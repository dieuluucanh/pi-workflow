/**
 * Workflow Extension — pure composer projection for an in-process Build child.
 *
 * The child is a separate AgentSession and its UI bridge deliberately no-ops
 * every chrome surface, so the parent must project the child's activity onto the
 * one composer both Parent and Child views share. This module is deliberately
 * pure: it decides text and Esc ownership only. The editor owns rendering and
 * the host wiring owns lifecycle.
 *
 * What the border may say, and why it is narrow:
 *
 *   - the phase word (`Working`, `Paused`, `Verifying`, …) and the controls;
 *   - NOT the latest tool/command. `lastTool` is a tool name plus an excerpt of
 *     its key argument (up to 100 chars for `bash`/`edit`), which pushed the
 *     line to ~190 columns and displaced the state on a normal terminal. The
 *     tool stream already lives in the child transcript band;
 *   - NOT the frozen-row counter (`Builder n/m`) or the child's own `n/m
 *     todos`. The pinned TODO pane owns progress, and the footer
 *     (`workflow-orchestrator`) owns the telemetry (model, context, tokens,
 *     elapsed).
 *
 * The accepted input type is narrowed to the three fields this projection uses,
 * so re-introducing either echo requires widening it on purpose.
 *
 * Every line names the control the user can actually run in that phase. A warm
 * pause is resumed with `/orchestrator resume`; a disposed child needs
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
  /**
   * Live child snapshot; `undefined` when no child owns execution.
   *
   * Deliberately narrow: phase plus the two transient flags the copy needs.
   * The border must not have access to the tool label or the row counters.
   */
  child?:
    | (Pick<OrchestratorChildState, "phase" | "pausePending" | "retrying"> & {
        lastError?: string;
      })
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

const PAUSE_CMD = "/orchestrator pause";
const PAUSE_HINT_ESC = "ESC or /orchestrator pause";
const PAUSE_COMPACT_ESC = "Working · ESC to pause";
const PAUSE_COMPACT_CMD = "Working · /orchestrator pause";
const RESUME_CMD = "/orchestrator resume to continue";
const ABORT_CMD = "/orchestrator abort to stop";

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
  const pauseCompact = escAvailable ? PAUSE_COMPACT_ESC : PAUSE_COMPACT_CMD;

  if (child && childLive(phase)) {
    if (phase === "starting") {
      return {
        line: `Starting… · ${pauseHint} · ${ABORT_CMD}`,
        compact: "Starting…",
        busy: true,
        paused: false,
        esc: orchestratorEscAction(input),
      };
    }
    if (phase === "running") {
      if (input.awaitingDialog === true) {
        return {
          line: `Waiting · answer the dialog · ${ABORT_CMD}`,
          compact: "Waiting · answer the dialog",
          busy: true,
          paused: false,
          esc: "swallow",
        };
      }
      if (child.retrying === true) {
        return {
          line: `Working · retrying… · ${pauseHint} · ${ABORT_CMD}`,
          compact: "Working · retrying…",
          busy: true,
          paused: false,
          esc: "pause",
        };
      }
      return {
        line: `Working · ${pauseHint} · ${ABORT_CMD}`,
        compact: pauseCompact,
        busy: true,
        paused: false,
        esc: "pause",
      };
    }
    if (phase === "paused") {
      if (child.pausePending === true) {
        return {
          line: `Pausing… · ${ABORT_CMD}`,
          compact: "Pausing…",
          busy: false,
          paused: false,
          esc: "swallow",
        };
      }
      return {
        line: `Paused · ${RESUME_CMD} · ${ABORT_CMD}`,
        compact: "Paused · /orchestrator resume",
        busy: false,
        paused: true,
        esc: "swallow",
      };
    }
    // settling / verifying
    return {
      line: `Verifying · ${ABORT_CMD}`,
      compact: "Verifying",
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
