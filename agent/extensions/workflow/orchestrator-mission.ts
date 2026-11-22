/**
 * Workflow Extension — Orchestrator mission context (plan step 4).
 *
 * The mode, the model role and the mission are three separate facts. Selecting
 * Orchestrator used to change the badge, model and tools but inject no mission,
 * so the model inferred "read-only" from the Plan-shaped tool policy and refused
 * its own job with "switch to /build".
 *
 * This module is the single authoritative mission text. It is deliberately
 * pure: the extension supplies bounded live state, and tests assert the exact
 * guarantees (identity, work entry, approval, delegation, no Plan/Builder
 * self-identification) without a model or a terminal.
 */

export const ORCHESTRATOR_CONTEXT_ENTRY = "workflow-orchestrator-context";
export const ORCHESTRATOR_MISSION_VERSION = 1 as const;

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
  /** Host/launcher readiness, when known. */
  host?: { ready: boolean; label: string; reason?: string };
  /** True only when this session owns the parent scheduler. */
  coordinator: boolean;
  /** A preview exists for the current roadmap revision. */
  hasBreakdown?: boolean;
  /** A worker must never reach this builder, but the guard is explicit. */
  managedWorker?: boolean;
  quarantined?: boolean;
  /** The breakdown approval is separate from plan approval. */
  breakdownApproved?: boolean;
  taskCounts?: { accepted: number; total: number };
}

const MAX_STATE_LINE = 240;

function bounded(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.replace(/\s+/g, " ").trim();
  return text.length === 0 ? undefined : text.slice(0, MAX_STATE_LINE);
}

function phaseLine(state: OrchestratorMissionState): string {
  if (state.quarantined) {
    return "State: QUARANTINED managed session — inspect and reconcile only. Do not orchestrate or mutate.";
  }
  if (state.managedWorker) {
    return "State: managed Build CHILD — this session is not the parent. Finish the assignment and report.";
  }
  if (!state.coordinator) {
    return "State: this session is not the Orchestrator parent; orchestration tools are unavailable.";
  }
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
    return "Next action: wait for the child's fenced report, then verify it; do not dispatch a second task.";
  }
  if (state.phase === "verifying") {
    return "Next action: verify the candidate with orchestrator_verify and accept only evidence-backed results.";
  }
  if (state.phase === "waiting_user") {
    return "Next action: wait for the user's answer; do not dispatch or claim completion.";
  }
  if (state.phase === "ready") {
    return "Next action: dispatch or retry the next frozen row with orchestrator_retry, then wait for its report.";
  }
  return "Next action: inspect the run state with orchestrator_status.";
}

/**
 * Builds the message injected for an Orchestrator turn.
 *
 * The text is written in the second person because it is model-facing. It
 * never says "you are in Plan mode" and never recommends `/build` for ordinary
 * orchestration work: delegation is the intended remedy for the parent's
 * read-only project access.
 */
export function buildOrchestratorMission(state: OrchestratorMissionState): string {
  const host = state.host;
  let hostLine: string;
  if (!host) {
    hostLine =
      "Child host: not reported yet; a dispatch must fail closed with the real reason.";
  } else if (host.ready) {
    hostLine = `Child host: ${host.label} is ready.`;
  } else {
    const reason = host.reason ? ` (${bounded(host.reason)})` : "";
    hostLine = `Child host: ${host.label} is NOT ready${reason}. Do not claim a child was launched.`;
  }

  const lines = [
    `[ORCHESTRATOR MODE ACTIVE — mission v${ORCHESTRATOR_MISSION_VERSION}]`,
    "You are the Orchestrator PARENT for this session. You are not in Plan mode and you are not the Builder.",
    "",
    "Mission:",
    "1. Understand the work the user asked for — the current discussion/tasks or an explicitly referenced plan.",
    "2. Read and explore enough to make the work executable; ask only necessary clarifications.",
    "3. When the user agrees, freeze the work once: an approved plan (one row per plan step) or an explicitly agreed standalone step list.",
    "4. Call orchestrator_start. It creates the frozen TODO list and starts the first visible Build child; there is no second breakdown approval.",
    "5. Delegate each frozen row to a visible, ordinary Build child session in order.",
    "6. After the child settles and is fenced, independently verify its actual changes and the required checks.",
    "7. Accept only evidence-backed results; otherwise send a bounded scoped repair. Acceptance starts the next row.",
    "",
    "Work entry (do this instead of changing mode):",
    "- When the user agrees, call orchestrator_start. Pass planPath for an approved plan, or title + steps for a standalone run.",
    "- Do not use the legacy prepare/propose tools: the frozen list is created directly and never re-baselined.",
    "- The extension auto-dispatches the first row; use orchestrator_status and orchestrator_retry for recovery.",
    "",
    "Permissions and limits:",
    "- You may inspect, run read-only/verify commands, start, verify and accept.",
    "- You do NOT edit project sources or mutate the workspace yourself. That is the managed Build child's job.",
    "- Never ask the user to switch to /build in order to perform orchestration work. /build leaves this mode; only the user chooses that deliberately.",
    "- Never claim work is complete because a child reported it, a TODO is checked, or a command exited zero. Acceptance is evidence-backed.",
    "",
    hostLine,
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
