/**
 * Scoped repair + no-progress tests (step 33).
 *
 * Pins: failure classification, a bounded directive containing the failed
 * criteria/checks/files/non-goals, same-warm-child vs fresh continuation,
 * budget exhaustion with explicit controls, stale-lease refusal and the
 * "never advance while verification fails" counter rule.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildDirective,
  buildRepairDecision,
  classifyFailure,
  recordRepairOutcome,
  repairControls,
  type RepairInput,
} from "./orchestrator-repair.ts";
import type { TaskCounters } from "./orchestrator-state.ts";

function counters(over: Partial<TaskCounters> = {}): TaskCounters {
  return { repairRounds: 0, noProgress: 0, rollovers: 0, launchFailures: 0, ...over };
}

function input(over: Partial<RepairInput> = {}): RepairInput {
  return {
    runId: "run-1",
    taskId: "task-t1",
    attemptId: "attempt-a1",
    candidateId: "candidate-c1",
    category: "verification",
    objective: "Implement the client",
    failedCriteria: [
      { roadmapStepId: "step-r2", status: "unmet", note: "client not wired" },
    ],
    failedChecks: [
      { name: "tests", status: "failed", evidence: "1 failing: client.test.ts" },
    ],
    changedFiles: ["src/client.ts"],
    nonGoals: ["do not rewrite the transport"],
    child: {
      phase: "fenced",
      warm: true,
      leaseGeneration: 4,
      currentLeaseGeneration: 4,
    },
    counters: counters(),
    now: 10,
    ...over,
  };
}

test("failure classification separates code from environment and scope", () => {
  assert.equal(classifyFailure(["check_failed"]).category, "verification");
  assert.equal(classifyFailure(["provider_error"]).category, "provider");
  assert.equal(classifyFailure(["launch_failed"]).category, "launch");
  assert.equal(classifyFailure(["context_exhausted"]).requiresRollover, true);
  assert.equal(classifyFailure(["manual_only"]).requiresHuman, true);
  assert.equal(classifyFailure(["check_failed", "scope_revision"]).category, "scope");
  assert.equal(classifyFailure(["provider_error", "context_exhausted"]).category, "context");
});

test("the directive is scoped, explicit and bounded", () => {
  const directive = buildDirective(
    input({
      failedChecks: Array.from({ length: 100 }, (_, index) => ({
        name: `check-${index}`,
        status: "failed",
        evidence: "x".repeat(2_000),
      })),
    }),
    1,
    3,
  );
  assert.equal(directive.failedChecks.length, 64);
  assert.match(directive.guidance, /Failed criteria: step-r2 \(unmet\)/);
  assert.match(directive.guidance, /Files already changed: src\/client.ts/);
  assert.match(directive.guidance, /Non-goals: do not rewrite the transport/);
  assert.match(directive.guidance, /Do not repeat unchanged side effects/);
  assert.equal(directive.doNotRepeatUnchangedEffects, true);
  assert.ok(directive.guidance.length <= 8_000);
});

test("a warm fenced child gets a repair; a gone child gets a continuation", () => {
  const warm = buildRepairDecision(input());
  assert.equal(warm.ok, true);
  assert.equal((warm as any).action, "same_child");
  assert.equal((warm as any).requiresResume, false);
  assert.equal((warm as any).message, "repair");
  assert.equal((warm as any).directive.round, 1);

  const paused = buildRepairDecision(
    input({ child: { phase: "paused", warm: true, leaseGeneration: 4, currentLeaseGeneration: 4 } }),
  );
  assert.equal((paused as any).action, "same_child");
  assert.equal((paused as any).requiresResume, true);

  const gone = buildRepairDecision(
    input({ child: { phase: "interrupted", warm: false, leaseGeneration: 4, currentLeaseGeneration: 4 } }),
  );
  assert.equal((gone as any).action, "fresh_continuation");
  assert.match((gone as any).reason, /window\/tab is gone/);
});

test("repair and no-progress budgets pause with explicit controls", () => {
  const repair = buildRepairDecision(input({ counters: counters({ repairRounds: 2 }) }));
  assert.equal((repair as any).action, "pause");
  assert.match((repair as any).reason, /repair budget exhausted/);
  assert.deepEqual((repair as any).controls, ["retry", "unblock", "cancel"]);

  const noProgress = buildRepairDecision(input({ counters: counters({ noProgress: 2 }) }));
  assert.equal((noProgress as any).action, "pause");
  assert.match((noProgress as any).reason, /no-progress budget exhausted/);

  const controls = repairControls({ reason: "repair budget exhausted" });
  assert.equal(controls.retry.requiresExplicitConfirmation, true);
  assert.equal(controls.retry.resetsBudget, false);
  assert.equal(controls.cancel.keepsEdits, true);
  assert.equal(controls.cancel.automaticRollback, false);
});

test("a stale lease generation cannot send a repair", () => {
  const stale = buildRepairDecision(
    input({ child: { phase: "fenced", warm: true, leaseGeneration: 3, currentLeaseGeneration: 4 } }),
  );
  assert.equal(stale.ok, false);
  assert.equal((stale as any).code, "lease");
});

test("provider, launch, manual and context failures take their own routes", () => {
  const provider = buildRepairDecision(
    input({ category: "provider", child: { phase: "running", warm: true, leaseGeneration: 4, currentLeaseGeneration: 4 } }),
  );
  assert.equal((provider as any).action, "retry");
  assert.equal((provider as any).target, "same_child");

  const launch = buildRepairDecision(input({ category: "launch" }));
  assert.equal((launch as any).action, "retry");
  assert.equal((launch as any).target, "fresh_launch");

  const launchExhausted = buildRepairDecision(
    input({ category: "launch", counters: counters({ launchFailures: 3 }) }),
  );
  assert.equal((launchExhausted as any).action, "pause");

  const manual = buildRepairDecision(input({ category: "manual" }));
  assert.equal((manual as any).action, "wait");
  assert.equal((manual as any).requiresHuman, true);

  const context = buildRepairDecision(input({ category: "context" }));
  assert.equal((context as any).action, "rollover_required");

  const scope = buildRepairDecision(input({ category: "scope" }));
  assert.equal((scope as any).action, "pause");
  assert.equal((scope as any).requiresApproval, true);
});

test("counter updates never advance while verification fails", () => {
  const changed = recordRepairOutcome({
    counters: counters({ noProgress: 1, repairRounds: 1 }),
    outcome: "meaningful_change",
    verificationFailed: true,
  });
  assert.equal(changed.ok, true);
  assert.equal((changed as any).action, "retry");
  assert.equal((changed as any).counters.noProgress, 0);
  assert.equal((changed as any).counters.repairRounds, 2);

  const unchanged = recordRepairOutcome({
    counters: counters({ noProgress: 1, repairRounds: 0 }),
    outcome: "no_change",
    verificationFailed: true,
  });
  assert.equal((unchanged as any).action, "pause");
  assert.match((unchanged as any).reason, /no-progress budget exhausted/);
  assert.equal((unchanged as any).counters.noProgress, 2);

  const over = recordRepairOutcome({
    counters: counters({ repairRounds: 2 }),
    outcome: "meaningful_change",
    verificationFailed: true,
  });
  assert.equal((over as any).action, "pause");
  assert.match((over as any).reason, /repair budget exhausted/);

  const blocked = recordRepairOutcome({
    counters: counters(),
    outcome: "blocked",
    verificationFailed: true,
  });
  assert.equal((blocked as any).action, "pause");
});
