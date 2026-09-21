/**
 * Synthetic (synthetic.new) provider + model catalog for pi.
 *
 * Generated per pi's official docs:
 *   - docs/custom-provider.md  -> `pi.registerProvider(name, ProviderConfig)`
 *   - docs/models.md           -> model fields, `compat`, `thinkingLevelMap`, cost
 *
 * Endpoint: https://api.synthetic.new/openai/v1  (OpenAI Chat Completions)
 * Provider id: `synthetic` (matches the entry in ~/.pi/agent/auth.json)
 *
 * Loading: this is an *extension module*, not `models.json`. Pi only auto-loads
 * `.ts` files from `~/.pi/agent/extensions/` (one level deep). This file lives in
 * the agent root, so it is registered explicitly via `extensions` in
 * ~/.pi/agent/settings.json.
 *
 * Auth: the API key lives in ~/.pi/agent/auth.json under "synthetic"
 * ({"type":"api_key","key":"…"}). Stored credentials win over the
 * `SYNTHETIC_API_KEY` env var, which is only a fallback when nothing is stored;
 * the live /models refresh resolves the key through the same auth resolution
 * pi uses for chat requests (provider-composer: stored credential -> config
 * value -> env interpolation).
 *
 * Catalog snapshot: 2026-09-21, from an authenticated
 * GET https://api.synthetic.new/openai/v1/models (rows with `always_on: true`).
 * `session_start` refreshes the list live; the static table below is the offline
 * fallback.
 */

import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// Endpoint / auth
// ---------------------------------------------------------------------------

export const SYNTHETIC_PROVIDER_ID = "synthetic";
export const SYNTHETIC_API_BASE_URL = "https://api.synthetic.new/openai/v1";
export const SYNTHETIC_MODELS_ENDPOINT = `${SYNTHETIC_API_BASE_URL}/models`;
export const SYNTHETIC_MODELS_TIMEOUT_MS = 3000;

/**
 * Shared compatibility flags for Synthetic's OpenAI-compatible endpoint.
 * See docs/models.md -> "OpenAI Compatibility".
 */
export const SYNTHETIC_COMPAT = {
	// Synthetic accepts a plain `system` message, not OpenAI's `developer` role.
	supportsDeveloperRole: false,
	// Synthetic does not implement strict JSON-schema tool defs.
	supportsStrictMode: false,
	// No `stream_options.include_usage`; usage arrives out-of-band.
	supportsUsageInStreaming: false,
	// No `store` field.
	supportsStore: false,
	maxTokensField: "max_tokens",
	requiresToolResultName: true,
} as const;

// ---------------------------------------------------------------------------
// Thinking levels
// ---------------------------------------------------------------------------

/** Pi thinking levels (docs/models.md -> "Thinking Level Map"). */
type ThinkingLevel = keyof NonNullable<ProviderModelConfig["thinkingLevelMap"]>;

/**
 * Synthetic advertises `reasoning_parameters.efforts`. Unknown/unsupported
 * levels must be marked `null` so the selector never sends a value the route
 * rejects (a rejected `reasoning_effort` fails the whole request).
 */
const EFFORT_TO_LEVEL: Record<string, ThinkingLevel> = {
	none: "off",
	off: "off",
	minimal: "minimal",
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: "xhigh",
	max: "max",
};

export function buildThinkingLevelMap(efforts: readonly string[]): ProviderModelConfig["thinkingLevelMap"] {
	const map: NonNullable<ProviderModelConfig["thinkingLevelMap"]> = {
		off: null,
		minimal: null,
		low: null,
		medium: null,
		high: null,
		xhigh: null,
		max: null,
	};

	let supported = false;
	for (const effort of efforts) {
		const level = EFFORT_TO_LEVEL[effort.trim().toLowerCase()];
		if (!level) continue;
		// Level is supported; the raw effort string is sent to the provider.
		map[level] = effort;
		supported = true;
	}

	return supported ? map : undefined;
}

/** Reasoning models get `supportsReasoningEffort`; non-reasoning models do not. */
function reasoningCompat(efforts?: readonly string[]) {
	if (!efforts || efforts.length === 0) return { ...SYNTHETIC_COMPAT };
	const map = buildThinkingLevelMap(efforts);
	if (!map) return { ...SYNTHETIC_COMPAT };
	return { ...SYNTHETIC_COMPAT, supportsReasoningEffort: true };
}

// ---------------------------------------------------------------------------
// Pricing
// ---------------------------------------------------------------------------

/**
 * Synthetic returns per-token price strings (e.g. "$0.0000006").
 * Pi's `cost` is $/million tokens (docs/models.md -> Model Configuration).
 */
