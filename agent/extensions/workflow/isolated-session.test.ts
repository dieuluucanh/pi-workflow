/**
 * Shared isolated-session infrastructure (parity plan row 7).
 *
 * The guarantees under test:
 *   - in-memory session and settings managers, explicit context only, and no
 *     ambient extensions/skills/templates/themes/context files;
 *   - its own ModelRuntime, parent provider seeding and a fail-fast auth
 *     preflight;
 *   - an exact active-tool assertion (missing, unexpected or unverifiable is a
 *     failure) with the raw SDK session disposed on every bootstrap failure;
 *   - no silent model fallback;
 *   - no process-global environment mutation for a refiner;
 *   - Review Mode still works through the shared wrapper.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createIsolatedSession,
  isolatedProviderAuthFailureMessage,
  missingIsolatedSessionSdkExports,
  renderIsolatedContext,
  renderIsolatedContextBlock,
} from "./isolated-session.ts";
import { createInProcessChildSession } from "./in-process-child.ts";
import { createReviewSession, reviewToolAllowlist, REVIEW_BUILTIN_TOOLS } from "./review.ts";
import { createReviewTools, type ReviewToolDeps } from "./review-tools.ts";
import { checkProviderAuth } from "./provider-auth.ts";

// ── Fixtures ─────────────────────────────────────────────────────────

const MODEL = { provider: "p", id: "m", thinking: "high" };

const TOOLS = ["read", "grep", "prompt_ask", "prompt_submit"];

interface Captured {
  loaderOptions?: Record<string, unknown>;
  settingsInput?: Record<string, unknown>;
  settingsOverrides?: Record<string, unknown>;
  sessionOptions?: Record<string, unknown>;
  sessionManagerArgs?: { cwd: string; opts: unknown };
  createCalls: number;
  fileSettingsCalls: number;
  sdkLoads: number;
  disposeCount: number;
  events: string[];
}

function fakeSession(activeTools: string[] | undefined) {
  return {
    subscribe: () => () => {},
    prompt: async () => {},
    followUp: async () => {},
    abort: async () => {},
    isStreaming: false,
    dispose: () => {},
    ...(activeTools === undefined
      ? {}
      : { getActiveToolNames: () => [...activeTools] }),
  };
}

function makeSdk(
  over: {
    runtime?: unknown;
    activeTools?:
      | string[]
      | ((opts: Record<string, unknown>) => string[] | undefined);
    fallbackMessage?: string;
    sessionModel?: { provider: string; id: string };
    createThrows?: Error;
  } = {},
) {
  const captured: Captured = {
    createCalls: 0,
    fileSettingsCalls: 0,
    sdkLoads: 0,
    disposeCount: 0,
    events: [],
  };
  const settingsManager = {
    getRetrySettings: () => ({
      enabled: true,
      maxRetries: 3,
      baseDelayMs: 2_000,
      maxAgentDelayMs: 60_000,
    }),
    applyOverrides: (overrides: unknown) => {
      captured.settingsOverrides = overrides as Record<string, unknown>;
    },
  };
  const sdk = {
    ModelRuntime: { create: async () => over.runtime ?? {} },
    DefaultResourceLoader: class {
      constructor(opts: Record<string, unknown>) {
        captured.loaderOptions = opts;
      }
      async reload() {}
    },
    SessionManager: {
      inMemory: (cwd: string, opts: unknown) => {
        captured.sessionManagerArgs = { cwd, opts };
        return {};
      },
    },
    SettingsManager: {
      // Must never run for an isolated session.
      create: () => {
        captured.fileSettingsCalls += 1;
        return settingsManager;
      },
      inMemory: (input: Record<string, unknown>) => {
        captured.settingsInput = input;
        return settingsManager;
      },
    },
    createAgentSession: async (opts: Record<string, unknown>) => {
      captured.createCalls += 1;
      captured.sessionOptions = opts;
      captured.events.push("create");
      if (over.createThrows) throw over.createThrows;
      const active =
        typeof over.activeTools === "function"
          ? over.activeTools(opts)
          : over.activeTools;
      const session = fakeSession(active);
      session.dispose = () => {
        captured.disposeCount += 1;
      };
      if (over.sessionModel) {
        (session as { model?: unknown }).model = over.sessionModel;
      }
      return {
        session,
        ...(over.fallbackMessage
          ? { modelFallbackMessage: over.fallbackMessage }
          : {}),
      };
    },
  };
  return { sdk, captured, settingsManager };
}

function baseOptions(over: Record<string, unknown> = {}) {
  return {
    cwd: "/proj",
    agentDir: "/agent",
    modelRef: MODEL,
    findModel: () => ({ provider: "p", id: "m" }),
    systemPrompt: "SYSTEM PROMPT",
    tools: TOOLS,
    customTools: [
      { name: "prompt_ask" },
      { name: "prompt_submit" },
    ],
    ...over,
  } as Parameters<typeof createIsolatedSession>[0];
}

/** A child runtime double that records provider registrations in order. */
function makeRuntime(
  over: {
    present?: string[];
    auth?: boolean;
    checkAuth?: (id: string) => unknown;
  } = {},
) {
  const ids = [...(over.present ?? [])];
  const events: string[] = [];
  const runtime = {
    getRegisteredProviderIds: () => [...ids],
    registerNativeProvider: (provider: { id?: string }) => {
      const id = String(provider?.id ?? "");
      ids.push(id);
      events.push(`native:${id}`);
    },
    registerProvider: (id: string) => {
      ids.push(id);
      events.push(`config:${id}`);
    },
    hasConfiguredAuth: (_id: string) => over.auth === true,
    checkAuth: async (id: string) =>
      over.checkAuth ? over.checkAuth(id) : undefined,
  };
  return { runtime, events, ids };
}

