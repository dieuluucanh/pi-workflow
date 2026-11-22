/**
 * Workflow Extension — roadmap projection + final integration gate (step 36).
 *
 * Completion is projected from ACCEPTED TASK COVERAGE only. A child's local
 * TODOs, a `[DONE]` tag, a report or a green child run are never consulted —
 * "all child TODOs done" cannot complete a roadmap.
 *
 * Coverage is conservative: a requirement stays open while any covering task
 * that was not superseded is not accepted, so one step split across several
 * tasks stays open until every one of them is accepted. Cancelled/blocked/
 * deferred distinctions are preserved instead of collapsed into "pending".
 *
 * After every requirement is covered, the final integration/regression/manual
 * checks run against the latest workspace. A failure keeps the run
 * non-complete and returns a scoped repair proposal; a scope-changing repair
 * requires a new approval. Only a fully green, quiescence-fenced, drift-free
 * gate may move the run to `final_verification` and then `completed`.
 */

import { createHash } from "node:crypto";

import { applyRunEvent, type RunState, type TaskRecord } from "./orchestrator-state.ts";
import { canTransitionRun, type CheckStatus, type RunPhase } from "./orchestrator-types.ts";
import type { RoadmapRequirementSnapshot, RoadmapSnapshot } from "./orchestrator-plan.ts";
import type { CheckExecutor } from "./orchestrator-acceptance.ts";

export const GATE_SCHEMA_VERSION = 1 as const;
export const MAX_FINAL_SUMMARY = 4_000;
export const MAX_GATE_CHECKS = 64;
export const MAX_FINAL_ARTIFACT = 2 * 1024 * 1024;

export type RequirementState =
  | "complete"
  | "in_progress"
  | "pending"
  | "blocked"
  | "cancelled"
  | "deferred";

export interface CoveringTask {
  taskId: string;
  state: string;
}

export interface RequirementProjection {
  requirementId: string;
  label: string;
  text: string;
  state: RequirementState;
  coveringTasks: CoveringTask[];
  reason?: string;
}

export interface RoadmapProjection {
  schemaVersion: typeof GATE_SCHEMA_VERSION;
  runId: string;
  roadmapRevision: number;
  total: number;
  completeCount: number;
  complete: boolean;
  requirements: RequirementProjection[];
  blockers: string[];
  /** Makes the source of truth explicit in the artifact/UI. */
  projectedFrom: "accepted_tasks";
}

function coveringTasks(state: RunState, requirementId: string): TaskRecord[] {
  return state.order
    .map((taskId) => state.tasks[taskId])
    .filter((task): task is TaskRecord => task !== undefined && task.covers.includes(requirementId));
}

function projectRequirement(
  state: RunState,
  requirement: RoadmapRequirementSnapshot,
): RequirementProjection {
  const covering = coveringTasks(state, requirement.roadmapStepId);
  const mapped = covering.map((task) => ({ taskId: task.taskId, state: task.state }));
  const base = {
    requirementId: requirement.roadmapStepId,
    label: requirement.label,
    text: requirement.text,
    coveringTasks: mapped,
  };

  if (covering.length === 0) {
    return { ...base, state: "pending", reason: "no task covers this requirement" };
  }
  const active = covering.filter((task) => task.state !== "superseded");
  if (active.length === 0) {
    return {
      ...base,
      state: "deferred",
      reason: "every covering task was superseded; a replacement scope needs approval",
    };
  }
  if (active.every((task) => task.state === "accepted")) {
    return { ...base, state: "complete" };
  }
  if (active.some((task) => task.state === "blocked")) {
    return { ...base, state: "blocked", reason: "a covering task is blocked" };
  }
  if (active.every((task) => task.state === "cancelled")) {
    return { ...base, state: "cancelled", reason: "every covering task was cancelled" };
  }
  if (active.some((task) => task.state === "cancelled")) {
    return {
      ...base,
      state: "in_progress",
      reason: "a cancelled covering task still needs an accepted replacement",
    };
  }
  return {
    ...base,
    state: "in_progress",
    reason: "a covering task is not accepted",
  };
}

