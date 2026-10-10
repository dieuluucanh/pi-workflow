/**
 * Bounded summarization for autocompact.
 *
 * Core design constraint: a compaction triggered *because* the context is full
 * must never send an unbounded prompt of its own. Pi core's default compaction
 * serializes the whole conversation into a single LLM request, which fails with
 * the very context-overflow error the compaction is trying to recover from.
 *
 * This module guarantees every summarizer request fits the model:
 *
 * 1. Budget    — input budget = contextWindow − reserveTokens − outputReserve −
 *                safety margin (chars ≈ tokens × 4, same heuristic as core).
 * 2. Chunking  — the serialized conversation is packed into window-sized chunks
 *                (never splitting a message; oversized single messages are
 *                truncated with an explicit marker).
 * 3. Fold      — a single call when everything fits, otherwise sequential folds
 *                that carry the running summary forward (bounded chunk cap with
 *                a deterministic middle digest when exceeded).
 * 4. Validate  — error and length stop-reasons are rejected (a length-capped
 *                summary is partial and must not become the session checkpoint);
 *                overflow errors retry with halved input before giving up.
 * 5. Fallback  — if the LLM path fails entirely, `buildFallbackSummary`
 *                deterministically assembles a continuation summary without any
 *                LLM call, so a compaction always succeeds and the session is
 *                never bricked.
 *
 * All functions are pure or take an injected `complete` function, which keeps
 * the whole chain unit-testable without network access.
 */

import { contentText, isContextOverflow } from "@earendil-works/pi-ai";
import type {
	AssistantMessage,
	Context,
	Message,
	Usage,
} from "@earendil-works/pi-ai";

// ============================================================================
// Constants
// ============================================================================

/** Chars-per-token heuristic, matching core's estimateTokens. */
export const CHARS_PER_TOKEN = 4;

/**
 * Assumed context window when the model does not declare one (contextWindow 0).
 * Conservative: 128k tokens is a safe lower bound for modern models.
 */
export const DEFAULT_ASSUMED_CONTEXT_WINDOW = 131072;

/** Minimum safety margin (tokens) reserved for prompt-template overhead. */
const SAFETY_MARGIN_MIN_TOKENS = 2048;

/** Safety margin as a fraction of the context window (absorbs estimator error). */
const SAFETY_MARGIN_RATIO = 0.05;

/** Chunks target this fraction of the input budget, leaving room for instructions. */
const CHUNK_TARGET_RATIO = 0.7;

/** Maximum times a single call's input is halved when the provider reports overflow. */
const MAX_OVERFLOW_HALVINGS = 3;

/** Floor for halved input, below which retrying is pointless (chars). */
const MIN_HALVED_CHARS = 4000;

/** Core parity: maximum characters of a single tool result in serialized text. */
const TOOL_RESULT_MAX_CHARS = 2000;

/** Cap on file entries rendered into a summary (each list). */
const MAX_FILE_ENTRIES = 200;

/** Default number of recent user messages preserved by the fallback summary. */
export const FALLBACK_RECENT_MESSAGES = 6;

/** Max chars of a user message preserved by the fallback summary. */
export const FALLBACK_MESSAGE_CHARS = 300;

// ============================================================================
// Types
// ============================================================================

/** Structural subset of pi-ai's Model used for budget math and calls. */
export interface SummarizerModel {
	contextWindow: number;
	maxTokens: number;
}

/** Options forwarded to the injected complete function (mirrors core options). */
export interface SummarizerCallOptions {
	maxTokens?: number;
	signal?: AbortSignal;
	cacheRetention?: "none";
	sessionId?: string;
	apiKey?: string;
	headers?: Record<string, string>;
	env?: Record<string, string>;
}

/** Injectable LLM call — matches ModelRegistry.complete's observable shape. */
export type CompleteFn = (
	model: SummarizerModel,
	context: Context,
	options?: SummarizerCallOptions,
) => Promise<AssistantMessage>;

/** Structured state preserved verbatim in summaries (todos, plan, files). */
export interface SummarizerStructured {
	todos?: { step: number; text: string; completed: boolean }[];
	planSteps?: string[];
	readFiles?: string[];
	modifiedFiles?: string[];
}

