/**
 * Workflow Extension — execution preview and approval (step 20).
 *
 * Three decisions stay distinct:
 *   1. entering Orchestrator mode (no work started);
 *   2. approving the ordinary Plan → Build handoff (unchanged);
 *   3. approving THIS execution breakdown (roadmap → tasks → limits → commit).
 *
 * Only an explicit execution approval may dispatch the first child. The record
 * stores digests of the roadmap, task plan and execution options, so a restart
 * can revalidate by rebuilding the preview: any material change (scope,
 * criteria, dependencies, limits, launcher, commit/mutation behavior) yields a
 * different digest and requires a new approval.
 */

import { createHash } from "node:crypto";

import { estimateTextTokens, type BudgetPlan } from "./orchestrator-budget.ts";
import type { RoadmapSnapshot } from "./orchestrator-plan.ts";
import type { TaskPlan } from "./orchestrator-types.ts";

export const APPROVAL_SCHEMA_VERSION = 1 as const;
export const APPROVAL_CONFIRMATION = "approve-execution" as const;
export const DEFAULT_TASK_OVERHEAD_TOKENS = 500;

export type CommitMode = "never" | "ask" | "allow";

export interface ExecutionLimits {
  repairRounds: number;
  noProgressLimit: number;
  rolloverLimit: number;
  launchFailureLimit: number;
  /** null/undefined = unknown, never treated as zero. */
  costLimitUsd?: number | null;
  activeTimeMinutes?: number | null;
}

export interface ExecutionOptions {
  commitMode: CommitMode;
  /** Globs/paths the parent intends the child to change. */
  mutationScope: readonly string[];
  baselineDirty: boolean;
}

export interface LauncherReadiness {
  ready: boolean;
  label: string;
  reason?: string;
}

export interface ExecutionPreviewInput {
  runId: string;
  roadmap: RoadmapSnapshot;
  plan: TaskPlan;
  orchestratorBudget: BudgetPlan;
  builderBudget: BudgetPlan;
  launcher: LauncherReadiness;
  checks: readonly string[];
  limits: ExecutionLimits;
  options: ExecutionOptions;
  /** Requirements already accepted by the parent (covered, not outstanding). */
  acceptedCovers?: Readonly<Record<string, readonly string[]>>;
  now: number;
}

export interface TaskEstimate {
  taskId: string;
  covers: readonly string[];
  dependsOn: readonly string[];
  estimatedTokens: number;
}

export interface ExecutionPreview {
  schemaVersion: typeof APPROVAL_SCHEMA_VERSION;
  runId: string;
  roadmapRevision: number;
  roadmapDigest: string;
  planDigest: string;
  /** Requirement → task ids, including uncovered outstanding requirements. */
  mapping: Array<{ requirementId: string; taskIds: string[] }>;
  tasks: TaskEstimate[];
  models: {
    orchestrator: { model: string; usableInput: number; confidence: string };
    builder: { model: string; usableInput: number; confidence: string };
  };
  launcher: LauncherReadiness;
  checks: readonly string[];
  limits: ExecutionLimits;
  options: ExecutionOptions;
  projectedTaskTokens: number;
  warnings: string[];
  blockedReasons: string[];
  /** Digest over every material input; approval and restart revalidation use it. */
  approvalDigest: string;
  createdAt: number;
}

export type PreviewResult =
  | { ok: true; preview: ExecutionPreview }
  | { ok: false; error: string };

export interface ExecutionApprovalRecord {
  schemaVersion: typeof APPROVAL_SCHEMA_VERSION;
  runId: string;
  approvalId: string;
  approvalDigest: string;
  planDigest: string;
  roadmapDigest: string;
  approvedAt: number;
}

export type ApprovalResult =
  | { ok: true; record: ExecutionApprovalRecord }
  | { ok: false; code: "blocked" | "confirmation" | "invalid"; error: string };

export type RevalidationResult =
  | { ok: true }
  | { ok: false; code: "approval_required"; reasons: string[] };

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
}

function sha256(value: unknown): string {
  return createHash("sha256").update(canonical(value), "utf8").digest("hex");
}

