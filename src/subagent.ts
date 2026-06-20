// src/subagent.ts
//
// The `task` tool — context isolation. The agent can delegate a focused,
// self-contained sub-job to a fresh sub-agent that runs its OWN streamText loop
// with its OWN message history, and returns ONLY its final report. The parent's
// context grows by that summary, not the sub-agent's whole transcript — the
// Claude-Code / Grok-Build pattern that lets one agent tackle big work without
// drowning its own window. The sub-agent reuses the parent's tools (so its edits
// are still approval-gated) but CANNOT spawn further sub-agents (no recursion).
import { tool, streamText, stepCountIs } from "ai";
import { z } from "zod";
import pc from "picocolors";
import { resolveCandidates, type Effort } from "./providers.js";

const SUB_SYSTEM = `You are a focused sub-agent spawned by Athene to complete ONE self-contained task. You do NOT see the parent conversation — work only from the task given. Use your tools to do it fully, then END with a concise, complete report of what you found or changed. That report is your ONLY output to the caller, so include everything they need (paths, findings, results) and nothing they don't. You CANNOT spawn further sub-agents.`;

const SUB_MAX_STEPS = 16;

export function makeSubagentTool(deps: {
  getTools: () => Record<string, any>;
  getEffort: () => Effort;
  getSystem: () => string;
}) {
  return tool({
    description:
      "Delegate a focused, SELF-CONTAINED sub-task to a fresh sub-agent that has its own context (it does NOT see this conversation) and returns only its final report. Use it for a wide search or a multi-step sub-job whose intermediate detail you don't need in your own context — keeps you lean. It has the same read/search/edit tools (edits still ask for approval) but cannot spawn further sub-agents. Give it a complete, standalone instruction.",
    inputSchema: z.object({
      description: z.string().max(200).describe("a 3-6 word label for the sub-task"),
      prompt: z.string().max(32_000).describe("the complete, standalone instruction for the sub-agent"),
    }),
    execute: async ({ description, prompt }, opts: unknown) => {
      const signal: AbortSignal | undefined = (opts as { abortSignal?: AbortSignal })?.abortSignal;
      const subTools = { ...deps.getTools() };
      delete subTools.task; // prevent recursion — one level deep only

      const cands = resolveCandidates(deps.getEffort());
      if (cands.length === 0) return "ERROR: no model available for the sub-agent.";

      process.stderr.write(pc.magenta(`\n ↳ subagent: ${description}\n`));
      let streamed = "";
      try {
        const result = streamText({
          model: cands[0].model,
          system: SUB_SYSTEM + "\n\n" + deps.getSystem(),
          messages: [{ role: "user", content: prompt }],
          tools: subTools,
          stopWhen: stepCountIs(SUB_MAX_STEPS),
          abortSignal: signal,
          maxRetries: 1, // ride out a transient blip on the one model (grok review)
        });
        for await (const part of result.fullStream as AsyncIterable<{ type: string; text?: string; textDelta?: string }>) {
          if (part.type === "text-delta") {
            const t = part.text ?? part.textDelta ?? "";
            streamed += t;
            process.stderr.write(pc.dim(t)); // nested, dimmed — not the parent's answer
          }
        }
        process.stderr.write(pc.magenta(`\n ↳ subagent done — ${description}\n`));
        // Prefer the SDK's resolved final text over hand-reassembled deltas. (grok review)
        const finalText = ((await result.text.catch(() => "")) || streamed).trim();
        const finishReason = await result.finishReason.catch(() => undefined);
        let report = finalText || "(the sub-agent produced no text report)";
        // Make truncation visible: it stopped because it wanted more steps/tokens. (grok review)
        if (finishReason === "tool-calls" || finishReason === "length") {
          report += `\n\n[sub-agent hit its ${SUB_MAX_STEPS}-step limit — work may be incomplete]`;
        }
        return report.length > 24_000 ? report.slice(0, 24_000) + "\n…(report truncated)" : report;
      } catch (e: unknown) {
        if (signal?.aborted) return "Sub-agent interrupted by the user.";
        const msg = e instanceof Error ? e.message : String(e);
        return `Sub-agent error: ${msg}${streamed ? `\n\nPartial output:\n${streamed.slice(0, 2000)}` : ""}`;
      }
    },
  });
}
