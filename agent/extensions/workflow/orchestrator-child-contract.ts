/**
 * Workflow Extension — in-process Orchestrator child contract.
 *
 * The Orchestrator's Build child is an ordinary SDK session created inside the
 * parent Pi process. What makes it a child is a small, validated custom entry
 * written before the session starts plus the kickoff prompt. There is no
 * process, window, tab, grant file or IPC endpoint.
 *
 * Rules:
 *  - unknown versions fail closed (no half-applied child identity);
 *  - a child can never opt into orchestration;
 *  - the contract is readable from either a custom entry (`data`) or a custom
 *    message (JSON text), so a host that writes either shape still works.
 */

/** Custom-entry type written into the child's in-memory session. */
export const ORCHESTRATOR_CHILD_ENTRY = "workflow-orchestrator-child";
export const ORCHESTRATOR_CHILD_VERSION = 2 as const;

/** One run row as the child receives it; the parent's instruction is separate. */
export interface ChildRow {
  ref: string;
  text: string;
  instruction?: string;
  /** Advisory review notes bound to this row; never requirements or gates. */
  reviewNotes?: Array<{ id: string; change: string }>;
  workspace?: { id: string; root: string };
}

export interface OrchestratorChildContext {
  version: typeof ORCHESTRATOR_CHILD_VERSION;
  runId: string;
  taskId: string;
  attemptId: string;
  /** Frozen row display ref, 1..N. */
  ref: string;
  total: number;
  /** Opaque parent session identity, for diagnostics only. */
  parentSessionRef: string;
  /** Semantic starting mode. Always build for a child. */
  mode: "build";
  /** A child may never start its own orchestration run. */
  mayOrchestrate: false;
  /** The single root this row targets; other roots belong to other rows. */
  workspace?: {
    id: string;
    root: string;
    primary: boolean;
  };
  createdAt: number;
}

export type OrchestratorChildReadResult =
  | { ok: true; context: OrchestratorChildContext; source: "entry" | "message" }
  | { ok: false; reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function messageContentText(message: unknown): string | undefined {
  if (!isRecord(message)) return undefined;
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const parts: string[] = [];
  for (const block of content) {
    if (isRecord(block) && block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    }
  }
  return parts.length > 0 ? parts.join("\n") : undefined;
}

/** Validate one bootstrap payload. Extra fields are ignored. */
export function parseOrchestratorChildContext(
  raw: unknown,
): OrchestratorChildReadResult {
  if (!isRecord(raw)) return { ok: false, reason: "bootstrap must be an object" };
  if (raw.version !== ORCHESTRATOR_CHILD_VERSION) {
    return {
      ok: false,
      reason: `unsupported orchestrator-child version ${String(raw.version)}`,
    };
  }
  const stringField = (name: string, max = 200): string | undefined => {
    const value = raw[name];
    if (typeof value !== "string") return undefined;
    const trimmed = value.trim();
    if (!trimmed || trimmed.length > max) return undefined;
    return trimmed;
  };
  const runId = stringField("runId");
  const taskId = stringField("taskId");
  const attemptId = stringField("attemptId");
  const ref = stringField("ref", 40);
  const parentSessionRef = stringField("parentSessionRef", 400);
  if (!runId) return { ok: false, reason: "invalid runId" };
  if (!taskId) return { ok: false, reason: "invalid taskId" };
  if (!attemptId) return { ok: false, reason: "invalid attemptId" };
  if (!ref) return { ok: false, reason: "invalid ref" };
  if (!parentSessionRef) return { ok: false, reason: "invalid parentSessionRef" };
  if (raw.mode !== undefined && raw.mode !== "build") {
    return { ok: false, reason: "a child must start in build mode" };
  }
  const total =
    typeof raw.total === "number" && Number.isFinite(raw.total)
      ? Math.max(1, Math.min(10_000, Math.trunc(raw.total)))
      : 1;
  const createdAt =
    typeof raw.createdAt === "number" && Number.isFinite(raw.createdAt)
      ? Math.trunc(raw.createdAt)
      : Date.now();
  let workspace: OrchestratorChildContext["workspace"];
  if (raw.workspace !== undefined) {
    if (!isRecord(raw.workspace)) return { ok: false, reason: "invalid workspace context" };
    const workspaceId = typeof raw.workspace.id === "string" ? raw.workspace.id.trim() : "";
    const root = typeof raw.workspace.root === "string" ? raw.workspace.root.trim() : "";
    if (!workspaceId || !root) return { ok: false, reason: "invalid workspace context" };
    workspace = {
      id: workspaceId,
      root,
      primary: raw.workspace.primary === true,
    };
  }
  return {
    ok: true,
    source: "entry",
    context: {
      version: ORCHESTRATOR_CHILD_VERSION,
      runId,
      taskId,
      attemptId,
      ref,
      total,
      parentSessionRef,
      mode: "build",
      mayOrchestrate: false,
      ...(workspace === undefined ? {} : { workspace }),
      createdAt,
    },
  };
}

/** One branch entry, structurally (console.SessionEntry-compatible). */
export interface ChildBranchEntryLike {
  type?: string;
  customType?: string;
  data?: unknown;
  message?: unknown;
}

/**
 * Find the newest child marker on the active branch. A later marker (a fresh
 * attempt) wins over an older one.
 */
export function readOrchestratorChildContext(
  entries: readonly ChildBranchEntryLike[],
): OrchestratorChildReadResult {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (!entry) continue;
    if (entry.type === "custom" && entry.customType === ORCHESTRATOR_CHILD_ENTRY) {
      return parseOrchestratorChildContext(entry.data);
    }
    if (
      entry.type === "message" &&
      isRecord(entry.message) &&
      entry.message.customType === ORCHESTRATOR_CHILD_ENTRY
    ) {
      const text = messageContentText(entry.message);
      if (text === undefined) {
        return {
          ok: false,
          reason: "orchestrator-child message has no text content",
        };
      }
      try {
        const parsed = parseOrchestratorChildContext(JSON.parse(text));
        return parsed.ok
          ? { ok: true, context: parsed.context, source: "message" }
          : parsed;
      } catch {
        return {
          ok: false,
          reason: "orchestrator-child message is not valid JSON",
        };
      }
    }
  }
  return { ok: false, reason: "absent" };
}

