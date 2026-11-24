/**
 * Orchestrator / related-session parity seams (Workflow plan step 33).
 *
 * These are the parts of the current in-process contract that had no dedicated
 * test: the Builder model/source bootstrap, the exact child tool allowlist, the
 * dispatch lifecycle (duplicate launch, stale launch, host/provider failure,
 * pause/resume/abort/close) and the child-visibility projection.
 *
 * Everything here is hermetic and fake-port based. The real staged artifact and
 * the authenticated Desktop related-session bridge are exercised separately
 * (`tests/host/workflow-artifact-parity.test.ts` in Desktop); live provider and
 * visible-terminal acceptance remains **NOT RUN** in
 * `docs/orchestrator-live-acceptance.md`. A fixture pass here is not live
 * acceptance.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  createOrchestratorChildController,
  type OrchestratorChildController,
  type OrchestratorChildState,
} from "./orchestrator-child-controller.ts";
import { orchestratorChildTools } from "./orchestrator-child-session.ts";
import {
  formatOrchestratorChildBand,
  formatOrchestratorChildStatus,
  type OrchestratorChildBandData,
} from "./orchestrator-child-view.ts";
import { resolveModelPlan } from "./orchestrator-model-plan.ts";
import type { InProcessChildSession } from "./in-process-child.ts";

// ── Fakes ─────────────────────────────────────────────────────────────

interface FakeChild extends InProcessChildSession {
  emit(event: unknown): void;
  disposed: number;
  aborted: number;
  prompts: string[];
}

function fakeChild(id = "child-session-1"): FakeChild {
  let listener: ((event: unknown) => void) | undefined;
  let disposed = 0;
  const child: FakeChild = {
    sessionId: id,
    modelLabel: "pi/builder-model",
    disposed: 0,
    aborted: 0,
    prompts: [],
    subscribe(next) {
      listener = next;
      return () => {
        listener = undefined;
      };
    },
    async prompt(text) {
      child.prompts.push(text);
    },
    async followUp() {
      /* no-op */
    },
    async abort() {
      child.aborted += 1;
    },
    isStreaming() {
      return false;
    },
    dispose() {
      disposed += 1;
      child.disposed = disposed;
    },
    emit(event) {
      listener?.(event);
    },
  };
  return child;
}

const START = {
  taskId: "task-1",
  attemptId: "attempt-1",
  ref: "1",
  total: 2,
  sessionId: "sdk-session",
};

function binding() {
  const children: FakeChild[] = [];
  const settles: Array<{ taskId: string; attemptId: string }> = [];
  const errors: Array<{ taskId: string; attemptId: string; error: string }> = [];
  const aborted: Array<{ taskId: string; attemptId: string; reason: string }> = [];
  const states: OrchestratorChildState[] = [];
  let createCalls = 0;
  let createResult: () => Promise<{
    ok: boolean;
    child?: FakeChild;
    modelLabel?: string;
    error?: string;
  }> = async () => {
    const child = fakeChild(`child-${children.length + 1}`);
    children.push(child);
    return { ok: true, child, modelLabel: child.modelLabel };
  };
  const controller: OrchestratorChildController = createOrchestratorChildController({
    create: async () => {
      createCalls += 1;
      return createResult();
    },
    buildPrompt: (input) =>
      `row ${input.ref}/${input.total} ${input.taskId}${input.repair ? ` repair:${input.repair}` : ""}`,
    timeoutMs: 60_000,
    onSettled: (event) => {
      settles.push({ taskId: event.taskId, attemptId: event.attemptId });
    },
    onError: (event) => {
      errors.push(event);
    },
    onAborted: (event) => {
      aborted.push(event);
    },
    onState: (state) => {
      states.push(state);
    },
  });
  return {
    controller,
    children,
    settles,
    errors,
    aborted,
    states,
    createCalls: () => createCalls,
    setCreate(next: typeof createResult) {
      createResult = next;
    },
  };
}

// ── Source/model bootstrap ────────────────────────────────────────────

