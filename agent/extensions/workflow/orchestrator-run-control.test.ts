/**
 * Run control tests (integration steps 13/17).
 *
 * These use the REAL local transport (named pipe on Windows, unix socket
 * elsewhere) so framing, deadlines and the ready → start → ack handshake are
 * exercised, not simulated. No child Pi process is started.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

import {
  grantFileFor,
  readWorkerGrant,
  createChildControl,
  createRunControl,
} from "./orchestrator-run-control.ts";

let runSeq = 0;

function tempProfile(): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-run-control-"));
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function uniqueRunId(): string {
  runSeq += 1;
  return `rc-test-${process.pid}-${runSeq}`;
}

test("control: ready → one sealed start → ack, and a candidate event reaches the parent", async () => {
  const { dir, cleanup } = tempProfile();
  const runId = uniqueRunId();
  const parent = createRunControl({ profileDir: dir, runId, platform: process.platform });
  const events: string[] = [];
  const control = createRunControl({
    profileDir: dir,
    runId,
    platform: process.platform,
    onEvent: (event) => {
      events.push(event.type);
    },
  });
  try {
    assert.deepEqual(await control.start(), { ok: true });
    const prepared = await control.prepareGrant({
      taskId: "task-1",
      attemptId: "attempt-1",
      sessionId: "session-1",
      generation: 3,
      taskStartId: "start-abc",
    });
    assert.equal(prepared.ok, true);
    if (!prepared.ok) return;

    // Only the reference belongs in session metadata; the secret is in a
    // private 0600 file.
    assert.equal(prepared.grantRef, grantFileFor(dir, runId, "session-1"));
    assert.ok(fs.existsSync(prepared.grantRef));
    const read = readWorkerGrant(prepared.grantRef);
    assert.equal(read.ok, true);
    if (!read.ok) return;
    assert.equal(read.value.secret, prepared.grant.secret);
    assert.equal(read.value.leaseGeneration, 3);

    const wait = control.awaitStart({ sessionId: "session-1", timeoutMs: 5_000 });
    let authorized = 0;
    const child = createChildControl({
      grant: prepared.grant,
      onStart: () => {
        authorized += 1;
        return true;
      },
      connectTimeoutMs: 3_000,
    });
    const started = await child.start();
    assert.deepEqual(started, { ok: true });
    assert.equal(authorized, 1);
    assert.deepEqual(await wait, { ok: true, acknowledged: true });

    assert.equal(await child.send("candidate", { candidateId: "c1" }), true);
    assert.deepEqual(events, ["candidate"]);
    child.close();
  } finally {
    await control.stop();
    await parent.stop();
    cleanup();
  }
});

test("control: a forged frame is refused before any event callback", async () => {
  const { dir, cleanup } = tempProfile();
  const runId = uniqueRunId();
  const events: string[] = [];
  const control = createRunControl({
    profileDir: dir,
    runId,
    platform: process.platform,
    onEvent: (event) => {
      events.push(event.type);
    },
  });
  try {
    await control.start();
    const prepared = await control.prepareGrant({
      taskId: "task-1",
      attemptId: "attempt-1",
      sessionId: "session-1",
      generation: 1,
      taskStartId: "start-1",
    });
    assert.equal(prepared.ok, true);
    if (!prepared.ok) return;

    const endpoint = control.endpoint();
    const reply = await new Promise<string>((resolve, reject) => {
      const socket = net.createConnection({ path: endpoint.path });
      socket.once("error", reject);
      socket.once("connect", () => {
        socket.write(
          `${JSON.stringify({
            requestId: "forged",
            version: 1,
            messageId: "forged-1",
            seq: 1,
            type: "candidate",
            runId,
            taskId: "task-1",
            attemptId: "attempt-1",
            sessionId: "session-1",
            generation: 1,
            leaseGeneration: 1,
            sentAt: Date.now(),
            payload: {},
            auth: { scheme: "hmac-sha256", mac: "0".repeat(64) },
          })}\n`,
        );
      });
      socket.on("data", (chunk) => {
        socket.destroy();
        resolve(chunk.toString("utf8").trim());
      });
      setTimeout(() => {
        socket.destroy();
        reject(new Error("no reply to the forged frame"));
      }, 3_000);
    });
    const parsed = JSON.parse(reply);
    assert.equal(parsed.ok, false);
    assert.match(String(parsed.error), /auth|authenticated/);
    assert.deepEqual(events, []);
  } finally {
    await control.stop();
    cleanup();
  }
});

test("control: a delivered-but-unacknowledged start is uncertain, never failed", async () => {
  const { dir, cleanup } = tempProfile();
  const runId = uniqueRunId();
  const control = createRunControl({ profileDir: dir, runId, platform: process.platform });
  try {
    await control.start();
    const prepared = await control.prepareGrant({
      taskId: "task-1",
      attemptId: "attempt-1",
      sessionId: "session-1",
      generation: 1,
      taskStartId: "start-1",
    });
    assert.equal(prepared.ok, true);
    if (!prepared.ok) return;

    const wait = control.awaitStart({ sessionId: "session-1", timeoutMs: 400 });
    const child = createChildControl({
      grant: prepared.grant,
      // The worker is not ready: no acknowledgement may be sent.
      onStart: () => false,
      connectTimeoutMs: 2_000,
    });
    const started = await child.start();
    assert.equal(started.ok, false);
    const outcome = await wait;
    assert.equal(outcome.ok, false);
    if (outcome.ok) return;
    assert.equal(outcome.delivered, true);
    assert.equal(outcome.uncertain, true);
    child.close();
  } finally {
    await control.stop();
    cleanup();
  }
});
