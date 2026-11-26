/**
 * Workflow Extension — Orchestrator mission context.
 *
 * The mode, the model role and the mission are three separate facts. Selecting
 * Orchestrator changes the badge, model and tools, so the mission must state
 * exactly how work runs: the parent reads the approved plan, binds rows with
 * `orchestrator_start`, and dispatches one in-process Build child per row. The
 * child owns its verification; the parent reads the report, marks the row done
 * through `workflow_todo` and dispatches the next one.
 *
 * This module is deliberately pure: the extension supplies bounded live state,
 * and tests assert the guarantees without a model or a terminal.
 */

import type { OrchestratorRunPhase } from "./orchestrator-run.ts";

export const ORCHESTRATOR_CONTEXT_ENTRY = "workflow-orchestrator-context";
export const ORCHESTRATOR_MISSION_VERSION = 7 as const;

/** `unbound` means no run is bound yet; preparation is still available. */
export type OrchestratorPhase = OrchestratorRunPhase | "unbound";

export interface OrchestratorMissionState {
  phase: OrchestratorPhase;
  runId?: string;
  sourceLabel?: string;
  nextAction?: string;
  pendingDecision?: string;
  /** Rows the TODO list reports done, and the run's total rows. */
  taskCounts?: { done: number; total: number };
  workspaces?: string;
}

function phaseLine(state: OrchestratorMissionState): string {
  const parts: string[] = [`State: ${state.phase}`];
  if (state.runId) parts.push(`run ${state.runId}`);
  if (state.sourceLabel) parts.push(`source ${state.sourceLabel}`);
  if (state.taskCounts) {
    parts.push(`${state.taskCounts.done}/${state.taskCounts.total} rows done`);
  }
  return parts.join(" · ");
}

function nextLine(state: OrchestratorMissionState): string {
  if (state.nextAction) return `Next action: ${state.nextAction}`;
  switch (state.phase) {
    case "unbound":
      return "Next action: when the user agrees, call orchestrator_start with one step per plan row and the workspaces the plan declares.";
    case "idle":
      return "Next action: read the current row's report, mark it done (or retry it with an amended instruction), then dispatch the next pending row.";
    case "running":
      return "Next action: end your turn; the child's report wakes you (do not poll).";
    case "paused":
      return "Next action: /orchestrator resume continues a warm paused child; otherwise orchestrator_retry re-dispatches the row with an amended instruction.";
    case "interrupted":
      return "Next action: explain the blocker, then orchestrator_retry re-dispatches the stored row instruction with your amendment.";
    case "cancelled":
      return "Next action: the run was cancelled — answer the user. When the user asks for new work, call orchestrator_start with the new steps; a cancelled run is replaced, never revived, and its unfinished rows are not carried over.";
    case "completed":
      return "Next action: the run is complete — answer the user. When the user asks for new work, call orchestrator_start with the new steps; a completed run is replaced, never revived.";
    default:
      return "Next action: inspect the run with orchestrator_status.";
  }
}

/**
 * Builds the message injected for an Orchestrator turn.
 *
 * The text is written in the second person because it is model-facing. It
 * never says "you are in Plan mode" and never recommends `/build` for ordinary
 * orchestration work.
 */
export function buildOrchestratorMission(state: OrchestratorMissionState): string {
  const lines = [
    `[ORCHESTRATOR MODE ACTIVE — mission v${ORCHESTRATOR_MISSION_VERSION}]`,
    "You are the Orchestrator PARENT for this session. You are not in Plan mode and you are not the Builder.",
    "",
    "Mission:",
    "1. Read the approved plan (or the user's agreed steps) and decide the row list. One row is one repository root and one coherent change.",
    "2. Call orchestrator_start with `steps` — a string, or {text, workspace} for a non-primary root — and `workspaces` when the plan declares more than one root. The extension validates and resolves the roots; it does not compile the plan.",
    "3. Dispatch one row at a time with orchestrator_dispatch. It launches an in-process Build child with that row's root as cwd; no window or tab is opened.",
    "4. When the child settles, its report wakes you. Read `Status:` and `Suggested:` first: they say whether the blocker is outside the row (a policy refusal such as workflow.commitPolicy: never, or an action only the user can take) or inside it (failing checks, missing code, unfinished work).",
    "5. Run the plan's `## Verification` once with ordinary bash before the last row is marked done. Show the real command and its output; there is no hidden gate.",
    "6. Never edit the plan file. Cross-repo work is multiple rows, never one row touching two roots.",
    "",
    "Blocker routing (the report's `Suggested:` line implements this):",
    "- External / out of scope: do not re-dispatch. The child has already been released when you read its report; if it is still live (starting/running/paused), call orchestrator_abort first. Mark the row done with workflow_todo and carry the reason and the child's status into your final report.",
    "- Internal / in scope: retry the SAME row with orchestrator_retry and amended `instructions` that name the concrete blocker and what remains. Do not start over.",
    "",
    "After orchestrator_dispatch, end your turn. The report is steered into your next step; do not poll orchestrator_status while the child works. Use orchestrator_status after a reload or when a report is unclear.",
    "Use orchestrator_abort only for a live child that must stop (it preserves the last report and leaves the row retryable).",
    "",
    "Reporting: when the run ends, your final message must list each row's outcome (done / done with a policy-blocked step and why / retried / aborted). Never omit an unresolved deviation.",
    "",
    "Work entry (do this instead of changing mode):",
    "- When the user agrees, call orchestrator_start. Pass planPath for an approved plan, or title + steps for a standalone run.",
    "- Use orchestrator_status to inspect the run; /orchestrator inspect shows a row's instruction and last report.",
    "- orchestrator_retry re-dispatches the current or named row; pass `instructions` to amend it. It never accepts a row.",
    "- orchestrator_abort stops a live child. It never accepts a row and never rewrites an existing report.",
    "",
    "Interaction:",
    "- User prompts while a child runs are forwarded to that child. Do not answer them yourself and do not ask the user to switch modes.",
    "- A terminal run never blocks a prompt; the parent answers and may start a replacement run.",
    "- The child interaction surface is command-only: /orchestrator pause, resume, abort, view, inspect.",
    "- /profile and /role switch the live Build child in place; the next child always launches on the same effective model.",
    "",
    "Permissions and limits:",
    "- You have full Build permissions, but while a child is starting, running or settling the extension refuses your edits, writes and mutating shell commands: the child owns the worktree. Wait for its report; call orchestrator_abort only if it must stop.",
    "- The approved plan is immutable by convention. Never edit the plan file.",
    "- Folder, read, write, commit and shell policies still apply exactly as they do in Build.",
    "- You trust the child's report; you do not re-run its checks. Mark a row done only after reading the report.",
    "",
    ...(state.workspaces ? [`Workspace roots: ${state.workspaces}`] : []),
    phaseLine(state),
    nextLine(state),
  ];
  if (state.pendingDecision && state.pendingDecision !== "none") {
    lines.push(`Pending decision: ${state.pendingDecision}`);
  }
  return lines.join("\n");
}

/**
 * True for the owned context entries this mode injects. Used to drop stale
 * projections without touching genuine user content that merely quotes them.
 */
export function isOrchestratorContextEntry(message: unknown): boolean {
  if (!message || typeof message !== "object") return false;
  const record = message as Record<string, unknown>;
  return record.customType === ORCHESTRATOR_CONTEXT_ENTRY;
}
