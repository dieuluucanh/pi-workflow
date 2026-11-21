/**
 * Local worker control protocol tests (step 23): authenticated bounded
 * envelopes, stale/reordered/duplicate rejection, mutation only for a verified
 * start/repair, and durable idempotent receipts (one kickoff per task start).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  MAX_MESSAGE_BYTES,
  authorizesMutation,
  createControlSecret,
  createOutbox,
  emptyReceipts,
  endpointDirIsPrivate,
  localEndpoint,
  openMessage,
  sealMessage,
  type ControlEnvelope,
  type ReceiptIo,
  type ReceiptState,
  type ValidationContext,
} from "./orchestrator-ipc.ts";

const secret = createControlSecret();
const identity = {
  runId: "run-1",
  taskId: "task-1",
  attemptId: "attempt-1",
  sessionId: "session-1",
  generation: 2,
  leaseGeneration: 7,
};

function make(over: Partial<Omit<ControlEnvelope, "auth">> = {}) {
  const sealed = sealMessage({
    secret,
    message: {
      version: 1,
      messageId: "m-1",
      seq: 1,
      type: "start",
      ...identity,
      taskStartId: "start-1",
      sentAt: 1,
      payload: { assignment: "packet" },
      ...over,
    },
  });
  assert.equal(sealed.ok, true, sealed.ok ? "" : sealed.error);
  return (sealed as { ok: true; value: ControlEnvelope }).value;
}

function ctx(over: Partial<ValidationContext> = {}): ValidationContext {
  return { secret, ...identity, expectedTaskStartId: "start-1", ...over };
}

test("a sealed message opens with matching identity and MAC", () => {
  const opened = openMessage(JSON.stringify(make()), ctx());
  assert.equal(opened.ok, true, opened.ok ? "" : opened.error);
  const message = (opened as { ok: true; value: ControlEnvelope }).value;
  assert.equal(message.type, "start");
  assert.equal(authorizesMutation(message, ctx()), true);
});

test("forged, tampered, wrong-version and oversized messages fail closed", () => {
  const good = make();
  const tampered = { ...good, payload: { assignment: "evil" } };
  assert.equal((openMessage(tampered, ctx()) as any).code, "auth");
  assert.equal(
    (openMessage(JSON.stringify({ ...good, version: 99 }), ctx()) as any).code,
    "version",
  );
  assert.equal(
    (openMessage("x".repeat(MAX_MESSAGE_BYTES + 1), ctx()) as any).code,
    "oversized",
  );
  const unknown = { ...good, type: "accept" };
  assert.equal((openMessage(unknown, ctx()) as any).code, "unsupported");
});

test("identity, generation, lease and ordering are enforced", () => {
  const message = make();
  assert.equal((openMessage(message, ctx({ runId: "run-2" })) as any).code, "mismatch");
  assert.equal((openMessage(message, ctx({ sessionId: "session-2" })) as any).code, "mismatch");
  assert.equal((openMessage(message, ctx({ generation: 3 })) as any).code, "stale");
  assert.equal((openMessage(message, ctx({ generation: 1 })) as any).code, "reordered");
  assert.equal((openMessage(message, ctx({ leaseGeneration: 8 })) as any).code, "stale");
  assert.equal((openMessage(message, ctx({ lastSeq: 1 })) as any).code, "reordered");
  assert.equal(
    (openMessage(message, ctx({ seenMessageIds: new Set(["m-1"]) })) as any).code,
    "duplicate",
  );
});

test("only a verified start/repair at the current lease authorizes mutation", () => {
  const start = make();
  assert.equal(authorizesMutation(start, { leaseGeneration: 7, expectedTaskStartId: "start-1" }), true);
  assert.equal(authorizesMutation(start, { leaseGeneration: 8, expectedTaskStartId: "start-1" }), false);
  assert.equal(authorizesMutation(start, { leaseGeneration: 7, expectedTaskStartId: "other" }), false);

  const candidate = make({ type: "candidate", messageId: "m-2", seq: 2 });
  assert.equal(authorizesMutation(candidate, { leaseGeneration: 7, expectedTaskStartId: "start-1" }), false);
  assert.equal(
    (openMessage(make({ type: "start-ack" }), ctx()) as any).ok,
    true,
    "bound start-ack opens",
  );
  assert.equal(
    (openMessage(make({ type: "start-ack" }), ctx({ expectedTaskStartId: "other" })) as any).code,
    "mismatch",
  );
});

test("receipts are durable and idempotent; one start cannot launch twice", async () => {
  const store = new Map<string, ReceiptState>();
  const io: ReceiptIo = {
    async load(runId) {
      return store.get(runId) ?? null;
    },
    async save(runId, state) {
      store.set(runId, JSON.parse(JSON.stringify(state)));
    },
  };
  const outbox = await createOutbox({ runId: "run-1", io });
  const start = make();
  assert.deepEqual(outbox.enqueue(start), { ok: true, duplicate: false });
  assert.deepEqual(outbox.enqueue(start), { ok: true, duplicate: true });
  // A different message id claiming the same start is refused.
  const second = make({ messageId: "m-2", seq: 2 });
  assert.equal(outbox.enqueue(second).ok, false);

  const sent: string[] = [];
  const first = await outbox.flush(async (raw) => {
    sent.push(raw);
  });
  assert.deepEqual(first, { sent: 1, failed: 0 });
  assert.equal(outbox.state().entries["m-1"]!.status, "delivered");

  assert.equal(await outbox.ack("m-1"), true);
  const afterAck = await outbox.flush(async (raw) => {
    sent.push(raw);
  });
  assert.deepEqual(afterAck, { sent: 0, failed: 0 });
  assert.equal(sent.length, 1);

  // Reload from the store: the ack survives and nothing is re-sent.
  const reloaded = await createOutbox({ runId: "run-1", io });
  assert.equal(reloaded.state().entries["m-1"]!.status, "acked");
  assert.equal(reloaded.state().starts["start-1"], "m-1");

  // A failed send stays pending (no false ack).
  const third = make({ messageId: "m-3", seq: 3, taskStartId: "start-2" });
  reloaded.enqueue(third);
  const failed = await reloaded.flush(async () => {
    throw new Error("ipc unavailable");
  });
  assert.deepEqual(failed, { sent: 0, failed: 1 });
  assert.equal(reloaded.state().entries["m-3"]!.status, "pending");
});

test("outbox is bounded and empty receipt state is versioned", async () => {
  const io: ReceiptIo = {
    async load() {
      return null;
    },
    async save() {},
  };
  const outbox = await createOutbox({ runId: "run-1", io, max: 1 });
  assert.equal(outbox.enqueue(make()).ok, true);
  assert.equal(outbox.enqueue(make({ messageId: "m-2", seq: 2, taskStartId: "start-2" })).ok, false);
  assert.equal(emptyReceipts().version, 1);
});

test("local endpoints are named pipes/sockets in a private profile directory", () => {
  const win = localEndpoint({ platform: "win32", profileDir: "C:/profile", runId: "run-1" });
  assert.equal((win as any).value.path, "\\\\.\\pipe\\pi-workflow-run-1");
  const unix = localEndpoint({ platform: "linux", profileDir: "/home/u/.pi", runId: "run-1" });
  assert.equal((unix as any).value.path, "/home/u/.pi/workflow/ipc/run-1.sock");
  assert.equal((localEndpoint({ platform: "linux", profileDir: "/p", runId: "../evil" }) as any).ok, false);
  assert.equal(endpointDirIsPrivate({ mode: 0o700 }), true);
  assert.equal(endpointDirIsPrivate({ mode: 0o755 }), false);
  assert.equal(endpointDirIsPrivate(null), false);
});
