/**
 * Tests for the pure Planner↔Reviewer negotiation policy and its live wiring.
 *
 * `decidePlanRevision` is the only place the loop condition is computed, so
 * the first half of this suite pins the whole decision table: failed outcomes,
 * the disabled budget, convergence, no-revision verdicts, exhaustion, the
 * continue case, the boundaries, junk inputs (never throws) and one 13-note
 * negotiation that continues three times and then exhausts.
 *
 * The second half drives the REAL extension through the fake Pi host to pin
 * the loop seam added in step 3: a revise round sends exactly one Planner
 * follow-up and never presents the handoff, a settled tool / silent body edit
 * re-reviews, a no-op hands the notes over, the budget stops after
 * `maxRevisions`, and a fresh prompt drops a stale revision turn.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import {
  MAX_REVISIONS_LIMIT,
  decidePlanRevision,
  type PlanRevisionInput,
} from "./review-negotiation.ts";
import type { ReviewExecutionOutcome, ReviewVerdict } from "./review.ts";
import {
  getUtcDateTimePrefix,
  parseReviewNotes,
  renderRequiredChanges,
  splitReviewerAppendix,
  type ReviewNote,
} from "./utils.ts";
import { HANDOFF_PLAN_ENTRY_TYPE } from "./handoff-view.ts";
import workflowExtension from "./index.ts";
import {
  fakeSdk,
  makeFakeCtx,
  makeFakeOrchestratorChildFactory,
  makeFakePi,
  scriptedReviewer,
  submitReviewRound,
  submitThenFinish,
  tmpProject,
  type FakeCapture,
  type FakeOrchestratorChildOptions,
} from "./test-support.ts";

/** A note list of `count` synthetic notes, `R1..Rn`. */
function notes(count: number): ReviewNote[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `R${i + 1}`,
    step: String((i % 19) + 1),
    change: `Fix thing ${i + 1}`,
  }));
}

function decide(
  patch: Partial<PlanRevisionInput> & {
    reviewOutcome?: ReviewExecutionOutcome;
    verdict?: ReviewVerdict;
  } = {},
) {
  return decidePlanRevision({
    reviewOutcome: "rewritten",
    verdict: "revise",
    notes: notes(2),
    revisionsUsed: 0,
    maxRevisions: 3,
    ...patch,
  });
}

// ── Failed rounds ────────────────────────────────────────────────────

test("failed outcomes never request a revision", () => {
  for (const reviewOutcome of [
    "paused",
    "aborted",
    "fallback",
    "skipped",
  ] as const) {
    const decision = decide({ reviewOutcome, verdict: "revise" });
    assert.equal(decision.request, false, reviewOutcome);
    assert.equal(decision.outcome, "review-failed", reviewOutcome);
    assert.ok(decision.reason.length > 0, reviewOutcome);
    assert.match(decision.reason, new RegExp(reviewOutcome));
  }
});

test("a failed round wins over every other rule, including a spent budget", () => {
  const decision = decide({
    reviewOutcome: "paused",
    verdict: "approve",
    notes: [],
    revisionsUsed: 9,
    maxRevisions: 0,
  });
  assert.equal(decision.outcome, "review-failed");
  assert.equal(decision.request, false);
});

test("usable outcomes are rewritten and unchanged", () => {
  for (const reviewOutcome of ["rewritten", "unchanged"] as const) {
    assert.equal(decide({ reviewOutcome }).outcome, "continue", reviewOutcome);
  }
});

// ── Disabled budget ──────────────────────────────────────────────────

test("maxRevisions 0 disables the loop (one-shot review)", () => {
  const decision = decide({ maxRevisions: 0, notes: notes(13) });
  assert.equal(decision.request, false, "a zero budget never requests");
  assert.equal(decision.outcome, "no-revision");
  assert.match(decision.reason, /disabled/);
  assert.match(decision.reason, /one-shot/);
  assert.equal(decision.maxRevisions, 0);
});

test("the disabled check runs before convergence", () => {
  // Plan step 1 rules are ordered: disabled first, then approve/no-notes.
  const decision = decide({ maxRevisions: 0, verdict: "approve", notes: [] });
  assert.equal(decision.outcome, "no-revision");
  assert.match(decision.reason, /disabled/);
});

// ── Converged / no-revision ──────────────────────────────────────────

test("approve with no notes converges", () => {
  const decision = decide({ verdict: "approve", notes: [] });
  assert.equal(decision.outcome, "converged");
  assert.equal(decision.request, false);
  assert.match(decision.reason, /approved/);
});

test("a revise/block verdict with no notes offers nothing to revise", () => {
  for (const verdict of ["revise", "block"] as const) {
    const decision = decide({ verdict, notes: [] });
    assert.equal(decision.request, false, verdict);
    assert.equal(decision.outcome, "no-revision", verdict);
    assert.match(decision.reason, new RegExp(verdict));
  }
});

test("no notes and no verdict is not a revision request", () => {
  const decision = decide({ verdict: undefined, notes: [] });
  assert.equal(decision.request, false);
  assert.equal(decision.outcome, "no-revision");
  assert.match(decision.reason, /no verdict/);
});

