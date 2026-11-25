/**
 * Workflow Extension — in-process Build child lifecycle.
 *
 * One child at a time. The controller owns start, settle, pause, resume, abort,
 * timeout and user steering. It never verifies or accepts a row; the parent
 * orchestration service does that from `onSettled`.
 */

import { formatActionLabel } from "./review.ts";
import type { ReviewLineKind } from "./review.ts";
import type { InProcessChildSession } from "./in-process-child.ts";
import type { ChildModelRef, ChildRuntimeStats } from "./child-stats.ts";
import {
  isPolicyRefusal,
  normalizePolicyRefusals,
} from "./orchestrator-report.ts";
import type { TodoItem } from "./utils.ts";

export type OrchestratorChildPhase =
  | "idle"
  | "starting"
  | "running"
  | "paused"
  | "settling"
  | "disposed";

export interface OrchestratorChildState {
  phase: OrchestratorChildPhase;
  taskId?: string;
  attemptId?: string;
  sessionId?: string;
  /** The model the child ACTUALLY runs (follows a live switch). */
  modelLabel?: string;
  /** Thinking level of the live child, when the session reports one. */
  thinking?: string;
  /** Context window usage and cumulative tokens, when observable. */
  stats?: ChildRuntimeStats;
  ref?: string;
  total?: number;
  startedAt?: number;
  /** Set while paused, so elapsed time freezes instead of draining. */
  pausedAt?: number;
  /** A pause request is still settling; the child is warm but not idle yet. */
  pausePending?: boolean;
  /** A provider retry/backoff is active; the run has not failed. */
  retrying?: boolean;
  lastTool?: string;
  todos: TodoItem[];
  lastError?: string;
  /** When the current settle started; the report has a bounded window. */
  settlingAt?: number;
  /** Bounded policy refusals the child hit (commit/folder/write/read/shell). */
  policyRefusals?: string[];
}

export interface OrchestratorChildOp {
  op: "new";
  kind: ReviewLineKind;
  text: string;
}

export interface CreateChildInput {
  sessionId: string;
  taskId: string;
  attemptId: string;
  ref: string;
  total: number;
  /** Absolute root this row targets; defaults to the session root. */
  cwd?: string;
  /** The declared workspace behind `cwd`, for the prompt only. */
  workspace?: { id: string; root: string };
}

export interface StartChildInput extends CreateChildInput {
  repair?: string;
}

export interface ChildSettledInput {
  taskId: string;
  attemptId: string;
  summary: string;
  toolCalls: number;
  durationMs: number;
  /** The child's final task-local list, snapshotted for the report. */
  todos: TodoItem[];
  /** Policy refusals observed while the child ran (bounded). */
  policyRefusals: string[];
}

export interface OrchestratorChildPorts {
  create: (input: CreateChildInput) => Promise<{
    ok: boolean;
    child?: InProcessChildSession;
    modelLabel?: string;
    error?: string;
  }>;  buildPrompt: (input: {
    taskId: string;
    attemptId: string;
    ref: string;
    total: number;
    cwd?: string;
    workspace?: { id: string; root: string };
    repair?: string;
  }) => string;
  onOps?: (ops: OrchestratorChildOp[]) => void;
  onState?: (state: OrchestratorChildState) => void;
  onSettled?: (input: ChildSettledInput) => void | Promise<void>;
  onError?: (input: {
    taskId: string;
    attemptId: string;
    error: string;
    todos: TodoItem[];
    policyRefusals: string[];
  }) => void | Promise<void>;
  onAborted?: (input: {
    taskId: string;
    attemptId: string;
    reason: string;
    /** False for a parent-tool abort: the tool result is the notification. */
    notify: boolean;
    todos: TodoItem[];
    policyRefusals: string[];
  }) => void | Promise<void>;
  /**
   * The model the parent currently wants this child to run (the effective
   * Builder role, profile overlay applied). Read at start/resume so a profile
   * switch that raced child creation is still honoured.
   */
  desiredModel?: () => { provider: string; id: string; thinking?: string } | undefined;
  now?: () => number;
  timeoutMs?: number;
  maxToolCalls?: number;
  /** Bound on recording a settle report before the child is failed/released. */
  settleReportTimeoutMs?: number;
}

