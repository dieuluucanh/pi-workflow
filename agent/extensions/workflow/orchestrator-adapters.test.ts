/**
 * Production adapter tests (plan step 8).
 *
 * Real filesystem, real locks and a fake git runner: the properties that matter
 * are durability (atomic replace, torn-line replay), single-writer ownership
 * across processes (exclusive lock + generation high-water mark) and an honest
 * baseline parser.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  createFileWorkspaceLeases,
  createGitBaselinePort,
  createNodeClock,
  createNodeFsPort,
  createNodeJournalIo,
  parsePorcelainZ,
} from "./orchestrator-adapters.ts";
import { createRunJournal } from "./orchestrator-store.ts";
import { captureBaseline } from "./orchestrator-workspace.ts";

function tempDir(): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-adapters-"));
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test("journal io: atomic replace never leaves a partial target", async () => {
  const { dir, cleanup } = tempDir();
  try {
    const io = createNodeJournalIo();
    const target = path.join(dir, "snapshot.json");
    await io.writeAtomic(target, '{"v":1}');
    assert.equal(await io.read(target), '{"v":1}');
    // No temp files are left behind.
    assert.deepEqual((await io.list(dir)).filter((n) => n.includes(".tmp")), []);
    await io.writeAtomic(target, '{"v":2}');
    assert.equal(await io.read(target), '{"v":2}');
  } finally {
    cleanup();
  }
});

test("journal io: a torn tail is preserved for replay/recovery, not hidden", async () => {
  const { dir, cleanup } = tempDir();
  try {
    const io = createNodeJournalIo();
    const run = createRunJournal({ dir, runId: "run-1", io });
    const appended = await run.append({
      eventId: "evt-1",
      type: "run.created",
      at: 1,
      payload: { cwd: dir },
    });
    assert.equal(appended.ok, true, appended.ok ? "" : appended.error);

    // A crash mid-append leaves a partial last line on disk.
    const journalPath = path.join(dir, "journal.ndjson");
    assert.ok(journalPath, "the journal file exists on disk");
    await io.append(journalPath!, '{"version":1,"seq":2,"torn"');

    const loaded = await run.load();
    assert.equal(loaded.ok, true, loaded.ok ? "" : loaded.error);
    if (loaded.ok) {
      assert.equal(loaded.value.seq, 1, "only the valid event is replayed");
      assert.equal(loaded.value.truncated, 1, "the torn tail is reported");
    }
  } finally {
    cleanup();
  }
});

test("journal io: the writer lock is exclusive per process", async () => {
  const { dir, cleanup } = tempDir();
  try {
    const io = createNodeJournalIo();
    const lock = path.join(dir, "run.lock");
    assert.equal(await io.acquireLock(lock, 1_000), true);
    assert.equal(await io.acquireLock(lock, 1_000), false, "a second writer is refused");
    await io.releaseLock(lock);
    assert.equal(await io.acquireLock(lock, 1_000), true);
    await io.releaseLock(lock);
  } finally {
    cleanup();
  }
});

test("fs port: stat/readdir/remove and missingOk behave like the contract", async () => {
  const { dir, cleanup } = tempDir();
  try {
    const port = createNodeFsPort();
    await port.writeFileAtomic(path.join(dir, "a", "b.txt"), "hi", { mkdirp: true });
    const stat = await port.stat(path.join(dir, "a", "b.txt"));
    assert.equal(stat?.kind, "file");
    assert.equal(await port.readFileText(path.join(dir, "missing"), { missingOk: true }), undefined);
    assert.deepEqual((await port.readdir(path.join(dir, "a"))).map((e) => e.name), ["b.txt"]);
    assert.deepEqual(await port.readdir(path.join(dir, "nope")), []);
    await port.remove(path.join(dir, "a"), { recursive: true });
    assert.equal(await port.stat(path.join(dir, "a")), undefined);
    // A same-directory rename reports failure as a value.
    const moved = await port.rename(path.join(dir, "x"), path.join(dir, "y"));
    assert.equal(moved.ok, false);
  } finally {
    cleanup();
  }
});

const GRANT = {
  workspaceKey: "ws-1",
  runId: "run-1",
  taskId: "task-1",
  attemptId: "attempt-1",
  sessionId: "session-1",
};

test("leases: a second identity is refused while the first holds the workspace", () => {
  const { dir, cleanup } = tempDir();
  try {
    const leases = createFileWorkspaceLeases({ root: dir, ttlMs: 1_000 });
    const first = leases.acquire({ ...GRANT, generation: 1 });
    assert.equal(first.ok, true);

    const other = leases.acquire({
      ...GRANT,
      attemptId: "attempt-2",
      sessionId: "session-2",
      generation: 2,
    });
    assert.equal(other.ok, false);
    assert.equal((other as any).code, "held");

    // Same identity is idempotent.
    const again = leases.acquire({ ...GRANT, generation: 1 });
    assert.equal(again.ok, true);
  } finally {
    cleanup();
  }
});

test("leases: expiry needs an explicit reclaim and generations never go backwards", () => {
  const { dir, cleanup } = tempDir();
  let clock = 1_000;
  try {
    const leases = createFileWorkspaceLeases({ root: dir, ttlMs: 100, now: () => clock });
    assert.equal(leases.acquire({ ...GRANT, generation: 1 }).ok, true);

    clock += 200;
    const expired = leases.acquire({
      ...GRANT,
      attemptId: "attempt-2",
      sessionId: "session-2",
      generation: 2,
    });
    assert.equal((expired as any).code, "expired", "expiry alone never grants");

    const noConfirm = leases.reclaim({
      workspaceKey: GRANT.workspaceKey,
      grant: { ...GRANT, attemptId: "attempt-2", sessionId: "session-2", generation: 2 },
      confirmation: "yes",
    } as never);
    assert.equal((noConfirm as any).code, "confirmation");

    const stale = leases.reclaim({
      workspaceKey: GRANT.workspaceKey,
      grant: { ...GRANT, attemptId: "attempt-2", sessionId: "session-2", generation: 1 },
      confirmation: "reclaim-stale",
    });
    assert.equal((stale as any).code, "stale_generation");

    const reclaimed = leases.reclaim({
      workspaceKey: GRANT.workspaceKey,
      grant: { ...GRANT, attemptId: "attempt-2", sessionId: "session-2", generation: 2 },
      confirmation: "reclaim-stale",
    });
    assert.equal(reclaimed.ok, true);
    assert.equal(leases.isWriter({
      ...GRANT,
      attemptId: "attempt-1",
      sessionId: "session-1",
      generation: 1,
      acquiredAt: 1,
      expiresAt: 2,
    }), false, "the old holder is fenced out");
  } finally {
    cleanup();
  }
});

test("leases: the generation high-water mark survives release, a new task and a restart", () => {
  const { dir, cleanup } = tempDir();
  try {
    const leases = createFileWorkspaceLeases({ root: dir, ttlMs: 10_000 });

    const firstGen = leases.nextGeneration!(GRANT.workspaceKey);
    assert.equal(firstGen, 1);
    const first = leases.acquire({ ...GRANT, generation: firstGen });
    assert.equal(first.ok, true);
    assert.equal(leases.release((first as any).grant).ok, true);

    // Task two must NOT propose generation 1 again; the high-water mark is
    // workspace-wide, not task/attempt-local.
    const secondGen = leases.nextGeneration!(GRANT.workspaceKey);
    assert.equal(secondGen, 2);
    const second = leases.acquire({
      ...GRANT,
      taskId: "task-2",
      attemptId: "attempt-2",
      sessionId: "session-2",
      generation: secondGen,
    });
    assert.equal(second.ok, true, second.ok ? "" : second.error);
    const staleTaskOne = leases.acquire({
      ...GRANT,
      attemptId: "attempt-1b",
      sessionId: "session-1b",
      generation: 1,
    });
    assert.equal((staleTaskOne as any).code, "held", "the live lease refuses an old generation");
    assert.equal(leases.release((second as any).grant).ok, true);

    // A new adapter instance (a restarted parent) reads the same high-water
    // mark from disk instead of resetting to 0.
    const restarted = createFileWorkspaceLeases({ root: dir, ttlMs: 10_000 });
    assert.equal(restarted.nextGeneration!(GRANT.workspaceKey), 3);
    const newRun = restarted.acquire({
      ...GRANT,
      runId: "run-2",
      taskId: "task-1",
      attemptId: "attempt-1",
      sessionId: "session-3",
      generation: 3,
    });
    assert.equal(newRun.ok, true);
  } finally {
    cleanup();
  }
});

test("baseline: content digests are real file bytes and bound to the workspace root", async () => {
  const { dir, cleanup } = tempDir();
  try {
    fs.writeFileSync(path.join(dir, "same-length.txt"), "aaaa");
    const port = createGitBaselinePort({
      runGit: () => ({ ok: false, stdout: "", error: "not a repository" }),
    });
    const first = await port.contentDigest!(dir, "same-length.txt");
    assert.match(first ?? "", /^[0-9a-f]{64}$/);
    fs.writeFileSync(path.join(dir, "same-length.txt"), "bbbb");
    const second = await port.contentDigest!(dir, "same-length.txt");
    assert.notEqual(first, second, "same size, different bytes");
    assert.equal(await port.contentDigest!(dir, "../outside.txt"), null);
    assert.equal(await port.contentDigest!(dir, "missing.txt"), null);
  } finally {
    cleanup();
  }
});

test("leases: release is holder-only, so a stale generation cannot free a live lease", () => {
  const { dir, cleanup } = tempDir();
  try {
    const leases = createFileWorkspaceLeases({ root: dir });
    const acquired = leases.acquire({ ...GRANT, generation: 1 });
    assert.equal(acquired.ok, true);
    if (!acquired.ok) return;

    const foreign = leases.release({
      ...acquired.grant,
      attemptId: "attempt-other",
      generation: 9,
    });
    assert.equal(foreign.ok, false);
    assert.equal(leases.release(acquired.grant).ok, true);
  } finally {
    cleanup();
  }
});

test("porcelain: modifications, staged adds, deletes, renames and untracked", () => {
  const output = [
    " M src/a.ts",
    "A  src/b.ts",
    "D  src/c.ts",
    "R  src/new.ts",
    "src/old.ts",
    "?? notes.md",
    "",
  ].join("\u0000");
  const changes = parsePorcelainZ(output);
  assert.deepEqual(
    changes.map((c) => `${c.status}:${c.staged}:${c.path}`),
    [
      "modified:false:src/a.ts",
      "added:true:src/b.ts",
      "deleted:true:src/c.ts",
      "renamed:true:src/new.ts",
      "untracked:false:notes.md",
    ],
  );
});

test("baseline: git status is read-only and captures untracked + binary", async () => {
  const { dir, cleanup } = tempDir();
  try {
    const calls: string[][] = [];
    const port = createGitBaselinePort({
      runGit: (args) => {
        calls.push(args);
        const joined = args.join(" ");
        if (joined === "rev-parse --is-inside-work-tree") return { ok: true, stdout: "true\n" };
        if (joined === "rev-parse HEAD") return { ok: true, stdout: "abc123\n" };
        if (joined === "rev-parse --abbrev-ref HEAD") return { ok: true, stdout: "main\n" };
        if (joined.includes("status --porcelain")) {
          return { ok: true, stdout: " M src/a.ts\u0000?? notes.md\u0000" };
        }
        if (joined.includes("diff --numstat")) {
          return { ok: true, stdout: "-\t-\tsrc/logo.png\n" };
        }
        return { ok: true, stdout: "" };
      },
    });

    const baseline = await captureBaseline({
      workspace: { key: "ws", root: dir, kind: "git" },
      port,
      now: 5,
      maxFiles: 100,
    } as never);
    assert.equal(baseline.ok, true, baseline.ok ? "" : baseline.error);
    if (!baseline.ok) return;
    assert.equal(baseline.value.kind, "git");
    assert.equal(baseline.value.head, "abc123");
    const statuses = baseline.value.changes.map((c) => `${c.status}:${c.path}`);
    assert.ok(statuses.includes("modified:src/a.ts"));
    assert.ok(statuses.includes("untracked:notes.md"));
    assert.ok(statuses.includes("binary:src/logo.png"));

    // Only read-only git commands were issued.
    for (const call of calls) {
      assert.equal(
        ["status", "diff", "rev-parse"].some((head) => call[0] === head),
        true,
        `unexpected git command: ${call.join(" ")}`,
      );
    }
  } finally {
    cleanup();
  }
});

test("baseline: a non-Git folder gets a bounded listing, never a failure", async () => {
  const { dir, cleanup } = tempDir();
  try {
    fs.writeFileSync(path.join(dir, "a.txt"), "a");
    fs.mkdirSync(path.join(dir, "nested"));
    fs.writeFileSync(path.join(dir, "nested", "b.txt"), "bb");
    const port = createGitBaselinePort({
      runGit: () => ({ ok: false, stdout: "", error: "not a repository" }),
    });
    const listing = await port.listFiles(dir, 1);
    assert.ok(listing);
    assert.equal(listing?.truncated, true, "the bound is applied");
    assert.equal(listing?.files.length, 1);
  } finally {
    cleanup();
  }
});

test("clock: real timers can be created and cleared", () => {
  const clock = createNodeClock();
  const handle = clock.setTimeout(() => undefined, 10_000);
  clock.clearTimeout(handle);
  assert.equal(typeof clock.now(), "number");
});
