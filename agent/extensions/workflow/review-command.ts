/**
 * Workflow Extension — `/review` command grammar.
 *
 * One shape for the whole family (Decision 1): `/review <verb> [args]`, and
 * bare `/review` or `/review <path>` runs a round. The former hyphenated
 * siblings (`/review-mode|prompt|status|pause|resume|abort`) are gone with no
 * aliases.
 *
 * This module owns *grammar only*: the verb table, the parser, help text and
 * argument completions. It is PURE — no Pi/TUI imports, no filesystem, no live
 * ports and no `review.ts` import (the handler validates timeout ranges with
 * `parseReviewTimeoutArg`). Decision 3 guards are DECLARED here
 * (`blockWhileChildActive`, `admission`) and applied by the dispatcher in the
 * order the table lists them; no guard is inferred from a handler body.
 *
 * Decision 5 is why unknown tokens parse as a path (`kind: "default"`) rather
 * than an error: only an exact, case-insensitive verb match shadows a plan
 * file. `suggestReviewVerb` is the separate hint the handler calls after the
 * path fails to resolve.
 */

import {
  SUGGEST_MAX_DISTANCE,
  splitCommandHead,
  stripOneQuotePair,
  suggestVerb,
} from "./command-text.ts";
import {
  joinArgumentValue,
  suppressExactArgumentMatch,
  type ArgumentCompletion,
} from "./utils.ts";

export const REVIEW_COMMAND_NAME = "review" as const;

export const REVIEW_DESCRIPTION =
  "Run a one-shot Review round (bare /review or /review <path>), or one verb: " +
  "status|pause|resume|abort|say <msg>|mode <on|off|status|timeout>|" +
  "prompt [global]|help [verb].";

/** Help grouping; ordered by `REVIEW_GROUPS`. */
export type ReviewVerbGroup = "round" | "control" | "config" | "help";

/**
 * What the dispatcher calls before the effect (Decision 3).
 *
 * `manual` = `admitReviewerNow({ trigger: "manual" })`, `resume` = the
 * `"resume"` trigger, `none` = no admission call at all.
 */
export type ReviewAdmissionTrigger = "manual" | "resume" | "none";

export interface ReviewVerbSpec {
  /** Verb name; the empty string is the default `/review [path]` form. */
  readonly name: string;
  /** Full usage line, including the command name. */
  readonly usage: string;
  /** One line for help and completion descriptions. */
  readonly summary: string;
  readonly group: ReviewVerbGroup;
  /** Call `blockWhileChildActive(ctx, label)` before admission. */
  readonly blockWhileChildActive: boolean;
  /** Guard label for `blockWhileChildActive` (`/review` or `/review mode`). */
  readonly blockLabel?: string;
  readonly admission: ReviewAdmissionTrigger;
}

/**
 * The default form: bare `/review` or `/review <path>`. It is not a verb, so
 * it is exported separately from `REVIEW_VERBS`, but it carries the same guard
 * class as `say` (Decision 3).
 */
export const REVIEW_DEFAULT_FORM = {
  name: "",
  usage: "/review [path]",
  summary:
    "Run a one-shot Review round for the current plan, or audit the named path.",
  group: "round",
  blockWhileChildActive: true,
  blockLabel: "/review",
  admission: "manual",
} as const satisfies ReviewVerbSpec;

