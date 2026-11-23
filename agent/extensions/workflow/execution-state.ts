/**
 * Workflow Extension — pure execution control state.
 *
 * This is metadata over the frozen TODO authority, never a second task list.
 * It owns execution identity/fencing, the shell-quarantine policy and the
 * terminal outcome. It deliberately does not store row text or order.
 */

import { createHash } from "node:crypto";

export const EXECUTION_STATE_VERSION = 1 as const;

export type ExecutionOwner =
  | "build"
  | "orchestrator-parent"
  | "managed-child";

export type ExecutionPhase =
  | "active"
  | "recovering-shell"
  | "verifying"
  | "waiting-child"
  | "paused"
  | "blocked"
  | "completed"
  | "stopped";

export type ExecutionRowStatus =
  | "pending"
  | "in_progress"
  | "completed"
  | "cancelled"
  | "blocked";

export interface ExecutionRow {
  id: string;
  ref: string;
  status: ExecutionRowStatus;
  /** Required executable checks; absence means non-shell evidence is needed. */
  requiredChecks?: number;
}

export interface ExecutionSource {
  kind: "plan" | "steps" | "discussion";
  path?: string;
  digest: string;
}

export interface ExecutionBlocker {
  category:
    | "permission"
    | "safety"
    | "external"
    | "verification"
    | "no-permitted-action"
    | "unknown";
  rowRef?: string;
  reason: string;
  requiredAction?: string;
  evidenceRefs?: string[];
  at: number;
}

export interface ShellQuarantine {
  executionId: string;
  rowRef?: string;
  attemptId?: string;
  reason: string;
  commandHash: string;
  at: number;
  /** Never automatically clear a quarantine; only an explicit user reset. */
  autoResume: false;
}

export type ExecutionKickoffStatus =
  | "pending"
  | "sent"
  | "acknowledged"
  | "failed";

export interface ExecutionKickoff {
  status: ExecutionKickoffStatus;
  at: number;
  error?: string;
}

export interface ExecutionProgress {
  boundariesWithoutProgress: number;
  recoveryBoundariesWithoutProgress: number;
  lastProgressSignature?: string;
  lastProgressAt?: number;
  /** Last settle boundary, used to detect barren continuations. */
  lastBoundaryAt?: number;
}

export interface ExecutionState {
  version: typeof EXECUTION_STATE_VERSION;
  executionId: string;
  /** Bumped by every user-visible transition; stale events are refused. */
  epoch: number;
  owner: ExecutionOwner;
  source: ExecutionSource;
  phase: ExecutionPhase;
  shellQuarantine?: ShellQuarantine;
  blocker?: ExecutionBlocker;
  pausedReason?: string;
  kickoff?: ExecutionKickoff;
  progress: ExecutionProgress;
  createdAt: number;
  updatedAt: number;
}

export interface ArmExecutionInput {
  executionId: string;
  owner: ExecutionOwner;
  source: ExecutionSource;
  now?: number;
}

export type ExecutionEvent =
  | {
      type: "progress";
      at: number;
      signature?: string;
    }
  | {
      type: "shell-timeout";
      executionId: string;
      epoch: number;
      rowRef?: string;
      attemptId?: string;
      reason: string;
      commandHash: string;
      at: number;
    }
  | {
      type: "pause";
      executionId: string;
      epoch: number;
      reason: string;
      blocker?: ExecutionBlocker;
      at: number;
    }
  | {
      type: "resume";
      executionId: string;
      epoch: number;
      at: number;
    }
  | {
      type: "stop";
      executionId: string;
      epoch: number;
      reason: string;
      at: number;
    }
  | {
      type: "block";
      executionId: string;
      epoch: number;
      blocker: ExecutionBlocker;
      at: number;
    }
  | {
      type: "shell-reset";
      executionId: string;
      epoch: number;
      at: number;
    };

export type ExecutionEventErrorCode =
  | "invalid"
  | "stale"
  | "terminal"
  | "not-paused";

export type ExecutionEventResult =
  | { ok: true; state: ExecutionState }
  | { ok: false; code: ExecutionEventErrorCode; error: string };

export type ShellAttemptEvent =
  | "user-prompt"
  | "new-user-request"
  | "session-start"
  | "session-tree"
  | "session-resume"
  | "compaction"
  | "agent-settled"
  | "automatic-continuation"
  | "mode-switch"
  | "shell-reset"
  | "child-replacement"
  | "reload"
  | "fork";

/**
 * C1 clear/persist matrix. Session lifecycle resets must not erase a restored
 * quarantine; only a genuine user prompt or an explicit shell reset may.
 */
export function shouldClearShellAttempt(event: ShellAttemptEvent): boolean {
  return event === "user-prompt" || event === "new-user-request" || event === "shell-reset";
}

