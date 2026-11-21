/**
 * Execution preview/approval tests (step 20). The three decisions stay
 * distinct; approval requires an explicit confirmation; and a restart can
 * revalidate by rebuilding the preview because every material input is digested.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  APPROVAL_CONFIRMATION,
  approveExecution,
  buildExecutionPreview,
  modeEntryDecision,
  ordinaryHandoffAction,
  orchestrateApprovedPlanAction,
  revalidateApproval,
  type ExecutionPreview,
} from "./orchestrator-approval.ts";
import { resolveBudget } from "./orchestrator-budget.ts";
import type { RoadmapSnapshot } from "./orchestrator-plan.ts";
import type { PlannedTask, TaskPlan } from "./orchestrator-types.ts";

function budget(role: "orchestrator" | "builder", window: number) {
  const result = resolveBudget({
    role,
    model: { provider: "p", id: `${role}-m`, contextWindow: window, maxOutputTokens: null },
  });
  assert.equal(result.ok, true);
  return (result as { ok: true; plan: any }).plan;
}

const builderBudget = budget("builder", 131_072);
const orchestratorBudget = budget("orchestrator", 1_048_576);

function snapshot(digest = "a".repeat(64)): RoadmapSnapshot {
  return {
    schemaVersion: 1,
    sourcePath: "C:/docs/roadmap.md",
    digest,
    title: "Roadmap",
    requirements: [
      {
        roadmapStepId: "rm-1",
        label: "1",
        text: "First requirement",
        phasePath: [],
        claimedComplete: false,
        completionVerified: false as const,
      },
      {
        roadmapStepId: "rm-2",
        label: "2",
        text: "Second requirement",
        phasePath: [],
        claimedComplete: false,
        completionVerified: false as const,
      },
    ],
    phases: [],
    lineCount: 2,
    createdAt: 1,
  };
}

function task(id: string, covers: string[]): PlannedTask {
  return {
    taskId: `task-${id}`,
    covers,
    objective: `Implement ${covers.join(" and ")} in the approved roadmap`,
    nonGoals: [],
    dependsOn: [],
    expectedFiles: ["src/x.ts"],
    acceptanceChecks: ["tests pass"],
    sizeRationale: "one unit",
  };
}

function plan(tasks: PlannedTask[] = [task("1", ["rm-1"]), task("2", ["rm-2"])]): TaskPlan {
  return { schemaVersion: 1, runId: "run-1", roadmapRevision: 1, tasks };
}

function preview(
  over: Partial<Parameters<typeof buildExecutionPreview>[0]> = {},
): ExecutionPreview {
  const result = buildExecutionPreview({
    runId: "run-1",
    roadmap: snapshot(),
    plan: plan(),
    orchestratorBudget,
    builderBudget,
    launcher: { ready: true, label: "Windows Terminal" },
    checks: ["tests pass"],
    limits: {
      repairRounds: 2,
      noProgressLimit: 2,
      rolloverLimit: 2,
      launchFailureLimit: 3,
      costLimitUsd: null,
    },
    options: { commitMode: "ask", mutationScope: ["src/**"], baselineDirty: false },
    now: 1,
    ...over,
  });
  assert.equal(result.ok, true, result.ok ? "" : result.error);
  return (result as { ok: true; preview: ExecutionPreview }).preview;
}

test("preview maps requirements, estimates and limits, and is approvable", () => {
  const value = preview();
  assert.deepEqual(
    value.mapping.map((entry) => entry.taskIds),
    [["task-1"], ["task-2"]],
  );
  assert.equal(value.tasks.length, 2);
  assert.ok(value.projectedTaskTokens > 0);
  assert.equal(value.limits.repairRounds, 2);
  assert.equal(value.options.commitMode, "ask");
  assert.match(value.warnings.join(" "), /cost limit is unknown/);
  assert.match(value.approvalDigest, /^[a-f0-9]{64}$/);

  const approved = approveExecution(value, {
    confirmation: APPROVAL_CONFIRMATION,
    approvalId: "approval-1",
    now: 2,
  });
  assert.equal(approved.ok, true);
  const record = (approved as { ok: true; record: any }).record;
  assert.equal(record.approvalDigest, value.approvalDigest);
  assert.equal(record.planDigest, value.planDigest);
});

test("a blocked preview cannot be approved", () => {
  const blocked = preview({
    launcher: { ready: false, label: "Windows Terminal", reason: "wt.exe was not found" },
  });
  assert.match(blocked.blockedReasons.join(" "), /wt\.exe/);
  const result = approveExecution(blocked, {
    confirmation: APPROVAL_CONFIRMATION,
    approvalId: "approval-1",
    now: 2,
  });
  assert.equal(result.ok, false);
  assert.equal((result as { code: string }).code, "blocked");

  const uncovered = preview({ plan: plan([task("1", ["rm-1"])]) });
  assert.match(uncovered.blockedReasons.join(" "), /rm-2/);
});

test("approval requires the explicit confirmation and an id", () => {
  const value = preview();
  const wrong = approveExecution(value, { confirmation: "yes", approvalId: "a", now: 2 });
  assert.equal((wrong as { code: string }).code, "confirmation");
  const noId = approveExecution(value, {
    confirmation: APPROVAL_CONFIRMATION,
    approvalId: "",
    now: 2,
  });
  assert.equal((noId as { code: string }).code, "invalid");
});

test("restart rebuilds the same digest; a material change requires a new approval", () => {
  const value = preview();
  const record = (
    approveExecution(value, {
      confirmation: APPROVAL_CONFIRMATION,
      approvalId: "approval-1",
      now: 2,
    }) as { ok: true; record: any }
  ).record;

  const rebuilt = preview();
  assert.deepEqual(revalidateApproval(record, rebuilt), { ok: true });

  const limitsChanged = preview({ limits: { ...value.limits, repairRounds: 3 } });
  const limitsResult = revalidateApproval(record, limitsChanged);
  assert.equal(limitsResult.ok, false);
  assert.match(
    (limitsResult as { reasons: string[] }).reasons.join(" "),
    /scope, limits, launcher or commit/,
  );

  const roadmapChanged = preview({ roadmap: snapshot("b".repeat(64)) });
  assert.match(
    (revalidateApproval(record, roadmapChanged) as { reasons: string[] }).reasons.join(" "),
    /roadmap changed/,
  );

  const planChanged = preview({ plan: plan([task("1", ["rm-1"]), task("2", ["rm-2"])]) });
  assert.equal(revalidateApproval(record, planChanged).ok, true);
});

test("mode entry, plan approval and execution approval are distinct decisions", () => {
  const mode = modeEntryDecision("run-1");
  const handoff = ordinaryHandoffAction();
  const orchestrate = orchestrateApprovedPlanAction(null);
  assert.notEqual(mode.kind, handoff.kind);
  assert.notEqual(handoff.kind, orchestrate.kind);
  assert.equal(mode.launchesWork, false);
  assert.equal(handoff.startsExecution, false);
  assert.equal(orchestrate.startsExecution, true);
  assert.equal(orchestrate.requiresExecutionApproval, true);
  assert.equal(orchestrate.approved, false);
  assert.notEqual(handoff.action, orchestrate.action);

  const value = preview();
  const record = approveExecution(value, {
    confirmation: APPROVAL_CONFIRMATION,
    approvalId: "approval-1",
    now: 2,
  });
  const approved = orchestrateApprovedPlanAction(
    (record as { ok: true; record: any }).record,
  );
  assert.equal(approved.approved, true);
});
