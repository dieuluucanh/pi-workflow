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
} as const;

export interface WorkflowStatusInput {
  mode: "build" | "plan" | null;
  /** Plannotator's Plan sub-state, shown inside the mode segment. */
  plannotatorActive?: boolean;
  done: number;
  total: number;
  stale?: boolean;
  profileLabel?: string;
  roleLabel?: string;
  commitMode: string;
  /** Only Default mode has a write policy; null/undefined omits it. */
  writeMode?: string | null;
}

export interface WorkflowStatusSegments {
  mode: string;
  profile: string;
  policy: string;
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
    (input.writeMode ? ` · writes:${input.writeMode}` : "");

  let mode: string;
  if (input.mode === "build") {
    mode = total > 0 ? `▶ build ${done}/${total}${stale}` : `▶ build${stale}`;
  } else if (input.mode === "plan") {
    const base = input.plannotatorActive
      ? "⏸ plan — reviewing in browser"
      : "⏸ plan";
    mode = total > 0 ? `${base} ${done}/${total}${stale}` : `${base}${stale}`;
  } else if (total > 0) {
    // The default mode must stay parseable by the Desktop badge decoder.
    mode = `◦ ${done}/${total}${stale}`;
  } else {
    mode = `◦ commits:${input.commitMode}${stale}`;
  }

  return { mode, profile, policy };
}

/** Sets a status only while it has text; `undefined` removes a stale key. */
export function setWorkflowStatus(
  ui: { setStatus?: (key: string, text: string | undefined) => void },
  key: string,
  text: string,
): void {
  ui.setStatus?.(key, text.length > 0 ? text : undefined);
}