/** The eight verbs, in help/completion order. No aliases, no hidden forms. */
export const REVIEW_VERBS = [
  {
    name: "status",
    usage: "/review status",
    summary:
      "Report the current review round — findings, phase, pause and any error.",
    group: "control",
    blockWhileChildActive: false,
    admission: "none",
  },
  {
    name: "pause",
    usage: "/review pause",
    summary: "Pause the in-flight round; the reviewer session stays warm.",
    group: "control",
    blockWhileChildActive: false,
    admission: "none",
  },
  {
    name: "resume",
    usage: "/review resume [note]",
    summary:
      "Resume a paused round on the warm reviewer session (Plan mode only).",
    group: "control",
    blockWhileChildActive: false,
    admission: "resume",
  },
  {
    name: "abort",
    usage: "/review abort",
    summary:
      "Stop the round (or discard a paused one) — the author's plan stands.",
    group: "control",
    blockWhileChildActive: false,
    admission: "none",
  },
  {
    name: "say",
    usage: "/review say <msg>",
    summary: "Send a message to the in-flight reviewer.",
    group: "control",
    blockWhileChildActive: true,
    blockLabel: "/review",
    admission: "manual",
  },
  {
    name: "mode",
    usage: "/review mode <on|off|status|timeout> [value] [global|project]",
    summary:
      "Configure Review Mode: on|off, status, timeout <seconds|unlimited>; settings carry maxRevisions (0 = one-shot).",
    group: "config",
    blockWhileChildActive: true,
    blockLabel: "/review mode",
    admission: "none",
  },
  {
    name: "prompt",
    usage: "/review prompt [global]",
    summary:
      "Edit the project's additional reviewer guidance (adds to, never replaces, the fixed criteria).",
    group: "config",
    blockWhileChildActive: false,
    admission: "none",
  },
  {
    name: "help",
    usage: "/review help [verb]",
    summary: "Print this list, or the usage and guards for one verb.",
    group: "help",
    blockWhileChildActive: false,
    admission: "none",
  },
] as const satisfies readonly ReviewVerbSpec[];

export type ReviewVerbEntry = (typeof REVIEW_VERBS)[number];
export type ReviewVerbName = ReviewVerbEntry["name"];

/** Every verb name, in table order. */
export const REVIEW_VERB_NAMES: readonly ReviewVerbName[] = REVIEW_VERBS.map(
  (verb) => verb.name,
);

/** Help group order and titles. */
export const REVIEW_GROUPS: readonly {
  key: ReviewVerbGroup;
  title: string;
}[] = [
  { key: "round", title: "Round" },
  { key: "control", title: "Control" },
  { key: "config", title: "Configuration" },
  { key: "help", title: "Help" },
];

/** Scopes every scoped setting accepts, in completion order. */
export const REVIEW_MODE_SCOPES = ["global", "project"] as const;
export type ReviewModeScope = (typeof REVIEW_MODE_SCOPES)[number];

export function isReviewModeScope(token: unknown): token is ReviewModeScope {
  return (
    typeof token === "string" &&
    (REVIEW_MODE_SCOPES as readonly string[]).includes(token.toLowerCase())
  );
}

/** `mode` subcommands, in completion order. */
export const REVIEW_MODE_SUBS = ["on", "off", "status", "timeout"] as const;
export type ReviewModeSub = (typeof REVIEW_MODE_SUBS)[number];

export function isReviewModeSub(token: unknown): token is ReviewModeSub {
  return (
    typeof token === "string" &&
    (REVIEW_MODE_SUBS as readonly string[]).includes(token.toLowerCase())
  );
}

/** Look one verb up by its exact, case-insensitive name. */
export function reviewVerb(name: unknown): ReviewVerbEntry | undefined {
  const head = typeof name === "string" ? name.trim().toLowerCase() : "";
  if (!head) return undefined;
  return REVIEW_VERBS.find((verb) => verb.name === head);
}

/** The table entry for the default `/review [path]` form. */
export function reviewDefaultForm(): typeof REVIEW_DEFAULT_FORM {
  return REVIEW_DEFAULT_FORM;
}

// ── Parsing ──────────────────────────────────────────────────────────

/**
 * Parsed `mode` sub-grammar. `timeout` without a value asks the handler to
 * show the current setting (today's branch); `scope` is fixed by position,
 * never searched for.
 */
export type ReviewModeAction =
  | { action: "on"; scope: ReviewModeScope }
  | { action: "off"; scope: ReviewModeScope }
  | { action: "status" }
  | { action: "timeout"; scope: ReviewModeScope; value?: string };

