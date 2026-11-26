/**
 * Workflow Extension — shared in-process child session factory.
 *
 * Review Mode and Orchestrator both need a second SDK `AgentSession` inside the
 * SAME Pi process: its own model runtime, its own in-memory session, an explicit
 * global tool allowlist, and (optionally) the Workflow extension loaded so the
 * child receives the normal Build policy gates.
 *
 * This module owns only the creation/teardown mechanics. It never imports the Pi
 * SDK at module scope, never throws, and never writes a session file. The caller
 * supplies the system prompt, the tool allowlist, the resource-loader isolation
 * mode, the session bootstrap and an optional provider-auth preflight.
 *
 * Why the tool allowlist is load-bearing: Pi's `createAgentSession({ tools })`
 * is a GLOBAL allowlist applied to built-in AND custom tools alike. A list that
 * omits a custom tool silently removes it from the child's registry.
 */

import { randomUUID } from "node:crypto";
import type { ProviderSeedResult } from "./review-providers.ts";
import { seedChildRuntimeProviders } from "./review-providers.ts";
import {
  childModelLabel,
  type ChildContextUsage,
  type ChildModelRef,
  type ChildRuntimeStats,
  type ChildTokenTotals,
} from "./child-stats.ts";

/**
 * Structural handle on the Pi SDK. Erased at compile time so importing this
 * module in a plain Node test does not load Pi.
 */
export interface InProcessChildSdk {
  ModelRuntime: { create: () => Promise<unknown> };
  DefaultResourceLoader: new (options: Record<string, unknown>) => {
    reload?: () => Promise<void>;
  };
  SessionManager: {
    inMemory: (...args: unknown[]) => unknown;
  };
  SettingsManager?: {
    create?: (...args: unknown[]) => unknown;
  };
  createAgentSession: (options: Record<string, unknown>) => Promise<{
    session?: unknown;
    extensionsResult?: unknown;
    modelFallbackMessage?: string;
  }>;
}

export type InProcessChildSdkLoader = () => Promise<unknown>;
export type PiCodingAgentSdk = InProcessChildSdk;
export type ReviewSdkLoader = InProcessChildSdkLoader;

/**
 * A live child session, narrowed to what the parent orchestration needs.
 * Deliberately keeps the rest of the extension free of SDK types.
 *
 * `currentModel`, `stats` and `setModel` are OPTIONAL: they are implemented over
 * public `AgentSession` APIs and feature-detected at call time, so an older SDK
 * (or a test double) still satisfies the handle. Callers must treat `undefined`
 * as "this session cannot report/switch" rather than as a failure.
 */
export interface InProcessChildSession {
  readonly sessionId: string;
  /** The model this session is actually running (launch label as fallback). */
  readonly modelLabel: string;
  /** Subscribe to the session's event stream. Returns an unsubscribe function. */
  subscribe(listener: (event: unknown) => void): () => void;
  /** Send a prompt. Queues as a steer when the session is already streaming. */
  prompt(text: string): Promise<void>;
  /** Send a prompt that is delivered only after the current run stops. */
  followUp(text: string): Promise<void>;
  /** Cancel the in-flight run. Never throws. */
  abort(): Promise<void>;
  isStreaming(): boolean;
  /** Unsubscribe and release. Never throws, safe to call twice. */
  dispose(): void;
  /** The model/thinking the session is running right now. */
  currentModel?(): ChildModelRef | undefined;
  /** Current context usage and cumulative tokens, when the SDK reports them. */
  stats?(): ChildRuntimeStats | undefined;
  /**
   * Switch the live session's model (and thinking) WITHOUT aborting it.
   * Auth happens inside the session's own runtime; a model already resolved
   * by the parent may be supplied to avoid a child-registry miss. Without it,
   * resolution still happens inside the session's own runtime.
   * Never throws: a refusal is a `{ ok: false, error }` result.
   */
  setModel?(
    provider: string,
    id: string,
    thinking?: string,
    preResolvedModel?: unknown,
  ): Promise<SwitchChildModelResult>;
}

export type SwitchChildModelResult =
  | { ok: true; model: ChildModelRef }
  | { ok: false; error: string };

export interface InProcessChildAuthInput {
  modelRuntime: unknown;
  providerSeed: ProviderSeedResult;
  modelLabel: string;
  provider: string;
}

