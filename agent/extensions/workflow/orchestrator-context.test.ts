/**
 * Parent-context tests (step 40): a bounded projection that does not grow with
 * child count, a durable pointer that keeps the active decision across
 * compaction, on-demand history paging, and parent/child TODO separation.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildParentProjection,
  buildRunPointer,
  compactionSnapshot,
  mergePointers,
  pageHistory,
  parseRunPointer,
  pointerEntry,
  restorePointer,
  scanStructuredState,
  type HistoryEntry,
  type RunPointer,
} from "./orchestrator-context.ts";
import { applyRunEvent, createRunState, type RunState } from "./orchestrator-state.ts";
import { ORCHESTRATOR_SCHEMA_VERSION, type PlannedTask } from "./orchestrator-types.ts";

function ok<T>(result: { ok: boolean }, label = "expected success"): T {
  assert.equal(result.ok, true, label);
  return result as unknown as T;
}

function tasks(count: number): PlannedTask[] {
  return Array.from({ length: count }, (_, index) => ({
    taskId: `task-t${index + 1}`,
    covers: ["step-r1"],
    objective: `Task ${index + 1}`,
    nonGoals: [],
    dependsOn: index === 0 ? [] : [`task-t${index}`],
    expectedFiles: [`src/file-${index + 1}.ts`],
    acceptanceChecks: ["tests"],
    sizeRationale: "small",
  }));
}

function planState(count = 2): RunState {
  let state = ok<{ state: RunState }>(
    createRunState({ runId: "run-1", roadmapRevision: 1, now: 1 }),
  ).state;
  state = ok<{ state: RunState }>(
    applyRunEvent(state, {
      type: "plan.apply",
      runId: "run-1",
      expectedRevision: state.revision,
      now: 2,
      plan: {
        schemaVersion: ORCHESTRATOR_SCHEMA_VERSION,
        runId: "run-1",
        roadmapRevision: 1,
        tasks: tasks(count),
      },
      requirements: [{ roadmapStepId: "step-r1", label: "1", text: "Do it" }],
    }),
  ).state;
  return state;
}

function verifyingState(): RunState {
  let state = planState();
  state = ok<{ state: RunState }>(
    applyRunEvent(state, {
      type: "task.assign",
      runId: "run-1",
      expectedRevision: state.revision,
      now: 3,
      taskId: "task-t1",
      attemptId: "attempt-a1",
      sessionId: "session-s1",
      generation: 1,
    }),
  ).state;
  state = ok<{ state: RunState }>(
    applyRunEvent(state, {
      type: "task.start",
      runId: "run-1",
      expectedRevision: state.revision,
      now: 4,
      taskId: "task-t1",
      attemptId: "attempt-a1",
      sessionId: "session-s1",
      generation: 1,
    }),
  ).state;
  state = ok<{ state: RunState }>(
    applyRunEvent(state, {
      type: "task.candidate",
      runId: "run-1",
      expectedRevision: state.revision,
      now: 5,
      taskId: "task-t1",
      attemptId: "attempt-a1",
      candidateId: "candidate-c1",
      meaningfulChange: true,
    }),
  ).state;
  return ok<{ state: RunState }>(
    applyRunEvent(state, {
      type: "task.verify",
      runId: "run-1",
      expectedRevision: state.revision,
      now: 6,
      taskId: "task-t1",
    }),
  ).state;
}

test("the pointer names the active decision for every phase", () => {
  const verifying = verifyingState();
  const pointer = buildRunPointer(verifying, 10);
  assert.equal(pointer.pendingDecision, "accept");
  assert.equal(pointer.activeTaskId, "task-t1");
  assert.match(pointer.nextAction, /acceptance or send a scoped repair/);

  const candidate = buildRunPointer(
    { ...verifying, tasks: { ...verifying.tasks, "task-t1": { ...verifying.tasks["task-t1"]!, state: "candidate" } } },
    10,
  );
  assert.equal(candidate.pendingDecision, "verify");

  const needsFix = buildRunPointer(
    { ...verifying, tasks: { ...verifying.tasks, "task-t1": { ...verifying.tasks["task-t1"]!, state: "needs_fix" } } },
    10,
  );
  assert.equal(needsFix.pendingDecision, "repair");

  const paused = buildRunPointer({ ...verifying, phase: "paused" }, 10);
  assert.equal(paused.pendingDecision, "resume");

  const accepted = planState();
  const allAccepted = {
    ...accepted,
    tasks: Object.fromEntries(
      Object.entries(accepted.tasks).map(([id, task]) => [id, { ...task, state: "accepted" as const }]),
    ),
  };
  assert.equal(buildRunPointer(allAccepted, 10).pendingDecision, "next_task");
});

test("the projection stays bounded as the task list grows", () => {
  const small = buildParentProjection({ state: planState(2), now: 10 });
  const large = buildParentProjection({ state: planState(50), now: 10 });
  const huge = buildParentProjection({ state: planState(200), now: 10 });
  assert.equal(large.tasks.length <= 12, true);
  assert.equal(large.omittedTasks, 38);
  assert.equal(large.truncated, true);
  assert.ok(large.tokens <= 1_200, `tokens ${large.tokens} should stay within the budget`);
  assert.ok(huge.tokens <= 1_200, "a 200-task run keeps the same constant-size context");
  assert.ok(
    huge.tokens <= large.tokens + 5,
    "the parent context must not grow linearly with child count",
  );
  assert.ok(small.tokens <= 1_200);
  assert.match(large.text, /50 tasks accepted|0\/50 tasks accepted/);
  assert.equal(JSON.stringify(large).includes("transcript"), false);
});

test("the projection carries the active task and dependency summary", () => {
  const state = verifyingState();
  const projection = buildParentProjection({ state, now: 10, maxTasks: 4 });
  assert.equal(projection.pointer.activeTaskId, "task-t1");
  assert.equal(projection.tasks[0]!.taskId, "task-t1");
  assert.deepEqual(projection.dependencies, [{ taskId: "task-t2", dependsOn: ["task-t1"] }]);
  assert.match(projection.text, /Pending decision: accept/);
  assert.match(projection.text, /task-t1 verifying/);
});

test("history pages are bounded and text is truncated explicitly", () => {
  const entries: HistoryEntry[] = Array.from({ length: 120 }, (_, index) => ({
    id: `entry-${index}`,
    kind: index % 2 === 0 ? "decision" : "note",
    at: index,
    text: index === 0 ? "x".repeat(5_000) : `entry ${index}`,
  }));
  const first = pageHistory({ entries, pageSize: 10 });
  assert.equal(first.items.length, 10);
  assert.equal(first.nextOffset, 10);
  assert.equal(first.truncatedText, true);
  assert.equal(first.items[0]!.text.length <= 2_000, true);

  const last = pageHistory({ entries, offset: 115, pageSize: 100 });
  assert.equal(last.items.length, 5);
  assert.equal(last.nextOffset, undefined);
  assert.equal(pageHistory({ entries, pageSize: 999 }).items.length <= 50, true);
});

test("pointer parsing fails closed and child pointers are ignored", () => {
  const pointer = buildRunPointer(planState(), 10);
  const parsed = parseRunPointer(pointer);
  assert.equal(parsed.ok, true);
  assert.equal((parsed as any).pointer.pendingDecision, "dispatch");

  assert.equal(parseRunPointer({ ...pointer, schemaVersion: 99 }).ok, false);
  assert.equal(parseRunPointer({ ...pointer, owner: "child" }).ok, false);
  assert.equal(parseRunPointer({ ...pointer, pendingDecision: "auto_accept" }).ok, false);

  const scanned = scanStructuredState([
    pointerEntry(pointer),
    { type: "custom", customType: "workflow-run-pointer", data: { ...pointer, owner: "child" } },
  ]);
  assert.equal(scanned.pointers.length, 1);
  assert.equal(scanned.ignored, 1);
});

test("structured scanning separates parent and child TODO projections", () => {
  const scanned = scanStructuredState([
    pointerEntry(buildRunPointer(planState(), 10)),
    {
      type: "custom",
      customType: "workflow-todo-projection",
      data: { owner: "parent", items: [{ step: 1, text: "roadmap" }] },
    },
    {
      type: "custom",
      customType: "workflow-todo-projection",
      data: { owner: "child", items: [{ step: 1, text: "local" }, { step: 2, text: "local2" }] },
    },
    { type: "custom", customType: "workflow-todo-projection", data: { owner: "worker", items: [] } },
  ]);
  assert.equal(scanned.parentTodos.length, 1);
  assert.equal(scanned.childTodos.length, 1);
  assert.equal(scanned.parentTodos[0]!.itemCount, 1);
  assert.equal(scanned.childTodos[0]!.itemCount, 2);
  assert.equal(scanned.ignored, 1);

  const snapshot = compactionSnapshot([
    pointerEntry(buildRunPointer(verifyingState(), 10)),
    { type: "custom", customType: "workflow-todo-projection", data: { owner: "child", items: [{ step: 1 }] } },
  ]);
  assert.equal(snapshot.pointer?.pendingDecision, "accept");
  assert.equal(snapshot.parentTodos.length, 0);
  assert.equal(snapshot.childTodosSeparate.length, 1);
});

test("merge/restore keeps the newest revision and never drops a pending decision", () => {
  const older = buildRunPointer(planState(), 10);
  const newer: RunPointer = { ...older, revision: older.revision + 1, pendingDecision: "verify", nextAction: "inspect" };
  assert.equal(mergePointers(older, newer).pointer.revision, newer.revision);
  assert.equal(mergePointers(newer, older).ignored, true);

  const rebuilt: RunPointer = { ...older, revision: older.revision + 1, pendingDecision: "none" };
  const restored = restorePointer({ persisted: newer, rebuilt });
  assert.equal(restored?.pendingDecision, "verify", "compaction must not lose the active decision");
  assert.equal(restorePointer({ persisted: older }), older);
  assert.equal(restorePointer({ rebuilt: older }), older);
});
