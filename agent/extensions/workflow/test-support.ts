/**
 * Shared test support for the workflow extension.
 *
 * Kept out of the shipped package files list and out of the `test` script's
 * entry point: it contains no tests, only the fake SDK / fake Pi host / fake
 * context and fixtures used by `review.test.ts` and `extension.test.ts`.
 *
 * The fake SDK reproduces the parts of Pi's child-session contract the review
 * runtime depends on (global tool allowlist, settle event, custom tools) so a
 * whole review round runs without a provider or network.
 */

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import type { WorkflowTabEditor } from "./tab-editor.ts";

// ── Plan fixtures ────────────────────────────────────────────────────

export const ORIGINAL_PLAN = [
  "# Plan: Add CSV export",
  "",
  "## Context",
  "The reports page needs CSV export following the existing export conventions.",
  "",
  "## Plan Steps",
  "",
  "1. Add a CSV serializer in src/export/csv.ts",
  "2. Wire a download button into the reports toolbar",
  "3. Add tests under tests/export/",
  "",
  "## Verification",
  "- Run the export test suite",
].join("\n");

/** A realistic rewrite: adds framework detail and a step, keeps the shape. */
export const REWRITTEN_PLAN = ORIGINAL_PLAN.replace(
  "1. Add a CSV serializer in src/export/csv.ts",
  "1. Add a CSV serializer in src/export/csv.ts returning Result<string, ExportError>, matching src/export/json.ts\n2. Register the format in src/export/index.ts so feature flags apply",
).replace(
  "3. Add tests under tests/export/",
  "4. Add tests under tests/export/ following the table-driven pattern",
);

/** Synthetic 22-step execution fixture; contains no user transcript text. */
export const HISTORICAL_22_STEP_PLAN = [
  "# Plan: Synthetic 22-step autonomy fixture",
  "",
  "## Plan Steps",
  ...Array.from({ length: 22 }, (_, i) =>
    `${i + 1}. Implement synthetic step ${i + 1} in module-${String(i + 1).padStart(2, "0")}.ts`,
  ),
  "",
  "## Verification",
  "- npm test",
].join("\n");

/** The historical 300s then 120s timeout shape, without real waits. */
export const TWO_TIMEOUT_SEQUENCE = [
  {
    command: "node --test extension.test.ts",
    timeoutSeconds: 300,
    durationMs: 300_569,
    message: "Command timed out after 300 seconds",
  },
  {
    command: "node --test --test-name-pattern RE1 extension.test.ts",
    timeoutSeconds: 120,
    durationMs: 120_477,
    message: "Command timed out after 120 seconds",
  },
] as const;

/** A non-shell work script that must remain executable after quarantine. */
export const SHELL_QUARANTINE_WORK_SCRIPT = [
  { kind: "bash", command: TWO_TIMEOUT_SEQUENCE[0].command, timeout: 300 },
  { kind: "bash", command: TWO_TIMEOUT_SEQUENCE[1].command, timeout: 120 },
  { kind: "read", path: "module-09.ts" },
  { kind: "grep", pattern: "TODO", path: "module-09.ts" },
  { kind: "edit", path: "module-09.ts" },
  { kind: "lsp", operation: "diagnostics", path: "module-09.ts" },
  { kind: "next-row", ref: "10" },
] as const;

/** A model checkpoint that must not end an approved execution. */
export const PREMATURE_FINAL_ANSWER = {
  stopReason: "stop" as const,
  text: "Status: incomplete. I stopped at a reasonable checkpoint.",
};

/** A checkless standalone row is valid metadata, not a missing assignment. */
export const CHECKLESS_STANDALONE_ROW = {
  id: "standalone-docs",
  ref: "1",
  text: "Document the public API",
  source: "steps" as const,
  acceptanceChecks: [] as string[],
  expectedFiles: ["docs/api.md"],
  status: "pending" as const,
};

/** Exact executable bytes that must survive snapshot/bootstrap round-trips. */
export const EXACT_CHECK_PAYLOAD =
  'node --test "suite with spaces.test.ts" && echo "a,b;c"';

/** A plan path that exists in persisted state but cannot be read on resume. */
export const MISSING_PLAN_RESUME = {
  persistedPlanPath: ".pi/plans/2026-11-22-missing-plan.md",
  remainingRefs: ["9", "15", "16", "17", "18", "19", "20", "21", "22"],
  fullRowCount: 22,
  expected: "paused with a diagnostic; never a shortened execution",
} as const;

/** Historical out-of-order progress: step 9 pending while 10-14 are done. */
export const OUT_OF_ORDER_COMPLETION = {
  pendingRefs: ["9"],
  completedRefs: ["1", "2", "3", "4", "5", "6", "7", "8", "10", "11", "12", "13", "14"],
} as const;

/** More required checks than the current silent cap; must reject or report. */
export const OVERFLOW_CHECKS = Array.from(
  { length: 13 },
  (_, i) => `node --test check-${i + 1}.test.ts`,
);

/** A pipeline whose display filter hides the real successful exit status. */
export const GREP_STATUS_MISMATCH = {
  command: 'npx tsc --noEmit 2>&1 | grep -c "error TS"',
  printedCount: "0",
  pipelineExitCode: 1,
} as const;

export function tmpProject(): { root: string; cwd: string; agentDir: string } {
  // Fixtures spell their root the way production resolves it: a Windows
  // runner's temp dir can be the 8.3 short path (`RUNNER~1`) while git and
  // realpathSync report the long form, which would make every fixture look
  // outside itself.
  const root = fs.realpathSync.native(
    fs.mkdtempSync(path.join(os.tmpdir(), "rv-test-")),
  );
  const cwd = path.join(root, "proj");
  const agentDir = path.join(root, "agent");
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(agentDir, { recursive: true });
  return { root, cwd, agentDir };
}

/**
 * Write a v1 `profiles.json` into a test agent dir (or a project `.pi`).
 *
 * Profile activation is session-scoped and file-backed, so a test that switches
 * profiles needs a real file: `ensureProfilesConfig` reads (and fingerprints)
 * it instead of the empty default config.
 */
