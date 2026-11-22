/**
 * Workflow Extension — run control authority (integration steps 13/17).
 *
 * This is the missing bridge between the durable decisions in
 * `orchestrator-ipc.ts` and the pipe in `orchestrator-ipc-node.ts`:
 *
 *   parent: prepare a private grant → start the endpoint → on `ready` deliver
 *           exactly one sealed `start` → record the `start-ack`
 *   child:  read the grant → connect → `ready` → validate the `start` → let the
 *           runtime authorize → `start-ack` → send reports/progress
 *
 * Properties that matter more than the happy path:
 *   - the secret never appears in argv, prompts, bootstrap entries or logs; it
 *     lives in a 0600 file inside the private IPC directory, and only its path
 *     is written into the child's session metadata;
 *   - a forged/stale/reordered/duplicate frame is refused by `openMessage`
 *     before any callback runs;
 *   - a delivered-but-unacknowledged start is `uncertain`, never "failed" and
 *     never retried blindly;
 *   - no start is delivered twice for the same grant.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import {
  createControlClient,
  createControlServer,
  type ControlClient,
  type ControlServer,
} from "./orchestrator-ipc-node.ts";
import {
  CONTROL_PROTOCOL_VERSION,
  createControlSecret,
  localEndpoint,
  openMessage,
  sealMessage,
  type ControlEnvelope,
  type EndpointSpec,
  type MessageType,
  type ValidationContext,
} from "./orchestrator-ipc.ts";

export const RUN_CONTROL_SCHEMA_VERSION = 1 as const;
export const MAX_GRANTS = 8;
const DEFAULT_START_TIMEOUT_MS = 30_000;
const DEFAULT_SEND_TIMEOUT_MS = 10_000;

export interface WorkerGrant {
  version: typeof RUN_CONTROL_SCHEMA_VERSION;
  runId: string;
  taskId: string;
  attemptId: string;
  sessionId: string;
  /** Attempt/session generation. */
  generation: number;
  /** Workspace lease generation, allocated durably by the parent. */
  leaseGeneration: number;
  taskStartId: string;
  endpoint: EndpointSpec;
  /** Shared HMAC secret. Never printed, never placed in argv/prompts. */
  secret: string;
}

export type GrantFileResult =
  | { ok: true; value: WorkerGrant }
  | { ok: false; error: string };

/** `<profile>/workflow/ipc/<runId>/grants/<sessionId>.json` */
export function grantFileFor(profileDir: string, runId: string, sessionId: string): string {
  const safeRun = runId.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80);
  const safeSession = sessionId.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120);
  return path.join(profileDir, "workflow", "ipc", safeRun, "grants", `${safeSession}.json`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function writeWorkerGrant(file: string, grant: WorkerGrant): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(grant), { encoding: "utf8", mode: 0o600 });
}

export function readWorkerGrant(file: string): GrantFileResult {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return { ok: false, error: "the control grant is missing or unreadable" };
  }
  if (!isRecord(raw)) return { ok: false, error: "the control grant is malformed" };
  if (raw.version !== RUN_CONTROL_SCHEMA_VERSION) {
    return { ok: false, error: "the control grant version is unsupported" };
  }
  const endpoint = isRecord(raw.endpoint) ? raw.endpoint : null;
  if (
    !endpoint ||
    (endpoint.kind !== "named-pipe" && endpoint.kind !== "unix-socket") ||
    typeof endpoint.path !== "string" ||
    typeof endpoint.privateDir !== "string"
  ) {
    return { ok: false, error: "the control grant endpoint is malformed" };
  }
  for (const key of ["runId", "taskId", "attemptId", "sessionId", "taskStartId", "secret"] as const) {
    if (typeof raw[key] !== "string" || (raw[key] as string).length === 0) {
      return { ok: false, error: `the control grant is missing ${key}` };
    }
  }
  if (
    !Number.isInteger(raw.generation) ||
    (raw.generation as number) < 1 ||
    !Number.isInteger(raw.leaseGeneration) ||
    (raw.leaseGeneration as number) < 1
  ) {
    return { ok: false, error: "the control grant generation is invalid" };
  }
  return {
    ok: true,
    value: {
      version: RUN_CONTROL_SCHEMA_VERSION,
      runId: raw.runId as string,
      taskId: raw.taskId as string,
      attemptId: raw.attemptId as string,
      sessionId: raw.sessionId as string,
      generation: raw.generation as number,
      leaseGeneration: raw.leaseGeneration as number,
      taskStartId: raw.taskStartId as string,
      endpoint: {
        kind: endpoint.kind as EndpointSpec["kind"],
        path: endpoint.path,
        privateDir: endpoint.privateDir,
      },
      secret: raw.secret as string,
    },
  };
}

