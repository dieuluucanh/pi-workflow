/**
 * Parent orchestration runtime tests (plan step 15).
 *
 * These drive the real composition root: real roadmap ingestion, real coverage
 * and decomposition validation, the real preview digest and the real journal
 * (in-memory io). They deliberately assert the SEPARATION the plan requires:
 * plan approval, mode entry and a proposed breakdown never authorize a child.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { createOrchestratorRuntime, type ProposalContext } from "./orchestrator-runtime.ts";
import { createRunJournal, type JournalIo } from "./orchestrator-store.ts";
import { snapshotRoadmap } from "./orchestrator-plan.ts";
import { resolveBudget } from "./orchestrator-budget.ts";
import { APPROVAL_CONFIRMATION } from "./orchestrator-approval.ts";

const ROADMAP = [
  "# Plan: Two things",
  "",
  "## Plan Steps",
  "",
  "1. Add the first module",
  "2. Add the second module",
  "",
].join("\n");

const PATH = "C:/work/.pi/plans/roadmap.md";

function memoryIo(): JournalIo & { files: Map<string, string>; appends: string[] } {
  const files = new Map<string, string>();
  const locks = new Set<string>();
  const appends: string[] = [];
  return {
    files,
    appends,
    async read(path) {
      return files.has(path) ? files.get(path)! : null;
    },
    async writeAtomic(path, data) {
      files.set(path, data);
    },
    async append(path, data) {
      appends.push(data);
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

function context(over: Partial<ProposalContext> = {}): ProposalContext {
  return {
    orchestratorBudget: budget("orchestrator"),
    builderBudget: budget("builder"),
    launcher: { ready: true, label: "Windows Terminal" },
    checks: ["npm test"],
    limits: { repairRounds: 2, noProgressLimit: 2, rolloverLimit: 1, launchFailureLimit: 3 },
    options: { commitMode: "never", mutationScope: ["src/**"], baselineDirty: false },
    ...over,
  };
}

function requirementIds() {
  const snapshot = snapshotRoadmap({ sourcePath: PATH, markdown: ROADMAP, now: 1 });
  if (!snapshot.ok) throw new Error(snapshot.error);
  return snapshot.snapshot.requirements.map((entry) => entry.roadmapStepId);
}

function planFor(runId: string, revision = 1) {
  const [first, second] = requirementIds();
  return {
    schemaVersion: 1,
    runId,
    roadmapRevision: revision,
    tasks: [
      {
        taskId: "task-first",
        covers: [first],
        objective: "Add the first module and its test",
        nonGoals: [],
        dependsOn: [],
        expectedFiles: ["src/first.ts"],
        acceptanceChecks: ["first module exports a value"],
        sizeRationale: "one small module",
      },
      {
        taskId: "task-second",
        covers: [second],
        objective: "Add the second module and its test",
        nonGoals: [],
        dependsOn: ["task-first"],
        expectedFiles: ["src/second.ts"],
        acceptanceChecks: ["second module exports a value"],
        sizeRationale: "one small module",
      },
    ],
  };
}

function setup(now = () => 1_000) {
  const io = memoryIo();
  const runtime = createOrchestratorRuntime({
    createJournal: (runId) => createRunJournal({ dir: `C:/runs/${runId}`, runId, io }),
    readRoadmap: async () => ROADMAP,
    now,
  });
  return { io, runtime };
}

async function ingested(runtime: ReturnType<typeof setup>["runtime"]) {
  const result = await runtime.ingest({ planPath: PATH, planText: ROADMAP });
  assert.equal(result.ok, true);
  return result.ok ? result.value : undefined!;
}

test("ingest snapshots the approved bytes and is idempotent for the same bytes", async () => {
  const { io, runtime } = setup();
  const first = await ingested(runtime);
  assert.equal(first.created, true);
  assert.match(first.runId, /^run-/);
  assert.equal(first.view.roadmap.requirementCount, 2);
  assert.equal(first.view.phase, "draft");

  const before = io.appends.length;
  const again = await runtime.ingest({ planPath: PATH, planText: ROADMAP });
  assert.equal(again.ok, true);
  if (again.ok) {
    assert.equal(again.value.created, false);
    assert.equal(again.value.runId, first.runId);
  }
  assert.equal(io.appends.length, before, "a repeated approval does not append a second run");
});

test("a proposal is validated, previewed and journaled — but never dispatchable", async () => {
  const { runtime } = setup();
  const created = await ingested(runtime);
  const proposed = await runtime.propose({
    plan: planFor(created.runId),
    context: context(),
  });
  assert.equal(proposed.ok, true);
  if (!proposed.ok) return;
  assert.equal(proposed.value.view.phase, "awaiting_approval");
  assert.equal(proposed.value.preview.tasks.length, 2);
  assert.equal(proposed.value.preview.blockedReasons.length, 0);
  assert.equal(runtime.canDispatch().ok, false, "a proposal is not an execution approval");
  assert.match(runtime.canDispatch().reasons.join(" "), /execution approval/);

  // The second approval is explicit and digest-bound.
  const refused = await runtime.approve({ confirmation: "yes" });
  assert.equal(refused.ok, false);
  const approved = await runtime.approve({ confirmation: APPROVAL_CONFIRMATION });
  assert.equal(approved.ok, true);
  if (!approved.ok) return;
  assert.equal(approved.value.view.phase, "ready");
  assert.equal(runtime.canDispatch().ok, true);
});

test("an uncovered roadmap requirement is refused before anything is stored", async () => {
  const { runtime } = setup();
  const created = await ingested(runtime);
  const [first] = requirementIds();
  const plan = planFor(created.runId);
  plan.tasks = [
    {
      taskId: "task-only",
      covers: [first],
      objective: "cover only one",
      nonGoals: [],
      dependsOn: [],
      expectedFiles: ["src/one.ts"],
      acceptanceChecks: ["one"],
      sizeRationale: "small",
    },
  ];
  const proposed = await runtime.propose({ plan, context: context() });
  assert.equal(proposed.ok, false);
  if (!proposed.ok) assert.equal(proposed.code, "decomposition");
  assert.equal(runtime.canDispatch().ok, false);
  assert.equal(runtime.view()?.plan, null);
});

test("a breakdown for another run or revision is refused", async () => {
  const { runtime } = setup();
  const created = await ingested(runtime);
  const otherRun = await runtime.propose({ plan: planFor("run-other-123456"), context: context() });
  assert.equal(otherRun.ok, false);

  const otherRevision = await runtime.propose({ plan: planFor(created.runId, 9), context: context() });
  assert.equal(otherRevision.ok, false);
});

test("an unavailable launcher blocks approval instead of pretending to be ready", async () => {
  const { runtime } = setup();
  const created = await ingested(runtime);
  const proposed = await runtime.propose({
    plan: planFor(created.runId),
    context: context({ launcher: { ready: false, label: "no terminal", reason: "not installed" } }),
  });
  assert.equal(proposed.ok, true, "the breakdown is shown with its blocker");
  if (!proposed.ok) return;
  assert.ok(proposed.value.preview.blockedReasons.length > 0);
  const approved = await runtime.approve({ confirmation: APPROVAL_CONFIRMATION });
  assert.equal(approved.ok, false);
  assert.equal(runtime.canDispatch().ok, false);
});

test("refine and cancel leave no approval and launch nothing", async () => {
  const { runtime } = setup();
  const created = await ingested(runtime);
  await runtime.propose({ plan: planFor(created.runId), context: context() });
  await runtime.approve({ confirmation: APPROVAL_CONFIRMATION });
  assert.equal(runtime.canDispatch().ok, true);

  const refined = await runtime.refine("grouping is wrong");
  assert.equal(refined.ok, true);
  assert.equal(runtime.canDispatch().ok, false);
  assert.equal(runtime.view()?.approval, null);

  const cancelled = await runtime.cancel("user stopped");
  assert.equal(cancelled.ok, true);
  assert.equal(runtime.view()?.phase, "cancelled");
  assert.equal(runtime.canDispatch().ok, false);
  const afterCancel = await runtime.propose({ plan: planFor(created.runId), context: context() });
  assert.equal(afterCancel.ok, false, "a cancelled run cannot be re-armed by a proposal");
});

test("preparation runs at most once per roadmap revision", async () => {
  const { runtime } = setup();
  await ingested(runtime);
  const message = runtime.preparationMessage();
  assert.ok(message && message.length > 0);
  assert.match(message!, /breakdown separately/);
  assert.ok(message!.length <= 4_000);

  await runtime.markPreparationStarted();
  assert.equal(runtime.preparationMessage(), undefined);
  assert.equal(runtime.view()?.preparationStarted, true);
});

test("a reload restores the roadmap, plan and approval from the journal", async () => {
  const { io, runtime } = setup();
  const created = await ingested(runtime);
  await runtime.propose({ plan: planFor(created.runId), context: context() });
  const approved = await runtime.approve({ confirmation: APPROVAL_CONFIRMATION });
  assert.equal(approved.ok, true);

  // A fresh runtime over the same files: no in-memory carry-over.
  const reloaded = createOrchestratorRuntime({
    createJournal: (runId) => createRunJournal({ dir: `C:/runs/${runId}`, runId, io }),
    now: () => 2_000,
  });
  const reingested = await reloaded.ingest({ planPath: PATH, planText: ROADMAP });
  assert.equal(reingested.ok, true);
  if (!reingested.ok) return;
  assert.equal(reingested.value.created, false, "the run was restored, not recreated");
  assert.equal(reingested.value.view.roadmap.digest, created.view.roadmap.digest);
  assert.ok(reingested.value.view.plan, "the breakdown survived the reload");
  assert.ok(reingested.value.view.approval, "the execution approval survived the reload");
  assert.equal(reloaded.canDispatch().ok, true);
});
