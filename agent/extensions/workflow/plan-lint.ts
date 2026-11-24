/**
 * Workflow Extension — plan lint, preview and pre-approval gating.
 *
 * The compiler (`plan-compiler.ts`) is the authority for what a plan means; it
 * fails closed with line-numbered diagnostics. This module is the thin,
 * deterministic presentation and policy layer in front of it:
 *
 *   - `lintPlan` compiles and classifies the result so a caller never has to
 *     re-implement "did this plan compile, and what will run".
 *   - `formatPlanLintReport` prints rows, gate/diagnostic/manual counts, exact
 *     commands, workspaces, timeouts and every warning/error with a line.
 *   - `assessPlanGates` answers the pre-approval question: does this plan have
 *     at least one executable final gate? A plan that only proves itself with
 *     prose (or with `diagnostic`/`manual` checks) is unverifiable, so freezing
 *     it requires an explicit acknowledgement.
 *   - `planFreezeGate` is the single freeze/approval decision; `reviewPlanSubmissionProblems`
 *     applies the same compile gate to a reviewer rewrite before it replaces
 *     the plan on disk.
 *
 * Everything here is pure: no clock, no filesystem, no shell. It never
 * executes a command and never mutates a plan.
 */

import {
  compilePlan,
  compilePlanChecks,
  compilePlanRows,
  formatPlanDiagnostic,
} from "./plan-compiler.ts";
import type {
  CheckKind,
  CheckSpec,
  PlanDiagnostic,
  PlanSpec,
} from "./plan-spec.ts";
import type { FrozenWorkspace } from "./orchestrator-workspace-set.ts";

/** Where a lint result came from, for the header line. */
export interface PlanLintOptions {
  /** Plan path, when the caller read a file. */
  path?: string;
  /** Workspace roots to resolve `[W]` aliases and per-check workspaces. */
  workspaces?: readonly FrozenWorkspace[];
}

export interface PlanGateAssessment {
  rows: number;
  /** Plan-level checks by kind (the final gate). */
  gate: number;
  diagnostic: number;
  manual: number;
  /** Executable row checks (all kinds). */
  rowChecks: number;
  /** True when no final `gate` check exists; freezing needs an acknowledgement. */
  needsAcknowledgement: boolean;
  acknowledgementReason?: string;
}

export interface PlanLintResult {
  /** True when the plan compiled with no error diagnostics. */
  ok: boolean;
  /** First error, as `line N: message`, when `ok` is false. */
  error?: string;
  spec?: PlanSpec;
  diagnostics: PlanDiagnostic[];
  assessment: PlanGateAssessment;
}

export interface PlanFreezeGateResult {
  ok: boolean;
  error?: string;
  /** True when `ok` is false only because an acknowledgement is missing. */
  needsAcknowledgement: boolean;
}

function countKinds(checks: readonly CheckSpec[]): Record<CheckKind, number> {
  const counts: Record<CheckKind, number> = {
    gate: 0,
    diagnostic: 0,
    manual: 0,
  };
  for (const check of checks) counts[check.kind] += 1;
  return counts;
}

/** Classify the checks a plan would execute. Pure and total. */
export function assessPlanGates(
  planChecks: readonly CheckSpec[],
  rows: readonly { checks?: readonly CheckSpec[] }[] = [],
): PlanGateAssessment {
  const final = countKinds(planChecks);
  const rowChecks = rows.reduce(
    (total, row) => total + (row.checks?.length ?? 0),
    0,
  );
  const needsAcknowledgement = final.gate === 0;
  const reason = needsAcknowledgement
    ? planChecks.length === 0
      ? "the plan has no final gate checks"
      : "every final check is diagnostic/manual, so nothing proves the plan"
    : undefined;
  return {
    rows: rows.length,
    gate: final.gate,
    diagnostic: final.diagnostic,
    manual: final.manual,
    rowChecks,
    needsAcknowledgement,
    ...(reason === undefined ? {} : { acknowledgementReason: reason }),
  };
}

function emptyAssessment(): PlanGateAssessment {
  return {
    rows: 0,
    gate: 0,
    diagnostic: 0,
    manual: 0,
    rowChecks: 0,
    needsAcknowledgement: true,
    acknowledgementReason: "the plan did not compile, so it has no gate checks",
  };
}

