/**
 * Approval/start coordinator tests.
 *
 * These pin the user-facing contract: approve journals before dispatch, a failed
 * dispatch does not revoke approval, deny/revise invalidate durably, and a stale
 * dialog answer has no effect.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  applyBreakdownApprovalDecision,
  nextAttemptIdFor,
  startNextReadyTask,
  type ApprovalFlowPorts,
  type ApprovalFlowView,
} from "./orchestrator-approval-flow.ts";

const DIGEST = "a".repeat(64);
const APPROVAL_ID = `preview-${DIGEST.slice(0, 16)}`;

function view(over: Partial<ApprovalFlowView> = {}): ApprovalFlowView {
  return {
    runId: "run-1",
    preview: { approvalDigest: DIGEST },
    nextTaskId: "task-1",
    state: {
      tasks: {
        "task-1": { attempts: [] },
      },
    },
    ...over,
  };
}

function ports(over: Partial<ApprovalFlowPorts> = {}): ApprovalFlowPorts {
  return {
    view: () => view(),
    approve: async () => ({ ok: true }),
    refine: async () => ({ ok: true }),
    canDispatch: () => ({ ok: true, reasons: [] }),
    dispatch: async () => ({ ok: true, text: "Dispatched task-1." }),
    ...over,
  };
}

test("approve journals first and dispatches the next ready task", async () => {
  const calls: string[] = [];
  const p = ports({
    approve: async (input) => {
      calls.push(`approve:${input.confirmation}:${input.approvalId}`);
      return { ok: true };
    },
    dispatch: async (input) => {
      calls.push(`dispatch:${input.taskId}:${input.attemptId}`);
      return { ok: true, text: `Dispatched ${input.taskId}.` };
    },
  });
  const result = await applyBreakdownApprovalDecision({
    decision: { choice: "approve" },
    expected: { runId: "run-1", approvalDigest: DIGEST },
    ports: p,
  });
  assert.equal(result.ok, true);
  assert.equal(result.status, "approved");
  assert.match(result.text, new RegExp(`Execution approved \\(${APPROVAL_ID}\\)`));
  assert.match(result.text, /Dispatched task-1/);
  assert.deepEqual(calls, [
    `approve:approve-execution:${APPROVAL_ID}`,
    "dispatch:task-1:attempt-1-1",
  ]);
});

test("a failed dispatch keeps the approval and reports the real blocker", async () => {
  const result = await applyBreakdownApprovalDecision({
    decision: { choice: "approve" },
    expected: { runId: "run-1", approvalDigest: DIGEST },
    ports: ports({
      dispatch: async () => ({
        ok: false,
        text: "The child session could not be prepared: no host.",
      }),
    }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, "approved");
  assert.match(result.text, /The approval remains valid/);
  assert.match(result.text, /no host/);
});

test("approval without a ready task does not claim a launch", async () => {
  const result = await applyBreakdownApprovalDecision({
    decision: { choice: "approve" },
    expected: { runId: "run-1", approvalDigest: DIGEST },
    ports: ports({
      view: () => view({ nextTaskId: undefined }),
    }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.status, "approved");
  assert.match(result.text, /no dependency-ready task/);
});

test("freeform feedback invalidates durably and asks for a revision", async () => {
  const refinements: string[] = [];
  const result = await applyBreakdownApprovalDecision({
    decision: { choice: "revise", feedback: "split task 1" },
    expected: { runId: "run-1", approvalDigest: DIGEST },
    ports: ports({
      refine: async (reason) => {
        refinements.push(reason);
        return { ok: true };
      },
      dispatch: async () => {
        throw new Error("must not dispatch on revise");
      },
    }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.status, "revised");
  assert.match(result.text, /split task 1/);
  assert.match(result.text, /invalidated durably/);
  assert.deepEqual(refinements, ["user feedback on the breakdown: split task 1"]);
});

test("deny invalidates durably and stays in Orchestrator", async () => {
  const refinements: string[] = [];
  const result = await applyBreakdownApprovalDecision({
    decision: { choice: "deny" },
    expected: { runId: "run-1", approvalDigest: DIGEST },
    ports: ports({
      refine: async (reason) => {
        refinements.push(reason);
        return { ok: true };
      },
    }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.status, "denied");
  assert.match(result.text, /Stay in Orchestrator mode/);
  assert.deepEqual(refinements, ["the user denied the proposed breakdown"]);
});

test("dismiss and a stale preview have no runtime effect", async () => {
  let effects = 0;
  const p = ports({
    approve: async () => {
      effects += 1;
      return { ok: true };
    },
    refine: async () => {
      effects += 1;
      return { ok: true };
    },
    dispatch: async () => {
      effects += 1;
      return { ok: true, text: "unexpected" };
    },
  });
  const dismissed = await applyBreakdownApprovalDecision({
    decision: { choice: "dismiss" },
    expected: { runId: "run-1", approvalDigest: DIGEST },
    ports: p,
  });
  assert.equal(dismissed.status, "dismissed");
  const stale = await applyBreakdownApprovalDecision({
    decision: { choice: "approve" },
    expected: { runId: "run-1", approvalDigest: "b".repeat(64) },
    ports: p,
  });
  assert.equal(stale.ok, false);
  assert.equal(stale.status, "stale");
  assert.equal(effects, 0);
});

test("startNextReadyTask refuses before approval and when already running", async () => {
  const notApproved = await startNextReadyTask(
    ports({ canDispatch: () => ({ ok: false, reasons: ["no execution approval exists"] }) }),
  );
  assert.equal(notApproved.ok, false);
  assert.equal(notApproved.code, "approval");

  const running = await startNextReadyTask(
    ports({ view: () => view({ state: { mutation: {}, tasks: {} } }) }),
  );
  assert.equal(running.ok, false);
  assert.equal(running.code, "busy");
});

test("attempt ids are stable, collision-free and fit the tool grammar", () => {
  assert.equal(nextAttemptIdFor("task-1", []), "attempt-1-1");
  assert.equal(
    nextAttemptIdFor("task-1", [{ attemptId: "attempt-1-1" }]),
    "attempt-1-2",
  );
  assert.equal(
    nextAttemptIdFor("task-1", [
      { attemptId: "attempt-1-1" },
      { attemptId: "attempt-1-2" },
    ]),
    "attempt-1-3",
  );
  const long = nextAttemptIdFor(`task-${"x".repeat(200)}`, []);
  assert.ok(long.length <= 96);
  assert.match(long, /^attempt-[A-Za-z0-9._-]{1,96}$/);
});
