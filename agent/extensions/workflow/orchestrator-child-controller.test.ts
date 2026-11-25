/**
 * Workflow Extension — Orchestrator child controller.
 *
 * The controller owns one in-process Build child: start/settle/pause/resume and
 * now live model switching + telemetry. These tests pin the parts that are easy
 * to get subtly wrong:
 *
 *   - a `/profile`-driven switch reaches a RUNNING child and never disposes it;
 *   - a switch refused by the SDK/auth keeps the child and the row untouched;
 *   - a switch that raced `prepare()` is reconciled before the first prompt,
 *     and a refused prepared switch is replaced by a fresh child;
 *   - resume does not prompt until an in-flight switch has finished;
 *   - pause freezes elapsed and settle still publishes stats.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createOrchestratorChildController,
  type ChildSettledInput,
  type CreateChildInput,
  type OrchestratorChildOp,
  type OrchestratorChildState,
} from "./orchestrator-child-controller.ts";
import type { InProcessChildSession } from "./in-process-child.ts";
import type { ChildModelRef } from "./child-stats.ts";

interface FakeChildOptions {
  model?: ChildModelRef;
  /** Undefined means "this session cannot switch models". */
  setModel?: (
    provider: string,
    id: string,
    thinking?: string,
  ) => Promise<{ ok: true; model: ChildModelRef } | { ok: false; error: string }>;
  stats?: {
    model?: ChildModelRef;
    tokens?: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
    context?: { tokens: number | null; contextWindow: number; percent: number | null };
  };
}

function makeChild(options: FakeChildOptions = {}) {
  const calls = {
    prompts: [] as string[],
    aborts: 0,
    disposes: 0,
    setModels: [] as Array<{ provider: string; id: string; thinking?: string }>,
  };
  const listeners: Array<(event: unknown) => void> = [];
  let streaming = false;
  let disposed = false;
  let model: ChildModelRef | undefined = options.model
    ? { ...options.model }
    : undefined;
  const child: InProcessChildSession = {
    sessionId: "fake-session",
    get modelLabel() {
      return model ? `${model.provider}/${model.id}` : "fake/model";
    },
    subscribe(listener) {
      listeners.push(listener);
      return () => {
        const i = listeners.indexOf(listener);
        if (i >= 0) listeners.splice(i, 1);
      };
    },
    async prompt(text) {
      calls.prompts.push(text);
      streaming = true;
    },
    async followUp(text) {
      calls.prompts.push(text);
    },
    async abort() {
      calls.aborts += 1;
      streaming = false;
    },
    isStreaming() {
      return streaming && !disposed;
    },
    dispose() {
      calls.disposes += 1;
      disposed = true;
      streaming = false;
      listeners.length = 0;
    },
    currentModel() {
      return model ? { ...model } : undefined;
    },
    stats() {
      if (!options.stats) return model ? { model: { ...model } } : undefined;
      return {
        ...(options.stats.model ? { model: { ...options.stats.model } } : {}),
        ...(options.stats.tokens ? { tokens: { ...options.stats.tokens } } : {}),
        ...(options.stats.context ? { context: { ...options.stats.context } } : {}),
      };
    },
  };
  if (options.setModel) {
    child.setModel = async (provider, id, thinking) => {
      calls.setModels.push({ provider, id, ...(thinking ? { thinking } : {}) });
      const result = await options.setModel!(provider, id, thinking);
      if (result.ok) model = { ...result.model };
      return result;
    };
  }
  return {
    child,
    calls,
    emit: (event: unknown) => {
      for (const listener of [...listeners]) listener(event);
    },
    setStreaming: (value: boolean) => {
      streaming = value;
    },
  };
}

const BASE = {
  sessionId: "s1",
  taskId: "task-1",
  attemptId: "a1",
  ref: "1",
  total: 1,
};

