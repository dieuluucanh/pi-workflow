/**
 * Worker session binding tests (plan step 14).
 *
 * The binding is where "a report is a claim" and "a fence revokes mutation"
 * become executable. Every case below drives the real candidate fence and the
 * real managed gate — no stand-in for either.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { createWorkerRuntime } from "./orchestrator-worker-runtime.ts";
import {
  createWorkerSessionBinding,
  isMutatingWorkerTool,
  readWorkerAssignment,
  READ_ONLY_WORKER_TOOLS,
} from "./orchestrator-worker-session.ts";
import type { ManagedSessionContext } from "./managed-session.ts";
import type { WorkerAssignmentScope } from "./orchestrator-worker-todos.ts";

const CONTEXT: ManagedSessionContext = {
  version: 1,
  runId: "run-1",
  taskId: "task-1",
  attemptId: "attempt-1",
  parentSessionRef: "parent-1",
  relation: "child",
  mode: "build",
  mayOrchestrate: false,
};

const ASSIGNMENT: WorkerAssignmentScope = {
  taskId: "task-1",
  covers: ["step-1"],
  objective: "Implement the first roadmap requirement",
  acceptanceChecks: ["the module exports a value", "the test suite passes"],
  expectedFiles: ["src/module.ts"],
  roadmap: { path: ".pi/plans/roadmap.md", digest: "abc123", revision: 4 },
};

function binding(over: { planText?: string; now?: () => number } = {}) {
  const runtime = createWorkerRuntime({
    context: CONTEXT,
    sessionId: "session-1",
    now: () => 1_000,
    preflightInput: () => ({
      model: { provider: "p", id: "builder" },
      activeTools: ["read", "edit", "write", "bash"],
      requiredTools: ["read", "edit", "bash"],
      assignmentPresent: true,
    }),
  });
  return createWorkerSessionBinding({
    runtime,
    assignment: ASSIGNMENT,
    ...(over.planText === undefined ? {} : { planText: over.planText }),
    now: over.now ?? (() => 2_000),
  });
}

function authorized(over: { planText?: string } = {}) {
  const worker = binding(over);
  assert.equal(worker.runtime.acknowledge().ok, true);
  assert.equal(worker.runtime.authorize({ leaseGeneration: 3, taskStartId: "start-1" }).ok, true);
  assert.equal(worker.runtime.noteStartAck("start-1").ok, true);
  return worker;
}

function report(over: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    reportId: "report-1",
    runId: "run-1",
    taskId: "task-1",
    attemptId: "attempt-1",
    sessionId: "session-1",
    outcome: "candidate",
    criteria: [{ roadmapStepId: "step-1", status: "met", note: "implemented" }],
    changes: { files: ["src/module.ts"], summary: "added the export" },
    checks: [{ name: "unit", status: "passed" }],
    remaining: [],
    risks: [],
    artifacts: [],
    createdAt: 1_500,
    ...over,
  };
}

test("task-local TODOs come from the assignment and never import the roadmap", () => {
  const worker = binding();
  const empty = worker.todos();
  assert.equal(empty, undefined, "the list is not initialized before the child asks");

  const built = worker.initializeTodos();
  assert.equal(built.ok, true);
  const list = worker.todos();
  assert.deepEqual(list?.items.map((item) => item.text), ASSIGNMENT.acceptanceChecks);
  assert.equal(list?.owner, "worker");
  assert.deepEqual(list?.roadmap, ASSIGNMENT.roadmap);

  // Passing the parent roadmap itself is refused by digest.
  const imported = worker.initializeTodos(`# Roadmap\n\ndigest: ${ASSIGNMENT.roadmap.digest}\n`);
  assert.equal(imported.ok, false);
  assert.equal((imported as any).code, "roadmap_import");
  assert.equal(worker.todos()?.items.length, ASSIGNMENT.acceptanceChecks.length, "the list is unchanged");
});

test("local completion and [DONE] tags never touch the parent roadmap or commits", () => {
  const worker = binding();
  worker.initializeTodos();

  const done = worker.completeTodo({ ref: 1, origin: "todo" });
  assert.equal(done.ok, true);
  assert.equal(worker.todos()?.items[0]?.completed, true);

  const tagged = worker.applyDoneTags("done with [DONE:2] and [DONE:99]");
  assert.equal(tagged.ok, true);
  assert.equal((tagged as any).value.effects.parentRoadmapChanged, false);
  assert.equal((tagged as any).value.effects.commitTriggered, false);
  assert.equal((tagged as any).value.effects.parentTodosChanged, false);
  assert.equal(worker.todos()?.items[1]?.completed, true);
  assert.equal(worker.todos()?.items.length, 2, "an unknown ref adds no step");
});

test("read-only tools run pre-grant; an unknown tool is treated as a mutation", () => {
  const worker = binding();
  assert.equal(worker.admitTool("read").ok, true, "reading is allowed before readiness");
  assert.equal(worker.admitTool("orchestrator_checkpoint").ok, true);
  assert.equal(isMutatingWorkerTool("read"), false);
  assert.equal(isMutatingWorkerTool("some_future_mutating_tool"), true);
  assert.ok(READ_ONLY_WORKER_TOOLS.has("grep"));

  const blocked = worker.admitTool("some_future_mutating_tool");
  assert.equal(blocked.ok, false);
  assert.match((blocked as any).error, /not authorized yet|not ready/i);
});

test("a report inside a parallel tool batch waits for the batch to drain", () => {
  const worker = authorized();
  assert.equal(worker.admitTool("edit").ok, true);
  assert.equal(worker.admitTool("bash").ok, true);

  assert.equal(worker.report(report()).ok, true);
  assert.equal(worker.fence().phase, "report_received", "not fenced while tools are in flight");
  assert.equal(worker.canMutate("edit"), true);

  worker.noteToolEnded();
  worker.noteSettled();
  assert.equal(worker.fence().phase, "report_received", "one tool is still in flight");

  worker.noteToolEnded();
  assert.equal(worker.fence().phase, "fenced");
  assert.equal(worker.canMutate("edit"), false, "the fence revokes the live grant");
  assert.equal(worker.acceptEligibility().ok, true, "the parent may now verify");
  assert.equal(worker.runtime.gate.canMutate(), true, "the managed gate alone did not know about the fence");
});

test("a queued follow-up blocks the fence, and a silent settle never yields a candidate", () => {
  const worker = authorized();
  assert.equal(worker.admitFollowUp().ok, true);
  worker.noteSettled();
  assert.equal(worker.fence().phase, "open", "queued input keeps the child live");
  worker.noteFollowUpEnded();
  assert.equal(worker.fence().phase, "fenced");
  assert.equal(worker.fence().candidate, undefined);
  const eligibility = worker.acceptEligibility();
  assert.equal(eligibility.ok, false);
  assert.ok(eligibility.reasons.some((reason) => /no candidate/.test(reason)));
});

test("a late report after the fence is refused; a repair needs a live parent grant", () => {
  const worker = authorized();
  worker.noteSettled();
  assert.equal(worker.fence().phase, "fenced");

  const late = worker.report(report());
  assert.equal(late.ok, false);
  assert.equal((late as any).code, "fenced");

  const noGrant = binding();
  noGrant.runtime.acknowledge();
  noGrant.noteSettled();
  const resume = noGrant.resumeForRepair("repair-authorized");
  assert.equal(resume.ok, false);
  assert.equal((resume as any).code, "authorization");

  const resumed = worker.resumeForRepair("repair-authorized");
  assert.equal(resumed.ok, true);
  assert.equal(worker.fence().phase, "resumed");
  assert.equal(worker.canMutate("write"), true);
  assert.equal(worker.report(report({ reportId: "report-2" })).ok, true);
});

test("a retried identical report is deduped instead of replacing the candidate", () => {
  const worker = authorized();
  assert.equal(worker.report(report()).ok, true);
  const first = worker.fence().candidateAt;
  const again = worker.report(report());
  assert.equal(again.ok, true);
  assert.equal(worker.fence().candidateAt, first, "the candidate was not re-recorded");
  assert.equal(worker.fence().candidate?.reportId, "report-1");
});

test("a report for another attempt/session is refused", () => {
  const worker = authorized();
  const wrong = worker.report(report({ attemptId: "attempt-2" }));
  assert.equal(wrong.ok, false);
  assert.equal((wrong as any).code, "mismatch");
  assert.equal(worker.fence().candidate, undefined);
});

test("checkpoints are notes and cannot become a candidate", () => {
  const worker = authorized();
  const result = worker.callCheckpointTool({ summary: "half way" });
  assert.equal(result.ok, true);
  assert.equal(worker.fence().candidate, undefined);
  assert.equal(worker.fence().checkpoint?.summary, "half way");
  assert.equal(worker.callCheckpointTool({ summary: "   " }).ok, false);
});

test("report tools store a claim without triggering a commit", () => {
  const worker = authorized();
  const result = worker.callReportTool({ report: report() });
  assert.equal(result.ok, true);
  assert.equal(result.candidateStored, true);
  assert.match(result.text, /not acceptance/);
  assert.match(result.text, /no commit was triggered/);
});

test("scope escalation, steering and orchestrator/commit refusals", () => {
  const worker = authorized();
  const inScope = worker.scope(["src/module.ts"]);
  assert.equal(inScope.requiresEscalation, false);

  const outOfScope = worker.scope(["src/module.ts", "src/other/file.ts"]);
  assert.equal(outOfScope.requiresEscalation, true);
  assert.deepEqual(outOfScope.outOfScope, ["src/other/file.ts"]);

  const steer = worker.interaction("steer", "use a different helper");
  assert.equal(steer.revalidate, true);
  assert.equal(steer.recorded.kind, "steer");

  assert.match(worker.refuseOrchestratorEntry(), /cannot enter Orchestrator/);
  assert.equal(worker.commitSurface("git commit").allowed, false);
  assert.equal(worker.commitSurface("bash").allowed, false);
  assert.equal(worker.commitSurface("read").allowed, true);
});

test("closing the binding refuses reports, admission and repair", () => {
  const worker = authorized();
  worker.close();
  assert.equal(worker.report(report()).ok, false);
  assert.equal(worker.admitTool("edit").ok, false);
  assert.equal(worker.resumeForRepair("repair-authorized").ok, false);
  assert.equal(worker.canMutate("read"), false);
});

function branchEntry(customType: string, data: unknown) {
  return { type: "custom", customType, data };
}

test("the task-local scope is read from the child's own branch, fail-closed", () => {
  const entries = [
    branchEntry("workflow-managed-session", { ...CONTEXT }),
    branchEntry("workflow-task-scope", {
      covers: ["step-1"],
      objective: "Implement the first requirement",
      acceptanceChecks: ["the module exports a value"],
      expectedFiles: ["src/module.ts"],
    }),
    branchEntry("workflow-roadmap-reference", ASSIGNMENT.roadmap),
  ];
  const read = readWorkerAssignment(entries);
  assert.equal(read.ok, true);
  assert.equal((read as any).scope.taskId, "task-1");
  assert.deepEqual((read as any).scope.acceptanceChecks, ["the module exports a value"]);
  assert.deepEqual((read as any).scope.roadmap, ASSIGNMENT.roadmap);

  assert.equal(readWorkerAssignment([]).ok, false);
  assert.match((readWorkerAssignment([]) as any).reason, /no task-local scope/);

  const noChecks = readWorkerAssignment([
    branchEntry("workflow-managed-session", { ...CONTEXT }),
    branchEntry("workflow-task-scope", {
      covers: ["step-1"],
      objective: "x",
      acceptanceChecks: [],
      expectedFiles: ["src/module.ts"],
    }),
    branchEntry("workflow-roadmap-reference", ASSIGNMENT.roadmap),
  ]);
  assert.equal(noChecks.ok, false);
  assert.match((noChecks as any).reason, /acceptance checks/);

  const noRoadmap = readWorkerAssignment([
    branchEntry("workflow-managed-session", { ...CONTEXT }),
    branchEntry("workflow-task-scope", {
      covers: ["step-1"],
      objective: "x",
      acceptanceChecks: ["y"],
      expectedFiles: ["src/module.ts"],
    }),
  ]);
  assert.equal(noRoadmap.ok, false);
  assert.match((noRoadmap as any).reason, /roadmap reference is missing/);
});

test("a scope written by prepareWorker is exactly the assignment the child reads", () => {
  // Mirrors the entry shape prepareWorker writes (workflow-task-scope).
  const entries = [
    branchEntry("workflow-managed-session", { ...CONTEXT }),
    branchEntry("workflow-roadmap-reference", ASSIGNMENT.roadmap),
    branchEntry("workflow-task-scope", {
      covers: ASSIGNMENT.covers,
      objective: ASSIGNMENT.objective,
      acceptanceChecks: ASSIGNMENT.acceptanceChecks,
      expectedFiles: ASSIGNMENT.expectedFiles,
      mutationScope: [],
    }),
  ];
  const read = readWorkerAssignment(entries);
  assert.equal(read.ok, true);
  const worker = binding();
  const built = worker.initializeTodos();
  assert.equal(built.ok, true);
  assert.deepEqual(
    worker.todos()?.items.map((item) => item.text),
    (read as any).scope.acceptanceChecks,
  );
});
