/**
 * Plan lint, preview and pre-approval gating tests.
 *
 * These pin the contract that makes a bad plan fail *before* `run.created`:
 *   - a commands-only plan compiles, has gates and freezes with no extra prompt;
 *   - a prose-only / diagnostic-only plan compiles but requires an explicit
 *     acknowledgement before freeze;
 *   - an ambiguous plan does not compile, prints a line-numbered error and can
 *     never be frozen;
 *   - a reviewer rewrite that introduces an ambiguous check (or removes every
 *     gate) is rejected before it replaces the plan;
 *   - the preview shows exactly the commands, workspaces and timeouts.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import {
  assessPlanGates,
  formatPlanLintReport,
  formatPlanPreview,
  lintPlan,
  planFreezeGate,
  reviewPlanSubmissionProblems,
} from "./plan-lint.ts";
import type { FrozenWorkspace } from "./orchestrator-workspace-set.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, "fixtures", "plan-compiler");

function fixture(name: string): string {
  return fs.readFileSync(path.join(FIXTURES, name), "utf8");
}

const WORKSPACE: FrozenWorkspace = {
  id: "W",
  key: "plain:C:/work",
  root: "C:/work",
  kind: "plain",
  displayPath: "C:/work",
  primary: true,
};

const FENCED = fixture("fenced-commands.md");

test("lintPlan: commands-only plan has gates and needs no acknowledgement", () => {
  const result = lintPlan(FENCED, { path: "fenced-commands.md" });
  assert.equal(result.ok, true);
  assert.equal(result.assessment.rows, 2);
  assert.equal(result.assessment.gate, 3, "fenced lines + whole-bullet span");
  assert.equal(result.assessment.needsAcknowledgement, false);
  assert.equal(planFreezeGate(result).ok, true);
});

test("lintPlan: prose-only Verification compiles with zero gates and needs acknowledgement", () => {
  const plan = [
    "# Plan: Prose only",
    "",
    "## Plan Steps",
    "",
    "1. Do the thing",
    "",
    "## Verification",
    "",
    "- Run the tests by hand",
  ].join("\n");
  const result = lintPlan(plan);
  assert.equal(result.ok, true, "prose-only verification is documentation");
  assert.equal(result.assessment.gate, 0);
  assert.equal(result.assessment.needsAcknowledgement, true);
  assert.match(result.assessment.acknowledgementReason ?? "", /no final gate/);

  const refused = planFreezeGate(result);
  assert.equal(refused.ok, false);
  assert.equal(refused.needsAcknowledgement, true);
  assert.match(refused.error ?? "", /acknowledge/i);

  const acknowledged = planFreezeGate(result, { acknowledged: true });
  assert.equal(acknowledged.ok, true);
});

test("lintPlan: diagnostic-only final gate still needs acknowledgement", () => {
  const plan = [
    "# Plan: Diagnostics only",
    "",
    "## Plan Steps",
    "",
    "1. Do the thing",
    "",
    "## Verification",
    "",
    "```checks",
    "checks:",
    "  - id: docs",
    "    command: pnpm check:docs",
    "    kind: diagnostic",
    "```",
  ].join("\n");
  const result = lintPlan(plan);
  assert.equal(result.ok, true);
  assert.equal(result.assessment.gate, 0);
  assert.equal(result.assessment.diagnostic, 1);
  assert.equal(result.assessment.needsAcknowledgement, true);
  assert.match(
    result.assessment.acknowledgementReason ?? "",
    /diagnostic\/manual/,
  );
});

test("lintPlan: an ambiguous mixed bullet fails closed with a line number", () => {
  const plan = [
    "# Plan: Ambiguous",
    "",
    "## Plan Steps",
    "",
    "1. Do the thing",
    "",
    "## Verification",
    "",
    "- `pnpm dev:preflight`, followed by a manual smoke test.",
  ].join("\n");
  const result = lintPlan(plan);
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /line 9/i);
  const refused = planFreezeGate(result, { acknowledged: true });
  assert.equal(refused.ok, false, "acknowledgement cannot bypass a compile error");
  assert.match(refused.error ?? "", /does not compile/i);
  assert.equal(result.assessment.gate, 0);
});

test("formatPlanLintReport: counts, exact commands, workspace and timeout", () => {
  const result = lintPlan(fixture("checks-block.md"), {
    path: "checks-block.md",
    workspaces: [WORKSPACE],
  });
  assert.equal(result.ok, true);
  const report = formatPlanLintReport(result);
  assert.match(report, /Plan lint: OK/);
  assert.match(report, /checks-block\.md/);
  assert.match(report, /Rows: 2/);
  assert.match(report, /Final checks: 3 gate · 0 diagnostic · 0 manual/);
  assert.match(report, /pnpm typecheck/);
  assert.match(report, /timeout 900s/);
  assert.match(report, /workspace W/);
  assert.match(report, /W=C:\/work \(primary\)/);
});

test("formatPlanLintReport: failure lists the line and no gate", () => {
  const result = lintPlan(fixture("unsupported-yaml.md"));
  assert.equal(result.ok, false);
  const report = formatPlanLintReport(result);
  assert.match(report, /Plan lint: FAILED/);
  assert.match(report, /Errors:/);
  assert.match(report, /Acknowledgement required:/);
});

test("formatPlanPreview: prints exactly what will run and the warning", () => {
  const fenced = formatPlanPreview(lintPlan(FENCED));
  assert.match(fenced, /3 final gate/);
  assert.match(fenced, /npm run typecheck/);
  assert.doesNotMatch(fenced, /WARNING/);

  const prose = formatPlanPreview(
    lintPlan(
      ["# Plan: P", "", "## Plan Steps", "", "1. Do it"].join("\n"),
    ),
  );
  assert.match(prose, /WARNING: the plan has no final gate checks/);
});

test("assessPlanGates: counts row checks and never mutates input", () => {
  const checks = [
    { id: "a", command: "npm test", kind: "gate" as const },
    { id: "b", command: "npm run lint", kind: "diagnostic" as const },
  ];
  const rows = [
    { checks: [{ id: "r", command: "npm run a", kind: "gate" as const }] },
    { checks: [] },
  ];
  const result = assessPlanGates(checks, rows);
  assert.equal(result.gate, 1);
  assert.equal(result.diagnostic, 1);
  assert.equal(result.rowChecks, 1);
  assert.equal(result.rows, 2);
  assert.equal(result.needsAcknowledgement, false);
  assert.equal(checks.length, 2);
});

test("reviewPlanSubmissionProblems: rejects ambiguity introduced by a rewrite", () => {
  const original = FENCED;
  const ambiguous = original.replace(
    "- `npm run lint`",
    "- `npm run lint`, then look at the output",
  );
  const problems = reviewPlanSubmissionProblems(original, ambiguous);
  assert.ok(problems.length > 0);
  assert.match(problems.join("\n"), /does not compile/i);
});

test("reviewPlanSubmissionProblems: rejects a rewrite that drops every gate", () => {
  const stripped = [
    "# Plan: Fenced commands only",
    "",
    "## Plan Steps",
    "",
    "1. Run the typecheck",
    "",
    "## Verification",
    "",
    "- Run the checks manually",
  ].join("\n");
  const problems = reviewPlanSubmissionProblems(FENCED, stripped);
  assert.equal(problems.length, 1);
  assert.match(problems[0]!, /removed every final gate/i);
});

test("reviewPlanSubmissionProblems: a legitimate edit is accepted", () => {
  const edited = FENCED.replace(
    "1. Run the typecheck",
    "1. Run the typecheck for every package",
  );
  assert.deepEqual(reviewPlanSubmissionProblems(FENCED, edited), []);
});

test("reviewPlanSubmissionProblems: a prose plan does not need gates", () => {
  const original = "# Plan: P\n\n## Plan Steps\n\n1. Do it\n";
  const next = "# Plan: P\n\n## Plan Steps\n\n1. Do it carefully\n";
  assert.deepEqual(reviewPlanSubmissionProblems(original, next), []);
});
