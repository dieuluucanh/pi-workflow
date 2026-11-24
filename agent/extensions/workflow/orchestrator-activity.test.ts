/**
 * Orchestrator composer projection tests.
 *
 * These are pure: no editor, no child session, no provider. They pin the exact
 * border copy and command spellings and, most importantly, the Esc matrix: a
 * repeated press while pausing/paused/verifying is consumed and never becomes
 * an abort.
 *
 * The border is deliberately narrow in what it may say: the phase word plus the
 * controls. Progress belongs to the pinned TODO pane (`Builder n/m`, `n/m
 * todos`), telemetry belongs to the footer (`child running · model · ctx …`) and
 * the tool stream belongs to the transcript band. A `lastTool` echoed here made
 * the line up to ~190 columns wide and pushed the actual state out of the
 * border, so the negative assertions below are as important as the positive
 * ones.
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

/** The widest line the border may ever render, in visible columns. */
const MAX_LINE = 96;
/** The narrow-terminal fallback must stay useful on a ~30-column border. */
const MAX_COMPACT = 30;
/** Recovery copy keeps its command guidance, so it gets a slightly wider bound. */
const MAX_RECOVERY_COMPACT = 40;

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

test("starting shows only the phase and the real pause/abort commands", () => {
  const activity = orchestratorActivity(
    input(
      {
        phase: "starting",
        ref: "2",
        total: 7,
        taskId: "task-2",
        attemptId: "attempt-1",
        todos: [],
      } as never,
      { escAvailable: true },
    ),
  );
  assert.ok(activity);
  assert.equal(activity.busy, true);
  assert.equal(activity.esc, "pause");
  assert.equal(
    activity.line,
    "Starting… · ESC or /orchestrator-pause to pause · /orchestrator-abort to stop",
  );
  assert.equal(activity.compact, "Starting…");
  assert.doesNotMatch(activity.line, /orchestrator-retry/);
});

test("running names the phase and the controls, never the tool", () => {
  const activity = orchestratorActivity(
    input(
      {
        phase: "running",
        ref: "3",
        total: 8,
        lastTool: "bash npm test",
        taskId: "task-3",
        attemptId: "attempt-2",
        todos: [],
      } as never,
      { escAvailable: true },
    ),
  );
  assert.ok(activity);
  assert.equal(activity.busy, true);
  assert.equal(activity.esc, "pause");
  assert.equal(
    activity.line,
    "Working · ESC or /orchestrator-pause to pause · /orchestrator-abort to stop",
  );
  assert.equal(activity.compact, "Working · ESC to pause");
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
  assert.equal(
    activity.line,
    "Working · /orchestrator-pause to pause · /orchestrator-abort to stop",
  );
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
  assert.equal(
    activity.line,
    "Working · retrying… · /orchestrator-pause to pause · /orchestrator-abort to stop",
  );
  assert.equal(activity.compact, "Working · retrying…");
  assert.doesNotMatch(activity.line, /blocked|failed/i);
});

test("a forwarded dialog is waiting, not Working with an Esc pause", () => {
  const activity = orchestratorActivity(
    input(
      {
        phase: "running",
        ref: "4",
        total: 9,
        todos: [],
      } as never,
      { awaitingDialog: true, escAvailable: true },
    ),
  );
  assert.ok(activity);
  assert.equal(
    activity.line,
    "Waiting · answer the dialog · /orchestrator-abort to stop",
  );
  assert.equal(activity.compact, "Waiting · answer the dialog");
  assert.equal(activity.esc, "swallow");
  assert.doesNotMatch(activity.line, /ESC/);
});

test("a warm pause advertises resume and consumes Esc", () => {
  const activity = orchestratorActivity(
    input(
      {
        phase: "paused",
        ref: "2",
        total: 5,
        todos: [],
      } as never,
      { escAvailable: true },
    ),
  );
  assert.ok(activity);
  assert.equal(activity.paused, true);
  assert.equal(activity.busy, false);
  assert.equal(activity.esc, "swallow");
  assert.equal(
    activity.line,
    "Paused · /orchestrator-resume to continue · /orchestrator-abort to stop",
  );
  assert.equal(activity.compact, "Paused · /orchestrator-resume");
  assert.doesNotMatch(activity.line, /ESC/);
});

