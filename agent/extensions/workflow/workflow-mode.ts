/**
 * Workflow Extension — mode controller and state codec.
 *
 * Plan / Build / Default used to be three local variables plus three local
 * functions inside the extension factory. This module owns the parts that can
 * be decided without a host:
 *
 *   - the tool policy for each mode (which tools stay active),
 *   - the Tab/Ctrl+Alt+P cycle order,
 *   - the semantic role each mode maps to (planner/builder/default),
 *   - reading and writing the persisted `workflow` session entry, including
 *     the legacy `enabled`/`executing` booleans from older sessions.
 *
 * What deliberately stays in `index.ts`: anything that needs Pi's live host —
 * `ctx.ui`, `pi.setActiveTools`, model registry, Review turn ownership and the
 * handoff. Those are effects, and they are ordered by the controller there.
 *
 * Keeping the codec here matters for upgrades: a session written by 0.13 must
 * restore identically, and a session written by the orchestrator build must
 * remain readable by an older Workflow that only knows `mode`.
 */

import type { TodoItem } from "./utils.ts";

/** `null` is Default (workflow off). Orchestrator is opt-in, never in Tab. */
export type WorkflowMode = "plan" | "build" | "orchestrator" | null;

export const WORKFLOW_MODES: readonly WorkflowMode[] = ["plan", "build", "orchestrator", null];

export function isWorkflowMode(value: unknown): value is WorkflowMode {
  return value === "plan" || value === "build" || value === "orchestrator" || value === null;
}

// ── Tool policy ──────────────────────────────────────────────────────

/**
 * Tools Plan mode keeps active. `edit`/`write` are INCLUDED on purpose: the
 * `tool_call` gate refuses them outside `.pi/plans/`, and a blocked tool that
 * is active can explain why. Deactivating them would turn a helpful refusal
 * into "unknown tool".
 */
export const PLAN_MODE_TOOLS = [
  "read",
  "bash",
  "edit",
  "write",
  "grep",
  "find",
  "ls",
  "explore",
  "questionnaire",
  "workflow_todo",
] as const;

/**
 * Tools Orchestrator keeps active. It is a parent/verification mode: the same
 * read-only exploration set as Plan, with project edits gated. Dispatch tools
 * arrive in later phases; entering the mode must not launch anything.
 */
export const ORCHESTRATOR_MODE_TOOLS = [...PLAN_MODE_TOOLS] as const;

/** Tools Build (the normal state) ensures are present. */
export const NORMAL_MODE_TOOLS = [...PLAN_MODE_TOOLS] as const;

/** Tools Plan removes from an inherited set before re-adding its own. */
export const PLAN_DISABLED_TOOLS: ReadonlySet<string> = new Set(["edit", "write"]);

const MANAGED_TOOLS: ReadonlySet<string> = new Set([
  ...PLAN_MODE_TOOLS,
  ...NORMAL_MODE_TOOLS,
]);

function unique(names: readonly string[]): string[] {
  return [...new Set(names)];
}

/**
 * Active tools for Plan mode. Preserves unmanaged tools the host activated
 * (e.g. a third-party extension's tool) — a mode switch must never silently
 * remove a capability the user enabled.
 */
export function planModeTools(active: readonly string[]): string[] {
  return unique([
    ...active.filter((name) => !PLAN_DISABLED_TOOLS.has(name)),
    ...PLAN_MODE_TOOLS,
  ]);
}

/** Active tools for Orchestrator: read-only plus the gated plan-write path. */
export function orchestratorModeTools(active: readonly string[]): string[] {
  return planModeTools(active);
}

/**
 * Active tools for Build/Default. The workflow-managed names are placed first
 * and in a stable order so a persisted/debugged tool list is reproducible.
 */
export function buildModeTools(active: readonly string[]): string[] {
  return unique([
    ...NORMAL_MODE_TOOLS,
    ...active.filter((name) => !MANAGED_TOOLS.has(name)),
  ]);
}

/** True when a tool is one the workflow manages (and therefore reorders). */
export function isManagedTool(name: string): boolean {
  return MANAGED_TOOLS.has(name);
}

// ── Cycle and role mapping ───────────────────────────────────────────

