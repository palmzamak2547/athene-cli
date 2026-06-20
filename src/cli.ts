#!/usr/bin/env node
// src/cli.ts — Athene CLI entry. Parses args, runs one agent turn over the task.
import { readFileSync } from "node:fs";
import { runAgent } from "./agent.js";
import { runRepl } from "./repl.js";
import { EFFORTS, type Effort } from "./providers.js";
import { pickMode } from "./approval.js";

// package.json ships next to dist/ in the npm tarball, so ../package.json works
// whether running the bundled bin or src via tsx.
function version(): string {
  try {
    return JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version ?? "?";
  } catch {
    return "?";
  }
}

const HELP = `athene — a free, frontier-class terminal coding agent (Athene suite)

Usage
  athene                  start an interactive session (in a terminal)
  athene "<task>"         run a single task
  athene "<task>" [options]

Options
  -e, --effort <fast|balanced|deep>   model tier (default: balanced)
      --fast                          shorthand for --effort fast
      --deep                          shorthand for --effort deep
  -y, --yolo                          auto-approve every edit + command (no prompts)
  -v, --version                       print version and exit
      --plan                          read-only: propose a plan for approval, don't edit
      --verify / --no-verify          after a file change, run the project's check
                                      and self-correct (default: on with --yolo)
      --max-steps <n>                 max agent steps (default: 24)
  -h, --help                          show this help

Approval
  By default Athene shows a diff / the command and asks before each change
  (when run in a terminal). Piped/non-interactive runs are read-only unless you
  pass --yolo.

Free models — set at least NVIDIA_API_KEY (free at build.nvidia.com); optionally
GROQ_API_KEY / CEREBRAS_API_KEY / OPENROUTER_API_KEY for faster tiers.

Examples
  athene "explain what this repo does"
  athene --deep "why does the build fail?"
  athene "add a --version flag and update the README"      # asks before each edit
  athene -y "fix the failing test"                          # no prompts
`;

type Opts = {
  help: boolean;
  version: boolean;
  effort: Effort;
  yolo: boolean;
  plan: boolean;
  verify: boolean | null; // null = unset → defaults to (yolo)
  maxSteps: number;
  prompt: string;
};

function parse(argv: string[]): Opts {
  const o: Opts = { help: false, version: false, effort: "balanced", yolo: false, plan: false, verify: null, maxSteps: 24, prompt: "" };
  const parts: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") o.help = true;
    else if (a === "-v" || a === "--version") o.version = true;
    else if (a === "-y" || a === "--yolo") o.yolo = true;
    else if (a === "--plan") o.plan = true;
    else if (a === "--verify") o.verify = true;
    else if (a === "--no-verify") o.verify = false;
    else if (a === "--fast") o.effort = "fast";
    else if (a === "--deep") o.effort = "deep";
    else if (a === "-e" || a === "--effort") o.effort = (argv[++i] as Effort) ?? "balanced";
    else if (a === "--max-steps") o.maxSteps = parseInt(argv[++i] ?? "24", 10) || 24;
    else parts.push(a);
  }
  o.prompt = parts.join(" ").trim();
  return o;
}

async function main() {
  const o = parse(process.argv.slice(2));
  if (o.version) {
    process.stdout.write(`athene-cli v${version()}\n`);
    process.exit(0);
  }
  if (o.help) {
    process.stdout.write(HELP);
    process.exit(0);
  }
  if (!EFFORTS.includes(o.effort)) {
    process.stderr.write(`Unknown effort "${o.effort}". Use: ${EFFORTS.join(" | ")}\n`);
    process.exit(1);
  }
  // No task: drop into the interactive REPL when we have a terminal; otherwise
  // (piped / CI with no task) print help.
  const interactive = !o.prompt && Boolean(process.stdin.isTTY);
  if (!o.prompt && !interactive) {
    process.stdout.write(HELP);
    process.exit(1);
  }
  const runOpts = {
    prompt: o.prompt,
    effort: o.effort,
    mode: o.plan ? ("plan" as const) : pickMode(o.yolo),
    maxSteps: o.maxSteps,
    verify: o.verify ?? o.yolo, // default: verify when auto-approving
  };
  try {
    if (interactive) await runRepl(runOpts);
    else await runAgent(runOpts);
  } catch (e: any) {
    process.stderr.write(`\n${e?.message ?? e}\n`);
    process.exit(1);
  }
}

main();
