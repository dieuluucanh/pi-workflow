/**
 * Workflow Extension — future stage interface (step 43).
 *
 * A narrow seam for `artifact → approval → execution → verification`, so a
 * later Planner/Reviewer stage can plug in without making v1 recursive.
 *
 * What a stage may NOT do in v1:
 *   - auto-plan (invent work without a user-approved artifact);
 *   - rewrite a roadmap that is already executing;
 *   - approve its own scope change;
 *   - dispatch/orchestrate child sessions recursively;
 *   - accept work (acceptance remains the parent's evidence-backed decision).
 *
 * The existing Plan/Review controller keeps its lifecycle; this module does not
 * move it. It only defines the ports a future stage would implement and rejects
 * an output that exceeds the stage's authority.
 */

export const STAGE_SCHEMA_VERSION = 1 as const;
export const MAX_STAGE_TEXT = 2_000;
export const MAX_STAGE_ARTIFACTS = 64;

export type StageKind = "artifact" | "approval" | "execution" | "verification";

export interface StageAuthority {
  mutateWorkspace: boolean;
  dispatchChildren: false;
  acceptWork: false;
  rewriteExecutingRoadmap: false;
  autoPlan: false;
  /** A stage may record an explicit approval only for the approval stage. */
  approveScope: boolean;
  requiresUserApproval: boolean;
}

const NO_RECURSION = {
  dispatchChildren: false,
  acceptWork: false,
  rewriteExecutingRoadmap: false,
  autoPlan: false,
} as const;

export const STAGE_AUTHORITY: Readonly<Record<StageKind, StageAuthority>> = {
  artifact: {
    mutateWorkspace: false,
    approveScope: false,
    requiresUserApproval: false,
    ...NO_RECURSION,
  },
  approval: {
    mutateWorkspace: false,
    approveScope: true,
    requiresUserApproval: true,
    ...NO_RECURSION,
  },
  execution: {
    mutateWorkspace: true,
    approveScope: false,
    requiresUserApproval: true,
    ...NO_RECURSION,
  },
  verification: {
    mutateWorkspace: false,
    approveScope: false,
    requiresUserApproval: false,
    ...NO_RECURSION,
  },
};

/** v1 limits, asserted at every stage boundary. */
export const V1_STAGE_LIMITS = {
  autoPlan: false,
  rewriteExecutingRoadmap: false,
  approveOwnScope: false,
  recursiveOrchestration: false,
} as const;

export interface StageArtifactRef {
  name: string;
  digest: string;
  bytes: number;
}

export interface StageApproval {
  approved: boolean;
  approvedBy: "user" | "parent" | "stage";
  /** Digest of the exact artifact/plan approved. */
  digest?: string;
}

export interface StageInput {
  schemaVersion: typeof STAGE_SCHEMA_VERSION;
  runId: string;
  stage: StageKind;
  revision: number;
  roadmapRevision: number;
  planRevision: number;
  artifacts: StageArtifactRef[];
  approval?: StageApproval;
  taskIds?: string[];
  /** A bounded summary; stages never receive the whole parent transcript. */
  contextSummary?: string;
}

export type StageStatus = "ok" | "blocked" | "failed";

export interface ArtifactStageOutput {
  stage: "artifact";
  status: StageStatus;
  artifacts: StageArtifactRef[];
  reason?: string;
}

export interface ApprovalStageOutput {
  stage: "approval";
  status: StageStatus;
  approval: StageApproval;
  /** The exact digest this approval covers; mandatory. */
  approvedDigest: string;
  reason?: string;
}

export interface ExecutionStageOutput {
  stage: "execution";
  status: StageStatus;
  changedFiles: string[];
  taskIds: string[];
  reason?: string;
}

export interface VerificationStageOutput {
  stage: "verification";
  status: StageStatus;
  verdict: "accepted" | "needs_fix" | "blocked";
  evidenceId?: string;
  reason?: string;
}

export type StageOutput =
  | ArtifactStageOutput
  | ApprovalStageOutput
  | ExecutionStageOutput
  | VerificationStageOutput;

export interface StagePort {
  run(input: StageInput): Promise<StageOutput>;
}

export interface StageRunContext {
  /** Only a user or the parent may be the approving actor. */
  actor: "user" | "parent" | "stage";
  /** A stage invocation inside another stage is never allowed in v1. */
  nested?: boolean;
  now: number;
}

export type StageCode =
  | "invalid"
  | "authority"
  | "approval"
  | "nested"
  | "mismatch"
  | "unavailable";

