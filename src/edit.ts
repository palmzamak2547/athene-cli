// src/edit.ts
//
// Reliable single-edit application — the thing coding agents fail at most. Models
// can't count lines and drift on whitespace, so we match by CONTENT with an
// escalating, tolerant cascade and return errors that teach the model how to fix
// its own block (aider's highest-ROI trick). Distilled from opencode's replacer
// chain + aider's self-correcting messages (recon 2026-06-20).
//
// Strategy: exact → line-trimmed → whitespace-collapsed. The first strategy that
// yields EXACTLY ONE match wins; >1 is ambiguous (ask for more context); 0 falls
// through, and total miss returns a "closest lines" hint. EOL + BOM are preserved
// (CRLF/BOM mismatch is the single most common real-world failure).

export type EditResult = { ok: true; next: string } | { ok: false; error: string };

export function applyEdit(original: string, oldStr: string, newStr: string): EditResult {
  if (oldStr.length === 0) return { ok: false, error: "old_string is empty." };

  const bom = original.startsWith("﻿") ? "﻿" : "";
  const body = bom ? original.slice(1) : original;
  const eol = body.includes("\r\n") ? "\r\n" : "\n";

  // Normalise line endings for matching; restore on write.
  const C = body.replace(/\r\n/g, "\n");
  const O = oldStr.replace(/\r\n/g, "\n");
  const N = newStr.replace(/\r\n/g, "\n");

  // Already applied? (new text present, old text absent — a common re-edit trap.)
  if (N.trim().length > 0 && !C.includes(O) && C.includes(N)) {
    return {
      ok: false,
      error:
        "The replacement is already in the file — this edit looks already applied. Skip it.",
    };
  }

  const loc = locate(C, O);
  if ("error" in loc) return { ok: false, error: loc.error };

  const nextC = C.slice(0, loc.start) + N + C.slice(loc.end);
  return { ok: true, next: bom + nextC.replace(/\n/g, eol) };
}

type Range = { start: number; end: number };

function locate(content: string, find: string): Range | { error: string } {
  // 1. exact substring
  let ranges = exactRanges(content, find);
  // 2. line-trimmed (ignore leading/trailing whitespace per line)
  if (ranges.length === 0)
    ranges = lineWindowRanges(content, find, (a, b) => a.trim() === b.trim());
  // 3. whitespace-collapsed (runs of spaces/tabs → one space)
  if (ranges.length === 0)
    ranges = lineWindowRanges(content, find, (a, b) => collapse(a) === collapse(b));

  if (ranges.length === 1) return ranges[0];
  if (ranges.length > 1)
    return {
      error: `old_string appears ${ranges.length} times. Add more surrounding context so it matches exactly one place, or split into smaller edits.`,
    };
  return { error: notFoundHint(content, find) };
}

function collapse(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function exactRanges(content: string, find: string): Range[] {
  const out: Range[] = [];
  let i = content.indexOf(find);
  while (i !== -1) {
    out.push({ start: i, end: i + find.length });
    i = content.indexOf(find, i + 1);
  }
  return out;
}

// Match `find` against `content` line-window-by-line-window using a line-equality
// predicate; return the char ranges of the ORIGINAL content (so we replace the
// real text, preserving its whitespace).
function lineWindowRanges(
  content: string,
  find: string,
  eq: (a: string, b: string) => boolean,
): Range[] {
  const cLines = content.split("\n");
  const fLines = find.split("\n");
  const n = fLines.length;
  if (n === 0 || n > cLines.length) return [];

  const offsets: number[] = [];
  let off = 0;
  for (const l of cLines) {
    offsets.push(off);
    off += l.length + 1; // + the "\n"
  }

  const out: Range[] = [];
  for (let i = 0; i + n <= cLines.length; i++) {
    let ok = true;
    for (let j = 0; j < n; j++) {
      if (!eq(cLines[i + j], fLines[j])) {
        ok = false;
        break;
      }
    }
    if (ok) {
      const start = offsets[i];
      const end = offsets[i + n - 1] + cLines[i + n - 1].length;
      out.push({ start, end });
    }
  }
  return out;
}

// "Did you mean…" — surface up to 3 file lines that overlap the first content
// line of old_string, so the model can correct its whitespace/text.
function notFoundHint(content: string, find: string): string {
  const base =
    "old_string not found. It must match the file exactly — including whitespace, indentation, and line endings. Read the file again.";
  const firstLine =
    find
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? "";
  const probe = collapse(firstLine).slice(0, 14);
  if (probe.length < 4) return base;
  const near = content
    .split("\n")
    .filter((l) => collapse(l).includes(probe))
    .slice(0, 3);
  if (!near.length) return base;
  return base + "\nClosest lines in the file:\n" + near.map((l) => "  " + l).join("\n");
}
