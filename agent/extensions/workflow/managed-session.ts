/**
 * Workflow Extension — managed worker sessions.
 *
 * An orchestrator child is an ORDINARY Pi session: normal tools, normal UI,
 * its own TODOs. What makes it a worker is a small, validated bootstrap record
 * written before it starts, plus a readiness handshake. This module owns both.
 *
 * Three properties matter:
 *
 *  1. **No process-global marker.** The Review child sets an env marker for the
 *     duration of `createAgentSession`; that works for a synchronous in-process
 *     child but is unsafe across asynchronous session creation (two sessions in
 *     one process would see each other's marker). Worker identity is read from
 *     THIS session's branch instead.
 *  2. **No silent authority.** A worker cannot become a parent scheduler, and
 *     it cannot mutate the workspace before it has acknowledged its assignment.
 *     Readiness is a per-session gate, not a prompt request.
 *  3. **Fail closed on a bad record.** An unknown schema version or an invalid
 *     id means "not a managed worker" plus a reason — never a half-applied
 *     context.
 */

import { isIdentifier, ORCHESTRATOR_SCHEMA_VERSION, type AttemptId, type RunId, type TaskId } from "./orchestrator-types.ts";

/** Custom-entry/custom-message type the host writes before `session_start`. */
export const MANAGED_SESSION_ENTRY = "workflow-managed-session";

/** The only bootstrap version this build understands. */
export const MANAGED_SESSION_VERSION = ORCHESTRATOR_SCHEMA_VERSION;

export interface ManagedSessionContext {
  version: typeof MANAGED_SESSION_VERSION;
  runId: RunId;
  taskId: TaskId;
  attemptId: AttemptId;
  /** Opaque parent session identity; never a filesystem path requirement. */
  parentSessionRef: string;
  relation: "child" | "sibling";
  /** Semantic starting mode, passed through to the extension. */
  mode?: string;
  /** The worker may not start orchestration, whatever mode it is in. */
  mayOrchestrate: false;
}

export type ManagedContextResult =
  | { ok: true; context: ManagedSessionContext; source: "entry" | "message" }
  | { ok: false; reason: string }
  | { ok: false; reason: "absent" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * Validates the bootstrap payload. Unknown extra fields are ignored; unknown
 * versions and invalid identities are rejected with a reason the session can
 * show (and that the run record can cite).
 */
export function parseManagedSessionContext(raw: unknown): ManagedContextResult {
  if (raw === undefined || raw === null) return { ok: false, reason: "absent" };
  if (!isRecord(raw)) return { ok: false, reason: "bootstrap must be an object" };
  if (raw.version !== MANAGED_SESSION_VERSION) {
    return {
      ok: false,
      reason: `unsupported managed-session version ${String(raw.version)}`,
    };
  }
  if (!isIdentifier("run", raw.runId)) return { ok: false, reason: "invalid runId" };
  if (!isIdentifier("task", raw.taskId)) return { ok: false, reason: "invalid taskId" };
  if (!isIdentifier("attempt", raw.attemptId)) {
    return { ok: false, reason: "invalid attemptId" };
  }
  if (typeof raw.parentSessionRef !== "string" || raw.parentSessionRef.trim().length === 0) {
    return { ok: false, reason: "invalid parentSessionRef" };
  }
  if (raw.relation !== "child" && raw.relation !== "sibling") {
    return { ok: false, reason: "relation must be child or sibling" };
  }
  const mode =
    typeof raw.mode === "string" && raw.mode.trim().length > 0 && raw.mode.length <= 40
      ? raw.mode.trim()
      : undefined;
  return {
    ok: true,
    source: "entry",
    context: {
      version: MANAGED_SESSION_VERSION,
      runId: raw.runId,
      taskId: raw.taskId,
      attemptId: raw.attemptId,
      parentSessionRef: raw.parentSessionRef.trim(),
      relation: raw.relation,
      ...(mode === undefined ? {} : { mode }),
      // A record can never opt INTO orchestration; that is the parent's right.
      mayOrchestrate: false,
    },
  };
}

/** One branch entry, structurally (so this module stays SDK-free). */
export interface BranchEntryLike {
  type?: string;
  customType?: string;
  data?: unknown;
  message?: unknown;
}

function messageContentText(message: unknown): string | undefined {
  if (!isRecord(message)) return undefined;
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const parts: string[] = [];
  for (const block of content) {
    if (isRecord(block) && block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    }
  }
  return parts.length > 0 ? parts.join("\n") : undefined;
}

/**
 * Finds the newest managed-session bootstrap on the active branch.
 *
 * Supported shapes, because a host may write either:
 *   - a custom ENTRY with `data` = the record;
 *   - a custom MESSAGE whose text content is the JSON record.
 *
 * The newest wins: a rollover/continuation writes a fresh record with a new
 * attempt id, and an older one must never override it.
 */
export function readManagedSessionContext(entries: readonly BranchEntryLike[]): ManagedContextResult {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (!entry) continue;
    if (entry.type === "custom" && entry.customType === MANAGED_SESSION_ENTRY) {
      return parseManagedSessionContext(entry.data);
    }
    if (entry.type === "message" && isRecord(entry.message) && entry.message.customType === MANAGED_SESSION_ENTRY) {
      const text = messageContentText(entry.message);
      if (text === undefined) {
        return { ok: false, reason: "managed-session message has no text content" };
      }
      try {
        return { ...parseManagedSessionContext(JSON.parse(text)), source: "message" } as ManagedContextResult;
      } catch {
        return { ok: false, reason: "managed-session message is not valid JSON" };
      }
    }
  }
  return { ok: false, reason: "absent" };
}

