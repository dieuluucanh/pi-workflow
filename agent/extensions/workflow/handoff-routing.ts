/**
 * Workflow Extension — plan handoff decision record and approval router.
 *
 * A plan approval is a decision with identity, not a boolean. This module owns
 * everything that can be decided without a Pi host:
 *
 *   - the durable identity of one handoff (plan path + approved-content digest,
 *     session/branch, review cycle, review/request correlation);
 *   - the destination captured when the decision was SHOWN, plus a one-off
 *     override that never writes settings;
 *   - consume/supersede transitions, so browser, native and reload-recovery
 *     events can never execute the same approval twice;
 *   - the pure route choice (`build` = this session, `orchestrator` = prepare a
 *     breakdown) that the extension applies.
 *
 * Legacy compatibility: a pending browser handoff persisted before destinations
 * existed was shown as "Approve → Build". Restoring it must keep that meaning;
 * it never becomes retroactive consent to orchestration.
 *
 * Type-only imports: this module stays testable without a host or filesystem.
 */

export const HANDOFF_DECISION_VERSION = 1 as const;

/** Where an approved plan executes. Mirrors `handoff-config.ts`. */
export type HandoffDestination = "orchestrator" | "build";

export const HANDOFF_DESTINATIONS: readonly HandoffDestination[] = [
  "orchestrator",
  "build",
];

export type HandoffDecisionState =
  | "pending"
  | "consumed"
  | "superseded"
  | "dismissed";

export type HandoffPresenter = "browser" | "native";

/** One applied routing effect. Exactly one per consumed decision. */
export interface HandoffRouteReceipt {
  at: number;
  destination: HandoffDestination;
  /** `direct-build` or `orchestrator-prepare`. */
  route: HandoffRouteKind;
  /** Set when the route was requested but could not be applied. */
  failure?: string;
}

export type HandoffRouteKind = "direct-build" | "orchestrator-prepare";

export type HandoffRoute =
  | { kind: "direct-build"; planPath: string; decisionId: string; feedback?: string }
  | { kind: "orchestrator-prepare"; planPath: string; decisionId: string; runHint: string };

export interface HandoffDecision {
  version: typeof HANDOFF_DECISION_VERSION;
  decisionId: string;
  planPath: string;
  /** Digest of the exact plan content the user was shown. */
  planHash: string;
  /** Session/branch identity the decision belongs to. */
  sessionRef: string;
  reviewCycleId: number;
  source: "auto" | "manual";
  presenter: HandoffPresenter;
  reviewOwned: boolean;
  /** Destination captured from settings when the decision was presented. */
  defaultDestination: HandoffDestination;
  /** Effective destination: the default, or the one-off override. */
  destination: HandoffDestination;
  /** 0 while the captured default applies; increments per explicit override. */
  overrideRevision: number;
  state: HandoffDecisionState;
  createdAt: number;
  updatedAt: number;
  /** Set when consumed; the bounded evidence that this decision ran. */
  receipts: HandoffRouteReceipt[];
  /** Present on a restored legacy decision (pre-destination). */
  legacy?: true;
}

export type HandoffDecisionResult<T = HandoffDecision> =
  | { ok: true; decision: T }
  | {
      ok: false;
      code:
        | "invalid"
        | "consumed"
        | "dismissed"
        | "superseded"
        | "stale"
        | "unchanged";
      error: string;
    };

const MAX_PLAN_PATH = 2_000;
const MAX_SESSION_REF = 400;
const MAX_DECISION_ID = 160;
const MAX_HASH = 128;
const MAX_RECEIPTS = 8;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function bounded(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= max ? trimmed : undefined;
}

export function isHandoffDestination(value: unknown): value is HandoffDestination {
  return value === "orchestrator" || value === "build";
}

function isState(value: unknown): value is HandoffDecisionState {
  return (
    value === "pending" ||
    value === "consumed" ||
    value === "superseded" ||
    value === "dismissed"
  );
}

/** Deterministic identity: stable across reloads for the same handoff. */
export function handoffDecisionId(input: {
  sessionRef: string;
  reviewCycleId: number;
  planPath: string;
  planHash: string;
}): string {
  const seed = [
    input.sessionRef,
    String(input.reviewCycleId),
    input.planPath,
    input.planHash,
  ].join("\u0000");
  // FNV-1a: short, dependency-free, stable. Uniqueness is not a security
  // property here; the digests and correlation are re-validated on consume.
  let hash = 0x811c9dc5;
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `handoff-${hash.toString(16).padStart(8, "0")}`.slice(0, MAX_DECISION_ID);
}

export interface CreateHandoffDecisionInput {
  planPath: string;
  planHash: string;
  sessionRef: string;
  reviewCycleId: number;
  source: "auto" | "manual";
  presenter: HandoffPresenter;
  reviewOwned: boolean;
  defaultDestination: HandoffDestination;
  now: number;
  /** A restored decision keeps its id through reload/recovery. */
  decisionId?: string;
  legacy?: true;
}

