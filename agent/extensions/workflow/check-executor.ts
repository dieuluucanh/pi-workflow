/**
 * Workflow Extension — the single CheckExecutor.
 *
 * Every executable check — a row check, the plan's final gate and the Build
 * `workflow_execution verify` surface — goes through this module. Before this
 * module the same command could be run three different ways: a nested bash tool
 * with a 120s literal, a headless `spawn` with a different timeout, or no
 * workspace root at all. The 2026-11-21 incident was one consequence: an
 * unvalidated Markdown sentence reached a shell.
 *
 * The executor is a pipeline, applied identically to both transports:
 *
 *   parse/validate the typed check -> resolve the workspace root ->
 *   resolve the deadline (per-check or the configured shell maximum) ->
 *   execute -> bound the output -> classify the failure -> return evidence
 *
 * Two transports, one rule set:
 *   - `createHostCheckTransport` uses the host's nested `bash` tool, so the
 *     shell guard, role policy and process-tree cancellation all apply.
 *   - `createHeadlessCheckTransport` is the `spawn` fallback for hosts without
 *     nested tool execution. It re-validates the command, clamps the deadline
 *     to the shell-guard hard cap and bounds the output itself, so it is never
 *     a silent bypass of the guard.
 *
 * Failure classes (`test`, `timeout`, `metadata`, `policy`, `environment`,
 * `manual`) are returned as data. Only `test`/`timeout` are repairable; a
 * metadata/policy/environment failure must block with a concrete fix instead
 * of consuming a repair round.
 */

import { spawnSync } from "node:child_process";

import {
  primaryWorkspace,
  resolveWorkspaceAlias,
  scopeCommandToWorkspace,
  type WorkspaceSet,
} from "./orchestrator-workspace-set.ts";
import { validateCommandShape } from "./plan-command-shape.ts";
import { validateCheckSpec, type CheckKind, type CheckSpec } from "./plan-spec.ts";
import { HARD_MAX_SHELL_TIMEOUT_SECONDS } from "./shell-guard.ts";
import { resolveVerificationDeadline } from "./verification-deadline.ts";

/** Output is evidence, not a transcript: every transport returns at most this. */
export const MAX_CHECK_OUTPUT_CHARS = 2_000;

/** A hung `git` must not block the diff/baseline path forever. */
export const DEFAULT_GIT_TIMEOUT_MS = 60_000;
export const MAX_GIT_OUTPUT_CHARS = 64_000;

export const CHECK_FAILURE_CLASSES = [
  "none",
  "test",
  "timeout",
  "metadata",
  "policy",
  "environment",
  "manual",
] as const;
export type CheckFailureClass = (typeof CHECK_FAILURE_CLASSES)[number];

/**
 * Only a genuine check failure may start a repair round. Everything else is a
 * configuration/contract problem: re-prompting the child cannot fix it.
 */
export function isRepairableFailure(failureClass: CheckFailureClass): boolean {
  return failureClass === "test" || failureClass === "timeout";
}

export interface CheckExecutionResult {
  /** Stable identity; `check-N` when the source carried no id. */
  checkId: string;
  command: string;
  kind: CheckKind;
  ok: boolean;
  failureClass: CheckFailureClass;
  repairable: boolean;
  exitCode: number | null;
  output: string;
  truncated: boolean;
  durationMs: number;
  workspaceId?: string;
  workspaceRoot?: string;
  /** Short, deterministic failure text; empty on success. */
  message: string;
}

export interface CheckWorkspaceHint {
  /** Alias → root bindings for the current run. */
  set?: WorkspaceSet;
  /** The root bound to the current row (or the surface's explicit root). */
  boundRoot?: string;
  /** Roots the diff observed as changed; one unambiguous root is usable. */
  changedRoots?: readonly string[];
  /** Last-resort cwd when no set is bound (the session root in production). */
  fallbackRoot?: string;
}

export interface CheckGuardDecision {
  blocked: boolean;
  reason?: string;
  /** Guard refusals are policy by default; a bounded tool is environment. */
  failureClass?: Extract<CheckFailureClass, "policy" | "environment" | "metadata">;
}