function parentSurface(over: {
  ids: string[];
  natives?: Record<string, unknown>;
  configs?: Record<string, unknown>;
}) {
  return {
    getRegisteredProviderIds: () => [...over.ids],
    getRegisteredNativeProvider: (id: string) => over.natives?.[id],
    getRegisteredProviderConfig: (id: string) => over.configs?.[id],
  };
}

// ── Isolation defaults and context inputs ────────────────────────────

test("isolated session: in-memory session/settings and no ambient resources", async () => {
  const { sdk, captured, settingsManager } = makeSdk({
    activeTools: (opts) => [...((opts.tools as string[]) ?? [])],
  });

  const res = await createIsolatedSession(
    baseOptions({
      context: [
        { label: "Plan", text: "PLAN TEXT" },
        "RAW CONTEXT",
        { label: "", text: "   " },
      ],
      loadSdk: async () => sdk,
    }),
  );

  assert.equal(res.ok, true, res.error);
  assert.equal(captured.loaderOptions?.noExtensions, true);
  assert.equal(captured.loaderOptions?.noSkills, true);
  assert.equal(captured.loaderOptions?.noPromptTemplates, true);
  assert.equal(captured.loaderOptions?.noThemes, true);
  assert.equal(captured.loaderOptions?.noContextFiles, true);
  assert.equal(captured.loaderOptions?.systemPrompt, "SYSTEM PROMPT");
  assert.deepEqual(captured.loaderOptions?.appendSystemPrompt, [
    "## Plan\n\nPLAN TEXT",
    "RAW CONTEXT",
  ]);

  assert.deepEqual(captured.settingsInput, {});
  assert.equal(
    captured.sessionOptions?.settingsManager,
    settingsManager,
    "the child receives the in-memory manager",
  );
  assert.deepEqual(captured.settingsOverrides, {
    retry: {
      enabled: true,
      maxRetries: 1,
      baseDelayMs: 2_000,
      maxAgentDelayMs: 60_000,
    },
  });
  assert.equal(captured.fileSettingsCalls, 0, "no file-backed settings read");

  assert.deepEqual(captured.sessionManagerArgs?.cwd, "/proj");
  assert.equal(
    typeof (captured.sessionManagerArgs?.opts as { id?: unknown } | undefined)
      ?.id,
    "string",
  );
  assert.equal(captured.sessionOptions?.thinkingLevel, "high");
  assert.deepEqual(captured.sessionOptions?.tools, TOOLS);
  assert.deepEqual(res.activeTools, TOOLS);
  assert.equal(res.session?.modelLabel, "p/m");
});

