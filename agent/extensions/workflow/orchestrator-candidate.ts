/**
 * Workflow Extension — structured candidate/report and quiescence fence (step 29).
 *
 * A report only PROPOSES completion. The parent may verify only after the child
 * is actually quiescent: settled, no tools in flight and no queued follow-ups.
 * At that point mutation authority is revoked and the child is inspection-only
 * until an explicit parent repair/resume authorization.
 *
 * This closes the common races:
 *   - a report sent inside a parallel tool batch waits for the batch to drain;
 *   - a pending follow-up/steer blocks the fence;
 *   - a silent/empty settle fences without a candidate (never success);
 *   - a late report after the fence is refused (needs resume);
 *   - `agent_end` is not settlement; only `agent_settled` is accepted.
 */

import {
  ORCHESTRATOR_SCHEMA_VERSION,
  validateWorkerReport,
  type WorkerReport,
} from "./orchestrator-types.ts";

export const CANDIDATE_SCHEMA_VERSION = 1 as const;

export type FencePhase = "open" | "report_received" | "fenced" | "resumed";

export interface CandidateState {
  schemaVersion: typeof CANDIDATE_SCHEMA_VERSION;
  phase: FencePhase;
  candidate?: WorkerReport;
  candidateAt?: number;
  /** Tools currently executing (parallel batches count). */
  pendingTools: number;
  /** Queued follow-ups/steers not yet consumed. */
  pendingFollowUps: number;
  /** True only after `agent_settled`; `agent_end` is not used. */
  settled: boolean;
  fencedAt?: number;
  reason?: string;
  /** Checkpoint summaries are notes, never candidates. */
  checkpoint?: { summary: string; at: number };
}

export type FenceCode = "fenced" | "invalid" | "mismatch" | "not_fenced" | "authorization";

export type FenceResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: FenceCode; error: string };

export function openCandidateFence(): CandidateState {
  return {
    schemaVersion: CANDIDATE_SCHEMA_VERSION,
    phase: "open",
    pendingTools: 0,
    pendingFollowUps: 0,
    settled: false,
  };
}

export function canMutate(state: CandidateState): boolean {
  return state.phase === "open" || state.phase === "report_received" || state.phase === "resumed";
}

function maybeFence(state: CandidateState, now: number): CandidateState {
  if (!state.settled || state.pendingTools > 0 || state.pendingFollowUps > 0) return state;
  if (state.candidate) {
    return { ...state, phase: "fenced", fencedAt: now, reason: "quiescent candidate" };
  }
  // Silent/empty settle: revoke mutation, but there is no candidate to verify.
  return {
    ...state,
    phase: "fenced",
    fencedAt: now,
    reason: "the child settled without a report",
  };
}

export function toolStarted(state: CandidateState): FenceResult<CandidateState> {
  if (!canMutate(state)) {
    return { ok: false, code: "fenced", error: "mutation authority is revoked; resume before a tool call" };
  }
  return { ok: true, value: { ...state, pendingTools: state.pendingTools + 1 } };
}

export function toolEnded(state: CandidateState, now: number): CandidateState {
  const pendingTools = Math.max(0, state.pendingTools - 1);
  return maybeFence({ ...state, pendingTools }, now);
}

export function followUpStarted(state: CandidateState): FenceResult<CandidateState> {
  if (!canMutate(state)) {
    return { ok: false, code: "fenced", error: "mutation authority is revoked; resume before a follow-up" };
  }
  return { ok: true, value: { ...state, pendingFollowUps: state.pendingFollowUps + 1 } };
}

export function followUpEnded(state: CandidateState, now: number): CandidateState {
  const pendingFollowUps = Math.max(0, state.pendingFollowUps - 1);
  return maybeFence({ ...state, pendingFollowUps }, now);
}

/** Only the settled signal counts; `agent_end` must not be routed here. */
export function agentSettled(state: CandidateState, now: number): CandidateState {
  return maybeFence({ ...state, settled: true }, now);
}