export type InProcessChildAuthCheck = (
  input: InProcessChildAuthInput,
) => Promise<{ ok: true } | { ok: false; error: string }>;

export interface CreateInProcessChildSessionOptions {
  cwd: string;
  /** Global Pi config dir (usually ~/.pi/agent). */
  agentDir: string;
  modelRef: { provider: string; id: string; thinking?: string };
  /** Resolve a model from the parent's registry by provider/id. */
  findModel: (provider: string, id: string) => unknown;
  /** Parent-side provider-registration surface (structural, feature-detected). */
  parentProviders?: unknown;
  /** SDK retries per child model (0-2), applied through a runtime-only override. */
  providerRetries?: number;
  /**
   * Create the child's SettingsManager in memory instead of loading the shared
   * settings files. An isolated session must set this so ambient settings can
   * never leak into the child. Default: file-backed with runtime-only overrides
   * (legacy behaviour kept for the Orchestrator Build child).
   */
  inMemorySettings?: boolean;
  /** Initial settings for an in-memory SettingsManager. */
  settings?: Record<string, unknown>;
  /** Skip ambient AGENTS.md/CLAUDE.md context files. */
  noContextFiles?: boolean;
  /**
   * Assert that the child's active tool set is EXACTLY `tools` — no missing and
   * no unexpected tool, and an SDK that cannot report its set fails too. Only
   * exact names are accepted; patterns/modifiers are refused before creation.
   */
  exactTools?: boolean;
  /**
   * Fail when the SDK reports `modelFallbackMessage` or resolves a different
   * model than requested. Isolated sessions use this so a model is never
   * substituted silently.
   */
  rejectModelFallback?: boolean;

  /** Override the loader's system prompt. Omit to keep Pi's default prompt. */
  systemPrompt?: string;
  appendSystemPrompt?: string[];

  /**
   * When true, load no ambient extensions. Review Mode uses this.
   * When false/omitted, `additionalExtensionPaths` are loaded in addition to the
   * normal user extension set unless `noExtensions` is true.
   */
  noExtensions?: boolean;
  /** Extra extension files/packages loaded even with `noExtensions: true`. */
  additionalExtensionPaths?: string[];
  noSkills?: boolean;
  noPromptTemplates?: boolean;
  noThemes?: boolean;

  /** Exact global tool allowlist (built-in + custom names). */
  tools: string[];
  customTools?: unknown[];
  /** Names that MUST be active after creation; a missing one fails the child. */
  requiredTools?: string[];

  /**
   * Build the session manager AFTER the SDK is loaded. The caller can append
   * bootstrap custom entries here (Orchestrator's child marker).
   */
  sessionManager: (sdk: InProcessChildSdk, sessionId: string) => unknown;
  /** Explicit session id. Omit to generate `<prefix>-<time>-<random>`. */
  sessionId?: string;
  sessionIdPrefix?: string;

  /** Env marker set only for the duration of `createAgentSession`. */
  markerEnv?: string;
  /** Bind the child's extension UI to this context (e.g. the parent UI bridge). */
  uiContext?: unknown;
  bindMode?: "print" | "rpc" | "json";

  /** Fail-fast provider auth preflight, run after seeding and before creation. */
  authCheck?: InProcessChildAuthCheck;
  /** Optional post-creation validation (extension loaded, marker readable, …). */
  validate?: (created: {
    session: unknown;
    extensionsResult: unknown;
    activeTools: string[] | undefined;
  }) => { ok: true } | { ok: false; error: string };
  /** Custom message for a missing registry model. */
  missingModelError?: (modelLabel: string) => string;
  /** Custom message for missing required tools. */
  describeMissingTools?: (missing: string[], active: string[]) => string;
  /** Custom message for an exact tool-set mismatch (missing/unexpected). */
  describeToolMismatch?: (mismatch: {
    missing: string[];
    unexpected: string[];
  }) => string;

  /**
   * Called after the SDK session is disposed. `AgentSession.dispose()` never
   * emits `session_shutdown`, so the child extension's own cleanup (subagents,
   * timers) must run through this hook.
   */
  onDispose?: () => void;
  /** Injectable for tests; defaults to a real dynamic import. */
  loadSdk?: InProcessChildSdkLoader;
}

