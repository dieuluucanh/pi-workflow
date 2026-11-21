/**
 * Session-scoped TODO store tests (step 3).
 *
 * The store is the storage seam: one instance per extension factory call. These
 * tests pin isolation (two sessions cannot share a list), ownership, the
 * plan-merge rules and the persistence snapshot — while the existing TODO and
 * extension suites keep pinning the public `workflow_todo` behaviour.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { createTodoStore, assertListOwner } from "./todo-service.ts";
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

const PLAN = [
  "# Plan: demo",
  "",
  "## Plan Steps",
  "",
  "1. Scaffold the app",
  "2. Add the API",
  "3. Add the UI",
].join("\n");

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

test("store: the same plan merges and preserves completion", () => {
  const store = createTodoStore();
  const first = store.loadFromPlanMarkdown({
    markdown: PLAN,
    planPath: "/p/plan.md",
    cwd: "/p",
  });
  assert.equal(first.replaced, true);
  assert.equal(first.count, 3);

  store.setStatus(store.items[0]?.ref ?? "1", "completed");
  // An agent-added step is not in the plan, so the same-plan merge keeps it.
  const adHoc = store.add({ text: "manual follow-up" });
  assert.equal(adHoc.duplicate, false);
  assert.equal(store.items.length, 4);

  const second = store.loadFromPlanMarkdown({
    markdown: `${PLAN}\n4. Ship it`,
    planPath: "/p/plan.md",
    cwd: "/p",
  });
  assert.equal(second.replaced, false);
  assert.equal(second.count, 5);
  assert.equal(second.preserved, 1);
  assert.equal(store.items[0]?.status, "completed");
  assert.ok(store.items.some((entry) => entry.text === "manual follow-up"));
});

test("store: a different plan replaces the list", () => {
  const store = createTodoStore();
  store.loadFromPlanMarkdown({ markdown: PLAN, planPath: "/p/a.md", cwd: "/p" });
  store.setStatus("1", "completed");
  const next = store.loadFromPlanMarkdown({
    markdown: "# Plan: other\n\n## Plan Steps\n\n1. Only step",
    planPath: "/p/b.md",
    cwd: "/p",
  });
  assert.equal(next.replaced, true);
  assert.equal(store.items.length, 1);
  assert.equal(store.items[0]?.status, "pending");
});

test("store: a title-only plan synthesizes one placeholder step", () => {
  const store = createTodoStore();
  const result = store.loadFromPlanMarkdown({
    markdown: "# Plan: Login flow\n\nNo numbered steps here.",
    planPath: "/p/login.md",
    cwd: "/p",
  });
  assert.equal(result.count, 1);
  assert.equal(result.synthesized, true);
  assert.match(store.items[0]?.text ?? "", /Login flow/);
});

test("store: empty markdown leaves the list untouched", () => {
  const store = createTodoStore();
  store.replace([item(1, "keep me")]);
  const result = store.loadFromPlanMarkdown({ markdown: "", planPath: "/p/x.md", cwd: "/p" });
  assert.equal(result.replaced, false);
  assert.equal(result.count, 1);
  assert.deepEqual(store.items.map((entry) => entry.text), ["keep me"]);
});

test("store: wholesale update removes omitted items, like the public tool", () => {
  const store = createTodoStore();
  store.replace([item(1, "one"), item(2, "two"), item(3, "three")]);
  const result = store.update([
    { ref: "1", status: "in_progress" },
    { ref: "3", status: "completed" },
  ]);
  assert.equal(result.removed, 1);
  assert.deepEqual(store.items.map((entry) => entry.text), ["one", "three"]);
  assert.equal(store.doneCount(), 1);
  assert.equal(store.remainingCount(), 1);
});

test("store: done tags mark refs and settle the list", () => {
  const store = createTodoStore();
  store.replace([item(1, "one"), item(2, "two")]);
  const marked = store.markDoneTags("finished [DONE:1] and [DONE:2]");
  assert.equal(marked.marked, 2);
  assert.equal(store.isSettled(), true);
  assert.ok(store.signature()?.includes("completed"));
});

test("store: add is duplicate-aware, toggle flips, clear removes the plan link", () => {
  const store = createTodoStore();
  store.replace([item(1, "one")]);
  store.planPath = "/p/plan.md";

  const first = store.add({ text: "two" });
  assert.equal(first.duplicate, false);
  assert.equal(store.items.length, 2);
  const again = store.add({ text: "two" });
  assert.equal(again.duplicate, true);
  assert.equal(store.items.length, 2);

  assert.equal(store.setStatus("1", "completed")?.status, "completed");
  assert.equal(store.toggle("1")?.status, "pending");

  store.clear();
  assert.deepEqual(store.items, []);
  assert.equal(store.planPath, undefined);
});

test("store: snapshot round-trips and a partial restore keeps present fields", () => {
  const store = createTodoStore("worker");
  store.replace([item(1, "one")]);
  store.planPath = "/p/w.md";
  store.panelPreference = "collapsed";
  store.panelScope = "scope-w";
  store.promptAfterSettle = true;
  store.completedSignature = "sig";

  const snapshot = store.snapshot();
  assert.equal(snapshot.owner, "worker");
  assert.equal(snapshot.panel.preference, "collapsed");

  const restored = createTodoStore("worker");
  restored.restore(snapshot);
  assert.deepEqual(restored.items.map((entry) => entry.text), ["one"]);
  assert.equal(restored.panelPreference, "collapsed");
  assert.equal(restored.promptAfterSettle, true);

  // An older entry without panel fields must not erase the current state.
  restored.restore({ items: [item(2, "two")] });
  assert.equal(restored.panelPreference, "collapsed");
  assert.deepEqual(restored.items.map((entry) => entry.text), ["two"]);
});

test("store: ownership is explicit and enforced", () => {
  const roadmap = createTodoStore("roadmap");
  const worker = createTodoStore("worker");
  assert.doesNotThrow(() => assertListOwner(roadmap, "roadmap"));
  assert.throws(() => assertListOwner(worker, "roadmap"), /owner mismatch/);
  // A worker list cannot be mistaken for the ordinary Plan/Build list.
  assert.throws(() => assertListOwner(worker, "ordinary"), /owner mismatch/);
});
