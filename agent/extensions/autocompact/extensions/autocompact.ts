/**
 * Autocompact — Intelligent Session Context Compaction for Pi
 *
 * Replaces default compaction with comprehensive summaries that preserve:
 * - Goals, Constraints, Progress (Done/In-Progress/Blocked)
 * - Key Decisions, Next Steps, Critical Context
 * - Cumulative read/modified files
 * - Plan/todo items with [DONE:n] completion markers
 * - User-stated preferences
 *
 * Features:
 * - Idle pre-warming at 70% context (agent_settled + 15s debounce)
 * - Cheap model override via autocompact.model setting
 * - Status footer with context percent + reserve headroom
 * - /autocompact command for status/toggle/compact/preview
 *
 * Usage:
 *   pi -e ./extensions/autocompact.ts
 *   pi install /path/to/autocompact
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { uuidv7 } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  convertToLlm,
  serializeConversation,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";

// ============================================================================
// Types
// ============================================================================

interface AutocompactSettings {
  enabled: boolean;
  reserveTokens: number;
  keepRecentTokens: number;
  prewarmThreshold: number;
  prewarmDebounceMs: number;
  model?: string;
  showStatus: boolean;
}

const DEFAULT_SETTINGS: AutocompactSettings = {
  enabled: true,
  reserveTokens: 16384,
  keepRecentTokens: 20000,
  prewarmThreshold: 0.7,
  prewarmDebounceMs: 15000,
  showStatus: true,
};

interface EnrichedDetails {
  readFiles: string[];
  modifiedFiles: string[];
  todos: { step: number; text: string; completed: boolean }[];
  planSteps: string[];
  version: 1;
}

// ============================================================================
// Helpers
// ============================================================================

/** Read settings from ~/.pi/agent/settings.json with fallback to compaction.* */
function resolveSettings(_ctx: ExtensionContext): AutocompactSettings {
  try {
    const settingsPath = join(getAgentDir(), "settings.json");
    const raw = JSON.parse(readFileSync(settingsPath, "utf8"));
    const ac = raw?.autocompact as Partial<AutocompactSettings> | undefined;
    const comp = raw?.compaction as Record<string, unknown> | undefined;
    return {
      enabled:
        ac?.enabled ?? (comp?.enabled as boolean) ?? DEFAULT_SETTINGS.enabled,
      reserveTokens:
        ac?.reserveTokens ??
        (comp?.reserveTokens as number) ??
        DEFAULT_SETTINGS.reserveTokens,
      keepRecentTokens:
        ac?.keepRecentTokens ??
        (comp?.keepRecentTokens as number) ??
        DEFAULT_SETTINGS.keepRecentTokens,
      prewarmThreshold:
        ac?.prewarmThreshold ?? DEFAULT_SETTINGS.prewarmThreshold,
      prewarmDebounceMs:
        ac?.prewarmDebounceMs ?? DEFAULT_SETTINGS.prewarmDebounceMs,
      model: ac?.model,
      showStatus: ac?.showStatus ?? DEFAULT_SETTINGS.showStatus,
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/** Extract todo items from conversation text */
function extractTodos(
  text: string,
): { step: number; text: string; completed: boolean }[] {
  const todos: { step: number; text: string; completed: boolean }[] = [];
  // Match "1. ☐ do something" or "1. [ ] do something" or "1. ✓ done" or "1. [x] done"
  const lines = text.split("\n");
  for (const line of lines) {
    const m = line.match(/^\s*(\d+)[.)]\s*(?:☐|\[[ ]\])\s*(.+)$/);
    if (m) {
      todos.push({
        step: parseInt(m[1], 10),
        text: m[2].trim(),
        completed: false,
      });
      continue;
    }
    const done = line.match(/^\s*(\d+)[.)]\s*(?:✓|☑|\[[xX]\])\s*(.+)$/);
    if (done) {
      todos.push({
        step: parseInt(done[1], 10),
        text: done[2].trim(),
        completed: true,
      });
    }
  }
  return todos;
}

/** Scan branch entries for plan/todo state */
function scanForPlanTodos(
  branchEntries: Array<{
    type: string;
    customType?: string;
    message?: unknown;
    data?: unknown;
  }>,
): { todos: EnrichedDetails["todos"]; planSteps: string[] } {
  const todos: EnrichedDetails["todos"] = [];
  const planSteps: string[] = [];

  for (const entry of branchEntries) {
    // Scan CustomMessage for plan context
    if (entry.type === "message" && entry.message) {
      const msg = entry.message as {
        role?: string;
        customType?: string;
        content?: string | Array<{ type: string; text?: string }>;
      };
      if (msg.role === "custom" && typeof msg.customType === "string") {
        if (
          msg.customType.includes("plan") ||
          msg.customType.includes("workflow")
        ) {
          const content =
            typeof msg.content === "string"
              ? msg.content
              : Array.isArray(msg.content)
                ? msg.content
                    .filter(
                      (c): c is { type: string; text: string } =>
                        c.type === "text",
                    )
                    .map((c) => c.text)
                    .join("\n")
                : "";
          // Extract todos from plan context
          const extracted = extractTodos(content);
          if (extracted.length > 0) todos.push(...extracted);
          // Extract Plan: header
          const planMatch = content.match(/Plan:\s*\n([\s\S]*?)(?:\n\n|$)/i);
          if (planMatch) {
            planSteps.push(
              ...planMatch[1]
                .split("\n")
                .filter((l: string) => l.trim().match(/^\d+[.)]\s/))
                .map((l: string) => l.trim()),
            );
          }
        }
      }
    }

    // Scan ToolResult.details.todos (from workflow_todo tool)
    if (entry.type === "message" && entry.message) {
      const msg = entry.message as {
        role?: string;
        toolName?: string;
        details?: unknown;
      };
      if (msg.role === "toolResult" && msg.details) {
        const details = msg.details as {
          todos?: Array<{ step: number; text: string; completed: boolean }>;
        };
        if (Array.isArray(details.todos) && details.todos.length > 0) {
          todos.push(...details.todos);
        }
      }
    }
  }

  // Deduplicate todos by step number, keep latest
  const seen = new Map<number, EnrichedDetails["todos"][0]>();
  for (const t of todos) {
    seen.set(t.step, t);
  }
  return {
    todos: [...seen.values()].sort((a, b) => a.step - b.step),
    planSteps,
  };
}

