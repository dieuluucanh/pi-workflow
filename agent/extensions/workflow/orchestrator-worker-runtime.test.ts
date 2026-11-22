/**
 * Managed worker runtime tests (plan step 13).
 *
 * The order under test: preflight → acknowledge → parent grant → start ack.
 * An acknowledged-but-ungranted worker is the state a resumed transcript or an
 * unapproved dispatch is in, and it must never be able to mutate.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { createWorkerRuntime, evaluateWorkerPreflight } from "./orchestrator-worker-runtime.ts";
import type { ManagedSessionContext } from "./managed-session.ts";

const CONTEXT: ManagedSessionContext = {
  version: 1,
  runId: "run-1",
  taskId: "task-1",
  attemptId: "attempt-1",
  parentSessionRef: "parent-1",
  relation: "child",
  mode: "build",
  mayOrchestrate: false,
};

function runtime(over: {
  model?: { provider: string; id: string } | null;
  activeTools?: string[];
  assignmentPresent?: boolean;
} = {}) {
  return createWorkerRuntime({
    context: CONTEXT,
    sessionId: "session-1",
    now: () => 1_000,
    preflightInput: () => ({
      model: over.model === undefined ? { provider: "p", id: "builder" } : over.model,
      activeTools: over.activeTools ?? ["read", "edit", "write", "bash"],
      requiredTools: ["read", "edit", "bash"],
      assignmentPresent: over.assignmentPresent ?? true,
    }),
  });
}

test("preflight: a missing model, tool or assignment blocks acknowledgement", () => {
  assert.deepEqual(
    evaluateWorkerPreflight({
      model: null,
      activeTools: ["read"],
      requiredTools: ["read", "edit"],
      assignmentPresent: false,
    }),
    { ok: false, missing: ["assignment metadata", "builder model", "tool edit"] },
  );
  assert.deepEqual(
    evaluateWorkerPreflight({
      model: { provider: "p", id: "b" },
      activeTools: ["read", "edit"],
      requiredTools: ["read"],
      assignmentPresent: true,
    }),
    { ok: true, missing: [] },
  );

  const blocked = runtime({ model: null });
  const ack = blocked.acknowledge();
  assert.equal(ack.ok, false);
  assert.equal((ack as any).code, "preflight");
  assert.deepEqual((ack as any).missing, ["builder model"]);
  assert.equal(blocked.gate.phase(), "pending_ready", "a failed preflight changes nothing");
});

test("acknowledgement opens reading but not mutation", () => {
  const worker = runtime();
  assert.equal(worker.acknowledge().ok, true);
  assert.equal(worker.gate.phase(), "ready");
  assert.equal(worker.gate.canMutate(), false);
  assert.match(worker.gate.mutationBlockReason("edit") ?? "", /not authorized yet/);

  // Idempotent acknowledgement is reported, not silently repeated.
  const again = worker.acknowledge();
  assert.equal(again.ok, false);
  assert.equal((again as any).code, "already");
});

test("only a parent grant opens mutation, and the start id must match", () => {
  const worker = runtime();
  assert.equal(worker.acknowledge().ok, true);

  const premature = worker.authorize({ leaseGeneration: 1, taskStartId: "start-x" });
  assert.equal(premature.ok, true, "the grant is accepted once ready");

  const wrongAck = worker.noteStartAck("start-other");
  assert.equal(wrongAck.ok, false);
  assert.equal((wrongAck as any).code, "mismatch");

  assert.equal(worker.noteStartAck("start-x").ok, true);
  assert.equal(worker.running(), true);
  assert.equal(worker.gate.canMutate(), true);

  // A second ack for the same attempt is refused.
  const duplicate = worker.noteStartAck("start-x");
  assert.equal(duplicate.ok, false);
  assert.equal((duplicate as any).code, "already");
});

test("a grant before acknowledgement is refused, never queued", () => {
  const worker = runtime();
  const early = worker.authorize({ leaseGeneration: 1, taskStartId: "start-x" });
  assert.equal(early.ok, false);
  assert.equal((early as any).code, "not_ready");
  assert.equal(worker.gate.canMutate(), false);
});

test("fencing stops mutation and a repair needs a fresh grant", () => {
  const worker = runtime();
  assert.equal(worker.acknowledge().ok, true);
  assert.equal(worker.authorize({ leaseGeneration: 1, taskStartId: "start-x" }).ok, true);
  assert.equal(worker.noteStartAck("start-x").ok, true);
  assert.equal(worker.gate.canMutate(), true);

  worker.fence();
  assert.equal(worker.running(), false);
  assert.equal(worker.fenced(), true);
  assert.equal(worker.gate.mutationBlockReason("edit") !== undefined, true);

  // A fenced worker refuses even a matching grant until the parent resumes it.
  const afterFence = worker.authorize({ leaseGeneration: 2, taskStartId: "start-x" });
  assert.equal(afterFence.ok, false);
  assert.equal((afterFence as any).code, "closed");
});

test("closing the worker refuses further acknowledgement, grants and mutation", () => {
  const worker = runtime();
  assert.equal(worker.acknowledge().ok, true);
  worker.close();
  assert.equal(worker.gate.phase(), "closed");
  assert.equal(worker.gate.canMutate(), false);
  assert.equal(worker.acknowledge().ok, false);
  const grant = worker.authorize({ leaseGeneration: 3, taskStartId: "start-x" });
  assert.equal(grant.ok, false);
});
