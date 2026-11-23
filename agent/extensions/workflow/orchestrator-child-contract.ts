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

import type { FrozenTodoRow } from "./todo-snapshot.ts";

/** Custom-entry type written into the child's in-memory session. */
export const ORCHESTRATOR_CHILD_ENTRY = "workflow-orchestrator-child";
export const ORCHESTRATOR_CHILD_VERSION = 1 as const;

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
  /** The row's bound root and the run's other roots, for prompt context. */
  workspace?: {
    id: string;
    root: string;
    primary: boolean;
    roots: Array<{ id: string; root: string; primary: boolean }>;
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
    const id = stringField("workspace", 24);
    void id;
    const workspaceId = typeof raw.workspace.id === "string" ? raw.workspace.id.trim() : "";
    const root = typeof raw.workspace.root === "string" ? raw.workspace.root.trim() : "";
    if (!workspaceId || !root) return { ok: false, reason: "invalid workspace context" };
    const rootsRaw = raw.workspace.roots;
    const roots = Array.isArray(rootsRaw)
      ? rootsRaw
          .filter((entry): entry is Record<string, unknown> => isRecord(entry))
          .map((entry) => ({
            id: typeof entry.id === "string" ? entry.id.trim() : "",
            root: typeof entry.root === "string" ? entry.root.trim() : "",
            primary: entry.primary === true,
          }))
          .filter((entry) => entry.id.length > 0 && entry.root.length > 0)
          .slice(0, 8)
      : [];
    workspace = {
      id: workspaceId,
      root,
      primary: raw.workspace.primary === true,
      roots,
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
    `You are the Build child for frozen row ${context.ref}/${context.total} of run ${context.runId} (${context.taskId}).`,
    context.workspace
      ? `Your workspace root is ${context.workspace.root} (id ${context.workspace.id}). The run also measures: ${context.workspace.roots.map((root) => `${root.id}=${root.root}`).join(", ")}.`
      : "You work inside the same Pi process as the Orchestrator parent.",
    "",
    "Rules:",
    "- Work ONLY on this row. Do not start, resume or manage an Orchestrator run; you are not the coordinator.",
    "- Create your own task-local TODO list with workflow_todo BEFORE the first edit or write. Build mode refuses mutations until that list exists.",
    "- Do not sync or adopt the parent plan's steps. Your list is local to this row.",
    "- Do not ask the user to switch modes or to use /build. You already have full Build tools and policies.",
    "- Do not ask the user questions; if a decision is genuinely ambiguous, choose the safest reasonable assumption and state it in your final summary.",
    "- Use read/edit/write/bash/grep/find/ls normally. The normal write, folder, read, commit and shell policies apply.",
    "- When the row is done, stop with a short summary of what changed, the files touched, and the checks you ran. The parent verifies and accepts; do not claim acceptance.",
  ].join("\n");
}

export interface OrchestratorChildKickoffInput {
  context: OrchestratorChildContext;
  row: FrozenTodoRow;
  /** Concrete failure from the previous attempt, for a repair round. */
  repair?: string;
}

const MAX_KICKOFF_CHARS = 12_000;

function bound(text: string, max = MAX_KICKOFF_CHARS): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n… (truncated)`;
}

/**
 * The durable first user prompt. It carries the row and nothing from the parent
 * conversation, so the child cannot drift into orchestrating the run.
 */
export function buildOrchestratorChildKickoff(
  input: OrchestratorChildKickoffInput,
): string {
  const { context, row } = input;
  const checks = row.acceptanceChecks.length
    ? row.acceptanceChecks.map((check, i) => `${i + 1}. ${check}`).join("\n")
    : "(none — the parent uses the diff-presence gate)";
  const files = row.expectedFiles.length
    ? row.expectedFiles.map((file) => `- ${file}`).join("\n")
    : "(not specified)";
  const workspace = context.workspace
    ? [
        "## Workspace",
        `Root: ${context.workspace.root} (id ${context.workspace.id})`,
        "Run roots: " +
          context.workspace.roots
            .map((root) => `${root.id}=${root.root}${root.primary ? " (primary)" : ""}`)
            .join(", "),
        "Other roots follow the normal folder/write policy.",
        "",
      ].join("\n")
    : "";
  const repair = input.repair?.trim()
    ? [
        "",
        "## Repair round",
        "The previous attempt did not satisfy the parent's verification:",
        input.repair.trim().slice(0, 4_000),
        "",
        "Fix the concrete failure, then finish with a short summary. Do not start over unless the failure requires it.",
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
      row.label ? `[${row.label}] ${row.text}` : row.text,
      "",
      "## Acceptance checks",
      checks,
      "",
      "## Expected files",
      files,
      "",
      workspace,
      "## Protocol",
      "1. Create your task-local TODO list now with `workflow_todo` — one item per real sub-step. Mutations are refused until it exists.",
      "2. Work the list in order. Mark a step completed immediately; keep one in progress.",
      "3. Run the acceptance checks you can run locally.",
      "4. Stop and answer with a concise summary: what changed, files touched, checks run, anything the parent must know.",
      "",
      "Do not orchestrate, do not edit the parent run, do not ask the user to switch modes, and do not claim acceptance.",
      repair,
    ].join("\n"),
  );
}
