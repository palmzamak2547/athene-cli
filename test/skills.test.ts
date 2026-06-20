import { test } from "node:test";
import assert from "node:assert/strict";
import { parseMeta } from "../src/skills.js";

const fm = (body: string) => `---\n${body}\n---\n# heading\ncontent`;

test("single-line name + description", () => {
  const r = parseMeta(fm("name: foo\ndescription: does a thing"), "fallback");
  assert.equal(r.name, "foo");
  assert.equal(r.description, "does a thing");
});

test("quoted description is unwrapped", () => {
  const r = parseMeta(fm('name: foo\ndescription: "quoted desc"'), "fb");
  assert.equal(r.description, "quoted desc");
});

test("folded > description spanning lines (the grok-found case)", () => {
  const r = parseMeta(fm("name: foo\ndescription: >\n  line one\n  line two"), "fb");
  assert.equal(r.description, "line one line two");
});

test("literal | description", () => {
  const r = parseMeta(fm("name: foo\ndescription: |\n  alpha\n  beta"), "fb");
  assert.equal(r.description, "alpha beta");
});

test("missing name falls back to the folder name", () => {
  const r = parseMeta(fm("description: hi"), "the-folder");
  assert.equal(r.name, "the-folder");
});

test("no frontmatter → empty description", () => {
  const r = parseMeta("# just a heading\ntext", "fb");
  assert.equal(r.name, "fb");
  assert.equal(r.description, "");
});
