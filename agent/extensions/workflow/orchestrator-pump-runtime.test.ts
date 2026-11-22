/**
 * Pump runtime tests (plan step 17).
 *
 * The pure pump is tested elsewhere; here the subject is the round trip:
 * a child event → a safe boundary decision → exactly one journaled parent wake,
 * surviving reload and never waking on `agent_end` or heartbeats.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { createPumpRuntime } from "./orchestrator-pump-runtime.ts";
import type { OrchestratorRuntime } from "./orchestrator-runtime.ts";
import type { PumpIdentity } from "./orchestrator-tools.ts";
import type { JournalEvent } from "./orchestrator-store.ts";

const IDENTITY: PumpIdentity = {
  runId: "run-1",
  taskId: "task-1",
  attemptId: "attempt-1",
  sessionId: "session-1",
  generation: 1,
  leaseGeneration: 2,
  epoch: 3,
};

function fakeRuntime(initial: JournalEvent[] = []) {
  const events: JournalEvent[] = [...initial];
  const appended: Array<{ type: string; payload: unknown; eventId: string }> = [];
  const runtime = {
    async journalEvents() {
      return { ok: true as const, value: events };
    },
    async appendJournal(type: string, payload: unknown, eventId: string) {
      appended.push({ type, payload, eventId });
      events.push({
        version: 1,
        seq: events.length + 1,
        eventId,
        at: 1,
        type: type as JournalEvent["type"],
        runId: "run-1",
        payload,
        prev: "",
        checksum: "x",
      });
      return { ok: true as const, value: undefined };
    },
  };
  // SAFETY: the pump runtime only reads `journalEvents`/`appendJournal`; every
  // other OrchestratorRuntime method belongs to dispatch/verification.
  return { runtime: runtime as unknown as OrchestratorRuntime, appended, events };
}

function event(over: Record<string, unknown> = {}) {
  return {
    messageId: "msg-1",
    seq: 1,
    kind: "candidate",
    runId: IDENTITY.runId,
    taskId: IDENTITY.taskId,
    attemptId: IDENTITY.attemptId,
    sessionId: IDENTITY.sessionId,
    generation: IDENTITY.generation,
    leaseGeneration: IDENTITY.leaseGeneration,
    epoch: IDENTITY.epoch,
    at: 1_000,
    settled: true,
    pendingTools: 0,
    pendingFollowUps: 0,
    ...over,
  };
}

function harness(options: { identity?: PumpIdentity | null; delivered?: JournalEvent[] } = {}) {
  const fake = fakeRuntime(options.delivered ?? []);
  const deliveredWakes: string[] = [];
  const pump = createPumpRuntime({
    runtime: () => fake.runtime,
    identity: () => (options.identity === null ? undefined : (options.identity ?? IDENTITY)),
    deliver: async (wake) => {
      deliveredWakes.push(wake.id);
      return { ok: true as const };
    },
    now: () => 2_000,
  });
  return { pump, fake, deliveredWakes };
}

test("no bound attempt means no ingest and no wake", async () => {
  const { pump } = harness({ identity: null });
  const result = pump.ingest(event());
  assert.equal(result.ok, false);
  assert.equal((result as any).code, "no_identity");
  const delivery = await pump.drainAndDeliver();
  assert.equal(delivery.delivered, false);
});

test("progress and heartbeats update status but never schedule a turn", async () => {
  const { pump, deliveredWakes } = harness();
  assert.equal(pump.ingest(event({ kind: "progress", settled: false })).ok, true);
  assert.equal(pump.ingest(event({ kind: "heartbeat", messageId: "m2", seq: 2, settled: false })).ok, true);
  const delivery = await pump.drainAndDeliver();
  assert.equal(delivery.delivered, false);
  assert.deepEqual(deliveredWakes, []);
});

test("a candidate inside a live tool batch is deferred, not delivered", async () => {
  const { pump, deliveredWakes } = harness();
  const result = pump.ingest(event({ pendingTools: 2 }));
  assert.equal(result.ok, false);
  assert.equal((result as any).code, "unsafe_boundary");
  assert.equal((result as any).retry, true);
  const delivery = await pump.drainAndDeliver();
  assert.equal(delivery.delivered, false);
  assert.deepEqual(deliveredWakes, []);
});

test("agent_end is never a settle boundary, even with settled:true", async () => {
  const { pump } = harness();
  const result = pump.ingest(event({ kind: "agent-end" }));
  assert.equal(result.ok, false);
  assert.equal((result as any).code, "unsafe_boundary");
});

test("a safe candidate delivers exactly one journaled wake", async () => {
  const { pump, deliveredWakes, fake } = harness();
  const ingested = pump.ingest(event());
  assert.equal(ingested.ok, true);
  const first = await pump.drainAndDeliver();
  assert.equal(first.delivered, true);
  assert.deepEqual(deliveredWakes.length, 1);
  assert.ok(fake.appended.some((entry) => entry.type === "wake.delivered"));

  // A second child event producing the same wake key is not delivered again.
  pump.endTurn();
  const second = pump.ingest(event({ messageId: "msg-2", seq: 2 }));
  assert.equal(second.ok, true);
  const delivery = await pump.drainAndDeliver();
  assert.equal(delivery.delivered, false);
  assert.match((delivery as any).reason, /already delivered/);
  assert.equal(deliveredWakes.length, 1);
});

test("a reload does not re-deliver a wake it already journaled", async () => {
  const key = "run-1:task-1:attempt-1:candidate";
  const deliveredEvent: JournalEvent[] = [
    {
      version: 1,
      seq: 1,
      eventId: `wake-delivered-${key}`,
      at: 1,
      type: "wake.delivered",
      runId: "run-1",
      payload: { wakeKey: key, kind: "candidate" },
      prev: "",
      checksum: "x",
    },
  ];
  const reloadedFake = fakeRuntime(deliveredEvent);
  const reloaded = createPumpRuntime({
    runtime: () => reloadedFake.runtime,
    identity: () => IDENTITY,
    deliver: async () => ({ ok: true as const }),
  });
  assert.equal(reloaded.ingest(event()).ok, true);
  const delivery = await reloaded.drainAndDeliver();
  assert.equal(delivery.delivered, false);
  assert.match((delivery as any).reason, /already delivered/);
  assert.deepEqual(reloaded.deliveredKeys(), [key]);
});

test("a busy parent queues the wake until the settled boundary", async () => {
  const { pump, deliveredWakes } = harness();
  pump.ingest(event());
  assert.equal((await pump.drainAndDeliver()).delivered, true);
  // The parent turn is now running; a second safe wake must wait.
  const second = pump.ingest(event({ messageId: "msg-3", seq: 3, kind: "quiescent" }));
  assert.equal(second.ok, true);
  const early = await pump.drainAndDeliver();
  assert.equal(early.delivered, false);
  assert.equal(deliveredWakes.length, 1);
  pump.endTurn();
  const late = await pump.drainAndDeliver();
  assert.equal(late.delivered, true);
  assert.equal(deliveredWakes.length, 2);
});

test("a stale epoch event is refused after the run rebinds", async () => {
  const { pump } = harness();
  const stale = pump.ingest(event({ epoch: 2 }));
  assert.equal(stale.ok, false);
  assert.equal((stale as any).code, "stale_epoch");
});

test("disposal refuses further events and wakes", async () => {
  const { pump } = harness();
  pump.dispose();
  assert.equal(pump.disposed(), true);
  assert.equal(pump.ingest(event()).ok, false);
  const delivery = await pump.drainAndDeliver();
  assert.equal(delivery.delivered, false);
});
