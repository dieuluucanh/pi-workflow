/**
 * Workflow Extension — parent orchestration tools.
 *
 * The model sees exactly four tools: start, dispatch, status and retry. There
 * is no acceptance tool and no model-supplied evidence: the parent reads the
 * child's report, marks the row done with `workflow_todo` and dispatches the
 * next row. Verification is an ordinary command whose output is visible.
 *
 * Nothing here launches a session, calls a model or writes a file.
 */

export const TOOLS_SCHEMA_VERSION = 2 as const;
export const MAX_RECEIPT_TEXT = 1_000;
export const MAX_STATUS_ROWS = 100;
export const MAX_STEPS = 200;

// ── Tool descriptors ─────────────────────────────────────────────────

export const ORCHESTRATOR_TOOL_NAMES = [
  "orchestrator_start",
  "orchestrator_dispatch",
  "orchestrator_status",
  "orchestrator_retry",
] as const;

export type OrchestratorToolName = (typeof ORCHESTRATOR_TOOL_NAMES)[number];

export interface ToolSpec {
  name: OrchestratorToolName;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, unknown>;
    required: string[];
    additionalProperties: false;
  };
  bounded: true;
}

export const ORCHESTRATOR_TOOLS: readonly ToolSpec[] = [
  {
    name: "orchestrator_start",
    description:
      "Bind the approved plan or the agreed steps as mutable TODO rows, then wait for the parent to dispatch row by row. Pass one step per plan row in `steps` — a string, or {text, workspace} when the row targets a declared non-primary root. The model reads the plan; the extension does not compile it. Call only after the user agrees.",
    parameters: {
      type: "object",
      properties: {
        planPath: {
          type: "string",
          description: "Absolute approved plan path. Omit when using explicit standalone steps.",
        },
        title: { type: "string", description: "Short title for a standalone run." },
        steps: {
          type: "array",
          maxItems: MAX_STEPS,
          items: {
            oneOf: [
              { type: "string" },
              {
                type: "object",
                properties: {
                  text: { type: "string", description: "The step, in the plan's words." },
                  workspace: {
                    type: "string",
                    description:
                      "Declared workspace id for this row; omit for the primary root.",
                  },
                },
                required: ["text"],
                additionalProperties: false,
              },
            ],
          },
          description:
            "One step per plan row. A step names `workspace` only when it targets a non-primary root.",
        },
        workspaces: {
          type: "array",
          maxItems: 8,
          items: {
            type: "object",
            properties: {
              id: {
                type: "string",
                description:
                  "Short alias, e.g. W or D. Omit to let the extension assign one.",
              },
              path: {
                type: "string",
                description: "Absolute path, or a path relative to the session root.",
              },
            },
            required: ["path"],
            additionalProperties: false,
          },
          description:
            "Repository roots for a multi-repo plan. The session root is always resolved as a root; the extension validates every entry.",
        },
      },
      required: [],
      additionalProperties: false,
    },
    bounded: true,
  },
  {
    name: "orchestrator_dispatch",
    description:
      "Dispatch one run row to an in-process Build child with a comprehensive instruction derived from the plan. Omit rowRef to take the first pending row. The child owns its TODO list and verification; its report wakes the parent. Do not auto-accept anything.",
    parameters: {
      type: "object",
      properties: {
        rowRef: {
          type: "string",
          description: "Row ref (1..N). Omit to dispatch the first pending row.",
        },
        instructions: {
          type: "string",
          description:
            "The parent's complete instruction for this row: the plan step, its verification, and any correction from a previous attempt.",
        },
        cwd: {
          type: "string",
          description:
            "A declared workspace id or an absolute root inside the run's declared roots. Defaults to the row's workspace root.",
        },
      },
      required: ["instructions"],
      additionalProperties: false,
    },
    bounded: true,
  },
  {
    name: "orchestrator_status",
    description:
      "Read the current run: phase, rows, TODO completion, the active child phase and the last child report. Read-only.",
    parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
    bounded: true,
  },
  {
    name: "orchestrator_retry",
    description:
      "Re-dispatch the current or named row with its stored instruction and start a fresh in-process Build child for it. This is recovery, not acceptance: a compliant row is still completed through workflow_todo.",
    parameters: {
      type: "object",
      properties: {
        rowRef: {
          type: "string",
          description: "Row ref (1..N). Omit to retry the current row.",
        },
      },
      required: [],
      additionalProperties: false,
    },
    bounded: true,
  },
];
