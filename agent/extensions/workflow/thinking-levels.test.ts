/**
 * Model-aware thinking levels (2026-10-31 UI plan, workflow side).
 *
 * The DeepSeek fixture is the user's real case: `minimal`/`medium` are `null`
 * in the model's `thinkingLevelMap`, so only five levels are offered.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  clampThinkingForModel,
  thinkingLevelsForModel,
  thinkingLevelsForPair,
} from "./thinking-levels.ts";
import { VALID_THINKING_LEVELS } from "./roles.ts";

const DEEPSEEK = {
  provider: "synthetic",
  id: "hf:deepseek-ai/DeepSeek-V4.1-Flash",
  reasoning: true,
  thinkingLevelMap: {
    off: "none",
    minimal: null,
    low: "low",
    medium: null,
    high: "high",
    xhigh: "xhigh",
    max: "max",
  },
};

test("uses the model's thinkingLevelMap", () => {
  assert.deepEqual(thinkingLevelsForModel(DEEPSEEK), ["off", "low", "high", "xhigh", "max"]);
});

test("offers only off for a non-reasoning model", () => {
  assert.deepEqual(thinkingLevelsForModel({ reasoning: false }), ["off"]);
});

test("falls back to every level for an unknown model", () => {
  assert.deepEqual(thinkingLevelsForModel(undefined), [...VALID_THINKING_LEVELS]);
  assert.deepEqual(thinkingLevelsForModel({}), [...VALID_THINKING_LEVELS]);
  assert.deepEqual(thinkingLevelsForModel("not a model"), [...VALID_THINKING_LEVELS]);
});

test("clamps an unsupported level to the nearest supported one", () => {
  assert.equal(clampThinkingForModel(DEEPSEEK, "medium"), "high");
  assert.equal(clampThinkingForModel(DEEPSEEK, "high"), "high");
  assert.equal(clampThinkingForModel(undefined, "medium"), "medium");
});

test("returns a pair that never contains a level outside its own list", () => {
  assert.deepEqual(thinkingLevelsForPair(DEEPSEEK, "medium"), {
    levels: ["off", "low", "high", "xhigh", "max"],
    level: "high",
  });
  assert.deepEqual(thinkingLevelsForPair(DEEPSEEK, "max"), {
    levels: ["off", "low", "high", "xhigh", "max"],
    level: "max",
  });
});