export function writeProfilesJson(
  dir: string,
  profiles: Array<{
    name: string;
    roles?: Record<
      string,
      { provider: string; id: string; thinking?: string }
    >;
    defaultModel?: { provider: string; id: string; thinking?: string };
  }>,
): string {
  const file = path.join(dir, "profiles.json");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify(
      {
        version: 1,
        profiles: profiles.map((profile) => ({
          name: profile.name,
          description: "",
          roles: profile.roles ?? {},
          ...(profile.defaultModel
            ? { defaultModel: profile.defaultModel }
            : {}),
        })),
      },
      null,
      2,
    ),
  );
  return file;
}

/** Parse `provider/id` (optionally `provider/id(thinking)`) into a model ref. */
export function parseFakeModelLabel(label: string): {
  provider: string;
  id: string;
  thinking?: string;
} {
  const match = /^([^/]+)\/(.+?)(?:\((\w+)\))?$/.exec(label.trim());
  if (!match) return { provider: "builder", id: label.trim() || "fake-model" };
  return {
    provider: match[1]!,
    id: match[2]!,
    ...(match[3] ? { thinking: match[3] } : {}),
  };
}

export const HIGH_FINDING = {
  id: "F1",
  severity: 9,
  confidence: 85,
  category: "framework-alignment",
  file: "src/export/csv.ts",
  lineRange: "1",
  summary: "Plan ignored the Result<T,E> convention",
  rationale: "Every sibling exporter returns Result.",
  disposition: "accepted" as const,
};

// ── Fake reviewer SDK ────────────────────────────────────────────────

export interface FakeCapture {
  prompts: string[];
  followUps: string[];
  tools: Record<string, { execute: (...args: unknown[]) => Promise<unknown> }>;
  /** The `tools` allowlist the runtime passed to createAgentSession. */
  toolAllowlist: string[];
  /** Tool names the child session reports as enabled. */
  activeTools: string[];
  /** How many times the child's `abort()` was called. */
  aborts: number;
  unsubscribeCount: number;
  /** How many `createAgentSession` calls this SDK double served. */
  createCalls: number;
  /** How many times the wrapped session's `dispose()` ran. */
  disposeCount: number;
  /** How many times `subscribe()` was requested on the wrapped session. */
  subscribeCalls: number;
  /** Emit an arbitrary child-session event (provider-error scripts use this). */
  emit: (event: unknown) => void;
  /**
   * Model switches requested through the wrapped session's `setModel`.
   * Records the provider/id/thinking the runtime asked for so a test can
   * assert that a live switch happened without a restart.
   */
  setModelCalls: Array<{
    provider: string;
    id: string;
    thinking?: string;
  }>;
  /** The model/thinking the fake session currently runs on. */
  currentModel: { provider: string; id: string; thinking?: string } | undefined;
  /** The modelRef `createAgentSession` was asked to run (launch model). */
  createdWith: { provider: string; id: string; thinking?: string } | undefined;
}

/** Built-in tool names the SDK registers before the allowlist is applied. */
export const FAKE_BUILTIN_TOOLS = [
  "read",
  "grep",
  "find",
  "ls",
  "bash",
  "edit",
  "write",
];

/**
 * A fake SDK whose "model" invokes the real review tools.
 *
 * This exercises the genuine orchestration path — tool wiring, the round gate,
 * the pass 1 → pass 2 advance, the fallback on timeout, and teardown — without
 * a provider, a network call, or a real child session.
 *
 * It also reproduces the SDK behaviour that caused the "reviewer can never
 * submit" bug (see `reviewToolAllowlist`): `tools` is a GLOBAL allowlist applied
 * to built-in AND custom tools, and `getActiveToolNames()` reports the result.
 * Finishing a run emits `agent_settled`, exactly like a real session does after
 * its post-run continuations, so the runtime's settle detection is exercised.
 */
