/**
 * Workflow Extension — Review Mode main-transcript UI tests
 *
 * Run with: npm test   (node --test, type-stripping — no build step)
 *
 * Covers the display-only surface: the transcript line buffer, the styled
 * formatters for the mode bands / reviewer stream / submitted summary, the
 * band dedupe gate, the width-bounded entry component, and the renderer
 * registration.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  REVIEW_PAUSED_LINE,
  REVIEW_RUNNING_LINE,
} from "./review.ts";
import {
  createReviewBandGate,
  createReviewEntryComponent,
  createReviewLineBuffer,
  formatModelSwitchEntry,
  formatReviewModeBand,
  formatReviewSubmittedEntry,
  formatReviewTranscriptLines,
  isTerminalPiHost,
  registerReviewEntryRenderers,
  reviewBandKey,
  MODEL_SWITCH_ENTRY_TYPE,
  REVIEW_MODE_ENTRY_TYPE,
  REVIEW_TRANSCRIPT_ENTRY_TYPE,
  type EntryRendererHost,
  type ThemeLike,
} from "./review-ui.ts";

/** Theme double: wraps text in `[color]…[/]` / `<b>…</b>` for assertions. */
function fakeTheme(): ThemeLike {
  return {
    fg: (color: string, text: string) => `[${color}]${text}[/]`,
    bold: (text: string) => `<b>${text}</b>`,
  };
}

// ══ Legacy transcript kinds ═══════════════════════════════════════════

test("transcript: legacy thinking lines still render (back-compat)", () => {
  const out = formatReviewTranscriptLines(
    [
      { kind: "thinking", text: "reasoning from an older session" },
      { kind: "tool", text: "▸ read: a.ts" },
    ],
    fakeTheme(),
  );
  assert.deepEqual(out, [
    "[dim]reasoning from an older session[/]",
    "[muted]▸ read: a.ts[/]",
  ]);
  assert.deepEqual(
    formatReviewTranscriptLines([{ kind: "thinking", text: "" }], fakeTheme()),
    [],
    "empty lines are skipped",
  );
});

// ══ Buffer ════════════════════════════════════════════════════════════

test("buffer: coalesces deltas and only releases complete lines", () => {
  const b = createReviewLineBuffer({ maxLines: 10 });
  b.push({ op: "append", kind: "text", text: "hel" });
  b.push({ op: "append", kind: "text", text: "lo" });
  assert.deepEqual(b.takeComplete(), [], "no newline yet → nothing emitted");
  b.push({ op: "append", kind: "text", text: " world\n" });
  assert.deepEqual(b.takeComplete(), [
    { kind: "text", text: "hello world" },
  ]);
  b.push({ op: "append", kind: "text", text: "tail" });
  assert.deepEqual(b.flush(), [{ kind: "text", text: "tail" }]);
});

test("buffer: `new` starts a line and a kind change splits lines", () => {
  const b = createReviewLineBuffer();
  b.push({ op: "new", kind: "tool", text: "▸ read" });
  b.push({ op: "new", kind: "status", text: "reviewer started" });
  b.push({ op: "append", kind: "text", text: "hey" });
  assert.deepEqual(b.flush(), [
    { kind: "tool", text: "▸ read" },
    { kind: "status", text: "reviewer started" },
    { kind: "text", text: "hey" },
  ]);
});

test("buffer: takeComplete caps the batch but never reorders", () => {
  const b = createReviewLineBuffer({ maxLines: 100 });
  for (let i = 0; i < 5; i++) {
    b.push({ op: "new", kind: "status", text: `l${i}` });
  }
  b.push({ op: "new", kind: "text", text: "" });
  b.push({ op: "append", kind: "text", text: "growing" });
  assert.deepEqual(b.takeComplete(2), [
    { kind: "status", text: "l0" },
    { kind: "status", text: "l1" },
  ]);
  assert.deepEqual(
    b.takeComplete().map((l) => l.text),
    ["l2", "l3", "l4"],
  );
  assert.deepEqual(b.flush(), [{ kind: "text", text: "growing" }]);
});

