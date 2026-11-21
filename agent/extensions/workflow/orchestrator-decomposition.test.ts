/**
 * Decomposition validation tests (step 18). Acceptance-critical: outstanding
 * coverage, DAG, oversized units, split/group without renumbering, and the
 * approval-revision gate for accepted work/criteria/dependencies.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  validateDecomposition,
  type DecompositionResult,
} from "./orchestrator-decomposition.ts";
import { resolveBudget } from "./orchestrator-budget.ts";
import type { RoadmapSnapshot } from "./orchestrator-plan.ts";
import type { PlannedTask, TaskPlan } from "./orchestrator-types.ts";

const budget = (() => {
  const result = resolveBudget({
    role: "builder",
    model: { provider: "p", id: "m", contextWindow: 131_072, maxOutputTokens: null },
  });
  assert.equal(result.ok, true);
  return (result as { ok: true; plan: ReturnType<typeof resolveBudget> extends never ? never : any }).plan;
})();

function snapshot(ids: string[]): RoadmapSnapshot {
  return {
    schemaVersion: 1,
    sourcePath: "C:/docs/roadmap.md",
    digest: "d",
    title: "Roadmap",
    requirements: ids.map((id) => ({
      roadmapStepId: id,
      label: id,
      text: id,
      phasePath: [],
      claimedComplete: false,
      completionVerified: false as const,
    })),
    phases: [],
    lineCount: 1,
    createdAt: 1,
  };
}

function task(id: string, covers: string[], dependsOn: string[] = []): PlannedTask {
  return {
    taskId: `task-${id}`,
    covers,
    objective: `Implement ${covers.join(" and ")} carefully`,
    nonGoals: [],
    dependsOn,
    expectedFiles: ["src/file.ts"],
    acceptanceChecks: ["tests pass"],
    sizeRationale: "fits one context",
  };
}

function validate(
  tasks: PlannedTask[],
  over: Partial<Parameters<typeof validateDecomposition>[0]> = {},
): DecompositionResult {
  return validateDecomposition({
    runId: "run-1",
    roadmapRevision: 1,
    snapshot: snapshot(["r1", "r2"]),
    tasks,
    builder: budget,
    ...over,
  });
}

function expectInvalid(result: DecompositionResult, code: string): void {
  assert.equal(result.ok, false);
  assert.equal((result as { code: string }).code, "invalid");
  assert.ok(
    (result as { issues: Array<{ code: string }> }).issues.some((entry) => entry.code === code),
    `expected ${code}`,
  );
}

test("a complete, coherent breakdown passes and keeps task ids", () => {
  const result = validate([task("1", ["r1"]), task("2", ["r2"], ["task-1"])]);
  assert.equal(result.ok, true);
  const plan = (result as { ok: true; plan: TaskPlan }).plan;
  assert.deepEqual(plan.tasks.map((entry) => entry.taskId), ["task-1", "task-2"]);
});

test("coverage: a missing or unknown requirement is refused", () => {
  expectInvalid(validate([task("1", ["r1"])]), "coverage");
  expectInvalid(validate([task("1", ["r1"]), task("2", ["r2"])], {
    snapshot: snapshot(["r1", "r2", "r3"]),
  }), "coverage");
  expectInvalid(validate([task("1", ["r1", "nope"]), task("2", ["r2"])]), "coverage");
});

test("dependencies: unknown ids and cycles are refused", () => {
  expectInvalid(validate([task("1", ["r1"], ["task-9"]), task("2", ["r2"])]), "dependency");
  expectInvalid(
    validate([task("1", ["r1"], ["task-2"]), task("2", ["r2"], ["task-1"])]),
    "cycle",
  );
});

test("incoherent units are refused instead of dispatched", () => {
  const emptyChecks = { ...task("1", ["r1"]), acceptanceChecks: [] };
  expectInvalid(validate([emptyChecks, task("2", ["r2"])]), "incoherent");
  const noRationale = { ...task("1", ["r1"]), sizeRationale: "" };
  expectInvalid(validate([noRationale, task("2", ["r2"])]), "incoherent");
});

test("an oversized task is blocked; splitting it passes", () => {
  const oversized = validate(
    [task("1", ["r1"]), task("2", ["r2"])],
    { estimatedTokens: { "task-1": 5_000 }, maxTaskTokens: 2_000 },
  );
  expectInvalid(oversized, "oversized");
  assert.match((oversized as { error: string }).error, /split/);

  const split = validate(
    [task("1", ["r1"]), task("2", ["r2"])],
    { estimatedTokens: { "task-1": 1_000, "task-2": 1_000 }, maxTaskTokens: 2_000 },
  );
  assert.equal(split.ok, true);
});

test("splitting one step into several tasks is legal and keeps ids durable", () => {
  const previous: TaskPlan = {
    schemaVersion: 1,
    runId: "run-1",
    roadmapRevision: 1,
    tasks: [task("1", ["r1", "r2"])],
  };
  const split = validate([task("1a", ["r1"]), task("1b", ["r2"])], { previous });
  assert.equal(split.ok, true, split.ok ? "" : split.error);
  // No renumbering: the new ids are stable as proposed, not "r1.1".
  assert.deepEqual(
    (split as { ok: true; plan: TaskPlan }).plan.tasks.map((entry) => entry.taskId),
    ["task-1a", "task-1b"],
  );
});

test("grouping adjacent small steps is legal while none is accepted", () => {
  const previous: TaskPlan = {
    schemaVersion: 1,
    runId: "run-1",
    roadmapRevision: 1,
    tasks: [task("1", ["r1"]), task("2", ["r2"])],
  };
  const grouped = validate([task("all", ["r1", "r2"])], { previous });
  assert.equal(grouped.ok, true, grouped.ok ? "" : grouped.error);
});

test("removing coverage, a dependency or accepted work requires a new approval", () => {
  const previous: TaskPlan = {
    schemaVersion: 1,
    runId: "run-1",
    roadmapRevision: 1,
    tasks: [task("1", ["r1"]), task("2", ["r2"], ["task-1"])],
  };
  const removed = validate([task("1", ["r1"])], { previous });
  assert.equal(removed.ok, false);
  assert.equal((removed as { code: string }).code, "approval_required");

  const unlinked = validate([task("1", ["r1"]), task("2", ["r2"])], { previous });
  assert.equal((unlinked as { code: string }).code, "approval_required");
  assert.ok(
    (unlinked as { issues: Array<{ code: string }> }).issues.some(
      (entry) => entry.code === "dependency_removed",
    ),
  );

  const acceptedChanged = validate(
    [
      { ...task("1", ["r1"]), objective: "A completely different accepted job" },
      task("2", ["r2"], ["task-1"]),
    ],
    { previous, acceptedTaskIds: ["task-1"] },
  );
  assert.equal((acceptedChanged as { code: string }).code, "approval_required");
  assert.ok(
    (acceptedChanged as { issues: Array<{ code: string }> }).issues.some(
      (entry) => entry.code === "accepted_changed",
    ),
  );

  const dropped = validate([task("2", ["r2"])], {
    previous,
    acceptedTaskIds: ["task-1"],
    snapshot: snapshot(["r1", "r2"]),
    acceptedCovers: { "task-1": ["r1"] },
  });
  assert.equal((dropped as { code: string }).code, "approval_required");
});

test("a different roadmap revision requires approval", () => {
  const previous: TaskPlan = {
    schemaVersion: 1,
    runId: "run-1",
    roadmapRevision: 1,
    tasks: [task("1", ["r1"]), task("2", ["r2"], ["task-1"])],
  };
  const moved = validate([task("1", ["r1"]), task("2", ["r2"], ["task-1"])], {
    previous,
    roadmapRevision: 2,
  });
  assert.equal((moved as { code: string }).code, "approval_required");
  assert.ok(
    (moved as { issues: Array<{ code: string }> }).issues.some(
      (entry) => entry.code === "roadmap_changed",
    ),
  );
});
