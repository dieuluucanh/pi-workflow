/**
 * Workflow Extension — frozen execution snapshot v2 (typed, content-addressed).
 *
 * v1 (`todo-snapshot.ts`) froze rows plus an opaque `planChecks: string[]`.
 * That shape could not tell a command from a sentence, so the 2026-11-21 run
 * executed five Markdown bullets. v2 keeps the same durable identity (row ids,
 * refs, statuses) but stores *typed* checks and a validation report, and keeps
 * the v1 fields as derived views so the panel, tools and existing call sites
 * keep working unchanged.
 *
 * Compatibility rules (Decision 11):
 *   - read v1, write v2;
 *   - a malformed v1 check is quarantined with its exact bytes and never
 *     executed, but it does not make the journal unreadable;
 *   - an unknown future snapshot version fails closed (the run stays loadable
 *     as data, but the caller must refuse to execute it).
 *
 * Nothing here reads the filesystem, the clock or a plan. Freezing is a pure
 * function of compiled input; upcasting is a pure function of stored bytes.
 */

import {
  legacyAcceptanceChecks,
  legacyCheckViews,
  MAX_WORKSPACES,
  planCheckId,
  rowCheckId,
  sha256Hex,
  stableStringify,
  validateCheckSpec,
  validatePlanRow,
  validatePlanSource,
  validatePlanSpec,
  type CheckSpec,
  type PlanRow,
  type PlanSpec,
  type SpecResult,
} from "./plan-spec.ts";
import {
  validateCommandShape,
  type PlanCheckSpec,
} from "./plan-checks.ts";
import {
  type FrozenWorkspace,
} from "./orchestrator-workspace-set.ts";
import {
  FROZEN_TODO_STATUSES,
  FROZEN_TODO_SCHEMA_VERSION,
  validateFrozenSnapshot,
  type FrozenTodoMode,
  type FrozenTodoRow,
  type FrozenTodoSnapshot,
} from "./todo-snapshot.ts";
import type { TodoStatus } from "./utils.ts";

/** Written by new freezes. Read by `readFrozenSnapshot`. */
export const FROZEN_EXECUTION_SCHEMA_VERSION = 2 as const;
/** The legacy shape this module upcasts from. */
export const FROZEN_V1_SCHEMA_VERSION = 1 as const;
/** Compiler label recorded on an in-memory upcast; never persisted by a freeze. */
export const FROZEN_V1_UPCAST_COMPILER = "upcast-v1" as const;

export const MAX_SNAPSHOT_ROWS = 500;
export const MAX_QUARANTINED_CHECKS = 200;

const SHA256 = /^[a-f0-9]{64}$/;
const SNAPSHOT_KEYS: ReadonlySet<string> = new Set([
  "schemaVersion",
  "executionId",
  "mode",
  "source",
  "compiler",
  "rows",
  "checks",
  "planChecks",
  "planCheckSpecs",
  "workspaces",
  "validation",
  "createdAt",
]);
const ROW_KEYS: ReadonlySet<string> = new Set([
  "id",
  "ref",
  "text",
  "label",
  "group",
  "source",
  "planStepId",
  "status",
  "sourceLine",
  "checks",
  "acceptanceCriteria",
  "expectedFiles",
  "workspaces",
  "acceptanceChecks",
]);
const VALIDATION_KEYS: ReadonlySet<string> = new Set([
  "ok",
  "errors",
  "warnings",
  "quarantined",
]);
const QUARANTINE_KEYS: ReadonlySet<string> = new Set([
  "scope",
  "rowRef",
  "index",
  "command",
  "reason",
  "fromVersion",
]);

/** A v1 check that could not be typed, kept for repair and never executed. */
export interface QuarantinedCheck {
  scope: "plan" | "row";
  rowRef?: string;
  /** Position in the source list it came from (0-based). */
  index: number;
  /** Exact historical bytes; may be prose or malformed. */
  command: string;
  reason: string;
  fromVersion: 1 | 2;
}

export interface FrozenSnapshotValidation {
  /** False when any error exists or a check was quarantined. */
  ok: boolean;
  errors: string[];
  warnings: string[];
  quarantined: QuarantinedCheck[];
}

export interface FrozenExecutionSource {
  /** v2 drops the never-emitted `discussion` kind. */
  kind: "plan" | "steps";
  path?: string;
  /** Semantic digest the run identity binds to. */
  digest: string;
  /** Hash of the exact source bytes, when the source is a file. */
  bytesSha256?: string;
  title: string;
}

export interface FrozenExecutionCompiler {
  /** Compiler contract version, or `upcast-v1` for an in-memory v1 read. */
  version: string;
  /** Content hash over rows/checks; validated on every read. */
  specHash: string;
}

