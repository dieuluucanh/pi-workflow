/**
 * Workflow Extension — pure frozen-run state machine.
 *
 * The journal persists decisions; this module decides whether a decision is
 * legal at all. It is pure: no clock, filesystem, session or model. Every event
 * carries the revision it was computed against, so a stale caller fails closed.
 *
 * Deliberate simplifications (orchestrator simplification plan, step 9):
 *   - the frozen TODO snapshot is the ONLY row/text/check authority;
 *   - a task is one frozen row, so there is no dependency graph, coverage map,
 *     attempt history, budget counter or mutation lease;
 *   - the states are exactly `pending | running | candidate | needs_fix |
 *     accepted | blocked` and the phases are exactly the seven a user sees.
 *
 * Invariants:
 *   - a foreign run id or a stale revision is refused;
 *   - `accepted` is reachable only from `candidate` after a verification;
 *   - `completed` requires every row accepted;
 *   - a repair round is bounded by a hard-coded cap, so a failing row blocks
 *     instead of retrying forever.
 */

import {
  ORCHESTRATOR_SCHEMA_VERSION,
  canTransitionRun,
  type RunId,
  type RunPhase,
  type TaskId,
  type TaskState,
} from "./orchestrator-types.ts";
import type { FrozenTodoSnapshot, FrozenTodoRow } from "./todo-snapshot.ts";

export const STATE_SCHEMA_VERSION = ORCHESTRATOR_SCHEMA_VERSION;

/** A failing row may be repaired at most this many times. */
export const MAX_REPAIR_ROUNDS = 2;

export type StateErrorCode =
  | "stale_revision"
  | "illegal_transition"
  | "unknown_task"
  | "revision"
  | "invalid_state";

export type StateResult =
  | { ok: true; state: RunState }
  | { ok: false; code: StateErrorCode; error: string };

export interface TaskRecord {
  taskId: TaskId;
  state: TaskState;
  attemptId?: string;
  sessionId?: string;
  reportId?: string;
  repairRounds: number;
  acceptedAt?: number;
  blockedReason?: string;
  updatedAt: number;
}

export interface RunPlanRef {
  path: string;
  title: string;
  digest: string;
}

export interface RunState {
  schemaVersion: typeof STATE_SCHEMA_VERSION;
  runId: RunId;
  /** The run-level revision fence every event must match. */
  revision: number;
  phase: RunPhase;
  /** The single row/text/check authority. */
  todos: FrozenTodoSnapshot;
  /** Stable task order; order[i] is frozen row i. */
  order: TaskId[];
  tasks: Record<TaskId, TaskRecord>;
  plan?: RunPlanRef;
  blockedReason?: string;
  lastError?: string;
  createdAt: number;
  updatedAt: number;
}

export interface RunEventBase {
  runId: RunId;
  /** The revision the caller observed; anything else is stale. */
  expectedRevision: number;
  now: number;
}

export type RunEvent =
  | (RunEventBase & { type: "run.transition"; to: RunPhase })
  | (RunEventBase & {
      type: "task.start";
      taskId: TaskId;
      attemptId: string;
      sessionId: string;
    })
  | (RunEventBase & { type: "task.report"; taskId: TaskId; reportId?: string })
  | (RunEventBase & { type: "task.verify"; taskId: TaskId })
  | (RunEventBase & {
      type: "task.accept";
      taskId: TaskId;
      evidenceId: string;
      workspaceRevision: string;
    })
  | (RunEventBase & { type: "task.needsFix"; taskId: TaskId; reason?: string })
  | (RunEventBase & { type: "task.block"; taskId: TaskId; reason: string })
  | (RunEventBase & { type: "task.retry"; taskId: TaskId });

export type RunEventType = RunEvent["type"];

function fail(code: StateErrorCode, error: string): StateResult {
  return { ok: false, code, error };
}

function bump(state: RunState, now: number): Pick<RunState, "revision" | "updatedAt"> {
  return { revision: state.revision + 1, updatedAt: now };
}

function replaceTask(
  state: RunState,
  taskId: TaskId,
  task: TaskRecord,
  patch: Partial<RunState>,
  now: number,
): RunState {
  return {
    ...state,
    ...bump(state, now),
    ...patch,
    tasks: { ...state.tasks, [taskId]: task },
  };
}

/** Task ids are positional because a task is exactly one frozen row. */
export function taskIdForRef(ref: string): TaskId {
  return `task-${ref}`;
}

