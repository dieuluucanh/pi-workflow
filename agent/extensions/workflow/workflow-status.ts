/**
 * Workflow footer segments (2026-10-31 UI plan, step 10).
 *
 * The extension used to publish one long `workflow` status containing the mode,
 * progress, profile/role, commit/write policy and review text. Desktop hosts can
 * only lay an arbitrary status string out as one column, and terminal Pi wraps
 * the same line less efficiently. This module builds short, stable segments so
 * each can be its own footer column.
 *
 * `workflow` stays the mode/progress string: it is what the Desktop parser
 * (`src/shared/workflow-mode.ts`) and existing terminal Pi users already know.
 * The other keys are additive.
 */

export const WORKFLOW_STATUS_KEYS = {
  mode: "workflow",
  profile: "workflow-profile",
  policy: "workflow-policy",
  review: "workflow-review",
  todos: "workflow-todos",
  orchestrator: "workflow-orchestrator",
} as const;

export interface WorkflowStatusInput {
  mode: "build" | "plan" | "orchestrator" | null;
  /**
   * The exclusive Review turn. `running|paused|handoff` replaces the author
   * mode in the segment; `transition` is internal and renders as running.
   */
  reviewPhase?: "idle" | "running" | "paused" | "handoff" | "transition" | null;
  /**
   * A pending plan handoff that did not come from a reviewer. Rendered as a
   * sub-state of the active mode (e.g. `⏸ plan — handoff pending`), never as
   * Review: Review Mode off must not look like Review.
   */
  handoffPending?: boolean;
  done: number;
  total: number;
  stale?: boolean;
  profileLabel?: string;
  roleLabel?: string;
  commitMode: string;
  /** Only Default mode has a write policy; null/undefined omits it. */
  writeMode?: string | null;
  /** Shared read/write/commit folder scope; null/undefined omits it. */
  folderMode?: string | null;
  /**
   * The saved handoff execution RECOMMENDATION. Visible so the user knows what
   * the next chooser will suggest; it never executes anything by itself.
   */
  handoffDestination?: "orchestrator" | "build";
  /**
   * Which handoff stage is active: a plan review awaiting a decision, an
   * approved plan awaiting its execution choice, or a route being applied.
   */
  handoffStage?: "review-pending" | "approved" | "routing";
  /** Orchestrator run state, when one is bound to this session. */
  orchestration?: {
    phase: string;
    blockedReason?: string;
    nextTaskId?: string;
  };
}

export interface WorkflowStatusSegments {
  mode: string;
  profile: string;
  policy: string;
  /** Empty unless an orchestrator run/decision is worth surfacing. */
  orchestrator: string;
}

export function buildWorkflowStatusSegments(
  input: WorkflowStatusInput,
): WorkflowStatusSegments {
  const done = Number.isFinite(input.done) ? Math.max(0, input.done) : 0;
  const total = Number.isFinite(input.total) ? Math.max(0, input.total) : 0;
  const stale = input.stale ? " ⚠" : "";
  const profile = [input.profileLabel ?? "", input.roleLabel ?? ""]
    .map((part) => part.trim())
    .filter(Boolean)
    .join(" | ");
  const policy =
    `commits:${input.commitMode}` +
    (input.writeMode ? ` · writes:${input.writeMode}` : "") +
    (input.folderMode ? ` · folders:${input.folderMode}` : "");

  let mode: string;
  const phase = input.reviewPhase ?? "idle";
  if (phase !== "idle") {
    // The mode segment is deliberately free of `n/m` and pass details: the
    // Desktop's progress parser must not read review progress as plan steps.
    const base =
      phase === "paused"
        ? "🔍 review — paused"
        : phase === "handoff"
          ? "🔍 review — awaiting decision"
          : "🔍 review";
    mode = base;
  } else {
    let base: string;
    if (input.mode === "build") {
      base = total > 0 ? `▶ build ${done}/${total}${stale}` : `▶ build${stale}`;
    } else if (input.mode === "plan") {
      base = total > 0 ? `⏸ plan ${done}/${total}${stale}` : `⏸ plan${stale}`;
    } else if (input.mode === "orchestrator") {
      base =
        total > 0
          ? `🧭 orchestrator ${done}/${total}${stale}`
          : `🧭 orchestrator${stale}`;
    } else if (total > 0) {
      // The default mode must stay parseable by the Desktop badge decoder.
      base = `◦ ${done}/${total}${stale}`;
    } else {
      base = `◦ commits:${input.commitMode}${stale}`;
    }
    const stageSuffix =
      input.handoffStage === "approved"
        ? " — execution choice pending"
        : input.handoffStage === "routing"
          ? " — applying execution"
          : input.handoffPending || input.handoffStage === "review-pending"
            ? " — handoff pending"
            : "";
    mode = `${base}${stageSuffix}`;
  }

  const destination = "";
  const run = input.orchestration
    ? `run ${input.orchestration.phase}` +
      (input.orchestration.nextTaskId ? ` · next ${input.orchestration.nextTaskId}` : "") +
      (input.orchestration.blockedReason
        ? ` · blocked: ${input.orchestration.blockedReason.slice(0, 120)}`
        : "")
    : "";
  const orchestrator = [destination, run].filter(Boolean).join(" · ");

  return { mode, profile, policy, orchestrator };
}

/** Sets a status only while it has text; `undefined` removes a stale key. */
export function setWorkflowStatus(
  ui: { setStatus?: (key: string, text: string | undefined) => void },
  key: string,
  text: string,
): void {
  ui.setStatus?.(key, text.length > 0 ? text : undefined);
}

/**
 * Sets a string-line widget only while it has lines; `[]` removes it.
 *
 * String lines (never a component factory) keep the widget portable: Terminal's
 * `setExtensionWidget` renders them directly, and Desktop's UI port hands arrays
 * to its native widget strip. `undefined` (not an empty array) is what actually
 * unmounts it.
 */
export function setWorkflowWidget(
  ui:
    | {
        setWidget?: (
          key: string,
          lines: string[] | undefined,
          options?: { placement?: "aboveEditor" | "belowEditor" },
        ) => void;
      }
    | undefined,
  key: string,
  lines: readonly string[],
  options?: { placement?: "aboveEditor" | "belowEditor" },
): void {
  ui?.setWidget?.(key, lines.length > 0 ? [...lines] : undefined, options);
}