export interface FrozenExecutionRow {
  id: string;
  ref: string;
  text: string;
  label?: string;
  group?: string;
  source: "plan" | "steps";
  planStepId?: string;
  status: TodoStatus;
  sourceLine?: number;
  /** Authoritative executable row checks. */
  checks: CheckSpec[];
  /** Authoritative evidence criteria; never executed. */
  acceptanceCriteria: string[];
  expectedFiles: string[];
  workspaces?: string[];
  /** Derived legacy view: check commands followed by criteria. */
  acceptanceChecks: string[];
}

export interface FrozenExecutionSnapshot {
  schemaVersion: typeof FROZEN_EXECUTION_SCHEMA_VERSION;
  executionId: string;
  mode: FrozenTodoMode;
  source: FrozenExecutionSource;
  compiler: FrozenExecutionCompiler;
  rows: FrozenExecutionRow[];
  /** Authoritative plan-level typed checks. */
  checks: CheckSpec[];
  /** Derived legacy view: every check command, in order. */
  planChecks: string[];
  /** Derived legacy view: command + workspace alias. */
  planCheckSpecs: PlanCheckSpec[];
  workspaces?: FrozenWorkspace[];
  validation: FrozenSnapshotValidation;
  createdAt: number;
}

export type FrozenSnapshotReadResult =
  | {
      ok: true;
      snapshot: FrozenExecutionSnapshot;
      fromVersion: 1 | 2;
      warnings: string[];
      quarantined: QuarantinedCheck[];
    }
  | { ok: false; code: "unknown_version" | "invalid"; error: string };

