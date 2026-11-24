/**
 * Workflow Extension — read-only migration scanner for existing runs and plans.
 *
 * Row 19 of the plan-execution contract refactor needs an honest inventory of
 * what is already on disk *before* anything is touched: which frozen snapshots
 * are still v1, which checks are malformed/quarantined, which checks reference
 * a workspace alias the snapshot never bound, and which v1 `acceptanceChecks`
 * entries are really prose. The scanner answers those questions and produces a
 * repair list; it never writes a journal, rewrites a snapshot or re-freezes a
 * run. Applying a fix stays with the amendment tool
 * (`scripts/repair-orchestrator-checks.mjs`, `/orchestrator-repair-checks`).
 *
 * Everything in this module is pure: journal text in, report out. The
 * filesystem walk lives in `scripts/migration-report.mjs` so tests can feed
 * fixtures without touching the real runs root.
 */

import {
  readFrozenSnapshot,
  type QuarantinedCheck,
} from "./frozen-snapshot.ts";
import { validateCommandShape } from "./plan-checks.ts";
import { lintPlan } from "./plan-lint.ts";
import {
  applyCheckSpecRepair,
  CHECK_SPEC_REPAIR_ACTION,
} from "./orchestrator-check-repair.ts";
import { replayJournal } from "./orchestrator-store.ts";
import { RUN_PHASES, type RunPhase } from "./orchestrator-types.ts";
import type { FrozenWorkspace } from "./orchestrator-workspace-set.ts";
import { parseWorkspaceDeclarations } from "./orchestrator-workspace-set.ts";
import type { PlanDiagnostic } from "./plan-spec.ts";
import type {
  FrozenTodoRow,
  FrozenTodoSnapshot,
} from "./todo-snapshot.ts";

export interface ScannedCheckIssue {
  scope: "plan" | "row";
  rowRef?: string;
  /** Position in the source list it came from (0-based). */
  index: number;
  /** Exact stored bytes; never executed. */
  command: string;
  reason: string;
  fromVersion: 1 | 2;
}

export interface ProseAcceptanceValue {
  rowRef: string;
  index: number;
  value: string;
}

export interface MissingWorkspaceAlias {
  scope: "plan" | "row";
  rowRef?: string;
  alias: string;
}

export interface RunMigrationScan {
  runId: string;
  /** Directory basename, when the caller scanned a directory. */
  runDir?: string;
  /** True when the journal replayed and the snapshot could be read. */
  readable: boolean;
  error?: string;
  phase: RunPhase;
  mode?: string;
  seq: number;
  /** `snapshot.json` seq, when the caller supplied it. */
  snapshotCacheSeq?: number;
  /** True when `snapshot.json` disagrees with the replayed journal. */
  staleSnapshotCache: boolean;
  /** Stored shape (`1` without `schemaVersion`, `2` with it). */
  snapshotVersion?: number;
  /** Shape the reader upcast the snapshot to. */
  frozenFromVersion?: 1 | 2;
  planPath?: string;
  workspaces: FrozenWorkspace[];
  accepted: number;
  totalRows: number;
  /** Effective final checks after any `run.control` repairs. */
  finalChecks: string[];
  typedCheckCount: number;
  quarantined: ScannedCheckIssue[];
  proseAcceptance: ProseAcceptanceValue[];
  missingWorkspaces: MissingWorkspaceAlias[];
  /** Number of `plan-check-specs-repair` events replayed in the scan. */
  repairEvents: number;
  /** Human-readable findings that need a decision. */
  issues: string[];
}

export interface PlanMigrationScan {
  path: string;
  readable: boolean;
  error?: string;
  /** True when the plan compiles with no error diagnostics. */
  ok: boolean;
  rows: number;
  gate: number;
  diagnostic: number;
  manual: number;
  rowChecks: number;
  needsAcknowledgement: boolean;
  acknowledgementReason?: string;
  declaredWorkspaces: string[];
  diagnostics: PlanDiagnostic[];
}

