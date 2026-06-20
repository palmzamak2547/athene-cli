import { test } from "node:test";
import assert from "node:assert/strict";
import { applyEdit } from "../src/edit.js";

test("exact unique replace", () => {
  const r = applyEdit("hello world", "world", "there");
  assert.ok(r.ok && r.next === "hello there");
});

test("empty old_string is rejected", () => {
  assert.equal(applyEdit("x", "", "y").ok, false);
});

test("ambiguous (>1 occurrence) is rejected", () => {
  assert.equal(applyEdit("a a", "a", "b").ok, false);
});

test("not-found is rejected with a message", () => {
  const r = applyEdit("abc", "xyz", "q");
  assert.ok(!r.ok && typeof r.error === "string" && r.error.length > 0);
});

test("line-trimmed fallback tolerates indentation drift", () => {
  // oldStr lacks the leading indentation the file has.
  const r = applyEdit("    return 1;\n", "return 1;", "return 2;");
  assert.ok(r.ok);
  assert.match((r as { next: string }).next, /return 2;/);
});

test("preserves CRLF line endings", () => {
  const r = applyEdit("a\r\nb\r\nc", "b", "B");
  assert.ok(r.ok && (r as { next: string }).next === "a\r\nB\r\nc");
});
