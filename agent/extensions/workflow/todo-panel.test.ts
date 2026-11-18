#!/usr/bin/env node
/**
 * Unit tests for the workflow todo panel state machine and renderers.
 * Run: node --test todo-panel.test.ts
 *
 * Imports the real pure functions from ./todo-panel.ts (Node type stripping).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  EMPTY_PERSISTED_TODO_PANEL,
  TODO_PANEL_MAX_ROWS,
  buildTodoRows,
  deriveTodoPanel,
  isTodoListSettled,
  readPersistedTodoPanel,
  renderTodoSummary,
  todoCompletionSignature,
  todoListKey,
  todoPanelContentKey,
  todoPanelSummary,
  todoStatusText,
  type TodoPanelTheme,
  type TodoPanelView,
} from "./todo-panel.ts";
import {
  ensureTodoLabels,
  itemStatus,
  type TodoItem,
} from "./utils.ts";

function items(spec: Array<Partial<TodoItem> & { text: string }>): TodoItem[] {
  return ensureTodoLabels(
    spec.map((s, i) => ({
      step: i + 1,
      text: s.text,
      completed: s.completed === true,
      status: s.status ?? (s.completed ? "completed" : "pending"),
      label: s.label,
      group: s.group,
      source: s.source ?? "plan",
      ref: s.ref,
    })) as TodoItem[],
  );
}

/** Identity theme: keeps assertions readable; strikethrough is explicit. */
const plainTheme: TodoPanelTheme = {
  fg: (_color, text) => text,
  strikethrough: (text) => `S(${text})`,
};

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function view(over: Partial<TodoPanelView> = {}): TodoPanelView {
  return {
    state: "collapsed",
    settled: true,
    listKey: "k",
    done: 1,
    total: 1,
    cancelled: 0,
    stale: false,
    summary: "☑ Todos 1/1 · all done · /todos expand",
    ...over,
  };
}

test("todoListKey ignores status but changes with text, ref and group", () => {
  const base = items([
    { text: "One", group: "A" },
    { text: "Two", group: "A" },
  ]);
  const key = todoListKey(base);

  const done = items([
    { text: "One", group: "A", completed: true },
    { text: "Two", group: "A", status: "cancelled" },
  ]);
  assert.equal(
    todoListKey(done),
    key,
    "status changes must not expire a panel override",
  );

  const renamed = items([
    { text: "One", group: "A" },
    { text: "Two renamed", group: "A" },
  ]);
  assert.notEqual(todoListKey(renamed), key);

  const regrouped = items([
    { text: "One", group: "B" },
    { text: "Two", group: "B" },
  ]);
  assert.notEqual(todoListKey(regrouped), key);

  const fewer = items([{ text: "One", group: "A" }]);
  assert.notEqual(todoListKey(fewer), key);
});

test("todoListKey is stable across calls and empty is stable", () => {
  const list = items([{ text: "One" }, { text: "Two" }]);
  assert.equal(todoListKey(list), todoListKey(list));
  assert.equal(todoListKey([]), todoListKey([]));
});

test("todoCompletionSignature changes with statuses", () => {
  const open = items([{ text: "One" }, { text: "Two" }]);
  const settled = items([
    { text: "One", completed: true },
    { text: "Two", completed: true },
  ]);
  assert.notEqual(todoCompletionSignature(open), todoCompletionSignature(settled));
  assert.equal(
    todoCompletionSignature(settled),
    todoCompletionSignature(
      items([
        { text: "One", completed: true },
        { text: "Two", completed: true },
      ]),
    ),
  );
});

test("isTodoListSettled: empty is not settled, done/cancelled are", () => {
  assert.equal(isTodoListSettled([]), false);
  assert.equal(
    isTodoListSettled(items([{ text: "A", completed: true }])),
    true,
  );
  assert.equal(
    isTodoListSettled(
      items([
        { text: "A", completed: true },
        { text: "B", status: "cancelled" },
      ]),
    ),
    true,
  );
  assert.equal(
    isTodoListSettled(items([{ text: "A", status: "cancelled" }])),
    true,
  );
  assert.equal(
    isTodoListSettled(
      items([
        { text: "A", completed: true },
        { text: "B", status: "in_progress" },
      ]),
    ),
    false,
  );
});

test("deriveTodoPanel: empty and explicit hidden always hide", () => {
  assert.equal(deriveTodoPanel({ items: [] }).state, "hidden");
  const list = items([{ text: "A" }]);
  assert.equal(
    deriveTodoPanel({ items: list, override: "hidden", overrideKey: todoListKey(list) })
      .state,
    "hidden",
  );
});

