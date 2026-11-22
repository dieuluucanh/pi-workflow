/**
 * Workflow Extension — human-bound execution preview (plan step 9).
 *
 * The breakdown approval is the ONE user decision that authorizes dispatch.
 * The runtime already validates coverage, models, checks and budgets; this
 * module turns that validated `ExecutionPreview` into the bounded text a human
 * actually reads in Terminal (and that a generic host can render), including
 * the ID that an approval must name.
 *
 * It is deliberately pure: no model, no clock, no transport. The preview ID is
 * derived from the approval digest, so approving a preview that has since
 * changed (different plan, models, limits or host readiness) is refused by the
 * runtime — the ID is not a UI decoration.
 */

import type { ExecutionPreview } from "./orchestrator-approval.ts";

export const PREVIEW_VIEW_VERSION = 1 as const;
export const MAX_PREVIEW_VIEW_CHARS = 6_000;
export const MAX_PREVIEW_LINES = 80;

export interface PreviewRequirement {
  roadmapStepId: string;
  label?: string;
  text: string;
}

export interface FormatPreviewInput {
  preview: ExecutionPreview;
  /** The roadmap requirements, so the user sees the derived scope, not ids. */
  requirements?: readonly PreviewRequirement[];
  /** Host readiness observed right now, when known. */
  host?: { ready: boolean; label: string; reason?: string };
  /** True when the run started from the user's current discussion. */
  fromDiscussion?: boolean;
  /** Dirty-baseline change count, when the caller knows it. */
  dirtyChanges?: number;
}

/**
 * The stable, human-typeable approval target. The full digest is not printed:
 * 16 hex chars already make an accidental collision implausible and it keeps
 * the command short enough to paste.
 */
export function previewApprovalId(preview: Pick<ExecutionPreview, "approvalDigest">): string {
  return `preview-${preview.approvalDigest.slice(0, 16)}`;
}

/** True when a user-supplied value names this exact preview. */
export function matchesPreviewId(
  preview: Pick<ExecutionPreview, "approvalDigest">,
  candidate: unknown,
  minimumPrefix = 8,
): boolean {
  if (typeof candidate !== "string") return false;
  const value = candidate.trim().toLowerCase();
  if (value.length === 0) return false;
  const digest = preview.approvalDigest.toLowerCase();
  if (value === digest) return true;
  if (value.startsWith("preview-")) return value.slice("preview-".length) === digest.slice(0, 16);
  return value.length >= minimumPrefix && digest.startsWith(value);
}

function join(values: readonly string[], empty: string): string {
  return values.length === 0 ? empty : values.join(", ");
}

/**
 * Formats the preview for a human. Lines are ordered by what the approval
 * decides: scope first, then execution shape, then host/baseline blockers, then
 * the exact command. The ID line is never omitted.
 */
