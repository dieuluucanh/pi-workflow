/**
 * Workflow Extension — typed plan-execution contract (v1).
 *
 * This module is the single source of truth for "what a plan step may execute".
 * The 2026-11-21 incident happened because a Markdown sentence was treated as a
 * shell command: `Acceptance:` prose reached the executor and `pnpm` was asked
 * to run `dev:preflight\`,`.
 *
 * The contract therefore separates two things that prose used to conflate:
 *   - `CheckSpec.command` is executable data. It is byte-exact, single-line and
 *     validated at every boundary (`validateCommandShape`).
 *   - `PlanRow.acceptanceCriteria` is evidence people read. It is never executed.
 *
 * Everything here is pure: no clock, no filesystem, no compiler. The compiler
 * (`plan-compiler.ts`) produces a `PlanSpec`; freeze turns it into a
 * `FrozenExecutionSnapshot` v2 (`frozen-snapshot.ts`). Both validate the stored
 * value with these parsers, so a hand-edited or foreign artifact fails closed
 * instead of being trusted because it "looks like the right shape".
 */

import { createHash } from "node:crypto";

import { validateCommandShape } from "./plan-command-shape.ts";
import type { PlanCheckSpec } from "./plan-checks.ts";
import type { FrozenWorkspace } from "./orchestrator-workspace-set.ts";

/** Version of the in-memory `PlanSpec` contract. */
export const PLAN_SPEC_VERSION = 1 as const;

/**
 * Check kinds:
 *   - `gate` must pass before a row/run is accepted;
 *   - `diagnostic` runs and reports, but never blocks acceptance;
 *   - `manual` is a human attestation and is never executed automatically.
 */
export const CHECK_KINDS = ["gate", "diagnostic", "manual"] as const;
export type CheckKind = (typeof CHECK_KINDS)[number];
export const DEFAULT_CHECK_KIND: CheckKind = "gate";

/** Shared limits. They mirror `plan-checks.ts` and the frozen snapshot bounds. */
export const MAX_PLAN_ROWS = 500;
export const MAX_CHECKS = 12;
export const MAX_ACCEPTANCE_CRITERIA = 20;
export const MAX_FILES = 20;
export const MAX_WORKSPACES = 8;
export const MAX_TEXT = 4_000;
/** The shell guard's hard cap is 3600s; a per-check timeout may not exceed it. */
export const MAX_CHECK_TIMEOUT_MS = 60 * 60_000;
export const MAX_EXPECTED_EXIT_CODE = 255;

const CHECK_SPEC_KEYS: ReadonlySet<string> = new Set([
  "id",
  "command",
  "workspace",
  "kind",
  "timeoutMs",
  "expectedExitCode",
]);
const PLAN_ROW_KEYS: ReadonlySet<string> = new Set([
  "id",
  "ref",
  "text",
  "label",
  "group",
  "checks",
  "acceptanceCriteria",
  "expectedFiles",
  "workspaces",
  "sourceLine",
]);
const PLAN_SPEC_KEYS: ReadonlySet<string> = new Set([
  "version",
  "source",
  "compiler",
  "rows",
  "planChecks",
  "workspaces",
  "diagnostics",
]);
const SOURCE_KEYS: ReadonlySet<string> = new Set([
  "kind",
  "path",
  "digest",
  "bytesSha256",
  "title",
]);
const COMPILER_KEYS: ReadonlySet<string> = new Set(["version", "specHash"]);
const DIAGNOSTIC_KEYS: ReadonlySet<string> = new Set([
  "severity",
  "code",
  "message",
  "line",
  "rowId",
  "checkId",
]);

const SHA256 = /^[a-f0-9]{64}$/;

export interface CheckSpec {
  /** Stable identity inside the compiled spec; never derived from position at read time. */
  id: string;
  /** Exact command bytes. Validated by `validateCommandShape`; no Markdown. */
  command: string;
  /** Workspace alias the command must run in, when it is not the primary root. */
  workspace?: string;
  kind: CheckKind;
  /** Per-check deadline, bounded by the shell-guard hard cap. */
  timeoutMs?: number;
  /** Expected process exit code; absent means 0. */
  expectedExitCode?: number;
}