test("buffer: cap drops oldest lines and records truncation", () => {
  const b = createReviewLineBuffer({ maxLines: 3 });
  for (let i = 0; i < 5; i++) {
    b.push({ op: "new", kind: "status", text: `l${i}` });
  }
  b.push({ op: "new", kind: "text", text: "" });
  assert.deepEqual(
    b.flush().map((l) => l.text),
    ["l2", "l3", "l4"],
  );
  assert.equal(b.truncated, true);
});

test("buffer: pushLine adds a synthetic user note; clear resets", () => {
  const b = createReviewLineBuffer({ maxLines: 2 });
  b.pushLine("user", "you → reviewer: fix X");
  assert.deepEqual(b.flush(), [
    { kind: "user", text: "you → reviewer: fix X" },
  ]);
  b.push({ op: "append", kind: "text", text: "a\nb\n" });
  assert.equal(b.size, 2, "two complete lines, empty tail not counted");
  b.clear();
  assert.equal(b.size, 0);
  assert.equal(b.truncated, false);
});

// ══ Formatters ════════════════════════════════════════════════════════

test("formatReviewTranscriptLines: colour by kind, drop empties, tolerate junk", () => {
  const theme = fakeTheme();
  const lines = formatReviewTranscriptLines(
    [
      { kind: "text", text: "reviewing" },
      { kind: "thinking", text: "hmm" },
      { kind: "tool", text: "▸ read" },
      { kind: "notice", text: "retrying" },
      { kind: "user", text: "you → reviewer: x" },
      { kind: "text", text: "" },
    ],
    theme,
  );
  assert.equal(lines.length, 5);
  assert.ok(lines[0].includes("[accent]reviewing"));
  assert.ok(lines[1].includes("[dim]hmm"));
  assert.ok(lines[2].includes("[muted]▸ read"));
  assert.ok(lines[3].includes("[warning]retrying"));
  assert.ok(lines[4].includes("[success]") && lines[4].includes("<b>"));
  assert.deepEqual(formatReviewTranscriptLines(undefined, theme), []);
  assert.deepEqual(formatReviewTranscriptLines("junk" as never, theme), []);
});

test("formatReviewModeBand: plan=warning, review=accent, done follows the verdict", () => {
  const theme = fakeTheme();
  assert.ok(
    formatReviewModeBand({ mode: "plan" }, theme)[0].includes("[warning]"),
  );
  const review = formatReviewModeBand(
    { mode: "review", round: 2, modelLabel: "p/m" },
    theme,
  )[0];
  assert.ok(review.includes("[accent]"));
  assert.ok(review.includes("round 2") && review.includes("p/m"));
  assert.ok(
    formatReviewModeBand({ mode: "review-done", verdict: "approve" }, theme)[0]
      .includes("[success]"),
  );
  const timedOut = formatReviewModeBand(
    { mode: "review-done", reason: "timeout" },
    theme,
  )[0];
  assert.ok(timedOut.includes("[warning]") && timedOut.includes("timeout"));
  // A resumed round is never rendered like a fresh flow.
  const resumed = formatReviewModeBand(
    { mode: "review", round: 1, modelLabel: "p/m", resumed: true },
    theme,
  )[0];
  assert.ok(resumed.includes("resumed"));
  assert.ok(resumed.includes("round 1"));
  assert.ok(
    !resumed.includes("sequential audit"),
    "a resume is a continuation, not a fresh audit",
  );
  // A pause is not a done band.
  const paused = formatReviewModeBand(
    { mode: "review-done", paused: true, reason: "paused — /review resume" },
    theme,
  )[0];
  assert.ok(paused.includes("REVIEW PAUSED"));
  assert.ok(!paused.includes("REVIEW DONE"));
  assert.ok(paused.includes("[warning]"));
  assert.ok(formatReviewModeBand(undefined, theme)[0].includes("[muted]"));
});

