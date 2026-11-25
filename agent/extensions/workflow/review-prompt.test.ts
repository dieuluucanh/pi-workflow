/**
 * Tests for the fixed review criteria and the reviewer guidance/prompt surface.
 *
 * Covers three contracts:
 *  - `REVIEW_CRITERIA` / `REVIEW_SYSTEM_PROMPT` are fixed and carry simplicity
 *    as a first-class (fifth) criterion.
 *  - `resolveReviewPrompt` returns GUIDANCE only: a project/global
 *    `review-prompt.md` replaces the default text but can never replace the
 *    criteria, which live in the system prompt.
 *  - `buildPass1Prompt` / `buildPass2Prompt` place that guidance and the
 *    over-engineering check where the reviewer actually reads them.
 *
 * Pure node:test + temp dirs; no Pi runtime is started.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  DEFAULT_REVIEW_GUIDANCE,
  REVIEW_CRITERIA,
  REVIEW_SYSTEM_PROMPT,
  resolveReviewPrompt,
} from "./review.ts";
import { buildPass1Prompt, buildPass2Prompt } from "./review-runtime.ts";

const CRITERIA_TEXT = REVIEW_CRITERIA.join("\n");

const PLAN = [
  "# Plan: Export",
  "",
  "## Steps",
  "",
  "1. Add the CSV writer",
  "",
].join("\n");

const FINDING = {
  id: "F1",
  severity: 8,
  confidence: 90,
  category: "correctness",
  summary: "The route is missing",
  rationale: "A plan step without a route cannot ship.",
  disposition: "accepted" as const,
};

test("REVIEW_CRITERIA has exactly five numbered criteria in priority order", () => {
  const numbered = CRITERIA_TEXT.split("\n").filter((line) =>
    /^\d+\. /.test(line),
  );
  assert.equal(numbered.length, 5, `expected 5 numbered criteria, got:\n${CRITERIA_TEXT}`);

  assert.match(CRITERIA_TEXT, /Framework alignment/);
  assert.match(CRITERIA_TEXT, /Industry best practice/);
  assert.match(CRITERIA_TEXT, /Requirement coverage/);
  assert.match(CRITERIA_TEXT, /Executability/);

  const fifth = numbered[4] ?? "";
  assert.match(fifth, /simplicity/i);
  assert.match(fifth, /over-engineering/i);
});

test("REVIEW_SYSTEM_PROMPT embeds the fixed criteria heading and criterion 5", () => {
  assert.ok(
    REVIEW_SYSTEM_PROMPT.includes(
      "## Review criteria (fixed; in priority order)",
    ),
  );
  assert.ok(REVIEW_SYSTEM_PROMPT.includes(CRITERIA_TEXT));
  assert.match(REVIEW_SYSTEM_PROMPT, /5\. Simplicity and over-engineering/);
});

test("resolveReviewPrompt returns project/global guidance and never replaces the criteria", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "review-prompt-"));
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "review-prompt-"));
  try {
    // Neither file: the built-in guidance, flagged as default.
    const fallback = resolveReviewPrompt(cwd, agentDir);
    assert.equal(fallback.text, DEFAULT_REVIEW_GUIDANCE);
    assert.equal(fallback.source, "default");
    assert.equal(fallback.path, undefined);

    // Global only.
    const globalText = "Prefer the existing module layout over new packages.\n";
    fs.writeFileSync(
      path.join(agentDir, "review-prompt.md"),
      globalText,
      "utf8",
    );
    const fromGlobal = resolveReviewPrompt(cwd, agentDir);
    assert.equal(fromGlobal.text, globalText);
    assert.equal(fromGlobal.source, "global");

    // Project wins, and still carries guidance only — no criteria set.
    const projectText = "Audit migration/rollback safety on every schema step.\n";
    fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
    fs.writeFileSync(
      path.join(cwd, ".pi", "review-prompt.md"),
      projectText,
      "utf8",
    );
    const fromProject = resolveReviewPrompt(cwd, agentDir);
    assert.equal(fromProject.text, projectText);
    assert.equal(fromProject.source, "project");
    assert.equal(fromProject.path, path.join(cwd, ".pi", "review-prompt.md"));
    assert.ok(!fromProject.text.includes("5. Simplicity"));
    assert.ok(!fromProject.text.includes("Review criteria"));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(agentDir, { recursive: true, force: true });
  }
});

test("buildPass1Prompt emits the guidance under Additional reviewer guidance", () => {
  const guidance = "Audit migration/rollback safety on every schema step.";
  const prompt = buildPass1Prompt({
    planPath: ".pi/plans/x.md",
    planText: PLAN,
    reviewPrompt: guidance,
    contextBlock: "",
    round: 1,
    totalRounds: 1,
    verify: true,
  });

  assert.ok(prompt.includes("## Additional reviewer guidance"));
  assert.ok(prompt.includes(guidance));
  assert.ok(!prompt.includes("## Your review guidance (authoritative)"));
  // The prompt states the criteria cannot be removed (they live in the system prompt).
  assert.ok(
    prompt.includes(
      "This guidance supplements the fixed review criteria in your system prompt",
    ),
  );
});

test("buildPass2Prompt diffs the appended revisions and keeps the over-engineering check", () => {
  const base = buildPass2Prompt({
    planPath: ".pi/plans/x.md",
    originalPlan: PLAN,
    rewrittenPlan: PLAN,
    findings: [FINDING],
  });
  assert.ok(base.includes("Over-engineering check"));
  assert.ok(base.includes("(no differences)"));

  const appended = `${PLAN}\n\n## Reviewer Revisions (round 1)\n\n- change`;
  const changed = buildPass2Prompt({
    planPath: ".pi/plans/x.md",
    originalPlan: PLAN,
    rewrittenPlan: appended,
    findings: [FINDING],
  });
  assert.ok(changed.includes("Over-engineering check"));
  assert.ok(changed.includes("Reviewer Revisions"));
  assert.ok(!changed.includes("(no differences)"));
});
