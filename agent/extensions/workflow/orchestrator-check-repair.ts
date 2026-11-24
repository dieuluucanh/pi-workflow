/**
 * Workflow Extension — durable plan-check amendments (Phase A).
 *
 * The live 2026-11-21 run froze five malformed `planChecks` at `todos.frozen`.
 * Rewriting that journal is forbidden, so the only legal fix is an append-only
 * `run.control` amendment that replaces the executable check list while leaving
 * rows, ids, statuses and workspaces byte-identical.
 *
 * Everything here is pure: no clock, no filesystem, no journal. The runtime
 * journals one event built by `buildCheckSpecRepair` and `restore()` re-applies
 * it with `applyCheckSpecRepair`, so a reload reproduces exactly the same
 * check list without touching `RunState.revision`.
 *
 * Two invariants are load-bearing:
 *   - `previous` is history and may itself be malformed (the incident case), so
 *     it is only shape-checked, never executed or validated as a command;
 *   - `next` is executable and is fully validated (command shape, workspace
 *     alias, list bounds) before it can be stored.
 */

import { createHash } from "node:crypto";

import {
  validateCommandShape,
  validatePlanCheckSpecs,
  type PlanCheckSpec,
} from "./plan-checks.ts";
import { executablePlanCheckSpecs } from "./final-gate.ts";
import type { FrozenTodoSnapshot } from "./todo-snapshot.ts";

export const CHECK_SPEC_REPAIR_ACTION = "plan-check-specs-repair" as const;
export const CHECK_SPEC_REPAIR_VERSION = 1 as const;
export const MAX_REPAIR_REASON = 500;
export const MAX_REPAIR_SOURCE = 500;
export const MAX_REPAIR_SPECS = 12;

/** Check kinds the v2 contract understands; Phase A only ever writes `gate`. */
export const CHECK_SPEC_KINDS = ["gate", "diagnostic", "manual"] as const;
export type CheckSpecKind = (typeof CHECK_SPEC_KINDS)[number];

/** The Phase-A spec shape: a validated command plus an explicit kind. */
export interface CheckSpec extends PlanCheckSpec {
  kind: CheckSpecKind;
}

export interface CheckSpecListView {
  planChecks: string[];
  planCheckSpecs: CheckSpec[];
}

export interface CheckSpecRepairPayload {
  action: typeof CHECK_SPEC_REPAIR_ACTION;
  version: typeof CHECK_SPEC_REPAIR_VERSION;
  executionId: string;
  previous: CheckSpecListView;
  next: CheckSpecListView;
  reason: string;
  source: string;
  approvedAt: number;
  manifestSha256?: string;
}

export type CheckSpecRepairCode =
  | "malformed"
  | "wrong_execution"
  | "stale_previous"
  | "invalid_next";

export type CheckSpecRepairResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: CheckSpecRepairCode; error: string };

