// src/search.ts
//
// grep + glob — the two search tools every coding agent leans on. They are
// dedicated tools (not "run grep through bash") for three reasons every frontier
// agent converged on:
//   1. Structured + CAPPED output, so a huge match set can't blow the context.
//   2. Confined to cwd (same safeResolve rule as the file tools) — search can't
//      wander into ~/.ssh.
//   3. Fast: a ripgrep fast-path when `rg` is on PATH, and a dependency-free
//      Node walker otherwise (most users don't have rg, so the fallback is the
//      real workhorse — it must be correct, not just a stub).
//
// Both are READ-ONLY, so (like read_file / list_dir) they don't route through
// the approver.
import { tool } from "ai";
import { z } from "zod";
import { promises as fs } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { safeResolve, escapeErr } from "./tools.js";

const root = () => process.cwd();

// Never worth searching — keeps the Node walker fast + the results relevant.
// (ripgrep applies .gitignore itself; this is the fallback's equivalent.)
const IGNORE_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  "out",
  "coverage",
  ".cache",
  ".turbo",
  ".parcel-cache",
  "vendor",
  ".venv",
  "venv",
  "__pycache__",
  ".idea",
  ".vscode",
  ".svelte-kit",
]);
const BINARY_EXT =
  /\.(png|jpe?g|gif|webp|ico|bmp|tiff?|pdf|zip|gz|tgz|bz2|xz|tar|rar|7z|exe|dll|so|dylib|a|o|bin|dat|woff2?|ttf|eot|otf|mp[34]|m4a|mov|avi|mkv|webm|wav|ogg|flac|class|jar|war|wasm|node|pyc|pdb|lock)$/i;

const MAX_GREP_MATCHES = 200;
const MAX_GLOB_FILES = 400;
const CAP_BYTES = 60_000;
const MAX_LINE = 240;
const MAX_FILE_BYTES = 2_000_000; // skip huge/minified files in the Node walker

// Forward-slashed path relative to cwd (stable across OSes for display + globbing).
function relForward(abs: string): string {
  return path.relative(root(), abs).split(path.sep).join("/");
}

// Minimal glob → RegExp: `**` spans path separators, `*` and `?` don't, `{a,b}`
// alternates, everything else literal. A pattern with NO `/` matches a file's
// BASENAME at any depth (so `*.ts` finds every .ts), matching how these agents
// are actually used; a pattern WITH `/` or `**` matches the full relative path.
export function globToRe(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        re += ".*";
        i++;
        if (glob[i + 1] === "/") i++; // consume the slash after **
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if (c === "{") {
      re += "(?:";
    } else if (c === "}") {
      re += ")";
    } else if (c === ",") {
      re += "|";
    } else if (c === "/") {
      re += "/";
    } else if (".+^$()|[]\\".includes(c)) {
      re += "\\" + c;
    } else {
      re += c;
    }
  }
  return new RegExp("^" + re + "$");
}

// Returns a matcher, or an error string if the glob is malformed (an unbalanced
// brace etc. would otherwise throw from new RegExp). (grok review)
function globMatcher(glob: string): ((rel: string) => boolean) | { error: string } {
  let re: RegExp;
  try {
    re = globToRe(glob);
  } catch (e: any) {
    return { error: `ERROR: invalid glob "${glob}": ${e.message}` };
  }
  const basenameOnly = !glob.includes("/") && !glob.includes("**");
  return (rel: string) => re.test(basenameOnly ? (rel.split("/").pop() ?? rel) : rel);
}

// Walk cwd yielding files, skipping ignored dirs.
async function* walkFiles(dir: string): AsyncGenerator<string> {
  let ents: import("node:fs").Dirent[];
  try {
    ents = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of ents) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (IGNORE_DIRS.has(e.name)) continue;
      yield* walkFiles(full);
    } else if (e.isFile()) {
      yield full;
    }
  }
}

// Run ripgrep if present. Resolves { missing:true } on ENOENT so the caller can
// fall back to the Node implementation; `code` is rg's exit (0=match, 1=no
// match, 2=error e.g. a bad regex — callers treat 2 as "fall back to Node" so
// the JS RegExp validates + reports it instead of silently returning "no
// matches"). Output stops accumulating once it hits the byte cap. (grok review)
function runRg(args: string[]): Promise<{ missing: boolean; out: string; code: number }> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn("rg", args, { cwd: root(), windowsHide: true });
    } catch {
      return resolve({ missing: true, out: "", code: -1 });
    }
    let out = "";
    let capped = false;
    let done = false;
    const finish = (r: { missing: boolean; out: string; code: number }) => {
      if (!done) {
        done = true;
        resolve(r);
      }
    };
    child.on("error", () => finish({ missing: true, out: "", code: -1 })); // ENOENT etc.
    child.stdout?.on("data", (d: Buffer) => {
      if (capped) return;
      out += d.toString("utf8");
      if (Buffer.byteLength(out, "utf8") > CAP_BYTES) {
        capped = true;
        out = out.slice(0, CAP_BYTES);
        try {
          child.kill();
        } catch {
          /* ignore */
        }
      }
    });
    child.stderr?.on("data", () => {}); // swallow "No files searched" etc.
    child.on("close", (code) => finish({ missing: false, out, code: code ?? 0 }));
  });
}

const NUL = String.fromCharCode(0); // binary sniff char, never typed as a raw byte

