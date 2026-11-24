/**
 * Shared isolated child-session bootstrap for auxiliary agents.
 *
 * Review Mode and prompt refinement both need a second SDK `AgentSession` in
 * the SAME Pi process, and both need it to be genuinely separate from the
 * parent conversation. They do NOT share prompts, submission tools, verdict
 * handling or fallback policy — those stay in their own wrappers
 * (`review.ts`, the future refinement runtime).
 *
 * What is shared here is only the general bootstrap:
 *   - an in-memory session manager and an in-memory settings manager (no
 *     session file, no user settings files, no writes);
 *   - no ambient extensions, skills, prompt templates, themes or AGENTS/CLAUDE
 *     context files; context is passed explicitly by the caller;
 *   - its own `ModelRuntime`, with parent-only provider registrations seeded
 *     and a provider-auth preflight before the session exists;
 *   - an exact active-tool assertion, so a dropped custom tool fails the child
 *     instead of producing a session that looks alive but cannot act;
 *   - disposal of the raw SDK session on EVERY bootstrap failure;
 *   - no silent model fallback: a substituted model is a failure.
 *
 * The former Review anti-recursion environment marker is supported only when a
 * caller explicitly opts in (`markerEnv`). Prompt refinement must not set one:
 * a refiner is identified by its own operation/session handles, never by
 * mutating process-global state.
 */

import * as path from "node:path";

import {
  createInProcessChildSession,
  isExactToolSelectionName,
  type CreateInProcessChildSessionResult,
  type InProcessChildSession,
  type InProcessChildSdkLoader,
} from "./in-process-child.ts";
import { checkProviderAuth, type ProviderAuthCheck } from "./provider-auth.ts";
import {
  describeSeedResult,
  isParentProviderSurface,
  type ProviderSeedResult,
} from "./review-providers.ts";

/** SDK exports an isolated session cannot be built without. */
export const ISOLATED_SESSION_REQUIRED_SDK_EXPORTS = [
  "ModelRuntime.create",
  "DefaultResourceLoader",
  "SessionManager.inMemory",
  "SettingsManager.inMemory",
  "createAgentSession",
] as const;

/**
 * Report which required SDK exports are missing. Pure and total: importing this
 * module never loads Pi, and a junk/empty SDK yields the full list.
 */
export function missingIsolatedSessionSdkExports(sdk: unknown): string[] {
  const holder =
    sdk && (typeof sdk === "object" || typeof sdk === "function")
      ? (sdk as Record<string, unknown>)
      : {};
  // The SDK exports these as *classes*, i.e. `typeof value === "function"`.
  // A plain object-only check silently reports every static
  // (`ModelRuntime.create`, `SessionManager.inMemory`, …) as missing against
  // the real SDK even though only test fixtures use object literals.
  const asObject = (value: unknown): Record<string, unknown> =>
    value && (typeof value === "object" || typeof value === "function")
      ? (value as Record<string, unknown>)
      : {};
  const modelRuntime = asObject(holder.ModelRuntime);
  const sessionManager = asObject(holder.SessionManager);
  const settingsManager = asObject(holder.SettingsManager);
  const missing: string[] = [];
  if (typeof modelRuntime.create !== "function") {
    missing.push("ModelRuntime.create");
  }
  if (typeof holder.DefaultResourceLoader !== "function") {
    missing.push("DefaultResourceLoader");
  }
  if (typeof sessionManager.inMemory !== "function") {
    missing.push("SessionManager.inMemory");
  }
  if (typeof settingsManager.inMemory !== "function") {
    missing.push("SettingsManager.inMemory");
  }
  if (typeof holder.createAgentSession !== "function") {
    missing.push("createAgentSession");
  }
  return missing;
}

/** One explicit, already policy-filtered context block. */
export interface IsolatedContextBlock {
  label: string;
  text: string;
}

/** A caller-supplied context block may be plain text or labelled. */
export type IsolatedContextInput = string | IsolatedContextBlock;

/**
 * Render one labelled context block. Callers must have filtered the text under
 * their own policy first; this function only frames it deterministically.
 */
export function renderIsolatedContextBlock(block: IsolatedContextBlock): string {
  const label = typeof block.label === "string" && block.label.trim()
    ? block.label.trim()
    : "Context";
  return `## ${label}\n\n${block.text ?? ""}`;
}

