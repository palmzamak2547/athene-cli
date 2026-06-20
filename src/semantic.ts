// src/semantic.ts — semantic code search.
//
// The capability Cursor / Continue are known for: ask "where is auth handled" /
// "how does the failover work" in plain language and get the right code back,
// even when you don't know the symbol to grep for. We embed the repo with
// NVIDIA's CODE embedding NIM (nv-embedcode-7b-v1, free) into a local vector
// index and answer by cosine similarity — dependency-free (cosine over a JSON
// array; no vector DB to install). Complements grep/symbols: grep is exact,
// symbols is structural, this is meaning-based.
//
// READ-ONLY (like grep/glob/symbols) — no approval. The index lives in
// .athene/semantic-index.json; building it is the only cost and it's opt-in
// (first search_code call, or /index).
import { tool } from "ai";
import { z } from "zod";
import { promises as fs } from "node:fs";
import path from "node:path";
import { isSecretFile } from "./tools.js";

const MODEL = "nvidia/nv-embedcode-7b-v1"; // 4096-dim, code-specialised
const ENDPOINT = "https://integrate.api.nvidia.com/v1/embeddings";
export const INDEX_REL = ".athene/semantic-index.json";

const IGNORE_DIRS = new Set([
  "node_modules", ".git", "dist", "build", ".next", "out", "coverage", ".cache",
  ".turbo", ".parcel-cache", "vendor", ".venv", "venv", "__pycache__", ".idea",
  ".vscode", ".svelte-kit", ".athene",
]);
const BINARY_EXT =
  /\.(png|jpe?g|gif|webp|ico|bmp|tiff?|pdf|zip|gz|tgz|bz2|xz|tar|rar|7z|exe|dll|so|dylib|a|o|bin|dat|woff2?|ttf|eot|otf|mp[34]|m4a|mov|avi|mkv|webm|wav|ogg|flac|class|jar|war|wasm|node|pyc|pdb|lock|map)$/i;
const MINIFIED = /\.min\.(js|css)$/i;
// Lock/generated files are pure noise in a CODE index — skip by name.
const NOISE_FILES = new Set([
  "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "npm-shrinkwrap.json",
  "composer.lock", "Cargo.lock", "poetry.lock", "Gemfile.lock", "go.sum",
]);

const NUL = String.fromCharCode(0); // binary sniff char, never typed as a raw byte
const CHUNK_LINES = 48; // ~a function or two per chunk
const OVERLAP = 8; // carry context across the cut
const MAX_CHUNK_CHARS = 2400; // keep each embed input small
const MAX_FILE_BYTES = 600_000; // skip huge/generated files
const MAX_CHUNKS = 1500; // bound API cost + index size (disclosed when hit)
const BATCH = 16;

type Chunk = { file: string; start: number; end: number; text: string; vec: number[] };
type Index = { model: string; dim: number; built: number; root: string; chunks: Chunk[] };

// ── NIM embedding client ───────────────────────────────────────────────────
function l2normalize(v: number[]): number[] {
  let s = 0;
  for (const x of v) s += x * x;
  const n = Math.sqrt(s) || 1;
  return v.map((x) => x / n);
}

// Embed a batch. Vectors come back L2-normalized so search is a plain dot
// product. On a batch failure (e.g. one oversized input) we split and retry so
// one bad chunk can't sink the whole index.
async function embedBatch(texts: string[], inputType: "query" | "passage"): Promise<number[][]> {
  const key = process.env.NVIDIA_API_KEY;
  if (!key) throw new Error("semantic search needs NVIDIA_API_KEY (free at build.nvidia.com)");
  if (texts.length === 0) return [];
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ input: texts, model: MODEL, input_type: inputType }),
  });
  if (!res.ok) {
    if (texts.length > 1) {
      // split-and-retry: isolate the offending input instead of failing the batch
      const mid = Math.floor(texts.length / 2);
      const [a, b] = await Promise.all([
        embedBatch(texts.slice(0, mid), inputType),
        embedBatch(texts.slice(mid), inputType),
      ]);
      return [...a, ...b];
    }
    throw new Error(`embeddings ${res.status}: ${(await res.text()).slice(0, 180)}`);
  }
  const j: any = await res.json();
  // Preserve request order (NIM returns an `index` per item).
  const out: number[][] = new Array(texts.length);
  for (const d of j.data) out[d.index ?? 0] = l2normalize(d.embedding);
  return out;
}

