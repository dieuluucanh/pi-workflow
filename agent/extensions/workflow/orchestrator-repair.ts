/**
 * Workflow Extension — scoped repair and no-progress handling (step 33).
 *
 * When parent verification fails, the scheduler does NOT advance and does NOT
 * blindly retry the same side effects. It classifies the failure first:
 *
 *   - a code/verification failure produces a bounded, scoped repair directive
 *     (failed criteria + concrete check evidence + already-changed files +
 *     non-goals) for the same warm child, or a fresh continuation only when the
 *     child is gone;
 *   - provider, launch, context and manual-only failures are classified
 *     separately — they are never disguised as "fix your code";
 *   - the persisted repair and no-progress counters bound the retries; at the
 *     bound the scheduler pauses with explicit retry/unblock/cancel controls
 *     instead of looping;
 *   - a stale lease generation cannot send a repair.
 *
 * Pure: no process, clock or model access.
 */

import { DEFAULT_EXECUTION_BUDGETS, type ExecutionBudgets } from "./orchestrator-types.ts";
import type { TaskCounters } from "./orchestrator-state.ts";

export const REPAIR_SCHEMA_VERSION = 1 as const;
export const MAX_DIRECTIVE_CHARS = 8_000;
export const MAX_REPAIR_ITEMS = 64;

/** Why verification (or a launch) failed. */
export type FailureFact =
  | "check_failed"
  | "criterion_unmet"
  | "provider_error"
  | "launch_failed"
  | "context_exhausted"
  | "manual_only"
  | "scope_revision";

export type FailureCategory =
  | "verification"
  | "provider"
  | "launch"
  | "context"
  | "manual"
  | "scope";

export interface FailureClassification {
  category: FailureCategory;
  /** A model-facing repair directive is appropriate. */
  directive: boolean;
  /** The scheduler may retry without changing the assignment. */
  retryable: boolean;
  /** A fresh context/continuation is the correct remedy. */
  requiresRollover: boolean;
  /** A human or a new approval is required before any further dispatch. */
  requiresHuman: boolean;
  reason: string;
}

const CLASSIFICATION: Readonly<Record<FailureFact, FailureClassification>> = {
  check_failed: {
    category: "verification",
    directive: true,
    retryable: true,
    requiresRollover: false,
    requiresHuman: false,
    reason: "a required check failed against the candidate",
  },
  criterion_unmet: {
    category: "verification",
    directive: true,
    retryable: true,
    requiresRollover: false,
    requiresHuman: false,
    reason: "a required roadmap criterion is not met",
  },
  provider_error: {
    category: "provider",
    directive: false,
    retryable: true,
    requiresRollover: false,
    requiresHuman: false,
    reason: "the provider failed; the work itself was not judged",
  },
  launch_failed: {
    category: "launch",
    directive: false,
    retryable: true,
    requiresRollover: false,
    requiresHuman: false,
    reason: "the child never reached its assignment turn",
  },
  context_exhausted: {
    category: "context",
    directive: false,
    retryable: false,
    requiresRollover: true,
    requiresHuman: false,
    reason: "the child context is exhausted; a continuation is required",
  },
  manual_only: {
    category: "manual",
    directive: false,
    retryable: false,
    requiresRollover: false,
    requiresHuman: true,
    reason: "a human-only acceptance criterion is still open",
  },
  scope_revision: {
    category: "scope",
    directive: false,
    retryable: false,
    requiresRollover: false,
    requiresHuman: true,
    reason: "scope/criteria/dependencies changed; a new approval revision is required",
  },
};

export function classifyFailure(facts: readonly FailureFact[]): FailureClassification {
  // Any human/scope/context fact outranks a code failure: the scheduler must
  // not ask a worker to "fix" something that is not a code problem.
  const order: FailureCategory[] = ["scope", "manual", "context", "launch", "provider", "verification"];
  for (const category of order) {
    for (const fact of facts) {
      const classification = CLASSIFICATION[fact];
      if (classification.category === category) return classification;
    }
  }
  return CLASSIFICATION.criterion_unmet;
}