export function makeSearchTools(onActivity: (line: string) => void) {
  const note = (line: string) => {
    try {
      onActivity(line);
    } catch {
      /* ignore */
    }
  };

  return {
    grep: tool({
      description:
        "Search file CONTENTS by regular expression and return matching `path:line: text`. Fast + capped. Prefer this over `bash grep`. Use `glob` to limit to a file type (e.g. \"*.ts\"), `path` to a subdirectory.",
      inputSchema: z.object({
        pattern: z.string().min(1).describe("regular expression (ripgrep / JS regex syntax)"),
        path: z.string().default(".").describe("directory or file to search, relative to cwd"),
        glob: z.string().optional().describe('limit to files matching a glob, e.g. "*.ts"'),
        ignore_case: z.boolean().optional(),
      }),
      execute: async ({ pattern, path: p, glob, ignore_case }) => {
        const base = safeResolve(p);
        if (!base) return escapeErr(p);

        // ripgrep fast-path.
        const rgArgs = [
          "--line-number",
          "--no-heading",
          "--color",
          "never",
          "--max-columns",
          String(MAX_LINE),
          "--max-count",
          "50",
        ];
        if (ignore_case) rgArgs.push("-i");
        if (glob) rgArgs.push("-g", glob);
        rgArgs.push("-e", pattern, "--", p);
        const rg = await runRg(rgArgs);
        if (!rg.missing && rg.code !== 2) {
          // code 2 = rg error (e.g. invalid regex) → fall through to Node, which
          // validates the pattern and returns a real error message. (grok review)
          const lines = rg.out.split("\n").filter(Boolean).slice(0, MAX_GREP_MATCHES);
          if (lines.length === 0) return `No matches for /${pattern}/ in ${p}`;
          const capped = lines.length >= MAX_GREP_MATCHES ? "\n…(capped)" : "";
          note(`grep /${pattern}/ → ${lines.length} hits`);
          return lines.join("\n") + capped;
        }

        // Node fallback.
        let re: RegExp;
        try {
          re = new RegExp(pattern, ignore_case ? "i" : "");
        } catch (e: any) {
          return `ERROR: invalid regex /${pattern}/: ${e.message}`;
        }
        let match: ((rel: string) => boolean) | null = null;
        if (glob) {
          const m = globMatcher(glob);
          if (typeof m !== "function") return m.error;
          match = m;
        }
        const results: string[] = [];
        let single = false;
        let iter: AsyncIterable<string> | Iterable<string>;
        try {
          const st = await fs.stat(base);
          if (st.isFile()) {
            single = true;
            iter = [base];
          } else {
            iter = walkFiles(base);
          }
        } catch (e: any) {
          return `ERROR searching ${p}: ${e.message}`;
        }
        outer: for await (const file of iter) {
          const rel = relForward(file);
          if (!single && BINARY_EXT.test(file)) continue;
          if (match && !match(rel)) continue;
          let text: string;
          try {
            if (!single) {
              const st = await fs.stat(file);
              if (st.size > MAX_FILE_BYTES) continue; // skip huge files
            }
            text = await fs.readFile(file, "utf8");
          } catch {
            continue;
          }
          if (text.includes(NUL)) continue; // binary guard
          const fileLines = text.split(/\r?\n/);
          for (let i = 0; i < fileLines.length; i++) {
            if (re.test(fileLines[i])) {
              const t = fileLines[i].trim();
              results.push(`${rel}:${i + 1}: ${t.length > MAX_LINE ? t.slice(0, MAX_LINE) + "…" : t}`);
              if (results.length >= MAX_GREP_MATCHES) break outer;
            }
          }
        }
        if (results.length === 0) return `No matches for /${pattern}/ in ${p}`;
        const capped = results.length >= MAX_GREP_MATCHES ? "\n…(capped)" : "";
        note(`grep /${pattern}/ → ${results.length} hits`);
        return results.join("\n") + capped;
      },
    }),

    glob: tool({
      description:
        'Find files by name/path pattern (e.g. "**/*.ts", "src/**/*.tsx", "*.json"). Returns matching paths, sorted, capped. A pattern without "/" matches a file\'s name at any depth. Prefer this over `bash find`.',
      inputSchema: z.object({
        pattern: z.string().min(1).describe('glob, e.g. "src/**/*.ts" or "*.md"'),
        path: z.string().default(".").describe("base directory, relative to cwd"),
      }),
      execute: async ({ pattern, path: p }) => {
        const base = safeResolve(p);
        if (!base) return escapeErr(p);

        // ripgrep fast-path (--files lists files, .gitignore-aware).
        const rg = await runRg(["--files", "-g", pattern, "--", p]);
        if (!rg.missing && rg.code !== 2) {
          const files = rg.out
            .split("\n")
            .map((s) => s.trim())
            .filter(Boolean)
            .map((s) => s.split(path.sep).join("/"))
            .sort()
            .slice(0, MAX_GLOB_FILES);
          if (files.length === 0) return `No files match ${pattern} in ${p}`;
          note(`glob ${pattern} → ${files.length}`);
          return files.join("\n") + (files.length >= MAX_GLOB_FILES ? "\n…(capped)" : "");
        }

        // Node fallback.
        const match = globMatcher(pattern);
        if (typeof match !== "function") return match.error;
        const out: string[] = [];
        for await (const file of walkFiles(base)) {
          const rel = relForward(file);
          if (match(rel)) {
            out.push(rel);
            if (out.length >= MAX_GLOB_FILES * 2) break; // gather, then sort+cap
          }
        }
        if (out.length === 0) return `No files match ${pattern} in ${p}`;
        out.sort();
        const capped = out.length > MAX_GLOB_FILES;
        note(`glob ${pattern} → ${out.length}`);
        return out.slice(0, MAX_GLOB_FILES).join("\n") + (capped ? "\n…(capped)" : "");
      },
    }),
  };
}
