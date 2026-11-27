/**
 * Workflow Extension — prompt-refinement result review and apply policy.
 *
 * The runtime (`prompt-refinement-runtime.ts`) decides *whether* one structured
 * candidate exists and hands it to a host delivery port. This module is the
 * layer between that candidate and the composer:
 *
 *   candidate → readiness → review record → hand-back / explicit replace
 *
 * Invariants (deterministic, never trusted to the model):
 *
 *   - **Review data stays out of the parent conversation.** The original
 *     draft, the candidate and the short change summary live in a bounded,
 *     in-memory `RefinementReviewStore` owned by the caller. This module has no
 *     session, SDK, provider or `sendUserMessage` import, never appends a
 *     message and never persists raw prompt text.
 *   - **Composer-ready means composer-ready.** A candidate is only accepted
 *     when it is non-empty, within the hard size cap, free of truncation
 *     markers, free of first-person "I did the work" claims and free of a
 *     conversational answer in place of a prompt. Readiness is re-checked here
 *     even if the runtime already validated the structured result.
 *   - **Strip transport, not Markdown.** A wrapper is removed only when it
 *     unambiguously wraps the *whole* text: a leading conversational label, a
 *     whole-text transport fence with no code language, a trailing "let me
 *     know" sign-off, a leading `/prompt` command prefix, or a whole-text
 *     result JSON envelope. Fences with a real language, headings, lists,
 *     quotes and inline code inside the prompt are preserved byte-for-byte.
 *   - **Original constraints survive or are surfaced.** Meaningful literals
 *     (code spans/blocks, paths, URLs, versions, quoted strings, identifiers)
 *     and explicit constraint sentences are compared against the candidate.
 *     A gap becomes a *review warning*, never a claim of semantic proof: the
 *     module cannot and does not guarantee intent equivalence.
 *   - **No second modal approval for ordinary success.** A clean hand-back is
 *     one write. Only a genuine conflict — the draft changed since the
 *     snapshot, or the composer cannot be read — requires an explicit
 *     replacement, and that replacement re-checks the exact revision the user
 *     just saw before writing.
 *   - **Nothing executes.** The module only reads/writes composer text, copies
 *     or shows text. There is no shell, edit, plan, commit, handoff or send
 *     path, and a candidate that *asks* for such work is still only text.
 */

import { REFINEMENT_LIMITS } from "./prompt-refinement-state.ts";
import {
  validateRefinementResult,
  type RefinementResult,
  type RefinementTerminologyChange,
} from "./prompt-refinement-prompt.ts";

/** Bump when the review record shape or the readiness rules change. */
export const REFINEMENT_REVIEW_VERSION = 1 as const;

/** Hard cap on one review record; defaults to the structured candidate cap. */
export const REFINEMENT_REVIEW_MAX_CHARS = REFINEMENT_LIMITS.candidateText;

/** Findings are advisory; this only keeps one review bounded. */
export const REFINEMENT_REVIEW_MAX_FINDINGS = 40;

// ── Review findings ──────────────────────────────────────────────────

export type RefinementReviewSeverity = "info" | "warning";

export type RefinementReviewFindingKind =
  | "wrapper-stripped"
  | "unchanged-candidate"
  | "terminology-changed"
  | "missing-literal"
  | "unverified-preserved-literal"
  | "possible-dropped-constraint"
  | "possible-over-expansion"
  | "possible-under-expansion"
  | "suggestions-present";

export interface RefinementReviewFinding {
  kind: RefinementReviewFindingKind;
  severity: RefinementReviewSeverity;
  /** Short, user-visible; never contains chain-of-thought or raw evidence. */
  message: string;
}

function finding(
  kind: RefinementReviewFindingKind,
  severity: RefinementReviewSeverity,
  message: string,
): RefinementReviewFinding {
  return { kind, severity, message };
}

// ── Wrapper stripping ────────────────────────────────────────────────

export interface StripComposerWrappersOptions {
  /** The untouched draft; used to avoid unwrapping the user's own JSON. */
  originalText?: string;
  /** Upper bound for a plausible result-JSON envelope. */
  maxChars?: number;
}

export interface ComposerWrapperResult {
  /** Exactly what the composer may receive. */
  text: string;
  /** Short descriptions of what was removed; never the removed body. */
  removed: string[];
  /** True when the text changed at all. */
  stripped: boolean;
}

