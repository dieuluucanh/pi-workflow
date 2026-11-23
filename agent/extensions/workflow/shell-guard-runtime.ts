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
import { shellCommandHash } from "./execution-state.ts";

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
  structuredContent?: unknown;
  result?: unknown;
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
  /** Restore a persisted execution quarantine without counting a new failure. */
  adoptQuarantine(input: { reason: string; commandHash?: string; at?: number }): void;
  quarantineInfo(): { reason: string; commandHash?: string; at: number } | undefined;
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

function structuredExitCode(event: ShellGuardResultEvent): number | undefined {
  const direct = event.structuredContent;
  const nested = event.result;
  for (const value of [direct, nested]) {
    if (!value || typeof value !== "object") continue;
    const code = (value as { exit_code?: unknown }).exit_code;
    if (typeof code === "number" && Number.isFinite(code)) return code;
    const inner = (value as { structuredContent?: unknown }).structuredContent;
    if (inner && typeof inner === "object") {
      const innerCode = (inner as { exit_code?: unknown }).exit_code;
      if (typeof innerCode === "number" && Number.isFinite(innerCode)) {
        return innerCode;
      }
    }
  }
  return undefined;
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
  let lastQuarantine:
    | { reason: string; commandHash?: string; at: number }
    | undefined;

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
      lastQuarantine = {
        reason: decision.reason,
        commandHash: shellCommandHash(call.command),
        at: deps.now?.() ?? Date.now(),
      };
      if (notifiedStop !== decision.reason) {
        notifiedStop = decision.reason;
        notify(
          `Shell guard quarantined shell for this execution: ${decision.reason}. Continue with non-shell tools; start a new prompt or use /shell-guard reset only when you intend a new shell budget.`,
          "warning",
        );
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
            `shell guard: shell is quarantined for this execution — ${recovery.stoppedReason() ?? "a repeated shell failure"}.`,
            "Do not call shell tools. Continue with non-shell tools (read, grep, find, ls, edit, write, LSP diagnostics); do not mark a shell-dependent row complete.",
            "If no permitted action can advance, report a structured blocker instead of waiting for the user.",
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
      // A structured exit status is authoritative. Fixture/test output that
      // merely prints a timeout sentence must not consume the guard budget.
      const exitCode = structuredExitCode(event);
      const kind =
        exitCode === undefined ? classifyShellFailureText(text) : undefined;
      if (!kind) {
        observed.add(id);
        return undefined;
      }
      observed.add(id);
      const decision = recordFailure(kind, call, {
        durationMs: typeof event.durationMs === "number" ? event.durationMs : undefined,
      });
      const guidance = shellFailureGuidance(kind, decision);
      let baseContent: unknown[] = [];
      if (Array.isArray(event.content)) {
        baseContent = event.content;
      } else if (typeof event.content === "string" && event.content) {
        baseContent = [{ type: "text", text: event.content }];
      }
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
      const exitCode = structuredExitCode(event);
      const kind =
        exitCode === undefined ? classifyShellFailureText(text) : undefined;
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
      lastQuarantine = undefined;
      audit({ kind: "reset", reason });
    },

    adoptQuarantine({ reason, commandHash, at }) {
      if (recovery.isStopped()) return;
      recovery.quarantine({ reason, command: commandHash, at });
      prepared.clear();
      observed.clear();
      notifiedStop = reason;
      lastQuarantine = {
        reason,
        ...(commandHash === undefined ? {} : { commandHash }),
        at: at ?? Date.now(),
      };
      audit({ kind: "adopt-quarantine", reason, at });
    },

    quarantineInfo: () => lastQuarantine,

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
