/**
 * Workflow Extension — frozen execution TODO snapshot.
 *
 * Build and Orchestrator share one row contract: a plan (or an explicitly
 * agreed list) is converted ONCE into stable rows, then only status changes.
 * The snapshot is pure data; it owns row identity, order, wording, refs and
 * the row-level check/file metadata. It never reads a plan again.
 *
 * This module deliberately does NOT parse Markdown itself: rows and per-row
 * metadata come from the single compiler (`plan-compiler.ts`), which keeps every
 * top-level source occurrence (no display dedupe, no truncation).
 */

import { createHash } from "node:crypto";

import {
  MAX_WORKSPACES,
  validateWorkspaceSet,
  type FrozenWorkspace,
} from "./orchestrator-workspace-set.ts";
import { isWindowsPath } from "./orchestrator-workspace.ts";
import {
  buildFrozenExecutionSnapshot,
  frozenExecutionToTodoSnapshot,
  type FrozenExecutionRowInput,
  type FrozenExecutionSnapshot,
} from "./frozen-snapshot.ts";
import { compilePlan, formatPlanDiagnostic } from "./plan-compiler.ts";
import {
  validatePlanCheckSpecs,
  type PlanCheckSpec,
} from "./plan-checks.ts";
import {
  planCheckId,
  planSpecHash,
  type CheckSpec,
  type PlanSpec,
} from "./plan-spec.ts";
import {
  planStepIdFor,
  todoItemId,
  type TodoItem,
  type TodoStatus,
} from "./utils.ts";

export const FROZEN_TODO_SCHEMA_VERSION = 1 as const;

export type FrozenTodoMode = "build" | "orchestrator";
export type FrozenTodoSourceKind = "plan" | "steps" | "discussion";

export const FROZEN_TODO_STATUSES: readonly TodoStatus[] = [
  "pending",
  "in_progress",
  "completed",
  "cancelled",
];

export interface FrozenTodoRow {
  /** Durable row identity; never derived from the current position. */
  id: string;
  /** Display ref 1..N, assigned once and never recomputed. */
  ref: string;
  text: string;
  label?: string;
  group?: string;
  source: "plan" | "steps";
  /** Plan binding; absent on explicit standalone steps. */
  planStepId?: string;
  acceptanceChecks: string[];
  expectedFiles: string[];
  /** Workspace aliases this row may attribute; first is the child cwd. */
  workspaces?: string[];
  status: TodoStatus;
  /** 1-based source line, when the row came from a plan. */
  sourceLine?: number;
}

export interface FrozenTodoSnapshot {
  version: typeof FROZEN_TODO_SCHEMA_VERSION;
  executionId: string;
  mode: FrozenTodoMode;
  source: {
    kind: FrozenTodoSourceKind;
    path?: string;
    digest: string;
    title: string;
  };
  rows: FrozenTodoRow[];
  /** Plan-level final-gate commands; per-row checks live on the row. */
  planChecks: string[];
  /** Optional multi-root set; absent means the legacy single session root. */
  workspaces?: FrozenWorkspace[];
  /** Optional per-command workspace alias; `planChecks` stays the command list. */
  planCheckSpecs?: PlanCheckSpec[];
  createdAt: number;
}

export type FrozenTodoResult =
  | {
      ok: true;
      /** v1 projection for the panel/tools/store (unchanged contract). */
      snapshot: FrozenTodoSnapshot;
      /** The compiled v2 artifact that is written to `todos.frozen`. */
      execution?: FrozenExecutionSnapshot;
    }
  | { ok: false; error: string };

export interface FrozenTodoBuildInput {
  mode: FrozenTodoMode;
  executionId?: string;
  now?: number;
  /** Optional plan-level checks; the caller may fill these later. */
  planChecks?: readonly string[];
}

// ── Parsing ──────────────────────────────────────────────────────────

interface Line {
  number: number;
  text: string;
  fenced: boolean;
}

