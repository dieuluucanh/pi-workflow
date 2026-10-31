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
  await workflowExtension(pi as never, { loadSdk: async () => sdk as never });
  const { ctx, notifies } = makeFakeCtx({
    cwd,
    hasUI: false,
    branch: over.branch ?? [],
  });
  await pi.emit("session_start", { reason: "startup" }, ctx);
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
  return { root, cwd, agentDir, pi, ctx, notifies, capture, cleanup };
}

function placePlan(
  cwd: string,
  name = "2026-10-31-review-target.md",
): { rel: string; abs: string } {
  const rel = path.join(".pi", "plans", name);
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

/** The reviewer writes the rewrite plus a "Review changes" appendix. */
function assertRewritten(abs: string): void {
  const text = fs.readFileSync(abs, "utf8");
  assert.ok(
    text.startsWith(REWRITTEN_PLAN),
    "the reviewer rewrote the plan the user actually wrote",
  );
}

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
    const plan = placePlan(b.cwd, "2026-10-31-recent.md");
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