/** Stable hash for a command identity; full normalized bytes, not a prefix. */
export function shellCommandHash(command: string): string {
  return createHash("sha256").update(command, "utf8").digest("hex");
}

export function armExecution(input: ArmExecutionInput): ExecutionState {
  const now = input.now ?? Date.now();
  return {
    version: EXECUTION_STATE_VERSION,
    executionId: input.executionId,
    epoch: 1,
    owner: input.owner,
    source: input.source,
    phase: "active",
    progress: {
      boundariesWithoutProgress: 0,
      recoveryBoundariesWithoutProgress: 0,
    },
    createdAt: now,
    updatedAt: now,
  };
}

function isTerminal(phase: ExecutionPhase): boolean {
  return phase === "completed" || phase === "stopped";
}

function fenceMatches(
  state: ExecutionState,
  event: { executionId: string; epoch: number },
): boolean {
  return state.executionId === event.executionId && state.epoch === event.epoch;
}

function stale(): ExecutionEventResult {
  return {
    ok: false,
    code: "stale",
    error: "the execution identity or epoch is stale",
  };
}

function invalid(error: string): ExecutionEventResult {
  return { ok: false, code: "invalid", error };
}

function terminal(): ExecutionEventResult {
  return {
    ok: false,
    code: "terminal",
    error: "the execution is already terminal",
  };
}

function unchanged(state: ExecutionState): ExecutionEventResult {
  return { ok: true, state };
}

function withState(
  state: ExecutionState,
  patch: Partial<ExecutionState>,
  now: number,
): ExecutionState {
  return {
    ...state,
    ...patch,
    epoch: state.epoch + 1,
    updatedAt: now,
  };
}

/** Record kickoff delivery/acknowledgement without changing the epoch. */
export function markExecutionKickoff(
  state: ExecutionState,
  status: ExecutionKickoffStatus,
  at: number,
  error?: string,
): ExecutionState {
  return {
    ...state,
    kickoff: {
      status,
      at,
      ...(error === undefined ? {} : { error }),
    },
    updatedAt: at,
  };
}

export function isShellQuarantined(state: ExecutionState): boolean {
  return state.shellQuarantine !== undefined;
}

/** Shell is usable only while active/verifying and not quarantined/paused. */
export function canUseShell(state: ExecutionState): boolean {
  if (state.shellQuarantine) return false;
  return (
    state.phase === "active" ||
    state.phase === "verifying" ||
    state.phase === "waiting-child"
  );
}

export function needsNonShellRecovery(state: ExecutionState): boolean {
  return (
    state.shellQuarantine !== undefined &&
    (state.phase === "recovering-shell" || state.phase === "paused")
  );
}

export function applyExecutionEvent(
  state: ExecutionState,
  event: ExecutionEvent,
): ExecutionEventResult {
  if (state.version !== EXECUTION_STATE_VERSION) {
    return invalid("unsupported execution-state version");
  }

  if (event.type === "progress") {
    if (state.phase === "paused" || state.phase === "blocked") return unchanged(state);
    if (isTerminal(state.phase)) return terminal();
    const now = event.at;
    const nextSignature = event.signature;
    const sameSignature =
      nextSignature !== undefined &&
      nextSignature === state.progress.lastProgressSignature;
    return {
      ok: true,
      state: {
        ...state,
        progress: {
          ...state.progress,
          ...(sameSignature
            ? {}
            : {
                boundariesWithoutProgress: 0,
                recoveryBoundariesWithoutProgress: 0,
                lastProgressSignature: nextSignature,
              }),
          lastProgressAt: now,
        },
        updatedAt: now,
      },
    };
  }

  if (!fenceMatches(state, event)) return stale();

  if (event.type === "shell-timeout") {
    if (isTerminal(state.phase)) return terminal();
    const sameIncident =
      state.shellQuarantine?.rowRef === event.rowRef &&
      state.shellQuarantine?.attemptId === event.attemptId &&
      state.shellQuarantine?.commandHash === event.commandHash;
    if (sameIncident) return unchanged(state);
    const quarantine: ShellQuarantine = {
      executionId: state.executionId,
      ...(event.rowRef === undefined ? {} : { rowRef: event.rowRef }),
      ...(event.attemptId === undefined ? {} : { attemptId: event.attemptId }),
      reason: event.reason,
      commandHash: event.commandHash,
      at: event.at,
      autoResume: false,
    };
    return {
      ok: true,
      state: withState(
        state,
        {
          shellQuarantine: quarantine,
          ...(state.phase === "paused"
            ? {}
            : { phase: "recovering-shell" as const }),
        },
        event.at,
      ),
    };
  }

  if (event.type === "pause") {
    if (isTerminal(state.phase)) return terminal();
    if (state.phase === "paused") return unchanged(state);
    return {
      ok: true,
      state: withState(
        state,
        {
          phase: "paused",
          pausedReason: event.reason,
          ...(event.blocker ? { blocker: event.blocker } : {}),
        },
        event.at,
      ),
    };
  }

  if (event.type === "resume") {
    if (isTerminal(state.phase)) return terminal();
    if (state.phase !== "paused" && state.phase !== "blocked") {
      return { ok: false, code: "not-paused", error: "the execution is not paused" };
    }
    return {
      ok: true,
      state: withState(
        state,
        {
          phase: state.shellQuarantine ? "recovering-shell" : "active",
          pausedReason: undefined,
          blocker: undefined,
        },
        event.at,
      ),
    };
  }

  if (event.type === "stop") {
    if (state.phase === "stopped") return unchanged(state);
    if (state.phase === "completed") return terminal();
    return {
      ok: true,
      state: withState(
        state,
        {
          phase: "stopped",
          pausedReason: event.reason,
        },
        event.at,
      ),
    };
  }

  if (event.type === "block") {
    if (isTerminal(state.phase)) return terminal();
    return {
      ok: true,
      state: withState(
        state,
        {
          phase: "blocked",
          blocker: event.blocker,
        },
        event.at,
      ),
    };
  }

  if (event.type === "shell-reset") {
    if (isTerminal(state.phase)) return terminal();
    return {
      ok: true,
      state: withState(
        state,
        {
          shellQuarantine: undefined,
          ...(state.phase === "recovering-shell"
            ? { phase: "active" as const }
            : {}),
        },
        event.at,
      ),
    };
  }

  return invalid("unknown execution event");
}

