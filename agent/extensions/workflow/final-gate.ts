/**
 * Workflow Extension — the journaled final-gate marker.
 *
 * The final plan gate used to have two call paths and no memory: the advance
 * engine ran it before the last acceptance, and the Build-completion branch of
 * `agent_end` could run the same frozen checks again (an in-process child is
 * forced to `build` mode). Nothing recorded that the gate had already passed,
 * so a slow gate could run twice and a changed check list was indistinguishable
 * from one that had passed.
 *
 * This module owns the durable marker:
 *
 *   - `computeFinalGateSpecHash` content-addresses exactly what will run
 *     (commands, kinds, timeouts, workspace aliases and roots). A changed spec
 *     is a different hash, so an old pass can never authorize a new gate.
 *   - `buildFinalGatePayload` records the spec hash, the bounded per-check
 *     results, the workspace revisions and the timestamp.
 *   - `findFinalGateRecord`/`finalGateSatisfied` read the journal. Completion
 *     requires a passing record whose hash matches the current snapshot.
 *
 * The module is pure: no clock, no filesystem, no execution. The runtime owns
 * appending and the store owns framing/checksums (the payload is a new known
 * event type with the same `run.control`-style validation).
 */

import { createHash } from "node:crypto";

import {
  CHECK_FAILURE_CLASSES,
  type CheckExecutionResult,
  type CheckFailureClass,
} from "./check-executor.ts";
import type { PlanCheckSpec } from "./plan-checks.ts";
import {
  CHECK_KINDS,
  planCheckId,
  sha256Hex,
  stableStringify,
  type CheckKind,
} from "./plan-spec.ts";
import type { FrozenWorkspace, WorkspaceSet } from "./orchestrator-workspace-set.ts";
import type { FrozenTodoSnapshot } from "./todo-snapshot.ts";

/** Journal event type for the final-gate marker. */
export const FINAL_GATE_EVENT_TYPE = "final_gate" as const;
/** Payload version; an unknown version fails closed on load. */
export const FINAL_GATE_PAYLOAD_VERSION = 1 as const;

/** Bounds: a marker records evidence, not a transcript. */
export const MAX_FINAL_GATE_RESULTS = 64;
export const MAX_FINAL_GATE_COMMAND = 500;
export const MAX_FINAL_GATE_MESSAGE = 1_000;
export const MAX_FINAL_GATE_WORKSPACES = 32;

const SHA256 = /^[a-f0-9]{64}$/;
const FAILURE_CLASS_SET: ReadonlySet<string> = new Set(CHECK_FAILURE_CLASSES);
const KIND_SET: ReadonlySet<string> = new Set(CHECK_KINDS);

export interface FinalGateCheckView {
  id: string;
  command: string;
  workspace?: string;
  kind: CheckKind;
  timeoutMs?: number;
  expectedExitCode?: number;
}

export interface FinalGateCheckResult {
  checkId: string;
  command: string;
  workspace?: string;
  kind: CheckKind;
  ok: boolean;
  failureClass: CheckFailureClass;
  exitCode: number | null;
  durationMs: number;
  workspaceId?: string;
}

export interface FinalGatePayload {
  version: typeof FINAL_GATE_PAYLOAD_VERSION;
  /** Content hash of the executable gate spec this record judged. */
  specHash: string;
  ok: boolean;
  checkedAt: number;
  results: FinalGateCheckResult[];
  /** workspaceId → the workspace revision the gate ran against. */
  workspaceRevisions: Record<string, string>;
  failureClass?: CheckFailureClass;
  failure?: string;
}