export function createRunState(input: {
  runId: RunId;
  todos: FrozenTodoSnapshot;
  plan?: RunPlanRef;
  now: number;
}): StateResult {
  if (typeof input.runId !== "string" || input.runId.length === 0) {
    return fail("invalid_state", "runId is required");
  }
  if (!input.todos || !Array.isArray(input.todos.rows) || input.todos.rows.length === 0) {
    return fail("invalid_state", "a frozen TODO snapshot with at least one row is required");
  }
  const tasks: Record<TaskId, TaskRecord> = {};
  const order: TaskId[] = [];
  for (const row of input.todos.rows) {
    const taskId = taskIdForRef(row.ref);
    if (tasks[taskId]) return fail("invalid_state", `duplicate frozen ref ${row.ref}`);
    tasks[taskId] = {
      taskId,
      state: "pending",
      repairRounds: 0,
      updatedAt: input.now,
    };
    order.push(taskId);
  }
  return {
    ok: true,
    state: {
      schemaVersion: STATE_SCHEMA_VERSION,
      runId: input.runId,
      revision: 1,
      phase: "ready",
      todos: input.todos,
      order,
      tasks,
      ...(input.plan === undefined ? {} : { plan: input.plan }),
      createdAt: input.now,
      updatedAt: input.now,
    },
  };
}

/** The frozen row a task owns; the task record never duplicates its text. */
export function rowForTask(state: RunState, taskId: TaskId): FrozenTodoRow | undefined {
  const index = state.order.indexOf(taskId);
  return index < 0 ? undefined : state.todos.rows[index];
}

/** The first pending row in frozen order, if any. */
export function nextPendingTask(state: RunState): TaskId | undefined {
  return state.order.find((taskId) => state.tasks[taskId]?.state === "pending");
}

/** Counts the panel/status need without re-deriving row state. */
export function taskCounts(state: RunState): {
  total: number;
  accepted: number;
  pending: number;
  running: number;
  blocked: number;
} {
  const counts = { total: state.order.length, accepted: 0, pending: 0, running: 0, blocked: 0 };
  for (const taskId of state.order) {
    const task = state.tasks[taskId];
    if (!task) continue;
    if (task.state === "accepted") counts.accepted += 1;
    else if (task.state === "blocked") counts.blocked += 1;
    else if (task.state === "pending") counts.pending += 1;
    else counts.running += 1;
  }
  return counts;
}

function baseError(state: RunState, event: RunEventBase): StateResult | undefined {
  if (event.runId !== state.runId) {
    return fail("invalid_state", "event belongs to a different run");
  }
  if (event.expectedRevision !== state.revision) {
    return fail(
      "stale_revision",
      `stale revision ${event.expectedRevision}; current is ${state.revision}`,
    );
  }
  return undefined;
}

function taskFor(state: RunState, taskId: TaskId): TaskRecord | StateResult {
  const task = state.tasks[taskId];
  return task ?? fail("unknown_task", `unknown task ${taskId}`);
}

function isFailure(value: TaskRecord | StateResult): value is StateResult {
  return "ok" in value;
}

function allAccepted(state: RunState): boolean {
  return state.order.every((taskId) => state.tasks[taskId]?.state === "accepted");
}

function applyTransition(
  state: RunState,
  event: Extract<RunEvent, { type: "run.transition" }>,
): StateResult {
  const base = baseError(state, event);
  if (base) return base;
  if (!canTransitionRun(state.phase, event.to)) {
    return fail("illegal_transition", `cannot move ${state.phase} → ${event.to}`);
  }
  if (event.to === "completed" && !allAccepted(state)) {
    const unfinished = state.order.filter((id) => state.tasks[id]?.state !== "accepted");
    return fail(
      "illegal_transition",
      `completed requires every row accepted; unfinished: ${unfinished.join(", ")}`,
    );
  }
  return {
    ok: true,
    state: {
      ...state,
      ...bump(state, event.now),
      phase: event.to,
      ...(event.to === "blocked" ? {} : { blockedReason: undefined }),
    },
  };
}

function applyStart(
  state: RunState,
  event: Extract<RunEvent, { type: "task.start" }>,
): StateResult {
  const base = baseError(state, event);
  if (base) return base;
  const task = taskFor(state, event.taskId);
  if (isFailure(task)) return task;
  if (task.state !== "pending" && task.state !== "needs_fix") {
    return fail("illegal_transition", `cannot start a ${task.state} row`);
  }
  if (state.order.some((id) => state.tasks[id]?.state === "running")) {
    return fail("illegal_transition", "another row is already running");
  }
  return {
    ok: true,
    state: replaceTask(
      state,
      task.taskId,
      {
        ...task,
        state: "running",
        attemptId: event.attemptId,
        sessionId: event.sessionId,
        blockedReason: undefined,
        updatedAt: event.now,
      },
      { phase: "running" },
      event.now,
    ),
  };
}

function applyReport(
  state: RunState,
  event: Extract<RunEvent, { type: "task.report" }>,
): StateResult {
  const base = baseError(state, event);
  if (base) return base;
  const task = taskFor(state, event.taskId);
  if (isFailure(task)) return task;
  if (task.state !== "running") {
    return fail("illegal_transition", `cannot record a report for a ${task.state} row`);
  }
  return {
    ok: true,
    state: replaceTask(
      state,
      task.taskId,
      {
        ...task,
        state: "candidate",
        ...(event.reportId === undefined ? {} : { reportId: event.reportId }),
        updatedAt: event.now,
      },
      {},
      event.now,
    ),
  };
}