/** Render the explicit context inputs, dropping empty entries. */
export function renderIsolatedContext(
  inputs: readonly IsolatedContextInput[] | undefined,
): string[] {
  const out: string[] = [];
  for (const input of inputs ?? []) {
    if (typeof input === "string") {
      if (input.trim()) out.push(input);
      continue;
    }
    if (input && typeof input.text === "string" && input.text.trim()) {
      out.push(renderIsolatedContextBlock(input));
    }
  }
  return out;
}

/** Everything the caller may customise about a provider-auth failure. */
export interface IsolatedProviderAuthFailure {
  /** Human label of the child, e.g. "reviewer" or "prompt refiner". */
  label: string;
  providerId: string;
  seed: ProviderSeedResult;
  /** `describeSeedResult(seed)` precomputed for message builders. */
  seedSummary: string;
  /** The parent session exposed a provider-registration surface. */
  parentSurfaceFound: boolean;
  modelsJsonPath: string;
  auth: ProviderAuthCheck;
}

/**
 * Default fail-fast message for a provider whose auth cannot be resolved after
 * seeding. Names the provider, reports what seeding did, and gives the generic
 * escape hatch. Wrappers may replace it with domain-specific guidance.
 */
export function isolatedProviderAuthFailureMessage(
  input: IsolatedProviderAuthFailure,
): string {
  const seedSummary = input.parentSurfaceFound
    ? input.seedSummary
    : "the parent session exposed no provider-registration surface, so nothing could be seeded";
  return [
    `${input.label} has no usable auth for provider "${input.providerId}".`,
    `Provider seeding: ${seedSummary}.`,
    `${input.label} runs in an isolated session without ambient extensions, so a provider registered only in the parent session must be seeded (above) AND its auth must be resolvable on its own.`,
    `Fix any one of:`,
    `  1. run /login ${input.providerId} — the stored credential is read by every runtime;`,
    `  2. add a static provider entry to ${input.modelsJsonPath} — that file is loaded by every runtime;`,
    `  3. export the API key the provider config references.`,
  ].join("\n");
}

export interface CreateIsolatedSessionOptions {
  cwd: string;
  /** Global Pi config dir (usually ~/.pi/agent). */
  agentDir: string;
  modelRef: { provider: string; id: string; thinking?: string };
  /** Resolve a model from the parent's registry by provider/id. */
  findModel: (provider: string, id: string) => unknown;
  /** Parent-side provider-registration surface (structural, feature-detected). */
  parentProviders?: unknown;
  /** SDK retries per child model (0-2), applied through an in-memory override. */
  providerRetries?: number;
  /** Explicit system prompt. Pi's ambient/default prompt is never used. */
  systemPrompt: string;
  /**
   * Explicit, policy-filtered context appended to the system prompt. Nothing is
   * read from disk implicitly; ambient AGENTS/CLAUDE files are off by default.
   */
  context?: readonly IsolatedContextInput[];
  /** Exact active tool allowlist (built-in and custom names). */
  tools: readonly string[];
  customTools?: unknown[];
  sessionId?: string;
  sessionIdPrefix?: string;
  /** Human label used in failure messages (default "isolated session"). */
  label?: string;
  /**
   * Opt-in legacy identity marker. Review needs it for compatibility; prompt
   * refinement must NOT pass it — a refiner is never identified by env state.
   */
  markerEnv?: string;
  /** Default true. Set false only to preserve a documented legacy behaviour. */
  noContextFiles?: boolean;
  /** Initial settings for the in-memory SettingsManager. */
  settings?: Record<string, unknown>;
  missingModelError?: (modelLabel: string) => string;
  describeToolMismatch?: (mismatch: {
    missing: string[];
    unexpected: string[];
  }) => string;
  describeProviderAuthFailure?: (
    input: IsolatedProviderAuthFailure,
  ) => string;
  /** Injectable for tests; defaults to a real dynamic import. */
  loadSdk?: InProcessChildSdkLoader;
}

export interface CreateIsolatedSessionResult {
  ok: boolean;
  session?: InProcessChildSession;
  modelLabel: string;
  /** Tool names the child actually has enabled, when the SDK exposes them. */
  activeTools?: string[];
  /** What provider seeding did before the session was created, when probed. */
  providerSeed?: ProviderSeedResult;
  error?: string;
}

const defaultSdkLoader: InProcessChildSdkLoader = async () =>
  await import("@earendil-works/pi-coding-agent");

/**
 * Create one strictly isolated child session. Never throws: every failure is a
 * `{ ok: false, error }` result, and a session created before a failed
 * assertion is disposed by the shared factory.
 */
