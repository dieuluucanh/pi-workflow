/**
 * Workflow Extension — parent tool adapters and durable dispatch (step 16).
 *
 * `orchestrator-tools.ts` decides; this module is where a decision becomes a
 * real, durable effect. It exists because the pure tool layer is not enough:
 * a dispatch must prepare the child, take the workspace lease, journal the
 * start INTENT, wake exactly once and record the actual acknowledgement.
 *
 * The order is the whole point, and it is enforced here rather than described:
 *
 *   1. readiness/authority checks (execution approval, task, dependencies)
 *   2. prepared session/host ownership (real session ref)
 *   3. workspace lease for this attempt/generation
 *   4. the `task.assign` reducer event (journaled before any wake)
 *   5. persisted `task.start.intent`
 *   6. one authenticated wake
 *   7. persisted `task.start.ack` + the `task.start` reducer event
 *
 * A failure at step 6 leaves the intent without an ack: that is `uncertain`,
 * and it must be reconciled, never retried blindly. Nothing here reports
 * "running" from an in-memory proposal.
 */

import {
  ORCHESTRATOR_TOOLS,
  handleOrchestratorTool,
  type ApprovalState,
  type OrchestratorToolName,
  type ToolContext,
  type ToolResult,
} from "./orchestrator-tools.ts";
import type { OrchestratorRuntime, ProposalContext } from "./orchestrator-runtime.ts";
import type { WorkspaceLeases, LeaseGrant } from "./orchestrator-workspace.ts";
import type { ExecutionBudgets } from "./orchestrator-types.ts";
import { formatExecutionPreview, previewApprovalId, MAX_PREVIEW_VIEW_CHARS } from "./orchestrator-preview-view.ts";

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
  /** The one correlated start message. Success means delivered, not accepted. */
  wake(input: {
    sessionRef: string;
    taskStartId: string;
    taskId: string;
    attemptId: string;
  }): Promise<
    | { ok: true; acknowledged: boolean }
    | { ok: false; error: string; uncertain?: boolean }
  >;
}

export interface ParentToolPorts {
  runtime: () => OrchestratorRuntime | undefined;
  /** Proposal inputs (budgets, launcher readiness, checks, limits, options). */
  proposalContext: () => ProposalContext | undefined;
  /**
   * Why proposal inputs are unavailable (for example an unconfigured Builder
   * model). A generic "budgets unavailable" message hides an actionable
   * configuration error, so the host supplies the concrete reason.
   */
  proposalUnavailable?: () => string | undefined;
  epoch: () => number;
  budgets?: ExecutionBudgets;
  workspaceRev?: () => string | undefined;
  dispatcher?: DispatchPort;
  leases?: {
    acquire: WorkspaceLeases["acquire"];
    release: WorkspaceLeases["release"];
  };
  workspaceKey?: () => string | undefined;
  /** Durable workspace-wide fencing token; falls back to attempt-local. */
  allocateGeneration?: () => number | undefined;
  now?: () => number;
  /**
   * Why this session may not orchestrate right now (managed worker, wrong
   * mode, no bound run). Checked before every tool call, so a tool name alone
   * can never grant orchestration authority.
   */
  eligible?: () => string | undefined;
  /**
   * Why preparation is unavailable (managed worker, wrong mode). Preparation
   * must work BEFORE a run is bound, so it cannot use `eligible`.
   */
  prepareEligible?: () => string | undefined;
  /**
   * Resolve/snapshot the requested work and return bounded breakdown
   * instructions. The extension owns file/run effects; this port only decides
   * what the model is told.
   */
  prepare?: (input: {
    source?: string;
    planPath?: string;
    objective?: string;
    constraints?: string[];
  }) => Promise<
    | { ok: true; text: string; details: Record<string, unknown> }
    | { ok: false; code: string; text: string }
  >;
}

export type ParentToolOutcome =
  | {
      ok: true;
      tool: OrchestratorToolName;
      text: string;
      details: Record<string, unknown>;
    }
  | { ok: false; tool: string; text: string; code: string };