// ── walk + chunk ─────────────────────────────────────────────────────────────
async function* walk(dir: string): AsyncGenerator<string> {
  let ents: import("node:fs").Dirent[];
  try {
    ents = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of ents) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!IGNORE_DIRS.has(e.name)) yield* walk(full);
    } else if (
      e.isFile() &&
      !BINARY_EXT.test(e.name) &&
      !MINIFIED.test(e.name) &&
      !NOISE_FILES.has(e.name) &&
      !isSecretFile(e.name) // never embed/send .env / keys / credentials (grok review)
    ) {
      yield full;
    }
  }
}

function relForward(abs: string): string {
  return path.relative(process.cwd(), abs).split(path.sep).join("/");
}

function chunkFile(rel: string, text: string): Array<{ file: string; start: number; end: number; text: string }> {
  const lines = text.split(/\r?\n/);
  const chunks: Array<{ file: string; start: number; end: number; text: string }> = [];
  const step = Math.max(1, CHUNK_LINES - OVERLAP);
  for (let i = 0; i < lines.length; i += step) {
    const slice = lines.slice(i, i + CHUNK_LINES);
    let body = slice.join("\n");
    if (!body.trim()) continue;
    if (body.length > MAX_CHUNK_CHARS) body = body.slice(0, MAX_CHUNK_CHARS);
    // Prefix the path so the embedding carries file context (helps retrieval).
    chunks.push({ file: rel, start: i + 1, end: Math.min(i + CHUNK_LINES, lines.length), text: `// ${rel}\n${body}` });
    if (i + CHUNK_LINES >= lines.length) break;
  }
  return chunks;
}

