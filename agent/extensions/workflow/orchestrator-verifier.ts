/**
 * Workflow Extension — optional independent implementation verifier (step 42).
 *
 * This is an OPT-IN, read/verify-only second opinion on the SAME immutable task
 * and candidate. It exists to surface disagreement; it has no authority:
 *
 *   - it cannot rewrite the plan, approve a scope change, dispatch work or
 *     accept a task;
 *   - the parent remains responsible for acceptance and for running every
 *     required check. Verifier agreement cannot cover a missing parent check;
 *   - a blocking disagreement pauses acceptance until it is resolved;
 *   - when the adapter is disabled or unavailable, behavior is parent-only and
 *     no required check is skipped.
 *
 * The existing Plan/Reviewer role semantics are untouched; this is a separate
 * configuration key and role.
 */

import type { CheckStatus, ContractResult, Verdict } from "./orchestrator-types.ts";

export const VERIFIER_SCHEMA_VERSION = 1 as const;
export const DEFAULT_VERIFIER_ROLE = "implementation-verifier";
export const MAX_FINDINGS = 32;
export const MAX_FINDING_CHARS = 1_000;
export const MAX_REVIEWED_CHECKS = 64;

/** Opt-in only. A missing config means disabled. */
export interface VerifierConfig {
  enabled: boolean;
  role: string;
  model?: { provider: string; id: string };
}

export const DEFAULT_VERIFIER_CONFIG: Readonly<VerifierConfig> = {
  enabled: false,
  role: DEFAULT_VERIFIER_ROLE,
};

export function coerceVerifierConfig(raw: unknown): VerifierConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ...DEFAULT_VERIFIER_CONFIG };
  }
  const record = raw as Record<string, unknown>;
  const enabled = record.enabled === true;
  const role =
    typeof record.role === "string" && record.role.trim().length > 0 && record.role.length <= 80
      ? record.role.trim()
      : DEFAULT_VERIFIER_ROLE;
  let model: { provider: string; id: string } | undefined;
  if (record.model && typeof record.model === "object" && !Array.isArray(record.model)) {
    const candidate = record.model as Record<string, unknown>;
    if (
      typeof candidate.provider === "string" &&
      candidate.provider.length > 0 &&
      candidate.provider.length <= 100 &&
      typeof candidate.id === "string" &&
      candidate.id.length > 0 &&
      candidate.id.length <= 200
    ) {
      model = { provider: candidate.provider, id: candidate.id };
    }
  }
  return { enabled, role, ...(model ? { model } : {}) };
}

export interface VerifierTaskInput {
  objective: string;
  covers: readonly string[];
  acceptanceChecks: readonly string[];
  nonGoals: readonly string[];
}

export interface VerifierCandidateInput {
  evidenceId: string;
  verdict: Verdict;
  filesChanged: readonly string[];
  checks: ReadonlyArray<{ name: string; status: CheckStatus; evidence?: string }>;
}

export interface VerifierRequest {
  schemaVersion: typeof VERIFIER_SCHEMA_VERSION;
  requestId: string;
  runId: string;
  taskId: string;
  attemptId: string;
  candidateId: string;
  roadmapRevision: number;
  workspaceRevision: string;
  task: VerifierTaskInput;
  candidate: VerifierCandidateInput;
  permissions: {
    readOnly: true;
    mayMutate: false;
    mayRewritePlan: false;
    mayAccept: false;
    mayDispatch: false;
    mayChangeScope: false;
  };
}

export type VerifierBuild =
  | { ok: true; request: VerifierRequest }
  | { ok: false; code: "disabled" | "invalid"; reason: string; parentOnly: boolean };

export type VerifierResponseVerdict = "agree" | "disagree";

export interface VerifierResponse {
  schemaVersion: typeof VERIFIER_SCHEMA_VERSION;
  requestId: string;
  verdict: VerifierResponseVerdict;
  findings: string[];
  /** Findings that must be resolved before acceptance. */
  blockingFindings: string[];
  /** Checks the verifier actually inspected; it cannot invent coverage. */
  reviewedChecks: string[];
}