export interface PlanRow {
  /** Durable row identity, assigned once by the compiler. */
  id: string;
  /** Display ref 1..N, assigned once and never recomputed. */
  ref: string;
  text: string;
  label?: string;
  group?: string;
  /** Executable row checks, in source order. */
  checks: CheckSpec[];
  /** Evidence criteria. Never executed. */
  acceptanceCriteria: string[];
  expectedFiles: string[];
  /** Workspace aliases this row may attribute. */
  workspaces: string[];
  /** 1-based source line, when the row came from a plan. */
  sourceLine?: number;
}

export interface PlanSource {
  kind: "plan" | "steps";
  /** Plan file path; absent for an explicit step list. */
  path?: string;
  /** Semantic digest the compiler/run identity binds to. */
  digest: string;
  /** Hash of the exact source bytes, when the source is a file. */
  bytesSha256?: string;
  title: string;
}

export interface PlanCompilerInfo {
  /** Compiler contract version (e.g. `plan-compiler/1`). */
  version: string;
  /** Content hash of the compiled rows/checks, independent of timestamps. */
  specHash: string;
}

export interface PlanDiagnostic {
  severity: "error" | "warning";
  code: string;
  message: string;
  /** 1-based source line, when the diagnostic is about a line. */
  line?: number;
  rowId?: string;
  checkId?: string;
}

export interface PlanSpec {
  version: typeof PLAN_SPEC_VERSION;
  source: PlanSource;
  compiler: PlanCompilerInfo;
  rows: PlanRow[];
  /** Plan-level checks (today's `## Verification` section). */
  planChecks: CheckSpec[];
  workspaces: FrozenWorkspace[];
  diagnostics: PlanDiagnostic[];
}

export type SpecResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

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

/** Deterministic JSON used for content hashes (sorted keys, no whitespace). */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function isCheckKind(value: unknown): value is CheckKind {
  return (CHECK_KINDS as readonly unknown[]).includes(value);
}

/**
 * Stable check id. Position is part of the id because checks are frozen in
 * source order, but the id never changes once stored; an amendment that adds a
 * check gets an id from the same rule and keeps older ids untouched.
 */
export function planCheckId(index: number): string {
  return `check-${index + 1}`;
}

export function rowCheckId(rowRef: string, index: number): string {
  return `check-row-${rowRef}-${index + 1}`;
}

function workspaceAliases(
  workspaces: readonly (string | { id?: string })[] | undefined,
): Set<string> {
  const aliases = new Set<string>();
  for (const workspace of workspaces ?? []) {
    const id =
      typeof workspace === "string"
        ? workspace
        : typeof workspace?.id === "string"
          ? workspace.id
          : "";
    if (id.trim()) aliases.add(id.trim().toLowerCase());
  }
  return aliases;
}

/**
 * Parse one executable check. Unknown keys, an unknown kind, a non-command or
 * an out-of-bounds timeout/exit code are errors, never silently defaulted.
 */