export interface CreateInProcessChildSessionResult {
  ok: boolean;
  session?: InProcessChildSession;
  modelLabel: string;
  /** Tool names the child actually has enabled, when the SDK exposes them. */
  activeTools?: string[];
  /** What provider seeding did before the session was created, when probed. */
  providerSeed?: ProviderSeedResult;
  /** Raw SDK extensions result, for callers that validate external surfaces. */
  extensionsResult?: unknown;
  error?: string;
}

/**
 * The difference between the tools a caller requested and the tools the child
 * session actually reports. `unverifiable` is distinct from an empty set: an
 * SDK that exposes no `getActiveToolNames()` cannot prove the set, which an
 * isolated session must treat as a failure rather than assuming success.
 */
export interface ExactToolSetMismatch {
  missing: string[];
  unexpected: string[];
  unverifiable: boolean;
}

/**
 * True when `name` is a plain exact tool name. Pi also accepts wildcard
 * patterns and `+name`/`-name` modifiers; those cannot be asserted as an exact
 * active set, so an isolated session refuses them before creating anything.
 */
export function isExactToolSelectionName(name: unknown): boolean {
  if (typeof name !== "string") return false;
  const trimmed = name.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith("+") || trimmed.startsWith("-")) return false;
  return !trimmed.includes("*");
}

function normalizeToolName(name: unknown): string | undefined {
  if (typeof name !== "string") return undefined;
  const trimmed = name.trim();
  return trimmed ? trimmed : undefined;
}

function normalizedToolNames(names: readonly unknown[] | undefined): string[] {
  const out = new Set<string>();
  for (const name of names ?? []) {
    const normalized = normalizeToolName(name);
    if (normalized) out.add(normalized);
  }
  return [...out].sort();
}

/**
 * Compare the requested allowlist with the child's reported active tools.
 * Pure and total; unknown/junk entries are ignored. `active === undefined`
 * means the SDK could not report the set, so the result is `unverifiable`.
 */
export function compareExactToolSet(
  requested: readonly unknown[] | undefined,
  active: readonly unknown[] | undefined,
): ExactToolSetMismatch {
  const wanted = normalizedToolNames(requested);
  if (active === undefined) {
    return { missing: wanted, unexpected: [], unverifiable: true };
  }
  const activeNames = new Set(normalizedToolNames(active));
  const wantedNames = new Set(wanted);
  return {
    missing: wanted.filter((name) => !activeNames.has(name)),
    unexpected: [...activeNames]
      .filter((name) => !wantedNames.has(name))
      .sort(),
    unverifiable: false,
  };
}

/** One-line, deterministic description of an exact tool-set mismatch. */
export function describeExactToolSetMismatch(
  mismatch: ExactToolSetMismatch,
): string {
  if (mismatch.unverifiable) {
    return "the SDK did not expose getActiveToolNames(), so the child's exact tool set cannot be verified";
  }
  const parts: string[] = [];
  if (mismatch.missing.length > 0) {
    parts.push(`missing: ${mismatch.missing.join(", ")}`);
  }
  if (mismatch.unexpected.length > 0) {
    parts.push(`unexpected: ${mismatch.unexpected.join(", ")}`);
  }
  return parts.join("; ");
}

/**
 * Dispose a raw SDK session exactly once, swallowing every failure. Used when a
 * created child session fails a post-creation bootstrap assertion — leaving it
 * alive would keep listeners, extensions and provider resources in-process.
 */
export function disposeRawSession(raw: unknown): void {
  if (raw === undefined || raw === null) return;
  try {
    const dispose = (raw as { dispose?: unknown }).dispose;
    if (typeof dispose !== "function") return;
    const result = (dispose as (this: unknown) => unknown).call(raw);
    if (result && typeof (result as Promise<unknown>).catch === "function") {
      void (result as Promise<unknown>).catch(() => undefined);
    }
  } catch {
    /* teardown is best-effort */
  }
}

/**
 * Best-effort cleanup for a session that was created but cannot be returned:
 * dispose the SDK session, then run the caller's extension cleanup hook.
 */
function discardCreatedSession(
  raw: unknown,
  onDispose: (() => void) | undefined,
): void {
  disposeRawSession(raw);
  try {
    onDispose?.();
  } catch {
    /* teardown is best-effort */
  }
}

/**
 * No silent model substitution: report the SDK's fallback message or a model
 * that differs from the requested provider/id. Returns undefined when the
 * resolved session model matches (or the session does not expose one).
 */
