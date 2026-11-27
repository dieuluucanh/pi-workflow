/**
 * Trigger state machine for autocompact pre-warming.
 *
 * Pure decision functions, injected with clock/usage values so they are unit
 * testable. They encode three fixes over the original heuristic:
 *
 * 1. No high-water suppression — after a compaction the context drops, which
 *    naturally prevents thrash; tokens no longer have to exceed the previous
 *    session peak before pre-warming can re-arm.
 * 2. No silent drops — when the debounce timer elapses while the agent is
 *    busy, the attempt is re-armed on a short poll instead of being discarded,
 *    so the compaction fires at the first idle gap.
 * 3. Hard trigger — at/above `hardTriggerThreshold` the debounce is bypassed:
 *    high context is no longer "pre-warming" territory.
 *
 * Note: pre-warm compaction can only start when the agent is idle — pi fires
 * `agent_settled` only after a run fully settles, so mid-run growth is covered
 * by the poll-until-idle loop and core's own overflow recovery.
 */

export interface TriggerSettings {
	/** Context fraction at which pre-warming is scheduled. */
	prewarmThreshold: number;
	/** Context fraction at which the debounce is bypassed. */
	hardTriggerThreshold: number;
	/** Minimum time (ms) between compactions for threshold-triggered pre-warms. */
	prewarmDebounceMs: number;
}

/** Poll interval (ms) used to re-arm a fire attempt while the agent is busy. */
export const RETRY_POLL_MS = 2000;

/** What the `agent_settled` handler should do. */
export type TriggerDecision =
	/** No usage data, or below the pre-warm threshold. */
	| "none"
	/** Above threshold but within the debounce window of the last compaction. */
	| "debounce"
	/** Above threshold, outside the debounce window — schedule the pre-warm. */
	| "fire"
	/** At/above the hard threshold — schedule immediately, bypassing the debounce. */
	| "hard-fire";

export interface TriggerUsage {
	tokens: number | null;
	contextWindow: number;
}

export interface TriggerInput {
	usage: TriggerUsage | undefined;
	settings: TriggerSettings;
	/** Timestamp of the last completed compaction (0 = never). */
	lastCompactionTimestamp: number;
	/** Current time (ms), injectable for tests. */
	now: number;
}

function clamp01(value: number): number {
	if (!Number.isFinite(value)) return 0;
	return Math.min(1, Math.max(0, value));
}

/**
 * Decide what to do on `agent_settled` given the current context usage.
 * Hard threshold wins over the debounce; the debounce only gates the
 * pre-warm ("fire") path.
 */
export function decideTrigger(input: TriggerInput): TriggerDecision {
	const { usage, settings, lastCompactionTimestamp, now } = input;
	if (!usage || usage.contextWindow <= 0) return "none";
	if (usage.tokens == null) return "none";
	const percent = usage.tokens / usage.contextWindow;
	if (percent >= clamp01(settings.hardTriggerThreshold)) return "hard-fire";
	if (percent < clamp01(settings.prewarmThreshold)) return "none";
	if (now - lastCompactionTimestamp < settings.prewarmDebounceMs) {
		return "debounce";
	}
	return "fire";
}

/** What the pending timer should do when it elapses. */
export type FireDecision = "compact" | "retry-later" | "cancel";

/**
 * Decide what an elapsed pre-warm timer should do. A busy agent no longer
 * consumes the attempt ("retry-later" re-arms on a short poll); only an
 * aborted session cancels it.
 */
export function decideFire(input: {
	isIdle: boolean;
	aborted: boolean;
}): FireDecision {
	if (input.aborted) return "cancel";
	if (!input.isIdle) return "retry-later";
	return "compact";
}

/** What the `session_compact_failed` handler should do. */
export type SelfHealDecision = "retry" | "skip";

/**
 * Decide whether a failed core compaction should trigger the one-shot
 * self-heal retry. Only automatic reasons are retried (a failed manual
 * /compact surfaces its error directly to the user), aborted runs are left
 * alone, and the pending guard enforces exactly one retry per failure chain.
 */
export function decideSelfHeal(input: {
	enabled: boolean;
	reason: "manual" | "threshold" | "overflow";
	aborted: boolean;
	retryPending: boolean;
}): SelfHealDecision {
	if (!input.enabled) return "skip";
	if (input.aborted) return "skip";
	if (input.reason === "manual") return "skip";
	if (input.retryPending) return "skip";
	return "retry";
}
