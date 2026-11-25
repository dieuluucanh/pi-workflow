/**
 * Advisory review notes (2026-11-25 authoritative-review plan, row 1).
 *
 * Pins the appendix format that the row-2 parser (`parseReviewNotes`) reads:
 * stable `R<n>` ids, the optional `Step`/`(F…)` fragments, the advisory line,
 * and the "one section per round" rule. `renderRequiredChanges` in utils.ts is
 * the single source of truth; the shared fixture
 * `fixtures/review-notes-required-changes.json` is the round-trip contract.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  countPlanSteps,
  parseReviewNotes,
  planHash,
  renderRequiredChanges,
  REVIEW_CHANGELOG_HEADING,
  REVIEW_UNRESOLVED_HEADING,
  stripReviewAppendix,
  type ReviewRevision,
} from "./utils.ts";
import {
  createReviewSubmitTool,
  type ReviewSubmitPayload,
} from "./review-tools.ts";
import {
  approveHandoffPlan,
  createHandoffDecision,
  handoffDecisionMatches,
  type HandoffDecision,
} from "./handoff-routing.ts";
import { reviewHandoffRecovery } from "./review-handoff.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = path.join(
  HERE,
  "fixtures",
  "review-notes-required-changes.json",
);

const ADVISORY_LINE =
  "_Advisory review notes. The approved plan body is authoritative on any conflict._";

const ORIGINAL_PLAN = [
  "# Plan: Export",
  "",
  "## Steps",
  "",
  "1. Add the CSV writer",
  "2. Add the route",
  "3. Document the endpoint",
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

interface RequiredChangesFixture {
  revisions: ReviewRevision[];
  requiredChanges: string;
}

function readFixture(): RequiredChangesFixture {
  return JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf8")) as RequiredChangesFixture;
}

function makeSubmitTool(
  submit: (payload: ReviewSubmitPayload) => Promise<unknown>,
) {
  return createReviewSubmitTool({
    planPath: () => ".pi/plans/x.md",
    originalPlan: () => ORIGINAL_PLAN,
    modelLabel: () => "reviewer/model",
    round: () => 1,
    submit: async (payload) => {
      await submit(payload);
      return { ok: true };
    },
    log: () => {},
  });
}

test("renderRequiredChanges matches the shared round-trip fixture exactly", () => {
  const fixture = readFixture();
  assert.equal(
    renderRequiredChanges(fixture.revisions),
    fixture.requiredChanges,
  );
  assert.equal(
    fixture.requiredChanges,
    [
      "### Required changes",
      "",
      "- **R1 · Step 2:** Register the route. _(F1)_",
    ].join("\n"),
  );
});

test("renderRequiredChanges omits Step and findingIds when absent", () => {
  assert.equal(renderRequiredChanges([]), "");
  assert.equal(renderRequiredChanges(undefined), "");
  assert.equal(
    renderRequiredChanges([{ id: "R1", change: "Do the thing." }]),
    ["### Required changes", "", "- **R1:** Do the thing."].join("\n"),
  );
  assert.equal(
    renderRequiredChanges([
      { id: "R2", step: "3", change: "Register the route." },
    ]),
    ["### Required changes", "", "- **R2 · Step 3:** Register the route."].join(
      "\n",
    ),
  );
  assert.equal(
    renderRequiredChanges([
      { id: "R3", change: "Add tests.", findingIds: ["F1", "F3"] },
    ]),
    ["### Required changes", "", "- **R3:** Add tests. _(F1, F3)_"].join("\n"),
  );
});

test("review_submit normalises missing ids to R1..Rn in submission order", async () => {
  const writes: ReviewSubmitPayload[] = [];
  const tool = makeSubmitTool(async (payload) => {
    writes.push(payload);
  });

  const result = await tool.execute(
    "id",
    {
      findings: [FINDING],
      verdict: "revise",
      summary: "Tighten the steps.",
      revisions: [
        { step: "1", change: "Add the writer." },
        { step: "2", change: "Register the route." },
        { change: "Document the endpoint." },
      ],
    },
    undefined,
    undefined,
    {},
  );

  assert.equal(result.isError, undefined);
  assert.equal(writes.length, 1);
  const changelog = writes[0]!.changelog;
  assert.ok(changelog.includes("- **R1 · Step 1:** Add the writer."), changelog);
  assert.ok(
    changelog.includes("- **R2 · Step 2:** Register the route."),
    changelog,
  );
  assert.ok(
    changelog.includes("- **R3:** Document the endpoint."),
    changelog,
  );
});

test("review_submit keeps supplied ids and renders findingIds", async () => {
  const writes: ReviewSubmitPayload[] = [];
  const tool = makeSubmitTool(async (payload) => {
    writes.push(payload);
  });

  await tool.execute(
    "id",
    {
      findings: [FINDING],
      verdict: "revise",
      summary: "One revision.",
      revisions: [
        {
          id: "R7",
          step: "2",
          change: "Register the route.",
          findingIds: ["F1", "F3"],
        },
      ],
    },
    undefined,
    undefined,
    {},
  );

  assert.ok(
    writes[0]!.changelog.includes(
      "- **R7 · Step 2:** Register the route. _(F1, F3)_",
    ),
  );
});

test("the advisory line sits immediately under the Reviewer Revisions heading", async () => {
  const writes: ReviewSubmitPayload[] = [];
  const tool = makeSubmitTool(async (payload) => {
    writes.push(payload);
  });

  await tool.execute(
    "id",
    {
      findings: [FINDING],
      verdict: "revise",
      summary: "One revision.",
      revisions: [{ step: "2", change: "Register the route." }],
    },
    undefined,
    undefined,
    {},
  );

  const lines = writes[0]!.changelog.split("\n");
  const heading = lines.indexOf("## Reviewer Revisions (round 1)");
  assert.notEqual(heading, -1);
  assert.equal(lines[heading + 1], ADVISORY_LINE);
});

test("two review_submit calls in one round leave exactly one section", async () => {
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
      return { ok: true };
    },
    log: () => {},
  });

  const params = {
    findings: [FINDING],
    verdict: "revise" as const,
    summary: "One revision.",
    revisions: [{ step: "2", change: "Register the route." }],
  };

  await tool.execute("id-1", params, undefined, undefined, {});
  await tool.execute("id-2", params, undefined, undefined, {});

  const headings = writes[1]!.planText.match(
    /^## Reviewer Revisions \(round 1\)$/gm,
  );
  assert.equal(headings?.length, 1, writes[1]!.planText);
  assert.equal(
    writes[1]!.planText.match(
      /^_Advisory review notes\. The approved plan body is authoritative on any conflict\._$/gm,
    )?.length,
    1,
  );
});

// ── parseReviewNotes (row 2) ─────────────────────────────────────────

function appendix(lines: string[], round = 1): string[] {
  return [
    `## Reviewer Revisions (round ${round})`,
    ADVISORY_LINE,
    "",
    ...lines,
    "",
  ];
}

test("parseReviewNotes reads numeric and non-numeric steps", () => {
  const plan = [
    ...ORIGINAL_PLAN.split("\n"),
    ...appendix([
      "### Required changes",
      "",
      "- **R1 · Step 2:** Register the route. _(F1, F3)_",
      "- **R2 · Step Phase 2:** Do the phase-2 thing.",
      "- **R3:** Do the thing.",
    ]),
  ].join("\n");

  assert.deepEqual(parseReviewNotes(plan), {
    notes: [
      {
        id: "R1",
        step: "2",
        change: "Register the route.",
        findingIds: ["F1", "F3"],
      },
      { id: "R2", step: "Phase 2", change: "Do the phase-2 thing." },
      { id: "R3", change: "Do the thing." },
    ],
    round: 1,
    stepCount: 3,
  });
});

test("two appended rounds parse the last round only", () => {
  const plan = [
    "# Plan: Export",
    "",
    "## Steps",
    "",
    "1. Add the CSV writer",
    "2. Add the route",
    "",
    ...appendix(["### Required changes", "", "- **R1 · Step 1:** Round one change."], 1),
    ...appendix(
      [
        "### Required changes",
        "",
        "- **R1 · Step 2:** Round two change.",
        "- **R2 · Step 1:** Second note.",
      ],
      2,
    ),
  ].join("\n");

  const parsed = parseReviewNotes(plan);
  assert.equal(parsed.round, 2);
  assert.deepEqual(parsed.notes, [
    { id: "R1", step: "2", change: "Round two change." },
    { id: "R2", step: "1", change: "Second note." },
  ]);
  assert.equal(parsed.stepCount, 2);
});

test("a round without a required-changes block yields no notes", () => {
  const approving = [
    ...ORIGINAL_PLAN.split("\n"),
    ...appendix([
      "Reviewer: `reviewer/model`",
      "Verdict: **approve**",
      "Summary: Nothing to change.",
    ]),
  ].join("\n");
  assert.deepEqual(parseReviewNotes(approving), {
    notes: [],
    round: 1,
    stepCount: 3,
  });

  const emptyBlock = [
    ...ORIGINAL_PLAN.split("\n"),
    ...appendix([
      "### Required changes",
      "",
      "Reviewer: `reviewer/model`",
      "Verdict: **revise**",
      "",
      "**Findings:** 0 addressed",
    ]),
  ].join("\n");
  assert.deepEqual(parseReviewNotes(emptyBlock), {
    notes: [],
    round: 1,
    stepCount: 3,
  });
});

test("a legacy round-1 section without R ids gets positional R1..Rn", () => {
  // No `R` ids and no advisory line: the parser assigns ids by position.
  const plan = [
    "# Plan: Export",
    "",
    "## Steps",
    "",
    "1. Add the CSV writer",
    "2. Add the route",
    "3. Document the endpoint",
    "",
    "## Reviewer Revisions (round 1)",
    "Reviewer: `legacy/model`",
    "Verdict: **revise**",
    "",
    "### Required changes",
    "",
    "- **Step 3:** Document the endpoint.",
    "- **2:** Register the route.",
    "",
  ].join("\n");

  assert.deepEqual(parseReviewNotes(plan), {
    notes: [
      { id: "R1", step: "3", change: "Document the endpoint." },
      { id: "R2", step: "2", change: "Register the route." },
    ],
    round: 1,
    stepCount: 3,
  });
});

test("a plan with no appendix parses to no notes", () => {
  assert.deepEqual(parseReviewNotes(ORIGINAL_PLAN), {
    notes: [],
    stepCount: 3,
  });
  assert.deepEqual(parseReviewNotes(""), { notes: [], stepCount: 0 });
});

test("malformed required-change bullets are skipped, never thrown", () => {
  const plan = [
    ...ORIGINAL_PLAN.split("\n"),
    ...appendix([
      "### Required changes",
      "",
      "- **R1 · Step 2:**",
      "- not a bold bullet",
      "- **Weird head:** Change it.",
      "- **R4 · Step 3:** Keep this one. _(F9)_",
    ]),
  ].join("\n");

  assert.deepEqual(parseReviewNotes(plan).notes, [
    { id: "R4", step: "3", change: "Keep this one.", findingIds: ["F9"] },
  ]);
});

test("renderRequiredChanges → parseReviewNotes round-trip (fixture contract)", () => {
  const fixture = readFixture();
  const revisions: ReviewRevision[] = [
    ...fixture.revisions,
    { id: "R2", change: "Add tests.", findingIds: ["F1", "F3"] },
  ];

  // Exactly the appendix order `renderReviewerRevisions` emits: the required
  // changes block, then the findings changelog (which must never leak in).
  const plan = [
    ...ORIGINAL_PLAN.split("\n"),
    "## Reviewer Revisions (round 1)",
    ADVISORY_LINE,
    "",
    "Reviewer: `reviewer/model`",
    "Verdict: **revise**",
    "Summary: Two revisions.",
    "",
    renderRequiredChanges(revisions),
    "",
    "reviewer `reviewer/model` · verdict **revise**",
    "",
    "**Findings:** 1 addressed",
    "",
    "### Addressed",
    "",
    "- 🟡 `utils.ts:1` — The route is missing _(severity 8, confidence 90%, correctness)_",
    "  - A plan step without a route cannot ship.",
    "",
  ].join("\n");

  assert.deepEqual(parseReviewNotes(plan), {
    round: 1,
    stepCount: 3,
    notes: [
      {
        id: "R1",
        step: "2",
        change: "Register the route.",
        findingIds: ["F1"],
      },
      { id: "R2", change: "Add tests.", findingIds: ["F1", "F3"] },
    ],
  });
});

test("stepCount counts numbered items under the last step-ish heading", () => {
  const plan = [
    "# Plan: Export",
    "",
    "## Context",
    "",
    "1. Not a step",
    "2. Still context",
    "",
    "## Plan Steps",
    "",
    "1. Add the CSV writer",
    "2. Add the route",
    "3. Document the endpoint",
    "   1. nested detail",
    "",
  ].join("\n");

  assert.equal(countPlanSteps(plan), 3);
  assert.equal(parseReviewNotes(plan).stepCount, 3);

  const withAppendix = [
    plan,
    "## Reviewer Revisions (round 1)",
    ADVISORY_LINE,
    "",
    "### Required changes",
    "",
    "- **R1 · Step 1:** Fix it.",
    "",
    "1. Appendix numbering never counts",
    "",
  ].join("\n");
  assert.equal(countPlanSteps(withAppendix), 3);
  assert.equal(parseReviewNotes(withAppendix).stepCount, 3);
});

test("stepCount falls back to every top-level numbered item without a step heading", () => {
  const plan = [
    "# Plan: Export",
    "",
    "1. Add the CSV writer",
    "2. Add the route",
    "3. Document the endpoint",
    "  1. nested detail",
    "",
  ].join("\n");

  assert.equal(countPlanSteps(plan), 3);
  assert.equal(parseReviewNotes(plan).stepCount, 3);
});

// ── planHash invariants (row 8) ──────────────────────────────────────
//
// Decision, recorded here rather than silently widened in code: the
// `## Reviewer Revisions (round N)` appendix is PART of the reviewed document.
// `stripReviewAppendix` therefore strips only `## Review changes` and
// `## Unresolved findings`, and `planHash` includes the revision appendix.
// The review-round guards compare that post-review text, so a new round is a
// new document while an identical reviewed text stays `unchanged`.

const REVIEWED_BODY = ORIGINAL_PLAN.trimEnd();

function reviewedText(round = 1, body = REVIEWED_BODY): string {
  return [
    body,
    ...appendix(
      [
        "### Required changes",
        "",
        `- **R1 · Step 2:** Round ${round} change.`,
      ],
      round,
    ),
  ].join("\n");
}

function amendedBody(): string {
  return REVIEWED_BODY.replace("2. Add the route", "2. Add the JSON route");
}

/** The shared computation every round guard reduces to. */
function hashVerdict(
  reference: string,
  candidate: string,
): "unchanged" | "changed" {
  return planHash(reference) === planHash(candidate) ? "unchanged" : "changed";
}

