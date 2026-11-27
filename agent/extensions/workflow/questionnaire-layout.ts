/**
 * Questionnaire viewport geometry and scroll state.
 *
 * This module is deliberately pure: no Pi runtime imports and no pi-tui
 * imports. The questionnaire view is rendered as a flat component (the host's
 * input dock treats the editor container as a leaf, so an inner layout node
 * would be ignored), which means the view must bound its own height and slice
 * its panes by hand. Keeping that math here makes it deterministic and easy to
 * unit-test.
 */

/** Hard cap for the questionnaire's rendered height. */
export const QUESTIONNAIRE_MAX_TOTAL_ROWS = 32;

/** Share of the terminal height the bottom-sheet overlay is allowed to use. */
export const QUESTIONNAIRE_MAX_FRACTION = 0.8;

/**
 * The `overlayOptions.maxHeight` string used by the questionnaire host.
 * Keep in sync with `QUESTIONNAIRE_MAX_FRACTION` (the view caps at
 * `floor(rows * fraction) - 1`, so it is always inside the overlay).
 */
export const QUESTIONNAIRE_OVERLAY_MAX_HEIGHT = "80%";

/** A question longer than this is not pinned above the scroll body. */
export const QUESTIONNAIRE_MAX_PINNED_QUESTION_LINES = 3;

/** Maximum logical answer lines shown under the freeform row. */
export const QUESTIONNAIRE_MAX_ANSWER_PREVIEW_LINES = 2;

/**
 * Maximum number of lines the questionnaire may render for a terminal with
 * `termRows` rows. Always at least 1 and always at most the overlay's
 * `floor(termRows * 0.8)` (minus a one-line safety margin), so the overlay's
 * own `maxHeight` slice can never cut the pinned choices.
 */
export function questionnaireMaxRows(termRows: number): number {
  // A zero/undefined/negative terminal height is not meaningful; fall back to
  // a typical 24-row terminal instead of collapsing the UI to one line.
  const raw = Number.isFinite(termRows) && termRows > 0 ? termRows : 24;
  const rows = Math.max(1, Math.floor(raw));
  const overlayMax = Math.max(
    1,
    Math.floor(rows * QUESTIONNAIRE_MAX_FRACTION),
  );
  return Math.max(
    1,
    Math.min(QUESTIONNAIRE_MAX_TOTAL_ROWS, overlayMax - 1),
  );
}

export interface QuestionnaireBudgetInput {
  termRows: number;
  /** Height of the top border / tab row. */
  topHeight: number;
  /** Height of a pinned short question (including its trailing blank). */
  pinnedHeight: number;
  /** Height of the help / status / bottom border block. */
  bottomHeight: number;
  /** Full height of the question/context (or answers summary) body. */
  questionContentHeight: number;
  /** Full height of the option list (or editor pane). */
  optionsContentHeight: number;
  /** Input mode: give the editor pane every row it can use. */
  editorPriority?: boolean;
  minQuestionRows?: number;
  minOptionRows?: number;
  /** Optional lower cap (never raises the host cap). */
  maxTotalRows?: number;
}

export interface QuestionnaireBudget {
  /** top + pinned + question + options + bottom. */
  total: number;
  /** Viewport height for the question/context body. */
  question: number;
  /** Viewport height for the option list / editor pane. */
  options: number;
  questionOverflow: boolean;
  optionsOverflow: boolean;
}

