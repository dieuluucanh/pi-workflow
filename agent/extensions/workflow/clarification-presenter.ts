/**
 * Workflow Extension — side-effect-free clarification presenter.
 *
 * Prompt refinement needs to ask the user 1–4 clarifying questions, but it
 * must NOT go through the model-facing `questionnaire` tool: that wrapper also
 * arms commit authorization and reports results as tool content. This module is
 * the parent-owned presentation seam instead:
 *
 *   - it renders the existing bounded bottom-sheet (`questionnaire-view.ts` /
 *     `questionnaire-layout.ts`) — no second UI implementation;
 *   - it never imports or touches commit, handoff or Review authority, and it
 *     exposes no tool-result shape;
 *   - overlay ownership stays with the caller: `acquireOverlay` /
 *     `releaseOverlay` bracket the presentation and release runs in `finally`;
 *   - cancellation is a first-class outcome, driven by the caller's
 *     `AbortSignal` or by the view's own Esc handling.
 *
 * Hosts differ, so the presenter dispatches through capability adapters:
 *
 *   - `terminal` — `ctx.ui.custom` overlay (interactive TUI);
 *   - `desktop`  — the same emulated TUI surface/`ctx.ui.custom` overlay;
 *   - `rpc`      — sequential **native dialogs** (`select` + `input`), because
 *                  RPC has `hasUI` but no custom-component surface;
 *   - `headless` — explicit `unsupported`; it never fabricates answers.
 *
 * The presenter is stateless: repeated rounds create a fresh component, hold no
 * module-level overlay depth and leak no answers between calls.
 */

import type { TUI } from "@earendil-works/pi-tui";

import { QUESTIONNAIRE_OVERLAY_MAX_HEIGHT } from "./questionnaire-layout.ts";
import {
  createQuestionnaireView,
  normalizeFreeform,
  type QuestionnaireQuestion,
  type QuestionnaireResult,
  type QuestionnaireTheme,
  type QuestionnaireView,
} from "./questionnaire-view.ts";

// ── Public types ─────────────────────────────────────────────────────

/** Where a clarification can actually be shown. */
export type ClarificationCapability =
  | "terminal"
  | "desktop"
  | "rpc"
  | "headless";

/** Which host surface the caller knows it is running on. */
export type ClarificationSurface = "auto" | "terminal" | "desktop";

/** Pi's run modes (mirrored structurally so this module needs no SDK import). */
export type ClarificationMode = "tui" | "rpc" | "json" | "print";

export interface ClarificationOption {
  label: string;
  description?: string;
  /**
   * Marks a model suggestion as the recommendation. Recommended rows are
   * hoisted to the front while every other row keeps its original order.
   */
  recommended?: boolean;
}

/**
 * One clarification question. `options` may be plain labels or objects, and
 * the freeform ("Type something.") row is always appended by the presenter —
 * callers must not add their own freeform alias.
 */
export interface ClarificationQuestionInput {
  /** Stable id from `prompt-refinement-state.ts` (`RefinementQuestion`). */
  questionId?: string;
  prompt: string;
  header?: string;
  context?: string;
  options: Array<string | ClarificationOption>;
}

export interface ClarificationAnswer {
  questionId?: string;
  prompt: string;
  header?: string;
  answer: string;
  wasCustom: boolean;
  /** 1-based option row, when the answer came from a listed option. */
  index?: number;
}

export type ClarificationOutcome =
  | { kind: "finished"; answers: ClarificationAnswer[] }
  | { kind: "skipped"; reason: "dismissed" }
  | { kind: "cancelled"; reason: "user" | "aborted" }
  | {
      kind: "unsupported";
      capability: ClarificationCapability;
      reason: "headless" | "no-native-dialog";
    }
  | { kind: "invalid"; reason: string }
  | { kind: "failed"; reason: string };

// ── Host contract ────────────────────────────────────────────────────

export interface ClarificationOverlayOptions {
  overlay?: boolean;
  overlayOptions?: {
    anchor?: string;
    width?: string | number;
    maxHeight?: string | number;
    margin?: number;
  };
  blocked?: { kind: string; message: string };
}

/** The component factory `ctx.ui.custom` accepts (structurally narrowed). */
export type ClarificationComponentFactory<T> = (
  tui: TUI,
  theme: QuestionnaireTheme,
  keybindings: unknown,
  done: (result: T) => void,
) => QuestionnaireView;