// ── Readiness gate ───────────────────────────────────────────────────

export type WorkerPhase = "pending_ready" | "ready" | "closed";

export interface ManagedSessionGate {
  readonly context: ManagedSessionContext;
  phase(): WorkerPhase;
  /** The worker acknowledged its assignment. Idempotent. */
  acknowledgeStart(at?: number): boolean;
  /**
   * The PARENT granted mutation authority for this attempt/lease/start id.
   * Readiness alone never authorizes edits: a worker can be ready yet still
   * waiting for its grant, which is the state a resumed or fenced worker is in.
   */
  authorizeMutation(input: {
    leaseGeneration: number;
    taskStartId: string;
    at?: number;
  }): { ok: true } | { ok: false; code: "not_ready" | "closed" | "invalid"; error: string };
  /** Drop the live grant (fence/repair); readiness is unchanged. */
  revokeAuthorization(): void;
  /** The live grant, when one was accepted. */
  authorization(): { leaseGeneration: number; taskStartId: string; at: number } | undefined;
  /** True only after acknowledgement AND a matching parent grant. */
  canMutate(): boolean;
  /** The run/acceptance side closed this worker; further mutation is refused. */
  close(): void;
  /** Human-readable reason a mutation is blocked, or undefined when allowed. */
  mutationBlockReason(tool: string): string | undefined;
  acknowledgedAt(): number | undefined;
  /** A stable per-session id used in status/report correlation. */
  sessionKey(): string;
}

/**
 * Creates the readiness gate for one managed session.
 *
 * `sessionId` is the host's session identity. When absent, a deterministic key
 * is derived from (run, task, attempt) so logs stay correlatable and two
 * workers never collide.
 */
