import { test } from "node:test";
import assert from "node:assert/strict";
import { globToRe } from "../src/search.js";

test("* does not cross path separators", () => {
  const re = globToRe("*.ts");
  assert.ok(re.test("file.ts"));
  assert.ok(!re.test("dir/file.ts"));
});

test("** crosses path separators", () => {
  const re = globToRe("src/**/*.ts");
  assert.ok(re.test("src/a.ts"));
  assert.ok(re.test("src/sub/deep/a.ts"));
  assert.ok(!re.test("other/a.ts"));
});

test("brace alternation", () => {
  const re = globToRe("*.{ts,tsx}");
  assert.ok(re.test("a.ts"));
  assert.ok(re.test("a.tsx"));
  assert.ok(!re.test("a.js"));
});

test("? matches exactly one non-separator char", () => {
  const re = globToRe("a?.ts");
  assert.ok(re.test("ab.ts"));
  assert.ok(!re.test("a.ts"));
  assert.ok(!re.test("a/.ts"));
});

test("dots in the pattern are literal", () => {
  const re = globToRe("config.json");
  assert.ok(re.test("config.json"));
  assert.ok(!re.test("configxjson"));
});
