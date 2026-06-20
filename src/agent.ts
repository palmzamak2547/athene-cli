// src/agent.ts
//
// The agent turn engine. The Vercel AI SDK's streamText + stopWhen(stepCountIs)
// IS the loop: it streams text + tool-calls, runs our tools, feeds results back,
// and repeats until the model stops or we hit the step cap. We render the stream
// and, crucially, FAIL OVER: if a free model errors before producing any visible
// text (EOL'd model → 410, rate limit, network), we transparently retry the next
// candidate in the tier. That's how a $0 model chain stays reliable.
import { streamText, stepCountIs, type LanguageModel } from "ai";
import pc from "picocolors";
import { resolveCandidates, type Effort } from "./providers.js";
import { makeTools } from "./tools.js";

const SYSTEM = `You are Athene — a precise, terse terminal coding agent (part of the open, free Athene suite).

Operating rules:
- You work inside the user's current directory. INSPECT before you change: use read_file / list_dir / bash(grep) to learn the real code first.
- Make the smallest correct change. Prefer edit_file (exact-string replace) over rewriting whole files.
- After editing code, verify when it's cheap — run the build / tests / the file via bash.
- IRON RULE 0: never invent file contents, APIs, or results. Read them. If you cannot verify something, say so plainly instead of guessing.
- Keep prose short. No preamble. Finish with a single-line summary of what you did (or why you could not).`;

type RunOpts = {
  prompt: string;
  effort: Effort;
  allowWrite: boolean;
  maxSteps: number;
};

export async function runAgent(opts: RunOpts): Promise<void> {
  const candidates = resolveCandidates(opts.effort);
  const tools = makeTools(opts.allowWrite, (line) =>
    process.stderr.write(pc.green(`  ✓ ${line}\n`)),
  );
  const ro = opts.allowWrite ? "" : " · read-only (pass --yolo to edit + run)";

  let lastErr = "";
  for (let i = 0; i < candidates.length; i++) {
    const { model, label } = candidates[i];
    process.stderr.write(pc.dim(`◆ Athene · ${label} · effort=${opts.effort}${ro}\n\n`));

    const res = await streamOnce(model, opts, tools);
    if (res.ok) return;

    lastErr = res.err ?? "unknown error";
    process.stderr.write(pc.yellow(`  ↳ ${label} failed (${lastErr}).`));
    if (i < candidates.length - 1) process.stderr.write(pc.yellow(" trying next free model…\n\n"));
    else process.stderr.write("\n");
  }
  throw new Error(`All free models for effort "${opts.effort}" failed. Last error: ${lastErr}`);
}

// Run one model. Returns ok=true if it produced output / finished cleanly;
// ok=false (with err) only when it failed BEFORE emitting any visible text — the
// safe point to fail over (we never re-emit a half-written answer).
async function streamOnce(
  model: LanguageModel,
  opts: RunOpts,
  tools: ReturnType<typeof makeTools>,
): Promise<{ ok: boolean; err?: string }> {
  let sawText = false;
  try {
    const result = streamText({
      model,
      system: SYSTEM,
      prompt: opts.prompt,
      tools,
      stopWhen: stepCountIs(opts.maxSteps),
    });

    for await (const part of result.fullStream as AsyncIterable<any>) {
      switch (part.type) {
        case "text-delta": {
          const t = part.text ?? part.textDelta ?? "";
          if (t) {
            sawText = true;
            process.stdout.write(t);
          }
          break;
        }
        case "tool-call": {
          const args = part.input ?? part.args ?? {};
          const preview = JSON.stringify(args).replace(/\s+/g, " ").slice(0, 100);
          process.stderr.write(pc.cyan(`\n  → ${part.toolName}(${preview})\n`));
          break;
        }
        case "error": {
          const err = stringifyErr(part.error);
          if (!sawText) return { ok: false, err };
          process.stderr.write(pc.red(`\n[error] ${err}\n`));
          break;
        }
        default:
          break; // tool-result / reasoning / step / finish — quiet for v0
      }
    }
    if (sawText) process.stdout.write("\n");
    return { ok: true };
  } catch (e) {
    if (sawText) {
      process.stdout.write("\n");
      return { ok: true }; // already committed to this answer; don't fail over
    }
    return { ok: false, err: stringifyErr(e) };
  }
}

function stringifyErr(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  const anyE = e as any;
  if (anyE?.responseBody) {
    try {
      const j = JSON.parse(anyE.responseBody);
      if (j.detail) return j.detail;
    } catch {
      /* fall through */
    }
  }
  if (anyE?.message) return String(anyE.message);
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}
