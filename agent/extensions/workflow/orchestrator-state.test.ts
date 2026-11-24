/**
 * Frozen-run state machine tests (Orchestrator simplification, steps 7-9/20).
 *
 * A task is exactly one frozen TODO row: no dependency graph, no coverage map,
 * no attempt history. These tests pin the state transitions that remain and the
 * failure behavior a dispatch/verify failure depends on.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_REPAIR_ROUNDS,
  applyRunEvent,
  createRunState,
  nextPendingTask,
  reconcileRunStateWithFrozenStatus,
  rowForTask,
  taskCounts,
  taskIdForRef,
  type RunState,
} from "./orchestrator-state.ts";
import { createFrozenTodosFromSteps, createFrozenTodosFromPlan } from "./todo-snapshot.ts";

function frozen(count = 3) {
  const built = createFrozenTodosFromSteps({
    title: "Frozen tests",
    steps: Array.from({ length: count }, (_, index) => `step ${index + 1}: do the thing`),
    mode: "orchestrator",
    now: 1,
  });
  assert.equal(built.ok, true);
  if (!built.ok) throw new Error((built as { error: string }).error);
  return built.snapshot;
}

function created(count = 3): RunState {
  const result = createRunState({ runId: "run-1", todos: frozen(count), now: 1_000 });
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error((result as { error: string }).error);
  return result.state;
}

function apply(state: RunState, event: Record<string, unknown>): RunState {
  const result = applyRunEvent(state, { runId: state.runId, expectedRevision: state.revision, ...event } as never);
  assert.equal(result.ok, true, result.ok ? "" : result.error);
  return (result as { ok: true; state: RunState }).state;
}

test("create: one task per frozen row, stable refs and order", () => {
  const state = created(4);
  assert.equal(state.phase, "ready");
  assert.equal(state.order.length, 4);
  assert.deepEqual(state.order, ["task-1", "task-2", "task-3", "task-4"]);
  assert.equal(state.todos.rows[2]!.ref, "3");
  assert.equal(nextPendingTask(state), "task-1");
  assert.equal(taskCounts(state).pending, 4);
  assert.deepEqual(rowForTask(state, "task-2")?.text, "step 2: do the thing");
});

test("create: an empty or corrupt snapshot fails closed", () => {
  const empty = createRunState({
    runId: "run-1",
    todos: { ...frozen(1), rows: [] },
    now: 1,
  });
  assert.equal(empty.ok, false);
});

test("a frozen row status is reconciled instead of resurrected as pending", () => {
  const snapshot = frozen(4);
  const statuses = ["completed", "cancelled", "in_progress", "pending"] as const;
  const rows = snapshot.rows.map((row, index) => ({ ...row, status: statuses[index]! }));
  const todos = { ...snapshot, rows };

  const seeded = createRunState({ runId: "run-status", todos, now: 10 });
  assert.equal(seeded.ok, true);
  if (!seeded.ok) return;
  assert.equal(seeded.state.tasks["task-1"]!.state, "accepted");
  assert.equal(seeded.state.tasks["task-1"]!.acceptedAt, 10);
  assert.equal(seeded.state.tasks["task-2"]!.state, "blocked");
  assert.match(seeded.state.tasks["task-2"]!.blockedReason ?? "", /cancelled/);
  // A reload has no live child: an in_progress row is recoverable work, not a
  // running task, and a pending row stays pending.
  assert.equal(seeded.state.tasks["task-3"]!.state, "pending");
  assert.equal(seeded.state.tasks["task-4"]!.state, "pending");
  assert.equal(nextPendingTask(seeded.state), "task-3");

  // Journal replay starts all-pending (so historical events replay) and
  // reconciles once afterwards. An event that already moved a row wins.
  const baseline = createRunState({
    runId: "run-status",
    todos,
    now: 10,
    honorRowStatus: false,
  });
  assert.equal(baseline.ok, true);
  if (!baseline.ok) return;
  assert.equal(baseline.state.tasks["task-1"]!.state, "pending");
  const retried = {
    ...baseline.state,
    tasks: {
      ...baseline.state.tasks,
      "task-2": { ...baseline.state.tasks["task-2"]!, state: "needs_fix" as const },
    },
  };
  const reconciled = reconcileRunStateWithFrozenStatus(retried, 20);
  assert.equal(reconciled.tasks["task-1"]!.state, "accepted");
  assert.equal(reconciled.tasks["task-2"]!.state, "needs_fix");
  assert.equal(reconciled.tasks["task-3"]!.state, "pending");
  assert.equal(reconciled.updatedAt, 20);
});

test("happy path: start → report → verify → accept", () => {
  let state = created(1);
  state = apply(state, { type: "task.start", now: 2, taskId: "task-1", attemptId: "a1", sessionId: "s-1" });
  assert.equal(state.phase, "running");
  state = apply(state, { type: "task.report", now: 3, taskId: "task-1", reportId: "report-1" });
  assert.equal(state.tasks["task-1"]!.state, "candidate");
  state = apply(state, { type: "task.verify", now: 4, taskId: "task-1" });
  state = apply(state, {
    type: "task.accept",
    now: 5,
    taskId: "task-1",
    evidenceId: "evidence-1",
    workspaceRevision: "abc",
  });
  assert.equal(state.tasks["task-1"]!.state, "accepted");
  assert.equal(state.tasks["task-1"]!.acceptedAt, 5);
  state = apply(state, { type: "run.transition", now: 6, to: "completed" });
  assert.equal(state.phase, "completed");
});

test("completed requires every row accepted", () => {
  const state = created(2);
  const result = applyRunEvent(state, {
    type: "run.transition",
    runId: state.runId,
    expectedRevision: state.revision,
    now: 2,
    to: "completed",
  });
  assert.equal(result.ok, false);
  assert.match((result as { error: string }).error, /every row accepted/);
});

test("one child at a time: a second running row is refused", () => {
  let state = created(2);
  state = apply(state, { type: "task.start", now: 2, taskId: "task-1", attemptId: "a1", sessionId: "s-1" });
  const result = applyRunEvent(state, {
    type: "task.start",
    runId: state.runId,
    expectedRevision: state.revision,
    now: 3,
    taskId: "task-2",
    attemptId: "a2",
    sessionId: "s-2",
  });
  assert.equal(result.ok, false);
  assert.match((result as { error: string }).error, /already running/);
});

test("repair is hard-capped; the last round blocks instead of retrying", () => {
  let state = created(1);
  state = apply(state, { type: "task.start", now: 2, taskId: "task-1", attemptId: "a1", sessionId: "s-1" });
  state = apply(state, { type: "task.report", now: 3, taskId: "task-1", reportId: "r1" });
  for (let round = 1; round <= MAX_REPAIR_ROUNDS; round += 1) {
    state = apply(state, { type: "task.needsFix", now: 4 + round, taskId: "task-1", reason: `round ${round}` });
    assert.equal(state.tasks["task-1"]!.repairRounds, round);
    assert.equal(state.tasks["task-1"]!.state, "needs_fix");
    state = apply(state, { type: "task.start", now: 5 + round, taskId: "task-1", attemptId: `a-${round + 1}`, sessionId: "s-1" });
    state = apply(state, { type: "task.report", now: 6 + round, taskId: "task-1", reportId: `r-${round}` });
  }
  state = apply(state, { type: "task.needsFix", now: 20, taskId: "task-1", reason: "still failing" });
  assert.equal(state.tasks["task-1"]!.state, "blocked");
  assert.equal(state.phase, "blocked");
  assert.match(state.tasks["task-1"]!.blockedReason ?? "", /repair/i);
});

test("retry returns a blocked row to pending and clears the block", () => {
  let state = created(1);
  state = apply(state, { type: "task.block", now: 2, taskId: "task-1", reason: "host unavailable" });
  assert.equal(state.phase, "blocked");
  state = apply(state, { type: "task.retry", now: 3, taskId: "task-1" });
  assert.equal(state.phase, "ready");
  assert.equal(state.tasks["task-1"]!.state, "pending");
  assert.equal(state.blockedReason, undefined);
});

test("stale revision and foreign run are refused without mutation", () => {
  const state = created(1);
  const stale = applyRunEvent(state, {
    type: "task.start",
    runId: state.runId,
    expectedRevision: state.revision + 5,
    now: 2,
    taskId: "task-1",
    attemptId: "a1",
    sessionId: "s-1",
  });
  assert.equal(stale.ok, false);
  assert.equal((stale as { code: string }).code, "stale_revision");

  const foreign = applyRunEvent(state, {
    type: "task.start",
    runId: "run-other",
    expectedRevision: state.revision,
    now: 2,
    taskId: "task-1",
    attemptId: "a1",
    sessionId: "s-1",
  });
  assert.equal(foreign.ok, false);
  assert.equal(state.tasks["task-1"]!.state, "pending");
});

test("plan rows keep their source order and ids through a status update", () => {
  const plan = [
    "# Plan: Demo",
    "",
    "## Plan Steps",
    "",
    "1. First step",
    "2. Second step",
    "3. Third step",
    "",
    "## Verification",
    "",
    "```bash",
    "node --test x.test.ts",
    "```",
  ].join("\n");
  const built = createFrozenTodosFromPlan({ planPath: "/tmp/plan.md", planText: plan, mode: "orchestrator", now: 1 });
  assert.equal(built.ok, true);
  if (!built.ok) return;
  const before = built.snapshot.rows.map((row) => `${row.id}|${row.ref}|${row.text}`);
  const createdFromPlan = createRunState({
    runId: "run-plan",
    todos: built.snapshot,
    now: 1_000,
  });
  assert.equal(createdFromPlan.ok, true);
  if (!createdFromPlan.ok) return;
  const state = apply(createdFromPlan.state, { type: "task.start", now: 2, taskId: taskIdForRef("1"), attemptId: "a1", sessionId: "s-1" });
  const after = state.todos.rows.map((row) => `${row.id}|${row.ref}|${row.text}`);
  assert.deepEqual(after, before);
});

test("a running row can be blocked for an abandoned launch and retried", () => {
  let state = created(1);
  state = apply(state, {
    type: "task.start",
    now: 2,
    taskId: "task-1",
    attemptId: "a1",
    sessionId: "s-1",
  });
  assert.equal(state.tasks["task-1"]!.state, "running");
  state = apply(state, {
    type: "task.block",
    now: 3,
    taskId: "task-1",
    reason: "launch never observed",
  });
  assert.equal(state.phase, "blocked");
  assert.match(state.tasks["task-1"]!.blockedReason ?? "", /launch never observed/);
  state = apply(state, { type: "task.retry", now: 4, taskId: "task-1" });
  assert.equal(state.phase, "ready");
  assert.equal(state.tasks["task-1"]!.state, "pending");
  assert.equal(state.blockedReason, undefined);
});