function fail<T>(code: CheckSpecRepairCode, error: string): CheckSpecRepairResult<T> {
  return { ok: false, code, error };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
    .join(",")}}`;
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function boundedText(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.replace(/\s+/g, " ").trim();
  if (!text) return undefined;
  return text.slice(0, max);
}

function kindOf(value: unknown): CheckSpecKind | undefined {
  if (value === undefined) return undefined;
  return (CHECK_SPEC_KINDS as readonly unknown[]).includes(value)
    ? (value as CheckSpecKind)
    : undefined;
}

function workspaceId(
  raw: string,
  workspaces: readonly { id?: string }[] | undefined,
): string {
  const alias = (workspaces ?? []).find(
    (workspace) =>
      typeof workspace?.id === "string" &&
      workspace.id.toLowerCase() === raw.toLowerCase(),
  );
  return alias?.id ?? raw;
}

/**
 * Normalize an amendment's `next` list: validate every command, resolve
 * workspace aliases to their canonical id, dedupe exact command+workspace
 * pairs, default `kind` to `gate` and deliberately drop per-check timeouts
 * (Phase A has none, so the later v2 upcast is mechanical).
 */
export function normalizeCheckSpecs(
  specs: unknown,
  workspaces?: readonly { id?: string }[],
  options: { allowEmpty?: boolean } = {},
): CheckSpecRepairResult<CheckSpec[]> {
  const validated = validatePlanCheckSpecs(specs, workspaces);
  if (!validated.ok) return fail("invalid_next", validated.error);
  const list = Array.isArray(specs) ? specs : [];
  if (list.length === 0 && options.allowEmpty !== true) {
    return fail(
      "invalid_next",
      "the amended check list is empty; pass allowEmpty to remove every final check",
    );
  }
  if (list.length > MAX_REPAIR_SPECS) {
    return fail("invalid_next", `more than ${MAX_REPAIR_SPECS} amended plan checks`);
  }
  const out: CheckSpec[] = [];
  for (const [index, value] of list.entries()) {
    if (!isRecord(value)) {
      return fail("malformed", `amended check ${index + 1} is not an object`);
    }
    const shape = validateCommandShape(value.command);
    if (!shape.ok) {
      return fail("invalid_next", `amended check ${index + 1}: ${shape.error}`);
    }
    const rawKind = value.kind;
    const kind = kindOf(rawKind);
    if (rawKind !== undefined && kind === undefined) {
      return fail(
        "invalid_next",
        `amended check ${index + 1} has an unknown kind ${String(rawKind)}`,
      );
    }
    const workspace =
      typeof value.workspace === "string"
        ? workspaceId(value.workspace, workspaces)
        : undefined;
    if (
      out.some(
        (spec) => spec.command === value.command && spec.workspace === workspace,
      )
    ) {
      continue;
    }
    out.push({
      command: value.command as string,
      ...(workspace === undefined ? {} : { workspace }),
      kind: kind ?? "gate",
    });
  }
  return { ok: true, value: out };
}

/** The current executable view of a frozen snapshot (specs derived for v1). */
export function checkSpecsOf(snapshot: FrozenTodoSnapshot): CheckSpecListView {
  return {
    planChecks: [...snapshot.planChecks],
    planCheckSpecs: executablePlanCheckSpecs(snapshot).map((spec) => ({
      command: spec.command,
      ...(spec.workspace === undefined ? {} : { workspace: spec.workspace }),
      kind: "gate",
    })),
  };
}

/** Order-insensitive key for exact list comparison (kind defaults to gate). */
function viewKey(view: CheckSpecListView): string {
  return canonical({
    planChecks: view.planChecks,
    planCheckSpecs: view.planCheckSpecs.map((spec) => ({
      command: spec.command,
      workspace: spec.workspace ?? null,
      kind: spec.kind ?? "gate",
    })),
  });
}

function sameView(a: CheckSpecListView, b: CheckSpecListView): boolean {
  return viewKey(a) === viewKey(b);
}

function requireListView(
  value: unknown,
  label: string,
  validateCommands: boolean,
  workspaces?: readonly { id?: string }[],
): CheckSpecRepairResult<CheckSpecListView> {
  if (!isRecord(value)) {
    return fail("malformed", `the amendment's ${label} list is missing`);
  }
  const planChecks = value.planChecks;
  if (!Array.isArray(planChecks) || planChecks.some((entry) => typeof entry !== "string")) {
    return fail("malformed", `the amendment's ${label}.planChecks is invalid`);
  }
  const rawSpecs = value.planCheckSpecs;
  if (rawSpecs !== undefined && !Array.isArray(rawSpecs)) {
    return fail("malformed", `the amendment's ${label}.planCheckSpecs is invalid`);
  }
  const specsValue: unknown = rawSpecs ?? (planChecks as string[]).map((command) => ({ command }));
  const specs: CheckSpec[] = [];
  for (const [index, entry] of (Array.isArray(specsValue) ? specsValue : []).entries()) {
    if (!isRecord(entry) || typeof entry.command !== "string") {
      return fail("malformed", `the amendment's ${label} check ${index + 1} is invalid`);
    }
    if (entry.workspace !== undefined && typeof entry.workspace !== "string") {
      return fail(
        "malformed",
        `the amendment's ${label} check ${index + 1} has an invalid workspace`,
      );
    }
    const rawKind = entry.kind;
    const kind = kindOf(rawKind);
    if (rawKind !== undefined && kind === undefined) {
      return fail(
        "malformed",
        `the amendment's ${label} check ${index + 1} has an unknown kind`,
      );
    }
    specs.push({
      command: entry.command,
      ...(typeof entry.workspace === "string" ? { workspace: entry.workspace } : {}),
      kind: kind ?? "gate",
    });
  }
  if (validateCommands) {
    const normalized = normalizeCheckSpecs(
      specs.map((spec) => ({
        command: spec.command,
        ...(spec.workspace === undefined ? {} : { workspace: spec.workspace }),
        kind: spec.kind,
      })),
      workspaces,
      { allowEmpty: true },
    );
    if (!normalized.ok) return normalized;
    return { ok: true, value: { planChecks: normalized.value.map((s) => s.command), planCheckSpecs: normalized.value } };
  }
  return { ok: true, value: { planChecks: [...(planChecks as string[])], planCheckSpecs: specs } };
}

