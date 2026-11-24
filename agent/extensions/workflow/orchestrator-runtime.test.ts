/**
 * Runtime start/restore contract (frozen list, journal-only restore).
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { createOrchestratorRuntime, type OrchestratorRuntimePorts } from "./orchestrator-runtime.ts";
import {
  createRunJournal,
  type JournalEvent,
  type JournalIo,
  type JournalState,
  type RunJournal,
} from "./orchestrator-store.ts";
import { createFrozenTodosFromPlan } from "./todo-snapshot.ts";
import type { FrozenWorkspace } from "./orchestrator-workspace-set.ts";

const PLAN = [
  "# Plan: Restore",
  "",
  "## Plan Steps",
  "",
  "1. First step",
  "2. Second step",
  "",
  "## Verification",
  "",
  "```bash",
  "node --test x.test.ts",
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
    putArtifact: async () => ({ ok: false as const, code: "invalid", error: "unused" }),
    getArtifact: async () => ({ ok: false as const, code: "invalid", error: "unused" }),
  } as unknown as RunJournal;
  return { journal, events };
}

function portsFor(get: () => RunJournal): OrchestratorRuntimePorts {
  return {
    createJournal: () => get(),
    now: () => 1_000,
  };
}

// ── Reload by plan path (real journal, multiple runs) ────────────────

const CONTRACT_PLAN = [
  "# Plan: Restore contract",
  "",
  "## Plan Steps",
  "",
  "1. First step",
  "2. Second step",
  "",
  "## Verification",
  "",
  "```bash",
  "node --test x.test.ts",
  "```",
].join("\n");

const WORKSPACES: FrozenWorkspace[] = [
  {
    id: "W",
    key: "git:C:/work",
    root: "C:/work",
    kind: "git",
    displayPath: "C:/work",
    primary: true,
  },
  {
    id: "X",
    key: "git:C:/work/x",
    root: "C:/work/x",
    kind: "git",
    displayPath: "C:/work/x",
    primary: false,
  },
];

function digestOf(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function memoryIo(): JournalIo & { files: Map<string, string> } {
  const files = new Map<string, string>();
  let locked = false;
  return {
    files,
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

function contractHarness(): {
  io: JournalIo & { files: Map<string, string> };
  journalFor(runId: string): RunJournal;
  runtime(): ReturnType<typeof createOrchestratorRuntime>;
} {
  const io = memoryIo();
  let tick = 2_000;
  const journalFor = (runId: string) =>
    createRunJournal({ dir: `C:/runs/${runId}`, runId, io });
  const ports: OrchestratorRuntimePorts = {
    createJournal: (runId) => journalFor(runId),
    listRunIds: async () => {
      const ids = new Set<string>();
      for (const key of io.files.keys()) {
        const match = /^C:[\\/]runs[\\/]([^\\/]+)[\\/]journal\.ndjson$/.exec(key);
        if (match?.[1]) ids.add(match[1]);
      }
      return [...ids].sort();
    },
    now: () => (tick += 1),
  };
  return { io, journalFor, runtime: () => createOrchestratorRuntime(ports) };
}

async function acceptedRow(
  runtime: ReturnType<typeof createOrchestratorRuntime>,
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
    const applied = await runtime.applyEvent({ ...event, runId, now: 2_100 } as never);
    assert.equal(applied.ok, true, applied.ok ? "" : applied.error);
  }
}

async function eventsOf(journal: RunJournal): Promise<JournalEvent[]> {
  const loaded = await journal.load();
  assert.equal(loaded.ok, true, loaded.ok ? "" : loaded.error);
  if (!loaded.ok) throw new Error("unreachable");
  return loaded.value.events;
}


test("startFromPlan freezes the rows and restoreFromPlan rebinds the same run", async () => {
  const memory = memoryJournal("run-restore");
  const runtime = createOrchestratorRuntime(portsFor(() => memory.journal));
  const started = await runtime.startFromPlan({
    planPath: "/tmp/plan.md",
    planText: PLAN,
  });
  assert.equal(started.ok, true);
  if (!started.ok) return;
  assert.equal(started.value.frozen.rows.length, 2);
  assert.equal(started.value.view.phase, "ready");
  const eventCount = memory.events.length;
  assert.deepEqual(
    memory.events.map((event) => event.type),
    ["run.created", "todos.frozen"],
  );

  const reloaded = createOrchestratorRuntime(portsFor(() => memory.journal));
  const restored = await reloaded.restoreFromPlan({
    planPath: "/tmp/plan.md",
    planText: PLAN,
  });
  assert.equal(restored.ok, true);
  if (!restored.ok) return;
  assert.equal(restored.value.frozen.rows.length, 2);
  assert.equal(restored.value.view.phase, "ready");
  assert.equal(memory.events.length, eventCount, "restore never appends");
});

test("restoreFromPlan refuses a plan that never started a run", async () => {
  const memory = memoryJournal("run-empty");
  const runtime = createOrchestratorRuntime(portsFor(() => memory.journal));
  const restored = await runtime.restoreFromPlan({
    planPath: "/tmp/other.md",
    planText: PLAN,
  });
  assert.equal(restored.ok, false);
  assert.match((restored as { error: string }).error, /no run journal/);
  assert.equal(memory.events.length, 0);
});

test("a duplicate start is refused instead of replacing the frozen list", async () => {
  const memory = memoryJournal("run-duplicate");
  const runtime = createOrchestratorRuntime(portsFor(() => memory.journal));
  const first = await runtime.startFromPlan({ planPath: "/tmp/plan.md", planText: PLAN });
  assert.equal(first.ok, true);
  const second = await runtime.startFromPlan({ planPath: "/tmp/plan.md", planText: PLAN });
  assert.equal(second.ok, false);
});

test("a changed plan digest restores by plan path with rows, workspaces and checks intact", async () => {
  const h = contractHarness();
  const runtime = h.runtime();
  const started = await runtime.startFromPlan({
    planPath: String.raw`C:\work\plans\contract.md`,
    planText: CONTRACT_PLAN,
    workspaces: WORKSPACES,
  });
  assert.equal(started.ok, true, started.ok ? "" : started.error);
  if (!started.ok) return;
  const { runId, frozen } = started.value;
  await acceptedRow(runtime, runId, "1");
  const before = await eventsOf(h.journalFor(runId));

  const edited = `${CONTRACT_PLAN}\n\nAn edit after freeze changes the digest.\n`;
  assert.notEqual(digestOf(edited), digestOf(CONTRACT_PLAN));
  const reloaded = h.runtime();
  const restored = await reloaded.restoreFromPlan({
    planPath: "C:/work/plans/contract.md",
    planText: edited,
  });
  assert.equal(restored.ok, true, restored.ok ? "" : restored.error);
  if (!restored.ok) return;
  assert.equal(restored.value.runId, runId);
  assert.equal(restored.value.view.state.tasks["task-1"]?.state, "accepted");
  assert.deepEqual(restored.value.frozen.workspaces, frozen.workspaces);
  assert.deepEqual(restored.value.frozen.planChecks, ["node --test x.test.ts"]);
  assert.deepEqual(restored.value.frozen.planCheckSpecs, [
    { command: "node --test x.test.ts" },
  ]);
  assert.equal(restored.value.frozen.rows.length, 2);
  assert.equal((await eventsOf(h.journalFor(runId))).length, before.length, "restore never appends");
});

test("two non-terminal runs for one plan path fail closed with both ids", async () => {
  const h = contractHarness();
  const first = h.runtime();
  const firstStart = await first.startFromPlan({
    planPath: "C:/work/amb.md",
    planText: CONTRACT_PLAN,
  });
  assert.equal(firstStart.ok, true, firstStart.ok ? "" : firstStart.error);
  if (!firstStart.ok) return;

  const second = h.runtime();
  const secondStart = await second.startFromPlan({
    planPath: "C:/work/amb.md",
    planText: `${CONTRACT_PLAN}\n\nSecond frozen variant.\n`,
  });
  assert.equal(secondStart.ok, true, secondStart.ok ? "" : secondStart.error);
  if (!secondStart.ok) return;
  assert.notEqual(firstStart.value.runId, secondStart.value.runId);

  const reloaded = h.runtime();
  const restored = await reloaded.restoreFromPlan({
    planPath: "C:/work/amb.md",
    planText: `${CONTRACT_PLAN}\n\nThird, unseen variant.\n`,
  });
  assert.equal(restored.ok, false);
  if (restored.ok) return;
  assert.match(restored.error, /more than one active run/);
  assert.match(restored.error, new RegExp(firstStart.value.runId));
  assert.match(restored.error, new RegExp(secondStart.value.runId));
});

test("a plan whose Verification no longer compiles still rebinds by digest", async () => {
  const h = contractHarness();
  // A valid run supplies a genuine frozen snapshot; the journal is then placed
  // under the candidate id of a malformed plan with the same source path.
  const seed = h.runtime();
  const seeded = await seed.startFromPlan({
    planPath: "C:/work/broken.md",
    planText: CONTRACT_PLAN,
  });
  assert.equal(seeded.ok, true, seeded.ok ? "" : seeded.error);
  if (!seeded.ok) return;

  const broken = [
    "# Plan: Broken verification",
    "",
    "## Plan Steps",
    "",
    "1. Only step",
    "",
    "## Verification",
    "",
    "- `pnpm typecheck`, followed by prose and another `pnpm lint` run",
  ].join("\n");
  const compiled = createFrozenTodosFromPlan({
    planPath: "C:/work/broken.md",
    planText: broken,
    mode: "orchestrator",
  });
  assert.equal(compiled.ok, false, "the fixture must not compile");

  const digest = digestOf(broken);
  const candidateRunId = `run-broken-md-${digest.slice(0, 12)}`;
  const journal = h.journalFor(candidateRunId);
  await journal.append({
    eventId: `created-${candidateRunId}`,
    type: "run.created",
    at: 9_000,
    payload: {
      sourcePath: "C:/work/broken.md",
      digest,
      title: "Broken verification",
      mode: "orchestrator",
      plan: { path: "C:/work/broken.md", title: "Broken verification", digest },
      rowCount: seeded.value.frozen.rows.length,
    },
  });
  await journal.append({
    eventId: `frozen-${candidateRunId}`,
    type: "todos.frozen",
    at: 9_001,
    // The frozen envelope carries the snapshot's own provenance; `run.created`
    // above is the synthetic part (it stands in for the plan path binding).
    payload: {
      executionId: seeded.value.frozen.executionId,
      digest: seeded.value.frozen.source.digest,
      snapshot: seeded.value.frozen,
    },
  });

  const reloaded = h.runtime();
  const restored = await reloaded.restoreFromPlan({
    planPath: "C:/work/broken.md",
    planText: broken,
  });
  assert.equal(restored.ok, true, restored.ok ? "" : restored.error);
  if (!restored.ok) return;
  assert.equal(restored.value.runId, candidateRunId);
  assert.equal(restored.value.frozen.rows.length, seeded.value.frozen.rows.length);
});

test("an unreadable plan file still restores by journaled source path", async () => {
  const h = contractHarness();
  const runtime = h.runtime();
  const started = await runtime.startFromPlan({
    planPath: "C:/work/gone.md",
    planText: CONTRACT_PLAN,
  });
  assert.equal(started.ok, true, started.ok ? "" : started.error);
  if (!started.ok) return;

  const reloaded = h.runtime();
  // No planText: this is what index.ts passes when the file cannot be read.
  const restored = await reloaded.restoreFromPlan({ planPath: "C:/work/gone.md" });
  assert.equal(restored.ok, true, restored.ok ? "" : restored.error);
  if (!restored.ok) return;
  assert.equal(restored.value.runId, started.value.runId);
  assert.equal(restored.value.frozen.planChecks.length, 1);
});

// ── Restore hardening (row 12) ──────────────────────────────────────

function frozenEventOf(memory: ReturnType<typeof memoryJournal>) {
  const event = memory.events.find((candidate) => candidate.type === "todos.frozen");
  assert.ok(event, "the freeze event exists");
  return event!;
}

async function startForRestore(memory: ReturnType<typeof memoryJournal>) {
  const runtime = createOrchestratorRuntime(portsFor(() => memory.journal));
  const started = await runtime.startFromPlan({ planPath: "/tmp/plan.md", planText: PLAN });
  assert.equal(started.ok, true, started.ok ? "" : started.error);
  return started;
}

test("a tampered frozen snapshot fails closed naming its journal seq", async () => {
  const memory = memoryJournal("run-tamper");
  await startForRestore(memory);
  const event = frozenEventOf(memory);
  const snapshot = (event.payload as { snapshot: { rows: { text: string }[] } }).snapshot;
  snapshot.rows[0]!.text = "edited after the freeze";

  const reloaded = createOrchestratorRuntime(portsFor(() => memory.journal));
  const restored = await reloaded.restoreFromPlan({ planPath: "/tmp/plan.md", planText: PLAN });
  assert.equal(restored.ok, false);
  if (restored.ok) return;
  assert.match(restored.error, new RegExp(`seq ${event.seq}`));
  assert.match(restored.error, /spec hash|invalid/);
});

test("an envelope/snapshot mismatch fails closed at its seq", async () => {
  const memory = memoryJournal("run-envelope");
  await startForRestore(memory);
  const event = frozenEventOf(memory);
  (event.payload as Record<string, unknown>).executionId = "todo-exec-someone-else";

  const reloaded = createOrchestratorRuntime(portsFor(() => memory.journal));
  const restored = await reloaded.restoreFromPlan({ planPath: "/tmp/plan.md", planText: PLAN });
  assert.equal(restored.ok, false);
  if (restored.ok) return;
  assert.match(restored.error, new RegExp(`seq ${event.seq}`));
  assert.match(restored.error, /mismatched execution id/);
});

test("a second frozen snapshot is rejected instead of silently re-frozen", async () => {
  const memory = memoryJournal("run-refreeze");
  await startForRestore(memory);
  const first = frozenEventOf(memory);
  memory.events.push({ ...first, seq: first.seq + 1, eventId: "frozen-again" });

  const reloaded = createOrchestratorRuntime(portsFor(() => memory.journal));
  const restored = await reloaded.restoreFromPlan({ planPath: "/tmp/plan.md", planText: PLAN });
  assert.equal(restored.ok, false);
  if (restored.ok) return;
  assert.match(restored.error, /more than one frozen TODO snapshot/);
  assert.match(restored.error, new RegExp(`seq ${first.seq + 1}`));
});

test("restore reconciles frozen row statuses: completed work is not resurrected", async () => {
  const memory = memoryJournal("run-status");
  const started = await startForRestore(memory);
  if (!started.ok) return;
  const event = frozenEventOf(memory);
  const snapshot = (
    event.payload as { snapshot: { rows: { status: string }[] } }
  ).snapshot;
  snapshot.rows[0]!.status = "completed";
  snapshot.rows[1]!.status = "cancelled";

  const reloaded = createOrchestratorRuntime(portsFor(() => memory.journal));
  const restored = await reloaded.restoreFromPlan({ planPath: "/tmp/plan.md", planText: PLAN });
  assert.equal(restored.ok, true, restored.ok ? "" : restored.error);
  if (!restored.ok) return;
  assert.equal(restored.value.view.state.tasks["task-1"]?.state, "accepted");
  assert.equal(restored.value.view.state.tasks["task-2"]?.state, "blocked");
  assert.equal(restored.value.view.nextTaskId, undefined);
  // The list itself still records the statuses; nothing was rewritten.
  assert.deepEqual(
    restored.value.frozen.rows.map((row) => row.status),
    ["completed", "cancelled"],
  );
  assert.equal(memory.events.length, 2, "restore never appends");
});

test("a v1 snapshot with malformed checks restores and reports the repair", async () => {
  const memory = memoryJournal("run-v1");
  await startForRestore(memory);
  const event = frozenEventOf(memory);
  const payload = event.payload as Record<string, unknown>;
  const v2 = payload.snapshot as {
    executionId: string;
    mode: string;
    source: { kind: string; path?: string; digest: string; title: string };
    rows: Record<string, unknown>[];
    workspaces?: unknown;
    createdAt: number;
  };
  const v1 = {
    version: 1,
    executionId: v2.executionId,
    mode: v2.mode,
    source: v2.source,
    rows: v2.rows.map((row) => ({
      id: row.id,
      ref: row.ref,
      text: row.text,
      ...(row.label === undefined ? {} : { label: row.label }),
      ...(row.group === undefined ? {} : { group: row.group }),
      source: row.source,
      ...(row.planStepId === undefined ? {} : { planStepId: row.planStepId }),
      acceptanceChecks: row.acceptanceChecks,
      expectedFiles: row.expectedFiles,
      ...(row.workspaces === undefined ? {} : { workspaces: row.workspaces }),
      status: row.status,
      ...(row.sourceLine === undefined ? {} : { sourceLine: row.sourceLine }),
    })),
    planChecks: ["pnpm check`, plus prose that is not one whole command"],
    ...(v2.workspaces === undefined ? {} : { workspaces: v2.workspaces }),
    createdAt: v2.createdAt,
  };
  payload.snapshot = v1;
  payload.digest = v2.source.digest;

  const notifications: string[] = [];
  const reloaded = createOrchestratorRuntime({
    ...portsFor(() => memory.journal),
    notify: (message: string) => notifications.push(message),
  });
  const restored = await reloaded.restoreFromPlan({ planPath: "/tmp/plan.md", planText: PLAN });
  assert.equal(restored.ok, true, restored.ok ? "" : restored.error);
  if (!restored.ok) return;
  assert.match(
    (restored.value.view.warnings ?? []).join("\n"),
    /quarantined/,
  );
  assert.ok(
    notifications.some((message) => /orchestrator-repair-checks/.test(message)),
    "the restore reports the repair command",
  );
  assert.deepEqual(restored.value.frozen.planChecks, []);
});

// ── Final-gate marker and completion rules ──────────────────────────

test("completion is refused until a passing final_gate marker exists", async () => {
  const memory = memoryJournal("run-gate-required");
  const runtime = createOrchestratorRuntime(portsFor(() => memory.journal));
  const started = await runtime.startFromPlan({ planPath: "/tmp/plan.md", planText: PLAN });
  assert.equal(started.ok, true);
  const runId = runtime.view()!.runId;
  await acceptedRow(runtime, runId, "1");
  await acceptedRow(runtime, runId, "2");

  const refused = await runtime.complete();
  assert.equal(refused.ok, false);
  assert.match(refused.ok ? "" : refused.error, /passing final gate/);
  assert.equal(runtime.view()!.phase, "running", "a refused completion does not move the run");

  const recorded = await runtime.recordFinalGate({ ok: true });
  assert.equal(recorded.ok, true);
  const completed = await runtime.complete();
  assert.equal(completed.ok, true);
  assert.equal(runtime.view()!.phase, "completed");
  assert.equal(
    memory.events.filter((event) => event.type === "final_gate").length,
    1,
    "one marker authorizes completion",
  );
});

test("a failing final_gate marker does not authorize completion", async () => {
  const memory = memoryJournal("run-gate-failing");
  const runtime = createOrchestratorRuntime(portsFor(() => memory.journal));
  const started = await runtime.startFromPlan({ planPath: "/tmp/plan.md", planText: PLAN });
  assert.equal(started.ok, true);
  const runId = runtime.view()!.runId;
  await acceptedRow(runtime, runId, "1");
  await acceptedRow(runtime, runId, "2");

  const recorded = await runtime.recordFinalGate({
    ok: false,
    failureClass: "test",
    failure: "npm run final: exit 1",
  });
  assert.equal(recorded.ok, true);
  const refused = await runtime.complete();
  assert.equal(refused.ok, false);
  assert.match(refused.ok ? "" : refused.error, /last run failed/);
});

test("an amended spec invalidates a passing marker and needs a new gate", async () => {
  const memory = memoryJournal("run-gate-spec");
  const runtime = createOrchestratorRuntime(portsFor(() => memory.journal));
  const started = await runtime.startFromPlan({ planPath: "/tmp/plan.md", planText: PLAN });
  assert.equal(started.ok, true);
  const before = await runtime.finalGateStatus();
  assert.equal(before.ok && before.value.satisfied, false);

  assert.equal((await runtime.recordFinalGate({ ok: true })).ok, true);
  const passed = await runtime.finalGateStatus();
  assert.equal(passed.ok && passed.value.satisfied, true);

  const amended = await runtime.repairCheckSpecs({
    specs: [{ command: "node --test y.test.ts" }],
    reason: "the gate spec changed",
    source: "test",
  });
  assert.equal(amended.ok, true, amended.ok ? "" : amended.error);

  const after = await runtime.finalGateStatus();
  assert.equal(after.ok && after.value.satisfied, false);
  assert.notEqual(
    before.ok ? before.value.specHash : "",
    after.ok ? after.value.specHash : "",
    "the executable spec hash changed",
  );
});

test("an identical final_gate record is idempotent and a new attempt is not", async () => {
  const memory = memoryJournal("run-gate-idempotent");
  const runtime = createOrchestratorRuntime(portsFor(() => memory.journal));
  const started = await runtime.startFromPlan({ planPath: "/tmp/plan.md", planText: PLAN });
  assert.equal(started.ok, true);

  const first = await runtime.recordFinalGate({ ok: true });
  const second = await runtime.recordFinalGate({ ok: true });
  assert.equal(first.ok && first.value.duplicate, false);
  assert.equal(second.ok && second.value.duplicate, true);
  assert.equal(
    memory.events.filter((event) => event.type === "final_gate").length,
    1,
    "the deterministic id dedupes an identical record",
  );
});

test("a journaled final gate survives reload and authorizes completion", async () => {
  const h = contractHarness();
  const runtime = h.runtime();
  const planPath = String.raw`C:\work\plans\gate.md`;
  const started = await runtime.startFromPlan({ planPath, planText: PLAN });
  assert.equal(started.ok, true);
  const runId = runtime.view()!.runId;
  await acceptedRow(runtime, runId, "1");
  await acceptedRow(runtime, runId, "2");
  assert.equal((await runtime.recordFinalGate({ ok: true })).ok, true);

  const reloaded = h.runtime();
  const opened = await reloaded.openRun(runId);
  assert.equal(opened.ok, true, opened.ok ? "" : opened.error);
  const status = await reloaded.finalGateStatus();
  assert.equal(status.ok && status.value.satisfied, true);
  const completed = await reloaded.complete();
  assert.equal(completed.ok, true, completed.ok ? "" : completed.error);
  assert.equal(reloaded.view()!.phase, "completed");
});