test("approve carrying notes is not convergence while the budget lasts", () => {
  // Step 5 makes approve+notes impossible at review_submit; if it slips
  // through the loop must still work the notes rather than call it converged.
  const decision = decide({ verdict: "approve", notes: notes(1) });
  assert.equal(decision.outcome, "continue");
  assert.equal(decision.request, true);
});

// ── Budget boundaries ────────────────────────────────────────────────

test("budget boundaries: 0 used continues, used === max exhausts", () => {
  const first = decide({ revisionsUsed: 0, maxRevisions: 3 });
  assert.equal(first.outcome, "continue");
  assert.equal(first.request, true);
  assert.equal(first.revisionsUsed, 0);
  assert.equal(first.maxRevisions, 3);

  const third = decide({ revisionsUsed: 2, maxRevisions: 3 });
  assert.equal(third.outcome, "continue");
  assert.match(third.reason, /Planner revision 3 of 3/);

  const spent = decide({ revisionsUsed: 3, maxRevisions: 3 });
  assert.equal(spent.outcome, "exhausted");
  assert.equal(spent.request, false);
  assert.match(spent.reason, /budget spent \(3\/3\)/);
  assert.match(spent.reason, /open notes/);

  const past = decide({ revisionsUsed: 4, maxRevisions: 3 });
  assert.equal(past.outcome, "exhausted");
});

test("a one-revision budget requests exactly once", () => {
  assert.equal(decide({ maxRevisions: 1, revisionsUsed: 0 }).outcome, "continue");
  assert.equal(decide({ maxRevisions: 1, revisionsUsed: 1 }).outcome, "exhausted");
});

// ── Junk inputs ──────────────────────────────────────────────────────

test("non-finite and negative counters are normalized", () => {
  for (const junk of [Number.NaN, -3, Number.POSITIVE_INFINITY, -0.5]) {
    const decision = decide({ revisionsUsed: junk as number, maxRevisions: 3 });
    assert.equal(decision.revisionsUsed, 0, String(junk));
    assert.equal(decision.outcome, "continue", String(junk));
  }
});

test("out-of-range budgets are clamped to 0..5", () => {
  const clampedHigh = decide({ maxRevisions: 99, revisionsUsed: 5 });
  assert.equal(clampedHigh.maxRevisions, MAX_REVISIONS_LIMIT);
  assert.equal(clampedHigh.outcome, "exhausted");

  const clampedNegative = decide({ maxRevisions: -2, notes: notes(1) });
  assert.equal(clampedNegative.maxRevisions, 0);
  assert.equal(clampedNegative.outcome, "no-revision");

  const fractional = decide({ maxRevisions: 2.9, revisionsUsed: 1.9 });
  assert.equal(fractional.maxRevisions, 2);
  assert.equal(fractional.revisionsUsed, 1);
  assert.equal(fractional.outcome, "continue");
});

test("junk string counters fall back instead of throwing", () => {
  const decision = decide({
    revisionsUsed: "junk" as unknown as number,
    maxRevisions: "junk" as unknown as number,
  });
  assert.equal(decision.revisionsUsed, 0);
  assert.equal(decision.maxRevisions, 0);
  assert.equal(decision.outcome, "no-revision");
});

test("a garbage input object still returns a decision", () => {
  for (const junk of [
    null,
    undefined,
    {},
    { notes: "not-an-array" },
    { notes: null, reviewOutcome: "nonsense" },
  ]) {
    const decision = decidePlanRevision(junk as unknown as PlanRevisionInput);
    assert.equal(decision.request, false, String(junk));
    assert.equal(decision.outcome, "review-failed", String(junk));
    assert.ok(decision.reason.length > 0, String(junk));
  }
});

// ── The loop ─────────────────────────────────────────────────────────

test("13 open notes with maxRevisions 3: three continues, then exhausted", () => {
  const openNotes = notes(13);
  let revisionsUsed = 0;
  const outcomes: string[] = [];

  for (let turn = 0; turn < 10; turn += 1) {
    const decision = decidePlanRevision({
      reviewOutcome: "rewritten",
      verdict: "revise",
      notes: openNotes,
      revisionsUsed,
      maxRevisions: 3,
    });
    outcomes.push(decision.outcome);
    if (!decision.request) break;
    revisionsUsed += 1;
  }

  assert.deepEqual(outcomes, ["continue", "continue", "continue", "exhausted"]);
  assert.equal(revisionsUsed, 3);

  const final = decidePlanRevision({
    reviewOutcome: "rewritten",
    verdict: "revise",
    notes: openNotes,
    revisionsUsed,
    maxRevisions: 3,
  });
  assert.equal(final.request, false);
  assert.match(final.reason, /13 open notes/);
});

test("the decision carries the budget it applied", () => {
  const decision = decide({ revisionsUsed: 1, maxRevisions: 4 });
  assert.deepEqual(
    [decision.revisionsUsed, decision.maxRevisions],
    [1, 4],
  );
});

// ── The live seam (real extension, fake Pi host) ──────────────────────

const LOOP_PLAN = [
  "# Plan: Export",
  "",
  "## Steps",
  "",
  "1. Add the CSV writer",
  "2. Add the route",
  "",
  "## Verification",
  "",
  "- Run the export test suite",
  "",
].join("\n");

