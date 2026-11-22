/**
 * Workflow Extension — the Orchestrator execution-approval question.
 *
 * This is the Orchestrator equivalent of `handoff-execution-view.ts`: it is
 * pure and host-free, so the answer matrix is unit-testable without a terminal.
 *
 * The fixed rows are deliberately only APPROVE and DENY. The questionnaire's
 * built-in freeform row is the “deny with a change” path: typed text becomes
 * revision feedback, never an approval. Cancel/unknown always dismiss.
 */

import type { ExecutionPreview } from "./orchestrator-approval.ts";
import type {
  QuestionnaireOption,
  QuestionnaireQuestion,
  QuestionnaireResult,
} from "./questionnaire-view.ts";
import {
  formatExecutionPreview,
  type PreviewRequirement,
} from "./orchestrator-preview-view.ts";

export const BREAKDOWN_QUESTION_HEADER = "Execution approval";
export const BREAKDOWN_APPROVE_LABEL =
  "Approve execution — start the next ready task";
export const BREAKDOWN_DENY_LABEL = "Deny — stay in Orchestrator";

export interface BreakdownApprovalQuestionInput {
  preview: ExecutionPreview;
  requirements?: readonly PreviewRequirement[];
  fromDiscussion?: boolean;
  dirtyChanges?: number;
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Builds the one approval question. The full digest-bound preview is the
 * scrollable context, so the user sees exactly what will be approved.
 */
export function buildBreakdownApprovalQuestion(
  input: BreakdownApprovalQuestionInput,
): QuestionnaireQuestion {
  const options: QuestionnaireOption[] = [
    {
      label: BREAKDOWN_APPROVE_LABEL,
      description:
        "Record the execution approval and start the next dependency-ready task now (recommended)",
    },
    {
      label: BREAKDOWN_DENY_LABEL,
      description:
        "Invalidate this breakdown and stay in Orchestrator. Type a change in the freeform row instead to ask for a revision.",
    },
  ];
  return {
    header: BREAKDOWN_QUESTION_HEADER,
    question: "Execution breakdown ready — approve it?",
    context: formatExecutionPreview({
      preview: input.preview,
      ...(input.requirements ? { requirements: input.requirements } : {}),
      ...(input.fromDiscussion === undefined
        ? {}
        : { fromDiscussion: input.fromDiscussion }),
      ...(input.dirtyChanges === undefined
        ? {}
        : { dirtyChanges: input.dirtyChanges }),
      approvalHint: "dialog",
    }),
    options,
  };
}

/**
 * The user's decision.
 *
 * - `approve` is returned ONLY for the exact approve row;
 * - `deny` is the exact deny row (durable invalidation);
 * - `revise` carries non-empty freeform text (treated as feedback);
 * - `dismiss` covers Esc/cancel/empty/unknown/malformed and never approves.
 */
export type BreakdownApprovalDecision =
  | { choice: "approve" }
  | { choice: "deny" }
  | { choice: "revise"; feedback: string }
  | { choice: "dismiss" };

export function breakdownApprovalDecisionFromResult(
  result: QuestionnaireResult | null | undefined,
): BreakdownApprovalDecision {
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
    return answer.length > 0
      ? { choice: "revise", feedback: answer }
      : { choice: "dismiss" };
  }
  const normalized = normalize(answer);
  if (normalized === normalize(BREAKDOWN_APPROVE_LABEL)) {
    return { choice: "approve" };
  }
  if (normalized === normalize(BREAKDOWN_DENY_LABEL)) {
    return { choice: "deny" };
  }
  return { choice: "dismiss" };
}
