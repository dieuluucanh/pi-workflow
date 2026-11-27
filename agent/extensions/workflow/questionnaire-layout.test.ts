#!/usr/bin/env node
/**
 * Unit tests for the pure questionnaire viewport/scroll helpers.
 * Run: node --test questionnaire-layout.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  QUESTIONNAIRE_MAX_FRACTION,
  QUESTIONNAIRE_MAX_TOTAL_ROWS,
  QUESTIONNAIRE_OVERLAY_MAX_HEIGHT,
  computeQuestionnaireBudget,
  createScrollPane,
  formatScrollPosition,
  keepRangeVisible,
  maxScrollTop,
  parseWheelScroll,
  previewTextLines,
  questionnaireMaxRows,
  scrollPaneBy,
  scrollPaneTo,
  updateScrollPane,
  type ScrollPane,
} from "./questionnaire-layout.ts";

function pane(
  contentHeight: number,
  viewportHeight: number,
  scrollTop = 0,
): ScrollPane {
  return { contentHeight, viewportHeight, scrollTop };
}

// ── max rows / overlay contract ─────────────────────────────────────

test("questionnaireMaxRows stays inside the overlay's 80% cap", () => {
  assert.equal(QUESTIONNAIRE_MAX_FRACTION, 0.8);
  assert.equal(QUESTIONNAIRE_OVERLAY_MAX_HEIGHT, "80%");
  assert.equal(QUESTIONNAIRE_MAX_TOTAL_ROWS, 32);

  for (const rows of [1, 2, 4, 5, 8, 10, 12, 16, 20, 24, 30, 40, 60, 100]) {
    const max = questionnaireMaxRows(rows);
    const overlayMax = Math.max(1, Math.floor(rows * 0.8));
    assert.ok(max >= 1, `rows=${rows}: at least one line`);
    assert.ok(
      max <= overlayMax,
      `rows=${rows}: ${max} must not exceed overlay ${overlayMax}`,
    );
    assert.ok(max <= QUESTIONNAIRE_MAX_TOTAL_ROWS);
  }

  assert.equal(questionnaireMaxRows(24), 18);
  assert.equal(questionnaireMaxRows(30), 23);
  assert.equal(questionnaireMaxRows(40), 31);
  assert.equal(questionnaireMaxRows(60), 32);
  assert.equal(questionnaireMaxRows(10), 7);
  assert.equal(questionnaireMaxRows(8), 5);
  assert.equal(questionnaireMaxRows(0), 18);
  assert.equal(questionnaireMaxRows(Number.NaN), 18);
});

// ── budget allocation ───────────────────────────────────────────────

test("budget: long question with few options keeps every option visible", () => {
  const budget = computeQuestionnaireBudget({
    termRows: 24,
    topHeight: 1,
    pinnedHeight: 0,
    bottomHeight: 3,
    questionContentHeight: 200,
    optionsContentHeight: 6,
  });
  assert.equal(budget.options, 6);
  assert.equal(budget.questionOverflow, true);
  assert.equal(budget.optionsOverflow, false);
  assert.equal(budget.total, 18);
});

test("budget: short question and long options preserve the question", () => {
  const budget = computeQuestionnaireBudget({
    termRows: 24,
    topHeight: 1,
    pinnedHeight: 0,
    bottomHeight: 3,
    questionContentHeight: 5,
    optionsContentHeight: 20,
  });
  assert.equal(budget.question, 5);
  assert.equal(budget.options, 9);
  assert.equal(budget.questionOverflow, false);
  assert.equal(budget.optionsOverflow, true);
  assert.equal(budget.total, 18);
});

test("budget: both long splits the available rows", () => {
  const budget = computeQuestionnaireBudget({
    termRows: 24,
    topHeight: 1,
    pinnedHeight: 0,
    bottomHeight: 3,
    questionContentHeight: 200,
    optionsContentHeight: 200,
  });
  assert.equal(budget.total, 18);
  assert.equal(budget.question, 5);
  assert.equal(budget.options, 9);
  assert.equal(budget.questionOverflow, true);
  assert.equal(budget.optionsOverflow, true);
});

test("budget: editor priority gives the editor pane all the rows it needs", () => {
  const budget = computeQuestionnaireBudget({
    termRows: 24,
    topHeight: 1,
    pinnedHeight: 0,
    bottomHeight: 3,
    questionContentHeight: 200,
    optionsContentHeight: 9,
    editorPriority: true,
  });
  assert.equal(budget.options, 9);
  assert.equal(budget.question, 5);
  assert.equal(budget.total, 18);

  const tight = computeQuestionnaireBudget({
    termRows: 24,
    topHeight: 1,
    pinnedHeight: 0,
    bottomHeight: 3,
    questionContentHeight: 200,
    optionsContentHeight: 20,
    editorPriority: true,
  });
  assert.equal(tight.options, 14);
  assert.equal(tight.question, 0);
  assert.equal(tight.total, 18);
});

test("budget: tiny terminals clamp without negative heights", () => {
  const budget = computeQuestionnaireBudget({
    termRows: 8,
    topHeight: 0,
    pinnedHeight: 0,
    bottomHeight: 2,
    questionContentHeight: 200,
    optionsContentHeight: 6,
  });
  assert.ok(budget.total <= questionnaireMaxRows(8));
  assert.ok(budget.question >= 0);
  assert.ok(budget.options >= 1);
  assert.equal(budget.total, budget.question + budget.options + 2);
});

test("budget: no content, zero avail, and lower caps stay safe", () => {
  const empty = computeQuestionnaireBudget({
    termRows: 24,
    topHeight: 1,
    pinnedHeight: 0,
    bottomHeight: 3,
    questionContentHeight: 0,
    optionsContentHeight: 0,
  });
  assert.deepEqual(
    {
      total: empty.total,
      question: empty.question,
      options: empty.options,
      qOver: empty.questionOverflow,
      oOver: empty.optionsOverflow,
    },
    { total: 4, question: 0, options: 0, qOver: false, oOver: false },
  );

  const fixedOnly = computeQuestionnaireBudget({
    termRows: 8,
    topHeight: 3,
    pinnedHeight: 3,
    bottomHeight: 3,
    questionContentHeight: 10,
    optionsContentHeight: 10,
  });
  assert.equal(fixedOnly.total, 9);
  assert.equal(fixedOnly.question, 0);
  assert.equal(fixedOnly.options, 0);
  assert.equal(fixedOnly.questionOverflow, true);
  assert.equal(fixedOnly.optionsOverflow, true);

  const lowered = computeQuestionnaireBudget({
    termRows: 60,
    topHeight: 1,
    pinnedHeight: 0,
    bottomHeight: 3,
    questionContentHeight: 100,
    optionsContentHeight: 5,
    maxTotalRows: 12,
  });
  assert.equal(lowered.total, 12);
  assert.equal(lowered.options, 5);
  assert.equal(lowered.question, 3);
});

test("budget: pinned question reduces the available body", () => {
  const withPin = computeQuestionnaireBudget({
    termRows: 24,
    topHeight: 1,
    pinnedHeight: 2,
    bottomHeight: 3,
    questionContentHeight: 100,
    optionsContentHeight: 5,
  });
  assert.equal(withPin.total, 18);
  assert.equal(withPin.options, 5);
  assert.equal(withPin.question, 7);
});

// ── scroll pane ─────────────────────────────────────────────────────

test("scroll pane: update, clamp, scrollBy and scrollTo", () => {
  const p = createScrollPane();
  assert.equal(maxScrollTop(p), 0);
  updateScrollPane(p, 10, 4);
  assert.equal(p.contentHeight, 10);
  assert.equal(p.viewportHeight, 4);
  assert.equal(p.scrollTop, 0);
  assert.equal(maxScrollTop(p), 6);

  scrollPaneBy(p, 99);
  assert.equal(p.scrollTop, 6);
  scrollPaneBy(p, -99);
  assert.equal(p.scrollTop, 0);

  scrollPaneTo(p, 4);
  assert.equal(p.scrollTop, 4);
  scrollPaneTo(p, Number.NaN);
  assert.equal(p.scrollTop, 0);

  updateScrollPane(p, 2, 4);
  assert.equal(p.scrollTop, 0);
  assert.equal(maxScrollTop(p), 0);

  scrollPaneBy(p, 3);
  assert.equal(p.scrollTop, 0);
});

// ── selection visibility ────────────────────────────────────────────

test("keepRangeVisible: short ranges above, inside and below", () => {
  const p = pane(20, 10, 0);
  assert.equal(keepRangeVisible(p, { start: 2, end: 4 }), 0);
  assert.equal(keepRangeVisible(p, { start: 12, end: 14 }), 4);
  assert.equal(keepRangeVisible(p, { start: 14, end: 16 }), 6);

  p.scrollTop = 5;
  assert.equal(keepRangeVisible(p, { start: 2, end: 4 }), 2);
  assert.equal(keepRangeVisible(p, { start: 6, end: 8 }), 5);
  assert.equal(keepRangeVisible(p, { start: 12, end: 14 }), 5);

  p.scrollTop = 20; // clamped to maxTop=10
  assert.equal(keepRangeVisible(p, { start: 2, end: 4 }), 2);
});

test("keepRangeVisible: tall range keeps an inner scroll position", () => {
  const p = pane(40, 10, 0);
  assert.equal(keepRangeVisible(p, { start: 5, end: 30 }), 5);
  p.scrollTop = 12;
  assert.equal(keepRangeVisible(p, { start: 5, end: 30 }), 12);
  p.scrollTop = 25;
  assert.equal(keepRangeVisible(p, { start: 5, end: 30 }), 5);
});

test("keepRangeVisible: zero viewport/content and out-of-range clamps", () => {
  assert.equal(keepRangeVisible(pane(0, 0, 0), { start: 0, end: 1 }), 0);
  assert.equal(keepRangeVisible(pane(20, 0, 4), { start: 2, end: 4 }), 0);
  assert.equal(
    keepRangeVisible(pane(20, 10, 0), { start: -5, end: 100 }),
    0,
  );
});

// ── wheel parsing ───────────────────────────────────────────────────

test("parseWheelScroll: SGR up/down and horizontal ignored", () => {
  assert.equal(parseWheelScroll("\x1b[<64;10;10M"), -3);
  assert.equal(parseWheelScroll("\x1b[<65;10;10M"), 3);
  assert.equal(parseWheelScroll("\x1b[<64;10;10m"), -3);
  assert.equal(parseWheelScroll("\x1b[<66;10;10M"), 0);
  assert.equal(parseWheelScroll("\x1b[<67;10;10M"), 0);
  assert.equal(parseWheelScroll("\x1b[<0;10;10M"), 0);
});

test("parseWheelScroll: X10 up/down and ordinary input", () => {
  const up = `\x1b[M${String.fromCharCode(32 + 64)}!!`;
  const down = `\x1b[M${String.fromCharCode(32 + 65)}!!`;
  assert.equal(parseWheelScroll(up), -3);
  assert.equal(parseWheelScroll(down), 3);
  assert.equal(parseWheelScroll("x"), 0);
  assert.equal(parseWheelScroll(""), 0);
  assert.equal(parseWheelScroll("\x1b[A"), 0);
});

// ── labels and previews ─────────────────────────────────────────────

test("formatScrollPosition reports the visible window", () => {
  assert.equal(formatScrollPosition(pane(42, 12, 0)), "1–12/42");
  assert.equal(formatScrollPosition(pane(42, 12, 30)), "31–42/42");
  assert.equal(formatScrollPosition(pane(42, 12, 99)), "31–42/42");
  assert.equal(formatScrollPosition(pane(0, 12, 0)), "0/0");
  assert.equal(formatScrollPosition(pane(5, 12, 0)), "1–5/5");
});

test("previewTextLines caps lines and reports hidden ones", () => {
  assert.deepEqual(previewTextLines("a\nb\nc\nd", 10, 2), {
    lines: ["a", "b"],
    hidden: 2,
  });
  assert.deepEqual(previewTextLines("abcdefghijkl", 5, 2), {
    lines: ["abcde", "fghij"],
    hidden: 1,
  });
  assert.deepEqual(previewTextLines("", 10, 2), {
    lines: [""],
    hidden: 0,
  });
  assert.deepEqual(previewTextLines("abc", 10, 0), {
    lines: [],
    hidden: 1,
  });
  assert.deepEqual(previewTextLines("abc", 0, 2), {
    lines: ["a", "b"],
    hidden: 1,
  });
});
