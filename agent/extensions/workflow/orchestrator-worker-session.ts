/**
 * Workflow Extension — managed worker session binding (integration step 14).
 *
 * Step 13 created the authority half of a managed child (`orchestrator-worker-
 * runtime.ts`): readiness is not mutation authority, and only a parent grant
 * opens the workspace. This module binds that authority to the things a real
 * child session actually does:
 *
 *   - report / checkpoint tools (bounded, and never acceptance);
 *   - a task-local TODO list built from the ASSIGNMENT, never the roadmap;
 *   - the quiescence fence fed by real tool, follow-up, question and settle
 *     events;
 *   - mutation admission for every tool and user-bash surface, including tools
 *     this build does not know (unknown ⇒ mutating ⇒ checked).
 *
 * Two invariants are easy to lose when wiring these together, so they are
 * structural here rather than comments:
 *
 *   1. **A report is not acceptance.** `report()` only stores a candidate. The
 *      binding exposes no transition to `accepted`, and `canAccept()` is the
 *      parent-side eligibility check, not a decision.
 *   2. **A fence wins over a ready-but-granted worker.** Once quiescent, the
 *      candidate fence revokes mutation even though the managed gate still has
 *      a live grant; the parent must explicitly resume it.
 *
 * Nothing here launches, dispatches, writes a file or marks a roadmap complete.
 */

import {
  agentSettled,
  canAccept,
  canMutate as fenceAllowsMutation,
  followUpEnded,
  followUpStarted,
  ingestWorkerReport,
  openCandidateFence,
  recordCheckpoint,
  resumeForRepair,
  toolEnded,
  toolStarted,
  type AcceptEligibility,
  type CandidateState,
  type FenceResult,
  type ReportContext,
} from "./orchestrator-candidate.ts";
import type { WorkerRuntime } from "./orchestrator-worker-runtime.ts";
import {
  applyWorkerDoneTags,
  buildWorkerTodos,
  completeWorkerTodo,
  detectOutOfScopeChanges,
  syncWorkerTodos,
  type OutOfScopeResult,
  type RoadmapReference,
  type WorkerAssignmentScope,
  type WorkerInteraction,
  type WorkerTodoEffects,
  type WorkerTodoList,
  type WorkerTodoResult,
} from "./orchestrator-worker-todos.ts";
import { childPushPolicy, suppressChildCommit } from "./orchestrator-commits.ts";
import type { BranchEntryLike } from "./managed-session.ts";

/**
 * Conservative read-only classification. Anything not named here — including a
 * tool this build has never seen, a deferred mutating tool, or a user-invented
 * name — is treated as a mutation and goes through the gate.
 */
export const READ_ONLY_WORKER_TOOLS: ReadonlySet<string> = new Set([
  "read",
  "grep",
  "find",
  "ls",
  "explore",
  "questionnaire",
  "workflow_todo",
  "workflow_worker_ready",
  "orchestrator_report",
  "orchestrator_checkpoint",
]);

export function isMutatingWorkerTool(tool: string): boolean {
  return !READ_ONLY_WORKER_TOOLS.has(tool);
}

/** Worker report/checkpoint tool descriptors, registered by `index.ts`. */
export interface WorkerToolSpec {
  name: "orchestrator_report" | "orchestrator_checkpoint";
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, unknown>;
    required: string[];
    additionalProperties: false;
  };
}

export const WORKER_TOOL_SPECS: readonly WorkerToolSpec[] = [
  {
    name: "orchestrator_report",
    description:
      "Report the assignment's outcome to the parent. This is a claim, not acceptance: the parent verifies the workspace and evidence itself.",
    parameters: {
      type: "object",
      properties: {
        report: { type: "object", description: "WorkerReport (schemaVersion, ids, outcome, criteria, changes, checks)" },
      },
      required: ["report"],
      additionalProperties: false,
    },
  },
  {
    name: "orchestrator_checkpoint",
    description:
      "Record a bounded progress checkpoint. A checkpoint can never become a candidate or complete the assignment.",
    parameters: {
      type: "object",
      properties: { summary: { type: "string" } },
      required: ["summary"],
      additionalProperties: false,
    },
  },
];

