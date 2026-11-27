/**
 * Prompt-refinement quality evaluation harness (parity plan step 35).
 *
 * These tests exercise the *evaluation machinery*, not a claim that refinement
 * is semantically good. They prove:
 *
 *   - the frozen corpus loads and covers every required category;
 *   - the deterministic fake provider/tool run drives the real runtime and
 *     every case's named properties hold;
 *   - the graders are not vacuous: generic mutants are caught;
 *   - a live-model sample cannot start without explicit authorization;
 *   - reports keep fake and live evidence separate and human sign-off pending.
 *
 * There is deliberately no exact-string golden candidate here: only literals
 * the contract requires to be byte-identical are compared exactly.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  LIVE_EVAL_AUTHORIZATION_ENV,
  REFINEMENT_EVAL_MUTANTS,
  REFINEMENT_EVAL_VERSION,
  gradeRefinementOutput,
  loadRefinementEvalCorpus,
  renderRefinementEvalReport,
  resolveLiveEvalAuthorization,
  runRefinementEvalCorpus,
  type RefinementEvalCorpus,
  type RefinementEvalOutput,
} from "./prompt-refinement-eval.ts";

const HERE = import.meta.dirname;
const CORPUS_PATH = join(HERE, "fixtures", "prompt-refinement-cases.json");

function rawCorpus(): unknown {
  return JSON.parse(readFileSync(CORPUS_PATH, "utf8")) as unknown;
}

function loadCorpus(): RefinementEvalCorpus {
  const result = loadRefinementEvalCorpus(rawCorpus());
  assert.equal(result.ok, true, result.ok ? "" : result.errors.join("\n"));
  if (!result.ok) throw new Error("unreachable");
  return result.corpus;
}

function outputFrom(overrides: Partial<RefinementEvalOutput> = {}): RefinementEvalOutput {
  return {
    candidate: "",
    changeSummary: ["Fixture summary."],
    suggestions: [],
    language: "en",
    terminology: [],
    evidenceIds: [],
    disclosures: [],
    askedQuestions: 0,
    questionTexts: [],
    modelInput: ["text"],
    ...overrides,
  };
}

// ── Corpus ───────────────────────────────────────────────────────────

test("eval corpus loads, is versioned and covers every frozen category", () => {
  const corpus = loadCorpus();
  assert.equal(corpus.version, 2);
  assert.equal(corpus.promptVersion, 1);
  assert.equal(corpus.rubricVersion, 1);
  assert.equal(corpus.cases.length, 14);
  const categories = new Set<string>(corpus.cases.map((item) => item.category));
  for (const required of [
    "typo-heavy",
    "terminology-evidence",
    "distinct-terms",
    "multilingual",
    "mixed-language",
    "quoted-commands",
    "noncoding",
    "sparse",
    "no-repo",
    "ambiguous-terminology",
    "prompt-injection",
    "vision",
    "vision-unsupported",
    "long-context",
  ]) {
    assert.ok(categories.has(required), `corpus misses "${required}"`);
  }
});

test("eval corpus rejects unknown cases, wrong versions and missing categories", () => {
  const raw = rawCorpus() as Record<string, unknown>;
  assert.equal(
    loadRefinementEvalCorpus({ ...raw, promptVersion: 99 }).ok,
    false,
    "a corpus pinned to an unknown prompt version must be refused",
  );
  const cases = raw.cases as unknown[];
  const missing = loadRefinementEvalCorpus({ ...raw, cases: cases.slice(0, 1) });
  assert.equal(missing.ok, false);
  if (!missing.ok) {
    assert.ok(missing.errors.some((error) => error.includes("no \"")));
  }
  const badCase = loadRefinementEvalCorpus({
    ...raw,
    cases: [...cases, { id: "x", category: "not-a-category" }],
  });
  assert.equal(badCase.ok, false);
});

// ── Deterministic fake-provider run ──────────────────────────────────

test("fake provider/tool corpus run satisfies every deterministic property", async () => {
  const corpus = loadCorpus();
  const run = await runRefinementEvalCorpus({ corpus, mode: "fake" });
  assert.equal(run.version, REFINEMENT_EVAL_VERSION);
  assert.equal(run.mode, "fake");
  assert.equal(run.liveSampleStatus, "not-requested");
  assert.equal(run.cases.length, corpus.cases.length);
  assert.equal(
    run.deterministicOk,
    true,
    run.cases
      .filter((record) => !record.gradeOk)
      .map(
        (record) =>
          `${record.caseId}: ${record.failures
            .map((finding) => `${finding.code}: ${finding.message}`)
            .join("; ")}`,
      )
      .join("\n"),
  );
  assert.equal(
    run.mutantChecksOk,
    true,
    run.cases
      .flatMap((record) =>
        record.mutants
          .filter((mutant) => !mutant.detected)
          .map((mutant) => `${record.caseId}/${mutant.mutant}: expected ${mutant.expectedCode}`),
      )
      .join("\n"),
  );

  for (const record of run.cases) {
    assert.equal(record.mode, "fake");
    assert.equal(record.modelSource, "deterministic-scripted-model");
    assert.equal(record.usageSource, "scripted-provider-usage");
    assert.equal(record.humanReview.status, "pending-human-signoff");
    assert.ok(Number.isFinite(record.latencyMs) && record.latencyMs >= 0);
    assert.ok(record.usage.totalTokens > 0);
    assert.ok(record.candidateChars > 0);
    assert.ok(record.changeSummary.length > 0);
  }

  const sparse = run.cases.find((record) => record.caseId === "sparse-make-it-better");
  assert.ok(sparse);
  assert.ok(sparse!.questionRounds >= 1, "the sparse request must ask, not invent");

  const visionUnsupported = run.cases.find(
    (record) => record.caseId === "vision-unsupported-crash-dialog",
  );
  assert.ok(visionUnsupported);
  assert.ok(visionUnsupported!.disclosures.length > 0);
  assert.ok(
    visionUnsupported!.disclosures.some((note) => /image|screenshot/i.test(note)),
    "a text-only model must disclose the unreadable image",
  );

  const terminology = run.cases.find(
    (record) => record.caseId === "terminology-sub-session-to-child-session",
  );
  assert.ok(terminology);
  assert.ok(terminology!.gradeOk);
});

test("fake run is deterministic for grades, questions and candidate size", async () => {
  const corpus = loadCorpus();
  const first = await runRefinementEvalCorpus({ corpus, mode: "fake" });
  const second = await runRefinementEvalCorpus({ corpus, mode: "fake" });
  const shape = (run: typeof first) =>
    run.cases.map((record) => ({
      caseId: record.caseId,
      gradeOk: record.gradeOk,
      candidateChars: record.candidateChars,
      questions: record.askedQuestionTexts,
      failures: record.failures.map((finding) => finding.code),
    }));
  assert.deepEqual(shape(first), shape(second));
});

test("guarded cases keep injection text out of candidates and grading", async () => {
  const corpus = loadCorpus();
  const run = await runRefinementEvalCorpus({
    corpus,
    mode: "fake",
    caseIds: ["prompt-injection-in-repo-file", "ambiguous-sub-session-versus-child-session"],
  });
  assert.equal(run.cases.length, 2);
  const injection = run.cases.find((record) => record.caseId === "prompt-injection-in-repo-file");
  assert.ok(injection);
  assert.ok(injection!.gradeOk, JSON.stringify(injection!.failures));
  const ambiguous = run.cases.find(
    (record) => record.caseId === "ambiguous-sub-session-versus-child-session",
  );
  assert.ok(ambiguous);
  assert.ok(ambiguous!.questionRounds >= 1);
});

// ── Grader self-checks ───────────────────────────────────────────────

test("graders catch a dropped requirement, forbidden phrase and unconsented idea", () => {
  const corpus = loadCorpus();
  const quoted = corpus.cases.find((item) => item.id === "quoted-commands-regression-commit")!;
  const dropped = gradeRefinementOutput(
    quoted,
    outputFrom({
      candidate:
        "Add a regression test and then commit the change. Do not change the command.",
    }),
  );
  assert.equal(dropped.ok, false);
  assert.ok(dropped.failures.some((finding) => finding.code === "literal-dropped"));

  const noncoding = corpus.cases.find((item) => item.id === "noncoding-release-slip-email")!;
  const forbidden = gradeRefinementOutput(
    noncoding,
    outputFrom({
      candidate:
        "# Purpose\n\nWrite a warm email about the release slipping one week to Friday because of budget pressure.",
    }),
  );
  assert.equal(forbidden.ok, false);
  assert.ok(forbidden.failures.some((finding) => finding.code === "forbidden-phrase"));

  const unconsented = gradeRefinementOutput(
    quoted,
    outputFrom({
      candidate:
        'Add a regression test that runs `npm test -- --test-name-pattern "prompt refinement"`.',
      suggestions: ["Also add a CI badge."],
    }),
  );
  assert.equal(unconsented.ok, false);
  assert.ok(
    unconsented.failures.some((finding) => finding.code === "unconsented-suggestion"),
  );
});

test("graders flag invented literals and execution claims", () => {
  const corpus = loadCorpus();
  const noRepo = corpus.cases.find((item) => item.id === "no-repo-volunteer-talk")!;
  const invented = gradeRefinementOutput(
    noRepo,
    outputFrom({
      candidate:
        "Plan a 30-minute talk about the tool library and borrowing. Use `src/invented-eval-module.ts` for the outline.",
    }),
  );
  assert.equal(invented.ok, false);
  assert.ok(invented.failures.some((finding) => finding.code === "invented-literal"));

  const claims = gradeRefinementOutput(
    noRepo,
    outputFrom({
      candidate: "Plan a 30-minute talk about the tool library and borrowing.",
      changeSummary: ["I wrote the talk and booked the room."],
    }),
  );
  assert.equal(claims.ok, false);
  assert.ok(claims.failures.some((finding) => finding.code === "execution-claim"));
});

test("every declared mutant premise is exercised by at least one corpus case", () => {
  const corpus = loadCorpus();
  for (const mutant of REFINEMENT_EVAL_MUTANTS) {
    assert.ok(
      corpus.cases.some((item) => mutant.applies(item)),
      `mutant "${mutant.id}" never applies to the corpus`,
    );
  }
});

test("rubric language retention separates monolingual and mixed cases", () => {
  const corpus = loadCorpus();
  const vietnamese = corpus.cases.find(
    (item) => item.id === "multilingual-vietnamese-default-mode",
  )!;
  const translated = gradeRefinementOutput(
    vietnamese,
    outputFrom({
      candidate:
        "Fix `resolveDefaultModeModel`: refuse when there is no snapshot instead of using the role model. Keep `/prompt-model reset` and do not rename configuration keys.",
      language: "en",
    }),
  );
  assert.equal(translated.ok, false);
  assert.ok(
    translated.failures.some((finding) => finding.code === "language-not-retained"),
  );

  const mixed = corpus.cases.find((item) => item.id === "mixed-language-config-trust")!;
  const forced = gradeRefinementOutput(
    mixed,
    outputFrom({
      candidate:
        "In `prompt-refinement-config.ts`, ignore the project override when the project is untrusted and use the global setting instead. Keep the inherit sentinel and the provider/model parsing.",
      language: "en",
    }),
  );
  assert.equal(forced.ok, false);
  assert.ok(forced.failures.some((finding) => finding.code === "language-not-retained"));
});

// ── Live authorization and reporting ─────────────────────────────────

test("a live model sample requires explicit authorization", () => {
  const refused = resolveLiveEvalAuthorization({}, true);
  assert.equal(refused.authorized, false);
  assert.match(refused.reason, new RegExp(LIVE_EVAL_AUTHORIZATION_ENV));

  const notRequested = resolveLiveEvalAuthorization(
    { [LIVE_EVAL_AUTHORIZATION_ENV]: "1" },
    false,
  );
  assert.equal(notRequested.authorized, false);

  const allowed = resolveLiveEvalAuthorization(
    { [LIVE_EVAL_AUTHORIZATION_ENV]: "1" },
    true,
  );
  assert.equal(allowed.authorized, true);
});

test("fake report keeps evidence classes separate and human sign-off pending", async () => {
  const corpus = loadCorpus();
  const run = await runRefinementEvalCorpus({ corpus, mode: "fake" });
  const report = renderRefinementEvalReport(run);
  assert.match(report, /deterministic fake provider/i);
  assert.match(report, /not evidence of semantic quality/i);
  assert.match(report, /pending-human-signoff|pending/i);
  assert.match(report, /human rubric sign-off is \*\*pending\*\*/i);
  assert.match(report, /never asserts semantic equivalence|not evidence of semantic quality/i);
  assert.doesNotMatch(report, /guaranteed semantic equivalence/i);
  assert.ok(report.includes("prompt-injection-in-repo-file"));
  assert.ok(report.includes("vision-unsupported-crash-dialog"));
  assert.ok(report.includes("long-context-many-constraints"));
});