test("the Builder role wins the bootstrap, including its thinking level", () => {
  const plan = resolveModelPlan({
    role: "builder",
    roleName: "Builder",
    roleModel: { provider: "open", id: "builder-model", thinking: "high" },
    fallbackModel: { provider: "pi", id: "main-model", contextWindow: 10, maxOutputTokens: 2 },
  });
  assert.equal(plan.ok, true);
  if (!plan.ok) return;
  assert.deepEqual(plan.launch, {
    provider: "open",
    id: "builder-model",
    thinking: "high",
  });
});

test("a missing role provider falls back to the session model instead of an empty provider", () => {
  // The historical dispatch bug: `provider: ""` won and the child never
  // bootstrapped. An incomplete role must not win.
  const plan = resolveModelPlan({
    role: "builder",
    roleName: "Builder",
    roleModel: { provider: "", id: "stale" },
    fallbackModel: { provider: "pi", id: "main-model", contextWindow: 64, maxOutputTokens: 8 },
  });
  assert.equal(plan.ok, true);
  if (!plan.ok) return;
  assert.deepEqual(plan.launch, { provider: "pi", id: "main-model" });
});

test("the session model never borrows the Builder's thinking level", () => {
  const plan = resolveModelPlan({
    role: "orchestrator",
    roleName: "Orchestrator",
    roleModel: null,
    fallbackModel: { provider: "pi", id: "main-model", contextWindow: 64, maxOutputTokens: 8 },
  });
  assert.equal(plan.ok, true);
  if (!plan.ok) return;
  assert.equal("thinking" in plan.launch, false);
});

test("no role and no session model refuses before anything is dispatched", () => {
  const plan = resolveModelPlan({
    role: "builder",
    roleName: "Builder",
    roleModel: { provider: "", id: "" },
    fallbackModel: null,
  });
  assert.equal(plan.ok, false);
  if (plan.ok) return;
  assert.equal(plan.code, "no_model");
  assert.match(plan.error, /Builder model is required/);
});

// ── Child authority boundary ──────────────────────────────────────────

test("the child tool allowlist can never orchestrate or arm the parent questionnaire", () => {
  const tools = orchestratorChildTools([
    "orchestrator_start",
    "orchestrator_status",
    "orchestrator_retry",
    "questionnaire",
    "read",
    "my-extension-tool",
  ]);
  for (const required of [
    "read",
    "bash",
    "edit",
    "write",
    "grep",
    "find",
    "ls",
    "workflow_todo",
    "explore",
  ]) {
    assert.ok(tools.includes(required), `child keeps ${required}`);
  }
  assert.ok(tools.includes("my-extension-tool"), "non-owning extra tools stay");
  assert.equal(tools.includes("questionnaire"), false);
  assert.equal(
    tools.filter((name) => name.startsWith("orchestrator_")).length,
    0,
    "a child may never start its own orchestration",
  );
  assert.equal(new Set(tools).size, tools.length, "the list is deduped");
});

// ── Dispatch lifecycle ────────────────────────────────────────────────

test("a duplicate launch while a child is active creates nothing twice", async () => {
  const b = binding();
  const first = await b.controller.start(START);
  assert.equal(first.ok, true);
  assert.equal(b.createCalls(), 1);
  assert.equal(b.children.length, 1);

  const second = await b.controller.start({ ...START, attemptId: "attempt-2" });
  assert.equal(second.ok, false);
  assert.match(second.error ?? "", /already active/);
  assert.equal(b.createCalls(), 1, "no second child session was created");
  assert.equal(b.children.length, 1);
});

test("a stale launch is refused and its half-created child is disposed", async () => {
  const b = binding();
  let resolveCreate:
    | ((value: {
        ok: boolean;
        child?: FakeChild;
        modelLabel?: string;
        error?: string;
      }) => void)
    | undefined;
  b.setCreate(
    () =>
      new Promise((resolve) => {
        resolveCreate = resolve;
      }),
  );
  const started = b.controller.start(START);
  // A reload/abort/navigation supersedes the in-flight launch.
  await b.controller.dispose();
  const late = fakeChild("late-child");
  resolveCreate?.({ ok: true, child: late, modelLabel: late.modelLabel });
  const result = await started;
  assert.equal(result.ok, false);
  assert.equal(result.error, "superseded");
  assert.equal(late.disposed, 1, "the orphaned session is released");
  assert.equal(b.states.at(-1)?.phase, "disposed");
});

