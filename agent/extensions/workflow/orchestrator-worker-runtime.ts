/**
 * Workflow Extension — managed worker runtime (integration step 13).
 *
 * The worker-side composition layer. It answers one question in a testable way:
 * may THIS managed child mutate the workspace right now?
 *
 * The order is deliberate and narrow:
 *
 *   preflight (model + tools + assignment metadata)   → ready
 *   workflow_worker_ready (the child read the task)   → acknowledged
 *   parent grant over IPC (lease + start id)          → may mutate
 *   start acknowledgement                             → running
 *   settle + drain                                    → fenced
 *
 * Acknowledging readiness alone never authorizes edits: that is what a resumed
 * transcript, a fenced worker or an unapproved dispatch looks like. The parent
 * grant is the only transition that opens mutation.
 */

import {
  createManagedSessionGate,
  type ManagedSessionContext,
  type ManagedSessionGate,
} from "./managed-session.ts";

export interface WorkerPreflightInput {
  /** The Builder model the assignment expects, when known. */
  model: { provider: string; id: string } | null;
  activeTools: readonly string[];
  /** Tools the task cannot be done without (e.g. read/edit/bash). */
  requiredTools?: readonly string[];
  /** The assignment metadata the host wrote before launch was found. */
  assignmentPresent: boolean;
}

export interface PreflightVerdict {
  ok: boolean;
  missing: string[];
}

export function evaluateWorkerPreflight(input: WorkerPreflightInput): PreflightVerdict {
  const missing: string[] = [];
  if (!input.assignmentPresent) missing.push("assignment metadata");
  if (!input.model || !input.model.provider || !input.model.id) missing.push("builder model");
  const active = new Set(input.activeTools);
  for (const tool of input.requiredTools ?? []) {
    if (!active.has(tool)) missing.push(`tool ${tool}`);
  }
  return { ok: missing.length === 0, missing };
}

export type WorkerRuntimeCode =
  | "preflight"
  | "not_ready"
  | "not_authorized"
  | "closed"
  | "mismatch"
  | "already";

export type WorkerRuntimeResult<T = undefined> =
  | ({ ok: true } & (T extends undefined ? { value?: undefined } : { value: T }))
  | { ok: false; code: WorkerRuntimeCode; error: string; missing?: string[] };

export interface WorkerRuntime {
  readonly gate: ManagedSessionGate;
  preflight(): PreflightVerdict;
  /** The child acknowledges it read the assignment; preflight must pass. */
  acknowledge(now?: number): WorkerRuntimeResult;
  /** The parent grant: the only transition that opens mutation. */
  authorize(input: {
    leaseGeneration: number;
    taskStartId: string;
    now?: number;
  }): WorkerRuntimeResult;
  /** The child reports the actual turn start for the authorized id. */
  noteStartAck(taskStartId: string): WorkerRuntimeResult;
  running(): boolean;
  /** Settle/drain fence: mutation stops until a repair grant arrives. */
  fence(): void;
  fenced(): boolean;
  close(): void;
}

export function createWorkerRuntime(input: {
  context: ManagedSessionContext;
  sessionId?: string;
  preflightInput: () => WorkerPreflightInput;
  now?: () => number;
}): WorkerRuntime {
  const now = input.now ?? (() => Date.now());
  const gate = createManagedSessionGate(input.context, input.sessionId);
  let started = false;
  let fenced = false;

  const preflight = () => evaluateWorkerPreflight(input.preflightInput());

  const runtime: WorkerRuntime = {
    gate,
    preflight,

    acknowledge(at = now()) {
      if (fenced) return { ok: false, code: "closed", error: "this worker is fenced" };
      const verdict = preflight();
      if (!verdict.ok) {
        return {
          ok: false,
          code: "preflight",
          error: `the worker environment is incomplete: ${verdict.missing.join(", ")}`,
          missing: verdict.missing,
        };
      }
      const first = gate.phase() !== "ready";
      if (!gate.acknowledgeStart(at)) {
        return { ok: false, code: "closed", error: "this worker is closed" };
      }
      return first
        ? { ok: true, value: undefined }
        : { ok: false, code: "already", error: "the assignment was already acknowledged" };
    },

    authorize(grant) {
      if (fenced) {
        return {
          ok: false,
          code: "closed",
          error: "this worker is fenced; the parent must grant a repair first",
        };
      }
      const result = gate.authorizeMutation({
        leaseGeneration: grant.leaseGeneration,
        taskStartId: grant.taskStartId,
        ...(grant.now === undefined ? {} : { at: grant.now }),
      });
      if (!result.ok) {
        return {
          ok: false,
          code: result.code === "not_ready" ? "not_ready" : result.code === "closed" ? "closed" : "mismatch",
          error: result.error,
        };
      }
      return { ok: true, value: undefined };
    },

    noteStartAck(taskStartId) {
      const authority = gate.authorization();
      if (!authority) {
        return {
          ok: false,
          code: "not_authorized",
          error: "no parent grant exists for this attempt",
        };
      }
      if (authority.taskStartId !== taskStartId) {
        return {
          ok: false,
          code: "mismatch",
          error: "the acknowledgement does not name the authorized start id",
        };
      }
      if (started) {
        return { ok: false, code: "already", error: "the turn start was already recorded" };
      }
      started = true;
      return { ok: true, value: undefined };
    },

    running: () => started && !fenced,

    fence() {
      fenced = true;
      started = false;
      gate.revokeAuthorization();
    },

    fenced: () => fenced,

    close() {
      fenced = true;
      started = false;
      gate.close();
    },
  };

  return runtime;
}
