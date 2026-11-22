/**
 * Integration-seam proof tests (plan step 1).
 *
 * Two properties the later runtime steps depend on:
 *
 *  1. Worker launch order is durable-before-visible: session file → managed
 *     metadata → readiness/lease → persisted start intent → exactly one wake.
 *     A resumed worker with no fresh authorization performs no wake at all.
 *  2. Host authority is grant-bound. A self-declared owner (or a real command
 *     name) never authorizes a privileged request; only a live grant the host
 *     itself delivered to that registration does, and only once.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  beginWorkerStart,
  deliverWake,
  markWorkerReady,
  prepareWorker,
  reconcileWorker,
  recordStartAck,
  type WorkerLaunchInput,
  type WorkerSdkPort,
} from "./orchestrator-worker.ts";
import {
  BRIDGE_AUTH_VERSION,
  createGrantAuthority,
  createGrantHolder,
  parseBridgeGrant,
} from "./host-bridge-auth.ts";

// ── Launch ordering ──────────────────────────────────────────────────

function orderedSdk() {
  const effects: string[] = [];
  // Keyed entries are durable on the real host: a reopen must find them and
  // skip re-appending, exactly like `SessionManager` reading the file.
  const durable = new Set<string>();
  const sdk: WorkerSdkPort = {
    async createSession({ name }) {
      effects.push(`create:${name}`);
      return { sessionId: "session-1", sessionFile: "C:/sessions/session-1.jsonl" };
    },
    async exists() {
      return true;
    },
    async appendManagedEntry(_file, type, key) {
      effects.push(`entry:${type}:${key}`);
      durable.add(`${type}:${key}`);
    },
    async hasManagedEntry(_file, type, key) {
      return durable.has(`${type}:${key}`);
    },
    async sendWake(_file, wake) {
      effects.push(`wake:${wake.content}`);
    },
  };
  return { sdk, effects };
}

function launchInput(over: Partial<WorkerLaunchInput> = {}): WorkerLaunchInput {
  return {
    runId: "run-1",
    taskId: "task-1",
    attemptId: "attempt-1",
    parentSessionRef: "parent-session",
    packetRef: "sha-abc",
    kickoff: { customType: "workflow-task-assignment", content: '{"task":"build"}' },
    roadmap: { path: "C:/docs/roadmap.md", digest: "a".repeat(64), revision: 1 },
    cwd: "C:/work/app",
    trust: "trust",
    model: { provider: "p", id: "builder", thinking: "medium" },
    now: 10,
    ...over,
  };
}

test("seam: metadata is durable before readiness, and the wake is last", async () => {
  const { sdk, effects } = orderedSdk();
  const prepared = await prepareWorker(launchInput(), sdk);
  assert.equal(prepared.ok, true, prepared.ok ? "" : prepared.error);
  if (!prepared.ok) return;
  const { spec, state } = prepared.value;

  // Nothing is visible to a child before its metadata exists.
  assert.equal(effects[0]?.startsWith("create:"), true);
  assert.deepEqual(
    effects.slice(1).map((entry) => entry.split(":")[1]),
    ["workflow-managed-session", "workflow-task-assignment", "workflow-roadmap-reference"],
  );
  assert.equal(effects.some((entry) => entry.startsWith("wake:")), false, "prepare never wakes");

  const ready = markWorkerReady(state, { sessionId: "session-1", generation: 1, now: 11 });
  assert.equal(ready.ok, true);
  if (!ready.ok) return;

  const started = beginWorkerStart(spec, ready.value, {
    leaseGeneration: 1,
    currentLeaseGeneration: 1,
    now: 12,
  });
  assert.equal(started.ok, true);
  if (!started.ok) return;
  assert.equal(started.value.intent.taskStartId, spec.taskStartId);

  // Intent must be persisted before delivery.
  const premature = await deliverWake(spec, started.value.state, sdk, {
    intentPersisted: false,
    now: 13,
  });
  assert.equal(premature.ok, false);
  assert.equal(effects.some((entry) => entry.startsWith("wake:")), false);

  const delivered = await deliverWake(spec, started.value.state, sdk, {
    intentPersisted: true,
    now: 13,
  });
  assert.equal(delivered.ok, true);
  assert.deepEqual(effects.at(-1), `wake:${spec.taskStartId}`);
  assert.equal(effects.filter((entry) => entry.startsWith("wake:")).length, 1);

  // A second delivery is refused: no duplicate assignment turn.
  if (delivered.ok) {
    const duplicate = await deliverWake(spec, delivered.value, sdk, {
      intentPersisted: true,
      now: 14,
    });
    assert.equal(duplicate.ok, false);
    assert.equal((duplicate as any).code, "duplicate");
    assert.equal(effects.filter((entry) => entry.startsWith("wake:")).length, 1);
  }

  if (delivered.ok) {
    const ack = recordStartAck(spec, delivered.value, { taskStartId: spec.taskStartId, now: 15 });
    assert.equal(ack.ok, true);
    if (ack.ok) assert.equal(ack.value.phase, "running");
  }
});

test("seam: a resumed worker without authorization stays idle", async () => {
  const { sdk, effects } = orderedSdk();
  const prepared = await prepareWorker(launchInput(), sdk);
  assert.equal(prepared.ok, true);
  if (!prepared.ok) return;

  // Resume = a durable file that already exists; no new create, no wake.
  const before = effects.length;
  const resumed = await prepareWorker(launchInput(), sdk, {
    existingSessionFile: prepared.value.spec.sessionFile,
  });
  assert.equal(resumed.ok, true);
  assert.equal(effects.length, before, "reopen performs no wake and no create");

  const reconciliation = await reconcileWorker({
    state: resumed.value.state,
    exists: async () => true,
  });
  assert.equal(reconciliation.action, "reopen");

  // The same worker still holds lease 1 and no start intent: nothing runs.
  const withoutLease = beginWorkerStart(resumed.value.spec, resumed.value.state, {
    leaseGeneration: 1,
    currentLeaseGeneration: 2,
    now: 20,
  });
  assert.equal(withoutLease.ok, false);
  assert.equal(effects.filter((entry) => entry.startsWith("wake:")).length, 0);
});

test("seam: a persisted assignment is data, not a turn trigger", async () => {
  const { sdk } = orderedSdk();
  const prepared = await prepareWorker(launchInput(), sdk);
  assert.equal(prepared.ok, true);
  if (!prepared.ok) return;
  // The kickoff content never appears in the wake: the wake only carries the
  // correlated start id, so a replay cannot resubmit the assignment.
  assert.equal(prepared.value.spec.wake.content, prepared.value.spec.taskStartId);
  assert.equal(prepared.value.spec.wake.content.includes('"task":"build"'), false);
  assert.equal(prepared.value.spec.wake.triggerTurn, true);
});

// ── Host-issued capability ──────────────────────────────────────────

const EPOCH = 7;

function grantedAuthority() {
  let clock = 1_000;
  let counter = 0;
  const authority = createGrantAuthority({
    now: () => clock,
    random: () => `t${++counter}`,
  });
  return { authority, advance: (ms: number) => (clock += ms), now: () => clock };
}

test("grant: a self-declared owner command alone never authorizes", () => {
  const { authority, now } = grantedAuthority();
  // No grant was ever issued, so a real owner name cannot be used.
  const result = authority.accept({
    raw: {
      version: BRIDGE_AUTH_VERSION,
      token: "forged-token",
      ownerCommand: "orchestrator",
      sessionId: "session-a",
      epoch: EPOCH,
      issuedAt: now() - 1_000,
      expiresAt: now() + 1_000,
    },
    ownerCommand: "orchestrator",
    sessionId: "session-a",
    epoch: EPOCH,
    operation: "create",
  });
  assert.equal(result.ok, false);
  assert.equal((result as any).code, "unknown");

  const absent = authority.accept({
    raw: undefined,
    ownerCommand: "orchestrator",
    sessionId: "session-a",
    epoch: EPOCH,
    operation: "create",
  });
  assert.equal(absent.ok, false);
  assert.equal((absent as any).code, "absent");
});

test("grant: a host-issued grant is single-use and bound to owner/session/epoch", () => {
  const { authority, now } = grantedAuthority();
  const issued = authority.issue({ ownerCommand: "orchestrator", sessionId: "session-a", epoch: EPOCH });
  assert.equal(issued.ok, true);
  if (!issued.ok) return;

  const foreignOwner = authority.accept({
    raw: issued.grant,
    ownerCommand: "other-extension",
    sessionId: "session-a",
    epoch: EPOCH,
    operation: "create",
  });
  assert.equal((foreignOwner as any).code, "owner_mismatch");

  const foreignSession = authority.accept({
    raw: issued.grant,
    ownerCommand: "orchestrator",
    sessionId: "session-b",
    epoch: EPOCH,
    operation: "create",
  });
  assert.equal((foreignSession as any).code, "session_mismatch");

  const staleEpoch = authority.accept({
    raw: issued.grant,
    ownerCommand: "orchestrator",
    sessionId: "session-a",
    epoch: EPOCH - 1,
    operation: "create",
  });
  assert.equal((staleEpoch as any).code, "epoch_mismatch");

  const accepted = authority.accept({
    raw: issued.grant,
    ownerCommand: "orchestrator",
    sessionId: "session-a",
    epoch: EPOCH,
    operation: "create",
  });
  assert.equal(accepted.ok, true);

  const replayed = authority.accept({
    raw: issued.grant,
    ownerCommand: "orchestrator",
    sessionId: "session-a",
    epoch: EPOCH,
    operation: "create",
  });
  assert.equal((replayed as any).code, "replayed");
  assert.ok(now() > 0);
});

test("grant: expiry and teardown invalidate older authority", () => {
  const { authority, advance, now } = grantedAuthority();
  const issued = authority.issue({
    ownerCommand: "orchestrator",
    sessionId: "session-a",
    epoch: EPOCH,
    ttlMs: 500,
  });
  assert.equal(issued.ok, true);
  if (!issued.ok) return;
  advance(600);
  const expired = authority.accept({
    raw: issued.grant,
    ownerCommand: "orchestrator",
    sessionId: "session-a",
    epoch: EPOCH,
    operation: "create",
  });
  assert.equal((expired as any).code, "expired");
  assert.equal(parseBridgeGrant(issued.grant, now() + 1).ok, false);

  const fresh = authority.issue({ ownerCommand: "orchestrator", sessionId: "session-a", epoch: EPOCH });
  assert.equal(fresh.ok, true);
  authority.reset();
  const afterReset = authority.accept({
    raw: (fresh as any).grant,
    ownerCommand: "orchestrator",
    sessionId: "session-a",
    epoch: EPOCH,
    operation: "create",
  });
  assert.equal((afterReset as any).code, "unknown");
});

test("grant: the extension attaches only a live grant, never a bare owner", () => {
  const holder = createGrantHolder();
  assert.equal(holder.usable(), false);
  assert.equal(holder.attach({ requestId: "r1" }), undefined);

  const rejected = holder.accept({ version: BRIDGE_AUTH_VERSION, token: "" });
  assert.equal(rejected.ok, false);
  assert.equal(holder.current(), undefined);

  const accepted = holder.accept({
    version: BRIDGE_AUTH_VERSION,
    token: "grant-ok",
    ownerCommand: "orchestrator",
    sessionId: "session-a",
    epoch: EPOCH,
    issuedAt: Date.now() - 1_000,
    expiresAt: Date.now() + 60_000,
  });
  assert.equal(accepted.ok, true);
  const attached = holder.attach({ requestId: "r1" });
  assert.equal(attached?.token, "grant-ok");
  assert.equal(attached?.ownerCommand, "orchestrator");
  assert.equal(attached?.requestId, "r1");

  // Teardown forgets it: no stale grant survives a rebind.
  holder.clear();
  assert.equal(holder.attach({ requestId: "r2" }), undefined);
});
