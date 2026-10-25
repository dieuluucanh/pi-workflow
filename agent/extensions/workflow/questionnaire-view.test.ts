#!/usr/bin/env node
/**
 * Questionnaire view regression tests.
 *
 * The old failure mode: a long question (a proposed commit message) pushed
 * the choice rows below the host's bottom clip. These tests render the view the
 * same way the host does (a flat line list, then an overlay slice) and prove
 * the choices are always present, the body scrolls, and the result shape is
 * unchanged.
 *
 * Run: node --test questionnaire-view.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { visibleWidth, type TUI } from "@earendil-works/pi-tui";

import {
  createQuestionnaireView,
  type QuestionnaireQuestion,
  type QuestionnaireResult,
  type QuestionnaireTheme,
  type QuestionnaireView,
} from "./questionnaire-view.ts";
import { questionnaireMaxRows } from "./questionnaire-layout.ts";

const THEME: QuestionnaireTheme = {
  fg: (_color, text) => text,
  bg: (_color, text) => text,
  bold: (text) => text,
};

interface Harness {
  view: QuestionnaireView;
  tui: TUI;
  getResult(): QuestionnaireResult | null | undefined;
}

function harness(
  questions: QuestionnaireQuestion[],
  rows = 24,
  columns = 80,
  signal?: AbortSignal,
): Harness {
  let result: QuestionnaireResult | null | undefined;
  const tui = {
    terminal: { rows, columns },
    requestRender: () => {},
  } as unknown as TUI;
  const view = createQuestionnaireView(tui, THEME, {
    questions,
    signal,
    done: (value) => {
      result = value;
    },
  });
  return { view, tui, getResult: () => result };
}

function render(view: QuestionnaireView, width = 80): string[] {
  return view.render(width);
}

function joined(view: QuestionnaireView, width = 80): string {
  return render(view, width).join("\n");
}

function assertWithinWidth(lines: string[], width: number): void {
  for (const line of lines) {
    assert.ok(
      visibleWidth(line) <= width,
      `line "${line}" is ${visibleWidth(line)} wide (limit ${width})`,
    );
  }
}

const OPTIONS = [
  { label: "✅ Commit", description: "Commit with this message" },
  { label: "✏️ Edit", description: "Modify the message before committing" },
  { label: "❌ Cancel", description: "Abort without committing" },
];

function longQuestion(lines = 200): string {
  return Array.from(
    { length: lines },
    (_, index) => `line ${index + 1}: proposed commit message body`,
  ).join("\n");
}

function hasAllOptions(text: string): void {
  assert.match(text, /✅ Commit/);
  assert.match(text, /✏️ Edit/);
  assert.match(text, /❌ Cancel/);
}

// ── the old bug: options must survive the overlay slice ─────────────

test("long question keeps every choice inside the overlay budget", () => {
  const { view } = harness([
    {
      header: "Commit",
      question: longQuestion(),
      options: OPTIONS,
    },
  ]);

  const lines = render(view, 80);
  const max = questionnaireMaxRows(24);
  assert.ok(
    lines.length <= max,
    `rendered ${lines.length} lines, budget ${max}`,
  );
  assert.ok(lines.length <= Math.floor(24 * 0.8));

  const text = lines.join("\n");
  hasAllOptions(text);
  assert.match(text, /PgUp\/PgDn scroll/);

  // This is exactly what the overlay does before compositing. The old view
  // would have lost the choices here.
  const overlaySlice = lines.slice(0, Math.floor(24 * 0.8));
  hasAllOptions(overlaySlice.join("\n"));
});

test("PageDown reveals later body lines without moving the choices", () => {
  const { view } = harness([
    {
      header: "Commit",
      question: longQuestion(),
      options: OPTIONS,
    },
  ]);

  const before = joined(view);
  assert.match(before, /line 1:/);
  hasAllOptions(before);

  for (let i = 0; i < 8; i++) view.handleInput("\x1b[6~");
  const after = joined(view);
  assert.notEqual(after, before);
  assert.match(after, /line 2[0-9]:|line 3[0-9]:|line 4[0-9]:|line 5[0-9]:/);
  hasAllOptions(after);
});

test("wheel input scrolls the body and keeps the choices", () => {
  const { view } = harness([
    {
      header: "Commit",
      question: longQuestion(),
      options: OPTIONS,
    },
  ]);

  const before = joined(view);
  for (let i = 0; i < 5; i++) view.handleInput("\x1b[<65;10;10M");
  const after = joined(view);
  assert.notEqual(after, before);
  hasAllOptions(after);

  // Wheel up returns toward the start.
  for (let i = 0; i < 10; i++) view.handleInput("\x1b[<64;10;10M");
  const back = joined(view);
  assert.match(back, /line 1:/);
  hasAllOptions(back);
});

test("context pins the short question above the scrollable message", () => {
  const { view } = harness([
    {
      header: "Commit",
      question: "Commit these staged changes?",
      context: longQuestion(80),
      options: OPTIONS,
    },
  ]);

  const lines = render(view, 80);
  const text = lines.join("\n");
  assert.match(text, /Commit these staged changes\?/);
  assert.match(text, /line 1:/);
  hasAllOptions(text);
  assert.ok(lines.length <= questionnaireMaxRows(24));

  for (let i = 0; i < 5; i++) view.handleInput("\x1b[6~");
  const after = joined(view);
  assert.match(after, /Commit these staged changes\?/);
  assert.match(after, /line [2-9][0-9]:|line 1[0-9][0-9]:/);
  hasAllOptions(after);
});

test("narrow terminals stay within the width and keep the choices", () => {
  const { view } = harness(
    [
      {
        header: "Commit",
        question: "A very long unbroken commit message ".repeat(30),
        options: OPTIONS,
      },
    ],
    24,
    30,
  );

  const lines = render(view, 30);
  assertWithinWidth(lines, 30);
  hasAllOptions(lines.join("\n"));
  assert.ok(lines.length <= questionnaireMaxRows(24));
});

test("resizing the terminal re-bounds the view (no width-only cache)", () => {
  const { view, tui } = harness([
    {
      header: "Commit",
      question: longQuestion(),
      options: OPTIONS,
    },
  ]);

  const tall = render(view, 80);
  assert.ok(tall.length <= questionnaireMaxRows(24));

  (tui.terminal as unknown as { rows: number }).rows = 12;
  const short = render(view, 80);
  assert.ok(short.length <= questionnaireMaxRows(12));
  assert.ok(short.length < tall.length);
  // At 8 rendered lines the option list scrolls; the selected row and the
  // scroll hint must both be visible.
  assert.match(short.join("\n"), /✅ Commit/);
  assert.match(short.join("\n"), /PgUp\/PgDn scroll/);
  assertWithinWidth(short, 80);
});

test("tiny terminals render without throwing and keep the selected choice", () => {
  for (const rows of [6, 8, 10]) {
    const { view } = harness(
      [
        {
          header: "Commit",
          question: longQuestion(40),
          options: OPTIONS,
        },
      ],
      rows,
    );
    const lines = render(view, 80);
    assert.ok(
      lines.length <= questionnaireMaxRows(rows),
      `rows=${rows}: ${lines.length} > ${questionnaireMaxRows(rows)}`,
    );
    // Initial selection is the first option.
    assert.match(lines.join("\n"), /✅ Commit/);
    assertWithinWidth(lines, 80);
  }
});

test("pathological one-line terminal never exceeds its cap", () => {
  const { view } = harness(
    [
      {
        header: "One",
        question: "First?",
        options: [{ label: "A" }, { label: "B" }],
      },
      {
        header: "Two",
        question: "Second?",
        options: [{ label: "C" }, { label: "D" }],
      },
    ],
    1,
  );
  const lines = render(view, 80);
  assert.ok(lines.length <= questionnaireMaxRows(1));
  assert.equal(lines.length, 1);
});

// ── result contract / multi-question / freeform ─────────────────────

test("single question result keeps the old answer shape", () => {
  const { view, getResult } = harness([
    {
      header: "Commit",
      question: "Commit these staged changes?",
      context: "feat: add the thing",
      options: OPTIONS,
    },
  ]);

  view.handleInput("\r"); // initial selection = ✅ Commit
  const result = getResult();
  assert.ok(result);
  assert.equal(result!.cancelled, false);
  assert.equal(result!.answers.length, 1);
  assert.deepEqual(
    {
      question: result!.answers[0].question,
      header: result!.answers[0].header,
      answer: result!.answers[0].answer,
      wasCustom: result!.answers[0].wasCustom,
      index: result!.answers[0].index,
    },
    {
      question: "Commit these staged changes?",
      header: "Commit",
      answer: "✅ Commit",
      wasCustom: false,
      index: 1,
    },
  );
});

test("multi-question tabs, answers summary and submit tab", () => {
  const { view, getResult } = harness([
    {
      header: "Scope",
      question: "Which scope?",
      options: [{ label: "Core" }, { label: "UI" }],
    },
    {
      header: "Tests",
      question: "Add tests?",
      options: [{ label: "Yes" }, { label: "No" }],
    },
  ]);

  assert.match(joined(view), /■|□/);
  view.handleInput("\r"); // Q1 = Core, advance to Q2
  assert.match(joined(view), /Add tests\?/);
  view.handleInput("\r"); // Q2 = Yes, advance to submit
  const summary = joined(view);
  assert.match(summary, /Ready to submit/);
  assert.match(summary, /Core/);
  assert.match(summary, /Yes/);
  assert.match(summary, /Press Enter to submit/);

  view.handleInput("\r");
  const result = getResult();
  assert.ok(result);
  assert.equal(result!.cancelled, false);
  assert.equal(result!.answers.length, 2);
  assert.equal(result!.answers[0].answer, "Core");
  assert.equal(result!.answers[1].answer, "Yes");
});

test("freeform entry: hide the list, type, submit", () => {
  const { view, getResult } = harness([
    {
      header: "Commit",
      question: "Commit?",
      options: [{ label: "Keep" }, { label: "Discard" }],
    },
  ]);

  // Rows: Keep, Discard, Type something.
  view.handleInput("\x1b[B");
  view.handleInput("\x1b[B");
  view.handleInput("\r");
  const input = joined(view);
  assert.match(input, /Your answer:/);
  assert.match(input, /Enter to submit/);
  assert.doesNotMatch(input, /1\. Keep/);
  assert.doesNotMatch(input, /Type something\./);

  for (const char of "feat: x") view.handleInput(char);
  view.handleInput("\r");

  const result = getResult();
  assert.ok(result);
  assert.equal(result!.answers[0].wasCustom, true);
  assert.equal(result!.answers[0].answer, "feat: x");
});

test("Esc from the editor goes back to the list; Esc outside cancels", () => {
  const { view, getResult } = harness([
    {
      header: "Commit",
      question: "Commit?",
      options: OPTIONS,
    },
  ]);

  view.handleInput("\x1b[B");
  view.handleInput("\x1b[B");
  view.handleInput("\x1b[B");
  view.handleInput("\r");
  assert.match(joined(view), /Your answer:/);
  view.handleInput("\x1b");
  const back = joined(view);
  assert.doesNotMatch(back, /Your answer:/);
  hasAllOptions(back);
  assert.equal(getResult(), undefined);

  view.handleInput("\x1b");
  const result = getResult();
  assert.ok(result);
  assert.equal(result!.cancelled, true);
  assert.deepEqual(result!.answers, []);
});

test("a long custom answer preview is capped with a remainder marker", () => {
  const { view } = harness([
    {
      header: "One",
      question: "First?",
      options: [{ label: "A" }, { label: "B" }],
    },
    {
      header: "Two",
      question: "Second?",
      options: [{ label: "C" }, { label: "D" }],
    },
  ]);

  // Q1's freeform row is the third row.
  view.handleInput("\x1b[B");
  view.handleInput("\x1b[B");
  view.handleInput("\r");
  const answer = Array.from({ length: 10 }, (_, i) => `answer ${i + 1}`).join(
    "\n",
  );
  view.handleInput(`\x1b[200~${answer}\x1b[201~`);
  view.handleInput("\r"); // submit freeform, advance to Q2
  view.handleInput("\x1b[Z"); // Shift+Tab back to Q1
  const preview = joined(view);
  assert.match(preview, /↳ Your answer:/);
  assert.match(preview, /more/);
  assert.match(preview, /1\. A/);
  const answerLines = preview
    .split("\n")
    .filter((line) => /↳ Your answer:|^\s{4}answer|more/.test(line));
  assert.ok(answerLines.length <= 4, `preview used ${answerLines.length} lines`);
});

test("aborting the tool signal resolves null and dispose unhooks it", () => {
  const controller = new AbortController();
  const { view, getResult } = harness(
    [
      {
        header: "Commit",
        question: "Commit?",
        options: OPTIONS,
      },
    ],
    24,
    80,
    controller.signal,
  );
  assert.equal(getResult(), undefined);
  controller.abort();
  assert.equal(getResult(), null);
  view.dispose();

  // An already-aborted signal resolves immediately, before any input.
  const already = new AbortController();
  already.abort();
  const preAborted = harness(
    [
      {
        header: "Commit",
        question: "Commit?",
        options: OPTIONS,
      },
    ],
    24,
    80,
    already.signal,
  );
  assert.equal(preAborted.getResult(), null);
});