export interface WorkerToolCallResult {
  ok: boolean;
  text: string;
  /** Present only when a report was stored (never an acceptance). */
  candidateStored?: boolean;
}

export interface WorkerSessionInput {
  runtime: WorkerRuntime;
  assignment: WorkerAssignmentScope;
  /** Local task plan text; must not be the parent roadmap. */
  planText?: string | null;
  now?: () => number;
}

export interface WorkerSessionBinding {
  readonly runtime: WorkerRuntime;
  readonly assignment: WorkerAssignmentScope;
  /** Current candidate/fence state. */
  fence(): CandidateState;
  /** The child's own list; undefined until initialized. */
  todos(): WorkerTodoList | undefined;

  initializeTodos(planText?: string | null): WorkerTodoResult<WorkerTodoList>;
  syncTodos(planText?: string | null): WorkerTodoResult<WorkerTodoList>;
  completeTodo(input: { ref?: number; text?: string; origin: "todo" | "done-tag" }): WorkerTodoResult<WorkerTodoList>;
  applyDoneTags(message: string): WorkerTodoResult<{ list: WorkerTodoList; effects: WorkerTodoEffects }>;

  /** Tool admission: unknown tools are mutations. */
  admitTool(tool: string): FenceResult<CandidateState>;
  noteToolEnded(now?: number): void;
  admitFollowUp(): FenceResult<CandidateState>;
  noteFollowUpEnded(now?: number): void;
  /** Only `agent_settled` may be routed here — never `agent_end`. */
  noteSettled(now?: number): void;

  report(raw: unknown, now?: number): FenceResult<CandidateState>;
  checkpoint(summary: string, now?: number): void;
  /** Parent-side eligibility ONLY; this never accepts. */
  acceptEligibility(): AcceptEligibility;
  /** Explicit parent repair authorization; the only way out of a fence. */
  resumeForRepair(authorization: string, now?: number): FenceResult<CandidateState>;

  /** Combined admission: managed grant AND candidate fence. */
  mutationBlockReason(tool: string): string | undefined;
  canMutate(tool: string): boolean;

  scope(paths: readonly string[]): OutOfScopeResult;
  interaction(kind: WorkerInteraction["kind"], note?: string): { recorded: WorkerInteraction; revalidate: true };
  /** A child may never become the parent scheduler. */
  refuseOrchestratorEntry(): string;
  /** Child commits/pushes stay suppressed regardless of mode. */
  commitSurface(tool: string): { allowed: boolean; reason?: string };

  /** Structured tool entry points for the registered descriptors. */
  callReportTool(params: unknown): WorkerToolCallResult;
  callCheckpointTool(params: unknown): WorkerToolCallResult;

  close(): void;
}

function maxReportText(value: unknown, max = 2_000): string {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim().slice(0, max);
}