export function fakeSdk(script: {
  pass1?: (c: FakeCapture) => Promise<void>;
  pass2?: (c: FakeCapture) => Promise<void>;
  shouldThrowOnCreate?: boolean;
  /** Child runtime double handed out by ModelRuntime.create (default {}). */
  runtime?: unknown;
  /** Make the child's first prompt reject with this value (preflight-style). */
  failPrompt1?: unknown;
  /** Text the fake review_bash backend returns (used by shell-guard tests). */
  bashResultText?: string;
  /**
   * Report `isStreaming: true` while a pass script runs, so the runtime's
   * post-pass `abortChild()` path is exercised (default false preserves the
   * old fake-session behaviour).
   */
  streaming?: boolean;
  /**
   * Emit a terminal `agent_end` from `abort()`, reproducing the shape the SDK's
   * `lazyStream` setup path produces when a host abort lands before the next
   * provider request is created.
   */
  abortEnd?: { stopReason: "error" | "aborted"; errorMessage: string };
  /** Throw from the child's `setModel` (auth/registry/model failure). */
  setModelError?: unknown;
  /** Return undefined from the child's `modelRuntime.getModel` (unknown model). */
  registryModels?: boolean;
}): { capture: FakeCapture; sdk: unknown } {
  const capture: FakeCapture = {
    prompts: [],
    followUps: [],
    tools: {},
    toolAllowlist: [],
    activeTools: [],
    aborts: 0,
    unsubscribeCount: 0,
    createCalls: 0,
    disposeCount: 0,
    subscribeCalls: 0,
    emit: () => {},
    setModelCalls: [],
    currentModel: undefined,
    createdWith: undefined,
  };
  const sdk = {
    ModelRuntime: { create: async () => script.runtime ?? {} },
    DefaultResourceLoader: class {
      async reload() {}
    },
    SessionManager: { inMemory: () => ({}) },
    // Isolated sessions require in-memory settings; the fake mirrors the real
    // SDK surface so `createIsolatedSession`'s preflight passes.
    SettingsManager: { inMemory: () => ({}) },
    createBashToolDefinition: () => ({
      parameters: {},
      execute: async () => ({
        content: [
          { type: "text", text: script.bashResultText ?? "ok" },
        ],
        ...(script.bashResultText ? { isError: true } : {}),
      }),
    }),
    createAgentSession: async (opts: {
      tools?: string[];
      customTools?: Array<{ name: string }>;
      model?: { provider: string; id: string; thinking?: string };
      thinkingLevel?: string;
    }) => {
      if (script.shouldThrowOnCreate) throw new Error("session create failed");
      capture.createCalls += 1;
      capture.toolAllowlist = [...(opts.tools ?? [])];
      // The launch model is what the runtime asked for; `currentModel` starts
      // there and follows `setModel`, mirroring the real session's shape.
      const launchModel = opts.model
        ? {
            provider: opts.model.provider,
            id: opts.model.id,
            ...((opts.model.thinking ?? opts.thinkingLevel)
              ? { thinking: opts.model.thinking ?? opts.thinkingLevel }
              : {}),
          }
        : undefined;
      capture.createdWith = launchModel;
      capture.currentModel = launchModel;
      let thinkingLevel = opts.thinkingLevel ?? launchModel?.thinking ?? "off";
      for (const t of opts.customTools ?? []) {
        capture.tools[t.name] = t as never;
      }
      // Pi's real rule: only names in `tools` survive, built-in or custom.
      const allow = opts.tools ? new Set(opts.tools) : undefined;
      const registered = new Set<string>([
        ...FAKE_BUILTIN_TOOLS,
        ...Object.keys(capture.tools),
      ]);
      capture.activeTools = [...registered].filter(
        (n) => !allow || allow.has(n),
      );

      const listeners: Array<(event: unknown) => void> = [];
      const emit = (event: unknown): void => {
        for (const l of [...listeners]) l(event);
      };
      capture.emit = emit;
      // A getter, not a method: `wrapAgentSession()` reads
      // `Boolean(s.isStreaming)` on every call.
      let streaming = false;
      const beginPass = (): void => {
        streaming = script.streaming === true;
      };
      const endPass = (): void => {
        streaming = false;
        emit({ type: "agent_settled" });
      };
      return {
        session: {
          get isStreaming() {
            return streaming;
          },
          get model() {
            return capture.currentModel
              ? { ...capture.currentModel }
              : undefined;
          },
          get thinkingLevel() {
            return thinkingLevel;
          },
          // Mirrors the real AgentSession: resolve a registry model and
          // switch it, never aborting or disposing the session.
          modelRuntime: {
            getModel: (provider: string, id: string) =>
              script.registryModels === false
                ? undefined
                : { provider, id },
          },
          setModel: async (
            model: { provider: string; id: string },
            _options?: { persist?: boolean },
          ) => {
            if (script.setModelError !== undefined) {
              throw script.setModelError instanceof Error
                ? script.setModelError
                : new Error(String(script.setModelError));
            }
            capture.setModelCalls.push({
              provider: model.provider,
              id: model.id,
              ...(capture.currentModel?.thinking
                ? { thinking: capture.currentModel.thinking }
                : {}),
            });
            capture.currentModel = {
              provider: model.provider,
              id: model.id,
              ...(capture.currentModel?.thinking
                ? { thinking: capture.currentModel.thinking }
                : {}),
            };
            emit({ type: "model_select", model, source: "set" });
          },
          setThinkingLevel: (level: string) => {
            thinkingLevel = level;
            if (capture.currentModel) {
              capture.currentModel = { ...capture.currentModel, thinking: level };
            }
            // The wrapper applies thinking AFTER `setModel`; fold it into the
            // recorded switch so a test sees the requested level.
            const last = capture.setModelCalls.at(-1);
            if (last) last.thinking = level;
            emit({ type: "thinking_level_changed", level });
          },
          getSessionStats: () => ({
            tokens: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, total: 150 },
            cost: 0,
            contextUsage: {
              tokens: 150,
              contextWindow: 1000,
              percent: 15,
            },
          }),
          getContextUsage: () => ({
            tokens: 150,
            contextWindow: 1000,
            percent: 15,
          }),
          subscribe: (listener: (event: unknown) => void) => {
            capture.subscribeCalls += 1;
            capture.unsubscribeCount += 1;
            listeners.push(listener);
            return () => {
              const i = listeners.indexOf(listener);
              if (i >= 0) listeners.splice(i, 1);
            };
          },
          prompt: async (text: string) => {
            capture.prompts.push(text);
            if (script.failPrompt1 !== undefined) throw script.failPrompt1;
            beginPass();
            emit({
              type: "tool_execution_start",
              toolCallId: "t1",
              toolName: "read",
              args: { path: "plan.md" },
            });
            emit({
              type: "tool_execution_end",
              toolCallId: "t1",
              toolName: "read",
              isError: false,
            });
            emit({
              type: "message_update",
              assistantMessageEvent: {
                type: "text_delta",
                delta: "reviewing…\n",
              },
            });
            try {
              await script.pass1?.(capture);
            } finally {
              endPass();
            }
          },
          followUp: async (text: string) => {
            capture.followUps.push(text);
            beginPass();
            emit({
              type: "tool_execution_start",
              toolCallId: "t2",
              toolName: "grep",
              args: { pattern: "TODO" },
            });
            emit({
              type: "tool_execution_end",
              toolCallId: "t2",
              toolName: "grep",
              isError: false,
            });
            emit({
              type: "message_update",
              assistantMessageEvent: {
                type: "text_delta",
                delta: "verifying…\n",
              },
            });
            try {
              await script.pass2?.(capture);
            } finally {
              endPass();
            }
          },
          abort: async () => {
            capture.aborts += 1;
            streaming = false;
            if (!script.abortEnd) return;
            // The real SDK emits the terminal assistant message while
            // `abort()` is still settling (before it resolves). Reproduce that
            // ordering so the runtime's suppression is actually exercised;
            // `agent_settled` follows asynchronously in the real session.
            emit({
              type: "agent_end",
              messages: [
                {
                  role: "assistant",
                  content: [],
                  stopReason: script.abortEnd.stopReason,
                  errorMessage: script.abortEnd.errorMessage,
                },
              ],
            });
          },
          getActiveToolNames: () => capture.activeTools.slice(),
          bindExtensions: async () => {},
          dispose: () => {
            capture.disposeCount += 1;
            streaming = false;
            listeners.length = 0;
          },
        },
      };
    },
  };
  return { capture, sdk };
}

/**
 * Finish a review pass with the LIVE append-only submission protocol.
 *
 * `_plan` is intentionally unused: `review_submit` has no replacement-body
 * parameter (pinned by `review-append-only.test.ts`) — it appends findings and
 * required revisions to the plan file instead. Callers keep passing a label for
 * readability.
 */
