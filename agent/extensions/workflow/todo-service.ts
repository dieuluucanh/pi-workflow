/**
 * Workflow Extension — session-scoped TODO store (plain mutable list).
 *
 * One instance per session, explicit ownership, and the pure helpers from
 * `utils.ts` for every mutation. There is no freeze, no plan digest, no
 * exclusion set and no recovery receipt: the model owns a mutable list and the
 * store only remembers it.
 *
 * Ownership stays explicit:
 *
 *   - `ordinary` — a normal Plan/Build/parent list. `workflow_todo` drives it.
 *   - `worker`   — a child session's task-local list. It cannot touch parent
 *                  state or trigger a parent commit.
 *
 * The store holds no module-level state, so two sessions (or a parent and its
 * child in one process) can never share items, ref numbering or panel
 * preferences.
 */

import {
  applyTodoUpdate,
  dedupeTodoItems,
  ensureTodoLabels,
  isDone,
  itemStatus,
  markCompletedRefs,
  resolveTodoRef,
  setTodoStatus,
  todoKey,
  type TodoItem,
  type TodoRefResolution,
  type TodoStatus,
  type TodoUpdateEntry,
} from "./utils.ts";

/** Which list a store instance owns. */
export const TODO_LIST_OWNERS = ["ordinary", "worker"] as const;
export type TodoListOwner = (typeof TODO_LIST_OWNERS)[number];

/** The panel preference values `/todos` accepts (presentation only). */
export type TodoPanelPreference = "auto" | "expanded" | "collapsed" | "hidden";

/** Everything a session persists about its list. */
export interface TodoStoreSnapshot {
  owner: TodoListOwner;
  items: TodoItem[];
  /** Display-only reminder of the plan the list came from. */
  planPath?: string;
  /** Monotonic list revision; a stale expected revision is refused. */
  revision?: number;
  panel: {
    preference: TodoPanelPreference;
    preferenceScope: string | null;
    promptAfterSettle: boolean;
    completedSignature: string | null;
  };
}

export interface TodoStore {
  readonly owner: TodoListOwner;

  /** The live list. Replaced by `replace`/`update`; never mutated by callers. */
  items: TodoItem[];
  /** Plan file the list is displayed against; display-only. */
  planPath: string | undefined;
  /** Monotonic list revision; bumped by every authoritative mutation. */
  revision: number;

  // Panel presentation. Kept beside the list because it is scoped to it.
  panelPreference: TodoPanelPreference;
  panelScope: string | null;
  promptAfterSettle: boolean;
  completedSignature: string | null;

  /** Replace the whole list (already-extracted steps are normalized). */
  replace(items: TodoItem[]): void;
  /** Wholesale update: omitted items are removed. */
  update(
    incoming: TodoUpdateEntry[],
    options?: { expectedRevision?: number },
  ): ReturnType<typeof applyTodoUpdate>;
  /** Mark `[DONE:ref]` tags from assistant text. */
  markDoneTags(text: string): ReturnType<typeof markCompletedRefs>;
  resolve(ref: string): TodoRefResolution;
  setStatus(ref: string, status: TodoStatus): TodoItem | undefined;
  toggle(ref: string): TodoItem | undefined;
  add(input: { text: string; group?: string; label?: string }): {
    item: TodoItem;
    duplicate: boolean;
  };
  clear(): void;

  doneCount(): number;
  remainingCount(): number;
  isSettled(): boolean;
  /** Settled-list signature; a status change produces a new one. */
  signature(): string | null;

  snapshot(): TodoStoreSnapshot;
  restore(snapshot: Partial<TodoStoreSnapshot>): void;
}

