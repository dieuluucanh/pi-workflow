/**
 * Workflow Extension — parent orchestration tools + child-event pump (step 31).
 *
 * The parent (orchestrator) never holds a tool turn for the lifetime of a task.
 * Every tool here validates a decision against the durable `RunState` and
 * returns a compact, durable receipt; the runtime applies the returned event
 * through `applyRunEvent`, which remains the only mutator.
 *
 * The event pump is the other half of the step: child events are correlated,
 * deduplicated and only *ever* wake the parent at a safe idle boundary. In
 * particular:
 *   - `agent_end` is not a boundary (only an explicit settle + drained
 *     tools/follow-ups is);
 *   - `progress`/`heartbeat` never wake the parent (that would be polling the
 *     model with extra turns);
 *   - a report that arrives while a tool batch or a queued follow-up is still
 *     live is deferred, not accepted and not lost;
 *   - wakes coalesce per task/attempt, so a burst cannot create overlapping
 *     parent turns;
 *   - an event from a previous runtime epoch / generation is refused, so a
 *     stale `pi`/`ctx` reference cannot steer the current run.
 *
 * Nothing here launches a process, calls a model or writes a file.
 */

import type { RunEvent, RunState, TaskRecord } from "./orchestrator-state.ts";
import { taskStartIdFor, workerIdFor } from "./orchestrator-worker.ts";
import {
  ORCHESTRATOR_SCHEMA_VERSION,
  acceptanceBlocker,
  canTransitionTask,
  validateAcceptanceEvidence,
  validatePlanCoverage,
  type AcceptanceEvidence,
  type PlannedTask,
  type RoadmapRequirement,
  type TaskPlan,
  type WorkerReport,
  type ExecutionBudgets,
} from "./orchestrator-types.ts";

export const TOOLS_SCHEMA_VERSION = 1 as const;

/** Receipts are serialized into a host UI; keep them small and bounded. */
export const MAX_RECEIPT_TEXT = 1_000;
export const MAX_STATUS_TASKS = 100;
export const MAX_WAKE_TEXT = 2_000;
export const MAX_REQUIREMENTS = 2_000;
export const MAX_TASKS = 500;

// ── Tool descriptors ─────────────────────────────────────────────────

export const ORCHESTRATOR_TOOL_NAMES = [
  "orchestrator_propose_tasks",
  "orchestrator_dispatch",
  "orchestrator_status",
  "orchestrator_verify",
  "orchestrator_repair",
  "orchestrator_accept",
] as const;

export type OrchestratorToolName = (typeof ORCHESTRATOR_TOOL_NAMES)[number];

export interface ToolSpec {
  name: OrchestratorToolName;
  description: string;
  /** JSON schema for the model-facing tool. */
  parameters: {
    type: "object";
    properties: Record<string, unknown>;
    required: string[];
    additionalProperties: false;
  };
  /** Dispatch/status never wait for long-running work. */
  bounded: true;
}

const EMPTY_PARAMS = {
  type: "object" as const,
  properties: {},
  required: [] as string[],
  additionalProperties: false as const,
};