interface RawStep {
  text: string;
  label?: string;
  group?: string;
  sourceLine: number;
  body: string[];
  acceptanceChecks?: string[];
  expectedFiles?: string[];
  workspaces?: string[];
}
function digestOf(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function unique(base: string, used: Set<string>): string {
  const count = [...used].filter((value) => value === base || value.startsWith(`${base}-`)).length;
  const id = count === 0 ? base : `${base}-${count + 1}`;
  used.add(id);
  return id;
}

function buildSnapshot(input: {
  mode: FrozenTodoMode;
  executionId?: string;
  now?: number;
  source: FrozenTodoSnapshot["source"];
  rows: RawStep[];
  planChecks?: readonly string[];
  workspaces?: readonly FrozenWorkspace[];
  planCheckSpecs?: readonly PlanCheckSpec[];
}): FrozenTodoSnapshot {
  const now = input.now ?? Date.now();
  const usedIds = new Set<string>();
  const usedPlanIds = new Set<string>();
  const rows = input.rows.map((raw, index) => {
    const label = raw.label ?? String(index + 1);
    const base = {
      text: raw.text,
      ...(raw.group === undefined ? {} : { group: raw.group }),
      label,
    };
    const id = unique(todoItemId(base), usedIds);
    const planId =
      input.source.kind === "plan"
        ? unique(planStepIdFor({ ...base, planStepId: undefined }), usedPlanIds)
        : undefined;
    return {
      id,
      ref: String(index + 1),
      text: raw.text,
      label,
      ...(raw.group === undefined ? {} : { group: raw.group }),
      source: input.source.kind === "plan" ? ("plan" as const) : ("steps" as const),
      ...(planId === undefined ? {} : { planStepId: planId }),
      acceptanceChecks: [...(raw.acceptanceChecks ?? [])],
      expectedFiles: [...(raw.expectedFiles ?? [])],
      ...(raw.workspaces === undefined || raw.workspaces.length === 0
        ? {}
        : { workspaces: [...raw.workspaces] }),
      status: "pending" as const,
      sourceLine: raw.sourceLine,
    } satisfies FrozenTodoRow;
  });
  return {
    version: FROZEN_TODO_SCHEMA_VERSION,
    executionId: input.executionId ?? `todo-exec-${input.source.digest.slice(0, 12)}-${now}`,
    mode: input.mode,
    source: input.source,
    rows,
    planChecks: [...(input.planChecks ?? [])],
    ...(input.workspaces === undefined || input.workspaces.length === 0
      ? {}
      : { workspaces: input.workspaces.map((workspace) => ({ ...workspace })) }),
    ...(input.planCheckSpecs === undefined
      ? {}
      : { planCheckSpecs: input.planCheckSpecs.map((spec) => ({ ...spec })) }),
    createdAt: now,
  };
}

/**
 * Build the compiled v2 artifact and its v1 projection together. The
 * projection is what the panel, todo store and legacy executor consume today;
 * the execution is what `todos.frozen` stores.
 */
function finishExecution(input: {
  mode: FrozenTodoMode;
  executionId?: string;
  now?: number;
  spec: PlanSpec;
  rows: readonly FrozenExecutionRowInput[];
  checks: readonly CheckSpec[];
  workspaces?: readonly FrozenWorkspace[];
  warnings?: readonly string[];
}): FrozenTodoResult {
  const now = input.now ?? Date.now();
  const warnings = [...(input.warnings ?? [])];
  const built = buildFrozenExecutionSnapshot({
    executionId:
      input.executionId ?? `todo-exec-${input.spec.source.digest.slice(0, 12)}-${now}`,
    mode: input.mode,
    source: input.spec.source,
    compilerVersion: input.spec.compiler.version,
    rows: input.rows,
    checks: input.checks,
    ...(input.workspaces === undefined ? {} : { workspaces: input.workspaces }),
    ...(warnings.length === 0 ? {} : { validation: { warnings } }),
    createdAt: now,
  });
  if (!built.ok) return { ok: false, error: built.error };
  return {
    ok: true,
    snapshot: frozenExecutionToTodoSnapshot(built.value),
    execution: built.value,
  };
}

/** Rows from the compiled spec, with the historical plan-step binding. */
function executionRowsFromPlan(
  spec: PlanSpec,
): FrozenExecutionRowInput[] {
  const usedPlanIds = new Set<string>();
  return spec.rows.map((row) => {
    const label = row.label ?? row.ref;
    const planStepId = unique(
      planStepIdFor({ text: row.text, group: row.group, label }),
      usedPlanIds,
    );
    return {
      ...row,
      source: spec.source.kind,
      status: "pending",
      ...(spec.source.kind === "plan" ? { planStepId } : {}),
    };
  });
}

function compiledChecks(
  spec: PlanSpec,
  input: { planChecks?: readonly string[]; planCheckSpecs?: readonly PlanCheckSpec[] },
): { ok: true; checks: CheckSpec[] } | { ok: false; error: string } {
  const checks = spec.planChecks;
  if (input.planChecks !== undefined) {
    const expected = checks.map((check) => check.command);
    if (
      expected.length !== input.planChecks.length ||
      expected.some((command, index) => command !== input.planChecks![index])
    ) {
      return {
        ok: false,
        error:
          "the supplied planChecks diverge from the compiled checks; freeze exactly what the compiler produced",
      };
    }
  }
  if (input.planCheckSpecs !== undefined) {
    const same =
      checks.length === input.planCheckSpecs.length &&
      checks.every(
        (check, index) =>
          check.command === input.planCheckSpecs![index]!.command &&
          check.workspace === input.planCheckSpecs![index]!.workspace,
      );
    if (!same) {
      return {
        ok: false,
        error:
          "the supplied planCheckSpecs diverge from the compiled checks; freeze exactly what the compiler produced",
      };
    }
  }
  return { ok: true, checks: [...checks] };
}

function stepChecks(
  input: { planChecks?: readonly string[]; planCheckSpecs?: readonly PlanCheckSpec[] },
): CheckSpec[] {
  const specs = input.planCheckSpecs;
  if (specs !== undefined) {
    return specs.map((spec, index) => ({
      id: planCheckId(index),
      command: spec.command,
      ...(spec.workspace === undefined ? {} : { workspace: spec.workspace }),
      kind: "gate",
    }));
  }
  return (input.planChecks ?? []).map((command, index) => ({
    id: planCheckId(index),
    command,
    kind: "gate",
  }));
}

/**
 * Convert an approved plan into frozen rows. One row per top-level source
 * occurrence, in source order; no text dedupe, no truncation, no renumbering.
 */
export function createFrozenTodosFromPlan(
  input: FrozenTodoBuildInput & {
    planPath: string;
    planText: string;
    workspaces?: readonly FrozenWorkspace[];
    planCheckSpecs?: readonly PlanCheckSpec[];
  },
): FrozenTodoResult {
  if (typeof input.planPath !== "string" || input.planPath.trim().length === 0) {
    return { ok: false, error: "a plan path is required" };
  }
  if (typeof input.planText !== "string" || input.planText.trim().length === 0) {
    return { ok: false, error: "the plan is empty" };
  }
  const compiled = compilePlan(input.planText, {
    path: input.planPath,
    ...(input.workspaces === undefined ? {} : { workspaces: input.workspaces }),
  });
  if (!compiled.ok) return { ok: false, error: compiled.error };
  const checks = compiledChecks(compiled.spec, input);
  if (!checks.ok) return checks;
  const warnings = compiled.diagnostics
    .filter((diagnostic) => diagnostic.severity === "warning")
    .map(formatPlanDiagnostic);
  return finishExecution({
    mode: input.mode,
    ...(input.executionId === undefined ? {} : { executionId: input.executionId }),
    ...(input.now === undefined ? {} : { now: input.now }),
    spec: compiled.spec,
    rows: executionRowsFromPlan(compiled.spec),
    checks: checks.checks,
    ...(input.workspaces === undefined ? {} : { workspaces: input.workspaces }),
    ...(warnings.length === 0 ? {} : { warnings }),
  });
}

/**
 * Freeze an explicitly agreed standalone list. This is the no-plan route:
 * the model/user agreed the steps, so their wording/order is the contract.
 */
export function createFrozenTodosFromSteps(
  input: FrozenTodoBuildInput & {
    title: string;
    steps: readonly string[];
    sourceRef?: string;
    workspaces?: readonly FrozenWorkspace[];
    planCheckSpecs?: readonly PlanCheckSpec[];
  },
): FrozenTodoResult {
  const title = input.title.trim();
  if (!title) return { ok: false, error: "a title is required" };
  const steps = input.steps
    .map((step) => step.replace(/\s+/g, " ").trim())
    .filter((step) => step.length > 0);
  if (steps.length === 0) return { ok: false, error: "at least one step is required" };
  if (steps.length > 200) return { ok: false, error: "the list is too long (max 200 steps)" };
  const payload = JSON.stringify({ title, steps, sourceRef: input.sourceRef ?? null });
  if (input.planCheckSpecs !== undefined) {
    const validated = validatePlanCheckSpecs(input.planCheckSpecs, input.workspaces);
    if (!validated.ok) {
      return { ok: false, error: `plan checks are not executable: ${validated.error}` };
    }
  }
  const usedIds = new Set<string>();
  const rows: FrozenExecutionRowInput[] = steps.map((text, index) => {
    const label = String(index + 1);
    return {
      id: unique(todoItemId({ text, label }), usedIds),
      ref: label,
      text,
      label,
      checks: [],
      acceptanceCriteria: [],
      expectedFiles: [],
      workspaces: [],
      sourceLine: index + 1,
    };
  });
  const specRows: PlanSpec["rows"] = rows.map((row) => ({
    id: row.id,
    ref: row.ref,
    text: row.text,
    label: row.label ?? row.ref,
    checks: [...row.checks],
    acceptanceCriteria: [...row.acceptanceCriteria],
    expectedFiles: [...row.expectedFiles],
    workspaces: [...row.workspaces],
    ...(row.sourceLine === undefined ? {} : { sourceLine: row.sourceLine }),
  }));
  const specChecks = stepChecks(input);
  const spec: PlanSpec = {
    version: 1,
    source: {
      kind: "steps",
      ...(input.sourceRef === undefined ? {} : { path: input.sourceRef }),
      digest: digestOf(payload),
      title,
    },
    compiler: {
      version: "steps/list",
      specHash: planSpecHash({ rows: specRows, planChecks: specChecks }),
    },
    rows: specRows,
    planChecks: specChecks,
    workspaces: (input.workspaces ?? []).map((workspace) => ({ ...workspace })),
    diagnostics: [],
  };
  return finishExecution({
    mode: input.mode,
    ...(input.executionId === undefined ? {} : { executionId: input.executionId }),
    ...(input.now === undefined ? {} : { now: input.now }),
    spec,
    rows,
    checks: spec.planChecks,
    ...(input.workspaces === undefined ? {} : { workspaces: input.workspaces }),
  });
}

/**
 * Validate a persisted snapshot. A missing/unsupported shape fails closed; the
 * caller must never infer a frozen list from legacy mutable rows.
 *
 * `skipWorkspaceGeometry` keeps a historical run readable: overlap/broad-root
 * analysis is a start-time binding decision, not a reason to refuse a journal
 * that already exists on disk. Entry shape and alias references are still
 * enforced.
 */
export function validateFrozenSnapshot(
  value: unknown,
  options: { skipWorkspaceGeometry?: boolean } = {},
): FrozenTodoResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: "the frozen snapshot is not an object" };
  }
  const record = value as Record<string, unknown>;
  if (record.version !== FROZEN_TODO_SCHEMA_VERSION) {
    return { ok: false, error: `unsupported frozen snapshot version ${String(record.version)}` };
  }
  if (typeof record.executionId !== "string" || record.executionId.trim().length === 0) {
    return { ok: false, error: "the frozen snapshot has no execution id" };
  }
  if (record.mode !== "build" && record.mode !== "orchestrator") {
    return { ok: false, error: "the frozen snapshot has an unknown mode" };
  }
  const source = record.source;
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    return { ok: false, error: "the frozen snapshot has no source" };
  }
  const sourceRecord = source as Record<string, unknown>;
  if (
    (sourceRecord.kind !== "plan" && sourceRecord.kind !== "steps" && sourceRecord.kind !== "discussion") ||
    typeof sourceRecord.digest !== "string" ||
    typeof sourceRecord.title !== "string"
  ) {
    return { ok: false, error: "the frozen snapshot source is invalid" };
  }
  if (!Array.isArray(record.rows) || record.rows.length === 0) {
    return { ok: false, error: "the frozen snapshot has no rows" };
  }
  if (record.rows.length > 500) return { ok: false, error: "the frozen snapshot has too many rows" };
  let workspaceAliases: Set<string> | undefined;
  if (record.workspaces !== undefined) {
    if (!Array.isArray(record.workspaces)) {
      return { ok: false, error: "the frozen snapshot has invalid workspaces" };
    }
    if (record.workspaces.length > MAX_WORKSPACES) {
      return { ok: false, error: `more than ${MAX_WORKSPACES} workspaces` };
    }
    const roots = record.workspaces as FrozenWorkspace[];
    for (const [index, root] of roots.entries()) {
      if (
        !root ||
        typeof root !== "object" ||
        typeof (root as { id?: unknown }).id !== "string" ||
        typeof (root as { root?: unknown }).root !== "string"
      ) {
        return { ok: false, error: `workspace ${index + 1} is invalid` };
      }
    }
    if (!options.skipWorkspaceGeometry) {
      const checked = validateWorkspaceSet({
        roots,
        caseInsensitive: roots.some((root) => isWindowsPath(root.root)),
      });
      if (!checked.ok) return { ok: false, error: checked.error };
    }
    workspaceAliases = new Set(roots.map((root) => root.id.toLowerCase()));
  }
  const ids = new Set<string>();
  const refs = new Set<string>();
  let inProgress = 0;
  for (const [index, rowValue] of record.rows.entries()) {
    if (!rowValue || typeof rowValue !== "object" || Array.isArray(rowValue)) {
      return { ok: false, error: `row ${index + 1} is invalid` };
    }
    const row = rowValue as Record<string, unknown>;
    if (typeof row.id !== "string" || row.id.length === 0 || ids.has(row.id)) {
      return { ok: false, error: `row ${index + 1} has a missing/duplicate id` };
    }
    ids.add(row.id);
    const expectedRef = String(index + 1);
    if (typeof row.ref !== "string" || row.ref !== expectedRef || refs.has(row.ref)) {
      return { ok: false, error: `row ${index + 1} has an invalid ref` };
    }
    refs.add(row.ref);
    if (typeof row.text !== "string" || row.text.trim().length === 0) {
      return { ok: false, error: `row ${index + 1} has no text` };
    }
    if (!FROZEN_TODO_STATUSES.includes(row.status as TodoStatus)) {
      return { ok: false, error: `row ${index + 1} has an invalid status` };
    }
    if (row.status === "in_progress") inProgress += 1;
    if (!Array.isArray(row.acceptanceChecks) || row.acceptanceChecks.some((c) => typeof c !== "string")) {
      return { ok: false, error: `row ${index + 1} has invalid checks` };
    }
    if (!Array.isArray(row.expectedFiles) || row.expectedFiles.some((f) => typeof f !== "string")) {
      return { ok: false, error: `row ${index + 1} has invalid files` };
    }
    if (row.workspaces !== undefined) {
      if (!Array.isArray(row.workspaces) || row.workspaces.some((w) => typeof w !== "string")) {
        return { ok: false, error: `row ${index + 1} has invalid workspaces` };
      }
      if (row.workspaces.length > MAX_WORKSPACES) {
        return { ok: false, error: `row ${index + 1} has too many workspaces` };
      }
      if (workspaceAliases) {
        for (const alias of row.workspaces) {
          if (!workspaceAliases.has(String(alias).toLowerCase())) {
            return { ok: false, error: `row ${index + 1} references unknown workspace "${String(alias)}"` };
          }
        }
      }
    }
  }
  if (inProgress > 1) return { ok: false, error: "more than one row is in progress" };
  if (!Array.isArray(record.planChecks) || record.planChecks.some((c) => typeof c !== "string")) {
    return { ok: false, error: "the frozen snapshot has invalid plan checks" };
  }
  const planChecks = record.planChecks as string[];
  if (record.planCheckSpecs !== undefined) {
    if (!Array.isArray(record.planCheckSpecs)) {
      return { ok: false, error: "the frozen snapshot has invalid plan check specs" };
    }
    if (record.planCheckSpecs.length > MAX_WORKSPACES + 12) {
      return { ok: false, error: "the frozen snapshot has too many plan check specs" };
    }
    for (const [index, specValue] of record.planCheckSpecs.entries()) {
      if (!specValue || typeof specValue !== "object" || Array.isArray(specValue)) {
        return { ok: false, error: `plan check spec ${index + 1} is invalid` };
      }
      const spec = specValue as Record<string, unknown>;
      if (typeof spec.command !== "string" || !planChecks.includes(spec.command)) {
        return { ok: false, error: `plan check spec ${index + 1} has an unknown command` };
      }
      if (spec.workspace !== undefined) {
        if (typeof spec.workspace !== "string") {
          return { ok: false, error: `plan check spec ${index + 1} has an invalid workspace` };
        }
        if (workspaceAliases && !workspaceAliases.has(spec.workspace.toLowerCase())) {
          return { ok: false, error: `plan check spec ${index + 1} references unknown workspace "${spec.workspace}"` };
        }
      }
    }
  }
  return { ok: true, snapshot: value as FrozenTodoSnapshot };
}