export function describeModelFallback(
  created: { modelFallbackMessage?: unknown; session?: unknown },
  modelRef: { provider: string; id: string },
): string | undefined {
  if (
    typeof created.modelFallbackMessage === "string" &&
    created.modelFallbackMessage.trim()
  ) {
    return created.modelFallbackMessage.trim();
  }
  try {
    const model = (created.session as {
      model?: { provider?: unknown; id?: unknown; modelId?: unknown };
    })?.model;
    if (!model || typeof model !== "object") return undefined;
    const provider = model.provider;
    const id = model.id ?? model.modelId;
    if (typeof provider !== "string" || typeof id !== "string") {
      return undefined;
    }
    if (provider === modelRef.provider && id === modelRef.id) return undefined;
    return `the session resolved ${provider}/${id} instead of ${modelRef.provider}/${modelRef.id}`;
  } catch {
    return undefined;
  }
}

/**
 * Read the session's enabled tool names, when the SDK exposes them.
 * Returns `undefined` (not `[]`) when the accessor is missing OR throws, so a
 * caller can tell "cannot verify" apart from a verifiably empty tool set.
 */
export function readActiveToolNames(session: unknown): string[] | undefined {
  try {
    const get = (session as { getActiveToolNames?: unknown } | undefined)
      ?.getActiveToolNames;
    if (typeof get !== "function") return undefined;
    const names = (get as () => unknown).call(session);
    if (!Array.isArray(names)) return undefined;
    return names.filter((n): n is string => typeof n === "string");
  } catch {
    return undefined;
  }
}

export function clampProviderRetries(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 1;
  return Math.min(2, Math.max(0, Math.trunc(value)));
}

export interface ChildSettingsOptions {
  /** Build the manager with `SettingsManager.inMemory` (no file I/O). */
  inMemory?: boolean;
  /** Initial settings for the in-memory manager. */
  settings?: Record<string, unknown>;
}

/** Apply the runtime-only retry override to any SettingsManager surface. */
function applyChildRetryOverride(
  manager: unknown,
  providerRetries: number | undefined,
): unknown | undefined {
  if (!manager || typeof manager !== "object") return undefined;
  const surface = manager as {
    getRetrySettings?: () => Record<string, unknown>;
    applyOverrides?: (overrides: unknown) => void;
  };
  if (typeof surface.applyOverrides !== "function") return manager;
  const base =
    typeof surface.getRetrySettings === "function"
      ? surface.getRetrySettings()
      : {
          enabled: true,
          maxRetries: 3,
          baseDelayMs: 2_000,
          maxAgentDelayMs: 60_000,
        };
  surface.applyOverrides({
    retry: {
      ...base,
      enabled: true,
      maxRetries: clampProviderRetries(providerRetries),
    },
  });
  return manager;
}

/**
 * Build the child's runtime-only SettingsManager so its SDK retry budget is
 * bounded. `applyOverrides` is in-memory either way: the shared settings.json
 * is never written.
 *
 * `options.inMemory` selects a manager that never reads the user's settings
 * files at all (the isolated-session default). The file-backed mode remains for
 * the Orchestrator Build child, which deliberately inherits the user's normal
 * settings. Feature-detected for older Pi runtimes; a failure here means the
 * child keeps default settings and the chain simply waits that budget out.
 */
export function createChildSettingsManager(
  sdk: unknown,
  cwd: string,
  agentDir: string,
  providerRetries: number | undefined,
  options: ChildSettingsOptions = {},
): unknown | undefined {
  try {
    const holder = sdk as {
      SettingsManager?: {
        create?: (...args: unknown[]) => unknown;
        inMemory?: (...args: unknown[]) => unknown;
      };
    };
    const SettingsManager = holder?.SettingsManager;
    if (!SettingsManager) return undefined;
    if (options.inMemory === true) {
      const inMemory = SettingsManager.inMemory;
      if (typeof inMemory !== "function") return undefined;
      const manager = inMemory.call(SettingsManager, options.settings ?? {});
      return applyChildRetryOverride(manager, providerRetries);
    }
    const create = SettingsManager.create;
    if (typeof create !== "function") return undefined;
    const manager = create.call(SettingsManager, cwd, agentDir);
    return applyChildRetryOverride(manager, providerRetries);
  } catch {
    return undefined;
  }
}