/** A leading label like "Here is the refined prompt:" — always short. */
const PREAMBLE_LINE =
  /^\s*(?:(?:here(?:'s|’s| is)|below (?:is|are)|this is|i(?:'ve|’ve| have) (?:refined|rewritten|rewrote|improved|edited)|i(?:'ll| will) (?:refine|rewrite|improve)|sure|certainly|of course|okay|ok)[^\n]{0,240}?)\s*:\s*$/i;

/** A trailing "let me know…" paragraph from chat, not from the prompt. */
const SIGNOFF_LINE =
  /^\s*(?:let me know|feel free|hope (?:this|that) helps|would you like|if you(?:'d| would)? (?:like|want|need)|anything else|happy to)[^\n]{0,240}$/i;

/** Conversational refusal at the start of a candidate. */
const REFUSAL_START =
  /^\s*(?:i(?:'m|’m| am) sorry|i (?:can(?:'t|’t|not)|won(?:'t|’t)|am unable)|unfortunately|as an ai|i(?:'m|’m| am) unable)\b/i;

/** First-person past-tense work claims — never a prompt's opening line. */
const EXECUTION_VERBS =
  "implemented|applied|created|added|updated|fixed|refactored|removed|deleted|renamed|committed|pushed|ran|wrote|written|modified|edited|changed|installed|migrated";
const IMPLEMENTATION_CLAIM = new RegExp(
  "^\\s*(?:done\\b|finished\\b|completed\\b|" +
    "i(?:'ve|’ve| have)?\\s+(?:" +
    EXECUTION_VERBS +
    ")\\b|" +
    "i\\s+(?:" +
    EXECUTION_VERBS +
    ")\\b|" +
    "(?:" +
    EXECUTION_VERBS +
    ")\\b|" +
    "(?:the\\s+)?(?:changes?|code|edits?|implementation|work)\\s+(?:is|are|has been|have been)\\s+(?:done|complete|completed|applied|updated|in place|merged|committed)\\b|" +
    "(?:all\\s+)?(?:the\\s+)?(?:tests?|checks?|build|lint)\\s+(?:pass|passes|passed|are passing|is passing|succeed|succeeded)\\b)",
  "i",
);

/** Explicit truncation markers only; a prompt may legitimately end in "…". */
const TRUNCATION_MARKER =
  /(?:\[\s*(?:output\s+)?truncated\b[^\]]*\]|<\s*(?:output\s+)?truncated\s*>|\(\s*(?:output\s+)?truncated\s*\)|<!--\s*truncated\s*-->)\s*$/i;

const WHOLE_FENCE =
  /^(?<fence>`{3,}|~{3,})(?<info>[^\r\n]*)\r?\n(?<body>[\s\S]*?)\r?\n(?:\k<fence>)[ \t]*$/;

const CHAT_PREAMBLE =
  /\b(?:here(?:'s|’s| is)|below is|i(?:'ve|’ve| have) (?:refined|rewritten|improved|edited)|this (?:refined|improved|rewritten) (?:prompt|version)|the (?:refined|improved|rewritten) (?:prompt|version)|as requested|i hope|let me know)\b/i;

function splitLines(text: string): { lines: string[]; newline: string } {
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  return { lines: text.split(/\r?\n/), newline };
}

function isFenceLine(line: string): boolean {
  return /^\s*(?:`{3,}|~{3,})/.test(line);
}

/**
 * A whole-text fence is transport only when the inner text is a Markdown
 * prompt. A fenced code block (shebang, no headings) is legitimate Markdown.
 */
function looksLikeMarkdownPrompt(text: string): boolean {
  if (/^#!/.test(text.trimStart())) return false;
  const headings = text.match(/^\s{0,3}#{1,6}\s+\S/gm)?.length ?? 0;
  const listItems = text.match(/^\s{0,3}(?:[-*+]\s|\d{1,3}[.)]\s)/gm)?.length ?? 0;
  return headings >= 1 || listItems >= 2;
}

function isJsonEnvelope(text: string, maxChars: number): string | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return undefined;
  if (trimmed.length > maxChars * 2) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return undefined;
  }
  const record = parsed as Record<string, unknown>;
  const keys = Object.keys(record);
  const resultKeys = new Set([
    "schemaVersion",
    "candidate",
    "changeSummary",
    "suggestions",
    "language",
    "terminology",
    "preservedLiterals",
  ]);
  const envelopeKeys = new Set(["refinedText", "prompt", "text"]);
  const isResultEnvelope =
    keys.every((key) => resultKeys.has(key)) &&
    typeof record.candidate === "string" &&
    record.candidate.trim().length > 0;
  const isSimpleEnvelope =
    keys.length === 1 &&
    envelopeKeys.has(keys[0]!) &&
    typeof record[keys[0]!] === "string" &&
    (record[keys[0]!] as string).trim().length > 0;
  if (!isResultEnvelope && !isSimpleEnvelope) return undefined;
  const value = isResultEnvelope
    ? (record.candidate as string)
    : (record[keys[0]!] as string);
  return value;
}

/**
 * Remove one outermost transport wrapper at a time.
 *
 * The loop is bounded and each step is independently conservative; if none of
 * the rules match, the input is returned unchanged.
 */
export function stripComposerWrappers(
  text: string,
  options: StripComposerWrappersOptions = {},
): ComposerWrapperResult {
  if (typeof text !== "string" || text.length === 0) {
    return { text: "", removed: [], stripped: false };
  }
  const removed: string[] = [];
  let current = text;

  // A leading `/prompt` prefix is transport, never prompt content.
  const withoutPrefix = current.replace(/^\s*\/prompt\b[ \t]+/, (match) => {
    removed.push("leading /prompt command prefix");
    return "";
  });
  current = withoutPrefix;

  // Repeat while a wrapper is actually removed (max 4 passes).
  for (let pass = 0; pass < 4; pass += 1) {
    const before = current;

    // 1. Whole-text transport fence. Never strip a real code-language fence
    //    and never strip a fence around pure code with no info string.
    const fence = WHOLE_FENCE.exec(current.trim());
    if (fence?.groups) {
      const info = fence.groups.info!.trim();
      const body = fence.groups.body ?? "";
      const language = info.split(/\s+/)[0] ?? "";
      const transportFence =
        language === ""
          ? looksLikeMarkdownPrompt(body)
          : /^(?:markdown|md|text|txt|plaintext)$/i.test(language);
      if (transportFence && body.trim().length > 0) {
        removed.push(
          language
            ? `whole-text ${language} code fence (transport)`
            : "whole-text fence around Markdown (transport)",
        );
        current = body;
      }
    }

    // 2. Leading conversational label + following blank line.
    {
      const { lines } = splitLines(current);
      let consumed = 0;
      while (consumed < lines.length && lines[consumed]!.trim() === "") consumed += 1;
      const start = consumed;
      unsigned: {
        if (start >= lines.length) break unsigned;
        const line = lines[start]!;
        if (!PREAMBLE_LINE.test(line)) break unsigned;
        const next = lines[start + 1];
        if (next !== undefined && next.trim() !== "") break unsigned;
        removed.push(
          `leading conversational label (${line.trim().length} chars)`,
        );
        current = lines.slice(start + 1).join(splitLines(current).newline);
      }
    }

    // 3. Trailing sign-off paragraph, optionally preceded by `---`.
    {
      const { lines, newline } = splitLines(current);
      let end = lines.length;
      while (end > 0 && lines[end - 1]!.trim() === "") end -= 1;
      if (end > 0 && SIGNOFF_LINE.test(lines[end - 1]!)) {
        end -= 1;
        while (end > 0 && lines[end - 1]!.trim() === "") end -= 1;
        if (end > 0 && /^\s*---+\s*$/.test(lines[end - 1]!)) end -= 1;
        removed.push("trailing sign-off (not part of the prompt)");
        current = lines.slice(0, end).join(newline);
      }
    }

    // 4. Whole-text JSON result envelope, unless the draft itself is JSON.
    const draftIsJson = /^\s*[{[]/.test(options.originalText ?? "");
    if (!draftIsJson) {
      const envelope = isJsonEnvelope(
        current,
        options.maxChars ?? REFINEMENT_REVIEW_MAX_CHARS,
      );
      if (envelope) {
        removed.push("whole-text result JSON envelope (transport)");
        current = envelope;
      }
    }

    if (current === before) break;
  }

  // Only leading blank lines and trailing whitespace are removed; internal
  // lines (Markdown hard breaks, indented code) stay byte-identical.
  const text_ = removed.length > 0
    ? current.replace(/^(?:[ \t]*\r?\n)+/, "").replace(/\s+$/, "")
    : text;
  return {
    text: text_,
    removed,
    stripped: removed.length > 0,
  };
}

// ── Composer readiness ───────────────────────────────────────────────

export type RefinementReadinessRefusal =
  | "empty"
  | "too-long"
  | "truncated"
  | "implementation-claim"
  | "model-refusal"
  | "conversational-preamble";

export interface RefinementComposerReadiness {
  /** True only when `text` may be written to the composer verbatim. */
  ready: boolean;
  /** Wrapper-stripped text; equals the input when nothing was stripped. */
  text: string;
  /** Raw candidate text length (before stripping). */
  rawChars: number;
  /** Delivered text length. */
  chars: number;
  maxChars: number;
  removed: string[];
  refusal?: RefinementReadinessRefusal;
  message?: string;
  findings: RefinementReviewFinding[];
}

export interface AssessComposerReadinessOptions {
  originalText?: string;
  maxChars?: number;
}

function firstNonEmptyLine(text: string): string {
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() !== "") return line;
  }
  return "";
}

/**
 * Decide whether `text` is ready to become composer content.
 *
 * This is a *transport/shape* check, not a quality judgement. Missing intent,
 * awkward wording or a legitimate but different structure are review concerns
 * for a human, never a deterministic failure here.
 */
export function assessComposerReadiness(
  text: unknown,
  options: AssessComposerReadinessOptions = {},
): RefinementComposerReadiness {
  const maxChars = options.maxChars ?? REFINEMENT_REVIEW_MAX_CHARS;
  const raw = typeof text === "string" ? text : "";
  const stripped = stripComposerWrappers(raw, {
    originalText: options.originalText,
    maxChars,
  });
  const findings: RefinementReviewFinding[] = [];
  const base = {
    text: stripped.text,
    rawChars: raw.length,
    chars: stripped.text.length,
    maxChars,
    removed: stripped.removed,
    findings,
  };
  if (stripped.removed.length > 0) {
    findings.push(
      finding(
        "wrapper-stripped",
        "info",
        `removed transport wrapper(s): ${stripped.removed.join("; ")}`,
      ),
    );
  }

  const refuse = (
    refusal: RefinementReadinessRefusal,
    message: string,
  ): RefinementComposerReadiness => ({
    ...base,
    ready: false,
    refusal,
    message,
  });

  if (stripped.text.trim().length === 0) {
    return refuse("empty", "the refined prompt is empty");
  }
  if (stripped.text.length > maxChars) {
    return refuse(
      "too-long",
      `the refined prompt is ${stripped.text.length} characters; the composer cap is ${maxChars}. Nothing was truncated.`,
    );
  }
  if (TRUNCATION_MARKER.test(stripped.text)) {
    return refuse(
      "truncated",
      "the refined prompt is explicitly marked as truncated",
    );
  }
  const lead = firstNonEmptyLine(stripped.text);
  if (IMPLEMENTATION_CLAIM.test(lead)) {
    return refuse(
      "implementation-claim",
      "the candidate claims work was implemented, applied or verified; refinement only returns prompt text",
    );
  }
  if (REFUSAL_START.test(lead)) {
    return refuse(
      "model-refusal",
      "the candidate is a refusal/apology rather than a refined prompt",
    );
  }
  // A chat preamble the wrapper rules did not recognise (no trailing colon,
  // too long): refuse instead of silently deleting prose that might be part of
  // the prompt. The meta phrase keeps this from rejecting a legitimate first
  // paragraph.
  const { lines } = splitLines(stripped.text);
  const firstBlank = lines.findIndex((line) => line.trim() === "");
  const leadParagraph = lines.slice(0, firstBlank > 0 ? firstBlank : 1).join(" ");
  if (
    firstBlank > 0 &&
    firstBlank < 4 &&
    !lines.slice(0, firstBlank).some((line) => isFenceLine(line) || /^[#>*|]/.test(line.trim())) &&
    leadParagraph.length > 300 &&
    CHAT_PREAMBLE.test(leadParagraph)
  ) {
    return refuse(
      "conversational-preamble",
      "the candidate starts with a long chat preamble instead of the prompt itself",
    );
  }
  return { ...base, ready: true };
}

// ── Literal and constraint preservation ──────────────────────────────

export interface ProtectedLiteral {
  value: string;
  kind: "code" | "inline-code" | "path" | "url" | "version" | "quoted" | "identifier";
}

const INLINE_CODE = /`([^`\n]{2,200})`/g;
const FENCED_CODE = /```[^\n]*\r?\n([\s\S]*?)```/g;
const URL_PATTERN = /\bhttps?:\/\/[^\s<>"'`)\]]+/g;
const PATH_PATTERN =
  /(?:[A-Za-z]:[\\/](?:[^\s"'`<>|:*?]+[\\/]?)+|\/(?:[\w.-]+\/)+[\w.-]+|\.{1,2}\/[\w./-]+|[\w.-]+[\\/][\w./-]+)/g;
const VERSION_PATTERN = /\bv?\d+\.\d+(?:\.\d+)+(?:[-+][\w.]+)?\b/g;
const QUOTED_PATTERN = /"([^"\n]{3,160})"|'([^'\n]{3,160})'/g;
const IDENTIFIER_PATTERN = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+){1,}\b/g;

