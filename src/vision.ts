// src/vision.ts — image input.
//
// The model chain is text-only and small models' vision+tool-calling is
// unreliable, so we take the robust path: when the user mentions an image
// (@screenshot.png), a vision NIM "reads" it into a precise text description
// that joins the prompt. So "what's wrong with this UI @shot.png" / "implement
// this mockup @design.png" works, and the proven text agent loop (with all its
// tools) continues from there. Free, via NVIDIA NIM.
import { promises as fs } from "node:fs";
import path from "node:path";

const VISION_MODELS = [
  "meta/llama-3.2-90b-vision-instruct", // strong
  "meta/llama-3.2-11b-vision-instruct", // faster fallback
  "meta/llama-4-maverick-17b-128e-instruct",
];
const ENDPOINT = "https://integrate.api.nvidia.com/v1/chat/completions";
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp)$/i;
const MAX_IMAGE_BYTES = 180_000; // NIM inline data-URL cap (no asset-upload yet)
const MIME: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".webp": "image/webp", ".bmp": "image/bmp",
};

export function isImagePath(p: string): boolean {
  return IMAGE_EXT.test(p);
}

const DEFAULT_INSTRUCTION =
  "Describe this image precisely for a software engineer. If it is a UI: the layout, components, theme/colors, exact visible text, and any visible problems. If it is a diagram or code: transcribe the content faithfully. Be specific and factual — no preamble.";

// Read an image and return a vision model's description, failing over across the
// NIM vision tier. Throws (with a clear reason) if no key / too large / all fail.
export async function describeImage(abs: string, instruction?: string): Promise<string> {
  const key = process.env.NVIDIA_API_KEY;
  if (!key) throw new Error("image input needs NVIDIA_API_KEY (free at build.nvidia.com)");
  // Check size with stat BEFORE loading the whole file into memory (grok review).
  const st = await fs.stat(abs);
  if (st.size > MAX_IMAGE_BYTES) {
    throw new Error(
      `image is ${Math.round(st.size / 1024)}KB — over the ${Math.round(MAX_IMAGE_BYTES / 1024)}KB inline limit (downscale it first)`,
    );
  }
  const buf = await fs.readFile(abs);
  const mime = MIME[path.extname(abs).toLowerCase()] ?? "image/png";
  const dataUrl = `data:${mime};base64,${buf.toString("base64")}`;
  const content = [
    { type: "text", text: instruction ?? DEFAULT_INSTRUCTION },
    { type: "image_url", image_url: { url: dataUrl } },
  ];
  let lastErr = "";
  for (const model of VISION_MODELS) {
    try {
      const res = await fetch(ENDPOINT, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model, messages: [{ role: "user", content }], max_tokens: 600, temperature: 0.2 }),
      });
      if (!res.ok) {
        lastErr = `${model}: ${res.status} ${(await res.text()).slice(0, 120)}`;
        continue;
      }
      const j: any = await res.json();
      const text: string | undefined = j.choices?.[0]?.message?.content?.trim();
      if (text) return text;
      lastErr = `${model}: empty response`;
    } catch (e: any) {
      lastErr = `${model}: ${e?.message ?? e}`;
    }
  }
  throw new Error(`vision failed (${lastErr})`);
}
