/**
 * Workflow Extension — the single plan compiler.
 *
 * Before this module there were three plan readers with different rules:
 * `todo-snapshot.parsePlanSteps` froze rows, `utils.extractPlanStepsFromMarkdown`
 * displayed them, and `plan-checks.extract*` froze/executed the checks. They
 * disagreed about sections, dedupe, truncation and what a command is — and the
 * 2026-11-21 incident slipped through the gap between the last two: a Markdown
 * sentence became `pnpm dev:preflight\`,`.
 *
 * `compilePlan` is now the only reader. It turns Markdown into a typed
 * `PlanSpec`:
 *   - rows from `## Plan Steps` (explicit headings/bold, numbered, checkbox),
 *   - per-row typed checks from `Checks:`/`Verify:` lines and fenced
 *     `checks:` blocks, with `Acceptance:` kept as non-executable criteria,
 *   - plan-level checks from `## Verification` (fenced command blocks, one
 *     whole-bullet code span, one raw command, and fenced `checks:` blocks),
 *   - provenance (path/digest/title), bound workspaces and line-numbered
 *     diagnostics.
 *
 * Invariants: deterministic order, no dedupe by display text, no truncation,
 * stable ids, exact command bytes and never a prose command. The display and
 * freeze adapters are thin projections of this output.
 */

import {
  looksLikeCommand,
  splitQuotedList,
  validateCommandShape,
  type CommandShapeResult,
} from "./plan-command-shape.ts";
import {
  parseChecksBlock,
  CHECKS_BLOCK_LANGUAGE,
  type ChecksBlockEntry,
} from "./plan-checks-block.ts";
import { todoItemId } from "./plan-identity.ts";
import {
  DEFAULT_CHECK_KIND,
  MAX_ACCEPTANCE_CRITERIA,
  MAX_CHECK_TIMEOUT_MS,
  MAX_CHECKS,
  MAX_EXPECTED_EXIT_CODE,
  MAX_FILES,
  MAX_PLAN_ROWS,
  MAX_TEXT,
  MAX_WORKSPACES,
  isCheckKind,
  planCheckId,
  planSpecHash,
  rowCheckId,
  sha256Hex,
  validatePlanSpec,
  type CheckKind,
  type CheckSpec,
  type PlanDiagnostic,
  type PlanRow,
  type PlanSpec,
} from "./plan-spec.ts";
import type { FrozenWorkspace } from "./orchestrator-workspace-set.ts";

/** Compiler contract version recorded on a compiled spec. */
export const PLAN_COMPILER_VERSION = "plan-compiler/1" as const;

const HEADING = /^(#{1,6})\s+(.+?)\s*$/;
const NUMBERED = /^(\d+(?:\.\d+)*)[.)]\s+(.+?)\s*$/;
const STEP_HEADING = /^(?:step\s+)?(\d+(?:\.\d+)*)[.):]?\s+(.+?)\s*$/i;
const BOLD = /^\*\*(.+?)\*\*\s*$/;
const BOLD_BULLET = /^[-*]\s+\*\*(.+?)\*\*\s*$/;
const CHECKBOX = /^[-*]\s+\[([ xX])\]\s+(.+?)\s*$/;
const EXCLUDED_SECTION =
  /^(context|decisions?|exploration|risks?|verification|non[- ]?goals?|out of scope|notes?|summary)$/i;

const LINE_MARKERS = /^[\s>*+-]+/;
const WORKSPACE_TAG = /^\[([A-Za-z][A-Za-z0-9_-]{0,23})\]\s+([\s\S]+)$/;
const WORKSPACE_LABEL = /^workspace\s*:\s*([A-Za-z][A-Za-z0-9_-]{0,23})\s*$/i;
const ALIAS = /^[A-Za-z][A-Za-z0-9_-]{0,23}$/;

const LABELLED_METADATA =
  /^(acceptance|acceptance checks?|acceptance criteria|checks?|verify|verification|files?|expected files?|paths?|workspaces?|repos?|repositories?)\s*:\s*(.*)$/i;

const MIXED_ERROR =
  "mixed command and prose; keep one whole command in backticks, use one whole code span, or use a fenced block";

/** One physical plan line, with fence state resolved. */
export interface PlanLine {
  /** 1-based line number in the source. */
  number: number;
  text: string;
  /** True inside a fence and on the fence markers themselves. */
  fenced: boolean;
  /** Language of the enclosing fence (`bash`, `checks`, …), lowercased. */
  fenceLanguage?: string;
  /** True for the opening/closing marker lines. */
  fenceMarker?: boolean;
}

export interface CompilePlanOptions {
  /** Plan file path. Without one the source is labelled `steps`. */
  path?: string;
  /** Bound workspace set; check aliases are validated against it. */
  workspaces?: readonly FrozenWorkspace[];
  /** Override the source kind (defaults to `plan` when a path is given). */
  kind?: "plan" | "steps";
}

/** Side data that must not become fields of the persisted `PlanRow`. */
export interface CompiledRowExtras {
  /** Document-order `acceptanceChecks` view (criteria and commands as written). */
  acceptanceChecks: string[];
  /** Checkbox state for the display projection; freeze ignores it. */
  completed?: boolean;
}

