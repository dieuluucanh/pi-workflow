/**
 * Workflow Extension — Plan Mode ↔ Build Mode
 *
 * Implements:
 * - plan/build modes with tool gating
 * - parallel exploration via subagent (pi --mode json)
 * - questionnaire (multi-choice, recommendation first, with Type-something editor)
 * - plan file to .pi/plans/*.md + inline Markdown handoff (no truncation, terminal scrollback)
 * - decision gate: 1 Execute / 2 Refine / 3 Freeform
 * - todo tool (persisted via details) + live widget/status tracking
 * - /rewind (tree nav) + /btw (queue note) + Escape abort (signal)
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, TextContent } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  CONFIG_DIR_NAME,
  getAgentDir,
  getMarkdownTheme,
  withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  Markdown,
  Text,
  Key,
  matchesKey,
  SelectList,
  ScrollView,
  Editor,
  type EditorTheme,
  type SelectItem,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import {
  isSafeCommand,
  extractTodoItems,
  extractPlanStepsFromMarkdown,
  markCompletedSteps,
  isPlanWritePath,
  getUtcDatePrefix,
  normalizePlanPath,
  isUserInteractionEntry,
  getHeaderText,
  formatTimestamp,
  shortId,
  type TodoItem,
} from "./utils.ts";
import {
  isGitRepo,
  isGitRepoSync,
  createCheckpoint,
  isDirty,
  createSafetySnapshot,
  restoreCode,
  findPersistedRef,
} from "./checkpoint.ts";

// ── Plannotator Bridge ───────────────────────────────────────────────
const PLANNOTATOR_REQUEST = "plannotator:request" as const;
const PLANNOTATOR_REVIEW_RESULT = "plannotator:review-result" as const;
const PLANNOTATOR_PLAN_APPROVED = "plannotator:plan-approved" as const;

// ── Helpers ──────────────────────────────────────────────────────────

function isAssistantMessage(m: AgentMessage): m is AssistantMessage {
  return m.role === "assistant" && Array.isArray((m as any).content);
}
function getTextContent(msg: AssistantMessage): string {
  return msg.content
    .filter((b): b is TextContent => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}
function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "plan"
  );
}

// ── Subagent runner (trimmed from examples/extensions/subagent) ─────

interface AgentConfig {
  name: string;
  description: string;
  tools?: string[];
  model?: string;
  systemPrompt: string;
  filePath: string;
}
function discoverAgents(cwd: string): AgentConfig[] {
  const agents: AgentConfig[] = [];
  const dirs = [path.join(getAgentDir(), "agents")];
  // also check .pi/agents up the tree (trusted projects only, but we load anyway)
  let cur = cwd;
  while (true) {
    const cand = path.join(cur, CONFIG_DIR_NAME, "agents");
    if (fs.existsSync(cand)) dirs.push(cand);
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!ent.name.endsWith(".md")) continue;
      const fp = path.join(dir, ent.name);
      try {
        const raw = fs.readFileSync(fp, "utf8");
        // simple frontmatter parse
        const fmMatch = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
        if (!fmMatch) continue;
        const fm = fmMatch[1];
        const body = fmMatch[2];
        const name = fm.match(/name:\s*(.+)/)?.[1].trim();
        const description = fm.match(/description:\s*(.+)/)?.[1].trim();
        if (!name || !description) continue;
        const toolsRaw = fm.match(/tools:\s*(.+)/)?.[1].trim();
        const model = fm.match(/model:\s*(.+)/)?.[1].trim();
        const tools = toolsRaw
          ? toolsRaw
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean)
          : undefined;
        agents.push({
          name,
          description,
          tools,
          model,
          systemPrompt: body,
          filePath: fp,
        });
      } catch (_e) {
        void _e;
      }
    }
  }
  // dedup by name (last wins)
  const map = new Map<string, AgentConfig>();
  for (const a of agents) map.set(a.name, a);
  return [...map.values()];
}

// Track active `pi --mode json` children spawned by runSingleAgent so they
// can be killed on session_shutdown and don't become orphans if VS Code
// closes the terminal or pi crashes (up to 4 concurrent via explore).
const activeSubagents = new Set<import("node:child_process").ChildProcess>();

async function runSingleAgent(
  cwd: string,
  agent: AgentConfig,
  task: string,
  signal?: AbortSignal,
): Promise<{ messages: any[]; stderr: string; exitCode: number; usage: any }> {
  const tmpDir = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "pi-subagent-"),
  );
  const promptPath = path.join(tmpDir, `prompt-${agent.name}.md`);
  if (agent.systemPrompt.trim()) {
    await withFileMutationQueue(promptPath, async () => {
      await fs.promises.writeFile(promptPath, agent.systemPrompt, {
        encoding: "utf-8",
        mode: 0o600,
      });
    });
  }
  // Actually pi --mode json -p --no-session ; ensure correct
  const cleanArgs = ["--mode", "json", "-p", "--no-session"];
  if (agent.model) cleanArgs.push("--model", agent.model);
  if (agent.tools?.length) cleanArgs.push("--tools", agent.tools.join(","));
  if (agent.systemPrompt.trim())
    cleanArgs.push("--append-system-prompt", promptPath);
  cleanArgs.push(`Task: ${task}`);

  // Resolve pi invocation
  const piCmd =
    process.argv[1] &&
    fs.existsSync(process.argv[1]) &&
    !process.argv[1].startsWith("/$bunfs/")
      ? process.execPath
      : "pi";
  return new Promise((resolve) => {
    const proc = spawn(
      piCmd,
      piCmd === "pi" ? cleanArgs : [process.argv[1], ...cleanArgs],
      {
        cwd,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    // Track for cleanup on session_shutdown — prevents orphaned subagents
    // if pi crashes while explore is running (up to 4 concurrent).
    activeSubagents.add(proc);
    let buffer = "";
    const messages: any[] = [];
    let stderr = "";
    const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };

    const onAbort = () => {
      try {
        proc.kill("SIGTERM");
      } catch (_e) {
        void _e;
      }
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }

    proc.stdout.on("data", (d) => {
      buffer += d.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const ev = JSON.parse(line);
          if (ev.type === "message_end" && ev.message) {
            messages.push(ev.message);
            const u = ev.message.usage;
            if (u) {
              usage.input += u.input || 0;
              usage.output += u.output || 0;
              usage.cacheRead += u.cacheRead || 0;
              usage.cacheWrite += u.cacheWrite || 0;
              usage.cost += u.cost?.total || 0;
            }
          }
        } catch (_e) {
          void _e;
        }
      }
    });
    proc.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    proc.on("close", (code) => {
      activeSubagents.delete(proc);
      if (signal) signal.removeEventListener("abort", onAbort);
      // cleanup tmp
      fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      resolve({ messages, stderr, exitCode: code ?? 0, usage });
    });
    proc.on("error", (err) => {
      activeSubagents.delete(proc);
      resolve({ messages, stderr: stderr + String(err), exitCode: 1, usage });
    });
  });
}

function getFinalOutput(messages: any[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "assistant") {
      for (const c of m.content || []) if (c.type === "text") return c.text;
    }
  }
  return "";
}

// ── Main Extension ───────────────────────────────────────────────────

export default function workflowExtension(pi: ExtensionAPI) {
  type WorkflowMode = "plan" | "build";
  let workflowMode: WorkflowMode | null = null;
  // overlay guard: true while any ctx.ui.custom overlay is active (questionnaire/rewind/decision gate)
  let overlayActive = false;
  let todoItems: TodoItem[] = [];
  let toolsBeforePlanMode: string[] | undefined;
  let currentPlanFile: string | undefined;
  let awaitingDecision = false;
  let lastHandoffAt: number | undefined;
  let handoffInFlight: Promise<void> | null = null;
  let btwNotes: string[] = [];

  // ── Plannotator bridge state ──────────────────────────────────
  let plannotatorActive = false;
  let lastReviewId: string | null = null;
  let plannotatorListenersRegistered = false;
  let currentSessionCtx: ExtensionContext | null = null;

  // ── Checkpoint (shadow bare-repo) state ────────────────────────
  const checkpoints = new Map<string, string>();
  let currentEntryId: string | undefined;
  let lastPromptHeader: string | undefined;
  const recentRestores = new Set<string>();

  // legacy aliases for bus sync / debug - keep in sync via setters (underscore to avoid unused lint)
  let _planModeEnabled = false;
  let _executionMode = false;
  function syncLegacyFlags() {
    _planModeEnabled = workflowMode === "plan";
    _executionMode = workflowMode === "build";
    void _planModeEnabled;
    void _executionMode;
  }

  const PLAN_MODE_TOOLS = [
    "read",
    "bash",
    "edit",
    "write",
    "grep",
    "find",
    "ls",
    "explore",
    "questionnaire",
    "workflow_todo",
  ];
  const NORMAL_MODE_TOOLS = [
    "read",
    "bash",
    "edit",
    "write",
    "grep",
    "find",
    "ls",
    "explore",
    "questionnaire",
    "workflow_todo",
  ];
  const PLAN_DISABLED = new Set(["edit", "write"]);

  function unique(arr: string[]): string[] {
    return [...new Set(arr)];
  }
  function getPlanModeTools(active: string[]): string[] {
    return unique([
      ...active.filter((n) => !PLAN_DISABLED.has(n)),
      ...PLAN_MODE_TOOLS,
    ]);
  }
  function getNormalTools(active: string[]): string[] {
    const managed = new Set([...PLAN_MODE_TOOLS, ...NORMAL_MODE_TOOLS]);
    return unique([
      ...NORMAL_MODE_TOOLS,
      ...active.filter((n) => !managed.has(n)),
    ]);
  }
  // alias for clarity: Build is the off-state of Plan
  const getBuildTools = getNormalTools;

  function updateStatus(ctx: ExtensionContext) {
    if (workflowMode === "build" && todoItems.length > 0) {
      const done = todoItems.filter((t) => t.completed).length;
      ctx.ui.setStatus(
        "workflow",
        ctx.ui.theme.fg("accent", `▶ build ${done}/${todoItems.length}`),
      );
    } else if (workflowMode === "plan") {
      const label = plannotatorActive
        ? "⏸ plan — reviewing in browser"
        : "⏸ plan";
      ctx.ui.setStatus("workflow", ctx.ui.theme.fg("warning", label));
    } else if (workflowMode === "build") {
      ctx.ui.setStatus("workflow", ctx.ui.theme.fg("accent", "▶ build"));
    } else {
      // initial null: treat as build for naming parity, but show nothing until first explicit set to avoid flash
      ctx.ui.setStatus("workflow", undefined);
    }
    if (workflowMode === "build" && todoItems.length > 0) {
      const lines = todoItems.map((item) => {
        if (item.completed)
          return (
            ctx.ui.theme.fg("success", "☑ ") +
            ctx.ui.theme.fg("muted", ctx.ui.theme.strikethrough(item.text))
          );
        return `${ctx.ui.theme.fg("dim", "☐ ")}${item.text}`;
      });
      ctx.ui.setWidget("workflow-todos", lines);
    } else if (workflowMode === "plan" && todoItems.length > 0) {
      const lines = todoItems.map(
        (item) =>
          `${ctx.ui.theme.fg("dim", "☐ ")}${ctx.ui.theme.fg("muted", item.text)}`,
      );
      ctx.ui.setWidget("workflow-todos", lines);
    } else {
      ctx.ui.setWidget("workflow-todos", undefined);
    }
  }

  function persistState() {
    syncLegacyFlags();
    pi.appendEntry("workflow", {
      // new canonical field
      mode: workflowMode,
      // legacy for backward compat (old sessions / external readers)
      enabled: workflowMode === "plan",
      todos: todoItems,
      executing: workflowMode === "build",
      toolsBeforePlanMode,
      planFile: currentPlanFile,
      awaitingDecision,
      awaitingDecisionAt: awaitingDecision ? lastHandoffAt : undefined,
    });
  }

  function setPlanMode(ctx: ExtensionContext) {
    if (workflowMode === "plan") {
      ctx.ui.notify(
        "Already in Plan mode — read-only. Press Tab or /build to switch to Build.",
        "info",
      );
      return;
    }
    workflowMode = "plan";
    syncLegacyFlags();
    if (toolsBeforePlanMode === undefined)
      toolsBeforePlanMode = pi.getActiveTools();
    pi.setActiveTools(getPlanModeTools(toolsBeforePlanMode));
    ctx.ui.notify(
      "Plan mode enabled — read-only. Explore + questionnaire loop, then write plan to .pi/plans/. Press Tab or /build to switch to Build.",
      "info",
    );
    try {
      fs.mkdirSync(path.join(ctx.cwd, CONFIG_DIR_NAME, "plans"), {
        recursive: true,
      });
    } catch (_e) {
      void _e;
    }
    updateStatus(ctx);
    persistState();
  }

  function setBuildMode(ctx: ExtensionContext) {
    if (workflowMode === "build") {
      ctx.ui.notify(
        "Already in Build mode — full access. Press Tab or /plan to switch to Plan.",
        "info",
      );
      return;
    }
    workflowMode = "build";
    syncLegacyFlags();
    pi.setActiveTools(
      toolsBeforePlanMode ?? getBuildTools(pi.getActiveTools()),
    );
    toolsBeforePlanMode = undefined;
    ctx.ui.notify(
      "Build mode — full access restored. Press Tab or /plan to switch to Plan.",
      "info",
    );
    updateStatus(ctx);
    persistState();
  }

  function cycleWorkflowMode(ctx: ExtensionContext) {
    if (workflowMode === "plan") setBuildMode(ctx);
    else setPlanMode(ctx);
  }

  // legacy alias for backward compat
  function togglePlanMode(ctx: ExtensionContext) {
    cycleWorkflowMode(ctx);
  }
  void togglePlanMode;

  function enterBuildModeFromPlan(ctx: ExtensionContext, planPath: string) {
    workflowMode = "build";
    syncLegacyFlags();
    currentPlanFile = planPath;
    pi.setActiveTools(
      toolsBeforePlanMode ?? getBuildTools(pi.getActiveTools()),
    );
    toolsBeforePlanMode = undefined;
    // populate todos from plan file if not already
    try {
      const content = fs.readFileSync(planPath, "utf8");
      const extracted = extractPlanStepsFromMarkdown(content);
      if (extracted.length > 0) {
        todoItems = extracted;
      }
    } catch (_e) {
      void _e;
    }
    updateStatus(ctx);
    persistState();
    ctx.ui.notify(
      `Build mode: ${todoItems.length} todos loaded from plan.`,
      "info",
    );
  }

  // ── Plannotator bridge helpers ─────────────────────────────────
  function getActiveCtx(): ExtensionContext | null {
    return currentSessionCtx;
  }

  function handlePlannotatorApprove(
    planFilePath: string,
    planContent: string,
    feedback: string | undefined,
    cwd: string | undefined,
  ) {
    const ctx = getActiveCtx();
    if (!ctx) return;
    if (workflowMode !== "plan") return;
    // Resolve plan path (plannotator gives cwd + relative path)
    let resolvedPlan = planFilePath;
    try {
      if (cwd && !path.isAbsolute(planFilePath)) {
        resolvedPlan = path.join(cwd, planFilePath);
      } else if (!path.isAbsolute(planFilePath)) {
        resolvedPlan = path.join(
          (ctx as any).cwd ?? cwd ?? process.cwd(),
          planFilePath,
        );
      }
    } catch (_e) {
      void _e;
    }
    // Ensure file exists (fallback write if agent only gave content)
    try {
      if (!fs.existsSync(resolvedPlan) && planContent) {
        fs.mkdirSync(path.dirname(resolvedPlan), { recursive: true });
        fs.writeFileSync(resolvedPlan, planContent, "utf8");
      }
    } catch (_e) {
      void _e;
    }
    awaitingDecision = false;
    lastHandoffAt = undefined;
    lastReviewId = null;
    enterBuildModeFromPlan(ctx as any, resolvedPlan);
    updateStatus(ctx as any);
    try {
      const remainingList = todoItems
        .map((t) => `${t.step}. ${t.text}`)
        .join("\n");
      const todoListText = todoItems
        .map((t, i) => `${i + 1}. ☐ ${t.text}`)
        .join("\n");
      const planTodoListMessage = {
        customType: "workflow-todo-list",
        content: `**Plan Steps (${todoItems.length}):**\n\n${todoListText}`,
        display: true,
      };
      const firstTodo = todoItems[0];
      const feedbackBlock = feedback ? `\n\nFeedback: ${feedback}` : "";
      const execMessage = `Execute the plan.\n\nRemaining steps:\n${remainingList}\n\nStart with: ${firstTodo ? firstTodo.text : (todoItems[0]?.text ?? "first step")}${feedbackBlock}\nAfter completing a step, include a [DONE:n] tag in your response.`;
      (pi as any).sendMessage?.(planTodoListMessage, { deliverAs: "followUp" });
      (pi as any).sendMessage?.(
        {
          customType: "workflow-plan-execute",
          content: execMessage,
          display: true,
        },
        { triggerTurn: true, deliverAs: "followUp" },
      );
    } catch (_e) {
      void _e;
    }
    try {
      pi.appendEntry("workflow-handoff-result", {
        at: Date.now(),
        choice: "execute",
        source: "plannotator",
        planPath: resolvedPlan,
      });
    } catch (_e) {
      void _e;
    }
  }

  function handlePlannotatorDeny(feedback: string) {
    const ctx = getActiveCtx();
    if (!ctx) return;
    awaitingDecision = false;
    lastHandoffAt = undefined;
    lastReviewId = null;
    persistState();
    try {
      const todoListText = todoItems
        .map((t, i) => `${i + 1}. ☐ ${t.text}`)
        .join("\n");
      const planTodoListMessage = {
        customType: "workflow-todo-list",
        content: `**Plan Steps (${todoItems.length}):**\n\n${todoListText}`,
        display: true,
      };
      (pi as any).sendMessage?.(planTodoListMessage, { deliverAs: "followUp" });
      if ((pi as any).sendUserMessage) {
        (pi as any).sendUserMessage(feedback || "Please revise the plan.", {
          deliverAs: "followUp",
        });
      } else {
        (pi as any).sendMessage?.(feedback || "Please revise the plan.", {
          deliverAs: "followUp",
        });
      }
    } catch (_e) {
      void _e;
    }
    try {
      pi.appendEntry("workflow-handoff-result", {
        at: Date.now(),
        choice: "refine",
        source: "plannotator",
        feedback,
      });
    } catch (_e) {
      void _e;
    }
  }

  function ensurePlannotatorListeners() {
    if (plannotatorListenersRegistered) return;
    try {
      const bus: any = (pi as any).events;
      if (!bus || typeof bus.on !== "function") return;
      // plan-approved (external executionMode) — direct handoff
      bus.on(PLANNOTATOR_PLAN_APPROVED, (event: any) => {
        try {
          handlePlannotatorApprove(
            event.planFilePath,
            event.planContent,
            event.feedback,
            event.cwd,
          );
        } catch (_e) {
          void _e;
        }
      });
      // review-result (plan-review shared API) — approve/deny from browser
      bus.on(PLANNOTATOR_REVIEW_RESULT, (event: any) => {
        try {
          if (!event || typeof event.reviewId !== "string") return;
          if (lastReviewId && event.reviewId !== lastReviewId) return;
          if (event.approved) {
            // For review-result we need to resolve planPath from currentPlanFile or lastReviewId
            const planPath = currentPlanFile || lastReviewId || "";
            // planContent may not be in event — read from file if possible
            let content = "";
            try {
              if (planPath && fs.existsSync(planPath))
                content = fs.readFileSync(planPath, "utf8");
            } catch (_e) {
              void _e;
            }
            handlePlannotatorApprove(
              planPath,
              content,
              event.feedback,
              (getActiveCtx() as any)?.cwd,
            );
          } else {
            handlePlannotatorDeny(event.feedback || "Plan needs revision.");
          }
        } catch (_e) {
          void _e;
        }
      });
      plannotatorListenersRegistered = true;
      plannotatorActive = true;
      const ctx = getActiveCtx();
      if (ctx) updateStatus(ctx as any);
    } catch (_e) {
      void _e;
    }
  }

  // pi-code package already owns --plan flag; we only add --workflow-plan alias to avoid duplicate-flag crash
  try {
    pi.registerFlag("workflow-plan", {
      description: "Start in workflow plan mode (alias for --plan)",
      type: "boolean",
      default: false,
    } as any);
  } catch (_e) {
    void _e;
  }

  try {
    pi.registerCommand("plan", {
      description: "Enable Plan mode (read-only, idempotent)",
      handler: async (_args, ctx) => setPlanMode(ctx as any),
    });
  } catch {
    // pi-code already owns /plan — add /workflow as our alias
    pi.registerCommand("workflow", {
      description: "Enable Plan mode (alias for /plan)",
      handler: async (_args, ctx) => setPlanMode(ctx as any),
    });
  }

  try {
    pi.registerCommand("build", {
      description: "Enable Build mode (full access, idempotent)",
      handler: async (_args, ctx) => setBuildMode(ctx as any),
    });
  } catch (_e) {
    void _e;
  }

  try {
    pi.registerShortcut(Key.ctrlAlt("p"), {
      description: "Toggle plan/build mode",
      handler: async (ctx: any) => {
        if (overlayActive) return;
        cycleWorkflowMode(ctx as any);
      },
    });
  } catch (_e) {
    void _e;
  }

  // Tab to toggle plan/build (context-aware: not when overlay active) — single registration to avoid duplicate-conflict warning
  try {
    pi.registerShortcut(
      "tab" as any,
      {
        description: "Toggle plan/build mode (Tab)",
        handler: async (ctx: any) => {
          if (overlayActive) return;
          cycleWorkflowMode(ctx as any);
        },
      } as any,
    );
  } catch (_e) {
    void _e;
  }

  // ── Todo tool (persisted via details) ────────────────────────────

  interface TodoDetails {
    action: string;
    todos: TodoItem[];
    nextStep: number;
    error?: string;
  }

  pi.registerTool({
    name: "workflow_todo",
    label: "Workflow Todo",
    description:
      "Manage todo list for plan execution. Actions: list, add (text), toggle (step), clear. Before execute, create todos from plan steps.",
    parameters: Type.Object({
      action: StringEnum(["list", "add", "toggle", "clear"] as const),
      text: Type.Optional(Type.String({ description: "Todo text (for add)" })),
      step: Type.Optional(
        Type.Number({ description: "Step number (for toggle)" }),
      ),
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      switch (params.action) {
        case "list":
          return {
            content: [
              {
                type: "text",
                text: todoItems.length
                  ? todoItems
                      .map(
                        (t) =>
                          `[${t.completed ? "x" : " "}] ${t.step}. ${t.text}`,
                      )
                      .join("\n")
                  : "No todos",
              },
            ],
            details: {
              action: "list",
              todos: [...todoItems],
              nextStep: todoItems.length + 1,
            } as TodoDetails,
          };
        case "add": {
          if (!params.text)
            return {
              content: [{ type: "text", text: "Error: text required" }],
              details: {
                action: "add",
                todos: [...todoItems],
                nextStep: todoItems.length + 1,
                error: "text required",
              } as TodoDetails,
            };
          const item: TodoItem = {
            step: todoItems.length + 1,
            text: params.text.slice(0, 80),
            completed: false,
          };
          todoItems.push(item);
          return {
            content: [
              { type: "text", text: `Added ${item.step}. ${item.text}` },
            ],
            details: {
              action: "add",
              todos: [...todoItems],
              nextStep: todoItems.length + 1,
            } as TodoDetails,
          };
        }
        case "toggle": {
          if (params.step === undefined)
            return {
              content: [{ type: "text", text: "Error: step required" }],
              details: {
                action: "toggle",
                todos: [...todoItems],
                nextStep: todoItems.length + 1,
                error: "step required",
              } as TodoDetails,
            };
          const it = todoItems.find((t) => t.step === params.step);
          if (!it)
            return {
              content: [
                { type: "text", text: `Step ${params.step} not found` },
              ],
              details: {
                action: "toggle",
                todos: [...todoItems],
                nextStep: todoItems.length + 1,
                error: "not found",
              } as TodoDetails,
            };
          it.completed = !it.completed;
          return {
            content: [
              {
                type: "text",
                text: `${it.step}. ${it.text} ${it.completed ? "done" : "pending"}`,
              },
            ],
            details: {
              action: "toggle",
              todos: [...todoItems],
              nextStep: todoItems.length + 1,
            } as TodoDetails,
          };
        }
        case "clear": {
          const c = todoItems.length;
          todoItems = [];
          return {
            content: [{ type: "text", text: `Cleared ${c} todos` }],
            details: { action: "clear", todos: [], nextStep: 1 } as TodoDetails,
          };
        }
        default:
          return {
            content: [
              { type: "text", text: `Unknown action ${params.action}` },
            ],
            details: {
              action: "list",
              todos: [...todoItems],
              nextStep: todoItems.length + 1,
              error: "unknown",
            } as TodoDetails,
          };
      }
    },
  });

  pi.registerCommand("todos", {
    description: "Show workflow todos",
    handler: async (_args, ctx) => {
      const list = todoItems.length
        ? todoItems
            .map((t, i) => `${i + 1}. ${t.completed ? "✓" : "○"} ${t.text}`)
            .join("\n")
        : "No todos.";
      ctx.ui.notify(`Todos (${todoItems.length}):\n${list}`, "info");
    },
  });

  // ── Explore tool (parallel subagents) ────────────────────────────

  pi.registerTool({
    name: "explore",
    label: "Explore",
    description:
      "Explore codebase in parallel sub-agents (read-only). Single: {agent,task} Parallel: {tasks:[{agent,task,cwd?}]}. Use scout for fast recon.",
    parameters: Type.Object({
      agent: Type.Optional(
        Type.String({ description: "Agent name for single mode" }),
      ),
      task: Type.Optional(Type.String({ description: "Task for single mode" })),
      tasks: Type.Optional(
        Type.Array(
          Type.Object({
            agent: Type.String(),
            task: Type.String(),
            cwd: Type.Optional(Type.String()),
          }),
        ),
      ),
      cwd: Type.Optional(
        Type.String({ description: "Working directory override" }),
      ),
    }),
    async execute(_id, params, signal, onUpdate, ctx) {
      const cwd = (params.cwd as string | undefined) ?? ctx.cwd;
      const agents = discoverAgents(cwd);

      let jobs: { agent: string; task: string; cwd?: string }[] = [];
      if (
        params.tasks &&
        Array.isArray(params.tasks) &&
        params.tasks.length > 0
      ) {
        jobs = params.tasks as any;
      } else if (params.agent && params.task) {
        jobs = [
          {
            agent: params.agent as string,
            task: params.task as string,
            cwd: cwd,
          },
        ];
      } else {
        return {
          content: [
            {
              type: "text",
              text: "Error: provide {agent,task} or {tasks:[...]}",
            },
          ],
          details: {},
        };
      }

      if (jobs.length > 8)
        return {
          content: [{ type: "text", text: "Error: max 8 tasks" }],
          details: {},
        };

      // concurrency 4
      const MAX_CONC = 4;
      const results: any[] = new Array(jobs.length);
      let next = 0;
      const workers = Array.from(
        { length: Math.min(MAX_CONC, jobs.length) },
        () => null,
      ).map(async () => {
        while (true) {
          const idx = next++;
          if (idx >= jobs.length) return undefined;
          const job = jobs[idx];
          const ag = agents.find((a) => a.name === job.agent);
          if (!ag) {
            results[idx] = {
              agent: job.agent,
              task: job.task,
              error: `Unknown agent "${job.agent}". Available: ${agents.map((a) => a.name).join(", ") || "none"}`,
            };
            continue;
          }
          try {
            const res = await runSingleAgent(
              job.cwd ?? cwd,
              ag,
              job.task,
              signal,
            );
            if (signal?.aborted) {
              results[idx] = {
                agent: job.agent,
                task: job.task,
                error: "Aborted (Escape)",
              };
            } else if (res.exitCode !== 0 && !getFinalOutput(res.messages)) {
              results[idx] = {
                agent: job.agent,
                task: job.task,
                error: res.stderr.slice(0, 2000) || `exit ${res.exitCode}`,
                usage: res.usage,
              };
            } else {
              const out = getFinalOutput(res.messages) || "(no output)";
              results[idx] = {
                agent: job.agent,
                task: job.task,
                output: out.slice(0, 50000),
                usage: res.usage,
              };
            }
          } catch (e: any) {
            results[idx] = {
              agent: job.agent,
              task: job.task,
              error: String(e?.message || e),
            };
          }
          if (onUpdate)
            onUpdate({
              content: [
                {
                  type: "text",
                  text: `Explore ${idx + 1}/${jobs.length} done`,
                },
              ],
              details: { jobs, results: results.filter(Boolean) },
            } as any);
        }
      });
      await Promise.all(workers);

      const summary = results
        .map((r, i) => {
          const hdr = `### [${i + 1}] ${r.agent}: ${r.task.slice(0, 80)}`;
          if (r.error) return `${hdr}\nERROR: ${r.error}`;
          return `${hdr}\n${r.output}`;
        })
        .join("\n\n---\n\n");

      return {
        content: [{ type: "text", text: summary }],
        details: { mode: jobs.length === 1 ? "single" : "parallel", results },
      };
    },
  });

  // ── Questionnaire tool ───────────────────────────────────────────

  const QuestionOptionSchema = Type.Object({
    label: Type.String({ description: "Display label" }),
    description: Type.Optional(
      Type.String({ description: "Optional description" }),
    ),
  });
  const QuestionSchema = Type.Object({
    question: Type.String({ description: "The question to ask" }),
    header: Type.Optional(
      Type.String({ description: "Short label for tab, e.g. Scope" }),
    ),
    options: Type.Array(QuestionOptionSchema, {
      description: "Options (first = recommended)",
    }),
  });

  pi.registerTool({
    name: "questionnaire",
    label: "Questionnaire",
    description:
      'Ask user 1-4 multiple-choice questions at once. Each has header, question, options (first = recommendation). Loops until clear. Use in plan mode. Tool appends "Type something." automatically - do not include freeform in options.',
    parameters: Type.Object({
      questions: Type.Optional(Type.Array(QuestionSchema)),
      question: Type.Optional(Type.String()),
      header: Type.Optional(Type.String()),
      options: Type.Optional(Type.Array(QuestionOptionSchema)),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      if (ctx.mode !== "tui")
        return {
          content: [{ type: "text", text: "UI not available" }],
          details: {},
        };

      // Normalize to questions[] array for unified UI (supports both single-question and multi-question calls)
      let questions: {
        question: string;
        header?: string;
        options: { label: string; description?: string }[];
      }[] = [];
      if (
        params.questions &&
        Array.isArray(params.questions) &&
        params.questions.length > 0
      ) {
        questions = params.questions as any;
      } else if (
        params.question &&
        params.options &&
        Array.isArray(params.options)
      ) {
        questions = [
          {
            question: params.question as string,
            header: params.header as string | undefined,
            options: params.options as any,
          },
        ];
      } else {
        return {
          content: [
            {
              type: "text",
              text: "Error: provide questions[] or {question, options}",
            },
          ],
          details: {},
        };
      }

      // Validate
      for (const q of questions)
        if (!q.options || q.options.length < 2)
          return {
            content: [
              {
                type: "text",
                text: `Error: question "${q.question.slice(0, 40)}" needs >=2 options`,
              },
            ],
            details: {},
          };
      if (questions.length > 4)
        return {
          content: [{ type: "text", text: "Error: max 4 questions at once" }],
          details: {},
        };

      // Build items for UI - reuse questionnaire pattern: tabs
      type DisplayOpt = {
        label: string;
        description?: string;
        isOther?: boolean;
      };
      const isMulti = questions.length > 1;

      overlayActive = true;
      let result: {
        answers: {
          question: string;
          header?: string;
          answer: string;
          wasCustom: boolean;
          index?: number;
        }[];
        cancelled: boolean;
      } | null;
      try {
        result = await ctx.ui.custom<{
          answers: {
            question: string;
            header?: string;
            answer: string;
            wasCustom: boolean;
            index?: number;
          }[];
          cancelled: boolean;
        } | null>((tui, theme, _kb, done) => {
          let currentTab = 0;
          let optionIndex = 0;
          let inputMode = false;
          let inputQuestionIdx: number | null = null;
          let cached: string[] | undefined;
          const answers = new Map<
            number,
            { answer: string; wasCustom: boolean; index?: number }
          >();

          const editorTheme: EditorTheme = {
            borderColor: (s) => theme.fg("accent", s),
            selectList: {
              selectedPrefix: (t) => theme.fg("accent", t),
              selectedText: (t) => theme.fg("accent", t),
              description: (t) => theme.fg("muted", t),
              scrollInfo: (t) => theme.fg("dim", t),
              noMatch: (t) => theme.fg("warning", t),
            },
          };
          const editor = new Editor(tui, editorTheme);
          // ── Shared freeform helpers (single source of truth) ──
          const FREEFORM_ALIASES = new Set([
            "type something",
            "type something else",
            "other",
            "other (please specify)",
            "other please specify",
          ]);
          const normalizeFreeform = (s: string) =>
            s.toLowerCase().trim().replace(/\.$/, "").replace(/\s+/g, " ");
          function buildDisplayOptions(
            raw: { label: string; description?: string }[],
          ): DisplayOpt[] {
            const filtered: DisplayOpt[] = (raw as DisplayOpt[]).filter(
              (o) => !FREEFORM_ALIASES.has(normalizeFreeform(o.label)),
            );
            filtered.push({ label: "Type something.", isOther: true });
            return filtered;
          }
          function isCustomSelected(
            prev: { wasCustom: boolean; index?: number } | undefined,
            opt: DisplayOpt | undefined,
            idx: number,
          ): boolean {
            if (!prev) return false;
            if (prev.wasCustom && opt?.isOther) return true;
            return prev.index === idx + 1;
          }
          editor.onSubmit = (value) => {
            if (inputQuestionIdx === null) return;
            const trimmed = value.trim() || "(no response)";
            const freeformIndex = buildDisplayOptions(
              questions[inputQuestionIdx]?.options.map((o) => ({
                label: o.label,
                description: o.description,
              })) ?? [],
            ).length; // 1-based last row
            answers.set(inputQuestionIdx, {
              answer: trimmed,
              wasCustom: true,
              index: freeformIndex,
            });
            inputMode = false;
            inputQuestionIdx = null;
            editor.setText("");
            advanceAfter();
          };

          function currentQ() {
            return questions[currentTab];
          }
          function currentOpts(): DisplayOpt[] {
            const q = currentQ();
            if (!q) return [];
            return buildDisplayOptions(
              q.options.map((o) => ({
                label: o.label,
                description: o.description,
              })),
            );
          }
          function optsForTab(tab: number): DisplayOpt[] {
            const q = questions[tab];
            if (!q) return [];
            return buildDisplayOptions(
              q.options.map((o) => ({
                label: o.label,
                description: o.description,
              })),
            );
          }
          function restoreOptionIndex(tab: number) {
            if (tab >= questions.length) {
              optionIndex = 0;
              return;
            }
            const prev = answers.get(tab);
            // wasCustom is authoritative for freeform (resilient to option count changes)
            if (prev?.wasCustom) {
              optionIndex = Math.max(0, optsForTab(tab).length - 1);
              return;
            }
            if (prev?.index) {
              const len = optsForTab(tab).length;
              optionIndex = Math.max(0, Math.min(prev.index - 1, len - 1));
            } else {
              optionIndex = 0;
            }
          }
          function allAnswered() {
            return questions.every((_, i) => answers.has(i));
          }
          function advanceAfter() {
            if (!isMulti) {
              submit(false);
              return;
            }
            if (currentTab < questions.length - 1) currentTab++;
            else currentTab = questions.length; // submit tab
            restoreOptionIndex(currentTab);
            cached = undefined;
            tui.requestRender();
          }
          function submit(cancelled: boolean) {
            if (cancelled) {
              done({ answers: [], cancelled: true });
              return;
            }
            const arr = questions.map((q, i) => {
              const a = answers.get(i);
              return {
                question: q.question,
                header: q.header,
                answer: a ? a.answer : "",
                wasCustom: a ? a.wasCustom : false,
                index: a?.index,
              };
            });
            done({ answers: arr, cancelled: false });
          }
          function refresh() {
            cached = undefined;
            tui.requestRender();
          }

          const handleInput = (data: string) => {
            if (signal?.aborted) {
              done(null);
              return;
            }
            if (inputMode) {
              if (matchesKey(data, Key.escape)) {
                inputMode = false;
                inputQuestionIdx = null;
                editor.setText("");
                refresh();
                return;
              }
              editor.handleInput(data);
              refresh();
              return;
            }
            const q = currentQ();
            const opts = currentOpts();
            if (isMulti) {
              if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
                currentTab = (currentTab + 1) % (questions.length + 1);
                restoreOptionIndex(currentTab);
                refresh();
                return;
              }
              if (
                matchesKey(data, Key.shift("tab")) ||
                matchesKey(data, Key.left)
              ) {
                currentTab =
                  (currentTab - 1 + questions.length + 1) %
                  (questions.length + 1);
                restoreOptionIndex(currentTab);
                refresh();
                return;
              }
            }
            if (currentTab === questions.length) {
              if (matchesKey(data, Key.enter) && allAnswered()) {
                submit(false);
              } else if (matchesKey(data, Key.escape)) {
                submit(true);
              }
              return;
            }
            if (matchesKey(data, Key.up)) {
              optionIndex = Math.max(0, optionIndex - 1);
              refresh();
              return;
            }
            if (matchesKey(data, Key.down)) {
              optionIndex = Math.min(opts.length - 1, optionIndex + 1);
              refresh();
              return;
            }
            if (matchesKey(data, Key.enter) && q) {
              const opt = opts[optionIndex];
              if (opt.isOther) {
                inputMode = true;
                inputQuestionIdx = currentTab;
                const prev = answers.get(currentTab);
                editor.setText(prev?.wasCustom ? prev.answer : "");
                refresh();
                return;
              }
              answers.set(currentTab, {
                answer: opt.label,
                wasCustom: false,
                index: optionIndex + 1,
              });
              advanceAfter();
              return;
            }
            if (matchesKey(data, Key.escape)) {
              submit(true);
            }
          };

          const render = (width: number): string[] => {
            if (cached) return cached;
            const lines: string[] = [];
            const W = Math.max(1, width);
            const q = currentQ();
            const opts = currentOpts();
            const wrap = (s: string) => {
              const out: string[] = [];
              for (const line of s.split("\n")) {
                out.push(...wrapTextWithAnsi(line, W));
              }
              return out;
            };
            const wrapWithPrefix = (prefix: string, text: string) => {
              const pw = visibleWidth(prefix);
              if (pw >= W) return wrap(prefix + text);
              const wrapped = wrapTextWithAnsi(text, W - pw);
              const cont = " ".repeat(pw);
              return wrapped.map(
                (ln, idx) => `${idx === 0 ? prefix : cont}${ln}`,
              );
            };
            lines.push(theme.fg("accent", "─".repeat(W)));
            if (isMulti) {
              const tabs: string[] = [];
              for (let i = 0; i < questions.length; i++) {
                const active = i === currentTab;
                const answered = answers.has(i);
                const lbl = questions[i].header || `Q${i + 1}`;
                const box = answered ? "■" : "□";
                const color = answered ? "success" : "muted";
                const text = ` ${box} ${lbl} `;
                const styled = active
                  ? theme.bg("selectedBg", theme.fg("text", text))
                  : theme.fg(color as any, text);
                tabs.push(`${styled} `);
              }
              const canSubmit = allAnswered();
              const isSubmit = currentTab === questions.length;
              const submitText = " ✓ Submit ";
              const sStyled = isSubmit
                ? theme.bg("selectedBg", theme.fg("text", submitText))
                : theme.fg(canSubmit ? "success" : "dim", submitText);
              tabs.push(`${sStyled}`);
              // naive join wrapped
              lines.push(" " + tabs.join(""));
              lines.push("");
            }
            if (inputMode && q) {
              lines.push(...wrap(" " + theme.fg("text", q.question)));
              lines.push("");
              for (let i = 0; i < opts.length; i++) {
                const opt = opts[i];
                const sel = i === optionIndex;
                const isOther = !!opt.isOther;
                const prefix = sel ? theme.fg("accent", "> ") : "  ";
                const label = `${i + 1}. ${opt.label}${isOther && inputMode ? " ✎" : ""}`;
                const color = sel || (isOther && inputMode) ? "accent" : "text";
                lines.push(...wrap(prefix + theme.fg(color as any, label)));
                if (opt.description)
                  lines.push(
                    ...wrap("     " + theme.fg("muted", opt.description)),
                  );
              }
              lines.push("");
              lines.push(...wrap(" " + theme.fg("muted", "Your answer:")));
              for (const l of editor.render(Math.max(1, W - 2)))
                lines.push(" " + l);
              lines.push("");
              lines.push(
                ...wrap(
                  " " + theme.fg("dim", "Enter to submit • Esc to go back"),
                ),
              );
            } else if (currentTab === questions.length) {
              lines.push(
                ...wrap(
                  " " + theme.fg("accent", theme.bold("Ready to submit")),
                ),
              );
              lines.push("");
              for (let i = 0; i < questions.length; i++) {
                const a = answers.get(i);
                if (a) {
                  const prefix = a.wasCustom ? "(wrote) " : "";
                  lines.push(
                    ...wrap(
                      "  " +
                        theme.fg(
                          "muted",
                          `${questions[i].header || `Q${i + 1}`}: `,
                        ) +
                        theme.fg("text", prefix + a.answer),
                    ),
                  );
                }
              }
              lines.push("");
              if (allAnswered())
                lines.push(
                  ...wrap(" " + theme.fg("success", "Press Enter to submit")),
                );
              else {
                const missing = questions
                  .filter((_, i) => !answers.has(i))
                  .map((q, idx) => q.header || `Q${idx + 1}`)
                  .join(", ");
                lines.push(
                  ...wrap(" " + theme.fg("warning", `Unanswered: ${missing}`)),
                );
              }
            } else if (q) {
              lines.push(...wrap(" " + theme.fg("text", q.question)));
              lines.push("");
              const prevAns = answers.get(currentTab);
              for (let i = 0; i < opts.length; i++) {
                const opt = opts[i];
                const sel = i === optionIndex;
                const isPrevSelected = isCustomSelected(prevAns, opt, i);
                const isOther = !!opt.isOther;
                const prefix = sel
                  ? theme.fg("accent", "> ")
                  : isPrevSelected
                    ? theme.fg("success", "✓ ")
                    : "  ";
                const label = `${i + 1}. ${opt.label}${isOther && inputMode ? " ✎" : ""}`;
                const color = sel
                  ? "accent"
                  : isPrevSelected
                    ? "success"
                    : isOther && inputMode
                      ? "accent"
                      : "text";
                lines.push(
                  ...wrapWithPrefix(prefix, theme.fg(color as any, label)),
                );
                if (opt.description)
                  lines.push(
                    ...wrapWithPrefix(
                      "     ",
                      theme.fg("muted", opt.description),
                    ),
                  );
                // Show previously typed custom answer inline below the Type something. row
                if (isOther && prevAns?.wasCustom) {
                  const answerLabel = theme.fg("muted", "↳ Your answer: ");
                  const answerVal = theme.fg("text", `"${prevAns.answer}"`);
                  // Handle multiline answers: split and wrap each segment
                  const answerLines = prevAns.answer.split("\n");
                  if (answerLines.length === 1) {
                    lines.push(
                      ...wrapWithPrefix("    ", answerLabel + answerVal),
                    );
                  } else {
                    lines.push(
                      ...wrapWithPrefix(
                        "    ",
                        answerLabel + theme.fg("text", `"${answerLines[0]}`),
                      ),
                    );
                    for (let ai = 1; ai < answerLines.length; ai++) {
                      const seg = theme.fg(
                        "text",
                        answerLines[ai] +
                          (ai === answerLines.length - 1 ? `"` : ""),
                      );
                      lines.push(...wrapWithPrefix("    ", seg));
                    }
                  }
                }
              }
            }
            lines.push("");
            if (!inputMode) {
              const help = isMulti
                ? "Tab/←→ navigate • ↑↓ select • Enter confirm • Esc cancel"
                : "↑↓ navigate • Enter select • Esc cancel";
              lines.push(...wrap(" " + theme.fg("dim", help)));
            }
            lines.push(theme.fg("accent", "─".repeat(W)));
            cached = lines;
            return lines;
          };

          return {
            render,
            invalidate: () => {
              cached = undefined;
            },
            handleInput,
          };
        });
      } finally {
        overlayActive = false;
      }

      if (!result || result.cancelled) {
        return {
          content: [{ type: "text", text: "User cancelled questionnaire" }],
          details: { questions, answers: [], cancelled: true },
        };
      }
      const summary = result.answers
        .map(
          (a) =>
            `${a.header || a.question.slice(0, 30)}: ${a.wasCustom ? `wrote "${a.answer}"` : `selected "${a.answer}"`}`,
        )
        .join("; ");
      return {
        content: [{ type: "text", text: `Answers: ${summary}` }],
        details: { questions, answers: result.answers, cancelled: false },
      };
    },
  });

  // ── /rewind and /btw ─────────────────────────────────────────────

  pi.registerCommand("rewind", {
    description:
      "Rewind to previous user checkpoint (restores messages + tracked files)",
    handler: async (_args, ctx) => {
      const branch: any[] = ctx.sessionManager.getBranch();
      if (!branch || branch.length === 0) {
        ctx.ui.notify("No history to rewind", "info");
        return;
      }

      // Build user-interaction checkpoints: filtered, newest-first, cap 20
      let userEntries: any[] = branch.filter((e: any) =>
        isUserInteractionEntry(e),
      );
      // Fallback to tree labels if branch has few user entries (orphan labels)
      if (userEntries.length < 2) {
        try {
          const tree: any = (ctx.sessionManager as any).getTree?.();
          if (Array.isArray(tree)) {
            const walk = (nodes: any[]) => {
              for (const n of nodes) {
                if (n?.entry && n.entry.type === "label") {
                  // Synthetic entry for orphan label
                  userEntries.push(n.entry);
                }
                if (Array.isArray(n?.children)) walk(n.children);
              }
            };
            walk(tree);
          }
        } catch (_e) {
          void _e;
        }
      }
      // Deduplicate btw synthetic entries by note+timestamp proximity (2s)
      const seenBtw = new Map<string, number>();
      const deduped: any[] = [];
      for (const e of userEntries) {
        if (e.type === "custom" && e.customType === "workflow-btw") {
          const key = String(e.data?.note ?? "").trim();
          const ts = e.timestamp ? new Date(e.timestamp).getTime() : 0;
          const prev = seenBtw.get(key);
          if (prev !== undefined && Math.abs(prev - ts) < 2000) continue;
          seenBtw.set(key, ts);
        }
        if (e.type === "custom_message" && e.customType === "workflow-btw") {
          const key = String(e.content ?? "").trim();
          const ts = e.timestamp ? new Date(e.timestamp).getTime() : 0;
          const prev = seenBtw.get(key);
          if (prev !== undefined && Math.abs(prev - ts) < 2000) continue;
          seenBtw.set(key, ts);
        }
        deduped.push(e);
      }
      userEntries = deduped;

      // Merge label entries that target an existing user entry id: fold into that row's description later, avoid duplicate row
      const labelByTarget = new Map<string, any>();
      for (const e of branch as any[])
        if (e.type === "label" && e.targetId) labelByTarget.set(e.targetId, e);
      const userIds = new Set(userEntries.map((e: any) => e.id));
      const visibleLabels: any[] = [];
      for (const e of branch as any[]) {
        if (e.type === "label" && !userIds.has(e.targetId))
          visibleLabels.push(e);
      }
      // Combine and order newest-first
      let combined: any[] = [...userEntries, ...visibleLabels];
      // Reverse chronological: newest first based on branch order; branch is root->leaf, so reverse
      combined = combined
        .slice()
        .sort((a: any, b: any) => {
          const ai = branch.indexOf(a);
          const bi = branch.indexOf(b);
          // Items not in branch (orphan labels) go last; otherwise sort by branch position descending
          if (ai === -1 && bi === -1) return 0;
          if (ai === -1) return 1;
          if (bi === -1) return -1;
          return bi - ai;
        })
        .slice(0, 20);
      if (combined.length < 2) {
        ctx.ui.notify(
          "No checkpoints yet — need at least one user prompt",
          "info",
        );
        return;
      }
      const items: SelectItem[] = combined.map((e: any) => {
        const id =
          e.id ||
          e.entryId ||
          e.targetId ||
          String(e.timestamp ?? Math.random());
        const header = getHeaderText(e);
        const label = header ? header : `user ${shortId(id)}`;
        const ts = formatTimestamp(e.timestamp);
        const hasSnap = checkpoints.has(id) || !!findPersistedRef(branch, id);
        const extra = hasSnap ? "" : " · [no snapshot]";
        const labelSuffix = labelByTarget.get(id)
          ? ` · label: ${String(labelByTarget.get(id).label ?? "").slice(0, 20)}`
          : "";
        return {
          value: id,
          label,
          description: `${ts ? ts + " · " : ""}${shortId(id)}${extra}${labelSuffix}`,
        };
      });

      overlayActive = true;
      let choice: string | null;
      try {
        choice = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
          const list = new SelectList(items, Math.min(items.length, 10), {
            selectedPrefix: (t) => theme.fg("accent", t),
            selectedText: (t) => theme.fg("accent", t),
            description: (t) => theme.fg("muted", t),
            scrollInfo: (t) => theme.fg("dim", t),
            noMatch: (t) => theme.fg("warning", t),
          });
          const container = new Container();
          container.addChild(
            new Text(
              theme.fg("accent", theme.bold(" Rewind — user checkpoints ")),
              1,
              0,
            ),
          );
          container.addChild(
            new Text(
              theme.fg(
                "dim",
                ` Showing user prompts only (tools hidden) • ${items.length} • Restores messages + tracked files `,
              ),
              1,
              0,
            ),
          );
          (list as any).onSelect = (it: SelectItem) => done(it.value);
          (list as any).onCancel = () => done(null);
          container.addChild(list as any);
          container.addChild(
            new Text(
              theme.fg("dim", " ↑↓ navigate • enter to rewind • esc cancel "),
              1,
              0,
            ),
          );
          return {
            render: (w) => container.render(w),
            invalidate: () => container.invalidate(),
            handleInput: (d) => {
              (list as any).handleInput(d);
              tui.requestRender();
            },
          };
        });
      } finally {
        overlayActive = false;
      }

      if (!choice) {
        ctx.ui.notify("Rewind cancelled", "info");
        return;
      }
      // Always Both: messages + tracked files atomically
      const cwd = (ctx as any).cwd as string;
      try {
        const isRepo = isGitRepoSync(cwd) || (await isGitRepo(pi as any, cwd));
        if (!isRepo) {
          await (ctx as any).navigateTree(choice, { summarize: false });
          ctx.ui.notify(
            `Rewound to ${shortId(choice)} — messages only (no git repo, file restore unavailable)`,
            "info",
          );
          return;
        }
        // Dirty check with safety snapshot
        let dirty = false;
        try {
          dirty = await isDirty(pi as any, cwd);
        } catch (_e) {
          void _e;
        }
        if (dirty && (ctx as any).hasUI) {
          const sel = await (ctx as any).ui.select(
            "Working tree has uncommitted changes. Create safety snapshot and restore?",
            [
              "Restore — snapshot current state then revert tracked files",
              "Cancel",
            ],
          );
          if (!sel || String(sel).startsWith("Cancel")) {
            ctx.ui.notify("Rewind cancelled — working tree preserved", "info");
            return;
          }
        }
        // Always create safety snapshot before destructive checkout
        try {
          await createSafetySnapshot(pi as any, cwd);
        } catch (_e) {
          void _e;
        }
        const ref = checkpoints.get(choice) ?? findPersistedRef(branch, choice);
        if (!ref) {
          await (ctx as any).navigateTree(choice, { summarize: false });
          ctx.ui.notify(
            `Rewound to ${shortId(choice)} — restored messages only (no file snapshot for this checkpoint)`,
            "info",
          );
          return;
        }
        // Move conversation branch first, then restore files so getBranch matches files
        await (ctx as any).navigateTree(choice, { summarize: false });
        recentRestores.add(choice);
        setTimeout(() => recentRestores.delete(choice), 2000);
        const res = await restoreCode(pi as any, cwd, ref, {
          signal: (ctx as any).signal,
        } as any);
        if (res.restored) {
          ctx.ui.notify(
            `Rewound to ${shortId(choice)} · files restored`,
            "info",
          );
        } else {
          ctx.ui.notify(
            `Rewound to ${shortId(choice)} — messages restored, file restore failed`,
            "error",
          );
        }
      } catch (e: any) {
        ctx.ui.notify(`Rewind failed: ${e?.message || e}`, "error");
      }
    },
  });

  pi.registerCommand("btw", {
    description: "Add note/question while agent is working (queued)",
    handler: async (args, ctx) => {
      const note = (args || "").trim();
      if (!note) {
        ctx.ui.notify("Usage: /btw <note or question>", "info");
        return;
      }
      btwNotes.push(note);
      // Persist as custom entry so it survives reload and appears in transcript
      try {
        pi.appendEntry("workflow-btw", { note, at: Date.now() });
      } catch (_e) {
        void _e;
      }
      // Inject as custom message so next LLM turn sees it
      try {
        (pi as any).sendMessage?.(
          {
            customType: "workflow-btw",
            content: `[BTW] ${note}`,
            display: true,
          },
          { triggerTurn: false },
        );
      } catch (_e) {
        void _e;
      }
      // Also append via sessionManager if available
      try {
        (ctx.sessionManager as any).appendCustomMessageEntry?.(
          "workflow-btw",
          `[BTW] ${note}`,
          true,
        );
      } catch (_e) {
        void _e;
      }

      if ((ctx as any).isIdle?.() === false) {
        ctx.ui.notify(`Note queued (agent busy): ${note.slice(0, 60)}`, "info");
      } else {
        ctx.ui.notify(
          `Note added: ${note.slice(0, 60)} — will be included in next turn`,
          "info",
        );
      }
    },
  });

  // Also allow /btw via input event when typed as message prefix
  pi.on("input", async (event, _ctx) => {
    if (typeof event.text === "string" && event.text.startsWith("/btw ")) {
      const note = event.text.slice(5).trim();
      if (note) {
        btwNotes.push(note);
        try {
          pi.appendEntry("workflow-btw", { note, at: Date.now() });
        } catch (_e) {
          void _e;
        }
      }
      return { action: "handled" } as any;
    }
    return { action: "continue" } as any;
  });

  // ── Session & Agent lifecycle ────────────────────────────────────

  pi.on("session_start", async (event, ctx) => {
    // restore state from custom entries (supports both legacy enabled/executing and new mode field)
    try {
      const entries = ctx.sessionManager.getBranch();
      for (const e of entries as any[]) {
        if (e.type === "custom" && e.customType === "workflow") {
          const d = e.data as any;
          if (d) {
            if (typeof d.mode === "string") {
              workflowMode =
                d.mode === "plan"
                  ? "plan"
                  : d.mode === "build"
                    ? "build"
                    : null;
            } else {
              // legacy: enabled (plan) / executing (build)
              if (d.enabled) workflowMode = "plan";
              else if (d.executing) workflowMode = "build";
              else if (workflowMode === null) workflowMode = null;
            }
            syncLegacyFlags();
            if (Array.isArray(d.todos)) todoItems = d.todos;
            toolsBeforePlanMode = d.toolsBeforePlanMode;
            currentPlanFile = d.planFile;
            awaitingDecision = !!d.awaitingDecision;
            lastHandoffAt =
              typeof d.awaitingDecisionAt === "number"
                ? d.awaitingDecisionAt
                : undefined;
            // Stale guard: if awaitingDecision was persisted >60s ago (crash while modal open), reset
            if (
              awaitingDecision &&
              lastHandoffAt &&
              Date.now() - lastHandoffAt > 60_000
            ) {
              awaitingDecision = false;
              lastHandoffAt = undefined;
              try {
                (ctx as any).ui?.notify?.(
                  "Recovered stale handoff gate — showing again",
                  "info",
                );
              } catch (_e) {
                void _e;
              }
              try {
                pi.appendEntry("workflow-handoff-stale-reset", {
                  at: Date.now(),
                  lastHandoffAt,
                });
              } catch (_e) {
                void _e;
              }
            }
          }
        }
        if (
          e.type === "custom" &&
          e.customType === "workflow-btw" &&
          e.data?.note
        ) {
          btwNotes.push(e.data.note);
        }
        if (
          e.type === "custom" &&
          e.customType === "workflow-checkpoint" &&
          e.data?.entryId &&
          typeof e.data?.ref === "string"
        ) {
          checkpoints.set(e.data.entryId, e.data.ref);
        }
      }
    } catch (_e) {
      void _e;
    }
    // auto-enable plan mode if flag set at startup (support both --plan and --workflow-plan)
    const flagPlan =
      (pi as any).getFlagValue?.("plan") ??
      (pi as any).getFlagValue?.("workflow-plan") ??
      false;
    if (event.reason === "startup" && flagPlan && workflowMode !== "plan") {
      workflowMode = "plan";
      syncLegacyFlags();
      if (toolsBeforePlanMode === undefined)
        toolsBeforePlanMode = pi.getActiveTools();
      pi.setActiveTools(getPlanModeTools(toolsBeforePlanMode));
      try {
        fs.mkdirSync(path.join(ctx.cwd, CONFIG_DIR_NAME, "plans"), {
          recursive: true,
        });
      } catch (_e) {
        void _e;
      }
      persistState();
    }
    currentSessionCtx = ctx as any;
    // Register plannotator bridge (idempotent) and detect presence
    ensurePlannotatorListeners();
    // Also detect via presence of plannotator package in settings
    try {
      const settings: any = (ctx as any).settings ?? {};
      const pkgs: string[] = settings.packages ?? [];
      if (pkgs.some((p: string) => String(p).includes("plannotator"))) {
        plannotatorActive = true;
        updateStatus(ctx as any);
      }
    } catch (_e) {
      void _e;
    }
    // Fallback: check if bus already has plannotator listeners (plannotator loaded before workflow)
    try {
      const bus: any = (pi as any).events;
      const hasPlannotator =
        bus &&
        typeof bus.listenerCount === "function" &&
        bus.listenerCount(PLANNOTATOR_REQUEST) > 0;
      if (hasPlannotator) {
        plannotatorActive = true;
        ensurePlannotatorListeners();
        updateStatus(ctx as any);
      }
    } catch (_e) {
      void _e;
    }
    updateStatus(ctx as any);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    // Kill any active explore subagents to prevent orphan leaks.
    // Without this, `pi --mode json` children spawned by runSingleAgent
    // (up to 4 concurrent) could survive if VS Code closes the terminal
    // or pi crashes, holding file handles and confusing the next session.
    for (const proc of [...activeSubagents]) {
      try {
        proc.kill("SIGTERM");
      } catch (_e) {
        void _e;
      }
    }
    activeSubagents.clear();
    // Ensure awaitingDecision does not persist stale across restart
    if (awaitingDecision) {
      awaitingDecision = false;
      lastHandoffAt = undefined;
      lastReviewId = null;
      try {
        persistState();
      } catch (_e) {
        void _e;
      }
    }
    ctx.ui.setStatus("workflow", undefined);
    ctx.ui.setWidget("workflow-todos", undefined);
    currentSessionCtx = null;
  });

  pi.on("session_tree", async (_event, ctx) => {
    // reconstruct after rewind
    todoItems = [];
    btwNotes = [];
    try {
      const branch = ctx.sessionManager.getBranch();
      for (const e of branch as any[]) {
        if (e.type === "custom" && e.customType === "workflow" && e.data?.todos)
          todoItems = e.data.todos;
        if (
          e.type === "message" &&
          e.message?.role === "toolResult" &&
          e.message.toolName === "workflow_todo" &&
          e.message.details?.todos
        ) {
          todoItems = e.message.details.todos;
        }
      }
    } catch (_e) {
      void _e;
    }
    updateStatus(ctx as any);
  });

  // Block edits/writes + bash gating
  pi.on("tool_call", async (event, ctx) => {
    const cwd = (ctx as ExtensionContext).cwd;
    if (event.toolName === "bash" && workflowMode === "plan") {
      const cmd = (event.input as any).command as string;
      // Narrow exception: allow mkdir -p .pi/plans as fallback for ensuring directory exists.
      // Bash writes via >, >>, tee, cp, mv stay blocked — plan file must use write tool (Claude Code parity).
      const lower = cmd.toLowerCase();
      const isMkdirPlans =
        /^\s*mkdir\s+(-p\s+)?/i.test(cmd) &&
        (lower.includes(".pi/plans") || lower.includes(".pi\\plans"));
      if (isMkdirPlans) {
        try {
          fs.mkdirSync(path.join(cwd, CONFIG_DIR_NAME, "plans"), {
            recursive: true,
          });
        } catch (_e) {
          void _e;
        }
        return;
      }
      if (!isSafeCommand(cmd)) {
        return {
          block: true,
          reason: `Plan mode: command blocked (not allowlisted). Use /build or Tab to switch to Build mode. Use write({path: ".pi/plans/<date>-<slug>.md"}) for plans — not bash >.\nCommand: ${cmd}`,
        } as any;
      }
    }
    if (
      (event.toolName === "edit" || event.toolName === "write") &&
      workflowMode === "plan"
    ) {
      const p =
        (event.input as any).path || (event.input as any).file_path || "";
      if (!isPlanWritePath(p, cwd)) {
        return {
          block: true,
          reason: `Plan mode: ${event.toolName} blocked. Only writes to .pi/plans/ allowed (use write({path: ".pi/plans/${getUtcDatePrefix()}-<slug>.md", content: "..."})). Use /build or Tab to switch to Build mode.`,
        } as any;
      }
      // Silent auto-correct: enforce UTC date prefix so LLM hallucinations don't create wrong-dated files
      try {
        const today = getUtcDatePrefix();
        const norm = normalizePlanPath(p, cwd, today);
        if (norm.corrected) {
          const input: any = event.input as any;
          if (input.path) input.path = norm.path;
          if (input.file_path) input.file_path = norm.path;
          try {
            (ctx as any).ui?.notify?.(
              `Plan path auto-corrected ${norm.original} → ${norm.path} (UTC ${today})`,
              "warning",
            );
          } catch (_e) {
            void _e;
          }
          try {
            pi.appendEntry("workflow-plan-path-corrected", {
              original: norm.original,
              corrected: norm.path,
              at: Date.now(),
              today,
            });
          } catch (_e) {
            void _e;
          }
        }
      } catch (_e) {
        void _e;
      }
      // Ensure plans dir exists
      try {
        fs.mkdirSync(path.join(cwd, CONFIG_DIR_NAME, "plans"), {
          recursive: true,
        });
      } catch (_e) {
        void _e;
      }
    }
    // In build mode, ensure todos exist before first real edit
    if (
      (event.toolName === "edit" || event.toolName === "write") &&
      workflowMode === "build" &&
      todoItems.length === 0
    ) {
      const p =
        (event.input as any).path || (event.input as any).file_path || "";
      if (!isPlanWritePath(p, cwd)) {
        // not blocking, but warn and create placeholder todo
        // block until todo list is created
        return {
          block: true,
          reason: `Build mode: create todos first. Use workflow_todo {action:"add", text:"..."} or ensure plan file exists. Then retry the edit.`,
        } as any;
      }
    }
  });

  // ── Checkpoint lifecycle: track leaf entryId and prompt header ─
  pi.on("tool_result", async (_event, ctx) => {
    try {
      const leaf =
        (ctx.sessionManager as any).getLeafEntry?.() ??
        ctx.sessionManager.getBranch()?.at(-1);
      if (leaf?.id) currentEntryId = leaf.id;
    } catch (_e) {
      void _e;
    }
  });

  pi.on("turn_start", async (_event, ctx) => {
    if (!currentEntryId) return;
    const cwd = (ctx as any).cwd as string;
    try {
      if (!isGitRepoSync(cwd) && !(await isGitRepo(pi as any, cwd))) return;
      const header = lastPromptHeader ?? "checkpoint";
      const res = await createCheckpoint(
        pi as any,
        cwd,
        currentEntryId,
        header,
      );
      if (res.ref) {
        checkpoints.set(currentEntryId, res.ref);
        try {
          pi.appendEntry("workflow-checkpoint", {
            entryId: currentEntryId,
            ref: res.ref,
            prompt: header,
            createdAt: Date.now(),
          });
        } catch (_e) {
          void _e;
        }
      }
    } catch (_e) {
      void _e;
    }
  });

  pi.on("agent_settled", async () => {
    // keep persisted CustomEntry for reload, clear in-memory tombstone only on explicit prune; for now no clear to survive fork
  });

  // Dedup helper for /tree vs /rewind double-restore
  pi.on("session_before_tree", async (event, ctx) => {
    const targetId =
      (event as any).preparation?.targetId ?? (event as any).targetId;
    if (!targetId || recentRestores.has(targetId)) return;
    const branch: any[] = ctx.sessionManager.getBranch();
    const ref = checkpoints.get(targetId) ?? findPersistedRef(branch, targetId);
    if (!ref) return;
    const cwd = (ctx as any).cwd as string;
    if (!isGitRepoSync(cwd) && !(await isGitRepo(pi as any, cwd))) return;
    if (!(ctx as any).hasUI) return;
    try {
      const dirty = await isDirty(pi as any, cwd);
      if (dirty) {
        const sel = await (ctx as any).ui.select(
          "Restore tracked files to this checkpoint?",
          ["Yes, restore files", "No, messages only"],
        );
        if (!sel || String(sel).startsWith("No")) return;
      }
      try {
        await createSafetySnapshot(pi as any, cwd);
      } catch (_e) {
        void _e;
      }
      const res = await restoreCode(pi as any, cwd, ref, {
        signal: (event as any).signal,
      } as any);
      if (res.restored) {
        (ctx as any).ui?.notify?.(
          `Files restored to ${shortId(targetId)}`,
          "info",
        );
        recentRestores.add(targetId);
        setTimeout(() => recentRestores.delete(targetId), 2000);
      }
    } catch (_e) {
      void _e;
    }
  });

  // Inject plan/build context + btw notes
  pi.on("before_agent_start", async (event, ctx) => {
    currentSessionCtx = ctx as any;
    ensurePlannotatorListeners();
    // Stale handoff reset: fresh user prompt means previous gate was dismissed/crashed
    try {
      const fw =
        (event as any).followUp === true ||
        (event as any).deliverAs === "followUp";
      if (awaitingDecision && !fw) {
        // If user sent a new prompt while gate stale, free it so next agent_end can show again
        const age = lastHandoffAt ? Date.now() - lastHandoffAt : Infinity;
        if (age > 5_000) {
          awaitingDecision = false;
          lastHandoffAt = undefined;
          persistState();
          try {
            pi.appendEntry("workflow-handoff-reset-before-start", {
              at: Date.now(),
              age,
            });
          } catch (_e) {
            void _e;
          }
        }
      }
    } catch (_e) {
      void _e;
    }
    // Capture header for next checkpoint commit message (first line of prompt)
    try {
      const raw = String((event as any).prompt ?? (event as any).text ?? "");
      if (raw.trim()) {
        const first =
          raw
            .split(/\r?\n/)
            .find((l: string) => l.trim())
            ?.trim() ?? raw.trim();
        lastPromptHeader = first.replace(/\s+/g, " ").slice(0, 80);
      }
    } catch (_e) {
      void _e;
    }
    if (workflowMode === "plan") {
      const btwBlock = btwNotes.length
        ? `\n\n[BTW notes from user (address these)]:\n${btwNotes.map((n) => `- ${n}`).join("\n")}`
        : "";
      btwNotes = []; // consume
      const today = getUtcDatePrefix();
      return {
        message: {
          customType: "workflow-plan-context",
          content: `[PLAN MODE ACTIVE — Today is ${today} (UTC). Use this date as the <date> prefix.] — read-only exploration.\n\nRestrictions:\n- edit/write blocked except .pi/plans/ — use the write tool for that path (not bash). Example: write({path: ".pi/plans/${today}-my-feature.md", content: "# Plan: ..."})
- bash limited to read-only allowlist (no >, >>, mkdir outside .pi/plans). Do not use bash to write the plan file.\n- Use explore tool (subagents) in parallel for codebase recon\n- Use questionnaire tool for clarifications: 1-4 questions at once, first option = recommendation. Questionnaire appends "Type something." automatically — do NOT add Other/Type something in options.
- Loop: explore → questionnaire → re-explore until no open questions.\n- Then write comprehensive plan to .pi/plans/<date>-<slug>.md where <date> is Today (${today}) and <slug> is kebab-case ≤40 chars, with headings: # Plan: <title>, ## Context, ## Decisions, ## Exploration Summary, ## Plan Steps (numbered 1..N), ## Risks, ## Verification.\n- If you need to verify the date, run: bash {command: "date -u +%F"} (UTC) — do not guess the date. The extension will auto-correct a wrong prefix to ${today}.\n- Keep asking until everything is clear. Do NOT edit source files.\n- Use brave-search skill via bash if web research needed.\n${btwBlock}`,
          display: false,
        },
      } as any;
    }
    if (workflowMode === "build" && todoItems.length > 0) {
      const remaining = todoItems.filter((t) => !t.completed);
      const list = remaining.map((t) => `${t.step}. ${t.text}`).join("\n");
      const btwBlock = btwNotes.length
        ? `\n\n[BTW]: ${btwNotes.join(" | ")}`
        : "";
      btwNotes = [];
      return {
        message: {
          customType: "workflow-build-context",
          content: `[BUILD MODE — executing plan. Full tool access enabled.]\n\nRemaining todos:\n${list}\n\nExecute steps in order. After completing a step, include [DONE:n] in your response and/or call workflow_todo {action:"toggle", step:n}.\nTrack progress via workflow_todo. Abort with Escape (signal) is supported.\n${btwBlock}`,
          display: false,
        },
      } as any;
    }
    if (btwNotes.length) {
      const notes = [...btwNotes];
      btwNotes = [];
      return {
        message: {
          customType: "workflow-btw",
          content: `[BTW] ${notes.join("\n[BTW] ")}`,
          display: true,
        },
      } as any;
    }
  });

  // Context filter when not in plan
  pi.on("context", async (event) => {
    if (workflowMode === "plan") return;
    return {
      messages: event.messages.filter((m: any) => {
        if (m.customType === "workflow-plan-context") return false;
        if (m.role !== "user") return true;
        const c = m.content;
        if (typeof c === "string") return !c.includes("[PLAN MODE ACTIVE]");
        if (Array.isArray(c))
          return !c.some(
            (x: any) =>
              x.type === "text" && x.text?.includes("[PLAN MODE ACTIVE]"),
          );
        return true;
      }),
    } as any;
  });

  // Track progress
  pi.on("turn_end", async (event, ctx) => {
    if (workflowMode !== "build" || todoItems.length === 0) return;
    if (!isAssistantMessage(event.message as AgentMessage)) return;
    const text = getTextContent(event.message as AssistantMessage);
    if (markCompletedSteps(text, todoItems) > 0) {
      updateStatus(ctx as any);
      persistState();
    }
    // also if workflow_todo toggled, the tool's own state already updated; just refresh widget
    updateStatus(ctx as any);
  });

  // Plan file detection + full render + decision gate
  let lastPlanWritePath: string | null = null;

  pi.on("tool_result", async (event, ctx) => {
    if (
      (event.toolName === "write" || event.toolName === "edit") &&
      !event.isError
    ) {
      const p =
        (event.input as any).path || (event.input as any).file_path || "";
      if (!p) return;
      const cwd = (ctx as any)?.cwd as string | undefined;
      // Use shared helper when cwd available; fall back to substring check
      let isPlan = false;
      try {
        if (cwd) isPlan = isPlanWritePath(String(p), cwd);
        else
          isPlan = String(p)
            .replace(/\\/g, "/")
            .toLowerCase()
            .includes(".pi/plans/");
      } catch (_e) {
        void _e;
        isPlan = String(p).toLowerCase().includes(".pi/plans");
      }
      if (isPlan) {
        // Store absolute for robust agent_end resolution (handles relative + Windows backslashes)
        try {
          const cwd2 = cwd ?? process.cwd();
          const abs = path.isAbsolute(String(p))
            ? String(p)
            : path.join(cwd2, String(p));
          lastPlanWritePath = abs;
        } catch (_e) {
          void _e;
          lastPlanWritePath = String(p);
        }
        try {
          pi.appendEntry("workflow-handoff-resolve", {
            source: "tool_result",
            planPath: lastPlanWritePath,
          });
        } catch (_e) {
          void _e;
        }
      }
    }
  });

  pi.on("agent_end", async (event, ctx) => {
    // Mutex: serialize concurrent agent_end handoffs (bus may emit Promise.all)
    if (handoffInFlight) {
      try {
        await handoffInFlight;
      } catch (_e) {
        void _e;
      }
      if (awaitingDecision) {
        try {
          ctx.ui.notify(
            "Plan handoff already pending — dismiss the existing prompt first.",
            "info",
          );
        } catch (_e) {
          void _e;
        }
        return;
      }
    }
    const runHandoff = async () => {
      // Build completion
      if (workflowMode === "build" && todoItems.length > 0) {
        const allDone = todoItems.every((t) => t.completed);
        if (allDone) {
          try {
            (pi as any).sendMessage?.(
              {
                customType: "workflow-complete",
                content: `**Build Complete! ✓**\n\n${todoItems.map((t) => `~~${t.step}. ${t.text}~~`).join("\n")}`,
                display: true,
              },
              { triggerTurn: false },
            );
          } catch (_e) {
            void _e;
          }
          // keep todos for history but stay in build
          updateStatus(ctx as any);
          persistState();
        }
        return;
      }

      if (workflowMode !== "plan") return;
      const hasUI = !!(ctx as any).hasUI;

      // Extract todos from last assistant message if plan was emitted
      const lastAssistant = [...(event.messages as any[])]
        .reverse()
        .find((m) => m.role === "assistant" && Array.isArray(m.content));
      let extracted: TodoItem[] = [];
      if (lastAssistant) {
        try {
          extracted = extractTodoItems(
            getTextContent(lastAssistant as AssistantMessage),
          );
        } catch (_e) {
          void _e;
        }
      }
      if (extracted.length > 0) todoItems = extracted;
      if (todoItems.length === 0 && lastPlanWritePath) {
        try {
          const planText = fs.readFileSync(
            path.isAbsolute(lastPlanWritePath)
              ? lastPlanWritePath
              : path.join((ctx as any).cwd, lastPlanWritePath),
            "utf8",
          );
          const fromFile = extractPlanStepsFromMarkdown(planText);
          if (fromFile.length > 0) todoItems = fromFile;
        } catch (_e) {
          void _e;
        }
      }
      // Broaden planPath recovery: scan branch for any plan file if lastPlanWritePath is still null
      if (todoItems.length === 0 && !lastPlanWritePath) {
        try {
          const branch = (ctx.sessionManager as any).getBranch?.() ?? [];
          for (let i = branch.length - 1; i >= 0; i--) {
            const e: any = branch[i];
            const cand =
              e?.data?.planFile ||
              e?.data?.planPath ||
              e?.data?.path ||
              e?.message?.toolName === "write" ||
              e?.message?.toolName === "edit"
                ? e?.input?.path || e?.input?.file_path || ""
                : "";
            const s = String(cand).toLowerCase();
            if (s.includes("plans/") || s.includes(".pi/plans")) {
              // try to resolve that entry as plan source
              try {
                const text = fs.readFileSync(
                  path.isAbsolute(cand)
                    ? cand
                    : path.join((ctx as any).cwd, cand),
                  "utf8",
                );
                const fromFile = extractPlanStepsFromMarkdown(text);
                if (fromFile.length > 0) {
                  todoItems = fromFile;
                  lastPlanWritePath = cand;
                  break;
                }
              } catch (_e) {
                void _e;
              }
            }
            // Also check custom entries that store planFile
            if (e?.customType === "workflow" && e?.data?.planFile) {
              try {
                const text = fs.readFileSync(e.data.planFile, "utf8");
                const fromFile = extractPlanStepsFromMarkdown(text);
                if (fromFile.length > 0) {
                  todoItems = fromFile;
                  lastPlanWritePath = e.data.planFile;
                  break;
                }
              } catch (_e) {
                void _e;
              }
            }
          }
        } catch (_e) {
          void _e;
        }
      }
      // If still zero but a plan file exists, synthesize a single todo from its title so the handoff still appears
      let _synthesizedFromTitle = false;
      void _synthesizedFromTitle;
      if (todoItems.length === 0) {
        // Try to synthesize from plan file title or last assistant text
        let synthText: string | undefined;
        // Prefer reading the resolved plan file if we can find one
        const candPlan =
          (currentPlanFile && fs.existsSync(currentPlanFile)
            ? currentPlanFile
            : null) ||
          (lastPlanWritePath &&
            (() => {
              try {
                const p = path.isAbsolute(lastPlanWritePath)
                  ? lastPlanWritePath
                  : path.join((ctx as any).cwd, lastPlanWritePath);
                return fs.existsSync(p) ? p : null;
              } catch {
                return null;
              }
            })()) ||
          null;
        if (candPlan) {
          try {
            const md = fs.readFileSync(candPlan, "utf8");
            const titleMatch =
              md.match(/^#\s+Plan[:\s]+(.+)$/im) || md.match(/^#\s+(.+)$/m);
            if (titleMatch) synthText = titleMatch[1].trim().slice(0, 80);
          } catch (_e) {
            void _e;
          }
        }
        if (!synthText && lastAssistant) {
          const t = getTextContent(lastAssistant as AssistantMessage)
            .slice(0, 80)
            .trim();
          if (t) synthText = t.split("\n")[0].trim().slice(0, 80);
        }
        if (synthText) {
          todoItems = [{ step: 1, text: synthText, completed: false }];
          _synthesizedFromTitle = true;
        } else {
          // Ultimate fallback: single generic step so gate can appear
          todoItems = [
            { step: 1, text: "Review and execute the plan", completed: false },
          ];
          _synthesizedFromTitle = true;
        }
      }

      // Try to find plan file path
      let planPath = currentPlanFile;
      if (!planPath && lastPlanWritePath) planPath = lastPlanWritePath;
      if (planPath && !path.isAbsolute(planPath))
        planPath = path.join((ctx as any).cwd, planPath);
      if (!planPath) {
        // synthesize path for display if file not yet written but plan text exists
        const slug = slugify(
          (event.messages.find((m: any) => m.role === "user") as any)
            ?.content?.[0]?.text || "plan",
        );
        const fname = `${getUtcDatePrefix()}-${slug}.md`;
        planPath = path.join((ctx as any).cwd, CONFIG_DIR_NAME, "plans", fname);
      }
      currentPlanFile = planPath;
      persistState();

      // Robust planTextForRender resolution with source logging (Step 2)
      let planTextForRender: string | null = null;
      let planSource: string = "none";
      const tryRead = (p: string | null | undefined): string | null => {
        if (!p) return null;
        try {
          const abs = path.isAbsolute(p) ? p : path.join((ctx as any).cwd, p);
          if (fs.existsSync(abs)) return fs.readFileSync(abs, "utf8");
        } catch (_e) {
          void _e;
        }
        return null;
      };
      // Priority: lastPlanWritePath (most recent write) -> current planPath -> branch scan -> assistant draft
      const fromLastWrite = tryRead(lastPlanWritePath);
      if (fromLastWrite) {
        planTextForRender = fromLastWrite;
        planSource = "lastPlanWritePath";
      } else {
        const fromPlanPath = tryRead(planPath);
        if (fromPlanPath) {
          planTextForRender = fromPlanPath;
          planSource = "planPath";
        } else {
          // Branch scan for any .pi/plans write that we missed (e.g. file_path alias, timing)
          try {
            const branch = (ctx.sessionManager as any).getBranch?.() ?? [];
            for (let i = branch.length - 1; i >= 0; i--) {
              const e: any = branch[i];
              const cand: string =
                e?.input?.path ||
                e?.input?.file_path ||
                e?.data?.planFile ||
                "";
              const s = String(cand).toLowerCase();
              if (s.includes("plans/") || s.includes(".pi/plans")) {
                const txt = tryRead(cand);
                if (txt) {
                  const steps = extractPlanStepsFromMarkdown(txt);
                  if (steps.length > 0 || txt.length > 200) {
                    planTextForRender = txt;
                    planSource = "branch-scan";
                    if (!lastPlanWritePath)
                      lastPlanWritePath = path.isAbsolute(cand)
                        ? cand
                        : path.join((ctx as any).cwd, cand);
                    break;
                  }
                }
              }
            }
          } catch (_e) {
            void _e;
          }
          if (!planTextForRender && lastAssistant) {
            planTextForRender = getTextContent(
              lastAssistant as AssistantMessage,
            );
            if (planTextForRender) planSource = "assistant-draft";
            try {
              if (planTextForRender)
                ctx.ui.notify(
                  "Using in-memory draft — plan file not yet persisted",
                  "info",
                );
            } catch (_e) {
              void _e;
            }
          }
        }
      }
      try {
        pi.appendEntry("workflow-handoff-resolve", {
          at: Date.now(),
          source: planSource,
          planPath,
          planTextLen: planTextForRender ? planTextForRender.length : 0,
        });
      } catch (_e) {
        void _e;
      }
      // Fallback when hasUI is false: still show handoff via followUp message (Claude Code parity for headless)
      if (!hasUI && planTextForRender && !awaitingDecision) {
        try {
          const preview = planTextForRender.slice(0, 4000);
          const list = todoItems.map((t) => `${t.step}. ${t.text}`).join("\n");
          const content = plannotatorActive
            ? `**Plan ready** (${todoItems.length} steps)\\n\\nTo review in browser, ensure SSH port forwarding is active:\\n\`\`\`\\nLocalForward 9999 localhost:9999\\n\`\`\`\\nThen set \`PLANNOTATOR_REMOTE=1\` and \`PLANNOTATOR_PORT=9999\`.\\n\\nOr type "Execute the plan" to build directly.\\n\\nRemaining:\\n${list}`
            : `**Plan ready** (${todoItems.length} steps)\\n\\n${preview.slice(0, 500)}...\\n\\nRemaining:\\n${list}\\n\\nType "Execute the plan" to build, or tell me what to refine.`;
          (pi as any).sendMessage?.(
            {
              customType: "workflow-handoff-fallback",
              content,
              display: true,
            },
            { triggerTurn: false },
          );
        } catch (_e) {
          void _e;
        }
        // Also notify
        try {
          ctx.ui.notify(
            plannotatorActive
              ? "Plan ready — awaiting browser review (or type Execute to build directly)"
              : "Plan ready — type Execute to build or tell me what to refine.",
            "info",
          );
        } catch (_e) {
          void _e;
        }
        return;
      }
      if (planTextForRender && hasUI && !awaitingDecision) {
        // ── Plannotator webview branch (browser review) ──────────
        if (plannotatorActive) {
          awaitingDecision = true;
          lastHandoffAt = Date.now();
          persistState();
          try {
            const bus: any = (pi as any).events;
            const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
            const response: any = await new Promise((resolve) => {
              let settled = false;
              const timer = setTimeout(() => {
                if (!settled) {
                  settled = true;
                  resolve({ status: "timeout" });
                }
              }, 5000);
              try {
                bus.emit(PLANNOTATOR_REQUEST, {
                  requestId,
                  action: "plan-review",
                  payload: {
                    planContent: planTextForRender!,
                    planFilePath: planPath,
                  },
                  respond: (res: any) => {
                    if (!settled) {
                      settled = true;
                      clearTimeout(timer);
                      resolve(res);
                    }
                  },
                });
              } catch (e) {
                if (!settled) {
                  settled = true;
                  clearTimeout(timer);
                  resolve({ status: "error", error: String(e) });
                }
              }
            });
            if (
              response &&
              response.status === "handled" &&
              response.result &&
              response.result.reviewId
            ) {
              lastReviewId = response.result.reviewId;
              try {
                pi.appendEntry("workflow-handoff-plannotator", {
                  at: Date.now(),
                  planPath,
                  reviewId: lastReviewId,
                  planTextLen: planTextForRender!.length,
                  source: planSource,
                });
              } catch (_e) {
                void _e;
              }
              try {
                currentSessionCtx = ctx as any;
                (ctx as any).ui?.notify?.(
                  "Plan opened in browser for review. Approve or annotate there.",
                  "info",
                );
                updateStatus(ctx as any);
              } catch (_e) {
                void _e;
              }
              return; // plannotator owns the review — result arrives via plannotator:review-result / plan-approved events
            }
            if (response && response.status !== "timeout") {
              try {
                (ctx as any).ui?.notify?.(
                  `Plannotator unavailable (${response.status}), falling back to inline review`,
                  "warning",
                );
              } catch (_e) {
                void _e;
              }
            }
          } catch (e) {
            try {
              (ctx as any).ui?.notify?.(
                `Plannotator request failed, falling back to inline: ${String(e).slice(0, 80)}`,
                "warning",
              );
            } catch (_e) {
              void _e;
            }
          }
          // Browser branch failed — clear gate so inline can show
          awaitingDecision = false;
          lastHandoffAt = undefined;
          lastReviewId = null;
          persistState();
          // fall through to inline handoff below
        }
        awaitingDecision = true;
        lastHandoffAt = Date.now();
        persistState();
        const handoffStart = Date.now();
        try {
          const planContent = planTextForRender;
          const items: SelectItem[] = [
            {
              value: "execute",
              label: "1. Execute the plan in Build Mode",
              description:
                "Create todos, switch to build, start implementing (recommended)",
            },
            {
              value: "refine",
              label: "2. Refine the plan in Plan Mode",
              description:
                "Stay in plan mode, ask more questions, update the plan file",
            },
            {
              value: "freeform",
              label: "3. Type something else",
              description: "Dismiss — type your own follow-up",
            },
          ];
          // Fallback inline handoff — split plan (scrollable, fill available) + choices (static at bottom).
          // Plannotator is primary; this branch is only reached on timeout/error or !hasUI.
          // Leaf custom component renders as flat lines, so ScrollView alone would not clip — manual slice
          // is required to bound the viewport. Plan slice fills available space above static choices.
          const choice = await ctx.ui.custom<string | null>(
            (tui: any, theme: any, _kb: any, done: any) => {
              const mdTheme = getMarkdownTheme();
              const planMd = new Markdown(planContent, 0, 0, mdTheme);
              const planScroll = new ScrollView(planMd as any, {
                overscroll: "contain",
                scrollbar: "auto",
                follow: "none",
                primary: false,
              });
              try {
                (planScroll as any).setScrollbarActive?.(true);
              } catch (_e) {
                void _e;
              }
              let collapsed = false;
              const buildHeader = () =>
                new Text(
                  theme.fg(
                    "accent",
                    theme.bold(
                      ` Plan: ${path.basename(planPath!)} ` +
                        (collapsed
                          ? "(collapsed — press c to expand)"
                          : "(press c to collapse)"),
                    ),
                  ),
                  1,
                  0,
                );
              let headerText = buildHeader();
              const choices = new Container();
              choices.addChild(
                new Text(
                  theme.fg(
                    "accent",
                    theme.bold(" Plan complete — choose next step "),
                  ),
                  1,
                  0,
                ),
              );
              const list = new SelectList(items, Math.min(items.length, 8), {
                selectedPrefix: (t: string) => theme.fg("accent", t),
                selectedText: (t: string) => theme.fg("accent", t),
                description: (t: string) => theme.fg("muted", t),
                scrollInfo: (t: string) => theme.fg("dim", t),
                noMatch: (t: string) => theme.fg("warning", t),
              });
              (list as any).onSelect = (it: SelectItem) => done(it.value);
              (list as any).onCancel = () => done(null);
              choices.addChild(list as any);
              choices.addChild(
                new Text(
                  theme.fg(
                    "dim",
                    " ↑↓ navigate • enter select • esc dismiss • c collapse ",
                  ),
                  1,
                  0,
                ),
              );
              return {
                render: (w: number) => {
                  try {
                    const termRows: number =
                      (tui as any)?.terminal?.rows ??
                      (tui as any)?.height ??
                      30;
                    const choiceLines = choices.render(w);
                    const choiceH = choiceLines.length;
                    const RESERVE = 3;
                    const MIN_PLAN = 6;
                    const MAX_PLAN = Math.max(MIN_PLAN, termRows - choiceH - 1);
                    const planViewport = collapsed
                      ? 0
                      : Math.max(
                          MIN_PLAN,
                          Math.min(MAX_PLAN, termRows - 1 - choiceH - RESERVE),
                        );
                    const out: string[] = [];
                    const hdr = buildHeader().render(w);
                    out.push(...hdr);
                    if (!collapsed) {
                      const all: string[] = (planScroll as any).render
                        ? (planScroll as any).render(w)
                        : (planMd as any).render(w);
                      try {
                        (planScroll as any).updateLayout(
                          all.length,
                          planViewport,
                          () => tui.requestRender(),
                        );
                      } catch (_e) {
                        void _e;
                      }
                      const maxSt = Math.max(0, all.length - planViewport);
                      if (((planScroll as any).scrollTop ?? 0) > maxSt) {
                        try {
                          (planScroll as any).scrollTo(maxSt);
                        } catch (_e) {
                          void _e;
                        }
                      }
                      const st = Math.max(
                        0,
                        Math.min((planScroll as any).scrollTop ?? 0, maxSt),
                      );
                      out.push(...all.slice(st, st + planViewport));
                    }
                    out.push(...choiceLines);
                    return out;
                  } catch (_e) {
                    void _e;
                  }
                  try {
                    return choices.render(w);
                  } catch (_ee) {
                    void _ee;
                    return [];
                  }
                },
                invalidate: () => {
                  try {
                    (planScroll as any).invalidate?.();
                  } catch (_e) {
                    void _e;
                  }
                  try {
                    choices.invalidate();
                  } catch (_e) {
                    void _e;
                  }
                  try {
                    headerText.invalidate?.();
                  } catch (_e) {
                    void _e;
                  }
                },
                handleInput: (d: string) => {
                  if (d === "c" || d === "C") {
                    collapsed = !collapsed;
                    try {
                      headerText = buildHeader();
                    } catch (_e) {
                      void _e;
                    }
                    try {
                      (planScroll as any).scrollTo(0);
                    } catch (_e) {
                      void _e;
                    }
                    tui.requestRender();
                    return;
                  }
                  const isWheel =
                    d.startsWith("\x1b[<") || d.startsWith("\x1b[M");
                  const isPageUp =
                    matchesKey(d, Key.pageUp) || d.includes("[5~");
                  const isPageDown =
                    matchesKey(d, Key.pageDown) || d.includes("[6~");
                  if (isWheel) {
                    let dir = 0;
                    if (d.includes(";")) {
                      dir = d.includes("64") ? -1 : d.includes("65") ? 1 : 0;
                      if (dir === 0)
                        dir = d.includes("M") && d.includes("64") ? -3 : 3;
                    } else {
                      dir = d.charCodeAt(3) === 97 ? -3 : 3;
                    }
                    try {
                      (planScroll as any).scrollBy(dir * 3);
                    } catch (_e) {
                      void _e;
                    }
                    tui.requestRender();
                    return;
                  }
                  if (isPageUp || isPageDown) {
                    const termRows: number =
                      (tui as any)?.terminal?.rows ??
                      (tui as any)?.height ??
                      30;
                    const delta = isPageUp
                      ? -Math.max(6, Math.floor(termRows * 0.5))
                      : Math.max(6, Math.floor(termRows * 0.5));
                    try {
                      (planScroll as any).scrollBy(delta);
                    } catch (_e) {
                      void _e;
                    }
                    tui.requestRender();
                    return;
                  }
                  (list as any).handleInput(d);
                  tui.requestRender();
                },
              };
            },
          );
          try {
            pi.appendEntry("workflow-handoff-result", {
              at: Date.now(),
              choice,
              durationMs: Date.now() - handoffStart,
              planPath,
            });
          } catch (_e) {
            void _e;
          }

          if (choice === "execute") {
            const resolvedPlan = planPath!;
            let fallbackWrote = false;
            try {
              if (!fs.existsSync(resolvedPlan)) {
                fs.mkdirSync(path.dirname(resolvedPlan), { recursive: true });
                fs.writeFileSync(resolvedPlan, planTextForRender, "utf8");
                fallbackWrote = true;
              }
            } catch (_e) {
              void _e;
            }
            if (fallbackWrote) {
              try {
                ctx.ui.notify(
                  "Plan was not on disk before handoff — persisted now as fallback (fix: write should happen in plan mode via write tool)",
                  "warning",
                );
              } catch (_e) {
                void _e;
              }
              try {
                pi.appendEntry("workflow-fallback-write", {
                  planPath: resolvedPlan,
                  at: Date.now(),
                });
              } catch (_e) {
                void _e;
              }
            }
            enterBuildModeFromPlan(ctx as any, resolvedPlan);
            updateStatus(ctx as any);
            try {
              const remainingList = todoItems
                .map((t) => `${t.step}. ${t.text}`)
                .join("\n");
              const todoListText = todoItems
                .map((t, i) => `${i + 1}. ☐ ${t.text}`)
                .join("\n");
              const planTodoListMessage = {
                customType: "workflow-todo-list",
                content: `**Plan Steps (${todoItems.length}):**\n\n${todoListText}`,
                display: true,
              };
              const firstTodo = todoItems[0];
              const execMessage = `Execute the plan.\n\nRemaining steps:\n${remainingList}\n\nStart with: ${firstTodo ? firstTodo.text : todoItems[0].text}\nAfter completing a step, include a [DONE:n] tag in your response.`;
              (pi as any).sendMessage?.(planTodoListMessage, {
                deliverAs: "followUp",
              });
              (pi as any).sendMessage?.(
                {
                  customType: "workflow-plan-execute",
                  content: execMessage,
                  display: true,
                },
                { triggerTurn: true, deliverAs: "followUp" },
              );
            } catch (_e) {
              void _e;
            }
          } else if (choice === "refine") {
            try {
              overlayActive = true;
              let refinement: string | null;
              try {
                refinement = await (ctx as any).ui.editor(
                  "Refine the plan:",
                  "",
                );
                if (refinement?.trim()) {
                  const todoListText = todoItems
                    .map((t, i) => `${i + 1}. ☐ ${t.text}`)
                    .join("\n");
                  const planTodoListMessage = {
                    customType: "workflow-todo-list",
                    content: `**Plan Steps (${todoItems.length}):**\n\n${todoListText}`,
                    display: true,
                  };
                  (pi as any).sendMessage?.(planTodoListMessage, {
                    deliverAs: "followUp",
                  });
                  if ((pi as any).sendUserMessage) {
                    (pi as any).sendUserMessage(refinement.trim(), {
                      deliverAs: "followUp",
                    });
                  } else {
                    (pi as any).sendMessage?.(refinement.trim(), {
                      deliverAs: "followUp",
                    });
                  }
                } else {
                  ctx.ui.notify(
                    "Refine: stay in plan mode. Tell me what to change, or ask more via questionnaire.",
                    "info",
                  );
                }
              } finally {
                overlayActive = false;
              }
            } catch (_e) {
              void _e;
              ctx.ui.notify(
                "Refine: stay in plan mode. Tell me what to change, or ask more via questionnaire.",
                "info",
              );
            }
          } else {
            ctx.ui.notify("Dismissed. Type your follow-up.", "info");
          }
        } finally {
          awaitingDecision = false;
          lastHandoffAt = undefined;
          persistState();
          try {
            (ctx as any).ui?.requestRender?.();
          } catch (_e) {
            void _e;
          }
        }
      } else if (!planTextForRender) {
        // Never silent: no plan text found — diagnose and stay in plan mode
        try {
          ctx.ui.notify(
            `Plan handoff: no plan text found (file missing and no assistant draft) — staying in plan mode. Use write to .pi/plans/${getUtcDatePrefix()}-<slug>.md`,
            "warning",
          );
        } catch (_e) {
          void _e;
        }
        try {
          pi.appendEntry("workflow-handoff-miss", {
            at: Date.now(),
            reason: "no-plan-text",
            planPath,
            todoLen: todoItems.length,
            hasUI,
          });
        } catch (_e) {
          void _e;
        }
        awaitingDecision = false;
        lastHandoffAt = undefined;
        persistState();
      } else if (awaitingDecision) {
        // Stale guard — if plannotator review is still pending, don't reset
        const age = lastHandoffAt ? Date.now() - lastHandoffAt : 0;
        if (plannotatorActive && lastReviewId) {
          try {
            const bus: any = (pi as any).events;
            const statusRes: any = await new Promise((resolve) => {
              let settled = false;
              const t = setTimeout(() => {
                if (!settled) {
                  settled = true;
                  resolve({ status: "timeout" });
                }
              }, 2000);
              try {
                bus.emit(PLANNOTATOR_REQUEST, {
                  requestId: `${Date.now()}-status`,
                  action: "review-status",
                  payload: { reviewId: lastReviewId },
                  respond: (r: any) => {
                    if (!settled) {
                      settled = true;
                      clearTimeout(t);
                      resolve(r);
                    }
                  },
                });
              } catch (e) {
                void e;
                if (!settled) {
                  settled = true;
                  clearTimeout(t);
                  resolve({ status: "error" });
                }
              }
            });
            if (
              statusRes &&
              statusRes.status === "handled" &&
              statusRes.result &&
              statusRes.result.status === "pending"
            ) {
              try {
                ctx.ui.notify(
                  "Plan review still open in browser — awaiting decision.",
                  "info",
                );
              } catch (_e) {
                void _e;
              }
              return;
            }
          } catch (_e) {
            void _e;
          }
        }
        if (age > 60_000) {
          awaitingDecision = false;
          lastHandoffAt = undefined;
          lastReviewId = null;
          persistState();
          try {
            ctx.ui.notify("Recovered stale handoff gate — retrying", "info");
          } catch (_e) {
            void _e;
          }
        } else {
          try {
            ctx.ui.notify(
              plannotatorActive && lastReviewId
                ? "Plan review still open in browser — approve or annotate there."
                : "Plan handoff already pending — dismiss the existing prompt first.",
              "info",
            );
          } catch (_e) {
            void _e;
          }
        }
      }
      // Telemetry: always log attempt outcome
      try {
        pi.appendEntry("workflow-handoff-attempt", {
          at: Date.now(),
          hasUI,
          awaitingDecisionAtEntry: false,
          planPath,
          planTextLen: planTextForRender ? planTextForRender.length : 0,
          todoLen: todoItems.length,
          source:
            planTextForRender && fs.existsSync(planPath) ? "file" : "assistant",
        });
      } catch (_e) {
        void _e;
      }
    };
    handoffInFlight = runHandoff();
    try {
      await handoffInFlight;
    } finally {
      handoffInFlight = null;
    }
  });

  // Keep status fresh
  pi.on("model_select", async (_e, ctx) => updateStatus(ctx as any));
  pi.on("thinking_level_select", async (_e, ctx) => updateStatus(ctx as any));

  // Sync with pi-code's plan-mode bus if present (so /plan from pi-code toggles our state too)
  try {
    const bus: any = (pi as any).events;
    if (bus && typeof bus.on === "function") {
      bus.on("pi-code:plan-mode", (state: any) => {
        // Mirror pi-code plan-mode into workflow's plan mode to avoid double toggles
        const isPlan = workflowMode === "plan";
        if (
          state &&
          typeof state.active === "boolean" &&
          state.active !== isPlan
        ) {
          if (state.active) {
            workflowMode = "plan";
            syncLegacyFlags();
            if (toolsBeforePlanMode === undefined)
              toolsBeforePlanMode = pi.getActiveTools();
            try {
              pi.setActiveTools(getPlanModeTools(toolsBeforePlanMode));
            } catch (_e) {
              void _e;
            }
          } else {
            workflowMode = "build";
            syncLegacyFlags();
            try {
              pi.setActiveTools(
                toolsBeforePlanMode ?? getBuildTools(pi.getActiveTools()),
              );
            } catch (_e) {
              void _e;
            }
            toolsBeforePlanMode = undefined;
          }
          // Find a ctx to update status — use a no-op if none
          // Status will be refreshed on next session_start/turn anyway
          persistState();
        }
      });
    }
  } catch (_e) {
    void _e;
  }
}
