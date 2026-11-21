/**
 * Workflow Extension — evidence-backed parent acceptance (step 32).
 *
 * A worker report is a proposal. This module is where the PARENT turns a
 * quiescent candidate into (or refuses to turn it into) an accepted task:
 *
 *   - the actual baseline→candidate change set is captured by the parent,
 *     including untracked/deleted/binary/mode changes — never the worker's
 *     claim about which files it touched;
 *   - checks are executed through an injected, already-policy-gated port and
 *     their REAL exit status/output is recorded; a claimed pass with no
 *     evidence is a failure, not a pass;
 *   - a pre-existing red gate, an unavailable tool and a manual-only check are
 *     explicit blockers instead of being reported as success;
 *   - the evidence is fenced to the exact workspace revision and roadmap
 *     revision; a changed workspace invalidates it;
 *   - acceptance is one atomic state event and is idempotent by evidence id,
 *     so a retried tool call does not bump the revision twice.
 *
 * Everything is pure/injected: no git executable, clock or model is invoked.
 */

import { createHash } from "node:crypto";

import type { BaselineChange, WorkspaceBaseline } from "./orchestrator-workspace.ts";
import {
  ORCHESTRATOR_SCHEMA_VERSION,
  acceptanceBlocker,
  validateAcceptanceEvidence,
  type AcceptanceEvidence,
  type CheckStatus,
  type CriterionStatus,
  type EvidenceId,
  type Verdict,
  type VerificationCheck,
} from "./orchestrator-types.ts";
import { applyRunEvent, type RunState } from "./orchestrator-state.ts";

export const ACCEPTANCE_SCHEMA_VERSION = 1 as const;
export const MAX_CHECK_OUTPUT = 2_000;
export const MAX_CHECKS = 64;
export const MAX_CRITERIA = 256;
export const MAX_DIFF_FILES = 512;

// ── Parent-captured candidate changes ────────────────────────────────

export interface CandidateDiff {
  added: string[];
  modified: string[];
  deleted: string[];
  renamed: string[];
  binary: string[];
  filesChanged: number;
  files: string[];
  truncated: boolean;
}

function fingerprint(change: BaselineChange): string {
  return [change.status, change.staged ? "s" : "u", change.mode ?? "", change.size ?? ""].join(
    "\u0000",
  );
}

function byPath(baseline: WorkspaceBaseline): Map<string, BaselineChange> {
  const map = new Map<string, BaselineChange>();
  for (const change of baseline.changes) map.set(change.path, change);
  return map;
}

/**
 * Diffs the dispatch baseline against the fenced candidate baseline. This is
 * deliberately NOT `compareBaseline` (which reports external mutation): here
 * every difference is the candidate's effect and is attributed to this task.
 */
export function diffCandidateChanges(
  previous: WorkspaceBaseline,
  current: WorkspaceBaseline,
): CandidateDiff {
  const before = byPath(previous);
  const added: string[] = [];
  const modified: string[] = [];
  const deleted: string[] = [];
  const renamed: string[] = [];
  const binary: string[] = [];
  const seen = new Set<string>();

  for (const change of current.changes) {
    seen.add(change.path);
    const earlier = before.get(change.path);
    if (change.status === "binary") binary.push(change.path);
    if (!earlier) {
      if (change.status === "deleted") deleted.push(change.path);
      else if (change.status === "renamed") renamed.push(change.path);
      else added.push(change.path);
      continue;
    }
    if (change.status === "deleted") deleted.push(change.path);
    else if (change.status === "renamed") renamed.push(change.path);
    else if (fingerprint(earlier) !== fingerprint(change)) modified.push(change.path);
  }
  for (const change of previous.changes) {
    if (seen.has(change.path)) continue;
    deleted.push(change.path);
    if (change.status === "binary") binary.push(change.path);
  }

  const sort = (list: string[]) => [...new Set(list)].sort((left, right) => left.localeCompare(right));
  const files = sort([...added, ...modified, ...deleted, ...renamed, ...binary]);
  const limit = MAX_DIFF_FILES;
  return {
    added: sort(added).slice(0, limit),
    modified: sort(modified).slice(0, limit),
    deleted: sort(deleted).slice(0, limit),
    renamed: sort(renamed).slice(0, limit),
    binary: sort(binary).slice(0, limit),
    filesChanged: files.length,
    files: files.slice(0, limit),
    truncated: previous.truncated || current.truncated || files.length > limit,
  };
}

// ── Check execution ──────────────────────────────────────────────────