export function validateCheckSpec(
  value: unknown,
  options: {
    workspaces?: readonly (string | { id?: string })[];
    label?: string;
  } = {},
): SpecResult<CheckSpec> {
  const label = options.label ?? "check";
  if (!isRecord(value)) return fail(`${label} is not an object`);
  const extra = unknownKeys(value, CHECK_SPEC_KEYS);
  if (extra.length > 0) {
    return fail(`${label} has unknown field(s): ${extra.join(", ")}`);
  }
  if (typeof value.id !== "string" || value.id.trim().length === 0) {
    return fail(`${label} has no id`);
  }
  if (value.id.length > 200) return fail(`${label} id is too long`);
  const shape = validateCommandShape(value.command);
  if (!shape.ok) return fail(`${label} is not an executable command: ${shape.error}`);
  const command = value.command as string;
  if (!isCheckKind(value.kind)) {
    return fail(`${label} has an unknown kind ${String(value.kind)}`);
  }
  if (value.workspace !== undefined) {
    if (typeof value.workspace !== "string" || value.workspace.trim().length === 0) {
      return fail(`${label} has an invalid workspace`);
    }
    const aliases = workspaceAliases(options.workspaces);
    if (aliases.size > 0 && !aliases.has(value.workspace.toLowerCase())) {
      return fail(`${label} references unknown workspace "${value.workspace}"`);
    }
  }
  if (value.timeoutMs !== undefined) {
    if (
      typeof value.timeoutMs !== "number" ||
      !Number.isInteger(value.timeoutMs) ||
      value.timeoutMs < 1 ||
      value.timeoutMs > MAX_CHECK_TIMEOUT_MS
    ) {
      return fail(
        `${label} has an invalid timeoutMs (1..${MAX_CHECK_TIMEOUT_MS} integer)`,
      );
    }
  }
  if (value.expectedExitCode !== undefined) {
    if (
      typeof value.expectedExitCode !== "number" ||
      !Number.isInteger(value.expectedExitCode) ||
      value.expectedExitCode < 0 ||
      value.expectedExitCode > MAX_EXPECTED_EXIT_CODE
    ) {
      return fail(
        `${label} has an invalid expectedExitCode (0..${MAX_EXPECTED_EXIT_CODE} integer)`,
      );
    }
  }
  return {
    ok: true,
    value: {
      id: value.id,
      command,
      kind: value.kind,
      ...(value.workspace === undefined ? {} : { workspace: value.workspace }),
      ...(value.timeoutMs === undefined ? {} : { timeoutMs: value.timeoutMs }),
      ...(value.expectedExitCode === undefined
        ? {}
        : { expectedExitCode: value.expectedExitCode }),
    },
  };
}

function boundedStrings(
  value: unknown,
  label: string,
  max: number,
): SpecResult<string[]> {
  if (!Array.isArray(value)) return fail(`${label} is not an array`);
  if (value.length > max) return fail(`more than ${max} ${label} entries`);
  const out: string[] = [];
  for (const [index, entry] of value.entries()) {
    if (typeof entry !== "string") return fail(`${label} entry ${index + 1} is not a string`);
    const text = entry.trim();
    if (!text) return fail(`${label} entry ${index + 1} is empty`);
    if (text.length > MAX_TEXT) return fail(`${label} entry ${index + 1} is too long`);
    out.push(text);
  }
  return { ok: true, value: out };
}

/** Parse one compiled row, including its checks and acceptance evidence. */
export function validatePlanRow(
  value: unknown,
  options: { workspaces?: readonly (string | { id?: string })[] } = {},
): SpecResult<PlanRow> {
  if (!isRecord(value)) return fail("row is not an object");
  const extra = unknownKeys(value, PLAN_ROW_KEYS);
  if (extra.length > 0) return fail(`row has unknown field(s): ${extra.join(", ")}`);
  if (typeof value.id !== "string" || value.id.trim().length === 0) {
    return fail("row has no id");
  }
  if (typeof value.ref !== "string" || !/^[1-9][0-9]*$/.test(value.ref)) {
    return fail(`row ${value.id} has an invalid ref`);
  }
  if (typeof value.text !== "string" || value.text.trim().length === 0) {
    return fail(`row ${value.ref} has no text`);
  }
  if (value.text.length > MAX_TEXT) return fail(`row ${value.ref} text is too long`);
  const label = value.label;
  const group = value.group;
  if (label !== undefined && typeof label !== "string") {
    return fail(`row ${value.ref} has an invalid label`);
  }
  if (group !== undefined && typeof group !== "string") {
    return fail(`row ${value.ref} has an invalid group`);
  }
  if (!Array.isArray(value.checks) || value.checks.length > MAX_CHECKS) {
    return fail(`row ${value.ref} has invalid checks (max ${MAX_CHECKS})`);
  }
  const checks: CheckSpec[] = [];
  const checkIds = new Set<string>();
  for (const [index, check] of value.checks.entries()) {
    const parsed = validateCheckSpec(check, {
      ...options,
      label: `row ${value.ref} check ${index + 1}`,
    });
    if (!parsed.ok) return parsed;
    if (checkIds.has(parsed.value.id)) {
      return fail(`row ${value.ref} has duplicate check id ${parsed.value.id}`);
    }
    checkIds.add(parsed.value.id);
    checks.push(parsed.value);
  }
  const criteria = boundedStrings(
    value.acceptanceCriteria,
    `row ${value.ref} acceptance criteria`,
    MAX_ACCEPTANCE_CRITERIA,
  );
  if (!criteria.ok) return criteria;
  const files = boundedStrings(value.expectedFiles, `row ${value.ref} expected files`, MAX_FILES);
  if (!files.ok) return files;
  const workspaces = boundedStrings(
    value.workspaces,
    `row ${value.ref} workspaces`,
    MAX_WORKSPACES,
  );
  if (!workspaces.ok) return workspaces;
  if (value.sourceLine !== undefined) {
    if (
      typeof value.sourceLine !== "number" ||
      !Number.isInteger(value.sourceLine) ||
      value.sourceLine < 1
    ) {
      return fail(`row ${value.ref} has an invalid sourceLine`);
    }
  }
  return {
    ok: true,
    value: {
      id: value.id,
      ref: value.ref,
      text: value.text,
      ...(label === undefined ? {} : { label }),
      ...(group === undefined ? {} : { group }),
      checks,
      acceptanceCriteria: criteria.value,
      expectedFiles: files.value,
      workspaces: workspaces.value,
      ...(value.sourceLine === undefined ? {} : { sourceLine: value.sourceLine }),
    },
  };
}

