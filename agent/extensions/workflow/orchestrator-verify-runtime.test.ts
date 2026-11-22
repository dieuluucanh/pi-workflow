/**
 * Verification runtime tests (plan step 18).
 *
 * These use the real acceptance engine and the real reducer: a passing
 * candidate is accepted once, a failing/skipped check produces a bounded
 * repair, and a workspace that moved during verification is refused.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { createVerifyRuntime } from "./orchestrator-verify-runtime.ts";
import { createOrchestratorRuntime, type ProposalContext } from "./orchestrator-runtime.ts";
import { createRunJournal, type JournalIo } from "./orchestrator-store.ts";
import { snapshotRoadmap } from "./orchestrator-plan.ts";
import { resolveBudget } from "./orchestrator-budget.ts";
import { APPROVAL_CONFIRMATION } from "./orchestrator-approval.ts";
import type { WorkspaceBaseline, BaselineChange } from "./orchestrator-workspace.ts";

const ROADMAP_ONE = [
  "# Plan: one thing",
  "",
  "## Plan Steps",
  "",
  "1. Add the first module",
  "",
].join("\n");
const ROADMAP_TWO = [
  "# Plan: two things",
  "",
  "## Plan Steps",
  "",
  "1. Add the first module",
  "2. Add the second module",
  "",
].join("\n");
const PATH = "C:/work/.pi/plans/roadmap.md";

function memoryIo(): JournalIo {
  const files = new Map<string, string>();
  const locks = new Set<string>();
  return {
    async read(path) {
      return files.has(path) ? files.get(path)! : null;
    },
    async writeAtomic(path, data) {
      files.set(path, data);
    },
    async append(path, data) {
      files.set(path, (files.get(path) ?? "") + data);
    },
    async list(dir) {
      return [...files.keys()].filter((key) => key.startsWith(dir));
    },
    async mkdir() {},
    async remove(path) {
      files.delete(path);
    },
    async acquireLock(path) {
      if (locks.has(path)) return false;
      locks.add(path);
      return true;
    },
    async releaseLock(path) {
      locks.delete(path);
    },
  };
}

function budget(role: "orchestrator" | "builder") {
  const plan = resolveBudget({
    role,
    model: { id: `${role}-model`, contextWindow: 128_000, maxOutputTokens: 8_000 },
  });
  if (!plan.ok) throw new Error(plan.error);
  return plan.plan;
}

function proposal(): ProposalContext {
  return {
    orchestratorBudget: budget("orchestrator"),
    builderBudget: budget("builder"),
    launcher: { ready: true, label: "Windows Terminal" },
    checks: ["npm test"],
    limits: { repairRounds: 2, noProgressLimit: 2, rolloverLimit: 1, launchFailureLimit: 3 },
    options: { commitMode: "never", mutationScope: ["src/**"], baselineDirty: false },
  };
}

function roadmap(twoTasks: boolean) {
  return twoTasks ? ROADMAP_TWO : ROADMAP_ONE;
}

function requirementIds(twoTasks = false) {
  const snapshot = snapshotRoadmap({ sourcePath: PATH, markdown: roadmap(twoTasks), now: 1 });
  if (!snapshot.ok) throw new Error(snapshot.error);
  return snapshot.snapshot.requirements.map((entry) => entry.roadmapStepId);
}

function plan(runId: string, twoTasks: boolean) {
  const [first, second] = requirementIds(twoTasks);
  const tasks: Array<{
    taskId: string;
    covers: string[];
    objective: string;
    nonGoals: string[];
    dependsOn: string[];
    expectedFiles: string[];
    acceptanceChecks: string[];
    sizeRationale: string;
  }> = [
    {
      taskId: "task-one",
      covers: [first],
      objective: "Add the first module",
      nonGoals: [],
      dependsOn: [],
      expectedFiles: ["src/one.ts"],
      acceptanceChecks: ["npm test"],
      sizeRationale: "one module",
    },
  ];
  if (twoTasks) {
    tasks.push({
      taskId: "task-two",
      covers: [second],
      objective: "Add the second module",
      nonGoals: [],
      dependsOn: ["task-one"],
      expectedFiles: ["src/two.ts"],
      acceptanceChecks: ["npm test"],
      sizeRationale: "one module",
    });
  }
  return { schemaVersion: 1, runId, roadmapRevision: 1, tasks };
}

function baseline(changes: BaselineChange[]): WorkspaceBaseline {
  return {
    schemaVersion: 1,
    workspaceKey: "C:/work",
    root: "C:/work",
    kind: "git",
    capturedAt: 1,
    head: "abc",
    branch: "main",
    changes,
    counts: {
      staged: changes.filter((change) => change.staged).length,
      unstaged: changes.filter((change) => !change.staged).length,
      untracked: 0,
      deleted: 0,
      binary: 0,
    },
    truncated: false,
    digest: `d-${changes.length}`,
  };
}

const CLEAN = baseline([]);
const CHANGED = baseline([{ path: "src/one.ts", status: "modified", staged: false }]);

async function running(twoTasks: boolean) {
  const io = memoryIo();
  const runtime = createOrchestratorRuntime({
    createJournal: (runId) => createRunJournal({ dir: `C:/runs/${runId}`, runId, io }),
    readRoadmap: async () => roadmap(twoTasks),
    now: () => 1_000,
  });
  const ingested = await runtime.ingest({ planPath: PATH, planText: roadmap(twoTasks) });
  if (!ingested.ok) throw new Error(ingested.error);
  const proposed = await runtime.propose({
    plan: plan(ingested.value.runId, twoTasks),
    context: proposal(),
  });
  if (!proposed.ok) throw new Error(proposed.error);
  const approved = await runtime.approve({ confirmation: APPROVAL_CONFIRMATION });
  if (!approved.ok) throw new Error(approved.error);

  const assigned = await runtime.applyEvent({
    type: "task.assign",
    runId: ingested.value.runId,
    now: 1_100,
    taskId: "task-one",
    attemptId: "attempt-1",
    sessionId: "session-child-1",
    generation: 1,
  });
  if (!assigned.ok) throw new Error(assigned.error);
  const started = await runtime.applyEvent({
    type: "task.start",
    runId: ingested.value.runId,
    now: 1_200,
    taskId: "task-one",
    attemptId: "attempt-1",
    sessionId: "session-child-1",
    generation: 1,
  });
  if (!started.ok) throw new Error(started.error);
  return { runtime, runId: ingested.value.runId };
}

async function candidate(runtime: Awaited<ReturnType<typeof running>>["runtime"]) {
  const recorded = await runtime.applyEvent({
    type: "task.candidate",
    runId: runtime.view()!.runId,
    now: 1_300,
    taskId: "task-one",
    attemptId: "attempt-1",
    candidateId: "candidate-c1",
    meaningfulChange: true,
  });
  if (!recorded.ok) throw new Error(recorded.error);
}

function executor(status: "passed" | "failed" | "skipped") {
  return {
    async run(request: { name: string }) {
      return { status, exitCode: status === "passed" ? 0 : 1, evidence: `${request.name}:${status}` };
    },
  };
}

test("a passing candidate is accepted once and proposes the next task", async () => {
  const { runtime, runId } = await running(true);
  await candidate(runtime);
  const reasons: string[] = [];
  const verify = createVerifyRuntime({
    runtime: () => runtime,
    baseline: () => CLEAN,
    candidate: async () => CHANGED,
    executor: executor("passed"),
    workspaceRevision: () => "rev-1",
    now: () => 2_000,
  });
  const outcome = await verify.verify({
    taskId: "task-one",
    attemptId: "attempt-1",
    candidateId: "candidate-c1",
    requiredCriteria: [requirementIds()[0]!],
    criteria: [{ roadmapStepId: requirementIds()[0]!, status: "met", evidence: "module exists" }],
    cwd: "C:/work",
  });
  assert.equal(outcome.ok, true, JSON.stringify(outcome));
  if (!outcome.ok || outcome.phase !== "accepted") return;
  assert.equal(outcome.duplicate, false);
  assert.ok(outcome.evidenceId.startsWith("evidence-"));
  assert.equal(outcome.nextTaskId, "task-two");
  assert.equal(runtime.view()?.state.tasks["task-one"]?.state, "accepted");
  assert.equal(verify.nextTask(), "task-two");

  // A retry is an idempotent read, not a second acceptance.
  const again = await verify.verify({
    taskId: "task-one",
    attemptId: "attempt-1",
    candidateId: "candidate-c1",
    requiredCriteria: [requirementIds()[0]!],
    criteria: [{ roadmapStepId: requirementIds()[0]!, status: "met" }],
    cwd: "C:/work",
  });
  assert.equal(again.ok, true);
  if (again.ok && again.phase === "accepted") {
    assert.equal(again.duplicate, true);
    assert.equal(again.evidenceId, outcome.evidenceId);
  }
  assert.equal(reasons.length, 0);
  assert.equal(runtime.view()?.state.tasks["task-one"]?.acceptance?.evidenceId, outcome.evidenceId);
  assert.equal(runtime.view()?.runId, runId);
});

test("a failing check becomes a scoped repair, never an acceptance", async () => {
  const { runtime } = await running(false);
  await candidate(runtime);
  const verify = createVerifyRuntime({
    runtime: () => runtime,
    baseline: () => CLEAN,
    candidate: async () => CHANGED,
    executor: executor("failed"),
    workspaceRevision: () => "rev-1",
    now: () => 2_000,
  });
  const outcome = await verify.verify({
    taskId: "task-one",
    attemptId: "attempt-1",
    candidateId: "candidate-c1",
    requiredCriteria: [requirementIds()[0]!],
    criteria: [{ roadmapStepId: requirementIds()[0]!, status: "met" }],
    cwd: "C:/work",
  });
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.phase, "needs_fix");
  const task = runtime.view()?.state.tasks["task-one"];
  assert.equal(task?.state, "needs_fix");
  assert.ok((task?.counters.repairRounds ?? 0) >= 1);
  assert.equal(task?.acceptance, undefined, "a failed check never mints acceptance");
});

test("a required check that did not run is not a pass", async () => {
  const { runtime } = await running(false);
  await candidate(runtime);
  const verify = createVerifyRuntime({
    runtime: () => runtime,
    baseline: () => CLEAN,
    candidate: async () => CHANGED,
    executor: executor("skipped"),
    workspaceRevision: () => "rev-1",
    now: () => 2_000,
  });
  const outcome = await verify.verify({
    taskId: "task-one",
    attemptId: "attempt-1",
    candidateId: "candidate-c1",
    requiredCriteria: [requirementIds()[0]!],
    criteria: [{ roadmapStepId: requirementIds()[0]!, status: "met" }],
    cwd: "C:/work",
  });
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.notEqual(outcome.phase, "accepted");
  assert.equal(runtime.view()?.state.tasks["task-one"]?.acceptance, undefined);
});

test("a workspace that changed during verification is refused", async () => {
  const { runtime } = await running(false);
  await candidate(runtime);
  let reads = 0;
  const verify = createVerifyRuntime({
    runtime: () => runtime,
    baseline: () => CLEAN,
    candidate: async () => CHANGED,
    executor: executor("passed"),
    workspaceRevision: () => {
      reads += 1;
      return reads === 1 ? "rev-1" : "rev-2";
    },
    now: () => 2_000,
  });
  const outcome = await verify.verify({
    taskId: "task-one",
    attemptId: "attempt-1",
    candidateId: "candidate-c1",
    requiredCriteria: [requirementIds()[0]!],
    criteria: [{ roadmapStepId: requirementIds()[0]!, status: "met" }],
    cwd: "C:/work",
  });
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(outcome.code, "workspace");
  assert.equal(runtime.view()?.state.tasks["task-one"]?.state, "verifying");
  assert.equal(runtime.view()?.state.tasks["task-one"]?.acceptance, undefined);
});

test("verification without a baseline is refused before any transition", async () => {
  const { runtime } = await running(false);
  await candidate(runtime);
  const verify = createVerifyRuntime({
    runtime: () => runtime,
    baseline: () => undefined,
    candidate: async () => CHANGED,
    executor: executor("passed"),
    workspaceRevision: () => "rev-1",
  });
  const outcome = await verify.verify({
    taskId: "task-one",
    attemptId: "attempt-1",
    candidateId: "candidate-c1",
    requiredCriteria: [requirementIds()[0]!],
    criteria: [{ roadmapStepId: requirementIds()[0]!, status: "met" }],
    cwd: "C:/work",
  });
  assert.equal(outcome.ok, false);
  assert.equal(runtime.view()?.state.tasks["task-one"]?.state, "candidate");
});