export const ORCHESTRATOR_TOOLS: readonly ToolSpec[] = [
  {
    name: "orchestrator_propose_tasks",
    description:
      "Propose a validated roadmap-to-task breakdown. This never dispatches work; it returns the coverage decision for explicit execution approval.",
    parameters: {
      type: "object",
      properties: {
        plan: { type: "object", description: "TaskPlan (schemaVersion, runId, roadmapRevision, tasks[])" },
        requirements: { type: "array", description: "Roadmap requirements the plan must cover" },
      },
      required: ["plan", "requirements"],
      additionalProperties: false,
    },
    bounded: true,
  },
  {
    name: "orchestrator_dispatch",
    description:
      "Start the approved assignment for one ready task. Returns a durable launch receipt immediately; it never holds the turn until the child finishes.",
    parameters: {
      type: "object",
      properties: {
        taskId: { type: "string" },
        attemptId: { type: "string" },
        sessionRef: { type: "string" },
      },
      required: ["taskId", "attemptId"],
      additionalProperties: false,
    },
    bounded: true,
  },
  {
    name: "orchestrator_status",
    description: "Read the current run projection: phase, tasks, counters and the next runnable task.",
    parameters: EMPTY_PARAMS,
    bounded: true,
  },
  {
    name: "orchestrator_verify",
    description:
      "Move a quiescent candidate into parent verification. Fails unless the workspace is quiescent and the candidate is the current attempt.",
    parameters: {
      type: "object",
      properties: { taskId: { type: "string" } },
      required: ["taskId"],
      additionalProperties: false,
    },
    bounded: true,
  },
  {
    name: "orchestrator_repair",
    description:
      "Request a scoped repair round after failed verification. Bounded by the persisted repair/no-progress budgets.",
    parameters: {
      type: "object",
      properties: {
        taskId: { type: "string" },
        reason: { type: "string" },
        meaningfulChange: { type: "boolean" },
      },
      required: ["taskId", "reason"],
      additionalProperties: false,
    },
    bounded: true,
  },
  {
    name: "orchestrator_accept",
    description:
      "Re-read the runtime-owned acceptance for one task. Evidence is captured by the parent during verification; a model-supplied evidence object can never mint a pass.",
    parameters: {
      type: "object",
      properties: { taskId: { type: "string" } },
      required: ["taskId"],
      additionalProperties: false,
    },
    bounded: true,
  },
];

// ── Tool context and results ─────────────────────────────────────────

export interface ApprovalState {
  approved: boolean;
  approvalDigest: string;
  planDigest: string;
}

export interface ToolContext {
  state: RunState;
  now: number;
  /** Owning runtime epoch; a stale reference is refused. */
  epoch: number;
  currentEpoch: number;
  /** A parent turn is already running: tools may read but not dispatch. */
  activeTurn: boolean;
  approval: ApprovalState | null;
  /** Workspace fingerprint captured by the parent right now, if any. */
  workspaceRevision?: string;
  budgets?: ExecutionBudgets;
}

export type ToolErrorCode =
  | "invalid"
  | "stale_epoch"
  | "busy"
  | "approval"
  | "state"
  | "budget"
  | "unavailable";

export type ToolResult =
  | {
      ok: true;
      tool: OrchestratorToolName;
      receipt: ToolReceipt;
      /** The caller applies this exact event; it may be absent for reads/proposals. */
      event?: RunEvent;
    }
  | { ok: false; code: ToolErrorCode; error: string };

export interface ToolReceipt {
  kind:
    | "proposal"
    | "dispatch"
    | "status"
    | "verification"
    | "repair"
    | "acceptance";
  runId: string;
  revision: number;
  summary: string;
  taskId?: string;
  attemptId?: string;
  sessionRef?: string;
  taskStartId?: string;
  nextTaskId?: string;
  requiresApproval?: boolean;
  counts?: { total: number; accepted: number; pending: number; blocked: number; cancelled: number };
  truncated?: boolean;
}

function fail(code: ToolErrorCode, error: string): ToolResult {
  return { ok: false, code, error };
}

function text(value: unknown, max = MAX_RECEIPT_TEXT): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > max) return undefined;
  if (/[\u0000-\u001f\u007f]/.test(trimmed.replace(/[\n\r\t]/g, " "))) return undefined;
  return trimmed;
}

function identifierPattern(kind: string, value: unknown): value is string {
  return (
    typeof value === "string" &&
    new RegExp(`^${kind}-[A-Za-z0-9._-]{1,96}$`).test(value)
  );
}

function checkEpoch(ctx: ToolContext): ToolResult | undefined {
  if (ctx.epoch !== ctx.currentEpoch) {
    return fail("stale_epoch", "this tool handle belongs to a previous runtime epoch");
  }
  return undefined;
}