/**
 * Projects roadmap status from accepted task coverage. Deliberately takes no
 * child TODO/report input, so child-local completion cannot leak upward.
 */
export function projectRoadmapCompletion(
  snapshot: RoadmapSnapshot,
  state: RunState,
): RoadmapProjection {
  const requirements = snapshot.requirements.map((requirement) =>
    projectRequirement(state, requirement),
  );
  const completeCount = requirements.filter((requirement) => requirement.state === "complete").length;
  const blockers = requirements
    .filter((requirement) => requirement.state !== "complete")
    .map(
      (requirement) =>
        `${requirement.requirementId} is ${requirement.state}${requirement.reason ? `: ${requirement.reason}` : ""}`,
    );
  return {
    schemaVersion: GATE_SCHEMA_VERSION,
    runId: state.runId,
    roadmapRevision: state.roadmapRevision,
    total: requirements.length,
    completeCount,
    complete: requirements.length > 0 && completeCount === requirements.length,
    requirements,
    blockers,
    projectedFrom: "accepted_tasks",
  };
}

// ── Final integration checks ─────────────────────────────────────────

export interface FinalCheckRequest {
  name: string;
  required: boolean;
  manualOnly?: boolean;
  command?: string;
  tool?: string;
}

export interface FinalCheckResult {
  name: string;
  status: CheckStatus;
  evidence?: string;
  exitCode?: number | null;
  manual?: boolean;
  unavailableTool?: string;
  preExistingFailure?: boolean;
  /** A required check was never run; this is missing evidence, not a failure. */
  missing?: boolean;
}

export interface FinalGateInput {
  snapshot: RoadmapSnapshot;
  state: RunState;
  /** Fenced state the parent observed now. */
  workspace: { revision: string; quiescent: boolean };
  /** Workspace revision the integration checks actually ran against. */
  verifiedWorkspaceRevision: string;
  checks: readonly FinalCheckResult[];
  requiredChecks: readonly string[];
  manualAcceptance: ReadonlyArray<{ name: string; approvedBy?: string }>;
  baselineChecks?: ReadonlyArray<{ name: string; status: CheckStatus }>;
  /** The user's approved roadmap identity; drift blocks completion. */
  approval: { roadmapDigest: string; roadmapRevision: number };
  now: number;
}

export interface RepairProposal {
  scope: "task" | "integration";
  reason: string;
  failedChecks: string[];
  /** Integration-level scope was never in an accepted task's promise. */
  requiresApproval: boolean;
  suggestedRound: number;
}

export interface FinalArtifact {
  name: "final-summary.json";
  content: string;
  digest: string;
  bytes: number;
}

export type FinalGateDecision =
  | {
      ok: true;
      decision: "complete";
      projection: RoadmapProjection;
      summary: string;
      artifact: FinalArtifact;
      blockers: [];
    }
  | {
      ok: true;
      decision: "repair";
      projection: RoadmapProjection;
      repair: RepairProposal;
      blockers: string[];
      summary: string;
    }
  | {
      ok: true;
      decision: "not_complete";
      projection: RoadmapProjection;
      blockers: string[];
      summary: string;
      /** Present when the gate stopped before running checks. */
      repair?: RepairProposal;
    }
  | { ok: false; code: "invalid"; error: string };

