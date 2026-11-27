/**
 * Tests for the bounded summarizer (summarizer.ts).
 *
 * Dependency-free unit tests with a scripted fake `complete` function — no
 * network, no direct pi-ai imports (fixture types are derived from the module
 * under test). Run with:
 *
 *   node --test summarizer.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
	buildFallbackSummary,
	computeBudget,
	formatStructuredSections,
	packChunks,
	serializeMessage,
	serializeToParts,
	summarizeFailure,
	summarizeWithFallback,
	sumUsage,
	trimChunksToCap,
	truncateWithMarker,
	type CompleteFn,
	type SummarizeInput,
	type SummarizerModel,
} from "./summarizer.ts";

// ============================================================================
// Fixture types (derived from the module under test — no pi-ai import)
// ============================================================================

/** The pi-ai Message type accepted by the serializer. */
type AnyMessage = Parameters<typeof serializeMessage>[0];
/** The pi-ai AssistantMessage returned by CompleteFn. */
type AssistantMessage = Awaited<ReturnType<CompleteFn>>;
type Usage = AssistantMessage["usage"];

// ============================================================================
// Fixtures
// ============================================================================

function zeroUsage(overrides: Partial<Usage> = {}): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		...overrides,
	};
}

function userMessage(text: string): AnyMessage {
	return { role: "user", content: text, timestamp: 1_000 };
}

function toolResultMessage(text: string): AnyMessage {
	return {
		role: "toolResult",
		toolCallId: "call-1",
		toolName: "read",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: 2_000,
	};
}

function okMessage(text: string, usage?: Partial<Usage>): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-completions",
		provider: "test",
		model: "test-model",
		usage: zeroUsage(usage),
		stopReason: "stop",
		timestamp: 3_000,
	};
}

function errorMessage(message: string): AssistantMessage {
	return {
		...okMessage(""),
		stopReason: "error",
		errorMessage: message,
		content: [],
	};
}

function lengthMessage(text = "partial summary"): AssistantMessage {
	return { ...okMessage(text), stopReason: "length" };
}

const OVERFLOW_ERROR =
	"This model's maximum context length is 131072 tokens. However, you requested 140000 tokens.";

interface FakeCall {
	systemPrompt: string | undefined;
	userText: string;
	maxTokens: number | undefined;
}

/** Scripted fake complete: `responses[i]` answers call i; records each request. */
function fakeComplete(
	responses: AssistantMessage[] | ((call: number) => AssistantMessage),
): {
	complete: CompleteFn;
	calls: () => number;
	requests: () => FakeCall[];
} {
	let count = 0;
	const requests: FakeCall[] = [];
	const complete: CompleteFn = async (_model, context, options) => {
		count += 1;
		const user = context.messages.at(-1);
		let userText = "";
		if (user && user.role === "user") {
			userText =
				typeof user.content === "string"
					? user.content
					: user.content
							.map((block) => (block.type === "text" ? block.text : ""))
							.join("");
		}
		requests.push({
			systemPrompt: context.systemPrompt,
			userText,
			maxTokens: options?.maxTokens,
		});
		return typeof responses === "function"
			? responses(count)
			: (responses[count - 1] ?? okMessage(""));
	};
	return { complete, calls: () => count, requests: () => requests };
}

const MODEL: SummarizerModel = { contextWindow: 100_000, maxTokens: 8192 };

function makeInput(overrides: Partial<SummarizeInput> = {}): SummarizeInput {
	return {
		model: MODEL,
		messages: [userMessage("hello world")],
		reserveTokens: 16_384,
		structured: {},
		...overrides,
	};
}

// ============================================================================
// computeBudget
// ============================================================================