export function validatePlanSource(value: unknown): SpecResult<PlanSource> {
  if (!isRecord(value)) return fail("plan source is not an object");
  const extra = unknownKeys(value, SOURCE_KEYS);
  if (extra.length > 0) return fail(`plan source has unknown field(s): ${extra.join(", ")}`);
  if (value.kind !== "plan" && value.kind !== "steps") {
    return fail("plan source has an unknown kind");
  }
  if (typeof value.digest !== "string" || !SHA256.test(value.digest)) {
    return fail("plan source has an invalid digest");
  }
  if (
    value.bytesSha256 !== undefined &&
    (typeof value.bytesSha256 !== "string" || !SHA256.test(value.bytesSha256))
  ) {
    return fail("plan source has an invalid bytesSha256");
  }
  if (typeof value.title !== "string" || value.title.trim().length === 0) {
    return fail("plan source has no title");
  }
  if (value.kind === "plan" && (typeof value.path !== "string" || !value.path.trim())) {
    return fail("plan source kind \"plan\" requires a path");
  }
  if (value.path !== undefined && typeof value.path !== "string") {
    return fail("plan source has an invalid path");
  }
  return {
    ok: true,
    value: {
      kind: value.kind,
      ...(value.path === undefined ? {} : { path: value.path }),
      digest: value.digest,
      ...(value.bytesSha256 === undefined ? {} : { bytesSha256: value.bytesSha256 }),
      title: value.title,
    },
  };
}

function validateCompiler(value: unknown): SpecResult<PlanCompilerInfo> {
  if (!isRecord(value)) return fail("compiler info is not an object");
  const extra = unknownKeys(value, COMPILER_KEYS);
  if (extra.length > 0) return fail(`compiler info has unknown field(s): ${extra.join(", ")}`);
  if (typeof value.version !== "string" || value.version.trim().length === 0) {
    return fail("compiler info has no version");
  }
  if (typeof value.specHash !== "string" || !SHA256.test(value.specHash)) {
    return fail("compiler info has an invalid specHash");
  }
  return { ok: true, value: { version: value.version, specHash: value.specHash } };
}

