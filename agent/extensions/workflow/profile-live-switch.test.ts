/**
 * `/profile use` must switch LIVE roles and leave a durable audit entry.
 *
 * These tests drive the real extension factory through the fake Pi host.
 *
 * The first three sections (live review line/status ownership, the warm
 * reviewer and the parent-side builder child) pin the CURRENT switch/audit
 * contract. They are green against the current source and must stay green:
 * the live reviewer/child really is switched in place and the
 * `workflow-model-switch` entry is really appended.
 *
 * Only the "single info notice" section at the bottom is the regression
 * target. It pins the tighter, still-missing contract: one `/profile use`,
 * `/profile use none`, `/role set` or `/role use` must produce EXACTLY ONE
 * info notification - the summary, with the `Default profile ...` line and any
 * live-owner (`Live reviewer →`, `Live Builder →`, `Workflow <mode>: model →`)
 * line folded into it - as the last notification of the measured slice, on top of one
 * durable `workflow-model-switch` entry with `changed === true`. Those
 * assertions are expected to fail today (an activation currently emits 2–4
 * info notices).
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
    // Needed for the reported scenario: without it the orchestrator mode entry
    // applies the BASE orchestrator model and `/profile use live` resolves the
    // same model, so the switch under test would be a no-op.
    orchestrator: { provider: "p", id: "orchestrator", thinking: "max" },
  },
  // Base role models (roles.ts seedDefaultRoles) are opencode-go/*; the profile
  // models above are p/*, so every activation is a real model change.
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
  /** The project root the fake ctx reports; owns `<cwd>/.pi/settings.json`. */
  cwd: string;
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
    cwd,
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

/**
 * Read-modify-write the project settings file `boot()` created
 * (`<cwd>/.pi/settings.json`), deep-merging into the existing `workflow`
 * object so `commitPolicy`/`reviewMode` survive.
 *
 * `workflow.defaultProfile` is deliberately written AFTER `boot()` and BEFORE
 * the mode entry: session_start seeds `activeProfileName` from that key when
 * the session has no explicit choice (index.ts:16052-16075), which would turn
 * the measured `/profile use live` into applyModeModel's already-on-target
 * branch. Writing it after the boot keeps the seeding out of the way while
 * making persistDefaultProfileChoice silent (before === after).
 */
