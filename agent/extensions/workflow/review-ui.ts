/**
 * Review Mode — main-transcript UI.
 *
 * The reviewer runs in an in-process child session, so its output never reaches
 * the main Pi transcript by itself. This module turns that output into
 * display-only custom entries (`pi.appendEntry` + `pi.registerEntryRenderer`),
 * which are durable in the TUI and never enter LLM context — Plan Mode (and
 * later Build Mode) cannot see the reviewer's work.
 *
 * Colours: Plan Mode is `warning`, Review Mode is `accent`. `▌ REVIEW MODE`
 * and `▌ REVIEW DONE` bands mark the audit phase, so sequential review
 * sections stay distinguishable without recolouring Pi's own user/assistant
 * messages (which extensions cannot do). Ordinary mode switches (Tab) emit no
 * band at all — the footer status shows the mode — and consecutive identical
 * bands are suppressed (`createReviewBandGate`) so the transcript cannot
 * ping-pong. Everything here is display-only and best-effort: a malformed
 * entry must render something readable instead of throwing.
 */

import { truncateToWidth } from "@earendil-works/pi-tui";
import type {
  EntryRenderer,
  ThemeColor,
} from "@earendil-works/pi-coding-agent";
import {
  REVIEW_SUBMITTED_ENTRY_TYPE,
  type ReviewLineKind,
  type ReviewTranscriptOp,
} from "./review.ts";

/** Custom entry type for Plan/Review/Review-done bands. */
export const REVIEW_MODE_ENTRY_TYPE = "workflow-review-mode";
/** Custom entry type for streamed reviewer transcript chunks. */
export const REVIEW_TRANSCRIPT_ENTRY_TYPE = "workflow-review-transcript";

/** Transcript kinds plus the synthetic line for a user's routed note. */
export type ReviewEntryLineKind = ReviewLineKind | "user";

/** One rendered review line. */
export interface ReviewEntryLine {
  kind: ReviewEntryLineKind;
  text: string;
}

/** Payload of a `workflow-review-mode` band entry. */
export interface ReviewModeBandData {
  mode: "plan" | "review" | "review-done";
  at?: number;
  modelLabel?: string;
  round?: number;
  verdict?: string;
  reason?: string;
}

/** Payload of a `workflow-review-transcript` chunk entry. */
export interface ReviewTranscriptEntryData {
  at?: number;
  lines?: ReviewEntryLine[];
}

/** Flattened shape of a `workflow-review-submitted` entry (see review.ts). */
export interface ReviewSubmittedEntryData {
  planPath?: string;
  round?: number;
  verdict?: string;
  summary?: string;
  modelLabel?: string;
  findings?: Array<{
    severity?: number;
    confidence?: number;
    category?: string;
    disposition?: string;
  }>;
}

/**
 * Minimal theme surface used by the pure formatters. Structural, so Pi's real
 * `Theme` satisfies it and tests can pass a two-method double without casting.
 */
export interface ThemeLike {
  fg(color: ThemeColor, text: string): string;
  bold(text: string): string;
}

/** Minimal component shape Pi accepts from an entry renderer. */
export interface ReviewEntryComponent {
  render(width: number): string[];
  invalidate(): void;
}

// ── Band identity / dedupe ───────────────────────────────────────────

/**
 * Stable identity of a mode-band payload. Deliberately excludes `at`: a
 * timestamp changes on every emission, but two identical consecutive bands
 * (re-entering Plan mode via Tab, re-running `/review` on the same round)
 * must collapse into a single transcript entry.
 */
export function reviewBandKey(data: ReviewModeBandData | undefined): string {
  return [
    data?.mode ?? "unknown",
    data?.round ?? "",
    data?.modelLabel ?? "",
    data?.verdict ?? "",
    data?.reason ?? "",
  ].join("|");
}

/** Consecutive-duplicate gate for mode bands (see `reviewBandKey`). */
export interface ReviewBandGate {
  /** Seed the last-seen key from a restored session entry (no emit). */
  seed(data: ReviewModeBandData | undefined): void;
  /** True when this band differs from the last accepted/seeded one. */
  accept(data: ReviewModeBandData | undefined): boolean;
}

/**
 * Create a gate that suppresses a band identical to the previous one. The
 * caller seeds it from the session on restore so a `/reload` cannot re-emit
 * the newest band, then calls `accept` before every `appendEntry`.
 */
export function createReviewBandGate(): ReviewBandGate {
  let last: string | undefined;
  return {
    seed(data) {
      last = reviewBandKey(data);
    },
    accept(data) {
      const key = reviewBandKey(data);
      if (key === last) return false;
      last = key;
      return true;
    },
  };
}

// ── Buffering ────────────────────────────────────────────────────────

const DEFAULT_MAX_LINES = 2000;

