/**
 * Observability tests (step 41): stable-key usage accounting (no double
 * billing), bounded status rows, safe caps when cost is unknown, and retention
 * that never deletes active work, unaccepted evidence or session history.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildRunStatus,
  checkResourceCaps,
  createUsageLedger,
  describeUsageSources,
  planRetention,
  rebindStatus,
  type RetentionItem,
  type RetentionPolicy,
  type UsageRecord,
} from "./orchestrator-observability.ts";
import { applyRunEvent, createRunState, type RunState } from "./orchestrator-state.ts";
import { ORCHESTRATOR_SCHEMA_VERSION, type PlannedTask } from "./orchestrator-types.ts";

function ok<T>(result: { ok: boolean }, label = "expected success"): T {
  assert.equal(result.ok, true, label);
  return result as unknown as T;
}

const TASKS: PlannedTask[] = [
  {
    taskId: "task-t1",
    covers: ["step-r1"],
    objective: "One",
    nonGoals: [],
    dependsOn: [],
    expectedFiles: ["src/a.ts"],
    acceptanceChecks: ["tests"],
    sizeRationale: "small",
  },
  {
    taskId: "task-t2",
    covers: ["step-r2"],
    objective: "Two",
    nonGoals: [],
    dependsOn: ["task-t1"],
    expectedFiles: ["src/b.ts"],
    acceptanceChecks: ["tests"],
    sizeRationale: "small",
  },
];

function planState(): RunState {
  let state = ok<{ state: RunState }>(
    createRunState({ runId: "run-1", roadmapRevision: 1, now: 1 }),
  ).state;
  return ok<{ state: RunState }>(
    applyRunEvent(state, {
      type: "plan.apply",
      runId: "run-1",
      expectedRevision: state.revision,
      now: 2,
      plan: {
        schemaVersion: ORCHESTRATOR_SCHEMA_VERSION,
        runId: "run-1",
        roadmapRevision: 1,
        tasks: TASKS,
      },
      requirements: [
        { roadmapStepId: "step-r1", label: "1", text: "One" },
        { roadmapStepId: "step-r2", label: "2", text: "Two" },
      ],
    }),
  ).state;
}

function record(over: Partial<UsageRecord> = {}): UsageRecord {
  return {
    sessionId: "session-s1",
    messageId: "message-m1",
    model: "openai/gpt",
    inputTokens: 100,
    outputTokens: 20,
    cachedInputTokens: 10,
    costUsd: 0.01,
    activeMs: 1_000,
    at: 5,
    ...over,
  };
}

test("usage is keyed per message and never sums with SDK totals", () => {
  const ledger = createUsageLedger();
  assert.equal(ok<{ duplicate: boolean }>(ledger.record(record())).duplicate, false);
  assert.equal(ok<{ duplicate: boolean }>(ledger.record(record({ inputTokens: 9_999 }))).duplicate, true);
  assert.equal(
    ok<{ duplicate: boolean }>(ledger.record(record({ messageId: "message-m2", costUsd: null, activeMs: 500 }))).duplicate,
    false,
  );
  assert.equal(ledger.record({ ...record(), inputTokens: -1 }).ok, false);

  const totals = ledger.totals();
  assert.equal(totals.records, 2);
  assert.equal(totals.inputTokens, 200);
  assert.equal(totals.duplicateRecords, 1);
  assert.equal(totals.unknownCostRecords, 1);
  assert.deepEqual(totals.unknownCostSessions, ["session-s1"]);
  assert.equal(totals.accountingBoundary, "workflow_messages_only");

  const bySession = ledger.bySession();
  assert.equal(bySession["session-s1"]!.records, 2);
  assert.equal(bySession["session-s1"]!.costKnown, false);

  const boundary = describeUsageSources({ workflowTotalTokens: 120, sdkSessionTotalTokens: 140 });
  assert.equal(boundary.sumIsSafe, false);
  assert.match(boundary.explanation, /double.bill/i);
});

test("caps pause when a configured cost or time limit cannot be proven", () => {
  const ledger = createUsageLedger();
  ledger.record(record());
  const known = ledger.totals();
  assert.equal(checkResourceCaps(known, { costLimitUsd: 1 }).status, "ok");

  const exceeded = checkResourceCaps(
    { ...known, costUsd: 2 },
    { costLimitUsd: 1 },
  );
  assert.equal(exceeded.status, "exceeded");
  assert.equal(exceeded.pauseRequired, true);

  ledger.record(record({ messageId: "message-m2", costUsd: null }));
  const unknown = checkResourceCaps(ledger.totals(), { costLimitUsd: 1 });
  assert.equal(unknown.status, "unknown");
  assert.equal(unknown.pauseRequired, true);
  assert.equal(unknown.costUnknown, true);

  const noLimit = checkResourceCaps(ledger.totals(), {});
  assert.equal(noLimit.status, "ok");
  assert.equal(noLimit.pauseRequired, false);

  const time = checkResourceCaps(known, { activeTimeLimitMinutes: 10 });
  assert.equal(time.status, "ok");
  const timeExceeded = checkResourceCaps({ ...known, activeMs: 11 * 60_000 }, { activeTimeLimitMinutes: 10 });
  assert.equal(timeExceeded.status, "exceeded");
});

test("status rows are bounded and carry link, context, counters and evidence", () => {
  let state = planState();
  const task = state.tasks["task-t1"]!;
  state = {
    ...state,
    tasks: {
      ...state.tasks,
      "task-t1": {
        ...task,
        state: "needs_fix",
        counters: { ...task.counters, repairRounds: 2, rollovers: 1, noProgress: 1 },
      },
    },
  };
  const ledger = createUsageLedger();
  ledger.record(record());
  const status = buildRunStatus({
    state,
    children: [
      {
        taskId: "task-t1",
        phase: "waiting_user",
        link: "tab-7",
        model: "openai/gpt",
        tokensUsed: 30_000,
        contextWindow: 128_000,
        localProgress: "2/5 local steps",
        waitingReason: "needs an API key",
      },
    ],
    evidence: [
      {
        taskId: "task-t1",
        evidenceId: "evidence-e1",
        verdict: "needs_fix",
        checksPassed: 1,
        checksFailed: 2,
        workspaceRevision: "ws-1",
      },
    ],
    usage: ledger.totals(),
    models: { orchestrator: "openai/gpt", builder: "openai/gpt" },
    now: 10,
  });
  assert.equal(status.rows.length <= 40, true);
  assert.match(status.text, /0\/2 accepted/);
  assert.match(status.text, /tab-7/);
  assert.match(status.text, /30000\/128000 ctx/);
  assert.match(status.text, /repairs 2 · rollovers 1/);
  assert.match(status.text, /waiting: needs an API key/);
  assert.match(status.text, /needs_fix · 1 passed \/ 2 failed/);
  assert.equal(status.usage.records, 1);

  const rebound = rebindStatus(status.rows, []);
  assert.equal(rebound.some((row) => row.childId === "task-t1"), false);
  assert.equal(rebound.some((row) => row.label === "Roadmap"), true);
});

test("retention protects active, unaccepted, session and pinned items", () => {
  const items: RetentionItem[] = [
    { id: "active-artifact", kind: "artifact", bytes: 1_000, createdAt: 1, active: true, accepted: false },
    { id: "open-evidence", kind: "evidence", bytes: 1_000, createdAt: 2, active: false, accepted: false },
    { id: "accepted-evidence", kind: "evidence", bytes: 1_000, createdAt: 3, active: false, accepted: true },
    { id: "history", kind: "session-history", bytes: 10_000, createdAt: 4, active: false, accepted: true },
    { id: "pinned", kind: "artifact", bytes: 1_000, createdAt: 5, active: false, accepted: true, pinned: true },
    { id: "old-artifact", kind: "artifact", bytes: 5_000, createdAt: 6, active: false, accepted: true },
    { id: "old-preview", kind: "transcript-preview", bytes: 500, createdAt: 7, active: false, accepted: false },
  ];
  const policy: RetentionPolicy = {
    maxTotalBytes: 100_000,
    maxPreviews: 10,
    maxQueueEntries: 10,
    maxAgeMs: 100,
    runComplete: false,
  };
  const plan = planRetention(items, policy, 1_000);
  assert.deepEqual(plan.delete, ["old-artifact", "old-preview"]);
  assert.equal(plan.protected.some((entry) => entry.id === "active-artifact"), true);
  assert.equal(plan.protected.some((entry) => entry.id === "open-evidence"), true);
  assert.equal(plan.protected.some((entry) => entry.id === "accepted-evidence"), true);
  assert.equal(plan.protected.some((entry) => entry.id === "history"), true);
  assert.equal(plan.protected.some((entry) => entry.id === "pinned"), true);
  assert.equal(plan.bytesFreed, 5_500);

  const completed = planRetention(items, { ...policy, runComplete: true }, 1_000);
  assert.equal(completed.delete.includes("accepted-evidence"), true);
});

test("preview and byte caps delete the oldest candidates only", () => {
  const items: RetentionItem[] = Array.from({ length: 5 }, (_, index) => ({
    id: `preview-${index}`,
    kind: "transcript-preview",
    bytes: 1_000,
    createdAt: index,
    active: false,
    accepted: false,
  }));
  const plan = planRetention(
    items,
    { maxTotalBytes: 10_000, maxPreviews: 2, maxQueueEntries: 10, maxAgeMs: 0, runComplete: false },
    100,
  );
  assert.deepEqual(plan.delete, ["preview-0", "preview-1", "preview-2"]);

  const bytes = planRetention(
    items,
    { maxTotalBytes: 2_500, maxPreviews: 10, maxQueueEntries: 10, maxAgeMs: 0, runComplete: false },
    100,
  );
  assert.deepEqual(bytes.delete, ["preview-0", "preview-1", "preview-2"]);
  assert.equal(bytes.bytesFreed, 3_000);
  assert.equal(bytes.keep.length, 2);
});
