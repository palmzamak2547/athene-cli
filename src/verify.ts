// src/verify.ts
//
// The verify loop — the "don't claim done until the project's own checks pass"
// discipline (Codex / Claude Code do this; it's the prompt-level Iron Rule 0).
// After a turn that CHANGED files, Athene runs the project's check command and,
// if it fails, feeds the failure back to the model to self-correct (bounded).
//
// Detection is deliberately conservative: a fast COMPILE-level check
// (typecheck / build / cargo check / go build), never a slow side-effecting
// test suite by default. The command is NOT model-supplied, so it's trusted,
// but it still routes through the approver (auto under --yolo, asks otherwise)
// so a user in ask-mode is never surprised by a build kicking off.
import { promises as fs } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Approver } from "./approval.js";

const pexec = promisify(execFile);

async function readJson(file: string): Promise<any | null> {
  try {
    return JSON.parse(await fs.readFile(path.join(process.cwd(), file), "utf8"));
  } catch {
    return null;
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(path.join(process.cwd(), file));
    return true;
  } catch {
    return false;
  }
}

// The fast check to run, or null if the project has none we recognise.
export async function detectVerifyCommand(): Promise<string | null> {
  const pkg = await readJson("package.json");
  if (pkg?.scripts) {
    for (const s of ["typecheck", "type-check", "tsc", "build", "lint"]) {
      if (typeof pkg.scripts[s] === "string") return `npm run ${s}`;
    }
  }
  // tsconfig but no script → tsc --noEmit directly.
  if (pkg && (await exists("tsconfig.json"))) return "npx tsc --noEmit";
  if (await exists("Cargo.toml")) return "cargo check";
  if (await exists("go.mod")) return "go build ./...";
  return null;
}

export type VerifyResult = { ran: boolean; ok: boolean; output: string };

// Run the check once. `ran:false` means the user declined to run it (we treat
// that as a non-blocking pass — Athene won't loop a check the user said no to).
export function makeVerifier(
  cmd: string,
  approve: Approver,
  note: (line: string) => void,
): () => Promise<VerifyResult> {
  return async () => {
    const ok = await approve({ title: `verify: ${cmd}`, preview: "" });
    if (!ok) return { ran: false, ok: true, output: "" };
    const win = process.platform === "win32";
    try {
      const { stdout, stderr } = await pexec(
        win ? "cmd.exe" : "bash",
        win ? ["/c", cmd] : ["-c", cmd],
        { cwd: process.cwd(), timeout: 180_000, maxBuffer: 8_000_000, windowsHide: true },
      );
      note(`verify passed: ${cmd}`);
      return { ran: true, ok: true, output: (stdout || "") + (stderr || "") };
    } catch (e: any) {
      const out = ((e.stdout as string) || "") + ((e.stderr as string) || e.message || "");
      return { ran: true, ok: false, output: out.length > 12_000 ? out.slice(-12_000) : out };
    }
  };
}
