/**
 * Workflow Extension — generic contribution publisher.
 *
 * `host-contributions.ts` owns the wire format and its validation. This module
 * owns the extension side of publishing it:
 *
 *   - discover whether the host speaks the contract (`hello`, or a probe),
 *   - publish a deterministic, bounded envelope on every change,
 *   - withdraw removed ids explicitly,
 *   - fall back to plain statuses/widgets when the host is older or silent.
 *
 * The publisher is framework-neutral on purpose. It knows nothing about
 * Plan/Build/Review; the caller supplies contributions and a fallback renderer.
 * That is what lets a third-party extension use the same contract, and what
 * lets Pi Desktop implement one reader instead of one per extension.
 *
 * Ordering and revision rules (normative):
 *   - `revision` starts at 1 and increases by exactly 1 per published change;
 *   - a rejected change does not advance the revision;
 *   - `removed` lists ids that existed in the previous set but not the new one;
 *   - an unchanged set is not re-published (no churn in the host registry).
 */

import type { ClockPort } from "./ports.ts";
import {
  HOST_CONTRIBUTION_LIMITS,
  HOST_CONTRIBUTION_VERSION,
  negotiateContributionVersion,
  parseContributionEnvelope,
  sortContributions,
  type Contribution,
  type ContributionEnvelope,
  type HostContributionCapabilities,
} from "./host-contributions.ts";

/**
 * Bus event names. `hello` is the host announcing support (broadcast after a
 * bind); `probe` asks any host to answer with the same payload; `update` and
 * `withdraw` carry validated envelopes.
 */
export const CONTRIBUTION_EVENTS = {
  hello: "host-contributions:hello",
  probe: "host-contributions:probe",
  update: "host-contributions:update",
  withdraw: "host-contributions:withdraw",
} as const;

export interface ContributionPublisherDeps {
  owner: { id: string; version?: string };
  sessionId: string;
  clock: ClockPort;
  /** Emit on the shared bus (pi.events.emit). */
  emit: (event: string, payload?: unknown) => void;
  /**
   * Subscribe to bus events (pi.events.on). Optional: a test may inject
   * capabilities directly instead.
   */
  listen?: (event: string, handler: (payload: unknown) => void) => () => void;
  /** Host attachment generation; a rebind supplies a new epoch. */
  epoch?: number;
  /** Called with every accepted set when the host does NOT support the contract. */
  onFallback?: (contributions: readonly Contribution[]) => void;
  /** Called when support changes, so the caller can add/remove native rows. */
  onSupportChange?: (supported: boolean, reason?: string) => void;
}

export interface PublishResult {
  ok: boolean;
  /** Present when `ok` is false. */
  reason?: string;
  /** True when the envelope was emitted to a supporting host. */
  published: boolean;
}

export interface ContributionPublisher {
  /** The negotiated contract version, or undefined when unsupported. */
  supportedVersion(): number | undefined;
  supported(): boolean;
  /** Why contributions are not published (never set when supported). */
  unsupportedReason(): string | undefined;
  /** The host's advertised capabilities, when known. */
  capabilities(): HostContributionCapabilities | undefined;

  /** Replace the whole contribution set (deterministic order). */
  set(contributions: readonly Contribution[]): PublishResult;
  /** Withdraw specific ids, keeping the rest. */
  remove(ids: readonly string[]): PublishResult;
  /** Withdraw everything (session teardown, mode exit). */
  clear(): PublishResult;

  /** Current accepted contributions, in publish order. */
  current(): readonly Contribution[];
  revision(): number;

  /** Record a host `hello` (also usable as a direct test seam). */
  hello(capabilities: HostContributionCapabilities): void;
  /** Ask a silent host to announce support. */
  probe(): void;
  /** Change the attachment generation (rebind / new host process). */
  setEpoch(epoch: number): void;
  dispose(): void;
}


/**
 * Full content equality, not just ids: a progress count, label, enabled flag or
 * panel-state detail must reach the host. Order is deterministic (`sortContributions`),
 * and every contribution is plain JSON, so a stable serialization is exact.
 */
function sameContributions(a: readonly Contribution[], b: readonly Contribution[]): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    if (JSON.stringify(a[index]) !== JSON.stringify(b[index])) return false;
  }
  return true;
}

/**
 * Creates a publisher for one session. It starts in the "unknown" state: until
 * a host says hello (or answers a probe), `set()` calls the fallback and emits
 * nothing, so an old host keeps seeing its statuses/widgets.
 */
