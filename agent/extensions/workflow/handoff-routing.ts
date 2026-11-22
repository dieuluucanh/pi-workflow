/**
 * Workflow Extension — plan handoff lifecycle and approval routing.
 *
 * A handoff is a two-stage decision, not a boolean:
 *
 *   1. **Plan review** — the configured presenter (Plannotator or native)
 *      asks Approve / Feedback / Skip about the PLAN.
 *   2. **Execution** — only after an approval, Workflow asks where the
 *      approved plan runs (Orchestrator preparation or direct Build).
 *
 * The stages are separate states so that:
 *   - a saved/recommended destination can never execute without stage 2;
 *   - cancelling stage 2 keeps the approval (it is not a dismissal);
 *   - duplicate browser/native/recovery events cannot route twice.
 *
 * ```text
 *   pending ──approve──▶ approved ──select──▶ routing ──ok──▶ consumed
 *      │                   │   ▲                │
 *      │                   │   └──fail(retryable)│
 *      ├──feedback/dismiss │                    └──fail(uncertain)─▶ route-failed
 *      └──superseded       └──superseded / new prompt✗
 * ```
 *
 * Legacy compatibility: v1 records (and pre-destination browser gates) carried
 * a destination captured when the handoff was SHOWN. That is a recommendation,
 * never consent to execute. Migrating them keeps the recommendation and
 * requires the new two-stage decisions. A v1 `consumed` record stays terminal.
 *
 * Type-only imports: this module stays testable without a host or filesystem.
 */

export const HANDOFF_DECISION_VERSION = 3 as const;
/** The version that carried recommendation fields; still readable. */
export const HANDOFF_DECISION_VERSION_V2 = 2 as const;
/** Records written before the two-stage lifecycle. Readable, never writable. */
export const HANDOFF_DECISION_VERSION_LEGACY = 1 as const;

/** Where an approved plan executes. Mirrors `handoff-config.ts`. */
export type HandoffDestination = "orchestrator" | "build";

export const HANDOFF_DESTINATIONS: readonly HandoffDestination[] = [
  "orchestrator",
  "build",
];

/**
 * Lifecycle states.
 *
 * - `pending`   — the plan is presented; only approval/feedback/dismiss.
 * - `approved`  — the plan is approved; the execution chooser has not routed.
 * - `routing`   — a destination was selected and the effect is being applied.
 * - `consumed`  — the route was applied (receipts hold the evidence).
 * - `route-failed` — the route failed; terminal unless the failure was provably
 *   pre-delivery, in which case an explicit retry is allowed.
 * - `superseded` / `dismissed` — terminal, no execution authority.
 */
export type HandoffDecisionState =
  | "pending"
  | "approved"
  | "routing"
  | "consumed"
  | "route-failed"
  | "superseded"
  | "dismissed";

export type HandoffPresenter = "browser" | "native";

/** Why the plan was approved. Recorded as evidence, not authority. */
export type HandoffApprovalVia = "native" | "browser" | "recovery" | "command";

/** Why the execution destination was selected. */
export type HandoffSelectionVia = "native" | "command";

export interface HandoffApprovalReceipt {
  at: number;
  via: HandoffApprovalVia;
  /** Optional plan comment carried with an approval (never a denial). */
  feedback?: string;
}

export interface HandoffSelectionReceipt {
  at: number;
  destination: HandoffDestination;
  via: HandoffSelectionVia;
}

/** One applied routing effect. Exactly one per consumed decision. */
export interface HandoffRouteReceipt {
  at: number;
  destination: HandoffDestination;
  /** `direct-build` or `orchestrator-prepare`. */
  route: HandoffRouteKind;
  /** Set when the route was attempted but could not be applied. */
  failure?: string;
  /**
   * True when delivery cannot be proved (a throw after an effect began). Such
   * a failure is never retried automatically.
   */
  uncertain?: boolean;
}

export type HandoffRouteKind = "direct-build" | "orchestrator-start" | "orchestrator-prepare";

