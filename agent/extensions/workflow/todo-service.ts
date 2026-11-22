/**
 * Workflow Extension — session-scoped TODO store.
 *
 * The todo list used to live as a handful of mutable closure variables inside
 * the (very large) extension factory. This module is the storage seam: one
 * instance per session, explicit ownership, and the pure helpers from
 * `utils.ts` for every mutation.
 *
 * Why ownership is explicit (orchestrator plan step 3):
 *
 *   - `ordinary` — a normal Plan/Build list. `workflow_todo` and plan-file
 *     reconciliation drive it exactly as before.
 *   - `roadmap`  — the parent Orchestrator's projection. Only accepted task
 *     coverage may complete a step; it must never be reinterpreted as worker
 *     progress.
 *   - `worker`   — a child session's task-local list. It cannot touch parent
 *     roadmap state or trigger a parent commit.
 *
 * The store holds no module-level state, so two sessions (or a parent and its
 * child in one process) can never share items, ref numbering or panel
 * preferences. `owner` is recorded so a future projection layer can refuse a
 * cross-list mutation instead of guessing from display numbers.
 *
 * Everything here is pure or I/O-light; file reads are injected by the caller.
 */

import {
  applyTodoUpdate,
  dedupeTodoItems,
  ensureTodoLabels,
  extractPlanStepsFromMarkdown,
  isDone,
  itemStatus,
  markCompletedRefs,
  mergeTodoItems,
  resolveTodoRef,
  samePlanPath,
  setTodoStatus,
  synthesizeFromPlanTitle,
  todoKey,
  type TodoItem,
  type TodoRefResolution,
  type TodoStatus,
  type TodoUpdateEntry,
} from "./utils.ts";

/** Which list a store instance owns. */
export const TODO_LIST_OWNERS = ["ordinary", "roadmap", "worker"] as const;
export type TodoListOwner = (typeof TODO_LIST_OWNERS)[number];

/** The panel preference values `/todos` accepts (presentation only). */
export type TodoPanelPreference = "auto" | "expanded" | "collapsed" | "hidden";

/** Everything a session persists about its list. */
export interface TodoStoreSnapshot {
  owner: TodoListOwner;
  items: TodoItem[];
  planPath?: string;
  /** Monotonic list revision; a stale expected revision is refused. */
  revision?: number;
  /** Plan bindings deliberately removed; passive reconciliation must not restore them. */
  excludedPlanSteps?: string[];
  planDigest?: string;
  /** Idempotency key of the last applied reviewed recovery. */
  recoveryReceiptId?: string;
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
  /** Plan file the current list was derived from (drives merge vs replace). */
  planPath: string | undefined;
  /** Monotonic list revision; bumped by every authoritative mutation. */
  revision: number;
  /** Plan bindings the user deliberately removed (durable exclusions). */
  excludedPlanSteps: Set<string>;
  /** Digest of the plan bytes last imported, when known. */
  planDigest: string | undefined;
  /** Last applied recovery receipt (idempotency). */
  recoveryReceiptId: string | undefined;

  // Panel presentation. Kept beside the list because it is scoped to it.
  panelPreference: TodoPanelPreference;
  panelScope: string | null;
  promptAfterSettle: boolean;
  completedSignature: string | null;

  /** Replace the whole list (already-extracted steps are normalized). */
  replace(items: TodoItem[]): void;
  /**
   * Industry-style wholesale update: omitted items are removed.
   *
   * A plan-linked list refuses a text-only bulk rewrite that would replace
   * most plan rows with new agent rows (that is how the 23→46 duplication
   * happened). `allowBulkReplace` is the explicit replacement intent.
   */
  update(
    incoming: TodoUpdateEntry[],
    options?: { allowBulkReplace?: boolean; expectedRevision?: number },
  ): ReturnType<typeof applyTodoUpdate>;
  /** Mark `[DONE:ref]` tags from assistant text. */
  markDoneTags(text: string): ReturnType<typeof markCompletedRefs>;
  resolve(ref: string): TodoRefResolution;
  setStatus(ref: string, status: TodoStatus): TodoItem | undefined;
  toggle(ref: string): TodoItem | undefined;
  add(input: { text: string; group?: string; label?: string }): { item: TodoItem; duplicate: boolean };
  clear(): void;