function asSdk(raw: unknown): InProcessChildSdk {
  return raw as InProcessChildSdk;
}

/** The raw `AgentSession` surface this wrapper feature-detects. */
interface RawChildSession {
  subscribe: (l: (e: unknown) => void) => () => void;
  prompt: (
    t: string,
    o?: { streamingBehavior?: "steer" | "followUp" },
  ) => Promise<void>;
  followUp: (t: string) => Promise<void>;
  abort: () => Promise<void>;
  isStreaming: boolean;
  dispose?: () => void | Promise<void>;
  model?: {
    provider?: unknown;
    id?: unknown;
    modelId?: unknown;
    thinking?: unknown;
  };
  thinkingLevel?: unknown;
  getSessionStats?: () => unknown;
  getContextUsage?: () => unknown;
  modelRuntime?: { getModel?: (provider: string, id: string) => unknown };
  setModel?: (
    model: unknown,
    options?: { persist?: boolean },
  ) => Promise<void> | void;
  setThinkingLevel?: (level: string, options?: { persist?: boolean }) => void;
}

/** The model the raw session is running, or undefined when not exposed. */
function readRawChildModel(s: RawChildSession): ChildModelRef | undefined {
  try {
    const raw = s.model;
    if (!raw || typeof raw !== "object") return undefined;
    const provider = raw.provider;
    const id = raw.id ?? raw.modelId;
    if (typeof provider !== "string" || provider.length === 0) return undefined;
    if (typeof id !== "string" || id.length === 0) return undefined;
    const thinking =
      typeof raw.thinking === "string"
        ? raw.thinking
        : typeof s.thinkingLevel === "string"
          ? s.thinkingLevel
          : undefined;
    return { provider, id, ...(thinking ? { thinking } : {}) };
  } catch {
    return undefined;
  }
}

/** Current context usage, when the SDK exposes it. */
function readRawChildContext(
  s: RawChildSession,
): ChildContextUsage | undefined {
  try {
    const usage = s.getContextUsage?.();
    if (!usage || typeof usage !== "object") return undefined;
    const record = usage as Record<string, unknown>;
    const contextWindow =
      typeof record.contextWindow === "number" &&
      Number.isFinite(record.contextWindow)
        ? record.contextWindow
        : 0;
    const tokens =
      typeof record.tokens === "number" && Number.isFinite(record.tokens)
        ? record.tokens
        : null;
    const percent =
      typeof record.percent === "number" && Number.isFinite(record.percent)
        ? record.percent
        : null;
    if (contextWindow <= 0 && tokens === null) return undefined;
    return { tokens, contextWindow, percent };
  } catch {
    return undefined;
  }
}

/** Cumulative token totals, when the SDK exposes session stats. */
function readRawChildTokens(
  s: RawChildSession,
): ChildTokenTotals | undefined {
  try {
    const stats = s.getSessionStats?.();
    if (!stats || typeof stats !== "object") return undefined;
    const tokens = (stats as { tokens?: unknown }).tokens;
    if (!tokens || typeof tokens !== "object") return undefined;
    const record = tokens as Record<string, unknown>;
    const num = (value: unknown): number =>
      typeof value === "number" && Number.isFinite(value) && value >= 0
        ? value
        : 0;
    return {
      input: num(record.input),
      output: num(record.output),
      cacheRead: num(record.cacheRead),
      cacheWrite: num(record.cacheWrite),
      total: num(record.total),
    };
  } catch {
    return undefined;
  }
}

/**
 * Switch the raw session's model without aborting it. A pre-resolved model
 * from the parent registry is used first; otherwise resolution (like auth)
 * happens inside the session's own runtime, the path Pi's `/model` uses.
 */
async function switchRawChildModel(
  s: RawChildSession,
  provider: string,
  id: string,
  thinking: string | undefined,
  preResolvedModel?: unknown,
): Promise<SwitchChildModelResult> {
  if (typeof s.setModel !== "function") {
    return {
      ok: false,
      error: "this session cannot switch models (unsupported SDK)",
    };
  }
  let resolved: unknown = preResolvedModel;
  if (!resolved) {
    try {
      resolved = s.modelRuntime?.getModel?.(provider, id);
    } catch {
      resolved = undefined;
    }
  }
  if (!resolved) {
    return {
      ok: false,
      error: `${provider}/${id} is not available in the child's model registry`,
    };
  }
  try {
    // NEVER persist: the child's switch must not rewrite the user's default.
    await s.setModel(resolved, { persist: false });
  } catch (error: unknown) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  if (thinking && typeof s.setThinkingLevel === "function") {
    try {
      s.setThinkingLevel(thinking, { persist: false });
    } catch {
      /* a thinking refusal must not undo an applied model switch */
    }
  }
  return {
    ok: true,
    model: mergeRequestedThinking(readRawChildModel(s), provider, id, thinking),
  };
}