export interface CheckTransportRequest {
  /** Exact command bytes the caller asked for. */
  command: string;
  /** The same command scoped to `cwd` (used by the host transport). */
  scopedCommand: string;
  cwd?: string;
  timeoutSeconds: number;
  timeoutMs: number;
  /** Deterministic deadline text, so a transport never invents "120 seconds". */
  timeoutMessage: string;
  signal?: AbortSignal;
}

export interface CheckTransportResponse {
  ok: boolean;
  exitCode?: number | null;
  output?: string;
  timedOut?: boolean;
  /** A refusal that happened before/inside the transport, not a test failure. */
  refused?: Extract<CheckFailureClass, "policy" | "environment" | "metadata">;
  error?: string;
}

export interface CheckTransport {
  readonly kind: "host" | "headless";
  run(request: CheckTransportRequest): Promise<CheckTransportResponse>;
}

export interface CheckTransportOutput {
  ok: boolean;
  output: string;
  exitCode: number | null;
  timedOut: boolean;
  refused?: Extract<CheckFailureClass, "policy" | "environment" | "metadata">;
  error?: string;
}

const POLICY_REFUSAL =
  /(?:shell is quarantined|quarantine|not permitted|not allowed|permission denied by policy|blocked by (?:the )?(?:role|policy)|policy refus\w*|tool .* (?:is )?(?:not )?(?:permitted|allowed))/i;

const SPAWN_FAILURE = /(?:ENOENT|EACCES|EPERM|spawn .* failed|was not found|is not recognized as an internal)/i;

/** Bounded output helper shared by every transport. */
export function boundCheckOutput(
  output: unknown,
  max = MAX_CHECK_OUTPUT_CHARS,
): { output: string; truncated: boolean } {
  const text = typeof output === "string" ? output : String(output ?? "");
  if (text.length <= max) return { output: text, truncated: false };
  return { output: text.slice(0, max), truncated: true };
}

/** Does this failure text look like a policy refusal rather than a bad test? */
export function looksLikePolicyRefusal(text: unknown): boolean {
  return typeof text === "string" && POLICY_REFUSAL.test(text);
}

// ── Host transport (nested bash tool) ───────────────────────────────

export type HostToolCall = (
  name: string,
  params: Record<string, unknown>,
  options?: { signal?: AbortSignal },
) => Promise<unknown>;

export interface HostCheckTransportOptions {
  executeTool: HostToolCall;
  maxOutputChars?: number;
}

function textFromNestedResult(nested: unknown): string {
  const content = (nested as { content?: unknown })?.content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      const record = part as { type?: unknown; text?: unknown };
      return record?.type === "text" ? String(record.text ?? "") : "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

export function createHostCheckTransport(
  options: HostCheckTransportOptions,
): CheckTransport {
  const max = options.maxOutputChars ?? MAX_CHECK_OUTPUT_CHARS;
  return {
    kind: "host",
    async run(request) {
      try {
        const nested = await options.executeTool(
          "bash",
          { command: request.scopedCommand, timeout: request.timeoutSeconds },
          request.signal ? { signal: request.signal } : undefined,
        );
        const raw = textFromNestedResult(nested);
        const timedOut =
          raw.includes(request.timeoutMessage) ||
          /Command timed out after \d+ seconds/i.test(raw);
        const isError = (nested as { isError?: unknown })?.isError === true;
        const bounded = boundCheckOutput(raw, max);
        if (isError && looksLikePolicyRefusal(raw)) {
          return {
            ok: false,
            output: bounded.output,
            exitCode: null,
            timedOut: false,
            refused: "policy",
            error: raw || "the host refused this command",
          };
        }
        return {
          ok: !isError && !timedOut,
          output: bounded.output,
          exitCode: null,
          timedOut,
        };
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          ok: false,
          output: boundCheckOutput(message, max).output,
          exitCode: null,
          timedOut: false,
          refused: looksLikePolicyRefusal(message) ? "policy" : "environment",
          error: message,
        };
      }
    },
  };
}

// ── Headless transport (spawn) ──────────────────────────────────────

export interface HeadlessSpawnResult {
  status: number | null;
  stdout?: unknown;
  stderr?: unknown;
  error?: { message?: string; code?: string };
  signal?: unknown;
}

export type HeadlessSpawn = (
  command: string,
  options: {
    shell: boolean;
    cwd?: string;
    windowsHide?: boolean;
    timeout: number;
    killSignal?: NodeJS.Signals;
  },
) => HeadlessSpawnResult;

