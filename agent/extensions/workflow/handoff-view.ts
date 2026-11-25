/**
 * Review Mode — native PLAN handoff decisions and question shapes.
 *
 * The browser (Plannotator) handoff lives in `index.ts` because it needs the Pi
 * event bus, the session context and the plan file. This module owns everything
 * that can be decided without those live objects:
 *
 * - the compact question the bottom-pinned questionnaire shows (the plan itself
 *   is printed into the transcript, NOT into the modal);
 * - the mapping from a questionnaire answer to a PLAN decision;
 * - the bounded plan text persisted with the transcript entry.
 *
 * The native question is about the PLAN only: Approve / Feedback / Skip. Where
 * an approved plan executes is a SEPARATE decision owned by
 * `handoff-execution-view.ts`, asked after the approval. Combining them (the
 * previous `Approve → Orchestrator` / `Approve → direct Build` rows) let a
 * single click both approve and execute, which is exactly the ordering bug this
 * split fixes.
 *
 * Keeping it free of TUI/host imports is what lets the unit tests cover the
 * answer matrix (approve / feedback / freeform / cancel / malformed) without a
 * terminal, mirroring `review-handoff.ts`.
 */

import type {
  QuestionnaireOption,
  QuestionnaireQuestion,
  QuestionnaireResult,
} from "./questionnaire-view.ts";

/** Approve the PLAN. Execution is chosen in the next, separate step. */
export const HANDOFF_APPROVE_LABEL = "Approve plan (choose execution next)";
/** Stay in Plan mode and revise from user feedback. */
export const HANDOFF_FEEDBACK_LABEL = "Give feedback (stay in Plan)";
/** Keep the plan, stay in Plan mode, change nothing. */
export const HANDOFF_SKIP_LABEL = "Skip for now (stay in Plan)";

/**
 * Legacy destination-specific approval labels.
 *
 * They were shown by older builds and may be persisted in a session answer or
 * an automation script. They now mean "approve the plan" ONLY: the execution
 * destination is always chosen in the separate second step.
 *
 * @deprecated use `HANDOFF_APPROVE_LABEL`; kept for answer compatibility.
 */
export const HANDOFF_APPROVE_ORCHESTRATOR_LABEL =
  "Approve plan → Orchestrator (prepare breakdown)";
/** @deprecated see `HANDOFF_APPROVE_ORCHESTRATOR_LABEL`. */
export const HANDOFF_APPROVE_BUILD_LABEL =
  "Approve plan → direct Build (execute here)";

/** Header tab of the handoff question. */
export const HANDOFF_QUESTION_HEADER = "Handoff";

/** Durable, display-only transcript entry type for the printed plan. */
export const HANDOFF_PLAN_ENTRY_TYPE = "workflow-handoff-plan";

/**
 * Upper bound on the plan text persisted with the transcript entry. The plan
 * file stays authoritative; the entry is a readable tail, not a second copy.
 */
export const HANDOFF_PLAN_MAX_CHARS = 40_000;

/** Why the native handoff is being shown. Persisted with the entry. */
export type HandoffReason =
  | "reviewed"
  | "handoff"
  | "aborted"
  | "unavailable"
  | "closed"
  | "build-failed";

/** Payload of `workflow-handoff-plan`. JSON-serializable (persisted). */
export interface HandoffPlanEntryData {
  planPath: string;
  planText: string;
  reason: HandoffReason;
  verdict?: string;
  findingCount?: number;
  truncated?: boolean;
  at?: number;
}

/**
 * What the user decided about the PLAN in the native question.
 *
 * There is deliberately no `execute` variant: approval is not execution.
 */
export type HandoffChoice =
  | { choice: "approve" }
  | { choice: "refine"; feedback?: string }
  | { choice: "dismiss" };

