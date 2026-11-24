/**
 * Cross-instance child-teardown handshake tests (plan step 25).
 *
 * The in-process Orchestrator child is a SECOND Workflow factory call in the
 * same process. Its cleanup must be reachable by the parent (so subagents die
 * with the child SDK session) without letting two sessions, or a resource
 * inspector load, share or steal each other's cleanup.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  CHILD_TEARDOWN_MAX_ENTRIES,
  CHILD_TEARDOWN_TTL_MS,
  createChildTeardownRegistry,
  orchestratorChildTeardowns,
  resetOrchestratorChildTeardownsForTests,
} from "./orchestrator-child-teardown.ts";

test("registry: entries are keyed by session and take() only returns its own", () => {
  const registry = createChildTeardownRegistry();
  const calls: string[] = [];
  registry.register("session-a", () => calls.push("a"));
  registry.register("session-b", () => calls.push("b"));

  assert.equal(registry.size(), 2);
  const a = registry.take("session-a");
  const b = registry.take("session-b");
  assert.equal(typeof a, "function");
  assert.equal(typeof b, "function");
  a?.();
  b?.();
  assert.deepEqual(calls, ["a", "b"]);
  // A take is consumed: a later session cannot run it twice.
  assert.equal(registry.take("session-a"), undefined);
  assert.equal(registry.size(), 0);
});

test("registry: take() is idempotent and never runs another session's cleanup", () => {
  const registry = createChildTeardownRegistry();
  let aCalls = 0;
  let bCalls = 0;
  registry.register("a", () => {
    aCalls += 1;
  });
  registry.register("b", () => {
    bCalls += 1;
  });

  assert.equal(registry.has("a"), true);
  assert.equal(registry.has("c"), false);
  registry.take("a")?.();
  assert.equal(registry.take("a"), undefined);
  assert.equal(aCalls, 1);
  assert.equal(bCalls, 0);
  // b is untouched by a's dispose (two sessions cannot share cleanup).
  assert.equal(registry.has("b"), true);
});

test("registry: re-register replaces only that session; a stale unregister cannot remove the newer entry", () => {
  const registry = createChildTeardownRegistry();
  const calls: string[] = [];
  const staleUnregister = registry.register("child", () => calls.push("old"));
  registry.register("child", () => calls.push("new"));

  staleUnregister();
  assert.equal(registry.has("child"), true);
  registry.take("child")?.();
  assert.deepEqual(calls, ["new"]);
});

test("registry: unregister is idempotent and scoped to the same closure", () => {
  const registry = createChildTeardownRegistry();
  const unregister = registry.register("child", () => {});
  unregister();
  unregister();
  assert.equal(registry.has("child"), false);
  assert.equal(registry.take("child"), undefined);
});

test("registry: bounded — the oldest entry is evicted, never unbounded growth", () => {
  const registry = createChildTeardownRegistry({ maxEntries: 2, ttlMs: 60_000 });
  registry.register("one", () => {});
  registry.register("two", () => {});
  registry.register("three", () => {});
  assert.equal(registry.size(), 2);
  assert.equal(registry.has("one"), false);
  assert.equal(registry.has("two"), true);
  assert.equal(registry.has("three"), true);
  // The documented default is a real bound, not "unbounded".
  assert.ok(CHILD_TEARDOWN_MAX_ENTRIES >= 1 && CHILD_TEARDOWN_MAX_ENTRIES <= 32);
});

test("registry: a child that never disposes cannot retain cleanup past the TTL", () => {
  let now = 1_000;
  const registry = createChildTeardownRegistry({ now: () => now, ttlMs: 5_000 });
  let calls = 0;
  registry.register("child", () => {
    calls += 1;
  });
  now += 4_999;
  assert.equal(registry.has("child"), true);
  now += 2;
  assert.equal(registry.has("child"), false);
  assert.equal(registry.take("child"), undefined);
  assert.equal(calls, 0);
  assert.ok(CHILD_TEARDOWN_TTL_MS > 0);
});

test("registry: clear() drops entries without running them", () => {
  const registry = createChildTeardownRegistry();
  let calls = 0;
  registry.register("child", () => {
    calls += 1;
  });
  registry.clear();
  assert.equal(registry.size(), 0);
  assert.equal(calls, 0);
});

test("singleton: is empty at module load (a losing builtin leaves no session state) and resettable", () => {
  resetOrchestratorChildTeardownsForTests();
  // Importing the factory module, or calling it without a child session_start,
  // must not publish any teardown entry.
  assert.equal(orchestratorChildTeardowns.size(), 0);
  assert.equal(orchestratorChildTeardowns.take("unknown"), undefined);

  const unregister = orchestratorChildTeardowns.register("child-1", () => {});
  assert.equal(orchestratorChildTeardowns.size(), 1);
  unregister();
  assert.equal(orchestratorChildTeardowns.size(), 0);
});