export type ReviewInvocation =
  | {
      /** Bare `/review` or `/review <path>`; the path may be empty. */
      kind: "default";
      /** Trimmed argument text with one matching quote pair stripped. */
      text: string;
    }
  | { kind: "help"; verb?: ReviewVerbName }
  | {
      kind: "verb";
      verb: ReviewVerbName;
      /** `say` only: the message, byte-for-byte. */
      text?: string;
      /** `resume` only: an optional free-text note. */
      note?: string;
      /** `mode` only. */
      mode?: ReviewModeAction;
      /** `prompt` only. */
      scope?: ReviewModeScope;
    }
  | {
      kind: "error";
      /** The lowercased token that failed, when one is known. */
      verb?: string;
      /** Complete user-facing sentence(s); never empty. */
      text: string;
    };

function usageError(spec: ReviewVerbSpec, detail?: string): ReviewInvocation {
  return {
    kind: "error",
    verb: spec.name,
    text: `${detail ? `${detail}\n` : ""}Usage: ${spec.usage}`,
  };
}

function unknownVerbError(head: string): ReviewInvocation {
  const suggestion = suggestVerb(head, REVIEW_VERB_NAMES);
  if (!suggestion) {
    return {
      kind: "error",
      verb: head,
      text: `Unknown Review verb "${head}". Run /review help for the verb list.`,
    };
  }
  return {
    kind: "error",
    verb: head,
    text: `Unknown Review verb "${head}". ${suggestion.text}`,
  };
}

/** Timeout values `parseReviewTimeoutArg` accepts, minus the numeric range. */
function isReviewTimeoutValue(token: string): boolean {
  const value = token.trim().toLowerCase();
  if (["unlimited", "off", "none"].includes(value)) return true;
  return /^\d+$/.test(value);
}

function parseMode(spec: ReviewVerbSpec, rest: string): ReviewInvocation {
  if (!rest) return { kind: "verb", verb: "mode", mode: { action: "status" } };
  const tokens = rest.split(/\s+/).filter(Boolean);
  const sub = (tokens[0] ?? "").toLowerCase();
  if (!isReviewModeSub(sub)) {
    return usageError(spec, `Unknown review mode subcommand "${tokens[0]}".`);
  }

  const scopeAt = (index: number, fallback: ReviewModeScope): ReviewModeScope | ReviewInvocation => {
    const token = tokens[index];
    if (token === undefined) return fallback;
    if (!isReviewModeScope(token)) {
      return usageError(spec, `Unknown scope "${token}". Expected global|project.`);
    }
    return token.toLowerCase() as ReviewModeScope;
  };

  switch (sub) {
    case "on":
    case "off": {
      if (tokens.length > 2) {
        return usageError(spec, `Unexpected argument "${tokens[2]}".`);
      }
      const scope = scopeAt(1, "global");
      if (typeof scope !== "string") return scope;
      return { kind: "verb", verb: "mode", mode: { action: sub, scope } };
    }
    case "status": {
      if (tokens.length > 1) {
        return usageError(spec, `Unexpected argument "${tokens[1]}".`);
      }
      return { kind: "verb", verb: "mode", mode: { action: "status" } };
    }
    case "timeout": {
      if (tokens.length > 3) {
        return usageError(spec, `Unexpected argument "${tokens[3]}".`);
      }
      const value = tokens[1];
      if (value !== undefined && !isReviewTimeoutValue(value)) {
        return usageError(
          spec,
          `Invalid timeout "${value}". Expected <seconds|unlimited>.`,
        );
      }
      const scope = scopeAt(2, "global");
      if (typeof scope !== "string") return scope;
      return {
        kind: "verb",
        verb: "mode",
        mode:
          value === undefined
            ? { action: "timeout", scope }
            : { action: "timeout", scope, value },
      };
    }
    default: {
      // Exhaustive over `ReviewModeSub`: unreachable today. A new subcommand
      // added without a branch lands here instead of silently parsing.
      return usageError(spec, `Unknown review mode subcommand "${sub}".`);
    }
  }
}

