import { test } from "node:test";
import assert from "node:assert/strict";
import { makeLoopGuard } from "../src/loopguard.js";

test("first call passes through", () => {
  const g = makeLoopGuard();
  assert.equal(g.before("read", { p: "a" }), null);
});

test("a repeat returns the cached result as a nudge", () => {
  const g = makeLoopGuard();
  g.before("read", { p: "a" });
  g.after("read", { p: "a" }, "RESULT-XYZ");
  const msg = g.before("read", { p: "a" });
  assert.ok(msg && msg.includes("RESULT-XYZ"));
});

test("args normalize so 0 and \"0\" are the same call", () => {
  const g = makeLoopGuard();
  g.before("t", { day: 0 });
  g.after("t", { day: 0 }, "r");
  assert.ok(g.before("t", { day: "0" })); // recognised as a repeat
});

test("hard STOP after maxRepeat", () => {
  const g = makeLoopGuard(4);
  g.before("x", {});
  g.before("x", {});
  g.before("x", {});
  const msg = g.before("x", {});
  assert.ok(msg && msg.startsWith("STOP"));
});

test("reset clears counts + cache", () => {
  const g = makeLoopGuard();
  g.before("x", {});
  g.after("x", {}, "r");
  g.reset();
  assert.equal(g.before("x", {}), null);
});
