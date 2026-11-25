import { test } from "node:test";
import assert from "node:assert/strict";

import { createReviewSubmitTool, type ReviewSubmitPayload } from "./review-tools.ts";

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
  assert.ok(payload.changelog.includes("Register the route in the app."));
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
