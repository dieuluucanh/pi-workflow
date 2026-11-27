#!/usr/bin/env node
/**
 * Side-effect-free clarification presenter tests.
 *
 * The presenter sits between prompt refinement and the existing bounded
 * questionnaire view. These tests pin the contract the parent relies on:
 *
 *   - 1–4 questions, free text and suggested-option ordering;
 *   - skip / finish / cancel as distinct outcomes;
 *   - repeated rounds own no shared state;
 *   - Terminal and Desktop use the overlay adapter, RPC uses native dialogs,
 *     headless is explicitly unsupported;
 *   - overlay acquisition is always released in `finally`;
 *   - no commit/handoff/Review authority is imported or touched.
 *
 * Run: node --test clarification-presenter.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { TUI } from "@earendil-works/pi-tui";

import {
  CLARIFICATION_FREEFORM_LABEL,
  fromRefinementQuestions,
  normalizeClarificationQuestions,
  orderClarificationOptions,
  presentClarification,
  resolveClarificationCapability,
  type ClarificationComponentFactory,
  type ClarificationMode,
  type ClarificationOverlayOptions,
  type ClarificationPresenterOptions,
  type ClarificationUiHost,
} from "./clarification-presenter.ts";
import type {
  QuestionnaireTheme,
  QuestionnaireView,
} from "./questionnaire-view.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));

const THEME: QuestionnaireTheme = {
  fg: (_color, text) => text,
  bg: (_color, text) => text,
  bold: (text) => text,
};

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function fakeTui(rows = 24, columns = 80): TUI {
  return {
    terminal: { rows, columns },
    requestRender: () => {},
  } as unknown as TUI;
}

interface HostHarness {
  host: ClarificationUiHost;
  views: Array<{ view: QuestionnaireView; options?: ClarificationOverlayOptions }>;
  selects: Array<{ title: string; options: string[] }>;
  inputs: Array<{ title: string; placeholder?: string }>;
  customs: number;
  acquires: number;
  releases: number;
}

function makeHost(
  over: {
    mode?: ClarificationMode;
    hasUI?: boolean;
    selectAnswers?: Array<string | undefined>;
    inputAnswers?: Array<string | undefined>;
    dismiss?: boolean;
    customThrows?: Error;
    selectAvailable?: boolean;
    inputAvailable?: boolean;
  } = {},
): HostHarness {
  const views: HostHarness["views"] = [];
  const selects: HostHarness["selects"] = [];
  const inputs: HostHarness["inputs"] = [];
  const selectAnswers = [...(over.selectAnswers ?? [])];
  const inputAnswers = [...(over.inputAnswers ?? [])];
  const harness: HostHarness = {
    host: undefined as unknown as ClarificationUiHost,
    views,
    selects,
    inputs,
    customs: 0,
    acquires: 0,
    releases: 0,
  };

  const host: ClarificationUiHost = {
    mode: over.mode ?? "tui",
    hasUI: over.hasUI ?? true,
    custom<T>(
      factory: ClarificationComponentFactory<T>,
      options?: ClarificationOverlayOptions,
    ): Promise<T> {
      harness.customs += 1;
      if (over.customThrows) return Promise.reject(over.customThrows);
      if (over.dismiss) return Promise.resolve(undefined as unknown as T);
      return new Promise<T>((resolve) => {
        const view = factory(fakeTui(), THEME, undefined, (result) =>
          resolve(result as unknown as T),
        );
        views.push({ view, options });
      });
    },
    ...(over.selectAvailable === false
      ? {}
      : {
          async select(title: string, options: string[]) {
            selects.push({ title, options });
            return selectAnswers.shift();
          },
        }),
    ...(over.inputAvailable === false
      ? {}
      : {
          async input(title: string, placeholder?: string) {
            inputs.push({ title, placeholder });
            return inputAnswers.shift();
          },
        }),
  };
  harness.host = host;
  return harness;
}

async function present(
  questions: unknown,
  harness: HostHarness,
  extra: Partial<ClarificationPresenterOptions> = {},
) {
  const pending = presentClarification(questions, {
    host: harness.host,
    acquireOverlay: () => {
      harness.acquires += 1;
    },
    releaseOverlay: () => {
      harness.releases += 1;
    },
    ...extra,
  });
  // The presenter builds the component synchronously before its first await.
  await Promise.resolve();
  return { pending, view: harness.views[harness.views.length - 1]?.view };
}

const TWO_OPTIONS = ["Recommended", "Alternative"];

// ── 1–4 questions, finish ────────────────────────────────────────────

test("terminal: one question renders the bottom-sheet and finishes on Enter", async () => {
  const harness = makeHost();
  const { pending, view } = await present(
    [{ prompt: "Which format?", header: "Format", options: TWO_OPTIONS }],
    harness,
  );

  assert.ok(view, "the view was created");
  assert.equal(harness.customs, 1);
  const overlay = harness.views[0]?.options;
  assert.equal(overlay?.overlay, true);
  assert.deepEqual(overlay?.overlayOptions, {
    anchor: "bottom-center",
    width: "100%",
    maxHeight: "80%",
    margin: 0,
  });
  const text = stripAnsi(view!.render(80).join("\n"));
  assert.match(text, /Which format\?/);
  assert.ok(
    text.indexOf("Recommended") < text.indexOf("Alternative"),
    "suggested order is preserved",
  );

  view!.handleInput("\r");
  const outcome = await pending;
  assert.equal(outcome.kind, "finished");
  assert.deepEqual(outcome, {
    kind: "finished",
    answers: [
      {
        prompt: "Which format?",
        header: "Format",
        answer: "Recommended",
        wasCustom: false,
        index: 1,
      },
    ],
  });
  assert.equal(harness.acquires, 1);
  assert.equal(harness.releases, 1);
});

test("terminal: four questions answer in order and submit together", async () => {
  const harness = makeHost();
  const questions = [1, 2, 3, 4].map((n) => ({
    prompt: `Question ${n}?`,
    header: `Q${n}`,
    options: [`A${n}`, `B${n}`],
  }));
  const { pending, view } = await present(questions, harness);
  assert.ok(view);

  for (let i = 0; i < 4; i += 1) view!.handleInput("\r");
  view!.handleInput("\r"); // submit tab

  const outcome = await pending;
  assert.equal(outcome.kind, "finished");
  if (outcome.kind !== "finished") return;
  assert.equal(outcome.answers.length, 4);
  assert.deepEqual(
    outcome.answers.map((answer) => answer.answer),
    ["A1", "A2", "A3", "A4"],
  );
  assert.deepEqual(
    outcome.answers.map((answer) => answer.header),
    ["Q1", "Q2", "Q3", "Q4"],
  );
});

test("terminal: free text is captured as a custom answer", async () => {
  const harness = makeHost();
  const { pending, view } = await present(
    [{ prompt: "How should it read?", options: ["Keep", "Rewrite"] }],
    harness,
  );
  assert.ok(view);

  view!.handleInput("\x1b[B"); // Alternative
  view!.handleInput("\x1b[B"); // Type something.
  view!.handleInput("\r");
  for (const char of "make it shorter") view!.handleInput(char);
  view!.handleInput("\r");

  const outcome = await pending;
  assert.equal(outcome.kind, "finished");
  if (outcome.kind !== "finished") return;
  assert.deepEqual(outcome.answers, [
    {
      prompt: "How should it read?",
      answer: "make it shorter",
      wasCustom: true,
      index: 3,
    },
  ]);
});

// ── Skip / cancel / abort ────────────────────────────────────────────

test("skip: a dismissed overlay is not a cancel and not an answer", async () => {
  const harness = makeHost({ dismiss: true });
  const outcome = await presentClarification(
    [{ prompt: "Anything?", options: TWO_OPTIONS }],
    {
      host: harness.host,
      acquireOverlay: () => {
        harness.acquires += 1;
      },
      releaseOverlay: () => {
        harness.releases += 1;
      },
    },
  );
  assert.deepEqual(outcome, { kind: "skipped", reason: "dismissed" });
  assert.equal(harness.acquires, 1);
  assert.equal(harness.releases, 1);
});

test("cancel: Esc returns a user cancel, not a finished answer", async () => {
  const harness = makeHost();
  const { pending, view } = await present(
    [{ prompt: "Proceed?", options: TWO_OPTIONS }],
    harness,
  );
  assert.ok(view);
  view!.handleInput("\x1b");
  assert.deepEqual(await pending, { kind: "cancelled", reason: "user" });
});

test("cancel: an aborted signal releases the overlay in finally", async () => {
  const harness = makeHost();
  const controller = new AbortController();
  const { pending, view } = await present(
    [{ prompt: "Proceed?", options: TWO_OPTIONS }],
    harness,
    { signal: controller.signal },
  );
  assert.ok(view);
  controller.abort();
  assert.deepEqual(await pending, { kind: "cancelled", reason: "aborted" });
  assert.equal(harness.releases, 1);
});

test("cancel: an already-aborted signal opens no overlay", async () => {
  const harness = makeHost();
  const controller = new AbortController();
  controller.abort();
  const outcome = await presentClarification(
    [{ prompt: "Proceed?", options: TWO_OPTIONS }],
    { host: harness.host, signal: controller.signal },
  );
  assert.deepEqual(outcome, { kind: "cancelled", reason: "aborted" });
  assert.equal(harness.customs, 0);
  assert.equal(harness.acquires, 0);
});

// ── Repeat rounds and focus ──────────────────────────────────────────

test("repeat rounds: sequential presentations share no state and balance overlays", async () => {
  const harness = makeHost();

  const first = await present(
    [{ prompt: "First?", options: ["First A", "First B"] }],
    harness,
  );
  first.view!.handleInput("\r");
  const firstOutcome = await first.pending;

  const second = await present(
    [{ prompt: "Second?", options: ["Second A", "Second B"] }],
    harness,
  );
  second.view!.handleInput("\x1b[B");
  second.view!.handleInput("\r");
  const secondOutcome = await second.pending;

  assert.equal(harness.views.length, 2);
  assert.notEqual(first.view, second.view);
  assert.equal(harness.acquires, 2);
  assert.equal(harness.releases, 2);
  assert.equal(firstOutcome.kind, "finished");
  assert.equal(secondOutcome.kind, "finished");
  if (firstOutcome.kind === "finished" && secondOutcome.kind === "finished") {
    assert.equal(firstOutcome.answers[0]?.answer, "First A");
    assert.equal(secondOutcome.answers[0]?.answer, "Second B");
  }
});

test("keyboard focus: the presented view is focusable and types into the editor", async () => {
  const harness = makeHost();
  const { pending, view } = await present(
    [{ prompt: "Focus?", options: TWO_OPTIONS }],
    harness,
  );
  assert.ok(view);
  assert.equal(view!.focused, false);
  view!.focused = true;
  assert.equal(view!.focused, true);

  view!.handleInput("\x1b[B");
  view!.handleInput("\x1b[B");
  view!.handleInput("\r");
  for (const char of "focused text") view!.handleInput(char);
  assert.match(
    stripAnsi(view!.render(80).join("\n")),
    /focused text/,
    "the keyboard-focused view received the typed text",
  );
  view!.handleInput("\r");

  const outcome = await pending;
  assert.equal(outcome.kind, "finished");
  if (outcome.kind === "finished") {
    assert.equal(outcome.answers[0]?.answer, "focused text");
  }
});

// ── Adapters ─────────────────────────────────────────────────────────

test("capability: auto/surface/mode map to terminal, desktop, rpc and headless", () => {
  assert.equal(
    resolveClarificationCapability({ mode: "tui", hasUI: true }),
    "terminal",
  );
  assert.equal(
    resolveClarificationCapability({ mode: "tui", hasUI: true }, "desktop"),
    "desktop",
  );
  assert.equal(
    resolveClarificationCapability({ mode: "rpc", hasUI: true }),
    "rpc",
  );
  assert.equal(
    resolveClarificationCapability({ mode: "print", hasUI: false }),
    "headless",
  );
  assert.equal(
    resolveClarificationCapability({ mode: "tui", hasUI: false }),
    "headless",
  );
});

test("capability: explicit mode/hasUI rescue the real Terminal host shape", async () => {
  // Real Terminal `ctx.ui` exposes neither `mode` nor `hasUI` (the SDK keeps
  // both on the session context). Without the explicit options the presenter
  // used to call a working TUI headless and never show a question.
  const harness = makeHost();
  const bareHost = { ...harness.host } as Record<string, unknown>;
  delete bareHost.mode;
  delete bareHost.hasUI;
  harness.host = bareHost as unknown as ClarificationUiHost;
  assert.equal(
    resolveClarificationCapability(harness.host as never),
    "headless",
    "the bare host shape is genuinely headless-looking",
  );
  const { pending, view } = await present(
    [{ prompt: "Real terminal question?", options: TWO_OPTIONS }],
    harness,
    { mode: "tui", hasUI: true },
  );
  assert.ok(view, "the explicit mode must open the terminal overlay");
  assert.equal(harness.customs, 1);
  view!.handleInput("\r");
  const outcome = await pending;
  assert.equal(outcome.kind, "finished");
});

test("desktop: the emulated TUI surface uses the same overlay adapter", async () => {
  const harness = makeHost();
  const { pending, view } = await present(
    [{ prompt: "Desktop?", options: TWO_OPTIONS }],
    harness,
    { surface: "desktop" },
  );
  assert.ok(view);
  assert.equal(harness.customs, 1);
  assert.equal(harness.views[0]?.options?.overlay, true);
  view!.handleInput("\r");
  const outcome = await pending;
  assert.equal(outcome.kind, "finished");
  if (outcome.kind === "finished") {
    assert.equal(outcome.answers[0]?.answer, "Recommended");
  }
});

test("rpc: native dialogs ask each question and use the freeform input", async () => {
  const harness = makeHost({
    mode: "rpc",
    selectAnswers: ["Use JSON", CLARIFICATION_FREEFORM_LABEL],
    inputAnswers: ["custom scope"],
  });
  const outcome = await presentClarification(
    [
      {
        questionId: "q-format",
        prompt: "Format?",
        options: ["Use JSON", { label: "Use YAML", recommended: true }],
      },
      {
        questionId: "q-scope",
        prompt: "Scope?",
        options: ["Whole file", "Selection"],
      },
    ],
    { host: harness.host },
  );

  assert.equal(outcome.kind, "finished");
  assert.equal(harness.customs, 0, "RPC never opens a custom component");
  assert.deepEqual(harness.selects[0]?.options, [
    "Use YAML",
    "Use JSON",
    CLARIFICATION_FREEFORM_LABEL,
  ]);
  assert.deepEqual(harness.inputs, [
    { title: "Scope?", placeholder: "Type your answer" },
  ]);
  if (outcome.kind !== "finished") return;
  assert.deepEqual(outcome.answers, [
    {
      questionId: "q-format",
      prompt: "Format?",
      answer: "Use JSON",
      wasCustom: false,
      index: 2,
    },
    {
      questionId: "q-scope",
      prompt: "Scope?",
      answer: "custom scope",
      wasCustom: true,
      index: 3,
    },
  ]);
});

test("rpc: a host without select reports unsupported instead of guessing", async () => {
  const harness = makeHost({ mode: "rpc", selectAvailable: false });
  const outcome = await presentClarification(
    [{ prompt: "Format?", options: TWO_OPTIONS }],
    { host: harness.host },
  );
  assert.deepEqual(outcome, {
    kind: "unsupported",
    capability: "rpc",
    reason: "no-native-dialog",
  });
  assert.equal(harness.customs, 0);
});

test("headless: print/json hosts report unsupported and never call the UI", async () => {
  const harness = makeHost({ mode: "print", hasUI: false });
  const outcome = await presentClarification(
    [{ prompt: "Format?", options: TWO_OPTIONS }],
    { host: harness.host },
  );
  assert.deepEqual(outcome, {
    kind: "unsupported",
    capability: "headless",
    reason: "headless",
  });
  assert.equal(harness.customs, 0);
  assert.equal(harness.acquires, 0);
  assert.equal(harness.selects.length, 0);
});

// ── Validation / ordering / failure ──────────────────────────────────

test("validation: 0 or 5 questions, an empty prompt or no options are invalid", async () => {
  const harness = makeHost();
  for (const questions of [
    [],
    Array.from({ length: 5 }, (_, index) => ({
      prompt: `Q${index + 1}?`,
      options: TWO_OPTIONS,
    })),
    [{ prompt: "   ", options: TWO_OPTIONS }],
    [{ prompt: "No options?", options: [] }],
    [{ prompt: "Only freeform?", options: ["Other", "Type something."] }],
  ]) {
    const outcome = await presentClarification(questions, {
      host: harness.host,
      acquireOverlay: () => {
        harness.acquires += 1;
      },
      releaseOverlay: () => {
        harness.releases += 1;
      },
    });
    assert.equal(outcome.kind, "invalid");
  }
  assert.equal(harness.customs, 0);
  assert.equal(harness.acquires, 0);
});

test("ordering: recommended rows hoist while every other suggested order is kept", () => {
  assert.deepEqual(
    orderClarificationOptions(["B", "A", "C"]).map((option) => option.label),
    ["B", "A", "C"],
  );
  assert.deepEqual(
    orderClarificationOptions([
      { label: "B" },
      { label: "A", recommended: true },
      { label: "C" },
    ]).map((option) => option.label),
    ["A", "B", "C"],
  );
  assert.deepEqual(
    orderClarificationOptions(["B", "Other", "Type something.", "A"]).map(
      (option) => option.label,
    ),
    ["B", "A"],
    "freeform aliases are stripped so the view does not render them twice",
  );
});

test("adapters: RefinementQuestion[] maps to presenter questions", () => {
  const [question] = fromRefinementQuestions([
    {
      questionId: "clarify-1",
      prompt: "What changed?",
      options: ["Add tests", "Refactor only"],
    },
  ]);
  assert.deepEqual(question, {
    questionId: "clarify-1",
    prompt: "What changed?",
    options: [{ label: "Add tests" }, { label: "Refactor only" }],
  });
  const normalized = normalizeClarificationQuestions([question]);
  assert.equal(normalized.ok, true);
});

test("failure: a host throw becomes a failed outcome and still releases the overlay", async () => {
  const harness = makeHost({ customThrows: new Error("host exploded") });
  const outcome = await presentClarification(
    [{ prompt: "Format?", options: TWO_OPTIONS }],
    {
      host: harness.host,
      acquireOverlay: () => {
        harness.acquires += 1;
      },
      releaseOverlay: () => {
        harness.releases += 1;
      },
    },
  );
  assert.deepEqual(outcome, { kind: "failed", reason: "host exploded" });
  assert.equal(harness.acquires, 1);
  assert.equal(harness.releases, 1);
});

// ── No commit / handoff / Review authority ───────────────────────────

test("authority: the presenter imports and touches no commit/handoff/Review state", () => {
  const source = fs.readFileSync(
    path.join(HERE, "clarification-presenter.ts"),
    "utf8",
  );
  for (const forbidden of [
    "commit-policy",
    "armCommitAuthorization",
    "commitAuthorization",
    "pendingCommitFlow",
    "handoff-",
    "review-",
    "review.ts",
  ]) {
    assert.ok(
      !source.includes(forbidden),
      `presenter must not reference ${forbidden}`,
    );
  }
});

test("authority: a finished outcome is a plain value with no tool-result shape", async () => {
  const harness = makeHost();
  const { pending, view } = await present(
    [{ prompt: "Format?", options: TWO_OPTIONS }],
    harness,
  );
  assert.ok(view);
  view!.handleInput("\r");
  const outcome = await pending;
  assert.deepEqual(Object.keys(outcome).sort(), ["answers", "kind"]);
  assert.equal(harness.selects.length, 0);
  assert.equal(harness.inputs.length, 0);
});
