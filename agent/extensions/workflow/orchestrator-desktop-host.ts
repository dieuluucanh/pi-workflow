/**
 * Workflow Extension — Desktop session-host adapter (step 26).
 *
 * W's generic `SessionHostPort` over Desktop's related-session wire (step 12).
 * The adapter only opens/focuses a normal session tab; it never starts a turn.
 * After the Desktop host reports the child ready, the SAME step-24 protocol as
 * Terminal applies: journal the start intent, grant the lease, then send the
 * one correlated wake. A second bootstrap prompt is never used.
 *
 * Trust / behavior:
 *   - the host must announce capabilities (`session-host:hello`); without a
 *     source-bound, separate-window, bootstrap-before-start host every call
 *     returns `unsupported` and nothing is launched;
 *   - requests are idempotent by `requestId` and by `dedupeKey` at the host, so
 *     a retry attaches to the same tab instead of creating another;
 *   - results are bounded and validated; a late/unknown result is ignored;
 *   - cleanup only closes an unopened/idle resource this call created — never a
 *     reused/live child or the parent;
 *   - the module has no wake/sendMessage dependency at all.
 */

import type {
  RelatedSessionSpec,
  SessionHostCapabilities,
  SessionHostPort,
  SessionHostResult,
} from "./session-host.ts";
import { validateRelatedSessionSpec } from "./session-host.ts";

/** Mirror of Desktop's wire channels (step 12). */
export const DESKTOP_SESSION_CHANNELS = {
  probe: "session-host:probe",
  hello: "session-host:hello",
  request: "session-host:request",
  result: "session-host:result",
} as const;

export interface DesktopSessionBus {
  on(channel: string, handler: (payload: unknown) => unknown): () => void;
  emit(channel: string, payload?: unknown): void;
}

/** Opaque timer handle; only passed back to `clearTimeout`. */
export type DesktopTimerHandle = number | object;

export interface DesktopClock {
  setTimeout(callback: () => void, ms: number): DesktopTimerHandle;
  clearTimeout(handle: DesktopTimerHandle): void;
  now(): number;
}

export interface DesktopSessionHostOptions {
  bus: DesktopSessionBus;
  /** A registered command name that identifies this extension to the host. */
  ownerCommand: string;
  clock: DesktopClock;
  timeoutMs?: number;
  onError?(error: unknown): void;
}

export interface DesktopSessionHost extends SessionHostPort {
  /** Ask the host to announce support now (bind/rebind). */
  probe(): void;
  /** Forget pending requests and stop listening. */
  dispose(): void;
  /** The host's last announcement, if any. */
  announced(): SessionHostCapabilities | undefined;
  /**
   * Close a launch that failed/cancelled, only when this call created it and it
   * never started. A reused or started child is never closed.
   */
  cleanupOwned(input: { sessionRef: string; reused: boolean; taskStarted: boolean }): Promise<boolean>;
}

const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_SETTLED = 100;
const SETTLED_TTL_MS = 60_000;
const OWNER_COMMAND = /^[a-z0-9][a-z0-9-]{0,63}$/;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function bounded(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= max ? trimmed : undefined;
}

function capabilitiesFrom(raw: unknown): SessionHostCapabilities | null {
  const record = asRecord(raw);
  if (typeof record.version !== "number" || !Number.isFinite(record.version)) return null;
  const label = bounded(record.label, 80);
  if (!label) return null;
  const flag = (value: unknown): boolean => value === true;
  return {
    version: Math.trunc(record.version),
    create: flag(record.create),
    open: flag(record.open),
    focus: flag(record.focus),
    inspect: flag(record.inspect),
    interrupt: flag(record.interrupt),
    close: flag(record.close),
    separateWindow: flag(record.separateWindow),
    bootstrapBeforeStart: flag(record.bootstrapBeforeStart),
    label,
    ...(bounded(record.reason, 400) ? { reason: bounded(record.reason, 400) } : {}),
    // Desktop's source binding is the gate for every native operation.
    ...(record.sourceBound === false ? { reason: "host cannot verify the publisher" } : {}),
    ...(record.sourceBound !== true ? { create: false } : {}),
  };
}

