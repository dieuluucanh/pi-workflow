/**
 * Workflow Extension — parent tool adapters and durable dispatch.
 *
 * `orchestrator-tools.ts` decides; this module turns a decision into a real,
 * durable effect. Dispatch order is the whole point:
 *
 *   1. authority/state checks (single running row, pending row, host bound)
 *   2. prepared child session/host ownership (real session ref)
 *   3. the `task.start` reducer event, journaled before any wake
 *   4. the persisted `task.start.intent`
 *   5. exactly one wake
 *
 * A failure before step 5 leaves the row pending with a real reason; nothing
 * is reported as running from an in-memory guess.
 */

import {
  ORCHESTRATOR_TOOLS,
  handleOrchestratorTool,
  type OrchestratorToolName,
  type ToolContext,
} from "./orchestrator-tools.ts";
import type { OrchestratorRuntime } from "./orchestrator-runtime.ts";
import type { WorkspaceLeases, LeaseGrant } from "./orchestrator-workspace.ts";

export const TOOL_ADAPTER_SCHEMA_VERSION = 1 as const;
export const MAX_TOOL_TEXT = 2_000;

export interface PreparedChild {
  sessionRef: string;
  taskStartId: string;
}

export interface DispatchPort {
  /** Creates the durable child session and its metadata (never a wake). */
  prepare(input: {
    runId: string;
    taskId: string;
    attemptId: string;
    generation: number;
  }): Promise<{ ok: true; child: PreparedChild } | { ok: false; error: string }>;
  /** The one correlated start message. */
  wake(input: {
    sessionRef: string;
    taskStartId: string;
    taskId: string;
    attemptId: string;
  }): Promise<{ ok: true; acknowledged: boolean } | { ok: false; error: string }>;
}

export interface ParentToolPorts {
  runtime: () => OrchestratorRuntime | undefined;
  epoch: () => number;
  workspaceRev?: () => string | undefined;
  dispatcher?: DispatchPort;
  leases?: {
    acquire: WorkspaceLeases["acquire"];
    release: WorkspaceLeases["release"];
  };
  workspaceKey?: () => string | undefined;
  allocateGeneration?: () => number | undefined;
  now?: () => number;
  /** Why this session may not orchestrate right now. */
  eligible?: () => string | undefined;
  /** Why preparation/start is unavailable (works before a run is bound). */
  startEligible?: () => string | undefined;
  /** Create/freeze the run and dispatch the first row. */
  start?: (input: {
    planPath?: string;
    title?: string;
    steps?: string[];
  }) => Promise<
    | { ok: true; text: string; details: Record<string, unknown> }
    | { ok: false; code: string; text: string }
  >;
  /** Retry the next pending row after a dispatch failure. */
  retry?: () => Promise<
    | { ok: true; text: string; details: Record<string, unknown> }
    | { ok: false; code: string; text: string }
  >;
  /** Run the real row verification (diff + checks). */
  verify?: (taskId: string) => Promise<{
    ok: boolean;
    text: string;
    code?: string;
    details?: Record<string, unknown>;
  }>;
  /** Accept the verified row and dispatch the next one. */
  accept?: (taskId: string) => Promise<{
    ok: boolean;
    text: string;
    code?: string;
    details?: Record<string, unknown>;
  }>;
}

export type ParentToolOutcome =
  | {
      ok: true;
      tool: OrchestratorToolName | "orchestrator_dispatch";
      text: string;
      details: Record<string, unknown>;
    }
  | { ok: false; tool: string; text: string; code: string };

export interface ParentToolRegistrar {
  registerTool(definition: {
    name: string;
    label: string;
    description: string;
    parameters: Record<string, unknown>;
    execute: (
      toolCallId: string,
      params: Record<string, unknown>,
    ) => Promise<{ content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> }>;
  }): void;
}

export interface ParentToolRuntime {
  context(): { ok: true; context: ToolContext } | { ok: false; error: string };
  call(name: OrchestratorToolName, params: unknown): Promise<ParentToolOutcome>;
  /** Internal scheduler entry: prepare/wake the requested frozen row. */
  dispatch(taskId: string): Promise<ParentToolOutcome>;
  register(registrar: ParentToolRegistrar): { registered: string[]; refused: string | null };
}

function bounded(value: string, max = MAX_TOOL_TEXT): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function asParams(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};
}