test("planHash includes the revision appendix and is stable for identical text", () => {
  const body = REVIEWED_BODY;
  const round1 = reviewedText();

  // The appendix is not stripped, so reviewed text is a different document
  // from the bare body the author wrote.
  assert.notEqual(planHash(round1), planHash(body));
  assert.equal(stripReviewAppendix(round1), round1);

  // Byte-identical reviewed text hashes identically, call after call.
  assert.equal(reviewedText(), reviewedText());
  assert.equal(planHash(round1), planHash(reviewedText()));
});

test("planHash treats a new round as a new reviewed document", () => {
  assert.notEqual(planHash(reviewedText(1)), planHash(reviewedText(2)));
});

test("planHash changes when only the body is rewritten", () => {
  const original = reviewedText();
  const rewritten = reviewedText(1, amendedBody());

  assert.notEqual(rewritten, original);
  assert.notEqual(planHash(rewritten), planHash(original));
  assert.equal(planHash(original), planHash(reviewedText()));
});

test("stripReviewAppendix still drops only the changelog headings", () => {
  // Pins the documented scope of the helper: changelog/unresolved are cut,
  // the revision appendix above is not.
  const withChangelog = `${REVIEWED_BODY}\n\n---\n\n${REVIEW_CHANGELOG_HEADING}\n\n- body changed\n`;
  const withUnresolved = `${REVIEWED_BODY}\n\n${REVIEW_UNRESOLVED_HEADING}\n\n- open question\n`;

  assert.equal(stripReviewAppendix(withChangelog), `${REVIEWED_BODY}\n`);
  assert.equal(planHash(withChangelog), planHash(REVIEWED_BODY));
  assert.equal(planHash(withUnresolved), planHash(REVIEWED_BODY));
});