function ctxFor(grant: WorkerGrant, lastSeq?: number, seen?: ReadonlySet<string>): ValidationContext {
  return {
    secret: grant.secret,
    runId: grant.runId,
    taskId: grant.taskId,
    attemptId: grant.attemptId,
    sessionId: grant.sessionId,
    generation: grant.generation,
    leaseGeneration: grant.leaseGeneration,
    expectedTaskStartId: grant.taskStartId,
    ...(lastSeq === undefined ? {} : { lastSeq }),
    ...(seen === undefined ? {} : { seenMessageIds: seen }),
  };
}

/** One envelope, sealed for a grant. */
function sealFor(
  grant: WorkerGrant,
  input: {
    type: MessageType;
    seq: number;
    payload: unknown;
    at: number;
    taskStartId?: string;
  },
) {
  return sealMessage({
    secret: grant.secret,
    message: {
      version: CONTROL_PROTOCOL_VERSION,
      messageId: `${input.type}-${grant.sessionId}-${input.seq}`,
      seq: input.seq,
      type: input.type,
      runId: grant.runId,
      taskId: grant.taskId,
      attemptId: grant.attemptId,
      sessionId: grant.sessionId,
      generation: grant.generation,
      leaseGeneration: grant.leaseGeneration,
      ...(input.taskStartId === undefined ? {} : { taskStartId: input.taskStartId }),
      sentAt: input.at,
      payload: input.payload,
    },
  });
}

// ── Parent side ──────────────────────────────────────────────────────

export type StartWait =
  | { ok: true; acknowledged: true }
  | { ok: false; error: string; delivered: boolean; uncertain: boolean };

interface SessionState {
  grant: WorkerGrant;
  lastSeq?: number;
  outSeq: number;
  /** Per-socket writer captured from the child's latest frame. */
  writer?: (response: unknown) => void;
  delivered: boolean;
  acknowledged: boolean;
  waiter?: {
    resolve: (value: StartWait) => void;
    timer: ReturnType<typeof setTimeout>;
  };
}

export interface RunControl {
  endpoint(): EndpointSpec;
  start(): Promise<{ ok: true } | { ok: false; error: string }>;
  stop(): Promise<void>;
  /** Writes the grant and arms the one-start window for this attempt. */
  prepareGrant(input: {
    taskId: string;
    attemptId: string;
    sessionId: string;
    generation: number;
    taskStartId: string;
  }): Promise<{ ok: true; grant: WorkerGrant; grantRef: string } | { ok: false; error: string }>;
  /** Resolves after the child acknowledges, or with `uncertain` after delivery. */
  awaitStart(input: { sessionId: string; timeoutMs?: number }): Promise<StartWait>;
  /** Post-start control message (say/repair/pause/close). */
  request(type: MessageType, payload: unknown, input: { sessionId: string; timeoutMs?: number }): Promise<boolean>;
  grant(sessionId: string): WorkerGrant | undefined;
  connections(): number;
}

