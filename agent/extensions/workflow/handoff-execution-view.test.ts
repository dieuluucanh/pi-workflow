/**
 * Unit tests for the stage-2 execution chooser (`handoff-execution-view.ts`).
 *
 * This is the only module that turns an answer into a destination, so the
 * matrix below is the safety boundary: an approval is never implied here, and
 * an unknown/freeform/cancelled answer can never become direct Build.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  EXECUTION_BUILD_LABEL,
  EXECUTION_LATER_LABEL,
  EXECUTION_ORCHESTRATOR_LABEL,
  EXECUTION_QUESTION_HEADER,
  buildExecutionQuestion,
  describeExecutionChoice,
  executionChoiceFromResult,
  executionLabel,
} from "./handoff-execution-view.ts";
import type { QuestionnaireResult } from "./questionnaire-view.ts";

function answer(label: string, wasCustom = false): QuestionnaireResult {
  return {
    cancelled: false,
    answers: [{ question: "q", answer: label, wasCustom }],
  } as QuestionnaireResult;
}

test("the question names the plan, the decision id and that nothing ran", () => {
  const question = buildExecutionQuestion({
    planPath: ".pi/plans/2026-11-22-x.md",
    decisionId: "handoff-1234abcd",
    recommended: "orchestrator",
  });
  assert.equal(question.header, EXECUTION_QUESTION_HEADER);
  assert.match(question.question, /Plan approved/);
  const context = String(question.context);
  assert.ok(context.includes(".pi/plans/2026-11-22-x.md"));
  assert.ok(context.includes("handoff-1234abcd"));
  assert.ok(context.includes("this approved plan only"));
  assert.ok(context.includes("Nothing has run yet"));
});

test("the recommendation is the first row and is marked recommended", () => {
  const recommended = buildExecutionQuestion({
    planPath: "p",
    decisionId: "d",
    recommended: "build",
  });
  assert.equal(recommended.options[0]?.label, EXECUTION_BUILD_LABEL);
  assert.match(String(recommended.options[0]?.description), /recommended/);
  assert.equal(recommended.options[1]?.label, EXECUTION_ORCHESTRATOR_LABEL);
  assert.equal(recommended.options[2]?.label, EXECUTION_LATER_LABEL);

  const fallback = buildExecutionQuestion({ planPath: "p", decisionId: "d" });
  assert.equal(fallback.options[0]?.label, EXECUTION_ORCHESTRATOR_LABEL);
  assert.equal(executionLabel("orchestrator"), EXECUTION_ORCHESTRATOR_LABEL);
  assert.equal(executionLabel("build"), EXECUTION_BUILD_LABEL);
});

test("each exact row maps to its destination", () => {
  assert.deepEqual(executionChoiceFromResult(answer(EXECUTION_ORCHESTRATOR_LABEL)), {
    choice: "execute",
    destination: "orchestrator",
  });
  assert.deepEqual(executionChoiceFromResult(answer(EXECUTION_BUILD_LABEL)), {
    choice: "execute",
    destination: "build",
  });
});

test("cancel, later, freeform, unknown and malformed DEFER (never Build)", () => {
  const defer = { choice: "defer" };
  assert.deepEqual(executionChoiceFromResult(null), defer);
  assert.deepEqual(executionChoiceFromResult(undefined), defer);
  assert.deepEqual(executionChoiceFromResult({ cancelled: true, answers: [] }), defer);
  assert.deepEqual(executionChoiceFromResult(answer(EXECUTION_LATER_LABEL)), defer);
  assert.deepEqual(executionChoiceFromResult(answer("build")), defer);
  assert.deepEqual(executionChoiceFromResult(answer("Orchestrator")), defer);
  assert.deepEqual(executionChoiceFromResult(answer("something else")), defer);
  assert.deepEqual(executionChoiceFromResult(answer("", true)), defer);
  assert.deepEqual(executionChoiceFromResult(answer(EXECUTION_BUILD_LABEL, true)), defer);
  assert.deepEqual(executionChoiceFromResult("build" as never), defer);
  assert.deepEqual(executionChoiceFromResult({} as never), defer);
});

test("the recommendation never influences parsing", () => {
  // The same answer resolves the same destination regardless of context; the
  // recommendation is a UI hint seeded by the caller.
  assert.deepEqual(executionChoiceFromResult(answer(EXECUTION_ORCHESTRATOR_LABEL)), {
    choice: "execute",
    destination: "orchestrator",
  });
});

test("descriptions distinguish preparation from immediate execution", () => {
  assert.match(describeExecutionChoice("orchestrator"), /breakdown/);
  assert.match(describeExecutionChoice("orchestrator"), /before any Build child/);
  assert.match(describeExecutionChoice("build"), /Build mode/);
  assert.match(describeExecutionChoice("build"), /now/);
});
