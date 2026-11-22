/**
 * Parent tool adapter tests (plan step 16).
 *
 * These assert the ORDER that makes dispatch safe: prepared child → lease →
 * journaled assignment → journaled intent → one wake → journaled ack. They also
 * assert the negative cases: no approval, a held lease, an uncertain wake and a
 * launch failure each end differently, and none reports a running child.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { createParentToolRuntime, PARENT_TOOL_NAMES, type DispatchPort } from "./orchestrator-tool-runtime.ts";
import { createOrchestratorRuntime, type ProposalContext } from "./orchestrator-runtime.ts";
import { createRunJournal, type JournalIo } from "./orchestrator-store.ts";
import { snapshotRoadmap } from "./orchestrator-plan.ts";
import { resolveBudget } from "./orchestrator-budget.ts";
import { APPROVAL_CONFIRMATION } from "./orchestrator-approval.ts";

const ROADMAP = [
  "# Plan: one thing",
  "",
  "## Plan Steps",
  "",
  "1. Add the module",
  "",
].join("\n");
const PATH = "C:/work/.pi/plans/roadmap.md";

function memoryIo(): JournalIo & { order: string[]; failNextAppend?: boolean } {
  const files = new Map<string, string>();
  const locks = new Set<string>();
  const io: JournalIo & { order: string[]; failNextAppend?: boolean } = {
    order: [],
    async read(path) {
      return files.has(path) ? files.get(path)! : null;
    },
    async writeAtomic(path, data) {
      files.set(path, data);
    },
    async append(path, data) {
      if (io.failNextAppend) {
        io.failNextAppend = false;
        throw new Error("disk full");
      }
      try {
        const record = JSON.parse(data.trim());
        io.order.push(String(record.type));
      } catch {
        /* not a journal line */
      }
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
  return io;
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

function requirementId() {
  const snapshot = snapshotRoadmap({ sourcePath: PATH, markdown: ROADMAP, now: 1 });
  if (!snapshot.ok) throw new Error(snapshot.error);
  return snapshot.snapshot.requirements[0]!.roadmapStepId;
}

function planFor(runId: string) {
  return {
    schemaVersion: 1,
    runId,
    roadmapRevision: 1,
    tasks: [
      {
        taskId: "task-one",
        covers: [requirementId()],
        objective: "Add the module and its test",
        nonGoals: [],
        dependsOn: [],
        expectedFiles: ["src/one.ts"],
        acceptanceChecks: ["module exports a value"],
        sizeRationale: "one small module",
      },
    ],
  };
}

async function approvedRun(io: JournalIo) {
  const runtime = createOrchestratorRuntime({
    createJournal: (runId) => createRunJournal({ dir: `C:/runs/${runId}`, runId, io }),
    readRoadmap: async () => ROADMAP,
    now: () => 1_000,
  });
  const ingested = await runtime.ingest({ planPath: PATH, planText: ROADMAP });
  if (!ingested.ok) throw new Error(ingested.error);
  const proposed = await runtime.propose({
    plan: planFor(ingested.value.runId),
    context: proposal(),
  });
  assert.equal(proposed.ok, true);
  const approved = await runtime.approve({ confirmation: APPROVAL_CONFIRMATION });
  assert.equal(approved.ok, true);
  return runtime;
}

function harness(options: {
  io: JournalIo;
  runtime: Awaited<ReturnType<typeof approvedRun>>;
  wake?: DispatchPort["wake"];
  lease?: boolean;
}) {
  const calls: string[] = [];
  const dispatcher: DispatchPort = {
    async prepare(input) {
      calls.push(`prepare:${input.taskId}`);
      return {
        ok: true as const,
        child: { sessionRef: "session-child-1", taskStartId: "start-child-1" },
      };
    },
    async wake(input) {
      calls.push(`wake:${input.sessionRef}:${input.taskStartId}`);
      if (options.wake) return options.wake(input);
      return { ok: true as const, acknowledged: true };
    },
  };
  const leases = options.lease
    ? {
        acquire: (input: Parameters<DispatchPort["prepare"]>[0] extends never ? never : {
          workspaceKey: string;
          runId: string;
          taskId: string;
          attemptId: string;
          sessionId: string;
          generation: number;
        }) => {
          calls.push("lease");
          return {
            ok: true as const,
            grant: { ...input, acquiredAt: 1, expiresAt: 2 },
          };
        },
        release: () => {
          calls.push("release");
          return { ok: true as const };
        },
      }
    : undefined;
  const tool = createParentToolRuntime({
    runtime: () => options.runtime,
    proposalContext: proposal,
    epoch: () => 7,
    workspaceRev: () => "rev-1",
    dispatcher,
    ...(leases ? { leases } : {}),
    ...(leases ? { workspaceKey: () => "C:/work" } : {}),
    now: () => 2_000,
  });
  return { tool, calls };
}

test("a dispatch prepares, leases, journals intent, wakes once and records the ack", async () => {
  const io = memoryIo();
  const runtime = await approvedRun(io);
  const { tool, calls } = harness({ io, runtime, lease: true });

  const result = await tool.call("orchestrator_dispatch", {
    taskId: "task-one",
    attemptId: "attempt-1",
  });
  assert.equal(result.ok, true, result.text);
  if (!result.ok) return;
  assert.match(result.text, /acknowledged/);
  assert.equal(calls[0], "prepare:task-one");
  assert.equal(calls[1], "lease");
  assert.match(calls[2] ?? "", /^wake:session-child-1:start-/);
  const startId = result.details.taskStartId as string;
  assert.equal(calls[2], `wake:session-child-1:${startId}`);
  assert.ok(io.order.includes("task.start.intent"), "the intent is durable before the wake");
  assert.ok(io.order.includes("task.start.ack"), "the actual acknowledgement is durable");
  assert.ok(
    io.order.indexOf("task.dispatched") < io.order.indexOf("task.start.intent"),
    "the assignment precedes the start intent",
  );
  assert.equal(runtime.view()?.phase, "building");
  assert.equal(runtime.view()?.state.mutation?.taskId, "task-one");
});