export type StageRun =
  | {
      ok: true;
      stage: StageKind;
      output: StageOutput;
      authority: StageAuthority;
      /** The stage never changes the run phase by itself. */
      runMutation: "none";
    }
  | { ok: false; code: StageCode; error: string };

function fail(code: StageCode, error: string): StageRun {
  return { ok: false, code, error };
}

function bounded(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > max) return undefined;
  return trimmed;
}

function validArtifacts(raw: unknown): StageArtifactRef[] | undefined {
  if (!Array.isArray(raw) || raw.length > MAX_STAGE_ARTIFACTS) return undefined;
  const out: StageArtifactRef[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return undefined;
    const record = entry as Record<string, unknown>;
    const name = bounded(record.name, 200);
    const digest = bounded(record.digest, 200);
    if (!name || !digest) return undefined;
    if (typeof record.bytes !== "number" || !Number.isFinite(record.bytes) || record.bytes < 0) {
      return undefined;
    }
    out.push({ name, digest, bytes: record.bytes });
  }
  return out;
}

/** Rejects a stage output that tries to acquire authority it was never given. */
const FORBIDDEN_OUTPUT_FIELDS = [
  "accepted",
  "acceptedTasks",
  "completed",
  "completion",
  "dispatch",
  "children",
  "autoPlan",
  "rewritePlan",
  "approveOwnScope",
] as const;

function outputAuthorityError(output: unknown): string | undefined {
  if (!output || typeof output !== "object" || Array.isArray(output)) {
    return "a stage output must be an object";
  }
  for (const field of FORBIDDEN_OUTPUT_FIELDS) {
    if (field in (output as Record<string, unknown>)) {
      return `a ${String((output as Record<string, unknown>).stage ?? "stage")} output may not carry "${field}"`;
    }
  }
  return undefined;
}

function validateOutput(input: StageInput, output: unknown): StageRun {
  const authority = STAGE_AUTHORITY[input.stage];
  const forbidden = outputAuthorityError(output);
  if (forbidden) return fail("authority", forbidden);
  const record = output as Record<string, unknown>;
  if (record.stage !== input.stage) {
    return fail("mismatch", `expected a ${input.stage} output, got ${String(record.stage)}`);
  }
  if (record.status !== "ok" && record.status !== "blocked" && record.status !== "failed") {
    return fail("invalid", "stage status must be ok, blocked or failed");
  }
  const reasonError = record.reason !== undefined && !bounded(record.reason, MAX_STAGE_TEXT);
  if (reasonError) return fail("invalid", "stage reason is empty or oversized");

  switch (input.stage) {
    case "artifact": {
      const artifacts = validArtifacts(record.artifacts);
      if (!artifacts) return fail("invalid", "artifact outputs are malformed");
      return {
        ok: true,
        stage: input.stage,
        authority,
        output: { stage: "artifact", status: record.status as StageStatus, artifacts },
        runMutation: "none",
      };
    }
    case "approval": {
      const approval = record.approval as StageApproval | undefined;
      if (!approval || typeof approval.approved !== "boolean") {
        return fail("invalid", "approval output needs an explicit decision");
      }
      if (approval.approvedBy !== "user" && approval.approvedBy !== "parent" && approval.approvedBy !== "stage") {
        return fail("invalid", "invalid approver");
      }
      if (approval.approvedBy === "stage") {
        return fail("authority", "a stage cannot approve its own scope");
      }
      if (approval.approved && approval.approvedBy !== "user" && approval.approvedBy !== "parent") {
        return fail("authority", "only a user or the parent may approve");
      }
      const approvedDigest = bounded(record.approvedDigest, 200);
      if (!approvedDigest) return fail("invalid", "the approved digest is required");
      return {
        ok: true,
        stage: input.stage,
        authority,
        output: {
          stage: "approval",
          status: record.status as StageStatus,
          approval,
          approvedDigest,
        },
        runMutation: "none",
      };
    }
    case "execution": {
      if (!input.approval?.approved || input.approval.approvedBy === "stage") {
        return fail("approval", "execution requires an explicit user/parent approval");
      }
      if (!input.approval.digest) {
        return fail("approval", "execution approval must name the approved digest");
      }
      if (input.artifacts.length === 0) {
        return fail("approval", "execution needs an approved artifact, not just an approval flag");
      }
      const approvedDigest = input.approval.digest;
      if (!input.artifacts.some((artifact) => artifact.digest === approvedDigest)) {
        return fail("approval", "the execution approval does not match any supplied artifact");
      }
      const changed = record.changedFiles;
      if (!Array.isArray(changed) || changed.length > 512) {
        return fail("invalid", "changedFiles must be a bounded array");
      }
      const changedFiles: string[] = [];
      for (const path of changed) {
        const value = bounded(path, 1_000);
        if (!value) return fail("invalid", "changedFiles contains an invalid path");
        changedFiles.push(value.replace(/\\/g, "/"));
      }
      const taskIds = Array.isArray(record.taskIds)
        ? record.taskIds.filter((value): value is string => typeof value === "string").slice(0, 500)
        : [];
      return {
        ok: true,
        stage: input.stage,
        authority,
        output: {
          stage: "execution",
          status: record.status as StageStatus,
          changedFiles,
          taskIds,
        },
        runMutation: "none",
      };
    }
    case "verification": {
      if (record.status === "ok" && record.verdict === "accepted" && !record.evidenceId) {
        return fail("authority", "verification cannot accept work without parent evidence");
      }
      if (record.verdict !== "accepted" && record.verdict !== "needs_fix" && record.verdict !== "blocked") {
        return fail("invalid", "invalid verification verdict");
      }
      const evidenceId =
        record.evidenceId === undefined ? undefined : bounded(record.evidenceId, 400);
      if (record.evidenceId !== undefined && !evidenceId) {
        return fail("invalid", "evidenceId is empty or oversized");
      }
      return {
        ok: true,
        stage: input.stage,
        authority,
        output: {
          stage: "verification",
          status: record.status as StageStatus,
          verdict: record.verdict,
          ...(evidenceId ? { evidenceId } : {}),
        },
        runMutation: "none",
      };
    }
    default:
      return fail("invalid", `unknown stage ${String((record as { stage?: unknown }).stage)}`);
  }
}