function toSize(value: number | undefined, fallback = 0): number {
  if (!Number.isFinite(value as number)) return fallback;
  return Math.max(0, Math.floor(value as number));
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Allocate the available rows between the scrolling question body and the
 * pinned option list.
 *
 * The options are the controls, so they are kept intact whenever they fit
 * alongside the minimum question height. When both bodies overflow, the
 * question gets roughly 40% and the options the rest; the selected option is
 * kept visible by `keepRangeVisible`, and the option list scrolls when even
 * that is not enough. The returned `total` is the exact rendered height
 * assuming the caller has already trimmed its chrome below `questionnaireMaxRows`.
 */
export function computeQuestionnaireBudget(
  input: QuestionnaireBudgetInput,
): QuestionnaireBudget {
  const hostCap = questionnaireMaxRows(input.termRows);
  const cap = Math.min(
    hostCap,
    toSize(input.maxTotalRows, QUESTIONNAIRE_MAX_TOTAL_ROWS),
  );
  const top = toSize(input.topHeight);
  const pinned = toSize(input.pinnedHeight);
  const bottom = toSize(input.bottomHeight);
  const fixed = top + pinned + bottom;
  const avail = Math.max(0, cap - fixed);
  const questionContent = toSize(input.questionContentHeight);
  const optionsContent = toSize(input.optionsContentHeight);

  if (avail === 0) {
    return {
      total: fixed,
      question: 0,
      options: 0,
      questionOverflow: questionContent > 0,
      optionsOverflow: optionsContent > 0,
    };
  }

  const minQuestion = Math.min(
    avail,
    toSize(input.minQuestionRows, 2),
  );
  const minOptions = Math.min(avail, toSize(input.minOptionRows, 2));

  let question: number;
  let options: number;

  if (input.editorPriority) {
    // The editor is the thing the user is typing into: show all of it that
    // fits, then give any remainder to the question/context.
    options = Math.min(optionsContent, avail);
    question = Math.min(questionContent, Math.max(0, avail - options));
  } else if (optionsContent <= Math.max(0, avail - minQuestion)) {
    // The choices fit while reserving the minimum question area.
    options = optionsContent;
    question = Math.min(questionContent, Math.max(0, avail - options));
  } else {
    // Both need to scroll. The choices keep a larger share (they are the
    // controls); the selected row is auto-scrolled by the caller.
    question = Math.min(
      questionContent,
      Math.max(minQuestion, Math.floor(avail * 0.4)),
    );
    options = Math.min(optionsContent, Math.max(0, avail - question));
    // If the question still has slack, honor the minimum option height so
    // the pinned choice block does not collapse to a single clipped row.
    const targetOptions = Math.min(minOptions, optionsContent);
    if (options < targetOptions && question > minQuestion) {
      const shift = Math.min(question - minQuestion, targetOptions - options);
      question -= shift;
      options += shift;
    }
    if (options === 0 && optionsContent > 0 && avail > 0) {
      options = Math.min(1, avail);
      question = Math.max(0, avail - options);
    }
  }

  // Defensive clamps: never exceed the available content/space and never
  // return a fractional or negative height.
  question = clamp(question, 0, Math.min(questionContent, avail));
  options = clamp(options, 0, Math.min(optionsContent, avail - question));

  return {
    total: fixed + question + options,
    question,
    options,
    questionOverflow: question < questionContent,
    optionsOverflow: options < optionsContent,
  };
}

/** A manually-sliced viewport: which line range of a body is visible. */
export interface ScrollPane {
  scrollTop: number;
  contentHeight: number;
  viewportHeight: number;
}

export function createScrollPane(): ScrollPane {
  return { scrollTop: 0, contentHeight: 0, viewportHeight: 0 };
}

/** Largest valid `scrollTop` for the pane's current content/viewport. */
export function maxScrollTop(pane: ScrollPane): number {
  const content = toSize(pane.contentHeight);
  const viewport = toSize(pane.viewportHeight);
  return Math.max(0, content - viewport);
}

/** Recompute the pane's dimensions and clamp `scrollTop` into range. */
export function updateScrollPane(
  pane: ScrollPane,
  contentHeight: number,
  viewportHeight: number,
): void {
  pane.contentHeight = toSize(contentHeight);
  pane.viewportHeight = toSize(viewportHeight);
  const top = Number.isFinite(pane.scrollTop) ? pane.scrollTop : 0;
  pane.scrollTop = clamp(Math.floor(top), 0, maxScrollTop(pane));
}

/** Set the pane's scroll position, clamped to its current limits. */
export function scrollPaneTo(pane: ScrollPane, scrollTop: number): void {
  const next = Number.isFinite(scrollTop) ? Math.floor(scrollTop) : 0;
  pane.scrollTop = clamp(next, 0, maxScrollTop(pane));
}

/** Scroll the pane by `delta` lines (positive = down). */
export function scrollPaneBy(pane: ScrollPane, delta: number): void {
  const step = Number.isFinite(delta) ? Math.trunc(delta) : 0;
  scrollPaneTo(pane, pane.scrollTop + step);
}

/** Inclusive-exclusive line range in a body. */
export interface LineRange {
  start: number;
  end: number;
}

/**
 * Return the scrollTop that keeps `range` visible.
 *
 * - A range that fits is fully shown.
 * - A range taller than the viewport keeps the current scrollTop when it is
 *   already inside the range, so a long selected description can be read
 *   instead of snapping back to its first line.
 * - Out-of-range values are clamped to the pane.
 */
export function keepRangeVisible(pane: ScrollPane, range: LineRange): number {
  const content = toSize(pane.contentHeight);
  const viewport = toSize(pane.viewportHeight);
  const maxTop = Math.max(0, content - viewport);
  const current = clamp(toSize(pane.scrollTop), 0, maxTop);

  if (viewport <= 0 || content <= 0) return 0;

  const rawStart = Math.min(range.start, range.end);
  const rawEnd = Math.max(range.start, range.end);
  const start = clamp(toSize(rawStart), 0, content);
  const end = clamp(toSize(rawEnd), start, content);

  // Already fully visible.
  if (start >= current && end <= current + viewport) return current;

  // Taller than the viewport: stay inside the range if possible, otherwise
  // show its first line.
  if (end - start > viewport) {
    if (current >= start && current <= end - viewport) return current;
    return clamp(start, 0, maxTop);
  }

  // Above the viewport.
  if (start < current) return clamp(start, 0, maxTop);

  // Below the viewport; scrolling to `end - viewport` shows the whole range.
  if (end > current + viewport) return clamp(end - viewport, 0, maxTop);

  return current;
}

/**
 * Parse a wheel event into a line delta (+3 = down, -3 = up, 0 = not a wheel).
 * Supports SGR (`\x1b[<64;x;yM`) and X10 (`\x1b[M` + 3 bytes) sequences.
 * Horizontal wheel events (66/67) are ignored.
 */
export function parseWheelScroll(data: string): number {
  if (!data) return 0;

  const sgr = /\x1b\[<(\d+);\d+;\d+[Mm]/.exec(data);
  if (sgr) {
    const button = Number(sgr[1]);
    if (button === 64) return -3;
    if (button === 65) return 3;
    return 0;
  }

  const x10 = data.indexOf("\x1b[M");
  if (x10 >= 0 && data.length >= x10 + 6) {
    const button = data.charCodeAt(x10 + 3) - 32;
    if (button === 64) return -3;
    if (button === 65) return 3;
  }

  return 0;
}

/** Human-readable position, e.g. `1–12/42` (empty content → `0/0`). */
export function formatScrollPosition(pane: ScrollPane): string {
  const content = toSize(pane.contentHeight);
  if (content <= 0) return "0/0";
  const viewport = toSize(pane.viewportHeight);
  const maxTop = Math.max(0, content - viewport);
  const top = clamp(toSize(pane.scrollTop), 0, maxTop);
  const first = Math.min(content, top + 1);
  const last = Math.min(content, top + Math.max(1, viewport));
  return `${first}–${last}/${content}`;
}

/**
 * Split text into at most `maxLines` display lines for the inline
 * "↳ Your answer" preview, with a rough character wrap. The caller should
 * still truncate/format each line to the real terminal width; this helper only
 * guarantees the preview's line cap and reports how many lines were hidden.
 */
export function previewTextLines(
  text: string,
  width: number,
  maxLines: number,
): { lines: string[]; hidden: number } {
  const safeWidth = Math.max(1, toSize(width, 1));
  const max = Math.max(0, toSize(maxLines, 0));
  const wrapped: string[] = [];

  for (const raw of String(text ?? "").split(/\r?\n/)) {
    if (raw.length === 0) {
      wrapped.push("");
      continue;
    }
    let rest = raw;
    while (rest.length > safeWidth) {
      wrapped.push(rest.slice(0, safeWidth));
      rest = rest.slice(safeWidth);
    }
    wrapped.push(rest);
  }

  const lines = wrapped.slice(0, max);
  return { lines, hidden: Math.max(0, wrapped.length - lines.length) };
}