export async function createIsolatedSession(
  options: CreateIsolatedSessionOptions,
): Promise<CreateIsolatedSessionResult> {
  const label =
    typeof options.label === "string" && options.label.trim()
      ? options.label.trim()
      : "isolated session";
  const modelLabel = `${options.modelRef.provider}/${options.modelRef.id}`;

  const loadSdk = options.loadSdk ?? defaultSdkLoader;
  let sdk: unknown;
  try {
    sdk = await loadSdk();
  } catch (e: unknown) {
    return {
      ok: false,
      modelLabel,
      error: `could not load the Pi SDK for the ${label}: ${
        e instanceof Error ? e.message : String(e)
      }`,
    };
  }

  const missingExports = missingIsolatedSessionSdkExports(sdk);
  if (missingExports.length > 0) {
    return {
      ok: false,
      modelLabel,
      error: `the Pi SDK cannot host the ${label}: required isolated-session exports are missing (${missingExports.join(
        ", ",
      )}). No ambient or file-backed fallback is used.`,
    };
  }

  // Normalise the exact allowlist before the SDK sees it. The low-level factory
  // repeats this check; doing it here yields a message without creating a
  // runtime, session manager or settings manager.
  const tools = [
    ...new Set(
      options.tools
        .filter((name): name is string => typeof name === "string")
        .map((name) => name.trim())
        .filter(Boolean),
    ),
  ];
  const invalidTools = tools.filter((name) => !isExactToolSelectionName(name));
  if (invalidTools.length > 0) {
    return {
      ok: false,
      modelLabel,
      error: `exact tool names are required for the ${label}; refusing patterns/modifiers: ${invalidTools.join(
        ", ",
      )}`,
    };
  }

  const modelsJsonPath = path.join(options.agentDir, "models.json");
  const contextBlocks = renderIsolatedContext(options.context);

  const result: CreateInProcessChildSessionResult =
    await createInProcessChildSession({
      cwd: options.cwd,
      agentDir: options.agentDir,
      modelRef: options.modelRef,
      findModel: options.findModel,
      ...(options.parentProviders === undefined
        ? {}
        : { parentProviders: options.parentProviders }),
      ...(options.providerRetries === undefined
        ? {}
        : { providerRetries: options.providerRetries }),
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: options.noContextFiles !== false,
      inMemorySettings: true,
      ...(options.settings === undefined ? {} : { settings: options.settings }),
      systemPrompt: options.systemPrompt,
      ...(contextBlocks.length > 0
        ? { appendSystemPrompt: contextBlocks }
        : {}),
      tools,
      ...(options.customTools === undefined
        ? {}
        : { customTools: options.customTools }),
      exactTools: true,
      rejectModelFallback: true,
      sessionManager: (childSdk, sessionId) =>
        childSdk.SessionManager.inMemory(options.cwd, { id: sessionId }),
      ...(options.sessionId === undefined
        ? {}
        : { sessionId: options.sessionId }),
      sessionIdPrefix: options.sessionIdPrefix ?? "isolated",
      ...(options.markerEnv === undefined
        ? {}
        : { markerEnv: options.markerEnv }),
      bindMode: "print",
      missingModelError:
        options.missingModelError ??
        ((missing) =>
          `${label} model ${missing} is not in the model registry — configure the model and retry`),
      ...(options.describeToolMismatch === undefined
        ? {}
        : { describeToolMismatch: options.describeToolMismatch }),
      authCheck: async ({ modelRuntime, providerSeed }) => {
        const auth = await checkProviderAuth(
          modelRuntime,
          options.modelRef.provider,
        );
        if (auth.configured) return { ok: true };
        const failure: IsolatedProviderAuthFailure = {
          label,
          providerId: options.modelRef.provider,
          seed: providerSeed,
          seedSummary: describeSeedResult(providerSeed),
          parentSurfaceFound: isParentProviderSurface(options.parentProviders),
          modelsJsonPath,
          auth,
        };
        return {
          ok: false,
          error: (
            options.describeProviderAuthFailure ??
            isolatedProviderAuthFailureMessage
          )(failure),
        };
      },
      // Reuse the already-loaded SDK object: the loader must not run twice, and
      // tests can supply a stub without touching the real package.
      loadSdk: async () => sdk,
    });

  return {
    ok: result.ok,
    modelLabel: result.modelLabel,
    ...(result.session ? { session: result.session } : {}),
    ...(result.activeTools ? { activeTools: result.activeTools } : {}),
    ...(result.providerSeed ? { providerSeed: result.providerSeed } : {}),
    ...(result.error ? { error: result.error } : {}),
  };
}
