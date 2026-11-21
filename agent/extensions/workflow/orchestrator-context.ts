/**
 * Workflow Extension — bounded parent context and compaction state (step 40).
 *
 * The parent must not grow its prompt with every child transcript. It carries a
 * small run projection plus a durable pointer, and pages history only on demand.
 *
 * The pointer (run/revision/active task/next action/pending decision) is stored
 * independently of model memory and survives manual/automatic compaction: a
 * compaction can drop prose, but it must not lose "verification is pending" or
 * inflate completion. Structured-state scanning keeps parent and child TODO
 * projections in separate buckets instead of mixing them.
 *
 * Pure: no tokenizer, model or SDK access; token counts are conservative
 * estimates and always reported as such.
 */

import type { RunState } from "./orchestrator-state.ts";
import type { RunPhase } from "./orchestrator-types.ts";

export const CONTEXT_SCHEMA_VERSION = 1 as const;
export const RUN_POINTER_ENTRY = "workflow-run-pointer";
export const TODO_PROJECTION_ENTRY = "workflow-todo-projection";
export const DEFAULT_PROJECTION_TOKENS = 1_200;
export const MAX_PROJECTION_TASKS = 12;
export const MAX_HISTORY_PAGE = 50;
export const MAX_TEXT = 2_000;
export const MAX_STRUCTURED_BYTES = 8_000;

export type PendingDecision = "verify" | "repair" | "accept" | "resume" | "dispatch" | "next_task" | "none";

export interface RunPointer {
  schemaVersion: typeof CONTEXT_SCHEMA_VERSION;
  /** The pointer belongs to the parent run; child pointers are ignored. */
  owner: "parent";
  runId: string;
  revision: number;
  phase: RunPhase;
  planRevision: number;
  roadmapRevision: number;
  acceptedCount: number;
  totalCount: number;
  activeTaskId?: string;
  nextAction: string;
  pendingDecision: PendingDecision;
  updatedAt: number;
}

function activeTaskId(state: RunState): string | undefined {
  if (state.mutation?.taskId) return state.mutation.taskId;
  for (const taskId of state.order) {
    const task = state.tasks[taskId];
    if (!task) continue;
    if (
      task.state === "running" ||
      task.state === "candidate" ||
      task.state === "verifying" ||
      task.state === "needs_fix" ||
      task.state === "assigned"
    ) {
      return taskId;
    }
  }
  return undefined;
}

function decisionFor(state: RunState, active: string | undefined): PendingDecision {
  if (state.phase === "paused" || state.phase === "interrupted") return "resume";
  const task = active ? state.tasks[active] : undefined;
  if (task) {
    if (task.state === "candidate") return "verify";
    if (task.state === "verifying") return "accept";
    if (task.state === "needs_fix" || task.state === "blocked") return "repair";
  }
  if (state.phase === "waiting_user") return "resume";
  const pending = state.order.find((taskId) => {
    const task = state.tasks[taskId];
    return (
      task?.state === "pending" &&
      task.dependsOn.every((dependency) => state.tasks[dependency]?.state === "accepted")
    );
  });
  if (pending) return "dispatch";
  if (state.order.every((taskId) => state.tasks[taskId]?.state === "accepted")) return "next_task";
  return "none";
}

function nextActionFor(state: RunState, decision: PendingDecision): string {
  if (state.phase === "blocked") return `blocked: ${state.blockedReason ?? "unknown reason"}`;
  switch (decision) {
    case "verify":
      return "inspect the quiescent candidate and run verification";
    case "accept":
      return "decide acceptance or send a scoped repair";
    case "repair":
      return "send a scoped repair or pause the run";
    case "resume":
      return "resume explicitly after confirming the workspace";
    case "dispatch":
      return "dispatch the next ready task";
    case "next_task":
      return "run the final integration gate";
    default:
      return "review the run status";
  }
}

/** The small durable pointer, independent of model memory. */
export function buildRunPointer(state: RunState, now: number): RunPointer {
  const acceptedCount = state.order.filter((taskId) => state.tasks[taskId]?.state === "accepted").length;
  const active = activeTaskId(state);
  const decision = decisionFor(state, active);
  return {
    schemaVersion: CONTEXT_SCHEMA_VERSION,
    owner: "parent",
    runId: state.runId,
    revision: state.revision,
    phase: state.phase,
    planRevision: state.planRevision,
    roadmapRevision: state.roadmapRevision,
    acceptedCount,
    totalCount: state.order.length,
    ...(active ? { activeTaskId: active } : {}),
    nextAction: nextActionFor(state, decision),
    pendingDecision: decision,
    updatedAt: now,
  };
}