function addLiteral(
  out: ProtectedLiteral[],
  seen: Set<string>,
  value: string,
  kind: ProtectedLiteral["kind"],
): void {
  const normalized = value.trim();
  if (normalized.length < 2 || normalized.length > 200) return;
  if (/^[\s._-]+$/.test(normalized)) return;
  if (seen.has(normalized)) return;
  seen.add(normalized);
  out.push({ value: normalized, kind });
}

/**
 * Deterministically collect the literals a prompt should carry over
 * byte-identically. This is a review aid, not an equivalence proof.
 */
export function extractProtectedLiterals(
  text: string,
  max = 32,
): ProtectedLiteral[] {
  const out: ProtectedLiteral[] = [];
  const seen = new Set<string>();
  if (typeof text !== "string" || text.trim() === "") return out;
  const withoutFences = text.replace(FENCED_CODE, (match, body: string) => {
    for (const line of String(body).split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed.length >= 4) addLiteral(out, seen, trimmed, "code");
    }
    return "\n";
  });
  for (const match of withoutFences.matchAll(INLINE_CODE)) {
    addLiteral(out, seen, match[1]!, "inline-code");
  }
  for (const match of withoutFences.matchAll(URL_PATTERN)) {
    addLiteral(out, seen, match[0].replace(/[.,;:!?]+$/, ""), "url");
  }
  for (const match of withoutFences.matchAll(PATH_PATTERN)) {
    addLiteral(out, seen, match[0], "path");
  }
  for (const match of withoutFences.matchAll(VERSION_PATTERN)) {
    addLiteral(out, seen, match[0], "version");
  }
  for (const match of withoutFences.matchAll(QUOTED_PATTERN)) {
    addLiteral(out, seen, (match[1] ?? match[2])!, "quoted");
  }
  for (const match of withoutFences.matchAll(IDENTIFIER_PATTERN)) {
    addLiteral(out, seen, match[0], "identifier");
  }
  return out.slice(0, max);
}

