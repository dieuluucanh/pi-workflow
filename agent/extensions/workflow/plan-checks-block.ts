/**
 * Workflow Extension — restricted-subset reader for a fenced `checks:` block.
 *
 * The package declares no runtime dependencies (`yaml` is only transitive), so
 * the typed check surface must not import a YAML library: doing so would break
 * the published extension. This module reads a deliberately small subset and
 * fails closed — with a line number — on anything it does not understand. A
 * silent misread here would put a sentence back in front of a shell, which is
 * the exact failure the 2026-11-21 incident produced.
 *
 * Accepted subset (and nothing else):
 *
 *   checks:                  # optional, fenced info string is already `checks`
 *     - id: typecheck        # required, first key on the dash line
 *       command: pnpm typecheck   # required
 *       kind: gate           # optional: gate | diagnostic | manual
 *       workspace: W         # optional alias
 *       timeoutMs: 900000    # optional positive integer
 *       expectedExitCode: 0  # optional integer 0..255
 *
 * Values are single-line scalars: plain (`pnpm test -- --runInBand`),
 * single-quoted (`'echo ''a b'''`) or double-quoted (`"say \"hi\""`, only
 * `\\` and `\"` escapes). Blank lines and `#` comment lines are ignored; a
 * ` #` outside quotes starts an inline comment.
 *
 * Explicitly unsupported (each is an error): anchors/aliases/tags (`&`, `*`,
 * `!`), flow collections (`[]`, `{}`), block scalars (`|`, `>`), multi-line
 * values, tabs, duplicate keys, unknown keys, nested mappings and directives.
 * Quote or separate the value instead of relying on YAML features.
 */

export const CHECKS_BLOCK_LANGUAGE = "checks" as const;

/** One field of one entry, with the 1-based plan line it was read from. */
export interface ChecksBlockField {
  value: string;
  line: number;
}

export interface ChecksBlockEntry {
  /** Line of the `- id:` entry start (or the dash when id is on the next line). */
  line: number;
  id?: ChecksBlockField;
  command?: ChecksBlockField;
  kind?: ChecksBlockField;
  workspace?: ChecksBlockField;
  timeoutMs?: ChecksBlockField;
  expectedExitCode?: ChecksBlockField;
}

export type ChecksBlockResult =
  | { ok: true; entries: ChecksBlockEntry[] }
  | { ok: false; error: string; line?: number };

export interface ChecksBlockLine {
  /** 1-based plan line. */
  line: number;
  text: string;
}

const KNOWN_KEYS = new Set([
  "id",
  "command",
  "kind",
  "workspace",
  "timeoutMs",
  "expectedExitCode",
]);

const ENTRY_WITH_KEY = /^(\s*)-\s+([A-Za-z][A-Za-z0-9_]*)\s*:(.*)$/;
const ENTRY_ALONE = /^(\s*)-\s*$/;
const FIELD = /^(\s*)([A-Za-z][A-Za-z0-9_]*)\s*:(.*)$/;
const TOP_LEVEL_CHECKS = /^checks\s*:\s*$/;

function fail(line: number | undefined, error: string): ChecksBlockResult {
  return line === undefined ? { ok: false, error } : { ok: false, error, line };
}

interface ScalarResult {
  ok: boolean;
  value?: string;
  error?: string;
}

function scalarError(error: string): ScalarResult {
  return { ok: false, error };
}

/** Ends at the first unquoted ` #`; plain scalars never start with a quote. */
function stripInlineComment(text: string): string {
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "#" && (index === 0 || /\s/.test(text[index - 1]!))) {
      return text.slice(0, index);
    }
  }
  return text;
}

function doubleQuoted(raw: string): ScalarResult {
  let value = "";
  for (let index = 1; index < raw.length; index += 1) {
    const char = raw[index]!;
    if (char === "\\") {
      const next = raw[index + 1];
      if (next !== "\\" && next !== '"') {
        return scalarError(
          `unsupported escape \\${next ?? ""}; only \\\\ and \\" are allowed in a double-quoted value`,
        );
      }
      value += next;
      index += 1;
      continue;
    }
    if (char === '"') {
      const rest = raw.slice(index + 1).trim();
      if (rest && !rest.startsWith("#")) {
        return scalarError("unexpected text after the closing double quote");
      }
      return { ok: true, value };
    }
    value += char;
  }
  return scalarError("unterminated double-quoted value");
}

function singleQuoted(raw: string): ScalarResult {
  let value = "";
  for (let index = 1; index < raw.length; index += 1) {
    const char = raw[index]!;
    if (char === "'") {
      if (raw[index + 1] === "'") {
        value += "'";
        index += 1;
        continue;
      }
      const rest = raw.slice(index + 1).trim();
      if (rest && !rest.startsWith("#")) {
        return scalarError("unexpected text after the closing single quote");
      }
      return { ok: true, value };
    }
    value += char;
  }
  return scalarError("unterminated single-quoted value");
}