export interface CompiledPlanRows {
  title: string;
  rows: PlanRow[];
  extras: ReadonlyMap<string, CompiledRowExtras>;
  diagnostics: PlanDiagnostic[];
}

export type PlanCompileResult =
  | {
      ok: true;
      spec: PlanSpec;
      rowExtras: ReadonlyMap<string, CompiledRowExtras>;
      diagnostics: PlanDiagnostic[];
    }
  | { ok: false; error: string; diagnostics: PlanDiagnostic[] };

// ── Diagnostics ──────────────────────────────────────────────────────

export function formatPlanDiagnostic(diagnostic: PlanDiagnostic): string {
  return diagnostic.line === undefined
    ? diagnostic.message
    : `line ${diagnostic.line}: ${diagnostic.message}`;
}

function firstError(diagnostics: readonly PlanDiagnostic[]): string | undefined {
  const error = diagnostics.find((diagnostic) => diagnostic.severity === "error");
  return error === undefined ? undefined : formatPlanDiagnostic(error);
}

function hasErrors(diagnostics: readonly PlanDiagnostic[]): boolean {
  return diagnostics.some((diagnostic) => diagnostic.severity === "error");
}

// ── Line scanning and sections ───────────────────────────────────────

/** Split CRLF/LF and mark fence state. Fence markers stay in the stream. */
export function scanPlanLines(markdown: string): PlanLine[] {
  const raw = markdown.split(/\r?\n/);
  const lines: PlanLine[] = [];
  let marker: string | undefined;
  let language: string | undefined;
  for (let index = 0; index < raw.length; index += 1) {
    const text = raw[index] ?? "";
    const trimmed = text.trimStart();
    const found =
      trimmed.startsWith("```") ? "```" : trimmed.startsWith("~~~") ? "~~~" : undefined;
    if (found && marker === undefined) {
      marker = found;
      const info = trimmed.slice(found.length).trim().split(/\s+/)[0] ?? "";
      language = info.replace(/:$/, "").toLowerCase() || undefined;
      lines.push({ number: index + 1, text, fenced: true, fenceMarker: true });
      continue;
    }
    if (found && marker === found) {
      marker = undefined;
      language = undefined;
      lines.push({ number: index + 1, text, fenced: true, fenceMarker: true });
      continue;
    }
    lines.push({
      number: index + 1,
      text,
      fenced: marker !== undefined,
      ...(language === undefined ? {} : { fenceLanguage: language }),
    });
  }
  return lines;
}

function headingOf(line: PlanLine): { level: number; title: string } | undefined {
  if (line.fenced) return undefined;
  const match = HEADING.exec(line.text);
  if (!match) return undefined;
  return { level: match[1]!.length, title: match[2]!.trim() };
}

function labelOf(text: string): { label?: string; text: string } {
  const step = STEP_HEADING.exec(text.trim());
  if (step) return { label: step[1], text: step[2]!.trim() };
  return { text: text.trim() };
}

function cleanStepText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function uniqueId(base: string, used: Set<string>): string {
  const count = [...used].filter((value) => value === base || value.startsWith(`${base}-`)).length;
  const id = count === 0 ? base : `${base}-${count + 1}`;
  used.add(id);
  return id;
}

interface SectionBounds {
  start: number;
  end: number;
}

function findSection(
  lines: readonly PlanLine[],
  title: RegExp,
  levelRange: { min: number; max: number },
): SectionBounds | "ambiguous" | undefined {
  const matches = lines
    .map((line, index) => ({ index, heading: headingOf(line) }))
    .filter(
      (entry) =>
        entry.heading !== undefined &&
        entry.heading.level >= levelRange.min &&
        entry.heading.level <= levelRange.max &&
        title.test(entry.heading.title),
    );
  if (matches.length > 1) return "ambiguous";
  const found = matches[0];
  if (!found?.heading) return undefined;
  let end = lines.length;
  for (let index = found.index + 1; index < lines.length; index += 1) {
    const heading = headingOf(lines[index]!);
    if (heading && heading.level <= found.heading.level) {
      end = index;
      break;
    }
  }
  return { start: found.index + 1, end };
}

function excludedFallbackLine(
  line: PlanLine,
  stack: Array<{ level: number; title: string }>,
): boolean {
  const heading = headingOf(line);
  if (heading) {
    while (stack.length > 0 && stack.at(-1)!.level >= heading.level) stack.pop();
    if (EXCLUDED_SECTION.test(heading.title)) {
      stack.push({ level: heading.level, title: heading.title });
      return true;
    }
    return stack.length > 0;
  }
  return stack.length > 0;
}

type BodySegment =
  | { kind: "line"; line: PlanLine }
  | { kind: "fence"; language: string | undefined; openLine: PlanLine; content: PlanLine[] };

/** Group a run of lines into single lines and complete fenced blocks. */
function splitFences(lines: readonly PlanLine[]): BodySegment[] {
  const segments: BodySegment[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index]!;
    if (!line.fenceMarker) {
      segments.push({ kind: "line", line });
      index += 1;
      continue;
    }
    const openLine = line;
    const content: PlanLine[] = [];
    index += 1;
    while (index < lines.length && !lines[index]!.fenceMarker) {
      content.push(lines[index]!);
      index += 1;
    }
    // An unclosed fence still ends the block at EOF.
    if (index < lines.length) index += 1;
    segments.push({
      kind: "fence",
      language: openLine.fenceLanguage ?? content[0]?.fenceLanguage,
      openLine,
      content,
    });
  }
  return segments;
}