export function createTodoStore(owner: TodoListOwner = "ordinary"): TodoStore {
  const store: TodoStore = {
    owner,
    items: [],
    planPath: undefined,
    revision: 0,
    panelPreference: "auto",
    panelScope: null,
    promptAfterSettle: false,
    completedSignature: null,

    replace(items) {
      store.items = ensureTodoLabels(dedupeTodoItems(items));
      store.revision += 1;
    },

    update(incoming, options) {
      if (
        options?.expectedRevision !== undefined &&
        options.expectedRevision !== store.revision
      ) {
        return {
          items: [...store.items],
          added: 0,
          removed: 0,
          kept: 0,
          normalized: 0,
          warnings: [],
          refused: `The list changed (revision ${store.revision}, expected ${options.expectedRevision}); re-read it and retry.`,
          revision: store.revision,
        };
      }
      const result = applyTodoUpdate(store.items, incoming);
      store.items = result.items;
      store.revision += 1;
      return { ...result, revision: store.revision };
    },

    markDoneTags(text) {
      return markCompletedRefs(text, store.items);
    },

    resolve(ref) {
      return resolveTodoRef(store.items, ref);
    },

    setStatus(ref, status) {
      const resolved = resolveTodoRef(store.items, ref);
      if (!resolved.item) return undefined;
      setTodoStatus(resolved.item, status);
      return resolved.item;
    },

    toggle(ref) {
      const resolved = resolveTodoRef(store.items, ref);
      if (!resolved.item) return undefined;
      setTodoStatus(resolved.item, isDone(resolved.item) ? "pending" : "completed");
      return resolved.item;
    },

    add(input) {
      const text = input.text.trim();
      const key = todoKey({ text, group: input.group });
      const existing = store.items.find((item) => todoKey(item) === key);
      if (existing) return { item: existing, duplicate: true };
      const step = store.items.reduce((max, item) => Math.max(max, item.step), 0) + 1;
      const item: TodoItem = {
        step,
        text,
        completed: false,
        status: "pending",
        ref: String(step),
        label: input.label ? String(input.label) : String(step),
        ...(input.group === undefined ? {} : { group: input.group }),
        source: "agent",
      };
      store.items = [...store.items, item];
      return { item, duplicate: false };
    },

    clear() {
      store.items = [];
      store.planPath = undefined;
      store.revision += 1;
    },

    doneCount() {
      return store.items.filter((item) => isDone(item)).length;
    },

    remainingCount() {
      return store.items.filter(
        (item) => !isDone(item) && itemStatus(item) !== "cancelled",
      ).length;
    },

    isSettled() {
      return store.items.length > 0 && store.remainingCount() === 0;
    },

    signature() {
      if (!store.isSettled()) return null;
      return store.items
        .map((item) => `${item.ref ?? item.step}:${itemStatus(item)}:${item.text}`)
        .join("|");
    },

    snapshot() {
      return {
        owner: store.owner,
        items: store.items.map((item) => ({ ...item })),
        ...(store.planPath === undefined ? {} : { planPath: store.planPath }),
        revision: store.revision,
        panel: {
          preference: store.panelPreference,
          preferenceScope: store.panelScope,
          promptAfterSettle: store.promptAfterSettle,
          completedSignature: store.completedSignature,
        },
      };
    },

    restore(snapshot) {
      if (Array.isArray(snapshot.items)) {
        store.items = ensureTodoLabels(snapshot.items);
      }
      if (snapshot.planPath !== undefined) {
        store.planPath = snapshot.planPath;
      }
      if (typeof snapshot.revision === "number" && Number.isFinite(snapshot.revision)) {
        store.revision = Math.max(store.revision, Math.floor(snapshot.revision));
      }
      const panel = snapshot.panel;
      if (panel) {
        // An entry written before a field existed must not erase the current
        // value; each field is restored only when it is present.
        if (typeof panel.preference === "string") store.panelPreference = panel.preference;
        if (panel.preferenceScope === null || typeof panel.preferenceScope === "string") {
          store.panelScope = panel.preferenceScope;
        }
        if (typeof panel.promptAfterSettle === "boolean") {
          store.promptAfterSettle = panel.promptAfterSettle;
        }
        if (
          panel.completedSignature === null ||
          typeof panel.completedSignature === "string"
        ) {
          store.completedSignature = panel.completedSignature;
        }
      }
    },
  };
  return store;
}

/**
 * A defensive check for the projection layer: only the expected owner may
 * drive a list, and a worker list can never be the parent's list.
 */
export function assertListOwner(
  store: Pick<TodoStore, "owner">,
  expected: TodoListOwner,
): void {
  if (store.owner !== expected) {
    throw new Error(
      `todo list owner mismatch: expected ${expected}, found ${store.owner}`,
    );
  }
}
