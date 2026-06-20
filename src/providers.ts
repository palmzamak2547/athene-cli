// src/providers.ts
//
// Every free frontier endpoint we use is OpenAI-API-compatible, so ONE factory
// (createOpenAICompatible) covers NVIDIA NIM, Groq, Cerebras, and OpenRouter.
// "Effort" selects a model tier; resolveCandidates() returns every key-available
// model in that tier IN ORDER, and the agent fails over to the next one if a
// model errors at runtime (NIM rotates model IDs weekly — EOL'd models return
// 410, so static IDs WILL go stale; failover is how we stay resilient + free).
//
// IDs verified against the live NIM catalog (GET /v1/models) 2026-06-20.
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";

export type Effort = "fast" | "balanced" | "deep";
export const EFFORTS: Effort[] = ["fast", "balanced", "deep"];

// Many free/smaller models reject PARALLEL tool calls — NIM's llama-3.3-70b
// returns 400 "This model only supports single tool-calls at once". The
// openai-compatible provider doesn't expose a typed option for it, so we patch
// the chat-completions body to force single-tool-call-per-step (a standard
// OpenAI field, accepted by Groq/Cerebras/OpenRouter/NIM). Only set it when the
// request actually carries tools, so we never send a stray field on plain chat.
const singleToolCallFetch: typeof fetch = async (input, init) => {
  if (init?.body && typeof init.body === "string") {
    try {
      const b = JSON.parse(init.body);
      let changed = false;
      if (Array.isArray(b.tools) && b.tools.length > 0 && b.parallel_tool_calls === undefined) {
        b.parallel_tool_calls = false;
        changed = true;
      }
      // Ask for token usage in the final streaming chunk (OpenAI-standard).
      if (b.stream === true && b.stream_options === undefined) {
        b.stream_options = { include_usage: true };
        changed = true;
      }
      if (changed) init = { ...init, body: JSON.stringify(b) };
    } catch {
      /* body isn't JSON we recognise — forward untouched */
    }
  }
  return fetch(input, init);
};

type Provider = { baseURL: string; keyEnv: string };

const PROVIDERS: Record<string, Provider> = {
  nim: { baseURL: "https://integrate.api.nvidia.com/v1", keyEnv: "NVIDIA_API_KEY" },
  groq: { baseURL: "https://api.groq.com/openai/v1", keyEnv: "GROQ_API_KEY" },
  cerebras: { baseURL: "https://api.cerebras.ai/v1", keyEnv: "CEREBRAS_API_KEY" },
  openrouter: { baseURL: "https://openrouter.ai/api/v1", keyEnv: "OPENROUTER_API_KEY" },
  // HuggingFace Inference Providers — OpenAI-compatible router. Free tier is only
  // ~$0.10/mo of credits, so it sits LAST in every tier (a safety net, not a
  // workhorse). Model IDs take a :policy suffix (:cheapest / :fastest).
  huggingface: { baseURL: "https://router.huggingface.co/v1", keyEnv: "HF_TOKEN" },
  // Google Gemini via its OpenAI-compatible endpoint. Generous free tier from
  // AI Studio (get a key at aistudio.google.com). OPT-IN: only used if you set
  // GEMINI_API_KEY, so it never affects the default NIM path. (Endpoint + model
  // from Google's docs; not live-verified here — set a key to use it.)
  gemini: {
    baseURL: "https://generativelanguage.googleapis.com/v1beta/openai",
    keyEnv: "GEMINI_API_KEY",
  },
};

// effort → ordered [providerKey, modelId] candidates. The agent walks the list
// until one streams successfully; NIM is always available (we ship the key).
const TIERS: Record<Effort, Array<[string, string]>> = {
  // Sub-second turns for quick edits + Q&A. Groq/Cerebras lead on speed; NIM
  // llama-3.3-70b is the proven always-on floor (verified tool-calling).
  fast: [
    ["groq", "openai/gpt-oss-20b"],
    ["cerebras", "llama-3.3-70b"],
    ["gemini", "gemini-2.5-flash"], // opt-in (GEMINI_API_KEY); fast + strong + free tier
    ["nim", "meta/llama-3.3-70b-instruct"],
    ["openrouter", "meta-llama/llama-3.3-70b-instruct:free"],
    ["huggingface", "openai/gpt-oss-20b:cheapest"],
  ],
  // Default. A strong current coder leads; llama-3.3-70b is the reliable
  // tool-calling backstop right behind it.
  balanced: [
    ["nim", "qwen/qwen3.5-122b-a10b"],
    ["gemini", "gemini-2.5-flash"], // opt-in (GEMINI_API_KEY)
    ["nim", "meta/llama-3.3-70b-instruct"],
    ["groq", "openai/gpt-oss-120b"],
    ["openrouter", "qwen/qwen3-coder:free"],
    ["huggingface", "openai/gpt-oss-120b:cheapest"],
  ],
  // Hard problems → a reasoning model, then an agentic-tuned fallback that does
  // tools well if the reasoner refuses to.
  deep: [
    ["nim", "deepseek-ai/deepseek-v4-pro"],
    ["gemini", "gemini-2.5-pro"], // opt-in (GEMINI_API_KEY); strong reasoning, free tier
    ["nim", "nvidia/llama-3.3-nemotron-super-49b-v1"],
    ["groq", "openai/gpt-oss-120b"],
    ["openrouter", "deepseek/deepseek-r1:free"],
    // Nous Hermes 3 405B — free + large + tool-tuned. Opt-in: needs an OpenRouter
    // key (NIM doesn't host Hermes — verified against the live catalog 2026-06-20).
    ["openrouter", "nousresearch/hermes-3-llama-3.1-405b:free"],
    ["huggingface", "deepseek-ai/DeepSeek-R1:fastest"],
  ],
};

export type Candidate = { model: LanguageModel; label: string };

// All key-available models for an effort, in tier order. Throws only if NO
// provider key is set for any candidate.
export function resolveCandidates(effort: Effort): Candidate[] {
  const out: Candidate[] = [];
  for (const [provKey, modelId] of TIERS[effort]) {
    const def = PROVIDERS[provKey];
    const apiKey = process.env[def.keyEnv];
    if (!apiKey) continue;
    const provider = createOpenAICompatible({
      name: provKey,
      baseURL: def.baseURL,
      apiKey,
      fetch: singleToolCallFetch,
    });
    out.push({ model: provider(modelId), label: `${provKey}:${modelId}` });
  }
  if (out.length === 0) {
    const keys = [...new Set(TIERS[effort].map(([p]) => PROVIDERS[p].keyEnv))];
    throw new Error(
      `No API key set for effort "${effort}". Set one of: ${keys.join(", ")} (NVIDIA_API_KEY is free at build.nvidia.com).`,
    );
  }
  return out;
}