function writeProjectSettings(
  cwd: string,
  add: Record<string, unknown>,
): void {
  const file = path.join(cwd, ".pi", "settings.json");
  const existing = JSON.parse(fs.readFileSync(file, "utf8")) as Record<
    string,
    unknown
  >;
  const merged: Record<string, unknown> = { ...existing };
  for (const [key, value] of Object.entries(add)) {
    if (key !== "workflow") {
      merged[key] = value;
      continue;
    }
    const current = (merged.workflow ?? {}) as Record<string, unknown>;
    merged.workflow = { ...current, ...(value as Record<string, unknown>) };
  }
  fs.writeFileSync(file, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
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

/** Base sentence of the single info notice, per activation direction. */
const PROFILE_ACTIVATED = "Profile ⚡ live activated:";
const PROFILE_DEACTIVATED = "Profile deactivated — default roles flow active.";

/** Every notification of a measured slice, levels included, for messages. */
function noticesText(b: Boot, from: number): string {
  return JSON.stringify(
    b.made.notifies
      .slice(from)
      .map((n) => `${n.level ?? "none"}: ${n.message}`),
  );
}

/** The info-level notifications of a measured slice (undefined counts as info). */
function infoNotices(
  b: Boot,
  from: number,
): Array<{ message: string; level?: string }> {
  return b.made.notifies
    .slice(from)
    .filter((n) => n.level === undefined || n.level === "info");
}

/** A live-owner notice sent on its own channel instead of folded in. */
function separateLiveOwnerNotices(
  b: Boot,
  from: number,
): Array<{ message: string; level?: string }> {
  return b.made.notifies
    .slice(from)
    .filter((n) => /^\s*(Review Mode:\s*)?Live (reviewer|Builder) →/.test(n.message));
}

async function activationCase(over: {
  mode?: "plan" | "build" | "orchestrator" | "default";
  args?: string;
  childTab?: boolean;
  role?: boolean;
  /** Enter `live` in the unmeasured region first, so `use none` really switches. */
  activateFirst?: boolean;
  /** Enable the RED single-info-notice regression assertions. */
  expectSingleInfo?: boolean;
}): Promise<void> {
  const b = await boot({ orchestrator: over.mode === "orchestrator" });
  try {
    // Variant (a): the key pre-exists, so the activation's own
    // persistDefaultProfileChoice sees before === after and stays silent. It is
    // written AFTER session_start on purpose: the boot time seeding of
    // activeProfileName from `workflow.defaultProfile` (index.ts:16052-16075)
    // would otherwise turn the measured `/profile use live` into
    // applyModeModel's already-on-target branch (changed === false).
    writeProjectSettings(b.cwd, { workflow: { defaultProfile: "live" } });
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
    if (over.activateFirst) await activate(b);
    const before = b.made.notifies.length;
    const entriesBefore = switchEntries(b).length;
    await activate(b, over.args ?? "use live");
    const all = b.made.notifies.slice(before);
    const notices = all.map((n) => n.message);
    // Only the entries the MEASURED switch appended (an unmeasured
    // `activateFirst` legitimately leaves its own entry behind).
    const entries = switchEntries(b).slice(entriesBefore);
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
    if (over.expectSingleInfo) {
      // The switch must really have happened: one durable entry that moved
      // the model. `from` is deliberately not pinned - it is whatever the mode
      // entry (or the unmeasured `use live`) left as the live model.
      const [entry] = entries;
      assert.equal(
        entry.changed,
        true,
        `the switch must report changed===true (saw ${JSON.stringify(entry)})`,
      );
      assert.notEqual(
        entry.from,
        entry.to,
        `the switch must move the model (saw ${JSON.stringify(entry)})`,
      );
      // Exactly one info notice, carrying the whole activation, and last.
      const infos = all.filter((n) => n.level === undefined || n.level === "info");
      assert.equal(
        infos.length,
        1,
        `exactly one info notice expected (saw ${infos.length} info of ${all.length} notifications: ${noticesText(b, before)})`,
      );
      assert.equal(
        all.at(-1),
        infos[0],
        `the single info notice must be the last notification (saw ${noticesText(b, before)})`,
      );
      const base =
        over.args === "use none" ? PROFILE_DEACTIVATED : PROFILE_ACTIVATED;
      assert.ok(
        infos[0].message.startsWith(base),
        `the single info notice must start with ${JSON.stringify(base)} (saw ${JSON.stringify(infos[0].message)})`,
      );
      if (over.args === "use none") {
        // The deactivation clears the pre-written default profile, so the
        // folded `Default profile cleared (...)` line is expected.
        assert.match(
          infos[0].message,
          /Default profile cleared \(/,
          `the cleared default profile must be folded into the single notice (saw ${JSON.stringify(infos[0].message)})`,
        );
      } else {
        // Variant (a) is already on "live", so nothing is re-written.
        assert.doesNotMatch(
          infos[0].message,
          /Default profile →/,
          `an unchanged default profile must not be re-announced (saw ${JSON.stringify(infos[0].message)})`,
        );
      }
      assert.equal(
        separateLiveOwnerNotices(b, before).length,
        0,
        `no separate live-owner info notice expected (saw ${noticesText(b, before)})`,
      );
    }
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

// ── RED: one info notice per switch (regression target) ──────────────

test("profile switch notice: Plan activation emits exactly one info notice", () =>
  activationCase({ mode: "plan", expectSingleInfo: true }));
test("profile switch notice: Build activation emits exactly one info notice", () =>
  activationCase({ mode: "build", expectSingleInfo: true }));
test("profile switch notice: Orchestrator parent activation emits exactly one info notice", () =>
  activationCase({ mode: "orchestrator", expectSingleInfo: true }));
test("profile switch notice: Default activation emits exactly one info notice", () =>
  activationCase({ mode: "default", expectSingleInfo: true }));
test("profile switch notice: /profile use none emits one deactivation info notice", () =>
  activationCase({
    args: "use none",
    activateFirst: true,
    expectSingleInfo: true,
  }));
test("profile switch notice: child-tab activation emits exactly one info notice", () =>
  activationCase({ mode: "orchestrator", childTab: true, expectSingleInfo: true }));
test("profile switch notice: /role set activation emits exactly one info notice", () =>
  activationCase({ role: true, expectSingleInfo: true }));

/**
 * The reported scenario: `/orchestrator` then `/profile use live`. Without the
 * profile's orchestrator override the mode entry and the activation resolve the
 * SAME model, so the switch under test would be a no-op - which is why PROFILE
 * carries `p/orchestrator` and this case pins `changed === true`.
 */
test("profile switch notice: the orchestrator parent really switches and reports once", async () => {
  const b = await boot({ orchestrator: true });
  try {
    writeProjectSettings(b.cwd, { workflow: { defaultProfile: "live" } });
    const enter = b.pi.commands["orchestrator"];
    assert.ok(enter, "orchestrator must be registered");
    await enter.handler("", b.ctx);
    const before = b.made.notifies.length;
    await activate(b);

    const entries = switchEntries(b);
    assert.equal(
      entries.length,
      1,
      `exactly one durable switch entry expected (saw ${JSON.stringify(entries)})`,
    );
    const parent = entries[0];
    assert.equal(parent.role, "parent", `the parent owns the orchestrator entry (saw ${JSON.stringify(parent)})`);
    assert.equal(parent.changed, true, `the orchestrator switch must report changed===true (saw ${JSON.stringify(parent)})`);
    assert.notEqual(parent.from, parent.to, `the orchestrator switch must move the model (saw ${JSON.stringify(parent)})`);
    assert.equal(parent.to, "p/orchestrator", `the orchestrator must land on the profile model (saw ${JSON.stringify(parent)})`);
    assert.notEqual(parent.from, "", "the audit must name the model the parent came from");

    const infos = infoNotices(b, before);
    assert.equal(
      infos.length,
      1,
      `exactly one info notice expected (saw ${infos.length} of ${b.made.notifies.slice(before).length} notifications: ${noticesText(b, before)})`,
    );
    assert.ok(
      infos[0].message.startsWith(PROFILE_ACTIVATED),
      `the single info notice must start with ${JSON.stringify(PROFILE_ACTIVATED)} (saw ${JSON.stringify(infos[0].message)})`,
    );
    assert.match(
      infos[0].message,
      /orchestrator → p\/orchestrator/,
      `the single notice must report the orchestrator model it applied (saw ${JSON.stringify(infos[0].message)})`,
    );
  } finally {
    await b.cleanup();
  }
});

/** A live reviewer's switch belongs to the activation's one notice. */
test("profile switch notice: a live reviewer folds into the single activation notice", async () => {
  const b = await boot({ reviewer: holdReviewer() });
  try {
    writeProjectSettings(b.cwd, { workflow: { defaultProfile: "live" } });
    await b.pi.commands["workflow"].handler("", b.ctx);
    await startHeldReview(b);
    const before = b.made.notifies.length;
    await activate(b);

    const all = b.made.notifies.slice(before);
    const infos = infoNotices(b, before);
    assert.equal(
      infos.length,
      1,
      `exactly one info notice expected (saw ${infos.length} of ${all.length} notifications: ${noticesText(b, before)})`,
    );
    assert.equal(
      all.at(-1),
      infos[0],
      `the single info notice must be the last notification (saw ${noticesText(b, before)})`,
    );
    assert.ok(
      infos[0].message.startsWith(PROFILE_ACTIVATED),
      `the single info notice must start with ${JSON.stringify(PROFILE_ACTIVATED)} (saw ${JSON.stringify(infos[0].message)})`,
    );
    assert.match(
      infos[0].message,
      /Live reviewer → p\/reviewer/,
      `the live reviewer line must be folded into the single notice (saw ${JSON.stringify(infos[0].message)})`,
    );
    assert.equal(
      separateLiveOwnerNotices(b, before).length,
      0,
      `no separate live-owner info notice expected (saw ${noticesText(b, before)})`,
    );

    const reviewer = switchEntries(b).find((entry) => entry.role === "reviewer");
    assert.ok(
      reviewer,
      `the live reviewer switch must still be audited (entries: ${JSON.stringify(switchEntries(b))})`,
    );
    assert.equal(
      reviewer.changed,
      true,
      `the live reviewer must really move to the profile model (saw ${JSON.stringify(reviewer)})`,
    );
  } finally {
    await b.cleanup();
  }
});

/** A live Build child's switch belongs to the activation's one notice. */
test("profile switch notice: a live Build child folds into the single activation notice", async () => {
  const b = await boot({ orchestrator: true });
  try {
    writeProjectSettings(b.cwd, { workflow: { defaultProfile: "live" } });
    await b.pi.commands["orchestrator"].handler("", b.ctx);
    await dispatchBuilder(b);
    const before = b.made.notifies.length;
    await activate(b);

    const all = b.made.notifies.slice(before);
    const infos = infoNotices(b, before);
    assert.equal(
      infos.length,
      1,
      `exactly one info notice expected (saw ${infos.length} of ${all.length} notifications: ${noticesText(b, before)})`,
    );
    assert.equal(
      all.at(-1),
      infos[0],
      `the single info notice must be the last notification (saw ${noticesText(b, before)})`,
    );
    assert.ok(
      infos[0].message.startsWith(PROFILE_ACTIVATED),
      `the single info notice must start with ${JSON.stringify(PROFILE_ACTIVATED)} (saw ${JSON.stringify(infos[0].message)})`,
    );
    assert.match(
      infos[0].message,
      /Live Builder → p\/builder/,
      `the live Build child line must be folded into the single notice (saw ${JSON.stringify(infos[0].message)})`,
    );
    assert.equal(
      separateLiveOwnerNotices(b, before).length,
      0,
      `no separate live-owner info notice expected (saw ${noticesText(b, before)})`,
    );

    const child = switchEntries(b).find((entry) => entry.role === "builder-child");
    assert.ok(
      child,
      `the live Build child switch must still be audited (entries: ${JSON.stringify(switchEntries(b))})`,
    );
    assert.equal(
      child.changed,
      true,
      `the live Build child must really move to the profile model (saw ${JSON.stringify(child)})`,
    );
  } finally {
    await b.cleanup();
  }
});

/** `/role set` is the other activation surface: one notice, folded live owner. */
test("profile switch notice: /role set folds the live reviewer into one info notice", async () => {
  const b = await boot({ reviewer: holdReviewer() });
  try {
    await startHeldReview(b);
    const before = b.made.notifies.length;
    const role = b.pi.commands["role"];
    assert.ok(role, "role must be registered");
    await role.handler("set reviewer p/reviewer xhigh", b.ctx);

    const all = b.made.notifies.slice(before);
    const infos = infoNotices(b, before);
    assert.equal(
      infos.length,
      1,
      `exactly one info notice expected (saw ${infos.length} of ${all.length} notifications: ${noticesText(b, before)})`,
    );
    assert.match(
      infos[0].message,
      /Live reviewer → p\/reviewer/,
      `the live reviewer line must be folded into the single notice (saw ${JSON.stringify(infos[0].message)})`,
    );
    assert.equal(
      separateLiveOwnerNotices(b, before).length,
      0,
      `no separate live-owner info notice expected (saw ${noticesText(b, before)})`,
    );
  } finally {
    await b.cleanup();
  }
});

/**
 * `/role use` does NOT reconcile live owners: its one notice carries the model
 * it applied to the parent instead. `explorer` is chosen because its base model
 * differs from the Build-mode model, so the switch is real (not the
 * already-on-target branch, which stays silent).
 */
test("profile switch notice: /role use reports the applied model in one info notice", async () => {
  const b = await boot({ orchestrator: true });
  try {
    const build = b.pi.commands["build"];
    assert.ok(build, "build must be registered");
    await build.handler("", b.ctx);
    const before = b.made.notifies.length;
    const role = b.pi.commands["role"];
    assert.ok(role, "role must be registered");
    await role.handler("use explorer", b.ctx);

    const all = b.made.notifies.slice(before);
    const infos = infoNotices(b, before);
    assert.equal(
      infos.length,
      1,
      `exactly one info notice expected (saw ${infos.length} of ${all.length} notifications: ${noticesText(b, before)})`,
    );
    assert.match(
      infos[0].message,
      /Workflow build: model → /,
      `the single notice must carry the applied model line (saw ${JSON.stringify(infos[0].message)})`,
    );
    assert.doesNotMatch(
      infos[0].message,
      /Live (reviewer|Builder) →/,
      `a /role use must not fold a live-owner line (saw ${JSON.stringify(infos[0].message)})`,
    );
  } finally {
    await b.cleanup();
  }
});

/**
 * Variant (b): a FRESH boot with no `workflow.defaultProfile` key of its own, so
 * the activation writes it (index.ts:1666-1672) and must fold that line in.
 * Variant (a) cannot cover this: its key is already "live", so before === after
 * and the write stays silent.
 */
test("profile switch notice: the default-profile write folds into the single activation notice", async () => {
  const b = await boot();
  try {
    await b.pi.commands["workflow"].handler("", b.ctx);
    const before = b.made.notifies.length;
    await activate(b);

    const all = b.made.notifies.slice(before);
    const infos = infoNotices(b, before);
    assert.equal(
      infos.length,
      1,
      `exactly one info notice expected (saw ${infos.length} of ${all.length} notifications: ${noticesText(b, before)})`,
    );
    assert.equal(
      all.at(-1),
      infos[0],
      `the single info notice must be the last notification (saw ${noticesText(b, before)})`,
    );
    assert.ok(
      infos[0].message.startsWith(PROFILE_ACTIVATED),
      `the single info notice must start with ${JSON.stringify(PROFILE_ACTIVATED)} (saw ${JSON.stringify(infos[0].message)})`,
    );
    assert.match(
      infos[0].message,
      /Default profile → ⚡ live \(/,
      `the default-profile write must be folded into the single notice (saw ${JSON.stringify(infos[0].message)})`,
    );
  } finally {
    await b.cleanup();
  }
});