export interface FrozenStatusUpdate {
  id?: string;
  ref?: string;
  status: TodoStatus;
}

/**
 * Status-only mutation. Structure (ids/refs/order/text) is immutable; omitted
 * rows keep their status. The whole batch is atomic.
 */
export function applyFrozenStatusUpdate(
  snapshot: FrozenTodoSnapshot,
  updates: readonly FrozenStatusUpdate[],
): FrozenTodoResult {
  const byId = new Map(snapshot.rows.map((row) => [row.id, row]));
  const byRef = new Map(snapshot.rows.map((row) => [row.ref, row]));
  const nextStatus = new Map<string, TodoStatus>();
  for (const update of updates) {
    if (!FROZEN_TODO_STATUSES.includes(update.status)) {
      return { ok: false, error: `invalid status ${String(update.status)}` };
    }
    const id = typeof update.id === "string" ? update.id : undefined;
    const ref = typeof update.ref === "string" ? update.ref : undefined;
    if ((id === undefined) === (ref === undefined)) {
      return { ok: false, error: "each update must name exactly one id or ref" };
    }
    const row = id !== undefined ? byId.get(id) : byRef.get(ref!);
    if (!row) return { ok: false, error: `unknown row ${id ?? ref}` };
    if (nextStatus.has(row.id)) return { ok: false, error: `duplicate update for ${row.id}` };
    nextStatus.set(row.id, update.status);
  }
  const rows = snapshot.rows.map((row) => ({
    ...row,
    status: nextStatus.get(row.id) ?? row.status,
  }));
  if (rows.filter((row) => row.status === "in_progress").length > 1) {
    return { ok: false, error: "more than one row is in progress" };
  }
  return {
    ok: true,
    snapshot: { ...snapshot, rows, planChecks: [...snapshot.planChecks] },
  };
}

export function frozenRowsToTodoItems(snapshot: FrozenTodoSnapshot): TodoItem[] {
  return snapshot.rows.map((row) => ({
    step: Number(row.ref),
    text: row.text,
    completed: row.status === "completed",
    status: row.status,
    id: row.id,
    ref: row.ref,
    label: row.label ?? row.ref,
    ...(row.group === undefined ? {} : { group: row.group }),
    ...(row.planStepId === undefined ? {} : { planStepId: row.planStepId }),
    source: row.source === "plan" ? ("plan" as const) : ("agent" as const),
  }));
}
