import { test } from "node:test";
import assert from "node:assert/strict";

import {
  armExecution,
  applyExecutionEvent,
  canUseShell,
  evaluateExecutionOutcome,
  isCleanCompletion,
  isShellQuarantined,
  needsNonShellRecovery,
  selectNextRow,
  shellCommandHash,
  shouldClearShellAttempt,
  type ExecutionRow,
  type ExecutionState,
} from "./execution-state.ts";

const rows: ExecutionRow[] = [
  { id: "r1", ref: "1", status: "completed" },
  { id: "r2", ref: "2", status: "cancelled" },
  { id: "r3", ref: "3", status: "pending" },
  { id: "r4", ref: "4", status: "in_progress" },
];

function armed(now = 100): ExecutionState {
  return armExecution({
    executionId: "exec-1",
    owner: "build",
    source: { kind: "plan", path: "plan.md", digest: "abc" },
    now,
  });
}

test("arm: versioned identity starts active with a clean progress budget", () => {
  const state = armed();
  assert.equal(state.version, 1);
  assert.equal(state.epoch, 1);
  assert.equal(state.phase, "active");
  assert.equal(state.shellQuarantine, undefined);
  assert.equal(state.blocker, undefined);
  assert.equal(state.progress.boundariesWithoutProgress, 0);
  assert.equal(canUseShell(state), true);
  assert.equal(needsNonShellRecovery(state), false);
});

test("fence: stale execution or epoch is refused without mutation", () => {
  const state = armed();
  const stale = applyExecutionEvent(state, {
    type: "pause",
    executionId: "exec-1",
    epoch: 99,
    reason: "stale",
    at: 200,
  });
  assert.equal(stale.ok, false);
  assert.equal((stale as any).code, "stale");

  const foreign = applyExecutionEvent(state, {
    type: "pause",
    executionId: "exec-2",
    epoch: 1,
    reason: "foreign",
    at: 200,
  });
  assert.equal(foreign.ok, false);
  assert.equal((foreign as any).code, "stale");
  assert.equal(state.phase, "active");
});

test("shell quarantine is recoverable, not paused, and idempotent", () => {
  const state = armed();
  const commandHash = shellCommandHash("npm test");
  const first = applyExecutionEvent(state, {
    type: "shell-timeout",
    executionId: state.executionId,
    epoch: state.epoch,
    rowRef: "3",
    attemptId: "attempt-1",
    reason: "second timeout",
    commandHash,
    at: 200,
  });
  assert.equal(first.ok, true);
  const quarantined = first.ok ? first.state : state;
  assert.equal(quarantined.phase, "recovering-shell");
  assert.equal(isShellQuarantined(quarantined), true);
  assert.equal(canUseShell(quarantined), false);
  assert.equal(needsNonShellRecovery(quarantined), true);
  assert.equal(quarantined.shellQuarantine?.autoResume, false);

  const again = applyExecutionEvent(quarantined, {
    type: "shell-timeout",
    executionId: quarantined.executionId,
    epoch: quarantined.epoch,
    rowRef: "3",
    attemptId: "attempt-1",
    reason: "second timeout",
    commandHash,
    at: 201,
  });
  assert.equal(again.ok, true);
  if (again.ok) {
    assert.equal(again.state.epoch, quarantined.epoch);
    assert.equal(again.state.shellQuarantine?.at, 200);
  }
});

test("user pause wins over a later shell incident and resume keeps quarantine", () => {
  const state = armed();
  const paused = applyExecutionEvent(state, {
    type: "pause",
    executionId: state.executionId,
    epoch: state.epoch,
    reason: "user paused",
    at: 200,
  });
  assert.equal(paused.ok, true);
  const pausedState = paused.ok ? paused.state : state;
  assert.equal(pausedState.phase, "paused");

  const timeout = applyExecutionEvent(pausedState, {
    type: "shell-timeout",
    executionId: pausedState.executionId,
    epoch: pausedState.epoch,
    rowRef: "3",
    attemptId: "attempt-1",
    reason: "timeout while paused",
    commandHash: shellCommandHash("npm test"),
    at: 201,
  });
  assert.equal(timeout.ok, true);
  const afterTimeout = timeout.ok ? timeout.state : pausedState;
  assert.equal(afterTimeout.phase, "paused");
  assert.equal(afterTimeout.shellQuarantine?.rowRef, "3");

  const resumed = applyExecutionEvent(afterTimeout, {
    type: "resume",
    executionId: afterTimeout.executionId,
    epoch: afterTimeout.epoch,
    at: 202,
  });
  assert.equal(resumed.ok, true);
  const afterResume = resumed.ok ? resumed.state : afterTimeout;
  assert.equal(afterResume.phase, "recovering-shell");
  assert.equal(afterResume.shellQuarantine?.rowRef, "3");
  assert.equal(afterResume.pausedReason, undefined);
  assert.equal(canUseShell(afterResume), false);
});

test("progress is ignored while paused and cannot reset a quarantine", () => {
  const state = armed();
  const paused = applyExecutionEvent(state, {
    type: "pause",
    executionId: state.executionId,
    epoch: state.epoch,
    reason: "user paused",
    at: 200,
  });
  assert.equal(paused.ok, true);
  const pausedState = paused.ok ? paused.state : state;
  const progress = applyExecutionEvent(pausedState, {
    type: "progress",
    at: 201,
    signature: "edited-file",
  });
  assert.equal(progress.ok, true);
  if (progress.ok) {
    assert.equal(progress.state.phase, "paused");
    assert.equal(progress.state.progress.lastProgressSignature, undefined);
  }
});

