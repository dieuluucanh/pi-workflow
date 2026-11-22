/**
 * Workflow Extension — parent orchestration runtime (integration step 15).
 *
 * This is the session-owned COMPOSITION ROOT for the Orchestrator parent. It
 * wires the pure modules that already exist into the two facts a parent run
 * actually needs:
 *
 *   1. the exact approved roadmap, snapshotted and journaled (so approval is
 *      bound to bytes, not to a path that may have changed since);
 *   2. a validated execution breakdown plus a SEPARATE, digest-bound execution
 *      approval. Plan approval and mode entry never authorize a dispatch.
 *
 * Everything effectful is injected (journal factory, clock, notify, append):
 * the module itself launches nothing, starts no turn and writes no session
 * file. `index.ts` supplies the ports and sends the one preparation message.
 *
 * Failure behavior is deliberate:
 *   - re-ingesting the SAME bytes is idempotent (same run id, no new event);
 *   - changed bytes invalidate the previous breakdown/approval rather than
 *     silently reusing them;
 *   - a cancelled/refined run has no approval, so `canDispatch()` is false;
 *   - a reload restores from the journal's artifacts, never from a guess.
 */

import {
  snapshotRoadmap,
  type RoadmapSnapshot,
  type RoadmapRequirementSnapshot,
} from "./orchestrator-plan.ts";
import {
  createRunState,
  applyRunEvent,
  nextRunnableTask,
  type RunState,
} from "./orchestrator-state.ts";
import { validateDecomposition } from "./orchestrator-decomposition.ts";
import {
  APPROVAL_CONFIRMATION,
  approveExecution,
  buildExecutionPreview,
  revalidateApproval,
  type ExecutionApprovalRecord,
  type ExecutionLimits,
  type ExecutionOptions,
  type ExecutionPreview,
  type LauncherReadiness,
} from "./orchestrator-approval.ts";
import type { BudgetPlan } from "./orchestrator-budget.ts";
import type { JournalEvent, RunJournal, JournalEventType } from "./orchestrator-store.ts";
import type { RoadmapRequirement, TaskPlan } from "./orchestrator-types.ts";
import type { RunEvent } from "./orchestrator-state.ts";

export const RUNTIME_SCHEMA_VERSION = 1 as const;
export const MAX_PREPARATION_CHARS = 4_000;

export interface ProposalContext {
  orchestratorBudget: BudgetPlan;
  builderBudget: BudgetPlan;
  launcher: LauncherReadiness;
  checks: readonly string[];
  limits: ExecutionLimits;
  options: ExecutionOptions;
}

export interface OrchestratorRuntimePorts {
  /** Journal for one run; the caller owns its directory/profile location. */
  createJournal(runId: string): RunJournal;
  /** Reads the plan the user approved. Defaults to Node fs in index.ts. */
  readRoadmap?: (path: string) => Promise<string>;
  now?: () => number;
  notify?: (message: string, level: "info" | "warning") => void;
  /** Durable branch-local projection entry, when the host has one. */
  appendEntry?: (type: string, data: unknown) => void;
}

export type RuntimeErrorCode =
  | "invalid"
  | "missing_roadmap"
  | "journal"
  | "coverage"
  | "decomposition"
  | "preview"
  | "approval"
  | "state"
  | "cancelled";

export type RuntimeResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: RuntimeErrorCode; error: string };

export interface RuntimeView {
  runId: string;
  phase: RunState["phase"];
  roadmapRevision: number;
  roadmap: {
    path: string;
    digest: string;
    title: string;
    requirementCount: number;
  };
  /** Bounded requirement projection, so a preview can show real scope. */
  requirements: ReadonlyArray<{ roadmapStepId: string; label: string; text: string }>;
  plan: TaskPlan | null;
  preview: ExecutionPreview | null;
  approval: ExecutionApprovalRecord | null;
  preparationStarted: boolean;
  nextTaskId?: string;
  state: RunState;
}

