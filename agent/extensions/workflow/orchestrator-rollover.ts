/**
 * Workflow Extension — context-aware child rollover (step 34).
 *
 * A long task can outgrow the child's context. The scheduler must NOT wait for
 * an overflow, and must never let two writers run at once:
 *
 *   1. monitor real usage against the model's usable input;
 *   2. at a safe boundary (settled/quiescent, no tool or shell in flight)
 *      request a structured checkpoint;
 *   3. quiesce the old child, then launch a fresh visible continuation with the
 *      same task/criteria and a NEW attempt/generation;
 *   4. keep repair/no-progress/rollover counters across the continuation.
 *
 * A checkpoint (or a compaction) is state, never completion: `completionClaimed`
 * is always false here, and acceptance still requires step 32 evidence. If an
 * overflow happens without a checkpoint, recovery is deliberately conservative:
 * re-read the workspace, keep the task open, and forbid a simultaneous writer.
 */

import { DEFAULT_EXECUTION_BUDGETS, type ExecutionBudgets } from "./orchestrator-types.ts";
import type { TaskCounters } from "./orchestrator-state.ts";

export const ROLLOVER_SCHEMA_VERSION = 1 as const;
export const MAX_CHECKPOINT_ITEMS = 64;
export const MAX_CHECKPOINT_TEXT = 1_000;
export const MAX_CHECKPOINT_TOTAL = 16_000;

/** Ratios of usable input. Low confidence checks in slightly earlier. */
export const APPROACHING_RATIO = 0.6;
export const CHECKPOINT_RATIO = 0.8;
export const ROLLOVER_RATIO = 0.9;

export interface UsageSample {
  tokensUsed: number;
  /** Provider context window, when known. */
  contextWindow?: number | null;
  /** Tokens reserved for output/system/repair. */
  reserveTokens?: number | null;
  confidence?: "high" | "medium" | "low";
  /** Boundaries that make a checkpoint unsafe to request now. */
  activeTool?: boolean;
  activeShell?: boolean;
  settled?: boolean;
}

export type UsageLevel = "ok" | "approaching" | "checkpoint_due" | "rollover_due" | "overflowed" | "unknown";

export interface UsageAssessment {
  level: UsageLevel;
  usableInput: number | null;
  ratio: number | null;
  headroom: number | null;
  /** A checkpoint may be requested at this instant. */
  safeBoundary: boolean;
  confidence: "high" | "medium" | "low" | "unknown";
  reason: string;
}

