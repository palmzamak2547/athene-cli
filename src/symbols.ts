// src/symbols.ts
//
// `symbols` — a lightweight "repo map" (aider's signature idea, without a
// tree-sitter dependency). Extracts the top-level DECLARATIONS of a file or
// directory — functions, classes, types, exports — so the agent can grasp the
// SHAPE of code (where things live, what a module exposes) without reading every
// line. Cheap structural context = fewer wasted read_file calls + better
// navigation in a large repo. Read-only, cwd-confined, capped.
import { tool } from "ai";
import { z } from "zod";
import { promises as fs } from "node:fs";
import path from "node:path";
import { safeResolve, escapeErr } from "./tools.js";

const MAX_FILES = 200;
const MAX_LINES = 1500; // skip huge/minified files
const IGNORE = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  "out",
  "coverage",
  "vendor",
  ".venv",
  "__pycache__",
]);

// Per-language declaration patterns. Each regex captures the line that DECLARES a
// top-level symbol; we keep the trimmed source line as the "signature".
const RULES: Record<string, RegExp[]> = {
  ts: [
    /^\s*(export\s+)?(default\s+)?(async\s+)?function\s+\w+/,
    /^\s*(export\s+)?(abstract\s+)?class\s+\w+/,
    /^\s*(export\s+)?(interface|type|enum)\s+\w+/,
    /^\s*(export\s+)?const\s+\w+\s*[:=]\s*(async\s*)?(\([^)]*\)|function|\w+\s*=>)/,
    /^\s*(public|private|protected|static|async|get|set)\s+\w+\s*\(/,
  ],
  py: [/^\s*(async\s+)?def\s+\w+/, /^\s*class\s+\w+/],
  go: [/^\s*func\s+(\(\w[^)]*\)\s*)?\w+/, /^\s*type\s+\w+\s+(struct|interface)/],
  rs: [
    /^\s*(pub\s+)?(async\s+)?fn\s+\w+/,
    /^\s*(pub\s+)?(struct|enum|trait|type)\s+\w+/,
    /^\s*impl(\s|<)/,
  ],
  java: [
    /^\s*(public|private|protected)?\s*(static\s+)?(final\s+)?(class|interface|enum|record)\s+\w+/,
    /^\s*(public|private|protected)\s+[\w<>\[\],\s]+\s+\w+\s*\(/,
  ],
  rb: [/^\s*def\s+\w+/, /^\s*(class|module)\s+\w+/],
};

const EXT_LANG: Record<string, keyof typeof RULES> = {
  ".ts": "ts",
  ".tsx": "ts",
  ".js": "ts",
  ".jsx": "ts",
  ".mjs": "ts",
  ".cjs": "ts",
  ".py": "py",
  ".go": "go",
  ".rs": "rs",
  ".java": "java",
  ".rb": "rb",
};

export function outline(text: string, lang: keyof typeof RULES): string[] {
  const rules = RULES[lang];
  const out: string[] = [];
  const lines = text.split(/\r?\n/);
  if (lines.length > MAX_LINES) return out;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.length > 240) continue;
    if (rules.some((re) => re.test(line))) {
      out.push(`${i + 1}: ${line.trim().replace(/\s*\{?\s*$/, "")}`);
    }
  }
  return out;
}

async function* walk(dir: string): AsyncGenerator<string> {
  let ents: import("node:fs").Dirent[];
  try {
    ents = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of ents) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!IGNORE.has(e.name)) yield* walk(full);
    } else if (e.isFile() && EXT_LANG[path.extname(e.name)]) {
      yield full;
    }
  }
}

export function makeSymbolsTool(onActivity: (line: string) => void) {
  const note = (l: string) => {
    try {
      onActivity(l);
    } catch {
      /* ignore */
    }
  };
  return {
    symbols: tool({
      description:
        "Outline the top-level symbols (functions, classes, types, exports) of a file OR a directory tree — a fast structural map of the code. Use it BEFORE reading whole files to learn where things are and what a module exposes. Read-only.",
      inputSchema: z.object({
        path: z.string().default(".").describe("a file or directory, relative to cwd"),
      }),
      execute: async ({ path: p }) => {
        const base = safeResolve(p);
        if (!base) return escapeErr(p);
        let stat;
        try {
          stat = await fs.stat(base);
        } catch (e: any) {
          return `ERROR: ${e.message}`;
        }
        const files: string[] = [];
        if (stat.isFile()) files.push(base);
        else {
          for await (const f of walk(base)) {
            files.push(f);
            if (files.length >= MAX_FILES) break;
          }
        }
        const blocks: string[] = [];
        let total = 0;
        for (const f of files) {
          const lang = EXT_LANG[path.extname(f)];
          if (!lang) continue;
          let text: string;
          try {
            text = await fs.readFile(f, "utf8");
          } catch {
            continue;
          }
          const syms = outline(text, lang);
          if (syms.length === 0) continue;
          const rel = path.relative(process.cwd(), f).split(path.sep).join("/");
          blocks.push(`${rel}\n  ${syms.join("\n  ")}`);
          total += syms.length;
          if (total > 1200) {
            blocks.push("…(truncated — narrow the path)");
            break;
          }
        }
        note(`symbols ${p} → ${total}`);
        return blocks.length ? blocks.join("\n\n") : `No top-level symbols found in ${p}.`;
      },
    }),
  };
}
