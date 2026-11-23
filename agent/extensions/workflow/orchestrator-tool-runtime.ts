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
  sessionFile?: string;
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
  }): Promise<
    | { ok: true; acknowledged: boolean; handle?: string }
    | { ok: false; error: string; uncertain?: boolean }
  >;
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
  probeStale?: (taskId: string) => Promise<{ stale: boolean; reason: string }>;
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

    // (5) exactly one wake: show the child, then wait for its start ack.
    const woken = await dispatcher.wake({
      sessionRef: prepared.child.sessionRef,
      taskStartId,
      taskId,
      attemptId,
    });
    if (!woken.ok) {
      if (woken.uncertain) {
        // The child may be running; never relaunch or un-run it automatically.
        await rt.appendJournal(
          "run.control",
          { action: "start-uncertain", taskId, attemptId, reason: woken.error },
          `start-uncertain-${view.runId}-${taskId}-${attemptId}`,
        );
        return {
          ok: false,
          tool: "orchestrator_dispatch",
          code: "uncertain",
          text: `The child was launched but did not acknowledge its start: ${woken.error}. The row stays running; reconcile it explicitly instead of relaunching.`,
        };
      }
      // The launcher refused before any child existed. Keep the row retryable.
      await rt.applyEvent({
        type: "task.block",
        runId: view.runId,
        now: now(),
        taskId,
        reason: `child launch failed: ${woken.error}`.slice(0, 400),
      });
      releaseLease();
      return {
        ok: false,
        tool: "orchestrator_dispatch",
        code: "launch",
        text: `The child could not be launched: ${woken.error}. ${taskId} is blocked; /orchestrator retry re-dispatches it.`,
      };
    }

    // Durable launch evidence: recovery uses its presence to distinguish a
    // never-launched attempt from a child that may still be alive.
    await rt.appendJournal(
      "task.launched",
      {
        taskId,
        attemptId,
        sessionId: prepared.child.sessionRef,
        taskStartId,
        generation,
        at: now(),
        ...(prepared.child.sessionFile === undefined
          ? {}
          : { sessionFile: prepared.child.sessionFile }),
        ...(woken.handle === undefined ? {} : { handle: woken.handle }),
      },
      `launched-${view.runId}-${taskId}-${attemptId}`,
    );

    return {
      ok: true,
      tool: "orchestrator_dispatch",
      text: `Dispatched ${taskId} to ${prepared.child.sessionRef}; the child acknowledged its start and is working.`,
      details: {
        runId: view.runId,
        taskId,
        attemptId,
        sessionRef: prepared.child.sessionRef,
        taskStartId,
        generation,
        ...(prepared.child.sessionFile === undefined
          ? {}
          : { sessionFile: prepared.child.sessionFile }),
        ...(woken.handle === undefined ? {} : { handle: woken.handle }),
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

      if (name === "orchestrator_retry") {
        const rt = ports.runtime();
        const view = rt?.view();
        if (!rt || !view) {
          return { ok: false, tool: name, code: "unavailable", text: "No orchestrator run is bound." };
        }
        const requested = typeof input.taskId === "string" ? input.taskId : "";
        const blocked = view.state.order.find((id) => {
          const state = view.state.tasks[id]?.state;
          return state === "blocked" || state === "needs_fix";
        });
        const running = view.state.order.find((id) => view.state.tasks[id]?.state === "running");
        const target = requested || blocked || running;
        if (!target) {
          return {
            ok: false,
            tool: name,
            code: "state",
            text: "There is no blocked, repaired or stale running row to retry.",
          };
        }
        const task = view.state.tasks[target];
        if (!task) {
          return { ok: false, tool: name, code: "state", text: `Unknown task ${target}.` };
        }

        // A running row is only abandoned when the probe proves no child ever
        // started; otherwise two children could write the same row.
        if (task.state === "running") {
          if (!ports.probeStale) {
            return {
              ok: false,
              tool: name,
              code: "unavailable",
              text: "No stale-row probe is bound; inspect the child before retrying.",
            };
          }
          const probe = await ports.probeStale(target);
          if (!probe.stale) {
            return { ok: false, tool: name, code: "state", text: probe.reason };
          }
          const blockedEvent = await rt.applyEvent({
            type: "task.block",
            runId: view.runId,
            now: now(),
            taskId: target,
            reason: `launch never observed; attempt ${task.attemptId ?? "unknown"} abandoned after probe`,
          });
          if (!blockedEvent.ok) {
            return {
              ok: false,
              tool: name,
              code: "journal",
              text: `The abandoned attempt could not be recorded: ${blockedEvent.error}`,
            };
          }
        }

        const retried = await rt.applyEvent({
          type: "task.retry",
          runId: view.runId,
          now: now(),
          taskId: target,
        });
        if (!retried.ok) {
          return { ok: false, tool: name, code: "state", text: `Cannot retry ${target}: ${retried.error}` };
        }
        const dispatched = await dispatch(target);
        return dispatched.ok
          ? {
              ok: true,
              tool: name,
              text: `${target} is retried. ${dispatched.text}`,
              details: { taskId: target, ...dispatched.details },
            }
          : {
              ok: false,
              tool: name,
              code: dispatched.code,
              text: `${target} is queued again, but the dispatch failed: ${dispatched.text}`,
            };
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