function fail<T>(error: string): SpecResult<T> {
  return { ok: false, error };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function unknownKeys(
  record: Record<string, unknown>,
  allowed: ReadonlySet<string>,
): string[] {
  return Object.keys(record).filter((key) => !allowed.has(key));
}

function boundedStringArray(
  value: unknown,
  label: string,
  max: number,
): SpecResult<string[]> {
  if (!Array.isArray(value)) return fail(`${label} is not an array`);
  if (value.length > max) return fail(`more than ${max} ${label} entries`);
  for (const [index, entry] of value.entries()) {
    if (typeof entry !== "string") return fail(`${label} entry ${index + 1} is not a string`);
  }
  return { ok: true, value: [...(value as string[])] };
}

function workspaceAliases(
  workspaces: readonly FrozenWorkspace[] | undefined,
): string[] {
  return (workspaces ?? []).map((workspace) => workspace.id);
}

/**
 * Content hash over the executable contract. Kept independent of timestamps,
 * compiler version and the derived legacy views, so a re-read/upcast is
 * deterministic and a freeze that reuses the same rows/checks hashes equal.
 */
export function frozenSpecHash(input: {
  rows: readonly Pick<
    FrozenExecutionRow,
    "id" | "ref" | "text" | "checks" | "acceptanceCriteria" | "expectedFiles" | "workspaces"
  >[];
  checks: readonly CheckSpec[];
}): string {
  return sha256Hex(
    stableStringify({
      rows: input.rows.map((row) => ({
        id: row.id,
        ref: row.ref,
        text: row.text,
        checks: row.checks,
        acceptanceCriteria: row.acceptanceCriteria,
        expectedFiles: row.expectedFiles,
        workspaces: row.workspaces ?? [],
      })),
      checks: input.checks,
    }),
  );
}

function specHashOf(snapshot: Pick<FrozenExecutionSnapshot, "rows" | "checks">): string {
  return frozenSpecHash(snapshot);
}

function sortedViews(snapshot: { checks: readonly CheckSpec[] }): {
  planChecks: string[];
  planCheckSpecs: PlanCheckSpec[];
} {
  return legacyCheckViews(snapshot.checks);
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameSpecs(left: readonly PlanCheckSpec[], right: readonly PlanCheckSpec[]): boolean {
  return (
    left.length === right.length &&
    left.every(
      (value, index) =>
        value.command === right[index]!.command && value.workspace === right[index]!.workspace,
    )
  );
}

/** Validate the derived legacy views against the typed source of truth. */
function checkDrift(snapshot: {
  checks: readonly CheckSpec[];
  planChecks: readonly string[];
  planCheckSpecs: readonly PlanCheckSpec[];
  rows: readonly FrozenExecutionRow[];
}): string | undefined {
  const views = sortedViews(snapshot);
  if (!sameStrings(views.planChecks, snapshot.planChecks)) {
    return "derived planChecks do not match the typed checks";
  }
  if (!sameSpecs(views.planCheckSpecs, snapshot.planCheckSpecs)) {
    return "derived planCheckSpecs do not match the typed checks";
  }
  for (const row of snapshot.rows) {
    const derived = legacyAcceptanceChecks(row);
    if (!sameStrings(derived, row.acceptanceChecks)) {
      return `row ${row.ref} derived acceptanceChecks do not match checks + criteria`;
    }
  }
  return undefined;
}

const ALIAS = /^[A-Za-z][A-Za-z0-9_-]{0,23}$/;

/**
 * Structural workspace validation only. Overlap/broad-root analysis is a
 * start-time binding decision; re-running it on every read would make a
 * historical run unreadable and lose journal history. Alias uniqueness and
 * shape are still enforced because rows/checks bind to them.
 */
function validateWorkspaces(value: unknown): SpecResult<FrozenWorkspace[] | undefined> {
  if (value === undefined) return { ok: true, value: undefined };
  if (!Array.isArray(value)) return fail("the frozen snapshot has invalid workspaces");
  if (value.length > MAX_WORKSPACES) {
    return fail(`the frozen snapshot has more than ${MAX_WORKSPACES} workspaces`);
  }
  const roots = value as FrozenWorkspace[];
  const aliases = new Set<string>();
  const keys = new Set<string>();
  let primaries = 0;
  for (const [index, root] of roots.entries()) {
    if (!isRecord(root) || typeof root.id !== "string" || typeof root.root !== "string") {
      return fail(`the frozen snapshot workspace ${index + 1} is invalid`);
    }
    if (!ALIAS.test(root.id)) {
      return fail(`workspace ${index + 1} has an invalid alias`);
    }
    if (root.root.trim().length === 0) {
      return fail(`workspace ${root.id} has no root`);
    }
    if (typeof root.key !== "string" || root.key.trim().length === 0) {
      return fail(`workspace ${root.id} has no identity key`);
    }
    if (root.kind !== "git" && root.kind !== "plain") {
      return fail(`workspace ${root.id} has an unknown kind`);
    }
    if (typeof root.primary !== "boolean") {
      return fail(`workspace ${root.id} has an invalid primary flag`);
    }
    if (root.primary) primaries += 1;
    if (aliases.has(root.id.toLowerCase())) {
      return fail(`duplicate workspace alias "${root.id}"`);
    }
    if (keys.has(root.key)) return fail(`duplicate workspace root for ${root.id}`);
    aliases.add(root.id.toLowerCase());
    keys.add(root.key);
  }
  if (roots.length > 0 && primaries !== 1) {
    return fail("exactly one primary workspace is required");
  }
  return { ok: true, value: roots };
}

function validateQuarantine(value: unknown): SpecResult<QuarantinedCheck[]> {
  if (!Array.isArray(value)) return fail("validation.quarantined is not an array");
  if (value.length > MAX_QUARANTINED_CHECKS) {
    return fail(`validation.quarantined has more than ${MAX_QUARANTINED_CHECKS} entries`);
  }
  const out: QuarantinedCheck[] = [];
  for (const [index, entry] of value.entries()) {
    if (!isRecord(entry)) return fail(`quarantined check ${index + 1} is not an object`);
    const extra = unknownKeys(entry, QUARANTINE_KEYS);
    if (extra.length > 0) {
      return fail(`quarantined check ${index + 1} has unknown field(s): ${extra.join(", ")}`);
    }
    if (entry.scope !== "plan" && entry.scope !== "row") {
      return fail(`quarantined check ${index + 1} has an invalid scope`);
    }
    if (
      typeof entry.index !== "number" ||
      !Number.isInteger(entry.index) ||
      entry.index < 0
    ) {
      return fail(`quarantined check ${index + 1} has an invalid index`);
    }
    if (typeof entry.command !== "string" || typeof entry.reason !== "string") {
      return fail(`quarantined check ${index + 1} is missing command/reason`);
    }
    if (entry.scope === "row" && typeof entry.rowRef !== "string") {
      return fail(`quarantined row check ${index + 1} has no rowRef`);
    }
    if (entry.fromVersion !== 1 && entry.fromVersion !== 2) {
      return fail(`quarantined check ${index + 1} has an invalid fromVersion`);
    }
    out.push({
      scope: entry.scope,
      ...(entry.rowRef === undefined ? {} : { rowRef: entry.rowRef as string }),
      index: entry.index,
      command: entry.command,
      reason: entry.reason,
      fromVersion: entry.fromVersion,
    });
  }
  return { ok: true, value: out };
}

function validateValidation(value: unknown): SpecResult<FrozenSnapshotValidation> {
  if (!isRecord(value)) return fail("the frozen snapshot has no validation report");
  const extra = unknownKeys(value, VALIDATION_KEYS);
  if (extra.length > 0) {
    return fail(`validation report has unknown field(s): ${extra.join(", ")}`);
  }
  if (typeof value.ok !== "boolean") return fail("validation.ok is not a boolean");
  const errors = boundedStringArray(value.errors, "validation.errors", 200);
  if (!errors.ok) return errors;
  const warnings = boundedStringArray(value.warnings, "validation.warnings", 200);
  if (!warnings.ok) return warnings;
  const quarantined = validateQuarantine(value.quarantined);
  if (!quarantined.ok) return quarantined;
  if (value.ok !== (errors.value.length === 0 && quarantined.value.length === 0)) {
    return fail("validation.ok does not match its errors/quarantined checks");
  }
  return {
    ok: true,
    value: {
      ok: value.ok,
      errors: errors.value,
      warnings: warnings.value,
      quarantined: quarantined.value,
    },
  };
}

function parseFrozenRow(
  value: unknown,
  workspaces: readonly FrozenWorkspace[] | undefined,
): SpecResult<FrozenExecutionRow> {
  if (!isRecord(value)) return fail("row is not an object");
  const extra = unknownKeys(value, ROW_KEYS);
  if (extra.length > 0) return fail(`row has unknown field(s): ${extra.join(", ")}`);
  // Reuse the plan-row parser for the shared fields, then require the frozen
  // identity fields it does not own.
  const planRow = validatePlanRow(
    {
      id: value.id,
      ref: value.ref,
      text: value.text,
      label: value.label,
      group: value.group,
      checks: value.checks,
      acceptanceCriteria: value.acceptanceCriteria,
      expectedFiles: value.expectedFiles,
      workspaces: value.workspaces ?? [],
      sourceLine: value.sourceLine,
    },
    workspaces === undefined ? {} : { workspaces },
  );
  if (!planRow.ok) return planRow;
  if (value.source !== "plan" && value.source !== "steps") {
    return fail(`row ${planRow.value.ref} has an invalid source`);
  }
  if (!FROZEN_TODO_STATUSES.includes(value.status as TodoStatus)) {
    return fail(`row ${planRow.value.ref} has an invalid status`);
  }
  if (value.planStepId !== undefined && typeof value.planStepId !== "string") {
    return fail(`row ${planRow.value.ref} has an invalid planStepId`);
  }
  const acceptanceChecks = boundedStringArray(
    value.acceptanceChecks,
    `row ${planRow.value.ref} acceptanceChecks`,
    200,
  );
  if (!acceptanceChecks.ok) return acceptanceChecks;
  return {
    ok: true,
    value: {
      id: planRow.value.id,
      ref: planRow.value.ref,
      text: planRow.value.text,
      ...(planRow.value.label === undefined ? {} : { label: planRow.value.label }),
      ...(planRow.value.group === undefined ? {} : { group: planRow.value.group }),
      source: value.source,
      ...(value.planStepId === undefined
        ? {}
        : { planStepId: value.planStepId as string }),
      status: value.status as TodoStatus,
      ...(planRow.value.sourceLine === undefined
        ? {}
        : { sourceLine: planRow.value.sourceLine }),
      checks: planRow.value.checks,
      acceptanceCriteria: planRow.value.acceptanceCriteria,
      expectedFiles: planRow.value.expectedFiles,
      ...(planRow.value.workspaces.length === 0
        ? {}
        : { workspaces: planRow.value.workspaces }),
      acceptanceChecks: acceptanceChecks.value,
    },
  };
}

/**
 * Parse a persisted v2 snapshot. Bounds, identity, workspace aliases, derived
 * views and the content hash are all re-checked; nothing is trusted because it
 * came from our own writer.
 */
export function validateFrozenExecutionSnapshot(
  value: unknown,
): SpecResult<FrozenExecutionSnapshot> {
  if (!isRecord(value)) return fail("the frozen snapshot is not an object");
  const extra = unknownKeys(value, SNAPSHOT_KEYS);
  if (extra.length > 0) {
    return fail(`the frozen snapshot has unknown field(s): ${extra.join(", ")}`);
  }
  if (value.schemaVersion !== FROZEN_EXECUTION_SCHEMA_VERSION) {
    return fail(`unsupported frozen snapshot version ${String(value.schemaVersion)}`);
  }
  if (typeof value.executionId !== "string" || value.executionId.trim().length === 0) {
    return fail("the frozen snapshot has no execution id");
  }
  if (value.mode !== "build" && value.mode !== "orchestrator") {
    return fail("the frozen snapshot has an unknown mode");
  }
  if (
    typeof value.createdAt !== "number" ||
    !Number.isFinite(value.createdAt) ||
    value.createdAt < 0
  ) {
    return fail("the frozen snapshot has an invalid createdAt");
  }
  const source = validatePlanSource(value.source);
  if (!source.ok) return source;
  if (!isRecord(value.compiler)) return fail("the frozen snapshot has no compiler info");
  const compilerExtra = unknownKeys(value.compiler, new Set(["version", "specHash"]));
  if (compilerExtra.length > 0) {
    return fail(`compiler info has unknown field(s): ${compilerExtra.join(", ")}`);
  }
  if (
    typeof value.compiler.version !== "string" ||
    value.compiler.version.trim().length === 0
  ) {
    return fail("the frozen snapshot compiler has no version");
  }
  if (typeof value.compiler.specHash !== "string" || !SHA256.test(value.compiler.specHash)) {
    return fail("the frozen snapshot compiler has an invalid specHash");
  }
  const workspaces = validateWorkspaces(value.workspaces);
  if (!workspaces.ok) return workspaces;
  if (!Array.isArray(value.rows) || value.rows.length === 0) {
    return fail("the frozen snapshot has no rows");
  }
  if (value.rows.length > MAX_SNAPSHOT_ROWS) {
    return fail(`the frozen snapshot has more than ${MAX_SNAPSHOT_ROWS} rows`);
  }
  const rows: FrozenExecutionRow[] = [];
  const ids = new Set<string>();
  const refs = new Set<string>();
  let inProgress = 0;
  for (const [index, rowValue] of value.rows.entries()) {
    const parsed = parseFrozenRow(rowValue, workspaces.value);
    if (!parsed.ok) return parsed;
    const expectedRef = String(index + 1);
    if (parsed.value.ref !== expectedRef) {
      return fail(
        `row ${index + 1} has ref "${parsed.value.ref}" (expected "${expectedRef}")`,
      );
    }
    if (ids.has(parsed.value.id)) return fail(`duplicate row id ${parsed.value.id}`);
    if (refs.has(parsed.value.ref)) return fail(`duplicate row ref ${parsed.value.ref}`);
    ids.add(parsed.value.id);
    refs.add(parsed.value.ref);
    if (parsed.value.status === "in_progress") inProgress += 1;
    rows.push(parsed.value);
  }
  if (inProgress > 1) return fail("more than one row is in progress");
  if (!Array.isArray(value.checks)) return fail("the frozen snapshot checks is not an array");
  const checks: CheckSpec[] = [];
  const checkIds = new Set<string>();
  for (const [index, check] of value.checks.entries()) {
    const parsed = validateCheckSpec(check, {
      ...(workspaces.value === undefined ? {} : { workspaces: workspaces.value }),
      label: `plan check ${index + 1}`,
    });
    if (!parsed.ok) return parsed;
    if (checkIds.has(parsed.value.id)) {
      return fail(`duplicate plan check id ${parsed.value.id}`);
    }
    checkIds.add(parsed.value.id);
    checks.push(parsed.value);
  }
  const planChecks = boundedStringArray(value.planChecks, "planChecks", checks.length);
  if (!planChecks.ok) return planChecks;
  if (!Array.isArray(value.planCheckSpecs)) {
    return fail("the frozen snapshot planCheckSpecs is not an array");
  }
  const planCheckSpecs: PlanCheckSpec[] = [];
  for (const [index, spec] of value.planCheckSpecs.entries()) {
    if (!isRecord(spec) || typeof spec.command !== "string") {
      return fail(`plan check spec ${index + 1} is invalid`);
    }
    if (spec.workspace !== undefined && typeof spec.workspace !== "string") {
      return fail(`plan check spec ${index + 1} has an invalid workspace`);
    }
    planCheckSpecs.push({
      command: spec.command,
      ...(spec.workspace === undefined ? {} : { workspace: spec.workspace }),
    });
  }
  const validation = validateValidation(value.validation);
  if (!validation.ok) return validation;
  const drift = checkDrift({ checks, planChecks: planChecks.value, planCheckSpecs, rows });
  if (drift) return fail(drift);
  const snapshot: FrozenExecutionSnapshot = {
    schemaVersion: FROZEN_EXECUTION_SCHEMA_VERSION,
    executionId: value.executionId,
    mode: value.mode,
    source: source.value,
    compiler: {
      version: value.compiler.version,
      specHash: value.compiler.specHash,
    },
    rows,
    checks,
    planChecks: planChecks.value,
    planCheckSpecs,
    ...(workspaces.value === undefined ? {} : { workspaces: workspaces.value }),
    validation: validation.value,
    createdAt: value.createdAt,
  };
  if (specHashOf(snapshot) !== snapshot.compiler.specHash) {
    return fail("the frozen snapshot spec hash does not match its rows/checks");
  }
  return { ok: true, value: snapshot };
}

export interface FrozenExecutionRowInput extends PlanRow {
  status?: TodoStatus;
  source?: "plan" | "steps";
  planStepId?: string;
}

export interface BuildFrozenExecutionInput {
  executionId: string;
  mode: FrozenTodoMode;
  source: FrozenExecutionSource;
  compilerVersion: string;
  rows: readonly FrozenExecutionRowInput[];
  checks: readonly CheckSpec[];
  workspaces?: readonly FrozenWorkspace[];
  validation?: Partial<FrozenSnapshotValidation>;
  createdAt: number;
}

/**
 * Build the v2 artifact once. Derived views and the content hash are computed
 * here, then the whole result runs through the reader, so a freeze cannot
 * persist something the reader would reject.
 */
export function buildFrozenExecutionSnapshot(
  input: BuildFrozenExecutionInput,
): SpecResult<FrozenExecutionSnapshot> {
  const rows: FrozenExecutionRow[] = input.rows.map((row) => ({
    id: row.id,
    ref: row.ref,
    text: row.text,
    ...(row.label === undefined ? {} : { label: row.label }),
    ...(row.group === undefined ? {} : { group: row.group }),
    source: row.source ?? (input.source.kind === "plan" ? "plan" : "steps"),
    ...(row.planStepId === undefined ? {} : { planStepId: row.planStepId }),
    status: row.status ?? "pending",
    ...(row.sourceLine === undefined ? {} : { sourceLine: row.sourceLine }),
    checks: [...row.checks],
    acceptanceCriteria: [...row.acceptanceCriteria],
    expectedFiles: [...row.expectedFiles],
    ...(row.workspaces.length === 0 ? {} : { workspaces: [...row.workspaces] }),
    acceptanceChecks: legacyAcceptanceChecks(row),
  }));
  const checks = [...input.checks];
  const views = legacyCheckViews(checks);
  const errors = [...(input.validation?.errors ?? [])];
  const warnings = [...(input.validation?.warnings ?? [])];
  const quarantined = [...(input.validation?.quarantined ?? [])];
  const snapshot: FrozenExecutionSnapshot = {
    schemaVersion: FROZEN_EXECUTION_SCHEMA_VERSION,
    executionId: input.executionId,
    mode: input.mode,
    source: input.source,
    compiler: {
      version: input.compilerVersion,
      specHash: frozenSpecHash({ rows, checks }),
    },
    rows,
    checks,
    planChecks: views.planChecks,
    planCheckSpecs: views.planCheckSpecs,
    ...(input.workspaces === undefined || input.workspaces.length === 0
      ? {}
      : { workspaces: input.workspaces.map((workspace) => ({ ...workspace })) }),
    validation: {
      ok: errors.length === 0 && quarantined.length === 0,
      errors,
      warnings,
      quarantined,
    },
    createdAt: input.createdAt,
  };
  return validateFrozenExecutionSnapshot(snapshot);
}

function withPlannedCheck(
  command: string,
  index: number,
  spec: { workspace?: string; kind?: unknown } | undefined,
  rowRef?: string,
): SpecResult<CheckSpec> {
  const shape = validateCommandShape(command);
  if (!shape.ok) return fail(shape.error);
  const kind =
    spec?.kind === "gate" || spec?.kind === "diagnostic" || spec?.kind === "manual"
      ? spec.kind
      : "gate";
  return {
    ok: true,
    value: {
      id: rowRef === undefined ? planCheckId(index) : rowCheckId(rowRef, index),
      command,
      ...(spec?.workspace === undefined ? {} : { workspace: spec.workspace }),
      kind,
    },
  };
}

function legacyKind(spec: { kind?: unknown } | undefined): unknown {
  return spec?.kind;
}

/**
 * Upcast a v1 frozen snapshot in memory. Commands are typed only when they are
 * actually command-shaped; prose `acceptanceChecks` becomes criteria and
 * malformed plan checks are quarantined with their exact bytes. The v1 array
 * on disk is never rewritten.
 */
export function upcastFrozenSnapshotV1(value: unknown): SpecResult<{
  snapshot: FrozenExecutionSnapshot;
  warnings: string[];
  quarantined: QuarantinedCheck[];
}> {
  const legacy = validateFrozenSnapshot(value, { skipWorkspaceGeometry: true });
  if (!legacy.ok) return fail(legacy.error);
  const v1 = legacy.snapshot;
  const rows: FrozenExecutionRow[] = [];
  const quarantined: QuarantinedCheck[] = [];
  const warnings: string[] = [
    `frozen snapshot v1 read; upcast to schemaVersion ${FROZEN_EXECUTION_SCHEMA_VERSION}`,
  ];
  for (const row of v1.rows) {
    const checks: CheckSpec[] = [];
    const criteria: string[] = [];
    let dropped = 0;
    for (const candidate of row.acceptanceChecks) {
      const parsed = withPlannedCheck(candidate, checks.length, undefined, row.ref);
      if (parsed.ok) {
        checks.push(parsed.value);
        continue;
      }
      criteria.push(candidate);
      if (candidate.trim() !== "" && validateCommandShape(candidate).ok === false) {
        dropped += 1;
      }
    }
    if (dropped > 0) {
      warnings.push(
        `row ${row.ref}: ${dropped} v1 acceptance value(s) kept as criteria and not executed`,
      );
    }
    rows.push({
      id: row.id,
      ref: row.ref,
      text: row.text,
      ...(row.label === undefined ? {} : { label: row.label }),
      ...(row.group === undefined ? {} : { group: row.group }),
      source: row.source,
      ...(row.planStepId === undefined ? {} : { planStepId: row.planStepId }),
      status: row.status,
      ...(row.sourceLine === undefined ? {} : { sourceLine: row.sourceLine }),
      checks,
      acceptanceCriteria: criteria,
      expectedFiles: [...row.expectedFiles],
      ...(row.workspaces === undefined || row.workspaces.length === 0
        ? {}
        : { workspaces: [...row.workspaces] }),
      acceptanceChecks: legacyAcceptanceChecks({ checks, acceptanceCriteria: criteria }),
    });
  }
  const specByCommand = new Map<string, { workspace?: string; kind?: unknown }>();
  for (const spec of v1.planCheckSpecs ?? []) {
    if (!specByCommand.has(spec.command)) {
      specByCommand.set(spec.command, {
        ...(spec.workspace === undefined ? {} : { workspace: spec.workspace }),
        kind: legacyKind(spec as unknown as Record<string, unknown>),
      });
    }
  }
  const checks: CheckSpec[] = [];
  for (const [sourceIndex, command] of v1.planChecks.entries()) {
    const parsed = withPlannedCheck(command, checks.length, specByCommand.get(command));
    if (!parsed.ok) {
      quarantined.push({
        scope: "plan",
        index: sourceIndex,
        command,
        reason: parsed.error,
        fromVersion: 1,
      });
      continue;
    }
    checks.push(parsed.value);
  }
  if (quarantined.length > 0) {
    warnings.push(
      `${quarantined.length} v1 plan check(s) quarantined and never executed; amend the run to repair them`,
    );
  }
  if (v1.source.kind === "discussion") {
    return fail(
      'frozen snapshot v1 source kind "discussion" has no v2 equivalent; recreate the run from a plan or step list',
    );
  }
  const snapshot: FrozenExecutionSnapshot = {
    schemaVersion: FROZEN_EXECUTION_SCHEMA_VERSION,
    executionId: v1.executionId,
    mode: v1.mode,
    source: {
      kind: v1.source.kind,
      ...(v1.source.path === undefined ? {} : { path: v1.source.path }),
      digest: v1.source.digest,
      ...(v1.source.kind === "plan" ? { bytesSha256: v1.source.digest } : {}),
      title: v1.source.title,
    },
    compiler: {
      version: FROZEN_V1_UPCAST_COMPILER,
      specHash: frozenSpecHash({ rows, checks }),
    },
    rows,
    checks,
    planChecks: legacyCheckViews(checks).planChecks,
    planCheckSpecs: legacyCheckViews(checks).planCheckSpecs,
    ...(v1.workspaces === undefined ? {} : { workspaces: v1.workspaces.map((w) => ({ ...w })) }),
    validation: {
      ok: quarantined.length === 0,
      errors: [],
      warnings,
      quarantined,
    },
    createdAt: v1.createdAt,
  };
  const validated = validateFrozenExecutionSnapshot(snapshot);
  if (!validated.ok) return validated;
  return { ok: true, value: { snapshot: validated.value, warnings, quarantined } };
}

/**
 * Read any stored frozen snapshot. v1 upcasts in memory; v2 validates; an
 * unknown future version fails closed so a newer writer can never be half-read.
 */
export function readFrozenSnapshot(value: unknown): FrozenSnapshotReadResult {
  if (!isRecord(value)) {
    return { ok: false, code: "invalid", error: "the frozen snapshot is not an object" };
  }
  const schemaVersion = value.schemaVersion;
  if (schemaVersion !== undefined) {
    if (schemaVersion !== FROZEN_EXECUTION_SCHEMA_VERSION) {
      return {
        ok: false,
        code: "unknown_version",
        error: `unknown frozen snapshot version ${String(schemaVersion)}; this build reads v1 and v2`,
      };
    }
    const parsed = validateFrozenExecutionSnapshot(value);
    if (!parsed.ok) return { ok: false, code: "invalid", error: parsed.error };
    return {
      ok: true,
      snapshot: parsed.value,
      fromVersion: 2,
      warnings: [],
      quarantined: parsed.value.validation.quarantined,
    };
  }
  // v1 marks itself with `version`. Anything else is a foreign/unknown shape.
  if (value.version !== FROZEN_V1_SCHEMA_VERSION) {
    if (typeof value.version === "number") {
      return {
        ok: false,
        code: "unknown_version",
        error: `unknown frozen snapshot version ${String(value.version)}; this build reads v1 and v2`,
      };
    }
    return { ok: false, code: "invalid", error: "the frozen snapshot has no version" };
  }
  const upcast = upcastFrozenSnapshotV1(value);
  if (!upcast.ok) return { ok: false, code: "invalid", error: upcast.error };
  return {
    ok: true,
    snapshot: upcast.value.snapshot,
    fromVersion: 1,
    warnings: upcast.value.warnings,
    quarantined: upcast.value.quarantined,
  };
}

/** Version marker of a stored snapshot, without parsing it. */
export function frozenSnapshotVersionOf(value: unknown): number | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.schemaVersion === "number") return value.schemaVersion;
  if (typeof value.version === "number") return value.version;
  return undefined;
}

