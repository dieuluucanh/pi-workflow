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
  DEFAULT_REVIEW_MODE_CONFIG,
  REVIEW_CRITERIA,
  REVIEW_SYSTEM_PROMPT,
  coerceReviewModeConfig,
  readReviewModeConfig,
  resolveReviewPrompt,
  writeReviewModeConfig,
} from "./review.ts";
import {
  buildPass1Prompt,
  buildPass2Prompt,
  type ReviewPriorRound,
} from "./review-runtime.ts";

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

test("Review settings: legacy chunkedSubmit/chunkChars keys are ignored, not fatal", () => {
  // Users may still carry the removed chunked-path settings on disk. Reading
  // them must not throw and must not resurrect the deleted fields.
  const config = coerceReviewModeConfig({
    enabled: true,
    rounds: 2,
    chunkedSubmit: "off",
    chunkChars: 0,
  });
  assert.equal(config.enabled, true);
  assert.equal(config.rounds, 2);
  assert.equal(config.passes, DEFAULT_REVIEW_MODE_CONFIG.passes);
  assert.ok(!("chunkedSubmit" in config), "chunkedSubmit is not part of the config");
  assert.ok(!("chunkChars" in config), "chunkChars is not part of the config");

  // Junk legacy values are ignored the same way.
  const junk = coerceReviewModeConfig({
    chunkedSubmit: { unexpected: true },
    chunkChars: "not-a-number",
  });
  assert.equal(junk.enabled, DEFAULT_REVIEW_MODE_CONFIG.enabled);
  assert.ok(!("chunkChars" in junk));
});

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

// ── Planner↔Reviewer loop: the previous round reaches the Reviewer ────────

const PRIOR_ROUND: ReviewPriorRound = {
  round: 2,
  notes: [
    { id: "R1", step: "2", change: "Add the CSV writer" },
    { id: "R2", change: "Drop the duplicate export helper" },
    { id: "R3", step: "4", change: "Add a migration rollback step" },
  ],
  responses: [
    { id: "R1", status: "applied" },
    {
      id: "R2",
      status: "rejected",
      reason: "The helper is already covered by the writer test.",
    },
    {
      id: "R3",
      status: "not_applicable",
      reason: "This plan adds no schema migration.",
    },
  ],
};

function pass1(priorRound?: ReviewPriorRound): string {
  return buildPass1Prompt({
    planPath: ".pi/plans/x.md",
    planText: PLAN,
    reviewPrompt: "guidance",
    contextBlock: "",
    round: 2,
    totalRounds: 3,
    verify: true,
    ...(priorRound === undefined ? {} : { priorRound }),
  });
}

function pass2(priorRound?: ReviewPriorRound): string {
  return buildPass2Prompt({
    planPath: ".pi/plans/x.md",
    originalPlan: PLAN,
    rewrittenPlan: `${PLAN}\n\n## Reviewer Revisions (round 2)\n\n- change`,
    findings: [FINDING],
    ...(priorRound === undefined ? {} : { priorRound }),
  });
}

test("buildPass1Prompt renders the previous round before the audit instructions", () => {
  const prompt = pass1(PRIOR_ROUND);

  // Header names the revision round the notes came from.
  assert.ok(prompt.includes("## Previous round (round 2)"), prompt);
  // Inserted before the normal audit instructions; the plan path survives.
  assert.ok(
    prompt.indexOf("## Previous round (round 2)") <
      prompt.indexOf("Audit the plan below"),
  );
  assert.ok(prompt.includes("File: .pi/plans/x.md"));

  // Every id and disposition is visible; `applied` carries no reason, the
  // other two carry the Planner's reason after an em dash.
  assert.ok(prompt.includes("- R1 · Step 2: applied"));
  assert.ok(
    prompt.includes(
      "- R2: rejected — The helper is already covered by the writer test.",
    ),
  );
  assert.ok(
    prompt.includes(
      "- R3 · Step 4: not applicable — This plan adds no schema migration.",
    ),
  );
  assert.ok(!/R1 · Step 2: applied —/.test(prompt), "applied has no reason");

  // The two instruction lines that keep the loop from ping-ponging.
  assert.ok(
    prompt.includes(
      "Do not re-raise a note the Planner resolved unless the revised body still\nfails it; if it does, restate it with the evidence.",
    ),
  );
  assert.ok(
    prompt.includes(
      "The plan body is authoritative; you still write only the appendix.",
    ),
  );

  // A missing reason still renders a line the Reviewer can read.
  const noReason = pass1({
    round: 1,
    notes: [{ id: "R1", change: "x" }],
    responses: [{ id: "R1", status: "rejected" }],
  });
  assert.ok(noReason.includes("- R1: rejected — no reason given"), noReason);
});

