/**
 * Workflow Extension — TODO ownership for orchestration.
 *
 * The session `TodoStore` is the single list authority. An Orchestrator run
 * installs its frozen snapshot there, so this module is only the read-only
 * projection and mutation guard used by `workflow_todo`:
 *
 *   - a parent/Orchestrator list is a projection of frozen rows + task state;
 *   - a checkbox or `[DONE:n]` tag is a claim, never acceptance;
 *   - only `orchestrator_verify` + `orchestrator_accept` move a row.
 */

import { rowForTask, taskCounts, type RunState } from "./orchestrator-state.ts";

export const TODO_OWNER_SCHEMA_VERSION = 1 as const;

export type TodoOwner = "ordinary" | "parent" | "worker";

export interface OwnedTodo {
  /** Display ref within THIS list; never a durable id. */
  ref: number;
  text: string;
  status: "pending" | "in_progress" | "completed" | "cancelled";
  taskId?: string;
  /** True only for an accepted frozen row. */
  acceptedCoverage: boolean;
}

export interface ParentTodoProjection {
  owner: "parent";
  runId: string;
  items: OwnedTodo[];
  /** True only when every frozen row is accepted. */
  complete: boolean;
  counts: { accepted: number; pending: number; blocked: number; cancelled: number };
}

/** The parent projection. Display-only; never a scheduler input. */
export function parentRoadmapTodos(state: RunState): ParentTodoProjection {
  const items: OwnedTodo[] = state.order.map((taskId, index) => {
    const task = state.tasks[taskId];
    const row = rowForTask(state, taskId);
    const status: OwnedTodo["status"] =
      task?.state === "accepted"
        ? "completed"
        : task?.state === "blocked"
          ? "pending"
          : task?.state === "pending"
            ? "pending"
            : "in_progress";
    return {
      ref: index + 1,
      text: row?.text ?? "",
      status,
      taskId,
      acceptedCoverage: task?.state === "accepted",
    };
  });
  const counts = taskCounts(state);
  return {
    owner: "parent",
    runId: state.runId,
    items,
    complete: state.order.length > 0 && counts.accepted === state.order.length,
    counts: {
      accepted: counts.accepted,
      pending: counts.pending + counts.running,
      blocked: counts.blocked,
      cancelled: 0,
    },
  };
}

export interface TodoMutationDecision {
  allowed: boolean;
  owner: TodoOwner;
  reason?: string;
}

/**
 * Who may mutate which list. A parent/Orchestrator list is read-only: the run
 * owns acceptance, and status edits would silently diverge from the journal.
 */
export function todoMutationDecision(
  owner: TodoOwner,
  action: "list" | "update" | "done" | "pending" | "add" | "toggle" | "sync" | "clear",
): TodoMutationDecision {
  if (owner === "parent") {
    return action === "list"
      ? { allowed: true, owner }
      : {
          allowed: false,
          owner,
          reason:
            "The Orchestrator list is frozen; use orchestrator_verify and orchestrator_accept to move a row.",
        };
  }
  return { allowed: true, owner };
}