// ── Shared validation helpers ────────────────────────────────────────

export interface RowMetadata {
  checks: CheckSpec[];
  acceptanceCriteria: string[];
  expectedFiles: string[];
  workspaces: string[];
  /** Document-order legacy view; never used as an executable list. */
  acceptanceChecks: string[];
  diagnostics: PlanDiagnostic[];
}

interface DiagnosticContext {
  rowRef?: string;
}

function workspaceAliasesOf(workspaces: readonly FrozenWorkspace[] | undefined): Set<string> {
  return new Set(
    (workspaces ?? [])
      .map((workspace) => workspace.id.trim().toLowerCase())
      .filter((id) => id.length > 0),
  );
}

/** Undefined when there is no bound set (the alias is validated at freeze). */
function effectiveAliases(aliases: ReadonlySet<string> | undefined): ReadonlySet<string> | undefined {
  return aliases === undefined || aliases.size === 0 ? undefined : aliases;
}

function pushRow(entry: PlanDiagnostic[], context: DiagnosticContext, diagnostic: PlanDiagnostic): void {
  entry.push({
    ...diagnostic,
    ...(context.rowRef === undefined ? {} : { rowId: context.rowRef }),
  });
}

function integerField(
  value: string | undefined,
  min: number,
  max: number,
  label: string,
): string | undefined {
  if (value === undefined) return undefined;
  if (!/^[0-9]+$/.test(value)) return `${label} must be a plain integer (${min}..${max})`;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    return `${label} must be an integer (${min}..${max})`;
  }
  return undefined;
}

/** Convert reader entries into typed checks, naming the offending line. */
function checksFromEntries(
  entries: readonly ChecksBlockEntry[],
  options: {
    scope: "plan" | "row";
    rowRef?: string;
    aliases?: ReadonlySet<string>;
    diagnostics: PlanDiagnostic[];
  },
): CheckSpec[] {
  const checks: CheckSpec[] = [];
  const ids = new Set<string>();
  const code = options.scope === "plan" ? "verification.checks-block" : "row.checks-block";
  const commandCode = options.scope === "plan" ? "verification.command" : "row.check";
  const context: DiagnosticContext = {
    ...(options.rowRef === undefined ? {} : { rowRef: options.rowRef }),
  };
  for (const entry of entries) {
    const entryLine = entry.line;
    const idField = entry.id;
    const commandField = entry.command;
    const id =
      idField?.value ??
      (options.scope === "plan"
        ? planCheckId(checks.length)
        : rowCheckId(options.rowRef ?? "1", checks.length));
    if (idField !== undefined && id.trim().length === 0) {
      pushRow(options.diagnostics, context, {
        severity: "error",
        code,
        message: "a check id must not be empty",
        line: idField.line,
      });
      continue;
    }
    if (!commandField) {
      pushRow(options.diagnostics, context, {
        severity: "error",
        code,
        message: `check "${id}" has no command`,
        line: entryLine,
      });
      continue;
    }
    const shape = validateCommandShape(commandField.value);
    if (!shape.ok) {
      pushRow(options.diagnostics, context, {
        severity: "error",
        code: commandCode,
        message: shape.error,
        line: commandField.line,
      });
      continue;
    }
    const kindValue = entry.kind?.value ?? DEFAULT_CHECK_KIND;
    if (!isCheckKind(kindValue)) {
      pushRow(options.diagnostics, context, {
        severity: "error",
        code,
        message: `check "${id}" has an unknown kind "${kindValue}" (gate, diagnostic, manual)`,
        line: entry.kind?.line ?? entryLine,
      });
      continue;
    }
    const timeoutError = integerField(entry.timeoutMs?.value, 1, MAX_CHECK_TIMEOUT_MS, "timeoutMs");
    if (timeoutError) {
      pushRow(options.diagnostics, context, {
        severity: "error",
        code,
        message: `check "${id}" ${timeoutError}`,
        line: entry.timeoutMs?.line ?? entryLine,
      });
      continue;
    }
    const exitError = integerField(
      entry.expectedExitCode?.value,
      0,
      MAX_EXPECTED_EXIT_CODE,
      "expectedExitCode",
    );
    if (exitError) {
      pushRow(options.diagnostics, context, {
        severity: "error",
        code,
        message: `check "${id}" ${exitError}`,
        line: entry.expectedExitCode?.line ?? entryLine,
      });
      continue;
    }
    const workspace = entry.workspace?.value;
    const workspaceError = validateAlias(
      workspace,
      entry.workspace?.line ?? entryLine,
      options.aliases,
    );
    if (workspaceError) {
      pushRow(options.diagnostics, context, {
        severity: "error",
        code: options.scope === "plan" ? "verification.workspace" : "row.workspace",
        message: workspaceError.message,
        line: workspaceError.line,
      });
      continue;
    }
    if (ids.has(id)) {
      pushRow(options.diagnostics, context, {
        severity: "error",
        code,
        message: `duplicate check id "${id}"`,
        line: entryLine,
      });
      continue;
    }
    ids.add(id);
    const timeoutValue = entry.timeoutMs?.value;
    const exitValue = entry.expectedExitCode?.value;
    checks.push({
      id,
      command: commandField.value,
      kind: kindValue as CheckKind,
      ...(workspace === undefined ? {} : { workspace }),
      ...(timeoutValue === undefined ? {} : { timeoutMs: Number(timeoutValue) }),
      ...(exitValue === undefined ? {} : { expectedExitCode: Number(exitValue) }),
    });
  }
  return checks;
}

