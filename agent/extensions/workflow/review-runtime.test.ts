/**
 * Live reviewer model switch contract (plan step 2).
 *
 * The reviewer is a warm, isolated session. A profile/role switch must reach
 * it in place. These tests pin the two surfaces that were missing:
 *   - a child that cannot resolve the requested model itself must accept the
 *     object the PARENT registry resolved;
 *   - a thinking-level-only change is a real change, even when the child does
 *     not report a current level.
 *
 * Failing tests intentionally: the fixes belong to a later row.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { createReviewRuntime } from "./review-runtime.ts";
import { DEFAULT_REVIEW_MODE_CONFIG } from "./review.ts";
import { fakeSdk } from "./test-support.ts";

const MODEL = { provider: "parent-provider", id: "reviewer-model", thinking: "high" };

interface HarnessOptions {
  /** Model the fake session reports via `currentModel()`. */
  currentModel?: { provider: string; id: string; thinking?: string } | undefined;
  /** Whether the child's modelRuntime can resolve a model by itself. */
  registryKnowsModel?: boolean;
}

function makeRuntime(opts: HarnessOptions = {}) {
  const { sdk, capture } = fakeSdk({
    registryModels: opts.registryKnowsModel !== false,
  });
  const findModelCalls: Array<{ provider: string; id: string }> = [];
  const originalCreate = (sdk as { createAgentSession: (o: unknown) => Promise<unknown> }).createAgentSession;
  (sdk as { createAgentSession: (o: unknown) => Promise<unknown> }).createAgentSession =
    async (o: unknown) => {
      const created = (await originalCreate(o)) as { session: unknown };
      // The fake otherwise mirrors the launch model; override it so the test
      // controls what `currentModel()` sees at switch time.
      capture.currentModel = opts.currentModel;
      if (opts.currentModel) {
        // The fake's `thinkingLevel` getter otherwise keeps the launch level,
        // and the child wrapper falls back to it when the model has none. Make
        // the override authoritative so "unknown thinking" stays unknown.
        Object.defineProperty(created.session as object, "thinkingLevel", {
          configurable: true,
          get: () => opts.currentModel?.thinking,
        });
      }
      return created;
    };
  const parentModel = { provider: MODEL.provider, id: MODEL.id };
  const deps = {
    cwd: "/tmp/review-runtime-test",
    agentDir: "/tmp/review-runtime-test-agent",
    config: () => DEFAULT_REVIEW_MODE_CONFIG,
    reviewerModel: () => MODEL,
    findModel: (provider: string, id: string) => {
      findModelCalls.push({ provider, id });
      return provider === parentModel.provider && id === parentModel.id
        ? parentModel
        : undefined;
    },
    planPath: () => undefined,
    readPlan: () => undefined,
    contextEntries: () => [],
    promptText: () => "review",
    runExplore: async () => "",
    writePlan: () => ({ ok: false, error: "not used" }),
    log: () => {},
    notify: () => {},
    loadSdk: async () => sdk,
  } as unknown as Parameters<typeof createReviewRuntime>[0];
  return { runtime: createReviewRuntime(deps), capture, findModelCalls };
}

test("switchModel: a child with no current model accepts the parent-resolved model", async () => {
  const { runtime, capture, findModelCalls } = makeRuntime({
    currentModel: undefined,
    registryKnowsModel: false,
  });
  assert.equal(await runtime.ensureStarted(), true);

  const result = await runtime.switchModel(MODEL);

  assert.equal(result.ok, true, result.error);
  assert.equal(result.changed, true);
  // The parent resolves the model before handing it to a child whose own
  // registry cannot resolve it.
  assert.deepEqual(findModelCalls, [
    { provider: MODEL.provider, id: MODEL.id },
  ]);
  assert.deepEqual(capture.setModelCalls, [
    { provider: MODEL.provider, id: MODEL.id, thinking: MODEL.thinking },
  ]);
});

test("switchModel: same provider/id with an unknown current thinking applies the level", async () => {
  const { runtime, capture } = makeRuntime({
    currentModel: { provider: MODEL.provider, id: MODEL.id },
  });
  assert.equal(await runtime.ensureStarted(), true);

  const result = await runtime.switchModel(MODEL);

  assert.equal(result.ok, true, result.error);
  assert.equal(result.changed, true);
  assert.equal(result.model?.thinking, MODEL.thinking);
  assert.deepEqual(capture.setModelCalls, [
    { provider: MODEL.provider, id: MODEL.id, thinking: MODEL.thinking },
  ]);
});
