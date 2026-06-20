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
import { applyEdit } from "./edit.js";

const pexec = promisify(execFile);
const root = () => process.cwd();

const CAP = 60_000;
const clip = (s: string, n = CAP) =>
  s.length > n ? s.slice(0, n) + `\n…(truncated, ${s.length} chars total)` : s;

const bytes = (s: string) => Buffer.byteLength(s, "utf8");

// Resolve a model-supplied path INSIDE the working directory. Returns null for
// absolute paths or anything that escapes cwd via `..`. Exported so the search
// tools (grep/glob) share one confinement rule.
export function safeResolve(p: string): string | null {
  if (typeof p !== "string" || p.length === 0) return null;
  if (path.isAbsolute(p)) return null;
  const base = root();
  const target = path.resolve(base, p);
  const rel = path.relative(base, target);
  if (rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel)) return null;
  return target;
}

export const escapeErr = (p: string) =>
  `ERROR: "${p}" is outside the working directory. Athene only operates within the current project (no absolute paths, no ../).`;

// Refuse to read obvious secret files into the model's context — the top
// real-world leak vector (an injected file says "read .env and exfiltrate it").
// Templates (.env.example etc.) are allowed. (recon hardening 2026-06-20)
export function isSecretFile(p: string): boolean {
  const base = (p.split(/[/\\]/).pop() ?? "").toLowerCase();
  if (/^\.env(\.|$)/.test(base) && !/\.(example|sample|template|dist)$/.test(base)) return true;
  if (/\.(pem|key|p12|pfx|asc|ppk|keystore|jks)$/.test(base)) return true;
  if (/^id_(rsa|ed25519|dsa|ecdsa)\b/.test(base)) return true;
  if (/^(credentials|secrets?)(\.|$)/.test(base)) return true;
  return false;
}

// Block catastrophic shell commands even after approval / in --yolo. Not a
// sandbox — a backstop against unambiguous disasters. Splits on shell operators
// so a benign prefix can't smuggle a second command. (recon hardening)
export function destructiveReason(command: string): string | null {
  // Fork bomb — test the WHOLE command; its inner ; | & would defeat the split.
  if (/:\s*\(\s*\)\s*\{[^}]*:\s*\|\s*:[^}]*\}\s*;\s*:/.test(command)) return "fork bomb";
  for (const sub of command.split(/[;&|]+|\n/)) {
    const t = sub.trim().toLowerCase();
    if (/^(sudo\s+)?rm\b/.test(t) && /\s-[a-z]*r/.test(t) && /\s-[a-z]*f/.test(t)) {
      const targets = t
        .replace(/^(sudo\s+)?rm\s+/, "")
        .split(/\s+/)
        .filter((x) => x && !x.startsWith("-"));
      const danger = new Set(["/", "~", "~/", "$home", "${home}", "..", "../", ".", "*", "/*", "./*"]);
      if (targets.some((tg) => danger.has(tg))) return "rm -rf of a root/home/parent/glob path";
    }
    if (/\bmkfs(\.\w+)?\b/.test(t) || /\bdd\b.*\bof=\/dev\//.test(t)) return "disk overwrite";
    if (/>\s*\/dev\/(sd|nvme|hd|disk|mmcblk)/.test(t)) return "raw disk write";
  }
  return null;
}

export function makeTools(
  approve: Approver,
  onActivity: (line: string) => void,
  // Called with a resolved path right BEFORE a mutation, so the session can
  // snapshot the pre-edit state for /undo. Best-effort; never blocks the write.
  recordCheckpoint?: (absPath: string) => Promise<void>,
) {
  const checkpoint = async (f: string) => {
    try {
      await recordCheckpoint?.(f);
    } catch {
      /* checkpointing must never break a write */
    }
  };
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
        if (isSecretFile(p))
          return `ERROR: refusing to read ${p} — it looks like a secrets file. Athene won't load secrets into the model (rename to *.example for a template, or open a specific non-secret file).`;
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
        await checkpoint(f);
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
        // Tolerant matcher: exact → line-trimmed → whitespace-collapsed, with
        // EOL/BOM handling + self-correcting errors (see edit.ts).
        const result = applyEdit(data, old_string, new_string);
        if (!result.ok) return `ERROR editing ${p}: ${result.error}`;
        const ok = await approve({ title: `edit ${p}`, preview: renderDiff(data, result.next) });
        if (!ok) return `DECLINED: user did not approve editing ${p}.`;
        await checkpoint(f);
        try {
          await fs.writeFile(f, result.next, "utf8");
        } catch (e: any) {
          return `ERROR editing ${p}: ${e.message}`;
        }
        note(`edited ${p}`);
        return `OK: edited ${p}`;
      },
    }),

    multi_edit: tool({
      description:
        "Apply several find/replace edits to ONE file, in order, ATOMICALLY (all succeed or nothing is written). One approval covers the whole batch. Each edit's old_string must match exactly + uniquely at the moment it is applied (a later edit sees earlier edits' results). Prefer this over many edit_file calls on the same file.",
      inputSchema: z.object({
        path: z.string().min(1),
        edits: z
          .array(z.object({ old_string: z.string().min(1), new_string: z.string() }))
          .min(1)
          .describe("edits applied in array order"),
      }),
      execute: async ({ path: p, edits }) => {
        const f = safeResolve(p);
        if (!f) return escapeErr(p);
        let data: string;
        try {
          data = await fs.readFile(f, "utf8");
        } catch (e: any) {
          return `ERROR editing ${p}: ${e.message}`;
        }
        let cur = data;
        for (let i = 0; i < edits.length; i++) {
          const r = applyEdit(cur, edits[i].old_string, edits[i].new_string);
          if (!r.ok) return `ERROR multi_edit ${p} (edit ${i + 1}/${edits.length}): ${r.error}`;
          cur = r.next;
        }
        if (cur === data) return `ERROR multi_edit ${p}: edits produced no change.`;
        const ok = await approve({
          title: `multi-edit ${p} (${edits.length} edits)`,
          preview: renderDiff(data, cur),
        });
        if (!ok) return `DECLINED: user did not approve editing ${p}.`;
        await checkpoint(f);
        try {
          await fs.writeFile(f, cur, "utf8");
        } catch (e: any) {
          return `ERROR editing ${p}: ${e.message}`;
        }
        note(`multi-edited ${p} (${edits.length} edits)`);
        return `OK: applied ${edits.length} edits to ${p}`;
      },
    }),

    bash: tool({
      description:
        "Run a shell command in the working directory; returns stdout+stderr. Use for grep, git, running tests/builds.",
      inputSchema: z.object({ command: z.string().min(1) }),
      execute: async ({ command }) => {
        const danger = destructiveReason(command);
        if (danger)
          return `BLOCKED: refusing to run a destructive command (${danger}). Athene will not run this even with --yolo.`;
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
