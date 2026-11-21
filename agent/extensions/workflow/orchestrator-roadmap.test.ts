/**
 * Roadmap projection + final gate tests (step 36).
 *
 * Pins: completion comes only from accepted task coverage (never child TODOs),
 * split steps stay open, blocked/cancelled/deferred are preserved, and the
 * final gate refuses on missing evidence / drift / pre-existing red gates while
 * only a fully green gate may reach `completed`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  applyFinalGateDecision,
  evaluateFinalGate,
  projectRoadmapCompletion,
  runFinalIntegrationGate,
  type FinalGateInput,
} from "./orchestrator-roadmap.ts";
import { applyRunEvent, createRunState, type RunState } from "./orchestrator-state.ts";
import { ORCHESTRATOR_SCHEMA_VERSION, type PlannedTask } from "./orchestrator-types.ts";
import type { RoadmapSnapshot } from "./orchestrator-plan.ts";

const ROADMAP: RoadmapSnapshot = {
  schemaVersion: ORCHESTRATOR_SCHEMA_VERSION,
  sourcePath: ".pi/plans/roadmap.md",
  digest: "roadmap-digest-1",
  title: "Roadmap",
  requirements: [
    { roadmapStepId: "step-r1", label: "1", text: "Read", phasePath: [], claimedComplete: false, completionVerified: false },
    { roadmapStepId: "step-r2", label: "2", text: "Build", phasePath: [], claimedComplete: false, completionVerified: false },
  ],
  phases: [],
  lineCount: 10,
  createdAt: 1,
};

const TASKS: PlannedTask[] = [
  {
    taskId: "task-t1",
    covers: ["step-r1"],
    objective: "Read",
    nonGoals: [],
    dependsOn: [],
    expectedFiles: ["src/a.ts"],
    acceptanceChecks: ["integration"],
    sizeRationale: "small",
  },
  {
    taskId: "task-t2",
    covers: ["step-r2"],
    objective: "Build",
    nonGoals: [],
    dependsOn: ["task-t1"],
    expectedFiles: ["src/b.ts"],
    acceptanceChecks: ["integration"],
    sizeRationale: "split",
  },
];

function ok<T>(result: { ok: boolean }, label = "expected success"): T {
  assert.equal(result.ok, true, label);
  return result as unknown as T;
}

function baseState(taskStates: Record<string, string> = { "task-t1": "accepted", "task-t2": "accepted" }): RunState {
  let state = ok<{ state: RunState }>(
    createRunState({ runId: "run-1", roadmapRevision: 1, now: 1 }),
  ).state;
  state = ok<{ state: RunState }>(
    applyRunEvent(state, {
      type: "plan.apply",
      runId: "run-1",
      expectedRevision: state.revision,
      now: 2,
      plan: {
        schemaVersion: ORCHESTRATOR_SCHEMA_VERSION,
        runId: "run-1",
        roadmapRevision: 1,
        tasks: TASKS,
      },
      requirements: [
        { roadmapStepId: "step-r1", label: "1", text: "Read" },
        { roadmapStepId: "step-r2", label: "2", text: "Build" },
      ],
    }),
  ).state;
  const tasks = { ...state.tasks };
  for (const [taskId, status] of Object.entries(taskStates)) {
    const task = tasks[taskId];
    if (!task) continue;
    tasks[taskId] = { ...task, state: status as typeof task.state };
  }
  return { ...state, tasks, phase: "ready" };
}

function gate(over: Partial<FinalGateInput> = {}): FinalGateInput {
  return {
    snapshot: ROADMAP,
    state: baseState(),
    workspace: { revision: "ws-1", quiescent: true },
    verifiedWorkspaceRevision: "ws-1",
    checks: [{ name: "integration", status: "passed", evidence: "exit 0" }],
    requiredChecks: ["integration"],
    manualAcceptance: [],
    approval: { roadmapDigest: ROADMAP.digest, roadmapRevision: 1 },
    now: 20,
    ...over,
  };
}

test("projection uses accepted task coverage only and keeps split steps open", () => {
  const split = projectRoadmapCompletion(
    ROADMAP,
    baseState({ "task-t1": "accepted", "task-t2": "candidate" }),
  );
  assert.equal(split.complete, false);
  assert.equal(split.completeCount, 1);
  assert.equal(
    split.requirements.find((requirement) => requirement.requirementId === "step-r2")?.state,
    "in_progress",
  );

  const complete = projectRoadmapCompletion(ROADMAP, baseState());
  assert.equal(complete.complete, true);
  assert.equal(complete.projectedFrom, "accepted_tasks");

  const blocked = projectRoadmapCompletion(
    ROADMAP,
    baseState({ "task-t1": "accepted", "task-t2": "blocked" }),
  );
  assert.equal(blocked.requirements[1]!.state, "blocked");

  const cancelled = projectRoadmapCompletion(
    ROADMAP,
    baseState({ "task-t1": "accepted", "task-t2": "cancelled" }),
  );
  assert.equal(cancelled.requirements[1]!.state, "cancelled");

  const deferred = projectRoadmapCompletion(
    ROADMAP,
    baseState({ "task-t1": "accepted", "task-t2": "superseded" }),
  );
  assert.equal(deferred.requirements[1]!.state, "deferred");
  assert.match(deferred.requirements[1]!.reason ?? "", /superseded/);
});

test("a child TODO or candidate can never complete a roadmap", () => {
  const projection = projectRoadmapCompletion(
    ROADMAP,
    baseState({ "task-t1": "candidate", "task-t2": "candidate" }),
  );
  assert.equal(projection.complete, false);
  assert.equal(projection.requirements.every((requirement) => requirement.state === "in_progress"), true);
});

test("a fully green gate completes and advances through legal phases", () => {
  const decision = evaluateFinalGate(gate());
  assert.equal(decision.ok, true);
  assert.equal((decision as any).decision, "complete");
  assert.match((decision as any).summary, /2\/2 requirements complete/);
  assert.match((decision as any).artifact.content, /"decision": "complete"/);
  assert.equal((decision as any).artifact.name, "final-summary.json");

  const applied = applyFinalGateDecision({ state: baseState(), decision, now: 21 });
  assert.equal(applied.ok, true);
  assert.deepEqual((applied as any).transitions, ["final_verification", "completed"]);
  assert.equal((applied as any).state.phase, "completed");

  const verifying = { ...baseState(), phase: "verifying" as const };
  const fromVerifying = applyFinalGateDecision({ state: verifying, decision, now: 22 });
  assert.deepEqual((fromVerifying as any).transitions, ["ready", "final_verification", "completed"]);

  const paused = { ...baseState(), phase: "paused" as const };
  const refused = applyFinalGateDecision({ state: paused, decision, now: 23 });
  assert.equal(refused.ok, false);
  assert.equal((refused as any).code, "state");

  const nonComplete = evaluateFinalGate(gate({ checks: [], requiredChecks: [] }));
  assert.equal((nonComplete as any).decision, "not_complete");
  const untouched = applyFinalGateDecision({ state: baseState(), decision: nonComplete, now: 24 });
  assert.equal((untouched as any).state.phase, "ready");
  assert.deepEqual((untouched as any).transitions, []);
});

test("a failed final check keeps the run non-complete and scopes the repair", () => {
  const promised = evaluateFinalGate(
    gate({ checks: [{ name: "integration", status: "failed", evidence: "boom" }] }),
  );
  assert.equal((promised as any).decision, "repair");
  assert.equal((promised as any).repair.scope, "task");
  assert.equal((promised as any).repair.requiresApproval, false);

  const integration = evaluateFinalGate(
    gate({
      requiredChecks: ["smoke"],
      checks: [{ name: "smoke", status: "failed", evidence: "boom" }],
    }),
  );
  assert.equal((integration as any).decision, "repair");
  assert.equal((integration as any).repair.scope, "integration");
  assert.equal((integration as any).repair.requiresApproval, true);

  const missing = evaluateFinalGate(gate({ requiredChecks: ["integration", "smoke"] }));
  assert.equal((missing as any).decision, "not_complete");
  assert.match((missing as any).blockers.join(" "), /required final check is missing: smoke/);
});

test("pre-existing red, unavailable tools, manual checks and drift block completion", () => {
  const preExisting = evaluateFinalGate(
    gate({ baselineChecks: [{ name: "integration", status: "failed" }] }),
  );
  assert.equal((preExisting as any).decision, "not_complete");
  assert.match((preExisting as any).blockers.join(" "), /pre-existing red/);

  const unavailable = evaluateFinalGate(
    gate({
      checks: [{ name: "integration", status: "skipped", unavailableTool: "pi-lens" }],
    }),
  );
  assert.equal((unavailable as any).decision, "not_complete");
  assert.match((unavailable as any).blockers.join(" "), /tool is unavailable/);

  const manual = evaluateFinalGate(
    gate({
      checks: [{ name: "manual", status: "skipped", manual: true }],
      requiredChecks: ["manual"],
    }),
  );
  assert.equal((manual as any).decision, "not_complete");
  assert.match((manual as any).blockers.join(" "), /manual final check has no human acceptance/);

  const acceptedManual = evaluateFinalGate(
    gate({
      checks: [{ name: "manual", status: "skipped", manual: true }],
      requiredChecks: ["manual"],
      manualAcceptance: [{ name: "manual", approvedBy: "user" }],
    }),
  );
  assert.equal((acceptedManual as any).decision, "complete");

  const changed = evaluateFinalGate(gate({ workspace: { revision: "ws-2", quiescent: true } }));
  assert.equal((changed as any).decision, "not_complete");
  assert.match((changed as any).blockers.join(" "), /workspace changed after/);

  const drift = evaluateFinalGate(
    gate({ approval: { roadmapDigest: "other", roadmapRevision: 1 } }),
  );
  assert.equal((drift as any).decision, "not_complete");
  assert.match((drift as any).blockers.join(" "), /roadmap digest changed/);

  const notQuiescent = evaluateFinalGate(
    gate({ workspace: { revision: "ws-1", quiescent: false } }),
  );
  assert.equal((notQuiescent as any).decision, "not_complete");
});

test("integration checks run through the gated executor and feed the gate", async () => {
  const calls: string[] = [];
  const decision = await runFinalIntegrationGate({
    ...gate(),
    cwd: "/repo",
    checkRequests: [
      { name: "integration", required: true, command: "npm test" },
      { name: "package", required: true },
    ],
    requiredChecks: ["integration", "package"],
    executor: {
      async run(request) {
        calls.push(request.name);
        return request.name === "integration"
          ? { status: "passed", exitCode: 0 }
          : { status: "failed", exitCode: 1, evidence: "package gate failed" };
      },
    },
  });
  assert.deepEqual(calls, ["integration", "package"]);
  assert.equal((decision as any).decision, "repair");
  assert.deepEqual((decision as any).repair.failedChecks, ["package"]);
});

test("a malformed gate input fails without inventing a decision", () => {
  const empty = evaluateFinalGate(gate({ snapshot: { ...ROADMAP, requirements: [] } }));
  assert.equal(empty.ok, false);
  assert.equal((empty as any).code, "invalid");
});
