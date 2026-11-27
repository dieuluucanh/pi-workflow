/**
 * Workflow Extension — pure child telemetry formatting.
 *
 * These formatters are the single source of truth for the child's model,
 * context, tokens and elapsed time across the footer status, the pinned panel,
 * the operator text and the host contributions. They must be:
 *
 *   - one line, always (a newline would break the footer);
 *   - honest (unknown renders as nothing, never `0` or `?`);
 *   - bounded (no wide string may push the footer off-screen).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  childModelLabel,
  childPhaseWord,
  formatChildModel,
  formatChildPanelHeader,
  formatChildProgress,
  formatChildStatusLine,
  formatChildTokens,
  formatContextUsage,
  formatElapsed,
  formatTokenCount,
  sanitizeStatLine,
} from "./child-stats.ts";

test("child-stats: token counts match the footer's compact style", () => {
  assert.equal(formatTokenCount(0), "0");
  assert.equal(formatTokenCount(999), "999");
  assert.equal(formatTokenCount(1_000), "1.0k");
  assert.equal(formatTokenCount(1_500), "1.5k");
  assert.equal(formatTokenCount(9_999), "10.0k");
  assert.equal(formatTokenCount(12_000), "12k");
  assert.equal(formatTokenCount(999_000), "999k");
  assert.equal(formatTokenCount(1_200_000), "1.2M");
  assert.equal(formatTokenCount(12_000_000), "12M");
  // Unknown / malformed values render nothing at all.
  assert.equal(formatTokenCount(undefined), "");
  assert.equal(formatTokenCount(null), "");
  assert.equal(formatTokenCount(Number.NaN), "");
  assert.equal(formatTokenCount(-5), "");
  assert.equal(formatTokenCount(Number.POSITIVE_INFINITY), "");
});

test("child-stats: context usage shows percent, or the token pair, or nothing", () => {
  assert.equal(
    formatContextUsage({ tokens: 86_000, contextWindow: 200_000, percent: 43 }),
    "ctx 43%",
  );
  assert.equal(
    formatContextUsage(
      { tokens: 86_000, contextWindow: 200_000, percent: 43 },
      { long: true },
    ),
    "ctx 43% (86k/200k)",
  );
  // Percent unknown after compaction: the token pair is still useful.
  assert.equal(
    formatContextUsage({ tokens: 10_000, contextWindow: 200_000, percent: null }),
    "ctx 10k/200k",
  );
  assert.equal(
    formatContextUsage({ tokens: 10_000, contextWindow: 200_000, percent: null }, { long: true }),
    "ctx 10k/200k",
  );
  // Percent known but tokens unknown (right after a reset).
  assert.equal(
    formatContextUsage({ tokens: null, contextWindow: 200_000, percent: 0 }),
    "ctx 0%",
  );
  // Nothing usable: no fabricated `ctx ?`.
  assert.equal(
    formatContextUsage({ tokens: null, contextWindow: 0, percent: null }),
    "",
  );
  // A token count without a window is not a percentage and not a pair: honest
  // emptiness beats a misleading `ctx 5`.
  assert.equal(
    formatContextUsage({ tokens: 5, contextWindow: 0, percent: null }),
    "",
  );
  assert.equal(formatContextUsage(undefined), "");
  assert.equal(
    formatContextUsage({ tokens: -1, contextWindow: -1, percent: -10 }),
    "",
  );
});

test("child-stats: token totals omit zero counters and include cache when present", () => {
  assert.equal(
    formatChildTokens({
      input: 12_000,
      output: 900,
      cacheRead: 0,
      cacheWrite: 0,
      total: 12_900,
    }),
    "↑12k ↓900",
  );
  assert.equal(
    formatChildTokens({
      input: 12_000,
      output: 900,
      cacheRead: 4_000,
      cacheWrite: 500,
      total: 17_400,
    }),
    "↑12k ↓900 R4.0k W500",
  );
  assert.equal(
    formatChildTokens({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    }),
    "",
  );
  assert.equal(formatChildTokens(undefined), "");
});

test("child-stats: elapsed is mm:ss, then h:mm:ss, clamped at zero", () => {
  assert.equal(formatElapsed(0), "00:00");
  assert.equal(formatElapsed(999), "00:00");
  assert.equal(formatElapsed(1_000), "00:01");
  assert.equal(formatElapsed(83_000), "01:23");
  assert.equal(formatElapsed(3_723_000), "1:02:03");
  assert.equal(formatElapsed(-5_000), "00:00");
  assert.equal(formatElapsed(undefined), "");
  assert.equal(formatElapsed(Number.NaN), "");
});

test("child-stats: the model label truncates in the middle, keeping the provider", () => {
  assert.equal(
    formatChildModel({ provider: "open", id: "muse-spark" }),
    "open/muse-spark",
  );
  const long = formatChildModel({
    provider: "synthetic",
    id: "hf:deepseek-ai/DeepSeek-V4.1-Flash-1017",
  });
  assert.ok(long.length <= 48, `bounded: ${long}`);
  assert.match(long, /^synthetic\//);
  assert.match(long, /…/);
  assert.match(long, /1017$/);
  // Control characters can never break the one-line contract.
  assert.equal(
    sanitizeStatLine(formatChildModel({ provider: "a", id: "b\nc\td" })),
    "a/b c d",
  );
  assert.equal(formatChildModel(undefined), "");
  assert.equal(childModelLabel(undefined, "builder/fallback"), "builder/fallback");
  assert.equal(
    childModelLabel({ provider: "open", id: "m" }, "builder/fallback"),
    "open/m",
  );
});

test("child-stats: the footer line keeps telemetry and drops the counters", () => {
  const input = {
    ref: "2",
    total: 7,
    phase: "running",
    model: { provider: "open", id: "muse-spark", thinking: "high" },
    stats: {
      tokens: {
        input: 12_000,
        output: 3_000,
        cacheRead: 0,
        cacheWrite: 0,
        total: 15_000,
      },
      context: { tokens: 86_000, contextWindow: 200_000, percent: 43 },
    },
    elapsedMs: 83_000,
    todoDone: 3,
    todoTotal: 5,
  };
  const line = formatChildStatusLine(input);
  assert.equal(
    line,
    "child running · open/muse-spark · ctx 43% (86k/200k) · ↑12k ↓3.0k · 01:23",
  );
  assert.doesNotMatch(line, /\d+\/\d+/, "no row pointer");
  assert.doesNotMatch(line, /todos/, "no child todo counter");
  assert.equal(line.includes("\n"), false, "always exactly one line");

  // The multi-line operator report opts back into the historical shape.
  assert.equal(
    formatChildStatusLine(input, { showRow: true, showTodoCount: true }),
    "child 2/7 running · open/muse-spark · ctx 43% (86k/200k) · ↑12k ↓3.0k · 01:23 · 3/5 todos",
  );

  // No stats yet: the model only, then nothing but the phase.
  assert.equal(
    formatChildStatusLine({
      ref: "2",
      total: 7,
      phase: "running",
      model: { provider: "open", id: "m" },
      todoDone: 1,
      todoTotal: 2,
    }),
    "child running · open/m",
  );
  assert.equal(formatChildStatusLine({ phase: "starting" }), "child starting");
  assert.equal(
    formatChildStatusLine({ ref: "1", total: 1, phase: "paused" }),
    "child paused",
  );
});

test("child-stats: one phase word for every surface", () => {
  assert.equal(childPhaseWord({ phase: "starting" }), "starting");
  assert.equal(childPhaseWord({ phase: "running" }), "running");
  assert.equal(
    childPhaseWord({ phase: "running", retrying: true }),
    "retrying",
  );
  assert.equal(childPhaseWord({ phase: "paused" }), "paused");
  assert.equal(
    childPhaseWord({ phase: "paused", pausePending: true }),
    "pausing",
  );
  assert.equal(childPhaseWord({ phase: "settling" }), "verifying");
  assert.equal(childPhaseWord({}), "starting", "absent phase is not a lie");

  // The word reaches the line, never the raw controller phase.
  assert.equal(
    formatChildStatusLine({ phase: "settling", model: { provider: "a", id: "b" } }),
    "child verifying · a/b",
  );
  assert.equal(
    formatChildStatusLine({ phase: "paused", pausePending: true }),
    "child pausing",
  );
  assert.equal(
    formatChildStatusLine({ phase: "running", retrying: true }),
    "child retrying",
  );
});

test("child-stats: the panel header stays short and names local todos", () => {
  assert.equal(
    formatChildPanelHeader({
      ref: "2",
      total: 7,
      model: { provider: "open", id: "muse-spark" },
      stats: { context: { tokens: 86_000, contextWindow: 200_000, percent: 43 } },
    }),
    "▌ CHILD 2/7 · open/muse-spark · ctx 43% · local todos",
  );
  assert.equal(
    formatChildPanelHeader({ ref: "1", total: 1 }),
    "▌ CHILD 1/1 · local todos",
  );
  assert.equal(formatChildPanelHeader({}), "▌ CHILD · local todos");
});

test("child-stats: progress detail is the compact fallback for the band", () => {
  assert.equal(
    formatChildProgress({ lastTool: "read src/app.ts", todoDone: 3, todoTotal: 5 }),
    "read src/app.ts · 3/5 todos",
  );
  assert.equal(formatChildProgress({ lastTool: "bash" }), "bash");
  assert.equal(formatChildProgress({ todoTotal: 0 }), "");
  assert.equal(formatChildProgress({}), "");
});

test("child-stats: no formatter can emit a newline or an unbounded line", () => {
  const hostile = {
    ref: "2\n3",
    total: 7,
    phase: "running\tnow",
    model: { provider: "open\nx", id: `y${"z".repeat(400)}` },
    stats: {
      context: { tokens: 1, contextWindow: 10, percent: 10 },
      tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 },
    },
    elapsedMs: 5_000,
    todoDone: 1,
    todoTotal: 2,
  };
  const line = formatChildStatusLine(hostile);
  assert.equal(/[\r\n\t]/.test(line), false);
  assert.ok(line.length < 200, `bounded line: ${line.length}`);
  const header = formatChildPanelHeader(hostile);
  assert.equal(/[\r\n\t]/.test(header), false);
  assert.ok(header.length < 120, `bounded header: ${header.length}`);
});
