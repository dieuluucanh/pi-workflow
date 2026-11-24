/**
 * Upcast fixtures for the plan-execution contract (v2 step 18).
 *
 * `fixtures/plan-contract/v1-journal.ndjson` is a hand-built v1 run that looks
 * exactly like something written before the refactor:
 *
 *   seq 1  run.created  — the plan identity,
 *   seq 2  todos.frozen — a v1 snapshot with one command acceptance value,
 *                         one prose acceptance value and two malformed checks,
 *   seq 3  run.control   — a Phase-A `plan-check-specs-repair` amendment.
 *
 * The fixture is byte-frozen. These tests prove that the new readers replay it
 * without recomputing a single checksum, upcast it in memory, apply the repair
 * idempotently, and still fail closed on a tampered payload or an unknown
 * payload version. Nothing here rewrites the old bytes.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { replayJournal } from "./orchestrator-store.ts";
import {
  payloadVersionOf,
  upcastJournalEventPayload,
  validateJournalEventPayload,
} from "./journal-payloads.ts";
import {
  FROZEN_EXECUTION_SCHEMA_VERSION,
  readFrozenSnapshot,
  type FrozenExecutionSnapshot,
} from "./frozen-snapshot.ts";
import { applyCheckSpecRepair } from "./orchestrator-check-repair.ts";
import type { FrozenTodoSnapshot } from "./todo-snapshot.ts";
import type { CheckSpec } from "./plan-spec.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONTRACT = path.join(HERE, "fixtures", "plan-contract");
const RUN_ID = "run-2026-11-24-upcast-fixture-000000000000";

const INCIDENT_CHECKS = [
  "pnpm dev:preflight`, followed by controlled `npm run dev` smoke on the repaired local demo.",
  "pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test`, golden comparisons at the repository's exact tolerance.",
];

function journalText(): string {
  return fs.readFileSync(path.join(CONTRACT, "v1-journal.ndjson"), "utf8");
}

function v1Snapshot(): Record<string, unknown> {
  return JSON.parse(
    fs.readFileSync(path.join(CONTRACT, "v1-snapshot.json"), "utf8"),
  ) as Record<string, unknown>;
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

function lines(): string[] {
  return journalText().split("\n").filter((line) => line.length > 0);
}

interface ParsedEvent {
  seq: number;
  type: string;
  payload: unknown;
  checksum: string;
  prev: string;
}

function parsedEvents(): ParsedEvent[] {
  return lines().map((line) => JSON.parse(line) as ParsedEvent);
}

test("the v1 journal fixture has the expected three-event shape", () => {
  const events = parsedEvents();
  assert.deepEqual(
    events.map((event) => [event.seq, event.type]),
    [
      [1, "run.created"],
      [2, "todos.frozen"],
      [3, "run.control"],
    ],
  );
  assert.equal(events[0]!.prev, "");
  assert.equal(events[1]!.prev, events[0]!.checksum);
  assert.equal(events[2]!.prev, events[1]!.checksum);
});

test("the archive replays byte-identically with no checksum recomputation", () => {
  const text = journalText();
  const original = lines();
  const replay = replayJournal(RUN_ID, text);
  assert.equal(replay.ok, true, replay.ok ? "" : replay.error);
  if (!replay.ok) return;
  assert.equal(replay.value.state.truncated, 0);
  assert.equal(replay.value.validLines.length, original.length);
  for (const [index, line] of original.entries()) {
    assert.equal(replay.value.validLines[index], line, `line ${index + 1} changed`);
    const parsed = JSON.parse(line) as { checksum: string };
    assert.equal(
      replay.value.state.events[index]!.checksum,
      parsed.checksum,
      `seq ${index + 1} checksum was recomputed`,
    );
  }
  assert.equal(replay.value.state.revision, replay.value.state.seq);
});

test("the v1 frozen payload upcasts to v2 and quarantines malformed checks", () => {
  const frozen = parsedEvents().find((event) => event.type === "todos.frozen")!;
  assert.equal(payloadVersionOf("todos.frozen", frozen.payload), 1);
  const upcast = upcastJournalEventPayload("todos.frozen", frozen.payload);
  assert.equal(upcast.ok, true, upcast.ok ? "" : upcast.error);
  if (!upcast.ok) return;
  assert.equal(upcast.fromVersion, 1);
  assert.equal(upcast.toVersion, 2);
  assert.equal(upcast.quarantined.length, INCIDENT_CHECKS.length);
  assert.deepEqual(
    upcast.quarantined.map((entry) => entry.command),
    INCIDENT_CHECKS,
  );
  const snapshot = upcast.payload.snapshot as FrozenExecutionSnapshot;
  assert.equal(snapshot.schemaVersion, FROZEN_EXECUTION_SCHEMA_VERSION);
  assert.deepEqual(snapshot.checks, [], "malformed checks never become commands");
  // The command acceptance value survives; the prose value becomes evidence.
  assert.deepEqual(snapshot.rows[0]!.checks.map((check) => check.command), ["npm test"]);
  assert.deepEqual(snapshot.rows[0]!.acceptanceCriteria, ["the wiring is documented"]);
});

test("the v1 snapshot fixture upcasts deterministically", () => {
  const first = readFrozenSnapshot(v1Snapshot());
  const second = readFrozenSnapshot(v1Snapshot());
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  if (!first.ok || !second.ok) return;
  assert.equal(first.fromVersion, 1);
  assert.deepEqual(first.snapshot, second.snapshot);
  assert.equal(first.quarantined.length, INCIDENT_CHECKS.length);
});

test("the Phase-A repair payload upcasts and applies to the v1 snapshot", () => {
  const events = parsedEvents();
  const frozen = events.find((event) => event.type === "todos.frozen")!;
  const control = events.find((event) => event.type === "run.control")!;

  const upcastSnapshot = upcastJournalEventPayload(frozen.type, frozen.payload);
  assert.equal(upcastSnapshot.ok, true);
  if (!upcastSnapshot.ok) return;
  const typed = upcastSnapshot.payload.snapshot as FrozenExecutionSnapshot;
  assert.deepEqual(typed.checks, [], "the malformed v1 checks stay quarantined");

  const repair = upcastJournalEventPayload(control.type, control.payload);
  assert.equal(repair.ok, true, repair.ok ? "" : repair.error);
  if (!repair.ok) return;
  assert.equal(repair.fromVersion, 1);
  assert.deepEqual(
    (repair.payload.typedNext as CheckSpec[]).map((check) => [check.command, check.kind]),
    [["npm run typecheck", "gate"]],
  );

  // The Phase-A amendment replaces the executable list of the v1 snapshot it
  // was written against, so it is applied to that shape (where `planChecks`
  // still holds the malformed bytes), not to the quarantined v2 projection.
  const legacy = v1Snapshot() as unknown as FrozenTodoSnapshot;
  const applied = applyCheckSpecRepair(legacy, control.payload);
  assert.equal(applied.ok, true, applied.ok ? "" : applied.error);
  if (!applied.ok) return;
  assert.equal(applied.value.changed, true);
  assert.deepEqual(applied.value.snapshot.planChecks, ["npm run typecheck"]);
  assert.deepEqual(applied.value.snapshot.planCheckSpecs, [
    { command: "npm run typecheck", kind: "gate" },
  ]);
  // Rows and workspaces are preserved byte-identically.
  assert.deepEqual(applied.value.snapshot.rows, legacy.rows);
  assert.deepEqual(applied.value.snapshot.workspaces, legacy.workspaces);

  // A repeated apply is a no-op, so replaying the journal is idempotent.
  const again = applyCheckSpecRepair(applied.value.snapshot, control.payload);
  assert.equal(again.ok, true);
  if (!again.ok) return;
  assert.equal(again.value.changed, false);
  assert.deepEqual(again.value.snapshot, applied.value.snapshot);
});

test("tampering with a payload or checksum is rejected on replay", () => {
  const parts = lines();
  const tamperedPayload = parts.map((line, index) => {
    if (index !== 1) return line;
    const event = JSON.parse(line) as ParsedEvent & { payload: Record<string, unknown> };
    return JSON.stringify({
      ...event,
      payload: { ...event.payload, digest: "1".repeat(64) },
    });
  });
  const payloadReplay = replayJournal(RUN_ID, `${tamperedPayload.join("\n")}\n`);
  assert.equal(payloadReplay.ok, true);
  if (payloadReplay.ok) {
    assert.equal(payloadReplay.value.state.truncated, 2, "the tampered line and tail are dropped");
    assert.equal(payloadReplay.value.state.seq, 1);
  }

  const tamperedChecksum = parts.map((line, index) => {
    if (index !== 2) return line;
    const event = JSON.parse(line) as ParsedEvent;
    return JSON.stringify({ ...event, checksum: "0".repeat(64) });
  });
  const checksumReplay = replayJournal(RUN_ID, `${tamperedChecksum.join("\n")}\n`);
  assert.equal(checksumReplay.ok, true);
  if (checksumReplay.ok) {
    assert.equal(checksumReplay.value.state.truncated, 1);
    assert.equal(checksumReplay.value.state.seq, 2);
  }

  // Re-signing the tampered payload does not make it trustworthy: the payload
  // validator still fails closed on the changed shape where it matters.
  const resealed = parts.map((line, index) => {
    if (index !== 1) return line;
    const event = JSON.parse(line) as ParsedEvent & { payload: Record<string, unknown> };
    const { checksum: _checksum, ...rest } = event;
    const next = {
      ...rest,
      payload: { ...event.payload, snapshot: { ...(event.payload.snapshot as object), version: 9 } },
    };
    return JSON.stringify({ ...next, checksum: checksumOf(next) });
  });
  const resealedReplay = replayJournal(RUN_ID, `${resealed.join("\n")}\n`);
  assert.equal(resealedReplay.ok, true);
  if (resealedReplay.ok) {
    const frozen = resealedReplay.value.state.events[1]!;
    const validation = validateJournalEventPayload(frozen.type, frozen.payload);
    assert.equal(validation.ok, false);
  }
});

test("an unknown payload version fails closed with its seq context", () => {
  const future = {
    executionId: "todo-exec-future",
    digest: "0".repeat(64),
    snapshot: { ...v1Snapshot(), version: 99 },
  };
  const validation = validateJournalEventPayload("todos.frozen", future);
  assert.equal(validation.ok, false);
  if (validation.ok) return;
  assert.equal(validation.code, "unknown_version");
  assert.match(validation.error, /version/i);

  const versionless = validateJournalEventPayload("todos.frozen", { executionId: "x", digest: "0" });
  assert.equal(versionless.ok, false);
});

test("json line shape is stable: re-serialising a replayed line is byte-identical", () => {
  for (const [index, line] of lines().entries()) {
    const parsed = JSON.parse(line) as ParsedEvent;
    assert.equal(JSON.stringify(parsed), line, `line ${index + 1} is not canonical JSON`);
  }
});
