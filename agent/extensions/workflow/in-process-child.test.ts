/**
 * Workflow Extension — the widened in-process child handle.
 *
 * `wrapAgentSession` is the ONE place the parent reaches a child's model and
 * telemetry. These tests pin its contract:
 *
 *   - a child that exposes the public `AgentSession` APIs reports its REAL
 *     model (not just the requested launch label) and its stats;
 *   - an older/partial SDK degrades to `undefined` / `{ok:false}` and never
 *     throws;
 *   - `setModel` switches without aborting or disposing, is never persisted,
 *     and reports an auth/registry refusal as a result;
 *   - `dispose` stays idempotent.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import { wrapAgentSession } from "./in-process-child.ts";
import workflowExtension from "./index.ts";
import { ORCHESTRATOR_CHILD_VERSION } from "./orchestrator-child-contract.ts";
import { PROFILE_CONFIG_VERSION } from "./profiles.ts";
import {
  fakeSdk,
  makeFakeCtx,
  makeFakePi,
  tmpProject,
} from "./test-support.ts";

interface RawOptions {
  model?: {
    provider?: unknown;
    id?: unknown;
    modelId?: unknown;
    thinking?: unknown;
  };
  thinkingLevel?: unknown;
  stats?: unknown;
  context?: unknown;
  registry?: ((provider: string, id: string) => unknown) | undefined;
  setModel?: (model: unknown, options?: { persist?: boolean }) => unknown;
  setThinkingLevel?: (level: string, options?: { persist?: boolean }) => void;
  /** Start streaming so the steer path can be asserted. */
  streaming?: boolean;
}

function makeRaw(opts: RawOptions = {}) {
  const calls = {
    prompts: [] as string[],
    steers: [] as string[],
    followUps: [] as string[],
    aborts: 0,
    disposes: 0,
    setModel: [] as Array<{ model: unknown; options?: { persist?: boolean } }>,
    setThinking: [] as Array<{ level: string; options?: { persist?: boolean } }>,
  };
  const listeners: Array<(e: unknown) => void> = [];
  const raw: Record<string, unknown> = {
    get isStreaming() {
      return opts.streaming === true;
    },
    subscribe(listener: (e: unknown) => void) {
      listeners.push(listener);
      return () => {
        const i = listeners.indexOf(listener);
        if (i >= 0) listeners.splice(i, 1);
      };
    },
    async prompt(text: string, o?: { streamingBehavior?: string }) {
      if (o?.streamingBehavior === "steer") calls.steers.push(text);
      else calls.prompts.push(text);
    },
    async followUp(text: string) {
      calls.followUps.push(text);
    },
    async abort() {
      calls.aborts += 1;
    },
    dispose() {
      calls.disposes += 1;
    },
    model: opts.model,
    thinkingLevel: opts.thinkingLevel,
    modelRuntime: {
      getModel: (provider: string, id: string) =>
        opts.registry ? opts.registry(provider, id) : { provider, id },
    },
  };
  if (opts.stats !== undefined) raw.getSessionStats = () => opts.stats;
  if (opts.context !== undefined) raw.getContextUsage = () => opts.context;
  if (opts.setModel !== undefined) raw.setModel = opts.setModel;
  if (opts.setThinkingLevel !== undefined) {
    raw.setThinkingLevel = opts.setThinkingLevel;
  }
  return { raw, calls, emit: (e: unknown) => listeners.forEach((l) => l(e)) };
}

test("child handle: reports the session's real model, not just the launch label", () => {
  const { raw } = makeRaw({
    model: { provider: "open", id: "actual-model", thinking: "high" },
  });
  const child = wrapAgentSession(raw, "builder/requested-model", "s1");
  assert.equal(child.modelLabel, "open/actual-model");
  assert.deepEqual(child.currentModel?.(), {
    provider: "open",
    id: "actual-model",
    thinking: "high",
  });
});

test("child handle: falls back to thinkingLevel and the launch label", () => {
  const withLevel = makeRaw({
    model: { provider: "open", id: "m" },
    thinkingLevel: "xhigh",
  }).raw;
  const child = wrapAgentSession(withLevel, "builder/fallback", "s2");
  assert.deepEqual(child.currentModel?.(), {
    provider: "open",
    id: "m",
    thinking: "xhigh",
  });

  const noModel = makeRaw({}).raw;
  const fallback = wrapAgentSession(noModel, "builder/fallback", "s3");
  assert.equal(fallback.modelLabel, "builder/fallback");
  assert.equal(fallback.currentModel?.(), undefined);
});

test("child handle: stats combine context and cumulative tokens", () => {
  const { raw } = makeRaw({
    model: { provider: "open", id: "m", thinking: "low" },
    context: { tokens: 12_345, contextWindow: 200_000, percent: 6.2 },
    stats: {
      tokens: { input: 12_000, output: 900, cacheRead: 400, cacheWrite: 0, total: 13_300 },
      cost: 0.5,
    },
  });
  const child = wrapAgentSession(raw, "open/m", "s4");
  const stats = child.stats?.();
  assert.ok(stats);
  assert.deepEqual(stats.model, { provider: "open", id: "m", thinking: "low" });
  assert.equal(stats.thinking, "low");
  assert.deepEqual(stats.context, {
    tokens: 12_345,
    contextWindow: 200_000,
    percent: 6.2,
  });
  assert.deepEqual(stats.tokens, {
    input: 12_000,
    output: 900,
    cacheRead: 400,
    cacheWrite: 0,
    total: 13_300,
  });
});