export interface ReviewLineBuffer {
  /** Apply one reviewer transcript op. */
  push(op: ReviewTranscriptOp): void;
  /** Append a synthetic line (e.g. a note the user routed to the reviewer). */
  pushLine(kind: ReviewEntryLineKind, text: string): void;
  /** Remove and return complete lines; a still-growing tail stays buffered. */
  takeComplete(max?: number): ReviewEntryLine[];
  /** Finalize the tail and return every buffered line (round end / teardown). */
  flush(): ReviewEntryLine[];
  /** True once lines had to be dropped to respect the cap. */
  readonly truncated: boolean;
  readonly size: number;
  clear(): void;
}

/**
 * Coalesce reviewer transcript ops into complete, emittable lines.
 *
 * Token deltas arrive as `append` ops that may or may not contain a newline, so
 * only lines terminated by `\n` are handed out — the caller appends one entry
 * per flush and the last partial line is kept until it finishes. Bounded by
 * `maxLines`: a long review cannot grow the buffer (or the caller's memory)
 * without limit, and dropping is recorded via `truncated`.
 */
export function createReviewLineBuffer(options?: {
  maxLines?: number;
}): ReviewLineBuffer {
  const maxLines = Math.max(
    1,
    Math.trunc(options?.maxLines ?? DEFAULT_MAX_LINES),
  );
  const complete: ReviewEntryLine[] = [];
  let tail: ReviewEntryLine | undefined;
  let truncated = false;

  const cap = (): void => {
    if (complete.length > maxLines) {
      complete.splice(0, complete.length - maxLines);
      truncated = true;
    }
  };

  const commitTail = (): void => {
    if (!tail) return;
    if (tail.text.length > 0) complete.push(tail);
    tail = undefined;
    cap();
  };

  const appendText = (kind: ReviewEntryLineKind, text: string): void => {
    if (tail && tail.kind !== kind) commitTail();
    if (!tail) tail = { kind, text: "" };
    tail.text += text;
    let idx = tail.text.indexOf("\n");
    while (idx >= 0) {
      complete.push({ kind: tail.kind, text: tail.text.slice(0, idx) });
      tail.text = tail.text.slice(idx + 1);
      idx = tail.text.indexOf("\n");
    }
    cap();
  };

  return {
    push(op) {
      if (op.op === "append") {
        appendText(op.kind, op.text);
      } else {
        commitTail();
        appendText(op.kind, op.text);
      }
    },
    pushLine(kind, text) {
      commitTail();
      appendText(kind, text);
    },
    takeComplete(max) {
      const n =
        max === undefined
          ? complete.length
          : Math.max(0, Math.trunc(Number(max) || 0));
      return complete.splice(0, n);
    },
    flush() {
      commitTail();
      return complete.splice(0, complete.length);
    },
    get truncated() {
      return truncated;
    },
    get size() {
      return complete.length + (tail && tail.text.length > 0 ? 1 : 0);
    },
    clear() {
      complete.length = 0;
      tail = undefined;
      truncated = false;
    },
  };
}

// ── Formatting ───────────────────────────────────────────────────────

/**
 * Colour map for transcript lines. `text`/`thinking` are no longer produced by
 * `translateReviewEvent` (the main-transcript stream is action headers plus the
 * summary card), but they are kept so entries restored from older sessions
 * still render readably instead of throwing.
 */
const LINE_COLORS: Record<ReviewEntryLineKind, ThemeColor> = {
  text: "accent",
  thinking: "dim",
  tool: "muted",
  finding: "warning",
  notice: "warning",
  status: "muted",
  user: "success",
};

/** Colour review lines by kind; junk lines degrade to plain accent text. */
export function formatReviewTranscriptLines(
  lines: ReviewEntryLine[] | undefined,
  theme: ThemeLike,
): string[] {
  const out: string[] = [];
  for (const line of Array.isArray(lines) ? lines : []) {
    const kind = (
      line && typeof line.kind === "string" ? line.kind : "text"
    ) as ReviewEntryLineKind;
    const text = line && typeof line.text === "string" ? line.text : "";
    if (text.length === 0) continue;
    const color = LINE_COLORS[kind] ?? "accent";
    if (kind === "user") {
      out.push(theme.fg(color, theme.bold(text)));
    } else {
      out.push(theme.fg(color, text));
    }
  }
  return out;
}