export const submitThenFinish =
  (_plan: string) =>
  async (c: FakeCapture): Promise<void> => {
    await c.tools.review_submit.execute(
      "1",
      {
        findings: [HIGH_FINDING],
        verdict: "revise",
        summary: "review submitted",
        revisions: [
          { step: "1", change: "Apply the reviewer's required change." },
        ],
      },
      undefined,
      undefined,
      {},
    );
    await c.tools.review_pass_done.execute(
      "2",
      { pass: 1, verdict: "revise", findings: [HIGH_FINDING] },
      undefined,
      undefined,
      {},
    );
  };

export const submitThenFinishPass2 =
  (_plan: string) =>
  async (c: FakeCapture): Promise<void> => {
    await c.tools.review_submit.execute(
      "3",
      {
        findings: [],
        verdict: "approve",
        summary: "verified",
      },
      undefined,
      undefined,
      {},
    );
    await c.tools.review_pass_done.execute(
      "4",
      { pass: 2, verdict: "approve", findings: [] },
      undefined,
      undefined,
      {},
    );
  };

/** One scripted reviewer round (1-based `round`), run inside `fakeSdk.pass1`. */
export type ScriptedReviewRound = (
  capture: FakeCapture,
  round: number,
) => Promise<void>;

/**
 * Script a reviewer sequence, one submission per review round.
 *
 * `fakeSdk` calls `pass1` once per round, so the wrapper hands each call the
 * next script. The final script repeats if the loop reviews more rounds than
 * scripted — a reviewer that keeps raising the same notes. `round()` exposes
 * how many rounds ran so a test can assert the sequence, not just its output.
 */
export function scriptedReviewer(
  rounds: readonly ScriptedReviewRound[],
): {
  pass1: (capture: FakeCapture) => Promise<void>;
  round: () => number;
} {
  let current = 0;
  return {
    round: () => current,
    pass1: async (capture) => {
      const script = rounds[Math.min(current, rounds.length - 1)];
      current += 1;
      if (!script) {
        throw new Error("scriptedReviewer: at least one round is required");
      }
      await script(capture, current);
    },
  };
}

/** One review submission for `submitReviewRound`. */
export interface ScriptedReviewSubmission {
  verdict: "approve" | "revise" | "block";
  findings?: readonly unknown[];
  /** Required changes; `approve` must not carry any. */
  revisions?: ReadonlyArray<{
    id?: string;
    step?: string;
    change: string;
  }>;
  summary?: string;
}

/**
 * Submit one fake review round through the live append-only protocol:
 * `review_submit` then `review_pass_done` for pass 1.
 */
export async function submitReviewRound(
  capture: FakeCapture,
  submission: ScriptedReviewSubmission,
): Promise<void> {
  const findings = [...(submission.findings ?? [])];
  await capture.tools.review_submit.execute(
    "submit",
    {
      findings,
      verdict: submission.verdict,
      summary: submission.summary ?? `${submission.verdict} submission`,
      ...(submission.revisions ? { revisions: submission.revisions } : {}),
    },
    undefined,
    undefined,
    {},
  );
  await capture.tools.review_pass_done.execute(
    "done",
    { pass: 1, verdict: submission.verdict, findings },
    undefined,
    undefined,
    {},
  );
}

// ── Fake Pi host ─────────────────────────────────────────────────────

type EventHandler = (event: unknown, ctx: unknown) => unknown | Promise<unknown>;

/** Values `pi.getFlagValue()` can return for a registered flag. */
export type FlagValue = boolean | string | number | undefined;

/** Minimal shape of a tool definition captured from `registerTool`. */
export interface FakeTool {
  name?: string;
  execute: (...args: unknown[]) => unknown;
}

export interface FakePi {
  handlers: Map<string, EventHandler[]>;
  commands: Record<
    string,
    {
      description?: string;
      handler: Function;
      getArgumentCompletions?: (prefix: string) => unknown;
    }
  >;
  shortcuts: Record<string, { description?: string; handler: Function }>;
  tools: Record<string, FakeTool>;
  entries: Array<{ type: string; data: unknown }>;
  sent: Array<{ content: unknown; options?: unknown }>;
  /** Ordered side effects used to pin transition ordering (tools, sends). */
  timeline: Array<
    | { kind: "tools"; tools: string[] }
    | { kind: "send"; content: unknown }
  >;
  activeTools: string[];
  model: unknown;
  on(event: string, handler: EventHandler): void;
  registerCommand(name: string, opts: { description?: string; handler: Function }): void;
  registerTool(def: unknown): void;
  registerShortcut(key: unknown, opts: unknown): void;
  registerFlag(name: string, opts: unknown): void;
  registerEntryRenderer(): void;
  registerMessageRenderer(): void;
  registerMarkdownTransformer(): void;
  appendEntry(type: string, data: unknown): void;
  getActiveTools(): string[];
  setActiveTools(tools: string[]): void;
  getAllTools(): unknown[];
  getFlagValue(name: string): FlagValue;
  setModel(model: unknown): void;
  sendMessage(content: unknown, options?: unknown): void;
  sendUserMessage(content: unknown, options?: unknown): void;
  exec(
    command: string,
    args?: string[],
    options?: { cwd?: string; signal?: AbortSignal },
  ): Promise<{ stdout: string; stderr: string; code: number }>;
  events: {
    on(
      event: string,
      handler: (payload: unknown) => unknown,
    ): () => void;
    emit(event: string, payload?: unknown): void;
    listenerCount(event?: string): number;
  };
  /** Fire every handler registered for an event, in registration order. */
  emit(event: string, payload?: unknown, ctx?: unknown): Promise<unknown[]>;
}

