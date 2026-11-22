/**
 * Workflow Extension — deterministic execution approval and auto-start.
 *
 * Approval and “go ahead” are one host action, but they are deliberately two
 * durable effects in this order:
 *
 *   1. persist the execution approval (the runtime journals it);
 *   2. dispatch the next dependency-ready task through the existing dispatch
 *      port.
 *
 * A failed dispatch does not roll the approval back: the user approved a
 * digest-bound breakdown, and the failure is a real host/model blocker that must
 * be reported instead of silently repeating the approval.
 *
 * The module is pure: `index.ts` supplies the runtime, the dispatch call and the
 * UI answer. That keeps the decision matrix testable without a terminal.
 */

import {
  APPROVAL_CONFIRMATION,
  type ExecutionPreview,
} from "./orchestrator-approval.ts";
import type { BreakdownApprovalDecision } from "./orchestrator-approval-view.ts";
import { previewApprovalId } from "./orchestrator-preview-view.ts";

export interface ApprovalFlowView {
  runId: string;
  preview: Pick<ExecutionPreview, "approvalDigest"> | null;
  nextTaskId?: string;
  state: {
    mutation?: unknown;
    tasks: Record<
      string,
      { attempts: readonly { attemptId: string }[] } | undefined
    >;
  };
}

export type ApprovalFlowPorts = {
  view: () => ApprovalFlowView | undefined;
  approve: (input: {
    confirmation: string;
    approvalId: string;
  }) => Promise<{ ok: true } | { ok: false; error: string }>;
  refine: (
    reason: string,
  ) => Promise<{ ok: true } | { ok: false; error: string }>;
  canDispatch: () => { ok: boolean; reasons: readonly string[] };
  dispatch: (input: {
    taskId: string;
    attemptId: string;
  }) => Promise<{ ok: boolean; text: string }>;
};

export type AutoStartResult = {
  ok: boolean;
  started: boolean;
  code?: "unavailable" | "busy" | "approval" | "state" | "idle" | "dispatch";
  text: string;
  taskId?: string;
  attemptId?: string;
};

function sanitizeAttemptPart(value: string): string {
  const cleaned = value
    .replace(/[^A-Za-z0-9._-]/g, "-")
    .replace(/^-+|-+$/g, "");
  return (cleaned.length > 0 ? cleaned : "task").slice(0, 80);
}

/**
 * Stable attempt id for an automatic first dispatch.
 *
 * The dispatch tool requires `^attempt-[A-Za-z0-9._-]{1,96}$`. The task prefix
 * is kept short enough that the prefix + counter always fit, and an existing id
 * is never reused.
 */
export function nextAttemptIdFor(
  taskId: string,
  attempts: readonly { attemptId: string }[] = [],
): string {
  const base = sanitizeAttemptPart(taskId.replace(/^task-/, ""));
  const used = new Set(attempts.map((attempt) => attempt.attemptId));
  let number = attempts.length + 1;
  let candidate = `attempt-${base}-${number}`;
  while (used.has(candidate)) {
    number += 1;
    candidate = `attempt-${base}-${number}`;
  }
  return candidate.slice(0, 96);
}

/**
 * Dispatch the next ready task once. The caller must already have a live
 * approval; `canDispatch()` is still re-checked here so a stale/revoked approval
 * can never launch from an old dialog answer.
 */
export async function startNextReadyTask(
  ports: Pick<ApprovalFlowPorts, "view" | "canDispatch" | "dispatch">,
): Promise<AutoStartResult> {
  const view = ports.view();
  if (!view) {
    return {
      ok: false,
      started: false,
      code: "unavailable",
      text: "No orchestrator run is bound to this session; nothing was dispatched.",
    };
  }
  if (view.state.mutation) {
    return {
      ok: false,
      started: false,
      code: "busy",
      text: "A child already holds the workspace mutation grant; no second task was dispatched.",
    };
  }
  const dispatchable = ports.canDispatch();
  if (!dispatchable.ok) {
    return {
      ok: false,
      started: false,
      code: "approval",
      text: `The run is not dispatchable: ${dispatchable.reasons.join("; ")}. Nothing was dispatched.`,
    };
  }
  const taskId = view.nextTaskId;
  if (!taskId) {
    return {
      ok: true,
      started: false,
      code: "idle",
      text: "Execution is approved, but no dependency-ready task is available yet; nothing was dispatched.",
    };
  }
  const task = view.state.tasks[taskId];
  if (!task) {
    return {
      ok: false,
      started: false,
      code: "state",
      text: `The next task ${taskId} is missing from the run state; nothing was dispatched.`,
    };
  }
  const attemptId = nextAttemptIdFor(taskId, task.attempts);
  const dispatched = await ports.dispatch({ taskId, attemptId });
  return {
    ok: dispatched.ok,
    started: dispatched.ok,
    code: "dispatch",
    text: dispatched.text,
    taskId,
    attemptId,
  };
}