function bounded(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 30)}…[truncated]` : value;
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function acceptedCheckNames(state: RunState): Set<string> {
  const names = new Set<string>();
  for (const taskId of state.order) {
    const task = state.tasks[taskId];
    if (task?.state !== "accepted") continue;
    for (const check of task.acceptanceChecks) names.add(check);
  }
  return names;
}

function buildArtifact(input: {
  projection: RoadmapProjection;
  snapshot: RoadmapSnapshot;
  checks: readonly FinalCheckResult[];
  workspaceRevision: string;
  decision: string;
  blockers: readonly string[];
  now: number;
}): FinalArtifact {
  const body = {
    schemaVersion: GATE_SCHEMA_VERSION,
    decision: input.decision,
    runId: input.projection.runId,
    roadmapDigest: input.snapshot.digest,
    roadmapRevision: input.projection.roadmapRevision,
    workspaceRevision: input.workspaceRevision,
    completeCount: input.projection.completeCount,
    total: input.projection.total,
    requirements: input.projection.requirements.map((requirement) => ({
      requirementId: requirement.requirementId,
      state: requirement.state,
      coveringTasks: requirement.coveringTasks,
    })),
    checks: input.checks.map((check) => ({
      name: check.name,
      status: check.status,
      evidence: check.evidence,
      manual: check.manual === true,
    })),
    blockers: [...input.blockers],
    projectedFrom: input.projection.projectedFrom,
    createdAt: input.now,
  };
  const content = bounded(JSON.stringify(body, null, 2), MAX_FINAL_ARTIFACT);
  return {
    name: "final-summary.json",
    content,
    digest: digest(body),
    bytes: Buffer.byteLength(content, "utf8"),
  };
}

function repairProposal(
  state: RunState,
  failed: readonly FinalCheckResult[],
  reason: string,
): RepairProposal {
  const promised = acceptedCheckNames(state);
  const integrationOnly = failed.filter((check) => !promised.has(check.name));
  return {
    scope: integrationOnly.length > 0 ? "integration" : "task",
    reason,
    failedChecks: failed.map((check) => check.name),
    requiresApproval: integrationOnly.length > 0,
    suggestedRound: 1,
  };
}

/**
 * Evaluates the final gate. It requires: every requirement covered by accepted
 * tasks, a quiescent workspace whose revision matches the checks, an unchanged
 * approved roadmap, and real evidence for every required check.
 */
export function evaluateFinalGate(input: FinalGateInput): FinalGateDecision {
  if (!input.snapshot.digest || input.snapshot.requirements.length === 0) {
    return { ok: false, code: "invalid", error: "the roadmap snapshot is empty or has no digest" };
  }
  if (!input.workspace.revision || !input.verifiedWorkspaceRevision) {
    return { ok: false, code: "invalid", error: "workspace revisions are required" };
  }
  if (input.checks.length > MAX_GATE_CHECKS) {
    return { ok: false, code: "invalid", error: "too many final checks" };
  }

  const projection = projectRoadmapCompletion(input.snapshot, input.state);
  const blockers: string[] = [];
  if (!projection.complete) blockers.push(...projection.blockers);
  if (!input.workspace.quiescent) {
    blockers.push("the workspace is not quiescent; the final gate needs a fenced candidate");
  }
  if (input.workspace.revision !== input.verifiedWorkspaceRevision) {
    blockers.push("the workspace changed after the integration checks ran");
  }
  if (input.requiredChecks.length === 0) {
    blockers.push("no final integration checks were required");
  }
  if (input.approval.roadmapDigest !== input.snapshot.digest) {
    blockers.push("the roadmap digest changed after approval");
  }
  if (input.approval.roadmapRevision !== input.state.roadmapRevision) {
    blockers.push("the roadmap revision changed after approval");
  }

  const results = new Map(input.checks.map((check) => [check.name, check]));
  const baseline = new Map((input.baselineChecks ?? []).map((check) => [check.name, check.status]));
  const manual = new Map(
    input.manualAcceptance.map((entry) => [entry.name, entry.approvedBy]),
  );
  const failed: FinalCheckResult[] = [];
  for (const name of input.requiredChecks) {
    const result = results.get(name);
    if (!result) {
      blockers.push(`required final check is missing: ${name}`);
      failed.push({ name, status: "skipped", evidence: "not run", missing: true });
      continue;
    }
    if (result.manual || result.status === "skipped" && /manual/i.test(result.evidence ?? "")) {
      const approvedBy = manual.get(name);
      if (!approvedBy) {
        blockers.push(`manual final check has no human acceptance: ${name}`);
        failed.push({ ...result, status: "skipped" });
        continue;
      }
      // Explicit human acceptance satisfies a manual criterion; the automated
      // "skipped is not a pass" rule below must not override it.
      continue;
    }
    if (result.unavailableTool) {
      blockers.push(`final check tool is unavailable: ${result.unavailableTool} (${name})`);
      failed.push(result);
      continue;
    }
    if (baseline.get(name) === "failed") {
      blockers.push(`pre-existing red final gate cannot be proof: ${name}`);
      failed.push({ ...result, preExistingFailure: true });
      continue;
    }
    if (result.status === "skipped") {
      // Fail closed: a required check that did not run is not a pass, even
      // without a "manual" marker in its evidence. Only the explicit manual
      // acceptance branch above can satisfy a human criterion.
      blockers.push(`required final check did not run: ${name}`);
      failed.push(result);
      continue;
    }
    if (result.status === "failed") {
      blockers.push(`final check failed: ${name}${result.evidence ? ` (${bounded(result.evidence, 200)})` : ""}`);
      failed.push(result);
      continue;
    }
    if (result.status === "passed" && !result.evidence && result.exitCode !== 0) {
      blockers.push(`final check ${name} claims a pass without recorded evidence`);
      failed.push({ ...result, status: "failed" });
    }
  }

  const summary = bounded(
    [
      `Final gate: ${projection.completeCount}/${projection.total} requirements complete.`,
      input.checks.length > 0
        ? `Checks: ${input.checks.map((check) => `${check.name}=${check.status}`).join(", ")}`
        : "Checks: none run.",
      blockers.length > 0 ? `Blockers: ${blockers.join("; ")}` : "No blockers.",
    ].join(" "),
    MAX_FINAL_SUMMARY,
  );

  if (blockers.length === 0) {
    return {
      ok: true,
      decision: "complete",
      projection,
      summary,
      blockers: [],
      artifact: buildArtifact({
        projection,
        snapshot: input.snapshot,
        checks: input.checks,
        workspaceRevision: input.workspace.revision,
        decision: "complete",
        blockers: [],
        now: input.now,
      }),
    };
  }

  const codeFailure = (check: FinalCheckResult): boolean =>
    !check.preExistingFailure &&
    !check.unavailableTool &&
    !check.manual &&
    check.missing !== true;
  const codeFailed = failed.some(codeFailure);
  if (projection.complete && codeFailed) {
    const failedResults = failed.filter(codeFailure);
    return {
      ok: true,
      decision: "repair",
      projection,
      repair: repairProposal(
        input.state,
        failedResults,
        failedResults.map((check) => `${check.name} failed`).join(", "),
      ),
      blockers,
      summary,
    };
  }
  return {
    ok: true,
    decision: "not_complete",
    projection,
    blockers,
    summary,
    ...(codeFailed
      ? {
          repair: repairProposal(
            input.state,
            failed.filter(codeFailure),
            "the final gate did not pass",
          ),
        }
      : {}),
  };
}

/** Runs the final checks through the same gated executor as acceptance. */
export async function runFinalIntegrationGate(
  input: Omit<FinalGateInput, "checks" | "manualAcceptance"> & {
    checkRequests: readonly FinalCheckRequest[];
    manualAcceptance?: ReadonlyArray<{ name: string; approvedBy?: string }>;
    unavailableTools?: readonly string[];
    cwd: string;
    executor: CheckExecutor;
  },
): Promise<FinalGateDecision> {
  if (input.checkRequests.length > MAX_GATE_CHECKS) {
    return { ok: false, code: "invalid", error: "too many final checks" };
  }
  const unavailable = new Set(input.unavailableTools ?? []);
  const checks: FinalCheckResult[] = [];
  for (const request of input.checkRequests) {
    if (request.manualOnly) {
      checks.push({
        name: request.name,
        status: "skipped",
        evidence: "manual-only; no human acceptance recorded",
        manual: true,
      });
      continue;
    }
    if (request.tool && unavailable.has(request.tool)) {
      checks.push({
        name: request.name,
        status: "skipped",
        evidence: `tool unavailable: ${request.tool}`,
        unavailableTool: request.tool,
      });
      continue;
    }
    try {
      const observation = await input.executor.run({
        name: request.name,
        ...(request.command ? { command: request.command } : {}),
        taskId: "final-integration",
        cwd: input.cwd,
      });
      const result: FinalCheckResult = { name: request.name, status: observation.status };
      if (observation.exitCode !== undefined) result.exitCode = observation.exitCode;
      if (observation.evidence !== undefined) result.evidence = observation.evidence;
      else if (observation.exitCode === 0) result.evidence = "exit 0";
      checks.push(result);
    } catch (error) {
      checks.push({
        name: request.name,
        status: "failed",
        evidence: `executor error: ${String((error as Error)?.message ?? error).slice(0, 500)}`,
      });
    }
  }
  return evaluateFinalGate({
    snapshot: input.snapshot,
    state: input.state,
    workspace: input.workspace,
    verifiedWorkspaceRevision: input.verifiedWorkspaceRevision,
    checks,
    requiredChecks: input.requiredChecks,
    manualAcceptance:
      input.manualAcceptance ??
      input.checkRequests.filter((request) => request.manualOnly).map((request) => ({ name: request.name })),
    ...(input.baselineChecks ? { baselineChecks: input.baselineChecks } : {}),
    approval: input.approval,
    now: input.now,
  });
}

// ── Applying the gate ────────────────────────────────────────────────

export type FinalApply =
  | { ok: true; state: RunState; transitions: RunPhase[] }
  | { ok: false; code: "invalid" | "state"; error: string };

/**
 * Moves a completed gate to `completed` through legal transitions only.
 * A non-complete decision leaves the run untouched (it never marks completion).
 */
export function applyFinalGateDecision(input: {
  state: RunState;
  decision: FinalGateDecision;
  now: number;
}): FinalApply {
  if (!input.decision.ok) return { ok: false, code: "invalid", error: input.decision.error };
  if (input.decision.decision !== "complete") {
    return { ok: true, state: input.state, transitions: [] };
  }
  let state = input.state;
  const transitions: RunPhase[] = [];
  const step = (to: RunPhase): boolean => {
    if (!canTransitionRun(state.phase, to)) return false;
    const applied = applyRunEvent(state, {
      type: "run.transition",
      runId: state.runId,
      expectedRevision: state.revision,
      now: input.now,
      to,
    });
    if (!applied.ok) return false;
    state = applied.state;
    transitions.push(to);
    return true;
  };

  // Walk the legal path to final_verification. A paused/blocked/interrupted
  // run is resumed explicitly by the operator, not by the gate.
  let guard = 0;
  while (state.phase !== "final_verification") {
    guard += 1;
    if (guard > 8) return { ok: false, code: "state", error: "no legal path to final verification" };
    switch (state.phase) {
      case "ready":
        if (!step("final_verification")) {
          return { ok: false, code: "state", error: "final verification is not legal from ready" };
        }
        break;
      case "verifying":
      case "building":
      case "waiting_user":
        if (!step(state.phase === "building" ? "verifying" : "ready")) {
          return { ok: false, code: "state", error: `cannot leave ${state.phase}` };
        }
        break;
      default:
        return {
          ok: false,
          code: "state",
          error: `the run is ${state.phase}; resume/pause handling must run before completion`,
        };
    }
  }
  if (!step("completed")) {
    return { ok: false, code: "state", error: "completion is not legal from final verification" };
  }
  return { ok: true, state, transitions };
}
