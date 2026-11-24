/**
 * Workflow Extension — pure prompt-refinement control state.
 *
 * This module owns the *contracts and transitions* for the composer prompt
 * refinement feature. It is deliberately pure: no clock, filesystem, Pi SDK,
 * session, provider or UI. Callers pass `at` timestamps and receive a new
 * immutable state or a typed refusal.
 *
 * Two independent facts are modelled, because conflating them is the main
 * correctness risk:
 *
 *   - **model success** produces a bounded candidate (`candidate-ready`); it
 *     never edits the composer and never disarms the toggle;
 *   - **composer apply success** is a separate receipt (`applied`); only that
 *     receipt (or an explicit toggle-off) may disarm the control.
 *
 * Everything else — cancellation, failure, a stale apply conflict — leaves the
 * toggle armed so the user can retry. No Review-mode, handoff or Orchestrator
 * state is imported or reused here; those are separate authorities.
 *
 * Fencing: every mutating event carries the exact `sessionId`, `bindingId`,
 * `generation` it was computed against. A mismatch is refused as `stale`
 * without mutation. Replaying a request id is idempotent and never re-applies
 * a candidate.
 */

export const PROMPT_REFINEMENT_SCHEMA_VERSION = 1 as const;

// ── Statuses ─────────────────────────────────────────────────────────

export const REFINEMENT_STATUSES = [
  "disabled",
  "armed",
  "inspecting",
  "clarifying",
  "composing",
  "candidate-ready",
  "applying",
  "applied",
  "cancelled",
  "failed",
  "conflicted",
] as const;

export type RefinementStatus = (typeof REFINEMENT_STATUSES)[number];

/** Statuses that own a live operation and can be cancelled/failed. */
export const ACTIVE_REFINEMENT_STATUSES: ReadonlySet<RefinementStatus> = new Set([
  "inspecting",
  "clarifying",
  "composing",
  "candidate-ready",
  "applying",
]);

/** Statuses after which a fresh operation may start (toggle already on). */
export const RESTARTABLE_REFINEMENT_STATUSES: ReadonlySet<RefinementStatus> = new Set([
  "armed",
  "cancelled",
  "failed",
  "conflicted",
]);

export function isRefinementStatus(value: unknown): value is RefinementStatus {
  return (
    typeof value === "string" &&
    (REFINEMENT_STATUSES as readonly string[]).includes(value)
  );
}

export function isActiveRefinementStatus(status: RefinementStatus): boolean {
  return ACTIVE_REFINEMENT_STATUSES.has(status);
}

// ── Bounds ───────────────────────────────────────────────────────────

/**
 * Hard ceilings for every retained record. They are intentionally small: the
 * refinement transcript is metadata, not a second conversation log.
 */
export const REFINEMENT_LIMITS = {
  originalText: 8_000,
  intentPoints: 16,
  intentPointLength: 400,
  constraints: 16,
  constraintLength: 400,
  evidence: 32,
  evidenceSummary: 1_000,
  questions: 8,
  questionPrompt: 500,
  questionOptions: 8,
  questionOptionLength: 300,
  answers: 8,
  answerLength: 1_000,
  candidateText: 24_000,
  changeSummary: 12,
  changeSummaryLength: 400,
  suggestions: 12,
  suggestionLength: 400,
  requestIds: 64,
} as const;

// ── Bounded records ──────────────────────────────────────────────────

export interface BoundedText {
  text: string;
  truncated: boolean;
}

function boundText(value: unknown, max: number): BoundedText {
  const text = typeof value === "string" ? value : "";
  if (text.length <= max) return { text, truncated: false };
  return { text: text.slice(0, max), truncated: true };
}