/** Parse one restricted-subset scalar. Never guesses at YAML features. */
export function parseChecksBlockScalar(raw: string): ScalarResult {
  const text = raw.replace(/^\s+/, "");
  if (text.trim().length === 0) return scalarError("the value is empty");
  if (text.includes("\t")) return scalarError("tabs are not supported");
  if (text.startsWith("'")) return singleQuoted(text);
  if (text.startsWith('"')) return doubleQuoted(text);
  for (const [marker, feature] of [
    ["&", "anchors"],
    ["*", "aliases"],
    ["!", "tags"],
    ["{", "flow mappings"],
    ["[", "flow sequences"],
    ["|", "block scalars"],
    [">", "folded block scalars"],
    ["%", "directives"],
    ["@", "reserved indicators"],
    ["`", "reserved indicators"],
  ] as const) {
    if (text.startsWith(marker)) {
      return scalarError(`unsupported YAML ${feature} (${marker}); use one plain scalar`);
    }
  }
  const value = stripInlineComment(text).trim();
  if (!value) return scalarError("the value is empty");
  if (/:(\s|$)/.test(value)) {
    return scalarError("a plain value must not contain ': '; quote the value");
  }
  return { ok: true, value };
}

function setField(
  entry: ChecksBlockEntry,
  key: string,
  raw: string,
  line: number,
): string | undefined {
  if (!KNOWN_KEYS.has(key)) {
    return `unknown key "${key}"; allowed keys are ${[...KNOWN_KEYS].join(", ")}`;
  }
  if (entry[key as keyof ChecksBlockEntry] !== undefined) {
    return `duplicate key "${key}"`;
  }
  const parsed = parseChecksBlockScalar(raw);
  if (!parsed.ok) return `${key}: ${parsed.error}`;
  (entry as unknown as Record<string, ChecksBlockField>)[key] = {
    value: parsed.value!,
    line,
  };
  return undefined;
}

/**
 * Read a fenced `checks:` block. `lines` are the fence content lines with
 * 1-based plan line numbers; the fence itself is the caller's business.
 */
export function parseChecksBlock(lines: readonly ChecksBlockLine[]): ChecksBlockResult {
  const entries: ChecksBlockEntry[] = [];
  let current: ChecksBlockEntry | undefined;
  let entryIndent: number | undefined;
  let sawTopLevel = false;

  for (const { line, text } of lines) {
    if (text.trim().length === 0) continue;
    if (text.includes("\t")) {
      return fail(
        line,
        "tabs are not supported in a checks block; indent with two spaces",
      );
    }
    if (text.trimStart().startsWith("#")) continue;

    const entryMatch = ENTRY_WITH_KEY.exec(text);
    const aloneMatch = ENTRY_ALONE.exec(text);
    if (entryMatch || aloneMatch) {
      const indent = (entryMatch?.[1] ?? aloneMatch?.[1] ?? "").length;
      if (entryIndent === undefined) entryIndent = indent;
      if (indent !== entryIndent) {
        return fail(line, "entries must share one indentation level");
      }
      current = { line };
      entries.push(current);
      if (entryMatch) {
        const error = setField(current, entryMatch[2]!, entryMatch[3]!, line);
        if (error) return fail(line, error);
      }
      continue;
    }

    const topLevel = TOP_LEVEL_CHECKS.exec(text);
    if (topLevel) {
      if (sawTopLevel || entries.length > 0) {
        return fail(line, "a checks block may contain only one top-level \"checks:\" line");
      }
      sawTopLevel = true;
      continue;
    }

    if (text.trimStart().startsWith("%")) {
      return fail(line, "YAML directives are not supported in a checks block");
    }

    const fieldMatch = FIELD.exec(text);
    if (fieldMatch) {
      if (!current) {
        return fail(
          line,
          "a key must belong to an entry; start with \"- id:\" (nested mappings are not supported)",
        );
      }
      const indent = fieldMatch[1]!.length;
      if (entryIndent !== undefined && indent <= entryIndent) {
        return fail(line, "a field must be indented deeper than its \"- id:\" entry");
      }
      const error = setField(current, fieldMatch[2]!, fieldMatch[3]!, line);
      if (error) return fail(line, error);
      continue;
    }

    return fail(
      line,
      "unsupported checks-block syntax; expected \"checks:\", \"- id:\" entries or \"key: value\" fields (no multi-line values, flow collections or nested mappings)",
    );
  }

  if (sawTopLevel && entries.length === 0) {
    // An explicit empty block is valid: a plan may declare no checks.
    return { ok: true, entries: [] };
  }
  return { ok: true, entries };
}