function validateInput(input: StageInput): string | undefined {
  if (!input || typeof input !== "object") return "stage input must be an object";
  if (input.schemaVersion !== STAGE_SCHEMA_VERSION) return "unsupported stage schema version";
  if (!input.runId || input.runId.length > 400) return "runId is required";
  if (!(input.stage in STAGE_AUTHORITY)) return "unknown stage kind";
  for (const key of ["revision", "roadmapRevision", "planRevision"] as const) {
    if (!Number.isInteger(input[key]) || input[key] < 0) return `${key} is invalid`;
  }
  if (!validArtifacts(input.artifacts)) return "artifacts are malformed";
  if (input.contextSummary !== undefined && !bounded(input.contextSummary, 8_000)) {
    return "contextSummary is empty or oversized";
  }
  return undefined;
}

/**
 * Runs one stage through the narrow port. It never mutates the run/phase and
 * never accepts work; it validates that the output stayed in its lane.
 */
export async function runStage(
  port: StagePort,
  input: StageInput,
  context: StageRunContext,
): Promise<StageRun> {
  if (context.nested) {
    return fail("nested", "v1 does not allow a stage to invoke another stage recursively");
  }
  const invalid = validateInput(input);
  if (invalid) return fail("invalid", invalid);
  if (input.stage === "approval" && context.actor === "stage") {
    return fail("approval", "a stage cannot approve its own scope");
  }

  let output: StageOutput;
  try {
    output = await port.run(input);
  } catch (error) {
    return fail("unavailable", `the stage failed: ${String((error as Error)?.message ?? error).slice(0, 500)}`);
  }
  return validateOutput(input, output);
}

/** Describes the unchanged current controller; no lifecycle was moved here. */
export function legacyControllerCompatibility(): {
  planLifecycleMoved: false;
  reviewTurnOwnership: "unchanged";
  acceptanceAuthority: "parent";
  v1Limits: typeof V1_STAGE_LIMITS;
} {
  return {
    planLifecycleMoved: false,
    reviewTurnOwnership: "unchanged",
    acceptanceAuthority: "parent",
    v1Limits: V1_STAGE_LIMITS,
  };
}

/** A tiny pipeline that refuses nested execution and keeps stages isolated. */
export function createStagePipeline(ports: Partial<Record<StageKind, StagePort>>): {
  run(input: StageInput, context: StageRunContext): Promise<StageRun>;
} {
  return {
    async run(input, context) {
      const port = ports[input.stage];
      if (!port) return fail("unavailable", `no port is registered for the ${input.stage} stage`);
      return runStage(port, input, context);
    },
  };
}