/** A controller whose ports are all no-ops; tests override what they need. */
function makeController(over: {
  create?: () => Promise<{
    ok: boolean;
    child?: InProcessChildSession;
    modelLabel?: string;
    error?: string;
  }>;
  desiredModel?: () => { provider: string; id: string; thinking?: string } | undefined;
  onSettled?: (input: ChildSettledInput) => void | Promise<void>;
  settleReportTimeoutMs?: number;
} = {}) {
  const states: OrchestratorChildState[] = [];
  const ops: Array<{ kind: string; text: string }> = [];
  const settled: unknown[] = [];
  const errors: string[] = [];
  let creates = 0;
  const controller = createOrchestratorChildController({
    create: async () => {
      creates += 1;
      return over.create ? over.create() : (() => {
        const fake = makeChild();
        return { ok: true, child: fake.child, modelLabel: "fake/model" };
      })();
    },
    buildPrompt: () => "kickoff",
    onState: (state: OrchestratorChildState) => states.push(state),
    onOps: (list: OrchestratorChildOp[]) =>
      ops.push(...list.map((op) => ({ kind: op.kind, text: op.text }))),
    onSettled: (input: ChildSettledInput) => {
      settled.push(input);
      return over.onSettled?.(input);
    },
    onError: ({ error }: { error: string }) => {
      errors.push(error);
    },
    ...(over.desiredModel ? { desiredModel: over.desiredModel } : {}),
    ...(over.settleReportTimeoutMs === undefined
      ? {}
      : { settleReportTimeoutMs: over.settleReportTimeoutMs }),
    now: () => 1_000,
  } as never);
  return {
    controller,
    states,
    ops,
    settled,
    errors,
    creates: () => creates,
  };
}

test("controller: a live switch reaches a RUNNING child without disposing it", async () => {
  const fake = makeChild({
    model: { provider: "old", id: "m", thinking: "low" },
    setModel: async (provider, id, thinking) => ({
      ok: true,
      model: { provider, id, ...(thinking ? { thinking } : {}) },
    }),
  });
  const { controller, states, ops } = makeController({
    create: async () => ({ ok: true, child: fake.child, modelLabel: "old/m" }),
  });
  await controller.start(BASE);
  const result = await controller.applyModel({
    provider: "new",
    id: "m2",
    thinking: "high",
  });
  assert.equal(result.ok, true);
  assert.equal(result.changed, true);
  assert.deepEqual(fake.calls.setModels, [
    { provider: "new", id: "m2", thinking: "high" },
  ]);
  assert.equal(fake.calls.disposes, 0, "a switch never disposes the child");
  assert.equal(fake.calls.aborts, 0, "a switch never aborts the child");
  assert.equal(controller.state().phase, "running");
  assert.equal(controller.state().modelLabel, "new/m2");
  assert.equal(controller.state().thinking, "high");
  assert.ok(
    ops.some((op) => op.text.includes("model → new/m2 (high)")),
    "the transcript records the switch",
  );
  assert.equal(states.at(-1)?.modelLabel, "new/m2");
});

test("controller: switching to the same model is a no-op", async () => {
  const fake = makeChild({
    model: { provider: "open", id: "m", thinking: "high" },
    setModel: async (provider, id, thinking) => ({
      ok: true,
      model: { provider, id, ...(thinking ? { thinking } : {}) },
    }),
  });
  const { controller } = makeController({
    create: async () => ({ ok: true, child: fake.child, modelLabel: "open/m" }),
  });
  await controller.start(BASE);
  const result = await controller.applyModel({
    provider: "open",
    id: "m",
    thinking: "high",
  });
  assert.equal(result.ok, true);
  assert.equal(result.changed, false);
  assert.equal(fake.calls.setModels.length, 0);
});

