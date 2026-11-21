/**
 * Run journal tests (step 21): checksummed replay, torn/tampered lines, corrupt
 * snapshots, duplicate/stale writes, the writer lock, intent-vs-ack, acceptance
 * only from accepted events, content-addressed artifacts and branch-local refs.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  MAX_ARTIFACT_BYTES,
  createRunJournal,
  type JournalIo,
} from "./orchestrator-store.ts";

function memoryIo(): JournalIo & { files: Map<string, string>; lock(): void } {
  const files = new Map<string, string>();
  let locked = false;
  return {
    files,
    lock() {
      locked = true;
    },
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

function journal(io = memoryIo(), runId = "run-1") {
  return {
    io,
    value: createRunJournal({ dir: "C:/runs/run-1", runId, io }),
    runId,
  };
}

const event = (eventId: string, type: string, payload: unknown = {}, at = 1) => ({
  eventId,
  type: type as never,
  payload,
  at,
});

test("append and reload preserve order; acceptance comes only from events", async () => {
  const h = journal();
  const first = await h.value.append({
    ...event("e1", "task.accepted", { taskId: "task-1", evidenceId: "ev-1" }),
    expectedSeq: 0,
  });
  assert.equal(first.ok, true);
  await h.value.append(event("e2", "task.reported", { taskId: "task-1" }));

  const loaded = await h.value.load();
  assert.equal(loaded.ok, true);
  const state = (loaded as { ok: true; value: any }).value;
  assert.equal(state.seq, 2);
  assert.equal(state.revision, 2);
  assert.deepEqual(state.accepted, [
    { taskId: "task-1", evidenceId: "ev-1", eventId: "e1" },
  ]);
});

test("a duplicate event id is idempotent; a stale sequence is refused", async () => {
  const h = journal();
  await h.value.append({ ...event("e1", "run.created"), expectedSeq: 0 });
  const again = await h.value.append({ ...event("e1", "run.created"), expectedSeq: 0 });
  assert.equal(again.ok, true);
  assert.equal((again as { ok: true; value: { duplicate: boolean } }).value.duplicate, true);
  const stale = await h.value.append({ ...event("e2", "plan.approved"), expectedSeq: 0 });
  assert.equal(stale.ok, false);
  assert.equal((stale as { code: string }).code, "stale");
  assert.equal(((await h.value.load()) as { ok: true; value: any }).value.seq, 1);
});

test("a second writer is refused while the lock is held", async () => {
  const h = journal();
  h.io.acquireLock("any", 1);
  const result = await h.value.append(event("e1", "run.created"));
  assert.equal(result.ok, false);
  assert.equal((result as { code: string }).code, "locked");
  await h.io.releaseLock("any");
});

test("torn and tampered journal tails stop replay without advancing acceptance", async () => {
  const h = journal();
  await h.value.append(event("e1", "task.accepted", { taskId: "task-1", evidenceId: "ev-1" }));
  const path = [...h.io.files.keys()].find((key) => key.endsWith("journal.ndjson"))!;
  h.io.files.set(path, `${h.io.files.get(path)}\n{"version":1`);
  const torn = (await h.value.load()) as { ok: true; value: any };
  assert.equal(torn.value.truncated, 1);
  assert.equal(torn.value.accepted.length, 1);

  const good = JSON.parse((h.io.files.get(path) ?? "").split("\n")[0]!);
  const forged = { ...good, seq: 2, eventId: "e2", payload: { taskId: "task-2", evidenceId: "ev-2" }, checksum: "0".repeat(64) };
  h.io.files.set(path, `${JSON.stringify(good)}\n${JSON.stringify(forged)}\n`);
  const tampered = (await h.value.load()) as { ok: true; value: any };
  assert.equal(tampered.value.seq, 1);
  assert.deepEqual([...tampered.value.acceptedTaskIds], ["task-1"]);
});

test("unknown versions fail closed; a corrupt snapshot is recoverable", async () => {
  const h = journal();
  const path = [...h.io.files.keys()];
  void path;
  await h.value.append(event("e1", "task.accepted", { taskId: "task-1", evidenceId: "ev-1" }));
  const journalPath = [...h.io.files.keys()].find((key) => key.endsWith("journal.ndjson"))!;
  const snapshotPath = [...h.io.files.keys()].find((key) => key.endsWith("snapshot.json"))!;

  h.io.files.set(journalPath, `{"version":99,"runId":"run-1"}\n`);
  const unknown = await h.value.load();
  assert.equal(unknown.ok, false);
  assert.equal((unknown as { code: string }).code, "unknown_version");

  h.io.files.set(journalPath, "");
  await h.value.recover();
  await h.value.append(event("e1", "task.accepted", { taskId: "task-1", evidenceId: "ev-1" }));

  h.io.files.set(snapshotPath, "not-json");
  const corrupt = await h.value.load();
  assert.equal((corrupt as { code: string }).code, "corrupt");

  const recovered = await h.value.recover();
  assert.equal(recovered.ok, true);
  assert.deepEqual([...(recovered as { ok: true; value: any }).value.acceptedTaskIds], ["task-1"]);
  assert.equal((await h.value.load()).ok, true);
});

test("start intent and acknowledgement are separate; ack alone is inconsistent", async () => {
  const h = journal();
  await h.value.append(event("e1", "task.start.intent", { taskId: "task-1", attemptId: "a-1" }));
  let state = (await h.value.load()) as { ok: true; value: any };
  assert.equal(state.value.kickoff["task-1"].status, "uncertain");

  await h.value.append(event("e2", "task.start.ack", { taskId: "task-1", attemptId: "a-1" }));
  state = (await h.value.load()) as { ok: true; value: any };
  assert.equal(state.value.kickoff["task-1"].status, "acknowledged");

  await h.value.append(event("e3", "task.start.ack", { taskId: "task-2", attemptId: "a-2" }));
  state = (await h.value.load()) as { ok: true; value: any };
  assert.equal(state.value.kickoff["task-2"].status, "inconsistent");

  // An accepted event without evidence does not grant acceptance.
  await h.value.append(event("e4", "task.accepted", { taskId: "task-3" }));
  state = (await h.value.load()) as { ok: true; value: any };
  assert.equal(state.value.acceptedTaskIds.has("task-3"), false);
});

test("artifacts are content-addressed and bounded; refs are branch-local", async () => {
  const h = journal();
  const one = await h.value.putArtifact({ name: "packet", content: "hello" });
  const two = await h.value.putArtifact({ name: "packet-again", content: "hello" });
  assert.equal(one.ok && two.ok, true);
  assert.equal(
    (one as { ok: true; value: any }).value.sha256,
    (two as { ok: true; value: any }).value.sha256,
  );
  const hash = (one as { ok: true; value: any }).value.sha256;
  assert.equal((await h.value.getArtifact(hash) as { ok: true; value: string }).value, "hello");
  const huge = await h.value.putArtifact({ name: "big", content: "x".repeat(MAX_ARTIFACT_BYTES + 1) });
  assert.equal((huge as { code: string }).code, "too_large");

  await h.value.append(event("e1", "session.ref", { branchId: "b1", sessionRef: "s-1" }));
  await h.value.append(event("e2", "session.ref", { branchId: "b2", sessionRef: "s-2" }));
  const b1 = (await h.value.sessionRefs("b1")) as { ok: true; value: any[] };
  assert.deepEqual(b1.value.map((entry) => entry.sessionRef), ["s-1"]);
});
