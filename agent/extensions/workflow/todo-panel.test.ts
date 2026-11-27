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
  childTodoPanelScope,
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

test("empty child derivation covers Auto and every explicit display state", () => {
  const auto = deriveTodoPanel({ items: [], showWhenEmpty: true });
  assert.equal(auto.state, "expanded");
  assert.equal(auto.settled, false);
  assert.equal(auto.done, 0);
  assert.equal(auto.total, 0);
  assert.equal(auto.cancelled, 0);
  assert.equal(auto.next, undefined);
  assert.equal(auto.summary, "No todos yet · /todos expand");

  const expanded = deriveTodoPanel({
    items: [], showWhenEmpty: true,
    preference: "expanded", preferenceScope: "child-run:r1", scopeKey: "child-run:r1",
  });
  assert.equal(expanded.state, "expanded");
  assert.equal(expanded.settled, false);
  assert.equal(expanded.summary, "No todos yet · /todos expand");

  const collapsed = deriveTodoPanel({
    items: [], showWhenEmpty: true,
    preference: "collapsed", preferenceScope: "child-run:r1", scopeKey: "child-run:r1",
  });
  assert.equal(collapsed.state, "collapsed");
  assert.equal(collapsed.settled, false);
  assert.equal(collapsed.done, 0);
  assert.equal(collapsed.total, 0);
  assert.equal(collapsed.cancelled, 0);
  assert.equal(collapsed.next, undefined);
  assert.equal(collapsed.summary, "No todos yet · /todos expand");
  assert.equal(stripAnsi(renderTodoSummary(plainTheme, 80, collapsed)), "No todos yet · /todos expand");

  const hidden = deriveTodoPanel({
    items: [], showWhenEmpty: true,
    preference: "hidden", preferenceScope: "child-run:r1", scopeKey: "child-run:r1",
  });
  assert.equal(hidden.state, "hidden");
  assert.equal(hidden.settled, false);
  assert.equal(hidden.summary, "No todos yet · /todos expand");
});

test("empty child scope mismatch ignores stored collapsed/hidden and derives Auto", () => {
  for (const preference of ["collapsed", "hidden"] as const) {
    const result = deriveTodoPanel({
      items: [], showWhenEmpty: true,
      preference, preferenceScope: "child-run:old", scopeKey: "child-run:new",
    });
    assert.equal(result.state, "expanded", `${preference} from another run`);
    assert.equal(result.settled, false);
  }
});

test("nonempty child uses ordinary open/settled lifecycle and scoped choices", () => {
  const open = items([{ text: "Open" }]);
  const settled = items([{ text: "Done", completed: true }]);
  const options = { showWhenEmpty: true, preferenceScope: "child-run:r1", scopeKey: "child-run:r1" };
  assert.equal(deriveTodoPanel({ items: open, ...options }).state, "expanded");
  assert.equal(deriveTodoPanel({ items: settled, ...options }).state, "collapsed");
  assert.equal(deriveTodoPanel({ items: open, ...options, preference: "collapsed" }).state, "collapsed");
  assert.equal(deriveTodoPanel({ items: settled, ...options, preference: "expanded" }).state, "expanded");
});

test("empty ordinary parent remains hidden with or without explicit preference", () => {
  assert.equal(deriveTodoPanel({ items: [] }).state, "hidden");
  for (const preference of ["auto", "expanded", "collapsed", "hidden"] as const) {
    const parent = deriveTodoPanel({
      items: [], preference, preferenceScope: "plan-a", scopeKey: "plan-a",
    });
    assert.equal(parent.state, "hidden", preference);
    assert.equal(parent.settled, false);
    assert.equal(parent.done, 0);
    assert.equal(parent.total, 0);
    assert.equal(parent.cancelled, 0);
    assert.equal(parent.next, undefined);
    assert.equal(parent.summary, "");
    assert.equal(todoStatusText(parent), "");
  }
});

test("childTodoPanelScope scopes runs and supports an unbound session", () => {
  assert.equal(childTodoPanelScope("run-1"), "child-run:run-1");
  assert.equal(childTodoPanelScope("run-2"), "child-run:run-2");
  assert.notEqual(childTodoPanelScope("run-1"), childTodoPanelScope("run-2"));
  assert.equal(childTodoPanelScope(null), "child-session");
  assert.equal(childTodoPanelScope(undefined), "child-session");
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
  const planned = items([
    { text: "A", completed: true },
    { text: "B", completed: true },
    { text: "C" },
    { text: "D" },
    { text: "E" },
  ]);
  const plannedSummary = todoPanelSummary(planned, { planned: true });
  assert.equal(
    plannedSummary,
    "☐ Todos 2/5 · planned · not executing · /todos expand",
  );
  assert.doesNotMatch(plannedSummary, /not started/);
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
  assert.deepEqual(rows, ["☐ 1. One", "✖ 2. Two"]);
});