export function createWorkerSessionBinding(input: WorkerSessionInput): WorkerSessionBinding {
  const now = input.now ?? (() => Date.now());
  const { runtime, assignment } = input;
  let fenceState = openCandidateFence();
  let list: WorkerTodoList | undefined;
  let initialPlanText: string | null | undefined = input.planText;
  let closed = false;
  const interactions: WorkerInteraction[] = [];

  const context = (): ReportContext => ({
    runId: runtime.gate.context.runId,
    taskId: runtime.gate.context.taskId,
    attemptId: runtime.gate.context.attemptId,
    sessionId: runtime.gate.sessionKey(),
  });

  const fenceBlocked = (): string | undefined => {
    if (closed) return "This worker session is closed; the parent must reopen the task.";
    if (!fenceAllowsMutation(fenceState)) {
      return "The child is quiescent/fenced: mutation authority is revoked until the parent authorizes a repair.";
    }
    return undefined;
  };

  /** Combined managed-gate + fence admission. */
  const combinedBlockReason = (tool: string): string | undefined => {
    if (closed) return "This worker session is closed; the parent must reopen the task.";
    // Read-only inspection stays available before readiness and while fenced:
    // that is how a child reads its assignment and how a repair is diagnosed.
    if (!isMutatingWorkerTool(tool)) return undefined;
    const gateReason = runtime.gate.mutationBlockReason(tool);
    if (gateReason) return gateReason;
    return fenceBlocked();
  };

  const binding: WorkerSessionBinding = {
    runtime,
    assignment,

    fence: () => fenceState,
    todos: () => list,

    initializeTodos(planText) {
      if (planText !== undefined) initialPlanText = planText;
      const built = buildWorkerTodos({
        assignment,
        planText: initialPlanText ?? null,
        now: now(),
      });
      if (!built.ok) return built;
      list = built.value;
      return { ok: true, value: list };
    },

    syncTodos(planText) {
      if (!list) return binding.initializeTodos(planText);
      const synced = syncWorkerTodos({
        list,
        assignment,
        ...(planText === undefined ? {} : { planText }),
        now: now(),
      });
      if (!synced.ok) return synced;
      list = synced.value.list;
      return { ok: true, value: list };
    },

    completeTodo(entry) {
      if (!list) {
        return { ok: false, code: "invalid", error: "the task-local list is not initialized" };
      }
      const done = completeWorkerTodo({
        list,
        ...(entry.ref === undefined ? {} : { ref: entry.ref }),
        ...(entry.text === undefined ? {} : { text: entry.text }),
        origin: entry.origin,
        now: now(),
      });
      if (!done.ok) return done;
      list = done.value.list;
      return { ok: true, value: list };
    },

    applyDoneTags(message) {
      if (!list) {
        return { ok: false, code: "invalid", error: "the task-local list is not initialized" };
      }
      const tagged = applyWorkerDoneTags({ list, message, now: now() });
      if (!tagged.ok) return tagged;
      list = tagged.value.list;
      return { ok: true, value: { list: tagged.value.list, effects: tagged.value.effects } };
    },

    admitTool(tool) {
      const blocked = combinedBlockReason(tool);
      if (blocked) {
        return {
          ok: false,
          code: isMutatingWorkerTool(tool) ? "fenced" : "authorization",
          error: blocked,
        };
      }
      if (!isMutatingWorkerTool(tool)) return { ok: true, value: fenceState };
      const started = toolStarted(fenceState);
      if (!started.ok) return started;
      fenceState = started.value;
      return { ok: true, value: fenceState };
    },

    noteToolEnded(at) {
      fenceState = toolEnded(fenceState, at ?? now());
    },

    admitFollowUp() {
      const blocked = fenceBlocked();
      if (blocked) return { ok: false, code: "fenced", error: blocked };
      const started = followUpStarted(fenceState);
      if (!started.ok) return started;
      fenceState = started.value;
      return { ok: true, value: fenceState };
    },

    noteFollowUpEnded(at) {
      fenceState = followUpEnded(fenceState, at ?? now());
    },

    noteSettled(at) {
      fenceState = agentSettled(fenceState, at ?? now());
    },

    report(raw, at) {
      if (closed) {
        return { ok: false, code: "authorization", error: "this worker session is closed" };
      }
      // Dedupe a retried identical report instead of replacing the candidate.
      const existing = fenceState.candidate;
      const candidateId =
        raw && typeof raw === "object" && !Array.isArray(raw)
          ? (raw as Record<string, unknown>).reportId
          : undefined;
      if (
        existing &&
        typeof candidateId === "string" &&
        candidateId === existing.reportId &&
        (fenceState.phase === "report_received" || fenceState.phase === "fenced")
      ) {
        return { ok: true, value: fenceState };
      }
      const ingested = ingestWorkerReport(fenceState, { raw, context: context(), now: at ?? now() });
      if (!ingested.ok) return ingested;
      fenceState = ingested.value;
      return { ok: true, value: fenceState };
    },

    checkpoint(summary, at) {
      fenceState = recordCheckpoint(fenceState, { summary, now: at ?? now() });
    },

    acceptEligibility: () => canAccept(fenceState),

    resumeForRepair(authorization, at) {
      if (closed) {
        return { ok: false, code: "authorization", error: "this worker session is closed" };
      }
      const resumed = resumeForRepair(fenceState, { authorization, now: at ?? now() });
      if (!resumed.ok) return resumed;
      fenceState = resumed.value;
      // A repair grant is a fresh parent authorization; readiness must already
      // hold, and the parent must have renewed the grant for this attempt.
      if (!runtime.gate.authorization()) {
        fenceState = { ...fenceState, phase: "fenced", reason: "no live parent grant" };
        return {
          ok: false,
          code: "authorization",
          error: "the parent must grant this attempt before a repair can resume mutation",
        };
      }
      return { ok: true, value: fenceState };
    },

    mutationBlockReason: combinedBlockReason,
    canMutate: (tool) => combinedBlockReason(tool) === undefined,

    scope(paths) {
      return detectOutOfScopeChanges({ assignment, changedPaths: paths });
    },

    interaction(kind, note) {
      const bounded = note === undefined ? undefined : maxReportText(note, 500);
      const interaction: WorkerInteraction = {
        kind,
        ...(bounded ? { note: bounded } : {}),
      };
      interactions.push(interaction);
      return { recorded: interaction, revalidate: true };
    },

    refuseOrchestratorEntry() {
      return "A managed worker cannot enter Orchestrator mode: orchestration is the parent's role. Its eligible cycle is Default → Plan → Build → Default.";
    },

    commitSurface(tool) {
      const normalized = tool.toLowerCase();
      if (normalized.includes("commit") || normalized.includes("push") || normalized === "bash") {
        const policy = childPushPolicy();
        return {
          allowed: false,
          reason: `Managed children never commit or push (${policy.reason}). The parent commits accepted work.`,
        };
      }
      return { allowed: true };
    },

    callReportTool(params) {
      const record =
        params && typeof params === "object" && !Array.isArray(params)
          ? (params as Record<string, unknown>)
          : {};
      const result = binding.report(record.report);
      if (!result.ok) return { ok: false, text: result.error };
      const candidate = result.value.candidate;
      const suppressed = suppressChildCommit({ source: "report", managed: true });
      const suppressionNote = suppressed.suppressed ? ` (${suppressed.reason})` : "";
      return {
        ok: true,
        candidateStored: !!candidate,
        text: candidate
          ? `Report ${candidate.reportId} stored for parent verification. Phase: ${result.value.phase}. This is not acceptance, and no commit was triggered${suppressionNote}.`
          : `Report stored, waiting for the tool batch to drain. Phase: ${result.value.phase}.`,
      };
    },

    callCheckpointTool(params) {
      const record =
        params && typeof params === "object" && !Array.isArray(params)
          ? (params as Record<string, unknown>)
          : {};
      const summary = maxReportText(record.summary);
      if (!summary) return { ok: false, text: "a checkpoint needs a short summary" };
      binding.checkpoint(summary);
      return { ok: true, text: `Checkpoint recorded (${summary.slice(0, 120)}). It is not a candidate.` };
    },

    close() {
      closed = true;
      runtime.close();
    },
  };

  return binding;
}

