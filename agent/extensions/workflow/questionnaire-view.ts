/**
 * Questionnaire view.
 *
 * The questionnaire is hosted as a full-width, bottom-anchored overlay. The
 * host renders the component as a flat list of lines (the fullscreen input
 * dock treats its editor container as a leaf), so this view must bound its own
 * height and slice its panes manually:
 *
 *   top border / tabs
 *   pinned short question
 *   scrollable question body (context / long question / answers summary)
 *   pinned option list (or the editor pane while typing)
 *   blank or submit status / help / bottom border
 *
 * The option rows and the help line are never part of the scroll region, so a
 * long proposed commit message can never push the choices off-screen. The view
 * never renders more than `questionnaireMaxRows(terminal.rows)` lines and stays
 * inside the host overlay's 80% max height.
 */

import {
  Editor,
  Key,
  matchesKey,
  visibleWidth,
  wrapTextWithAnsi,
  truncateToWidth,
  type Component,
  type EditorTheme,
  type Focusable,
  type TUI,
} from "@earendil-works/pi-tui";
import type { ThemeColor } from "@earendil-works/pi-coding-agent";
import {
  QUESTIONNAIRE_MAX_ANSWER_PREVIEW_LINES,
  QUESTIONNAIRE_MAX_PINNED_QUESTION_LINES,
  computeQuestionnaireBudget,
  createScrollPane,
  keepRangeVisible,
  parseWheelScroll,
  previewTextLines,
  questionnaireMaxRows,
  scrollPaneBy,
  scrollPaneTo,
  updateScrollPane,
  type LineRange,
  type ScrollPane,
} from "./questionnaire-layout.ts";

// ── Public types ─────────────────────────────────────────────────────

export interface QuestionnaireOption {
  label: string;
  description?: string;
}

export interface QuestionnaireQuestion {
  question: string;
  header?: string;
  /**
   * Long supporting text (e.g. the proposed commit message). Rendered in the
   * scrollable body while `question` stays pinned and short when possible.
   */
  context?: string;
  options: QuestionnaireOption[];
}

export interface QuestionnaireAnswer {
  question: string;
  header?: string;
  answer: string;
  wasCustom: boolean;
  index?: number;
}

export interface QuestionnaireResult {
  answers: QuestionnaireAnswer[];
  cancelled: boolean;
}

export interface QuestionnaireViewOptions {
  questions: QuestionnaireQuestion[];
  /** Resolve the surrounding `ctx.ui.custom()` call. */
  done: (result: QuestionnaireResult | null) => void;
  signal?: AbortSignal;
}

/**
 * Minimal theme surface. Structural, so Pi's real `Theme` satisfies it and
 * tests can pass a fake with identity styling.
 */
export interface QuestionnaireTheme {
  fg(color: ThemeColor, text: string): string;
  /** The package root exports ThemeColor but not ThemeBg; the view only uses this key. */
  bg(color: "selectedBg", text: string): string;
  bold(text: string): string;
}

export interface QuestionnaireView extends Component, Focusable {
  /** Always present in this view (unlike the optional Component method). */
  handleInput(data: string): void;
  dispose(): void;
}

// ── Freeform options (same aliases as the original questionnaire) ────

export interface DisplayOption {
  label: string;
  description?: string;
  isOther?: boolean;
}

const FREEFORM_ALIASES = new Set([
  "type something",
  "type something else",
  "other",
  "other (please specify)",
  "other please specify",
]);

export function normalizeFreeform(value: string): string {
  return value.toLowerCase().trim().replace(/\.$/, "").replace(/\s+/g, " ");
}

/** Build the rows shown for a question: its options plus the freeform row. */
export function buildDisplayOptions(
  raw: readonly QuestionnaireOption[],
): DisplayOption[] {
  const filtered: DisplayOption[] = raw
    .filter((option) => !FREEFORM_ALIASES.has(normalizeFreeform(option.label)))
    .map((option) => ({
      label: option.label,
      ...(option.description === undefined
        ? {}
        : { description: option.description }),
    }));
  filtered.push({ label: "Type something.", isOther: true });
  return filtered;
}

/** Was this option the previously selected answer (not the moving cursor)? */
export function isCustomSelected(
  prev: { wasCustom: boolean; index?: number } | undefined,
  opt: DisplayOption | undefined,
  index: number,
): boolean {
  if (!prev) return false;
  if (prev.wasCustom && opt?.isOther) return true;
  return prev.index === index + 1;
}

