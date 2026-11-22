/**
 * Handoff decision + routing tests (plan step 4).
 *
 * The record is what makes "approve once" true across browser, native and
 * reload-recovery paths: identity, the destination captured when shown, a
 * one-off override that never writes settings, and a single consume.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  HANDOFF_DECISION_VERSION,
  consumeHandoffDecision,
  createHandoffDecision,
  dismissHandoffDecision,
  handoffDecisionId,
  handoffDecisionMatches,
  handoffRouteFor,
  isHandoffDestination,
  overrideHandoffDestination,
  parseHandoffDecision,
  supersedeHandoffDecision,
  type HandoffDecision,
} from "./handoff-routing.ts";

const BASE = {
  planPath: "C:/work/.pi/plans/2026-11-21-x.md",
  planHash: "a".repeat(64),
  sessionRef: "session-a",
  reviewCycleId: 4,
  source: "auto" as const,
  presenter: "native" as const,
  reviewOwned: false,
  defaultDestination: "orchestrator" as "orchestrator" | "build",
  now: 1_000,
};

function created(
  over: Partial<typeof BASE> & { legacy?: true } = {},
): HandoffDecision {
  const result = createHandoffDecision({ ...BASE, ...over });
  assert.equal(result.ok, true, result.ok ? "" : result.error);
  return (result as { ok: true; decision: HandoffDecision }).decision;
}

test("decision: identity is stable for the same handoff and changes with content", () => {
  const a = created();
  const b = created();
  assert.equal(a.decisionId, b.decisionId);
  assert.equal(a.state, "pending");
  assert.equal(a.destination, "orchestrator", "the captured default applies");
  assert.equal(a.overrideRevision, 0);

  const otherHash = created({ planHash: "b".repeat(64) });
  assert.notEqual(otherHash.decisionId, a.decisionId);
  const otherCycle = created({ reviewCycleId: 5 });
  assert.notEqual(otherCycle.decisionId, a.decisionId);
  assert.match(a.decisionId, /^handoff-[0-9a-f]{8}$/);
  assert.equal(
    handoffDecisionId({
      sessionRef: "session-a",
      reviewCycleId: 4,
      planPath: BASE.planPath,
      planHash: BASE.planHash,
    }),
    a.decisionId,
  );
});

test("decision: invalid identity fails closed", () => {
  for (const broken of [
    { planPath: "" },
    { planHash: "" },
    { sessionRef: "  " },
    { reviewCycleId: -1 },
    { reviewCycleId: 1.5 },
    { defaultDestination: "auto" as never },
  ]) {
    const result = createHandoffDecision({ ...BASE, ...broken });
    assert.equal(result.ok, false, JSON.stringify(broken));
  }
});

test("decision: legacy pending approvals keep Build, whatever the new default is", () => {
  const legacy = created({ legacy: true, defaultDestination: "orchestrator" });
  assert.equal(legacy.destination, "build");
  assert.equal(legacy.defaultDestination, "build");
  assert.equal(legacy.legacy, true);
  assert.deepEqual(handoffRouteFor(legacy), {
    kind: "direct-build",
    planPath: BASE.planPath,
    decisionId: legacy.decisionId,
  });
});

test("decision: a one-off override retargets only this record", () => {
  const decision = created();
  const override = overrideHandoffDestination(decision, "build", 1_100);
  assert.equal(override.ok, true);
  if (!override.ok) return;
  assert.equal(override.decision.destination, "build");
  assert.equal(override.decision.overrideRevision, 1);
  assert.equal(override.decision.defaultDestination, "orchestrator", "settings untouched");
  assert.equal(override.decision.legacy, undefined, "an explicit choice is not legacy");

  // Same destination twice is a no-op, not a silent second revision.
  const again = overrideHandoffDestination(override.decision, "build", 1_200);
  assert.equal(again.ok, false);
  assert.equal((again as any).code, "unchanged");

  // A later override in the other direction still works and bumps the revision.
  const back = overrideHandoffDestination(override.decision, "orchestrator", 1_300);
  assert.equal(back.ok, true);
  if (back.ok) assert.equal(back.decision.overrideRevision, 2);
});

test("decision: consumed, dismissed and superseded handoffs cannot be retargeted", () => {
  const decision = created();
  const consumed = consumeHandoffDecision(decision, { now: 1_100, route: "orchestrator-prepare" });
  assert.equal(consumed.ok, true);
  if (!consumed.ok) return;
  assert.equal(consumed.decision.state, "consumed");
  assert.equal(consumed.decision.receipts.length, 1);
  assert.deepEqual(overrideHandoffDestination(consumed.decision, "build", 1_200), {
    ok: false,
    code: "consumed",
    error: "this handoff was already approved — change the default for the next one",
  });

  const dismissed = dismissHandoffDecision(decision, 1_100);
  assert.equal(dismissed.state, "dismissed");
  assert.equal((overrideHandoffDestination(dismissed, "build", 1_200) as any).code, "dismissed");

  const superseded = supersedeHandoffDecision(decision, 1_100, "a newer prompt");
  assert.equal(superseded.state, "superseded");
  assert.equal(superseded.receipts.at(-1)?.failure, "a newer prompt");
});

test("decision: consume happens exactly once and the route must match the destination", () => {
  const decision = created();
  const wrong = consumeHandoffDecision(decision, { now: 1_100, route: "direct-build" });
  assert.equal(wrong.ok, false);
  assert.equal((wrong as any).code, "invalid");
  assert.equal(decision.state, "pending", "a failed consume leaves the decision intact");

  const changedPlan = consumeHandoffDecision(decision, {
    now: 1_100,
    route: "orchestrator-prepare",
    planHash: "c".repeat(64),
  });
  assert.equal(changedPlan.ok, false);
  assert.equal((changedPlan as any).code, "invalid");

  const first = consumeHandoffDecision(decision, {
    now: 1_100,
    route: "orchestrator-prepare",
    planHash: BASE.planHash,
  });
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.equal(first.route.kind, "orchestrator-prepare");

  const second = consumeHandoffDecision(first.decision, {
    now: 1_200,
    route: "orchestrator-prepare",
  });
  assert.equal(second.ok, false);
  assert.equal((second as any).code, "not_pending");
});

test("decision: a consumed failure keeps the attempt visible without authorising a retry", () => {
  const decision = created({ defaultDestination: "build" });
  const result = consumeHandoffDecision(decision, {
    now: 1_100,
    route: "direct-build",
    failure: "Build mode was not entered",
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.decision.state, "consumed");
  assert.equal(result.decision.receipts[0]?.failure, "Build mode was not entered");
});

test("decision: match rejects a stale path, hash or cycle", () => {
  const decision = created();
  assert.equal(handoffDecisionMatches(decision, {}), true);
  assert.equal(handoffDecisionMatches(decision, { planPath: BASE.planPath }), true);
  assert.equal(handoffDecisionMatches(decision, { planPath: "other.md" }), false);
  assert.equal(handoffDecisionMatches(decision, { planHash: "d".repeat(64) }), false);
  assert.equal(handoffDecisionMatches(decision, { reviewCycleId: 9 }), false);
});

test("decision: the persisted codec round-trips and rejects unknown/corrupt records", () => {
  const decision = overrideHandoffDestination(created(), "build", 1_100);
  assert.equal(decision.ok, true);
  if (!decision.ok) return;
  const consumed = consumeHandoffDecision(decision.decision, { now: 1_200, route: "direct-build" });
  assert.equal(consumed.ok, true);
  if (!consumed.ok) return;

  const parsed = parseHandoffDecision(JSON.parse(JSON.stringify(consumed.decision)));
  assert.deepEqual(parsed, consumed.decision);

  assert.equal(parseHandoffDecision(undefined), undefined);
  assert.equal(parseHandoffDecision({ ...consumed.decision, version: 2 }), undefined);
  assert.equal(parseHandoffDecision({ ...consumed.decision, state: "weird" }), undefined);
  assert.equal(parseHandoffDecision({ ...consumed.decision, planPath: "" }), undefined);
  assert.equal(parseHandoffDecision({ ...consumed.decision, destination: "auto" }), undefined);
  assert.equal(parseHandoffDecision({ ...consumed.decision, receipts: "no" })?.receipts.length, 0);
  assert.equal(
    parseHandoffDecision({ ...consumed.decision, receipts: [{ at: 1, destination: "build", route: "nope" }] })
      ?.receipts.length,
    0,
  );
});

test("decision: destinations are a closed set", () => {
  assert.equal(isHandoffDestination("orchestrator"), true);
  assert.equal(isHandoffDestination("build"), true);
  assert.equal(isHandoffDestination("auto"), false);
  assert.equal(HANDOFF_DECISION_VERSION, 1);
});
