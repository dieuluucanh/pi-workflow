/**
 * `/profile use` must switch LIVE roles and leave a durable audit entry.
 *
 * These tests drive the real extension factory through the fake Pi host. They
 * cover the warm reviewer (running, paused, handoff, warm-idle), the live
 * Build child, and the single-notice/single-entry activation contract for
 * Plan, Build, Orchestrator, Default, `/profile use none`, child-tab and
 * `/role` activation. The missing behaviour is intentionally left to a later
 * row: every case below is red against the current source.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import workflowExtension from "./index.ts";
import { PROFILE_CONFIG_VERSION } from "./profiles.ts";
import {
  createReviewState,
  reviewFooterSegment,
  reviewStateSummary,
} from "./review.ts";
import { WORKFLOW_STATUS_KEYS } from "./workflow-status.ts";
import {
  fakeSdk,
  latestStatus,
  makeFakeCtx,
  makeFakeOrchestratorChildFactory,
  makeFakePi,
  submitThenFinish,
  tmpProject,
  type FakeCapture,
} from "./test-support.ts";

const PROFILE = {
  name: "live",
  description: "live switch profile",
  roles: {
    planner: { provider: "p", id: "planner", thinking: "high" },
    builder: { provider: "p", id: "builder", thinking: "medium" },
    reviewer: { provider: "p", id: "reviewer", thinking: "xhigh" },
  },
  defaultModel: { provider: "p", id: "default", thinking: "medium" },
};

const LOOP_PLAN = [
  "# Plan: live profile",
  "",
  "## Steps",
  "",
  "1. First",
  "2. Second",
  "",
  "## Verification",
  "- npm test",
].join("\n");

interface Boot {
  pi: ReturnType<typeof makeFakePi>;
  ctx: ReturnType<typeof makeFakeCtx>["ctx"];
  made: ReturnType<typeof makeFakeCtx>;
  capture: FakeCapture;
  childFactory: ReturnType<typeof makeFakeOrchestratorChildFactory>;
  planPath: string;
  /** The in-flight `/review` command, so a warm-idle test can await its exit. */
  reviewRun?: Promise<void>;
  cleanup(): Promise<void>;
}

