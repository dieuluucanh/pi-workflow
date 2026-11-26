/**
 * Workflow Extension — `/orchestrator` command grammar.
 *
 * One shape for the whole family (Decision 1): `/orchestrator <verb> [args]`.
 * Bare `/orchestrator` enters Orchestrator mode. The former hyphenated
 * siblings (`/orchestrator-pause|resume|abort|view`) are gone with no aliases;
 * the only migration aid is the error sentence for the removed `cancel` verb
 * ("cancel is now stop"), which comes from `command-text.ts`.
 *
 * This module owns *grammar only*: the verb table, the parser, help text and
 * argument completions. It is PURE — no Pi/TUI imports, no filesystem, no
 * live ports. The operator (`orchestrator-operator.ts`) keeps the effects; the
 * composition root passes completion data in as a plain object.
 *
 * Decision 3 guards are DECLARED here (`requiresMode`, `run`, `requiresChild`)
 * and applied by the dispatcher, never inferred from a handler body.
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

/**
 * Longest accepted `/orchestrator say` message.
 *
 * The operator imports this constant (row 3) so the parser and the delivery
 * path cannot drift; nothing here imports the operator, so there is no cycle.
 */
export const MAX_SAY_CHARS = 2_000;

export const ORCHESTRATOR_COMMAND_NAME = "orchestrator" as const;

export const ORCHESTRATOR_DESCRIPTION =
  "Enter Orchestrator mode (bare /orchestrator), or run one verb: " +
  "start [path]|status|inspect [rowRef]|pause|resume|abort|retry [rowRef]|" +
  "stop|say <text>|view [child|parent|auto]|help [verb].";

/** Argument shapes the parser understands. */
export type OrchestratorArgKind = "none" | "path?" | "rowRef?" | "view" | "text";

/** Help grouping; ordered by `ORCHESTRATOR_GROUPS`. */
export type OrchestratorVerbGroup = "run" | "child" | "view" | "help";

/** How much state a verb needs before its effect may run (Decision 3). */
export type OrchestratorRunRequirement = "required" | "forbidden" | "none";

export interface OrchestratorVerbSpec {
  readonly name: string;
  /** Full usage line, including the command name. */
  readonly usage: string;
  /** One line for help and completion descriptions. */
  readonly summary: string;
  readonly args: OrchestratorArgKind;
  readonly group: OrchestratorVerbGroup;
  /** Orchestrator mode is required (start and every control verb). */
  readonly requiresMode: boolean;
  readonly run: OrchestratorRunRequirement;
  /** A live or paused child must exist (pause/abort/say). */
  readonly requiresChild: boolean;
}

/**
 * The verb table. There is exactly one entry per verb; no aliases, no hidden
 * forms. `start` is the only verb that refuses an active run: a completed or
 * cancelled run (or one whose rows are all settled) is replaced instead, and
 * `status`, `inspect`, `view` and `help` are the only verbs usable outside
 * Orchestrator mode.
 */
export const ORCHESTRATOR_VERBS = [
  {
    name: "start",
    usage: "/orchestrator start [path]",
    summary:
      "Record the approved plan and start the model-driven run (replaces a completed or cancelled run; dispatches one row at a time).",
    args: "path?",
    group: "run",
    requiresMode: true,
    run: "forbidden",
    requiresChild: false,
  },
  {
    name: "status",
    usage: "/orchestrator status",
    summary: "Report the bound run, row progress, the live child and the next row.",
    args: "none",
    group: "run",
    requiresMode: false,
    run: "none",
    requiresChild: false,
  },
  {
    name: "inspect",
    usage: "/orchestrator inspect [rowRef]",
    summary: "Show one run row: root, instruction, last report and child detail.",
    args: "rowRef?",
    group: "run",
    requiresMode: false,
    run: "required",
    requiresChild: false,
  },
  {
    name: "retry",
    usage: "/orchestrator retry [rowRef]",
    summary: "Dispatch the named row again (or the current/next row) with its stored instruction.",
    args: "rowRef?",
    group: "run",
    requiresMode: true,
    run: "required",
    requiresChild: false,
  },
  {
    name: "pause",
    usage: "/orchestrator pause",
    summary: "Pause the live Build child; the warm session is kept.",
    args: "none",
    group: "child",
    requiresMode: true,
    run: "required",
    requiresChild: true,
  },
  {
    name: "resume",
    usage: "/orchestrator resume",
    summary: "Resume the paused child, or start a fresh one through the retry port.",
    args: "none",
    group: "child",
    requiresMode: true,
    run: "required",
    requiresChild: false,
  },
  {
    name: "abort",
    usage: "/orchestrator abort",
    summary: "Abort the active row's child and leave the run retryable.",
    args: "none",
    group: "child",
    requiresMode: true,
    run: "required",
    requiresChild: true,
  },
  {
    name: "stop",
    usage: "/orchestrator stop",
    summary: "Stop the run: dispose the child and cancel the run record.",
    args: "none",
    group: "child",
    requiresMode: true,
    run: "required",
    requiresChild: false,
  },
  {
    name: "say",
    usage: "/orchestrator say <text>",
    summary: "Deliver a message to the running or paused child.",
    args: "text",
    group: "child",
    requiresMode: true,
    run: "required",
    requiresChild: true,
  },
  {
    name: "view",
    usage: "/orchestrator view [child|parent|auto]",
    summary: "Show or set which session the UI follows.",
    args: "view",
    group: "view",
    requiresMode: false,
    run: "none",
    requiresChild: false,
  },
  {
    name: "help",
    usage: "/orchestrator help [verb]",
    summary: "Print this list, or the usage and guards for one verb.",
    args: "none",
    group: "help",
    requiresMode: false,
    run: "none",
    requiresChild: false,
  },
] as const satisfies readonly OrchestratorVerbSpec[];

