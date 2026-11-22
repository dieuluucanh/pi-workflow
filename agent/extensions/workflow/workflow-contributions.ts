/**
 * Workflow Extension — Workflow's own contributions to the generic contract.
 *
 * The generic protocol (`host-contributions.ts`) knows nothing about Plan,
 * Build, Review or TODOs. This module is the only place that maps Workflow's
 * state onto it, so a host can render Workflow's controls natively without
 * parsing glyphs or knowing `/review-pause`.
 *
 * Terminal Pi keeps its existing status/widgets; this is additive. A host that
 * does not speak the contract gets the publisher's fallback (step 7).
 */

import type { Contribution } from "./host-contributions.ts";
import type { WorkflowMode } from "./workflow-mode.ts";

export const WORKFLOW_OWNER_ID = "@dieulc/workflow";

/** The effective todo-panel presentation, when the extension knows it. */
export type WorkflowPanelState = "expanded" | "collapsed" | "hidden";

export interface WorkflowContributionInput {
  mode: WorkflowMode;
  done: number;
  total: number;
  stale?: boolean;
  /**
   * Whether the registered `/workflow-cycle` command exists in this session.
   * The composer's mode label references that action, so an unavailable
   * command must publish a disabled target rather than a dead button.
   */
  cycleAvailable?: boolean;
  /** Why cycling is refused right now (e.g. a Review owns the turn). */
  cycleDisabledReason?: string;
  /** Effective todo-panel state; display-only, never inferred by the host. */
  panelState?: WorkflowPanelState | null;
  /** Live review phase; `idle` means no review row. */
  reviewPhase?: "idle" | "running" | "paused" | "handoff" | "transition" | null;
  /** A pending handoff that is not review-owned. */
  handoffPending?: boolean;
  /**
   * Active handoff stage. `approved` is a real, resumable state: the plan is
   * approved and only the execution choice is missing.
   */
  handoffStage?: "review-pending" | "approved" | "routing";
  /** Panel/commit hints, optional (display only). */
  commitMode?: string;
  writeMode?: string | null;
  /**
   * Bound orchestration state. Display/diagnostics only: a contribution can
   * never approve, dispatch or bypass the runtime's eligibility checks.
   */
  orchestration?: {
    phase: string;
    blockedReason?: string;
    nextTaskId?: string;
    /** Whether a visible child host can be reached right now. */
    hostReady?: boolean;
    hostLabel?: string;
    hostReason?: string;
  };
}

/** Human-readable panel state for the generic progress detail (display only). */
export function panelStateLabel(state: WorkflowPanelState): string {
  return state.charAt(0).toUpperCase() + state.slice(1);
}

/**
 * Builds Workflow's contribution set. Order values are fixed so a mode badge
 * stays left of progress and actions.
 */