function applyVerify(
  state: RunState,
  event: Extract<RunEvent, { type: "task.verify" }>,
): StateResult {
  const base = baseError(state, event);
  if (base) return base;
  const task = taskFor(state, event.taskId);
  if (isFailure(task)) return task;
  if (task.state !== "candidate") {
    return fail("illegal_transition", `cannot verify a ${task.state} row`);
  }
  // Verification is a marker; acceptance or needs_fix is the decision.
  return {
    ok: true,
    state: { ...state, ...bump(state, event.now) },
  };
}

function applyAccept(
  state: RunState,
  event: Extract<RunEvent, { type: "task.accept" }>,
): StateResult {
  const base = baseError(state, event);
  if (base) return base;
  const task = taskFor(state, event.taskId);
  if (isFailure(task)) return task;
  if (task.state !== "candidate") {
    return fail("illegal_transition", `cannot accept a ${task.state} row`);
  }
  if (typeof event.evidenceId !== "string" || event.evidenceId.trim().length === 0) {
    return fail("invalid_state", "acceptance requires evidence");
  }
  if (typeof event.workspaceRevision !== "string" || event.workspaceRevision.length === 0) {
    return fail("invalid_state", "acceptance requires a workspace revision");
  }
  return {
    ok: true,
    state: replaceTask(
      state,
      task.taskId,
      { ...task, state: "accepted", acceptedAt: event.now, updatedAt: event.now },
      {},
      event.now,
    ),
  };
}

function applyNeedsFix(
  state: RunState,
  event: Extract<RunEvent, { type: "task.needsFix" }>,
): StateResult {
  const base = baseError(state, event);
  if (base) return base;
  const task = taskFor(state, event.taskId);
  if (isFailure(task)) return task;
  if (task.state !== "candidate" && task.state !== "running") {
    return fail("illegal_transition", `cannot request a fix for a ${task.state} row`);
  }
  const repairRounds = task.repairRounds + 1;
  if (repairRounds > MAX_REPAIR_ROUNDS) {
    const reason = event.reason
      ? `repair budget exhausted after ${MAX_REPAIR_ROUNDS} round(s): ${event.reason.slice(0, 250)}`
      : `repair budget exhausted after ${MAX_REPAIR_ROUNDS} round(s)`;
    return {
      ok: true,
      state: replaceTask(
        state,
        task.taskId,
        { ...task, state: "blocked", repairRounds, blockedReason: reason, updatedAt: event.now },
        { phase: "blocked", blockedReason: reason },
        event.now,
      ),
    };
  }
  return {
    ok: true,
    state: replaceTask(
      state,
      task.taskId,
      { ...task, state: "needs_fix", repairRounds, updatedAt: event.now },
      { phase: "ready" },
      event.now,
    ),
  };
}

function applyBlock(
  state: RunState,
  event: Extract<RunEvent, { type: "task.block" }>,
): StateResult {
  const base = baseError(state, event);
  if (base) return base;
  const task = taskFor(state, event.taskId);
  if (isFailure(task)) return task;
  if (task.state === "accepted") {
    return fail("illegal_transition", "an accepted row cannot be blocked");
  }
  return {
    ok: true,
    state: replaceTask(
      state,
      task.taskId,
      { ...task, state: "blocked", blockedReason: event.reason, updatedAt: event.now },
      { phase: "blocked", blockedReason: event.reason },
      event.now,
    ),
  };
}

function applyRetry(
  state: RunState,
  event: Extract<RunEvent, { type: "task.retry" }>,
): StateResult {
  const base = baseError(state, event);
  if (base) return base;
  const task = taskFor(state, event.taskId);
  if (isFailure(task)) return task;
  if (task.state !== "blocked" && task.state !== "needs_fix") {
    return fail("illegal_transition", `cannot retry a ${task.state} row`);
  }
  return {
    ok: true,
    state: replaceTask(
      state,
      task.taskId,
      {
        ...task,
        state: "pending",
        repairRounds: task.state === "blocked" ? 0 : task.repairRounds,
        blockedReason: undefined,
        updatedAt: event.now,
      },
      { phase: "ready", blockedReason: undefined },
      event.now,
    ),
  };
}

/** The only mutator of a `RunState`. */
export function applyRunEvent(state: RunState, event: RunEvent): StateResult {
  switch (event.type) {
    case "run.transition":
      return applyTransition(state, event);
    case "task.start":
      return applyStart(state, event);
    case "task.report":
      return applyReport(state, event);
    case "task.verify":
      return applyVerify(state, event);
    case "task.accept":
      return applyAccept(state, event);
    case "task.needsFix":
      return applyNeedsFix(state, event);
    case "task.block":
      return applyBlock(state, event);
    case "task.retry":
      return applyRetry(state, event);
    default:
      return fail("invalid_state", "unknown event");
  }
}
