/**
 * Workflow Extension — worker-local TODOs and normal interaction (step 28).
 *
 * A managed Build child gets its OWN todo list scoped to the assignment. It
 * never imports the parent roadmap as local work and its completions can never
 * move parent roadmap state or trigger a commit. The roadmap is a read-only
 * reference (path/digest/revision), kept outside the todo items.
 *
 * Child UX stays ordinary: normal questions/prompts, but user steering and
 * model changes are recorded and returned as rechecks (budget/parity) instead
 * of being silently accepted. Changes outside the assignment are escalated.
 */

import {
  extractPlanStepsFromMarkdown,
  markCompletedRefs,
  type TodoItem,
} from "./utils.ts";

export const WORKER_TODO_SCHEMA_VERSION = 1 as const;
export const MAX_WORKER_TODOS = 200;
export const MAX_TODO_TEXT_CHARS = 500;

export interface RoadmapReference {
  path: string;
  digest: string;
  revision: number;
}

export interface WorkerAssignmentScope {
  taskId: string;
  covers: readonly string[];
  objective: string;
  acceptanceChecks: readonly string[];
  expectedFiles: readonly string[];
  /** Prefixes/globs the child may change. */
  mutationScope?: readonly string[];
  roadmap: RoadmapReference;
}

export interface WorkerTodoItem {
  ref: number;
  text: string;
  completed: boolean;
  group?: string;
  label?: string;
  source: "assignment";
}

export interface WorkerTodoList {
  schemaVersion: typeof WORKER_TODO_SCHEMA_VERSION;
  taskId: string;
  owner: "worker";
  items: WorkerTodoItem[];
  /** Read-only; never converted into local work. */
  roadmap: RoadmapReference;
  updatedAt: number;
}

export type WorkerTodoResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: "invalid" | "too_large" | "roadmap_import" | "mismatch"; error: string };

function boundedText(value: string): string | undefined {
  const clean = value.replace(/\s+/g, " ").trim();
  if (clean.length === 0 || clean.length > MAX_TODO_TEXT_CHARS) return undefined;
  return clean;
}

function itemsFromPlan(
  planText: string,
  assignment: WorkerAssignmentScope,
): WorkerTodoResult<WorkerTodoItem[]> {
  const parsed = extractPlanStepsFromMarkdown(planText).slice(0, MAX_WORKER_TODOS);
  const items: WorkerTodoItem[] = [];
  for (const step of parsed) {
    const text = boundedText(step.text);
    if (!text) continue;
    items.push({
      ref: items.length + 1,
      text,
      completed: step.completed === true,
      ...(step.group ? { group: step.group.slice(0, 120) } : {}),
      ...(step.label ? { label: step.label.slice(0, 40) } : {}),
      source: "assignment",
    });
  }
  if (items.length === 0) {
    return { ok: false, code: "invalid", error: "the task-local plan has no usable steps" };
  }
  // Roadmap coverage is a reference, never a list of local steps.
  void assignment;
  return { ok: true, value: items };
}

/**
 * Builds the child's local list. A task-local plan is used when supplied; the
 * accepted roadmap itself must never be passed (its digest is refused), and the
 * fallback is the assignment's acceptance checks — never the roadmap.
 */
export function buildWorkerTodos(input: {
  assignment: WorkerAssignmentScope;
  planText?: string | null;
  now: number;
}): WorkerTodoResult<WorkerTodoList> {
  const assignment = input.assignment;
  if (!assignment.taskId || assignment.taskId.length > 120) {
    return { ok: false, code: "invalid", error: "assignment task id is invalid" };
  }
  if (!boundedText(assignment.objective)) {
    return { ok: false, code: "invalid", error: "assignment objective is invalid" };
  }
  if (input.planText && input.planText.length > 0) {
    if (input.planText.includes(assignment.roadmap.digest)) {
      return {
        ok: false,
        code: "roadmap_import",
        error: "the child must sync its task-local plan, not the parent roadmap",
      };
    }
  }
  let items: WorkerTodoItem[];
  if (input.planText && input.planText.trim().length > 0) {
    const parsed = itemsFromPlan(input.planText, assignment);
    if (!parsed.ok) return parsed;
    items = parsed.value;
  } else {
    const checks = assignment.acceptanceChecks
      .map((check) => boundedText(check))
      .filter((check): check is string => !!check)
      .slice(0, MAX_WORKER_TODOS);
    if (checks.length === 0) {
      return { ok: false, code: "invalid", error: "the assignment has no acceptance checks" };
    }
    items = checks.map((text, index) => ({
      ref: index + 1,
      text,
      completed: false,
      source: "assignment" as const,
    }));
  }
  return {
    ok: true,
    value: {
      schemaVersion: WORKER_TODO_SCHEMA_VERSION,
      taskId: assignment.taskId,
      owner: "worker",
      items,
      roadmap: { ...assignment.roadmap },
      updatedAt: input.now,
    },
  };
}

/**
 * Re-syncs the task-local plan while preserving local completions. It can never
 * add a roadmap requirement as a local step.
 */