/** Tab / Ctrl+Alt+P order: Default → Plan → Build → Default. */
export function cycleMode(current: WorkflowMode, direction: 1 | -1 = 1): WorkflowMode {
  // Orchestrator is opt-in and not in this cycle. Tab (either direction) leaves
  // it for Default; /plan and /build switch directly.
  if (current === "orchestrator") return null;
  const order: WorkflowMode[] = [null, "plan", "build"];
  const index = order.indexOf(current);
  const next = (index + direction + order.length) % order.length;
  return order[next] ?? null;
}

export type ModeRole = "planner" | "builder" | "orchestrator" | null;

/** The semantic role a mode activates (the model binding lives in roles.ts). */
export function roleForMode(mode: WorkflowMode): ModeRole {
  if (mode === "plan") return "planner";
  if (mode === "build") return "builder";
  if (mode === "orchestrator") return "orchestrator";
  return null;
}

/** Footer/status label for a mode, independent of a host's theme. */
export function modeLabel(mode: WorkflowMode): string {
  if (mode === "plan") return "plan";
  if (mode === "build") return "build";
  if (mode === "orchestrator") return "orchestrator";
  return "default";
}

// ── Persisted state codec ────────────────────────────────────────────

/**
 * The durable part of the `workflow` custom entry this module understands.
 * Other fields (todos, handoff correlation, …) are owned by their features.
 */
export interface WorkflowStateFields {
  mode: WorkflowMode;
  /** Legacy mirrors, still written for older readers. */
  enabled: boolean;
  executing: boolean;
  toolsBeforePlanMode?: string[];
  planFile?: string;
  todos?: TodoItem[];
}

export interface DecodedWorkflowEntry {
  mode: WorkflowMode;
  /** The entry used the pre-`mode` `enabled`/`executing` booleans. */
  legacy: boolean;
  toolsBeforePlanMode?: string[];
  planFile?: string;
}

/**
 * Decodes one persisted entry.
 *
 * `previous` carries the mode restored from an earlier entry: a legacy entry
 * with neither boolean must NOT reset the mode (that was the pre-fix behaviour
 * and would lose a plan/build selection on resume).
 *
 * Returns `undefined` for a non-object payload, so a corrupt entry is skipped
 * rather than clearing state.
 */
export function decodeWorkflowEntry(
  data: unknown,
  previous: WorkflowMode = null,
): DecodedWorkflowEntry | undefined {
  if (!data || typeof data !== "object" || Array.isArray(data)) return undefined;
  const record = data as Record<string, unknown>;

  let mode: WorkflowMode;
  let legacy = false;
  // The canonical shape is identified by the PRESENCE of `mode`, including
  // `mode: null` for Default. Checking the value's type instead would classify
  // our own `{mode: null}` output as legacy and mislabel it.
  if ("mode" in record) {
    // An unknown string is a newer mode this build does not understand: treat
    // it as Default rather than crashing or guessing. Orchestrator is the
    // current opt-in mode; older readers still see Default.
    mode =
      record.mode === "plan"
        ? "plan"
        : record.mode === "build"
          ? "build"
          : record.mode === "orchestrator"
            ? "orchestrator"
            : null;
  } else if (typeof record.enabled === "boolean" || typeof record.executing === "boolean") {
    legacy = true;
    if (record.enabled === true) mode = "plan";
    else if (record.executing === true) mode = "build";
    else mode = previous;
  } else {
    mode = previous;
  }

  const toolsBeforePlanMode = Array.isArray(record.toolsBeforePlanMode)
    ? record.toolsBeforePlanMode.filter((entry): entry is string => typeof entry === "string")
    : undefined;
  const planFile =
    typeof record.planFile === "string" && record.planFile.length > 0
      ? record.planFile
      : undefined;

  return {
    mode,
    legacy,
    ...(toolsBeforePlanMode === undefined ? {} : { toolsBeforePlanMode }),
    ...(planFile === undefined ? {} : { planFile }),
  };
}

/**
 * The fields written on every persist. `enabled`/`executing` are kept for
 * readers written before the `mode` field existed; they are derived, never
 * authoritative.
 */
export function encodeWorkflowMode(mode: WorkflowMode): Pick<
  WorkflowStateFields,
  "mode" | "enabled" | "executing"
> {
  return {
    mode,
    enabled: mode === "plan",
    executing: mode === "build",
  };
}