test("renderIsolatedContext: drops empty blocks and labels the rest", () => {
  assert.deepEqual(renderIsolatedContext(undefined), []);
  assert.deepEqual(
    renderIsolatedContext([
      "",
      "  ",
      { label: "Files", text: "src/a.ts" },
      { label: "  ", text: "bare" },
    ]),
    ["## Files\n\nsrc/a.ts", "## Context\n\nbare"],
  );
  assert.equal(
    renderIsolatedContextBlock({ label: "Evidence", text: "" }),
    "## Evidence\n\n",
  );
});

// ── Provider seeding and auth ────────────────────────────────────────

test("isolated session: seeds parent-only providers before creating the child", async () => {
  const { runtime, events } = makeRuntime({ present: ["present"], auth: true });
  const { sdk } = makeSdk({
    runtime,
    activeTools: (opts) => [...((opts.tools as string[]) ?? [])],
  });
  // Record the create boundary on the same ordered event list as seeding.
  const createAgentSession = sdk.createAgentSession;
  sdk.createAgentSession = async (opts: Record<string, unknown>) => {
    events.push("create");
    return await createAgentSession(opts);
  };

  const res = await createIsolatedSession(
    baseOptions({
      parentProviders: parentSurface({
        ids: ["custom", "present"],
        natives: { custom: { id: "custom" } },
      }),
      loadSdk: async () => sdk,
    }),
  );

  assert.equal(res.ok, true, res.error);
  assert.deepEqual(res.providerSeed?.seeded, ["custom"]);
  assert.deepEqual(res.providerSeed?.skippedPresent, ["present"]);
  const seededAt = events.indexOf("native:custom");
  const createdAt = events.indexOf("create");
  assert.ok(seededAt >= 0, "custom provider was registered");
  assert.ok(
    seededAt < createdAt,
    `provider seeding must precede session creation (${events.join(" → ")})`,
  );
});

test("isolated session: missing provider auth fails fast without creating a session", async () => {
  const { runtime } = makeRuntime({ auth: false });
  const { sdk, captured } = makeSdk({
    runtime,
    activeTools: (opts) => [...((opts.tools as string[]) ?? [])],
  });

  const res = await createIsolatedSession(
    baseOptions({
      modelRef: { provider: "custom", id: "m", thinking: "high" },
      parentProviders: parentSurface({ ids: ["custom"] }),
      loadSdk: async () => sdk,
    }),
  );

  assert.equal(res.ok, false);
  assert.equal(res.session, undefined);
  assert.match(res.error ?? "", /no usable auth for provider "custom"/);
  assert.match(res.error ?? "", /Provider seeding:/);
  assert.equal(captured.createCalls, 0, "no session is created without auth");
  assert.equal(captured.disposeCount, 0);
});

test("isolated session: a custom auth message replaces the generic one", async () => {
  const { runtime } = makeRuntime({ auth: false });
  const { sdk } = makeSdk({ runtime });
  const res = await createIsolatedSession(
    baseOptions({
      parentProviders: parentSurface({ ids: [] }),
      describeProviderAuthFailure: ({ providerId }: { providerId: string }) =>
        `refiner cannot use ${providerId}; set /prompt-model`,
      loadSdk: async () => sdk,
    }),
  );
  assert.equal(res.ok, false);
  assert.match(res.error ?? "", /refiner cannot use p; set \/prompt-model/);
});

test("provider auth probe: an SDK with no auth accessors is trusted, not blocked", async () => {
  const unverifiable = await checkProviderAuth({}, "p");
  assert.equal(unverifiable.configured, true);
  assert.equal(unverifiable.unverifiable, true);

  assert.equal(
    (await checkProviderAuth({ hasConfiguredAuth: () => true }, "p")).configured,
    true,
  );
  assert.equal(
    (await checkProviderAuth({ hasConfiguredAuth: () => false }, "p")).configured,
    false,
  );
  assert.equal(
    (
      await checkProviderAuth(
        { checkAuth: async () => ({ apiKey: "x" }) },
        "p",
      )
    ).configured,
    true,
  );
  const throwing = await checkProviderAuth(
    {
      checkAuth: async () => {
        throw new Error("boom");
      },
    },
    "p",
  );
  assert.equal(
    throwing.configured,
    false,
    "a throwing accessor is not a verification",
  );
  assert.equal(throwing.unverifiable, false);
});

