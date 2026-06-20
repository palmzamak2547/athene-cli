// src/repl.ts
//
// Interactive session. `athene` with no task (in a terminal) lands here: the
// tools / MCP / skills / system prompt are built once by openSession, then each
// line you type runs a turn that KEEPS the conversation history — so you can
// course-correct ("now also handle the empty case") without re-establishing
// context, and the provider KV-cache stays warm. Slash commands tweak the
// session without restarting it; custom .athene/commands/*.md commands run as
// templated tasks.
import * as readline from "node:readline/promises";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import pc from "picocolors";
import { openSession, type RunOpts } from "./agent.js";
import { EFFORTS, type Effort } from "./providers.js";
import { loadCommands, expandCommand } from "./commands.js";
import { saveSession } from "./sessionstore.js";

const pexec = promisify(execFile);

const HELP = `${pc.bold("commands")}
  /help            this help
  /effort <tier>   switch model tier (${EFFORTS.join(" | ")})
  /fast /deep      shortcuts for the tiers
  /verify on|off   run the project's check after a file change + self-correct
  /architect on|off  plan with a strong model first, then edit (better edits)
  /plan on|off     read-only: propose changes for approval, don't apply
  /init            analyze the project and write an AGENTS.md
  /diff            show the working-tree git diff
  /rewind [n]      undo the last n turns (conversation only; files unchanged)
  /undo            revert the file changes the last task made (on disk)
  /compact         summarize the conversation now to free up context
  /commands        list your custom .athene/commands
  /clear           forget the conversation so far (fresh context)
  /exit            quit (or Ctrl-D)
Anything else is a task. Mention a file inline with @path/to/file to add it.
History is kept across turns — refer back freely.`;

const INIT_PROMPT = `Analyze this project and create (or improve, if it exists) an AGENTS.md at the repo root. Inspect package.json / README / config files and sample a few source files first. Document concisely: what the project is, the stack, how to build / test / run it, the key conventions, and the directory layout. Keep it tight — AGENTS.md is loaded into agent context every session, so signal over completeness.`;

async function gitDiff(): Promise<string> {
  try {
    const { stdout } = await pexec("git", ["--no-pager", "diff", "--stat", "HEAD"], {
      cwd: process.cwd(),
      maxBuffer: 4_000_000,
    });
    const { stdout: full } = await pexec("git", ["--no-pager", "diff", "HEAD"], {
      cwd: process.cwd(),
      maxBuffer: 8_000_000,
    });
    if (!full.trim()) return pc.dim("no changes vs HEAD.");
    const body = full.length > 20_000 ? full.slice(0, 20_000) + "\n…(truncated)" : full;
    return stdout + "\n" + body;
  } catch (e: any) {
    return pc.yellow(`/diff needs a git repo (${e?.message ?? e}).`);
  }
}

// Expand `@path/to/file` mentions in a prompt: inline the file's content (the
// aider /add + Claude Code @ convenience). Confined to cwd; a token that isn't a
// readable file is left as literal text.
async function expandMentions(text: string): Promise<string> {
  const tokens = [...new Set([...text.matchAll(/@([\w./\-]+)/g)].map((m) => m[1]))];
  if (tokens.length === 0) return text;
  const root = process.cwd();
  const blocks: string[] = [];
  for (const rel of tokens) {
    const abs = path.resolve(root, rel);
    if (!abs.startsWith(root)) continue; // confine to cwd
    try {
      const content = await fs.readFile(abs, "utf8");
      blocks.push(`# ${rel}\n${content.length > 16000 ? content.slice(0, 16000) + "\n…(truncated)" : content}`);
    } catch {
      /* not a readable file — leave the @token as plain text */
    }
  }
  if (blocks.length === 0) return text;
  process.stderr.write(pc.dim(` (added ${blocks.length} mentioned file${blocks.length === 1 ? "" : "s"})\n`));
  return `${text}\n\n--- mentioned files ---\n${blocks.join("\n\n")}`;
}