test("formatReviewSubmittedEntry: severity tiers and truncation notice", () => {
  const theme = fakeTheme();
  const findings = Array.from({ length: 17 }, (_, i) => ({
    severity: i === 0 ? 9 : i === 1 ? 6 : 2,
    confidence: 80,
    disposition: "accepted",
    category: "framework-alignment",
  }));
  const out = formatReviewSubmittedEntry(
    {
      planPath: ".pi/plans/x.md",
      verdict: "revise",
      summary: "Fixed the steps",
      findings,
    },
    theme,
  );
  assert.ok(out[0].includes("[warning]") && out[0].includes("17 findings"));
  assert.ok(out.some((l) => l.includes("Fixed the steps")));
  assert.ok(out.some((l) => l.includes(".pi/plans/x.md")));
  assert.ok(out.some((l) => l.includes("[error]")), "severity 9 is error");
  assert.ok(out.some((l) => l.includes("[warning]")), "severity 6 is warning");
  assert.ok(out.some((l) => l.includes("[muted]")), "severity 2 is muted");
  assert.ok(out.some((l) => l.includes("+2 more")));
  assert.ok(formatReviewSubmittedEntry(undefined, theme).length > 0);
});

// ══ Band identity / dedupe ════════════════════════════════════════════

test("reviewBandKey: ignores `at`, follows mode/round/verdict/reason", () => {
  assert.equal(
    reviewBandKey({ mode: "plan", at: 1 }),
    reviewBandKey({ mode: "plan", at: 999 }),
    "a timestamp must not change the identity",
  );
  assert.notEqual(
    reviewBandKey({ mode: "plan" }),
    reviewBandKey({ mode: "review" }),
  );
  assert.notEqual(
    reviewBandKey({ mode: "review", round: 1 }),
    reviewBandKey({ mode: "review", round: 2 }),
  );
  assert.notEqual(
    reviewBandKey({ mode: "review-done", verdict: "approve" }),
    reviewBandKey({ mode: "review-done", verdict: "revise" }),
  );
  assert.notEqual(
    reviewBandKey({ mode: "review-done", reason: "timeout" }),
    reviewBandKey({ mode: "review-done", reason: "failed: x" }),
  );
  assert.notEqual(
    reviewBandKey({ mode: "review", round: 1 }),
    reviewBandKey({ mode: "review", round: 1, resumed: true }),
    "a resumed band must not collapse into the fresh band it continues",
  );
  assert.notEqual(
    reviewBandKey({ mode: "review-done", reason: "paused" }),
    reviewBandKey({ mode: "review-done", reason: "paused", paused: true }),
  );
  assert.equal(reviewBandKey(undefined), "unknown||||||");
});

test("createReviewBandGate: suppresses only consecutive identical bands", () => {
  const gate = createReviewBandGate();
  assert.equal(gate.accept({ mode: "review", round: 1 }), true);
  assert.equal(
    gate.accept({ mode: "review", round: 1 }),
    false,
    "repeating the same band emits nothing",
  );
  assert.equal(gate.accept({ mode: "review-done", verdict: "approve" }), true);
  assert.equal(
    gate.accept({ mode: "review", round: 1 }),
    true,
    "alternating bands still emit",
  );
});

test("createReviewBandGate: seeded history suppresses the next match", () => {
  const gate = createReviewBandGate();
  gate.seed({ mode: "review-done", verdict: "approve" });
  assert.equal(gate.accept({ mode: "review-done", verdict: "approve" }), false);
  assert.equal(gate.accept({ mode: "review-done", verdict: "revise" }), true);
  assert.equal(gate.accept({ mode: "review-done", verdict: "revise" }), false);
});

// ══ Component + registration ══════════════════════════════════════════

test("createReviewEntryComponent: every line is width-bounded", () => {
  const c = createReviewEntryComponent(["[accent]abcdefghij[/]"]);
  const lines = c.render(5);
  assert.equal(lines.length, 1);
  assert.ok(!lines[0].includes("abcdefghij"), "content is truncated to width");
  c.invalidate();
});