/** Roadmap reference carried into the child: read-only, never local work. */
export function workerRoadmapReference(input: {
  path: string;
  digest: string;
  revision: number;
}): RoadmapReference {
  return { path: input.path, digest: input.digest, revision: input.revision };
}

/** Custom entry the host writes with the task-local work contract. */
export const WORKER_SCOPE_ENTRY = "workflow-task-scope";
export const WORKER_ROADMAP_ENTRY = "workflow-roadmap-reference";

export type WorkerAssignmentRead =
  | { ok: true; scope: WorkerAssignmentScope; model?: { provider: string; id: string } }
  | { ok: false; reason: string };

function stringList(value: unknown, max: number): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") return undefined;
    const text = entry.trim();
    if (!text || text.length > 500) return undefined;
    out.push(text);
    if (out.length > max) return undefined;
  }
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Text of a custom message entry; the Desktop host writes bootstrap as one. */
function messageText(message: unknown): string | undefined {
  if (!isRecord(message)) return undefined;
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const parts: string[] = [];
  for (const block of content) {
    if (isRecord(block) && block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    }
  }
  return parts.length > 0 ? parts.join("\n") : undefined;
}

/**
 * Reads the newest record for a custom type in EITHER host shape:
 *   - a custom ENTRY whose `data` is the record (Workflow's own SDK writer);
 *   - a custom MESSAGE whose text content is the JSON record (Desktop's
 *     related-session bootstrap, appended before `session_start`).
 * Reading only the first shape would make every Desktop child look unassigned.
 */