/**
 * Compile a plan and return everything a lint/preview surface needs.
 *
 * On a compile error the partial row/check projection is still returned so the
 * report can show what *would* run next to the diagnostics. Callers must gate
 * on `ok === false` and never freeze or execute the partial result.
 */
export function lintPlan(
  markdown: string,
  options: PlanLintOptions = {},
): PlanLintResult {
  const compiled = compilePlan(markdown, {
    ...(options.path === undefined ? {} : { path: options.path }),
    ...(options.workspaces === undefined
      ? {}
      : { workspaces: options.workspaces }),
  });
  if (compiled.ok) {
    return {
      ok: true,
      spec: compiled.spec,
      diagnostics: compiled.diagnostics,
      assessment: assessPlanGates(compiled.spec.planChecks, compiled.spec.rows),
    };
  }
  const rows = compilePlanRows(markdown, {
    ...(options.workspaces === undefined
      ? {}
      : { workspaces: options.workspaces }),
  });
  const checks = compilePlanChecks(markdown, {
    ...(options.workspaces === undefined
      ? {}
      : { workspaces: options.workspaces }),
  });
  return {
    ok: false,
    error: compiled.error,
    diagnostics: compiled.diagnostics,
    assessment: assessPlanGates(checks.checks, rows.rows),
  };
}

function checkSuffix(check: CheckSpec): string {
  const parts: string[] = [];
  if (check.workspace !== undefined) parts.push(`workspace ${check.workspace}`);
  if (check.timeoutMs !== undefined)
    parts.push(`timeout ${Math.round(check.timeoutMs / 1000)}s`);
  if (check.expectedExitCode !== undefined)
    parts.push(`exit ${check.expectedExitCode}`);
  return parts.length === 0 ? "" : ` (${parts.join(", ")})`;
}

function settingsLine(workspaces: readonly FrozenWorkspace[]): string {
  if (workspaces.length === 0) return "Workspaces: primary only";
  return `Workspaces: ${workspaces
    .map(
      (workspace) =>
        `${workspace.id}=${workspace.displayPath}${workspace.primary ? " (primary)" : ""}`,
    )
    .join(", ")}`;
}

function diagnosticsBlock(
  label: string,
  diagnostics: readonly PlanDiagnostic[],
): string[] {
  const lines = diagnostics.map(
    (diagnostic) => `  - ${formatPlanDiagnostic(diagnostic)}`,
  );
  return lines.length === 0 ? [] : [label, ...lines];
}

/**
 * Human-readable lint output. Deterministic ordering, no ANSI, safe to print
 * in a command result or the transcript.
 */
export function formatPlanLintReport(result: PlanLintResult): string {
  const spec = result.spec;
  const path =
    spec?.source.path ??
    (spec === undefined ? undefined : spec.source.title);
  const header = result.ok ? "Plan lint: OK" : "Plan lint: FAILED";
  const lines: string[] = [
    path === undefined ? header : `${header} — ${path}`,
    `Rows: ${result.assessment.rows}`,
    `Final checks: ${result.assessment.gate} gate · ${result.assessment.diagnostic} diagnostic · ${result.assessment.manual} manual`,
    `Row checks: ${result.assessment.rowChecks}`,
  ];
  if (spec !== undefined) {
    lines.push(settingsLine(spec.workspaces));
    if (spec.planChecks.length === 0) {
      lines.push("Final gate: (none)");
    } else {
      lines.push("Final gate:");
      spec.planChecks.forEach((check, index) => {
        lines.push(
          `  ${index + 1}. [${check.kind}] ${check.command}${checkSuffix(check)}`,
        );
      });
    }
    const rowChecks = spec.rows.filter((row) => row.checks.length > 0);
    if (rowChecks.length > 0) {
      lines.push("Row checks:");
      for (const row of rowChecks) {
        lines.push(`  Row ${row.ref}: ${row.text}`);
        row.checks.forEach((check, index) => {
          lines.push(
            `    ${index + 1}. [${check.kind}] ${check.command}${checkSuffix(check)}`,
          );
        });
      }
    }
  }
  lines.push(
    ...diagnosticsBlock(
      "Warnings:",
      result.diagnostics.filter((d) => d.severity === "warning"),
    ),
    ...diagnosticsBlock(
      "Errors:",
      result.diagnostics.filter((d) => d.severity === "error"),
    ),
  );
  if (result.assessment.needsAcknowledgement) {
    lines.push(
      `Acknowledgement required: ${result.assessment.acknowledgementReason}.`,
    );
  }
  return lines.join("\n");
}