function boundedRequirements(raw: unknown): RoadmapRequirement[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_REQUIREMENTS) return undefined;
  const out: RoadmapRequirement[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return undefined;
    const record = entry as Record<string, unknown>;
    if (!identifierPattern("step", record.roadmapStepId)) return undefined;
    if (seen.has(record.roadmapStepId)) return undefined;
    seen.add(record.roadmapStepId);
    const label = text(record.label, 100);
    const requirementText = text(record.text, 1_000);
    if (!label || !requirementText) return undefined;
    const group = record.group === undefined ? undefined : text(record.group, 200);
    if (record.group !== undefined && group === undefined) return undefined;
    out.push({
      roadmapStepId: record.roadmapStepId,
      label,
      text: requirementText,
      ...(group === undefined ? {} : { group }),
    });
  }
  return out;
}

function boundedTask(raw: unknown): PlannedTask | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  if (!identifierPattern("task", record.taskId)) return undefined;
  const stringArray = (value: unknown, max: number, maxChars: number): string[] | undefined => {
    if (!Array.isArray(value) || value.length > max) return undefined;
    const out: string[] = [];
    for (const entry of value) {
      const parsed = text(entry, maxChars);
      if (parsed === undefined) return undefined;
      out.push(parsed);
    }
    return out;
  };
  const covers = stringArray(record.covers, 200, 100);
  const nonGoals = stringArray(record.nonGoals, 64, 500);
  const expectedFiles = stringArray(record.expectedFiles, 256, 512);
  const acceptanceChecks = stringArray(record.acceptanceChecks, 64, 500);
  const dependsOn = stringArray(record.dependsOn, 64, 100);
  const objective = text(record.objective, 2_000);
  const sizeRationale = text(record.sizeRationale, 1_000);
  if (
    !covers ||
    !nonGoals ||
    !expectedFiles ||
    !acceptanceChecks ||
    !dependsOn ||
    !objective ||
    !sizeRationale
  ) {
    return undefined;
  }
  for (const cover of covers) {
    if (!identifierPattern("step", cover)) return undefined;
  }
  for (const dependency of dependsOn) {
    if (!identifierPattern("task", dependency)) return undefined;
  }
  return {
    taskId: record.taskId,
    covers,
    objective,
    nonGoals,
    dependsOn,
    expectedFiles,
    acceptanceChecks,
    sizeRationale,
  };
}

/** Validates the model-supplied breakdown before it can become a durable plan. */
export function parseTaskPlan(
  raw: unknown,
  expected: { runId: string; roadmapRevision: number },
): { ok: true; plan: TaskPlan } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "plan must be an object" };
  }
  const record = raw as Record<string, unknown>;
  if (record.schemaVersion !== ORCHESTRATOR_SCHEMA_VERSION) {
    return { ok: false, error: `unsupported plan schema version ${String(record.schemaVersion)}` };
  }
  if (record.runId !== expected.runId) return { ok: false, error: "plan belongs to a different run" };
  if (record.roadmapRevision !== expected.roadmapRevision) {
    return { ok: false, error: "plan maps a different roadmap revision" };
  }
  if (!Array.isArray(record.tasks) || record.tasks.length === 0 || record.tasks.length > MAX_TASKS) {
    return { ok: false, error: "plan must contain a bounded, non-empty task list" };
  }
  const tasks: PlannedTask[] = [];
  for (const entry of record.tasks) {
    const task = boundedTask(entry);
    if (!task) return { ok: false, error: "a task in the plan is malformed or oversized" };
    tasks.push(task);
  }
  return {
    ok: true,
    plan: {
      schemaVersion: ORCHESTRATOR_SCHEMA_VERSION,
      runId: expected.runId,
      roadmapRevision: expected.roadmapRevision,
      tasks,
    },
  };
}

function findTask(state: RunState, taskId: unknown): TaskRecord | undefined {
  if (typeof taskId !== "string") return undefined;
  return state.tasks[taskId];
}