test("a pause still settling is Pausing, never a second pause", () => {
  const activity = orchestratorActivity(
    input(
      {
        phase: "paused",
        ref: "2",
        total: 5,
        pausePending: true,
        todos: [],
      } as never,
      { escAvailable: true },
    ),
  );
  assert.ok(activity);
  assert.equal(activity.paused, false);
  assert.equal(activity.busy, false);
  assert.equal(activity.esc, "swallow");
  assert.equal(activity.line, "Pausing… · /orchestrator-abort to stop");
  assert.equal(activity.compact, "Pausing…");
  assert.doesNotMatch(activity.line, /ESC/);
});

test("verifying is guidance-only and consumes Esc", () => {
  const activity = orchestratorActivity(
    input(
      {
        phase: "settling",
        ref: "5",
        total: 6,
        todos: [],
      } as never,
      { escAvailable: true },
    ),
  );
  assert.ok(activity);
  assert.equal(activity.esc, "swallow");
  assert.equal(activity.line, "Verifying · /orchestrator-abort to stop");
  assert.equal(activity.compact, "Verifying");
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

// ── Border content guards (the reported defect) ──────────────────────

test("no border line can echo the last tool, command or row counter", () => {
  const leaky = {
    phase: "running",
    ref: "3",
    total: 19,
    taskId: "task-3",
    attemptId: "attempt-2",
    // The exact shape that made the border ~190 columns wide.
    lastTool: "bash: npm test -- --watch --runInBand",
    todos: [],
  } as never;

  for (const escAvailable of [true, false]) {
    const activity = orchestratorActivity(input(leaky, { escAvailable }));
    assert.ok(activity);
    for (const text of [activity.line, activity.compact]) {
      assert.doesNotMatch(text, /Builder/, text);
      assert.doesNotMatch(text, /\d+\s*\/\s*\d+/, text);
      assert.doesNotMatch(
        text,
        /bash|npm|--watch|--runInBand|task-3/,
        `no tool echo: ${text}`,
      );
      assert.doesNotMatch(text, /todos?/, `no todo counter: ${text}`);
    }
  }
});

test("every border line stays inside its width budget", () => {
  const children = [
    { phase: "starting" },
    { phase: "running" },
    { phase: "running", retrying: true },
    { phase: "paused" },
    { phase: "paused", pausePending: true },
    { phase: "settling" },
  ];
  for (const child of children) {
    for (const escAvailable of [true, false]) {
      const activity = orchestratorActivity(
        input({ ...child, ref: "3", total: 19, todos: [] } as never, {
          escAvailable,
        }),
      );
      assert.ok(activity, JSON.stringify(child));
      assert.ok(
        activity.line.length <= MAX_LINE,
        `${activity.line.length} > ${MAX_LINE}: ${activity.line}`,
      );
      assert.ok(
        activity.compact.length <= MAX_COMPACT,
        `${activity.compact.length} > ${MAX_COMPACT}: ${activity.compact}`,
      );
      assert.doesNotMatch(activity.line, /[\r\n\t]/, "one clean line");
    }
  }

  const dialog = orchestratorActivity(
    input({ phase: "running", todos: [] } as never, { awaitingDialog: true }),
  );
  assert.ok(dialog);
  assert.ok(dialog.line.length <= MAX_LINE);
  assert.ok(dialog.compact.length <= MAX_COMPACT);

  // Recovery guidance keeps its command spellings, so it is bounded separately.
  const blocked = orchestratorActivity({
    runPhase: "blocked",
    blockedReason: "check failed",
  });
  assert.ok(blocked);
  assert.ok(blocked.compact.length <= MAX_RECOVERY_COMPACT);
  const runPaused = orchestratorActivity({ runPhase: "paused" });
  assert.ok(runPaused);
  assert.ok(runPaused.compact.length <= MAX_RECOVERY_COMPACT);
});
