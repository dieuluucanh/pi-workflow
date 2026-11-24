/**
 * Orchestrator composer projection tests.
 *
 * These are pure: no editor, no child session, no provider. They pin the exact
 * command spellings and, most importantly, the Esc matrix: a repeated press
 * while pausing/paused/verifying is consumed and never becomes an abort.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  orchestratorActivity,
  orchestratorEscAction,
  type OrchestratorActivityInput,
} from "./orchestrator-activity.ts";

function input(
  child: OrchestratorActivityInput["child"],
  over: Omit<OrchestratorActivityInput, "child"> = {},
): OrchestratorActivityInput {
  return { runPhase: "running", child, ...over };
}

test("no run and no child has no composer activity", () => {
  assert.equal(orchestratorActivity({}), undefined);
  assert.equal(orchestratorActivity({ runPhase: "ready" }), undefined);
  assert.equal(
    orchestratorActivity(input({ phase: "idle", todos: [] } as never)),
    undefined,
  );
  assert.equal(
    orchestratorActivity(input({ phase: "disposed", todos: [] } as never)),
    undefined,
  );
});

test("starting shows the child identity and real pause/abort commands", () => {
  const activity = orchestratorActivity(
    input({
      phase: "starting",
      ref: "2",
      total: 7,
      taskId: "task-2",
      attemptId: "attempt-1",
      todos: [],
    } as never),
  );
  assert.ok(activity);
  assert.equal(activity.busy, true);
  assert.equal(activity.esc, "pause");
  assert.match(activity.line, /Starting Builder 2\/7/);
  assert.match(activity.line, /\/orchestrator-pause/);
  assert.match(activity.line, /\/orchestrator-abort/);
  assert.doesNotMatch(activity.line, /orchestrator-retry/);
});

test("running names Working, the tool and the controls", () => {
  const activity = orchestratorActivity(
    input({
      phase: "running",
      ref: "3",
      total: 8,
      lastTool: "bash npm test",
      taskId: "task-3",
      attemptId: "attempt-2",
      todos: [],
    } as never, { escAvailable: true }),
  );
  assert.ok(activity);
  assert.equal(activity.busy, true);
  assert.equal(activity.esc, "pause");
  assert.match(activity.line, /^Working · Builder 3\/8 · bash npm test/);
  assert.match(activity.line, /ESC or \/orchestrator-pause to pause/);
  assert.match(activity.line, /\/orchestrator-abort to stop/);
  assert.equal(activity.compact, "Working · Builder 3/8 · bash npm test");
});

test("a wider host without the editor route omits the ESC hint", () => {
  const activity = orchestratorActivity(
    input({
      phase: "running",
      ref: "1",
      total: 2,
      todos: [],
    } as never),
  );
  assert.ok(activity);
  assert.equal(activity.esc, "pause");
  assert.doesNotMatch(activity.line, /ESC/);
  assert.match(activity.line, /\/orchestrator-pause to pause/);
});

test("provider retry is still Working, not a failure", () => {
  const activity = orchestratorActivity(
    input({
      phase: "running",
      ref: "1",
      total: 2,
      retrying: true,
      todos: [],
    } as never),
  );
  assert.ok(activity);
  assert.equal(activity.busy, true);
  assert.match(activity.line, /retrying…/);
  assert.doesNotMatch(activity.line, /blocked|failed/i);
});

test("a forwarded dialog is waiting, not Working with an Esc pause", () => {
  const activity = orchestratorActivity(
    input({
      phase: "running",
      ref: "4",
      total: 9,
      todos: [],
    } as never, { awaitingDialog: true, escAvailable: true }),
  );
  assert.ok(activity);
  assert.match(activity.line, /Waiting · Builder 4\/9/);
  assert.equal(activity.esc, "swallow");
  assert.doesNotMatch(activity.line, /ESC/);
});

test("a warm pause advertises resume and consumes Esc", () => {
  const activity = orchestratorActivity(
    input({
      phase: "paused",
      ref: "2",
      total: 5,
      todos: [],
    } as never, { escAvailable: true }),
  );
  assert.ok(activity);
  assert.equal(activity.paused, true);
  assert.equal(activity.busy, false);
  assert.equal(activity.esc, "swallow");
  assert.match(activity.line, /^Paused · Builder 2\/5/);
  assert.match(activity.line, /\/orchestrator-resume to continue/);
  assert.match(activity.line, /\/orchestrator-abort to stop/);
  assert.doesNotMatch(activity.line, /ESC/);
  assert.equal(activity.compact, "Paused · Builder 2/5");
});

test("a pause still settling is Pausing, never a second pause", () => {
  const activity = orchestratorActivity(
    input({
      phase: "paused",
      ref: "2",
      total: 5,
      pausePending: true,
      todos: [],
    } as never, { escAvailable: true }),
  );
  assert.ok(activity);
  assert.equal(activity.paused, false);
  assert.equal(activity.busy, false);
  assert.equal(activity.esc, "swallow");
  assert.match(activity.line, /^Pausing Builder 2\/5…/);
  assert.doesNotMatch(activity.line, /ESC/);
});

test("verifying is guidance-only and consumes Esc", () => {
  const activity = orchestratorActivity(
    input({
      phase: "settling",
      ref: "5",
      total: 6,
      todos: [],
    } as never, { escAvailable: true }),
  );
  assert.ok(activity);
  assert.equal(activity.esc, "swallow");
  assert.match(activity.line, /^Verifying · Builder 5\/6/);
  assert.match(activity.line, /\/orchestrator-abort to stop/);
  assert.doesNotMatch(activity.line, /orchestrator-pause|ESC/);
});

test("blocked and paused runs without a warm child offer recovery, not Working", () => {
  const blocked = orchestratorActivity({
    runPhase: "blocked",
    blockedReason: "check failed in row 3",
  });
  assert.ok(blocked);
  assert.equal(blocked.busy, false);
  assert.equal(blocked.esc, "pass");
  assert.match(blocked.line, /Run blocked — check failed in row 3/);
  assert.match(blocked.line, /\/orchestrator retry/);

  const paused = orchestratorActivity({ runPhase: "paused" });
  assert.ok(paused);
  assert.equal(paused.busy, false);
  assert.equal(paused.paused, false);
  assert.equal(paused.esc, "pass");
  assert.match(paused.line, /Run paused/);
  assert.match(paused.line, /\/orchestrator retry/);
});

test("a stale snapshot never presents Working or owns Esc", () => {
  const stale = input(
    {
      phase: "running",
      ref: "1",
      total: 1,
      todos: [],
    } as never,
    { owned: false },
  );
  assert.equal(orchestratorActivity(stale), undefined);
  assert.equal(orchestratorEscAction(stale), "pass");
});

test("Esc matrix: pause only while starting/running", () => {
  const phase = (value: string, over: Record<string, unknown> = {}) =>
    orchestratorEscAction(
      input({ phase: value, todos: [], ...over } as never),
    );

  assert.equal(phase("starting"), "pause");
  assert.equal(phase("running"), "pause");
  assert.equal(phase("running", { retrying: true }), "pause");
  assert.equal(phase("paused"), "swallow");
  assert.equal(phase("paused", { pausePending: true }), "swallow");
  assert.equal(phase("settling"), "swallow");
  assert.equal(phase("idle"), "pass");
  assert.equal(phase("disposed"), "pass");
});

test("Esc with a forwarded dialog is swallowed by the composer route", () => {
  assert.equal(
    orchestratorEscAction(
      input({ phase: "running", todos: [] } as never, {
        awaitingDialog: true,
      }),
    ),
    "swallow",
  );
});

test("repeated Esc decisions never produce abort/resume", () => {
  const seen = new Set<string>();
  for (let press = 0; press < 5; press += 1) {
    seen.add(
      orchestratorEscAction(
        input({ phase: "paused", pausePending: true, todos: [] } as never),
      ),
    );
  }
  assert.deepEqual([...seen], ["swallow"]);
});