/**
 * Project a v2 snapshot back to the v1 shape. Existing consumers (`RunState`,
 * the todo service, the panel, the legacy executor) read a `FrozenTodoSnapshot`;
 * the projection keeps them working until they are switched to typed checks.
 */
export function frozenExecutionToTodoSnapshot(
  snapshot: FrozenExecutionSnapshot,
): FrozenTodoSnapshot {
  const rows: FrozenTodoRow[] = snapshot.rows.map((row) => ({
    id: row.id,
    ref: row.ref,
    text: row.text,
    ...(row.label === undefined ? {} : { label: row.label }),
    ...(row.group === undefined ? {} : { group: row.group }),
    source: row.source,
    ...(row.planStepId === undefined ? {} : { planStepId: row.planStepId }),
    acceptanceChecks: [...row.acceptanceChecks],
    expectedFiles: [...row.expectedFiles],
    ...(row.workspaces === undefined ? {} : { workspaces: [...row.workspaces] }),
    status: row.status,
    ...(row.sourceLine === undefined ? {} : { sourceLine: row.sourceLine }),
  }));
  return {
    version: FROZEN_TODO_SCHEMA_VERSION,
    executionId: snapshot.executionId,
    mode: snapshot.mode,
    source: {
      kind: snapshot.source.kind,
      ...(snapshot.source.path === undefined ? {} : { path: snapshot.source.path }),
      digest: snapshot.source.digest,
      title: snapshot.source.title,
    },
    rows,
    planChecks: [...snapshot.planChecks],
    ...(snapshot.workspaces === undefined
      ? {}
      : { workspaces: snapshot.workspaces.map((workspace) => ({ ...workspace })) }),
    planCheckSpecs: snapshot.planCheckSpecs.map((spec) => ({ ...spec })),
    createdAt: snapshot.createdAt,
  };
}

