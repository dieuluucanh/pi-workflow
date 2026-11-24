/**
 * Bounded git runner tests.
 *
 * The runner is the only place the multi-repo resolver shells out to git. These
 * tests pin the bound: success, non-zero exit, a hang (timeout), output
 * truncation and a throwing spawn. No real git is run.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_GIT_TIMEOUT_MS,
  MAX_GIT_OUTPUT_CHARS,
  runBoundedGitSync,
  type BoundedGitOptions,
} from "./git-bounded.ts";

function fakeSpawn(result: unknown): NonNullable<BoundedGitOptions["spawnSync"]> {
  return (() => result) as unknown as NonNullable<BoundedGitOptions["spawnSync"]>;
}

test("git-bounded: a zero exit is ok and keeps stdout", () => {
  const result = runBoundedGitSync(["status", "--porcelain"], "C:/repo", {
    spawnSync: fakeSpawn({ status: 0, stdout: " M a.ts\n", stderr: "" }),
  });
  assert.deepEqual(result, {
    ok: true,
    stdout: " M a.ts\n",
    stderr: "",
    timedOut: false,
    failureClass: "none",
    truncated: false,
  });
});

test("git-bounded: a non-zero exit is an environment failure", () => {
  const result = runBoundedGitSync(["rev-parse", "HEAD"], "C:/repo", {
    spawnSync: fakeSpawn({ status: 128, stdout: "", stderr: "fatal: no repo" }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.failureClass, "environment");
  assert.equal(result.timedOut, false);
  assert.match(result.stderr, /no repo/);
});

test("git-bounded: a timeout is reported, never thrown", () => {
  const result = runBoundedGitSync(["status"], "C:/repo", {
    spawnSync: fakeSpawn({
      status: null,
      stdout: "",
      stderr: "",
      error: { code: "ETIMEDOUT", message: "operation timed out" },
    }),
    timeoutMs: 25,
  });
  assert.equal(result.ok, false);
  assert.equal(result.timedOut, true);
  assert.equal(result.failureClass, "environment");
  assert.match(result.stderr, /timed out after 25ms/);
});

test("git-bounded: a throwing spawn becomes an environment failure", () => {
  const spawnSync = (() => {
    throw new Error("spawn failed");
  }) as unknown as NonNullable<BoundedGitOptions["spawnSync"]>;
  const result = runBoundedGitSync(["status"], "C:/repo", { spawnSync });
  assert.equal(result.ok, false);
  assert.equal(result.failureClass, "environment");
  assert.match(result.stderr, /spawn failed/);
});

test("git-bounded: output is truncated at the configured bound", () => {
  const result = runBoundedGitSync(["status"], "C:/repo", {
    spawnSync: fakeSpawn({ status: 0, stdout: "x".repeat(40), stderr: "" }),
    maxOutputChars: 10,
  });
  assert.equal(result.stdout, "x".repeat(10));
  assert.equal(result.truncated, true);
});

test("git-bounded: defaults are bounded constants", () => {
  assert.equal(DEFAULT_GIT_TIMEOUT_MS, 60_000);
  assert.equal(MAX_GIT_OUTPUT_CHARS, 64_000);
});
