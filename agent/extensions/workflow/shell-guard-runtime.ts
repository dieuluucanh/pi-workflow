/**
 * Workflow Extension — shell guard runtime adapter.
 *
 * Bridges the pure guard (`shell-guard.ts`) to Pi's tool lifecycle without
 * replacing the built-in bash tool:
 *
 *   tool_call            → supply/cap timeout, refuse empty probes, refuse
 *                          invalid timeouts, block after a trip
 *   tool_result          → classify a native deadline, append guidance
 *   tool_execution_end   → finalize calls that never reached tool_result
 *
 * The recovery budget is request-scoped. It is reset by a genuine user prompt
 * handler, never by an automatic continuation, retry or compaction.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  SHELL_GUARD_AUDIT_ENTRY,
  classifyShellFailureText,
  createShellGuardRecovery,
  detectEmptyInterpreterProbe,
  emptyProbeReason,
  isGuardedShellTool,
  normalizeShellTimeout,
  shellFailureGuidance,
  type ShellGuardFailureKind,
  type ShellGuardToolName,
  type ShellLimits,
} from "./shell-guard.ts";

export interface PreparedShellCall {
  toolCallId: string;
  toolName: ShellGuardToolName;
  command: string;
  timeoutSeconds?: number;
  addedDefault: boolean;
  capped: boolean;
  /** The guard blocked this call before execution. */
  blocked?: "empty-probe" | "invalid-timeout";
}

export interface ShellGuardResultEvent {
  toolName?: unknown;
  toolCallId?: unknown;
  content?: unknown;
  isError?: unknown;
  durationMs?: unknown;
}

export interface ShellGuardRuntimeDeps {
  limits: () => ShellLimits;
  notify?: (message: string, level?: "info" | "warning" | "error") => void;
  log?: (message: string, level?: "info" | "warning" | "error") => void;
  /** Persist a durable audit entry (never raw command text/output). */
  record?: (data: Record<string, unknown>) => void;
  /** Stop the current agent run without awaiting idle. */
  abort?: () => void;
  now?: () => number;
}

export interface ShellGuardRuntime {
  /**
   * Normalize or block a tool call. Mutates `input.timeout` in place for an
   * allowed shell call, exactly as Pi documents for `tool_call` handlers.
   */
  prepare(
    event: { toolName?: unknown; toolCallId?: unknown; input?: unknown },
  ): { block: true; reason: string } | undefined;
  /** Result hook: classify a failure, append guidance, trip if needed. */
  observeResult(
    event: ShellGuardResultEvent,
  ): { content?: unknown; isError?: boolean } | undefined;
  /** End hook: finalize calls that skipped `tool_result`. */
  observeEnd(event: ShellGuardResultEvent): void;
  reset(reason: string): void;
  isStopped(): boolean;
  stoppedReason(): string | undefined;
  snapshot(): {
    failures: number;
    stopped: boolean;
    stoppedReason?: string;
    kinds: ShellGuardFailureKind[];
    limits: ShellLimits;
    pending: number;
    blocked: number;
  };
}

const MAX_PREPARED = 100;

function textOfContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      const text = (part as { text?: unknown }).text;
      return typeof text === "string" ? text : "";
    })
    .filter(Boolean)
    .join("\n");
}

function resultText(event: ShellGuardResultEvent): string {
  const direct = textOfContent(event.content);
  if (direct) return direct;
  const result = (event as { result?: unknown }).result;
  if (result && typeof result === "object") {
    const nested = textOfContent((result as { content?: unknown }).content);
    if (nested) return nested;
  }
  return "";
}

function resultIsError(event: ShellGuardResultEvent): boolean {
  if (event.isError === true) return true;
  const result = (event as { result?: unknown }).result;
  return Boolean(
    result &&
      typeof result === "object" &&
      (result as { isError?: unknown }).isError === true,
  );
}

/**
 * Create one request-scoped guard. A new runtime instance is per session;
 * `reset` is the request boundary.
 */