const STOPWORDS = new Set([
  "about",
  "after",
  "again",
  "also",
  "always",
  "another",
  "because",
  "before",
  "being",
  "between",
  "could",
  "does",
  "doing",
  "each",
  "every",
  "from",
  "have",
  "into",
  "just",
  "must",
  "never",
  "only",
  "other",
  "over",
  "same",
  "should",
  "some",
  "such",
  "than",
  "that",
  "their",
  "them",
  "then",
  "there",
  "these",
  "they",
  "this",
  "those",
  "through",
  "under",
  "until",
  "using",
  "very",
  "what",
  "when",
  "where",
  "which",
  "while",
  "will",
  "with",
  "without",
  "would",
  "your",
]);

function significantTokens(text: string): Set<string> {
  const tokens = new Set<string>();
  for (const raw of text.toLowerCase().matchAll(/[a-z][a-z0-9_]{3,}/g)) {
    const token = raw[0];
    if (!STOPWORDS.has(token)) tokens.add(token);
  }
  return tokens;
}

const CONSTRAINT_MARKER =
  /\b(?:must(?:\s+not)?|mustn't|should(?:\s+not)?|shouldn't|never|only|always|do(?:es)?\s+not|don't|doesn't|avoid|without|unless|at\s+(?:least|most)|no\s+more\s+than|keep|preserve|leave\s+unchanged|not\s+change|don't\s+change)\b/i;

export interface OriginalConstraint {
  sentence: string;
  /** Fraction (0–1) of its significant tokens found in the candidate. */
  coverage: number;
}

function proseSentences(text: string): string[] {
  const withoutFences = text.replace(FENCED_CODE, "\n");
  return withoutFences
    .split(/(?<=[.!?;])\s+|\n+/)
    .map((sentence) => sentence.replace(/^[\s>*\-+\d.)]+/, "").trim())
    .filter((sentence) => sentence.length > 0);
}