export function syncWorkerTodos(input: {
  list: WorkerTodoList;
  assignment: WorkerAssignmentScope;
  planText?: string | null;
  now: number;
}): WorkerTodoResult<{ list: WorkerTodoList; importedRoadmap: false }> {
  if (input.list.taskId !== input.assignment.taskId) {
    return { ok: false, code: "mismatch", error: "the list belongs to another task" };
  }
  const rebuilt = buildWorkerTodos({
    assignment: input.assignment,
    ...(input.planText === undefined ? {} : { planText: input.planText }),
    now: input.now,
  });
  if (!rebuilt.ok) return rebuilt;
  const previous = new Map(
    input.list.items.map((item) => [`${item.group ?? ""}\u0000${item.text}`, item.completed]),
  );
  const items = rebuilt.value.items.map((item) => ({
    ...item,
    completed: previous.get(`${item.group ?? ""}\u0000${item.text}`) === true,
  }));
  return {
    ok: true,
    value: {
      list: { ...rebuilt.value, items, updatedAt: input.now },
      importedRoadmap: false,
    },
  };
}

export interface WorkerTodoEffects {
  parentRoadmapChanged: false;
  commitTriggered: false;
  parentTodosChanged: false;
}

/** Completes a local ref; the return type makes parent/commit effects impossible. */
export function completeWorkerTodo(input: {
  list: WorkerTodoList;
  ref?: number;
  text?: string;
  origin: "todo" | "done-tag";
  now: number;
}): WorkerTodoResult<{ list: WorkerTodoList; effects: WorkerTodoEffects }> {
  const index = input.list.items.findIndex((item) =>
    input.ref !== undefined ? item.ref === input.ref : item.text === input.text,
  );
  if (index < 0) {
    return { ok: false, code: "invalid", error: "no such task-local step" };
  }
  const items = input.list.items.map((item, position) =>
    position === index ? { ...item, completed: true } : item,
  );
  return {
    ok: true,
    value: {
      list: { ...input.list, items, updatedAt: input.now },
      effects: { parentRoadmapChanged: false, commitTriggered: false, parentTodosChanged: false },
    },
  };
}

/** `[DONE:n]` tags are local refs only; unknown/out-of-range refs are ignored. */
export function applyWorkerDoneTags(input: {
  list: WorkerTodoList;
  message: string;
  now: number;
}): WorkerTodoResult<{ list: WorkerTodoList; effects: WorkerTodoEffects }> {
  const asTodoItems: TodoItem[] = input.list.items.map((item) => ({
    ref: String(item.ref),
    step: item.ref - 1,
    text: item.text,
    completed: item.completed,
    source: "plan",
  }));
  markCompletedRefs(input.message, asTodoItems);
  const completedRefs = new Set(
    asTodoItems.filter((item) => item.completed).map((item) => Number(item.ref)),
  );
  const items = input.list.items.map((item) =>
    completedRefs.has(item.ref) ? { ...item, completed: true } : item,
  );
  return {
    ok: true,
    value: {
      list: { ...input.list, items, updatedAt: input.now },
      effects: { parentRoadmapChanged: false, commitTriggered: false, parentTodosChanged: false },
    },
  };
}

// ── Scope and interaction ───────────────────────────────────────────

export interface OutOfScopeResult {
  outOfScope: string[];
  requiresEscalation: boolean;
  reason?: string;
}

function underScope(path: string, scope: string): boolean {
  const cleanPath = path.replace(/\\/g, "/");
  const cleanScope = scope.replace(/\\/g, "/").replace(/\/+$/, "");
  if (cleanScope.endsWith("/**")) {
    return cleanPath.startsWith(cleanScope.slice(0, -3));
  }
  if (cleanScope.endsWith("*")) return cleanPath.startsWith(cleanScope.slice(0, -1));
  return cleanPath === cleanScope || cleanPath.startsWith(`${cleanScope}/`);
}

/** Reports changed files outside the assignment's expected/mutation scope. */
export function detectOutOfScopeChanges(input: {
  assignment: WorkerAssignmentScope;
  changedPaths: readonly string[];
}): OutOfScopeResult {
  const scope = [
    ...input.assignment.expectedFiles,
    ...(input.assignment.mutationScope ?? []),
  ].filter((entry) => entry.length > 0);
  if (scope.length === 0) {
    return {
      outOfScope: [...input.changedPaths],
      requiresEscalation: input.changedPaths.length > 0,
      reason: "the assignment declares no change surface",
    };
  }
  const outOfScope = [...new Set(input.changedPaths)]
    .filter((path) => !scope.some((entry) => underScope(path, entry)))
    .sort();
  return {
    outOfScope,
    requiresEscalation: outOfScope.length > 0,
    ...(outOfScope.length > 0
      ? { reason: `${outOfScope.length} change(s) fall outside the assignment scope` }
      : {}),
  };
}

export interface WorkerInteraction {
  kind: "steer" | "user-question" | "model-change";
  note?: string;
}

export interface InteractionEffects {
  requiresBudgetRecheck: boolean;
  requiresParityRecheck: boolean;
  requiresParentDecision: boolean;
  autoAccepted: false;
}

/** Normal child interaction is recorded; only rechecks are produced, never acceptance. */
export function recordWorkerInteraction(interaction: WorkerInteraction): InteractionEffects {
  return {
    requiresBudgetRecheck: interaction.kind === "steer" || interaction.kind === "model-change",
    requiresParityRecheck: interaction.kind === "model-change",
    requiresParentDecision: interaction.kind === "model-change",
    autoAccepted: false,
  };
}