/** Input for {@link summarizeWithFallback}. */
export interface SummarizeInput {
	model: SummarizerModel;
	/** LLM-compatible messages (convertToLlm output) to summarize. */
	messages: Message[];
	/** Summary from the previous compaction, folded into the new summary. */
	previousSummary?: string;
	/** Extra focus instructions (e.g. /compact focus, pre-warm note). */
	customInstructions?: string;
	/** Compaction reserveTokens setting (drives the output reserve). */
	reserveTokens: number;
	/** Structured state appended deterministically to the final summary. */
	structured: SummarizerStructured;
	/** Maximum fold chunks before middle-digest trimming (default 8). */
	maxChunks?: number;
	/** Routing session id for the summarizer calls. */
	sessionId?: string;
	/** Optional request-time auth overrides. */
	apiKey?: string;
	headers?: Record<string, string>;
	env?: Record<string, string>;
}

/** How the final summary was produced. */
export type SummarizeStrategy = "single" | "fold" | "fallback";

export interface SummarizeResult {
	summary: string;
	strategy: SummarizeStrategy;
	/** Number of fold calls when strategy === "fold". */
	folds?: number;
	/** Combined usage of all LLM calls (undefined for the fallback). */
	usage?: Usage;
	/** Present when strategy === "fallback": why the LLM path failed. */
	fallbackReason?: string;
}

/** Raised when the LLM summarization path fails after its bounded retries. */
export class SummarizerError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SummarizerError";
	}
}

// ============================================================================
// Budget
// ============================================================================

export interface SummarizerBudget {
	/** Max chars of conversation text a single summarizer call may carry. */
	maxInputChars: number;
	/** Target chunk size in chars (fraction of the budget). */
	maxChunkChars: number;
	/** Max output tokens for one summary call. */
	maxOutputTokens: number;
	/** The context window the budget was computed against. */
	contextWindow: number;
}

/**
 * Compute the per-call summarizer budget for a model.
 *
 * `outputReserve` mirrors core (`min(0.8 × reserveTokens, model.maxTokens)`).
 * The safety margin keeps the real request under the provider limit even when
 * the chars/4 estimate undercounts.
 */
export function computeBudget(
	model: SummarizerModel | undefined,
	reserveTokens: number,
): SummarizerBudget {
	const contextWindow =
		model && model.contextWindow > 0
			? model.contextWindow
			: DEFAULT_ASSUMED_CONTEXT_WINDOW;
	const modelMaxTokens =
		model && model.maxTokens > 0 ? model.maxTokens : Number.POSITIVE_INFINITY;
	const reserve = reserveTokens > 0 ? reserveTokens : 16384;
	// Mirror core: min(0.8 × reserveTokens, model.maxTokens) — no floor, so the
	// request never exceeds the model's real output limit.
	const maxOutputTokens = Math.min(
		Math.floor(0.8 * reserve),
		modelMaxTokens,
	);
	const safetyMargin = Math.max(
		SAFETY_MARGIN_MIN_TOKENS,
		Math.ceil(contextWindow * SAFETY_MARGIN_RATIO),
	);
	const inputBudgetTokens = Math.max(
		1024,
		contextWindow - reserve - maxOutputTokens - safetyMargin,
	);
	const maxInputChars = inputBudgetTokens * CHARS_PER_TOKEN;
	return {
		maxInputChars,
		maxChunkChars: Math.max(
			MIN_HALVED_CHARS,
			Math.floor(maxInputChars * CHUNK_TARGET_RATIO),
		),
		maxOutputTokens,
		contextWindow,
	};
}

/** Estimate token count from text length (chars/4 heuristic, same as core). */
export function estimateTextTokens(text: string): number {
	return Math.ceil(text.length / CHARS_PER_TOKEN);
}

// ============================================================================
// Serialization (per-message, core-format compatible)
// ============================================================================

/** Truncate with an explicit marker so the model knows content was dropped. */
export function truncateWithMarker(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	const omitted = text.length - maxChars;
	return `${text.slice(0, maxChars)}\n[... ${omitted} more characters truncated ...]`;
}

/**
 * Serialize ONE LLM message to text using the same format as core's
 * serializeConversation, so chunked summaries read identically to single-shot
 * ones. Tool results are truncated per-message (core parity); a single message
 * larger than `maxChars` is truncated with a marker.
 */
