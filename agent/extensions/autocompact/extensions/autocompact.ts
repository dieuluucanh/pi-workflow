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
 * Overflow safety: every summarizer request is bounded to the model's context
 * window (single call, or chunked fold-reduce when the conversation is larger),
 * and when LLM summarization fails entirely a deterministic fallback summary is
 * returned instead. While autocompact is enabled the `session_before_compact`
 * hook always answers, so an over-context session can always continue instead
 * of getting bricked.
 *
 * Features:
 * - Idle pre-warming at 70% context (agent_settled + debounce)
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
import type { Api, Model } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { convertToLlm, getAgentDir } from "@earendil-works/pi-coding-agent";
import {
  buildFallbackSummary,
  summarizeWithFallback,
  type CompleteFn,
  type SummarizeInput,
  type SummarizeStrategy,
  type SummarizerModel,
  type SummarizerStructured,
} from "../summarizer.ts";
import {
  decideFire,
  decideSelfHeal,
  decideTrigger,
  RETRY_POLL_MS,
} from "../trigger.ts";

// ============================================================================
// Types
// ============================================================================

/** Backoff (ms) before the one-shot self-heal retry after a failed compaction. */
const SELF_HEAL_RETRY_DELAY_MS = 3000;

interface AutocompactSettings {
  enabled: boolean;
  reserveTokens: number;
  keepRecentTokens: number;
  prewarmThreshold: number;
  prewarmDebounceMs: number;
  /** Context fraction at which compaction fires without waiting for the debounce. */
  hardTriggerThreshold: number;
  /** Max chunks for fold-reduce summarization before middle-digest trimming. */
  maxSummarizerChunks: number;
  model?: string;
  showStatus: boolean;
}

const DEFAULT_SETTINGS: AutocompactSettings = {
  enabled: true,
  reserveTokens: 16384,
  keepRecentTokens: 20000,
  prewarmThreshold: 0.7,
  prewarmDebounceMs: 15000,
  hardTriggerThreshold: 0.9,
  maxSummarizerChunks: 8,
  showStatus: true,
};

interface EnrichedDetails {
  readFiles: string[];
  modifiedFiles: string[];
  todos: { step: number; text: string; completed: boolean }[];
  planSteps: string[];
  version: 1;
  /** How the summary was produced: single call, fold-reduce, or deterministic fallback. */
  strategy?: SummarizeStrategy;
  /** Present when strategy === "fallback": why the LLM path failed. */
  fallbackReason?: string;
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
    const fraction = (value: unknown, fallback: number): number => {
      const n = typeof value === "number" ? value : Number.NaN;
      if (!Number.isFinite(n)) return fallback;
      return Math.min(1, Math.max(0, n));
    };
    const count = (value: unknown, fallback: number): number => {
      const n = typeof value === "number" ? value : Number.NaN;
      if (!Number.isFinite(n) || n < 1) return fallback;
      return Math.floor(n);
    };
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
      prewarmThreshold: fraction(
        ac?.prewarmThreshold,
        DEFAULT_SETTINGS.prewarmThreshold,
      ),
      prewarmDebounceMs:
        ac?.prewarmDebounceMs ?? DEFAULT_SETTINGS.prewarmDebounceMs,
      hardTriggerThreshold: fraction(
        ac?.hardTriggerThreshold,
        DEFAULT_SETTINGS.hardTriggerThreshold,
      ),
      maxSummarizerChunks: count(
        ac?.maxSummarizerChunks,
        DEFAULT_SETTINGS.maxSummarizerChunks,
      ),
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