function newestRecord(
  entries: readonly BranchEntryLike[],
  customType: string,
): Record<string, unknown> | undefined {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (!entry) continue;
    if (entry.type === "custom" && entry.customType === customType) {
      const data = entry.data;
      return isRecord(data) ? data : undefined;
    }
    if (
      entry.type === "message" &&
      isRecord(entry.message) &&
      entry.message.customType === customType
    ) {
      const text = messageText(entry.message);
      if (text === undefined) return undefined;
      try {
        const parsed: unknown = JSON.parse(text);
        return isRecord(parsed) ? parsed : undefined;
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

/**
 * Reads the task-local contract the parent wrote before launch. A missing or
 * malformed record is reported, never guessed: an empty scope would let a child
 * believe it may change anything.
 */
export function readWorkerAssignment(entries: readonly BranchEntryLike[]): WorkerAssignmentRead {
  const record = newestRecord(entries, WORKER_SCOPE_ENTRY);
  if (!record) {
    return { ok: false, reason: "no task-local scope was written for this worker" };
  }
  if (typeof record.objective !== "string" || record.objective.trim().length === 0) {
    return { ok: false, reason: "the task scope has no objective" };
  }
  const covers = stringList(record.covers, 200);
  const acceptanceChecks = stringList(record.acceptanceChecks, 64);
  const expectedFiles = stringList(record.expectedFiles, 512);
  const mutationScope = record.mutationScope === undefined ? [] : stringList(record.mutationScope, 64);
  if (!covers || covers.length === 0) return { ok: false, reason: "the task scope covers no requirement" };
  if (!acceptanceChecks || acceptanceChecks.length === 0) {
    return { ok: false, reason: "the task scope has no acceptance checks" };
  }
  if (!expectedFiles || !mutationScope) {
    return { ok: false, reason: "the task scope has an invalid change surface" };
  }
  const roadmap = newestRecord(entries, WORKER_ROADMAP_ENTRY);
  if (!roadmap) {
    return { ok: false, reason: "the roadmap reference is missing" };
  }
  if (
    typeof roadmap.path !== "string" ||
    !roadmap.path.trim() ||
    typeof roadmap.digest !== "string" ||
    !roadmap.digest.trim() ||
    typeof roadmap.revision !== "number" ||
    !Number.isFinite(roadmap.revision)
  ) {
    return { ok: false, reason: "the roadmap reference is invalid" };
  }
  const context = newestRecord(entries, "workflow-managed-session");
  const taskId = context?.taskId;
  if (typeof taskId !== "string" || !taskId.startsWith("task-")) {
    return { ok: false, reason: "the managed task identity is missing" };
  }
  return {
    ok: true,
    scope: {
      taskId,
      covers,
      objective: record.objective.trim().slice(0, 600),
      acceptanceChecks,
      expectedFiles,
      ...(mutationScope.length > 0 ? { mutationScope } : {}),
      roadmap: {
        path: roadmap.path.trim(),
        digest: roadmap.digest.trim(),
        revision: Math.max(0, Math.floor(roadmap.revision)),
      },
    },
    ...(assignmentModel(entries) ? { model: assignmentModel(entries) } : {}),
  };
}

/** The Builder model the parent recorded for this assignment, when valid. */
function assignmentModel(
  entries: readonly BranchEntryLike[],
): { provider: string; id: string } | undefined {
  const raw = newestRecord(entries, "workflow-task-assignment");
  if (!raw) return undefined;
  const model = raw.model;
  if (!model || typeof model !== "object" || Array.isArray(model)) return undefined;
  const record = model as Record<string, unknown>;
  if (typeof record.provider !== "string" || !record.provider.trim()) return undefined;
  if (typeof record.id !== "string" || !record.id.trim()) return undefined;
  return { provider: record.provider.trim(), id: record.id.trim() };
}
