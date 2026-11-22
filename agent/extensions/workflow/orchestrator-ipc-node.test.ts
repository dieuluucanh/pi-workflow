/**
 * Local control transport tests (plan step 10).
 *
 * A real OS socket (named pipe on Windows, unix socket elsewhere) proves the
 * framing, deadlines and teardown. Authentication itself belongs to
 * `orchestrator-ipc.ts`; these tests assert the transport never invents it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { localEndpoint } from "./orchestrator-ipc.ts";
import { createControlClient, createControlServer } from "./orchestrator-ipc-node.ts";

function endpointFor(runId: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ipc-"));
  const resolved = localEndpoint({
    platform: process.platform,
    profileDir: dir,
    runId,
  });
  assert.equal(resolved.ok, true, resolved.ok ? "" : resolved.error);
  if (!resolved.ok) throw new Error("endpoint");
  fs.mkdirSync(resolved.value.privateDir, { recursive: true });
  return {
    endpoint: resolved.value,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

test("control transport: a request is answered with its correlated reply", { timeout: 8_000 }, async () => {
  const unique = `t${process.pid}-${Date.now().toString(36)}`;
  const { endpoint, cleanup } = endpointFor(unique);
  const server = createControlServer({
    endpoint,
    onMessage: (raw, reply) => {
      const record = raw as { requestId?: string; value?: number };
      reply({ requestId: record.requestId, doubled: (record.value ?? 0) * 2 });
    },
  });
  try {
    await server.start();
    const client = createControlClient({ endpoint, connectTimeoutMs: 2_000 });
    try {
      const answer = (await client.request({ requestId: "r1", value: 21 })) as {
        requestId: string;
        doubled: number;
      };
      assert.equal(answer.requestId, "r1");
      assert.equal(answer.doubled, 42);
      assert.equal(client.status().connected, true);
    } finally {
      client.close();
    }
  } finally {
    await server.stop();
    cleanup();
  }
});

test("control transport: the server reports its live clients and stops cleanly", { timeout: 8_000 }, async () => {
  const unique = `c${process.pid}-${Date.now().toString(36)}`;
  const { endpoint, cleanup } = endpointFor(unique);
  const server = createControlServer({
    endpoint,
    onMessage: (raw, reply) => {
      const record = raw as { requestId?: string };
      reply({ requestId: record.requestId, ok: true });
    },
  });
  try {
    await server.start();
    const client = createControlClient({ endpoint });
    try {
      await client.request({ requestId: "r1" });
      // Give the accept loop a tick to register the socket.
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(server.connections(), 1);
    } finally {
      client.close();
    }
    await server.stop();
    // A stopped server no longer answers.
    const late = createControlClient({ endpoint, connectTimeoutMs: 300 });
    try {
      await assert.rejects(() => late.request({ requestId: "r2" }, 300));
    } finally {
      late.close();
    }
  } finally {
    away(cleanup);
  }
});

function away(fn: () => void): void {
  try {
    fn();
  } catch {
    /* windows may keep the pipe briefly */
  }
}

test("control transport: an oversized frame is refused by the size limit", { timeout: 8_000 }, async () => {
  const unique = `o${process.pid}-${Date.now().toString(36)}`;
  const { endpoint, cleanup } = endpointFor(unique);
  const errors: unknown[] = [];
  const server = createControlServer({
    endpoint,
    limits: { maxBytes: 128 },
    onError: (error) => errors.push(error),
    onMessage: (_raw, reply) => reply({ ok: true }),
  });
  try {
    await server.start();
    const client = createControlClient({ endpoint, limits: { maxBytes: 128 } });
    try {
      await assert.rejects(
        () => client.request({ requestId: "big", payload: "x".repeat(512) }, 500),
        /too large/,
      );
    } finally {
      client.close();
    }
  } finally {
    await server.stop();
    cleanup();
  }
});

test("control transport: an unanswered request times out without hanging", { timeout: 8_000 }, async () => {
  const unique = `s${process.pid}-${Date.now().toString(36)}`;
  const { endpoint, cleanup } = endpointFor(unique);
  const server = createControlServer({ endpoint, onMessage: () => undefined });
  try {
    await server.start();
    const client = createControlClient({ endpoint });
    try {
      await assert.rejects(() => client.request({ requestId: "never" }, 150), /timed out/);
    } finally {
      client.close();
    }
  } finally {
    await server.stop();
    cleanup();
  }
});