export interface ReportContext {
  runId: string;
  taskId: string;
  attemptId: string;
  sessionId: string;
}

/** Validates and stores a report; it never accepts work and never skips the fence. */
export function ingestWorkerReport(
  state: CandidateState,
  input: { raw: unknown; context: ReportContext; now: number },
): FenceResult<CandidateState> {
  if (state.phase === "fenced") {
    return { ok: false, code: "fenced", error: "the child is fenced; the parent must resume it first" };
  }
  const parsed = validateWorkerReport(input.raw);
  if (!parsed.ok) return { ok: false, code: "invalid", error: parsed.error };
  const report = parsed.value;
  const ctx = input.context;
  if (
    report.runId !== ctx.runId ||
    report.taskId !== ctx.taskId ||
    report.attemptId !== ctx.attemptId ||
    report.sessionId !== ctx.sessionId
  ) {
    return { ok: false, code: "mismatch", error: "the report belongs to another run/task/attempt/session" };
  }
  return {
    ok: true,
    value: maybeFence(
      {
        ...state,
        phase: "report_received",
        candidate: report,
        candidateAt: input.now,
        reason: "report received; waiting for quiescence",
      },
      input.now,
    ),
  };
}

/** A checkpoint is a progress note; it cannot become a candidate or fence. */
export function recordCheckpoint(
  state: CandidateState,
  input: { summary: string; now: number },
): CandidateState {
  const summary = input.summary.replace(/\s+/g, " ").trim().slice(0, 2_000);
  return {
    ...state,
    checkpoint: { summary, at: input.now },
  };
}

export interface AcceptEligibility {
  ok: boolean;
  reasons: string[];
}

/**
 * Eligibility for PARENT verification. It is not acceptance: evidence must
 * still pass `acceptanceBlocker` on the parent side.
 */
export function canAccept(state: CandidateState): AcceptEligibility {
  const reasons: string[] = [];
  if (state.phase !== "fenced") reasons.push("the child is not quiescent/fenced");
  if (!state.candidate) reasons.push("there is no candidate report");
  if (state.pendingTools > 0) reasons.push("tools are still in flight");
  if (state.pendingFollowUps > 0) reasons.push("follow-ups are still queued");
  if (state.candidate) {
    if (state.candidate.outcome !== "candidate") {
      reasons.push(`report outcome is ${state.candidate.outcome}, not candidate`);
    }
    if (!state.candidate.criteria.some((criterion) => criterion.status === "met")) {
      reasons.push("the report claims no met criteria");
    }
  }
  return { ok: reasons.length === 0, reasons };
}

/** Explicit parent authorization to repair/resume after the fence. */
export function resumeForRepair(
  state: CandidateState,
  input: { authorization: string; now: number },
): FenceResult<CandidateState> {
  if (state.phase !== "fenced") {
    return { ok: false, code: "not_fenced", error: "only a fenced child can be resumed" };
  }
  if (input.authorization !== "repair-authorized") {
    return { ok: false, code: "authorization", error: "an explicit parent repair authorization is required" };
  }
  return {
    ok: true,
    value: {
      ...state,
      phase: "resumed",
      settled: false,
      candidate: undefined,
      candidateAt: undefined,
      fencedAt: undefined,
      reason: "parent authorized repair",
    },
  };
}

/** Metadata used by the coordinator when recording the fence in the journal. */
export function fenceEvent(state: CandidateState): {
  phase: FencePhase;
  candidateId?: string;
  reportId?: string;
  reason?: string;
} {
  return {
    phase: state.phase,
    ...(state.candidate ? { candidateId: `candidate-${state.candidate.reportId}`, reportId: state.candidate.reportId } : {}),
    ...(state.reason ? { reason: state.reason } : {}),
  };
}

/** The report schema this module accepts, for tool registration. */
export const WORKER_REPORT_SCHEMA_VERSION = ORCHESTRATOR_SCHEMA_VERSION;
