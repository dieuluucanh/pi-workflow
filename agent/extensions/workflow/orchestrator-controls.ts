/**
 * Workflow Extension — run controls, mode/input ownership (step 37).
 *
 * One owner at a time. Pause/resume/stop, a mode change and a queued prompt all
 * pass through this reducer, so an Escape/`/build` race or a queued prompt
 * cannot create two mutating owners or leave a stuck mode lock.
 *
 * Rules:
 *   - pause/stop first QUIESCE the active child. A busy child gets a directive
 *     and the run waits for the fence; nothing is killed silently.
 *   - a lease is released only after the child is quiescent, and stopping
 *     retains edits (no automatic rollback is ever claimed).
 *   - the parent may orchestrate but never gets workspace-write authority; that
 *     stays with the single child owner, which is checked by every tool path.
 *   - a mode change is refused while a child or Review owns the turn, and is
 *     deferred (not dropped) when a prompt is queued.
 *   - every transition is revision-fenced, so racing commands fail closed.
 */

import type { RunPhase } from "./orchestrator-types.ts";

export const CONTROLS_SCHEMA_VERSION = 1 as const;
export const MAX_REASON_CHARS = 500;

export type MutatingOwner = "parent" | "child" | "review" | "none";
export type ControlMode = "plan" | "build" | "default" | "orchestrator";

export interface ChildControlState {
  taskId: string;
  attemptId: string;
  sessionId: string;
  phase: "launching" | "ready" | "running" | "waiting_user" | "fenced" | "paused" | "closed" | "interrupted";
  pendingTools: number;
  pendingFollowUps: number;
  /** True only after an actual settle (`agent_end` does not count). */
  settled: boolean;
  leaseGeneration: number;
  editsPreserved: boolean;
}

export interface RunControlState {
  schemaVersion: typeof CONTROLS_SCHEMA_VERSION;
  runId: string;
  revision: number;
  phase: RunPhase;
  /** Who may mutate the workspace right now. */
  owner: MutatingOwner;
  /** Who owns the composer input right now. */
  inputOwner: MutatingOwner;
  mode: ControlMode;
  child?: ChildControlState;
  queuedPrompts: number;
  reviewActive: boolean;
  pauseReason?: string;
  stoppedAt?: number;
  updatedAt: number;
}

export type ControlCode =
  | "invalid"
  | "stale_revision"
  | "terminal"
  | "busy"
  | "single_writer"
  | "not_paused"
  | "review_owns_turn";

export type ControlAction =
  | "pause_quiesce"
  | "paused"
  | "resumed"
  | "stop_quiesce"
  | "stopped"
  | "mode_changed"
  | "mode_deferred"
  | "input_claimed"
  | "input_released"
  | "dispatch_started"
  | "child_finished"
  | "unstick";

export interface ControlSuccess {
  ok: true;
  action: ControlAction;
  state: RunControlState;
  /** The runtime must release the workspace lease only when this is true. */
  releaseLease: boolean;
  /** A directive to send to the child, when quiescing. */
  directive?: "pause" | "stop";
  /** The stop/pause is not safe until the child fences. */
  waitForFence: boolean;
  editsPreserved: boolean;
  automaticRollback: false;
}

export type ControlResult =
  | ControlSuccess
  | { ok: false; code: ControlCode; error: string };

const TERMINAL = new Set<RunPhase>(["completed", "failed", "cancelled"]);

function fail(code: ControlCode, error: string): ControlResult {
  return { ok: false, code, error };
}

function bumps(state: RunControlState, now: number, patch: Partial<RunControlState>): RunControlState {
  return { ...state, ...patch, revision: state.revision + 1, updatedAt: now };
}

function boundedReason(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_REASON_CHARS) return undefined;
  return trimmed;
}

