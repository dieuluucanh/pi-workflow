/**
 * Execution preview view (plan step 9).
 *
 * The preview is what the human approves. These tests pin the parts that make
 * that approval meaningful: the derived scope is shown, a blocked host is not
 * hidden, and the approval command names an ID derived from the digest.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import type { ExecutionPreview } from "./orchestrator-approval.ts";
import {
  formatExecutionPreview,
  matchesPreviewId,
  previewApprovalId,
} from "./orchestrator-preview-view.ts";

const DIGEST = "a".repeat(64);

function preview(over: Partial<ExecutionPreview> = {}): ExecutionPreview {
  return {
    schemaVersion: 1,
    runId: "run-1",
    roadmapRevision: 3,
    roadmapDigest: "b".repeat(64),
    planDigest: "c".repeat(64),
    mapping: [
      { requirementId: "1", taskIds: ["task-1"] },
      { requirementId: "2", taskIds: ["task-2"] },
    ],
    tasks: [
      { taskId: "task-1", covers: ["1"], dependsOn: [], estimatedTokens: 1_000 },
      { taskId: "task-2", covers: ["2"], dependsOn: ["task-1"], estimatedTokens: 2_000 },
    ],
    models: {
      orchestrator: { model: "orch-model", usableInput: 100_000, confidence: "high" },
      builder: { model: "build-model", usableInput: 80_000, confidence: "medium" },
    },
    launcher: { ready: true, label: "Pi Desktop" },
    checks: ["npm test"],
    limits: {
      repairRounds: 2,
      noProgressLimit: 2,
      rolloverLimit: 2,
      launchFailureLimit: 3,
    },
    options: { commitMode: "never", mutationScope: ["src/**"], baselineDirty: false },
    projectedTaskTokens: 3_000,
    warnings: [],
    blockedReasons: [],
    approvalDigest: DIGEST,
    createdAt: 1_760_000_000_000,
    ...over,
  };
}

test("preview id is derived from the approval digest and matched exactly", () => {
  const p = preview();
  assert.equal(previewApprovalId(p), `preview-${"a".repeat(16)}`);
  assert.equal(matchesPreviewId(p, `preview-${"a".repeat(16)}`), true);
  assert.equal(matchesPreviewId(p, DIGEST), true);
  assert.equal(matchesPreviewId(p, "a".repeat(8)), true);
  assert.equal(matchesPreviewId(p, "approve-execution"), false);
  assert.equal(matchesPreviewId(p, `preview-${"b".repeat(16)}`), false);
  assert.equal(matchesPreviewId(p, ""), false);
});

test("preview renders the derived requirement text, grouping and models", () => {
  const text = formatExecutionPreview({
    preview: preview(),
    requirements: [
      { roadmapStepId: "1", label: "Step", text: "Add the CLI command" },
      { roadmapStepId: "2", text: "Add tests" },
    ],
    fromDiscussion: true,
  });
  assert.match(text, /Execution preview preview-aaaaaaaaaaaaaaaa/);
  assert.match(text, /current discussion/);
  assert.match(text, /Add the CLI command/);
  assert.match(text, /Add tests/);
  assert.match(text, /task-2: covers 2 · depends on task-1/);
  assert.match(text, /Models: orchestrator orch-model/);
  assert.match(text, /Commit: never/);
  assert.match(text, /Approve with: \/orchestrator approve preview-aaaaaaaaaaaaaaaa/);
});

test("dialog approval hides the command and points at the host dialog", () => {
  const text = formatExecutionPreview({
    preview: preview(),
    approvalHint: "dialog",
  });
  assert.doesNotMatch(text, /\/orchestrator approve/);
  assert.doesNotMatch(text, /\/orchestrator refine/);
  assert.match(text, /execution approval dialog/);
});

test("none approval hint leaves the outcome to the caller", () => {
  const text = formatExecutionPreview({
    preview: preview(),
    approvalHint: "none",
  });
  assert.doesNotMatch(text, /\/orchestrator approve/);
  assert.doesNotMatch(text, /\/orchestrator refine/);
  assert.doesNotMatch(text, /execution approval dialog/);
});

test("a blocked breakdown shows the blocker and no approval command", () => {
  const text = formatExecutionPreview({
    preview: preview({
      launcher: { ready: false, label: "Terminal", reason: "no launcher binary" },
      blockedReasons: ["the builder model has no headroom"],
    }),
  });
  assert.match(text, /Terminal NOT READY \(no launcher binary\)/);
  assert.match(text, /Blocker: the builder model has no headroom/);
  assert.match(text, /cannot be dispatched yet/);
  assert.doesNotMatch(text, /Approve with:/);
});

test("uncovered requirements are explicit, never silently dropped", () => {
  const text = formatExecutionPreview({
    preview: preview({
      mapping: [
        { requirementId: "1", taskIds: ["task-1"] },
        { requirementId: "2", taskIds: [] },
      ],
    }),
    requirements: [
      { roadmapStepId: "1", text: "covered" },
      { roadmapStepId: "2", text: "not covered" },
    ],
  });
  assert.match(text, /2 not covered → UNCOVERED/);
  assert.match(text, /Uncovered: 2/);
});

test("the preview text is bounded even for a huge roadmap", () => {
  const mapping = Array.from({ length: 200 }, (_, index) => ({
    requirementId: String(index + 1),
    taskIds: [`task-${index + 1}`],
  }));
  const text = formatExecutionPreview({
    preview: preview({ mapping, tasks: [] }),
    requirements: mapping.map((entry) => ({
      roadmapStepId: entry.requirementId,
      text: "x".repeat(20),
    })),
  });
  assert.ok(text.length <= 6_000);
  assert.match(text, /more requirement\(s\)/);
});
