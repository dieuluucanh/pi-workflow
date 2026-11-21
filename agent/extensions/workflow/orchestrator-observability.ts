/**
 * Workflow Extension — observability, retention and resource budgets (step 41).
 *
 * Three separate concerns:
 *
 *  1. **Usage accounting with stable keys.** A record is keyed by
 *     `sessionId:messageId`, so a reload/replay cannot double-count. These
 *     totals are deliberately separate from the SDK's session totals: adding
 *     both is double billing, so the boundary is explicit.
 *  2. **A bounded status projection.** Accepted/remaining work, the active
 *     child/link and its local progress, real models/context usage,
 *     repair/rollover counters, waiting/blocked reasons and verification
 *     evidence — all as bounded rows, not raw transcripts.
 *  3. **Explicit retention.** Cleanup never deletes active work, unaccepted
 *     evidence or session history by surprise, and a configured spend/time cap
 *     pauses safely when the real cost is unknown (unknown is not zero).
 *
 * Pure: the caller supplies usage records and retention candidates.
 */

import type { RunState } from "./orchestrator-state.ts";
import type { Verdict } from "./orchestrator-types.ts";

export const OBSERVABILITY_SCHEMA_VERSION = 1 as const;
export const MAX_STATUS_ROWS = 40;
export const MAX_STATUS_TEXT = 4_000;
export const MAX_USAGE_RECORDS = 100_000;

// ── Usage ledger ─────────────────────────────────────────────────────

export interface UsageRecord {
  sessionId: string;
  messageId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  /** null/undefined = unknown, never treated as zero. */
  costUsd?: number | null;
  activeMs?: number;
  at: number;
}

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  costUsd: number;
  knownCostRecords: number;
  unknownCostRecords: number;
  unknownCostSessions: string[];
  activeMs: number;
  records: number;
  duplicateRecords: number;
  /** Totals never include the SDK's own session counters. */
  accountingBoundary: "workflow_messages_only";
}

export interface SessionUsage {
  sessionId: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  costUsd: number;
  costKnown: boolean;
  activeMs: number;
  records: number;
}

export interface UsageLedger {
  record(record: UsageRecord): { ok: true; duplicate: boolean } | { ok: false; error: string };
  totals(): UsageTotals;
  bySession(): Record<string, SessionUsage>;
  records(): UsageRecord[];
}

function emptyTotals(duplicates: number): UsageTotals {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    costUsd: 0,
    knownCostRecords: 0,
    unknownCostRecords: 0,
    unknownCostSessions: [],
    activeMs: 0,
    records: 0,
    duplicateRecords: duplicates,
    accountingBoundary: "workflow_messages_only",
  };
}

function validRecord(record: UsageRecord): string | undefined {
  for (const key of ["sessionId", "messageId", "model"] as const) {
    const value = record[key];
    if (typeof value !== "string" || value.length === 0 || value.length > 400) {
      return `invalid ${key}`;
    }
  }
  for (const key of ["inputTokens", "outputTokens"] as const) {
    if (typeof record[key] !== "number" || !Number.isFinite(record[key]) || record[key] < 0) {
      return `invalid ${key}`;
    }
  }
  if (record.cachedInputTokens !== undefined && (!Number.isFinite(record.cachedInputTokens) || record.cachedInputTokens < 0)) {
    return "invalid cachedInputTokens";
  }
  if (record.costUsd !== undefined && record.costUsd !== null) {
    if (!Number.isFinite(record.costUsd) || record.costUsd < 0) return "invalid costUsd";
  }
  if (record.activeMs !== undefined && (!Number.isFinite(record.activeMs) || record.activeMs < 0)) {
    return "invalid activeMs";
  }
  return undefined;
}

