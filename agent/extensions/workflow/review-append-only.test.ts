import { test } from "node:test";
import assert from "node:assert/strict";

import { createReviewSubmitTool, type ReviewSubmitPayload } from "./review-tools.ts";

const ADVISORY_LINE =
  "_Review notes for the Planner. The plan body is authoritative once the Planner has revised it; unresolved notes are listed below._";

const ORIGINAL_PLAN = [
  "# Plan: Export",
  "",
  "## Steps",
  "",
  "1. Add the CSV writer",
  "2. Add the route",
  "",
].join("\n");

const HIGH_FINDING = {
  id: "F1",
  severity: 8,
  confidence: 90,
  category: "correctness",
  summary: "The route is missing",
  rationale: "A plan step without a route cannot ship.",
  disposition: "accepted" as const,
};

test("review_submit appends Reviewer Revisions and never replaces the body", async () => {
  const writes: Array<Record<string, unknown>> = [];
  const tool = createReviewSubmitTool({
    planPath: () => ".pi/plans/x.md",
    originalPlan: () => ORIGINAL_PLAN,
    modelLabel: () => "reviewer/model",
    round: () => 2,
    submit: async (payload) => {
      writes.push(payload as unknown as Record<string, unknown>);
      return { ok: true, path: ".pi/plans/x.md" };
    },
    log: () => {},
  });

  const result = await tool.execute(
    "id",
    {
      findings: [HIGH_FINDING],
      verdict: "revise",
      summary: "Tighten the route step.",
      revisions: [{ step: "2", change: "Register the route in the app." }],
    },
    undefined,
    undefined,
    {},
  );

  assert.equal(result.isError, undefined);
  assert.equal(writes.length, 1);
  const payload = writes[0] as {
    planBody: string;
    planText: string;
    changelog: string;
  };
  assert.equal(payload.planBody, ORIGINAL_PLAN);
  assert.ok(payload.planText.startsWith(ORIGINAL_PLAN.trimEnd()));
  assert.ok(payload.changelog.includes("## Reviewer Revisions (round 2)"));
  assert.ok(payload.changelog.includes(ADVISORY_LINE));
  // The retired wording never comes back: nothing still says "approved plan
  // body is authoritative" now that the Planner's revision wins instead.
  assert.ok(!payload.changelog.includes("approved plan body is authoritative"));
  assert.ok(
    payload.changelog.includes("- **R1 · Step 2:** Register the route in the app."),
  );
  assert.ok(result.content[0].text.includes("review_pass_done"));
});

