/**
 * Workflow Extension — budget, usage and rollover runtime (step 19).
 *
 * Usage is the SDK's report; it is not authority. This module makes usage
 * durable and idempotent so a reload/compaction cannot double-count or reset a
 * limit, and it only *proposes* a rollover: the attempt.rollover transition is
 * still applied by the reducer, which preserves the task counters.
 *
 * Guarantees:
 *   - a duplicate `(sessionId,messageId)` is reported, never counted twice;
 *   - usage survives a reload (journal `run.control` records are replayed);
 *   - an unknown cost with a configured cap pauses instead of assuming $0;
 *   - a rollover needs a SETTLED child, a new attempt id and a better lease;
 *   - rollover never resets repair/no-progress/rollover counters.
 */

import {
  DEFAULT_EXECUTION_BUDGETS,
  type ExecutionBudgets,
} from "./orchestrator-types.ts";
import {
  createUsageLedger,
  checkResourceCaps,
  type CapCheck,
  type ResourceLimits,
  type UsageRecord,
  type UsageTotals,
} from "./orchestrator-observability.ts";
import {
  assessUsage,
  planRollover,
  type ChildCheckpoint,
  type RolloverChildState,
  type RolloverDecision,
  type UsageAssessment,
} from "./orchestrator-rollover.ts";
import type { OrchestratorRuntime } from "./orchestrator-runtime.ts";
import type { TaskCounters } from "./orchestrator-state.ts";

export const BUDGET_RUNTIME_SCHEMA_VERSION = 1 as const;

export interface BudgetRuntimePorts {
  runtime: () => OrchestratorRuntime | undefined;
  limits?: ResourceLimits;
  budgets?: ExecutionBudgets;
  now?: () => number;
}

export type BudgetRuntimeResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: "invalid" | "journal" | "budget" | "lease" | "state"; error: string };

export interface RolloverRequest {
  taskId: string;
  attemptId: string;
  sessionId: string;
  child: RolloverChildState;
  next: { attemptId: string; sessionId: string; generation: number };
  counters: TaskCounters;
  /** Captured at a safe boundary before the decision; required to relaunch. */
  checkpoint?: ChildCheckpoint;
  overflowed?: boolean;
}

export interface BudgetRuntime {
  /** Replays journaled usage; safe to call on every reload. */
  restore(): Promise<BudgetRuntimeResult<{ records: number }>>;
  recordUsage(record: UsageRecord): Promise<BudgetRuntimeResult<{ duplicate: boolean }>>;
  totals(): UsageTotals;
  caps(): CapCheck;
  assess(input: {
    tokensUsed: number;
    contextWindow?: number | null;
    reserveTokens?: number | null;
    confidence?: "high" | "medium" | "low";
    activeTool?: boolean;
    activeShell?: boolean;
    settled?: boolean;
  }): UsageAssessment;
  /** Plans and (only when safe) applies a continuation attempt. */
  rollover(
    request: RolloverRequest,
  ): Promise<BudgetRuntimeResult<{ decision: RolloverDecision; applied: boolean }>>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function createBudgetRuntime(ports: BudgetRuntimePorts): BudgetRuntime {
  const now = ports.now ?? (() => Date.now());
  const ledger = createUsageLedger();
  const budgets = ports.budgets ?? DEFAULT_EXECUTION_BUDGETS;
  let restored = false;

  const runtime: BudgetRuntime = {
    async restore() {
      if (restored) return { ok: true, value: { records: ledger.records().length } };
      restored = true;
      const owner = ports.runtime();
      if (!owner) return { ok: true, value: { records: 0 } };
      const events = await owner.journalEvents();
      if (!events.ok) return { ok: false, code: "journal", error: events.error };
      for (const event of events.value) {
        if (event.type !== "run.control" || !isRecord(event.payload)) continue;
        if (event.payload.action !== "usage" || !isRecord(event.payload.record)) continue;
        // SAFETY: the record is re-validated by the ledger before it counts.
        ledger.record(event.payload.record as unknown as UsageRecord);
      }
      return { ok: true, value: { records: ledger.records().length } };
    },

    async recordUsage(record) {
      const owner = ports.runtime();
      if (!owner) return { ok: false, code: "state", error: "no run is bound" };
      const first = ledger.record(record);
      if (!first.ok) return { ok: false, code: "invalid", error: first.error };
      if (first.duplicate) return { ok: true, value: { duplicate: true } };
      const journaled = await owner.appendJournal(
        "run.control",
        { action: "usage", record },
        `usage-${record.sessionId}-${record.messageId}`,
      );
      if (!journaled.ok) {
        // Undo is impossible on the ledger; report the failure so the caller
        // retries. The ledger already dropped the duplicate, not the record.
        return { ok: false, code: "journal", error: journaled.error };
      }
      return { ok: true, value: { duplicate: false } };
    },

    totals: () => ledger.totals(),
    caps: () => checkResourceCaps(ledger.totals(), ports.limits ?? {}),

    assess(input) {
      return assessUsage({
        tokensUsed: input.tokensUsed,
        ...(input.contextWindow === undefined ? {} : { contextWindow: input.contextWindow }),
        ...(input.reserveTokens === undefined ? {} : { reserveTokens: input.reserveTokens }),
        ...(input.confidence === undefined ? {} : { confidence: input.confidence }),
        ...(input.activeTool === undefined ? {} : { activeTool: input.activeTool }),
        ...(input.activeShell === undefined ? {} : { activeShell: input.activeShell }),
        ...(input.settled === undefined ? {} : { settled: input.settled }),
      });
    },

    async rollover(request) {
      const owner = ports.runtime();
      if (!owner) return { ok: false, code: "state", error: "no run is bound" };
      const view = owner.view();
      if (!view) return { ok: false, code: "state", error: "no run is bound" };
      const decision = planRollover({
        runId: view.runId,
        taskId: request.taskId,
        attemptId: request.attemptId,
        sessionId: request.sessionId,
        child: request.child,
        next: request.next,
        counters: request.counters,
        budgets,
        ...(request.checkpoint === undefined ? {} : { checkpoint: request.checkpoint }),
        ...(request.overflowed === undefined ? {} : { overflowed: request.overflowed }),
        now: now(),
      });
      if (!decision.ok) {
        return {
          ok: false,
          code: decision.code === "lease" ? "lease" : "invalid",
          error: decision.error,
        };
      }
      if (decision.action !== "relaunch") {
        // Checkpoint-first and pause are decisions, not transitions.
        return { ok: true, value: { decision, applied: false } };
      }
      const applied = await owner.applyEvent({
        type: "attempt.rollover",
        runId: view.runId,
        now: now(),
        taskId: request.taskId,
        attemptId: request.attemptId,
        newAttemptId: decision.attemptId,
        sessionId: decision.sessionId,
        generation: decision.generation,
      });
      if (!applied.ok) {
        return { ok: false, code: "state", error: applied.error };
      }
      return { ok: true, value: { decision, applied: true } };
    },
  };

  return runtime;
}

/** A bounded, display-only usage summary for status output. */
export function usageSummary(totals: UsageTotals): string {
  const cost =
    totals.unknownCostRecords > 0
      ? `$${totals.costUsd.toFixed(4)} + ${totals.unknownCostRecords} unknown`
      : `$${totals.costUsd.toFixed(4)}`;
  return `${totals.records} message(s) · ${totals.inputTokens} in / ${totals.outputTokens} out · ${cost}`;
}