export function serializeMessage(msg: Message, maxChars: number): string {
	let text: string;
	switch (msg.role) {
		case "user": {
			const content = contentText(msg.content, "");
			text = content ? `[User]: ${content}` : "";
			break;
		}
		case "assistant": {
			const parts: string[] = [];
			const thinking: string[] = [];
			const toolCalls: string[] = [];
			for (const block of msg.content) {
				if (block.type === "thinking") {
					thinking.push(block.thinking);
				} else if (block.type === "toolCall") {
					const args = Object.entries(block.arguments)
						.map(([k, v]) => `${k}=${JSON.stringify(v)}`)
						.join(", ");
					toolCalls.push(`${block.name}(${args})`);
				}
			}
			if (thinking.length > 0) {
				parts.push(`[Assistant thinking]: ${thinking.join("\n")}`);
			}
			if (msg.content.some((block) => block.type === "text")) {
				parts.push(`[Assistant]: ${contentText(msg.content)}`);
			}
			if (toolCalls.length > 0) {
				parts.push(`[Assistant tool calls]: ${toolCalls.join("; ")}`);
			}
			text = parts.join("\n");
			break;
		}
		case "toolResult": {
			const content = contentText(msg.content, "");
			text = content
				? `[Tool result]: ${truncateWithMarker(content, TOOL_RESULT_MAX_CHARS)}`
				: "";
			break;
		}
		case "system":
			// System messages are prompt state, not conversation; skip (core parity).
			text = "";
			break;
		default:
			text = "";
			break;
	}
	if (!text) return "";
	return truncateWithMarker(text, maxChars);
}

/** Serialize a message list into per-message text parts, dropping empties. */
export function serializeToParts(messages: Message[], maxMessageChars: number): string[] {
	const parts: string[] = [];
	for (const msg of messages) {
		const part = serializeMessage(msg, maxMessageChars);
		if (part) parts.push(part);
	}
	return parts;
}

// ============================================================================
// Chunk packing
// ============================================================================

/**
 * Greedily pack serialized parts into chunks, never splitting a part.
 * A part larger than `maxChunkChars` is truncated (marker included).
 * Returns at least one chunk when `parts` is non-empty.
 */
export function packChunks(parts: string[], maxChunkChars: number): string[] {
	if (parts.length === 0) return [];
	const chunks: string[] = [];
	let current: string[] = [];
	let currentChars = 0;
	for (const rawPart of parts) {
		const part = truncateWithMarker(rawPart, maxChunkChars);
		const partChars = part.length + 2; // "\n\n" separator
		if (current.length > 0 && currentChars + partChars > maxChunkChars) {
			chunks.push(current.join("\n\n"));
			current = [];
			currentChars = 0;
		}
		current.push(part);
		currentChars += partChars;
	}
	if (current.length > 0) chunks.push(current.join("\n\n"));
	return chunks;
}

/**
 * Enforce the fold cap: keep the first chunk (session goal), the most recent
 * chunks, and replace everything in between with a one-line digest.
 */
export function trimChunksToCap(chunks: string[], cap: number): string[] {
	if (cap < 3 || chunks.length <= cap) return chunks;
	const droppedCount = chunks.length - (cap - 1);
	const digestChars = chunks
		.slice(1, chunks.length - (cap - 2))
		.reduce((sum, c) => sum + c.length, 0);
	const digest = `[... ${droppedCount} older conversation parts (${digestChars} chars) omitted to fit the summarizer window; the parts before and after this line are intact ...]`;
	return [chunks[0], digest, ...chunks.slice(chunks.length - (cap - 2))];
}

// ============================================================================
// Prompts
// ============================================================================

export const SUMMARIZER_SYSTEM_PROMPT = `You are a context summarization assistant. Your task is to read the conversation excerpt provided by the user and produce or update a structured summary following the exact format specified.

Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.`;