interface LoopBoot {
  pi: ReturnType<typeof makeFakePi>;
  ctx: any;
  fake: ReturnType<typeof makeFakeCtx>;
  capture: { prompts: string[] };
  cwd: string;
  planPath: string;
  /** The plan text `endRun` reports as the Planner's assistant message. */
  planText: string;
  cleanup(): void;
}

/**
 * Boot the real extension on a temp project in Plan mode with Review Mode on
 * and a fake reviewer. The default reviewer submits one revise note (R1) every
 * round; `reviewer` replaces it with a scripted per-round sequence.
 */
async function bootLoop(
  over: {
    maxRevisions?: number;
    hasUI?: boolean;
    plan?: string;
    reviewer?: (capture: FakeCapture) => Promise<void>;
  } = {},
): Promise<LoopBoot> {
  const { root, cwd, agentDir } = tmpProject();
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
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
            maxRevisions: over.maxRevisions ?? 3,
            timeoutMs: 10_000,
            providerRecovery: "off",
            fallbackOnError: "skip",
          },
        },
      },
      null,
      2,
    ),
  );
  // An existing plan is never renamed by the append-only writer.
  const planPath = path.join(
    cwd,
    ".pi",
    "plans",
    `${getUtcDateTimePrefix()}-loop.md`,
  );
  const planText = over.plan ?? LOOP_PLAN;
  fs.writeFileSync(planPath, planText, "utf8");
  const pi = makeFakePi({ activeTools: ["read", "write", "edit", "bash"] });
  const { sdk, capture } = fakeSdk({
    pass1: over.reviewer ?? submitThenFinish("# Plan: loop"),
  });
  await workflowExtension(pi as never, {
    loadSdk: async () => sdk as never,
    selfExtensionPath: "/fake/index.ts",
    plannotatorRequestTimeoutMs: 20,
    plannotatorRecoveryTimeoutMs: 20,
    isTerminalHost: () => true,
  });
  const fake = makeFakeCtx({ cwd, hasUI: over.hasUI === true, idle: false });
  await pi.emit("session_start", { reason: "startup" }, fake.ctx);
  await pi.commands["workflow"].handler("", fake.ctx);
  const cleanup = () => {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  };
  return {
    pi,
    ctx: fake.ctx,
    fake,
    capture: capture as unknown as { prompts: string[] },
    cwd,
    planPath,
    planText,
    cleanup,
  };
}

/** The Planner wrote the plan in Plan mode, then the run ended. */
async function plannerWrotePlan(booted: LoopBoot): Promise<void> {
  await booted.pi.emit(
    "tool_result",
    { toolName: "write", isError: false, input: { path: booted.planPath } },
    booted.ctx,
  );
  await endRun(booted);
}

async function endRun(booted: LoopBoot): Promise<void> {
  await booted.pi.emit(
    "agent_end",
    {
      type: "agent_end",
      willRetry: false,
      messages: [
        { role: "assistant", content: [{ type: "text", text: booted.planText }] },
      ],
    },
    booted.ctx,
  );
}

/** Planner revision follow-ups sent to the plan agent (`sendUserMessage`). */
function revisionFollowUps(booted: LoopBoot): Array<{ content: unknown; options?: unknown }> {
  return booted.pi.sent.filter(
    (entry) =>
      typeof entry.content === "string" &&
      entry.content.includes("# Planner revision"),
  );
}

/** Handoff presentations (headless fallback message or native modal). */
function handoffs(booted: LoopBoot): unknown[] {
  return booted.pi.sent.filter(
    (entry) =>
      (entry.content as { customType?: string } | null)?.customType ===
      "workflow-handoff-fallback",
  );
}

/** Change the plan BODY, keeping the Reviewer's appendix byte-identical. */
function revisePlanBody(planPath: string): void {
  const live = fs.readFileSync(planPath, "utf8");
  const split = splitReviewerAppendix(live);
  const body = split.body.replace(
    "2. Add the route",
    "2. Add the route\n3. Add the exporter",
  );
  fs.writeFileSync(planPath, `${body.trimEnd()}\n\n${split.appendix}`, "utf8");
}

/** Run the Planner's `plan_revision_done` report through the real tool. */
async function reportRevision(
  booted: LoopBoot,
  responses: Array<{ id: string; status: string; reason?: string }>,
): Promise<{ isError?: boolean; content: Array<{ text: string }> }> {
  const tool = booted.pi.tools["plan_revision_done"];
  assert.ok(tool, "plan_revision_done is registered");
  return (await tool.execute(
    "call-revision",
    { responses },
    undefined,
    undefined,
    {},
  )) as { isError?: boolean; content: Array<{ text: string }> };
}

/** The durable transcript entry presentPlanHandoff prints for the user. */
function handoffPlan(
  booted: LoopBoot,
): { planText: string; planPath?: string; verdict?: string } | undefined {
  const entry = [...booted.pi.entries]
    .reverse()
    .find((item) => item.type === HANDOFF_PLAN_ENTRY_TYPE);
  return entry?.data as
    | { planText: string; planPath?: string; verdict?: string }
    | undefined;
}

/** The latest persisted `workflow` entry state. */
function workflowState(booted: LoopBoot): Record<string, unknown> {
  const entry = [...booted.pi.entries]
    .reverse()
    .find((item) => item.type === "workflow");
  return (entry?.data ?? {}) as Record<string, unknown>;
}

