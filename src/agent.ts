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
  // A mutating tool (write/edit/bash) ran → the workspace changed → it is NOT
  // safe to fail over to another model (it would replay those side-effects).
  // makeTools only calls onActivity on a SUCCESSFUL mutation; reads are silent.
  let sideEffected = false;
  const tools = makeTools(opts.allowWrite, (line) => {
    sideEffected = true;
    process.stderr.write(pc.green(`  ✓ ${line}\n`));
  });
  const ro = opts.allowWrite ? "" : " · read-only (pass --yolo to edit + run)";

  let lastErr = "";
  for (let i = 0; i < candidates.length; i++) {
    const { model, label } = candidates[i];
    process.stderr.write(pc.dim(`◆ Athene · ${label} · effort=${opts.effort}${ro}\n\n`));

    const res = await streamOnce(model, opts, tools);
    if (res.ok) return;

    lastErr = res.err ?? "unknown error";
    // grok review 1a: if a model already mutated the workspace then failed,
    // retrying a different model would duplicate those changes. Stop instead.
    if (sideEffected) {
      throw new Error(
        `${label} failed AFTER modifying the workspace — not retrying another model to avoid duplicate changes. Error: ${lastErr}`,
      );
    }
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
          // grok review 2a: show only the locating arg (path/command), never the
          // full args JSON — keeps file bodies + anything secret out of the log.
          const args = (part.input ?? part.args ?? {}) as Record<string, unknown>;
          const key = "command" in args ? "command" : "path" in args ? "path" : null;
          const preview = key
            ? String(args[key]).replace(/\s+/g, " ").slice(0, 80)
            : Object.keys(args).join(", ");
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
    const err = stringifyErr(e);
    if (sawText) {
      // grok review 1b: already committed to this answer — surface the error
      // (don't swallow it) but keep the partial output rather than failing over.
      process.stdout.write("\n");
      process.stderr.write(pc.red(`[error] ${err}\n`));
      return { ok: true };
    }
    return { ok: false, err };
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
