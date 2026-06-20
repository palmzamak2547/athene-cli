// src/tools.ts
//
// Built-in agent tools. Read-only tools (read_file / list_dir) always run.
// Mutating tools (write_file / edit_file / bash) route through the approver,
// which shows the user a colorized diff / the command and asks before anything
// happens (auto with --yolo, interactive on a TTY, refuse when piped). Every
// tool fails soft (returns an ERROR/DECLINED string the model can recover from)
// rather than throwing. All file paths are confined to the working directory —
// no ../ escape, no absolute paths (a prompt-injected model must not read
// ~/.ssh or write /etc). (grok + codex review, 2026-06-20.)
import { tool } from "ai";
import { z } from "zod";
import { promises as fs } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Approver } from "./approval.js";
import { renderDiff } from "./ui.js";

const pexec = promisify(execFile);
const root = () => process.cwd();

const CAP = 60_000;
const clip = (s: string, n = CAP) =>
  s.length > n ? s.slice(0, n) + `\n…(truncated, ${s.length} chars total)` : s;

const bytes = (s: string) => Buffer.byteLength(s, "utf8");

// Resolve a model-supplied path INSIDE the working directory. Returns null for
// absolute paths or anything that escapes cwd via `..`.
function safeResolve(p: string): string | null {
  if (typeof p !== "string" || p.length === 0) return null;
  if (path.isAbsolute(p)) return null;
  const base = root();
  const target = path.resolve(base, p);
  const rel = path.relative(base, target);
  if (rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel)) return null;
  return target;
}

const escapeErr = (p: string) =>
  `ERROR: "${p}" is outside the working directory. Athene only operates within the current project (no absolute paths, no ../).`;

export function makeTools(approve: Approver, onActivity: (line: string) => void) {
  // onActivity is best-effort telemetry — never let it turn a successful op into
  // a reported failure, so it runs AFTER the real result is in hand.
  const note = (line: string) => {
    try {
      onActivity(line);
    } catch {
      /* ignore */
    }
  };

  const readMaybe = async (f: string): Promise<string> => {
    try {
      return await fs.readFile(f, "utf8");
    } catch {
      return "";
    }
  };

  return {
    read_file: tool({
      description: "Read a UTF-8 text file, relative to the working directory.",
      inputSchema: z.object({ path: z.string().min(1).describe("path relative to cwd") }),
      execute: async ({ path: p }) => {
        const f = safeResolve(p);
        if (!f) return escapeErr(p);
        try {
          return clip(await fs.readFile(f, "utf8"));
        } catch (e: any) {
          return `ERROR reading ${p}: ${e.message}`;
        }
      },
    }),

    list_dir: tool({
      description: "List the files and folders in a directory (folders end with '/').",
      inputSchema: z.object({ path: z.string().default(".") }),
      execute: async ({ path: p }) => {
        const f = safeResolve(p);
        if (!f) return escapeErr(p);
        try {
          const ents = await fs.readdir(f, { withFileTypes: true });
          return (
            clip(
              ents
                .map((e) => (e.isDirectory() ? e.name + "/" : e.name))
                .sort()
                .join("\n"),
            ) || "(empty)"
          );
        } catch (e: any) {
          return `ERROR listing ${p}: ${e.message}`;
        }
      },
    }),

    write_file: tool({
      description: "Create or overwrite a UTF-8 text file (creates parent dirs).",
      inputSchema: z.object({ path: z.string().min(1), content: z.string() }),
      execute: async ({ path: p, content }) => {
        const f = safeResolve(p);
        if (!f) return escapeErr(p);
        const old = await readMaybe(f);
        const ok = await approve({
          title: `${old ? "overwrite" : "create"} ${p}`,
          preview: renderDiff(old, content),
        });
        if (!ok) return `DECLINED: user did not approve writing ${p}.`;
        try {
          await fs.mkdir(path.dirname(f), { recursive: true });
          await fs.writeFile(f, content, "utf8");
        } catch (e: any) {
          return `ERROR writing ${p}: ${e.message}`;
        }
        note(`wrote ${p} (${bytes(content)}b)`);
        return `OK: wrote ${bytes(content)} bytes to ${p}`;
      },
    }),

    edit_file: tool({
      description:
        "Replace an exact unique occurrence of old_string with new_string in a file. " +
        "old_string must match exactly (including whitespace) and appear EXACTLY ONCE — " +
        "add surrounding context to make it unique.",
      inputSchema: z.object({
        path: z.string().min(1),
        old_string: z.string().min(1),
        new_string: z.string(),
      }),
      execute: async ({ path: p, old_string, new_string }) => {
        const f = safeResolve(p);
        if (!f) return escapeErr(p);
        let data: string;
        try {
          data = await fs.readFile(f, "utf8");
        } catch (e: any) {
          return `ERROR editing ${p}: ${e.message}`;
        }
        const count = data.split(old_string).length - 1;
        if (count === 0)
          return `ERROR: old_string not found in ${p}. Read the file again and match exactly.`;
        if (count > 1)
          return `ERROR: old_string appears ${count} times in ${p}. Add surrounding context so it's unique.`;
        const next = data.replace(old_string, new_string);
        const ok = await approve({ title: `edit ${p}`, preview: renderDiff(data, next) });
        if (!ok) return `DECLINED: user did not approve editing ${p}.`;
        try {
          await fs.writeFile(f, next, "utf8");
        } catch (e: any) {
          return `ERROR editing ${p}: ${e.message}`;
        }
        note(`edited ${p}`);
        return `OK: edited ${p}`;
      },
    }),

    bash: tool({
      description:
        "Run a shell command in the working directory; returns stdout+stderr. Use for grep, git, running tests/builds.",
      inputSchema: z.object({ command: z.string().min(1) }),
      execute: async ({ command }) => {
        const ok = await approve({ title: `run: ${command}`, preview: "" });
        if (!ok) return `DECLINED: user did not approve running: ${command}`;
        const win = process.platform === "win32";
        let out: string;
        try {
          const { stdout, stderr } = await pexec(
            win ? "cmd.exe" : "bash",
            win ? ["/c", command] : ["-c", command],
            { cwd: root(), timeout: 120_000, maxBuffer: 8_000_000, windowsHide: true },
          );
          out = (stdout || "") + (stderr ? "\n[stderr]\n" + stderr : "");
        } catch (e: any) {
          return clip(`EXIT ${e.code ?? "?"}\n${(e.stdout || "") + (e.stderr || e.message || "")}`);
        }
        note(`ran: ${command}`);
        return clip(out) || "(no output)";
      },
    }),
  };
}
