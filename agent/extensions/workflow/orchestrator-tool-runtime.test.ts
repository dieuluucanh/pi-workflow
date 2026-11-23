/**
 * Parent dispatch/retry behavior (launch evidence, honest failure, recovery).
 */

import assert from "node:assert/strict";
import test from "node:test";

import { createParentToolRuntime, type ParentToolPorts } from "./orchestrator-tool-runtime.ts";
import {
  applyRunEvent,
  createRunState,
  type RunState,
  type RunEvent,
} from "./orchestrator-state.ts";
import { createFrozenTodosFromSteps } from "./todo-snapshot.ts";
import type { OrchestratorRuntime, RuntimeView } from "./orchestrator-runtime.ts";
import type { JournalEvent, JournalEventType } from "./orchestrator-store.ts";

function frozen() {
  const built = createFrozenTodosFromSteps({
    title: "dispatch",
    steps: ["first", "second"],
    mode: "orchestrator",
    now: 1,
  });
  assert.equal(built.ok, true);
  if (!built.ok) throw new Error((built as { error: string }).error);
  return built.snapshot;
}

function fakeRuntime(initial?: RunState) {
  const created = createRunState({ runId: "run-1", todos: frozen(), now: 1_000 });
  assert.equal(created.ok, true);
  if (!created.ok) throw new Error((created as { error: string }).error);
  let state = initial ?? created.state;
  const events: string[] = [];
  const applyEvent = async (event: Parameters<OrchestratorRuntime["applyEvent"]>[0]) => {
    const result = applyRunEvent(state, {
      ...(event as RunEvent),
      expectedRevision: state.revision,
    } as RunEvent);
    if (!result.ok) return { ok: false, code: "state" as const, error: result.error };
    state = result.state;
    events.push(event.type);
    return { ok: true as const, value: { revision: state.revision, view: view() } };
  };
  const view = (): RuntimeView => ({
    runId: state.runId,
    phase: state.phase,
    todos: state.todos,
    ...(state.plan === undefined ? {} : { plan: state.plan }),
    ...(state.order.find((id) => state.tasks[id]?.state === "pending") === undefined
      ? {}
      : { nextTaskId: state.order.find((id) => state.tasks[id]?.state === "pending") }),
    state,
  });
  const runtime = {
    view,
    applyEvent,
    appendJournal: async (type: JournalEventType) => {
      events.push(type);
      return { ok: true as const, value: undefined };
    },
    journalEvents: async () =>
      ({
        ok: true as const,
        value: [] as JournalEvent[],
      }),
    restore: async () => ({ ok: true as const, value: view() }),
    startFromPlan: async () => ({ ok: false as const, code: "state" as const, error: "unused" }),
    startFromSteps: async () => ({ ok: false as const, code: "state" as const, error: "unused" }),
    restoreFromPlan: async () => ({ ok: false as const, code: "state" as const, error: "unused" }),
    cancel: async () => ({ ok: true as const, value: { view: view() } }),
    complete: async () => ({ ok: true as const, value: { view: view() } }),
  } as unknown as OrchestratorRuntime;
  return { runtime, events, getState: () => state };
}

function ports(options: {
  // A fresh generation per dispatch, like the workspace lease allocator.
  // (The counter lives per harness; two harnesses both start at 1.)
  runtime: OrchestratorRuntime;
  wake: () => Promise<{ ok: true; acknowledged: boolean; handle?: string } | { ok: false; error: string; uncertain?: boolean }>;
  probeStale?: (taskId: string) => Promise<{ stale: boolean; reason: string }>;
}): ParentToolPorts {
  return {
    runtime: () => options.runtime,
    epoch: () => 1,
    dispatcher: {
      prepare: async (input: {
        runId: string;
        taskId: string;
        attemptId: string;
        generation: number;
      }) => ({
        ok: true as const,
        child: {
          sessionRef: `session-${input.taskId}`,
          taskStartId: "start-1",
          sessionFile: "/tmp/child.jsonl",
        },
      }),
      wake: options.wake,
    },
    allocateGeneration: (() => {
      let generation = 1;
      return () => {
        generation += 1;
        return generation;
      };
    })(),
    now: () => 2_000,
    ...(options.probeStale === undefined ? {} : { probeStale: options.probeStale }),
  } as unknown as ParentToolPorts;
}