/**
 * Report what the session runs, but never silently drop a thinking level we
 * deliberately applied when the session does not echo one back.
 */
function mergeRequestedThinking(
  actual: ChildModelRef | undefined,
  provider: string,
  id: string,
  thinking: string | undefined,
): ChildModelRef {
  if (!actual) {
    return { provider, id, ...(thinking ? { thinking } : {}) };
  }
  return thinking && !actual.thinking
    ? { ...actual, thinking }
    : { ...actual };
}

/**
 * Wrap a raw AgentSession in the narrow child handle. `dispose` is idempotent
 * and never throws; a disposed session ignores later prompts.
 */
export function wrapAgentSession(
  raw: unknown,
  modelLabel: string,
  sessionId: string,
  onDispose?: () => void,
): InProcessChildSession {
  const s = raw as RawChildSession;
  let disposed = false;
  const unsubscribers: Array<() => void> = [];
  return {
    sessionId,
    // The model the session actually runs, not just what was requested.
    get modelLabel() {
      return childModelLabel(readRawChildModel(s), modelLabel);
    },
    subscribe(listener) {
      const un = s.subscribe(listener);
      if (disposed) {
        try {
          un();
        } catch {
          /* ignore */
        }
        return () => {};
      }
      unsubscribers.push(un);
      return un;
    },
    async prompt(text) {
      if (disposed) return;
      if (s.isStreaming) await s.prompt(text, { streamingBehavior: "steer" });
      else await s.prompt(text);
    },
    async followUp(text) {
      if (disposed) return;
      await s.followUp(text);
    },
    async abort() {
      try {
        await s.abort();
      } catch {
        /* aborted sessions can throw; cancellation is best-effort */
      }
    },
    isStreaming() {
      return !disposed && Boolean(s.isStreaming);
    },
    currentModel() {
      return disposed ? undefined : readRawChildModel(s);
    },
    stats(): ChildRuntimeStats | undefined {
      if (disposed) return undefined;
      const model = readRawChildModel(s);
      const context = readRawChildContext(s);
      const tokens = readRawChildTokens(s);
      if (!model && !context && !tokens) return undefined;
      return {
        ...(model ? { model } : {}),
        ...(model?.thinking ? { thinking: model.thinking } : {}),
        ...(tokens ? { tokens } : {}),
        ...(context ? { context } : {}),
      };
    },
    async setModel(
      provider: string,
      id: string,
      thinking?: string,
      preResolvedModel?: unknown,
    ) {
      if (disposed) {
        return { ok: false, error: "the child session is disposed" };
      }
      return switchRawChildModel(s, provider, id, thinking, preResolvedModel);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const un of unsubscribers.splice(0)) {
        try {
          un();
        } catch {
          /* ignore */
        }
      }
      // Release the SDK session when it exposes a disposer. Older SDKs may not;
      // aborting is still the caller's responsibility for an in-flight turn.
      try {
        const result = s.dispose?.();
        if (result && typeof (result as Promise<unknown>).catch === "function") {
          void (result as Promise<unknown>).catch(() => undefined);
        }
      } catch {
        /* ignore */
      }
      try {
        onDispose?.();
      } catch {
        /* teardown is best-effort */
      }
    },
  };
}

/**
 * Create one in-process child session. Never throws: every failure is returned
 * as `{ ok: false, error }` with the model label so the caller can degrade.
 */
