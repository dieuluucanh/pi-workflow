/**
 * Workflow Extension — host-issued bridge capability (integration step 1).
 *
 * The Pi event bus is `emit(channel, data)` / `on(channel, handler)`: it carries
 * no publisher identity. A payload naming an extension — or even naming a
 * genuinely registered command — therefore proves nothing about who sent it.
 *
 * This module defines the supported alternative. The HOST resolves an
 * extension's registered command through SDK `sourceInfo` and invokes that
 * command with a bounded, single-use grant. Only code reachable from that
 * registration ever sees the token, so attaching it to a privileged request is
 * evidence that the host itself handed authority to that registration.
 *
 * Properties:
 *   - a grant binds owner command + session + epoch and expires;
 *   - a missing, foreign, expired or replayed-with-different-authority grant
 *     fails closed with a reason, never a silent allow;
 *   - an extension keeps grants in memory only. They are never persisted,
 *     logged in prompts, passed in argv or exported with session data;
 *   - the extension side and the host side are both pure decision objects so
 *     ordering and replay can be tested without a bus or a desktop.
 *
 * Loaded extensions are trusted code in the same process; this seam is a
 * routing/provenance boundary, not a sandbox. Cross-process authority remains
 * the authenticated IPC envelope (HMAC + lease/start generations).
 */

export const BRIDGE_AUTH_VERSION = 1 as const;

export const BRIDGE_AUTH_LIMITS = {
  maxTokenChars: 256,
  maxOwnerCommandChars: 64,
  maxSessionChars: 200,
  maxGrantTtlMs: 30 * 60_000,
  maxLocalSeq: 1_000_000,
} as const;

/** Owner command names are lower-case kebab identifiers, as Pi registers them. */
export const OWNER_COMMAND_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** One host-issued grant, as delivered to a registered extension command. */
export interface BridgeGrant {
  version: typeof BRIDGE_AUTH_VERSION;
  /** Opaque single-use token minted by the host. */
  token: string;
  /** The registered command whose handler received this grant. */
  ownerCommand: string;
  /** Host session the grant is scoped to. */
  sessionId: string;
  /** Host epoch; a reload/rebind invalidates older grants. */
  epoch: number;
  issuedAt: number;
  expiresAt: number;
}

export type GrantErrorCode =
  | "absent"
  | "malformed"
  | "expired"
  | "owner_mismatch"
  | "session_mismatch"
  | "epoch_mismatch"
  | "unknown"
  | "replayed"
  | "exhausted";

