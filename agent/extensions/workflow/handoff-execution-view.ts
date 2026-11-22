/**
 * Workflow Extension — the execution chooser (stage 2 of a plan handoff).
 *
 * This module is the ONLY place that turns a user answer into an execution
 * destination. It is asked after a plan has been APPROVED, never before and
 * never as part of the plan question, so:
 *
 *   - a saved `workflow.handoff.executionMode` is a recommendation, not consent;
 *   - cancelling the chooser keeps the approval and starts nothing;
 *   - an unknown/freeform answer can never fall back to direct Build.
 *
 * Pure and host-free, mirroring `handoff-view.ts`, so the answer matrix is
 * unit-testable without a terminal.
 */

import type {
  QuestionnaireOption,
  QuestionnaireQuestion,
  QuestionnaireResult,
} from "./questionnaire-view.ts";
import type { HandoffDestination } from "./handoff-routing.ts";

/** Header tab of the execution question. */
export const EXECUTION_QUESTION_HEADER = "Execution";

/** Approve into Orchestrator preparation (a second, separate approval follows). */
export const EXECUTION_ORCHESTRATOR_LABEL =
  "Orchestrator — prepare an execution breakdown";
/** Approve into this session's Build mode and start now. */
export const EXECUTION_BUILD_LABEL =
  "Direct Build — execute in this session now";
/** Keep the approval; start nothing and stay in Plan. */
export const EXECUTION_LATER_LABEL = "Decide later (stay in Plan)";

export interface ExecutionQuestionInput {
  planPath: string;
  /** The pending decision's printed id, so the user can resume it later. */
  decisionId: string;
  /** Saved/one-off recommendation; earns the first row and "recommended". */
  recommended?: HandoffDestination;
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

/** Label for a destination row. */
export function executionLabel(destination: HandoffDestination): string {
  return destination === "orchestrator"
    ? EXECUTION_ORCHESTRATOR_LABEL
    : EXECUTION_BUILD_LABEL;
}

/** One-line meaning of a destination, for the row description and notices. */
export function describeExecutionChoice(destination: HandoffDestination): string {
  return destination === "orchestrator"
    ? "Enter Orchestrator, prepare a validated breakdown, and approve that separately before any Build child starts"
    : "Enter this session's Build mode and start implementing the approved plan now";
}

/**
 * Build the execution question. The recommended destination is first; the
 * other remains a first-class choice. Cancelling is always available through
 * the questionnaire's own cancel row.
 */
export function buildExecutionQuestion(
  input: ExecutionQuestionInput,
): QuestionnaireQuestion {
  const recommended: HandoffDestination = input.recommended ?? "orchestrator";
  const alternate: HandoffDestination =
    recommended === "orchestrator" ? "build" : "orchestrator";
  const options: QuestionnaireOption[] = [
    {
      label: executionLabel(recommended),
      description: `${describeExecutionChoice(recommended)} (recommended)`,
    },
    {
      label: executionLabel(alternate),
      description: describeExecutionChoice(alternate),
    },
    {
      label: EXECUTION_LATER_LABEL,
      description:
        "Keep the approval and stay in Plan; resume with /handoff continue",
    },
  ];
  return {
    header: EXECUTION_QUESTION_HEADER,
    question: "Plan approved — where should it run?",
    context: [
      `Plan: ${input.planPath || "(no plan file)"}`,
      `Handoff: ${input.decisionId || "(unknown)"}`,
      "This choice applies to this approved plan only; your saved default is unchanged.",
      "Nothing has run yet.",
    ].join("\n"),
    options,
  };
}

/**
 * Stage-2 answer.
 *
 * - `execute` is returned ONLY for an exact destination row;
 * - `defer` covers later/cancel/unknown/malformed: the approval is preserved and
 *   nothing executes.
 */
export type ExecutionChoice =
  | { choice: "execute"; destination: HandoffDestination }
  | { choice: "defer" };

export function executionChoiceFromResult(
  result: QuestionnaireResult | null | undefined,
): ExecutionChoice {
  if (!result || typeof result !== "object") return { choice: "defer" };
  if ((result as { cancelled?: unknown }).cancelled === true) {
    return { choice: "defer" };
  }
  const answers = (result as { answers?: unknown }).answers;
  const first = Array.isArray(answers) ? answers[0] : undefined;
  if (!first || typeof first !== "object") return { choice: "defer" };
  const record = first as { answer?: unknown; wasCustom?: unknown };
  // Freeform text in stage 2 is not a destination; never guess Build.
  if (record.wasCustom === true) return { choice: "defer" };
  const answer = typeof record.answer === "string" ? record.answer.trim() : "";
  const normalized = normalize(answer);
  if (normalized === normalize(EXECUTION_ORCHESTRATOR_LABEL)) {
    return { choice: "execute", destination: "orchestrator" };
  }
  if (normalized === normalize(EXECUTION_BUILD_LABEL)) {
    return { choice: "execute", destination: "build" };
  }
  return { choice: "defer" };
}
