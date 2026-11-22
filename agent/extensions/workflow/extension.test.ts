/**
 * Extension-level regression tests for manual `/review` and the handoff gate.
 *
 * These drive the REAL extension factory and event handlers with a fake Pi
 * host and a fake reviewer SDK. No provider, network or real child session is
 * involved. The scenarios are the 2026-10-31 bug report:
 *
 *   A. a plan written in Default mode, then `/plan`, then `/review`
 *   B. a mid-run switch into Plan, then a plan write, then `agent_end`
 *   C. a plan written before the switch: no auto review, but `/review` works
 *
 * Run with: npm test   (node --test, type stripping)
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import workflowExtension from "./index.ts";
import {
  REVIEW_HANDOFF_LINE,
  REVIEW_PAUSED_LINE,
  REVIEW_RUNNING_HINT,
  REVIEW_RUNNING_LINE,
  planHash,
} from "./review.ts";
import { todoListKey } from "./todo-panel.ts";
import type { TodoItem } from "./utils.ts";
import {
  ORIGINAL_PLAN,
  REWRITTEN_PLAN,
  fakeSdk,
  makeFakeCtx,
  makeFakePi,
  latestStatus,
  renderReviewWidget,
  renderTodoWidget,
  stripAnsi,
  submitThenFinish,
  tmpProject,
  type FakeCapture,
} from "./test-support.ts";

interface BootOptions {
  enabled?: boolean;
  verify?: boolean;
  hasUI?: boolean;
  plannotator?: boolean;
  /**
   * Answer every `plan-review` request with `{status:"error"}` — the broken
   * Plannotator path the native fallback must survive.
   */
  plannotatorError?: boolean;
  /** Per-review-id answer for `plannotator:request` `review-status`. */
  plannotatorStatus?: Record<string, unknown>;
  startReason?: "startup" | "reload" | "resume" | "fork" | "new";
  /** Value returned by `ctx.ui.custom` (native handoff questionnaire result). */
  customAnswer?: unknown;
  /**
   * Sequential `ctx.ui.custom` answers. Plan approval and the execution choice
   * are two separate modals, so a test that approves supplies both in order.
   */
  customAnswers?: unknown[];
  editorAnswer?: string | null;
  /** `ctx.ui.select` answer (closed-review inline handoff). */
  selectAnswer?: string;
  /** `ctx.ui.confirm` answer (default true). */
  confirmAnswer?: boolean;
  modelRegistry?: { find?: (provider: string, id: string) => unknown };
  /**
   * Extra project `<cwd>/.pi/settings.json` content. `workflow` is merged one
   * level so `{ workflow: { handoff: "native" } }` keeps `reviewMode`.
   */
  settings?: Record<string, unknown>;
  /** Global `<agentDir>/settings.json` content (scope-precedence tests). */
  globalSettings?: Record<string, unknown>;
  /** Fake `ctx.settings` (e.g. `{ packages: ["npm:@plannotator/pi-extension"] }`). */
  ctxSettings?: Record<string, unknown>;
  script?: {
    pass1?: (c: FakeCapture) => Promise<void>;
    pass2?: (c: FakeCapture) => Promise<void>;
  };
  branch?: unknown[];
  /**
   * Host kind for the Terminal review widget: false models Pi Desktop (no
   * widget; the working row is the live line). Defaults to terminal-shaped.
   */
  isTerminalHost?: boolean;
  /** `ctx.isIdle()` at boot; a test can flip it later with `setIdle`. */
  idle?: boolean;
  /**
   * Approval destination. This suite pins direct Build; the production default
   * is Orchestrator, covered by `handoff-destination.test.ts`.
   */
  /** `unset` leaves the field absent so the PRODUCT default is exercised. */
  executionMode?: "orchestrator" | "build" | "unset";
}

async function boot(over: BootOptions = {}) {
  const { root, cwd, agentDir } = tmpProject();
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  fs.mkdirSync(path.join(cwd, ".pi", "plans"), { recursive: true });
  const extraSettings = over.settings ?? {};
  const extraWorkflow =
    extraSettings.workflow &&
    typeof extraSettings.workflow === "object" &&
    !Array.isArray(extraSettings.workflow)
      ? (extraSettings.workflow as Record<string, unknown>)
      : {};
  // A presenter string shorthand cannot also carry a destination, so this
  // fixture normalizes it to the object form it means (`{mode: "native"}`).
  const rawHandoff = extraWorkflow.handoff;
  const handoffObject: Record<string, unknown> =
    typeof rawHandoff === "string"
      ? { mode: rawHandoff }
      : rawHandoff && typeof rawHandoff === "object" && !Array.isArray(rawHandoff)
        ? (rawHandoff as Record<string, unknown>)
        : {};
  fs.writeFileSync(
    path.join(cwd, ".pi", "settings.json"),
    JSON.stringify(
      {
        ...extraSettings,
        workflow: {
          ...extraWorkflow,
          reviewMode: {
            enabled: over.enabled !== false,
            rounds: 1,
            passes: over.verify ? 2 : 1,
            verify: over.verify === true,
            timeoutMs: 5000,
          },
          // This suite pins the DIRECT-BUILD contract. The product default is
          // Orchestrator (covered by handoff-destination.test.ts), so legacy
          // approve→Build tests configure their destination explicitly.
          handoff: {
            ...handoffObject,
            ...(over.executionMode === "unset"
              ? {}
              : {
                  executionMode:
                    over.executionMode ?? handoffObject.executionMode ?? "build",
                }),
          },
        },
      },
      null,
      2,
    ),
  );
  if (over.globalSettings) {
    fs.writeFileSync(
      path.join(agentDir, "settings.json"),
      JSON.stringify(over.globalSettings, null, 2),
    );
  }
  const { capture, sdk } = fakeSdk(
    over.script ?? { pass1: submitThenFinish(REWRITTEN_PLAN) },
  );
  // Every plan approval now opens a SECOND modal. Unless a test supplies the
  // full sequence, answer that chooser with the configured destination so
  // approve→effect tests keep asserting the execution they configured.
  if (over.customAnswers === undefined && over.customAnswer !== undefined) {
    over.customAnswers = [
      over.customAnswer,
      executionAnswer(
        over.executionMode === "orchestrator" || over.executionMode === "unset"
          ? "orchestrator"
          : "build",
      ),
    ];
  }
  const pi = makeFakePi();
  const plannotatorRequests: Array<{
    requestId?: string;
    reviewId: string;
    planPath?: string;
    planContent?: string;
  }> = [];
  const reviewStatusRequests: string[] = [];
  let reviewSeq = 0;
  if (over.plannotator === true) {
    // Registering a request listener is what makes the extension detect a live
    // Plannotator host. The fake assigns a fresh review id per plan-review so
    // a second round cannot accidentally correlate with the first one.
    pi.events.on("plannotator:request", (raw: unknown) => {
      const request = raw as any;
      if (request?.action === "plan-review") {
        reviewSeq += 1;
        const reviewId = `review-${reviewSeq}`;
        plannotatorRequests.push({
          requestId: request.requestId,
          reviewId,
          planPath: request.payload?.planFilePath,
          planContent: request.payload?.planContent,
        });
        request.respond?.(
          over.plannotatorError === true
            ? { status: "error" }
            : { status: "handled", result: { reviewId } },
        );
      } else if (request?.action === "review-status") {
        const reviewId = String(request.payload?.reviewId ?? "");
        reviewStatusRequests.push(reviewId);
        request.respond?.({
          status: "handled",
          result:
            over.plannotatorStatus?.[reviewId] ?? { status: "pending" },
        });
      } else {
        request.respond?.({ status: "handled", result: { status: "pending" } });
      }
    });
  }
  await workflowExtension(pi as never, {
    loadSdk: async () => sdk as never,
    // The fake host has no Plannotator listener unless `plannotator: true`, so
    // an untuned handoff would wait the production 15 s before falling back to
    // the native questionnaire. Keep the fallback path fast in tests.
    plannotatorRequestTimeoutMs: 50,
    plannotatorRecoveryTimeoutMs: 50,
    // The test runner's stdout is piped, so the production predicate would be
    // false. Default to terminal-shaped; Desktop-shaped tests pass
    // `isTerminalHost: false`.
    isTerminalHost: () => over.isTerminalHost !== false,
  });
  const {
    ctx,
    notifies,
    statuses,
    statusCalls,
    widgets,
    widgetCalls,
    workingMessages,
    workingVisible,
    setIdle,
    confirms,
    selects,
    customs,
  } = makeFakeCtx({
    cwd,
    hasUI: over.hasUI === true,
    branch: over.branch ?? [],
    ...(over.idle === undefined ? {} : { idle: over.idle }),
    ...(over.modelRegistry ? { modelRegistry: over.modelRegistry } : {}),
    ...(over.customAnswer === undefined
      ? {}
      : { customAnswer: over.customAnswer }),
    ...(over.customAnswers === undefined
      ? {}
      : { customAnswers: over.customAnswers }),
    ...(over.editorAnswer === undefined
      ? {}
      : { editorAnswer: over.editorAnswer }),
    ...(over.selectAnswer === undefined
      ? {}
      : { selectAnswer: over.selectAnswer }),
    ...(over.confirmAnswer === undefined
      ? {}
      : { confirmAnswer: over.confirmAnswer }),
    ...(over.ctxSettings ? { settings: over.ctxSettings } : {}),
  });
  await pi.emit("session_start", { reason: over.startReason ?? "startup" }, ctx);
  const cleanup = async () => {
    try {
      await pi.emit("session_shutdown", {}, ctx);
    } catch {
      /* best effort */
    }
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  };
  return {
    root,
    cwd,
    agentDir,
    pi,
    ctx,
    notifies,
    statuses,
    statusCalls,
    widgets,
    widgetCalls,
    workingMessages,
    workingVisible,
    setIdle,
    confirms,
    selects,
    capture,
    customs,
    plannotatorRequests,
    reviewStatusRequests,
    cleanup,
  };
}

function placePlan(
  cwd: string,
  name = "review-target.md",
): { rel: string; abs: string } {
  // The plan target must be dated TODAY (UTC): `normalizePlanPath` rewrites a
  // stale date prefix, so a hard-coded fixture date would have the reviewer
  // write a different file than the one the test reads back.
  const today = new Date().toISOString().slice(0, 10);
  const rel = path.join(".pi", "plans", `${today}-${name}`);
  const abs = path.join(cwd, rel);
  fs.writeFileSync(abs, ORIGINAL_PLAN, "utf8");
  return { rel, abs };
}

async function freshPrompt(pi: any, ctx: any): Promise<void> {
  await pi.emit(
    "before_agent_start",
    { messageType: "user", prompt: "write a plan" },
    ctx,
  );
}

async function writeResult(pi: any, ctx: any, rel: string): Promise<void> {
  await pi.emit(
    "tool_result",
    { toolName: "write", isError: false, input: { path: rel }, content: [] },
    ctx,
  );
}

function runMessages(rel: string): unknown[] {
  return [
    {
      role: "assistant",
      content: [
        { type: "toolCall", name: "write", arguments: { path: rel } },
      ],
    },
    { role: "assistant", content: [{ type: "text", text: "plan written" }] },
  ];
}

async function switchToPlan(pi: any, ctx: any): Promise<void> {
  await pi.commands.plan.handler("", ctx);
}

async function runReview(pi: any, ctx: any, args = ""): Promise<void> {
  await pi.commands.review.handler(args, ctx);
}

function notified(notifies: Array<{ message: string }>, text: string): boolean {
  return notifies.some((n) => n.message.includes(text));
}

/** Visible text of one sent message (the fake stores the message OBJECT). */
function sentText(entry: { content?: unknown }): string {
  const content = entry?.content;
  if (typeof content === "string") return content;
  if (content && typeof content === "object") {
    const inner = (content as { content?: unknown }).content;
    if (typeof inner === "string") return inner;
    return JSON.stringify(content);
  }
  return "";
}

/** True when any sent message contains `needle`. */
function sentIncludes(
  b: { pi: { sent: Array<{ content?: unknown }> } },
  needle: string,
): boolean {
  return b.pi.sent.some((entry) => sentText(entry).includes(needle));
}