test("registerReviewEntryRenderers: registers every transcript entry type", () => {
  const registered: string[] = [];
  const host: EntryRendererHost = {
    registerEntryRenderer(customType, _renderer) {
      registered.push(customType);
    },
  };
  registerReviewEntryRenderers(host);
  assert.deepEqual([...registered].sort(), [
    "workflow-handoff-plan",
    "workflow-model-switch",
    "workflow-review-mode",
    "workflow-review-submitted",
    "workflow-review-transcript",
  ]);
  assert.equal(REVIEW_MODE_ENTRY_TYPE, "workflow-review-mode");
  assert.equal(REVIEW_TRANSCRIPT_ENTRY_TYPE, "workflow-review-transcript");
  assert.equal(MODEL_SWITCH_ENTRY_TYPE, "workflow-model-switch");
});

test("registerReviewEntryRenderers: a model switch reaches the timeline", () => {
  type CapturedRenderer = (
    entry: unknown,
    options: unknown,
    theme: ThemeLike,
  ) => { render(width: number): string[] };
  const renderers = new Map<string, CapturedRenderer>();
  const host: EntryRendererHost = {
    registerEntryRenderer(customType, renderer) {
      renderers.set(customType, renderer as unknown as CapturedRenderer);
    },
  };
  registerReviewEntryRenderers(host);
  const renderer = renderers.get(MODEL_SWITCH_ENTRY_TYPE);
  assert.ok(renderer, "workflow-model-switch must have a desktop renderer");
  const component = renderer!({ data: {
    scope: "reviewer",
    from: "p/old",
    to: "p/reviewer",
    ok: true,
    changed: true,
  } }, {}, fakeTheme());
  const line = component.render(120).join("\n");
  assert.match(line, /p\/old → p\/reviewer/);
  assert.match(line, /reviewer/);
  assert.doesNotMatch(line, /undefined/);

  // A refused switch keeps BOTH model labels visible in the same row, but
  // is styled as a warning rather than a successful change.
  const refused = renderer!({ data: {
    scope: "reviewer",
    from: "p/old",
    to: "p/reviewer",
    ok: false,
    changed: false,
    error: "registry miss",
  } }, {}, fakeTheme());
  const warning = refused.render(120).join("\n");
  assert.match(warning, /p\/old/);
  assert.match(warning, /p\/reviewer/);
  assert.match(warning, /\[warning\]/);
  assert.match(warning, /registry miss/);
  assert.ok(
    formatModelSwitchEntry(undefined, fakeTheme()).length > 0,
    "a malformed/missing payload must still render something readable",
  );
});

test("review lines keep the exact 0.14.0 pause/resume/abort hints", () => {
  // The footer/status line and the controls must never disagree about the
  // public grammar: `/review pause`, `/review resume`, `/review abort`.
  assert.ok(REVIEW_RUNNING_LINE.includes("/review pause"));
  assert.ok(REVIEW_RUNNING_LINE.includes("/review abort"));
  assert.ok(REVIEW_PAUSED_LINE.includes("/review resume"));
  assert.ok(REVIEW_PAUSED_LINE.includes("/review abort"));
  for (const line of [REVIEW_RUNNING_LINE, REVIEW_PAUSED_LINE]) {
    assert.doesNotMatch(line, /\/review-(?:pause|resume|abort)\b/);
  }
});

test("isTerminalPiHost excludes every piped / Desktop host", () => {
  // Terminal Pi: an interactive TUI with a real TTY and no Desktop marker.
  assert.equal(isTerminalPiHost({ isTTY: true }), true);
  // Pi Desktop: piped stdio (host-supervisor.ts) plus its own marker.
  assert.equal(isTerminalPiHost({ isTTY: false }), false);
  assert.equal(isTerminalPiHost({}), false);
  assert.equal(
    isTerminalPiHost({ isTTY: true, desktopHostEntry: "/app/host/index.mjs" }),
    false,
    "PI_DESKTOP_HOST_ENTRY is a hard exclusion even on a TTY",
  );
  // RPC/print hosts are piped too.
  assert.equal(isTerminalPiHost({ isTTY: undefined }), false);
});
