/**
 * Workflow Extension — Orchestrator contracts (schema v1).
 *
 * This module is the single source of truth for the DURABLE parts of an
 * orchestrated run: identities, state transitions, worker reports and parent
 * acceptance evidence. It is pure (no Pi SDK, no Node imports) and therefore
 * usable from a test, a worker process or the durable store.
 *
 * Three rules govern everything here:
 *
 *  1. **The engine decides, the model proposes.** The model supplies a task
 *     breakdown, a report and a verdict suggestion. Only a validated transition
 *     (this module) can move a task to `accepted` or a run to `completed`.
 *  2. **Identity is not display numbering.** `roadmapStepId` / `taskId` /
 *     `attemptId` are stable; the `1..N` numbers a user sees in a TODO panel
 *     are presentation only. A child's local step 3 is never the parent's
 *     roadmap step 3.
 *  3. **Unknown versions fail closed.** A reader that does not know a schema
 *     version must reject the document, not partially interpret it.
 *
 * The wire contract between an extension and a host (mode badges, actions,
 * related sessions) lives in `host-contributions.ts`; the child-session launch
 * contract lives in `session-host.ts`. This file never imports either.
 */

/** The only schema version this build can read or write. */
export const ORCHESTRATOR_SCHEMA_VERSION = 1 as const;

// ── Identities ───────────────────────────────────────────────────────

/**
 * Identifiers are opaque strings with a prefix. The prefix is diagnostic
 * only — never parse one to recover semantics.
 */
export type RunId = string;
export type RoadmapStepId = string;
export type TaskId = string;
export type AttemptId = string;
export type CandidateId = string;
export type ReportId = string;
export type EvidenceId = string;
export type SessionId = string;

const ID_PATTERN = /^[a-z]+-[A-Za-z0-9._-]{1,96}$/;

/** Validates one prefixed identifier. `kind` is the expected prefix. */
export function isIdentifier(kind: string, value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (!ID_PATTERN.test(value)) return false;
  return value.startsWith(`${kind}-`);
}

export function makeId(kind: string, suffix: string): string {
  const safe = suffix.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 80);
  return `${kind}-${safe}`;
}

// ── Run phases ───────────────────────────────────────────────────────

export const RUN_PHASES = [
  "ready",
  "running",
  "paused",
  "blocked",
  "completed",
  "failed",
  "cancelled",
] as const;

export type RunPhase = (typeof RUN_PHASES)[number];

/**
 * Allowed transitions. A transition not listed here is rejected — in
 * particular, nothing leaves a terminal phase, and `completed` is reachable
 * only from `final_verification`.
 */
export const RUN_TRANSITIONS: Readonly<Record<RunPhase, readonly RunPhase[]>> = {
  ready: ["running", "paused", "blocked", "completed", "cancelled", "failed"],
  running: ["ready", "paused", "blocked", "completed", "cancelled", "failed"],
  paused: ["ready", "running", "cancelled", "failed"],
  blocked: ["ready", "running", "paused", "cancelled", "failed"],
  completed: [],
  failed: [],
  cancelled: [],
};

export const TERMINAL_RUN_PHASES: ReadonlySet<RunPhase> = new Set([
  "completed",
  "failed",
  "cancelled",
]);

export function isRunPhase(value: unknown): value is RunPhase {
  return typeof value === "string" && (RUN_PHASES as readonly string[]).includes(value);
}

export function canTransitionRun(from: RunPhase, to: RunPhase): boolean {
  return RUN_TRANSITIONS[from].includes(to);
}

// ── Task states ──────────────────────────────────────────────────────

export const TASK_STATES = [
  "pending",
  "running",
  "candidate",
  "needs_fix",
  "accepted",
  "blocked",
] as const;

export type TaskState = (typeof TASK_STATES)[number];

/**
 * Allowed task transitions.
 *
 * Notes that matter for correctness:
 *  - `accepted` can only be entered from `verifying`;
 *  - `candidate` can only be entered from `running` (a report needs a run);
 *  - `accepted → running` is deliberately absent: further work is a NEW task or
 *    an explicit `superseded` + replacement, so accepted evidence is immutable;
 *  - a failed launch moves `assigned → pending` (retryable) rather than
 *    pretending the worker ran.
 */
