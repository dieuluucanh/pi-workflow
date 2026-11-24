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

import { createHash } from "node:crypto";

import {
  applyRunEvent,
  createRunState,
  nextPendingTask,
  reconcileRunStateWithFrozenStatus,
  type RunEvent,
  type RunState,
} from "./orchestrator-state.ts";
import type { JournalEvent, JournalEventType, RunJournal } from "./orchestrator-store.ts";
import { RUN_PHASES, type RunPhase } from "./orchestrator-types.ts";
import {
  CHECK_SPEC_REPAIR_ACTION,
  applyCheckSpecRepair,
  buildCheckSpecRepair,
  checkSpecRepairEventId,
} from "./orchestrator-check-repair.ts";
import type { PlanCheckSpec } from "./plan-checks.ts";
import type {
  CheckExecutionResult,
  CheckFailureClass,
} from "./check-executor.ts";
import {
  FINAL_GATE_EVENT_TYPE,
  buildFinalGatePayload,
  computeFinalGateSpecHash,
  finalGateCheckSpecs,
  finalGateCompletionError,
  finalGateEventId,
  findFinalGateRecord,
  type FinalGatePayload,
} from "./final-gate.ts";
import {
  frozenExecutionToTodoSnapshot,
  readFrozenSnapshot,
  type FrozenExecutionSnapshot,
} from "./frozen-snapshot.ts";
import {
  createFrozenTodosFromPlan,
  createFrozenTodosFromSteps,
  type FrozenTodoSnapshot,
} from "./todo-snapshot.ts";
import type { FrozenWorkspace, WorkspaceSet } from "./orchestrator-workspace-set.ts";

export const RUNTIME_SCHEMA_VERSION = 1 as const;

export interface OrchestratorRuntimePorts {
  /** Journal for one run; the caller owns its directory/profile location. */
  createJournal(runId: string): RunJournal;
  /**
   * Names of every journal under the runs root. Enables the reload-by-plan-path
   * fallback when a plan digest changed; absent hosts keep digest-only restore.
   */
  listRunIds?: () => Promise<readonly string[]>;
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
  /**
   * Diagnostics from the frozen-snapshot reader (a v1 upcast, a quarantined
   * historical check, or a repair instruction). Empty/absent on a clean v2
   * restore; never persisted by a freeze.
   */
  warnings?: string[];
  state: RunState;
}

/** Phases in which a plan-check amendment may be applied. */
export const REPAIRABLE_RUN_PHASES: ReadonlySet<RunPhase> = new Set<RunPhase>([
  "ready",
  "paused",
  "blocked",
]);

export interface RepairCheckSpecsInput {
  specs: readonly PlanCheckSpec[];
  reason: string;
  source: string;
  allowEmpty?: boolean;
  manifestSha256?: string;
  /** Optimistic fence; a mismatch is refused by the journal, naming the seq. */
  expectedSeq?: number;
}

export interface RepairCheckSpecsValue {
  eventId: string;
  /** True when an identical amendment was already applied (no new event). */
  duplicate: boolean;
  /** True when this call appended the amendment. */
  changed: boolean;
  view: RuntimeView;
}

/** One final-gate outcome the runtime turns into a durable marker. */
export interface RecordFinalGateInput {
  ok: boolean;
  results?: readonly CheckExecutionResult[];
  /** workspaceId → the revision the gate actually ran against. */
  workspaceRevisions?: Record<string, string>;
  failureClass?: CheckFailureClass;
  failure?: string;
}

/** The journaled verdict for the CURRENT executable spec. */
export interface FinalGateStatusValue {
  specHash: string;
  record?: FinalGatePayload;
  /** A passing record exists for exactly this spec hash. */
  satisfied: boolean;
}