const SUMMARY_FORMAT = `Use this EXACT format:

## Goal
[What the user is trying to accomplish — primary objective and any sub-goals]

## Constraints & Preferences
- [Requirements, preferences, and constraints mentioned by user, or "(none)"]

## Progress
### Done
- [x] [Completed tasks with enough detail to understand what was achieved]

### In Progress
- [ ] [Current work — what was being worked on most recently]

### Blocked
- [Issues, errors, or dependencies blocking progress, or "(none)"]

## Key Decisions
- **[Decision]**: [Rationale — why this approach was chosen over alternatives]

## Next Steps
1. [What should happen next — ordered by priority]

## Critical Context
- [Data, file paths, error messages, environment details needed to continue]
- [User preferences that should be respected going forward]

Important rules:
1. Preserve plan/todo items verbatim with their completion status.
2. Include ALL file paths that were read or modified in the excerpt.
3. Preserve error messages and blockers exactly as they occurred.
4. Be thorough but concise — focus on actionable information.`;

/**
 * Instruction block for one fold call. The conversation excerpt is NOT part of
 * this string — it is assembled (and, on overflow retries, halved) separately
 * so shrinking it actually shrinks the request.
 */
function buildFoldInstructions(options: {
	summarySoFar?: string;
	partIndex: number;
	partCount: number;
	customInstructions?: string;
}): string {
	const { summarySoFar, partIndex, partCount, customInstructions } = options;
	const position =
		partCount > 1
			? `This is part ${partIndex} of ${partCount} of a long conversation, summarized sequentially. `
			: "";
	const previous = summarySoFar
		? `<summary-so-far>\n${summarySoFar}\n</summary-so-far>\n\n`
		: "";
	const update = summarySoFar
		? "Update the summary above with the information from the excerpt below: PRESERVE everything still relevant, ADD new progress and decisions, MOVE completed items to Done, and UPDATE Next Steps.\n\n"
		: "";
	const lastNote =
		partIndex === partCount && partCount > 1
			? "\nThis is the FINAL part — make sure the summary reflects the most recent state of the work."
			: "";
	const focus = customInstructions
		? `\n\nAdditional focus: ${customInstructions}`
		: "";
	return `${position}${update}${previous}Below is a conversation excerpt inside <conversation-excerpt> tags. Create a comprehensive structured summary of the conversation so far that will replace the conversation history. The summary must contain all information needed to continue the work effectively.\n\n${SUMMARY_FORMAT}${focus}${lastNote}`;
}

// ============================================================================
// Response validation + retry
// ============================================================================

/**
 * Return an error message when a summarizer response cannot be persisted.
 * Mirrors core's getSummarizationFailure: error stops and length stops are both
 * unusable (a length stop contains a partial summary).
 */
export function summarizeFailure(response: AssistantMessage): string | undefined {
	if (response.stopReason === "aborted") return undefined;
	if (response.stopReason === "error") {
		return response.errorMessage || "Unknown provider error";
	}
	if (response.stopReason === "length") {
		return "Summary generation hit the token cap and is incomplete";
	}
	return undefined;
}

function responseText(response: AssistantMessage): string {
	const parts: string[] = [];
	for (const block of response.content) {
		if (block.type === "text") parts.push(block.text);
	}
	return parts.join("\n").trim();
}

/** Sum usage across summarizer calls (local sum; no cross-version dependency). */
export function sumUsage(usages: (Usage | undefined)[]): Usage | undefined {
	const valid = usages.filter((u): u is Usage => u !== undefined);
	if (valid.length === 0) return undefined;
	const out: Usage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	for (const u of valid) {
		out.input += u.input ?? 0;
		out.output += u.output ?? 0;
		out.cacheRead += u.cacheRead ?? 0;
		out.cacheWrite += u.cacheWrite ?? 0;
		out.totalTokens += u.totalTokens ?? 0;
		if (u.cost) {
			out.cost.input += u.cost.input ?? 0;
			out.cost.output += u.cost.output ?? 0;
			out.cost.cacheRead += u.cost.cacheRead ?? 0;
			out.cost.cacheWrite += u.cost.cacheWrite ?? 0;
			out.cost.total += u.cost.total ?? 0;
		}
	}
	return out;
}

interface CallContext {
	deps: { complete: CompleteFn };
	model: SummarizerModel;
	instructions: string;
	maxOutputTokens: number;
	signal?: AbortSignal;
	sessionId?: string;
	apiKey?: string;
	headers?: Record<string, string>;
	env?: Record<string, string>;
}

/**
 * One bounded summarizer call with retries:
 * - overflow error → halve the conversation text and retry (up to MAX_OVERFLOW_HALVINGS)
 * - any other error, or empty text → one plain retry
 * - length stop → rejected (partial summary), counts as a failure
 * Throws SummarizerError when the call still fails, or propagates aborts.
 */