export function makeFakePi(over: { activeTools?: string[] } = {}): FakePi {
  const handlers = new Map<string, EventHandler[]>();
  const busHandlers = new Map<string, Array<(payload: unknown) => unknown>>();
  const commands: FakePi["commands"] = {};
  const shortcuts: FakePi["shortcuts"] = {};
  const tools: FakePi["tools"] = {};
  const entries: FakePi["entries"] = [];
  const sent: FakePi["sent"] = [];
  const timeline: FakePi["timeline"] = [];
  const pi: FakePi = {
    handlers,
    commands,
    shortcuts,
    tools,
    entries,
    sent,
    timeline,
    activeTools: over.activeTools ?? ["read", "write", "edit", "bash"],
    model: undefined,
    on(event, handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    registerCommand(name, opts) {
      commands[name] = opts;
    },
    registerTool(def: unknown) {
      const tool = def as FakeTool;
      if (tool?.name) tools[tool.name] = tool;
    },
    registerShortcut(key, opts) {
      shortcuts[String(key)] = opts as { description?: string; handler: Function };
    },
    registerFlag() {},
    registerEntryRenderer() {},
    registerMessageRenderer() {},
    registerMarkdownTransformer() {},
    appendEntry(type, data) {
      entries.push({ type, data });
    },
    getActiveTools() {
      return [...pi.activeTools];
    },
    setActiveTools(tools) {
      pi.activeTools = [...tools];
      timeline.push({ kind: "tools", tools: [...tools] });
    },
    getAllTools() {
      return [];
    },
    getFlagValue() {
      return undefined;
    },
    setModel(model) {
      pi.model = model;
    },
    sendMessage(content, options) {
      sent.push({ content, options });
      timeline.push({ kind: "send", content });
    },
    sendUserMessage(content, options) {
      sent.push({ content, options });
      timeline.push({ kind: "send", content });
    },
    // Checkpoints, `/rewind` and `/commit` shell out to git through `pi.exec`.
    // Run it for real so a temp repo/empty dir behaves like the host does
    // (a missing repo must fail closed, not report a fabricated success).
    exec(command, args = [], options) {
      return promisify(execFile)(command, args, {
        maxBuffer: 4 * 1024 * 1024,
        ...(options?.cwd ? { cwd: options.cwd } : {}),
        ...(options?.signal ? { signal: options.signal } : {}),
      })
        .then(({ stdout, stderr }) => ({ stdout, stderr, code: 0 }))
        .catch((error: { stdout?: string; stderr?: string; code?: number | string }) => ({
          stdout: String(error?.stdout ?? ""),
          stderr: String(error?.stderr ?? ""),
          code: typeof error?.code === "number" ? error.code : 1,
        }));
    },
    events: {
      on(event, handler) {
        const list = busHandlers.get(event) ?? [];
        list.push(handler);
        busHandlers.set(event, list);
        // Mirror the SDK EventBus: `on` returns the unsubscribe for the
        // handler, so an extension can own its listener lifetime.
        return () => {
          const live = busHandlers.get(event);
          if (!live) return;
          const index = live.indexOf(handler);
          if (index === -1) return;
          live.splice(index, 1);
          if (live.length === 0) busHandlers.delete(event);
        };
      },
      emit(event, payload) {
        for (const handler of busHandlers.get(event) ?? []) {
          try {
            void handler(payload);
          } catch {
            /* listener failures must not break the fake host */
          }
        }
      },
      listenerCount(event) {
        return event === undefined
          ? [...busHandlers.values()].reduce((n, list) => n + list.length, 0)
          : (busHandlers.get(event)?.length ?? 0);
      },
    },
    async emit(event, payload = {}, ctx) {
      const list = handlers.get(event) ?? [];
      const results: unknown[] = [];
      for (const handler of list) {
        results.push(await handler(payload, ctx));
      }
      return results;
    },
  };
  return pi;
}

// ── Boundary / provider-turn harness ─────────────────────────────────

export interface BoundaryRunOptions {
  outcome?: "completed" | "aborted" | "error";
  messages?: unknown[];
  entries?: unknown[];
  pendingMessages?: unknown[];
  contextEntries?: unknown[];
  contextMessages?: unknown[];
  llmMessages?: unknown[];
  canContinue?: boolean;
}

export interface BoundaryRunResult {
  entries: unknown[];
  continue: boolean;
  context: {
    contextEntries: unknown[];
    contextMessages: unknown[];
    llmMessages: unknown[];
    pendingMessages: unknown[];
    canContinue: boolean;
  };
  results: unknown[];
}

/**
 * Drive one Pi `agent_before_settle` boundary with real chaining semantics:
 * each handler sees prior entries and the current continuation decision.
 * This is the missing piece that a plain `pi.emit()` cannot model.
 */
export async function runBoundary(
  pi: FakePi,
  ctx: unknown,
  over: BoundaryRunOptions = {},
): Promise<BoundaryRunResult> {
  let entries = [...(over.entries ?? [])];
  let continueRequested = false;
  const context = {
    contextEntries: [...(over.contextEntries ?? [])],
    contextMessages: [...(over.contextMessages ?? [])],
    llmMessages: [...(over.llmMessages ?? [])],
    pendingMessages: [...(over.pendingMessages ?? [])],
    canContinue: over.canContinue ?? true,
  };
  const results: unknown[] = [];
  for (const handler of pi.handlers.get("agent_before_settle") ?? []) {
    const event = {
      type: "agent_before_settle",
      entries: [...entries],
      continue: continueRequested,
      context,
      outcome: over.outcome ?? "completed",
      messages: over.messages ?? [],
    };
    const result = (await handler(event, ctx)) as
      | { entries?: unknown[]; continue?: boolean }
      | undefined;
    if (result?.entries) entries = [...result.entries];
    if (result?.continue !== undefined) continueRequested = result.continue;
    results.push(result);
  }
  return { entries, continue: continueRequested, context, results };
}

/**
 * Drive successive synthetic provider turns. A turn stops early when the
 * boundary does not request continuation. This models the real lifecycle
 * without a network provider or a real child session.
 */
export async function driveBoundaryTurns(
  pi: FakePi,
  ctx: unknown,
  turns: BoundaryRunOptions[],
): Promise<BoundaryRunResult[]> {
  const out: BoundaryRunResult[] = [];
  for (const turn of turns) {
    const result = await runBoundary(pi, ctx, turn);
    out.push(result);
    if (!result.continue) break;
  }
  return out;
}

// ── Fake extension context ───────────────────────────────────────────

export interface FakeCtxOptions {
  cwd: string;
  hasUI?: boolean;
  branch?: unknown[];
  selectAnswer?: string | undefined;
  /** Per-dialog answers, consumed in order before falling back to selectAnswer. */
  selectAnswers?: Array<string | undefined>;
  /** Value returned by `ui.custom` (native handoff questionnaire result). */
  customAnswer?: unknown;
  /**
   * Sequential `ui.custom` answers. The handoff now has TWO stages (plan
   * approval, then execution), so a test that answers both supplies them in
   * order. When exhausted, `customAnswer` is used.
   */
  customAnswers?: unknown[];
  /** Value returned by `ui.editor` (e.g. the inline Refine text). */
  editorAnswer?: string | null;
  /** Value returned by `ui.confirm` (default true). */
  confirmAnswer?: boolean;
  modelRegistry?: { find?: (provider: string, id: string) => unknown };
  /** Fake `ctx.settings` (e.g. `{ packages: [...] }`) for detection tests. */
  settings?: Record<string, unknown>;
  signal?: AbortSignal;
  /** Project-local settings trust (default true for existing fixtures). */
  projectTrusted?: boolean;
  /**
   * `ctx.isIdle()` — false while an agent run owns the session (the automatic
   * review runs inside `agent_end`). Defaults to true.
   */
  idle?: boolean;
  /** `ctx.hasPendingMessages()` at boot (queued continuation guard). */
  pendingMessages?: boolean;
  /** `ctx.sessionManager.getSessionId()` (child teardown registry key). */
  sessionId?: string;
}
export function makeFakeCtx(over: FakeCtxOptions) {
  const notifies: Array<{ message: string; level?: string }> = [];
  /** `ctx.navigateTree` calls (rewind moves the conversation branch). */
  const navigations: Array<{ id: string; options?: unknown }> = [];
  const statuses: unknown[] = [];
  const statusCalls: Array<{ key: string; value: unknown }> = [];
  const widgets: unknown[] = [];
  const widgetCalls: Array<{
    key: string;
    value: unknown;
    options?: unknown;
  }> = [];
  const confirms: Array<{ title: string; message: string }> = [];
  const selects: Array<{ title: string; options: unknown[] }> = [];
  /** One entry per `ctx.ui.custom` call (the native handoff modal). */
  const customs: Array<{ options?: unknown }> = [];
  /** Every factory passed to `ui.setEditorComponent` (last one is active). */
  const editorFactories: Array<
    (tui: unknown, theme: unknown, keybindings: unknown) => unknown
  > = [];
  /** Editor instances created by tests through the captured factory. */
  const editors: unknown[] = [];
  const fakeTui = {
    requestRender() {
      /* no-op */
    },
  };
  const fakeKeybindings = {
    matches(data: string, keybinding: string): boolean {
      return keybinding === "tui.input.tab" && data === "\t";
    },
    getKeys(keybinding: string): string[] {
      return keybinding === "tui.input.tab" ? ["tab"] : [];
    },
  };
  const fakeTheme = {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
    strikethrough: (text: string) => text,
    borderColor: (text: string) => text,
    selectList: {},
  };
  // A test can flip this to model a run that is still active (automatic
  // review) versus an idle session (manual `/review`).
  let idle = over.idle !== false;
  const workingMessages: Array<string | undefined> = [];
  const workingVisible: boolean[] = [];
  let aborts = 0;
  // Models a run that still has queued messages / a pending continuation.
  let pendingMessages = over.pendingMessages === true;
  const ctx = {
    cwd: over.cwd,
    mode: "tui",
    hasUI: over.hasUI === true,
    signal: over.signal,
    isIdle: () => idle,
    hasPendingMessages: () => pendingMessages,
    abort: () => {
      aborts += 1;
    },
    isProjectTrusted: () => over.projectTrusted !== false,
    modelRegistry: over.modelRegistry ?? {
      find: (provider: string, id: string) => ({ provider, id }),
    },
    settings: over.settings ?? {},
    sessionManager: {
      getSessionId: () => over.sessionId ?? "fake-session",
      getBranch: () => over.branch ?? [],
      buildContextEntries: () => over.branch ?? [],
      getLeafEntry: () => (over.branch ?? []).at(-1),
    },
    async navigateTree(id: string, options?: unknown) {
      navigations.push({ id, options });
    },
    ui: {
      async select(title: string, options: unknown[]) {
        selects.push({ title, options });
        if (over.selectAnswers && over.selectAnswers.length > 0) {
          return over.selectAnswers.shift();
        }
        return over.selectAnswer;
      },
      async custom(_factory?: unknown, options?: unknown) {
        customs.push({ options });
        if (over.customAnswers && over.customAnswers.length > 0) {
          return over.customAnswers.shift();
        }
        return over.customAnswer ?? null;
      },
      async editor() {
        return over.editorAnswer;
      },
      async input() {
        return undefined;
      },
      async confirm(title: string, message: string) {
        confirms.push({ title, message });
        return over.confirmAnswer !== false;
      },
      notify(message: string, level?: string) {
        notifies.push({ message, level });
      },
      setStatus(key: string, value: unknown) {
        statuses.push(value);
        statusCalls.push({ key, value });
      },
      setWidget(key: string, value: unknown, options?: unknown) {
        widgets.push(value);
        widgetCalls.push({ key, value, options });
      },
      setWorkingMessage(message: string | undefined) {
        workingMessages.push(message);
      },
      setWorkingVisible(visible: boolean) {
        workingVisible.push(visible);
      },
      setEditorComponent(
        factory?: (tui: unknown, theme: unknown, keybindings: unknown) => unknown,
      ) {
        if (typeof factory === "function") editorFactories.push(factory);
        else editorFactories.length = 0;
      },
      getEditorComponent() {
        return editorFactories.at(-1);
      },
      getEditorText() {
        return "";
      },
      theme: fakeTheme,
    },
  };
  return {
    ctx,
    notifies,
    statuses,
    statusCalls,
    widgets,
    widgetCalls,
    workingMessages,
    workingVisible,
    /** Flip `ctx.isIdle()` for a test that needs an active run. */
    setIdle(value: boolean) {
      idle = value;
    },
    /** Flip `ctx.hasPendingMessages()` for a queued-continuation test. */
    setPendingMessages(value: boolean) {
      pendingMessages = value;
    },
    /** Count `ctx.abort()` calls (shell guard trips). */
    aborts: () => aborts,
    confirms,
    selects,
    customs,
    navigations,
    editorFactories,
    /** Instantiate the active editor factory the way the host would. */
    createEditor(): WorkflowTabEditor | undefined {
      const factory = editorFactories.at(-1);
      if (!factory) return undefined;
      const editor = factory(fakeTui, fakeTheme, fakeKeybindings);
      void editors;
      return editor as WorkflowTabEditor;
    },
  };
}

/** Visible text without SGR color/reset sequences. */
export function stripAnsi(text: string): string {
  return String(text).replace(/\x1b\[[0-9;]*m/g, "");
}

/**
 * Render the latest `workflow-review-status` widget. Returns `[]` when the
 * widget is cleared (hidden) or was never mounted. The value is a plain string
 * array by design (see `setWorkflowWidget`).
 */
export function renderReviewWidget(
  widgetCalls: Array<{ key: string; value: unknown; options?: unknown }>,
): string[] {
  const call = [...widgetCalls]
    .reverse()
    .find((entry) => entry.key === "workflow-review-status");
  if (!call || call.value === undefined) return [];
  return Array.isArray(call.value) ? (call.value as string[]) : [];
}

/**
 * Latest `ctx.ui.setStatus` text for one key (undefined when never set).
 *
 * Statuses are strings by contract; a non-string value is mangled for display
 * rather than leaking `unknown` into assertions.
 */
export function latestStatus(
  statusCalls: Array<{ key: string; value: unknown }>,
  key: string,
): string | undefined {
  const call = [...statusCalls].reverse().find((entry) => entry.key === key);
  const value = call?.value;
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value;
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

/**
 * Render the latest `workflow-todos` widget with a plain theme. Returns `[]`
 * when the widget is cleared (hidden) or was never mounted.
 */
export function renderTodoWidget(
  widgetCalls: Array<{ key: string; value: unknown; options?: unknown }>,
  width = 80,
  theme?: { fg(color: string, text: string): string; bold(text: string): string; strikethrough(text: string): string },
): string[] {
  const call = [...widgetCalls]
    .reverse()
    .find((entry) => entry.key === "workflow-todos");
  if (!call || call.value === undefined) return [];
  if (typeof call.value !== "function") {
    return Array.isArray(call.value) ? (call.value as string[]) : [];
  }
  const component = (call.value as Function)({}, theme ?? {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
    strikethrough: (text: string) => text,
  });
  const rows = component?.render?.(width);
  return Array.isArray(rows) ? (rows as string[]) : [];
}

// ── Fake in-process Orchestrator Build child ────────────────────────
//
// The real child is a second SDK session. These tests only need the lifecycle
// surface the controller drives, so the fake exposes exactly that and lets a
// test choose when (and whether) it settles.

export interface FakeOrchestratorChildSession {
  readonly sessionId: string;
  readonly modelLabel: string;
  subscribe(listener: (event: unknown) => void): () => void;
  prompt(text: string): Promise<void>;
  followUp(text: string): Promise<void>;
  abort(): Promise<void>;
  isStreaming(): boolean;
  dispose(): void;
  /** Test control: emit one event to the subscribers. */
  emit(event: unknown): void;
  /** Test control: emit a summary, todo list and settle. */
  settle(summary?: string): void;
  /** Test control: resolve a `holdPrompt` prompt. */
  finishPrompt(): void;
  /** Test control: resolve a `holdAbort` abort. */
  releaseAbort(): void;
  /** Test control: a full prompt → tool events → settle. */
  settleOnPrompt: boolean;
  /** How many `prompt()` calls the session received. */
  promptCalls: number;
  /** How many `dispose()` calls the session received. */
  disposeCalls: number;
  /** Model switches requested through `setModel` (live-switch assertions). */
  setModelCalls: Array<{
    provider: string;
    id: string;
    thinking?: string;
  }>;
  /** The child's actual model; follows `setModel`, else the launch label. */
  currentModel(): { provider: string; id: string; thinking?: string } | undefined;
  /** Switch the fake child's model without restarting it. */
  setModel(
    provider: string,
    id: string,
    thinking?: string,
  ): Promise<{ ok: true } | { ok: false; error: string }>;
  /** Runtime stats the parent reads through the widened handle. */
  stats(): {
    model?: { provider: string; id: string; thinking?: string };
    tokens?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; total?: number };
    context?: { tokens: number | null; contextWindow: number; percent: number | null };
  } | undefined;
}

export interface FakeOrchestratorChildOptions {
  modelLabel?: string;
  /** Structured launch model (defaults parsed from `modelLabel`). */
  modelRef?: { provider: string; id: string; thinking?: string };
  failCreate?: string;
  /** Emit a summary + settle as soon as the kickoff prompt arrives. */
  settleOnPrompt?: boolean;
  /** Called for every prompt, before the default settle behaviour. */
  onPrompt?: (
    text: string,
    session: FakeOrchestratorChildSession,
  ) => Promise<void> | void;
  /** Todos mirrored from a workflow_todo tool result on settle. */
  todos?: Array<{
    text: string;
    completed?: boolean;
    status?: "pending" | "in_progress" | "completed" | "cancelled";
  }>;
  summary?: string;
  /** Values the fake `stats()` reports (defaults are a small sample). */
  stats?: {
    tokens?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; total?: number };
    context?: { tokens: number | null; contextWindow: number; percent: number | null };
  };
  /** Reject `setModel` with this value (switch-failure assertions). */
  setModelError?: unknown;
  /** Emit an assistant `message_end` with usage from `settle()`. */
  usageOnSettle?: boolean;
  /**
   * Hold `prompt()` until the test calls `session.finishPrompt()`. Models a
   * Builder that is still thinking so pause/resume races are deterministic.
   */
  holdPrompt?: boolean;
  /** Hold `abort()` until the test calls `session.releaseAbort()`. */
  holdAbort?: boolean;
}

export interface FakeOrchestratorChildFactory {
  factory: (input: {
    context: { taskId: string; attemptId: string };
    sessionId?: string;
  }) => Promise<
    | { ok: true; child: FakeOrchestratorChildSession; modelLabel: string }
    | { ok: false; error: string }
  >;
  created: FakeOrchestratorChildSession[];
  /** How many factory (child create) attempts were served. */
  startCount: number;
  /** The `modelRef` each factory call was asked to launch with. */
  modelRefs: Array<{ provider: string; id: string; thinking?: string }>;
}

/** Emit the settle sequence (usage → todos → summary → settled). */
function emitFakeSettle(
  options: FakeOrchestratorChildOptions,
  emit: (event: unknown) => void,
  summary: string | undefined,
): void {
  if (options.usageOnSettle === true) {
    emit({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: summary ?? options.summary ?? "done" }],
        usage: {
          input: options.stats?.tokens?.input ?? 120,
          output: options.stats?.tokens?.output ?? 40,
          cacheRead: 0,
          cacheWrite: 0,
        },
      },
    });
  }
  if (options.todos && options.todos.length > 0) {
    emit({
      type: "tool_execution_end",
      toolCallId: "c2",
      toolName: "workflow_todo",
      result: {
        details: {
          todos: options.todos.map((todo, index) => {
            const status =
              todo.status ?? (todo.completed ? "completed" : "pending");
            return {
              step: index + 1,
              text: todo.text,
              status,
              completed: status === "completed",
            };
          }),
        },
      },
    });
  }
  emit({
    type: "agent_end",
    messages: [
      {
        role: "assistant",
        content: [
          {
            type: "text",
            text: summary ?? options.summary ?? "child finished the row",
          },
        ],
      },
    ],
  });
  emit({ type: "agent_settled" });
}