function parsePrompt(spec: ReviewVerbSpec, rest: string): ReviewInvocation {
  if (!rest) return { kind: "verb", verb: "prompt", scope: "project" };
  const tokens = rest.split(/\s+/).filter(Boolean);
  if (tokens.length > 1) {
    return usageError(spec, `Unexpected argument "${tokens[1]}".`);
  }
  const token = tokens[0] ?? "";
  if (!isReviewModeScope(token)) {
    return usageError(spec, `Unknown scope "${token}". Expected global|project.`);
  }
  return {
    kind: "verb",
    verb: "prompt",
    scope: token.toLowerCase() as ReviewModeScope,
  };
}

/**
 * Parse the text after `/review`.
 *
 * Decision 5: the first token is a verb only on an exact (case-insensitive)
 * match; otherwise the whole text is a plan path with one matching quote pair
 * stripped. So `help`, `status`, `mode`, `prompt`, `pause`, `resume`, `abort`
 * and `say` shadow a plan file with that exact name — quoting the path
 * (`/review "status"`) makes it a path again.
 *
 * Rules:
 *   - empty / non-verb      → default form (path may be empty)
 *   - `--help` / `-h`       → help (optionally for one named verb)
 *   - `help [verb]`         → help
 *   - `<verb> --help` / `-h`→ help for that verb
 *   - `say <msg>`           → the message; empty is a usage error
 *   - `mode …`              → strict sub-grammar (scope fixed by position)
 *   - `prompt [global]`     → scope, default project; extras are an error
 *   - `resume [note]`       → optional free-text note
 *   - `status|pause|abort`  → reject extra tokens
 */
export function parseReviewInvocation(raw: unknown): ReviewInvocation {
  const text = typeof raw === "string" ? raw.trim() : "";
  const { head, rest } = splitCommandHead(text);
  if (!head) return { kind: "default", text: "" };

  if (head === "--help" || head === "-h") {
    const named = reviewVerb(rest);
    return named ? { kind: "help", verb: named.name } : { kind: "help" };
  }

  if (head === "help") {
    if (!rest || rest === "--help" || rest === "-h") return { kind: "help" };
    const named = reviewVerb(rest);
    if (named) return { kind: "help", verb: named.name };
    return unknownVerbError(splitCommandHead(rest).head);
  }

  const spec = reviewVerb(head);
  // Decision 5: not a verb → the whole text is a path, one quote pair off.
  if (!spec) return { kind: "default", text: stripOneQuotePair(text) };

  if (rest === "--help" || rest === "-h") {
    return { kind: "help", verb: spec.name };
  }

  switch (spec.name) {
    case "status":
    case "pause":
    case "abort": {
      if (rest) return usageError(spec, `Unexpected argument "${rest}".`);
      return { kind: "verb", verb: spec.name };
    }
    case "resume": {
      return rest
        ? { kind: "verb", verb: "resume", note: rest }
        : { kind: "verb", verb: "resume" };
    }
    case "say": {
      if (!rest) return usageError(spec, "A message is required.");
      return { kind: "verb", verb: "say", text: rest };
    }
    case "mode": {
      return parseMode(spec, rest);
    }
    case "prompt": {
      return parsePrompt(spec, rest);
    }
    case "help": {
      // The `help` branch above returns before this; kept exhaustive so a new
      // verb cannot fall through without a parse rule.
      return { kind: "help" };
    }
    default: {
      return { kind: "error", text: "Unsupported Review argument." };
    }
  }
}

/**
 * Nearest Review verb for a token that did not resolve to a readable plan.
 *
 * The handler calls this only AFTER path resolution fails, so a real plan file
 * named `statsu` is never "corrected". Rules are `command-text.ts`'s: only
 * alphabetic tokens qualify and the edit distance is at most
 * `SUGGEST_MAX_DISTANCE` (2). An exact verb is not a suggestion.
 */
export function suggestReviewVerb(token: unknown) {
  return suggestVerb(token, REVIEW_VERB_NAMES);
}

