/**
 * Parent tool adapter behavior.
 *
 * The surface is start/status/retry. Acceptance is automatic, so these tests
 * pin: start delegates, status is read-only, retry re-queues the exact row and
 * dispatches it through the in-process child dispatcher, and a dispatch failure
 * is reported honestly.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  createParentToolRuntime,
  type ParentToolPorts,
} from "./orchestrator-tool-runtime.ts";
import {
  applyRunEvent,
  createRunState,
  type RunEvent,
  type RunState,
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
  const applyEvent = async (
    event: Parameters<OrchestratorRuntime["applyEvent"]>[0],
  ) => {
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
      : {
          nextTaskId: state.order.find(
            (id) => state.tasks[id]?.state === "pending",
          ),
        }),
    state,
  });
  const runtime = {
    view,
    applyEvent,
    appendJournal: async (type: JournalEventType) => {
      events.push(type);
      return { ok: true as const, value: undefined };
    },
    journalEvents: async () => ({
      ok: true as const,
      value: [] as JournalEvent[],
    }),
    restore: async () => ({ ok: true as const, value: view() }),
    startFromPlan: async () => ({
      ok: false as const,
      code: "state" as const,
      error: "unused",
    }),
    startFromSteps: async () => ({
      ok: false as const,
      code: "state" as const,
      error: "unused",
    }),
    restoreFromPlan: async () => ({
      ok: false as const,
      code: "state" as const,
      error: "unused",
    }),
    cancel: async () => ({ ok: true as const, value: { view: view() } }),
    complete: async () => ({ ok: true as const, value: { view: view() } }),
  } as unknown as OrchestratorRuntime;
  return { runtime, events, getState: () => state };
}

function ports(options: {
  runtime: OrchestratorRuntime;
  dispatchNext?: ParentToolPorts["dispatchNext"];
  start?: ParentToolPorts["start"];
}): ParentToolPorts {
  return {
    runtime: () => options.runtime,
    epoch: () => 1,
    now: () => 2_000,
    ...(options.start === undefined ? {} : { start: options.start }),
    ...(options.dispatchNext === undefined
      ? {}
      : { dispatchNext: options.dispatchNext }),
  };
}

test("start delegates to the extension start service", async () => {
  const fake = fakeRuntime();
  const calls: Array<Record<string, unknown>> = [];
  const tools = createParentToolRuntime(
    ports({
      runtime: fake.runtime,
      start: async (input) => {
        calls.push({ ...input });
        return { ok: true, text: "started", details: { runId: "run-1" } };
      },
    }),
  );
  const outcome = await tools.call("orchestrator_start", {
    title: "standalone",
    steps: ["one"],
  });
  assert.equal(outcome.ok, true);
  assert.deepEqual(calls, [{ title: "standalone", steps: ["one"] }]);
  assert.equal(fake.events.length, 0, "start does not apply a raw reducer event");
});

test("status is read-only and reports the next row", async () => {
  const fake = fakeRuntime();
  const tools = createParentToolRuntime(ports({ runtime: fake.runtime }));
  const outcome = await tools.call("orchestrator_status", {});
  assert.equal(outcome.ok, true);
  assert.match(outcome.text, /ready/);
  assert.equal((outcome.details as { nextTaskId?: string }).nextTaskId, "task-1");
  assert.equal(fake.events.length, 0);
});

test("retry re-queues the blocked row and dispatches it immediately", async () => {
  const fake = fakeRuntime();
  const blocked = applyRunEvent(fake.getState(), {
    type: "task.block",
    runId: "run-1",
    expectedRevision: fake.getState().revision,
    now: 1_100,
    taskId: "task-1",
    reason: "check failed",
  });
  assert.equal(blocked.ok, true);
  if (!blocked.ok) return;
  const next = fakeRuntime(blocked.state);
  const dispatched: string[] = [];
  const tools = createParentToolRuntime(
    ports({
      runtime: next.runtime,
      dispatchNext: async (taskId) => {
        dispatched.push(taskId);
        return { ok: true, text: "child started", details: {} };
      },
    }),
  );
  const outcome = await tools.call("orchestrator_retry", {});
  assert.equal(outcome.ok, true);
  assert.deepEqual(dispatched, ["task-1"]);
  assert.equal(next.getState().tasks["task-1"]!.state, "pending");
  assert.deepEqual(next.events, ["task.retry"]);
});

test("retry refuses when no row is blocked or repaired", async () => {
  const fake = fakeRuntime();
  const tools = createParentToolRuntime(ports({ runtime: fake.runtime }));
  const outcome = await tools.call("orchestrator_retry", {});
  assert.equal(outcome.ok, false);
  assert.match(outcome.text, /no blocked or repaired row/i);
  assert.equal(fake.events.length, 0);
});

test("retry reports a failed dispatch without hiding the re-queue", async () => {
  const fake = fakeRuntime();
  const blocked = applyRunEvent(fake.getState(), {
    type: "task.block",
    runId: "run-1",
    expectedRevision: fake.getState().revision,
    now: 1_100,
    taskId: "task-1",
    reason: "check failed",
  });
  assert.equal(blocked.ok, true);
  if (!blocked.ok) return;
  const next = fakeRuntime(blocked.state);
  const tools = createParentToolRuntime(
    ports({
      runtime: next.runtime,
      dispatchNext: async () => ({
        ok: false,
        code: "child",
        text: "no Builder model",
      }),
    }),
  );
  const outcome = await tools.call("orchestrator_retry", {});
  assert.equal(outcome.ok, false);
  assert.equal((outcome as { code: string }).code, "child");
  assert.match(outcome.text, /no Builder model/);
  assert.equal(next.getState().tasks["task-1"]!.state, "pending");
});

test("register exposes exactly start, status and retry", async () => {
  const fake = fakeRuntime();
  const tools = createParentToolRuntime(ports({ runtime: fake.runtime }));
  const names: string[] = [];
  const registered = tools.register({
    registerTool: (definition) => {
      names.push(definition.name);
    },
  });
  assert.deepEqual(registered.registered, [
    "orchestrator_start",
    "orchestrator_status",
    "orchestrator_retry",
  ]);
  assert.deepEqual(names, registered.registered);
});