function validateAlias(
  workspace: string | undefined,
  line: number,
  aliases: ReadonlySet<string> | undefined,
): { message: string; line: number } | undefined {
  if (workspace === undefined) return undefined;
  if (!ALIAS.test(workspace)) {
    return { message: `invalid workspace alias "${workspace}"`, line };
  }
  const effective = effectiveAliases(aliases);
  if (effective && !effective.has(workspace.toLowerCase())) {
    return { message: `check references unknown workspace "${workspace}"`, line };
  }
  return undefined;
}

// ── Row metadata ─────────────────────────────────────────────────────

function pushBounded(
  list: string[],
  value: string,
  max: number,
  label: string,
  line: number,
  diagnostics: PlanDiagnostic[],
  context: DiagnosticContext,
): boolean {
  const text = value.trim();
  if (!text) return false;
  if (text.length > MAX_TEXT) {
    pushRow(diagnostics, context, {
      severity: "error",
      code: "row.metadata",
      message: `${label} exceeds ${MAX_TEXT} characters`,
      line,
    });
    return false;
  }
  if (list.includes(text)) return false;
  if (list.length >= max) {
    pushRow(diagnostics, context, {
      severity: "error",
      code: "row.metadata",
      message: `more than ${max} ${label} entries`,
      line,
    });
    return false;
  }
  list.push(text);
  return true;
}

/** One whole code span or one raw command; anything mixed is an error. */
function commandFromLegacyValue(
  raw: string,
  line: number,
  diagnostics: PlanDiagnostic[],
  code: string,
  context: DiagnosticContext,
): string | undefined {
  const trimmed = raw.trim();
  const wholeSpan = /^`([^`]+)`$/.exec(trimmed);
  if (wholeSpan) {
    const inner = wholeSpan[1]!.trim();
    const shape = validateCommandShape(inner);
    if (!shape.ok) {
      pushRow(diagnostics, context, { severity: "error", code, message: shape.error, line });
      return undefined;
    }
    return inner;
  }
  if (trimmed.includes("`")) {
    pushRow(diagnostics, context, { severity: "error", code, message: MIXED_ERROR, line });
    return undefined;
  }
  const shape: CommandShapeResult = validateCommandShape(trimmed);
  if (!shape.ok) {
    pushRow(diagnostics, context, { severity: "error", code, message: shape.error, line });
    return undefined;
  }
  return trimmed;
}

/**
 * Parse one row body. Labelled `Acceptance:` values are criteria (never
 * executed); `Checks:`/`Verify:` values and fenced `checks:` blocks are typed
 * checks; `Files:`/`Workspaces:` are row metadata. Errors are diagnostics
 * naming their 1-based source line.
 */
