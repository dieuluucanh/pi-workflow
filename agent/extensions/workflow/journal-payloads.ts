/**
 * Workflow Extension — journal payload registry and upcasters.
 *
 * The journal itself is append-only v1 (`JOURNAL_VERSION = 1`, one checksum
 * algorithm, one `prev` chain); the *payload* is the compatibility boundary.
 * Decision 6 deliberately keeps the line framing frozen: an older reader
 * treats an unknown line version as a torn tail, so adding a second frame
 * would lose history instead of preserving it.
 *
 * This module owns what the store must know before it trusts a line:
 *   - which event types this build can read (including read-only legacy types
 *     written by the pre-orchestrator journal, so archived runs stay loadable);
 *   - the payload version of each type, and fail-closed rejection of a version
 *     this build does not understand;
 *   - a per-type validator for the fields the store/reducer depend on;
 *   - an in-memory upcast selected by the payload's own version (v1 frozen
 *     snapshot -> v2; Phase-A `run.control` repair -> typed amendment).
 *
 * Upcasting NEVER rewrites the journal or recomputes a checksum: replay hands
 * raw events back byte-identically, and callers ask for the upcast view.
 */

import {
  CHECK_SPEC_REPAIR_ACTION,
  validateCheckSpecRepairPayload,
  type CheckSpecRepairPayload,
} from "./orchestrator-check-repair.ts";
import { RUN_PHASES, type RunPhase } from "./orchestrator-types.ts";
import {
  FINAL_GATE_EVENT_TYPE,
  FINAL_GATE_PAYLOAD_VERSION,
  validateFinalGatePayload,
} from "./final-gate.ts";
import {
  readFrozenSnapshot,
  type FrozenExecutionSnapshot,
  type QuarantinedCheck,
} from "./frozen-snapshot.ts";
import { planCheckId, type CheckSpec } from "./plan-spec.ts";
import type { PlanCheckSpec } from "./plan-checks.ts";

/** Event types this build can read. New writers add to this list deliberately. */
export const READABLE_EVENT_TYPES = [
  "run.created",
  "todos.frozen",
  "run.transition",
  "task.started",
  "task.start.intent",
  "task.launched",
  "task.reported",
  "task.verified",
  "task.needs_fix",
  "task.accepted",
  "task.blocked",
  "task.retried",
  "run.control",
  "run.completed",
  "final_gate",
] as const;

/**
 * Read-only types written by the superseded journal implementation. They are
 * recognised so an archived run does not become unreadable, but this build
 * never writes them and no reducer consumes them.
 */
export const LEGACY_EVENT_TYPES = [
  "plan.proposed",
  "run.preparation",
  "execution.approved",
] as const;

export type ReadableEventType = (typeof READABLE_EVENT_TYPES)[number];
export type LegacyEventType = (typeof LEGACY_EVENT_TYPES)[number];

const READABLE: ReadonlySet<string> = new Set(READABLE_EVENT_TYPES);
const LEGACY: ReadonlySet<string> = new Set(LEGACY_EVENT_TYPES);
const PHASES: ReadonlySet<string> = new Set(RUN_PHASES);
const SHA256 = /^[a-f0-9]{64}$/;

export type JournalPayloadValidation =
  | { ok: true; warnings: string[] }
  | {
      ok: false;
      code: "unknown_event" | "unknown_version" | "invalid_payload";
      error: string;
    };

export interface JournalPayloadUpcast {
  ok: true;
  /** In-memory payload; the stored bytes are untouched. */
  payload: Record<string, unknown>;
  fromVersion: number;
  toVersion: number;
  warnings: string[];
  quarantined: QuarantinedCheck[];
}

export type JournalPayloadUpcastResult =
  | JournalPayloadUpcast
  | { ok: false; code: "unknown_event" | "unknown_version" | "invalid_payload"; error: string };