// ── Guard sites (row 8) ──────────────────────────────────────────────
//
// Each test names the index.ts site it pins. Where the site has a pure helper
// in handoff-routing.ts/review-handoff.ts, the helper is tested directly; the
// remaining sites are pinned through the exact planHash comparison they use.

test("guard: handoff print dedupe — identical text dedupes, amended body prints", () => {
  // index.ts `printHandoffPlan`: const key = `${planPath}:${planHash(planText)}`;
  // booking that key in `handoffPrintKey` is the dedupe. No pure helper exists,
  // so this is hash-comparison-tested.
  const planPath = "C:/work/.pi/plans/2026-11-25-advisory.md";
  const printKey = (text: string) => `${planPath}:${planHash(text)}`;

  assert.equal(printKey(reviewedText()), printKey(reviewedText()));
  assert.notEqual(printKey(reviewedText(1, amendedBody())), printKey(reviewedText()));
  assert.equal(hashVerdict(reviewedText(), reviewedText()), "unchanged");
  assert.equal(hashVerdict(reviewedText(), reviewedText(1, amendedBody())), "changed");
});

test("guard: Plannotator stale-tab check — same text keeps the tab, amended body is stale", () => {
  // index.ts browser approval: `planHash(planContent) !== pendingHandoffPlanHash`.
  // The approval site is inline (hash-comparison-tested). `reviewHandoffRecovery`
  // is the pure helper for the same pending-tab hash rule, tested directly.
  const pendingHandoffPlanHash = planHash(reviewedText());

  assert.equal(planHash(reviewedText()) !== pendingHandoffPlanHash, false);
  assert.equal(
    planHash(reviewedText(1, amendedBody())) !== pendingHandoffPlanHash,
    true,
  );
  assert.equal(hashVerdict(reviewedText(), reviewedText()), "unchanged");
  assert.equal(hashVerdict(reviewedText(), reviewedText(1, amendedBody())), "changed");

  assert.equal(
    reviewHandoffRecovery({
      status: "pending",
      pendingHash: pendingHandoffPlanHash,
      currentHash: planHash(reviewedText()),
    }).action,
    "keep",
  );
  assert.equal(
    reviewHandoffRecovery({
      status: "pending",
      pendingHash: pendingHandoffPlanHash,
      currentHash: planHash(reviewedText(1, amendedBody())),
    }).action,
    "clear",
  );
});