function finitePositive(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function finiteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/**
 * Assesses usage without assuming context size equals competence. Missing
 * metadata yields `unknown`, which callers must treat conservatively (request
 * usage / checkpoint) rather than as "plenty of room".
 */
export function assessUsage(sample: UsageSample): UsageAssessment {
  const safeBoundary =
    sample.activeTool !== true && sample.activeShell !== true && sample.settled !== false;
  const confidence = sample.confidence ?? "medium";
  const base = { safeBoundary, confidence } as const;

  if (!finiteNonNegative(sample.tokensUsed)) {
    return {
      ...base,
      level: "unknown",
      usableInput: null,
      ratio: null,
      headroom: null,
      reason: "token usage is not a finite non-negative number",
    };
  }
  if (!finitePositive(sample.contextWindow)) {
    return {
      ...base,
      level: "unknown",
      usableInput: null,
      ratio: null,
      headroom: null,
      reason: "the context window is unknown; do not treat it as unbounded",
    };
  }
  const reserve = sample.reserveTokens ?? 0;
  if (!finiteNonNegative(reserve) || reserve >= sample.contextWindow) {
    return {
      ...base,
      level: "unknown",
      usableInput: null,
      ratio: null,
      headroom: null,
      reason: "the token reserve is unknown or larger than the context window",
    };
  }
  const usableInput = Math.max(1, sample.contextWindow - reserve);
  const ratio = sample.tokensUsed / usableInput;
  const headroom = Math.max(0, usableInput - sample.tokensUsed);
  const shift = confidence === "low" ? 0.05 : 0;

  let level: UsageLevel;
  if (sample.tokensUsed >= sample.contextWindow) level = "overflowed";
  else if (ratio >= ROLLOVER_RATIO - shift) level = "rollover_due";
  else if (ratio >= CHECKPOINT_RATIO - shift) level = "checkpoint_due";
  else if (ratio >= APPROACHING_RATIO - shift) level = "approaching";
  else level = "ok";

  let reason = "usage is within the working set";
  if (level === "overflowed") {
    reason = "the context is already overflowing; recover without a checkpoint";
  } else if (level === "rollover_due") {
    reason = "request a checkpoint now and prepare a fresh continuation";
  } else if (level === "checkpoint_due") {
    reason = "a checkpoint should be requested before the hard headroom limit";
  } else if (level === "approaching") {
    reason = "the child is approaching its usable input";
  }

  return {
    ...base,
    level,
    usableInput,
    ratio,
    headroom,
    reason,
  };
}

// ── Structured checkpoint ────────────────────────────────────────────

export interface CheckpointCheck {
  name: string;
  status: string;
}

export interface ChildCheckpoint {
  schemaVersion: typeof ROLLOVER_SCHEMA_VERSION;
  runId: string;
  taskId: string;
  attemptId: string;
  sessionId: string;
  /** Local TODOs still open; these are the child's, not the roadmap's. */
  remainingTodos: string[];
  decisions: string[];
  files: string[];
  checks: CheckpointCheck[];
  /** Effects that may already have landed (install/migration/external call). */
  partialEffects: string[];
  criteria: string[];
  /** Always false: a checkpoint is never acceptance. */
  completionClaimed: false;
  truncated: boolean;
  digest: string;
  createdAt: number;
}

export interface CheckpointInput {
  runId: string;
  taskId: string;
  attemptId: string;
  sessionId: string;
  remainingTodos?: readonly string[];
  decisions?: readonly string[];
  files?: readonly string[];
  checks?: readonly CheckpointCheck[];
  partialEffects?: readonly string[];
  criteria?: readonly string[];
  /** False while a tool/shell is running; the caller must request it later. */
  safeBoundary: boolean;
  now: number;
}

export type CheckpointResult =
  | { ok: true; checkpoint: ChildCheckpoint }
  | { ok: false; code: "unsafe_boundary" | "invalid"; error: string };

function boundedItems(
  raw: readonly string[] | undefined,
  max: number,
): { items: string[]; truncated: boolean } {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of raw ?? []) {
    if (typeof entry !== "string") continue;
    const value = entry.trim().slice(0, MAX_CHECKPOINT_TEXT);
    if (value.length === 0 || seen.has(value)) continue;
    seen.add(value);
    if (out.length >= max) return { items: out, truncated: true };
    out.push(value);
  }
  return { items: out, truncated: false };
}

function digest(value: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(value);
  } catch {
    text = String(value);
  }
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/**
 * Captures what a continuation needs. It refuses an unsafe boundary instead of
 * snapshotting a half-finished tool call.
 */
