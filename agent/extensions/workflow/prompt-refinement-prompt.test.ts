/**
 * Workflow Extension — prompt-refinement prompt/schema/rubric tests.
 *
 * Run with: npm test   (node --test, type-stripping — no build step)
 *
 * These tests protect the v1 contracts:
 *   - the system prompt is versioned, deterministic, provider-neutral and
 *     states every non-negotiable requirement;
 *   - `input.v1` / `result.v1` accept valid shapes and refuse wrong versions,
 *     unknown fields, empty candidates, unconsented suggestions and
 *     unsupported terminology substitutions;
 *   - one outer transport fence is stripped without touching candidate fences;
 *   - the rubric is frozen, sums to 100 and cannot pass a critical regression;
 *   - the fixture corpus covers every required category and its terminology
 *     expectations reference real evidence.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import {
  REFINEMENT_INPUT_SCHEMA_ID,
  PROMPT_REFINEMENT_INPUT_SCHEMA_VERSION,
  PROMPT_REFINEMENT_PROMPT_VERSION,
  REFINEMENT_RESULT_SCHEMA_ID,
  PROMPT_REFINEMENT_RESULT_SCHEMA_VERSION,
  PROMPT_REFINEMENT_RUBRIC_VERSION,
  REFINEMENT_CASE_CATEGORIES,
  REFINEMENT_EVIDENCE_KINDS,
  REFINEMENT_INPUT_JSON_SCHEMA,
  REFINEMENT_PROMPT_REQUIREMENTS,
  REFINEMENT_RESULT_JSON_SCHEMA,
  REFINEMENT_RUBRIC_DIMENSIONS,
  REFINEMENT_RUBRIC_DIMENSION_IDS,
  REFINEMENT_WIRE_LIMITS,
  RUBRIC_PASS_SCORE,
  RUBRIC_SCORE_SCALE,
  buildRefinementSystemPrompt,
  evaluateRefinementRubric,
  parseRefinementResultText,
  stripRefinementResultWrapper,
  validateRefinementEvaluationCase,
  validateRefinementInput,
  validateRefinementResult,
  type RefinementResult,
} from "./prompt-refinement-prompt.ts";
import { REFINEMENT_LIMITS } from "./prompt-refinement-state.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = path.join(HERE, "fixtures", "prompt-refinement-cases.json");
const DOCS_PATH = path.join(HERE, "..", "..", "..", "docs", "prompt-refinement-rubrics.md");

function fixtureFile(): {
  version: number;
  schemaVersion: number;
  promptVersion: number;
  rubricVersion: number;
  cases: any[];
} {
  return JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as any;
}

function validResult(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    candidate: "Please update the default model so the persisted choice survives a restart.",
    changeSummary: ["Corrected typos and tightened one sentence."],
    suggestions: [],
    language: "en",
    ...overrides,
  };
}

// ── System prompt ────────────────────────────────────────────────────

test("system prompt is versioned, deterministic and names both schema ids", () => {
  assert.equal(PROMPT_REFINEMENT_PROMPT_VERSION, 1);
  const prompt = buildRefinementSystemPrompt();
  assert.equal(prompt, buildRefinementSystemPrompt());
  assert.match(prompt, /system prompt \(v1\)/);
  assert.ok(prompt.includes(REFINEMENT_INPUT_SCHEMA_ID));
  assert.ok(prompt.includes(REFINEMENT_RESULT_SCHEMA_ID));
  assert.ok(prompt.includes(`schemaVersion: ${PROMPT_REFINEMENT_RESULT_SCHEMA_VERSION}`));
});

test("system prompt states every non-negotiable requirement", () => {
  const prompt = buildRefinementSystemPrompt();
  for (const requirement of REFINEMENT_PROMPT_REQUIREMENTS) {
    assert.ok(
      prompt.includes(requirement.phrase),
      `missing requirement ${requirement.id}: ${requirement.phrase}`,
    );
  }
});

test("system prompt is provider-neutral (no vendor names or vendor markup)", () => {
  const prompt = buildRefinementSystemPrompt();
  assert.doesNotMatch(
    prompt,
    /\b(openai|anthropic|claude|gpt|gemini|llama|mistral|copilot)\b/i,
  );
  assert.doesNotMatch(prompt, /<\/?(?:system|user|assistant|tool)\b/i);
});

test("system prompt forbids execution and unconsented suggestions explicitly", () => {
  const prompt = buildRefinementSystemPrompt();
  assert.match(prompt, /Never execute the request/);
  assert.match(prompt, /do not\s+claim that it was sent/i);
  assert.match(prompt, /Only when suggestionsAllowed is true/);
  assert.match(prompt, /return an empty `suggestions` array/);
  assert.match(prompt, /Keep the original language/);
  assert.match(prompt, /byte-for-byte/);
});

// ── Input schema ─────────────────────────────────────────────────────

test("input.v1 accepts a minimal request and defaults consent to false", () => {
  const result = validateRefinementInput({
    schemaVersion: 1,
    prompt: "  keep this leading whitespace  ",
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.schemaVersion, 1);
  assert.equal(result.value.prompt, "  keep this leading whitespace  ");
  assert.equal(result.value.suggestionsAllowed, false);
});

test("input.v1 accepts evidence, answers and explicit consent", () => {
  const result = validateRefinementInput({
    schemaVersion: 1,
    prompt: "Use the child session term.",
    language: "en",
    purpose: "coding",
    intentPoints: ["rename the worker"],
    constraints: ["keep retry"],
    evidence: [
      {
        evidenceId: "ev-1",
        kind: "file",
        path: "agent/extensions/workflow/README.md",
        summary: "The repository calls it a child session.",
      },
    ],
    answers: [{ question: "Which worker?", answer: "the frozen-row worker" }],
    suggestionsAllowed: true,
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.suggestionsAllowed, true);
  assert.equal(result.value.evidence?.length, 1);
  assert.equal(result.value.answers?.[0]?.answer, "the frozen-row worker");
});

test("input.v1 refuses wrong version, unknown fields and unbounded content", () => {
  const cases: Array<[string, unknown]> = [
    ["wrong version", { schemaVersion: 2, prompt: "x" }],
    ["missing version", { prompt: "x" }],
    ["empty prompt", { schemaVersion: 1, prompt: "   " }],
    ["oversized prompt", {
      schemaVersion: 1,
      prompt: "x".repeat(REFINEMENT_LIMITS.originalText + 1),
    }],
    ["unknown field", { schemaVersion: 1, prompt: "x", injected: true }],
    ["non-boolean consent", { schemaVersion: 1, prompt: "x", suggestionsAllowed: "yes" }],
    ["too many intent points", {
      schemaVersion: 1,
      prompt: "x",
      intentPoints: Array.from({ length: REFINEMENT_LIMITS.intentPoints + 1 }, () => "p"),
    }],
  ];
  for (const [label, value] of cases) {
    const result = validateRefinementInput(value);
    assert.equal(result.ok, false, label);
  }
});

test("input.v1 refuses duplicate or malformed evidence", () => {
  const duplicate = validateRefinementInput({
    schemaVersion: 1,
    prompt: "x",
    evidence: [
      { evidenceId: "ev-1", kind: "file", summary: "a" },
      { evidenceId: "ev-1", kind: "search", summary: "b" },
    ],
  });
  assert.equal(duplicate.ok, false);

  const badKind = validateRefinementInput({
    schemaVersion: 1,
    prompt: "x",
    evidence: [{ evidenceId: "ev-1", kind: "guess", summary: "a" }],
  });
  assert.equal(badKind.ok, false);

  const extraField = validateRefinementInput({
    schemaVersion: 1,
    prompt: "x",
    evidence: [{ evidenceId: "ev-1", kind: "file", summary: "a", confidence: 1 }],
  });
  assert.equal(extraField.ok, false);
});

// ── Result schema ────────────────────────────────────────────────────

test("result.v1 accepts a valid result with terminology and preserved literals", () => {
  const result = validateRefinementResult(
    validResult({
      terminology: [
        {
          from: "sub-session",
          to: "child session",
          evidenceId: "ev-orchestrator-child",
          reason: "Repository wording.",
        },
      ],
      preservedLiterals: ["`/prompt-model inherit`"],
    }),
    { evidenceIds: new Set(["ev-orchestrator-child"]) },
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.terminology?.[0]?.to, "child session");
  assert.deepEqual(result.value.preservedLiterals, ["`/prompt-model inherit`"]);
});

test("result.v1 refuses wrong versions, unknown fields and invalid prose", () => {
  const cases: Array<[string, unknown, Record<string, unknown>?]> = [
    ["wrong version", validResult({ schemaVersion: 2 })],
    ["unknown field", validResult({ executed: true })],
    ["empty candidate", validResult({ candidate: "   " })],
    ["missing language", validResult({ language: undefined })],
    ["empty summary", validResult({ changeSummary: [] })],
    ["bad summary type", validResult({ changeSummary: "changed" })],
    ["too long candidate", validResult({ candidate: "x".repeat(REFINEMENT_LIMITS.candidateText + 1) })],
    ["suggestion without consent", validResult({ suggestions: ["Also update docs"] })],
    [
      "candidate too long for caller limit",
      validResult({ candidate: "x".repeat(20) }),
      { maxCandidateChars: 10 },
    ],
  ];
  for (const [label, value, options] of cases) {
    assert.equal(validateRefinementResult(value, options).ok, false, label);
  }
});

test("result.v1 accepts suggestions only with explicit consent", () => {
  const withSuggestion = validResult({ suggestions: ["Consider adding a regression test."] });
  assert.equal(validateRefinementResult(withSuggestion).ok, false);
  const consented = validateRefinementResult(withSuggestion, {
    suggestionsAllowed: true,
  });
  assert.equal(consented.ok, true);
});

test("result.v1 refuses unsupported terminology substitutions", () => {
  const missingEvidence = validateRefinementResult(
    validResult({ terminology: [{ from: "sub-session", to: "child session" }] }),
  );
  assert.equal(missingEvidence.ok, false);

  const unknownEvidence = validateRefinementResult(
    validResult({
      terminology: [
        { from: "sub-session", to: "child session", evidenceId: "ev-missing" },
      ],
    }),
    { evidenceIds: new Set(["ev-real"]) },
  );
  assert.equal(unknownEvidence.ok, false);

  const noop = validateRefinementResult(
    validResult({
      terminology: [
        { from: "child session", to: "child session", evidenceId: "ev-real" },
      ],
    }),
    { evidenceIds: new Set(["ev-real"]) },
  );
  assert.equal(noop.ok, false);
});

test("result.v1 can validate terminology without evidence when explicitly allowed", () => {
  const result = validateRefinementResult(
    validResult({ terminology: [{ from: "e.g.", to: "for example" }] }),
    { requireTerminologyEvidence: false },
  );
  assert.equal(result.ok, true);
});

// ── Parsing / transport wrappers ─────────────────────────────────────

test("result parsing accepts plain and single-fenced JSON", () => {
  const result = validResult();
  const json = JSON.stringify(result);
  assert.equal(parseRefinementResultText(json).ok, true);
  assert.equal(parseRefinementResultText("```json\n" + json + "\n```").ok, true);
  assert.equal(parseRefinementResultText("```\n" + json + "\n```").ok, true);
});

test("wrapper stripping removes only one outer fence and preserves candidate fences", () => {
  const candidate = "```bash\nnpm test\n```";
  const json = JSON.stringify(validResult({ candidate }));
  const parsed = parseRefinementResultText("```json\n" + json + "\n```");
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.value.candidate, candidate);

  const inner = "```json\n" + json + "\n```";
  assert.equal(stripRefinementResultWrapper(inner), json);
  assert.equal(stripRefinementResultWrapper(json), json);
});

test("result parsing refuses invalid JSON and populated unknown fields", () => {
  assert.equal(parseRefinementResultText("not json").ok, false);
  assert.equal(parseRefinementResultText("").ok, false);
  assert.equal(parseRefinementResultText(42).ok, false);
  assert.equal(
    parseRefinementResultText(JSON.stringify(validResult({ extra: "field" }))).ok,
    false,
  );
});

// ── JSON Schema descriptors ──────────────────────────────────────────

test("JSON schemas are closed, versioned and aligned with the state limits", () => {
  const input = REFINEMENT_INPUT_JSON_SCHEMA as any;
  const result = REFINEMENT_RESULT_JSON_SCHEMA as any;

  assert.equal(input.$id, REFINEMENT_INPUT_SCHEMA_ID);
  assert.equal(result.$id, REFINEMENT_RESULT_SCHEMA_ID);
  assert.equal(input.properties.schemaVersion.const, PROMPT_REFINEMENT_INPUT_SCHEMA_VERSION);
  assert.equal(result.properties.schemaVersion.const, PROMPT_REFINEMENT_RESULT_SCHEMA_VERSION);
  assert.equal(input.additionalProperties, false);
  assert.equal(result.additionalProperties, false);
  assert.deepEqual(input.required.sort(), ["prompt", "schemaVersion"]);
  assert.deepEqual(
    result.required.sort(),
    ["candidate", "changeSummary", "language", "schemaVersion", "suggestions"],
  );

  assert.equal(input.properties.prompt.maxLength, REFINEMENT_LIMITS.originalText);
  assert.equal(input.properties.evidence.maxItems, REFINEMENT_LIMITS.evidence);
  assert.equal(input.properties.answers.maxItems, REFINEMENT_LIMITS.answers);
  assert.equal(result.properties.candidate.maxLength, REFINEMENT_LIMITS.candidateText);
  assert.equal(result.properties.changeSummary.maxItems, REFINEMENT_LIMITS.changeSummary);
  assert.equal(result.properties.suggestions.maxItems, REFINEMENT_LIMITS.suggestions);
  assert.equal(
    result.properties.terminology.maxItems,
    REFINEMENT_WIRE_LIMITS.terminologyChanges,
  );
  assert.deepEqual(
    input.properties.evidence.items.properties.kind.enum,
    [...REFINEMENT_EVIDENCE_KINDS],
  );
});

// ── Rubric ───────────────────────────────────────────────────────────

test("rubric v1 is complete, weighted to 100 and declares critical floors", () => {
  assert.equal(PROMPT_REFINEMENT_RUBRIC_VERSION, 1);
  assert.equal(REFINEMENT_RUBRIC_DIMENSIONS.length, 9);
  assert.equal(new Set(REFINEMENT_RUBRIC_DIMENSION_IDS).size, 9);
  assert.equal(
    REFINEMENT_RUBRIC_DIMENSIONS.reduce((sum, dimension) => sum + dimension.weight, 0),
    100,
  );
  const critical = REFINEMENT_RUBRIC_DIMENSIONS.filter((dimension) => dimension.critical);
  assert.ok(critical.length >= 6);
  for (const dimension of REFINEMENT_RUBRIC_DIMENSIONS) {
    assert.ok(dimension.minScore >= RUBRIC_SCORE_SCALE.min);
    assert.ok(dimension.minScore <= RUBRIC_SCORE_SCALE.max);
    assert.ok(dimension.criteria.length > 0);
  }
});

test("rubric passes only a high weighted score with every critical floor met", () => {
  const perfect = Object.fromEntries(
    REFINEMENT_RUBRIC_DIMENSIONS.map((dimension) => [dimension.id, 4]),
  );
  const pass = evaluateRefinementRubric(perfect);
  assert.equal(pass.pass, true);
  assert.equal(pass.score, 100);

  const criticalRegression = { ...perfect, non_execution: 2 };
  const failed = evaluateRefinementRubric(criticalRegression);
  assert.equal(failed.pass, false);
  assert.ok(failed.issues.some((issue) => issue.includes("non_execution")));

  const missing = { ...perfect };
  delete (missing as Record<string, number>).language_retention;
  const missingResult = evaluateRefinementRubric(missing);
  assert.equal(missingResult.pass, false);

  const unknown = evaluateRefinementRubric({ ...perfect, invented_dimension: 4 });
  assert.equal(unknown.pass, false);

  const nonInteger = evaluateRefinementRubric({ ...perfect, conciseness: 3.5 });
  assert.equal(nonInteger.pass, false);

  const lowTotal = Object.fromEntries(
    REFINEMENT_RUBRIC_DIMENSIONS.map((dimension) => [dimension.id, 2]),
  );
  const low = evaluateRefinementRubric(lowTotal);
  assert.equal(low.pass, false);
  assert.ok(low.score < RUBRIC_PASS_SCORE);
});

// ── Evaluation corpus ────────────────────────────────────────────────

test("fixture corpus is versioned, unique and covers every required category", () => {
  const file = fixtureFile();
  // corpus v2 added no-repo/ambiguous/prompt-injection/vision/long-context
  // cases; the input/result schema, prompt and rubric versions are unchanged.
  assert.equal(file.version, 2);
  assert.equal(file.schemaVersion, PROMPT_REFINEMENT_INPUT_SCHEMA_VERSION);
  assert.equal(file.promptVersion, PROMPT_REFINEMENT_PROMPT_VERSION);
  assert.equal(file.rubricVersion, PROMPT_REFINEMENT_RUBRIC_VERSION);

  const ids = new Set<string>();
  for (const raw of file.cases) {
    const result = validateRefinementEvaluationCase(raw);
    assert.equal(result.ok, true, `invalid fixture ${String((raw as any)?.id)}`);
    if (!result.ok) continue;
    assert.ok(!ids.has(result.value.id), `duplicate fixture id ${result.value.id}`);
    ids.add(result.value.id);
    assert.ok(result.value.humanReview, `${result.value.id} needs humanReview`);
    assert.equal(result.value.input.schemaVersion, 1);
  }

  const categories = new Set(file.cases.map((item: any) => item.category));
  assert.deepEqual(
    [...categories].sort(),
    [...REFINEMENT_CASE_CATEGORIES].sort(),
  );
});

test("fixture corpus covers the evaluation dimensions required by plan step 35", () => {
  const raw = fixtureFile();
  const byCategory = new Map<string, any[]>();
  for (const item of raw.cases) {
    const list = byCategory.get(item.category) ?? [];
    list.push(item);
    byCategory.set(item.category, list);
  }
  for (const required of [
    "no-repo",
    "ambiguous-terminology",
    "prompt-injection",
    "vision",
    "vision-unsupported",
    "long-context",
  ]) {
    assert.ok(byCategory.has(required), `missing ${required} case`);
  }

  const ambiguous = byCategory.get("ambiguous-terminology")![0];
  assert.equal(ambiguous.expectations.expectsClarification, true);
  assert.ok(ambiguous.expectations.mustPreserve.includes("sub-session"));

  const injection = byCategory.get("prompt-injection")![0];
  assert.ok(
    injection.input.evidence[0].summary.includes("SYSTEM OVERRIDE"),
    "the injection case must actually contain an injected instruction",
  );
  assert.ok(injection.expectations.mustNotContain.includes("rm -rf"));
  assert.equal(injection.expectations.expectsClarification, false);

  const visionUnsupported = byCategory.get("vision-unsupported")![0];
  assert.equal(visionUnsupported.expectations.expectsClarification, true);

  const longContext = byCategory.get("long-context")![0];
  assert.ok(longContext.input.prompt.length > 2_000);
  assert.ok(longContext.input.evidence.length >= 6);
  assert.ok(longContext.input.constraints.length >= 12);
  assert.equal(longContext.expectations.expectsClarification, false);
});

test("fixture corpus encodes the required terminology and literal cases", () => {
  const cases = new Map<string, any>(
    fixtureFile().cases.map((item: any) => [item.id, item]),
  );

  const terminology = cases.get("terminology-sub-session-to-child-session");
  assert.ok(terminology);
  assert.match(terminology.input.prompt, /sub-session/);
  assert.ok(
    terminology.input.evidence.some(
      (item: any) => item.summary.includes("child session") && item.summary.includes("in-process"),
    ),
  );
  assert.deepEqual(terminology.expectations.expectedTerminology, [
    {
      from: "sub-session",
      to: "child session",
      evidenceId: "ev-orchestrator-child",
    },
  ]);
  assert.ok(terminology.expectations.mustNotContain.includes("sub-session"));

  const distinct = cases.get("distinct-session-child-subagent");
  assert.ok(distinct);
  assert.deepEqual(distinct.expectations.mustPreserveDistinctTerms, [
    "Pi session",
    "child session",
    "subagent",
  ]);
  assert.ok(distinct.expectations.mustNotContain.includes("sub-session"));

  const quoted = cases.get("quoted-commands-regression-commit");
  assert.ok(quoted);
  assert.ok(
    quoted.expectations.mustPreserve.includes(
      '`npm test -- --test-name-pattern "prompt refinement"`',
    ),
  );
  assert.ok(
    quoted.expectations.mustPreserve.includes(
      '`git commit -m "fix(workflow): keep drafts on refine"`',
    ),
  );
  assert.ok(quoted.input.prompt.includes("--test-name-pattern"));

  const typo = cases.get("typo-heavy-default-model");
  assert.ok(typo);
  assert.ok(typo.expectations.mustPreserve.includes("/prompt-model inherit"));

  const noncoding = cases.get("noncoding-release-slip-email");
  assert.ok(noncoding);
  assert.equal(noncoding.input.purpose, "writing");
  assert.ok(noncoding.expectations.mustNotContain.includes("because"));
  assert.ok(noncoding.input.suggestionsAllowed);

  const sparse = cases.get("sparse-make-it-better");
  assert.ok(sparse);
  assert.equal(sparse.expectations.expectsClarification, true);

  const multilingual = cases.get("multilingual-vietnamese-default-mode");
  assert.ok(multilingual);
  assert.equal(multilingual.expectations.preserveLanguage, "vi");
  const mixed = cases.get("mixed-language-config-trust");
  assert.ok(mixed);
  assert.equal(mixed.expectations.preserveLanguage, "vi+en");

  const consentValues = new Set(
    [...cases.values()].map((item) => item.input.suggestionsAllowed),
  );
  assert.deepEqual([...consentValues].sort(), [false, true]);
});

test("evaluation case validation refuses unsupported expectations", () => {
  const base = fixtureFile().cases[1];

  const badCategory = JSON.parse(JSON.stringify(base));
  badCategory.category = "vibes";
  assert.equal(validateRefinementEvaluationCase(badCategory).ok, false);

  const missingEvidence = JSON.parse(JSON.stringify(base));
  missingEvidence.expectations.expectedTerminology[0].evidenceId = "ev-missing";
  assert.equal(validateRefinementEvaluationCase(missingEvidence).ok, false);

  const loweredCritical = JSON.parse(JSON.stringify(base));
  loweredCritical.expectations.rubricMinimums = { non_execution: 1 };
  assert.equal(validateRefinementEvaluationCase(loweredCritical).ok, false);

  const unknownExpectation = JSON.parse(JSON.stringify(base));
  unknownExpectation.expectations.autoPass = true;
  assert.equal(validateRefinementEvaluationCase(unknownExpectation).ok, false);
});

test("rubric documentation names every frozen dimension", () => {
  const doc = readFileSync(DOCS_PATH, "utf8");
  assert.match(doc, /Rubric version:\*\* 1/);
  assert.match(doc, /Pass rule:/);
  for (const dimension of REFINEMENT_RUBRIC_DIMENSIONS) {
    assert.ok(doc.includes(`\`${dimension.id}\``), `docs missing ${dimension.id}`);
    assert.ok(doc.includes(dimension.title), `docs missing title ${dimension.title}`);
  }
});

test("a schema-valid result can satisfy the rubric without executing anything", () => {
  const result = validateRefinementResult(validResult());
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const scores = Object.fromEntries(
    REFINEMENT_RUBRIC_DIMENSIONS.map((dimension) => [dimension.id, 4]),
  );
  assert.equal(evaluateRefinementRubric(scores).pass, true);
  assert.equal((result.value as RefinementResult).suggestions.length, 0);
});
