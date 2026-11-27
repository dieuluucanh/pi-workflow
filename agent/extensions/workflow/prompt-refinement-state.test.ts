import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  REFINEMENT_LIMITS,
  applyRefinementEvent,
  boundIntent,
  canDeliverCandidate,
  createRefinementState,
  isActive,
  isApplied,
  isArmed,
  isDisarmed,
  isModelSuccessOnly,
  refinementDigest,
  type PromptRefinementState,
  type RefinementEvent,
  type RefinementEventResult,
} from "./prompt-refinement-state.ts";

const SESSION = "session-1";
const BINDING = "binding-1";

let requestCounter = 0;

function fresh(enabled = false, now = 100): PromptRefinementState {
  requestCounter = 0;
  return createRefinementState({
    sessionId: SESSION,
    bindingId: BINDING,
    enabled,
    now,
  });
}

/** Build fenced events against the current state snapshot. */
function ev(
  state: PromptRefinementState,
  body: Record<string, unknown>,
): RefinementEvent {
  requestCounter += 1;
  return {
    requestId: `req-${requestCounter}-${Math.random().toString(16).slice(2)}`,
    sessionId: state.sessionId,
    bindingId: state.bindingId,
    expectedGeneration: state.generation,
    at: 1_000 + requestCounter,
    ...body,
  } as RefinementEvent;
}

function ok(result: RefinementEventResult): PromptRefinementState {
  assert.equal(result.ok, true, result.ok ? "" : `${result.code}: ${result.error}`);
  if (!result.ok) throw new Error("unreachable");
  return result.state;
}

function refused(result: RefinementEventResult): {
  code: string;
  error: string;
} {
  assert.equal(result.ok, false, "expected a refusal");
  if (result.ok) throw new Error("unreachable");
  return { code: result.code, error: result.error };
}

function toggleOn(state: PromptRefinementState): PromptRefinementState {
  return ok(applyRefinementEvent(state, ev(state, { type: "control.set", enabled: true })));
}

function start(
  state: PromptRefinementState,
  operationId = "operation-1",
  baseRevision = 7,
): PromptRefinementState {
  return ok(
    applyRefinementEvent(
      state,
      ev(state, {
        type: "operation.start",
        operationId,
        baseRevision,
        intent: {
          originalText: "fix teh bug in the parser",
          intentPoints: ["repair the parser bug"],
          constraints: ["do not change the public API"],
          language: "en",
        },
      }),
    ),
  );
}

function addEvidence(state: PromptRefinementState, id = "ev-1"): PromptRefinementState {
  return ok(
    applyRefinementEvent(
      state,
      ev(state, {
        type: "inspection.evidence",
        operationId: "operation-1",
        evidence: { evidenceId: id, kind: "file", summary: "parser.ts", path: "src/parser.ts" },
      }),
    ),
  );
}

function ask(state: PromptRefinementState): PromptRefinementState {
  return ok(
    applyRefinementEvent(
      state,
      ev(state, {
        type: "clarification.request",
        operationId: "operation-1",
        questions: [
          {
            questionId: "q1",
            prompt: "Which parser?",
            options: ["src/parser.ts", "src/other.ts"],
          },
        ],
      }),
    ),
  );
}

function compose(state: PromptRefinementState): PromptRefinementState {
  return ok(
    applyRefinementEvent(
      state,
      ev(state, { type: "composition.start", operationId: "operation-1" }),
    ),
  );
}

function candidate(
  state: PromptRefinementState,
  text = "Fix the bug in the parser without changing the public API.",
): PromptRefinementState {
  return ok(
    applyRefinementEvent(
      state,
      ev(state, {
        type: "composition.candidate",
        operationId: "operation-1",
        candidateText: text,
        changeSummary: ["Corrected spelling", "Kept the API constraint"],
        suggestions: ["Add a regression test"],
        model: "fake/model",
      }),
    ),
  );
}

function toComposing(): PromptRefinementState {
  let state = toggleOn(fresh());
  state = start(state);
  state = addEvidence(state);
  state = ask(state);
  state = ok(
    applyRefinementEvent(
      state,
      ev(state, {
        type: "clarification.answer",
        operationId: "operation-1",
        answers: ["src/parser.ts"],
        reinspect: false,
      }),
    ),
  );
  return state;
}