export type OrchestratorVerbEntry = (typeof ORCHESTRATOR_VERBS)[number];
export type OrchestratorVerbName = OrchestratorVerbEntry["name"];

/** Every verb name, in table order. */
export const ORCHESTRATOR_VERB_NAMES: readonly OrchestratorVerbName[] =
  ORCHESTRATOR_VERBS.map((verb) => verb.name);

/** Help group order and titles. */
export const ORCHESTRATOR_GROUPS: readonly {
  key: OrchestratorVerbGroup;
  title: string;
}[] = [
  { key: "run", title: "Run" },
  { key: "child", title: "Child" },
  { key: "view", title: "View" },
  { key: "help", title: "Help" },
];

/** Views `/orchestrator view` accepts, in completion order. */
export const ORCHESTRATOR_VIEWS = ["child", "parent", "auto"] as const;
export type OrchestratorView = (typeof ORCHESTRATOR_VIEWS)[number];

export function isOrchestratorView(token: unknown): token is OrchestratorView {
  return (
    typeof token === "string" &&
    (ORCHESTRATOR_VIEWS as readonly string[]).includes(token)
  );
}

/** Look one verb up by its exact, case-insensitive name. */
export function orchestratorVerb(
  name: unknown,
): OrchestratorVerbEntry | undefined {
  const head = typeof name === "string" ? name.trim().toLowerCase() : "";
  if (!head) return undefined;
  return ORCHESTRATOR_VERBS.find((verb) => verb.name === head);
}

// ── Parsing ──────────────────────────────────────────────────────────

export type OrchestratorInvocation =
  | { kind: "mode-entry" }
  | { kind: "help"; verb?: OrchestratorVerbName }
  | {
      kind: "verb";
      verb: OrchestratorVerbName;
      /** `start` only: one quote pair stripped; absent when bare. */
      path?: string;
      /** `inspect`/`retry` only: the explicit row ref; absent when bare. */
      rowRef?: string;
      /** `view` only: the requested view; absent means "report the current one". */
      view?: OrchestratorView;
      /** `say` only: the message, byte-for-byte. */
      text?: string;
    }
  | {
      kind: "error";
      /** The lowercased token that failed, when one is known. */
      verb?: string;
      /** Complete user-facing sentence(s); never empty. */
      text: string;
    };

function usageError(spec: OrchestratorVerbSpec, detail?: string): OrchestratorInvocation {
  return {
    kind: "error",
    verb: spec.name,
    text: `${detail ? `${detail}\n` : ""}Usage: ${spec.usage}`,
  };
}

function unknownVerbError(head: string): OrchestratorInvocation {
  const suggestion = suggestVerb(head, ORCHESTRATOR_VERB_NAMES);
  if (!suggestion) {
    return {
      kind: "error",
      verb: head,
      text: `Unknown Orchestrator verb "${head}". Run /orchestrator help for the verb list.`,
    };
  }
  if (suggestion.migration) {
    return {
      kind: "error",
      verb: head,
      text: `Unknown Orchestrator verb "${head}". ${suggestion.text} Run /orchestrator ${suggestion.verb}.`,
    };
  }
  return {
    kind: "error",
    verb: head,
    text: `Unknown Orchestrator verb "${head}". ${suggestion.text}`,
  };
}

/**
 * Parse the text after `/orchestrator`.
 *
 * Rules (all case-insensitive on the verb):
 *   - empty                          → mode entry
 *   - `--help` / `-h`                → help (optionally for one named verb)
 *   - `help [verb]`                  → help
 *   - `<verb> --help` / `-h`         → help for that verb
 *   - zero-arg verbs reject extras   → usage error
 *   - `view` rejects a non-enum      → usage error
 *   - `say` refuses empty/over-long  → usage/limit sentence; nothing is sent
 *   - `start` takes one quote pair off the optional path
 *   - `inspect`/`retry` take one optional row ref (a single token)
 *   - anything else                  → unknown verb, with the nearest hint
 */
