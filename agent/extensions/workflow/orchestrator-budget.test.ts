/**
 * Budget service tests (step 17). The acceptance cases: four context sizes
 * produce different safe budgets, a bootstrap that cannot fit stops dispatch,
 * and missing metadata degrades to a conservative fallback. Context is a
 * capacity number, never a competence claim.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_BUDGET_POLICY,
  canDispatch,
  coerceBudgetPolicy,
  estimateTextTokens,
  resolveBudget,
  resolveBudgetPair,
  type BudgetPlan,
} from "./orchestrator-budget.ts";

function plan(window: number | null, over: { output?: number | null; cap?: number } = {}): BudgetPlan {
  const result = resolveBudget({
    role: "builder",
    model: {
      provider: "test",
      id: "m",
      contextWindow: window,
      maxOutputTokens: over.output ?? null,
    },
    ...(over.cap === undefined ? {} : { userCaps: { inputTokens: over.cap } }),
  });
  assert.equal(result.ok, true, result.ok ? "" : result.error);
  return (result as { ok: true; plan: BudgetPlan }).plan;
}

test("32K/128K/512K/1M produce different, increasing safe budgets", () => {
  const plans = [32_768, 131_072, 524_288, 1_048_576].map((window) => plan(window));
  for (let index = 1; index < plans.length; index += 1) {
    assert.ok(plans[index]!.usableInput > plans[index - 1]!.usableInput);
    assert.ok(plans[index]!.targetWorkingSet > plans[index - 1]!.targetWorkingSet);
    assert.ok(plans[index]!.bootstrapBudget > plans[index - 1]!.bootstrapBudget);
    assert.ok(plans[index]!.checkpointAt > plans[index - 1]!.checkpointAt);
    assert.ok(plans[index]!.stopAt > plans[index - 1]!.stopAt);
  }
  assert.ok(plans.every((entry) => entry.source === "provider" && entry.confidence === "high"));
});

test("a bootstrap that alone cannot fit refuses dispatch before work starts", () => {
  const small = plan(32_768);
  const refused = canDispatch(small, { bootstrapTokens: small.bootstrapBudget + 1 });
  assert.equal(refused.ok, false);
  assert.equal((refused as { code: string }).code, "bootstrap");
  assert.match((refused as { reason: string }).reason, /bootstrap/);

  assert.equal(canDispatch(small, { bootstrapTokens: 100 }).ok, true);
  const capacity = canDispatch(small, { bootstrapTokens: 100, systemTokens: 100_000 });
  assert.equal(capacity.ok, false);
  assert.equal((capacity as { code: string }).code, "capacity");
});

test("missing metadata degrades to a conservative fallback and low confidence", () => {
  const unknown = plan(null);
  assert.equal(unknown.contextWindow, 8_192);
  assert.equal(unknown.source, "fallback");
  assert.equal(unknown.confidence, "low");
  assert.match(unknown.warnings.join(" "), /unknown/);
  // A small task can still run; a large bootstrap cannot.
  assert.equal(canDispatch(unknown, { bootstrapTokens: 100 }).ok, true);
  assert.equal(canDispatch(unknown, { bootstrapTokens: 20_000 }).ok, false);
});

test("user caps narrow the plan and are labelled", () => {
  const capped = plan(1_048_576, { cap: 16_384 });
  assert.equal(capped.contextWindow, 16_384);
  assert.equal(capped.source, "user-cap");
  assert.match(capped.warnings.join(" "), /user input cap/);

  const outputCapped = plan(131_072, { output: 8_000, cap: 131_072 });
  assert.ok(outputCapped.outputReserve <= 8_000);
});

test("runtime compaction can request an earlier checkpoint", () => {
  const resolve = resolveBudget({
    role: "orchestrator",
    model: { provider: "p", id: "m", contextWindow: 131_072, maxOutputTokens: null },
    compaction: { enabled: true, thresholdPercent: 40 },
  });
  assert.equal(resolve.ok, true);
  const compacted = (resolve as { ok: true; plan: BudgetPlan }).plan;
  const baseline = plan(131_072);
  assert.ok(compacted.checkpointAt < baseline.checkpointAt);
  assert.match(compacted.warnings.join(" "), /compaction/);
});

test("a model change produces a new plan; nothing is cached as capability", () => {
  const large = plan(1_048_576);
  const small = plan(32_768);
  assert.notEqual(large.usableInput, small.usableInput);
  // Capacity fields only: no competence/capability verdict is present.
  assert.doesNotMatch(JSON.stringify(large), /compet|capab/i);
});

test("policy ratios are clamped into a safe order", () => {
  const policy = coerceBudgetPolicy({ targetRatio: 0.9, checkpointRatio: 0.2, stopRatio: 0.3 });
  assert.equal(policy.targetRatio, 0.2);
  assert.ok(policy.targetRatio <= policy.checkpointRatio);
  assert.ok(policy.checkpointRatio <= policy.stopRatio);
  assert.ok(policy.bootstrapRatio <= policy.targetRatio);
  assert.equal(coerceBudgetPolicy(undefined).targetRatio, DEFAULT_BUDGET_POLICY.targetRatio);
});

test("parent and child budgets resolve independently", () => {
  const pair = resolveBudgetPair({
    orchestrator: {
      model: { provider: "p", id: "big", contextWindow: 1_048_576, maxOutputTokens: null },
    },
    builder: {
      model: { provider: "p", id: "small", contextWindow: 32_768, maxOutputTokens: null },
    },
  });
  assert.equal(pair.ok, true);
  const value = (pair as { ok: true; pair: { orchestrator: BudgetPlan; builder: BudgetPlan } }).pair;
  assert.equal(value.orchestrator.role, "orchestrator");
  assert.equal(value.builder.role, "builder");
  assert.ok(value.orchestrator.usableInput > value.builder.usableInput);
});

test("text estimates are monotonic and non-zero", () => {
  assert.equal(estimateTextTokens("").tokens, 1);
  assert.ok(estimateTextTokens("x".repeat(4_000)).tokens > estimateTextTokens("x".repeat(40)).tokens);
  assert.equal(estimateTextTokens("x").confidence, "medium");
});