function boundList(
  values: unknown,
  maxItems: number,
  maxLength: number,
): { items: string[]; truncated: boolean } {
  if (!Array.isArray(values)) return { items: [], truncated: false };
  let truncated = false;
  const items: string[] = [];
  for (const value of values) {
    if (items.length >= maxItems) {
      truncated = true;
      break;
    }
    if (typeof value !== "string") continue;
    const bounded = boundText(value, maxLength);
    if (bounded.truncated) truncated = true;
    items.push(bounded.text);
  }
  return { items, truncated };
}

export interface RefinementIntentRecord {
  originalText: string;
  intentPoints: string[];
  constraints: string[];
  language?: string;
  truncated: boolean;
}

export interface RefinementIntentInput {
  originalText: string;
  intentPoints?: string[];
  constraints?: string[];
  language?: string;
}

export function boundIntent(input: RefinementIntentInput): RefinementIntentRecord {
  const original = boundText(input.originalText, REFINEMENT_LIMITS.originalText);
  const points = boundList(
    input.intentPoints,
    REFINEMENT_LIMITS.intentPoints,
    REFINEMENT_LIMITS.intentPointLength,
  );
  const constraints = boundList(
    input.constraints,
    REFINEMENT_LIMITS.constraints,
    REFINEMENT_LIMITS.constraintLength,
  );
  const language = boundText(input.language, 40);
  return {
    originalText: original.text,
    intentPoints: points.items,
    constraints: constraints.items,
    ...(language.text ? { language: language.text } : {}),
    truncated: original.truncated || points.truncated || constraints.truncated || language.truncated,
  };
}

export type RefinementEvidenceKind =
  | "file"
  | "search"
  | "context"
  | "question"
  | "answer";

export interface RefinementEvidenceRecord {
  evidenceId: string;
  kind: RefinementEvidenceKind;
  summary: string;
  path?: string;
  at: number;
  truncated: boolean;
}

export interface RefinementEvidenceInput {
  evidenceId: string;
  kind: RefinementEvidenceKind;
  summary: string;
  path?: string;
}

export interface RefinementQuestion {
  questionId: string;
  prompt: string;
  options: string[];
}

export const REFINEMENT_QUESTION_HEADERS = [
  "Clarify",
  "Scope",
  "Intent",
  "Evidence",
] as const;

export interface ModelResultRecord {
  /** Exactly the model's candidate prose, before any composer write. */
  candidateText: string;
  /** Short, user-visible summary of what changed. */
  changeSummary: string[];
  /** Optional ideas that are NOT requirements until the user accepts them. */
  suggestions: string[];
  model: string;
  modelOutputAt: number;
  /** Stable digest used to bind an apply receipt to this exact candidate. */
  digest: string;
  truncated: boolean;
}

export interface ApplyAttempt {
  baseRevision: number;
  startedAt: number;
}

export type ApplyReceiptOutcome = "applied" | "conflict";

export interface ApplyReceipt {
  receiptId: string;
  operationId: string;
  sessionId: string;
  bindingId: string;
  baseRevision: number;
  candidateDigest: string;
  outcome: ApplyReceiptOutcome;
  appliedAt: number;
  /** Digest of the text actually committed by the composer, if any. */
  appliedDigest?: string;
  conflictReason?: string;
}

export interface RefinementOperation {
  operationId: string;
  sessionId: string;
  bindingId: string;
  baseRevision: number;
  intent: RefinementIntentRecord;
  evidence: RefinementEvidenceRecord[];
  evidenceTruncated: boolean;
  questions: RefinementQuestion[];
  answers: string[];
  modelResult?: ModelResultRecord;
  applyAttempt?: ApplyAttempt;
}

export type RefinementOutcomeKind =
  | "cancelled"
  | "failed"
  | "conflicted"
  | "applied";

export interface RefinementOutcome {
  kind: RefinementOutcomeKind;
  reason: string;
  at: number;
}

// ── State ────────────────────────────────────────────────────────────