/**
 * Render the native handoff questionnaire the host would show and dismiss it.
 * The rendered lines are the user-visible handoff (context + options).
 */
function captureNativeHandoff(booted: LoopBoot): string[] {
  const lines: string[] = [];
  booted.ctx.ui.custom = async (
    factory: (
      tui: unknown,
      theme: unknown,
      keybindings: unknown,
      done: unknown,
    ) => { render(width: number): string[] },
  ) => {
    const view = factory(
      { terminal: { rows: 60, columns: 100 }, requestRender() {} },
      {
        fg: (_color: string, text: string) => text,
        bg: (_color: string, text: string) => text,
        bold: (text: string) => text,
        strikethrough: (text: string) => text,
      },
      {},
      () => {},
    );
    lines.push(...view.render(100));
    return null;
  };
  return lines;
}

test("loop seam: a revise round sends one Planner follow-up and no handoff", async () => {
  const booted = await bootLoop();
  try {
    await plannerWrotePlan(booted);
    // The Reviewer appended R1 with a revise verdict → exactly one Planner turn.
    const followUps = revisionFollowUps(booted);
    assert.equal(followUps.length, 1, "exactly one revision follow-up");
    const followUp = followUps[0]!;
    assert.equal(
      (followUp.options as { deliverAs?: string } | undefined)?.deliverAs,
      "followUp",
      "the revision turn is a followUp send",
    );
    assert.equal(
      (followUp.options as { triggerTurn?: unknown } | undefined)?.triggerTurn,
      undefined,
      "never a triggerTurn send",
    );
    assert.equal(
      (followUp.options as { steer?: unknown } | undefined)?.steer,
      undefined,
      "never a steer",
    );
    assert.match(String(followUp.content), /Planner revision — round 1 of 3/);
    // No handoff while the negotiation is running.
    assert.deepEqual(handoffs(booted), [], "no handoff on the revise round");
    assert.deepEqual(booted.fake.customs, [], "no native modal");
    const revisionEntry = [...booted.pi.entries]
      .reverse()
      .find((entry) => entry.type === "workflow-review-revision");
    assert.ok(revisionEntry, "the revision turn is audited");
    assert.deepEqual(
      (revisionEntry!.data as { noteIds?: string[] }).noteIds,
      ["R1"],
    );
  } finally {
    booted.cleanup();
  }
});

test("loop e2e: revise 2 notes → one follow-up; approve round 2 → handoff, no run", async () => {
  const reviewer = scriptedReviewer([
    async (capture) => {
      await submitReviewRound(capture, {
        verdict: "revise",
        revisions: [
          { step: "1", change: "Add the CSV writer." },
          { step: "2", change: "Add the route test." },
        ],
      });
    },
    async (capture) => {
      await submitReviewRound(capture, { verdict: "approve", findings: [] });
    },
  ]);
  const booted = await bootLoop({ reviewer: reviewer.pass1 });
  try {
    // The seed is exactly the plan step 8 describes: 2 steps, no appendix.
    const seed = splitReviewerAppendix(booted.planText);
    assert.equal(seed.appendix, "", "the seed plan carries no Reviewer appendix");
    assert.match(seed.body, /^1\. Add the CSV writer$/m);
    assert.match(seed.body, /^2\. Add the route$/m);
    assert.doesNotMatch(seed.body, /^3\./m, "the seed has exactly two steps");

    await plannerWrotePlan(booted);
    // Round 1: exactly one Planner revision turn, never a handoff.
    const followUps = revisionFollowUps(booted);
    assert.equal(followUps.length, 1, "one revision follow-up");
    assert.equal(
      (followUps[0]!.options as { deliverAs?: string } | undefined)?.deliverAs,
      "followUp",
    );
    assert.equal(
      (followUps[0]!.options as { triggerTurn?: unknown } | undefined)
        ?.triggerTurn,
      undefined,
      "the revision turn is never a triggerTurn send",
    );
    assert.equal(
      (followUps[0]!.options as { steer?: unknown } | undefined)?.steer,
      undefined,
      "the revision turn is never a steer",
    );
    assert.match(String(followUps[0]!.content), /Planner revision — round 1 of 3/);
    assert.deepEqual(handoffs(booted), [], "no handoff on the revise round");
    assert.equal(handoffs(booted).length, 0);
    assert.deepEqual(booted.fake.customs, [], "no native handoff modal either");

    // The Planner applies R1, marks R2 not applicable, and reports it.
    const live = fs.readFileSync(booted.planPath, "utf8");
    const split = splitReviewerAppendix(live);
    fs.writeFileSync(
      booted.planPath,
      `${split.body.replace(
        "2. Add the route",
        "2. Add the route\n3. Add the exporter",
      ).trimEnd()}\n\n${split.appendix}`,
      "utf8",
    );
    await booted.pi.emit(
      "tool_result",
      {
        toolName: "write",
        isError: false,
        input: { path: booted.planPath },
      },
      booted.ctx,
    );
    const settled = await reportRevision(booted, [
      { id: "R1", status: "applied" },
      {
        id: "R2",
        status: "not_applicable",
        reason: "The existing route suite already covers it.",
      },
    ]);
    assert.equal(settled.isError, undefined, settled.content[0]?.text);

    // The next run: the Reviewer re-reviews, approves, and the plan hands off.
    await endRun(booted);
    assert.equal(reviewer.round(), 2, "round 2 ran exactly once");
    assert.equal(handoffs(booted).length, 1, "the converged plan hands off");
    assert.equal(revisionFollowUps(booted).length, 1, "no further revision");
    const presented = handoffPlan(booted);
    assert.ok(presented, "the handoff printed the plan into the transcript");
    assert.match(presented!.planText, /3\. Add the exporter/, "final body");
    assert.match(
      presented!.planText,
      /## Reviewer Revisions \(round \d+\)/,
      "the Reviewer's final appendix",
    );
    assert.match(presented!.planText, /Verdict: \*\*approve\*\*/);
    assert.doesNotMatch(
      presented!.planText,
      /### Required changes/,
      "the approving round left no open notes",
    );

    // Nothing executed: no Orchestrator run and no Build kickoff.
    assert.ok(
      !workflowState(booted).orchestratorRun,
      "no Orchestrator run was started",
    );
    assert.deepEqual(
      booted.pi.sent.filter(
        (entry) =>
          (entry.content as { customType?: string } | null)?.customType ===
          "workflow-plan-execute",
      ),
      [],
      "the run never started",
    );
    assert.doesNotMatch(
      JSON.stringify(booted.pi.sent),
      /\[ORCHESTRATOR START\]|\[APPROVED PLAN\]/,
    );
  } finally {
    booted.cleanup();
  }
});