export interface OrchestratorChildController {
  state(): OrchestratorChildState;
  /**
   * Create the child session before any durable transition, so a missing
   * Builder model/provider auth fails closed without marking the row running.
   * A successful preparation is consumed by the next `start`.
   */
  prepare(input: CreateChildInput): Promise<{
    ok: boolean;
    modelLabel?: string;
    error?: string;
  }>;
  /** Dispose a prepared-but-never-started child (e.g. the journal failed). */
  discardPrepared(): void;
  start(input: StartChildInput): Promise<{ ok: boolean; error?: string }>;
  /**
   * Switch the live (or prepared) child to `ref` WITHOUT aborting it.
   * Serialized with resume so a prompt never runs on a half-switched session.
   * Never fails the row: a refusal is reported to the caller for display only.
   */
  applyModel(ref: {
    provider: string;
    id: string;
    thinking?: string;
  }): Promise<{
    ok: boolean;
    changed?: boolean;
    model?: ChildModelRef;
    error?: string;
  }>;
  /**
   * Re-prompt the warm child for a repair round after a failed verification.
   * Returns false when the session is gone, so the caller can replace it.
   */
  reenter(repair: string): Promise<boolean>;
  pause(): Promise<boolean>;
  resume(note?: string): Promise<boolean>;
  /** Abort the live child. `notify:false` suppresses the parent wake. */
  abort(reason: string, opts?: { notify?: boolean }): Promise<void>;
  dispose(): Promise<void>;
  deliver(text: string): Promise<{ ok: boolean; queued?: boolean; error?: string }>;
}

export const DEFAULT_CHILD_TIMEOUT_MS = 45 * 60_000;
export const DEFAULT_SETTLE_REPORT_TIMEOUT_MS = 15_000;
export const MAX_CHILD_TOOL_CALLS = 300;
/** Refusals kept for the report; the last few are the relevant ones. */
const MAX_CHILD_POLICY_REFUSALS = 3;
const MAX_TOOL_ERROR_CHARS = 2_000;

function assistantText(messages: unknown): string {
  if (!Array.isArray(messages)) return "";
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as
      | { role?: string; content?: unknown }
      | undefined;
    if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
    const text = message.content
      .filter(
        (block): block is { type: "text"; text: string } =>
          !!block &&
          typeof block === "object" &&
          (block as { type?: unknown }).type === "text" &&
          typeof (block as { text?: unknown }).text === "string",
      )
      .map((block) => block.text)
      .join("\n")
      .trim();
    if (text) return text.slice(0, 8_000);
  }
  return "";
}

/**
 * Bounded text for a failed tool result. Pi's blocked-tool result carries the
 * refusal in `content[].text`; shells may use `output`; anything else is
 * stringified defensively so a policy refusal is never silently dropped.
 */
function toolErrorText(result: unknown): string {
  if (!result || typeof result !== "object") return "";
  const record = result as { content?: unknown; output?: unknown; text?: unknown };
  if (Array.isArray(record.content)) {
    const text = record.content
      .map((block) =>
        block &&
        typeof block === "object" &&
        (block as { type?: unknown }).type === "text" &&
        typeof (block as { text?: unknown }).text === "string"
          ? (block as { text: string }).text
          : "",
      )
      .join("\n")
      .trim();
    if (text) return text.slice(0, MAX_TOOL_ERROR_CHARS);
  }
  if (typeof record.output === "string" && record.output.trim()) {
    return record.output.trim().slice(0, MAX_TOOL_ERROR_CHARS);
  }
  if (typeof record.text === "string" && record.text.trim()) {
    return record.text.trim().slice(0, MAX_TOOL_ERROR_CHARS);
  }
  try {
    return JSON.stringify(result).slice(0, MAX_TOOL_ERROR_CHARS);
  } catch {
    return "";
  }
}

function asTodoItems(value: unknown): TodoItem[] {
  if (!Array.isArray(value)) return [];
  const out: TodoItem[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    const text = typeof item.text === "string" ? item.text.trim() : "";
    if (!text) continue;
    const status =
      item.status === "in_progress" ||
      item.status === "completed" ||
      item.status === "cancelled"
        ? item.status
        : item.completed === true
          ? "completed"
          : "pending";
    out.push({
      step: typeof item.step === "number" ? item.step : out.length + 1,
      text,
      completed: status === "completed",
      status,
      ...(typeof item.id === "string" ? { id: item.id } : {}),
      ...(typeof item.ref === "string" ? { ref: item.ref } : {}),
      ...(typeof item.label === "string" ? { label: item.label } : {}),
      ...(typeof item.group === "string" ? { group: item.group } : {}),
    });
    if (out.length >= 100) break;
  }
  return out;
}