test("controller: a refused switch keeps the child and reports the error", async () => {
  const fake = makeChild({
    model: { provider: "old", id: "m" },
    setModel: async () => ({ ok: false, error: "No API key for provider" }),
  });
  const { controller } = makeController({
    create: async () => ({ ok: true, child: fake.child, modelLabel: "old/m" }),
  });
  await controller.start(BASE);
  const result = await controller.applyModel({ provider: "new", id: "m2" });
  assert.equal(result.ok, false);
  assert.match(String(result.error), /No API key/);
  assert.equal(controller.state().phase, "running", "the row is not blocked");
  assert.equal(controller.state().modelLabel, "old/m");
  assert.equal(fake.calls.disposes, 0);
});

test("controller: an unsupported session refuses the switch by name", async () => {
  const fake = makeChild({ model: { provider: "old", id: "m" } });
  const { controller } = makeController({
    create: async () => ({ ok: true, child: fake.child, modelLabel: "old/m" }),
  });
  await controller.start(BASE);
  const result = await controller.applyModel({ provider: "new", id: "m2" });
  assert.equal(result.ok, false);
  assert.match(String(result.error), /cannot switch models/);
});

test("controller: applyModel with no child is a clean refusal", async () => {
  const { controller } = makeController();
  const result = await controller.applyModel({ provider: "new", id: "m2" });
  assert.equal(result.ok, false);
  assert.match(String(result.error), /no child is active/);
});

test("controller: a finishing child is not switched", async () => {
  const fake = makeChild({ model: { provider: "old", id: "m" } });
  const { controller } = makeController({
    create: async () => ({ ok: true, child: fake.child, modelLabel: "old/m" }),
  });
  await controller.start(BASE);
  fake.emit({ type: "agent_settled" });
  const result = await controller.applyModel({ provider: "new", id: "m2" });
  assert.equal(result.ok, false);
  assert.match(String(result.error), /finishing/);
});

test("controller: a switch that raced prepare() is applied before the first prompt", async () => {
  const fake = makeChild({
    model: { provider: "old", id: "m" },
    setModel: async (provider, id, thinking) => ({
      ok: true,
      model: { provider, id, ...(thinking ? { thinking } : {}) },
    }),
  });
  const { controller, creates } = makeController({
    create: async () => ({ ok: true, child: fake.child, modelLabel: "old/m" }),
    desiredModel: () => ({ provider: "new", id: "m2", thinking: "high" }),
  });
  await controller.prepare(BASE);
  // The profile switched between prepare() and start().
  const started = await controller.start(BASE);
  assert.equal(started.ok, true);
  assert.deepEqual(fake.calls.setModels, [
    { provider: "new", id: "m2", thinking: "high" },
  ]);
  assert.equal(creates(), 1, "the prepared child was reused, not recreated");
  assert.equal(fake.calls.prompts.length, 1);
  assert.equal(controller.state().modelLabel, "new/m2");
});

test("controller: a refused prepared switch falls back to a fresh child", async () => {
  const first = makeChild({
    model: { provider: "old", id: "m" },
    setModel: async () => ({ ok: false, error: "not in the child registry" }),
  });
  const second = makeChild({ model: { provider: "new", id: "m2" } });
  let created = 0;
  const { controller } = makeController({
    create: async () => {
      created += 1;
      return created === 1
        ? { ok: true, child: first.child, modelLabel: "old/m" }
        : { ok: true, child: second.child, modelLabel: "new/m2" };
    },
    desiredModel: () => ({ provider: "new", id: "m2" }),
  });
  await controller.prepare(BASE);
  const started = await controller.start(BASE);
  assert.equal(started.ok, true);
  assert.equal(created, 2, "a refused prepared switch is replaced");
  assert.equal(first.calls.disposes, 1, "the unusable prepared child is released");
  assert.equal(second.calls.prompts.length, 1);
  assert.equal(controller.state().modelLabel, "new/m2");
});

