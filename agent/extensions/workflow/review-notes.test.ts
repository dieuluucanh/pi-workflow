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
  parseReviewNotes,
  planHash,
  renderRequiredChanges,
  REVIEW_CHANGELOG_HEADING,
  REVIEW_UNRESOLVED_HEADING,
  splitReviewerAppendix,
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
  "_Review notes for the Planner. The plan body is authoritative once the Planner has revised it; unresolved notes are listed below._";

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

// ── Submission contract (Planner↔Reviewer loop fix, step 1a) ─────────
//
// The appendix grammar is `R<n>` only. A reviewer that invents `RV1` (the id
// form observed in the reported session) must be refused at submission, not
// silently rendered into a plan the parser then drops. Every refusal has to
// happen BEFORE the write, so the plan file keeps the previous round's notes.

function resultText(result: {
  content?: Array<{ text: string }>;
  isError?: boolean;
}): string {
  return (result.content ?? []).map((block) => block.text).join("\n");
}

async function submitRevisions(
  tool: ReturnType<typeof makeSubmitTool>,
  revisions: unknown[],
): Promise<{
  content?: Array<{ text: string }>;
  isError?: boolean;
}> {
  return (await tool.execute(
    "id",
    {
      findings: [FINDING],
      verdict: "revise",
      summary: "Required changes.",
      revisions,
    },
    undefined,
    undefined,
    {},
  )) as { content?: Array<{ text: string }>; isError?: boolean };
}

test("review_submit rejects a supplied id outside the R<n> form and writes nothing", async () => {
  const writes: ReviewSubmitPayload[] = [];
  const tool = makeSubmitTool(async (payload) => {
    writes.push(payload);
  });

  const result = await submitRevisions(tool, [
    { id: "RV1", step: "2", change: "Register the route." },
  ]);

  assert.equal(result.isError, true, resultText(result));
  // The error names the offending id and the field the reviewer must fix.
  assert.match(resultText(result), /RV1/, "names the bad id");
  assert.match(resultText(result), /revision/i, "names the revisions field");
  assert.equal(writes.length, 0, "an inconsistent submission never writes");
});

