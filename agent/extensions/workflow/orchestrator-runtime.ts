/**
 * Workflow Extension — parent orchestration runtime.
 *
 * One runtime, one frozen TODO authority, one journal. It deliberately has no
 * proposal, preview, approval, budget or rollover layer:
 *
 *   - `startFromPlan` / `startFromSteps` freeze the rows ONCE and create the
 *     run; nothing else can replace the list;
 *   - `applyEvent` validates the pure reducer transition first, journals it,
 *     and only then mutates the in-memory state (a failed append changes
 *     nothing);
 *   - `restore` rebuilds the run from the journal and the frozen snapshot only.
 *
 * Everything effectful is injected (journal factory, clock, notify, append):
 * the module launches nothing and starts no turn.
 */

import {
  applyRunEvent,
  createRunState,
  nextPendingTask,
  type RunEvent,
  type RunState,
} from "./orchestrator-state.ts";
import type { JournalEvent, JournalEventType, RunJournal } from "./orchestrator-store.ts";
import type { RunPhase } from "./orchestrator-types.ts";
import {
  createFrozenTodosFromPlan,
  createFrozenTodosFromSteps,
  type FrozenTodoSnapshot,
} from "./todo-snapshot.ts";

export const RUNTIME_SCHEMA_VERSION = 1 as const;

export interface OrchestratorRuntimePorts {
  /** Journal for one run; the caller owns its directory/profile location. */
  createJournal(runId: string): RunJournal;
  /** Reads the plan the user approved. Defaults to Node fs in index.ts. */
  readPlan?: (path: string) => Promise<string>;
  now?: () => number;
  notify?: (message: string, level: "info" | "warning") => void;
  /** Durable branch-local projection entry, when the host has one. */
  appendEntry?: (type: string, data: unknown) => void;
}

export type RuntimeErrorCode =
  | "invalid"
  | "missing_plan"
  | "journal"
  | "state"
  | "cancelled";

export type RuntimeResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: RuntimeErrorCode; error: string };

export interface RuntimeView {
  runId: string;
  phase: RunPhase;
  todos: FrozenTodoSnapshot;
  plan?: { path: string; title: string; digest: string };
  nextTaskId?: string;
  blockedReason?: string;
  state: RunState;
}

export interface OrchestratorRuntime {
  /** Freeze the approved plan once and create the run in phase `ready`. */
  startFromPlan(input: {
    planPath: string;
    planText: string;
    executionId?: string;
    now?: number;
  }): Promise<RuntimeResult<{ runId: string; view: RuntimeView; frozen: FrozenTodoSnapshot }>>;
  /** Freeze an explicitly agreed standalone list once. */
  startFromSteps(input: {
    title: string;
    steps: readonly string[];
    sourcePath?: string;
    sourceRef?: string;
    executionId?: string;
    now?: number;
  }): Promise<RuntimeResult<{ runId: string; view: RuntimeView; frozen: FrozenTodoSnapshot }>>;
  /**
   * Applies one reducer event durably: validate, journal, then commit.
   */
  applyEvent(
    event: RunEventInput,
  ): Promise<RuntimeResult<{ revision: number; view: RuntimeView }>>;
  /** Journal records that are not reducer transitions (wake intent, control). */
  appendJournal(
    type: JournalEventType,
    payload: unknown,
    eventId: string,
  ): Promise<RuntimeResult<void>>;
  /** Durable journal events, for reload-safe dedupe. */
  journalEvents(): Promise<RuntimeResult<readonly JournalEvent[]>>;
  view(): RuntimeView | undefined;
  restore(): Promise<RuntimeResult<RuntimeView>>;
  /**
   * Restore the deterministic run for an already-approved plan WITHOUT
   * creating one. A reload uses this; a plan that never started a run stays
   * unbound instead of getting an empty journal.
   */
  restoreFromPlan(input: {
    planPath: string;
    planText: string;
    executionId?: string;
    now?: number;
  }): Promise<RuntimeResult<{ runId: string; view: RuntimeView; frozen: FrozenTodoSnapshot }>>;
  cancel(reason: string): Promise<RuntimeResult<{ view: RuntimeView }>>;
  /** Runs the plan-level final checks once, then completes the run. */
  complete(): Promise<RuntimeResult<{ view: RuntimeView }>>;
}