export function createUsageLedger(): UsageLedger {
  const records = new Map<string, UsageRecord>();
  let duplicates = 0;

  const ledger: UsageLedger = {
    record(record) {
      const error = validRecord(record);
      if (error) return { ok: false, error };
      const key = `${record.sessionId}:${record.messageId}`;
      if (records.has(key)) {
        duplicates += 1;
        return { ok: true, duplicate: true };
      }
      records.set(key, { ...record });
      if (records.size > MAX_USAGE_RECORDS) {
        // Bound memory without corrupting keys: drop the oldest inserted.
        const oldest = records.keys().next().value;
        if (oldest) records.delete(oldest);
      }
      return { ok: true, duplicate: false };
    },

    totals() {
      const totals = emptyTotals(duplicates);
      const unknownSessions = new Set<string>();
      for (const record of records.values()) {
        totals.records += 1;
        totals.inputTokens += record.inputTokens;
        totals.outputTokens += record.outputTokens;
        totals.cachedInputTokens += record.cachedInputTokens ?? 0;
        totals.activeMs += record.activeMs ?? 0;
        if (typeof record.costUsd === "number" && Number.isFinite(record.costUsd)) {
          totals.costUsd += record.costUsd;
          totals.knownCostRecords += 1;
        } else {
          totals.unknownCostRecords += 1;
          unknownSessions.add(record.sessionId);
        }
      }
      totals.unknownCostSessions = [...unknownSessions].sort((left, right) => left.localeCompare(right));
      return totals;
    },

    bySession() {
      const out: Record<string, SessionUsage> = {};
      for (const record of records.values()) {
        const entry = out[record.sessionId] ?? {
          sessionId: record.sessionId,
          inputTokens: 0,
          outputTokens: 0,
          cachedInputTokens: 0,
          costUsd: 0,
          costKnown: true,
          activeMs: 0,
          records: 0,
        };
        entry.records += 1;
        entry.inputTokens += record.inputTokens;
        entry.outputTokens += record.outputTokens;
        entry.cachedInputTokens += record.cachedInputTokens ?? 0;
        entry.activeMs += record.activeMs ?? 0;
        if (typeof record.costUsd === "number" && Number.isFinite(record.costUsd)) {
          entry.costUsd += record.costUsd;
        } else {
          entry.costKnown = false;
        }
        out[record.sessionId] = entry;
      }
      return out;
    },

    records() {
      return [...records.values()].map((record) => ({ ...record }));
    },
  };
  return ledger;
}

/**
 * The SDK reports its own session totals. This helper exists so a caller can
 * show both without adding them: summing would double-bill the same messages.
 */
export function describeUsageSources(input: {
  workflowTotalTokens: number;
  sdkSessionTotalTokens: number | null;
}): { sumIsSafe: false; explanation: string; separate: { workflow: number; sdk: number | null } } {
  return {
    sumIsSafe: false,
    explanation:
      "Workflow usage is keyed per message; SDK session totals already include those messages, so adding them double-bills. Show them separately.",
    separate: { workflow: input.workflowTotalTokens, sdk: input.sdkSessionTotalTokens },
  };
}

// ── Caps ─────────────────────────────────────────────────────────────

export interface ResourceLimits {
  costLimitUsd?: number | null;
  activeTimeLimitMinutes?: number | null;
}

export type CapStatus = "ok" | "exceeded" | "unknown";

export interface CapCheck {
  status: CapStatus;
  pauseRequired: boolean;
  reasons: string[];
  /** Unknown is visible, never silently treated as zero. */
  costUnknown: boolean;
  activeTimeUnknown: boolean;
}

/** A configured cap pauses when the actual spend/time cannot be established. */
export function checkResourceCaps(usage: UsageTotals, limits: ResourceLimits): CapCheck {
  const reasons: string[] = [];
  let status: CapStatus = "ok";
  const costLimit = limits.costLimitUsd;
  const timeLimit = limits.activeTimeLimitMinutes;

  if (typeof costLimit === "number" && Number.isFinite(costLimit) && costLimit >= 0) {
    if (usage.unknownCostRecords > 0) {
      status = "unknown";
      reasons.push(
        `cost is unknown for ${usage.unknownCostRecords} message(s) (${usage.unknownCostSessions.join(", ")}); a configured cap cannot be proven safe`,
      );
    } else if (usage.costUsd > costLimit) {
      status = "exceeded";
      reasons.push(`cost $${usage.costUsd.toFixed(4)} exceeds the $${costLimit.toFixed(2)} cap`);
    }
  }
  if (typeof timeLimit === "number" && Number.isFinite(timeLimit) && timeLimit >= 0) {
    const minutes = usage.activeMs / 60_000;
    if (usage.activeMs === 0) {
      reasons.push("active time is not reported; treat it as unknown rather than zero");
      if (status === "ok") status = "unknown";
    } else if (minutes > timeLimit) {
      status = "exceeded";
      reasons.push(`active time ${minutes.toFixed(1)}m exceeds the ${timeLimit.toFixed(0)}m cap`);
    }
  }

  return {
    status,
    pauseRequired: status !== "ok",
    reasons,
    costUnknown: usage.unknownCostRecords > 0,
    activeTimeUnknown: usage.activeMs === 0,
  };
}

// ── Status projection ────────────────────────────────────────────────

export interface ChildStatusInput {
  taskId: string;
  attemptId?: string;
  phase: string;
  /** Opaque tab/window reference; presentation only. */
  link?: string;
  model?: string;
  tokensUsed?: number;
  contextWindow?: number;
  /** Child-local progress, not roadmap acceptance. */
  localProgress?: string;
  waitingReason?: string;
  blockedReason?: string;
}