/** Project a v2 snapshot to the compiler contract (for lint/preview callers). */
export function frozenExecutionToPlanSpec(
  snapshot: FrozenExecutionSnapshot,
): SpecResult<PlanSpec> {
  const rows: PlanRow[] = snapshot.rows.map((row) => ({
    id: row.id,
    ref: row.ref,
    text: row.text,
    ...(row.label === undefined ? {} : { label: row.label }),
    ...(row.group === undefined ? {} : { group: row.group }),
    checks: row.checks,
    acceptanceCriteria: row.acceptanceCriteria,
    expectedFiles: row.expectedFiles,
    workspaces: row.workspaces ?? [],
    ...(row.sourceLine === undefined ? {} : { sourceLine: row.sourceLine }),
  }));
  const diagnostics = [
    ...snapshot.validation.errors.map((message) => ({
      severity: "error" as const,
      code: "frozen.validation",
      message,
    })),
    ...snapshot.validation.warnings.map((message) => ({
      severity: "warning" as const,
      code: "frozen.validation",
      message,
    })),
  ];
  const spec: PlanSpec = {
    version: 1,
    source: snapshot.source,
    compiler: snapshot.compiler,
    rows,
    planChecks: snapshot.checks,
    workspaces: snapshot.workspaces ?? [],
    diagnostics,
  };
  const validated = validatePlanSpec(spec);
  return validated.ok ? { ok: true, value: validated.value } : validated;
}