/** Colour a Plan/Review/Review-done band. */
export function formatReviewModeBand(
  data: ReviewModeBandData | undefined,
  theme: ThemeLike,
): string[] {
  const mode = data?.mode;
  if (mode === "plan") {
    const title = theme.fg("warning", theme.bold("▌ PLAN MODE"));
    const hint = theme.fg(
      "muted",
      "  read-only · the reviewer audits after Plan Mode finishes",
    );
    return [title + hint];
  }
  if (mode === "review") {
    const bits: string[] = [];
    if (typeof data?.round === "number" && data.round > 1) {
      bits.push(`round ${data.round}`);
    }
    if (typeof data?.modelLabel === "string" && data.modelLabel) {
      bits.push(data.modelLabel);
    }
    bits.push("sequential audit");
    const title = theme.fg("accent", theme.bold("▌ REVIEW MODE"));
    return [title + theme.fg("muted", `  ${bits.join(" · ")}`)];
  }
  if (mode === "review-done") {
    const clean = data?.verdict === "approve" && !data?.reason;
    const color: ThemeColor = clean ? "success" : "warning";
    let detail = "";
    if (data?.reason) {
      detail = `  ${data.reason}`;
    } else if (typeof data?.verdict === "string" && data.verdict) {
      detail = `  verdict: ${data.verdict}`;
    }
    return [
      theme.fg(color, theme.bold("▌ REVIEW DONE")) + theme.fg("muted", detail),
    ];
  }
  return [theme.fg("muted", "▌ review")];
}

const MAX_SUMMARY_FINDINGS = 15;

/** Render the `workflow-review-submitted` audit entry as a dated summary card. */
export function formatReviewSubmittedEntry(
  data: ReviewSubmittedEntryData | undefined,
  theme: ThemeLike,
): string[] {
  const findings = Array.isArray(data?.findings) ? data.findings : [];
  const verdict = typeof data?.verdict === "string" ? data.verdict : "unknown";
  const color: ThemeColor = verdict === "approve" ? "success" : "warning";
  const count = `${findings.length} finding${findings.length === 1 ? "" : "s"}`;
  const model =
    typeof data?.modelLabel === "string" && data.modelLabel
      ? ` · ${data.modelLabel}`
      : "";
  const out: string[] = [
    theme.fg(color, theme.bold("▌ REVIEW SUMMARY")) +
      theme.fg("muted", `  ${verdict} · ${count}${model}`),
  ];
  if (typeof data?.summary === "string" && data.summary.trim()) {
    out.push(theme.fg("text", data.summary.trim()));
  }
  if (typeof data?.planPath === "string" && data.planPath) {
    out.push(theme.fg("muted", `plan: ${data.planPath}`));
  }
  const shown = findings.slice(0, MAX_SUMMARY_FINDINGS);
  for (const f of shown) {
    const sev = typeof f?.severity === "number" ? f.severity : 0;
    const conf = typeof f?.confidence === "number" ? f.confidence : 0;
    let sevColor: ThemeColor = "muted";
    if (sev >= 8) sevColor = "error";
    else if (sev >= 5) sevColor = "warning";
    const bits = [`sev ${sev}`, `conf ${conf}`];
    if (typeof f?.disposition === "string" && f.disposition) {
      bits.push(f.disposition);
    }
    if (typeof f?.category === "string" && f.category) bits.push(f.category);
    out.push(theme.fg(sevColor, `  • ${bits.join(" · ")}`));
  }
  if (findings.length > shown.length) {
    out.push(
      theme.fg(
        "muted",
        `  … +${findings.length - shown.length} more (see /review-status)`,
      ),
    );
  }
  return out;
}

// ── Registration ─────────────────────────────────────────────────────

/** A component over pre-formatted lines. `render` is width-bounded. */
export function createReviewEntryComponent(
  lines: string[],
): ReviewEntryComponent {
  const content = Array.isArray(lines) ? lines : [];
  return {
    render(width: number): string[] {
      const w = Math.max(1, Math.trunc(Number(width) || 80));
      return content.map((line) => truncateToWidth(line, w, "…"));
    },
    invalidate(): void {
      /* static content */
    },
  };
}

/** The subset of `ExtensionAPI` this module needs (test-friendly). */
export interface EntryRendererHost {
  registerEntryRenderer<T = unknown>(
    customType: string,
    renderer: EntryRenderer<T>,
  ): void;
}

/**
 * Register the Review Mode transcript renderers. Called once when the extension
 * loads; registering a customType again overwrites, so `/reload` is idempotent.
 */
export function registerReviewEntryRenderers(host: EntryRendererHost): void {
  host.registerEntryRenderer<ReviewModeBandData>(
    REVIEW_MODE_ENTRY_TYPE,
    (entry, _options, theme) =>
      createReviewEntryComponent(formatReviewModeBand(entry?.data, theme)),
  );
  host.registerEntryRenderer<ReviewTranscriptEntryData>(
    REVIEW_TRANSCRIPT_ENTRY_TYPE,
    (entry, _options, theme) =>
      createReviewEntryComponent(
        formatReviewTranscriptLines(entry?.data?.lines, theme),
      ),
  );
  host.registerEntryRenderer<ReviewSubmittedEntryData>(
    REVIEW_SUBMITTED_ENTRY_TYPE,
    (entry, _options, theme) =>
      createReviewEntryComponent(formatReviewSubmittedEntry(entry?.data, theme)),
  );
}