/**
 * True when the branch was created by the OLD external-child implementation.
 * Those sessions are demoted to ordinary Build with a warning; they are never
 * quarantined or left behind a grant that no longer exists.
 */
export function hasLegacyManagedHistory(
  entries: readonly ChildBranchEntryLike[],
): boolean {
  return entries.some(
    (entry) =>
      (entry.type === "custom" || entry.type === "message") &&
      (entry.customType === "workflow-managed-session" ||
        entry.customType === "workflow-task-assignment" ||
        entry.customType === "workflow-task-scope" ||
        entry.customType === "workflow-roadmap-reference" ||
        entry.customType === "workflow-control-grant"),
  );
}

/** Compact, authoritative child identity for the system prompt. */
export function buildOrchestratorChildSystemPrompt(
  context: OrchestratorChildContext,
): string {
  return [
    "[ORCHESTRATOR BUILD CHILD]",
    `You are the Build child for row ${context.ref}/${context.total} of run ${context.runId} (${context.taskId}).`,
    context.workspace
      ? `Your workspace root is ${context.workspace.root} (id ${context.workspace.id}). Other roots belong to other rows; do not edit them.`
      : "You work inside the same Pi process as the Orchestrator parent.",
    "",
    "Rules:",
    "- Work ONLY on this row. Do not start, resume or manage an Orchestrator run; you are not the coordinator.",
    "- Create your own task-local TODO list with workflow_todo BEFORE the first edit or write. Build mode refuses mutations until that list exists.",
    "- Do not sync or adopt the parent plan's steps. Your list is local to this row.",
    "- Review notes are advisory: the approved plan is authoritative and wins on conflict.",
    "- Do not ask the user to switch modes or to use /build. You already have full Build tools and policies.",
    "- Do not ask the user questions; if a decision is genuinely ambiguous, choose the safest reasonable assumption and state it in your final summary.",
    "- If a policy forbids a step (for example a commit under `workflow.commitPolicy: never`, or a folder/read/write denial), do not retry it and never mark it completed. Record it as `cancelled` with the policy named in the item text, leave the work uncommitted, and list it under `## Not done` in your final summary.",
    "- Use read/edit/write/bash/grep/find/ls normally. The normal write, folder, read, commit and shell policies apply.",
    "- When the row is done, stop with a short summary of what changed, the files touched and exactly what you ran to verify it. The parent trusts your report; do not claim acceptance.",
  ].join("\n");
}

export interface OrchestratorChildKickoffInput {
  context: OrchestratorChildContext;
  row: ChildRow;
  /** Concrete failure from the previous attempt, for a repair round. */
  repair?: string;
}

const MAX_KICKOFF_CHARS = 12_000;

/** Advisory notes are a bounded extra; the hard bound remains the whole kickoff. */
const MAX_REVIEW_NOTES_BLOCK_CHARS = 2_000;
const REVIEW_NOTE_FULL_COUNT = 5;
const REVIEW_NOTE_FULL_CHARS = 400;
const REVIEW_NOTE_SHORT_CHARS = 120;