/**
 * The minimal parent UI surface. The real `ctx.ui` satisfies it; a Build child
 * bridge (`orchestrator-child-ui.ts`) also satisfies it.
 */
export interface ClarificationUiHost {
  readonly mode: ClarificationMode;
  readonly hasUI: boolean;
  custom<T>(
    factory: ClarificationComponentFactory<T>,
    options?: ClarificationOverlayOptions,
  ): Promise<T>;
  select?(
    title: string,
    options: string[],
    opts?: unknown,
  ): Promise<string | undefined>;
  input?(
    title: string,
    placeholder?: string,
    opts?: unknown,
  ): Promise<string | undefined>;
}

export interface ClarificationPresenterOptions {
  host: ClarificationUiHost;
  /**
   * The live Pi run mode. Real Terminal `ctx.ui` exposes no `mode` (the SDK
   * puts it on the session context), so a caller that knows the mode must pass
   * it; without it a real TUI is misread as headless and questions are never
   * shown.
   */
  mode?: ClarificationMode;
  /**
   * The live `hasUI` fact. Real Terminal puts it on the session context
   * (`ctx.hasUI`), not on `ctx.ui`, so the presenter cannot read it from the
   * injected host object either.
   */
  hasUI?: boolean;
  /** Host surface hint; `auto` (default) follows `mode` + `hasUI`. */
  surface?: ClarificationSurface;
  /**
   * Parent-owned overlay stack. The presenter only brackets its own overlay;
   * the caller keeps the counter, so two presenters can never both clobber it.
   */
  acquireOverlay?: () => void;
  releaseOverlay?: () => void;
  /** Caller cancellation. An abort before start never opens an overlay. */
  signal?: AbortSignal;
  /** Hard caps; defaults are 4 questions and 8 options per question. */
  maxQuestions?: number;
  maxOptions?: number;
  /** Test seam; production uses the real bounded bottom-sheet view. */
  createView?: typeof createQuestionnaireView;
}

// ── Constants ────────────────────────────────────────────────────────

export const CLARIFICATION_MAX_QUESTIONS = 4;
export const CLARIFICATION_MAX_OPTIONS = 8;
/** Always appended by the view / native dialog; callers must not add it. */
export const CLARIFICATION_FREEFORM_LABEL = "Type something.";

/**
 * Mirrors the aliases the questionnaire view treats as its freeform row, so a
 * caller-supplied "Other" never renders twice in the native-dialog adapter.
 */
const FREEFORM_ALIASES = new Set([
  "type something",
  "type something else",
  "other",
  "other (please specify)",
  "other please specify",
]);

// ── Capability + ordering helpers ────────────────────────────────────

export function resolveClarificationCapability(
  host: Pick<ClarificationUiHost, "mode" | "hasUI">,
  surface: ClarificationSurface = "auto",
): ClarificationCapability {
  if (!host.hasUI) return "headless";
  if (host.mode === "rpc") return "rpc";
  if (host.mode !== "tui") return "headless";
  if (surface === "desktop") return "desktop";
  return "terminal";
}

/**
 * Stable recommendation hoist: options explicitly marked `recommended` move to
 * the front in their original relative order; every other option keeps the
 * model's suggested order.
 */
export function orderClarificationOptions(
  options: ReadonlyArray<string | ClarificationOption>,
): ClarificationOption[] {
  const normalized: ClarificationOption[] = [];
  for (const option of options) {
    const label =
      typeof option === "string" ? option : String(option.label ?? "");
    if (!label.trim()) continue;
    if (FREEFORM_ALIASES.has(normalizeFreeform(label))) continue;
    normalized.push({
      label,
      ...(typeof option === "string" || option.description === undefined
        ? {}
        : { description: option.description }),
      ...(typeof option === "string" || option.recommended !== true
        ? {}
        : { recommended: true }),
    });
  }
  const recommended = normalized.filter((option) => option.recommended);
  const rest = normalized.filter((option) => !option.recommended);
  return [...recommended, ...rest];
}

export function clarificationOverlayOptions(
  capability: ClarificationCapability,
): ClarificationOverlayOptions {
  // Terminal and Desktop both host the component as the same bottom sheet;
  // Desktop's emulated TUI surface renders `ctx.ui.custom` in its dialog dock.
  void capability;
  return {
    overlay: true,
    overlayOptions: {
      anchor: "bottom-center",
      width: "100%",
      maxHeight: QUESTIONNAIRE_OVERLAY_MAX_HEIGHT,
      margin: 0,
    },
  };
}

