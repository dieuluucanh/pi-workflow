/**
 * Workflow Extension — local worker control protocol (step 23).
 *
 * Bounded, authenticated messages between the parent coordinator and a managed
 * Build child. Nothing here trusts a transport: every envelope is validated
 * (version, size, HMAC, run/task/attempt/session/lease generation, monotonic
 * sequence) before it can affect state, and only `start`/`repair` can authorize
 * mutation. There is deliberately no `accept` message — acceptance is a
 * parent-only, evidence-backed decision.
 *
 * Delivery is idempotent and durable through an injected receipt store: a
 * retried message id is never delivered twice, and a retried `start` with the
 * same task-start id cannot launch a second assignment turn. Lost IPC recovers
 * from pending receipts without polling model turns.
 *
 * Transport endpoints are local-only: a Windows named pipe or a Unix socket in
 * the profile-owned private directory. The caller supplies the transport; this
 * module only builds/validates messages, manages receipts and computes the
 * endpoint. Secrets never appear in prompts or payloads.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const CONTROL_PROTOCOL_VERSION = 1 as const;
export const AUTH_SCHEME = "hmac-sha256" as const;
export const MAX_MESSAGE_BYTES = 64 * 1024;
export const MAX_MESSAGE_ID_CHARS = 200;
export const MAX_TASK_START_ID_CHARS = 200;
export const MIN_SECRET_BYTES = 32;

export const MESSAGE_TYPES = [
  "ready",
  "start",
  "start-ack",
  "progress",
  "waiting-user",
  "candidate",
  "quiescent",
  "repair",
  "pause",
  "heartbeat",
  "close",
] as const;
export type MessageType = (typeof MESSAGE_TYPES)[number];

/** Only these can authorize workspace mutation (and only after validation). */
export const MUTATING_MESSAGE_TYPES: ReadonlySet<MessageType> = new Set(["start", "repair"]);

export interface ControlEnvelope {
  version: typeof CONTROL_PROTOCOL_VERSION;
  messageId: string;
  /** Monotonic per sender; a lower/equal sequence is reordered/stale. */
  seq: number;
  type: MessageType;
  runId: string;
  taskId: string;
  attemptId: string;
  sessionId: string;
  /** Attempt/session generation the sender believes is current. */
  generation: number;
  /** Workspace lease generation; must match for mutation authorization. */
  leaseGeneration: number;
  taskStartId?: string;
  sentAt: number;
  payload: unknown;
  auth: { scheme: typeof AUTH_SCHEME; mac: string };
}

export type ControlErrorCode =
  | "malformed"
  | "oversized"
  | "version"
  | "auth"
  | "mismatch"
  | "stale"
  | "reordered"
  | "duplicate"
  | "unsupported";

export type ControlResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: ControlErrorCode; error: string };