function validateDiagnostic(value: unknown): SpecResult<PlanDiagnostic> {
  if (!isRecord(value)) return fail("diagnostic is not an object");
  const extra = unknownKeys(value, DIAGNOSTIC_KEYS);
  if (extra.length > 0) return fail(`diagnostic has unknown field(s): ${extra.join(", ")}`);
  if (value.severity !== "error" && value.severity !== "warning") {
    return fail("diagnostic has an unknown severity");
  }
  if (typeof value.code !== "string" || value.code.trim().length === 0) {
    return fail("diagnostic has no code");
  }
  if (typeof value.message !== "string" || value.message.trim().length === 0) {
    return fail("diagnostic has no message");
  }
  const line = value.line;
  const rowId = value.rowId;
  const checkId = value.checkId;
  if (line !== undefined) {
    if (typeof line !== "number" || !Number.isInteger(line) || line < 1) {
      return fail("diagnostic has an invalid line");
    }
  }
  if (rowId !== undefined && typeof rowId !== "string") {
    return fail("diagnostic has an invalid rowId");
  }
  if (checkId !== undefined && typeof checkId !== "string") {
    return fail("diagnostic has an invalid checkId");
  }
  return {
    ok: true,
    value: {
      severity: value.severity,
      code: value.code,
      message: value.message,
      ...(line === undefined ? {} : { line }),
      ...(rowId === undefined ? {} : { rowId }),
      ...(checkId === undefined ? {} : { checkId }),
    },
  };
}

function validateWorkspaceEntries(value: unknown): SpecResult<FrozenWorkspace[]> {
  if (!Array.isArray(value)) return fail("plan workspaces is not an array");
  if (value.length > MAX_WORKSPACES) {
    return fail(`more than ${MAX_WORKSPACES} plan workspaces`);
  }
  const ids = new Set<string>();
  const out: FrozenWorkspace[] = [];
  for (const [index, entry] of value.entries()) {
    if (!isRecord(entry)) return fail(`plan workspace ${index + 1} is not an object`);
    if (typeof entry.id !== "string" || !/^[A-Za-z][A-Za-z0-9_-]{0,23}$/.test(entry.id)) {
      return fail(`plan workspace ${index + 1} has an invalid id`);
    }
    if (typeof entry.root !== "string" || entry.root.trim().length === 0) {
      return fail(`plan workspace ${index + 1} has no root`);
    }
    if (entry.primary !== undefined && typeof entry.primary !== "boolean") {
      return fail(`plan workspace ${index + 1} has an invalid primary flag`);
    }
    if (ids.has(entry.id.toLowerCase())) {
      return fail(`duplicate plan workspace alias "${entry.id}"`);
    }
    ids.add(entry.id.toLowerCase());
    out.push({
      ...(entry as unknown as FrozenWorkspace),
    });
  }
  if (out.length > 0 && out.filter((workspace) => workspace.primary === true).length > 1) {
    return fail("more than one plan workspace is primary");
  }
  return { ok: true, value: out };
}

/**
 * Parse a complete `PlanSpec`. Structural validation only: whether a check is
 * executable was already decided by `validateCheckSpec`, and whether a plan is
 * *acceptable* is the compiler/lint's job (`diagnostics`).
 */
