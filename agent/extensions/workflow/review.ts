/**
 * Workflow Extension — Review Mode
 *
 * A second, independent reviewer agent that supervises Plan Mode:
 *
 *   Plan Mode (main session)  ──plan file──▶  Review Mode (child session)
 *          ▲                                        │
 *          │ feedback                               │ rewrites the plan
 *          │                                        ▼
 *      Plannotator webview  ◀────────────  reviewed plan + change log
 *
 * Design rules (see docs/plans/2026-09-18-review-mode-dual-plan.md):
 *
 * - Review Mode is TOGGLEABLE. When disabled, the plan/build flow is
 *   byte-for-byte the behaviour that existed before this module.
 * - Review Mode runs in its OWN in-process session (own context, own model,
 *   own system prompt). It reads Plan Mode's context but never the reverse.
 * - Review Mode is read-only except for one write path: `review_submit_plan`
 *   (implemented in the parent, not in the child).
 * - This module holds the pure, I/O-light parts (config, prompt, state,
 *   validation, rendering) so they can be unit-tested without a Pi runtime.
 *   Nothing here imports the Pi SDK at module scope.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import {
  getUtcDatePrefix,
  isPlanWritePath,
  normalizePlanPath,
  planHash,
  reviewNeedsVerification,
  validateReviewedPlan,
  type ReviewDisposition,
  type ReviewFinding,
  type ReviewTier,
} from "./utils.ts";

// Re-exported so `review.ts` is the single import surface for Review Mode.
export type { ReviewDisposition, ReviewFinding, ReviewTier };
export { planHash, reviewNeedsVerification, validateReviewedPlan };

/** Pi's project config directory. Mirrors CONFIG_DIR_NAME without importing Pi at module scope. */
export const WORKFLOW_CONFIG_DIR = ".pi";

/** Top-level key in settings.json that namespaces all workflow settings. */
export const WORKFLOW_SETTINGS_KEY = "workflow";

/** Nested key under WORKFLOW_SETTINGS_KEY. */
export const REVIEW_MODE_KEY = "reviewMode";

/** Custom entry type used to persist review state across reload/resume. */
export const REVIEW_ENTRY_TYPE = "workflow-review";
export const REVIEW_SUBMITTED_ENTRY_TYPE = "workflow-review-submitted";
export const REVIEW_HANDOFF_ENTRY_TYPE = "workflow-review-handoff";

// ── Step 2: Review Mode configuration ────────────────────────────────

export type ReviewFallbackOnError = "skip" | "block";

export interface ReviewModeConfig {
  /** Master toggle. When false every Review Mode code path is a no-op. */
  enabled: boolean;
  /**
   * true  → spawn the reviewer when Plan Mode starts and let it explore
   *         concurrently; its review pass fires when the plan file lands.
   * false → start the reviewer only when the plan is ready (sequential).
   */
  parallel: boolean;
  /** Max Review↔Plan rounds per user-feedback cycle. */
  rounds: number;
  /** 1 = review + rewrite only. 2 = review + rewrite, then self-verify. */
  passes: number;
  /** Run the self-verification pass (only when pass 1 found severity >= 5). */
  verify: boolean;
  /** Open the dual-pane overlay automatically when a review starts. */
  autoOpenPane: boolean;
  /** What to do if the reviewer model is unavailable or the review fails. */
  fallbackOnError: ReviewFallbackOnError;
  /** Max `review_explore` subagents per review round (cost ceiling). */
  exploreBudget: number;
  /** Wall-clock cap for a single review round, in milliseconds. */
  timeoutMs: number;
}

export const DEFAULT_REVIEW_MODE_CONFIG: Readonly<ReviewModeConfig> = {
  enabled: false,
  parallel: true,
  rounds: 1,
  passes: 2,
  verify: true,
  autoOpenPane: true,
  fallbackOnError: "skip",
  exploreBudget: 3,
  timeoutMs: 10 * 60 * 1000,
};

const ROUNDS_MIN = 1;
const ROUNDS_MAX = 5;
const PASSES_MIN = 1;
const PASSES_MAX = 2;
const EXPLORE_MIN = 0;
const EXPLORE_MAX = 8;
const TIMEOUT_MIN = 30_000;
const TIMEOUT_MAX = 3_600_000;

/** A JSON object parsed from an untrusted source (settings file, fragment). */
export type JsonObject = Record<string, unknown>;

/**
 * A raw `workflow.reviewMode` fragment. `true` is accepted as shorthand for
 * `{ enabled: true }` so a minimal settings file stays readable.
 */
export type RawReviewModeSetting = JsonObject | boolean;

function clampInt(
  value: unknown,
  min: number,
  max: number,
  fallback: number,
): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

function asBool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

/**
 * Coerce an untrusted settings fragment into a complete ReviewModeConfig.
 * Accepts an object, or the boolean shorthand `true`/`false` for
 * `{ enabled: true }` / `{ enabled: false }`. Invalid fields fall back to
 * `base` (defaults). Never throws.
 */
export function coerceReviewModeConfig(
  raw: unknown,
  base: ReviewModeConfig = DEFAULT_REVIEW_MODE_CONFIG as ReviewModeConfig,
): ReviewModeConfig {
  if (typeof raw === "boolean") return { ...base, enabled: raw };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ...base };
  }
  const r = raw as Record<string, unknown>;
  const fallbackOnError: ReviewFallbackOnError =
    r.fallbackOnError === "block" || r.fallbackOnError === "skip"
      ? r.fallbackOnError
      : base.fallbackOnError;
  return {
    enabled: asBool(r.enabled, base.enabled),
    parallel: asBool(r.parallel, base.parallel),
    rounds: clampInt(r.rounds, ROUNDS_MIN, ROUNDS_MAX, base.rounds),
    passes: clampInt(r.passes, PASSES_MIN, PASSES_MAX, base.passes),
    verify: asBool(r.verify, base.verify),
    autoOpenPane: asBool(r.autoOpenPane, base.autoOpenPane),
    fallbackOnError,
    exploreBudget: clampInt(
      r.exploreBudget,
      EXPLORE_MIN,
      EXPLORE_MAX,
      base.exploreBudget,
    ),
    timeoutMs: clampInt(r.timeoutMs, TIMEOUT_MIN, TIMEOUT_MAX, base.timeoutMs),
  };
}