function resultFrom(raw: unknown): SessionHostResult | null {
  const record = asRecord(raw);
  if (record.ok === true) {
    const sessionRef = bounded(record.sessionRef, 400);
    if (!sessionRef) return null;
    return {
      ok: true,
      sessionRef,
      focused: record.focused === true,
      reused: record.reused === true,
    };
  }
  if (record.ok === false) {
    const code = record.code;
    if (code !== "unsupported" && code !== "rejected" && code !== "failed" && code !== "cancelled") {
      return null;
    }
    const reason = bounded(record.reason, 400);
    if (!reason) return null;
    return { ok: false, code, reason };
  }
  return null;
}

export function createDesktopSessionHost(options: DesktopSessionHostOptions): DesktopSessionHost {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let announced: SessionHostCapabilities | undefined;
  let disposed = false;
  const offs: Array<() => void> = [];
  const pending = new Map<
    string,
    { finish(result: SessionHostResult): void; handle: DesktopTimerHandle }
  >();
  const settled = new Map<string, { at: number; result: SessionHostResult }>();

  if (!OWNER_COMMAND.test(options.ownerCommand)) {
    throw new Error("ownerCommand must be a registered command name");
  }

  const report = (error: unknown): void => {
    try {
      options.onError?.(error);
    } catch {
      /* diagnostics must not break the adapter */
    }
  };

  const remember = (requestId: string, result: SessionHostResult): void => {
    const at = options.clock.now();
    settled.set(requestId, { at, result });
    if (settled.size > MAX_SETTLED) {
      for (const [key, entry] of settled) {
        if (settled.size <= MAX_SETTLED) break;
        if (at - entry.at > SETTLED_TTL_MS || settled.size > MAX_SETTLED) settled.delete(key);
      }
    }
  };

  const finish = (requestId: string, result: SessionHostResult): void => {
    const entry = pending.get(requestId);
    if (!entry) return;
    pending.delete(requestId);
    try {
      options.clock.clearTimeout(entry.handle);
    } catch {
      /* a fake clock may not need clearing */
    }
    remember(requestId, result);
    entry.finish(result);
  };

  const request = (input: {
    requestId: string;
    operation: "create" | "open" | "focus" | "inspect" | "interrupt" | "close";
    spec?: RelatedSessionSpec;
    sessionRef?: string;
  }): Promise<SessionHostResult> => {
    if (disposed) {
      return Promise.resolve({ ok: false, code: "cancelled", reason: "the adapter is disposed" });
    }
    const previous = settled.get(input.requestId);
    if (previous && options.clock.now() - previous.at <= SETTLED_TTL_MS) {
      return Promise.resolve(previous.result);
    }
    if (pending.has(input.requestId)) {
      return new Promise((resolve) => {
        const entry = pending.get(input.requestId)!;
        const original = entry.finish;
        entry.finish = (result) => {
          original(result);
          resolve(result);
        };
      });
    }
    return new Promise((resolve) => {
      const handle = options.clock.setTimeout(() => {
        finish(input.requestId, {
          ok: false,
          code: "failed",
          reason: "the Desktop host did not answer the related-session request",
        });
      }, timeoutMs);
      pending.set(input.requestId, { finish: resolve, handle });
      try {
        options.bus.emit(DESKTOP_SESSION_CHANNELS.request, {
          requestId: input.requestId,
          operation: input.operation,
          ownerCommand: options.ownerCommand,
          ...(input.spec ? { spec: input.spec } : {}),
          ...(input.sessionRef ? { sessionRef: input.sessionRef } : {}),
        });
      } catch (error) {
        finish(input.requestId, {
          ok: false,
          code: "failed",
          reason: error instanceof Error ? error.message : "the request could not be sent",
        });
      }
    });
  };

  const unsupported = (reason: string): SessionHostResult => ({
    ok: false,
    code: "unsupported",
    reason,
  });

  const host: DesktopSessionHost = {
    probe() {
      try {
        options.bus.emit(DESKTOP_SESSION_CHANNELS.probe, {});
      } catch (error) {
        report(error);
      }
    },

    announced: () => announced,

    async capabilities() {
      if (!announced) {
        return {
          version: 1,
          create: false,
          open: false,
          focus: false,
          inspect: false,
          interrupt: false,
          close: false,
          separateWindow: false,
          bootstrapBeforeStart: false,
          label: "Pi Desktop",
          reason: "the Desktop host has not announced related-session support",
        };
      }
      return announced;
    },

    async createRelated(spec) {
      const parsed = validateRelatedSessionSpec(spec);
      if (!parsed.ok) return { ok: false, code: "rejected", reason: parsed.error };
      if (!announced) return unsupported("the Desktop host has not announced related-session support");
      if (!announced.create || !announced.separateWindow) {
        return unsupported(announced.reason ?? "this Desktop host cannot open a separate session tab");
      }
      if (!announced.bootstrapBeforeStart) {
        return unsupported("this Desktop host cannot apply the bootstrap before the session starts");
      }
      return request({ requestId: parsed.value.requestId, operation: "create", spec: parsed.value });
    },

    async open(sessionRef) {
      if (!announced) return unsupported("the Desktop host has not announced related-session support");
      if (!announced.open) return unsupported(announced.reason ?? "this host cannot open a session");
      return request({ requestId: `open-${sessionRef}`, operation: "open", sessionRef });
    },

    async focus(sessionRef) {
      if (!announced?.focus) return false;
      const result = await request({
        requestId: `focus-${sessionRef}`,
        operation: "focus",
        sessionRef,
      });
      return result.ok;
    },

    async inspect(sessionRef) {
      if (!announced?.inspect) return { ok: false, reason: "inspection is not supported" };
      const result = await request({
        requestId: `inspect-${sessionRef}`,
        operation: "inspect",
        sessionRef,
      });
      if (!result.ok) return { ok: false, reason: result.reason };
      return { ok: true, title: result.sessionRef, running: false };
    },

    async interrupt(sessionRef) {
      if (!announced?.interrupt) return false;
      const result = await request({
        requestId: `interrupt-${sessionRef}`,
        operation: "interrupt",
        sessionRef,
      });
      return result.ok;
    },

    async close(sessionRef) {
      if (!announced?.close) return false;
      const result = await request({
        requestId: `close-${sessionRef}`,
        operation: "close",
        sessionRef,
      });
      return result.ok;
    },

    async cleanupOwned(input) {
      if (input.reused) return false;
      if (input.taskStarted) return false;
      return host.close(input.sessionRef);
    },

    dispose() {
      disposed = true;
      for (const requestId of [...pending.keys()]) {
        finish(requestId, { ok: false, code: "cancelled", reason: "the adapter was disposed" });
      }
      for (const off of offs.splice(0)) {
        try {
          off();
        } catch (error) {
          report(error);
        }
      }
    },
  };

  try {
    offs.push(
      options.bus.on(DESKTOP_SESSION_CHANNELS.hello, (payload) => {
        const capabilities = capabilitiesFrom(payload);
        if (!capabilities) return undefined;
        announced = capabilities;
        return undefined;
      }),
    );
    offs.push(
      options.bus.on(DESKTOP_SESSION_CHANNELS.result, (payload) => {
        const record = asRecord(payload);
        const requestId = typeof record.requestId === "string" ? record.requestId : "";
        if (!requestId) return undefined;
        const result = resultFrom(record.result);
        if (!result) {
          finish(requestId, { ok: false, code: "rejected", reason: "invalid host result" });
          return undefined;
        }
        finish(requestId, result);
        return undefined;
      }),
    );
  } catch (error) {
    report(error);
  }

  return host;
}