/** The fake child's runtime stats, with the same shape the real handle reports. */
function buildFakeChildStats(
  options: FakeOrchestratorChildOptions,
  current: { provider: string; id: string; thinking?: string },
) {
  return {
    model: { ...current },
    tokens: {
      input: options.stats?.tokens?.input ?? 100,
      output: options.stats?.tokens?.output ?? 50,
      cacheRead: options.stats?.tokens?.cacheRead ?? 0,
      cacheWrite: options.stats?.tokens?.cacheWrite ?? 0,
      total: options.stats?.tokens?.total ?? 150,
    },
    context: options.stats?.context ?? {
      tokens: 150,
      contextWindow: 1000,
      percent: 15,
    },
  };
}

/**
 * Build one fake child session. Extracted from the factory so the factory
 * itself stays a thin creation/capture shim (and readable).
 */
function buildFakeOrchestratorSession(
  options: FakeOrchestratorChildOptions,
  input: {
    context: { taskId: string; attemptId: string };
    sessionId?: string;
    modelRef?: { provider: string; id: string; thinking?: string };
  },
): { session: FakeOrchestratorChildSession; modelLabel: string } {
  const listeners: Array<(event: unknown) => void> = [];
  let streaming = false;
  let disposed = false;
  let promptResolve: (() => void) | undefined;
  let abortResolve: (() => void) | undefined;
  const launchModel =
    options.modelRef ??
    (input.modelRef
      ? { ...input.modelRef }
      : parseFakeModelLabel(options.modelLabel ?? "builder/fake-model"));
  const modelLabel =
    options.modelLabel ?? `${launchModel.provider}/${launchModel.id}`;
  let current = { ...launchModel };
  const emit = (event: unknown): void => {
    if (disposed) return;
    for (const listener of [...listeners]) listener(event);
  };
  const session: FakeOrchestratorChildSession = {
    sessionId: input.sessionId ?? "fake-session",
    modelLabel,
    subscribe(listener) {
      listeners.push(listener);
      return () => {
        const index = listeners.indexOf(listener);
        if (index >= 0) listeners.splice(index, 1);
      };
    },
    async prompt(text) {
      if (disposed) return;
      session.promptCalls += 1;
      if (options.onPrompt) await options.onPrompt(text, session);
      streaming = true;
      emit({
        type: "tool_execution_start",
        toolCallId: "c1",
        toolName: "read",
        args: { path: "README.md" },
      });
      emit({ type: "tool_execution_end", toolCallId: "c1", toolName: "read" });
      if (options.holdPrompt === true) {
        await new Promise<void>((resolve) => {
          promptResolve = resolve;
        });
      }
      if (options.settleOnPrompt === true) {
        streaming = false;
        session.settle();
      }
    },
    async followUp(text) {
      await session.prompt(text);
    },
    async abort() {
      if (options.holdAbort === true) {
        await new Promise<void>((resolve) => {
          abortResolve = resolve;
        });
      }
      streaming = false;
    },
    isStreaming() {
      return streaming;
    },
    dispose() {
      session.disposeCalls += 1;
      disposed = true;
      streaming = false;
      listeners.length = 0;
    },
    emit,
    settle(summary) {
      streaming = false;
      emitFakeSettle(options, emit, summary);
    },
    finishPrompt() {
      const resolve = promptResolve;
      promptResolve = undefined;
      resolve?.();
    },
    releaseAbort() {
      const resolve = abortResolve;
      abortResolve = undefined;
      resolve?.();
    },
    settleOnPrompt: options.settleOnPrompt === true,
    promptCalls: 0,
    disposeCalls: 0,
    setModelCalls: [],
    currentModel: () => ({ ...current }),
    async setModel(provider, id, thinking) {
      if (options.setModelError !== undefined) {
        return {
          ok: false,
          error:
            options.setModelError instanceof Error
              ? options.setModelError.message
              : String(options.setModelError),
        };
      }
      session.setModelCalls.push({
        provider,
        id,
        ...(thinking ? { thinking } : {}),
      });
      const nextThinking = thinking ?? current.thinking;
      current = {
        provider,
        id,
        ...(nextThinking ? { thinking: nextThinking } : {}),
      };
      // `SwitchChildModelResult` promises the applied model, and the controller
      // publishes its label from it. Returning a bare `{ ok: true }` made every
      // live switch look like a failure (the error surfaced only as a warning).
      return { ok: true, model: { ...current } };
    },
    stats() {
      return buildFakeChildStats(options, current);
    },
  };
  return { session, modelLabel };
}

export function makeFakeOrchestratorChildFactory(
  options: FakeOrchestratorChildOptions = {},
): FakeOrchestratorChildFactory {
  const created: FakeOrchestratorChildSession[] = [];
  const modelRefs: Array<{ provider: string; id: string; thinking?: string }> =
    [];
  let startCount = 0;
  const factory: FakeOrchestratorChildFactory["factory"] = async (input) => {
    startCount += 1;
    const requested = (
      input as { modelRef?: { provider: string; id: string; thinking?: string } }
    ).modelRef;
    if (requested) modelRefs.push({ ...requested });
    if (options.failCreate) return { ok: false, error: options.failCreate };
    const { session, modelLabel } = buildFakeOrchestratorSession(options, {
      ...input,
      ...(requested ? { modelRef: requested } : {}),
    });
    created.push(session);
    return { ok: true, child: session, modelLabel };
  };
  return {
    factory,
    created,
    modelRefs,
    get startCount() {
      return startCount;
    },
  };
}