export interface HandoffQuestionInput {
  planPath: string;
  reason: HandoffReason;
  verdict?: string;
  findingCount?: number;
  /**
   * Advisory notes the reviewer recorded in the plan's last round appendix.
   * Shown next to the findings count only when positive; the plan body itself
   * is never amended by them.
   */
  revisionCount?: number;
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

/** One human-readable line for the reason the handoff appeared. */
export function handoffReasonLabel(reason: HandoffReason): string {
  switch (reason) {
    case "aborted":
      return "review skipped — the author's plan stands";
    case "unavailable":
      return "Plannotator unavailable — native handoff";
    case "closed":
      return "browser review closed without a decision";
    case "build-failed":
      return "Build was not entered — the plan stays in Plan mode";
    case "handoff":
      return "plan ready — approve to choose execution, or give feedback";
    case "reviewed":
    default:
      return "review finished";
  }
}

/**
 * Bound the plan text persisted with the transcript entry.
 *
 * The trailer names the full file so a truncated entry is never mistaken for
 * the complete plan. A non-string input is treated as empty rather than
 * throwing: a malformed result must never break the handoff.
 */
export function capHandoffPlanText(
  planText: unknown,
  planPath: string,
): { text: string; truncated: boolean } {
  const text = typeof planText === "string" ? planText : "";
  if (text.length <= HANDOFF_PLAN_MAX_CHARS) {
    return { text, truncated: false };
  }
  const head = text.slice(0, HANDOFF_PLAN_MAX_CHARS).replace(/\s+$/, "");
  const file = planPath || "(unknown)";
  return {
    text: `${head}\n\n… plan truncated in transcript — full file: ${file}`,
    truncated: true,
  };
}

/**
 * Build the native PLAN question.
 *
 * Deliberately carries NO plan body: the plan is printed into the transcript
 * above the modal (step 2), so the modal stays compact and pinned at the bottom
 * instead of covering the screen with a pinned plan pane.
 */
export function buildHandoffQuestion(
  input: HandoffQuestionInput,
): QuestionnaireQuestion {
  const file = input.planPath || "(no plan file)";
  const lines = [`Plan: ${file}`, handoffReasonLabel(input.reason)];
  if (typeof input.verdict === "string" && input.verdict.trim()) {
    let count = "";
    if (typeof input.findingCount === "number" && input.findingCount >= 0) {
      const plural = input.findingCount === 1 ? "" : "s";
      count = ` · ${input.findingCount} finding${plural}`;
    }
    if (
      typeof input.revisionCount === "number" &&
      Number.isFinite(input.revisionCount) &&
      input.revisionCount > 0
    ) {
      const plural = input.revisionCount === 1 ? "" : "s";
      count += ` · ${input.revisionCount} note${plural}`;
    }
    lines.push(`Review: ${input.verdict.trim()}${count}`);
  }
  lines.push("The plan is printed above in the transcript — scroll up to read it.");
  lines.push("Approving the plan is not execution: you choose where it runs next.");
  const options: QuestionnaireOption[] = [
    {
      label: HANDOFF_APPROVE_LABEL,
      description:
        "Approve this plan, then choose Orchestrator (in-process child per step) or direct Build",
    },
    {
      label: HANDOFF_FEEDBACK_LABEL,
      description: "Send changes to the planner and review the revision again",
    },
    {
      label: HANDOFF_SKIP_LABEL,
      description: "Keep the plan on disk; decide later with /review or /build",
    },
  ];
  return {
    header: HANDOFF_QUESTION_HEADER,
    question: "Plan ready — approve it, or ask for changes?",
    context: lines.join("\n"),
    options,
  };
}

/**
 * Map a plan-question result to a PLAN decision.
 *
 * - approve resolves by label (including the legacy destination-specific
 *   labels, which now approve only);
 * - the built-in freeform row (`wasCustom`) is feedback text;
 * - cancel, a missing/unknown answer, or a non-object is a dismissal — never an
 *   approval, and never an execution.
 */
export function handoffChoiceFromResult(
  result: QuestionnaireResult | null | undefined,
): HandoffChoice {
  if (!result || typeof result !== "object") return { choice: "dismiss" };
  if ((result as { cancelled?: unknown }).cancelled === true) {
    return { choice: "dismiss" };
  }
  const answers = (result as { answers?: unknown }).answers;
  const first = Array.isArray(answers) ? answers[0] : undefined;
  if (!first || typeof first !== "object") return { choice: "dismiss" };
  const record = first as { answer?: unknown; wasCustom?: unknown };
  const answer =
    typeof record.answer === "string" ? record.answer.trim() : "";
  if (record.wasCustom === true) {
    return answer ? { choice: "refine", feedback: answer } : { choice: "dismiss" };
  }
  const normalized = normalize(answer);
  if (
    normalized === normalize(HANDOFF_APPROVE_LABEL) ||
    normalized === normalize(HANDOFF_APPROVE_ORCHESTRATOR_LABEL) ||
    normalized === normalize(HANDOFF_APPROVE_BUILD_LABEL)
  ) {
    return { choice: "approve" };
  }
  if (normalized === normalize(HANDOFF_FEEDBACK_LABEL)) {
    return { choice: "refine" };
  }
  return { choice: "dismiss" };
}
