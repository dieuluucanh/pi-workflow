/**
 * Workflow Extension — automatic verify / accept / advance engine.
 *
 * One in-process Build child settles; this module decides what happens next.
 * The parent model is not in the loop: it never calls verify/accept for a
 * healthy row. It is woken only when a row blocks (repair budget exhausted,
 * provider failure, abort) or when the run completes, so it can explain.
 *
 * Ordering is load-bearing:
 *   report → diff gate → row checks → verify marker → final plan checks →
 *   accept → dispose → dispatch next (or complete)
 *
 * A failure journals `task.needsFix` and then re-enters `running` with the ONE
 * transition the reducer allows from `needs_fix`: `task.start` with the same
 * attemptId/sessionId. A warm child is re-prompted; a gone child is replaced
 * for the same attempt so the baseline stays attributable.
 *
 * Everything that is not a blocker/completion is display-only: the visible
 * record is the child transcript, not an LLM message.
 */

import type { OrchestratorRuntime, RuntimeView } from "./orchestrator-runtime.ts";
import { rowForTask } from "./orchestrator-state.ts";
import { MAX_REPAIR_ROUNDS } from "./orchestrator-state.ts";
import type { TaskId } from "./orchestrator-types.ts";
import {
  hasAttributableChange,
  type BaselineDiff,
} from "./orchestrator-workspace.ts";
import type { OrchestratorChildState } from "./orchestrator-child-controller.ts";
import type { FrozenTodoRow } from "./todo-snapshot.ts";

export const ADVANCE_SCHEMA_VERSION = 1 as const;

export interface AdvanceRowCheckResult {
  command: string;
  ok: boolean;
  output: string;
}

/** The subset of the child controller this engine drives. */
export interface AdvanceChild {
  state(): Pick<
    OrchestratorChildState,
    "phase" | "taskId" | "attemptId" | "sessionId" | "ref" | "total"
  >;
  /** Re-prompt the warm child for a repair round. False when it is gone. */
  reenter(repair: string): Promise<boolean>;
  abort(reason: string): Promise<void>;
  dispose(): Promise<void>;
  start(input: {
    taskId: string;
    attemptId: string;
    ref: string;
    total: number;
    sessionId: string;
    repair?: string;
  }): Promise<{ ok: boolean; error?: string }>;
}

export interface ChildSettledEvent {
  taskId: string;
  attemptId: string;
  summary: string;
  toolCalls: number;
  durationMs: number;
}

export interface AdvancePorts {
  runtime(): OrchestratorRuntime | undefined;
  child(): AdvanceChild | undefined;
  /** Capture the current baseline and diff it against the attempt baseline. */
  diff(
    taskId: string,
    expectedFiles: readonly string[],
  ): Promise<BaselineDiff | undefined>;
  runRowChecks(
    commands: readonly string[],
  ): Promise<{ ok: boolean; results: AdvanceRowCheckResult[]; failure?: string }>;
  runFinalChecks(): Promise<{ ok: boolean; failure?: string }>;
  dispatchNext(): Promise<{ ok: boolean; text: string }>;
  notify(message: string, level?: "info" | "warning"): void;
  /** Non-triggering context message; never starts a parent turn. */
  contextMessage?(message: string): void;
  /** Wakes the parent model: a blocked row or a completed run. */
  triggerTurn?(message: string): void;
  now?: () => number;
  onTodosChanged?(): void;
}

export interface AdvanceOutcome {
  ok: boolean;
  action:
    | "ignored"
    | "accepted"
    | "completed"
    | "repairing"
    | "blocked"
    | "paused"
    | "error";
  text: string;
}

const EVIDENCE_PREFIX = "evidence";

function bounded(value: string, max = 2_000): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function isTerminal(phase: RuntimeView["phase"]): boolean {
  return phase === "completed" || phase === "cancelled" || phase === "failed";
}

/** The failure text shown to the child on the repair round. */
export function buildRepairPrompt(input: {
  taskId: string;
  reason: string;
  summary?: string;
  round: number;
}): string {
  return [
    `Repair round ${input.round}/${MAX_REPAIR_ROUNDS} for ${input.taskId}.`,
    "",
    "The parent's mechanical verification failed:",
    input.reason.trim().slice(0, 3_000),
    "",
    input.summary?.trim()
      ? `Your previous summary was:\n${input.summary.trim().slice(0, 1_500)}\n`
      : "",
    "Fix the concrete failure, keep your task-local TODO list current, re-run the relevant checks, and finish with a short summary. Do not start over unless the failure requires it.",
  ].join("\n");
}

