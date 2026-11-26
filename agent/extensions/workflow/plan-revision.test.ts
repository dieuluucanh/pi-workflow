/**
 * Tests for the Planner's revision turn (Planner↔Reviewer loop, row 2).
 *
 * Two contracts are pinned here:
 *
 *   1. `buildPlanRevisionPrompt` — names the plan/round, states the ownership
 *      rules (body vs appendix, one response per note, a reason for every
 *      rejection), lists at most 12 notes and then `… and N more: <ids>` (an id
 *      is never dropped), clips the change text and stays inside the 12k bound.
 *   2. `plan_revision_done` — the validation order: pending, coverage
 *      (missing/extra/duplicate), status + reason, appendix untouched, and
 *      `applied` implies a body change. A refusal never settles.
 *
 * Pure node:test: no Pi runtime, no filesystem.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import {
  MAX_REVISION_PROMPT_CHANGE_CHARS,
  MAX_REVISION_PROMPT_CHARS,
  MAX_REVISION_PROMPT_NOTES,
  PLAN_REVISION_CORRECTIVE_PREAMBLE,
  PLAN_REVISION_TOOL_NAME,
  buildPlanRevisionPrompt,
  createPlanRevisionDoneTool,
  type PlanRevisionResponse,
  type PlanRevisionToolDeps,
} from "./plan-revision.ts";
import { getUtcDateTimePrefix, planHash, splitReviewerAppendix, type ReviewNote } from "./utils.ts";
import { decidePlanRevision } from "./review-negotiation.ts";
import workflowExtension from "./index.ts";
import {
  fakeSdk,
  makeFakeCtx,
  makeFakePi,
  submitThenFinish,
  tmpProject,
} from "./test-support.ts";

// ── Fixtures ─────────────────────────────────────────────────────────

const BODY = [
  "# Plan: Export",
  "",
  "## Steps",
  "",
  "1. Add the CSV writer",
  "2. Add the route",
  "",
].join("\n");

const APPENDIX = [
  "## Reviewer Revisions (round 1)",
  "_Review notes for the Planner. The plan body is authoritative once the Planner has revised it; unresolved notes are listed below._",
  "",
  "### Required changes",
  "",
  "- **R1 · Step 2:** Register the route.",
  "- **R2:** Add tests.",
  "",
].join("\n");

const PLAN = `${BODY}\n${APPENDIX}`;

const AMENDED_PLAN = PLAN.replace("2. Add the route", "2. Add the JSON route");

const NOTES: ReviewNote[] = [
  { id: "R1", step: "2", change: "Register the route." },
  { id: "R2", change: "Add tests." },
];

function notesOf(count: number, changeLen = 40): ReviewNote[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `R${i + 1}`,
    step: String((i % 9) + 1),
    change: `C${i + 1} ${"x".repeat(changeLen)}`,
  }));
}

const bodyHash = (text: string) => planHash(splitReviewerAppendix(text).body);

interface Harness {
  deps: PlanRevisionToolDeps;
  tool: ReturnType<typeof createPlanRevisionDoneTool>;
  settled: PlanRevisionResponse[][];
  state: { pending: boolean; plan: string | undefined; notes: ReviewNote[] };
}

function harness(patch: Partial<PlanRevisionToolDeps> = {}): Harness {
  const state = {
    pending: true,
    plan: PLAN as string | undefined,
    notes: NOTES,
  };
  const settled: PlanRevisionResponse[][] = [];
  const deps: PlanRevisionToolDeps = {
    pending: () => state.pending,
    notes: () => state.notes,
    readPlan: () => state.plan,
    expectedAppendix: () => splitReviewerAppendix(PLAN).appendix,
    bodyHashAtStart: () => bodyHash(PLAN),
    planHashBody: bodyHash,
    settle: (responses) => {
      settled.push(responses);
      state.pending = false;
    },
    ...patch,
  };
  return { deps, tool: createPlanRevisionDoneTool(deps), settled, state };
}

function resultText(result: { content: Array<{ text: string }> }): string {
  return result.content.map((part) => part.text).join("\n");
}

async function call(
  tool: ReturnType<typeof createPlanRevisionDoneTool>,
  responses: unknown,
  summary?: string,
) {
  return tool.execute("call-1", { responses, summary }, undefined, undefined, {});
}

// ── Prompt ───────────────────────────────────────────────────────────

test("prompt: names the plan, the round and the ownership rules", () => {
  const prompt = buildPlanRevisionPrompt({
    planPath: "C:/work/.pi/plans/2026-11-26-export.md",
    round: 2,
    maxRounds: 3,
    notes: NOTES,
  });

  assert.ok(prompt.includes("round 2 of 3"), prompt);
  assert.ok(prompt.includes("C:/work/.pi/plans/2026-11-26-export.md"), prompt);
  assert.ok(prompt.includes("plan BODY"), prompt);
  // The appendix belongs to the Reviewer — stated, and named exactly.
  assert.ok(prompt.includes("## Reviewer Revisions"), prompt);
  assert.ok(
    /do NOT edit[\s\S]*Reviewer's `## Reviewer Revisions` appendix/i.test(prompt),
    prompt,
  );
  // One response per note, `applied` means saved, reasons required.
  assert.ok(prompt.includes("Answer every note exactly once"), prompt);
  assert.ok(/`rejected` and `not_applicable` require a concrete reason/.test(prompt), prompt);
  assert.ok(prompt.includes(PLAN_REVISION_TOOL_NAME), prompt);
  // The TODO list reminder.
  assert.ok(prompt.includes("workflow_todo"), prompt);
  assert.ok(prompt.includes("do not call `review_submit`"), prompt);
});

test("prompt: lists the notes as `R<n> · Step <ref>: <change>`", () => {
  const prompt = buildPlanRevisionPrompt({
    planPath: "/p/plan.md",
    round: 1,
    maxRounds: 3,
    notes: NOTES,
  });

  assert.ok(prompt.includes("- R1 · Step 2: Register the route."), prompt);
  assert.ok(prompt.includes("- R2: Add tests."), prompt);
  assert.ok(prompt.includes("## Notes to answer (2)"), prompt);
});

test("prompt: caps at 12 notes and keeps every surplus id", () => {
  const prompt = buildPlanRevisionPrompt({
    planPath: "/p/plan.md",
    round: 1,
    maxRounds: 3,
    notes: notesOf(15),
  });

  for (let i = 1; i <= MAX_REVISION_PROMPT_NOTES; i += 1) {
    assert.ok(prompt.includes(`- R${i} · Step`), `R${i} must be listed`);
  }
  assert.ok(prompt.includes("… and 3 more: R13, R14, R15"), prompt);
  assert.ok(!prompt.includes("- R13 · Step"), "R13 is only in the tail");
  assert.ok(prompt.includes("## Notes to answer (15)"), prompt);
});

test("prompt: clips a long change and stays inside the 12k bound", () => {
  const long = buildPlanRevisionPrompt({
    planPath: "/p/plan.md",
    round: 1,
    maxRounds: 3,
    notes: [{ id: "R1", change: "y".repeat(900) }],
  });
  const line = long.split("\n").find((l) => l.startsWith("- R1:")) ?? "";
  assert.ok(
    line.length <= MAX_REVISION_PROMPT_CHANGE_CHARS + "- R1: ".length,
    `change not clipped: ${line.length}`,
  );
  assert.ok(line.endsWith("…"), line);

  const huge = buildPlanRevisionPrompt({
    planPath: "/p/plan.md",
    round: 1,
    maxRounds: 3,
    notes: notesOf(200, 900),
  });
  assert.ok(huge.length <= MAX_REVISION_PROMPT_CHARS, `${huge.length} chars`);
});

test("prompt: a blank round/maxRounds still renders a usable prompt", () => {
  const prompt = buildPlanRevisionPrompt({
    planPath: "",
    round: Number.NaN,
    maxRounds: 0,
    notes: [],
  });

  assert.ok(prompt.includes("round 1 of 1"), prompt);
  assert.ok(prompt.includes("the current plan file"), prompt);
  assert.ok(prompt.includes("(the Reviewer left no notes)"), prompt);
});

test("prompt: the corrective preamble is opt-in and never changes the normal format", () => {
  const notes: ReviewNote[] = [{ id: "R1", step: "2", change: "Register the route." }];
  const normal = buildPlanRevisionPrompt({
    planPath: "/p/plan.md",
    round: 2,
    maxRounds: 3,
    notes,
  });
  const corrective = buildPlanRevisionPrompt({
    planPath: "/p/plan.md",
    round: 2,
    maxRounds: 3,
    notes,
    preamble: PLAN_REVISION_CORRECTIVE_PREAMBLE,
  });

  assert.ok(
    !normal.includes(PLAN_REVISION_CORRECTIVE_PREAMBLE),
    "the normal prompt carries no corrective line",
  );
  assert.ok(
    corrective.includes(`> ${PLAN_REVISION_CORRECTIVE_PREAMBLE}`),
    corrective,
  );
  // The marker (the heading) must stay the first line: follow-up runs are
  // recognised by it, corrective or not.
  assert.equal(
    corrective.split("\n")[0],
    normal.split("\n")[0],
    "the heading is unchanged",
  );
  // The notes to answer are identical; only the preamble differs.
  assert.ok(corrective.includes("- R1 · Step 2: Register the route."));
  assert.ok(corrective.includes("## Notes to answer (1)"));
});

// ── Tool: validation matrix ──────────────────────────────────────────

test("tool: declares the loop tool name and schema", () => {
  const { tool } = harness();
  assert.equal(tool.name, PLAN_REVISION_TOOL_NAME);
  assert.equal(tool.name, "plan_revision_done");
  assert.ok(tool.description.includes("applied"));
  assert.equal(typeof tool.execute, "function");
  assert.ok(tool.parameters);
});

test("tool: refuses when no revision turn is pending", async () => {
  const { tool, settled } = harness({ pending: () => false });

  const result = await call(tool, [
    { id: "R1", status: "applied" },
    { id: "R2", status: "rejected", reason: "Already covered by step 3." },
  ]);

  assert.equal(result.isError, true);
  assert.ok(resultText(result).includes("no Planner revision is pending"));
  assert.equal(settled.length, 0);
});

test("tool: refuses a non-array or malformed responses payload", async () => {
  const a = harness();
  const notArray = await call(a.tool, { R1: "applied" });
  assert.equal(notArray.isError, true);
  assert.ok(resultText(notArray).includes("must be an array"));
  assert.equal(a.settled.length, 0);

  const b = harness();
  const malformed = await call(b.tool, ["R1"]);
  assert.equal(malformed.isError, true);
  assert.equal(b.settled.length, 0);
});

test("tool: refuses a missing note id", async () => {
  const { tool, settled } = harness();

  const result = await call(tool, [
    { id: "R1", status: "applied" },
  ]);

  assert.equal(result.isError, true);
  assert.ok(resultText(result).includes("missing responses for: R2"));
  assert.equal(settled.length, 0);
});

test("tool: refuses an unknown note id", async () => {
  const { tool, settled } = harness();

  const result = await call(tool, [
    { id: "R1", status: "applied" },
    { id: "R2", status: "applied" },
    { id: "R9", status: "applied" },
  ]);

  assert.equal(result.isError, true);
  assert.ok(resultText(result).includes("unknown note ids: R9"));
  assert.equal(settled.length, 0);
});

test("tool: refuses a duplicate note id", async () => {
  const { tool, settled } = harness();

  const result = await call(tool, [
    { id: "R1", status: "applied" },
    { id: "R1", status: "rejected", reason: "No." },
    { id: "R2", status: "applied" },
  ]);

  assert.equal(result.isError, true);
  assert.ok(resultText(result).includes("duplicate responses for: R1"));
  assert.equal(settled.length, 0);
});

test("tool: refuses an invalid status", async () => {
  const { tool, settled } = harness();

  const result = await call(tool, [
    { id: "R1", status: "done" },
    { id: "R2", status: "applied" },
  ]);

  assert.equal(result.isError, true);
  assert.ok(resultText(result).includes("invalid status for: R1 (done)"));
  assert.equal(settled.length, 0);
});

test("tool: refuses rejected / not_applicable without a reason", async () => {
  const rejected = harness();
  const a = await call(rejected.tool, [
    { id: "R1", status: "rejected" },
    { id: "R2", status: "applied" },
  ]);
  assert.equal(a.isError, true);
  assert.ok(resultText(a).includes("reason is required for: R1 (rejected)"));
  assert.equal(rejected.settled.length, 0);

  const notApplicable = harness();
  const b = await call(notApplicable.tool, [
    { id: "R1", status: "not_applicable", reason: "   " },
    { id: "R2", status: "applied" },
  ]);
  assert.equal(b.isError, true);
  assert.ok(resultText(b).includes("reason is required for: R1 (not_applicable)"));
  assert.equal(notApplicable.settled.length, 0);
});

test("tool: refuses an edited Reviewer appendix", async () => {
  const { tool, settled } = harness({
    readPlan: () =>
      PLAN.replace("- **R1 · Step 2:** Register the route.", "- **R1:** Reworded by the Planner."),
  });

  const result = await call(tool, [
    { id: "R1", status: "not_applicable", reason: "The route is registered elsewhere." },
    { id: "R2", status: "not_applicable", reason: "Tests already exist." },
  ]);

  assert.equal(result.isError, true);
  assert.ok(
    resultText(result).includes(
      "Do not edit the Reviewer's appendix; restore it and retry.",
    ),
    resultText(result),
  );
  assert.equal(settled.length, 0);
});

test("tool: a deleted appendix is an appendix edit", async () => {
  const { tool, settled } = harness({ readPlan: () => BODY });

  const result = await call(tool, [
    { id: "R1", status: "applied" },
    { id: "R2", status: "applied" },
  ]);

  assert.equal(result.isError, true);
  assert.ok(resultText(result).includes("Do not edit the Reviewer's appendix"));
  assert.equal(settled.length, 0);
});

test("tool: a CRLF save of the same plan is not an appendix edit", async () => {
  const crlf = AMENDED_PLAN.replace(/\n/g, "\r\n");
  const { tool, settled } = harness({ readPlan: () => crlf });

  const result = await call(tool, [
    { id: "R1", status: "applied" },
    { id: "R2", status: "rejected", reason: "Tests are step 4's job." },
  ]);

  assert.equal(result.isError, undefined, resultText(result));
  assert.equal(settled.length, 1);
});

test("tool: refuses `applied` when the body did not change", async () => {
  const { tool, settled } = harness();

  const result = await call(tool, [
    { id: "R1", status: "applied" },
    { id: "R2", status: "rejected", reason: "Tests are step 4's job." },
  ]);

  assert.equal(result.isError, true);
  assert.ok(
    resultText(result).includes(
      "The plan body did not change; apply the notes or mark them rejected/not applicable with a reason.",
    ),
    resultText(result),
  );
  assert.equal(settled.length, 0);
});

test("tool: refuses when the plan file cannot be read", async () => {
  const { tool, settled } = harness({ readPlan: () => undefined });

  const result = await call(tool, [
    { id: "R1", status: "applied" },
    { id: "R2", status: "applied" },
  ]);

  assert.equal(result.isError, true);
  assert.ok(resultText(result).includes("plan file could not be read"));
  assert.equal(settled.length, 0);
});

// ── Tool: accepted settlements ───────────────────────────────────────

test("tool: all-rejected with an unchanged body is accepted", async () => {
  const { tool, settled } = harness();

  const result = await call(
    tool,
    [
      { id: "R1", status: "rejected", reason: "The route is registered in step 5." },
      { id: "R2", status: "not_applicable", reason: "Step 4 already adds the tests." },
    ],
    "Rejected both notes with evidence.",
  );

  assert.equal(result.isError, undefined, resultText(result));
  assert.equal(settled.length, 1);
  assert.deepEqual(settled[0], [
    { id: "R1", status: "rejected", reason: "The route is registered in step 5." },
    { id: "R2", status: "not_applicable", reason: "Step 4 already adds the tests." },
  ]);
  const text = resultText(result);
  assert.ok(text.includes("0 applied, 1 rejected, 1 not applicable"), text);
  assert.ok(text.includes("Rejected both notes with evidence."), text);
});

test("tool: an applied note with a real body edit settles the turn", async () => {
  const { tool, settled, state } = harness({ readPlan: () => AMENDED_PLAN });

  const result = await call(tool, [
    { id: "R1", status: "applied" },
    { id: "R2", status: "rejected", reason: "Tests are step 4's job." },
  ]);

  assert.equal(result.isError, undefined, resultText(result));
  assert.equal(settled.length, 1);
  assert.deepEqual(settled[0], [
    { id: "R1", status: "applied" },
    { id: "R2", status: "rejected", reason: "Tests are step 4's job." },
  ]);
  assert.ok(resultText(result).includes("1 applied, 1 rejected, 0 not applicable"));
  assert.equal(state.pending, false, "settling closes the turn");
});

test("tool: ids are matched case-insensitively and reasons are normalized", async () => {
  const { tool, settled, state } = harness({ readPlan: () => AMENDED_PLAN });
  state.notes = [{ id: "R7", step: "3", change: "Fix it." }];

  const result = await call(tool, [
    { id: " r7 ", status: "applied", reason: "  fixed   the   step  " },
  ]);

  assert.equal(result.isError, undefined, resultText(result));
  assert.deepEqual(settled[0], [
    { id: "R7", status: "applied", reason: "fixed the step" },
  ]);
});

test("tool: a refusal keeps the turn pending for a retry", async () => {
  const { tool, state, settled } = harness();

  const first = await call(tool, [{ id: "R1", status: "applied" }]);
  assert.equal(first.isError, true);
  assert.equal(state.pending, true);
  assert.equal(settled.length, 0);

  state.plan = AMENDED_PLAN;
  const retry = await call(tool, [
    { id: "R1", status: "applied" },
    { id: "R2", status: "rejected", reason: "Tests are step 4's job." },
  ]);
  assert.equal(retry.isError, undefined, resultText(retry));
  assert.equal(settled.length, 1);
  assert.equal(state.pending, false);
});

// ── Live lifecycle seam and attempt guard (loop fix, step 1d/1e/1h) ──
//
// These drive the REAL extension through the fake Pi host. The loop state
// lives in `index.ts`, so the faithful test is a booted extension: the
// follow-up run boundary (`before_agent_start` carrying the revision prompt),
// the retry after an errored attempt, and a non-final `agent_end`. The reported
// session lost the revision turn exactly at that boundary and then reviewed a
// stale snapshot on an errored attempt.

const SEAM_PLAN = [
  "# Plan: Seam",
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

interface SeamBoot {
  pi: ReturnType<typeof makeFakePi>;
  ctx: any;
  fake: ReturnType<typeof makeFakeCtx>;
  capture: { prompts: string[] };
  cwd: string;
  planPath: string;
  planText: string;
  cleanup(): void;
}

/**
 * Boot the real extension on a temp project in Plan mode with Review Mode on
 * and a fake reviewer that submits one revise note (R1) per round.
 */
