/**
 * Workflow Extension — parent orchestration tools.
 *
 * The model sees exactly six tools: start, status, verify, accept, repair and
 * retry. There is no propose/preview/approval tool and no model-facing
 * dispatch: the extension's scheduler dispatches the next frozen row itself.
 *
 * Each handler validates a decision against the durable `RunState` and returns
 * the exact reducer event the runtime must journal. A read-only status returns
 * a receipt without an event. Acceptance evidence is never model-supplied: the
 * caller passes what the verification runtime captured.
 *
 * Nothing here launches a process, calls a model or writes a file.
 */

import type { RunEvent, RunState } from "./orchestrator-state.ts";
import { taskCounts, rowForTask } from "./orchestrator-state.ts";

export const TOOLS_SCHEMA_VERSION = 1 as const;
export const MAX_RECEIPT_TEXT = 1_000;
export const MAX_STATUS_ROWS = 100;
export const MAX_STEPS = 200;

// ── Tool descriptors ─────────────────────────────────────────────────

export const ORCHESTRATOR_TOOL_NAMES = [
  "orchestrator_start",
  "orchestrator_status",
  "orchestrator_verify",
  "orchestrator_repair",
  "orchestrator_accept",
  "orchestrator_retry",
] as const;

export type OrchestratorToolName = (typeof ORCHESTRATOR_TOOL_NAMES)[number];

export interface ToolSpec {
  name: OrchestratorToolName;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, unknown>;
    required: string[];
    additionalProperties: false;
  };
  bounded: true;
}

const TASK_PARAM = {
  type: "string",
  description: "Frozen task id (task-<ref>) from orchestrator_status.",
} as const;

export const ORCHESTRATOR_TOOLS: readonly ToolSpec[] = [
  {
    name: "orchestrator_start",
    description:
      "Start an Orchestrator run: freeze the approved plan or the explicitly agreed standalone steps into one TODO row per step, then dispatch the first visible Build child. Call only after the user agrees; never ask for a separate execution approval.",
    parameters: {
      type: "object",
      properties: {
        planPath: {
          type: "string",
          description: "Absolute approved plan path. Omit when using explicit standalone steps.",
        },
        title: { type: "string", description: "Short title for a standalone run." },
        steps: {
          type: "array",
          items: { type: "string" },
          description: "Explicitly agreed standalone steps; one frozen TODO row each.",
        },
      },
      required: [],
      additionalProperties: false,
    },
    bounded: true,
  },
  {
    name: "orchestrator_status",
    description:
      "Read the frozen run projection: phase, row states, the next row and any blocker. Read-only.",
    parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
    bounded: true,
  },
  {
    name: "orchestrator_verify",
    description:
      "Verify the current candidate against the row's diff and plan checks. The parent captures the evidence; the model cannot supply it.",
    parameters: {
      type: "object",
      properties: { taskId: TASK_PARAM },
      required: ["taskId"],
      additionalProperties: false,
    },
    bounded: true,
  },
  {
    name: "orchestrator_repair",
    description:
      "Send one scoped repair round to the same child after a failed verification. Bounded to two rounds.",
    parameters: {
      type: "object",
      properties: {
        taskId: TASK_PARAM,
        reason: { type: "string", description: "Concrete, bounded repair reason." },
      },
      required: ["taskId", "reason"],
      additionalProperties: false,
    },
    bounded: true,
  },
  {
    name: "orchestrator_accept",
    description:
      "Accept a verified row and let the scheduler dispatch the next one. Evidence is runtime-owned.",
    parameters: {
      type: "object",
      properties: { taskId: TASK_PARAM },
      required: ["taskId"],
      additionalProperties: false,
    },
    bounded: true,
  },
  {
    name: "orchestrator_retry",
    description:
      "Recovery only: retry the next pending frozen row after a dispatch failure. The scheduler normally dispatches automatically.",
    parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
    bounded: true,
  },
];

// ── Tool context and results ─────────────────────────────────────────

/** Runtime-captured acceptance evidence for one verified row. */
export interface VerificationEvidence {
  taskId: string;
  evidenceId: string;
  workspaceRevision: string;
}

export interface ToolContext {
  state: RunState;
  now: number;
  /** Owning runtime epoch; a stale reference is refused. */
  epoch: number;
  currentEpoch: number;
  /** Evidence captured by `orchestrator_verify`, keyed by task id. */
  evidence?: ReadonlyMap<string, VerificationEvidence>;
}

export type ToolErrorCode =
  | "invalid"
  | "stale_epoch"
  | "state"
  | "unavailable";

export type ToolResult =
  | {
      ok: true;
      tool: OrchestratorToolName;
      receipt: ToolReceipt;
      /** The caller applies this exact event; absent for reads. */
      event?: RunEvent;
    }
  | { ok: false; code: ToolErrorCode; error: string };

export interface ToolReceipt {
  kind: "status" | "verification" | "repair" | "acceptance" | "retry";
  runId: string;
  revision: number;
  summary: string;
  taskId?: string;
  nextTaskId?: string;
  counts?: { total: number; accepted: number; pending: number; running: number; blocked: number };
  rows?: Array<{ taskId: string; ref: string; status: string; text: string }>;
  blockedReason?: string;
  truncated?: boolean;
}

function fail(code: ToolErrorCode, error: string): ToolResult {
  return { ok: false, code, error };
}

function findTask(state: RunState, taskId: unknown): string | undefined {
  return typeof taskId === "string" && state.tasks[taskId] ? taskId : undefined;
}

