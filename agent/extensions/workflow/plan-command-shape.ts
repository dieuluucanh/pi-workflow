/**
 * Workflow Extension — the execution boundary for one shell command.
 *
 * A command is data, not display prose. The 2026-11-21 incident happened
 * because a Markdown sentence reached a shell: `pnpm` was asked to run
 * `dev:preflight\`,` because the frozen list kept the prose after a stray
 * closing backtick.
 *
 * This module is deliberately dependency-free and has no importers that could
 * cycle: `plan-checks.ts` re-exports it, `plan-spec.ts`, `frozen-snapshot.ts`
 * and `plan-compiler.ts` import it directly. Every boundary (compile, freeze,
 * execute) calls the same function, so a sentence cannot be executable in one
 * path and evidence in another.
 */

/** Shared with `plan-spec.ts`/`frozen-snapshot.ts`; a command may not exceed it. */
export const MAX_COMMAND_TEXT = 4_000;

const MAX_TEXT = MAX_COMMAND_TEXT;

const COMMAND_PREFIX =
  /^(?:\$|>)?\s*(?:cd|npm|npx|pnpm|yarn|bun|node|deno|python3?|pytest|uv|poetry|cargo|go|make|dotnet|mvn|gradle|bash|sh|zsh|powershell|pwsh|git|ls|cat|rg|grep|find|jq)\b/i;

const BACKTICK = /`/;
const CRLF_NUL = /[\r\n\0]/;

/** `.cmd`/`./script`/`C:\tool` are commands even without a known prefix. */
const PATH_LIKE_COMMAND = /^(?:\.{1,2}[\\/]|[\\/]|[A-Za-z]:[\\/])/;

/** A leading token that could be an attempted shell command, not prose. */
export function looksLikeCommand(text: string): boolean {
  const cleaned = typeof text === "string" ? text.trim() : "";
  if (!cleaned) return false;
  if (COMMAND_PREFIX.test(cleaned)) return true;
  return PATH_LIKE_COMMAND.test(cleaned);
}

export type CommandShapeResult = { ok: true } | { ok: false; error: string };

/**
 * The execution boundary. A string may only reach a shell when it is one
 * non-empty, single-line command without Markdown or surrounding whitespace.
 * Prose (an `Acceptance:` criterion, for example) is evidence, not a command.
 */
export function validateCommandShape(command: unknown): CommandShapeResult {
  if (typeof command !== "string") {
    return { ok: false, error: "a command must be a string" };
  }
  if (command.trim().length === 0) {
    return { ok: false, error: "a command must not be empty" };
  }
  if (command.length > MAX_TEXT) {
    return { ok: false, error: `a command must be ${MAX_TEXT} characters or fewer` };
  }
  if (CRLF_NUL.test(command)) {
    return {
      ok: false,
      error: "a command must be a single line without CR, LF or NUL",
    };
  }
  if (BACKTICK.test(command)) {
    return { ok: false, error: "a command must not contain Markdown backticks" };
  }
  if (command !== command.trim()) {
    return {
      ok: false,
      error: "a command must not have leading or trailing whitespace",
    };
  }
  if (!looksLikeCommand(command)) {
    return { ok: false, error: "prose is not a shell command" };
  }
  return { ok: true };
}

/**
 * Split an inline list only on separators outside single/double quotes. This
 * keeps `echo "a,b;c"` one command while still allowing `npm test; tsc`.
 */
export function splitQuotedList(value: string): string[] {
  const out: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let escaped = false;
  for (const char of value) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      current += char;
      escaped = true;
      continue;
    }
    if (quote) {
      current += char;
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      current += char;
      continue;
    }
    if (char === ";" || char === ",") {
      if (current.trim()) out.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  if (current.trim()) out.push(current.trim());
  return out;
}