// ── Directive ────────────────────────────────────────────────────────

export interface FailedCriterion {
  roadmapStepId: string;
  status: string;
  note?: string;
}

export interface FailedCheck {
  name: string;
  status: string;
  evidence?: string;
}

export interface RepairDirective {
  schemaVersion: typeof REPAIR_SCHEMA_VERSION;
  runId: string;
  taskId: string;
  attemptId: string;
  candidateId: string;
  round: number;
  limit: number;
  failedCriteria: FailedCriterion[];
  failedChecks: FailedCheck[];
  changedFiles: string[];
  nonGoals: string[];
  guidance: string;
  /** The child must not replay effects that already landed. */
  doNotRepeatUnchangedEffects: true;
  truncated: boolean;
  createdAt: number;
}

export interface ChildRepairState {
  phase: "launching" | "ready" | "running" | "waiting_user" | "fenced" | "paused" | "closed" | "interrupted";
  /** Accepted a directive without a relaunch. */
  warm: boolean;
  leaseGeneration: number;
  currentLeaseGeneration: number;
}

export interface RepairInput {
  runId: string;
  taskId: string;
  attemptId: string;
  candidateId: string;
  category: FailureCategory;
  objective: string;
  failedCriteria: readonly FailedCriterion[];
  failedChecks: readonly FailedCheck[];
  changedFiles: readonly string[];
  nonGoals: readonly string[];
  child: ChildRepairState;
  counters: TaskCounters;
  budgets?: ExecutionBudgets;
  now: number;
}

export type RepairControl = "retry" | "unblock" | "cancel";

export type RepairDecision =
  | {
      ok: true;
      action: "same_child";
      requiresResume: boolean;
      directive: RepairDirective;
      message: "repair";
      leaseGeneration: number;
    }
  | {
      ok: true;
      action: "fresh_continuation";
      directive: RepairDirective;
      reason: string;
    }
  | {
      ok: true;
      action: "retry";
      target: "same_child" | "fresh_launch";
      reason: string;
      controls: readonly RepairControl[];
    }
  | {
      ok: true;
      action: "rollover_required";
      reason: string;
    }
  | {
      ok: true;
      action: "wait";
      reason: string;
      controls: readonly RepairControl[];
      requiresHuman: boolean;
    }
  | {
      ok: true;
      action: "pause";
      reason: string;
      controls: readonly RepairControl[];
      requiresApproval: boolean;
    }
  | { ok: false; code: "invalid" | "lease"; error: string };

export type RepairOutcome =
  | { ok: true; action: "retry" | "pause"; counters: TaskCounters; reason?: string }
  | { ok: false; code: "invalid"; error: string };

function fail(code: "invalid" | "lease", error: string): { ok: false; code: "invalid" | "lease"; error: string } {
  return { ok: false, code, error };
}

function bounded(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > max) return undefined;
  return trimmed;
}

function list<T>(input: readonly T[], max: number): T[] {
  return input.slice(0, max);
}

function controlsFor(reason: string): RepairControl[] {
  if (/approval|scope/i.test(reason)) return ["retry", "unblock", "cancel"];
  if (/manual|human/i.test(reason)) return ["unblock", "cancel"];
  return ["retry", "unblock", "cancel"];
}

