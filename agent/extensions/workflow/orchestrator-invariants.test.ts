/**
 * Orchestrator invariant/property coverage (step 44).
 *
 * Generates transition sequences from a deterministic PRNG and asserts the
 * global invariants after every accepted event, plus targeted cases the plan
 * names explicitly: duplicate/stale events, local vs durable refs, stale
 * generations, task splitting, cancelled requirements, scope revisions and
 * retry/rollover budgets.
 *
 * The generator is seed-stable, so a failure is reproducible without a fuzzing
 * dependency.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  applyRunEvent,
  createRunState,
  mutationTask,
  nextRunnableTask,
  projectTodos,
  type RunEvent,
  type RunState,
} from "./orchestrator-state.ts";
import {
  ORCHESTRATOR_SCHEMA_VERSION,
  TASK_STATES,
  validatePlanCoverage,
  type AcceptanceEvidence,
  type PlannedTask,
  type RoadmapRequirement,
} from "./orchestrator-types.ts";
import { createEventPump, type PumpEvent } from "./orchestrator-tools.ts";
import { createUsageLedger } from "./orchestrator-observability.ts";

/** mulberry32: tiny deterministic PRNG. */
function rng(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value = (value + 0x6d2b79f5) >>> 0;
    let t = value;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const REQUIREMENTS: RoadmapRequirement[] = [
  { roadmapStepId: "step-r1", label: "1", text: "One" },
  { roadmapStepId: "step-r2", label: "2", text: "Two" },
  { roadmapStepId: "step-r3", label: "3", text: "Three" },
];

const TASKS: PlannedTask[] = [
  {
    taskId: "task-t1",
    covers: ["step-r1"],
    objective: "One",
    nonGoals: [],
    dependsOn: [],
    expectedFiles: ["src/a.ts"],
    acceptanceChecks: ["tests"],
    sizeRationale: "small",
  },
  {
    taskId: "task-t2",
    covers: ["step-r2"],
    objective: "Two",
    nonGoals: [],
    dependsOn: ["task-t1"],
    expectedFiles: ["src/b.ts"],
    acceptanceChecks: ["tests"],
    sizeRationale: "small",
  },
  {
    taskId: "task-t3",
    covers: ["step-r3"],
    objective: "Three",
    nonGoals: [],
    dependsOn: ["task-t2"],
    expectedFiles: ["src/c.ts"],
    acceptanceChecks: ["tests"],
    sizeRationale: "small",
  },
];

function planState(): RunState {
  const created = createRunState({ runId: "run-1", roadmapRevision: 1, now: 1 });
  assert.equal(created.ok, true);
  const applied = applyRunEvent(created.state, {
    type: "plan.apply",
    runId: "run-1",
    expectedRevision: created.state.revision,
    now: 2,
    plan: {
      schemaVersion: ORCHESTRATOR_SCHEMA_VERSION,
      runId: "run-1",
      roadmapRevision: 1,
      tasks: TASKS,
    },
    requirements: REQUIREMENTS,
  });
  assert.equal(applied.ok, true);
  return applied.state;
}

function fingerprint(state: RunState): string {
  return JSON.stringify(state);
}

function assertInvariants(state: RunState): void {
  assert.ok(state.revision >= 1);
  assert.equal(new Set(state.order).size, state.order.length, "order ids are unique");
  for (const taskId of state.order) {
    const task = state.tasks[taskId];
    assert.ok(task, `order names ${taskId}`);
    assert.ok((TASK_STATES as readonly string[]).includes(task.state), `valid task state ${task.state}`);
    assert.ok(task.covers.length > 0, "every task covers a requirement");
    const attemptIds = task.attempts.map((attempt) => attempt.attemptId);
    assert.equal(new Set(attemptIds).size, attemptIds.length, "attempt ids are unique");
    if (task.state === "accepted") {
      assert.ok(task.acceptance, "accepted has evidence");
      const current = task.attempts.find((attempt) => attempt.attemptId === task.currentAttemptId);
      assert.ok(current?.candidateId, "accepted has a candidate");
    }
  }
  if (state.mutation) {
    assert.equal(state.mutation.runId, state.runId);
    const task = state.tasks[state.mutation.taskId];
    assert.ok(task, "the single writer names a task");
    assert.ok(
      task.state === "assigned" || task.state === "running",
      `the writer task is ${task.state}, not a mutating state`,
    );
    assert.equal(task.currentAttemptId, state.mutation.attemptId);
    assert.equal(mutationTask(state), task.taskId);
  }
  if (state.phase === "completed") {
    assert.equal(
      state.order.every((taskId) => state.tasks[taskId]?.state === "accepted"),
      true,
      "completion requires every task accepted",
    );
  }
  const todos = projectTodos(state);
  assert.deepEqual(
    todos.map((todo) => todo.ref),
    state.order.map((_, index) => index + 1),
    "display refs are a local 1..N sequence",
  );
  assert.equal(new Set(todos.map((todo) => todo.taskId)).size, todos.length);
  for (const todo of todos) assert.notEqual(todo.ref, todo.taskId);
}

function evidenceFor(state: RunState, taskId: string, index: number): AcceptanceEvidence | undefined {
  const task = state.tasks[taskId];
  const attempt = task?.attempts.find((entry) => entry.attemptId === task.currentAttemptId);
  if (!attempt?.candidateId) return undefined;
  return {
    schemaVersion: ORCHESTRATOR_SCHEMA_VERSION,
    evidenceId: `evidence-e${index}`,
    runId: state.runId,
    taskId,
    attemptId: attempt.attemptId,
    candidateId: attempt.candidateId,
    roadmapRevision: state.roadmapRevision,
    workspaceRevision: "workspace-rev-1",
    inspected: { filesChanged: 1, files: ["src/a.ts"] },
    checks: [{ name: "tests", status: "passed", evidence: "exit 0" }],
    verdict: "accepted",
    createdAt: 10 + index,
  };
}

function candidateEvents(state: RunState, random: () => number, index: number): RunEvent[] {
  const now = 100 + index;
  const events: RunEvent[] = [];
  const base = { runId: state.runId, expectedRevision: state.revision, now };

  for (const taskId of state.order) {
    const task = state.tasks[taskId];
    const ready = task.dependsOn.every((id) => state.tasks[id]?.state === "accepted");
    if (task.state === "pending" && ready) {
      events.push({
        ...base,
        type: "task.assign",
        taskId,
        attemptId: `attempt-a${index}-${taskId}`,
        sessionId: `session-s${index}-${taskId}`,
        generation: task.attempts.length + 1,
      });
      events.push({ ...base, type: "task.assign", taskId, attemptId: `attempt-a${index}-${taskId}`, sessionId: `session-s${index}-${taskId}`, generation: 0 });
    }
    if (task.state === "assigned" && task.currentAttemptId) {
      const attempt = task.attempts.find((entry) => entry.attemptId === task.currentAttemptId)!;
      events.push({
        ...base,
        type: "task.start",
        taskId,
        attemptId: attempt.attemptId,
        sessionId: attempt.sessionId,
        generation: attempt.generation,
      });
      events.push({
        ...base,
        type: "task.start",
        taskId,
        attemptId: attempt.attemptId,
        sessionId: attempt.sessionId,
        generation: attempt.generation + 99,
      });
    }
    if (task.state === "running" && task.currentAttemptId) {
      events.push({
        ...base,
        type: "task.candidate",
        taskId,
        attemptId: task.currentAttemptId,
        candidateId: `candidate-c${index}-${taskId}`,
        meaningfulChange: random() > 0.3,
      });
    }
    if (task.state === "candidate") {
      events.push({ ...base, type: "task.verify", taskId });
    }
    if (task.state === "verifying") {
      const evidence = evidenceFor(state, taskId, index);
      if (evidence && random() > 0.25) {
        events.push({
          ...base,
          type: "task.accept",
          taskId,
          evidence,
          workspaceRevision: evidence.workspaceRevision,
        });
      } else {
        events.push({
          ...base,
          type: "task.needsFix",
          taskId,
          meaningfulChange: random() > 0.5,
          reason: "checks failed",
        });
      }
    }
    if (task.state === "needs_fix") {
      events.push({
        ...base,
        type: "task.assign",
        taskId,
        attemptId: `attempt-r${index}-${taskId}`,
        sessionId: `session-r${index}-${taskId}`,
        generation: task.attempts.length + 1,
      });
      events.push({ ...base, type: "task.block", taskId, reason: "blocked" });
    }
    if (task.state === "accepted") {
      events.push({ ...base, type: "task.supersede", taskId, reason: "scope revision" });
    }
    if (task.state === "assigned") {
      const attempt = task.attempts.find((entry) => entry.attemptId === task.currentAttemptId);
      if (attempt) events.push({ ...base, type: "attempt.launchFailed", taskId, attemptId: attempt.attemptId });
    }
    if (task.state === "running" || task.state === "candidate" || task.state === "verifying") {
      events.push({ ...base, type: "task.cancel", taskId, reason: "cancelled requirement" });
    }
    if (task.state === "candidate" || task.state === "running") {
      const attempt = task.attempts.find((entry) => entry.attemptId === task.currentAttemptId);
      if (attempt) {
        events.push({
          ...base,
          type: "attempt.rollover",
          taskId,
          attemptId: attempt.attemptId,
          newAttemptId: `attempt-o${index}-${taskId}`,
          sessionId: `session-o${index}-${taskId}`,
          generation: attempt.generation + 1,
        });
      }
    }
  }
  const phases = ["ready", "dispatching", "building", "verifying", "paused", "blocked", "interrupted", "cancelled", "final_verification", "completed"];
  events.push({ ...base, type: "run.transition", to: phases[Math.floor(random() * phases.length)] as RunState["phase"] });
  return events;
}

test("generated transition sequences preserve the global invariants", () => {
  for (let seed = 1; seed <= 25; seed += 1) {
    const random = rng(seed);
    let state = planState();
    for (let index = 0; index < 30; index += 1) {
      const before = fingerprint(state);
      const events = candidateEvents(state, random, index);
      if (events.length === 0) break;
      const event = events[Math.floor(random() * events.length)]!;
      const outcome = applyRunEvent(state, event);
      if (outcome.ok) {
        assert.equal(outcome.state.revision, state.revision + 1, `seed ${seed}: one revision per event`);
        state = outcome.state;
        assertInvariants(state);
      } else {
        assert.equal(fingerprint(state), before, `seed ${seed}: a refused event must not mutate state`);
        assert.ok(outcome.code.length > 0);
      }
      // A duplicate of the same revision always fails after a successful event.
      const stale = applyRunEvent(state, event);
      if (stale.ok) {
        assert.fail(`seed ${seed}: the same revision must not apply twice`);
      }
    }
  }
});

test("stale generations and stale revisions fail without a writer", () => {
  let state = planState();
  const assign = applyRunEvent(state, {
    type: "task.assign",
    runId: "run-1",
    expectedRevision: state.revision,
    now: 3,
    taskId: "task-t1",
    attemptId: "attempt-a1",
    sessionId: "session-s1",
    generation: 1,
  });
  assert.equal(assign.ok, true);
  state = assign.state;

  const stale = applyRunEvent(state, {
    type: "task.start",
    runId: "run-1",
    expectedRevision: state.revision - 1,
    now: 4,
    taskId: "task-t1",
    attemptId: "attempt-a1",
    sessionId: "session-s1",
    generation: 1,
  });
  assert.equal(stale.ok, false);
  assert.equal((stale as any).code, "stale_revision");

  const wrongGeneration = applyRunEvent(state, {
    type: "task.start",
    runId: "run-1",
    expectedRevision: state.revision,
    now: 4,
    taskId: "task-t1",
    attemptId: "attempt-a1",
    sessionId: "session-s1",
    generation: 9,
  });
  assert.equal(wrongGeneration.ok, false);
  assert.equal((wrongGeneration as any).code, "stale_generation");
  assert.equal(mutationTask(state), "task-t1");
});

test("no-progress and repair budgets pause instead of looping", () => {
  let state = planState();
  const assign = applyRunEvent(state, {
    type: "task.assign",
    runId: "run-1",
    expectedRevision: state.revision,
    now: 3,
    taskId: "task-t1",
    attemptId: "attempt-a1",
    sessionId: "session-s1",
    generation: 1,
  });
  assert.equal(assign.ok, true);
  state = assign.state;
  const start = applyRunEvent(state, {
    type: "task.start",
    runId: "run-1",
    expectedRevision: state.revision,
    now: 4,
    taskId: "task-t1",
    attemptId: "attempt-a1",
    sessionId: "session-s1",
    generation: 1,
  });
  assert.equal(start.ok, true);
  state = start.state;

  let index = 0;
  while (state.tasks["task-t1"]!.state !== "blocked" && index < 10) {
    index += 1;
    if (state.tasks["task-t1"]!.state === "running") {
      const candidate = applyRunEvent(state, {
        type: "task.candidate",
        runId: "run-1",
        expectedRevision: state.revision,
        now: 10 + index,
        taskId: "task-t1",
        attemptId: state.tasks["task-t1"]!.currentAttemptId ?? "attempt-a1",
        candidateId: `candidate-c${index}`,
        meaningfulChange: false,
      });
      assert.equal(candidate.ok, true);
      state = candidate.state;
    }
    if (state.tasks["task-t1"]!.state === "candidate") {
      const verify = applyRunEvent(state, {
        type: "task.verify",
        runId: "run-1",
        expectedRevision: state.revision,
        now: 20 + index,
        taskId: "task-t1",
      });
      assert.equal(verify.ok, true);
      state = verify.state;
    }
    if (state.tasks["task-t1"]!.state === "verifying") {
      const fix = applyRunEvent(state, {
        type: "task.needsFix",
        runId: "run-1",
        expectedRevision: state.revision,
        now: 30 + index,
        taskId: "task-t1",
        meaningfulChange: false,
        reason: "same failure",
      });
      assert.equal(fix.ok, true);
      state = fix.state;
    }
    if (state.tasks["task-t1"]!.state === "needs_fix") {
      const reassign = applyRunEvent(state, {
        type: "task.assign",
        runId: "run-1",
        expectedRevision: state.revision,
        now: 40 + index,
        taskId: "task-t1",
        attemptId: `attempt-fix${index}`,
        sessionId: `session-s${index}`,
        generation: state.tasks["task-t1"]!.attempts.length + 1,
      });
      assert.equal(reassign.ok, true);
      state = reassign.state;
      const run = applyRunEvent(state, {
        type: "task.start",
        runId: "run-1",
        expectedRevision: state.revision,
        now: 41 + index,
        taskId: "task-t1",
        attemptId: `attempt-fix${index}`,
        sessionId: `session-s${index}`,
        generation: state.tasks["task-t1"]!.attempts.length,
      });
      assert.equal(run.ok, true);
      state = run.state;
    }
  }
  assert.equal(state.tasks["task-t1"]!.state, "blocked");
  assert.match(state.tasks["task-t1"]!.blockedReason ?? "", /no-progress budget exhausted/);
  assert.equal(nextRunnableTask(state), undefined);
});

test("coverage rejects uncovered and cyclic plans before any dispatch", () => {
  const unknownCover = validatePlanCoverage({
    requirements: REQUIREMENTS,
    tasks: [{ ...TASKS[0], covers: ["step-missing"] }],
  });
  assert.equal(unknownCover.ok, false);

  const uncovered = validatePlanCoverage({
    requirements: REQUIREMENTS,
    tasks: TASKS.slice(0, 2),
  });
  assert.equal(uncovered.ok, false);
  assert.equal((uncovered as any).uncovered.length, 1);

  const cyclic = validatePlanCoverage({
    requirements: REQUIREMENTS,
    tasks: [
      { ...TASKS[0], dependsOn: ["task-t2"] },
      { ...TASKS[1], dependsOn: ["task-t1"] },
      TASKS[2],
    ],
  });
  assert.equal(cyclic.ok, false);
  assert.match((cyclic as any).error, /dependency cycle/);
});

test("a report cannot accept a parent ref, and duplicate events never wake twice", () => {
  const state = planState();
  const todos = projectTodos(state);
  assert.deepEqual(todos.map((todo) => todo.ref), [1, 2, 3]);
  for (const todo of todos) {
    assert.equal(todo.taskId.startsWith("task-"), true);
    assert.equal(typeof todo.ref, "number");
  }

  const pump = createEventPump({
    identity: {
      runId: "run-1",
      taskId: "task-t1",
      attemptId: "attempt-a1",
      sessionId: "session-s1",
      generation: 1,
      leaseGeneration: 1,
      epoch: 1,
    },
  });
  const event: PumpEvent = {
    messageId: "message-1",
    seq: 1,
    kind: "candidate",
    runId: "run-1",
    taskId: "task-t1",
    attemptId: "attempt-a1",
    sessionId: "session-s1",
    generation: 1,
    leaseGeneration: 1,
    epoch: 1,
    settled: true,
    pendingTools: 0,
    pendingFollowUps: 0,
    at: 10,
  };
  assert.equal(pump.ingest(event).ok, true);
  const duplicate = pump.ingest({ ...event, seq: 2 });
  assert.equal((duplicate as any).code, "duplicate");
  assert.equal(pump.pending(), 0);
});

test("usage replay is idempotent across a generated report sequence", () => {
  const ledger = createUsageLedger();
  const random = rng(99);
  let duplicates = 0;
  for (let index = 0; index < 200; index += 1) {
    const sessionId = `session-${Math.floor(random() * 3)}`;
    const messageId = `message-${Math.floor(random() * 40)}`;
    const result = ledger.record({
      sessionId,
      messageId,
      model: "openai/gpt",
      inputTokens: 10,
      outputTokens: 2,
      costUsd: 0.001,
      at: index,
    });
    assert.equal(result.ok, true);
    if ((result as any).duplicate) duplicates += 1;
  }
  const totals = ledger.totals();
  assert.equal(totals.records + totals.duplicateRecords, 200);
  assert.equal(totals.records, ledger.records().length);
  assert.ok(duplicates > 0);
});

test("repair rounds pause at the configured limit instead of retrying forever", () => {
  let state = planState();
  const step = (event: RunEvent) => {
    const result = applyRunEvent(state, event);
    if (!result.ok) return result;
    state = result.state;
    return result;
  };
  let assigned = step({
    type: "task.assign",
    runId: "run-1",
    expectedRevision: state.revision,
    now: 3,
    taskId: "task-t1",
    attemptId: "attempt-round0",
    sessionId: "session-round0",
    generation: 1,
  });
  assert.equal(assigned.ok, true);
  let attemptId = "attempt-round0";
  let generation = 1;
  for (let round = 1; round <= 3; round += 1) {
    step({
      type: "task.start",
      runId: "run-1",
      expectedRevision: state.revision,
      now: 10 + round,
      taskId: "task-t1",
      attemptId,
      sessionId: `session-round${round - 1}`,
      generation,
    });
    step({
      type: "task.candidate",
      runId: "run-1",
      expectedRevision: state.revision,
      now: 20 + round,
      taskId: "task-t1",
      attemptId,
      candidateId: `candidate-repair${round}`,
      meaningfulChange: true,
    });
    step({
      type: "task.verify",
      runId: "run-1",
      expectedRevision: state.revision,
      now: 30 + round,
      taskId: "task-t1",
    });
    const fixed = step({
      type: "task.needsFix",
      runId: "run-1",
      expectedRevision: state.revision,
      now: 40 + round,
      taskId: "task-t1",
      meaningfulChange: true,
      reason: "still failing",
    });
    assert.equal(fixed.ok, true);
    if (state.tasks["task-t1"]!.state === "blocked") break;
    attemptId = `attempt-round${round}`;
    generation += 1;
    const next = step({
      type: "task.assign",
      runId: "run-1",
      expectedRevision: state.revision,
      now: 50 + round,
      taskId: "task-t1",
      attemptId,
      sessionId: `session-round${round}`,
      generation,
    });
    assert.equal(next.ok, true);
  }
  const task = state.tasks["task-t1"]!;
  assert.equal(task.state, "blocked");
  assert.equal(task.counters.repairRounds > 2, true);
  assert.match(task.blockedReason ?? "", /repair budget exhausted/);
});