// ── Small rendering helpers ──────────────────────────────────────────

function wrapWithPrefix(
  prefix: string,
  text: string,
  width: number,
): string[] {
  const W = Math.max(1, Math.floor(width) || 1);
  const prefixWidth = visibleWidth(prefix);
  if (prefixWidth >= W) {
    const combined = wrapTextWithAnsi(`${prefix}${text}`, W);
    return combined.length > 0 ? combined : [prefix];
  }
  const wrapped = wrapTextWithAnsi(text, Math.max(1, W - prefixWidth));
  if (wrapped.length === 0) return [prefix];
  const continuation = " ".repeat(prefixWidth);
  return wrapped.map(
    (line, index) => `${index === 0 ? prefix : continuation}${line}`,
  );
}

function repeatRule(theme: QuestionnaireTheme, width: number): string {
  return theme.fg("accent", "─".repeat(Math.max(1, width)));
}

function truncateOne(
  theme: QuestionnaireTheme,
  text: string,
  width: number,
  color: ThemeColor = "dim",
): string {
  return truncateToWidth(` ${theme.fg(color, text)}`, Math.max(1, width));
}

// ── View factory ─────────────────────────────────────────────────────

interface AnswerState {
  answer: string;
  wasCustom: boolean;
  index?: number;
}

interface OptionBody {
  lines: string[];
  selectedRange?: LineRange;
}

