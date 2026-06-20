import { test } from "node:test";
import assert from "node:assert/strict";
import { outline } from "../src/symbols.js";

test("TS: functions, classes, types, exports, arrow consts", () => {
  const src = `import x from "y";
export function foo(a: number) { return a; }
const bar = (b) => b * 2;
export class Widget {}
export interface Opts { n: number }
type Id = string;
let plain = 1;`;
  const got = outline(src, "ts").map((l) => l.replace(/^\d+:\s*/, ""));
  assert.ok(got.some((l) => l.includes("function foo")));
  assert.ok(got.some((l) => l.includes("const bar")));
  assert.ok(got.some((l) => l.includes("class Widget")));
  assert.ok(got.some((l) => l.includes("interface Opts")));
  assert.ok(got.some((l) => l.includes("type Id")));
  // a plain `let` declaration is not a top-level symbol
  assert.ok(!got.some((l) => l.includes("plain")));
});

test("Python: def + class", () => {
  const got = outline("import os\ndef run(x):\n    pass\nclass Thing:\n    pass\n", "py");
  assert.equal(got.length, 2);
  assert.ok(got[0].includes("def run"));
  assert.ok(got[1].includes("class Thing"));
});

test("Go: func + type struct", () => {
  const got = outline("package main\nfunc Main() {}\ntype T struct {}\n", "go");
  assert.ok(got.some((l) => l.includes("func Main")));
  assert.ok(got.some((l) => l.includes("type T struct")));
});

test("Rust: fn + struct + impl", () => {
  const got = outline("pub fn go() {}\nstruct S {}\nimpl S {}\n", "rs");
  assert.ok(got.some((l) => l.includes("fn go")));
  assert.ok(got.some((l) => l.includes("struct S")));
  assert.ok(got.some((l) => l.includes("impl S")));
});

test("line numbers are 1-based and trailing brace is trimmed", () => {
  const got = outline("\nexport function f() {\n}\n", "ts");
  assert.equal(got[0], "2: export function f()");
});