export const TASK_TRANSITIONS: Readonly<Record<TaskState, readonly TaskState[]>> = {
  pending: ["running", "blocked"],
  running: ["candidate", "needs_fix", "blocked"],
  candidate: ["accepted", "needs_fix", "blocked"],
  needs_fix: ["running", "blocked"],
  accepted: [],
  blocked: ["pending", "running"],
};

export const TERMINAL_TASK_STATES: ReadonlySet<TaskState> = new Set(["accepted"]);

/**
 * States in which a row needs no further default action.
 */
export const SETTLED_TASK_STATES: ReadonlySet<TaskState> = new Set(["accepted"]);

export function isTaskState(value: unknown): value is TaskState {
  return typeof value === "string" && (TASK_STATES as readonly string[]).includes(value);
}

export function canTransitionTask(from: TaskState, to: TaskState): boolean {
  return TASK_TRANSITIONS[from].includes(to);
}

// ── Budgets ──────────────────────────────────────────────────────────

/**
 * Conservative, configurable defaults. Every counter here is persisted with
 * the task; a rollover, reload or model switch never resets one.
 */
export interface ExecutionBudgets {
  /** Repair rounds after the first candidate. */
  repairRounds: number;
  /** Consecutive outcomes with no meaningful change before pausing. */
  noProgressLimit: number;
  /** Fresh continuation sessions allowed for one task. */
  rolloverLimit: number;
  /** Launch failures tolerated for one task before blocking. */
  launchFailureLimit: number;
}

export const DEFAULT_EXECUTION_BUDGETS: Readonly<ExecutionBudgets> = {
  repairRounds: 2,
  noProgressLimit: 2,
  rolloverLimit: 2,
  launchFailureLimit: 3,
};

/** Hard caps: a config file can only make these stricter, never unbounded. */
export const MAX_EXECUTION_BUDGETS: Readonly<ExecutionBudgets> = {
  repairRounds: 5,
  noProgressLimit: 5,
  rolloverLimit: 5,
  launchFailureLimit: 10,
};

export function coerceExecutionBudgets(raw: unknown): ExecutionBudgets {
  const base = { ...DEFAULT_EXECUTION_BUDGETS };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return base;
  const record = raw as Record<string, unknown>;
  for (const key of Object.keys(base) as Array<keyof ExecutionBudgets>) {
    const value = record[key];
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    const clamped = Math.max(0, Math.min(MAX_EXECUTION_BUDGETS[key], Math.floor(value)));
    base[key] = clamped;
  }
  return base;
}

// ── Coverage and task shape ──────────────────────────────────────────

/** One stable requirement extracted from the approved roadmap. */
export interface RoadmapRequirement {
  roadmapStepId: RoadmapStepId;
  /** The roadmap's own label (e.g. `2.1`), presentation only. */
  label: string;
  /** Phase/group heading the step appeared under, if any. */
  group?: string;
  text: string;
  /** 1-based line range in the approved snapshot, for citations. */
  sourceLines?: { start: number; end: number };
}

export interface PlannedTask {
  taskId: TaskId;
  /** Every roadmap requirement this task must satisfy. */
  covers: RoadmapStepId[];
  objective: string;
  nonGoals: string[];
  /** Task ids that must be accepted before this one may start. */
  dependsOn: TaskId[];
  expectedFiles: string[];
  acceptanceChecks: string[];
  /** Why this task fits one worker context (the budget service validates). */
  sizeRationale: string;
}

export interface TaskPlan {
  schemaVersion: typeof ORCHESTRATOR_SCHEMA_VERSION;
  runId: RunId;
  /** Approved roadmap revision this plan maps. */
  roadmapRevision: number;
  tasks: PlannedTask[];
}

export type PlanCoverage =
  | { ok: true }
  | { ok: false; error: string; uncovered: RoadmapStepId[]; unknown: RoadmapStepId[] };