test("shell reset clears quarantine but keeps the epoch fence current", () => {
  const state = armed();
  const timedOut = applyExecutionEvent(state, {
    type: "shell-timeout",
    executionId: state.executionId,
    epoch: state.epoch,
    reason: "second timeout",
    commandHash: shellCommandHash("npm test"),
    at: 200,
  });
  assert.equal(timedOut.ok, true);
  if (!timedOut.ok) return;
  const reset = applyExecutionEvent(timedOut.state, {
    type: "shell-reset",
    executionId: timedOut.state.executionId,
    epoch: timedOut.state.epoch,
    at: 201,
  });
  assert.equal(reset.ok, true);
  if (!reset.ok) return;
  assert.equal(reset.state.shellQuarantine, undefined);
  assert.equal(reset.state.phase, "active");
  assert.equal(canUseShell(reset.state), true);
  const stale = applyExecutionEvent(reset.state, {
    type: "resume",
    executionId: reset.state.executionId,
    epoch: timedOut.state.epoch,
    at: 202,
  });
  assert.equal(stale.ok, false);
  assert.equal((stale as any).code, "stale");
});

test("C1 matrix: only a genuine user prompt or explicit reset clears shell", () => {
  assert.equal(shouldClearShellAttempt("user-prompt"), true);
  assert.equal(shouldClearShellAttempt("new-user-request"), true);
  assert.equal(shouldClearShellAttempt("shell-reset"), true);
  for (const event of [
    "session-start",
    "session-tree",
    "session-resume",
    "compaction",
    "agent-settled",
    "automatic-continuation",
    "mode-switch",
    "child-replacement",
    "reload",
    "fork",
  ] as const) {
    assert.equal(shouldClearShellAttempt(event), false, event);
  }
});

test("next row is one row, prefers in-progress, and skips blocked refs", () => {
  const state = armed();
  assert.equal(selectNextRow(rows, state)?.ref, "4");
  assert.equal(selectNextRow(rows, state, ["4"])?.ref, "3");
  assert.equal(selectNextRow(rows, state, ["3", "4"]), undefined);
  assert.equal(
    selectNextRow(rows, { ...state, phase: "paused" }),
    undefined,
  );
  assert.equal(
    selectNextRow(rows, { ...state, phase: "blocked" }),
    undefined,
  );
});

test("outcomes distinguish complete, exclusions, blocked, and unverified", () => {
  const state = armed();
  assert.equal(
    evaluateExecutionOutcome(state, [
      { id: "a", ref: "1", status: "completed" },
      { id: "b", ref: "2", status: "completed" },
    ]).kind,
    "complete",
  );
  assert.equal(
    evaluateExecutionOutcome(state, [
      { id: "a", ref: "1", status: "completed" },
      { id: "b", ref: "2", status: "cancelled" },
    ]).kind,
    "complete-with-exclusions",
  );
  assert.equal(
    evaluateExecutionOutcome(state, [
      { id: "a", ref: "1", status: "cancelled" },
      { id: "b", ref: "2", status: "cancelled" },
    ]).kind,
    "blocked",
  );
  assert.equal(
    evaluateExecutionOutcome(state, [
      { id: "a", ref: "1", status: "pending" },
    ]).kind,
    "active",
  );

  const timeout = applyExecutionEvent(state, {
    type: "shell-timeout",
    executionId: state.executionId,
    epoch: state.epoch,
    rowRef: "1",
    reason: "timeout",
    commandHash: shellCommandHash("npm test"),
    at: 200,
  });
  assert.equal(timeout.ok, true);
  const quarantined = timeout.ok ? timeout.state : state;
  const outcome = evaluateExecutionOutcome(quarantined, [
    { id: "a", ref: "1", status: "pending", requiredChecks: 1 },
  ]);
  assert.equal(outcome.kind, "blocked-unverified");
  assert.equal(isCleanCompletion(outcome), false);
});

test("terminal pause/stop/block outcomes are explicit", () => {
  const state = armed();
  const stopped = applyExecutionEvent(state, {
    type: "stop",
    executionId: state.executionId,
    epoch: state.epoch,
    reason: "user stop",
    at: 200,
  });
  assert.equal(stopped.ok, true);
  if (stopped.ok) {
    assert.equal(evaluateExecutionOutcome(stopped.state, rows).kind, "stopped");
    assert.equal(isCleanCompletion(evaluateExecutionOutcome(stopped.state, rows)), false);
  }

  const blocked = applyExecutionEvent(state, {
    type: "block",
    executionId: state.executionId,
    epoch: state.epoch,
    blocker: {
      category: "permission",
      rowRef: "3",
      reason: "permission denied",
      at: 200,
    },
    at: 200,
  });
  assert.equal(blocked.ok, true);
  if (blocked.ok) {
    const outcome = evaluateExecutionOutcome(blocked.state, rows);
    assert.equal(outcome.kind, "blocked");
    assert.equal(isCleanCompletion(outcome), false);
  }
});

test("command hashes use the full bytes and are stable", () => {
  assert.equal(shellCommandHash("npm test"), shellCommandHash("npm test"));
  assert.notEqual(shellCommandHash("npm test"), shellCommandHash("npm  test"));
  assert.equal(shellCommandHash("x".repeat(5_000)).length, 64);
});

test("an unsupported state version fails closed", () => {
  const state = { ...armed(), version: 99 } as unknown as ExecutionState;
  const result = applyExecutionEvent(state, { type: "progress", at: 1 });
  assert.equal(result.ok, false);
  assert.equal((result as any).code, "invalid");
});