export interface PromptRefinementState {
  schemaVersion: typeof PROMPT_REFINEMENT_SCHEMA_VERSION;
  sessionId: string;
  bindingId: string;
  /** The toggle itself. Independent from `status`. */
  enabled: boolean;
  status: RefinementStatus;
  /** Bumped by every accepted mutation; stale events are refused. */
  generation: number;
  operation?: RefinementOperation;
  lastOutcome?: RefinementOutcome;
  /** The one receipt that is allowed to auto-disarm. */
  appliedReceipt?: ApplyReceipt;
  /** Bounded replay window for idempotent request handling. */
  seenRequestIds: string[];
  createdAt: number;
  updatedAt: number;
}

// ── Events ───────────────────────────────────────────────────────────

export interface RefinementEventBase {
  /** Client-generated idempotency key. Replays are no-ops. */
  requestId: string;
  sessionId: string;
  bindingId: string;
  /** The generation the caller observed. */
  expectedGeneration: number;
  at: number;
}

export type RefinementEvent =
  | (RefinementEventBase & { type: "control.set"; enabled: boolean })
  | (RefinementEventBase & {
      type: "operation.start";
      operationId: string;
      baseRevision: number;
      intent: RefinementIntentInput;
    })
  | (RefinementEventBase & {
      type: "inspection.evidence";
      operationId: string;
      evidence: RefinementEvidenceInput;
    })
  | (RefinementEventBase & {
      type: "clarification.request";
      operationId: string;
      questions: RefinementQuestion[];
    })
  | (RefinementEventBase & {
      type: "clarification.answer";
      operationId: string;
      answers: string[];
      reinspect: boolean;
    })
  | (RefinementEventBase & {
      type: "composition.start";
      operationId: string;
    })
  | (RefinementEventBase & {
      type: "composition.candidate";
      operationId: string;
      candidateText: string;
      changeSummary?: string[];
      suggestions?: string[];
      model: string;
    })
  | (RefinementEventBase & {
      type: "apply.begin";
      operationId: string;
      baseRevision: number;
    })
  | (RefinementEventBase & {
      type: "apply.receipt";
      operationId: string;
      receipt: {
        receiptId: string;
        baseRevision: number;
        candidateDigest: string;
        outcome: ApplyReceiptOutcome;
        appliedText?: string;
        conflictReason?: string;
      };
    })
  | (RefinementEventBase & {
      type: "operation.cancel";
      operationId: string;
      reason: string;
    })
  | (RefinementEventBase & {
      type: "operation.fail";
      operationId: string;
      reason: string;
    });

export type RefinementEventType = RefinementEvent["type"];

export type RefinementEventErrorCode =
  | "invalid"
  | "stale"
  | "illegal_transition"
  | "terminal";

export type RefinementEventResult =
  | { ok: true; state: PromptRefinementState; duplicate?: boolean }
  | { ok: false; code: RefinementEventErrorCode; error: string };

// ── Construction ─────────────────────────────────────────────────────

export interface CreateRefinementStateInput {
  sessionId: string;
  bindingId: string;
  enabled?: boolean;
  now?: number;
}

export function createRefinementState(
  input: CreateRefinementStateInput,
): PromptRefinementState {
  const now = input.now ?? 0;
  const enabled = input.enabled === true;
  return {
    schemaVersion: PROMPT_REFINEMENT_SCHEMA_VERSION,
    sessionId: input.sessionId,
    bindingId: input.bindingId,
    enabled,
    status: enabled ? "armed" : "disabled",
    generation: 1,
    seenRequestIds: [],
    createdAt: now,
    updatedAt: now,
  };
}

// ── Pure helpers ─────────────────────────────────────────────────────

