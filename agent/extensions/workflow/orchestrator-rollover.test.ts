/**
 * Context-aware rollover tests (step 34): usage thresholds, conservative
 * unknown metadata, safe-boundary checkpoints, no simultaneous writers,
 * counter survival and overflow recovery without a checkpoint.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  assessUsage,
  createCheckpoint,
  planRollover,
  usageRolloverRequest,
  type RolloverInput,
} from "./orchestrator-rollover.ts";
import type { TaskCounters } from "./orchestrator-state.ts";

function counters(over: Partial<TaskCounters> = {}): TaskCounters {
  return { repairRounds: 1, noProgress: 1, rollovers: 0, launchFailures: 0, ...over };
}

function checkpoint() {
  const created = createCheckpoint({
    runId: "run-1",
    taskId: "task-t1",
    attemptId: "attempt-a1",
    sessionId: "session-s1",
    remainingTodos: ["wire the client", "add a test"],
    decisions: ["use the injected transport"],
    files: ["src/client.ts"],
    checks: [{ name: "tests", status: "failed" }],
    partialEffects: ["dependency installed"],
    criteria: ["step-r2"],
    safeBoundary: true,
    now: 5,
  });
  assert.equal(created.ok, true);
  return (created as any).checkpoint;
}

function rollover(over: Partial<RolloverInput> = {}): RolloverInput {
  return {
    runId: "run-1",
    taskId: "task-t1",
    attemptId: "attempt-a1",
    sessionId: "session-s1",
    child: {
      phase: "fenced",
      pendingTools: 0,
      pendingFollowUps: 0,
      leaseGeneration: 4,
      currentLeaseGeneration: 4,
      settled: true,
    },
    next: { attemptId: "attempt-a2", sessionId: "session-s2", generation: 2 },
    checkpoint: checkpoint(),
    counters: counters(),
    now: 10,
    ...over,
  };
}

test("usage levels scale with the real window and never assume competence", () => {
  const small = assessUsage({ tokensUsed: 30_000, contextWindow: 32_000, reserveTokens: 2_000 });
  assert.equal(small.level, "rollover_due");

  const medium = assessUsage({ tokensUsed: 100_000, contextWindow: 128_000, reserveTokens: 8_000 });
  assert.equal(medium.level, "checkpoint_due");

  const large = assessUsage({ tokensUsed: 100_000, contextWindow: 512_000, reserveTokens: 16_000 });
  assert.equal(large.level, "ok");

  const huge = assessUsage({ tokensUsed: 400_000, contextWindow: 1_000_000, reserveTokens: 32_000 });
  assert.equal(huge.level, "ok");

  const overflow = assessUsage({ tokensUsed: 32_000, contextWindow: 32_000, reserveTokens: 1_000 });
  assert.equal(overflow.level, "overflowed");
});

test("unknown or low-confidence metadata is conservative", () => {
  const unknown = assessUsage({ tokensUsed: 10_000 });
  assert.equal(unknown.level, "unknown");
  assert.equal(unknown.usableInput, null);
  assert.match(unknown.reason, /do not treat it as unbounded/);

  const badReserve = assessUsage({ tokensUsed: 10, contextWindow: 1_000, reserveTokens: 2_000 });
  assert.equal(badReserve.level, "unknown");

  const low = assessUsage({
    tokensUsed: 74_000,
    contextWindow: 100_000,
    reserveTokens: 10_000,
    confidence: "low",
  });
  assert.equal(low.level, "checkpoint_due", "low confidence checks in earlier");

  const unsafe = assessUsage({
    tokensUsed: 90_000,
    contextWindow: 100_000,
    reserveTokens: 10_000,
    activeTool: true,
  });
  assert.equal(unsafe.safeBoundary, false);
});

test("checkpoints refuse an unsafe boundary and bound their content", () => {
  const unsafe = createCheckpoint({
    runId: "run-1",
    taskId: "task-t1",
    attemptId: "attempt-a1",
    sessionId: "session-s1",
    safeBoundary: false,
    now: 1,
  });
  assert.equal(unsafe.ok, false);
  assert.equal((unsafe as any).code, "unsafe_boundary");

  const created = checkpoint();
  assert.equal(created.completionClaimed, false);
  assert.equal(created.truncated, false);
  assert.match(created.digest, /^[0-9a-f]{8}$/);

  const huge = createCheckpoint({
    runId: "run-1",
    taskId: "task-t1",
    attemptId: "attempt-a1",
    sessionId: "session-s1",
    remainingTodos: Array.from({ length: 100 }, (_, index) => `todo ${index}`),
    decisions: Array.from({ length: 100 }, (_, index) => `decision ${index} ${"x".repeat(1_500)}`),
    safeBoundary: true,
    now: 1,
  });
  assert.equal(huge.ok, true);
  assert.equal((huge as any).checkpoint.truncated, true);
  assert.ok(JSON.stringify((huge as any).checkpoint).length <= 16_000);
});

test("rollover waits for quiescence and refuses a stale lease", () => {
  const busy = planRollover(
    rollover({
      child: {
        phase: "running",
        pendingTools: 1,
        pendingFollowUps: 0,
        leaseGeneration: 4,
        currentLeaseGeneration: 4,
        settled: true,
      },
    }),
  );
  assert.equal((busy as any).action, "checkpoint_first");

  const stale = planRollover(
    rollover({
      child: {
        phase: "fenced",
        pendingTools: 0,
        pendingFollowUps: 0,
        leaseGeneration: 3,
        currentLeaseGeneration: 4,
        settled: true,
      },
    }),
  );
  assert.equal(stale.ok, false);
  assert.equal((stale as any).code, "lease");

  const sameAttempt = planRollover(rollover({ next: { attemptId: "attempt-a1", sessionId: "s", generation: 2 } }));
  assert.equal(sameAttempt.ok, false);
});

test("a quiescent checkpointed child relaunches without simultaneous writers", () => {
  const decision = planRollover(rollover());
  assert.equal((decision as any).action, "relaunch");
  assert.equal((decision as any).attemptId, "attempt-a2");
  assert.equal((decision as any).generation, 2);
  assert.equal((decision as any).recovery, "checkpoint");
  assert.equal((decision as any).completionClaimed, false);
  assert.equal((decision as any).simultaneousWriters, false);
  assert.equal((decision as any).counters.rollovers, 1);
  assert.equal((decision as any).counters.repairRounds, 1, "repair counters survive rollover");
  assert.equal((decision as any).counters.noProgress, 1);
  assert.match((decision as any).instructions, /checkpoint is not acceptance/);
});

test("overflow without a checkpoint recovers conservatively and budgets still bound it", () => {
  const overflow = planRollover(rollover({ checkpoint: undefined, overflowed: true }));
  assert.equal((overflow as any).action, "relaunch");
  assert.equal((overflow as any).checkpoint, null);
  assert.equal((overflow as any).recovery, "overflow_without_checkpoint");
  assert.equal((overflow as any).completionClaimed, false);
  assert.match((overflow as any).instructions, /re-read changed files/);

  const noCheckpoint = planRollover(rollover({ checkpoint: undefined, overflowed: false }));
  assert.equal((noCheckpoint as any).action, "checkpoint_first");

  const exhausted = planRollover(rollover({ counters: counters({ rollovers: 2 }) }));
  assert.equal((exhausted as any).action, "pause");
  assert.match((exhausted as any).reason, /rollover budget exhausted/);
});

test("usage requests map to checkpoint or cautious recovery", () => {
  assert.equal(
    usageRolloverRequest({
      assessment: assessUsage({ tokensUsed: 1_000, contextWindow: 100_000, reserveTokens: 1_000 }),
      taskId: "task-t1",
      attemptId: "attempt-a1",
    }).action,
    "none",
  );
  assert.equal(
    usageRolloverRequest({
      assessment: assessUsage({ tokensUsed: 96_000, contextWindow: 100_000, reserveTokens: 1_000 }),
      taskId: "task-t1",
      attemptId: "attempt-a1",
    }).action,
    "checkpoint",
  );
  assert.equal(
    usageRolloverRequest({
      assessment: assessUsage({ tokensUsed: 100_000, contextWindow: 100_000, reserveTokens: 1_000 }),
      taskId: "task-t1",
      attemptId: "attempt-a1",
    }).action,
    "recover",
  );
  assert.equal(
    usageRolloverRequest({
      assessment: assessUsage({ tokensUsed: 10 }),
      taskId: "task-t1",
      attemptId: "attempt-a1",
    }).action,
    "checkpoint",
  );
});