// ── build ─────────────────────────────────────────────────────────────────────
export async function buildIndex(onProgress?: (msg: string) => void): Promise<{ chunks: number; files: number; capped: boolean }> {
  const root = process.cwd();
  const pending: Array<{ file: string; start: number; end: number; text: string }> = [];
  const filesSeen = new Set<string>();
  let capped = false;
  for await (const abs of walk(root)) {
    let stat: import("node:fs").Stats;
    try {
      stat = await fs.stat(abs);
    } catch {
      continue;
    }
    if (stat.size > MAX_FILE_BYTES || stat.size === 0) continue;
    let text: string;
    try {
      text = await fs.readFile(abs, "utf8");
    } catch {
      continue;
    }
    if (text.includes(NUL)) continue; // binary guard
    const rel = relForward(abs);
    const cs = chunkFile(rel, text);
    if (cs.length === 0) continue;
    filesSeen.add(rel);
    for (const c of cs) {
      pending.push(c);
      if (pending.length >= MAX_CHUNKS) {
        capped = true;
        break;
      }
    }
    if (capped) break;
  }

  const chunks: Chunk[] = [];
  let dim = 0;
  for (let i = 0; i < pending.length; i += BATCH) {
    const batch = pending.slice(i, i + BATCH);
    const vecs = await embedBatch(batch.map((c) => c.text), "passage");
    for (let j = 0; j < batch.length; j++) {
      const vec = vecs[j];
      if (!vec) continue;
      dim = vec.length;
      // Round to 4 decimals to keep the JSON index small, then re-normalize so
      // the dot product stays a true cosine (rounding denormalizes). (grok review)
      chunks.push({ ...batch[j], vec: l2normalize(vec.map((x) => Math.round(x * 1e4) / 1e4)) });
    }
    onProgress?.(`embedding ${Math.min(i + BATCH, pending.length)}/${pending.length} chunks…`);
  }

  const index: Index = { model: MODEL, dim, built: Date.now(), root, chunks };
  const out = path.join(root, INDEX_REL);
  await fs.mkdir(path.dirname(out), { recursive: true });
  // Atomic write: a mid-write crash must not leave a truncated index that then
  // parses as garbage — write a temp file and rename over it. (grok review)
  const tmp = `${out}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(index));
  await fs.rename(tmp, out);
  return { chunks: chunks.length, files: filesSeen.size, capped };
}

async function loadIndex(): Promise<Index | null> {
  try {
    const raw = await fs.readFile(path.join(process.cwd(), INDEX_REL), "utf8");
    const idx = JSON.parse(raw) as Index;
    if (idx?.model === MODEL && Array.isArray(idx.chunks)) return idx;
    return null;
  } catch {
    return null;
  }
}

function topK(index: Index, qvec: number[], k: number): Array<{ c: Chunk; score: number }> {
  const scored = index.chunks.map((c) => {
    let dot = 0;
    const v = c.vec;
    const n = Math.min(v.length, qvec.length);
    for (let i = 0; i < n; i++) dot += v[i] * qvec[i];
    return { c, score: dot };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k);
}

// ── search (shared by the tool + the `athene search` CLI) ─────────────────────
// In-session cache so repeated searches don't re-parse the index.
let cachedIndex: Index | null = null;

export async function runSearch(
  query: string,
  k: number,
  opts: { autobuild?: boolean; note?: (m: string) => void } = {},
): Promise<string> {
  const note = opts.note ?? (() => {});
  if (!process.env.NVIDIA_API_KEY) {
    return "ERROR: semantic search needs NVIDIA_API_KEY (free at build.nvidia.com). Use `grep` or `symbols` instead.";
  }
  // Always retry the on-disk load when we have nothing cached — so an index
  // built by `athene index` (or another process) is picked up, not skipped on a
  // sticky "already tried" flag. A missing-file read fails fast. (grok review)
  if (!cachedIndex) cachedIndex = await loadIndex();
  if (!cachedIndex) {
    if (!opts.autobuild) return "No semantic index yet — run `athene index` first.";
    note("building semantic index (first use)…");
    try {
      const r = await buildIndex((m) => note(m));
      if (r.chunks === 0) return "No source files to index here.";
      cachedIndex = await loadIndex();
      note(`indexed ${r.chunks} chunks from ${r.files} files${r.capped ? ` (capped at ${MAX_CHUNKS})` : ""}`);
    } catch (e: any) {
      return `ERROR building index: ${e?.message ?? e}. Use \`grep\` or \`symbols\` instead.`;
    }
  }
  if (!cachedIndex || cachedIndex.chunks.length === 0) return "The semantic index is empty — try `grep` or `symbols`.";
  let qvec: number[] | undefined;
  try {
    [qvec] = await embedBatch([query], "query");
  } catch (e: any) {
    return `ERROR embedding query: ${e?.message ?? e}. Use \`grep\` instead.`;
  }
  if (!qvec) return "ERROR: the query embedding came back empty — try again, or use `grep`."; // (grok review)
  const hits = topK(cachedIndex, qvec, k);
  note(`search_code "${query.slice(0, 40)}" → ${hits.length} hits`);
  const lines = hits.map(({ c, score }) => {
    const body = c.text.replace(/^\/\/ [^\n]*\n/, ""); // drop the path-prefix line
    const snippet = body.split("\n").slice(0, 4).join("\n");
    return `${c.file}:${c.start}-${c.end}  (${score.toFixed(3)})\n${snippet}`;
  });
  return lines.join("\n\n") || `No semantic matches for "${query}".`;
}

// A fresh build invalidates the in-session cache (the next search reloads).
export function invalidateSemanticCache(): void {
  cachedIndex = null;
}

// ── tool ──────────────────────────────────────────────────────────────────────
export function makeSemanticTool(onActivity: (line: string) => void) {
  const note = (l: string) => {
    try {
      onActivity(l);
    } catch {
      /* ignore */
    }
  };
  return {
    search_code: tool({
      description:
        "Semantic code search: find code by MEANING from a natural-language description (e.g. \"where are payments verified\", \"the retry/failover logic\", \"how is auth checked\") — even when you don't know the exact symbol or wording to grep. Use this for \"where/how does X work\" questions; use `grep` for an exact string/regex and `symbols` for a file's structure. The first call builds a local embedding index (may take a moment on a big repo).",
      inputSchema: z.object({
        query: z.string().min(2).describe("what you're looking for, in plain language"),
        k: z.number().int().min(1).max(20).default(6).describe("how many results"),
      }),
      execute: async ({ query, k }) => runSearch(query, k, { autobuild: true, note }),
    }),
  };
}
