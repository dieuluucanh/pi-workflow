/**
 * Workflow Extension — in-process Orchestrator Build child.
 *
 * One fresh Workflow extension instance per child gives the child the same
 * Build tools and policy gates as a normal Build session without spawning a
 * process, opening a window/tab or using a grant/IPC channel.
 */

import {
  createInProcessChildSession,
  type InProcessChildSession,
} from "./in-process-child.ts";
import {
  ORCHESTRATOR_CHILD_ENTRY,
  ORCHESTRATOR_CHILD_VERSION,
  buildOrchestratorChildSystemPrompt,
  type OrchestratorChildContext,
} from "./orchestrator-child-contract.ts";
import {
  checkReviewerProviderAuth,
  describeSeedResult,
} from "./review-providers.ts";

/** Build tools the child must have. Custom parent tools are added by the caller. */
export const ORCHESTRATOR_CHILD_REQUIRED_TOOLS = [
  "read",
  "bash",
  "edit",
  "write",
  "grep",
  "find",
  "ls",
  "workflow_todo",
] as const;

export interface CreateOrchestratorChildInput {
  context: OrchestratorChildContext;
  cwd: string;
  agentDir: string;
  modelRef: { provider: string; id: string; thinking?: string };
  findModel: (provider: string, id: string) => unknown;
  parentProviders?: unknown;
  /** This extension's own file, loaded by the child's resource loader. */
  selfExtensionPath: string;
  /** Parent UI bridge; permission dialogs only. */
  uiContext?: unknown;
  /** Extra active tools from the parent session's non-Workflow set. */
  extraTools?: string[];
  providerRetries?: number;
  sessionId?: string;
  /** Child-extension teardown, run after `AgentSession.dispose()`. */
  onDispose?: () => void;
  loadSdk?: () => Promise<unknown>;
}

export interface CreateOrchestratorChildResult {
  ok: boolean;
  child?: InProcessChildSession;
  modelLabel?: string;
  error?: string;
}

/**
 * Create the child session. The caller sends the kickoff prompt after this
 * returns `ok: true`.
 */
export async function createOrchestratorBuildChild(
  input: CreateOrchestratorChildInput,
): Promise<CreateOrchestratorChildResult> {
  const tools = [
    ...new Set([
      ...ORCHESTRATOR_CHILD_REQUIRED_TOOLS,
      "explore",
      ...(input.extraTools ?? []),
    ]),
  ].filter((name) => name !== "questionnaire" && !name.startsWith("orchestrator_"));

  const result = await createInProcessChildSession({
    cwd: input.cwd,
    agentDir: input.agentDir,
    modelRef: input.modelRef,
    findModel: input.findModel,
    parentProviders: input.parentProviders,
    providerRetries: input.providerRetries,
    noExtensions: true,
    additionalExtensionPaths: [input.selfExtensionPath],
    noPromptTemplates: true,
    noThemes: true,
    appendSystemPrompt: [
      buildOrchestratorChildSystemPrompt(input.context),
    ],
    tools,
    requiredTools: [...ORCHESTRATOR_CHILD_REQUIRED_TOOLS],
    sessionManager: (sdk, sessionId) => {
      const manager = sdk.SessionManager.inMemory(input.cwd, {
        id: sessionId,
      }) as {
        appendCustomEntry?: (customType: string, data?: unknown) => unknown;
      };
      manager.appendCustomEntry?.(ORCHESTRATOR_CHILD_ENTRY, input.context);
      return manager;
    },
    sessionId: input.sessionId,
    sessionIdPrefix: "orch-child",
    bindMode: "print",
    uiContext: input.uiContext,
    onDispose: input.onDispose,
    missingModelError: (label) =>
      `Builder model ${label} is not in the model registry — set it with /role set builder <provider/model> or /profile.`,
    authCheck: async ({ modelRuntime, providerSeed }) => {
      const auth = await checkReviewerProviderAuth(
        modelRuntime,
        input.modelRef.provider,
      );
      if (auth.configured) return { ok: true };
      return {
        ok: false,
        error: `Builder provider ${input.modelRef.provider} is not configured: ${describeSeedResult(
          providerSeed,
        )}. Configure auth or choose another Builder model; nothing was dispatched.`,
      };
    },
    validate: ({ extensionsResult }) => {
      const loaded = Array.isArray(
        (extensionsResult as { extensions?: unknown[] } | undefined)
          ?.extensions,
      )
        ? (extensionsResult as { extensions: Array<Record<string, unknown>> })
            .extensions
        : [];
      const self = input.selfExtensionPath.replace(/\\/g, "/");
      const found = loaded.some((ext) => {
        const path = String(ext.path ?? ext.resolvedPath ?? "").replace(
          /\\/g,
          "/",
        );
        return path === self || path.endsWith("/workflow/index.ts");
      });
      if (!found) {
        return {
          ok: false,
          error:
            "the Workflow extension did not load in the child, so Build policies would be missing; refusing to run an unguarded child",
        };
      }
      return { ok: true };
    },
    loadSdk: input.loadSdk,
  });

  if (!result.ok || !result.session) {
    return {
      ok: false,
      ...(result.modelLabel ? { modelLabel: result.modelLabel } : {}),
      error: result.error ?? "the child session could not be created",
    };
  }
  return {
    ok: true,
    child: result.session,
    modelLabel: result.modelLabel,
  };
}

/** Marker used by the child extension to detect its own identity. */
export { ORCHESTRATOR_CHILD_ENTRY, ORCHESTRATOR_CHILD_VERSION };
