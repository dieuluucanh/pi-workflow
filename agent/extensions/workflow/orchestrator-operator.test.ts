/**
 * Operator dispatcher tests (schema-driven `/orchestrator` verbs).
 *
 * The operator parses once with `parseOrchestratorInvocation` and dispatches:
 * help/mode-entry → start → view → no-run guard → verb switch. It never
 * journals an event, compiles a plan or dispatches by itself: retry/resume and
 * start/abort delegate to injected ports.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_SAY_CHARS,
  parseOrchestratorInvocation,
} from "./orchestrator-command.ts";
import {
  OPERATOR_SCHEMA_VERSION,
  createOperatorRuntime,
  orchestratorInputDecision,
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
    mode: () => "orchestrator",
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
    start: async (path) => {
      calls.push(`start:${path}`);
      return { ok: true, text: `Plan ${path || "(bare)"} recorded.` };
    },
    abort: async (reason) => {
      calls.push(`abort:${reason}`);
      return { ok: true, text: "Child aborted. The row is retryable.", aborted: true };
    },
    stopChild: async () => {
      calls.push("stopChild");
    },
    deliver: async (text) => {
      calls.push(`deliver:${text}`);
      return { ok: true };
    },
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

test("the operator schema version tracks the schema-driven grammar", () => {
  assert.equal(OPERATOR_SCHEMA_VERSION, 4);
});

test("parse: bare is mode entry, extras and unknown verbs are errors", () => {
  assert.deepEqual(parseOrchestratorInvocation(""), { kind: "mode-entry" });
  const extra = parseOrchestratorInvocation("status now");
  assert.equal(extra.kind, "error");
  const unknown = parseOrchestratorInvocation("nonsense");
  assert.equal(unknown.kind, "error");
  assert.match(unknown.kind === "error" ? unknown.text : "", /Unknown Orchestrator verb "nonsense"/);
});

test("cancel is an unknown verb that points at stop, with no aliases", async () => {
  assert.equal(parseOrchestratorInvocation("cancel").kind, "error");
  const cancelled = parseOrchestratorInvocation("cancel");
  assert.match(cancelled.kind === "error" ? cancelled.text : "", /cancel/);
  assert.match(cancelled.kind === "error" ? cancelled.text : "", /stop/);

  const { operator, calls } = harness();
  const result = await operator.run("cancel");
  assert.equal(result.ok, false);
  assert.match(result.text, /is now "?stop"?|use "?stop"?/i);
  assert.deepEqual(calls, [], "cancel must not stop the run");
});

test("bare invocation and help return the verb table without effects", async () => {
  const { operator, calls } = harness();
  const bare = await operator.run("");
  assert.equal(bare.ok, true);
  const help = await operator.run("help");
  assert.equal(help.ok, true);
  assert.deepEqual(calls, []);
  for (const verb of ["start", "status", "inspect", "pause", "resume", "abort", "retry", "stop", "say", "view", "help"]) {
    assert.match(help.text, new RegExp(`/orchestrator ${verb}\\b`));
  }
  assert.doesNotMatch(help.text, /orchestrator-pause|orchestrator-resume|orchestrator-abort|orchestrator-view/);
  assert.doesNotMatch(help.text, /Aliases:/);
  assert.match(help.text, /`cancel` was removed: use `stop`/);
});

test("status reports the run record, TODO completion and the next row", async () => {
  const { operator } = harness();
  const result = await operator.run("status");
  assert.equal(result.ok, true);
  assert.match(result.text, /run-.*· idle/);
  assert.match(result.text, /plan \.pi\/plans\/x\.md/);
  assert.match(result.text, /1\/2 rows done · next 2/);
  assert.match(result.text, /W=C:\/repo\/main \(primary\)/);
  assert.match(result.text, /report \(row 2\):/);
  assert.match(result.text, /Blocked on a missing token\./);
  assert.match(result.text, /next row: 2/);
  assert.doesNotMatch(result.text, /accepted/i);
});

test("status without a run still succeeds and explains how to bind one", async () => {
  const { operator } = harness({ run: () => undefined });
  const result = await operator.run("status");
  assert.equal(result.ok, true);
  assert.match(result.text, /No Orchestrator run is bound yet/);
  assert.match(result.text, /Nothing was launched\./);
  assert.match(result.text, /\/orchestrator start <path>/);
});

test("a run-required verb without a run fails with the same guidance", async () => {
  const { operator, calls } = harness({ run: () => undefined });
  const result = await operator.run("pause");
  assert.equal(result.ok, false);
  assert.match(result.text, /No Orchestrator run is bound yet/);
  assert.deepEqual(calls, [], "no effect runs without a bound run");
});

test("start calls the start port with the parsed path, and bare start with empty", async () => {
  const { operator, calls } = harness({ run: () => undefined });
  const started = await operator.run("start .pi/plans/x.md");
  assert.equal(started.ok, true);
  assert.deepEqual(calls, ["start:.pi/plans/x.md"]);
  assert.match(started.text, /recorded/);

  const bare = harness({ run: () => undefined });
  assert.equal((await bare.operator.run("start")).ok, true);
  assert.deepEqual(bare.calls, ["start:"]);
});

test("start refuses an already-bound run before touching the start port", async () => {
  const { operator, calls } = harness();
  const result = await operator.run("start");
  assert.equal(result.ok, false);
  assert.match(result.text, /A run is already bound/);
  assert.match(result.text, /\/orchestrator status/);
  assert.deepEqual(calls, []);
});

test("start in another mode names /orchestrator instead of switching", async () => {
  const { operator, calls } = harness({
    mode: () => "build",
    run: () => undefined,
  });
  const result = await operator.run("start .pi/plans/x.md");
  assert.equal(result.ok, false);
  assert.match(result.text, /Orchestrator mode only/);
  assert.match(result.text, /\/orchestrator/);
  assert.deepEqual(calls, []);
});

test("a wired mode port refuses mode-required verbs outside Orchestrator mode", async () => {
  const { operator, calls } = harness({ mode: () => "plan" });
  const result = await operator.run("pause");
  assert.equal(result.ok, false);
  assert.match(result.text, /Orchestrator mode only/);
  assert.deepEqual(calls, []);

  // status/inspect/view need no mode.
  assert.equal((await operator.run("status")).ok, true);
  assert.equal((await operator.run("view")).ok, true);
  assert.equal((await operator.run("inspect 2")).ok, true);
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

test("a settled child is not resumable; resume starts a fresh child", async () => {
  const { operator, calls } = harness({
    child: () => ({ phase: "settling", todos: [] }),
  });
  const result = await operator.run("resume");
  assert.equal(result.ok, true);
  assert.deepEqual(calls, ["retry:2"], "settling is not a warm paused child");
  assert.match(result.text, /Fresh child started for row 2/);
});

test("abort delegates to the abort port and pauses only when it aborted", async () => {
  const aborted = harness();
  const result = await aborted.operator.run("abort");
  assert.equal(result.ok, true);
  assert.deepEqual(aborted.calls, ["abort:user abort", "phase:paused"]);
  assert.match(result.text, /retryable/);

  const noop = harness({
    abort: async () => {
      return { ok: true, text: "No live Build child to abort.", aborted: false };
    },
  });
  const noopResult = await noop.operator.run("abort");
  assert.equal(noopResult.ok, true);
  assert.deepEqual(noop.calls, [], "an idempotent no-op never records a phase");
  assert.match(noopResult.text, /No live Build child/);
});

test("abort without a child refuses and never calls the port", async () => {
  const { operator, calls } = harness({ child: () => undefined });
  const result = await operator.run("abort");
  assert.equal(result.ok, false);
  assert.equal(result.text, "No Orchestrator child is active.");
  assert.deepEqual(calls, []);
});

test("stop is the only cancel", async () => {
  const stopped = harness();
  assert.equal((await stopped.operator.run("stop")).ok, true);
  assert.deepEqual(stopped.calls, ["stopChild", "phase:cancelled"]);

  const cancelled = harness();
  assert.equal((await cancelled.operator.run("cancel")).ok, false);
  assert.deepEqual(cancelled.calls, []);
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
  const delivered = harness();
  const result = await delivered.operator.run("say continue");
  assert.equal(result.ok, true);
  assert.match(result.text, /Message delivered to the child: continue/);
  assert.deepEqual(delivered.calls, ["deliver:continue"]);

  const calls: string[] = [];
  const queued = harness({
    deliver: async (text) => {
      calls.push(`deliver:${text}`);
      return { ok: true, queued: true };
    },
  });
  const queuedResult = await queued.operator.run("say hold on");
  assert.equal(queuedResult.ok, true);
  assert.match(queuedResult.text, /queued for the paused child/);
  assert.deepEqual(calls, ["deliver:hold on"]);

  const none = harness({ child: () => undefined });
  assert.equal((await none.operator.run("say hi")).ok, false);
  assert.deepEqual(none.calls, []);
});

test("over-length say fails and delivers nothing; the text is never sliced", async () => {
  const { operator, calls } = harness();
  const over = await operator.run(`say ${"x".repeat(MAX_SAY_CHARS + 1)}`);
  assert.equal(over.ok, false);
  assert.match(over.text, /limit is 2000/);
  assert.match(over.text, /Nothing was delivered/);
  assert.deepEqual(calls, [], "no delivery for an over-length message");

  const exact = harness();
  assert.equal((await exact.operator.run(`say ${"y".repeat(MAX_SAY_CHARS)}`)).ok, true);
  assert.equal(exact.calls.length, 1);
  assert.equal(exact.calls[0], `deliver:${"y".repeat(MAX_SAY_CHARS)}`);
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

test("view stores and reports the composer view before the run guard", async () => {
  const { operator, calls } = harness({ run: () => undefined, child: () => undefined });
  const result = await operator.run("view child");
  assert.equal(result.ok, true);
  assert.deepEqual(calls, ["view:child"]);
  assert.match(result.text, /View: auto/);
  assert.match(result.text, /No child is active\./);

  const bad = harness();
  const refused = await bad.operator.run("view sideways");
  assert.equal(refused.ok, false);
  assert.match(refused.text, /Unknown view "sideways"/);
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
  if (idle.action !== "refuse") return;
  assert.match(idle.notice, /orchestrator retry/);
  assert.match(idle.notice, /[Rr]esume only continues a paused warm child/);
  assert.match(idle.action === "refuse" ? idle.notice : "", /orchestrator retry/);
  assert.deepEqual(orchestratorInputDecision("start", { childPhase: undefined, hasRun: false }), {
    action: "allow",
  });
});