test("computeBudget: subtracts reserve, output reserve and safety margin", () => {
	// outputReserve = min(0.8*16384, 8192) = 8192; safety = max(2048, 5000) = 5000
	// input = 100000 - 16384 - 8192 - 5000 = 70424 tokens
	const budget = computeBudget({ contextWindow: 100_000, maxTokens: 8192 }, 16_384);
	assert.equal(budget.contextWindow, 100_000);
	assert.equal(budget.maxOutputTokens, 8192);
	assert.equal(budget.maxInputChars, 70_424 * 4);
	assert.equal(budget.maxChunkChars, Math.floor(70_424 * 4 * 0.7));
});

test("computeBudget: caps output reserve at model.maxTokens and falls back for unknown window", () => {
	const budget = computeBudget({ contextWindow: 0, maxTokens: 0 }, 16_384);
	assert.equal(budget.contextWindow, 131_072); // DEFAULT_ASSUMED_CONTEXT_WINDOW
	// maxTokens 0 → treated as unbounded → 0.8 * 16384 = 13107
	assert.equal(budget.maxOutputTokens, 13_107);
});

test("computeBudget: clamps to sane minimums for tiny windows", () => {
	const budget = computeBudget({ contextWindow: 1_000, maxTokens: 100 }, 1_000);
	// outputReserve = min(800, 100) = 100; input tokens floored at 1024
	assert.equal(budget.maxOutputTokens, 100);
	assert.equal(budget.maxInputChars, 1024 * 4);
	assert.equal(budget.maxChunkChars, 4000); // MIN_HALVED_CHARS floor
});

// ============================================================================
// Serialization
// ============================================================================

test("serializeMessage: core-compatible formats per role", () => {
	assert.equal(serializeMessage(userMessage("hello"), 10_000), "[User]: hello");

	const assistant: AnyMessage = {
		role: "assistant",
		content: [
			{ type: "thinking", thinking: "deep thought" },
			{ type: "text", text: "the answer" },
			{ type: "toolCall", id: "call-1", name: "read_file", arguments: { path: "/a.ts" } },
		],
		api: "openai-completions",
		provider: "test",
		model: "m",
		usage: zeroUsage(),
		stopReason: "stop",
		timestamp: 4_000,
	};
	const serialized = serializeMessage(assistant, 10_000);
	assert.ok(serialized.includes("[Assistant thinking]: deep thought"));
	assert.ok(serialized.includes("[Assistant]: the answer"));
	assert.ok(serialized.includes('[Assistant tool calls]: read_file(path="/a.ts")'));

	assert.equal(
		serializeMessage({ role: "system", content: "prompt", timestamp: 5_000 }, 10_000),
		"",
	);
});

test("serializeMessage: truncates tool results at 2000 chars with a marker", () => {
	const long = "x".repeat(5_000);
	const serialized = serializeMessage(toolResultMessage(long), 100_000);
	assert.ok(serialized.startsWith(`[Tool result]: ${"x".repeat(2_000)}`));
	assert.ok(serialized.endsWith("\n[... 3000 more characters truncated ...]"));
});

test("serializeMessage: truncates single oversized messages to maxChars", () => {
	// "[User]: " (8 chars) + 2000 y's = 2008 chars → slice(0, 500), 1508 omitted.
	const serialized = serializeMessage(userMessage("y".repeat(2_000)), 500);
	assert.ok(serialized.length < 600);
	assert.ok(serialized.startsWith("[User]: yyy"));
	assert.ok(serialized.includes("[... 1508 more characters truncated ...]"));
});

test("truncateWithMarker: reports the exact omitted count", () => {
	assert.equal(truncateWithMarker("short", 100), "short");
	const out = truncateWithMarker("a".repeat(50), 30);
	assert.equal(out, `${"a".repeat(30)}\n[... 20 more characters truncated ...]`);
});

test("serializeToParts: drops empty serializations", () => {
	const parts = serializeToParts(
		[userMessage("one"), { role: "system", content: "sys", timestamp: 1 }, userMessage("two")],
		10_000,
	);
	assert.deepEqual(parts, ["[User]: one", "[User]: two"]);
});

// ============================================================================
// Chunk packing
// ============================================================================

