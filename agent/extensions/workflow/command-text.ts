/**
 * Workflow Extension — shared command-text helpers.
 *
 * The `/orchestrator` and `/review` families share one shape,
 * `/object <verb> [args]`, and therefore one handful of text primitives: split
 * the first token off an argument string, unwrap one matching quote pair from a
 * path, and turn an unknown token into a nearest-verb hint.
 *
 * This module is PURE: no Pi/TUI imports, no filesystem, no state. It is the
 * ~40-line base Decision 9 allows instead of a command framework; the verb
 * tables live in `orchestrator-command.ts` and `review-command.ts`.
 */

export interface CommandHead {
  /** First whitespace-delimited token, lowercased. Empty for blank input. */
  head: string;
  /** Everything after the head, trimmed. Empty when only the head was typed. */
  rest: string;
}

/**
 * Split the first token off a raw slash-command argument string.
 *
 *   splitCommandHead("  Status  ")        → { head: "status", rest: "" }
 *   splitCommandHead("start 'a b.md'")    → { head: "start", rest: "'a b.md'" }
 *   splitCommandHead("")                  → { head: "", rest: "" }
 *
 * The head is lowercased so callers compare verbs case-insensitively; the rest
 * keeps its original casing because it may be a path or a message. Non-string
 * input (a host passing undefined) is treated as empty. Pure; never throws.
 */
export function splitCommandHead(raw: unknown): CommandHead {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (text.length === 0) return { head: "", rest: "" };
  const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(text);
  if (!match) return { head: "", rest: "" };
  return {
    head: (match[1] ?? "").toLowerCase(),
    rest: (match[2] ?? "").trim(),
  };
}

/**
 * Strip exactly ONE matching leading/trailing quote pair (`'…'` or `"…"`).
 *
 *   stripOneQuotePair(`"a b.md"`)  → "a b.md"
 *   stripOneQuotePair(`'a".md'`)   → `a".md`
 *   stripOneQuotePair(`"a.md`)     → `"a.md`   (unmatched, left alone)
 *   stripOneQuotePair(`'a.md"`)    → `'a.md"`  (mismatched, left alone)
 *
 * Outer whitespace is trimmed first. Only one pair is removed, so a path that
 * genuinely starts and ends with a quote keeps its inner pair. Pure.
 */
export function stripOneQuotePair(text: unknown): string {
  const trimmed = typeof text === "string" ? text.trim() : "";
  if (trimmed.length < 2) return trimmed;
  const first = trimmed[0];
  if (first !== "'" && first !== '"') return trimmed;
  if (trimmed[trimmed.length - 1] !== first) return trimmed;
  return trimmed.slice(1, -1);
}

/** Levenshtein edit distance over two already-lowercased strings. */
function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const substitution = (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1);
      const deletion = (previous[j] ?? 0) + 1;
      const insertion = (current[j - 1] ?? 0) + 1;
      current[j] = Math.min(substitution, deletion, insertion);
    }
    previous = current;
  }
  return previous[b.length] ?? 0;
}

/** A token is suggestable only when it is alphabetic (never a path or a ref). */
function isAlphabetic(token: string): boolean {
  return /^[a-z]+$/.test(token.toLowerCase());
}

export const SUGGEST_MAX_DISTANCE = 2;

/** The removed `/orchestrator cancel` verb and the verb that replaced it. */
export const CANCEL_MIGRATION_FROM = "cancel";
export const CANCEL_MIGRATION_TO = "stop";

/** Sentence shown when the token is the removed `cancel` verb. */
export const CANCEL_MIGRATION_SENTENCE =
  `"${CANCEL_MIGRATION_FROM}" is now "${CANCEL_MIGRATION_TO}".`;

export interface VerbSuggestion {
  /** The verb the user most likely meant. */
  verb: string;
  /** True only for the `cancel` → `stop` migration. */
  migration: boolean;
  /** Ready-to-append sentence for the caller's error line. */
  text: string;
}

/**
 * Nearest known verb for an unknown token, or undefined.
 *
 * Rules (Decision 2): only alphabetic tokens are corrected — a row ref like
 * `3` or a path must never be "corrected" into a verb — and only candidates
 * within edit distance `SUGGEST_MAX_DISTANCE` qualify. An exact match is not a
 * suggestion. Ties break alphabetically so the hint is deterministic.
 *
 * `cancel` is special: the verb was removed in favour of `stop`, so when the
 * table contains `stop` the hint is the migration sentence rather than a
 * generic "did you mean". The sentence is command-agnostic on purpose; the
 * caller names its own command. Pure; never throws.
 */
export function suggestVerb(
  token: unknown,
  verbs: readonly string[],
): VerbSuggestion | undefined {
  const raw = typeof token === "string" ? token.trim().toLowerCase() : "";
  if (!isAlphabetic(raw)) return undefined;
  const known = verbs
    .map((verb) => (typeof verb === "string" ? verb.trim().toLowerCase() : ""))
    .filter((verb) => verb.length > 0);
  if (known.length === 0) return undefined;

  if (raw === CANCEL_MIGRATION_FROM && known.includes(CANCEL_MIGRATION_TO)) {
    return {
      verb: CANCEL_MIGRATION_TO,
      migration: true,
      text: CANCEL_MIGRATION_SENTENCE,
    };
  }
  if (known.includes(raw)) return undefined;

  let best: { verb: string; distance: number } | undefined;
  for (const verb of known) {
    const distance = editDistance(raw, verb);
    if (distance === 0 || distance > SUGGEST_MAX_DISTANCE) continue;
    if (
      !best ||
      distance < best.distance ||
      (distance === best.distance && verb < best.verb)
    ) {
      best = { verb, distance };
    }
  }
  if (!best) return undefined;
  return {
    verb: best.verb,
    migration: false,
    text: `Did you mean "${best.verb}"?`,
  };
}