/** Adapt prompt-refinement's `RefinementQuestion[]` without importing it. */
export function fromRefinementQuestions(
  questions: ReadonlyArray<{
    questionId?: string;
    prompt: string;
    options: readonly string[];
  }>,
): ClarificationQuestionInput[] {
  return questions.map((question) => ({
    ...(question.questionId ? { questionId: question.questionId } : {}),
    prompt: question.prompt,
    options: question.options.map((label) => ({ label })),
  }));
}

// ── Validation ───────────────────────────────────────────────────────

interface NormalizedQuestions {
  inputs: ClarificationQuestionInput[];
  questions: QuestionnaireQuestion[];
}

export function normalizeClarificationQuestions(
  input: unknown,
  options: { maxQuestions?: number; maxOptions?: number } = {},
): { ok: true; value: NormalizedQuestions } | { ok: false; reason: string } {
  const maxQuestions = options.maxQuestions ?? CLARIFICATION_MAX_QUESTIONS;
  const maxOptions = options.maxOptions ?? CLARIFICATION_MAX_OPTIONS;
  if (!Array.isArray(input)) {
    return { ok: false, reason: "questions must be an array" };
  }
  if (input.length === 0) {
    return { ok: false, reason: "at least one question is required" };
  }
  if (input.length > maxQuestions) {
    return {
      ok: false,
      reason: `at most ${maxQuestions} questions are allowed`,
    };
  }

  const inputs: ClarificationQuestionInput[] = [];
  const questions: QuestionnaireQuestion[] = [];

  for (let index = 0; index < input.length; index += 1) {
    const raw = input[index] as Partial<ClarificationQuestionInput> | undefined;
    if (!raw || typeof raw !== "object") {
      return { ok: false, reason: `question ${index + 1} must be an object` };
    }
    const prompt = typeof raw.prompt === "string" ? raw.prompt : "";
    if (!prompt.trim()) {
      return { ok: false, reason: `question ${index + 1} needs a prompt` };
    }
    if (!Array.isArray(raw.options)) {
      return { ok: false, reason: `question ${index + 1} needs options[]` };
    }
    const ordered = orderClarificationOptions(raw.options).slice(0, maxOptions);
    if (ordered.length === 0) {
      return {
        ok: false,
        reason: `question ${index + 1} needs at least one option`,
      };
    }
    const header =
      typeof raw.header === "string" && raw.header.trim()
        ? raw.header
        : undefined;
    const context =
      typeof raw.context === "string" && raw.context.length > 0
        ? raw.context
        : undefined;

    inputs.push({
      ...(raw.questionId ? { questionId: raw.questionId } : {}),
      prompt,
      ...(header === undefined ? {} : { header }),
      ...(context === undefined ? {} : { context }),
      options: ordered,
    });
    questions.push({
      question: prompt,
      ...(header === undefined ? {} : { header }),
      ...(context === undefined ? {} : { context }),
      options: ordered,
    });
  }

  return { ok: true, value: { inputs, questions } };
}

// ── Outcome mapping ──────────────────────────────────────────────────

function answersFromResult(
  inputs: ClarificationQuestionInput[],
  result: QuestionnaireResult,
): ClarificationAnswer[] {
  return inputs.map((input, index) => {
    const answer = result.answers?.[index];
    return {
      ...(input.questionId ? { questionId: input.questionId } : {}),
      prompt: input.prompt,
      ...(input.header === undefined ? {} : { header: input.header }),
      answer: answer?.answer ?? "",
      wasCustom: answer?.wasCustom === true,
      ...(answer?.index === undefined ? {} : { index: answer.index }),
    };
  });
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error) return error;
  return "clarification presentation failed";
}

// ── Adapters ─────────────────────────────────────────────────────────

async function presentWithView(
  normalized: NormalizedQuestions,
  options: ClarificationPresenterOptions,
): Promise<ClarificationOutcome> {
  const createView = options.createView ?? createQuestionnaireView;

  let result: QuestionnaireResult | null;
  try {
    result = await options.host.custom<QuestionnaireResult | null>(
      (tui, theme, _keybindings, done) =>
        createView(tui, theme, {
          questions: normalized.questions,
          done,
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        }),
      clarificationOverlayOptions("terminal"),
    );
  } catch (error) {
    return { kind: "failed", reason: errorMessage(error) };
  }

  if (options.signal?.aborted) {
    return { kind: "cancelled", reason: "aborted" };
  }
  if (!result) {
    return { kind: "skipped", reason: "dismissed" };
  }
  if (result.cancelled) {
    return { kind: "cancelled", reason: "user" };
  }
  return {
    kind: "finished",
    answers: answersFromResult(normalized.inputs, result),
  };
}