async function callSummarizer(
	ctx: CallContext,
	conversationText: string,
): Promise<{ text: string; usage: Usage | undefined }> {
	// The excerpt is the halvable part of the request; instructions stay intact.
	let text = conversationText;
	let halvings = 0;
	let plainRetryUsed = false;
	for (;;) {
		ctx.signal?.throwIfAborted();
		const userMessage = `${ctx.instructions}\n\n<conversation-excerpt>\n${text}\n</conversation-excerpt>`;
		const messages: Message[] = [
			{ role: "user", content: [{ type: "text", text: userMessage }], timestamp: Date.now() },
		];
		const context: Context = {
			systemPrompt: SUMMARIZER_SYSTEM_PROMPT,
			messages,
		};
		const response = await ctx.deps.complete(ctx.model, context, {
			maxTokens: ctx.maxOutputTokens,
			signal: ctx.signal,
			cacheRetention: "none",
			sessionId: ctx.sessionId,
			apiKey: ctx.apiKey,
			headers: ctx.headers,
			env: ctx.env,
		});
		if (response.stopReason === "aborted" || ctx.signal?.aborted) {
			ctx.signal?.throwIfAborted();
			throw new SummarizerError("Summarization aborted");
		}
		const failure = summarizeFailure(response);
		const output = failure ? "" : responseText(response);
		if (!failure && output) {
			return { text: output, usage: response.usage };
		}
		const reason = failure || "Summarizer returned an empty response";
		if (isContextOverflow(response)) {
			halvings += 1;
			if (halvings > MAX_OVERFLOW_HALVINGS || text.length <= MIN_HALVED_CHARS) {
				throw new SummarizerError(`Context overflow during summarization: ${reason}`);
			}
			const keepChars = Math.floor(text.length / 2);
			text = `[... earlier half of this excerpt truncated to fit the model context window ...]\n${text.slice(-keepChars)}`;
			continue;
		}
		if (!plainRetryUsed) {
			plainRetryUsed = true;
			continue;
		}
		throw new SummarizerError(reason);
	}
}

// ============================================================================
// Deterministic summary sections
// ============================================================================

function formatList(entries: string[], label: string): string {
	if (entries.length === 0) return "";
	const shown = entries.slice(0, MAX_FILE_ENTRIES);
	const extra =
		entries.length > MAX_FILE_ENTRIES
			? `\n- ... and ${entries.length - MAX_FILE_ENTRIES} more`
			: "";
	return `\n## ${label}\n${shown.map((f) => `- ${f}`).join("\n")}${extra}\n`;
}

/**
 * Structured sections appended deterministically to the final summary (both LLM
 * and fallback paths) so todos/plan/files survive even if the model drops them.
 */
export function formatStructuredSections(structured: SummarizerStructured): string {
	let out = "";
	const todos = structured.todos ?? [];
	if (todos.length > 0) {
		out += `\n## Active Todo Items\n${todos
			.map((t) => `${t.step}. ${t.completed ? "✓" : "☐"} ${t.text}`)
			.join("\n")}\n`;
	}
	const plan = structured.planSteps ?? [];
	if (plan.length > 0) {
		out += `\n## Plan Steps\n${plan.join("\n")}\n`;
	}
	out += formatList(structured.readFiles ?? [], "Files Read");
	out += formatList(structured.modifiedFiles ?? [], "Files Modified");
	return out;
}

// ============================================================================
// Fallback summary
// ============================================================================

/**
 * Deterministic no-LLM summary used when summarization fails entirely.
 * Preserves continuation state: previous summary, todos/plan, file lists, and
 * the most recent user messages. Always succeeds — this is what un-bricks a
 * session whose context is already over the model's limit.
 */
