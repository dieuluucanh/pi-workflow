/**
 * Automatic verify/accept/advance contract.
 *
 * These tests use the real reducer/journal and fake ports, so they pin the
 * exact transition sequence. The child is never real: the point is that the
 * parent's decision path is mechanical and does not depend on the model.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  createOrchestratorRuntime,
  type OrchestratorRuntime,
  type OrchestratorRuntimePorts,
} from "./orchestrator-runtime.ts";
import type {
  JournalEvent,
  JournalState,
  RunJournal,
} from "./orchestrator-store.ts";
import {
  buildRepairPrompt,
  checkFailureHint,
  checkResultRepairable,
  createOrchestratorAdvance,
  type AdvanceChild,
  type AdvancePorts,
} from "./orchestrator-advance.ts";
import { MAX_REPAIR_ROUNDS } from "./orchestrator-state.ts";
import type { OrchestratorChildPhase } from "./orchestrator-child-controller.ts";
import type { WorkspaceSetDiff } from "./orchestrator-workspace-set.ts";

const PLAN = [
  "# Plan: Advance",
  "",
  "## Plan Steps",
  "",
  "1. First row",
  "   Acceptance:",
  "   - npm run first",
  "   Files:",
  "   - a.ts",
  "",
  "2. Second row",
  "",
  "## Verification",
  "",
  "```bash",
  "npm run final",
  "```",
].join("\n");

const NO_OP_PLAN = [
  "# Plan: NoOp",
  "",
  "## Plan Steps",
  "",
  "1. Silent row",
  "",
  "2. Last row",
  "",
  "## Verification",
  "",
  "```bash",
  "npm run final",
  "```",
].join("\n");

function memoryJournal(runId: string) {
  const events: JournalEvent[] = [];
  const state = (): JournalState => ({
    runId,
    seq: events.length,
    revision: events.length,
    events: [...events],
    accepted: [],
    acceptedTaskIds: new Set<string>(),
    kickoff: {},
    truncated: 0,
  });
  const journal = {
    dir: `/tmp/${runId}`,
    load: async () => ({ ok: true as const, value: state() }),
    append: async (input: {
      eventId: string;
      type: string;
      at: number;
      payload: unknown;
    }) => {
      const event = {
        version: 1,
        seq: events.length + 1,
        eventId: input.eventId,
        at: input.at,
        type: input.type,
        runId,
        payload: input.payload,
        prev: "",
        checksum: "checksum",
      } as unknown as JournalEvent;
      events.push(event);
      return { ok: true as const, value: { state: state(), duplicate: false } };
    },
    recover: async () => ({ ok: true as const, value: state() }),
    putArtifact: async () => ({
      ok: false as const,
      code: "invalid",
      error: "unused",
    }),
    getArtifact: async () => ({
      ok: false as const,
      code: "invalid",
      error: "unused",
    }),
  } as unknown as RunJournal;
  return { journal, events };
}

function portsFor(journal: RunJournal): OrchestratorRuntimePorts {
  return { createJournal: () => journal, now: () => 1_000 };
}

function positiveDiff(overrides: Partial<WorkspaceSetDiff> = {}): WorkspaceSetDiff {
  const diff: WorkspaceSetDiff = {
    changed: true,
    entries: [
      {
        workspaceId: "W",
        root: "C:/work/W",
        diff: {
          changed: true,
          committedPaths: [],
          dirtyPaths: ["a.ts"],
          attributionConflicts: [],
          workspaceRevision: "rev-1",
        },
      },
    ],
    committedPaths: [],
    dirtyPaths: ["a.ts"],
    attributionConflicts: [],
    workspaceRevision: "rev-1",
    ...overrides,
  };
  if (overrides.changed !== undefined) diff.entries[0]!.diff.changed = overrides.changed;
  if (overrides.committedPaths !== undefined) diff.entries[0]!.diff.committedPaths = [...overrides.committedPaths];
  if (overrides.dirtyPaths !== undefined) diff.entries[0]!.diff.dirtyPaths = [...overrides.dirtyPaths];
  if (overrides.attributionConflicts !== undefined) diff.entries[0]!.diff.attributionConflicts = [...overrides.attributionConflicts];
  return diff;
}

interface HarnessOptions {
  plan?: string;
  diff?: WorkspaceSetDiff | undefined;
  diffDelay?: Promise<void>;
  rowChecks?: AdvancePorts["runRowChecks"];
  finalChecks?: AdvancePorts["runFinalChecks"];
  reenter?: (repair: string) => Promise<boolean>;
}

function harness(options: HarnessOptions = {}) {
  const memory = memoryJournal("run-advance");
  const runtime: OrchestratorRuntime = createOrchestratorRuntime(
    portsFor(memory.journal),
  );
  const calls = {
    dispatched: 0,
    reentered: [] as string[],
    started: [] as Array<Record<string, unknown>>,
    disposed: 0,
    turns: [] as string[],
    contexts: [] as string[],
    notices: [] as string[],
    checks: [] as string[][],
  };
  let childState: {
    phase: OrchestratorChildPhase;
    taskId: string;
    attemptId: string;
    sessionId: string;
    ref: string;
    total: number;
  } = {
    phase: "settling",
    taskId: "task-1",
    attemptId: "attempt-1",
    sessionId: "session-1",
    ref: "1",
    total: 2,
  };
  const child: AdvanceChild = {
    state: () => childState,
    reenter: async (repair) => {
      calls.reentered.push(repair);
      childState = { ...childState, phase: "running" };
      return options.reenter ? options.reenter(repair) : true;
    },
    abort: async () => {},
    dispose: async () => {
      calls.disposed += 1;
    },
    start: async (input) => {
      calls.started.push({ ...input });
      return { ok: true };
    },
  };
  const advance = createOrchestratorAdvance({
    runtime: () => runtime,
    child: () => child,
    diff: async (_taskId, expectedFiles, workspaceIds) => {
      if (options.diffDelay) await options.diffDelay;
      void expectedFiles;
      void workspaceIds;
      return { ok: true, diff: options.diff === undefined ? positiveDiff() : options.diff };
    },
    runRowChecks:
      options.rowChecks ??
      (async (commands, _root) => {
        calls.checks.push([...commands]);
        return { ok: true, results: [] };
      }),
    runFinalChecks: options.finalChecks ?? (async () => ({ ok: true })),
    dispatchNext: async () => {
      calls.dispatched += 1;
      return { ok: true, text: "dispatched next" };
    },
    notify: (message) => calls.notices.push(message),
    contextMessage: (message) => calls.contexts.push(message),
    triggerTurn: (message) => calls.turns.push(message),
  });
  return { runtime, advance, calls, memory, setChildState: (next: typeof childState) => { childState = next; } };
}

async function bindTask(
  runtime: OrchestratorRuntime,
  taskId = "task-1",
  attemptId = "attempt-1",
  sessionId = "session-1",
): Promise<void> {
  const started = await runtime.applyEvent({
    type: "task.start",
    runId: runtime.view()!.runId,
    now: 1,
    taskId,
    attemptId,
    sessionId,
  });
  assert.equal(started.ok, true);
}

function settle(taskId = "task-1", attemptId = "attempt-1") {
  return {
    taskId,
    attemptId,
    summary: "done",
    toolCalls: 3,
    durationMs: 1_000,
  };
}

test("a settled row is verified, accepted and the next row is dispatched", async () => {
  const h = harness();
  const started = await h.runtime.startFromPlan({
    planPath: "/tmp/advance.md",
    planText: PLAN,
  });
  assert.equal(started.ok, true);
  await bindTask(h.runtime);

  const outcome = await h.advance.settled(settle());

  assert.equal(outcome.ok, true);
  assert.equal(outcome.action, "accepted");
  const view = h.runtime.view()!;
  assert.equal(view.state.tasks["task-1"]?.state, "accepted");
  assert.equal(h.calls.dispatched, 1);
  assert.deepEqual(h.calls.checks, [["npm run first"]]);
});

test("a row with no checks, no files and no change asks for one repair", async () => {
  const h = harness({ plan: NO_OP_PLAN, diff: positiveDiff({ changed: false, dirtyPaths: [] }) });
  const started = await h.runtime.startFromPlan({
    planPath: "/tmp/noop.md",
    planText: NO_OP_PLAN,
  });
  assert.equal(started.ok, true);
  await bindTask(h.runtime);

  const outcome = await h.advance.settled(settle());

  assert.equal(outcome.action, "repairing");
  assert.equal(h.calls.reentered.length, 1);
  assert.match(h.calls.reentered[0] ?? "", /no workspace change/);
  const view = h.runtime.view()!;
  assert.equal(view.state.tasks["task-1"]?.state, "running");
  assert.equal(view.state.tasks["task-1"]?.repairRounds, 1);
});

test("committed work is attributable even when git status is clean", async () => {
  const h = harness({
    diff: positiveDiff({ committedPaths: ["a.ts"], dirtyPaths: [] }),
  });
  const started = await h.runtime.startFromPlan({
    planPath: "/tmp/advance.md",
    planText: PLAN,
  });
  assert.equal(started.ok, true);
  await bindTask(h.runtime);

  const outcome = await h.advance.settled(settle());

  assert.equal(outcome.action, "accepted");
  assert.equal(h.runtime.view()!.state.tasks["task-1"]?.state, "accepted");
});

test("a failing row check journals needsFix and re-enters running on the warm child", async () => {
  const h = harness({
    rowChecks: async (commands) => ({
      ok: false,
      results: commands.map((command) => ({ command, ok: false, output: "boom" })),
      failure: "row check failed: npm run first — boom",
    }),
  });
  const started = await h.runtime.startFromPlan({
    planPath: "/tmp/advance.md",
    planText: PLAN,
  });
  assert.equal(started.ok, true);
  await bindTask(h.runtime);

  const outcome = await h.advance.settled(settle());

  assert.equal(outcome.action, "repairing");
  assert.equal(h.calls.reentered.length, 1);
  assert.match(h.calls.reentered[0] ?? "", /row check failed/);
  const view = h.runtime.view()!;
  // task.start with the same attempt/session is the only legal return.
  assert.equal(view.state.tasks["task-1"]?.state, "running");
  assert.equal(view.state.tasks["task-1"]?.attemptId, "attempt-1");
  assert.equal(view.state.tasks["task-1"]?.sessionId, "session-1");
});

test("a non-repairable row metadata failure blocks on the first settle", async () => {
  const h = harness({
    rowChecks: async (commands) =>
      ({
        ok: false,
        results: commands.map((command) => ({
          command,
          ok: false,
          output: "invalid metadata",
        })),
        failure: "row check metadata invalid: prose Acceptance is not a command",
        repairable: false,
      }) as Awaited<ReturnType<AdvancePorts["runRowChecks"]>>,
  });
  const started = await h.runtime.startFromPlan({
    planPath: "/tmp/advance.md",
    planText: PLAN,
  });
  assert.equal(started.ok, true);
  await bindTask(h.runtime);

  const outcome = await h.advance.settled(settle());

  assert.equal(outcome.action, "blocked");
  assert.match(outcome.text, /plan-metadata failure/);
  assert.match(outcome.text, /repair the frozen check list/);
  assert.equal(h.calls.reentered.length, 0, "metadata failures never re-enter the child");
  assert.equal(h.calls.started.length, 0, "metadata failures never start a fresh child");
  assert.equal(
    h.memory.events.filter((event) => event.type === "task.needs_fix").length,
    0,
    "a metadata failure must not journal task.needs_fix",
  );
  const view = h.runtime.view()!;
  assert.equal(view.state.tasks["task-1"]?.state, "blocked");
  assert.equal(view.state.tasks["task-1"]?.repairRounds, 0);
});

test("several changed roots and no row workspace block as ambiguous, never the primary root", async () => {
  let seenRoot: string | undefined;
  let seenChanged: readonly string[] | undefined;
  const twoRootDiff: WorkspaceSetDiff = {
    changed: true,
    entries: [
      {
        workspaceId: "W",
        root: "C:/work/W",
        diff: {
          changed: true,
          committedPaths: [],
          dirtyPaths: ["a.ts"],
          attributionConflicts: [],
          workspaceRevision: "rev-1",
        },
      },
      {
        workspaceId: "ERP",
        root: "C:/work/ERP",
        diff: {
          changed: true,
          committedPaths: [],
          dirtyPaths: ["b.ts"],
          attributionConflicts: [],
          workspaceRevision: "rev-2",
        },
      },
    ],
    committedPaths: [],
    dirtyPaths: ["a.ts", "b.ts"],
    attributionConflicts: [],
    workspaceRevision: "rev-2",
  };
  const h = harness({
    diff: twoRootDiff,
    rowChecks: async (_commands, root, changedRoots) => {
      seenRoot = root;
      seenChanged = changedRoots;
      return {
        ok: false,
        results: [],
        failure: "row check metadata invalid: ambiguous check workspace",
        failureClass: "metadata",
        repairable: false,
      } as Awaited<ReturnType<AdvancePorts["runRowChecks"]>>;
    },
  });
  const started = await h.runtime.startFromPlan({
    planPath: "/tmp/advance.md",
    planText: PLAN,
  });
  assert.equal(started.ok, true);
  await bindTask(h.runtime);

  const outcome = await h.advance.settled(settle());

  assert.equal(outcome.action, "blocked");
  assert.match(outcome.text, /plan-metadata failure/);
  // Both changed roots travel with the hint; no primary-root default is sent.
  assert.equal(seenRoot, undefined);
  assert.deepEqual(seenChanged, ["C:/work/W", "C:/work/ERP"]);
  assert.equal(h.calls.reentered.length, 0);
  assert.equal(
    h.memory.events.filter((event) => event.type === "task.needs_fix").length,
    0,
  );
  assert.equal(h.runtime.view()!.state.tasks["task-1"]?.repairRounds, 0);
});

test("a non-repairable final-check metadata failure blocks the last row without a repair round", async () => {
  const h = harness({
    plan: NO_OP_PLAN,
    finalChecks: async () =>
      ({
        ok: false,
        failure: "final plan check metadata invalid: mixed command and prose",
        repairable: false,
      }) as Awaited<ReturnType<AdvancePorts["runFinalChecks"]>>,
  });
  const started = await h.runtime.startFromPlan({
    planPath: "/tmp/noop.md",
    planText: NO_OP_PLAN,
  });
  assert.equal(started.ok, true);
  await bindTask(h.runtime, "task-1", "attempt-1", "session-1");
  const firstRow = await h.advance.settled(settle("task-1", "attempt-1"));
  assert.equal(firstRow.action, "accepted");
  await bindTask(h.runtime, "task-2", "attempt-2", "session-2");

  const outcome = await h.advance.settled(settle("task-2", "attempt-2"));

  assert.equal(outcome.action, "blocked");
  assert.match(outcome.text, /plan-metadata failure/);
  assert.equal(h.calls.reentered.length, 0, "metadata failures never re-enter the child");
  assert.equal(
    h.memory.events.filter((event) => event.type === "task.needs_fix").length,
    0,
    "a metadata failure must not journal task.needs_fix",
  );
  const view = h.runtime.view()!;
  assert.equal(view.state.tasks["task-2"]?.state, "blocked");
  assert.equal(view.state.tasks["task-2"]?.repairRounds, 0);
});

test("a gone child is replaced with the same attempt identity", async () => {
  const h = harness({
    rowChecks: async () => ({ ok: false, results: [], failure: "nope" }),
    reenter: async () => false,
  });
  const started = await h.runtime.startFromPlan({
    planPath: "/tmp/advance.md",
    planText: PLAN,
  });
  assert.equal(started.ok, true);
  await bindTask(h.runtime);

  const outcome = await h.advance.settled(settle());

  assert.equal(outcome.action, "repairing");
  assert.equal(h.calls.disposed, 1);
  assert.equal(h.calls.started.length, 1);
  assert.equal(h.calls.started[0]?.attemptId, "attempt-1");
  assert.equal(h.calls.started[0]?.sessionId, "session-1");
});

test("repair exhaustion blocks the row, pauses the run and wakes the parent", async () => {
  const h = harness({
    rowChecks: async () => ({ ok: false, results: [], failure: "still failing" }),
  });
  const started = await h.runtime.startFromPlan({
    planPath: "/tmp/advance.md",
    planText: PLAN,
  });
  assert.equal(started.ok, true);
  await bindTask(h.runtime);

  for (let round = 1; round <= MAX_REPAIR_ROUNDS; round += 1) {
    const result = await h.advance.settled(settle());
    assert.equal(result.action, "repairing", `round ${round}`);
  }
  const exhausted = await h.advance.settled(settle());

  assert.equal(exhausted.action, "blocked");
  const view = h.runtime.view()!;
  assert.equal(view.state.tasks["task-1"]?.state, "blocked");
  assert.equal(view.phase, "paused");
  assert.equal(h.calls.dispatched, 0);
  assert.equal(h.calls.turns.length, 1);
  assert.match(h.calls.turns[0] ?? "", /blocked|repair/i);
});

test("a final plan check failure repairs the last row before acceptance", async () => {
  const h = harness({
    plan: NO_OP_PLAN,
    finalChecks: async () => ({ ok: false, failure: "npm run final: exit 1" }),
  });
  const started = await h.runtime.startFromPlan({
    planPath: "/tmp/noop.md",
    planText: NO_OP_PLAN,
  });
  assert.equal(started.ok, true);
  // Accept row 1 so row 2 becomes the last unaccepted row.
  await bindTask(h.runtime, "task-1", "attempt-1", "session-1");
  const firstRow = await h.advance.settled(settle("task-1", "attempt-1"));
  assert.equal(firstRow.action, "accepted");
  await bindTask(h.runtime, "task-2", "attempt-2", "session-2");
  const first = await h.advance.settled(settle("task-2", "attempt-2"));
  assert.equal(first.action, "repairing");
  assert.match(h.calls.reentered[0] ?? "", /final plan check failed/);
  assert.equal(h.runtime.view()!.state.tasks["task-2"]?.state, "running");
});

test("a paused run is neither reported nor advanced", async () => {
  const h = harness();
  const started = await h.runtime.startFromPlan({
    planPath: "/tmp/advance.md",
    planText: PLAN,
  });
  assert.equal(started.ok, true);
  await bindTask(h.runtime);
  const paused = await h.runtime.applyEvent({
    type: "run.transition",
    runId: h.runtime.view()!.runId,
    now: 2,
    to: "paused",
  });
  assert.equal(paused.ok, true);

  const outcome = await h.advance.settled(settle());

  assert.equal(outcome.action, "paused");
  const view = h.runtime.view()!;
  assert.equal(view.state.tasks["task-1"]?.state, "running");
  assert.equal(h.calls.dispatched, 0);
});

test("a stale child settle is ignored", async () => {
  const h = harness();
  const started = await h.runtime.startFromPlan({
    planPath: "/tmp/advance.md",
    planText: PLAN,
  });
  assert.equal(started.ok, true);
  await bindTask(h.runtime, "task-1", "attempt-1");

  const outcome = await h.advance.settled(settle("task-1", "attempt-0"));

  assert.equal(outcome.action, "ignored");
  assert.equal(h.runtime.view()!.state.tasks["task-1"]?.state, "running");
});

test("a user abort blocks the row and pauses without waking the parent", async () => {
  const h = harness();
  const started = await h.runtime.startFromPlan({
    planPath: "/tmp/advance.md",
    planText: PLAN,
  });
  assert.equal(started.ok, true);
  await bindTask(h.runtime);

  const outcome = await h.advance.aborted({
    taskId: "task-1",
    attemptId: "attempt-1",
    reason: "user abort",
  });

  assert.equal(outcome.action, "blocked");
  const view = h.runtime.view()!;
  assert.equal(view.state.tasks["task-1"]?.state, "blocked");
  assert.equal(view.phase, "paused");
  assert.equal(h.calls.turns.length, 0);
  assert.equal(h.calls.dispatched, 0);
});

test("a terminal child error blocks the row and wakes the parent", async () => {
  const h = harness();
  const started = await h.runtime.startFromPlan({
    planPath: "/tmp/advance.md",
    planText: PLAN,
  });
  assert.equal(started.ok, true);
  await bindTask(h.runtime);

  const outcome = await h.advance.failed({
    taskId: "task-1",
    attemptId: "attempt-1",
    error: "provider auth failed",
  });

  assert.equal(outcome.action, "blocked");
  assert.equal(h.runtime.view()!.state.tasks["task-1"]?.state, "blocked");
  assert.equal(h.calls.turns.length, 1);
  assert.equal(h.calls.disposed, 1);
});

test("buildRepairPrompt carries the failure, the summary and the round bound", () => {
  const text = buildRepairPrompt({
    taskId: "task-1",
    reason: "row check failed",
    summary: "I touched a.ts",
    round: 2,
  });
  assert.match(text, /Repair round 2\/2/);
  assert.match(text, /row check failed/);
  assert.match(text, /I touched a\.ts/);
});

// ── Failure taxonomy and the journaled final gate ────────────────────

test("the taxonomy decides repair: only test/timeout may re-enter the child", async () => {
  assert.equal(checkResultRepairable({}), true, "legacy default stays repairable");
  assert.equal(checkResultRepairable({ failureClass: "test" }), true);
  assert.equal(checkResultRepairable({ failureClass: "timeout" }), true);
  for (const failureClass of ["metadata", "policy", "environment", "manual"] as const) {
    assert.equal(checkResultRepairable({ failureClass }), false, failureClass);
  }
  assert.equal(checkResultRepairable({ repairable: false, failureClass: "test" }), false);
  assert.match(checkFailureHint("policy"), /shell-policy refusal/);
  assert.match(checkFailureHint("environment"), /environment failure/);
  assert.match(checkFailureHint("manual"), /manual check/);
  assert.match(checkFailureHint("metadata"), /plan-metadata failure/);
});

test("a policy refusal blocks with its own fix and no repair round", async () => {
  const h = harness({
    rowChecks: async () =>
      ({
        ok: false,
        results: [],
        failure: "row check failed: npm test",
        failureClass: "policy",
        repairable: false,
      }) as Awaited<ReturnType<AdvancePorts["runRowChecks"]>>,
  });
  const started = await h.runtime.startFromPlan({ planPath: "/tmp/advance.md", planText: PLAN });
  assert.equal(started.ok, true);
  await bindTask(h.runtime);

  const outcome = await h.advance.settled(settle());

  assert.equal(outcome.action, "blocked");
  assert.match(outcome.text, /shell-policy refusal/);
  assert.match(outcome.text, /cannot change a policy/);
  assert.equal(h.calls.reentered.length, 0);
  assert.equal(
    h.memory.events.filter((event) => event.type === "task.needs_fix").length,
    0,
  );
  assert.equal(h.runtime.view()!.state.tasks["task-1"]?.repairRounds, 0);
});

test("a manual check can never be auto-accepted", async () => {
  const h = harness({
    rowChecks: async () =>
      ({
        ok: false,
        results: [],
        failure: "row check failed: human attestation",
        failureClass: "manual",
        repairable: false,
      }) as Awaited<ReturnType<AdvancePorts["runRowChecks"]>>,
  });
  const started = await h.runtime.startFromPlan({ planPath: "/tmp/advance.md", planText: PLAN });
  assert.equal(started.ok, true);
  await bindTask(h.runtime);

  const outcome = await h.advance.settled(settle());

  assert.equal(outcome.action, "blocked");
  assert.match(outcome.text, /manual check/);
  assert.match(outcome.text, /cannot be auto-accepted/);
  const task = h.runtime.view()!.state.tasks["task-1"];
  assert.equal(task?.state, "blocked");
  assert.equal(task?.repairRounds, 0);
});

test("an environment failure on the final gate blocks instead of repairing", async () => {
  const h = harness({
    plan: NO_OP_PLAN,
    finalChecks: async () =>
      ({
        ok: false,
        failure: "final plan check failed: git baseline timed out",
        failureClass: "environment",
        repairable: false,
      }) as Awaited<ReturnType<AdvancePorts["runFinalChecks"]>>,
  });
  const started = await h.runtime.startFromPlan({ planPath: "/tmp/noop.md", planText: NO_OP_PLAN });
  assert.equal(started.ok, true);
  await bindTask(h.runtime, "task-1", "attempt-1", "session-1");
  assert.equal((await h.advance.settled(settle("task-1", "attempt-1"))).action, "accepted");
  await bindTask(h.runtime, "task-2", "attempt-2", "session-2");

  const outcome = await h.advance.settled(settle("task-2", "attempt-2"));

  assert.equal(outcome.action, "blocked");
  assert.match(outcome.text, /environment failure/);
  assert.equal(h.calls.reentered.length, 0);
  assert.equal(h.runtime.view()!.state.tasks["task-2"]?.repairRounds, 0);
});

test("a passing final gate is journaled, reused and lets the run complete once", async () => {
  let finalRuns = 0;
  const h = harness({
    plan: NO_OP_PLAN,
    finalChecks: async () => {
      finalRuns += 1;
      return { ok: true };
    },
  });
  const started = await h.runtime.startFromPlan({ planPath: "/tmp/noop.md", planText: NO_OP_PLAN });
  assert.equal(started.ok, true);
  await bindTask(h.runtime, "task-1", "attempt-1", "session-1");
  assert.equal((await h.advance.settled(settle("task-1", "attempt-1"))).action, "accepted");

  // Another call path already ran and recorded the same executable spec.
  const recorded = await h.runtime.recordFinalGate({ ok: true });
  assert.equal(recorded.ok, true);
  await bindTask(h.runtime, "task-2", "attempt-2", "session-2");

  const outcome = await h.advance.settled(settle("task-2", "attempt-2"));

  assert.equal(outcome.action, "completed");
  assert.equal(finalRuns, 0, "the journaled pass is reused instead of re-run");
  assert.equal(h.memory.events.filter((event) => event.type === "final_gate").length, 1);
  assert.equal(h.memory.events.filter((event) => event.type === "run.completed").length, 1);
});

test("the first successful gate is journaled before completion", async () => {
  const h = harness();
  const started = await h.runtime.startFromPlan({ planPath: "/tmp/noop.md", planText: NO_OP_PLAN });
  assert.equal(started.ok, true);
  await bindTask(h.runtime, "task-1", "attempt-1", "session-1");
  assert.equal((await h.advance.settled(settle("task-1", "attempt-1"))).action, "accepted");
  await bindTask(h.runtime, "task-2", "attempt-2", "session-2");

  const outcome = await h.advance.settled(settle("task-2", "attempt-2"));

  assert.equal(outcome.action, "completed");
  const gateEvent = h.memory.events.find((event) => event.type === "final_gate");
  assert.ok(gateEvent, "the passing gate was journaled");
  const status = await h.runtime.finalGateStatus();
  assert.equal(status.ok && status.value.satisfied, true);
});