async function presentWithNativeDialog(
  normalized: NormalizedQuestions,
  options: ClarificationPresenterOptions,
): Promise<ClarificationOutcome> {
  const { host } = options;
  const select = host.select;
  if (typeof select !== "function") {
    return {
      kind: "unsupported",
      capability: "rpc",
      reason: "no-native-dialog",
    };
  }

  const answers: ClarificationAnswer[] = [];
  for (const input of normalized.inputs) {
    if (options.signal?.aborted) {
      return { kind: "cancelled", reason: "aborted" };
    }
    const labels = input.options.map((option) =>
      typeof option === "string" ? option : option.label,
    );
    let picked: string | undefined;
    try {
      picked = await select.call(host, input.prompt, [
        ...labels,
        CLARIFICATION_FREEFORM_LABEL,
      ]);
    } catch (error) {
      return { kind: "failed", reason: errorMessage(error) };
    }

    if (options.signal?.aborted) {
      return { kind: "cancelled", reason: "aborted" };
    }
    if (picked === undefined || picked === null) {
      return { kind: "skipped", reason: "dismissed" };
    }

    const knownIndex = labels.indexOf(picked);
    if (knownIndex >= 0) {
      answers.push({
        ...(input.questionId ? { questionId: input.questionId } : {}),
        prompt: input.prompt,
        ...(input.header === undefined ? {} : { header: input.header }),
        answer: picked,
        wasCustom: false,
        index: knownIndex + 1,
      });
      continue;
    }

    const typeInput = host.input;
    if (typeof typeInput !== "function") {
      return {
        kind: "unsupported",
        capability: "rpc",
        reason: "no-native-dialog",
      };
    }
    let typed: string | undefined;
    try {
      typed = await typeInput.call(host, input.prompt, "Type your answer");
    } catch (error) {
      return { kind: "failed", reason: errorMessage(error) };
    }
    if (options.signal?.aborted) {
      return { kind: "cancelled", reason: "aborted" };
    }
    if (typed === undefined) {
      return { kind: "cancelled", reason: "user" };
    }
    answers.push({
      ...(input.questionId ? { questionId: input.questionId } : {}),
      prompt: input.prompt,
      ...(input.header === undefined ? {} : { header: input.header }),
      answer: typed.trim() || "(no response)",
      wasCustom: true,
      index: labels.length + 1,
    });
  }

  return { kind: "finished", answers };
}

// ── Entry point ──────────────────────────────────────────────────────

/**
 * Present a clarification round and resolve one typed outcome. Never throws
 * and never mutates caller state outside the injected overlay callbacks.
 *
 * Overlay ownership: `acquireOverlay` runs immediately before the TUI overlay
 * is requested, and `releaseOverlay` runs in `finally` on every path — finish,
 * skip, cancel, validation failure after acquisition or a host throw.
 */
export async function presentClarification(
  questions: unknown,
  options: ClarificationPresenterOptions,
): Promise<ClarificationOutcome> {
  const normalized = normalizeClarificationQuestions(questions, {
    ...(options.maxQuestions === undefined
      ? {}
      : { maxQuestions: options.maxQuestions }),
    ...(options.maxOptions === undefined
      ? {}
      : { maxOptions: options.maxOptions }),
  });
  if (!normalized.ok) {
    return { kind: "invalid", reason: normalized.reason };
  }

  if (options.signal?.aborted) {
    return { kind: "cancelled", reason: "aborted" };
  }

  const capability = resolveClarificationCapability(
    {
      mode: options.mode ?? options.host.mode,
      hasUI: options.hasUI ?? options.host.hasUI,
    },
    options.surface ?? "auto",
  );

  if (capability === "headless") {
    return { kind: "unsupported", capability, reason: "headless" };
  }

  if (capability === "rpc") {
    return presentWithNativeDialog(normalized.value, options);
  }

  // Terminal and Desktop both own one overlay slot; the caller's counter is
  // bracketed here, never re-implemented inside the presenter.
  options.acquireOverlay?.();
  try {
    return await presentWithView(normalized.value, options);
  } finally {
    options.releaseOverlay?.();
  }
}
