/**
 * Operator command tests (plan step 20).
 *
 * The operator is a thin, truthful surface over the runtime: it reports what is
 * actually durable, refuses to claim a paused/fenced child it cannot observe,
 * and never launches anything.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { createOperatorRuntime, parseOperatorArgs } from "./orchestrator-operator.ts";
import { createOrchestratorRuntime, type ProposalContext } from "./orchestrator-runtime.ts";
import { createRunJournal, type JournalIo } from "./orchestrator-store.ts";
import { snapshotRoadmap } from "./orchestrator-plan.ts";
import { resolveBudget } from "./orchestrator-budget.ts";
import { APPROVAL_CONFIRMATION } from "./orchestrator-approval.ts";
import { previewApprovalId } from "./orchestrator-preview-view.ts";

const ROADMAP = [
  "# Plan: one thing",
  "",
  "## Plan Steps",
  "",
  "1. Add the module",
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

function context(): ProposalContext {
  return {
    orchestratorBudget: budget("orchestrator"),
    builderBudget: budget("builder"),
    launcher: { ready: true, label: "Windows Terminal" },
    checks: ["npm test"],
    limits: { repairRounds: 2, noProgressLimit: 2, rolloverLimit: 1, launchFailureLimit: 3 },
    options: { commitMode: "never", mutationScope: ["src/**"], baselineDirty: false },
  };
}

function requirementId() {
  const snapshot = snapshotRoadmap({ sourcePath: PATH, markdown: ROADMAP, now: 1 });
  if (!snapshot.ok) throw new Error(snapshot.error);
  return snapshot.snapshot.requirements[0]!.roadmapStepId;
}

function plan(runId: string) {
  return {
    schemaVersion: 1,
    runId,
    roadmapRevision: 1,
    tasks: [
      {
        taskId: "task-one",
        covers: [requirementId()],
        objective: "Add the module",
        nonGoals: [],
        dependsOn: [],
        expectedFiles: ["src/one.ts"],
        acceptanceChecks: ["npm test"],
        sizeRationale: "one module",
      },
    ],
  };
}

async function setup(options: { propose?: boolean; approve?: boolean } = {}) {
  const io = memoryIo();
  const runtime = createOrchestratorRuntime({
    createJournal: (runId) => createRunJournal({ dir: `C:/runs/${runId}`, runId, io }),
    readRoadmap: async () => ROADMAP,
    now: () => 1_000,
  });
  const ingested = await runtime.ingest({ planPath: PATH, planText: ROADMAP });
  if (!ingested.ok) throw new Error(ingested.error);
  if (options.propose !== false) {
    const proposed = await runtime.propose({
      plan: plan(ingested.value.runId),
      context: context(),
    });
    if (!proposed.ok) throw new Error(proposed.error);
  }
  if (options.approve) {
    const approved = await runtime.approve({ confirmation: APPROVAL_CONFIRMATION });
    if (!approved.ok) throw new Error(approved.error);
  }
  const operator = createOperatorRuntime({ runtime: () => runtime, now: () => 2_000 });
  return { runtime, operator };
}

test("argument parsing: bare is mode entry, unknown is help, verbs keep their rest", () => {
  assert.deepEqual(parseOperatorArgs(""), { verb: "mode-entry", rest: "" });
  assert.deepEqual(parseOperatorArgs("status"), { verb: "status", rest: "" });
  assert.deepEqual(parseOperatorArgs("say please fix the test"), {
    verb: "say",
    rest: "please fix the test",
  });
  assert.deepEqual(parseOperatorArgs("nonsense"), { verb: "help", rest: "" });
  assert.deepEqual(parseOperatorArgs("inspect task-one"), { verb: "inspect", rest: "task-one" });
});

test("status reports the durable phase, requirement count and approval state", async () => {
  const { operator } = await setup();
  const result = await operator.run("status");
  assert.equal(result.ok, true);
  assert.match(result.text, /awaiting_approval/);
  assert.match(result.text, /1 requirement/);
  assert.match(result.text, /execution approval pending/);
  assert.match(result.text, /not dispatchable/);
});

test("start refuses before a breakdown and before its approval", async () => {
  const noBreakdown = await setup({ propose: false });
  const early = await noBreakdown.operator.run("start");
  assert.equal(early.ok, false);
  assert.match(early.text, /No breakdown exists/);

  const proposed = await setup();
  const pending = await proposed.operator.run("start");
  assert.equal(pending.ok, false);
  assert.match(pending.text, /not approved/);
});

test("approve requires the exact preview id and then start reports readiness only", async () => {
  const { runtime, operator } = await setup();
  const preview = runtime.view()?.preview;
  assert.ok(preview, "the breakdown preview exists");
  const previewId = previewApprovalId(preview!);

  const wrong = await operator.run("approve yes");
  assert.equal(wrong.ok, false);
  assert.match(wrong.text, /must name this preview/);
  const literal = await operator.run(`approve ${APPROVAL_CONFIRMATION}`);
  assert.equal(literal.ok, false, "the old literal confirmation is not a preview id");

  const approved = await operator.run(`approve ${previewId}`);
  assert.equal(approved.ok, true, approved.text);
  assert.match(approved.text, /Execution approved/);

  const start = await operator.run("start");
  assert.equal(start.ok, true, start.text);
  assert.match(start.text, /never launches a child/);
});

test("preview renders scope, host, limits and the approval id; refine invalidates durably", async () => {
  const { runtime, operator } = await setup();
  const preview = await operator.run("preview");
  assert.equal(preview.ok, true, preview.text);
  assert.match(preview.text, /Execution preview preview-[0-9a-f]{16}/);
  assert.match(preview.text, /Approve with: \/orchestrator approve preview-/);
  assert.match(preview.text, /Checks:/);
  assert.match(preview.text, /Limits:/);

  await operator.run("approve " + previewApprovalId(runtime.view()!.preview!));
  assert.equal(runtime.canDispatch().ok, true);

  const missing = await operator.run("refine");
  assert.equal(missing.ok, false);

  const refined = await operator.run("refine split task one");
  assert.equal(refined.ok, true, refined.text);
  assert.equal(runtime.view()?.approval, null);
  assert.equal(runtime.view()?.preview, null);
  assert.equal(runtime.view()?.phase, "awaiting_approval");

  // The invalidation is journaled: a reload must not resurrect the approval.
  const restored = await runtime.restore();
  assert.equal(restored.ok, true, restored.ok ? "" : restored.error);
  assert.equal(runtime.view()?.approval, null);
  assert.equal(runtime.view()?.preview, null);
});

test("pause/resume/stop are real transitions and never claim a fenced child", async () => {
  const { runtime, operator } = await setup({ approve: true });
  const paused = await operator.run("pause");
  assert.equal(paused.ok, true, paused.text);
  assert.equal(runtime.view()?.phase, "paused");

  const again = await operator.run("pause");
  assert.equal(again.ok, false);

  const resumed = await operator.run("resume");
  assert.equal(resumed.ok, true, resumed.text);
  assert.equal(runtime.view()?.phase, "ready");

  // With a live mutation grant, pause/stop refuse instead of pretending.
  const view = runtime.view()!;
  await runtime.applyEvent({
    type: "task.assign",
    runId: view.runId,
    now: 1_500,
    taskId: "task-one",
    attemptId: "attempt-1",
    sessionId: "session-child-1",
    generation: 1,
  });
  const busyPause = await operator.run("pause");
  assert.equal(busyPause.ok, false);
  assert.match(busyPause.text, /wait for its fence/);
  const busyStop = await operator.run("stop");
  assert.equal(busyStop.ok, false);

  const stopped = await operator.run("stop");
  assert.equal(stopped.ok, false, "still leased");
});

test("say needs text and never sends it itself", async () => {
  const { operator } = await setup();
  const empty = await operator.run("say");
  assert.equal(empty.ok, false);
  const said = await operator.run("say please add a test");
  assert.equal(said.ok, true);
  assert.equal(said.say, "please add a test");
  assert.match(said.text, /not sent automatically/);
});

test("inspect shows the task contract without changing anything", async () => {
  const { runtime, operator } = await setup();
  const before = runtime.view()?.state.revision;
  const result = await operator.run("inspect task-one");
  assert.equal(result.ok, true, result.text);
  assert.match(result.text, /task-one/);
  assert.match(result.text, /npm test/);
  assert.equal(runtime.view()?.state.revision, before);
});

test("retry only applies to a blocked or paused run", async () => {
  const { operator } = await setup({ approve: true });
  const early = await operator.run("retry");
  assert.equal(early.ok, false);
  await operator.run("pause");
  const retried = await operator.run("retry");
  assert.equal(retried.ok, true, retried.text);
});

test("cancel leaves a terminal run and refuses further starts", async () => {
  const { runtime, operator } = await setup({ approve: true });
  const cancelled = await operator.run("cancel user asked");
  assert.equal(cancelled.ok, true, cancelled.text);
  assert.equal(runtime.view()?.phase, "cancelled");
  const start = await operator.run("start");
  assert.equal(start.ok, false);
});

test("no bound run yields a truthful refusal for every verb", async () => {
  const operator = createOperatorRuntime({ runtime: () => undefined });
  for (const verb of ["status", "start", "pause", "resume", "stop", "cancel"]) {
    const result = await operator.run(verb);
    assert.equal(result.ok, false, verb);
    assert.match(result.text, /No orchestrator run is bound/);
  }
  const help = await operator.run("");
  assert.equal(help.ok, true);
  assert.match(help.text, /Usage: \/orchestrator/);
});