/**
 * Creates the pending record. A legacy record keeps the destination it was
 * originally shown with (`build`), never the new default.
 */
export function createHandoffDecision(
  input: CreateHandoffDecisionInput,
): HandoffDecisionResult {
  const planPath = bounded(input.planPath, MAX_PLAN_PATH);
  const planHash = bounded(input.planHash, MAX_HASH);
  const sessionRef = bounded(input.sessionRef, MAX_SESSION_REF);
  if (!planPath) return { ok: false, code: "invalid", error: "planPath is required" };
  if (!planHash) return { ok: false, code: "invalid", error: "planHash is required" };
  if (!sessionRef) return { ok: false, code: "invalid", error: "sessionRef is required" };
  if (!Number.isInteger(input.reviewCycleId) || input.reviewCycleId < 0) {
    return { ok: false, code: "invalid", error: "reviewCycleId must be a non-negative integer" };
  }
  if (!isHandoffDestination(input.defaultDestination)) {
    return { ok: false, code: "invalid", error: "unknown default destination" };
  }
  const legacy = input.legacy === true;
  const defaultDestination: HandoffDestination = legacy ? "build" : input.defaultDestination;
  const decisionId =
    bounded(input.decisionId, MAX_DECISION_ID) ??
    handoffDecisionId({
      sessionRef,
      reviewCycleId: input.reviewCycleId,
      planPath,
      planHash,
    });
  return {
    ok: true,
    decision: {
      version: HANDOFF_DECISION_VERSION,
      decisionId,
      planPath,
      planHash,
      sessionRef,
      reviewCycleId: input.reviewCycleId,
      source: input.source,
      presenter: input.presenter,
      reviewOwned: input.reviewOwned,
      defaultDestination,
      destination: defaultDestination,
      overrideRevision: 0,
      state: "pending",
      createdAt: input.now,
      updatedAt: input.now,
      receipts: [],
      ...(legacy ? { legacy: true as const } : {}),
    },
  };
}

/**
 * Applies a one-off destination. Only a pending decision can be overridden and
 * settings are never touched here; `handoff-config.ts` owns the saved default.
 */
export function overrideHandoffDestination(
  decision: HandoffDecision,
  destination: HandoffDestination,
  now: number,
): HandoffDecisionResult {
  if (decision.state === "consumed") {
    return {
      ok: false,
      code: "consumed",
      error: "this handoff was already approved — change the default for the next one",
    };
  }
  if (decision.state !== "pending") {
    return {
      ok: false,
      code: decision.state === "dismissed" ? "dismissed" : "superseded",
      error: `this handoff is ${decision.state}`,
    };
  }
  if (!isHandoffDestination(destination)) {
    return { ok: false, code: "invalid", error: "unknown destination" };
  }
  if (decision.destination === destination && decision.overrideRevision > 0) {
    return { ok: false, code: "unchanged", error: `already set to ${destination}` };
  }
  // Drop `legacy` entirely: an explicit one-off choice means the restored-Build
  // rule no longer applies, and the record must round-trip byte-stably.
  const { legacy: _legacy, ...rest } = decision;
  void _legacy;
  return {
    ok: true,
    decision: {
      ...rest,
      destination,
      overrideRevision: decision.overrideRevision + 1,
      updatedAt: now,
    },
  };
}

/** True when this event still describes the decision (path + content + cycle). */
export function handoffDecisionMatches(
  decision: HandoffDecision,
  input: { planPath?: string; planHash?: string; reviewCycleId?: number },
): boolean {
  if (input.reviewCycleId !== undefined && input.reviewCycleId !== decision.reviewCycleId) {
    return false;
  }
  if (input.planPath !== undefined && input.planPath !== decision.planPath) return false;
  if (input.planHash !== undefined && input.planHash !== decision.planHash) return false;
  return true;
}

/**
 * The pure route for an approval. Calling this does not consume: the caller
 * persists intent first, then applies the effect, then records the receipt.
 */
export function handoffRouteFor(decision: HandoffDecision): HandoffRoute | undefined {
  if (decision.state !== "pending") return undefined;
  if (decision.destination === "build") {
    return {
      kind: "direct-build",
      planPath: decision.planPath,
      decisionId: decision.decisionId,
    };
  }
  return {
    kind: "orchestrator-prepare",
    planPath: decision.planPath,
    decisionId: decision.decisionId,
    runHint: decision.planHash.slice(0, 16),
  };
}

export type ConsumeResult =
  | { ok: true; decision: HandoffDecision; route: HandoffRoute }
  | { ok: false; code: "not_pending" | "invalid"; error: string };

/**
 * Marks the decision consumed and returns the single route to apply.
 *
 * Idempotence is by state: a second approval (browser duplicate, native answer
 * after fallback, reload recovery) sees `consumed` and is refused, so no second
 * parent turn, run or child can start from one decision.
 */