  /**
   * Extract steps from plan markdown and merge them:
   * same plan file → completion-preserving merge; different/absent → replace.
   * Returns whether the list was replaced and how many items were preserved.
   */
  loadFromPlanMarkdown(input: {
    markdown: string;
    planPath: string;
    cwd: string;
    /** Explicit sync may restore deliberately removed steps. */
    restoreExcluded?: boolean;
  }): {
    replaced: boolean;
    count: number;
    preserved: number;
    synthesized: boolean;
    excluded: number;
    restored: number;
  };

  /** Merge freshly extracted steps from the SAME plan file. */
  mergeExtracted(
    extracted: TodoItem[],
    planPath: string,
    cwd: string,
    options?: { restoreExcluded?: boolean },
  ): {
    replaced: boolean;
    count: number;
    preserved: number;
    excluded: number;
    restored: number;
  };

  doneCount(): number;
  remainingCount(): number;
  isSettled(): boolean;
  /** Settled-list signature; a status change produces a new one. */
  signature(): string | null;

  snapshot(): TodoStoreSnapshot;
  restore(snapshot: Partial<TodoStoreSnapshot>): void;
  /**
   * Apply a reviewed recovery of a damaged list. Idempotent per receipt id;
   * it is bookkeeping only and never proves completion or triggers commits.
   */
  recover(items: TodoItem[], receiptId: string): { applied: boolean };
}

