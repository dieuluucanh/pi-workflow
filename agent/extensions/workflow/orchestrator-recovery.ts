/**
 * Workflow Extension — restart/reload/branch reconciliation (step 38).
 *
 * Reload is not a fresh start: the journal, the active branch, the parent
 * process identity and the real child session files must agree before work can
 * continue. This module produces that decision.
 *
 * Invariants:
 *   - a torn/tampered journal tail (truncated replay) pauses; it never resumes as
 *     if the missing events had not happened;
 *   - the journal is authoritative for acceptance. A snapshot that claims an
 *     accepted task the journal never recorded is inconsistent → pause;
 *   - an intent without an ack is `uncertain`; the plan says inspect the real
 *     session file/outbox, never blindly resend the assignment;
 *   - an old parent that may still be alive pauses reacquisition even when a
 *     TTL has expired — TTL alone is not ownership;
 *   - parent loss stops children safely; it does not let a new branch continue
 *     their work;
 *   - fork/tree/rewind branches cannot reuse an active run/lease without an
 *     explicit clone decision, and session refs from another branch are ignored.
 *
 * Pure: the caller supplies the journal projection, probes and clock.
 */

import type { JournalState, KickoffState } from "./orchestrator-store.ts";

export const RECOVERY_SCHEMA_VERSION = 1 as const;
export const DEFAULT_HEARTBEAT_STALE_MS = 30_000;

export interface ProcessIdentity {
  instanceId: string;
  startedAt: number;
  heartbeatAt: number;
}

export interface BranchInfo {
  id: string;
  kind: "active" | "fork" | "tree" | "rewind";
  /** The run this branch considers active. */
  activeRunId?: string;
}

export interface SessionProbe {
  sessionRef: string;
  sessionFile: string | null;
  exists: boolean;
  /** Process instance that opened/owns the file, when known. */
  ownerInstance?: string;
  heartbeatAt?: number;
}

export interface RunSnapshot {
  runId: string;
  revision: number;
  phase: string;
  acceptedTaskIds: string[];
  planRevision?: number;
  roadmapRevision?: number;
}

export interface RecoveryInput {
  journal: JournalState;
  snapshot?: RunSnapshot;
  branch: BranchInfo;
  sessions: readonly SessionProbe[];
  parent: { identity: ProcessIdentity; alive: boolean };
  current: ProcessIdentity;
  staleMs?: number;
  now: number;
}

export type RecoveryAction =
  | "resume"
  | "reconcile_start"
  | "pause"
  | "stop_children"
  | "clone_required"
  | "interrupted";

export interface KickoffReconciliation {
  taskId: string;
  status: KickoffState["status"];
  attemptId?: string;
  sessionId?: string;
  /** Concrete instruction; never "resend the kickoff" for an uncertain start. */
  instruction: string;
}

export type SessionState = "live" | "missing" | "stale" | "foreign" | "unprobed";

export interface SessionReconciliation {
  sessionRef: string;
  taskId?: string;
  attemptId?: string;
  state: SessionState;
  ownedByCurrent: boolean;
}

export interface RecoveryPlan {
  schemaVersion: typeof RECOVERY_SCHEMA_VERSION;
  action: RecoveryAction;
  reason: string;
  acceptedTaskIds: string[];
  snapshotMatchesJournal: boolean;
  /** Snapshot lacks journal-accepted tasks; rebuild before resuming. */
  snapshotStale: boolean;
  kickoff: KickoffReconciliation[];
  sessions: SessionReconciliation[];
  stopChildren: boolean;
  resumeAllowed: boolean;
  requiresOperator: boolean;
  staleWriterPossible: boolean;
  ownership: "current_instance" | "old_instance" | "unknown";
  reconcileTasks: string[];
  pausedTasks: string[];
}

function result(
  input: RecoveryInput,
  over: Partial<RecoveryPlan> & Pick<RecoveryPlan, "action" | "reason">,
): RecoveryPlan {
  return {
    schemaVersion: RECOVERY_SCHEMA_VERSION,
    acceptedTaskIds: [...input.journal.acceptedTaskIds],
    snapshotMatchesJournal: true,
    snapshotStale: false,
    kickoff: [],
    sessions: [],
    stopChildren: false,
    resumeAllowed: false,
    requiresOperator: false,
    staleWriterPossible: false,
    ownership: "current_instance",
    reconcileTasks: [],
    pausedTasks: [],
    ...over,
  };
}

function kickoffInstruction(status: KickoffState["status"], sessionFile: string | null): string {
  switch (status) {
    case "uncertain":
      return `Inspect ${sessionFile ?? "the child session file"} and its outbox/transcript for an actual assignment turn before deciding; do not resend the kickoff blindly.`;
    case "inconsistent":
      return "The start intent and acknowledgement disagree; keep the task paused and reconcile the attempt before any retry.";
    case "acknowledged":
      return "The assignment turn was acknowledged; resume normally if the session is live.";
    default:
      return "No start was attempted.";
  }
}

function probeSessions(input: RecoveryInput): {
  reconciled: SessionReconciliation[];
  missingAcknowledged: string[];
  foreign: string[];
} {
  const staleMs = input.staleMs ?? DEFAULT_HEARTBEAT_STALE_MS;
  const reconciled: SessionReconciliation[] = [];
  const missingAcknowledged: string[] = [];
  const foreign: string[] = [];

  for (const probe of input.sessions) {
    const ownedByCurrent = probe.ownerInstance === input.current.instanceId;
    let state: SessionState;
    if (!probe.exists || !probe.sessionFile) state = "missing";
    else if (probe.ownerInstance && !ownedByCurrent) state = "foreign";
    else if (
      probe.heartbeatAt !== undefined &&
      input.now - probe.heartbeatAt > staleMs
    ) {
      state = "stale";
    } else state = "live";
    reconciled.push({
      sessionRef: probe.sessionRef,
      state,
      ownedByCurrent,
    });
  }
  return { reconciled, missingAcknowledged, foreign };
}

