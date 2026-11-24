/**
 * Workflow Extension — parent tool adapters.
 *
 * `orchestrator-tools.ts` decides; this module turns a decision into a durable
 * effect. The surface is deliberately small: start, dispatch, status and retry.
 *
 * Acceptance is no longer a tool call. A settled child is verified, accepted
 * and followed by the next row inside the parent report loop. The model only
 * recovers a blocked row (retry) or explains a blocker/completion.
 */

import {
  ORCHESTRATOR_TOOLS,
  handleOrchestratorTool,
  type OrchestratorToolName,
  type ToolContext,
} from "./orchestrator-tools.ts";
import type { OrchestratorRuntime } from "./orchestrator-runtime.ts";
import type { OrchestratorRun } from "./orchestrator-run.ts";

export const TOOL_ADAPTER_SCHEMA_VERSION = 2 as const;
export const MAX_TOOL_TEXT = 2_000;

export interface ParentToolPorts {
  runtime: () => OrchestratorRuntime | undefined;
  /** The model-driven run record, when the new engine is active. */
  run?: () => OrchestratorRun | undefined;
  /** Dispatch one row with the parent's complete instruction. */
  dispatch?: (input: {
    rowRef?: string;
    instructions: string;
    cwd?: string;
  }) => Promise<
    | { ok: true; text: string; details: Record<string, unknown> }
    | { ok: false; code: string; text: string }
  >;
  /** Render the current run and its last child reports. */
  statusText?: () => string;
  epoch: () => number;
  now?: () => number;
  /** Why this session may not orchestrate right now. */
  eligible?: () => string | undefined;
  /** Why starting is unavailable (works before a run is bound). */
  startEligible?: () => string | undefined;
  /** Create/freeze the run and dispatch the first row. */
  start?: (input: {
    planPath?: string;
    title?: string;
    steps?: string[];
    workspaces?: Array<{ id?: string; path: string }>;
  }) => Promise<
    | { ok: true; text: string; details: Record<string, unknown> }
    | { ok: false; code: string; text: string }
  >;
  /** Dispatch the next pending frozen row into the in-process Build child. */
  dispatchNext?: (taskId: string) => Promise<
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

export interface ParentToolRegistrar {
  registerTool(definition: {
    name: string;
    label: string;
    description: string;
    parameters: Record<string, unknown>;
    execute: (
      toolCallId: string,
      params: Record<string, unknown>,
    ) => Promise<{
      content: Array<{ type: "text"; text: string }>;
      details: Record<string, unknown>;
    }>;
  }): void;
}

export interface ParentToolRuntime {
  context(): { ok: true; context: ToolContext } | { ok: false; error: string };
  call(name: OrchestratorToolName, params: unknown): Promise<ParentToolOutcome>;
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