export interface PayloadContract {
  /** Envelope versions this reader understands. Empty = versionless payload. */
  versions: readonly number[];
  /** Selects the payload's own version; undefined when it carries none. */
  versionOf?: (payload: Record<string, unknown>) => number | undefined;
  /** Returns an error message, or undefined when the payload is readable. */
  validate: (payload: Record<string, unknown>) => string | undefined;
  /** Optional in-memory upgrade; identity when absent. */
  upcast?: (payload: Record<string, unknown>) => JournalPayloadUpcastResult;
  /** Read-only historical type; never written by this build. */
  legacy?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function requireString(
  payload: Record<string, unknown>,
  key: string,
  label: string,
): string | undefined {
  const value = payload[key];
  return typeof value === "string" && value.trim().length > 0
    ? undefined
    : `${label} has no ${key}`;
}

function optionalString(
  payload: Record<string, unknown>,
  key: string,
  label: string,
): string | undefined {
  const value = payload[key];
  return value === undefined || typeof value === "string"
    ? undefined
    : `${label} has an invalid ${key}`;
}

function optionalFiniteNumber(
  payload: Record<string, unknown>,
  key: string,
  label: string,
): string | undefined {
  const value = payload[key];
  return value === undefined || (typeof value === "number" && Number.isFinite(value))
    ? undefined
    : `${label} has an invalid ${key}`;
}

function taskPayload(payload: Record<string, unknown>, label: string): string | undefined {
  return requireString(payload, "taskId", label);
}

/** `todos.frozen` payload version is the snapshot's own version marker. */
function frozenPayloadVersion(payload: Record<string, unknown>): number | undefined {
  const snapshot = payload.snapshot;
  if (!isRecord(snapshot)) return undefined;
  if (typeof snapshot.schemaVersion === "number") return snapshot.schemaVersion;
  if (typeof snapshot.version === "number") return snapshot.version;
  return undefined;
}

function validateFrozenPayload(payload: Record<string, unknown>): string | undefined {
  const executionId = requireString(payload, "executionId", "todos.frozen");
  if (executionId) return executionId;
  if (typeof payload.digest !== "string" || !SHA256.test(payload.digest)) {
    return "todos.frozen has an invalid digest";
  }
  const snapshot = payload.snapshot;
  if (!isRecord(snapshot)) return "todos.frozen has no snapshot";
  // The store validates the envelope and the payload version. Full snapshot
  // semantics (row bounds, workspace geometry, quarantined checks) belong to
  // `readFrozenSnapshot` on restore: bricking the whole journal because one
  // historical snapshot has an awkward workspace set would lose run history.
  const version = frozenPayloadVersion(payload);
  if (version !== 1 && version !== 2) {
    return `todos.frozen has an unknown snapshot version ${String(version)}`;
  }
  if (!Array.isArray(snapshot.rows) || snapshot.rows.length === 0) {
    return "todos.frozen snapshot has no rows";
  }
  if (!Array.isArray(snapshot.planChecks)) {
    return "todos.frozen snapshot has no planChecks";
  }
  return undefined;
}

function validateRunCreated(payload: Record<string, unknown>): string | undefined {
  for (const key of ["sourcePath", "title", "mode", "digest"] as const) {
    const error = optionalString(payload, key, "run.created");
    if (error) return error;
  }
  if (payload.digest !== undefined && !SHA256.test(String(payload.digest))) {
    return "run.created has an invalid digest";
  }
  if (
    payload.mode !== undefined &&
    payload.mode !== "build" &&
    payload.mode !== "orchestrator"
  ) {
    return "run.created has an unknown mode";
  }
  for (const key of ["rowCount", "revision", "requirementCount"] as const) {
    const error = optionalFiniteNumber(payload, key, "run.created");
    if (error) return error;
  }
  if (payload.plan !== undefined && payload.plan !== null) {
    if (!isRecord(payload.plan)) return "run.created has an invalid plan reference";
    for (const key of ["path", "title", "digest"] as const) {
      const error = optionalString(payload.plan, key, "run.created plan");
      if (error) return error;
    }
  }
  return undefined;
}

function validateRunTransition(payload: Record<string, unknown>): string | undefined {
  if (payload.to === undefined) return undefined;
  if (typeof payload.to !== "string" || !PHASES.has(payload.to)) {
    return `run.transition has an unknown phase ${String(payload.to)}`;
  }
  return optionalFiniteNumber(payload, "now", "run.transition");
}

function validateTaskEnvelope(
  payload: Record<string, unknown>,
  label: string,
): string | undefined {
  const taskId = taskPayload(payload, label);
  if (taskId) return taskId;
  const type = optionalString(payload, "type", label);
  if (type) return type;
  return optionalFiniteNumber(payload, "now", label);
}

function validateRunControl(payload: Record<string, unknown>): string | undefined {
  const action = requireString(payload, "action", "run.control");
  if (action) return action;
  if (payload.version !== undefined && payload.version !== 1) {
    return `run.control has an unknown payload version ${String(payload.version)}`;
  }
  const shape = optionalFiniteNumber(payload, "approvedAt", "run.control");
  if (shape) return shape;
  if (payload.action === CHECK_SPEC_REPAIR_ACTION) {
    const parsed = validateCheckSpecRepairPayload(payload);
    if (!parsed.ok) return `run.control repair amendment is invalid: ${parsed.error}`;
    return undefined;
  }
  if (payload.action === "cancel") {
    return requireString(payload, "reason", "run.control cancel");
  }
  // Unknown actions are ignored by restore and never execute anything; they
  // are kept readable so a newer writer's control event is not a hard failure.
  if (payload.record !== undefined && !isRecord(payload.record)) {
    return "run.control has an invalid record";
  }
  return undefined;
}

function upcastFrozenPayload(
  payload: Record<string, unknown>,
): JournalPayloadUpcastResult {
  const snapshot = payload.snapshot;
  if (!isRecord(snapshot)) {
    return { ok: false, code: "invalid_payload", error: "todos.frozen has no snapshot" };
  }
  const read = readFrozenSnapshot(snapshot);
  if (!read.ok) {
    const code = read.code === "unknown_version" ? "unknown_version" : "invalid_payload";
    return { ok: false, code, error: read.error };
  }
  const frozen: FrozenExecutionSnapshot = read.snapshot;
  return {
    ok: true,
    payload: { ...payload, snapshot: frozen },
    fromVersion: read.fromVersion,
    toVersion: 2,
    warnings: read.warnings,
    quarantined: read.quarantined,
  };
}

/** Phase-A amendments carry command+kind only; v2 checks have stable ids. */
function upcastCheckSpecRepair(
  payload: Record<string, unknown>,
): JournalPayloadUpcastResult {
  const parsed = validateCheckSpecRepairPayload(payload);
  if (!parsed.ok) {
    return { ok: false, code: "invalid_payload", error: parsed.error };
  }
  const amendment: CheckSpecRepairPayload = parsed.value;
  const typed: CheckSpec[] = amendment.next.planCheckSpecs.map((spec, index) => ({
    id: planCheckId(index),
    command: spec.command,
    ...(spec.workspace === undefined ? {} : { workspace: spec.workspace }),
    kind: spec.kind,
  }));
  const nextView: { planChecks: string[]; planCheckSpecs: PlanCheckSpec[] } = {
    planChecks: typed.map((spec) => spec.command),
    planCheckSpecs: typed.map((spec) => ({
      command: spec.command,
      ...(spec.workspace === undefined ? {} : { workspace: spec.workspace }),
    })),
  };
  return {
    ok: true,
    payload: {
      ...payload,
      // `previous` is history and may be malformed; it stays byte-exact.
      previous: amendment.previous,
      next: nextView,
      typedNext: typed,
    },
    fromVersion: amendment.version,
    toVersion: 1,
    warnings: [
      "Phase-A plan-check amendment upcast to typed check specs in memory",
    ],
    quarantined: [],
  };
}

/**
 * The registry. Validators are intentionally field-scoped, not
 * unknown-key-rejecting: journal payloads also carry runner metadata
 * (`type`, `runId`, `now`) that future writers may extend.
 */
export const EVENT_PAYLOAD_REGISTRY: Readonly<Record<string, PayloadContract>> = {
  "run.created": {
    versions: [],
    validate: validateRunCreated,
  },
  "todos.frozen": {
    versions: [1, 2],
    versionOf: frozenPayloadVersion,
    validate: validateFrozenPayload,
    upcast: upcastFrozenPayload,
  },
  "run.transition": {
    versions: [],
    validate: validateRunTransition,
  },
  "task.started": {
    versions: [],
    validate: (payload) => validateTaskEnvelope(payload, "task.started"),
  },
  "task.start.intent": {
    versions: [],
    validate: (payload) =>
      taskPayload(payload, "task.start.intent") ??
      requireString(payload, "attemptId", "task.start.intent") ??
      optionalString(payload, "sessionId", "task.start.intent"),
  },
  "task.launched": {
    versions: [],
    validate: (payload) => validateTaskEnvelope(payload, "task.launched"),
  },
  "task.reported": {
    versions: [],
    validate: (payload) => validateTaskEnvelope(payload, "task.reported"),
  },
  "task.verified": {
    versions: [],
    validate: (payload) => validateTaskEnvelope(payload, "task.verified"),
  },
  "task.needs_fix": {
    versions: [],
    validate: (payload) => validateTaskEnvelope(payload, "task.needs_fix"),
  },
  "task.accepted": {
    versions: [],
    validate: (payload) =>
      taskPayload(payload, "task.accepted") ??
      requireString(payload, "evidenceId", "task.accepted"),
  },
  "task.blocked": {
    versions: [],
    validate: (payload) =>
      taskPayload(payload, "task.blocked") ??
      requireString(payload, "reason", "task.blocked"),
  },
  "task.retried": {
    versions: [],
    validate: (payload) => validateTaskEnvelope(payload, "task.retried"),
  },
  "run.control": {
    versions: [1],
    versionOf: (payload) =>
      typeof payload.version === "number" ? payload.version : undefined,
    validate: validateRunControl,
    upcast: (payload) =>
      payload.action === CHECK_SPEC_REPAIR_ACTION
        ? upcastCheckSpecRepair(payload)
        : {
            ok: true,
            payload,
            fromVersion: 1,
            toVersion: 1,
            warnings: [],
            quarantined: [],
          },
  },
  "run.completed": {
    versions: [],
    validate: (payload) => optionalFiniteNumber(payload, "at", "run.completed"),
  },
  [FINAL_GATE_EVENT_TYPE]: {
    versions: [FINAL_GATE_PAYLOAD_VERSION],
    versionOf: (payload) =>
      typeof payload.version === "number" ? payload.version : undefined,
    validate: validateFinalGatePayload,
  },
};

/** Read-only legacy contracts: object payloads only, no interpretation. */
for (const type of LEGACY_EVENT_TYPES) {
  (EVENT_PAYLOAD_REGISTRY as Record<string, PayloadContract>)[type] = {
    versions: [],
    validate: (payload) =>
      isRecord(payload) ? undefined : `${type} payload is not an object`,
    legacy: true,
  };
}

export function isReadableEventType(type: unknown): boolean {
  return typeof type === "string" && (READABLE.has(type) || LEGACY.has(type));
}

export function isLegacyEventType(type: unknown): boolean {
  return typeof type === "string" && LEGACY.has(type);
}

/** The payload's own version, if the contract defines one. */
export function payloadVersionOf(
  type: unknown,
  payload: unknown,
): number | undefined {
  if (typeof type !== "string") return undefined;
  const contract = EVENT_PAYLOAD_REGISTRY[type];
  if (!contract?.versionOf || !isRecord(payload)) return undefined;
  return contract.versionOf(payload);
}

/**
 * Validate one journal line's type and payload. Unknown types and unknown
 * payload versions fail closed with a code the store maps to a journal error.
 */
export function validateJournalEventPayload(
  type: unknown,
  payload: unknown,
): JournalPayloadValidation {
  if (typeof type !== "string") {
    return { ok: false, code: "unknown_event", error: "the event type is not a string" };
  }
  const contract = EVENT_PAYLOAD_REGISTRY[type];
  if (!contract || !isReadableEventType(type)) {
    return {
      ok: false,
      code: "unknown_event",
      error: `unknown journal event type ${type}`,
    };
  }
  if (!isRecord(payload)) {
    return {
      ok: false,
      code: "invalid_payload",
      error: `${type} payload is not an object`,
    };
  }
  if (contract.versionOf) {
    const version = contract.versionOf(payload);
    if (version !== undefined && !contract.versions.includes(version)) {
      return {
        ok: false,
        code: "unknown_version",
        error: `${type} has an unknown payload version ${version}`,
      };
    }
  }
  const error = contract.validate(payload);
  if (error) return { ok: false, code: "invalid_payload", error };
  return { ok: true, warnings: [] };
}

/**
 * Validate every journal payload in order. This is the load gate: the store
 * calls it after byte-level replay, so an unreadable payload fails closed with
 * the event's sequence instead of being partially interpreted.
 */
export function validateJournalEventSequence(
  events: readonly { type: unknown; seq: number; payload: unknown }[],
): JournalPayloadValidation {
  for (const event of events) {
    const validated = validateJournalEventPayload(event.type, event.payload);
    if (!validated.ok) {
      return {
        ok: false,
        code: validated.code,
        error: `${String(event.type)} seq ${event.seq}: ${validated.error}`,
      };
    }
  }
  return { ok: true, warnings: [] };
}

/**
 * Produce the in-memory typed view of one journal payload. Raw bytes are never
 * touched; a versionless payload upcasts to itself.
 */
export function upcastJournalEventPayload(
  type: unknown,
  payload: unknown,
): JournalPayloadUpcastResult {
  const validated = validateJournalEventPayload(type, payload);
  if (!validated.ok) return validated;
  const contract = EVENT_PAYLOAD_REGISTRY[type as string]!;
  const record = payload as Record<string, unknown>;
  if (!contract.upcast) {
    return {
      ok: true,
      payload: record,
      fromVersion: payloadVersionOf(type, payload) ?? 1,
      toVersion: payloadVersionOf(type, payload) ?? 1,
      warnings: validated.warnings,
      quarantined: [],
    };
  }
  const upcast = contract.upcast(record);
  if (!upcast.ok) return upcast;
  return { ...upcast, warnings: [...validated.warnings, ...upcast.warnings] };
}

/** Readable phases, exported so callers do not duplicate the list. */
export const READABLE_RUN_PHASES: readonly RunPhase[] = RUN_PHASES;