export function parsePrice(value: string | undefined): number {
	if (!value) return 0;
	const parsed = Number.parseFloat(value.replace(/[^0-9.eE+-]/g, ""));
	return Number.isFinite(parsed) ? parsed * 1_000_000 : 0;
}

// ---------------------------------------------------------------------------
// Static catalog (offline fallback)
// ---------------------------------------------------------------------------

interface CatalogEntry {
	id: string;
	name: string;
	/** Synthetic `input_modalities` includes image. */
	vision: boolean;
	contextWindow: number;
	maxTokens: number;
	/** Advertised `reasoning_parameters.efforts`; omitted => no reasoning. */
	efforts?: readonly string[];
	/** Synthetic `pricing` per-token strings. */
	pricing: {
		prompt: string;
		completion: string;
		input_cache_reads: string;
		input_cache_writes?: string;
	};
}

/** `syn:*` ids are permalinks Synthetic re-points as models rotate. */
const CATALOG: readonly CatalogEntry[] = [
	{
		id: "syn:large:text",
		name: "syn:large:text",
		vision: true,
		contextWindow: 524288,
		maxTokens: 65536,
		efforts: ["none", "low", "high", "xhigh", "max"],
		pricing: { prompt: "$0.0000006", completion: "$0.0000012", input_cache_reads: "$0.00000003" },
	},
	{
		id: "syn:small:text",
		name: "syn:small:text",
		vision: false,
		contextWindow: 196608,
		maxTokens: 65536,
		efforts: ["none", "low", "medium", "high"],
		pricing: { prompt: "$0.0000001", completion: "$0.0000005", input_cache_reads: "$0.00000002" },
	},
	{
		id: "syn:large:vision",
		name: "syn:large:vision",
		vision: true,
		contextWindow: 524288,
		maxTokens: 65536,
		efforts: ["low", "high", "max"],
		pricing: { prompt: "$0.000003", completion: "$0.000015", input_cache_reads: "$0.00000045" },
	},
	{
		id: "syn:small:vision",
		name: "syn:small:vision",
		vision: true,
		contextWindow: 262144,
		maxTokens: 65536,
		efforts: ["low", "medium", "xhigh"],
		pricing: { prompt: "$0.00000045", completion: "$0.0000022", input_cache_reads: "$0.00000009" },
	},
	{
		id: "hf:deepseek-ai/DeepSeek-V4.1-Flash",
		name: "deepseek-ai/DeepSeek-V4.1-Flash",
		vision: true,
		contextWindow: 524288,
		maxTokens: 65536,
		efforts: ["none", "low", "high", "xhigh", "max"],
		pricing: { prompt: "$0.0000006", completion: "$0.0000012", input_cache_reads: "$0.00000003" },
	},
	{
		id: "hf:moonshotai/Kimi-K3",
		name: "moonshotai/Kimi-K3",
		vision: true,
		contextWindow: 524288,
		maxTokens: 65536,
		efforts: ["low", "high", "max"],
		pricing: { prompt: "$0.000003", completion: "$0.000015", input_cache_reads: "$0.00000045" },
	},
	{
		id: "hf:zai-org/GLM-5.3-Flash",
		name: "zai-org/GLM-5.3-Flash",
		vision: true,
		contextWindow: 524288,
		maxTokens: 65536,
		efforts: ["low", "high", "max"],
		pricing: { prompt: "$0.00000015", completion: "$0.0000005", input_cache_reads: "$0.00000004" },
	},
	{
		id: "hf:Qwen/Qwen3.8-27B",
		name: "Qwen/Qwen3.8-27B",
		vision: true,
		contextWindow: 262144,
		maxTokens: 65536,
		efforts: ["low", "medium", "xhigh"],
		pricing: { prompt: "$0.00000045", completion: "$0.0000022", input_cache_reads: "$0.00000009" },
	},
	{
		id: "hf:nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-NVFP4",
		name: "nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-NVFP4",
		vision: false,
		contextWindow: 262144,
		maxTokens: 65536,
		efforts: ["none", "low", "medium", "high"],
		pricing: { prompt: "$0.0000003", completion: "$0.000001", input_cache_reads: "$0.00000006" },
	},
	{
		id: "hf:openai/gpt-oss-120b",
		name: "openai/gpt-oss-120b",
		vision: false,
		contextWindow: 131072,
		maxTokens: 65536,
		efforts: ["none", "low", "medium", "high"],
		pricing: { prompt: "$0.0000001", completion: "$0.0000001", input_cache_reads: "$0.00000002" },
	},
	{
		id: "hf:zai-org/GLM-4.7-Flash",
		name: "zai-org/GLM-4.7-Flash",
		vision: false,
		contextWindow: 196608,
		maxTokens: 65536,
		efforts: ["none", "low", "medium", "high"],
		pricing: { prompt: "$0.0000001", completion: "$0.0000005", input_cache_reads: "$0.00000002" },
	},
];