export async function createInProcessChildSession(
  options: CreateInProcessChildSessionOptions,
): Promise<CreateInProcessChildSessionResult> {
  const modelLabel = `${options.modelRef.provider}/${options.modelRef.id}`;
  const loadSdk =
    options.loadSdk ??
    (async () => await import("@earendil-works/pi-coding-agent"));
  const sessionId =
    options.sessionId ??
    `${options.sessionIdPrefix ?? "child"}-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;

  const previousMarker =
    options.markerEnv === undefined
      ? undefined
      : process.env[options.markerEnv];

  // A raw SDK session created inside the try. If a later bootstrap assertion
  // fails (model/tool/validation), it must be disposed before returning — a
  // live child would keep listeners, extensions and provider state in-process.
  let createdSession: unknown;

  try {
    const sdk = asSdk(await loadSdk());

    // Exact-name tools only: a wildcard or `+name`/`-name` entry cannot be
    // asserted as an exact active set, so refuse it before creating anything.
    if (options.exactTools === true) {
      const invalid = options.tools.filter(
        (name) => !isExactToolSelectionName(name),
      );
      if (invalid.length > 0) {
        return {
          ok: false,
          modelLabel,
          error: `exact tool names are required for an isolated session; refusing patterns/modifiers: ${invalid.join(", ")}`,
        };
      }
    }

    const model = options.findModel(
      options.modelRef.provider,
      options.modelRef.id,
    );
    if (!model) {
      return {
        ok: false,
        modelLabel,
        error:
          options.missingModelError?.(modelLabel) ??
          `child model ${modelLabel} is not in the model registry`,
      };
    }

    let modelRuntime: unknown;
    try {
      modelRuntime = await sdk.ModelRuntime.create();
    } catch (e: unknown) {
      return {
        ok: false,
        modelLabel,
        error: `could not create a model runtime for the child (auth/model catalog problem): ${
          e instanceof Error ? e.message : String(e)
        }`,
      };
    }

    // Seed providers the child does not compose yet (e.g. providers registered
    // only in the parent session) BEFORE the session exists. Present-probe:
    // only the difference is registered, native-first, per-provider
    // fault-isolated — never fatal, never layer-aware.
    const providerSeed = seedChildRuntimeProviders(
      modelRuntime,
      options.parentProviders,
    );

    if (options.authCheck) {
      const auth = await options.authCheck({
        modelRuntime,
        providerSeed,
        modelLabel,
        provider: options.modelRef.provider,
      });
      if (!auth.ok) {
        return {
          ok: false,
          modelLabel,
          providerSeed,
          error: auth.error,
        };
      }
    }

    const loaderOptions: Record<string, unknown> = {
      cwd: options.cwd,
      agentDir: options.agentDir,
    };
    if (options.noExtensions === true) loaderOptions.noExtensions = true;
    if (options.additionalExtensionPaths?.length) {
      loaderOptions.additionalExtensionPaths = [
        ...options.additionalExtensionPaths,
      ];
    }
    if (options.noSkills === true) loaderOptions.noSkills = true;
    if (options.noPromptTemplates === true) {
      loaderOptions.noPromptTemplates = true;
    }
    if (options.noThemes === true) loaderOptions.noThemes = true;
    if (options.noContextFiles === true) {
      loaderOptions.noContextFiles = true;
    }
    if (options.systemPrompt !== undefined) {
      loaderOptions.systemPrompt = options.systemPrompt;
    }
    if (options.appendSystemPrompt && options.appendSystemPrompt.length > 0) {
      loaderOptions.appendSystemPrompt = [...options.appendSystemPrompt];
    }

    const loader = new sdk.DefaultResourceLoader(loaderOptions);
    try {
      await loader.reload?.();
    } catch {
      /* a reload failure must not abort the child; defaults still apply */
    }

    const sessionManager = options.sessionManager(sdk, sessionId);
    const settingsManager = createChildSettingsManager(
      sdk,
      options.cwd,
      options.agentDir,
      options.providerRetries,
      {
        inMemory: options.inMemorySettings === true,
        ...(options.settings === undefined
          ? {}
          : { settings: options.settings }),
      },
    );

    if (options.markerEnv !== undefined) {
      process.env[options.markerEnv] = "1";
    }
    let created: {
      session?: unknown;
      extensionsResult?: unknown;
      modelFallbackMessage?: string;
    };
    try {
      created = await sdk.createAgentSession({
        cwd: options.cwd,
        agentDir: options.agentDir,
        modelRuntime,
        model,
        ...(options.modelRef.thinking === undefined
          ? {}
          : { thinkingLevel: options.modelRef.thinking }),
        tools: [...options.tools],
        ...(options.customTools === undefined
          ? {}
          : { customTools: options.customTools }),
        resourceLoader: loader,
        sessionManager,
        ...(settingsManager ? { settingsManager } : {}),
        sessionStartEvent: { type: "session_start", reason: "startup" },
      } as never);
    } finally {
      if (options.markerEnv !== undefined) {
        if (previousMarker === undefined) {
          delete process.env[options.markerEnv];
        } else {
          process.env[options.markerEnv] = previousMarker;
        }
      }
    }

    if (!created?.session) {
      return {
        ok: false,
        modelLabel,
        providerSeed,
        error: "createAgentSession returned no session",
      };
    }
    createdSession = created.session;

    // No silent substitution: an isolated caller opts into failing when the SDK
    // reports a fallback model or the session resolved a different model.
    if (options.rejectModelFallback === true) {
      const fallback = describeModelFallback(created, options.modelRef);
      if (fallback) {
        discardCreatedSession(created.session, options.onDispose);
        return {
          ok: false,
          modelLabel,
          providerSeed,
          error: `the child session did not use the requested model ${modelLabel}: ${fallback} — isolated sessions never fall back silently`,
        };
      }
    }

    const activeTools = readActiveToolNames(created.session);

    // Exact-set assertion first: a missing or unexpected tool means the child
    // is not the session the caller asked for, so it must not escape alive.
    if (options.exactTools === true) {
      const mismatch = compareExactToolSet(options.tools, activeTools);
      if (
        mismatch.unverifiable ||
        mismatch.missing.length > 0 ||
        mismatch.unexpected.length > 0
      ) {
        discardCreatedSession(created.session, options.onDispose);
        return {
          ok: false,
          modelLabel,
          providerSeed,
          ...(activeTools ? { activeTools } : {}),
          extensionsResult: created.extensionsResult,
          error:
            options.describeToolMismatch?.(mismatch) ??
            `the child's active tool set is not the requested set (${describeExactToolSetMismatch(
              mismatch,
            )})`,
        };
      }
    }

    const required = [...new Set(options.requiredTools ?? [])];
    if (activeTools && required.length > 0) {
      const missing = required.filter((name) => !activeTools.includes(name));
      if (missing.length > 0) {
        discardCreatedSession(created.session, options.onDispose);
        return {
          ok: false,
          modelLabel,
          providerSeed,
          activeTools,
          extensionsResult: created.extensionsResult,
          error:
            options.describeMissingTools?.(missing, activeTools) ??
            `child tools are not active: ${missing.join(", ")} — the session's tools allowlist dropped them`,
        };
      }
    }

    if (options.validate) {
      const validated = options.validate({
        session: created.session,
        extensionsResult: created.extensionsResult,
        activeTools,
      });
      if (!validated.ok) {
        discardCreatedSession(created.session, options.onDispose);
        return {
          ok: false,
          modelLabel,
          providerSeed,
          ...(activeTools ? { activeTools } : {}),
          extensionsResult: created.extensionsResult,
          error: validated.error,
        };
      }
    }

    // Bind the child's extension UI explicitly. Review binds print mode with no
    // UI; Orchestrator binds a bridge that forwards permission dialogs to the
    // parent. A binding failure is not fatal: the child still runs, but the
    // caller's validation is responsible for any surface it cannot live without.
    try {
      const bindable = created.session as {
        bindExtensions?: (bindings: {
          mode?: string;
          uiContext?: unknown;
        }) => Promise<void>;
      };
      await bindable.bindExtensions?.({
        mode: options.bindMode ?? "print",
        ...(options.uiContext === undefined
          ? {}
          : { uiContext: options.uiContext }),
      });
    } catch {
      /* ignore: the caller can still validate the session/tools */
    }

    return {
      ok: true,
      modelLabel,
      providerSeed,
      ...(activeTools ? { activeTools } : {}),
      extensionsResult: created.extensionsResult,
      session: wrapAgentSession(
        created.session,
        modelLabel,
        sessionId,
        options.onDispose,
      ),
    };
  } catch (e: unknown) {
    // A throw after creation (e.g. a caller validation hook or a bind failure
    // surfacing unexpectedly) must not leave the raw child alive.
    if (createdSession !== undefined) {
      discardCreatedSession(createdSession, options.onDispose);
    }
    return {
      ok: false,
      modelLabel,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}
