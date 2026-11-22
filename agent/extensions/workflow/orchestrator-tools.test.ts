/**
 * Parent orchestration tool + event pump tests (step 31).
 *
 * Pins the step contract: every tool validates against the durable state and
 * returns a bounded receipt/event; dispatch never waits for the child; the
 * pump only wakes the parent at a real idle boundary, deduplicates bursts and
 * refuses `agent_end`, stale epochs and out-of-order messages.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ORCHESTRATOR_TOOLS,
  createEventPump,
  handleOrchestratorTool,
  parseTaskPlan,
  registerOrchestratorTools,
  type PumpEvent,
  type ToolContext,
} from "./orchestrator-tools.ts";
import {
  applyRunEvent,
  createRunState,
  mutationTask,
  type RunState,
} from "./orchestrator-state.ts";
import {
  ORCHESTRATOR_SCHEMA_VERSION,
  type AcceptanceEvidence,
  type PlannedTask,
  type RoadmapRequirement,
} from "./orchestrator-types.ts";
import { taskStartIdFor, workerIdFor } from "./orchestrator-worker.ts";

const REQS: RoadmapRequirement[] = [
  { roadmapStepId: "step-r1", label: "1", text: "Read the API" },
  { roadmapStepId: "step-r2", label: "2", text: "Implement the client" },
];

const TASKS: PlannedTask[] = [
  {
    taskId: "task-t1",
    covers: ["step-r1"],
    objective: "Read the API",
    nonGoals: [],
    dependsOn: [],
    expectedFiles: ["src/api.ts"],
    acceptanceChecks: ["notes exist"],
    sizeRationale: "small",
  },
  {
    taskId: "task-t2",
    covers: ["step-r2"],
    objective: "Implement the client",
    nonGoals: [],
    dependsOn: ["task-t1"],
    expectedFiles: ["src/client.ts"],
    acceptanceChecks: ["tests pass"],
    sizeRationale: "small",
  },
];

function ok<T>(result: { ok: boolean }, label = "expected success"): T {
  assert.equal(result.ok, true, label);
  return result as unknown as T;
}

function stateWithPlan(): RunState {
  const state = ok<{ state: RunState }>(
    createRunState({ runId: "run-1", roadmapRevision: 1, now: 1 }),
  ).state;
  return ok<{ state: RunState }>(
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
      requirements: REQS,
    }),
  ).state;
}

function context(state: RunState, over: Partial<ToolContext> = {}): ToolContext {
  return {
    state,
    now: 10,
    epoch: 3,
    currentEpoch: 3,
    activeTurn: false,
    approval: { approved: true, approvalDigest: "digest", planDigest: "digest" },
    workspaceRevision: "workspace-rev-1",
    ...over,
  };
}

function runningCandidate(): RunState {
  let state = stateWithPlan();
  state = ok<{ state: RunState }>(
    applyRunEvent(state, {
      type: "task.assign",
      runId: "run-1",
      expectedRevision: state.revision,
      now: 3,
      taskId: "task-t1",
      attemptId: "attempt-a1",
      sessionId: "session-s1",
      generation: 1,
    }),
  ).state;
  state = ok<{ state: RunState }>(
    applyRunEvent(state, {
      type: "task.start",
      runId: "run-1",
      expectedRevision: state.revision,
      now: 4,
      taskId: "task-t1",
      attemptId: "attempt-a1",
      sessionId: "session-s1",
      generation: 1,
    }),
  ).state;
  state = ok<{ state: RunState }>(
    applyRunEvent(state, {
      type: "task.candidate",
      runId: "run-1",
      expectedRevision: state.revision,
      now: 5,
      taskId: "task-t1",
      attemptId: "attempt-a1",
      candidateId: "candidate-c1",
      meaningfulChange: true,
    }),
  ).state;
  return state;
}

function evidence(over: Partial<AcceptanceEvidence> = {}): AcceptanceEvidence {
  return {
    schemaVersion: ORCHESTRATOR_SCHEMA_VERSION,
    evidenceId: "evidence-e1",
    runId: "run-1",
    taskId: "task-t1",
    attemptId: "attempt-a1",
    candidateId: "candidate-c1",
    roadmapRevision: 1,
    workspaceRevision: "workspace-rev-1",
    inspected: { filesChanged: 1, files: ["src/api.ts"] },
    checks: [{ name: "tests", status: "passed", evidence: "exit 0" }],
    verdict: "accepted",
    createdAt: 8,
    ...over,
  };
}

function pumpEvent(over: Partial<PumpEvent> = {}): PumpEvent {
  return {
    messageId: "message-1",
    seq: 1,
    kind: "ready",
    runId: "run-1",
    taskId: "task-t1",
    attemptId: "attempt-a1",
    sessionId: "session-s1",
    generation: 1,
    leaseGeneration: 1,
    epoch: 3,
    at: 9,
    ...over,
  };
}

test("proposal validates coverage and never dispatches", () => {
  const state = ok<{ state: RunState }>(
    createRunState({ runId: "run-1", roadmapRevision: 1, now: 1 }),
  ).state;
  const proposed = ok<{ receipt: any; event: any }>(
    handleOrchestratorTool(
      "orchestrator_propose_tasks",
      {
        plan: {
          schemaVersion: ORCHESTRATOR_SCHEMA_VERSION,
          runId: "run-1",
          roadmapRevision: 1,
          tasks: TASKS,
        },
        requirements: REQS,
      },
      context(state),
    ),
  );
  assert.equal(proposed.receipt.requiresApproval, true);
  assert.match(proposed.receipt.summary, /execution approval is still required/);
  assert.equal(proposed.event.type, "plan.apply");

  const uncovered = handleOrchestratorTool(
    "orchestrator_propose_tasks",
    {
      plan: {
        schemaVersion: ORCHESTRATOR_SCHEMA_VERSION,
        runId: "run-1",
        roadmapRevision: 1,
        tasks: [{ ...TASKS[0], covers: [] }],
      },
      requirements: REQS,
    },
    context(state),
  );
  assert.equal(uncovered.ok, false);
});

test("parseTaskPlan rejects foreign runs, versions and oversized lists", () => {
  assert.equal(
    parseTaskPlan(
      {
        schemaVersion: 99,
        runId: "run-1",
        roadmapRevision: 1,
        tasks: TASKS,
      },
      { runId: "run-1", roadmapRevision: 1 },
    ).ok,
    false,
  );
  assert.equal(
    parseTaskPlan(
      {
        schemaVersion: ORCHESTRATOR_SCHEMA_VERSION,
        runId: "run-2",
        roadmapRevision: 1,
        tasks: TASKS,
      },
      { runId: "run-1", roadmapRevision: 1 },
    ).ok,
    false,
  );
  assert.equal(
    parseTaskPlan(
      {
        schemaVersion: ORCHESTRATOR_SCHEMA_VERSION,
        runId: "run-1",
        roadmapRevision: 1,
        tasks: [],
      },
      { runId: "run-1", roadmapRevision: 1 },
    ).ok,
    false,
  );
});

test("dispatch needs explicit approval, a ready task and no other writer", () => {
  const state = stateWithPlan();
  const unapproved = handleOrchestratorTool(
    "orchestrator_dispatch",
    { taskId: "task-t1", attemptId: "attempt-a1" },
    context(state, { approval: null }),
  );
  assert.equal(unapproved.ok, false);
  assert.equal((unapproved as any).code, "approval");

  const dependent = handleOrchestratorTool(
    "orchestrator_dispatch",
    { taskId: "task-t2", attemptId: "attempt-a2" },
    context(state),
  );
  assert.equal((dependent as any).code, "state");

  const dispatched = ok<{ receipt: any; event: any }>(
    handleOrchestratorTool(
      "orchestrator_dispatch",
      { taskId: "task-t1", attemptId: "attempt-a1", sessionRef: "tab-1" },
      context(state),
    ),
  );
  assert.equal(dispatched.receipt.kind, "dispatch");
  assert.match(dispatched.receipt.taskStartId, /^start-/);
  assert.equal(dispatched.receipt.sessionRef, "tab-1");
  const next = ok<{ state: RunState }>(applyRunEvent(state, dispatched.event)).state;
  assert.equal(mutationTask(next), "task-t1");

  const overlap = handleOrchestratorTool(
    "orchestrator_dispatch",
    { taskId: "task-t2", attemptId: "attempt-a2" },
    context(next, { approval: { approved: true, approvalDigest: "d", planDigest: "d" } }),
  );
  assert.equal((overlap as any).code, "state");
});

test("status reports bounded counts and the next runnable task", () => {
  let state = stateWithPlan();
  const initial = ok<{ receipt: any }>(
    handleOrchestratorTool("orchestrator_status", {}, context(state)),
  ).receipt;
  assert.deepEqual(initial.counts, { total: 2, accepted: 0, pending: 2, blocked: 0, cancelled: 0 });
  assert.equal(initial.nextTaskId, "task-t1");

  state = runningCandidate();
  const candidate = ok<{ receipt: any }>(
    handleOrchestratorTool("orchestrator_status", {}, context(state)),
  ).receipt;
  assert.equal(candidate.counts.pending, 2);
  assert.equal(candidate.nextTaskId, undefined);
});

test("verify requires a quiescent candidate; acceptance evidence is runtime-owned", () => {
  let state = runningCandidate();
  const verified = ok<{ event: any }>(
    handleOrchestratorTool("orchestrator_verify", { taskId: "task-t1" }, context(state)),
  );
  state = ok<{ state: RunState }>(applyRunEvent(state, verified.event)).state;
  assert.equal(state.tasks["task-t1"]!.state, "verifying");

  // A model-supplied evidence object is no longer an acceptance input at all.
  const forged = handleOrchestratorTool(
    "orchestrator_accept",
    { evidence: evidence() },
    context(state),
  );
  assert.equal((forged as any).ok, false);
  assert.equal((forged as any).code, "invalid");

  const pending = handleOrchestratorTool(
    "orchestrator_accept",
    { taskId: "task-t1" },
    context(state),
  );
  assert.equal((pending as any).ok, false);
  assert.equal((pending as any).code, "unavailable");
  assert.match((pending as any).error, /orchestrator_verify/);
});

test("repair is bounded and refuses a stale epoch", () => {
  let state = runningCandidate();
  state = ok<{ state: RunState }>(
    applyRunEvent(state, {
      type: "task.verify",
      runId: "run-1",
      expectedRevision: state.revision,
      now: 6,
      taskId: "task-t1",
    }),
  ).state;
  const repair = ok<{ event: any; receipt: any }>(
    handleOrchestratorTool(
      "orchestrator_repair",
      { taskId: "task-t1", reason: "tests failed", meaningfulChange: false },
      context(state),
    ),
  );
  assert.match(repair.receipt.summary, /Scoped repair round 1\/2/);
  const next = ok<{ state: RunState }>(applyRunEvent(state, repair.event)).state;
  assert.equal(next.tasks["task-t1"]!.state, "needs_fix");
  assert.equal(next.tasks["task-t1"]!.counters.repairRounds, 1);

  const stale = handleOrchestratorTool(
    "orchestrator_status",
    {},
    context(state, { epoch: 2, currentEpoch: 3 }),
  );
  assert.equal((stale as any).code, "stale_epoch");
});

test("tool registration exposes every bounded spec and uses the current epoch", async () => {
  let current = context(stateWithPlan());
  const registered: string[] = [];
  const result = registerOrchestratorTools(
    {
      registerTool(spec, handler) {
        registered.push(spec.name);
        assert.equal(spec.bounded, true);
        assert.ok(handler);
      },
    },
    () => current,
  );
  assert.equal(result.unavailable, null);
  assert.deepEqual(registered, ORCHESTRATOR_TOOLS.map((tool) => tool.name));

  current = context(stateWithPlan(), { epoch: 2, currentEpoch: 4 });
  const stale = await handleOrchestratorTool("orchestrator_status", {}, current);
  assert.equal((stale as any).code, "stale_epoch");
});

test("the pump defers a report until the batch settles and never uses agent_end", () => {
  const pump = createEventPump({
    identity: {
      runId: "run-1",
      taskId: "task-t1",
      attemptId: "attempt-a1",
      sessionId: "session-s1",
      generation: 1,
      leaseGeneration: 1,
      epoch: 3,
    },
  });

  const early = pump.ingest(pumpEvent({ kind: "candidate", settled: false, pendingTools: 2 }));
  assert.equal(early.ok, false);
  assert.equal((early as any).code, "unsafe_boundary");
  assert.equal((early as any).retry, true);

  const end = pump.ingest(pumpEvent({ kind: "agent-end" }));
  assert.equal((end as any).code, "unsafe_boundary");

  const safe = pump.ingest(
    pumpEvent({ messageId: "message-2", seq: 2, kind: "candidate", settled: true, pendingTools: 0 }),
  );
  assert.equal(safe.ok, true);
  assert.equal((safe as any).wake.kind, "candidate");
  assert.match((safe as any).wake.text, /inspect the quiescent candidate/);
});

test("the pump deduplicates, refuses reorders/stale epochs and coalesces bursts", () => {
  const pump = createEventPump({
    identity: {
      runId: "run-1",
      taskId: "task-t1",
      attemptId: "attempt-a1",
      sessionId: "session-s1",
      generation: 1,
      leaseGeneration: 1,
      epoch: 3,
    },
  });
  pump.beginTurn();
  assert.equal(pump.ingest(pumpEvent()).ok, true, "ready while busy is queued");
  const duplicate = pump.ingest(pumpEvent());
  assert.equal((duplicate as any).code, "duplicate");
  const reordered = pump.ingest(pumpEvent({ messageId: "message-0", seq: 0 }));
  assert.equal((reordered as any).code, "reordered");
  const staleEpoch = pump.ingest(pumpEvent({ messageId: "message-9", seq: 9, epoch: 2 }));
  assert.equal((staleEpoch as any).code, "stale_epoch");

  const waiting = pump.ingest(
    pumpEvent({ messageId: "message-3", seq: 3, kind: "waiting-user", questionId: "q-1" }),
  );
  assert.equal(waiting.ok, true);
  assert.equal(pump.pending(), 1, "ready was replaced by the higher-priority waiting-user wake");

  const heartbeat = pump.ingest(
    pumpEvent({ messageId: "message-4", seq: 4, kind: "heartbeat" }),
  );
  assert.equal((heartbeat as any).queued, false);
  assert.equal(pump.pending(), 1);

  const held = pump.drain();
  assert.equal(held, undefined, "a wake cannot overlap the active turn");
  pump.endTurn();
  const wake = pump.drain();
  assert.equal(wake?.kind, "waiting-user");
  assert.match(wake!.text, /Waiting|waiting/);
  assert.equal(pump.pending(), 0);
});

// ── Contract alignment (plan step 7) ─────────────────────────────────

test("dispatch requires a real host session and uses the worker's start id", () => {
  const state = stateWithPlan();
  const context = (over: Partial<ToolContext> = {}): ToolContext => ({
    state,
    now: 10,
    epoch: 1,
    currentEpoch: 1,
    activeTurn: false,
    approval: { approved: true, approvalDigest: "a", planDigest: "b" },
    ...over,
  });

  const missing = handleOrchestratorTool(
    "orchestrator_dispatch",
    { taskId: "task-t1", attemptId: "attempt-a1" },
    context(),
  );
  assert.equal(missing.ok, false);
  assert.equal((missing as any).code, "invalid");
  assert.match((missing as any).error, /sessionRef/);

  const dispatched = ok<{ event: any; receipt: any }>(
    handleOrchestratorTool(
      "orchestrator_dispatch",
      {
        taskId: "task-t1",
        attemptId: "attempt-a1",
        sessionRef: "sdk-session-42",
      },
      context(),
    ),
  );
  assert.equal(dispatched.event.sessionId, "sdk-session-42", "no placeholder id");
  assert.equal(dispatched.receipt.sessionRef, "sdk-session-42");
  // The receipt and the worker module must agree on the start id.
  assert.equal(
    dispatched.receipt.taskStartId,
    taskStartIdFor(workerIdFor({ runId: "run-1", taskId: "task-t1", attemptId: "attempt-a1" }), "attempt-a1"),
  );
});
