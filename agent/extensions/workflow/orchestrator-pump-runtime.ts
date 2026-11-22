/**
 * Workflow Extension — parent event pump runtime (integration step 17).
 *
 * `createEventPump` (orchestrator-tools.ts) is the pure correlation policy.
 * This module is what makes it durable and real:
 *
 *   - one pump per current attempt identity, so a new attempt or epoch cannot
 *     inherit an old queue;
 *   - delivery is journaled BEFORE it is considered done (`wake.delivered`), so
 *     a reload cannot deliver the same wake twice;
 *   - a wake is only drained when the parent is idle (`agent_settled` boundary),
 *     never from `agent_end`;
 *   - heartbeats/progress can update status but never schedule a turn.
 *
 * The module performs no model call itself: `deliver` is injected by index.ts
 * and must be the live `pi.sendMessage(..., { triggerTurn: true })`.
 */

import {
  createEventPump,
  type EventPump,
  type ParentWake,
  type PumpEvent,
  type PumpIdentity,
  type PumpResult,
} from "./orchestrator-tools.ts";
import type { OrchestratorRuntime } from "./orchestrator-runtime.ts";

export const PUMP_RUNTIME_SCHEMA_VERSION = 1 as const;

export interface PumpRuntimePorts {
  runtime: () => OrchestratorRuntime | undefined;
  /** The attempt this parent is currently coordinating, if any. */
  identity: () => PumpIdentity | undefined;
  /** The one real wake path (live `pi`/`ctx`); returns after delivery. */
  deliver: (wake: ParentWake) => Promise<{ ok: true } | { ok: false; error: string }>;
  now?: () => number;
}

export type PumpRuntimeIngest =
  | PumpResult
  | { ok: false; code: "no_identity" | "disposed" | "invalid"; error: string };

export type PumpDelivery =
  | { delivered: true; wake: ParentWake }
  | { delivered: false; reason: string };

export interface PumpRuntime {
  ingest(raw: unknown): PumpRuntimeIngest;
  /** Delivers at most one coalesced wake when the parent is idle. */
  drainAndDeliver(): Promise<PumpDelivery>;
  /** Call from `agent_settled`: the parent turn is over, queued wakes may run. */
  endTurn(): void;
  pending(): number;
  disposed(): boolean;
  dispose(): void;
  /** Test/diagnostic view of what this runtime has journaled. */
  deliveredKeys(): readonly string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function identityKey(identity: PumpIdentity): string {
  return [
    identity.runId,
    identity.taskId,
    identity.attemptId,
    identity.sessionId,
    identity.generation,
    identity.leaseGeneration,
    identity.epoch,
  ].join("|");
}

/**
 * Structural validation at the boundary. The pure pump re-checks every field
 * against the live identity; this only ensures the wire value is an event shape
 * and never `undefined`/a string smuggled in as JSON.
 */
function asPumpEvent(raw: unknown): PumpEvent | undefined {
  if (!isRecord(raw)) return undefined;
  const required = [
    "messageId",
    "kind",
    "runId",
    "taskId",
    "attemptId",
    "sessionId",
  ] as const;
  for (const key of required) {
    if (typeof raw[key] !== "string" || (raw[key] as string).length === 0) return undefined;
  }
  for (const key of ["seq", "generation", "leaseGeneration", "epoch", "at"] as const) {
    if (typeof raw[key] !== "number" || !Number.isFinite(raw[key] as number)) return undefined;
  }
  // SAFETY: every field the pump dereferences was type-checked above, and the
  // remaining optional fields (report, settled, pendingTools…) are re-validated
  // by the pure pump against the live identity before any wake is scheduled.
  return raw as unknown as PumpEvent;
}

export function createPumpRuntime(ports: PumpRuntimePorts): PumpRuntime {
  let pump: EventPump | undefined;
  let pumpIdentity = "";
  let disposed = false;
  let loaded = false;
  const delivered = new Set<string>();
  let pendingWake: ParentWake | undefined;

  const ensurePump = (): { ok: true; pump: EventPump } | { ok: false; error: string } => {
    if (disposed) return { ok: false, error: "the pump runtime is disposed" };
    const identity = ports.identity();
    if (!identity) return { ok: false, error: "no coordinated attempt is bound to this parent" };
    const key = identityKey(identity);
    if (pump && key === pumpIdentity) return { ok: true, pump };
    pump?.close();
    pump = createEventPump({ identity });
    pumpIdentity = key;
    pendingWake = undefined;
    return { ok: true, pump };
  };

  const loadDelivered = async (): Promise<void> => {
    if (loaded) return;
    loaded = true;
    const runtime = ports.runtime();
    if (!runtime) return;
    const events = await runtime.journalEvents();
    if (!events.ok) return;
    for (const event of events.value) {
      if (event.type !== "wake.delivered" || !isRecord(event.payload)) continue;
      const key = event.payload.wakeKey;
      if (typeof key === "string") delivered.add(key);
    }
  };

  const wakeKey = (wake: ParentWake): string => `${wake.dedupeKey}:${wake.kind}`;

  const runtime: PumpRuntime = {
    ingest(raw) {
      if (disposed) return { ok: false, code: "disposed", error: "the pump runtime is disposed" };
      const event = asPumpEvent(raw);
      if (!event) return { ok: false, code: "invalid", error: "not a pump event" };
      const ensured = ensurePump();
      if (!ensured.ok) return { ok: false, code: "no_identity", error: ensured.error };
      const result = ensured.pump.ingest(event);
      if (result.ok && result.wake) pendingWake = result.wake;
      return result;
    },

    async drainAndDeliver() {
      if (disposed) return { delivered: false, reason: "the pump runtime is disposed" };
      const ensured = ensurePump();
      if (!ensured.ok) return { delivered: false, reason: ensured.error };
      await loadDelivered();
      const wake = pendingWake ?? ensured.pump.drain();
      if (!wake) return { delivered: false, reason: "no safe wake is queued" };
      pendingWake = undefined;
      const key = wakeKey(wake);
      if (delivered.has(key)) {
        return { delivered: false, reason: `wake ${key} was already delivered; not repeating it` };
      }
      const result = await ports.deliver(wake);
      if (!result.ok) {
        // Delivery failure is not delivered: the caller may retry at the next
        // settled boundary, and no journal record claims otherwise.
        return { delivered: false, reason: result.error };
      }
      const owner = ports.runtime();
      if (owner) {
        await owner.appendJournal(
          "wake.delivered",
          { wakeKey: key, kind: wake.kind, taskId: wake.taskId, attemptId: wake.attemptId },
          `wake-delivered-${key}`,
        );
      }
      delivered.add(key);
      return { delivered: true, wake };
    },

    endTurn() {
      if (disposed) return;
      pump?.endTurn();
    },

    pending() {
      return (pump?.pending() ?? 0) + (pendingWake ? 1 : 0);
    },

    disposed: () => disposed,

    dispose() {
      disposed = true;
      pump?.close();
      pump = undefined;
      pendingWake = undefined;
    },

    deliveredKeys: () => [...delivered],
  };

  return runtime;
}

/** True when this event may schedule a parent turn (never heartbeats). */
export function wakeEligibleKind(kind: PumpEvent["kind"]): boolean {
  return (
    kind === "candidate" ||
    kind === "quiescent" ||
    kind === "waiting-user" ||
    kind === "ready" ||
    kind === "close" ||
    kind === "pause"
  );
}
