/**
 * Workflow Extension — persistent normal worker sessions (step 24).
 *
 * This module prepares and drives ONE ordinary Build worker session. It is
 * deliberately transport-free: the SDK effects arrive through `WorkerSdkPort`
 * (`SessionManager.create`, custom entries, and the correlated wake), so the
 * ordering can be tested without spawning a real child.
 *
 * Guarantees:
 *   - stable `workerId` and a durable session FILE created through the SDK; no
 *     JSONL is handwritten here;
 *   - managed metadata is written BEFORE launch, idempotently (a relaunch never
 *     duplicates the assignment);
 *   - the child is never woken before it acknowledges readiness and a matching
 *     workspace lease is granted;
 *   - the durable kickoff content and the one-shot correlated wake are separate
 *     values; the wake carries only the task-start id and `triggerTurn: true`;
 *   - a start intent is returned for the caller to journal BEFORE delivery, so
 *     a restart with intent-but-no-ack reconciles instead of replaying.
 *
 * The actual process/tab launch adapters are steps 25 (terminal) and 26
 * (Desktop); both use this plan and lifecycle.
 */

export const WORKER_SCHEMA_VERSION = 1 as const;
export const MAX_SESSION_NAME_CHARS = 120;
export const MAX_METADATA_CHARS = 8_000;
export const MAX_RESOURCES = 64;

export interface WorkerSdkPort {
  createSession(input: {
    cwd: string;
    agentDir?: string;
    name: string;
  }): Promise<{ sessionId: string; sessionFile: string }>;
  exists(sessionFile: string): Promise<boolean>;
  appendManagedEntry(
    sessionFile: string,
    customType: string,
    key: string,
    data: unknown,
  ): Promise<void>;
  /** Idempotency probe: true when this keyed entry is already present. */
  hasManagedEntry(sessionFile: string, customType: string, key: string): Promise<boolean>;
  /** The supported correlated wake (`pi.sendMessage(..., {triggerTurn:true})`). */
  sendWake(
    sessionFile: string,
    wake: { customType: string; content: string; triggerTurn: true },
  ): Promise<void>;
}

export interface WorkerResources {
  extensions?: readonly string[];
  skills?: readonly string[];
  prompts?: readonly string[];
}

export interface WorkerLaunchInput {
  runId: string;
  taskId: string;
  attemptId: string;
  parentSessionRef: string;
  /** The assignment packet reference (content-addressed artifact id). */
  packetRef: string;
  kickoff: { customType: string; content: string };
  roadmap: { path: string; digest: string; revision: number };
  cwd: string;
  agentDir?: string;
  profile?: string;
  trust: "trust" | "session" | "never";
  model: { provider: string; id: string; thinking?: string };
  resources?: WorkerResources;
  /**
   * The task-local work contract, written into the child's own session so the
   * child can build its LOCAL todo list without reading the parent roadmap.
   * Bounded and optional: an older caller keeps working unchanged.
   */
  scope?: {
    covers: readonly string[];
    objective: string;
    acceptanceChecks: readonly string[];
    expectedFiles: readonly string[];
    mutationScope?: readonly string[];
  };
  now: number;
}

export interface WorkerLaunchSpec {
  schemaVersion: typeof WORKER_SCHEMA_VERSION;
  workerId: string;
  sessionName: string;
  sessionFile: string;
  sessionId: string;
  runId: string;
  taskId: string;
  attemptId: string;
  parentSessionRef: string;
  packetRef: string;
  roadmap: { path: string; digest: string; revision: number };
  cwd: string;
  agentDir?: string;
  profile?: string;
  trust: "trust" | "session" | "never";
  model: { provider: string; id: string; thinking?: string };
  resources: WorkerResources;
  /** Durable assignment content; never the wake. */
  kickoff: { customType: string; content: string };
  /** One-shot correlated wake; content is only the task-start id. */
  wake: { customType: string; content: string; triggerTurn: true };
  taskStartId: string;
  assignmentId: string;
  createdAt: number;
}

export type WorkerPhase =
  | "launched"
  | "ready"
  | "starting"
  | "running"
  | "needs_reconciliation"
  | "closed";