function toCandidate(): PromptRefinementState {
  return candidate(toComposing());
}

function toApplying(): PromptRefinementState {
  const ready = toCandidate();
  return ok(
    applyRefinementEvent(
      ready,
      ev(ready, { type: "apply.begin", operationId: "operation-1", baseRevision: 7 }),
    ),
  );
}

function appliedReceipt(
  state: PromptRefinementState,
  body: Record<string, unknown> = {},
) {
  return ev(state, {
    type: "apply.receipt",
    operationId: "operation-1",
    receipt: {
      receiptId: "receipt-1",
      baseRevision: 7,
      candidateDigest: state.operation?.modelResult?.digest ?? "",
      outcome: "applied",
      appliedText: state.operation?.modelResult?.candidateText,
      ...body,
    },
  });
}

// ── construction and lifecycle ───────────────────────────────────────

test("construction: disabled by default, armed when enabled", () => {
  const disabled = fresh(false);
  assert.equal(disabled.schemaVersion, 1);
  assert.equal(disabled.status, "disabled");
  assert.equal(disabled.enabled, false);
  assert.equal(isArmed(disabled), false);
  assert.equal(isActive(disabled), false);
  assert.equal(isDisarmed(disabled), true);

  const armed = fresh(true);
  assert.equal(armed.status, "armed");
  assert.equal(armed.enabled, true);
  assert.equal(isArmed(armed), true);
  assert.equal(isDisarmed(armed), false);
});

test("happy path walks every status to applied and only the receipt disarms", () => {
  let state = fresh(false);
  assert.equal(state.status, "disabled");

  state = toggleOn(state);
  assert.equal(state.status, "armed");

  state = start(state);
  assert.equal(state.status, "inspecting");
  assert.equal(state.operation?.baseRevision, 7);
  assert.deepEqual(state.operation?.intent.intentPoints, ["repair the parser bug"]);

  state = addEvidence(state);
  assert.equal(state.status, "inspecting");
  assert.equal(state.operation?.evidence.length, 1);

  state = ask(state);
  assert.equal(state.status, "clarifying");
  assert.equal(state.operation?.questions.length, 1);

  state = ok(
    applyRefinementEvent(
      state,
      ev(state, {
        type: "clarification.answer",
        operationId: "operation-1",
        answers: ["src/parser.ts"],
        reinspect: false,
      }),
    ),
  );
  assert.equal(state.status, "composing");

  state = candidate(state);
  assert.equal(state.status, "candidate-ready");
  assert.equal(state.enabled, true);
  assert.equal(state.appliedReceipt, undefined);
  assert.equal(isModelSuccessOnly(state), true);
  assert.equal(isApplied(state), false);
  assert.equal(canDeliverCandidate(state), true);

  state = ok(
    applyRefinementEvent(
      state,
      ev(state, { type: "apply.begin", operationId: "operation-1", baseRevision: 7 }),
    ),
  );
  assert.equal(state.status, "applying");

  const ready = state;
  state = ok(applyRefinementEvent(ready, appliedReceipt(ready)));
  assert.equal(state.status, "applied");
  assert.equal(state.enabled, false);
  assert.equal(isApplied(state), true);
  assert.equal(isDisarmed(state), true);
  assert.equal(state.appliedReceipt?.outcome, "applied");
  assert.equal(state.lastOutcome?.kind, "applied");
});

test("generation advances on accepted transitions and never on no-ops", () => {
  const start1 = fresh(true);
  const armedAgain = toggleOn(start1);
  assert.equal(armedAgain.generation, start1.generation);

  const started = start(armedAgain);
  assert.equal(started.generation, armedAgain.generation + 1);
  const withEvidence = addEvidence(started);
  assert.equal(withEvidence.generation, started.generation + 1);
});

// ── idempotence / duplicate requests ─────────────────────────────────

test("duplicate request ids are idempotent and never create a second operation", () => {
  const armed = fresh(true);
  const startEvent = ev(armed, {
    type: "operation.start",
    operationId: "operation-1",
    baseRevision: 7,
    intent: { originalText: "do the thing" },
  });
  const first = ok(applyRefinementEvent(armed, startEvent));
  assert.equal(first.status, "inspecting");

  const replay = applyRefinementEvent(first, startEvent);
  assert.equal(replay.ok, true);
  if (!replay.ok) throw new Error("unreachable");
  assert.equal(replay.duplicate, true);
  assert.equal(replay.state.generation, first.generation);
  assert.equal(replay.state.operation?.operationId, "operation-1");
});