export function parseOrchestratorInvocation(raw: unknown): OrchestratorInvocation {
  const { head, rest } = splitCommandHead(raw);
  if (!head) return { kind: "mode-entry" };

  const helpIsRequested = (verb: OrchestratorVerbSpec) =>
    rest === "--help" || rest === "-h" ? { verb: verb.name } : undefined;

  if (head === "--help" || head === "-h") {
    const named = orchestratorVerb(rest);
    return named ? { kind: "help", verb: named.name } : { kind: "help" };
  }

  if (head === "help") {
    if (!rest || rest === "--help" || rest === "-h") return { kind: "help" };
    const named = orchestratorVerb(rest);
    if (named) return { kind: "help", verb: named.name };
    return unknownVerbError(splitCommandHead(rest).head);
  }

  const spec = orchestratorVerb(head);
  if (!spec) return unknownVerbError(head);

  if (helpIsRequested(spec)) return { kind: "help", verb: spec.name };

  switch (spec.args) {
    case "none": {
      if (rest) return usageError(spec, `Unexpected argument "${rest}".`);
      return { kind: "verb", verb: spec.name };
    }
    case "path?": {
      if (!rest) return { kind: "verb", verb: spec.name };
      const path = stripOneQuotePair(rest);
      if (!path) {
        return usageError(spec, "The path is empty after unquoting.");
      }
      return { kind: "verb", verb: spec.name, path };
    }
    case "rowRef?": {
      if (!rest) return { kind: "verb", verb: spec.name };
      const tokens = rest.split(/\s+/).filter(Boolean);
      if (tokens.length !== 1) {
        return usageError(spec, `Expected a single row ref, got "${rest}".`);
      }
      return { kind: "verb", verb: spec.name, rowRef: tokens[0] };
    }
    case "view": {
      if (!rest) return { kind: "verb", verb: spec.name };
      const view = rest.toLowerCase();
      if (!isOrchestratorView(view)) {
        return usageError(
          spec,
          `Unknown view "${rest}". Expected one of ${ORCHESTRATOR_VIEWS.join("|")}.`,
        );
      }
      return { kind: "verb", verb: spec.name, view };
    }
    case "text": {
      if (!rest) return usageError(spec, "A message is required.");
      if (rest.length > MAX_SAY_CHARS) {
        return usageError(
          spec,
          `The message is ${rest.length} characters; the limit is ${MAX_SAY_CHARS}. Nothing was delivered.`,
        );
      }
      return { kind: "verb", verb: spec.name, text: rest };
    }
    default: {
      // Exhaustive over `OrchestratorArgKind`: unreachable today. A new kind
      // added without a branch lands here instead of silently parsing.
      return { kind: "error", text: "Unsupported Orchestrator argument." };
    }
  }
}

// ── Help ─────────────────────────────────────────────────────────────

/** Decision 3 flags as one help line (no guard is inferred elsewhere). */
export function describeOrchestratorGuards(spec: OrchestratorVerbSpec): string {
  const mode = spec.requiresMode
    ? "Orchestrator mode required"
    : "usable in any mode";
  const run =
    spec.run === "required"
      ? "a bound run is required"
      : spec.run === "forbidden"
        ? "refuses an active run; replaces a completed or cancelled one"
        : "no run needed";
  const child = spec.requiresChild
    ? "; a live or paused child is required"
    : "";
  return `${mode}; ${run}${child}.`;
}

/**
 * Build the help text: the whole table, or one verb's usage and guards.
 * An unknown verb falls back to the full list (the parser already reports the
 * error). Every non-help verb appears exactly once, grouped, with no aliases.
 */
export function formatOrchestratorHelp(verb?: unknown): string {
  const spec = orchestratorVerb(verb);
  if (spec) {
    return [
      `Usage: ${spec.usage}`,
      `  ${spec.summary}`,
      `  Guards: ${describeOrchestratorGuards(spec)}`,
      "Run /orchestrator help for every verb.",
    ].join("\n");
  }

  const width = Math.max(...ORCHESTRATOR_VERBS.map((entry) => entry.usage.length));
  const lines: string[] = [
    "Usage: /orchestrator [<verb>] [args]",
    "Bare /orchestrator enters Orchestrator mode (same as Tab).",
    "Every verb is exact — there are no aliases; `--help`/`-h` prints this list.",
    "",
  ];
  for (const group of ORCHESTRATOR_GROUPS) {
    const entries = ORCHESTRATOR_VERBS.filter((entry) => entry.group === group.key);
    if (entries.length === 0) continue;
    lines.push(group.title);
    for (const entry of entries) {
      lines.push(`  ${entry.usage.padEnd(width)}  ${entry.summary}`);
    }
    lines.push("");
  }
  lines.push(
    "`cancel` was removed: use `stop`.",
    `Unknown-token hints use edit distance up to ${SUGGEST_MAX_DISTANCE}; row refs and paths are never corrected.`,
  );
  return lines.join("\n");
}

