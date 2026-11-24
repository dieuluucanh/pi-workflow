/**
 * Workflow Extension — the Orchestrator child transcript/status formatters.
 *
 * The status string is shared by the footer, the operator text and the host
 * contributions, so these tests pin the truth it must never lose: the child's
 * identity, the model that actually runs, context, tokens, elapsed time and its
 * local todo counters — on exactly one line.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  formatOrchestratorChildProgress,
  formatOrchestratorChildStatus,
} from "./orchestrator-child-view.ts";
import type { OrchestratorChildState } from "./orchestrator-child-controller.ts";

function state(over: Partial<OrchestratorChildState> = {}): OrchestratorChildState {
  return {
    phase: "running",
    taskId: "task-2",
    attemptId: "a1",
    sessionId: "s1",
    ref: "2",
    total: 7,
    modelLabel: "open/muse-spark",
    startedAt: 1_000,
    todos: [],
    ...over,
  };
}

test("child status: idle and disposed render nothing", () => {
  assert.equal(formatOrchestratorChildStatus(undefined), "");
  assert.equal(formatOrchestratorChildStatus(state({ phase: "idle" })), "");
  assert.equal(formatOrchestratorChildStatus(state({ phase: "disposed" })), "");
});

test("child status: carries identity, model, stats, elapsed and todos", () => {
  const line = formatOrchestratorChildStatus(
    state({
      stats: {
        model: { provider: "open", id: "muse-spark", thinking: "high" },
        tokens: {
          input: 12_000,
          output: 3_000,
          cacheRead: 0,
          cacheWrite: 0,
          total: 15_000,
        },
        context: { tokens: 86_000, contextWindow: 200_000, percent: 43 },
      },
      todos: [
        { step: 1, text: "a", completed: true },
        { step: 2, text: "b", completed: true },
        { step: 3, text: "c", completed: false },
        { step: 4, text: "d", completed: false },
        { step: 5, text: "e", completed: false },
      ],
    }),
    84_000, // now
  );
  assert.equal(
    line,
    "child 2/7 running · open/muse-spark · ctx 43% (86k/200k) · ↑12k ↓3.0k · 01:23 · 2/5 todos",
  );
  assert.equal(line.includes("\n"), false);
});

test("child status: a paused child freezes elapsed at pausedAt", () => {
  const line = formatOrchestratorChildStatus(
    state({ phase: "paused", pausedAt: 61_000 }),
    999_000,
  );
  assert.equal(line, "child 2/7 paused · open/muse-spark · 01:00");
});

test("child status: settling is reported as verifying", () => {
  assert.equal(
    formatOrchestratorChildStatus(state({ phase: "settling", startedAt: 0 }), 5_000),
    "child 2/7 verifying · open/muse-spark · 00:05",
  );
});

test("child status: without stats it keeps the historical shape", () => {
  assert.equal(
    formatOrchestratorChildStatus(
      state({
        startedAt: undefined,
        todos: [{ step: 1, text: "a", completed: true }],
      }),
    ),
    "child 2/7 running · open/muse-spark · 1/1 todos",
  );
});

test("child progress: the compact band detail names the tool and todos", () => {
  assert.equal(
    formatOrchestratorChildProgress(
      state({
        lastTool: "read src/app.ts",
        todos: [
          { step: 1, text: "a", completed: true },
          { step: 2, text: "b", completed: true },
          { step: 3, text: "c", completed: false },
        ],
      }),
    ),
    "read src/app.ts · 2/3 todos",
  );
  assert.equal(formatOrchestratorChildProgress(undefined), "");
  assert.equal(
    formatOrchestratorChildProgress(state({ phase: "disposed" })),
    "",
  );
});

test("child status: hostile content stays on one bounded line", () => {
  const line = formatOrchestratorChildStatus(
    state({
      modelLabel: "open/mod\nel",
      lastTool: "tool\twith\ttabs",
      todos: [{ step: 1, text: "a\nb", completed: false }],
    }),
  );
  assert.equal(/[\r\n\t]/.test(line), false);
  assert.ok(line.length < 160, `bounded: ${line.length}`);
});