async function bootSeam(
  over: { maxRevisions?: number } = {},
): Promise<SeamBoot> {
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
  const planPath = path.join(
    cwd,
    ".pi",
    "plans",
    `${getUtcDateTimePrefix()}-seam.md`,
  );
  fs.writeFileSync(planPath, SEAM_PLAN, "utf8");
  const pi = makeFakePi({ activeTools: ["read", "write", "edit", "bash"] });
  const { sdk, capture } = fakeSdk({
    pass1: submitThenFinish("# Plan: seam"),
  });
  await workflowExtension(pi as never, {
    loadSdk: async () => sdk as never,
    selfExtensionPath: "/fake/index.ts",
    plannotatorRequestTimeoutMs: 20,
    plannotatorRecoveryTimeoutMs: 20,
    isTerminalHost: () => true,
  });
  const fake = makeFakeCtx({ cwd, hasUI: false, idle: false });
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
    planText: SEAM_PLAN,
    cleanup,
  };
}

/** The Planner wrote the plan in Plan mode, then the run ended cleanly. */
async function plannerWroteSeamPlan(booted: SeamBoot): Promise<void> {
  await booted.pi.emit(
    "tool_result",
    { toolName: "write", isError: false, input: { path: booted.planPath } },
    booted.ctx,
  );
  await endSeamRun(booted);
}

