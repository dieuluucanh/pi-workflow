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
 */
export interface InProcessChildSession {
  readonly sessionId: string;
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
}

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

/**
 * Build the child's runtime-only SettingsManager so its SDK retry budget is
 * bounded. `applyOverrides` is in-memory: the shared settings.json is never
 * written. Feature-detected for older Pi runtimes; a failure here means the
 * child keeps the parent's settings and the chain simply waits that budget out.
 */
export function createChildSettingsManager(
  sdk: unknown,
  cwd: string,
  agentDir: string,
  providerRetries: number | undefined,
): unknown | undefined {
  try {
    const holder = sdk as {
      SettingsManager?: { create?: (...args: unknown[]) => unknown };
    };
    const SettingsManager = holder?.SettingsManager;
    const create = SettingsManager?.create;
    if (typeof create !== "function") return undefined;
    const manager = create.call(SettingsManager, cwd, agentDir) as {
      getRetrySettings?: () => Record<string, unknown>;
      applyOverrides?: (overrides: unknown) => void;
    };
    if (!manager || typeof manager !== "object") return undefined;
    if (typeof manager.applyOverrides !== "function") return manager;
    const base =
      typeof manager.getRetrySettings === "function"
        ? manager.getRetrySettings()
        : {
            enabled: true,
            maxRetries: 3,
            baseDelayMs: 2_000,
            maxAgentDelayMs: 60_000,
          };
    manager.applyOverrides({
      retry: {
        ...base,
        enabled: true,
        maxRetries: clampProviderRetries(providerRetries),
      },
    });
    return manager;
  } catch {
    return undefined;
  }
}

function asSdk(raw: unknown): InProcessChildSdk {
  return raw as InProcessChildSdk;
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
  const s = raw as {
    subscribe: (l: (e: unknown) => void) => () => void;
    prompt: (
      t: string,
      o?: { streamingBehavior?: "steer" | "followUp" },
    ) => Promise<void>;
    followUp: (t: string) => Promise<void>;
    abort: () => Promise<void>;
    isStreaming: boolean;
    dispose?: () => void | Promise<void>;
  };
  let disposed = false;
  const unsubscribers: Array<() => void> = [];
  return {
    sessionId,
    modelLabel,
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

  try {
    const sdk = asSdk(await loadSdk());

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

    const activeTools = readActiveToolNames(created.session);
    const required = [...new Set(options.requiredTools ?? [])];
    if (activeTools && required.length > 0) {
      const missing = required.filter((name) => !activeTools.includes(name));
      if (missing.length > 0) {
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
    return {
      ok: false,
      modelLabel,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}