export function createManagedSessionGate(
  context: ManagedSessionContext,
  sessionId?: string,
): ManagedSessionGate {
  let phase: WorkerPhase = "pending_ready";
  let acknowledgedAt: number | undefined;
  let authority:
    | { leaseGeneration: number; taskStartId: string; at: number }
    | undefined;
  const key =
    sessionId && sessionId.trim().length > 0
      ? sessionId.trim()
      : `${context.runId}/${context.taskId}/${context.attemptId}`;

  return {
    context,
    phase: () => phase,
    acknowledgeStart(at = Date.now()) {
      if (phase === "closed") return false;
      if (phase === "ready") return true;
      phase = "ready";
      acknowledgedAt = at;
      return true;
    },
    authorizeMutation(input) {
      if (phase === "closed") {
        return { ok: false, code: "closed", error: "this worker session is closed" };
      }
      if (phase !== "ready") {
        return {
          ok: false,
          code: "not_ready",
          error: "the worker has not acknowledged its assignment yet",
        };
      }
      if (
        !Number.isInteger(input.leaseGeneration) ||
        input.leaseGeneration < 1 ||
        typeof input.taskStartId !== "string" ||
        input.taskStartId.length === 0
      ) {
        return { ok: false, code: "invalid", error: "the grant is incomplete" };
      }
      authority = {
        leaseGeneration: input.leaseGeneration,
        taskStartId: input.taskStartId,
        at: input.at ?? Date.now(),
      };
      return { ok: true };
    },
    revokeAuthorization() {
      authority = undefined;
    },
    authorization: () => authority,
    canMutate: () => phase === "ready" && authority !== undefined,
    close() {
      phase = "closed";
      authority = undefined;
    },
    mutationBlockReason(tool) {
      if (phase === "closed") {
        return `This worker session is closed; ${tool} is refused. The parent verifies and decides whether to reopen the task.`;
      }
      if (phase !== "ready") {
        return `Worker not ready yet: call workflow_worker_ready after reading the assignment before using ${tool}.`;
      }
      if (authority) return undefined;
      return `Worker is ready but not authorized yet: the parent must grant this attempt's lease/start before ${tool}. Nothing is running.`;
    },
    acknowledgedAt: () => acknowledgedAt,
    sessionKey: () => key,
  };
}

/**
 * True when this session's branch carries evidence that it WAS a managed
 * worker, even if its bootstrap can no longer be read. A branch that lost its
 * record must be reconciled, never silently promoted to ordinary authority.
 */
export function hasManagedHistory(entries: readonly BranchEntryLike[]): boolean {
  return entries.some(
    (entry) =>
      (entry.type === "custom" || entry.type === "message") &&
      (entry.customType === MANAGED_SESSION_ENTRY ||
        entry.customType === "workflow-task-assignment" ||
        entry.customType === "workflow-task-scope" ||
        entry.customType === "workflow-roadmap-reference"),
  );
}

/**
 * The three session identities. The middle one is the reason this exists: a
 * present-but-unreadable managed record is neither ordinary nor a usable
 * worker, so it is quarantined instead of falling open.
 */
export type ManagedSessionState =
  | { kind: "ordinary" }
  | { kind: "worker"; context: ManagedSessionContext }
  | { kind: "quarantined"; reason: string };

export function resolveManagedSessionState(
  entries: readonly BranchEntryLike[],
  readError?: unknown,
): ManagedSessionState {
  if (readError !== undefined) {
    return {
      kind: "quarantined",
      reason: `the managed bootstrap could not be read: ${
        readError instanceof Error ? readError.message : String(readError)
      }`,
    };
  }
  const read = readManagedSessionContext(entries);
  if (read.ok) return { kind: "worker", context: read.context };
  if (read.reason === "absent") {
    return hasManagedHistory(entries)
      ? {
          kind: "quarantined",
          reason:
            "this branch was a managed worker but its bootstrap is no longer readable; reconcile the assignment before mutating",
        }
      : { kind: "ordinary" };
  }
  return { kind: "quarantined", reason: read.reason };
}

/**
 * The reason a quarantined session must refuse a tool. Read-only inspection is
 * allowed (that is how the user reconciles it); mutation, shell and
 * orchestration are not.
 */
export function quarantineBlockReason(input: {
  reason: string;
  tool: string;
  mutating: boolean;
}): string | undefined {
  if (!input.mutating) return undefined;
  return `This managed worker session is quarantined (${input.reason}). ${input.tool} is refused: inspect the assignment and reconcile it before any workspace change, orchestration or commit.`;
}

/**
 * True when this session must not start an orchestration run of its own.
 * A worker can still use Plan/Build/Default and its own TODOs — it just cannot
 * become a parent scheduler.
 */
export function isManagedWorker(entries: readonly BranchEntryLike[]): boolean {
  return readManagedSessionContext(entries).ok;
}