// ── Missing exports and model/tool capability failures ───────────────

test("isolated session: missing SDK exports fail before any runtime is built", async () => {
  assert.deepEqual(
    missingIsolatedSessionSdkExports({}),
    [
      "ModelRuntime.create",
      "DefaultResourceLoader",
      "SessionManager.inMemory",
      "SettingsManager.inMemory",
      "createAgentSession",
    ],
  );
  assert.deepEqual(
    missingIsolatedSessionSdkExports({
      ModelRuntime: { create: () => {} },
      DefaultResourceLoader: class {},
      SessionManager: { inMemory: () => ({}) },
      SettingsManager: { inMemory: () => ({}) },
      createAgentSession: () => {},
    }),
    [],
  );
  // The real SDK exports classes (functions), not object literals. A
  // `typeof value === "object"` guard used to report every static as missing
  // in the real Terminal, so refinement could never start there.
  assert.deepEqual(
    missingIsolatedSessionSdkExports({
      ModelRuntime: class {
        static create(): void {}
      },
      DefaultResourceLoader: class {},
      SessionManager: class {
        static inMemory(): void {}
      },
      SettingsManager: class {
        static inMemory(): void {}
      },
      createAgentSession: () => {},
    }),
    [],
    "class-valued SDK exports must satisfy the isolated-session capability check",
  );

  const res = await createIsolatedSession(
    baseOptions({
      loadSdk: async () => ({ ModelRuntime: { create: async () => ({}) } }),
    }),
  );
  assert.equal(res.ok, false);
  assert.match(res.error ?? "", /SettingsManager\.inMemory/);
  assert.match(res.error ?? "", /SessionManager\.inMemory/);
  assert.match(res.error ?? "", /DefaultResourceLoader/);
  assert.match(res.error ?? "", /createAgentSession/);
  assert.match(res.error ?? "", /No ambient or file-backed fallback/);
});

test("isolated session: a missing model is a capability failure, not a fallback", async () => {
  const { sdk, captured } = makeSdk({ activeTools: TOOLS });
  const res = await createIsolatedSession(
    baseOptions({ findModel: () => undefined, loadSdk: async () => sdk }),
  );
  assert.equal(res.ok, false);
  assert.match(res.error ?? "", /not in the model registry/);
  assert.equal(captured.createCalls, 0);
});

test("isolated session: a dropped tool fails and disposes the created session", async () => {
  const { sdk, captured } = makeSdk({ activeTools: ["read"] });
  const res = await createIsolatedSession(
    baseOptions({ loadSdk: async () => sdk }),
  );
  assert.equal(res.ok, false);
  assert.equal(res.session, undefined);
  assert.match(res.error ?? "", /missing: (grep|prompt_ask|prompt_submit)/);
  assert.deepEqual(res.activeTools, ["read"]);
  assert.equal(captured.disposeCount, 1, "the raw child was disposed");
});

test("isolated session: an unexpected active tool fails and disposes the created session", async () => {
  const { sdk, captured } = makeSdk({
    activeTools: [...TOOLS, "bash"],
  });
  const res = await createIsolatedSession(
    baseOptions({ loadSdk: async () => sdk }),
  );
  assert.equal(res.ok, false);
  assert.match(res.error ?? "", /unexpected: bash/);
  assert.equal(captured.disposeCount, 1);
});

test("isolated session: an unverifiable tool set fails and disposes", async () => {
  const { sdk, captured } = makeSdk({ activeTools: undefined });
  const res = await createIsolatedSession(
    baseOptions({ loadSdk: async () => sdk }),
  );
  assert.equal(res.ok, false);
  assert.match(res.error ?? "", /cannot be verified/);
  assert.equal(captured.disposeCount, 1);
});

