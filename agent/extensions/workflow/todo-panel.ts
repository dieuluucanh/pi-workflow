/**
 * Workflow todo panel — pure presentation and state machine.
 *
 * The panel is a fixed widget in the host dock (`ctx.ui.setWidget`), so it can
 * never scroll with the transcript. Its job is therefore to be as small as
 * possible once the plan is finished:
 *
 * - expanded: full anchored rows while work is open;
 * - collapsed: one summary line the moment every item is completed/cancelled;
 * - hidden: no widget at all after the next user prompt (or by explicit user
 *   choice).
 *
 * Everything in this module is pure (except `truncateToWidth`) so the state
 * matrix and the rendered rows are unit-testable without the extension host.
 */

import { truncateToWidth } from "@earendil-works/pi-tui";
import { isDone, itemStatus, todoKey, todoRef, type TodoItem } from "./utils.ts";

export type TodoPanelState = "expanded" | "collapsed" | "hidden";
export type TodoPanelOverride = TodoPanelState | null;
export type TodoPanelMode = "plan" | "build" | null;

/** Row cap for the expanded panel (component factories bypass the host's 10-line limit). */
export const TODO_PANEL_MAX_ROWS = 15;

/** Minimal theme surface used by the renderers (keeps tests host-free). */
export interface TodoPanelTheme {
  fg(color: string, text: string): string;
  strikethrough(text: string): string;
}

export interface TodoPanelInput {
  items: TodoItem[];
  /** Explicit user choice; ignored when `overrideKey` no longer matches the list. */
  override?: TodoPanelOverride;
  /** Identity of the list the override belongs to (see `todoListKey`). */
  overrideKey?: string | null;
  /** A fresh user prompt arrived after the list settled. */
  promptAfterSettle?: boolean;
  /** Drives the ⚠ marker in the summary; the footer owns the actual warning. */
  stale?: boolean;
}

export interface TodoPanelView {
  state: TodoPanelState;
  settled: boolean;
  listKey: string;
  done: number;
  total: number;
  cancelled: number;
  next?: TodoItem;
  summary: string;
}

/** Shape persisted in the `workflow` custom entry. */
export interface PersistedTodoPanel {
  override: TodoPanelOverride;
  overrideKey: string | null;
  promptAfterSettle: boolean;
  completedSignature: string | null;
}

export const EMPTY_PERSISTED_TODO_PANEL: PersistedTodoPanel = {
  override: null,
  overrideKey: null,
  promptAfterSettle: false,
  completedSignature: null,
};