export interface EvidenceStatusInput {
  taskId: string;
  evidenceId: string;
  verdict: Verdict;
  checksPassed: number;
  checksFailed: number;
  workspaceRevision: string;
}

export interface StatusRow {
  label: string;
  value: string;
  tone: "info" | "ok" | "warn" | "error";
  childId?: string;
}

export interface RunStatus {
  schemaVersion: typeof OBSERVABILITY_SCHEMA_VERSION;
  rows: StatusRow[];
  text: string;
  truncated: boolean;
  usage: UsageTotals;
  caps: CapCheck;
}

function bounded(value: string, max = 300): string {
  return value.length > max ? `${value.slice(0, max - 20)}…[truncated]` : value;
}

export function buildRunStatus(input: {
  state: RunState;
  children: readonly ChildStatusInput[];
  evidence: readonly EvidenceStatusInput[];
  usage: UsageTotals;
  limits?: ResourceLimits;
  models?: { orchestrator?: string; builder?: string };
  now: number;
}): RunStatus {
  const state = input.state;
  const counts = { accepted: 0, remaining: 0, blocked: 0, cancelled: 0 };
  for (const taskId of state.order) {
    const task = state.tasks[taskId];
    if (!task) continue;
    if (task.state === "accepted") counts.accepted += 1;
    else if (task.state === "blocked") counts.blocked += 1;
    else if (task.state === "cancelled" || task.state === "superseded") counts.cancelled += 1;
    else counts.remaining += 1;
  }
  const caps = checkResourceCaps(input.usage, input.limits ?? {});
  const rows: StatusRow[] = [
    {
      label: "Roadmap",
      value: `${counts.accepted}/${state.order.length} accepted · ${counts.remaining} remaining · ${counts.blocked} blocked · ${counts.cancelled} cancelled`,
      tone: counts.blocked > 0 ? "warn" : "info",
    },
    { label: "Phase", value: `${state.phase} · revision ${state.revision}`, tone: "info" },
  ];
  if (state.blockedReason) {
    rows.push({ label: "Blocked", value: bounded(state.blockedReason), tone: "error" });
  }
  if (input.models?.orchestrator || input.models?.builder) {
    rows.push({
      label: "Models",
      value: `${input.models.orchestrator ?? "unknown"} (orch) / ${input.models.builder ?? "unknown"} (build)`,
      tone: "info",
    });
  }

  for (const child of input.children.slice(0, 20)) {
    const context =
      child.tokensUsed !== undefined && child.contextWindow !== undefined && child.contextWindow > 0
        ? ` · ${child.tokensUsed}/${child.contextWindow} ctx`
        : "";
    rows.push({
      label: `Child ${child.taskId}`,
      value: bounded(
        `${child.phase}${child.localProgress ? ` · ${child.localProgress}` : ""}${context}${
          child.link ? ` · ${child.link}` : ""
        }${child.waitingReason ? ` · waiting: ${child.waitingReason}` : ""}${
          child.blockedReason ? ` · blocked: ${child.blockedReason}` : ""
        }`,
      ),
      tone: child.blockedReason !== undefined ? "error" : child.waitingReason !== undefined ? "warn" : "info",
      childId: child.taskId,
    });
    const task = state.tasks[child.taskId];
    if (task && (task.counters.repairRounds > 0 || task.counters.rollovers > 0)) {
      rows.push({
        label: `  ${child.taskId} counters`,
        value: `repairs ${task.counters.repairRounds} · rollovers ${task.counters.rollovers} · no-progress ${task.counters.noProgress}`,
        tone: "warn",
        childId: child.taskId,
      });
    }
  }
  for (const evidence of input.evidence.slice(0, 20)) {
    rows.push({
      label: `Evidence ${evidence.taskId}`,
      value: bounded(
        `${evidence.verdict} · ${evidence.checksPassed} passed / ${evidence.checksFailed} failed · workspace ${evidence.workspaceRevision}`,
      ),
      tone: evidence.verdict === "accepted" ? "ok" : "warn",
    });
  }
  rows.push({
    label: "Usage",
    value: `$${input.usage.costUsd.toFixed(4)} known · ${input.usage.unknownCostRecords} unknown cost · ${input.usage.activeMs}ms active · ${input.usage.records} record(s)`,
    tone: input.usage.unknownCostRecords > 0 ? "warn" : "info",
  });
  if (caps.status !== "ok") {
    rows.push({ label: "Caps", value: bounded(caps.reasons.join("; ") || caps.status), tone: "error" });
  }

  const boundedRows = rows.slice(0, MAX_STATUS_ROWS);
  const text = bounded(
    boundedRows.map((row) => `${row.label}: ${row.value}`).join("\n"),
    MAX_STATUS_TEXT,
  );
  return {
    schemaVersion: OBSERVABILITY_SCHEMA_VERSION,
    rows: boundedRows,
    text,
    truncated: rows.length > boundedRows.length,
    usage: input.usage,
    caps,
  };
}

