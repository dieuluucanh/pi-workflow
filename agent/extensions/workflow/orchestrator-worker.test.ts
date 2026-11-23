/**
 * Persistent worker tests (step 24): durable file+metadata before launch,
 * readiness and lease gates before the one-shot wake, and restart
 * reconciliation that never replays an uncertain start.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { readWorkerAssignment } from "./orchestrator-worker-session.ts";
import {
  beginWorkerStart,
  deliverWake,
  markWorkerClosed,
  markWorkerReady,
  prepareWorker,
  reconcileWorker,
  recordStartAck,
  type WorkerLaunchInput,
  type WorkerSdkPort,
  type WorkerState,
} from "./orchestrator-worker.ts";

test("assignment: checkless and standalone rows remain valid", () => {
  const entries = [
    {
      type: "custom",
      customType: "workflow-managed-session",
      data: { taskId: "task-1" },
    },
    {
      type: "custom",
      customType: "workflow-roadmap-reference",
      data: { path: "roadmap.md", digest: "digest", revision: 1 },
    },
    {
      type: "custom",
      customType: "workflow-task-scope",
      data: {
        covers: [],
        objective: "Standalone documentation task",
        acceptanceChecks: [],
        expectedFiles: ["docs/api.md"],
        mutationScope: [],
      },
    },
  ];
  const read = readWorkerAssignment(entries as never);
  assert.equal(read.ok, true);
  if (!read.ok) return;
  assert.deepEqual(read.scope.covers, []);
  assert.deepEqual(read.scope.acceptanceChecks, []);
  assert.deepEqual(read.scope.expectedFiles, ["docs/api.md"]);

  const malformed = readWorkerAssignment(
    entries.map((entry) =>
      entry.customType === "workflow-task-scope"
        ? { ...entry, data: { ...entry.data, acceptanceChecks: "not-a-list" } }
        : entry,
    ) as never,
  );
  assert.equal(malformed.ok, false);
});

function fakeSdk(over: Partial<WorkerSdkPort> = {}) {
  const calls: string[] = [];
  const entries = new Set<string>();
  const sdk: WorkerSdkPort = {
    async createSession({ name }) {
      calls.push(`create:${name}`);
      return { sessionId: "session-1", sessionFile: "C:/sessions/session-1.jsonl" };
    },
    async exists() {
      return true;
    },
    async appendManagedEntry(_file, type, key) {
      calls.push(`entry:${type}`);
      entries.add(`${type}:${key}`);
    },
    async hasManagedEntry(_file, type, key) {
      return entries.has(`${type}:${key}`);
    },
    async sendWake(_file, wake) {
      calls.push(`wake:${wake.customType}:${wake.content}:${wake.triggerTurn}`);
    },
    ...over,
  };
  return { sdk, calls, entries };
}

function input(over: Partial<WorkerLaunchInput> = {}): WorkerLaunchInput {
  return {
    runId: "run-1",
    taskId: "task-1",
    attemptId: "attempt-1",
    parentSessionRef: "parent-session",
    packetRef: "sha-abc",
    kickoff: { customType: "workflow-task-assignment", content: '{"task":"build"}' },
    roadmap: { path: "C:/docs/roadmap.md", digest: "a".repeat(64), revision: 1 },
    cwd: "C:/work/app",
    profile: "builder-profile",
    trust: "trust",
    model: { provider: "p", id: "builder", thinking: "medium" },
    resources: { extensions: ["C:/pi/ext"], skills: ["C:/pi/skills"] },
    now: 10,
    ...over,
  };
}

async function prepared(over: Partial<WorkerLaunchInput> = {}) {
  const sdk = fakeSdk();
  const result = await prepareWorker(input(over), sdk.sdk);
  assert.equal(result.ok, true, result.ok ? "" : result.error);
  return { ...sdk, ...(result as { ok: true; value: { spec: any; state: WorkerState } }).value };
}

test("prepare creates the durable file and writes metadata before launch", async () => {
  const value = await prepared();
  assert.equal(value.calls[0]?.startsWith("create:"), true);
  assert.equal(value.spec.workerId, "worker-run-1-task-1-attempt-1");
  assert.equal(value.spec.sessionFile, "C:/sessions/session-1.jsonl");
  assert.equal(value.state.phase, "launched");
  assert.equal(value.calls.filter((call) => call.startsWith("entry:")).length, 3);
  // The durable kickoff and the wake are separate values.
  assert.equal(value.spec.kickoff.content, '{"task":"build"}');
  assert.equal(value.spec.wake.customType, "workflow-task-start");
  assert.equal(value.spec.wake.content, value.spec.taskStartId);
  assert.equal(value.spec.wake.triggerTurn, true);
  assert.equal(value.spec.model.id, "builder");
  assert.equal(value.spec.trust, "trust");
  assert.deepEqual(value.spec.resources.extensions, ["C:/pi/ext"]);
  assert.equal("messages" in value.spec, false);
  assert.equal(value.calls.some((call) => call.startsWith("wake:")), false);
});

test("a relaunch reopens the same worker and never duplicates metadata", async () => {
  const sdk = fakeSdk();
  const first = await prepareWorker(input(), sdk.sdk);
  assert.equal(first.ok, true);
  const again = await prepareWorker(input(), sdk.sdk, {
    existingSessionFile: "C:/sessions/session-1.jsonl",
  });
  assert.equal(again.ok, true);
  assert.equal((again as any).value.spec.workerId, (first as any).value.spec.workerId);
  assert.equal(sdk.calls.filter((call) => call.startsWith("create:")).length, 1);
  assert.equal(sdk.calls.filter((call) => call.startsWith("entry:")).length, 3);
});

test("readiness, lease and persisted intent gate the single wake", async () => {
  const value = await prepared();
  assert.equal(
    (beginWorkerStart(value.spec, value.state, { leaseGeneration: 1, currentLeaseGeneration: 1, now: 11 }) as any).code,
    "not_ready",
  );
  const ready = markWorkerReady(value.state, { sessionId: "session-1", generation: 1, now: 11 });
  assert.equal(ready.ok, true);
  const state = (ready as any).value;
  assert.equal(
    (beginWorkerStart(value.spec, state, { leaseGeneration: 1, currentLeaseGeneration: 2, now: 12 }) as any).code,
    "lease",
  );
  const started = beginWorkerStart(value.spec, state, {
    leaseGeneration: 2,
    currentLeaseGeneration: 2,
    now: 12,
  });
  assert.equal(started.ok, true);
  const start = (started as any).value;
  assert.equal(start.intent.taskStartId, value.spec.taskStartId);

  assert.equal(
    (await deliverWake(value.spec, start.state, value.sdk, { intentPersisted: false, now: 13 }) as any).code,
    "invalid",
  );
  const delivered = await deliverWake(value.spec, start.state, value.sdk, {
    intentPersisted: true,
    now: 13,
  });
  assert.equal(delivered.ok, true);
  assert.equal(value.calls.filter((call) => call.startsWith("wake:")).length, 1);
  assert.match(value.calls.at(-1)!, /triggerTurn|true/);

  const duplicate = await deliverWake(value.spec, (delivered as any).value, value.sdk, {
    intentPersisted: true,
    now: 14,
  });
  assert.equal((duplicate as any).code, "duplicate");

  const acked = recordStartAck(value.spec, (delivered as any).value, {
    taskStartId: value.spec.taskStartId,
    now: 14,
  });
  assert.equal((acked as any).value.phase, "running");
});

test("reconciliation never replays an uncertain start", async () => {
  const value = await prepared();
  const ready = (markWorkerReady(value.state, { sessionId: "s", generation: 1, now: 2 }) as any).value;
  assert.equal((await reconcileWorker({ state: ready, exists: async () => true })).action, "await_start");

  const starting = (beginWorkerStart(value.spec, ready, {
    leaseGeneration: 1,
    currentLeaseGeneration: 1,
    now: 3,
  }) as any).value.state;
  assert.equal(
    (await reconcileWorker({ state: starting, exists: async () => true })).action,
    "needs_reconciliation",
  );
  const delivered = (await deliverWake(value.spec, starting, value.sdk, {
    intentPersisted: true,
    now: 4,
  }) as any).value;
  assert.equal(
    (await reconcileWorker({ state: delivered, exists: async () => true })).action,
    "needs_reconciliation",
  );
  assert.equal(
    (await reconcileWorker({ state: delivered, exists: async () => false })).action,
    "recreate",
  );

  const running = (
    recordStartAck(value.spec, delivered, {
      taskStartId: value.spec.taskStartId,
      now: 5,
    }) as any
  ).value;
  assert.equal((await reconcileWorker({ state: running, exists: async () => true })).action, "running");
  assert.equal(
    (await reconcileWorker({ state: markWorkerClosed(running, 6), exists: async () => true })).action,
    "terminal",
  );
});

test("invalid or oversized launch inputs are refused before any SDK effect", async () => {
  const sdk = fakeSdk();
  const bad = await prepareWorker(input({ kickoff: { customType: "x", content: "y".repeat(9_000) } }), sdk.sdk);
  assert.equal(bad.ok, false);
  const noModel = await prepareWorker(input({ model: { provider: "", id: "" } }), sdk.sdk);
  assert.equal(noModel.ok, false);
  assert.equal(sdk.calls.length, 0);
});

test("an acknowledgement must name this worker's exact task-start id", async () => {
  const value = await prepared();
  const ready = (markWorkerReady(value.state, {
    sessionId: "session-1",
    generation: 1,
    now: 11,
  }) as any).value;
  const starting = (beginWorkerStart(value.spec, ready, {
    leaseGeneration: 1,
    currentLeaseGeneration: 1,
    now: 12,
  }) as any).value;
  const delivered = (await deliverWake(value.spec, starting.state, value.sdk, {
    intentPersisted: true,
    now: 13,
  })) as any;

  const wrong = recordStartAck(value.spec, delivered.value, {
    taskStartId: "start-somewhere-else",
    now: 14,
  });
  assert.equal(wrong.ok, false);
  assert.equal((wrong as any).code, "mismatch");
  assert.equal(wrong.ok ? undefined : wrong.error.includes("does not name"), true);

  const right = recordStartAck(value.spec, delivered.value, {
    taskStartId: value.spec.taskStartId,
    now: 15,
  });
  assert.equal(right.ok, true);
  assert.equal(right.ok ? right.value.phase : undefined, "running");
});
