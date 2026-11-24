/**
 * Durable plan-check amendments (Phase A of the plan-execution contract).
 *
 * The live 2026-11-21 run cannot be repaired by editing its journal, so the
 * only legal fix is an append-only `run.control` amendment. These tests pin
 * that contract: one event, deterministic id, validated next list, untouched
 * revision fence, preserved accepted rows, idempotent repeat and a restore that
 * applies amendments in order and fails closed naming the sequence.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  CHECK_SPEC_REPAIR_ACTION,
  applyCheckSpecRepair,
  buildCheckSpecRepair,
  checkSpecRepairEventId,
  checkSpecsOf,
  normalizeCheckSpecs,
} from "./orchestrator-check-repair.ts";
import {
  createOrchestratorRuntime,
  type OrchestratorRuntime,
  type OrchestratorRuntimePorts,
} from "./orchestrator-runtime.ts";
import {
  createRunJournal,
  type JournalEvent,
  type JournalIo,
  type RunJournal,
} from "./orchestrator-store.ts";
import type { FrozenTodoSnapshot } from "./todo-snapshot.ts";

const PLAN = [
  "# Plan: Durable amendment",
  "",
  "## Plan Steps",
  "",
  "1. First step",
  "2. Second step",
  "",
  "## Verification",
  "",
  "```bash",
  "pnpm typecheck",
  "```",
].join("\n");

const INCIDENT_PLAN_CHECKS = [
  "pnpm dev:preflight`, followed by controlled `npm run dev` smoke",
  "pnpm dev:preflight`, followed by controlled `npm run dev`",
];

function memoryIo(): JournalIo {
  const files = new Map<string, string>();
  let locked = false;
  return {
    async read(path) {
      return files.get(path) ?? null;
    },
    async writeAtomic(path, data) {
      files.set(path, data);
    },
    async append(path, data) {
      files.set(path, (files.get(path) ?? "") + data);
    },
    async list(dir) {
      return [...files.keys()].filter((key) => key.startsWith(dir));
    },
    async mkdir() {},
    async remove(path) {
      files.delete(path);
    },
    async acquireLock() {
      if (locked) return false;
      locked = true;
      return true;
    },
    async releaseLock() {
      locked = false;
    },
  };
}

function harness(): {
  io: JournalIo;
  journalFor(runId: string): RunJournal;
  runtime(): OrchestratorRuntime;
} {
  const io = memoryIo();
  let tick = 1_000;
  const journalFor = (runId: string) =>
    createRunJournal({ dir: `C:/runs/${runId}`, runId, io });
  const ports: OrchestratorRuntimePorts = {
    createJournal: (runId) => journalFor(runId),
    now: () => (tick += 1),
  };
  return { io, journalFor, runtime: () => createOrchestratorRuntime(ports) };
}

async function startRun(runtime: OrchestratorRuntime): Promise<{
  runId: string;
  frozen: FrozenTodoSnapshot;
}> {
  const started = await runtime.startFromPlan({
    planPath: "/tmp/plan.md",
    planText: PLAN,
  });
  assert.equal(started.ok, true, started.ok ? "" : started.error);
  if (!started.ok) throw new Error("unreachable");
  return { runId: started.value.runId, frozen: started.value.frozen };
}

async function acceptRow(
  runtime: OrchestratorRuntime,
  runId: string,
  ref: string,
): Promise<void> {
  const taskId = `task-${ref}`;
  const events = [
    { type: "task.start", taskId, attemptId: `attempt-${ref}`, sessionId: `session-${ref}` },
    { type: "task.report", taskId },
    { type: "task.verify", taskId },
    { type: "task.accept", taskId, evidenceId: `evidence-${ref}`, workspaceRevision: "rev-1" },
  ] as const;
  for (const event of events) {
    const applied = await runtime.applyEvent({
      ...event,
      runId,
      now: 2_000,
    } as never);
    assert.equal(applied.ok, true, applied.ok ? "" : applied.error);
  }
}

async function pause(runtime: OrchestratorRuntime, runId: string): Promise<void> {
  const paused = await runtime.applyEvent({
    type: "run.transition",
    runId,
    now: 2_100,
    to: "paused",
  });
  assert.equal(paused.ok, true, paused.ok ? "" : paused.error);
}

async function eventsOf(journal: RunJournal): Promise<JournalEvent[]> {
  const loaded = await journal.load();
  assert.equal(loaded.ok, true, loaded.ok ? "" : loaded.error);
  if (!loaded.ok) throw new Error("unreachable");
  return loaded.value.events;
}

// ── Pure helpers ─────────────────────────────────────────────────────

test("normalizeCheckSpecs defaults kind gate, resolves aliases and dedupes", () => {
  const normalized = normalizeCheckSpecs(
    [
      { command: "pnpm typecheck", workspace: "w" },
      { command: "pnpm typecheck", workspace: "W" },
      { command: "pnpm lint", kind: "diagnostic", timeoutMs: 5_000 },
    ],
    [{ id: "W" } as never],
  );
  assert.equal(normalized.ok, true);
  if (!normalized.ok) return;
  assert.deepEqual(normalized.value, [
    { command: "pnpm typecheck", workspace: "W", kind: "gate" },
    { command: "pnpm lint", kind: "diagnostic" },
  ]);
});

test("the incident's malformed previous list is history, never executable", () => {
  const snapshot = {
    version: 1,
    executionId: "exec-incident",
    mode: "orchestrator",
    source: { kind: "plan", digest: "d", title: "Incident" },
    rows: [
      {
        id: "row-1",
        ref: "1",
        text: "Only step",
        source: "plan",
        acceptanceChecks: [],
        expectedFiles: [],
        status: "pending",
      },
    ],
    planChecks: [...INCIDENT_PLAN_CHECKS],
    createdAt: 1,
  } as unknown as FrozenTodoSnapshot;
  const built = buildCheckSpecRepair({
    executionId: "exec-incident",
    snapshot,
    specs: [{ command: "pnpm typecheck" }],
    reason: "replace the five malformed checks",
    source: "recovery script",
    approvedAt: 10,
  });
  assert.equal(built.ok, true, built.ok ? "" : built.error);
  if (!built.ok) return;
  assert.deepEqual(built.value.previous.planChecks, INCIDENT_PLAN_CHECKS);
  assert.deepEqual(built.value.next.planChecks, ["pnpm typecheck"]);
  assert.deepEqual(built.value.next.planCheckSpecs, [
    { command: "pnpm typecheck", kind: "gate" },
  ]);

  const applied = applyCheckSpecRepair(snapshot, built.value);
  assert.equal(applied.ok, true, applied.ok ? "" : applied.error);
  if (!applied.ok) return;
  assert.equal(applied.value.changed, true);
  assert.deepEqual(applied.value.snapshot.planChecks, ["pnpm typecheck"]);
  assert.deepEqual(applied.value.snapshot.rows, snapshot.rows);
  assert.equal(applied.value.snapshot.executionId, snapshot.executionId);
});

test("build refuses a stale previous, a wrong execution and an empty next", () => {
  const snapshot = {
    version: 1,
    executionId: "exec-1",
    mode: "orchestrator",
    source: { kind: "plan", digest: "d", title: "t" },
    rows: [
      {
        id: "row-1",
        ref: "1",
        text: "Only step",
        source: "plan",
        acceptanceChecks: [],
        expectedFiles: [],
        status: "pending",
      },
    ],
    planChecks: ["pnpm typecheck"],
    createdAt: 1,
  } as unknown as FrozenTodoSnapshot;
  const stale = buildCheckSpecRepair({
    executionId: "exec-1",
    snapshot,
    specs: [{ command: "pnpm lint" }],
    reason: "r",
    source: "s",
    approvedAt: 2,
    previous: { planChecks: ["pnpm test"], planCheckSpecs: [] },
  });
  assert.equal(stale.ok, false);
  if (!stale.ok) assert.equal(stale.code, "stale_previous");

  const wrongExecution = buildCheckSpecRepair({
    executionId: "exec-2",
    snapshot,
    specs: [{ command: "pnpm lint" }],
    reason: "r",
    source: "s",
    approvedAt: 2,
  });
  assert.equal(wrongExecution.ok, false);
  if (!wrongExecution.ok) assert.equal(wrongExecution.code, "wrong_execution");

  const empty = buildCheckSpecRepair({
    executionId: "exec-1",
    snapshot,
    specs: [],
    reason: "r",
    source: "s",
    approvedAt: 2,
  });
  assert.equal(empty.ok, false);
  if (!empty.ok) assert.equal(empty.code, "invalid_next");

  const allowedEmpty = buildCheckSpecRepair({
    executionId: "exec-1",
    snapshot,
    specs: [],
    reason: "remove every final check",
    source: "s",
    approvedAt: 2,
    allowEmpty: true,
  });
  assert.equal(allowedEmpty.ok, true, allowedEmpty.ok ? "" : allowedEmpty.error);
});

test("apply is idempotent and refuses a mismatched execution/previous", () => {
  const snapshot = {
    version: 1,
    executionId: "exec-1",
    mode: "orchestrator",
    source: { kind: "plan", digest: "d", title: "t" },
    rows: [
      {
        id: "row-1",
        ref: "1",
        text: "Only step",
        source: "plan",
        acceptanceChecks: [],
        expectedFiles: [],
        status: "pending",
      },
    ],
    planChecks: ["pnpm typecheck"],
    createdAt: 1,
  } as unknown as FrozenTodoSnapshot;
  const built = buildCheckSpecRepair({
    executionId: "exec-1",
    snapshot,
    specs: [{ command: "pnpm lint" }],
    reason: "r",
    source: "s",
    approvedAt: 2,
  });
  assert.equal(built.ok, true, built.ok ? "" : built.error);
  if (!built.ok) return;
  const first = applyCheckSpecRepair(snapshot, built.value);
  assert.equal(first.ok, true);
  if (!first.ok) return;
  const repeat = applyCheckSpecRepair(first.value.snapshot, built.value);
  assert.equal(repeat.ok, true);
  if (!repeat.ok) return;
  assert.equal(repeat.value.changed, false);

  const wrongExecution = applyCheckSpecRepair(snapshot, {
    ...built.value,
    executionId: "exec-other",
  });
  assert.equal(wrongExecution.ok, false);
  if (!wrongExecution.ok) assert.equal(wrongExecution.code, "wrong_execution");

  const stale = applyCheckSpecRepair(first.value.snapshot, {
    ...built.value,
    next: {
      planChecks: ["pnpm test"],
      planCheckSpecs: [{ command: "pnpm test", kind: "gate" }],
    },
  });
  assert.equal(stale.ok, false);
  if (!stale.ok) assert.equal(stale.code, "stale_previous");
});

test("malformed next commands never reach the frozen list", () => {
  const glitch = normalizeCheckSpecs([
    { command: "pnpm dev:preflight`, followed by `npm run dev`" },
  ]);
  assert.equal(glitch.ok, false);
  if (!glitch.ok) assert.equal(glitch.code, "invalid_next");

  const prose = normalizeCheckSpecs([{ command: "everything works" }]);
  assert.equal(prose.ok, false);
  if (!prose.ok) assert.match(prose.error, /prose is not a shell command/);
});

test("the amendment event id is deterministic for a canonical payload", () => {
  const payload = {
    action: CHECK_SPEC_REPAIR_ACTION,
    version: 1 as const,
    executionId: "exec-1",
    previous: { planChecks: ["pnpm typecheck"], planCheckSpecs: [] },
    next: {
      planChecks: ["pnpm lint"],
      planCheckSpecs: [{ command: "pnpm lint", kind: "gate" as const }],
    },
    reason: "r",
    source: "s",
    approvedAt: 2,
  };
  const first = checkSpecRepairEventId(payload);
  const second = checkSpecRepairEventId(JSON.parse(JSON.stringify(payload)));
  assert.equal(first, second);
  assert.match(first, /^repair-[a-f0-9]{32}$/);
});

// ── Runtime integration ──────────────────────────────────────────────

test("repair appends one event, preserves accepted rows and never bumps revision", async () => {
  const h = harness();
  const runtime = h.runtime();
  const { runId } = await startRun(runtime);
  await acceptRow(runtime, runId, "1");
  await pause(runtime, runId);
  const before = runtime.view();
  assert.ok(before);
  if (!before) return;
  assert.equal(before.state.tasks["task-1"]?.state, "accepted");

  const repaired = await runtime.repairCheckSpecs({
    specs: [{ command: "pnpm lint" }, { command: "pnpm typecheck" }],
    reason: "the frozen list named a script that does not exist",
    source: "unit test",
  });
  assert.equal(repaired.ok, true, repaired.ok ? "" : repaired.error);
  if (!repaired.ok) return;
  assert.equal(repaired.value.changed, true);
  assert.equal(repaired.value.duplicate, false);
  assert.equal(repaired.value.view.state.revision, before.state.revision);
  assert.equal(repaired.value.view.phase, "paused");
  assert.deepEqual(repaired.value.view.todos.planChecks, ["pnpm lint", "pnpm typecheck"]);
  assert.deepEqual(repaired.value.view.todos.planCheckSpecs, [
    { command: "pnpm lint", kind: "gate" },
    { command: "pnpm typecheck", kind: "gate" },
  ]);
  // Rows, ids, order, tasks and plan are byte-identical.
  assert.deepEqual(repaired.value.view.todos.rows, before.todos.rows);
  assert.deepEqual(repaired.value.view.state.order, before.state.order);
  assert.deepEqual(repaired.value.view.state.tasks, before.state.tasks);
  assert.deepEqual(repaired.value.view.state.tasks["task-1"]?.state, "accepted");
  assert.deepEqual(repaired.value.view.state.plan, before.state.plan);

  const events = await eventsOf(h.journalFor(runId));
  const control = events.at(-1);
  assert.equal(control?.type, "run.control");
  assert.equal(control?.eventId, repaired.value.eventId);
  assert.equal((control?.payload as { action: string }).action, CHECK_SPEC_REPAIR_ACTION);
});

test("a repeated repair is a no-op and never appends a second event", async () => {
  const h = harness();
  const runtime = h.runtime();
  const { runId } = await startRun(runtime);
  await pause(runtime, runId);
  const input = {
    specs: [{ command: "pnpm lint" }],
    reason: "repair",
    source: "unit test",
  };
  const first = await runtime.repairCheckSpecs(input);
  assert.equal(first.ok, true, first.ok ? "" : first.error);
  const count = (await eventsOf(h.journalFor(runId))).length;

  const repeat = await runtime.repairCheckSpecs(input);
  assert.equal(repeat.ok, true, repeat.ok ? "" : repeat.error);
  if (!repeat.ok) return;
  assert.equal(repeat.value.changed, false);
  assert.equal(repeat.value.duplicate, true);
  assert.equal((await eventsOf(h.journalFor(runId))).length, count);
  assert.deepEqual(repeat.value.view.todos.planChecks, ["pnpm lint"]);
});

test("repair is refused while the run is running and while a child row is live", async () => {
  const h = harness();
  const runtime = h.runtime();
  const { runId } = await startRun(runtime);
  const running = await runtime.applyEvent({
    type: "run.transition",
    runId,
    now: 1_500,
    to: "running",
  });
  assert.equal(running.ok, true);
  const refusedRunning = await runtime.repairCheckSpecs({
    specs: [{ command: "pnpm lint" }],
    reason: "r",
    source: "s",
  });
  assert.equal(refusedRunning.ok, false);
  if (!refusedRunning.ok) assert.match(refusedRunning.error, /run is running/);

  const started = await runtime.applyEvent({
    type: "task.start",
    runId,
    now: 1_600,
    taskId: "task-1",
    attemptId: "attempt-1",
    sessionId: "session-1",
  });
  assert.equal(started.ok, true, started.ok ? "" : started.error);
  await pause(runtime, runId);
  const refusedLive = await runtime.repairCheckSpecs({
    specs: [{ command: "pnpm lint" }],
    reason: "r",
    source: "s",
  });
  assert.equal(refusedLive.ok, false);
  if (!refusedLive.ok) assert.match(refusedLive.error, /live child/);
});

test("a malformed next command is refused before any journal write", async () => {
  const h = harness();
  const runtime = h.runtime();
  const { runId } = await startRun(runtime);
  await pause(runtime, runId);
  const count = (await eventsOf(h.journalFor(runId))).length;
  const refused = await runtime.repairCheckSpecs({
    specs: [{ command: "pnpm dev:preflight`, followed by `npm run dev`" }],
    reason: "r",
    source: "s",
  });
  assert.equal(refused.ok, false);
  if (!refused.ok) assert.match(refused.error, /backtick|executable command/);
  assert.equal((await eventsOf(h.journalFor(runId))).length, count);
});

test("a reload applies the amendment and the next reducer event replays", async () => {
  const h = harness();
  const runtime = h.runtime();
  const { runId } = await startRun(runtime);
  await acceptRow(runtime, runId, "1");
  await pause(runtime, runId);
  const repaired = await runtime.repairCheckSpecs({
    specs: [{ command: "pnpm lint" }, { command: "pnpm typecheck" }],
    reason: "repair",
    source: "unit test",
  });
  assert.equal(repaired.ok, true, repaired.ok ? "" : repaired.error);

  const reopened = h.runtime();
  const opened = await reopened.openRun(runId);
  assert.equal(opened.ok, true, opened.ok ? "" : opened.error);
  if (!opened.ok) return;
  assert.deepEqual(opened.value.todos.planChecks, ["pnpm lint", "pnpm typecheck"]);
  assert.equal(opened.value.state.tasks["task-1"]?.state, "accepted");
  assert.equal(opened.value.state.revision, repaired.ok ? repaired.value.view.state.revision : -1);

  // The first event after the amendment journals a revision replay reproduces.
  const next = await reopened.applyEvent({
    type: "task.start",
    runId,
    now: 3_000,
    taskId: "task-2",
    attemptId: "attempt-2",
    sessionId: "session-2",
  });
  assert.equal(next.ok, true, next.ok ? "" : next.error);
  if (!next.ok) return;

  const reloaded = h.runtime();
  const restored = await reloaded.openRun(runId);
  assert.equal(restored.ok, true, restored.ok ? "" : restored.error);
  if (!restored.ok) return;
  assert.equal(restored.value.state.revision, next.value.revision);
  assert.equal(restored.value.phase, "running");
  assert.equal(restored.value.state.tasks["task-2"]?.state, "running");
  assert.equal(restored.value.state.tasks["task-1"]?.state, "accepted");
  assert.deepEqual(restored.value.todos.planChecks, ["pnpm lint", "pnpm typecheck"]);
});

test("restore fails closed naming the sequence for a malformed amendment", async () => {
  const h = harness();
  const runtime = h.runtime();
  const { runId, frozen } = await startRun(runtime);
  await pause(runtime, runId);
  const built = buildCheckSpecRepair({
    executionId: frozen.executionId,
    snapshot: frozen,
    specs: [{ command: "pnpm lint" }],
    reason: "r",
    source: "s",
    approvedAt: 2_000,
  });
  assert.equal(built.ok, true, built.ok ? "" : built.error);
  if (!built.ok) return;
  const tampered = JSON.parse(JSON.stringify(built.value)) as {
    next: { planChecks: string[]; planCheckSpecs: { command: string }[] };
  };
  tampered.next.planChecks = ["pnpm dev:preflight`, followed by `npm run dev`"];
  tampered.next.planCheckSpecs[0]!.command = "pnpm dev:preflight`, followed by `npm run dev`";
  const appended = await h.journalFor(runId).append({
    type: "run.control",
    eventId: "repair-tampered",
    at: 2_500,
    payload: tampered,
  });
  assert.equal(appended.ok, true, appended.ok ? "" : appended.error);

  const reloaded = h.runtime();
  const restored = await reloaded.openRun(runId);
  assert.equal(restored.ok, false);
  if (!restored.ok) {
    assert.match(restored.error, /seq 4/);
    assert.match(restored.error, /backtick|executable command/);
  }
});

test("restore fails closed naming the sequence for a stale previous list", async () => {
  const h = harness();
  const runtime = h.runtime();
  const { runId, frozen } = await startRun(runtime);
  await pause(runtime, runId);
  const built = buildCheckSpecRepair({
    executionId: frozen.executionId,
    snapshot: frozen,
    specs: [{ command: "pnpm lint" }],
    reason: "r",
    source: "s",
    approvedAt: 2_000,
  });
  assert.equal(built.ok, true, built.ok ? "" : built.error);
  if (!built.ok) return;
  const stale = JSON.parse(JSON.stringify(built.value)) as { previous: unknown };
  stale.previous = { planChecks: ["pnpm test"], planCheckSpecs: [] };
  const appended = await h.journalFor(runId).append({
    type: "run.control",
    eventId: "repair-stale",
    at: 2_500,
    payload: stale,
  });
  assert.equal(appended.ok, true, appended.ok ? "" : appended.error);

  const reloaded = h.runtime();
  const restored = await reloaded.openRun(runId);
  assert.equal(restored.ok, false);
  if (!restored.ok) {
    assert.match(restored.error, /seq 4/);
    assert.match(restored.error, /stale_previous|previous checks do not match/);
  }
});

test("openRun binds an existing journal without appending and refuses an unknown run", async () => {
  const h = harness();
  const runtime = h.runtime();
  const { runId } = await startRun(runtime);
  const count = (await eventsOf(h.journalFor(runId))).length;
  const reopened = h.runtime();
  const opened = await reopened.openRun(runId);
  assert.equal(opened.ok, true, opened.ok ? "" : opened.error);
  assert.equal((await eventsOf(h.journalFor(runId))).length, count);

  const missing = h.runtime();
  const unknown = await missing.openRun("run-does-not-exist");
  assert.equal(unknown.ok, false);
  if (!unknown.ok) assert.match(unknown.error, /no run journal exists/);
});

test("a repair with an expectedSeq fence is refused when the journal moved", async () => {
  const h = harness();
  const runtime = h.runtime();
  const { runId } = await startRun(runtime);
  await pause(runtime, runId);
  const events = await eventsOf(h.journalFor(runId));
  const currentSeq = events.length;
  const refused = await runtime.repairCheckSpecs({
    specs: [{ command: "pnpm lint" }],
    reason: "r",
    source: "s",
    expectedSeq: currentSeq - 1,
  });
  assert.equal(refused.ok, false);
  if (!refused.ok) assert.match(refused.error, /stale sequence/);
  const accepted = await runtime.repairCheckSpecs({
    specs: [{ command: "pnpm lint" }],
    reason: "r",
    source: "s",
    expectedSeq: currentSeq,
  });
  assert.equal(accepted.ok, true, accepted.ok ? "" : accepted.error);
});

test("checkSpecsOf derives the legacy view for a snapshot without specs", () => {
  const snapshot = {
    version: 1,
    executionId: "exec-1",
    mode: "orchestrator",
    source: { kind: "plan", digest: "d", title: "t" },
    rows: [],
    planChecks: ["pnpm typecheck"],
    createdAt: 1,
  } as unknown as FrozenTodoSnapshot;
  assert.deepEqual(checkSpecsOf(snapshot), {
    planChecks: ["pnpm typecheck"],
    planCheckSpecs: [{ command: "pnpm typecheck", kind: "gate" }],
  });
});