test("duplicate evidence ids and repeated toggles are no-ops", () => {
  let state = start(toggleOn(fresh()));
  state = addEvidence(state, "ev-1");
  const again = ok(applyRefinementEvent(state, ev(state, {
    type: "inspection.evidence",
    operationId: "operation-1",
    evidence: { evidenceId: "ev-1", kind: "file", summary: "different summary" },
  })));
  assert.equal(again.generation, state.generation);
  assert.equal(again.operation?.evidence.length, 1);
  assert.equal(again.operation?.evidence[0].summary, "parser.ts");

  const armed = fresh(true);
  const on1 = toggleOn(armed);
  const on2 = toggleOn(on1);
  assert.equal(on2.generation, on1.generation);
  assert.equal(on2.status, "armed");
});

test("a replayed apply receipt cannot apply twice", () => {
  const applying = toApplying();
  const receipt = appliedReceipt(applying);
  const applied = ok(applyRefinementEvent(applying, receipt));
  assert.equal(applied.status, "applied");
  assert.equal(applied.generation, applying.generation + 1);

  const replay = applyRefinementEvent(applied, receipt);
  assert.equal(replay.ok, true);
  if (!replay.ok) throw new Error("unreachable");
  assert.equal(replay.duplicate, true);
  assert.equal(replay.state.generation, applied.generation);
  assert.equal(replay.state.appliedReceipt?.receiptId, "receipt-1");
});

// ── invalid transitions ──────────────────────────────────────────────

test("invalid transitions are refused without mutation", () => {
  const armed = fresh(true);

  const startWhileDisabled = applyRefinementEvent(fresh(false), ev(fresh(false), {
    type: "operation.start",
    operationId: "operation-1",
    baseRevision: 7,
    intent: { originalText: "x" },
  }));
  assert.equal(refused(startWhileDisabled).code, "illegal_transition");

  const appendBeforeStart = applyRefinementEvent(armed, ev(armed, {
    type: "inspection.evidence",
    operationId: "operation-1",
    evidence: { evidenceId: "ev-1", kind: "file", summary: "x" },
  }));
  assert.equal(refused(appendBeforeStart).code, "stale");

  let state = start(armed);
  const secondStart = applyRefinementEvent(state, ev(state, {
    type: "operation.start",
    operationId: "operation-2",
    baseRevision: 8,
    intent: { originalText: "y" },
  }));
  assert.equal(refused(secondStart).code, "illegal_transition");

  const answerTooEarly = applyRefinementEvent(state, ev(state, {
    type: "clarification.answer",
    operationId: "operation-1",
    answers: ["a"],
    reinspect: false,
  }));
  assert.equal(refused(answerTooEarly).code, "illegal_transition");

  const candidateTooEarly = applyRefinementEvent(state, ev(state, {
    type: "composition.candidate",
    operationId: "operation-1",
    candidateText: "text",
    model: "m",
  }));
  assert.equal(refused(candidateTooEarly).code, "illegal_transition");

  const ready = toCandidate();
  const receiptEarly = applyRefinementEvent(ready, appliedReceipt(ready));
  assert.equal(refused(receiptEarly).code, "illegal_transition");

  state = toApplied();
  const cancelApplied = applyRefinementEvent(state, ev(state, {
    type: "operation.cancel",
    operationId: "operation-1",
    reason: "late",
  }));
  assert.equal(refused(cancelApplied).code, "terminal");
});

function toApplied(): PromptRefinementState {
  const applying = toApplying();
  return ok(applyRefinementEvent(applying, appliedReceipt(applying)));
}

// ── stale fencing ────────────────────────────────────────────────────

