/**
 * Operator command tests (run-record verbs).
 *
 * The operator reports and controls an already-bound `OrchestratorRun`. It
 * never journals an event, never compiles a plan and never dispatches by
 * itself: retry/resume call the injected retry port with the stored
 * instruction.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  OPERATOR_SCHEMA_VERSION,
  createOperatorRuntime,
  orchestratorInputDecision,
  parseOperatorArgs,
  type OperatorRuntimePorts,
  type OperatorTodoRow,
} from "./orchestrator-operator.ts";
import {
  createOrchestratorRun,
  recordDispatch,
  recordReport,
  setRunPhase,
  type OrchestratorRun,
} from "./orchestrator-run.ts";

const TODO_ROWS: OperatorTodoRow[] = [
  { ref: "1", text: "First row", completed: true },
  { ref: "2", text: "Second row", completed: false },
];

function boundRun(): OrchestratorRun {
  const created = createOrchestratorRun({
    title: "Operator demo",
    planPath: ".pi/plans/x.md",
    steps: ["First row", "Second row"],
    workspaces: [
      { id: "W", root: "C:/repo/main", kind: "git", displayPath: ".", primary: true },
      { id: "B", root: "C:/repo/other", kind: "git", displayPath: "C:/repo/other", primary: false },
    ],
    now: 1,
  });
  const dispatched = recordDispatch(created, {
    rowRef: "2",
    instruction: "Do row two.",
  });
  return recordReport(dispatched, { rowRef: "2", report: "Blocked on a missing token." });
}

function harness(overrides: Partial<OperatorRuntimePorts> = {}) {
  const calls: string[] = [];
  const ports: OperatorRuntimePorts = {
    run: () => boundRun(),
    todos: () => TODO_ROWS,
    child: () => ({
      phase: "running",
      ref: "2",
      total: 2,
      todos: [],
    }),
    pauseChild: async () => {
      calls.push("pauseChild");
      return true;
    },
    resumeChild: async () => {
      calls.push("resumeChild");
      return true;
    },
    abortChild: async () => {
      calls.push("abortChild");
    },
    stopChild: async () => {
      calls.push("stopChild");
    },
    deliver: async () => ({ ok: true }),
    view: () => "auto",
    setView: (view) => calls.push(`view:${view}`),
    setPhase: (phase) => calls.push(`phase:${phase}`),
    retry: async (rowRef) => {
      calls.push(`retry:${rowRef ?? "?"}`);
      return { ok: true, text: "child started" };
    },
    ...overrides,
  };
  return { operator: createOperatorRuntime(ports), calls };
}

test("the operator schema version tracks the rewritten verbs", () => {
  assert.equal(OPERATOR_SCHEMA_VERSION, 3);
});

test("parse: bare is mode entry, an unknown verb is help", () => {
  assert.deepEqual(parseOperatorArgs(""), { verb: "mode-entry", rest: "" });
  assert.deepEqual(parseOperatorArgs("status now"), { verb: "status", rest: "now" });
  assert.deepEqual(parseOperatorArgs("nonsense"), { verb: "help", rest: "" });
});

test("status reports the run record, TODO completion and the next row", async () => {
  const { operator } = harness();
  const result = await operator.run("status");
  assert.equal(result.ok, true);
  assert.match(result.text, /run-.*· idle/);
  assert.match(result.text, /plan \.pi\/plans\/x\.md/);
  assert.match(result.text, /1\/2 rows done · next 2/);
  assert.match(result.text, /W=C:\/repo\/main \(primary\)/);
  assert.match(result.text, /next row: 2/);
  assert.doesNotMatch(result.text, /accepted/i);
});

test("status without a run explains how to bind one", async () => {
  const { operator } = harness({ run: () => undefined });
  const result = await operator.run("status");
  assert.equal(result.ok, false);
  assert.match(result.text, /orchestrator_start/);
});

test("start points at the model tool instead of creating a run", async () => {
  const { operator } = harness();
  const result = await operator.run("start");
  assert.equal(result.ok, false);
  assert.match(result.text, /already bound/i);
  assert.doesNotMatch(result.text, /frozen/i);
});

test("pause controls the child and records the phase", async () => {
  const { operator, calls } = harness();
  const result = await operator.run("pause");
  assert.equal(result.ok, true);
  assert.deepEqual(calls, ["pauseChild", "phase:paused"]);
});

test("pause refuses a terminal run and a missing child", async () => {
  const done = harness({ run: () => setRunPhase(boundRun(), "completed") });
  assert.match((await done.operator.run("pause")).text, /cannot be paused/);

  const idle = harness({ child: () => undefined });
  assert.match((await idle.operator.run("pause")).text, /No live child to pause/);

  const paused = harness({ child: () => ({ phase: "paused", todos: [] }) });
  assert.match((await paused.operator.run("pause")).text, /already paused/);
});

test("resume continues a warm paused child and records running", async () => {
  const { operator, calls } = harness({ child: () => ({ phase: "paused", todos: [] }) });
  const result = await operator.run("resume");
  assert.equal(result.ok, true);
  assert.deepEqual(calls, ["resumeChild", "phase:running"]);
});

test("resume without a warm child re-dispatches the current row", async () => {
  const { operator, calls } = harness({ child: () => undefined });
  const result = await operator.run("resume");
  assert.equal(result.ok, true);
  assert.deepEqual(calls, ["retry:2"]);
  assert.match(result.text, /Fresh child started for row 2/);
});

test("abort and stop dispose the child and record the phase", async () => {
  const aborted = harness();
  assert.equal((await aborted.operator.run("abort")).ok, true);
  assert.deepEqual(aborted.calls, ["abortChild", "phase:paused"]);

  const stopped = harness();
  assert.equal((await stopped.operator.run("stop")).ok, true);
  assert.deepEqual(stopped.calls, ["stopChild", "phase:cancelled"]);

  const cancelled = harness();
  assert.equal((await cancelled.operator.run("cancel")).ok, true);
  assert.deepEqual(cancelled.calls, ["stopChild", "phase:cancelled"]);

  const none = harness({ child: () => undefined });
  assert.equal((await none.operator.run("abort")).ok, false);
});

test("retry re-dispatches the stored instruction for the current or named row", async () => {
  const { operator, calls } = harness();
  assert.equal((await operator.run("retry")).ok, true);
  assert.deepEqual(calls, ["retry:2"]);

  const named = harness();
  assert.equal((await named.operator.run("retry 1")).ok, true);
  assert.deepEqual(named.calls, ["retry:1"]);
});

test("say delivers to the live child and refuses without one", async () => {
  const delivered = harness({ deliver: async () => ({ ok: true, queued: true }) });
  const result = await delivered.operator.run("say continue");
  assert.equal(result.ok, true);
  assert.match(result.text, /queued/);

  const none = harness({ child: () => undefined });
  assert.equal((await none.operator.run("say hi")).ok, false);
});

test("inspect shows the row instruction, last report and root", async () => {
  const { operator } = harness();
  const result = await operator.run("inspect 2");
  assert.equal(result.ok, true);
  assert.match(result.text, /instruction: Do row two\./);
  assert.match(result.text, /last report: Blocked on a missing token\./);
  assert.match(result.text, /root: C:\/repo\/main/);
  assert.doesNotMatch(result.text, /checks:|repairs|files:/);
});

test("view stores and reports the composer view", async () => {
  const { operator, calls } = harness();
  const result = await operator.run("view child");
  assert.equal(result.ok, true);
  assert.deepEqual(calls, ["view:child"]);
  assert.match(result.text, /View: auto/);
});

test("help names the run-record verbs and never mentions acceptance", async () => {
  const { operator } = harness();
  const result = await operator.run("help");
  assert.match(result.text, /orchestrator_start/);
  assert.match(result.text, /inspect \[rowRef\]/);
  assert.doesNotMatch(result.text, /accepted|frozen/i);
});

test("input routing forwards, queues and refuses around the live child", () => {
  assert.deepEqual(orchestratorInputDecision("/status", { childPhase: "running", hasRun: true }), {
    action: "allow",
  });
  assert.deepEqual(orchestratorInputDecision("keep going", { childPhase: "running", hasRun: true }), {
    action: "forward",
  });
  assert.deepEqual(orchestratorInputDecision("keep going", { childPhase: "paused", hasRun: true }), {
    action: "queue",
  });
  const idle = orchestratorInputDecision("keep going", { childPhase: "idle", hasRun: true });
  assert.equal(idle.action, "refuse");
  assert.match(idle.action === "refuse" ? idle.notice : "", /orchestrator retry/);
  assert.deepEqual(orchestratorInputDecision("start", { childPhase: undefined, hasRun: false }), {
    action: "allow",
  });
});