/**
 * Find original sentences that state a constraint and check how much of their
 * vocabulary survives in the candidate. A low coverage is a *hint to review*,
 * not proof that a constraint was dropped.
 */
export function assessOriginalConstraints(
  originalText: string,
  candidateText: string,
  max = 12,
): OriginalConstraint[] {
  if (typeof originalText !== "string" || typeof candidateText !== "string") {
    return [];
  }
  const candidateTokens = significantTokens(candidateText);
  const results: OriginalConstraint[] = [];
  for (const sentence of proseSentences(originalText)) {
    if (results.length >= max) break;
    if (sentence.length < 15 || sentence.length > 400) continue;
    if (!CONSTRAINT_MARKER.test(sentence)) continue;
    const tokens = significantTokens(sentence);
    if (tokens.size === 0) continue;
    let present = 0;
    for (const token of tokens) {
      if (candidateTokens.has(token)) {
        present += 1;
        continue;
      }
      for (const candidateToken of candidateTokens) {
        if (
          candidateToken.length >= 4 &&
          (candidateToken.startsWith(token) || token.startsWith(candidateToken))
        ) {
          present += 1;
          break;
        }
      }
    }
    results.push({ sentence, coverage: present / tokens.size });
  }
  return results;
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function containsLiteral(candidate: string, literal: string): boolean {
  if (candidate.includes(literal)) return true;
  return normalizeWhitespace(candidate).includes(normalizeWhitespace(literal));
}

// ── Change summary ───────────────────────────────────────────────────

export interface RefinementChangeSummary {
  lines: string[];
  /** One-line notice for status/progress surfaces. */
  headline: string;
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text;
}

export function composeChangeSummary(
  result: Pick<RefinementResult, "changeSummary" | "terminology">,
): RefinementChangeSummary {
  const lines = result.changeSummary
    .filter((line): line is string => typeof line === "string")
    .map((line) => clip(normalizeWhitespace(line), 240))
    .filter((line) => line.length > 0)
    .slice(0, REFINEMENT_LIMITS.changeSummary);
  const terminology: RefinementTerminologyChange[] = result.terminology ?? [];
  const headlineParts: string[] = [];
  headlineParts.push(
    lines.length === 1 ? "1 change" : `${lines.length} changes`,
  );
  if (terminology.length > 0) {
    headlineParts.push(
      terminology.length === 1
        ? "1 evidence-backed term"
        : `${terminology.length} evidence-backed terms`,
    );
  }
  return {
    lines,
    headline: headlineParts.join(", "),
  };
}

// ── Review record ────────────────────────────────────────────────────

export interface RefinementReview {
  version: typeof REFINEMENT_REVIEW_VERSION;
  operationId?: string;
  createdAt: number;
  /** The untouched draft, kept for View/Copy and retry. */
  originalText: string;
  originalChars: number;
  /** Wrapper-stripped candidate: exactly what the composer may receive. */
  candidateText: string;
  rawCandidateText: string;
  candidateChars: number;
  language: string;
  changeSummary: string[];
  changeHeadline: string;
  findings: RefinementReviewFinding[];
  warnings: RefinementReviewFinding[];
  /** Only ready reviews are ever built. */
  ready: true;
}

export interface BuildRefinementReviewInput {
  originalText: string;
  /** Untrusted structured result; re-validated here, not trusted. */
  result: unknown;
  operationId?: string;
  suggestionsAllowed?: boolean;
  evidenceIds?: Iterable<string>;
  /** Answers that explicitly approved a scope change (runtime ledger). */
  approvedScopeChanges?: readonly string[];
  maxCandidateChars?: number;
  now?: () => number;
}

export type BuildRefinementReviewOutcome =
  | { ok: true; review: RefinementReview }
  | {
      ok: false;
      reason: "invalid-result" | "not-ready" | "unapproved-scope-claim";
      message: string;
      findings: RefinementReviewFinding[];
      readiness?: RefinementComposerReadiness;
    };

function unapprovedScopeClaim(
  lines: readonly string[],
  suggestions: readonly string[],
  approvedScopeChanges: readonly string[],
): string | undefined {
  if (approvedScopeChanges.length > 0) return undefined;
  const claim =
    /\b(?:added|adds|adding|introduced|introduces|introducing)\s+(?:a\s+)?(?:new\s+)?(?:feature|task|deliverable|requirement|scope|work)\b|\b(?:expanded|expands|expanding|broadened|broadens|broadening)\s+(?:the\s+)?(?:scope|request|task)\b|\balso\s+(?:implement|implemented|build|built|add|added|handle|handled)\b/i;
  for (const line of [...lines, ...suggestions]) {
    if (typeof line === "string" && line.trim() && claim.test(line)) {
      return clip(normalizeWhitespace(line), 200);
    }
  }
  return undefined;
}

/**
 * Build the bounded review record for one structured candidate.
 *
 * The readiness gate is deterministic, but intent quality is not: findings are
 * hints for the human who will edit and send the prompt, and the module never
 * claims the rewritten text is semantically equivalent.
 */
export function buildRefinementReview(
  input: BuildRefinementReviewInput,
): BuildRefinementReviewOutcome {
  const findings: RefinementReviewFinding[] = [];
  const evidenceIds =
    input.evidenceIds === undefined
      ? new Set<string>()
      : new Set(input.evidenceIds);
  const maxCandidateChars =
    input.maxCandidateChars ?? REFINEMENT_REVIEW_MAX_CHARS;

  const validation = validateRefinementResult(input.result, {
    suggestionsAllowed: input.suggestionsAllowed === true,
    evidenceIds,
    requireTerminologyEvidence: true,
    maxCandidateChars,
  });
  if (!validation.ok) {
    const detail = validation.errors
      .map((issue) => `${issue.path}: ${issue.message}`)
      .join("; ");
    return {
      ok: false,
      reason: "invalid-result",
      message: `the structured refinement result is invalid: ${detail}`,
      findings,
    };
  }
  const result = validation.value;

  const scopeClaim = unapprovedScopeClaim(
    result.changeSummary,
    result.suggestions,
    input.approvedScopeChanges ?? [],
  );
  if (scopeClaim) {
    return {
      ok: false,
      reason: "unapproved-scope-claim",
      message: `the change summary claims unapproved new work ("${scopeClaim}")`,
      findings: [
        finding(
          "possible-over-expansion",
          "warning",
          "the change summary claims new work the user never approved",
        ),
      ],
    };
  }

  const readiness = assessComposerReadiness(result.candidate, {
    originalText: input.originalText,
    maxChars: maxCandidateChars,
  });
  if (!readiness.ready) {
    return {
      ok: false,
      reason: "not-ready",
      message: readiness.message ?? "the candidate is not ready for the composer",
      findings: [...findings, ...readiness.findings],
      readiness,
    };
  }
  const candidateText = readiness.text;

  // Literal preservation: byte-identical check, reported as a warning.
  for (const literal of extractProtectedLiterals(input.originalText)) {
    if (!containsLiteral(candidateText, literal.value)) {
      findings.push(
        finding(
          "missing-literal",
          "warning",
          `${literal.kind} literal from the original is not present byte-identically: "${clip(literal.value, 120)}"`,
        ),
      );
    }
  }

  // Constraint sentences whose vocabulary largely disappeared.
  for (const constraint of assessOriginalConstraints(
    input.originalText,
    candidateText,
  )) {
    if (constraint.coverage < 0.5) {
      findings.push(
        finding(
          "possible-dropped-constraint",
          "warning",
          `a constraint may have been dropped or reworded (review hint, not a verification): "${clip(constraint.sentence, 140)}"`,
        ),
      );
    }
  }

  // Preserved-literal claims the candidate does not actually contain.
  for (const literal of (result.preservedLiterals ?? []).slice(0, 12)) {
    if (literal && !containsLiteral(candidateText, literal)) {
      findings.push(
        finding(
          "unverified-preserved-literal",
          "warning",
          `the result claims to preserve "${clip(literal, 100)}" but the candidate does not contain it`,
        ),
      );
    }
  }

  // Size movement is advisory: purpose-driven prompts may legitimately grow.
  if (
    candidateText.length > Math.max(4000, input.originalText.length * 3)
  ) {
    findings.push(
      finding(
        "possible-over-expansion",
        "warning",
        `the candidate grew from ${input.originalText.length} to ${candidateText.length} characters; check for added scope`,
      ),
    );
  } else if (
    input.originalText.length >= 200 &&
    candidateText.length < input.originalText.length * 0.25
  ) {
    findings.push(
      finding(
        "possible-under-expansion",
        "warning",
        `the candidate shrank from ${input.originalText.length} to ${candidateText.length} characters; check for dropped requirements`,
      ),
    );
  }

  if (normalizeWhitespace(candidateText) === normalizeWhitespace(input.originalText)) {
    findings.push(
      finding(
        "unchanged-candidate",
        "info",
        "the candidate is unchanged apart from whitespace/wrappers",
      ),
    );
  }
  if ((result.terminology ?? []).length > 0) {
    findings.push(
      finding(
        "terminology-changed",
        "info",
        `${result.terminology!.length} terminology change(s) with cited evidence; verify the terms are not deliberately distinct`,
      ),
    );
  }
  if (result.suggestions.length > 0) {
    findings.push(
      finding(
        "suggestions-present",
        "info",
        `${result.suggestions.length} optional suggestion(s) were kept separate and are not requirements`,
      ),
    );
  }

  const summary = composeChangeSummary(result);
  const boundedFindings = findings.slice(0, REFINEMENT_REVIEW_MAX_FINDINGS);
  const review: RefinementReview = {
    version: REFINEMENT_REVIEW_VERSION,
    ...(input.operationId !== undefined ? { operationId: input.operationId } : {}),
    createdAt: (input.now ?? Date.now)(),
    originalText: input.originalText,
    originalChars: input.originalText.length,
    candidateText,
    rawCandidateText: result.candidate,
    candidateChars: candidateText.length,
    language: result.language,
    changeSummary: summary.lines,
    changeHeadline: summary.headline,
    findings: boundedFindings,
    warnings: boundedFindings.filter((entry) => entry.severity === "warning"),
    ready: true,
  };
  return { ok: true, review };
}

/** Short, non-executing notice for a status line. */
export function refinementReviewNotice(review: RefinementReview): string {
  const warnings = review.warnings.length;
  const suffix =
    warnings === 0
      ? ""
      : ` · ${warnings} review ${warnings === 1 ? "warning" : "warnings"}`;
  return `Refined prompt ready (${review.changeHeadline})${suffix}. Nothing was run or changed.`;
}

// ── Review store (outside the parent conversation) ────────────────────

export interface RefinementReviewStore {
  put(review: RefinementReview): void;
  get(operationId: string): RefinementReview | undefined;
  latest(): RefinementReview | undefined;
  discard(operationId: string): boolean;
  clear(): void;
  readonly size: number;
}

/**
 * Bounded, in-memory, insertion-ordered store. Reviews are never written to
 * session files, logs or the parent conversation.
 */
export function createRefinementReviewStore(maxEntries = 8): RefinementReviewStore {
  const limit = Math.max(1, Math.floor(maxEntries));
  const reviews = new Map<string, RefinementReview>();
  const keyOf = (review: RefinementReview): string =>
    review.operationId ?? `anonymous-${review.createdAt}`;
  return {
    put(review) {
      const key = keyOf(review);
      reviews.delete(key);
      reviews.set(key, review);
      while (reviews.size > limit) {
        const oldest = reviews.keys().next();
        if (oldest.done) break;
        reviews.delete(oldest.value);
      }
    },
    get(operationId) {
      const review = reviews.get(operationId);
      if (!review) return undefined;
      // Refresh recency.
      reviews.delete(operationId);
      reviews.set(operationId, review);
      return review;
    },
    latest() {
      let last: RefinementReview | undefined;
      for (const review of reviews.values()) last = review;
      return last;
    },
    discard(operationId) {
      return reviews.delete(operationId);
    },
    clear() {
      reviews.clear();
    },
    get size() {
      return reviews.size;
    },
  };
}

// ── Conflict and apply policy ────────────────────────────────────────

export type DraftConflictReason =
  | "edited-during-refinement"
  | "composer-unavailable"
  | "different-session";

export interface DraftConflict {
  conflict: boolean;
  reason?: DraftConflictReason;
  /** Exact text the user must see and confirm before a replacement. */
  currentText?: string;
}

/**
 * Compare the draft captured at operation start with the live composer text.
 * Any difference — including whitespace — is a conflict; the caller may offer
 * an explicit replacement but must never overwrite silently.
 */
export function detectDraftConflict(
  baselineText: string,
  currentText: string | undefined,
): DraftConflict {
  if (typeof currentText !== "string") {
    return { conflict: true, reason: "composer-unavailable" };
  }
  if (currentText !== baselineText) {
    return {
      conflict: true,
      reason: "edited-during-refinement",
      currentText,
    };
  }
  return { conflict: false };
}

export type ReviewActionId =
  | "insert"
  | "replace"
  | "view-original"
  | "view-candidate"
  | "copy-original"
  | "copy-candidate"
  | "keep-draft"
  | "discard";

export interface ReviewAction {
  id: ReviewActionId;
  label: string;
  /** Primary action: Enter/default and no extra confirmation. */
  primary: boolean;
  /** Destructive overwrite; requires an explicit, re-checked confirmation. */
  destructive: boolean;
  /** Only available when a conflict exists. */
  conflictOnly?: boolean;
}

/**
 * Stable labels, so Terminal, Desktop and tests agree on the affordances.
 * `insert` is deliberately a single action: an ordinary successful hand-back
 * does not open a second approval dialog.
 */
export const REVIEW_ACTION_LABELS: Readonly<Record<ReviewActionId, string>> = {
  insert: "Insert refined prompt",
  replace: "Replace newer draft…",
  "view-original": "View original",
  "view-candidate": "View refined prompt",
  "copy-original": "Copy original",
  "copy-candidate": "Copy refined prompt",
  "keep-draft": "Keep newer draft",
  discard: "Discard result",
};

export function reviewActions(
  review: RefinementReview | undefined,
  conflict: DraftConflict,
): ReviewAction[] {
  if (!review) return [];
  const actions: ReviewAction[] = [];
  if (conflict.conflict) {
    actions.push(
      {
        id: "replace",
        label: REVIEW_ACTION_LABELS.replace,
        primary: false,
        destructive: true,
      },
      {
        id: "keep-draft",
        label: REVIEW_ACTION_LABELS["keep-draft"],
        primary: true,
        destructive: false,
      },
    );
  } else {
    actions.push({
      id: "insert",
      label: REVIEW_ACTION_LABELS.insert,
      primary: true,
      destructive: false,
    });
  }
  actions.push(
    {
      id: "view-original",
      label: REVIEW_ACTION_LABELS["view-original"],
      primary: false,
      destructive: false,
    },
    {
      id: "view-candidate",
      label: REVIEW_ACTION_LABELS["view-candidate"],
      primary: false,
      destructive: false,
    },
    {
      id: "copy-original",
      label: REVIEW_ACTION_LABELS["copy-original"],
      primary: false,
      destructive: false,
    },
    {
      id: "copy-candidate",
      label: REVIEW_ACTION_LABELS["copy-candidate"],
      primary: false,
      destructive: false,
    },
    {
      id: "discard",
      label: REVIEW_ACTION_LABELS.discard,
      primary: false,
      destructive: false,
    },
  );
  return actions;
}

// ── Apply ────────────────────────────────────────────────────────────

/** Synchronous composer seam. Reads and writes text only; never sends. */
export interface RefinementComposerPort {
  /** Expected-buffer check; must be synchronous to avoid a TOCTOU window. */
  getText(): string | undefined;
  /** Replace the composer text. Must not send, submit or change modes. */
  setText(text: string): boolean | { ok: boolean; error?: string };
  /** Read-only View affordance for a long text. */
  showText?(title: string, text: string): void;
  /** Copy affordance; absent means the host has no clipboard surface. */
  copyText?(text: string): boolean | { ok: boolean; error?: string };
  notify?(message: string, level?: "info" | "warning"): void;
}

export interface ApplyRefinementReviewInput {
  action: ReviewActionId;
  review: RefinementReview;
  /** Exact draft captured when the operation started. */
  baselineText: string;
  /**
   * For `replace`: the exact newer draft the user was shown when they chose
   * the explicit replacement. Re-read and compared again before writing.
   */
  confirmedReplaceText?: string;
  composer: RefinementComposerPort;
}

export type RefinementApplyReason =
  | "conflict"
  | "not-ready"
  | "composer-unavailable"
  | "write-refused"
  | "copy-unavailable"
  | "copy-failed"
  | "view-unavailable"
  | "unknown-action";

export type RefinementApplyOutcome =
  | { ok: true; action: ReviewActionId; writtenChars?: number }
  | {
      ok: false;
      action: ReviewActionId;
      reason: RefinementApplyReason;
      message: string;
      conflict?: DraftConflict;
      actions?: ReviewAction[];
    };

function writeOutcome(
  result: boolean | { ok: boolean; error?: string },
): { ok: true } | { ok: false; error: string } {
  if (result === true) return { ok: true };
  if (result === false) return { ok: false, error: "the host refused the write" };
  return result.ok
    ? { ok: true }
    : { ok: false, error: result.error ?? "the host refused the write" };
}

/**
 * Execute one review action under the apply policy.
 *
 * `insert` is the ordinary successful hand-back and performs exactly one
 * conditional write. `replace` is only reachable from a conflict and re-reads
 * the composer, comparing against `confirmedReplaceText` so newer typing is
 * never overwritten.
 */
export function applyRefinementReview(
  input: ApplyRefinementReviewInput,
): RefinementApplyOutcome {
  const { action, review, composer } = input;
  if (!review.ready) {
    return {
      ok: false,
      action,
      reason: "not-ready",
      message: "the refined prompt is not ready for the composer",
    };
  }

  if (action === "view-original" || action === "view-candidate") {
    if (!composer.showText) {
      return {
        ok: false,
        action,
        reason: "view-unavailable",
        message: "this host cannot display the original or refined prompt",
      };
    }
    composer.showText(
      action === "view-original" ? "Original prompt" : "Refined prompt",
      action === "view-original" ? review.originalText : review.candidateText,
    );
    return { ok: true, action };
  }

  if (action === "copy-original" || action === "copy-candidate") {
    if (!composer.copyText) {
      return {
        ok: false,
        action,
        reason: "copy-unavailable",
        message:
          "this host has no clipboard surface; use View instead (the text is unchanged)",
      };
    }
    const copied = composer.copyText(
      action === "copy-original" ? review.originalText : review.candidateText,
    );
    const read = writeOutcome(copied);
    return read.ok
      ? { ok: true, action }
      : {
          ok: false,
          action,
          reason: "copy-failed",
          message: `copy failed: ${read.error}`,
        };
  }

  if (action === "keep-draft" || action === "discard") {
    return { ok: true, action };
  }

  if (action !== "insert" && action !== "replace") {
    return {
      ok: false,
      action,
      reason: "unknown-action",
      message: `unknown review action: ${String(action)}`,
    };
  }

  const current = composer.getText();
  const conflict = detectDraftConflict(input.baselineText, current);
  if (action === "insert" && conflict.conflict) {
    return {
      ok: false,
      action,
      reason: "conflict",
      message:
        conflict.reason === "composer-unavailable"
          ? "the composer cannot be read, so the refined prompt was not inserted; it is kept for Copy/View"
          : "the draft changed while it was being refined; the refined prompt was not inserted and is kept for Copy/View or explicit replacement",
      conflict,
      actions: reviewActions(review, conflict),
    };
  }
  if (action === "replace" && conflict.conflict) {
    // The user confirmed a replacement of a specific newer revision; re-check
    // that the composer has not moved on since they confirmed it. If they
    // undid their edit (current === baseline) this is an ordinary write.
    if (
      input.confirmedReplaceText === undefined ||
      current !== input.confirmedReplaceText
    ) {
      return {
        ok: false,
        action,
        reason: "conflict",
        message:
          "the draft changed again after the replacement was confirmed; nothing was overwritten",
        conflict: detectDraftConflict(input.confirmedReplaceText ?? "", current),
        actions: reviewActions(review, conflict),
      };
    }
  }

  const written = composer.setText(review.candidateText);
  const result = writeOutcome(written);
  if (!result.ok) {
    return {
      ok: false,
      action,
      reason: "write-refused",
      message: `the composer refused the refined prompt: ${result.error}`,
    };
  }
  composer.notify?.(
    `Inserted the refined prompt (${review.changeHeadline}). Edit and send it yourself; nothing was run.`,
    "info",
  );
  return {
    ok: true,
    action,
    writtenChars: review.candidateText.length,
  };
}
