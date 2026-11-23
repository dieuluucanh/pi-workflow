/**
 * Workflow Extension — deterministic plan checks and row metadata.
 *
 * Executable commands are source data, not display prose. Their exact bytes
 * (including quoting, semicolons, commas and internal whitespace) survive from
 * the approved plan through the frozen snapshot and child bootstrap. Resource
 * limits fail closed with a diagnostic; they never silently truncate or drop a
 * required check.
 */

const MAX_CHECKS = 12;
const MAX_FILES = 20;
const MAX_WORKSPACES = 8;
const MAX_TEXT = 4_000;

const COMMAND_PREFIX =
  /^(?:\$|>)?\s*(?:cd|npm|npx|pnpm|yarn|bun|node|deno|python3?|pytest|uv|poetry|cargo|go|make|dotnet|mvn|gradle|bash|sh|zsh|powershell|pwsh|git|ls|cat|rg|grep|find|jq)\b/i;

const HEADING = /^(#{1,6})\s+(.+?)\s*$/;
const FENCE = /^\s*(```|~~~)/;
const BULLET = /^\s*[-*+]\s+(.+?)\s*$/;
const NUMBERED = /^\s*\d+[.)]\s+(.+?)\s*$/;

function exactCommand(line: string): string | undefined {
  const cleaned = line
    .replace(/^[\s>*+-]+/, "")
    .replace(/^`+|`+$/g, "")
    .trim();
  if (!cleaned || !COMMAND_PREFIX.test(cleaned)) return undefined;
  return cleaned;
}

function exactCommandOnLine(
  line: string,
): { command: string; workspace?: string } | undefined {
  const cleaned = line
    .replace(/^[\s>*+-]+/, "")
    .replace(/^`+|`+$/g, "")
    .trim();
  if (!cleaned) return undefined;
  const tagged = /^\[([A-Za-z][A-Za-z0-9_-]{0,23})\]\s+(.+)$/.exec(cleaned);
  const candidate = tagged ? tagged[2]!.trim() : cleaned;
  const command = exactCommand(candidate);
  if (!command) return undefined;
  return { command, ...(tagged ? { workspace: tagged[1] } : {}) };
}

function addExact(
  list: string[],
  value: string,
  max: number,
  label: string,
): string | undefined {
  const text = value.trim();
  if (!text) return undefined;
  if (text.length > MAX_TEXT) {
    return `${label} exceeds ${MAX_TEXT} characters`;
  }
  if (list.includes(text)) return undefined;
  if (list.length >= max) return `more than ${max} ${label} entries`;
  list.push(text);
  return undefined;
}

/**
 * Split an inline list only on separators outside single/double quotes. This
 * keeps `echo "a,b;c"` one command while still allowing `npm test; tsc`.
 */
function splitQuotedList(value: string): string[] {
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

export interface PlanCheckSpec {
  command: string;
  workspace?: string;
}

export type PlanChecksResult =
  | { ok: true; checks: string[] }
  | { ok: false; error: string };

export type PlanCheckSpecsResult =
  | { ok: true; specs: PlanCheckSpec[] }
  | { ok: false; error: string };

function addSpec(
  specs: PlanCheckSpec[],
  command: string,
  workspace: string | undefined,
): string | undefined {
  const text = command.trim();
  if (!text) return undefined;
  if (text.length > MAX_TEXT) return `plan checks exceeds ${MAX_TEXT} characters`;
  if (specs.some((spec) => spec.command === text && spec.workspace === workspace)) {
    return undefined;
  }
  if (specs.length >= MAX_CHECKS) return `more than ${MAX_CHECKS} plan checks entries`;
  specs.push({ command: text, ...(workspace === undefined ? {} : { workspace }) });
  return undefined;
}

/**
 * Plan-level Verification commands with an optional workspace alias. `[D] cmd`
 * and a preceding `Workspace: D` line are metadata; command bytes are kept.
 * The old command-only API remains below for callers/tests.
 */
export function extractPlanChecksWithWorkspaceDetailed(
  markdown: string,
): PlanCheckSpecsResult {
  if (typeof markdown !== "string" || markdown.trim().length === 0) {
    return { ok: true, specs: [] };
  }
  const lines = markdown.split(/\r?\n/);
  let start = -1;
  let level = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const heading = HEADING.exec(lines[index] ?? "");
    if (!heading) continue;
    if (heading[1]!.length >= 2 && /^\s*verification\s*$/i.test(heading[2]!)) {
      start = index + 1;
      level = heading[1]!.length;
      break;
    }
  }
  if (start < 0) return { ok: true, specs: [] };

  const specs: PlanCheckSpec[] = [];
  let error: string | undefined;
  let fence: string | undefined;
  let workspace: string | undefined;
  const push = (parsed: { command: string; workspace?: string } | undefined): void => {
    if (!parsed) return;
    const added = addSpec(specs, parsed.command, parsed.workspace ?? workspace);
    if (added) error ??= added;
  };
  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const heading = HEADING.exec(line);
    if (heading && heading[1]!.length <= level) break;
    const trimmed = line.trim();
    const label = /^workspace\s*:\s*([A-Za-z][A-Za-z0-9_-]{0,23})\s*$/i.exec(trimmed);
    if (label) {
      workspace = label[1];
      continue;
    }
    const fenceMatch = FENCE.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1]!;
      fence = fence === undefined ? marker : fence === marker ? undefined : fence;
      continue;
    }
    if (fence !== undefined) {
      push(exactCommandOnLine(line));
      continue;
    }
    const bullet = BULLET.exec(line) ?? NUMBERED.exec(line);
    if (bullet) push(exactCommandOnLine(bullet[1]!));
  }
  return error ? { ok: false, error } : { ok: true, specs };
}

export function extractPlanChecksDetailed(markdown: string): PlanChecksResult {
  const result = extractPlanChecksWithWorkspaceDetailed(markdown);
  return result.ok
    ? { ok: true, checks: result.specs.map((spec) => spec.command) }
    : result;
}

/** Compatibility wrapper for callers that only need display/legacy checks. */
export function extractPlanChecks(markdown: string): string[] {
  const result = extractPlanChecksDetailed(markdown);
  return result.ok ? result.checks : [];
}

export interface RowMetadata {
  acceptanceChecks: string[];
  expectedFiles: string[];
  workspaces: string[];
  /** Present when a required check/file/workspace exceeded a boundary. */
  error?: string;
}

/**
 * Extract optional per-row metadata from a plan-step body. Only explicit
 * `Acceptance:`/`Checks:`/`Verify:` and `Files:`/`Expected files:` lines are
 * read. Executable values are preserved exactly; prose is never executed.
 */
export function extractRowMetadata(body: string): RowMetadata {
  const acceptanceChecks: string[] = [];
  const expectedFiles: string[] = [];
  const workspaces: string[] = [];
  if (typeof body !== "string" || body.trim().length === 0) {
    return { acceptanceChecks, expectedFiles, workspaces };
  }
  let mode: "checks" | "files" | "workspaces" | undefined;
  let error: string | undefined;
  const target = (): string[] =>
    mode === "files" ? expectedFiles : mode === "workspaces" ? workspaces : acceptanceChecks;
  const max = (): number =>
    mode === "files" ? MAX_FILES : mode === "workspaces" ? MAX_WORKSPACES : MAX_CHECKS;
  const label = (): string =>
    mode === "files" ? "expected files" : mode === "workspaces" ? "workspaces" : "row checks";
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      mode = undefined;
      continue;
    }
    const labelled =
      /^(acceptance|acceptance checks?|checks?|verify|verification|files?|expected files?|paths?|workspaces?|repos?|repositories?)\s*:\s*(.*)$/i.exec(
        line,
      );
    if (labelled) {
      const key = labelled[1]!.toLowerCase();
      const value = labelled[2]!.trim();
      mode = /workspace|repo/.test(key)
        ? "workspaces"
        : /file|path/.test(key)
          ? "files"
          : "checks";
      if (value) {
        for (const part of splitQuotedList(value)) {
          const added = addExact(target(), part, max(), label());
          if (added) error ??= added;
        }
      }
      continue;
    }
    if (mode === undefined) continue;
    const bullet = BULLET.exec(line) ?? NUMBERED.exec(line);
    if (!bullet) {
      mode = undefined;
      continue;
    }
    const added = addExact(target(), bullet[1]!, max(), label());
    if (added) error ??= added;
  }
  return error
    ? { acceptanceChecks, expectedFiles, workspaces, error }
    : { acceptanceChecks, expectedFiles, workspaces };
}