export interface OrchestratorRuntime {
  /** Snapshots the approved plan bytes and creates/continues this run. */
  ingest(input: { planPath: string; planText?: string }): Promise<
    RuntimeResult<{ runId: string; created: boolean; view: RuntimeView }>
  >;
  /** Validates and stores a breakdown; it never approves or dispatches. */
  propose(input: {
    plan: unknown;
    requirements?: readonly RoadmapRequirement[];
    context: ProposalContext;
  }): Promise<RuntimeResult<{ preview: ExecutionPreview; view: RuntimeView }>>;
  /** The SECOND approval: roadmap/plan/limits digest-bound. */
  approve(input: { confirmation: string; approvalId?: string }): Promise<
    RuntimeResult<{ record: ExecutionApprovalRecord; view: RuntimeView }>
  >;
  /** Refine invalidates the shown breakdown; no child is launched. */
  refine(reason: string): Promise<RuntimeResult<{ view: RuntimeView }>>;
  cancel(reason: string): Promise<RuntimeResult<{ view: RuntimeView }>>;
  /** A bounded preparation prompt, exactly once per roadmap revision. */
  preparationMessage(): string | undefined;
  markPreparationStarted(): Promise<RuntimeResult<{ view: RuntimeView }>>;
  /** True only with a live approval that still matches every material input. */
  canDispatch(): { ok: boolean; reasons: string[] };
  /**
   * Applies one reducer event durably: the pure transition is validated first,
   * then journaled, and only then becomes the runtime's state. A journal
   * failure therefore changes nothing in memory.
   */
  applyEvent(
    event: RunEventInput,
  ): Promise<RuntimeResult<{ revision: number; view: RuntimeView }>>;
  /** Intent/ack records that are not reducer transitions. */
  appendJournal(
    type: JournalEventType,
    payload: unknown,
    eventId: string,
  ): Promise<RuntimeResult<void>>;
  /** Durable journal events, for reload-safe dedupe (wakes, receipts). */
  journalEvents(): Promise<RuntimeResult<readonly JournalEvent[]>>;
  view(): RuntimeView | undefined;
  restore(): Promise<RuntimeResult<RuntimeView>>;
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
  "plan.apply": "plan.proposed",
  "run.transition": "run.transition",
  "task.assign": "task.dispatched",
  "task.start": "task.start.ack",
  "task.candidate": "task.reported",
  "task.verify": "task.verified",
  "task.accept": "task.accepted",
  "task.needsFix": "task.needs_fix",
  "task.block": "task.blocked",
  "task.cancel": "task.cancelled",
  "task.supersede": "task.superseded",
  "attempt.launchFailed": "attempt.launch_failed",
  "attempt.rollover": "attempt.rollover",
};