export interface WorkerState {
  schemaVersion: typeof WORKER_SCHEMA_VERSION;
  workerId: string;
  sessionFile: string;
  phase: WorkerPhase;
  launchedAt: number;
  readyAt?: number;
  startIntentAt?: number;
  startedAt?: number;
  closedAt?: number;
  wakeSentAt?: number;
  leaseGeneration?: number;
  reason?: string;
}

export type WorkerResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: "invalid" | "not_ready" | "lease" | "duplicate" | "mismatch" | "io"; error: string };


export function workerIdFor(input: { runId: string; taskId: string; attemptId: string }): string {
  const safe = `${input.runId}-${input.taskId}-${input.attemptId}`.replace(
    /[^A-Za-z0-9._-]/g,
    "-",
  );
  return `worker-${safe}`.slice(0, 120);
}

export function taskStartIdFor(workerId: string, attemptId: string): string {
  return `start-${workerId}-${attemptId}`.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 160);
}

function bounded(value: string, max: number): boolean {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

function stringList(value: readonly string[] | undefined): string[] {
  if (!value) return [];
  return [...new Set(value.filter((entry) => typeof entry === "string" && entry.length > 0))].slice(
    0,
    MAX_RESOURCES,
  );
}

/**
 * Creates the durable worker file and writes managed metadata before launch.
 * `existingSessionFile` lets a relaunch reopen the exact worker instead of
 * minting a new one; metadata entries are still idempotent.
 */
export async function prepareWorker(
  input: WorkerLaunchInput,
  sdk: WorkerSdkPort,
  options: { existingSessionFile?: string | null } = {},
): Promise<WorkerResult<{ spec: WorkerLaunchSpec; state: WorkerState }>> {
  for (const [field, value] of [
    ["runId", input.runId],
    ["taskId", input.taskId],
    ["attemptId", input.attemptId],
    ["parentSessionRef", input.parentSessionRef],
    ["packetRef", input.packetRef],
    ["cwd", input.cwd],
    ["kickoff.content", input.kickoff.content],
  ] as const) {
    if (!bounded(value, field === "kickoff.content" ? MAX_METADATA_CHARS : 400)) {
      return { ok: false, code: "invalid", error: `${field} is invalid` };
    }
  }
  if (!input.kickoff.customType || input.kickoff.customType.length > 80) {
    return { ok: false, code: "invalid", error: "kickoff customType is invalid" };
  }
  if (!input.model.provider || !input.model.id) {
    return { ok: false, code: "invalid", error: "Builder model is required" };
  }
  const workerId = workerIdFor(input);
  const sessionName = `Workflow ${input.taskId} (${input.attemptId})`.slice(0, MAX_SESSION_NAME_CHARS);
  const taskStartId = taskStartIdFor(workerId, input.attemptId);
  const assignmentId = `assignment-${workerId}`;

  let sessionId: string;
  let sessionFile: string;
  if (options.existingSessionFile) {
    if (!(await sdk.exists(options.existingSessionFile))) {
      return { ok: false, code: "io", error: "the existing worker session file is missing" };
    }
    sessionFile = options.existingSessionFile;
    sessionId = `reopened-${workerId}`;
  } else {
    try {
      const created = await sdk.createSession({
        cwd: input.cwd,
        ...(input.agentDir ? { agentDir: input.agentDir } : {}),
        name: sessionName,
      });
      sessionId = created.sessionId;
      sessionFile = created.sessionFile;
    } catch (error) {
      return {
        ok: false,
        code: "io",
        error: error instanceof Error ? error.message : "the worker session could not be created",
      };
    }
    if (!sessionFile || !(await sdk.exists(sessionFile))) {
      return { ok: false, code: "io", error: "the worker session file was not created durably" };
    }
  }

  const managed = {
    version: WORKER_SCHEMA_VERSION,
    runId: input.runId,
    taskId: input.taskId,
    attemptId: input.attemptId,
    parentSessionRef: input.parentSessionRef,
    relation: "child",
    mode: "build",
    mayOrchestrate: false,
  };
  const entries: Array<{ type: string; key: string; data: unknown }> = [
    { type: "workflow-managed-session", key: `${assignmentId}:managed`, data: managed },
    {
      type: "workflow-task-assignment",
      key: assignmentId,
      data: {
        assignmentId,
        taskStartId,
        packetRef: input.packetRef,
        kickoff: input.kickoff.content,
        model: input.model,
        trust: input.trust,
        profile: input.profile ?? null,
      },
    },
    {
      type: "workflow-roadmap-reference",
      key: `${assignmentId}:roadmap`,
      data: input.roadmap,
    },
  ];
  if (input.scope) {
    entries.push({
      type: "workflow-task-scope",
      key: `${assignmentId}:scope`,
      data: {
        covers: stringList(input.scope.covers),
        objective: input.scope.objective.slice(0, 600),
        acceptanceChecks: stringList(input.scope.acceptanceChecks).slice(0, 64),
        expectedFiles: stringList(input.scope.expectedFiles).slice(0, 512),
        mutationScope: stringList(input.scope.mutationScope).slice(0, 64),
      },
    });
  }
  for (const entry of entries) {
    if (JSON.stringify(entry.data).length > MAX_METADATA_CHARS) {
      return { ok: false, code: "invalid", error: `${entry.type} metadata is too large` };
    }
    if (await sdk.hasManagedEntry(sessionFile, entry.type, entry.key)) continue;
    try {
      await sdk.appendManagedEntry(sessionFile, entry.type, entry.key, entry.data);
    } catch (error) {
      return {
        ok: false,
        code: "io",
        error: error instanceof Error ? error.message : "managed metadata could not be written",
      };
    }
  }

  const spec: WorkerLaunchSpec = {
    schemaVersion: WORKER_SCHEMA_VERSION,
    workerId,
    sessionName,
    sessionFile,
    sessionId,
    runId: input.runId,
    taskId: input.taskId,
    attemptId: input.attemptId,
    parentSessionRef: input.parentSessionRef,
    packetRef: input.packetRef,
    roadmap: { ...input.roadmap },
    cwd: input.cwd,
    ...(input.agentDir ? { agentDir: input.agentDir } : {}),
    ...(input.profile ? { profile: input.profile } : {}),
    trust: input.trust,
    model: { ...input.model },
    resources: {
      extensions: stringList(input.resources?.extensions),
      skills: stringList(input.resources?.skills),
      prompts: stringList(input.resources?.prompts),
    },
    kickoff: { ...input.kickoff },
    wake: { customType: "workflow-task-start", content: taskStartId, triggerTurn: true },
    taskStartId,
    assignmentId,
    createdAt: input.now,
  };
  return {
    ok: true,
    value: {
      spec,
      state: {
        schemaVersion: WORKER_SCHEMA_VERSION,
        workerId,
        sessionFile,
        phase: "launched",
        launchedAt: input.now,
      },
    },
  };
}

/** The child explicitly reports that it owns the file and its runtime is bound. */
export function markWorkerReady(
  state: WorkerState,
  input: { sessionId: string; generation: number; now: number },
): WorkerResult<WorkerState> {
  if (state.phase !== "launched") {
    return { ok: false, code: "invalid", error: `cannot mark a ${state.phase} worker ready` };
  }
  if (!input.sessionId) return { ok: false, code: "invalid", error: "session id is required" };
  return {
    ok: true,
    value: {
      ...state,
      phase: "ready",
      readyAt: input.now,
      leaseGeneration: input.generation,
    },
  };
}

/**
 * Authorizes the start AFTER readiness and a matching lease. Returns the
 * durable intent the caller must journal before calling `deliverWake`.
 */
export function beginWorkerStart(
  spec: WorkerLaunchSpec,
  state: WorkerState,
  input: { leaseGeneration: number; currentLeaseGeneration: number; now: number },
): WorkerResult<{ state: WorkerState; intent: { taskStartId: string; wakeId: string; at: number } }> {
  if (state.phase !== "ready") {
    return { ok: false, code: "not_ready", error: `worker is ${state.phase}, not ready` };
  }
  if (input.leaseGeneration !== input.currentLeaseGeneration) {
    return { ok: false, code: "lease", error: "the workspace lease does not match this worker" };
  }
  return {
    ok: true,
    value: {
      state: {
        ...state,
        phase: "starting",
        startIntentAt: input.now,
        leaseGeneration: input.leaseGeneration,
      },
      intent: { taskStartId: spec.taskStartId, wakeId: spec.wake.content, at: input.now },
    },
  };
}

/**
 * Sends the one correlated wake. The caller must have journaled the intent
 * first; a second delivery is refused rather than replaying the assignment.
 */
export async function deliverWake(
  spec: WorkerLaunchSpec,
  state: WorkerState,
  sdk: WorkerSdkPort,
  input: { intentPersisted: boolean; now: number },
): Promise<WorkerResult<WorkerState>> {
  if (state.phase !== "starting") {
    return { ok: false, code: "invalid", error: `cannot wake a ${state.phase} worker` };
  }
  if (!input.intentPersisted) {
    return { ok: false, code: "invalid", error: "persist the start intent before delivery" };
  }
  if (state.wakeSentAt !== undefined) {
    return { ok: false, code: "duplicate", error: "the wake was already sent" };
  }
  try {
    await sdk.sendWake(spec.sessionFile, spec.wake);
  } catch (error) {
    return {
      ok: false,
      code: "io",
      error: error instanceof Error ? error.message : "the wake could not be delivered",
    };
  }
  return {
    ok: true,
    value: { ...state, wakeSentAt: input.now, startedAt: input.now },
  };
}

/** The child acknowledges the actual turn start (not just the wake send). */
/**
 * The child acknowledges the actual turn start (not just the wake send).
 *
 * The acknowledgement must name the EXACT start id this worker's wake carried:
 * a stale or foreign ack must not promote a different attempt to `running`.
 */
export function recordStartAck(
  spec: Pick<WorkerLaunchSpec, "taskStartId">,
  state: WorkerState,
  input: { taskStartId: string; now: number },
): WorkerResult<WorkerState> {
  if (state.phase !== "starting") {
    return { ok: false, code: "invalid", error: `cannot acknowledge a ${state.phase} worker` };
  }
  if (state.wakeSentAt === undefined) {
    return { ok: false, code: "invalid", error: "no wake was sent for this start" };
  }
  if (input.taskStartId !== spec.taskStartId) {
    return {
      ok: false,
      code: "mismatch",
      error: "the acknowledgement does not name this worker's task-start id",
    };
  }
  return {
    ok: true,
    value: { ...state, phase: "running", startedAt: state.startedAt ?? input.now },
  };
}

export type WorkerReconcileAction =
  | { action: "running" }
  | { action: "await_start"; reason: string }
  | { action: "needs_reconciliation"; reason: string }
  | { action: "reopen"; reason: string }
  | { action: "recreate"; reason: string }
  | { action: "terminal"; reason: string };

/**
 * Restart reconciliation. It never replays a start: intent-without-ack needs a
 * human/coordinator decision, and a missing file is recreated without waking.
 */
export async function reconcileWorker(input: {
  state: WorkerState;
  exists: (sessionFile: string) => Promise<boolean>;
}): Promise<WorkerReconcileAction> {
  const state = input.state;
  if (state.phase === "running") return { action: "running" };
  if (state.phase === "closed") return { action: "terminal", reason: "worker was closed" };
  const fileExists = await input.exists(state.sessionFile);
  if (!fileExists) {
    return {
      action: "recreate",
      reason: "the worker session file is gone; recreate it without replaying the assignment",
    };
  }
  if (state.phase === "starting") {
    return {
      action: "needs_reconciliation",
      reason:
        state.wakeSentAt !== undefined
          ? "a wake was sent but no turn-start acknowledgement exists"
          : "a start intent was persisted but no wake was delivered",
    };
  }
  if (state.phase === "ready") {
    return {
      action: "await_start",
      reason: "worker is ready; start needs a fresh lease grant and explicit authorization",
    };
  }
  if (state.phase === "needs_reconciliation") {
    return { action: "needs_reconciliation", reason: state.reason ?? "unresolved start" };
  }
  return { action: "reopen", reason: "reopen the durable worker and wait for readiness" };
}

export function markWorkerClosed(state: WorkerState, now: number): WorkerState {
  return { ...state, phase: "closed", closedAt: now };
}