test("loop e2e: editing the Reviewer's appendix is refused and the body survives", async () => {
  const booted = await bootLoop();
  try {
    await plannerWrotePlan(booted);
    const live = fs.readFileSync(booted.planPath, "utf8");
    const expected = splitReviewerAppendix(live);
    assert.ok(expected.appendix.length > 0, "round 1 appended an appendix");
    // The Planner edits the appendix (and not the body) by hand.
    fs.writeFileSync(
      booted.planPath,
      `${expected.body.trimEnd()}\n\n${expected.appendix.replace(
        "R1",
        "R9",
      )}`,
      "utf8",
    );
    const refused = await reportRevision(booted, [
      { id: "R1", status: "applied" },
    ]);
    assert.equal(refused.isError, true, "the edit is refused");
    assert.match(
      refused.content.map((block) => block.text).join("\n"),
      /Do not edit the Reviewer's appendix/,
    );
    // The refusal never writes: the Planner's body is still exactly there.
    const afterRefusal = splitReviewerAppendix(
      fs.readFileSync(booted.planPath, "utf8"),
    );
    assert.equal(afterRefusal.body, expected.body, "the body is preserved");

    // Restore the appendix, apply the note for real, and let the review run.
    const revisedBody = expected.body.replace(
      "2. Add the route",
      "2. Add the route\n3. Add the exporter",
    );
    fs.writeFileSync(
      booted.planPath,
      `${revisedBody.trimEnd()}\n\n${expected.appendix}`,
      "utf8",
    );
    const accepted = await reportRevision(booted, [
      { id: "R1", status: "applied" },
    ]);
    assert.equal(accepted.isError, undefined, accepted.content[0]?.text);
    await endRun(booted);
    assert.equal(
      booted.capture.prompts.length,
      2,
      "the restored revision is re-reviewed",
    );
    // The next Reviewer turn reads the expected appendix, not the tampered one.
    const nextPrompt = booted.capture.prompts[1]!;
    assert.match(nextPrompt, /## Reviewer Revisions \(round 1\)/);
    assert.match(nextPrompt, /R1 · Step 1/);
    assert.doesNotMatch(nextPrompt, /R9 · Step/);
  } finally {
    booted.cleanup();
  }
});

test("loop seam: a settled tool re-reviews the revised body", async () => {
  const booted = await bootLoop();
  try {
    await plannerWrotePlan(booted);
    const promptsBefore = booted.capture.prompts.length;
    // The Planner applies R1, keeps the appendix, and reports it.
    revisePlanBody(booted.planPath);
    await booted.pi.emit(
      "tool_result",
      { toolName: "write", isError: false, input: { path: booted.planPath } },
      booted.ctx,
    );
    const tool = booted.pi.tools["plan_revision_done"];
    assert.ok(tool, "plan_revision_done is registered");
    const result = (await tool.execute(
      "call-1",
      { responses: [{ id: "R1", status: "applied" }] },
      undefined,
      undefined,
      {},
    )) as { isError?: boolean; content: Array<{ text: string }> };
    assert.equal(result.isError, undefined, result.content[0]?.text);
    await endRun(booted);
    // The reviewer ran again on the revised body, and the second revise round
    // requests revision 2.
    assert.equal(
      booted.capture.prompts.length,
      promptsBefore + 1,
      "a settled revision turn re-reviews",
    );
    const followUps = revisionFollowUps(booted);
    assert.equal(followUps.length, 2, "round 2 requested after the re-review");
    assert.match(String(followUps[1]!.content), /Planner revision — round 2 of 3/);
  } finally {
    booted.cleanup();
  }
});

test("loop seam: a silent body change re-reviews without the tool", async () => {
  const booted = await bootLoop();
  try {
    await plannerWrotePlan(booted);
    const promptsBefore = booted.capture.prompts.length;
    // No `plan_revision_done`: the body hash is the only evidence.
    revisePlanBody(booted.planPath);
    await booted.pi.emit(
      "tool_result",
      { toolName: "write", isError: false, input: { path: booted.planPath } },
      booted.ctx,
    );
    await endRun(booted);
    assert.equal(
      booted.capture.prompts.length,
      promptsBefore + 1,
      "a silent body edit re-reviews",
    );
    assert.equal(revisionFollowUps(booted).length, 2);
  } finally {
    booted.cleanup();
  }
});


test("loop e2e: a no-op hands off without re-review, one notice, current appendix", async () => {
  const booted = await bootLoop();
  try {
    await plannerWrotePlan(booted);
    const promptsBefore = booted.capture.prompts.length;
    // The Planner changed nothing: no tool, no body edit.
    await endRun(booted);
    assert.equal(
      booted.capture.prompts.length,
      promptsBefore,
      "an unchanged revision is not re-reviewed",
    );
    assert.equal(revisionFollowUps(booted).length, 1, "no extra revision");
    assert.equal(handoffs(booted).length, 1, "the plan is handed off");
    const notices = booted.fake.notifies.map((n) => n.message);
    const noProgress = notices.filter((message) =>
      message.includes(
        "Planner made no revision — handing off the reviewer's notes",
      ),
    );
    assert.equal(noProgress.length, 1, "exactly one no-progress notice");
    // The handoff carries the plan the user has, with the current appendix.
    const presented = handoffPlan(booted);
    assert.ok(presented, "the plan is printed for the handoff");
    assert.match(
      presented!.planText,
      /## Reviewer Revisions \(round \d+\)/,
      "the current appendix travels with the handoff",
    );
    assert.match(presented!.planText, /R1/);
  } finally {
    booted.cleanup();
  }
});

test("loop e2e: maxRevisions 1 hands off with the non-convergence note", async () => {
  // A persistent revise: every round keeps the same note open.
  const persistent = scriptedReviewer([
    async (capture) => {
      await submitReviewRound(capture, {
        verdict: "revise",
        revisions: [
          { step: "1", change: "Apply the reviewer's required change." },
        ],
      });
    },
    async (capture) => {
      await submitReviewRound(capture, {
        verdict: "revise",
        revisions: [
          { step: "1", change: "Apply the reviewer's required change." },
        ],
      });
    },
  ]);
  const booted = await bootLoop({
    maxRevisions: 1,
    hasUI: true,
    reviewer: persistent.pass1,
  });
  try {
    const nativeHandoff = captureNativeHandoff(booted);
    await plannerWrotePlan(booted);
    assert.equal(revisionFollowUps(booted).length, 1);
    assert.match(String(revisionFollowUps(booted)[0]!.content), /round 1 of 1/);
    // One settled revision spends the whole budget: the re-review's notes hand
    // off instead of starting revision 2.
    revisePlanBody(booted.planPath);
    await booted.pi.emit(
      "tool_result",
      { toolName: "write", isError: false, input: { path: booted.planPath } },
      booted.ctx,
    );
    await booted.pi.tools["plan_revision_done"].execute(
      "call-1",
      { responses: [{ id: "R1", status: "applied" }] },
      undefined,
      undefined,
      {},
    );
    await endRun(booted);
    assert.equal(
      persistent.round(),
      2,
      "the re-review ran once and still asked for a revision",
    );
    assert.equal(revisionFollowUps(booted).length, 1, "no second revision turn");
    // The native questionnaire is the handoff, and it carries the warning.
    const rendered = nativeHandoff.join("\n");
    assert.ok(rendered.length > 0, "the handoff questionnaire rendered");
    assert.match(
      rendered.replace(/\s+/g, " "),
      /Review did not converge after 1 revision — approving accepts the plan as written; Give feedback continues\./,
    );
    assert.match(rendered, /Review: revise/, "the last verdict is shown");
    const presented = handoffPlan(booted);
    assert.equal(presented?.verdict, "revise", "the last verdict is revise");
    assert.match(presented?.planText ?? "", /## Reviewer Revisions \(round \d+\)/);
    const notices = booted.fake.notifies.map((n) => n.message);
    assert.ok(
      notices.some((message) => /budget spent \(1\/1\)/.test(message)),
      `expected the exhaustion notice, saw: ${notices.join(" | ")}`,
    );
  } finally {
    booted.cleanup();
  }
});

test("loop seam: a fresh prompt drops a stale revision turn", async () => {
  const booted = await bootLoop();
  try {
    await plannerWrotePlan(booted);
    const persistedRevision = () => {
      const entry = [...booted.pi.entries]
        .reverse()
        .find((item) => item.type === "workflow");
      return (entry?.data as
        | { planRevision?: { round?: number; pending?: boolean } }
        | undefined)?.planRevision;
    };
    assert.equal(persistedRevision()?.round, 1, "one revision turn recorded");
    // A genuine user prompt: the follow-up continuation is over.
    await booted.pi.emit(
      "before_agent_start",
      { type: "before_agent_start", messageType: "user", prompt: "new task" },
      booted.ctx,
    );
    assert.equal(persistedRevision()?.round, 0, "the loop state is dropped");
    assert.equal(
      persistedRevision()?.pending,
      false,
      "no stale pending revision",
    );
  } finally {
    booted.cleanup();
  }
});

test("loop e2e revert: Orchestrator rows ignore the appendix and the child kickoff", async () => {
  const { root, cwd, agentDir } = tmpProject();
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const planPath = path.join(cwd, "plan.md");
  fs.writeFileSync(
    planPath,
    [
      "# Plan: Revert",
      "",
      "## Steps",
      "",
      "1. First",
      "2. Second",
      "3. Third",
      "",
      "## Verification",
      "",
      "- Run the suite",
      "",
      "## Reviewer Revisions (round 1)",
      "",
      "### Required changes",
      "",
      "- **R1 · Step 1:** Bind this note to a row.",
    ].join("\n"),
    "utf8",
  );
  const pi = makeFakePi({ activeTools: ["read", "write", "edit", "bash"] });
  const kickoffs: string[] = [];
  const childOptions: FakeOrchestratorChildOptions = {
    holdPrompt: true,
    onPrompt: (text) => {
      kickoffs.push(text);
    },
  };
  const child = makeFakeOrchestratorChildFactory(childOptions);
  const { sdk } = fakeSdk({ pass1: submitThenFinish("# Plan: revert") });
  try {
    await workflowExtension(pi as never, {
      loadSdk: async () => sdk as never,
      createOrchestratorChild: child.factory as never,
      plannotatorRequestTimeoutMs: 20,
      plannotatorRecoveryTimeoutMs: 20,
      isTerminalHost: () => true,
    });
    const fake = makeFakeCtx({ cwd, hasUI: false, branch: [] });
    await pi.emit("session_start", { reason: "startup" }, fake.ctx);
    await (pi.commands.orchestrator.handler("", fake.ctx) as Promise<void>);

    const callTool = async (
      name: string,
      params: Record<string, unknown>,
    ): Promise<string> => {
      const tool = pi.tools[name];
      assert.ok(tool, `${name} is registered`);
      const result = (await tool.execute(
        `call-${name}`,
        params,
        undefined,
        undefined,
        fake.ctx,
      )) as { content: Array<{ text?: string }> };
      return result.content.map((block) => block.text ?? "").join("\n");
    };

    const started = await callTool("orchestrator_start", {
      planPath,
      steps: ["First", "Second", "Third"],
    });
    assert.match(started, /created with 3 row/);

    const workflowEntry = [...pi.entries]
      .reverse()
      .find((item) => item.type === "workflow");
    const run = (workflowEntry?.data as {
      orchestratorRun?: {
        rows: Array<Record<string, unknown>>;
        [key: string]: unknown;
      };
    })?.orchestratorRun;
    assert.ok(run, "the run is persisted");
    assert.equal(run!.rows.length, 3, "one row per plan step");
    const reviewKeys = [
      ...Object.keys(run!).filter((key) => /review/i.test(key)),
      ...run!.rows.flatMap((row) =>
        Object.keys(row).filter((key) => /review/i.test(key)),
      ),
    ];
    assert.deepEqual(reviewKeys, [], "the run binds no review notes");
    assert.deepEqual(
      fake.notifies.filter((note) => /numbered steps/i.test(note.message)),
      [],
      "no numbered-step warning",
    );

    const dispatched = await callTool("orchestrator_dispatch", {
      rowRef: "1",
      instructions: "Do row one.",
    });
    assert.match(dispatched, /Dispatched row 1\/3/);
    assert.equal(kickoffs.length, 1, "the child received one kickoff");
    // Build the removed names from fragments so this test's own source stays
    // clean for the dead-code grep below.
    const removedNoteNames = [
      ["bind", "Review", "Notes"].join(""),
      ["unbound", "Review", "Notes"].join(""),
    ];
    const advisoryHeading = ["## Review notes ", "(advisory)"].join("");
    assert.equal(
      kickoffs[0]!.includes(advisoryHeading),
      false,
      "the child kickoff carries no review-notes advisory block",
    );
    for (const name of removedNoteNames) {
      assert.equal(
        kickoffs[0]!.includes(name),
        false,
        `the child kickoff carries no ${name} field`,
      );
    }
    assert.deepEqual(
      fake.notifies.filter((note) => /numbered steps/i.test(note.message)),
      [],
      "dispatching emits no numbered-step warning either",
    );
  } finally {
    try {
      await pi.emit("session_shutdown", { reason: "quit" }, {} as never);
    } catch {
      /* shutdown is best-effort in the fake host */
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

test("loop e2e: a reload never auto-sends; /review is the resume path", async () => {
  const { root, cwd, agentDir } = tmpProject();
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
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
            maxRevisions: 3,
            timeoutMs: 10_000,
            providerRecovery: "off",
            fallbackOnError: "skip",
          },
        },
      },
      null,
      2,
    ),
  );
  const planPath = path.join(
    cwd,
    ".pi",
    "plans",
    `${getUtcDateTimePrefix()}-reload.md`,
  );
  fs.writeFileSync(planPath, LOOP_PLAN, "utf8");
  const pi = makeFakePi({ activeTools: ["read", "write", "edit", "bash"] });
  const { sdk, capture } = fakeSdk({
    pass1: async (child) => {
      await submitReviewRound(child, { verdict: "approve", findings: [] });
    },
  });
  try {
    await workflowExtension(pi as never, {
      loadSdk: async () => sdk as never,
      selfExtensionPath: "/fake/index.ts",
      plannotatorRequestTimeoutMs: 20,
      plannotatorRecoveryTimeoutMs: 20,
      isTerminalHost: () => true,
    });
    const fake = makeFakeCtx({
      cwd,
      hasUI: false,
      branch: [
        {
          type: "custom",
          customType: "workflow",
          data: {
            mode: "plan",
            planRevision: {
              round: 2,
              pending: true,
              settled: true,
              noteIds: ["R1"],
              responses: [],
            },
          },
        },
      ],
    });
    await pi.emit("session_start", { reason: "reload" }, fake.ctx);
    const notices = fake.notifies.map((n) => n.message);
    assert.ok(
      notices.some((message) =>
        message.includes(
          "Review negotiation stopped by reload — run /review to continue.",
        ),
      ),
      `expected the reload notice, saw: ${notices.join(" | ")}`,
    );
    assert.equal(pi.sent.length, 0, "a restore never auto-sends a Planner prompt");
    assert.deepEqual(fake.customs, [], "a restore never opens a modal");
    assert.equal(capture.prompts.length, 0, "no review round ran on restore");

    // `/review` is the documented resume path: an explicit command runs the
    // round (never an automatic continuation), and approve hands off.
    assert.ok(pi.commands.review, "/review is registered");
    await pi.commands.review.handler(
      `.pi/plans/${path.basename(planPath)}`,
      fake.ctx,
    );
    assert.equal(
      capture.prompts.length,
      1,
      `/review resumes the review (notices: ${fake.notifies
        .map((n) => n.message)
        .join(" | ")})`,
    );
    assert.deepEqual(
      pi.sent.filter(
        (entry) =>
          typeof entry.content === "string" &&
          entry.content.includes("# Planner revision"),
      ),
      [],
      "an approving resume needs no Planner prompt",
    );
    assert.equal(
      pi.sent.filter(
        (entry) =>
          (entry.content as { customType?: string } | null)?.customType ===
          "workflow-handoff-fallback",
      ).length,
      1,
      "/review hands the approved plan off",
    );
  } finally {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  }
});

// ── The reverted advisory binding is dead code ────────────────────────

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * The names the 2026-11-26 plan deleted. Built from fragments so this guard's
 * own source never satisfies the grep it runs.
 */
const REMOVED_BINDING_TOKENS = [
  ["bind", "Review", "Notes"].join(""),
  ["unbound", "Review", "Notes"].join(""),
  ["count", "Plan", "Steps"].join(""),
  ["step", "Count"].join(""),
  ["Review notes ", "(advisory)"].join(""),
];

/** Every `.ts`/`.json` file under the extension, `node_modules` excluded. */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(ts|json)$/.test(entry.name)) out.push(full);
  }
  return out;
}