export interface CheckRequest {
  name: string;
  /** Command/action the already-gated executor should run; omitted for manual checks. */
  command?: string;
  required: boolean;
  /** A human-only acceptance criterion; never auto-passed. */
  manualOnly?: boolean;
  /** Tool/extension the check needs; when missing the check is explicitly blocked. */
  tool?: string;
}

export interface CheckObservation {
  status: CheckStatus;
  exitCode?: number | null;
  evidence?: string;
  durationMs?: number;
}

export interface CheckExecutor {
  run(request: {
    name: string;
    command?: string;
    taskId: string;
    cwd: string;
  }): Promise<CheckObservation>;
}

export interface BaselineCheck {
  name: string;
  status: CheckStatus;
  evidence?: string;
}

export interface ManualCheck {
  name: string;
  approvedBy?: string;
  note?: string;
}

export interface AcceptanceInput {
  runId: string;
  taskId: string;
  attemptId: string;
  candidateId: string;
  roadmapRevision: number;
  workspace: {
    /** Fenced workspace generation this evidence describes. */
    revision: string;
    quiescent: boolean;
  };
  baseline: WorkspaceBaseline;
  candidate: WorkspaceBaseline;
  /** Every requirement this task promised to cover. */
  requiredCriteria: readonly string[];
  /** Parent-observed criterion status (a worker claim is not proof on its own). */
  criteria: ReadonlyArray<{
    roadmapStepId: string;
    status: CriterionStatus;
    evidence?: string;
  }>;
  checks: readonly CheckRequest[];
  /** Checks that were already red before this candidate; they cannot become proof. */
  baselineChecks?: readonly BaselineCheck[];
  manualChecks?: readonly ManualCheck[];
  expectedPaths?: readonly string[];
  unavailableTools?: readonly string[];
  cwd: string;
  now: number;
}

export type AcceptancePhase = "accepted" | "needs_fix" | "blocked";

export interface AcceptanceOutcome {
  schemaVersion: typeof ACCEPTANCE_SCHEMA_VERSION;
  verdict: Verdict;
  phase: AcceptancePhase;
  evidence: AcceptanceEvidence;
  diff: CandidateDiff;
  checks: VerificationCheck[];
  blockers: string[];
  warnings: string[];
}

export type AcceptanceBuild =
  | { ok: true; outcome: AcceptanceOutcome }
  | { ok: false; code: "invalid"; error: string };

function bounded(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > max) return undefined;
  return trimmed;
}

