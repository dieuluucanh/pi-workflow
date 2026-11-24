/**
 * Journal payload registry and upcasters (v2 step 8).
 *
 * The journal line format stays v1 forever (Decision 6), so the payload is the
 * compatibility boundary. These tests prove:
 *   - every known event type has a validator and every archived reader-visible
 *     type stays readable, including the pre-orchestrator legacy types;
 *   - unknown types/versions fail closed with a seq, never a silent skip;
 *   - a real v1 journal replays byte-identically with no checksum recomputation;
 *   - the incident's five malformed checks upcast to quarantine, not commands;
 *   - a Phase-A `run.control` repair upcasts to typed specs in memory;
 *   - a stale `snapshot.json` cache is rebuilt from the journal.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import {
  KNOWN_EVENT_TYPES,
  createRunJournal,
  replayJournal,
  type JournalIo,
} from "./orchestrator-store.ts";
import {
  EVENT_PAYLOAD_REGISTRY,
  LEGACY_EVENT_TYPES,
  READABLE_EVENT_TYPES,
  isLegacyEventType,
  isReadableEventType,
  payloadVersionOf,
  upcastJournalEventPayload,
  validateJournalEventPayload,
} from "./journal-payloads.ts";
import { sha256Hex } from "./plan-spec.ts";
import type { FrozenExecutionSnapshot } from "./frozen-snapshot.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUN_ID = "run-2026-11-21-misa-audit-de-4f5693849d93";
const RUNS_ROOT = path.join(HERE, "..", "..", "orchestrator", "runs");

const INCIDENT_CHECKS = [
  "pnpm dev:preflight`, followed by controlled `npm run dev` smoke on the repaired local demo.",
  "pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test`, golden comparisons at the repository's exact tolerance.",
  "pnpm check` (the existing 19-gate chain), plus `check:docs-reference`, `check:docs-glossary` and focused generated-snapshot checks where applicable.",
  "pnpm db:test:invariants`, `pnpm db:test:ledger-tamper`, `pnpm db:verify-ledger` and migration/backfill/restore rehearsal on disposable databases only. Record fresh-install and upgrade results separately.",
  "pnpm docs:build` and `pnpm check:release` as diagnostics: report pending release/human gates honestly, not as conditions that can be fabricated or bypassed.",
];

const planDigest = sha256Hex("incident plan bytes");

function v1Snapshot(): Record<string, unknown> {
  return {
    version: 1,
    executionId: "todo-exec-4f5693849d93-1795440365299",
    mode: "orchestrator",
    source: {
      kind: "plan",
      path: "C:/repo/.pi/plans/incident.md",
      digest: planDigest,
      title: "MISA audit recovery",
    },
    rows: [
      {
        id: "row-1",
        ref: "1",
        text: "Reconcile documentation.",
        label: "15",
        source: "plan",
        planStepId: "step-15",
        acceptanceChecks: ["pnpm test"],
        expectedFiles: ["docs/README.md"],
        status: "completed",
        sourceLine: 120,
      },
    ],
    planChecks: [...INCIDENT_CHECKS],
    planCheckSpecs: INCIDENT_CHECKS.map((command) => ({ command })),
    createdAt: 1795440365299,
  };
}

function frozenPayload(): Record<string, unknown> {
  return {
    executionId: "todo-exec-4f5693849d93-1795440365299",
    digest: planDigest,
    snapshot: v1Snapshot(),
  };
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
    .join(",")}}`;
}

function checksumOf(event: Record<string, unknown>): string {
  return createHash("sha256")
    .update(
      canonical({
        version: event.version,
        seq: event.seq,
        eventId: event.eventId,
        at: event.at,
        type: event.type,
        runId: event.runId,
        payload: event.payload,
        prev: event.prev,
      }),
      "utf8",
    )
    .digest("hex");
}

function memoryIo(): JournalIo & { files: Map<string, string> } {
  const files = new Map<string, string>();
  let locked = false;
  return {
    files,
    async read(file) {
      return files.get(file) ?? null;
    },
    async writeAtomic(file, data) {
      files.set(file, data);
    },
    async append(file, data) {
      files.set(file, (files.get(file) ?? "") + data);
    },
    async list(dir) {
      return [...files.keys()].filter((key) => key.startsWith(dir));
    },
    async mkdir() {},
    async remove(file) {
      files.delete(file);
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

function journal(io = memoryIo(), runId = "run-1") {
  return {
    io,
    runId,
    value: createRunJournal({ dir: `C:/runs/${runId}`, runId, io }),
  };
}

test("the registry covers every known journal event type", () => {
  assert.deepEqual([...READABLE_EVENT_TYPES].sort(), [...KNOWN_EVENT_TYPES].sort());
  for (const type of KNOWN_EVENT_TYPES) {
    assert.ok(EVENT_PAYLOAD_REGISTRY[type], `${type} has no payload contract`);
    assert.equal(isReadableEventType(type), true);
    assert.equal(EVENT_PAYLOAD_REGISTRY[type]!.legacy, undefined);
  }
});

test("legacy pre-orchestrator event types stay readable, never written", () => {
  for (const type of LEGACY_EVENT_TYPES) {
    assert.equal(isReadableEventType(type), true);
    assert.equal(isLegacyEventType(type), true);
    assert.equal(EVENT_PAYLOAD_REGISTRY[type]!.legacy, true);
    assert.equal(validateJournalEventPayload(type, { planArtifact: "a" }).ok, true);
  }
});

test("unknown event types and payload versions fail closed", () => {
  const unknownType = validateJournalEventPayload("run.exploded", {});
  assert.equal(unknownType.ok, false);
  if (!unknownType.ok) assert.equal(unknownType.code, "unknown_event");

  const futureSnapshot = validateJournalEventPayload("todos.frozen", {
    executionId: "todo-exec-1",
    digest: planDigest,
    snapshot: { schemaVersion: 3, rows: [] },
  });
  assert.equal(futureSnapshot.ok, false);
  if (!futureSnapshot.ok) assert.equal(futureSnapshot.code, "unknown_version");

  const futureControl = validateJournalEventPayload("run.control", {
    action: "cancel",
    reason: "stop",
    version: 2,
  });
  assert.equal(futureControl.ok, false);
  if (!futureControl.ok) assert.equal(futureControl.code, "unknown_version");

  const missingEvidence = validateJournalEventPayload("task.accepted", {
    taskId: "task-1",
  });
  assert.equal(missingEvidence.ok, false);
  if (!missingEvidence.ok) assert.equal(missingEvidence.code, "invalid_payload");

  assert.equal(
    validateJournalEventPayload("run.control", {
      action: "future-control-channel",
      record: { ok: true },
    }).ok,
    true,
    "an unknown control action is readable (restore ignores it) and executes nothing",
  );
});

test("a v1 todos.frozen payload upcasts in memory and quarantines malformed checks", () => {
  const payload = frozenPayload();
  assert.equal(payloadVersionOf("todos.frozen", payload), 1);
  const upcast = upcastJournalEventPayload("todos.frozen", payload);
  assert.equal(upcast.ok, true);
  if (!upcast.ok) return;
  assert.equal(upcast.fromVersion, 1);
  assert.equal(upcast.toVersion, 2);
  const snapshot = upcast.payload.snapshot as FrozenExecutionSnapshot;
  assert.equal(snapshot.schemaVersion, 2);
  assert.deepEqual(snapshot.checks, []);
  assert.equal(upcast.quarantined.length, INCIDENT_CHECKS.length);
  assert.equal(snapshot.rows[0]!.checks[0]!.command, "pnpm test");
  // The stored payload is untouched: upcasting never rewrites history.
  assert.equal((payload.snapshot as Record<string, unknown>).version, 1);
  assert.equal(payloadVersionOf("todos.frozen", payload), 1);
});

test("a Phase-A repair payload upcasts to typed specs without touching history", () => {
  const previous = {
    planChecks: [...INCIDENT_CHECKS],
    planCheckSpecs: INCIDENT_CHECKS.map((command) => ({ command })),
  };
  const repair = {
    action: "plan-check-specs-repair",
    version: 1,
    executionId: "todo-exec-4f5693849d93-1795440365299",
    previous,
    next: {
      planChecks: ["pnpm typecheck", "pnpm test"],
      planCheckSpecs: [
        { command: "pnpm typecheck", kind: "gate" },
        { command: "pnpm test", kind: "diagnostic" },
      ],
    },
    reason: "repair the five malformed checks",
    source: "test",
    approvedAt: 1795440500000,
  };
  const upcast = upcastJournalEventPayload("run.control", repair);
  assert.equal(upcast.ok, true);
  if (!upcast.ok) return;
  assert.equal(upcast.fromVersion, 1);
  const typedNext = upcast.payload.typedNext as Array<Record<string, unknown>>;
  assert.deepEqual(
    typedNext.map((spec) => [spec.id, spec.command, spec.kind]),
    [
      ["check-1", "pnpm typecheck", "gate"],
      ["check-2", "pnpm test", "diagnostic"],
    ],
  );
  // `previous` is history: its commands are preserved, and only the Phase-A
  // `kind` default is filled in for the typed in-memory view.
  const history = upcast.payload.previous as {
    planChecks: string[];
    planCheckSpecs: Array<{ command: string }>;
  };
  assert.deepEqual(history.planChecks, INCIDENT_CHECKS);
  assert.deepEqual(
    history.planCheckSpecs.map((spec) => spec.command),
    INCIDENT_CHECKS,
  );
  assert.equal(
    (upcast.payload.next as { planChecks: string[] }).planChecks[0],
    "pnpm typecheck",
  );
});

test("a foreign line with an invalid payload fails load, not append", async () => {
  const h = journal();
  // The store is an append sink; a foreign writer can put an unreadable
  // payload on disk. Load is where this build refuses to interpret it.
  await h.value.append({
    eventId: "e1",
    type: "run.created",
    payload: { sourcePath: "C:/repo/plan.md" },
    at: 1,
  });
  const journalPath = [...h.io.files.keys()].find((key) => key.endsWith("journal.ndjson"))!;
  const event = JSON.parse(h.io.files.get(journalPath)!.trim()) as Record<string, unknown>;
  const forged: Record<string, unknown> = {
    ...event,
    type: "todos.frozen",
    payload: {
      executionId: "x",
      digest: sha256Hex("p"),
      snapshot: { version: 1, rows: [], planChecks: [] },
    },
  };
  forged.checksum = checksumOf(forged);
  h.io.files.set(journalPath, `${JSON.stringify(forged)}\n`);

  const loaded = await h.value.load();
  assert.equal(loaded.ok, false);
  if (loaded.ok) return;
  assert.equal(loaded.code, "invalid");
  assert.match(loaded.error, /seq 1/);
  assert.match(loaded.error, /no rows/);
});

test("an unknown type is rejected on load while replay stays byte-level", async () => {
  const h = journal();
  await h.value.append({
    eventId: "e1",
    type: "run.created",
    payload: { sourcePath: "C:/repo/plan.md" },
    at: 1,
  });
  const journalPath = [...h.io.files.keys()].find((key) => key.endsWith("journal.ndjson"))!;
  const originalLine = h.io.files.get(journalPath)!.trim();
  const event = JSON.parse(originalLine) as Record<string, unknown>;
  const forged: Record<string, unknown> = { ...event, type: "run.exploded" };
  forged.checksum = checksumOf(forged);
  const forgedLine = JSON.stringify(forged);
  h.io.files.set(journalPath, `${forgedLine}\n`);

  // Pure replay proves the bytes/chain; it does not interpret payloads.
  const replay = replayJournal(h.runId, h.io.files.get(journalPath)!);
  assert.equal(replay.ok, true);
  if (replay.ok) {
    assert.deepEqual(replay.value.validLines, [forgedLine]);
    assert.equal(replay.value.state.events.length, 1);
  }

  // Load is the fail-closed gate and names the seq.
  const loaded = await h.value.load();
  assert.equal(loaded.ok, false);
  if (loaded.ok) return;
  assert.equal(loaded.code, "invalid");
  assert.match(loaded.error, /seq 1/);
  assert.match(loaded.error, /unknown journal event type/);
});

test("a stale snapshot cache is rebuilt from the journal, not trusted", async () => {
  const h = journal();
  await h.value.append({
    eventId: "e1",
    type: "task.accepted",
    payload: { taskId: "task-1", evidenceId: "ev-1" },
    at: 1,
  });
  const snapshotPath = [...h.io.files.keys()].find((key) => key.endsWith("snapshot.json"))!;
  const stale: Record<string, unknown> = {
    version: 1,
    runId: h.runId,
    seq: 0,
    revision: 0,
  };
  stale.checksum = createHash("sha256").update(canonical(stale), "utf8").digest("hex");
  h.io.files.set(snapshotPath, JSON.stringify(stale));

  const loaded = await h.value.load();
  assert.equal(loaded.ok, true);
  const state = (loaded as { ok: true; value: { seq: number; revision: number; accepted: unknown[] } })
    .value;
  assert.equal(state.seq, 1);
  assert.equal(state.revision, 1);
  assert.equal(state.accepted.length, 1);

  const rewritten = JSON.parse(h.io.files.get(snapshotPath)!) as Record<string, unknown>;
  assert.equal(rewritten.seq, 1);
  assert.equal(rewritten.revision, 1);
});

test(
  "every archived v1 journal line replays byte-identically with no checksum recomputation",
  { skip: !fs.existsSync(path.join(RUNS_ROOT, RUN_ID, "journal.ndjson")) },
  () => {
    const text = fs.readFileSync(path.join(RUNS_ROOT, RUN_ID, "journal.ndjson"), "utf8");
    const lines = text.split("\n").filter((line) => line.length > 0);
    const replay = replayJournal(RUN_ID, text);
    assert.equal(replay.ok, true, replay.ok ? "" : replay.error);
    if (!replay.ok) return;
    assert.equal(replay.value.state.truncated, 0);
    assert.equal(replay.value.validLines.length, lines.length);
    for (const [index, line] of lines.entries()) {
      assert.equal(replay.value.validLines[index], line, `line ${index + 1} changed on replay`);
      const parsed = JSON.parse(line) as { checksum: string };
      assert.equal(
        replay.value.state.events[index]!.checksum,
        parsed.checksum,
        `seq ${index + 1} checksum was recomputed`,
      );
    }
    assert.equal(replay.value.state.revision, replay.value.state.seq);

    const frozen = replay.value.state.events.find((event) => event.type === "todos.frozen");
    assert.ok(frozen, "the archived run has a todos.frozen event");
    const upcast = upcastJournalEventPayload(frozen!.type, frozen!.payload);
    assert.equal(upcast.ok, true, upcast.ok ? "" : upcast.error);
    if (!upcast.ok) return;
    assert.equal(upcast.quarantined.length, INCIDENT_CHECKS.length);
    assert.equal(replay.value.state.revision, replay.value.state.seq);
  },
);