test("controller: resume waits for an in-flight switch before prompting", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fake = makeChild({
    model: { provider: "old", id: "m" },
    setModel: async (provider, id, thinking) => {
      await gate;
      return { ok: true, model: { provider, id, ...(thinking ? { thinking } : {}) } };
    },
  });
  // The desired model changes AFTER the child started: otherwise `start()`
  // would reconcile into the same gated switch and never reach the test body.
  let desired: { provider: string; id: string; thinking?: string } | undefined;
  const { controller } = makeController({
    create: async () => ({ ok: true, child: fake.child, modelLabel: "old/m" }),
    desiredModel: () => desired,
  });
  await controller.start(BASE);
  await controller.pause();
  assert.equal(controller.state().pausedAt, 1_000, "pause freezes elapsed");

  desired = { provider: "new", id: "m2" };
  const switching = controller.applyModel({ provider: "new", id: "m2" });
  const resuming = controller.resume();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(
    fake.calls.prompts.length,
    1,
    "resume must not prompt while the switch is still in flight",
  );

  release();
  await switching;
  assert.equal(await resuming, true);
  assert.equal(fake.calls.prompts.length, 2, "the resume prompt lands after the switch");
  assert.equal(controller.state().pausedAt, undefined);
  assert.equal(controller.state().phase, "running");
});

test("controller: pause freezes elapsed and resume clears it", async () => {
  const fake = makeChild({ model: { provider: "open", id: "m" } });
  const { controller } = makeController({
    create: async () => ({ ok: true, child: fake.child, modelLabel: "open/m" }),
  });
  await controller.start(BASE);
  assert.equal(controller.state().pausedAt, undefined);
  await controller.pause();
  assert.equal(controller.state().phase, "paused");
  assert.equal(controller.state().pausedAt, 1_000);
  assert.equal(await controller.resume(), true);
  assert.equal(controller.state().pausedAt, undefined);
});