export function createRunControl(input: {
  runId: string;
  now: number;
  phase?: RunPhase;
  mode?: ControlMode;
  child?: ChildControlState;
}): RunControlState {
  return {
    schemaVersion: CONTROLS_SCHEMA_VERSION,
    runId: input.runId,
    revision: 1,
    phase: input.phase ?? "ready",
    owner: input.child ? "child" : "none",
    inputOwner: "parent",
    mode: input.mode ?? "orchestrator",
    ...(input.child ? { child: { ...input.child } } : {}),
    queuedPrompts: 0,
    reviewActive: false,
    updatedAt: input.now,
  };
}

/** A child is safe to pause/stop only when it actually settled and drained. */
export function childQuiescent(child: ChildControlState | undefined): boolean {
  if (!child) return true;
  if (!child.settled || child.pendingTools > 0 || child.pendingFollowUps > 0) return false;
  return (
    child.phase === "fenced" ||
    child.phase === "closed" ||
    child.phase === "interrupted" ||
    child.phase === "paused"
  );
}

function checkRevision(state: RunControlState, expectedRevision: number): ControlResult | undefined {
  if (!Number.isInteger(expectedRevision) || expectedRevision !== state.revision) {
    return fail(
      "stale_revision",
      `stale control revision ${String(expectedRevision)}; current is ${state.revision}`,
    );
  }
  return undefined;
}

/**
 * Pause keeps work visible. If the child is busy, the runtime pauses it at the
 * next safe point; the lease is NOT released yet.
 */
export function pauseRun(
  state: RunControlState,
  input: { expectedRevision: number; reason?: string; now: number },
): ControlResult {
  const stale = checkRevision(state, input.expectedRevision);
  if (stale) return stale;
  if (TERMINAL.has(state.phase)) return fail("terminal", `the run is ${state.phase}`);
  const reason = input.reason === undefined ? undefined : boundedReason(input.reason);
  if (input.reason !== undefined && reason === undefined) {
    return fail("invalid", "the pause reason is too long or empty");
  }
  if (!childQuiescent(state.child)) {
    return {
      ok: true,
      action: "pause_quiesce",
      state: bumps(state, input.now, {
        pauseReason: reason ?? "paused by the operator",
      }),
      releaseLease: false,
      directive: "pause",
      waitForFence: true,
      editsPreserved: true,
      automaticRollback: false,
    };
  }
  return {
    ok: true,
    action: "paused",
    state: bumps(state, input.now, {
      phase: "paused",
      owner: "none",
      inputOwner: "none",
      pauseReason: reason ?? "paused by the operator",
      ...(state.child ? { child: { ...state.child, phase: "paused", editsPreserved: true } } : {}),
    }),
    releaseLease: true,
    waitForFence: false,
    editsPreserved: true,
    automaticRollback: false,
  };
}

/** Resume is explicit and never auto-restarts a child. */
export function resumeRun(
  state: RunControlState,
  input: { expectedRevision: number; now: number },
): ControlResult {
  const stale = checkRevision(state, input.expectedRevision);
  if (stale) return stale;
  if (state.phase !== "paused") return fail("not_paused", `the run is ${state.phase}`);
  if (state.reviewActive) return fail("review_owns_turn", "Review owns the turn");
  return {
    ok: true,
    action: "resumed",
    state: bumps(state, input.now, {
      phase: "ready",
      owner: "none",
      inputOwner: "parent",
      pauseReason: undefined,
    }),
    releaseLease: false,
    waitForFence: false,
    editsPreserved: true,
    automaticRollback: false,
  };
}

/**
 * Stop quiesces first, then cancels. Edits are retained and rollback is never
 * automatic; the operator can inspect before any manual revert.
 */
