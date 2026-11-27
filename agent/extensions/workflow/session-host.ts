/**
 * Workflow Extension — related-session host contract (v1).
 *
 * Orchestration needs a child that is a NORMAL session: a real interactive Pi
 * window in a terminal, or a normal session tab in Pi Desktop. Pi's extension
 * API can replace the current runtime (`newSession`/`switchSession`) but it
 * cannot open a second, independently owned session. This contract is the
 * request the extension sends to a host that can:
 *
 *   - Windows Terminal / macOS Terminal / Linux terminal adapters (W), and
 *   - Pi Desktop's session-tab service (D).
 *
 * Trust rules that the host enforces (not the extension):
 *   - one live owner per session file; opening an already-owned session
 *     focuses it instead of starting a second writer;
 *   - `bootstrap` entries are written before the child's `session_start`, so a
 *     child cannot take an action before it knows its task;
 *   - `sessionRef` values are opaque handles. An extension must never assume a
 *     path, a tab id or a process id;
 *   - a result with `code: "unsupported"` is final. There is no silent
 *     headless fallback — the caller must pause and explain.
 *
 * This module is pure. The terminal launcher port lives in `ports.ts`; the
 * Desktop implementation lives in the Desktop repository.
 */

export const SESSION_HOST_VERSION = 1 as const;

/** What a host can do. Resolved once per dispatch, because installs change. */
export interface SessionHostCapabilities {
  version: number;
  /** Opens a new related session. */
  create: boolean;
  /** Opens an existing session file/ref. */
  open: boolean;
  /** Brings an existing related session forward. */
  focus: boolean;
  /** Read-only inspection of a running session (no second writer). */
  inspect: boolean;
  /** Cooperative interruption of the child's current turn. */
  interrupt: boolean;
  /** Closes the host's own window/tab without killing unrelated work. */
  close: boolean;
  /** A separate OS window/tab, as opposed to replacing the parent. */
  separateWindow: boolean;
  /** The host can apply bootstrap entries before `session_start`. */
  bootstrapBeforeStart: boolean;
  /** Human-readable host identity, e.g. `Windows Terminal` or `Pi Desktop`. */
  label: string;
  reason?: string;
}

export const SESSION_HOST_LIMITS = {
  maxBootstrapEntries: 8,
  maxBootstrapChars: 8_000,
  maxTitleChars: 120,
  maxRefChars: 400,
  maxDedupeChars: 200,
} as const;

/** One durable entry written before the child starts. */
export interface SessionBootstrapEntry {
  customType: string;
  content: string;
  display: boolean;
}

export const SESSION_BOOTSTRAP_TYPES = [
  "workflow-managed-session",
  "workflow-task-assignment",
  "workflow-roadmap-reference",
  "workflow-task-scope",
  "workflow-control-grant",
] as const;

export type SessionBootstrapType = (typeof SESSION_BOOTSTRAP_TYPES)[number];

export interface RelatedSessionSpec {
  /** Caller-generated idempotency key; retries must reuse it. */
  requestId: string;
  /** Parent session identity (opaque). */
  parentSessionRef: string;
  relation: "child" | "sibling";
  title: string;
  /** Absolute working directory for the child. */
  cwd: string;
  /**
   * Semantic mode the child should start in. Hosts pass it to the extension
   * bootstrap; it is not a security boundary (the bootstrap entry is).
   */
  mode?: string;
  /** Dedupe key: same key + same parent reuses the existing session. */
  dedupeKey: string;
  bootstrap: SessionBootstrapEntry[];
}

export type SessionHostErrorCode = "unsupported" | "rejected" | "failed" | "cancelled";

export type SessionHostResult =
  | {
      ok: true;
      sessionRef: string;
      focused: boolean;
      reused: boolean;
      /** The real durable identity, when the host owns creation. */
      sessionId?: string;
      sessionFile?: string;
    }
  | { ok: false; code: SessionHostErrorCode; reason: string };

export interface SessionHostPort {
  capabilities(): Promise<SessionHostCapabilities>;
  createRelated(spec: RelatedSessionSpec): Promise<SessionHostResult>;
  open(sessionRef: string): Promise<SessionHostResult>;
  focus(sessionRef: string): Promise<boolean>;
  inspect(sessionRef: string): Promise<
    { ok: true; title: string; running: boolean } | { ok: false; reason: string }
  >;
  interrupt(sessionRef: string): Promise<boolean>;
  close(sessionRef: string): Promise<boolean>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

const CONTROL = /[\u0000-\u001f\u007f]/;

function text(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > max) return undefined;
  if (CONTROL.test(trimmed)) return undefined;
  return trimmed;
}