export function formatExecutionPreview(input: FormatPreviewInput): string {
  const preview = input.preview;
  const id = previewApprovalId(preview);
  const requirementText = new Map(
    (input.requirements ?? []).map((entry) => [entry.roadmapStepId, entry]),
  );
  const mapped = new Set(preview.mapping.flatMap((entry) => entry.taskIds));
  const outstanding = preview.mapping.filter((entry) => entry.taskIds.length === 0);

  const lines: string[] = [];
  const push = (line: string) => {
    if (lines.length < MAX_PREVIEW_LINES) lines.push(line);
  };

  push(`Execution preview ${id}`);
  push(
    `Run ${preview.runId} · roadmap revision ${preview.roadmapRevision} · source ${
      input.fromDiscussion ? "current discussion" : "plan file"
    }`,
  );
  push(
    `Roadmap digest ${preview.roadmapDigest.slice(0, 12)} · plan digest ${preview.planDigest.slice(0, 12)}`,
  );
  push("");
  push(
    `Scope: ${preview.mapping.length} requirement(s), ${preview.mapping.length - outstanding.length} mapped to ${preview.tasks.length} task(s)`,
  );
  const requirementLines = preview.mapping.slice(0, 40).map((entry, index) => {
    const requirement = requirementText.get(entry.requirementId);
    const label = requirement?.label ? ` (${requirement.label})` : "";
    const text = requirement?.text ?? "(requirement text not reported)";
    const target = entry.taskIds.length > 0 ? entry.taskIds.join(", ") : "UNCOVERED";
    return `  ${index + 1}. ${entry.requirementId}${label} ${text.slice(0, 180)} → ${target}`;
  });
  for (const line of requirementLines) push(line);
  if (preview.mapping.length > 40) push(`  … ${preview.mapping.length - 40} more requirement(s)`);
  if (outstanding.length > 0) {
    push(`  Uncovered: ${join(outstanding.map((entry) => entry.requirementId), "none")}`);
  }
  push("");

  for (const task of preview.tasks.slice(0, 20)) {
    const known = task.covers
      .map((id) => requirementText.get(id)?.text ?? id)
      .join("; ")
      .slice(0, 240);
    push(
      `Task ${task.taskId}: covers ${join(task.covers, "(none)")} · depends on ${join(
        task.dependsOn,
        "none",
      )} · ~${task.estimatedTokens} tokens`,
    );
    if (known) push(`  ${known}`);
  }
  if (preview.tasks.length > 20) push(`… ${preview.tasks.length - 20} more task(s)`);
  push("");

  push(
    `Models: orchestrator ${preview.models.orchestrator.model} (usable ${preview.models.orchestrator.usableInput}, ${preview.models.orchestrator.confidence}) · builder ${preview.models.builder.model} (usable ${preview.models.builder.usableInput}, ${preview.models.builder.confidence})`,
  );
  const host = input.host
    ? input.host.ready
      ? `${input.host.label} ready`
      : `${input.host.label} NOT READY${input.host.reason ? ` (${input.host.reason})` : ""}`
    : preview.launcher.ready
      ? `${preview.launcher.label} ready`
      : `${preview.launcher.label} NOT READY${preview.launcher.reason ? ` (${preview.launcher.reason})` : ""}`;
  push(`Child host: ${host}`);
  push(`Checks: ${join(preview.checks, "(none declared — acceptance would be unverifiable)")}`);
  push(
    `Baseline: ${
      input.dirtyChanges !== undefined
        ? `${input.dirtyChanges} pre-existing change(s) preserved`
        : preview.options.baselineDirty
          ? "dirty (pre-existing user work is preserved)"
          : "clean"
    }`,
  );
  push(
    `Commit: ${preview.options.commitMode} · mutation scope ${
      preview.options.mutationScope.length > 0
        ? join(preview.options.mutationScope.slice(0, 12), "")
        : "(not narrowed)"
    }`,
  );
  push(
    `Limits: repairs ${preview.limits.repairRounds} · no-progress ${preview.limits.noProgressLimit} · rollovers ${preview.limits.rolloverLimit} · launch failures ${preview.limits.launchFailureLimit}`,
  );
  for (const warning of preview.warnings.slice(0, 8)) push(`Warning: ${warning}`);
  for (const blocked of preview.blockedReasons.slice(0, 8)) push(`Blocker: ${blocked}`);
  push("");
  push(
    `Mapped tasks: ${mapped.size > 0 ? [...mapped].slice(0, 40).join(", ") : "none"}`,
  );
  push(
    preview.blockedReasons.length > 0
      ? `This breakdown cannot be dispatched yet. Fix the blockers, then propose again; nothing is approved by this text.`
      : `Approve with: /orchestrator approve ${id}`,
  );
  push(`Refine with: /orchestrator refine <what to change> · Cancel with: /orchestrator cancel`);

  return lines.join("\n").slice(0, MAX_PREVIEW_VIEW_CHARS);
}