/** Build enriched details for compaction entry */
function buildEnrichedDetails(
  fileOps: { readFiles: string[]; modifiedFiles: string[] },
  branchEntries: Array<{
    type: string;
    customType?: string;
    message?: unknown;
    data?: unknown;
  }>,
): EnrichedDetails {
  const { todos, planSteps } = scanForPlanTodos(branchEntries);
  return {
    readFiles: fileOps.readFiles,
    modifiedFiles: fileOps.modifiedFiles,
    todos,
    planSteps,
    version: 1,
  };
}

/** Convert FileOperations {read: Set, written: Set, edited: Set} → {readFiles, modifiedFiles} */
function computeFileLists(fileOps: {
  read: Set<string>;
  written: Set<string>;
  edited: Set<string>;
}): { readFiles: string[]; modifiedFiles: string[] } {
  const readFiles = [...fileOps.read].sort();
  const modifiedFiles = [
    ...new Set([...fileOps.written, ...fileOps.edited]),
  ].sort();
  return { readFiles, modifiedFiles };
}

/** Estimate token count from text length (chars/4 heuristic) */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Build summary prompt from template + data */
function buildSummaryPrompt(
  conversationText: string,
  readFiles: string[],
  modifiedFiles: string[],
  previousSummary?: string,
  customInstructions?: string,
  todos?: EnrichedDetails["todos"],
  planSteps?: string[],
): string {
  const previousContext = previousSummary
    ? `\n\nPrevious session summary for context:\n${previousSummary}`
    : "";

  const todoSection =
    todos && todos.length > 0
      ? `\n\nActive todo items (preserve verbatim in summary):\n${todos.map((t) => `${t.step}. ${t.completed ? "✓" : "☐"} ${t.text}`).join("\n")}`
      : "";

  const planSection =
    planSteps && planSteps.length > 0
      ? `\n\nPlan steps (preserve verbatim in summary):\n${planSteps.join("\n")}`
      : "";

  return `You are a conversation summarizer for a coding agent. Create a comprehensive summary of this conversation that will replace the ENTIRE conversation history. The summary must be thorough and include all information needed to continue work effectively.
${previousContext}
## Structure the summary with these sections

## Goal
[What the user is trying to accomplish — the primary objective and any sub-goals]

## Constraints & Preferences
- [Requirements, preferences, and constraints mentioned by user]

## Progress
### Done
- [x] [Completed tasks with enough detail to understand what was achieved]

### In Progress
- [ ] [Current work — what was being worked on when the conversation was compacted]

### Blocked
- [Issues, errors, or dependencies blocking progress]

## Key Decisions
- **[Decision]**: [Rationale — why this approach was chosen over alternatives]

## Next Steps
1. [What should happen next — ordered by priority]

## Critical Context
- [Data, file paths, error messages, environment details needed to continue]
- [Plan file contents or plan steps if the user was in plan mode]
- [Active todo items with their completion status]
- [User preferences that should be respected going forward]
${customInstructions ? `\n## User Focus\n${customInstructions}\n` : ""}
## Important Rules

1. Preserve plan-mode todo items **verbatim** with their completion status ([DONE:n] markers)
2. Include ALL file paths that were read or modified
3. Preserve error messages and blockers exactly as they occurred
4. Include user-stated preferences (e.g., "always use TypeScript", "never modify .env")
5. If there was a plan file (Plan: or TODO: sections), preserve its contents
6. Be thorough but concise — avoid filler, focus on actionable information
${todoSection}${planSection}

<read-files>
${readFiles.join("\n")}
</read-files>

<modified-files>
${modifiedFiles.join("\n")}
</modified-files>

<conversation>
${conversationText}
</conversation>`;
}

// ============================================================================
// Extension Entry
// ============================================================================

export default function autocompact(pi: ExtensionAPI) {
  // State (in-memory, reset on session_start)
  let lastCompactionTimestamp = 0;
  let previousTokens: number | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let autoCompactionEnabled = true;

  pi.registerFlag("autocompact", {
    description: "Enable autocompact extension",
    type: "boolean",
    default: true,
  });

  // --- Session lifecycle ---

  pi.on("session_start", async (_event, ctx) => {
    // Reset state on new session
    lastCompactionTimestamp = 0;
    previousTokens = null;
    autoCompactionEnabled = true;

    // Check flag override
    if (pi.getFlag("autocompact") === false) {
      autoCompactionEnabled = false;
    }

    // Update status footer
    updateStatus(ctx);
  });

  pi.on("session_shutdown", async () => {
    // Clear idle timer on shutdown
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  });

  // --- Status footer ---

  function updateStatus(ctx: ExtensionContext): void {
    if (!ctx.hasUI) return;
    const settings = resolveSettings(ctx);
    if (!settings.showStatus || !autoCompactionEnabled) {
      ctx.ui.setStatus("autocompact", undefined);
      return;
    }

    const usage = ctx.getContextUsage();
    if (!usage) {
      ctx.ui.setStatus("autocompact", undefined);
      return;
    }

    const percent =
      usage.tokens == null
        ? 0
        : Math.round((usage.tokens / usage.contextWindow) * 100);
    const threshold = Math.round(settings.prewarmThreshold * 100);

    if (percent >= threshold) {
      ctx.ui.setStatus(
        "autocompact",
        ctx.ui.theme.fg("warning", `◐ ${percent}% compact`),
      );
    } else {
      ctx.ui.setStatus(
        "autocompact",
        ctx.ui.theme.fg("muted", `◐ ${percent}%`),
      );
    }
  }

  // --- Trigger engine: threshold + overflow + idle pre-warming ---

  // The core `session_before_compact` hook intercepts ALL compaction
  // (threshold, overflow, manual) and provides intelligent summaries
  pi.on("session_before_compact", async (event, ctx) => {
    if (!autoCompactionEnabled) return;

    const { preparation, branchEntries, customInstructions, reason, signal } =
      event;

    // Skip if aborted
    if (signal?.aborted) return;

    const settings = resolveSettings(ctx);
    const allMessages = [
      ...preparation.messagesToSummarize,
      ...preparation.turnPrefixMessages,
    ];

    // Build enriched details with plan/todo extraction (computeFileLists converts FileOperations→{readFiles,modifiedFiles})
    const fileLists = computeFileLists(preparation.fileOps);
    const details = buildEnrichedDetails(fileLists, branchEntries);

    // Resolve summarizer model
    let model;
    if (settings.model) {
      const [provider, ...rest] = settings.model.split("/");
      const modelId = rest.join("/");
      model = ctx.modelRegistry.find(provider, modelId);
      if (!model) {
        ctx.ui.notify(
          `autocompact: model "${settings.model}" not found, using default`,
          "warning",
        );
      }
    }
    if (!model) {
      model = ctx.model;
    }

    if (!model) {
      ctx.ui.notify(
        "autocompact: no model available, falling back to native compaction",
        "warning",
      );
      return;
    }

    // Serialize conversation for summarizer
    const conversationText = serializeConversation(convertToLlm(allMessages));

    // Build summary prompt
    const summaryText = buildSummaryPrompt(
      conversationText,
      details.readFiles,
      details.modifiedFiles,
      preparation.previousSummary,
      customInstructions,
      details.todos,
      details.planSteps,
    );

    // Build messages for LLM call
    const summaryMessages = [
      {
        role: "user" as const,
        content: [{ type: "text" as const, text: summaryText }],
        timestamp: Date.now(),
      },
    ];

    const reasonLabel =
      reason === "overflow"
        ? "overflow recovery"
        : reason === "threshold"
          ? "threshold"
          : "manual";
    ctx.ui.notify(
      `autocompact (${reasonLabel}): summarizing ${allMessages.length} messages (${preparation.tokensBefore.toLocaleString()} tokens)...`,
      "info",
    );

    try {
      const response = await ctx.modelRegistry.complete(
        model,
        { messages: summaryMessages },
        {
          maxTokens: 8192,
          signal,
          cacheRetention: "none",
          sessionId: uuidv7(),
        },
      );

      const summary = response.content
        .filter((c): c is { type: "text"; text: string } => c.type === "text")
        .map((c) => c.text)
        .join("\n");

      if (!summary.trim()) {
        if (!signal?.aborted) {
          ctx.ui.notify(
            "autocompact: summary was empty, falling back to native compaction",
            "warning",
          );
        }
        return;
      }

      // Return compaction result — SessionManager saves with fromHook=true
      return {
        compaction: {
          summary,
          firstKeptEntryId: preparation.firstKeptEntryId,
          tokensBefore: preparation.tokensBefore,
          usage: response.usage,
          details,
        },
      };
    } catch (error) {
      if (signal?.aborted) return;
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(
        `autocompact: summarization failed (${message}), falling back to native`,
        "error",
      );
      // Return undefined to let core compaction run
      return;
    }
  });

  // --- Idle pre-warming on agent_settled ---

  pi.on("agent_settled", async (_event, ctx) => {
    if (!autoCompactionEnabled) return;

    const settings = resolveSettings(ctx);
    if (!settings.enabled) return;

    // Clear any pending idle timer
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }

    // Check context usage
    const usage = ctx.getContextUsage();
    if (!usage) return;

    const percent =
      usage.tokens == null ? 0 : usage.tokens / usage.contextWindow;
    const threshold = settings.prewarmThreshold;

    // Only pre-warm if above threshold
    if (percent < threshold) return;

    // Debounce: only compact if enough time since last compaction
    const now = Date.now();
    if (now - lastCompactionTimestamp < settings.prewarmDebounceMs) return;

    // Track previous tokens to avoid thrashing
    if (
      previousTokens !== null &&
      usage.tokens != null &&
      usage.tokens <= previousTokens
    )
      return;
    previousTokens = usage.tokens ?? previousTokens;

    // Schedule pre-warming with debounce
    idleTimer = setTimeout(() => {
      if (!ctx.isIdle()) return;
      if (ctx.signal?.aborted) return;

      lastCompactionTimestamp = Date.now();
      ctx.compact({
        customInstructions:
          "Pre-warming compaction — context at high capacity. Summarize for continuity, preserving all critical context, todo items, and plan state.",
        onComplete: () => {
          if (ctx.hasUI) {
            ctx.ui.notify("autocompact: pre-warming completed", "info");
            updateStatus(ctx);
          }
        },
        onError: (error) => {
          if (ctx.hasUI) {
            ctx.ui.notify(
              `autocompact: pre-warming failed (${error.message})`,
              "error",
            );
          }
        },
      });
    }, settings.prewarmDebounceMs);
  });

  // --- Turn-end: update status ---

  pi.on("turn_end", async (_event, ctx) => {
    updateStatus(ctx);
  });

  // --- /autocompact command ---

  pi.registerCommand("autocompact", {
    description:
      "Autocompact context management (status|on|off|compact|preview)",
    getArgumentCompletions: (argPrefix: string) => {
      const items = ["status", "on", "off", "compact", "preview"];
      const filtered = items.filter((i) => i.startsWith(argPrefix));
      return filtered.map((i) => ({ label: i, value: i, description: i }));
    },
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/);
      const sub = parts[0]?.toLowerCase() ?? "";
      const focus = parts.slice(1).join(" ").trim();

      if (!sub || sub === "status") {
        const usage = ctx.getContextUsage();
        if (usage) {
          const percent =
            usage.tokens == null
              ? 0
              : Math.round((usage.tokens / usage.contextWindow) * 100);
          const settings = resolveSettings(ctx);
          const timeSinceLast =
            lastCompactionTimestamp > 0
              ? `${Math.round((Date.now() - lastCompactionTimestamp) / 1000)}s ago`
              : "never";
          ctx.ui.notify(
            `autocompact: ${percent}% context (${usage.tokens?.toLocaleString() ?? "?"}/${usage.contextWindow.toLocaleString()} tokens)\n` +
              `enabled: ${autoCompactionEnabled} | threshold: ${Math.round(settings.prewarmThreshold * 100)}% | last compact: ${timeSinceLast}`,
            "info",
          );
        } else {
          ctx.ui.notify("autocompact: no context usage data available", "info");
        }
        return;
      }

      if (sub === "on") {
        autoCompactionEnabled = true;
        ctx.ui.notify("autocompact: enabled", "info");
        updateStatus(ctx);
        return;
      }

      if (sub === "off") {
        autoCompactionEnabled = false;
        ctx.ui.notify("autocompact: disabled", "info");
        updateStatus(ctx);
        return;
      }

      if (sub === "compact") {
        ctx.ui.notify("autocompact: starting manual compaction...", "info");
        ctx.compact({
          customInstructions: focus || undefined,
          onComplete: () => {
            ctx.ui.notify("autocompact: compaction completed", "info");
            updateStatus(ctx);
          },
          onError: (error) => {
            ctx.ui.notify(
              `autocompact: compaction failed (${error.message})`,
              "error",
            );
          },
        });
        return;
      }

      if (sub === "preview") {
        const branch = ctx.sessionManager.getBranch();
        const allText = branch
          .filter(
            (e): e is typeof e & { message: { content: unknown } } =>
              e.type === "message" && "message" in e,
          )
          .map((e) => {
            const msg = e.message;
            if (typeof msg.content === "string") return msg.content;
            if (Array.isArray(msg.content)) {
              return msg.content
                .filter(
                  (c): c is { type: string; text: string } => c.type === "text",
                )
                .map((c) => c.text)
                .join("\n");
            }
            return "";
          })
          .join("\n");

        const tokenEstimate = estimateTokens(allText);
        ctx.ui.notify(
          `autocompact preview: ~${tokenEstimate.toLocaleString()} tokens estimated for serialization\n` +
            `(${branch.length} entries on current branch)`,
          "info",
        );
        return;
      }

      ctx.ui.notify(
        `autocompact: unknown subcommand "${sub}"\nUsage: /autocompact [status|on|off|compact [focus]|preview]`,
        "error",
      );
    },
  });
}
