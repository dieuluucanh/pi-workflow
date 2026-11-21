/**
 * Workflow Extension — bounded assignment/context packets (step 19).
 *
 * One immutable packet per attempt is what a fresh Build child receives. It
 * must be enough to understand the task and the approved roadmap WITHOUT the
 * parent's history, and small enough that the first request cannot overflow.
 *
 * The packet contains:
 *   - identity + the task's objective, non-goals, acceptance checks and scope;
 *   - a bounded roadmap overview (whole-plan counts + the relevant sections),
 *     plus a paginated reference to the full, immutable snapshot;
 *   - accepted dependency summaries (evidence, not raw transcripts);
 *   - project instruction and baseline-caution REFERENCES;
 *   - the intended Build environment (typed fields only, never an env dump);
 *   - the reporting protocol;
 *   - an explicit list of anything omitted for space.
 *
 * The mandatory sections (identity, task contract, reporting, snapshot ref) are
 * never truncated. If they alone exceed the budget, creation fails with
 * `too_large` — the caller pauses instead of sending a request that overflows.
 * Everything else is added while it fits; the rest stays reachable through the
 * paged snapshot and explicit references.
 */

import { estimateTextTokens, type BudgetPlan } from "./orchestrator-budget.ts";
import type { RoadmapSnapshot } from "./orchestrator-plan.ts";
import type { PlannedTask } from "./orchestrator-types.ts";

export const PACKET_SCHEMA_VERSION = 1 as const;
export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;

export interface AcceptedDependencySummary {
  taskId: string;
  objective: string;
  /** Parent acceptance evidence reference. */
  evidenceId?: string;
  /** Bounded check names/results, not command output. */
  checks: readonly string[];
  summary?: string;
}

/** Typed, secret-free description of the intended child environment. */
export interface BuildEnvironmentSnapshot {
  cwd: string;
  model: { provider: string; id: string; thinking?: string };
  tools: readonly string[];
  profile?: string;
  /** Resource paths the child must load (extensions/skills/prompts). */
  resourcePaths?: readonly string[];
}

export interface ReportingProtocol {
  /** Tools the child may use to report (e.g. workflow_worker_report). */
  toolNames: readonly string[];
  /** Report fields the parent expects. */
  fields: readonly string[];
  instructions?: string;
}

export interface SnapshotReference {
  path: string;
  digest: string;
  pageSize: number;
  pageCount: number;
  totalRequirements: number;
  /** How to read the rest; never a raw full-text inline dump. */
  access: "paginate";
}

export interface PacketSection {
  id: string;
  title: string;
  text: string;
  /** True when the section is required and was never truncated. */
  mandatory: boolean;
}

export interface AssignmentPacket {
  schemaVersion: typeof PACKET_SCHEMA_VERSION;
  runId: string;
  taskId: string;
  attemptId: string;
  roadmapRevision: number;
  /** SHA-256 of the approved snapshot. */
  roadmapDigest: string;
  sections: readonly PacketSection[];
  /** Exactly what the child receives inline. */
  inlineText: string;
  estimatedTokens: number;
  omitted: readonly string[];
  snapshot: SnapshotReference;
  budget: {
    maxInlineTokens: number;
    bootstrapBudget: number;
    confidence: BudgetPlan["confidence"];
  };
  createdAt: number;
}

export interface AssignmentPacketInput {
  runId: string;
  taskId: string;
  attemptId: string;
  roadmapRevision: number;
  task: PlannedTask;
  snapshot: RoadmapSnapshot;
  dependencies: readonly AcceptedDependencySummary[];
  projectInstructions?: readonly string[];
  baselineCautions?: readonly string[];
  environment: BuildEnvironmentSnapshot;
  reporting: ReportingProtocol;
  budget: BudgetPlan;
  /** Defaults to the builder's bootstrap budget. */
  maxInlineTokens?: number;
  pageSize?: number;
  now: number;
}

export type PacketResult =
  | { ok: true; packet: AssignmentPacket }
  | { ok: false; code: "too_large" | "invalid"; error: string };

export interface RoadmapPage {
  page: number;
  pageSize: number;
  pageCount: number;
  total: number;
  requirements: Array<{
    roadmapStepId: string;
    label: string;
    text: string;
    phasePath: readonly string[];
    claimedComplete: boolean;
    sourceLines?: { start: number; end: number };
  }>;
}