interface ApprovalMaterial {
  runId: string;
  roadmapRevision: number;
  roadmapDigest: string;
  planDigest: string;
  mapping: ExecutionPreview["mapping"];
  tasks: ExecutionPreview["tasks"];
  models: ExecutionPreview["models"];
  launcher: ExecutionPreview["launcher"];
  checks: ExecutionPreview["checks"];
  limits: ExecutionPreview["limits"];
  options: ExecutionPreview["options"];
  projectedTaskTokens: number;
}

/** Material inputs only: no timestamps, no display warnings. */
function approvalInput(
  preview: Omit<ExecutionPreview, "approvalDigest" | "createdAt">,
): ApprovalMaterial {
  return {
    runId: preview.runId,
    roadmapRevision: preview.roadmapRevision,
    roadmapDigest: preview.roadmapDigest,
    planDigest: preview.planDigest,
    mapping: preview.mapping,
    tasks: preview.tasks,
    models: preview.models,
    launcher: preview.launcher,
    checks: preview.checks,
    limits: preview.limits,
    options: preview.options,
    projectedTaskTokens: preview.projectedTaskTokens,
  };
}

function modelLabel(model: { provider?: string; id: string }): string {
  return model.provider ? `${model.provider}/${model.id}` : model.id;
}

/**
 * Builds the preview the user approves. Invalid identity fails; everything else
 * is presented with explicit `blockedReasons` so approval can refuse cleanly.
 */
export function buildExecutionPreview(input: ExecutionPreviewInput): PreviewResult {
  if (!input.runId || input.plan.runId !== input.runId) {
    return { ok: false, error: "the plan belongs to a different run" };
  }
  const accepted = new Set(
    Object.values(input.acceptedCovers ?? {}).flatMap((covers) => [...covers]),
  );
  const coverage = new Map<string, string[]>();
  for (const task of input.plan.tasks) {
    for (const requirementId of task.covers) {
      coverage.set(requirementId, [...(coverage.get(requirementId) ?? []), task.taskId]);
    }
  }
  const mapping = input.roadmap.requirements.map((requirement) => ({
    requirementId: requirement.roadmapStepId,
    taskIds: coverage.get(requirement.roadmapStepId) ?? [],
  }));

  const warnings: string[] = [];
  const blockedReasons: string[] = [];
  for (const requirement of input.roadmap.requirements) {
    if (accepted.has(requirement.roadmapStepId)) continue;
    if ((coverage.get(requirement.roadmapStepId) ?? []).length === 0) {
      blockedReasons.push(`requirement ${requirement.roadmapStepId} has no task`);
    }
  }
  if (!input.launcher.ready) {
    blockedReasons.push(input.launcher.reason ?? `${input.launcher.label} is not ready`);
  }
  if (input.plan.tasks.length === 0) blockedReasons.push("the breakdown has no tasks");
  if (input.checks.length === 0) warnings.push("no acceptance checks are listed");
  if (input.orchestratorBudget.confidence !== "high") {
    warnings.push("orchestrator model limits are estimated with low/medium confidence");
  }
  if (input.builderBudget.confidence !== "high") {
    warnings.push("builder model limits are estimated with low/medium confidence");
  }
  if (input.limits.costLimitUsd === undefined || input.limits.costLimitUsd === null) {
    warnings.push("cost limit is unknown — it is not treated as zero");
  }
  if (input.options.baselineDirty) {
    warnings.push("baseline is dirty; automatic staging may be refused");
  }

  const tasks = input.plan.tasks.map((task) => {
    const text = [
      task.objective,
      task.nonGoals.join("\n"),
      task.expectedFiles.join("\n"),
      task.acceptanceChecks.join("\n"),
      task.sizeRationale,
    ].join("\n");
    return {
      taskId: task.taskId,
      covers: [...task.covers],
      dependsOn: [...task.dependsOn],
      estimatedTokens: estimateTextTokens(text).tokens + DEFAULT_TASK_OVERHEAD_TOKENS,
    };
  });
  const projectedTaskTokens = tasks.reduce((sum, task) => sum + task.estimatedTokens, 0);
  const planDigest = sha256(input.plan);

  const base: Omit<ExecutionPreview, "approvalDigest" | "createdAt"> = {
    schemaVersion: APPROVAL_SCHEMA_VERSION,
    runId: input.runId,
    roadmapRevision: input.plan.roadmapRevision,
    roadmapDigest: input.roadmap.digest,
    planDigest,
    mapping,
    tasks,
    models: {
      orchestrator: {
        model: modelLabel(input.orchestratorBudget.model),
        usableInput: input.orchestratorBudget.usableInput,
        confidence: input.orchestratorBudget.confidence,
      },
      builder: {
        model: modelLabel(input.builderBudget.model),
        usableInput: input.builderBudget.usableInput,
        confidence: input.builderBudget.confidence,
      },
    },
    launcher: { ...input.launcher },
    checks: [...input.checks],
    limits: { ...input.limits },
    options: { ...input.options, mutationScope: [...input.options.mutationScope] },
    projectedTaskTokens,
    warnings,
    blockedReasons,
  };

  return {
    ok: true,
    preview: {
      ...base,
      approvalDigest: sha256(approvalInput(base)),
      createdAt: input.now,
    },
  };
}

