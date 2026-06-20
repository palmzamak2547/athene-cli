// src/repl.ts
//
// Interactive session. `athene` with no task (in a terminal) lands here: the
// tools / MCP / skills / system prompt are built once by openSession, then each
// line you type runs a turn that KEEPS the conversation history — so you can
// course-correct ("now also handle the empty case") without re-establishing
// context, and the provider KV-cache stays warm. Slash commands tweak the
// session without restarting it.
import * as readline from "node:readline/promises";
import pc from "picocolors";
import { openSession, type RunOpts } from "./agent.js";
import { EFFORTS, type Effort } from "./providers.js";

const HELP = `${pc.bold("commands")}
  /help            this help
  /effort <tier>   switch model tier (${EFFORTS.join(" | ")})
  /fast /deep      shortcuts for the tiers
  /verify on|off   run the project's check after a file change + self-correct
  /clear           forget the conversation so far (fresh context)
  /exit            quit (or Ctrl-D)
Anything else is a task. History is kept across turns — refer back freely.`;

export async function runRepl(opts: RunOpts): Promise<void> {
  const session = await openSession(opts);
  let effort = opts.effort;
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

  process.stdout.write(
    `\n ${pc.bold(pc.cyan("🦉 Athene"))} ${pc.dim("— interactive. /help for commands, /exit to quit.")}\n`,
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

      if (line.startsWith("/")) {
        const [cmd, ...rest] = line.slice(1).split(/\s+/);
        const arg = rest.join(" ").trim();
        if (cmd === "exit" || cmd === "quit" || cmd === "q") break;
        if (cmd === "help" || cmd === "h" || cmd === "?") {
          process.stdout.write(HELP + "\n");
        } else if (cmd === "clear" || cmd === "new" || cmd === "reset") {
          messages.length = 0;
          session.resetStats();
          process.stdout.write(pc.dim("context cleared.\n"));
        } else if (cmd === "effort") {
          if ((EFFORTS as string[]).includes(arg)) {
            effort = arg as Effort;
            session.setEffort(effort);
            process.stdout.write(pc.dim(`effort → ${effort}\n`));
          } else {
            process.stdout.write(pc.yellow(`usage: /effort ${EFFORTS.join(" | ")}\n`));
          }
        } else if (cmd === "verify") {
          const on = arg === "on" || arg === "true" || arg === "1";
          session.setVerify(on);
          process.stdout.write(pc.dim(`verify → ${on ? "on" : "off"}\n`));
        } else if ((EFFORTS as string[]).includes(cmd)) {
          effort = cmd as Effort;
          session.setEffort(effort);
          process.stdout.write(pc.dim(`effort → ${effort}\n`));
        } else {
          process.stdout.write(pc.yellow(`unknown command /${cmd} — try /help\n`));
        }
        continue;
      }

      messages.push({ role: "user", content: line });
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
