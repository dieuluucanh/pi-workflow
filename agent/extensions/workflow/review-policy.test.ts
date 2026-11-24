/**
 * Pure Reviewer ownership policy tests.
 *
 * The policy is the single answer to "may a Reviewer round start right now?".
 * No SDK, no extension, no provider: these cases pin the boundary the
 * Orchestrator/Build regression violated.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  EXECUTING_CHILD_PHASES,
  EXECUTING_RUN_PHASES,
  admitModeTransition,
  admitReviewer,
  executionOwnsSession,
  type ReviewerAdmissionInput,
} from "./review-policy.ts";
import type { OrchestratorRunPhase } from "./orchestrator-run.ts";

const PLAN_AUTO: ReviewerAdmissionInput = {
  trigger: "auto",
  mode: "plan",
  autoReviewEnabled: true,
  hasCurrentPlanSubmission: true,
};

test("review policy: a submitted Plan with automatic review on is admitted", () => {
  assert.deepEqual(admitReviewer(PLAN_AUTO), { ok: true });
});

test("review policy: manual and resume bypass only the automatic flag", () => {
  const manual = admitReviewer({
    trigger: "manual",
    mode: "plan",
    autoReviewEnabled: false,
  });
  assert.deepEqual(manual, { ok: true }, "manual works with automatic off");
  assert.deepEqual(
    admitReviewer({ trigger: "resume", mode: "plan", autoReviewEnabled: false }),
    { ok: true },
    "resume works with automatic off",
  );
  // ...but a live dispatch still owns the session. A paused run is idle from
  // the user's point of view and must not block a review round.
  for (const trigger of ["manual", "resume"] as const) {
    const refused = admitReviewer({
      trigger,
      mode: "plan",
      runPhase: "running",
    });
    assert.equal(refused.ok, false);
    if (!refused.ok) assert.equal(refused.code, "executing-run");
    assert.deepEqual(
      admitReviewer({ trigger, mode: "plan", runPhase: "paused" }),
      { ok: true },
      "an idle/paused run does not own the session",
    );
  }
});

test("review policy: automatic needs both the flag and a current submission", () => {
  const disabled = admitReviewer({ ...PLAN_AUTO, autoReviewEnabled: false });
  assert.equal(disabled.ok, false);
  if (!disabled.ok) assert.equal(disabled.code, "auto-disabled");

  const noSubmission = admitReviewer({
    ...PLAN_AUTO,
    hasCurrentPlanSubmission: false,
  });
  assert.equal(noSubmission.ok, false);
  if (!noSubmission.ok) assert.equal(noSubmission.code, "no-current-submission");

  // Manual review of an existing plan needs no new write.
  assert.deepEqual(
    admitReviewer({
      trigger: "manual",
      mode: "plan",
      autoReviewEnabled: false,
      hasCurrentPlanSubmission: false,
    }),
    { ok: true },
  );
});

test("review policy: every non-Plan mode is refused for every trigger", () => {
  for (const mode of ["build", "orchestrator", null] as const) {
    for (const trigger of ["auto", "manual", "resume"] as const) {
      const refused = admitReviewer({
        ...PLAN_AUTO,
        trigger,
        mode,
      });
      assert.equal(refused.ok, false, `${trigger}/${String(mode)} refused`);
      if (!refused.ok) assert.equal(refused.code, "not-plan");
    }
  }
});

test("review policy: an Orchestrator Build child is never a review owner", () => {
  // Even a child session that believes it is in Plan mode.
  for (const mode of ["plan", "build", "orchestrator", null] as const) {
    const refused = admitReviewer({
      ...PLAN_AUTO,
      mode,
      isOrchestratorChild: true,
    });
    assert.equal(refused.ok, false);
    if (!refused.ok) assert.equal(refused.code, "orchestrator-child");
  }
});

test("review policy: a stale session/cycle owner is refused", () => {
  const refused = admitReviewer({ ...PLAN_AUTO, staleOwner: true });
  assert.equal(refused.ok, false);
  if (!refused.ok) assert.equal(refused.code, "stale-owner");
});

test("review policy: executing child and run phases own the session", () => {
  for (const childPhase of EXECUTING_CHILD_PHASES) {
    assert.equal(executionOwnsSession({ childPhase }), true);
    const refused = admitReviewer({ ...PLAN_AUTO, childPhase });
    assert.equal(refused.ok, false, `child ${childPhase}`);
    if (!refused.ok) assert.equal(refused.code, "executing-run");
  }
  for (const runPhase of EXECUTING_RUN_PHASES) {
    // Between-row windows have no live child: the run phase alone must block.
    assert.equal(executionOwnsSession({ runPhase }), true);
    const refused = admitReviewer({ ...PLAN_AUTO, runPhase });
    assert.equal(refused.ok, false, `run ${runPhase}`);
    if (!refused.ok) assert.equal(refused.code, "executing-run");
  }
  for (const childPhase of ["idle", "disposed"] as const) {
    assert.equal(executionOwnsSession({ childPhase }), false);
  }
  for (const runPhase of ["idle", "paused", "interrupted", "completed", "cancelled"] as const) {
    assert.equal(executionOwnsSession({ runPhase }), false);
  }
});

test("mode transition: leaving Orchestrator while a run executes is refused", () => {
  for (const target of ["plan", "build", null] as const) {
    for (const runPhase of EXECUTING_RUN_PHASES) {
      const res = admitModeTransition({
        target,
        currentMode: "orchestrator",
        runPhase,
      });
      assert.equal(res.ok, false, `${target}/${runPhase}`);
      if (!res.ok) assert.equal(res.code, "executing-run");
    }
    for (const childPhase of EXECUTING_CHILD_PHASES) {
      const res = admitModeTransition({
        target,
        currentMode: "orchestrator",
        childPhase,
      });
      assert.equal(res.ok, false, `${target}/${childPhase}`);
    }
  }
  // Terminal/paused runs release the session.
  for (const runPhase of ["idle", "paused", "interrupted", "completed", "cancelled"] as const) {
    assert.deepEqual(
      admitModeTransition({
        target: "plan",
        currentMode: "orchestrator",
        runPhase: runPhase as OrchestratorRunPhase,
      }),
      { ok: true },
    );
  }
  // Only a live dispatch owns the session between rows.
  assert.deepEqual([...EXECUTING_RUN_PHASES], ["running"]);
});

test("mode transition: children cannot switch; managed bootstrap is exempt", () => {
  for (const target of ["plan", "build", "orchestrator", null] as const) {
    const refused = admitModeTransition({
      target,
      currentMode: "build",
      isOrchestratorChild: true,
    });
    assert.equal(refused.ok, false);
    if (!refused.ok) assert.equal(refused.code, "orchestrator-child");
  }
  assert.deepEqual(
    admitModeTransition({
      target: "build",
      currentMode: "build",
      isOrchestratorChild: true,
      fromManagedChild: true,
    }),
    { ok: true },
  );
});

test("mode transition: staying in Orchestrator is not blocked by its own run", () => {
  assert.deepEqual(
    admitModeTransition({
      target: "orchestrator",
      currentMode: "orchestrator",
      runPhase: "running",
    }),
    { ok: true },
  );
});