// ── Completions ──────────────────────────────────────────────────────

/**
 * Data the completion surface needs. Injected as a plain object so this module
 * stays pure: the composition root supplies `listRecentPlanFiles(...)` and the
 * run's row refs, and nothing here imports `index.ts` or a Pi type.
 */
export interface OrchestratorCompletionContext {
  /** Recent plan paths, most recent first (`listRecentPlanFiles`). */
  plans?: readonly string[];
  /** Row refs of the bound run, in order. */
  rows?: readonly string[];
  /** The run's current row ref, offered in addition to `rows`. */
  currentRef?: string;
}

function verbTakesArgument(spec: OrchestratorVerbSpec): boolean {
  // `help` is listed as taking no argument but accepts an optional verb name.
  return spec.args !== "none" || spec.name === "help";
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

/**
 * Argument completions for `/orchestrator` (pi-tui full-argument contract).
 *
 *   /orchestrator <tab>                → every verb
 *   /orchestrator st<tab>              → start, status, stop
 *   /orchestrator start <tab>          → recent plans
 *   /orchestrator inspect|retry <tab>  → run rows plus the current ref
 *   /orchestrator view <tab>           → child|parent|auto
 *   /orchestrator help <tab>           → verb names
 *
 * Every `value` is the complete replacement for the typed argument text (see
 * `joinArgumentValue`). Returns null when there is nothing to offer. Pure.
 */
export function orchestratorCompletionItems(
  raw: unknown,
  ctx: OrchestratorCompletionContext = {},
): ArgumentCompletion[] | null {
  const text = typeof raw === "string" ? raw : "";
  const trimmed = text.trim();
  const endsWithWs = /\s$/.test(text);
  // Leading whitespace is not a committed token: only whitespace AFTER the
  // verb moves the cursor into the argument position.
  const body = text.replace(/^\s+/, "");

  // ── Verb position ──────────────────────────────────────────────────
  if (!trimmed || !/\s/.test(body)) {
    const partial = trimmed.toLowerCase();
    const items = ORCHESTRATOR_VERBS.filter((spec) =>
      spec.name.startsWith(partial),
    ).map((spec) => ({
      value: verbTakesArgument(spec) ? `${spec.name} ` : spec.name,
      label: spec.name,
      description: spec.summary,
    }));
    return finish(items, partial);
  }

  const tokens = trimmed.split(/\s+/).filter(Boolean);
  // The completion prefix keeps the typed trailing whitespace: `joinArgumentValue`
  // needs it to append rather than replace the token.
  const prefix = body;
  const head = (tokens[0] ?? "").toLowerCase();
  const spec = orchestratorVerb(head);
  if (!spec) return null;

  // Every verb takes at most one argument, so a third token is free text.
  if (tokens.length > 2) return null;
  const partial = endsWithWs ? "" : (tokens[1] ?? "");
  if (tokens.length === 2 && endsWithWs) return null;

  switch (spec.name) {
    case "start": {
      const items = (ctx.plans ?? [])
        .filter((plan) => typeof plan === "string" && plan.length > 0)
        .map((plan) => completion(prefix, plan, "recent plan"));
      return finish(items, partial);
    }
    case "inspect":
    case "retry": {
      const refs: Array<{ ref: string; description: string }> = [];
      if (typeof ctx.currentRef === "string" && ctx.currentRef.length > 0) {
        refs.push({ ref: ctx.currentRef, description: "current row" });
      }
      for (const ref of ctx.rows ?? []) {
        if (typeof ref === "string" && ref.length > 0 && ref !== ctx.currentRef) {
          refs.push({ ref, description: "run row" });
        }
      }
      const items = refs.map((entry) =>
        completion(prefix, entry.ref, entry.description),
      );
      return finish(items, partial);
    }
    case "view": {
      const items = ORCHESTRATOR_VIEWS.map((view) =>
        completion(
          prefix,
          view,
          `follow the ${view === "auto" ? "active session" : `${view} session`}`,
        ),
      );
      return finish(items, partial);
    }
    case "help": {
      const items = ORCHESTRATOR_VERBS.map((entry) =>
        completion(prefix, entry.name, entry.summary),
      );
      return finish(items, partial);
    }
    default:
      // `say` is free text and the remaining verbs take no argument.
      return null;
  }
}
