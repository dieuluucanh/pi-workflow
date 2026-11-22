/**
 * Model-plan regression tests.
 *
 * The user-reported bootstrap failure produced `{ provider: "", id: <parent> }`
 * and `prepareWorker` rejected it. These tests pin the replacement contract:
 * the effective Builder role wins, the session model is only a fallback, and a
 * launch plan can never carry an empty provider.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { resolveModelPlan } from "./orchestrator-model-plan.ts";

const SESSION = {
  provider: "session-provider",
  id: "session-model",
  contextWindow: 131_072,
  maxOutputTokens: 8_000,
};

test("effective Builder role wins over the live session model", () => {
  const result = resolveModelPlan({
    role: "builder",
    roleName: "Builder",
    roleModel: {
      provider: "role-provider",
      id: "role-model",
      thinking: "medium",
    },
    fallbackModel: SESSION,
    lookupLimits: () => ({ contextWindow: 262_144, maxOutputTokens: 16_000 }),
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.launch, {
    provider: "role-provider",
    id: "role-model",
    thinking: "medium",
  });
  assert.equal(result.budget.model.provider, "role-provider");
  assert.equal(result.budget.model.id, "role-model");
  assert.equal(result.budget.contextWindow, 262_144);
});

test("an empty role provider falls back instead of producing provider \"\"", () => {
  const result = resolveModelPlan({
    role: "builder",
    roleName: "Builder",
    roleModel: { provider: "   ", id: "role-model" },
    fallbackModel: SESSION,
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.launch.provider, "session-provider");
  assert.equal(result.launch.id, "session-model");
  assert.notEqual(result.launch.provider, "");
  assert.equal(result.budget.model.provider, "session-provider");
});

test("a missing role and a missing session provider fail closed", () => {
  const result = resolveModelPlan({
    role: "builder",
    roleName: "Builder",
    roleModel: { id: "role-model" },
    fallbackModel: { id: "session-model", contextWindow: 131_072, maxOutputTokens: null },
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "no_model");
  assert.match(result.error, /Builder model is required/);
});

test("the same-model fallback keeps the session context limits", () => {
  const result = resolveModelPlan({
    role: "builder",
    roleName: "Builder",
    roleModel: { provider: "session-provider", id: "session-model" },
    fallbackModel: SESSION,
    lookupLimits: () => undefined,
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.budget.contextWindow, 131_072);
  assert.equal(result.budget.source, "provider");
});

test("unknown role limits degrade conservatively instead of guessing", () => {
  const result = resolveModelPlan({
    role: "builder",
    roleName: "Builder",
    roleModel: { provider: "role-provider", id: "role-model" },
    fallbackModel: SESSION,
    lookupLimits: () => undefined,
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.budget.source, "fallback");
  assert.equal(result.budget.confidence, "low");
  assert.match(result.budget.warnings.join(" "), /unknown/);
});

test("an impossible budget is refused with a budget code", () => {
  const result = resolveModelPlan({
    role: "builder",
    roleName: "Builder",
    roleModel: { provider: "role-provider", id: "role-model" },
    lookupLimits: () => ({ contextWindow: 1, maxOutputTokens: 1 }),
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "budget");
});
