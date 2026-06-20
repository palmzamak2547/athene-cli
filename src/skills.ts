// src/skills.ts
//
// Athene inherits the SAME skill bank that Claude Code + grok share
// (~/.claude/skills), plus its own (~/.athene/skills). Each skill is a folder
// with a SKILL.md (frontmatter name + description, then the body). We index
// name + a SHORT description into the system prompt (cheap), and load the FULL
// skill body on demand via the `use_skill` tool — the token-efficient Claude-Code
// pattern (don't pour 45 full skills into every prompt; surface them, fetch the
// one that matches). Absent dirs are simply skipped, so a public user with no
// skill bank gets a clean, skill-less agent.
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { tool } from "ai";
import { z } from "zod";

const SKILL_DIRS = [
  path.join(os.homedir(), ".athene", "skills"),
  path.join(os.homedir(), ".claude", "skills"), // shared with Claude Code + grok
];

type SkillMeta = { name: string; short: string; file: string };

function parseMeta(text: string, fallback: string): { name: string; description: string } {
  const m = text.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/);
  const fm = m ? m[1] : "";
  return { name: yamlValue(fm, "name") || fallback, description: yamlValue(fm, "description") };
}

// Extract a YAML scalar from a frontmatter block — handles `key: value`, quoted
// values, AND folded/literal blocks (`key: >` / `key: |` with the text on the
// following indented lines). grok review: a single-line-only regex missed those.
function yamlValue(fm: string, key: string): string {
  const lines = fm.split(/\r?\n/);
  const head = new RegExp(`^\\s*${key}:`);
  const i = lines.findIndex((l) => head.test(l));
  if (i === -1) return "";
  const inline = lines[i].replace(head, "").trim();
  if (inline && !/^[>|][-+]?$/.test(inline)) return inline.replace(/^["']|["']$/g, "");
  const baseIndent = lines[i].match(/^(\s*)/)?.[1].length ?? 0;
  const out: string[] = [];
  for (let j = i + 1; j < lines.length; j++) {
    if (lines[j].trim() === "") {
      out.push("");
      continue;
    }
    const indent = lines[j].match(/^(\s*)/)?.[1].length ?? 0;
    if (indent <= baseIndent) break;
    out.push(lines[j].trim());
  }
  return out.join(" ").trim();
}

function shorten(desc: string, n = 120): string {
  const s = desc.replace(/\s+/g, " ").trim();
  if (s.length <= n) return s;
  const cut = s.slice(0, n);
  const sp = cut.lastIndexOf(" ");
  return (sp > 40 ? cut.slice(0, sp) : cut) + "…";
}

async function discover(): Promise<SkillMeta[]> {
  const out: SkillMeta[] = [];
  const seen = new Set<string>();
  for (const dir of SKILL_DIRS) {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => null);
    if (!entries) continue;
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const file = path.join(dir, e.name, "SKILL.md");
      const text = await fs.readFile(file, "utf8").catch(() => null);
      if (!text) continue;
      const { name, description } = parseMeta(text, e.name);
      const key = name.toLowerCase();
      if (!description || seen.has(key)) continue; // ~/.athene wins over ~/.claude
      seen.add(key);
      out.push({ name, short: shorten(description), file });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export type SkillsHandle = {
  tools: Record<string, any>;
  promptIndex: string;
  count: number;
};

export async function loadSkills(): Promise<SkillsHandle> {
  const skills = await discover();
  if (skills.length === 0) return { tools: {}, promptIndex: "", count: 0 };
  const byName = new Map(skills.map((s) => [s.name, s]));

  const use_skill = tool({
    description:
      "Load the full instructions for one of the AVAILABLE SKILLS listed in your system prompt. Call this FIRST whenever the task matches a skill's purpose.",
    inputSchema: z.object({ name: z.string().describe("exact skill name from the SKILLS list") }),
    execute: async ({ name }) => {
      const s =
        byName.get(name) ?? skills.find((x) => x.name.toLowerCase() === name.toLowerCase());
      if (!s) return `No skill "${name}". Available: ${skills.map((x) => x.name).join(", ")}`;
      const raw = await fs.readFile(s.file, "utf8").catch(() => null);
      if (raw === null) return `ERROR loading skill ${name}.`;
      // Strip the frontmatter — the model already has name + description from the
      // index; send only the body. (grok review)
      const body = raw.replace(/^---\s*\r?\n[\s\S]*?\r?\n---\s*\r?\n?/, "").trim() || raw;
      return body.length > 24_000 ? body.slice(0, 24_000) + "\n…(truncated)" : body;
    },
  });

  const promptIndex = skills.map((s) => `- ${s.name}: ${s.short}`).join("\n");
  return { tools: { use_skill }, promptIndex, count: skills.length };
}

// Per-project memory (Claude-Code AGENTS.md / CLAUDE.md pattern): the first of
// these found in the working directory is loaded into the system context so the
// agent knows the project's conventions up front.
const MEMORY_FILES = ["AGENTS.md", "CLAUDE.md", ".athene/AGENTS.md", "athene.md"];

export async function loadProjectMemory(): Promise<{ name: string; text: string } | null> {
  for (const f of MEMORY_FILES) {
    const text = await fs.readFile(path.join(process.cwd(), f), "utf8").catch(() => null);
    if (text && text.trim()) {
      return {
        name: f,
        text: text.length > 12_000 ? text.slice(0, 12_000) + "\n…(truncated)" : text,
      };
    }
  }
  return null;
}
