/**
 * Pure decisions for the Review Mode → Plannotator handoff.
 *
 * The browser request itself lives in index.ts; these helpers keep the
 * correlation, supersede and reload-recovery rules testable without a host.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  pendingHandoffIsStale,
  reviewHandoffRecovery,
  shouldHandoffManualResult,
} from "./review-handoff.ts";

test("reviewHandoffRecovery: pending keeps only a matching plan", () => {
  assert.deepEqual(
    reviewHandoffRecovery({ status: "pending", pendingHash: "h1", currentHash: "h1" }),
    { action: "keep", reason: "pending" },
  );
  assert.deepEqual(
    reviewHandoffRecovery({ status: "pending", pendingHash: "h1", currentHash: "h2" }),
    { action: "clear", reason: "the plan changed since the review opened" },
  );
  assert.deepEqual(
    reviewHandoffRecovery({ status: "pending" }),
    { action: "keep", reason: "pending" },
  );
});

test("reviewHandoffRecovery: completed applies the recorded decision", () => {
  assert.deepEqual(
    reviewHandoffRecovery({
      status: "completed",
      approved: true,
      feedback: "ok",
      pendingHash: "h1",
      currentHash: "h1",
    }),
    { action: "apply", approved: true, feedback: "ok" },
  );
  assert.deepEqual(
    reviewHandoffRecovery({
      status: "completed",
      approved: false,
      feedback: "revise",
    }),
    { action: "apply", approved: false, feedback: "revise" },
  );
  assert.deepEqual(
    reviewHandoffRecovery({
      status: "completed",
      approved: true,
      pendingHash: "h1",
      currentHash: "h2",
    }),
    { action: "clear", reason: "the plan changed since the review opened" },
  );
});

test("reviewHandoffRecovery: missing and malformed statuses clear", () => {
  assert.deepEqual(reviewHandoffRecovery({ status: "missing" }), {
    action: "clear",
    reason: "the browser review is no longer available",
  });
  assert.deepEqual(
    reviewHandoffRecovery({ status: "completed" }),
    { action: "apply", approved: false },
    "a completed status without an approval field is a denial",
  );
});

test("pendingHandoffIsStale: force, cycle and plan hash decide", () => {
  assert.equal(pendingHandoffIsStale({ awaiting: false }), false);
  assert.equal(
    pendingHandoffIsStale({ awaiting: true, force: true }),
    true,
  );
  assert.equal(
    pendingHandoffIsStale({
      awaiting: true,
      pendingCycleId: 1,
      currentCycleId: 2,
    }),
    true,
  );
  assert.equal(
    pendingHandoffIsStale({
      awaiting: true,
      pendingPlanHash: "h1",
      nextPlanHash: "h2",
    }),
    true,
  );
  assert.equal(
    pendingHandoffIsStale({
      awaiting: true,
      pendingCycleId: 2,
      currentCycleId: 2,
      pendingPlanHash: "h1",
      nextPlanHash: "h1",
    }),
    false,
  );
});

test("shouldHandoffManualResult: only a settled manual round hands off", () => {
  assert.equal(shouldHandoffManualResult({ outcome: "rewritten" }), true);
  assert.equal(shouldHandoffManualResult({ outcome: "unchanged" }), true);
  assert.equal(shouldHandoffManualResult({ outcome: "fallback" }), true);
  assert.equal(shouldHandoffManualResult({ outcome: "skipped" }), true);
  assert.equal(shouldHandoffManualResult({ outcome: "paused" }), false);
  assert.equal(shouldHandoffManualResult({ outcome: "aborted" }), false);
});