export function buildDirective(input: RepairInput, round: number, limit: number): RepairDirective {
  const failedCriteria = list(input.failedCriteria, MAX_REPAIR_ITEMS).map((criterion) => ({
    roadmapStepId: criterion.roadmapStepId,
    status: criterion.status,
    ...(criterion.note ? { note: criterion.note.slice(0, 500) } : {}),
  }));
  const failedChecks = list(input.failedChecks, MAX_REPAIR_ITEMS).map((check) => ({
    name: check.name,
    status: check.status,
    ...(check.evidence ? { evidence: check.evidence.slice(0, 1_000) } : {}),
  }));
  const changedFiles = list(input.changedFiles, MAX_REPAIR_ITEMS).map((path) =>
    path.replace(/\\/g, "/").slice(0, 400),
  );
  const nonGoals = list(input.nonGoals, MAX_REPAIR_ITEMS).map((goal) => goal.slice(0, 400));

  // Order matters: the actionable scope (criteria/files/non-goals) survives
  // even when a check log is huge. Detailed check output is last and bounded.
  const fullCheckLine = failedChecks
    .map(
      (check) =>
        `${check.name} (${check.status}${check.evidence ? `: ${check.evidence.slice(0, 200)}` : ""})`,
    )
    .join("; ");
  const checkLine = fullCheckLine.slice(0, 3_000);
  let truncated = checkLine.length < fullCheckLine.length;
  const lines = [
    `Repair round ${round}/${limit} for ${input.taskId}/${input.attemptId} (candidate ${input.candidateId}).`,
    `Objective: ${input.objective.slice(0, 1_000)}`,
    failedCriteria.length > 0
      ? `Failed criteria: ${failedCriteria
          .map((criterion) => `${criterion.roadmapStepId} (${criterion.status})`)
          .join(", ")}`
      : "Failed criteria: none recorded",
    `Files already changed: ${changedFiles.length > 0 ? changedFiles.join(", ") : "none"}`,
    `Non-goals: ${nonGoals.length > 0 ? nonGoals.join("; ") : "none"}`,
    "Start from the current workspace. Do not repeat unchanged side effects (installs, migrations, external calls).",
    "Stay inside the assignment; report any newly discovered scope instead of implementing it.",
    failedChecks.length > 0 ? `Failed checks: ${checkLine}` : "Failed checks: none recorded",
  ];
  let guidance = lines.join("\n");
  if (guidance.length > MAX_DIRECTIVE_CHARS) {
    truncated = true;
    guidance = `${guidance.slice(0, MAX_DIRECTIVE_CHARS - 40)}\n[directive truncated]`;
  }

  return {
    schemaVersion: REPAIR_SCHEMA_VERSION,
    runId: input.runId,
    taskId: input.taskId,
    attemptId: input.attemptId,
    candidateId: input.candidateId,
    round,
    limit,
    failedCriteria,
    failedChecks,
    changedFiles,
    nonGoals,
    guidance,
    doNotRepeatUnchangedEffects: true,
    truncated,
    createdAt: input.now,
  };
}

/**
 * Decides what the scheduler may do next. Verification failures go back to the
 * child with a directive; environment failures are classified instead of
 * pretending they are code defects; budgets pause with explicit controls.
 */