/** Extract the `workflow.reviewMode` fragment from a raw settings object. */
export function extractReviewModeRaw(
  settings: unknown,
): RawReviewModeSetting | undefined {
  if (!settings || typeof settings !== "object" || Array.isArray(settings))
    return undefined;
  const wf = (settings as JsonObject)[WORKFLOW_SETTINGS_KEY];
  if (!wf || typeof wf !== "object" || Array.isArray(wf)) return undefined;
  const raw = (wf as JsonObject)[REVIEW_MODE_KEY];
  if (typeof raw === "boolean") return raw;
  if (raw && typeof raw === "object" && !Array.isArray(raw))
    return raw as JsonObject;
  return undefined;
}

/**
 * Merge global then project settings fragments, then coerce onto defaults.
 * Project wins field-by-field over global; global wins over defaults.
 */
export function mergeReviewModeConfig(
  globalRaw: unknown,
  projectRaw: unknown,
): ReviewModeConfig {
  const fromGlobal = coerceReviewModeConfig(globalRaw);
  return coerceReviewModeConfig(projectRaw, fromGlobal);
}

export interface ReviewConfigPaths {
  global: string;
  project: string;
}

/**
 * Settings file locations. `agentDir` is passed in rather than read from the
 * Pi SDK so this stays pure and testable.
 */
export function reviewConfigPaths(
  cwd: string,
  agentDir: string,
): ReviewConfigPaths {
  return {
    global: path.join(agentDir, "settings.json"),
    project: path.join(cwd, WORKFLOW_CONFIG_DIR, "settings.json"),
  };
}