function text(value: unknown, max = MAX_RECEIPT_TEXT): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.replace(/\s+/g, " ").trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.slice(0, max);
}

export function handleOrchestratorTool(
  name: OrchestratorToolName,
  raw: unknown,
  ctx: ToolContext,
): ToolResult {
  if (ctx.epoch !== ctx.currentEpoch) {
    return fail("stale_epoch", "this tool handle belongs to a previous runtime epoch");
  }
  const params =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const state = ctx.state;

  switch (name) {
    case "orchestrator_status": {
      const counts = taskCounts(state);
      const rows = state.order.slice(0, MAX_STATUS_ROWS).map((taskId) => {
        const row = rowForTask(state, taskId);
        return {
          taskId,
          ref: row?.ref ?? "?",
          status: state.tasks[taskId]?.state ?? "unknown",
          text: (row?.text ?? "").slice(0, 200),
        };
      });
      const next = state.order.find((taskId) => state.tasks[taskId]?.state === "pending");
      return {
        ok: true,
        tool: name,
        receipt: {
          kind: "status",
          runId: state.runId,
          revision: state.revision,
          summary:
            `${state.phase} · ${counts.accepted}/${counts.total} accepted` +
            (next ? ` · next: ${next}` : "") +
            (state.blockedReason ? ` · blocked: ${state.blockedReason}` : ""),
          ...(next === undefined ? {} : { nextTaskId: next }),
          counts,
          rows,
          ...(state.blockedReason === undefined ? {} : { blockedReason: state.blockedReason }),
          truncated: rows.length < state.order.length,
        },
      };
    }

    case "orchestrator_verify": {
      const taskId = findTask(state, params.taskId);
      if (!taskId) return fail("state", "unknown task");
      const task = state.tasks[taskId]!;
      if (task.state !== "candidate") {
        return fail("state", `cannot verify a ${task.state} row`);
      }
      return {
        ok: true,
        tool: name,
        receipt: {
          kind: "verification",
          runId: state.runId,
          revision: state.revision,
          taskId,
          summary: `Verifying ${taskId} against the captured diff and row checks.`,
        },
        event: {
          type: "task.verify",
          runId: state.runId,
          expectedRevision: state.revision,
          now: ctx.now,
          taskId,
        },
      };
    }

    case "orchestrator_repair": {
      const taskId = findTask(state, params.taskId);
      if (!taskId) return fail("state", "unknown task");
      const reason = text(params.reason, 1_000);
      if (!reason) return fail("invalid", "a concrete repair reason is required");
      const task = state.tasks[taskId]!;
      if (task.state === "accepted") return fail("state", "an accepted row cannot be repaired");
      if (task.repairRounds >= 2) {
        return fail("state", "the repair budget is exhausted; retry or stop the run");
      }
      return {
        ok: true,
        tool: name,
        receipt: {
          kind: "repair",
          runId: state.runId,
          revision: state.revision,
          taskId,
          summary: `Scoped repair round ${task.repairRounds + 1}/2: ${reason}`,
        },
        event: {
          type: "task.needsFix",
          runId: state.runId,
          expectedRevision: state.revision,
          now: ctx.now,
          taskId,
          reason,
        },
      };
    }

    case "orchestrator_accept": {
      const taskId = findTask(state, params.taskId);
      if (!taskId) return fail("state", "unknown task");
      const task = state.tasks[taskId]!;
      if (task.state === "accepted") {
        return {
          ok: true,
          tool: name,
          receipt: {
            kind: "acceptance",
            runId: state.runId,
            revision: state.revision,
            taskId,
            summary: `${taskId} is already accepted.`,
          },
        };
      }
      const evidence = ctx.evidence?.get(taskId);
      if (!evidence) {
        return fail(
          "unavailable",
          "Acceptance evidence is runtime-owned. Run orchestrator_verify; a model-supplied object cannot mint a pass.",
        );
      }
      if (task.state !== "candidate") {
        return fail("state", `cannot accept a ${task.state} row`);
      }
      return {
        ok: true,
        tool: name,
        receipt: {
          kind: "acceptance",
          runId: state.runId,
          revision: state.revision,
          taskId,
          summary: `Accepting ${taskId} with evidence ${evidence.evidenceId}.`,
        },
        event: {
          type: "task.accept",
          runId: state.runId,
          expectedRevision: state.revision,
          now: ctx.now,
          taskId,
          evidenceId: evidence.evidenceId,
          workspaceRevision: evidence.workspaceRevision,
        },
      };
    }

    case "orchestrator_retry": {
      const taskId =
        typeof params.taskId === "string" && state.tasks[params.taskId]
          ? params.taskId
          : state.order.find((id) => {
              const task = state.tasks[id];
              return task?.state === "blocked" || task?.state === "needs_fix";
            });
      if (!taskId) return fail("state", "no blocked or repaired row is waiting for a retry");
      return {
        ok: true,
        tool: name,
        receipt: {
          kind: "retry",
          runId: state.runId,
          revision: state.revision,
          taskId,
          summary: `Retrying ${taskId}; the scheduler will dispatch it when the child host is ready.`,
        },
        event: {
          type: "task.retry",
          runId: state.runId,
          expectedRevision: state.revision,
          now: ctx.now,
          taskId,
        },
      };
    }

    case "orchestrator_start":
      return fail("state", "start is handled by the extension start service, not the pure tool layer");

    default:
      return fail("unavailable", `unknown orchestration tool ${String(name)}`);
  }
}
