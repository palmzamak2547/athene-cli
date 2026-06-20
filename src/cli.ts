#!/usr/bin/env node
// src/cli.ts — Athene CLI entry. Parses args, runs one agent turn over the task.
import { runAgent } from "./agent.js";
import { EFFORTS, type Effort } from "./providers.js";

const HELP = `athene — a free, frontier-class terminal coding agent (Athene suite)

Usage
  athene "<task>" [options]

Options
  -e, --effort <fast|balanced|deep>   model tier (default: balanced)
      --fast                          shorthand for --effort fast
      --deep                          shorthand for --effort deep
  -y, --yolo                          allow file writes + shell commands (default: read-only)
      --max-steps <n>                 max agent steps (default: 24)
  -h, --help                          show this help

Free models — set at least NVIDIA_API_KEY (free at build.nvidia.com); optionally
GROQ_API_KEY / CEREBRAS_API_KEY / OPENROUTER_API_KEY for faster tiers.

Examples
  athene "explain what this repo does"
  athene --deep "why does the build fail?"
  athene -y "add a --version flag and update the README"
`;

type Opts = {
  help: boolean;
  effort: Effort;
  allowWrite: boolean;
  maxSteps: number;
  prompt: string;
};

function parse(argv: string[]): Opts {
  const o: Opts = {
    help: false,
    effort: "balanced",
    allowWrite: false,
    maxSteps: 24,
    prompt: "",
  };
  const parts: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") o.help = true;
    else if (a === "-y" || a === "--yolo") o.allowWrite = true;
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
  if (o.help || !o.prompt) {
    process.stdout.write(HELP);
    process.exit(o.help ? 0 : 1);
  }
  if (!EFFORTS.includes(o.effort)) {
    process.stderr.write(`Unknown effort "${o.effort}". Use: ${EFFORTS.join(" | ")}\n`);
    process.exit(1);
  }
  try {
    await runAgent({
      prompt: o.prompt,
      effort: o.effort,
      allowWrite: o.allowWrite,
      maxSteps: o.maxSteps,
    });
  } catch (e: any) {
    process.stderr.write(`\n${e?.message ?? e}\n`);
    process.exit(1);
  }
}

main();
