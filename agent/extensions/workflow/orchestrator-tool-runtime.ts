/**
 * Workflow Extension — parent tool adapters.
 *
 * `orchestrator-tools.ts` describes the four tools; this module validates the
 * model's input and calls the extension services. There is no event-sourced
 * fallback and no acceptance path: start binds the run, dispatch launches one
 * child, status reads the record and retry re-dispatches the stored
 * instruction.
 */

import {
  MAX_STEPS,
  ORCHESTRATOR_TOOLS,
  type OrchestratorToolName,
} from "./orchestrator-tools.ts";
import type { OrchestratorRun, OrchestratorRunStep } from "./orchestrator-run.ts";

export const TOOL_ADAPTER_SCHEMA_VERSION = 3 as const;
export const MAX_TOOL_TEXT = 2_000;

/** A model-supplied workspace declaration, before the resolver runs. */
export interface WorkspaceDeclarationInput {
  id?: string;
  path: string;
}

export interface ParentToolPorts {
  /** The model-driven run record, when one is bound. */
  run: () => OrchestratorRun | undefined;
  /** Render the current run and its last child reports. */
  statusText: () => string;
  /** Dispatch one row with the parent's complete instruction. */
  dispatch: (input: {
    rowRef?: string;
    instructions: string;
    cwd?: string;
  }) => Promise<
    | { ok: true; text: string; details: Record<string, unknown> }
    | { ok: false; code: string; text: string }
  >;
  /** Bind the run: validate roots, normalize steps, record the rows. */
  start: (input: {
    planPath?: string;
    title?: string;
    steps?: readonly OrchestratorRunStep[];
    workspaces?: readonly WorkspaceDeclarationInput[];
  }) => Promise<
    | { ok: true; text: string; details: Record<string, unknown> }
    | { ok: false; code: string; text: string }
  >;
  now?: () => number;
  /** Why this session may not orchestrate right now. */
  eligible?: () => string | undefined;
  /** Why starting is unavailable (works before a run is bound). */
  startEligible?: () => string | undefined;
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

function asWorkspaces(raw: unknown): WorkspaceDeclarationInput[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const workspaces: WorkspaceDeclarationInput[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const path = typeof record.path === "string" ? record.path.trim() : "";
    if (!path) continue;
    const id = typeof record.id === "string" ? record.id.trim() : "";
    workspaces.push({ ...(id ? { id } : {}), path });
  }
  return workspaces.length > 0 ? workspaces.slice(0, 8) : undefined;
}

/** Accept `string` or `{text, workspace?}`; drop entries without text. */
export function normalizeToolSteps(raw: unknown): OrchestratorRunStep[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const steps: OrchestratorRunStep[] = [];
  for (const entry of raw) {
    if (typeof entry === "string") {
      const text = entry.replace(/\s+/g, " ").trim();
      if (text) steps.push(text);
      continue;
    }
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const text =
      typeof record.text === "string" ? record.text.replace(/\s+/g, " ").trim() : "";
    if (!text) continue;
    const workspace =
      typeof record.workspace === "string" ? record.workspace.trim() : "";
    steps.push({ text, ...(workspace ? { workspace } : {}) });
  }
  return steps.length > 0 ? steps.slice(0, MAX_STEPS) : undefined;
}

export function createParentToolRuntime(ports: ParentToolPorts): ParentToolRuntime {
  const runtime: ParentToolRuntime = {
    async call(name, params) {
      const input = asParams(params);

      if (name === "orchestrator_start") {
        const blocked = ports.startEligible?.();
        if (blocked) return { ok: false, tool: name, code: "unavailable", text: blocked };
        const workspaces = asWorkspaces(input.workspaces);
        const steps = normalizeToolSteps(input.steps);
        const started = await ports.start({
          ...(typeof input.planPath === "string" ? { planPath: input.planPath } : {}),
          ...(typeof input.title === "string" ? { title: input.title } : {}),
          ...(workspaces ? { workspaces } : {}),
          ...(steps ? { steps } : {}),
        });
        return started.ok
          ? { ok: true, tool: name, text: started.text, details: started.details }
          : { ok: false, tool: name, code: started.code, text: started.text };
      }

      const blocked = ports.eligible?.();
      if (blocked) return { ok: false, tool: name, code: "unavailable", text: blocked };

      if (name === "orchestrator_status") {
        return { ok: true, tool: name, text: ports.statusText(), details: {} };
      }

      const run = ports.run();
      const rowRef =
        name === "orchestrator_retry"
          ? (typeof input.rowRef === "string" && input.rowRef.trim()) ||
            (typeof input.taskId === "string" &&
              input.taskId.replace(/^task-/, "").replace(/^row-/, "").trim()) ||
            run?.currentRef
          : typeof input.rowRef === "string"
            ? input.rowRef.trim()
            : undefined;
      const stored = run?.rows.find(
        (row) => row.ref === (typeof rowRef === "string" ? rowRef : ""),
      );
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