test("review_submit accepts a re-review submission using R1..Rn including a reused id", async () => {
  // Round 2 restates R1 and adds R2: numbering restarts per round, and an id
  // reused from the previous round is legal by design.
  const writes: ReviewSubmitPayload[] = [];
  const tool = createReviewSubmitTool({
    planPath: () => ".pi/plans/x.md",
    originalPlan: () => ORIGINAL_PLAN,
    modelLabel: () => "reviewer/model",
    round: () => 2,
    submit: async (payload) => {
      writes.push(payload);
      return { ok: true };
    },
    log: () => {},
  });

  const result = await submitRevisions(tool, [
    { id: "R1", step: "2", change: "Register the route." },
    { id: "R2", change: "Add tests." },
  ]);

  assert.equal(result.isError, undefined, resultText(result));
  assert.equal(writes.length, 1);
  const written = writes[0]!.planText;
  assert.match(written, /## Reviewer Revisions \(round 2\)/);
  assert.deepEqual(parseReviewNotes(written).notes, [
    { id: "R1", step: "2", change: "Register the route." },
    { id: "R2", change: "Add tests." },
  ]);
});

test("review_submit rejects duplicate supplied ids and writes nothing", async () => {
  const writes: ReviewSubmitPayload[] = [];
  const tool = makeSubmitTool(async (payload) => {
    writes.push(payload);
  });

  const result = await submitRevisions(tool, [
    { id: "R1", step: "1", change: "Add the writer." },
    { id: "R1", step: "2", change: "Register the route." },
  ]);

  assert.equal(result.isError, true, resultText(result));
  assert.match(resultText(result), /R1/, "names the duplicated id");
  assert.match(resultText(result), /duplicate/i);
  assert.equal(writes.length, 0, "a duplicate-id submission never writes");
});

test("review_submit rejects a change that breaks the bullet grammar", async () => {
  // Each of these keeps the ids but changes the note the parser reads back:
  // a multi-line change injects a bullet, a trailing `_(F1)_` is stripped as a
  // findings fragment, and a leading `**` is split as an id. All three are
  // renderer/parser drift and must be refused with an error naming `change`.
  for (const change of [
    "Register the route.\n- **R2:** Injected second note.",
    "Register the route. _(F1)_",
    "**Register** the route.",
  ]) {
    const writes: ReviewSubmitPayload[] = [];
    const tool = makeSubmitTool(async (payload) => {
      writes.push(payload);
    });

    const result = await submitRevisions(tool, [
      { id: "R1", step: "2", change },
    ]);

    assert.equal(result.isError, true, JSON.stringify(change));
    assert.match(resultText(result), /change/, JSON.stringify(change));
    assert.equal(writes.length, 0, JSON.stringify(change));
  }
});

test("review_submit refuses a `step` the appendix parser would reshape", async () => {
  // The bullet head is `**R1 · Step <step>:**`, so a step that fights it is
  // silently rewritten (`2**` reads back as `2`) or hides the note entirely (a
  // line break ends the bullet and the note disappears). Both are drift: the
  // guard names the note index and field, shows both sides, and writes nothing.
  const cases: Array<[string, RegExp]> = [
    ["2**", /note 1 `step` reads back as "2" but the submission says "2\*\*"/],
    ["2\n3", /note 1 \(R1\) is missing from the appendix/],
  ];
  for (const [step, pattern] of cases) {
    const writes: ReviewSubmitPayload[] = [];
    const tool = makeSubmitTool(async (payload) => {
      writes.push(payload);
    });

    const result = await submitRevisions(tool, [
      { id: "R1", step, change: "Register the route." },
    ]);

    assert.equal(result.isError, true, JSON.stringify(step));
    assert.match(resultText(result), /does not round-trip/, JSON.stringify(step));
    assert.match(resultText(result), pattern, JSON.stringify(step));
    // Both sides are shown so the reviewer can correct the submission.
    assert.match(resultText(result), /\nexpected: +\[/, JSON.stringify(step));
    assert.match(resultText(result), /\nparsed: +\[/, JSON.stringify(step));
    assert.equal(writes.length, 0, "a drifting step never writes");
  }
});

test("review_submit refuses findingIds the appendix would split", async () => {
  // `_(F1,F2)_` reads back as two ids, so the note the Planner receives differs
  // from the note the reviewer submitted.
  const writes: ReviewSubmitPayload[] = [];
  const tool = makeSubmitTool(async (payload) => {
    writes.push(payload);
  });

  const result = await submitRevisions(tool, [
    { id: "R1", change: "Add tests.", findingIds: ["F1,F2"] },
  ]);

  assert.equal(result.isError, true, resultText(result));
  assert.match(
    resultText(result),
    /note 1 `findingIds` reads back as \["F1","F2"\] but the submission says \["F1,F2"\]/,
  );
  assert.equal(writes.length, 0, "drifting findingIds never write");
});

test("review_submit accepts a note with no step and no findingIds", async () => {
  // Absent optionals are normalised on both sides: a minimal note must not be
  // refused just because the parser has nothing to fill in.
  const writes: ReviewSubmitPayload[] = [];
  const tool = makeSubmitTool(async (payload) => {
    writes.push(payload);
  });

  const result = await submitRevisions(tool, [
    { id: "R1", change: "Do the thing." },
    { change: "Do the other thing." },
  ]);

  assert.equal(result.isError, undefined, resultText(result));
  assert.equal(writes.length, 1);
  assert.deepEqual(parseReviewNotes(writes[0]!.planText).notes, [
    { id: "R1", change: "Do the thing." },
    { id: "R2", change: "Do the other thing." },
  ]);
});

test("review_submit round-trips the full note shape for a valid submission", async () => {
  const writes: ReviewSubmitPayload[] = [];
  const tool = makeSubmitTool(async (payload) => {
    writes.push(payload);
  });

  const result = await submitRevisions(tool, [
    { id: "R1", step: "2", change: "Register the route." },
    { id: "R2", change: "Add tests.", findingIds: ["F1", "F3"] },
    { step: "3", change: "Document the endpoint." },
  ]);

  assert.equal(result.isError, undefined, resultText(result));
  assert.equal(writes.length, 1);
  // Field by field, in submission order: `id`, `step`, `change`,
  // `findingIds`. The omitted id was assigned R3.
  assert.deepEqual(parseReviewNotes(writes[0]!.planText).notes, [
    { id: "R1", step: "2", change: "Register the route." },
    { id: "R2", change: "Add tests.", findingIds: ["F1", "F3"] },
    { id: "R3", step: "3", change: "Document the endpoint." },
  ]);
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
  // The retired wording is gone: the Planner's revision is authoritative now,
  // not the body the reviewer approved. The parser ignores either line.
  assert.ok(!writes[0]!.changelog.includes("approved plan body is authoritative"));
});

test("the rendered appendix parses back to the fixture's notes", async () => {
  const fixture = readFixture();
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
      revisions: fixture.revisions,
    },
    undefined,
    undefined,
    {},
  );

  const written = writes[0]!.planText;
  // New advisory line present exactly once, old line absent entirely.
  assert.equal(
    written
      .split("\n")
      .filter((line) => line === ADVISORY_LINE).length,
    1,
    written,
  );
  assert.ok(!written.includes("Advisory review notes"));
  assert.ok(written.includes(fixture.requiredChanges));
  // Round-trip: the appendix the tool renders reads back as the same notes.
  assert.deepEqual(parseReviewNotes(written).notes, fixture.revisions);
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
      /^_Review notes for the Planner\. The plan body is authoritative once the Planner has revised it; unresolved notes are listed below\._$/gm,
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
  });
});

