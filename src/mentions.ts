// src/mentions.ts — `@path` inline mentions, shared by the REPL and the
// single-task run. A text file is inlined; an IMAGE is read by a vision model
// (vision.ts) and its description is inlined, so "@mockup.png" works everywhere.
// Confined to cwd; an unreadable @token is left as literal text (the aider /add
// + Claude Code @ convenience).
import { promises as fs } from "node:fs";
import pc from "picocolors";
import { safeResolve } from "./tools.js";
import { isImagePath, describeImage } from "./vision.js";

export async function expandMentions(text: string): Promise<string> {
  const tokens = [...new Set([...text.matchAll(/@([\w./\-]+)/g)].map((m) => m[1]))];
  if (tokens.length === 0) return text;
  const blocks: string[] = [];
  let images = 0;
  for (const rel of tokens) {
    const abs = safeResolve(rel); // robust cwd-confinement (no ../ escape, no abs, no sibling-prefix)
    if (!abs) continue;
    // Don't follow a symlink that could point outside cwd (grok review).
    try {
      if ((await fs.lstat(abs)).isSymbolicLink()) continue;
    } catch {
      continue;
    }
    if (isImagePath(rel)) {
      try {
        process.stderr.write(pc.dim(` 👁 reading image ${rel}…\n`));
        const desc = await describeImage(abs);
        blocks.push(`# ${rel} (image — described by a vision model)\n${desc}`);
        images++;
      } catch (e: any) {
        process.stderr.write(pc.yellow(` could not read image ${rel}: ${e?.message ?? e}\n`));
      }
      continue;
    }
    try {
      const content = await fs.readFile(abs, "utf8");
      blocks.push(`# ${rel}\n${content.length > 16000 ? content.slice(0, 16000) + "\n…(truncated)" : content}`);
    } catch {
      /* not a readable file — leave the @token as plain text */
    }
  }
  if (blocks.length === 0) return text;
  const fileCount = blocks.length - images;
  const parts: string[] = [];
  if (fileCount) parts.push(`${fileCount} file${fileCount === 1 ? "" : "s"}`);
  if (images) parts.push(`${images} image${images === 1 ? "" : "s"}`);
  process.stderr.write(pc.dim(` (added ${parts.join(" + ")})\n`));
  return `${text}\n\n--- mentioned ---\n${blocks.join("\n\n")}`;
}