/**
 * Structural coverage check: every requirement is covered by at least one task,
 * no task cites an unknown requirement, and dependencies form a DAG. It does
 * NOT judge whether a task is well-sized (that is the budget service's job).
 */
export function validatePlanCoverage(input: {
  requirements: readonly RoadmapRequirement[];
  tasks: readonly PlannedTask[];
}): PlanCoverage {
  const known = new Set(input.requirements.map((requirement) => requirement.roadmapStepId));
  const covered = new Set<RoadmapStepId>();
  const taskIds = new Set<TaskId>();
  const unknown: RoadmapStepId[] = [];
  for (const task of input.tasks) {
    if (taskIds.has(task.taskId)) {
      return { ok: false, error: `duplicate task id ${task.taskId}`, uncovered: [], unknown: [] };
    }
    taskIds.add(task.taskId);
    if (task.covers.length === 0) {
      return { ok: false, error: `task ${task.taskId} covers no requirement`, uncovered: [], unknown: [] };
    }
    for (const id of task.covers) {
      if (!known.has(id)) unknown.push(id);
      covered.add(id);
    }
  }
  for (const task of input.tasks) {
    for (const dependency of task.dependsOn) {
      if (!taskIds.has(dependency)) {
        return {
          ok: false,
          error: `task ${task.taskId} depends on unknown task ${dependency}`,
          uncovered: [],
          unknown: [],
        };
      }
    }
  }
  const cycle = findDependencyCycle(input.tasks);
  if (cycle) return { ok: false, error: `dependency cycle: ${cycle.join(" → ")}`, uncovered: [], unknown: [] };

  const uncovered = [...known].filter((id) => !covered.has(id));
  if (unknown.length > 0 || uncovered.length > 0) {
    return {
      ok: false,
      error: `${uncovered.length} uncovered requirement(s), ${unknown.length} unknown id(s)`,
      uncovered,
      unknown,
    };
  }
  return { ok: true };
}

/** Returns the first cycle as a readable chain, or undefined for a DAG. */
export function findDependencyCycle(tasks: readonly PlannedTask[]): string[] | undefined {
  const byId = new Map(tasks.map((task) => [task.taskId, task]));
  const visiting = new Set<string>();
  const done = new Set<string>();

  const walk = (id: string, path: string[]): string[] | undefined => {
    if (done.has(id)) return undefined;
    if (visiting.has(id)) {
      const start = path.indexOf(id);
      return [...path.slice(start >= 0 ? start : 0), id];
    }
    visiting.add(id);
    path.push(id);
    for (const dependency of byId.get(id)?.dependsOn ?? []) {
      const found = walk(dependency, path);
      if (found) return found;
    }
    path.pop();
    visiting.delete(id);
    done.add(id);
    return undefined;
  };

  for (const task of tasks) {
    const found = walk(task.taskId, []);
    if (found) return found;
  }
  return undefined;
}

// ── Worker reports ───────────────────────────────────────────────────

export const REPORT_OUTCOMES = ["candidate", "partial", "blocked"] as const;
export type ReportOutcome = (typeof REPORT_OUTCOMES)[number];

export const CRITERION_STATUSES = ["met", "unmet", "unknown"] as const;
export type CriterionStatus = (typeof CRITERION_STATUSES)[number];

export const CHECK_STATUSES = ["passed", "failed", "skipped"] as const;
export type CheckStatus = (typeof CHECK_STATUSES)[number];

/** Bounds on a worker report, so a runaway child cannot flood the parent. */
export const REPORT_LIMITS = {
  maxCriteria: 256,
  maxChecks: 64,
  maxFiles: 512,
  maxRemaining: 64,
  maxRisks: 32,
  maxArtifacts: 64,
  maxText: 2_000,
} as const;

export interface WorkerReport {
  schemaVersion: typeof ORCHESTRATOR_SCHEMA_VERSION;
  reportId: ReportId;
  runId: RunId;
  taskId: TaskId;
  attemptId: AttemptId;
  sessionId: SessionId;
  outcome: ReportOutcome;
  /** Criteria the worker claims; a claim is verified by the parent. */
  criteria: Array<{
    roadmapStepId: RoadmapStepId;
    status: CriterionStatus;
    note?: string;
  }>;
  changes: { files: string[]; summary: string };
  checks: Array<{ name: string; status: CheckStatus; detail?: string }>;
  remaining: string[];
  risks: string[];
  artifacts: Array<{ id: string; kind: string; path?: string }>;
  createdAt: number;
}

