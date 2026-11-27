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

import type {
  Contribution,
  ContributionActionGroup,
} from "./host-contributions.ts";
import {
  MODE_PRESENTATION,
  modePresentation,
  type ModePresentation,
  type ModePresentationKey,
  type WorkflowMode,
} from "./workflow-mode.ts";
import type { ChildModelRef, ChildRuntimeStats } from "./child-stats.ts";
import {
  COMPOSER_CONTROL_KIND,
  COMPOSER_CONTROL_SLOT,
  COMPOSER_TRANSFORM_CONTRACT,
  type ComposerControlContribution,
  type ComposerControlIcon,
  type ComposerControlTone,
} from "./composer-transform.ts";

export const WORKFLOW_OWNER_ID = "@dieulc/workflow";

/** Inline working controls for the live Build child. */
const RUN_CONTROLS_GROUP: ContributionActionGroup = {
  id: "run-controls",
  label: "Run controls",
  order: 30,
  placement: "inline",
};

/**
 * Inline working controls for a live or paused Review round. The footer/status
 * line owns the phase detail; these are verbs only, and the handoff phase (a
 * decision in the review tab) publishes none of them.
 */
const REVIEW_CONTROLS_GROUP: ContributionActionGroup = {
  id: "review-controls",
  label: "Review controls",
  order: 30,
  placement: "inline",
};

/** The active TODO view/display menu; always after the run controls. */
function todosGroup(childPanel: boolean): ContributionActionGroup {
  return {
    id: "todos",
    label: childPanel ? "Child todos" : "Todos",
    order: 40,
    placement: "menu",
  };
}

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
  /**
   * The resolved mode command per mode, from the registration flags in
   * `index.ts`. A missing key means that command is not registered in this
   * session; the mapper then publishes a disabled action with a precise reason
   * instead of an enabled button the host cannot run.
   */
  modeCommands?: Partial<Record<ModePresentationKey, string>>;
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
    /** The live in-process Build child (no window/tab). */
    child?: {
      ref: string;
      total: number;
      phase: string;
      /** A pause request is still settling (the line says `pausing`). */
      pausePending?: boolean;
      /** Provider backoff is active (the line says `retrying`). */
      retrying?: boolean;
      model?: string;
      modelRef?: ChildModelRef;
      stats?: ChildRuntimeStats;
      thinking?: string;
      elapsedMs?: number;
      todoDone?: number;
      todoTotal?: number;
    };
    /** Which TODO panel the pinned widget shows; display-only. */
    view?: "auto" | "parent" | "child";
  };
  /**
   * Whether the child TODO list is the active pinned panel. The host cannot
   * infer this from `orchestration.view` alone because `auto` follows a live
   * or settled child. Display-only, exactly like `view`.
   */
  childPanelActive?: boolean;
  /**
   * Composer-transform publication state. `undefined` means the host did not
   * negotiate `composer-transform-v1`, so no composer-control is published and
   * the existing status/action fallback plus `/prompt` remain the surface.
   */
  composer?: WorkflowComposerInput;
}

/**
 * Everything Workflow publishes for the generic composer control. The host
 * resolves `actionRef`/`transformActionRef` from the current registry; this
 * mapper never hard-codes a host or Desktop-specific consumer.
 */
export interface WorkflowComposerInput {
  controlId: string;
  toggleActionId: string;
  transformActionId: string;
  label: string;
  description?: string;
  icon?: ComposerControlIcon;
  tone?: ComposerControlTone;
  order?: number;
  checked: boolean;
  enabled: boolean;
  disabledReason?: string;
  publicCommand: string;
  companionCommand: string;
  /** Same-owner action command names resolved by the host. */
  toggleCommand: string;
  transformCommand: string;
}

/**
 * Publishes the generic `composer-control`, plus the two same-owner actions its
 * references resolve to. The transform action invokes the public input command
 * with no args: operation transport never rides on contribution args.
 */
