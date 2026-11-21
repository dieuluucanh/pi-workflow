/**
 * Pure orchestrator state machine tests (step 15).
 *
 * These pin the invariants the journal and scheduler must never bypass:
 * revision fences, dependency readiness, one mutation owner, candidate ≠
 * acceptance, cancellation ≠ completion, and bounded retry counters.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  applyRunEvent,
  createRunState,
  mutationTask,
  nextRunnableTask,
  projectTodos,
  type RunState,
  type StateResult,
} from "./orchestrator-state.ts";
import {
  ORCHESTRATOR_SCHEMA_VERSION,
  type AcceptanceEvidence,
  type PlannedTask,
  type RoadmapRequirement,
} from "./orchestrator-types.ts";

const REQS: RoadmapRequirement[] = [
  { roadmapStepId: "r1", label: "1", text: "Read the API" },
  { roadmapStepId: "r2", label: "2", text: "Implement the client" },
];

const TASKS: PlannedTask[] = [
  {
    taskId: "t1",
    covers: ["r1"],
    objective: "Read the API",
    nonGoals: [],
    dependsOn: [],
    expectedFiles: ["src/api.ts"],
    acceptanceChecks: ["notes exist"],
    sizeRationale: "small",
  },
  {
    taskId: "t2",
    covers: ["r2"],
    objective: "Implement the client",
    nonGoals: [],
    dependsOn: ["t1"],
    expectedFiles: ["src/client.ts"],
    acceptanceChecks: ["tests pass"],
    sizeRationale: "small",
  },
];

function expectOk(result: StateResult): RunState {
  assert.equal(result.ok, true, result.ok ? "" : `${result.code}: ${result.error}`);
  return (result as { ok: true; state: RunState }).state;
}

function expectFail(result: StateResult, code: string): void {
  assert.equal(result.ok, false, "expected a refusal");
  assert.equal((result as { ok: false; code: string }).code, code);
}

function init(): RunState {
  const created = createRunState({ runId: "run-1", roadmapRevision: 1, now: 1 });
  const state = expectOk(created);
  const planned = expectOk(
    applyRunEvent(state, {
      type: "plan.apply",
      runId: state.runId,
      expectedRevision: state.revision,
      now: 2,
      plan: {
        schemaVersion: ORCHESTRATOR_SCHEMA_VERSION,
        runId: state.runId,
        roadmapRevision: 1,
        tasks: TASKS,
      },
      requirements: REQS,
    }),
  );
  return planned;
}

function approved(): RunState {
  const planned = init();
  const ready = expectOk(
    applyRunEvent(planned, {
      type: "run.transition",
      runId: planned.runId,
      expectedRevision: planned.revision,
      now: 3,
      to: "ready",
    }),
  );
  // awaiting_approval → ready is legal; the test jumps through the documented
  // approval gate rather than bypassing it.
  return ready;
}

function nextGeneration(state: RunState, taskId: string): number {
  const attempts = state.tasks[taskId]?.attempts ?? [];
  return attempts.reduce((max, attempt) => Math.max(max, attempt.generation), 0) + 1;
}

function assign(state: RunState, taskId: string, attemptId = `a-${taskId}`): RunState {
  return expectOk(
    applyRunEvent(state, {
      type: "task.assign",
      runId: state.runId,
      expectedRevision: state.revision,
      now: 10,
      taskId,
      attemptId,
      sessionId: `s-${attemptId}`,
      generation: nextGeneration(state, taskId),
    }),
  );
}

function running(state: RunState, taskId: string, attemptId = `a-${taskId}`): RunState {
  const started = assign(state, taskId, attemptId);
  const generation = started.tasks[taskId]?.attempts.at(-1)?.generation ?? 1;
  return expectOk(
    applyRunEvent(started, {
      type: "task.start",
      runId: started.runId,
      expectedRevision: started.revision,
      now: 11,
      taskId,
      attemptId,
      sessionId: `s-${attemptId}`,
      generation,
    }),
  );
}

function candidate(state: RunState, taskId: string, attemptId = `a-${taskId}`, meaningful = true): RunState {
  const live = running(state, taskId, attemptId);
  return expectOk(
    applyRunEvent(live, {
      type: "task.candidate",
      runId: live.runId,
      expectedRevision: live.revision,
      now: 12,
      taskId,
      attemptId,
      candidateId: `c-${taskId}`,
      meaningfulChange: meaningful,
    }),
  );
}

function evidence(state: RunState, taskId = "t1"): AcceptanceEvidence {
  const task = state.tasks[taskId];
  return {
    schemaVersion: ORCHESTRATOR_SCHEMA_VERSION,
    evidenceId: `e-${taskId}`,
    runId: state.runId,
    taskId,
    attemptId: task.currentAttemptId!,
    candidateId: `c-${taskId}`,
    roadmapRevision: state.roadmapRevision,
    workspaceRevision: "ws-1",
    inspected: { filesChanged: 1, files: ["src/api.ts"] },
    checks: [{ name: "notes exist", status: "passed" }],
    verdict: "accepted",
    createdAt: 13,
  };
}

function accept(state: RunState, taskId = "t1"): RunState {
  // `accept` is the whole candidate → verify → evidence path; a caller may
  // already be at `candidate` (the repair tests are).
  const ready = state.tasks[taskId]?.state === "candidate" ? state : candidate(state, taskId);
  const verified = expectOk(
    applyRunEvent(ready, {
      type: "task.verify",
      runId: ready.runId,
      expectedRevision: ready.revision,
      now: 13,
      taskId,
    }),
  );
  return expectOk(
    applyRunEvent(verified, {
      type: "task.accept",
      runId: verified.runId,
      expectedRevision: verified.revision,
      now: 14,
      taskId,
      evidence: evidence(verified, taskId),
      workspaceRevision: "ws-1",
    }),
  );
}

test("plan: coverage, cycles and unknown ids fail closed", () => {
  const created = createRunState({ runId: "run-1", roadmapRevision: 1, now: 1 });
  const state = expectOk(created);
  const apply = (tasks: PlannedTask[], requirements = REQS) =>
    applyRunEvent(state, {
      type: "plan.apply",
      runId: state.runId,
      expectedRevision: state.revision,
      now: 2,
      plan: {
        schemaVersion: ORCHESTRATOR_SCHEMA_VERSION,
        runId: state.runId,
        roadmapRevision: 1,
        tasks,
      },
      requirements,
    });

  expectFail(apply([TASKS[0]!]), "coverage");
  expectFail(apply([{ ...TASKS[0]!, covers: ["nope"] }]), "coverage");
  expectFail(
    apply([
      { ...TASKS[0]!, dependsOn: ["t2"] },
      { ...TASKS[1]!, dependsOn: ["t1"] },
    ]),
    "coverage",
  );
  expectOk(apply(TASKS));
});

test("fences: a stale revision or an illegal run transition is refused", () => {
  const planned = init();
  expectFail(
    applyRunEvent(planned, {
      type: "run.transition",
      runId: planned.runId,
      expectedRevision: planned.revision - 1,
      now: 3,
      to: "ready",
    }),
    "stale_revision",
  );
  expectFail(
    applyRunEvent(planned, {
      type: "run.transition",
      runId: planned.runId,
      expectedRevision: planned.revision,
      now: 3,
      to: "completed",
    }),
    "illegal_transition",
  );
  // A foreign run id is not a revision race; it is a different record.
  expectFail(
    applyRunEvent(planned, {
      type: "run.transition",
      runId: "run-other",
      expectedRevision: planned.revision,
      now: 3,
      to: "ready",
    }),
    "invalid_state",
  );
});

test("dependency: a dependent task cannot start before its dependency is accepted", () => {
  const ready = approved();
  assert.equal(nextRunnableTask(ready), "t1");
  expectFail(
    applyRunEvent(ready, {
      type: "task.assign",
      runId: ready.runId,
      expectedRevision: ready.revision,
      now: 10,
      taskId: "t2",
      attemptId: "a-t2",
      sessionId: "s-t2",
      generation: 1,
    }),
    "dependency",
  );
});

test("single writer: a second assign is refused while a grant is held", () => {
  const assigned = assign(approved(), "t1");
  assert.equal(mutationTask(assigned), "t1");
  expectFail(
    applyRunEvent(assigned, {
      type: "task.assign",
      runId: assigned.runId,
      expectedRevision: assigned.revision,
      now: 10,
      taskId: "t2",
      attemptId: "a-t2",
      sessionId: "s-t2",
      generation: 1,
    }),
    "single_writer",
  );
  // A stale session/generation cannot start the assigned attempt either.
  expectFail(
    applyRunEvent(assigned, {
      type: "task.start",
      runId: assigned.runId,
      expectedRevision: assigned.revision,
      now: 11,
      taskId: "t1",
      attemptId: "a-t1",
      sessionId: "s-other",
      generation: 1,
    }),
    "stale_generation",
  );
});

test("candidate is not acceptance; acceptance needs matching evidence", () => {
  const ready = approved();
  const live = candidate(ready, "t1");
  assert.equal(live.tasks.t1!.state, "candidate");
  assert.equal(live.tasks.t1!.acceptance, undefined);
  assert.equal(live.mutation, null);

  expectFail(
    applyRunEvent(live, {
      type: "task.accept",
      runId: live.runId,
      expectedRevision: live.revision,
      now: 14,
      taskId: "t1",
      evidence: evidence(live),
      workspaceRevision: "ws-1",
    }),
    "illegal_transition",
  );

  const verified = expectOk(
    applyRunEvent(live, {
      type: "task.verify",
      runId: live.runId,
      expectedRevision: live.revision,
      now: 13,
      taskId: "t1",
    }),
  );
  expectFail(
    applyRunEvent(verified, {
      type: "task.accept",
      runId: verified.runId,
      expectedRevision: verified.revision,
      now: 14,
      taskId: "t1",
      evidence: { ...evidence(verified), candidateId: "c-wrong" },
      workspaceRevision: "ws-1",
    }),
    "evidence",
  );
  expectFail(
    applyRunEvent(verified, {
      type: "task.accept",
      runId: verified.runId,
      expectedRevision: verified.revision,
      now: 14,
      taskId: "t1",
      evidence: evidence(verified),
      workspaceRevision: "ws-2",
    }),
    "evidence",
  );

  const accepted = accept(ready, "t1");
  assert.equal(accepted.tasks.t1!.state, "accepted");
  assert.equal(accepted.tasks.t1!.acceptance?.evidenceId, "e-t1");
});

test("accepted work unlocks its dependent, and completion needs every task accepted", () => {
  const accepted = accept(approved(), "t1");
  assert.equal(nextRunnableTask(accepted), "t2");
  expectFail(
    applyRunEvent(accepted, {
      type: "run.transition",
      runId: accepted.runId,
      expectedRevision: accepted.revision,
      now: 20,
      to: "completed",
    }),
    "illegal_transition",
  );
  const second = accept(accepted, "t2");
  const readyAgain = expectOk(
    applyRunEvent(second, {
      type: "run.transition",
      runId: second.runId,
      expectedRevision: second.revision,
      now: 21,
      to: "ready",
    }),
  );
  const finalCheck = expectOk(
    applyRunEvent(readyAgain, {
      type: "run.transition",
      runId: readyAgain.runId,
      expectedRevision: readyAgain.revision,
      now: 22,
      to: "final_verification",
    }),
  );
  const done = expectOk(
    applyRunEvent(finalCheck, {
      type: "run.transition",
      runId: finalCheck.runId,
      expectedRevision: finalCheck.revision,
      now: 23,
      to: "completed",
    }),
  );
  assert.equal(done.phase, "completed");
});

test("cancellation is not completion", () => {
  const ready = approved();
  const cancelled = expectOk(
    applyRunEvent(ready, {
      type: "task.cancel",
      runId: ready.runId,
      expectedRevision: ready.revision,
      now: 15,
      taskId: "t1",
      reason: "user stopped it",
    }),
  );
  assert.equal(cancelled.tasks.t1!.state, "cancelled");
  assert.equal(cancelled.tasks.t1!.acceptance, undefined);
  expectFail(
    applyRunEvent(cancelled, {
      type: "run.transition",
      runId: cancelled.runId,
      expectedRevision: cancelled.revision,
      now: 16,
      to: "completed",
    }),
    "illegal_transition",
  );
});

test("counters: repair budget pauses after the configured rounds", () => {
  let state = candidate(approved(), "t1");
  for (let round = 1; round <= 3; round += 1) {
    const verified = expectOk(
      applyRunEvent(state, {
        type: "task.verify",
        runId: state.runId,
        expectedRevision: state.revision,
        now: 20 + round,
        taskId: "t1",
      }),
    );
    const fixed = applyRunEvent(verified, {
      type: "task.needsFix",
      runId: verified.runId,
      expectedRevision: verified.revision,
      now: 21 + round,
      taskId: "t1",
      meaningfulChange: true,
    });
    if (round <= 2) {
      state = expectOk(fixed);
      state = running(state, "t1", `a-t1-${round + 1}`);
      state = expectOk(
        applyRunEvent(state, {
          type: "task.candidate",
          runId: state.runId,
          expectedRevision: state.revision,
          now: 30 + round,
          taskId: "t1",
          attemptId: `a-t1-${round + 1}`,
          candidateId: `c-t1-${round + 1}`,
          meaningfulChange: true,
        }),
      );
    } else {
      // Default repair budget is 2: the third request records a blocked pause.
      const blocked = expectOk(fixed);
      assert.equal(blocked.tasks.t1!.state, "blocked");
      assert.equal(blocked.tasks.t1!.counters.repairRounds, 3);
      assert.equal(blocked.phase, "blocked");
      state = blocked;
    }
  }
  assert.equal(state.tasks.t1!.state, "blocked");
});

test("counters: two no-progress candidates block the task", () => {
  let state = candidate(approved(), "t1", "a-t1", false);
  // The budget keeps one no-progress outcome in flight; the second blocks.
  assert.equal(state.tasks.t1!.counters.noProgress, 1);
  state = expectOk(
    applyRunEvent(state, {
      type: "task.verify",
      runId: state.runId,
      expectedRevision: state.revision,
      now: 20,
      taskId: "t1",
    }),
  );
  state = expectOk(
    applyRunEvent(state, {
      type: "task.needsFix",
      runId: state.runId,
      expectedRevision: state.revision,
      now: 21,
      taskId: "t1",
      meaningfulChange: false,
    }),
  );
  assert.equal(state.tasks.t1!.state, "blocked");
  assert.equal(state.phase, "blocked");
});

test("projection: refs are display-local and reflect durable task state", () => {
  const ready = approved();
  const accepted = accept(ready, "t1");
  const cancelled = expectOk(
    applyRunEvent(accepted, {
      type: "task.cancel",
      runId: accepted.runId,
      expectedRevision: accepted.revision,
      now: 22,
      taskId: "t2",
      reason: "scope dropped",
    }),
  );
  assert.deepEqual(projectTodos(cancelled), [
    { ref: 1, taskId: "t1", text: "Read the API", status: "completed" },
    { ref: 2, taskId: "t2", text: "Implement the client", status: "cancelled" },
  ]);
});
