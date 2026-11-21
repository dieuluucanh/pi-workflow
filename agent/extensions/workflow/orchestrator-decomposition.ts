/**
 * Workflow Extension — validated, scope-preserving decomposition (step 18).
 *
 * The model proposes tasks; this module decides whether the proposal is a
 * faithful, runnable breakdown of the approved roadmap. It is pure: the caller
 * supplies the roadmap snapshot, the previous plan, accepted task ids and the
 * builder budget.
 *
 * Rules:
 *   - every OUTSTANDING roadmap requirement is covered exactly once or more;
 *     completion claims are not accepted coverage;
 *   - dependencies exist and form a DAG;
 *   - each task is a coherent unit with an objective, acceptance checks and a
 *     size rationale, and its estimate fits the builder's working set;
 *   - oversized tasks are refused (split them) rather than silently dispatched;
 *   - splitting one step into several tasks and grouping adjacent small steps
 *     are legal and never renumber durable task ids;
 *   - removing a criterion/dependency, changing accepted work, or moving to a
 *     different roadmap revision requires a NEW approval revision and fails
 *     closed here.
 */

import {
  ORCHESTRATOR_SCHEMA_VERSION,
  findDependencyCycle,
  isIdentifier,
  type PlannedTask,
  type RoadmapStepId,
  type TaskId,
  type TaskPlan,
} from "./orchestrator-types.ts";
import type { BudgetPlan } from "./orchestrator-budget.ts";
import { estimateTextTokens } from "./orchestrator-budget.ts";
import type { RoadmapSnapshot } from "./orchestrator-plan.ts";

export const DECOMPOSITION_SCHEMA_VERSION = ORCHESTRATOR_SCHEMA_VERSION;

export const DEFAULT_TASK_OVERHEAD_TOKENS = 500;

export type DecompositionIssueCode =
  | "empty"
  | "duplicate_id"
  | "coverage"
  | "dependency"
  | "cycle"
  | "oversized"
  | "incoherent"
  | "accepted_changed"
  | "criterion_removed"
  | "dependency_removed"
  | "roadmap_changed";

export interface DecompositionIssue {
  code: DecompositionIssueCode;
  message: string;
  taskId?: TaskId;
  requirementId?: RoadmapStepId;
}

export type DecompositionResult =
  | { ok: true; plan: TaskPlan; issues: [] }
  | {
      ok: false;
      /** `invalid` = fix the proposal; `approval_required` = a new revision. */
      code: "invalid" | "approval_required";
      error: string;
      issues: DecompositionIssue[];
    };

export interface DecompositionInput {
  runId: string;
  roadmapRevision: number;
  snapshot: RoadmapSnapshot;
  tasks: readonly PlannedTask[];
  /** Budget for one Build child (resolved from real model limits). */
  builder: BudgetPlan;
  /** The previously approved breakdown, when this is a revision. */
  previous?: TaskPlan | null;
  /** Accepted tasks in the live run; changing them needs a new revision. */
  acceptedTaskIds?: readonly TaskId[];
  /** Requirement coverage already accepted by the parent. */
  acceptedCovers?: Readonly<Record<TaskId, readonly RoadmapStepId[]>>;
  /** Per-task estimate override (tests/telemetry); default is a text estimate. */
  estimatedTokens?: Readonly<Record<TaskId, number>>;
  /** Tighter than the builder working set; default = builder.targetWorkingSet. */
  maxTaskTokens?: number;
}

function issue(
  code: DecompositionIssueCode,
  message: string,
  extra: { taskId?: TaskId; requirementId?: RoadmapStepId } = {},
): DecompositionIssue {
  return { code, message, ...extra };
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const a = [...left].sort();
  const b = [...right].sort();
  return a.every((value, index) => value === b[index]);
}

function estimateTaskTokens(task: PlannedTask): number {
  const text = [
    task.objective,
    task.nonGoals.join("\n"),
    task.expectedFiles.join("\n"),
    task.acceptanceChecks.join("\n"),
    task.sizeRationale,
  ].join("\n");
  return estimateTextTokens(text).tokens + DEFAULT_TASK_OVERHEAD_TOKENS;
}

/**
 * Validates one breakdown. Invalid proposals return `code: "invalid"`; proposals
 * that would silently change approved/accepted scope return
 * `code: "approval_required"` with the concrete reasons.
 */