export function stopRun(
  state: RunControlState,
  input: { expectedRevision: number; reason?: string; now: number },
): ControlResult {
  const stale = checkRevision(state, input.expectedRevision);
  if (stale) return stale;
  if (TERMINAL.has(state.phase)) return fail("terminal", `the run is ${state.phase}`);
  const reason = input.reason === undefined ? "stopped by the operator" : boundedReason(input.reason);
  if (reason === undefined) return fail("invalid", "the stop reason is too long or empty");
  if (!childQuiescent(state.child)) {
    return {
      ok: true,
      action: "stop_quiesce",
      state: bumps(state, input.now, { pauseReason: reason }),
      releaseLease: false,
      directive: "stop",
      waitForFence: true,
      editsPreserved: true,
      automaticRollback: false,
    };
  }
  return {
    ok: true,
    action: "stopped",
    state: bumps(state, input.now, {
      phase: "cancelled",
      owner: "none",
      inputOwner: "none",
      stoppedAt: input.now,
      pauseReason: reason,
      ...(state.child ? { child: { ...state.child, editsPreserved: true } } : {}),
    }),
    releaseLease: true,
    waitForFence: false,
    editsPreserved: true,
    automaticRollback: false,
  };
}

/**
 * A mode change needs the turn. While a child or Review owns it, the change is
 * refused; a queued prompt is deferred until the turn ends (never dropped).
 */
export function requestModeChange(
  state: RunControlState,
  input: {
    expectedRevision: number;
    to: ControlMode;
    now: number;
    force?: boolean;
  },
): ControlResult {
  const stale = checkRevision(state, input.expectedRevision);
  if (stale) return stale;
  if (TERMINAL.has(state.phase)) return fail("terminal", `the run is ${state.phase}`);
  if (state.owner === "child" && !childQuiescent(state.child) && !input.force) {
    return fail(
      "single_writer",
      "the child owns the turn; pause/quiesce it before changing the parent mode",
    );
  }
  if (state.reviewActive) {
    return fail("review_owns_turn", "Review owns the turn; leave Review before changing mode");
  }
  if (state.queuedPrompts > 0) {
    return {
      ok: true,
      action: "mode_deferred",
      state: bumps(state, input.now, { mode: input.to }),
      releaseLease: false,
      waitForFence: false,
      editsPreserved: true,
      automaticRollback: false,
    };
  }
  return {
    ok: true,
    action: "mode_changed",
    state: bumps(state, input.now, {
      mode: input.to,
      ...(state.child === undefined && state.owner === "none" ? { phase: "ready" as RunPhase } : {}),
    }),
    releaseLease: false,
    waitForFence: false,
    editsPreserved: true,
    automaticRollback: false,
  };
}

/** The single mutating owner. A second claim is refused, not queued. */
export function claimOwner(
  state: RunControlState,
  input: { expectedRevision: number; owner: Exclude<MutatingOwner, "none">; now: number },
): ControlResult {
  const stale = checkRevision(state, input.expectedRevision);
  if (stale) return stale;
  if (state.owner !== "none" && state.owner !== input.owner) {
    return fail("single_writer", `${state.owner} already owns the mutation turn`);
  }
  if (input.owner === "parent") {
    return fail("single_writer", "the parent never holds workspace-write authority");
  }
  return {
    ok: true,
    action: "dispatch_started",
    state: bumps(state, input.now, { owner: input.owner }),
    releaseLease: false,
    waitForFence: false,
    editsPreserved: true,
    automaticRollback: false,
  };
}

/** Release after the child fences/closes; the lease may now be released. */
export function finishChild(
  state: RunControlState,
  input: { expectedRevision: number; now: number; nextPhase?: RunPhase },
): ControlResult {
  const stale = checkRevision(state, input.expectedRevision);
  if (stale) return stale;
  if (!childQuiescent(state.child)) {
    return fail("busy", "the child has not fenced yet; release only after a real settle and drain");
  }
  return {
    ok: true,
    action: "child_finished",
    state: bumps(state, input.now, {
      owner: "none",
      ...(input.nextPhase ? { phase: input.nextPhase } : {}),
      ...(state.child ? { child: { ...state.child, phase: "closed" } } : {}),
    }),
    releaseLease: true,
    waitForFence: false,
    editsPreserved: true,
    automaticRollback: false,
  };
}