export interface HeadlessCheckTransportOptions {
  /** Injected in tests; production uses `node:child_process.spawnSync`. */
  spawn?: HeadlessSpawn;
  maxOutputChars?: number;
}

export function createHeadlessCheckTransport(
  options: HeadlessCheckTransportOptions = {},
): CheckTransport {
  const max = options.maxOutputChars ?? MAX_CHECK_OUTPUT_CHARS;
  const spawn: HeadlessSpawn =
    options.spawn ??
    ((command, spawnOptions) =>
      spawnSync(command, {
        shell: true,
        cwd: spawnOptions.cwd,
        windowsHide: true,
        timeout: spawnOptions.timeout,
        killSignal: spawnOptions.killSignal ?? "SIGKILL",
        encoding: "utf8",
      }) as unknown as HeadlessSpawnResult);
  return {
    kind: "headless",
    async run(request) {
      // The headless path must not be a silent bypass: it re-validates the
      // exact bytes and clamps the deadline to the shell-guard hard cap.
      const shape = validateCommandShape(request.command);
      if (!shape.ok) {
        return {
          ok: false,
          output: "",
          exitCode: null,
          timedOut: false,
          refused: "metadata",
          error: `refused to execute a malformed command: ${shape.error}`,
        };
      }
      if (request.command !== request.command.trim() || /\r|\n|\0/.test(request.command)) {
        return {
          ok: false,
          output: "",
          exitCode: null,
          timedOut: false,
          refused: "metadata",
          error: "refused to execute a multi-line or padded command",
        };
      }
      const timeoutSeconds = Math.min(
        HARD_MAX_SHELL_TIMEOUT_SECONDS,
        Math.max(1, Math.ceil(request.timeoutSeconds)),
      );
      const result = spawn(request.command, {
        shell: true,
        ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
        windowsHide: true,
        timeout: timeoutSeconds * 1_000,
        killSignal: "SIGKILL",
      });
      const stdout = String(result.stdout ?? "");
      const stderr = String(result.stderr ?? "");
      const combined = `${stdout}${stderr}`.trim();
      const bounded = boundCheckOutput(combined, max);
      const failureText = result.error?.message ?? "";
      const timedOut =
        result.error?.code === "ETIMEDOUT" ||
        Boolean(result.signal) ||
        /timed? ?out/i.test(failureText);
      if (timedOut) {
        const withDeadline = boundCheckOutput(
          `${request.timeoutMessage}${bounded.output ? `\n${bounded.output}` : ""}`,
          max,
        );
        return {
          ok: false,
          output: withDeadline.output,
          exitCode: null,
          timedOut: true,
          error: request.timeoutMessage,
        };
      }
      if (result.error) {
        return {
          ok: false,
          output: bounded.output,
          exitCode: null,
          timedOut: false,
          refused: SPAWN_FAILURE.test(failureText) || !failureText ? "environment" : "environment",
          error: failureText,
        };
      }
      return {
        ok: result.status === 0,
        output: bounded.output,
        exitCode: result.status,
        timedOut: false,
      };
    },
  };
}

// ── The executor ────────────────────────────────────────────────────

export interface CheckExecutorInput {
  id?: string;
  command: unknown;
  workspace?: string;
  kind?: string;
  timeoutMs?: number;
  expectedExitCode?: number;
}

export interface CheckExecutorOptions {
  transport: CheckTransport;
  /** Live shell limits; read per execution so a limit change applies at once. */
  limits?: () => { maxTimeoutSeconds?: unknown } | undefined;
  /** Shell guard/quarantine decision, evaluated before any transport. */
  guard?: () => CheckGuardDecision;
  maxOutputChars?: number;
  now?: () => number;
  /** Resolve workspace aliases against this set by default. */
  workspaceSet?: () => WorkspaceSet | undefined;
}

export interface CheckExecutor {
  readonly kind: CheckTransport["kind"];
  execute(
    check: unknown,
    hint?: CheckWorkspaceHint,
    context?: { signal?: AbortSignal },
  ): Promise<CheckExecutionResult>;
  executeMany(
    checks: readonly unknown[],
    hint?: CheckWorkspaceHint,
    context?: { signal?: AbortSignal; stopOnFailure?: boolean },
  ): Promise<{ ok: boolean; results: CheckExecutionResult[] }>;
}

