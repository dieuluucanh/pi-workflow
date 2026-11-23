/**
 * Child dispatch composition (launch → arm/await ack → failure honesty).
 *
 * The regression this pins: `wake()` used to return success after only reading
 * a map, so a run reported “Dispatched” while no window/tab ever opened.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  createChildDispatcher,
  type ChildHost,
  type ChildDispatcherPorts,
} from "./orchestrator-child-host.ts";
import { createRunState } from "./orchestrator-state.ts";
import { createFrozenTodosFromSteps } from "./todo-snapshot.ts";
import type { WorkerGrant, RunControl } from "./orchestrator-run-control.ts";
import type { WorkerLaunchSpec } from "./orchestrator-worker.ts";
import type { OrchestratorRuntime } from "./orchestrator-runtime.ts";

function runtime(): OrchestratorRuntime {
  const frozen = createFrozenTodosFromSteps({
    title: "child",
    steps: ["first", "second"],
    mode: "orchestrator",
    now: 1,
  });
  assert.equal(frozen.ok, true);
  if (!frozen.ok) throw new Error((frozen as { error: string }).error);
  const created = createRunState({ runId: "run-1", todos: frozen.snapshot, now: 1_000 });
  assert.equal(created.ok, true);
  if (!created.ok) throw new Error((created as { error: string }).error);
  const view = {
    runId: "run-1",
    phase: created.state.phase,
    todos: frozen.snapshot,
    nextTaskId: "task-1",
    state: created.state,
  };
  return { view: () => view } as unknown as OrchestratorRuntime;
}

function grant(): WorkerGrant {
  return {
    version: 1,
    runId: "run-1",
    taskId: "task-1",
    attemptId: "task-1-attempt-1",
    sessionId: "worker-run-1-task-1-task-1-attempt-1",
    generation: 1,
    leaseGeneration: 1,
    taskStartId: "start-1",
    endpoint: { kind: "unix", path: "/tmp/sock" } as never,
    secret: "secret",
  };
}

function harness(options: {
  launch?: () => Promise<{ ok: true; handle?: string } | { ok: false; error: string }>;
  start?: Awaited<ReturnType<RunControl["awaitStart"]>>;
}) {
  const calls: string[] = [];
  const host: ChildHost = {
    capabilities: async () => ({
      available: true,
      label: "Fake host",
      separateWindow: true,
      focus: false,
    }),
    prepare: async ({ launch }) =>
      ({
        ok: true,
        spec: {
          ...launch,
          schemaVersion: 1,
          workerId: "worker-1",
          sessionName: "child",
          sessionFile: "/tmp/child.jsonl",
          sessionId: "session-1",
          resources: { extensions: [], skills: [], prompts: [] },
          wake: { customType: "workflow-task-start", content: "start-1", triggerTurn: true },
          taskStartId: "start-1",
          assignmentId: "assignment-1",
          createdAt: 1,
        } satisfies WorkerLaunchSpec,
        sessionRef: "session-1",
        sessionFile: "/tmp/child.jsonl",
      }) as never,
    launch: async () => {
      calls.push("launch");
      return options.launch ? await options.launch() : { ok: true, handle: "handle-1" };
    },
  };
  const control: RunControl = {
    endpoint: () => ({ kind: "unix", path: "/tmp/sock" }),
    start: async () => ({ ok: true }),
    stop: async () => undefined,
    prepareGrant: async () => ({ ok: true, grant: grant(), grantRef: "/tmp/grant.json" }),
    awaitStart: async (input: { sessionId: string }) => {
      calls.push(`await:${input.sessionId}`);
      return options.start ?? { ok: true, acknowledged: true };
    },
    request: async () => true,
    grant: () => undefined,
    connections: () => 0,
    onEvent: async () => undefined,
  } as unknown as RunControl;

  const ports: ChildDispatcherPorts = {
    runtime,
    control: () => control,
    host: () => host,
    builderModel: () => ({ provider: "p", id: "m" }),
    parentSessionRef: () => "parent",
    cwd: () => "/tmp",
    trust: () => "session",
    allocateGeneration: () => 1,
    now: () => 1_000,
  };
  return { dispatcher: createChildDispatcher(ports), calls };
}

test("wake launches exactly once, then waits for the child's start ack", async () => {
  const h = harness({});
  const prepared = await h.dispatcher.prepare({
    runId: "run-1",
    taskId: "task-1",
    attemptId: "task-1-attempt-1",
    generation: 1,
  });
  assert.equal(prepared.ok, true);

  const woken = await h.dispatcher.wake({
    sessionRef: "session-1",
    taskStartId: "start-1",
    taskId: "task-1",
    attemptId: "task-1-attempt-1",
  });
  assert.deepEqual(woken, { ok: true, acknowledged: true, handle: "handle-1" });
  assert.deepEqual(h.calls, ["launch", `await:worker-run-1-task-1-task-1-attempt-1`]);

  // A second wake never shows a second child.
  const again = await h.dispatcher.wake({
    sessionRef: "session-1",
    taskStartId: "start-1",
    taskId: "task-1",
    attemptId: "task-1-attempt-1",
  });
  assert.equal(again.ok, true);
  assert.equal(h.calls.filter((call) => call === "launch").length, 1);
});

test("a launch refusal is a failure, not a dispatched child", async () => {
  const h = harness({ launch: async () => ({ ok: false, error: "wt.exe is missing" }) });
  await h.dispatcher.prepare({
    runId: "run-1",
    taskId: "task-1",
    attemptId: "task-1-attempt-1",
    generation: 1,
  });
  const woken = await h.dispatcher.wake({
    sessionRef: "session-1",
    taskStartId: "start-1",
    taskId: "task-1",
    attemptId: "task-1-attempt-1",
  });
  assert.equal(woken.ok, false);
  assert.match((woken as { error: string }).error, /wt\.exe is missing/);
  assert.equal((woken as { uncertain?: boolean }).uncertain, undefined);
});

test("a delivered start without an ack is uncertain", async () => {
  const h = harness({
    start: { ok: false, error: "no ack within 45s", delivered: true, uncertain: true },
  });
  await h.dispatcher.prepare({
    runId: "run-1",
    taskId: "task-1",
    attemptId: "task-1-attempt-1",
    generation: 1,
  });
  const woken = await h.dispatcher.wake({
    sessionRef: "session-1",
    taskStartId: "start-1",
    taskId: "task-1",
    attemptId: "task-1-attempt-1",
  });
  assert.equal(woken.ok, false);
  assert.equal((woken as { uncertain?: boolean }).uncertain, true);
});
