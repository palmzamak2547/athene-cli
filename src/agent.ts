// src/agent.ts
//
// The agent turn engine + presentation. The Vercel AI SDK's streamText +
// stopWhen(stepCountIs) IS the loop; we render it through ui.ts (banner, thinking
// spinner, tool lines, run summary) and gate mutations through the approver. We
// also FAIL OVER: if a free model errors before producing any visible text or
// side-effect, we transparently retry the next candidate in the tier.
import { streamText, stepCountIs, type LanguageModel } from "ai";
import pc from "picocolors";
import { resolveCandidates, type Effort } from "./providers.js";
import { makeTools } from "./tools.js";
import { createApprover, type ApprovalMode } from "./approval.js";
import * as ui from "./ui.js";

const SYSTEM = `You are Athene — a precise, terse terminal coding agent (part of the open, free Athene suite).

Operating rules:
- You work inside the user's current directory. INSPECT before you change: use read_file / list_dir / bash(grep) to learn the real code first.
- Make the smallest correct change. Prefer edit_file (exact, unique-match string replace) over rewriting whole files.
- After editing code, verify when it's cheap — run the build / tests / the file via bash.
- IRON RULE 0: never invent file contents, APIs, or results. Read them. If you cannot verify something, say so plainly instead of guessing.
- If a tool result says DECLINED or BLOCKED, the user refused that action — do NOT claim you made the change. Report that it was skipped and stop.
- Keep prose short. No preamble. Finish with a single-line summary of what you did (or why you could not).`;

type RunOpts = {
  prompt: string;
  effort: Effort;
  mode: ApprovalMode;
  maxSteps: number;
};

export async function runAgent(opts: RunOpts): Promise<void> {
  const candidates = resolveCandidates(opts.effort);
  const approve = createApprover(opts.mode);

  // Stats for the run summary + the failover side-effect guard.
  const files = new Set<string>();
  let commands = 0;
  let sideEffected = false;
  const tools = makeTools(approve, (line) => {
    sideEffected = true;
    if (line.startsWith("ran:")) commands++;
    else {
      const m = line.match(/^(?:wrote|edited)\s+(\S+)/);
      if (m) files.add(m[1]);
    }
    process.stderr.write(ui.noteLine(line));
  });

  const started = Date.now();
  let lastErr = "";
  for (let i = 0; i < candidates.length; i++) {
    const { model, label } = candidates[i];
    process.stderr.write(ui.banner(label, opts.effort, opts.mode, process.cwd()));

    const res = await streamOnce(model, opts, tools);
    if (res.ok) {
      process.stderr.write(ui.summary({ files: files.size, commands, ms: Date.now() - started }));
      return;
    }

    lastErr = res.err ?? "unknown error";
    // If a model already mutated the workspace then failed, retrying a different
    // model would duplicate those changes. Stop instead. (grok review)
    if (sideEffected) {
      throw new Error(
        `${label} failed AFTER modifying the workspace — not retrying another model to avoid duplicate changes. Error: ${lastErr}`,
      );
    }
    process.stderr.write(ui.warnLine(`${label} failed (${lastErr})`));
    if (i < candidates.length - 1) process.stderr.write(pc.dim("   trying the next free model…\n"));
  }
  throw new Error(`All free models for effort "${opts.effort}" failed. Last error: ${lastErr}`);
}

// Run one model. ok=true if it produced output / finished cleanly; ok=false (with
// err) only when it failed BEFORE emitting any visible text — the safe failover
// point (we never re-emit a half-written answer).
async function streamOnce(
  model: LanguageModel,
  opts: RunOpts,
  tools: ReturnType<typeof makeTools>,
): Promise<{ ok: boolean; err?: string }> {
  const spin = ui.makeSpinner("thinking…");
  let sawText = false;
  spin.start();
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
            spin.stop();
            sawText = true;
            process.stdout.write(t);
          }
          break;
        }
        case "tool-call": {
          spin.stop();
          // Read-only tools just announce themselves; mutating tools render via
          // the approver (diff/command + prompt) inside their execute().
          const name = part.toolName;
          if (name === "read_file" || name === "list_dir") {
            const args = (part.input ?? part.args ?? {}) as Record<string, unknown>;
            process.stderr.write(ui.toolLine(name, String(args.path ?? ".")));
          }
          break;
        }
        case "tool-result": {
          spin.start(); // the model will now think about the next step
          break;
        }
        case "error": {
          const err = stringifyErr(part.error);
          spin.stop();
          if (!sawText) return { ok: false, err };
          process.stderr.write(ui.errLine(err));
          break;
        }
        default:
          break;
      }
    }
    spin.stop();
    if (sawText) process.stdout.write("\n");
    return { ok: true };
  } catch (e) {
    spin.stop();
    const err = stringifyErr(e);
    if (sawText) {
      process.stdout.write("\n");
      process.stderr.write(ui.errLine(err));
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