test("dispatch without an execution approval never prepares or wakes anything", async () => {
  const io = memoryIo();
  const runtime = createOrchestratorRuntime({
    createJournal: (runId) => createRunJournal({ dir: `C:/runs/${runId}`, runId, io }),
    readRoadmap: async () => ROADMAP,
    now: () => 1_000,
  });
  const ingested = await runtime.ingest({ planPath: PATH, planText: ROADMAP });
  assert.equal(ingested.ok, true);
  if (!ingested.ok) return;
  await runtime.propose({ plan: planFor(ingested.value.runId), context: proposal() });
  const { tool, calls } = harness({ io, runtime });
  const result = await tool.call("orchestrator_dispatch", {
    taskId: "task-one",
    attemptId: "attempt-1",
  });
  assert.equal(result.ok, false);
  assert.match(result.text, /execution approval/);
  assert.deepEqual(calls, [], "no child is prepared without approval");
});

test("a lease held by another attempt blocks the wake", async () => {
  const io = memoryIo();
  const runtime = await approvedRun(io);
  const calls: string[] = [];
  const tool = createParentToolRuntime({
    runtime: () => runtime,
    proposalContext: proposal,
    epoch: () => 1,
    dispatcher: {
      async prepare() {
        calls.push("prepare");
        return { ok: true as const, child: { sessionRef: "session-x", taskStartId: "start-x" } };
      },
      async wake() {
        calls.push("wake");
        return { ok: true as const, acknowledged: true };
      },
    },
    leases: {
      acquire: () => ({ ok: false as const, code: "held" as const, error: "another attempt holds the lease" }),
      release: () => ({ ok: true as const }),
    },
    workspaceKey: () => "C:/work",
  });
  const result = await tool.call("orchestrator_dispatch", {
    taskId: "task-one",
    attemptId: "attempt-1",
  });
  assert.equal(result.ok, false);
  assert.match(result.text, /workspace is not available/);
  assert.deepEqual(calls, ["prepare"], "the lease is checked before any wake");
});

test("an uncertain wake leaves the intent and demands reconciliation", async () => {
  const io = memoryIo();
  const runtime = await approvedRun(io);
  const { tool } = harness({
    io,
    runtime,
    wake: async () => ({ ok: false, error: "connection reset after send", uncertain: true }),
  });
  const result = await tool.call("orchestrator_dispatch", {
    taskId: "task-one",
    attemptId: "attempt-1",
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "uncertain");
  assert.match(result.text, /never resend blindly/);
  assert.ok(io.order.includes("task.start.intent"));
  assert.ok(!io.order.includes("task.start.ack"));
});

test("a launch failure is recorded and does not claim a running child", async () => {
  const io = memoryIo();
  const runtime = await approvedRun(io);
  const { tool } = harness({
    io,
    runtime,
    wake: async () => ({ ok: false, error: "terminal not found" }),
  });
  const result = await tool.call("orchestrator_dispatch", {
    taskId: "task-one",
    attemptId: "attempt-1",
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "launch");
  const task = runtime.view()?.state.tasks["task-one"];
  assert.equal(task?.state, "pending", "a failed launch returns the task to the queue");
  assert.equal(runtime.view()?.state.mutation, null);
});

test("a journal failure before the wake keeps the child unstarted", async () => {
  const io = memoryIo();
  const runtime = await approvedRun(io);
  const { tool, calls } = harness({ io, runtime });
  io.failNextAppend = true;
  const result = await tool.call("orchestrator_dispatch", {
    taskId: "task-one",
    attemptId: "attempt-1",
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.code, /journal/);
  assert.deepEqual(calls, ["prepare:task-one"], "no wake happens after a journal failure");
});

test("read/propose tools answer from the bound run and keep approval separate", async () => {
  const io = memoryIo();
  const runtime = createOrchestratorRuntime({
    createJournal: (runId) => createRunJournal({ dir: `C:/runs/${runId}`, runId, io }),
    readRoadmap: async () => ROADMAP,
    now: () => 1_000,
  });
  const ingested = await runtime.ingest({ planPath: PATH, planText: ROADMAP });
  assert.equal(ingested.ok, true);
  if (!ingested.ok) return;
  const { tool } = harness({ io, runtime });

  const proposed = await tool.call("orchestrator_propose_tasks", {
    plan: planFor(ingested.value.runId),
    requirements: [
      {
        roadmapStepId: requirementId(),
        label: "1",
        text: "Add the module",
      },
    ],
  });
  assert.equal(proposed.ok, true, proposed.text);
  if (!proposed.ok) return;
  assert.equal(proposed.details.requiresApproval, true);

  const status = await tool.call("orchestrator_status", {});
  assert.equal(status.ok, true);
  if (!status.ok) return;
  assert.match(status.text, /awaiting_approval/);
});

test("registration exposes every parent tool name", () => {
  const io = memoryIo();
  const runtime = createOrchestratorRuntime({
    createJournal: (runId) => createRunJournal({ dir: `C:/runs/${runId}`, runId, io }),
  });
  const tool = createParentToolRuntime({
    runtime: () => runtime,
    proposalContext: proposal,
    epoch: () => 1,
  });
  const names: string[] = [];
  const result = tool.register({
    registerTool(definition) {
      names.push(definition.name);
    },
  });
  assert.deepEqual(names, [...PARENT_TOOL_NAMES]);
  assert.equal(result.refused, null);
  assert.equal(result.registered.length, 6);
});
