/**
 * Workflow Extension — pure orchestrator run/task state machine (step 15).
 *
 * The journal (step 21) persists decisions; this module decides whether a
 * decision is legal at all. It is pure: no clock, filesystem, session or model.
 * Every event carries the revision it was computed against, so a stale caller
 * fails closed instead of overwriting newer state.
 *
 * Invariants enforced here:
 *   - stable run/task/attempt/session identities; a foreign run id is refused;
 *   - a dependency must be `accepted` before its dependent may start;
 *   - exactly one task/attempt/session holds the workspace mutation grant, and
 *     a stale generation cannot resume writing;
 *   - `candidate` is not acceptance: acceptance needs evidence for the exact
 *     run/task/attempt/candidate/workspace/roadmap revision, from `verifying`;
 *   - cancellation is not completion: `completed` requires every task accepted;
 *   - repair, no-progress, rollover and launch counters persist on the task and
 *     pause at their bound instead of retrying forever.
 *
 * Later steps add journal I/O, scheduling and child transport. None of them may
 * bypass these reducers.
 */

import {
  ORCHESTRATOR_SCHEMA_VERSION,
  acceptanceBlocker,
  canTransitionRun,
  canTransitionTask,
  ownsWorkspace,
  validatePlanCoverage,
  type AcceptanceEvidence,
  type AttemptId,
  type CandidateId,
  type EvidenceId,
  type MutationGrant,
  type RoadmapRequirement,
  type RunId,
  type RunPhase,
  type SessionId,
  type TaskId,
  type TaskPlan,
  type TaskState,
  type ExecutionBudgets,
  DEFAULT_EXECUTION_BUDGETS,
} from "./orchestrator-types.ts";

export const STATE_SCHEMA_VERSION = ORCHESTRATOR_SCHEMA_VERSION;

export type StateErrorCode =
  | "stale_revision"
  | "illegal_transition"
  | "coverage"
  | "dependency"
  | "single_writer"
  | "stale_generation"
  | "evidence"
  | "unknown_task"
  | "budget"
  | "invalid_state";

export type StateResult =
  | { ok: true; state: RunState }
  | { ok: false; code: StateErrorCode; error: string };

export interface TaskCounters {
  /** Repair rounds after the first candidate. */
  repairRounds: number;
  /** Consecutive candidates with no meaningful change. */
  noProgress: number;
  /** Fresh continuation sessions used for this task. */
  rollovers: number;
  /** Launch attempts that never reached the task turn. */
  launchFailures: number;
}

export const EMPTY_TASK_COUNTERS: Readonly<TaskCounters> = {
  repairRounds: 0,
  noProgress: 0,
  rollovers: 0,
  launchFailures: 0,
};

export type AttemptState = "assigned" | "running" | "candidate" | "verifying" | "accepted" | "cancelled";

export interface AttemptRecord {
  attemptId: AttemptId;
  sessionId: SessionId;
  /** Monotonic per task; a stale holder is refused. */
  generation: number;
  state: AttemptState;
  startedAt: number;
  endedAt?: number;
  candidateId?: CandidateId;
  reportId?: string;
}

export interface AcceptanceRecord {
  evidenceId: EvidenceId;
  candidateId: CandidateId;
  attemptId: AttemptId;
  workspaceRevision: string;
  roadmapRevision: number;
  acceptedAt: number;
}

export interface TaskRecord {
  taskId: TaskId;
  covers: string[];
  objective: string;
  nonGoals: string[];
  dependsOn: TaskId[];
  expectedFiles: string[];
  acceptanceChecks: string[];
  sizeRationale: string;
  state: TaskState;
  /** Per-task revision; a task update carries the run revision that produced it. */
  attempts: AttemptRecord[];
  currentAttemptId?: AttemptId;
  counters: TaskCounters;
  acceptance?: AcceptanceRecord;
  cancellation?: { reason: string; at: number };
  blockedReason?: string;
}