function budgetBlocked(task: TaskRecord, budgets: ExecutionBudgets): string | undefined {
  if (task.counters.launchFailures >= budgets.launchFailureLimit) {
    return "launch failure budget exhausted";
  }
  return undefined;
}

// ── Handlers ─────────────────────────────────────────────────────────

export function handleOrchestratorTool(
  name: OrchestratorToolName,
  raw: unknown,
  ctx: ToolContext,
): ToolResult {
  const stale = checkEpoch(ctx);
  if (stale) return stale;
  const params =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const budgets = ctx.budgets ?? {
    repairRounds: 2,
    noProgressLimit: 2,
    rolloverLimit: 2,
    launchFailureLimit: 3,
  };

  switch (name) {
    case "orchestrator_propose_tasks": {
      const requirements = boundedRequirements(params.requirements);
      if (!requirements) return fail("invalid", "requirements are malformed or oversized");
      const parsed = parseTaskPlan(params.plan, {
        runId: ctx.state.runId,
        roadmapRevision: ctx.state.roadmapRevision,
      });
      if (!parsed.ok) return fail("invalid", parsed.error);
      const coverage = validatePlanCoverage({ requirements, tasks: parsed.plan.tasks });
      if (!coverage.ok) return fail("state", coverage.error);
      if (ctx.state.phase !== "draft" && ctx.state.phase !== "awaiting_approval") {
        return fail("state", `cannot propose tasks in phase ${ctx.state.phase}`);
      }
      return {
        ok: true,
        tool: name,
        receipt: {
          kind: "proposal",
          runId: ctx.state.runId,
          revision: ctx.state.revision,
          taskId: undefined,
          summary: `Proposed ${parsed.plan.tasks.length} task(s) covering ${requirements.length} requirement(s); execution approval is still required.`,
          requiresApproval: true,
          counts: { total: parsed.plan.tasks.length, accepted: 0, pending: parsed.plan.tasks.length, blocked: 0, cancelled: 0 },
        },
        event: {
          type: "plan.apply",
          runId: ctx.state.runId,
          expectedRevision: ctx.state.revision,
          now: ctx.now,
          plan: parsed.plan,
          requirements,
        },
      };
    }

    case "orchestrator_dispatch": {
      if (ctx.activeTurn) return fail("busy", "a parent turn is already running");
      if (!ctx.approval?.approved) {
        return fail("approval", "explicit execution approval is required before the first dispatch");
      }
      const task = findTask(ctx.state, params.taskId);
      if (!task) return fail("state", "unknown task");
      if (!identifierPattern("attempt", params.attemptId)) {
        return fail("invalid", "attemptId must be a stable prefixed identifier");
      }
      if (task.state !== "pending" && task.state !== "needs_fix" && task.state !== "blocked") {
        return fail("state", `cannot dispatch a ${task.state} task`);
      }
      const notAccepted = task.dependsOn.filter(
        (id) => ctx.state.tasks[id]?.state !== "accepted",
      );
      if (notAccepted.length > 0) {
        return fail("state", `dependencies are not accepted: ${notAccepted.join(", ")}`);
      }
      if (ctx.state.mutation) {
        return fail("state", "another attempt holds the workspace mutation grant");
      }
      const blocked = budgetBlocked(task, budgets);
      if (blocked) return fail("budget", blocked);
      const sessionRef =
        typeof params.sessionRef === "string" ? params.sessionRef.trim() : "";
      if (!sessionRef || sessionRef.length > 400) {
        return fail(
          "invalid",
          "a concrete sessionRef from the host is required before dispatch",
        );
      }
      const startId = taskStartIdFor(
        workerIdFor({
          runId: ctx.state.runId,
          taskId: task.taskId,
          attemptId: params.attemptId,
        }),
        params.attemptId,
      );
      return {
        ok: true,
        tool: name,
        receipt: {
          kind: "dispatch",
          runId: ctx.state.runId,
          revision: ctx.state.revision,
          taskId: task.taskId,
          attemptId: params.attemptId,
          sessionRef,
          taskStartId: startId,
          summary: `Assignment ${task.taskId}/${params.attemptId} is ready to launch; the receipt is durable, the child runs in its own session.`,
        },
        event: {
          type: "task.assign",
          runId: ctx.state.runId,
          expectedRevision: ctx.state.revision,
          now: ctx.now,
          taskId: task.taskId,
          attemptId: params.attemptId,
          sessionId: sessionRef,
          generation: task.attempts.length + 1,
        },
      };
    }

    case "orchestrator_status": {
      const tasks = ctx.state.order.slice(0, MAX_STATUS_TASKS);
      const counts = { total: ctx.state.order.length, accepted: 0, pending: 0, blocked: 0, cancelled: 0 };
      for (const id of ctx.state.order) {
        const state = ctx.state.tasks[id]?.state;
        if (state === "accepted") counts.accepted += 1;
        else if (state === "blocked") counts.blocked += 1;
        else if (state === "cancelled" || state === "superseded") counts.cancelled += 1;
        else counts.pending += 1;
      }
      const next = ctx.state.order.find((id) => {
        const task = ctx.state.tasks[id];
        return (
          task?.state === "pending" &&
          task.dependsOn.every((dependency) => ctx.state.tasks[dependency]?.state === "accepted")
        );
      });
      return {
        ok: true,
        tool: name,
        receipt: {
          kind: "status",
          runId: ctx.state.runId,
          revision: ctx.state.revision,
          summary:
            `${ctx.state.phase} · ${counts.accepted}/${counts.total} accepted` +
            (ctx.state.blockedReason ? ` · blocked: ${ctx.state.blockedReason}` : "") +
            (next ? ` · next: ${next}` : ""),
          ...(next ? { nextTaskId: next } : {}),
          counts,
          truncated: tasks.length < ctx.state.order.length,
        },
      };
    }

    case "orchestrator_verify": {
      const task = findTask(ctx.state, params.taskId);
      if (!task) return fail("state", "unknown task");
      if (task.state !== "candidate") return fail("state", `cannot verify a ${task.state} task`);
      if (ctx.state.mutation) {
        return fail("state", "verification requires a quiescent workspace");
      }
      const attempt = task.attempts.find((entry) => entry.attemptId === task.currentAttemptId);
      if (!attempt?.candidateId) {
        return fail("state", "the current attempt has no candidate");
      }
      if (!canTransitionTask(task.state, "verifying")) {
        return fail("state", `cannot verify a ${task.state} task`);
      }
      return {
        ok: true,
        tool: name,
        receipt: {
          kind: "verification",
          runId: ctx.state.runId,
          revision: ctx.state.revision,
          taskId: task.taskId,
          attemptId: attempt.attemptId,
          summary: `Verifying candidate ${attempt.candidateId} in a read-only workspace.`,
        },
        event: {
          type: "task.verify",
          runId: ctx.state.runId,
          expectedRevision: ctx.state.revision,
          now: ctx.now,
          taskId: task.taskId,
        },
      };
    }

    case "orchestrator_repair": {
      const task = findTask(ctx.state, params.taskId);
      if (!task) return fail("state", "unknown task");
      const reason = text(params.reason, 1_000);
      if (!reason) return fail("invalid", "a concrete repair reason is required");
      if (!canTransitionTask(task.state, "needs_fix")) {
        return fail("state", `cannot request a repair for a ${task.state} task`);
      }
      if (task.counters.repairRounds >= budgets.repairRounds) {
        return fail(
          "budget",
          "repair budget is exhausted; an explicit unblock/retry/cancel decision is required",
        );
      }
      if (params.meaningfulChange === false && task.counters.noProgress + 1 >= budgets.noProgressLimit) {
        return fail(
          "budget",
          "no-progress budget is exhausted; the scheduler will not retry unchanged work",
        );
      }
      return {
        ok: true,
        tool: name,
        receipt: {
          kind: "repair",
          runId: ctx.state.runId,
          revision: ctx.state.revision,
          taskId: task.taskId,
          attemptId: task.currentAttemptId,
          summary: `Scoped repair round ${task.counters.repairRounds + 1}/${budgets.repairRounds}: ${reason}`,
        },
        event: {
          type: "task.needsFix",
          runId: ctx.state.runId,
          expectedRevision: ctx.state.revision,
          now: ctx.now,
          taskId: task.taskId,
          meaningfulChange: params.meaningfulChange === true,
          reason,
        },
      };
    }

    case "orchestrator_accept": {
      // Acceptance evidence is runtime-owned: a model-supplied object is not
      // provenance. The live adapter re-reads the evidence it captured during
      // `orchestrator_verify`; the pure decision layer refuses to manufacture it.
      const taskId = typeof params.taskId === "string" ? params.taskId : "";
      if (!taskId) return fail("invalid", "taskId is required");
      const task = ctx.state.tasks[taskId];
      if (!task) return fail("state", "unknown task");
      if (task.state === "accepted" && task.acceptance) {
        return {
          ok: true,
          tool: name,
          receipt: {
            kind: "acceptance",
            runId: ctx.state.runId,
            revision: ctx.state.revision,
            taskId: task.taskId,
            attemptId: task.acceptance.attemptId,
            summary: `${task.taskId} is already accepted with evidence ${task.acceptance.evidenceId}.`,
          },
        };
      }
      return fail(
        "unavailable",
        "Acceptance is applied by the parent during verification. Run orchestrator_verify; a model-supplied evidence object cannot mint a pass.",
      );
    }

    default:
      return fail("unavailable", `unknown orchestration tool ${String(name)}`);
  }
}