/**
 * Rebuilds the next safe action. `resume` is only returned when ownership,
 * journal, snapshot and every acknowledged session agree.
 */
export function planRecovery(input: RecoveryInput): RecoveryPlan {
  const staleMs = input.staleMs ?? DEFAULT_HEARTBEAT_STALE_MS;
  const journal = input.journal;
  const accepted = [...journal.acceptedTaskIds];
  const snapshot = input.snapshot;

  if (snapshot && snapshot.runId !== journal.runId) {
    return result(input, {
      action: "pause",
      reason: "the persisted snapshot belongs to a different run",
      snapshotMatchesJournal: false,
      requiresOperator: true,
    });
  }
  if (journal.truncated > 0) {
    return result(input, {
      action: "pause",
      reason: `the journal has ${journal.truncated} unreadable/torn line(s); recover the journal before resuming`,
      requiresOperator: true,
    });
  }
  if (input.branch.kind !== "active") {
    return result(input, {
      action: "clone_required",
      reason: `branch ${input.branch.id} is ${input.branch.kind}; an active run/lease cannot be reused without an explicit clone decision`,
      requiresOperator: true,
    });
  }
  if (input.branch.activeRunId && input.branch.activeRunId !== journal.runId) {
    return result(input, {
      action: "clone_required",
      reason: "the active branch points at a different run; reconcile the run selection explicitly",
      requiresOperator: true,
    });
  }

  const snapshotAccepted = new Set(snapshot?.acceptedTaskIds ?? accepted);
  const extraInSnapshot = [...snapshotAccepted].filter((taskId) => !journal.acceptedTaskIds.has(taskId));
  const missingFromSnapshot = accepted.filter((taskId) => !snapshotAccepted.has(taskId));
  if (extraInSnapshot.length > 0) {
    return result(input, {
      action: "pause",
      reason: `the snapshot claims acceptance the journal never recorded: ${extraInSnapshot.join(", ")}`,
      snapshotMatchesJournal: false,
      requiresOperator: true,
    });
  }

  const sessions = probeSessions(input);
  const kickoff: KickoffReconciliation[] = [];
  const pausedTasks = new Set<string>();
  for (const [taskId, state] of Object.entries(journal.kickoff)) {
    const sessionId = state.ack?.sessionId ?? state.intent?.sessionId;
    const probe = input.sessions.find((entry) => entry.sessionRef === sessionId);
    kickoff.push({
      taskId,
      status: state.status,
      ...(state.intent ? { attemptId: state.intent.attemptId } : {}),
      ...(sessionId ? { sessionId } : {}),
      instruction: kickoffInstruction(state.status, probe?.sessionFile ?? null),
    });
    if (state.status === "uncertain" || state.status === "inconsistent") pausedTasks.add(taskId);
  }
  for (const taskId of [...sessions.missingAcknowledged, ...sessions.foreign]) pausedTasks.add(taskId);

  const parentCurrent = input.parent.identity.instanceId === input.current.instanceId;
  const parentFresh =
    input.now - input.parent.identity.heartbeatAt <= staleMs &&
    input.parent.identity.instanceId !== input.current.instanceId;
  const staleWriterPossible = !parentCurrent && (input.parent.alive || parentFresh);
  let ownership: RecoveryPlan["ownership"] = "unknown";
  if (parentCurrent) ownership = "current_instance";
  else if (input.parent.identity.instanceId) ownership = "old_instance";

  const base = {
    acceptedTaskIds: accepted,
    snapshotMatchesJournal: true,
    snapshotStale: missingFromSnapshot.length > 0,
    kickoff,
    sessions: sessions.reconciled,
    pausedTasks: [...pausedTasks],
    reconcileTasks: kickoff
      .filter((entry) => entry.status !== "acknowledged" && entry.status !== "not_started")
      .map((entry) => entry.taskId),
    ownership,
    staleWriterPossible,
  };

  if (staleWriterPossible) {
    return result(input, {
      ...base,
      action: "pause",
      reason: parentCurrent
        ? "reacquisition is safe"
        : "the previous parent may still be alive (fresh heartbeat/identity); TTL alone is not ownership",
      requiresOperator: true,
    });
  }
  if (!parentCurrent && !input.parent.alive) {
    return result(input, {
      ...base,
      action: "stop_children",
      reason: "the owning parent process is gone; stop the children safely before any new owner continues",
      stopChildren: true,
      requiresOperator: true,
    });
  }
  if (sessions.missingAcknowledged.length > 0) {
    return result(input, {
      ...base,
      action: "pause",
      reason: `an acknowledged kickoff has no live session file: ${sessions.missingAcknowledged.join(", ")}`,
      requiresOperator: true,
    });
  }
  if (sessions.foreign.length > 0) {
    return result(input, {
      ...base,
      action: "pause",
      reason: `a child session is owned by another process instance: ${sessions.foreign.join(", ")}`,
      requiresOperator: true,
    });
  }
  if (base.reconcileTasks.length > 0) {
    return result(input, {
      ...base,
      action: "reconcile_start",
      reason: "a task-start intent is uncertain or inconsistent; inspect before resuming",
      requiresOperator: true,
    });
  }
  if (base.snapshotStale) {
    return result(input, {
      ...base,
      action: "resume",
      reason: "the journal recorded acceptance the snapshot lacks; rebuild the snapshot and resume",
      resumeAllowed: true,
    });
  }
  return result(input, {
    ...base,
    action: "resume",
    reason: "journal, branch, parent identity and child sessions agree",
    resumeAllowed: true,
  });
}