test("deriveTodoPanel: open list expands unless explicitly collapsed/hidden", () => {
  const list = items([
    { text: "A", completed: true },
    { text: "B" },
  ]);
  const key = todoListKey(list);
  assert.equal(deriveTodoPanel({ items: list }).state, "expanded");
  assert.equal(
    deriveTodoPanel({ items: list, override: "expanded", overrideKey: key })
      .state,
    "expanded",
  );
  assert.equal(
    deriveTodoPanel({ items: list, override: "collapsed", overrideKey: key })
      .state,
    "collapsed",
  );
  assert.equal(
    deriveTodoPanel({ items: list, override: "hidden", overrideKey: key })
      .state,
    "hidden",
  );
});

test("deriveTodoPanel: an override from another list is expired", () => {
  const list = items([{ text: "A" }, { text: "B" }]);
  assert.equal(
    deriveTodoPanel({
      items: list,
      override: "hidden",
      overrideKey: "stale-key",
    }).state,
    "expanded",
  );
  assert.equal(
    deriveTodoPanel({
      items: list,
      override: "expanded",
      overrideKey: null,
    }).state,
    "expanded",
    "a keyless override is ignored",
  );
});

test("deriveTodoPanel: settled collapses, prompt hides, explicit choice survives", () => {
  const list = items([
    { text: "A", completed: true },
    { text: "B", completed: true },
  ]);
  const key = todoListKey(list);

  assert.equal(deriveTodoPanel({ items: list }).state, "collapsed");
  assert.equal(
    deriveTodoPanel({ items: list, promptAfterSettle: false }).state,
    "collapsed",
  );
  assert.equal(
    deriveTodoPanel({ items: list, promptAfterSettle: true }).state,
    "hidden",
  );
  assert.equal(
    deriveTodoPanel({
      items: list,
      override: "expanded",
      overrideKey: key,
      promptAfterSettle: true,
    }).state,
    "expanded",
  );
  assert.equal(
    deriveTodoPanel({
      items: list,
      override: "collapsed",
      overrideKey: key,
      promptAfterSettle: true,
    }).state,
    "collapsed",
  );
  assert.equal(
    deriveTodoPanel({
      items: list,
      override: "hidden",
      overrideKey: key,
      promptAfterSettle: false,
    }).state,
    "hidden",
  );
  // A stale settled override expires to the automatic collapsed state.
  assert.equal(
    deriveTodoPanel({
      items: list,
      override: "expanded",
      overrideKey: "other",
      promptAfterSettle: false,
    }).state,
    "collapsed",
  );
});

test("deriveTodoPanel exposes counts, next item and the matching list key", () => {
  const list = items([
    { text: "A", completed: true },
    { text: "B", status: "cancelled" },
    { text: "C", status: "in_progress" },
  ]);
  const v = deriveTodoPanel({ items: list, stale: true });
  assert.equal(v.state, "expanded");
  assert.equal(v.settled, false);
  assert.equal(v.done, 1);
  assert.equal(v.cancelled, 1);
  assert.equal(v.total, 3);
  assert.equal(v.next?.text, "C");
  assert.equal(v.listKey, todoListKey(list));
  assert.match(v.summary, /⚠/);
});

test("todoPanelSummary exact one-line forms", () => {
  assert.equal(
    todoPanelSummary(
      items([
        { text: "A", completed: true },
        { text: "B", completed: true },
      ]),
    ),
    "☑ Todos 2/2 · all done · /todos expand",
  );
  assert.equal(
    todoPanelSummary(
      items([
        { text: "A", completed: true },
        { text: "B", status: "cancelled" },
      ]),
    ),
    "☑ Todos 1/2 · 1 cancelled · all done · /todos expand",
  );
  const open = items([
    { text: "A", completed: true },
    { text: "B" },
    { text: "C" },
  ]);
  assert.equal(
    todoPanelSummary(open),
    "☐ Todos 1/3 · next 2. B · /todos expand",
  );
  assert.equal(
    todoPanelSummary(open, { stale: true }),
    "☐ Todos 1/3 ⚠ · next 2. B · /todos expand",
  );
  assert.equal(todoPanelSummary([]), "");
});