test("isolated session: wildcard/modifier tool entries are refused before creation", async () => {
  const { sdk, captured } = makeSdk({ activeTools: TOOLS });
  for (const bad of ["*", "+read", "-grep"]) {
    const res = await createIsolatedSession(
      baseOptions({ tools: ["read", bad], loadSdk: async () => sdk }),
    );
    assert.equal(res.ok, false, `${bad} must be refused`);
    assert.match(res.error ?? "", /exact tool names are required/);
  }
  assert.equal(captured.createCalls, 0);
  assert.equal(captured.disposeCount, 0);
});

test("isolated session: no silent model fallback (message or resolved model)", async () => {
  const withMessage = makeSdk({
    activeTools: TOOLS,
    fallbackMessage: "Could not restore model x/y. Using p/m",
  });
  const res1 = await createIsolatedSession(
    baseOptions({ loadSdk: async () => withMessage.sdk }),
  );
  assert.equal(res1.ok, false);
  assert.match(res1.error ?? "", /did not use the requested model p\/m/);
  assert.match(res1.error ?? "", /never fall back silently/);
  assert.equal(withMessage.captured.disposeCount, 1);

  const withModel = makeSdk({
    activeTools: TOOLS,
    sessionModel: { provider: "other", id: "z" },
  });
  const res2 = await createIsolatedSession(
    baseOptions({ loadSdk: async () => withModel.sdk }),
  );
  assert.equal(res2.ok, false);
  assert.match(res2.error ?? "", /resolved other\/z instead of p\/m/);
  assert.equal(withModel.captured.disposeCount, 1);
});

// ── Disposal on low-level bootstrap failures ─────────────────────────

test("low-level child: a validation failure disposes the session and runs onDispose", async () => {
  const { sdk, captured } = makeSdk({ activeTools: TOOLS });
  let cleanup = 0;
  const res = await createInProcessChildSession({
    cwd: "/proj",
    agentDir: "/agent",
    modelRef: MODEL,
    findModel: () => ({}),
    tools: TOOLS,
    sessionManager: (childSdk, id) =>
      childSdk.SessionManager.inMemory("/proj", { id }),
    validate: () => ({ ok: false, error: "child extension missing" }),
    onDispose: () => {
      cleanup += 1;
    },
    loadSdk: async () => sdk,
  });
  assert.equal(res.ok, false);
  assert.equal(res.error, "child extension missing");
  assert.equal(captured.disposeCount, 1);
  assert.equal(cleanup, 1);
});

test("low-level child: a throwing validation hook still disposes the session", async () => {
  const { sdk, captured } = makeSdk({ activeTools: TOOLS });
  const res = await createInProcessChildSession({
    cwd: "/proj",
    agentDir: "/agent",
    modelRef: MODEL,
    findModel: () => ({}),
    tools: TOOLS,
    sessionManager: (childSdk, id) =>
      childSdk.SessionManager.inMemory("/proj", { id }),
    validate: () => {
      throw new Error("validator exploded");
    },
    loadSdk: async () => sdk,
  });
  assert.equal(res.ok, false);
  assert.match(res.error ?? "", /validator exploded/);
  assert.equal(captured.disposeCount, 1);
});

// ── No process-global environment mutation for a refiner ─────────────

test("isolated session: creating a refiner never mutates process env", async () => {
  delete process.env.PI_WORKFLOW_REVIEW_CHILD;
  delete process.env.PI_PROMPT_REFINEMENT_CHILD;
  delete process.env.PI_WORKFLOW_REFINEMENT_CHILD;
  const allowed = process.env.PI_WORKFLOW_REVIEW_CHILD;
  const before = { ...process.env };

  const { sdk, captured } = makeSdk({
    activeTools: (opts) => [...((opts.tools as string[]) ?? [])],
  });
  const res = await createIsolatedSession(
    baseOptions({ label: "prompt refiner", loadSdk: async () => sdk }),
  );

  assert.equal(res.ok, true, res.error);
  assert.equal(allowed, undefined);
  assert.deepEqual({ ...process.env }, before, "no environment key was added/removed");
  assert.equal(process.env.PI_WORKFLOW_REVIEW_CHILD, undefined);
  assert.equal(process.env.PI_PROMPT_REFINEMENT_CHILD, undefined);
  assert.equal(process.env.PI_WORKFLOW_REFINEMENT_CHILD, undefined);
  // The explicit marker option stays opt-in; a refiner passes none.
  assert.equal(
    (captured.sessionOptions as { markerEnv?: unknown } | undefined)?.markerEnv,
    undefined,
  );
});