interface ResolvedCheck {
  spec: CheckSpec;
  workspaceRoot?: string;
  workspaceId?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function resultFailure(
  base: Pick<CheckExecutionResult, "checkId" | "command" | "kind" | "durationMs">,
  failureClass: CheckFailureClass,
  message: string,
  extra: Partial<CheckExecutionResult> = {},
): CheckExecutionResult {
  return {
    ...base,
    ok: failureClass === "none",
    failureClass,
    repairable: isRepairableFailure(failureClass),
    exitCode: extra.exitCode ?? null,
    output: extra.output ?? "",
    truncated: extra.truncated ?? false,
    message,
    ...(extra.workspaceId === undefined ? {} : { workspaceId: extra.workspaceId }),
    ...(extra.workspaceRoot === undefined ? {} : { workspaceRoot: extra.workspaceRoot }),
  };
}

/**
 * Parse a check from either the typed contract (`CheckSpec`) or one of the
 * legacy projections (`PlanCheckSpec`, a frozen `acceptanceChecks` string).
 * Absent `id`/`kind` are supplied, never invented bytes: the command itself is
 * validated exactly as stored.
 */
function resolveCheck(
  value: unknown,
  index: number,
  workspaces: WorkspaceSet | undefined,
): { ok: true; value: CheckSpec } | { ok: false; error: string } {
  let raw: Record<string, unknown> | undefined;
  if (typeof value === "string") {
    raw = { command: value };
  } else if (isRecord(value)) {
    raw = value;
  } else {
    return { ok: false, error: `check ${index + 1} is not a command` };
  }
  const candidate: Record<string, unknown> = {
    id: typeof raw.id === "string" && raw.id.trim() ? raw.id : `check-${index + 1}`,
    command: raw.command,
    kind: typeof raw.kind === "string" ? raw.kind : "gate",
  };
  for (const key of ["workspace", "timeoutMs", "expectedExitCode"] as const) {
    if (raw[key] !== undefined) candidate[key] = raw[key];
  }
  return validateCheckSpec(candidate, { workspaces: workspaces?.roots });
}

function resolveWorkspace(
  spec: CheckSpec,
  hint: CheckWorkspaceHint | undefined,
  set: WorkspaceSet | undefined,
): { ok: true; value: { root?: string; id?: string } } | { ok: false; error: string } {
  const activeSet = hint?.set ?? set;
  if (spec.workspace) {
    const resolved = resolveWorkspaceAlias(activeSet, spec.workspace);
    if (!resolved) {
      return {
        ok: false,
        error: `unknown workspace ${spec.workspace}; declare it in Workspaces:/Repositories: or fix the alias`,
      };
    }
    return { ok: true, value: { root: resolved.root, id: resolved.id } };
  }
  if (hint?.boundRoot && hint.boundRoot.trim()) {
    return {
      ok: true,
      value: {
        root: hint.boundRoot,
        ...(activeSet?.roots.find((root) => root.root === hint.boundRoot)?.id === undefined
          ? {}
          : { id: activeSet!.roots.find((root) => root.root === hint.boundRoot)!.id }),
      },
    };
  }
  const changed = (hint?.changedRoots ?? []).filter((root) => root.trim());
  if (changed.length === 1) {
    const root = changed[0]!;
    return {
      ok: true,
      value: {
        root,
        ...(activeSet?.roots.find((entry) => entry.root === root)?.id === undefined
          ? {}
          : { id: activeSet!.roots.find((entry) => entry.root === root)!.id }),
      },
    };
  }
  if (changed.length > 1) {
    return {
      ok: false,
      error: `ambiguous check workspace: ${changed.length} roots changed and the check names none`,
    };
  }
  // Several bound roots and no explicit alias/bound/single-changed root is the
  // same ambiguity as several changed roots: a primary-root guess can run the
  // check in the wrong repository, so fail closed instead of defaulting.
  if (activeSet !== undefined && activeSet.roots.length > 1) {
    return {
      ok: false,
      error: `ambiguous check workspace: ${activeSet.roots.length} roots are bound and the check names none`,
    };
  }
  const primary = primaryWorkspace(activeSet);
  if (primary) return { ok: true, value: { root: primary.root, id: primary.id } };
  if (hint?.fallbackRoot && hint.fallbackRoot.trim()) {
    return { ok: true, value: { root: hint.fallbackRoot } };
  }
  return { ok: true, value: {} };
}

export function createCheckExecutor(options: CheckExecutorOptions): CheckExecutor {
  const now = options.now ?? (() => Date.now());
  const maxOutput = options.maxOutputChars ?? MAX_CHECK_OUTPUT_CHARS;

  async function execute(
    check: unknown,
    hint?: CheckWorkspaceHint,
    context?: { signal?: AbortSignal },
  ): Promise<CheckExecutionResult> {
    const startedAt = now();
    const set = hint?.set ?? options.workspaceSet?.();
    const parsed = resolveCheck(check, 0, set);
    if (!parsed.ok) {
      return resultFailure(
        { checkId: "check-1", command: typeof check === "string" ? check : "", kind: "gate", durationMs: 0 },
        "metadata",
        `check metadata invalid: ${parsed.error}`,
      );
    }
    return executeResolved(parsed.value, hint, set, startedAt, context);
  }

  async function executeResolved(
    spec: CheckSpec,
    hint: CheckWorkspaceHint | undefined,
    set: WorkspaceSet | undefined,
    startedAt: number,
    context?: { signal?: AbortSignal },
  ): Promise<CheckExecutionResult> {
    const base = {
      checkId: spec.id,
      command: spec.command,
      kind: spec.kind,
      durationMs: 0,
    };
    if (spec.kind === "manual") {
      return resultFailure(
        { ...base, durationMs: Math.max(0, now() - startedAt) },
        "manual",
        "manual check: a human must attest this result; it is never executed automatically",
      );
    }
    const workspace = resolveWorkspace(spec, hint, set);
    if (!workspace.ok) {
      return resultFailure(
        { ...base, durationMs: Math.max(0, now() - startedAt) },
        "metadata",
        `check metadata invalid: ${workspace.error}`,
      );
    }
    const guard = options.guard?.();
    if (guard?.blocked) {
      return resultFailure(
        { ...base, durationMs: Math.max(0, now() - startedAt) },
        guard.failureClass ?? "policy",
        guard.reason ?? "the shell guard refused this check",
        {
          ...(workspace.value.id === undefined ? {} : { workspaceId: workspace.value.id }),
          ...(workspace.value.root === undefined ? {} : { workspaceRoot: workspace.value.root }),
        },
      );
    }
    const limits = options.limits?.();
    const configured = resolveVerificationDeadline(limits);
    let timeoutSeconds = configured.timeoutSeconds;
    let timeoutMs = configured.timeoutMs;
    let timeoutMessage = configured.message;
    if (typeof spec.timeoutMs === "number") {
      timeoutSeconds = Math.min(
        HARD_MAX_SHELL_TIMEOUT_SECONDS,
        Math.max(1, Math.ceil(spec.timeoutMs / 1_000)),
      );
      timeoutMs = timeoutSeconds * 1_000;
      timeoutMessage = `Command timed out after ${timeoutSeconds} seconds`;
    }
    const response = await options.transport.run({
      command: spec.command,
      scopedCommand: scopeCommandToWorkspace(spec.command, workspace.value.root),
      ...(workspace.value.root === undefined ? {} : { cwd: workspace.value.root }),
      timeoutSeconds,
      timeoutMs,
      timeoutMessage,
      ...(context?.signal === undefined ? {} : { signal: context.signal }),
    });
    const bounded = boundCheckOutput(response.output ?? "", maxOutput);
    const durationMs = Math.max(0, now() - startedAt);
    const evidence = {
      ...(workspace.value.id === undefined ? {} : { workspaceId: workspace.value.id }),
      ...(workspace.value.root === undefined ? {} : { workspaceRoot: workspace.value.root }),
      output: bounded.output,
      truncated: bounded.truncated || (response.output ?? "").length > maxOutput,
      exitCode: response.exitCode ?? null,
    };
    if (response.refused) {
      return resultFailure(
        { ...base, durationMs },
        response.refused,
        response.error ?? response.output ?? "the transport refused this check",
        evidence,
      );
    }
    if (response.timedOut) {
      return resultFailure(
        { ...base, durationMs },
        "timeout",
        response.error ?? timeoutMessage,
        evidence,
      );
    }
    const expected = spec.expectedExitCode ?? 0;
    if (!response.ok || (response.exitCode !== null && response.exitCode !== expected)) {
      return resultFailure(
        { ...base, durationMs },
        "test",
        response.error ?? `exit code ${response.exitCode ?? "null"} (expected ${expected})`,
        evidence,
      );
    }
    return {
      ...base,
      durationMs,
      ok: true,
      failureClass: "none",
      repairable: false,
      output: bounded.output,
      truncated: evidence.truncated,
      exitCode: response.exitCode ?? expected,
      message: "",
      ...(evidence.workspaceId === undefined ? {} : { workspaceId: evidence.workspaceId }),
      ...(evidence.workspaceRoot === undefined ? {} : { workspaceRoot: evidence.workspaceRoot }),
    };
  }

  return {
    kind: options.transport.kind,
    execute,
    async executeMany(checks, hint, context) {
      const set = hint?.set ?? options.workspaceSet?.();
      const results: CheckExecutionResult[] = [];
      const stopOnFailure = context?.stopOnFailure !== false;
      for (const [index, check] of (checks ?? []).entries()) {
        const startedAt = now();
        const parsed = resolveCheck(check, index, set);
        if (!parsed.ok) {
          const failure = resultFailure(
            {
              checkId: `check-${index + 1}`,
              command: typeof check === "string" ? check : "",
              kind: "gate",
              durationMs: 0,
            },
            "metadata",
            `check metadata invalid: ${parsed.error}`,
          );
          results.push(failure);
          if (stopOnFailure) return { ok: false, results };
          continue;
        }
        const result = await executeResolved(
          parsed.value,
          hint,
          set,
          startedAt,
          context,
        );
        results.push(result);
        // A diagnostic reports; only a gate/manual result stops the run.
        if (!result.ok && stopOnFailure && parsed.value.kind !== "diagnostic") {
          return { ok: false, results };
        }
      }
      return { ok: results.every((result) => result.ok || result.kind === "diagnostic"), results };
    },
  };
}

// ── Bounded non-check tooling ───────────────────────────────────────

export interface BoundedGitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  failureClass: CheckFailureClass;
  truncated: boolean;
}

