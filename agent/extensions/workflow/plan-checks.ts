/**
 * Workflow Extension — deterministic plan checks and row metadata.
 *
 * Executable commands are source data, not display prose. Their exact bytes
 * (including quoting, semicolons, commas and internal whitespace) survive from
 * the approved plan through the frozen snapshot and child bootstrap. Resource
 * limits fail closed with a diagnostic; they never silently truncate or drop a
 * required check.
 */

import {
  looksLikeCommand,
  splitQuotedList,
  validateCommandShape,
  type CommandShapeResult,
} from "./plan-command-shape.ts";
import {
  compilePlanChecks,
  formatPlanDiagnostic,
  parseRowMetadata,
} from "./plan-compiler.ts";

/**
 * The execution boundary now lives in `plan-command-shape.ts` so the compiler,
 * the spec/frozen parsers and this module share one rule with no cycle. It is
 * re-exported here because existing callers and tests import it from here.
 */
export { looksLikeCommand, splitQuotedList, validateCommandShape };
export type { CommandShapeResult };

const MAX_CHECKS = 12;

const HEADING = /^(#{1,6})\s+(.+?)\s*$/;
const FENCE = /^\s*(```|~~~)/;
const BULLET = /^\s*[-*+]\s+(.+?)\s*$/;
const NUMBERED = /^\s*\d+[.)]\s+(.+?)\s*$/;

const LINE_MARKERS = /^[\s>*+-]+/;
const WORKSPACE_TAG = /^\[([A-Za-z][A-Za-z0-9_-]{0,23})\]\s+([\s\S]+)$/;

export type PlanCheckSpecsValidation = { ok: true } | { ok: false; error: string };

function workspaceIds(
  workspaces: readonly (string | { id?: string })[] | undefined,
): Set<string> {
  const ids = new Set<string>();
  for (const workspace of workspaces ?? []) {
    const id =
      typeof workspace === "string"
        ? workspace
        : typeof workspace?.id === "string"
          ? workspace.id
          : "";
    if (id.trim()) ids.add(id.trim().toLowerCase());
  }
  return ids;
}

/**
 * Validate a plan-check list before freeze or execution: array shape, the
 * 12-entry boundary, one command per entry and a known workspace alias.
 */
export function validatePlanCheckSpecs(
  specs: unknown,
  workspaces?: readonly (string | { id?: string })[],
): PlanCheckSpecsValidation {
  if (!Array.isArray(specs)) {
    return { ok: false, error: "plan check specs must be an array" };
  }
  if (specs.length > MAX_CHECKS) {
    return { ok: false, error: `more than ${MAX_CHECKS} plan checks entries` };
  }
  const aliases = workspaceIds(workspaces);
  for (const [index, value] of specs.entries()) {
    const label = `plan check ${index + 1}`;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { ok: false, error: `${label} is invalid` };
    }
    const spec = value as Record<string, unknown>;
    if (typeof spec.command !== "string") {
      return { ok: false, error: `${label} has no command` };
    }
    const shape = validateCommandShape(spec.command);
    if (!shape.ok) {
      return { ok: false, error: `${label} is not an executable command: ${shape.error}` };
    }
    if (spec.workspace !== undefined) {
      if (typeof spec.workspace !== "string" || spec.workspace.trim().length === 0) {
        return { ok: false, error: `${label} has an invalid workspace` };
      }
      if (aliases.size > 0 && !aliases.has(spec.workspace.toLowerCase())) {
        return { ok: false, error: `${label} references unknown workspace "${spec.workspace}"` };
      }
    }
  }
  return { ok: true };
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

/**
 * Plan-level Verification commands with an optional workspace alias. `[D] cmd`
 * and a preceding `Workspace: D` line are metadata; command bytes are kept.
 *
 * Since the 2026-11-24 refactor this is a thin projection of the single plan
 * compiler (`plan-compiler.ts`), so authoring, freeze and execution cannot
 * disagree about what the Verification section says.
 */
export function extractPlanChecksWithWorkspaceDetailed(
  markdown: string,
): PlanCheckSpecsResult {
  const compiled = compilePlanChecks(markdown);
  if (!compiled.ok) {
    return { ok: false, error: compiled.error ?? "the Verification section is invalid" };
  }
  return {
    ok: true,
    specs: compiled.checks.map((check) => ({
      command: check.command,
      ...(check.workspace === undefined ? {} : { workspace: check.workspace }),
    })),
  };
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
 *
 * Thin projection of `plan-compiler.parseRowMetadata`: the legacy
 * `acceptanceChecks` view keeps document order so an existing freeze stays
 * byte-identical, while the typed lists are the authority for new work.
 */
export function extractRowMetadata(body: string): RowMetadata {
  const parsed = parseRowMetadata(body);
  const error = parsed.diagnostics.find((diagnostic) => diagnostic.severity === "error");
  return {
    acceptanceChecks: parsed.acceptanceChecks,
    expectedFiles: parsed.expectedFiles,
    workspaces: parsed.workspaces,
    ...(error === undefined ? {} : { error: formatPlanDiagnostic(error) }),
  };
}
