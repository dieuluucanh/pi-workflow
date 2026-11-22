/**
 * Workflow Extension — deterministic plan checks and row metadata.
 *
 * The frozen TODO contract has no model-authored acceptance criteria. Checks
 * come from the plan itself: the `## Verification` section for the final gate,
 * and optional `Acceptance:`/`Checks:`/`Files:` lines in a step body for the
 * per-row gate. Only command-shaped lines are extracted; prose is never run.
 */

const MAX_CHECKS = 12;
const MAX_FILES = 20;
const MAX_TEXT = 500;

const COMMAND_PREFIX =
  /^(?:\$|>)?\s*(?:cd|npm|npx|pnpm|yarn|bun|node|deno|python3?|pytest|uv|poetry|cargo|go|make|dotnet|mvn|gradle|bash|sh|zsh|powershell|pwsh|git|ls|cat|rg|grep|find|jq)\b/i;

const HEADING = /^(#{1,6})\s+(.+?)\s*$/;
const FENCE = /^\s*(```|~~~)/;
const BULLET = /^\s*[-*+]\s+(.+?)\s*$/;
const NUMBERED = /^\s*\d+[.)]\s+(.+?)\s*$/;

function bounded(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, MAX_TEXT);
}

function commandOf(line: string): string | undefined {
  const cleaned = line.replace(/^[\s>*+-]+/, "").replace(/^`+|`+$/g, "").trim();
  if (!cleaned || !COMMAND_PREFIX.test(cleaned)) return undefined;
  return bounded(cleaned);
}

function pushUnique(list: string[], value: string, max: number): void {
  const text = bounded(value);
  if (!text || list.includes(text) || list.length >= max) return;
  list.push(text);
}

/**
 * Extract the final plan-level commands from `## Verification`.
 *
 * A fenced block is read line by line; only command-shaped lines are kept.
 * A bullet/numbered list line is kept only when it starts with a known command.
 * No command is invented and no prose is executed.
 */
export function extractPlanChecks(markdown: string): string[] {
  if (typeof markdown !== "string" || markdown.trim().length === 0) return [];
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
  if (start < 0) return [];
  const checks: string[] = [];
  let fence: string | undefined;
  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const heading = HEADING.exec(line);
    if (heading && heading[1]!.length <= level) break;
    const fenceMatch = FENCE.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1]!;
      fence = fence === undefined ? marker : fence === marker ? undefined : fence;
      continue;
    }
    if (fence !== undefined) {
      const command = commandOf(line);
      if (command) pushUnique(checks, command, MAX_CHECKS);
      continue;
    }
    const bullet = BULLET.exec(line) ?? NUMBERED.exec(line);
    if (bullet) {
      const command = commandOf(bullet[1]!);
      if (command) pushUnique(checks, command, MAX_CHECKS);
    }
  }
  return checks;
}

export interface RowMetadata {
  acceptanceChecks: string[];
  expectedFiles: string[];
}

/**
 * Extract optional per-row metadata from a plan-step body. Only explicit
 * `Acceptance:`/`Checks:`/`Verify:` and `Files:`/`Expected files:` lines are
 * read. A header with no inline value consumes the following bullets until the
 * next header or blank paragraph.
 */
export function extractRowMetadata(body: string): RowMetadata {
  const acceptanceChecks: string[] = [];
  const expectedFiles: string[] = [];
  if (typeof body !== "string" || body.trim().length === 0) {
    return { acceptanceChecks, expectedFiles };
  }
  let mode: "checks" | "files" | undefined;
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      mode = undefined;
      continue;
    }
    const labelled = /^(acceptance|acceptance checks?|checks?|verify|verification|files?|expected files?|paths?)\s*:\s*(.*)$/i.exec(
      line,
    );
    if (labelled) {
      const key = labelled[1]!.toLowerCase();
      const value = labelled[2]!.trim();
      mode = /file|path/.test(key) ? "files" : "checks";
      if (value) {
        for (const part of value.split(/[;,]/)) {
          pushUnique(mode === "files" ? expectedFiles : acceptanceChecks, part, mode === "files" ? MAX_FILES : MAX_CHECKS);
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
    const value = bullet[1]!;
    pushUnique(mode === "files" ? expectedFiles : acceptanceChecks, value, mode === "files" ? MAX_FILES : MAX_CHECKS);
  }
  return { acceptanceChecks, expectedFiles };
}
