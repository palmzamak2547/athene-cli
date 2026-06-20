// src/ui.ts
//
// The terminal UX layer — everything the user sees. Kept separate from logic so
// the "look" is designed in one place: a calm header, a thinking spinner, clean
// tool lines, colorized diffs for edits, and a one-line run summary. All chrome
// goes to STDERR so `athene "..." > out.md` still captures a clean answer.
import pc from "picocolors";
import { diffLines } from "diff";

const OWL = "🦉";
const RULE = pc.dim("─".repeat(52));

function shortenPath(p: string): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  let s = home && p.startsWith(home) ? "~" + p.slice(home.length) : p;
  s = s.replace(/\\/g, "/");
  return s.length > 44 ? "…" + s.slice(-43) : s;
}

export function banner(model: string, effort: string, mode: string, cwd: string): string {
  const modeTag =
    mode === "auto"
      ? pc.yellow("auto-approve")
      : mode === "ask"
        ? pc.green("approve-on-ask")
        : pc.dim("read-only");
  return (
    "\n" +
    ` ${pc.cyan(pc.bold(`${OWL} Athene`))}\n` +
    ` ${pc.bold(effort)}${pc.dim("  ·  " + model)}${pc.dim("  ·  ")}${modeTag}${pc.dim("  ·  " + shortenPath(cwd))}\n` +
    ` ${RULE}\n\n`
  );
}

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
export function makeSpinner(label: string) {
  const tty = !!process.stderr.isTTY;
  let timer: ReturnType<typeof setInterval> | null = null;
  let i = 0;
  return {
    start() {
      if (!tty || timer) return;
      timer = setInterval(() => {
        process.stderr.write(`\r ${pc.cyan(FRAMES[i++ % FRAMES.length])} ${pc.dim(label)}`);
      }, 80);
    },
    stop() {
      if (!timer) return; // only clear the line when we were actually spinning
      clearInterval(timer);
      timer = null;
      if (tty) process.stderr.write("\r\x1b[2K"); // clear the spinner line
    },
  };
}

const TOOL_ICON: Record<string, string> = {
  read_file: "📖",
  list_dir: "📂",
  write_file: "✎",
  edit_file: "✎",
  bash: "❯",
};

export function toolLine(name: string, target: string): string {
  const icon = TOOL_ICON[name] ?? "⚒";
  return ` ${pc.cyan(icon)} ${pc.cyan(name)} ${pc.dim(target)}\n`;
}

export function noteLine(text: string): string {
  return ` ${pc.green("✓")} ${pc.dim(text)}\n`;
}

export function warnLine(text: string): string {
  return ` ${pc.yellow("•")} ${pc.yellow(text)}\n`;
}

export function errLine(text: string): string {
  return ` ${pc.red("✗")} ${pc.red(text)}\n`;
}

// Colorized unified-style diff with collapsed unchanged context, so an edit is
// readable at a glance (green add / red remove / dim context).
export function renderDiff(oldStr: string, newStr: string, opts?: { context?: number; max?: number }): string {
  const context = opts?.context ?? 2;
  const max = opts?.max ?? 80;
  const parts = diffLines(oldStr, newStr);
  const out: string[] = [];
  let shown = 0;

  const push = (line: string) => {
    if (shown >= max) return;
    out.push(line);
    shown++;
  };

  parts.forEach((part, idx) => {
    const lines = part.value.replace(/\n$/, "").split("\n");
    if (part.added) lines.forEach((l) => push(pc.green(`  + ${l}`)));
    else if (part.removed) lines.forEach((l) => push(pc.red(`  - ${l}`)));
    else {
      // Unchanged: keep a little context near edits, collapse the middle.
      const isFirst = idx === 0;
      const isLast = idx === parts.length - 1;
      if (lines.length <= context * 2 + 1) {
        lines.forEach((l) => push(pc.dim(`    ${l}`)));
      } else {
        const head = isFirst ? [] : lines.slice(0, context);
        const tail = isLast ? [] : lines.slice(-context);
        head.forEach((l) => push(pc.dim(`    ${l}`)));
        push(pc.dim(`    ⋯ ${lines.length - head.length - tail.length} unchanged`));
        tail.forEach((l) => push(pc.dim(`    ${l}`)));
      }
    }
  });
  if (shown >= max) out.push(pc.dim("    … diff truncated"));
  return out.join("\n");
}

export function summary(stats: {
  files: number;
  commands: number;
  ms: number;
  tokens?: number;
}): string {
  const bits = [
    `${stats.files} file${stats.files === 1 ? "" : "s"} changed`,
    stats.commands > 0 ? `${stats.commands} command${stats.commands === 1 ? "" : "s"}` : null,
    `${(stats.ms / 1000).toFixed(1)}s`,
    stats.tokens ? `≈${stats.tokens.toLocaleString()} tok` : null,
  ].filter(Boolean);
  return `\n ${pc.dim("◇")} ${pc.dim(bits.join("  ·  "))}\n`;
}
