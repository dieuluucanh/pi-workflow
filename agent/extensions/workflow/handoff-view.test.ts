/**
 * Pure unit tests for the native handoff decisions (`handoff-view.ts`).
 *
 * The plan text is printed into the transcript; the questionnaire only carries
 * the path, the reason and a scroll hint. These tests pin that split plus the
 * answer matrix (approve / feedback / freeform / cancel / malformed), because a
 * wrong mapping here is what would send an execute turn the user never asked
 * for.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  HANDOFF_APPROVE_BUILD_LABEL,
  HANDOFF_APPROVE_LABEL,
  HANDOFF_APPROVE_ORCHESTRATOR_LABEL,
  HANDOFF_FEEDBACK_LABEL,
  HANDOFF_PLAN_ENTRY_TYPE,
  HANDOFF_PLAN_MAX_CHARS,
  HANDOFF_QUESTION_HEADER,
  HANDOFF_SKIP_LABEL,
  buildHandoffQuestion,
  capHandoffPlanText,
  handoffChoiceFromResult,
  handoffReasonLabel,
} from "./handoff-view.ts";

test("HANDOFF_PLAN_ENTRY_TYPE is the durable transcript entry", () => {
  assert.equal(HANDOFF_PLAN_ENTRY_TYPE, "workflow-handoff-plan");
});

test("capHandoffPlanText keeps a small plan intact", () => {
  const plan = "# Plan\n\n1. Do the thing";
  const capped = capHandoffPlanText(plan, ".pi/plans/x.md");
  assert.equal(capped.truncated, false);
  assert.equal(capped.text, plan);

  const boundary = "x".repeat(HANDOFF_PLAN_MAX_CHARS);
  const atLimit = capHandoffPlanText(boundary, ".pi/plans/x.md");
  assert.equal(atLimit.truncated, false);
  assert.equal(atLimit.text.length, HANDOFF_PLAN_MAX_CHARS);
});

test("capHandoffPlanText bounds a huge plan and names the file", () => {
  const plan = "a".repeat(HANDOFF_PLAN_MAX_CHARS + 1);
  const capped = capHandoffPlanText(plan, ".pi/plans/huge.md");
  assert.equal(capped.truncated, true);
  assert.ok(capped.text.startsWith("a".repeat(100)));
  assert.ok(capped.text.length < plan.length + 200);
  assert.ok(capped.text.includes("plan truncated in transcript"));
  assert.ok(capped.text.includes(".pi/plans/huge.md"));
});

test("capHandoffPlanText tolerates a malformed entry", () => {
  assert.deepEqual(capHandoffPlanText(undefined, "p"), {
    text: "",
    truncated: false,
  });
  assert.deepEqual(capHandoffPlanText(null, "p"), {
    text: "",
    truncated: false,
  });
});

test("buildHandoffQuestion carries a short context, never the plan body", () => {
  const question = buildHandoffQuestion({
    planPath: ".pi/plans/2026-11-15-hf.md",
    reason: "aborted",
    verdict: "revise",
    findingCount: 2,
  });
  assert.equal(question.header, HANDOFF_QUESTION_HEADER);
  assert.equal(question.question, "Plan ready — approve it, or ask for changes?");
  assert.deepEqual(
    question.options.map((o) => o.label),
    [HANDOFF_APPROVE_LABEL, HANDOFF_FEEDBACK_LABEL, HANDOFF_SKIP_LABEL],
    "the plan question is destination-neutral",
  );
  const context = String(question.context ?? "");
  assert.ok(context.includes(".pi/plans/2026-11-15-hf.md"));
  assert.ok(context.includes("review skipped"));
  assert.ok(context.includes("revise"));
  assert.ok(context.includes("2 findings"));
  assert.ok(
    context.includes("scroll up"),
    "the context tells the user where the plan is",
  );
  assert.ok(
    !context.includes("Plan Steps"),
    "the plan body must not be pinned inside the modal",
  );
  assert.ok(
    /not execution/.test(context),
    "the question says approval is not execution",
  );
});

test("buildHandoffQuestion pluralizes and omits missing detail", () => {
  const one = buildHandoffQuestion({
    planPath: "p",
    reason: "reviewed",
    verdict: "approve",
    findingCount: 1,
  });
  assert.ok(String(one.context).includes("1 finding"));
  assert.ok(!String(one.context).includes("1 findings"));

  const bare = buildHandoffQuestion({ planPath: "", reason: "closed" });
  assert.ok(String(bare.context).includes("(no plan file)"));
  assert.ok(!String(bare.context).includes("Review:"));
});

test("handoffReasonLabel covers every reason", () => {
  const reasons = [
    "reviewed",
    "handoff",
    "aborted",
    "unavailable",
    "closed",
    "build-failed",
  ] as const;
  for (const reason of reasons) {
    assert.ok(handoffReasonLabel(reason).length > 0, reason);
  }
  assert.ok(handoffReasonLabel("build-failed").includes("Build"));
  assert.ok(handoffReasonLabel("handoff").includes("approve"));
});

test("handoffChoiceFromResult maps the approve row to a PLAN approval", () => {
  const result = {
    cancelled: false,
    answers: [
      { question: "q", answer: HANDOFF_APPROVE_LABEL, wasCustom: false },
    ],
  };
  assert.deepEqual(handoffChoiceFromResult(result), { choice: "approve" });
});

test("handoffChoiceFromResult maps the feedback row to refine", () => {
  const result = {
    cancelled: false,
    answers: [
      { question: "q", answer: `  ${HANDOFF_FEEDBACK_LABEL}  `, wasCustom: false },
    ],
  };
  assert.deepEqual(handoffChoiceFromResult(result), { choice: "refine" });
});

test("handoffChoiceFromResult treats freeform text as feedback", () => {
  const result = {
    cancelled: false,
    answers: [
      { question: "q", answer: "  add an export test  ", wasCustom: true },
    ],
  };
  assert.deepEqual(handoffChoiceFromResult(result), {
    choice: "refine",
    feedback: "add an export test",
  });
});

test("handoffChoiceFromResult dismisses cancel, empty and unknown answers", () => {
  assert.deepEqual(handoffChoiceFromResult(null), { choice: "dismiss" });
  assert.deepEqual(handoffChoiceFromResult(undefined), { choice: "dismiss" });
  assert.deepEqual(handoffChoiceFromResult({ cancelled: true, answers: [] }), {
    choice: "dismiss",
  });
  assert.deepEqual(
    handoffChoiceFromResult({
      cancelled: false,
      answers: [{ question: "q", answer: "something", wasCustom: false }],
    }),
    { choice: "dismiss" },
    "an unknown label never becomes execute",
  );
  assert.deepEqual(
    handoffChoiceFromResult({
      cancelled: false,
      answers: [{ question: "q", answer: "   ", wasCustom: true }],
    }),
    { choice: "dismiss" },
    "empty freeform text is not a refine",
  );
  assert.deepEqual(
    handoffChoiceFromResult({
      cancelled: false,
      answers: [{ question: "q", answer: HANDOFF_SKIP_LABEL, wasCustom: false }],
    }),
    { choice: "dismiss" },
  );
});

test("handoffChoiceFromResult tolerates a non-object host answer", () => {
  // A fake/legacy host may return a bare string; never treat it as execute.
  assert.deepEqual(handoffChoiceFromResult("refine" as never), {
    choice: "dismiss",
  });
  assert.deepEqual(handoffChoiceFromResult({} as never), {
    choice: "dismiss",
  });
  assert.deepEqual(
    handoffChoiceFromResult({ cancelled: false, answers: [] } as never),
    { choice: "dismiss" },
  );
});

// ── Approval is stage 1 only ─────────────────────────────────────────

test("native plan rows never carry an execution destination", () => {
  const question = buildHandoffQuestion({ planPath: "p", reason: "reviewed" });
  assert.equal(question.options.length, 3);
  assert.equal(question.options[0]?.label, HANDOFF_APPROVE_LABEL);
  assert.match(String(question.options[0]?.description), /choose Orchestrator \(in-process child per step\) or direct Build/);
  for (const option of question.options) {
    assert.doesNotMatch(
      option.label,
      /→ (Orchestrator|direct Build)/,
      "no destination-specific approval row",
    );
  }
});

test("legacy destination labels approve the PLAN only", () => {
  const answer = (label: string) =>
    handoffChoiceFromResult({
      cancelled: false,
      answers: [{ question: "q", answer: label, wasCustom: false }],
    });
  // Pre-split labels are still readable, but they must never imply a route.
  assert.deepEqual(answer(HANDOFF_APPROVE_ORCHESTRATOR_LABEL), { choice: "approve" });
  assert.deepEqual(answer(HANDOFF_APPROVE_BUILD_LABEL), { choice: "approve" });
  // A label that is only similar is never an approval.
  assert.deepEqual(answer("Approve plan → Build maybe"), { choice: "dismiss" });
});