/**
 * Validate a journaled amendment as data. Unknown actions/versions fail
 * closed, and a malformed `next` list can never be applied on restore.
 */
export function validateCheckSpecRepairPayload(
  value: unknown,
  workspaces?: readonly { id?: string }[],
): CheckSpecRepairResult<CheckSpecRepairPayload> {
  if (!isRecord(value)) return fail("malformed", "the amendment is not an object");
  if (value.action !== CHECK_SPEC_REPAIR_ACTION) {
    return fail("malformed", `unknown amendment action ${String(value.action)}`);
  }
  if (value.version !== CHECK_SPEC_REPAIR_VERSION) {
    return fail("malformed", `unknown amendment version ${String(value.version)}`);
  }
  if (typeof value.executionId !== "string" || value.executionId.trim().length === 0) {
    return fail("malformed", "the amendment has no execution id");
  }
  const reason = boundedText(value.reason, MAX_REPAIR_REASON);
  if (!reason) return fail("malformed", "the amendment has no reason");
  const source = boundedText(value.source, MAX_REPAIR_SOURCE);
  if (!source) return fail("malformed", "the amendment has no source");
  if (typeof value.approvedAt !== "number" || !Number.isFinite(value.approvedAt)) {
    return fail("malformed", "the amendment has no approvedAt timestamp");
  }
  if (
    value.manifestSha256 !== undefined &&
    (typeof value.manifestSha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(value.manifestSha256))
  ) {
    return fail("malformed", "the amendment has an invalid manifest checksum");
  }
  const previous = requireListView(value.previous, "previous", false);
  if (!previous.ok) return previous;
  const next = requireListView(value.next, "next", true, workspaces);
  if (!next.ok) return next;
  return {
    ok: true,
    value: {
      action: CHECK_SPEC_REPAIR_ACTION,
      version: CHECK_SPEC_REPAIR_VERSION,
      executionId: value.executionId,
      previous: previous.value,
      next: next.value,
      reason,
      source,
      approvedAt: value.approvedAt,
      ...(value.manifestSha256 === undefined
        ? {}
        : { manifestSha256: value.manifestSha256 }),
    },
  };
}

export interface BuildCheckSpecRepairInput {
  executionId: string;
  /** The frozen snapshot the amendment applies to (for previous + aliases). */
  snapshot: FrozenTodoSnapshot;
  specs: readonly PlanCheckSpec[];
  reason: string;
  source: string;
  approvedAt: number;
  allowEmpty?: boolean;
  manifestSha256?: string;
  /** The exact previous view the caller observed; absent means "current". */
  previous?: CheckSpecListView;
}

/**
 * Build one durable amendment payload without touching the journal. `previous`
 * must match the snapshot exactly (stale callers fail closed) and `next` is
 * normalized/validated so the payload is safe to store and replay.
 */