test("two review_submit calls in one round leave exactly one Reviewer Revisions section", async () => {
  // Models the LIVE plan file: pass 2 resubmits after pass 1 already wrote its
  // revisions section, so `originalPlan()` returns the pass-1 text on the
  // second call. A fake that always returned the pristine body would hide the
  // stacked-section bug this test exists to catch.
  let livePlan = ORIGINAL_PLAN;
  const writes: ReviewSubmitPayload[] = [];
  const tool = createReviewSubmitTool({
    planPath: () => ".pi/plans/x.md",
    originalPlan: () => livePlan,
    modelLabel: () => "reviewer/model",
    round: () => 1,
    submit: async (payload) => {
      writes.push(payload);
      livePlan = payload.planText;
      return { ok: true, path: ".pi/plans/x.md" };
    },
    log: () => {},
  });

  const params = {
    findings: [HIGH_FINDING],
    verdict: "revise" as const,
    summary: "Tighten the route step.",
    revisions: [{ step: "2", change: "Register the route in the app." }],
  };

  const first = await tool.execute("id-1", params, undefined, undefined, {});
  const second = await tool.execute("id-2", params, undefined, undefined, {});

  assert.equal(first.isError, undefined);
  assert.equal(second.isError, undefined);
  assert.equal(writes.length, 2);

  const pass2 = writes[1] as ReviewSubmitPayload;
  // The second payload is composed from the author's body, not the pass-1 file.
  // (`stripReviewerRevisions` trims the base, so compare against trimEnd.)
  assert.equal(pass2.planBody, ORIGINAL_PLAN.trimEnd());
  assert.ok(!pass2.planBody.includes("## Reviewer Revisions"));

  // Exactly one section heading survives, and pass 1's finding is still there.
  const headings = pass2.planText.match(/^## Reviewer Revisions \(round 1\)$/gm);
  assert.equal(headings?.length, 1, `expected one heading, got:\n${pass2.planText}`);
  assert.ok(pass2.planText.includes("The route is missing"));
  assert.ok(
    !pass2.planText.includes("No findings — the plan was submitted unchanged."),
  );
});

test("review_submit has no replacement-body parameter", () => {
  const tool = createReviewSubmitTool({
    planPath: () => ".pi/plans/x.md",
    originalPlan: () => ORIGINAL_PLAN,
    modelLabel: () => "reviewer/model",
    submit: async () => ({ ok: true }),
    log: () => {},
  });
  const schema = tool.parameters as { properties?: Record<string, unknown> };
  assert.equal(schema.properties?.planMarkdown, undefined);
});

// ── Convergence at review_submit (row 5) ─────────────────────────────
//
// `approve` is the reviewer's "nothing left to change" signal, so it cannot
// carry required changes: the call is refused before the plan is written and
// before the submit callback runs. The inferred-convergence sentence is what
// tells the host that a notes-free revise/block round has nothing to work on.

function makeTool(submit: (payload: ReviewSubmitPayload) => Promise<unknown>) {
  return createReviewSubmitTool({
    planPath: () => ".pi/plans/x.md",
    originalPlan: () => ORIGINAL_PLAN,
    modelLabel: () => "reviewer/model",
    round: () => 1,
    submit: async (payload) => {
      await submit(payload);
      return { ok: true, path: ".pi/plans/x.md" };
    },
    log: () => {},
  });
}

test("approve with a required change is refused and writes nothing", async () => {
  const writes: ReviewSubmitPayload[] = [];
  const tool = makeTool(async (payload) => {
    writes.push(payload);
  });

  const result = await tool.execute(
    "id",
    {
      findings: [HIGH_FINDING],
      verdict: "approve",
      summary: "Looks good — one small fix.",
      revisions: [{ step: "2", change: "Register the route in the app." }],
    },
    undefined,
    undefined,
    {},
  );

  assert.equal(result.isError, true);
  assert.match(
    result.content[0].text,
    /verdict approve cannot carry required changes; use revise or drop the revisions\./,
  );
  assert.equal(writes.length, 0, "no plan write on a refused submission");
  assert.equal(result.details, undefined, "refusal leaves no state behind");
});

test("approve with no required changes is accepted", async () => {
  const writes: ReviewSubmitPayload[] = [];
  const tool = makeTool(async (payload) => {
    writes.push(payload);
  });

  const result = await tool.execute(
    "id",
    { findings: [], verdict: "approve", summary: "Plan is sound." },
    undefined,
    undefined,
    {},
  );

  assert.equal(result.isError, undefined);
  assert.equal(writes.length, 1);
  assert.equal(writes[0]!.verdict, "approve");
  assert.ok(!result.content[0].text.includes("nothing to revise"));
  assert.ok(result.content[0].text.includes("Now call review_pass_done"));
});

for (const verdict of ["revise", "block"] as const) {
  test(`${verdict} with no required changes is accepted and reports convergence`, async () => {
    const writes: ReviewSubmitPayload[] = [];
    const tool = makeTool(async (payload) => {
      writes.push(payload);
    });

    const result = await tool.execute(
      "id",
      {
        findings: [HIGH_FINDING],
        verdict,
        summary: "Nothing the Planner can act on.",
      },
      undefined,
      undefined,
      {},
    );

    assert.equal(result.isError, undefined);
    assert.equal(writes.length, 1);
    assert.equal(writes[0]!.verdict, verdict);
    assert.ok(
      result.content[0].text.includes(
        "No required changes — the Planner has nothing to revise; the host treats this round as converged.",
      ),
      result.content[0].text,
    );
    // The normal appended-summary line survives the extra sentence.
    assert.ok(
      result.content[0].text.includes("appended Reviewer Revisions (round 1)"),
      result.content[0].text,
    );
    assert.ok(result.content[0].text.includes("- revisions: 0"));
  });
}
