/**
 * Orchestrator breakdown approval view tests.
 *
 * The approval dialog is the only UI path that can authorize a dispatch from a
 * normal session, so the answer matrix is fail-closed: only the exact approve
 * row approves, freeform text revises, and cancel/unknown dismisses.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import type { ExecutionPreview } from "./orchestrator-approval.ts";
import {
  BREAKDOWN_APPROVE_LABEL,
  BREAKDOWN_DENY_LABEL,
  breakdownApprovalDecisionFromResult,
  buildBreakdownApprovalQuestion,
} from "./orchestrator-approval-view.ts";

function preview(over: Partial<ExecutionPreview> = {}): ExecutionPreview {
  return {
    schemaVersion: 1,
    runId: "run-1",
    roadmapRevision: 1,
    roadmapDigest: "b".repeat(64),
    planDigest: "c".repeat(64),
    mapping: [{ requirementId: "1", taskIds: ["task-1"] }],
    tasks: [
      {
        taskId: "task-1",
        covers: ["1"],
        dependsOn: [],
        estimatedTokens: 1_000,
      },
    ],
    models: {
      orchestrator: { model: "p/orch", usableInput: 100_000, confidence: "high" },
      builder: { model: "p/build", usableInput: 80_000, confidence: "high" },
    },
    launcher: { ready: true, label: "Pi Desktop" },
    checks: ["npm test"],
    limits: {
      repairRounds: 2,
      noProgressLimit: 2,
      rolloverLimit: 2,
      launchFailureLimit: 3,
    },
    options: { commitMode: "never", mutationScope: [], baselineDirty: false },
    projectedTaskTokens: 1_000,
    warnings: [],
    blockedReasons: [],
    approvalDigest: "a".repeat(64),
    createdAt: 1,
    ...over,
  };
}

test("question shows the digest-bound preview and only approve/deny rows", () => {
  const question = buildBreakdownApprovalQuestion({
    preview: preview(),
    requirements: [{ roadmapStepId: "1", text: "Add the command" }],
    fromDiscussion: true,
  });
  assert.equal(question.header, "Execution approval");
  const context = question.context ?? "";
  assert.match(context, /Execution preview preview-aaaaaaaaaaaaaaaa/);
  assert.match(context, /Add the command/);
  assert.match(context, /execution approval dialog/);
  assert.doesNotMatch(context, /\/orchestrator approve/);
  assert.deepEqual(
    question.options?.map((option) => option.label),
    [BREAKDOWN_APPROVE_LABEL, BREAKDOWN_DENY_LABEL],
  );
});

test("only the exact approve row approves", () => {
  const result = {
    cancelled: false,
    answers: [
      { question: "q", answer: BREAKDOWN_APPROVE_LABEL, wasCustom: false },
    ],
  };
  assert.deepEqual(breakdownApprovalDecisionFromResult(result), {
    choice: "approve",
  });
});

test("freeform text is revision feedback, never approval", () => {
  const result = {
    cancelled: false,
    answers: [
      { question: "q", answer: "split task 2 and add tests", wasCustom: true },
    ],
  };
  assert.deepEqual(breakdownApprovalDecisionFromResult(result), {
    choice: "revise",
    feedback: "split task 2 and add tests",
  });
});

test("the deny row is an explicit durable denial", () => {
  const result = {
    cancelled: false,
    answers: [
      { question: "q", answer: BREAKDOWN_DENY_LABEL, wasCustom: false },
    ],
  };
  assert.deepEqual(breakdownApprovalDecisionFromResult(result), {
    choice: "deny",
  });
});

test("cancel, empty, malformed and unknown answers dismiss", () => {
  assert.deepEqual(breakdownApprovalDecisionFromResult(null), {
    choice: "dismiss",
  });
  assert.deepEqual(
    breakdownApprovalDecisionFromResult({ cancelled: true, answers: [] }),
    { choice: "dismiss" },
  );
  assert.deepEqual(
    breakdownApprovalDecisionFromResult({
      cancelled: false,
      answers: [{ question: "q", answer: "   ", wasCustom: true }],
    }),
    { choice: "dismiss" },
  );
  assert.deepEqual(
    breakdownApprovalDecisionFromResult({
      cancelled: false,
      answers: [{ question: "q", answer: "approve", wasCustom: false }],
    }),
    { choice: "dismiss" },
  );
  assert.deepEqual(
    breakdownApprovalDecisionFromResult({
      cancelled: false,
      answers: [{}],
    } as never),
    { choice: "dismiss" },
  );
});