export function createCheckpoint(input: CheckpointInput): CheckpointResult {
  if (!input.safeBoundary) {
    return {
      ok: false,
      code: "unsafe_boundary",
      error: "a checkpoint needs a settled boundary with no tool or shell in flight",
    };
  }
  for (const [label, value] of [
    ["runId", input.runId],
    ["taskId", input.taskId],
    ["attemptId", input.attemptId],
    ["sessionId", input.sessionId],
  ] as const) {
    if (typeof value !== "string" || value.trim().length === 0 || value.length > 400) {
      return { ok: false, code: "invalid", error: `${label} is invalid` };
    }
  }

  const todos = boundedItems(input.remainingTodos, MAX_CHECKPOINT_ITEMS);
  const decisions = boundedItems(input.decisions, MAX_CHECKPOINT_ITEMS);
  const files = boundedItems(input.files, MAX_CHECKPOINT_ITEMS);
  const partialEffects = boundedItems(input.partialEffects, MAX_CHECKPOINT_ITEMS);
  const criteria = boundedItems(input.criteria, MAX_CHECKPOINT_ITEMS);
  const checks: CheckpointCheck[] = [];
  for (const check of (input.checks ?? []).slice(0, MAX_CHECKPOINT_ITEMS)) {
    if (!check || typeof check.name !== "string" || typeof check.status !== "string") continue;
    const name = check.name.trim().slice(0, 200);
    const status = check.status.trim().slice(0, 50);
    if (!name || !status) continue;
    checks.push({ name, status });
  }

  const truncated =
    todos.truncated ||
    decisions.truncated ||
    files.truncated ||
    partialEffects.truncated ||
    criteria.truncated ||
    (input.checks?.length ?? 0) > checks.length;

  const body = {
    runId: input.runId,
    taskId: input.taskId,
    attemptId: input.attemptId,
    sessionId: input.sessionId,
    remainingTodos: todos.items,
    decisions: decisions.items,
    files: files.items,
    checks,
    partialEffects: partialEffects.items,
    criteria: criteria.items,
  };
  let checkpoint: ChildCheckpoint = {
    schemaVersion: ROLLOVER_SCHEMA_VERSION,
    ...body,
    completionClaimed: false,
    truncated,
    digest: digest(body),
    createdAt: input.now,
  };
  // Bound the serialized size, dropping the least critical list first.
  while (JSON.stringify(checkpoint).length > MAX_CHECKPOINT_TOTAL) {
    if (checkpoint.partialEffects.length > 0) {
      checkpoint = { ...checkpoint, partialEffects: checkpoint.partialEffects.slice(0, -1) };
    } else if (checkpoint.decisions.length > 0) {
      checkpoint = { ...checkpoint, decisions: checkpoint.decisions.slice(0, -1) };
    } else if (checkpoint.remainingTodos.length > 0) {
      checkpoint = { ...checkpoint, remainingTodos: checkpoint.remainingTodos.slice(0, -1) };
    } else if (checkpoint.files.length > 0) {
      checkpoint = { ...checkpoint, files: checkpoint.files.slice(0, -1) };
    } else if (checkpoint.checks.length > 0) {
      checkpoint = { ...checkpoint, checks: checkpoint.checks.slice(0, -1) };
    } else if (checkpoint.criteria.length > 0) {
      checkpoint = { ...checkpoint, criteria: checkpoint.criteria.slice(0, -1) };
    } else {
      break;
    }
    checkpoint = { ...checkpoint, truncated: true };
  }
  // The digest must describe the final bounded content, not the pre-trim body.
  const finalBody = {
    runId: checkpoint.runId,
    taskId: checkpoint.taskId,
    attemptId: checkpoint.attemptId,
    sessionId: checkpoint.sessionId,
    remainingTodos: checkpoint.remainingTodos,
    decisions: checkpoint.decisions,
    files: checkpoint.files,
    checks: checkpoint.checks,
    partialEffects: checkpoint.partialEffects,
    criteria: checkpoint.criteria,
  };
  checkpoint = { ...checkpoint, digest: digest(finalBody) };
  return { ok: true, checkpoint };
}

// ── Rollover decision ────────────────────────────────────────────────

export interface RolloverChildState {
  phase:
    | "launching"
    | "ready"
    | "running"
    | "waiting_user"
    | "fenced"
    | "paused"
    | "closed"
    | "interrupted";
  pendingTools: number;
  pendingFollowUps: number;
  /** Lease the old child currently holds. */
  leaseGeneration: number;
  /** Timely lease the scheduler would grant to the continuation. */
  currentLeaseGeneration: number;
  /** True only after an actual settle (never `agent_end`). */
  settled: boolean;
}

export interface RolloverInput {
  runId: string;
  taskId: string;
  /** The attempt being replaced. */
  attemptId: string;
  sessionId: string;
  child: RolloverChildState;
  next: {
    attemptId: string;
    sessionId: string;
    generation: number;
  };
  /** The checkpoint captured before this decision, when one exists. */
  checkpoint?: ChildCheckpoint;
  counters: TaskCounters;
  budgets?: ExecutionBudgets;
  /** Usage crossed the hard limit; recover from actual workspace state. */
  overflowed?: boolean;
  now: number;
}

export type RolloverDecision =
  | {
      ok: true;
      action: "checkpoint_first";
      reason: string;
      /** A checkpoint must be requested at the next safe boundary. */
      requiresSafeBoundary: true;
    }
  | {
      ok: true;
      action: "relaunch";
      attemptId: string;
      sessionId: string;
      generation: number;
      checkpoint: ChildCheckpoint | null;
      recovery: "checkpoint" | "overflow_without_checkpoint";
      counters: TaskCounters;
      /** A checkpoint never completes the task. */
      completionClaimed: false;
      simultaneousWriters: false;
      instructions: string;
    }
  | {
      ok: true;
      action: "pause";
      reason: string;
      controls: readonly ("retry" | "unblock" | "cancel")[];
    }
  | { ok: false; code: "invalid" | "lease"; error: string };