/** A clean, errored or empty-ended run. */
async function endSeamRun(
  booted: SeamBoot,
  over: {
    stopReason?: "error" | "aborted";
    content?: Array<{ type: "text"; text: string }>;
  } = {},
): Promise<void> {
  const message = over.stopReason
    ? { role: "assistant", stopReason: over.stopReason, content: [] }
    : {
        role: "assistant",
        content: over.content ?? [{ type: "text", text: booted.planText }],
      };
  await booted.pi.emit(
    "agent_end",
    { type: "agent_end", willRetry: false, messages: [message] },
    booted.ctx,
  );
}

/** Planner revision follow-ups sent to the plan agent (`sendUserMessage`). */
function seamRevisionFollowUps(
  booted: SeamBoot,
): Array<{ content: unknown; options?: unknown }> {
  return booted.pi.sent.filter(
    (entry) =>
      typeof entry.content === "string" &&
      entry.content.includes("# Planner revision"),
  );
}

/** Emulate the run that answers the last revision follow-up. */
async function startSeamRevisionRun(booted: SeamBoot): Promise<void> {
  const followUps = seamRevisionFollowUps(booted);
  assert.ok(followUps.length > 0, "a Planner revision follow-up was sent");
  const prompt = String(followUps[followUps.length - 1]!.content);
  await booted.pi.emit(
    "before_agent_start",
    { type: "before_agent_start", messageType: "user", prompt },
    booted.ctx,
  );
}