export function buildFallbackSummary(
	input: Pick<SummarizeInput, "messages" | "previousSummary" | "structured">,
	reason: string,
	recentLimit = FALLBACK_RECENT_MESSAGES,
): string {
	const userMessages: string[] = [];
	for (const m of input.messages) {
		if (m.role !== "user") continue;
		const text = contentText(m.content, "").trim();
		if (text.length > 0) userMessages.push(text);
	}
	const goal = userMessages[0]
		? truncateWithMarker(userMessages[0], 500)
		: "(see previous summary)";
	const recent = userMessages.slice(-recentLimit).map((text, i, arr) => {
		const idx = arr.length - recentLimit + i + 1;
		return `${idx}. ${truncateWithMarker(text, FALLBACK_MESSAGE_CHARS)}`;
	});

	let out = `## Goal\n${goal}\n`;
	out += `\n## Compaction Notice\nAutomatic fallback summary generated by autocompact on ${new Date().toISOString()}: LLM summarization failed (${reason}). The older conversation could not be summarized and is truncated; only the state below is preserved. Reconstruct detail as needed from the file lists and recent messages.\n`;
	if (input.previousSummary?.trim()) {
		out += `\n## Previous Summary\n${input.previousSummary.trim()}\n`;
	}
	if (recent.length > 0) {
		out += `\n## Recent User Messages\n${recent.join("\n")}\n`;
	}
	out += formatStructuredSections(input.structured);
	return out.trim();
}

// ============================================================================
// Entry point
// ============================================================================

/**
 * Summarize `input.messages` within the model's window, falling back to a
 * deterministic summary when the LLM path fails. Only aborts propagate — every
 * other failure produces a usable summary.
 */
export async function summarizeWithFallback(
	deps: { complete: CompleteFn },
	input: SummarizeInput,
): Promise<SummarizeResult> {
	const budget = computeBudget(input.model, input.reserveTokens);
	const maxMessageChars = Math.max(MIN_HALVED_CHARS, budget.maxChunkChars);
	const parts = serializeToParts(input.messages, maxMessageChars);
	const structuredText = formatStructuredSections(input.structured);
	const sessionId = input.sessionId;
	const callCtx: Omit<CallContext, "instructions"> = {
		deps,
		model: input.model,
		maxOutputTokens: budget.maxOutputTokens,
		sessionId,
		apiKey: input.apiKey,
		headers: input.headers,
		env: input.env,
	};

	const tryLlm = async (): Promise<
		{ summary: string; strategy: SummarizeStrategy; folds?: number; usage?: Usage } | SummarizerError
	> => {
		try {
			let chunks = packChunks(parts, budget.maxChunkChars);
			if (chunks.length === 0) {
				throw new SummarizerError("No serializable conversation content");
			}
			const maxChunks = input.maxChunks && input.maxChunks >= 1 ? input.maxChunks : 8;
			const trimmed = trimChunksToCap(chunks, maxChunks);
			const usedDigest = trimmed.length < chunks.length;
			chunks = trimmed;

			let summarySoFar = input.previousSummary?.trim() || undefined;
			let usage: Usage | undefined;
			for (let i = 0; i < chunks.length; i += 1) {
				const instructions = buildFoldInstructions({
					summarySoFar,
					partIndex: i + 1,
					partCount: chunks.length,
					customInstructions: input.customInstructions,
				});
				// The chunk is the halvable excerpt; overflow retries shrink it.
				const result = await callSummarizer({ ...callCtx, instructions }, chunks[i]);
				summarySoFar = result.text;
				usage = sumUsage([usage, result.usage]);
			}
			if (!summarySoFar) {
				throw new SummarizerError("Summarizer produced an empty summary");
			}
			// Note digest trimming in the summary so degradation is visible.
			const finalText = usedDigest
				? `${summarySoFar}\n\n(autocompact: the conversation exceeded the summarizer window; some middle parts were omitted.)`
				: summarySoFar;
			return {
				summary: finalText,
				strategy: chunks.length > 1 ? "fold" : "single",
				folds: chunks.length,
				usage,
			};
		} catch (error) {
			if (error instanceof SummarizerError) return error;
			throw error;
		}
	};

	const llmOutcome = await tryLlm();
	if (!(llmOutcome instanceof SummarizerError)) {
		return {
			...llmOutcome,
			summary: `${llmOutcome.summary}${structuredText}`,
		};
	}

	// LLM path failed entirely — deterministic fallback keeps the session usable.
	const fallback = buildFallbackSummary(input, llmOutcome.message);
	return {
		summary: `${fallback}${structuredText}`.trim(),
		strategy: "fallback",
		fallbackReason: llmOutcome.message,
	};
}