test("packChunks: never splits a part and starts a new chunk at the boundary", () => {
	const a = "a".repeat(30);
	const b = "b".repeat(30);
	const c = "c".repeat(30);
	// 32 chars per part incl. separator; two fit in 70 → [a,b], then [c].
	const chunks = packChunks([a, b, c], 70);
	assert.equal(chunks.length, 2);
	assert.equal(chunks[0], `${a}\n\n${b}`);
	assert.equal(chunks[1], c);
});

test("packChunks: truncates a single part larger than the chunk budget", () => {
	const chunks = packChunks(["z".repeat(1_000)], 200);
	assert.equal(chunks.length, 1);
	assert.ok(chunks[0].length <= 300); // 200 + marker
	assert.ok(chunks[0].includes("[... 800 more characters truncated ...]"));
});

test("packChunks: returns [] for empty input", () => {
	assert.deepEqual(packChunks([], 100), []);
});

test("trimChunksToCap: keeps first and recent chunks with a digest in between", () => {
	const chunks = ["c0", "c1", "c2", "c3", "c4"];
	const trimmed = trimChunksToCap(chunks, 3);
	assert.deepEqual(trimmed.slice(0, 1), ["c0"]);
	assert.deepEqual(trimmed.slice(2), ["c4"]);
	assert.equal(trimmed.length, 3);
	// Three middle chunks (c1..c3) are replaced by the digest.
	assert.ok(trimmed[1].includes("[... 3 older conversation parts (6 chars) omitted"));
});

test("trimChunksToCap: no-op under the cap or for tiny caps", () => {
	const chunks = ["a", "b"];
	assert.deepEqual(trimChunksToCap(chunks, 8), chunks);
	assert.deepEqual(trimChunksToCap(["a", "b", "c"], 2), ["a", "b", "c"]);
});

// ============================================================================
// Response validation
// ============================================================================

test("summarizeFailure: rejects error and length stops, accepts normal stops", () => {
	assert.equal(summarizeFailure(errorMessage(OVERFLOW_ERROR)), OVERFLOW_ERROR);
	assert.equal(
		summarizeFailure({ ...okMessage(""), stopReason: "error" }),
		"Unknown provider error",
	);
	assert.ok((summarizeFailure(lengthMessage()) ?? "").includes("token cap"));
	assert.equal(summarizeFailure(okMessage("fine")), undefined);
	assert.equal(summarizeFailure({ ...okMessage(""), stopReason: "aborted" }), undefined);
});

test("sumUsage: combines totals and cost across calls", () => {
	const combined = sumUsage([
		zeroUsage({ input: 10, output: 5, totalTokens: 15, cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, total: 3 } }),
		zeroUsage({ input: 20, output: 5, totalTokens: 25, cost: { input: 2, output: 1, cacheRead: 0, cacheWrite: 0, total: 3 } }),
	]);
	assert.equal(combined?.input, 30);
	assert.equal(combined?.output, 10);
	assert.equal(combined?.totalTokens, 40);
	assert.equal(combined?.cost.total, 6);
	assert.equal(sumUsage([]), undefined);
});

// ============================================================================
// summarizeWithFallback — LLM paths
// ============================================================================

test("summarizeWithFallback: single-shot success appends structured sections", async () => {
	const fake = fakeComplete(() => okMessage("SUMMARY TEXT"));
	const result = await summarizeWithFallback(
		{ complete: fake.complete },
		makeInput({
			structured: {
				todos: [{ step: 1, text: "fix bug", completed: false }],
				readFiles: ["/src/a.ts"],
			},
		}),
	);

	assert.equal(result.strategy, "single");
	assert.equal(result.folds, 1);
	assert.ok(result.summary.startsWith("SUMMARY TEXT"));
	assert.ok(result.summary.includes("## Active Todo Items"));
	assert.ok(result.summary.includes("1. ☐ fix bug"));
	assert.ok(result.summary.includes("## Files Read\n- /src/a.ts"));

	const [request] = fake.requests();
	assert.ok(request.systemPrompt?.startsWith("You are a context summarization assistant"));
	assert.ok(request.userText.includes("[User]: hello world"));
	assert.ok(request.userText.includes("Use this EXACT format"));
	// maxTokens mirrors core: min(0.8 * 16384, 8192) = 8192
	assert.equal(request.maxTokens, 8192);
});