  let snapshotTodos: EnrichedDetails["todos"] | undefined;
  for (const entry of branchEntries) {
    // Authoritative snapshot: the latest workflow custom entry's todos.
    if (
      entry.type === "custom" &&
      (entry as any).customType === "workflow" &&
      Array.isArray((entry as any).data?.todos)
    ) {
      snapshotTodos = (entry as any).data.todos as EnrichedDetails["todos"];
    }
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

  // Prefer the latest workflow snapshot wholesale — it already carries the
  // authoritative completion state, so step-key last-writer-wins cannot reset
  // a completed item back to pending.
  if (snapshotTodos && snapshotTodos.length > 0) {
    return {
      todos: [...snapshotTodos].sort((a, b) => a.step - b.step),
      planSteps: dedupeLines(planSteps),
    };
  }

  // Legacy fallback: deduplicate todos by step number, keep latest.
  const seen = new Map<number, EnrichedDetails["todos"][0]>();
  for (const t of todos) {
    seen.set(t.step, t);
  }
  return {
    todos: [...seen.values()].sort((a, b) => a.step - b.step),
    planSteps: dedupeLines(planSteps),
  };
}

/** Dedupe plan-step lines while preserving order. */
function dedupeLines(lines: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const l of lines) {
    const k = l.trim().toLowerCase();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(l);
  }
  return out;
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

/**
 * Merge file lists from all previous compaction entries back into the
 * cumulative sets.
 *
 * Hook-sourced compactions are saved with `fromHook=true`, and core only folds
 * details of native compactions into `preparation.fileOps` — without this
 * merge the cumulative read/modified tracking would silently reset at every
 * autocompact compaction. Union across all compaction entries because native
 * compactions only fold their immediate predecessor's details.
 */
function mergePreviousCompactionFiles(
  fileLists: { readFiles: string[]; modifiedFiles: string[] },
  branchEntries: Array<{ type: string; details?: unknown }>,
): { readFiles: string[]; modifiedFiles: string[] } {
  const read = new Set(fileLists.readFiles);
  const modified = new Set(fileLists.modifiedFiles);
  for (const entry of branchEntries) {
    if (entry.type !== "compaction") continue;
    const details = entry.details as
      | { readFiles?: unknown; modifiedFiles?: unknown }
      | undefined;
    if (Array.isArray(details?.readFiles)) {
      for (const f of details.readFiles) {
        if (typeof f === "string") read.add(f);
      }
    }
    if (Array.isArray(details?.modifiedFiles)) {
      for (const f of details.modifiedFiles) {
        if (typeof f === "string") modified.add(f);
      }
    }
  }
  return { readFiles: [...read].sort(), modifiedFiles: [...modified].sort() };
}

/** Estimate token count from text length (chars/4 heuristic) */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Resolve the summarizer model: settings override first, then the current model. */
function resolveSummarizerModel(
  ctx: ExtensionContext,
  settings: AutocompactSettings,
): SummarizerModel | undefined {
  if (settings.model) {
    const [provider, ...rest] = settings.model.split("/");
    const modelId = rest.join("/");
    const found = ctx.modelRegistry.find(provider, modelId);
    if (found) return found;
    ctx.ui.notify(
      `autocompact: model "${settings.model}" not found, using current model`,
      "warning",
    );
  }
  return ctx.model ?? undefined;
}

/** Human label for a compaction trigger reason. */
function reasonLabel(reason: "manual" | "threshold" | "overflow"): string {
  if (reason === "overflow") return "overflow recovery";
  if (reason === "threshold") return "threshold";
  return "manual";
}

// ============================================================================
// Extension Entry
// ============================================================================

export default function autocompact(pi: ExtensionAPI) {
  // State (in-memory, reset on session_start)
  let lastCompactionTimestamp = 0;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let autoCompactionEnabled = true;
  let lastStrategy: SummarizeStrategy | null = null;
  let lastFallbackReason: string | null = null;
  // Self-heal state: one outstanding retry per failure chain, reset on success.
  let selfHealRetryPending = false;
  let selfHealTimer: ReturnType<typeof setTimeout> | null = null;

  pi.registerFlag("autocompact", {
    description: "Enable autocompact extension",
    type: "boolean",
    default: true,
  });

  // --- Session lifecycle ---

  pi.on("session_start", async (_event, ctx) => {
    // Reset state on new session
    lastCompactionTimestamp = 0;
    autoCompactionEnabled = true;
    lastStrategy = null;
    lastFallbackReason = null;
    selfHealRetryPending = false;

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
    if (selfHealTimer) {
      clearTimeout(selfHealTimer);
      selfHealTimer = null;
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

  // --- Compaction hook: bounded summarization with deterministic fallback ---
  //
  // The core `session_before_compact` hook intercepts ALL compaction
  // (threshold, overflow, manual). Summarizer input is bounded to the model's
  // window (single call or chunked fold-reduce — see summarizer.ts), and the
  // LLM path degrades to a deterministic fallback summary on failure. While
  // enabled, this hook always returns a compaction result: core's default
  // summarizer sends the whole conversation in one unbounded request and
  // cannot succeed once the context is full, so deferring to it would leave
  // the session stuck.

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
    const label = reasonLabel(reason);

    // Enrichment: plan/todo extraction + cumulative file tracking.
    const fileLists = mergePreviousCompactionFiles(
      computeFileLists(preparation.fileOps),
      branchEntries,
    );
    const details = buildEnrichedDetails(fileLists, branchEntries);

    const structured: SummarizerStructured = {
      todos: details.todos,
      planSteps: details.planSteps,
      readFiles: details.readFiles,
      modifiedFiles: details.modifiedFiles,
    };

    const model = resolveSummarizerModel(ctx, settings);
    const input: SummarizeInput = {
      model: model ?? { contextWindow: 0, maxTokens: 0 },
      messages: convertToLlm(allMessages),
      previousSummary: preparation.previousSummary,
      customInstructions,
      reserveTokens: settings.reserveTokens,
      structured,
      maxChunks: settings.maxSummarizerChunks,
      sessionId: uuidv7(),
    };

    ctx.ui.notify(
      `autocompact (${label}): summarizing ${allMessages.length} messages (${preparation.tokensBefore.toLocaleString()} tokens)...`,
      "info",
    );

    try {
      const result = model
        ? await summarizeWithFallback(
            {
              complete: (m, context, options) =>
                ctx.modelRegistry.complete(m as Model<Api>, context, options),
            },
            input,
          )
        : {
            summary: buildFallbackSummary(
              {
                messages: input.messages,
                previousSummary: preparation.previousSummary,
                structured,
              },
              "no summarizer model available",
            ),
            strategy: "fallback" as const,
            fallbackReason: "no summarizer model available",
          };

      if (signal?.aborted) return;

      if (result.strategy === "fallback") {
        ctx.ui.notify(
          `autocompact (${label}): LLM summarization failed (${result.fallbackReason}); using deterministic fallback summary`,
          "warning",
        );
      } else {
        const folds =
          result.strategy === "fold" && result.folds && result.folds > 1
            ? `, ${result.folds} parts`
            : "";
        ctx.ui.notify(
          `autocompact (${label}): summary ready (${result.strategy}${folds})`,
          "info",
        );
      }

      // Bookkeeping: a compaction just happened; reset trigger state.
      lastCompactionTimestamp = Date.now();
      lastStrategy = result.strategy;
      lastFallbackReason = result.fallbackReason ?? null;

      const enrichedDetails: EnrichedDetails = {
        ...details,
        strategy: result.strategy,
      };
      if (result.fallbackReason) {
        enrichedDetails.fallbackReason = result.fallbackReason;
      }

      // Return compaction result — SessionManager saves with fromHook=true
      return {
        compaction: {
          summary: result.summary,
          firstKeptEntryId: preparation.firstKeptEntryId,
          tokensBefore: preparation.tokensBefore,
          usage: result.usage,
          details: enrichedDetails,
        },
      };
    } catch (error) {
      if (signal?.aborted) return;
      const message = error instanceof Error ? error.message : String(error);
      // summarizeWithFallback already degrades internally; this net catches
      // unexpected errors (conversion, state access) so a failed hook never
      // defers to core's unbounded summarizer at overflow.
      try {
        const summary = buildFallbackSummary(
          {
            messages: input.messages,
            previousSummary: preparation.previousSummary,
            structured,
          },
          message,
        );
        lastCompactionTimestamp = Date.now();
        lastStrategy = "fallback";
        lastFallbackReason = message;
        ctx.ui.notify(
          `autocompact (${label}): summarizer crashed (${message}); using deterministic fallback summary`,
          "error",
        );
        return {
          compaction: {
            summary,
            firstKeptEntryId: preparation.firstKeptEntryId,
            tokensBefore: preparation.tokensBefore,
            details: {
              ...details,
              strategy: "fallback" as const,
              fallbackReason: message,
            },
          },
        };
      } catch {
        ctx.ui.notify(
          `autocompact (${label}): compaction failed (${message})`,
          "error",
        );
        return;
      }
    }
  });

  // --- Idle pre-warming on agent_settled (decisions in ../trigger.ts) ---

  function runPrewarmCompact(ctx: ExtensionContext): void {
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
  }

  function schedulePrewarm(ctx: ExtensionContext, delayMs: number): void {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      idleTimer = null;
      const action = decideFire({
        isIdle: ctx.isIdle(),
        aborted: ctx.signal?.aborted === true,
      });
      if (action === "cancel") return;
      if (action === "retry-later") {
        // A run is active — poll until the first idle gap instead of silently
        // dropping the attempt (the old behavior lost it until the next settle).
        schedulePrewarm(ctx, RETRY_POLL_MS);
        return;
      }
      // Re-check before compacting: context may have dropped (compaction or
      // context edit since scheduling) or be within the post-compaction debounce.
      const decision = decideTrigger({
        usage: ctx.getContextUsage(),
        settings: resolveSettings(ctx),
        lastCompactionTimestamp,
        now: Date.now(),
      });
      if (decision === "none" || decision === "debounce") return;
      runPrewarmCompact(ctx);
    }, delayMs);
  }