export function validateDecomposition(input: DecompositionInput): DecompositionResult {
  const issues: DecompositionIssue[] = [];
  const tasks = input.tasks;
  if (tasks.length === 0) {
    return {
      ok: false,
      code: "invalid",
      error: "the breakdown is empty",
      issues: [issue("empty", "no tasks were proposed")],
    };
  }

  const knownRequirements = new Set(
    input.snapshot.requirements.map((requirement) => requirement.roadmapStepId),
  );
  const acceptedCovers = new Set<RoadmapStepId>(
    Object.values(input.acceptedCovers ?? {}).flat(),
  );
  const accepted = new Set(input.acceptedTaskIds ?? []);
  const byId = new Map<TaskId, PlannedTask>();
  const covered = new Set<RoadmapStepId>();
  const maxTokens = input.maxTaskTokens ?? input.builder.targetWorkingSet;

  for (const task of tasks) {
    if (!isIdentifier("task", task.taskId)) {
      issues.push(issue("incoherent", `invalid task id ${String(task.taskId)}`, { taskId: task.taskId }));
      continue;
    }
    if (byId.has(task.taskId)) {
      issues.push(issue("duplicate_id", `duplicate task id ${task.taskId}`, { taskId: task.taskId }));
      continue;
    }
    byId.set(task.taskId, task);

    if (task.covers.length === 0) {
      issues.push(issue("coverage", `task ${task.taskId} covers no requirement`, { taskId: task.taskId }));
    }
    for (const requirementId of task.covers) {
      if (!knownRequirements.has(requirementId)) {
        issues.push(
          issue("coverage", `task ${task.taskId} cites unknown requirement ${requirementId}`, {
            taskId: task.taskId,
            requirementId,
          }),
        );
      }
      covered.add(requirementId);
    }

    if (task.objective.trim().length < 10) {
      issues.push(issue("incoherent", `task ${task.taskId} needs a substantive objective`, { taskId: task.taskId }));
    }
    if (task.acceptanceChecks.length === 0) {
      issues.push(
        issue("incoherent", `task ${task.taskId} has no acceptance checks`, { taskId: task.taskId }),
      );
    }
    if (task.sizeRationale.trim().length === 0) {
      issues.push(
        issue("incoherent", `task ${task.taskId} has no size rationale`, { taskId: task.taskId }),
      );
    }

    const estimate = input.estimatedTokens?.[task.taskId] ?? estimateTaskTokens(task);
    if (!Number.isFinite(estimate) || estimate < 0) {
      issues.push(issue("incoherent", `task ${task.taskId} has no usable estimate`, { taskId: task.taskId }));
    } else if (estimate > maxTokens) {
      issues.push(
        issue(
          "oversized",
          `task ${task.taskId} needs ~${estimate} tokens; the safe unit is ${maxTokens} — split it`,
          { taskId: task.taskId },
        ),
      );
    }
  }

  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      if (!byId.has(dependency)) {
        issues.push(
          issue("dependency", `task ${task.taskId} depends on unknown task ${dependency}`, {
            taskId: task.taskId,
          }),
        );
      }
      if (dependency === task.taskId) {
        issues.push(
          issue("dependency", `task ${task.taskId} depends on itself`, { taskId: task.taskId }),
        );
      }
    }
  }
  const cycle = findDependencyCycle(tasks);
  if (cycle) {
    issues.push(issue("cycle", `dependency cycle: ${cycle.join(" → ")}`));
  }

  // Every outstanding requirement must still be covered. Accepted coverage is
  // the parent's evidence-backed acceptance, not a checkbox claim.
  for (const requirement of input.snapshot.requirements) {
    const id = requirement.roadmapStepId;
    if (acceptedCovers.has(id)) continue;
    if (!covered.has(id)) {
      issues.push(
        issue("coverage", `requirement ${id} is not covered by any task`, { requirementId: id }),
      );
    }
  }

  // Scope changes that must go back to the user for a new approval revision.
  const approvalReasons: DecompositionIssue[] = [];
  const previous = input.previous;
  if (previous) {
    if (previous.roadmapRevision !== input.roadmapRevision) {
      approvalReasons.push(
        issue("roadmap_changed", "the proposal maps a different roadmap revision"),
      );
    }
    const previousById = new Map(previous.tasks.map((task) => [task.taskId, task]));
    for (const task of tasks) {
      const before = previousById.get(task.taskId);
      if (!before) continue;
      if (!sameSet(before.dependsOn, task.dependsOn)) {
        approvalReasons.push(
          issue("dependency_removed", `task ${task.taskId} changed its dependencies`, {
            taskId: task.taskId,
          }),
        );
      }
      if (accepted.has(task.taskId)) {
        if (before.objective !== task.objective || !sameSet(before.covers, task.covers)) {
          approvalReasons.push(
            issue("accepted_changed", `accepted task ${task.taskId} was changed`, {
              taskId: task.taskId,
            }),
          );
        }
      }
    }
    for (const taskId of accepted) {
      if (!byId.has(taskId)) {
        approvalReasons.push(
          issue("accepted_changed", `accepted task ${taskId} was removed`, { taskId }),
        );
      }
    }
    const previousCovered = new Set(previous.tasks.flatMap((task) => task.covers));
    for (const requirementId of previousCovered) {
      if (!covered.has(requirementId) && !acceptedCovers.has(requirementId)) {
        approvalReasons.push(
          issue("criterion_removed", `requirement ${requirementId} lost its coverage`, {
            requirementId,
          }),
        );
      }
    }
  }

  // A scope change outranks a fixable proposal issue: the user must approve a
  // new revision before the plan can even be corrected.
  if (approvalReasons.length > 0) {
    return {
      ok: false,
      code: "approval_required",
      error: `a new approval revision is required: ${approvalReasons[0]!.message}`,
      issues: [...issues, ...approvalReasons],
    };
  }
  if (issues.length > 0) {
    return {
      ok: false,
      code: "invalid",
      error: `${issues.length} decomposition issue(s): ${issues[0]!.message}`,
      issues,
    };
  }

  return {
    ok: true,
    plan: {
      schemaVersion: DECOMPOSITION_SCHEMA_VERSION,
      runId: input.runId,
      roadmapRevision: input.roadmapRevision,
      tasks: tasks.map((task) => ({
        ...task,
        covers: [...task.covers],
        nonGoals: [...task.nonGoals],
        dependsOn: [...task.dependsOn],
        expectedFiles: [...task.expectedFiles],
        acceptanceChecks: [...task.acceptanceChecks],
      })),
    },
    issues: [],
  };
}
