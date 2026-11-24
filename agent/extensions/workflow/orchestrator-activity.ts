/**
 * Workflow Extension — pure composer projection for an in-process Build child.
 *
 * The child is a separate AgentSession and its UI bridge deliberately no-ops
 * every chrome surface, so the parent must project the child's activity onto the
 * one composer both Parent and Child views share. This module is deliberately
 * pure: it decides text and Esc ownership only. The editor owns rendering and
 * the host wiring owns lifecycle.
 *
 * Every line names the control the user can actually run in that phase. A warm
 * pause is resumed with `/orchestrator-resume`; a disposed child needs
 * `/orchestrator retry`. `/orchestrator-retry` does not exist.
 */

import type {
  OrchestratorChildPhase,
  OrchestratorChildState,
} from "./orchestrator-child-controller.ts";

export type OrchestratorEscAction = "pause" | "swallow" | "pass";

export interface OrchestratorActivityInput {
  /** Durable run phase, when a run is bound. */
  runPhase?: string;
  blockedReason?: string;
  /** Live child snapshot; `undefined` when no child owns execution. */
  child?:
    | (Pick<
        OrchestratorChildState,
        | "phase"
        | "ref"
        | "total"
        | "lastTool"
        | "taskId"
        | "attemptId"
        | "pausePending"
        | "retrying"
      > & { lastError?: string })
    | undefined;
  /** A forwarded child permission dialog is waiting for the user. */
  awaitingDialog?: boolean;
  /** The focused Workflow editor can route Esc. */
  escAvailable?: boolean;
  /**
   * The snapshot belongs to the current run/attempt. A stale callback from a
   * previous child must never present Working.
   */
  owned?: boolean;
}

export interface OrchestratorActivity {
  /** Wide, unstyled border line (theme applied by the editor). */
  line: string;
  /** Hint-free border line for narrow terminals. */
  compact: string;
  /** True while the child is doing work (drives the spinner). */
  busy: boolean;
  /** True only for a warm paused child. */
  paused: boolean;
  /** How the focused composer must treat Esc. */
  esc: OrchestratorEscAction;
}

const PAUSE_CMD = "/orchestrator-pause to pause";
const PAUSE_HINT_ESC = "ESC or /orchestrator-pause to pause";
const RESUME_CMD = "/orchestrator-resume to continue";
const ABORT_CMD = "/orchestrator-abort to stop";

function builderName(
  child: NonNullable<OrchestratorActivityInput["child"]>,
): string {
  return child.ref && child.total
    ? `Builder ${child.ref}/${child.total}`
    : "Builder";
}

function childLive(phase: OrchestratorChildPhase | undefined): boolean {
  return (
    phase === "starting" ||
    phase === "running" ||
    phase === "paused" ||
    phase === "settling"
  );
}

/**
 * Decide what Esc means for the focused composer.
 *
 * The rule that matters most: once the child owns execution, Esc never falls
 * through to the host. A second Esc while pausing/paused/swallowing is
 * consumed without another pause request and, above all, without an abort.
 */
export function orchestratorEscAction(
  input: OrchestratorActivityInput,
): OrchestratorEscAction {
  if (input.owned === false) return "pass";
  const phase = input.child?.phase;
  if (!childLive(phase)) return "pass";
  if (phase === "starting" || phase === "running") {
    if (input.awaitingDialog === true) return "swallow";
    return "pause";
  }
  // paused (including the pause-pending window) and settling both consume Esc:
  // a repeat press must not become an implicit resume or abort.
  return "swallow";
}

/**
 * Project the current run/child onto the composer.
 *
 * Returns `undefined` when no Orchestrator surface should own the composer:
 * no bound run, no live child, a completed/cancelled run, or a stale snapshot.
 */
export function orchestratorActivity(
  input: OrchestratorActivityInput,
): OrchestratorActivity | undefined {
  if (input.owned === false) return undefined;
  const child = input.child;
  const phase = child?.phase;
  const escAvailable = input.escAvailable === true;
  const pauseHint = escAvailable ? PAUSE_HINT_ESC : PAUSE_CMD;

  if (child && childLive(phase)) {
    const name = builderName(child);
    if (phase === "starting") {
      return {
        line: `Starting ${name}… · ${pauseHint} · ${ABORT_CMD}`,
        compact: `Starting ${name}…`,
        busy: true,
        paused: false,
        esc: orchestratorEscAction(input),
      };
    }
    if (phase === "running") {
      const retry = child.retrying === true;
      if (input.awaitingDialog === true) {
        return {
          line: `Waiting · ${name} · answer the dialog · ${ABORT_CMD}`,
          compact: `Waiting · ${name}`,
          busy: true,
          paused: false,
          esc: "swallow",
        };
      }
      const detail = retry
        ? "retrying…"
        : child.lastTool
          ? child.lastTool
          : "";
      return {
        line: `Working · ${name}${detail ? ` · ${detail}` : ""} · ${pauseHint} · ${ABORT_CMD}`,
        compact: `Working · ${name}${detail ? ` · ${detail}` : ""}`,
        busy: true,
        paused: false,
        esc: "pause",
      };
    }
    if (phase === "paused") {
      if (child.pausePending === true) {
        return {
          line: `Pausing ${name}… · ${ABORT_CMD}`,
          compact: `Pausing ${name}…`,
          busy: false,
          paused: false,
          esc: "swallow",
        };
      }
      return {
        line: `Paused · ${name} · ${RESUME_CMD} · ${ABORT_CMD}`,
        compact: `Paused · ${name}`,
        busy: false,
        paused: true,
        esc: "swallow",
      };
    }
    // settling / verifying
    return {
      line: `Verifying · ${name} · ${ABORT_CMD}`,
      compact: `Verifying · ${name}`,
      busy: false,
      paused: false,
      esc: "swallow",
    };
  }

  // No live child. Recovery states are guidance, not a Working claim.
  if (input.blockedReason) {
    const reason = input.blockedReason.replace(/\s+/g, " ").trim().slice(0, 120);
    return {
      line: `Run blocked${reason ? ` — ${reason}` : ""} · /orchestrator retry starts a fresh child · /orchestrator status`,
      compact: `Run blocked · /orchestrator retry`,
      busy: false,
      paused: false,
      esc: "pass",
    };
  }
  if (input.runPhase === "paused") {
    return {
      line: `Run paused — /orchestrator retry starts a fresh child · /orchestrator status`,
      compact: `Run paused · /orchestrator retry`,
      busy: false,
      paused: false,
      esc: "pass",
    };
  }
  return undefined;
}