export function createRunControl(options: {
  profileDir: string;
  runId: string;
  platform?: NodeJS.Platform;
  now?: () => number;
  onEvent?: (event: ControlEnvelope) => void | Promise<void>;
  onError?: (error: unknown) => void;
}): RunControl {
  const now = options.now ?? (() => Date.now());
  const endpointResult = localEndpoint({
    platform: options.platform ?? process.platform,
    profileDir: options.profileDir,
    runId: options.runId,
  });
  if (!endpointResult.ok) {
    throw new Error(`control endpoint is invalid: ${endpointResult.error}`);
  }
  const endpoint = endpointResult.value;
  const sessions = new Map<string, SessionState>();
  const seen = new Set<string>();
  let server: ControlServer | undefined;
  let starting = false;

  const settle = (state: SessionState, value: StartWait) => {
    const waiter = state.waiter;
    if (!waiter) return;
    clearTimeout(waiter.timer);
    state.waiter = undefined;
    waiter.resolve(value);
  };

  const write = async (state: SessionState, response: unknown): Promise<boolean> => {
    const writer = state.writer;
    if (!writer) return false;
    try {
      writer(response);
      return true;
    } catch {
      return false;
    }
  };

  const deliverStart = async (state: SessionState, requestId: string): Promise<boolean> => {
    const seq = state.outSeq + 1;
    const sealed = sealFor(state.grant, {
      type: "start",
      seq,
      payload: {
        leaseGeneration: state.grant.leaseGeneration,
        taskStartId: state.grant.taskStartId,
      },
      at: now(),
      taskStartId: state.grant.taskStartId,
    });
    if (!sealed.ok) return false;
    state.outSeq = seq;
    const sent = await write(state, { requestId, ...sealed.value });
    state.delivered = sent;
    return sent;
  };

  const validate = (
    raw: unknown,
  ): { ok: true; state: SessionState; envelope: ControlEnvelope } | { ok: false; error: string } => {
    let firstError = "";
    for (const state of sessions.values()) {
      const opened = openMessage(raw, ctxFor(state.grant, state.lastSeq, seen));
      if (opened.ok) return { ok: true, state, envelope: opened.value };
      if (!firstError) firstError = opened.error;
    }
    return { ok: false, error: firstError || "no active control grant" };
  };

  const onMessage = async (raw: unknown, reply: (response: unknown) => void): Promise<void> => {
    const requestId = isRecord(raw) && typeof raw.requestId === "string" ? raw.requestId : "";
    const checked = validate(raw);
    if (!checked.ok) {
      reply({ requestId, ok: false, error: checked.error });
      return;
    }
    const { state, envelope } = checked;
    state.writer = reply;
    if (envelope.type === "ready") {
      if (state.delivered) {
        reply({ requestId, ok: true, alreadyDelivered: true });
        return;
      }
      const delivered = await deliverStart(state, requestId);
      if (!delivered) {
        reply({ requestId, ok: false, error: "the start could not be delivered" });
      }
      // When delivered, the sealed start envelope IS the reply.
      return;
    }
    state.lastSeq = envelope.seq;
    seen.add(envelope.messageId);
    if (envelope.type === "start-ack") {
      state.acknowledged = true;
      settle(state, { ok: true, acknowledged: true });
      reply({ requestId, ok: true });
      return;
    }
    try {
      await options.onEvent?.(envelope);
      reply({ requestId, ok: true });
    } catch (error: unknown) {
      reply({
        requestId,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const control: RunControl = {
    endpoint: () => endpoint,
    async start() {
      if (starting || server) return { ok: true };
      starting = true;
      try {
        if (endpoint.kind === "unix-socket") {
          fs.mkdirSync(endpoint.privateDir, { recursive: true, mode: 0o700 });
        }
        server = createControlServer({
          endpoint,
          onMessage,
          onError: (error) => options.onError?.(error),
        });
        await server.start();
        return { ok: true };
      } catch (error: unknown) {
        server = undefined;
        return {
          ok: false,
          error: `the control endpoint could not be started: ${
            error instanceof Error ? error.message : String(error)
          }`,
        };
      } finally {
        starting = false;
      }
    },
    async stop() {
      for (const state of sessions.values()) {
        settle(state, {
          ok: false,
          error: "the run control endpoint was stopped",
          delivered: state.delivered,
          uncertain: state.delivered,
        });
      }
      const active = server;
      server = undefined;
      if (active) await active.stop();
    },
    async prepareGrant(input) {
      if (!input.sessionId) return { ok: false, error: "a session id is required" };
      if (sessions.size >= MAX_GRANTS && !sessions.has(input.sessionId)) {
        return { ok: false, error: "too many active grants; close an attempt first" };
      }
      const grant: WorkerGrant = {
        version: RUN_CONTROL_SCHEMA_VERSION,
        runId: options.runId,
        taskId: input.taskId,
        attemptId: input.attemptId,
        sessionId: input.sessionId,
        generation: input.generation,
        leaseGeneration: input.generation,
        taskStartId: input.taskStartId,
        endpoint,
        secret: createControlSecret(),
      };
      const grantRef = grantFileFor(options.profileDir, options.runId, input.sessionId);
      try {
        writeWorkerGrant(grantRef, grant);
      } catch (error: unknown) {
        return {
          ok: false,
          error: `the control grant could not be written: ${
            error instanceof Error ? error.message : String(error)
          }`,
        };
      }
      sessions.set(input.sessionId, {
        grant,
        outSeq: 0,
        delivered: false,
        acknowledged: false,
      });
      return { ok: true, grant, grantRef };
    },
    async awaitStart(input) {
      const state = sessions.get(input.sessionId);
      if (!state) {
        return { ok: false, error: "no grant is prepared for this session", delivered: false, uncertain: false };
      }
      if (state.acknowledged) return { ok: true, acknowledged: true };
      const timeoutMs = input.timeoutMs ?? DEFAULT_START_TIMEOUT_MS;
      return new Promise<StartWait>((resolve) => {
        const timer = setTimeout(() => {
          state.waiter = undefined;
          resolve({
            ok: false,
            error: state.delivered
              ? "the start was delivered but the child did not acknowledge it"
              : "the child never connected to the control endpoint",
            delivered: state.delivered,
            uncertain: state.delivered,
          });
        }, timeoutMs);
        // A non-awaited start wait must not keep the parent process alive.
        // SAFETY: Node's Timeout has unref(); the shared timer type omits it.
        (timer as unknown as { unref?: () => void }).unref?.();
        state.waiter = { resolve, timer };
      });
    },
    async request(type, payload, input) {
      const state = sessions.get(input.sessionId);
      if (!state || !state.writer) return false;
      const seq = state.outSeq + 1;
      const sealed = sealFor(state.grant, {
        type,
        seq,
        payload,
        at: now(),
        taskStartId: state.grant.taskStartId,
      });
      if (!sealed.ok) return false;
      state.outSeq = seq;
      return await write(state, { requestId: `post-${seq}`, ...sealed.value });
    },
    grant: (sessionId) => sessions.get(sessionId)?.grant,
    connections: () => server?.connections() ?? 0,
  };

  return control;
}

// ── Child side ───────────────────────────────────────────────────────

export interface ChildControl {
  /** Connect, request the start grant, authorize, acknowledge, then return. */
  start(): Promise<{ ok: true } | { ok: false; error: string }>;
  send(type: MessageType, payload: unknown, timeoutMs?: number): Promise<boolean>;
  close(): void;
  status(): { connected: boolean; authorized: boolean };
}

export function createChildControl(options: {
  grant: WorkerGrant;
  /**
   * Called with the validated start grant. The child must authorize its worker
   * runtime here; returning false means "not ready" and NO acknowledgement is
   * sent (the parent then reconciles an uncertain start).
   */
  onStart: (grant: WorkerGrant) => Promise<boolean> | boolean;
  onSay?: (text: string) => Promise<void> | void;
  now?: () => number;
  connectTimeoutMs?: number;
}): ChildControl {
  const now = options.now ?? (() => Date.now());
  let client: ControlClient | undefined;
  let seq = 0;
  let authorized = false;

  const envelope = (type: MessageType, payload: unknown, taskStartId?: string) => {
    const grant = options.grant;
    seq += 1;
    return {
      version: CONTROL_PROTOCOL_VERSION,
      messageId: `${type}-${grant.sessionId}-${seq}`,
      seq,
      type,
      runId: grant.runId,
      taskId: grant.taskId,
      attemptId: grant.attemptId,
      sessionId: grant.sessionId,
      generation: grant.generation,
      leaseGeneration: grant.leaseGeneration,
      ...(taskStartId === undefined ? {} : { taskStartId }),
      sentAt: now(),
      payload,
    };
  };

  const control: ChildControl = {
    async start() {
      client = createControlClient({
        endpoint: options.grant.endpoint,
        ...(options.connectTimeoutMs === undefined
          ? {}
          : { connectTimeoutMs: options.connectTimeoutMs }),
        // Post-start pushes (say/pause/close) are not replies to a request.
        onMessage: (frame) => {
          const opened = openMessage(frame, ctxFor(options.grant));
          if (!opened.ok || opened.value.type !== "say") return;
          const payload = opened.value.payload;
          const text =
            payload && typeof payload === "object" && typeof (payload as { text?: unknown }).text === "string"
              ? (payload as { text: string }).text.slice(0, 2_000)
              : "";
          if (text) void options.onSay?.(text);
        },
      });
      try {
        const ready = sealMessage({
          secret: options.grant.secret,
          message: envelope("ready", { pid: process.pid }),
        });
        if (!ready.ok) return { ok: false, error: ready.error };
        const reply = await client.request(
          { requestId: ready.value.messageId, ...ready.value },
          30_000,
        );
        const opened = openMessage(reply, ctxFor(options.grant));
        if (!opened.ok) {
          return { ok: false, error: `the start grant was refused: ${opened.error}` };
        }
        if (opened.value.type !== "start") {
          return { ok: false, error: `unexpected control reply ${opened.value.type}` };
        }
        if (opened.value.taskStartId !== options.grant.taskStartId) {
          return { ok: false, error: "the start grant names a different task start" };
        }
        authorized = await options.onStart(options.grant);
        if (!authorized) {
          return { ok: false, error: "the worker runtime refused the start grant" };
        }
        const ack = sealMessage({
          secret: options.grant.secret,
          message: envelope("start-ack", { runtimeReady: true }, options.grant.taskStartId),
        });
        if (!ack.ok) return { ok: false, error: ack.error };
        await client.request({ requestId: ack.value.messageId, ...ack.value }, 10_000);
        return { ok: true };
      } catch (error: unknown) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },

    async send(type, payload, timeoutMs = DEFAULT_SEND_TIMEOUT_MS) {
      if (!client) return false;
      const sealed = sealMessage({
        secret: options.grant.secret,
        message: envelope(type, payload, options.grant.taskStartId),
      });
      if (!sealed.ok) return false;
      try {
        await client.request({ requestId: sealed.value.messageId, ...sealed.value }, timeoutMs);
        return true;
      } catch {
        return false;
      }
    },

    close() {
      client?.close();
      client = undefined;
      authorized = false;
    },

    status: () => ({ connected: client?.status().connected ?? false, authorized }),
  };

  return control;
}
