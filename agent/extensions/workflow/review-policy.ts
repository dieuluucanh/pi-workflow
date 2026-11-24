/**
 * Reviewer ownership policy (pure).
 *
 * The independent Reviewer is a **Plan artifact**. This module is the single
 * source of truth for "may a Reviewer round start or resume right now?", and
 * it is also the execution-ownership predicate the mode controller shares:
 *
 *   - an Orchestrator Build child is never a review owner, whatever mode its
 *     session claims;
 *   - an executing Orchestrator run owns the session, including the
 *     between-row window where no child is live;
 *   - a Reviewer may only run in a parent Plan session;
 *   - automatic review additionally needs the feature enabled **and** a
 *     current Plan submission (a plan write/edit in this run, in Plan mode).
 *
 * Manual `/review` and `/review-resume` bypass only the automatic-enabled
 * flag. They never bypass ownership, mode or staleness.
 *
 * Keeping this pure lets the extension, the commands and the tests agree on
 * one answer without importing the extension or the SDK.
 */

import type { OrchestratorChildPhase } from "./orchestrator-child-controller.ts";
import type { OrchestratorRunPhase } from "./orchestrator-run.ts";
import type { WorkflowMode } from "./workflow-mode.ts";

/** What is asking for a Reviewer round. */
export type ReviewerTrigger = "auto" | "manual" | "resume";

/** Child phases in which the child owns the session. */
export const EXECUTING_CHILD_PHASES: readonly OrchestratorChildPhase[] = [
  "starting",
  "running",
  "paused",
  "settling",
];

/**
 * Run phases in which the run owns the session (no child required).
 *
 * Only a live dispatch owns the session. `idle`, `paused`, `interrupted`,
 * `cancelled` and `completed` are idle from the user's point of view: they may
 * leave the mode or start a review.
 */
export const EXECUTING_RUN_PHASES: readonly OrchestratorRunPhase[] = ["running"];

export interface ExecutionOwnershipInput {
  childPhase?: OrchestratorChildPhase;
  runPhase?: OrchestratorRunPhase;
}

/**
 * True when an Orchestrator execution currently owns the session.
 *
 * A live child always owns the session; a run with `running` owns it between
 * rows, when no child is live yet.
 */
export function executionOwnsSession(
  input: ExecutionOwnershipInput,
): boolean {
  return (
    (input.childPhase !== undefined &&
      EXECUTING_CHILD_PHASES.includes(input.childPhase)) ||
    (input.runPhase !== undefined &&
      EXECUTING_RUN_PHASES.includes(input.runPhase))
  );
}

export type ReviewerRefusalCode =
  | "orchestrator-child"
  | "stale-owner"
  | "executing-run"
  | "not-plan"
  | "auto-disabled"
  | "no-current-submission";

export type ReviewerAdmission =
  | { ok: true }
  | { ok: false; code: ReviewerRefusalCode; reason: string };

export interface ReviewerAdmissionInput extends ExecutionOwnershipInput {
  trigger: ReviewerTrigger;
  /** Live workflow mode. */
  mode: WorkflowMode;
  /** True in an in-process Orchestrator Build child. */
  isOrchestratorChild?: boolean;
  /** Persisted/configured automatic-review flag. */
  autoReviewEnabled?: boolean;
  /**
   * Automatic review only: a successful `.pi/plans/` write/edit in THIS run,
   * in Plan mode, still belonging to the current session/cycle.
   */
  hasCurrentPlanSubmission?: boolean;
  /** True when the round belongs to a superseded session or cycle. */
  staleOwner?: boolean;
}

/**
 * Decide whether a Reviewer round may start. `reason` is user-facing and is
 * deliberately complete: callers must not invent their own refusal copy.
 */
export function admitReviewer(
  input: ReviewerAdmissionInput,
): ReviewerAdmission {
  if (input.isOrchestratorChild === true) {
    return {
      ok: false,
      code: "orchestrator-child",
      reason:
        "This is an Orchestrator Build child. Review belongs to the parent Plan; work the assigned row and finish with a summary.",
    };
  }
  if (input.staleOwner === true) {
    return {
      ok: false,
      code: "stale-owner",
      reason:
        "This review belongs to a superseded session or plan cycle — it will not start.",
    };
  }
  if (executionOwnsSession(input)) {
    return {
      ok: false,
      code: "executing-run",
      reason:
        "An Orchestrator run owns this session — finish, pause or abort it before reviewing a plan. Row verification is not a review round.",
    };
  }
  if (input.mode !== "plan") {
    return {
      ok: false,
      code: "not-plan",
      reason:
        "Review is available in Plan mode only — switch with /plan, then run /review.",
    };
  }
  if (input.trigger === "auto") {
    if (input.autoReviewEnabled !== true) {
      return {
        ok: false,
        code: "auto-disabled",
        reason: "Automatic review is off — run /review to audit the plan manually.",
      };
    }
    if (input.hasCurrentPlanSubmission !== true) {
      return {
        ok: false,
        code: "no-current-submission",
        reason:
          "No plan was submitted in this Plan run — automatic review waits for a plan write.",
      };
    }
  }
  return { ok: true };
}

export type ModeTransitionRefusalCode =
  | "orchestrator-child"
  | "executing-run";

export type ModeTransitionAdmission =
  | { ok: true }
  | { ok: false; code: ModeTransitionRefusalCode; reason: string };

export interface ModeTransitionAdmissionInput extends ExecutionOwnershipInput {
  target: WorkflowMode;
  currentMode: WorkflowMode;
  isOrchestratorChild?: boolean;
  /** Authorized internal child bootstrap, not a user mode request. */
  fromManagedChild?: boolean;
}

/**
 * Shared final gate for every mode change (commands, cycling, host events and
 * approval paths). Enforced when the transition actually executes, so a
 * queued request cannot bypass a run that started in the meantime.
 */
export function admitModeTransition(
  input: ModeTransitionAdmissionInput,
): ModeTransitionAdmission {
  if (input.isOrchestratorChild === true && input.fromManagedChild !== true) {
    return {
      ok: false,
      code: "orchestrator-child",
      reason:
        "This is an Orchestrator Build child. Mode changes are disabled; work the assigned row and finish with a summary.",
    };
  }
  // Leaving Orchestrator is the only transition that can strand a live run.
  const leavingOrchestrator =
    input.currentMode === "orchestrator" && input.target !== "orchestrator";
  if (leavingOrchestrator && executionOwnsSession(input)) {
    return {
      ok: false,
      code: "executing-run",
      reason:
        "An Orchestrator run owns this session — /orchestrator-abort or /orchestrator stop first.",
    };
  }
  return { ok: true };
}