function toModelConfig(entry: CatalogEntry): ProviderModelConfig {
	const efforts = entry.efforts ?? [];
	const reasoning = efforts.length > 0;
	return {
		id: entry.id,
		name: entry.name,
		reasoning,
		thinkingLevelMap: reasoning ? buildThinkingLevelMap(efforts) : undefined,
		input: entry.vision ? ["text", "image"] : ["text"],
		cost: {
			input: parsePrice(entry.pricing.prompt),
			output: parsePrice(entry.pricing.completion),
			cacheRead: parsePrice(entry.pricing.input_cache_reads),
			cacheWrite: parsePrice(entry.pricing.input_cache_writes ?? "0"),
		},
		contextWindow: entry.contextWindow,
		maxTokens: entry.maxTokens,
		compat: reasoningCompat(efforts),
	};
}

/** Offline fallback / initial registration: the pinned snapshot above. */
export function getStaticModels(): ProviderModelConfig[] {
	return CATALOG.map(toModelConfig);
}

// ---------------------------------------------------------------------------
// Live refresh
// ---------------------------------------------------------------------------

interface SyntheticApiModel {
	id: string;
	name?: string;
	always_on?: boolean;
	supported_features?: string[] | null;
	input_modalities?: string[] | null;
	context_length?: number;
	max_output_length?: number;
	reasoning_parameters?: { efforts?: string[] } | null;
	pricing?: Record<string, string> | null;
}

async function fetchSyntheticModels(apiKey?: string): Promise<ProviderModelConfig[] | undefined> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), SYNTHETIC_MODELS_TIMEOUT_MS);
	try {
		const headers: Record<string, string> = { Accept: "application/json" };
		if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

		const response = await fetch(SYNTHETIC_MODELS_ENDPOINT, { headers, signal: controller.signal });
		if (!response.ok) return undefined;

		const payload = (await response.json()) as { data?: SyntheticApiModel[] };
		return (payload.data ?? [])
			.filter((m) => m.always_on && (!m.supported_features || m.supported_features.includes("tools")))
			.map((m) => {
				const efforts = m.reasoning_parameters?.efforts;
				return toModelConfig({
					id: m.id,
					name: m.name ?? m.id,
					vision: (m.input_modalities ?? []).includes("image"),
					contextWindow: m.context_length ?? 128000,
					maxTokens: m.max_output_length ?? 65536,
					efforts: efforts && efforts.length > 0 ? efforts : undefined,
					pricing: {
						prompt: m.pricing?.prompt ?? "0",
						completion: m.pricing?.completion ?? "0",
						input_cache_reads: m.pricing?.input_cache_reads ?? "0",
						input_cache_writes: m.pricing?.input_cache_writes ?? "0",
					},
				});
			});
	} catch {
		// Network/timeout/parse failure -> keep the static catalog.
		return undefined;
	} finally {
		clearTimeout(timer);
	}
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

/**
 * Config-level key is a fallback only: used when auth.json has no
 * "synthetic" entry. A stored credential always wins over this value.
 */
export function providerConfig(models: ProviderModelConfig[]) {
	return {
		baseUrl: SYNTHETIC_API_BASE_URL,
		apiKey: "$SYNTHETIC_API_KEY",
		api: "openai-completions" as const,
		models,
	};
}

export default function (pi: ExtensionAPI) {
	// Register during load so the provider is available to `/model`,
	// `pi --list-models`, and interactive startup.
	pi.registerProvider(SYNTHETIC_PROVIDER_ID, providerConfig(getStaticModels()));

	// Refresh the catalog after the session starts (best-effort; falls back to
	// the static snapshot on any failure). The key resolves the same way chat
	// requests do: stored auth.json credential first, env var fallback second.
	pi.on("session_start", async (_event, ctx) => {
		let apiKey = process.env.SYNTHETIC_API_KEY;
		try {
			const auth = await ctx.modelRegistry.getProviderAuth(SYNTHETIC_PROVIDER_ID);
			apiKey = auth?.auth?.apiKey || apiKey;
		} catch {
			// Unconfigured provider / resolution failure -> env fallback only.
		}
		const live = await fetchSyntheticModels(apiKey);
		if (live && live.length > 0) {
			pi.registerProvider(SYNTHETIC_PROVIDER_ID, providerConfig(live));
		}
	});
}