// ── Review compatibility through the shared wrapper ──────────────────

test("Review compatibility: createReviewSession uses the shared isolation defaults", async () => {
  const markerDuringCreate: Array<string | undefined> = [];
  const captured: { loaderOptions?: Record<string, unknown>; sessionOptions?: Record<string, unknown> } = {};
  const customTools = [
    { name: "review_ask" },
    { name: "review_submit" },
  ];
  const expected = reviewToolAllowlist(customTools);
  const sdk = {
    ModelRuntime: { create: async () => ({}) },
    DefaultResourceLoader: class {
      constructor(opts: Record<string, unknown>) {
        captured.loaderOptions = opts;
      }
      async reload() {}
    },
    SessionManager: { inMemory: () => ({}) },
    SettingsManager: { inMemory: () => ({}) },
    createAgentSession: async (opts: Record<string, unknown>) => {
      captured.sessionOptions = opts;
      markerDuringCreate.push(process.env.PI_WORKFLOW_REVIEW_CHILD);
      return {
        session: {
          subscribe: () => () => {},
          prompt: async () => {},
          followUp: async () => {},
          abort: async () => {},
          isStreaming: false,
          getActiveToolNames: () => [...((opts.tools as string[]) ?? [])],
          bindExtensions: async () => {},
        },
      };
    },
  };

  const res = await createReviewSession({
    cwd: "/proj",
    agentDir: "/agent",
    modelRef: { provider: "p", id: "m", thinking: "xhigh" },
    findModel: () => ({}),
    reviewPrompt: "USER GUIDANCE",
    customTools,
    loadSdk: async () => sdk as never,
  });

  assert.equal(res.ok, true, res.error);
  assert.equal(captured.loaderOptions?.noExtensions, true);
  assert.equal(captured.loaderOptions?.noSkills, true);
  assert.equal(captured.loaderOptions?.noPromptTemplates, true);
  assert.equal(captured.loaderOptions?.noThemes, true);
  // Review preserves its documented ambient context files.
  assert.equal(captured.loaderOptions?.noContextFiles, undefined);
  assert.ok(
    String(captured.loaderOptions?.systemPrompt).startsWith("You are REVIEW MODE"),
  );
  assert.deepEqual(captured.loaderOptions?.appendSystemPrompt, ["USER GUIDANCE"]);
  assert.deepEqual(captured.sessionOptions?.tools, expected);
  assert.deepEqual(res.activeTools, expected);
  assert.equal(markerDuringCreate[0], "1");
  assert.equal(process.env.PI_WORKFLOW_REVIEW_CHILD, undefined);
  for (const name of REVIEW_BUILTIN_TOOLS) {
    assert.ok(expected.includes(name), `${name} stays in the review allowlist`);
  }
  assert.ok(!expected.includes("bash"));
  assert.ok(!expected.includes("edit"));
  assert.ok(!expected.includes("write"));
});

test("Review allowlist: exactly the eight reviewer tools, no review_plan_*", () => {
  const definition = (name: string) => ({
    name,
    label: name,
    description: "",
    parameters: {},
    execute: async () => ({ content: [] }),
  });
  const sdk = {
    createBashToolDefinition: () => definition("bash"),
    createReadToolDefinition: () => definition("read"),
    createGrepToolDefinition: () => definition("grep"),
    createFindToolDefinition: () => definition("find"),
    createLsToolDefinition: () => definition("ls"),
  };
  const deps: ReviewToolDeps = {
    cwd: "/proj",
    log: () => {},
    explore: {
      budget: () => 1,
      run: async () => "",
      onUsed: () => {},
      log: () => {},
    },
    submit: {
      planPath: () => "/proj/.pi/plans/plan.md",
      originalPlan: () => "# Plan",
      modelLabel: () => "reviewer-model",
      submit: async () => ({ ok: true, path: "/proj/.pi/plans/plan.md" }),
      log: () => {},
    },
    passDone: {
      hasSubmitted: () => true,
      onPassDone: () => {},
      willVerify: () => false,
      log: () => {},
    },
  };

  const built = createReviewTools(sdk as never, deps);
  const names = built.tools.map((tool) => (tool as { name: string }).name);
  const expected = [
    "read",
    "grep",
    "find",
    "ls",
    "review_bash",
    "review_explore",
    "review_submit",
    "review_pass_done",
  ];
  assert.deepEqual([...names].sort(), [...expected].sort(), "built tools");
  assert.deepEqual(reviewToolAllowlist(built.tools), expected, "allowlist");
  assert.ok(
    !expected.some((name) => name.startsWith("review_plan_")),
    "no chunked rewrite tool is exposed",
  );
});