export interface OrchestratorRuntime {
  /** Freeze the approved plan once and create the run in phase `ready`. */
  startFromPlan(input: {
    planPath: string;
    planText: string;
    workspaces?: readonly FrozenWorkspace[];
    workspaceSet?: WorkspaceSet;
    executionId?: string;
    now?: number;
  }): Promise<RuntimeResult<{ runId: string; view: RuntimeView; frozen: FrozenTodoSnapshot }>>;
  /** Freeze an explicitly agreed standalone list once. */
  startFromSteps(input: {
    title: string;
    steps: readonly string[];
    sourcePath?: string;
    sourceRef?: string;
    workspaces?: readonly FrozenWorkspace[];
    workspaceSet?: WorkspaceSet;
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
    /** Omitted when the plan file is unreadable; the path fallback still runs. */
    planText?: string;
    executionId?: string;
    now?: number;
  }): Promise<RuntimeResult<{ runId: string; view: RuntimeView; frozen: FrozenTodoSnapshot }>>;
  /**
   * Bind the latest non-terminal run whose `run.created.sourcePath` matches the
   * plan, matching case/slash-normalized. Never creates a run.
   */
  restoreByPlanPath(
    planPath: string,
  ): Promise<RuntimeResult<{ runId: string; view: RuntimeView; frozen: FrozenTodoSnapshot }>>;
  cancel(reason: string): Promise<RuntimeResult<{ view: RuntimeView }>>;
  /**
   * Bind an existing journal by run id WITHOUT freezing a plan. Used by the
   * standalone repair tool and by an explicit reopen; it never creates a run.
   */
  openRun(runId: string): Promise<RuntimeResult<RuntimeView>>;
  /**
   * Append one durable `plan-check-specs-repair` amendment. Allowed only in
   * `ready`/`paused`/`blocked` with no live child; rows, ids, statuses,
   * workspaces and `RunState.revision` are left untouched so the next journaled
   * reducer event still replays.
   */
  repairCheckSpecs(
    input: RepairCheckSpecsInput,
  ): Promise<RuntimeResult<RepairCheckSpecsValue>>;
  /**
   * Journal one `final_gate` marker for the current executable spec. The id is
   * derived from the record, so an identical report is idempotent while a new
   * attempt (a different timestamp/result) adds a new line.
   */
  recordFinalGate(
    input: RecordFinalGateInput,
  ): Promise<RuntimeResult<{ specHash: string; record: FinalGatePayload; duplicate: boolean }>>;
  /**
   * Read the journaled verdict for the current snapshot. Completion reuses a
   * passing record instead of re-running the gate, and a changed spec hash
   * (an amendment or a re-freeze) can never inherit an older pass.
   */
  finalGateStatus(): Promise<RuntimeResult<FinalGateStatusValue>>;
  /** Runs the plan-level final checks once, then completes the run. */
  complete(): Promise<RuntimeResult<{ view: RuntimeView }>>;
}

function slug(value: string): string {
  const clean = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return (clean || "run").slice(0, 24);
}