export interface ProjectionTask {
  taskId: string;
  state: string;
  covers: number;
  repairRounds: number;
  noProgress: number;
}

export interface RunProjection {
  schemaVersion: typeof CONTEXT_SCHEMA_VERSION;
  pointer: RunPointer;
  tasks: ProjectionTask[];
  dependencies: Array<{ taskId: string; dependsOn: string[] }>;
  text: string;
  /** Conservative ~4 chars/token; never presented as exact model usage. */
  tokens: number;
  truncated: boolean;
  omittedTasks: number;
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function trimToBudget(lines: string[], budgetTokens: number): { lines: string[]; truncated: boolean } {
  const out: string[] = [];
  let tokens = 0;
  let truncated = false;
  for (const line of lines) {
    const cost = estimateTokens(`${line}\n`);
    if (tokens + cost > budgetTokens) {
      truncated = true;
      break;
    }
    out.push(line);
    tokens += cost;
  }
  return { lines: out, truncated };
}

/**
 * Builds the parent-facing projection. It never includes a child transcript,
 * report body or raw log — only the bounded pointer, task states, dependency
 * summary and next action. Large runs keep a constant-size context.
 */
export function buildParentProjection(input: {
  state: RunState;
  now: number;
  maxTasks?: number;
  budgetTokens?: number;
}): RunProjection {
  const state = input.state;
  const maxTasks = Math.max(1, Math.min(MAX_PROJECTION_TASKS, input.maxTasks ?? MAX_PROJECTION_TASKS));
  const budget = Math.max(120, Math.min(8_000, input.budgetTokens ?? DEFAULT_PROJECTION_TOKENS));
  const pointer = buildRunPointer(state, input.now);

  const prioritized: string[] = [];
  if (pointer.activeTaskId) prioritized.push(pointer.activeTaskId);
  for (const taskId of state.order) {
    if (!prioritized.includes(taskId)) prioritized.push(taskId);
  }
  const selected = prioritized.slice(0, maxTasks);
  const tasks: ProjectionTask[] = [];
  for (const taskId of selected) {
    const task = state.tasks[taskId];
    if (!task) continue;
    tasks.push({
      taskId,
      state: task.state,
      covers: task.covers.length,
      repairRounds: task.counters.repairRounds,
      noProgress: task.counters.noProgress,
    });
  }
  const dependencies: Array<{ taskId: string; dependsOn: string[] }> = [];
  for (const task of tasks) {
    const record = state.tasks[task.taskId];
    if (record && record.dependsOn.length > 0) {
      dependencies.push({ taskId: task.taskId, dependsOn: [...record.dependsOn] });
    }
  }

  const head = [
    `Run ${pointer.runId} · ${pointer.phase} · revision ${pointer.revision}`,
    `${pointer.acceptedCount}/${pointer.totalCount} tasks accepted; next: ${pointer.nextAction}`,
    `Pending decision: ${pointer.pendingDecision}${pointer.activeTaskId ? ` · active ${pointer.activeTaskId}` : ""}`,
  ];
  const taskLines = tasks.map(
    (task) =>
      `- ${task.taskId} ${task.state} (covers ${task.covers}, repairs ${task.repairRounds}, no-progress ${task.noProgress})`,
  );
  const { lines, truncated } = trimToBudget([...head, ...taskLines], budget);
  const text = lines.join("\n").slice(0, MAX_TEXT);
  return {
    schemaVersion: CONTEXT_SCHEMA_VERSION,
    pointer,
    tasks,
    dependencies,
    text,
    tokens: estimateTokens(text),
    truncated: truncated || prioritized.length > maxTasks,
    omittedTasks: Math.max(0, state.order.length - tasks.length),
  };
}

// ── History paging ───────────────────────────────────────────────────

export type HistoryKind = "decision" | "acceptance" | "repair" | "rollover" | "note";

export interface HistoryEntry {
  id: string;
  kind: HistoryKind;
  taskId?: string;
  at: number;
  /** A bounded summary; never a raw transcript. */
  text: string;
}

export interface HistoryPage {
  items: Array<{ id: string; kind: HistoryKind; taskId?: string; at: number; text: string }>;
  nextOffset?: number;
  total: number;
  truncatedText: boolean;
}

/** On-demand paging keeps the parent prompt small while detail stays reachable. */
export function pageHistory(input: {
  entries: readonly HistoryEntry[];
  offset?: number;
  pageSize?: number;
}): HistoryPage {
  const pageSize = Math.max(1, Math.min(MAX_HISTORY_PAGE, input.pageSize ?? 20));
  const offset = Math.max(0, Math.floor(input.offset ?? 0));
  const slice = input.entries.slice(offset, offset + pageSize);
  let truncatedText = false;
  const items = slice.map((entry) => {
    let text = typeof entry.text === "string" ? entry.text : "";
    if (text.length > MAX_TEXT) {
      text = `${text.slice(0, MAX_TEXT - 20)}…[truncated]`;
      truncatedText = true;
    }
    return {
      id: entry.id,
      kind: entry.kind,
      ...(entry.taskId ? { taskId: entry.taskId } : {}),
      at: entry.at,
      text,
    };
  });
  const next = offset + items.length;
  return {
    items,
    ...(next < input.entries.length ? { nextOffset: next } : {}),
    total: input.entries.length,
    truncatedText,
  };
}

// ── Structured-state scanning / compaction ───────────────────────────

export interface ScannedEntryLike {
  type?: string;
  customType?: string;
  data?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export type PointerParse =
  | { ok: true; pointer: RunPointer }
  | { ok: false; reason: string };

const DECISIONS: ReadonlySet<string> = new Set([
  "verify",
  "repair",
  "accept",
  "resume",
  "dispatch",
  "next_task",
  "none",
]);

/** Validates a persisted pointer. Unknown versions fail closed (no pointer). */
export function parseRunPointer(raw: unknown): PointerParse {
  if (!isRecord(raw)) return { ok: false, reason: "pointer must be an object" };
  if (raw.schemaVersion !== CONTEXT_SCHEMA_VERSION) {
    return { ok: false, reason: `unsupported pointer version ${String(raw.schemaVersion)}` };
  }
  if (raw.owner !== "parent") return { ok: false, reason: "a child pointer cannot drive the parent" };
  for (const key of ["runId", "nextAction"] as const) {
    if (typeof raw[key] !== "string" || raw[key].length === 0 || raw[key].length > MAX_TEXT) {
      return { ok: false, reason: `invalid ${key}` };
    }
  }
  for (const key of ["revision", "planRevision", "roadmapRevision", "acceptedCount", "totalCount", "updatedAt"] as const) {
    if (typeof raw[key] !== "number" || !Number.isFinite(raw[key])) {
      return { ok: false, reason: `invalid ${key}` };
    }
  }
  if (typeof raw.phase !== "string") return { ok: false, reason: "invalid phase" };
  if (typeof raw.pendingDecision !== "string" || !DECISIONS.has(raw.pendingDecision)) {
    return { ok: false, reason: "invalid pendingDecision" };
  }
  if (raw.activeTaskId !== undefined && typeof raw.activeTaskId !== "string") {
    return { ok: false, reason: "invalid activeTaskId" };
  }
  return {
    ok: true,
    pointer: {
      schemaVersion: CONTEXT_SCHEMA_VERSION,
      owner: "parent",
      runId: raw.runId as string,
      revision: raw.revision as number,
      phase: raw.phase as RunPhase,
      planRevision: raw.planRevision as number,
      roadmapRevision: raw.roadmapRevision as number,
      acceptedCount: raw.acceptedCount as number,
      totalCount: raw.totalCount as number,
      ...(typeof raw.activeTaskId === "string" ? { activeTaskId: raw.activeTaskId } : {}),
      nextAction: raw.nextAction as string,
      pendingDecision: raw.pendingDecision as PendingDecision,
      updatedAt: raw.updatedAt as number,
    },
  };
}

/** A custom entry the runtime can persist; small enough to survive compaction. */
export function pointerEntry(pointer: RunPointer): {
  type: "custom";
  customType: typeof RUN_POINTER_ENTRY;
  data: RunPointer;
} {
  return { type: "custom", customType: RUN_POINTER_ENTRY, data: pointer };
}

export interface ScannedStructuredState {
  /** Newest first per run. */
  pointers: RunPointer[];
  parentTodos: Array<{ itemCount: number; data: unknown }>;
  childTodos: Array<{ itemCount: number; data: unknown }>;
  ignored: number;
}

/**
 * Scans branch entries for run pointers and TODO projections. Parent and child
 * TODO lists are kept separate so a child's local plan cannot be mistaken for
 * roadmap progress (or vice versa).
 */
export function scanStructuredState(entries: readonly ScannedEntryLike[]): ScannedStructuredState {
  const pointers: RunPointer[] = [];
  const parentTodos: ScannedStructuredState["parentTodos"] = [];
  const childTodos: ScannedStructuredState["childTodos"] = [];
  let ignored = 0;

  const sizeOk = (value: unknown): boolean => {
    try {
      return JSON.stringify(value).length <= MAX_STRUCTURED_BYTES;
    } catch {
      return false;
    }
  };

  for (const entry of entries) {
    if (entry.type !== "custom") continue;
    if (entry.customType === RUN_POINTER_ENTRY) {
      const parsed = parseRunPointer(entry.data);
      if (!parsed.ok || !sizeOk(entry.data)) {
        ignored += 1;
        continue;
      }
      pointers.push(parsed.pointer);
      continue;
    }
    if (entry.customType === TODO_PROJECTION_ENTRY) {
      if (!isRecord(entry.data) || !sizeOk(entry.data)) {
        ignored += 1;
        continue;
      }
      const owner = entry.data.owner;
      const rawItems = entry.data.items;
      if (owner !== "parent" && owner !== "child") {
        ignored += 1;
        continue;
      }
      if (!Array.isArray(rawItems)) {
        ignored += 1;
        continue;
      }
      const bounded = rawItems.slice(0, 200);
      const projection = { itemCount: bounded.length, data: { ...entry.data, items: bounded } };
      if (owner === "parent") parentTodos.push(projection);
      else childTodos.push(projection);
    }
  }
  pointers.sort((left, right) => right.revision - left.revision || right.updatedAt - left.updatedAt);
  return { pointers, parentTodos, childTodos, ignored };
}

/**
 * Merges a persisted pointer with a fresh one. Revision never regresses, and a
 * pending decision from the newer pointer is always preserved.
 */
export function mergePointers(
  existing: RunPointer | undefined,
  incoming: RunPointer,
): { pointer: RunPointer; ignored: boolean } {
  if (!existing) return { pointer: incoming, ignored: false };
  if (incoming.revision < existing.revision) return { pointer: existing, ignored: true };
  if (incoming.revision === existing.revision) {
    return { pointer: existing, ignored: true };
  }
  return { pointer: incoming, ignored: false };
}

/**
 * The compaction-time restore. `persisted` is the durable pointer; it wins
 * whenever the rebuilt projection is missing or regressed. A pending
 * verification/repair/accept decision is therefore not lost by compaction.
 */
export function restorePointer(input: {
  persisted?: RunPointer;
  rebuilt?: RunPointer;
}): RunPointer | undefined {
  const { persisted, rebuilt } = input;
  if (!persisted) return rebuilt;
  if (!rebuilt) return persisted;
  const merged = mergePointers(persisted, rebuilt);
  if (merged.ignored && persisted.pendingDecision !== "none" && rebuilt.pendingDecision === "none") {
    return persisted;
  }
  return merged.pointer;
}

/** The small state retained across compaction, with child TODO lists separate. */
export function compactionSnapshot(entries: readonly ScannedEntryLike[]): {
  pointer?: RunPointer;
  parentTodos: Array<{ itemCount: number; data: unknown }>;
  childTodosSeparate: Array<{ itemCount: number; data: unknown }>;
  ignored: number;
} {
  const scanned = scanStructuredState(entries);
  return {
    ...(scanned.pointers[0] ? { pointer: scanned.pointers[0] } : {}),
    parentTodos: scanned.parentTodos,
    childTodosSeparate: scanned.childTodos,
    ignored: scanned.ignored,
  };
}