/** FNV-1a (32-bit) — short, stable, dependency-free. */
function shortHash(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** Display ref for a todo row (stable canonical GLOBAL step). */
function todoLabel(it: TodoItem, index: number): string {
  return todoRef(it) || String(it.step || index + 1);
}

function firstOpenItem(items: TodoItem[]): TodoItem | undefined {
  return items.find((it) => !isDone(it) && itemStatus(it) !== "cancelled");
}

function countDone(items: TodoItem[]): number {
  return items.filter((it) => isDone(it)).length;
}

function countCancelled(items: TodoItem[]): number {
  return items.filter((it) => itemStatus(it) === "cancelled").length;
}

/**
 * Identity of a todo list for override scoping. Deliberately excludes status:
 * marking a step done must not reset the user's collapse/hide choice. Adding,
 * removing, renaming or re-grouping steps changes the key and expires it.
 */
export function todoListKey(items: TodoItem[]): string {
  if (items.length === 0) return "0:empty";
  const basis = items
    .map(
      (it) =>
        `${todoRef(it)}\u0001${todoKey(it)}\u0001${it.group ?? ""}`,
    )
    .join("\u0002");
  return `${items.length}:${shortHash(basis)}`;
}

/**
 * Identity of one *completion event*: the list plus every item's status. Used
 * to send the Build-complete card once per revision instead of once per
 * `agent_end`.
 */
export function todoCompletionSignature(items: TodoItem[]): string {
  const statuses = items
    .map((it) => `${todoRef(it)}:${itemStatus(it)}`)
    .join(",");
  return shortHash(`${todoListKey(items)}|${statuses}`);
}

/** True when every item is completed or cancelled and the list is non-empty. */
export function isTodoListSettled(items: TodoItem[]): boolean {
  return (
    items.length > 0 &&
    items.every((it) => isDone(it) || itemStatus(it) === "cancelled")
  );
}

/**
 * Derive the panel state. Mode is intentionally not an input: it only affects
 * row styling, not whether the panel is expanded, collapsed or hidden.
 *
 * Precedence:
 * 1. empty list → hidden;
 * 2. explicit hidden → hidden, for any list state;
 * 3. settled + explicit expanded/collapsed → that state (survives the prompt);
 * 4. settled + a user prompt happened → hidden;
 * 5. settled → collapsed (the “all done” moment);
 * 6. open + explicit collapsed → collapsed;
 * 7. open → expanded.
 */
export function deriveTodoPanel(input: TodoPanelInput): TodoPanelView {
  const items = input.items;
  const listKey = todoListKey(items);
  const override =
    input.overrideKey != null && input.overrideKey === listKey
      ? (input.override ?? null)
      : null;
  const settled = isTodoListSettled(items);
  let state: TodoPanelState;
  if (items.length === 0) {
    state = "hidden";
  } else if (override === "hidden") {
    state = "hidden";
  } else if (settled) {
    if (override === "expanded" || override === "collapsed") {
      state = override;
    } else if (input.promptAfterSettle === true) {
      state = "hidden";
    } else {
      state = "collapsed";
    }
  } else {
    state = override === "collapsed" ? "collapsed" : "expanded";
  }

  return {
    state,
    settled,
    listKey,
    done: countDone(items),
    total: items.length,
    cancelled: countCancelled(items),
    next: firstOpenItem(items),
    summary: todoPanelSummary(items, { stale: input.stale }),
  };
}

/**
 * One-line summary. Theme-free so tests and notifications can assert exact
 * text; `renderTodoSummary` applies colors.
 */
export function todoPanelSummary(
  items: TodoItem[],
  opts: { stale?: boolean } = {},
): string {
  if (items.length === 0) return "";
  const done = countDone(items);
  const total = items.length;
  const cancelled = countCancelled(items);
  if (isTodoListSettled(items)) {
    const parts = [`☑ Todos ${done}/${total}`];
    if (cancelled > 0) parts.push(`${cancelled} cancelled`);
    parts.push("all done", "/todos expand");
    return parts.join(" · ");
  }
  const stale = opts.stale ? " ⚠" : "";
  const head = `☐ Todos ${done}/${total}${stale}`;
  const next = firstOpenItem(items);
  return next
    ? `${head} · next ${todoRef(next)}. ${next.text} · /todos expand`
    : `${head} · /todos expand`;
}

/** Render the collapsed one-liner for the widget. */
export function renderTodoSummary(
  theme: TodoPanelTheme,
  width: number,
  view: TodoPanelView,
): string {
  const tone = view.settled
    ? "success"
    : view.state === "collapsed"
      ? "accent"
      : "muted";
  return truncateToWidth(
    theme.fg(tone, view.summary),
    Math.max(1, width - 2),
    "…",
  );
}

/**
 * Rows for the expanded widget: group headers + labelled items, anchored on
 * the first incomplete item (including its group header), capped for the
 * terminal. Output is identical to the pre-refactor `buildTodoRows`.
 */
export function buildTodoRows(
  theme: TodoPanelTheme,
  width: number,
  items: TodoItem[],
  mode: TodoPanelMode,
): string[] {
  if (items.length === 0) return [];
  const contentWidth = Math.max(1, width - 2);
  type Row = { group?: string; item?: TodoItem; index: number };
  const rows: Row[] = [];
  let lastGroup: string | undefined;
  items.forEach((item, index) => {
    if (item.group && item.group !== lastGroup) {
      rows.push({ group: item.group, index });
      lastGroup = item.group;
    }
    rows.push({ item, index });
  });
  const firstUndone = items.findIndex(
    (t) => !isDone(t) && itemStatus(t) !== "cancelled",
  );
  const anchorIndex = firstUndone < 0 ? 0 : firstUndone;
  let startRow = rows.findIndex((r) => r.item && r.index === anchorIndex);
  if (startRow < 0) startRow = 0;
  if (startRow > 0 && rows[startRow - 1]?.group) startRow -= 1;
  const visible = rows.slice(startRow, startRow + TODO_PANEL_MAX_ROWS);
  const rendered = visible.map((row) => {
    if (row.group) {
      return truncateToWidth(
        theme.fg("muted", `── ${row.group}`),
        contentWidth,
        "…",
      );
    }
    const item = row.item as TodoItem;
    const ref = todoLabel(item, row.index);
    const status = itemStatus(item);
    const isCurrent = row.index === anchorIndex && !isDone(item);
    const prefix =
      isCurrent || status === "in_progress"
        ? theme.fg("accent", "▶ ")
        : status === "completed"
          ? theme.fg("success", "☑ ")
          : status === "cancelled"
            ? theme.fg("dim", "✖ ")
            : theme.fg("dim", "☐ ");
    const labelPart =
      item.label !== undefined && String(item.label) !== ref
        ? theme.fg("muted", ` (${item.label})`)
        : "";
    const body = `${ref}. ${item.text}${labelPart}`;
    let styled: string;
    if (isDone(item)) {
      styled = theme.fg("muted", theme.strikethrough(body));
    } else if (isCurrent && mode === "build") {
      styled = theme.fg("accent", body);
    } else if (mode === "plan" || mode === null) {
      styled = theme.fg("muted", body);
    } else {
      styled = body;
    }
    return truncateToWidth(`${prefix}${styled}`, contentWidth, "…");
  });
  const remaining = rows.length - (startRow + visible.length);
  if (remaining > 0) {
    rendered.push(theme.fg("muted", `… +${remaining} more`));
  }
  return rendered;
}

/**
 * Defensive reader for the persisted `todoPanel` object. Accepts either the
 * `workflow` entry data or the panel object itself. Unknown/missing fields fall
 * back to automatic behaviour; a mismatched `overrideKey` is restored verbatim
 * so `deriveTodoPanel` can expire it naturally.
 */
export function readPersistedTodoPanel(data: unknown): PersistedTodoPanel {
  const container =
    data && typeof data === "object"
      ? (data as { todoPanel?: unknown })
      : undefined;
  const raw =
    container && "todoPanel" in container && container.todoPanel
      ? container.todoPanel
      : data;
  const obj = raw && typeof raw === "object" ? (raw as any) : {};
  const override =
    obj.override === "expanded" ||
    obj.override === "collapsed" ||
    obj.override === "hidden"
      ? obj.override
      : null;
  return {
    override,
    overrideKey: typeof obj.overrideKey === "string" ? obj.overrideKey : null,
    promptAfterSettle: obj.promptAfterSettle === true,
    completedSignature:
      typeof obj.completedSignature === "string"
        ? obj.completedSignature
        : null,
  };
}
