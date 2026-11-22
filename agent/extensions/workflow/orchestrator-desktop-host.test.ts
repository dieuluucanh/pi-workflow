/**
 * Desktop session-host adapter tests (step 26): capability negotiation,
 * idempotent creation, bounded validation, timeout/late-result handling,
 * owned-only cleanup, and no automatic start/wake.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DESKTOP_SESSION_CHANNELS,
  createDesktopSessionHost,
  type DesktopClock,
  type DesktopSessionBus,
} from "./orchestrator-desktop-host.ts";
import type { RelatedSessionSpec } from "./session-host.ts";

function bus() {
  const listeners = new Map<string, Array<(payload: unknown) => unknown>>();
  const sent: Array<{ channel: string; payload: unknown }> = [];
  const value: DesktopSessionBus = {
    on(channel, handler) {
      const list = listeners.get(channel) ?? [];
      list.push(handler);
      listeners.set(channel, list);
      return () => {
        const index = list.indexOf(handler);
        if (index >= 0) list.splice(index, 1);
      };
    },
    emit(channel, payload) {
      sent.push({ channel, payload });
      for (const handler of [...(listeners.get(channel) ?? [])]) handler(payload);
    },
  };
  return { value, sent };
}

function clock() {
  let now = 1_000;
  let next = 1;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const value: DesktopClock = {
    now: () => now,
    setTimeout(callback, ms) {
      const id = next++;
      timers.set(id, { at: now + ms, callback });
      return id;
    },
    clearTimeout(handle) {
      timers.delete(handle as number);
    },
  };
  return {
    value,
    advance(ms: number) {
      now += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.at <= now) {
          timers.delete(id);
          timer.callback();
        }
      }
    },
  };
}

const caps = {
  version: 1,
  create: true,
  open: true,
  focus: true,
  inspect: true,
  interrupt: true,
  close: true,
  separateWindow: true,
  bootstrapBeforeStart: true,
  sourceBound: true,
  label: "Pi Desktop",
};

const spec = (over: Partial<RelatedSessionSpec> = {}): RelatedSessionSpec => ({
  requestId: "req-1",
  parentSessionRef: "session-1",
  relation: "child",
  title: "Task 1",
  cwd: "C:/work/app",
  dedupeKey: "task-1",
  bootstrap: [
    { customType: "workflow-managed-session", content: "{}", display: false },
    { customType: "workflow-task-assignment", content: "{}", display: false },
  ],
  ...over,
});

function harness(over: { reply?: boolean; autoCaps?: boolean; noGrant?: boolean } = {}) {
  const grant = {
    token: "grant-abc",
    ownerCommand: "workflow",
    sessionId: "session-1",
    epoch: 3,
  };
  const b = bus();
  const c = clock();
  const requests: Array<Record<string, unknown>> = [];
  let reply = over.reply ?? true;
  b.value.on(DESKTOP_SESSION_CHANNELS.request, (payload) => {
    requests.push(payload as Record<string, unknown>);
    if (reply) {
      b.value.emit(DESKTOP_SESSION_CHANNELS.result, {
        requestId: (payload as { requestId: string }).requestId,
        result: { ok: true, sessionRef: "tab-child", focused: true, reused: false },
      });
    }
    return undefined;
  });
  const host = createDesktopSessionHost({
    bus: b.value,
    ownerCommand: "workflow",
    clock: c.value,
    ...(over.noGrant ? {} : { grant: () => grant }),
  });
  // Announce AFTER the adapter subscribes (the real host does this on bind).
  if (over.autoCaps !== false) b.value.emit(DESKTOP_SESSION_CHANNELS.hello, caps);
  return {
    host,
    bus: b,
    requests,
    clock: c,
    setReply(value: boolean) {
      reply = value;
    },
  };
}

test("without a host announcement nothing is launched", async () => {
  const h = harness({ autoCaps: false });
  const capabilities = await h.host.capabilities();
  assert.equal(capabilities.create, false);
  const result = await h.host.createRelated(spec());
  assert.equal(result.ok, false);
  assert.equal((result as any).code, "unsupported");
  assert.equal(h.requests.length, 0);
  h.host.probe();
  assert.equal(h.bus.sent.at(-1)?.channel, DESKTOP_SESSION_CHANNELS.probe);
});

test("negotiated capabilities and a create request are bounded and idempotent", async () => {
  const h = harness();
  assert.equal((await h.host.capabilities()).create, true);
  const result = await h.host.createRelated(spec());
  assert.deepEqual(result, {
    ok: true,
    sessionRef: "tab-child",
    focused: true,
    reused: false,
  });
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0]!.ownerCommand, "workflow");
  assert.deepEqual(h.requests[0]!.spec, spec());

  // A retried request id replays the settled result without another emission.
  const again = await h.host.createRelated(spec());
  assert.deepEqual(again, result);
  assert.equal(h.requests.length, 1);

  // A pending duplicate joins the in-flight request.
  h.setReply(false);
  const pendingSpec = spec({ requestId: "req-2" });
  const first = h.host.createRelated(pendingSpec);
  const second = h.host.createRelated(pendingSpec);
  assert.equal(h.requests.length, 2);
  h.bus.value.emit(DESKTOP_SESSION_CHANNELS.result, {
    requestId: "req-2",
    result: { ok: true, sessionRef: "tab-2", focused: false, reused: true },
  });
  assert.deepEqual(await first, await second);
  assert.equal(h.requests.length, 2);
});

test("local validation rejects an unsafe spec before any wire request", async () => {
  const h = harness();
  const relative = await h.host.createRelated(spec({ cwd: "work/app" }));
  assert.equal((relative as any).code, "rejected");
  const unknown = await h.host.createRelated(
    spec({ bootstrap: [{ customType: "shell", content: "rm -rf /", display: false }] }),
  );
  assert.equal((unknown as any).code, "rejected");
  assert.equal(h.requests.length, 0);
});

test("timeout fails closed; a late result is ignored", async () => {
  const h = harness();
  h.setReply(false);
  const pending = h.host.createRelated(spec({ requestId: "req-late" }));
  h.clock.advance(20_000);
  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal((result as any).code, "failed");
  h.bus.value.emit(DESKTOP_SESSION_CHANNELS.result, {
    requestId: "req-late",
    result: { ok: true, sessionRef: "tab-late", focused: true, reused: false },
  });
  // Late result does not resurrect the completed promise or settle unknown ids.
  assert.equal(h.requests.length, 1);
});

test("cleanup closes only an owned, unstarted resource", async () => {
  const h = harness();
  assert.equal(await h.host.cleanupOwned({ sessionRef: "tab-1", reused: true, taskStarted: false }), false);
  assert.equal(await h.host.cleanupOwned({ sessionRef: "tab-1", reused: false, taskStarted: true }), false);
  const closed = await h.host.cleanupOwned({
    sessionRef: "tab-1",
    reused: false,
    taskStarted: false,
  });
  assert.equal(closed, true);
  assert.equal(h.requests.at(-1)!.operation, "close");
});

test("open/focus/inspect map to the wire protocol without starting work", async () => {
  const h = harness();
  assert.equal((await h.host.open("tab-child")).ok, true);
  assert.equal(await h.host.focus("tab-child"), true);
  const inspected = await h.host.inspect("tab-child");
  assert.equal(inspected.ok, true);
  assert.equal(await h.host.interrupt("tab-child"), true);
  assert.equal(await h.host.close("tab-child"), true);
  assert.deepEqual(
    h.requests.map((request) => request.operation),
    ["open", "focus", "inspect", "interrupt", "close"],
  );
  // No wake/start channel: the adapter cannot launch an assignment turn.
  assert.equal(
    h.bus.sent.some((entry) => entry.channel === "workflow-task-start"),
    false,
  );
});

test("dispose cancels pending requests and stops listening", async () => {
  const h = harness();
  h.setReply(false);
  const pending = h.host.createRelated(spec({ requestId: "req-dispose" }));
  h.host.dispose();
  assert.equal((await pending as any).code, "cancelled");
  const after = await h.host.createRelated(spec({ requestId: "req-after" }));
  assert.equal((after as any).code, "cancelled");
  assert.equal(h.requests.length, 1);
});

// ── Host-issued grant (plan step 12) ─────────────────────────────────

test("grant: a session without a host grant sends nothing and fails closed", async () => {
  const h = harness({ noGrant: true });
  const result = await h.host.createRelated(spec());
  assert.equal(result.ok, false);
  assert.equal((result as any).code, "unsupported");
  assert.match((result as any).reason, /capability grant/);
  assert.equal(h.requests.length, 0, "the wire was never touched");
});

test("grant: the request carries the host-issued grant and nothing else proves it", async () => {
  const h = harness();
  const result = await h.host.createRelated(spec());
  assert.equal(result.ok, true);
  const sent = h.requests[0] as { grant?: { token?: string; ownerCommand?: string } };
  assert.equal(sent.grant?.token, "grant-abc");
  assert.equal(sent.grant?.ownerCommand, "workflow");
  // The owner name alone is still present, but the host now gates on the grant.
  assert.equal((h.requests[0] as { ownerCommand?: string }).ownerCommand, "workflow");
});