async function waitFor(cond: () => boolean, ms = 1500): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Wait until `n` reviewer passes have started. */
async function waitForPrompts(capture: FakeCapture, n: number): Promise<void> {
  for (let i = 0; i < 400 && capture.prompts.length < n; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.ok(capture.prompts.length >= n, `reviewer pass ${n} started`);
}

/**
 * A `QuestionnaireResult` for the STAGE-1 native plan question.
 *
 * `approve` approves the PLAN only; where it runs is a separate answer
 * (`executionAnswer`). Legacy destination labels are deliberately not used here
 * so the tests exercise the real two-stage flow.
 */
function handoffAnswer(
  choice: "approve" | "feedback" | "skip" | { freeform: string },
): unknown {
  if (typeof choice === "object") {
    return {
      cancelled: false,
      answers: [
        { question: "Plan ready — approve it, or ask for changes?", answer: choice.freeform, wasCustom: true },
      ],
    };
  }
  const labels = {
    approve: "Approve plan (choose execution next)",
    feedback: "Give feedback (stay in Plan)",
    skip: "Skip for now (stay in Plan)",
  };
  return {
    cancelled: false,
    answers: [
      { question: "Plan ready — approve it, or ask for changes?", answer: labels[choice], wasCustom: false },
    ],
  };
}

/** A `QuestionnaireResult` for the STAGE-2 execution chooser. */
function executionAnswer(
  destination: "orchestrator" | "build" | "later",
): unknown {
  const labels = {
    orchestrator: "Orchestrator — delegate each plan step",
    build: "Direct Build — implement in this session",
    later: "Decide later (stay in Plan)",
  };
  return {
    cancelled: false,
    answers: [
      { question: "Plan approved — where should it run?", answer: labels[destination], wasCustom: false },
    ],
  };
}

/** The reviewer writes the rewrite plus a "Review changes" appendix. */
function assertRewritten(abs: string): void {
  const text = fs.readFileSync(abs, "utf8");
  assert.ok(
    text.startsWith(REWRITTEN_PLAN),
    "the reviewer rewrote the plan the user actually wrote",
  );
}

test("switching to Plan clamps an unsupported role level silently", async () => {
  const model = {
    provider: "opencode-go",
    id: "muse-spark-1.2-contributor",
    reasoning: true,
    thinkingLevelMap: {
      off: "none",
      minimal: null,
      low: "low",
      medium: null,
      high: null,
      xhigh: null,
      max: null,
    },
  };
  const b = await boot({ modelRegistry: { find: () => model } });
  try {
    await switchToPlan(b.pi, b.ctx);
    assert.ok(notified(b.notifies, "Plan mode enabled"));
    // The planner role's stored `high` is unsupported by this fixture; the
    // activation still clamps, but it must not add a thinking-clamp warning.
    assert.ok(!notified(b.notifies, "does not support"));
  } finally {
    await b.cleanup();
  }
});

test("A: /review audits a plan written in Default, after switching to Plan", async () => {
  const b = await boot();
  try {
    const plan = placePlan(b.cwd);
    await freshPrompt(b.pi, b.ctx);
    await writeResult(b.pi, b.ctx, plan.rel);
    await switchToPlan(b.pi, b.ctx);
    assert.ok(notified(b.notifies, "Plan mode enabled"));

    await runReview(b.pi, b.ctx);

    assertRewritten(plan.abs);
    assert.equal(b.capture.prompts.length, 1, "one manual review round ran");
    assert.ok(
      b.capture.prompts[0].includes("Add CSV export"),
      "the reviewer received the plan text",
    );
    assert.ok(
      !notified(b.notifies, "No plan file found"),
      "the manual command must not claim there is no plan",
    );
  } finally {
    await b.cleanup();
  }
});

test("B: a mid-run switch into Plan still gets the automatic review", async () => {
  const b = await boot();
  try {
    await freshPrompt(b.pi, b.ctx);
    // The run is still active; the user switches to Plan before the write.
    await switchToPlan(b.pi, b.ctx);
    const plan = placePlan(b.cwd);
    await writeResult(b.pi, b.ctx, plan.rel);
    await b.pi.emit("agent_end", { messages: runMessages(plan.rel) }, b.ctx);

    assertRewritten(plan.abs);
    assert.ok(
      b.pi.entries.some(
        (e: any) => e.type === "workflow" && e.data?.planFile === plan.abs,
      ),
      "the plan target is persisted for a later resume",
    );
    assert.equal(b.capture.prompts.length, 1, "the automatic round ran");
    assert.ok(
      b.pi.sent.some((s: any) =>
        JSON.stringify(s.content).includes("Plan ready"),
      ),
      "the handoff rendered after the review",
    );
  } finally {
    await b.cleanup();
  }
});

test("C: a plan written before the switch is not auto-reviewed, but /review works", async () => {
  const b = await boot();
  try {
    await freshPrompt(b.pi, b.ctx);
    const plan = placePlan(b.cwd);
    await writeResult(b.pi, b.ctx, plan.rel);
    await switchToPlan(b.pi, b.ctx);
    await b.pi.emit("agent_end", { messages: runMessages(plan.rel) }, b.ctx);

    assert.equal(
      b.capture.prompts.length,
      0,
      "a plan written under Default must not auto-handoff",
    );
    assert.ok(
      notified(b.notifies, "Plan file ready"),
      "the user is told the plan exists and how to review it",
    );

    await runReview(b.pi, b.ctx);
    assert.equal(b.capture.prompts.length, 1, "the manual fallback works");
    assertRewritten(plan.abs);
  } finally {
    await b.cleanup();
  }
});

test("D: bare /review with no plan lists recent plans and the path syntax", async () => {
  const b = await boot();
  try {
    const plan = placePlan(b.cwd, "recent.md");
    await runReview(b.pi, b.ctx);
    assert.ok(
      notified(b.notifies, "No plan file found"),
      "the warning still fires",
    );
    assert.ok(
      notified(b.notifies, "/review"),
      "the warning teaches the explicit-path syntax",
    );
    assert.ok(
      notified(b.notifies, plan.rel) ||
        notified(b.notifies, plan.rel.replace(/\\/g, "/")),
      "the newest plan is offered as a suggestion",
    );
  } finally {
    await b.cleanup();
  }
});

test("E: /review <path> works with no recorded write", async () => {
  const b = await boot();
  try {
    const plan = placePlan(b.cwd);
    await runReview(b.pi, b.ctx, plan.rel);
    assert.equal(b.capture.prompts.length, 1);
    assertRewritten(plan.abs);
  } finally {
    await b.cleanup();
  }
});

test("F: /review say with no round stays in chat", async () => {
  const b = await boot();
  try {
    await runReview(b.pi, b.ctx, "say hello");
    assert.ok(notified(b.notifies, "No review round running"));
    assert.equal(b.capture.prompts.length, 0);
  } finally {
    await b.cleanup();
  }
});

test("G: Review Mode off keeps auto review off but manual /review works", async () => {
  const b = await boot({ enabled: false });
  try {
    await freshPrompt(b.pi, b.ctx);
    await switchToPlan(b.pi, b.ctx);
    const plan = placePlan(b.cwd);
    await writeResult(b.pi, b.ctx, plan.rel);
    await b.pi.emit("agent_end", { messages: runMessages(plan.rel) }, b.ctx);
    assert.equal(
      b.capture.prompts.length,
      0,
      "automatic review is gated by the enabled flag",
    );

    await runReview(b.pi, b.ctx);
    assert.equal(b.capture.prompts.length, 1, "manual review bypasses the flag");
    assertRewritten(plan.abs);
  } finally {
    await b.cleanup();
  }
});

test("H: restore keeps a planFile from an earlier entry and /review uses it", async () => {
  const { root, cwd, agentDir } = tmpProject();
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  let pi: any;
  let ctx: any;
  try {
    fs.mkdirSync(path.join(cwd, ".pi", "plans"), { recursive: true });
    const plan = placePlan(cwd);
    const branch = [
      {
        type: "custom",
        customType: "workflow",
        data: { mode: "plan", planFile: plan.rel, todos: [] },
      },
      // A later entry without planFile must not erase the restored value.
      {
        type: "custom",
        customType: "workflow",
        data: { mode: "plan", todos: [] },
      },
    ];
    const { capture, sdk } = fakeSdk({
      pass1: submitThenFinish(REWRITTEN_PLAN),
    });
    pi = makeFakePi();
    await workflowExtension(pi as never, {
      loadSdk: async () => sdk as never,
    });
    const made = makeFakeCtx({
      cwd,
      hasUI: false,
      branch,
    });
    ctx = made.ctx;
    await pi.emit("session_start", { reason: "resume" }, ctx);
    await runReview(pi, ctx);
    assert.equal(capture.prompts.length, 1);
    assertRewritten(plan.abs);
    assert.ok(!notified(made.notifies, "No plan file found"));
  } finally {
    try {
      if (pi && ctx) await pi.emit("session_shutdown", {}, ctx);
    } catch {
      /* best effort */
    }
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  }
});

test("J: a second Plan cycle gets a fresh review budget (rounds:1)", async () => {
  const b = await boot();
  try {
    await freshPrompt(b.pi, b.ctx);
    await switchToPlan(b.pi, b.ctx);
    const first = placePlan(b.cwd, "first.md");
    await writeResult(b.pi, b.ctx, first.rel);
    await b.pi.emit("agent_end", { messages: runMessages(first.rel) }, b.ctx);
    assert.equal(b.capture.prompts.length, 1, "first plan reviewed");
    assertRewritten(first.abs);
    assert.ok(
      !b.pi.entries.some(
        (e: any) =>
          e.type === "workflow-review-mode" &&
          String(e.data?.reason ?? "").includes("round limit"),
      ),
      "the first plan never hits the cap",
    );

    // A fresh prompt is a new feedback cycle. The second plan must be reviewed
    // with the default rounds: 1, not handed over as a round-limit skip.
    await freshPrompt(b.pi, b.ctx);
    const second = placePlan(b.cwd, "second.md");
    await writeResult(b.pi, b.ctx, second.rel);
    await b.pi.emit("agent_end", { messages: runMessages(second.rel) }, b.ctx);

    assert.equal(
      b.capture.prompts.length,
      2,
      "the second plan ran its own review round",
    );
    assertRewritten(second.abs);
    assert.ok(
      !b.pi.entries.some(
        (e: any) =>
          e.type === "workflow-review-mode" &&
          String(e.data?.reason ?? "").includes("round limit"),
      ),
      "a new cycle never inherits the previous cycle's consumed round",
    );
    assert.ok(
      b.pi.entries.some(
        (e: any) =>
          e.type === "workflow-review-cycle" && e.data?.reason === "prompt",
      ),
      "the new cycle is recorded for diagnosis",
    );
  } finally {
    await b.cleanup();
  }
});

test("K: a same-plan feedback prompt keeps findings but restarts the round", async () => {
  const b = await boot();
  try {
    await freshPrompt(b.pi, b.ctx);
    await switchToPlan(b.pi, b.ctx);
    const plan = placePlan(b.cwd, "refine.md");
    await writeResult(b.pi, b.ctx, plan.rel);
    await b.pi.emit("agent_end", { messages: runMessages(plan.rel) }, b.ctx);
    assert.equal(b.capture.prompts.length, 1, "first revision reviewed");

    // Same plan file, fresh feedback prompt: a new round must run (not the
    // round cap) and the previous finding must reach the reviewer.
    fs.writeFileSync(plan.abs, ORIGINAL_PLAN, "utf8");
    await freshPrompt(b.pi, b.ctx);
    await writeResult(b.pi, b.ctx, plan.rel);
    await b.pi.emit("agent_end", { messages: runMessages(plan.rel) }, b.ctx);

    assert.equal(
      b.capture.prompts.length,
      2,
      "the same-plan feedback revision got a fresh round",
    );
    assert.ok(
      b.capture.prompts[1].includes("Findings from the previous round"),
      "the reviewer is asked to verify the prior finding",
    );
    assert.ok(
      b.capture.prompts[1].includes("Result<T,E> convention"),
      "the actual prior finding is carried into the prompt",
    );
  } finally {
    await b.cleanup();
  }
});

test("M: inline Refine starts a new cycle and carries findings", async () => {
  const b = await boot({
    hasUI: true,
    customAnswer: handoffAnswer("feedback"),
    editorAnswer: "Please add an export test.",
  });
  try {
    await freshPrompt(b.pi, b.ctx);
    await switchToPlan(b.pi, b.ctx);
    const plan = placePlan(b.cwd, "inline-refine.md");
    await writeResult(b.pi, b.ctx, plan.rel);
    await b.pi.emit("agent_end", { messages: runMessages(plan.rel) }, b.ctx);
    assert.equal(b.capture.prompts.length, 1, "first revision reviewed");
    assert.ok(
      b.pi.entries.some(
        (e: any) =>
          e.type === "workflow-handoff-result" && e.data?.choice === "refine",
      ),
      "the inline Refine choice was taken",
    );
    assert.ok(
      b.pi.entries.some(
        (e: any) =>
          e.type === "workflow-review-cycle" && e.data?.reason === "refine",
      ),
      "Refine started a new review cycle",
    );
    assert.ok(
      b.pi.sent.some((s: any) =>
        String(s.content).includes("Please add an export test."),
      ),
      "the refinement feedback was sent as the follow-up",
    );

    // Simulate the follow-up run writing the revised same plan and ending.
    // Dismiss the second handoff so this test only exercises the refine cycle.
    (b.ctx as any).ui.custom = async () => null;
    fs.writeFileSync(plan.abs, ORIGINAL_PLAN, "utf8");
    await writeResult(b.pi, b.ctx, plan.rel);
    await b.pi.emit("agent_end", { messages: runMessages(plan.rel) }, b.ctx);

    assert.equal(
      b.capture.prompts.length,
      2,
      "the refined plan got a fresh review round",
    );
    assert.ok(
      b.capture.prompts[1].includes("Findings from the previous round"),
      "Refine preserved the prior findings for verification",
    );
  } finally {
    await b.cleanup();
  }
});

test("N: browser Deny restarts the cycle and sends the feedback", async () => {
  const b = await boot({ hasUI: true, plannotator: true, customAnswers: [executionAnswer("build")] });
  try {
    await freshPrompt(b.pi, b.ctx);
    await switchToPlan(b.pi, b.ctx);
    const plan = placePlan(b.cwd, "browser-deny.md");
    await writeResult(b.pi, b.ctx, plan.rel);
    await b.pi.emit("agent_end", { messages: runMessages(plan.rel) }, b.ctx);
    assert.equal(b.capture.prompts.length, 1, "first revision reviewed");
    assert.ok(
      b.pi.sent.some((s: any) =>
        JSON.stringify(s.content).includes("Plan opened in browser"),
      ) ||
        b.pi.entries.some(
          (e: any) => e.type === "workflow-handoff-plannotator",
        ),
      "the browser handoff opened after the review",
    );

    b.pi.events.emit("plannotator:review-result", {
      reviewId: "review-1",
      approved: false,
      feedback: "Please add an export test.",
    });
    for (let i = 0; i < 100; i += 1) {
      const cycleStarted = b.pi.entries.some(
        (e: any) =>
          e.type === "workflow-review-cycle" && e.data?.reason === "deny",
      );
      const feedbackSent = b.pi.sent.some((s: any) =>
        String(s.content).includes("Please add an export test."),
      );
      if (cycleStarted && feedbackSent) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.ok(
      b.pi.entries.some(
        (e: any) =>
          e.type === "workflow-review-cycle" && e.data?.reason === "deny",
      ),
      "browser Deny started a new review cycle",
    );
    assert.ok(
      b.pi.sent.some((s: any) =>
        String(s.content).includes("Please add an export test."),
      ),
      "the deny feedback was sent as the follow-up",
    );

    // Simulate the follow-up run writing the revised same plan and ending.
    // The browser branch answers with a new review id; this handoff is enough
    // to prove the deny cycle reset reached the next automatic review.
    fs.writeFileSync(plan.abs, ORIGINAL_PLAN, "utf8");
    await writeResult(b.pi, b.ctx, plan.rel);
    await b.pi.emit("agent_end", { messages: runMessages(plan.rel) }, b.ctx);

    assert.equal(
      b.capture.prompts.length,
      2,
      "the denied plan got a fresh review round",
    );
    assert.ok(
      b.capture.prompts[1].includes("Findings from the previous round"),
      "browser Deny preserved the prior findings for verification",
    );
  } finally {
    await b.cleanup();
  }
});

test("L: a new prompt abandons a paused gated review and clears its status/lock", async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const b = await boot({
    script: {
      pass1: async (c) => {
        await gate;
        await submitThenFinish(REWRITTEN_PLAN)(c);
      },
    },
  });
  try {
    await freshPrompt(b.pi, b.ctx);
    await switchToPlan(b.pi, b.ctx);
    const plan = placePlan(b.cwd, "paused.md");
    await writeResult(b.pi, b.ctx, plan.rel);
    const handoff = b.pi.emit(
      "agent_end",
      { messages: runMessages(plan.rel) },
      b.ctx,
    );
    for (let i = 0; i < 100 && b.capture.prompts.length === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(b.capture.prompts.length, 1, "the gated round started");

    await b.pi.commands["review-pause"].handler("", b.ctx);
    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.ok(
      !b.pi.sent.some((s: any) =>
        JSON.stringify(s.content).includes("Plan ready"),
      ),
      "a paused gated review withholds the handoff",
    );
    assert.ok(notified(b.notifies, "Review paused"));

    const before = b.statuses.length;
    await freshPrompt(b.pi, b.ctx);
    // The new prompt settles the parked gate; the old handoff must return
    // without rendering after the cycle token changed.
    await handoff;
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.ok(
      notified(b.notifies, "prompt was already queued") ||
        notified(b.notifies, "Paused review abandoned"),
      "the user is told the bypass prompt stopped the review",
    );
    const after = b.statuses
      .slice(before)
      .filter((value): value is string => typeof value === "string");
    assert.ok(
      !after.some((value) => value.includes("review paused")),
      "the stale paused line is cleared",
    );
    assert.ok(
      !after.some((value) => value.includes("modes locked")),
      "the stale mode lock is cleared",
    );
    assert.ok(
      !b.pi.sent.some((s: any) =>
        JSON.stringify(s.content).includes("Plan ready"),
      ),
      "the abandoned handoff never renders after the new prompt",
    );
  } finally {
    release();
    await b.cleanup();
  }
});

test("I: /tree re-derives the plan and drops one from another branch", async () => {
  const b = await boot();
  try {
    const plan = placePlan(b.cwd);
    await writeResult(b.pi, b.ctx, plan.rel);
    await runReview(b.pi, b.ctx);
    assert.equal(b.capture.prompts.length, 1);

    // Rewind to a branch that never saw the plan.
    const rewindCtx = makeFakeCtx({ cwd: b.cwd, hasUI: false, branch: [] }).ctx;
    await b.pi.emit("session_tree", {}, rewindCtx);
    await runReview(b.pi, rewindCtx);
    // The command runs on the rewind context; no plan is recorded there.
    assert.equal(
      b.capture.prompts.length,
      1,
      "/review must not audit the stale plan after a rewind",
    );
  } finally {
    await b.cleanup();
  }
});

test("O: browser Deny produces a second browser handoff", async () => {
  const b = await boot({ hasUI: true, plannotator: true, customAnswers: [executionAnswer("build")] });
  try {
    await freshPrompt(b.pi, b.ctx);
    await switchToPlan(b.pi, b.ctx);
    const plan = placePlan(b.cwd, "two-rounds.md");
    await writeResult(b.pi, b.ctx, plan.rel);
    await b.pi.emit("agent_end", { messages: runMessages(plan.rel) }, b.ctx);
    assert.equal(b.plannotatorRequests.length, 1, "round 1 opened once");
    assert.equal(b.plannotatorRequests[0]?.reviewId, "review-1");

    b.pi.events.emit("plannotator:review-result", {
      reviewId: "review-1",
      approved: false,
      feedback: "Please add an export test.",
    });
    for (let i = 0; i < 100; i += 1) {
      if (
        b.pi.entries.some(
          (e: any) =>
            e.type === "workflow-review-cycle" && e.data?.reason === "deny",
        )
      )
        break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    fs.writeFileSync(plan.abs, ORIGINAL_PLAN, "utf8");
    await writeResult(b.pi, b.ctx, plan.rel);
    await b.pi.emit("agent_end", { messages: runMessages(plan.rel) }, b.ctx);

    assert.equal(b.capture.prompts.length, 2, "round 2 ran");
    assert.equal(
      b.plannotatorRequests.length,
      2,
      "round 2 opened a fresh browser review",
    );
    assert.equal(b.plannotatorRequests[1]?.reviewId, "review-2");
  } finally {
    await b.cleanup();
  }
});

test("P: a different plan supersedes a pending browser review", async () => {
  const b = await boot({ hasUI: true, plannotator: true, customAnswers: [executionAnswer("build")] });
  try {
    await freshPrompt(b.pi, b.ctx);
    await switchToPlan(b.pi, b.ctx);
    const first = placePlan(b.cwd, "pending-first.md");
    await writeResult(b.pi, b.ctx, first.rel);
    await b.pi.emit("agent_end", { messages: runMessages(first.rel) }, b.ctx);
    assert.equal(b.plannotatorRequests.length, 1);

    // A follow-up run writes a different plan without a fresh prompt. The
    // old browser review is still pending and must not suppress this one.
    const second = placePlan(b.cwd, "pending-second.md");
    await writeResult(b.pi, b.ctx, second.rel);
    await b.pi.emit("agent_end", { messages: runMessages(second.rel) }, b.ctx);

    assert.equal(b.capture.prompts.length, 2, "the second plan was reviewed");
    assert.equal(
      b.plannotatorRequests.length,
      2,
      "the second plan opened its own browser review",
    );
    assert.ok(
      String(b.plannotatorRequests[1]?.planPath).endsWith("pending-second.md"),
      "the new review points at the new plan",
    );
  } finally {
    await b.cleanup();
  }
});

test("Q: a stale browser Deny cannot suppress the running round's handoff", async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const b = await boot({
    hasUI: true,
    plannotator: true,
    script: {
      pass1: async (c) => {
        if (c.prompts.length === 2) await gate;
        await submitThenFinish(REWRITTEN_PLAN)(c);
      },
    },
  });
  try {
    await freshPrompt(b.pi, b.ctx);
    await switchToPlan(b.pi, b.ctx);
    const first = placePlan(b.cwd, "stale-first.md");
    await writeResult(b.pi, b.ctx, first.rel);
    await b.pi.emit("agent_end", { messages: runMessages(first.rel) }, b.ctx);
    assert.equal(b.plannotatorRequests.length, 1);

    const second = placePlan(b.cwd, "stale-second.md");
    await writeResult(b.pi, b.ctx, second.rel);
    const handoff = b.pi.emit(
      "agent_end",
      { messages: runMessages(second.rel) },
      b.ctx,
    );
    for (let i = 0; i < 100 && b.capture.prompts.length < 2; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(b.capture.prompts.length, 2, "the new round is running");

    // The user clicks Deny in the old tab while the new round audits.
    b.pi.events.emit("plannotator:review-result", {
      reviewId: "review-1",
      approved: false,
      feedback: "stale feedback",
    });
    release();
    await handoff;

    assert.equal(
      b.plannotatorRequests.length,
      2,
      "the current round still handed off",
    );
    assert.equal(b.plannotatorRequests[1]?.reviewId, "review-2");
  } finally {
    release();
    await b.cleanup();
  }
});

async function reloadWithPending(
  status: Record<string, unknown>,
  over: BootOptions = {},
  plain = false,
  ctxAnswers?: unknown[],
): Promise<{
  b: Awaited<ReturnType<typeof boot>>;
  made: ReturnType<typeof makeFakeCtx>;
  plan: { rel: string; abs: string };
}> {
  const b = await boot({
    hasUI: true,
    plannotator: true,
    plannotatorStatus: status,
    ...over,
  });
  const plan = placePlan(b.cwd, "reload-pending.md");
  const branch = [
    {
      type: "custom",
      customType: "workflow",
      data: {
        mode: "plan",
        planFile: plan.abs,
        todos: [],
        awaitingDecision: true,
        awaitingDecisionAt: Date.now(),
        lastReviewId: "review-1",
        pendingHandoffPlanPath: plan.abs,
        pendingHandoffPlanHash: planHash(ORIGINAL_PLAN),
        pendingHandoffSource: "auto",
        pendingHandoffCycleId: 1,
        ...(plain
          ? { pendingHandoffReviewOwned: false, planHandoffPhase: "pending" }
          : {}),
      },
    },
  ];
  const made = makeFakeCtx({
    cwd: b.cwd,
    hasUI: true,
    branch,
    ...(ctxAnswers ? { customAnswers: ctxAnswers } : {}),
  });
  await b.pi.emit("session_start", { reason: "reload" }, made.ctx);
  return { b, made, plan };
}

test("R1: reload keeps a pending browser review", async () => {
  const { b, made } = await reloadWithPending({
    "review-1": { status: "pending" },
  });
  try {
    await waitFor(() => b.reviewStatusRequests.includes("review-1"));
    assert.deepEqual(
      b.reviewStatusRequests,
      ["review-1"],
      "the reloaded session asked Plannotator for the review status",
    );
    assert.ok(
      notified(made.notifies, "still open") ||
        notified(made.notifies, "browser"),
      "the restored gate is visible to the user",
    );
    assert.ok(
      made.statuses.some(
        (value) =>
          typeof value === "string" &&
          value.includes("🔍 review — awaiting decision"),
      ),
      "a kept gate restores Review as the handoff phase",
    );
  } finally {
    await b.cleanup();
  }
});

test("R2: reload records an approval and WAITS for the execution choice", async () => {
  const { b, made } = await reloadWithPending(
    {
      "review-1": {
        status: "completed",
        approved: true,
        feedback: "looks good",
      },
    },
    {},
    false,
    [executionAnswer("build")],
  );
  try {
    await waitFor(() =>
      b.pi.entries.some((e: any) => e.type === "workflow-handoff-approved"),
    );
    const approved = b.pi.entries.find(
      (e: any) => e.type === "workflow-handoff-approved",
    ) as any;
    assert.ok(approved, "the recovered approval is recorded as stage 1");
    const modesBefore = b.pi.entries.filter(
      (e: any) => e.type === "workflow" && e.data?.mode,
    );
    assert.equal(
      modesBefore.filter((e: any) => e.data.mode === "build").length,
      0,
      "recovery never executes: the approved plan waits in Plan",
    );
    assert.ok(
      notified(made.notifies, "execution was not selected") ||
        notified(made.notifies, "/handoff continue"),
      "recovery tells the user how to choose execution",
    );

    // Resume explicitly. This is the ONLY way the restored plan executes.
    await b.pi.commands.handoff.handler(
      `continue ${approved.data.decisionId}`,
      made.ctx,
    );
    await waitFor(() =>
      b.pi.entries.some(
        (e: any) => e.type === "workflow" && e.data?.mode === "build",
      ),
    );
    assert.ok(
      b.pi.entries.some(
        (e: any) => e.type === "workflow" && e.data?.mode === "build",
      ),
      "an explicit resume enters the chosen destination",
    );
  } finally {
    await b.cleanup();
  }
});

test("R3: reload applies a completed denial", async () => {
  const { b } = await reloadWithPending({
    "review-1": {
      status: "completed",
      approved: false,
      feedback: "please add an export test",
    },
  });
  try {
    await waitFor(() =>
      b.pi.sent.some((s: any) =>
        String(s.content).includes("please add an export test"),
      ),
    );
    assert.ok(
      b.pi.sent.some((s: any) =>
        String(s.content).includes("please add an export test"),
      ),
      "a denial completed during the reload reaches the planner",
    );
  } finally {
    await b.cleanup();
  }
});

test("R4: a missing review is cleared after reload", async () => {
  const { b, made } = await reloadWithPending({
    "review-1": { status: "missing" },
  });
  try {
    await waitFor(() =>
      b.pi.entries.some((e: any) => e.type === "workflow-handoff-recovery"),
    );
    assert.ok(
      b.pi.entries.some(
        (e: any) => e.type === "workflow-handoff-recovery",
      ),
      "a missing review is recorded and cleared",
    );
    const modes = made.statuses.filter(
      (value): value is string =>
        typeof value === "string" &&
        (value.includes("🔍 review") ||
          value.includes("⏸ plan") ||
          value.includes("▶ build")),
    );
    assert.ok(
      modes.at(-1)?.includes("⏸ plan"),
      `a cleared gate returns to the author mode, got ${modes.at(-1)}`,
    );
  } finally {
    await b.cleanup();
  }
});

test("S1: manual /review opens the browser handoff in Plan mode", async () => {
  const b = await boot({ hasUI: true, plannotator: true, customAnswers: [executionAnswer("build")] });
  try {
    await freshPrompt(b.pi, b.ctx);
    await switchToPlan(b.pi, b.ctx);
    const plan = placePlan(b.cwd, "manual-handoff.md");
    await writeResult(b.pi, b.ctx, plan.rel);
    await runReview(b.pi, b.ctx);

    assert.equal(b.plannotatorRequests.length, 1, "manual /review handed off");
    assert.ok(
      b.pi.entries.some(
        (e: any) => e.type === "workflow-handoff-plannotator",
      ),
      "the handoff is recorded",
    );
  } finally {
    await b.cleanup();
  }
});

test("S2: a manual handoff approval enters Build from Default mode", async () => {
  const b = await boot({ hasUI: true, plannotator: true, customAnswers: [executionAnswer("build")] });
  try {
    await freshPrompt(b.pi, b.ctx);
    const plan = placePlan(b.cwd, "manual-default.md");
    await writeResult(b.pi, b.ctx, plan.rel);
    await runReview(b.pi, b.ctx);
    assert.equal(b.plannotatorRequests.length, 1);

    b.pi.events.emit("plannotator:review-result", {
      reviewId: "review-1",
      approved: true,
    });
    await waitFor(() =>
      b.pi.entries.some(
        (e: any) => e.type === "workflow" && e.data?.mode === "build",
      ),
    );
    assert.ok(
      b.pi.entries.some(
        (e: any) => e.type === "workflow" && e.data?.mode === "build",
      ),
      "manual approval enters Build",
    );
  } finally {
    await b.cleanup();
  }
});

test("S3: a manual Deny outside Plan switches to Plan and sends feedback", async () => {
  const b = await boot({ hasUI: true, plannotator: true, customAnswers: [executionAnswer("build")] });
  try {
    await freshPrompt(b.pi, b.ctx);
    const plan = placePlan(b.cwd, "manual-deny.md");
    await writeResult(b.pi, b.ctx, plan.rel);
    await runReview(b.pi, b.ctx);
    assert.equal(b.plannotatorRequests.length, 1);

    b.pi.events.emit("plannotator:review-result", {
      reviewId: "review-1",
      approved: false,
      feedback: "please add an export test",
    });
    await waitFor(() =>
      b.pi.sent.some((s: any) =>
        String(s.content).includes("please add an export test"),
      ),
    );
    assert.ok(notified(b.notifies, "Plan mode"), "the revision runs in Plan");
    assert.ok(
      b.pi.sent.some((s: any) =>
        String(s.content).includes("please add an export test"),
      ),
      "the denial feedback was sent",
    );
  } finally {
    await b.cleanup();
  }
});

test("S5: a paused manual review hands off after /review-resume", async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const b = await boot({
    hasUI: true,
    plannotator: true,
    script: {
      pass1: async (c) => {
        if (c.prompts.length === 1) await gate;
        await submitThenFinish(REWRITTEN_PLAN)(c);
      },
    },
  });
  try {
    await freshPrompt(b.pi, b.ctx);
    await switchToPlan(b.pi, b.ctx);
    const plan = placePlan(b.cwd, "manual-resume.md");
    await writeResult(b.pi, b.ctx, plan.rel);
    const manual = b.pi.commands.review.handler("", b.ctx);
    for (let i = 0; i < 100 && b.capture.prompts.length === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(b.capture.prompts.length, 1);
    await b.pi.commands["review-pause"].handler("", b.ctx);
    release();
    await manual;
    assert.equal(
      b.plannotatorRequests.length,
      0,
      "a paused manual review does not hand off yet",
    );

    await b.pi.commands["review-resume"].handler("", b.ctx);
    assert.equal(
      b.plannotatorRequests.length,
      1,
      "the resumed manual round opens the browser once",
    );
  } finally {
    release();
    await b.cleanup();
  }
});

test("S4: a manual cycle keeps reviewing after Deny with Review Mode off", async () => {
  const b = await boot({ enabled: false, hasUI: true, plannotator: true, customAnswers: [executionAnswer("build")] });
  try {
    await freshPrompt(b.pi, b.ctx);
    await switchToPlan(b.pi, b.ctx);
    const plan = placePlan(b.cwd, "manual-cycle.md");
    await writeResult(b.pi, b.ctx, plan.rel);
    await runReview(b.pi, b.ctx);
    assert.equal(b.plannotatorRequests.length, 1, "manual review handed off");

    b.pi.events.emit("plannotator:review-result", {
      reviewId: "review-1",
      approved: false,
      feedback: "please add an export test",
    });
    await waitFor(() =>
      b.pi.sent.some((s: any) =>
        String(s.content).includes("please add an export test"),
      ),
    );
    // Real Pi fires before_agent_start for the extension's feedback turn. It
    // used to clear manualReviewCycle with reason "prompt"; the refine flag
    // must preserve it so this manual cycle re-reviews with auto mode off.
    await b.pi.emit(
      "before_agent_start",
      { messageType: "custom", prompt: "please add an export test" },
      b.ctx,
    );

    fs.writeFileSync(plan.abs, ORIGINAL_PLAN, "utf8");
    await writeResult(b.pi, b.ctx, plan.rel);
    await b.pi.emit("agent_end", { messages: runMessages(plan.rel) }, b.ctx);

    assert.equal(b.capture.prompts.length, 2, "the revised plan was reviewed");
    assert.equal(
      b.plannotatorRequests.length,
      2,
      "the revised plan handed off again",
    );
  } finally {
    await b.cleanup();
  }
});

test("P: auto Review Approve applies Build before execute and ends Review", async () => {
  const b = await boot({ hasUI: true, plannotator: true, customAnswers: [executionAnswer("build")] });
  try {
    await freshPrompt(b.pi, b.ctx);
    await switchToPlan(b.pi, b.ctx);
    const plan = placePlan(b.cwd, "approve-order.md");
    await writeResult(b.pi, b.ctx, plan.rel);
    await b.pi.emit("agent_end", { messages: runMessages(plan.rel) }, b.ctx);
    assert.equal(b.plannotatorRequests.length, 1, "the review opened once");

    b.pi.events.emit("plannotator:review-result", {
      reviewId: "review-1",
      approved: true,
    });
    await waitFor(() =>
      b.pi.sent.some((s: any) =>
        JSON.stringify(s.content).includes("Execute the plan"),
      ),
    );

    const buildToolAt = b.pi.timeline.reduce(
      (found, entry, index) =>
        entry.kind === "tools" && entry.tools.includes("write") ? index : found,
      -1,
    );
    const executeAt = b.pi.timeline.findIndex(
      (entry) =>
        entry.kind === "send" &&
        JSON.stringify(entry.content).includes("Execute the plan"),
    );
    assert.ok(buildToolAt >= 0, "Build tools were applied");
    assert.ok(
      buildToolAt < executeAt,
      "Build tools are active before the execute message is sent",
    );

    const statuses = b.statuses.filter(
      (value): value is string => typeof value === "string",
    );
    const lastMode = [...statuses]
      .reverse()
      .find(
        (value) =>
          value.includes("▶ build") ||
          value.includes("⏸ plan") ||
          value.includes("🔍 review"),
      );
    assert.ok(
      lastMode?.includes("▶ build"),
      `the last mode status is Build, got ${lastMode}`,
    );
  } finally {
    await b.cleanup();
  }
});

test("Q: repeated browser feedback legs re-review and reset the round budget", async () => {
  const b = await boot({ hasUI: true, plannotator: true, verify: false, customAnswers: [executionAnswer("build")] });
  try {
    await freshPrompt(b.pi, b.ctx);
    await switchToPlan(b.pi, b.ctx);
    const plan = placePlan(b.cwd, "feedback-loop.md");
    await writeResult(b.pi, b.ctx, plan.rel);
    await b.pi.emit("agent_end", { messages: runMessages(plan.rel) }, b.ctx);
    assert.equal(b.plannotatorRequests.length, 1, "round 1 handed off");

    for (let leg = 1; leg <= 2; leg += 1) {
      b.pi.events.emit("plannotator:review-result", {
        reviewId: `review-${leg}`,
        approved: false,
        feedback: `revision ${leg}`,
      });
      await waitFor(() =>
        b.pi.sent.some((s: any) =>
          String(s.content).includes(`revision ${leg}`),
        ),
      );
      // Real Pi fires before_agent_start for the extension's feedback turn;
      // the fake host does not, so simulate it explicitly.
      await b.pi.emit(
        "before_agent_start",
        { messageType: "custom", prompt: `revision ${leg}` },
        b.ctx,
      );
      fs.writeFileSync(plan.abs, ORIGINAL_PLAN, "utf8");
      await writeResult(b.pi, b.ctx, plan.rel);
      await b.pi.emit("agent_end", { messages: runMessages(plan.rel) }, b.ctx);
      assert.equal(
        b.plannotatorRequests.length,
        leg + 1,
        `feedback leg ${leg} opened a fresh handoff`,
      );
      assert.ok(
        !b.pi.entries.some(
          (e: any) =>
            e.type === "workflow-review-mode" &&
            String(e.data?.reason ?? "").includes("round limit"),
        ),
        `feedback leg ${leg} did not hit the round cap`,
      );
    }

    b.pi.events.emit("plannotator:review-result", {
      reviewId: "review-3",
      approved: true,
    });
    await waitFor(() =>
      b.pi.sent.some((s: any) =>
        JSON.stringify(s.content).includes("Execute the plan"),
      ),
    );
    assert.equal(b.capture.prompts.length, 3, "three review rounds ran");
    assert.ok(
      b.statuses.some(
        (value) => typeof value === "string" && value.includes("▶ build"),
      ),
      "approval entered Build",
    );
  } finally {
    await b.cleanup();
  }
});

test("R: pause/resume keeps Review, abort still hands off", async () => {
  const releases: Array<() => void> = [];
  const b = await boot({
    hasUI: true,
    plannotator: true,
    script: {
      pass1: async (c) => {
        await new Promise<void>((resolve) => releases.push(resolve));
        await submitThenFinish(REWRITTEN_PLAN)(c);
      },
    },
  });
  try {
    await freshPrompt(b.pi, b.ctx);
    await switchToPlan(b.pi, b.ctx);
    const plan = placePlan(b.cwd, "pause-resume.md");
    await writeResult(b.pi, b.ctx, plan.rel);
    const handoff = b.pi.emit(
      "agent_end",
      { messages: runMessages(plan.rel) },
      b.ctx,
    );

    const waitForPrompt = async (n: number): Promise<void> => {
      for (let i = 0; i < 200 && b.capture.prompts.length < n; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      assert.ok(b.capture.prompts.length >= n, `round ${n} started`);
    };

    await waitForPrompt(1);
    for (let i = 0; i < 1; i += 1) {
      await b.pi.commands["review-pause"].handler("", b.ctx);
      releases.shift()?.();
      for (let wait = 0; wait < 200; wait += 1) {
        const paused = b.statuses.some(
          (value) =>
            typeof value === "string" && value.includes("🔍 review — paused"),
        );
        if (paused) break;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      assert.ok(
        b.statuses.some(
          (value) =>
            typeof value === "string" && value.includes("🔍 review — paused"),
        ),
        `pause ${i + 1} shows Review paused`,
      );
      // The paused status is painted before the aborting round's finally has
      // cleared `activeReview`; let it settle before resuming.
      await new Promise((resolve) => setTimeout(resolve, 60));
      await b.pi.commands["review-resume"].handler("", b.ctx);
      await waitForPrompt(i + 2);
    }

    // Abort the fourth round while paused. The gated handoff is parked, so the
    // abort must settle it and the parked runHandoff must present the plan.
    await b.pi.commands["review-pause"].handler("", b.ctx);
    releases.shift()?.();
    await new Promise((resolve) => setTimeout(resolve, 10));
    await b.pi.commands["review-abort"].handler("", b.ctx);
    for (let i = 0; i < 200 && b.plannotatorRequests.length === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.ok(
      b.plannotatorRequests.length >= 1,
      "abort presented the plan for Approve/Revise",
    );
    await handoff;
    const strings = b.statuses.filter(
      (value): value is string => typeof value === "string",
    );
    assert.ok(
      strings.some((value) => value.includes("🔍 review — awaiting decision")),
      "the abort moved Review to the handoff phase",
    );
    assert.ok(
      !strings.at(-1)?.includes("🔍 review — paused"),
      "the paused status did not stick",
    );
  } finally {
    releaseAll(releases);
    await b.cleanup();
  }
});

function releaseAll(releases: Array<() => void>): void {
  while (releases.length > 0) releases.shift()?.();
}

test("T: manual /review locks prompts/modes and Approve enters Build", async () => {
  const b = await boot({ enabled: false, hasUI: true, plannotator: true, customAnswers: [executionAnswer("build")] });
  try {
    const plan = placePlan(b.cwd, "manual-default.md");
    await runReview(b.pi, b.ctx, plan.rel);
    assert.equal(b.plannotatorRequests.length, 1, "manual review handed off");
    assert.ok(
      b.statuses.some(
        (value) => typeof value === "string" && value.includes("🔍 review"),
      ),
      "manual /review enters Review",
    );

    const blocked = await b.pi.emit(
      "input",
      { text: "rewrite the plan", source: "interactive" },
      b.ctx,
    );
    assert.deepEqual(blocked[0], { action: "handled" });
    assert.ok(notified(b.notifies, "prompts are locked"));

    const allowed = await b.pi.emit(
      "input",
      { text: "/model opencode-go/other", source: "interactive" },
      b.ctx,
    );
    assert.deepEqual(allowed[0], { action: "continue" });

    await b.pi.commands.plan.handler("", b.ctx);
    assert.ok(notified(b.notifies, "mode switching is locked"));

    b.pi.events.emit("plannotator:review-result", {
      reviewId: "review-1",
      approved: true,
    });
    await waitFor(() =>
      b.pi.sent.some((s: any) =>
        JSON.stringify(s.content).includes("Execute the plan"),
      ),
    );
    assert.ok(
      b.statuses.some(
        (value) => typeof value === "string" && value.includes("▶ build"),
      ),
      "Approve entered Build",
    );
  } finally {
    await b.cleanup();
  }
});

test("U: manual /review feedback switches to Plan", async () => {
  const b = await boot({ enabled: false, hasUI: true, plannotator: true, customAnswers: [executionAnswer("build")] });
  try {
    const plan = placePlan(b.cwd, "manual-feedback.md");
    await runReview(b.pi, b.ctx, plan.rel);
    b.pi.events.emit("plannotator:review-result", {
      reviewId: "review-1",
      approved: false,
      feedback: "please revise",
    });
    await waitFor(() =>
      b.pi.sent.some((s: any) => String(s.content).includes("please revise")),
    );
    const strings = b.statuses.filter(
      (value): value is string => typeof value === "string",
    );
    assert.ok(
      strings.some((value) => value.includes("⏸ plan")),
      "Deny returned to Plan for the revision",
    );
    assert.ok(
      !strings.at(-1)?.includes("🔍 review"),
      "Review is no longer the active mode after feedback",
    );
  } finally {
    await b.cleanup();
  }
});

test("V: /review with no plan warns and never enters Review", async () => {
  const b = await boot({ hasUI: true, plannotator: true, customAnswers: [executionAnswer("build")] });
  try {
    await runReview(b.pi, b.ctx);
    assert.ok(notified(b.notifies, "No plan file found"));
    assert.equal(b.plannotatorRequests.length, 0, "no handoff opened");
    assert.ok(
      !b.statuses.some(
        (value) => typeof value === "string" && value.includes("🔍 review"),
      ),
      "no Review mode status was painted",
    );
    const allowed = await b.pi.emit(
      "input",
      { text: "ordinary prompt", source: "interactive" },
      b.ctx,
    );
    assert.deepEqual(allowed[0], { action: "continue" });
  } finally {
    await b.cleanup();
  }
});

test("T1: a terminal manual /review paints the live composer widget while idle", async () => {
  const releases: Array<() => void> = [];
  const b = await boot({
    enabled: false,
    hasUI: true,
    plannotator: true,
    script: {
      pass1: async (c) => {
        await new Promise<void>((resolve) => releases.push(resolve));
        await submitThenFinish(REWRITTEN_PLAN)(c);
      },
    },
  });
  try {
    const plan = placePlan(b.cwd, "terminal-widget.md");
    const running = runReview(b.pi, b.ctx, plan.rel);
    await waitForPrompts(b.capture, 1);
    const lines = renderReviewWidget(b.widgetCalls);
    assert.ok(
      lines.some((line) => line.includes("🔍 Reviewing plan…")),
      "the composer line is live while an idle round runs",
    );
    assert.ok(
      lines.some((line) => line.includes(REVIEW_RUNNING_HINT)),
      "the terminal widget carries the pause/abort hints",
    );
    const reviewStatus = latestStatus(b.statusCalls, "workflow-review");
    assert.ok(
      typeof reviewStatus === "string" &&
        reviewStatus.includes(REVIEW_RUNNING_HINT),
      "workflow-review carries the same live line as the widget",
    );
    const call = [...b.widgetCalls]
      .reverse()
      .find((entry) => entry.key === "workflow-review-status");
    assert.ok(Array.isArray(call?.value), "the widget payload is a plain string[]");
    assert.deepEqual(
      (call?.options as { placement?: string } | undefined)?.placement,
      "aboveEditor",
    );

    releases.shift()?.();
    await running;
    assert.ok(
      renderReviewWidget(b.widgetCalls).some((line) =>
        line.includes(REVIEW_HANDOFF_LINE),
      ),
      "the finished round moves to the handoff line",
    );
  } finally {
    releaseAll(releases);
    await b.cleanup();
  }
});

test("T2: a Desktop-shaped host gets the status line but no widget", async () => {
  const releases: Array<() => void> = [];
  const b = await boot({
    enabled: false,
    hasUI: true,
    plannotator: true,
    isTerminalHost: false,
    script: {
      pass1: async (c) => {
        await new Promise<void>((resolve) => releases.push(resolve));
        await submitThenFinish(REWRITTEN_PLAN)(c);
      },
    },
  });
  try {
    const plan = placePlan(b.cwd, "desktop-widget.md");
    const running = runReview(b.pi, b.ctx, plan.rel);
    await waitForPrompts(b.capture, 1);
    assert.deepEqual(
      renderReviewWidget(b.widgetCalls),
      [],
      "Desktop already renders the idle working message as its working row",
    );
    assert.ok(
      b.workingMessages.includes(REVIEW_RUNNING_LINE),
      "the working row input carries the hints",
    );
    assert.ok(b.workingVisible.includes(true), "the working row was shown");
    const reviewStatus = latestStatus(b.statusCalls, "workflow-review");
    assert.ok(
      typeof reviewStatus === "string" &&
        reviewStatus.includes(REVIEW_RUNNING_HINT),
      "the Desktop host still receives the native status line",
    );

    releases.shift()?.();
    await running;
  } finally {
    releaseAll(releases);
    await b.cleanup();
  }
});

test("T3: a terminal automatic review adds no second live line", async () => {
  const releases: Array<() => void> = [];
  const b = await boot({
    hasUI: true,
    plannotator: true,
    // Inside agent_end the run is still active: Pi's own working row owns the
    // line, so the extension must not add a duplicate.
    idle: false,
    script: {
      pass1: async (c) => {
        await new Promise<void>((resolve) => releases.push(resolve));
        await submitThenFinish(REWRITTEN_PLAN)(c);
      },
    },
  });
  try {
    await freshPrompt(b.pi, b.ctx);
    await switchToPlan(b.pi, b.ctx);
    const plan = placePlan(b.cwd, "terminal-auto.md");
    await writeResult(b.pi, b.ctx, plan.rel);
    const handoff = b.pi.emit(
      "agent_end",
      { messages: runMessages(plan.rel) },
      b.ctx,
    );
    await waitForPrompts(b.capture, 1);
    assert.deepEqual(
      renderReviewWidget(b.widgetCalls),
      [],
      "the run's working row already shows the message",
    );
    assert.ok(b.workingMessages.includes(REVIEW_RUNNING_LINE));

    releases.shift()?.();
    await handoff;
  } finally {
    releaseAll(releases);
    await b.cleanup();
  }
});

test("T4: pause/resume moves the terminal widget between forms", async () => {
  const releases: Array<() => void> = [];
  const b = await boot({
    enabled: false,
    hasUI: true,
    plannotator: true,
    script: {
      pass1: async (c) => {
        await new Promise<void>((resolve) => releases.push(resolve));
        await submitThenFinish(REWRITTEN_PLAN)(c);
      },
    },
  });
  try {
    const plan = placePlan(b.cwd, "terminal-pause.md");
    const running = runReview(b.pi, b.ctx, plan.rel);
    await waitForPrompts(b.capture, 1);
    await b.pi.commands["review-pause"].handler("", b.ctx);
    releases.shift()?.();
    await waitFor(() =>
      renderReviewWidget(b.widgetCalls).some((line) =>
        line.includes("Review paused"),
      ),
    );
    assert.ok(
      renderReviewWidget(b.widgetCalls).some((line) =>
        line.includes(REVIEW_PAUSED_LINE),
      ),
      "the paused form is painted with both hints",
    );
    const pausedStatus = latestStatus(b.statusCalls, "workflow-review");
    assert.ok(
      typeof pausedStatus === "string" &&
        pausedStatus.includes(REVIEW_PAUSED_LINE),
      "workflow-review carries the full paused line",
    );
    await running;

    const resumed = b.pi.commands["review-resume"].handler("", b.ctx);
    await waitForPrompts(b.capture, 2);
    assert.ok(
      renderReviewWidget(b.widgetCalls).some((line) =>
        line.includes(REVIEW_RUNNING_HINT),
      ),
      "the running form returns after /review-resume",
    );
    releases.shift()?.();
    await resumed;
    assert.deepEqual(
      renderReviewWidget(b.widgetCalls),
      [`${REVIEW_HANDOFF_LINE} · 🔒 modes locked`],
      "the finished round moves the widget to the handoff line",
    );
  } finally {
    releaseAll(releases);
    await b.cleanup();
  }
});

test("T5: /review-abort moves the terminal widget to the handoff line", async () => {
  const releases: Array<() => void> = [];
  const b = await boot({
    enabled: false,
    hasUI: true,
    plannotator: true,
    script: {
      pass1: async (c) => {
        await new Promise<void>((resolve) => releases.push(resolve));
        await submitThenFinish(REWRITTEN_PLAN)(c);
      },
    },
  });
  try {
    const plan = placePlan(b.cwd, "terminal-abort.md");
    const running = runReview(b.pi, b.ctx, plan.rel);
    await waitForPrompts(b.capture, 1);
    assert.ok(renderReviewWidget(b.widgetCalls).length > 0);

    await b.pi.commands["review-abort"].handler("", b.ctx);
    releases.shift()?.();
    await running;
    assert.ok(
      renderReviewWidget(b.widgetCalls).some((line) =>
        line.includes(REVIEW_HANDOFF_LINE),
      ),
      "the abort hands off with the skip hint, not a stale running line",
    );
    const reviewStatus = latestStatus(b.statusCalls, "workflow-review");
    assert.ok(
      typeof reviewStatus === "string" &&
        reviewStatus.includes(REVIEW_HANDOFF_LINE),
      "the review status names the handoff",
    );
  } finally {
    releaseAll(releases);
    await b.cleanup();
  }
});

test("R5: reload during a running round returns to Plan, no phantom Review", async () => {
  const b = await boot({ hasUI: true, plannotator: true, customAnswers: [executionAnswer("build")] });
  try {
    const plan = placePlan(b.cwd, "reload-running.md");
    const branch = [
      {
        type: "custom",
        customType: "workflow",
        data: {
          mode: "plan",
          planFile: plan.abs,
          todos: [],
          awaitingDecision: false,
        },
      },
    ];
    const made = makeFakeCtx({ cwd: b.cwd, hasUI: true, branch });
    await b.pi.emit("session_start", { reason: "reload" }, made.ctx);
    assert.ok(
      !made.statuses.some(
        (value) => typeof value === "string" && value.includes("🔍 review"),
      ),
      "a running round cannot survive the reload as Review",
    );
    assert.ok(
      made.statuses.some(
        (value) => typeof value === "string" && value.includes("⏸ plan"),
      ),
      "the reloaded session returns to Plan",
    );
  } finally {
    await b.cleanup();
  }
});

test("W: Build -> Plan -> a new plan gets a fresh review", async () => {
  const b = await boot({ hasUI: true, plannotator: true, customAnswers: [executionAnswer("build")] });
  try {
    await freshPrompt(b.pi, b.ctx);
    await switchToPlan(b.pi, b.ctx);
    const first = placePlan(b.cwd, "loop-first.md");
    await writeResult(b.pi, b.ctx, first.rel);
    await b.pi.emit("agent_end", { messages: runMessages(first.rel) }, b.ctx);
    assert.equal(b.plannotatorRequests.length, 1);

    b.pi.events.emit("plannotator:review-result", {
      reviewId: "review-1",
      approved: true,
    });
    await waitFor(() =>
      b.pi.sent.some((s: any) =>
        JSON.stringify(s.content).includes("Execute the plan"),
      ),
    );
    assert.ok(
      b.statuses.some(
        (value) => typeof value === "string" && value.includes("▶ build"),
      ),
      "Build started",
    );

    // Build -> Plan -> a new plan. The next review must not be suppressed by
    // the previous plan's budget or hash.
    await b.pi.commands.plan.handler("", b.ctx);
    await freshPrompt(b.pi, b.ctx);
    const second = placePlan(b.cwd, "loop-second.md");
    await writeResult(b.pi, b.ctx, second.rel);
    await b.pi.emit("agent_end", { messages: runMessages(second.rel) }, b.ctx);
    assert.equal(b.capture.prompts.length, 2, "the new plan was reviewed");
    assert.equal(b.plannotatorRequests.length, 2, "the new plan handed off");
    assert.ok(
      b.pi.entries.some(
        (e: any) =>
          e.type === "workflow-review-cycle" && e.data?.reason === "prompt",
      ),
      "the new Plan cycle is recorded",
    );
  } finally {
    await b.cleanup();
  }
});

test("X: closing the browser review falls back to the native handoff", async () => {
  const b = await boot({
    hasUI: true,
    plannotator: true,
    customAnswer: handoffAnswer("approve"),
  });
  try {
    await freshPrompt(b.pi, b.ctx);
    await switchToPlan(b.pi, b.ctx);
    const plan = placePlan(b.cwd, "close-review.md");
    await writeResult(b.pi, b.ctx, plan.rel);
    await b.pi.emit("agent_end", { messages: runMessages(plan.rel) }, b.ctx);
    assert.equal(b.plannotatorRequests.length, 1, "the browser review opened");
    assert.equal(b.customs.length, 0, "the browser owned the decision");

    b.pi.events.emit("plannotator:session-closed", {
      reviewId: "review-1",
      outcome: "closed",
    });
    await waitFor(() =>
      b.pi.sent.some((s: any) =>
        JSON.stringify(s.content).includes("Execute the plan"),
      ),
    );
    assert.equal(b.customs.length, 2, "plan approval + execution chooser opened");
    assert.ok(
      b.pi.entries.some((e: any) => e.type === "workflow-handoff-plan"),
      "the plan was printed into the transcript",
    );
    assert.ok(
      b.pi.entries.some(
        (e: any) =>
          e.type === "workflow-handoff-result" &&
          e.data?.choice === "execute" &&
          e.data?.source === "native",
      ),
      "the execute choice is attributed to the native handoff",
    );
    assert.ok(
      b.statuses.some(
        (value) => typeof value === "string" && value.includes("▶ build"),
      ),
      "the native handoff executed and entered Build",
    );
  } finally {
    await b.cleanup();
  }
});

test("Y: dismissing the closed-review handoff does not stick Review", async () => {
  const b = await boot({ hasUI: true, plannotator: true, customAnswer: null });
  try {
    await freshPrompt(b.pi, b.ctx);
    await switchToPlan(b.pi, b.ctx);
    const plan = placePlan(b.cwd, "close-cancel.md");
    await writeResult(b.pi, b.ctx, plan.rel);
    await b.pi.emit("agent_end", { messages: runMessages(plan.rel) }, b.ctx);
    b.pi.events.emit("plannotator:session-closed", {
      reviewId: "review-1",
      outcome: "closed",
    });
    await waitFor(() => notified(b.notifies, "Dismissed. Type your follow-up."));
    assert.ok(
      notified(b.notifies, "Dismissed. Type your follow-up."),
      "the native handoff was dismissed",
    );
    const modes = b.statuses.filter(
      (value): value is string =>
        typeof value === "string" &&
        (value.includes("🔍 review") ||
          value.includes("⏸ plan") ||
          value.includes("▶ build")),
    );
    assert.ok(
      modes.at(-1)?.includes("⏸ plan"),
      `cancelling returns to Plan, got ${modes.at(-1)}`,
    );
    // The turn must be closed: prompts and modes are accepted again.
    const input = await b.pi.emit(
      "input",
      { text: "do the next thing", source: "interactive" },
      b.ctx,
    );
    assert.deepEqual(input[0], { action: "continue" });
    await b.pi.commands["review-abort"].handler("", b.ctx);
    assert.ok(notified(b.notifies, "Nothing to abort"));
  } finally {
    await b.cleanup();
  }
});

// ── Native handoff fallback (2026-11-15 plan) ────────────────────────

test("HF1: a Plannotator error falls back to the native handoff", async () => {
  const b = await boot({
    hasUI: true,
    plannotator: true,
    plannotatorError: true,
    customAnswer: handoffAnswer("skip"),
  });
  try {
    await freshPrompt(b.pi, b.ctx);
    await switchToPlan(b.pi, b.ctx);
    const plan = placePlan(b.cwd, "hf1-plannotator-error.md");
    await writeResult(b.pi, b.ctx, plan.rel);
    await b.pi.emit("agent_end", { messages: runMessages(plan.rel) }, b.ctx);

    assert.equal(b.plannotatorRequests.length, 1, "the browser was tried once");
    assert.equal(b.customs.length, 1, "the native questionnaire opened");
    const printed = b.pi.entries.find(
      (e: any) => e.type === "workflow-handoff-plan",
    );
    assert.ok(printed, "the plan was printed into the transcript");
    assert.ok(
      String((printed as any).data?.planText).includes("Result<string, ExportError>"),
      "the reviewed plan is in the entry",
    );
    assert.ok(
      !b.pi.sent.some((s: any) =>
        JSON.stringify(s.content).includes("Execute the plan"),
      ),
      "skip sent no execute turn",
    );
    assert.ok(
      notified(b.notifies, "Plannotator handoff unavailable"),
      "the failure is announced",
    );
    await b.pi.commands["review-abort"].handler("", b.ctx);
    assert.ok(notified(b.notifies, "Nothing to abort"), "the turn is closed");
  } finally {
    await b.cleanup();
  }
});

test("HF2: approving the native handoff enters Build before execute", async () => {
  const b = await boot({ hasUI: true, customAnswer: handoffAnswer("approve") });
  try {
    await freshPrompt(b.pi, b.ctx);
    await switchToPlan(b.pi, b.ctx);
    const plan = placePlan(b.cwd, "hf2-approve.md");
    await writeResult(b.pi, b.ctx, plan.rel);
    await b.pi.emit("agent_end", { messages: runMessages(plan.rel) }, b.ctx);
    assert.equal(b.customs.length, 2, "plan approval + execution chooser opened");
    await waitFor(() =>
      b.pi.sent.some((s: any) =>
        JSON.stringify(s.content).includes("Execute the plan"),
      ),
    );
    const toolIdx = b.pi.timeline.findIndex(
      (t: any) => t.kind === "tools" && (t.tools ?? []).includes("edit"),
    );
    const sendIdx = b.pi.timeline.findIndex(
      (t: any) =>
        t.kind === "send" &&
        JSON.stringify(t.content).includes("Execute the plan"),
    );
    assert.ok(toolIdx >= 0, "the tool set was swapped to Build");
    assert.ok(sendIdx > toolIdx, "execute was sent after the Build swap");
    assert.ok(
      b.statuses.some(
        (value) => typeof value === "string" && value.includes("▶ build"),
      ),
      "the session is in Build mode",
    );
  } finally {
    await b.cleanup();
  }
});

test("HF3: a failed Build entry drops the execute turn", async () => {
  const b = await boot({ hasUI: true, customAnswer: handoffAnswer("approve") });
  const realSetActiveTools = b.pi.setActiveTools.bind(b.pi);
  try {
    await freshPrompt(b.pi, b.ctx);
    await switchToPlan(b.pi, b.ctx);
    const plan = placePlan(b.cwd, "hf3-build-fails.md");
    await writeResult(b.pi, b.ctx, plan.rel);
    (b.pi as any).setActiveTools = () => {
      throw new Error("tools boom");
    };
    await b.pi.emit("agent_end", { messages: runMessages(plan.rel) }, b.ctx);

    assert.ok(
      notified(b.notifies, "Could not enter Build mode") ||
        notified(b.notifies, "Build was not entered"),
      "the Build failure is reported",
    );
    assert.ok(
      !b.pi.sent.some((s: any) =>
        JSON.stringify(s.content).includes("Execute the plan"),
      ),
      "no execute turn was sent",
    );
    const lastMode = [...b.pi.entries]
      .reverse()
      .find((e: any) => e.type === "workflow" && e.data?.mode) as any;
    assert.notEqual(lastMode?.data?.mode, "build", "the session stayed in Plan mode");
    assert.ok(
      b.pi.entries.some(
        (e: any) => e.type === "workflow-review-turn-closed",
      ),
      "the review turn was closed",
    );
  } finally {
    (b.pi as any).setActiveTools = realSetActiveTools;
    await b.cleanup();
  }
});

test("HF4: /review-abort exits a pending browser handoff locally", async () => {
  const b = await boot({
    hasUI: true,
    plannotator: true,
    customAnswer: handoffAnswer("skip"),
  });
  try {
    await freshPrompt(b.pi, b.ctx);
    await switchToPlan(b.pi, b.ctx);
    const plan = placePlan(b.cwd, "hf4-abort-handoff.md");
    await writeResult(b.pi, b.ctx, plan.rel);
    await b.pi.emit("agent_end", { messages: runMessages(plan.rel) }, b.ctx);
    assert.equal(b.plannotatorRequests.length, 1, "the browser review opened");
    assert.equal(b.customs.length, 0, "the browser owned the decision");

    await b.pi.commands["review-abort"].handler("", b.ctx);
    assert.equal(
      b.plannotatorRequests.length,
      1,
      "abort never re-opened the browser",
    );
    assert.equal(b.customs.length, 1, "the native handoff opened");
    assert.ok(
      b.pi.entries.some((e: any) => e.type === "workflow-handoff-plan"),
      "the plan was printed into the transcript",
    );

    await b.pi.commands["review-abort"].handler("", b.ctx);
    assert.ok(
      notified(b.notifies, "Nothing to abort"),
      "a second abort is a no-op, not a soft-lock",
    );
  } finally {
    await b.cleanup();
  }
});

test("HF5: dismissing a native handoff releases prompts and modes", async () => {
  const b = await boot({ hasUI: true, customAnswer: null });
  try {
    await freshPrompt(b.pi, b.ctx);
    await switchToPlan(b.pi, b.ctx);
    const plan = placePlan(b.cwd, "hf5-dismiss.md");
    await writeResult(b.pi, b.ctx, plan.rel);
    await b.pi.emit("agent_end", { messages: runMessages(plan.rel) }, b.ctx);
    assert.ok(notified(b.notifies, "Dismissed. Type your follow-up."));

    const input = await b.pi.emit(
      "input",
      { text: "carry on", source: "interactive" },
      b.ctx,
    );
    assert.deepEqual(input[0], { action: "continue" });
    await b.pi.commands["review-abort"].handler("", b.ctx);
    assert.ok(notified(b.notifies, "Nothing to abort"));
    await b.pi.commands.build.handler("", b.ctx);
    assert.ok(
      b.statuses.some(
        (value) => typeof value === "string" && value.includes("▶ build"),
      ),
      "a mode switch works after dismissal",
    );
  } finally {
    await b.cleanup();
  }
});

test("HF6: a manual /review falls back natively when Plannotator errors", async () => {
  const b = await boot({
    enabled: false,
    hasUI: true,
    plannotator: true,
    plannotatorError: true,
    customAnswer: handoffAnswer("skip"),
  });
  try {
    const plan = placePlan(b.cwd, "hf6-manual.md");
    await runReview(b.pi, b.ctx, plan.rel);
    assert.equal(b.customs.length, 1, "the native questionnaire opened");
    assert.ok(notified(b.notifies, "Plannotator handoff unavailable"));
    assert.ok(
      b.pi.entries.some((e: any) => e.type === "workflow-handoff-plan"),
      "the plan was printed into the transcript",
    );
    await b.pi.commands["review-abort"].handler("", b.ctx);
    assert.ok(notified(b.notifies, "Nothing to abort"), "no stale turn");
  } finally {
    await b.cleanup();
  }
});

test("HF7: resuming a paused review falls back natively", async () => {
  const releases: Array<() => void> = [];
  const b = await boot({
    hasUI: true,
    plannotator: true,
    plannotatorError: true,
    customAnswer: handoffAnswer("skip"),
    script: {
      pass1: async (c) => {
        await new Promise<void>((resolve) => releases.push(resolve));
        await submitThenFinish(REWRITTEN_PLAN)(c);
      },
    },
  });
  try {
    await freshPrompt(b.pi, b.ctx);
    await switchToPlan(b.pi, b.ctx);
    const plan = placePlan(b.cwd, "hf7-resume.md");
    await writeResult(b.pi, b.ctx, plan.rel);
    const handoff = b.pi.emit(
      "agent_end",
      { messages: runMessages(plan.rel) },
      b.ctx,
    );
    await waitFor(() => b.capture.prompts.length >= 1);
    await b.pi.commands["review-pause"].handler("", b.ctx);
    releases.shift()?.();
    await waitFor(() =>
      b.statuses.some(
        (value) =>
          typeof value === "string" && value.includes("🔍 review — paused"),
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 60));

    const resumed = b.pi.commands["review-resume"].handler("", b.ctx);
    await waitFor(() => b.capture.prompts.length >= 2);
    releases.shift()?.();
    await resumed;
    await handoff;

    assert.ok(b.customs.length >= 1, "the native fallback opened");
    assert.ok(
      b.pi.entries.some((e: any) => e.type === "workflow-handoff-plan"),
      "the plan was printed into the transcript",
    );
  } finally {
    while (releases.length > 0) releases.shift()?.();
    await b.cleanup();
  }
});

test("HF8: a headless handoff closes the review turn", async () => {
  const b = await boot({ hasUI: false, enabled: true });
  try {
    await freshPrompt(b.pi, b.ctx);
    await switchToPlan(b.pi, b.ctx);
    const plan = placePlan(b.cwd, "hf8-headless.md");
    await writeResult(b.pi, b.ctx, plan.rel);
    await b.pi.emit("agent_end", { messages: runMessages(plan.rel) }, b.ctx);

    assert.equal(b.customs.length, 0, "no modal on a headless host");
    assert.ok(
      b.pi.sent.some(
        (s: any) => (s.content as any)?.customType === "workflow-handoff-fallback",
      ),
      "the headless fallback message was sent",
    );
    assert.ok(
      b.pi.entries.some(
        (e: any) =>
          e.type === "workflow-review-turn-closed" &&
          e.data?.reason === "headless-handoff",
      ),
      "the review turn was closed",
    );
    await b.pi.commands["review-abort"].handler("", b.ctx);
    // The headless decision stays pending after the turn closes (that is what
    // makes /handoff approve possible). Assert the REVIEW turn is idle rather
    // than the old "nothing to abort" wording, which no longer describes it.
    b.notifies.length = 0;
    await b.pi.commands["review-status"].handler("", b.ctx);
    const status = b.notifies.at(-1)?.message ?? "";
    assert.match(status, /turn\s*:\s*idle/, "no review turn is left running");
    assert.ok(!/running|paused/.test(status), "no review lock is left");
  } finally {
    await b.cleanup();
  }
});

test("HF9: aborting a paused gated review presents exactly once", async () => {
  const releases: Array<() => void> = [];
  const b = await boot({
    hasUI: true,
    plannotator: true,
    script: {
      pass1: async (c) => {
        await new Promise<void>((resolve) => releases.push(resolve));
        await submitThenFinish(REWRITTEN_PLAN)(c);
      },
    },
  });
  try {
    await freshPrompt(b.pi, b.ctx);
    await switchToPlan(b.pi, b.ctx);
    const plan = placePlan(b.cwd, "hf9-paused-gated.md");
    await writeResult(b.pi, b.ctx, plan.rel);
    const handoff = b.pi.emit(
      "agent_end",
      { messages: runMessages(plan.rel) },
      b.ctx,
    );
    await waitFor(() => b.capture.prompts.length >= 1);
    await b.pi.commands["review-pause"].handler("", b.ctx);
    releases.shift()?.();
    await waitFor(() =>
      b.statuses.some(
        (value) =>
          typeof value === "string" && value.includes("🔍 review — paused"),
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(b.plannotatorRequests.length, 0, "no handoff while paused");

    await b.pi.commands["review-abort"].handler("", b.ctx);
    await handoff;
    assert.equal(
      b.plannotatorRequests.length,
      1,
      "the parked handoff presented once, never twice",
    );
    assert.equal(b.customs.length, 0, "no second native modal was stacked");
  } finally {
    while (releases.length > 0) releases.shift()?.();
    await b.cleanup();
  }
});

// ── Handoff target toggle (workflow.handoff, 2026-11-15 plan) ────────

test("HD1: auto + a detected host opens the browser handoff", async () => {
  const b = await boot({ hasUI: true, plannotator: true, customAnswers: [executionAnswer("build")] });
  try {
    await freshPrompt(b.pi, b.ctx);
    await switchToPlan(b.pi, b.ctx);
    const plan = placePlan(b.cwd, "hd1-auto-browser.md");
    await writeResult(b.pi, b.ctx, plan.rel);
    await b.pi.emit("agent_end", { messages: runMessages(plan.rel) }, b.ctx);

    assert.equal(b.plannotatorRequests.length, 1, "the browser was asked");
    assert.equal(b.customs.length, 0, "the native modal stayed closed");
  } finally {
    await b.cleanup();
  }
});

test("HD2: auto + no host goes native immediately, without a warning", async () => {
  const b = await boot({ hasUI: true, customAnswer: handoffAnswer("approve") });
  try {
    await freshPrompt(b.pi, b.ctx);
    await switchToPlan(b.pi, b.ctx);
    const plan = placePlan(b.cwd, "hd2-auto-native.md");
    await writeResult(b.pi, b.ctx, plan.rel);
    await b.pi.emit("agent_end", { messages: runMessages(plan.rel) }, b.ctx);

    assert.equal(
      b.plannotatorRequests.length,
      0,
      "no request was emitted without a host",
    );
    assert.equal(b.customs.length, 2, "plan approval + execution chooser opened");
    assert.ok(
      !notified(b.notifies, "Plannotator handoff unavailable"),
      "an intentional native handoff is not a failure",
    );
    assert.ok(
      !b.pi.entries.some(
        (e: any) => e.type === "workflow-handoff-plannotator-failed",
      ),
      "no failure entry was written",
    );
    await waitFor(() =>
      b.pi.sent.some((s: any) =>
        JSON.stringify(s.content).includes("Execute the plan"),
      ),
    );
    assert.ok(
      b.pi.sent.some((s: any) =>
        JSON.stringify(s.content).includes("Execute the plan"),
      ),
      "approving still starts the execute turn",
    );
  } finally {
    await b.cleanup();
  }
});

test("HD3: handoff=native never opens the browser even with a host", async () => {
  const b = await boot({
    hasUI: true,
    plannotator: true,
    settings: { workflow: { handoff: "native" } },
    customAnswer: handoffAnswer("approve"),
  });
  try {
    await freshPrompt(b.pi, b.ctx);
    await switchToPlan(b.pi, b.ctx);
    const plan = placePlan(b.cwd, "hd3-native-host.md");
    await writeResult(b.pi, b.ctx, plan.rel);
    await b.pi.emit("agent_end", { messages: runMessages(plan.rel) }, b.ctx);

    assert.equal(b.plannotatorRequests.length, 0, "the bus was not used");
    assert.equal(
      b.customs.length,
      2,
      "the native plan question and the execution chooser opened",
    );
    await waitFor(() =>
      b.pi.sent.some((s: any) =>
        JSON.stringify(s.content).includes("Execute the plan"),
      ),
    );
    assert.ok(
      b.statuses.some(
        (value) => typeof value === "string" && value.includes("▶ build"),
      ),
      "approval entered Build",
    );
  } finally {
    await b.cleanup();
  }
});

test("HD4: handoff=plannotator forces the attempt and falls back", async () => {
  const b = await boot({
    hasUI: true,
    settings: { workflow: { handoff: "plannotator" } },
    customAnswer: handoffAnswer("skip"),
  });
  try {
    await freshPrompt(b.pi, b.ctx);
    await switchToPlan(b.pi, b.ctx);
    const plan = placePlan(b.cwd, "hd4-forced.md");
    await writeResult(b.pi, b.ctx, plan.rel);
    await b.pi.emit("agent_end", { messages: runMessages(plan.rel) }, b.ctx);

    assert.ok(
      b.pi.entries.some(
        (e: any) => e.type === "workflow-handoff-plannotator-failed",
      ),
      "the attempt was forced even without a detected host",
    );
    assert.equal(b.customs.length, 1, "the native fallback opened");
    assert.ok(
      notified(b.notifies, "Plannotator handoff unavailable"),
      "the forced-mode failure is announced",
    );
    assert.ok(
      b.pi.entries.some(
        (e: any) => e.type === "workflow-handoff-plannotator-failed",
      ),
      "the failed attempt is recorded",
    );
  } finally {
    await b.cleanup();
  }
});

test("HD5: stale browser approvals are ignored in native mode", async () => {
  const b = await boot({
    hasUI: true,
    plannotator: true,
    settings: { workflow: { handoff: "native" } },
    customAnswer: handoffAnswer("skip"),
  });
  try {
    await freshPrompt(b.pi, b.ctx);
    await switchToPlan(b.pi, b.ctx);
    const plan = placePlan(b.cwd, "hd5-stale-approve.md");
    await writeResult(b.pi, b.ctx, plan.rel);
    await b.pi.emit("agent_end", { messages: runMessages(plan.rel) }, b.ctx);
    assert.equal(b.customs.length, 1, "the native handoff opened");

    b.pi.events.emit("plannotator:review-result", {
      reviewId: "review-1",
      approved: true,
    });
    b.pi.events.emit("plannotator:plan-approved", {
      planFilePath: plan.abs,
      planContent: ORIGINAL_PLAN,
    });
    await new Promise((resolve) => setTimeout(resolve, 40));

    assert.ok(
      !b.pi.sent.some((s: any) =>
        JSON.stringify(s.content).includes("Execute the plan"),
      ),
      "a leftover tab cannot start the execute turn",
    );
    const lastMode = [...b.pi.entries]
      .reverse()
      .find((e: any) => e.type === "workflow" && e.data?.mode) as any;
    assert.notEqual(lastMode?.data?.mode, "build", "the session stayed in Plan mode");
  } finally {
    await b.cleanup();
  }
});

test("HD6: reload in native mode clears a pending browser gate", async () => {
  const { b, made } = await reloadWithPending(
    { "review-1": { status: "pending" } },
    { settings: { workflow: { handoff: "native" } } },
  );
  try {
    await waitFor(() =>
      b.pi.entries.some(
        (e: any) =>
          e.type === "workflow-handoff-recovery" && e.data?.action === "clear",
      ),
    );
    assert.deepEqual(
      b.reviewStatusRequests,
      [],
      "native mode never queries the browser",
    );
    const cleared = b.pi.entries.find(
      (e: any) =>
        e.type === "workflow-handoff-recovery" && e.data?.action === "clear",
    );
    assert.ok(cleared, "the stale gate was cleared");
    assert.equal((cleared as any).data?.mode, "native");
    assert.ok(
      !notified(made.notifies, "Browser review still open"),
      "no browser prompt is announced",
    );
    const modes = made.statuses.filter(
      (value): value is string =>
        typeof value === "string" &&
        (value.includes("🔍 review") ||
          value.includes("⏸ plan") ||
          value.includes("▶ build")),
    );
    assert.ok(
      modes.at(-1)?.includes("⏸ plan"),
      `the cleared gate returns to the author mode, got ${modes.at(-1)}`,
    );
  } finally {
    await b.cleanup();
  }
});

test("HD7: headless native handoff uses the text fallback, not SSH hint", async () => {
  const b = await boot({
    hasUI: false,
    enabled: true,
    settings: { workflow: { handoff: "native" } },
  });
  try {
    await freshPrompt(b.pi, b.ctx);
    await switchToPlan(b.pi, b.ctx);
    const plan = placePlan(b.cwd, "hd7-headless.md");
    await writeResult(b.pi, b.ctx, plan.rel);
    await b.pi.emit("agent_end", { messages: runMessages(plan.rel) }, b.ctx);

    const fallback = b.pi.sent.find(
      (s: any) => (s.content as any)?.customType === "workflow-handoff-fallback",
    );
    assert.ok(fallback, "the headless fallback message was sent");
    const text = JSON.stringify((fallback as any).content);
    assert.ok(
      text.includes("/handoff approve handoff-"),
      "the headless message names the exact approval command and decision id",
    );
    assert.ok(
      text.includes("Nothing executes until you approve"),
      "headless never implies automatic execution",
    );
    assert.ok(!text.includes("SSH port forwarding"), "no browser hint");
    assert.ok(!text.includes("PLANNOTATOR_REMOTE"), "no bridge env hint");
    assert.ok(
      b.pi.entries.some(
        (e: any) =>
          e.type === "workflow-review-turn-closed" &&
          e.data?.reason === "headless-handoff",
      ),
      "the review turn was closed",
    );
  } finally {
    await b.cleanup();
  }
});

test("HD8: /handoff reports status and writes the requested scope", async () => {
  const b = await boot({ hasUI: true });
  const settingsPath = path.join(b.cwd, ".pi", "settings.json");
  try {
    await b.pi.commands.handoff.handler("", b.ctx);
    assert.ok(notified(b.notifies, "Handoff: auto (default)"));
    assert.ok(notified(b.notifies, "no Plannotator host detected"));
    assert.ok(notified(b.notifies, "effective: native questionnaire"));

    await b.pi.commands.handoff.handler("sideways", b.ctx);
    assert.ok(notified(b.notifies, "Usage: /handoff auto|native|plannotator"));

    await b.pi.commands.handoff.handler("native project", b.ctx);
    let settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    assert.deepEqual(settings.workflow.handoff, {
      mode: "native",
      executionMode: "build",
    });
    assert.equal(
      settings.workflow.reviewMode.enabled,
      true,
      "the review config was preserved",
    );
    assert.ok(notified(b.notifies, "Handoff → native (project)"));

    await b.pi.commands.handoff.handler("auto global", b.ctx);
    const globalPath = path.join(b.agentDir, "settings.json");
    const global = JSON.parse(fs.readFileSync(globalPath, "utf8"));
    assert.equal(global.workflow.handoff.mode, "auto");
    assert.equal(
      global.workflow.handoff.executionMode,
      undefined,
      "a presenter write stays sparse and does not pin the destination",
    );
    settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    assert.deepEqual(
      settings.workflow.handoff,
      { mode: "native", executionMode: "build" },
      "the project override is unchanged",
    );
    assert.ok(notified(b.notifies, "Handoff → auto (global)"));
  } finally {
    await b.cleanup();
  }
});

test("HD9: /handoff refuses to switch while a decision is pending", async () => {
  const b = await boot({ hasUI: true, plannotator: true, customAnswers: [executionAnswer("build")] });
  const settingsPath = path.join(b.cwd, ".pi", "settings.json");
  try {
    await freshPrompt(b.pi, b.ctx);
    await switchToPlan(b.pi, b.ctx);
    const plan = placePlan(b.cwd, "hd9-pending.md");
    await writeResult(b.pi, b.ctx, plan.rel);
    await b.pi.emit("agent_end", { messages: runMessages(plan.rel) }, b.ctx);
    assert.equal(b.plannotatorRequests.length, 1, "the browser owns the gate");

    const beforeWrite = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    await b.pi.commands.handoff.handler("native", b.ctx);
    assert.ok(notified(b.notifies, "A handoff prompt is open"));
    let settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    assert.deepEqual(
      settings.workflow.handoff,
      beforeWrite.workflow.handoff,
      "the refused write changed nothing",
    );

    await b.pi.commands["review-abort"].handler("", b.ctx);
    await b.pi.commands.handoff.handler("native project", b.ctx);
    settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    assert.deepEqual(settings.workflow.handoff, {
      mode: "native",
      executionMode: "build",
    });
  } finally {
    await b.cleanup();
  }
});

test("HD12: /handoff fallback converts a plain browser handoff to native", async () => {
  const b = await boot({
    enabled: false,
    hasUI: true,
    plannotator: true,
    customAnswer: handoffAnswer("approve"),
  });
  try {
    await freshPrompt(b.pi, b.ctx);
    await switchToPlan(b.pi, b.ctx);
    const plan = placePlan(b.cwd, "hd12-fallback.md");
    await writeResult(b.pi, b.ctx, plan.rel);
    await b.pi.emit("agent_end", { messages: runMessages(plan.rel) }, b.ctx);
    assert.equal(b.plannotatorRequests.length, 1, "the browser owns the plain handoff");
    assert.ok(
      !b.statuses.some(
        (value) => typeof value === "string" && value.includes("🔍 review"),
      ),
      "Review Mode off never paints Review",
    );
    assert.ok(
      b.statuses.some(
        (value) =>
          typeof value === "string" &&
          value.includes("⏸ plan") &&
          value.includes("handoff pending"),
      ),
      "the footer names the plain handoff",
    );

    await b.pi.commands.handoff.handler("fallback", b.ctx);
    assert.ok(b.customs.length >= 1, "the native questionnaire opened");
    assert.equal(
      b.pi.entries.filter((e: any) => e.type === "workflow-handoff-plan")
        .length,
      1,
      "the plan printed exactly once",
    );
    await waitFor(() =>
      b.statuses.some(
        (value) => typeof value === "string" && value.includes("▶ build"),
      ),
    );
    assert.ok(
      b.pi.sent.some((s: any) =>
        JSON.stringify(s.content).includes("Execute the plan"),
      ),
      "approve entered Build and sent execute",
    );
    await b.pi.commands.handoff.handler("fallback", b.ctx);
    assert.ok(
      notified(b.notifies, "Nothing to fall back"),
      "a repeat is idempotent",
    );
  } finally {
    await b.cleanup();
  }
});

test("HD13: /review-mode off downgrades a plain handoff and keeps the browser decision", async () => {
  const b = await boot({ enabled: false, hasUI: true, plannotator: true, customAnswers: [executionAnswer("build")] });
  try {
    await freshPrompt(b.pi, b.ctx);
    await switchToPlan(b.pi, b.ctx);
    const plan = placePlan(b.cwd, "hd13-plain-off.md");
    await writeResult(b.pi, b.ctx, plan.rel);
    await b.pi.emit("agent_end", { messages: runMessages(plan.rel) }, b.ctx);
    assert.equal(b.plannotatorRequests.length, 1);

    await b.pi.commands["review-mode"].handler("off", b.ctx);
    assert.ok(notified(b.notifies, "Review Mode disabled"));
    assert.ok(
      b.statuses.some(
        (value) =>
          typeof value === "string" &&
          value.includes("⏸ plan") &&
          value.includes("handoff pending"),
      ),
      "the pending handoff stays visible as a plain decision",
    );
    assert.ok(
      !b.statuses.some(
        (value) => typeof value === "string" && value.includes("🔍 review"),
      ),
      "disabling never paints Review",
    );

    // The browser correlation survives the downgrade: a late approval builds.
    b.pi.events.emit("plannotator:review-result", {
      reviewId: "review-1",
      approved: true,
    });
    await waitFor(() =>
      b.pi.sent.some((s: any) =>
        JSON.stringify(s.content).includes("Execute the plan"),
      ),
    );
    assert.ok(
      b.statuses.some(
        (value) => typeof value === "string" && value.includes("▶ build"),
      ),
      "the late approval still enters Build",
    );
  } finally {
    await b.cleanup();
  }
});

test("HD14: /review-mode off is refused while a reviewer round runs", async () => {
  const releases: Array<() => void> = [];
  const b = await boot({
    hasUI: true,
    plannotator: true,
    script: {
      pass1: async (c) => {
        await new Promise<void>((resolve) => releases.push(resolve));
        await submitThenFinish(REWRITTEN_PLAN)(c);
      },
    },
  });
  try {
    await freshPrompt(b.pi, b.ctx);
    await switchToPlan(b.pi, b.ctx);
    const plan = placePlan(b.cwd, "hd14-running-off.md");
    await writeResult(b.pi, b.ctx, plan.rel);
    const running = b.pi.emit(
      "agent_end",
      { messages: runMessages(plan.rel) },
      b.ctx,
    );
    await waitForPrompts(b.capture, 1);
    await b.pi.commands["review-mode"].handler("off", b.ctx);
    assert.ok(notified(b.notifies, "running or paused"));
    releases.shift()?.();
    await running;
  } finally {
    releaseAll(releases);
    await b.cleanup();
  }
});

test("HD15: /review-mode off downgrades a finished review handoff", async () => {
  const b = await boot({ hasUI: true, plannotator: true, customAnswers: [executionAnswer("build")] });
  try {
    await freshPrompt(b.pi, b.ctx);
    await switchToPlan(b.pi, b.ctx);
    const plan = placePlan(b.cwd, "hd15-review-off.md");
    await writeResult(b.pi, b.ctx, plan.rel);
    await b.pi.emit("agent_end", { messages: runMessages(plan.rel) }, b.ctx);
    assert.equal(b.plannotatorRequests.length, 1);
    assert.ok(
      b.statuses.some(
        (value) =>
          typeof value === "string" &&
          value.includes("🔍 review — awaiting decision"),
      ),
      "the review-owned handoff starts as Review",
    );
    const handoffStatus = latestStatus(b.statusCalls, "workflow-review");
    assert.ok(
      typeof handoffStatus === "string" &&
        handoffStatus.includes(REVIEW_HANDOFF_LINE),
      "workflow-review names the handoff and the abort hint",
    );

    await b.pi.commands["review-mode"].handler("off", b.ctx);
    assert.ok(notified(b.notifies, "Review Mode disabled"));
    assert.ok(
      b.statuses.some(
        (value) =>
          typeof value === "string" &&
          value.includes("⏸ plan") &&
          value.includes("handoff pending"),
      ),
      "the downgraded handoff is a Plan sub-state",
    );

    b.pi.events.emit("plannotator:review-result", {
      reviewId: "review-1",
      approved: true,
    });
    await waitFor(() =>
      b.pi.sent.some((s: any) =>
        JSON.stringify(s.content).includes("Execute the plan"),
      ),
    );
  } finally {
    await b.cleanup();
  }
});

test("HD16: a stale manual cycle does not run a review after startup", async () => {
  const branch = [
    {
      type: "custom",
      customType: "workflow",
      data: {
        mode: "plan",
        todos: [],
        manualReviewCycle: true,
        awaitingDecision: false,
      },
    },
  ];
  const b = await boot({ enabled: false, hasUI: true, plannotator: true, branch });
  try {
    const plan = placePlan(b.cwd, "hd16-stale-manual.md");
    await writeResult(b.pi, b.ctx, plan.rel);
    await b.pi.emit("agent_end", { messages: runMessages(plan.rel) }, b.ctx);
    assert.equal(
      b.capture.prompts.length,
      0,
      "a restored stale manual flag must not run a reviewer",
    );
    assert.equal(
      b.plannotatorRequests.length,
      1,
      "the plain plan handoff still opens",
    );
  } finally {
    await b.cleanup();
  }
});

test("HD17: /review-mode off overrides a project enabled:true", async () => {
  const b = await boot({ hasUI: true });
  try {
    const settingsPath = path.join(b.cwd, ".pi", "settings.json");
    let settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    assert.equal(
      settings.workflow.reviewMode.enabled,
      true,
      "the project override starts ON",
    );
    await b.pi.commands["review-mode"].handler("off", b.ctx);
    settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    assert.equal(
      settings.workflow.reviewMode.enabled,
      false,
      "the project override is made effective",
    );
    assert.ok(notified(b.notifies, "Review Mode disabled"));
  } finally {
    await b.cleanup();
  }
});

test("HD18: a plain handoff carries the plan and does not lock modes/prompts", async () => {
  const b = await boot({ enabled: false, hasUI: true, plannotator: true, customAnswers: [executionAnswer("build")] });
  try {
    await freshPrompt(b.pi, b.ctx);
    await switchToPlan(b.pi, b.ctx);
    const plan = placePlan(b.cwd, "hd18-plain.md");
    await writeResult(b.pi, b.ctx, plan.rel);
    await b.pi.emit("agent_end", { messages: runMessages(plan.rel) }, b.ctx);
    assert.equal(b.plannotatorRequests.length, 1);
    assert.ok(
      String(b.plannotatorRequests[0]?.planContent ?? "").includes(
        "# Plan: Add CSV export",
      ),
      "the browser request carries the plan text",
    );
    assert.ok(
      b.statuses.some(
        (value) =>
          typeof value === "string" &&
          value.includes("handoff pending") &&
          !value.includes("review"),
      ),
      "the footer names the plain handoff",
    );
    const input = await b.pi.emit(
      "input",
      { text: "refine this plan", source: "interactive" },
      b.ctx,
    );
    assert.deepEqual(input[0], { action: "continue" }, "prompts stay free");
    await b.pi.commands.build.handler("", b.ctx);
    assert.ok(
      !notified(b.notifies, "mode switching is locked"),
      "a plain handoff never locks the mode switch",
    );
    assert.ok(
      b.statuses.some(
        (value) => typeof value === "string" && value.includes("▶ build"),
      ),
      "Build was entered",
    );
  } finally {
    await b.cleanup();
  }
});

test("HD19: a forced browser timeout falls back natively without Review", async () => {
  const b = await boot({
    enabled: false,
    hasUI: true,
    settings: { workflow: { handoff: { mode: "plannotator" } } },
    customAnswer: handoffAnswer("skip"),
  });
  try {
    await freshPrompt(b.pi, b.ctx);
    await switchToPlan(b.pi, b.ctx);
    const plan = placePlan(b.cwd, "hd19-timeout.md");
    await writeResult(b.pi, b.ctx, plan.rel);
    await b.pi.emit("agent_end", { messages: runMessages(plan.rel) }, b.ctx);
    assert.ok(b.customs.length >= 1, "the native questionnaire opened");
    assert.ok(
      b.pi.entries.filter((e: any) => e.type === "workflow-handoff-plan")
        .length === 1,
      "the plan printed once",
    );
    assert.ok(
      !b.statuses.some(
        (value) => typeof value === "string" && value.includes("🔍 review"),
      ),
      "the timeout fallback never paints Review",
    );
    await b.pi.commands.build.handler("", b.ctx);
    assert.ok(!notified(b.notifies, "mode switching is locked"));
  } finally {
    await b.cleanup();
  }
});

test("HD20: reload keeps a plain handoff plain and fallback-ready", async () => {
  const { b, made } = await reloadWithPending(
    { "review-1": { status: "pending" } },
    { enabled: false, customAnswer: handoffAnswer("skip") },
    true,
  );
  try {
    await waitFor(() => b.reviewStatusRequests.includes("review-1"));
    assert.ok(
      made.statuses.some(
        (value) =>
          typeof value === "string" &&
          value.includes("handoff pending") &&
          !value.includes("review"),
      ),
      "the restored plain handoff is a Plan sub-state",
    );
    assert.ok(
      !made.statuses.some(
        (value) => typeof value === "string" && value.includes("🔍 review"),
      ),
      "the reload did not resurrect the false Review lock",
    );
    await b.pi.commands.handoff.handler("fallback", made.ctx);
    assert.ok(made.customs.length >= 1, "the native fallback opened after reload");
  } finally {
    await b.cleanup();
  }
});

test("HD21: a fresh prompt supersedes a plain handoff; a late approve is ignored", async () => {
  const b = await boot({ enabled: false, hasUI: true, plannotator: true, customAnswers: [executionAnswer("build")] });
  try {
    await freshPrompt(b.pi, b.ctx);
    await switchToPlan(b.pi, b.ctx);
    const plan = placePlan(b.cwd, "hd21-supersede.md");
    await writeResult(b.pi, b.ctx, plan.rel);
    await b.pi.emit("agent_end", { messages: runMessages(plan.rel) }, b.ctx);
    assert.equal(b.plannotatorRequests.length, 1);

    await freshPrompt(b.pi, b.ctx);
    b.pi.events.emit("plannotator:review-result", {
      reviewId: "review-1",
      approved: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.ok(
      !b.pi.sent.some((s: any) =>
        JSON.stringify(s.content).includes("Execute the plan"),
      ),
      "a stale browser approval cannot execute the superseded plan",
    );
    const lastStatus = [...b.statuses]
      .reverse()
      .find((value) => typeof value === "string");
    assert.ok(
      !String(lastStatus).includes("handoff pending"),
      "the new prompt cleared the plain handoff label",
    );
  } finally {
    await b.cleanup();
  }
});

test("HD10: a corrupt workflow.handoff value behaves as auto", async () => {
  const b = await boot({
    hasUI: true,
    plannotator: true,
    settings: { workflow: { handoff: 42 } },
  });
  try {
    await freshPrompt(b.pi, b.ctx);
    await switchToPlan(b.pi, b.ctx);
    const plan = placePlan(b.cwd, "hd10-corrupt.md");
    await writeResult(b.pi, b.ctx, plan.rel);
    await b.pi.emit("agent_end", { messages: runMessages(plan.rel) }, b.ctx);

    assert.equal(
      b.plannotatorRequests.length,
      1,
      "auto retried the detected host",
    );
    assert.equal(b.customs.length, 0);
  } finally {
    await b.cleanup();
  }
});

test("HD11: a manual /review honours handoff=native", async () => {
  const b = await boot({
    enabled: false,
    hasUI: true,
    settings: { workflow: { handoff: "native" } },
    customAnswer: handoffAnswer("skip"),
  });
  try {
    const plan = placePlan(b.cwd, "hd11-manual-native.md");
    await runReview(b.pi, b.ctx, plan.rel);

    assert.equal(b.plannotatorRequests.length, 0, "no browser request");
    assert.equal(b.customs.length, 1, "the native questionnaire opened");
    assert.ok(
      !notified(b.notifies, "Plannotator handoff unavailable"),
      "no failure warning for the selected native target",
    );
    assert.ok(
      b.pi.entries.some((e: any) => e.type === "workflow-handoff-plan"),
      "the plan was printed into the transcript",
    );
    await b.pi.commands["review-abort"].handler("", b.ctx);
    assert.ok(notified(b.notifies, "Nothing to abort"), "no stale turn");
  } finally {
    await b.cleanup();
  }
});

// ── Todo panel lifecycle (2026-11-14 plan) ──────────────────────────

function seededTodos(
  spec: Array<{
    text: string;
    status?: "pending" | "in_progress" | "completed" | "cancelled";
    group?: string;
  }>,
): TodoItem[] {
  return spec.map((s, i) => ({
    step: i + 1,
    ref: String(i + 1),
    label: String(i + 1),
    text: s.text,
    group: s.group,
    status: s.status ?? "pending",
    completed: s.status === "completed",
    source: "plan",
  }));
}

const SETTLED_TODOS = seededTodos([
  { text: "One", status: "completed" },
  { text: "Two", status: "completed" },
]);


function workflowBranch(todos: TodoItem[], todoPanel?: Record<string, unknown>) {
  return [
    {
      type: "custom",
      customType: "workflow",
      data: {
        mode: "build",
        enabled: false,
        executing: true,
        todos,
        planFile: null,
        ...(todoPanel ? { todoPanel } : {}),
      },
    },
  ];
}

function hiddenPanel(todos: TodoItem[]): Record<string, unknown> {
  return {
    override: "hidden",
    overrideKey: todoListKey(todos),
    promptAfterSettle: false,
    completedSignature: null,
  };
}

function completionCards(pi: { sent: Array<{ content: unknown }> }): unknown[] {
  return pi.sent
    .map((s) => s.content as { customType?: string })
    .filter((c) => c?.customType === "workflow-complete");
}

test("Z1: a settled build list collapses the pinned panel to one row", async () => {
  const b = await boot({ branch: workflowBranch(SETTLED_TODOS), hasUI: true });
  try {
    const rows = renderTodoWidget(b.widgetCalls);
    assert.equal(rows.length, 1, `rows=${JSON.stringify(rows)}`);
    assert.match(stripAnsi(rows[0]), /☑ Todos 2\/2 · all done · \/todos expand/);
  } finally {
    await b.cleanup();
  }
});

test("Z2: agent_end sends the completion card once per settled list", async () => {
  const b = await boot({ branch: workflowBranch(SETTLED_TODOS), hasUI: true });
  try {
    await b.pi.emit("agent_end", { messages: [] }, b.ctx);
    await b.pi.emit("agent_end", { messages: [] }, b.ctx);
    assert.equal(
      completionCards(b.pi).length,
      1,
      "a settled list must not re-emit the Build Complete card",
    );
    const persisted = [...b.pi.entries]
      .reverse()
      .find((e) => e.type === "workflow") as any;
    assert.ok(
      typeof persisted?.data?.todoPanel?.completedSignature === "string",
      "the signature is persisted",
    );
  } finally {
    await b.cleanup();
  }
});

test("Z3: the next user prompt hides the settled panel; a custom run does not", async () => {
  const b = await boot({ branch: workflowBranch(SETTLED_TODOS), hasUI: true });
  try {
    assert.equal(renderTodoWidget(b.widgetCalls).length, 1);
    await b.pi.emit(
      "before_agent_start",
      { messageType: "custom", message: { customType: "x", content: "" } },
      b.ctx,
    );
    assert.equal(
      renderTodoWidget(b.widgetCalls).length,
      1,
      "a custom triggerTurn run must not hide the panel",
    );
    await b.pi.emit(
      "before_agent_start",
      { messageType: "user", prompt: "next task" },
      b.ctx,
    );
    assert.deepEqual(
      renderTodoWidget(b.widgetCalls),
      [],
      "a real user prompt hides the settled panel",
    );
  } finally {
    await b.cleanup();
  }
});

test("Z4: /todos verbs control the panel, list, and clear", async () => {
  const b = await boot({
    branch: workflowBranch(SETTLED_TODOS),
    hasUI: true,
    confirmAnswer: true,
  });
  try {
    await b.pi.commands.todos.handler("expand", b.ctx);
    assert.ok(renderTodoWidget(b.widgetCalls).length > 1, "expand shows rows");

    await b.pi.commands.todos.handler("collapse", b.ctx);
    assert.equal(renderTodoWidget(b.widgetCalls).length, 1, "collapse is one row");

    await b.pi.commands.todos.handler("hide", b.ctx);
    assert.deepEqual(renderTodoWidget(b.widgetCalls), [], "hide removes the widget");

    await b.pi.commands.todos.handler("auto", b.ctx);
    assert.equal(
      renderTodoWidget(b.widgetCalls).length,
      1,
      "auto returns a settled list to one row",
    );

    await b.pi.commands.todos.handler("", b.ctx);
    assert.ok(
      b.notifies.some((n) => n.message.includes("Todos (2):")),
      "no-arg form still lists every step",
    );

    const completions = b.pi.commands.todos.getArgumentCompletions?.("ex") as
      | Array<{ value: string }>
      | null;
    assert.deepEqual(
      completions?.map((c) => c.value),
      ["expand "],
      "argument completions expose the verbs",
    );

    await b.pi.commands.todos.handler("clear", b.ctx);
    assert.equal(b.confirms.length, 1, "clear asks once");
    assert.match(b.confirms[0].title, /Clear todos\?/);
    assert.deepEqual(renderTodoWidget(b.widgetCalls), []);
    assert.ok(b.notifies.some((n) => n.message.includes("Cleared 2 todos")));
  } finally {
    await b.cleanup();
  }
});

test("Z5: /todos clear is headless-safe (no confirm prompt)", async () => {
  const b = await boot({ branch: workflowBranch(SETTLED_TODOS), hasUI: false });
  try {
    await b.pi.commands.todos.handler("clear", b.ctx);
    assert.equal(b.confirms.length, 0, "headless must not open a dialog");
    const persisted = [...b.pi.entries]
      .reverse()
      .find((e) => e.type === "workflow") as any;
    assert.deepEqual(persisted?.data?.todos, []);
  } finally {
    await b.cleanup();
  }
});

test("Z6: ctrl+alt+o toggles the panel", async () => {
  const b = await boot({ branch: workflowBranch(SETTLED_TODOS), hasUI: true });
  try {
    const shortcut = b.pi.shortcuts["ctrl+alt+o"];
    assert.ok(shortcut, "the shortcut is registered");
    assert.equal(renderTodoWidget(b.widgetCalls).length, 1);

    await shortcut.handler(b.ctx);
    assert.ok(
      renderTodoWidget(b.widgetCalls).length > 1,
      "toggle expands a collapsed panel",
    );

    await shortcut.handler(b.ctx);
    assert.equal(
      renderTodoWidget(b.widgetCalls).length,
      1,
      "toggle collapses an expanded panel",
    );
  } finally {
    await b.cleanup();
  }
});

test("Z7: a status mutation re-registers the widget so the live rows repaint", async () => {
  const list = seededTodos([
    { text: "One", status: "in_progress" },
    { text: "Two" },
  ]);
  const b = await boot({ branch: workflowBranch(list), hasUI: true });
  try {
    const before = b.widgetCalls.filter((c) => c.key === "workflow-todos").length;
    await b.pi.tools["workflow_todo"].execute(
      "todo-1",
      { action: "done", step: 2 },
      undefined,
      undefined,
      b.ctx,
    );
    const after = b.widgetCalls.filter((c) => c.key === "workflow-todos").length;
    assert.equal(after, before + 1, "a visible row change re-registers the widget");
    const rows = renderTodoWidget(b.widgetCalls).map(stripAnsi);
    assert.deepEqual(
      rows,
      ["▶ 1. One", "☑ 2. Two"],
      "the live rows reflect the status change",
    );
  } finally {
    await b.cleanup();
  }
});

test("Z8: workflow_todo add keeps a hidden panel hidden in the same plan", async () => {
  const b = await boot({ branch: workflowBranch(SETTLED_TODOS), hasUI: true });
  try {
    await b.pi.commands.todos.handler("hide", b.ctx);
    assert.deepEqual(renderTodoWidget(b.widgetCalls), []);

    await b.pi.tools["workflow_todo"].execute(
      "todo-2",
      { action: "add", text: "Three" },
      undefined,
      undefined,
      b.ctx,
    );

    const rows = renderTodoWidget(b.widgetCalls).map(stripAnsi);
    assert.deepEqual(
      rows,
      [],
      "the sticky hidden choice survives an agent-added step",
    );

    const persisted = [...b.pi.entries]
      .reverse()
      .find((e) => e.type === "workflow") as any;
    assert.equal(
      persisted?.data?.todos?.length,
      3,
      "add writes a persisted workflow entry",
    );
  } finally {
    await b.cleanup();
  }
});

test("Z9: a reload restores a persisted hidden or expanded panel", async () => {
  const hidden = await boot({
    branch: workflowBranch(SETTLED_TODOS, hiddenPanel(SETTLED_TODOS)),
    hasUI: true,
  });
  try {
    assert.deepEqual(
      renderTodoWidget(hidden.widgetCalls),
      [],
      "restored hidden state stays hidden",
    );
  } finally {
    await hidden.cleanup();
  }

  const expanded = await boot({
    branch: workflowBranch(SETTLED_TODOS, {
      override: "expanded",
      overrideKey: todoListKey(SETTLED_TODOS),
      promptAfterSettle: false,
      completedSignature: null,
    }),
    hasUI: true,
  });
  try {
    assert.ok(
      renderTodoWidget(expanded.widgetCalls).length > 1,
      "restored expanded state stays expanded",
    );
  } finally {
    await expanded.cleanup();
  }
});

test("Z10: a rewind restores the panel state of the branch", async () => {
  const b = await boot({ branch: workflowBranch(SETTLED_TODOS), hasUI: true });
  try {
    const rewound = makeFakeCtx({
      cwd: b.cwd,
      hasUI: true,
      branch: workflowBranch(SETTLED_TODOS, hiddenPanel(SETTLED_TODOS)),
    });
    await b.pi.emit("session_tree", {}, rewound.ctx);
    assert.deepEqual(
      renderTodoWidget(rewound.widgetCalls),
      [],
      "the rewind target's hidden choice wins",
    );
  } finally {
    await b.cleanup();
  }
});

test("Z11: a settled list drops the stale marker from the footer", async () => {
  const b = await boot({ branch: workflowBranch(SETTLED_TODOS), hasUI: true });
  try {
    await b.pi.emit("agent_end", { messages: [] }, b.ctx);
    const buildStatuses = b.statuses.filter(
      (value): value is string =>
        typeof value === "string" && value.includes("build"),
    );
    assert.ok(buildStatuses.length > 0);
    assert.ok(
      !buildStatuses.at(-1)!.includes("⚠"),
      `settled footer must be stale-free: ${buildStatuses.at(-1)}`,
    );
  } finally {
    await b.cleanup();
  }
});

test("Z12: a hidden panel publishes a compact status and clears it when shown", async () => {
  const b = await boot({ branch: workflowBranch(SETTLED_TODOS), hasUI: true });
  try {
    await b.pi.commands.todos.handler("hide", b.ctx);
    assert.match(
      stripAnsi(String(latestStatus(b.statusCalls, "workflow-todos"))),
      /☑ Todos 2\/2 · hidden/,
    );

    await b.pi.commands.todos.handler("expand", b.ctx);
    assert.equal(latestStatus(b.statusCalls, "workflow-todos"), undefined);
  } finally {
    await b.cleanup();
  }
});

test("Z13: a collapsed panel stays collapsed when a step is added", async () => {
  const b = await boot({ branch: workflowBranch(SETTLED_TODOS), hasUI: true });
  try {
    await b.pi.commands.todos.handler("collapse", b.ctx);
    assert.equal(renderTodoWidget(b.widgetCalls).length, 1);

    await b.pi.tools["workflow_todo"].execute(
      "todo-3",
      { action: "add", text: "Three" },
      undefined,
      undefined,
      b.ctx,
    );

    const rows = renderTodoWidget(b.widgetCalls).map(stripAnsi);
    assert.equal(rows.length, 1, "the sticky collapsed choice survives the add");
    assert.match(rows[0] ?? "", /Todos/);
  } finally {
    await b.cleanup();
  }
});

// ── Approval destination routing (plan steps 4–6) ─────────────────────

test("RD4: a configured browser handoff opens FIRST, with no picker and no write", async () => {
  const b = await boot({
    executionMode: "unset",
    plannotator: true,
    hasUI: true,
    customAnswers: [executionAnswer("orchestrator")],
  });
  try {
    await freshPrompt(b.pi, b.ctx);
    await switchToPlan(b.pi, b.ctx);
    const plan = placePlan(b.cwd, "rd4-first.md");
    await writeResult(b.pi, b.ctx, plan.rel);
    await b.pi.emit("agent_end", { messages: runMessages(plan.rel) }, b.ctx);

    // The browser request is the FIRST interaction. The old code asked a
    // native destination picker here and wrote the answer to settings.
    assert.equal(b.plannotatorRequests.length, 1, "Plannotator opened immediately");
    assert.equal(b.selects.length, 0, "no pre-review destination picker");
    assert.equal(b.customs.length, 0, "no native modal before the plan review");
    assert.equal(
      fs.existsSync(path.join(b.agentDir, "settings.json")),
      false,
      "showing the handoff wrote no settings",
    );

    b.pi.events.emit("plannotator:review-result", { reviewId: "review-1", approved: true });
    await waitFor(() =>
      b.pi.entries.some(
        (e: any) => e.type === "workflow-handoff-route" && e.data?.route === "orchestrator-prepare",
      ),
    );
    assert.equal(
      sentIncludes(b, "Execute the plan"),
      false,
      "the browser approval prepared a breakdown, not a Build turn",
    );
    assert.equal(
      b.customs.length,
      1,
      "the execution chooser is the only native modal",
    );
    // The per-plan choice is not persisted for future handoffs.
    assert.equal(
      fs.existsSync(path.join(b.agentDir, "settings.json")),
      false,
      "the chooser did not save a default",
    );
  } finally {
    await b.cleanup();
  }
});

test("RD5: a headless handoff approves by id, then executes by explicit id", async () => {
  const b = await boot({ executionMode: "build", hasUI: false });
  try {
    await freshPrompt(b.pi, b.ctx);
    await switchToPlan(b.pi, b.ctx);
    const plan = placePlan(b.cwd, "rd5-headless.md");
    await writeResult(b.pi, b.ctx, plan.rel);
    await b.pi.emit("agent_end", { messages: runMessages(plan.rel) }, b.ctx);

    const persisted = [...b.pi.entries]
      .reverse()
      .find((e: any) => e.type === "workflow" && e.data?.pendingHandoffDecision) as any;
    const decisionId = persisted?.data?.pendingHandoffDecision?.decisionId;
    assert.ok(decisionId, "a pending decision with an id is persisted");
    assert.equal(
      sentIncludes(b, "Execute the plan"),
      false,
      "headless never auto-executes",
    );

    await b.pi.commands.handoff.handler("approve nope", b.ctx);
    assert.ok(notified(b.notifies, "does not match the current handoff"));

    // Stage 1: approval only. Nothing runs and no mode changes.
    await b.pi.commands.handoff.handler(`approve ${decisionId}`, b.ctx);
    assert.ok(notified(b.notifies, "Plan approved"));
    assert.equal(
      sentIncludes(b, "Execute the plan"),
      false,
      "approval alone never executes",
    );
    const afterApprove = [...b.pi.entries]
      .reverse()
      .find((e: any) => e.type === "workflow" && e.data?.mode) as any;
    assert.notEqual(afterApprove?.data?.mode, "build");

    // Stage 2: an explicit destination is required.
    await b.pi.commands.handoff.handler(`execute ${decisionId}`, b.ctx);
    assert.ok(notified(b.notifies, "Choose an execution destination"));

    await b.pi.commands.handoff.handler(`execute ${decisionId} build`, b.ctx);
    await waitFor(() => b.pi.sent.some((s: any) => String(s.content).includes("Execute the plan")));
    const mode = [...b.pi.entries]
      .reverse()
      .find((e: any) => e.type === "workflow" && e.data?.mode) as any;
    assert.equal(mode?.data?.mode, "build");

    // The decision is consumed exactly once.
    const before = b.pi.sent.length;
    await b.pi.commands.handoff.handler(`execute ${decisionId} build`, b.ctx);
    assert.equal(b.pi.sent.length, before, "an id is consumed once");
  } finally {
    await b.cleanup();
  }
});

function approvedDecisionId(b: { pi: { entries: any[] } }): string | undefined {
  const approved = [...b.pi.entries]
    .reverse()
    .find((e: any) => e.type === "workflow-handoff-approved") as any;
  return approved?.data?.decisionId;
}

test("MX: every presenter asks the plan first, then asks execution", async () => {
  for (const presenter of ["native", "plannotator"] as const) {
    const answers: unknown[] =
      presenter === "native"
        ? [handoffAnswer("approve"), executionAnswer("build")]
        : [executionAnswer("build")];
    const b = await boot({
      hasUI: true,
      plannotator: presenter === "plannotator",
      customAnswers: answers,
    });
    try {
      await freshPrompt(b.pi, b.ctx);
      await switchToPlan(b.pi, b.ctx);
      const plan = placePlan(b.cwd, `mx-${presenter}.md`);
      await writeResult(b.pi, b.ctx, plan.rel);
      await b.pi.emit("agent_end", { messages: runMessages(plan.rel) }, b.ctx);

      if (presenter === "plannotator") {
        assert.equal(b.plannotatorRequests.length, 1, "the browser owns stage 1");
        assert.equal(b.customs.length, 0, "no native modal before the browser");
        b.pi.events.emit("plannotator:review-result", {
          reviewId: "review-1",
          approved: true,
        });
      }
      await waitFor(() => approvedDecisionId(b) !== undefined);
      const orderNow = b.pi.entries.map((e: any) => e.type);
      const routedNow = orderNow.findIndex(
        (t: string) => t === "workflow-handoff-route",
      );
      if (routedNow >= 0) {
        assert.ok(
          orderNow.indexOf("workflow-handoff-approved") < routedNow,
          "approval is recorded before the execution route",
        );
      }
      await waitFor(() => sentIncludes(b, "Execute the plan"));
      assert.equal(sentIncludes(b, "Execute the plan"), true, "direct Build ran");
      assert.equal(
        b.pi.entries.some((e: any) => e.type === "workflow-orchestrator-preparation"),
        false,
        "no preparation entry exists",
      );
    } finally {
      await b.cleanup();
    }
  }
});
test("TS1: an approved plan waits in Plan until execution is chosen", async () => {
  const answers: unknown[] = [handoffAnswer("approve"), executionAnswer("later")];
  const b = await boot({ hasUI: true, customAnswers: answers });
  try {
    await freshPrompt(b.pi, b.ctx);
    await switchToPlan(b.pi, b.ctx);
    const plan = placePlan(b.cwd, "ts1-wait.md");
    await writeResult(b.pi, b.ctx, plan.rel);
    await b.pi.emit("agent_end", { messages: runMessages(plan.rel) }, b.ctx);
    await waitFor(() => approvedDecisionId(b) !== undefined);

    const id = approvedDecisionId(b);
    assert.ok(id, "stage 1 recorded an approval");
    assert.equal(sentIncludes(b, "Execute the plan"), false, "nothing executed");
    const modes = b.pi.entries.filter((e: any) => e.type === "workflow" && e.data?.mode);
    assert.equal(
      modes.some((e: any) => e.data.mode === "build"),
      false,
      "the session stayed in Plan",
    );
    assert.ok(
      notified(b.notifies, "Plan stays approved") ||
        notified(b.notifies, "/handoff continue"),
      "the user is told how to resume",
    );

    // Resume explicitly: the ONLY way the deferred approval executes.
    answers.push(executionAnswer("build"));
    await b.pi.commands.handoff.handler(`continue ${id}`, b.ctx);
    await waitFor(() => sentIncludes(b, "Execute the plan"));
    assert.equal(sentIncludes(b, "Execute the plan"), true);
  } finally {
    await b.cleanup();
  }
});

test("TS2: a denial after approval cannot execute or resurrect it", async () => {
  // Stage 1 is the browser, so the queue holds only stage-2 answers.
  const answers: unknown[] = [executionAnswer("later")];
  const b = await boot({ hasUI: true, plannotator: true, customAnswers: answers });
  const settingsPath = path.join(b.cwd, ".pi", "settings.json");
  try {
    await freshPrompt(b.pi, b.ctx);
    await switchToPlan(b.pi, b.ctx);
    const plan = placePlan(b.cwd, "ts2-feedback.md");
    await writeResult(b.pi, b.ctx, plan.rel);
    await b.pi.emit("agent_end", { messages: runMessages(plan.rel) }, b.ctx);
    assert.equal(b.plannotatorRequests.length, 1);

    b.pi.events.emit("plannotator:review-result", {
      reviewId: "review-1",
      approved: true,
    });
    await waitFor(() => approvedDecisionId(b) !== undefined);
    const id = approvedDecisionId(b)!;
    const settingsBefore = fs.readFileSync(settingsPath, "utf8");
    assert.equal(sentIncludes(b, "Execute the plan"), false, "deferred, not executed");

    // A late denial for the SAME review must not start a revision or clear the
    // approval. The one-claim-per-review guard refuses it.
    b.pi.events.emit("plannotator:review-result", {
      reviewId: "review-1",
      approved: false,
      feedback: "too late",
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(sentIncludes(b, "Execute the plan"), false, "nothing executed");
    assert.equal(
      b.pi.sent.some((s: any) => sentText(s).includes("too late")),
      false,
      "no revision turn was sent for a late denial",
    );
    assert.equal(
      fs.readFileSync(settingsPath, "utf8"),
      settingsBefore,
      "no settings write",
    );

    // The approval is still resumable and still requires the second decision.
    answers.push(executionAnswer("build"));
    await b.pi.commands.handoff.handler(`continue ${id}`, b.ctx);
    await waitFor(() => sentIncludes(b, "Execute the plan"));
    assert.equal(sentIncludes(b, "Execute the plan"), true);
  } finally {
    await b.cleanup();
  }
});

test("TS2b: feedback on an UNANSWERED plan revises in Plan and never executes", async () => {
  const b = await boot({ hasUI: true, customAnswer: handoffAnswer("feedback") });
  try {
    await freshPrompt(b.pi, b.ctx);
    await switchToPlan(b.pi, b.ctx);
    const plan = placePlan(b.cwd, "ts2b-feedback.md");
    await writeResult(b.pi, b.ctx, plan.rel);
    await b.pi.emit("agent_end", { messages: runMessages(plan.rel) }, b.ctx);

    assert.ok(
      b.pi.entries.some((e: any) => e.type === "workflow-handoff-result" && e.data?.choice === "refine"),
      "the feedback is recorded as a refine",
    );
    assert.equal(sentIncludes(b, "Execute the plan"), false, "feedback never executes");
    assert.equal(b.customs.length, 1, "no execution chooser after feedback");
    const lastMode = [...b.pi.entries]
      .reverse()
      .find((e: any) => e.type === "workflow" && e.data?.mode) as any;
    assert.equal(lastMode?.data?.mode, "plan", "the session stays in Plan");
    // No feedback text was entered, so the plan is not sent back for a
    // revision: the user keeps Plan mode and can type the change directly.
    assert.ok(
      notified(b.notifies, "Refine: stay in plan mode"),
      "an empty feedback entry is a no-op, not an execution",
    );
  } finally {
    await b.cleanup();
  }
});

test("TS3: duplicate approvals open one chooser and route once", async () => {
  const b = await boot({
    hasUI: true,
    plannotator: true,
    customAnswers: [executionAnswer("build")],
  });
  try {
    await freshPrompt(b.pi, b.ctx);
    await switchToPlan(b.pi, b.ctx);
    const plan = placePlan(b.cwd, "ts3-duplicate.md");
    await writeResult(b.pi, b.ctx, plan.rel);
    await b.pi.emit("agent_end", { messages: runMessages(plan.rel) }, b.ctx);
    assert.equal(b.plannotatorRequests.length, 1);

    b.pi.events.emit("plannotator:review-result", { reviewId: "review-1", approved: true });
    b.pi.events.emit("plannotator:review-result", { reviewId: "review-1", approved: true });
    b.pi.events.emit("plannotator:plan-approved", {
      cwd: b.cwd,
      planFilePath: plan.abs,
      planContent: ORIGINAL_PLAN,
    });
    await waitFor(() => sentIncludes(b, "Execute the plan"));
    await new Promise((resolve) => setTimeout(resolve, 25));

    assert.equal(
      b.pi.entries.filter((e: any) => e.type === "workflow-handoff-approved").length,
      1,
      "one approval transition",
    );
    assert.equal(b.customs.length, 1, "one execution chooser");
    assert.equal(
      b.pi.entries.filter((e: any) => e.type === "workflow-handoff-route").length,
      1,
      "one route receipt",
    );
  } finally {
    await b.cleanup();
  }
});

test("TS4: a plan changed after approval is refused at execution time", async () => {
  const answers: unknown[] = [handoffAnswer("approve"), executionAnswer("later")];
  const b = await boot({ hasUI: true, customAnswers: answers });
  try {
    await freshPrompt(b.pi, b.ctx);
    await switchToPlan(b.pi, b.ctx);
    const plan = placePlan(b.cwd, "ts4-changed.md");
    await writeResult(b.pi, b.ctx, plan.rel);
    await b.pi.emit("agent_end", { messages: runMessages(plan.rel) }, b.ctx);
    await waitFor(() => approvedDecisionId(b) !== undefined);
    const id = approvedDecisionId(b)!;

    fs.writeFileSync(plan.abs, `${ORIGINAL_PLAN}

5. Sneaky extra step`, "utf8");
    answers.push(executionAnswer("build"));
    await b.pi.commands.handoff.handler(`continue ${id}`, b.ctx);
    await new Promise((resolve) => setTimeout(resolve, 25));

    assert.equal(sentIncludes(b, "Execute the plan"), false, "changed plan not executed");
    assert.ok(
      notified(b.notifies, "changed or is unreadable") ||
        notified(b.notifies, "plan changed"),
      "the refusal is visible",
    );
    // The decision is superseded, so a later execute command is refused too.
    await b.pi.commands.handoff.handler(`execute ${id} build`, b.ctx);
    assert.equal(sentIncludes(b, "Execute the plan"), false);
  } finally {
    await b.cleanup();
  }
});

// ── Real-entrypoint orchestration integration (plan step 24) ─────────

test("RE1: a real approved plan freezes the run and starts without a preparation turn", async () => {
  const b = await boot({
    hasUI: true,
    customAnswers: [handoffAnswer("approve"), executionAnswer("orchestrator")],
  });
  try {
    await freshPrompt(b.pi, b.ctx);
    await switchToPlan(b.pi, b.ctx);
    const plan = placePlan(b.cwd, "re1-run.md");
    await writeResult(b.pi, b.ctx, plan.rel);
    await b.pi.emit("agent_end", { messages: runMessages(plan.rel) }, b.ctx);

    const runsRoot = path.join(b.agentDir, "orchestrator", "runs");
    assert.ok(fs.existsSync(runsRoot), "the run directory exists");
    const runDirs = fs.readdirSync(runsRoot).filter((entry) => entry.startsWith("run-"));
    assert.equal(runDirs.length, 1, "exactly one run is created");
    const journal = fs.readFileSync(
      path.join(runsRoot, runDirs[0]!, "journal.ndjson"),
      "utf8",
    );
    assert.match(journal, /"type":"run.created"/);
    assert.match(journal, /"type":"todos.frozen"/);
    assert.doesNotMatch(journal, /"type":"plan.proposed"/);

    const sentText = (entry: any) =>
      String(
        (entry.content && typeof entry.content === "object"
          ? (entry.content as any).content
          : entry.content) ?? "",
      );
    const preparationTurns = b.pi.sent.filter((entry: any) =>
      sentText(entry).includes("Orchestrator preparation"),
    );
    assert.equal(preparationTurns.length, 0, "no separate preparation turn");
    assert.equal(
      b.pi.sent.some((entry: any) => sentText(entry).includes("Execute the plan")),
      false,
      "the direct-Build prompt is never sent",
    );

    const status = await b.pi.tools.orchestrator_status.execute("re1-status", {});
    assert.match(JSON.stringify(status), /"runId":"run-/);
    assert.match(JSON.stringify(status), /accepted/);
  } finally {
    await b.cleanup();
  }
});
test("RE2: the explicit direct-Build destination sends exactly one execution prompt and creates no run", async () => {
  const b = await boot({
    hasUI: true,
    customAnswers: [handoffAnswer("approve"), executionAnswer("build")],
  });
  try {
    await freshPrompt(b.pi, b.ctx);
    await switchToPlan(b.pi, b.ctx);
    const plan = placePlan(b.cwd, "re2-build.md");
    await writeResult(b.pi, b.ctx, plan.rel);
    await b.pi.emit("agent_end", { messages: runMessages(plan.rel) }, b.ctx);

    const execution = b.pi.sent.filter((entry: any) => {
      const content = entry.content;
      const text =
        content && typeof content === "object"
          ? String((content as any).content ?? "")
          : String(content ?? "");
      return text.includes("Execute the plan");
    });
    assert.equal(execution.length, 1, "the direct-Build execution prompt is sent once");
    const runsRoot = path.join(b.agentDir, "orchestrator", "runs");
    assert.equal(
      fs.existsSync(runsRoot) && fs.readdirSync(runsRoot).length > 0,
      false,
      "direct Build creates no orchestration run",
    );
  } finally {
    await b.cleanup();
  }
});
