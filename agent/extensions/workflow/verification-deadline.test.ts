/**
 * Verification deadline resolver. The executor used to hard-code 120 seconds,
 * which made `pnpm check` (the incident's own gate) unrunnable. These tests pin
 * the resolver instead of waiting on a real timeout.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  HARD_MAX_SHELL_TIMEOUT_SECONDS,
  DEFAULT_SHELL_MAX_TIMEOUT_SECONDS,
  DEFAULT_SHELL_TIMEOUT_SECONDS,
} from "./shell-guard.ts";
import { resolveVerificationDeadline } from "./verification-deadline.ts";

test("an absent or invalid limit falls back to the shell-guard maximum, not 120s", () => {
  for (const limits of [undefined, null, {}, { maxTimeoutSeconds: "nope" }, { maxTimeoutSeconds: 0 }]) {
    const deadline = resolveVerificationDeadline(limits);
    assert.equal(deadline.timeoutSeconds, DEFAULT_SHELL_MAX_TIMEOUT_SECONDS);
    assert.equal(deadline.timeoutMs, DEFAULT_SHELL_MAX_TIMEOUT_SECONDS * 1_000);
    assert.match(deadline.message, new RegExp(`${DEFAULT_SHELL_MAX_TIMEOUT_SECONDS} seconds`));
  }
  assert.ok(
    DEFAULT_SHELL_MAX_TIMEOUT_SECONDS > DEFAULT_SHELL_TIMEOUT_SECONDS,
    "the verification deadline may exceed the interactive default",
  );
});

test("a configured maximum is used verbatim in seconds and milliseconds", () => {
  const deadline = resolveVerificationDeadline({ maxTimeoutSeconds: 300 });
  assert.equal(deadline.timeoutSeconds, 300);
  assert.equal(deadline.timeoutMs, 300_000);
  assert.equal(deadline.message, "Command timed out after 300 seconds");
});

test("a string limit is coerced and an over-cap limit is clamped to the hard cap", () => {
  assert.equal(resolveVerificationDeadline({ maxTimeoutSeconds: "45" }).timeoutSeconds, 45);
  const capped = resolveVerificationDeadline({
    maxTimeoutSeconds: HARD_MAX_SHELL_TIMEOUT_SECONDS + 10_000,
  });
  assert.equal(capped.timeoutSeconds, HARD_MAX_SHELL_TIMEOUT_SECONDS);
  assert.equal(capped.timeoutMs, HARD_MAX_SHELL_TIMEOUT_SECONDS * 1_000);
  assert.doesNotMatch(capped.message, /120/);
});

test("the deadline is always finite, positive and never unbounded", () => {
  for (const value of [-1, 0.5, Number.NaN, Infinity, -Infinity, "1e9", 12.9]) {
    const deadline = resolveVerificationDeadline({ maxTimeoutSeconds: value });
    assert.ok(Number.isFinite(deadline.timeoutSeconds));
    assert.ok(deadline.timeoutSeconds >= 1);
    assert.ok(deadline.timeoutSeconds <= HARD_MAX_SHELL_TIMEOUT_SECONDS);
    assert.equal(deadline.timeoutMs, deadline.timeoutSeconds * 1_000);
  }
});