export type HandoffRoute =
  | { kind: "direct-build"; planPath: string; decisionId: string; feedback?: string }
  | { kind: "orchestrator-start"; planPath: string; decisionId: string; runHint: string }
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
  /**
   * The destination the user explicitly selected in stage 2. Absent until the
   * execution chooser answers — this is the only execution authority.
   */
  destination?: HandoffDestination;
  state: HandoffDecisionState;
  createdAt: number;
  updatedAt: number;
  /** Set when the plan was approved (stage 1). */
  approvedAt?: number;
  approval?: HandoffApprovalReceipt;
  selection?: HandoffSelectionReceipt;
  /** Present on a restored legacy decision (pre-destination). */
  legacy?: true;
  /** Bounded evidence of applied/failed routes. */
  receipts: HandoffRouteReceipt[];
}

export type HandoffDecisionResult<T = HandoffDecision> =
  | { ok: true; decision: T }
  | {
      ok: false;
      code:
        | "invalid"
        | "wrong-state"
        | "consumed"
        | "dismissed"
        | "superseded"
        | "stale"
        | "unchanged"
        | "not-approved"
        | "no-selection";
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
    value === "approved" ||
    value === "routing" ||
    value === "consumed" ||
    value === "route-failed" ||
    value === "superseded" ||
    value === "dismissed"
  );
}

/** True while a decision still describes work the user can act on. */
export function isHandoffActive(
  decision: HandoffDecision | undefined,
): decision is HandoffDecision {
  return (
    decision !== undefined &&
    (decision.state === "pending" ||
      decision.state === "approved" ||
      decision.state === "routing" ||
      decision.state === "route-failed")
  );
}

/** The plan was approved but no execution route has been applied. */
export function isAwaitingExecution(
  decision: HandoffDecision | undefined,
): decision is HandoffDecision {
  return decision !== undefined && decision.state === "approved";
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
  now: number;
  /** A restored decision keeps its id through reload/recovery. */
  decisionId?: string;
  legacy?: true;
}

/**
 * Creates the `pending` record. A legacy record keeps the destination it was
 * originally shown with (`build`) as the RECOMMENDATION, never as a selection.
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
  const legacy = input.legacy === true;
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
      state: "pending",
      createdAt: input.now,
      updatedAt: input.now,
      receipts: [],
      ...(legacy ? { legacy: true as const } : {}),
    },
  };
}

/**
 * Stage 1: record plan approval. Does NOT choose or apply a destination.
 *
 * Idempotence is by state: a second approval sees `approved` (or later) and is
 * refused, so a duplicate browser event cannot open a second chooser.
 */
export function approveHandoffPlan(
  decision: HandoffDecision,
  input: {
    now: number;
    via: HandoffApprovalVia;
    /** Re-validated approved content; must still match what was shown. */
    planHash?: string;
    /** Approval comment from the presenter (not a denial). */
    feedback?: string;
  },
): HandoffDecisionResult {
  if (decision.state === "consumed") {
    return { ok: false, code: "consumed", error: "this handoff was already applied" };
  }
  if (decision.state === "dismissed") {
    return { ok: false, code: "dismissed", error: "this handoff was dismissed" };
  }
  if (decision.state === "superseded") {
    return { ok: false, code: "superseded", error: "this handoff was superseded" };
  }
  if (decision.state === "route-failed") {
    return {
      ok: false,
      code: "wrong-state",
      error: "this handoff already had an execution attempt",
    };
  }
  if (decision.state === "approved" || decision.state === "routing") {
    return {
      ok: false,
      code: "wrong-state",
      error: "this plan is already approved — choose the execution destination",
    };
  }
  if (input.planHash !== undefined && input.planHash !== decision.planHash) {
    return { ok: false, code: "invalid", error: "the plan changed after it was shown" };
  }
  return {
    ok: true,
    decision: {
      ...decision,
      state: "approved",
      updatedAt: input.now,
      approvedAt: input.now,
      approval: {
        at: input.now,
        via: input.via,
        ...(input.feedback === undefined || input.feedback.trim() === ""
          ? {}
          : { feedback: input.feedback }),
      },
    },
  };
}

/**
 * Stage 2: the user explicitly chose where the approved plan runs.
 *
 * Only an `approved` decision can be selected. A destination is required; a
 * cancellation is the ABSENCE of this transition, never a default.
 */
