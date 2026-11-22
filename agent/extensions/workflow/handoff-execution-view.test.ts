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
  });
  assert.equal(question.header, EXECUTION_QUESTION_HEADER);
  assert.match(question.question, /Plan approved/);
  const context = String(question.context);
  assert.ok(context.includes(".pi/plans/2026-11-22-x.md"));
  assert.ok(context.includes("handoff-1234abcd"));
  assert.ok(context.includes("this approved plan only"));
  assert.ok(context.includes("Nothing has run yet"));
});

test("both destinations are first-class and neither is marked recommended", () => {
  const question = buildExecutionQuestion({ planPath: "p", decisionId: "d" });
  assert.equal(question.options[0]?.label, EXECUTION_BUILD_LABEL);
  assert.equal(question.options[1]?.label, EXECUTION_ORCHESTRATOR_LABEL);
  assert.equal(question.options[2]?.label, EXECUTION_LATER_LABEL);
  assert.doesNotMatch(JSON.stringify(question.options), /recommended/i);
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

test("the chooser never preselects a destination", () => {
  // The same answer resolves the same destination regardless of context; there
  // is no saved recommendation to seed it.
  assert.deepEqual(executionChoiceFromResult(answer(EXECUTION_ORCHESTRATOR_LABEL)), {
    choice: "execute",
    destination: "orchestrator",
  });
});

test("descriptions distinguish in-session Build from delegated Orchestrator", () => {
  assert.match(describeExecutionChoice("orchestrator"), /TODO row per step/);
  assert.match(describeExecutionChoice("orchestrator"), /delegate/);
  assert.match(describeExecutionChoice("build"), /Build mode/);
  assert.match(describeExecutionChoice("build"), /implement/);
});