test("previous round caps notes at 12 and reasons at 240 characters", () => {
  const notes = Array.from({ length: 15 }, (_v, index) => ({
    id: `R${index + 1}`,
    change: `change ${index + 1}`,
  }));
  // One over-long reason; the other notes carry no response at all.
  const longReason = `reject-reason ${"x".repeat(300)}`;
  const responses = [
    { id: "R1", status: "rejected" as const, reason: longReason },
  ];
  const prompt = pass1({ round: 3, notes, responses });

  // 12 rendered lines plus an id-preserving tail: ids are never dropped.
  assert.ok(prompt.includes("- R12: no response recorded"));
  assert.ok(!prompt.includes("- R13:"), "only 12 notes are listed");
  assert.ok(prompt.includes("… and 3 more: R13, R14, R15"), prompt);

  // The reason is clipped to 240 characters, ending in an ellipsis.
  const expected = `- R1: rejected — ${longReason.slice(0, 239)}…`;
  assert.ok(prompt.includes(`\n${expected}\n`), "the reason is clipped");
  assert.ok(!prompt.includes(longReason), "the full reason is not in the prompt");
  const reasonLine =
    prompt.split("\n").find((line) => line.startsWith("- R1: rejected")) ?? "";
  assert.equal(
    reasonLine.length,
    "- R1: rejected — ".length + 240,
    "the reason body is exactly 240 characters",
  );
});

test("buildPass2Prompt carries the same previous-round section", () => {
  const prompt = pass2(PRIOR_ROUND);
  assert.ok(prompt.includes("## Previous round (round 2)"));
  assert.ok(prompt.includes("- R1 · Step 2: applied"));
  assert.ok(
    prompt.includes(
      "- R2: rejected — The helper is already covered by the writer test.",
    ),
  );
  assert.ok(prompt.includes("not applicable — This plan adds no schema migration."));
  assert.ok(
    prompt.includes(
      "The plan body is authoritative; you still write only the appendix.",
    ),
  );
  // Still the verifying pass, and still diffing the revisions.
  assert.ok(prompt.includes("Over-engineering check"));
  assert.ok(prompt.includes("Reviewer Revisions"));
});

test("a round without priorRound renders no previous-round section", () => {
  for (const prompt of [pass1(), pass2()]) {
    assert.ok(!prompt.includes("Previous round"), prompt);
    assert.ok(!prompt.includes("Do not re-raise a note"));
    assert.ok(!prompt.includes("The plan body is authoritative"));
    // No stray blank heading or doubled separator left by the skipped section.
    assert.ok(!prompt.includes("\n\n\n"));
  }
  // The fresh prompts still open with their own band and instructions.
  assert.ok(
    pass1().startsWith(
      "[REVIEW MODE — PASS 1 of 2 — round 2/3]\n\nAudit the plan below",
    ),
  );
  assert.ok(
    pass2().startsWith(
      "[REVIEW MODE — PASS 2 of 2: VERIFY YOUR OWN REVISIONS]\n\nYou just submitted",
    ),
  );
});

// ── Revision budget (reviewMode.maxRevisions) ─────────────────────────

test("review settings: maxRevisions defaults to 3", () => {
  assert.equal(DEFAULT_REVIEW_MODE_CONFIG.maxRevisions, 3);
  const config = coerceReviewModeConfig({});
  assert.equal(config.maxRevisions, 3);
});

test("review settings: maxRevisions clamps to 0..5 and junk falls back to 3", () => {
  assert.equal(coerceReviewModeConfig({ maxRevisions: 0 }).maxRevisions, 0);
  assert.equal(coerceReviewModeConfig({ maxRevisions: -2 }).maxRevisions, 0);
  assert.equal(coerceReviewModeConfig({ maxRevisions: 5 }).maxRevisions, 5);
  assert.equal(coerceReviewModeConfig({ maxRevisions: 99 }).maxRevisions, 5);
  assert.equal(coerceReviewModeConfig({ maxRevisions: 2.7 }).maxRevisions, 2);
  assert.equal(coerceReviewModeConfig({ maxRevisions: "junk" }).maxRevisions, 3);
  assert.equal(
    coerceReviewModeConfig({ maxRevisions: Number.NaN }).maxRevisions,
    3,
  );
});

test("review settings: maxRevisions survives a write/read round-trip", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "review-revisions-"));
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "review-revisions-"));
  try {
    // A fresh read is the default.
    assert.equal(readReviewModeConfig(cwd, agentDir).config.maxRevisions, 3);

    const written = writeReviewModeConfig("project", cwd, agentDir, {
      maxRevisions: 2,
    });
    assert.equal(written.ok, true, written.error);
    assert.equal(readReviewModeConfig(cwd, agentDir).config.maxRevisions, 2);

    // Only the patched field is written: the scope does not pin the rest.
    const raw = JSON.parse(
      fs.readFileSync(path.join(cwd, ".pi", "settings.json"), "utf8"),
    );
    assert.deepEqual(raw.workflow.reviewMode, { maxRevisions: 2 });

    // `rounds` keeps its own default and meaning; the two are independent.
    assert.equal(
      readReviewModeConfig(cwd, agentDir).config.rounds,
      DEFAULT_REVIEW_MODE_CONFIG.rounds,
    );

    // An out-of-range write is clamped on the way in and on the way out.
    assert.equal(
      writeReviewModeConfig("project", cwd, agentDir, { maxRevisions: 9 }).ok,
      true,
    );
    assert.equal(readReviewModeConfig(cwd, agentDir).config.maxRevisions, 5);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(agentDir, { recursive: true, force: true });
  }
});