test("dispatch journals start, launch evidence, and only then reports success", async () => {
  const fake = fakeRuntime();
  const tools = createParentToolRuntime(
    ports({ runtime: fake.runtime, wake: async () => ({ ok: true, acknowledged: true }) }),
  );
  const outcome = await tools.dispatch("task-1");
  assert.equal(outcome.ok, true);
  assert.match(outcome.text, /Dispatched/);
  assert.deepEqual(fake.events, ["task.start", "task.start.intent", "task.launched"]);
  assert.equal(fake.getState().tasks["task-1"]!.state, "running");
});

test("a launch failure blocks the row and never says Dispatched", async () => {
  const fake = fakeRuntime();
  const tools = createParentToolRuntime(
    ports({
      runtime: fake.runtime,
      wake: async () => ({ ok: false, error: "wt.exe is missing" }),
    }),
  );
  const outcome = await tools.dispatch("task-1");
  assert.equal(outcome.ok, false);
  assert.equal((outcome as { code: string }).code, "launch");
  assert.doesNotMatch(outcome.text, /Dispatched/);
  assert.match(outcome.text, /blocked/);
  assert.equal(fake.getState().tasks["task-1"]!.state, "blocked");
  assert.equal(fake.getState().phase, "blocked");
});

test("an unacknowledged delivery stays running and reports uncertainty", async () => {
  const fake = fakeRuntime();
  const tools = createParentToolRuntime(
    ports({
      runtime: fake.runtime,
      wake: async () => ({
        ok: false,
        error: "no ack within 45s",
        uncertain: true,
      }),
    }),
  );
  const outcome = await tools.dispatch("task-1");
  assert.equal(outcome.ok, false);
  assert.equal((outcome as { code: string }).code, "uncertain");
  assert.equal(fake.getState().tasks["task-1"]!.state, "running");
  assert.ok(fake.events.includes("run.control"));
});

test("retry re-dispatches a blocked row immediately", async () => {
  const fake = fakeRuntime();
  const blocked = applyRunEvent(fake.getState(), {
    type: "task.block",
    runId: "run-1",
    expectedRevision: fake.getState().revision,
    now: 1_100,
    taskId: "task-1",
    reason: "host unavailable",
  });
  assert.equal(blocked.ok, true);
  if (!blocked.ok) return;
  const next = fakeRuntime(blocked.state);
  const tools = createParentToolRuntime(
    ports({ runtime: next.runtime, wake: async () => ({ ok: true, acknowledged: true }) }),
  );
  const outcome = await tools.call("orchestrator_retry", {});
  assert.equal(outcome.ok, true);
  assert.match(outcome.text, /retried/i);
  assert.equal(next.getState().tasks["task-1"]!.state, "running");
});

test("retry abandons a never-launched running row only after a stale probe", async () => {
  const fake = fakeRuntime();
  const started = applyRunEvent(fake.getState(), {
    type: "task.start",
    runId: "run-1",
    expectedRevision: fake.getState().revision,
    now: 1_100,
    taskId: "task-1",
    attemptId: "task-1-attempt-1",
    sessionId: "session-1",
  });
  assert.equal(started.ok, true);
  if (!started.ok) return;
  const next = fakeRuntime(started.state);
  const tools = createParentToolRuntime(
    ports({
      runtime: next.runtime,
      wake: async () => ({ ok: true, acknowledged: true }),
      probeStale: async () => ({ stale: true, reason: "no launch record" }),
    }),
  );
  const outcome = await tools.call("orchestrator_retry", {});
  assert.equal(outcome.ok, true);
  assert.equal(next.getState().tasks["task-1"]!.state, "running");
  // The new start carries a new attempt id.
  assert.notEqual(next.getState().tasks["task-1"]!.attemptId, "task-1-attempt-1");
});

test("retry refuses a running row that may still have a child", async () => {
  const fake = fakeRuntime();
  const started = applyRunEvent(fake.getState(), {
    type: "task.start",
    runId: "run-1",
    expectedRevision: fake.getState().revision,
    now: 1_100,
    taskId: "task-1",
    attemptId: "task-1-attempt-1",
    sessionId: "session-1",
  });
  assert.equal(started.ok, true);
  if (!started.ok) return;
  const next = fakeRuntime(started.state);
  const tools = createParentToolRuntime(
    ports({
      runtime: next.runtime,
      wake: async () => ({ ok: true, acknowledged: true }),
      probeStale: async () => ({ stale: false, reason: "the child session already started a turn" }),
    }),
  );
  const outcome = await tools.call("orchestrator_retry", {});
  assert.equal(outcome.ok, false);
  assert.match(outcome.text, /already started a turn/);
  assert.equal(next.getState().tasks["task-1"]!.state, "running");
});