test("stale generation, session, binding and operation id are refused", () => {
  const state = start(toggleOn(fresh()));
  const before = state.generation;

  const staleGeneration = applyRefinementEvent(state, {
    ...ev(state, { type: "composition.start", operationId: "operation-1" }),
    expectedGeneration: state.generation - 1,
  });
  assert.equal(refused(staleGeneration).code, "stale");

  const staleSession = applyRefinementEvent(state, {
    ...ev(state, { type: "composition.start", operationId: "operation-1" }),
    sessionId: "session-2",
  });
  assert.equal(refused(staleSession).code, "stale");

  const staleBinding = applyRefinementEvent(state, {
    ...ev(state, { type: "composition.start", operationId: "operation-1" }),
    bindingId: "binding-2",
  });
  assert.equal(refused(staleBinding).code, "stale");

  const foreignOperation = applyRefinementEvent(state, ev(state, {
    type: "inspection.evidence",
    operationId: "operation-9",
    evidence: { evidenceId: "ev-1", kind: "file", summary: "x" },
  }));
  assert.equal(refused(foreignOperation).code, "stale");

  // The original snapshot was never mutated.
  assert.equal(state.status, "inspecting");
  assert.equal(state.generation, before);
  assert.equal(state.operation?.evidence.length, 0);
});

// ── cancellation / arming semantics ─────────────────────────────────

test("explicit toggle-off cancels the live operation and disarms", () => {
  let state = start(toggleOn(fresh()));
  state = ok(applyRefinementEvent(state, ev(state, {
    type: "control.set",
    enabled: false,
  })));
  assert.equal(state.status, "cancelled");
  assert.equal(state.enabled, false);
  assert.equal(isDisarmed(state), true);
  assert.equal(state.lastOutcome?.kind, "cancelled");
  assert.equal(state.lastOutcome?.reason, "toggle-off");
  assert.equal(isActive(state), false);

  // Turning it back on re-arms without resurrecting the operation.
  state = toggleOn(state);
  assert.equal(state.status, "armed");
  assert.equal(state.enabled, true);
});

test("only an applied receipt disarms; cancel, failure and conflict stay armed", () => {
  const running = start(toggleOn(fresh()));
  const cancelled = ok(applyRefinementEvent(running, ev(running, {
    type: "operation.cancel",
    operationId: "operation-1",
    reason: "user",
  })));
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.enabled, true);
  assert.equal(isDisarmed(cancelled), false);

  const composing = toComposing();
  const failed = ok(applyRefinementEvent(composing, ev(composing, {
    type: "operation.fail",
    operationId: "operation-1",
    reason: "provider error",
  })));
  assert.equal(failed.status, "failed");
  assert.equal(failed.enabled, true);
  assert.equal(isDisarmed(failed), false);

  const applying = toApplying();
  const conflicted = ok(applyRefinementEvent(
    applying,
    appliedReceipt(applying, { outcome: "conflict", conflictReason: "base moved" }),
  ));
  assert.equal(conflicted.status, "conflicted");
  assert.equal(conflicted.enabled, true);
  assert.equal(isDisarmed(conflicted), false);
  assert.equal(isApplied(conflicted), false);
  assert.equal(conflicted.appliedReceipt?.outcome, "conflict");

  // A fresh operation may start while still armed after conflict.
  const restarted = ok(applyRefinementEvent(conflicted, ev(conflicted, {
    type: "operation.start",
    operationId: "operation-2",
    baseRevision: 9,
    intent: { originalText: "retry" },
  })));
  assert.equal(restarted.status, "inspecting");
  assert.equal(restarted.enabled, true);
});

test("model output alone does not disarm or create an apply receipt", () => {
  const ready = toCandidate();
  assert.equal(ready.status, "candidate-ready");
  assert.equal(ready.enabled, true);
  assert.equal(ready.appliedReceipt, undefined);
  assert.equal(isModelSuccessOnly(ready), true);
  assert.equal(isApplied(ready), false);
  assert.equal(isDisarmed(ready), false);
});

// ── apply conflict matrix ────────────────────────────────────────────

test("base-revision and digest mismatches become conflicts, not applies", () => {
  const applying = toApplying();

  const baseMismatch = ok(applyRefinementEvent(
    applying,
    appliedReceipt(applying, { baseRevision: 99 }),
  ));
  assert.equal(baseMismatch.status, "conflicted");
  assert.match(baseMismatch.appliedReceipt?.conflictReason ?? "", /base revision/);
  assert.equal(baseMismatch.enabled, true);

  const digestMismatch = ok(applyRefinementEvent(
    applying,
    appliedReceipt(applying, { candidateDigest: "deadbeef" }),
  ));
  assert.equal(digestMismatch.status, "conflicted");
  assert.match(digestMismatch.appliedReceipt?.conflictReason ?? "", /digest/);

  const explicitConflict = ok(applyRefinementEvent(
    applying,
    appliedReceipt(applying, { outcome: "conflict" }),
  ));
  assert.equal(explicitConflict.status, "conflicted");
});