// ── Tool registration ────────────────────────────────────────────────

export interface ToolRegistrar {
  registerTool(
    spec: ToolSpec,
    handler: (toolCallId: string, params: unknown) => Promise<ToolResult>,
  ): void;
}

/**
 * Registers the structured tools. The context is read per call, so a replaced
 * `pi`/`ctx` (new epoch) is observed instead of a captured stale reference.
 */
export function registerOrchestratorTools(
  registrar: ToolRegistrar,
  getContext: () => ToolContext | undefined,
): { registered: OrchestratorToolName[]; unavailable: string | null } {
  for (const spec of ORCHESTRATOR_TOOLS) {
    registrar.registerTool(spec, async (_toolCallId, params) => {
      const context = getContext();
      if (!context) return fail("unavailable", "the orchestration runtime is not bound");
      return handleOrchestratorTool(spec.name, params, context);
    });
  }
  return { registered: [...ORCHESTRATOR_TOOL_NAMES], unavailable: null };
}

// ── Child event pump ─────────────────────────────────────────────────

/** Only a real settle after draining counts; `agent_end` is not one. */
export const PUMP_EVENT_KINDS = [
  "ready",
  "start-ack",
  "progress",
  "waiting-user",
  "candidate",
  "quiescent",
  "repair",
  "pause",
  "heartbeat",
  "close",
  "agent-end",
] as const;

