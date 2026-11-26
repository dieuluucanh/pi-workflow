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

import {
  MAX_REVISION_PROMPT_CHANGE_CHARS,
  MAX_REVISION_PROMPT_CHARS,
  MAX_REVISION_PROMPT_NOTES,
  PLAN_REVISION_TOOL_NAME,
  buildPlanRevisionPrompt,
  createPlanRevisionDoneTool,
  type PlanRevisionResponse,
  type PlanRevisionToolDeps,
} from "./plan-revision.ts";
import { planHash, splitReviewerAppendix, type ReviewNote } from "./utils.ts";

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