export type SessionSpecResult =
  | { ok: true; value: RelatedSessionSpec }
  | { ok: false; error: string };

/**
 * Validates a launch request. Rejects control characters (they would corrupt a
 * terminal title or a path), unbounded bootstrap content, and bootstrap types
 * this version does not know — a child must never start with an instruction it
 * cannot interpret.
 */
export function validateRelatedSessionSpec(raw: unknown): SessionSpecResult {
  if (!isRecord(raw)) return { ok: false, error: "spec must be an object" };
  const requestId = text(raw.requestId, SESSION_HOST_LIMITS.maxDedupeChars);
  if (!requestId) return { ok: false, error: "invalid requestId" };
  const parentSessionRef = text(raw.parentSessionRef, SESSION_HOST_LIMITS.maxRefChars);
  if (!parentSessionRef) return { ok: false, error: "invalid parentSessionRef" };
  if (raw.relation !== "child" && raw.relation !== "sibling") {
    return { ok: false, error: "relation must be child or sibling" };
  }
  const title = text(raw.title, SESSION_HOST_LIMITS.maxTitleChars);
  if (!title) return { ok: false, error: "invalid title" };
  const cwd = text(raw.cwd, SESSION_HOST_LIMITS.maxRefChars);
  if (!cwd) return { ok: false, error: "invalid cwd" };
  if (!/^[A-Za-z]:[\\/]|^\//.test(cwd)) {
    return { ok: false, error: "cwd must be absolute" };
  }
  const mode = raw.mode === undefined ? undefined : text(raw.mode, 40);
  if (raw.mode !== undefined && mode === undefined) return { ok: false, error: "invalid mode" };
  const dedupeKey = text(raw.dedupeKey, SESSION_HOST_LIMITS.maxDedupeChars);
  if (!dedupeKey) return { ok: false, error: "invalid dedupeKey" };

  if (!Array.isArray(raw.bootstrap)) return { ok: false, error: "bootstrap must be an array" };
  if (raw.bootstrap.length > SESSION_HOST_LIMITS.maxBootstrapEntries) {
    return { ok: false, error: "too many bootstrap entries" };
  }
  const bootstrap: SessionBootstrapEntry[] = [];
  let total = 0;
  for (const entry of raw.bootstrap) {
    if (!isRecord(entry)) return { ok: false, error: "bootstrap entry must be an object" };
    const customType = entry.customType;
    if (
      typeof customType !== "string" ||
      !(SESSION_BOOTSTRAP_TYPES as readonly string[]).includes(customType)
    ) {
      return { ok: false, error: `unsupported bootstrap entry ${String(customType)}` };
    }
    const content = text(entry.content, SESSION_HOST_LIMITS.maxBootstrapChars);
    if (!content) return { ok: false, error: `invalid bootstrap content for ${customType}` };
    total += content.length;
    if (total > SESSION_HOST_LIMITS.maxBootstrapChars * SESSION_HOST_LIMITS.maxBootstrapEntries) {
      return { ok: false, error: "bootstrap content is too large" };
    }
    bootstrap.push({ customType, content, display: entry.display === true });
  }

  return {
    ok: true,
    value: {
      requestId,
      parentSessionRef,
      relation: raw.relation,
      title,
      cwd,
      ...(mode === undefined ? {} : { mode }),
      dedupeKey,
      bootstrap,
    },
  };
}

/**
 * The one supported dispatch gate. Returns a user-facing reason instead of
 * throwing, so a missing host pauses the run with an actionable message.
 */
export function dispatchSupport(capabilities: SessionHostCapabilities): string | undefined {
  if (capabilities.version < SESSION_HOST_VERSION) {
    return `session host contract v${capabilities.version} is older than v${SESSION_HOST_VERSION}`;
  }
  if (!capabilities.create) return capabilities.reason ?? "this host cannot open a related session";
  if (!capabilities.separateWindow) {
    return capabilities.reason ?? "this host cannot open a separate session window/tab";
  }
  if (!capabilities.bootstrapBeforeStart) {
    return "this host cannot apply the task bootstrap before the child starts";
  }
  if (!capabilities.focus) return "this host cannot bring the child session forward";
  return undefined;
}
