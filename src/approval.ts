// src/approval.ts
//
// The approval gate. Before any mutation (write/edit/bash) Athene shows what it's
// about to do — a colorized diff for edits, the content for new files, the command
// for bash — and asks. Three modes:
//   auto  (--yolo)            : show + apply, never ask (CI / "I trust it")
//   ask   (interactive TTY)   : show + prompt [y]es / [n]o / [a]ll / [q]uit
//   deny  (no TTY, no --yolo) : show + refuse (safe default when piped)
// "all" flips the rest of the session to auto. This is the UX that turns a raw
// agent into something you can actually trust at the keyboard.
import * as readline from "node:readline/promises";
import pc from "picocolors";

export type ApprovalMode = "auto" | "ask" | "deny" | "plan";

export type ApprovalRequest = {
  title: string; // e.g. "edit src/app.ts" / "run: npm test"
  preview: string; // rendered diff / content / command (already colorized)
};

// The approver is a function with a runtime `setPlan` toggle so the REPL's
// `/plan` can flip plan mode on/off without rebuilding the session.
export type Approver = ((req: ApprovalRequest) => Promise<boolean>) & {
  setPlan: (on: boolean) => void;
};

export class ApprovalAbort extends Error {
  constructor() {
    super("aborted by user");
    this.name = "ApprovalAbort";
  }
}

export function createApprover(mode: ApprovalMode): Approver {
  let auto = mode === "auto";
  let plan = mode === "plan";

  const fn = async (req: ApprovalRequest): Promise<boolean> => {
    // Always show what's about to happen.
    process.stderr.write(`\n ${pc.bold(pc.yellow("▸ " + req.title))}\n`);
    if (req.preview.trim()) process.stderr.write(req.preview.replace(/\n?$/, "\n"));

    if (plan) {
      // Plan mode: never apply. The model gets DECLINED and (per the system
      // prompt) presents a plan instead of editing.
      process.stderr.write(pc.dim(" (plan mode — proposing, not applying)\n\n"));
      return false;
    }
    if (auto) {
      process.stderr.write(pc.dim(" (auto-approved)\n\n"));
      return true;
    }
    if (mode === "deny") {
      process.stderr.write(pc.dim(" (skipped — read-only; re-run with --yolo to apply)\n\n"));
      return false;
    }

    // mode === "ask": interactive prompt.
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    try {
      for (;;) {
        const ans = (await rl.question(pc.bold(" apply? ") + pc.dim("[y]es / [n]o / [a]ll / [q]uit » ")))
          .trim()
          .toLowerCase();
        if (ans === "y" || ans === "yes" || ans === "") {
          process.stderr.write("\n");
          return true;
        }
        if (ans === "n" || ans === "no") {
          process.stderr.write(pc.dim(" (skipped)\n\n"));
          return false;
        }
        if (ans === "a" || ans === "all") {
          auto = true;
          process.stderr.write(pc.dim(" (approving the rest of this run)\n\n"));
          return true;
        }
        if (ans === "q" || ans === "quit") {
          rl.close();
          process.stderr.write(pc.red("\n ✗ aborted\n"));
          process.exit(130);
        }
        process.stderr.write(pc.dim(" please answer y / n / a / q\n"));
      }
    } finally {
      rl.close();
    }
  };

  (fn as Approver).setPlan = (on: boolean) => {
    plan = on;
  };
  return fn as Approver;
}

// Decide the mode from flags + whether we have an interactive terminal.
export function pickMode(yolo: boolean): ApprovalMode {
  if (yolo) return "auto";
  return process.stdin.isTTY ? "ask" : "deny";
}
