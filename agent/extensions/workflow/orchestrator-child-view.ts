/**
 * Workflow Extension — Orchestrator child transcript UI.
 *
 * The child is in-process, so its visible record is a display-only custom entry
 * stream in the PARENT transcript, exactly like Review Mode. Nothing here enters
 * LLM context and nothing opens a window/tab.
 */

import type { EntryRenderer, ThemeColor } from "@earendil-works/pi-coding-agent";
import type { ReviewLineKind } from "./review.ts";
import {
  createReviewEntryComponent,
  formatReviewTranscriptLines,
} from "./review-ui.ts";
import type { OrchestratorChildState } from "./orchestrator-child-controller.ts";
import {
  formatChildProgress,
  formatChildStatusLine,
  modelRefFromLabel,
} from "./child-stats.ts";

export const ORCHESTRATOR_CHILD_BAND_ENTRY = "workflow-orchestrator-child-band";
export const ORCHESTRATOR_CHILD_TRANSCRIPT_ENTRY =
  "workflow-orchestrator-child-transcript";

export interface OrchestratorChildBandData {
  runId: string;
  taskId: string;
  ref: string;
  total: number;
  phase: "start" | "done" | "failed" | "paused" | "aborted";
  model?: string;
  detail?: string;
}

export interface OrchestratorChildTranscriptData {
  runId: string;
  taskId: string;
  ref: string;
  total: number;
  lines: Array<{ kind: ReviewLineKind; text: string }>;
}

export interface ChildEntryRendererHost {
  registerEntryRenderer<T = unknown>(
    customType: string,
    renderer: EntryRenderer<T>,
  ): void;
}

function colorFor(phase: OrchestratorChildBandData["phase"]): ThemeColor {
  if (phase === "failed" || phase === "aborted") return "error";
  if (phase === "paused") return "warning";
  if (phase === "done") return "success";
  return "accent";
}

/** One readable band line, e.g. `▌ BUILD CHILD 2/7 · task-2 · running`. */
export function formatOrchestratorChildBand(
  data: OrchestratorChildBandData | undefined,
  theme: {
    fg(color: ThemeColor, text: string): string;
    bold(text: string): string;
  },
): string[] {
  if (!data) return [];
  const label =
    data.phase === "start"
      ? "BUILD CHILD"
      : data.phase === "done"
        ? "CHILD DONE"
        : data.phase === "failed"
          ? "CHILD BLOCKED"
          : data.phase === "paused"
            ? "CHILD PAUSED"
            : "CHILD ABORTED";
  const color = colorFor(data.phase);
  const title = theme.fg(color, theme.bold(`▌ ${label}`));
  const bits = [`${data.ref}/${data.total}`, data.taskId];
  if (data.model) bits.push(data.model);
  if (data.detail) bits.push(data.detail.slice(0, 200));
  return [title + theme.fg("muted", `  ${bits.filter(Boolean).join(" · ")}`)];
}

export function formatOrchestratorChildTranscript(
  data: OrchestratorChildTranscriptData | undefined,
  theme: Parameters<typeof formatReviewTranscriptLines>[1],
): string[] {
  return formatReviewTranscriptLines(data?.lines, theme);
}

/**
 * Register once at extension load. Re-registering overwrites, so `/reload` is
 * idempotent (same contract as Review's renderers).
 */
export function registerOrchestratorChildRenderers(
  host: ChildEntryRendererHost,
): void {
  host.registerEntryRenderer<OrchestratorChildBandData>(
    ORCHESTRATOR_CHILD_BAND_ENTRY,
    (entry, _options, theme) =>
      createReviewEntryComponent(
        formatOrchestratorChildBand(entry?.data, theme),
      ),
  );
  host.registerEntryRenderer<OrchestratorChildTranscriptData>(
    ORCHESTRATOR_CHILD_TRANSCRIPT_ENTRY,
    (entry, _options, theme) =>
      createReviewEntryComponent(
        formatOrchestratorChildTranscript(entry?.data, theme),
      ),
  );
}

/**
 * Footer/status text; one bounded, truthful line.
 *
 * Shares `formatChildStatusLine`, so the footer, the pinned panel, the operator
 * text and the host contributions can never disagree about the child's model,
 * context or todos.
 */
export function formatOrchestratorChildStatus(
  state: OrchestratorChildState | undefined,
  now: number = Date.now(),
): string {
  if (!state || state.phase === "idle" || state.phase === "disposed") {
    return "";
  }
  const phase = state.phase === "settling" ? "verifying" : state.phase;
  const model =
    state.stats?.model ?? modelRefFromLabel(state.modelLabel);
  const elapsedMs =
    state.startedAt === undefined
      ? undefined
      : Math.max(0, (state.pausedAt ?? now) - state.startedAt);
  return formatChildStatusLine({
    ...(state.ref ? { ref: state.ref } : {}),
    ...(state.total === undefined ? {} : { total: state.total }),
    phase,
    ...(model ? { model } : {}),
    ...(state.stats ? { stats: state.stats } : {}),
    ...(elapsedMs === undefined ? {} : { elapsedMs }),
    todoDone: state.todos.filter((item) => item.completed).length,
    todoTotal: state.todos.length,
  });
}

/** The compact detail carried by the historical child band (model excluded). */
export function formatOrchestratorChildProgress(
  state: OrchestratorChildState | undefined,
): string {
  if (!state || state.phase === "idle" || state.phase === "disposed") {
    return "";
  }
  return formatChildProgress({
    ...(state.lastTool ? { lastTool: state.lastTool } : {}),
    todoDone: state.todos.filter((item) => item.completed).length,
    todoTotal: state.todos.length,
  });
}