/** Explicit approval of the execution breakdown; mode entry and plan approval are not enough. */
export function approveExecution(
  preview: ExecutionPreview,
  options: { confirmation: string; approvalId: string; now: number },
): ApprovalResult {
  if (preview.blockedReasons.length > 0) {
    return { ok: false, code: "blocked", error: preview.blockedReasons[0]! };
  }
  if (options.confirmation !== APPROVAL_CONFIRMATION) {
    return { ok: false, code: "confirmation", error: "explicit execution approval is required" };
  }
  if (!options.approvalId || options.approvalId.trim().length === 0) {
    return { ok: false, code: "invalid", error: "an approval id is required" };
  }
  return {
    ok: true,
    record: {
      schemaVersion: APPROVAL_SCHEMA_VERSION,
      runId: preview.runId,
      approvalId: options.approvalId,
      approvalDigest: preview.approvalDigest,
      planDigest: preview.planDigest,
      roadmapDigest: preview.roadmapDigest,
      approvedAt: options.now,
    },
  };
}

/** Restart-safe check: rebuild the preview and compare the material digest. */
export function revalidateApproval(
  record: ExecutionApprovalRecord | null,
  preview: ExecutionPreview,
): RevalidationResult {
  if (!record) return { ok: false, code: "approval_required", reasons: ["no execution approval"] };
  const reasons: string[] = [];
  if (record.runId !== preview.runId) reasons.push("run changed");
  if (record.roadmapDigest !== preview.roadmapDigest) reasons.push("roadmap changed");
  if (record.planDigest !== preview.planDigest) reasons.push("task breakdown changed");
  if (record.approvalDigest !== preview.approvalDigest) {
    reasons.push("scope, limits, launcher or commit behavior changed");
  }
  return reasons.length === 0 ? { ok: true } : { ok: false, code: "approval_required", reasons };
}

// ── Distinct decision descriptors ────────────────────────────────────

export const DECISION_KINDS = {
  modeEntry: "mode-entry",
  planApproval: "plan-approval",
  executionApproval: "execution-breakdown-approval",
} as const;

export function modeEntryDecision(runId: string) {
  return { kind: DECISION_KINDS.modeEntry, runId, launchesWork: false };
}

/** The ordinary Plan → Build handoff. Never auto-orchestrates. */
export function ordinaryHandoffAction() {
  return {
    kind: DECISION_KINDS.planApproval,
    action: "approve-plan-to-build",
    startsExecution: false,
    requiresExecutionApproval: false,
  } as const;
}

/** A separate route for an already-approved plan; it never reuses the handoff action. */
export function orchestrateApprovedPlanAction(record: ExecutionApprovalRecord | null) {
  return {
    kind: DECISION_KINDS.executionApproval,
    action: "orchestrate-approved-plan",
    startsExecution: true,
    requiresExecutionApproval: true,
    approved: record !== null,
  } as const;
}
