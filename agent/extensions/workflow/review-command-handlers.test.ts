/**
 * `/review` command handlers — the seven former siblings folded into one.
 *
 * These drive the REAL workflow extension through the fake Pi host, so they
 * prove the dispatcher's Decision 3 guard table against the real handler
 * bodies: `status`/`pause`/`abort`/`mode`/`prompt` are control/configuration
 * questions that must answer without a reviewer, `resume` refuses outside Plan
 * through admission, and a near-verb path token earns a "did you mean" hint.
 *
 * Nothing here starts a reviewer: every case asserts the fake host sent no
 * prompt and opened no modal, so a regression that turns a status read into a
 * round fails loudly instead of hanging.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import workflowExtension from "./index.ts";
import {
  reviewInputAllowed,
  reviewInputDecision,
} from "./review.ts";
import { makeFakeCtx, makeFakePi, tmpProject } from "./test-support.ts";

interface Booted {
  pi: ReturnType<typeof makeFakePi>;
  ctx: any;
  fake: ReturnType<typeof makeFakeCtx>;
  cleanup: () => void;
}

/**
 * Boot one factory on a temp project in Default mode (not Plan): the
 * guard-free verbs must answer there, and `resume` must refuse there.
 * `plan: true` enters Plan mode first (the round form's admission needs it).
 */
async function boot(over: { plan?: boolean } = {}): Promise<Booted> {
  const { root, cwd, agentDir } = tmpProject();
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
  fs.writeFileSync(
    path.join(cwd, ".pi", "settings.json"),
    JSON.stringify({ workflow: { commitPolicy: { mode: "never" } } }, null, 2),
  );
  const pi = makeFakePi();
  await workflowExtension(pi as never, { selfExtensionPath: "/fake/index.ts" });
  const fake = makeFakeCtx({ cwd, hasUI: false, idle: true });
  await pi.emit("session_start", { reason: "startup" }, fake.ctx);
  if (over.plan === true) {
    await pi.commands["workflow"].handler("", fake.ctx);
  }
  const cleanup = () => {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  };
  return { pi, ctx: fake.ctx, fake, cleanup };
}

/** Run `/review <args>` and return the notices it added for THIS call. */
async function runReview(
  booted: Booted,
  args: string,
): Promise<Array<{ message: string; level?: string }>> {
  const before = booted.fake.notifies.length;
  await booted.pi.commands["review"].handler(args, booted.ctx);
  return booted.fake.notifies.slice(before);
}

/** Every case also proves no reviewer work was started. */
function assertNoReviewerStarted(booted: Booted, sentBefore: number): void {
  assert.equal(
    booted.pi.sent.length,
    sentBefore,
    "no prompt was sent to a reviewer",
  );
  assert.deepEqual(booted.fake.customs, [], "no modal was opened");
  assert.deepEqual(booted.fake.selects, [], "no question was asked");
}

test("review status: the idle round reports without starting a reviewer", async () => {
  const booted = await boot();
  try {
    const sentBefore = booted.pi.sent.length;
    const notices = await runReview(booted, "status");
    assert.equal(notices.length, 1);
    assert.equal(notices[0]?.level, "info");
    assert.match(notices[0]!.message, /Review Mode is OFF/);
    assert.match(notices[0]!.message, /Manual review is Plan mode only/);
    assertNoReviewerStarted(booted, sentBefore);
  } finally {
    booted.cleanup();
  }
});

test("review mode status: reports configuration, not the round", async () => {
  const booted = await boot();
  try {
    const sentBefore = booted.pi.sent.length;
    const notices = await runReview(booted, "mode status");
    assert.equal(notices.length, 1);
    assert.equal(notices[0]?.level, "info");
    // The Decision 4 distinction: enabled/timeout/sources, never findings.
    assert.match(notices[0]!.message, /Review Mode/);
    assert.match(notices[0]!.message, /timeout/i);
    assert.doesNotMatch(notices[0]!.message, /phase {3}:/);
    assertNoReviewerStarted(booted, sentBefore);
  } finally {
    booted.cleanup();
  }
});

test("review pause and abort: no round means a notice, not an error", async () => {
  const booted = await boot();
  try {
    const sentBefore = booted.pi.sent.length;
    const pause = await runReview(booted, "pause");
    assert.equal(pause.length, 1);
    assert.equal(pause[0]?.message, "No review round running.");

    const abort = await runReview(booted, "abort");
    assert.equal(abort.length, 1);
    assert.equal(
      abort[0]?.message,
      "Nothing to abort — no review, pause, or handoff is active.",
    );
    assertNoReviewerStarted(booted, sentBefore);
  } finally {
    booted.cleanup();
  }
});