export function createTodoStore(owner: TodoListOwner = "ordinary"): TodoStore {
  const store: TodoStore = {
    owner,
    items: [],
    planPath: undefined,
    revision: 0,
    excludedPlanSteps: new Set<string>(),
    planDigest: undefined,
    recoveryReceiptId: undefined,
    panelPreference: "auto",
    panelScope: null,
    promptAfterSettle: false,
    completedSignature: null,

    replace(items) {
      store.items = ensureTodoLabels(dedupeTodoItems(items));
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
      const planRows = store.items.filter((item) => item.planStepId);
      const identifiable = (incoming ?? []).filter(
        (entry) =>
          (entry.id !== undefined && String(entry.id).trim().length > 0) ||
          (entry.ref !== undefined && String(entry.ref).trim().length > 0),
      ).length;
      // Ref-less wholesale rewording of a plan-linked list is the exact shape
      // that created a second copy of every task. Refuse before mutating.
      if (
        options?.allowBulkReplace !== true &&
        planRows.length >= 3 &&
        identifiable < Math.ceil(planRows.length / 2)
      ) {
        return {
          items: [...store.items],
          added: 0,
          removed: 0,
          kept: 0,
          normalized: 0,
          warnings: [],
          refused:
            "This list is linked to a plan. Update existing items with their id/ref; a text-only wholesale rewrite could duplicate tasks. Pass intent:\"replace\" to replace the list deliberately.",
          revision: store.revision,
        };
      }
      const before = new Map(store.items.map((item) => [item.id, item]));
      const result = applyTodoUpdate(store.items, incoming);
      const keptIds = new Set(result.items.map((item) => item.id));
      let excludedAdded = 0;
      for (const item of before.values()) {
        if (!item?.planStepId || !item.id) continue;
        if (keptIds.has(item.id)) continue;
        store.excludedPlanSteps.add(item.planStepId);
        excludedAdded += 1;
      }
      store.items = result.items;
      store.revision += 1;
      return { ...result, revision: store.revision, excludedAdded };
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
      // An explicit clear is a deliberate membership decision: remember the
      // plan bindings so passive reconciliation cannot resurrect them.
      for (const item of store.items) {
        if (item.planStepId) store.excludedPlanSteps.add(item.planStepId);
      }
      store.items = [];
      store.planPath = undefined;
      store.revision += 1;
    },

    loadFromPlanMarkdown({ markdown, planPath, cwd, restoreExcluded }) {
      let extracted = extractPlanStepsFromMarkdown(markdown);
      let synthesized = false;
      if (extracted.length === 0) {
        const synth = synthesizeFromPlanTitle(markdown);
        if (synth) {
          extracted = [synth];
          synthesized = true;
        }
      }
      if (extracted.length === 0) {
        return {
          replaced: false,
          count: store.items.length,
          preserved: 0,
          synthesized: false,
          excluded: 0,
          restored: 0,
        };
      }
      const merged = store.mergeExtracted(extracted, planPath, cwd, {
        ...(restoreExcluded === undefined ? {} : { restoreExcluded }),
      });
      return { ...merged, synthesized };
    },

    mergeExtracted(extracted, planPath, cwd, options) {
      const samePlan =
        store.planPath !== undefined && samePlanPath(store.planPath, planPath, cwd);
      if (samePlan) {
        const restoreExcluded = options?.restoreExcluded === true;
        const merged = mergeTodoItems(store.items, extracted, {
          excludedPlanStepIds: store.excludedPlanSteps,
          ...(restoreExcluded ? { restoreExcluded: true } : {}),
        });
        // An explicit sync is the only operation that clears membership
        // exclusions; passive reconciliation never does.
        if (restoreExcluded) store.excludedPlanSteps.clear();
        store.items = merged.items;
        store.planPath = planPath;
        store.revision += 1;
        return {
          replaced: false,
          count: store.items.length,
          preserved: merged.preserved,
          excluded: merged.excluded,
          restored: merged.restored,
        };
      }
      // A new plan lineage: exclusions belong to the previous plan.
      store.excludedPlanSteps.clear();
      store.items = ensureTodoLabels(extracted);
      store.planPath = planPath;
      store.revision += 1;
      return {
        replaced: true,
        count: store.items.length,
        preserved: 0,
        excluded: 0,
        restored: 0,
      };
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
        excludedPlanSteps: [...store.excludedPlanSteps],
        ...(store.planDigest === undefined ? {} : { planDigest: store.planDigest }),
        ...(store.recoveryReceiptId === undefined
          ? {}
          : { recoveryReceiptId: store.recoveryReceiptId }),
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
      if (snapshot.planPath !== undefined) store.planPath = snapshot.planPath;
      if (typeof snapshot.revision === "number" && Number.isFinite(snapshot.revision)) {
        store.revision = Math.max(store.revision, Math.floor(snapshot.revision));
      }
      if (Array.isArray(snapshot.excludedPlanSteps)) {
        store.excludedPlanSteps = new Set(
          snapshot.excludedPlanSteps.filter(
            (entry): entry is string => typeof entry === "string" && entry.length > 0,
          ),
        );
      }
      if (typeof snapshot.planDigest === "string") store.planDigest = snapshot.planDigest;
      if (typeof snapshot.recoveryReceiptId === "string") {
        store.recoveryReceiptId = snapshot.recoveryReceiptId;
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
        if (panel.completedSignature === null || typeof panel.completedSignature === "string") {
          store.completedSignature = panel.completedSignature;
        }
      }
    },

    recover(items, receiptId) {
      if (store.recoveryReceiptId === receiptId) return { applied: false };
      // The reviewed list is authoritative; keep stable ids/bindings it carries.
      store.items = ensureTodoLabels(dedupeTodoItems(items));
      store.recoveryReceiptId = receiptId;
      store.revision += 1;
      return { applied: true };
    },
  };
  return store;
}

/**
 * A defensive check for the projection layer: only an `ordinary` list may be
 * driven by `workflow_todo`/plan reconciliation, and a worker list can never
 * be the parent's roadmap list.
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