function fail(code: "invalid" | "lease", error: string): { ok: false; code: "invalid" | "lease"; error: string } {
  return { ok: false, code, error };
}

/**
 * The only place a continuation may be launched. It refuses while anything is
 * in flight, refuses a stale lease holder and stops at the rollover budget.
 */
export function planRollover(input: RolloverInput): RolloverDecision {
  for (const [label, value] of [
    ["runId", input.runId],
    ["taskId", input.taskId],
    ["attemptId", input.attemptId],
    ["sessionId", input.sessionId],
    ["next.attemptId", input.next.attemptId],
    ["next.sessionId", input.next.sessionId],
  ] as const) {
    if (typeof value !== "string" || value.trim().length === 0 || value.length > 400) {
      return fail("invalid", `${label} is invalid`);
    }
  }
  if (input.next.attemptId === input.attemptId) {
    return fail("invalid", "a continuation must use a new attempt id");
  }
  if (!Number.isInteger(input.next.generation) || input.next.generation < 2) {
    return fail("invalid", "a continuation generation must increase");
  }
  if (
    !Number.isInteger(input.child.leaseGeneration) ||
    input.child.leaseGeneration !== input.child.currentLeaseGeneration
  ) {
    return fail("lease", "a stale lease holder cannot be rolled over");
  }
  if (
    !input.child.settled ||
    input.child.pendingTools > 0 ||
    input.child.pendingFollowUps > 0
  ) {
    return {
      ok: true,
      action: "checkpoint_first",
      reason: "the child is not quiescent; request the checkpoint after the tool/follow-up drain",
      requiresSafeBoundary: true,
    };
  }

  const budgets = input.budgets ?? DEFAULT_EXECUTION_BUDGETS;
  const rollovers = input.counters.rollovers + 1;
  if (rollovers > budgets.rolloverLimit) {
    return {
      ok: true,
      action: "pause",
      reason: "rollover budget exhausted",
      controls: ["retry", "unblock", "cancel"],
    };
  }

  const checkpoint = input.checkpoint ?? null;
  if (input.overflowed && !checkpoint) {
    return {
      ok: true,
      action: "relaunch",
      attemptId: input.next.attemptId,
      sessionId: input.next.sessionId,
      generation: input.next.generation,
      checkpoint: null,
      recovery: "overflow_without_checkpoint",
      counters: { ...input.counters, rollovers },
      completionClaimed: false,
      simultaneousWriters: false,
      instructions:
        "Recover from the actual workspace: re-read changed files, run the task checks, keep the task open and reconcile any partial effects before writing.",
    };
  }
  if (!checkpoint) {
    return {
      ok: true,
      action: "checkpoint_first",
      reason: "no checkpoint has been captured yet",
      requiresSafeBoundary: true,
    };
  }

  return {
    ok: true,
    action: "relaunch",
    attemptId: input.next.attemptId,
    sessionId: input.next.sessionId,
    generation: input.next.generation,
    checkpoint,
    recovery: "checkpoint",
    counters: { ...input.counters, rollovers },
    completionClaimed: false,
    simultaneousWriters: false,
    instructions:
      "Continue the same task and criteria from the checkpoint. Re-verify files against the workspace; the checkpoint is not acceptance.",
  };
}

/** Prepares a usage-triggered checkpoint request at a safe boundary. */
export function usageRolloverRequest(input: {
  assessment: UsageAssessment;
  taskId: string;
  attemptId: string;
}):
  | { action: "none" }
  | { action: "checkpoint"; reason: string; taskId: string; attemptId: string }
  | { action: "recover"; reason: string; taskId: string; attemptId: string } {
  if (input.assessment.level === "overflowed") {
    return {
      action: "recover",
      reason: input.assessment.reason,
      taskId: input.taskId,
      attemptId: input.attemptId,
    };
  }
  if (input.assessment.level === "checkpoint_due" || input.assessment.level === "rollover_due") {
    return {
      action: "checkpoint",
      reason: input.assessment.reason,
      taskId: input.taskId,
      attemptId: input.attemptId,
    };
  }
  if (input.assessment.level === "unknown") {
    return {
      action: "checkpoint",
      reason: "usage metadata is unknown; capture a checkpoint before a possible overflow",
      taskId: input.taskId,
      attemptId: input.attemptId,
    };
  }
  return { action: "none" };
}
