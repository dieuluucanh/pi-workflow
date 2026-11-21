/**
 * Workflow Extension — native child lifecycle controls (step 30).
 *
 * One coordinator-owned lifecycle for a visible Build child. Controls route
 * through the control protocol (pause/repair/resume/say/close) and never treat
 * a report or a window close as acceptance.
 *
 * Rules:
 *   - a stale lease generation cannot pause/resume/steer or restart writes; a
 *     resume requires the CURRENT lease generation and, after the fence, an
 *     explicit repair authorization;
 *   - `waiting_user` is shown in the parent while the child keeps its normal UI;
 *   - closing requests the child's graceful shutdown/dispose, retains the
 *     session history and archives the relation; it never force-closes
 *     unrelated shells/windows;
 *   - a worker window/tab that disappears becomes `interrupted` with edits
 *     preserved — never accepted progress and never an orphan scheduler.
 */

export const LIFECYCLE_SCHEMA_VERSION = 1 as const;
export const MAX_SAY_CHARS = 8_000;

export type ChildPhase =
  | "launching"
  | "ready"
  | "running"
  | "waiting_user"
  | "fenced"
  | "paused"
  | "closing"
  | "closed"
  | "interrupted";

export interface ChildLifecycleState {
  schemaVersion: typeof LIFECYCLE_SCHEMA_VERSION;
  runId: string;
  taskId: string;
  attemptId: string;
  sessionId: string;
  /** Session ref/tab id/window id; opaque. */
  sessionRef: string;
  phase: ChildPhase;
  /** The lease this child currently holds (if any). */
  leaseGeneration: number;
  /** True only while this lifecycle may schedule/execute. */
  schedulerOwner: boolean;
  waitingQuestionId?: string;
  closeReason?: string;
  /** A window/tab close is not acceptance. */
  acceptedProgress: boolean;
  historyRetained: boolean;
  editsPreserved: boolean;
  archive?: {
    relation: "child" | "sibling";
    parentTabId: string;
    sessionFile: string | null;
    title: string;
    retained: true;
  };
}

export type LifecycleCode =
  | "invalid"
  | "stale_lease"
  | "authorization"
  | "not_ready"
  | "closed"
  | "too_large";

export type LifecycleResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: LifecycleCode; error: string };

export function createChildLifecycle(input: {
  runId: string;
  taskId: string;
  attemptId: string;
  sessionId: string;
  sessionRef: string;
  leaseGeneration: number;
}): ChildLifecycleState {
  return {
    schemaVersion: LIFECYCLE_SCHEMA_VERSION,
    ...input,
    phase: "launching",
    schedulerOwner: false,
    acceptedProgress: false,
    historyRetained: true,
    editsPreserved: true,
  };
}

function active(state: ChildLifecycleState): boolean {
  return state.phase !== "closed" && state.phase !== "interrupted" && state.phase !== "closing";
}

export function markChildReady(state: ChildLifecycleState): ChildLifecycleState {
  return active(state) ? { ...state, phase: "ready", schedulerOwner: true } : state;
}

export function markChildRunning(state: ChildLifecycleState): ChildLifecycleState {
  return active(state) ? { ...state, phase: "running", schedulerOwner: true } : state;
}

/** The child asked a question in its normal UI; the parent shows it, no accept. */
export function markWaitingUser(
  state: ChildLifecycleState,
  questionId: string,
): LifecycleResult<ChildLifecycleState> {
  if (!active(state)) return { ok: false, code: "closed", error: `child is ${state.phase}` };
  if (!questionId || questionId.length > 200) {
    return { ok: false, code: "invalid", error: "question id is required" };
  }
  return {
    ok: true,
    value: { ...state, phase: "waiting_user", waitingQuestionId: questionId, schedulerOwner: true },
  };
}

/** Parent-facing status while the child keeps using its normal UI. */
export function parentStatus(state: ChildLifecycleState): string {
  switch (state.phase) {
    case "waiting_user":
      return `Waiting for your answer in the child${state.waitingQuestionId ? ` (${state.waitingQuestionId})` : ""}`;
    case "paused":
      return "Child paused; edits preserved";
    case "closing":
      return "Closing the child gracefully";
    case "closed":
      return "Child closed; history retained";
    case "interrupted":
      return "Child interrupted (window/tab closed); edits preserved";
    case "fenced":
      return "Child quiescent; awaiting parent verification or repair authorization";
    default:
      return "Child is running in its own window/tab";
  }
}

function leaseMatches(state: ChildLifecycleState, leaseGeneration: number): boolean {
  return Number.isInteger(leaseGeneration) && leaseGeneration === state.leaseGeneration;
}

/** Pause keeps edits and authority with the same live lease. */
export function pauseChild(
  state: ChildLifecycleState,
  input: { leaseGeneration: number },
): LifecycleResult<{ state: ChildLifecycleState; message: "pause" }> {
  if (!active(state)) return { ok: false, code: "closed", error: `child is ${state.phase}` };
  if (!leaseMatches(state, input.leaseGeneration)) {
    return { ok: false, code: "stale_lease", error: "a stale lease generation cannot pause the child" };
  }
  return {
    ok: true,
    value: {
      state: { ...state, phase: "paused", schedulerOwner: true },
      message: "pause",
    },
  };
}