export function parseRowMetadataLines(
  lines: readonly PlanLine[],
  context: { rowRef?: string; aliases?: ReadonlySet<string> } = {},
): RowMetadata {
  const diagnostics: PlanDiagnostic[] = [];
  const checks: CheckSpec[] = [];
  const acceptanceCriteria: string[] = [];
  const expectedFiles: string[] = [];
  const workspaces: string[] = [];
  const acceptanceChecks: string[] = [];
  const rowContext: DiagnosticContext = {
    ...(context.rowRef === undefined ? {} : { rowRef: context.rowRef }),
  };
  let mode: "criteria" | "checks" | "files" | "workspaces" | undefined;

  const addCheck = (command: string, line: number, workspace?: string): void => {
    if (checks.length >= MAX_CHECKS) {
      pushRow(diagnostics, rowContext, {
        severity: "error",
        code: "row.check",
        message: `more than ${MAX_CHECKS} row checks`,
        line,
      });
      return;
    }
    const aliasError = validateAlias(workspace, line, context.aliases);
    if (aliasError) {
      pushRow(diagnostics, rowContext, {
        severity: "error",
        code: "row.workspace",
        message: aliasError.message,
        line: aliasError.line,
      });
      return;
    }
    const id =
      context.rowRef === undefined
        ? planCheckId(checks.length)
        : rowCheckId(context.rowRef, checks.length);
    checks.push({
      id,
      command,
      kind: "gate",
      ...(workspace === undefined ? {} : { workspace }),
    });
    acceptanceChecks.push(command);
  };

  const addValue = (
    kind: "criteria" | "checks" | "files" | "workspaces",
    value: string,
    line: number,
    workspace?: string,
  ): void => {
    if (kind === "checks") {
      const command = commandFromLegacyValue(value, line, diagnostics, "row.check", rowContext);
      if (command !== undefined) addCheck(command, line, workspace);
      return;
    }
    const list =
      kind === "files" ? expectedFiles : kind === "workspaces" ? workspaces : acceptanceCriteria;
    const max =
      kind === "files"
        ? MAX_FILES
        : kind === "workspaces"
          ? MAX_WORKSPACES
          : MAX_ACCEPTANCE_CRITERIA;
    const label =
      kind === "files"
        ? "expected files"
        : kind === "workspaces"
          ? "workspaces"
          : "acceptance criteria";
    const added = pushBounded(list, value, max, label, line, diagnostics, rowContext);
    if (added && kind === "criteria") acceptanceChecks.push(value.trim());
  };

  for (const segment of splitFences(lines)) {
    if (segment.kind === "fence") {
      if (segment.language !== CHECKS_BLOCK_LANGUAGE) continue;
      const parsed = parseChecksBlock(
        segment.content.map((line) => ({ line: line.number, text: line.text })),
      );
      if (!parsed.ok) {
        pushRow(diagnostics, rowContext, {
          severity: "error",
          code: "row.checks-block",
          message: parsed.error,
          line: parsed.line ?? segment.openLine.number,
        });
        continue;
      }
      const typed = checksFromEntries(parsed.entries, {
        scope: "row",
        ...(context.rowRef === undefined ? {} : { rowRef: context.rowRef }),
        ...(context.aliases === undefined ? {} : { aliases: context.aliases }),
        diagnostics,
      });
      for (const check of typed) {
        checks.push(check);
        if (!acceptanceChecks.includes(check.command)) acceptanceChecks.push(check.command);
      }
      continue;
    }
    const raw = segment.line.text;
    const trimmed = raw.trim();
    if (!trimmed) {
      mode = undefined;
      continue;
    }
    const labelled = LABELLED_METADATA.exec(trimmed);
    if (labelled) {
      const key = labelled[1]!.toLowerCase();
      const value = labelled[2]!.trim();
      mode = /workspace|repo/.test(key)
        ? "workspaces"
        : /file|path/.test(key)
          ? "files"
          : /acceptance/.test(key)
            ? "criteria"
            : "checks";
      if (value) {
        for (const part of splitQuotedList(value)) addValue(mode, part, segment.line.number);
      }
      continue;
    }
    if (mode === undefined) continue;
    const bullet = /^\s*[-*+]\s+(.+?)\s*$/.exec(raw) ?? /^\s*\d+[.)]\s+(.+?)\s*$/.exec(raw);
    if (!bullet) {
      mode = undefined;
      continue;
    }
    const tagged = WORKSPACE_TAG.exec(bullet[1]!.trim());
    const content = tagged ? tagged[2]!.trim() : bullet[1]!.trim();
    addValue(mode, content, segment.line.number, tagged?.[1]);
  }

  return {
    checks,
    acceptanceCriteria,
    expectedFiles,
    workspaces,
    acceptanceChecks,
    diagnostics,
  };
}

/** String convenience wrapper used by the legacy `extractRowMetadata` adapter. */
export function parseRowMetadata(
  body: string,
  context: { rowRef?: string; baseLine?: number; aliases?: ReadonlySet<string> } = {},
): RowMetadata {
  if (typeof body !== "string" || body.trim().length === 0) {
    return {
      checks: [],
      acceptanceCriteria: [],
      expectedFiles: [],
      workspaces: [],
      acceptanceChecks: [],
      diagnostics: [],
    };
  }
  const scanned = scanPlanLines(body);
  const offset = (context.baseLine ?? 1) - 1;
  return parseRowMetadataLines(
    scanned.map((line) => ({ ...line, number: line.number + offset })),
    {
      ...(context.rowRef === undefined ? {} : { rowRef: context.rowRef }),
      ...(context.aliases === undefined ? {} : { aliases: context.aliases }),
    },
  );
}

// ── Verification ─────────────────────────────────────────────────────