test("renderTodoSummary applies the theme and truncates to the width", () => {
  const long = view({
    state: "collapsed",
    settled: false,
    summary: "☐ Todos 1/3 · next 2. A very long step title that will not fit",
  });
  const narrow = stripAnsi(renderTodoSummary(plainTheme, 30, long));
  assert.ok(narrow.endsWith("…"), narrow);
  assert.ok(narrow.length <= 28, `width=${narrow.length} text=${JSON.stringify(narrow)}`);

  const done = stripAnsi(renderTodoSummary(plainTheme, 80, view()));
  assert.equal(done, "☑ Todos 1/1 · all done · /todos expand");
});

test("buildTodoRows anchors on the first open item", () => {
  const list = items([
    { text: "One", completed: true },
    { text: "Two", completed: true },
    { text: "Three", status: "in_progress" },
    { text: "Four" },
  ]);
  const rows = buildTodoRows(plainTheme, 80, list, "build");
  assert.deepEqual(rows, ["▶ 3. Three", "☐ 4. Four"]);
});

test("buildTodoRows includes the group header of the anchor", () => {
  const list = items([
    { text: "One", group: "Phase A" },
    { text: "Two", group: "Phase B" },
  ]);
  const rows = buildTodoRows(plainTheme, 80, list, "build");
  assert.deepEqual(rows, ["── Phase A", "▶ 1. One", "── Phase B", "☐ 2. Two"]);
});

test("buildTodoRows renders cancelled items and muted plan rows", () => {
  const list = items([
    { text: "One" },
    { text: "Two", status: "cancelled" },
  ]);
  const rows = buildTodoRows(plainTheme, 80, list, "plan");
  assert.deepEqual(rows, ["▶ 1. One", "✖ 2. Two"]);
});

test("buildTodoRows caps the window and appends +N more", () => {
  const list = items(
    Array.from({ length: TODO_PANEL_MAX_ROWS + 5 }, (_v, i) => ({
      text: `Step ${i + 1}`,
    })),
  );
  const rows = buildTodoRows(plainTheme, 80, list, "build");
  assert.equal(rows.length, TODO_PANEL_MAX_ROWS + 1);
  assert.equal(rows.at(-1), "… +5 more");
});

test("buildTodoRows truncates each row to the widget width", () => {
  const list = items([{ text: "A".repeat(200) }]);
  const rows = buildTodoRows(plainTheme, 24, list, "build");
  assert.equal(rows.length, 1);
  const clean = stripAnsi(rows[0]);
  assert.ok(clean.endsWith("…"), clean);
  assert.ok(clean.length <= 22, `width=${clean.length} text=${JSON.stringify(clean)}`);
});

test("buildTodoRows prints the plan label only when it differs from the ref", () => {
  const list = items([{ text: "One", label: "2.3" }]);
  const rows = buildTodoRows(plainTheme, 80, list, "build");
  assert.equal(rows[0], "▶ 1. One (2.3)");
});

test("buildTodoRows keeps the completed-list fallback anchored at the top", () => {
  const list = items([
    { text: "One", completed: true },
    { text: "Two", completed: true },
  ]);
  const rows = buildTodoRows(plainTheme, 80, list, "build");
  assert.deepEqual(rows, ["☑ S(1. One)", "☑ S(2. Two)"]);
});

test("deriveTodoPanel: a same-scope preference survives list edits", () => {
  const list = items([{ text: "One" }, { text: "Two" }]);
  const renamed = items([{ text: "One renamed" }, { text: "Two" }]);
  assert.equal(
    deriveTodoPanel({
      items: renamed,
      preference: "hidden",
      preferenceScope: "/plan/a.md",
      scopeKey: "/plan/a.md",
    }).state,
    "hidden",
  );
  assert.equal(
    deriveTodoPanel({
      items: renamed,
      preference: "collapsed",
      preferenceScope: "/plan/a.md",
      scopeKey: "/plan/a.md",
    }).state,
    "collapsed",
  );
  assert.notEqual(todoListKey(list), todoListKey(renamed));
});

test("deriveTodoPanel: a different scope returns to automatic", () => {
  const list = items([{ text: "A" }, { text: "B" }]);
  assert.equal(
    deriveTodoPanel({
      items: list,
      preference: "hidden",
      preferenceScope: "/plan/old.md",
      scopeKey: "/plan/new.md",
    }).state,
    "expanded",
  );
  assert.equal(
    deriveTodoPanel({ items: list, preference: "auto", scopeKey: "session" }).state,
    "expanded",
  );
});

