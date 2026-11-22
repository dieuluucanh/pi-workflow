/**
 * Workflow Extension — local control transport (integration step 10).
 *
 * `orchestrator-ipc.ts` owns the *decisions*: envelope shape, HMAC sealing,
 * replay/reorder checks, mutation authorization and the durable outbox. This
 * module owns the *pipe*: a bounded, newline-framed local socket (Windows named
 * pipe / POSIX unix socket) with deadlines, reconnects and explicit status.
 *
 * It deliberately performs no authentication itself — the caller must run every
 * inbound frame through `openMessage()` and every outbound one through
 * `sealMessage()`. That keeps one authority path and makes this transport
 * useless on its own if someone forgets the envelope.
 */

import * as net from "node:net";

import {
  MAX_MESSAGE_BYTES,
  type EndpointSpec,
} from "./orchestrator-ipc.ts";

export interface FrameLimits {
  /** Hard per-frame cap. A larger frame closes the connection. */
  maxBytes: number;
}

const DEFAULT_LIMITS: FrameLimits = { maxBytes: MAX_MESSAGE_BYTES };
const DEFAULT_CONNECT_TIMEOUT_MS = 5_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;

export type Reply = (response: unknown) => void;

export interface ControlServer {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Live client count, for status/debug rows. */
  connections(): number;
}

export interface ControlServerOptions {
  endpoint: EndpointSpec;
  /** One validated frame. Responses are framed back to that client. */
  onMessage(raw: unknown, reply: Reply): void | Promise<void>;
  onError?(error: unknown): void;
  limits?: Partial<FrameLimits>;
}

export interface ControlClient {
  /** Sends one frame and resolves with the correlated reply. */
  request(message: { requestId: string } & Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
  close(): void;
  status(): { connected: boolean; detail?: string };
}

export interface ControlClientOptions {
  endpoint: EndpointSpec;
  connectTimeoutMs?: number;
  limits?: Partial<FrameLimits>;
  onStatus?(status: { connected: boolean; detail?: string }): void;
  /**
   * A validated-shape frame that is not a reply to a pending request (the
   * parent pushes say/repair/pause after the start handshake). The caller must
   * still authenticate it with `openMessage`.
   */
  onMessage?(frame: unknown): void;
}

function frame(value: unknown, limits: FrameLimits): Buffer {
  const text = JSON.stringify(value);
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes + 1 > limits.maxBytes) {
    throw new Error(`control frame is too large (${bytes} bytes)`);
  }
  return Buffer.from(`${text}\n`, "utf8");
}

/** Split a stream into complete lines, failing closed on an oversized frame. */
function lineReader(
  onLine: (text: string) => void,
  onError: (error: Error) => void,
  limits: FrameLimits,
): (chunk: Buffer) => void {
  let buffer = "";
  return (chunk) => {
    buffer += chunk.toString("utf8");
    if (Buffer.byteLength(buffer, "utf8") > limits.maxBytes) {
      buffer = "";
      onError(new Error("control frame exceeds the size limit"));
      return;
    }
    for (;;) {
      const index = buffer.indexOf("\n");
      if (index < 0) return;
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (!line.trim()) continue;
      try {
        onLine(line);
      } catch (error) {
        onError(error instanceof Error ? error : new Error(String(error)));
      }
    }
  };
}