export function buildWorkflowContributions(
  input: WorkflowContributionInput,
): Contribution[] {
  const out: Contribution[] = [];
  const phase = input.reviewPhase ?? "idle";
  const reviewing = phase !== "idle";
  const done = Math.max(0, Math.trunc(input.done));
  const total = Math.max(0, Math.trunc(input.total));

  /**
   * One generic cycle action per snapshot. The current-mode label references it
   * by id, so a host can render the mode itself as the control instead of a row
   * of Plan/Build buttons. The command walks the same guarded, serialized ring
   * as Tab; this mapper never computes the next mode and never grants an
   * execution effect.
   */
  const pushCycleAction = (disabledReason?: string): string => {
    const reason =
      disabledReason ??
      (input.cycleAvailable === false ? "mode cycle is unavailable in this session" : undefined);
    out.push({
      id: "mode-cycle",
      kind: "action",
      slot: "action",
      label: "Cycle mode",
      tone: "neutral",
      order: 20,
      command: { name: "workflow-cycle" },
      enabled: reason === undefined,
      ...(reason === undefined ? {} : { disabledReason: reason }),
    });
    return "mode-cycle";
  };

  if (reviewing) {
    const base =
      phase === "paused"
        ? "🔍 review — paused"
        : phase === "handoff"
          ? "🔍 review — awaiting decision"
          : "🔍 review";
    out.push({
      id: "mode",
      kind: "mode",
      slot: "mode",
      label: base,
      tone: phase === "paused" ? "warning" : "accent",
      order: 0,
      detail:
        phase === "handoff"
          ? "The plan is waiting for your decision in the review tab."
          : "An independent reviewer owns this turn.",
      actionRef: pushCycleAction(input.cycleDisabledReason ?? "a review owns this turn"),
      actions: [],
    });
    out.push({
      id: "review",
      kind: "action",
      slot: "action",
      label: phase === "paused" ? "Resume review" : "Review status",
      tone: "info",
      order: 20,
      command: { name: phase === "paused" ? "review-resume" : "review-status" },
      enabled: phase !== "handoff",
      ...(phase === "handoff" ? { disabledReason: "decide in the review tab" } : {}),
    });
    out.push({
      id: "input",
      kind: "input",
      slot: "input",
      availability: "locked",
      tone: "warning",
      order: 40,
      reason: "A reviewer owns this turn; pause or stop it to prompt the plan agent.",
    });
    if (phase === "running" || phase === "paused") {
      out.push({
        id: "review-stop",
        kind: "action",
        slot: "action",
        label: "Stop review",
        tone: "warning",
        order: 30,
        command: { name: "review-abort" },
        enabled: true,
      });
    }
    return out;
  }

  const modeLabel =
    input.mode === "build"
      ? "▶ build"
      : input.mode === "plan"
        ? "⏸ plan"
        : input.mode === "orchestrator"
          ? "🧭 orchestrator"
          : "◦ default";
  out.push({
    id: "mode",
    kind: "mode",
    slot: "mode",
    label: modeLabel,
    tone:
      input.mode === "build"
        ? "accent"
        : input.mode === "plan"
          ? "warning"
          : input.mode === "orchestrator"
            ? "info"
            : "neutral",
    order: 0,
    detail:
      input.handoffStage === "approved"
        ? "plan approved — execution choice pending"
        : input.handoffStage === "routing"
          ? "applying the chosen execution"
          : input.handoffPending || input.handoffStage === "review-pending"
            ? "handoff pending"
            : undefined,
    actionRef: pushCycleAction(input.cycleDisabledReason),
    actions: [],
  });

  out.push({
    id: "input",
    kind: "input",
    slot: "input",
    availability: "available",
    tone: "neutral",
    order: 5,
    reason: "Prompts go to the active workflow mode.",
  });

  if (input.handoffStage === "approved") {
    // The approval survives a cancelled execution choice; this is the explicit
    // resume. It can never execute by itself.
    out.push({
      id: "handoff-continue",
      kind: "action",
      slot: "action",
      label: "Choose execution",
      tone: "warning",
      order: 6,
      command: { name: "handoff", args: "continue" },
      enabled: true,
    });
  }

  if (total > 0) {
    out.push({
      id: "todos",
      kind: "progress",
      slot: "progress",
      label: "Todos",
      tone: "neutral",
      order: 10,
      done: Math.min(done, total),
      total,
      ...(input.stale ? { stale: true } : {}),
      ...(input.panelState ? { detail: panelStateLabel(input.panelState) } : {}),
      actions: [],
    });
  }

  if (total > 0) {
    const displayActions: Array<[string, string, string]> = [
      ["todos-auto", "Automatic", "auto"],
      ["todos-expand", "Show todos", "expand"],
      ["todos-collapse", "Collapse todos", "collapse"],
      ["todos-hide", "Hide todos", "hide"],
    ];
    for (const [id, label, args] of displayActions) {
      out.push({
        id,
        kind: "action",
        slot: "action",
        label,
        tone: "neutral",
        order: 11,
        command: { name: "todos", args },
        enabled: true,
      });
    }
    // A computed toggle keeps Ctrl+Alt+O equivalent without the host having to
    // infer the panel's state from markup or status prose.
    out.push({
      id: "todos-toggle",
      kind: "action",
      slot: "action",
      label: input.panelState === "expanded" ? "Collapse panel" : "Expand panel",
      tone: "neutral",
      order: 12,
      command: {
        name: "todos",
        args: input.panelState === "expanded" ? "collapse" : "expand",
      },
      enabled: true,
    });
  }

  if (input.mode === "orchestrator" && input.orchestration) {
    const run = input.orchestration;
    out.push({
      id: "orchestrator-run",
      kind: "status",
      slot: "status",
      text: `run ${run.phase}${run.nextTaskId ? ` · next ${run.nextTaskId}` : ""}`,
      tone: "info",
      order: 41,
    });
    if (run.blockedReason) {
      out.push({
        id: "orchestrator-blocked",
        kind: "status",
        slot: "status",
        text: `blocked: ${run.blockedReason.slice(0, 160)}`,
        tone: "warning",
        order: 42,
      });
    }
    if (run.hostReady === false) {
      out.push({
        id: "orchestrator-host",
        kind: "status",
        slot: "status",
        text: `${run.hostLabel ?? "child host"} unavailable: ${(run.hostReason ?? "no visible child host").slice(0, 160)}`,
        tone: "warning",
        order: 43,
      });
      // An explicit escape, never an automatic fallback: the user chooses.
      out.push({
        id: "orchestrator-direct-build",
        kind: "action",
        slot: "action",
        label: "Use direct Build",
        description: "Leave coordination and continue in this session as Build. Nothing is dispatched.",
        tone: "warning",
        command: { name: "build" },
        enabled: true,
        order: 44,
      });
    }
  }

  if (input.commitMode || input.writeMode) {
    const parts = [
      input.commitMode ? `commits:${input.commitMode}` : "",
      input.writeMode ? `writes:${input.writeMode}` : "",
    ].filter(Boolean);
    out.push({
      id: "policy",
      kind: "status",
      slot: "status",
      text: parts.join(" · "),
      tone: "neutral",
      order: 40,
    });
  }

  return out;
}