export interface OrchestratorAdvance {
  /** A natural child settle. Intentional aborts never reach this. */
  settled(event: ChildSettledEvent): Promise<AdvanceOutcome>;
  /** The child reported a terminal error (provider auth, crash, timeout). */
  failed(input: { taskId: string; attemptId: string; error: string }): Promise<AdvanceOutcome>;
  /** The user aborted the child; the row is blocked and the run pauses. */
  aborted(input: { taskId: string; attemptId: string; reason: string }): Promise<AdvanceOutcome>;
  /** Evidence currently held for a row, for `/orchestrator inspect`. */
  evidence(taskId: string): { evidenceId: string; workspaceRevision: string } | undefined;
}

export function createOrchestratorAdvance(
  ports: AdvancePorts,
): OrchestratorAdvance {
  const now = ports.now ?? (() => Date.now());
  const evidence = new Map<
    string,
    { evidenceId: string; workspaceRevision: string }
  >();

  const runtimeBound = ():
    | { ok: true; runtime: OrchestratorRuntime; view: RuntimeView }
    | { ok: false } => {
    const runtime = ports.runtime();
    const view = runtime?.view();
    if (!runtime || !view) return { ok: false };
    return { ok: true, runtime, view };
  };

  const pauseRun = async (
    runtime: OrchestratorRuntime,
    view: RuntimeView,
    reason: string,
  ): Promise<void> => {
    if (view.phase === "paused" || isTerminal(view.phase)) return;
    await runtime.applyEvent({
      type: "run.transition",
      runId: view.runId,
      now: now(),
      to: "paused",
    });
    void reason;
  };

  const block = async (
    runtime: OrchestratorRuntime,
    view: RuntimeView,
    taskId: string,
    reason: string,
    wake: boolean,
  ): Promise<AdvanceOutcome> => {
    const blocked = await runtime.applyEvent({
      type: "task.block",
      runId: view.runId,
      now: now(),
      taskId,
      reason: bounded(reason, 400),
    });
    const text = blocked.ok
      ? `${taskId} blocked: ${bounded(reason, 400)}`
      : `${taskId} could not be blocked: ${blocked.error}`;
    const after = runtime.view();
    if (after) await pauseRun(runtime, after, reason);
    ports.notify(text, "warning");
    if (wake) ports.triggerTurn?.(text);
    ports.onTodosChanged?.();
    return { ok: false, action: "blocked", text };
  };

  const repaired = async (
    runtime: OrchestratorRuntime,
    view: RuntimeView,
    taskId: string,
    reason: string,
    summary: string | undefined,
  ): Promise<AdvanceOutcome> => {
    const row = rowForTask(view.state, taskId);
    if (!row) return block(runtime, view, taskId, "the frozen row is missing", true);

    const needsFix = await runtime.applyEvent({
      type: "task.needsFix",
      runId: view.runId,
      now: now(),
      taskId,
      reason: bounded(reason, 1_000),
    });
    if (!needsFix.ok) {
      return block(runtime, view, taskId, `repair could not be journaled: ${needsFix.error}`, true);
    }
    const afterFix = runtime.view();
    if (!afterFix) return { ok: false, action: "error", text: "no run view" };
    const task = afterFix.state.tasks[taskId];
    if (!task) return { ok: false, action: "error", text: "the row disappeared" };

    // Budget exhaustion is reported by the reducer as `blocked`.
    if (task.state === "blocked") {
      await pauseRun(runtime, afterFix, reason);
      const text = `${taskId} is blocked after ${MAX_REPAIR_ROUNDS} repair round(s): ${bounded(reason, 300)}`;
      ports.notify(text, "warning");
      ports.triggerTurn?.(text);
      ports.onTodosChanged?.();
      try {
        await ports.child()?.dispose();
      } catch {
        /* ignore */
      }
      return { ok: false, action: "blocked", text };
    }

    const attemptId = task.attemptId ?? "";
    const sessionId = task.sessionId ?? "";
    if (!attemptId || !sessionId) {
      return block(runtime, afterFix, taskId, "the repair attempt identity is missing", true);
    }
    const reentered = await runtime.applyEvent({
      type: "task.start",
      runId: afterFix.runId,
      now: now(),
      taskId,
      attemptId,
      sessionId,
    });
    if (!reentered.ok) {
      return block(runtime, afterFix, taskId, `repair could not re-enter running: ${reentered.error}`, true);
    }

    const round = (task.repairRounds ?? 0) + 1;
    const prompt = buildRepairPrompt({
      taskId,
      reason,
      ...(summary ? { summary } : {}),
      round,
    });
    const child = ports.child();
    if (child) {
      const warm = await child.reenter(prompt).catch(() => false);
      if (warm) {
        ports.contextMessage?.(`${taskId}: repair round ${round} started on the warm child.`);
        return {
          ok: true,
          action: "repairing",
          text: `${taskId}: repair round ${round}`,
        };
      }
      try {
        await child.dispose();
      } catch {
        /* ignore */
      }
    }
    const fresh = ports.child();
    if (!fresh) return block(runtime, afterFix, taskId, "no child controller is bound", true);
    const started = await fresh.start({
      taskId,
      attemptId,
      ref: row.ref,
      total: afterFix.state.order.length,
      sessionId,
      repair: prompt,
    });
    if (!started.ok) {
      return block(runtime, afterFix, taskId, `the repair child could not start: ${started.error}`, true);
    }
    ports.contextMessage?.(`${taskId}: repair round ${round} started on a fresh child.`);
    return {
      ok: true,
      action: "repairing",
      text: `${taskId}: repair round ${round}`,
    };
  };

  const settled = async (event: ChildSettledEvent): Promise<AdvanceOutcome> => {
    const bound = runtimeBound();
    if (!bound.ok) return { ok: false, action: "ignored", text: "no run is bound" };
    const { runtime } = bound;
    const view = runtime.view()!;

    if (isTerminal(view.phase)) {
      return { ok: false, action: "ignored", text: `the run is ${view.phase}` };
    }
    if (view.phase === "paused") {
      // Pause wins: leave the row exactly as it is. Resume re-prompts the warm
      // child, whose next settle continues from here.
      return { ok: false, action: "paused", text: "the run is paused" };
    }
    const task = view.state.tasks[event.taskId];
    if (!task) return { ok: false, action: "ignored", text: "unknown task" };
    if (task.attemptId !== event.attemptId) {
      return { ok: false, action: "ignored", text: "a stale child settled" };
    }
    if (task.state === "accepted" || task.state === "blocked") {
      return { ok: false, action: "ignored", text: `${event.taskId} is ${task.state}` };
    }

    if (task.state === "running") {
      const reported = await runtime.applyEvent({
        type: "task.report",
        runId: view.runId,
        now: now(),
        taskId: event.taskId,
      });
      if (!reported.ok) {
        return { ok: false, action: "error", text: `report failed: ${reported.error}` };
      }
      ports.onTodosChanged?.();
    } else if (task.state !== "candidate") {
      return { ok: false, action: "ignored", text: `${event.taskId} is ${task.state}` };
    }

    const current = runtime.view()!;
    const row: FrozenTodoRow | undefined = rowForTask(current.state, event.taskId);
    if (!row) return { ok: false, action: "error", text: "the frozen row is missing" };

    // ── Diff gate ────────────────────────────────────────────────────
    let diff: BaselineDiff | undefined;
    try {
      diff = await ports.diff(event.taskId, row.expectedFiles);
    } catch {
      diff = undefined;
    }
    if (!diff) {
      return repaired(
        runtime,
        current,
        event.taskId,
        "the workspace diff could not be measured, so the child's work cannot be attributed",
        event.summary,
      );
    }
    if (row.expectedFiles.length > 0 && !hasAttributableChange(diff, row.expectedFiles)) {
      return repaired(
        runtime,
        current,
        event.taskId,
        `no workspace change detected for this row (expected: ${row.expectedFiles.join(", ")})`,
        event.summary,
      );
    }
    if (
      row.expectedFiles.length === 0 &&
      row.acceptanceChecks.length === 0 &&
      !diff.changed
    ) {
      return repaired(
        runtime,
        current,
        event.taskId,
        "no workspace change was observed. Implement the concrete deliverable for this row (or add a plan acceptance check), then finish again.",
        event.summary,
      );
    }

    // ── Row checks ───────────────────────────────────────────────────
    let checkResults: AdvanceRowCheckResult[] = [];
    if (row.acceptanceChecks.length > 0) {
      const checks = await ports.runRowChecks(row.acceptanceChecks);
      checkResults = checks.results;
      if (!checks.ok) {
        const failure = checks.failure ?? "a row check failed";
        return repaired(runtime, current, event.taskId, failure, event.summary);
      }
    }

    // Pause/abort wins over acceptance.
    const beforeAccept = runtime.view();
    if (!beforeAccept || beforeAccept.phase === "paused" || isTerminal(beforeAccept.phase)) {
      return { ok: false, action: "paused", text: "the run paused during verification" };
    }

    // ── Verify marker ────────────────────────────────────────────────
    const verified = await runtime.applyEvent({
      type: "task.verify",
      runId: beforeAccept.runId,
      now: now(),
      taskId: event.taskId,
    });
    if (!verified.ok) {
      return { ok: false, action: "error", text: `verify marker failed: ${verified.error}` };
    }
    const evidenceId = `${EVIDENCE_PREFIX}-${event.taskId}-${verified.value.revision}`.slice(0, 96);
    evidence.set(event.taskId, {
      evidenceId,
      workspaceRevision: diff.workspaceRevision,
    });

    // ── Final plan gate before the last acceptance ───────────────────
    const remaining = beforeAccept.state.order.filter(
      (id) => id !== event.taskId && beforeAccept.state.tasks[id]?.state !== "accepted",
    );
    if (remaining.length === 0) {
      const finalChecks = await ports.runFinalChecks();
      if (!finalChecks.ok) {
        evidence.delete(event.taskId);
        return repaired(
          runtime,
          beforeAccept,
          event.taskId,
          `final plan check failed: ${finalChecks.failure ?? "unknown"}`,
          event.summary,
        );
      }
    }

    // Pause again after the potentially long final checks.
    const beforeJournal = runtime.view();
    if (!beforeJournal || beforeJournal.phase === "paused" || isTerminal(beforeJournal.phase)) {
      return { ok: false, action: "paused", text: "the run paused during verification" };
    }

    const accepted = await runtime.applyEvent({
      type: "task.accept",
      runId: beforeJournal.runId,
      now: now(),
      taskId: event.taskId,
      evidenceId,
      workspaceRevision: diff.workspaceRevision,
    });
    if (!accepted.ok) {
      evidence.delete(event.taskId);
      return {
        ok: false,
        action: "error",
        text: `acceptance failed: ${accepted.error}`,
      };
    }
    evidence.delete(event.taskId);
    ports.onTodosChanged?.();

    // ── Dispose, then advance or complete ────────────────────────────
    try {
      await ports.child()?.dispose();
    } catch {
      /* ignore */
    }
    const after = runtime.view();
    if (!after) return { ok: true, action: "accepted", text: `${event.taskId} accepted` };
    if (after.phase === "paused") {
      return { ok: true, action: "paused", text: `${event.taskId} accepted; the run is paused` };
    }
    if (!after.nextTaskId) {
      const completed = await runtime.complete();
      const text = completed.ok
        ? `Every frozen row is accepted and the plan checks passed; run ${after.runId} is complete.`
        : `Every row is accepted, but the run could not complete: ${completed.error}`;
      ports.notify(text, completed.ok ? "info" : "warning");
      ports.triggerTurn?.(text);
      ports.onTodosChanged?.();
      return { ok: completed.ok, action: "completed", text };
    }
    const dispatched = await ports.dispatchNext();
    ports.contextMessage?.(
      `${event.taskId} accepted after ${checkResults.length} check(s); dispatching ${after.nextTaskId}.`,
    );
    if (!dispatched.ok) {
      return {
        ok: false,
        action: "error",
        text: `accepted, but the next row could not start: ${dispatched.text}`,
      };
    }
    return { ok: true, action: "accepted", text: dispatched.text };
  };

  const failed = async (input: {
    taskId: string;
    attemptId: string;
    error: string;
  }): Promise<AdvanceOutcome> => {
    const bound = runtimeBound();
    if (!bound.ok) return { ok: false, action: "ignored", text: "no run is bound" };
    const view = bound.view;
    const task = view.state.tasks[input.taskId];
    if (!task || task.attemptId !== input.attemptId) {
      return { ok: false, action: "ignored", text: "a stale child failed" };
    }
    if (task.state === "accepted" || task.state === "blocked") {
      return { ok: false, action: "ignored", text: `${input.taskId} is ${task.state}` };
    }
    try {
      await ports.child()?.dispose();
    } catch {
      /* ignore */
    }
    return block(bound.runtime, view, input.taskId, input.error, true);
  };

  const aborted = async (input: {
    taskId: string;
    attemptId: string;
    reason: string;
  }): Promise<AdvanceOutcome> => {
    const bound = runtimeBound();
    if (!bound.ok) return { ok: false, action: "ignored", text: "no run is bound" };
    const view = bound.view;
    const task = view.state.tasks[input.taskId];
    if (!task || task.attemptId !== input.attemptId) {
      return { ok: false, action: "ignored", text: "a stale child aborted" };
    }
    if (task.state === "accepted") {
      return { ok: false, action: "ignored", text: "the row is accepted" };
    }
    // A user abort is not a blocker to explain: no parent turn.
    return block(bound.runtime, view, input.taskId, `aborted: ${input.reason}`, false);
  };

  return {
    settled,
    failed,
    aborted,
    evidence(taskId: TaskId) {
      return evidence.get(taskId);
    },
  };
}