test("dead-code: no source or test file still names the reverted advisory binding", () => {
  const matches: string[] = [];
  for (const file of sourceFiles(HERE)) {
    const text = fs.readFileSync(file, "utf8");
    for (const token of REMOVED_BINDING_TOKENS) {
      if (text.includes(token)) {
        matches.push(`${path.relative(HERE, file)}: ${token}`);
      }
    }
  }
  assert.deepEqual(matches, [], "the deleted symbols must not come back");

  // The plan's exact check, asserted instead of swallowed with `|| true`:
  // rg exits 0 when it finds a match and 1 when it finds nothing.
  const pattern = REMOVED_BINDING_TOKENS.join("|");
  const result = spawnSync(
    "rg",
    [
      "-n",
      pattern,
      "--glob",
      "!node_modules",
      "--glob",
      "*.ts",
      "--glob",
      "*.json",
      ".",
    ],
    { cwd: HERE, encoding: "utf8" },
  );
  assert.equal(
    result.error,
    undefined,
    `rg must be runnable: ${String(result.error)}`,
  );
  assert.equal(
    result.status,
    1,
    `rg must find no match (exit 1); stdout:\n${result.stdout}`,
  );
  assert.equal(result.stdout.trim(), "", "no match lines");
});

test("dead-code proof: parseReviewNotes reads all 13 notes of the reported plan", () => {
  // The old proof counted plan steps; with the counter gone the equivalent
  // evidence is that the real parser still recovers every note.
  const revertedPlan = [
    "# Plan: Reported",
    "",
    "## Steps",
    "",
    "1. Keep the body authoritative",
    "",
    "## Reviewer Revisions (round 1)",
    "",
    renderRequiredChanges(notes(13)),
    "",
  ].join("\n");
  const parsed = parseReviewNotes(revertedPlan);
  assert.equal(parsed.notes.length, 13, "all 13 notes survive the revert");
  assert.deepEqual(
    parsed.notes.map((note) => note.id),
    notes(13).map((note) => note.id),
  );
  assert.deepEqual(
    parsed.notes.map((note) => note.change),
    notes(13).map((note) => note.change),
  );
});