test("a plan with no appendix parses to no notes", () => {
  assert.deepEqual(parseReviewNotes(ORIGINAL_PLAN), {
    notes: [],
  });
  assert.deepEqual(parseReviewNotes(""), { notes: [] });
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

// ── splitReviewerAppendix (Planner↔Reviewer loop, row 2) ─────────────
//
// The Planner owns `body`, the Reviewer owns `appendix`. The split must use
// the same heading grammar as `parseReviewNotes` (last round wins) and must
// normalize line endings + trailing blank space on both halves, so a CRLF save
// is not refused as "Do not edit the Reviewer's appendix".

test("splitReviewerAppendix: one appendix splits body from appendix", () => {
  const plan = reviewedText();
  const { body, appendix } = splitReviewerAppendix(plan);

  assert.equal(body, REVIEWED_BODY);
  assert.equal(
    appendix.split("\n")[0],
    "## Reviewer Revisions (round 1)",
  );
  assert.ok(appendix.includes("- **R1 · Step 2:** Round 1 change."), appendix);
  assert.ok(!appendix.endsWith("\n"), "the appendix is trimmed");
  // Reconstruction: the plan is exactly `body`, one newline, then the appendix.
  assert.equal(`${body}\n${appendix}`, plan.trimEnd());
});

test("splitReviewerAppendix: multiple rounds — the last section wins", () => {
  const plan = [
    REVIEWED_BODY,
    ...appendix(["### Required changes", "", "- **R1:** Round 1 change."], 1),
    ...appendix(["### Required changes", "", "- **R1:** Round 2 change."], 2),
  ].join("\n");

  const split = splitReviewerAppendix(plan);

  // The reviewed body is the last heading's text: everything before it.
  assert.ok(split.body.startsWith(REVIEWED_BODY), split.body);
  assert.ok(split.body.includes("## Reviewer Revisions (round 1)"), split.body);
  assert.ok(!split.body.includes("round 2"), split.body);
  assert.equal(
    split.appendix.split("\n")[0],
    "## Reviewer Revisions (round 2)",
  );
  assert.ok(split.appendix.includes("Round 2 change."), split.appendix);
  assert.ok(!split.appendix.includes("Round 1 change."), split.appendix);
  // Same section the note parser reads.
  assert.deepEqual(parseReviewNotes(plan).notes.map((n) => n.change), [
    "Round 2 change.",
  ]);
});

test("splitReviewerAppendix: no appendix leaves the trimmed body", () => {
  assert.deepEqual(splitReviewerAppendix(`\n\n${ORIGINAL_PLAN}\n\n`), {
    body: ORIGINAL_PLAN.trim(),
    appendix: "",
  });
  assert.deepEqual(splitReviewerAppendix(""), { body: "", appendix: "" });
  // A heading that is not the `(round N)` grammar is body text.
  const loose = `${REVIEWED_BODY}\n\n## Reviewer Revisions\n\n- old format\n`;
  assert.deepEqual(splitReviewerAppendix(loose), {
    body: `${REVIEWED_BODY}\n\n## Reviewer Revisions\n\n- old format`,
    appendix: "",
  });
});

test("splitReviewerAppendix: CRLF and trailing whitespace are normalized", () => {
  const lf = reviewedText();
  const crlf = `${lf.replace(/\n/g, "\r\n")}\r\n`;
  const padded = lf
    .split("\n")
    .map((line) => `${line}  \t`)
    .join("\n");

  const expected = splitReviewerAppendix(lf);
  assert.deepEqual(splitReviewerAppendix(crlf), expected);
  assert.deepEqual(splitReviewerAppendix(padded), expected);
  // The body hash a Windows editor save produces is the same hash.
  assert.equal(
    planHash(splitReviewerAppendix(crlf).body),
    planHash(splitReviewerAppendix(lf).body),
  );
});

test("splitReviewerAppendix: a body-only edit changes the body hash only", () => {
  const before = splitReviewerAppendix(reviewedText());
  const after = splitReviewerAppendix(reviewedText(1, amendedBody()));

  assert.equal(after.appendix, before.appendix);
  assert.notEqual(after.body, before.body);
  assert.notEqual(planHash(after.body), planHash(before.body));
});
