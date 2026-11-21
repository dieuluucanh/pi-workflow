/**
 * Worker-local TODO tests (step 28): task-local scope, no roadmap import,
 * completion isolation from parent roadmap/commits, out-of-scope escalation and
 * interaction rechecks.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  applyWorkerDoneTags,
  buildWorkerTodos,
  completeWorkerTodo,
  detectOutOfScopeChanges,
  recordWorkerInteraction,
  syncWorkerTodos,
  type WorkerAssignmentScope,
} from "./orchestrator-worker-todos.ts";

const assignment: WorkerAssignmentScope = {
  taskId: "task-1",
  covers: ["rm-1", "rm-2"],
  objective: "Implement the approved task",
  acceptanceChecks: ["unit tests pass", "no new warnings"],
  expectedFiles: ["src/feature.ts", "tests/feature.test.ts"],
  mutationScope: ["src/feature/**"],
  roadmap: { path: "C:/docs/roadmap.md", digest: "ROADMAPDIGEST", revision: 1 },
};

const LOCAL_PLAN = `# Task plan

## Plan Steps

1. Read the existing feature
2. Implement the change
3. Add tests
`;

test("a child list is owned by the worker and keeps the roadmap as a reference", () => {
  const result = buildWorkerTodos({ assignment, now: 1 });
  assert.equal(result.ok, true, result.ok ? "" : result.error);
  const list = (result as any).value;
  assert.equal(list.owner, "worker");
  assert.deepEqual(
    list.items.map((item: any) => item.text),
    ["unit tests pass", "no new warnings"],
  );
  assert.deepEqual(list.roadmap, assignment.roadmap);
  assert.equal(JSON.stringify(list.items).includes("ROADMAPDIGEST"), false);
});

test("the roadmap itself cannot be synced as local work", () => {
  const result = buildWorkerTodos({
    assignment,
    planText: `# Roadmap\n\ndigest: ${assignment.roadmap.digest}\n\n## Plan Steps\n\n1. Do everything`,
    now: 1,
  });
  assert.equal(result.ok, false);
  assert.equal((result as any).code, "roadmap_import");
});

test("a task-local plan becomes local steps and sync preserves completions", () => {
  const built = buildWorkerTodos({ assignment, planText: LOCAL_PLAN, now: 1 });
  assert.equal(built.ok, true);
  let list = (built as any).value;
  assert.deepEqual(
    list.items.map((item: any) => item.text),
    ["Read the existing feature", "Implement the change", "Add tests"],
  );
  const completed = completeWorkerTodo({ list, ref: 2, origin: "todo", now: 2 });
  assert.equal((completed as any).value.effects.parentRoadmapChanged, false);
  list = (completed as any).value.list;

  const synced = syncWorkerTodos({ list, assignment, planText: LOCAL_PLAN, now: 3 });
  assert.equal(synced.ok, true);
  assert.equal((synced as any).value.importedRoadmap, false);
  assert.equal((synced as any).value.list.items[1].completed, true);
  assert.equal((synced as any).value.list.roadmap.digest, assignment.roadmap.digest);

  const otherTask = syncWorkerTodos({
    list,
    assignment: { ...assignment, taskId: "task-2" },
    now: 4,
  });
  assert.equal((otherTask as any).code, "mismatch");
});

test("[DONE:n] tags are local refs; parent roadmap and commits are untouched", () => {
  const built = buildWorkerTodos({ assignment, planText: LOCAL_PLAN, now: 1 });
  const list = (built as any).value;
  const tagged = applyWorkerDoneTags({ list, message: "Done [DONE:2]", now: 2 });
  assert.equal((tagged as any).value.effects.commitTriggered, false);
  assert.equal((tagged as any).value.effects.parentTodosChanged, false);
  assert.equal((tagged as any).value.effects.parentRoadmapChanged, false);
  assert.deepEqual(
    (tagged as any).value.list.items.map((item: any) => item.completed),
    [false, true, false],
  );
  const unknown = applyWorkerDoneTags({ list, message: "[DONE:99]", now: 3 });
  assert.deepEqual(
    (unknown as any).value.list.items.map((item: any) => item.completed),
    [false, false, false],
  );
});

test("changes outside the assignment are escalated, never silently accepted", () => {
  const inside = detectOutOfScopeChanges({
    assignment,
    changedPaths: ["src/feature.ts", "src/feature/sub.ts"],
  });
  assert.equal(inside.requiresEscalation, false);

  const outside = detectOutOfScopeChanges({
    assignment,
    changedPaths: ["src/feature.ts", "src/unrelated.ts"],
  });
  assert.equal(outside.requiresEscalation, true);
  assert.deepEqual(outside.outOfScope, ["src/unrelated.ts"]);
  assert.match(outside.reason ?? "", /outside the assignment scope/);

  const undeclared = detectOutOfScopeChanges({
    assignment: { ...assignment, expectedFiles: [], mutationScope: [] },
    changedPaths: ["src/feature.ts"],
  });
  assert.equal(undeclared.requiresEscalation, true);
});

test("steering and model changes produce rechecks, never auto-acceptance", () => {
  assert.deepEqual(recordWorkerInteraction({ kind: "user-question" }), {
    requiresBudgetRecheck: false,
    requiresParityRecheck: false,
    requiresParentDecision: false,
    autoAccepted: false,
  });
  const steer = recordWorkerInteraction({ kind: "steer", note: "use the other helper" });
  assert.equal(steer.requiresBudgetRecheck, true);
  assert.equal(steer.autoAccepted, false);
  const model = recordWorkerInteraction({ kind: "model-change" });
  assert.equal(model.requiresParityRecheck, true);
  assert.equal(model.requiresParentDecision, true);
  assert.equal(model.autoAccepted, false);
});
