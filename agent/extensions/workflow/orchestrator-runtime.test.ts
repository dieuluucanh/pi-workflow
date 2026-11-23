/**
 * Runtime start/restore contract (frozen list, journal-only restore).
 */

import assert from "node:assert/strict";
import test from "node:test";

import { createOrchestratorRuntime, type OrchestratorRuntimePorts } from "./orchestrator-runtime.ts";
import type { JournalEvent, JournalState, RunJournal } from "./orchestrator-store.ts";

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