export interface RunState {
  schemaVersion: typeof STATE_SCHEMA_VERSION;
  runId: RunId;
  /** The run-level revision fence every event must match. */
  revision: number;
  phase: RunPhase;
  roadmapRevision: number;
  /** 0 until a breakdown is applied; only one breakdown per run in v1. */
  planRevision: number;
  requirements: RoadmapRequirement[];
  tasks: Record<TaskId, TaskRecord>;
  /** Stable plan order; TODO refs are 1..N over this list. */
  order: TaskId[];
  mutation: MutationGrant | null;
  blockedReason?: string;
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
  | (RunEventBase & { type: "plan.apply"; plan: TaskPlan; requirements: RoadmapRequirement[] })
  | (RunEventBase & { type: "run.transition"; to: RunPhase })
  | (RunEventBase & {
      type: "task.assign";
      taskId: TaskId;
      attemptId: AttemptId;
      sessionId: SessionId;
      generation: number;
    })
  | (RunEventBase & {
      type: "task.start";
      taskId: TaskId;
      attemptId: AttemptId;
      sessionId: SessionId;
      generation: number;
    })
  | (RunEventBase & {
      type: "task.candidate";
      taskId: TaskId;
      attemptId: AttemptId;
      candidateId: CandidateId;
      reportId?: string;
      meaningfulChange: boolean;
    })
  | (RunEventBase & { type: "task.verify"; taskId: TaskId })
  | (RunEventBase & {
      type: "task.accept";
      taskId: TaskId;
      evidence: AcceptanceEvidence;
      workspaceRevision: string;
      unmetCriteria?: string[];
    })
  | (RunEventBase & {
      type: "task.needsFix";
      taskId: TaskId;
      meaningfulChange: boolean;
      reason?: string;
    })
  | (RunEventBase & { type: "task.block"; taskId: TaskId; reason: string })
  | (RunEventBase & { type: "task.cancel"; taskId: TaskId; reason: string })
  | (RunEventBase & { type: "task.supersede"; taskId: TaskId; reason: string })
  | (RunEventBase & { type: "attempt.launchFailed"; taskId: TaskId; attemptId: AttemptId })
  | (RunEventBase & {
      type: "attempt.rollover";
      taskId: TaskId;
      attemptId: AttemptId;
      newAttemptId: AttemptId;
      sessionId: SessionId;
      generation: number;
    });

export interface ProjectedTodo {
  /** Display ref 1..N within this task list; never a durable id. */
  ref: number;
  taskId: TaskId;
  text: string;
  status: "pending" | "in_progress" | "completed" | "cancelled";
}

function fail(code: StateErrorCode, error: string): StateResult {
  return { ok: false, code, error };
}

function cloneTask(task: TaskRecord, patch: Partial<TaskRecord>): TaskRecord {
  return { ...task, counters: { ...task.counters }, attempts: [...task.attempts], ...patch };
}

function nextRevision(state: RunState, now: number): { revision: number; updatedAt: number } {
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
    ...nextRevision(state, now),
    ...patch,
    tasks: { ...state.tasks, [taskId]: task },
  };
}

function stageTask(task: TaskRecord, patch: Partial<TaskRecord>): TaskRecord {
  return cloneTask(task, patch);
}

function budgetBlocked(
  state: RunState,
  taskId: TaskId,
  task: TaskRecord,
  reason: string,
  now: number,
): StateResult {
  return {
    ok: true,
    state: replaceTask(
      state,
      taskId,
      stageTask(task, { state: "blocked", blockedReason: reason }),
      { phase: "blocked", blockedReason: reason, mutation: null },
      now,
    ),
  };
}

function generationFor(task: TaskRecord): number {
  return task.attempts.reduce((max, attempt) => Math.max(max, attempt.generation), 0);
}

/** The single task whose attempt may mutate the workspace right now. */
export function mutationTask(state: RunState): TaskId | undefined {
  return state.mutation?.taskId;
}

/** Counters are persisted; a rollover/reload must never reset one. */
export function taskCounters(state: RunState, taskId: TaskId): TaskCounters | undefined {
  return state.tasks[taskId]?.counters;
}

export function createRunState(input: {
  runId: RunId;
  roadmapRevision: number;
  now: number;
}): StateResult {
  if (typeof input.runId !== "string" || input.runId.length === 0) {
    return fail("invalid_state", "runId is required");
  }
  if (!Number.isInteger(input.roadmapRevision) || input.roadmapRevision < 1) {
    return fail("invalid_state", "roadmapRevision must be a positive integer");
  }
  return {
    ok: true,
    state: {
      schemaVersion: STATE_SCHEMA_VERSION,
      runId: input.runId,
      revision: 1,
      phase: "draft",
      roadmapRevision: input.roadmapRevision,
      planRevision: 0,
      requirements: [],
      tasks: {},
      order: [],
      mutation: null,
      createdAt: input.now,
      updatedAt: input.now,
    },
  };
}

