/**
 * Named regressions for the legacy-engine sweep.
 *
 * Each test names the behaviour that replaced the removed engine:
 *   (b) reload: a `running` record restores as `interrupted`, retry dispatches;
 *   (c) no auto-accept: a child report never completes a row on its own;
 *   (e) approve → build: the plan is a plain kickoff and the list stays mutable.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createOrchestratorRun,
  markRunInterrupted,
  recordDispatch,
  recordReport,
  restoreOrchestratorRun,
} from "./orchestrator-run.ts";
import { createParentToolRuntime } from "./orchestrator-tool-runtime.ts";
import { createTodoStore } from "./todo-service.ts";

test("regression (b) reload: a running record restores as interrupted and retry dispatches", async () => {
  const created = createOrchestratorRun({
    title: "reload",
    steps: ["one", "two"],
    now: 1,
  });
  const running = recordDispatch(created, {
    rowRef: "1",
    instruction: "Do the first row.",
  });
  const restored = restoreOrchestratorRun(JSON.parse(JSON.stringify(running)));
  assert.equal(restored?.phase, "running");
  assert.ok(restored);
  const interrupted = markRunInterrupted(restored, {
    reason: "the in-process child did not survive the reload",
  });
  assert.equal(interrupted.phase, "interrupted");

  let dispatched: { rowRef?: string; instructions: string } | undefined;
  const runtime = createParentToolRuntime({
    run: () => interrupted,
    statusText: () => "interrupted",
    dispatch: async (input) => {
      dispatched = input;
      return { ok: true, text: "dispatched", details: {} };
    },
    start: async () => ({ ok: true, text: "started", details: {} }),
  });
  const result = await runtime.call("orchestrator_retry", {});
  assert.equal(result.ok, true);
  assert.deepEqual(dispatched, {
    rowRef: "1",
    instructions: "Do the first row.",
  });
});

test("regression (c) no auto-accept: a child report leaves the row incomplete", () => {
  const store = createTodoStore();
  store.replace([
    {
      step: 1,
      text: "one",
      completed: false,
      status: "pending",
      ref: "1",
      label: "1",
      source: "plan",
    },
    {
      step: 2,
      text: "two",
      completed: false,
      status: "pending",
      ref: "2",
      label: "2",
      source: "plan",
    },
  ]);
  const created = createOrchestratorRun({
    title: "accept",
    steps: ["one", "two"],
    now: 1,
  });
  const dispatched = recordDispatch(created, {
    rowRef: "1",
    instruction: "Do one.",
  });
  const reported = recordReport(dispatched, {
    rowRef: "1",
    report: "Done. Tests pass.",
  });
  assert.equal(reported.phase, "idle");
  assert.equal(reported.rows[0]?.lastReport, "Done. Tests pass.");
  assert.equal(
    store.items[0]?.completed,
    false,
    "a report is not acceptance; only workflow_todo completes a row",
  );

  store.setStatus("1", "completed");
  assert.equal(store.items[0]?.completed, true);
  assert.equal(store.items[1]?.completed, false);
});

test("regression (e) approve → build: a plain kickoff, no freeze, rows stay mutable", () => {
  const store = createTodoStore();
  // The freeze/merge surface is gone: the plan is context, not a compiled list.
  assert.equal("freeze" in store, false);
  assert.equal("mergeExtracted" in store, false);
  assert.equal("loadFromPlanMarkdown" in store, false);

  const added = store.add({ text: "first row from the model" });
  assert.equal(added.duplicate, false);
  store.update([{ text: "rewritten row" }, { text: "a second row" }]);
  assert.deepEqual(
    store.items.map((item) => item.text),
    ["rewritten row", "a second row"],
  );
});