test("summarizeWithFallback: folds sequentially, carrying the running summary", async () => {
	const fake = fakeComplete((call) => okMessage(`summary-part-${call}`));
	// 4000-char parts with a 4000-char chunk budget (6000-token window after
	// clamping) force two chunks.
	const big = (ch: string, n: number) => userMessage(ch.repeat(n));
	const result = await summarizeWithFallback(
		{ complete: fake.complete },
		makeInput({
			model: { contextWindow: 6_000, maxTokens: 500 },
			messages: [big("a", 4_000), big("b", 4_000)],
		}),
	);

	assert.equal(result.strategy, "fold");
	assert.equal(result.folds, 2);
	assert.equal(result.summary, "summary-part-2");

	const requests = fake.requests();
	assert.equal(requests.length, 2);
	assert.ok(requests[0].userText.includes("part 1 of 2"));
	assert.ok(!requests[0].userText.includes("summary-so-far"));
	assert.ok(requests[1].userText.includes("part 2 of 2"));
	assert.ok(requests[1].userText.includes("<summary-so-far>\nsummary-part-1"));
	assert.ok(requests[1].userText.includes("FINAL part"));
});

test("summarizeWithFallback: enforces the chunk cap with a middle digest", async () => {
	const fake = fakeComplete((call) => okMessage(`s${call}`));
	const big = (ch: string, n: number) => userMessage(ch.repeat(n));
	// 5 messages × 4000 chars → 5 chunks; maxChunks 3 → first + digest + last.
	const result = await summarizeWithFallback(
		{ complete: fake.complete },
		makeInput({
			model: { contextWindow: 6_000, maxTokens: 500 },
			messages: [big("a", 4_000), big("b", 4_000), big("c", 4_000), big("d", 4_000), big("e", 4_000)],
			maxChunks: 3,
		}),
	);

	assert.equal(result.strategy, "fold");
	assert.equal(result.folds, 3);
	assert.equal(
		result.summary,
		"s3\n\n(autocompact: the conversation exceeded the summarizer window; some middle parts were omitted.)",
	);
	const digestCall = fake.requests()[1];
	assert.ok(digestCall.userText.includes("older conversation parts ("));
	assert.ok(digestCall.userText.includes("omitted to fit the summarizer window"));
});

test("summarizeWithFallback: halves the excerpt on overflow and retries", async () => {
	const fake = fakeComplete([errorMessage(OVERFLOW_ERROR), okMessage("recovered")]);
	const result = await summarizeWithFallback(
		{ complete: fake.complete },
		makeInput({ messages: [userMessage("w".repeat(5_000))] }),
	);

	assert.equal(result.strategy, "single");
	assert.equal(result.summary, "recovered");
	assert.equal(fake.calls(), 2);

	const requests = fake.requests();
	assert.ok(requests[1].userText.includes("[... earlier half of this excerpt truncated"));
	// The halved excerpt must actually be smaller than the original request.
	assert.ok(requests[1].userText.length < requests[0].userText.length);
});

test("summarizeWithFallback: persistent overflow degrades to the deterministic fallback", async () => {
	const fake = fakeComplete(() => errorMessage(OVERFLOW_ERROR));
	const result = await summarizeWithFallback(
		{ complete: fake.complete },
		makeInput({
			previousSummary: "PREVIOUS",
			structured: {
				todos: [{ step: 2, text: "ship it", completed: true }],
				modifiedFiles: ["/src/b.ts"],
			},
		}),
	);

	assert.equal(result.strategy, "fallback");
	assert.ok((result.fallbackReason ?? "").includes("Context overflow"));
	assert.ok(result.summary.includes("PREVIOUS"));
	assert.ok(result.summary.includes("LLM summarization failed"));
	assert.ok(result.summary.includes("2. ✓ ship it"));
	assert.ok(result.summary.includes("## Files Modified\n- /src/b.ts"));
});