test("todoPanelContentKey changes with rows, state, mode and stale", () => {
  const base = items([{ text: "One" }]);
  const key = todoPanelContentKey({ items: base, state: "expanded", mode: "build" });
  assert.equal(
    todoPanelContentKey({ items: base, state: "expanded", mode: "build" }),
    key,
  );
  assert.notEqual(
    todoPanelContentKey({ items: items([{ text: "Two" }]), state: "expanded", mode: "build" }),
    key,
  );
  assert.notEqual(
    todoPanelContentKey({ items: base, state: "collapsed", mode: "build" }),
    key,
  );
  assert.notEqual(
    todoPanelContentKey({ items: base, state: "expanded", mode: "plan" }),
    key,
  );
  assert.notEqual(
    todoPanelContentKey({ items: base, state: "expanded", mode: "build", stale: true }),
    key,
  );
});

test("todoStatusText is compact and exact", () => {
  assert.equal(
    todoStatusText(
      view({
        state: "expanded",
        settled: false,
        done: 3,
        total: 12,
        summary: "☐ Todos 3/12 · next 4. Test · /todos expand",
      }),
    ),
    "☐ Todos 3/12 · expanded",
  );
  assert.equal(
    todoStatusText(view({ state: "hidden", settled: false, done: 3, total: 12, stale: true })),
    "☐ Todos 3/12 ⚠ · hidden",
  );
  assert.equal(
    todoStatusText(view({ state: "collapsed", settled: true, done: 1, total: 2, cancelled: 1 })),
    "☑ Todos 1/2 · 1 cancelled · collapsed",
  );
});

test("readPersistedTodoPanel: defaults, valid data and garbage", () => {
  assert.deepEqual(readPersistedTodoPanel(undefined), EMPTY_PERSISTED_TODO_PANEL);
  assert.deepEqual(readPersistedTodoPanel(null), EMPTY_PERSISTED_TODO_PANEL);
  assert.deepEqual(readPersistedTodoPanel({}), EMPTY_PERSISTED_TODO_PANEL);
  assert.deepEqual(
    readPersistedTodoPanel({ todoPanel: "nope" }),
    EMPTY_PERSISTED_TODO_PANEL,
  );
  assert.deepEqual(readPersistedTodoPanel({ todos: [] }), EMPTY_PERSISTED_TODO_PANEL);

  const stored = {
    preference: "hidden",
    preferenceScope: "/plan/a.md",
    promptAfterSettle: true,
    completedSignature: "deadbeef",
  };
  assert.deepEqual(readPersistedTodoPanel({ todoPanel: stored }), {
    ...stored,
    legacyOverride: null,
    legacyOverrideKey: null,
  });
  assert.deepEqual(readPersistedTodoPanel(stored), {
    ...stored,
    legacyOverride: null,
    legacyOverrideKey: null,
  });

  // A legacy entry exposes its choice and key for the caller to migrate.
  assert.deepEqual(
    readPersistedTodoPanel({
      todoPanel: {
        override: "hidden",
        overrideKey: "abc",
        promptAfterSettle: "yes",
        completedSignature: 42,
      },
    }),
    {
      preference: "auto",
      preferenceScope: null,
      promptAfterSettle: false,
      completedSignature: null,
      legacyOverride: "hidden",
      legacyOverrideKey: "abc",
    },
  );

  // Unknown preference values fall back to automatic.
  assert.equal(
    readPersistedTodoPanel({ todoPanel: { preference: "wat" } }).preference,
    "auto",
  );
});

test("readPersistedTodoPanel restores a mismatched key verbatim for expiry", () => {
  const restored = readPersistedTodoPanel({
    todoPanel: { override: "hidden", overrideKey: "old-list" },
  });
  assert.equal(restored.legacyOverrideKey, "old-list");
  const list = items([{ text: "A" }]);
  assert.equal(
    deriveTodoPanel({
      items: list,
      override: restored.legacyOverride,
      overrideKey: restored.legacyOverrideKey,
    }).state,
    "expanded",
  );
});

test("itemStatus is used, so legacy `completed` items are settled", () => {
  const legacy: TodoItem[] = [
    { step: 1, text: "A", completed: true, ref: "1" },
    { step: 2, text: "B", completed: true, ref: "2" },
  ];
  assert.equal(isTodoListSettled(legacy), true);
  assert.equal(itemStatus(legacy[0]), "completed");
  assert.equal(deriveTodoPanel({ items: legacy }).state, "collapsed");
});