export function createControlServer(options: ControlServerOptions): ControlServer {
  const limits: FrameLimits = { ...DEFAULT_LIMITS, ...options.limits };
  const sockets = new Set<net.Socket>();
  let server: net.Server | undefined;
  const report = (error: unknown): void => {
    try {
      options.onError?.(error);
    } catch {
      /* diagnostics must never break the transport */
    }
  };

  return {
    async start() {
      if (server) return;
      const created = net.createServer((socket) => {
        sockets.add(socket);
        socket.on("close", () => sockets.delete(socket));
        socket.on("error", (error) => report(error));
        socket.on(
          "data",
          lineReader(
            (line) => {
              let parsed: unknown;
              try {
                parsed = JSON.parse(line);
              } catch {
                report(new Error("control frame is not valid JSON"));
                return;
              }
              void Promise.resolve(options.onMessage(parsed, (response) => {
                if (socket.destroyed) return;
                try {
                  socket.write(frame(response, limits));
                } catch (error) {
                  report(error);
                }
              })).catch((error) => report(error));
            },
            (error) => {
              report(error);
              socket.destroy();
            },
            limits,
          ),
        );
      });
      server = created;
      await new Promise<void>((resolve, reject) => {
        created.once("error", reject);
        created.listen(options.endpoint.path, () => {
          created.removeListener("error", reject);
          resolve();
        });
      });
    },

    async stop() {
      const active = server;
      server = undefined;
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      if (!active) return;
      await new Promise<void>((resolve) => active.close(() => resolve()));
    },

    connections: () => sockets.size,
  };
}

export function createControlClient(options: ControlClientOptions): ControlClient {
  const limits: FrameLimits = { ...DEFAULT_LIMITS, ...options.limits };
  const connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  let socket: net.Socket | undefined;
  let connected = false;
  let detail: string | undefined;
  const pending = new Map<
    string,
    { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }
  >();

  const setStatus = (next: boolean, reason?: string): void => {
    connected = next;
    detail = reason;
    try {
      options.onStatus?.({ connected, ...(reason ? { detail: reason } : {}) });
    } catch {
      /* ignore */
    }
  };

  const failAll = (error: Error): void => {
    for (const [id, entry] of pending) {
      clearTimeout(entry.timer);
      pending.delete(id);
      entry.reject(error);
    }
  };

  const connect = async (): Promise<net.Socket> => {
    if (socket && connected) return socket;
    const next = net.createConnection({ path: options.endpoint.path });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        next.destroy();
        reject(new Error(`control endpoint did not accept a connection within ${connectTimeoutMs}ms`));
      }, connectTimeoutMs);
      next.once("connect", () => {
        clearTimeout(timer);
        resolve();
      });
      next.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
    next.setNoDelay(true);
    socket = next;
    setStatus(true);
    next.on("close", () => {
      setStatus(false, "the control connection closed");
      failAll(new Error("the control connection closed"));
    });
    next.on("error", (error) => {
      setStatus(false, error.message);
      failAll(error);
    });
    next.on(
      "data",
      lineReader(
        (line) => {
          let parsed: unknown;
          try {
            parsed = JSON.parse(line);
          } catch {
            return;
          }
          const record = parsed as { requestId?: unknown };
          const id = typeof record.requestId === "string" ? record.requestId : "";
          const entry = pending.get(id);
          if (!entry) {
            try {
              options.onMessage?.(parsed);
            } catch {
              /* a push handler must not break the transport */
            }
            return;
          }
          clearTimeout(entry.timer);
          pending.delete(id);
          entry.resolve(parsed);
        },
        (error) => {
          setStatus(false, error.message);
          failAll(error);
        },
        limits,
      ),
    );
    return next;
  };

  return {
    async request(message, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS) {
      const active = await connect();
      return new Promise<unknown>((resolve, reject) => {
        if (pending.has(message.requestId)) {
          reject(new Error(`a request with id ${message.requestId} is already pending`));
          return;
        }
        const timer = setTimeout(() => {
          pending.delete(message.requestId);
          reject(new Error(`control request ${message.requestId} timed out`));
        }, timeoutMs);
        pending.set(message.requestId, { resolve, reject, timer });
        try {
          active.write(frame(message, limits));
        } catch (error) {
          clearTimeout(timer);
          pending.delete(message.requestId);
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    },

    close() {
      failAll(new Error("the control client was closed"));
      socket?.destroy();
      socket = undefined;
      setStatus(false, "closed");
    },

    status: () => ({ connected, ...(detail ? { detail } : {}) }),
  };
}