/** Authority-bearing fields a verifier response may never carry. */
const FORBIDDEN_RESPONSE_FIELDS = [
  "accepted",
  "accept",
  "approve",
  "approval",
  "rewritePlan",
  "plan",
  "dispatch",
  "mutate",
  "authority",
  "scope",
] as const;

export function verifierMayAccept(): false {
  return false;
}

export function verifierMayRewritePlan(): false {
  return false;
}

/**
 * Builds the bounded request. A disabled config returns `parentOnly` instead of
 * an empty/fake verification.
 */
export function buildVerifierRequest(
  input: {
    config: VerifierConfig;
    requestId: string;
    runId: string;
    taskId: string;
    attemptId: string;
    candidateId: string;
    roadmapRevision: number;
    workspaceRevision: string;
    task: VerifierTaskInput;
    candidate: VerifierCandidateInput;
  },
): VerifierBuild {
  if (!input.config.enabled) {
    return {
      ok: false,
      code: "disabled",
      reason: "the independent verifier is disabled; the parent verifies alone",
      parentOnly: true,
    };
  }
  for (const [label, value] of [
    ["requestId", input.requestId],
    ["runId", input.runId],
    ["taskId", input.taskId],
    ["attemptId", input.attemptId],
    ["candidateId", input.candidateId],
    ["workspaceRevision", input.workspaceRevision],
    ["evidenceId", input.candidate.evidenceId],
  ] as const) {
    if (typeof value !== "string" || value.trim().length === 0 || value.length > 400) {
      return { ok: false, code: "invalid", reason: `${label} is invalid`, parentOnly: false };
    }
  }
  if (!Number.isInteger(input.roadmapRevision) || input.roadmapRevision < 1) {
    return { ok: false, code: "invalid", reason: "roadmapRevision is invalid", parentOnly: false };
  }
  return {
    ok: true,
    request: {
      schemaVersion: VERIFIER_SCHEMA_VERSION,
      requestId: input.requestId,
      runId: input.runId,
      taskId: input.taskId,
      attemptId: input.attemptId,
      candidateId: input.candidateId,
      roadmapRevision: input.roadmapRevision,
      workspaceRevision: input.workspaceRevision,
      task: {
        objective: input.task.objective.slice(0, 2_000),
        covers: [...input.task.covers].slice(0, 256),
        acceptanceChecks: [...input.task.acceptanceChecks].slice(0, 64),
        nonGoals: [...input.task.nonGoals].slice(0, 64),
      },
      candidate: {
        evidenceId: input.candidate.evidenceId,
        verdict: input.candidate.verdict,
        filesChanged: [...input.candidate.filesChanged].slice(0, 512),
        checks: input.candidate.checks.slice(0, 64).map((check) => ({
          name: check.name.slice(0, 200),
          status: check.status,
          ...(check.evidence ? { evidence: check.evidence.slice(0, 1_000) } : {}),
        })),
      },
      permissions: {
        readOnly: true,
        mayMutate: false,
        mayRewritePlan: false,
        mayAccept: false,
        mayDispatch: false,
        mayChangeScope: false,
      },
    },
  };
}

function boundedStringArray(raw: unknown, max: number, maxChars: number): string[] | undefined {
  if (!Array.isArray(raw) || raw.length > max) return undefined;
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string") return undefined;
    const value = entry.trim();
    if (value.length === 0 || value.length > maxChars) return undefined;
    out.push(value);
  }
  return out;
}

/**
 * Validates a verifier response. A response that tries to acquire acceptance,
 * plan-rewrite or dispatch authority is rejected outright, not sanitized.
 */