/** The persisted `planRevision` block. */
function seamRevisionState(booted: SeamBoot):
  | {
      round?: number;
      pending?: boolean;
      settled?: boolean;
      noteIds?: string[];
      responses?: unknown[];
    }
  | undefined {
  const entry = [...booted.pi.entries]
    .reverse()
    .find((item) => item.type === "workflow");
  return (entry?.data as { planRevision?: Record<string, unknown> } | undefined)
    ?.planRevision as
    | {
        round?: number;
        pending?: boolean;
        settled?: boolean;
        noteIds?: string[];
        responses?: unknown[];
      }
    | undefined;
}

/** Handoff presentations (headless fallback message). */
function seamHandoffs(booted: SeamBoot): unknown[] {
  return booted.pi.sent.filter(
    (entry) =>
      (entry.content as { customType?: string } | null)?.customType ===
      "workflow-handoff-fallback",
  );
}

/** Entries of one extension type, in order. */
function seamEntries(
  booted: SeamBoot,
  type: string,
): Array<Record<string, unknown>> {
  return booted.pi.entries
    .filter((entry) => entry.type === type)
    .map((entry) => (entry.data ?? {}) as Record<string, unknown>);
}

/** Run the Planner's `plan_revision_done` report through the real tool. */
async function seamRevisionReport(
  booted: SeamBoot,
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

/** Change the plan BODY, keeping the Reviewer's appendix byte-identical. */
function reviseSeamBody(
  booted: SeamBoot,
  addition = "3. Add the exporter",
): void {
  const live = fs.readFileSync(booted.planPath, "utf8");
  const split = splitReviewerAppendix(live);
  fs.writeFileSync(
    booted.planPath,
    `${split.body
      .replace("2. Add the route", `2. Add the route\n${addition}`)
      .trimEnd()}\n\n${split.appendix}`,
    "utf8",
  );
}

// ── (d) The lifecycle seam ───────────────────────────────────────────

test("lifecycle seam: the revision prompt's run keeps round/pending and settles", async () => {
  const booted = await bootSeam();
  try {
    await plannerWroteSeamPlan(booted);
    assert.equal(seamRevisionFollowUps(booted).length, 1);
    const opened = seamRevisionState(booted)!;
    assert.equal(opened.round, 1, "revision 1 opened");
    assert.equal(opened.pending, true);
    assert.deepEqual(opened.noteIds, ["R1"]);

    // The host starts the follow-up's run with the exact revision prompt. That
    // is a continuation, not a new task: the turn must survive it.
    await startSeamRevisionRun(booted);
    const running = seamRevisionState(booted)!;
    assert.equal(running.round, 1, "the budget survives the follow-up run");
    assert.equal(running.pending, true, "the turn is still open");
    assert.deepEqual(running.noteIds, ["R1"]);

    // `plan_revision_done` works on every round: an all-rejected answer settles
    // the turn (no body edit needed).
    const settled = await seamRevisionReport(booted, [
      {
        id: "R1",
        status: "rejected",
        reason: "The route is registered in step 2.",
      },
    ]);
    assert.equal(settled.isError, undefined, settled.content[0]?.text);
    const after = seamRevisionState(booted)!;
    assert.equal(after.round, 1);
    assert.equal(after.pending, false, "the settle closed the turn");
    assert.equal(after.settled, true);
  } finally {
    booted.cleanup();
  }
});

test("lifecycle seam: a custom run does not reset the revision turn", async () => {
  const booted = await bootSeam();
  try {
    await plannerWroteSeamPlan(booted);
    assert.equal(seamRevisionState(booted)?.pending, true);

    await booted.pi.emit(
      "before_agent_start",
      {
        type: "before_agent_start",
        messageType: "custom",
        prompt: "**Plan Steps (2):**\n\n1. Add the route",
      },
      booted.ctx,
    );

    const after = seamRevisionState(booted)!;
    assert.equal(after.round, 1, "a custom run is not a new task");
    assert.equal(after.pending, true);
    assert.deepEqual(after.noteIds, ["R1"]);
  } finally {
    booted.cleanup();
  }
});

test("lifecycle seam: a genuine new task prompt resets the revision turn", async () => {
  const booted = await bootSeam();
  try {
    await plannerWroteSeamPlan(booted);
    assert.equal(seamRevisionState(booted)?.pending, true);

    await booted.pi.emit(
      "before_agent_start",
      { type: "before_agent_start", messageType: "user", prompt: "new task" },
      booted.ctx,
    );

    const after = seamRevisionState(booted)!;
    assert.equal(after.round, 0, "a new task drops the spent round");
    assert.equal(after.pending, false, "no stale pending revision");
  } finally {
    booted.cleanup();
  }
});

test("lifecycle seam: an errored attempt + the same prompt again still settles", async () => {
  const booted = await bootSeam();
  try {
    await plannerWroteSeamPlan(booted);
    assert.equal(seamRevisionState(booted)?.round, 1);

    // The provider errored mid-turn: the host retries the SAME follow-up.
    await startSeamRevisionRun(booted);
    await endSeamRun(booted, { stopReason: "error" });
    const errored = seamRevisionState(booted)!;
    assert.equal(errored.round, 1, "the retry keeps the budget");
    assert.equal(errored.pending, true, "the turn is still open for the retry");

    await startSeamRevisionRun(booted);
    const retried = seamRevisionState(booted)!;
    assert.equal(retried.round, 1);
    assert.equal(retried.pending, true);

    // The retried run applies the note (a body edit is required for
    // `applied`) and settles the turn through the real tool.
    reviseSeamBody(booted);
    await booted.pi.emit(
      "tool_result",
      { toolName: "write", isError: false, input: { path: booted.planPath } },
      booted.ctx,
    );
    const settled = await seamRevisionReport(booted, [
      { id: "R1", status: "applied" },
    ]);
    assert.equal(settled.isError, undefined, settled.content[0]?.text);
    const after = seamRevisionState(booted)!;
    assert.equal(after.pending, false, "the retried turn settled");
    assert.equal(after.settled, true);
  } finally {
    booted.cleanup();
  }
});

// ── (e) The attempt guard ────────────────────────────────────────────

test("attempt guard: an errored attempt runs no review, resolves no turn and hands off nothing", async () => {
  const booted = await bootSeam();
  try {
    await plannerWroteSeamPlan(booted);
    const promptsBefore = booted.capture.prompts.length;
    const followUpsBefore = seamRevisionFollowUps(booted).length;

    await startSeamRevisionRun(booted);
    await endSeamRun(booted, { stopReason: "error" });

    assert.equal(
      booted.capture.prompts.length,
      promptsBefore,
      "no review on a non-final attempt",
    );
    assert.equal(
      seamRevisionFollowUps(booted).length,
      followUpsBefore,
      "no revision resolution on a non-final attempt",
    );
    assert.deepEqual(
      seamHandoffs(booted),
      [],
      "no handoff on a non-final attempt",
    );
    assert.deepEqual(booted.fake.customs, [], "no native modal either");
    const state = seamRevisionState(booted)!;
    assert.equal(state.pending, true, "the turn survives its errored attempt");
    assert.equal(state.round, 1);

    const skips = seamEntries(booted, "workflow-handoff-skip");
    assert.equal(skips.length, 1, "the skipped attempt is audited");
    // The entry records the stop reason (the field name is the producer's).
    assert.match(JSON.stringify(skips[0]), /error/);
    assert.ok(
      booted.fake.notifies.some((notice) => /skip/i.test(notice.message)),
      `expected a skip notice, saw: ${booted.fake.notifies
        .map((notice) => notice.message)
        .join(" | ")}`,
    );
  } finally {
    booted.cleanup();
  }
});

test("attempt guard: an aborted attempt is skipped the same way", async () => {
  const booted = await bootSeam();
  try {
    await plannerWroteSeamPlan(booted);
    const promptsBefore = booted.capture.prompts.length;

    await startSeamRevisionRun(booted);
    await endSeamRun(booted, { stopReason: "aborted" });

    assert.equal(booted.capture.prompts.length, promptsBefore);
    assert.deepEqual(seamHandoffs(booted), []);
    assert.equal(seamRevisionState(booted)?.pending, true);
    const skips = seamEntries(booted, "workflow-handoff-skip");
    assert.equal(skips.length, 1);
    assert.match(JSON.stringify(skips[0]), /aborted/);
  } finally {
    booted.cleanup();
  }
});

test("attempt guard: an empty attempt that wrote no plan is skipped, then one clean run reviews", async () => {
  const booted = await bootSeam();
  try {
    await plannerWroteSeamPlan(booted);
    const promptsBefore = booted.capture.prompts.length;

    await startSeamRevisionRun(booted);
    await endSeamRun(booted, { content: [] });

    assert.equal(
      booted.capture.prompts.length,
      promptsBefore,
      "an empty attempt is skipped",
    );
    assert.deepEqual(seamHandoffs(booted), []);
    assert.equal(seamEntries(booted, "workflow-handoff-skip").length, 1);
    assert.equal(seamRevisionState(booted)?.pending, true);

    // The retried attempt does the revision and ends clean: exactly one review.
    await startSeamRevisionRun(booted);
    reviseSeamBody(booted);
    await booted.pi.emit(
      "tool_result",
      { toolName: "write", isError: false, input: { path: booted.planPath } },
      booted.ctx,
    );
    const settled = await seamRevisionReport(booted, [
      { id: "R1", status: "applied" },
    ]);
    assert.equal(settled.isError, undefined, settled.content[0]?.text);
    await endSeamRun(booted);

    assert.equal(
      booted.capture.prompts.length,
      promptsBefore + 1,
      "the clean attempt reviewed exactly once",
    );
    assert.equal(
      seamEntries(booted, "workflow-handoff-skip").length,
      1,
      "no new skip",
    );
  } finally {
    booted.cleanup();
  }
});

test("attempt guard: an empty attempt that DID write the plan is not dropped", async () => {
  const booted = await bootSeam();
  try {
    await plannerWroteSeamPlan(booted);
    const promptsBefore = booted.capture.prompts.length;

    // The Planner wrote the revised body but produced no assistant text.
    await startSeamRevisionRun(booted);
    reviseSeamBody(booted);
    await booted.pi.emit(
      "tool_result",
      { toolName: "write", isError: false, input: { path: booted.planPath } },
      booted.ctx,
    );
    await endSeamRun(booted, { content: [] });

    assert.equal(
      booted.capture.prompts.length,
      promptsBefore + 1,
      "a run that wrote the plan is still reviewed",
    );
    assert.equal(
      seamEntries(booted, "workflow-handoff-skip").length,
      0,
      "no skip notice for a productive run",
    );
  } finally {
    booted.cleanup();
  }
});

// ── (h2) The pending-turn guard ──────────────────────────────────────

test("pending-turn guard: an agent_end before the revision run neither reviews nor hands off", async () => {
  const booted = await bootSeam();
  try {
    await plannerWroteSeamPlan(booted);
    const promptsBefore = booted.capture.prompts.length;
    const followUpsBefore = seamRevisionFollowUps(booted).length;
    assert.equal(seamRevisionState(booted)?.pending, true);
    // Do NOT start the follow-up run: this `agent_end` is the leftover boundary
    // of the run that sent the revision prompt.
    await endSeamRun(booted);

    assert.equal(
      booted.capture.prompts.length,
      promptsBefore,
      "no review while the revision follow-up has not started",
    );
    assert.equal(
      seamRevisionFollowUps(booted).length,
      followUpsBefore,
      "no revision resolution",
    );
    assert.deepEqual(
      seamHandoffs(booted),
      [],
      "no handoff while a turn is pending",
    );
    assert.equal(
      seamRevisionState(booted)?.pending,
      true,
      "the pending turn is left intact for its own run",
    );
  } finally {
    booted.cleanup();
  }
});

// ── (g) A requested revision is never silently downgraded ─────────────
//
// `beginPlannerRevision`'s mode/turn guards cannot be staged from the public
// harness (the negotiation block only runs in Plan mode and ends the review
// turn immediately before the call), so the contract the guard protects is
// pinned where it is decidable: for every budget, a revise round with open
// notes either opens one more revision or ends in the exhaustion handoff. It
// never becomes a silent handoff.

test("negotiation: open notes always spend a revision or exhaust, never a silent handoff", () => {
  for (let maxRevisions = 1; maxRevisions <= 5; maxRevisions += 1) {
    for (
      let revisionsUsed = 0;
      revisionsUsed <= maxRevisions;
      revisionsUsed += 1
    ) {
      const decision = decidePlanRevision({
        reviewOutcome: "rewritten",
        verdict: "revise",
        notes: NOTES,
        revisionsUsed,
        maxRevisions,
      }) as unknown as {
        request: boolean;
        outcome: string;
        handoff?: boolean;
      };
      const label = `${revisionsUsed}/${maxRevisions}`;
      if (revisionsUsed < maxRevisions) {
        assert.equal(decision.request, true, label);
        assert.equal(decision.handoff, false, label);
      } else {
        assert.equal(decision.request, false, label);
        assert.equal(decision.outcome, "exhausted", label);
        assert.equal(decision.handoff, true, label);
      }
    }
  }
});