export interface ValidationContext {
  secret: string;
  runId: string;
  taskId: string;
  attemptId: string;
  sessionId: string;
  generation: number;
  leaseGeneration: number;
  /** Last accepted sequence from this sender. */
  lastSeq?: number;
  /** Task-start id bound to the current assignment, when one exists. */
  expectedTaskStartId?: string;
  /** Message ids already accepted (in-memory dedupe; receipts do the rest). */
  seenMessageIds?: ReadonlySet<string>;
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

/** Stable bytes an HMAC covers; auth itself is excluded. */
export function signedBytes(
  envelope: Omit<ControlEnvelope, "auth">,
): string {
  return canonical({
    version: envelope.version,
    messageId: envelope.messageId,
    seq: envelope.seq,
    type: envelope.type,
    runId: envelope.runId,
    taskId: envelope.taskId,
    attemptId: envelope.attemptId,
    sessionId: envelope.sessionId,
    generation: envelope.generation,
    leaseGeneration: envelope.leaseGeneration,
    taskStartId: envelope.taskStartId ?? null,
    sentAt: envelope.sentAt,
    payload: envelope.payload,
  });
}

export function createControlSecret(): string {
  return randomBytes(32).toString("base64url");
}

export function signMessage(input: {
  secret: string;
  message: Omit<ControlEnvelope, "auth">;
}): ControlResult<string> {
  if (Buffer.byteLength(input.secret, "utf8") < MIN_SECRET_BYTES) {
    return { ok: false, code: "auth", error: "control secret is too short" };
  }
  return {
    ok: true,
    value: createHmac("sha256", input.secret).update(signedBytes(input.message), "utf8").digest("hex"),
  };
}

export function sealMessage(input: {
  secret: string;
  message: Omit<ControlEnvelope, "auth">;
}): ControlResult<ControlEnvelope> {
  const mac = signMessage(input);
  if (!mac.ok) return mac;
  const envelope: ControlEnvelope = {
    ...input.message,
    auth: { scheme: AUTH_SCHEME, mac: mac.value },
  };
  const size = Buffer.byteLength(JSON.stringify(envelope), "utf8");
  if (size > MAX_MESSAGE_BYTES) {
    return { ok: false, code: "oversized", error: `message exceeds ${MAX_MESSAGE_BYTES} bytes` };
  }
  return { ok: true, value: envelope };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function shortString(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

function macMatches(expected: string, actual: string): boolean {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(actual, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Validates one inbound message. Forged, stale, reordered, duplicate or
 * oversized messages fail closed; the caller must not act on anything else.
 */
export function openMessage(raw: unknown, ctx: ValidationContext): ControlResult<ControlEnvelope> {
  const text = typeof raw === "string" ? raw : JSON.stringify(raw);
  if (Buffer.byteLength(text, "utf8") > MAX_MESSAGE_BYTES) {
    return { ok: false, code: "oversized", error: "message is too large" };
  }
  let parsed: unknown;
  try {
    parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return { ok: false, code: "malformed", error: "message is not JSON" };
  }
  if (!isRecord(parsed)) return { ok: false, code: "malformed", error: "message must be an object" };
  if (parsed.version !== CONTROL_PROTOCOL_VERSION) {
    return { ok: false, code: "version", error: `unsupported protocol version ${String(parsed.version)}` };
  }
  if (
    !shortString(parsed.messageId, MAX_MESSAGE_ID_CHARS) ||
    typeof parsed.seq !== "number" ||
    !Number.isInteger(parsed.seq) ||
    parsed.seq < 1
  ) {
    return { ok: false, code: "malformed", error: "invalid message id/sequence" };
  }
  if (!(MESSAGE_TYPES as readonly unknown[]).includes(parsed.type)) {
    return { ok: false, code: "unsupported", error: "unknown message type" };
  }
  for (const field of ["runId", "taskId", "attemptId", "sessionId"] as const) {
    if (!shortString(parsed[field], 400)) {
      return { ok: false, code: "malformed", error: `invalid ${field}` };
    }
  }
  if (
    !Number.isInteger(parsed.generation) ||
    !Number.isInteger(parsed.leaseGeneration) ||
    !Number.isInteger(parsed.sentAt)
  ) {
    return { ok: false, code: "malformed", error: "invalid generation/timestamp" };
  }
  if (parsed.taskStartId !== undefined && !shortString(parsed.taskStartId, MAX_TASK_START_ID_CHARS)) {
    return { ok: false, code: "malformed", error: "invalid taskStartId" };
  }
  const auth = isRecord(parsed.auth) ? parsed.auth : null;
  if (!auth || auth.scheme !== AUTH_SCHEME || !shortString(auth.mac, 200)) {
    return { ok: false, code: "auth", error: "missing authentication" };
  }
  // Construct from validated fields instead of an unchecked object cast: every
  // value here was checked above, and the MAC below verifies the whole shape.
  const envelope: ControlEnvelope = {
    version: CONTROL_PROTOCOL_VERSION,
    messageId: parsed.messageId as string,
    seq: parsed.seq as number,
    type: parsed.type as MessageType,
    runId: parsed.runId as string,
    taskId: parsed.taskId as string,
    attemptId: parsed.attemptId as string,
    sessionId: parsed.sessionId as string,
    generation: parsed.generation as number,
    leaseGeneration: parsed.leaseGeneration as number,
    ...(typeof parsed.taskStartId === "string" ? { taskStartId: parsed.taskStartId } : {}),
    sentAt: parsed.sentAt as number,
    payload: parsed.payload,
    auth: { scheme: AUTH_SCHEME, mac: auth.mac as string },
  };
  const { auth: _auth, ...unsigned } = envelope;
  const expected = signMessage({ secret: ctx.secret, message: unsigned as never });
  if (!expected.ok) return expected;
  if (!macMatches(expected.value, auth.mac)) {
    return { ok: false, code: "auth", error: "message authentication failed" };
  }

  if (envelope.runId !== ctx.runId) {
    return { ok: false, code: "mismatch", error: "message belongs to a different run" };
  }
  if (envelope.taskId !== ctx.taskId || envelope.attemptId !== ctx.attemptId) {
    return { ok: false, code: "mismatch", error: "message belongs to a different task/attempt" };
  }
  if (envelope.sessionId !== ctx.sessionId) {
    return { ok: false, code: "mismatch", error: "message belongs to a different session" };
  }
  if (envelope.generation < ctx.generation) {
    return { ok: false, code: "stale", error: "stale attempt generation" };
  }
  if (envelope.generation > ctx.generation) {
    return { ok: false, code: "reordered", error: "message is from a future generation" };
  }
  if (envelope.leaseGeneration !== ctx.leaseGeneration) {
    return { ok: false, code: "stale", error: "message names a different lease generation" };
  }
  if (ctx.lastSeq !== undefined && envelope.seq <= ctx.lastSeq) {
    return { ok: false, code: "reordered", error: "message sequence did not advance" };
  }
  if (ctx.seenMessageIds?.has(envelope.messageId)) {
    return { ok: false, code: "duplicate", error: "message was already accepted" };
  }
  if (envelope.type === "start-ack" || envelope.type === "quiescent" || envelope.type === "candidate") {
    if (!envelope.taskStartId || envelope.taskStartId !== ctx.expectedTaskStartId) {
      return { ok: false, code: "mismatch", error: "message is not bound to the current task start" };
    }
  }
  return { ok: true, value: envelope };
}

/** Mutation is authorized only for a verified start/repair at the current lease. */
export function authorizesMutation(
  message: ControlEnvelope,
  ctx: Pick<ValidationContext, "leaseGeneration" | "expectedTaskStartId">,
): boolean {
  if (!MUTATING_MESSAGE_TYPES.has(message.type)) return false;
  if (message.leaseGeneration !== ctx.leaseGeneration) return false;
  if (message.type === "start") {
    return !!message.taskStartId && message.taskStartId === ctx.expectedTaskStartId;
  }
  return true;
}

// ── Durable receipts (outbox) ────────────────────────────────────────

export type ReceiptStatus = "pending" | "delivered" | "acked";

export interface OutboxEntry {
  message: ControlEnvelope;
  status: ReceiptStatus;
  createdSeq: number;
  taskStartId?: string;
}

export interface ReceiptState {
  version: 1;
  nextOrdinal: number;
  entries: Record<string, OutboxEntry>;
  /** taskStartId → messageId, so a duplicate kickoff is impossible. */
  starts: Record<string, string>;
}

export interface ReceiptIo {
  load(runId: string): Promise<ReceiptState | null>;
  save(runId: string, state: ReceiptState): Promise<void>;
}

export const MAX_RECEIPTS = 500;

export function emptyReceipts(): ReceiptState {
  return { version: 1, nextOrdinal: 1, entries: {}, starts: {} };
}

export interface Outbox {
  state(): ReceiptState;
  /** Idempotent: an existing message id/start id is never queued twice. */
  enqueue(message: ControlEnvelope): { ok: true; duplicate: boolean } | { ok: false; error: string };
  ack(messageId: string): Promise<boolean>;
  markDelivered(messageId: string): boolean;
  pending(): OutboxEntry[];
  persist(): Promise<void>;
  /** Sends every un-acked entry once; a failed send stays pending. */
  flush(send: (raw: string) => Promise<void>): Promise<{ sent: number; failed: number }>;
}

export function createOutbox(input: { runId: string; io: ReceiptIo; max?: number }): Promise<Outbox> {
  const max = input.max ?? MAX_RECEIPTS;
  return (async () => {
    let state = (await input.io.load(input.runId)) ?? emptyReceipts();
    if (state.version !== 1) state = emptyReceipts();
    const outbox: Outbox = {
      state: () => state,
      enqueue(message) {
        if (state.entries[message.messageId]) return { ok: true, duplicate: true };
        if (message.taskStartId) {
          const existing = state.starts[message.taskStartId];
          if (existing && existing !== message.messageId) {
            return { ok: false, error: "a different message already claimed this task start" };
          }
        }
        if (Object.keys(state.entries).length >= max) {
          return { ok: false, error: "outbox is full; acknowledge pending receipts first" };
        }
        state.entries[message.messageId] = {
          message,
          status: "pending",
          createdSeq: state.nextOrdinal++,
          ...(message.taskStartId ? { taskStartId: message.taskStartId } : {}),
        };
        if (message.taskStartId) state.starts[message.taskStartId] = message.messageId;
        return { ok: true, duplicate: false };
      },
      async ack(messageId) {
        const entry = state.entries[messageId];
        if (!entry) return false;
        entry.status = "acked";
        await outbox.persist();
        return true;
      },
      markDelivered(messageId) {
        const entry = state.entries[messageId];
        if (!entry || entry.status !== "pending") return false;
        entry.status = "delivered";
        return true;
      },
      pending() {
        return Object.values(state.entries)
          .filter((entry) => entry.status !== "acked")
          .sort((left, right) => left.createdSeq - right.createdSeq);
      },
      async persist() {
        await input.io.save(input.runId, state);
      },
      async flush(send) {
        let sent = 0;
        let failed = 0;
        for (const entry of outbox.pending()) {
          try {
            await send(JSON.stringify(entry.message));
            entry.status = entry.status === "pending" ? "delivered" : entry.status;
            sent += 1;
          } catch {
            failed += 1;
          }
        }
        if (sent > 0) await outbox.persist();
        return { sent, failed };
      },
    };
    return outbox;
  })();
}

// ── Local endpoint ───────────────────────────────────────────────────

export interface EndpointSpec {
  kind: "named-pipe" | "unix-socket";
  path: string;
  /** The directory must be profile-owned and private (0700). */
  privateDir: string;
}

export function localEndpoint(input: {
  platform: NodeJS.Platform;
  profileDir: string;
  runId: string;
}): ControlResult<EndpointSpec> {
  if (!input.runId || /[^A-Za-z0-9._-]/.test(input.runId)) {
    return { ok: false, code: "malformed", error: "run id must be a simple token" };
  }
  const privateDir = `${input.profileDir.replace(/[\\/]+$/, "")}/workflow/ipc`;
  if (input.platform === "win32") {
    return {
      ok: true,
      value: {
        kind: "named-pipe",
        path: `\\\\.\\pipe\\pi-workflow-${input.runId}`,
        privateDir,
      },
    };
  }
  return {
    ok: true,
    value: { kind: "unix-socket", path: `${privateDir}/${input.runId}.sock`, privateDir },
  };
}

/** Refuse a directory that is not private (mode 0700), when a stat is supplied. */
export function endpointDirIsPrivate(stat: { mode: number } | null): boolean {
  if (!stat) return false;
  // Mask to the permission bits; group/other must have no access.
  return (stat.mode & 0o077) === 0;
}
