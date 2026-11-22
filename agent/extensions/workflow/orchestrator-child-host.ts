/**
 * Workflow Extension — child host composition (integration steps 9/11/16).
 *
 * This module is the only place where "dispatch" becomes real:
 *
 *   allocation → prepare (SDK session + metadata + private grant)
 *              → arm the control window
 *              → launch a VISIBLE child (Terminal / Desktop)
 *              → wait for the child's authenticated start acknowledgement
 *
 * It deliberately owns no policy. The tool runtime already checked approval,
 * dependencies and the lease; this layer performs the effects and reports the
 * honest outcome, including `uncertain` when a start may have been delivered.
 *
 * Two host families exist and must not be mixed:
 *   - Terminal: Workflow (through the SDK adapter) creates the session file and
 *     launches `pi --session <file>`;
 *   - Desktop: the host is the SOLE creator of its normal session tab and
 *     returns the real identity; Workflow only supplies bootstrap entries.
 */

import { createHash } from "node:crypto";

import type { OrchestratorRuntime } from "./orchestrator-runtime.ts";
import type { DispatchPort, PreparedChild } from "./orchestrator-tool-runtime.ts";
import type { TaskRecord } from "./orchestrator-state.ts";
import {
  prepareWorker,
  taskStartIdFor,
  workerIdFor,
  type WorkerLaunchInput,
  type WorkerLaunchSpec,
  type WorkerSdkPort,
} from "./orchestrator-worker.ts";
import type {
  SessionHostPort,
  SessionHostResult,
  RelatedSessionSpec,
  SessionBootstrapEntry,
} from "./session-host.ts";
import type { RunControl, WorkerGrant } from "./orchestrator-run-control.ts";
import type { TerminalHost } from "./orchestrator-launcher-node.ts";
import { launchWorkerInTerminal } from "./orchestrator-launcher-node.ts";
import { SESSION_HOST_LIMITS } from "./session-host.ts";

export const CHILD_HOST_SCHEMA_VERSION = 1 as const;
export const CONTROL_GRANT_ENTRY = "workflow-control-grant";
const MAX_KICKOFF_CHARS = 6_000;

export interface HostCapability {
  available: boolean;
  label: string;
  separateWindow: boolean;
  focus: boolean;
  reason?: string;
}

/** A visible child creator/adapter. */
export interface ChildHost {
  capabilities(): Promise<HostCapability>;
  /**
   * Create the durable child and its metadata. It must NOT start a turn: the
   * authorized start is delivered only after the parent arms the window.
   */
  prepare(input: {
    launch: WorkerLaunchInput;
    grantRef: string;
    controlSessionId: string;
  }): Promise<{ ok: true; spec: WorkerLaunchSpec; sessionRef: string; sessionFile?: string } | { ok: false; error: string }>;
  /** Show the child. A launcher success is not readiness and not a start. */
  launch(spec: WorkerLaunchSpec): Promise<{ ok: true; handle?: string } | { ok: false; error: string }>;
}

