/**
 * Handoff decision lifecycle tests (two-stage model).
 *
 * The record is what makes "approve once, then choose execution" true across
 * browser, native, recovery and command paths:
 *
 *   pending --approve--> approved --select--> routing --ok--> consumed
 *      |                    |                    `--fail--> route-failed
 *      `--feedback/dismiss--┘
 *
 * Three invariants are load-bearing and covered explicitly below:
 *   1. an approval NEVER routes (stage 2 is required);
 *   2. a recommendation/default NEVER executes;
 *   3. a cancellation leaves the approval intact.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  HANDOFF_DECISION_VERSION,
  HANDOFF_DECISION_VERSION_LEGACY,
  approveHandoffPlan,
  beginHandoffRoute,
  consumeHandoffRoute,
  createHandoffDecision,
  dismissHandoffDecision,
  handoffDecisionId,
  handoffDecisionMatches,
  handoffRouteFor,
  isAwaitingExecution,
  isHandoffDestination,
  parseHandoffDecision,
  selectHandoffDestination,
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

function approved(over: Partial<typeof BASE> = {}): HandoffDecision {
  const result = approveHandoffPlan(created(over), { now: 1_100, via: "native" });
  assert.equal(result.ok, true, result.ok ? "" : result.error);
  return (result as { ok: true; decision: HandoffDecision }).decision;
}

test("create: identity is stable for the same handoff and changes with content", () => {
  const a = created();
  const b = created();
  assert.equal(a.decisionId, b.decisionId);
  assert.equal(a.state, "pending");
  assert.equal(a.destination, undefined, "creation never selects an execution");
  assert.equal(HANDOFF_DECISION_VERSION, 3);

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

test("create: invalid identity fails closed", () => {
  for (const broken of [
    { planPath: "" },
    { planHash: "" },
    { sessionRef: "  " },
    { reviewCycleId: -1 },
    { reviewCycleId: 1.5 },
  ]) {
    const result = createHandoffDecision({ ...BASE, ...broken });
    assert.equal(result.ok, false, JSON.stringify(broken));
  }
});

test("approve: stage 1 records approval and never routes", () => {
  const decision = created();
  assert.equal(handoffRouteFor(decision), undefined);

  const result = approveHandoffPlan(decision, { now: 1_100, via: "browser" });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.decision.state, "approved");
  assert.equal(result.decision.approvedAt, 1_100);
  assert.equal(result.decision.approval?.via, "browser");
  assert.equal(result.decision.destination, undefined);
  assert.equal(handoffRouteFor(result.decision), undefined, "approval alone never routes");
  assert.equal(isAwaitingExecution(result.decision), true);

  // A duplicate approval (second browser channel) is refused, so it cannot
  // open a second chooser.
  const again = approveHandoffPlan(result.decision, { now: 1_200, via: "native" });
  assert.equal(again.ok, false);
  assert.equal((again as any).code, "wrong-state");
});

test("approve: a hash mismatch or terminal state is refused", () => {
  const changed = approveHandoffPlan(created(), {
    now: 1_100,
    via: "native",
    planHash: "b".repeat(64),
  });
  assert.equal(changed.ok, false);
  assert.equal((changed as any).code, "invalid");

  const dismissed = dismissHandoffDecision(created(), 1_050);
  assert.equal((approveHandoffPlan(dismissed, { now: 1_100, via: "native" }) as any).code, "dismissed");

  const superseded = supersedeHandoffDecision(created(), 1_050, "new prompt");
  assert.equal(
    (approveHandoffPlan(superseded, { now: 1_100, via: "native" }) as any).code,
    "superseded",
  );
});

test("approve: an approval comment is kept and is not a denial", () => {
  const result = approveHandoffPlan(created(), {
    now: 1_100,
    via: "browser",
    feedback: "ship it, but note the migration",
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.decision.state, "approved");
  assert.equal(result.decision.approval?.feedback, "ship it, but note the migration");
});

test("select: requires an approval, then records the only execution authority", () => {
  const decision = created();
  const early = selectHandoffDestination(decision, "build", 1_050);
  assert.equal(early.ok, false);
  assert.equal((early as any).code, "not-approved");

  const selected = selectHandoffDestination(approved(), "build", 1_200, "command");
  assert.equal(selected.ok, true);
  if (!selected.ok) return;
  assert.equal(selected.decision.state, "approved");
  assert.equal(selected.decision.destination, "build");
  assert.equal(selected.decision.selection?.via, "command");
  assert.deepEqual(handoffRouteFor(selected.decision), {
    kind: "direct-build",
    planPath: BASE.planPath,
    decisionId: selected.decision.decisionId,
  });
});

test("route: a selection is required before any effect", () => {
  const decision = approved();
  const noSelection = beginHandoffRoute(decision, { now: 1_200, destination: "build" });
  assert.equal(noSelection.ok, false);
  assert.equal((noSelection as any).code, "no-selection");

  const pendingDecision = created();
  const beforeApproval = beginHandoffRoute(pendingDecision, {
    now: 1_200,
    destination: "orchestrator",
  });
  assert.equal(beforeApproval.ok, false);
  assert.equal((beforeApproval as any).code, "not-approved");
});

test("route: destination mismatch and changed plan are refused", () => {
  const selected = selectHandoffDestination(approved(), "orchestrator", 1_200);
  assert.equal(selected.ok, true);
  if (!selected.ok) return;

  const wrong = beginHandoffRoute(selected.decision, {
    now: 1_300,
    destination: "build",
  });
  assert.equal(wrong.ok, false);
  assert.equal((wrong as any).code, "invalid");

  const changed = beginHandoffRoute(selected.decision, {
    now: 1_300,
    destination: "orchestrator",
    planHash: "b".repeat(64),
  });
  assert.equal(changed.ok, false);
  assert.equal((changed as any).code, "invalid");
});

test("route: consumed exactly once, with a receipt", () => {
  const selected = selectHandoffDestination(approved(), "orchestrator", 1_200);
  assert.equal(selected.ok, true);
  if (!selected.ok) return;
  const began = beginHandoffRoute(selected.decision, {
    now: 1_300,
    destination: "orchestrator",
  });
  assert.equal(began.ok, true);
  if (!began.ok) return;
  assert.equal(began.decision.state, "routing");
  assert.equal(began.route.kind, "orchestrator-prepare");

  const wrongRoute = consumeHandoffRoute(began.decision, {
    now: 1_400,
    route: "direct-build",
  });
  assert.equal(wrongRoute.ok, false);
  assert.equal((wrongRoute as any).code, "invalid");
  assert.equal(began.decision.state, "routing", "a failed consume leaves intent intact");

  const done = consumeHandoffRoute(began.decision, {
    now: 1_400,
    route: "orchestrator-prepare",
  });
  assert.equal(done.ok, true);
  if (!done.ok) return;
  assert.equal(done.decision.state, "consumed");
  assert.equal(done.decision.receipts.length, 1);
  assert.equal(done.decision.receipts[0]?.destination, "orchestrator");

  const second = consumeHandoffRoute(done.decision, {
    now: 1_500,
    route: "orchestrator-prepare",
  });
  assert.equal(second.ok, false);
  assert.equal((second as any).code, "consumed");
  // No duplicate route: a consumed decision cannot be re-begun or re-approved.
  assert.equal(
    (beginHandoffRoute(done.decision, { now: 1_500, destination: "orchestrator" }) as any).ok,
    false,
  );
  assert.equal(
    (approveHandoffPlan(done.decision, { now: 1_500, via: "native" }) as any).code,
    "consumed",
  );
});

test("route failure: retryable only when delivery is provably pre-effect", () => {
  const selected = selectHandoffDestination(approved(), "build", 1_200);
  assert.equal(selected.ok, true);
  if (!selected.ok) return;
  const began = beginHandoffRoute(selected.decision, { now: 1_300, destination: "build" });
  assert.equal(began.ok, true);
  if (!began.ok) return;

  const failed = consumeHandoffRoute(began.decision, {
    now: 1_400,
    route: "direct-build",
    failure: "Build mode was not entered",
  });
  assert.equal(failed.ok, true);
  if (!failed.ok) return;
  assert.equal(failed.decision.state, "route-failed");
  assert.equal(failed.decision.receipts[0]?.failure, "Build mode was not entered");
  assert.notEqual(failed.decision.receipts[0]?.uncertain, true);

  // Explicit retry is allowed for a proven pre-delivery failure.
  const retry = beginHandoffRoute(failed.decision, { now: 1_500, destination: "build" });
  assert.equal(retry.ok, true);

  // An uncertain delivery is NOT retryable.
  const uncertain = consumeHandoffRoute(began.decision, {
    now: 1_600,
    route: "direct-build",
    failure: "threw after enqueue",
    uncertain: true,
  });
  assert.equal(uncertain.ok, true);
  if (!uncertain.ok) return;
  const blocked = beginHandoffRoute(uncertain.decision, {
    now: 1_700,
    destination: "build",
  });
  assert.equal(blocked.ok, false);
  assert.equal((blocked as any).code, "wrong-state");
  assert.match((blocked as any).error, /uncertain/);
});

test("cancel: a deferred stage 2 leaves the approval intact", () => {
  // There is no transition for cancellation on purpose: the state stays
  // `approved`, which is what makes /handoff continue possible.
  const decision = approved();
  assert.equal(decision.state, "approved");
  assert.equal(isAwaitingExecution(decision), true);
  assert.equal(decision.destination, undefined);
  assert.equal(decision.receipts.length, 0);
});

test("dismiss: only an unanswered plan review is dismissible", () => {
  const dismissed = dismissHandoffDecision(created(), 1_050);
  assert.equal(dismissed.state, "dismissed");
  assert.equal((selectHandoffDestination(dismissed, "build", 1_100) as any).code, "wrong-state");

  const announced = approved();
  assert.equal(dismissHandoffDecision(announced, 1_200).state, "approved");
});

test("supersede: an approval can be superseded; a routing attempt cannot", () => {
  const announced = supersedeHandoffDecision(approved(), 1_200, "a newer prompt");
  assert.equal(announced.state, "superseded");

  const selected = selectHandoffDestination(approved(), "build", 1_200);
  assert.equal(selected.ok, true);
  if (!selected.ok) return;
  const routing = beginHandoffRoute(selected.decision, { now: 1_300, destination: "build" });
  assert.equal(routing.ok, true);
  if (!routing.ok) return;
  assert.equal(
    supersedeHandoffDecision(routing.decision, 1_400, "new prompt").state,
    "routing",
    "a live route keeps its owner so delivery can be recorded",
  );
});

test("match: rejects a stale path, hash or cycle", () => {
  const decision = created();
  assert.equal(handoffDecisionMatches(decision, {}), true);
  assert.equal(handoffDecisionMatches(decision, { planPath: BASE.planPath }), true);
  assert.equal(handoffDecisionMatches(decision, { planPath: "other.md" }), false);
  assert.equal(handoffDecisionMatches(decision, { planHash: "d".repeat(64) }), false);
  assert.equal(handoffDecisionMatches(decision, { reviewCycleId: 9 }), false);
});

test("codec: the current record round-trips and rejects corrupt data", () => {
  const selected = selectHandoffDestination(approved(), "build", 1_200);
  assert.equal(selected.ok, true);
  if (!selected.ok) return;
  const began = beginHandoffRoute(selected.decision, { now: 1_300, destination: "build" });
  assert.equal(began.ok, true);
  if (!began.ok) return;
  const done = consumeHandoffRoute(began.decision, { now: 1_400, route: "direct-build" });
  assert.equal(done.ok, true);
  if (!done.ok) return;

  const parsed = parseHandoffDecision(JSON.parse(JSON.stringify(done.decision)));
  assert.deepEqual(parsed, done.decision);

  assert.equal(parseHandoffDecision(undefined), undefined);
  assert.equal(parseHandoffDecision({ ...done.decision, version: 99 }), undefined);
  assert.equal(parseHandoffDecision({ ...done.decision, state: "weird" }), undefined);
  assert.equal(parseHandoffDecision({ ...done.decision, planPath: "" }), undefined);
  assert.equal(parseHandoffDecision({ ...done.decision, destination: "auto" }), undefined);
  assert.equal(parseHandoffDecision({ ...done.decision, receipts: "no" })?.receipts.length, 0);
  assert.equal(
    parseHandoffDecision({
      ...done.decision,
      receipts: [{ at: 1, destination: "build", route: "nope" }],
    })?.receipts.length,
    0,
  );
  // An approved/routed record without its selection is corrupt, not a default.
  const { destination: _dropped, ...noSelection } = done.decision;
  void _dropped;
  assert.equal(parseHandoffDecision({ ...noSelection, state: "routing" }), undefined);
});

test("codec: a v1 pending record migrates to a RECOMMENDATION only", () => {
  const v1 = {
    version: HANDOFF_DECISION_VERSION_LEGACY,
    decisionId: "handoff-aaaaaaaa",
    planPath: BASE.planPath,
    planHash: BASE.planHash,
    sessionRef: BASE.sessionRef,
    reviewCycleId: 4,
    source: "auto",
    presenter: "browser",
    reviewOwned: true,
    defaultDestination: "orchestrator",
    destination: "orchestrator",
    overrideRevision: 1,
    state: "pending",
    createdAt: 1,
    updatedAt: 2,
    receipts: [],
  };
  const migrated = parseHandoffDecision(v1);
  assert.ok(migrated);
  assert.equal(migrated!.version, 3);
  assert.equal(migrated!.state, "pending");
  assert.equal(migrated!.destination, undefined, "a v1 capture is not consent to execute");
  assert.equal(handoffRouteFor(migrated!), undefined);
});

test("codec: a v2 decision still reads; its recommendation fields are dropped", () => {
  const v2 = {
    version: 2,
    decisionId: "handoff-cccccccc",
    planPath: BASE.planPath,
    planHash: BASE.planHash,
    sessionRef: BASE.sessionRef,
    reviewCycleId: 4,
    source: "auto",
    presenter: "native",
    reviewOwned: false,
    recommendedDestination: "build",
    recommendationRevision: 3,
    destination: "orchestrator",
    state: "approved",
    createdAt: 1,
    updatedAt: 2,
    receipts: [],
  };
  const migrated = parseHandoffDecision(v2);
  assert.ok(migrated);
  assert.equal(migrated!.version, 3);
  assert.equal(migrated!.destination, "orchestrator", "the explicit selection survives");
  assert.equal((migrated as any).recommendedDestination, undefined);
  assert.equal((migrated as any).recommendationRevision, undefined);

  const missingDestination = parseHandoffDecision({ ...v2, destination: undefined });
  assert.equal(missingDestination, undefined, "an approved v2 record still needs consent");
});

test("codec: a v1 consumed record stays terminal and never re-routes", () => {
  const v1 = {
    version: HANDOFF_DECISION_VERSION_LEGACY,
    decisionId: "handoff-bbbbbbbb",
    planPath: BASE.planPath,
    planHash: BASE.planHash,
    sessionRef: BASE.sessionRef,
    reviewCycleId: 4,
    source: "manual",
    presenter: "native",
    reviewOwned: false,
    defaultDestination: "build",
    destination: "build",
    overrideRevision: 0,
    state: "consumed",
    createdAt: 1,
    updatedAt: 2,
    receipts: [{ at: 3, destination: "build", route: "direct-build" }],
  };
  const migrated = parseHandoffDecision(v1);
  assert.ok(migrated);
  assert.equal(migrated!.state, "consumed");
  assert.equal(migrated!.destination, "build");
  assert.equal(handoffRouteFor(migrated!), undefined);
  assert.equal(
    (approveHandoffPlan(migrated!, { now: 9, via: "native" }) as any).code,
    "consumed",
  );
});

test("codec: destinations are a closed set", () => {
  assert.equal(isHandoffDestination("orchestrator"), true);
  assert.equal(isHandoffDestination("build"), true);
  assert.equal(isHandoffDestination("auto"), false);
  assert.equal(HANDOFF_DECISION_VERSION, 3);
});