export function selectHandoffDestination(
  decision: HandoffDecision,
  destination: HandoffDestination,
  now: number,
  via: HandoffSelectionVia = "native",
): HandoffDecisionResult {
  if (decision.state === "pending") {
    return {
      ok: false,
      code: "not-approved",
      error: "the plan is not approved yet",
    };
  }
  if (decision.state === "consumed") {
    return { ok: false, code: "consumed", error: "this handoff was already applied" };
  }
  if (decision.state !== "approved") {
    return {
      ok: false,
      code: "wrong-state",
      error: `this handoff is ${decision.state}`,
    };
  }
  if (!isHandoffDestination(destination)) {
    return { ok: false, code: "invalid", error: "unknown destination" };
  }
  return {
    ok: true,
    decision: {
      ...decision,
      destination,
      updatedAt: now,
      selection: { at: now, destination, via },
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
 * The pure route for a selected destination. Calling this does not consume:
 * the caller persists intent first, then applies the effect, then records the
 * receipt.
 */
export function handoffRouteFor(decision: HandoffDecision): HandoffRoute | undefined {
  if (decision.state !== "routing" && decision.state !== "approved") return undefined;
  const destination = decision.destination;
  if (!destination) return undefined;
  if (destination === "build") {
    return {
      kind: "direct-build",
      planPath: decision.planPath,
      decisionId: decision.decisionId,
      ...(decision.approval?.feedback ? { feedback: decision.approval.feedback } : {}),
    };
  }
  return {
    kind: "orchestrator-prepare",
    planPath: decision.planPath,
    decisionId: decision.decisionId,
    runHint: decision.planHash.slice(0, 16),
  };
}

export type RouteBeginResult =
  | { ok: true; decision: HandoffDecision; route: HandoffRoute }
  | { ok: false; code: "not-approved" | "no-selection" | "wrong-state" | "invalid"; error: string };

/**
 * Persisted routing intent. Marks the decision `routing` and returns the single
 * route to apply. Requires a selected destination that matches `destination`.
 *
 * A `route-failed` decision is retryable only when the last receipt is not
 * uncertain (a proven pre-delivery failure).
 */
export function beginHandoffRoute(
  decision: HandoffDecision,
  input: {
    now: number;
    /** Re-validated approved content; must still match what was shown. */
    planHash?: string;
    /** The destination the caller is about to apply. */
    destination: HandoffDestination;
  },
): RouteBeginResult {
  const retry =
    decision.state === "route-failed" &&
    decision.receipts[decision.receipts.length - 1]?.uncertain !== true;
  if (decision.state !== "approved" && !retry) {
    if (decision.state === "route-failed") {
      return {
        ok: false,
        code: "wrong-state",
        error: "the previous attempt's delivery is uncertain — reconcile before retrying",
      };
    }
    return {
      ok: false,
      code: decision.state === "pending" ? "not-approved" : "wrong-state",
      error: `this handoff is ${decision.state}`,
    };
  }
  if (input.planHash !== undefined && input.planHash !== decision.planHash) {
    return { ok: false, code: "invalid", error: "the plan changed after it was shown" };
  }
  if (!isHandoffDestination(input.destination)) {
    return { ok: false, code: "invalid", error: "unknown destination" };
  }
  if (!decision.destination) {
    return {
      ok: false,
      code: "no-selection",
      error: "choose Orchestrator or direct Build before executing",
    };
  }
  if (decision.destination !== input.destination) {
    return {
      ok: false,
      code: "invalid",
      error: `the selected destination is ${decision.destination}, not ${input.destination}`,
    };
  }
  const routing: HandoffDecision = {
    ...decision,
    state: "routing",
    updatedAt: input.now,
  };
  const route = handoffRouteFor(routing);
  if (!route) {
    return { ok: false, code: "no-selection", error: "no route is available" };
  }
  return { ok: true, decision: routing, route };
}

/**
 * Marks the route applied. Requires `routing` (or a retryable `route-failed`,
 * which `beginHandoffRoute` normalizes first).
 */
export function consumeHandoffRoute(
  decision: HandoffDecision,
  input: {
    now: number;
    route: HandoffRouteKind;
    failure?: string;
    uncertain?: boolean;
  },
): HandoffDecisionResult {
  if (decision.state !== "routing" && decision.state !== "route-failed") {
    return {
      ok: false,
      code: decision.state === "consumed" ? "consumed" : "wrong-state",
      error: `this handoff is ${decision.state}`,
    };
  }
  const destination = decision.destination;
  if (!destination) {
    return { ok: false, code: "no-selection", error: "no destination was selected" };
  }
  const expected = destination === "build" ? "direct-build" : "orchestrator-prepare";
  if (input.route !== expected) {
    return {
      ok: false,
      code: "invalid",
      error: `the destination is ${destination}, not ${input.route}`,
    };
  }
  const receipt: HandoffRouteReceipt = {
    at: input.now,
    destination,
    route: input.route,
    ...(input.failure === undefined ? {} : { failure: input.failure }),
    ...(input.uncertain === true ? { uncertain: true } : {}),
  };
  const failed = input.failure !== undefined;
  return {
    ok: true,
    decision: {
      ...decision,
      state: failed ? "route-failed" : "consumed",
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
  // A routing attempt is never silently superseded: its delivery outcome must
  // be recorded by the route owner.
  if (decision.state === "consumed" || decision.state === "routing") return decision;
  const receipt: HandoffRouteReceipt | undefined =
    reason && decision.destination
      ? {
          at: now,
          destination: decision.destination,
          route:
            decision.destination === "build" ? "direct-build" : "orchestrator-start",
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

/** Dismisses an UNANSWERED plan review. An approval is not dismissible. */
export function dismissHandoffDecision(decision: HandoffDecision, now: number): HandoffDecision {
  if (decision.state !== "pending") return decision;
  return { ...decision, state: "dismissed", updatedAt: now };
}

function parseReceipts(raw: unknown): HandoffRouteReceipt[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(isRecord)
    .flatMap((entry) => {
      if (typeof entry.at !== "number") return [];
      if (!isHandoffDestination(entry.destination)) return [];
      if (entry.route !== "direct-build" && entry.route !== "orchestrator-prepare") {
        return [];
      }
      const failure = bounded(entry.failure, 400);
      return [
        {
          at: entry.at,
          destination: entry.destination,
          route: entry.route,
          ...(failure ? { failure } : {}),
          ...(entry.uncertain === true ? { uncertain: true as const } : {}),
        } satisfies HandoffRouteReceipt,
      ];
    })
    .slice(-MAX_RECEIPTS);
}

/** What every versioned record must carry to be considered at all. */
interface DecisionIdentity {
  decisionId: string;
  planPath: string;
  planHash: string;
  sessionRef: string;
  reviewCycleId: number;
  source: "auto" | "manual";
  presenter: HandoffPresenter;
}

/** Validate the identity/correlation fields shared by all versions. */
function parseIdentity(raw: Record<string, unknown>): DecisionIdentity | undefined {
  const decisionId = bounded(raw.decisionId, MAX_DECISION_ID);
  const planPath = bounded(raw.planPath, MAX_PLAN_PATH);
  const planHash = bounded(raw.planHash, MAX_HASH);
  const sessionRef = bounded(raw.sessionRef, MAX_SESSION_REF);
  if (!decisionId || !planPath || !planHash || !sessionRef) return undefined;
  if (!Number.isInteger(raw.reviewCycleId) || (raw.reviewCycleId as number) < 0) {
    return undefined;
  }
  if (raw.source !== "auto" && raw.source !== "manual") return undefined;
  if (raw.presenter !== "browser" && raw.presenter !== "native") return undefined;
  return {
    decisionId,
    planPath,
    planHash,
    sessionRef,
    reviewCycleId: raw.reviewCycleId as number,
    source: raw.source,
    presenter: raw.presenter,
  };
}

/**
 * v1 → v2. A v1 destination captured at creation is only a RECOMMENDATION; a
 * v1 `consumed` record stays terminal with its original route.
 */
function parseLegacyDecision(raw: Record<string, unknown>): HandoffDecision | undefined {
  const identity = parseIdentity(raw);
  if (!identity) return undefined;
  const legacyDestination = isHandoffDestination(raw.defaultDestination)
    ? raw.defaultDestination
    : isHandoffDestination(raw.destination)
      ? raw.destination
      : undefined;
  if (!legacyDestination) return undefined;
  const legacyState: HandoffDecisionState =
    raw.state === "consumed" || raw.state === "superseded" || raw.state === "dismissed"
      ? raw.state
      : "pending";
  const receipts = parseReceipts(raw.receipts);
  const base: HandoffDecision = {
    version: HANDOFF_DECISION_VERSION,
    ...identity,
    reviewOwned: raw.reviewOwned === true,
    state: legacyState,
    createdAt: typeof raw.createdAt === "number" ? raw.createdAt : 0,
    updatedAt: typeof raw.updatedAt === "number" ? raw.updatedAt : 0,
    receipts,
    ...(raw.legacy === true ? { legacy: true as const } : {}),
  };
  if (legacyState !== "consumed") return base;
  return {
    ...base,
    destination: legacyDestination,
    selection: {
      at: receipts.at(-1)?.at ?? 0,
      destination: legacyDestination,
      via: "native",
    },
  };
}

function parseApproval(raw: unknown): HandoffApprovalReceipt | undefined {
  if (!isRecord(raw) || typeof raw.at !== "number") return undefined;
  const via: HandoffApprovalVia =
    raw.via === "browser" || raw.via === "recovery" || raw.via === "command"
      ? raw.via
      : "native";
  const feedback = bounded(raw.feedback, 4_000);
  return { at: raw.at, via, ...(feedback ? { feedback } : {}) };
}

function parseSelection(raw: unknown): HandoffSelectionReceipt | undefined {
  if (!isRecord(raw) || typeof raw.at !== "number") return undefined;
  if (!isHandoffDestination(raw.destination)) return undefined;
  return {
    at: raw.at,
    destination: raw.destination,
    via: raw.via === "command" ? "command" : "native",
  };
}

/** Current v3 shape: no recommendation fields. */
function parseV3Decision(raw: Record<string, unknown>): HandoffDecision | undefined {
  return parseDecisionBody(raw);
}

/**
 * Version 2 is still readable: its recommendation fields are dropped (they
 * never were execution authority), and an approved/routing record still needs
 * its explicit `destination`.
 */
function parseV2Decision(raw: Record<string, unknown>): HandoffDecision | undefined {
  return parseDecisionBody(raw);
}

function parseDecisionBody(raw: Record<string, unknown>): HandoffDecision | undefined {
  if (!isState(raw.state)) return undefined;
  const identity = parseIdentity(raw);
  if (!identity) return undefined;
  if (raw.destination !== undefined && !isHandoffDestination(raw.destination)) return undefined;
  const destination = isHandoffDestination(raw.destination) ? raw.destination : undefined;
  // Approved/routed states must carry their explicit selection; treating a
  // missing one as a default would execute without consent.
  const needsSelection =
    raw.state === "approved" || raw.state === "routing" || raw.state === "route-failed";
  if (needsSelection && !destination) return undefined;

  const approval = parseApproval(raw.approval);
  const selection = parseSelection(raw.selection);
  return {
    version: HANDOFF_DECISION_VERSION,
    ...identity,
    reviewOwned: raw.reviewOwned === true,
    ...(destination ? { destination } : {}),
    state: raw.state,
    createdAt: typeof raw.createdAt === "number" ? raw.createdAt : 0,
    updatedAt: typeof raw.updatedAt === "number" ? raw.updatedAt : 0,
    ...(typeof raw.approvedAt === "number" ? { approvedAt: raw.approvedAt } : {}),
    ...(approval ? { approval } : {}),
    ...(selection ? { selection } : {}),
    receipts: parseReceipts(raw.receipts),
    ...(raw.legacy === true ? { legacy: true as const } : {}),
  };
}

/**
 * Bounded, validated codec for the persisted workflow entry.
 *
 * Accepts v3 (current), v2 (recommendation fields ignored) and migrates a v1
 * record conservatively: a v1 destination is a recommendation, and a v1
 * `consumed` record stays terminal.
 */
export function parseHandoffDecision(raw: unknown): HandoffDecision | undefined {
  if (!isRecord(raw)) return undefined;
  if (raw.version === HANDOFF_DECISION_VERSION_LEGACY) return parseLegacyDecision(raw);
  if (raw.version === HANDOFF_DECISION_VERSION_V2) return parseV2Decision(raw);
  if (raw.version !== HANDOFF_DECISION_VERSION) return undefined;
  return parseV3Decision(raw);
}