// ── Help ─────────────────────────────────────────────────────────────

/** The Decision 3 guard class as one help line. */
export function describeReviewGuards(spec: ReviewVerbSpec): string {
  const parts: string[] = [];
  if (spec.blockWhileChildActive) {
    parts.push(`refuses while a Build child is active (${spec.blockLabel ?? "/review"})`);
  }
  if (spec.admission === "manual") {
    parts.push("Reviewer admission on the `manual` trigger");
  } else if (spec.admission === "resume") {
    parts.push("Reviewer admission on the `resume` trigger");
  }
  if (parts.length === 0) return "No guards — it never blocks or admits a reviewer.";
  return `${parts.join("; ")}.`;
}

/**
 * Build the help text: the whole table, or one verb's usage and guards.
 *
 * Teaches the bare/path form, the shadowing caveat and the Decision 4
 * distinction between `/review status` (the round) and `/review mode status`
 * (configuration). An unknown verb falls back to the full list; the parser
 * already reports the error.
 */
export function formatReviewHelp(verb?: unknown): string {
  const spec = reviewVerb(verb);
  if (spec) {
    return [
      `Usage: ${spec.usage}`,
      `  ${spec.summary}`,
      `  Guards: ${describeReviewGuards(spec)}`,
      "Run /review help for every verb.",
    ].join("\n");
  }

  const entries: readonly ReviewVerbSpec[] = [REVIEW_DEFAULT_FORM, ...REVIEW_VERBS];
  const width = Math.max(...entries.map((entry) => entry.usage.length));
  const lines: string[] = [
    "Usage: /review [<verb>] [args]",
    "Bare /review runs a one-shot Review round for the current plan; /review <path> audits that file (Plan mode only).",
    "Every verb is exact — there are no aliases; `--help`/`-h` prints this list.",
    "",
  ];
  for (const group of REVIEW_GROUPS) {
    const grouped = entries.filter((entry) => entry.group === group.key);
    if (grouped.length === 0) continue;
    lines.push(group.title);
    for (const entry of grouped) {
      lines.push(`  ${entry.usage.padEnd(width)}  ${entry.summary}`);
    }
    lines.push("");
  }
  lines.push(
    "Shadowing: a plan file named exactly `status`, `pause`, `resume`, `abort`, `say`, `mode`, `prompt` or `help` loses to the verb — quote the path (/review \"status\") or name it from a directory.",
    "Different questions: /review status reports the review round; /review mode status reports configuration (enabled, timeout and source, prompt source, shadowed scope).",
    "Revisions: reviewMode.maxRevisions (0-5, default 3) caps automatic Planner revision turns; 0 makes every review one-shot.",
    `Unknown-token hints use edit distance up to ${SUGGEST_MAX_DISTANCE}; paths and file names are never corrected.`,
  );
  return lines.join("\n");
}

// ── Completions ──────────────────────────────────────────────────────

/**
 * Data the completion surface needs. Injected as a plain object so this module
 * stays pure: the composition root supplies `listRecentPlanFiles(...)`.
 */
export interface ReviewCompletionContext {
  /** Recent plan paths, most recent first (`listRecentPlanFiles`). */
  plans?: readonly string[];
}

function completion(
  prefix: string,
  token: string,
  description: string,
): ArgumentCompletion {
  return {
    value: joinArgumentValue(prefix, token),
    label: token,
    description,
  };
}

function finish(
  items: ArgumentCompletion[],
  partial: string,
): ArgumentCompletion[] | null {
  const needle = partial.toLowerCase();
  const filtered = needle
    ? items.filter((item) => item.label.toLowerCase().startsWith(needle))
    : items;
  if (filtered.length === 0) return null;
  if (suppressExactArgumentMatch(filtered.map((item) => item.label), partial)) {
    return null;
  }
  return filtered;
}

/** Verbs whose completion should commit a trailing space (they take args). */
function verbTakesArgument(spec: ReviewVerbSpec): boolean {
  return ["say", "mode", "prompt", "help"].includes(spec.name);
}