export function buildWorkflowComposerContributions(
  input: WorkflowComposerInput,
): Contribution[] {
  const enabled = input.enabled !== false;
  const reason = input.disabledReason;
  const control: ComposerControlContribution = {
    id: input.controlId,
    kind: COMPOSER_CONTROL_KIND,
    slot: COMPOSER_CONTROL_SLOT,
    tone: input.tone ?? "accent",
    order: input.order ?? 14,
    label: input.label,
    ...(input.description === undefined ? {} : { description: input.description }),
    ...(input.icon === undefined ? {} : { icon: input.icon }),
    checked: input.checked === true,
    enabled,
    ...(enabled || reason === undefined ? {} : { disabledReason: reason }),
    behavior: "one-shot-return",
    actionRef: input.toggleActionId,
    transformActionRef: input.transformActionId,
    operation: {
      contract: COMPOSER_TRANSFORM_CONTRACT,
      publicCommand: input.publicCommand,
      companionCommand: input.companionCommand,
    },
  };
  return [
    {
      id: input.toggleActionId,
      kind: "action",
      slot: "action",
      label: input.checked ? "Refinement armed" : "Refine prompt",
      tone: input.checked ? "accent" : "neutral",
      order: 13,
      command: { name: input.toggleCommand },
      enabled,
      ...(enabled || reason === undefined ? {} : { disabledReason: reason }),
    },
    {
      id: input.transformActionId,
      kind: "action",
      slot: "action",
      label: "Refine prompt",
      tone: "accent",
      order: 14,
      // No args: the host routes structured input through its typed
      // `composer.transform` method, never through a command string.
      command: { name: input.transformCommand },
      enabled,
      ...(enabled || reason === undefined ? {} : { disabledReason: reason }),
    },
    control,
  ];
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

  /**
   * One menu action and one presentation choice per mode. The choice is data
   * only: it references the same-owner action by id and carries no executable
   * command or enabled state of its own. The current mode wins with
   * `"current mode"`; otherwise a refused cycle (Review/handoff) locks every
   * remaining action with the same reason. A missing command is always
   * disabled, never an enabled dead button.
   */
  const pushModeMenu = (): void => {
    const missingCommandReason = (presentation: ModePresentation): string => {
      const names = presentation.commands.map((name) => `/${name}`);
      return names.length === 1
        ? `${names[0]} is not registered in this session`
        : `neither ${names[0]} nor ${names[1]} is registered in this session`;
    };
    for (const presentation of MODE_PRESENTATION) {
      const command = input.modeCommands?.[presentation.key];
      const reason =
        input.mode === presentation.mode
          ? "current mode"
          : (input.cycleDisabledReason ??
            (command === undefined ? missingCommandReason(presentation) : undefined));
      out.push({
        id: `mode-${presentation.key}`,
        kind: "action",
        slot: "action",
        label: presentation.menuLabel,
        description: presentation.description,
        tone: presentation.tone,
        order: 20 + presentation.order,
        // Keep the canonical reference even when registration failed: the host
        // re-validates it, and a disabled action without a command is not a
        // shape the contract can express.
        command: { name: command ?? presentation.commands[0]! },
        enabled: reason === undefined,
        ...(reason === undefined ? {} : { disabledReason: reason }),
      });
    }
    for (const presentation of MODE_PRESENTATION) {
      out.push({
        id: `mode-choice-${presentation.key}`,
        kind: "mode-choice",
        slot: "mode-choice",
        label: presentation.menuLabel,
        description: presentation.description,
        tone: presentation.tone,
        order: presentation.order,
        actionRef: `mode-${presentation.key}`,
        ...(input.mode === presentation.mode ? { checked: true } : {}),
      });
    }
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
      id: "input",
      kind: "input",
      slot: "input",
      availability: "locked",
      tone: "warning",
      order: 40,
      reason: "A reviewer owns this turn; pause or stop it to prompt the plan agent.",
    });
    // One inline group, the same verbs in every phase that accepts them:
    // running pauses, paused resumes, both abort. Handoff and transition carry
    // no control because the review tab (host-provided) owns the decision.
    if (phase === "running" || phase === "paused") {
      out.push({
        id: phase === "paused" ? "review-resume" : "review-pause",
        kind: "action",
        slot: "action",
        label: phase === "paused" ? "Resume review" : "Pause review",
        description: phase === "paused" ? "/review resume" : "/review pause",
        tone: phase === "paused" ? "info" : "warning",
        order: 30,
        group: REVIEW_CONTROLS_GROUP,
        command: {
          name: "review",
          args: phase === "paused" ? "resume" : "pause",
        },
        enabled: true,
      });
      out.push({
        id: "review-abort",
        kind: "action",
        slot: "action",
        label: "Abort review",
        description: "/review abort",
        tone: "warning",
        order: 31,
        group: REVIEW_CONTROLS_GROUP,
        command: { name: "review", args: "abort" },
        enabled: true,
      });
    }
    pushModeMenu();
    return out;
  }

  const presentation = modePresentation(input.mode);
  out.push({
    id: "mode",
    kind: "mode",
    slot: "mode",
    label: presentation.composerLabel,
    tone: presentation.tone,
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

  pushModeMenu();

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
      label: input.childPanelActive === true ? "Child todos" : "Todos",
      tone: "neutral",
      order: 10,
      done: Math.min(done, total),
      total,
      ...(input.stale ? { stale: true } : {}),
      ...(input.panelState ? { detail: panelStateLabel(input.panelState) } : {}),
      actions: [],
    });
  }

  const childPanel = input.childPanelActive === true;
  const activeTodosGroup = todosGroup(childPanel);

  // Keep child controls reachable before a child header or TODO row exists.
  // Progress above remains independently gated by total > 0.
  if (total > 0 || childPanel) {
    const displayActions: Array<[string, string, string]> = [
      ["todos-auto", "Auto todos", "auto"],
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
        group: activeTodosGroup,
        command: { name: "todos", args },
        enabled: true,
      });
    }
  }

  if (input.mode === "orchestrator" && input.orchestration) {
    const run = input.orchestration;
    const child = run.child;
    const childLive =
      child !== undefined &&
      (child.phase === "starting" ||
        child.phase === "running" ||
        child.phase === "paused" ||
        child.phase === "settling");
    out.push({
      id: "orchestrator-run",
      kind: "status",
      slot: "status",
      text: `run ${run.phase}${run.nextTaskId ? ` · next ${run.nextTaskId}` : ""}`,
      tone: "info",
      order: 41,
    });
    if (child) {
      // The Desktop routes status rows to the footer and the existing
      // `workflow-orchestrator` setStatus line already carries the child
      // telemetry, so publishing an `orchestrator-child` row here would only
      // duplicate it.
      out.push({
        id: "orchestrator-view",
        kind: "action",
        slot: "action",
        label: childPanel ? "Show parent todos" : "Show child todos",
        tone: "neutral",
        order: 43,
        group: activeTodosGroup,
        command: {
          name: "orchestrator",
          args: childPanel ? "view parent" : "view child",
        },
        enabled: true,
      });
      if (child.phase === "running" || child.phase === "starting") {
        out.push({
          id: "orchestrator-pause",
          kind: "action",
          slot: "action",
          label: "Pause child",
          description: "/orchestrator pause",
          tone: "warning",
          order: 44,
          group: RUN_CONTROLS_GROUP,
          command: { name: "orchestrator", args: "pause" },
          enabled: true,
        });
      }
      if (child.phase === "paused") {
        out.push({
          id: "orchestrator-resume",
          kind: "action",
          slot: "action",
          label: "Resume child",
          description: "/orchestrator resume",
          tone: "info",
          order: 44,
          group: RUN_CONTROLS_GROUP,
          command: { name: "orchestrator", args: "resume" },
          enabled: true,
        });
      }
      out.push({
        id: "orchestrator-abort",
        kind: "action",
        slot: "action",
        label: "Abort child",
        description: "/orchestrator abort",
        tone: "warning",
        order: 45,
        group: RUN_CONTROLS_GROUP,
        command: { name: "orchestrator", args: "abort" },
        enabled: true,
      });
    }
    if (run.blockedReason) {
      out.push({
        id: "orchestrator-blocked",
        kind: "status",
        slot: "status",
        text: `blocked: ${run.blockedReason.slice(0, 160)}`,
        tone: "warning",
        order: 46,
      });
    }
    if (childLive) {
      // Truthful prompt routing: running prose is forwarded, paused prose is
      // queued for resume, and a starting/verifying child cannot accept one.
      const hint =
        child?.phase === "paused"
          ? "paused — prompts are queued; /orchestrator resume delivers them"
          : child?.phase === "starting"
            ? "child is starting — wait for Working before sending a note"
            : child?.phase === "settling"
              ? "child is verifying — wait for the next row"
              : "prompts are forwarded to the Build child";
      out.push({
        id: "orchestrator-input-hint",
        kind: "status",
        slot: "status",
        text: hint,
        tone: "neutral",
        order: 47,
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

  // Composer control is additive and only appears after a v1 negotiation.
  if (input.composer) {
    out.push(...buildWorkflowComposerContributions(input.composer));
  }

  return out;
}
