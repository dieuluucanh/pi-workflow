/**
 * Tests for the autocompact trigger state machine (trigger.ts).
 *
 * Dependency-free pure-function tests. Run with:
 *
 *   node --test trigger.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
	decideFire,
	decideSelfHeal,
	decideTrigger,
	type TriggerSettings,
	type TriggerUsage,
} from "./trigger.ts";

const SETTINGS: TriggerSettings = {
	prewarmThreshold: 0.7,
	hardTriggerThreshold: 0.9,
	prewarmDebounceMs: 15_000,
};

function usage(tokens: number, contextWindow = 100_000): TriggerUsage {
	return { tokens, contextWindow };
}

// ============================================================================
// decideTrigger
// ============================================================================

test("decideTrigger: returns none without usable usage data", () => {
	const base = { settings: SETTINGS, lastCompactionTimestamp: 0, now: 60_000 };
	assert.equal(decideTrigger({ ...base, usage: undefined }), "none");
	assert.equal(
		decideTrigger({ ...base, usage: { tokens: null, contextWindow: 100_000 } }),
		"none",
	);
	assert.equal(decideTrigger({ ...base, usage: usage(99_000, 0) }), "none");
});

test("decideTrigger: below the prewarm threshold is none", () => {
	assert.equal(
		decideTrigger({
			usage: usage(69_999),
			settings: SETTINGS,
			lastCompactionTimestamp: 0,
			now: 60_000,
		}),
		"none",
	);
	// Exactly at the threshold counts as above it.
	assert.equal(
		decideTrigger({
			usage: usage(70_000),
			settings: SETTINGS,
			lastCompactionTimestamp: 0,
			now: 60_000,
		}),
		"fire",
	);
});

test("decideTrigger: above threshold outside the debounce window fires", () => {
	assert.equal(
		decideTrigger({
			usage: usage(80_000),
			settings: SETTINGS,
			lastCompactionTimestamp: 0,
			now: 60_000,
		}),
		"fire",
	);
});

test("decideTrigger: within the debounce window of the last compaction defers", () => {
	// last compact 5s ago with a 15s debounce.
	assert.equal(
		decideTrigger({
			usage: usage(80_000),
			settings: SETTINGS,
			lastCompactionTimestamp: 55_000,
			now: 60_000,
		}),
		"debounce",
	);
	// 15s later the same usage fires again — no high-water suppression.
	assert.equal(
		decideTrigger({
			usage: usage(80_000),
			settings: SETTINGS,
			lastCompactionTimestamp: 55_000,
			now: 75_000,
		}),
		"fire",
	);
});

test("decideTrigger: no high-water suppression after a compaction (old bug)", () => {
	// The old implementation suppressed pre-warm until tokens exceeded the
	// previous session peak. Here tokens sit far below any old peak, yet the
	// decision depends only on threshold + debounce (now is well past it).
	assert.equal(
		decideTrigger({
			usage: usage(75_000),
			settings: SETTINGS,
			lastCompactionTimestamp: 0,
			now: 60_000,
		}),
		"fire",
	);
});

test("decideTrigger: hard threshold bypasses the debounce", () => {
	// 92% context, last compact 2s ago → hard-fire, not debounce.
	assert.equal(
		decideTrigger({
			usage: usage(92_000),
			settings: SETTINGS,
			lastCompactionTimestamp: 58_000,
			now: 60_000,
		}),
		"hard-fire",
	);
	// Just below the hard threshold stays on the debounce path.
	assert.equal(
		decideTrigger({
			usage: usage(89_999),
			settings: SETTINGS,
			lastCompactionTimestamp: 58_000,
			now: 60_000,
		}),
		"debounce",
	);
	// Exactly at the hard threshold is hard-fire.
	assert.equal(
		decideTrigger({
			usage: usage(90_000),
			settings: SETTINGS,
			lastCompactionTimestamp: 0,
			now: 60_000,
		}),
		"hard-fire",
	);
});

test("decideTrigger: clamps out-of-range thresholds", () => {
	// prewarm 5 → clamped to 1: nothing below 100% context reaches the soft path.
	assert.equal(
		decideTrigger({
			usage: usage(95_000),
			settings: { ...SETTINGS, prewarmThreshold: 5, hardTriggerThreshold: 0.99 },
			lastCompactionTimestamp: 0,
			now: 60_000,
		}),
		"none",
	);
	// hard -1 → clamped to 0: everything at or above 0% hard-fires.
	assert.equal(
		decideTrigger({
			usage: usage(10_000),
			settings: { ...SETTINGS, hardTriggerThreshold: -1 },
			lastCompactionTimestamp: 0,
			now: 60_000,
		}),
		"hard-fire",
	);
});

// ============================================================================
// decideFire
// ============================================================================

test("decideFire: compacts when idle, re-arms when busy, cancels when aborted", () => {
	assert.equal(decideFire({ isIdle: true, aborted: false }), "compact");
	assert.equal(decideFire({ isIdle: false, aborted: false }), "retry-later");
	assert.equal(decideFire({ isIdle: true, aborted: true }), "cancel");
	// Abort wins over busy: never compact into a dying session.
	assert.equal(decideFire({ isIdle: false, aborted: true }), "cancel");
});

// ============================================================================
// decideSelfHeal
// ============================================================================

test("decideSelfHeal: retries automatic failures once the chain is clear", () => {
	for (const reason of ["threshold", "overflow"] as const) {
		assert.equal(
			decideSelfHeal({ enabled: true, reason, aborted: false, retryPending: false }),
			"retry",
		);
	}
});

test("decideSelfHeal: skips manual failures, aborts, disabled state and pending retries", () => {
	assert.equal(
		decideSelfHeal({ enabled: true, reason: "manual", aborted: false, retryPending: false }),
		"skip",
	);
	assert.equal(
		decideSelfHeal({ enabled: true, reason: "overflow", aborted: true, retryPending: false }),
		"skip",
	);
	assert.equal(
		decideSelfHeal({ enabled: false, reason: "overflow", aborted: false, retryPending: false }),
		"skip",
	);
	// No second retry while one is outstanding.
	assert.equal(
		decideSelfHeal({ enabled: true, reason: "overflow", aborted: false, retryPending: true }),
		"skip",
	);
});