/** The first pending task whose dependencies are all accepted, if any. */
export function nextRunnableTask(state: RunState): TaskId | undefined {
  for (const taskId of state.order) {
    const task = state.tasks[taskId];
    if (!task || task.state !== "pending") continue;
    const ready = task.dependsOn.every((id) => state.tasks[id]?.state === "accepted");
    if (ready) return taskId;
  }
  return undefined;
}

/** Project the durable task records into display TODOs (refs are local). */
export function projectTodos(state: RunState): ProjectedTodo[] {
  return state.order.map((taskId, index) => {
    const task = state.tasks[taskId];
    let status: ProjectedTodo["status"] = "in_progress";
    if (task.state === "accepted") status = "completed";
    else if (task.state === "cancelled" || task.state === "superseded") status = "cancelled";
    else if (task.state === "pending" || task.state === "blocked") status = "pending";
    return { ref: index + 1, taskId, text: task.objective, status };
  });
}

function taskEventError(state: RunState, event: RunEventBase): StateResult | undefined {
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

function taskOrFail(state: RunState, taskId: TaskId): TaskRecord | StateResult {
  const task = state.tasks[taskId];
  return task ?? fail("unknown_task", `unknown task ${taskId}`);
}

function isStateResult(value: TaskRecord | StateResult): value is StateResult {
  return "ok" in value;
}

function grantFor(
  state: RunState,
  task: TaskRecord,
  event: RunEventBase & {
    attemptId: AttemptId;
    sessionId: SessionId;
    generation: number;
  },
): MutationGrant {
  return {
    runId: state.runId,
    taskId: task.taskId,
    attemptId: event.attemptId,
    sessionId: event.sessionId,
    generation: event.generation,
  };
}

function holdsGrant(
  state: RunState,
  grant: MutationGrant,
): { ok: true } | { ok: false; code: StateErrorCode; error: string } {
  if (!state.mutation) return { ok: false, code: "single_writer", error: "no mutation grant is held" };
  if (!ownsWorkspace(state.mutation, grant)) {
    return {
      ok: false,
      code: "stale_generation",
      error: "the workspace grant is held by another attempt or generation",
    };
  }
  return { ok: true };
}

function applyPlan(
  state: RunState,
  event: Extract<RunEvent, { type: "plan.apply" }>,
): StateResult {
  const base = taskEventError(state, event);
  if (base) return base;
  if (state.planRevision !== 0) {
    return fail("invalid_state", "a task breakdown is already applied");
  }
  if (state.phase !== "draft" && state.phase !== "awaiting_approval") {
    return fail("illegal_transition", `cannot apply a breakdown in phase ${state.phase}`);
  }
  if (event.plan.runId !== state.runId) {
    return fail("invalid_state", "breakdown belongs to a different run");
  }
  if (event.plan.roadmapRevision !== state.roadmapRevision) {
    return fail("invalid_state", "breakdown maps a different roadmap revision");
  }
  const coverage = validatePlanCoverage({
    requirements: event.requirements,
    tasks: event.plan.tasks,
  });
  if (!coverage.ok) return fail("coverage", coverage.error);

  const tasks: Record<TaskId, TaskRecord> = {};
  for (const planned of event.plan.tasks) {
    tasks[planned.taskId] = {
      taskId: planned.taskId,
      covers: [...planned.covers],
      objective: planned.objective,
      nonGoals: [...planned.nonGoals],
      dependsOn: [...planned.dependsOn],
      expectedFiles: [...planned.expectedFiles],
      acceptanceChecks: [...planned.acceptanceChecks],
      sizeRationale: planned.sizeRationale,
      state: "pending",
      attempts: [],
      counters: { ...EMPTY_TASK_COUNTERS },
    };
  }
  return {
    ok: true,
    state: {
      ...state,
      ...nextRevision(state, event.now),
      phase: "awaiting_approval",
      planRevision: 1,
      requirements: event.requirements.map((requirement) => ({ ...requirement })),
      tasks,
      order: event.plan.tasks.map((task) => task.taskId),
    },
  };
}

function applyRunTransition(
  state: RunState,
  event: Extract<RunEvent, { type: "run.transition" }>,
): StateResult {
  const base = taskEventError(state, event);
  if (base) return base;
  if (!canTransitionRun(state.phase, event.to)) {
    return fail("illegal_transition", `cannot move ${state.phase} → ${event.to}`);
  }
  if (event.to === "completed" || event.to === "final_verification") {
    const unfinished = state.order.filter((id) => state.tasks[id]?.state !== "accepted");
    if (unfinished.length > 0) {
      return fail(
        "illegal_transition",
        `${event.to} requires every task accepted; unfinished: ${unfinished.join(", ")}`,
      );
    }
  }
  return {
    ok: true,
    state: {
      ...state,
      ...nextRevision(state, event.now),
      phase: event.to,
      ...(event.to === "blocked" ? {} : { blockedReason: undefined }),
    },
  };
}

function applyAssign(
  state: RunState,
  event: Extract<RunEvent, { type: "task.assign" }>,
  budgets: ExecutionBudgets,
): StateResult {
  const base = taskEventError(state, event);
  if (base) return base;
  const task = taskOrFail(state, event.taskId);
  if (isStateResult(task)) return task;
  if (state.mutation) {
    return fail("single_writer", `task ${state.mutation.taskId} already owns the workspace`);
  }
  if (task.state !== "pending" && task.state !== "needs_fix" && task.state !== "blocked") {
    return fail("illegal_transition", `cannot assign a ${task.state} task`);
  }
  const notAccepted = task.dependsOn.filter((id) => state.tasks[id]?.state !== "accepted");
  if (notAccepted.length > 0) {
    return fail("dependency", `dependencies not accepted: ${notAccepted.join(", ")}`);
  }
  if (!Number.isInteger(event.generation) || event.generation <= generationFor(task)) {
    return fail("stale_generation", "attempt generation must increase");
  }
  if (task.counters.launchFailures >= budgets.launchFailureLimit) {
    return budgetBlocked(state, task.taskId, task, "launch failure budget exhausted", event.now);
  }
  const attempt: AttemptRecord = {
    attemptId: event.attemptId,
    sessionId: event.sessionId,
    generation: event.generation,
    state: "assigned",
    startedAt: event.now,
  };
  const next = stageTask(task, {
    state: "assigned",
    currentAttemptId: attempt.attemptId,
    attempts: [...task.attempts, attempt],
    blockedReason: undefined,
  });
  return {
    ok: true,
    state: replaceTask(
      state,
      task.taskId,
      next,
      {
        phase: state.phase === "ready" ? "dispatching" : state.phase,
        mutation: grantFor(state, task, event),
      },
      event.now,
    ),
  };
}

function applyStart(
  state: RunState,
  event: Extract<RunEvent, { type: "task.start" }>,
): StateResult {
  const base = taskEventError(state, event);
  if (base) return base;
  const task = taskOrFail(state, event.taskId);
  if (isStateResult(task)) return task;
  if (task.state !== "assigned") {
    return fail("illegal_transition", `cannot start a ${task.state} task`);
  }
  if (!canTransitionTask("assigned", "running")) {
    return fail("illegal_transition", "assigned cannot start");
  }
  const held = holdsGrant(state, grantFor(state, task, event));
  if (!held.ok) return fail(held.code, held.error);
  const attempt = task.attempts.find((entry) => entry.attemptId === event.attemptId);
  if (!attempt || attempt.sessionId !== event.sessionId || attempt.generation !== event.generation) {
    return fail("stale_generation", "the attempt does not match the assigned grant");
  }
  const attempts = task.attempts.map((entry) =>
    entry.attemptId === event.attemptId ? { ...entry, state: "running" as const } : entry,
  );
  return {
    ok: true,
    state: replaceTask(
      state,
      task.taskId,
      stageTask(task, { state: "running", attempts }),
      { phase: "building" },
      event.now,
    ),
  };
}

function applyCandidate(
  state: RunState,
  event: Extract<RunEvent, { type: "task.candidate" }>,
  budgets: ExecutionBudgets,
): StateResult {
  const base = taskEventError(state, event);
  if (base) return base;
  const task = taskOrFail(state, event.taskId);
  if (isStateResult(task)) return task;
  if (task.state !== "running" || !canTransitionTask("running", "candidate")) {
    return fail("illegal_transition", `cannot record a candidate for a ${task.state} task`);
  }
  const attempt = task.attempts.find((entry) => entry.attemptId === event.attemptId);
  if (!attempt) return fail("stale_generation", "the candidate names a previous attempt");
  const held = holdsGrant(state, {
    runId: state.runId,
    taskId: task.taskId,
    attemptId: attempt.attemptId,
    sessionId: attempt.sessionId,
    generation: attempt.generation,
  });
  if (!held.ok) return fail(held.code, held.error);
  const noProgress = event.meaningfulChange ? 0 : task.counters.noProgress + 1;
  const counters = { ...task.counters, noProgress };
  const attempts = task.attempts.map((entry) =>
    entry.attemptId === event.attemptId
      ? {
          ...entry,
          state: "candidate" as const,
          candidateId: event.candidateId,
          ...(event.reportId === undefined ? {} : { reportId: event.reportId }),
        }
      : entry,
  );
  const candidateTask = stageTask(task, { state: "candidate", attempts, counters });
  if (noProgress >= budgets.noProgressLimit && !event.meaningfulChange) {
    return budgetBlocked(state, task.taskId, candidateTask, "no-progress budget exhausted", event.now);
  }
  // A candidate is not acceptance. Reporting quiescence revokes mutation
  // authority; verification is read-only until a repair is granted.
  return {
    ok: true,
    state: replaceTask(state, task.taskId, candidateTask, { mutation: null }, event.now),
  };
}

function applyVerify(
  state: RunState,
  event: Extract<RunEvent, { type: "task.verify" }>,
): StateResult {
  const base = taskEventError(state, event);
  if (base) return base;
  const task = taskOrFail(state, event.taskId);
  if (isStateResult(task)) return task;
  if (!canTransitionTask(task.state, "verifying")) {
    return fail("illegal_transition", `cannot verify a ${task.state} task`);
  }
  if (state.mutation) {
    return fail("single_writer", "verification requires a quiescent workspace");
  }
  const attempts = task.attempts.map((entry) =>
    entry.attemptId === task.currentAttemptId ? { ...entry, state: "verifying" as const } : entry,
  );
  return {
    ok: true,
    state: replaceTask(
      state,
      task.taskId,
      stageTask(task, { state: "verifying", attempts }),
      { phase: "verifying" },
      event.now,
    ),
  };
}

function applyAccept(
  state: RunState,
  event: Extract<RunEvent, { type: "task.accept" }>,
): StateResult {
  const base = taskEventError(state, event);
  if (base) return base;
  const task = taskOrFail(state, event.taskId);
  if (isStateResult(task)) return task;
  if (task.state !== "verifying" || !canTransitionTask("verifying", "accepted")) {
    return fail("illegal_transition", `cannot accept a ${task.state} task`);
  }
  if (state.mutation) {
    return fail("single_writer", "acceptance requires a quiescent workspace");
  }
  const evidence = event.evidence;
  if (
    evidence.runId !== state.runId ||
    evidence.taskId !== task.taskId ||
    evidence.attemptId !== task.currentAttemptId ||
    evidence.candidateId !==
      task.attempts.find((attempt) => attempt.attemptId === task.currentAttemptId)?.candidateId
  ) {
    return fail("evidence", "evidence does not describe this task's current candidate");
  }
  const blocker = acceptanceBlocker({
    evidence,
    workspaceRevision: event.workspaceRevision,
    roadmapRevision: state.roadmapRevision,
    unmetCriteria: event.unmetCriteria ?? [],
  });
  if (blocker) return fail("evidence", blocker);

  const acceptance: AcceptanceRecord = {
    evidenceId: evidence.evidenceId,
    candidateId: evidence.candidateId,
    attemptId: evidence.attemptId,
    workspaceRevision: evidence.workspaceRevision,
    roadmapRevision: evidence.roadmapRevision,
    acceptedAt: event.now,
  };
  const attempts = task.attempts.map((entry) =>
    entry.attemptId === task.currentAttemptId ? { ...entry, state: "accepted" as const } : entry,
  );
  return {
    ok: true,
    state: replaceTask(
      state,
      task.taskId,
      stageTask(task, { state: "accepted", acceptance, attempts }),
      {},
      event.now,
    ),
  };
}

function applyNeedsFix(
  state: RunState,
  event: Extract<RunEvent, { type: "task.needsFix" }>,
  budgets: ExecutionBudgets,
): StateResult {
  const base = taskEventError(state, event);
  if (base) return base;
  const task = taskOrFail(state, event.taskId);
  if (isStateResult(task)) return task;
  if (!canTransitionTask(task.state, "needs_fix")) {
    return fail("illegal_transition", `cannot request a fix for a ${task.state} task`);
  }
  const repairRounds = task.counters.repairRounds + 1;
  const noProgress = event.meaningfulChange ? 0 : task.counters.noProgress + 1;
  const counters = { ...task.counters, repairRounds, noProgress };
  const next = stageTask(task, {
    state: "needs_fix",
    counters,
    ...(event.reason === undefined ? {} : { blockedReason: undefined }),
  });
  if (repairRounds > budgets.repairRounds) {
    return budgetBlocked(state, task.taskId, next, "repair budget exhausted", event.now);
  }
  if (noProgress >= budgets.noProgressLimit && !event.meaningfulChange) {
    return budgetBlocked(state, task.taskId, next, "no-progress budget exhausted", event.now);
  }
  return {
    ok: true,
    state: replaceTask(state, task.taskId, next, { phase: "ready" }, event.now),
  };
}

function applyCancel(
  state: RunState,
  event: Extract<RunEvent, { type: "task.cancel" }>,
): StateResult {
  const base = taskEventError(state, event);
  if (base) return base;
  const task = taskOrFail(state, event.taskId);
  if (isStateResult(task)) return task;
  if (task.state === "accepted" || task.state === "superseded") {
    return fail("illegal_transition", `an ${task.state} task cannot be cancelled`);
  }
  if (!canTransitionTask(task.state, "cancelled")) {
    return fail("illegal_transition", `cannot cancel a ${task.state} task`);
  }
  const attempts = task.attempts.map((entry) =>
    entry.state === "accepted" ? entry : { ...entry, state: "cancelled" as const },
  );
  return {
    ok: true,
    state: replaceTask(
      state,
      task.taskId,
      stageTask(task, {
        state: "cancelled",
        attempts,
        cancellation: { reason: event.reason, at: event.now },
      }),
      { mutation: state.mutation?.taskId === task.taskId ? null : state.mutation },
      event.now,
    ),
  };
}

function applySupersede(
  state: RunState,
  event: Extract<RunEvent, { type: "task.supersede" }>,
): StateResult {
  const base = taskEventError(state, event);
  if (base) return base;
  const task = taskOrFail(state, event.taskId);
  if (isStateResult(task)) return task;
  if (task.state !== "accepted" || !canTransitionTask("accepted", "superseded")) {
    return fail("illegal_transition", "only an accepted task can be superseded");
  }
  return {
    ok: true,
    state: replaceTask(
      state,
      task.taskId,
      stageTask(task, { state: "superseded", cancellation: { reason: event.reason, at: event.now } }),
      {},
      event.now,
    ),
  };
}

function applyLaunchFailure(
  state: RunState,
  event: Extract<RunEvent, { type: "attempt.launchFailed" }>,
  budgets: ExecutionBudgets,
): StateResult {
  const base = taskEventError(state, event);
  if (base) return base;
  const task = taskOrFail(state, event.taskId);
  if (isStateResult(task)) return task;
  if (task.state !== "assigned" && task.state !== "running") {
    return fail("illegal_transition", `a launch failure cannot apply to a ${task.state} task`);
  }
  if (task.currentAttemptId !== event.attemptId) {
    return fail("stale_generation", "launch failure names a previous attempt");
  }
  const launchFailures = task.counters.launchFailures + 1;
  const counters = { ...task.counters, launchFailures };
  const attempts = task.attempts.map((entry) =>
    entry.attemptId === event.attemptId ? { ...entry, state: "cancelled" as const } : entry,
  );
  const next = stageTask(task, { state: "pending", counters, attempts });
  const patch = {
    mutation: state.mutation?.taskId === task.taskId ? null : state.mutation,
  };
  if (launchFailures >= budgets.launchFailureLimit) {
    return budgetBlocked(
      state,
      task.taskId,
      next,
      "launch failure budget exhausted",
      event.now,
    );
  }
  return { ok: true, state: replaceTask(state, task.taskId, next, patch, event.now) };
}

function applyRollover(
  state: RunState,
  event: Extract<RunEvent, { type: "attempt.rollover" }>,
  budgets: ExecutionBudgets,
): StateResult {
  const base = taskEventError(state, event);
  if (base) return base;
  const task = taskOrFail(state, event.taskId);
  if (isStateResult(task)) return task;
  if (task.currentAttemptId !== event.attemptId) {
    return fail("stale_generation", "rollover names a previous attempt");
  }
  if (!Number.isInteger(event.generation) || event.generation <= generationFor(task)) {
    return fail("stale_generation", "rollover generation must increase");
  }
  const rollovers = task.counters.rollovers + 1;
  const counters = { ...task.counters, rollovers };
  const attempts = task.attempts.map((entry) =>
    entry.attemptId === event.attemptId && entry.state !== "accepted"
      ? { ...entry, state: "cancelled" as const, endedAt: event.now }
      : entry,
  );
  attempts.push({
    attemptId: event.newAttemptId,
    sessionId: event.sessionId,
    generation: event.generation,
    state: "assigned",
    startedAt: event.now,
  });
  const next = stageTask(task, {
    state: "assigned",
    currentAttemptId: event.newAttemptId,
    attempts,
    counters,
  });
  if (rollovers > budgets.rolloverLimit) {
    return budgetBlocked(state, task.taskId, next, "rollover budget exhausted", event.now);
  }
  return {
    ok: true,
    state: replaceTask(
      state,
      task.taskId,
      next,
      {
        mutation: grantFor(state, task, {
          ...event,
          attemptId: event.newAttemptId,
        }),
      },
      event.now,
    ),
  };
}

function applyBlock(
  state: RunState,
  event: Extract<RunEvent, { type: "task.block" }>,
): StateResult {
  const base = taskEventError(state, event);
  if (base) return base;
  const task = taskOrFail(state, event.taskId);
  if (isStateResult(task)) return task;
  if (!canTransitionTask(task.state, "blocked")) {
    return fail("illegal_transition", `cannot block a ${task.state} task`);
  }
  return {
    ok: true,
    state: replaceTask(
      state,
      task.taskId,
      stageTask(task, { state: "blocked", blockedReason: event.reason }),
      {
        phase: "blocked",
        blockedReason: event.reason,
        mutation: state.mutation?.taskId === task.taskId ? null : state.mutation,
      },
      event.now,
    ),
  };
}

/**
 * The only mutator of a `RunState`. Invalid, stale or out-of-order events
 * return an error and leave the caller's state untouched.
 */
export function applyRunEvent(
  state: RunState,
  event: RunEvent,
  options: { budgets?: ExecutionBudgets } = {},
): StateResult {
  const budgets = options.budgets ?? DEFAULT_EXECUTION_BUDGETS;
  switch (event.type) {
    case "plan.apply":
      return applyPlan(state, event);
    case "run.transition":
      return applyRunTransition(state, event);
    case "task.assign":
      return applyAssign(state, event, budgets);
    case "task.start":
      return applyStart(state, event);
    case "task.candidate":
      return applyCandidate(state, event, budgets);
    case "task.verify":
      return applyVerify(state, event);
    case "task.accept":
      return applyAccept(state, event);
    case "task.needsFix":
      return applyNeedsFix(state, event, budgets);
    case "task.block":
      return applyBlock(state, event);
    case "task.cancel":
      return applyCancel(state, event);
    case "task.supersede":
      return applySupersede(state, event);
    case "attempt.launchFailed":
      return applyLaunchFailure(state, event, budgets);
    case "attempt.rollover":
      return applyRollover(state, event, budgets);
    default:
      return fail("invalid_state", "unknown event");
  }
}