test("child handle: an SDK without stats/context reports undefined", () => {
  const { raw } = makeRaw({ model: { provider: "open", id: "m" } });
  const child = wrapAgentSession(raw, "open/m", "s5");
  // No stats/context readers exist on this double at all.
  const stats = child.stats?.();
  assert.ok(stats, "the model alone is still reported");
  assert.equal(stats.tokens, undefined);
  assert.equal(stats.context, undefined);
});

test("child handle: malformed stats never throw and never fabricate numbers", () => {
  const { raw } = makeRaw({
    model: { provider: "open", id: "m" },
    context: { tokens: "nope", contextWindow: Number.NaN, percent: -3 },
    stats: { tokens: { input: "x", output: -5 } },
  });
  const child = wrapAgentSession(raw, "open/m", "s6");
  const stats = child.stats?.();
  // NaN window + null tokens is "unknown", not a 0% reading.
  assert.equal(stats?.context, undefined);
  assert.deepEqual(stats?.tokens, {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
  });
});

test("child handle: setModel switches without persisting or aborting", async () => {
  const { raw, calls } = makeRaw({
    model: { provider: "old", id: "model", thinking: "low" },
    setModel: (model, options) => {
      calls.setModel.push({ model, options });
      (raw as { model?: unknown }).model = model;
    },
    setThinkingLevel: (level, options) => {
      calls.setThinking.push({ level, options });
    },
  });
  const child = wrapAgentSession(raw, "old/model", "s7");
  const result = await child.setModel?.("new", "model-2", "high");
  assert.deepEqual(result, {
    ok: true,
    model: { provider: "new", id: "model-2", thinking: "high" },
  });
  assert.equal(calls.setModel.length, 1);
  assert.deepEqual(calls.setModel[0]?.options, { persist: false });
  assert.deepEqual(calls.setThinking, [{ level: "high", options: { persist: false } }]);
  assert.equal(calls.aborts, 0, "a model switch never aborts the child");
  assert.equal(calls.disposes, 0, "a model switch never disposes the child");
  assert.equal(child.modelLabel, "new/model-2");
});

test("child handle: an unsupported SDK refuses the switch without throwing", async () => {
  const { raw } = makeRaw({ model: { provider: "open", id: "m" } });
  const child = wrapAgentSession(raw, "open/m", "s8");
  const result = await child.setModel?.("other", "model");
  assert.equal(result?.ok, false);
  assert.match(String((result as { error?: string }).error), /unsupported SDK/);
});

test("child handle: a registry miss refuses the switch by name", async () => {
  const { raw } = makeRaw({
    model: { provider: "open", id: "m" },
    registry: () => undefined,
    setModel: () => {},
  });
  const child = wrapAgentSession(raw, "open/m", "s9");
  const result = await child.setModel?.("missing", "model");
  assert.equal(result?.ok, false);
  assert.match(
    String((result as { error?: string }).error),
    /missing\/model is not available/,
  );
});

test("child handle: an auth failure is returned, not thrown", async () => {
  const { raw } = makeRaw({
    model: { provider: "open", id: "m" },
    setModel: () => {
      throw new Error("No API key for provider");
    },
  });
  const child = wrapAgentSession(raw, "open/m", "s10");
  const result = await child.setModel?.("open", "m");
  assert.equal(result?.ok, false);
  assert.match(String((result as { error?: string }).error), /No API key/);
});

test("child handle: a thinking refusal does not undo an applied model switch", async () => {
  const { raw } = makeRaw({
    model: { provider: "open", id: "m" },
    setModel: (model) => {
      (raw as { model?: unknown }).model = model;
    },
    setThinkingLevel: () => {
      throw new Error("thinking unsupported");
    },
  });
  const child = wrapAgentSession(raw, "open/m", "s11");
  const result = await child.setModel?.("next", "model", "max");
  assert.equal(result?.ok, true);
  assert.deepEqual(
    (result as { model?: unknown }).model,
    { provider: "next", id: "model", thinking: "max" },
  );
});

test("child handle: dispose is idempotent and drops stats/model access", async () => {
  const { raw, calls } = makeRaw({
    model: { provider: "open", id: "m" },
    stats: { tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 } },
    setModel: () => {},
  });
  let teardown = 0;
  const child = wrapAgentSession(raw, "open/m", "s12", () => {
    teardown += 1;
  });
  child.dispose();
  child.dispose();
  assert.equal(calls.disposes, 1);
  assert.equal(teardown, 1);
  assert.equal(child.currentModel?.(), undefined);
  assert.equal(child.stats?.(), undefined);
  const result = await child.setModel?.("open", "m");
  assert.equal(result?.ok, false);
  assert.match(String((result as { error?: string }).error), /disposed/);
});