export function buildCheckSpecRepair(
  input: BuildCheckSpecRepairInput,
): CheckSpecRepairResult<CheckSpecRepairPayload> {
  if (
    typeof input.executionId !== "string" ||
    input.executionId.trim().length === 0
  ) {
    return fail("malformed", "an execution id is required");
  }
  if (input.executionId !== input.snapshot.executionId) {
    return fail(
      "wrong_execution",
      `the amendment names execution ${input.executionId}; this snapshot is ${input.snapshot.executionId}`,
    );
  }
  const reason = boundedText(input.reason, MAX_REPAIR_REASON);
  if (!reason) return fail("malformed", "a repair reason is required");
  const source = boundedText(input.source, MAX_REPAIR_SOURCE);
  if (!source) return fail("malformed", "a repair source is required");
  if (typeof input.approvedAt !== "number" || !Number.isFinite(input.approvedAt)) {
    return fail("malformed", "an approvedAt timestamp is required");
  }
  if (
    input.manifestSha256 !== undefined &&
    !/^[a-f0-9]{64}$/.test(input.manifestSha256)
  ) {
    return fail("malformed", "the manifest checksum must be a sha256");
  }
  const current = checkSpecsOf(input.snapshot);
  const previous = input.previous ?? current;
  if (!sameView(previous, current)) {
    return fail(
      "stale_previous",
      `the previous checks are stale; current commands are ${JSON.stringify(current.planChecks)}`,
    );
  }
  const normalized = normalizeCheckSpecs(input.specs, input.snapshot.workspaces, {
    allowEmpty: input.allowEmpty === true,
  });
  if (!normalized.ok) return normalized;
  const next: CheckSpecListView = {
    planChecks: normalized.value.map((spec) => spec.command),
    planCheckSpecs: normalized.value,
  };
  return {
    ok: true,
    value: {
      action: CHECK_SPEC_REPAIR_ACTION,
      version: CHECK_SPEC_REPAIR_VERSION,
      executionId: input.executionId,
      previous: {
        planChecks: [...previous.planChecks],
        planCheckSpecs: previous.planCheckSpecs.map((spec) => ({ ...spec })),
      },
      next,
      reason,
      source,
      approvedAt: input.approvedAt,
      ...(input.manifestSha256 === undefined
        ? {}
        : { manifestSha256: input.manifestSha256 }),
    },
  };
}

/**
 * Deterministic journal id for an amendment: the canonical payload hash. A
 * byte-identical payload can never be appended twice.
 */
export function checkSpecRepairEventId(payload: CheckSpecRepairPayload): string {
  return `repair-${sha256(canonical(payload)).slice(0, 32)}`;
}

export interface ApplyCheckSpecRepairResult {
  snapshot: FrozenTodoSnapshot;
  /** False when the snapshot already carries the amended list (repeat apply). */
  changed: boolean;
}

/**
 * Apply one amendment to a frozen snapshot, preserving rows/ids/statuses/
 * workspaces byte-identically. A repeat of an already-applied amendment is a
 * no-op (checked before `previous`), so replaying a journal is idempotent.
 */
export function applyCheckSpecRepair(
  snapshot: FrozenTodoSnapshot,
  payload: unknown,
): CheckSpecRepairResult<ApplyCheckSpecRepairResult> {
  const validated = validateCheckSpecRepairPayload(payload, snapshot.workspaces);
  if (!validated.ok) return validated;
  const amendment = validated.value;
  if (amendment.executionId !== snapshot.executionId) {
    return fail(
      "wrong_execution",
      `the amendment names execution ${amendment.executionId}; this snapshot is ${snapshot.executionId}`,
    );
  }
  const current = checkSpecsOf(snapshot);
  if (sameView(current, amendment.next)) {
    return { ok: true, value: { snapshot, changed: false } };
  }
  if (!sameView(current, amendment.previous)) {
    return fail(
      "stale_previous",
      `the amendment's previous checks do not match the frozen snapshot; current commands are ${JSON.stringify(current.planChecks)}`,
    );
  }
  const nextSnapshot: FrozenTodoSnapshot = {
    ...snapshot,
    rows: snapshot.rows,
    planChecks: [...amendment.next.planChecks],
    planCheckSpecs: amendment.next.planCheckSpecs.map((spec) => ({
      command: spec.command,
      ...(spec.workspace === undefined ? {} : { workspace: spec.workspace }),
      kind: spec.kind,
    })),
    ...(snapshot.workspaces === undefined
      ? {}
      : { workspaces: snapshot.workspaces }),
  };
  return { ok: true, value: { snapshot: nextSnapshot, changed: true } };
}