test("apply cannot begin from a truncated candidate", () => {
  const composing = toComposing();
  const oversized = "x".repeat(REFINEMENT_LIMITS.candidateText + 50);
  const ready = candidate(composing, oversized);
  assert.equal(ready.status, "candidate-ready");
  assert.equal(ready.operation?.modelResult?.truncated, true);
  assert.equal(canDeliverCandidate(ready), false);

  const begin = applyRefinementEvent(ready, ev(ready, {
    type: "apply.begin",
    operationId: "operation-1",
    baseRevision: 7,
  }));
  assert.equal(refused(begin).code, "invalid");
});

// ── bounds ───────────────────────────────────────────────────────────

test("intent, evidence and result records are bounded", () => {
  const hugeIntent = boundIntent({
    originalText: "a".repeat(REFINEMENT_LIMITS.originalText + 10),
    intentPoints: Array.from({ length: REFINEMENT_LIMITS.intentPoints + 5 }, () => "b"),
    constraints: ["c".repeat(REFINEMENT_LIMITS.constraintLength + 1)],
  });
  assert.equal(hugeIntent.originalText.length, REFINEMENT_LIMITS.originalText);
  assert.equal(hugeIntent.intentPoints.length, REFINEMENT_LIMITS.intentPoints);
  assert.equal(hugeIntent.truncated, true);

  let state = start(toggleOn(fresh()));
  for (let i = 0; i < REFINEMENT_LIMITS.evidence + 4; i += 1) {
    state = addEvidence(state, `ev-${i}`);
  }
  assert.equal(state.operation?.evidence.length, REFINEMENT_LIMITS.evidence);
  assert.equal(state.operation?.evidenceTruncated, true);
  assert.equal(state.operation?.evidence.at(-1)?.evidenceId, `ev-${REFINEMENT_LIMITS.evidence + 3}`);

  const ready = candidate(toComposing());
  const result = ready.operation?.modelResult;
  assert.equal(result?.model, "fake/model");
  assert.equal(result?.changeSummary.length, 2);
  assert.equal(result?.suggestions.length, 1);
  assert.equal(result?.truncated, false);
});

test("question requests are bounded", () => {
  const state = start(toggleOn(fresh()));
  const questions = Array.from({ length: REFINEMENT_LIMITS.questions + 3 }, (_, i) => ({
    questionId: `q-${i}`,
    prompt: `question ${i}`,
    options: Array.from({ length: REFINEMENT_LIMITS.questionOptions + 3 }, (_, j) => `o-${j}`),
  }));
  const asked = ok(applyRefinementEvent(state, ev(state, {
    type: "clarification.request",
    operationId: "operation-1",
    questions,
  })));
  assert.equal(asked.operation?.questions.length, REFINEMENT_LIMITS.questions);
  assert.equal(
    asked.operation?.questions[0].options.length,
    REFINEMENT_LIMITS.questionOptions,
  );
});

test("digest is deterministic and binds the candidate", () => {
  assert.equal(refinementDigest("same text"), refinementDigest("same text"));
  assert.notEqual(refinementDigest("same text"), refinementDigest("same text "));
  const ready = candidate(toComposing(), "A different candidate.");
  assert.equal(
    ready.operation?.modelResult?.digest,
    refinementDigest("A different candidate."),
  );
});

// ── isolation ────────────────────────────────────────────────────────

test("module is pure and does not reuse Review/Orchestrator/handoff state", () => {
  const source = readFileSync(
    new URL("./prompt-refinement-state.ts", import.meta.url),
    "utf8",
  );
  assert.equal(/^\s*import\s/m.test(source), false, "no imports allowed");
  for (const forbidden of [
    "orchestrator-state",
    "orchestrator-types",
    "review-runtime",
    "review.ts",
    "handoff-view",
    "handoff-routing",
    "session-host",
  ]) {
    assert.equal(source.includes(forbidden), false, `must not reference ${forbidden}`);
  }
});