export function validateVerifierResponse(
  raw: unknown,
  request: VerifierRequest,
): ContractResult<VerifierResponse> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "verifier response must be an object" };
  }
  const record = raw as Record<string, unknown>;
  if (record.schemaVersion !== VERIFIER_SCHEMA_VERSION) {
    return { ok: false, error: `unsupported verifier schema version ${String(record.schemaVersion)}` };
  }
  if (record.requestId !== request.requestId) {
    return { ok: false, error: "the response belongs to a different request" };
  }
  for (const field of FORBIDDEN_RESPONSE_FIELDS) {
    if (field in record) {
      return { ok: false, error: `a verifier response may not carry "${field}" authority` };
    }
  }
  if (record.verdict !== "agree" && record.verdict !== "disagree") {
    return { ok: false, error: "verdict must be agree or disagree" };
  }
  const findings = boundedStringArray(record.findings, MAX_FINDINGS, MAX_FINDING_CHARS);
  const blockingFindings = boundedStringArray(record.blockingFindings, MAX_FINDINGS, MAX_FINDING_CHARS);
  const reviewedChecks = boundedStringArray(record.reviewedChecks, MAX_REVIEWED_CHECKS, 200);
  if (!findings || !blockingFindings || !reviewedChecks) {
    return { ok: false, error: "findings/reviewedChecks are malformed or oversized" };
  }
  if (record.verdict === "disagree" && blockingFindings.length === 0) {
    // A disagreement with no blocking finding is advisory only; keep it honest.
    blockingFindings.push("the verifier disagreed without a blocking finding");
  }
  return {
    ok: true,
    value: {
      schemaVersion: VERIFIER_SCHEMA_VERSION,
      requestId: request.requestId,
      verdict: record.verdict,
      findings,
      blockingFindings,
      reviewedChecks,
    },
  };
}

export interface ParentEvidenceSummary {
  verdict: Verdict;
  blockers: readonly string[];
  requiredChecks: readonly string[];
  checks: ReadonlyArray<{ name: string; status: CheckStatus; evidence?: string }>;
}

export interface VerifierDecision {
  acceptanceAllowed: boolean;
  requiresResolution: boolean;
  parentOnly: boolean;
  blockers: string[];
  verifierFindings: string[];
}

/**
 * Combines the optional verifier with the parent's evidence. Verifier agreement
 * is necessary-but-not-sufficient: the parent's checks must still pass with
 * recorded evidence. Disablement never removes a required parent check.
 */
export function applyVerifierResult(input: {
  request?: VerifierRequest;
  response?: VerifierResponse;
  parent: ParentEvidenceSummary;
  unavailable?: boolean;
}): VerifierDecision {
  const blockers = [...input.parent.blockers];

  for (const required of input.parent.requiredChecks) {
    const check = input.parent.checks.find((entry) => entry.name === required);
    if (!check) {
      blockers.push(`required check is missing: ${required}`);
      continue;
    }
    if (check.status !== "passed") blockers.push(`required check is ${check.status}: ${required}`);
    if (check.status === "passed" && !check.evidence) {
      blockers.push(`required check has no recorded evidence: ${required}`);
    }
  }
  if (input.parent.verdict !== "accepted") {
    blockers.push(`the parent verdict is ${input.parent.verdict}`);
  }

  if (!input.request || !input.response || input.unavailable === true) {
    return {
      acceptanceAllowed: blockers.length === 0,
      requiresResolution: false,
      parentOnly: true,
      blockers: [...new Set(blockers)],
      verifierFindings: [],
    };
  }

  const response = input.response;
  const request = input.request;
  if (response.requestId !== request.requestId) {
    blockers.push("the verifier response is for a different request");
  }
  for (const required of input.parent.requiredChecks) {
    if (!response.reviewedChecks.includes(required)) {
      blockers.push(`the verifier did not review required check: ${required}`);
    }
  }
  if (response.verdict === "disagree" || response.blockingFindings.length > 0) {
    blockers.push(
      ...response.blockingFindings.map((finding) => `verifier disagreement: ${finding}`),
    );
  }
  const requiresResolution = response.verdict === "disagree" || response.blockingFindings.length > 0;
  return {
    acceptanceAllowed: blockers.length === 0 && !requiresResolution,
    requiresResolution,
    parentOnly: false,
    blockers: [...new Set(blockers)],
    verifierFindings: [...response.findings],
  };
}