test("a host/provider failure is reported honestly and never settles as success", async () => {
  const b = binding();
  b.setCreate(async () => ({
    ok: false,
    error: "Builder provider open is not configured: nothing was dispatched.",
  }));
  const result = await b.controller.start(START);
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /nothing was dispatched/);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(b.settles.length, 0, "no settle/report is journaled");
  assert.equal(b.errors.length, 1);
  assert.equal(b.errors[0]?.taskId, "task-1");
  assert.equal(b.errors[0]?.attemptId, "attempt-1");
  assert.equal(b.controller.state().phase, "disposed");
});

test("interrupt, resume and close control the warm child exactly once", async () => {
  const b = binding();
  assert.equal((await b.controller.start(START)).ok, true);
  const child = b.children[0]!;

  assert.equal(await b.controller.pause(), true);
  assert.equal(child.aborted, 1);
  assert.equal(b.controller.state().phase, "paused");

  const queued = await b.controller.deliver("also cover the stale grant");
  assert.deepEqual(queued, { ok: true, queued: true });

  assert.equal(await b.controller.resume(), true);
  assert.equal(b.controller.state().phase, "running");
  assert.match(child.prompts.at(-1) ?? "", /stale grant/);

  child.emit({ type: "agent_end", messages: [{ role: "assistant", content: "done" }] });
  child.emit({ type: "agent_settled" });
  assert.equal(b.settles.length, 1);
  assert.equal(b.settles[0]?.attemptId, "attempt-1");
  child.emit({ type: "agent_settled" });
  assert.equal(b.settles.length, 1, "a duplicate settle is ignored");

  await b.controller.abort("user aborted");
  assert.equal(b.aborted.length, 1);
  assert.equal(b.aborted[0]?.reason, "user aborted");
  assert.equal(b.controller.state().phase, "disposed");
});

test("prose is refused when no child runs and never starts a parent turn", async () => {
  const b = binding();
  const refused = await b.controller.deliver("hello");
  assert.equal(refused.ok, false);
  assert.match(refused.error ?? "", /no running child/);
  assert.equal(b.createCalls(), 0, "no session was created by a prose send");
});

// ── Child visibility (display-only projection) ────────────────────────

test("child visibility is a bounded display projection with no context injection", () => {
  assert.equal(formatOrchestratorChildStatus(undefined), "");
  assert.equal(
    formatOrchestratorChildStatus({ phase: "idle", todos: [] }),
    "",
  );
  const running = formatOrchestratorChildStatus({
    phase: "running",
    ref: "2",
    total: 3,
    lastTool: "edit",
    todos: [
      { step: 1, text: "a", completed: true },
      { step: 2, text: "b", completed: false },
    ],
  });
  assert.equal(running, "child 2/3 · edit · 1/2 todos");
  assert.equal(
    formatOrchestratorChildStatus({ phase: "paused", ref: "1", total: 2, todos: [] }),
    "⏸ child 1/2 paused",
  );

  const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
  const detail = "x".repeat(300);
  const band: OrchestratorChildBandData = {
    runId: "run-1",
    taskId: "task-2",
    ref: "2",
    total: 3,
    phase: "start",
    model: "pi/builder-model",
    detail,
  };
  const line = formatOrchestratorChildBand(band, theme).join("\n");
  assert.match(line, /BUILD CHILD/);
  assert.match(line, /2\/3 · task-2 · pi\/builder-model/);
  assert.ok(line.includes("x".repeat(200)), "detail is kept up to the bound");
  assert.equal(line.includes("x".repeat(201)), false, "detail is truncated");
  assert.deepEqual(formatOrchestratorChildBand(undefined, theme), []);
});