export type GrantResult =
  | { ok: true; grant: BridgeGrant }
  | { ok: false; code: GrantErrorCode; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function boundedText(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= max ? trimmed : undefined;
}

/**
 * Validates a grant received from a host command argument.
 *
 * Returns the normalized grant or a reason. It never throws: a malformed host
 * payload is a refusal, not a crash in the middle of a command handler.
 */
export function parseBridgeGrant(raw: unknown, now = Date.now()): GrantResult {
  if (raw === undefined || raw === null) {
    return { ok: false, code: "absent", error: "no host capability grant" };
  }
  if (!isRecord(raw)) {
    return { ok: false, code: "malformed", error: "the host capability grant is not an object" };
  }
  if (raw.version !== BRIDGE_AUTH_VERSION) {
    return {
      ok: false,
      code: "malformed",
      error: `unsupported capability grant version ${String(raw.version)}`,
    };
  }
  const token = boundedText(raw.token, BRIDGE_AUTH_LIMITS.maxTokenChars);
  const ownerCommand = boundedText(raw.ownerCommand, BRIDGE_AUTH_LIMITS.maxOwnerCommandChars);
  const sessionId = boundedText(raw.sessionId, BRIDGE_AUTH_LIMITS.maxSessionChars);
  if (!token) return { ok: false, code: "malformed", error: "the grant has no usable token" };
  if (!ownerCommand || !OWNER_COMMAND_PATTERN.test(ownerCommand)) {
    return { ok: false, code: "malformed", error: "the grant names no valid owner command" };
  }
  if (!sessionId) return { ok: false, code: "malformed", error: "the grant names no session" };
  if (!Number.isInteger(raw.epoch) || (raw.epoch as number) < 0) {
    return { ok: false, code: "malformed", error: "the grant has no valid epoch" };
  }
  if (!Number.isFinite(raw.issuedAt) || !Number.isFinite(raw.expiresAt)) {
    return { ok: false, code: "malformed", error: "the grant has no valid validity window" };
  }
  const issuedAt = raw.issuedAt as number;
  const expiresAt = raw.expiresAt as number;
  if (expiresAt <= issuedAt) {
    return { ok: false, code: "malformed", error: "the grant expires before it is issued" };
  }
  if (expiresAt - issuedAt > BRIDGE_AUTH_LIMITS.maxGrantTtlMs) {
    return { ok: false, code: "malformed", error: "the grant lifetime is too long" };
  }
  const grant: BridgeGrant = {
    version: BRIDGE_AUTH_VERSION,
    token,
    ownerCommand,
    sessionId,
    epoch: raw.epoch as number,
    issuedAt,
    expiresAt,
  };
  if (now >= expiresAt) {
    return { ok: false, code: "expired", error: "the host capability grant has expired" };
  }
  return { ok: true, grant };
}

/** Extension-side holder: one live grant per host session, memory only. */
export interface GrantHolder {
  /** Accept a grant handed to this extension by a host command invocation. */
  accept(raw: unknown, now?: number): GrantResult;
  /** Forget it on teardown/rebind. A stale grant is never reused. */
  clear(): void;
  current(): BridgeGrant | undefined;
  /** True only while a valid, unexpired grant is held. */
  usable(now?: number): boolean;
  /**
   * What a privileged request must carry. Absent when no grant exists, so the
   * caller fails closed instead of sending an owner string and hoping.
   */
  attach<T extends Record<string, unknown>>(payload: T, now?: number): (T & BridgeGrant) | undefined;
}

export function createGrantHolder(): GrantHolder {
  let held: BridgeGrant | undefined;
  return {
    accept(raw, now = Date.now()) {
      const parsed = parseBridgeGrant(raw, now);
      if (!parsed.ok) {
        held = undefined;
        return parsed;
      }
      held = parsed.grant;
      return parsed;
    },
    clear() {
      held = undefined;
    },
    current: () => held,
    usable(now = Date.now()) {
      return !!held && now < held.expiresAt;
    },
    attach(payload, now = Date.now()) {
      if (!held || now >= held.expiresAt) return undefined;
      return { ...payload, ...held };
    },
  };
}

/** Host-side view of one issued grant. */
export interface IssuedGrant {
  grant: BridgeGrant;
  /** Operation class the host authorized, or `undefined` for any one operation. */
  consumedBy?: string;
}

/**
 * Host-side authority: mints grants for a command invocation and validates the
 * request that later carries one.
 *
 * `issue` is called by the host when it invokes a registered extension command;
 * `accept` is called on the resulting bus request. Validation is checked in a
 * fixed order so a stale/foreign grant can never be reported as a replay.
 */
export interface GrantAuthority {
  issue(input: {
    ownerCommand: string;
    sessionId: string;
    epoch: number;
    now?: number;
    ttlMs?: number;
  }): { ok: true; grant: BridgeGrant } | { ok: false; code: "invalid"; error: string };
  accept(
    input: {
      raw: unknown;
      ownerCommand: string;
      sessionId: string;
      epoch: number;
      operation: string;
      now?: number;
    },
  ): GrantResult;
  /** Forget every grant (session teardown/rebind). */
  reset(): void;
}

export function createGrantAuthority(options: {
  now?: () => number;
  random?: () => string;
  maxTtlMs?: number;
} = {}): GrantAuthority {
  const now = options.now ?? (() => Date.now());
  const random = options.random ?? (() => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`);
  const maxTtlMs = Math.min(options.maxTtlMs ?? 5 * 60_000, BRIDGE_AUTH_LIMITS.maxGrantTtlMs);
  /** token → issued grant; memory only, per host process. */
  const issued = new Map<string, IssuedGrant>();

  const reset = () => issued.clear();

  return {
    issue(input) {
      const ownerCommand = boundedText(input.ownerCommand, BRIDGE_AUTH_LIMITS.maxOwnerCommandChars);
      const sessionId = boundedText(input.sessionId, BRIDGE_AUTH_LIMITS.maxSessionChars);
      if (!ownerCommand || !OWNER_COMMAND_PATTERN.test(ownerCommand)) {
        return { ok: false, code: "invalid", error: "ownerCommand is not a registered command name" };
      }
      if (!sessionId) return { ok: false, code: "invalid", error: "sessionId is required" };
      if (!Number.isInteger(input.epoch) || input.epoch < 0) {
        return { ok: false, code: "invalid", error: "epoch must be a non-negative integer" };
      }
      const at = input.now ?? now();
      const ttlMs = Math.min(
        Math.max(1, input.ttlMs ?? maxTtlMs),
        maxTtlMs,
        BRIDGE_AUTH_LIMITS.maxGrantTtlMs,
      );
      const token = `grant-${random()}`.slice(0, BRIDGE_AUTH_LIMITS.maxTokenChars);
      const grant: BridgeGrant = {
        version: BRIDGE_AUTH_VERSION,
        token,
        ownerCommand,
        sessionId,
        epoch: input.epoch,
        issuedAt: at,
        expiresAt: at + ttlMs,
      };
      issued.set(token, { grant });
      return { ok: true, grant };
    },

    accept(input) {
      const parsed = parseBridgeGrant(input.raw, input.now ?? now());
      if (!parsed.ok) return parsed;
      const known = issued.get(parsed.grant.token);
      if (!known) {
        return { ok: false, code: "unknown", error: "the capability grant was not issued by this host" };
      }
      const at = input.now ?? now();
      if (at >= known.grant.expiresAt) {
        issued.delete(known.grant.token);
        return { ok: false, code: "expired", error: "the capability grant expired" };
      }
      if (known.grant.ownerCommand !== input.ownerCommand) {
        return { ok: false, code: "owner_mismatch", error: "the grant belongs to another extension" };
      }
      if (known.grant.sessionId !== input.sessionId) {
        return { ok: false, code: "session_mismatch", error: "the grant belongs to another session" };
      }
      if (known.grant.epoch !== input.epoch) {
        return { ok: false, code: "epoch_mismatch", error: "the grant is from a previous host epoch" };
      }
      if (known.consumedBy !== undefined) {
        return {
          ok: false,
          code: "replayed",
          error: `the grant was already used for ${known.consumedBy}`,
        };
      }
      if (known.grant.issuedAt > at) {
        return { ok: false, code: "malformed", error: "the grant is issued in the future" };
      }
      known.consumedBy = input.operation;
      return { ok: true, grant: known.grant };
    },

    reset,
  };
}