export function createOrchestratorRuntime(
  ports: OrchestratorRuntimePorts,
): OrchestratorRuntime {
  const now = ports.now ?? (() => Date.now());
  let journal: RunJournal | undefined;
  let runId: string | undefined;
  let snapshot: RoadmapSnapshot | undefined;
  let state: RunState | undefined;
  let plan: TaskPlan | null = null;
  let preview: ExecutionPreview | null = null;
  let approval: ExecutionApprovalRecord | null = null;
  let preparationStarted = false;
  let cancelled = false;

  const notify = (message: string, level: "info" | "warning" = "info") => {
    ports.notify?.(message, level);
  };

  const fail = <T>(code: RuntimeErrorCode, error: string): RuntimeResult<T> => ({
    ok: false,
    code,
    error,
  });

  const requirementIds = (): RoadmapRequirement[] =>
    (snapshot?.requirements ?? []).map((entry) => ({
      roadmapStepId: entry.roadmapStepId,
      label: entry.label,
      ...(entry.group === undefined ? {} : { group: entry.group }),
      text: entry.text,
      ...(entry.sourceLines === undefined ? {} : { sourceLines: entry.sourceLines }),
    }));

  const buildView = (): RuntimeView | undefined => {
    if (!runId || !snapshot || !state) return undefined;
    const nextTaskId = nextRunnableTask(state);
    return {
      runId,
      phase: state.phase,
      roadmapRevision: state.roadmapRevision,
      roadmap: {
        path: snapshot.sourcePath,
        digest: snapshot.digest,
        title: snapshot.title,
        requirementCount: snapshot.requirements.length,
      },
      requirements: snapshot.requirements.slice(0, 200).map((entry) => ({
        roadmapStepId: entry.roadmapStepId,
        label: entry.label,
        text: entry.text,
      })),
      plan,
      preview,
      approval,
      preparationStarted,
      ...(nextTaskId === undefined ? {} : { nextTaskId }),
      state,
    };
  };

  const append = async (
    type: Parameters<RunJournal["append"]>[0]["type"],
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

  const apply = (event: Parameters<typeof applyRunEvent>[1]): RuntimeResult<void> => {
    if (!state) return fail("state", "no run state");
    const result = applyRunEvent(state, { ...event, expectedRevision: state.revision });
    if (!result.ok) return fail("state", result.error);
    state = result.state;
    return { ok: true, value: undefined };
  };

  const artifactJson = async (name: string, value: unknown): Promise<RuntimeResult<{ sha256: string }>> => {
    if (!journal) return fail("journal", "no run journal is bound");
    const result = await journal.putArtifact({ name, content: JSON.stringify(value) });
    if (!result.ok) return fail("journal", `${result.code}: ${result.error}`);
    return { ok: true, value: { sha256: result.value.sha256 } };
  };

  const readArtifact = async (sha: string): Promise<RuntimeResult<unknown>> => {
    if (!journal) return fail("journal", "no run journal is bound");
    const result = await journal.getArtifact(sha);
    if (!result.ok) return fail("journal", `${result.code}: ${result.error}`);
    try {
      return { ok: true, value: JSON.parse(result.value) };
    } catch {
      return fail("journal", "an artifact is not valid JSON");
    }
  };

  const loadPlan = async (input: {
    planPath: string;
    planText?: string;
  }): Promise<RuntimeResult<string>> => {
    if (typeof input.planPath !== "string" || input.planPath.trim().length === 0) {
      return fail("invalid", "the approved plan path is required");
    }
    if (typeof input.planText === "string" && input.planText.trim().length > 0) {
      return { ok: true, value: input.planText };
    }
    if (!ports.readRoadmap) {
      return fail("missing_roadmap", "the approved plan bytes are unavailable; reopen the plan");
    }
    try {
      const text = await ports.readRoadmap(input.planPath);
      if (!text || text.trim().length === 0) return fail("missing_roadmap", "the approved plan is empty");
      return { ok: true, value: text };
    } catch (error) {
      return fail(
        "missing_roadmap",
        `the approved plan could not be read: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };

  const runtime: OrchestratorRuntime = {
    async ingest(input) {
      const text = await loadPlan(input);
      if (!text.ok) return text;
      const snap = snapshotRoadmap({ sourcePath: input.planPath, markdown: text.value, now: now() });
      if (!snap.ok) return fail("invalid", snap.error);

      // Deterministic id per roadmap digest: the same bytes resume the same run.
      const digest = snap.snapshot.digest;
      const candidateRunId = `run-${slug(input.planPath.split(/[\\/]/).pop() ?? "roadmap")}-${digest.slice(0, 12)}`;
      const sameRoadmap = runId === candidateRunId && snapshot?.digest === digest;
      if (sameRoadmap) {
        return {
          ok: true,
          value: { runId: runId!, created: false, view: buildView()! },
        };
      }

      runId = candidateRunId;
      journal = ports.createJournal(runId);
      // A journal that already has events is authoritative. Never replace a
      // stored run with a fresh one because restore failed or the bytes moved:
      // that would silently void the breakdown, approvals and acceptance.
      const existing = await journal.load();
      const hadEvents = existing.ok && existing.value.events.length > 0;
      const restored = await runtime.restore();
      if (restored.ok) {
        if (restored.value.roadmap.digest === digest) {
          return { ok: true, value: { runId, created: false, view: restored.value } };
        }
        return fail(
          "invalid",
          "the approved roadmap changed since this run was created; approve the new bytes explicitly (a silent re-ingest would void the stored breakdown and acceptance)",
        );
      }
      if (hadEvents) {
        return fail(
          "journal",
          `the existing run could not be restored (${restored.error}); inspect or recover its journal instead of starting a new run`,
        );
      }

      // Changed bytes: everything downstream (plan, preview, approval) is void.
      plan = null;
      preview = null;
      approval = null;
      preparationStarted = false;
      cancelled = false;

      const created = createRunState({ runId, roadmapRevision: 1, now: now() });
      if (!created.ok) return fail("state", created.error);
      state = created.state;
      snapshot = snap.snapshot;

      const snapshotRef = await artifactJson("roadmap.json", snap.snapshot);
      if (!snapshotRef.ok) return snapshotRef;
      const appended = await append(
        "run.created",
        {
          sourcePath: snap.snapshot.sourcePath,
          digest,
          revision: 1,
          snapshotArtifact: snapshotRef.value.sha256,
          requirementCount: snap.snapshot.requirements.length,
        },
        `created-${runId}`,
      );
      if (!appended.ok) return appended;
      ports.appendEntry?.("workflow-orchestrator-run", {
        at: now(),
        runId,
        roadmapPath: snap.snapshot.sourcePath,
        roadmapDigest: digest,
        roadmapRevision: 1,
      });
      notify(
        `Orchestrator run ${runId}: ${snap.snapshot.requirements.length} roadmap requirement(s) captured. A breakdown must be proposed and approved separately.`,
      );
      return { ok: true, value: { runId, created: true, view: buildView()! } };
    },

    async propose(input) {
      if (!runId || !snapshot || !state) {
        return fail("missing_roadmap", "no approved roadmap is bound to this run");
      }
      if (cancelled) return fail("cancelled", "this run was cancelled; start a new approval");
      if (!isRecord(input.plan)) return fail("invalid", "the breakdown must be an object");
      // SAFETY: the breakdown is re-validated below (run identity, roadmap
      // revision, coverage, DAG and sizing) before anything is stored.
      const planValue = input.plan as unknown as TaskPlan;
      if (planValue.runId !== runId) {
        return fail("invalid", "the breakdown belongs to a different run");
      }
      if (planValue.roadmapRevision !== state.roadmapRevision) {
        return fail(
          "invalid",
          `the breakdown targets roadmap revision ${String(planValue.roadmapRevision)}, current is ${state.roadmapRevision}`,
        );
      }

      const decomposition = validateDecomposition({
        runId,
        roadmapRevision: state.roadmapRevision,
        snapshot,
        tasks: planValue.tasks,
        builder: input.context.builderBudget,
      });
      if (!decomposition.ok) {
        const detail = decomposition.issues
          .slice(0, 5)
          .map((issue) => issue.message)
          .join("; ");
        return fail(
          "decomposition",
          detail || decomposition.error || "the breakdown is not executable",
        );
      }

      const previewResult = buildExecutionPreview({
        runId,
        roadmap: snapshot,
        plan: planValue,
        orchestratorBudget: input.context.orchestratorBudget,
        builderBudget: input.context.builderBudget,
        launcher: input.context.launcher,
        checks: input.context.checks,
        limits: input.context.limits,
        options: input.context.options,
        now: now(),
      });
      if (!previewResult.ok) return fail("preview", previewResult.error);

      plan = planValue;
      preview = previewResult.preview;
      // A new breakdown voids any previous approval, even before it is shown.
      approval = null;
      const proposed = apply({
        type: "plan.apply",
        runId,
        now: now(),
        expectedRevision: state.revision,
        plan: planValue,
        requirements: [...(input.requirements ?? requirementIds())],
      });
      if (!proposed.ok) return proposed;
      const planRef = await artifactJson("plan.json", planValue);
      if (!planRef.ok) return planRef;
      const previewRef = await artifactJson("preview.json", previewResult.preview);
      if (!previewRef.ok) return previewRef;
      const journaled = await append(
        "plan.proposed",
        {
          roadmapRevision: state.roadmapRevision,
          planDigest: previewResult.preview.planDigest,
          planArtifact: planRef.value.sha256,
          previewArtifact: previewRef.value.sha256,
        },
        `plan-proposed-${runId}-${previewResult.preview.planDigest.slice(0, 16)}`,
      );
      if (!journaled.ok) return journaled;
      return { ok: true, value: { preview: previewResult.preview, view: buildView()! } };
    },

    async approve(input) {
      if (!runId || !state || !snapshot || !preview || !plan) {
        return fail("approval", "there is no breakdown to approve");
      }
      if (cancelled) return fail("cancelled", "this run was cancelled");
      const approved = approveExecution(preview, {
        confirmation: input.confirmation,
        approvalId: input.approvalId ?? `approval-${runId}-${preview.planDigest.slice(0, 12)}`,
        now: now(),
      });
      if (!approved.ok) {
        return fail("approval", approved.error);
      }
      const planRef = await artifactJson("plan.json", plan);
      if (!planRef.ok) return planRef;
      const previewRef = await artifactJson("preview.json", preview);
      if (!previewRef.ok) return previewRef;
      const appended = await append(
        "execution.approved",
        {
          record: approved.record,
          planArtifact: planRef.value.sha256,
          previewArtifact: previewRef.value.sha256,
        },
        `execution-approved-${runId}-${approved.record.approvalDigest.slice(0, 16)}`,
      );
      if (!appended.ok) return appended;
      approval = approved.record;
      const ready = apply({ type: "run.transition", runId, now: now(), expectedRevision: state.revision, to: "ready" });
      if (!ready.ok) return ready;
      return { ok: true, value: { record: approved.record, view: buildView()! } };
    },

    async refine(reason) {
      if (!runId || !state) return fail("state", "no run state");
      if (cancelled) return fail("cancelled", "this run was cancelled");
      const text = clampText(reason, 500) || "the user asked to refine the breakdown";
      if (!plan && !preview && !approval) {
        return { ok: true, value: { view: buildView()! } };
      }
      // Journal the invalidation BEFORE touching memory. A refinement must
      // survive reload: the old approval stays dead until a new breakdown is
      // approved again.
      const appended = await append(
        "run.control",
        { action: "refine", reason: text },
        `breakdown-refined-${runId}-${state.revision + 1}`,
      );
      if (!appended.ok) return appended;
      approval = null;
      plan = null;
      preview = null;
      notify(`Breakdown needs refinement: ${text}. Nothing was dispatched.`, "warning");
      if (state.phase === "ready") {
        state = {
          ...state,
          revision: state.revision + 1,
          phase: "awaiting_approval",
          updatedAt: now(),
        };
      }
      return { ok: true, value: { view: buildView()! } };
    },

    async cancel(reason) {
      if (!state) return fail("state", "no run state");
      cancelled = true;
      approval = null;
      plan = null;
      preview = null;
      const text = clampText(reason, 500) || "cancelled by the user";
      const transitioned = apply({ type: "run.transition", runId: runId!, now: now(), expectedRevision: state.revision, to: "cancelled" });
      if (!transitioned.ok) return transitioned;
      const appended = await append("run.control", { action: "cancel", reason: text }, `cancel-${runId}`);
      if (!appended.ok) return appended;
      notify(`Orchestrator run ${runId} cancelled: ${text}. No child was launched.`, "warning");
      return { ok: true, value: { view: buildView()! } };
    },

    preparationMessage() {
      if (!runId || !snapshot || !state || cancelled) return undefined;
      if (preparationStarted) return undefined;
      if (plan) return undefined;
      const requirements = snapshot.requirements
        .slice(0, 200)
        .map((entry) => `- ${entry.roadmapStepId} (${entry.label}) ${entry.text.slice(0, 200)}`)
        .join("\n");
      const message = [
        `Orchestrator preparation for run ${runId}.`,
        `Approved roadmap: ${snapshot.sourcePath} (digest ${snapshot.digest.slice(0, 12)}, revision ${state.roadmapRevision}, ${snapshot.requirements.length} requirements).`,
        "Propose an execution breakdown with the orchestrator_propose_tasks tool. Group requirements into tasks that fit one Build child, declare dependencies, expected files and acceptance checks.",
        "Do NOT dispatch, edit the workspace or claim completion. The user approves the breakdown separately before any child starts.",
        "Requirements:",
        requirements.slice(0, MAX_PREPARATION_CHARS - 1_200),
      ].join("\n");
      return message.slice(0, MAX_PREPARATION_CHARS);
    },

    async markPreparationStarted() {
      if (!runId || !state) return fail("state", "no run state");
      preparationStarted = true;
      const appended = await append(
        "run.preparation",
        { roadmapRevision: state.roadmapRevision, digest: snapshot?.digest ?? null },
        `preparation-${runId}-${state.roadmapRevision}`,
      );
      if (!appended.ok) return appended;
      return { ok: true, value: { view: buildView()! } };
    },

    async applyEvent(event) {
      if (!runId || !state) return fail("state", "no run state");
      if (event.runId !== runId) return fail("invalid", "the event belongs to a different run");
      // SAFETY: the caller passes one member of the discriminated RunEvent
      // union; the spread below only attaches the runtime's current revision,
      // which is what `applyRunEvent` compares against.
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

    canDispatch() {
      const reasons: string[] = [];
      if (!runId || !state) return { ok: false, reasons: ["no run is bound"] };
      if (cancelled) reasons.push("the run was cancelled");
      if (state.phase !== "ready") reasons.push(`the run phase is ${state.phase}, not ready`);
      if (!plan || !preview) reasons.push("no breakdown is approved");
      if (!approval) reasons.push("no execution approval exists");
      if (approval && preview) {
        const revalidated = revalidateApproval(approval, preview);
        if (!revalidated.ok) reasons.push(...(revalidated.reasons ?? ["the approval is stale"]));
      }
      return reasons.length === 0 ? { ok: true, reasons: [] } : { ok: false, reasons };
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
      const payload = created.payload;
      const artifactSha = typeof payload.snapshotArtifact === "string" ? payload.snapshotArtifact : "";
      if (!artifactSha) return fail("journal", "the roadmap snapshot artifact is missing");
      const artifact = await readArtifact(artifactSha);
      if (!artifact.ok) return artifact;
      if (!isRecord(artifact.value) || artifact.value.digest !== payload.digest) {
        return fail("journal", "the roadmap snapshot does not match the journal digest");
      }
      // SAFETY: snapshotRoadmap is the only writer of this artifact and the
      // digest comparison above proves these are the approved bytes.
      snapshot = artifact.value as unknown as RoadmapSnapshot;
      const revision = typeof payload.revision === "number" ? payload.revision : 1;
      const createdState = createRunState({ runId, roadmapRevision: revision, now: now() });
      if (!createdState.ok) return fail("state", createdState.error);
      state = createdState.state;
      cancelled = false;
      preparationStarted = events.some((event) => event.type === "run.preparation");
      approval = null;
      plan = null;
      preview = null;

      for (const event of events) {
        if (event.type === "plan.proposed" && isRecord(event.payload)) {
          // A newly proposed breakdown voids any approval restored earlier in
          // this loop; approvals bind to one exact plan digest.
          approval = null;
          const planArtifact = event.payload.planArtifact;
          const previewArtifact = event.payload.previewArtifact;
          if (typeof planArtifact === "string") {
            const read = await readArtifact(planArtifact);
            // SAFETY: written by `propose` from a validated TaskPlan; the
            // object check above keeps a non-object value out.
            // SAFETY: artifact schema is owned by this runtime.
            if (read.ok && isRecord(read.value)) plan = read.value as unknown as TaskPlan;
          }
          if (typeof previewArtifact === "string") {
            const read = await readArtifact(previewArtifact);
            // SAFETY: written by buildExecutionPreview; the object check above
            // keeps a non-object value out.
            // SAFETY: artifact schema is owned by this runtime.
            if (read.ok && isRecord(read.value)) preview = read.value as unknown as ExecutionPreview;
          }
        }
        if (event.type === "execution.approved" && isRecord(event.payload) && isRecord(event.payload.record)) {
          // SAFETY: the record is written by approveExecution, and dispatch
          // still revalidates every digest before anything starts.
          approval = event.payload.record as unknown as ExecutionApprovalRecord;
        }
        if (event.type === "run.control" && isRecord(event.payload) && event.payload.action === "cancel") {
          cancelled = true;
        }
        if (event.type === "run.control" && isRecord(event.payload) && event.payload.action === "refine") {
          approval = null;
          plan = null;
          preview = null;
          if (state.phase === "ready") {
            state = {
              ...state,
              revision: state.revision + 1,
              phase: "awaiting_approval",
              updatedAt: now(),
            };
          }
        }
      }

      // Replay the complete ordered reducer history. Rebuilding only the
      // plan/approval left tasks, starts, fences and acceptance in memory that
      // a reload lost, so a resumed parent could not know a child was running.
      const reducerTypes = new Set<string>(Object.keys(EVENT_JOURNAL_TYPE));
      for (const event of events) {
        const payload = event.payload;
        if (
          isRecord(payload) &&
          typeof payload.type === "string" &&
          reducerTypes.has(payload.type) &&
          payload.runId === runId
        ) {
          // SAFETY: the payload is the exact RunEvent this runtime journaled in
          // `applyEvent`; the type/runId checks above keep foreign records out.
          const applied = applyRunEvent(state, {
            ...(payload as unknown as RunEvent),
            expectedRevision: state.revision,
          });
          if (!applied.ok) {
            return fail(
              "state",
              `journal replay failed at ${event.type}: ${applied.error}`,
            );
          }
          state = applied.state;
        }
      }

      // Legacy journal written before every transition was journaled: rebuild
      // the plan/approval phase without overwriting a newer reducer phase.
      if (plan && state.planRevision === 0) {
        const applied = applyRunEvent(state, {
          type: "plan.apply",
          runId,
          now: now(),
          expectedRevision: state.revision,
          plan,
          requirements: requirementIds(),
        });
        if (applied.ok) state = applied.state;
      }
      if (approval && state.phase === "awaiting_approval") {
        const ready = applyRunEvent(state, {
          type: "run.transition",
          runId,
          now: now(),
          expectedRevision: state.revision,
          to: "ready",
        });
        if (ready.ok) state = ready.state;
      }
      state = { ...state, updatedAt: now() };
      return { ok: true, value: buildView()! };
    },
  };

  return runtime;
}

/** True when an approval confirmation string is the explicit one. */
export function isExplicitApproval(confirmation: unknown): boolean {
  return confirmation === APPROVAL_CONFIRMATION;
}

/** Requirements currently covered by the run's plan, for UI/status. */
export function coveredRequirementIds(plan: TaskPlan | null): string[] {
  return [...new Set((plan?.tasks ?? []).flatMap((task) => task.covers))];
}

export type { RoadmapRequirementSnapshot };