export type FinalGateParse =
  | { ok: true; value: FinalGatePayload }
  | { ok: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function boundedString(value: unknown, max: number): string | undefined {
  return typeof value === "string" && value.length <= max ? value : undefined;
}

/**
 * The plan-level checks the gate will execute, in the order the executor sees
 * them. `planCheckSpecs` carries the workspace alias; legacy snapshots only
 * have the command list. Position is the frozen identity (`check-N`), exactly
 * like the compiler/executor, so the same snapshot always hashes equal.
 */
/**
 * The single derivation of a frozen snapshot's executable check view.
 *
 * Every surface that needs the executable commands (the final gate, the repair
 * command's status preview, `runFinalPlanChecks`, the repair module) calls this
 * instead of re-implementing `planCheckSpecs ?? planChecks.map(...)`. A v2
 * snapshot keeps `planCheckSpecs` and `planChecks` in lockstep; a legacy or
 * tampered snapshot whose arrays diverge falls back to the command list rather
 * than silently executing zero checks (an empty `planCheckSpecs` must not look
 * like a green gate).
 */
export function executablePlanCheckSpecs(
  source:
    | Pick<FrozenTodoSnapshot, "planChecks" | "planCheckSpecs">
    | {
        planChecks?: readonly string[];
        planCheckSpecs?: readonly PlanCheckSpec[];
      }
    | undefined,
): Array<{ command: string; workspace?: string }> {
  if (!source) return [];
  const commands = source.planChecks ?? [];
  const specs = source.planCheckSpecs;
  if (Array.isArray(specs) && specs.length === commands.length && specs.length > 0) {
    return specs.map((spec) => ({
      command: spec.command,
      ...(spec.workspace === undefined ? {} : { workspace: spec.workspace }),
    }));
  }
  return commands.map((command) => ({ command }));
}

export function finalGateCheckSpecs(
  source:
    | Pick<FrozenTodoSnapshot, "planChecks" | "planCheckSpecs">
    | {
        planChecks?: readonly string[];
        planCheckSpecs?: readonly PlanCheckSpec[];
      }
    | undefined,
): FinalGateCheckView[] {
  return executablePlanCheckSpecs(source).map((spec, index) => ({
    id: planCheckId(index),
    command: spec.command,
    ...(spec.workspace === undefined ? {} : { workspace: spec.workspace }),
    kind: "gate",
  }));
}

function normalizedWorkspaces(
  workspaces: readonly Pick<FrozenWorkspace, "id" | "root" | "primary">[] | undefined,
): Array<{ id: string; root: string; primary: boolean }> {
  return (workspaces ?? [])
    .map((workspace) => ({
      id: workspace.id,
      root: workspace.root,
      primary: workspace.primary === true,
    }))
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
}

/**
 * Deterministic hash of what will execute. Timestamps, results and workspace
 * *revisions* are excluded (they are evidence); the roots and alias bindings
 * are included because a check without an alias resolves against the primary
 * root, so a different binding is a different gate.
 */
export function computeFinalGateSpecHash(input: {
  checks: readonly FinalGateCheckView[];
  workspaces?: readonly Pick<FrozenWorkspace, "id" | "root" | "primary">[];
  set?: Pick<WorkspaceSet, "roots">;
}): string {
  const workspaces = input.workspaces ?? input.set?.roots;
  const spec = {
    checks: input.checks.map((check) => ({
      id: check.id,
      command: check.command,
      workspace: check.workspace ?? null,
      kind: check.kind,
      timeoutMs: check.timeoutMs ?? null,
      expectedExitCode: check.expectedExitCode ?? null,
    })),
    workspaces: normalizedWorkspaces(workspaces),
  };
  return sha256Hex(stableStringify(spec));
}

/** Bounded result projection for the journal. Output text is never stored. */
export function summarizeFinalGateResults(
  results: readonly CheckExecutionResult[] | undefined,
): FinalGateCheckResult[] {
  return (results ?? []).slice(0, MAX_FINAL_GATE_RESULTS).map((result) => ({
    checkId: result.checkId,
    command: result.command.slice(0, MAX_FINAL_GATE_COMMAND),
    kind: result.kind,
    ok: result.ok,
    failureClass: result.failureClass,
    exitCode: typeof result.exitCode === "number" ? result.exitCode : null,
    durationMs: Math.max(0, Math.round(result.durationMs)),
    ...(result.workspaceId === undefined ? {} : { workspaceId: result.workspaceId }),
  }));
}

export function buildFinalGatePayload(input: {
  specHash: string;
  ok: boolean;
  checkedAt: number;
  results?: readonly CheckExecutionResult[];
  workspaceRevisions?: Record<string, string>;
  failureClass?: CheckFailureClass;
  failure?: string;
}): FinalGatePayload {
  return {
    version: FINAL_GATE_PAYLOAD_VERSION,
    specHash: input.specHash,
    ok: input.ok,
    checkedAt: input.checkedAt,
    results: summarizeFinalGateResults(input.results),
    workspaceRevisions: { ...(input.workspaceRevisions ?? {}) },
    ...(input.failureClass === undefined ? {} : { failureClass: input.failureClass }),
    ...(input.failure === undefined
      ? {}
      : { failure: input.failure.slice(0, MAX_FINAL_GATE_MESSAGE) }),
  };
}

/** Deterministic id: an identical record is idempotent; a new attempt is not. */
export function finalGateEventId(payload: FinalGatePayload): string {
  return `final-gate-${createHash("sha256")
    .update(stableStringify(payload), "utf8")
    .digest("hex")
    .slice(0, 24)}`;
}

function parseResult(value: unknown, index: number): string | undefined {
  if (!isRecord(value)) return `final_gate result ${index + 1} is not an object`;
  const label = `final_gate result ${index + 1}`;
  if (typeof value.checkId !== "string" || value.checkId.trim().length === 0) {
    return `${label} has no checkId`;
  }
  if (typeof value.command !== "string" || value.command.length > 4_000) {
    return `${label} has an invalid command`;
  }
  if (!KIND_SET.has(String(value.kind))) return `${label} has an unknown kind`;
  if (typeof value.ok !== "boolean") return `${label} has an invalid ok flag`;
  if (!FAILURE_CLASS_SET.has(String(value.failureClass))) {
    return `${label} has an unknown failure class`;
  }
  if (
    value.exitCode !== null &&
    (typeof value.exitCode !== "number" || !Number.isInteger(value.exitCode))
  ) {
    return `${label} has an invalid exitCode`;
  }
  if (
    typeof value.durationMs !== "number" ||
    !Number.isFinite(value.durationMs) ||
    value.durationMs < 0
  ) {
    return `${label} has an invalid durationMs`;
  }
  for (const key of ["workspace", "workspaceId"] as const) {
    if (value[key] !== undefined && typeof value[key] !== "string") {
      return `${label} has an invalid ${key}`;
    }
  }
  return undefined;
}

function parseWorkspaceRevisions(value: unknown): string | undefined {
  if (!isRecord(value)) return "final_gate has invalid workspaceRevisions";
  const entries = Object.entries(value);
  if (entries.length > MAX_FINAL_GATE_WORKSPACES) {
    return `final_gate has more than ${MAX_FINAL_GATE_WORKSPACES} workspace revisions`;
  }
  for (const [key, revision] of entries) {
    if (!key.trim()) return "final_gate has an empty workspace id";
    if (typeof revision !== "string") return `final_gate revision for ${key} is not a string`;
  }
  return undefined;
}

/**
 * Validate the stored payload. Field-scoped like every journal contract: the
 * envelope may grow, but a wrong spec hash, an unknown failure class or an
 * unknown version is refused so a marker can never be half-read.
 */
export function parseFinalGatePayload(payload: unknown): FinalGateParse {
  if (!isRecord(payload)) return { ok: false, error: "final_gate payload is not an object" };
  if (payload.version !== FINAL_GATE_PAYLOAD_VERSION) {
    return {
      ok: false,
      error: `final_gate has an unknown payload version ${String(payload.version)}`,
    };
  }
  if (typeof payload.specHash !== "string" || !SHA256.test(payload.specHash)) {
    return { ok: false, error: "final_gate has an invalid specHash" };
  }
  if (typeof payload.ok !== "boolean") return { ok: false, error: "final_gate has no ok flag" };
  if (typeof payload.checkedAt !== "number" || !Number.isFinite(payload.checkedAt)) {
    return { ok: false, error: "final_gate has an invalid checkedAt" };
  }
  if (!Array.isArray(payload.results)) {
    return { ok: false, error: "final_gate results is not an array" };
  }
  if (payload.results.length > MAX_FINAL_GATE_RESULTS) {
    return {
      ok: false,
      error: `final_gate has more than ${MAX_FINAL_GATE_RESULTS} results`,
    };
  }
  for (const [index, result] of payload.results.entries()) {
    const error = parseResult(result, index);
    if (error) return { ok: false, error };
  }
  const revisions = parseWorkspaceRevisions(payload.workspaceRevisions);
  if (revisions) return { ok: false, error: revisions };
  if (
    payload.failureClass !== undefined &&
    !FAILURE_CLASS_SET.has(String(payload.failureClass))
  ) {
    return { ok: false, error: "final_gate has an unknown failureClass" };
  }
  if (
    payload.failure !== undefined &&
    boundedString(payload.failure, MAX_FINAL_GATE_MESSAGE) === undefined
  ) {
    return { ok: false, error: "final_gate has an invalid failure message" };
  }
  return {
    ok: true,
    value: {
      version: FINAL_GATE_PAYLOAD_VERSION,
      specHash: payload.specHash,
      ok: payload.ok,
      checkedAt: payload.checkedAt,
      results: payload.results as FinalGateCheckResult[],
      workspaceRevisions: payload.workspaceRevisions as Record<string, string>,
      ...(payload.failureClass === undefined
        ? {}
        : { failureClass: payload.failureClass as CheckFailureClass }),
      ...(payload.failure === undefined ? {} : { failure: payload.failure as string }),
    },
  };
}

/** Registry adapter: an error string, or undefined when readable. */
export function validateFinalGatePayload(payload: Record<string, unknown>): string | undefined {
  const parsed = parseFinalGatePayload(payload);
  return parsed.ok ? undefined : parsed.error;
}

/** The newest readable marker, in journal order. */
export function latestFinalGateRecord(
  events: readonly { type: unknown; payload: unknown }[],
): FinalGatePayload | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.type !== FINAL_GATE_EVENT_TYPE) continue;
    const parsed = parseFinalGatePayload(event.payload);
    if (parsed.ok) return parsed.value;
  }
  return undefined;
}

/** The newest readable marker judged against exactly this spec hash. */
export function findFinalGateRecord(
  events: readonly { type: unknown; payload: unknown }[],
  specHash: string,
): FinalGatePayload | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.type !== FINAL_GATE_EVENT_TYPE) continue;
    const parsed = parseFinalGatePayload(event.payload);
    if (parsed.ok && parsed.value.specHash === specHash) return parsed.value;
  }
  return undefined;
}

/** Completion requires a passing marker for the current spec hash. */
export function finalGateSatisfied(
  events: readonly { type: unknown; payload: unknown }[],
  specHash: string,
): boolean {
  return findFinalGateRecord(events, specHash)?.ok === true;
}

/** A concrete, actionable completion refusal. */
export function finalGateCompletionError(specHash: string, record?: FinalGatePayload): string {
  if (!record) {
    return `completion requires a passing final gate for spec ${specHash.slice(0, 12)}; the gate has not run for the current check list`;
  }
  if (!record.ok) {
    return `completion requires a passing final gate for spec ${specHash.slice(0, 12)}; the last run failed (${record.failure ?? record.failureClass ?? "unknown"})`;
  }
  return `completion requires a passing final gate for spec ${specHash.slice(0, 12)}`;
}