test("Review compatibility: a dropped reviewer tool disposes the child", async () => {
  let disposeCount = 0;
  const sdk = {
    ModelRuntime: { create: async () => ({}) },
    DefaultResourceLoader: class {
      async reload() {}
    },
    SessionManager: { inMemory: () => ({}) },
    SettingsManager: { inMemory: () => ({}) },
    createAgentSession: async () => ({
      session: {
        subscribe: () => () => {},
        prompt: async () => {},
        followUp: async () => {},
        abort: async () => {},
        isStreaming: false,
        getActiveToolNames: () => [...REVIEW_BUILTIN_TOOLS],
        dispose: () => {
          disposeCount += 1;
        },
      },
    }),
  };

  const res = await createReviewSession({
    cwd: "/proj",
    agentDir: "/agent",
    modelRef: { provider: "p", id: "m", thinking: "high" },
    findModel: () => ({}),
    reviewPrompt: "x",
    customTools: [{ name: "review_submit" }],
    loadSdk: async () => sdk as never,
  });

  assert.equal(res.ok, false);
  assert.match(res.error ?? "", /review_submit/);
  assert.equal(disposeCount, 1);
});

// ── Generic message helper ───────────────────────────────────────────

test("isolatedProviderAuthFailureMessage: names the provider and the escape hatch", () => {
  const message = isolatedProviderAuthFailureMessage({
    label: "prompt refiner",
    providerId: "custom",
    seed: { seeded: [], skippedPresent: [], errors: [] },
    seedSummary: "nothing needed seeding; none were already present; no failures",
    parentSurfaceFound: false,
    modelsJsonPath: "/agent/models.json",
    auth: {
      configured: false,
      viaSnapshot: false,
      viaCheckAuth: false,
      unverifiable: false,
    },
  });
  assert.match(message, /prompt refiner has no usable auth for provider "custom"/);
  assert.match(message, /no provider-registration surface/);
  assert.match(message, /\/login custom/);
  assert.match(message, /\/agent\/models\.json/);
});

test("isolated session: class-shaped SDK exports are accepted (production shape)", () => {
  // The real Pi SDK exports these as CLASSES. A static-method check must not
  // treat a constructor as "not an object" and report its statics as missing.
  class ModelRuntime {
    static async create() {
      return {};
    }
  }
  class SessionManager {
    static inMemory() {
      return {};
    }
  }
  class SettingsManager {
    static inMemory() {
      return {};
    }
  }
  assert.deepEqual(
    missingIsolatedSessionSdkExports({
      ModelRuntime,
      DefaultResourceLoader: class {},
      SessionManager,
      SettingsManager,
      createAgentSession: () => {},
    }),
    [],
    "class constructors with the required statics satisfy the probe",
  );

  // A function carrier with the statics attached is equally valid.
  const fnCarrier = Object.assign(function carrier() {}, {
    inMemory: () => ({}),
  });
  assert.deepEqual(
    missingIsolatedSessionSdkExports({
      ModelRuntime: Object.assign(function rt() {}, { create: async () => ({}) }),
      DefaultResourceLoader: class {},
      SessionManager: fnCarrier,
      SettingsManager: Object.assign(function sm() {}, {
        inMemory: () => ({}),
      }),
      createAgentSession: () => {},
    }),
    [],
  );

  // A non-callable static is a genuine failure, named precisely.
  assert.deepEqual(
    missingIsolatedSessionSdkExports({
      ModelRuntime: class {
        static create = 42;
      },
      DefaultResourceLoader: class {},
      SessionManager: { inMemory: () => ({}) },
      SettingsManager: { inMemory: () => ({}) },
      createAgentSession: () => {},
    }),
    ["ModelRuntime.create"],
  );
});

