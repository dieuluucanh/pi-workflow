/**
 * Integration smoke test: loads the REAL extension module and drives its
 * `session_before_compact` handler end-to-end against a mocked extension
 * context. Guards the core overflow invariant:
 *
 *   while autocompact is enabled, the hook ALWAYS returns a compaction
 *   result — even when every LLM call fails with a context overflow.
 *
 * Run with:
 *
 *   node --test smoke-integration.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

// Load the actual extension entry (exercises the real import graph:
// pi-coding-agent, pi-ai, summarizer.ts, trigger.ts).
import autocompact from "./extensions/autocompact.ts";

// ============================================================================
// Mocks
// ============================================================================

function makePi() {
	const handlers = new Map<string, Array<(event: any, ctx: any) => Promise<unknown>>>();
	const flags = new Map<string, boolean>();
	let command: ((args: string, ctx: any) => Promise<void>) | undefined;
	return {
		pi: {
			registerFlag: (name: string, _opts: unknown) => flags.set(name, true),
			getFlag: (name: string) => flags.get(name),
			on: (event: string, handler: (event: any, ctx: any) => Promise<unknown>) => {
				const list = handlers.get(event) ?? [];
				list.push(handler);
				handlers.set(event, list);
				return () => {};
			},
			registerCommand: (_name: string, opts: { handler: (args: string, ctx: any) => Promise<void> }) => {
				command = opts.handler;
			},
		},
		handler: (event: string) => {
			const list = handlers.get(event);
			assert.ok(list && list.length > 0, `no handler registered for ${event}`);
			return list[0];
		},
		command: () => {
			assert.ok(command, "/autocompact command registered");
			return command as (args: string, ctx: any) => Promise<void>;
		},
	};
}

function makeCtx(complete: (model: any, context: any, options: any) => Promise<any>) {
	const notifications: { message: string; level: string }[] = [];
	return {
		ctx: {
			hasUI: false,
			ui: {
				notify: (message: string, level: string) => {
					notifications.push({ message, level });
				},
				setStatus: () => {},
				theme: { fg: (_role: string, text: string) => text },
			},
			modelRegistry: {
				find: () => undefined,
				complete,
			},
			model: { contextWindow: 100_000, maxTokens: 8192, provider: "test", id: "test-model" },
			getContextUsage: () => ({ tokens: 10_000, contextWindow: 100_000 }),
			sessionManager: { getBranch: () => [] },
			isIdle: () => true,
			signal: undefined,
			compact: (_options?: unknown) => {},
		},
		notifications,
	};
}

function okSummary(text: string) {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-completions",
		provider: "test",
		model: "test-model",
		usage: {
			input: 10,
			output: 10,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 20,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function overflowResponse() {
	return {
		role: "assistant",
		content: [],
		api: "openai-completions",
		provider: "test",
		model: "test-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "error",
		errorMessage:
			"This model's maximum context length is 131072 tokens. However, you requested 200000 tokens.",
		timestamp: Date.now(),
	};
}

function makeEvent(reason: "manual" | "threshold" | "overflow" = "overflow") {
	const messages = [
		{ role: "user", content: "Fix the login bug", timestamp: 1 },
		{ role: "assistant", content: [{ type: "text", text: "Investigating auth" }], api: "openai-completions", provider: "test", model: "m", usage: {
			input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		}, stopReason: "stop", timestamp: 2 },
		{ role: "user", content: "Still failing", timestamp: 3 },
	];
	return {
		type: "session_before_compact" as const,
		preparation: {
			messagesToSummarize: messages,
			turnPrefixMessages: [],
			firstKeptEntryId: "entry-kept-1",
			tokensBefore: 123_456,
			previousSummary: "EARLIER SUMMARY",
			fileOps: {
				read: new Set(["/src/a.ts"]),
				written: new Set<string>(),
				edited: new Set(["/src/b.ts"]),
			},
		},
		branchEntries: [],
		customInstructions: undefined,
		reason,
		willRetry: reason === "overflow",
		signal: undefined,
	};
}

// ============================================================================
// Tests
// ============================================================================

test("smoke: hook returns a compaction on the happy path", async () => {
	const { pi, handler } = makePi();
	autocompact(pi as any);
	const { ctx, notifications } = makeCtx(async () => okSummary("LLM SUMMARY BODY"));

	const event = makeEvent("overflow");
	const result = (await handler("session_before_compact")(event, ctx)) as any;

	assert.ok(result?.compaction, "hook must return a compaction result");
	assert.ok(result.compaction.summary.startsWith("LLM SUMMARY BODY"));
	assert.ok(result.compaction.summary.includes("EARLIER SUMMARY") === false); // single-shot, no fold
	assert.equal(result.compaction.firstKeptEntryId, "entry-kept-1");
	assert.equal(result.compaction.tokensBefore, 123_456);
	assert.equal(result.compaction.details.strategy, "single");
	// Cumulative files: preparation fileOps + structured sections in the summary.
	assert.ok(result.compaction.summary.includes("## Files Read\n- /src/a.ts"));
	assert.ok(result.compaction.summary.includes("## Files Modified\n- /src/b.ts"));
	assert.ok(notifications.some((n) => n.message.includes("summary ready (single)")));
});

test("smoke: hook STILL returns a compaction when every LLM call overflows", async () => {
	const { pi, handler } = makePi();
	autocompact(pi as any);
	const { ctx, notifications } = makeCtx(async () => overflowResponse());

	const result = (await handler("session_before_compact")(makeEvent("overflow"), ctx)) as any;

	assert.ok(result?.compaction, "fallback must un-brick the session");
	assert.equal(result.compaction.details.strategy, "fallback");
	assert.ok(result.compaction.details.fallbackReason.includes("Context overflow"));
	// Fallback content: previous summary + goal + files preserved.
	assert.ok(result.compaction.summary.includes("EARLIER SUMMARY"));
	assert.ok(result.compaction.summary.includes("Fix the login bug"));
	assert.ok(result.compaction.summary.includes("- /src/a.ts"));
	assert.ok(notifications.some((n) => n.level === "warning" && n.message.includes("deterministic fallback")));
});

test("smoke: disabled hook defers to native compaction (returns undefined)", async () => {
	const { pi, handler, command } = makePi();
	autocompact(pi as any);
	const { ctx } = makeCtx(async () => okSummary("should not be called"));

	// Toggle the SAME instance off via its registered command.
	await command()("off", ctx);

	const result = await handler("session_before_compact")(makeEvent("overflow"), ctx);
	assert.equal(result, undefined);
});

test("smoke: settings-model override is resolved via the registry", async () => {
	// resolveSettings reads the real agent settings.json; autocompact.model is
	// unset there, so the current model is used — assert the registry path by
	// overriding find() to return the override and complete() to record it.
	const { pi, handler } = makePi();
	autocompact(pi as any);
	let completedWithModel: any;
	const { ctx } = makeCtx(async (model) => {
		completedWithModel = model;
		return okSummary("ok");
	});
	await handler("session_before_compact")(makeEvent("manual"), ctx);
	assert.ok(completedWithModel, "summarizer called with a resolved model");
	assert.equal(completedWithModel.contextWindow, 100_000);
});