test("controller: settle publishes the child's stats", async () => {
  const fake = makeChild({
    model: { provider: "open", id: "m", thinking: "high" },
    stats: {
      model: { provider: "open", id: "m", thinking: "high" },
      tokens: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, total: 150 },
      context: { tokens: 1_000, contextWindow: 200_000, percent: 0.5 },
    },
  });
  const { controller, states, settled } = makeController({
    create: async () => ({ ok: true, child: fake.child, modelLabel: "open/m" }),
  });
  await controller.start(BASE);
  fake.emit({ type: "message_end", message: { role: "assistant", content: [] } });
  const withStats = states.filter((state) => state.stats !== undefined);
  assert.ok(withStats.length > 0, "stats are published");
  const last = withStats.at(-1)!;
  assert.equal(last.stats?.context?.percent, 0.5);
  assert.equal(last.stats?.tokens?.total, 150);
  assert.equal(last.thinking, "high");

  fake.emit({ type: "agent_settled" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(settled.length, 1, "settle still runs");
  assert.equal(
    controller.state().phase,
    "idle",
    "a settled child is released, not left in settling",
  );
  assert.equal(fake.calls.disposes, 1, "the settled session is disposed");
});

test("controller: the settle event carries the final todos and policy refusals", async () => {
  const fake = makeChild({ model: { provider: "open", id: "m" } });
  const { controller, settled } = makeController({
    create: async () => ({ ok: true, child: fake.child, modelLabel: "open/m" }),
  });
  await controller.start(BASE);
  fake.emit({
    type: "tool_execution_end",
    toolName: "workflow_todo",
    isError: false,
    result: {
      details: {
        todos: [
          { step: 1, text: "Write the change", status: "completed" },
          {
            step: 2,
            text: "Commit (blocked: commitPolicy=never)",
            status: "cancelled",
          },
        ],
      },
    },
  });
  fake.emit({
    type: "tool_execution_end",
    toolName: "bash",
    isError: true,
    result: {
      content: [
        {
          type: "text",
          text: "Commit policy is 'never' (workflow.commitPolicy): `git add` is blocked.",
        },
      ],
    },
  });
  fake.emit({ type: "agent_end", messages: [{ role: "assistant", content: "done" }] });
  fake.emit({ type: "agent_settled" });
  await new Promise((resolve) => setTimeout(resolve, 5));

  const input = settled[0] as ChildSettledInput;
  assert.equal(input.todos.length, 2);
  assert.equal(input.todos[1]?.status, "cancelled");
  assert.equal(input.policyRefusals.length, 1);
  assert.match(input.policyRefusals[0] ?? "", /Commit policy is 'never'/);
});

test("controller: a hung settle report fails, releases and never wedges settling", async () => {
  const fake = makeChild();
  const { controller, errors } = makeController({
    create: async () => ({ ok: true, child: fake.child, modelLabel: "fake/model" }),
    settleReportTimeoutMs: 20,
    onSettled: () => new Promise<void>(() => {}),
  });
  await controller.start(BASE);
  fake.emit({ type: "agent_settled" });
  assert.equal(controller.state().phase, "settling");
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(controller.state().phase, "disposed");
  assert.equal(errors.length, 1);
  assert.match(errors[0] ?? "", /report was not recorded/);
  assert.equal(fake.calls.disposes, 1);
});

test("controller: stats are not republished when nothing changed", async () => {
  let reads = 0;
  const fake = makeChild({
    model: { provider: "open", id: "m" },
    stats: {
      model: { provider: "open", id: "m" },
      context: { tokens: 10, contextWindow: 100, percent: 10 },
    },
  });
  const original = fake.child.stats!;
  fake.child.stats = () => {
    reads += 1;
    return original();
  };
  const { controller, states } = makeController({
    create: async () => ({ ok: true, child: fake.child, modelLabel: "open/m" }),
  });
  await controller.start(BASE);
  const before = states.length;
  fake.emit({ type: "entry_appended", entry: { type: "message" } });
  fake.emit({ type: "entry_appended", entry: { type: "message" } });
  fake.emit({ type: "entry_appended", entry: { type: "message" } });
  assert.ok(reads >= 3, "the child is probed on each boundary");
  assert.equal(
    states.length - before,
    0,
    "an unchanged stats snapshot is not republished",
  );
});

// ── Pause/resume safety (deferred child, repeated Esc) ───────────────

interface DeferredChild {
  sessionId: string;
  modelLabel: string;
  promptCalls: number;
  abortCalls: number;
  disposeCalls: number;
  subscribe(listener: (event: unknown) => void): () => void;
  prompt(text: string): Promise<void>;
  followUp(text: string): Promise<void>;
  abort(): Promise<void>;
  isStreaming(): boolean;
  dispose(): void;
  emit(event: unknown): void;
  finishPrompt(): void;
  releaseAbort(): void;
  rejectPrompt(error: Error): void;
}

function makeDeferredChild(holdAbort = false): DeferredChild {
  const listeners = new Set<(event: unknown) => void>();
  let promptResolve: (() => void) | undefined;
  let promptReject: ((error: Error) => void) | undefined;
  let abortResolve: (() => void) | undefined;
  let disposed = false;
  const child: DeferredChild = {
    sessionId: "fake-session",
    modelLabel: "builder/fake",
    promptCalls: 0,
    abortCalls: 0,
    disposeCalls: 0,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    prompt() {
      child.promptCalls += 1;
      return new Promise<void>((resolve, reject) => {
        promptResolve = resolve;
        promptReject = reject;
      });
    },
    async followUp() {
      await child.prompt("");
    },
    abort() {
      child.abortCalls += 1;
      if (!holdAbort) return Promise.resolve();
      return new Promise<void>((resolve) => {
        abortResolve = resolve;
      });
    },
    isStreaming() {
      return !disposed;
    },
    dispose() {
      child.disposeCalls += 1;
      disposed = true;
      listeners.clear();
    },
    emit(event) {
      for (const listener of [...listeners]) listener(event);
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
    rejectPrompt(error) {
      const reject = promptReject;
      promptReject = undefined;
      reject?.(error);
    },
  };
  return child;
}

function makeDeferredHarness(options: { timeoutMs?: number; createDeferred?: boolean; holdAbort?: boolean } = {}) {
  const child = makeDeferredChild(options.holdAbort === true);
  const states: OrchestratorChildState[] = [];
  const errors: string[] = [];
  const aborted: string[] = [];
  let settled = 0;
  let create: ((value: { ok: true; child: DeferredChild; modelLabel: string }) => void) | undefined;
  const controller = createOrchestratorChildController({
    create: (_input: CreateChildInput) => {
      if (options.createDeferred === true) {
        return new Promise((resolve) => {
          create = resolve as never;
        });
      }
      return Promise.resolve({ ok: true, child, modelLabel: child.modelLabel });
    },
    buildPrompt: () => "do the row",
    onState: (state) => states.push(state),
    onError: ({ error }) => {
      errors.push(error);
    },
    onAborted: ({ reason }) => {
      aborted.push(reason);
    },
    onSettled: () => {
      settled += 1;
    },
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
  return {
    controller,
    child,
    states,
    errors,
    aborted,
    settled: () => settled,
    resolveCreate() {
      create?.({ ok: true, child, modelLabel: child.modelLabel });
    },
  };
}

async function waitForDeferred(predicate: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${label}`);
}

const deferredStartInput: CreateChildInput = {
  sessionId: "session-1",
  taskId: "task-1",
  attemptId: "attempt-1",
  ref: "1",
  total: 3,
};

test("repeated pause aborts once and keeps the warm child", async () => {
  const h = makeDeferredHarness();
  const running = h.controller.start(deferredStartInput);
  await waitForDeferred(() => h.controller.state().phase === "running", "running");

  const first = h.controller.pause();
  const second = await h.controller.pause();
  assert.equal(second, false, "a pause already owns the invocation");
  assert.equal(await first, true);
  assert.equal(h.child.abortCalls, 1);
  assert.equal(h.child.disposeCalls, 0);
  assert.equal(h.controller.state().phase, "paused");
  assert.equal(h.controller.state().pausePending, false);

  // A late settlement from the paused run must not settle the row.
  h.child.emit({ type: "agent_settled" });
  assert.equal(h.settled(), 0);
  assert.deepEqual(h.errors, []);
  assert.deepEqual(h.aborted, []);
  assert.equal(h.child.disposeCalls, 0);
  h.child.finishPrompt();
  await running;
});

test("a paused child is not failed by the old execution deadline", async () => {
  const h = makeDeferredHarness({ timeoutMs: 60 });
  const running = h.controller.start(deferredStartInput);
  await waitForDeferred(() => h.controller.state().phase === "running", "running");
  await h.controller.pause();
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(h.controller.state().phase, "paused");
  assert.deepEqual(h.errors, []);
  assert.equal(h.child.disposeCalls, 0);
  h.child.finishPrompt();
  await running;
});

test("a pause during child creation never prompts or leaks the session", async () => {
  const h = makeDeferredHarness({ createDeferred: true });
  const running = h.controller.start(deferredStartInput);
  await waitForDeferred(() => h.controller.state().phase === "starting", "starting");
  assert.equal(await h.controller.pause(), true);
  h.resolveCreate();
  await running;
  assert.equal(h.child.promptCalls, 0);
  assert.equal(h.child.disposeCalls, 0);
  assert.equal(h.controller.state().phase, "paused");
});

test("a paused prompt rejection is not reported as a child failure", async () => {
  const h = makeDeferredHarness();
  const running = h.controller.start(deferredStartInput);
  await waitForDeferred(() => h.controller.state().phase === "running", "running");
  await h.controller.pause();
  h.child.rejectPrompt(new Error("aborted by pause"));
  await new Promise((resolve) => setTimeout(resolve, 5));
  const result = await running;
  assert.equal(result.ok, true);
  assert.deepEqual(h.errors, []);
  assert.equal(h.child.disposeCalls, 0);
});

test("start is a short admission and returns while the prompt is held", async () => {
  const h = makeDeferredHarness();
  const result = await h.controller.start(deferredStartInput);
  assert.equal(result.ok, true);
  assert.equal(h.controller.state().phase, "running");
  assert.equal(h.child.promptCalls, 1);
  h.child.finishPrompt();
  await new Promise((resolve) => setTimeout(resolve, 5));
});

test("a prompt rejection after admission reports one failure and releases", async () => {
  const h = makeDeferredHarness();
  const result = await h.controller.start(deferredStartInput);
  assert.equal(result.ok, true);
  h.child.rejectPrompt(new Error("network down"));
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(h.errors.length, 1);
  assert.match(h.errors[0] ?? "", /network down/);
  assert.equal(h.controller.state().phase, "disposed");
  assert.equal(h.child.disposeCalls, 1);
});

test("resume is a short admission and waits for pause settlement", async () => {
  const h = makeDeferredHarness({ holdAbort: true });
  const running = h.controller.start(deferredStartInput);
  await waitForDeferred(() => h.controller.state().phase === "running", "running");

  const pausing = h.controller.pause();
  await waitForDeferred(() => h.controller.state().phase === "paused", "paused");
  const resuming = h.controller.resume();
  // The resume must not prompt before the abort settles.
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(h.child.promptCalls, 1);

  h.child.releaseAbort();
  await pausing;
  assert.equal(await resuming, true);
  assert.equal(h.child.promptCalls, 2, "resume started exactly one new prompt");
  assert.equal(h.controller.state().phase, "running");
  assert.equal(h.child.disposeCalls, 0);

  // Admission returns while the resumed prompt is still pending.
  h.child.emit({ type: "agent_settled" });
  assert.equal(h.settled(), 1);
  // The original (pre-pause) prompt intentionally stays pending: the fake
  // abort does not reject it, exactly like an SDK abort that settles the run.
  void running;
});

test("a resumed child can be paused again without escalating", async () => {
  const h = makeDeferredHarness();
  const running = h.controller.start(deferredStartInput);
  await waitForDeferred(() => h.controller.state().phase === "running", "running");
  await h.controller.pause();
  h.child.emit({ type: "agent_settled" });
  assert.equal(await h.controller.resume(), true);
  await waitForDeferred(() => h.controller.state().phase === "running", "resumed");

  assert.equal(await h.controller.pause(), true);
  assert.equal(h.child.abortCalls, 2);
  assert.equal(h.child.disposeCalls, 0);
  assert.deepEqual(h.aborted, []);
  void running;
});

test("a provider retry is visible without failing the row", async () => {
  const h = makeDeferredHarness();
  const running = h.controller.start(deferredStartInput);
  await waitForDeferred(() => h.controller.state().phase === "running", "running");
  h.child.emit({ type: "auto_retry_start", errorMessage: "429" });
  assert.equal(h.controller.state().retrying, true);
  assert.equal(h.controller.state().phase, "running");
  h.child.emit({ type: "auto_retry_end", success: true });
  assert.equal(h.controller.state().retrying, false);
  assert.deepEqual(h.errors, []);
  h.child.finishPrompt();
  await running;
});

test("an explicit abort still reports the destructive callback once", async () => {
  const h = makeDeferredHarness();
  const running = h.controller.start(deferredStartInput);
  await waitForDeferred(() => h.controller.state().phase === "running", "running");
  await h.controller.abort("user abort");
  assert.equal(h.child.abortCalls, 1);
  assert.equal(h.child.disposeCalls, 1);
  assert.deepEqual(h.aborted, ["user abort"]);
  assert.equal(h.controller.state().phase, "disposed");
  h.child.finishPrompt();
  await running;
});
