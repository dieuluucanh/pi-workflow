/**
 * Lifecycle control tests (step 30): waiting-user visibility, stale-lease
 * refusal, repair authorization, graceful/owned closure with retained history,
 * and an interrupted window close that is never accepted progress.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  canSchedule,
  closeChild,
  createChildLifecycle,
  handleWindowClosed,
  markChildRunning,
  markWaitingUser,
  parentStatus,
  pauseChild,
  requestRepair,
  resumeChild,
  sayToChild,
} from "./orchestrator-lifecycle.ts";

function child(phase: "running" | "fenced" = "running") {
  const base = createChildLifecycle({
    runId: "run-1",
    taskId: "task-1",
    attemptId: "attempt-1",
    sessionId: "session-1",
    sessionRef: "worker-ref-1",
    leaseGeneration: 4,
  });
  return { ...markChildRunning(base), ...(phase === "fenced" ? { phase, schedulerOwner: false } : {}) };
}

test("waiting-user is visible in the parent without accepting anything", () => {
  const waiting = markWaitingUser(child(), "question-1");
  assert.equal(waiting.ok, true);
  const state = (waiting as any).value;
  assert.equal(state.phase, "waiting_user");
  assert.match(parentStatus(state), /Waiting for your answer in the child/);
  assert.equal(state.acceptedProgress, false);
  assert.equal(canSchedule(state), true);
});

test("a stale lease generation cannot pause, resume, steer or repair", () => {
  const state = child();
  assert.equal((pauseChild(state, { leaseGeneration: 3 }) as any).code, "stale_lease");
  assert.equal(
    (resumeChild(state, { leaseGeneration: 3, currentLeaseGeneration: 4 }) as any).code,
    "stale_lease",
  );
  assert.equal((sayToChild(state, { text: "steer", leaseGeneration: 3 }) as any).code, "stale_lease");

  const fenced = child("fenced");
  assert.equal(
    (requestRepair(fenced, { authorization: "repair-authorized", leaseGeneration: 3 }) as any).code,
    "stale_lease",
  );
  assert.equal(
    (resumeChild(fenced, { leaseGeneration: 3, currentLeaseGeneration: 4 }) as any).code,
    "stale_lease",
  );
});

test("a fenced child needs explicit repair authorization and the current lease", () => {
  const fenced = child("fenced");
  assert.equal(
    (resumeChild(fenced, { leaseGeneration: 4, currentLeaseGeneration: 4 }) as any).code,
    "authorization",
  );
  assert.equal(
    (requestRepair(fenced, { authorization: "nope", leaseGeneration: 4 }) as any).code,
    "authorization",
  );
  const repaired = requestRepair(fenced, { authorization: "repair-authorized", leaseGeneration: 4 });
  assert.equal(repaired.ok, true);
  assert.equal((repaired as any).value.state.phase, "running");
  const resumed = resumeChild(fenced, {
    leaseGeneration: 4,
    currentLeaseGeneration: 4,
    repairAuthorization: "repair-authorized",
  });
  assert.equal(resumed.ok, true);
});

test("accepted closure is graceful, owned and archive-retaining", () => {
  const state = child();
  const closed = closeChild(state, {
    accepted: true,
    reason: "accepted by the parent",
    parentTabId: "tab-parent",
    sessionFile: "C:/sessions/worker.jsonl",
    title: "Task 1",
    now: 10,
  });
  assert.equal(closed.ok, true);
  const outcome = (closed as any).value;
  assert.equal(outcome.dispose, true);
  assert.equal(outcome.force, false);
  assert.equal(outcome.sessionRef, "worker-ref-1");
  assert.equal(outcome.retainHistory, true);
  assert.equal(outcome.state.phase, "closed");
  assert.equal(outcome.state.acceptedProgress, true);
  assert.equal(outcome.state.archive?.retained, true);
  assert.equal(canSchedule(outcome.state), false);

  const again = closeChild(outcome.state, {
    accepted: true,
    reason: "twice",
    parentTabId: "tab-parent",
    sessionFile: null,
    title: "Task 1",
    now: 11,
  });
  assert.equal((again as any).code, "closed");
});

test("a user-closed window is interrupted, not accepted, and has no scheduler", () => {
  const state = child();
  const closed = handleWindowClosed(state, {
    parentTabId: "tab-parent",
    sessionFile: "C:/sessions/worker.jsonl",
    title: "Task 1",
    now: 12,
  });
  assert.equal(closed.ok, true);
  const outcome = (closed as any).value;
  assert.equal(outcome.interrupted, true);
  assert.equal(outcome.state.phase, "interrupted");
  assert.equal(outcome.state.acceptedProgress, false);
  assert.equal(outcome.state.editsPreserved, true);
  assert.equal(outcome.state.historyRetained, true);
  assert.equal(canSchedule(outcome.state), false);
  assert.match(parentStatus(outcome.state), /interrupted/);
});

test("say is bounded, keeps the child running, and requests a budget recheck", () => {
  const state = child();
  const said = sayToChild(state, { text: "try the other helper", leaseGeneration: 4 });
  assert.equal(said.ok, true);
  assert.equal((said as any).value.requiresBudgetRecheck, true);
  assert.equal((sayToChild(state, { text: "  ", leaseGeneration: 4 }) as any).code, "invalid");
  assert.equal(
    (sayToChild(state, { text: "x".repeat(8_001), leaseGeneration: 4 }) as any).code,
    "too_large",
  );

  const closed = (handleWindowClosed(state, {
    parentTabId: "tab-parent",
    sessionFile: null,
    title: "Task 1",
    now: 3,
  }) as any).value.state;
  assert.equal((sayToChild(closed, { text: "hi", leaseGeneration: 4 }) as any).code, "closed");
});
