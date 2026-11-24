import { test } from "node:test";
import assert from "node:assert/strict";

import { createReviewSubmitTool } from "./review-tools.ts";

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