test("buildTodoRows never shows the execution marker in Plan mode", () => {
  const list = items([
    { text: "One", completed: true },
    { text: "Two", status: "in_progress" },
    { text: "Three" },
  ]);
  const rows = buildTodoRows(plainTheme, 80, list, "plan");
  assert.deepEqual(rows, ["☐ 2. Two", "☐ 3. Three"]);
  assert.ok(rows.every((row) => !row.includes("▶")), rows.join(" | "));
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

test("deriveTodoPanel: Plan mode renders a preview without a next step", () => {
  const list = items([
    { text: "A", completed: true },
    { text: "B" },
    { text: "C" },
  ]);
  const plan = deriveTodoPanel({ items: list, mode: "plan" });
  assert.equal(plan.next, undefined);
  assert.equal(
    plan.summary,
    "☐ Todos 1/3 · planned · not executing · /todos expand",
  );
  const build = deriveTodoPanel({ items: list, mode: "build" });
  assert.equal(build.next?.text, "B");
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
  assert.equal(
    todoStatusText(view({ state: "hidden", settled: false, done: 0, total: 0 }), { child: true }),
    "Child todos · no todos yet · hidden",
  );
  assert.equal(
    todoStatusText(view({ state: "expanded", settled: false, done: 1, total: 2 }), { child: true }),
    "☐ Child todos 1/2 · expanded",
  );
  assert.equal(
    todoStatusText(view({ state: "hidden", settled: false, done: 0, total: 0 })),
    "",
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

test("readPersistedTodoPanel round-trips valid child preference and scope independently", () => {
  for (const childPreference of ["auto", "expanded", "collapsed", "hidden"] as const) {
    const decoded = readPersistedTodoPanel({
      todoPanel: { childPreference, childPreferenceScope: "child-run:run-7" },
    });
    assert.equal(decoded.childPreference, childPreference);
    assert.equal(decoded.childPreferenceScope, "child-run:run-7");
  }

  const explicitAuto = readPersistedTodoPanel({ todoPanel: { childPreference: "auto" } });
  assert.equal(explicitAuto.childPreference, "auto");
  assert.equal(Object.hasOwn(explicitAuto, "childPreferenceScope"), false);
  const explicitNullScope = readPersistedTodoPanel({ todoPanel: { childPreferenceScope: null } });
  assert.equal(Object.hasOwn(explicitNullScope, "childPreference"), false);
  assert.equal(explicitNullScope.childPreferenceScope, null);

  const absent = readPersistedTodoPanel({ todoPanel: {} });
  assert.equal(Object.hasOwn(absent, "childPreference"), false);
  assert.equal(Object.hasOwn(absent, "childPreferenceScope"), false);
});

test("readPersistedTodoPanel omits invalid child fields without disturbing legacy parent decoding", () => {
  const badPreference = readPersistedTodoPanel({
    todoPanel: { preference: "collapsed", preferenceScope: "/plan/p.md", childPreference: "wat" },
  });
  assert.equal(Object.hasOwn(badPreference, "childPreference"), false);
  assert.equal(badPreference.preference, "collapsed");
  assert.equal(badPreference.preferenceScope, "/plan/p.md");

  const badScope = readPersistedTodoPanel({
    todoPanel: { childPreference: "hidden", childPreferenceScope: 42 },
  });
  assert.equal(badScope.childPreference, "hidden");
  assert.equal(Object.hasOwn(badScope, "childPreferenceScope"), false);

  const legacy = readPersistedTodoPanel({ todoPanel: { override: "hidden", overrideKey: "legacy-key" } });
  assert.equal(legacy.preference, "auto");
  assert.equal(legacy.preferenceScope, null);
  assert.equal(legacy.legacyOverride, "hidden");
  assert.equal(legacy.legacyOverrideKey, "legacy-key");
  assert.equal(Object.hasOwn(legacy, "childPreference"), false);
  assert.equal(Object.hasOwn(legacy, "childPreferenceScope"), false);
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
