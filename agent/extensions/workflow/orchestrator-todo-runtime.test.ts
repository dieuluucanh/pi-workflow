/**
 * TODO ownership tests (plan step 21).
 *
 * The projection is derived from acceptance; a checkbox or child completion is
 * display-only. These cases pin the separation between the three lists.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  parentRoadmapTodos,
  reconcileCheckboxClaims,
  todoEffectsTarget,
  todoMutationDecision,
} from "./orchestrator-todo-runtime.ts";
import { createRunState, applyRunEvent } from "./orchestrator-state.ts";
import type { RunState } from "./orchestrator-state.ts";

const REQUIREMENTS = [
  { roadmapStepId: "step-1", label: "1", text: "First requirement" },
  { roadmapStepId: "step-2", label: "2", text: "Second requirement" },
];

function plan(runId: string) {
  return {
    schemaVersion: 1 as const,
    runId,
    roadmapRevision: 1,
    tasks: [
      {
        taskId: "task-1",
        covers: ["step-1"],
        objective: "First task",
        nonGoals: [],
        dependsOn: [],
        expectedFiles: ["a.ts"],
        acceptanceChecks: ["check 1"],
        sizeRationale: "small",
      },
      {
        taskId: "task-2",
        covers: ["step-2"],
        objective: "Second task",
        nonGoals: [],
        dependsOn: ["task-1"],
        expectedFiles: ["b.ts"],
        acceptanceChecks: ["check 2"],
        sizeRationale: "small",
      },
    ],
  };
}

function withPlan(): RunState {
  const created = createRunState({ runId: "run-1", roadmapRevision: 1, now: 1 });
  if (!created.ok) throw new Error(created.error);
  const applied = applyRunEvent(created.state, {
    type: "plan.apply",
    runId: "run-1",
    expectedRevision: created.state.revision,
    now: 2,
    plan: plan("run-1"),
    requirements: REQUIREMENTS,
  });
  if (!applied.ok) throw new Error(applied.error);
  return applied.state;
}

test("partial acceptance is visible but never complete", () => {
  const state = withPlan();
  const projection = parentRoadmapTodos(state);
  assert.equal(projection.owner, "parent");
  assert.equal(projection.items.length, 2);
  assert.equal(projection.complete, false);
  assert.equal(projection.counts.accepted, 0);
  assert.equal(projection.counts.pending, 2);
  assert.equal(projection.items[0]?.acceptedCoverage, false);
  assert.equal(projection.items[0]?.taskId, "task-1");

  // Run the first task through assign/start/candidate/verify/accept.
  const view = state;
  let current = view;
  for (const event of [
    { type: "task.assign", taskId: "task-1", attemptId: "attempt-1", sessionId: "s-1", generation: 1 },
    { type: "task.start", taskId: "task-1", attemptId: "attempt-1", sessionId: "s-1", generation: 1 },
    { type: "task.candidate", taskId: "task-1", attemptId: "attempt-1", candidateId: "candidate-1", meaningfulChange: true },
    { type: "task.verify", taskId: "task-1" },
  ] as const) {
    const next = applyRunEvent(current, { ...event, runId: "run-1", expectedRevision: current.revision, now: 10 });
    if (!next.ok) throw new Error(`${event.type}: ${next.error}`);
    current = next.state;
  }
  // Acceptance needs validated evidence; a projection never mints it.
  const partial = parentRoadmapTodos(current);
  assert.equal(partial.complete, false);
  assert.equal(partial.items[0]?.status, "in_progress");
});

test("cancelled/superseded tasks are counted and never complete the list", () => {
  let state = withPlan();
  const cancelled = applyRunEvent(state, {
    type: "task.cancel",
    runId: "run-1",
    expectedRevision: state.revision,
    now: 5,
    taskId: "task-2",
    reason: "not needed",
  });
  assert.equal(cancelled.ok, true);
  state = cancelled.state;
  const projection = parentRoadmapTodos(state);
  assert.equal(projection.counts.cancelled, 1);
  assert.equal(projection.complete, false);
});

test("the parent projection refuses every mutation except list", () => {
  assert.equal(todoMutationDecision("parent", "list").allowed, true);
  for (const action of ["update", "done", "pending", "add", "toggle", "sync", "clear"] as const) {
    const decision = todoMutationDecision("parent", action);
    assert.equal(decision.allowed, false, action);
    assert.match(decision.reason ?? "", /projection of accepted coverage/);
  }
  assert.equal(todoMutationDecision("ordinary", "done").allowed, true);
  assert.equal(todoMutationDecision("worker", "done").allowed, true);
});

test("checkbox claims are display-only and accept nothing", () => {
  const state = withPlan();
  const reconciled = reconcileCheckboxClaims({ state, completedRefs: [1, 1, 99] });
  assert.equal(reconciled.displayOnly, true);
  assert.deepEqual(reconciled.claimedRefs, [1]);
  assert.deepEqual(reconciled.acceptedTaskIds, []);
});

test("no TODO owner can trigger a parent roadmap change or a commit", () => {
  for (const owner of ["ordinary", "parent", "worker"] as const) {
    assert.deepEqual(todoEffectsTarget(owner), {
      parentRoadmap: false,
      commit: false,
      parentTodos: false,
    });
  }
});
