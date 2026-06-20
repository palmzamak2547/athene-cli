import { test } from "node:test";
import assert from "node:assert/strict";
import { destructiveReason, isSecretFile, safeResolve } from "../src/tools.js";

test("rm -rf / is blocked", () => assert.ok(destructiveReason("rm -rf /")));
test("rm -rf ~ is blocked", () => assert.ok(destructiveReason("rm -rf ~")));
test("fork bomb is blocked", () => assert.ok(destructiveReason(":(){ :|:& };:")));
test("dd to a raw disk is blocked", () =>
  assert.ok(destructiveReason("dd if=/dev/zero of=/dev/sda")));
test("a smuggled second command is blocked", () =>
  assert.ok(destructiveReason("echo hi; rm -rf /")));
test("benign rm of ./dist is allowed", () =>
  assert.equal(destructiveReason("rm -rf ./dist"), null));
test("git status is allowed", () => assert.equal(destructiveReason("git status"), null));

test(".env is a secret file", () => assert.ok(isSecretFile(".env")));
test(".env.local is a secret file", () => assert.ok(isSecretFile(".env.local")));
test(".env.example is NOT a secret (template)", () =>
  assert.equal(isSecretFile(".env.example"), false));
test("a .pem is a secret file", () => assert.ok(isSecretFile("server.pem")));
test("a normal source file is not secret", () => assert.equal(isSecretFile("index.ts"), false));

test("safeResolve rejects an absolute path", () => assert.equal(safeResolve("/etc/passwd"), null));
test("safeResolve rejects a ../ escape", () => assert.equal(safeResolve("../secrets"), null));
test("safeResolve allows an in-cwd path", () => assert.ok(safeResolve("src/index.ts")));