export function createContributionPublisher(
  deps: ContributionPublisherDeps,
): ContributionPublisher {
  let capabilities: HostContributionCapabilities | undefined;
  let supportReason: string | undefined = "host has not announced contribution support";
  let revision = 0;
  let epoch = deps.epoch ?? 0;
  let contributions: Contribution[] = [];
  let disposed = false;
  const unsubscribe: Array<() => void> = [];

  const setSupport = (caps: HostContributionCapabilities | undefined, reason?: string): void => {
    const next = caps ? negotiateContributionVersion(caps) : undefined;
    const wasSupported = capabilities !== undefined && supportReason === undefined;
    if (next?.ok) {
      capabilities = caps;
      supportReason = undefined;
    } else {
      capabilities = caps;
      supportReason = reason ?? (next && !next.ok ? next.error : "host has not announced contribution support");
    }
    const nowSupported = capabilities !== undefined && supportReason === undefined;
    if (nowSupported !== wasSupported) {
      try {
        deps.onSupportChange?.(nowSupported, supportReason);
      } catch {
        /* a listener failure must not break publishing */
      }
    }
  };

  if (deps.listen) {
    try {
      unsubscribe.push(
        deps.listen(CONTRIBUTION_EVENTS.hello, (payload) => {
          if (!payload || typeof payload !== "object") return;
          const record = payload as Record<string, unknown>;
          if (record.contractVersion === undefined) return;
          publisher.hello({
            contractVersion: Number(record.contractVersion),
            kinds: Array.isArray(record.kinds) ? (record.kinds as never) : [],
            slots: Array.isArray(record.slots) ? (record.slots as never) : [],
            ...(typeof record.maxContributions === "number"
              ? { maxContributions: record.maxContributions }
              : {}),
          });
        }),
      );
    } catch {
      /* a host without a bus simply never becomes supported */
    }
  }

  const envelopeFor = (
    next: readonly Contribution[],
    removed: readonly string[],
    atRevision: number = revision,
  ): ContributionEnvelope => ({
    version: HOST_CONTRIBUTION_VERSION,
    owner: { ...deps.owner },
    sessionId: deps.sessionId,
    epoch,
    revision: atRevision,
    removed: [...removed],
    contributions: [...next],
  });

  const validate = (
    next: readonly Contribution[],
    removed: readonly string[],
  ): { ok: true } | { ok: false; reason: string } => {
    // Validate the envelope that would be published: revision is 1-based, so
    // the candidate carries `revision + 1` before the counter advances.
    const parsed = parseContributionEnvelope(envelopeFor(next, removed, revision + 1));
    return parsed.ok ? { ok: true } : { ok: false, reason: parsed.error };
  };

  const fallback = (next: readonly Contribution[]): void => {
    try {
      deps.onFallback?.(next);
    } catch {
      /* the fallback is best-effort; never break the caller */
    }
  };

  const publisher: ContributionPublisher = {
    supportedVersion: () => (supportReason === undefined ? HOST_CONTRIBUTION_VERSION : undefined),
    supported: () => supportReason === undefined,
    unsupportedReason: () => supportReason,
    capabilities: () => capabilities,

    set(nextContributions) {
      if (disposed) return { ok: false, reason: "publisher disposed", published: false };
      const ordered = sortContributions(
        nextContributions.map((contribution) => ({
          ownerId: deps.owner.id,
          contribution,
        })),
      ).map((entry) => entry.contribution);

      const previousIds = new Set(contributions.map((entry) => entry.id));
      const nextIds = new Set(ordered.map((entry) => entry.id));
      const removed = [...previousIds].filter((id) => !nextIds.has(id));

      const valid = validate(ordered, removed);
      if (!valid.ok) return { ok: false, reason: valid.reason, published: false };

      // No change → no churn (but still fall back if the host is unsupported,
      // because the caller may rely on the fallback being current).
      if (sameContributions(contributions, ordered) && removed.length === 0) {
        if (!publisher.supported()) fallback(ordered);
        return { ok: true, published: publisher.supported() };
      }

      revision += 1;
      contributions = ordered;

      if (!publisher.supported()) {
        fallback(ordered);
        return { ok: true, published: false, reason: supportReason };
      }
      try {
        deps.emit(CONTRIBUTION_EVENTS.update, envelopeFor(ordered, removed));
        return { ok: true, published: true };
      } catch (error) {
        return {
          ok: false,
          published: false,
          reason: error instanceof Error ? error.message : String(error),
        };
      }
    },

    remove(ids) {
      const drop = new Set(ids);
      return publisher.set(contributions.filter((entry) => !drop.has(entry.id)));
    },

    clear() {
      return publisher.set([]);
    },

    current: () => contributions.map((entry) => entry),
    revision: () => revision,

    hello(caps) {
      // A host that cannot hold our session is not a match.
      if (caps.maxContributions !== undefined && caps.maxContributions < 1) {
        setSupport(caps, "host accepts no contributions");
        return;
      }
      setSupport(caps);
      // Announce the current set to a newly attached host.
      if (publisher.supported() && contributions.length > 0) {
        revision += 1;
        try {
          deps.emit(CONTRIBUTION_EVENTS.update, envelopeFor(contributions, []));
        } catch {
          /* the next set() retries */
        }
      }
    },

    probe() {
      if (disposed) return;
      try {
        deps.emit(CONTRIBUTION_EVENTS.probe, {
          contractVersion: HOST_CONTRIBUTION_VERSION,
          owner: { ...deps.owner },
          sessionId: deps.sessionId,
          maxContributions: HOST_CONTRIBUTION_LIMITS.maxContributions,
        });
      } catch {
        /* probing is best-effort */
      }
    },

    setEpoch(next) {
      if (!Number.isInteger(next) || next < 0) return;
      if (next === epoch) return;
      epoch = next;
      // A new attachment starts its registry clean: the host drops the old
      // session state, so the next publish must be a full set.
      revision = 0;
      const previous = contributions;
      contributions = [];
      if (previous.length > 0 && publisher.supported()) {
        revision += 1;
        try {
          deps.emit(CONTRIBUTION_EVENTS.update, envelopeFor(previous, []));
          contributions = previous;
        } catch {
          /* retried by the next set() */
        }
      }
    },

    dispose() {
      disposed = true;
      for (const off of unsubscribe.splice(0)) {
        try {
          off();
        } catch {
          /* ignore */
        }
      }
    },
  };

  return publisher;
}