test("summarizeWithFallback: length stops are rejected, never persisted as summaries", async () => {
	const fake = fakeComplete(() => lengthMessage("partial"));
	const result = await summarizeWithFallback(
		{ complete: fake.complete },
		makeInput({ messages: [userMessage("short")] }),
	);

	assert.equal(result.strategy, "fallback");
	assert.ok((result.fallbackReason ?? "").includes("token cap"));
	assert.equal(fake.calls(), 2); // one plain retry, then give up
	assert.ok(!result.summary.startsWith("partial"));
});

test("summarizeWithFallback: empty responses get one plain retry, then fall back", async () => {
	const fake = fakeComplete(() => okMessage("   "));
	const result = await summarizeWithFallback(
		{ complete: fake.complete },
		makeInput(),
	);

	assert.equal(result.strategy, "fallback");
	assert.ok((result.fallbackReason ?? "").includes("empty response"));
	assert.equal(fake.calls(), 2);
});

test("summarizeWithFallback: non-overflow provider errors surface their real message", async () => {
	const fake = fakeComplete(() => errorMessage("429 Too Many Requests"));
	const result = await summarizeWithFallback(
		{ complete: fake.complete },
		makeInput(),
	);

	assert.equal(result.strategy, "fallback");
	assert.ok((result.fallbackReason ?? "").includes("429 Too Many Requests"));
});

// ============================================================================
// buildFallbackSummary + structured sections
// ============================================================================

test("buildFallbackSummary: preserves goal, previous summary, recent messages and state", () => {
	const messages: AnyMessage[] = [
		userMessage("Fix the login bug in the auth service"),
		...Array.from({ length: 8 }, (_, i) => userMessage(`follow-up ${i + 1}`)),
	];
	const summary = buildFallbackSummary(
		{
			messages,
			previousSummary: "PREVIOUS SUMMARY BODY",
			structured: {
				todos: [{ step: 1, text: "write test", completed: false }],
				planSteps: ["1. plan step one"],
				readFiles: ["/a.ts"],
				modifiedFiles: ["/b.ts"],
			},
		},
		"provider exploded",
	);

	assert.ok(summary.includes("## Goal\nFix the login bug"));
	assert.ok(summary.includes("LLM summarization failed (provider exploded)"));
	assert.ok(summary.includes("## Previous Summary\nPREVIOUS SUMMARY BODY"));
	// Recent messages: the LAST 6, numbered 1..6
	assert.ok(!summary.includes("follow-up 2\n") && !summary.endsWith("follow-up 2"));
	for (let i = 3; i <= 8; i += 1) {
		assert.ok(summary.includes(`${i - 2}. follow-up ${i}`));
	}
	assert.ok(summary.includes("1. ☐ write test"));
	assert.ok(summary.includes("## Plan Steps\n1. plan step one"));
	assert.ok(summary.includes("## Files Read\n- /a.ts"));
	assert.ok(summary.includes("## Files Modified\n- /b.ts"));
});

test("buildFallbackSummary: falls back to the previous summary when there are no user messages", () => {
	const summary = buildFallbackSummary(
		{ messages: [], previousSummary: "OLD STATE", structured: {} },
		"boom",
	);
	assert.ok(summary.includes("(see previous summary)"));
	assert.ok(summary.includes("OLD STATE"));
});

test("formatStructuredSections: caps file lists at 200 entries with a note", () => {
	const files = Array.from({ length: 250 }, (_, i) => `/f/${i}.ts`);
	const sections = formatStructuredSections({ readFiles: files });
	assert.ok(sections.includes("- /f/199.ts"));
	assert.ok(!sections.includes("- /f/200.ts"));
	assert.ok(sections.includes("and 50 more"));
});