/** Resume requires the CURRENT lease; a fenced child also needs repair auth. */
export function resumeChild(
  state: ChildLifecycleState,
  input: {
    leaseGeneration: number;
    currentLeaseGeneration: number;
    repairAuthorization?: string;
  },
): LifecycleResult<{ state: ChildLifecycleState; message: "resume" }> {
  if (!active(state)) return { ok: false, code: "closed", error: `child is ${state.phase}` };
  if (
    !leaseMatches(state, input.leaseGeneration) ||
    input.leaseGeneration !== input.currentLeaseGeneration
  ) {
    return { ok: false, code: "stale_lease", error: "resume requires the current lease generation" };
  }
  if (state.phase === "fenced" && input.repairAuthorization !== "repair-authorized") {
    return { ok: false, code: "authorization", error: "explicit repair authorization is required" };
  }
  return {
    ok: true,
    value: {
      state: {
        ...state,
        phase: "running",
        schedulerOwner: true,
        ...(state.phase === "fenced" ? { leaseGeneration: input.leaseGeneration } : {}),
      },
      message: "resume",
    },
  };
}

/** User steering is normal interaction; it never accepts or bypasses the fence. */
export function sayToChild(
  state: ChildLifecycleState,
  input: { text: string; leaseGeneration: number },
): LifecycleResult<{
  state: ChildLifecycleState;
  message: "say";
  text: string;
  requiresBudgetRecheck: true;
}> {
  if (!active(state)) return { ok: false, code: "closed", error: `child is ${state.phase}` };
  if (state.phase === "fenced") {
    return { ok: false, code: "not_ready", error: "the child is fenced; resume it with authorization first" };
  }
  if (!leaseMatches(state, input.leaseGeneration)) {
    return { ok: false, code: "stale_lease", error: "a stale lease generation cannot steer the child" };
  }
  const text = input.text.trim();
  if (text.length === 0) return { ok: false, code: "invalid", error: "the message is empty" };
  if (text.length > MAX_SAY_CHARS) return { ok: false, code: "too_large", error: "the message is too large" };
  return {
    ok: true,
    value: {
      state: { ...state, phase: "running", schedulerOwner: true },
      message: "say",
      text,
      requiresBudgetRecheck: true,
    },
  };
}

/** After the fence, the parent grants a scoped repair turn. */
export function requestRepair(
  state: ChildLifecycleState,
  input: { authorization: string; leaseGeneration: number },
): LifecycleResult<{ state: ChildLifecycleState; message: "repair" }> {
  if (state.phase !== "fenced") {
    return { ok: false, code: "not_ready", error: "repair applies only to a fenced child" };
  }
  if (input.authorization !== "repair-authorized") {
    return { ok: false, code: "authorization", error: "explicit repair authorization is required" };
  }
  if (!leaseMatches(state, input.leaseGeneration)) {
    return { ok: false, code: "stale_lease", error: "a stale lease generation cannot repair" };
  }
  return {
    ok: true,
    value: {
      state: { ...state, phase: "running", schedulerOwner: true },
      message: "repair",
    },
  };
}

export interface CloseOutcome {
  state: ChildLifecycleState;
  /** Request the owning runtime's graceful shutdown/dispose. */
  dispose: true;
  force: false;
  /** Only this opaque ref; unrelated shells/windows are untouched. */
  sessionRef: string;
  retainHistory: true;
  archived: boolean;
  interrupted: boolean;
}

/**
 * Accepted closure: graceful dispose + archive. `accepted` refers to the
 * parent's acceptance decision; it is recorded on the relation, not inferred
 * from a window close.
 */
export function closeChild(
  state: ChildLifecycleState,
  input: {
    accepted: boolean;
    reason: string;
    parentTabId: string;
    sessionFile: string | null;
    title: string;
    now: number;
  },
): LifecycleResult<CloseOutcome> {
  if (state.phase === "closed") {
    return { ok: false, code: "closed", error: "the child is already closed" };
  }
  const archive = {
    relation: "child" as const,
    parentTabId: input.parentTabId,
    sessionFile: input.sessionFile,
    title: input.title,
    retained: true as const,
  };
  const next: ChildLifecycleState = {
    ...state,
    phase: input.accepted ? "closed" : "interrupted",
    schedulerOwner: false,
    acceptedProgress: input.accepted,
    historyRetained: true,
    editsPreserved: true,
    closeReason: input.reason.slice(0, 400),
    archive,
  };
  return {
    ok: true,
    value: {
      state: next,
      dispose: true,
      force: false,
      sessionRef: state.sessionRef,
      retainHistory: true,
      archived: true,
      interrupted: !input.accepted,
    },
  };
}

/**
 * The user closed the worker window/tab. Equivalent to a graceful dispose of
 * this child only: interrupted, edits preserved, no acceptance, no respawn.
 */
export function handleWindowClosed(
  state: ChildLifecycleState,
  input: { parentTabId: string; sessionFile: string | null; title: string; now: number },
): LifecycleResult<CloseOutcome> {
  return closeChild(state, {
    accepted: false,
    reason: "the child window/tab was closed",
    ...input,
  });
}

/** No scheduler may adopt an interrupted worker; the parent decides next steps. */
export function canSchedule(state: ChildLifecycleState): boolean {
  return state.schedulerOwner && (state.phase === "running" || state.phase === "waiting_user" || state.phase === "ready");
}
