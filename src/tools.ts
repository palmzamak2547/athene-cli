// src/tools.ts
//
// Built-in agent tools. Read-only tools (read_file / list_dir) always run;
// mutating tools (write_file / edit_file / bash) are gated behind write mode
// (--yolo) for v0 safety — a real approval prompt is the next step. Every tool
// fails soft (returns an ERROR string the model can recover from) rather than
// throwing, so one bad call never kills the agent loop.
import { tool } from "ai";
import { z } from "zod";
import { promises as fs } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const pexec = promisify(execFile);
const root = () => process.cwd();
const abs = (p: string) => path.resolve(root(), p);

const CAP = 60_000;
const clip = (s: string, n = CAP) =>
  s.length > n ? s.slice(0, n) + `\n…(truncated, ${s.length} chars total)` : s;

export function makeTools(allowWrite: boolean, onActivity: (line: string) => void) {
  const guard = (label: string): string | null =>
    allowWrite
      ? null
      : `BLOCKED: "${label}" needs write mode. Re-run with --yolo to allow file writes + commands.`;

  return {
    read_file: tool({
      description: "Read a UTF-8 text file, relative to the working directory.",
      inputSchema: z.object({ path: z.string().describe("path relative to cwd") }),
      execute: async ({ path: p }) => {
        try {
          return clip(await fs.readFile(abs(p), "utf8"));
        } catch (e: any) {
          return `ERROR reading ${p}: ${e.message}`;
        }
      },
    }),

    list_dir: tool({
      description: "List the files and folders in a directory (folders end with '/').",
      inputSchema: z.object({ path: z.string().default(".") }),
      execute: async ({ path: p }) => {
        try {
          const ents = await fs.readdir(abs(p), { withFileTypes: true });
          return (
            ents
              .map((e) => (e.isDirectory() ? e.name + "/" : e.name))
              .sort()
              .join("\n") || "(empty)"
          );
        } catch (e: any) {
          return `ERROR listing ${p}: ${e.message}`;
        }
      },
    }),

    write_file: tool({
      description:
        "Create or overwrite a UTF-8 text file (creates parent dirs). Requires write mode.",
      inputSchema: z.object({ path: z.string(), content: z.string() }),
      execute: async ({ path: p, content }) => {
        const b = guard(`write ${p}`);
        if (b) return b;
        try {
          await fs.mkdir(path.dirname(abs(p)), { recursive: true });
          await fs.writeFile(abs(p), content, "utf8");
          onActivity(`wrote ${p} (${content.length}b)`);
          return `OK: wrote ${content.length} bytes to ${p}`;
        } catch (e: any) {
          return `ERROR writing ${p}: ${e.message}`;
        }
      },
    }),

    edit_file: tool({
      description:
        "Replace the FIRST exact occurrence of old_string with new_string in a file. " +
        "old_string must match exactly (including whitespace) and be unique enough to find the right spot. Requires write mode.",
      inputSchema: z.object({
        path: z.string(),
        old_string: z.string(),
        new_string: z.string(),
      }),
      execute: async ({ path: p, old_string, new_string }) => {
        const b = guard(`edit ${p}`);
        if (b) return b;
        try {
          const data = await fs.readFile(abs(p), "utf8");
          if (!data.includes(old_string))
            return `ERROR: old_string not found in ${p}. Read the file again and match exactly.`;
          await fs.writeFile(abs(p), data.replace(old_string, new_string), "utf8");
          onActivity(`edited ${p}`);
          return `OK: edited ${p}`;
        } catch (e: any) {
          return `ERROR editing ${p}: ${e.message}`;
        }
      },
    }),

    bash: tool({
      description:
        "Run a shell command in the working directory; returns stdout+stderr. Use for grep, git, running tests/builds. Requires write mode.",
      inputSchema: z.object({ command: z.string() }),
      execute: async ({ command }) => {
        const b = guard(`run: ${command}`);
        if (b) return b;
        const win = process.platform === "win32";
        try {
          const { stdout, stderr } = await pexec(
            win ? "cmd.exe" : "bash",
            win ? ["/c", command] : ["-c", command],
            { cwd: root(), timeout: 120_000, maxBuffer: 8_000_000, windowsHide: true },
          );
          onActivity(`ran: ${command}`);
          return clip((stdout || "") + (stderr ? "\n[stderr]\n" + stderr : "")) || "(no output)";
        } catch (e: any) {
          return clip(
            `EXIT ${e.code ?? "?"}\n${(e.stdout || "") + (e.stderr || e.message || "")}`,
          );
        }
      },
    }),
  };
}
