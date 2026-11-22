/**
 * SDK worker storage tests (plan step 9).
 *
 * The fake `SessionManager` mirrors the two behaviours that matter: the file is
 * lazy until the first entry is appended, and entries survive reopening. The
 * wake is deliberately not an SDK call: without a host adapter it must fail
 * closed rather than pretend a child started.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  MANAGED_KEY_INDEX,
  SESSION_BOOTSTRAP_MARKER,
  createSdkWorkerPort,
  loadPiSdkModule,
  resolveSessionManagerExport,
  type SdkLike,
  type SdkSessionManagerLike,
} from "./orchestrator-sdk.ts";
import {
  beginWorkerStart,
  deliverWake,
  markWorkerReady,
  prepareWorker,
  type WorkerLaunchInput,
} from "./orchestrator-worker.ts";

interface Entry {
  type?: string;
  customType?: string;
  data?: unknown;
}

function fakeSdk(dir: string) {
  const files = new Map<string, { id: string; entries: Entry[] }>();
  let seq = 0;

  const managerFor = (file: string, id: string, entries: Entry[]): SdkSessionManagerLike => ({
    getSessionId: () => id,
    getSessionFile: () => file,
    getEntries: () => entries,
    appendCustomEntry(customType, data) {
      entries.push({ type: "custom", customType, data });
      // Real SDK behaviour: setup entries stay in memory until a conversation
      // entry exists, so this deliberately does NOT write the file.
      return `entry-${entries.length}`;
    },
    appendSessionInfo(name) {
      entries.push({ type: "session_info", data: { name } });
      return `entry-${entries.length}`;
    },
    appendMessage(message) {
      entries.push({ type: "message", data: message });
      // First conversation entry materializes the lazy file.
      fs.writeFileSync(file, entries.map((entry) => JSON.stringify(entry)).join("\n"), "utf8");
      return `entry-${entries.length}`;
    },
  });

  const sdk: SdkLike = {
    SessionManager: {
      create(_cwd) {
        seq += 1;
        const id = `session-${seq}`;
        const file = path.join(dir, `${id}.jsonl`);
        const record = { id, entries: [] as Entry[] };
        files.set(file, record);
        return managerFor(file, id, record.entries);
      },
      open(file) {
        const record = files.get(file);
        if (!record) throw new Error(`unknown session file ${file}`);
        return managerFor(file, record.id, record.entries);
      },
    },
  };
  return { sdk, files };
}

function launchInput(_sessionFile: string): WorkerLaunchInput {
  return {
    runId: "run-1",
    taskId: "task-1",
    attemptId: "attempt-1",
    parentSessionRef: "parent-1",
    packetRef: "sha-abc",
    kickoff: { customType: "workflow-task-assignment", content: '{"task":"build"}' },
    roadmap: { path: "C:/docs/roadmap.md", digest: "a".repeat(64), revision: 1 },
    cwd: "C:/work/app",
    trust: "trust",
    model: { provider: "p", id: "builder", thinking: "medium" },
    now: 10,
  };
}

function tempDir(): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-sdk-worker-"));
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test("sdk loader: a class constructor is accepted (the reported bootstrap bug)", async () => {
  class ClassSessionManager {
    static create(): SdkSessionManagerLike {
      return {} as SdkSessionManagerLike;
    }
    static open(): SdkSessionManagerLike {
      return {} as SdkSessionManagerLike;
    }
  }
  assert.equal(typeof ClassSessionManager, "function");
  assert.equal(
    resolveSessionManagerExport({ SessionManager: ClassSessionManager }),
    ClassSessionManager,
  );
  const loaded = await loadPiSdkModule(async () => ({
    SessionManager: ClassSessionManager,
  }));
  assert.equal(loaded.SessionManager, ClassSessionManager);
});

test("sdk loader: object and default-namespace exports are accepted", async () => {
  const objectManager = {
    create: () => ({} as SdkSessionManagerLike),
    open: () => ({} as SdkSessionManagerLike),
  };
  assert.equal(
    resolveSessionManagerExport({ SessionManager: objectManager }),
    objectManager,
  );
  assert.equal(
    resolveSessionManagerExport({ default: { SessionManager: objectManager } }),
    objectManager,
  );
  assert.equal(resolveSessionManagerExport({ default: objectManager }), objectManager);
});

test("sdk loader: an export without create/open is rejected with a bounded reason", async () => {
  assert.equal(resolveSessionManagerExport({ SessionManager: class {} }), undefined);
  await assert.rejects(
    loadPiSdkModule(async () => ({ SessionManager: class {} }), "test-sdk"),
    (error: unknown) => {
      const text = error instanceof Error ? error.message : String(error);
      assert.match(text, /SessionManager is unavailable or invalid/);
      assert.match(text, /test-sdk/);
      assert.match(text, /SessionManager=function/);
      return true;
    },
  );
});

test("sdk loader: import failures name the package", async () => {
  await assert.rejects(
    loadPiSdkModule(async () => {
      throw new Error("module not found");
    }, "missing-sdk"),
    (error: unknown) => {
      const text = error instanceof Error ? error.message : String(error);
      assert.match(text, /missing-sdk/);
      assert.match(text, /module not found/);
      return true;
    },
  );
});

test("sdk port: probe validates the SDK without creating a session", async () => {
  const { dir, cleanup } = tempDir();
  try {
    const { sdk } = fakeSdk(dir);
    let loads = 0;
    const port = createSdkWorkerPort({
      loadSdk: async () => {
        loads += 1;
        return sdk;
      },
    });
    await port.probe?.();
    assert.equal(loads, 1);
    assert.deepEqual(fs.readdirSync(dir), [], "probe must not create a session file");

    const failing = createSdkWorkerPort({
      loadSdk: async () => {
        throw new Error("sdk missing");
      },
    });
    await assert.rejects(failing.probe?.() ?? Promise.resolve(), /sdk missing/);
  } finally {
    cleanup();
  }
});

test("sdk port: creation materializes the file before it is reported durable", async () => {
  const { dir, cleanup } = tempDir();
  try {
    const { sdk } = fakeSdk(dir);
    const port = createSdkWorkerPort({ loadSdk: async () => sdk });
    const created = await port.createSession({ cwd: dir, name: "Workflow task-1" });
    assert.ok(fs.existsSync(created.sessionFile));
    assert.match(created.sessionId, /^session-\d+$/);
    assert.equal(await port.exists(created.sessionFile), true);
    const keys = await port.listManagedKeys(created.sessionFile);
    assert.deepEqual(keys, []);
    // The conversation entry, not the setup marker, defeated the lazy file.
    const lines = fs
      .readFileSync(created.sessionFile, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    assert.ok(lines.some((entry) => entry.type === "message"));
  } finally {
    cleanup();
  }
});

test("sdk port: the REAL SDK materializes a durable idle session", async () => {
  const { dir, cleanup } = tempDir();
  try {
    // Built at runtime so the dependency stays a peer (not a bundled import).
    const sdkPackage = ["@earendil-works", "pi-coding-agent"].join("/");
    const loaded = await loadPiSdkModule(
      async () => await import(sdkPackage),
      sdkPackage,
    );
    const port = createSdkWorkerPort({ loadSdk: async () => loaded });
    const created = await port.createSession({ cwd: dir, name: "real worker" });
    assert.ok(created.sessionId.length > 0);
    assert.ok(
      fs.existsSync(created.sessionFile),
      "the real SDK must have written the session file",
    );
    assert.deepEqual(await port.listManagedKeys(created.sessionFile), []);
  } finally {
    cleanup();
  }
});

test("sdk port: managed entries keep their exact shape and are indexed", async () => {
  const { dir, cleanup } = tempDir();
  try {
    const { sdk, files } = fakeSdk(dir);
    const port = createSdkWorkerPort({ loadSdk: async () => sdk });
    const created = await port.createSession({ cwd: dir, name: "worker" });

    const managed = { version: 1, runId: "run-1" };
    await port.appendManagedEntry(created.sessionFile, "workflow-managed-session", "k1", managed);
    assert.equal(
      await port.hasManagedEntry(created.sessionFile, "workflow-managed-session", "k1"),
      true,
    );
    assert.equal(
      await port.hasManagedEntry(created.sessionFile, "workflow-managed-session", "k2"),
      false,
    );

    const entries = files.get(created.sessionFile)!.entries;
    const record = entries.find((entry) => entry.customType === "workflow-managed-session");
    assert.deepEqual(record?.data, managed, "the child reads the record unchanged");
    assert.ok(entries.some((entry) => entry.customType === MANAGED_KEY_INDEX));
    assert.ok(entries.some((entry) => entry.customType === SESSION_BOOTSTRAP_MARKER));
    assert.deepEqual(await port.listManagedKeys(created.sessionFile), ["k1"]);
  } finally {
    cleanup();
  }
});

test("sdk port: prepareWorker writes metadata once across a reopen", async () => {
  const { dir, cleanup } = tempDir();
  try {
    const { sdk } = fakeSdk(dir);
    const port = createSdkWorkerPort({ loadSdk: async () => sdk });
    const created = await port.createSession({ cwd: dir, name: "seed" });
    const first = await prepareWorker(launchInput(created.sessionFile), port, {
      existingSessionFile: created.sessionFile,
    });
    assert.equal(first.ok, true, first.ok ? "" : first.error);
    const before = await port.listManagedKeys(created.sessionFile);
    assert.equal(before.length, 3, "managed + assignment + roadmap keys");

    const again = await prepareWorker(launchInput(created.sessionFile), port, {
      existingSessionFile: created.sessionFile,
    });
    assert.equal(again.ok, true);
    const after = await port.listManagedKeys(created.sessionFile);
    assert.deepEqual(after.sort(), before.sort(), "no duplicate metadata on reopen");
  } finally {
    cleanup();
  }
});

test("sdk port: a wake without a host adapter fails closed, so no start is claimed", async () => {
  const { dir, cleanup } = tempDir();
  try {
    const { sdk } = fakeSdk(dir);
    const port = createSdkWorkerPort({ loadSdk: async () => sdk });
    const created = await port.createSession({ cwd: dir, name: "wake" });
    await assert.rejects(
      () =>
        port.sendWake(created.sessionFile, {
          customType: "workflow-task-start",
          content: "start-1",
          triggerTurn: true,
        }),
      /cannot start a turn/,
    );
  } finally {
    cleanup();
  }
});

test("sdk port: the host wake is called once with the correlated start id", async () => {
  const { dir, cleanup } = tempDir();
  try {
    const { sdk } = fakeSdk(dir);
    const wakes: Array<{ content: string; triggerTurn: boolean; sessionId: string }> = [];
    const port = createSdkWorkerPort({
      loadSdk: async () => sdk,
      wake: async (input) => {
        wakes.push({
          content: input.content,
          triggerTurn: input.triggerTurn,
          sessionId: input.sessionId,
        });
      },
    });
    const created = await port.createSession({ cwd: dir, name: "wake" });
    const prepared = await prepareWorker(launchInput(created.sessionFile), port, {
      existingSessionFile: created.sessionFile,
    });
    assert.equal(prepared.ok, true);
    if (!prepared.ok) return;
    const ready = markWorkerReady(prepared.value.state, {
      sessionId: "session-1",
      generation: 1,
      now: 11,
    });
    assert.equal(ready.ok, true);
    if (!ready.ok) return;
    const starting = beginWorkerStart(prepared.value.spec, ready.value, {
      leaseGeneration: 1,
      currentLeaseGeneration: 1,
      now: 12,
    });
    assert.equal(starting.ok, true);
    if (!starting.ok) return;

    const delivered = await deliverWake(prepared.value.spec, starting.value.state, port, {
      intentPersisted: true,
      now: 13,
    });
    assert.equal(delivered.ok, true, delivered.ok ? "" : delivered.error);
    assert.deepEqual(wakes, [
      {
        content: prepared.value.spec.taskStartId,
        triggerTurn: true,
        sessionId: "session-1",
      },
    ]);
  } finally {
    cleanup();
  }
});