export interface TextResult<T> {
  ok: true;
  value: T;
}
export interface ErrorResult {
  ok: false;
  error: string;
}
export type ContractResult<T> = TextResult<T> | ErrorResult;

function fail(error: string): ErrorResult {
  return { ok: false, error };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function boundedString(value: unknown, max: number = REPORT_LIMITS.maxText): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > max) return undefined;
  // A multi-line claim would render as several rows/lines in a host; reject it
  // instead of silently collapsing it.
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return undefined;
  return trimmed;
}

function boundedStringArray(
  value: unknown,
  max: number,
  maxChars: number = REPORT_LIMITS.maxText,
): string[] | undefined {
  if (!Array.isArray(value) || value.length > max) return undefined;
  const out: string[] = [];
  for (const entry of value) {
    const text = boundedString(entry, maxChars);
    if (text === undefined) return undefined;
    out.push(text);
  }
  return out;
}

/**
 * Validates a worker report. Unknown extra fields are ignored (forward
 * compatibility); unknown `schemaVersion` is rejected. The returned value is a
 * fresh, bounded copy — never the caller's object.
 */
export function validateWorkerReport(raw: unknown): ContractResult<WorkerReport> {
  if (!isRecord(raw)) return fail("report must be an object");
  if (raw.schemaVersion !== ORCHESTRATOR_SCHEMA_VERSION) {
    return fail(`unsupported report schema version ${String(raw.schemaVersion)}`);
  }
  for (const key of ["reportId", "runId", "taskId", "attemptId", "sessionId"] as const) {
    if (!isIdentifier(key.replace(/Id$/, "").toLowerCase(), raw[key])) {
      return fail(`invalid ${key}`);
    }
  }
  if (!(REPORT_OUTCOMES as readonly unknown[]).includes(raw.outcome)) {
    return fail("invalid outcome");
  }
  if (!isRecord(raw.changes)) return fail("changes must be an object");
  const files = boundedStringArray(raw.changes.files, REPORT_LIMITS.maxFiles, 512);
  if (files === undefined) return fail("changes.files must be bounded path strings");
  const summary = boundedString(raw.changes.summary);
  if (summary === undefined) return fail("changes.summary is required");

  if (!Array.isArray(raw.criteria) || raw.criteria.length > REPORT_LIMITS.maxCriteria) {
    return fail("criteria must be a bounded array");
  }
  const criteria: WorkerReport["criteria"] = [];
  for (const entry of raw.criteria) {
    if (!isRecord(entry)) return fail("criterion must be an object");
    if (!isIdentifier("step", entry.roadmapStepId)) return fail("invalid criterion roadmapStepId");
    if (!(CRITERION_STATUSES as readonly unknown[]).includes(entry.status)) {
      return fail("invalid criterion status");
    }
    const note = entry.note === undefined ? undefined : boundedString(entry.note, 500);
    if (entry.note !== undefined && note === undefined) return fail("criterion note is too long");
    criteria.push({
      roadmapStepId: entry.roadmapStepId,
      status: entry.status as CriterionStatus,
      ...(note === undefined ? {} : { note }),
    });
  }

  if (!Array.isArray(raw.checks) || raw.checks.length > REPORT_LIMITS.maxChecks) {
    return fail("checks must be a bounded array");
  }
  const checks: WorkerReport["checks"] = [];
  for (const entry of raw.checks) {
    if (!isRecord(entry)) return fail("check must be an object");
    const name = boundedString(entry.name, 200);
    if (name === undefined) return fail("check.name is required");
    if (!(CHECK_STATUSES as readonly unknown[]).includes(entry.status)) {
      return fail("invalid check status");
    }
    const detail = entry.detail === undefined ? undefined : boundedString(entry.detail, 1_000);
    if (entry.detail !== undefined && detail === undefined) return fail("check.detail is too long");
    checks.push({
      name,
      status: entry.status as CheckStatus,
      ...(detail === undefined ? {} : { detail }),
    });
  }

  const remaining = boundedStringArray(raw.remaining, REPORT_LIMITS.maxRemaining);
  if (remaining === undefined) return fail("remaining must be a bounded string array");
  const risks = boundedStringArray(raw.risks, REPORT_LIMITS.maxRisks);
  if (risks === undefined) return fail("risks must be a bounded string array");

  if (!Array.isArray(raw.artifacts) || raw.artifacts.length > REPORT_LIMITS.maxArtifacts) {
    return fail("artifacts must be a bounded array");
  }
  const artifacts: WorkerReport["artifacts"] = [];
  for (const entry of raw.artifacts) {
    if (!isRecord(entry)) return fail("artifact must be an object");
    const id = boundedString(entry.id, 200);
    const kind = boundedString(entry.kind, 100);
    if (!id || !kind) return fail("artifact id and kind are required");
    const path = entry.path === undefined ? undefined : boundedString(entry.path, 1_000);
    if (entry.path !== undefined && path === undefined) return fail("artifact path is too long");
    artifacts.push({ id, kind, ...(path === undefined ? {} : { path }) });
  }

  if (typeof raw.createdAt !== "number" || !Number.isFinite(raw.createdAt) || raw.createdAt <= 0) {
    return fail("createdAt must be a positive timestamp");
  }

  return {
    ok: true,
    value: {
      schemaVersion: ORCHESTRATOR_SCHEMA_VERSION,
      reportId: raw.reportId as string,
      runId: raw.runId as string,
      taskId: raw.taskId as string,
      attemptId: raw.attemptId as string,
      sessionId: raw.sessionId as string,
      outcome: raw.outcome as ReportOutcome,
      criteria,
      changes: { files, summary },
      checks,
      remaining,
      risks,
      artifacts,
      createdAt: raw.createdAt,
    },
  };
}

