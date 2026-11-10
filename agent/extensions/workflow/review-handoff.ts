/**
 * Review Mode — Plannotator handoff decisions.
 *
 * The browser request itself is orchestrated in `index.ts` because it needs the
 * Pi event bus, the current session context and the plan file. Everything that
 * can be decided without those live objects lives here:
 *
 * - whether an open browser review still belongs to the current plan;
 * - whether a pending gate must be superseded by a new round;
 * - whether a settled manual round should hand off at all.
 *
 * Keeping these pure is what lets the extension tests cover the stale-gate and
 * reload-recovery matrix without a host or a real browser.
 */

import type { ReviewExecutionResult } from "./review.ts";

/** What opened the browser review. */
export type ReviewHandoffSource = "auto" | "manual";

/** The correlation persisted with `awaitingDecision`. */
export interface PendingReviewHandoff {
  reviewId: string;
  planPath: string;
  planHash: string;
  source: ReviewHandoffSource;
  requestId?: string;
  reviewUrl?: string;
  cycleId: number;
  at: number;
}

export type ReviewHandoffRecovery =
  | { action: "keep"; reason: "pending" }
  | {
      action: "apply";
      approved: boolean;
      feedback?: string;
      savedPath?: string;
    }
  | { action: "clear"; reason: string };

/**
 * Decide what to do with a pending handoff after a reload.
 *
 * Plannotator's `review-status` is authoritative for whether the review is
 * still open, but not for whether it still describes the current plan. A plan
 * changed while the app was away makes both a pending tab and a completed
 * decision stale, so the hash is checked before either is honoured.
 */
export function reviewHandoffRecovery(input: {
  status: "pending" | "completed" | "missing";
  approved?: boolean;
  feedback?: string;
  savedPath?: string;
  pendingHash?: string;
  currentHash?: string;
}): ReviewHandoffRecovery {
  if (input.status === "missing") {
    return {
      action: "clear",
      reason: "the browser review is no longer available",
    };
  }
  if (
    input.pendingHash !== undefined &&
    input.currentHash !== undefined &&
    input.pendingHash !== input.currentHash
  ) {
    return {
      action: "clear",
      reason: "the plan changed since the review opened",
    };
  }
  if (input.status === "pending") {
    return { action: "keep", reason: "pending" };
  }
  return {
    action: "apply",
    approved: input.approved === true,
    ...(input.feedback !== undefined ? { feedback: input.feedback } : {}),
    ...(input.savedPath !== undefined ? { savedPath: input.savedPath } : {}),
  };
}

/**
 * True when a pending browser gate cannot belong to the round about to start.
 *
 * `force` is for an automatic round start (a new round must never inherit an
 * older gate) and for `/review`: both are an explicit supersede even when the
 * plan hash happens to match.
 */
export function pendingHandoffIsStale(input: {
  awaiting: boolean;
  force?: boolean;
  pendingCycleId?: number;
  currentCycleId?: number;
  pendingPlanHash?: string;
  nextPlanHash?: string;
}): boolean {
  if (input.awaiting !== true) return false;
  if (input.force === true) return true;
  if (
    input.pendingCycleId !== undefined &&
    input.currentCycleId !== undefined &&
    input.pendingCycleId !== input.currentCycleId
  ) {
    return true;
  }
  return (
    input.pendingPlanHash !== undefined &&
    input.nextPlanHash !== undefined &&
    input.pendingPlanHash !== input.nextPlanHash
  );
}

/**
 * A manual `/review` hands off when the round settled one way or another.
 * A pause is resumed later; an abort is an explicit exit.
 */
export function shouldHandoffManualResult(
  result: Pick<ReviewExecutionResult, "outcome">,
): boolean {
  return result.outcome !== "paused" && result.outcome !== "aborted";
}
