/**
 * Parent tool adapter tests.
 *
 * These pin the thin layer between the four descriptors and the extension
 * services: input normalization, the stored-instruction retry, and the
 * eligibility refusals. No SDK or terminal is involved.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  TOOL_ADAPTER_SCHEMA_VERSION,
  createParentToolRuntime,
  type ParentToolPorts,
} from "./orchestrator-tool-runtime.ts";
import {
  createOrchestratorRun,
  recordDispatch,
  type OrchestratorRun,
} from "./orchestrator-run.ts";

function boundRun(): OrchestratorRun {
  const created = createOrchestratorRun({
    title: "tools",
    steps: ["first", "second"],
    now: 1,
  });
  const dispatched = recordDispatch(created, {
    rowRef: "1",
    instruction: "Do the first thing, then report.",
  });
  void dispatched;
  return created;
}

function harness(overrides: Partial<ParentToolPorts> = {}) {
  const calls: Record<string, unknown> = {};
  const run = boundRun();
  const ports: ParentToolPorts = {
    run: () => run,
    statusText: () => "run idle",
    dispatch: async (input) => {
      calls.dispatch = input;
      return { ok: true, text: `dispatched ${input.rowRef ?? "?"}`, details: {} };
    },
    start: async (input) => {
      calls.start = input;
      return { ok: true, text: "started", details: { rows: input.steps?.length ?? 0 } };
    },
    ...overrides,
  };
  return { runtime: createParentToolRuntime(ports), calls, run };
}

test("the adapter schema version tracks the changed surface", () => {
  assert.equal(TOOL_ADAPTER_SCHEMA_VERSION, 4);
});

test("start forwards the step union and workspace declarations", async () => {
  const { runtime, calls } = harness();
  const result = await runtime.call("orchestrator_start", {
    title: "Two repos",
    planPath: ".pi/plans/x.md",
    steps: ["Root step", { text: "Other step", workspace: "B" }, "  "],
    workspaces: [{ id: "B", path: "C:/repo/other" }, { path: "./" }, { path: " " }],
  });
  assert.equal(result.ok, true);
  assert.deepEqual(calls.start, {
    title: "Two repos",
    planPath: ".pi/plans/x.md",
    steps: ["Root step", { text: "Other step", workspace: "B" }],
    workspaces: [{ id: "B", path: "C:/repo/other" }, { path: "./" }],
  });
});

test("start is refused when starting is unavailable", async () => {
  const { runtime, calls } = harness({ startEligible: () => "enter Orchestrator mode first" });
  const result = await runtime.call("orchestrator_start", { steps: ["one"] });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.text, /enter Orchestrator mode first/);
  assert.equal(calls.start, undefined);
});

test("status reads the run record text and needs no child", async () => {
  const { runtime } = harness({ statusText: () => "run idle · 0/2 rows done" });
  const result = await runtime.call("orchestrator_status", {});
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.match(result.text, /0\/2 rows done/);
  assert.deepEqual(result.details, {});
});

test("status is refused when this session may not orchestrate", async () => {
  const { runtime } = harness({ eligible: () => "Orchestration tools are available in Orchestrator mode only." });
  const result = await runtime.call("orchestrator_status", {});
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.text, /Orchestrator mode only/);
});

test("dispatch requires instructions and forwards them with the row", async () => {
  const { runtime, calls } = harness();
  const missing = await runtime.call("orchestrator_dispatch", {});
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.code, "invalid");

  const result = await runtime.call("orchestrator_dispatch", {
    rowRef: "2",
    instructions: "Implement row two.",
    cwd: "B",
  });
  assert.equal(result.ok, true);
  assert.deepEqual(calls.dispatch, {
    rowRef: "2",
    instructions: "Implement row two.",
    cwd: "B",
  });
});

test("retry re-dispatches the current row with its stored instruction", async () => {
  const run = recordDispatch(boundRun(), {
    rowRef: "1",
    instruction: "Stored instruction for row one.",
  });
  const { runtime, calls } = harness({ run: () => run });
  const result = await runtime.call("orchestrator_retry", {});
  assert.equal(result.ok, true);
  assert.deepEqual(calls.dispatch, {
    rowRef: "1",
    instructions: "Stored instruction for row one.",
  });
});

test("retry of a named row falls back to the row text when no instruction is stored", async () => {
  const { runtime, calls } = harness();
  const result = await runtime.call("orchestrator_retry", { rowRef: "2" });
  assert.equal(result.ok, true);
  assert.deepEqual(calls.dispatch, { rowRef: "2", instructions: "second" });
});

test("retry accepts the legacy task-<ref> form and an explicit instruction", async () => {
  const { runtime, calls } = harness();
  const result = await runtime.call("orchestrator_retry", {
    taskId: "task-2",
    instructions: "Amended instruction.",
  });
  assert.equal(result.ok, true);
  assert.deepEqual(calls.dispatch, { rowRef: "2", instructions: "Amended instruction." });
});

test("abort requires a reason, forwards it and accepts the truthful idle result", async () => {
  const calls: Array<{ reason: string }> = [];
  const { runtime } = harness({
    abort: async (input) => {
      calls.push(input);
      return { ok: true as const, text: `aborted: ${input.reason}` };
    },
  });

  const missing = await runtime.call("orchestrator_abort", {});
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.code, "invalid");
  assert.equal(calls.length, 0, "a missing reason never reaches the child");

  const result = await runtime.call("orchestrator_abort", {
    reason: "  the child is stuck in a retry loop  ",
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.match(result.text, /the child is stuck in a retry loop/);
  assert.deepEqual(calls, [{ reason: "the child is stuck in a retry loop" }]);
});

test("abort without a bound dispatcher is a clean refusal", async () => {
  const { runtime } = harness();
  const result = await runtime.call("orchestrator_abort", { reason: "stuck" });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, "unavailable");
    assert.match(result.text, /nothing was stopped/);
  }
});

test("retry forwards an amended instruction so the parent can loop back", async () => {
  const run = recordDispatch(boundRun(), {
    rowRef: "1",
    instruction: "Stored instruction for row one.",
  });
  const { runtime, calls } = harness({ run: () => run });
  const result = await runtime.call("orchestrator_retry", {
    rowRef: "1",
    instructions: "The test at src/a.test.ts still fails; fix it and rerun.",
  });
  assert.equal(result.ok, true);
  assert.deepEqual(calls.dispatch, {
    rowRef: "1",
    instructions: "The test at src/a.test.ts still fails; fix it and rerun.",
  });
});

test("registration exposes exactly the five descriptors", () => {
  const { runtime } = harness();
  const registered: string[] = [];
  const outcome = runtime.register({
    registerTool: (definition) => {
      registered.push(definition.name);
      assert.equal(definition.parameters.type, "object");
    },
  });
  assert.deepEqual(registered, [
    "orchestrator_start",
    "orchestrator_dispatch",
    "orchestrator_status",
    "orchestrator_retry",
    "orchestrator_abort",
  ]);
  assert.deepEqual(outcome.registered, registered);
  assert.equal(outcome.refused, null);
});