export type BreakdownApprovalStatus =
  | "approved"
  | "revised"
  | "denied"
  | "dismissed"
  | "stale"
  | "error";

export interface BreakdownApprovalResult {
  ok: boolean;
  status: BreakdownApprovalStatus;
  text: string;
  details?: Record<string, unknown>;
}

export interface ApplyBreakdownApprovalInput {
  decision: BreakdownApprovalDecision;
  /** The preview the user actually saw. A changed digest invalidates the answer. */
  expected: { runId: string; approvalDigest: string };
  ports: ApprovalFlowPorts;
}

function stale(expected: ApplyBreakdownApprovalInput["expected"]): BreakdownApprovalResult {
  return {
    ok: false,
    status: "stale",
    text: `The breakdown changed while the approval dialog was open (expected ${expected.approvalDigest.slice(0, 12)}, current preview differs). Nothing was approved or dispatched.`,
  };
}

/**
 * Apply one dialog answer. Approval is journaled before dispatch; deny/revise
 * call the runtime refine path so the preview cannot be approved later.
 */
export async function applyBreakdownApprovalDecision(
  input: ApplyBreakdownApprovalInput,
): Promise<BreakdownApprovalResult> {
  const current = input.ports.view();
  if (!current) {
    return {
      ok: false,
      status: "error",
      text: "No orchestrator run is bound to this session; nothing was approved.",
    };
  }
  if (
    current.runId !== input.expected.runId ||
    !current.preview ||
    current.preview.approvalDigest !== input.expected.approvalDigest
  ) {
    return stale(input.expected);
  }

  if (input.decision.choice === "dismiss") {
    return {
      ok: true,
      status: "dismissed",
      text: "The approval dialog was dismissed. The breakdown is still pending; nothing was approved or dispatched.",
    };
  }

  if (input.decision.choice === "revise") {
    const refined = await input.ports.refine(
      `user feedback on the breakdown: ${input.decision.feedback}`,
    );
    if (!refined.ok) {
      return {
        ok: false,
        status: "error",
        text: `The breakdown could not be invalidated: ${refined.error}. Nothing was dispatched.`,
      };
    }
    return {
      ok: true,
      status: "revised",
      text: [
        `The user asked for changes: ${input.decision.feedback}`,
        "The previous breakdown was invalidated durably. Propose a revised breakdown now with orchestrator_propose_tasks; do not dispatch.",
      ].join("\n"),
      details: { feedback: input.decision.feedback },
    };
  }

  if (input.decision.choice === "deny") {
    const refined = await input.ports.refine(
      "the user denied the proposed breakdown",
    );
    if (!refined.ok) {
      return {
        ok: false,
        status: "error",
        text: `The breakdown could not be invalidated: ${refined.error}. Nothing was dispatched.`,
      };
    }
    return {
      ok: true,
      status: "denied",
      text: "The user denied this breakdown. The preview was invalidated durably. Stay in Orchestrator mode and wait for the user's next instruction; do not propose or dispatch until they reply.",
    };
  }

  const approvalId = previewApprovalId(current.preview);
  const approved = await input.ports.approve({
    confirmation: APPROVAL_CONFIRMATION,
    approvalId,
  });
  if (!approved.ok) {
    return {
      ok: false,
      status: "error",
      text: `Execution approval was not recorded: ${approved.error}. Nothing was dispatched.`,
    };
  }

  const started = await startNextReadyTask(input.ports);
  if (started.ok) {
    return {
      ok: true,
      status: "approved",
      text: [`Execution approved (${approvalId}).`, started.text].join("\n"),
      details: {
        approvalId,
        started: started.started,
        ...(started.taskId ? { taskId: started.taskId } : {}),
        ...(started.attemptId ? { attemptId: started.attemptId } : {}),
      },
    };
  }
  return {
    ok: false,
    status: "approved",
    text: [
      `Execution approved (${approvalId}), but the first dispatch did not start: ${started.text}`,
      "The approval remains valid. Fix the blocker, then dispatch the ready task explicitly; do not re-approve.",
    ].join("\n"),
    details: {
      approvalId,
      started: false,
      ...(started.taskId ? { taskId: started.taskId } : {}),
      ...(started.attemptId ? { attemptId: started.attemptId } : {}),
    },
  };
}