/**
 * Compact preview for the handoff/freeze modal: exactly what will run, with
 * the acknowledgement note when the plan has no executable final gate.
 */
export function formatPlanPreview(
  result: PlanLintResult,
  opts: { maxCommands?: number } = {},
): string {
  const spec = result.spec;
  const max = opts.maxCommands ?? 20;
  const lines: string[] = [];
  if (!result.ok) {
    lines.push(`Plan does not compile: ${result.error ?? "unknown error"}`);
    const errors = result.diagnostics
      .filter((d) => d.severity === "error")
      .slice(0, 5);
    for (const error of errors) lines.push(`  - ${formatPlanDiagnostic(error)}`);
    return lines.join("\n");
  }
  const assessment = result.assessment;
  lines.push(
    `Check preview: ${assessment.rows} rows · ${assessment.gate} final gate · ${assessment.rowChecks} row checks`,
  );
  if (spec !== undefined && spec.planChecks.length > 0) {
    lines.push("Final gate:");
    for (const check of spec.planChecks.slice(0, max)) {
      lines.push(`  - ${check.command}${checkSuffix(check)}`);
    }
    if (spec.planChecks.length > max) {
      lines.push(`  … ${spec.planChecks.length - max} more (run /plan lint)`);
    }
  }
  if (assessment.needsAcknowledgement) {
    lines.push(
      `WARNING: ${assessment.acknowledgementReason} — approve explicitly to freeze an unverifiable plan.`,
    );
  }
  return lines.join("\n");
}

/**
 * The single freeze/approval decision.
 *
 * - a plan that does not compile is refused, because the frozen snapshot would
 *   be built from a partial or ambiguous spec;
 * - a compilable plan with no final `gate` check needs an explicit
 *   acknowledgement, so an unverifiable plan cannot be frozen silently;
 * - a plan whose final gate is fenced commands (the normal case) freezes
 *   without any extra prompt.
 */
export function planFreezeGate(
  result: PlanLintResult,
  options: { acknowledged?: boolean } = {},
): PlanFreezeGateResult {
  if (!result.ok) {
    return {
      ok: false,
      needsAcknowledgement: false,
      error: `the plan does not compile: ${result.error ?? "unknown error"}`,
    };
  }
  if (result.assessment.needsAcknowledgement && options.acknowledged !== true) {
    return {
      ok: false,
      needsAcknowledgement: true,
      error: `${result.assessment.acknowledgementReason} — acknowledge explicitly to freeze an unverifiable plan`,
    };
  }
  return { ok: true, needsAcknowledgement: false };
}

/**
 * Reviewer rewrite gate. Returns human-readable problems; empty means the
 * rewrite may replace the plan. A rewrite that introduces an ambiguous check
 * (a mixed prose/command bullet, unsupported YAML, a duplicate gate) fails
 * here, before anything is written.
 */
export function reviewPlanSubmissionProblems(
  originalMarkdown: string,
  nextMarkdown: string,
  options: PlanLintOptions = {},
): string[] {
  const next = lintPlan(nextMarkdown, options);
  if (!next.ok) {
    const errors = next.diagnostics
      .filter((diagnostic) => diagnostic.severity === "error")
      .slice(0, 8)
      .map((diagnostic) => `plan does not compile: ${formatPlanDiagnostic(diagnostic)}`);
    return errors.length > 0
      ? errors
      : [`plan does not compile: ${next.error ?? "unknown error"}`];
  }
  const original = lintPlan(originalMarkdown, options);
  if (
    original.ok &&
    original.assessment.gate > 0 &&
    next.assessment.gate === 0
  ) {
    return [
      `the rewrite removed every final gate check (the original had ${original.assessment.gate}) — restore a fenced command block or a \`checks:\` block`,
    ];
  }
  return [];
}