/** Create the controller. It is inert until `start` is called. */
export function createOrchestratorChildController(
  ports: OrchestratorChildPorts,
): OrchestratorChildController {
  const now = ports.now ?? (() => Date.now());
  const timeoutMs = ports.timeoutMs ?? DEFAULT_CHILD_TIMEOUT_MS;
  const maxToolCalls = ports.maxToolCalls ?? MAX_CHILD_TOOL_CALLS;
  const settleReportTimeoutMs =
    typeof ports.settleReportTimeoutMs === "number" &&
    ports.settleReportTimeoutMs > 0
      ? Math.max(1, Math.floor(ports.settleReportTimeoutMs))
      : DEFAULT_SETTLE_REPORT_TIMEOUT_MS;

  let state: OrchestratorChildState = { phase: "idle", todos: [] };
  let child: InProcessChildSession | undefined;
  let unsubscribe: (() => void) | undefined;
  let generation = 0;
  let expectedAbort: "abort" | "stop" | undefined;
  let settledOnce = false;
  /** A failure/report was already emitted for this attempt. */
  let failedOnce = false;
  /** Bounded policy refusals observed through failed tool results. */
  let policyRefusals: string[] = [];
  let toolCalls = 0;
  let summary = "";
  let startedAt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  /**
   * Pause ownership for the current invocation. It deliberately survives the
   * SDK's `agent_settled` event and the awaited prompt's catch, so an
   * intentional pause can never be misclassified as a child failure.
   */
  let pauseState: "none" | "requested" | "settled" = "none";
  let pauseWaiters: Array<(settled: boolean) => void> = [];
  /** Remaining ACTIVE execution budget; paused wall time is excluded. */
  let remainingMs = timeoutMs;
  let deadlineStartedAt: number | undefined;
  let deadlineGen = -1;
  let queuedNote: string | undefined;
  /** The last row input, so a re-prompt targets the same root. */
  let lastInput: CreateChildInput | undefined;
  let prepared:
    | {
        attemptId: string;
        child: InProcessChildSession;
        modelLabel?: string;
      }
    | undefined;
  /** Deduplicates stats publication so a render loop cannot churn the UI. */
  let lastStatsKey = "";
  /** Serializes model switches with resume; never held across a prompt. */
  let modelLane: Promise<unknown> = Promise.resolve();

  const runInModelLane = <T>(work: () => Promise<T>): Promise<T> => {
    const next = modelLane.then(work, work);
    modelLane = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };

  /**
   * Republish the child's stats when they actually changed.
   *
   * `getSessionStats()` is O(entries), and every `entry_appended` would ask for
   * it: the dedupe key is what keeps a busy child from repainting on each event.
   */
  const refreshStats = (): void => {
    const target = child ?? prepared?.child;
    const read = target?.stats;
    if (!read) return;
    let stats: ChildRuntimeStats | undefined;
    try {
      stats = read.call(target);
    } catch {
      return;
    }
    if (!stats) return;
    const key = JSON.stringify(stats);
    if (key === lastStatsKey) return;
    lastStatsKey = key;
    publish({
      stats,
      ...(stats.model?.thinking ? { thinking: stats.model.thinking } : {}),
    });
  };

  /** Apply `ref` to one session, updating state/prepared/transcript. */
  const applyToSession = async (
    target: InProcessChildSession,
    ref: { provider: string; id: string; thinking?: string },
  ): Promise<{ ok: boolean; changed?: boolean; model?: ChildModelRef; error?: string }> => {
    const current = target.currentModel?.();
    const sameModel =
      current?.provider === ref.provider && current.id === ref.id;
    const sameThinking =
      !ref.thinking || !current?.thinking || ref.thinking === current.thinking;
    if (sameModel && sameThinking) {
      return { ok: true, changed: false, ...(current ? { model: current } : {}) };
    }
    if (typeof target.setModel !== "function") {
      return {
        ok: false,
        error: "this child cannot switch models (unsupported SDK)",
      };
    }
    const result = await target.setModel(
      ref.provider,
      ref.id,
      ref.thinking,
    );
    if (!result.ok) return { ok: false, error: result.error };
    const model = result.model;
    const label = `${model.provider}/${model.id}`;
    if (target === child) {
      publish({
        modelLabel: label,
        ...(model.thinking ? { thinking: model.thinking } : {}),
      });
      ops([
        {
          op: "new",
          kind: "notice",
          text: `model → ${label}${model.thinking ? ` (${model.thinking})` : ""}`,
        },
      ]);
      refreshStats();
    } else if (prepared && prepared.child === target) {
      prepared.modelLabel = label;
    }
    return { ok: true, changed: true, model };
  };

  /**
   * Bring a session to the parent's desired model. A mismatch is switched; a
   * refusal is reported so the caller can decide (a prepared child is replaced,
   * a running one is left alone).
   */
  const ensureDesiredModel = async (
    target: InProcessChildSession,
  ): Promise<{ ok: boolean; error?: string }> => {
    const desired = ports.desiredModel?.();
    if (!desired) return { ok: true };
    const current = target.currentModel?.();
    if (
      current &&
      current.provider === desired.provider &&
      current.id === desired.id &&
      (!desired.thinking ||
        !current.thinking ||
        desired.thinking === current.thinking)
    ) {
      return { ok: true };
    }
    // A session that cannot report/switch a model is accepted as-is: the
    // launch model was already resolved from the same effective role.
    if (typeof target.setModel !== "function") return { ok: true };
    const applied = await applyToSession(target, desired);
    return applied.ok
      ? { ok: true }
      : { ok: false, error: applied.error ?? "the model switch failed" };
  };

  const publish = (patch: Partial<OrchestratorChildState>): void => {
    state = { ...state, ...patch };
    try {
      ports.onState?.({ ...state, todos: [...state.todos] });
    } catch {
      /* display-only */
    }
  };

  const ops = (list: OrchestratorChildOp[]): void => {
    if (list.length === 0) return;
    try {
      ports.onOps?.(list);
    } catch {
      /* display-only */
    }
  };

  /** A copy of the final list; the report owns its snapshot. */
  const snapshotTodos = (): TodoItem[] =>
    state.todos.map((item) => ({ ...item }));

  const snapshotPolicyRefusals = (): string[] =>
    normalizePolicyRefusals(policyRefusals);

  /** Remember a refusal without letting a retry loop unbounded the list. */
  const notePolicyRefusal = (text: string): void => {
    const value = text.trim();
    if (!value || policyRefusals.includes(value)) return;
    policyRefusals.push(value.slice(0, MAX_TOOL_ERROR_CHARS));
    if (policyRefusals.length > MAX_CHILD_POLICY_REFUSALS) {
      policyRefusals.shift();
    }
  };

  const clearTimer = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    deadlineStartedAt = undefined;
  };

  /** Release a warm resume waiting for the pause to finish settling. */
  const resolvePause = (): void => {
    const waiters = pauseWaiters.splice(0);
    for (const waiter of waiters) {
      try {
        waiter(true);
      } catch {
        /* ignore */
      }
    }
  };

  const failWaiters = (): void => {
    const waiters = pauseWaiters.splice(0);
    for (const waiter of waiters) {
      try {
        waiter(false);
      } catch {
        /* ignore */
      }
    }
  };

  const PAUSE_SETTLE_TIMEOUT_MS = 5_000;

  /**
   * Wait (bounded) for an in-flight pause to finish. Resume must never prompt a
   * session that is still aborting: that would be steered into the dying run.
   */
  const waitForPauseSettlement = async (): Promise<boolean> => {
    if (pauseState === "none" || pauseState === "settled") return true;
    return new Promise<boolean>((resolve) => {
      let done = false;
      const finish = (value: boolean): void => {
        if (done) return;
        done = true;
        resolve(value);
      };
      pauseWaiters.push((settled) => finish(settled));
      const timeout = setTimeout(() => finish(false), PAUSE_SETTLE_TIMEOUT_MS);
      // SAFETY: Node's Timeout exposes `unref()`; a DOM-style numeric handle
      // from a non-Node host does not, so the call is optional.
      (timeout as unknown as { unref?: () => void }).unref?.();
    });
  };

  /**
   * Freeze the execution deadline while paused. The remaining budget is kept,
   * so repeated pause/resume neither expires a warm child nor resets the
   * execution budget indefinitely.
   */
  const suspendDeadline = (): void => {
    if (
      timer !== undefined &&
      deadlineStartedAt !== undefined &&
      deadlineGen === generation
    ) {
      remainingMs = Math.max(
        1_000,
        remainingMs - Math.max(0, now() - deadlineStartedAt),
      );
    }
    clearTimer();
  };

  /**
   * Arm the execution deadline.
   *
   * `unref()`ed: the deadline is an enforcement budget, not work, so it must
   * never keep the process alive on its own (headless runs, tests, shutdown
   * after the last row). The child's own streaming keeps the loop alive while
   * there is real work.
   */
  const armDeadline = (gen: number): void => {
    clearTimer();
    if (remainingMs <= 0) return;
    deadlineStartedAt = now();
    deadlineGen = gen;
    timer = setTimeout(() => {
      if (gen !== generation || settledOnce) return;
      if (state.phase === "paused") return;
      expectedAbort = "abort";
      void child?.abort();
      release();
      fail(`the child did not finish within ${Math.round(timeoutMs / 1000)}s`);
    }, remainingMs);
    // SAFETY: Node's Timeout carries `unref()`; the DOM-style numeric handle a
    // non-Node host may return does not, and the optional call keeps it safe.
    const handle = timer as unknown as { unref?: () => void };
    try {
      handle.unref?.();
    } catch {
      /* an unref refusal must not break the deadline */
    }
  };

  /** Unsubscribe the current listener; the session may stay warm. */
  const unsubscribeEvents = (): void => {
    try {
      unsubscribe?.();
    } catch {
      /* ignore */
    }
    unsubscribe = undefined;
  };

  /** Dispose only the current child; a prepared child is left for `start`. */
  const disposeCurrentChild = (): void => {
    unsubscribeEvents();
    try {
      child?.dispose();
    } catch {
      /* ignore */
    }
    child = undefined;
  };

  const release = (): void => {
    clearTimer();
    disposeCurrentChild();
    if (prepared) {
      try {
        prepared.child.dispose();
      } catch {
        /* ignore */
      }
      prepared = undefined;
    }
  };

  /**
   * Report a failure once, release the session and wake the parent with the
   * child's final facts. Centralised so no call site can leak a live session.
   */
  const fail = (reason: string): void => {
    if (failedOnce) return;
    const taskId = state.taskId;
    const attemptId = state.attemptId;
    if (!taskId || !attemptId) return;
    failedOnce = true;
    settledOnce = true;
    expectedAbort = "abort";
    const todos = snapshotTodos();
    const refusals = snapshotPolicyRefusals();
    release();
    publish({
      phase: "disposed",
      lastError: reason,
      pausePending: false,
      retrying: false,
    });
    void Promise.resolve(
      ports.onError?.({ taskId, attemptId, error: reason, todos, policyRefusals: refusals }),
    ).catch(() => undefined);
  };

  /**
   * Publish the post-settle state and release the session.
   *
   * Disposal is deferred to the next macrotask: `finish()` runs inside the
   * SDK's `agent_settled` dispatch, and disposing a session mid-dispatch tears
   * down listeners that are still being iterated. The generation guard keeps a
   * late timer from touching a newer attempt.
   */
  const settleIdle = (gen: number): void => {
    if (gen !== generation) return;
    publish({
      phase: "idle",
      settlingAt: undefined,
      pausePending: false,
      retrying: false,
    });
    unsubscribeEvents();
    const target = child;
    if (!target) return;
    const handle = setTimeout(() => {
      if (gen !== generation) return;
      if (child === target) child = undefined;
      try {
        target.dispose();
      } catch {
        /* ignore */
      }
    }, 0);
    (handle as { unref?: () => void }).unref?.();
  };

  const finish = (): void => {
    if (settledOnce || failedOnce) return;
    settledOnce = true;
    clearTimer();
    const gen = generation;
    publish({
      phase: "settling",
      settlingAt: now(),
      pausePending: false,
      retrying: false,
    });
    const taskId = state.taskId ?? "";
    const attemptId = state.attemptId ?? "";
    const todos = snapshotTodos();
    const refusals = snapshotPolicyRefusals();
    const settleReport = Promise.resolve(
      ports.onSettled?.({
        taskId,
        attemptId,
        summary: summary || "(no final summary)",
        toolCalls,
        durationMs: Math.max(0, now() - startedAt),
        todos,
        policyRefusals: refusals,
      }),
    );
    // A stuck persistence/UI port must never wedge the run in `settling`: the
    // dispatch guard would refuse the next row forever. Bound the report and
    // fail honestly if it cannot be recorded.
    let settleTimer: ReturnType<typeof setTimeout> | undefined;
    const reportDeadline = new Promise<never>((_resolve, reject) => {
      settleTimer = setTimeout(() => {
        reject(
          new Error(
            `the child settled but its report was not recorded within ${Math.round(
              settleReportTimeoutMs / 1000,
            )}s`,
          ),
        );
      }, settleReportTimeoutMs);
      // SAFETY: Node's Timeout carries `unref()`; a DOM-style numeric handle
      // from a non-Node host does not, so the call is optional.
      (settleTimer as unknown as { unref?: () => void }).unref?.();
    });
    void Promise.race([settleReport, reportDeadline])
      .then(() => settleIdle(gen))
      .catch((error: unknown) => {
        if (gen !== generation) return;
        fail(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (settleTimer !== undefined) clearTimeout(settleTimer);
      });
  };

  const onEvent = (raw: unknown, gen: number): void => {
    if (!child || gen !== generation) return;
    const event =
      raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
    const type = typeof event.type === "string" ? event.type : "";
    if (type === "tool_execution_start") {
      const name = typeof event.toolName === "string" ? event.toolName : "tool";
      const label = formatActionLabel(name, event.args);
      publish({ lastTool: label });
      ops([{ op: "new", kind: "tool", text: `▸ ${label}` }]);
      toolCalls += 1;
      if (toolCalls > maxToolCalls) {
        expectedAbort = "abort";
        void child.abort();
        release();
        fail(`the child exceeded the ${maxToolCalls}-tool-call budget`);
      }
      return;
    }
    if (type === "tool_execution_end") {
      const name = typeof event.toolName === "string" ? event.toolName : "tool";
      const failed = event.isError === true;
      ops([
        {
          op: "new",
          kind: "tool",
          text: `▸ ${name} ${failed ? "failed" : "ok"}`,
        },
      ]);
      if (name === "workflow_todo") {
        const result = event.result as { details?: { todos?: unknown } } | undefined;
        const todos = asTodoItems(result?.details?.todos);
        if (todos.length > 0) publish({ todos });
      } else if (failed) {
        const text = toolErrorText(event.result);
        if (text && isPolicyRefusal(text)) notePolicyRefusal(text);
      }
      return;
    }
    if (type === "agent_start") {
      publish({ retrying: false });
      // The SDK resets an abort requested before its run became active. A
      // pause that landed in that window is reapplied here, once, so the warm
      // child stops instead of running the whole row after looking paused.
      if (state.phase === "paused") {
        void child.abort();
      }
      return;
    }
    if (type === "agent_end") {
      const text = assistantText(event.messages);
      if (text) summary = text;
      refreshStats();
      return;
    }
    if (type === "message_end" || type === "entry_appended") {
      // Usage/model changes arrive here; `refreshStats` dedupes so a busy run
      // does not repaint on every entry.
      refreshStats();
      return;
    }
    if (type === "agent_settled") {
      refreshStats();
      if (pauseState !== "none") {
        // A requested pause owns settlement: keep the warm child, do not settle
        // the row, and release resume exactly once. This also covers a settle
        // that arrives before the awaited `abort()` resolves.
        pauseState = "settled";
        publish({ pausePending: false, retrying: false });
        resolvePause();
        return;
      }
      if (expectedAbort !== undefined) {
        expectedAbort = undefined;
        return;
      }
      finish();
      return;
    }
    if (type === "auto_retry_start") {
      const message = typeof event.errorMessage === "string" ? event.errorMessage : "";
      publish({ retrying: true });
      ops([
        {
          op: "new",
          kind: "notice",
          text: message
            ? `retrying after a provider error: ${message.slice(0, 300)}`
            : "retrying after a provider error",
        },
      ]);
      return;
    }
    if (type === "auto_retry_end") {
      publish({ retrying: false });
      if (event.success !== false) return;
      const detail =
        typeof event.finalError === "string" ? event.finalError : "";
      if (!settledOnce) {
        expectedAbort = "abort";
        release();
        fail(
          detail
            ? `provider retry budget exhausted: ${detail.slice(0, 400)}`
            : "provider retry budget exhausted",
        );
      }
    }
  };

  return {
    state() {
      return { ...state, todos: [...state.todos] };
    },

    async prepare(input) {
      if (prepared && prepared.attemptId !== input.attemptId) {
        try {
          prepared.child.dispose();
        } catch {
          /* ignore */
        }
        prepared = undefined;
      }
      if (prepared) {
        return {
          ok: true,
          ...(prepared.modelLabel ? { modelLabel: prepared.modelLabel } : {}),
        };
      }
      const created = await ports.create(input);
      if (!created.ok || !created.child) {
        return { ok: false, error: created.error ?? "child creation failed" };
      }
      prepared = {
        attemptId: input.attemptId,
        child: created.child,
        ...(created.modelLabel ? { modelLabel: created.modelLabel } : {}),
      };
      return {
        ok: true,
        ...(created.modelLabel ? { modelLabel: created.modelLabel } : {}),
      };
    },

    discardPrepared() {
      if (!prepared) return;
      try {
        prepared.child.dispose();
      } catch {
        /* ignore */
      }
      prepared = undefined;
    },

    async applyModel(ref) {
      // A finishing/disposed child must not be switched: its session is about
      // to be released and the next row resolves the profile fresh anyway.
      if (state.phase === "settling" || state.phase === "disposed") {
        return { ok: false, error: "the child is finishing" };
      }
      const target = child ?? prepared?.child;
      if (!target) {
        return { ok: false, error: "no child is active" };
      }
      return runInModelLane(async () => {
        const at = child ?? prepared?.child;
        if (!at) {
          return { ok: false, error: "no child is active" };
        }
        try {
          return await applyToSession(at, ref);
        } catch (error: unknown) {
          return {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      });
    },

    async start(input) {
      if (state.phase === "starting" || state.phase === "running") {
        return { ok: false, error: "a child is already active" };
      }
      // A settled child is already released, but be defensive: never adopt a
      // new attempt while a leftover session still exists.
      disposeCurrentChild();
      generation += 1;
      const gen = generation;
      settledOnce = false;
      failedOnce = false;
      policyRefusals = [];
      expectedAbort = undefined;
      pauseState = "none";
      resolvePause();
      remainingMs = timeoutMs;
      toolCalls = 0;
      summary = "";
      queuedNote = undefined;
      startedAt = now();
      lastInput = input;
      publish({
        phase: "starting",
        taskId: input.taskId,
        attemptId: input.attemptId,
        sessionId: input.sessionId,
        ref: input.ref,
        total: input.total,
        startedAt,
        settlingAt: undefined,
        lastTool: undefined,
        lastError: undefined,
        policyRefusals: [],
        todos: [],
      });

      let modelLabel: string | undefined;
      let adopted: InProcessChildSession | undefined;
      if (prepared && prepared.attemptId === input.attemptId) {
        modelLabel = prepared.modelLabel;
        adopted = prepared.child;
        prepared = undefined;
        // A `/profile` or `/role` switch can land between `prepare()` (which
        // created this session) and `start()`. Bring it to the parent's current
        // Builder model BEFORE the first prompt; a refusal replaces it with a
        // fresh child created from the same current plan.
        const reconciled = await ensureDesiredModel(adopted);
        if (gen !== generation) {
          try {
            adopted.dispose();
          } catch {
            /* ignore */
          }
          return { ok: false, error: "superseded" };
        }
        if (!reconciled.ok) {
          try {
            adopted.dispose();
          } catch {
            /* ignore */
          }
          adopted = undefined;
          modelLabel = undefined;
        }
      }
      if (!adopted) {
        const created = await ports.create({
          sessionId: input.sessionId,
          taskId: input.taskId,
          attemptId: input.attemptId,
          ref: input.ref,
          total: input.total,
        });
        if (gen !== generation) {
          // A newer start/abort/dispose happened while the session was being
          // created. Dispose the half-created child instead of leaking a live
          // session nobody owns (stale launch, reload or host failure).
          try {
            created.child?.dispose();
          } catch {
            /* ignore */
          }
          return { ok: false, error: "superseded" };
        }
        if (!created.ok || !created.child) {
          fail(created.error ?? "the child session could not be created");
          return { ok: false, error: created.error ?? "child creation failed" };
        }
        adopted = created.child;
        modelLabel = created.modelLabel;
        // Correct a silently substituted launch model; a refusal is not fatal.
        await ensureDesiredModel(adopted);
      }
      child = adopted;
      // Report the model the session ACTUALLY resolved, not the request.
      const actual = child.currentModel?.();
      const actualLabel = actual
        ? `${actual.provider}/${actual.id}`
        : modelLabel;
      if (pauseState !== "none") {
        // Pause landed while the session was being created/adopted. Keep the
        // warm child, never prompt, and never arm a deadline.
        publish({
          phase: "paused",
          pausedAt: now(),
          pausePending: false,
          ...(actualLabel ? { modelLabel: actualLabel } : {}),
          ...(actual?.thinking ? { thinking: actual.thinking } : {}),
          sessionId: child.sessionId,
        });
        pauseState = "settled";
        resolvePause();
        return { ok: true };
      }
      publish({
        phase: "running",
        ...(actualLabel ? { modelLabel: actualLabel } : {}),
        ...(actual?.thinking ? { thinking: actual.thinking } : {}),
        sessionId: child.sessionId,
        pausedAt: undefined,
        pausePending: false,
        retrying: false,
      });
      refreshStats();
      unsubscribe = child.subscribe((event) => onEvent(event, gen));
      armDeadline(gen);
      // Short admission: the parent must regain control immediately. The run's
      // completion arrives through `agent_settled`; a rejection is handled
      // exactly like `resume()` so a real failure is still reported once.
      const launched = child.prompt(
        ports.buildPrompt({
          taskId: input.taskId,
          attemptId: input.attemptId,
          ref: input.ref,
          total: input.total,
          ...(input.cwd ? { cwd: input.cwd } : {}),
          ...(input.workspace ? { workspace: input.workspace } : {}),
          ...(input.repair ? { repair: input.repair } : {}),
        }),
      );
      void launched.catch((error: unknown) => {
        if (gen !== generation) return;
        // An intentional pause aborts the SDK run; its prompt rejection is not
        // a child failure and must not dispose the warm session.
        if (pauseState !== "none") return;
        if (expectedAbort !== undefined) return;
        const text = error instanceof Error ? error.message : String(error);
        fail(`the child prompt failed: ${text}`);
      });
      return { ok: true };
    },

    async pause() {
      // Idempotent by contract: a second Esc can never issue a second abort or
      // escalate into a destructive stop.
      if (pauseState !== "none") return false;
      if (state.phase !== "starting" && state.phase !== "running") return false;
      if (!child && state.phase === "running") return false;
      const gen = generation;
      pauseState = "requested";
      suspendDeadline();
      // Freeze elapsed on pause: a warm child must not accumulate wall time.
      publish({
        phase: "paused",
        pausedAt: now(),
        pausePending: true,
        retrying: false,
      });
      const target = child;
      if (target) {
        try {
          await target.abort();
        } catch {
          /* ignore */
        }
      }
      if (gen !== generation) return true;
      // `agent_settled` may already have completed the pause; this is the
      // fallback for a host that resolves abort without that event.
      pauseState = "settled";
      publish({ pausePending: false });
      resolvePause();
      return true;
    },

    async reenter(repair) {
      if (!child || (state.phase !== "settling" && state.phase !== "paused")) {
        return false;
      }
      const taskId = state.taskId;
      const attemptId = state.attemptId;
      const ref = state.ref;
      const total = state.total;
      if (!taskId || !attemptId || !ref || total === undefined) return false;
      if (!(await waitForPauseSettlement())) return false;
      if (!child || (state.phase !== "settling" && state.phase !== "paused")) {
        return false;
      }
      const gen = generation;
      pauseState = "none";
      expectedAbort = undefined;
      settledOnce = false;
      summary = "";
      publish({ phase: "running", pausedAt: undefined, pausePending: false, retrying: false });
      armDeadline(gen);
      try {
        await child.prompt(
          ports.buildPrompt({
            taskId,
            attemptId,
            ref,
            total,
            repair,
            ...(lastInput?.cwd ? { cwd: lastInput.cwd } : {}),
            ...(lastInput?.workspace ? { workspace: lastInput.workspace } : {}),
          }),
        );
        return true;
      } catch (error: unknown) {
        if (pauseState !== "none") return true;
        if (gen !== generation) return false;
        const message = error instanceof Error ? error.message : String(error);
        fail(`the child could not be re-prompted: ${message}`);
        return false;
      }
    },

    async resume(note?: string) {
      if (state.phase !== "paused" || !child) return false;
      // Never prompt a session that is still aborting: that would steer the
      // continuation into the dying run instead of starting a real one.
      if (!(await waitForPauseSettlement())) return false;
      if (state.phase !== "paused" || !child) return false;
      const text =
        note?.trim() ||
        queuedNote ||
        "Continue the assigned row from where you stopped. Keep your task-local TODO list current, then finish with a short summary.";
      queuedNote = undefined;
      // Never prompt on a half-switched session: finish any in-flight switch
      // and apply the current desired model first. A refusal keeps the old
      // model (still resumable) and never blocks the resume.
      await runInModelLane(async () => {
        if (!child) return;
        await ensureDesiredModel(child);
      });
      if (state.phase !== "paused" || !child) return false;
      const gen = generation;
      pauseState = "none";
      expectedAbort = undefined;
      settledOnce = false;
      summary = "";
      publish({ phase: "running", pausedAt: undefined, pausePending: false, retrying: false });
      armDeadline(gen);
      // Resume is a SHORT admission: controls (including a new pause) must not
      // wait for the whole run to finish. Completion/failure still arrives via
      // the event stream and the attempt-scoped rejection handler below.
      const launched = child.prompt(text);
      void launched.catch((error: unknown) => {
        if (gen !== generation) return;
        if (pauseState !== "none") return;
        if (expectedAbort !== undefined) return;
        const message = error instanceof Error ? error.message : String(error);
        fail(`the child could not resume: ${message}`);
      });
      return true;
    },

    async abort(reason, opts) {
      const taskId = state.taskId ?? "";
      const attemptId = state.attemptId ?? "";
      const notify = opts?.notify !== false;
      const live =
        state.phase === "starting" ||
        state.phase === "running" ||
        state.phase === "paused";
      // A settled (or already stopped) child has no live work: release only and
      // never rewrite the report that already landed.
      if (!live || settledOnce) {
        generation += 1;
        expectedAbort = "abort";
        pauseState = "none";
        clearTimer();
        failWaiters();
        release();
        publish({ phase: "disposed", pausePending: false, retrying: false });
        return;
      }
      const todos = snapshotTodos();
      const refusals = snapshotPolicyRefusals();
      generation += 1;
      expectedAbort = "abort";
      pauseState = "none";
      clearTimer();
      failWaiters();
      try {
        await child?.abort();
      } catch {
        /* ignore */
      }
      release();
      publish({ phase: "disposed", pausePending: false, retrying: false });
      if (taskId && attemptId) {
        try {
          await ports.onAborted?.({
            taskId,
            attemptId,
            reason,
            notify,
            todos,
            policyRefusals: refusals,
          });
        } catch {
          /* ignore */
        }
      }
    },

    async dispose() {
      generation += 1;
      expectedAbort = "abort";
      pauseState = "none";
      clearTimer();
      failWaiters();
      release();
      publish({ phase: "disposed", pausePending: false, retrying: false });
    },

    async deliver(text) {
      const value = text.trim();
      if (!value) return { ok: false, error: "empty message" };
      if (state.phase === "paused") {
        queuedNote = value.slice(0, 2_000);
        return { ok: true, queued: true };
      }
      if (state.phase !== "running" || !child) {
        return { ok: false, error: "no running child" };
      }
      try {
        await child.prompt(value);
        return { ok: true };
      } catch (error: unknown) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  };
}
