/**
 * Workflow Extension — Planner↔Reviewer negotiation policy (pure).
 *
 * `decidePlanRevision` is the ONLY place the revision-loop condition is
 * computed. It decides, from one finished review round and the revision
 * budget, whether the Planner gets another revision turn, the loop is
 * converged, or the host hands off as-is.
 *
 * Pure and total: no I/O, no Pi runtime, never throws. The loop wiring lives
 * in `index.ts` (step 3 of the plan) and consumes this decision verbatim.
 */

import type { ReviewExecutionOutcome, ReviewVerdict } from "./review.ts";
import type { ReviewNote } from "./utils.ts";

/** Upper bound of the `maxRevisions` budget (mirrors `review.ts`). */
export const MAX_REVISIONS_LIMIT = 5;

/** The two review outcomes that mean "the round produced a reviewer verdict". */
const USABLE_OUTCOMES: ReadonlySet<ReviewExecutionOutcome> = new Set([
  "rewritten",
  "unchanged",
]);

/**
 * Why the loop stopped or continues.
 *
 * - `continue`      — request one more Planner revision turn.
 * - `converged`     — the reviewer approved with no required changes.
 * - `no-revision`   — nothing for the Planner to revise (or the budget is
 *                     disabled): hand off.
 * - `exhausted`     — notes are still open but `maxRevisions` is spent: hand
 *                     off with a warning.
 * - `review-failed` — the round paused/aborted/failed/skipped: never revise.
 */
export type ReviewNegotiationOutcome =
  | "continue"
  | "converged"
  | "no-revision"
  | "exhausted"
  | "review-failed";

/** One decision of the Planner↔Reviewer loop. */
export interface ReviewNegotiationDecision {
  /** True only when the host must send a Planner revision turn. */
  request: boolean;
  outcome: ReviewNegotiationOutcome;
  /** Human-readable reason, always present (used for notices and the handoff). */
  reason: string;
  /** Normalized revisions already spent (never negative, never fractional). */
  revisionsUsed: number;
  /** Normalized revision budget actually applied (clamped to 0..5). */
  maxRevisions: number;
}

export interface PlanRevisionInput {
  /** How the executed review round ended (`review.ts`). */
  reviewOutcome: ReviewExecutionOutcome;
  /** The reviewer's verdict, when the round produced one. */
  verdict?: ReviewVerdict;
  /** Notes parsed from the reviewer's appendix for this round. */
  notes: readonly ReviewNote[];
  /** Revision turns already spent in this negotiation (separate from `rounds`). */
  revisionsUsed: number;
  /** The configured budget: 0 = one-shot, clamped to 0..5. */
  maxRevisions: number;
}

/** Clamp a budget/counter to a whole number in 0..`max`, junk -> `fallback`. */
function clampCount(value: unknown, max: number, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(0, Math.trunc(n)));
}

function plural(count: number): string {
  return count === 1 ? "revision" : "revisions";
}

/**
 * Decide the next loop move. Rules, in order:
 *
 * 1. `paused|aborted|fallback|skipped` → `review-failed`, never revise.
 * 2. `maxRevisions === 0` → `no-revision` (reason "disabled"): one-shot.
 * 3. `approve` with no notes → `converged`.
 * 4. no notes at all → `no-revision` (nothing to revise).
 * 5. notes present and `revisionsUsed >= maxRevisions` → `exhausted`.
 * 6. otherwise → `continue` (one request).
 *
 * Never throws; non-finite/negative inputs are normalized and the budget is
 * clamped to 0..5 before the comparison.
 */
export function decidePlanRevision(
  input: PlanRevisionInput,
): ReviewNegotiationDecision {
  let revisionsUsed = 0;
  let maxRevisions: number;
  try {
    revisionsUsed = clampCount(input?.revisionsUsed, MAX_REVISIONS_LIMIT, 0);
    maxRevisions = clampCount(input?.maxRevisions, MAX_REVISIONS_LIMIT, 0);
  } catch {
    revisionsUsed = 0;
    maxRevisions = 0;
  }

  const budget = { revisionsUsed, maxRevisions };
  const outcome = input?.reviewOutcome;
  const verdict = input?.verdict;
  const notes = Array.isArray(input?.notes) ? input.notes : [];
  const noteCount = notes.length;

  if (!USABLE_OUTCOMES.has(outcome)) {
    return {
      request: false,
      outcome: "review-failed",
      reason: `review did not produce a usable verdict (${String(outcome ?? "unknown")})`,
      ...budget,
    };
  }

  if (maxRevisions === 0) {
    return {
      request: false,
      outcome: "no-revision",
      reason: "revisions disabled (maxRevisions 0) — one-shot review",
      ...budget,
    };
  }

  if (verdict === "approve" && noteCount === 0) {
    return {
      request: false,
      outcome: "converged",
      reason: "reviewer approved with no required changes",
      ...budget,
    };
  }

  if (noteCount === 0) {
    const verdictLabel = verdict ? `verdict ${verdict}` : "no verdict";
    return {
      request: false,
      outcome: "no-revision",
      reason: `${verdictLabel} with no required changes — nothing to revise`,
      ...budget,
    };
  }

  if (revisionsUsed >= maxRevisions) {
    return {
      request: false,
      outcome: "exhausted",
      reason: `revision budget spent (${revisionsUsed}/${maxRevisions}) with ${noteCount} open note${
        noteCount === 1 ? "" : "s"
      }`,
      ...budget,
    };
  }

  const remaining = maxRevisions - revisionsUsed;
  return {
    request: true,
    outcome: "continue",
    reason: `${noteCount} open note${noteCount === 1 ? "" : "s"} — Planner revision ${
      revisionsUsed + 1
    } of ${maxRevisions} (${remaining} ${plural(remaining)} left)`,
    ...budget,
  };
}