function clip(text: string, max: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, Math.max(1, max - 1))}…` : clean;
}

function uniqueStrings(values: readonly string[], max: number): string[] {
  const out: string[] = [];
  for (const value of values) {
    const clean = value.trim();
    if (clean.length === 0 || out.includes(clean)) continue;
    out.push(clean);
    if (out.length >= max) break;
  }
  return out;
}

function deepFreeze<T>(value: T): T {
  if (Array.isArray(value)) {
    for (const entry of value) deepFreeze(entry);
    return Object.freeze(value);
  }
  if (value && typeof value === "object") {
    for (const entry of Object.values(value as Record<string, unknown>)) deepFreeze(entry);
    return Object.freeze(value);
  }
  return value;
}

function pageCount(total: number, pageSize: number): number {
  return total === 0 ? 1 : Math.ceil(total / pageSize);
}

/** One bounded page of the immutable snapshot; deterministic for a revision. */
export function roadmapPage(
  snapshot: RoadmapSnapshot,
  options: { page?: number; pageSize?: number } = {},
): { ok: true; page: RoadmapPage } | { ok: false; error: string } {
  const size = Math.floor(options.pageSize ?? DEFAULT_PAGE_SIZE);
  if (!Number.isFinite(size) || size < 1 || size > MAX_PAGE_SIZE) {
    return { ok: false, error: `pageSize must be between 1 and ${MAX_PAGE_SIZE}` };
  }
  const total = snapshot.requirements.length;
  const pages = pageCount(total, size);
  const page = Math.floor(options.page ?? 0);
  if (!Number.isFinite(page) || page < 0 || page >= pages) {
    return { ok: false, error: `page must be between 0 and ${pages - 1}` };
  }
  return {
    ok: true,
    page: {
      page,
      pageSize: size,
      pageCount: pages,
      total,
      requirements: snapshot.requirements.slice(page * size, page * size + size).map((entry) => ({
        roadmapStepId: entry.roadmapStepId,
        label: entry.label,
        text: entry.text,
        phasePath: [...entry.phasePath],
        claimedComplete: entry.claimedComplete,
        ...(entry.sourceLines === undefined ? {} : { sourceLines: entry.sourceLines }),
      })),
    },
  };
}

function renderSections(sections: readonly PacketSection[]): string {
  return sections
    .map((section) => `## ${section.title}\n${section.text}`)
    .join("\n\n");
}

function tokensFor(text: string): number {
  return estimateTextTokens(text).tokens;
}

/**
 * Builds the immutable packet. Throws nothing; an unbounded mandatory part is a
 * structured `too_large` refusal.
 */