export function claimInput(
  state: RunControlState,
  input: { expectedRevision: number; owner: Exclude<MutatingOwner, "none">; now: number },
): ControlResult {
  const stale = checkRevision(state, input.expectedRevision);
  if (stale) return stale;
  if (state.reviewActive && input.owner !== "review") {
    return fail("review_owns_turn", "Review owns the input");
  }
  if (state.inputOwner !== "none" && state.inputOwner !== input.owner) {
    return fail("single_writer", `${state.inputOwner} already owns the input`);
  }
  return {
    ok: true,
    action: "input_claimed",
    state: bumps(state, input.now, { inputOwner: input.owner }),
    releaseLease: false,
    waitForFence: false,
    editsPreserved: true,
    automaticRollback: false,
  };
}

export function releaseInput(
  state: RunControlState,
  input: { expectedRevision: number; owner: MutatingOwner; now: number },
): ControlResult {
  const stale = checkRevision(state, input.expectedRevision);
  if (stale) return stale;
  if (state.inputOwner !== input.owner) {
    return fail("single_writer", "only the current input owner can release it");
  }
  return {
    ok: true,
    action: "input_released",
    state: bumps(state, input.now, { inputOwner: "none" }),
    releaseLease: false,
    waitForFence: false,
    editsPreserved: true,
    automaticRollback: false,
  };
}

/**
 * The policy hook every tool path must consult. The parent is intentionally
 * excluded even when it owns orchestration.
 */
export function workspaceWriteAllowed(
  state: RunControlState,
  actor: MutatingOwner,
): { allowed: boolean; reason?: string } {
  if (TERMINAL.has(state.phase)) return { allowed: false, reason: `the run is ${state.phase}` };
  if (actor === "parent") return { allowed: false, reason: "the parent never writes the workspace" };
  if (state.owner !== actor) {
    return { allowed: false, reason: `${state.owner} owns the workspace, not ${actor}` };
  }
  return { allowed: true };
}

/** Queued user prompts are accepted only when no mutating turn is live. */
export function canAcceptPrompt(state: RunControlState): boolean {
  if (TERMINAL.has(state.phase)) return false;
  if (state.reviewActive) return false;
  return state.owner === "none";
}

export function queuePrompt(
  state: RunControlState,
  input: { expectedRevision: number; now: number },
): ControlResult {
  const stale = checkRevision(state, input.expectedRevision);
  if (stale) return stale;
  if (!canAcceptPrompt(state)) {
    return fail("busy", "a mutating owner or Review has the turn; the prompt must wait");
  }
  return {
    ok: true,
    action: "input_claimed",
    state: bumps(state, input.now, { queuedPrompts: state.queuedPrompts + 1 }),
    releaseLease: false,
    waitForFence: false,
    editsPreserved: true,
    automaticRollback: false,
  };
}

/**
 * Clears an owner whose child disappeared or whose run was resumed after a
 * crash. This is the recovery hook for a stuck mode lock.
 */
export function unstick(
  state: RunControlState,
  input: { expectedRevision: number; now: number; childAlive: boolean },
): ControlResult {
  const stale = checkRevision(state, input.expectedRevision);
  if (stale) return stale;
  if (input.childAlive && state.child) {
    return fail("busy", "the child is still alive; pause or close it first");
  }
  const nextOwner: MutatingOwner = state.reviewActive ? "review" : "none";
  let nextPhase: RunPhase = "ready";
  if (state.phase === "cancelled" || state.phase === "completed" || state.phase === "failed") {
    nextPhase = state.phase;
  } else if (state.phase === "paused") {
    nextPhase = "paused";
  }
  const changed =
    state.owner !== nextOwner ||
    state.inputOwner !== (state.reviewActive ? state.inputOwner : "parent") ||
    state.phase !== nextPhase;
  if (!changed) return fail("invalid", "the ownership state is already consistent");
  return {
    ok: true,
    action: "unstick",
    state: bumps(state, input.now, {
      owner: nextOwner,
      inputOwner: state.reviewActive ? state.inputOwner : "parent",
      phase: nextPhase,
      child: undefined,
    }),
    releaseLease: true,
    waitForFence: false,
    editsPreserved: true,
    automaticRollback: false,
  };
}