async function boot(over: {
  reviewer?: (capture: FakeCapture) => Promise<void>;
  branch?: unknown[];
  orchestrator?: boolean;
  /** Make the fake reviewer reject `setModel` (live-switch refusal case). */
  setModelError?: unknown;
} = {}): Promise<Boot> {
  const { root, cwd, agentDir } = tmpProject();
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  fs.writeFileSync(
    path.join(agentDir, "profiles.json"),
    JSON.stringify({ version: PROFILE_CONFIG_VERSION, profiles: [PROFILE] }, null, 2),
    "utf8",
  );
  fs.mkdirSync(path.join(cwd, ".pi", "plans"), { recursive: true });
  fs.writeFileSync(
    path.join(cwd, ".pi", "settings.json"),
    JSON.stringify(
      {
        workflow: {
          commitPolicy: { mode: "never" },
          reviewMode: {
            enabled: true,
            rounds: 1,
            passes: 1,
            timeoutMs: 10_000,
            providerRecovery: "off",
            fallbackOnError: "skip",
          },
        },
      },
      null,
      2,
    ),
    "utf8",
  );
  const planPath = path.join(cwd, ".pi", "plans", "live-profile.md");
  fs.writeFileSync(planPath, LOOP_PLAN, "utf8");

  const pi = makeFakePi({ activeTools: ["read", "write", "edit", "bash"] });
  const { sdk, capture } = fakeSdk({
    pass1: over.reviewer ?? submitThenFinish("# Plan: live profile"),
    ...(over.setModelError !== undefined
      ? { setModelError: over.setModelError }
      : {}),
  });
  const childFactory = makeFakeOrchestratorChildFactory({ holdPrompt: true });
  await workflowExtension(pi as never, {
    loadSdk: async () => sdk as never,
    createOrchestratorChild: childFactory.factory as never,
    selfExtensionPath: "/fake/index.ts",
    plannotatorRequestTimeoutMs: 20,
    plannotatorRecoveryTimeoutMs: 20,
    isTerminalHost: () => true,
  });
  const made = makeFakeCtx({
    cwd,
    hasUI: false,
    branch: over.branch ?? [],
    idle: false,
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
  // Enter Plan mode, then let the Planner write the plan (as the loop tests do).
  if (over.orchestrator !== true) {
    await pi.commands["workflow"].handler("", made.ctx);
    await pi.emit(
      "tool_result",
      { toolName: "write", isError: false, input: { path: planPath } },
      made.ctx,
    );
    await pi.emit(
      "agent_end",
      {
        type: "agent_end",
        willRetry: false,
        messages: [
          { role: "assistant", content: [{ type: "text", text: LOOP_PLAN }] },
        ],
      },
      made.ctx,
    );
  }
  return {
    pi,
    ctx: made.ctx,
    made,
    capture,
    childFactory,
    planPath,
    async cleanup() {
      try {
        await pi.emit("session_shutdown", { reason: "quit" }, made.ctx);
      } catch {
        /* shutdown is best-effort in the fake host */
      }
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

/** A review round that never submits, so the reviewer stays live. */
function holdReviewer(): (capture: FakeCapture) => Promise<void> {
  return async () => {
    await new Promise<void>(() => {});
  };
}

async function startHeldReview(b: Boot): Promise<void> {
  const running = b.pi.commands["review"].handler(b.planPath, b.ctx);
  b.reviewRun = running;
  const deadline = Date.now() + 2_000;
  while (b.capture.prompts.length === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(b.capture.prompts.length > 0, "the reviewer round must start");
  void running;
}

function switchEntries(b: Boot): Array<Record<string, unknown>> {
  return b.pi.entries
    .filter((entry) => entry.type === "workflow-model-switch")
    .map((entry) => entry.data as Record<string, unknown>);
}

async function activate(b: Boot, args = "use live"): Promise<void> {
  await b.pi.commands["profile"].handler(args, b.ctx);
}

async function assertSwitchAudited(b: Boot, role: string): Promise<void> {
  const entries = switchEntries(b);
  assert.ok(
    entries.some((entry) => entry.role === role),
    `a durable workflow-model-switch entry for ${role} must be appended (entries: ${JSON.stringify(
      b.pi.entries.map((entry) => entry.type),
    )})`,
  );
}

/** The `/review status` notification, which owns the single `model :` row. */
function reviewStatusNotice(b: Boot): string | undefined {
  return b.made.notifies.find((n) => /^\s*phase\s+:/m.test(n.message))?.message;
}

// ── Live review line / status ownership ─────────────────────────────

test("review footer: only the LIVE line carries the reviewer model", () => {
  const before = createReviewState({
    planHash: "h",
    modelLabel: "p/old",
  });
  const after = createReviewState({
    planHash: "h",
    modelLabel: "p/reviewer",
  });
  const beforeLine = reviewFooterSegment(before, false);
  const afterLine = reviewFooterSegment(after, false);
  assert.match(beforeLine, /p\/old/);
  assert.match(afterLine, /p\/reviewer/);
  assert.doesNotMatch(afterLine, /p\/old/);
  assert.match(afterLine, /pass 1\/2/);
  // `/review status` uses `reviewStateSummary`, not the footer: its own
  // `model :` row remains the single place the label appears.
  assert.doesNotMatch(reviewStateSummary(after), /p\/reviewer/);
  assert.match(reviewStateSummary(after), /pass 1\/2/);
});

test("profile live switch: the live review footer follows the model", async () => {
  const b = await boot({ reviewer: holdReviewer() });
  try {
    await startHeldReview(b);
    const before =
      latestStatus(b.made.statusCalls, WORKFLOW_STATUS_KEYS.review) ?? "";
    assert.match(before, /\/review pause/);
    assert.doesNotMatch(before, /p\/reviewer/);
    await activate(b);
    const after =
      latestStatus(b.made.statusCalls, WORKFLOW_STATUS_KEYS.review) ?? "";
    assert.match(
      after,
      /p\/reviewer/,
      `the live review line must name the switched reviewer (saw ${JSON.stringify(after)})`,
    );
    assert.match(after, /\/review pause/);
  } finally {
    await b.cleanup();
  }
});

test("profile live switch: /review status prints the model exactly once", async () => {
  const b = await boot({ reviewer: holdReviewer() });
  try {
    await startHeldReview(b);
    await activate(b);
    await b.pi.commands["review"].handler("status", b.ctx);
    const status = reviewStatusNotice(b);
    assert.ok(status, "a /review status notification must be emitted");
    const modelRows = status!.match(/model\s+:\s*p\/reviewer/g) ?? [];
    assert.equal(
      modelRows.length,
      1,
      `the status must print exactly one model row (saw ${JSON.stringify(status)})`,
    );
    assert.equal(
      (status!.match(/p\/reviewer/g) ?? []).length,
      1,
      "the summary line must not repeat the model label",
    );
  } finally {
    await b.cleanup();
  }
});

test("profile live switch: a refused switch warns with both models", async () => {
  const b = await boot({
    reviewer: holdReviewer(),
    setModelError: "model not authorized",
  });
  try {
    await startHeldReview(b);
    await b.pi.commands["review"].handler("status", b.ctx);
    const before = reviewStatusNotice(b) ?? "";
    const oldModel = before.match(/model\s+:\s+([^\s]+)/)?.[1];
    assert.ok(oldModel, "the reviewer must report its current model first");
    const noticesBefore = b.made.notifies.length;
    await activate(b);
    const warnings = b.made.notifies
      .slice(noticesBefore)
      .filter((n) => n.level === "warning" && /Live reviewer keeps/.test(n.message));
    assert.equal(
      warnings.length,
      1,
      `exactly one refusal warning expected (saw ${JSON.stringify(
        b.made.notifies.slice(noticesBefore).map((n) => n.message),
      )})`,
    );
    assert.ok(
      warnings[0].message.includes(oldModel!) &&
        warnings[0].message.includes("p/reviewer"),
      `the warning must name the kept and requested models (saw ${JSON.stringify(
        warnings[0].message,
      )})`,
    );
    assert.deepEqual(
      b.capture.currentModel?.id,
      oldModel!.split("/").at(-1),
      "a refused switch must keep the reviewer on its old model",
    );
    assert.ok(
      switchEntries(b).some(
        (entry) => entry.role === "reviewer" && entry.ok === false,
      ),
      "the refused switch still leaves one durable audit entry",
    );
  } finally {
    await b.cleanup();
  }
});

// ── Live reviewer ───────────────────────────────────────────────────

test("profile live switch: a running reviewer follows and is audited", async () => {
  const b = await boot({ reviewer: holdReviewer() });
  try {
    await startHeldReview(b);
    await activate(b);
    assert.ok(
      b.capture.setModelCalls.length > 0,
      "the live reviewer session must receive setModel",
    );
    await assertSwitchAudited(b, "reviewer");
    assert.ok(
      b.made.notifies.some((n) => /[Ll]ive reviewer/.test(n.message)),
      "a live reviewer switch must emit exactly one review notice",
    );
  } finally {
    await b.cleanup();
  }
});

test("profile live switch: a paused reviewer follows and is audited", async () => {
  const b = await boot({ reviewer: holdReviewer() });
  try {
    await startHeldReview(b);
    await b.pi.commands["review"].handler("pause", b.ctx);
    await activate(b);
    assert.ok(
      b.capture.setModelCalls.length > 0,
      "a paused reviewer must be reconciled to the new profile model",
    );
    await assertSwitchAudited(b, "reviewer");
  } finally {
    await b.cleanup();
  }
});

test("profile live switch: a handoff-owned reviewer is audited", async () => {
  const b = await boot({
    branch: [
      {
        type: "custom",
        customType: "workflow",
        data: {
          awaitingDecision: true,
          planHandoffPhase: "pending",
          pendingHandoffReviewOwned: true,
          mode: "plan",
        },
      },
    ],
  });
  try {
    await activate(b);
    assert.ok(
      b.capture.setModelCalls.length > 0,
      "a handoff-owned reviewer must be reconciled to the new profile model",
    );
    await assertSwitchAudited(b, "reviewer");
  } finally {
    await b.cleanup();
  }
});

test("profile live switch: a warm-idle reviewer switches in place and is audited", async () => {
  const b = await boot();
  try {
    await startHeldReview(b);
    // The fake reviewer submits and finishes; the session stays warm.
    await b.capture.tools.review_pass_done?.execute?.(
      "done",
      { pass: 1, verdict: "approve", findings: [] },
      undefined,
      undefined,
      b.ctx,
    );
    // Wait for the turn to close: this is the warm-IDLE case, with no active
    // round, no pause and no handoff ownership — only a live runtime session.
    assert.ok(b.reviewRun, "the review command must still be in flight");
    await b.reviewRun;
    const createsBefore = b.capture.createCalls;
    const disposesBefore = b.capture.disposeCount;

    await activate(b);

    assert.ok(
      b.capture.setModelCalls.some(
        (call) => call.provider === "p" && call.id === "reviewer",
      ),
      "a warm-idle reviewer must be reconciled without starting a new round",
    );
    assert.deepEqual(
      b.capture.currentModel,
      { provider: "p", id: "reviewer", thinking: "xhigh" },
      "the warm session itself must now report the applied model/thinking",
    );
    assert.equal(
      b.capture.createCalls,
      createsBefore,
      "a live switch must not reboot the warm session",
    );
    assert.equal(
      b.capture.disposeCount,
      disposesBefore,
      "a live switch must not dispose the warm session",
    );
    // The runtime records the new key AND updates ReviewState.modelLabel, so
    // the status surface names the model that actually runs now.
    await b.pi.commands["review"].handler("status", b.ctx);
    assert.ok(
      b.made.notifies.some((n) => /model\s+:\s+p\/reviewer/.test(n.message)),
      `the review status must report the applied model label (notices: ${JSON.stringify(
        b.made.notifies.map((n) => n.message),
      )})`,
    );

    // A genuine next round reuses that warm session; it must not boot just to
    // adopt the model selected while the reviewer was idle.
    await b.pi.commands["review"].handler(b.planPath, b.ctx);
    assert.equal(
      b.capture.createCalls,
      createsBefore,
      "the next round must reuse the switched session, not reboot for the model",
    );
    assert.equal(
      b.capture.disposeCount,
      disposesBefore,
      "the next round must not dispose the switched session",
    );
    await assertSwitchAudited(b, "reviewer");
  } finally {
    await b.cleanup();
  }
});

test("profile live switch: a reviewer-only profile still audits the reviewer", async () => {
  const b = await boot({ reviewer: holdReviewer() });
  try {
    await startHeldReview(b);
    await activate(b);
    await assertSwitchAudited(b, "reviewer");
  } finally {
    await b.cleanup();
  }
});

// ── Parent-side builder child ───────────────────────────────────────

async function dispatchBuilder(b: Boot): Promise<void> {
  const start = b.pi.tools["orchestrator_start"];
  assert.ok(start, "orchestrator_start must be registered");
  await start.execute("start", { steps: ["Row one"] }, undefined, undefined, b.ctx);
  const dispatch = b.pi.tools["orchestrator_dispatch"];
  assert.ok(dispatch, "orchestrator_dispatch must be registered");
  await dispatch.execute(
    "dispatch",
    { rowRef: "1", instructions: "Do row one." },
    undefined,
    undefined,
    b.ctx,
  );
  assert.equal(b.childFactory.created.length, 1, "one live child must exist");
}

test("profile live switch: the parent audits a running builder-child entry", async () => {
  const b = await boot({ orchestrator: true });
  try {
    await await b.pi.commands["orchestrator"].handler("", b.ctx);
    await dispatchBuilder(b);
    await activate(b);
    const entries = switchEntries(b);
    assert.ok(
      entries.some((entry) => entry.role === "builder-child"),
      `the parent must append a builder-child workflow-model-switch entry (entries: ${JSON.stringify(
        b.pi.entries.map((entry) => entry.type),
      )})`,
    );
  } finally {
    await b.cleanup();
  }
});

// ── Single notice / single entry activation contract ─────────────────

async function activationCase(over: {
  mode?: "plan" | "build" | "orchestrator" | "default";
  args?: string;
  childTab?: boolean;
  role?: boolean;
}): Promise<void> {
  const b = await boot({ orchestrator: over.mode === "orchestrator" });
  try {
    if (over.mode === "orchestrator") {
      await b.pi.commands["orchestrator"].handler("", b.ctx);
    } else if (over.mode === "plan" || over.mode === "build") {
      await b.pi.commands["workflow"].handler(over.mode === "plan" ? "plan" : "build", b.ctx);
    } else {
      await b.pi.commands["workflow"].handler("default", b.ctx);
    }
    if (over.childTab) {
      const view = b.pi.commands["orchestrator"];
      assert.ok(view, "orchestrator must be registered");
      await view.handler("view child", b.ctx);
    }
    if (over.role) {
      const role = b.pi.commands["role"];
      assert.ok(role, "role must be registered");
      await role.handler("set builder p/builder", b.ctx);
    }
    const before = b.made.notifies.length;
    await activate(b, over.args ?? "use live");
    const notices = b.made.notifies.slice(before).map((n) => n.message);
    const entries = switchEntries(b);
    assert.equal(
      entries.length,
      1,
      `exactly one durable switch entry expected (saw ${JSON.stringify(entries)})`,
    );
    const switchNotices = notices.filter((message) =>
      /[Ll]ive (reviewer|Builder)/.test(message),
    );
    assert.ok(
      switchNotices.length <= 1,
      `the live switch must use one notice channel, not ${switchNotices.length} (saw ${JSON.stringify(notices)})`,
    );
    assert.equal(
      switchNotices.length,
      1,
      `exactly one live-switch notice expected (saw ${JSON.stringify(notices)})`,
    );
  } finally {
    await b.cleanup();
  }
}

test("profile live switch: Plan activation uses the single notice/entry channel", () =>
  activationCase({ mode: "plan" }));
test("profile live switch: Build activation uses the single notice/entry channel", () =>
  activationCase({ mode: "build" }));
test("profile live switch: Orchestrator parent activation uses the single notice/entry channel", () =>
  activationCase({ mode: "orchestrator" }));
test("profile live switch: Default activation uses the single notice/entry channel", () =>
  activationCase({ mode: "default" }));
test("profile live switch: /profile use none uses the single notice/entry channel", () =>
  activationCase({ args: "use none" }));
test("profile live switch: child-tab activation uses the single notice/entry channel", () =>
  activationCase({ mode: "orchestrator", childTab: true }));
test("profile live switch: /role activation uses the single notice/entry channel", () =>
  activationCase({ role: true }));