test("child handle: prompt steers while streaming, followUp is deferred", async () => {
  const { raw, calls } = makeRaw({ streaming: true });
  const child = wrapAgentSession(raw, "open/m", "s13");
  await child.prompt("hello");
  await child.followUp("later");
  assert.deepEqual(calls.steers, ["hello"]);
  assert.deepEqual(calls.prompts, []);
  assert.deepEqual(calls.followUps, ["later"]);
  assert.equal(child.isStreaming(), true);
});

/**
 * A child-local `/profile use` is session-scoped. It must switch the child's
 * own model but never write the parent's global default-profile / default-model
 * settings: one child's row assignment is not a user preference.
 */
test("child: /profile use switches the child model without writing parent global defaults", async () => {
  const { root, cwd, agentDir } = tmpProject();
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    fs.writeFileSync(
      path.join(agentDir, "profiles.json"),
      JSON.stringify({
        version: PROFILE_CONFIG_VERSION,
        profiles: [
          {
            name: "child-live",
            description: "child-local profile",
            roles: {
              builder: { provider: "p", id: "child-builder", thinking: "medium" },
              reviewer: { provider: "p", id: "child-reviewer", thinking: "high" },
            },
            defaultModel: { provider: "p", id: "child-default", thinking: "medium" },
          },
        ],
      }),
      "utf8",
    );
    fs.writeFileSync(path.join(agentDir, "settings.json"), "{}", "utf8");
    fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
    fs.writeFileSync(path.join(cwd, ".pi", "settings.json"), "{}", "utf8");

    const pi = makeFakePi({ activeTools: ["read", "write", "edit", "bash"] });
    // The fake SDK factory needs a script (empty here: this child never
    // launches a review session); the child's global-write assertions below
    // are unchanged.
    const { sdk } = fakeSdk({});
    await workflowExtension(pi as never, {
      loadSdk: async () => sdk as never,
      selfExtensionPath: "/fake/index.ts",
      isTerminalHost: () => true,
    });
    const made = makeFakeCtx({
      cwd,
      hasUI: false,
      branch: [
        {
          type: "custom",
          customType: "workflow-orchestrator-child",
          data: {
            version: ORCHESTRATOR_CHILD_VERSION,
            runId: "run-1",
            taskId: "task-1",
            attemptId: "attempt-1",
            ref: "1",
            total: 1,
            parentSessionRef: "parent-1",
          },
        },
      ],
      modelRegistry: {
        find: (provider: string, id: string) => ({
          provider,
          id,
          contextWindow: 1000,
          maxOutputTokens: 1000,
        }),
      },
    });
    await pi.emit("session_start", { reason: "startup" }, made.ctx);
    await pi.commands["profile"].handler("use child-live", made.ctx);

    // The child's own model still switches — the global-write guard must not
    // suppress the session-scoped effect.
    assert.equal(
      (pi.model as { provider?: string; id?: string } | undefined)?.id,
      "child-builder",
      "the child's own pi.setModel must still run",
    );
    // The row's switch is audited in the child transcript only — there is no
    // child→parent channel, and the parent-only owners stay silent.
    const switchScopes = pi.entries
      .filter((entry) => entry.type === "workflow-model-switch")
      .map((entry) => (entry.data as { scope?: string })?.scope);
    assert.ok(
      switchScopes.includes("child"),
      `a child-local profile activation must audit its own model switch (${JSON.stringify(switchScopes)})`,
    );
    assert.deepEqual(
      switchScopes.filter((scope) => scope !== "child"),
      [],
      "a child must never emit a parent/reviewer/builder-child model switch",
    );

    // A programmatic model_select inside the child also reaches the global
    // default-model mirror handler; it must refuse to persist there too.
    await pi.emit(
      "model_select",
      {
        type: "model_select",
        source: "user-select",
        model: {
          provider: "p",
          id: "child-select",
          thinking: "high",
          contextWindow: 1000,
          maxOutputTokens: 1000,
        },
      },
      made.ctx,
    );

    const global = JSON.parse(
      fs.readFileSync(path.join(agentDir, "settings.json"), "utf8"),
    ) as Record<string, unknown>;
    const workflow = (global.workflow ?? {}) as Record<string, unknown>;
    assert.equal(
      workflow.defaultProfile,
      undefined,
      "a child must not persist workflow.defaultProfile globally",
    );
    for (const key of ["defaultModel", "model", "defaultProvider", "defaultThinkingLevel"]) {
      assert.equal(
        global[key],
        undefined,
        `a child must not persist the parent's global ${key}`,
      );
      assert.equal(
        workflow[key],
        undefined,
        `a child must not persist the parent's workflow.${key}`,
      );
    }
    assert.equal(
      pi.entries.filter(
        (entry) => entry.type === "workflow-model-default-skip",
      ).length,
      0,
      "a child-local profile activation must not be reported as a global default write",
    );
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