test("guard: approval re-read — identical text approves, amended body is invalid", () => {
  // index.ts approval re-read: `planHash(planText) !== decision.planHash`.
  // `handoffDecisionMatches` (handoff-routing.ts) is the pure helper for that
  // planHash arm, and `approveHandoffPlan` re-validates the same digest.
  const decisionHash = planHash(reviewedText());
  const created = createHandoffDecision({
    planPath: "C:/work/.pi/plans/2026-11-25-advisory.md",
    planHash: decisionHash,
    sessionRef: "session-a",
    reviewCycleId: 1,
    source: "auto",
    presenter: "native",
    reviewOwned: false,
    now: 1_000,
  });
  assert.equal(created.ok, true);
  const decision = (created as { ok: true; decision: HandoffDecision }).decision;

  assert.equal(
    handoffDecisionMatches(decision, { planHash: planHash(reviewedText()) }),
    true,
  );
  assert.equal(
    handoffDecisionMatches(decision, {
      planHash: planHash(reviewedText(1, amendedBody())),
    }),
    false,
  );
  assert.equal(hashVerdict(reviewedText(), reviewedText()), "unchanged");
  assert.equal(hashVerdict(reviewedText(), reviewedText(1, amendedBody())), "changed");

  assert.equal(
    approveHandoffPlan(decision, {
      now: 1_100,
      via: "native",
      planHash: planHash(reviewedText()),
    }).ok,
    true,
  );
  assert.equal(
    approveHandoffPlan(decision, {
      now: 1_100,
      via: "native",
      planHash: planHash(reviewedText(1, amendedBody())),
    }).ok,
    false,
  );
});

test("guard: pause/review fold — identical text is unchanged, amended body is changed", () => {
  // index.ts `applyGatedResult`: if (planHash(finalText) === planHash(authorPlan)) return;
  // No pure helper wraps this fold, so it is hash-comparison-tested.
  const authorPlan = reviewedText();

  assert.equal(planHash(reviewedText()) === planHash(authorPlan), true);
  assert.equal(
    planHash(reviewedText(1, amendedBody())) === planHash(authorPlan),
    false,
  );
  assert.equal(hashVerdict(authorPlan, reviewedText()), "unchanged");
  assert.equal(hashVerdict(authorPlan, reviewedText(1, amendedBody())), "changed");
});
