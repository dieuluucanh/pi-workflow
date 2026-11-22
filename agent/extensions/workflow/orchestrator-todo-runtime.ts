/**
 * Workflow Extension — TODO ownership (integration step 21).
 *
 * Three lists must never overwrite each other:
 *
 *   - an ordinary session's Plan/Build todos (unchanged behaviour);
 *   - the PARENT roadmap projection (derived from accepted task coverage);
 *   - a managed child's task-local todos (`orchestrator-worker-todos.ts`).
 *
 * The parent projection is read-only with respect to the roadmap: a checkbox,
 * `[DONE:n]` tag or child completion can display progress but cannot accept a
 * task or schedule the next one. That is what makes "completion is derived from
 * acceptance" true instead of aspirational.
 */

import { projectTodos, type RunState } from "./orchestrator-state.ts";

export const TODO_OWNER_SCHEMA_VERSION = 1 as const;

export type TodoOwner = "ordinary" | "parent" | "worker";

export interface OwnedTodo {
  /** Display ref within THIS list; never a durable id. */
  ref: number;
  text: string;
  status: "pending" | "in_progress" | "completed" | "cancelled";
  taskId?: string;
  /** Only an accepted task's coverage is `completed` in the parent list. */
  acceptedCoverage: boolean;
}

export interface ParentTodoProjection {
  owner: "parent";
  runId: string;
  items: OwnedTodo[];
  /** True only when every requirement is covered by an accepted task. */
  complete: boolean;
  counts: { accepted: number; pending: number; blocked: number; cancelled: number };
}

/** The parent roadmap projection. Display-only; never a scheduler input. */
export function parentRoadmapTodos(state: RunState): ParentTodoProjection {
  const projected = projectTodos(state);
  const items: OwnedTodo[] = projected.map((entry) => {
    const task = state.tasks[entry.taskId];
    return {
      ref: entry.ref,
      text: entry.text,
      status: entry.status,
      taskId: entry.taskId,
      acceptedCoverage: task?.state === "accepted",
    };
  });
  const counts = { accepted: 0, pending: 0, blocked: 0, cancelled: 0 };
  for (const taskId of state.order) {
    const task = state.tasks[taskId];
    if (!task) continue;
    if (task.state === "accepted") counts.accepted += 1;
    else if (task.state === "blocked") counts.blocked += 1;
    else if (task.state === "cancelled" || task.state === "superseded") counts.cancelled += 1;
    else counts.pending += 1;
  }
  const complete =
    state.order.length > 0 &&
    state.order.every((taskId) => state.tasks[taskId]?.state === "accepted");
  return { owner: "parent", runId: state.runId, items, complete, counts };
}

export interface TodoMutationDecision {
  allowed: boolean;
  owner: TodoOwner;
  reason?: string;
}

/**
 * Who may mutate which list. A worker/ordinary list update can never move the
 * parent roadmap, and a parent checkbox change is display-only.
 */
export function todoMutationDecision(
  owner: TodoOwner,
  action: "list" | "update" | "done" | "pending" | "add" | "toggle" | "sync" | "clear",
): TodoMutationDecision {
  if (owner === "parent" && action !== "list") {
    return {
      allowed: false,
      owner,
      reason:
        "The parent roadmap list is a projection of accepted coverage; use acceptance/repair decisions instead of editing it.",
    };
  }
  return { allowed: true, owner };
}

/** A child or ordinary completion can never be routed into parent acceptance. */
export function todoEffectsTarget(owner: TodoOwner): {
  parentRoadmap: false;
  commit: false;
  parentTodos: false;
} {
  void owner;
  return { parentRoadmap: false, commit: false, parentTodos: false };
}

/**
 * Reconciles `- [x]` checkboxes from a plan file into the PARENT view without
 * accepting anything: it returns the claimed-complete refs for display, and an
 * empty acceptance list. (Roadmap ingestion already records claimed state.)
 */
export function reconcileCheckboxClaims(input: {
  state: RunState;
  completedRefs: readonly number[];
}): { displayOnly: true; acceptedTaskIds: string[]; claimedRefs: number[] } {
  const ids = new Set(input.state.order);
  const claimedRefs = [...new Set(input.completedRefs)].filter(
    (ref) => Number.isInteger(ref) && ref >= 1 && ref <= input.state.order.length,
  );
  for (const ref of claimedRefs) {
    const taskId = input.state.order[ref - 1];
    if (taskId) ids.add(taskId);
  }
  // A checkbox is a claim: it never becomes acceptance.
  return { displayOnly: true, acceptedTaskIds: [], claimedRefs };
}