export function validatePlanSpec(
  value: unknown,
  options: { workspaces?: readonly (string | { id?: string })[] } = {},
): SpecResult<PlanSpec> {
  if (!isRecord(value)) return fail("the plan spec is not an object");
  const extra = unknownKeys(value, PLAN_SPEC_KEYS);
  if (extra.length > 0) return fail(`plan spec has unknown field(s): ${extra.join(", ")}`);
  if (value.version !== PLAN_SPEC_VERSION) {
    return fail(`unsupported plan spec version ${String(value.version)}`);
  }
  const source = validatePlanSource(value.source);
  if (!source.ok) return source;
  const compiler = validateCompiler(value.compiler);
  if (!compiler.ok) return compiler;
  const workspaces = validateWorkspaceEntries(value.workspaces);
  if (!workspaces.ok) return workspaces;
  const aliases = workspaces.value.length > 0 ? workspaces.value : options.workspaces;
  if (!Array.isArray(value.rows)) return fail("plan spec rows is not an array");
  if (value.rows.length > MAX_PLAN_ROWS) {
    return fail(`more than ${MAX_PLAN_ROWS} plan rows`);
  }
  const rows: PlanRow[] = [];
  const ids = new Set<string>();
  const refs = new Set<string>();
  for (const [index, row] of value.rows.entries()) {
    const parsed = validatePlanRow(row, aliases === undefined ? {} : { workspaces: aliases });
    if (!parsed.ok) return parsed;
    const expectedRef = String(index + 1);
    if (parsed.value.ref !== expectedRef) {
      return fail(`row ${index + 1} has ref "${parsed.value.ref}" (expected "${expectedRef}")`);
    }
    if (ids.has(parsed.value.id)) return fail(`duplicate row id ${parsed.value.id}`);
    if (refs.has(parsed.value.ref)) return fail(`duplicate row ref ${parsed.value.ref}`);
    ids.add(parsed.value.id);
    refs.add(parsed.value.ref);
    rows.push(parsed.value);
  }
  if (!Array.isArray(value.planChecks) || value.planChecks.length > MAX_CHECKS) {
    return fail(`plan checks is invalid (max ${MAX_CHECKS})`);
  }
  const planChecks: CheckSpec[] = [];
  const planCheckIds = new Set<string>();
  for (const [index, check] of value.planChecks.entries()) {
    const parsed = validateCheckSpec(check, {
      ...(aliases === undefined ? {} : { workspaces: aliases }),
      label: `plan check ${index + 1}`,
    });
    if (!parsed.ok) return parsed;
    if (planCheckIds.has(parsed.value.id)) {
      return fail(`duplicate plan check id ${parsed.value.id}`);
    }
    planCheckIds.add(parsed.value.id);
    planChecks.push(parsed.value);
  }
  if (!Array.isArray(value.diagnostics)) return fail("plan diagnostics is not an array");
  if (value.diagnostics.length > MAX_PLAN_ROWS * 4) {
    return fail("plan diagnostics is too long");
  }
  const diagnostics: PlanDiagnostic[] = [];
  for (const diagnostic of value.diagnostics) {
    const parsed = validateDiagnostic(diagnostic);
    if (!parsed.ok) return parsed;
    diagnostics.push(parsed.value);
  }
  return {
    ok: true,
    value: {
      version: PLAN_SPEC_VERSION,
      source: source.value,
      compiler: compiler.value,
      rows,
      planChecks,
      workspaces: workspaces.value,
      diagnostics,
    },
  };
}

/**
 * Content hash over the executable contract. Timestamps, compiler version and
 * diagnostics are excluded so recompiling the same source yields the same hash.
 */
export function planSpecHash(spec: Pick<PlanSpec, "rows" | "planChecks">): string {
  return sha256Hex(
    stableStringify({
      rows: spec.rows.map((row) => ({
        id: row.id,
        ref: row.ref,
        text: row.text,
        checks: row.checks,
        acceptanceCriteria: row.acceptanceCriteria,
        expectedFiles: row.expectedFiles,
        workspaces: row.workspaces,
      })),
      planChecks: spec.planChecks,
    }),
  );
}

/** `planChecks`/`planCheckSpecs` legacy views derived from one typed list. */
export interface CheckSpecListView {
  planChecks: string[];
  planCheckSpecs: PlanCheckSpec[];
}

/**
 * Derive the legacy command views. Every typed check is included: the current
 * executor is kind-unaware, so filtering here would silently drop a command it
 * runs today. The typed executor (failure taxonomy) is the place that decides
 * which kinds gate acceptance.
 */
export function legacyCheckViews(specs: readonly CheckSpec[]): CheckSpecListView {
  return {
    planChecks: specs.map((spec) => spec.command),
    planCheckSpecs: specs.map((spec) => ({
      command: spec.command,
      ...(spec.workspace === undefined ? {} : { workspace: spec.workspace }),
    })),
  };
}

/** The legacy `acceptanceChecks` view of one row: commands then criteria. */
export function legacyAcceptanceChecks(row: Pick<PlanRow, "checks" | "acceptanceCriteria">): string[] {
  return [...row.checks.map((check) => check.command), ...row.acceptanceCriteria];
}

/** Executable gate commands only; diagnostics/manual are reported, not gated. */
export function gateCommands(specs: readonly CheckSpec[]): string[] {
  return specs.filter((spec) => spec.kind === "gate").map((spec) => spec.command);
}
