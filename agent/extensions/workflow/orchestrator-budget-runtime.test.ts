/**
 * Budget/usage/rollover runtime tests (plan step 19).
 *
 * The reducer, the usage ledger and the rollover planner are real here. The
 * assertions are the durable properties: no double counting after reload, no
 * silent $0 for unknown cost, and no rollover without a settled child.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { createBudgetRuntime } from "./orchestrator-budget-runtime.ts";
import type { OrchestratorRuntime } from "./orchestrator-runtime.ts";
import type { JournalEvent } from "./orchestrator-store.ts";
import type { TaskCounters } from "./orchestrator-state.ts";

function fakeRuntime(options: { events?: JournalEvent[]; failAppend?: boolean } = {}) {
  const events: JournalEvent[] = [...(options.events ?? [])];
  const appended: Array<{ type: string; payload: unknown; eventId: string }> = [];
  let revision = 1;
  const runtime = {
    view() {
      return {
        runId: "run-1",
        phase: "building",
        roadmapRevision: 1,
        state: { ...baseState, revision },
      } as never;
    },
    async journalEvents() {
      return { ok: true as const, value: events };
    },
    async appendJournal(type: string, payload: unknown, eventId: string) {
      if (options.failAppend) return { ok: false as const, code: "journal" as const, error: "disk full" };
      appended.push({ type, payload, eventId });
      return { ok: true as const, value: undefined };
    },
    async applyEvent(event: { type: string }) {
      appended.push({ type: event.type, payload: event, eventId: `ev-${appended.length}` });
      revision += 1;
      return { ok: true as const, value: { revision, view: runtime.view() } };
    },
  };
  // SAFETY: the budget runtime only uses view/journalEvents/appendJournal/applyEvent.
  return { runtime: runtime as unknown as OrchestratorRuntime, appended, events };
}

const baseState = {
  schemaVersion: 1,
  runId: "run-1",
  revision: 1,
  phase: "building",
  roadmapRevision: 1,
  planRevision: 1,
  requirements: [],
  tasks: {},
  order: [],
  mutation: null,
  createdAt: 1,
  updatedAt: 1,
};

const COUNTERS: TaskCounters = {
  repairRounds: 1,
  noProgress: 1,
  rollovers: 1,
  launchFailures: 0,
};

const CHILD = {
  phase: "fenced" as const,
  pendingTools: 0,
  pendingFollowUps: 0,
  leaseGeneration: 2,
  currentLeaseGeneration: 2,
  settled: true,
};

const CHECKPOINT = {
  schemaVersion: 1 as const,
  runId: "run-1",
  taskId: "task-1",
  attemptId: "attempt-1",
  sessionId: "session-1",
  remainingTodos: ["write the second file"],
  decisions: ["kept the existing helper"],
  files: ["src/one.ts"],
  checks: [{ name: "npm test", status: "passed" }],
  partialEffects: [],
  criteria: ["one"],
  completionClaimed: false as const,
  truncated: false,
  digest: "checkpoint-digest",
  createdAt: 1,
};

function usage(over: Record<string, unknown> = {}) {
  return {
    sessionId: "session-1",
    messageId: "msg-1",
    model: "builder",
    inputTokens: 1_000,
    outputTokens: 200,
    cachedInputTokens: 0,
    costUsd: 0.01,
    activeMs: 1_000,
    at: 1,
    ...over,
  };
}

test("usage is journaled once and replayed after a reload", async () => {
  const { runtime, appended } = fakeRuntime();
  const budget = createBudgetRuntime({ runtime: () => runtime });
  const first = await budget.recordUsage(usage());
  assert.equal(first.ok, true);
  assert.equal(appended.filter((entry) => entry.eventId.startsWith("usage-")).length, 1);

  const duplicate = await budget.recordUsage(usage());
  assert.equal(duplicate.ok, true);
  if (duplicate.ok) assert.equal(duplicate.value.duplicate, true);
  assert.equal(appended.filter((entry) => entry.eventId.startsWith("usage-")).length, 1);

  // A fresh runtime replays the journal instead of starting at zero.
  const journaled = fakeRuntime({
    events: [
      {
        version: 1,
        seq: 1,
        eventId: "usage-session-1-msg-1",
        at: 1,
        type: "run.control",
        runId: "run-1",
        payload: { action: "usage", record: usage() },
        prev: "",
        checksum: "x",
      },
    ],
  });
  const reloaded = createBudgetRuntime({ runtime: () => journaled.runtime });
  const restored = await reloaded.restore();
  assert.equal(restored.ok, true);
  assert.equal(reloaded.totals().records, 1);
  assert.equal(reloaded.totals().inputTokens, 1_000);
});

test("a journal failure is reported, never silently counted as durable", async () => {
  const { runtime } = fakeRuntime({ failAppend: true });
  const budget = createBudgetRuntime({ runtime: () => runtime });
  const result = await budget.recordUsage(usage());
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "journal");
});

test("an unknown cost with a configured cap pauses instead of assuming $0", async () => {
  const { runtime } = fakeRuntime();
  const budget = createBudgetRuntime({
    runtime: () => runtime,
    limits: { costLimitUsd: 5 },
  });
  await budget.recordUsage(usage({ costUsd: null }));
  const caps = budget.caps();
  assert.equal(caps.status, "unknown");
  assert.equal(caps.pauseRequired, true);
  assert.match(caps.reasons.join(" "), /cost is unknown/);
});

test("headroom assessment reports a rollover level only with real limits", () => {
  const { runtime } = fakeRuntime();
  const budget = createBudgetRuntime({ runtime: () => runtime });
  const unknown = budget.assess({ tokensUsed: 1_000 });
  assert.equal(unknown.level, "unknown", "no context window is not 'plenty of room'");

  const tight = budget.assess({ tokensUsed: 101_000, contextWindow: 100_000, settled: true });
  assert.equal(tight.level, "overflowed");
});

test("a rollover needs a new attempt and applies the attempt.rollover transition", async () => {
  const { runtime, appended } = fakeRuntime();
  const budget = createBudgetRuntime({ runtime: () => runtime });
  const applied = await budget.rollover({
    taskId: "task-1",
    attemptId: "attempt-1",
    sessionId: "session-1",
    child: CHILD,
    next: { attemptId: "attempt-2", sessionId: "session-2", generation: 2 },
    counters: COUNTERS,
    checkpoint: CHECKPOINT,
  });
  assert.equal(applied.ok, true, applied.ok ? "" : applied.error);
  if (!applied.ok) return;
  assert.equal(applied.value.applied, true);
  if (applied.value.decision.ok) {
    assert.equal(applied.value.decision.action, "relaunch");
  }
  assert.ok(appended.some((entry) => entry.type === "attempt.rollover"));
});

test("an unsettled or same-attempt rollover is refused without a transition", async () => {
  const { runtime, appended } = fakeRuntime();
  const budget = createBudgetRuntime({ runtime: () => runtime });

  const sameAttempt = await budget.rollover({
    taskId: "task-1",
    attemptId: "attempt-1",
    sessionId: "session-1",
    child: CHILD,
    next: { attemptId: "attempt-1", sessionId: "session-2", generation: 2 },
    counters: COUNTERS,
  });
  assert.equal(sameAttempt.ok, false);

  const unsettled = await budget.rollover({
    taskId: "task-1",
    attemptId: "attempt-1",
    sessionId: "session-1",
    child: { ...CHILD, settled: false },
    next: { attemptId: "attempt-2", sessionId: "session-2", generation: 2 },
    counters: COUNTERS,
  });
  assert.equal(unsettled.ok, true);
  if (unsettled.ok) assert.equal(unsettled.value.applied, false);
  assert.equal(appended.filter((entry) => entry.type === "attempt.rollover").length, 0);
});

test("the rollover budget is cumulative and stops further continuations", async () => {
  const { runtime } = fakeRuntime();
  const budget = createBudgetRuntime({
    runtime: () => runtime,
    budgets: { repairRounds: 2, noProgressLimit: 2, rolloverLimit: 1, launchFailureLimit: 3 },
  });
  const exhausted = await budget.rollover({
    taskId: "task-1",
    attemptId: "attempt-1",
    sessionId: "session-1",
    child: CHILD,
    next: { attemptId: "attempt-2", sessionId: "session-2", generation: 2 },
    counters: { ...COUNTERS, rollovers: 1 },
  });
  assert.equal(exhausted.ok, true);
  if (exhausted.ok) {
    assert.equal(exhausted.value.applied, false);
    if (exhausted.value.decision.ok) {
      assert.equal(exhausted.value.decision.action, "pause");
    }
  }
});