/** The next row to work on, never the whole list. */
export function selectNextRow(
  rows: readonly ExecutionRow[],
  state: ExecutionState,
  blockedRefs: readonly string[] = [],
): ExecutionRow | undefined {
  if (
    state.phase === "paused" ||
    state.phase === "stopped" ||
    state.phase === "completed" ||
    state.phase === "blocked"
  ) {
    return undefined;
  }
  const blocked = new Set(blockedRefs);
  const inProgress = rows.find(
    (row) => row.status === "in_progress" && !blocked.has(row.ref),
  );
  if (inProgress) return inProgress;
  return rows.find((row) => row.status === "pending" && !blocked.has(row.ref));
}

export type ExecutionOutcome =
  | { kind: "active" }
  | { kind: "paused"; reason: string }
  | { kind: "stopped"; reason: string }
  | { kind: "complete"; completedRefs: string[] }
  | {
      kind: "complete-with-exclusions";
      completedRefs: string[];
      excludedRefs: string[];
    }
  | { kind: "blocked"; blocker: ExecutionBlocker }
  | {
      kind: "blocked-unverified";
      blockedRefs: string[];
      reason: string;
    };

/**
 * Terminal classification. A cancelled-only list is never "complete"; a
 * shell-quarantined required row is never green.
 */
export function evaluateExecutionOutcome(
  state: ExecutionState,
  rows: readonly ExecutionRow[],
): ExecutionOutcome {
  if (state.phase === "stopped") {
    return { kind: "stopped", reason: state.pausedReason ?? "stopped" };
  }
  if (state.phase === "paused") {
    return { kind: "paused", reason: state.pausedReason ?? "paused" };
  }
  if (state.phase === "blocked" && state.blocker) {
    return { kind: "blocked", blocker: state.blocker };
  }
  if (rows.length === 0) {
    return {
      kind: "blocked",
      blocker: {
        category: "unknown",
        reason: "the execution has no rows",
        at: state.updatedAt,
      },
    };
  }

  const completedRefs = rows
    .filter((row) => row.status === "completed")
    .map((row) => row.ref);
  const excludedRefs = rows
    .filter((row) => row.status === "cancelled")
    .map((row) => row.ref);
  const pendingRefs = rows
    .filter((row) => row.status === "pending" || row.status === "in_progress")
    .map((row) => row.ref);

  if (pendingRefs.length > 0) {
    if (state.shellQuarantine) {
      return {
        kind: "blocked-unverified",
        blockedRefs: pendingRefs,
        reason: "shell is quarantined and required work remains unverified",
      };
    }
    return { kind: "active" };
  }

  if (completedRefs.length === 0 && excludedRefs.length > 0) {
    return {
      kind: "blocked",
      blocker: {
        category: "no-permitted-action",
        reason: "every row was cancelled; cancellation is not completion",
        at: state.updatedAt,
      },
    };
  }

  if (excludedRefs.length > 0) {
    return {
      kind: "complete-with-exclusions",
      completedRefs,
      excludedRefs,
    };
  }

  return { kind: "complete", completedRefs };
}

/** True only for a fully verified terminal result. */
export function isCleanCompletion(outcome: ExecutionOutcome): boolean {
  return outcome.kind === "complete";
}