export function createParentToolRuntime(ports: ParentToolPorts): ParentToolRuntime {
  const now = ports.now ?? (() => Date.now());
  let lease: LeaseGrant | undefined;

  const releaseLease = () => {
    if (!lease) return;
    try {
      ports.leases?.release(lease);
    } catch {
      /* a stale lease expires on its own */
    }
    lease = undefined;
  };

  const context = (): { ok: true; context: ToolContext } | { ok: false; error: string } => {
    const rt = ports.runtime();
    const view = rt?.view();
    if (!rt || !view) {
      return { ok: false, error: "no orchestrator run is bound to this session" };
    }
    return {
      ok: true,
      context: {
        state: view.state,
        now: now(),
        epoch: ports.epoch(),
        currentEpoch: ports.epoch(),
      },
    };
  };

  const dispatch = async (taskId: string): Promise<ParentToolOutcome> => {
    const rt = ports.runtime();
    const view = rt?.view();
    if (!rt || !view) {
      return { ok: false, tool: "orchestrator_dispatch", code: "unavailable", text: "No orchestrator run is bound." };
    }
    if (view.phase === "paused" || view.phase === "cancelled" || view.phase === "completed") {
      return {
        ok: false,
        tool: "orchestrator_dispatch",
        code: "state",
        text: `The run is ${view.phase}; no row is dispatched.`,
      };
    }
    const running = view.state.order.find(
      (id) => view.state.tasks[id]?.state === "running" || view.state.tasks[id]?.state === "candidate",
    );
    if (running) {
      return {
        ok: false,
        tool: "orchestrator_dispatch",
        code: "state",
        text: `${running} is still in flight; the scheduler runs one child at a time.`,
      };
    }
    const task = view.state.tasks[taskId];
    if (!task) {
      return { ok: false, tool: "orchestrator_dispatch", code: "state", text: "unknown task" };
    }
    if (task.state !== "pending") {
      return {
        ok: false,
        tool: "orchestrator_dispatch",
        code: "state",
        text: `${taskId} is ${task.state}; only a pending row is dispatched.`,
      };
    }
    const dispatcher = ports.dispatcher;
    if (!dispatcher) {
      return {
        ok: false,
        tool: "orchestrator_dispatch",
        code: "unavailable",
        text: "No child host is bound (no Terminal/Desktop launcher port); nothing was dispatched.",
      };
    }
    const allocated = ports.allocateGeneration?.();
    const generation =
      typeof allocated === "number" && Number.isInteger(allocated) && allocated > 0
        ? allocated
        : task.repairRounds + 1;
    const attemptId = `${taskId}-attempt-${generation}`;

    // (1) prepared session/host ownership — a real identity, not a guess.
    const prepared = await dispatcher.prepare({
      runId: view.runId,
      taskId,
      attemptId,
      generation,
    });
    if (!prepared.ok) {
      return {
        ok: false,
        tool: "orchestrator_dispatch",
        code: "prepare",
        text: `The child session could not be prepared: ${prepared.error}. Nothing was woken.`,
      };
    }

    // (2) the workspace lease, when one is configured.
    const workspaceKey = ports.workspaceKey?.();
    if (ports.leases && workspaceKey) {
      const acquired = ports.leases.acquire({
        workspaceKey,
        runId: view.runId,
        taskId,
        attemptId,
        sessionId: prepared.child.sessionRef,
        generation,
      });
      if (!acquired.ok) {
        return {
          ok: false,
          tool: "orchestrator_dispatch",
          code: acquired.code,
          text: `The workspace is not available to this attempt: ${acquired.error}. Nothing was woken.`,
        };
      }
      lease = acquired.grant;
    }

    // (3) the durable transition, journaled before any wake.
    const started = await rt.applyEvent({
      type: "task.start",
      runId: view.runId,
      now: now(),
      taskId,
      attemptId,
      sessionId: prepared.child.sessionRef,
    });
    if (!started.ok) {
      releaseLease();
      return {
        ok: false,
        tool: "orchestrator_dispatch",
        code: "journal",
        text: `The dispatch intent could not be journaled: ${started.error}. Nothing was woken.`,
      };
    }

    const taskStartId = prepared.child.taskStartId ?? `start-${view.runId}-${taskId}-${attemptId}`;

    // (4) persisted start INTENT, before the wake.
    const intent = await rt.appendJournal(
      "task.start.intent",
      {
        taskId,
        attemptId,
        sessionId: prepared.child.sessionRef,
        taskStartId,
        generation,
      },
      `start-intent-${view.runId}-${taskId}-${attemptId}`,
    );
    if (!intent.ok) {
      releaseLease();
      return {
        ok: false,
        tool: "orchestrator_dispatch",
        code: "journal",
        text: `The start intent could not be journaled: ${intent.error}. Nothing was woken.`,
      };
    }

    // (5) exactly one wake.
    const woken = await dispatcher.wake({
      sessionRef: prepared.child.sessionRef,
      taskStartId,
      taskId,
      attemptId,
    });
    if (!woken.ok) {
      // The visible window/session exists; the row is in flight and the report
      // cannot arrive until the start turn runs. Leave the honest state.
      return {
        ok: false,
        tool: "orchestrator_dispatch",
        code: "launch",
        text: `The child was prepared but the start could not be delivered: ${woken.error}. The frozen row is intact; retry after fixing the host.`,
      };
    }
    return {
      ok: true,
      tool: "orchestrator_dispatch",
      text: `Dispatched ${taskId} to ${prepared.child.sessionRef}; waiting for the child's report.`,
      details: {
        runId: view.runId,
        taskId,
        attemptId,
        sessionRef: prepared.child.sessionRef,
        taskStartId,
        generation,
      },
    };
  };

  const runtime: ParentToolRuntime = {
    context,

    async call(name, params) {
      const input = asParams(params);

      if (name === "orchestrator_start") {
        const blocked = ports.startEligible?.();
        if (blocked) return { ok: false, tool: name, code: "unavailable", text: blocked };
        if (!ports.start) {
          return { ok: false, tool: name, code: "unavailable", text: "No Orchestrator start service is bound." };
        }
        const started = await ports.start({
          ...(typeof input.planPath === "string" ? { planPath: input.planPath } : {}),
          ...(typeof input.title === "string" ? { title: input.title } : {}),
          ...(Array.isArray(input.steps)
            ? {
                steps: input.steps.filter(
                  (entry): entry is string => typeof entry === "string" && entry.trim().length > 0,
                ),
              }
            : {}),
        });
        return started.ok
          ? { ok: true, tool: name, text: started.text, details: started.details }
          : { ok: false, tool: name, code: started.code, text: started.text };
      }

      const blocked = ports.eligible?.();
      if (blocked) return { ok: false, tool: name, code: "unavailable", text: blocked };
      const built = context();
      if (!built.ok) return { ok: false, tool: name, code: "unavailable", text: built.error };

      // The real verification/acceptance paths are host-provided; the model
      // supplies only a task id and can never mint evidence.
      if (name === "orchestrator_verify") {
        const taskId = typeof input.taskId === "string" ? input.taskId : "";
        if (!ports.verify) {
          return { ok: false, tool: name, code: "unavailable", text: "No verification service is bound." };
        }
        const verified = await ports.verify(taskId);
        if (verified.ok) {
          return { ok: true, tool: name, text: bounded(verified.text), details: verified.details ?? {} };
        }
        return { ok: false, tool: name, code: verified.code ?? "state", text: verified.text };
      }

      if (name === "orchestrator_accept") {
        const taskId = typeof input.taskId === "string" ? input.taskId : "";
        if (!ports.accept) {
          return { ok: false, tool: name, code: "unavailable", text: "No acceptance service is bound." };
        }
        const accepted = await ports.accept(taskId);
        return accepted.ok
          ? { ok: true, tool: name, text: bounded(accepted.text), details: accepted.details ?? {} }
          : { ok: false, tool: name, code: accepted.code ?? "state", text: accepted.text };
      }

      const decided = handleOrchestratorTool(name, input, built.context);
      if (!decided.ok) return { ok: false, tool: name, code: decided.code, text: decided.error };
      if (decided.event) {
        const applied = await ports.runtime()!.applyEvent(decided.event);
        if (!applied.ok) {
          return {
            ok: false,
            tool: name,
            code: "journal",
            text: `The transition could not be journaled: ${applied.error}. Nothing changed.`,
          };
        }
      }
      return {
        ok: true,
        tool: name,
        text: bounded(decided.receipt.summary),
        details: { ...decided.receipt },
      };
    },

    dispatch,

    register(registrar) {
      const registered: string[] = [];
      for (const spec of ORCHESTRATOR_TOOLS) {
        registrar.registerTool({
          name: spec.name,
          label: `Orchestrator ${spec.name.replace("orchestrator_", "").replace(/_/g, " ")}`,
          description: spec.description,
          parameters: spec.parameters,
          execute: async (_toolCallId, params) => {
            const result = await runtime.call(spec.name, params);
            return {
              content: [{ type: "text" as const, text: result.text }],
              details: result.ok ? result.details : { ok: false, code: result.code },
            };
          },
        });
        registered.push(spec.name);
      }
      return { registered, refused: null };
    },
  };

  return runtime;
}

/** Tool names the parent may use; workers and ordinary sessions never may. */
export const PARENT_TOOL_NAMES: readonly OrchestratorToolName[] = ORCHESTRATOR_TOOLS.map(
  (spec) => spec.name,
);

/** A bounded refusal for a session that must not orchestrate. */
export function parentToolRefusal(reason: string): ParentToolOutcome {
  return {
    ok: false,
    tool: "orchestrator",
    code: "unavailable",
    text: bounded(`Orchestration tools are unavailable: ${reason}`),
  };
}