export function createAssignmentPacket(input: AssignmentPacketInput): PacketResult {
  if (!input.runId || !input.taskId || !input.attemptId) {
    return { ok: false, code: "invalid", error: "run/task/attempt identity is required" };
  }
  if (input.snapshot.requirements.length === 0) {
    return { ok: false, code: "invalid", error: "the roadmap snapshot is empty" };
  }
  const taskRequirementIds = new Set(input.task.covers);
  const knownIds = new Set(input.snapshot.requirements.map((entry) => entry.roadmapStepId));
  for (const id of taskRequirementIds) {
    if (!knownIds.has(id)) {
      return { ok: false, code: "invalid", error: `task covers unknown requirement ${id}` };
    }
  }

  const pageSize = Math.min(
    MAX_PAGE_SIZE,
    Math.max(1, Math.floor(input.pageSize ?? DEFAULT_PAGE_SIZE)),
  );
  const pages = pageCount(input.snapshot.requirements.length, pageSize);
  const snapshotRef: SnapshotReference = {
    path: input.snapshot.sourcePath,
    digest: input.snapshot.digest,
    pageSize,
    pageCount: pages,
    totalRequirements: input.snapshot.requirements.length,
    access: "paginate",
  };
  const maxInlineTokens = Math.max(
    64,
    Math.floor(input.maxInlineTokens ?? input.budget.bootstrapBudget),
  );

  const identity: PacketSection = {
    id: "identity",
    title: "Assignment identity",
    mandatory: true,
    text: [
      `run: ${input.runId}`,
      `task: ${input.taskId}`,
      `attempt: ${input.attemptId}`,
      `roadmap revision: ${input.roadmapRevision}`,
      `roadmap digest: ${input.snapshot.digest}`,
      `roadmap source: ${input.snapshot.sourcePath}`,
      `roadmap pages: ${pages} × ${pageSize}`,
      `overall requirements: ${input.snapshot.requirements.length}`,
    ].join("\n"),
  };

  const taskContract: PacketSection = {
    id: "task",
    title: "Task contract",
    mandatory: true,
    text: [
      `objective: ${clip(input.task.objective, 600)}`,
      input.task.nonGoals.length > 0
        ? `non-goals: ${clip(input.task.nonGoals.join("; "), 400)}`
        : "non-goals: none stated",
      `acceptance checks: ${clip(input.task.acceptanceChecks.join("; "), 700)}`,
      `expected files: ${clip(input.task.expectedFiles.join(", "), 400)}`,
      `size rationale: ${clip(input.task.sizeRationale, 300)}`,
    ].join("\n"),
  };

  const reporting: PacketSection = {
    id: "reporting",
    title: "Reporting protocol",
    mandatory: true,
    text: [
      `report tools: ${uniqueStrings(input.reporting.toolNames, 8).join(", ") || "(none)"}`,
      `fields: ${uniqueStrings(input.reporting.fields, 24).join(", ") || "(none)"}`,
      input.reporting.instructions ? clip(input.reporting.instructions, 500) : "",
      "A report proposes completion; the parent verifies before accepting.",
    ]
      .filter(Boolean)
      .join("\n"),
  };

  const covered = input.snapshot.requirements.filter((entry) =>
    taskRequirementIds.has(entry.roadmapStepId),
  );
  const relevantPhases = new Set(
    covered.flatMap((entry) => entry.phasePath.slice(0, 1)),
  );
  const relevant = input.snapshot.requirements
    .filter((entry) => !taskRequirementIds.has(entry.roadmapStepId))
    .filter((entry) => entry.phasePath.some((phase) => relevantPhases.has(phase)))
    .slice(0, 12);

  const roadmapOverview: PacketSection = {
    id: "roadmap",
    title: "Roadmap overview",
    mandatory: true,
    text: [
      `${input.snapshot.title} — ${input.snapshot.requirements.length} requirements in ${input.snapshot.phases.length} phases`,
      `this task covers: ${covered
        .map((entry) => `${entry.label} ${clip(entry.text, 180)}`)
        .join(" | ")}`,
      relevant.length > 0
        ? `adjacent requirements: ${relevant
            .map((entry) => `${entry.label} ${clip(entry.text, 120)}`)
            .join(" | ")}`
        : "",
      `read the rest with the snapshot reference (page 0..${pages - 1}, ${pageSize} per page)`,
    ]
      .filter(Boolean)
      .join("\n"),
  };

  const dependencies: PacketSection = {
    id: "dependencies",
    title: "Accepted dependencies",
    mandatory: false,
    text:
      input.dependencies.length === 0
        ? "none"
        : input.dependencies
            .slice(0, 8)
            .map((entry) =>
              [
                `${entry.taskId}: ${clip(entry.objective, 160)}`,
                entry.evidenceId ? `  evidence: ${entry.evidenceId}` : "",
                entry.checks.length > 0 ? `  checks: ${clip(entry.checks.join("; "), 240)}` : "",
                entry.summary ? `  ${clip(entry.summary, 240)}` : "",
              ]
                .filter(Boolean)
                .join("\n"),
            )
            .join("\n"),
  };

  const references: PacketSection = {
    id: "references",
    title: "Project instructions and baseline",
    mandatory: false,
    text: [
      `instructions: ${uniqueStrings(input.projectInstructions ?? [], 12).join(", ") || "(none)"}`,
      `baseline cautions: ${
        uniqueStrings(input.baselineCautions ?? [], 12).join("; ") || "(none)"
      }`,
    ].join("\n"),
  };

  const environment: PacketSection = {
    id: "environment",
    title: "Build environment",
    mandatory: false,
    text: [
      `cwd: ${clip(input.environment.cwd, 300)}`,
      `model: ${input.environment.model.provider}/${input.environment.model.id}${
        input.environment.model.thinking ? ` (${input.environment.model.thinking})` : ""
      }`,
      `tools: ${uniqueStrings(input.environment.tools, 100).join(", ")}`,
      input.environment.profile ? `profile: ${clip(input.environment.profile, 80)}` : "",
      input.environment.resourcePaths && input.environment.resourcePaths.length > 0
        ? `resources: ${uniqueStrings(input.environment.resourcePaths, 20).join(", ")}`
        : "",
    ]
      .filter(Boolean)
      .join("\n"),
  };

  const mandatory = [identity, taskContract, reporting, roadmapOverview];
  const optional = [dependencies, references, environment];
  const mandatoryTokens = tokensFor(renderSections(mandatory));
  if (mandatoryTokens > maxInlineTokens) {
    return {
      ok: false,
      code: "too_large",
      error: `the mandatory assignment needs ${mandatoryTokens} tokens but only ${maxInlineTokens} fit`,
    };
  }

  const sections: PacketSection[] = [...mandatory];
  const omitted: string[] = [];
  for (const section of optional) {
    const candidate = [...sections, section];
    const text = renderSections(candidate);
    if (tokensFor(text) > maxInlineTokens) {
      omitted.push(section.id);
      continue;
    }
    sections.push(section);
  }

  const inlineText = renderSections(sections);
  const estimatedTokens = tokensFor(inlineText);
  if (estimatedTokens > maxInlineTokens) {
    return {
      ok: false,
      code: "too_large",
      error: `the assignment needs ${estimatedTokens} tokens but only ${maxInlineTokens} fit`,
    };
  }

  return {
    ok: true,
    packet: deepFreeze({
      schemaVersion: PACKET_SCHEMA_VERSION,
      runId: input.runId,
      taskId: input.taskId,
      attemptId: input.attemptId,
      roadmapRevision: input.roadmapRevision,
      roadmapDigest: input.snapshot.digest,
      sections,
      inlineText,
      estimatedTokens,
      omitted,
      snapshot: snapshotRef,
      budget: {
        maxInlineTokens,
        bootstrapBudget: input.budget.bootstrapBudget,
        confidence: input.budget.confidence,
      },
      createdAt: input.now,
    }),
  };
}