test("isolated session: the installed Pi SDK satisfies the export contract (import only)", async () => {
  const sdk = await import("@earendil-works/pi-coding-agent");
  // Import-only: never constructs a ModelRuntime, SettingsManager or session.
  assert.deepEqual(
    missingIsolatedSessionSdkExports(sdk),
    [],
    "the real named-export namespace must satisfy the probe",
  );
});

test("isolated session: each required export is reported individually", () => {
  const complete = {
    ModelRuntime: class {
      static async create() {
        return {};
      }
    },
    DefaultResourceLoader: class {},
    SessionManager: class {
      static inMemory() {
        return {};
      }
    },
    SettingsManager: class {
      static inMemory() {
        return {};
      }
    },
    createAgentSession: () => {},
  } as Record<string, unknown>;
  assert.deepEqual(missingIsolatedSessionSdkExports(complete), []);

  const cases: Array<[string, string]> = [
    ["ModelRuntime", "ModelRuntime.create"],
    ["DefaultResourceLoader", "DefaultResourceLoader"],
    ["SessionManager", "SessionManager.inMemory"],
    ["SettingsManager", "SettingsManager.inMemory"],
    ["createAgentSession", "createAgentSession"],
  ];
  for (const [key, name] of cases) {
    const partial = { ...complete };
    delete partial[key];
    assert.deepEqual(
      missingIsolatedSessionSdkExports(partial),
      [name],
      `only ${name} is reported when ${key} is absent`,
    );
  }

  // Junk holders are total, never throwing, and report every export.
  for (const junk of [null, undefined, "sdk", 42, true]) {
    assert.deepEqual(missingIsolatedSessionSdkExports(junk), [
      "ModelRuntime.create",
      "DefaultResourceLoader",
      "SessionManager.inMemory",
      "SettingsManager.inMemory",
      "createAgentSession",
    ]);
  }
});

test("isolated session: a missing export fails before any runtime or session is built", async () => {
  const { sdk, captured } = makeSdk({ activeTools: TOOLS });
  const missingCreate = { ...sdk, DefaultResourceLoader: undefined };
  const res = await createIsolatedSession(
    baseOptions({ loadSdk: async () => missingCreate }),
  );
  assert.equal(res.ok, false);
  assert.match(res.error ?? "", /DefaultResourceLoader/);
  assert.equal(captured.createCalls, 0, "no session was created");
  assert.equal(captured.fileSettingsCalls, 0, "no file-backed settings were read");
  assert.equal(
    captured.loaderOptions,
    undefined,
    "no resource loader was constructed",
  );
});

test("refinement wrapper: shared bootstrap keeps in-memory settings and exact tools", async () => {
  const { sdk, captured } = makeSdk({
    activeTools: ["read", "grep"],
  });
  const res = await createIsolatedSession(
    baseOptions({
      label: "refinement session",
      sessionIdPrefix: "refine",
      tools: ["read", "grep"],
      customTools: [],
      loadSdk: async () => sdk,
    }),
  );
  assert.equal(res.ok, true, res.error);
  assert.equal(
    captured.fileSettingsCalls,
    0,
    "refinement never falls back to file-backed settings",
  );
  assert.deepEqual(captured.settingsInput, {});
  const opts = captured.sessionOptions as Record<string, unknown>;
  assert.deepEqual(opts.tools, ["read", "grep"], "exact tool allowlist");
  assert.equal(
    (captured.loaderOptions as Record<string, unknown>).noExtensions,
    true,
  );
  assert.equal(
    (captured.loaderOptions as Record<string, unknown>).noSkills,
    true,
  );
  assert.equal(
    (captured.loaderOptions as Record<string, unknown>).noContextFiles,
    true,
    "refinement keeps ambient context off by default",
  );
});