/** After a child closes, its status rows are dropped; no stale rows remain. */
export function rebindStatus(rows: readonly StatusRow[], liveChildIds: readonly string[]): StatusRow[] {
  const live = new Set(liveChildIds);
  return rows.filter((row) => row.childId === undefined || live.has(row.childId));
}

// ── Retention ────────────────────────────────────────────────────────

export type RetentionKind = "artifact" | "transcript-preview" | "ipc-queue" | "evidence" | "session-history";

export interface RetentionItem {
  id: string;
  kind: RetentionKind;
  bytes: number;
  createdAt: number;
  /** Active work is never deleted. */
  active: boolean;
  /** Acceptance evidence that has not been accepted is never deleted. */
  accepted: boolean;
  pinned?: boolean;
}

export interface RetentionPolicy {
  maxTotalBytes: number;
  maxPreviews: number;
  maxQueueEntries: number;
  maxAgeMs: number;
  /** Accepted evidence may be cleaned only after the run is complete. */
  runComplete: boolean;
}

export interface RetentionPlan {
  keep: string[];
  delete: string[];
  protected: Array<{ id: string; reason: string }>;
  bytesFreed: number;
  reasons: string[];
}

/**
 * Plans an explicit cleanup. Protected items (active work, unaccepted evidence,
 * session history, pinned items) are never candidates; the caller executes the
 * returned list instead of guessing.
 */
export function planRetention(
  items: readonly RetentionItem[],
  policy: RetentionPolicy,
  now: number,
): RetentionPlan {
  const protectedItems: RetentionPlan["protected"] = [];
  const candidates: RetentionItem[] = [];
  for (const item of items) {
    if (item.pinned) {
      protectedItems.push({ id: item.id, reason: "pinned" });
      continue;
    }
    if (item.kind === "session-history") {
      protectedItems.push({ id: item.id, reason: "session history is retained" });
      continue;
    }
    if (item.active) {
      protectedItems.push({ id: item.id, reason: "active work" });
      continue;
    }
    if (item.kind === "evidence" && (!item.accepted || !policy.runComplete)) {
      protectedItems.push({
        id: item.id,
        reason: policy.runComplete ? "unaccepted evidence" : "evidence retained until the run completes",
      });
      continue;
    }
    candidates.push(item);
  }

  const deletable = new Set<string>();
  const sorted = [...candidates].sort((left, right) => left.createdAt - right.createdAt);
  for (const item of sorted) {
    if (policy.maxAgeMs > 0 && now - item.createdAt > policy.maxAgeMs) deletable.add(item.id);
  }

  let previews = items.filter((item) => item.kind === "transcript-preview" && !deletable.has(item.id)).length;
  let queues = items.filter((item) => item.kind === "ipc-queue" && !deletable.has(item.id)).length;
  for (const item of sorted) {
    if (deletable.has(item.id)) continue;
    if (item.kind === "transcript-preview" && previews > policy.maxPreviews) {
      deletable.add(item.id);
      previews -= 1;
    } else if (item.kind === "ipc-queue" && queues > policy.maxQueueEntries) {
      deletable.add(item.id);
      queues -= 1;
    }
  }

  let totalBytes = items
    .filter((item) => !deletable.has(item.id))
    .reduce((sum, item) => sum + Math.max(0, item.bytes), 0);
  for (const item of sorted) {
    if (totalBytes <= policy.maxTotalBytes) break;
    if (deletable.has(item.id)) {
      totalBytes -= Math.max(0, item.bytes);
      continue;
    }
    deletable.add(item.id);
    totalBytes -= Math.max(0, item.bytes);
  }

  const deleteList = [...deletable];
  const keep = items.filter((item) => !deletable.has(item.id)).map((item) => item.id);
  const bytesFreed = items
    .filter((item) => deletable.has(item.id))
    .reduce((sum, item) => sum + Math.max(0, item.bytes), 0);
  const reasons: string[] = [];
  if (deleteList.length > 0) reasons.push(`explicit cleanup of ${deleteList.length} item(s)`);
  if (policy.maxTotalBytes > 0 && totalBytes > policy.maxTotalBytes) {
    reasons.push("the byte cap could not be met without deleting protected items");
  }
  return { keep, delete: deleteList, protected: protectedItems, bytesFreed, reasons };
}
