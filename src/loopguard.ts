// src/loopguard.ts
//
// Stops a weaker model from spinning — calling the same tool with the same
// arguments over and over instead of synthesising an answer (seen live: a fast
// model called an MCP tool 10× alternating {day:0}/{day:"0"}). We NORMALISE args
// (so 0 and "0" collapse to one signature, defeating trivial-variation evasion),
// cache the first result, and on a repeat hand back that cached result with a
// nudge to use it — then a hard stop after `maxRepeat`. Acts at the tool-execute
// boundary, so it's reliable and doesn't depend on SDK step internals.
export type LoopGuard = {
  before(name: string, args: unknown): string | null;
  after(name: string, args: unknown, result: string): void;
};

function normalize(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (Array.isArray(v)) return "[" + v.map(normalize).join(",") + "]";
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    return (
      "{" +
      Object.keys(o)
        .sort()
        .map((k) => k + ":" + normalize(o[k]))
        .join(",") +
      "}"
    );
  }
  return String(v); // coerce number/bool/string → same key (0 === "0")
}

export function makeLoopGuard(maxRepeat = 4): LoopGuard {
  const counts = new Map<string, number>();
  const cache = new Map<string, string>();
  return {
    before(name, args) {
      const sig = name + "|" + normalize(args);
      const n = (counts.get(sig) ?? 0) + 1;
      counts.set(sig, n);
      if (n >= maxRepeat) {
        return `STOP: you have already called ${name} with these arguments ${n} times. Do NOT call it again — write your final answer now using the results you already have.`;
      }
      if (n >= 2) {
        const prev = cache.get(sig);
        if (prev !== undefined) {
          return `You already called ${name} with these arguments; it returned:\n${prev}\n\nUse this result — do not call it again.`;
        }
      }
      return null;
    },
    after(name, args, result) {
      const sig = name + "|" + normalize(args);
      cache.set(sig, result.length > 4000 ? result.slice(0, 4000) + "…" : result);
    },
  };
}