function parseLegacyBullet(
  content: string,
  line: number,
  workspace: string | undefined,
  diagnostics: PlanDiagnostic[],
): { command: string; workspace?: string } | undefined {
  const trimmed = content.trim();
  const wholeSpan = /^`([^`]+)`$/.exec(trimmed);
  if (wholeSpan) {
    const inner = wholeSpan[1]!.trim();
    if (!looksLikeCommand(inner)) return undefined;
    const shape = validateCommandShape(inner);
    if (!shape.ok) {
      diagnostics.push({ severity: "error", code: "verification.command", message: shape.error, line });
      return undefined;
    }
    return { command: inner, ...(workspace === undefined ? {} : { workspace }) };
  }
  const leadingSpan = /^`([^`]+)`([\s\S]*)$/.exec(trimmed);
  if (leadingSpan) {
    if (!looksLikeCommand(leadingSpan[1]!.trim())) return undefined;
    diagnostics.push({ severity: "error", code: "verification.mixed", message: MIXED_ERROR, line });
    return undefined;
  }
  if (trimmed.includes("`")) {
    if (looksLikeCommand(trimmed)) {
      diagnostics.push({ severity: "error", code: "verification.mixed", message: MIXED_ERROR, line });
    }
    return undefined;
  }
  if (!looksLikeCommand(trimmed)) return undefined;
  const shape = validateCommandShape(trimmed);
  if (!shape.ok) {
    diagnostics.push({ severity: "error", code: "verification.command", message: shape.error, line });
    return undefined;
  }
  return { command: trimmed, ...(workspace === undefined ? {} : { workspace }) };
}

function parseFencedCommandLine(
  raw: string,
  line: number,
  workspace: string | undefined,
  diagnostics: PlanDiagnostic[],
): { command: string; workspace?: string } | undefined {
  const cleaned = raw.replace(LINE_MARKERS, "").trim();
  if (!cleaned) return undefined;
  const tagged = WORKSPACE_TAG.exec(cleaned);
  const content = tagged ? tagged[2]!.trim() : cleaned;
  const alias = tagged?.[1] ?? workspace;
  if (!content) return undefined;
  if (!looksLikeCommand(content)) return undefined;
  const shape = validateCommandShape(content);
  if (!shape.ok) {
    diagnostics.push({ severity: "error", code: "verification.command", message: shape.error, line });
    return undefined;
  }
  return { command: content, ...(alias === undefined ? {} : { workspace: alias }) };
}

function parseVerification(
  lines: readonly PlanLine[],
  bounds: SectionBounds,
  aliases: ReadonlySet<string>,
): { checks: CheckSpec[]; diagnostics: PlanDiagnostic[] } {
  const diagnostics: PlanDiagnostic[] = [];
  const checks: CheckSpec[] = [];
  const section = lines.slice(bounds.start, bounds.end);
  let workspace: string | undefined;

  const add = (value: { command: string; workspace?: string }, line: number): void => {
    if (checks.length >= MAX_CHECKS) {
      diagnostics.push({
        severity: "error",
        code: "verification.limit",
        message: `more than ${MAX_CHECKS} plan checks entries`,
        line,
      });
      return;
    }
    const alias = value.workspace;
    const aliasError = validateAlias(alias, line, aliases);
    if (aliasError) {
      diagnostics.push({
        severity: "error",
        code: "verification.workspace",
        message: aliasError.message,
        line: aliasError.line,
      });
      return;
    }
    if (checks.some((check) => check.command === value.command && check.workspace === alias)) {
      return;
    }
    checks.push({
      id: planCheckId(checks.length),
      command: value.command,
      kind: "gate",
      ...(alias === undefined ? {} : { workspace: alias }),
    });
  };

  for (const segment of splitFences(section)) {
    if (segment.kind === "fence") {
      if (segment.language === CHECKS_BLOCK_LANGUAGE) {
        const parsed = parseChecksBlock(
          segment.content.map((line) => ({ line: line.number, text: line.text })),
        );
        if (!parsed.ok) {
          diagnostics.push({
            severity: "error",
            code: "verification.checks-block",
            message: parsed.error,
            line: parsed.line ?? segment.openLine.number,
          });
          continue;
        }
        const typed = checksFromEntries(parsed.entries, {
          scope: "plan",
          aliases,
          diagnostics,
        });
        for (const check of typed) {
          if (checks.length >= MAX_CHECKS) {
            diagnostics.push({
              severity: "error",
              code: "verification.limit",
              message: `more than ${MAX_CHECKS} plan checks entries`,
              line: segment.openLine.number,
            });
            break;
          }
          checks.push(
            check.workspace === undefined && workspace !== undefined
              ? { ...check, workspace }
              : check,
          );
        }
        continue;
      }
      for (const content of segment.content) {
        const parsed = parseFencedCommandLine(content.text, content.number, workspace, diagnostics);
        if (parsed) add(parsed, content.number);
      }
      continue;
    }
    const trimmed = segment.line.text.trim();
    if (!trimmed) continue;
    const label = WORKSPACE_LABEL.exec(trimmed);
    if (label) {
      workspace = label[1];
      continue;
    }
    const bullet =
      /^\s*[-*+]\s+(.+?)\s*$/.exec(segment.line.text) ??
      /^\s*\d+[.)]\s+(.+?)\s*$/.exec(segment.line.text);
    if (!bullet) continue;
    const tagged = WORKSPACE_TAG.exec(bullet[1]!.trim());
    const content = tagged ? tagged[2]!.trim() : bullet[1]!.trim();
    const alias = tagged?.[1] ?? workspace;
    const parsed = parseLegacyBullet(content, segment.line.number, alias, diagnostics);
    if (parsed) add(parsed, segment.line.number);
  }

  return { checks, diagnostics };
}

// ── Rows ─────────────────────────────────────────────────────────────

interface RawRow {
  text: string;
  label?: string;
  group?: string;
  sourceLine: number;
  completed?: boolean;
  body: PlanLine[];
}

interface RowSection {
  title: string;
  bounds: SectionBounds | undefined;
  relevant: PlanLine[];
}

function rowSection(lines: readonly PlanLine[]): RowSection | { error: string } {
  const title =
    lines
      .map((line) => headingOf(line))
      .find((heading) => heading?.level === 1)
      ?.title.replace(/^Plan:\s*/i, "")
      .trim() || "Plan";
  const bounds = findSection(lines, /plan\s+steps/i, { min: 2, max: 4 });
  if (bounds === "ambiguous") return { error: "the plan has more than one Plan Steps section" };
  if (bounds !== undefined) {
    return { title, bounds, relevant: lines.slice(bounds.start, bounds.end) };
  }
  const kept: PlanLine[] = [];
  const stack: Array<{ level: number; title: string }> = [];
  for (const line of lines) {
    if (!excludedFallbackLine(line, stack)) kept.push(line);
  }
  return { title, bounds: undefined, relevant: kept };
}

