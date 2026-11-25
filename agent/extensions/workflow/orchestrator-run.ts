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
  | "cancelled"
  | "completed";

export type OrchestratorWorkspaceKind = "git" | "plain";

/** One resolved repository root a run may target. */
export interface OrchestratorRunWorkspace {
  /** Short alias used by the model, the operator and the tool input. */
  id: string;
  /** Absolute repository root. */
  root: string;
  /** `git` when the root is a git work tree, `plain` otherwise. */
  kind: OrchestratorWorkspaceKind;
  /** Root as the user declared it, for display. */
  displayPath: string;
  /** Exactly one workspace is the session root. */
  primary: boolean;
}

/** One advisory review note attached to a row. Never a gate. */
export interface OrchestratorRowReviewNote {
  /** Stable note id, `R<n>`. */
  id: string;
  /** The required change, as parsed from the plan appendix. */
  change: string;
}

/** A note the harness could not bind to a row; the parent must place it. */
export interface OrchestratorUnboundReviewNote extends OrchestratorRowReviewNote {
  /** The plan step reference when the note carried one. */
  step?: string;
}

export interface OrchestratorRunRow {
  /** Display ref, stable for the life of the run: "1".."N". */
  ref: string;
  text: string;
  /** Advisory review notes bound to this row; never acceptance criteria. */
  reviewNotes?: OrchestratorRowReviewNote[];
  /** The parent's latest instruction for this row, reused on a retry. */
  instruction?: string;
  /** The child's final summary for the last dispatch. */
  lastReport?: string;
  lastReportAt?: number;
  /** Declared workspace this row targets; other roots belong to other rows. */
  workspaceId?: string;
  /** Absolute child cwd for this row; the row workspace root by default. */
  cwd?: string;
}

/** A step is either plain text or text tagged with a declared workspace id. */
export type OrchestratorRunStep =
  | string
  | { text: string; workspace?: string };

export interface OrchestratorRun {
  schemaVersion: typeof ORCHESTRATOR_RUN_SCHEMA_VERSION;
  runId: string;
  planPath?: string;
  title: string;
  rows: OrchestratorRunRow[];
  /** Notes that could not be attached to a row; advisory and parent-placed. */
  unboundReviewNotes?: OrchestratorUnboundReviewNote[];
  /** Resolved roots the model declared at start time. */
  workspaces?: OrchestratorRunWorkspace[];
  currentRef?: string;
  childSessionId?: string;
  phase: OrchestratorRunPhase;
  /** Why the run stopped: a child error/abort or a lost reload. */
  blockedReason?: string;
  createdAt: number;
  updatedAt: number;
}

export interface CreateOrchestratorRunInput {
  title?: string;
  planPath?: string;
  steps: readonly OrchestratorRunStep[];
  workspaces?: readonly OrchestratorRunWorkspace[];
  /** Notes the caller could not bind to a row; preserved on the run. */
  unboundReviewNotes?: readonly OrchestratorUnboundReviewNote[];
  now?: number;
}