function sha(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function kickoffText(input: {
  task: TaskRecord;
  taskStartId: string;
  workerId: string;
}): string {
  const lines = [
    `# Workflow assignment ${input.workerId}`,
    `Start id: ${input.taskStartId}`,
    "",
    `Objective: ${input.task.objective}`,
    "",
    "Covers:",
    ...(input.task.covers.length > 0 ? input.task.covers.map((id) => `- ${id}`) : ["- (none)"]),
    "",
    "Acceptance checks:",
    ...(input.task.acceptanceChecks.length > 0
      ? input.task.acceptanceChecks.map((check) => `- ${check}`)
      : ["- (none)"]),
    "",
    "Expected files:",
    ...(input.task.expectedFiles.length > 0
      ? input.task.expectedFiles.map((file) => `- ${file}`)
      : ["- (none)"]),
    "",
    "Rules: call workflow_worker_ready, then work only inside this task. Report with",
    "orchestrator_report; a report is a claim, not acceptance. Do not commit or push.",
  ];
  return lines.join("\n").slice(0, MAX_KICKOFF_CHARS);
}

function packetRefFor(task: TaskRecord): string {
  return sha(
    JSON.stringify({
      taskId: task.taskId,
      covers: task.covers,
      objective: task.objective,
      checks: task.acceptanceChecks,
      files: task.expectedFiles,
    }),
  ).slice(0, 40);
}

/** Terminal-host child creator: the SDK owns the session file. */
export function createTerminalChildHost(options: {
  sdk: () => Promise<WorkerSdkPort>;
  terminal: TerminalHost;
  label?: string;
}): ChildHost {
  return {
    async capabilities() {
      const caps = await options.terminal.port.capabilities();
      return {
        available: caps.available,
        label: options.label ?? caps.label,
        separateWindow: caps.separateWindow,
        focus: caps.focus,
        ...(caps.reason ? { reason: caps.reason } : {}),
      };
    },

    async prepare({ launch, grantRef }) {
      let sdk: WorkerSdkPort;
      try {
        sdk = await options.sdk();
      } catch (error: unknown) {
        return {
          ok: false,
          error: `the SDK worker storage is unavailable: ${
            error instanceof Error ? error.message : String(error)
          }`,
        };
      }
      const prepared = await prepareWorker(launch, sdk);
      if (!prepared.ok) return { ok: false, error: prepared.error };
      const spec = prepared.value.spec;
      try {
        await sdk.appendManagedEntry(
          spec.sessionFile,
          CONTROL_GRANT_ENTRY,
          `${spec.assignmentId}:control`,
          {
            grantRef,
            controlSessionId: spec.workerId,
            runId: spec.runId,
            taskId: spec.taskId,
            attemptId: spec.attemptId,
            taskStartId: spec.taskStartId,
          },
        );
      } catch (error: unknown) {
        return {
          ok: false,
          error: `the control grant reference could not be written: ${
            error instanceof Error ? error.message : String(error)
          }`,
        };
      }
      return { ok: true, spec, sessionRef: spec.sessionId || spec.workerId, sessionFile: spec.sessionFile };
    },

    async launch(spec) {
      const outcome = await launchWorkerInTerminal(options.terminal, {
        workerId: spec.workerId,
        sessionName: spec.sessionName,
        sessionFile: spec.sessionFile,
        cwd: spec.cwd,
        ...(spec.agentDir === undefined ? {} : { agentDir: spec.agentDir }),
        resources: spec.resources,
      });
      return outcome.ok
        ? { ok: true, handle: outcome.windowRef }
        : { ok: false, error: `${outcome.error}${outcome.guidance ? ` — ${outcome.guidance}` : ""}` };
    },
  };
}

function bootstrapFor(input: {
  spec: Omit<WorkerLaunchSpec, "sessionFile" | "sessionId">;
  grantRef: string;
  controlSessionId: string;
}): SessionBootstrapEntry[] {
  const data = [
    {
      customType: "workflow-managed-session",
      content: JSON.stringify({
        version: 1,
        runId: input.spec.runId,
        taskId: input.spec.taskId,
        attemptId: input.spec.attemptId,
        parentSessionRef: input.spec.parentSessionRef,
        relation: "child",
        mode: "build",
        mayOrchestrate: false,
        workerId: input.spec.workerId,
        taskStartId: input.spec.taskStartId,
      }),
    },
    {
      customType: "workflow-task-assignment",
      content: JSON.stringify({
        assignmentId: input.spec.assignmentId,
        taskStartId: input.spec.taskStartId,
        packetRef: input.spec.packetRef,
        kickoff: input.spec.kickoff.content,
        model: input.spec.model,
        trust: input.spec.trust,
        profile: input.spec.profile ?? null,
      }),
    },
    {
      customType: "workflow-roadmap-reference",
      content: JSON.stringify(input.spec.roadmap),
    },
    {
      customType: CONTROL_GRANT_ENTRY,
      content: JSON.stringify({
        grantRef: input.grantRef,
        controlSessionId: input.controlSessionId,
        runId: input.spec.runId,
        taskId: input.spec.taskId,
        attemptId: input.spec.attemptId,
        taskStartId: input.spec.taskStartId,
      }),
    },
  ];
  return data.map((entry) => ({
    customType: entry.customType,
    content: entry.content.slice(0, SESSION_HOST_LIMITS.maxBootstrapChars),
    display: false,
  }));
}

/**
 * Desktop-host child creator: the HOST creates the tab/session and returns its
 * real identity. Workflow never creates a second file for the same assignment.
 */
export function createDesktopChildHost(options: {
  host: SessionHostPort;
  parentSessionRef: () => string;
  label?: string;
}): ChildHost {
  const specs = new Map<string, WorkerLaunchSpec>();
  return {
    async capabilities() {
      const caps = await options.host.capabilities();
      return {
        available: caps.create && caps.separateWindow && caps.bootstrapBeforeStart,
        label: options.label ?? caps.label,
        separateWindow: caps.separateWindow,
        focus: caps.focus,
        ...(caps.reason ? { reason: caps.reason } : {}),
      };
    },

    async prepare({ launch, grantRef, controlSessionId }) {
      const base: Omit<WorkerLaunchSpec, "sessionFile" | "sessionId"> = {
        schemaVersion: 1,
        workerId: workerIdFor({
          runId: launch.runId,
          taskId: launch.taskId,
          attemptId: launch.attemptId,
        }),
        sessionName: `Workflow ${launch.taskId} (${launch.attemptId})`.slice(0, 120),
        runId: launch.runId,
        taskId: launch.taskId,
        attemptId: launch.attemptId,
        parentSessionRef: launch.parentSessionRef,
        packetRef: launch.packetRef,
        roadmap: { ...launch.roadmap },
        cwd: launch.cwd,
        ...(launch.agentDir ? { agentDir: launch.agentDir } : {}),
        ...(launch.profile ? { profile: launch.profile } : {}),
        trust: launch.trust,
        model: { ...launch.model },
        resources: {
          extensions: [...(launch.resources?.extensions ?? [])],
          skills: [...(launch.resources?.skills ?? [])],
          prompts: [...(launch.resources?.prompts ?? [])],
        },
        kickoff: { ...launch.kickoff },
        wake: { customType: "workflow-task-start", content: "", triggerTurn: true },
        taskStartId: taskStartIdFor(
          workerIdFor({ runId: launch.runId, taskId: launch.taskId, attemptId: launch.attemptId }),
          launch.attemptId,
        ),
        assignmentId: `assignment-${workerIdFor({ runId: launch.runId, taskId: launch.taskId, attemptId: launch.attemptId })}`,
        createdAt: launch.now,
      };
      // The deterministic ids come from the same scheme as prepareWorker.
      const spec = withDeterministicIds(base);
      const related: RelatedSessionSpec = {
        requestId: spec.workerId,
        parentSessionRef: options.parentSessionRef(),
        relation: "child",
        title: spec.sessionName,
        cwd: spec.cwd,
        mode: "build",
        dedupeKey: `${spec.runId}:${spec.taskId}:${spec.attemptId}`,
        bootstrap: bootstrapFor({ spec, grantRef, controlSessionId }),
      };
      const result: SessionHostResult = await options.host.createRelated(related);
      if (!result.ok) return { ok: false, error: `${result.code}: ${result.reason}` };
      const sessionFile = result.sessionFile;
      const sessionId = result.sessionId ?? result.sessionRef;
      if (!sessionFile) {
        return {
          ok: false,
          error: "the Desktop host did not return a durable session file, so the child cannot be woken",
        };
      }
      const complete: WorkerLaunchSpec = { ...spec, sessionFile, sessionId, kickoff: spec.kickoff };
      complete.wake = { customType: "workflow-task-start", content: spec.taskStartId, triggerTurn: true };
      specs.set(complete.workerId, complete);
      return { ok: true, spec: complete, sessionRef: sessionId, sessionFile };
    },

    async launch(spec) {
      if (!specs.has(spec.workerId)) {
        specs.set(spec.workerId, spec);
      }
      // Desktop `createRelated` already opened the visible tab; the child waits
      // for the authenticated start grant. Nothing else is allowed to launch it.
      return { ok: true };
    },
  };
}

/** Deterministic ids matching `prepareWorker` (workerId / taskStartId / assignmentId). */
function withDeterministicIds(
  base: Omit<WorkerLaunchSpec, "sessionFile" | "sessionId">,
): Omit<WorkerLaunchSpec, "sessionFile" | "sessionId"> & { workerId: string; taskStartId: string; assignmentId: string } {
  const workerId = base.workerId;
  return {
    ...base,
    workerId,
    taskStartId: `start-${workerId}-${base.attemptId}`,
    assignmentId: `assignment-${workerId}`,
  };
}

// ── Dispatcher ───────────────────────────────────────────────────────

export interface ChildDispatcherPorts {
  runtime: () => OrchestratorRuntime | undefined;
  control: () => RunControl;
  host: () => ChildHost;
  builderModel: (taskId: string) => { provider: string; id: string; thinking?: string } | undefined;
  parentSessionRef: () => string;
  cwd: () => string;
  agentDir?: () => string | undefined;
  profile?: () => string | undefined;
  trust: () => "trust" | "session" | "never";
  /** Durable workspace-wide generation allocation (never attempt-local). */
  allocateGeneration: () => number;
  now?: () => number;
}

export interface ChildDispatcher extends DispatchPort {
  capabilities(): Promise<HostCapability>;
  /** Diagnostics only: what the last prepare created. */
  lastPrepared(): { taskId: string; attemptId: string; sessionRef: string; sessionFile?: string } | undefined;
}

export function createChildDispatcher(ports: ChildDispatcherPorts): ChildDispatcher {
  const now = ports.now ?? (() => Date.now());
  const prepared = new Map<
    string,
    { spec: WorkerLaunchSpec; sessionRef: string; sessionFile?: string; grant: WorkerGrant }
  >();
  let last: { taskId: string; attemptId: string; sessionRef: string; sessionFile?: string } | undefined;

  const key = (taskId: string, attemptId: string) => `${taskId}|${attemptId}`;

  const dispatcher: ChildDispatcher = {
    capabilities: () => ports.host().capabilities(),

    lastPrepared: () => last,

    async prepare(input) {
      const runtime = ports.runtime();
      const view = runtime?.view();
      if (!runtime || !view) return { ok: false, error: "no approved run is bound to this parent" };
      const task = view.state.tasks[input.taskId];
      if (!task) return { ok: false, error: `unknown task ${input.taskId}` };
      const existing = prepared.get(key(input.taskId, input.attemptId));
      if (existing) {
        return { ok: true, child: { sessionRef: existing.sessionRef, taskStartId: existing.spec.taskStartId } };
      }
      const model = ports.builderModel(input.taskId);
      if (!model) {
        return {
          ok: false,
          error: "no Builder model is configured, so a child cannot be prepared",
        };
      }
      const capability = await ports.host().capabilities();
      if (!capability.available) {
        return { ok: false, error: capability.reason ?? `${capability.label} cannot host a child` };
      }
      const control = ports.control();
      const started = await control.start();
      if (!started.ok) return { ok: false, error: started.error };

      const controlSessionId = workerIdFor({
        runId: view.runId,
        taskId: input.taskId,
        attemptId: input.attemptId,
      });
      const taskStartId = taskStartIdFor(controlSessionId, input.attemptId);
      const grant = await control.prepareGrant({
        taskId: input.taskId,
        attemptId: input.attemptId,
        sessionId: controlSessionId,
        generation: input.generation,
        taskStartId,
      });
      if (!grant.ok) return { ok: false, error: grant.error };

      const spec = task;
      const launch: WorkerLaunchInput = {
        runId: view.runId,
        taskId: input.taskId,
        attemptId: input.attemptId,
        parentSessionRef: ports.parentSessionRef(),
        packetRef: packetRefFor(spec),
        kickoff: { customType: "workflow-task-assignment", content: kickoffText({ task: spec, taskStartId, workerId: controlSessionId }) },
        roadmap: {
          path: view.roadmap.path,
          digest: view.roadmap.digest,
          revision: view.roadmapRevision,
        },
        cwd: ports.cwd(),
        ...(ports.agentDir?.() ? { agentDir: ports.agentDir?.() } : {}),
        ...(ports.profile?.() ? { profile: ports.profile?.() } : {}),
        trust: ports.trust(),
        model,
        now: now(),
        scope: {
          covers: task.covers,
          objective: task.objective,
          acceptanceChecks: task.acceptanceChecks,
          expectedFiles: task.expectedFiles,
        },
      };
      const created = await ports.host().prepare({
        launch,
        grantRef: grant.grantRef,
        controlSessionId,
      });
      if (!created.ok) {
        return { ok: false, error: created.error };
      }
      prepared.set(key(input.taskId, input.attemptId), {
        spec: created.spec,
        sessionRef: created.sessionRef,
        ...(created.sessionFile === undefined ? {} : { sessionFile: created.sessionFile }),
        grant: grant.grant,
      });
      last = {
        taskId: input.taskId,
        attemptId: input.attemptId,
        sessionRef: created.sessionRef,
        ...(created.sessionFile === undefined ? {} : { sessionFile: created.sessionFile }),
      };
      const child: PreparedChild = { sessionRef: created.sessionRef, taskStartId: created.spec.taskStartId };
      return { ok: true, child };
    },

    async wake(input) {
      const entry = prepared.get(key(input.taskId, input.attemptId));
      if (!entry) {
        return { ok: false, error: "the child was not prepared; nothing was launched" };
      }
      const capability = await ports.host().capabilities();
      if (!capability.available) {
        return { ok: false, error: capability.reason ?? `${capability.label} cannot host a child` };
      }
      const control = ports.control();
      // Arm the window BEFORE the child can connect: a fast child must not race
      // the acknowledgement into a "never connected" result.
      const waiting = control.awaitStart({ sessionId: entry.grant.sessionId, timeoutMs: 45_000 });
      const launched = await ports.host().launch(entry.spec);
      if (!launched.ok) {
        return { ok: false, error: `the child could not be shown: ${launched.error}` };
      }
      const started = await waiting;
      if (!started.ok) {
        return {
          ok: false,
          error: started.error,
          // The visible child exists; an unacknowledged start is uncertain,
          // never a clean failure that invites a blind retry.
          uncertain: true,
        };
      }
      return { ok: true, acknowledged: true };
    },
  };

  return dispatcher;
}

/** Read a control-grant reference from a child's own session entries. */
export function controlGrantRefFrom(
  entries: ReadonlyArray<{ type?: string; customType?: string; data?: unknown }>,
): string | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.type !== "custom" || entry.customType !== CONTROL_GRANT_ENTRY) continue;
    const data = entry.data;
    if (data && typeof data === "object" && typeof (data as { grantRef?: unknown }).grantRef === "string") {
      return (data as { grantRef: string }).grantRef;
    }
  }
  return undefined;
}