/** Deterministic, dependency-free digest for candidate/apply identity. */
export function refinementDigest(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

export function isArmed(state: PromptRefinementState): boolean {
  return state.enabled && state.status === "armed";
}

export function isActive(state: PromptRefinementState): boolean {
  return isActiveRefinementStatus(state.status);
}

export function isDisarmed(state: PromptRefinementState): boolean {
  return !state.enabled;
}

/** A candidate is deliverable only if it is non-empty and not truncated. */
export function canDeliverCandidate(state: PromptRefinementState): boolean {
  if (state.status !== "candidate-ready") return false;
  const result = state.operation?.modelResult;
  if (!result) return false;
  if (result.truncated) return false;
  return result.candidateText.trim().length > 0;
}

/** True when the model produced a candidate that has NOT been applied yet. */
export function isModelSuccessOnly(state: PromptRefinementState): boolean {
  return (
    state.status === "candidate-ready" &&
    state.operation?.modelResult !== undefined &&
    state.appliedReceipt === undefined
  );
}

/** True only for a receipt-backed composer apply. */
export function isApplied(state: PromptRefinementState): boolean {
  return state.status === "applied" && state.appliedReceipt?.outcome === "applied";
}

// ── Reducer internals ────────────────────────────────────────────────

function fail(code: RefinementEventErrorCode, error: string): RefinementEventResult {
  return { ok: false, code, error };
}

function fenceMatches(state: PromptRefinementState, event: RefinementEventBase): boolean {
  return (
    state.sessionId === event.sessionId &&
    state.bindingId === event.bindingId &&
    state.generation === event.expectedGeneration
  );
}

function operationMatches(
  state: PromptRefinementState,
  operationId: string,
): boolean {
  return state.operation?.operationId === operationId;
}

function rememberRequest(
  state: PromptRefinementState,
  requestId: string,
): string[] {
  const next = [...state.seenRequestIds, requestId];
  const overflow = next.length - REFINEMENT_LIMITS.requestIds;
  return overflow > 0 ? next.slice(overflow) : next;
}

function noop(
  state: PromptRefinementState,
  requestId: string,
  duplicate = false,
): RefinementEventResult {
  return {
    ok: true,
    state: {
      ...state,
      seenRequestIds: rememberRequest(state, requestId),
    },
    ...(duplicate ? { duplicate: true } : {}),
  };
}

function advance(
  state: PromptRefinementState,
  requestId: string,
  patch: Partial<PromptRefinementState>,
  at: number,
): RefinementEventResult {
  return {
    ok: true,
    state: {
      ...state,
      ...patch,
      generation: state.generation + 1,
      updatedAt: at,
      seenRequestIds: rememberRequest(state, requestId),
    },
  };
}

function boundQuestions(
  questions: RefinementQuestion[],
): RefinementQuestion[] {
  const bounded: RefinementQuestion[] = [];
  for (const question of questions) {
    if (bounded.length >= REFINEMENT_LIMITS.questions) break;
    const prompt = boundText(question.prompt, REFINEMENT_LIMITS.questionPrompt);
    const options = boundList(
      question.options,
      REFINEMENT_LIMITS.questionOptions,
      REFINEMENT_LIMITS.questionOptionLength,
    );
    bounded.push({
      questionId: question.questionId,
      prompt: prompt.text,
      options: options.items,
    });
  }
  return bounded;
}

function boundEvidence(
  input: RefinementEvidenceInput,
  at: number,
): RefinementEvidenceRecord {
  const summary = boundText(input.summary, REFINEMENT_LIMITS.evidenceSummary);
  const path = boundText(input.path, 1_024);
  return {
    evidenceId: input.evidenceId,
    kind: input.kind,
    summary: summary.text,
    ...(path.text ? { path: path.text } : {}),
    at,
    truncated: summary.truncated || path.truncated,
  };
}

// ── Reducer ──────────────────────────────────────────────────────────

export function applyRefinementEvent(
  state: PromptRefinementState,
  event: RefinementEvent,
): RefinementEventResult {
  if (state.schemaVersion !== PROMPT_REFINEMENT_SCHEMA_VERSION) {
    return fail("invalid", "unsupported prompt-refinement schema version");
  }

  // Idempotency first: a replay must never depend on the live generation.
  if (state.seenRequestIds.includes(event.requestId)) {
    return noop(state, event.requestId, true);
  }

  if (!fenceMatches(state, event)) {
    return fail("stale", "the session, binding or generation is stale");
  }

  switch (event.type) {
    // ── control ────────────────────────────────────────────────────
    case "control.set": {
      if (event.enabled === state.enabled) {
        // Repeated toggle-on/off is a no-op, never a second operation.
        if (event.enabled) {
          if (state.status === "armed" || isActive(state)) {
            return noop(state, event.requestId);
          }
          // Re-affirming an already-enabled settled state re-arms it.
          if (
            state.status === "cancelled" ||
            state.status === "failed" ||
            state.status === "conflicted"
          ) {
            return advance(
              state,
              event.requestId,
              { status: "armed", operation: undefined },
              event.at,
            );
          }
          return noop(state, event.requestId);
        }
        // Already disarmed.
        if (state.status === "disabled" || state.status === "applied") {
          return noop(state, event.requestId);
        }
        return noop(state, event.requestId);
      }

      if (event.enabled) {
        if (isActive(state)) {
          return noop(state, event.requestId);
        }
        return advance(
          state,
          event.requestId,
          {
            enabled: true,
            status: "armed",
            operation: undefined,
          },
          event.at,
        );
      }

      // Explicit toggle-off: cancel any live operation and disarm. This is the
      // only user gesture besides an applied receipt that disarms.
      if (isActive(state)) {
        return advance(
          state,
          event.requestId,
          {
            enabled: false,
            status: "cancelled",
            lastOutcome: {
              kind: "cancelled",
              reason: "toggle-off",
              at: event.at,
            },
          },
          event.at,
        );
      }
      return advance(
        state,
        event.requestId,
        {
          enabled: false,
          status: "disabled",
          operation: undefined,
        },
        event.at,
      );
    }

    // ── operation lifecycle ───────────────────────────────────────
    case "operation.start": {
      if (!state.enabled) {
        return fail("illegal_transition", "refinement is disabled");
      }
      if (!RESTARTABLE_REFINEMENT_STATUSES.has(state.status)) {
        if (isActive(state)) {
          return fail("illegal_transition", "an operation is already active");
        }
        return fail(
          "illegal_transition",
          `cannot start an operation from ${state.status}`,
        );
      }
      if (!event.operationId) {
        return fail("invalid", "an operation id is required");
      }
      if (!Number.isInteger(event.baseRevision) || event.baseRevision < 0) {
        return fail("invalid", "baseRevision must be a non-negative integer");
      }
      const operation: RefinementOperation = {
        operationId: event.operationId,
        sessionId: state.sessionId,
        bindingId: state.bindingId,
        baseRevision: event.baseRevision,
        intent: boundIntent(event.intent),
        evidence: [],
        evidenceTruncated: false,
        questions: [],
        answers: [],
      };
      return advance(
        state,
        event.requestId,
        {
          status: "inspecting",
          operation,
          appliedReceipt: undefined,
          lastOutcome: undefined,
        },
        event.at,
      );
    }

    case "inspection.evidence": {
      if (!operationMatches(state, event.operationId)) {
        return fail("stale", "the operation id is stale");
      }
      if (state.status !== "inspecting") {
        return fail(
          "illegal_transition",
          `evidence is not accepted in ${state.status}`,
        );
      }
      const operation = state.operation!;
      if (operation.evidence.some((item) => item.evidenceId === event.evidence.evidenceId)) {
        return noop(state, event.requestId, true);
      }
      const evidence = [...operation.evidence, boundEvidence(event.evidence, event.at)];
      const overflow = evidence.length - REFINEMENT_LIMITS.evidence;
      return advance(
        state,
        event.requestId,
        {
          operation: {
            ...operation,
            evidence: overflow > 0 ? evidence.slice(overflow) : evidence,
            evidenceTruncated: operation.evidenceTruncated || overflow > 0,
          },
        },
        event.at,
      );
    }

    case "clarification.request": {
      if (!operationMatches(state, event.operationId)) {
        return fail("stale", "the operation id is stale");
      }
      if (state.status !== "inspecting" && state.status !== "clarifying") {
        return fail(
          "illegal_transition",
          `clarification is not available in ${state.status}`,
        );
      }
      if (!Array.isArray(event.questions) || event.questions.length === 0) {
        return fail("invalid", "at least one question is required");
      }
      return advance(
        state,
        event.requestId,
        {
          status: "clarifying",
          operation: {
            ...state.operation!,
            questions: boundQuestions(event.questions),
            answers: [],
          },
        },
        event.at,
      );
    }

    case "clarification.answer": {
      if (!operationMatches(state, event.operationId)) {
        return fail("stale", "the operation id is stale");
      }
      if (state.status !== "clarifying") {
        return fail(
          "illegal_transition",
          `answers are not accepted in ${state.status}`,
        );
      }
      const answers = boundList(
        event.answers,
        REFINEMENT_LIMITS.answers,
        REFINEMENT_LIMITS.answerLength,
      );
      return advance(
        state,
        event.requestId,
        {
          status: event.reinspect ? "inspecting" : "composing",
          operation: {
            ...state.operation!,
            answers: answers.items,
          },
        },
        event.at,
      );
    }

    case "composition.start": {
      if (!operationMatches(state, event.operationId)) {
        return fail("stale", "the operation id is stale");
      }
      if (state.status !== "inspecting" && state.status !== "clarifying") {
        return fail(
          "illegal_transition",
          `composition cannot start from ${state.status}`,
        );
      }
      return advance(
        state,
        event.requestId,
        { status: "composing" },
        event.at,
      );
    }

    case "composition.candidate": {
      if (!operationMatches(state, event.operationId)) {
        return fail("stale", "the operation id is stale");
      }
      if (state.status !== "composing") {
        return fail(
          "illegal_transition",
          `a candidate is not accepted in ${state.status}`,
        );
      }
      const candidate = boundText(
        event.candidateText,
        REFINEMENT_LIMITS.candidateText,
      );
      if (candidate.text.trim().length === 0) {
        return fail("invalid", "a candidate must not be empty");
      }
      const changeSummary = boundList(
        event.changeSummary,
        REFINEMENT_LIMITS.changeSummary,
        REFINEMENT_LIMITS.changeSummaryLength,
      );
      const suggestions = boundList(
        event.suggestions,
        REFINEMENT_LIMITS.suggestions,
        REFINEMENT_LIMITS.suggestionLength,
      );
      const result: ModelResultRecord = {
        candidateText: candidate.text,
        changeSummary: changeSummary.items,
        suggestions: suggestions.items,
        model: boundText(event.model, 200).text,
        modelOutputAt: event.at,
        digest: refinementDigest(candidate.text),
        truncated:
          candidate.truncated || changeSummary.truncated || suggestions.truncated,
      };
      // Model success only: status becomes candidate-ready, the toggle stays on
      // and no apply receipt exists.
      return advance(
        state,
        event.requestId,
        {
          status: "candidate-ready",
          operation: {
            ...state.operation!,
            modelResult: result,
          },
        },
        event.at,
      );
    }

    case "apply.begin": {
      if (!operationMatches(state, event.operationId)) {
        return fail("stale", "the operation id is stale");
      }
      if (state.status !== "candidate-ready") {
        return fail(
          "illegal_transition",
          `apply cannot begin from ${state.status}`,
        );
      }
      if (!canDeliverCandidate(state)) {
        return fail("invalid", "the candidate is not deliverable");
      }
      if (!Number.isInteger(event.baseRevision) || event.baseRevision < 0) {
        return fail("invalid", "baseRevision must be a non-negative integer");
      }
      return advance(
        state,
        event.requestId,
        {
          status: "applying",
          operation: {
            ...state.operation!,
            applyAttempt: {
              baseRevision: event.baseRevision,
              startedAt: event.at,
            },
          },
        },
        event.at,
      );
    }

    case "apply.receipt": {
      if (!operationMatches(state, event.operationId)) {
        return fail("stale", "the operation id is stale");
      }
      // A receipt that has already been consumed is idempotent even if the
      // caller minted a new request id.
      if (state.appliedReceipt?.receiptId === event.receipt.receiptId) {
        return noop(state, event.requestId, true);
      }
      if (state.status !== "applying") {
        return fail(
          "illegal_transition",
          `an apply receipt is not accepted in ${state.status}`,
        );
      }
      const operation = state.operation!;
      const attempt = operation.applyAttempt;
      const candidate = operation.modelResult;
      if (!attempt || !candidate) {
        return fail("invalid", "the operation has no apply attempt or candidate");
      }
      const receipt = event.receipt;
      const baseMismatch = receipt.baseRevision !== attempt.baseRevision;
      const digestMismatch = receipt.candidateDigest !== candidate.digest;
      const conflict =
        receipt.outcome === "conflict" || baseMismatch || digestMismatch;

      const record: ApplyReceipt = {
        receiptId: receipt.receiptId,
        operationId: operation.operationId,
        sessionId: state.sessionId,
        bindingId: state.bindingId,
        baseRevision: receipt.baseRevision,
        candidateDigest: receipt.candidateDigest,
        outcome: conflict ? "conflict" : "applied",
        appliedAt: event.at,
        ...(conflict
          ? {
              conflictReason:
                receipt.conflictReason ??
                (baseMismatch
                  ? "the composer base revision changed"
                  : digestMismatch
                    ? "the candidate digest changed"
                    : "the composer refused the apply"),
            }
          : {
              appliedDigest: refinementDigest(receipt.appliedText ?? candidate.candidateText),
            }),
      };

      if (conflict) {
        // A conflict never disarms: the user may retry or explicitly turn off.
        return advance(
          state,
          event.requestId,
          {
            status: "conflicted",
            appliedReceipt: record,
            lastOutcome: {
              kind: "conflicted",
              reason: record.conflictReason ?? "apply conflict",
              at: event.at,
            },
          },
          event.at,
        );
      }

      // The single auto-disarm path.
      return advance(
        state,
        event.requestId,
        {
          enabled: false,
          status: "applied",
          appliedReceipt: record,
          lastOutcome: {
            kind: "applied",
            reason: "composer apply receipt",
            at: event.at,
          },
        },
        event.at,
      );
    }

    case "operation.cancel": {
      if (!operationMatches(state, event.operationId)) {
        return fail("stale", "the operation id is stale");
      }
      if (state.status === "applied") {
        return fail("terminal", "the operation is already applied");
      }
      if (!isActive(state)) {
        return fail(
          "illegal_transition",
          `cancellation is not available in ${state.status}`,
        );
      }
      // Cancellation keeps the toggle armed unless the caller used
      // `control.set` off, which is the explicit disarm path.
      return advance(
        state,
        event.requestId,
        {
          status: "cancelled",
          lastOutcome: {
            kind: "cancelled",
            reason: event.reason,
            at: event.at,
          },
        },
        event.at,
      );
    }

    case "operation.fail": {
      if (!operationMatches(state, event.operationId)) {
        return fail("stale", "the operation id is stale");
      }
      if (state.status === "applied") {
        return fail("terminal", "the operation is already applied");
      }
      if (!isActive(state)) {
        return fail(
          "illegal_transition",
          `failure is not accepted in ${state.status}`,
        );
      }
      return advance(
        state,
        event.requestId,
        {
          status: "failed",
          lastOutcome: {
            kind: "failed",
            reason: event.reason,
            at: event.at,
          },
        },
        event.at,
      );
    }

    default: {
      return fail("invalid", "unknown prompt-refinement event");
    }
  }
}