export function consumeHandoffDecision(
  decision: HandoffDecision,
  input: {
    now: number;
    /** Re-validated approved content; must still match what was shown. */
    planHash?: string;
    route: HandoffRouteKind;
    failure?: string;
  },
): ConsumeResult {
  if (decision.state !== "pending") {
    return {
      ok: false,
      code: "not_pending",
      error: `this handoff is ${decision.state}`,
    };
  }
  if (input.planHash !== undefined && input.planHash !== decision.planHash) {
    return { ok: false, code: "invalid", error: "the plan changed after it was shown" };
  }
  const route = handoffRouteFor(decision);
  if (!route) return { ok: false, code: "not_pending", error: "no route is available" };
  if (route.kind !== input.route) {
    return {
      ok: false,
      code: "invalid",
      error: `the destination is ${decision.destination}, not ${input.route}`,
    };
  }
  const receipt: HandoffRouteReceipt = {
    at: input.now,
    destination: decision.destination,
    route: input.route,
    ...(input.failure === undefined ? {} : { failure: input.failure }),
  };
  return {
    ok: true,
    route,
    decision: {
      ...decision,
      state: "consumed",
      updatedAt: input.now,
      receipts: [...decision.receipts, receipt].slice(-MAX_RECEIPTS),
    },
  };
}

export function supersedeHandoffDecision(
  decision: HandoffDecision,
  now: number,
  reason?: string,
): HandoffDecision {
  if (decision.state === "consumed") return decision;
  const receipt: HandoffRouteReceipt | undefined = reason
    ? {
        at: now,
        destination: decision.destination,
        route: decision.destination === "build" ? "direct-build" : "orchestrator-prepare",
        failure: reason,
      }
    : undefined;
  return {
    ...decision,
    state: "superseded",
    updatedAt: now,
    receipts: receipt
      ? [...decision.receipts, receipt].slice(-MAX_RECEIPTS)
      : decision.receipts,
  };
}

export function dismissHandoffDecision(decision: HandoffDecision, now: number): HandoffDecision {
  if (decision.state === "consumed") return decision;
  return { ...decision, state: "dismissed", updatedAt: now };
}

/** Bounded, validated codec for the persisted workflow entry. */
export function parseHandoffDecision(raw: unknown): HandoffDecision | undefined {
  if (!isRecord(raw)) return undefined;
  if (raw.version !== HANDOFF_DECISION_VERSION) return undefined;
  if (!isState(raw.state)) return undefined;
  const decisionId = bounded(raw.decisionId, MAX_DECISION_ID);
  const planPath = bounded(raw.planPath, MAX_PLAN_PATH);
  const planHash = bounded(raw.planHash, MAX_HASH);
  const sessionRef = bounded(raw.sessionRef, MAX_SESSION_REF);
  if (!decisionId || !planPath || !planHash || !sessionRef) return undefined;
  if (!Number.isInteger(raw.reviewCycleId) || (raw.reviewCycleId as number) < 0) return undefined;
  if (raw.source !== "auto" && raw.source !== "manual") return undefined;
  if (raw.presenter !== "browser" && raw.presenter !== "native") return undefined;
  if (!isHandoffDestination(raw.defaultDestination)) return undefined;
  if (!isHandoffDestination(raw.destination)) return undefined;
  if (!Number.isInteger(raw.overrideRevision) || (raw.overrideRevision as number) < 0) {
    return undefined;
  }
  return {
    version: HANDOFF_DECISION_VERSION,
    decisionId,
    planPath,
    planHash,
    sessionRef,
    reviewCycleId: raw.reviewCycleId as number,
    source: raw.source,
    presenter: raw.presenter,
    reviewOwned: raw.reviewOwned === true,
    defaultDestination: raw.defaultDestination,
    destination: raw.destination,
    overrideRevision: raw.overrideRevision as number,
    state: raw.state,
    createdAt: typeof raw.createdAt === "number" ? raw.createdAt : 0,
    updatedAt: typeof raw.updatedAt === "number" ? raw.updatedAt : 0,
    receipts: Array.isArray(raw.receipts)
      ? (raw.receipts as unknown[])
          .filter(isRecord)
          .flatMap((entry) => {
            if (typeof entry.at !== "number") return [];
            if (!isHandoffDestination(entry.destination)) return [];
            if (entry.route !== "direct-build" && entry.route !== "orchestrator-prepare") {
              return [];
            }
            return [
              {
                at: entry.at,
                destination: entry.destination,
                route: entry.route,
                ...(bounded(entry.failure, 400) ? { failure: bounded(entry.failure, 400)! } : {}),
              } satisfies HandoffRouteReceipt,
            ];
          })
          .slice(-MAX_RECEIPTS)
      : [],
    ...(raw.legacy === true ? { legacy: true as const } : {}),
  };
}