export type PumpEventKind = (typeof PUMP_EVENT_KINDS)[number];

export interface PumpEvent {
  messageId: string;
  /** Monotonic per sender; duplicates/reorders are refused. */
  seq: number;
  kind: PumpEventKind;
  runId: string;
  taskId: string;
  attemptId: string;
  sessionId: string;
  generation: number;
  leaseGeneration: number;
  /** Runtime epoch that produced the event. */
  epoch: number;
  at: number;
  settled?: boolean;
  pendingTools?: number;
  pendingFollowUps?: number;
  report?: WorkerReport;
  questionId?: string;
  reason?: string;
}

export type PumpCode =
  | "duplicate"
  | "stale"
  | "reordered"
  | "unsafe_boundary"
  | "stale_epoch"
  | "invalid"
  | "closed";

export type PumpResult =
  | { ok: true; queued: boolean; wake?: ParentWake }
  | { ok: false; code: PumpCode; error: string; retry?: boolean };

export type ParentWakeKind =
  | "ready"
  | "candidate"
  | "quiescent"
  | "waiting-user"
  | "interrupted"
  | "paused";

export interface ParentWake {
  id: string;
  kind: ParentWakeKind;
  runId: string;
  taskId: string;
  attemptId: string;
  sessionId: string;
  text: string;
  /** Stable per task/attempt/kind; a burst coalesces instead of stacking. */
  dedupeKey: string;
  /** Wakes never force a continuation; the parent chooses its next turn. */
  requiresTurn: false;
}