export interface MigrationReport {
  runs: RunMigrationScan[];
  plans: PlanMigrationScan[];
  /** Ordered, actionable repair list. Empty means nothing to migrate. */
  repairList: string[];
  counts: {
    runs: number;
    unreadableRuns: number;
    v1Runs: number;
    repairedRuns: number;
    quarantinedChecks: number;
    missingWorkspaceAliases: number;
    plans: number;
    failingPlans: number;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function workspacesOf(value: unknown): FrozenWorkspace[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(isRecord)
    .filter(
      (entry): entry is FrozenWorkspace & Record<string, unknown> =>
        typeof entry.id === "string" &&
        typeof entry.root === "string" &&
        typeof entry.key === "string" &&
        (entry.kind === "git" || entry.kind === "plain") &&
        typeof entry.displayPath === "string" &&
        typeof entry.primary === "boolean",
    )
    .map((entry) => ({
      id: entry.id,
      key: entry.key,
      root: entry.root,
      kind: entry.kind,
      displayPath: entry.displayPath,
      primary: entry.primary,
    }));
}

function phaseOf(events: readonly { type: string; payload: unknown }[]): RunPhase {
  let phase: RunPhase = "ready";
  for (const event of events) {
    if (event.type !== "run.transition") continue;
    const payload = event.payload;
    if (!isRecord(payload) || typeof payload.to !== "string") continue;
    if ((RUN_PHASES as readonly string[]).includes(payload.to)) {
      phase = payload.to as RunPhase;
    }
  }
  return phase;
}

function snapshotSeqOf(snapshotText: string | undefined): number | undefined {
  if (snapshotText === undefined || snapshotText.trim().length === 0) return undefined;
  try {
    const parsed = JSON.parse(snapshotText);
    return isRecord(parsed) && typeof parsed.seq === "number" ? parsed.seq : undefined;
  } catch {
    return undefined;
  }
}

function quarantineIssues(quarantined: readonly QuarantinedCheck[]): ScannedCheckIssue[] {
  return quarantined.map((entry) => ({
    scope: entry.scope,
    ...(entry.rowRef === undefined ? {} : { rowRef: entry.rowRef }),
    index: entry.index,
    command: entry.command,
    reason: entry.reason,
    fromVersion: entry.fromVersion,
  }));
}

/** v1 rows keep `acceptanceChecks: string[]`; non-command entries are prose. */
function proseAcceptanceOf(snapshot: unknown): ProseAcceptanceValue[] {
  if (!isRecord(snapshot) || !Array.isArray(snapshot.rows)) return [];
  const found: ProseAcceptanceValue[] = [];
  for (const row of snapshot.rows as unknown[]) {
    if (!isRecord(row) || !Array.isArray(row.acceptanceChecks)) continue;
    const rowRef = typeof row.ref === "string" ? row.ref : "?";
    (row.acceptanceChecks as unknown[]).forEach((entry, index) => {
      if (typeof entry !== "string" || entry.trim().length === 0) return;
      if (validateCommandShape(entry).ok) return;
      found.push({ rowRef, index, value: entry });
    });
  }
  return found;
}

function workspaceAliasesOf(snapshot: unknown): FrozenWorkspace[] {
  if (!isRecord(snapshot)) return [];
  return workspacesOf(snapshot.workspaces);
}

function collectMissingWorkspaces(
  snapshot: unknown,
  workspaces: readonly FrozenWorkspace[],
): MissingWorkspaceAlias[] {
  const bound = new Set(workspaces.map((workspace) => workspace.id));
  const missing: MissingWorkspaceAlias[] = [];
  const seen = new Set<string>();
  const add = (scope: "plan" | "row", rowRef: string | undefined, alias: unknown): void => {
    if (typeof alias !== "string" || alias.length === 0) return;
    if (bound.has(alias)) return;
    const key = `${scope}\u0000${rowRef ?? ""}\u0000${alias}`;
    if (seen.has(key)) return;
    seen.add(key);
    missing.push({ scope, ...(rowRef === undefined ? {} : { rowRef }), alias });
  };
  if (!isRecord(snapshot)) return missing;
  if (Array.isArray(snapshot.planCheckSpecs)) {
    for (const spec of snapshot.planCheckSpecs as unknown[]) {
      if (isRecord(spec)) add("plan", undefined, spec.workspace);
    }
  }
  if (Array.isArray(snapshot.checks)) {
    for (const check of snapshot.checks as unknown[]) {
      if (isRecord(check)) add("plan", undefined, check.workspace);
    }
  }
  if (Array.isArray(snapshot.rows)) {
    for (const row of snapshot.rows as unknown[]) {
      if (!isRecord(row)) continue;
      const rowRef = typeof row.ref === "string" ? row.ref : undefined;
      const aliases = stringArray(row.workspaces);
      for (const alias of aliases) add("row", rowRef, alias);
      if (Array.isArray(row.checks)) {
        for (const check of row.checks as unknown[]) {
          if (isRecord(check)) add("row", rowRef, check.workspace);
        }
      }
    }
  }
  return missing;
}

function storedSnapshotVersion(snapshot: unknown): number | undefined {
  if (!isRecord(snapshot)) return undefined;
  if (typeof snapshot.schemaVersion === "number") return snapshot.schemaVersion;
  if (typeof snapshot.version === "number") return snapshot.version;
  return undefined;
}

export interface RunScanInput {
  runId: string;
  /** Raw `journal.ndjson` text, or null when the file is missing. */
  journalText: string | null;
  /** Raw `snapshot.json` text, or undefined when the cache is absent. */
  snapshotText?: string;
  runDir?: string;
}

/**
 * Scan one run without writing anything. Every failure is a finding, not an
 * exception: a torn journal or an unknown snapshot version is reported so the
 * operator can decide, instead of aborting the whole report.
 */
export function scanRunJournal(input: RunScanInput): RunMigrationScan {
  const empty: RunMigrationScan = {
    runId: input.runId,
    ...(input.runDir === undefined ? {} : { runDir: input.runDir }),
    readable: false,
    phase: "ready",
    seq: 0,
    staleSnapshotCache: false,
    workspaces: [],
    accepted: 0,
    totalRows: 0,
    finalChecks: [],
    typedCheckCount: 0,
    quarantined: [],
    proseAcceptance: [],
    missingWorkspaces: [],
    repairEvents: 0,
    issues: [],
  };
  const replayed = replayJournal(input.runId, input.journalText);
  if (!replayed.ok) {
    return {
      ...empty,
      error: `${replayed.code}: ${replayed.error}`,
      staleSnapshotCache: false,
      issues: [`journal is not replayable (${replayed.code}): ${replayed.error}`],
    };
  }
  const { state } = replayed.value;
  const events = state.events;
  const created = events.find((event) => event.type === "run.created");
  const frozenEvent = events.find((event) => event.type === "todos.frozen");
  const createdPayload = isRecord(created?.payload) ? created!.payload : undefined;
  const mode = typeof createdPayload?.mode === "string" ? createdPayload.mode : undefined;
  const planPath =
    typeof createdPayload?.sourcePath === "string" ? createdPayload.sourcePath : undefined;
  const snapshotCacheSeq = snapshotSeqOf(input.snapshotText);
  const staleSnapshotCache =
    snapshotCacheSeq !== undefined && input.journalText !== null && snapshotCacheSeq !== state.seq;

  if (!frozenEvent || !isRecord(frozenEvent.payload) || !isRecord(frozenEvent.payload.snapshot)) {
    return {
      ...empty,
      phase: phaseOf(events),
      ...(mode === undefined ? {} : { mode }),
      seq: state.seq,
      ...(snapshotCacheSeq === undefined ? {} : { snapshotCacheSeq }),
      staleSnapshotCache,
      ...(planPath === undefined ? {} : { planPath }),
      accepted: state.acceptedTaskIds.size,
      error: "the journal has no readable todos.frozen snapshot",
      issues: ["journal has no readable todos.frozen snapshot; the run cannot be executed"],
    };
  }

  let currentSnapshot: unknown = frozenEvent.payload.snapshot;
  let repairEvents = 0;
  const issues: string[] = [];
  for (const event of events) {
    if (event.type !== "run.control") continue;
    const payload = event.payload;
    if (!isRecord(payload) || payload.action !== CHECK_SPEC_REPAIR_ACTION) continue;
    if (!isRecord(currentSnapshot)) break;
    const applied = applyCheckSpecRepair(
      currentSnapshot as unknown as FrozenTodoSnapshot,
      payload,
    );
    if (applied.ok) {
      currentSnapshot = applied.value.snapshot;
      if (applied.value.changed) repairEvents += 1;
      continue;
    }
    issues.push(
      `run.control repair at seq ${event.seq} could not be applied: ${applied.error}`,
    );
  }

  const read = readFrozenSnapshot(currentSnapshot);
  const workspaces = workspaceAliasesOf(currentSnapshot);
  const rawRows = isRecord(currentSnapshot) && Array.isArray(currentSnapshot.rows)
    ? (currentSnapshot.rows as FrozenTodoRow[])
    : [];
  const missingWorkspaces = collectMissingWorkspaces(currentSnapshot, workspaces);
  const proseAcceptance = proseAcceptanceOf(currentSnapshot);
  const quarantined = quarantineIssues(
    read.ok ? read.quarantined : frozenEventQuarantine(currentSnapshot),
  );
  const rawPlanChecks = isRecord(currentSnapshot) ? stringArray(currentSnapshot.planChecks) : [];
  const finalChecks = read.ok ? read.snapshot.planChecks : rawPlanChecks;
  const typedCheckCount =
    read.ok && read.fromVersion === 2
      ? read.snapshot.checks.length
      : rawPlanChecks.filter((command) => validateCommandShape(command).ok).length;

  for (const issue of quarantined) {
    issues.push(
      `quarantined ${issue.scope} check #${issue.index + 1}${
        issue.rowRef === undefined ? "" : ` (row ${issue.rowRef})`
      }: ${issue.reason} — \`${issue.command}\` is never executed`,
    );
  }
  for (const missing of missingWorkspaces) {
    issues.push(
      `${missing.scope === "plan" ? "plan" : `row ${missing.rowRef ?? "?"}`} check references unbound workspace alias "${missing.alias}"`,
    );
  }
  if (!read.ok) {
    issues.push(
      `frozen snapshot is not readable (${read.code}): ${read.error}; the run must not execute checks`,
    );
  }
  if (staleSnapshotCache) {
    issues.push(
      `snapshot.json seq ${String(snapshotCacheSeq)} disagrees with the replayed seq ${state.seq}; reopening the run rebuilds the cache (this report does not write)`,
    );
  }
  for (const inherited of state.truncated > 0
    ? [`journal replay stopped after ${state.seq} line(s); ${state.truncated} line(s) ignored as a torn tail`]
    : []) {
    issues.push(inherited);
  }

  return {
    runId: input.runId,
    ...(input.runDir === undefined ? {} : { runDir: input.runDir }),
    readable: read.ok,
    ...(read.ok ? {} : { error: `${read.code}: ${read.error}` }),
    phase: phaseOf(events),
    ...(mode === undefined ? {} : { mode }),
    seq: state.seq,
    ...(snapshotCacheSeq === undefined ? {} : { snapshotCacheSeq }),
    staleSnapshotCache,
    ...(storedSnapshotVersion(currentSnapshot) === undefined
      ? {}
      : { snapshotVersion: storedSnapshotVersion(currentSnapshot) }),
    ...(read.ok ? { frozenFromVersion: read.fromVersion } : {}),
    ...(planPath === undefined ? {} : { planPath }),
    workspaces,
    accepted: state.acceptedTaskIds.size,
    totalRows: rawRows.length,
    finalChecks,
    typedCheckCount,
    quarantined,
    proseAcceptance,
    missingWorkspaces,
    repairEvents,
    issues,
  };
}

/**
 * `readFrozenSnapshot` returns quarantine only on a successful read. When the
 * whole snapshot is unreadable we still want the v1 malformed checks listed,
 * because that is exactly the shape the repair tool fixes.
 */
function frozenEventQuarantine(snapshot: unknown): QuarantinedCheck[] {
  if (!isRecord(snapshot) || !Array.isArray(snapshot.planChecks)) return [];
  const out: QuarantinedCheck[] = [];
  (snapshot.planChecks as unknown[]).forEach((entry, index) => {
    if (typeof entry !== "string") return;
    const shape = validateCommandShape(entry);
    if (shape.ok) return;
    out.push({
      scope: "plan",
      index,
      command: entry,
      reason: shape.error ?? "not a command",
      fromVersion: 1,
    });
  });
  return out;
}

export interface PlanScanInput {
  path: string;
  markdown: string | null;
}

/** Scan one plan with the same compiler the freeze path uses. Read-only. */
export function scanPlanText(input: PlanScanInput): PlanMigrationScan {
  if (input.markdown === null) {
    return {
      path: input.path,
      readable: false,
      error: "the plan file is missing or unreadable",
      ok: false,
      rows: 0,
      gate: 0,
      diagnostic: 0,
      manual: 0,
      rowChecks: 0,
      needsAcknowledgement: true,
      declaredWorkspaces: [],
      diagnostics: [],
    };
  }
  const declared = parseWorkspaceDeclarations(input.markdown);
  // The compiler only needs the alias ids to resolve `[W]`/`workspace:`; it
  // never touches a root here. Stubs keep the scan independent of the machine.
  const workspaces: FrozenWorkspace[] = declared.map((declaration, index) => ({
    id: declaration.id,
    key: `scan:${declaration.id}`,
    root: declaration.path,
    kind: "plain",
    displayPath: declaration.path,
    primary: index === 0,
  }));
  const result = lintPlan(input.markdown, { path: input.path, workspaces });
  return {
    path: input.path,
    readable: true,
    ...(result.error === undefined ? {} : { error: result.error }),
    ok: result.ok,
    rows: result.assessment.rows,
    gate: result.assessment.gate,
    diagnostic: result.assessment.diagnostic,
    manual: result.assessment.manual,
    rowChecks: result.assessment.rowChecks,
    needsAcknowledgement: result.assessment.needsAcknowledgement,
    ...(result.assessment.acknowledgementReason === undefined
      ? {}
      : { acknowledgementReason: result.assessment.acknowledgementReason }),
    declaredWorkspaces: declared.map((declaration) => declaration.id),
    diagnostics: result.diagnostics,
  };
}

function runRepairActions(run: RunMigrationScan): string[] {
  const actions: string[] = [];
  if (run.error !== undefined && !run.readable) {
    actions.push(
      `${run.runId}: do not execute; resolve "${run.error}" before retrying the row`,
    );
  }
  if (run.quarantined.length > 0) {
    actions.push(
      `${run.runId}: replace ${run.quarantined.length} malformed final check(s) with a durable amendment — node --experimental-transform-types agent/extensions/workflow/scripts/repair-orchestrator-checks.mjs --run-dir <run-dir> --status, then --manifest <file> --apply --yes --expect-seq ${run.seq}`,
    );
  }
  for (const missing of run.missingWorkspaces) {
    actions.push(
      `${run.runId}: bind workspace alias "${missing.alias}" (start the run with the root or amend the checks); no silent primary-root fallback`,
    );
  }
  if (run.staleSnapshotCache) {
    actions.push(
      `${run.runId}: reopen the run so the store rebuilds snapshot.json from the journal (the scanner never writes)`,
    );
  }
  if (run.repairEvents > 0) {
    actions.push(
      `${run.runId}: ${run.repairEvents} plan-check amendment event(s) already applied; keep the journal as-is and do not re-freeze`,
    );
  }
  return actions;
}

function planRepairActions(plan: PlanMigrationScan): string[] {
  const actions: string[] = [];
  if (!plan.readable) {
    actions.push(`${plan.path}: restore the plan file before freezing a new run (existing runs still restore from their journal)`);
    return actions;
  }
  if (!plan.ok) {
    actions.push(
      `${plan.path}: plan does not compile; fix the error diagnostics and run /plan lint before approving`,
    );
  }
  if (plan.needsAcknowledgement) {
    actions.push(
      `${plan.path}: no final gate check (${plan.acknowledgementReason ?? "unverifiable"}); add a real gate or acknowledge explicitly at freeze`,
    );
  }
  return actions;
}

/** Aggregate a set of scanned runs and plans into one report + repair list. */
export function buildMigrationReport(input: {
  runs: readonly RunMigrationScan[];
  plans: readonly PlanMigrationScan[];
}): MigrationReport {
  const runs = [...input.runs];
  const plans = [...input.plans];
  const repairList = [
    ...runs.flatMap(runRepairActions),
    ...plans.flatMap(planRepairActions),
  ];
  return {
    runs,
    plans,
    repairList,
    counts: {
      runs: runs.length,
      unreadableRuns: runs.filter((run) => !run.readable).length,
      v1Runs: runs.filter((run) => run.frozenFromVersion === 1).length,
      repairedRuns: runs.filter((run) => run.repairEvents > 0).length,
      quarantinedChecks: runs.reduce((total, run) => total + run.quarantined.length, 0),
      missingWorkspaceAliases: runs.reduce(
        (total, run) => total + run.missingWorkspaces.length,
        0,
      ),
      plans: plans.length,
      failingPlans: plans.filter((plan) => !plan.ok).length,
    },
  };
}

function shortCommand(command: string): string {
  const text = command.replace(/\s+/g, " ").trim();
  return text.length <= 100 ? text : `${text.slice(0, 97)}…`;
}

/** Deterministic, ANSI-free text report. Safe for a command result. */
export function formatMigrationReport(report: MigrationReport): string {
  const lines: string[] = [];
  const counts = report.counts;
  lines.push(
    `migration scan: ${counts.runs} run(s), ${counts.plans} plan(s) — read-only, no journal or snapshot was written`,
  );
  lines.push(
    `runs: ${counts.v1Runs} v1, ${counts.repairedRuns} already amended, ${counts.unreadableRuns} unreadable, ${counts.quarantinedChecks} quarantined check(s), ${counts.missingWorkspaceAliases} unbound alias(es)`,
  );
  lines.push(`plans: ${counts.failingPlans} of ${counts.plans} do not compile`);
  if (report.runs.length > 0) {
    lines.push("", "## Runs");
    for (const run of report.runs) {
      const accepted = run.totalRows === 0 ? `${run.accepted}` : `${run.accepted}/${run.totalRows}`;
      const version =
        run.snapshotVersion === undefined ? "?" : `v${run.snapshotVersion}`;
      const upcast =
        run.frozenFromVersion === undefined ? "" : ` (read as v${run.frozenFromVersion})`;
      lines.push(
        `- ${run.runId}${run.runDir === undefined ? "" : ` [${run.runDir}]`}: ${run.phase}, seq ${run.seq}, accepted ${accepted}, snapshot ${version}${upcast}, ${run.finalChecks.length} final check(s), ${run.typedCheckCount} typed`,
      );
      if (run.planPath) lines.push(`  plan: ${run.planPath}`);
      if (run.workspaces.length > 0) {
        lines.push(
          `  workspaces: ${run.workspaces
            .map((workspace) => `${workspace.id}=${workspace.displayPath}${workspace.primary ? " (primary)" : ""}`)
            .join(", ")}`,
        );
      }
      for (const quarantine of run.quarantined) {
        lines.push(
          `  QUARANTINED ${quarantine.scope} #${quarantine.index + 1}: ${shortCommand(quarantine.command)} — ${quarantine.reason}`,
        );
      }
      for (const prose of run.proseAcceptance) {
        lines.push(
          `  prose acceptance row ${prose.rowRef} #${prose.index + 1}: ${shortCommand(prose.value)} (criterion, never executed)`,
        );
      }
      for (const missing of run.missingWorkspaces) {
        lines.push(
          `  UNBOUND workspace ${missing.alias} on ${missing.scope === "plan" ? "plan check" : `row ${missing.rowRef ?? "?"}`}`,
        );
      }
      if (run.staleSnapshotCache) {
        lines.push(
          `  STALE snapshot.json seq ${String(run.snapshotCacheSeq)} != journal seq ${run.seq}`,
        );
      }
      for (const issue of run.issues) {
        if (
          run.quarantined.some((quarantine) => issue.includes(quarantine.command)) ||
          run.missingWorkspaces.some((missing) => issue.includes(missing.alias)) ||
          run.proseAcceptance.some((prose) => issue.includes(prose.value))
        ) {
          continue;
        }
        lines.push(`  ! ${issue}`);
      }
    }
  }
  if (report.plans.length > 0) {
    lines.push("", "## Plans");
    for (const plan of report.plans) {
      lines.push(
        `- ${plan.path}: ${plan.ok ? "compiles" : "FAILS"} — ${plan.rows} row(s), gate ${plan.gate}, diagnostic ${plan.diagnostic}, manual ${plan.manual}, row checks ${plan.rowChecks}${plan.needsAcknowledgement ? ", needs freeze acknowledgement" : ""}`,
      );
      for (const diagnostic of plan.diagnostics) {
        if (diagnostic.severity !== "error") continue;
        const line = diagnostic.line === undefined ? "" : ` line ${diagnostic.line}`;
        lines.push(`  ERROR${line}: ${diagnostic.message}`);
      }
      if (plan.error !== undefined && plan.ok === false) lines.push(`  ${plan.error}`);
    }
  }
  lines.push("", "## Repair list");
  if (report.repairList.length === 0) {
    lines.push("- none: every scanned run is readable and no plan needs migration");
  } else {
    for (const action of report.repairList) lines.push(`- ${action}`);
  }
  return lines.join("\n");
}
