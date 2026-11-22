/**
 * Child-host dispatcher tests (integration steps 9/11/16).
 *
 * The dispatcher is where a decision becomes an effect. These tests pin the
 * ordering that makes a crash honest: arm the control window before the child
 * can connect, prepare before launch, and report `uncertain` (never a clean
 * failure) when a visible child exists but did not acknowledge.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  controlGrantRefFrom,
  createChildDispatcher,
  createTerminalChildHost,
  kickoffText,
  type ChildHost,
  type HostCapability,
} from "./orchestrator-child-host.ts";
import type { OrchestratorRuntime } from "./orchestrator-runtime.ts";
import type { RunControl, StartWait, WorkerGrant } from "./orchestrator-run-control.ts";
import type { TaskRecord } from "./orchestrator-state.ts";
import type { WorkerLaunchSpec } from "./orchestrator-worker.ts";

const task: TaskRecord = {
  taskId: "task-1",
  covers: ["R1"],
  objective: "Implement the thing",
  nonGoals: [],
  dependsOn: [],
  expectedFiles: ["src/thing.ts"],
  acceptanceChecks: ["npm test"],
  sizeRationale: "small",
  state: "pending",
  attempts: [],
  counters: { repairRounds: 0, rollovers: 0, noProgress: 0, launchFailures: 0 },
};

function runtimeView(): OrchestratorRuntime {
  return {
    view: () => ({
      runId: "run-1",
      phase: "running",
      roadmapRevision: 2,
      roadmap: { path: "C:/plans/p.md", digest: "d".repeat(64), title: "P", requirementCount: 1 },
      plan: null,
      preview: null,
      approval: null,
      preparationStarted: true,
      state: {
        tasks: { "task-1": task },
        order: ["task-1"],
        mutation: null,
      } as never,
    }),
  } as unknown as OrchestratorRuntime;
}

const grant: WorkerGrant = {
  version: 1,
  runId: "run-1",
  taskId: "task-1",
  attemptId: "attempt-1",
  sessionId: "worker-id",
  generation: 7,
  leaseGeneration: 7,
  taskStartId: "start-worker-id-attempt-1",
  endpoint: { kind: "named-pipe", path: "\\\\.\\pipe\\test", privateDir: "C:/tmp" },
  secret: "s".repeat(40),
};

test("dispatcher: prepare orders grant → metadata → launch, and wake arms before showing the child", async () => {
  const calls: string[] = [];
  let waitArmed = false;
  const control = {
    async start() {
      calls.push("control.start");
      return { ok: true as const };
    },
    async prepareGrant() {
      calls.push("control.prepareGrant");
      return { ok: true as const, grant, grantRef: "C:/tmp/grant.json" };
    },
    awaitStart() {
      waitArmed = true;
      calls.push("control.awaitStart");
      return Promise.resolve<StartWait>({ ok: true, acknowledged: true });
    },
    grant: () => grant,
  } as unknown as RunControl;

  const capability: HostCapability = {
    available: true,
    label: "Test Terminal",
    separateWindow: true,
    focus: false,
  };
  const spec = {
    workerId: "worker-id",
    taskStartId: grant.taskStartId,
    sessionFile: "C:/sessions/child.jsonl",
    sessionId: "real-session",
  } as unknown as WorkerLaunchSpec;
  const host: ChildHost = {
    capabilities: async () => capability,
    async prepare(input) {
      assert.equal(waitArmed, false, "the grant exists before the child is created");
      assert.equal(input.controlSessionId, "worker-run-1-task-1-attempt-1");
      calls.push("host.prepare");
      return { ok: true, spec, sessionRef: "real-session" };
    },
    async launch() {
      assert.equal(waitArmed, true, "the start window must be armed before the child can connect");
      calls.push("host.launch");
      return { ok: true };
    },
  };

  const dispatcher = createChildDispatcher({
    runtime: () => runtimeView(),
    control: () => control,
    host: () => host,
    builderModel: () => ({ provider: "p", id: "builder" }),
    parentSessionRef: () => "parent-1",
    cwd: () => "C:/work",
    trust: () => "trust",
    allocateGeneration: () => 7,
  });

  const prepared = await dispatcher.prepare({
    runId: "run-1",
    taskId: "task-1",
    attemptId: "attempt-1",
    generation: 7,
  });
  assert.equal(prepared.ok, true);
  if (!prepared.ok) return;
  assert.equal(prepared.child.sessionRef, "real-session");
  const woke = await dispatcher.wake({
    sessionRef: "real-session",
    taskStartId: grant.taskStartId,
    taskId: "task-1",
    attemptId: "attempt-1",
  });
  assert.deepEqual(woke, { ok: true, acknowledged: true });
  assert.deepEqual(calls, [
    "control.start",
    "control.prepareGrant",
    "host.prepare",
    "control.awaitStart",
    "host.launch",
  ]);

  // A second prepare for the same attempt never creates a second child.
  const again = await dispatcher.prepare({
    runId: "run-1",
    taskId: "task-1",
    attemptId: "attempt-1",
    generation: 7,
  });
  assert.equal(again.ok, true);
  assert.equal(calls.filter((call) => call === "host.prepare").length, 1);
});

test("dispatcher: a visible child without an acknowledgement is uncertain", async () => {
  const control = {
    async start() {
      return { ok: true as const };
    },
    async prepareGrant() {
      return { ok: true as const, grant, grantRef: "C:/tmp/grant.json" };
    },
    awaitStart() {
      return Promise.resolve<StartWait>({
        ok: false,
        error: "the start was delivered but the child did not acknowledge it",
        delivered: true,
        uncertain: true,
      });
    },
    grant: () => grant,
  } as unknown as RunControl;
  const host: ChildHost = {
    capabilities: async () => ({
      available: true,
      label: "Test Terminal",
      separateWindow: true,
      focus: false,
    }),
    async prepare() {
      return {
        ok: true,
        spec: {
          workerId: "worker-id",
          taskStartId: grant.taskStartId,
          sessionFile: "C:/sessions/child.jsonl",
        } as unknown as WorkerLaunchSpec,
        sessionRef: "real-session",
      };
    },
    async launch() {
      return { ok: true };
    },
  };
  const dispatcher = createChildDispatcher({
    runtime: () => runtimeView(),
    control: () => control,
    host: () => host,
    builderModel: () => ({ provider: "p", id: "builder" }),
    parentSessionRef: () => "parent-1",
    cwd: () => "C:/work",
    trust: () => "trust",
    allocateGeneration: () => 7,
  });
  await dispatcher.prepare({
    runId: "run-1",
    taskId: "task-1",
    attemptId: "attempt-1",
    generation: 7,
  });
  const woke = await dispatcher.wake({
    sessionRef: "real-session",
    taskStartId: grant.taskStartId,
    taskId: "task-1",
    attemptId: "attempt-1",
  });
  assert.equal(woke.ok, false);
  if (woke.ok) return;
  assert.equal(woke.uncertain, true);
});

test("dispatcher: a missing Builder model or unavailable host prepares nothing", async () => {
  const dispatcher = createChildDispatcher({
    runtime: () => runtimeView(),
    control: () => ({}) as RunControl,
    host: () => ({
      capabilities: async () => ({
        available: false,
        label: "none",
        separateWindow: false,
        focus: false,
        reason: "no terminal adapter",
      }),
      prepare: async () => {
        throw new Error("must not be called");
      },
      launch: async () => {
        throw new Error("must not be called");
      },
    }),
    builderModel: () => undefined,
    parentSessionRef: () => "parent-1",
    cwd: () => "C:/work",
    trust: () => "trust",
    allocateGeneration: () => 1,
  });
  const prepared = await dispatcher.prepare({
    runId: "run-1",
    taskId: "task-1",
    attemptId: "attempt-1",
    generation: 1,
  });
  assert.equal(prepared.ok, false);
  if (prepared.ok) return;
  assert.match(prepared.error, /Builder model/);
});

test("terminal host: readiness includes the SDK probe", async () => {
  const terminal = {
    port: {
      capabilities: async () => ({
        available: true,
        label: "Test Terminal",
        separateWindow: true,
        focus: false,
      }),
    },
  } as never;
  const healthy = createTerminalChildHost({
    sdk: async () => ({ probe: async () => undefined }) as never,
    terminal,
    label: "Test Terminal",
  });
  const ready = await healthy.capabilities();
  assert.equal(ready.available, true);
  assert.equal(ready.label, "Test Terminal");

  const broken = createTerminalChildHost({
    sdk: async () =>
      ({
        probe: async () => {
          throw new Error("SessionManager export invalid");
        },
      }) as never,
    terminal,
    label: "Test Terminal",
  });
  const unavailable = await broken.capabilities();
  assert.equal(unavailable.available, false);
  assert.match(unavailable.reason ?? "", /SDK worker storage unavailable/);
  assert.match(unavailable.reason ?? "", /SessionManager export invalid/);
});

test("terminal host: a failed SDK probe prepares nothing", async () => {
  let creates = 0;
  const host = createTerminalChildHost({
    sdk: async () =>
      ({
        probe: async () => {
          throw new Error("SessionManager unavailable");
        },
        createSession: async () => {
          creates += 1;
          return { sessionId: "s", sessionFile: "C:/sessions/s.jsonl" };
        },
      }) as never,
    terminal: {
      port: {
        capabilities: async () => ({
          available: true,
          label: "Test Terminal",
          separateWindow: true,
          focus: false,
        }),
      },
    } as never,
  });
  const prepared = await host.prepare({
    launch: {} as never,
    grantRef: "g",
    controlSessionId: "control-1",
  });
  assert.equal(prepared.ok, false);
  if (prepared.ok) return;
  assert.match(prepared.error, /SDK worker storage is unavailable/);
  assert.equal(creates, 0);
});

test("kickoff text carries the assignment contract, not the roadmap", () => {
  const text = kickoffText({ task, taskStartId: "start-1", workerId: "w1" });
  assert.match(text, /Start id: start-1/);
  assert.match(text, /R1/);
  assert.match(text, /npm test/);
  assert.match(text, /src\/thing\.ts/);
  assert.match(text, /a report is a claim/);
});

test("control grant reference is read from the child's own metadata", () => {
  assert.equal(
    controlGrantRefFrom([
      { type: "custom", customType: "workflow-control-grant", data: { grantRef: "a" } },
      { type: "custom", customType: "workflow-control-grant", data: { grantRef: "b" } },
    ]),
    "b",
  );
  assert.equal(controlGrantRefFrom([{ type: "custom", customType: "other" }]), undefined);
});
