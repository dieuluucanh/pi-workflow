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

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

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

export function tmpProject(): { root: string; cwd: string; agentDir: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rv-test-"));
  const cwd = path.join(root, "proj");
  const agentDir = path.join(root, "agent");
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(agentDir, { recursive: true });
  return { root, cwd, agentDir };
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
  /** Emit an arbitrary child-session event (provider-error scripts use this). */
  emit: (event: unknown) => void;
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
}): { capture: FakeCapture; sdk: unknown } {
  const capture: FakeCapture = {
    prompts: [],
    followUps: [],
    tools: {},
    toolAllowlist: [],
    activeTools: [],
    aborts: 0,
    unsubscribeCount: 0,
    emit: () => {},
  };
  const sdk = {
    ModelRuntime: { create: async () => script.runtime ?? {} },
    DefaultResourceLoader: class {
      async reload() {}
    },
    SessionManager: { inMemory: () => ({}) },
    createBashToolDefinition: () => ({
      parameters: {},
      execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
    }),
    createAgentSession: async (opts: {
      tools?: string[];
      customTools?: Array<{ name: string }>;
    }) => {
      if (script.shouldThrowOnCreate) throw new Error("session create failed");
      capture.toolAllowlist = [...(opts.tools ?? [])];
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
          subscribe: (listener: (event: unknown) => void) => {
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
        },
      };
    },
  };
  return { capture, sdk };
}

export const submitThenFinish =
  (plan: string) =>
  async (c: FakeCapture): Promise<void> => {
    await c.tools.review_submit_plan.execute(
      "1",
      {
        planMarkdown: plan,
        findings: [HIGH_FINDING],
        verdict: "revise",
        summary: "aligned",
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
  (plan: string) =>
  async (c: FakeCapture): Promise<void> => {
    await c.tools.review_submit_plan.execute(
      "3",
      {
        planMarkdown: plan,
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
  events: {
    on(event: string, handler: (payload: unknown) => unknown): void;
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
    events: {
      on(event, handler) {
        const list = busHandlers.get(event) ?? [];
        list.push(handler);
        busHandlers.set(event, list);
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

// ── Fake extension context ───────────────────────────────────────────

export interface FakeCtxOptions {
  cwd: string;
  hasUI?: boolean;
  branch?: unknown[];
  selectAnswer?: string | undefined;
  /** Per-dialog answers, consumed in order before falling back to selectAnswer. */
  selectAnswers?: Array<string | undefined>;
  /** Value returned by `ui.custom` (the inline handoff choice). */
  customAnswer?: string | null;
  /** Value returned by `ui.editor` (e.g. the inline Refine text). */
  editorAnswer?: string | null;
  /** Value returned by `ui.confirm` (default true). */
  confirmAnswer?: boolean;
  modelRegistry?: { find?: (provider: string, id: string) => unknown };
  signal?: AbortSignal;
  /** Project-local settings trust (default true for existing fixtures). */
  projectTrusted?: boolean;
}

export function makeFakeCtx(over: FakeCtxOptions) {
  const notifies: Array<{ message: string; level?: string }> = [];
  const statuses: unknown[] = [];
  const widgets: unknown[] = [];
  const widgetCalls: Array<{
    key: string;
    value: unknown;
    options?: unknown;
  }> = [];
  const confirms: Array<{ title: string; message: string }> = [];
  const selects: Array<{ title: string; options: unknown[] }> = [];
  const ctx = {
    cwd: over.cwd,
    mode: "tui",
    hasUI: over.hasUI === true,
    signal: over.signal,
    isProjectTrusted: () => over.projectTrusted !== false,
    modelRegistry: over.modelRegistry ?? {
      find: (provider: string, id: string) => ({ provider, id }),
    },
    settings: {},
    sessionManager: {
      getBranch: () => over.branch ?? [],
      buildContextEntries: () => over.branch ?? [],
    },
    ui: {
      async select(title: string, options: unknown[]) {
        selects.push({ title, options });
        if (over.selectAnswers && over.selectAnswers.length > 0) {
          return over.selectAnswers.shift();
        }
        return over.selectAnswer;
      },
      async custom() {
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
      setStatus(_key: string, value: unknown) {
        statuses.push(value);
      },
      setWidget(key: string, value: unknown, options?: unknown) {
        widgets.push(value);
        widgetCalls.push({ key, value, options });
      },
      setEditorComponent() {},
      getEditorText() {
        return "";
      },
      theme: {
        fg: (_color: string, text: string) => text,
        strikethrough: (text: string) => text,
      },
    },
  };
  return {
    ctx,
    notifies,
    statuses,
    widgets,
    widgetCalls,
    confirms,
    selects,
  };
}

/** Visible text without SGR color/reset sequences. */
export function stripAnsi(text: string): string {
  return String(text).replace(/\x1b\[[0-9;]*m/g, "");
}

/**
 * Render the latest `workflow-todos` widget with a plain theme. Returns `[]`
 * when the widget is cleared (hidden) or was never mounted.
 */
export function renderTodoWidget(
  widgetCalls: Array<{ key: string; value: unknown; options?: unknown }>,
  width = 80,
): string[] {
  const call = [...widgetCalls]
    .reverse()
    .find((entry) => entry.key === "workflow-todos");
  if (!call || call.value === undefined) return [];
  if (typeof call.value !== "function") {
    return Array.isArray(call.value) ? (call.value as string[]) : [];
  }
  const component = (call.value as Function)({}, {
    fg: (_color: string, text: string) => text,
    strikethrough: (text: string) => text,
  });
  const rows = component?.render?.(width);
  return Array.isArray(rows) ? (rows as string[]) : [];
}