/** What `registerParentTools` needs; index.ts maps this to `pi.registerTool`. */
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

export interface ParentToolCallOptions {
  /**
   * The host already owns the approval surface. A UI host asks for the dialog
   * (so the tool text must not print a command), a headless host keeps the
   * id-bound command, and `none` lets the host append the actual outcome.
   */
  approvalHint?: "command" | "dialog" | "none";
}

export interface ParentToolRuntime {
  /** Builds the current tool context, or a truthful reason it is unavailable. */
  context(): { ok: true; context: ToolContext } | { ok: false; error: string };
  call(
    name: OrchestratorToolName,
    params: unknown,
    options?: ParentToolCallOptions,
  ): Promise<ParentToolOutcome>;
  register(registrar: ParentToolRegistrar): { registered: string[]; refused: string | null };
}

const START_ACK_PREFIX = "start-ack";

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

  const context = (): { ok: true; context: ToolContext } | { ok: false; error: string } => {
    const rt = ports.runtime();
    if (!rt) {
      return { ok: false, error: "no approved orchestrator run is bound to this session" };
    }
    const view = rt.view();
    if (!view) {
      return { ok: false, error: "no approved orchestrator run is bound to this session" };
    }
    const dispatcherReady = rt.canDispatch();
    const approval: ApprovalState | null = view.approval && view.preview
      ? {
          // A live approval is not the same as a dispatchable run: the runtime
          // revalidates every material digest and the phase.
          approved: dispatcherReady.ok,
          approvalDigest: view.approval.approvalDigest,
          planDigest: view.approval.planDigest,
        }
      : null;
    const workspaceRevision = ports.workspaceRev?.();
    return {
      ok: true,
      context: {
        state: view.state,
        now: now(),
        epoch: ports.epoch(),
        currentEpoch: ports.epoch(),
        activeTurn: false,
        approval,
        ...(workspaceRevision === undefined ? {} : { workspaceRevision }),
        ...(ports.budgets === undefined ? {} : { budgets: ports.budgets }),
      },
    };
  };

  const releaseLease = () => {
    if (!lease) return;
    try {
      ports.leases?.release(lease);
    } catch {
      /* a stale lease expires on its own; never crash the run on release */
    }
    lease = undefined;
  };

  const dispatch = async (
    ctx: ToolContext,
    params: Record<string, unknown>,
  ): Promise<ParentToolOutcome> => {
    const dispatcher = ports.dispatcher;
    if (!dispatcher) {
      return {
        ok: false,
        tool: "orchestrator_dispatch",
        code: "unavailable",
        text: "No child host is bound (no Terminal/Desktop launcher port); nothing was dispatched.",
      };
    }
    const taskId = typeof params.taskId === "string" ? params.taskId : "";
    const attemptId = typeof params.attemptId === "string" ? params.attemptId : "";
    const task = ctx.state.tasks[taskId];
    if (!task) {
      return { ok: false, tool: "orchestrator_dispatch", code: "state", text: "unknown task" };
    }
    // (1) authority first: a missing/stale execution approval must fail BEFORE
    // any session, lease or wake effect. A prepared child is already an effect.
    if (!ctx.approval?.approved) {
      return {
        ok: false,
        tool: "orchestrator_dispatch",
        code: "approval",
        text: "Explicit execution approval is required before the first dispatch; nothing was prepared or woken.",
      };
    }
    const rt = ports.runtime();
    if (!rt) {
      return { ok: false, tool: "orchestrator_dispatch", code: "unavailable", text: "No orchestrator run is bound; nothing was prepared or woken." };
    }
    const dispatchable = rt.canDispatch();
    if (!dispatchable.ok) {
      return {
        ok: false,
        tool: "orchestrator_dispatch",
        code: "approval",
        text: `This run is not dispatchable: ${dispatchable.reasons.join("; ")}. Nothing was prepared or woken.`,
      };
    }
    const allocated = ports.allocateGeneration?.();
    const generation =
      typeof allocated === "number" && Number.isInteger(allocated) && allocated > 0
        ? allocated
        : task.attempts.length + 1;

    // (2) prepared session/host ownership — real identity, not a guess.
    const prepared = await dispatcher.prepare({
      runId: ctx.state.runId,
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

    // (3) the workspace lease, when one is configured.
    const workspaceKey = ports.workspaceKey?.();
    if (ports.leases && workspaceKey) {
      const acquired = ports.leases.acquire({
        workspaceKey,
        runId: ctx.state.runId,
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

    // (4) the decision, recomputed with the REAL session reference.
    const decided = handleOrchestratorTool(
      "orchestrator_dispatch",
      { ...params, sessionRef: prepared.child.sessionRef },
      ctx,
    );
    if (!decided.ok) {
      releaseLease();
      return { ok: false, tool: "orchestrator_dispatch", code: decided.code, text: decided.error };
    }
    if (!decided.event) {
      releaseLease();
      return {
        ok: false,
        tool: "orchestrator_dispatch",
        code: "state",
        text: "the dispatch produced no durable transition",
      };
    }
    const assigned = await rt.applyEvent(decided.event);
    if (!assigned.ok) {
      releaseLease();
      return {
        ok: false,
        tool: "orchestrator_dispatch",
        code: "journal",
        text: `The dispatch intent could not be journaled: ${assigned.error}. Nothing was woken.`,
      };
    }

    const taskStartId =
      decided.receipt.taskStartId ??
      prepared.child.taskStartId ??
      `start-${ctx.state.runId}-${taskId}-${attemptId}`;

    // (5) persisted start INTENT, before the wake.
    const intent = await rt.appendJournal(
      "task.start.intent",
      {
        taskId,
        attemptId,
        sessionId: prepared.child.sessionRef,
        taskStartId,
        generation,
      },
      `start-intent-${ctx.state.runId}-${taskId}-${attemptId}`,
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

    // (6) exactly one wake.
    const woken = await dispatcher.wake({
      sessionRef: prepared.child.sessionRef,
      taskStartId,
      taskId,
      attemptId,
    });
    if (!woken.ok) {
      // A delivered-but-unacknowledged start is uncertain, not failed.
      if (woken.uncertain) {
        return {
          ok: false,
          tool: "orchestrator_dispatch",
          code: "uncertain",
          text: `The start was sealed but not acknowledged: ${woken.error}. The run must reconcile this attempt (never resend blindly).`,
        };
      }
      await rt.applyEvent({
        type: "attempt.launchFailed",
        runId: ctx.state.runId,
        now: now(),
        taskId,
        attemptId,
      });
      releaseLease();
      return {
        ok: false,
        tool: "orchestrator_dispatch",
        code: "launch",
        text: `The child could not be started: ${woken.error}. The launch failure was recorded.`,
      };
    }

    if (!woken.acknowledged) {
      return {
        ok: false,
        tool: "orchestrator_dispatch",
        code: "uncertain",
        text: `The start message was delivered but the child did not acknowledge ${taskStartId}. Reconcile before retrying.`,
      };
    }

    // (7) the actual acknowledgement.
    await rt.appendJournal(
      "task.start.ack",
      {
        taskId,
        attemptId,
        sessionId: prepared.child.sessionRef,
        taskStartId,
        generation,
      },
      `${START_ACK_PREFIX}-${ctx.state.runId}-${taskId}-${attemptId}`,
    );
    const started = await rt.applyEvent({
      type: "task.start",
      runId: ctx.state.runId,
      now: now(),
      taskId,
      attemptId,
      sessionId: prepared.child.sessionRef,
      generation,
    });
    if (!started.ok) {
      return {
        ok: false,
        tool: "orchestrator_dispatch",
        code: "state",
        text: `The child acknowledged, but the start transition failed: ${started.error}. Reconcile the run.`,
      };
    }

    return {
      ok: true,
      tool: "orchestrator_dispatch",
      text: `Dispatched ${taskId}/${attemptId} to ${prepared.child.sessionRef}; the child acknowledged start ${taskStartId}. Parent verification follows the child's fenced report.`,
      details: {
        runId: ctx.state.runId,
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

    async call(name, params, options) {
      const input = asParams(params);

      // Preparation is the one parent capability available BEFORE a run is
      // bound. It is still refused for workers, quarantine and other modes.
      if (name === "orchestrator_prepare") {
        const blocked = ports.prepareEligible?.();
        if (blocked) {
          return { ok: false, tool: name, code: "unavailable", text: blocked };
        }
        if (!ports.prepare) {
          return {
            ok: false,
            tool: name,
            code: "unavailable",
            text: "This build has no work-source service bound; nothing was prepared.",
          };
        }
        const prepared = await ports.prepare({
          ...(typeof input.source === "string" ? { source: input.source } : {}),
          ...(typeof input.planPath === "string" ? { planPath: input.planPath } : {}),
          ...(typeof input.objective === "string" ? { objective: input.objective } : {}),
          ...(Array.isArray(input.constraints)
            ? {
                constraints: input.constraints.filter(
                  (entry): entry is string => typeof entry === "string",
                ),
              }
            : {}),
        });
        return prepared.ok
          ? { ok: true, tool: name, text: prepared.text, details: prepared.details }
          : { ok: false, tool: name, code: prepared.code, text: prepared.text };
      }

      const blocked = ports.eligible?.();
      if (blocked) {
        return { ok: false, tool: name, code: "unavailable", text: blocked };
      }
      const built = context();
      if (!built.ok) {
        return { ok: false, tool: name, code: "unavailable", text: built.error };
      }

      if (name === "orchestrator_propose_tasks") {
        const proposal = ports.proposalContext();
        if (!proposal) {
          return {
            ok: false,
            tool: name,
            code: "unavailable",
            text:
              ports.proposalUnavailable?.() ??
              "Execution budgets/launcher readiness are unavailable, so a breakdown cannot be validated yet.",
          };
        }
        const proposed = await (ports.runtime() as OrchestratorRuntime).propose({
          plan: input.plan,
          // Coverage is resolved by the runtime from the roadmap it snapshotted
          // at ingest; a model-supplied requirement list is not authority.
          context: proposal,
        });
        if (!proposed.ok) {
          return { ok: false, tool: name, code: proposed.code, text: proposed.error };
        }
        const preview = proposed.value.preview;
        const blockers = preview.blockedReasons.slice(0, 5);
        return {
          ok: true,
          tool: name,
          text: bounded(
            formatExecutionPreview({
              preview,
              requirements: proposed.value.view.requirements,
              fromDiscussion: /discussion-[0-9a-f]+\.md$/i.test(proposed.value.view.roadmap.path),
              approvalHint: options?.approvalHint ?? "command",
            }),
            MAX_PREVIEW_VIEW_CHARS,
          ),
          details: {
            runId: preview.runId,
            previewId: previewApprovalId(preview),
            planDigest: preview.planDigest,
            approvalDigest: preview.approvalDigest,
            taskCount: preview.tasks.length,
            blockedReasons: blockers,
            requiresApproval: true,
          },
        };
      }

      if (name === "orchestrator_dispatch") {
        return dispatch(built.context, input);
      }

      const decided = handleOrchestratorTool(name, input, built.context);
      if (!decided.ok) {
        return { ok: false, tool: name, code: decided.code, text: decided.error };
      }
      if (decided.event) {
        const applied = await (ports.runtime() as OrchestratorRuntime).applyEvent(decided.event);
        if (!applied.ok) {
          return {
            ok: false,
            tool: name,
            code: "journal",
            text: `The transition could not be journaled: ${applied.error}. Nothing changed.`,
          };
        }
      }
      const receipt = decided.receipt;
      return {
        ok: true,
        tool: name,
        text: bounded(receipt.summary),
        details: { ...receipt },
      };
    },

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

export type { ToolResult };
