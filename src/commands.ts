// src/commands.ts
//
// Custom slash commands — the near-zero-effort extensibility every frontier
// agent ships (Claude Code, Codex, Grok all read a commands dir). A file
// `.athene/commands/<name>.md` (project) or `~/.athene/commands/<name>.md`
// (global) defines `/<name>`: its body is a prompt template, with `$ARGUMENTS`
// (everything after the command) and `$1`..`$9` (positional words) substituted.
// Project commands win over global ones of the same name.
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

const DIRS = [
  path.join(process.cwd(), ".athene", "commands"),
  path.join(os.homedir(), ".athene", "commands"),
];

export type CustomCommand = { template: string; source: string };
export type CustomCommands = Map<string, CustomCommand>;

export async function loadCommands(): Promise<CustomCommands> {
  const out: CustomCommands = new Map();
  for (const dir of DIRS) {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => null);
    if (!entries) continue;
    for (const e of entries) {
      if (!e.isFile() || !e.name.toLowerCase().endsWith(".md")) continue;
      const name = e.name.replace(/\.md$/i, "").toLowerCase();
      if (out.has(name)) continue; // project dir is listed first → it wins
      const text = await fs.readFile(path.join(dir, e.name), "utf8").catch(() => null);
      if (text && text.trim()) out.set(name, { template: text.trim(), source: path.join(dir, e.name) });
    }
  }
  return out;
}

// Substitute $ARGUMENTS and $1..$9 in a command template.
export function expandCommand(template: string, args: string): string {
  const trimmed = args.trim();
  const parts = trimmed.length ? trimmed.split(/\s+/) : [];
  return template
    .replace(/\$ARGUMENTS\b/g, trimmed)
    .replace(/\$([1-9])\b/g, (_, d: string) => parts[Number(d) - 1] ?? "");
}
