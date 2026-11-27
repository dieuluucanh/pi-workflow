/**
 * Cross-instance teardown handshake for in-process Orchestrator children.
 *
 * `AgentSession.dispose()` never emits `session_shutdown`, so a child Workflow
 * instance (a SECOND factory call in the same process) publishes a teardown
 * closure here and the parent controller runs it after disposing the SDK
 * session. That handshake needs process-wide reach, but it must not become
 * shared session state:
 *
 *   - entries are keyed by the child's own session id, so two sessions (or a
 *     parent plus a resource-inspector load) never take each other's cleanup;
 *   - `take()` is idempotent, so a parent dispose and a child shutdown can both
 *     run without double-tearing-down or leaving a stale closure;
 *   - `register()` replaces only that session's entry and the returned
 *     `unregister` refuses to remove a newer entry (ABA safety);
 *   - the map is bounded (max entries) and time-bounded (TTL), so a child that
 *     never disposes cannot retain its subagent set forever.
 *
 * The registry holds only opaque teardown functions — no reviewer, refiner or
 * subagent objects are shared between instances.
 */

/** How long a child teardown entry may wait for the parent's dispose. */
export const CHILD_TEARDOWN_TTL_MS = 30 * 60 * 1000;

/** Upper bound on retained child sessions (one per concurrent child). */
export const CHILD_TEARDOWN_MAX_ENTRIES = 8;

export interface ChildTeardownRegistryDeps {
  /** Injected clock (tests). Defaults to `Date.now`. */
  now?: () => number;
  /** Injected TTL (tests). Defaults to {@link CHILD_TEARDOWN_TTL_MS}. */
  ttlMs?: number;
  /** Injected bound (tests). Defaults to {@link CHILD_TEARDOWN_MAX_ENTRIES}. */
  maxEntries?: number;
}

export interface ChildTeardownRegistry {
  /**
   * Publish `teardown` for `sessionId`. Returns an idempotent unregister that
   * removes the entry only while it is still this exact teardown.
   */
  register(sessionId: string, teardown: () => void): () => void;
  /** Remove and return this session's teardown; never another session's. */
  take(sessionId: string): (() => void) | undefined;
  /** Whether a live (non-expired) entry exists for the session. */
  has(sessionId: string): boolean;
  /** Number of live entries (expired/bounded entries are pruned first). */
  size(): number;
  /** Drop every entry without running them (tests / process reset). */
  clear(): void;
}

export function createChildTeardownRegistry(
  deps: ChildTeardownRegistryDeps = {},
): ChildTeardownRegistry {
  const now = deps.now ?? Date.now;
  const ttlMs = deps.ttlMs ?? CHILD_TEARDOWN_TTL_MS;
  const maxEntries = Math.max(1, deps.maxEntries ?? CHILD_TEARDOWN_MAX_ENTRIES);
  const entries = new Map<string, { teardown: () => void; at: number }>();

  /** Drop expired entries, then the oldest ones above the bound. */
  function prune(): void {
    const cutoff = now() - ttlMs;
    for (const [sessionId, entry] of entries) {
      if (entry.at <= cutoff) entries.delete(sessionId);
    }
    while (entries.size > maxEntries) {
      const oldest = entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      entries.delete(oldest);
    }
  }

  return {
    register(sessionId, teardown) {
      if (!sessionId || typeof teardown !== "function") return () => {};
      prune();
      // Replace this session's entry only: another child's cleanup is not ours.
      entries.delete(sessionId);
      entries.set(sessionId, { teardown, at: now() });
      prune();
      return () => {
        const current = entries.get(sessionId);
        if (current && current.teardown === teardown) entries.delete(sessionId);
      };
    },
    take(sessionId) {
      const current = entries.get(sessionId);
      if (!current) return undefined;
      entries.delete(sessionId);
      if (now() - current.at > ttlMs) return undefined;
      return current.teardown;
    },
    has(sessionId) {
      prune();
      return entries.has(sessionId);
    },
    size() {
      prune();
      return entries.size;
    },
    clear() {
      entries.clear();
    },
  };
}

/**
 * The process-wide handshake. It is a registry, not session state: each child
 * publishes only its own opaque cleanup closure, keyed by its own session id.
 */
export const orchestratorChildTeardowns = createChildTeardownRegistry();

/** Test hook: drop entries between cases so one test cannot see another's. */
export function resetOrchestratorChildTeardownsForTests(): void {
  orchestratorChildTeardowns.clear();
}
