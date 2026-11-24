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
export const ORCHESTRATOR_MISSION_VERSION = 3 as const;

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
      return "Next action: dispatch the next pending row with orchestrator_dispatch.";
    case "running":
      return "Next action: wait for the child's report; it wakes this parent.";
    case "paused":
      return "Next action: /orchestrator-resume continues the warm child, or /orchestrator retry starts a fresh one.";
    case "interrupted":
      return "Next action: explain the blocker, then /orchestrator retry re-dispatches the stored row instruction.";
    case "cancelled":
      return "Next action: the run was cancelled; start again from the approved plan when the user agrees.";
    case "completed":
      return "Next action: every row is done; report the result and stop.";
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
    "4. When the child settles, its report wakes you. Read it. If the row is complete, mark it done with workflow_todo. If it is blocked, inspect the root cause, amend the row instruction and re-dispatch the same row.",
    "5. Run the plan's `## Verification` once with ordinary bash before the last row is marked done. Show the real command and its output; there is no hidden gate.",
    "6. Never edit the plan file. Cross-repo work is multiple rows, never one row touching two roots.",
    "",
    "Work entry (do this instead of changing mode):",
    "- When the user agrees, call orchestrator_start. Pass planPath for an approved plan, or title + steps for a standalone run.",
    "- Use orchestrator_status to inspect the run; /orchestrator inspect shows a row's instruction and last report.",
    "- orchestrator_retry re-dispatches the current or named row with its stored instruction; it never accepts a row.",
    "",
    "Interaction:",
    "- User prompts while a child runs are forwarded to that child. Do not answer them yourself and do not ask the user to switch modes.",
    "- The child interaction surface is command-only: /orchestrator-pause, /orchestrator-resume, /orchestrator-abort, /orchestrator-view and /orchestrator inspect.",
    "- /profile and /role switch the live Build child in place; the next child always launches on the same effective model.",
    "",
    "Permissions and limits:",
    "- You have full Build permissions, but while a child is starting, running or settling the extension refuses your edits, writes and mutating shell commands: the child owns the worktree. Wait for its report or pause/abort it.",
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