export interface PumpIdentity {
  runId: string;
  taskId: string;
  attemptId: string;
  sessionId: string;
  generation: number;
  leaseGeneration: number;
  epoch: number;
}

export interface EventPump {
  ingest(event: PumpEvent): PumpResult;
  /** Call when a parent turn starts, so wakes cannot overlap. */
  beginTurn(): void;
  /** Call when the parent turn has finished; queued wakes may now drain. */
  endTurn(): void;
  /** Returns at most one coalesced wake, and marks a turn as started. */
  drain(): ParentWake | undefined;
  pending(): number;
  close(): void;
}

const WAKE_PRIORITY: Record<ParentWakeKind, number> = {
  candidate: 5,
  "waiting-user": 4,
  interrupted: 3,
  paused: 2,
  ready: 1,
  quiescent: 0,
};

function wakeKindFor(event: PumpEvent): ParentWakeKind | undefined {
  switch (event.kind) {
    case "candidate":
      return "candidate";
    case "waiting-user":
      return "waiting-user";
    case "close":
      return "interrupted";
    case "pause":
      return "paused";
    case "ready":
    case "start-ack":
      return "ready";
    case "quiescent":
      return "quiescent";
    case "progress":
    case "heartbeat":
    case "repair":
      return undefined;
    default:
      return undefined;
  }
}

function nextActionFor(kind: ParentWakeKind): string {
  switch (kind) {
    case "candidate":
      return "inspect the quiescent candidate, run the required checks, then accept or repair";
    case "waiting-user":
      return "the child is waiting for the user in its own window/tab; no parent acceptance is possible yet";
    case "interrupted":
      return "the child window/tab closed; inspect preserved edits and decide repair, retry or cancel";
    case "paused":
      return "the child is paused with edits preserved; resume explicitly or leave it paused";
    case "ready":
      return "the child is ready; confirm the lease/preflight before the authorized start";
    case "quiescent":
      return "the child settled without a candidate; inspect before retrying, do not treat it as success";
    default:
      return "inspect the child status before the next decision";
  }
}

function safeBoundary(event: PumpEvent): string | undefined {
  if (event.kind === "agent-end") {
    return "agent_end is not a settlement boundary; wait for agent_settled after tools and follow-ups drain";
  }
  if (event.kind !== "candidate" && event.kind !== "quiescent") return undefined;
  if (event.settled !== true) return "the child has not actually settled yet";
  if ((event.pendingTools ?? 0) > 0) return "a tool batch is still in flight";
  if ((event.pendingFollowUps ?? 0) > 0) return "a queued follow-up/steer has not drained";
  return undefined;
}

function wakeText(event: PumpEvent, kind: ParentWakeKind): string {
  const head = `${kind} · ${event.taskId}/${event.attemptId}/${event.sessionId}`;
  const detail =
    kind === "waiting-user" && event.questionId ? ` · question ${event.questionId}` : "";
  const reason = event.reason ? ` · ${event.reason.slice(0, 300)}` : "";
  return `${head}${detail}${reason} · ${nextActionFor(kind)}`.slice(0, MAX_WAKE_TEXT);
}

