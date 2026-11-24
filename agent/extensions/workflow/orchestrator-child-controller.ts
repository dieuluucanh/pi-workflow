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
  lastTool?: string;
  todos: TodoItem[];
  lastError?: string;
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
    repair?: string;
  }) => string;
  onOps?: (ops: OrchestratorChildOp[]) => void;
  onState?: (state: OrchestratorChildState) => void;
  onSettled?: (input: ChildSettledInput) => void | Promise<void>;
  onError?: (input: { taskId: string; attemptId: string; error: string }) => void | Promise<void>;
  onAborted?: (input: { taskId: string; attemptId: string; reason: string }) => void | Promise<void>;
  /**
   * The model the parent currently wants this child to run (the effective
   * Builder role, profile overlay applied). Read at start/resume so a profile
   * switch that raced child creation is still honoured.
   */
  desiredModel?: () => { provider: string; id: string; thinking?: string } | undefined;
  now?: () => number;
  timeoutMs?: number;
  maxToolCalls?: number;
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
  abort(reason: string): Promise<void>;
  dispose(): Promise<void>;
  deliver(text: string): Promise<{ ok: boolean; queued?: boolean; error?: string }>;
}

export const DEFAULT_CHILD_TIMEOUT_MS = 45 * 60_000;
export const MAX_CHILD_TOOL_CALLS = 300;

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

  let state: OrchestratorChildState = { phase: "idle", todos: [] };
  let child: InProcessChildSession | undefined;
  let unsubscribe: (() => void) | undefined;
  let generation = 0;
  let expectedAbort: "pause" | "abort" | "stop" | undefined;
  let settledOnce = false;
  let toolCalls = 0;
  let summary = "";
  let startedAt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let queuedNote: string | undefined;
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

  const clearTimer = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  /**
   * Arm the execution deadline.
   *
   * `unref()`ed: the deadline is an enforcement budget, not work, so it must
   * never keep the process alive on its own (headless runs, tests, shutdown
   * after the last row). The child's own streaming keeps the loop alive while
   * there is real work.
   */
  const armDeadline = (callback: () => void): void => {
    timer = setTimeout(callback, timeoutMs);
    // SAFETY: Node's Timeout carries `unref()`; the DOM-style numeric handle a
    // non-Node host may return does not, and the optional call keeps it safe.
    const handle = timer as unknown as { unref?: () => void };
    try {
      handle.unref?.();
    } catch {
      /* an unref refusal must not break the deadline */
    }
  };

  const release = (): void => {
    clearTimer();
    try {
      unsubscribe?.();
    } catch {
      /* ignore */
    }
    unsubscribe = undefined;
    try {
      child?.dispose();
    } catch {
      /* ignore */
    }
    child = undefined;
    if (prepared) {
      try {
        prepared.child.dispose();
      } catch {
        /* ignore */
      }
      prepared = undefined;
    }
  };

  const fail = (reason: string): void => {
    if (!state.taskId || !state.attemptId) return;
    publish({ phase: "disposed", lastError: reason });
    void Promise.resolve(
      ports.onError?.({
        taskId: state.taskId,
        attemptId: state.attemptId,
        error: reason,
      }),
    ).catch(() => undefined);
  };

  const finish = (): void => {
    if (settledOnce) return;
    settledOnce = true;
    clearTimer();
    publish({ phase: "settling" });
    const taskId = state.taskId ?? "";
    const attemptId = state.attemptId ?? "";
    void Promise.resolve(
      ports.onSettled?.({
        taskId,
        attemptId,
        summary: summary || "(no final summary)",
        toolCalls,
        durationMs: Math.max(0, now() - startedAt),
      }),
    ).catch((error: unknown) => {
      fail(error instanceof Error ? error.message : String(error));
    });
  };

  const onEvent = (raw: unknown): void => {
    if (!child) return;
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
      if (expectedAbort !== undefined) {
        expectedAbort = undefined;
        return;
      }
      finish();
      return;
    }
    if (type === "auto_retry_start") {
      const message = typeof event.errorMessage === "string" ? event.errorMessage : "";
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
    if (type === "auto_retry_end" && event.success === false) {
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
      generation += 1;
      const gen = generation;
      settledOnce = false;
      expectedAbort = undefined;
      toolCalls = 0;
      summary = "";
      queuedNote = undefined;
      startedAt = now();
      publish({
        phase: "starting",
        taskId: input.taskId,
        attemptId: input.attemptId,
        sessionId: input.sessionId,
        ref: input.ref,
        total: input.total,
        startedAt,
        lastTool: undefined,
        lastError: undefined,
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
      publish({
        phase: "running",
        ...(actualLabel ? { modelLabel: actualLabel } : {}),
        ...(actual?.thinking ? { thinking: actual.thinking } : {}),
        sessionId: child.sessionId,
        pausedAt: undefined,
      });
      refreshStats();
      unsubscribe = child.subscribe(onEvent);
      armDeadline(() => {
        if (gen !== generation || settledOnce) return;
        expectedAbort = "abort";
        void child?.abort();
        release();
        fail(`the child did not finish within ${Math.round(timeoutMs / 1000)}s`);
      });
      try {
        await child.prompt(
          ports.buildPrompt({
            taskId: input.taskId,
            attemptId: input.attemptId,
            ref: input.ref,
            total: input.total,
            ...(input.repair ? { repair: input.repair } : {}),
          }),
        );
      } catch (error: unknown) {
        if (gen !== generation) return { ok: false, error: "superseded" };
        if (expectedAbort !== undefined) return { ok: false, error: "aborted" };
        const text = error instanceof Error ? error.message : String(error);
        expectedAbort = "abort";
        release();
        fail(`the child prompt failed: ${text}`);
        return { ok: false, error: text };
      }
      return { ok: true };
    },

    async pause() {
      if (state.phase !== "running" || !child) return false;      expectedAbort = "pause";
      // Freeze elapsed on pause: a warm child must not accumulate wall time.
      publish({ phase: "paused", pausedAt: now() });
      try {
        await child.abort();
      } catch {
        /* ignore */
      }
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
      clearTimer();
      settledOnce = false;
      expectedAbort = undefined;
      summary = "";
      publish({ phase: "running", pausedAt: undefined });
      armDeadline(() => {
        if (settledOnce) return;
        expectedAbort = "abort";
        void child?.abort();
        release();
        fail(`the child did not finish within ${Math.round(timeoutMs / 1000)}s`);
      });
      try {
        await child.prompt(
          ports.buildPrompt({ taskId, attemptId, ref, total, repair }),
        );
        return true;
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        fail(`the child could not be re-prompted: ${message}`);
        return false;
      }
    },

    async resume(note?: string) {
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
      expectedAbort = undefined;
      settledOnce = false;
      publish({ phase: "running", pausedAt: undefined });
      try {
        await child.prompt(text);
        return true;
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        fail(`the child could not resume: ${message}`);
        return false;
      }
    },

    async abort(reason) {
      generation += 1;
      expectedAbort = "abort";
      const taskId = state.taskId ?? "";
      const attemptId = state.attemptId ?? "";
      clearTimer();
      try {
        await child?.abort();
      } catch {
        /* ignore */
      }
      release();
      publish({ phase: "disposed" });
      if (taskId && attemptId) {
        try {
          await ports.onAborted?.({ taskId, attemptId, reason });
        } catch {
          /* ignore */
        }
      }
    },

    async dispose() {
      generation += 1;
      expectedAbort = "abort";
      clearTimer();
      release();
      publish({ phase: "disposed" });
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