// ── Acceptance evidence ──────────────────────────────────────────────

export const VERDICTS = ["accepted", "needs_fix", "blocked"] as const;
export type Verdict = (typeof VERDICTS)[number];

export interface VerificationCheck {
  name: string;
  status: CheckStatus;
  /** Actual command/output reference; never an unverified claim. */
  evidence?: string;
}

export interface AcceptanceEvidence {
  schemaVersion: typeof ORCHESTRATOR_SCHEMA_VERSION;
  evidenceId: EvidenceId;
  runId: RunId;
  taskId: TaskId;
  attemptId: AttemptId;
  candidateId: CandidateId;
  roadmapRevision: number;
  /** Fenced workspace state the evidence was produced against. */
  workspaceRevision: string;
  inspected: { filesChanged: number; files: string[] };
  checks: VerificationCheck[];
  verdict: Verdict;
  notes?: string;
  createdAt: number;
}

/**
 * Why acceptance evidence is rejected. The parent must never accept a task on
 * the strength of a prose message, a child-local TODO or an exit code.
 */
export function acceptanceBlocker(input: {
  evidence: AcceptanceEvidence | undefined;
  /** Current workspace generation; evidence from another one is stale. */
  workspaceRevision: string;
  roadmapRevision: number;
  /** Criteria the parent still considers unmet. */
  unmetCriteria: readonly string[];
}): string | undefined {
  const evidence = input.evidence;
  if (!evidence) return "no acceptance evidence";
  if (evidence.verdict !== "accepted") return `verdict is ${evidence.verdict}`;
  if (evidence.workspaceRevision !== input.workspaceRevision) {
    return "evidence was produced against a different workspace revision";
  }
  if (evidence.roadmapRevision !== input.roadmapRevision) {
    return "evidence was produced against a different roadmap revision";
  }
  if (input.unmetCriteria.length > 0) {
    return `unmet criteria: ${input.unmetCriteria.join(", ")}`;
  }
  return undefined;
}