function slug(value: string): string {
  const clean = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return (clean || "run").slice(0, 24);
}

function clampText(value: unknown, max: number): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Reducer events have a matching durable journal record. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type RunEventInput = DistributiveOmit<RunEvent, "expectedRevision">;

const EVENT_JOURNAL_TYPE: Readonly<Record<RunEvent["type"], JournalEventType>> = {
  "run.transition": "run.transition",
  "task.start": "task.started",
  "task.report": "task.reported",
  "task.verify": "task.verified",
  "task.accept": "task.accepted",
  "task.needsFix": "task.needs_fix",
  "task.block": "task.blocked",
  "task.retry": "task.retried",
};

export function createOrchestratorRuntime(
  ports: OrchestratorRuntimePorts,
): OrchestratorRuntime {
  const now = ports.now ?? (() => Date.now());
  let journal: RunJournal | undefined;
  let runId: string | undefined;
  let state: RunState | undefined;

  const notify = (message: string, level: "info" | "warning" = "info") => {
    ports.notify?.(message, level);
  };

  const fail = <T>(code: RuntimeErrorCode, error: string): RuntimeResult<T> => ({
    ok: false,
    code,
    error,
  });

  const buildView = (): RuntimeView | undefined => {
    if (!runId || !state) return undefined;
    const nextTaskId = nextPendingTask(state);
    return {
      runId,
      phase: state.phase,
      todos: state.todos,
      ...(state.plan === undefined ? {} : { plan: state.plan }),
      ...(nextTaskId === undefined ? {} : { nextTaskId }),
      state,
    };
  };

  const append = async (
    type: JournalEventType,
    payload: unknown,
    eventId: string,
  ): Promise<RuntimeResult<void>> => {
    if (!journal) return fail("journal", "no run journal is bound");
    try {
      const result = await journal.append({ type, payload, eventId, at: now() });
      if (!result.ok) return fail("journal", `${result.code}: ${result.error}`);
      return { ok: true, value: undefined };
    } catch (error: unknown) {
      return fail(
        "journal",
        `the journal write failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };

  async function startFromFrozen(
    frozen: FrozenTodoSnapshot,
    plan: { path: string; title: string; digest: string } | undefined,
    sourcePath: string,
  ): Promise<RuntimeResult<{ runId: string; view: RuntimeView; frozen: FrozenTodoSnapshot }>> {
    if (runId && state) {
      return fail(
        "state",
        `run ${runId} is already active; stop it before starting another frozen list`,
      );
    }
    const candidateRunId = `run-${slug(sourcePath.split(/[\\/]/).pop() ?? "plan")}-${frozen.source.digest
      .slice(0, 12)}`;
    const created = createRunState({
      runId: candidateRunId,
      todos: frozen,
      ...(plan === undefined ? {} : { plan }),
      now: now(),
    });
    if (!created.ok) return fail("state", created.error);

    const bound = ports.createJournal(candidateRunId);
    const existing = await bound.load();
    if (!existing.ok) {
      return fail("journal", `${existing.code}: ${existing.error}`);
    }
    if (existing.value.events.length > 0) {
      // An existing journal is authoritative: restoring it is the only way to
      // resume. Never overwrite a stored run because the caller asked twice.
      runId = candidateRunId;
      journal = bound;
      const restored = await runtime.restore();
      if (!restored.ok) return restored;
      return { ok: true, value: { runId: candidateRunId, view: restored.value, frozen: restored.value.todos } };
    }

    runId = candidateRunId;
    journal = bound;
    state = created.state;

    const createdEvent = await append(
      "run.created",
      {
        sourcePath,
        digest: frozen.source.digest,
        title: frozen.source.title,
        mode: frozen.mode,
        plan: plan ?? null,
        rowCount: frozen.rows.length,
      },
      `created-${candidateRunId}`,
    );
    if (!createdEvent.ok) {
      runId = undefined;
      journal = undefined;
      state = undefined;
      return createdEvent;
    }
    const frozenEvent = await append(
      "todos.frozen",
      { executionId: frozen.executionId, digest: frozen.source.digest, snapshot: frozen },
      `frozen-${candidateRunId}`,
    );
    if (!frozenEvent.ok) {
      runId = undefined;
      journal = undefined;
      state = undefined;
      return frozenEvent;
    }
    ports.appendEntry?.("workflow-orchestrator-run", {
      at: now(),
      runId: candidateRunId,
      sourcePath,
      digest: frozen.source.digest,
      rowCount: frozen.rows.length,
      executionId: frozen.executionId,
    });
    notify(
      `Orchestrator run ${candidateRunId}: ${frozen.rows.length} frozen plan step(s).`,
    );
    return { ok: true, value: { runId: candidateRunId, view: buildView()!, frozen } };
  }

  const runtime: OrchestratorRuntime = {
    async startFromPlan(input) {
      if (typeof input.planPath !== "string" || input.planPath.trim().length === 0) {
        return fail("invalid", "the approved plan path is required");
      }
      const text = input.planText;
      if (typeof text !== "string" || text.trim().length === 0) {
        return fail("missing_plan", "the approved plan bytes are unavailable; reopen the plan");
      }
      const frozen = createFrozenTodosFromPlan({
        planPath: input.planPath,
        planText: text,
        mode: "orchestrator",
        ...(input.executionId === undefined ? {} : { executionId: input.executionId }),
        ...(input.now === undefined ? {} : { now: input.now }),
      });
      if (!frozen.ok) return fail("invalid", frozen.error);
      return startFromFrozen(
        frozen.snapshot,
        {
          path: input.planPath,
          title: frozen.snapshot.source.title,
          digest: frozen.snapshot.source.digest,
        },
        input.planPath,
      );
    },

    async startFromSteps(input) {
      const frozen = createFrozenTodosFromSteps({
        title: input.title,
        steps: input.steps,
        mode: "orchestrator",
        ...(input.sourceRef === undefined ? {} : { sourceRef: input.sourceRef }),
        ...(input.executionId === undefined ? {} : { executionId: input.executionId }),
        ...(input.now === undefined ? {} : { now: input.now }),
      });
      if (!frozen.ok) return fail("invalid", frozen.error);
      const sourcePath =
        input.sourcePath ??
        `orchestrator/steps-${frozen.snapshot.source.digest.slice(0, 12)}.md`;
      return startFromFrozen(frozen.snapshot, undefined, sourcePath);
    },

    async applyEvent(event) {
      if (!runId || !state) return fail("state", "no run state");
      if (event.runId !== runId) return fail("invalid", "the event belongs to a different run");
      // SAFETY: the caller passes one member of the discriminated RunEvent
      // union; the spread only attaches the runtime's current revision.
      const next = applyRunEvent(state, {
        ...(event as RunEvent),
        expectedRevision: state.revision,
      });
      if (!next.ok) return fail("state", next.error);
      const journaled = await append(
        EVENT_JOURNAL_TYPE[event.type],
        event,
        `${event.type}-${runId}-${next.state.revision}`,
      );
      if (!journaled.ok) return journaled;
      state = next.state;
      return { ok: true, value: { revision: state.revision, view: buildView()! } };
    },

    appendJournal(type, payload, eventId) {
      return append(type, payload, eventId);
    },

    async journalEvents() {
      if (!journal) return fail("journal", "no run journal is bound");
      try {
        const loaded = await journal.load();
        if (!loaded.ok) return fail("journal", `${loaded.code}: ${loaded.error}`);
        return { ok: true, value: loaded.value.events };
      } catch (error: unknown) {
        return fail(
          "journal",
          `the journal could not be read: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },

    view: buildView,

    async restore() {
      if (!runId || !journal) return fail("state", "no run is bound");
      const loaded = await journal.load();
      if (!loaded.ok) return fail("journal", `${loaded.code}: ${loaded.error}`);
      const events = loaded.value.events;
      if (events.length === 0) return fail("journal", "the run journal is empty");

      const created = events.find((event) => event.type === "run.created");
      if (!created || !isRecord(created.payload)) {
        return fail("journal", "the run journal has no creation record");
      }
      const frozenEvent = events.find((event) => event.type === "todos.frozen");
      const frozenPayload = frozenEvent?.payload;
      if (!isRecord(frozenPayload) || !isRecord(frozenPayload.snapshot)) {
        return fail("journal", "the run journal has no frozen TODO snapshot");
      }
      // SAFETY: `todos.frozen` is written only from a validated
      // FrozenTodoSnapshot; the shape checks above keep foreign values out.
      const frozen = frozenPayload.snapshot as unknown as FrozenTodoSnapshot;
      const createdPayload = created.payload;
      const planValue = createdPayload.plan;
      const plan =
        isRecord(planValue) &&
        typeof planValue.path === "string" &&
        typeof planValue.title === "string" &&
        typeof planValue.digest === "string"
          ? { path: planValue.path, title: planValue.title, digest: planValue.digest }
          : undefined;
      const rebuilt = createRunState({
        runId,
        todos: frozen,
        ...(plan === undefined ? {} : { plan }),
        now: typeof created.at === "number" ? created.at : now(),
      });
      if (!rebuilt.ok) return fail("state", rebuilt.error);
      state = rebuilt.state;

      // Replay every reducer event in journal order.
      for (const event of events) {
        const payload = event.payload;
        if (!isRecord(payload) || typeof payload.type !== "string") continue;
        if (!(payload.type in EVENT_JOURNAL_TYPE)) continue;
        if (payload.runId !== runId) continue;
        // SAFETY: the payload is the exact RunEvent this runtime journaled.
        const applied = applyRunEvent(state, {
          ...(payload as unknown as RunEvent),
          expectedRevision: state.revision,
        });
        if (!applied.ok) {
          return fail("state", `journal replay failed at ${event.type}: ${applied.error}`);
        }
        state = applied.state;
      }
      state = { ...state, updatedAt: now() };
      return { ok: true, value: buildView()! };
    },

    async restoreFromPlan(input) {
      const frozen = createFrozenTodosFromPlan({
        planPath: input.planPath,
        planText: input.planText,
        mode: "orchestrator",
        ...(input.executionId === undefined ? {} : { executionId: input.executionId }),
        ...(input.now === undefined ? {} : { now: input.now }),
      });
      if (!frozen.ok) return fail("invalid", frozen.error);
      const candidateRunId = `run-${slug(
        input.planPath.split(/[\\/]/).pop() ?? "plan",
      )}-${frozen.snapshot.source.digest.slice(0, 12)}`;
      const bound = ports.createJournal(candidateRunId);
      const existing = await bound.load();
      if (!existing.ok) return fail("journal", `${existing.code}: ${existing.error}`);
      if (existing.value.events.length === 0) {
        return fail("journal", "no run journal exists for this plan yet");
      }
      runId = candidateRunId;
      journal = bound;
      state = undefined;
      const restored = await runtime.restore();
      if (!restored.ok) {
        runId = undefined;
        journal = undefined;
        return restored;
      }
      return {
        ok: true,
        value: { runId: candidateRunId, view: restored.value, frozen: restored.value.todos },
      };
    },

    async cancel(reason) {
      if (!runId || !state) return fail("state", "no run state");
      const text = clampText(reason, 500) || "cancelled by the user";
      const transitioned = await runtime.applyEvent({
        type: "run.transition",
        runId,
        now: now(),
        to: "cancelled",
      });
      if (!transitioned.ok) return transitioned;
      await append("run.control", { action: "cancel", reason: text }, `cancel-${runId}`);
      notify(`Orchestrator run ${runId} cancelled: ${text}.`, "warning");
      return { ok: true, value: { view: transitioned.value.view } };
    },

    async complete() {
      if (!runId || !state) return fail("state", "no run state");
      const transitioned = await runtime.applyEvent({
        type: "run.transition",
        runId,
        now: now(),
        to: "completed",
      });
      if (!transitioned.ok) return transitioned;
      await append("run.completed", { at: now() }, `completed-${runId}`);
      return { ok: true, value: { view: transitioned.value.view } };
    },
  };

  return runtime;
}