export function createQuestionnaireView(
  tui: TUI,
  theme: QuestionnaireTheme,
  opts: QuestionnaireViewOptions,
): QuestionnaireView {
  const questions = opts.questions;
  const isMulti = questions.length > 1;
  const done = opts.done;
  const signal = opts.signal;

  // ── state ──
  let currentTab = 0;
  let optionIndex = 0;
  let inputMode = false;
  let inputQuestionIdx: number | null = null;
  let closed = false;
  let focused = false;

  const answers = new Map<number, AnswerState>();
  const questionPane: ScrollPane = createScrollPane();
  const optionPane: ScrollPane = createScrollPane();
  const questionScrollByTab = new Map<number, number>();
  const optionScrollByTab = new Map<number, number>();

  const editorTheme: EditorTheme = {
    borderColor: (text) => theme.fg("accent", text),
    selectList: {
      selectedPrefix: (text) => theme.fg("accent", text),
      selectedText: (text) => theme.fg("accent", text),
      description: (text) => theme.fg("muted", text),
      scrollInfo: (text) => theme.fg("dim", text),
      noMatch: (text) => theme.fg("warning", text),
    },
  };
  const editor = new Editor(tui, editorTheme);

  // ── helpers ──

  function refresh(): void {
    tui.requestRender();
  }

  function currentQ(): QuestionnaireQuestion | undefined {
    return questions[currentTab];
  }

  function optsForTab(tab: number): DisplayOption[] {
    const q = questions[tab];
    return q ? buildDisplayOptions(q.options) : [];
  }

  function currentOpts(): DisplayOption[] {
    return optsForTab(currentTab);
  }

  function allAnswered(): boolean {
    return questions.every((_, index) => answers.has(index));
  }

  function restoreOptionIndex(tab: number): void {
    if (tab >= questions.length) {
      optionIndex = 0;
      return;
    }
    const previous = answers.get(tab);
    const opts = optsForTab(tab);
    if (previous?.wasCustom) {
      optionIndex = Math.max(0, opts.length - 1);
      return;
    }
    if (previous?.index) {
      optionIndex = Math.max(0, Math.min(previous.index - 1, opts.length - 1));
      return;
    }
    optionIndex = 0;
  }

  function saveTabScroll(): void {
    questionScrollByTab.set(currentTab, questionPane.scrollTop);
    optionScrollByTab.set(currentTab, optionPane.scrollTop);
  }

  function restoreTabScroll(tab: number): void {
    questionPane.scrollTop = questionScrollByTab.get(tab) ?? 0;
    optionPane.scrollTop = optionScrollByTab.get(tab) ?? 0;
  }

  function goToTab(tab: number): void {
    const next = Math.max(0, Math.min(questions.length, tab));
    if (next === currentTab) return;
    saveTabScroll();
    currentTab = next;
    inputMode = false;
    inputQuestionIdx = null;
    editor.focused = false;
    restoreOptionIndex(currentTab);
    restoreTabScroll(currentTab);
    refresh();
  }

  function finish(result: QuestionnaireResult | null): void {
    if (closed) return;
    closed = true;
    done(result);
  }

  function submit(cancelled: boolean): void {
    if (closed) return;
    if (cancelled) {
      finish({ answers: [], cancelled: true });
      return;
    }
    const result: QuestionnaireAnswer[] = questions.map((question, index) => {
      const answer = answers.get(index);
      return {
        question: question.question,
        header: question.header,
        answer: answer ? answer.answer : "",
        wasCustom: answer ? answer.wasCustom : false,
        index: answer?.index,
      };
    });
    finish({ answers: result, cancelled: false });
  }

  function advanceAfter(): void {
    if (!isMulti) {
      submit(false);
      return;
    }
    if (currentTab < questions.length - 1) {
      goToTab(currentTab + 1);
    } else {
      goToTab(questions.length);
    }
  }

  function leaveInputMode(): void {
    inputMode = false;
    inputQuestionIdx = null;
    editor.setText("");
    editor.focused = false;
    refresh();
  }

  function beginInputMode(): void {
    const opts = currentOpts();
    if (!opts[optionIndex]?.isOther) return;
    inputMode = true;
    inputQuestionIdx = currentTab;
    const previous = answers.get(currentTab);
    editor.setText(previous?.wasCustom ? previous.answer : "");
    editor.focused = focused;
    refresh();
  }

  editor.onSubmit = (value) => {
    if (!inputMode || inputQuestionIdx === null) return;
    const index = inputQuestionIdx;
    const trimmed = value.trim() || "(no response)";
    const freeformIndex = optsForTab(index).length; // 1-based last row
    answers.set(index, {
      answer: trimmed,
      wasCustom: true,
      index: freeformIndex,
    });
    inputMode = false;
    inputQuestionIdx = null;
    editor.setText("");
    editor.focused = false;
    advanceAfter();
  };

  // ── body builders ──

  function buildQuestionLines(
    question: QuestionnaireQuestion,
    width: number,
  ): string[] {
    const lines: string[] = [];
    for (const raw of String(question.question ?? "").split(/\r?\n/)) {
      lines.push(...wrapWithPrefix(" ", theme.fg("text", raw), width));
    }
    return lines.length > 0 ? lines : [""];
  }

  function buildContextLines(
    question: QuestionnaireQuestion | undefined,
    width: number,
  ): string[] {
    const context = String(question?.context ?? "");
    if (!context.trim()) return [];
    const lines: string[] = [];
    for (const raw of context.split(/\r?\n/)) {
      lines.push(...wrapWithPrefix("  ", theme.fg("text", raw), width));
    }
    return lines;
  }

  function buildPinnedQuestion(
    question: QuestionnaireQuestion | undefined,
    questionLines: string[],
    maxRows: number,
  ): string[] {
    if (!question || currentTab === questions.length) return [];
    if (!String(question.context ?? "").trim()) return [];
    if (maxRows < 12) return [];
    if (questionLines.length > QUESTIONNAIRE_MAX_PINNED_QUESTION_LINES) return [];
    return [...questionLines, ""];
  }

  function buildAnswersSummary(width: number): string[] {
    const lines: string[] = [];
    lines.push(
      ...wrapWithPrefix(
        " ",
        theme.fg("accent", theme.bold("Ready to submit")),
        width,
      ),
    );
    lines.push("");
    for (let index = 0; index < questions.length; index++) {
      const answer = answers.get(index);
      if (!answer) continue;
      const header = questions[index].header || `Q${index + 1}`;
      const prefix = answer.wasCustom ? "(wrote) " : "";
      lines.push(
        ...wrapWithPrefix(
          "  ",
          theme.fg("muted", `${header}: `) +
            theme.fg("text", prefix + answer.answer),
          width,
        ),
      );
      lines.push("");
    }
    return lines;
  }

  function buildQuestionBody(
    width: number,
    question: QuestionnaireQuestion | undefined,
    questionLines: string[],
    pinned: boolean,
  ): string[] {
    if (currentTab === questions.length) return buildAnswersSummary(width);
    if (!question) return [];
    const contextLines = buildContextLines(question, width);
    if (pinned) return contextLines;
    return [...questionLines, "", ...contextLines];
  }

  function buildEditorPane(width: number): string[] {
    const lines: string[] = [];
    lines.push("");
    lines.push(
      ...wrapWithPrefix(" ", theme.fg("muted", "Your answer:"), width),
    );
    const inner = Math.max(1, width - 2);
    for (const line of editor.render(inner)) {
      lines.push(...wrapWithPrefix("  ", line, width));
    }
    lines.push("");
    lines.push(
      ...wrapWithPrefix(
        " ",
        theme.fg("dim", "Enter to submit • Esc to go back"),
        width,
      ),
    );
    return lines;
  }

  function buildOptionBody(width: number): OptionBody {
    if (currentTab === questions.length) {
      return { lines: [] };
    }
    if (inputMode) {
      return { lines: buildEditorPane(width) };
    }

    const options = currentOpts();
    const previous = answers.get(currentTab);
    const lines: string[] = [];
    let selectedRange: LineRange | undefined;
    const selectedIndex = Math.max(
      0,
      Math.min(optionIndex, Math.max(0, options.length - 1)),
    );

    for (let index = 0; index < options.length; index++) {
      const option = options[index];
      const selected = index === selectedIndex;
      const previouslySelected = isCustomSelected(previous, option, index);
      const isOther = !!option.isOther;

      let prefix: string;
      let color: ThemeColor;
      if (selected) {
        prefix = theme.fg("accent", "> ");
        color = "accent";
      } else if (previouslySelected) {
        prefix = theme.fg("success", "✓ ");
        color = "success";
      } else {
        prefix = "  ";
        color = "text";
      }

      const start = lines.length;
      lines.push(
        ...wrapWithPrefix(
          prefix,
          theme.fg(color, `${index + 1}. ${option.label}`),
          width,
        ),
      );
      if (option.description) {
        lines.push(
          ...wrapWithPrefix(
            "     ",
            theme.fg("muted", option.description),
            width,
          ),
        );
      }

      // Show the previously typed freeform answer inline under its row, but
      // never let a multi-paragraph answer take over the option viewport.
      if (isOther && previous?.wasCustom) {
        const preview = previewTextLines(
          previous.answer,
          Math.max(1, width - 22),
          QUESTIONNAIRE_MAX_ANSWER_PREVIEW_LINES,
        );
        const firstLine = preview.lines[0] ?? "";
        const moreSuffix =
          preview.hidden > 0 ? ` … +${preview.hidden} more` : "";
        const closingFirst = preview.lines.length === 1 ? '"' : "";
        lines.push(
          ...wrapWithPrefix(
            "    ",
            theme.fg("muted", "↳ Your answer: ") +
              theme.fg("text", `"${firstLine}${closingFirst}${moreSuffix}`),
            width,
          ),
        );
        for (let previewIndex = 1; previewIndex < preview.lines.length; previewIndex++) {
          const closing =
            previewIndex === preview.lines.length - 1 ? '"' : "";
          lines.push(
            ...wrapWithPrefix(
              "    ",
              theme.fg("text", `${preview.lines[previewIndex]}${closing}`),
              width,
            ),
          );
        }
      }

      if (selected) {
        selectedRange = { start, end: lines.length };
      }
    }

    return { lines, selectedRange };
  }

  // ── chrome ──

  function isCompact(maxRows: number): boolean {
    return maxRows < 12;
  }

  function isTiny(maxRows: number): boolean {
    return maxRows < 6;
  }

  function bottomHeightFor(maxRows: number): number {
    return isTiny(maxRows) ? 1 : isCompact(maxRows) ? 2 : 3;
  }

  function buildTabsLine(width: number): string {
    const tabs: string[] = [];
    const labelBudget = Math.max(
      4,
      Math.floor((width - 2) / (questions.length + 1)) - 4,
    );
    for (let index = 0; index < questions.length; index++) {
      const active = index === currentTab;
      const answered = answers.has(index);
      const label = truncateToWidth(
        questions[index].header || `Q${index + 1}`,
        labelBudget,
      );
      const box = answered ? "■" : "□";
      const color: ThemeColor = answered ? "success" : "muted";
      const text = ` ${box} ${label} `;
      const styled = active
        ? theme.bg(
            "selectedBg",
            `${theme.fg("accent", "→")} ${theme.fg("text", text)}`,
          )
        : theme.fg(color, `  ${text}`);
      tabs.push(`${styled} `);
    }

    const canSubmit = allAnswered();
    const isSubmit = currentTab === questions.length;
    const submitText = " ✓ Submit ";
    const styledSubmit = isSubmit
      ? theme.bg(
          "selectedBg",
          `${theme.fg("accent", "→")} ${theme.fg("text", submitText)}`,
        )
      : theme.fg(canSubmit ? "success" : "dim", `  ${submitText}`);
    tabs.push(styledSubmit);
    return truncateToWidth(` ${tabs.join("")}`, Math.max(1, width));
  }

  function buildTopBar(width: number, maxRows: number): string[] {
    const lines: string[] = [];
    // A one-line terminal cannot hold both a tab row and the help line; keep
    // the controls visible and let the tab row go rather than exceed the cap.
    if (maxRows <= 1) return lines;
    if (!isCompact(maxRows)) {
      lines.push(repeatRule(theme, width));
    }
    if (isMulti) {
      lines.push(buildTabsLine(width));
      if (!isCompact(maxRows)) lines.push("");
    }
    return lines;
  }

  function buildBottom(
    width: number,
    maxRows: number,
    overflow: { question: boolean; options: boolean },
  ): string[] {
    const submitTab = currentTab === questions.length;
    const anyOverflow = overflow.question || overflow.options;
    const scrollHint = anyOverflow ? " • PgUp/PgDn scroll" : "";
    const status = submitTab
      ? allAnswered()
        ? "Press Enter to submit"
        : `Unanswered: ${questions
            .filter((_, index) => !answers.has(index))
            .map((question, index) => question.header || `Q${index + 1}`)
            .join(", ")}`
      : "";
    const help = submitTab
      ? `Enter submit • Esc cancel${scrollHint}`
      : inputMode
        ? `Enter submit • Esc back${scrollHint}`
        : `${
            anyOverflow ? "PgUp/PgDn scroll • " : ""
          }${isMulti ? "Tab/←→ tabs • " : ""}↑↓ select • Enter confirm • Esc cancel`;

    const lines: string[] = [];
    if (!isCompact(maxRows)) {
      lines.push(
        submitTab
          ? truncateOne(
              theme,
              status,
              width,
              allAnswered() ? "success" : "warning",
            )
          : "",
      );
    }
    if (isTiny(maxRows)) {
      lines.push(truncateOne(theme, help, width));
    } else {
      lines.push(truncateOne(theme, help, width));
      lines.push(repeatRule(theme, width));
    }
    return lines;
  }

  // ── render ──

  function render(width: number): string[] {
    const W = Math.max(1, Math.floor(width) || 1);
    const rows = Math.max(
      1,
      Math.floor(Number.isFinite(tui.terminal?.rows) && tui.terminal.rows > 0
        ? tui.terminal.rows
        : 24),
    );
    const maxRows = questionnaireMaxRows(rows);

    const top = buildTopBar(W, maxRows);
    const submitTab = currentTab === questions.length;
    const question = submitTab ? undefined : currentQ();
    const questionLines = question
      ? buildQuestionLines(question, W)
      : [];
    const pinned = buildPinnedQuestion(question, questionLines, maxRows);
    const questionBody = buildQuestionBody(
      W,
      question,
      questionLines,
      pinned.length > 0,
    );
    const optionBody = buildOptionBody(W);

    const budget = computeQuestionnaireBudget({
      termRows: rows,
      topHeight: top.length,
      pinnedHeight: pinned.length,
      bottomHeight: bottomHeightFor(maxRows),
      questionContentHeight: questionBody.length,
      optionsContentHeight: optionBody.lines.length,
      editorPriority: inputMode,
    });

    updateScrollPane(questionPane, questionBody.length, budget.question);
    updateScrollPane(optionPane, optionBody.lines.length, budget.options);

    if (optionBody.selectedRange) {
      const target = keepRangeVisible(optionPane, optionBody.selectedRange);
      scrollPaneTo(optionPane, target);
    }

    const bottom = buildBottom(W, maxRows, {
      question: budget.questionOverflow,
      options: budget.optionsOverflow,
    });

    const questionSlice = questionBody.slice(
      questionPane.scrollTop,
      questionPane.scrollTop + budget.question,
    );
    const optionSlice = optionBody.lines.slice(
      optionPane.scrollTop,
      optionPane.scrollTop + budget.options,
    );

    return [...top, ...pinned, ...questionSlice, ...optionSlice, ...bottom];
  }

  // ── input ──

  function pageSize(pane: ScrollPane): number {
    return Math.max(1, pane.viewportHeight - 2);
  }

  function scrollOverflowing(delta: number, questionOnly = false): void {
    if (questionPane.contentHeight > questionPane.viewportHeight) {
      scrollPaneBy(questionPane, delta);
      refresh();
      return;
    }
    if (
      !questionOnly &&
      optionPane.contentHeight > optionPane.viewportHeight
    ) {
      scrollPaneBy(optionPane, delta);
      refresh();
    }
  }

  function handleScrollKey(data: string, questionOnly = false): boolean {
    const wheel = parseWheelScroll(data);
    if (wheel !== 0) {
      scrollOverflowing(wheel, questionOnly);
      return true;
    }
    if (matchesKey(data, Key.pageUp) || matchesKey(data, Key.pageDown)) {
      const size = pageSize(
        questionPane.contentHeight > questionPane.viewportHeight
          ? questionPane
          : optionPane,
      );
      scrollOverflowing(
        matchesKey(data, Key.pageUp) ? -size : size,
        questionOnly,
      );
      return true;
    }
    if (!questionOnly && matchesKey(data, Key.ctrl("u"))) {
      scrollOverflowing(
        -Math.max(1, Math.floor(questionPane.viewportHeight / 2)),
      );
      return true;
    }
    if (!questionOnly && matchesKey(data, Key.ctrl("d"))) {
      scrollOverflowing(
        Math.max(1, Math.floor(questionPane.viewportHeight / 2)),
      );
      return true;
    }
    return false;
  }

  function handleInput(data: string): void {
    if (closed) return;
    if (signal?.aborted) {
      finish(null);
      return;
    }

    if (inputMode) {
      if (matchesKey(data, Key.escape)) {
        leaveInputMode();
        return;
      }
      if (handleScrollKey(data, true)) return;
      editor.handleInput(data);
      refresh();
      return;
    }

    if (isMulti) {
      if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
        goToTab((currentTab + 1) % (questions.length + 1));
        return;
      }
      if (
        matchesKey(data, Key.shift("tab")) ||
        matchesKey(data, Key.left)
      ) {
        goToTab(
          (currentTab - 1 + questions.length + 1) % (questions.length + 1),
        );
        return;
      }
    }

    if (currentTab === questions.length) {
      if (matchesKey(data, Key.enter)) {
        if (allAnswered()) submit(false);
        return;
      }
      if (matchesKey(data, Key.escape)) {
        submit(true);
        return;
      }
      handleScrollKey(data);
      return;
    }

    if (matchesKey(data, Key.up)) {
      optionIndex = Math.max(0, optionIndex - 1);
      refresh();
      return;
    }
    if (matchesKey(data, Key.down)) {
      optionIndex = Math.min(
        Math.max(0, currentOpts().length - 1),
        optionIndex + 1,
      );
      refresh();
      return;
    }
    if (matchesKey(data, Key.enter)) {
      const option = currentOpts()[optionIndex];
      if (!option) return;
      if (option.isOther) {
        beginInputMode();
        return;
      }
      answers.set(currentTab, {
        answer: option.label,
        wasCustom: false,
        index: optionIndex + 1,
      });
      advanceAfter();
      return;
    }
    if (matchesKey(data, Key.escape)) {
      submit(true);
      return;
    }

    handleScrollKey(data);
  }

  const onAbort = () => {
    finish(null);
  };
  if (signal) {
    if (signal.aborted) {
      onAbort();
    } else {
      signal.addEventListener("abort", onAbort, { once: true });
    }
  }

  return {
    get focused(): boolean {
      return focused;
    },
    set focused(value: boolean) {
      focused = !!value;
      editor.focused = focused && inputMode;
    },
    render,
    handleInput,
    invalidate(): void {
      editor.invalidate();
      tui.requestRender();
    },
    dispose(): void {
      if (signal) signal.removeEventListener("abort", onAbort);
      editor.focused = false;
    },
  };
}