function cleanText(value: unknown): string {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeStep(step: OrchestratorRunStep): { text: string; workspace?: string } {
  if (typeof step === "string") return { text: cleanText(step) };
  if (!step || typeof step !== "object") return { text: "" };
  const text = cleanText((step as { text?: unknown }).text);
  const workspace = cleanText((step as { workspace?: unknown }).workspace);
  return { text, ...(workspace ? { workspace } : {}) };
}

/** Keep exactly one primary workspace so a run always has a default root. */
function ensureSinglePrimary(
  workspaces: readonly OrchestratorRunWorkspace[],
): OrchestratorRunWorkspace[] {
  const found = workspaces.findIndex((workspace) => workspace.primary);
  const primaryIndex = found === -1 ? 0 : found;
  return workspaces.map((workspace, index) =>
    workspace.primary === (index === primaryIndex)
      ? workspace
      : { ...workspace, primary: index === primaryIndex },
  );
}

/**
 * Normalize the model-supplied steps into rows with stable refs.
 * A step that names an undeclared workspace is refused, not guessed.
 */
function buildRows(
  steps: readonly OrchestratorRunStep[],
  byId: Map<string, OrchestratorRunWorkspace>,
  primary: OrchestratorRunWorkspace | undefined,
): OrchestratorRunRow[] {
  const rows: OrchestratorRunRow[] = [];
  for (const raw of steps) {
    const step = normalizeStep(raw);
    if (!step.text) continue;
    const ref = String(rows.length + 1);
    const workspace = step.workspace
      ? byId.get(step.workspace)
      : primary;
    if (step.workspace && !workspace) {
      const known = [...byId.keys()].join(", ") || "none declared";
      throw new Error(
        `Unknown workspace "${step.workspace}" on step ${ref}; declared workspaces: ${known}.`,
      );
    }
    rows.push({
      ref,
      text: step.text,
      ...(workspace ? { workspaceId: workspace.id, cwd: workspace.root } : {}),
    });
  }
  return rows;
}

export function createOrchestratorRun(
  input: CreateOrchestratorRunInput,
): OrchestratorRun {
  const now = input.now ?? Date.now();
  const workspaces = input.workspaces?.length
    ? ensureSinglePrimary(input.workspaces)
    : undefined;
  const byId = new Map<string, OrchestratorRunWorkspace>();
  for (const workspace of workspaces ?? []) {
    const id = cleanText(workspace.id);
    if (!id) throw new Error("Every declared workspace needs a non-empty id.");
    if (byId.has(id)) {
      throw new Error(`Duplicate workspace id "${id}"; each root needs its own alias.`);
    }
    byId.set(id, workspace);
  }
  const primary = workspaces?.find((workspace) => workspace.primary);
  const rows = buildRows(input.steps, byId, primary);
  const unboundReviewNotes = restoreUnboundReviewNotes(input.unboundReviewNotes);
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
    rows,
    ...(unboundReviewNotes ? { unboundReviewNotes } : {}),
    ...(workspaces ? { workspaces } : {}),
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

function clearBlockedReason(run: OrchestratorRun): OrchestratorRun {
  if (!("blockedReason" in run)) return run;
  const { blockedReason: _drop, ...rest } = run;
  return rest;
}

export function recordDispatch(
  run: OrchestratorRun,
  input: {
    rowRef: string;
    instruction: string;
    childSessionId?: string;
    workspaceId?: string;
    cwd?: string;
  },
): OrchestratorRun {
  const rowRef = String(input.rowRef);
  const base = clearBlockedReason(run);
  return touch(base, {
    phase: "running",
    currentRef: rowRef,
    ...(input.childSessionId ? { childSessionId: input.childSessionId } : {}),
    rows: base.rows.map((row) =>
      row.ref === rowRef
        ? {
            ...row,
            instruction: input.instruction,
            ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
            ...(input.cwd ? { cwd: input.cwd } : {}),
          }
        : row,
    ),
  });
}

export function recordReport(
  run: OrchestratorRun,
  input: { rowRef: string; report: string; now?: number },
): OrchestratorRun {
  const rowRef = String(input.rowRef);
  const at = input.now ?? Date.now();
  return touch(clearBlockedReason(run), {
    phase: "idle",
    rows: run.rows.map((row) =>
      row.ref === rowRef
        ? { ...row, lastReport: input.report, lastReportAt: at }
        : row,
    ),
  });
}

/**
 * Record a dispatch unless the row already reported after the attempt started.
 *
 * `dispatchOrchestratorRow` awaits child creation and prompt admission before
 * it can record the dispatch. A child that settles inside that window has
 * already written the report; recording against the pre-await snapshot would
 * overwrite it (the 2026-11-24 session lost row 1's report that way). The
 * settle wins: return the live record untouched and tell the caller.
 */
export function recordDispatchIfNotReported(
  run: OrchestratorRun,
  input: {
    rowRef: string;
    instruction: string;
    childSessionId?: string;
    workspaceId?: string;
    cwd?: string;
    /** Wall-clock captured before the child was created/admitted. */
    startedAt: number;
  },
): { run: OrchestratorRun; recorded: boolean } {
  const row = runRow(run, input.rowRef);
  if (
    row?.lastReportAt !== undefined &&
    Number.isFinite(row.lastReportAt) &&
    row.lastReportAt >= input.startedAt
  ) {
    return { run, recorded: false };
  }
  return { run: recordDispatch(run, input), recorded: true };
}

/**
 * The parent (or the operator) stopped the live child. The row stays retryable
 * and an existing settle report is never overwritten by the abort note.
 */
export function recordAbort(
  run: OrchestratorRun,
  input: { rowRef: string; report: string; reason: string; now?: number },
): OrchestratorRun {
  const rowRef = String(input.rowRef);
  const at = input.now ?? Date.now();
  const reason = cleanText(input.reason) || "child aborted";
  return touch(run, {
    phase: "paused",
    blockedReason: `Aborted: ${reason}`,
    rows: run.rows.map((row) =>
      row.ref === rowRef && row.lastReport === undefined
        ? { ...row, lastReport: input.report, lastReportAt: at }
        : row,
    ),
  });
}

/**
 * A child failure is not a normal settle: keep the row retryable, name the
 * reason and record the report so a reload still explains what happened.
 */
export function recordFailure(
  run: OrchestratorRun,
  input: { rowRef: string; report: string; reason: string; now?: number },
): OrchestratorRun {
  const rowRef = String(input.rowRef);
  const at = input.now ?? Date.now();
  const reason = cleanText(input.reason) || "the child failed";
  return touch(run, {
    phase: "interrupted",
    blockedReason: reason,
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
  // `paused` and `interrupted` are recovery states: their reason must survive
  // the operator's follow-up `setPhase` call after an abort/failure.
  const base =
    phase === "interrupted" || phase === "paused"
      ? run
      : clearBlockedReason(run);
  return touch(base, { phase });
}

/**
 * The reload lost the in-process child, or the child reported an error/abort.
 * The run stays resumable through `/orchestrator retry`.
 */
export function markRunInterrupted(
  run: OrchestratorRun,
  input: { now?: number; reason?: string } = {},
): OrchestratorRun {
  return {
    ...run,
    phase: "interrupted",
    blockedReason:
      cleanText(input.reason) || "the in-process child did not survive the reload",
    updatedAt: input.now ?? Date.now(),
  };
}

/** The workspace a row targets, or undefined when the run declares none. */
export function workspaceForRow(
  run: OrchestratorRun,
  row: OrchestratorRunRow | undefined,
): OrchestratorRunWorkspace | undefined {
  const id = row?.workspaceId;
  if (id) {
    const declared = run.workspaces?.find((workspace) => workspace.id === id);
    if (declared) return declared;
  }
  if (!row?.cwd) return undefined;
  return run.workspaces?.find((workspace) => workspace.root === row.cwd);
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

/** Validate bound notes; drop malformed entries rather than failing a restore. */
function restoreRowReviewNotes(value: unknown): OrchestratorRowReviewNote[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const notes: OrchestratorRowReviewNote[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const note = entry as Partial<OrchestratorRowReviewNote>;
    const id = typeof note.id === "string" ? note.id.trim() : "";
    const change = typeof note.change === "string" ? note.change.trim() : "";
    if (!id || !change) continue;
    notes.push({ id, change });
  }
  return notes.length > 0 ? notes : undefined;
}

/** Validate run-level notes; drop malformed entries rather than failing a restore. */
function restoreUnboundReviewNotes(
  value: unknown,
): OrchestratorUnboundReviewNote[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const notes: OrchestratorUnboundReviewNote[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const note = entry as Partial<OrchestratorUnboundReviewNote>;
    const id = typeof note.id === "string" ? note.id.trim() : "";
    const change = typeof note.change === "string" ? note.change.trim() : "";
    if (!id || !change) continue;
    const step =
      typeof note.step === "string" && note.step.trim() ? note.step.trim() : undefined;
    notes.push({ id, change, ...(step ? { step } : {}) });
  }
  return notes.length > 0 ? notes : undefined;
}

/** Drop corrupt workspace entries instead of failing the whole restore. */
function restoreWorkspaces(value: unknown): OrchestratorRunWorkspace[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const seen = new Set<string>();
  const workspaces: OrchestratorRunWorkspace[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const workspace = entry as Partial<OrchestratorRunWorkspace>;
    const id = typeof workspace.id === "string" ? workspace.id.trim() : "";
    const root = typeof workspace.root === "string" ? workspace.root.trim() : "";
    if (!id || !root || seen.has(id)) continue;
    seen.add(id);
    workspaces.push({
      id,
      root,
      kind: workspace.kind === "git" ? "git" : "plain",
      displayPath:
        typeof workspace.displayPath === "string" && workspace.displayPath.trim()
          ? workspace.displayPath
          : root,
      primary: workspace.primary === true,
    });
  }
  return workspaces.length > 0 ? ensureSinglePrimary(workspaces) : undefined;
}

function restoreRow(
  entry: unknown,
  workspaceIds: ReadonlySet<string>,
): OrchestratorRunRow | undefined {
  if (!entry || typeof entry !== "object") return undefined;
  const row = entry as Partial<OrchestratorRunRow>;
  if (typeof row.text !== "string" || !row.text.trim()) return undefined;
  const ref = String(row.ref ?? "").trim();
  if (!ref) return undefined;
  const workspaceId =
    typeof row.workspaceId === "string" && workspaceIds.has(row.workspaceId)
      ? row.workspaceId
      : undefined;
  const reviewNotes = restoreRowReviewNotes(row.reviewNotes);
  return {
    ref,
    text: row.text,
    ...(reviewNotes ? { reviewNotes } : {}),
    ...(typeof row.instruction === "string" ? { instruction: row.instruction } : {}),
    ...(typeof row.lastReport === "string" ? { lastReport: row.lastReport } : {}),
    ...(typeof row.lastReportAt === "number" ? { lastReportAt: row.lastReportAt } : {}),
    ...(workspaceId ? { workspaceId } : {}),
    ...(typeof row.cwd === "string" ? { cwd: row.cwd } : {}),
  };
}

function restorePhase(value: unknown): OrchestratorRunPhase {
  return value === "running" ||
    value === "paused" ||
    value === "completed" ||
    value === "interrupted" ||
    value === "cancelled"
    ? value
    : "idle";
}

export interface BindReviewNotesResult {
  /** One slot per step row; `reviewNotes` is present only on bound rows. */
  rows: Array<{ ref: string; reviewNotes?: OrchestratorRowReviewNote[] }>;
  unboundReviewNotes: OrchestratorUnboundReviewNote[];
  /** True only when the plan's step count equals the run's row count. */
  aligned: boolean;
  planStepCount: number;
  rowCount: number;
}

/**
 * Attach advisory notes to rows by 1-based plan step index.
 *
 * Binding is positional and deliberately bounded: it happens only when the
 * plan's numbered-step count equals the model-supplied row count. A merged,
 * split or reordered row list with a different count leaves every note on the
 * run (`aligned: false`) so the parent can place them; even with equal counts a
 * reordered list still binds by index, because a row carries no plan-step
 * identity. A non-numeric or out-of-range step is never guessed onto a row.
 */
export function bindReviewNotes(
  notes: readonly OrchestratorUnboundReviewNote[],
  planStepCount: number,
  steps: readonly OrchestratorRunStep[],
): BindReviewNotesResult {
  const rowCount = steps.length;
  const rows: BindReviewNotesResult["rows"] = steps.map((_step, index) => ({
    ref: String(index + 1),
  }));
  const input = Array.isArray(notes) ? notes.filter(Boolean) : [];
  if (input.length === 0) {
    return { rows, unboundReviewNotes: [], aligned: true, planStepCount, rowCount };
  }
  if (planStepCount !== rowCount) {
    return {
      rows,
      unboundReviewNotes: input.map((note) => ({
        id: note.id,
        ...(note.step ? { step: note.step } : {}),
        change: note.change,
      })),
      aligned: false,
      planStepCount,
      rowCount,
    };
  }
  const unboundReviewNotes: OrchestratorUnboundReviewNote[] = [];
  for (const note of input) {
    const rawStep = typeof note.step === "string" ? note.step.trim() : "";
    const index = /^\d+$/.test(rawStep) ? Number(rawStep) : Number.NaN;
    if (!Number.isInteger(index) || index < 1 || index > rowCount) {
      unboundReviewNotes.push({
        id: note.id,
        ...(note.step ? { step: note.step } : {}),
        change: note.change,
      });
      continue;
    }
    const row = rows[index - 1];
    if (!row) continue;
    (row.reviewNotes ??= []).push({ id: note.id, change: note.change });
  }
  return { rows, unboundReviewNotes, aligned: true, planStepCount, rowCount };
}

export function restoreOrchestratorRun(value: unknown): OrchestratorRun | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Partial<OrchestratorRun>;
  if (record.schemaVersion !== ORCHESTRATOR_RUN_SCHEMA_VERSION) return undefined;
  if (typeof record.runId !== "string" || !record.runId.trim()) return undefined;
  if (!Array.isArray(record.rows)) return undefined;
  // Older records have no workspaces at all; they must still restore.
  const workspaces = restoreWorkspaces(record.workspaces);
  const workspaceIds = new Set(workspaces?.map((workspace) => workspace.id) ?? []);
  const rows = record.rows
    .map((entry) => restoreRow(entry, workspaceIds))
    .filter((row): row is OrchestratorRunRow => row !== undefined);
  if (rows.length === 0) return undefined;
  const unboundReviewNotes = restoreUnboundReviewNotes(record.unboundReviewNotes);
  const phase = restorePhase(record.phase);
  return {
    schemaVersion: ORCHESTRATOR_RUN_SCHEMA_VERSION,
    runId: record.runId,
    ...(typeof record.planPath === "string" ? { planPath: record.planPath } : {}),
    title: typeof record.title === "string" && record.title.trim() ? record.title : "Orchestrator work",
    rows,
    ...(unboundReviewNotes ? { unboundReviewNotes } : {}),
    ...(workspaces ? { workspaces } : {}),
    ...(typeof record.currentRef === "string" ? { currentRef: record.currentRef } : {}),
    ...(typeof record.childSessionId === "string"
      ? { childSessionId: record.childSessionId }
      : {}),
    phase,
    ...(typeof record.blockedReason === "string" && record.blockedReason.trim()
      ? { blockedReason: record.blockedReason }
      : {}),
    createdAt: typeof record.createdAt === "number" ? record.createdAt : Date.now(),
    updatedAt: typeof record.updatedAt === "number" ? record.updatedAt : Date.now(),
  };
}
