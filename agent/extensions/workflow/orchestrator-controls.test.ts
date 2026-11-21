/**
 * Controls tests (step 37): quiesce-before-pause/stop, lease release only after
 * the fence, explicit resume, no automatic rollback, one mutating/input owner,
 * review/mode races and revision fences.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  canAcceptPrompt,
  childQuiescent,
  claimInput,
  claimOwner,
  createRunControl,
  finishChild,
  pauseRun,
  queuePrompt,
  releaseInput,
  requestModeChange,
  resumeRun,
  stopRun,
  unstick,
  workspaceWriteAllowed,
  type ChildControlState,
  type RunControlState,
} from "./orchestrator-controls.ts";

function child(over: Partial<ChildControlState> = {}): ChildControlState {
  return {
    taskId: "task-t1",
    attemptId: "attempt-a1",
    sessionId: "session-s1",
    phase: "running",
    pendingTools: 0,
    pendingFollowUps: 0,
    settled: true,
    leaseGeneration: 4,
    editsPreserved: true,
    ...over,
  };
}

function base(over: Partial<ChildControlState> = {}): RunControlState {
  return createRunControl({ runId: "run-1", now: 1, mode: "orchestrator", child: child(over) });
}

function ok<T>(result: { ok: boolean }, label = "expected success"): T {
  assert.equal(result.ok, true, label);
  return result as unknown as T;
}

test("pause waits for the fence before releasing the lease", () => {
  const busy = base({ pendingTools: 1, phase: "running" });
  const quiesce = ok<any>(pauseRun(busy, { expectedRevision: busy.revision, now: 2 }));
  assert.equal(quiesce.action, "pause_quiesce");
  assert.equal(quiesce.releaseLease, false);
  assert.equal(quiesce.directive, "pause");
  assert.equal(quiesce.state.phase, busy.phase);

  const fenced = base({ phase: "fenced" });
  const paused = ok<any>(pauseRun(fenced, { expectedRevision: fenced.revision, now: 3 }));
  assert.equal(paused.action, "paused");
  assert.equal(paused.releaseLease, true);
  assert.equal(paused.state.phase, "paused");
  assert.equal(paused.state.owner, "none");

  const resumed = ok<any>(resumeRun(paused.state, { expectedRevision: paused.state.revision, now: 4 }));
  assert.equal(resumed.state.phase, "ready");
  assert.equal(resumed.state.inputOwner, "parent");
  assert.equal((resumeRun(fenced, { expectedRevision: fenced.revision, now: 5 }) as any).code, "not_paused");
});

test("stop quiesces, retains edits and never claims a rollback", () => {
  const busy = base({ pendingFollowUps: 1 });
  const quiesce = ok<any>(stopRun(busy, { expectedRevision: busy.revision, now: 2 }));
  assert.equal(quiesce.action, "stop_quiesce");
  assert.equal(quiesce.waitForFence, true);
  assert.equal(quiesce.editsPreserved, true);

  const idle = base({ phase: "fenced" });
  const stopped = ok<any>(stopRun(idle, { expectedRevision: idle.revision, now: 3, reason: "user stop" }));
  assert.equal(stopped.action, "stopped");
  assert.equal(stopped.state.phase, "cancelled");
  assert.equal(stopped.state.owner, "none");
  assert.equal(stopped.releaseLease, true);
  assert.equal(stopped.automaticRollback, false);
  assert.equal(stopped.editsPreserved, true);
  assert.equal((stopRun(stopped.state, { expectedRevision: stopped.state.revision, now: 4 }) as any).code, "terminal");
});

test("a live child or Review refuses a mode change; a queued prompt defers it", () => {
  const busy = base({ pendingTools: 1 });
  const refused = requestModeChange(busy, { expectedRevision: busy.revision, to: "build", now: 2 });
  assert.equal((refused as any).code, "single_writer");

  const fenced = base({ phase: "fenced" });
  const review = { ...fenced, reviewActive: true };
  const reviewRefused = requestModeChange(review, { expectedRevision: review.revision, to: "build", now: 3 });
  assert.equal((reviewRefused as any).code, "review_owns_turn");

  const queued = { ...base({ phase: "fenced" }), queuedPrompts: 1 };
  const deferred = ok<any>(requestModeChange(queued, { expectedRevision: queued.revision, to: "build", now: 4 }));
  assert.equal(deferred.action, "mode_deferred");
  assert.equal(deferred.state.mode, "build");

  const clean = base({ phase: "fenced" });
  const changed = ok<any>(requestModeChange(clean, { expectedRevision: clean.revision, to: "default", now: 5 }));
  assert.equal(changed.action, "mode_changed");
});

test("mutating and input ownership are single and parent cannot write", () => {
  const state = { ...base({ phase: "fenced" }), inputOwner: "none" as const };
  const childOwned = ok<any>(claimOwner(state, { expectedRevision: state.revision, owner: "child", now: 2 }));
  assert.equal(childOwned.state.owner, "child");
  assert.equal(workspaceWriteAllowed(childOwned.state, "child").allowed, true);
  assert.equal(workspaceWriteAllowed(childOwned.state, "parent").allowed, false);

  const second = claimOwner(childOwned.state, {
    expectedRevision: childOwned.state.revision,
    owner: "review",
    now: 3,
  });
  assert.equal((second as any).code, "single_writer");
  const parent = claimOwner(
    { ...childOwned.state, owner: "none" },
    { expectedRevision: childOwned.state.revision, owner: "parent", now: 3 },
  );
  assert.equal((parent as any).code, "single_writer");

  const claimed = ok<any>(claimInput(state, { expectedRevision: state.revision, owner: "review", now: 4 }));
  assert.equal(claimed.state.inputOwner, "review");
  assert.equal(
    (claimInput(claimed.state, { expectedRevision: claimed.state.revision, owner: "parent", now: 5 }) as any).code,
    "single_writer",
  );
  const released = ok<any>(
    releaseInput(claimed.state, { expectedRevision: claimed.state.revision, owner: "review", now: 6 }),
  );
  assert.equal(released.state.inputOwner, "none");
});

test("prompts queue only at an idle boundary", () => {
  const busy = base({ pendingTools: 1 });
  assert.equal(canAcceptPrompt(busy), false);
  const queued = queuePrompt(busy, { expectedRevision: busy.revision, now: 2 });
  assert.equal((queued as any).code, "busy");

  const idle = { ...base({ phase: "fenced" }), owner: "none" as const, child: undefined };
  assert.equal(canAcceptPrompt(idle), true);
  const accepted = ok<any>(queuePrompt(idle, { expectedRevision: idle.revision, now: 3 }));
  assert.equal(accepted.state.queuedPrompts, 1);
  assert.equal(childQuiescent(idle.child), true);
});

test("races fail closed: one mode/dispatch decision per revision", () => {
  const state = base({ phase: "fenced" });
  const mode = ok<any>(requestModeChange(state, { expectedRevision: state.revision, to: "build", now: 2 }));
  const dispatch = claimOwner(mode.state, {
    expectedRevision: state.revision,
    owner: "child",
    now: 2,
  });
  assert.equal((dispatch as any).code, "stale_revision");
  assert.equal(ok<any>(finishChild(mode.state, { expectedRevision: mode.state.revision, now: 3, nextPhase: "ready" })).releaseLease, true);
});

test("unstick clears an owner whose child disappeared without touching a live one", () => {
  const recovered = base({ phase: "running" });
  const stuck = { ...recovered, owner: "child" as const };
  const cleared = ok<any>(unstick(stuck, { expectedRevision: stuck.revision, now: 2, childAlive: false }));
  assert.equal(cleared.state.owner, "none");
  assert.equal(cleared.state.child, undefined);
  assert.equal(cleared.releaseLease, true);

  // A live child must be paused/closed, not silently unstuck.
  const stillStuck = unstick(stuck, { expectedRevision: stuck.revision, now: 4, childAlive: true });
  assert.equal((stillStuck as any).code, "busy");
});