export function createShellGuardRuntime(
  deps: ShellGuardRuntimeDeps,
): ShellGuardRuntime {
  const recovery = createShellGuardRecovery();
  const prepared = new Map<string, PreparedShellCall>();
  const observed = new Set<string>();
  let notifiedStop: string | undefined;

  const notify = (
    message: string,
    level: "info" | "warning" | "error" = "warning",
  ): void => {
    try {
      deps.notify?.(message, level);
    } catch {
      /* notifications are best-effort */
    }
  };

  const audit = (data: Record<string, unknown>): void => {
    try {
      deps.record?.({ entry: SHELL_GUARD_AUDIT_ENTRY, at: Date.now(), ...data });
    } catch {
      /* audit is best-effort */
    }
  };

  const trimPrepared = (): void => {
    while (prepared.size > MAX_PREPARED) {
      const oldest = prepared.keys().next().value;
      if (oldest === undefined) break;
      prepared.delete(oldest);
      observed.delete(oldest);
    }
  };

  const recordFailure = (
    kind: ShellGuardFailureKind,
    call: PreparedShellCall,
    extra: Record<string, unknown> = {},
  ) => {
    const decision = recovery.recordFailure({
      kind,
      command: call.command,
      at: deps.now?.(),
    });
    audit({
      kind,
      decision: decision.action,
      failures: decision.failures,
      tool: call.toolName,
      toolCallId: call.toolCallId,
      timeoutSeconds: call.timeoutSeconds,
      ...extra,
    });
    if (decision.action === "stop") {
      if (notifiedStop !== decision.reason) {
        notifiedStop = decision.reason;
        notify(
          `Shell guard stopped this request: ${decision.reason}. Start a new prompt to continue.`,
          "warning",
        );
      }
      try {
        deps.abort?.();
      } catch {
        /* abort is best-effort */
      }
    }
    return decision;
  };

  return {
    prepare(event) {
      if (!isGuardedShellTool(event.toolName)) return undefined;
      const toolName = event.toolName;
      const toolCallId =
        typeof event.toolCallId === "string" ? event.toolCallId : "";
      if (!toolCallId) return undefined;
      if (recovery.isStopped()) {
        return {
          block: true,
          reason: [
            `shell guard: this request is stopped — ${recovery.stoppedReason() ?? "a repeated shell failure"}.`,
            "No further shell calls run automatically. Report the current state and wait for the user's next instruction.",
          ].join(" "),
        };
      }
      const input = event.input;
      if (!input || typeof input !== "object") return undefined;
      const command =
        typeof (input as { command?: unknown }).command === "string"
          ? (input as { command: string }).command
          : "";
      if (!command.trim()) return undefined;

      const limits = deps.limits();
      const call: PreparedShellCall = {
        toolCallId,
        toolName,
        command,
        addedDefault: false,
        capped: false,
      };

      const probe = detectEmptyInterpreterProbe(command);
      if (probe.kind === "empty-probe") {
        call.blocked = "empty-probe";
        prepared.set(toolCallId, call);
        trimPrepared();
        recordFailure("empty-probe", call, { interpreter: probe.interpreter });
        return { block: true, reason: emptyProbeReason(probe) };
      }

      const timeout = normalizeShellTimeout(input, limits, toolName);
      if (!timeout.ok) {
        call.blocked = "invalid-timeout";
        prepared.set(toolCallId, call);
        trimPrepared();
        recordFailure("invalid-timeout", call);
        return { block: true, reason: timeout.error };
      }

      const requestedTimeout = (input as { timeout?: unknown }).timeout;
      (input as { timeout?: number }).timeout = timeout.timeoutSeconds;
      call.timeoutSeconds = timeout.timeoutSeconds;
      call.addedDefault = timeout.source === "default";
      call.capped = timeout.capped;
      prepared.set(toolCallId, call);
      trimPrepared();
      if (timeout.capped) {
        audit({
          kind: "capped",
          tool: toolName,
          toolCallId,
          requested: requestedTimeout,
          timeoutSeconds: timeout.timeoutSeconds,
        });
      }
      return undefined;
    },

    observeResult(event) {
      if (!isGuardedShellTool(event.toolName)) return undefined;
      const id = typeof event.toolCallId === "string" ? event.toolCallId : "";
      const call = prepared.get(id);
      if (!call || call.blocked || observed.has(id)) return undefined;
      if (!resultIsError(event)) {
        observed.add(id);
        return undefined;
      }
      const text = resultText(event);
      const kind = classifyShellFailureText(text);
      if (!kind) {
        observed.add(id);
        return undefined;
      }
      observed.add(id);
      const decision = recordFailure(kind, call, {
        durationMs: typeof event.durationMs === "number" ? event.durationMs : undefined,
      });
      const guidance = shellFailureGuidance(kind, decision);
      const baseContent = Array.isArray(event.content)
        ? event.content
        : typeof event.content === "string" && event.content
          ? [{ type: "text", text: event.content }]
          : [];
      return {
        content: [...baseContent, { type: "text", text: guidance }],
        isError: true,
      };
    },

    observeEnd(event) {
      const id = typeof event.toolCallId === "string" ? event.toolCallId : "";
      if (!id) return;
      const call = prepared.get(id);
      if (!call || call.blocked || observed.has(id)) {
        if (call?.blocked) {
          prepared.delete(id);
          observed.delete(id);
        }
        return;
      }
      if (!resultIsError(event)) {
        observed.add(id);
        prepared.delete(id);
        return;
      }
      const text = resultText(event);
      const kind = classifyShellFailureText(text);
      if (kind) {
        observed.add(id);
        recordFailure(kind, call, {
          durationMs:
            typeof event.durationMs === "number" ? event.durationMs : undefined,
          via: "tool_execution_end",
        });
      }
      prepared.delete(id);
      observed.delete(id);
    },

    reset(reason) {
      recovery.reset();
      prepared.clear();
      observed.clear();
      notifiedStop = undefined;
      audit({ kind: "reset", reason });
    },

    isStopped: () => recovery.isStopped(),
    stoppedReason: () => recovery.stoppedReason(),
    snapshot: () => ({
      ...recovery.snapshot(),
      limits: deps.limits(),
      pending: prepared.size,
      blocked: [...prepared.values()].filter((c) => c.blocked !== undefined).length,
    }),
  };
}

/** Convenience: notify target for the extension context (best-effort). */
export function notifyShellGuard(
  ctx: ExtensionContext | undefined,
  message: string,
  level: "info" | "warning" | "error" = "warning",
): void {
  try {
    (ctx as { ui?: { notify?: (m: string, l?: string) => void } } | undefined)
      ?.ui?.notify?.(message, level);
  } catch {
    /* best-effort */
  }
}
