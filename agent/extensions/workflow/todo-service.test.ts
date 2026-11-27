/**
 * Session-scoped TODO store tests (plain mutable list).
 *
 * The store is the storage seam: one instance per extension factory call. These
 * tests pin isolation (two sessions cannot share a list), ownership, the
 * wholesale-update rule and the persistence snapshot. There is no freeze, no
 * plan merge, no exclusion set and no recovery receipt.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  TODO_LIST_OWNERS,
  assertListOwner,
  createTodoStore,
} from "./todo-service.ts";
import type { TodoItem } from "./utils.ts";

const item = (step: number, text: string, over: Partial<TodoItem> = {}): TodoItem => ({
  step,
  text,
  completed: false,
  status: "pending",
  ref: String(step),
  label: String(step),
  source: "plan",
  ...over,
});

test("store: two instances never share items, plan path or panel state", () => {
  const a = createTodoStore("ordinary");
  const b = createTodoStore("ordinary");
  a.replace([item(1, "one")]);
  a.planPath = "/p/plan.md";
  a.panelPreference = "expanded";
  a.panelScope = "scope-a";

  assert.equal(b.items.length, 0);
  assert.equal(b.planPath, undefined);
  assert.equal(b.panelPreference, "auto");
  assert.equal(b.panelScope, null);

  b.replace([item(1, "other")]);
  assert.deepEqual(a.items.map((entry) => entry.text), ["one"]);
  assert.deepEqual(b.items.map((entry) => entry.text), ["other"]);
});

test("store: replace normalizes refs and dedupes", () => {
  const store = createTodoStore();
  store.replace([item(7, "late"), item(2, "early"), item(2, "early", { ref: "2b" })]);
  assert.deepEqual(store.items.map((entry) => entry.text), ["late", "early"]);
  // Refs are compacted to 1..N by ensureTodoLabels.
  assert.deepEqual(store.items.map((entry) => entry.ref), ["1", "2"]);
});

test("store: wholesale update removes omitted items", () => {
  const store = createTodoStore();
  store.replace([item(1, "one"), item(2, "two"), item(3, "three")]);
  const result = store.update([
    { ref: "1", text: "one" },
    { ref: "3", text: "three" },
  ]);
  assert.equal(result.refused, undefined);
  assert.deepEqual(store.items.map((entry) => entry.text), ["one", "three"]);
  assert.equal(result.removed, 1);
});

test("store: a ref-less wholesale rewrite is accepted (no plan-linked guard)", () => {
  const store = createTodoStore();
  store.replace([item(1, "one"), item(2, "two"), item(3, "three")]);
  const result = store.update([{ text: "rewritten one" }, { text: "rewritten two" }]);
  assert.equal(result.refused, undefined);
  assert.deepEqual(store.items.map((entry) => entry.text), [
    "rewritten one",
    "rewritten two",
  ]);
});

test("store: a stale expectedRevision is refused without mutating", () => {
  const store = createTodoStore();
  store.replace([item(1, "one")]);
  const revision = store.revision;
  const refused = store.update([{ text: "other" }], { expectedRevision: revision - 1 });
  assert.match(refused.refused ?? "", /re-read it and retry/);
  assert.deepEqual(store.items.map((entry) => entry.text), ["one"]);

  const applied = store.update([{ text: "other" }], { expectedRevision: revision });
  assert.equal(applied.refused, undefined);
  assert.deepEqual(store.items.map((entry) => entry.text), ["other"]);
});

test("store: done tags mark refs and settle the list", () => {
  const store = createTodoStore();
  store.replace([item(1, "one"), item(2, "two")]);
  const marked = store.markDoneTags("[DONE:1] finished");
  assert.equal(marked.marked, 1);
  assert.equal(store.doneCount(), 1);
  assert.equal(store.isSettled(), false);
  store.setStatus("2", "completed");
  assert.equal(store.isSettled(), true);
  assert.match(store.signature() ?? "", /^1:completed:one\|2:completed:two$/);
});

test("store: add is duplicate-aware, toggle flips, clear drops the plan link", () => {
  const store = createTodoStore();
  store.planPath = "/p/plan.md";
  const first = store.add({ text: "Do X" });
  assert.equal(first.duplicate, false);
  const again = store.add({ text: "do  x" });
  assert.equal(again.duplicate, true);
  assert.equal(again.item.step, first.item.step);

  const toggled = store.toggle(first.item.ref!);
  assert.equal(toggled?.completed, true);
  const back = store.toggle(first.item.ref!);
  assert.equal(back?.completed, false);

  store.clear();
  assert.deepEqual(store.items, []);
  assert.equal(store.planPath, undefined);
});

test("store: snapshot round-trips and a partial restore keeps present fields", () => {
  const store = createTodoStore("worker");
  store.replace([item(1, "one")]);
  store.planPath = "/p/plan.md";
  store.panelPreference = "collapsed";
  store.panelScope = "scope";
  store.completedSignature = "sig";
  const snapshot = store.snapshot();
  assert.deepEqual(snapshot.panel, {
    preference: "collapsed",
    preferenceScope: "scope",
    promptAfterSettle: false,
    completedSignature: "sig",
  });
  assert.deepEqual(Object.keys(snapshot).sort(), [
    "items",
    "owner",
    "panel",
    "planPath",
    "revision",
  ]);

  const restored = createTodoStore("worker");
  restored.restore(snapshot);
  assert.deepEqual(restored.items.map((entry) => entry.text), ["one"]);
  assert.equal(restored.planPath, "/p/plan.md");
  assert.equal(restored.panelPreference, "collapsed");

  // A later entry that omits a field must not erase the restored value.
  restored.restore({ items: [item(1, "two")], revision: restored.revision });
  assert.equal(restored.panelPreference, "collapsed");
  assert.equal(restored.planPath, "/p/plan.md");
  assert.deepEqual(restored.items.map((entry) => entry.text), ["two"]);
});

test("store: ownership is explicit and enforced", () => {
  assert.deepEqual([...TODO_LIST_OWNERS], ["ordinary", "worker"]);
  const worker = createTodoStore("worker");
  assert.doesNotThrow(() => assertListOwner(worker, "worker"));
  assert.throws(() => assertListOwner(worker, "ordinary"), /owner mismatch/);
  // A parent/roadmap list is an ordinary list now.
  const parent = createTodoStore("ordinary");
  assert.doesNotThrow(() => assertListOwner(parent, "ordinary"));
});
