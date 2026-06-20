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
import { promisify } from "node:util";
import pc from "picocolors";
import { openSession, type RunOpts } from "./agent.js";
import { EFFORTS, type Effort } from "./providers.js";
import { loadCommands, expandCommand } from "./commands.js";

const pexec = promisify(execFile);

const HELP = `${pc.bold("commands")}
  /help            this help
  /effort <tier>   switch model tier (${EFFORTS.join(" | ")})
  /fast /deep      shortcuts for the tiers
  /verify on|off   run the project's check after a file change + self-correct
  /plan on|off     read-only: propose changes for approval, don't apply
  /diff            show the working-tree git diff
  /commands        list your custom .athene/commands
  /clear           forget the conversation so far (fresh context)
  /exit            quit (or Ctrl-D)
Anything else is a task. History is kept across turns — refer back freely.`;

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

export async function runRepl(opts: RunOpts): Promise<void> {
  const session = await openSession(opts);
  const commands = await loadCommands();
  let effort = opts.effort;
  let plan = opts.mode === "plan";
  const messages: any[] = [];

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let closed = false;
  const shutdown = async () => {
    if (closed) return;
    closed = true;
    rl.close();
    await session.close();
  };
  // Ctrl-C quits cleanly (closes MCP children) rather than orphaning them.
  rl.on("SIGINT", () => {
    void shutdown().then(() => {
      process.stdout.write(pc.dim("\nbye.\n"));
      process.exit(0);
    });
  });

  const cmdNote = commands.size ? pc.dim(` · ${commands.size} custom command${commands.size === 1 ? "" : "s"}`) : "";
  process.stdout.write(
    `\n ${pc.bold(pc.cyan("🦉 Athene"))} ${pc.dim("— interactive. /help for commands, /exit to quit.")}${cmdNote}\n`,
  );

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
        const custom = commands.get(cmd);
        if (custom) {
          taskText = expandCommand(custom.template, arg);
        } else {
          process.stdout.write(pc.yellow(`unknown command /${raw} — try /help\n`));
          continue;
        }
      }

      messages.push({ role: "user", content: taskText });
      try {
        const { responseMessages } = await session.runTask(messages, false);
        if (responseMessages?.length) messages.push(...responseMessages);
        else messages.pop(); // nothing came back — drop the dangling user turn
      } catch (e: any) {
        messages.pop(); // failed turn → keep history clean; files on disk are the truth
        process.stderr.write(pc.red(`\n${e?.message ?? e}\n`));
      }
    }
  } finally {
    await shutdown();
    process.stdout.write(pc.dim("\nbye.\n"));
  }
}
