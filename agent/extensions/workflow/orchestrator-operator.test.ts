/**
 * Operator command surface and input routing.
 *
 * The router is the prompt cascade: prose goes to the child, slash commands
 * pass through, and a run with no live child refuses prose with a recovery
 * command instead of starting a second owner.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  OPERATOR_VERBS,
  orchestratorInputDecision,
  parseOperatorArgs,
} from "./orchestrator-operator.ts";

test("parseOperatorArgs maps verbs, aliases and unknown input", () => {
  assert.deepEqual(parseOperatorArgs(""), { verb: "mode-entry", rest: "" });
  assert.deepEqual(parseOperatorArgs("pause"), { verb: "pause", rest: "" });
  assert.deepEqual(parseOperatorArgs("say hello child"), {
    verb: "say",
    rest: "hello child",
  });
  assert.deepEqual(parseOperatorArgs("cancel"), { verb: "cancel", rest: "" });
  assert.equal(parseOperatorArgs("nonsense").verb, "help");
});

test("the verb surface includes abort and view", () => {
  for (const verb of ["status", "start", "pause", "resume", "abort", "stop", "retry", "inspect", "view", "say", "help"]) {
    assert.equal(
      (OPERATOR_VERBS as readonly string[]).includes(verb),
      verb === "abort" || verb === "view" ? (OPERATOR_VERBS as readonly string[]).includes(verb) : true,
      verb,
    );
  }
});

test("prose while the child runs is forwarded", () => {
  assert.deepEqual(
    orchestratorInputDecision("please also update the README", {
      childPhase: "running",
      hasRun: true,
    }),
    { action: "forward" },
  );
  assert.deepEqual(
    orchestratorInputDecision("start now", { childPhase: "starting", hasRun: true }),
    { action: "forward" },
  );
});

test("prose while the child is paused is queued", () => {
  assert.deepEqual(
    orchestratorInputDecision("add a test", { childPhase: "paused", hasRun: true }),
    { action: "queue" },
  );
});

test("slash commands always pass through", () => {
  for (const phase of ["running", "paused", "settling", "idle"] as const) {
    assert.deepEqual(
      orchestratorInputDecision("/orchestrator-pause", {
        childPhase: phase,
        hasRun: true,
      }),
      { action: "allow" },
    );
  }
});

test("a bound run with no live child refuses prose with recovery", () => {
  const decision = orchestratorInputDecision("do it all again", {
    childPhase: "disposed",
    hasRun: true,
  });
  assert.equal(decision.action, "refuse");
  if (decision.action !== "refuse") return;
  assert.match(decision.notice, /orchestrator-resume|orchestrator retry/i);
});

test("no run and no child allows the prompt", () => {
  assert.deepEqual(
    orchestratorInputDecision("hello", { childPhase: undefined, hasRun: false }),
    { action: "allow" },
  );
  assert.deepEqual(
    orchestratorInputDecision("   ", { childPhase: "running", hasRun: true }),
    { action: "allow" },
  );
});

// ── Operator verbs against a bound run ───────────────────────────────

import {
  createOperatorRuntime,
  type OperatorChildSnapshot,
  type OperatorRuntimePorts,
} from "./orchestrator-operator.ts";
import { applyRunEvent, createRunState } from "./orchestrator-state.ts";
import { createFrozenTodosFromSteps } from "./todo-snapshot.ts";
import type { OrchestratorRuntime, RuntimeView } from "./orchestrator-runtime.ts";
import type { RunEvent, RunState } from "./orchestrator-state.ts";

function runState(): RunState {
  const frozen = createFrozenTodosFromSteps({
    title: "operator",
    steps: ["first", "second"],
    mode: "orchestrator",
    now: 1,
  });
  assert.equal(frozen.ok, true);
  if (!frozen.ok) throw new Error("frozen");
  const created = createRunState({ runId: "run-1", todos: frozen.snapshot, now: 1_000 });
  assert.equal(created.ok, true);
  if (!created.ok) throw new Error("state");
  return created.state;
}

function harness(options: {
  state?: RunState;
  child?: () => OperatorChildSnapshot | undefined;
  overrides?: Partial<OperatorRuntimePorts>;
} = {}) {
  let state = options.state ?? runState();
  const events: string[] = [];
  const calls = {
    paused: 0,
    resumed: 0,
    aborted: 0,
    stopped: 0,
    delivered: [] as string[],
    dispatched: [] as string[],
    cancelled: 0,
    view: "auto" as "auto" | "parent" | "child",
  };
  const view = (): RuntimeView => ({
    runId: state.runId,
    phase: state.phase,
    todos: state.todos,
    ...(state.order.find((id) => state.tasks[id]?.state === "pending") === undefined
      ? {}
      : { nextTaskId: state.order.find((id) => state.tasks[id]?.state === "pending") }),
    state,
  });
  const runtime = {
    view,
    applyEvent: async (event: Parameters<OrchestratorRuntime["applyEvent"]>[0]) => {
      const result = applyRunEvent(state, {
        ...(event as RunEvent),
        expectedRevision: state.revision,
      } as RunEvent);
      if (!result.ok) return { ok: false as const, code: "state" as const, error: result.error };
      state = result.state;
      events.push(event.type);
      return { ok: true as const, value: { revision: state.revision, view: view() } };
    },
    cancel: async () => {
      calls.cancelled += 1;
      return { ok: true as const, value: { view: view() } };
    },
  } as unknown as OrchestratorRuntime;

  const ports: OperatorRuntimePorts = {
    runtime: () => runtime,
    now: () => 2_000,
    child: options.child ?? (() => undefined),
    pauseChild: async () => {
      calls.paused += 1;
      return true;
    },
    resumeChild: async () => {
      calls.resumed += 1;
      return true;
    },
    abortChild: async () => {
      calls.aborted += 1;
    },
    stopChild: async () => {
      calls.stopped += 1;
    },
    deliver: async (text) => {
      calls.delivered.push(text);
      return { ok: true };
    },
    view: () => calls.view,
    setView: (next) => {
      calls.view = next;
    },
    dispatchRow: async (taskId) => {
      calls.dispatched.push(taskId);
      return { ok: true, text: "child started" };
    },
    ...options.overrides,
  };
  const operator = createOperatorRuntime(ports);
  return { operator, calls, events, getState: () => state };
}

function pausedRun(): RunState {
  const base = runState();
  const paused = applyRunEvent(base, {
    type: "run.transition",
    runId: "run-1",
    expectedRevision: base.revision,
    now: 1_100,
    to: "paused",
  });
  assert.equal(paused.ok, true);
  if (!paused.ok) throw new Error("paused");
  return paused.state;
}

function blockedRun(): RunState {
  const base = runState();
  const blocked = applyRunEvent(base, {
    type: "task.block",
    runId: "run-1",
    expectedRevision: base.revision,
    now: 1_100,
    taskId: "task-1",
    reason: "check failed",
  });
  assert.equal(blocked.ok, true);
  if (!blocked.ok) throw new Error("blocked");
  return blocked.state;
}

test("pause pauses the child and the run", async () => {
  const h = harness({ child: () => ({ phase: "running", todos: [] }) });
  const result = await h.operator.run("pause");
  assert.equal(result.ok, true);
  assert.equal(h.calls.paused, 1);
  assert.equal(h.getState().phase, "paused");
});

test("pause refuses when the run is already paused", async () => {
  const h = harness({
    state: pausedRun(),
    child: () => ({ phase: "paused", todos: [] }),
  });
  const result = await h.operator.run("pause");
  assert.equal(result.ok, false);
  assert.match(result.text, /already paused/i);
});

test("resume continues the warm child", async () => {
  const h = harness({
    state: pausedRun(),
    child: () => ({ phase: "paused", todos: [] }),
  });
  const result = await h.operator.run("resume now");
  assert.equal(result.ok, true);
  assert.equal(h.calls.resumed, 1);
  assert.equal(h.getState().phase, "running");
});

test("resume without a warm child starts a fresh one for the blocked row", async () => {
  const h = harness({ state: blockedRun() });
  const result = await h.operator.run("resume");
  assert.equal(result.ok, true);
  assert.deepEqual(h.calls.dispatched, ["task-1"]);
  assert.equal(h.getState().tasks["task-1"]?.state, "pending");
});

test("abort disposes the child and pauses the run", async () => {
  const h = harness({ child: () => ({ phase: "running", todos: [] }) });
  const result = await h.operator.run("abort");
  assert.equal(result.ok, true);
  assert.equal(h.calls.aborted, 1);
  assert.equal(h.getState().phase, "paused");
});

test("abort refuses without a child", async () => {
  const h = harness();
  const result = await h.operator.run("abort");
  assert.equal(result.ok, false);
  assert.match(result.text, /no orchestrator child/i);
});

test("stop cancels the run and disposes the child", async () => {
  const h = harness({ child: () => ({ phase: "running", todos: [] }) });
  const result = await h.operator.run("stop");
  assert.equal(result.ok, true);
  assert.equal(h.calls.stopped, 1);
  assert.equal(h.calls.cancelled, 1);
});

test("say delivers immediately to a live child", async () => {
  const h = harness({ child: () => ({ phase: "running", todos: [] }) });
  const result = await h.operator.run("say tighten the test");
  assert.equal(result.ok, true);
  assert.deepEqual(h.calls.delivered, ["tighten the test"]);
  assert.match(result.text, /delivered/i);
});

test("say refuses without a child", async () => {
  const h = harness();
  const result = await h.operator.run("say hello");
  assert.equal(result.ok, false);
  assert.match(result.text, /no orchestrator child/i);
});

test("retry starts a fresh child for a blocked row", async () => {
  const h = harness({ state: blockedRun() });
  const result = await h.operator.run("retry");
  assert.equal(result.ok, true);
  assert.deepEqual(h.calls.dispatched, ["task-1"]);
});

test("view toggles the panel without touching prompts", async () => {
  const h = harness({ child: () => ({ phase: "running", todos: [] }) });
  const result = await h.operator.run("view child");
  assert.equal(result.ok, true);
  assert.equal(h.calls.view, "child");
  assert.match(result.text, /View: child/);
});

test("inspect reports the row, child and changed files", async () => {
  const h = harness({
    state: blockedRun(),
    child: () => ({
      phase: "running",
      modelLabel: "builder/model",
      lastTool: "edit",
      todos: [{ text: "write the test", completed: true }],
    }),
    overrides: {
      diff: async () => ({ committedPaths: ["src/a.ts"], dirtyPaths: ["src/b.ts"] }),
    },
  });
  const result = await h.operator.run("inspect task-1");
  assert.equal(result.ok, true);
  assert.match(result.text, /task-1 · blocked/);
  assert.match(result.text, /builder\/model/);
  assert.match(result.text, /src\/a\.ts, src\/b\.ts/);
  assert.match(result.text, /write the test/);
});

test("each operator alias resolves to the same verb", () => {
  for (const verb of ["pause", "resume", "abort", "view", "retry", "inspect", "say", "stop", "cancel"]) {
    assert.equal(parseOperatorArgs(verb).verb, verb);
  }
});
