/**
 * Workflow Extension — Orchestrator mission context.
 *
 * The mode, the model role and the mission are three separate facts. Selecting
 * Orchestrator changes the badge, model and tools, so the mission must state
 * exactly how work runs: one in-process Build child per frozen row, automatic
 * acceptance, and a parent model that only handles blockers, status and
 * recovery.
 *
 * This module is deliberately pure: the extension supplies bounded live state,
 * and tests assert the guarantees without a model or a terminal.
 */

export const ORCHESTRATOR_CONTEXT_ENTRY = "workflow-orchestrator-context";
export const ORCHESTRATOR_MISSION_VERSION = 2 as const;

export type OrchestratorPhase =
  | "unbound"
  | "draft"
  | "awaiting_approval"
  | "ready"
  | "dispatching"
  | "building"
  | "verifying"
  | "waiting_user"
  | "paused"
  | "blocked"
  | "interrupted"
  | "failed"
  | "completed"
  | "cancelled";

export interface OrchestratorMissionState {
  /** `unbound` means no run is bound yet; preparation is still available. */
  phase: OrchestratorPhase;
  runId?: string;
  sourceLabel?: string;
  nextAction?: string;
  pendingDecision?: string;
  taskCounts?: { accepted: number; total: number };
  workspaces?: string;
}

function phaseLine(state: OrchestratorMissionState): string {
  const parts: string[] = [`State: ${state.phase}`];
  if (state.runId) parts.push(`run ${state.runId}`);
  if (state.sourceLabel) parts.push(`source ${state.sourceLabel}`);
  if (state.taskCounts) {
    parts.push(`${state.taskCounts.accepted}/${state.taskCounts.total} tasks accepted`);
  }
  return parts.join(" · ");
}

function nextLine(state: OrchestratorMissionState): string {
  if (state.nextAction) return `Next action: ${state.nextAction}`;
  if (state.phase === "unbound") {
    return "Next action: when the user agrees, call orchestrator_start with the approved planPath or the explicit standalone steps.";
  }
  if (state.phase === "awaiting_approval") {
    return "Next action: the plan is frozen but not started; call orchestrator_start or inspect the run with orchestrator_status.";
  }
  if (state.phase === "draft") {
    return "Next action: call orchestrator_start with the approved plan or the agreed steps.";
  }
  if (state.phase === "dispatching" || state.phase === "building") {
    return "Next action: wait for the child to settle; the extension verifies, accepts and starts the next row automatically.";
  }
  if (state.phase === "verifying") {
    return "Next action: wait for the automatic verification; do not verify or accept manually.";
  }
  if (state.phase === "waiting_user") {
    return "Next action: wait for the user's answer; do not dispatch or claim completion.";
  }
  if (state.phase === "paused") {
    return "Next action: /orchestrator-resume continues the warm child, or /orchestrator-retry starts a fresh one.";
  }
  if (state.phase === "blocked") {
    return "Next action: explain the blocker with orchestrator_status, then /orchestrator retry when the user agrees.";
  }
  return "Next action: inspect the run state with orchestrator_status.";
}

/**
 * Builds the message injected for an Orchestrator turn.
 *
 * The text is written in the second person because it is model-facing. It
 * never says "you are in Plan mode" and never recommends `/build` for ordinary
 * orchestration work: decomposition and execution belong to the extension.
 */
export function buildOrchestratorMission(state: OrchestratorMissionState): string {
  const lines = [
    `[ORCHESTRATOR MODE ACTIVE — mission v${ORCHESTRATOR_MISSION_VERSION}]`,
    "You are the Orchestrator PARENT for this session. You are not in Plan mode and you are not the Builder.",
    "",
    "Mission:",
    "1. Understand the work the user asked for — the current discussion/tasks or an explicitly referenced plan.",
    "2. Read and explore enough to make the work executable; ask only necessary clarifications.",
    "3. When the user agrees, freeze the work once: an approved plan (one row per plan step) or an explicitly agreed standalone step list.",
    "4. Call orchestrator_start. The extension freezes the TODO list and runs one in-process Build child per frozen row; no window or tab is opened.",
    "5. Children advance automatically: on a natural settle the extension reports, runs the row checks plus the attributable diff, accepts on pass and dispatches the next row.",
    "6. Every declared workspace root is measured; a frozen row may bind its work with `Workspaces:` and its first alias becomes the child cwd.",
    "6. A failed check starts a bounded repair on the same attempt. Only exhaustion, a provider failure or the user pauses the run and wakes you.",
    "",
    "Work entry (do this instead of changing mode):",
    "- When the user agrees, call orchestrator_start. Pass planPath for an approved plan, or title + steps for a standalone run.",
    "- Do not use any prepare/propose tool: the frozen list is created directly and never re-baselined.",
    "- Use orchestrator_status to inspect; use orchestrator_retry only to recover a blocked or repaired row.",
    "",
    "Interaction:",
    "- User prompts while a child runs are forwarded to that child. Do not answer them yourself and do not ask the user to switch modes.",
    "- The child interaction surface is command-only: /orchestrator-pause, /orchestrator-resume, /orchestrator-abort, /orchestrator-view and /orchestrator inspect.",
    "- /profile changes only the next child; the live child keeps its model.",
    "",
    "Permissions and limits:",
    "- You may inspect, read, run read-only/verify commands, start, retry, pause, resume, abort and stop.",
    "- You do NOT edit project sources or mutate the workspace yourself. That is the Build child's job.",
    "- Never ask the user to switch to /build in order to perform orchestration work. /build leaves this mode; only the user chooses that deliberately.",
    "- Never claim work is complete because a child reported it, a TODO is checked, or a command exited zero. Acceptance is mechanical (checks + attributable diff).",
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