export function buildRepairDecision(input: RepairInput): RepairDecision {
  for (const [label, value] of [
    ["runId", input.runId],
    ["taskId", input.taskId],
    ["attemptId", input.attemptId],
    ["candidateId", input.candidateId],
  ] as const) {
    if (!bounded(value, 400)) return fail("invalid", `${label} is invalid`);
  }
  const budgets = input.budgets ?? DEFAULT_EXECUTION_BUDGETS;

  if (input.category === "manual") {
    return {
      ok: true,
      action: "wait",
      reason: "a human-only acceptance criterion is still open",
      controls: ["unblock", "cancel"],
      requiresHuman: true,
    };
  }
  if (input.category === "scope") {
    return {
      ok: true,
      action: "pause",
      reason: "scope, criteria or dependencies changed; a new approval revision is required",
      controls: controlsFor("scope approval"),
      requiresApproval: true,
    };
  }
  if (input.category === "context") {
    return {
      ok: true,
      action: "rollover_required",
      reason: "the child context is exhausted; checkpoint and continuation are required",
    };
  }
  if (input.category === "provider") {
    return {
      ok: true,
      action: "retry",
      target: input.child.phase === "closed" || input.child.phase === "interrupted" ? "fresh_launch" : "same_child",
      reason: "the provider failed; retry the same assignment",
      controls: ["retry", "cancel"],
    };
  }
  if (input.category === "launch") {
    if (input.counters.launchFailures >= budgets.launchFailureLimit) {
      return {
        ok: true,
        action: "pause",
        reason: "launch failure budget exhausted",
        controls: ["retry", "unblock", "cancel"],
        requiresApproval: false,
      };
    }
    return {
      ok: true,
      action: "retry",
      target: "fresh_launch",
      reason: "the launch failed before the assignment turn",
      controls: ["retry", "cancel"],
    };
  }

  // A verification failure: never advance, never loop past the budgets.
  if (input.counters.repairRounds >= budgets.repairRounds) {
    return {
      ok: true,
      action: "pause",
      reason: "repair budget exhausted",
      controls: ["retry", "unblock", "cancel"],
      requiresApproval: false,
    };
  }
  if (input.counters.noProgress >= budgets.noProgressLimit) {
    return {
      ok: true,
      action: "pause",
      reason: "no-progress budget exhausted; refusing to retry unchanged side effects",
      controls: ["retry", "unblock", "cancel"],
      requiresApproval: false,
    };
  }
  if (!Number.isInteger(input.child.leaseGeneration) || input.child.leaseGeneration !== input.child.currentLeaseGeneration) {
    return fail("lease", "a stale lease generation cannot send a repair directive");
  }

  const round = input.counters.repairRounds + 1;
  const directive = buildDirective(input, round, budgets.repairRounds + 1);
  if (
    input.child.warm &&
    (input.child.phase === "running" || input.child.phase === "fenced" || input.child.phase === "ready" || input.child.phase === "waiting_user")
  ) {
    return {
      ok: true,
      action: "same_child",
      requiresResume: input.child.phase === "waiting_user",
      directive,
      message: "repair",
      leaseGeneration: input.child.leaseGeneration,
    };
  }
  if (input.child.phase === "paused") {
    return {
      ok: true,
      action: "same_child",
      requiresResume: true,
      directive,
      message: "repair",
      leaseGeneration: input.child.leaseGeneration,
    };
  }
  return {
    ok: true,
    action: "fresh_continuation",
    directive,
    reason:
      input.child.phase === "closed" || input.child.phase === "interrupted"
        ? "the child window/tab is gone; reopen the same task as a fresh continuation"
        : "the child is not warm; continue in a fresh child with the same assignment",
  };
}

/**
 * Counter update after a repair attempt. `verificationFailed` is required and
 * therefore always true for this function: the scheduler never advances while
 * verification fails.
 */
export function recordRepairOutcome(input: {
  counters: TaskCounters;
  outcome: "meaningful_change" | "no_change" | "blocked";
  verificationFailed: true;
  budgets?: ExecutionBudgets;
}): RepairOutcome {
  const budgets = input.budgets ?? DEFAULT_EXECUTION_BUDGETS;
  if (input.outcome === "blocked") {
    return {
      ok: true,
      action: "pause",
      counters: { ...input.counters },
      reason: "the repair attempt is blocked and needs an explicit decision",
    };
  }
  const repairRounds = input.counters.repairRounds + 1;
  const noProgress = input.outcome === "no_change" ? input.counters.noProgress + 1 : 0;
  const counters = { ...input.counters, repairRounds, noProgress };
  if (repairRounds > budgets.repairRounds) {
    return { ok: true, action: "pause", counters, reason: "repair budget exhausted" };
  }
  if (noProgress >= budgets.noProgressLimit) {
    return {
      ok: true,
      action: "pause",
      counters,
      reason: "no-progress budget exhausted; refusing to retry unchanged side effects",
    };
  }
  return { ok: true, action: "retry", counters };
}

/** Explicit controls shown when a budget is exhausted. */
export function repairControls(input: { reason: string; requiresApproval?: boolean }) {
  return {
    reason: input.reason,
    retry: { requiresExplicitConfirmation: true as const, resetsBudget: false as const },
    unblock: { requiresUserDecision: true as const },
    cancel: { keepsEdits: true as const, automaticRollback: false as const },
    requiresApproval: input.requiresApproval === true,
  };
}