  const context = ():
    | { ok: true; context: ToolContext }
    | { ok: false; error: string } => {
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

  const runtime: ParentToolRuntime = {
    context,

    async call(name, params) {
      const input = asParams(params);

      if (name === "orchestrator_start") {
        const blocked = ports.startEligible?.();
        if (blocked) return { ok: false, tool: name, code: "unavailable", text: blocked };
        if (!ports.start) {
          return {
            ok: false,
            tool: name,
            code: "unavailable",
            text: "No Orchestrator start service is bound.",
          };
        }
        const workspaces = Array.isArray(input.workspaces)
          ? input.workspaces
              .filter(
                (entry): entry is Record<string, unknown> =>
                  !!entry && typeof entry === "object" && !Array.isArray(entry),
              )
              .map((entry) => ({
                ...(typeof entry.id === "string" && entry.id.trim()
                  ? { id: entry.id.trim() }
                  : {}),
                path: typeof entry.path === "string" ? entry.path.trim() : "",
              }))
              .filter((entry) => entry.path.length > 0)
              .slice(0, 8)
          : undefined;
        const started = await ports.start({
          ...(typeof input.planPath === "string" ? { planPath: input.planPath } : {}),
          ...(typeof input.title === "string" ? { title: input.title } : {}),
          ...(workspaces && workspaces.length > 0 ? { workspaces } : {}),
          ...(Array.isArray(input.steps)
            ? {
                steps: input.steps.filter(
                  (entry): entry is string =>
                    typeof entry === "string" && entry.trim().length > 0,
                ),
              }
            : {}),
        });
        return started.ok
          ? { ok: true, tool: name, text: started.text, details: started.details }
          : { ok: false, tool: name, code: started.code, text: started.text };
      }

      if (name === "orchestrator_status" && ports.statusText) {
        const blocked = ports.eligible?.();
        if (blocked) return { ok: false, tool: name, code: "unavailable", text: blocked };
        return { ok: true, tool: name, text: ports.statusText(), details: {} };
      }

      if (
        (name === "orchestrator_dispatch" || name === "orchestrator_retry") &&
        ports.dispatch
      ) {
        const blocked = ports.eligible?.();
        if (blocked) return { ok: false, tool: name, code: "unavailable", text: blocked };
        const run = ports.run?.();
        let rowRef =
          typeof input.rowRef === "string" ? input.rowRef.trim() : undefined;
        if (!rowRef && typeof input.taskId === "string") {
          rowRef =
            input.taskId.replace(/^task-/, "").replace(/^row-/, "").trim() ||
            undefined;
        }
        if (name === "orchestrator_retry" && !rowRef) rowRef = run?.currentRef;
        const stored = run?.rows.find((row) => row.ref === rowRef);
        const instructions =
          typeof input.instructions === "string" && input.instructions.trim()
            ? input.instructions.trim()
            : name === "orchestrator_retry"
              ? (stored?.instruction ?? stored?.text ?? "")
              : "";
        if (!instructions) {
          return {
            ok: false,
            tool: name,
            code: "invalid",
            text:
              name === "orchestrator_dispatch"
                ? "orchestrator_dispatch requires a complete `instructions` string for the row."
                : "No stored instruction or row text is available to retry; pass `instructions`.",
          };
        }
        const dispatched = await ports.dispatch({
          ...(rowRef ? { rowRef } : {}),
          instructions,
          ...(typeof input.cwd === "string" && input.cwd.trim()
            ? { cwd: input.cwd.trim() }
            : {}),
        });
        return dispatched.ok
          ? { ok: true, tool: name, text: dispatched.text, details: dispatched.details }
          : { ok: false, tool: name, code: dispatched.code, text: dispatched.text };
      }

      const blocked = ports.eligible?.();
      if (blocked) return { ok: false, tool: name, code: "unavailable", text: blocked };
      const built = context();
      if (!built.ok) return { ok: false, tool: name, code: "unavailable", text: built.error };

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
        if (name === "orchestrator_retry" && decided.receipt.taskId) {
          if (!ports.dispatchNext) {
            return {
              ok: false,
              tool: name,
              code: "unavailable",
              text: `${decided.receipt.taskId} is queued again, but no child dispatcher is bound.`,
            };
          }
          const dispatched = await ports.dispatchNext(decided.receipt.taskId);
          return dispatched.ok
            ? {
                ok: true,
                tool: name,
                text: `${decided.receipt.summary}\n\n${dispatched.text}`,
                details: { ...decided.receipt, ...dispatched.details },
              }
            : {
                ok: false,
                tool: name,
                code: dispatched.code,
                text: `${decided.receipt.taskId} is queued again, but the dispatch failed: ${dispatched.text}`,
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

/** Tool names the parent may use; ordinary sessions never may. */
export const PARENT_TOOL_NAMES: readonly OrchestratorToolName[] = ORCHESTRATOR_TOOLS.map(
  (spec) => spec.name,
);

/** A bounded refusal for a session that must not orchestrate. */
export function parentToolRefusal(reason: string): ParentToolOutcome {
  return {
    ok: false,
    tool: "orchestrator_status",
    code: "unavailable",
    text: bounded(`Orchestration tools are unavailable: ${reason}`),
  };
}
