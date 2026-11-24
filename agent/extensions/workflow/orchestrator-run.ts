/**
 * Workflow Extension — model-driven Orchestrator run record.
 *
 * The approved plan is the source document. The parent model reads it and
 * supplies the numbered steps; this module only remembers which row is
 * dispatched, the instruction it received and the child's last report. It is
 * deliberately not an event-sourced journal: the session entry is the durable
 * record and a reload restores the last snapshot.
 */

export const ORCHESTRATOR_RUN_SCHEMA_VERSION = 1 as const;

export type OrchestratorRunPhase =
  | "idle"
  | "running"
  | "paused"
  | "interrupted"
  | "completed";

export interface OrchestratorRunRow {
  /** Display ref, stable for the life of the run: "1".."N". */
  ref: string;
  text: string;
  /** The parent's latest instruction for this row, reused on a retry. */
  instruction?: string;
  /** The child's final summary for the last dispatch. */
  lastReport?: string;
  lastReportAt?: number;
}

export interface OrchestratorRun {
  schemaVersion: typeof ORCHESTRATOR_RUN_SCHEMA_VERSION;
  runId: string;
  planPath?: string;
  title: string;
  rows: OrchestratorRunRow[];
  currentRef?: string;
  childSessionId?: string;
  phase: OrchestratorRunPhase;
  createdAt: number;
  updatedAt: number;
}

export interface CreateOrchestratorRunInput {
  title?: string;
  planPath?: string;
  steps: readonly string[];
  now?: number;
}

function cleanSteps(steps: readonly string[]): string[] {
  return steps
    .map((step) => String(step ?? "").replace(/\s+/g, " ").trim())
    .filter((step) => step.length > 0);
}

export function createOrchestratorRun(
  input: CreateOrchestratorRunInput,
): OrchestratorRun {
  const now = input.now ?? Date.now();
  const steps = cleanSteps(input.steps);
  const title = (input.title ?? "").trim() || "Orchestrator work";
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32) || "run";
  return {
    schemaVersion: ORCHESTRATOR_RUN_SCHEMA_VERSION,
    runId: `run-${now.toString(36)}-${slug}`,
    ...(input.planPath ? { planPath: input.planPath } : {}),
    title,
    rows: steps.map((text, index) => ({ ref: String(index + 1), text })),
    phase: "idle",
    createdAt: now,
    updatedAt: now,
  };
}

function touch(run: OrchestratorRun, patch: Partial<OrchestratorRun>): OrchestratorRun {
  return {
    ...run,
    ...patch,
    updatedAt: Date.now(),
  };
}

export function recordDispatch(
  run: OrchestratorRun,
  input: { rowRef: string; instruction: string; childSessionId?: string },
): OrchestratorRun {
  const rowRef = String(input.rowRef);
  return touch(run, {
    phase: "running",
    currentRef: rowRef,
    ...(input.childSessionId ? { childSessionId: input.childSessionId } : {}),
    rows: run.rows.map((row) =>
      row.ref === rowRef ? { ...row, instruction: input.instruction } : row,
    ),
  });
}

export function recordReport(
  run: OrchestratorRun,
  input: { rowRef: string; report: string; now?: number },
): OrchestratorRun {
  const rowRef = String(input.rowRef);
  const at = input.now ?? Date.now();
  return touch(run, {
    phase: "idle",
    rows: run.rows.map((row) =>
      row.ref === rowRef
        ? { ...row, lastReport: input.report, lastReportAt: at }
        : row,
    ),
  });
}

export function setRunPhase(
  run: OrchestratorRun,
  phase: OrchestratorRunPhase,
): OrchestratorRun {
  return touch(run, { phase });
}

export function runRow(run: OrchestratorRun, ref: string): OrchestratorRunRow | undefined {
  return run.rows.find((row) => row.ref === String(ref));
}

/** Next row that is not completed in the TODO list. */
export function nextPendingRow(
  run: OrchestratorRun,
  isCompleted: (ref: string) => boolean,
): OrchestratorRunRow | undefined {
  return run.rows.find((row) => !isCompleted(row.ref));
}

export function restoreOrchestratorRun(value: unknown): OrchestratorRun | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Partial<OrchestratorRun>;
  if (record.schemaVersion !== ORCHESTRATOR_RUN_SCHEMA_VERSION) return undefined;
  if (typeof record.runId !== "string" || !record.runId.trim()) return undefined;
  if (!Array.isArray(record.rows)) return undefined;
  const rows: OrchestratorRunRow[] = record.rows
    .map((entry) => {
      if (!entry || typeof entry !== "object") return undefined;
      const row = entry as Partial<OrchestratorRunRow>;
      if (typeof row.text !== "string" || !row.text.trim()) return undefined;
      return {
        ref: String(row.ref ?? "").trim() || "",
        text: row.text,
        ...(typeof row.instruction === "string" ? { instruction: row.instruction } : {}),
        ...(typeof row.lastReport === "string" ? { lastReport: row.lastReport } : {}),
        ...(typeof row.lastReportAt === "number" ? { lastReportAt: row.lastReportAt } : {}),
      } satisfies OrchestratorRunRow;
    })
    .filter((row): row is OrchestratorRunRow => row !== undefined && row.ref !== "");
  if (rows.length === 0) return undefined;
  const phase: OrchestratorRunPhase =
    record.phase === "running" || record.phase === "paused" || record.phase === "completed"
      ? record.phase
      : record.phase === "interrupted"
        ? "interrupted"
        : "idle";
  return {
    schemaVersion: ORCHESTRATOR_RUN_SCHEMA_VERSION,
    runId: record.runId,
    ...(typeof record.planPath === "string" ? { planPath: record.planPath } : {}),
    title: typeof record.title === "string" && record.title.trim() ? record.title : "Orchestrator work",
    rows,
    ...(typeof record.currentRef === "string" ? { currentRef: record.currentRef } : {}),
    ...(typeof record.childSessionId === "string"
      ? { childSessionId: record.childSessionId }
      : {}),
    phase,
    createdAt: typeof record.createdAt === "number" ? record.createdAt : Date.now(),
    updatedAt: typeof record.updatedAt === "number" ? record.updatedAt : Date.now(),
  };
}