/**
 * Correlates child events with the current attempt and delivers at most one
 * bounded wake per safe idle boundary. Heartbeats/progress are status updates
 * only; they never schedule a model turn.
 */
export function createEventPump(options: { identity: PumpIdentity }): EventPump {
  const identity = options.identity;
  const seen = new Set<string>();
  const lastSeq = new Map<string, number>();
  const pending = new Map<string, ParentWake>();
  let activeTurn = false;
  let closed = false;
  let wakeCounter = 0;

  return {
    ingest(event) {
      if (closed) return { ok: false, code: "closed", error: "the event pump is closed" };
      if (!event || typeof event !== "object") {
        return { ok: false, code: "invalid", error: "event must be an object" };
      }
      if ((PUMP_EVENT_KINDS as readonly string[]).includes(event.kind) === false) {
        return { ok: false, code: "invalid", error: "unsupported event kind" };
      }
      if (event.epoch !== identity.epoch) {
        return { ok: false, code: "stale_epoch", error: "event came from a previous runtime epoch" };
      }
      if (
        event.runId !== identity.runId ||
        event.taskId !== identity.taskId ||
        event.attemptId !== identity.attemptId ||
        event.sessionId !== identity.sessionId ||
        event.generation !== identity.generation
      ) {
        return { ok: false, code: "stale", error: "event does not belong to the current attempt" };
      }
      if (seen.has(event.messageId)) {
        return { ok: false, code: "duplicate", error: "this event was already processed" };
      }
      const previous = lastSeq.get(event.sessionId) ?? -1;
      if (!Number.isInteger(event.seq) || event.seq <= previous) {
        return { ok: false, code: "reordered", error: "event sequence is stale or reordered" };
      }

      const unsafe = safeBoundary(event);
      if (unsafe) {
        // A report inside a live batch is held by the child's fence; it must be
        // resent after the drain. Do not consume its id or sequence.
        return { ok: false, code: "unsafe_boundary", error: unsafe, retry: true };
      }

      seen.add(event.messageId);
      lastSeq.set(event.sessionId, event.seq);

      const kind = wakeKindFor(event);
      if (!kind) return { ok: true, queued: false };

      const dedupeKey = `${event.runId}:${event.taskId}:${event.attemptId}`;
      const existing = pending.get(dedupeKey);
      if (existing && WAKE_PRIORITY[existing.kind] > WAKE_PRIORITY[kind]) {
        return { ok: true, queued: true };
      }
      wakeCounter += 1;
      const wake: ParentWake = {
        id: `wake-${String(wakeCounter)}-${event.messageId}`.slice(0, 200),
        kind,
        runId: event.runId,
        taskId: event.taskId,
        attemptId: event.attemptId,
        sessionId: event.sessionId,
        text: wakeText(event, kind),
        dedupeKey,
        requiresTurn: false,
      };
      pending.set(dedupeKey, wake);
      // Drain synchronously only when the parent is idle; otherwise it stays
      // queued for the next endTurn, which is what prevents overlapping turns.
      if (!activeTurn) {
        pending.delete(dedupeKey);
        activeTurn = true;
        return { ok: true, queued: false, wake };
      }
      return { ok: true, queued: true };
    },

    beginTurn() {
      activeTurn = true;
    },

    endTurn() {
      activeTurn = false;
    },

    drain() {
      if (closed || activeTurn || pending.size === 0) return undefined;
      const wakes = [...pending.values()].sort(
        (left, right) => WAKE_PRIORITY[right.kind] - WAKE_PRIORITY[left.kind],
      );
      const wake = wakes[0];
      if (!wake) return undefined;
      pending.delete(wake.dedupeKey);
      activeTurn = true;
      return wake;
    },

    pending() {
      return pending.size;
    },

    close() {
      closed = true;
      pending.clear();
    },
  };
}