function digest(value: unknown): string {
  const canonical = JSON.stringify(value);
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/** Deterministic id keeps a retried acceptance call idempotent. */
export function evidenceIdFor(input: {
  runId: string;
  taskId: string;
  attemptId: string;
  candidateId: string;
  workspaceRevision: string;
  roadmapRevision: number;
}): EvidenceId {
  const hash = createHash("sha256")
    .update(
      [
        input.runId,
        input.taskId,
        input.attemptId,
        input.candidateId,
        input.workspaceRevision,
        String(input.roadmapRevision),
      ].join("\u0000"),
      "utf8",
    )
    .digest("hex")
    .slice(0, 32);
  return `evidence-${hash}`;
}

function checkEvidence(observation: CheckObservation): string | undefined {
  const explicit = bounded(observation.evidence, MAX_CHECK_OUTPUT);
  if (explicit) return explicit;
  if (observation.exitCode === 0) return "exit 0";
  if (observation.exitCode !== undefined && observation.exitCode !== null) {
    return `exit ${observation.exitCode}`;
  }
  return undefined;
}

/**
 * Captures evidence and computes a verdict. It never throws for a failed
 * check: a failure is recorded, and `accepted` is returned only when nothing
 * blocks it.
 */
export async function runAcceptance(
  input: AcceptanceInput,
  executor: CheckExecutor,
): Promise<AcceptanceBuild> {
  for (const [label, value] of [
    ["runId", input.runId],
    ["taskId", input.taskId],
    ["attemptId", input.attemptId],
    ["candidateId", input.candidateId],
    ["workspace revision", input.workspace.revision],
  ] as const) {
    if (!bounded(value, 400)) return { ok: false, code: "invalid", error: `${label} is invalid` };
  }
  if (!Number.isInteger(input.roadmapRevision) || input.roadmapRevision < 1) {
    return { ok: false, code: "invalid", error: "roadmapRevision must be a positive integer" };
  }
  if (input.checks.length > MAX_CHECKS) {
    return { ok: false, code: "invalid", error: "too many checks" };
  }
  if (input.requiredCriteria.length > MAX_CRITERIA) {
    return { ok: false, code: "invalid", error: "too many required criteria" };
  }

  const diff = diffCandidateChanges(input.baseline, input.candidate);
  const blockers: string[] = [];
  const warnings: string[] = [];
  const unavailable = new Set((input.unavailableTools ?? []).filter(Boolean));
  const baseline = new Map((input.baselineChecks ?? []).map((check) => [check.name, check]));
  const checks: VerificationCheck[] = [];

  if (!input.workspace.quiescent) {
    blockers.push("the workspace is not quiescent; acceptance needs a fenced candidate");
  }
  if (input.checks.length === 0) {
    blockers.push("no verification checks were run");
  }
  if (diff.truncated) {
    blockers.push("the change set was truncated; acceptance needs a bounded, complete diff");
  }

  const expected = new Set((input.expectedPaths ?? []).map((path) => path.replace(/\\/g, "/")));
  for (const path of expected) {
    if (!diff.files.includes(path)) {
      blockers.push(`expected change is missing: ${path}`);
    }
  }

  for (const request of input.checks) {
    if (request.manualOnly) {
      const manual = (input.manualChecks ?? []).find((check) => check.name === request.name);
      if (!manual?.approvedBy) {
        blockers.push(`manual-only check has not been accepted by a human: ${request.name}`);
        checks.push({
          name: request.name,
          status: "skipped",
          evidence: "manual-only; no human acceptance recorded",
        });
      } else {
        checks.push({
          name: request.name,
          status: "passed",
          evidence: `manual acceptance by ${manual.approvedBy}`,
        });
      }
      continue;
    }
    if (request.tool && unavailable.has(request.tool)) {
      blockers.push(`required tool is unavailable: ${request.tool} (${request.name})`);
      checks.push({
        name: request.name,
        status: "skipped",
        evidence: `tool unavailable: ${request.tool}`,
      });
      continue;
    }

    let observation: CheckObservation;
    try {
      observation = await executor.run({
        name: request.name,
        ...(request.command ? { command: request.command } : {}),
        taskId: input.taskId,
        cwd: input.cwd,
      });
    } catch (error) {
      observation = {
        status: "failed",
        evidence: `executor error: ${String((error as Error)?.message ?? error).slice(0, 500)}`,
      };
    }

    const prior = baseline.get(request.name);
    if (prior?.status === "failed") {
      blockers.push(`pre-existing red gate cannot be proof: ${request.name}`);
      checks.push({
        name: request.name,
        status: observation.status,
        evidence: checkEvidence(observation) ?? "no evidence",
      });
      continue;
    }

    const evidence = checkEvidence(observation);
    if (observation.status === "passed" && !evidence) {
      blockers.push(`check ${request.name} claims a pass without recorded evidence`);
      checks.push({ name: request.name, status: "failed", evidence: "no recorded evidence" });
      continue;
    }
    if (observation.status === "failed" && request.required) {
      blockers.push(
        `required check failed: ${request.name}${evidence ? ` (${evidence.slice(0, 200)})` : ""}`,
      );
    } else if (observation.status === "skipped" && request.required) {
      blockers.push(`required check was skipped: ${request.name}`);
    }
    checks.push({
      name: request.name,
      status: observation.status,
      ...(evidence === undefined ? {} : { evidence }),
    });
  }

  const required = new Set(input.requiredCriteria);
  for (const criterion of input.criteria) {
    if (!required.has(criterion.roadmapStepId)) {
      warnings.push(`ignored criterion outside this task's scope: ${criterion.roadmapStepId}`);
      continue;
    }
    if (criterion.status !== "met") {
      blockers.push(`criterion ${criterion.roadmapStepId} is ${criterion.status}`);
    }
    required.delete(criterion.roadmapStepId);
  }
  for (const missing of required) {
    blockers.push(`criterion ${missing} has no parent-observed status`);
  }

  const blocked = blockers.some((blocker) =>
    /not quiescent|unavailable|manual-only|pre-existing|no verification checks|truncated|has no parent-observed/.test(
      blocker,
    ),
  );
  let phase: AcceptancePhase = "accepted";
  if (blocked) phase = "blocked";
  else if (blockers.length > 0) phase = "needs_fix";
  let verdict: Verdict = "needs_fix";
  if (phase === "accepted") verdict = "accepted";
  else if (phase === "blocked") verdict = "blocked";

  const notes = blockers.length > 0 ? blockers.join("; ").slice(0, 4_000) : undefined;
  const evidence: AcceptanceEvidence = {
    schemaVersion: ORCHESTRATOR_SCHEMA_VERSION,
    evidenceId: evidenceIdFor({
      runId: input.runId,
      taskId: input.taskId,
      attemptId: input.attemptId,
      candidateId: input.candidateId,
      workspaceRevision: input.workspace.revision,
      roadmapRevision: input.roadmapRevision,
    }),
    runId: input.runId,
    taskId: input.taskId,
    attemptId: input.attemptId,
    candidateId: input.candidateId,
    roadmapRevision: input.roadmapRevision,
    workspaceRevision: input.workspace.revision,
    inspected: { filesChanged: diff.filesChanged, files: diff.files },
    checks,
    verdict,
    ...(notes === undefined ? {} : { notes }),
    createdAt: input.now,
  };

  const validated = validateAcceptanceEvidence(evidence);
  if (!validated.ok) return { ok: false, code: "invalid", error: validated.error };
  return {
    ok: true,
    outcome: {
      schemaVersion: ACCEPTANCE_SCHEMA_VERSION,
      verdict,
      phase,
      evidence: validated.value,
      diff,
      checks,
      blockers,
      warnings,
    },
  };
}

// ── Atomic, idempotent acceptance ────────────────────────────────────

export type AcceptanceApplyCode =
  | "stale"
  | "evidence"
  | "workspace"
  | "state"
  | "invalid";

export type AcceptanceApply =
  | {
      ok: true;
      state: RunState;
      duplicate: boolean;
      evidenceId: string;
      revision: number;
      nextTaskId?: string;
    }
  | { ok: false; code: AcceptanceApplyCode; error: string };

/**
 * Applies one acceptance event. Re-applying the same evidence to the same
 * accepted task is a no-op (not a second acceptance); anything else must pass
 * the state machine's exact candidate/workspace/roadmap fence.
 */
export function applyAcceptanceDecision(input: {
  state: RunState;
  evidence: AcceptanceEvidence;
  /** Workspace fingerprint captured NOW; mismatching evidence is stale. */
  currentWorkspaceRevision: string;
  now: number;
  unmetCriteria?: readonly string[];
}): AcceptanceApply {
  const validated = validateAcceptanceEvidence(input.evidence);
  if (!validated.ok) return { ok: false, code: "invalid", error: validated.error };
  const evidence = validated.value;
  if (evidence.runId !== input.state.runId) {
    return { ok: false, code: "invalid", error: "evidence belongs to a different run" };
  }
  if (evidence.workspaceRevision !== input.currentWorkspaceRevision) {
    return {
      ok: false,
      code: "workspace",
      error: "the workspace changed after the evidence was captured",
    };
  }

  const task = input.state.tasks[evidence.taskId];
  if (!task) return { ok: false, code: "state", error: "evidence names an unknown task" };
  if (task.state === "accepted" && task.acceptance?.evidenceId === evidence.evidenceId) {
    return {
      ok: true,
      state: input.state,
      duplicate: true,
      evidenceId: evidence.evidenceId,
      revision: input.state.revision,
    };
  }

  const blocker = acceptanceBlocker({
    evidence,
    workspaceRevision: input.currentWorkspaceRevision,
    roadmapRevision: input.state.roadmapRevision,
    unmetCriteria: input.unmetCriteria ?? [],
  });
  if (blocker) return { ok: false, code: "evidence", error: blocker };

  const applied = applyRunEvent(input.state, {
    type: "task.accept",
    runId: input.state.runId,
    expectedRevision: input.state.revision,
    now: input.now,
    taskId: evidence.taskId,
    evidence,
    workspaceRevision: input.currentWorkspaceRevision,
    ...(input.unmetCriteria ? { unmetCriteria: [...input.unmetCriteria] } : {}),
  });
  if (!applied.ok) {
    let code: AcceptanceApplyCode = "state";
    if (applied.code === "stale_revision") code = "stale";
    else if (applied.code === "evidence") code = "evidence";
    return { ok: false, code, error: applied.error };
  }
  const nextTaskId = applied.state.order.find((id) => {
    const candidate = applied.state.tasks[id];
    return (
      candidate?.state === "pending" &&
      candidate.dependsOn.every((dependency) => applied.state.tasks[dependency]?.state === "accepted")
    );
  });
  return {
    ok: true,
    state: applied.state,
    duplicate: false,
    evidenceId: evidence.evidenceId,
    revision: applied.state.revision,
    ...(nextTaskId ? { nextTaskId } : {}),
  };
}

/** Stable digest of an outcome for a host/artifact summary. */
export function acceptanceDigest(outcome: AcceptanceOutcome): string {
  return digest({
    verdict: outcome.verdict,
    evidence: outcome.evidence,
    blockers: outcome.blockers,
  });
}
