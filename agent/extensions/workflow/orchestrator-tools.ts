/**
 * Workflow Extension — parent orchestration tools.
 *
 * The model sees exactly three tools: start, status and retry. Verification,
 * acceptance and repair are automatic: `orchestrator-advance.ts` decides from
 * the child's settle, the row checks and the attributable diff. There is no
 * model-facing dispatch and no model-supplied evidence.
 *
 * Nothing here launches a session, calls a model or writes a file.
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

export const ORCHESTRATOR_TOOLS: readonly ToolSpec[] = [
  {
    name: "orchestrator_start",
    description:
      "Start an Orchestrator run: freeze the approved plan or the explicitly agreed standalone steps into one TODO row per step, then dispatch the first in-process Build child (no new window or tab). Call only after the user agrees; never ask for a separate execution approval.",
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
      "Read the frozen run projection: phase, row states, the next row, the active child and any blocker. Read-only.",
    parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
    bounded: true,
  },
  {
    name: "orchestrator_retry",
    description:
      "Recovery only: retry a blocked or repaired frozen row and start a fresh in-process Build child for it. Healthy rows advance automatically; the scheduler normally dispatches without this tool.",
    parameters: {
      type: "object",
      properties: {
        taskId: {
          type: "string",
          description: "Frozen task id (task-<ref>). Omit to retry the first blocked/repaired row.",
        },
      },
      required: [],
      additionalProperties: false,
    },
    bounded: true,
  },
];

// ── Tool context and results ─────────────────────────────────────────

export interface ToolContext {
  state: RunState;
  now: number;
  /** Owning runtime epoch; a stale reference is refused. */
  epoch: number;
  currentEpoch: number;
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
  kind: "status" | "retry";
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

    case "orchestrator_retry": {
      const requested =
        typeof params.taskId === "string" && state.tasks[params.taskId]
          ? params.taskId
          : undefined;
      if (typeof params.taskId === "string" && params.taskId && !requested) {
        return fail("state", `unknown task ${params.taskId}`);
      }
      const taskId =
        requested ??
        state.order.find((id) => {
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
          summary: `Retrying ${taskId}; a fresh in-process Build child will start for it.`,
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