function scopeItems(prefix: string): ArgumentCompletion[] {
  return REVIEW_MODE_SCOPES.map((scope) =>
    completion(prefix, scope, `write the ${scope} settings`),
  );
}

/**
 * Argument completions for `/review` (pi-tui full-argument contract).
 *
 *   /review <tab>                  → every verb plus recent plans
 *   /review sta<tab>               → status
 *   /review mode <tab>             → on|off|status|timeout
 *   /review mode on|off <tab>      → global|project
 *   /review mode timeout <tab>     → unlimited
 *   /review mode timeout <v> <tab> → global|project
 *   /review prompt <tab>           → global|project
 *   /review help <tab>             → verb names
 *   /review say <tab>              → nothing (free text)
 *
 * Every `value` is the complete replacement for the typed argument text (see
 * `joinArgumentValue`). Returns null when there is nothing to offer. Pure.
 */
export function reviewCompletionItems(
  raw: unknown,
  ctx: ReviewCompletionContext = {},
): ArgumentCompletion[] | null {
  const text = typeof raw === "string" ? raw : "";
  const trimmed = text.trim();
  const endsWithWs = /\s$/.test(text);
  // Leading whitespace is not a committed token: only whitespace AFTER the
  // verb moves the cursor into the argument position.
  const body = text.replace(/^\s+/, "");

  // ── Verb position (the default form's path lives here too) ──────────
  if (!trimmed || !/\s/.test(body)) {
    const partial = trimmed.toLowerCase();
    const verbs: ArgumentCompletion[] = REVIEW_VERBS.filter((spec) =>
      spec.name.startsWith(partial),
    ).map((spec) => ({
      value: verbTakesArgument(spec) ? `${spec.name} ` : spec.name,
      label: spec.name,
      description: spec.summary,
    }));
    const plans: ArgumentCompletion[] = (ctx.plans ?? [])
      .filter((plan) => typeof plan === "string" && plan.length > 0)
      .map((plan) => completion("", plan, "review this plan"));
    return finish([...verbs, ...plans], partial);
  }

  const tokens = trimmed.split(/\s+/).filter(Boolean);
  // The completion prefix keeps the typed trailing whitespace: `joinArgumentValue`
  // needs it to append rather than replace the token.
  const prefix = body;
  const head = (tokens[0] ?? "").toLowerCase();
  const spec = reviewVerb(head);
  // The default form takes one path; a second token is free text.
  if (!spec) return null;

  const argTokens = tokens.slice(1);
  const argIndex = endsWithWs
    ? argTokens.length
    : Math.max(argTokens.length - 1, 0);
  const partial = endsWithWs ? "" : (argTokens[argIndex] ?? "");
  // Nothing past the position being completed.
  if (argTokens.length > argIndex + 1) return null;

  switch (spec.name) {
    case "mode": {
      if (argIndex === 0) {
        const items = REVIEW_MODE_SUBS.map((sub) =>
          completion(prefix, sub, `review mode ${sub}`),
        );
        return finish(items, partial);
      }
      const sub = (argTokens[0] ?? "").toLowerCase();
      if (sub === "on" || sub === "off") {
        if (argIndex !== 1) return null;
        return finish(scopeItems(prefix), partial);
      }
      if (sub === "timeout") {
        if (argIndex === 1) {
          return finish(
            [completion(prefix, "unlimited", "remove the review timeout cap")],
            partial,
          );
        }
        if (argIndex === 2) return finish(scopeItems(prefix), partial);
        return null;
      }
      return null;
    }
    case "prompt": {
      if (argIndex !== 0) return null;
      return finish(scopeItems(prefix), partial);
    }
    case "help": {
      if (argIndex !== 0) return null;
      const items = REVIEW_VERBS.map((entry) =>
        completion(prefix, entry.name, entry.summary),
      );
      return finish(items, partial);
    }
    default:
      // `status`/`pause`/`abort` take no argument; `resume` takes free text;
      // `say` is free text.
      return null;
  }
}