export async function runRepl(opts: RunOpts, initial?: any[]): Promise<void> {
  const session = await openSession(opts);
  const commands = await loadCommands();
  let effort = opts.effort;
  let plan = opts.mode === "plan";
  let messages: any[] = initial && initial.length ? initial.slice() : [];
  const sessionId = `${Date.now()}-${Math.floor(Math.random() * 1e6).toString(36)}`;
  const snapshots: any[][] = []; // message-history state before each turn, for /rewind
  const MAX_SNAPSHOTS = 30;

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let closed = false;
  let running: AbortController | null = null; // set while a task is in flight
  const shutdown = async () => {
    if (closed) return;
    closed = true;
    rl.close();
    await session.close();
  };
  // Ctrl-C interrupts a running task (stay in the REPL); at the idle prompt it
  // quits cleanly (closing MCP children rather than orphaning them).
  rl.on("SIGINT", () => {
    if (running) {
      running.abort();
      return;
    }
    void shutdown().then(() => {
      process.stdout.write(pc.dim("\nbye.\n"));
      process.exit(0);
    });
  });

  const cmdNote = commands.size ? pc.dim(` · ${commands.size} custom command${commands.size === 1 ? "" : "s"}`) : "";
  process.stdout.write(
    `\n ${pc.bold(pc.cyan("🦉 Athene"))} ${pc.dim("— interactive. /help for commands, /exit to quit.")}${cmdNote}\n`,
  );
  if (initial?.length) {
    process.stdout.write(pc.dim(` (resumed ${initial.length} messages — /clear for a fresh start)\n`));
  }

  try {
    while (!closed) {
      let line: string;
      try {
        line = (await rl.question(pc.cyan("\n› "))).trim();
      } catch {
        break; // Ctrl-D / stream closed
      }
      if (!line) continue;

      let taskText = line; // may be replaced by an expanded custom command
      if (line.startsWith("/")) {
        const [raw, ...rest] = line.slice(1).split(/\s+/);
        const cmd = raw.toLowerCase();
        const arg = rest.join(" ").trim();

        if (cmd === "exit" || cmd === "quit" || cmd === "q") break;
        if (cmd === "help" || cmd === "h" || cmd === "?") {
          process.stdout.write(HELP + "\n");
          continue;
        }
        if (cmd === "clear" || cmd === "new" || cmd === "reset") {
          messages.length = 0;
          session.resetStats();
          process.stdout.write(pc.dim("context cleared.\n"));
          continue;
        }
        if (cmd === "rewind") {
          const n = Math.max(1, parseInt(arg, 10) || 1);
          let restored: any[] | null = null;
          for (let i = 0; i < n && snapshots.length; i++) restored = snapshots.pop() ?? null;
          if (restored) {
            messages = restored;
            process.stdout.write(pc.dim(`rewound — back to ${messages.length} messages (files on disk are unchanged)\n`));
          } else {
            process.stdout.write(pc.dim("nothing to rewind\n"));
          }
          continue;
        }
        if (cmd === "undo") {
          const n = await session.restoreFiles();
          process.stdout.write(
            pc.dim(n ? `reverted ${n} file${n === 1 ? "" : "s"} from the last task\n` : "no file changes to undo\n"),
          );
          continue;
        }
        if (cmd === "compact") {
          const before = messages.length;
          messages = await session.compact(messages);
          process.stdout.write(
            pc.dim(messages.length < before ? `compacted ${before} → ${messages.length} messages\n` : "conversation is small — nothing to compact\n"),
          );
          continue;
        }
        if (cmd === "effort") {
          if ((EFFORTS as string[]).includes(arg)) {
            effort = arg as Effort;
            session.setEffort(effort);
            process.stdout.write(pc.dim(`effort → ${effort}\n`));
          } else {
            process.stdout.write(pc.yellow(`usage: /effort ${EFFORTS.join(" | ")}\n`));
          }
          continue;
        }
        if (cmd === "verify") {
          const on = arg === "on" || arg === "true" || arg === "1";
          session.setVerify(on);
          process.stdout.write(pc.dim(`verify → ${on ? "on" : "off"}\n`));
          continue;
        }
        if (cmd === "architect") {
          const on = arg === "on" || arg === "true" || arg === "1";
          session.setArchitect(on);
          process.stdout.write(
            pc.dim(`architect → ${on ? "on (a strong model plans, then the editor applies)" : "off"}\n`),
          );
          continue;
        }
        if (cmd === "plan") {
          plan = arg !== "off" && arg !== "false" && arg !== "0";
          session.setPlan(plan);
          process.stdout.write(pc.dim(`plan mode → ${plan ? "on (proposing, not applying)" : "off"}\n`));
          continue;
        }
        if (cmd === "diff") {
          process.stdout.write((await gitDiff()) + "\n");
          continue;
        }
        if (cmd === "commands") {
          if (!commands.size) process.stdout.write(pc.dim("no custom commands (.athene/commands/*.md)\n"));
          else
            process.stdout.write(
              [...commands.keys()].map((n) => pc.dim(`  /${n}`)).join("\n") + "\n",
            );
          continue;
        }
        if ((EFFORTS as string[]).includes(cmd)) {
          effort = cmd as Effort;
          session.setEffort(effort);
          process.stdout.write(pc.dim(`effort → ${effort}\n`));
          continue;
        }
        if (cmd === "init") {
          taskText = INIT_PROMPT; // run as a task (the agent inspects + writes AGENTS.md)
        } else {
          const custom = commands.get(cmd);
          if (custom) {
            taskText = expandCommand(custom.template, arg);
          } else {
            process.stdout.write(pc.yellow(`unknown command /${raw} — try /help\n`));
            continue;
          }
        }
      }

      taskText = await expandMentions(taskText); // inline any @file mentions
      snapshots.push(messages.slice()); // for /rewind (shallow — messages aren't mutated in place)
      if (snapshots.length > MAX_SNAPSHOTS) snapshots.shift();
      messages = await session.compact(messages); // fold older turns if too long
      messages.push({ role: "user", content: taskText });
      running = new AbortController();
      try {
        const { responseMessages } = await session.runTask(messages, false, running.signal);
        if (responseMessages?.length) messages.push(...responseMessages);
        else messages.pop(); // nothing came back — drop the dangling user turn
      } catch (e: any) {
        messages.pop(); // failed turn → keep history clean; files on disk are the truth
        process.stderr.write(pc.red(`\n${e?.message ?? e}\n`));
      } finally {
        running = null;
      }
      void saveSession(sessionId, messages); // persist for `athene --continue`
    }
  } finally {
    await shutdown();
    process.stdout.write(pc.dim("\nbye.\n"));
  }
}