function parseRows(
  lines: readonly PlanLine[],
  aliases: ReadonlySet<string>,
): {
  title: string;
  rows: PlanRow[];
  extras: Map<string, CompiledRowExtras>;
  diagnostics: PlanDiagnostic[];
} {
  const diagnostics: PlanDiagnostic[] = [];
  const section = rowSection(lines);
  if ("error" in section) {
    diagnostics.push({ severity: "error", code: "plan.section", message: section.error });
    return { title: "Plan", rows: [], extras: new Map(), diagnostics };
  }
  const relevant = section.relevant;
  const nonFenced = relevant.filter((line) => !line.fenced);

  const hasExplicit = nonFenced.some((line) => {
    const heading = headingOf(line);
    if (heading && labelOf(heading.title).label) return true;
    return BOLD.test(line.text) || BOLD_BULLET.test(line.text);
  });
  const hasNumbered = nonFenced.some((line) => NUMBERED.test(line.text));
  const hasCheckbox = nonFenced.some((line) => CHECKBOX.test(line.text));
  const mode = hasExplicit
    ? "explicit"
    : hasNumbered
      ? "numbered"
      : hasCheckbox
        ? "checkbox"
        : undefined;
  if (mode === undefined) return { title: section.title, rows: [], extras: new Map(), diagnostics };

  const rawRows: RawRow[] = [];
  let current: RawRow | undefined;
  const groupStack: Array<{ level: number; title: string }> = [];
  const group = (): string | undefined =>
    groupStack.length === 0 ? undefined : groupStack.map((entry) => entry.title).join(" / ");
  const pushGroup = (heading: { level: number; title: string }): void => {
    while (groupStack.length > 0 && groupStack.at(-1)!.level >= heading.level) groupStack.pop();
    groupStack.push(heading);
  };
  const push = (row: Omit<RawRow, "body">): void => {
    const next: RawRow = { ...row, body: [] };
    rawRows.push(next);
    current = next;
  };
  const bodyLine = (line: PlanLine): void => {
    if (current) current.body.push(line);
  };

  for (const line of relevant) {
    if (line.fenced) {
      bodyLine(line);
      continue;
    }
    const heading = headingOf(line);
    if (heading) {
      if (heading.level === 1 && /^plan:/i.test(heading.title)) continue;
      const labelled = labelOf(heading.title);
      if (mode === "explicit" && labelled.label) {
        push({
          text: cleanStepText(labelled.text),
          label: labelled.label,
          ...(group() === undefined ? {} : { group: group() }),
          sourceLine: line.number,
        });
        continue;
      }
      if (!/plan\s+steps/i.test(heading.title)) {
        pushGroup({ level: heading.level, title: heading.title });
        current = undefined;
      }
      continue;
    }

    if (mode === "explicit") {
      const bold = BOLD.exec(line.text) ?? BOLD_BULLET.exec(line.text);
      if (bold) {
        const labelled = labelOf(bold[1]!);
        push({
          text: cleanStepText(labelled.text),
          ...(labelled.label === undefined ? {} : { label: labelled.label }),
          ...(group() === undefined ? {} : { group: group() }),
          sourceLine: line.number,
        });
        continue;
      }
      bodyLine(line);
      continue;
    }

    if (mode === "numbered") {
      const numbered = NUMBERED.exec(line.text);
      if (numbered) {
        push({
          text: cleanStepText(numbered[2]!),
          label: numbered[1]!,
          ...(group() === undefined ? {} : { group: group() }),
          sourceLine: line.number,
        });
        continue;
      }
      bodyLine(line);
      continue;
    }

    const checkbox = CHECKBOX.exec(line.text);
    if (checkbox) {
      push({
        text: cleanStepText(checkbox[2]!),
        ...(group() === undefined ? {} : { group: group() }),
        sourceLine: line.number,
        completed: checkbox[1]!.toLowerCase() === "x",
      });
      continue;
    }
    bodyLine(line);
  }

  const usedIds = new Set<string>();
  const rows: PlanRow[] = [];
  const extras = new Map<string, CompiledRowExtras>();
  for (const raw of rawRows) {
    if (rows.length >= MAX_PLAN_ROWS) {
      diagnostics.push({
        severity: "error",
        code: "plan.rows-limit",
        message: `more than ${MAX_PLAN_ROWS} plan rows`,
        line: raw.sourceLine,
      });
      break;
    }
    if (raw.text.length > MAX_TEXT) {
      diagnostics.push({
        severity: "error",
        code: "row.text",
        message: `row text exceeds ${MAX_TEXT} characters`,
        line: raw.sourceLine,
      });
      continue;
    }
    const label = raw.label ?? String(rows.length + 1);
    const id = uniqueId(todoItemId({ text: raw.text, group: raw.group, label }), usedIds);
    const ref = String(rows.length + 1);
    const metadata = parseRowMetadataLines(raw.body, { rowRef: ref, aliases });
    diagnostics.push(...metadata.diagnostics);
    rows.push({
      id,
      ref,
      text: raw.text,
      label,
      ...(raw.group === undefined ? {} : { group: raw.group }),
      checks: metadata.checks,
      acceptanceCriteria: metadata.acceptanceCriteria,
      expectedFiles: metadata.expectedFiles,
      workspaces: metadata.workspaces,
      sourceLine: raw.sourceLine,
    });
    extras.set(id, {
      acceptanceChecks: metadata.acceptanceChecks,
      ...(raw.completed === undefined ? {} : { completed: raw.completed }),
    });
  }
  return { title: section.title, rows, extras, diagnostics };
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * Compile a plan into a validated `PlanSpec`. Any error diagnostic (line
 * number included) makes the result `ok:false`; callers must not freeze or
 * execute a refused plan.
 */
export function compilePlan(
  markdown: string,
  options: CompilePlanOptions = {},
): PlanCompileResult {
  if (typeof markdown !== "string" || markdown.trim().length === 0) {
    return {
      ok: false,
      error: "the plan is empty",
      diagnostics: [{ severity: "error", code: "plan.empty", message: "the plan is empty" }],
    };
  }
  const lines = scanPlanLines(markdown);
  const aliases = workspaceAliasesOf(options.workspaces);
  const parsedRows = parseRows(lines, aliases);
  const diagnostics = [...parsedRows.diagnostics];
  if (parsedRows.rows.length === 0) {
    diagnostics.push({
      severity: "error",
      code: "plan.no-steps",
      message: "the plan has no top-level steps in the Plan Steps section",
    });
  }
  const bounds = findSection(lines, /^\s*verification\s*$/i, { min: 2, max: 6 });
  let planChecks: CheckSpec[] = [];
  if (bounds === "ambiguous") {
    diagnostics.push({
      severity: "error",
      code: "verification.section",
      message: "the plan has more than one Verification section",
    });
  } else if (bounds !== undefined) {
    const verification = parseVerification(lines, bounds, aliases);
    planChecks = verification.checks;
    diagnostics.push(...verification.diagnostics);
  }
  const digest = sha256Hex(markdown);
  const kind = options.kind ?? (options.path === undefined ? "steps" : "plan");
  const spec: PlanSpec = {
    version: 1,
    source: {
      kind,
      ...(options.path === undefined ? {} : { path: options.path }),
      digest,
      ...(kind === "plan" ? { bytesSha256: digest } : {}),
      title: parsedRows.title,
    },
    compiler: {
      version: PLAN_COMPILER_VERSION,
      specHash: planSpecHash({ rows: parsedRows.rows, planChecks }),
    },
    rows: parsedRows.rows,
    planChecks,
    workspaces: (options.workspaces ?? []).map((workspace) => ({ ...workspace })),
    diagnostics,
  };
  const error = firstError(diagnostics);
  if (error !== undefined) return { ok: false, error, diagnostics };
  const validated = validatePlanSpec(spec);
  if (!validated.ok) {
    diagnostics.push({ severity: "error", code: "plan.spec", message: validated.error });
    return { ok: false, error: validated.error, diagnostics };
  }
  return { ok: true, spec: validated.value, rowExtras: parsedRows.extras, diagnostics };
}

/**
 * Rows only, for display adapters. Never fails: metadata errors stay in
 * `diagnostics` so a Build-mode todo list cannot vanish because one row's
 * `Checks:` line is malformed.
 */
export function compilePlanRows(
  markdown: string,
  options: Pick<CompilePlanOptions, "workspaces"> = {},
): CompiledPlanRows {
  if (typeof markdown !== "string" || markdown.length === 0) {
    return { title: "Plan", rows: [], extras: new Map(), diagnostics: [] };
  }
  const parsed = parseRows(scanPlanLines(markdown), workspaceAliasesOf(options.workspaces));
  return {
    title: parsed.title,
    rows: parsed.rows,
    extras: parsed.extras,
    diagnostics: parsed.diagnostics,
  };
}

/**
 * Plan-level checks only, for callers that need the executable gate without a
 * full spec (freeze validation, `workflow_execution verify`, repair preview).
 */
export function compilePlanChecks(
  markdown: string,
  options: Pick<CompilePlanOptions, "workspaces"> = {},
): { ok: boolean; checks: CheckSpec[]; error?: string; diagnostics: PlanDiagnostic[] } {
  if (typeof markdown !== "string" || markdown.trim().length === 0) {
    return { ok: true, checks: [], diagnostics: [] };
  }
  const lines = scanPlanLines(markdown);
  const aliases = workspaceAliasesOf(options.workspaces);
  const bounds = findSection(lines, /^\s*verification\s*$/i, { min: 2, max: 6 });
  if (bounds === "ambiguous") {
    const diagnostics: PlanDiagnostic[] = [
      {
        severity: "error",
        code: "verification.section",
        message: "the plan has more than one Verification section",
      },
    ];
    return {
      ok: false,
      checks: [],
      error: "the plan has more than one Verification section",
      diagnostics,
    };
  }
  if (bounds === undefined) return { ok: true, checks: [], diagnostics: [] };
  const verification = parseVerification(lines, bounds, aliases);
  const error = firstError(verification.diagnostics);
  return {
    ok: error === undefined,
    checks: verification.checks,
    ...(error === undefined ? {} : { error }),
    diagnostics: verification.diagnostics,
  };
}

/** True when at least one diagnostic is an error. */
export function planHasErrors(diagnostics: readonly PlanDiagnostic[]): boolean {
  return hasErrors(diagnostics);
}