function bound(text: string, max = MAX_KICKOFF_CHARS): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n… (truncated)`;
}

function clipReviewNote(value: unknown, max: number): string {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function reviewNoteBullet(note: { id: string; change: string }, max: number): string {
  return `- ${note.id}: ${clipReviewNote(note.change, max)}`;
}

/**
 * Render the advisory review-notes block, or `""` when the row has none.
 *
 * The first five notes keep up to 400 characters of change text; later notes
 * keep their id and up to 120 characters. If that exceeds the 2,000-character
 * target, the surplus notes collapse into one `… and N more: <ids>` line so an
 * id is never dropped. Five full 400-character entries can themselves exceed
 * 2,000, in which case the ids still win and the whole-kickoff bound applies.
 */
function buildReviewNotesSection(
  notes: readonly { id: string; change: string }[] | undefined,
): string {
  if (!notes || notes.length === 0) return "";
  const normalized = notes
    .map((note) => ({
      id: String(note.id ?? "").trim(),
      change: String(note.change ?? ""),
    }))
    .filter((note) => note.id.length > 0);
  if (normalized.length === 0) return "";

  const header = [
    "## Review notes (advisory)",
    "The approved plan is authoritative. Apply a note when it is consistent with the row. If a note conflicts with the plan or the row, follow the plan and record the conflict.",
  ].join("\n");
  const full = normalized
    .slice(0, REVIEW_NOTE_FULL_COUNT)
    .map((note) => reviewNoteBullet(note, REVIEW_NOTE_FULL_CHARS));
  const rest = normalized.slice(REVIEW_NOTE_FULL_COUNT);
  if (rest.length === 0) return [header, ...full].join("\n");

  const short = rest.map((note) =>
    reviewNoteBullet(note, REVIEW_NOTE_SHORT_CHARS),
  );
  const withAll = [header, ...full, ...short].join("\n");
  if (withAll.length <= MAX_REVIEW_NOTES_BLOCK_CHARS) return withAll;

  const candidate = (keep: number): string => {
    const omitted = rest.slice(keep);
    const lines = [header, ...full, ...short.slice(0, keep)];
    if (omitted.length > 0) {
      lines.push(`… and ${omitted.length} more: ${omitted.map((note) => note.id).join(", ")}`);
    }
    return lines.join("\n");
  };
  // Keep as many shortened bullets as fit beside the id-only overflow line.
  // Length grows monotonically with `keep`, so binary search the largest fit.
  let low = 0;
  let high = short.length - 1;
  let best: string | undefined;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const rendered = candidate(middle);
    if (rendered.length <= MAX_REVIEW_NOTES_BLOCK_CHARS) {
      best = rendered;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return best ?? candidate(0);
}

/**
 * The durable first user prompt. It carries the row and nothing from the parent
 * conversation, so the child cannot drift into orchestrating the run.
 */
export function buildOrchestratorChildKickoff(
  input: OrchestratorChildKickoffInput,
): string {
  const { context, row } = input;
  const workspace = context.workspace
    ? [
        "## Workspace",
        `Root: ${context.workspace.root} (id ${context.workspace.id})`,
        "Other roots belong to other rows; do not edit them.",
        "",
      ].join("\n")
    : "";
  const instruction = row.instruction?.trim()
    ? ["## Parent instructions", row.instruction.trim(), ""].join("\n")
    : "";
  const reviewNotes = buildReviewNotesSection(row.reviewNotes);
  const repair = input.repair?.trim()
    ? [
        "",
        "## Repair round",
        "The previous attempt did not resolve the reported blocker:",
        input.repair.trim().slice(0, 4_000),
        "",
        "Address the concrete problem, then finish with a short summary. Do not start over unless the problem requires it.",
      ].join("\n")
    : "";
  return bound(
    [
      `# Orchestrator Build child — row ${context.ref}/${context.total}`,
      "",
      `Run: ${context.runId}`,
      `Task: ${context.taskId}`,
      `Attempt: ${context.attemptId}`,
      "",
      "## Your row",
      row.text,
      "",
      ...(reviewNotes ? [reviewNotes, ""] : []),
      instruction,
      workspace,
      "## Protocol",
      "1. Create your task-local TODO list now with `workflow_todo` — one item per real sub-step. Mutations are refused until it exists.",
      "2. Work the list in order. Mark a step completed immediately; keep one in progress.",
      "3. Run the verification the row or the plan names, then say exactly what you ran and what it printed.",
      "4. Stop and answer with a concise summary: what changed, files touched, checks run with their real result, and every step you did NOT complete with the reason (policy or otherwise). End the summary with a `## Review notes` section listing every note id as `applied`, `not applicable — <why>`, or `conflicts with the plan — followed the plan`. A note whose text was shortened is still acknowledged by id. The parent branches on it.",
      "",
      "When a policy forbids a step, do not retry it and never mark it completed: mark it `cancelled` with the policy named in the item text, leave the work uncommitted, and list it under `## Not done` in your final summary.",
      "",
      "Do not orchestrate, do not edit the parent run, and do not ask the user to switch modes. The parent trusts your report instead of re-verifying it.",
      repair,
    ].join("\n"),
  );
}