/** Raw plan-byte digest; deliberately independent of the plan compiler. */
function digestOf(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Windows path comparison: slash- and case-insensitive. */
function normalizePlanPath(value: string): string {
  let normalized = value.trim().replace(/\\/g, "/").replace(/\/{2,}/g, "/");
  if (normalized.length > 1) normalized = normalized.replace(/\/+$/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

const TERMINAL_RUN_PHASES: ReadonlySet<RunPhase> = new Set<RunPhase>([
  "completed",
  "failed",
  "cancelled",
]);

/** Phase derived from journal records without replaying the whole reducer. */
function phaseFromEvents(events: readonly JournalEvent[]): RunPhase {
  let phase: RunPhase = "ready";
  for (const event of events) {
    if (event.type === "run.completed") {
      phase = "completed";
      continue;
    }
    if (event.type !== "run.transition") continue;
    const payload = event.payload;
    if (!isRecord(payload) || typeof payload.to !== "string") continue;
    const to = payload.to;
    if ((RUN_PHASES as readonly string[]).includes(to)) phase = to as RunPhase;
  }
  return phase;
}

function clampText(value: unknown, max: number): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Content-addressed identity of the executable final gate for one snapshot. */
function finalGateSpecHashFor(snapshot: FrozenTodoSnapshot): string {
  return computeFinalGateSpecHash({
    checks: finalGateCheckSpecs(snapshot),
    workspaces: snapshot.workspaces,
  });
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
  /** Reader diagnostics from the last restore; not part of the journal. */
  let restoreWarnings: string[] = [];

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
      ...(restoreWarnings.length === 0 ? {} : { warnings: [...restoreWarnings] }),
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
    execution?: FrozenExecutionSnapshot,
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
    restoreWarnings = [];

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
      {
        executionId: frozen.executionId,
        digest: frozen.source.digest,
        snapshot: execution ?? frozen,
      },
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
        ...(input.workspaces === undefined ? {} : { workspaces: input.workspaces }),
        ...(input.workspaceSet === undefined
          ? {}
          : { workspaces: input.workspaceSet.roots }),
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
        frozen.execution,
      );
    },

    async startFromSteps(input) {
      const frozen = createFrozenTodosFromSteps({
        title: input.title,
        steps: input.steps,
        mode: "orchestrator",
        ...(input.workspaces === undefined ? {} : { workspaces: input.workspaces }),
        ...(input.workspaceSet === undefined
          ? {}
          : { workspaces: input.workspaceSet.roots }),
        ...(input.sourceRef === undefined ? {} : { sourceRef: input.sourceRef }),
        ...(input.executionId === undefined ? {} : { executionId: input.executionId }),
        ...(input.now === undefined ? {} : { now: input.now }),
      });
      if (!frozen.ok) return fail("invalid", frozen.error);
      const sourcePath =
        input.sourcePath ??
        `orchestrator/steps-${frozen.snapshot.source.digest.slice(0, 12)}.md`;
      return startFromFrozen(frozen.snapshot, undefined, sourcePath, frozen.execution);
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
      const frozenEvents = events.filter((event) => event.type === "todos.frozen");
      if (frozenEvents.length === 0) {
        return fail("journal", "the run journal has no frozen TODO snapshot");
      }
      // A second freeze is a re-freeze attempt, not history this build can
      // trust: only `startFromPlan` may compile a snapshot, and a run's rows
      // are the original contract. Fail closed naming the offending seq rather
      // than silently adopting whatever plan text was available later.
      if (frozenEvents.length > 1) {
        const extra = frozenEvents[1]!;
        return fail(
          "journal",
          `the run journal has more than one frozen TODO snapshot (seq ${extra.seq}); a run may be frozen only once`,
        );
      }
      const frozenEvent = frozenEvents[0]!;
      const frozenPayload = frozenEvent.payload;
      if (!isRecord(frozenPayload) || !isRecord(frozenPayload.snapshot)) {
        return fail(
          "journal",
          `the run journal has no frozen TODO snapshot (seq ${frozenEvent.seq})`,
        );
      }
      // Read v1 or v2 through the one reader: new journals store the compiled
      // v2 artifact, an existing v1 journal upcasts in memory, and a malformed
      // historical check is quarantined rather than executed.
      const read = readFrozenSnapshot(frozenPayload.snapshot);
      if (!read.ok) {
        return fail(
          "journal",
          `the frozen TODO snapshot at seq ${frozenEvent.seq} is invalid: ${read.error}`,
        );
      }
      // The envelope and the snapshot came from one writer; a mismatch means
      // the payload was assembled or edited after the freeze.
      if (
        typeof frozenPayload.executionId === "string" &&
        frozenPayload.executionId !== read.snapshot.executionId
      ) {
        return fail(
          "journal",
          `the frozen TODO snapshot at seq ${frozenEvent.seq} has a mismatched execution id`,
        );
      }
      if (
        typeof frozenPayload.digest === "string" &&
        frozenPayload.digest !== read.snapshot.source.digest
      ) {
        return fail(
          "journal",
          `the frozen TODO snapshot at seq ${frozenEvent.seq} has a mismatched source digest`,
        );
      }
      const frozen = frozenExecutionToTodoSnapshot(read.snapshot);
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
        // Replay must start from all-pending tasks: a seeded `accepted` row
        // would reject its own historical `task.start`. Status reconciliation
        // happens once, after the loop.
        honorRowStatus: false,
      });
      if (!rebuilt.ok) return fail("state", rebuilt.error);
      state = rebuilt.state;

      // Replay every reducer event in journal order. Amendment control events
      // are applied in place: they replace the executable check list without
      // moving the revision, so the reducer fence stays reproducible.
      for (const event of events) {
        const payload = event.payload;
        if (!isRecord(payload)) continue;
        if (event.type === "run.control" && payload.action === CHECK_SPEC_REPAIR_ACTION) {
          const amended = applyCheckSpecRepair(state.todos, payload);
          if (!amended.ok) {
            return fail(
              "state",
              `journal replay failed at ${event.type} seq ${event.seq}: ${amended.error}`,
            );
          }
          state = { ...state, todos: amended.value.snapshot };
          continue;
        }
        if (typeof payload.type !== "string") continue;
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
      // Rows finished/abandoned before the freeze must not come back as work.
      state = { ...reconcileRunStateWithFrozenStatus(state, now()), updatedAt: now() };
      restoreWarnings = [...read.warnings];
      for (const warning of restoreWarnings) {
        notify(warning, "warning");
      }
      for (const entry of read.quarantined) {
        notify(
          `Frozen snapshot at seq ${frozenEvent.seq}: a ${entry.scope} check was quarantined (${entry.reason}); run /orchestrator-repair-checks to amend the final checks.`,
          "warning",
        );
      }
      return { ok: true, value: buildView()! };
    },

    async restoreByPlanPath(planPath) {
      if (typeof planPath !== "string" || planPath.trim().length === 0) {
        return fail("invalid", "the approved plan path is required");
      }
      if (!ports.listRunIds) {
        return fail("invalid", "run listing is unavailable; cannot restore by plan path");
      }
      const wanted = normalizePlanPath(planPath);
      let runIds: readonly string[];
      try {
        runIds = await ports.listRunIds();
      } catch (error: unknown) {
        return fail(
          "journal",
          `the run list could not be read: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      const candidates: {
        runId: string;
        at: number;
        terminal: boolean;
        journal: RunJournal;
      }[] = [];
      for (const id of runIds) {
        if (typeof id !== "string" || id.trim().length === 0) continue;
        let bound: RunJournal;
        try {
          bound = ports.createJournal(id);
        } catch {
          continue;
        }
        const loaded = await bound.load();
        // A corrupt or foreign run must not poison the scan for the rest.
        if (!loaded.ok) continue;
        const created = loaded.value.events.find((event) => event.type === "run.created");
        if (!created || !isRecord(created.payload)) continue;
        const sourcePath = created.payload.sourcePath;
        if (typeof sourcePath !== "string") continue;
        if (normalizePlanPath(sourcePath) !== wanted) continue;
        candidates.push({
          runId: id,
          at: typeof created.at === "number" ? created.at : 0,
          terminal: TERMINAL_RUN_PHASES.has(phaseFromEvents(loaded.value.events)),
          journal: bound,
        });
      }
      if (candidates.length === 0) {
        return fail("journal", "no run journal exists for this plan yet");
      }
      // Deterministic order: creation time, then run id.
      candidates.sort((a, b) => a.at - b.at || (a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0));
      const live = candidates.filter((candidate) => !candidate.terminal);
      if (live.length > 1) {
        return fail(
          "state",
          `more than one active run matches this plan: ${live
            .map((candidate) => candidate.runId)
            .join(", ")}. Open one explicitly by run id.`,
        );
      }
      // Prefer a non-terminal run; otherwise rebind the newest terminal one.
      const chosen = live[0] ?? candidates[candidates.length - 1]!;
      runId = chosen.runId;
      journal = chosen.journal;
      state = undefined;
      const restored = await runtime.restore();
      if (!restored.ok) {
        runId = undefined;
        journal = undefined;
        state = undefined;
        return restored;
      }
      return {
        ok: true,
        value: { runId: chosen.runId, view: restored.value, frozen: restored.value.todos },
      };
    },

    async restoreFromPlan(input) {
      if (typeof input.planPath !== "string" || input.planPath.trim().length === 0) {
        return fail("invalid", "the approved plan path is required");
      }
      const planText = input.planText;
      if (typeof planText === "string" && planText.length > 0) {
        // The candidate id is derived from the raw plan bytes, NOT from the
        // compiler: a plan that no longer compiles must still rebind its
        // intact journal, and an edited plan simply misses this candidate.
        const digest = digestOf(planText);
        const candidateRunId = `run-${slug(
          input.planPath.split(/[\\/]/).pop() ?? "plan",
        )}-${digest.slice(0, 12)}`;
        let bound: RunJournal | undefined;
        try {
          bound = ports.createJournal(candidateRunId);
        } catch {
          bound = undefined;
        }
        if (bound) {
          try {
            const existing = await bound.load();
            if (!existing.ok) return fail("journal", `${existing.code}: ${existing.error}`);
            if (existing.value.events.length > 0) {
              runId = candidateRunId;
              journal = bound;
              state = undefined;
              const restored = await runtime.restore();
              if (!restored.ok) {
                runId = undefined;
                journal = undefined;
                state = undefined;
                return restored;
              }
              return {
                ok: true,
                value: { runId: candidateRunId, view: restored.value, frozen: restored.value.todos },
              };
            }
          } catch (error: unknown) {
            return fail(
              "journal",
              `the run journal could not be read: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          }
        }
      }
      // Digest changed (or the plan is unreadable): fall back to the plan path.
      if (!ports.listRunIds) {
        return fail("journal", "no run journal exists for this plan yet");
      }
      return runtime.restoreByPlanPath(input.planPath);
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

    async repairCheckSpecs(input) {
      if (!runId || !journal || !state) return fail("state", "no run state");
      if (!REPAIRABLE_RUN_PHASES.has(state.phase)) {
        return fail(
          "state",
          `cannot amend final checks while the run is ${state.phase}; pause it first`,
        );
      }
      if (state.order.some((taskId) => state!.tasks[taskId]?.state === "running")) {
        return fail(
          "state",
          "a live child still owns a running row; stop it before amending final checks",
        );
      }
      const built = buildCheckSpecRepair({
        executionId: state.todos.executionId,
        snapshot: state.todos,
        specs: input.specs,
        reason: input.reason,
        source: input.source,
        approvedAt: now(),
        ...(input.allowEmpty === undefined ? {} : { allowEmpty: input.allowEmpty }),
        ...(input.manifestSha256 === undefined
          ? {}
          : { manifestSha256: input.manifestSha256 }),
      });
      if (!built.ok) return fail("invalid", built.error);
      const payload = built.value;
      const eventId = checkSpecRepairEventId(payload);

      // Idempotency by event id FIRST: the journal dedupes a known id, so a
      // repeated apply must not be re-judged against the now-advanced previous.
      const loaded = await journal.load();
      if (!loaded.ok) return fail("journal", `${loaded.code}: ${loaded.error}`);
      const known = loaded.value.events.some((event) => event.eventId === eventId);
      // Apply the normalizer once so an already-amended snapshot is a no-op.
      const amended = applyCheckSpecRepair(state.todos, payload);
      if (!amended.ok) return fail("invalid", amended.error);
      if (known || !amended.value.changed) {
        state = { ...state, todos: amended.value.snapshot, updatedAt: now() };
        return {
          ok: true,
          value: { eventId, duplicate: true, changed: false, view: buildView()! },
        };
      }

      const appended = await journal.append({
        type: "run.control",
        payload,
        eventId,
        at: now(),
        ...(input.expectedSeq === undefined ? {} : { expectedSeq: input.expectedSeq }),
      });
      if (!appended.ok) return fail("journal", `${appended.code}: ${appended.error}`);
      if (appended.value.duplicate) {
        state = { ...state, todos: amended.value.snapshot, updatedAt: now() };
        return {
          ok: true,
          value: { eventId, duplicate: true, changed: false, view: buildView()! },
        };
      }
      // Only `todos` and `updatedAt` move: revision stays, so the next reducer
      // event journals a revision the replay reproduces exactly.
      state = { ...state, todos: amended.value.snapshot, updatedAt: now() };
      notify(
        `Orchestrator run ${runId}: ${payload.next.planChecks.length} final check(s) amended (${payload.reason}).`,
        "warning",
      );
      return {
        ok: true,
        value: { eventId, duplicate: false, changed: true, view: buildView()! },
      };
    },

    async recordFinalGate(input) {
      if (!runId || !journal || !state) return fail("state", "no run state");
      const specHash = finalGateSpecHashFor(state.todos);
      const record = buildFinalGatePayload({
        specHash,
        ok: input.ok === true,
        checkedAt: now(),
        ...(input.results === undefined ? {} : { results: input.results }),
        ...(input.workspaceRevisions === undefined
          ? {}
          : { workspaceRevisions: input.workspaceRevisions }),
        ...(input.failureClass === undefined ? {} : { failureClass: input.failureClass }),
        ...(input.failure === undefined ? {} : { failure: input.failure }),
      });
      const eventId = finalGateEventId(record);
      const loaded = await journal.load();
      if (!loaded.ok) return fail("journal", `${loaded.code}: ${loaded.error}`);
      // Idempotency by deterministic id: the store dedupes a known id, so an
      // identical retry is a no-op while a new attempt gets its own line.
      if (loaded.value.events.some((event) => event.eventId === eventId)) {
        return { ok: true, value: { specHash, record, duplicate: true } };
      }
      const appended = await journal.append({
        type: FINAL_GATE_EVENT_TYPE,
        payload: record,
        eventId,
        at: now(),
      });
      if (!appended.ok) return fail("journal", `${appended.code}: ${appended.error}`);
      return {
        ok: true,
        value: { specHash, record, duplicate: appended.value.duplicate },
      };
    },

    async finalGateStatus() {
      if (!runId || !journal || !state) return fail("state", "no run state");
      const specHash = finalGateSpecHashFor(state.todos);
      let events: readonly JournalEvent[];
      try {
        const loaded = await journal.load();
        if (!loaded.ok) return fail("journal", `${loaded.code}: ${loaded.error}`);
        events = loaded.value.events;
      } catch (error: unknown) {
        return fail(
          "journal",
          `the run journal could not be read: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      const record = findFinalGateRecord(events, specHash);
      return { ok: true, value: { specHash, ...(record === undefined ? {} : { record }), satisfied: record?.ok === true } };
    },

    async openRun(id) {
      if (typeof id !== "string" || id.trim().length === 0) {
        return fail("invalid", "a run id is required");
      }
      const bound = ports.createJournal(id);
      const loaded = await bound.load();
      if (!loaded.ok) return fail("journal", `${loaded.code}: ${loaded.error}`);
      if (loaded.value.events.length === 0) {
        return fail("journal", `no run journal exists for ${id}`);
      }
      runId = id;
      journal = bound;
      state = undefined;
      const restored = await runtime.restore();
      if (!restored.ok) {
        runId = undefined;
        journal = undefined;
        state = undefined;
        return restored;
      }
      return { ok: true, value: restored.value };
    },

    async complete() {
      if (!runId || !state) return fail("state", "no run state");
      // Completion is a verified terminal claim: every row must be accepted
      // (the reducer enforces that) AND a passing final-gate marker must exist
      // for exactly this executable spec. A changed check list needs a new
      // gate; a passing one is reused instead of being run twice.
      const gate = await runtime.finalGateStatus();
      if (!gate.ok) return gate;
      if (!gate.value.satisfied) {
        return fail(
          "state",
          finalGateCompletionError(gate.value.specHash, gate.value.record),
        );
      }
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