  pi.on("agent_settled", async (_event, ctx) => {
    if (!autoCompactionEnabled) return;

    const settings = resolveSettings(ctx);
    if (!settings.enabled) return;

    const decision = decideTrigger({
      usage: ctx.getContextUsage(),
      settings,
      lastCompactionTimestamp,
      now: Date.now(),
    });

    if (decision === "none") {
      // Context dropped below the pre-warm threshold (e.g. after a compaction
      // or context edit) — a pending attempt is no longer needed.
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
      return;
    }
    if (decision === "debounce") return;
    if (decision === "hard-fire") {
      // At/above the hard threshold: bypass the debounce entirely.
      schedulePrewarm(ctx, 0);
      return;
    }
    // "fire": schedule once and let the timer poll until idle. A pending
    // timer survives intervening runs instead of being reset by each settle,
    // so active use no longer starves the pre-warm.
    if (!idleTimer) {
      schedulePrewarm(ctx, settings.prewarmDebounceMs);
    }
  });

  // --- Compaction bookkeeping (covers native compactions too) ---

  pi.on("session_compact", async (_event, ctx) => {
    lastCompactionTimestamp = Date.now();
    updateStatus(ctx);
  });

  pi.on("session_compact_failed", async (event, ctx) => {
    updateStatus(ctx);

    // Self-heal: when core's compaction just failed (threshold/overflow), give
    // autocompact one bounded retry via the manual path. Our hook answers with
    // a bounded summarizer or a deterministic fallback, so this directly
    // un-bricks sessions where the native unbounded summarizer failed.
    if (
      decideSelfHeal({
        enabled: autoCompactionEnabled && resolveSettings(ctx).enabled,
        reason: event.reason,
        aborted: event.aborted,
        retryPending: selfHealRetryPending,
      }) === "skip"
    ) {
      return;
    }

    selfHealRetryPending = true;
    if (ctx.hasUI) {
      ctx.ui.notify(
        `autocompact: compaction failed (${event.errorMessage ?? "unknown error"}); retrying once via autocompact...`,
        "warning",
      );
    }
    if (selfHealTimer) clearTimeout(selfHealTimer);
    selfHealTimer = setTimeout(() => {
      selfHealTimer = null;
      if (!ctx.isIdle() || ctx.signal?.aborted) {
        // Busy or aborted at fire time: drop the retry (a new failure event
        // would re-arm it; the guard resets below on settle/compaction).
        selfHealRetryPending = false;
        return;
      }
      ctx.compact({
        customInstructions:
          "Recovery compaction — the previous automatic compaction failed. Summarize for continuity, preserving all critical context, todo items, and plan state.",
        onComplete: () => {
          selfHealRetryPending = false;
          if (ctx.hasUI) {
            ctx.ui.notify("autocompact: recovery compaction completed", "info");
            updateStatus(ctx);
          }
        },
        onError: () => {
          selfHealRetryPending = false;
          if (ctx.hasUI) {
            ctx.ui.notify(
              "autocompact: recovery compaction failed; run /autocompact compact to retry manually",
              "error",
            );
          }
        },
      });
    }, SELF_HEAL_RETRY_DELAY_MS);
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
          let strategyText = "—";
          if (lastStrategy === "fallback") {
            strategyText = `fallback${lastFallbackReason ? ` (${lastFallbackReason})` : ""}`;
          } else if (lastStrategy) {
            strategyText = lastStrategy;
          }
          ctx.ui.notify(
            `autocompact: ${percent}% context (${usage.tokens?.toLocaleString() ?? "?"}/${usage.contextWindow.toLocaleString()} tokens)\n` +
              `enabled: ${autoCompactionEnabled} | prewarm: ${Math.round(settings.prewarmThreshold * 100)}% | hard: ${Math.round(settings.hardTriggerThreshold * 100)}% | max chunks: ${settings.maxSummarizerChunks}\n` +
              `last compact: ${timeSinceLast} | last strategy: ${strategyText}`,
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