export interface BoundedGitOptions {
  timeoutMs?: number;
  maxOutputChars?: number;
  /** Injected in tests; production uses `node:child_process.spawnSync`. */
  spawnSync?: typeof spawnSync;
  killSignal?: NodeJS.Signals;
}

/**
 * A bounded `git` runner for the baseline/commit ports. `spawnSync` without a
 * timeout blocked the diff path forever on a hung git; a timeout is an
 * `environment` problem (configuration), never a repairable test failure.
 */
export function runBoundedGitSync(
  args: readonly string[],
  cwd: string,
  options: BoundedGitOptions = {},
): BoundedGitResult {
  const timeoutMs = Math.max(1, options.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS);
  const max = options.maxOutputChars ?? MAX_GIT_OUTPUT_CHARS;
  const run = options.spawnSync ?? spawnSync;
  try {
    const result = run("git", args as string[], {
      cwd,
      encoding: "utf8",
      windowsHide: true,
      timeout: timeoutMs,
      killSignal: options.killSignal ?? "SIGKILL",
    });
    const stdout = boundCheckOutput(result.stdout, max);
    const stderr = boundCheckOutput(result.stderr, max);
    const failureText = String((result as { error?: { message?: string } }).error?.message ?? "");
    const timedOut =
      (result as { error?: { code?: string } }).error?.code === "ETIMEDOUT" ||
      Boolean((result as { signal?: unknown }).signal) ||
      /timed? ?out/i.test(failureText);
    const truncated = stdout.truncated || stderr.truncated;
    if (timedOut) {
      return {
        ok: false,
        stdout: stdout.output,
        stderr: `${stderr.output}${stderr.output ? "\n" : ""}git ${args.join(" ")} timed out after ${timeoutMs}ms`,
        timedOut: true,
        failureClass: "environment",
        truncated,
      };
    }
    return {
      ok: result.status === 0,
      stdout: stdout.output,
      stderr: stderr.output || failureText,
      timedOut: false,
      failureClass: result.status === 0 ? "none" : "environment",
      truncated,
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      stdout: "",
      stderr: boundCheckOutput(message, max).output,
      timedOut: false,
      failureClass: "environment",
      truncated: message.length > max,
    };
  }
}