test("review prompt without a UI: prints the guidance, writes nothing", async () => {
  const booted = await boot();
  try {
    const sentBefore = booted.pi.sent.length;
    const notices = await runReview(booted, "prompt");
    assert.equal(notices.length, 1);
    assert.equal(notices[0]?.level, "info");
    assert.match(notices[0]!.message, /^Reviewer guidance \(/);
    assertNoReviewerStarted(booted, sentBefore);
  } finally {
    booted.cleanup();
  }
});

test("review resume outside Plan: refused through admission, warning level", async () => {
  const booted = await boot();
  try {
    const sentBefore = booted.pi.sent.length;
    const notices = await runReview(booted, "resume");
    assert.equal(notices.length, 1);
    assert.equal(notices[0]?.level, "warning");
    assert.match(
      notices[0]!.message,
      /Review is available in Plan mode only — switch with \/plan, then run \/review\./,
    );
    assertNoReviewerStarted(booted, sentBefore);
  } finally {
    booted.cleanup();
  }
});

test("review stat: an unresolved near-verb path earns a did-you-mean line", async () => {
  const booted = await boot({ plan: true });
  try {
    const sentBefore = booted.pi.sent.length;
    const notices = await runReview(booted, "stat");
    assert.equal(notices.length, 1);
    assert.equal(notices[0]?.level, "warning");
    // The path fallback (Decision 5) resolved to a non-plan path, so the
    // refusal names the plan directory and appends the verb hint.
    assert.match(notices[0]!.message, /Review only reads plans under/);
    assert.match(notices[0]!.message, /Did you mean "[a-z]+"\?/);
    // A nearer token names the obvious verb unambiguously.
    const nearer = await runReview(booted, "statu");
    assert.equal(nearer.length, 1);
    assert.match(nearer[0]!.message, /Did you mean "status"\?/);
    assertNoReviewerStarted(booted, sentBefore);
  } finally {
    booted.cleanup();
  }
});

test("review parse errors are warnings, never a round", async () => {
  const booted = await boot();
  try {
    const sentBefore = booted.pi.sent.length;

    const badScope = await runReview(booted, "mode on garbage");
    assert.equal(badScope.length, 1);
    assert.equal(badScope[0]?.level, "warning");
    assert.match(badScope[0]!.message, /Unknown scope "garbage"\. Expected global\|project\./);
    assert.match(badScope[0]!.message, /Usage: \/review mode/);

    const emptySay = await runReview(booted, "say");
    assert.equal(emptySay.length, 1);
    assert.equal(emptySay[0]?.level, "warning");
    assert.match(emptySay[0]!.message, /A message is required\./);
    assert.match(emptySay[0]!.message, /Usage: \/review say <msg>/);

    const extraArg = await runReview(booted, "status now");
    assert.equal(extraArg.length, 1);
    assert.equal(extraArg[0]?.level, "warning");
    assert.match(extraArg[0]!.message, /Unexpected argument "now"\./);

    assertNoReviewerStarted(booted, sentBefore);
  } finally {
    booted.cleanup();
  }
});

test("review help: the table and one verb's guards, no reviewer", async () => {
  const booted = await boot();
  try {
    const sentBefore = booted.pi.sent.length;
    const all = await runReview(booted, "help");
    assert.equal(all.length, 1);
    assert.match(all[0]!.message, /Usage: \/review \[<verb>\] \[args\]/);
    assert.match(all[0]!.message, /\/review mode status reports configuration/);

    const mode = await runReview(booted, "mode --help");
    assert.equal(mode.length, 1);
    assert.match(mode[0]!.message, /Usage: \/review mode/);
    assert.match(mode[0]!.message, /refuses while a Build child is active \(/);
    assertNoReviewerStarted(booted, sentBefore);
  } finally {
    booted.cleanup();
  }
});

test("reviewInputAllowed: /review pause is allowed while a round owns the turn", () => {
  assert.equal(reviewInputAllowed("/review pause"), true);
  assert.equal(reviewInputAllowed("/review abort"), true);
  assert.equal(
    reviewInputAllowed("/review-pause"),
    true,
    "the blanket /review prefix still covers the folded grammar",
  );
  assert.deepEqual(reviewInputDecision("/review pause", "running"), {
    action: "allow",
  });
  assert.deepEqual(reviewInputDecision("/review pause", "paused"), {
    action: "allow",
  });
  // A plain prompt is still blocked while the reviewer owns the turn.
  assert.equal(reviewInputDecision("change the plan", "running").action, "block");
});
