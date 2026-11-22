/**
 * Parent tool surface tests (Orchestrator simplification, steps 10/20).
 *
 * The model sees six tools; there is no propose/preview/dispatch tool, no
 * pump and no model-supplied acceptance evidence.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  ORCHESTRATOR_TOOL_NAMES,
  ORCHESTRATOR_TOOLS,
  handleOrchestratorTool,
} from "./orchestrator-tools.ts";
import { applyRunEvent, createRunState, type RunState } from "./orchestrator-state.ts";
import { createFrozenTodosFromSteps } from "./todo-snapshot.ts";

function state(): RunState {
  const frozen = createFrozenTodosFromSteps({
    title: "tools",
    steps: ["first", "second"],
    mode: "orchestrator",
    now: 1,
  });
  assert.equal(frozen.ok, true);
  if (!frozen.ok) throw new Error((frozen as { error: string }).error);
  const created = createRunState({ runId: "run-1", todos: frozen.snapshot, now: 1_000 });
  assert.equal(created.ok, true);
  if (!created.ok) throw new Error((created as { error: string }).error);
  return created.state;
}

function running(): RunState {
  const base = state();
  const started = applyRunEvent(base, {
    type: "task.start",
    runId: "run-1",
    expectedRevision: base.revision,
    now: 1_001,
    taskId: "task-1",
    attemptId: "a1",
    sessionId: "s-1",
  });
  assert.equal(started.ok, true);
  if (!started.ok) throw new Error((started as { error: string }).error);
  return started.state;
}

function candidate(): RunState {
  const base = running();
  const reported = applyRunEvent(base, {
    type: "task.report",
    runId: "run-1",
    expectedRevision: base.revision,
    now: 1_002,
    taskId: "task-1",
    reportId: "report-1",
  });
  assert.equal(reported.ok, true);
  if (!reported.ok) throw new Error((reported as { error: string }).error);
  return reported.state;
}

const ctx = (currentState: RunState, evidence?: Map<string, { taskId: string; evidenceId: string; workspaceRevision: string }>) => ({
  state: currentState,
  now: 2,
  epoch: 1,
  currentEpoch: 1,
  ...(evidence === undefined ? {} : { evidence }),
});

test("the model-facing surface is exactly the six simplified tools", () => {
  assert.deepEqual([...ORCHESTRATOR_TOOL_NAMES], [
    "orchestrator_start",
    "orchestrator_status",
    "orchestrator_verify",
    "orchestrator_repair",
    "orchestrator_accept",
    "orchestrator_retry",
  ]);
  assert.equal(ORCHESTRATOR_TOOLS.length, 6);
  assert.equal(
    ORCHESTRATOR_TOOLS.some((spec) => /propose|prepare|dispatch|preview/.test(spec.name)),
    false,
  );
});

test("status reports phase, counts and the next frozen row", () => {
  const result = handleOrchestratorTool("orchestrator_status", {}, ctx(candidate()));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.receipt.kind, "status");
  assert.match(result.receipt.summary, /ready|running/);
  assert.equal(result.receipt.counts?.total, 2);
  assert.equal(result.receipt.nextTaskId, "task-2");
  assert.equal(result.receipt.rows?.length, 2);
});

test("verify requires a reported candidate and emits the marker event", () => {
  const early = handleOrchestratorTool("orchestrator_verify", { taskId: "task-1" }, ctx(state()));
  assert.equal(early.ok, false);

  const ready = handleOrchestratorTool("orchestrator_verify", { taskId: "task-1" }, ctx(candidate()));
  assert.equal(ready.ok, true);
  if (!ready.ok) return;
  assert.equal(ready.event?.type, "task.verify");
});

test("accept refuses model-supplied evidence; runtime evidence emits the event", () => {
  const refused = handleOrchestratorTool("orchestrator_accept", { taskId: "task-1" }, ctx(candidate()));
  assert.equal(refused.ok, false);
  assert.match((refused as { error: string }).error, /runtime-owned/);

  const accepted = handleOrchestratorTool(
    "orchestrator_accept",
    { taskId: "task-1" },
    ctx(candidate(), new Map([["task-1", { taskId: "task-1", evidenceId: "evidence-1", workspaceRevision: "abc" }]])),
  );
  assert.equal(accepted.ok, true);
  if (!accepted.ok) return;
  assert.equal(accepted.event?.type, "task.accept");
});

test("repair is bounded and cannot target an accepted row", () => {
  const repair = handleOrchestratorTool(
    "orchestrator_repair",
    { taskId: "task-1", reason: "the check failed" },
    ctx(candidate()),
  );
  assert.equal(repair.ok, true);
  if (!repair.ok) return;
  assert.equal(repair.event?.type, "task.needsFix");
});

test("retry only applies to a blocked or repaired row", () => {
  const idle = handleOrchestratorTool("orchestrator_retry", {}, ctx(candidate()));
  assert.equal(idle.ok, false);
});

test("start is handled by the extension service, never the pure tool layer", () => {
  const result = handleOrchestratorTool("orchestrator_start", {}, ctx(state()));
  assert.equal(result.ok, false);
});