export function validateAcceptanceEvidence(raw: unknown): ContractResult<AcceptanceEvidence> {
  if (!isRecord(raw)) return fail("evidence must be an object");
  if (raw.schemaVersion !== ORCHESTRATOR_SCHEMA_VERSION) {
    return fail(`unsupported evidence schema version ${String(raw.schemaVersion)}`);
  }
  for (const key of ["evidenceId", "runId", "taskId", "attemptId", "candidateId"] as const) {
    if (!isIdentifier(key.replace(/Id$/, "").toLowerCase(), raw[key])) {
      return fail(`invalid ${key}`);
    }
  }
  if (!(VERDICTS as readonly unknown[]).includes(raw.verdict)) return fail("invalid verdict");
  if (typeof raw.roadmapRevision !== "number" || !Number.isInteger(raw.roadmapRevision)) {
    return fail("roadmapRevision must be an integer");
  }
  const workspaceRevision = boundedString(raw.workspaceRevision, 200);
  if (!workspaceRevision) return fail("workspaceRevision is required");

  if (!isRecord(raw.inspected)) return fail("inspected must be an object");
  if (
    typeof raw.inspected.filesChanged !== "number" ||
    !Number.isInteger(raw.inspected.filesChanged) ||
    raw.inspected.filesChanged < 0
  ) {
    return fail("inspected.filesChanged must be a non-negative integer");
  }
  const files = boundedStringArray(raw.inspected.files, REPORT_LIMITS.maxFiles, 512);
  if (files === undefined) return fail("inspected.files must be bounded path strings");

  if (!Array.isArray(raw.checks) || raw.checks.length > REPORT_LIMITS.maxChecks) {
    return fail("checks must be a bounded array");
  }
  const checks: VerificationCheck[] = [];
  for (const entry of raw.checks) {
    if (!isRecord(entry)) return fail("check must be an object");
    const name = boundedString(entry.name, 200);
    if (!name) return fail("check.name is required");
    if (!(CHECK_STATUSES as readonly unknown[]).includes(entry.status)) {
      return fail("invalid check status");
    }
    const evidence =
      entry.evidence === undefined ? undefined : boundedString(entry.evidence, 1_000);
    if (entry.evidence !== undefined && evidence === undefined) {
      return fail("check.evidence is too long");
    }
    checks.push({
      name,
      status: entry.status as CheckStatus,
      ...(evidence === undefined ? {} : { evidence }),
    });
  }

  const notes = raw.notes === undefined ? undefined : boundedString(raw.notes);
  if (raw.notes !== undefined && notes === undefined) return fail("notes is too long");
  if (typeof raw.createdAt !== "number" || !Number.isFinite(raw.createdAt) || raw.createdAt <= 0) {
    return fail("createdAt must be a positive timestamp");
  }

  return {
    ok: true,
    value: {
      schemaVersion: ORCHESTRATOR_SCHEMA_VERSION,
      evidenceId: raw.evidenceId as string,
      runId: raw.runId as string,
      taskId: raw.taskId as string,
      attemptId: raw.attemptId as string,
      candidateId: raw.candidateId as string,
      roadmapRevision: raw.roadmapRevision,
      workspaceRevision,
      inspected: { filesChanged: raw.inspected.filesChanged, files },
      checks,
      verdict: raw.verdict as Verdict,
      ...(notes === undefined ? {} : { notes }),
      createdAt: raw.createdAt,
    },
  };
}

// ── Single-writer helpers ────────────────────────────────────────────

/** Who may mutate the workspace for a task. */
export interface MutationGrant {
  runId: RunId;
  taskId: TaskId;
  attemptId: AttemptId;
  sessionId: SessionId;
  /** Monotonic lease generation; a stale holder is refused. */
  generation: number;
}

/**
 * True when `grant` is the only valid writer for the workspace. Kept as a pure
 * predicate so the store and in-process children agree on one rule.
 */
export function ownsWorkspace(grant: MutationGrant | undefined, candidate: MutationGrant): boolean {
  return (
    grant !== undefined &&
    grant.runId === candidate.runId &&
    grant.taskId === candidate.taskId &&
    grant.attemptId === candidate.attemptId &&
    grant.sessionId === candidate.sessionId &&
    grant.generation === candidate.generation
  );
}
