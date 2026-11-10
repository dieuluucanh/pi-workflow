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
import { planHash } from "./review.ts";
import {
  ORIGINAL_PLAN,
  REWRITTEN_PLAN,
  fakeSdk,
  makeFakeCtx,
  makeFakePi,
  submitThenFinish,
  tmpProject,
  type FakeCapture,
} from "./test-support.ts";

interface BootOptions {
  enabled?: boolean;
  verify?: boolean;
  hasUI?: boolean;
  plannotator?: boolean;
  /** Per-review-id answer for `plannotator:request` `review-status`. */
  plannotatorStatus?: Record<string, unknown>;
  startReason?: "startup" | "reload" | "resume" | "fork" | "new";
  customAnswer?: string | null;
  editorAnswer?: string | null;
  modelRegistry?: { find?: (provider: string, id: string) => unknown };
  script?: {
    pass1?: (c: FakeCapture) => Promise<void>;
    pass2?: (c: FakeCapture) => Promise<void>;
  };
  branch?: unknown[];
}

async function boot(over: BootOptions = {}) {
  const { root, cwd, agentDir } = tmpProject();
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  fs.mkdirSync(path.join(cwd, ".pi", "plans"), { recursive: true });
  fs.writeFileSync(
    path.join(cwd, ".pi", "settings.json"),
    JSON.stringify(
      {
        workflow: {
          reviewMode: {
            enabled: over.enabled !== false,
            rounds: 1,
            passes: over.verify ? 2 : 1,
            verify: over.verify === true,
            timeoutMs: 5000,
          },
        },
      },
      null,
      2,
    ),
  );
  const { capture, sdk } = fakeSdk(
    over.script ?? { pass1: submitThenFinish(REWRITTEN_PLAN) },
  );
  const pi = makeFakePi();
  const plannotatorRequests: Array<{
    requestId?: string;
    reviewId: string;
    planPath?: string;
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
        });
        request.respond?.({
          status: "handled",
          result: { reviewId },
        });
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
  await workflowExtension(pi as never, { loadSdk: async () => sdk as never });
  const { ctx, notifies, statuses, widgets } = makeFakeCtx({
    cwd,
    hasUI: over.hasUI === true,
    branch: over.branch ?? [],
    ...(over.modelRegistry ? { modelRegistry: over.modelRegistry } : {}),
    ...(over.customAnswer !== undefined
      ? { customAnswer: over.customAnswer }
      : {}),
    ...(over.editorAnswer !== undefined
      ? { editorAnswer: over.editorAnswer }
      : {}),
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
    widgets,
    capture,
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
  await pi.emit("before_agent_start", { prompt: "write a plan" }, ctx);
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

async function waitFor(cond: () => boolean, ms = 1500): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
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
    customAnswer: "refine",
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
  const b = await boot({ hasUI: true, plannotator: true });
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
      notified(b.notifies, "Paused review abandoned"),
      "the user is told the pause was abandoned",
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
  const b = await boot({ hasUI: true, plannotator: true });
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
  const b = await boot({ hasUI: true, plannotator: true });
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
): Promise<{
  b: Awaited<ReturnType<typeof boot>>;
  made: ReturnType<typeof makeFakeCtx>;
  plan: { rel: string; abs: string };
}> {
  const b = await boot({
    hasUI: true,
    plannotator: true,
    plannotatorStatus: status,
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
      },
    },
  ];
  const made = makeFakeCtx({ cwd: b.cwd, hasUI: true, branch });
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
  } finally {
    await b.cleanup();
  }
});

test("R2: reload applies a completed approval", async () => {
  const { b } = await reloadWithPending({
    "review-1": {
      status: "completed",
      approved: true,
      feedback: "looks good",
    },
  });
  try {
    await waitFor(() =>
      b.pi.entries.some(
        (e: any) => e.type === "workflow" && e.data?.mode === "build",
      ),
    );
    assert.ok(
      b.pi.entries.some(
        (e: any) => e.type === "workflow" && e.data?.mode === "build",
      ),
      "an approval completed during the reload enters Build",
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
  const { b } = await reloadWithPending({
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
  } finally {
    await b.cleanup();
  }
});

test("S1: manual /review opens the browser handoff in Plan mode", async () => {
  const b = await boot({ hasUI: true, plannotator: true });
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
  const b = await boot({ hasUI: true, plannotator: true });
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
  const b = await boot({ hasUI: true, plannotator: true });
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
  const b = await boot({ enabled: false, hasUI: true, plannotator: true });
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