function readJsonSafe(fp: string): JsonObject | undefined {
  try {
    if (!fs.existsSync(fp)) return undefined;
    const parsed: unknown = JSON.parse(fs.readFileSync(fp, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return undefined;
    return parsed as JsonObject;
  } catch {
    return undefined;
  }
}

export interface ResolvedReviewConfig {
  config: ReviewModeConfig;
  /** Which files contributed (for /review-mode status and debugging). */
  sources: { global: boolean; project: boolean };
}

/**
 * Resolve the effective Review Mode config from disk.
 * Never throws — a corrupt or missing file falls back to defaults.
 */
export function readReviewModeConfig(
  cwd: string,
  agentDir: string,
): ResolvedReviewConfig {
  const paths = reviewConfigPaths(cwd, agentDir);
  const globalSettings = readJsonSafe(paths.global);
  const projectSettings = readJsonSafe(paths.project);
  const config = mergeReviewModeConfig(
    extractReviewModeRaw(globalSettings),
    extractReviewModeRaw(projectSettings),
  );
  return {
    config,
    sources: {
      global: extractReviewModeRaw(globalSettings) !== undefined,
      project: extractReviewModeRaw(projectSettings) !== undefined,
    },
  };
}

/**
 * The single gate used by every Review Mode hook.
 * Never throws.
 */
export function isReviewEnabled(cwd: string, agentDir: string): boolean {
  try {
    return readReviewModeConfig(cwd, agentDir).config.enabled;
  } catch {
    return false;
  }
}

/**
 * Read-modify-write `workflow.reviewMode` into a settings file, preserving
 * every other key in that file (Pi owns settings.json — we must not clobber it).
 */
export function writeReviewModeConfig(
  scope: "global" | "project",
  cwd: string,
  agentDir: string,
  patch: Partial<ReviewModeConfig>,
): { path: string; ok: boolean; error?: string } {
  const paths = reviewConfigPaths(cwd, agentDir);
  const fp = scope === "project" ? paths.project : paths.global;
  try {
    const existing = readJsonSafe(fp);
    const root: JsonObject = existing ? { ...existing } : {};
    const wfExisting = root[WORKFLOW_SETTINGS_KEY];
    const wf: JsonObject =
      wfExisting && typeof wfExisting === "object" && !Array.isArray(wfExisting)
        ? { ...(wfExisting as JsonObject) }
        : {};
    const current = coerceReviewModeConfig(wf[REVIEW_MODE_KEY]);
    const next = coerceReviewModeConfig({ ...current, ...patch }, current);
    wf[REVIEW_MODE_KEY] = next;
    root[WORKFLOW_SETTINGS_KEY] = wf;
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, JSON.stringify(root, null, 2) + "\n", "utf8");
    return { path: fp, ok: true };
  } catch (e: unknown) {
    return {
      path: fp,
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

// ── Step 3: Review prompt resolution ─────────────────────────────────

/**
 * Built-in reviewer guidance. The resolved prompt is appended to the
 * reviewer's SYSTEM prompt inside the child session only — it is never
 * injected into the parent (Plan Mode) context.
 */
export const DEFAULT_REVIEW_PROMPT = [
  "Always align with the existing project framework and industry best practice.",
  "",
  "Your job is to independently audit a plan that another agent produced, then",
  "rewrite it so it is correct, complete, and idiomatic for THIS repository.",
  "",
  "Review criteria, in priority order:",
  "",
  "1. Framework alignment — does the plan follow the conventions, module layout,",
  "   naming, error-handling style, and dependency choices already established in",
  "   this codebase? Prefer the repo's own patterns over novel ones. Call out every",
  "   divergence explicitly.",
  "2. Industry best practice — correctness, security, error handling, testability,",
  "   observability, performance, and migration/rollback safety. Cite the specific",
  "   practice when you flag a gap.",
  "3. Requirement coverage — every requirement in the shared context must map to at",
  "   least one plan step. A requirement with no step is a Critical finding.",
  "4. Executability — each step must be concrete enough to implement without",
  "   guessing: file paths, symbols, and a verifiable outcome.",
  "5. Simplicity — remove unnecessary steps, speculative abstractions, and work that",
  "   is out of scope for the stated goal.",
  "",
  "Rules:",
  "",
  "- You may READ anything: files, git history, docs, tests, prior plans.",
  "- You may NOT write code or modify any file. The ONLY write you may perform is",
  "  submitting the revised plan through `review_submit_plan`.",
  "- Never invent files, APIs, or conventions. Verify with read/grep/find/ls first.",
  "- If the plan is already sound, say so and submit it unchanged rather than",
  "  inventing findings to look useful.",
  "- Preserve the original plan's structure and the author's intent. Adjust; do not",
  "  replace it with your own different plan.",
  "- Keep the plan's existing heading style so its steps remain machine-extractable.",
].join("\n");

export interface ReviewPromptPaths {
  global: string;
  project: string;
}

export function reviewPromptPaths(
  cwd: string,
  agentDir: string,
): ReviewPromptPaths {
  return {
    global: path.join(agentDir, "review-prompt.md"),
    project: path.join(cwd, WORKFLOW_CONFIG_DIR, "review-prompt.md"),
  };
}

function readTextSafe(fp: string): string | undefined {
  try {
    if (!fs.existsSync(fp)) return undefined;
    const text = fs.readFileSync(fp, "utf8");
    return text.trim() ? text : undefined;
  } catch {
    return undefined;
  }
}

export type ReviewPromptSource = "project" | "global" | "default";

export interface ResolvedReviewPrompt {
  text: string;
  source: ReviewPromptSource;
  path?: string;
}

/**
 * Resolve the user's reviewer guidance: project file wins over global file
 * wins over the built-in default. Never throws.
 */
export function resolveReviewPrompt(
  cwd: string,
  agentDir: string,
): ResolvedReviewPrompt {
  const paths = reviewPromptPaths(cwd, agentDir);
  const project = readTextSafe(paths.project);
  if (project) {
    return { text: project, source: "project", path: paths.project };
  }
  const global = readTextSafe(paths.global);
  if (global) {
    return { text: global, source: "global", path: paths.global };
  }
  return { text: DEFAULT_REVIEW_PROMPT, source: "default" };
}

/**
 * Write user reviewer guidance to the project or global prompt file.
 * Returns the path written, or an error — never throws.
 */
export function writeReviewPrompt(
  scope: "global" | "project",
  text: string,
  cwd: string,
  agentDir: string,
): { path: string; ok: boolean; error?: string } {
  const paths = reviewPromptPaths(cwd, agentDir);
  const fp = scope === "project" ? paths.project : paths.global;
  try {
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, text.endsWith("\n") ? text : text + "\n", "utf8");
    return { path: fp, ok: true };
  } catch (e: unknown) {
    return {
      path: fp,
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

// ── Step 5: Review Mode state ────────────────────────────────────────

/** Lifecycle phase of the reviewer session. */
export type ReviewPhase =
  | "idle"
  | "starting"
  | "exploring"
  | "reviewing"
  | "verifying"
  | "rewriting"
  | "done"
  | "failed"
  | "aborted";

/** The reviewer's overall judgement of the plan. */
export type ReviewVerdict = "approve" | "revise" | "block";

/** Where a review transcript line came from. */
export type ReviewLineKind =
  | "text"
  | "thinking"
  | "tool"
  | "finding"
  | "notice"
  | "status";

/** One line in the reviewer pane. Kept small: the pane renders these verbatim. */
export interface ReviewTranscriptLine {
  kind: ReviewLineKind;
  text: string;
  /** Unix ms. */
  at: number;
}

/** The reviewer's structured output for one pass. */
export interface ReviewPassResult {
  pass: 1 | 2;
  verdict: ReviewVerdict;
  findings: ReviewFinding[];
  /** Free-text notes the reviewer added alongside the structured findings. */
  notes?: string;
  /** Unix ms. */
  at: number;
}

/** Full Review Mode runtime state (persisted on every phase boundary). */
export interface ReviewState {
  phase: ReviewPhase;
  /** 1-based round within the current user-feedback cycle. */
  round: number;
  /** 1-based pass within the current round. */
  pass: 1 | 2;
  /** Hash of the plan revision under review (see planHash). */
  planHash: string;
  /** Plan path being reviewed/rewritten. */
  planPath?: string;
  /** `provider/id` of the reviewer model, for display + provenance. */
  modelLabel: string;
  findings: ReviewFinding[];
  verdict?: ReviewVerdict;
  /** The rewritten plan, once submitted. */
  rewrittenPlan?: string;
  /** Reviewer passes completed in this round. */
  passes: ReviewPassResult[];
  /** Number of `review_explore` subagents used this round. */
  exploreUsed: number;
  /** Input tokens reported by the child session, when available. */
  tokenEstimate?: number;
  startedAt: number;
  finishedAt?: number;
  error?: string;
}

/** A fresh state object for a new round. */
export function createReviewState(init: {
  planHash: string;
  planPath?: string;
  modelLabel: string;
  round?: number;
  now?: number;
}): ReviewState {
  const now = init.now ?? Date.now();
  return {
    phase: "idle",
    round: Math.max(1, Math.trunc(init.round ?? 1)),
    pass: 1,
    planHash: init.planHash,
    planPath: init.planPath,
    modelLabel: init.modelLabel,
    findings: [],
    passes: [],
    exploreUsed: 0,
    startedAt: now,
  };
}

/** Elapsed wall-clock for the current round, in ms. */
export function reviewElapsedMs(
  state: ReviewState,
  now: number = Date.now(),
): number {
  const end = state.finishedAt ?? now;
  return Math.max(0, end - state.startedAt);
}

/** Short human label for a phase, used by the status widget and `/review-status`. */
export function reviewPhaseLabel(phase: ReviewPhase): string {
  switch (phase) {
    case "idle":
      return "idle";
    case "starting":
      return "starting";
    case "exploring":
      return "exploring";
    case "reviewing":
      return "reviewing";
    case "verifying":
      return "verifying";
    case "rewriting":
      return "rewriting";
    case "done":
      return "done";
    case "failed":
      return "failed";
    case "aborted":
      return "aborted";
    default:
      return "idle";
  }
}

/** True while the reviewer is actively working (used to gate the overlay). */
export function reviewIsActive(phase: ReviewPhase): boolean {
  return (
    phase === "starting" ||
    phase === "exploring" ||
    phase === "reviewing" ||
    phase === "verifying" ||
    phase === "rewriting"
  );
}

/**
 * One-line summary for the status strip / notify calls.
 * Example: `🔍 review · pass 2/2 · 3 findings · ● verifying`
 */
export function reviewStateSummary(state: ReviewState | undefined): string {
  if (!state) return "";
  const bits: string[] = [];
  bits.push(`pass ${state.pass}/2`);
  if (state.round > 1) bits.push(`round ${state.round}`);
  const n = state.findings.length;
  bits.push(`${n} finding${n === 1 ? "" : "s"}`);
  if (reviewIsActive(state.phase))
    bits.push(`● ${reviewPhaseLabel(state.phase)}`);
  else if (state.phase === "done") bits.push("✓ done");
  else if (state.phase !== "idle") bits.push(reviewPhaseLabel(state.phase));
  return `🔍 review · ${bits.join(" · ")}`;
}

/**
 * Outcome of one Plan↔Review round, handed back to the handoff orchestrator.
 *
 * `fallback: true` means "the reviewer did not produce a usable rewrite —
 * continue with the author's plan" (see config.fallbackOnError).
 */
export interface ReviewRoundResult {
  ok: boolean;
  fallback: boolean;
  /** The plan to hand to the user (reviewed when ok, original otherwise). */
  planText: string;
  planHash: string;
  state: ReviewState;
  reason?: string;
}

const DISPOSITIONS: readonly ReviewDisposition[] = [
  "accepted",
  "rejected",
  "deferred",
];

function clampNumber(
  value: unknown,
  min: number,
  max: number,
  fallback: number,
): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

function str(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

export interface SanitizeFindingsOptions {
  /** Cap on findings kept, to bound the changelog and prompt size. */
  max?: number;
  /** How to treat a finding with a missing/unknown disposition. */
  defaultDisposition?: ReviewDisposition;
}

/**
 * Coerce the model's submitted findings into well-formed ReviewFinding values.
 *
 * Findings arrive from an LLM, so nothing here is trusted: severities are
 * clamped to 1-10, confidences to 0-100, dispositions restricted to the three
 * known values, and text fields trimmed. Entries that cannot yield a summary
 * are dropped rather than rendered as empty bullets. Never throws.
 */
export function sanitizeFindings(
  raw: unknown,
  opts: SanitizeFindingsOptions = {},
): ReviewFinding[] {
  const max = Number.isFinite(opts.max) ? Math.max(0, Number(opts.max)) : 50;
  const defaultDisposition = opts.defaultDisposition ?? "accepted";
  if (!Array.isArray(raw)) return [];
  const out: ReviewFinding[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const f = item as Record<string, unknown>;
    const summary = str(f.summary).replace(/\s+/g, " ").trim();
    if (!summary) continue;
    const disposition = DISPOSITIONS.includes(
      f.disposition as ReviewDisposition,
    )
      ? (f.disposition as ReviewDisposition)
      : defaultDisposition;
    const file = str(f.file).trim();
    const lineRange = str(f.lineRange).trim();
    const finding: ReviewFinding = {
      id: str(f.id).trim() || `F${out.length + 1}`,
      severity: clampNumber(f.severity, 1, 10, 5),
      confidence: clampNumber(f.confidence, 0, 100, 60),
      category: str(f.category).trim() || "general",
      summary,
      rationale: str(f.rationale).replace(/\s+/g, " ").trim(),
      disposition,
    };
    if (file) finding.file = file;
    if (lineRange) finding.lineRange = lineRange;
    out.push(finding);
    if (out.length >= max) break;
  }
  return out;
}

// ── Steps 12-13: apply a submitted plan ──────────────────────────────

/** Minimal Pi surface used when publishing a reviewed plan (keeps this testable). */
export interface ReviewEntrySink {
  appendEntry: (customType: string, data?: unknown) => void;
}

export interface ApplySubmittedPlanOptions {
  cwd: string;
  /** The plan path Plan Mode chose, absolute or cwd-relative. */
  planPath: string;
  /** planBody + `## Review changes` appendix (what gets written). */
  planText: string;
  planBody: string;
  verdict: ReviewVerdict;
  summary: string;
  findings: ReviewFinding[];
  round: number;
  modelLabel: string;
  pi: ReviewEntrySink;
  notify?: (message: string, level?: "info" | "warning" | "error") => void;
}

export interface ApplySubmittedPlanResult {
  ok: boolean;
  path: string;
  /** True when the date prefix was corrected to today (UTC). */
  corrected: boolean;
  error?: string;
}

/**
 * Steps 12-13: write the reviewed plan over Plan Mode's plan file and record it.
 *
 * Step 12 — the reviewer adjusts the SAME file Plan Mode wrote. It never picks
 * a new slug: `normalizePlanPath` owns the `.pi/plans/<UTC-date>-<slug>.md`
 * convention, so the plan the user reviews in Plannotator is the plan history
 * they already have. A defense-in-depth guard refuses any path outside
 * `.pi/plans/`, so even a compromised reviewer tool call cannot write elsewhere.
 *
 * Step 13 — appends a `workflow-review-submitted` entry (not part of the LLM
 * context) so `/review-status`, resume, and post-hoc inspection can see what was
 * submitted, and notifies the user once.
 *
 * Never throws; failures are returned so the caller can fall back.
 */
export function applySubmittedPlan(
  options: ApplySubmittedPlanOptions,
): ApplySubmittedPlanResult {
  const today = getUtcDatePrefix();
  const normalized = normalizePlanPath(options.planPath, options.cwd, today);
  const relOrAbs = normalized.path;

  // Defense in depth: Review Mode may only ever write inside .pi/plans/.
  if (!isPlanWritePath(relOrAbs, options.cwd)) {
    return {
      ok: false,
      path: relOrAbs,
      corrected: normalized.corrected,
      error: `refusing to write outside .pi/plans/ (${relOrAbs})`,
    };
  }

  const abs = path.isAbsolute(relOrAbs)
    ? relOrAbs
    : path.join(options.cwd, relOrAbs);

  try {
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, options.planText, "utf8");
  } catch (e: unknown) {
    return {
      ok: false,
      path: abs,
      corrected: normalized.corrected,
      error: e instanceof Error ? e.message : String(e),
    };
  }

  try {
    options.pi.appendEntry(REVIEW_SUBMITTED_ENTRY_TYPE, {
      at: Date.now(),
      planPath: abs,
      round: options.round,
      verdict: options.verdict,
      summary: options.summary,
      modelLabel: options.modelLabel,
      planHash: planHash(options.planBody),
      planChars: options.planText.length,
      findings: options.findings.map((f) => ({
        id: f.id,
        severity: f.severity,
        confidence: f.confidence,
        category: f.category,
        disposition: f.disposition,
      })),
      correctedDatePrefix: normalized.corrected,
    });
  } catch {
    /* the write succeeded; a failed audit entry must not invalidate it */
  }

  try {
    options.notify?.(
      `Review Mode submitted the plan (${options.verdict}, ${options.findings.length} finding${
        options.findings.length === 1 ? "" : "s"
      })`,
      "info",
    );
  } catch {
    /* notifications are best-effort */
  }

  return { ok: true, path: abs, corrected: normalized.corrected };
}

// ── Step 14: pass gate ───────────────────────────────────────────────

/**
 * Step 14 — the handshake between the reviewer's tool calls and the
 * orchestrator, so pass 1 → pass 2 advances deterministically instead of the
 * orchestrator guessing from prose.
 *
 * Both waits are edge-tolerant: whichever happens first (the tool call or the
 * await) wins, and a wait that starts after the event resolves immediately.
 * That matters because a fast reviewer can call `review_submit_plan` and
 * `review_pass_done` in the same turn, before the orchestrator awaits.
 *
 * Every wait is bounded by a timeout and an AbortSignal, so a reviewer that
 * never calls its tools cannot hang the plan handoff (risk R7).
 */
export interface ReviewRoundGate {
  /** Clear both slots for a new round/pass. */
  reset(): void;
  notifySubmitted(payload: ReviewSubmitPayloadLike): void;
  notifyPassDone(result: ReviewPassResult): void;
  lastSubmitted(): ReviewSubmitPayloadLike | undefined;
  lastPassDone(): ReviewPassResult | undefined;
  waitForSubmit(
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<ReviewSubmitPayloadLike | undefined>;
  waitForPassDone(
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<ReviewPassResult | undefined>;
}

/**
 * The subset of a submission the gate needs. `review-tools.ts` builds the full
 * payload; the gate stays independent of it to avoid a module cycle.
 */
export interface ReviewSubmitPayloadLike {
  planBody: string;
  planText: string;
  findings: ReviewFinding[];
  verdict: ReviewVerdict;
  summary: string;
  changelog: string;
}

function deferredWait<T>(
  current: () => T | undefined,
  register: (resolve: (value: T | undefined) => void) => void,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<T | undefined> {
  const existing = current();
  if (existing !== undefined) return Promise.resolve(existing);
  return new Promise<T | undefined>((resolve) => {
    let settled = false;
    const finish = (value: T | undefined) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(value);
    };
    const timer = setTimeout(
      () => finish(undefined),
      Math.max(1, Math.trunc(timeoutMs)),
    );
    const onAbort = () => finish(undefined);
    signal?.addEventListener("abort", onAbort, { once: true });
    register(finish);
  });
}

export function createReviewRoundGate(): ReviewRoundGate {
  let submitted: ReviewSubmitPayloadLike | undefined;
  let passDone: ReviewPassResult | undefined;
  let submitWaiters: Array<
    (value: ReviewSubmitPayloadLike | undefined) => void
  > = [];
  let passWaiters: Array<(value: ReviewPassResult | undefined) => void> = [];

  const settleWaiters = <T>(
    waiters: Array<(value: T | undefined) => void>,
    value: T,
  ): void => {
    for (const resolve of waiters.splice(0)) {
      try {
        resolve(value);
      } catch {
        /* ignore */
      }
    }
  };

  return {
    reset() {
      submitted = undefined;
      passDone = undefined;
      submitWaiters = [];
      passWaiters = [];
    },
    notifySubmitted(payload) {
      submitted = payload;
      settleWaiters(submitWaiters, payload);
    },
    notifyPassDone(result) {
      passDone = result;
      settleWaiters(passWaiters, result);
    },
    lastSubmitted: () => submitted,
    lastPassDone: () => passDone,
    waitForSubmit: (timeoutMs, signal) =>
      deferredWait<ReviewSubmitPayloadLike>(
        () => submitted,
        (resolve) => submitWaiters.push(resolve),
        timeoutMs,
        signal,
      ),
    waitForPassDone: (timeoutMs, signal) =>
      deferredWait<ReviewPassResult>(
        () => passDone,
        (resolve) => passWaiters.push(resolve),
        timeoutMs,
        signal,
      ),
  };
}

// ── Step 16: reviewer transcript stream ──────────────────────────────

/** Default cap on retained pane lines (the panes are a rolling window). */
export const MAX_REVIEW_LINES = 2000;

/**
 * A transcript mutation derived from a session event.
 *
 * Deltas are modelled as `append` rather than one line per token: the reviewer
 * streams hundreds of text deltas per message, and pushing each as its own line
 * would make the pane unreadable and the buffer useless. Coalescing is decided
 * here (pure) so the pane and the buffer cannot disagree.
 */
export type ReviewTranscriptOp =
  | { op: "append"; kind: ReviewLineKind; text: string }
  | { op: "new"; kind: ReviewLineKind; text: string };

function eventRecord(event: unknown): Record<string, unknown> | undefined {
  if (!event || typeof event !== "object") return undefined;
  return event as Record<string, unknown>;
}

/**
 * Translate one child-session event into transcript operations.
 *
 * Only the event kinds that make a readable review transcript are surfaced;
 * token accounting, queue churn and compaction internals are dropped so the pane
 * shows reasoning, tool use and status rather than plumbing.
 */
export function translateReviewEvent(event: unknown): ReviewTranscriptOp[] {
  const e = eventRecord(event);
  if (!e) return [];
  const type = typeof e.type === "string" ? e.type : "";

  if (type === "message_update") {
    const inner = eventRecord(e.assistantMessageEvent);
    const innerType = typeof inner?.type === "string" ? inner.type : "";
    if (innerType === "text_delta") {
      const delta = typeof inner?.delta === "string" ? inner.delta : "";
      return delta ? [{ op: "append", kind: "text", text: delta }] : [];
    }
    if (innerType === "thinking_delta") {
      const delta = typeof inner?.delta === "string" ? inner.delta : "";
      return delta ? [{ op: "append", kind: "thinking", text: delta }] : [];
    }
    return [];
  }

  if (type === "message_start") {
    const msg = eventRecord(e.message);
    const role = typeof msg?.role === "string" ? msg.role : "";
    if (role === "assistant") {
      return [{ op: "new", kind: "text", text: "" }];
    }
    return [];
  }

  if (type === "tool_execution_start") {
    const name = typeof e.toolName === "string" ? e.toolName : "tool";
    return [{ op: "new", kind: "tool", text: `▸ ${name}` }];
  }

  if (type === "tool_execution_end") {
    const name = typeof e.toolName === "string" ? e.toolName : "tool";
    const failed = e.isError === true;
    return [
      {
        op: "new",
        kind: "tool",
        text: `▸ ${name} ${failed ? "failed" : "ok"}`,
      },
    ];
  }

  if (type === "agent_start") {
    return [{ op: "new", kind: "status", text: "reviewer started" }];
  }
  if (type === "agent_end") {
    return [{ op: "new", kind: "status", text: "reviewer finished this run" }];
  }
  if (type === "auto_retry_start") {
    return [
      { op: "new", kind: "notice", text: "retrying after a provider error" },
    ];
  }

  return [];
}

/**
 * Bounded rolling buffer of pane lines.
 *
 * One buffer serves both the child transcript (right pane) and, via the same
 * API, the mirrored Plan Mode transcript (left pane). Bounding matters: a long
 * review can emit tens of thousands of deltas, and the pane must not grow
 * without limit for the life of the session.
 */
export class ReviewTranscript {
  private lines: ReviewTranscriptLine[] = [];
  /**
   * Assigned in the body rather than declared as a constructor parameter
   * property: `npm test` runs `node --test` on this file directly, and Node's
   * type-stripping mode rejects parameter properties (ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX).
   */
  private readonly max: number;

  constructor(max: number = MAX_REVIEW_LINES) {
    this.max = max;
  }

  /** Apply one op, coalescing with the tail when the kind matches. */
  apply(op: ReviewTranscriptOp, now: number = Date.now()): void {
    if (op.op === "append") {
      const last = this.lines[this.lines.length - 1];
      if (last && last.kind === op.kind) {
        last.text += op.text;
        return;
      }
      // Nothing to append to: start a line instead of losing the text.
      this.lines.push({ kind: op.kind, text: op.text, at: now });
      this.trim();
      return;
    }
    this.lines.push({ kind: op.kind, text: op.text, at: now });
    this.trim();
  }

  /** Translate and apply a raw session event. Returns the applied ops. */
  ingest(event: unknown, now: number = Date.now()): ReviewTranscriptOp[] {
    const ops = translateReviewEvent(event);
    for (const op of ops) this.apply(op, now);
    return ops;
  }

  private trim(): void {
    const max = Math.max(1, Math.trunc(this.max));
    if (this.lines.length > max) {
      this.lines.splice(0, this.lines.length - max);
    }
  }

  /** Snapshot for rendering. */
  toLines(): ReviewTranscriptLine[] {
    return this.lines.slice();
  }

  /** Flatten to plain strings for the pane. */
  toDisplayLines(): string[] {
    const out: string[] = [];
    for (const l of this.lines) {
      if (l.kind === "text" || l.kind === "thinking") {
        for (const part of l.text.split("\n")) out.push(part);
      } else {
        out.push(l.text);
      }
    }
    return out;
  }

  get size(): number {
    return this.lines.length;
  }

  clear(): void {
    this.lines = [];
  }
}

/**
 * The reviewer's system prompt. The user's guidance (review-prompt.md) is
 * APPENDED to this, and the whole thing lives only in the child session —
 * Plan Mode never sees it (requirement: Plan cannot see Review's context).
 */
export const REVIEW_SYSTEM_PROMPT = [
  "You are REVIEW MODE: an independent auditor that supervises another agent's plan.",
  "",
  "You run in your own session with your own context and your own model. The plan",
  "you are auditing was produced by a different agent (Plan Mode). Your value comes",
  "from a genuinely independent perspective, not from agreeing with it.",
  "",
  "You are READ-ONLY. You cannot edit files, run mutating shell commands, or install",
  "anything. Your single write action is submitting the revised plan through the",
  "`review_submit_plan` tool.",
  "",
  "## Tools",
  "",
  "- `read`, `grep`, `find`, `ls` — inspect the repository freely. Always verify a",
  "  claim about the codebase with these before you rely on it.",
  "- `review_bash` — a READ-ONLY shell limited to an allowlist (ls, cat, rg, fd,",
  "  jq, diff, stat, git status/log/diff/show/branch, node --version, ...).",
  "  Mutating commands and redirects are refused. Note: you CANNOT run tests,",
  "  builds, or linters — that is a deliberate parity with Plan Mode's",
  "  permissions. Verify a plan's claims by READING code, not by executing it.",
  "- `review_explore` — delegate focused read-only reconnaissance to subagents.",
  "- `review_submit_plan` — submit the final rewritten plan. This is the ONLY way",
  "  your work reaches the user. A review that never submits is a failed review.",
  "- `review_pass_done` — end the current pass with a verdict and your findings.",
  "",
  "## Protocol",
  "",
  "1. Read the shared context first. It contains Plan Mode's exploration, the user's",
  "   requirements, and the plan itself.",
  "2. Verify the plan against the real repository. Do not trust the plan's own claims",
  "   about what exists.",
  "3. Record every issue as a finding: severity 1-10, confidence 0-100, a category, a",
  "   file/line anchor when you have one, a one-line summary, and a rationale.",
  "4. Rewrite the plan so it is correct and framework-aligned, then submit it with",
  "   `review_submit_plan`.",
  "5. End the pass with `review_pass_done`.",
  "",
  "You cannot execute tests or builds, so never assert that something 'passes'.",
  "Instead state what the plan should verify and how, and flag unverifiable claims.",
  "",
  "## Restraint",
  "",
  "- If the plan is sound, submit it unchanged and say so. Never invent findings to",
  "  appear useful — a false finding costs the user more than a missed nit.",
  "- Adjust the plan; do not replace it with a different plan of your own. Preserve",
  "  the author's structure, step numbering, and heading style so the plan stays",
  "  machine-extractable.",
  "- Never invent files, symbols, APIs, or conventions. If you cannot verify",
  "  something, say so in the finding rather than asserting it.",
].join("\n");

/**
 * Type-only handle on the Pi SDK. This is erased at compile time, so importing
 * this module in a plain Node test does not load Pi.
 */
export type PiCodingAgentSdk = typeof import("@earendil-works/pi-coding-agent");

export type ReviewSdkLoader = () => Promise<PiCodingAgentSdk>;

/** Built-in tool names the reviewer may call. Read-only by construction. */
export const REVIEW_BUILTIN_TOOLS = ["read", "grep", "find", "ls"] as const;

/**
 * A live reviewer session, narrowed to what Review Mode actually uses.
 * Keeps the orchestrator free of SDK types.
 */
export interface ReviewChildSession {
  readonly sessionId: string;
  readonly modelLabel: string;
  /** Subscribe to the session's event stream. Returns an unsubscribe function. */
  subscribe(listener: (event: unknown) => void): () => void;
  /** Send a prompt. Queues as a steer when the session is already streaming. */
  prompt(text: string): Promise<void>;
  /** Send a prompt that is delivered only after the current run stops. */
  followUp(text: string): Promise<void>;
  /** Cancel the in-flight run. Never throws. */
  abort(): Promise<void>;
  isStreaming(): boolean;
  /** Unsubscribe and release. Never throws, safe to call twice. */
  dispose(): void;
}

export interface CreateReviewSessionOptions {
  cwd: string;
  /** Global Pi config dir (usually ~/.pi/agent). */
  agentDir: string;
  /** Reviewer role model. */
  modelRef: { provider: string; id: string; thinking: string };
  /** Resolve a model from the parent's registry by provider/id. */
  findModel: (provider: string, id: string) => unknown;
  /**
   * Resolved user reviewer guidance, appended to REVIEW_SYSTEM_PROMPT.
   *
   * Note: the pruned Plan Mode history is NOT passed to the session manager.
   * The 3-argument `SessionManager.inMemory(cwd, opts, entries)` form only
   * exists from Pi 0.85.1, and this package declares
   * `peerDependencies: { "@earendil-works/pi-coding-agent": "*" }`. A 0.84.x
   * runtime would silently ignore those entries and hand the reviewer an empty
   * context, so the caller renders the history into the first prompt with
   * `renderReviewContextBlock` instead.
   */
  reviewPrompt: string;
  /** Reviewer-only tools, built by the caller. */
  customTools: unknown[];
  /** Injectable for tests; defaults to a real dynamic import. */
  loadSdk?: ReviewSdkLoader;
}

export interface CreateReviewSessionResult {
  ok: boolean;
  session?: ReviewChildSession;
  modelLabel: string;
  error?: string;
}

/**
 * Environment marker set only for the duration of child-session creation.
 *
 * Belt-and-braces anti-recursion: the child is created with
 * `noExtensions: true`, so it cannot load this extension again. The marker is
 * set and immediately restored anyway, because the child runs in the SAME
 * process as the parent — leaving it set would leak into a later `/reload`.
 */
export const REVIEW_CHILD_MARKER_ENV = "PI_WORKFLOW_REVIEW_CHILD";

function wrapAgentSession(
  raw: unknown,
  modelLabel: string,
  sessionId: string,
): ReviewChildSession {
  const s = raw as {
    subscribe: (l: (e: unknown) => void) => () => void;
    prompt: (
      t: string,
      o?: { streamingBehavior?: "steer" | "followUp" },
    ) => Promise<void>;
    followUp: (t: string) => Promise<void>;
    abort: () => Promise<void>;
    isStreaming: boolean;
  };
  let disposed = false;
  const unsubscribers: Array<() => void> = [];
  return {
    sessionId,
    modelLabel,
    subscribe(listener) {
      const un = s.subscribe(listener);
      if (disposed) {
        try {
          un();
        } catch {
          /* ignore */
        }
        return () => {};
      }
      unsubscribers.push(un);
      return un;
    },
    async prompt(text) {
      if (disposed) return;
      if (s.isStreaming) await s.prompt(text, { streamingBehavior: "steer" });
      else await s.prompt(text);
    },
    async followUp(text) {
      if (disposed) return;
      await s.followUp(text);
    },
    async abort() {
      try {
        await s.abort();
      } catch {
        /* aborted sessions can throw; cancellation is best-effort */
      }
    },
    isStreaming() {
      return !disposed && Boolean(s.isStreaming);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const un of unsubscribers.splice(0)) {
        try {
          un();
        } catch {
          /* ignore */
        }
      }
    },
  };
}

/**
 * Create the reviewer's in-process child session.
 *
 * Isolation properties that matter:
 * - `noExtensions: true` → the child never loads this or any other extension,
 *   so Review Mode cannot recurse or observe the parent's hooks.
 * - `SessionManager.inMemory(...)` → the child never writes a session file and
 *   never touches the parent's session history.
 * - its own `ModelRuntime` → no contention with the parent's model state.
 * - read-only built-in tools + reviewer-only custom tools.
 *
 * Never throws: a failure is returned as `{ ok: false, error }` so the caller
 * can fall back to the author's plan (config.fallbackOnError).
 */
export async function createReviewSession(
  options: CreateReviewSessionOptions,
): Promise<CreateReviewSessionResult> {
  const modelLabel = `${options.modelRef.provider}/${options.modelRef.id}`;
  const loadSdk =
    options.loadSdk ?? (() => import("@earendil-works/pi-coding-agent"));
  const sessionId = `review-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;

  const previousMarker = process.env[REVIEW_CHILD_MARKER_ENV];
  try {
    const sdk = await loadSdk();

    const model = options.findModel(
      options.modelRef.provider,
      options.modelRef.id,
    );
    if (!model) {
      return {
        ok: false,
        modelLabel,
        error: `reviewer model ${modelLabel} is not in the model registry — run /role set reviewer <provider/model>`,
      };
    }

    let modelRuntime: unknown;
    try {
      modelRuntime = await sdk.ModelRuntime.create();
    } catch (e: unknown) {
      return {
        ok: false,
        modelLabel,
        error: `could not create a model runtime for the reviewer (auth/model catalog problem): ${
          e instanceof Error ? e.message : String(e)
        }`,
      };
    }

    // No ambient extensions, no skills/prompts/themes: the reviewer gets exactly
    // the system prompt below and nothing from the user's other packages.
    // Project context files (AGENTS.md etc.) DO load — they are the framework
    // signal the reviewer is meant to align with.
    const loader = new sdk.DefaultResourceLoader({
      cwd: options.cwd,
      agentDir: options.agentDir,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      systemPrompt: REVIEW_SYSTEM_PROMPT,
      appendSystemPrompt: [options.reviewPrompt],
    });
    try {
      await loader.reload?.();
    } catch {
      /* a reload failure must not abort the review; defaults still apply */
    }

    const sessionManager = sdk.SessionManager.inMemory(options.cwd, {
      id: sessionId,
    });

    process.env[REVIEW_CHILD_MARKER_ENV] = "1";
    let created: { session?: unknown; modelFallbackMessage?: string };
    try {
      created = await sdk.createAgentSession({
        cwd: options.cwd,
        agentDir: options.agentDir,
        modelRuntime,
        model,
        thinkingLevel: options.modelRef.thinking as never,
        tools: [...REVIEW_BUILTIN_TOOLS],
        customTools: options.customTools as never,
        resourceLoader: loader,
        sessionManager,
        sessionStartEvent: { type: "session_start", reason: "startup" },
      } as never);
    } finally {
      if (previousMarker === undefined)
        delete process.env[REVIEW_CHILD_MARKER_ENV];
      else process.env[REVIEW_CHILD_MARKER_ENV] = previousMarker;
    }

    if (!created?.session) {
      return {
        ok: false,
        modelLabel,
        error: "createAgentSession returned no session",
      };
    }

    // Bind in print mode so the child's UI context is explicitly non-interactive.
    // Best-effort: a binding failure is not fatal because the child has no extensions.
    try {
      const bindable = created.session as {
        bindExtensions?: (b: { mode: string }) => Promise<void>;
      };
      await bindable.bindExtensions?.({ mode: "print" });
    } catch {
      /* ignore */
    }

    return {
      ok: true,
      modelLabel,
      session: wrapAgentSession(created.session, modelLabel, sessionId),
    };
  } catch (e: unknown) {
    return {
      ok: false,
      modelLabel,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}
