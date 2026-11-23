/**
 * Workflow Extension — shell hang guard (pure)
 *
 * The 2026-11-20 erp-atom incident: two `python - <<'EOF'` probes with an
 * EMPTY heredoc body, no `timeout`, and a grep after them. The shell calls
 * waited 52m27s and 21m56s until the user aborted them. The commands were
 * valid Bash — the defect was an unbounded foreground wait, not malformed
 * syntax.
 *
 * This module owns the parts that need no Pi runtime so they are cheap to
 * test and impossible to accidentally make network-dependent:
 *
 *   - finite timeout normalization (120s default, 900s ceiling, 3600s hard cap)
 *   - a narrow recognizer for DIRECT interpreter-stdin commands whose heredoc
 *     body is provably empty (fail-open on anything ambiguous)
 *   - a request-scoped recovery budget: one changed approach, then stop
 *
 * It is deliberately NOT a shell parser. `shell-text.ts` already owns the
 * quote-aware view the policy gates use; that scanner does not model heredoc
 * bodies and its splitter is intentionally non-POSIX. The recognizer below is
 * conservative: it only blocks when every step is unambiguous. Anything else
 * (multiple heredocs, `<<-`, escaped delimiters, `-c`/`-m`) is reported as
 * `unknown` and keeps the finite deadline instead of being refused.
 */

import { tokenizeWords } from "./shell-text.ts";

/** Shell tools this guard owns. `review_bash` is the reviewer's wrapper. */
export type ShellGuardToolName = "bash" | "powershell" | "review_bash";

export const SHELL_GUARD_TOOL_NAMES: readonly ShellGuardToolName[] = [
  "bash",
  "powershell",
  "review_bash",
];

/** True for the tool names the guard normalizes. */
export function isGuardedShellTool(name: unknown): name is ShellGuardToolName {
  return (
    typeof name === "string" &&
    (SHELL_GUARD_TOOL_NAMES as readonly string[]).includes(name)
  );
}

// ── Limits ────────────────────────────────────────────────────────────

export interface ShellLimits {
  /** Deadline used when the model omits `timeout`. */
  defaultTimeoutSeconds: number;
  /** Largest value an explicit `timeout` may request. */
  maxTimeoutSeconds: number;
}

export const DEFAULT_SHELL_TIMEOUT_SECONDS = 120;
export const DEFAULT_SHELL_MAX_TIMEOUT_SECONDS = 900;
/**
 * Deliberate user configuration may raise the ceiling, but never remove it.
 * A finite bound is the whole point; there is no `0`/`unlimited` escape.
 */
export const HARD_MAX_SHELL_TIMEOUT_SECONDS = 3_600;

export const DEFAULT_SHELL_LIMITS: Readonly<ShellLimits> = {
  defaultTimeoutSeconds: DEFAULT_SHELL_TIMEOUT_SECONDS,
  maxTimeoutSeconds: DEFAULT_SHELL_MAX_TIMEOUT_SECONDS,
};

/** Clamp one limit to `[1, HARD_MAX]`; non-finite input returns `fallback`. */
export function clampShellSeconds(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  const whole = Math.trunc(n);
  if (whole < 1) return fallback;
  return Math.min(HARD_MAX_SHELL_TIMEOUT_SECONDS, whole);
}

/**
 * Repair a pair so `default <= max`. Pure and total; never returns a
 * non-finite, zero, or above-hard-cap value.
 */
export function normalizeShellLimits(
  limits: Partial<ShellLimits> | undefined,
  base: ShellLimits = DEFAULT_SHELL_LIMITS as ShellLimits,
): ShellLimits {
  const max = clampShellSeconds(limits?.maxTimeoutSeconds, base.maxTimeoutSeconds);
  const def = clampShellSeconds(limits?.defaultTimeoutSeconds, base.defaultTimeoutSeconds);
  return {
    defaultTimeoutSeconds: Math.min(def, max),
    maxTimeoutSeconds: Math.max(max, Math.min(def, max)),
  };
}

// ── Timeout normalization ─────────────────────────────────────────────

export type ShellTimeoutNormalization =
  | {
      ok: true;
      timeoutSeconds: number;
      /** `explicit` kept the model's value; `default` supplied one. */
      source: "explicit" | "default";
      /** The model asked for more than the effective ceiling. */
      capped: boolean;
    }
  | { ok: false; error: string };

/**
 * Normalize a shell tool's `timeout` input.
 *
 * Pi's bash schema accepts a finite positive number of seconds and arms its
 * process-tree cancellation only when one is present. A missing value gets the
 * configured default; an explicit value is capped, never widened; an invalid
 * value is refused instead of running unbounded.
 */
export function normalizeShellTimeout(
  input: unknown,
  limits: ShellLimits,
  tool: string = "shell",
): ShellTimeoutNormalization {
  const raw = (input as { timeout?: unknown } | null | undefined)?.timeout;
  const effective = normalizeShellLimits(limits);
  if (raw === undefined || raw === null) {
    return {
      ok: true,
      timeoutSeconds: effective.defaultTimeoutSeconds,
      source: "default",
      capped: false,
    };
  }
  let value = NaN;
  if (typeof raw === "number") {
    value = raw;
  } else if (typeof raw === "string" && raw.trim() !== "") {
    value = Number(raw);
  }
  if (!Number.isFinite(value) || value <= 0) {
    return {
      ok: false,
      error:
        `shell guard: ${tool} timeout must be a finite number of seconds greater than 0 ` +
        `(received ${typeof raw === "string" ? JSON.stringify(raw.slice(0, 40)) : String(raw)}). ` +
        `Omit timeout to use the ${effective.defaultTimeoutSeconds}s default.`,
    };
  }
  if (value > effective.maxTimeoutSeconds) {
    return {
      ok: true,
      timeoutSeconds: effective.maxTimeoutSeconds,
      source: "explicit",
      capped: true,
    };
  }
  return { ok: true, timeoutSeconds: value, source: "explicit", capped: false };
}

/** Human-readable limits line used by `/shell-guard` and notices. */
export function describeShellLimits(limits: ShellLimits): string {
  const effective = normalizeShellLimits(limits);
  return `${effective.defaultTimeoutSeconds}s default · ${effective.maxTimeoutSeconds}s maximum per shell call`;
}

// ── Empty interpreter-probe recognizer ────────────────────────────────

export type EmptyProbeDetection =
  | {
      kind: "empty-probe";
      interpreter: string;
      delimiter: string;
      operator: string;
    }
  | { kind: "none" }
  | { kind: "unknown"; reason: string };

interface HeredocOperator {
  start: number;
  /** Offset where the delimiter token starts (after `<<` + spaces). */
  delimiterStart: number;
  /** End of the delimiter token. */
  end: number;
  delimiter: string;
  delimiterQuoted: boolean;
  /** `<<-`, `<<<`, or a malformed token. */
  unsupported?: string;
  /** Index of the last top-level separator before this operator. */
  statementStart: number;
}

/** Python executables we recognize as direct interpreters. */
const PYTHON_RE = /^(?:python(?:3(?:\.\d+)*)?|py)$/i;

function baseCommandName(word: string): string {
  const normalized = word.replace(/\\/g, "/");
  const base = normalized.slice(normalized.lastIndexOf("/") + 1);
  return base.toLowerCase().replace(/\.exe$/, "");
}

function isPythonExecutable(word: string): boolean {
  return PYTHON_RE.test(baseCommandName(word));
}

/**
 * Scan for unquoted heredoc operators while tracking the last top-level
 * separator (`;`, newline, `|`, `&`). Quoted and backslash-escaped `<` never
 * count. The scan is total and never throws.
 */
function scanHeredocOperators(command: string): HeredocOperator[] {
  const ops: HeredocOperator[] = [];
  let quote: '"' | "'" | undefined;
  let lastSeparator = 0;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      if (ch === "\\" && quote === '"') {
        i++;
        continue;
      }
      if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === "\\") {
      i++;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === ";" || ch === "\n" || ch === "|" || ch === "&") {
      lastSeparator = i + 1;
      continue;
    }
    if (ch !== "<" || command[i + 1] !== "<") continue;

    const operator: HeredocOperator = {
      start: i,
      delimiterStart: i + 2,
      end: i + 2,
      delimiter: "",
      delimiterQuoted: false,
      statementStart: lastSeparator,
    };

    if (command[i + 2] === "<") {
      operator.unsupported = "here-string `<<<`";
      ops.push(operator);
      continue;
    }
    if (command[i + 2] === "-") {
      operator.unsupported = "tab-stripped heredoc `<<-`";
      ops.push(operator);
      continue;
    }

    let j = i + 2;
    while (j < command.length && (command[j] === " " || command[j] === "\t")) {
      j++;
    }
    operator.delimiterStart = j;
    if (j >= command.length || command[j] === "\n") {
      operator.unsupported = "a heredoc without a delimiter";
      ops.push(operator);
      continue;
    }

    const first = command[j];
    if (first === "'" || first === '"') {
      let k = j + 1;
      let value = "";
      let escaped = false;
      let closed = false;
      while (k < command.length) {
        const c = command[k];
        if (escaped) {
          value += c;
          escaped = false;
          k++;
          continue;
        }
        if (c === "\\") {
          escaped = true;
          k++;
          continue;
        }
        if (c === first) {
          closed = true;
          k++;
          break;
        }
        if (c === "\n") break;
        value += c;
        k++;
      }
      if (!closed || escaped || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
        operator.unsupported = "a quoted heredoc delimiter";
        ops.push(operator);
        continue;
      }
      operator.delimiter = value;
      operator.delimiterQuoted = true;
      operator.end = k;
      ops.push(operator);
      i = k - 1;
      continue;
    }

    let k = j;
    let value = "";
    while (k < command.length && !/[\s;&|<>()]/.test(command[k])) {
      value += command[k];
      k++;
    }
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
      operator.unsupported = "a heredoc delimiter that is not a simple word";
      ops.push(operator);
      continue;
    }
    operator.delimiter = value;
    operator.end = k;
    ops.push(operator);
    i = k - 1;
  }
  return ops;
}

/** Words in a statement slice, with leading `VAR=value` assignments removed. */
function statementWords(command: string, op: HeredocOperator): string[] {
  const slice = command.slice(op.statementStart, op.start);
  const { words } = tokenizeWords(slice);
  const values = words.map((w) => w.value);
  while (values.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(values[0] ?? "")) {
    values.shift();
  }
  return values;
}

/** Is this invocation running a stdin script (`python -` / bare `python`)? */
function isStdinScriptInvocation(args: readonly string[]): boolean {
  if (args.some((a) => a === "-c" || a.startsWith("-c") || a === "-m" || a.startsWith("-m"))) {
    return false;
  }
  const positional = args.filter((a) => !a.startsWith("-") || a === "-");
  if (positional.length > 1) return false;
  const only = positional[0];
  if (only === undefined) return true;
  return only === "-";
}

/**
 * Detect a direct interpreter-stdin command whose heredoc body is provably
 * empty. Only an unambiguous empty body is blocked; everything else returns
 * `none` (not a probe) or `unknown` (leave it to the finite deadline).
 */
export function detectEmptyInterpreterProbe(
  command: unknown,
): EmptyProbeDetection {
  if (typeof command !== "string" || !command.trim()) return { kind: "none" };

  const ops = scanHeredocOperators(command);
  if (ops.length === 0) return { kind: "none" };
  if (ops.length > 1) {
    return { kind: "unknown", reason: "multiple heredocs in one command" };
  }
  const op = ops[0]!;
  if (op.unsupported) {
    return { kind: "unknown", reason: op.unsupported };
  }

  const words = statementWords(command, op);
  const executable = words[0] ?? "";
  if (!isPythonExecutable(executable)) return { kind: "none" };
  if (!isStdinScriptInvocation(words.slice(1))) return { kind: "none" };

  const lineEnd = command.indexOf("\n", op.end);
  if (lineEnd === -1) {
    return { kind: "unknown", reason: "heredoc has no body line" };
  }
  const lines = command.slice(lineEnd + 1).split("\n");
  let terminator = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.replace(/\r$/, "");
    if (line === op.delimiter) {
      terminator = i;
      break;
    }
  }
  if (terminator === -1) {
    return { kind: "unknown", reason: "heredoc terminator not found" };
  }
  const body = lines.slice(0, terminator);
  if (body.some((line) => line.trim() !== "")) {
    return { kind: "none" };
  }

  return {
    kind: "empty-probe",
    interpreter: baseCommandName(executable),
    delimiter: op.delimiter,
    operator: op.delimiterQuoted ? `<<'${op.delimiter}'` : `<<${op.delimiter}`,
  };
}

/** Actionable refusal text for an empty probe. */
export function emptyProbeReason(hit: Extract<EmptyProbeDetection, { kind: "empty-probe" }>): string {
  return [
    `shell guard: empty interpreter probe refused — \`${hit.interpreter} - ${hit.operator}\` has an empty stdin script.`,
    "Nothing was launched. This is not a syntax error: the heredoc is valid but the interpreter has no code to run.",
    "Run the intended `grep`/`read` directly, or provide a non-empty script. Do not repeat this probe.",
  ].join(" ");
}

// ── Request-scoped recovery budget ────────────────────────────────────

export type ShellGuardFailureKind =
  | "timeout"
  | "empty-probe"
  | "invalid-timeout";

export interface ShellGuardFailure {
  kind: ShellGuardFailureKind;
  /** Whitespace-normalized command text used only for duplicate detection. */
  fingerprint: string;
  at: number;
}

export type ShellGuardDecision =
  | {
      action: "continue";
      failures: number;
      /** The command was seen for the first time. */
      duplicate: boolean;
      reason: string;
    }
  | { action: "stop"; failures: number; reason: string };

export interface ShellGuardRecovery {
  isStopped(): boolean;
  stoppedReason(): string | undefined;
  /** Restore a durable execution quarantine after a session reset. */
  quarantine(input: { reason: string; command?: string; at?: number }): void;
  recordFailure(input: {
    kind: ShellGuardFailureKind;
    command: unknown;
    at?: number;
  }): ShellGuardDecision;
  reset(reason?: string): void;
  snapshot(): {
    failures: number;
    stopped: boolean;
    stoppedReason?: string;
    kinds: ShellGuardFailureKind[];
  };
}

/** Stable, bounded fingerprint of a command (for duplicate detection only). */
export function shellFingerprint(command: unknown): string {
  if (typeof command !== "string") return "";
  return command.replace(/\s+/g, " ").trim().slice(0, 2_000);
}


/**
 * First qualifying failure → one changed approach. Repeating the same command,
 * or any second qualifying failure in the same logical request → stop.
 */
export function createShellGuardRecovery(): ShellGuardRecovery {
  const failures: ShellGuardFailure[] = [];
  let stopped: string | undefined;

  return {
    isStopped: () => stopped !== undefined,
    stoppedReason: () => stopped,
    recordFailure({ kind, command, at }) {
      const fingerprint = shellFingerprint(command);
      if (stopped !== undefined) {
        return {
          action: "stop",
          failures: failures.length,
          reason: stopped,
        };
      }
      const duplicate = failures.some((f) => f.fingerprint === fingerprint);
      if (duplicate || failures.length >= 1) {
        stopped = duplicate
          ? "the same shell command failed again after the one allowed changed approach"
          : "a second shell-guard failure occurred in the same execution";
        failures.push({
          kind,
          fingerprint,
          at: typeof at === "number" ? at : Date.now(),
        });
        return {
          action: "stop",
          failures: failures.length,
          reason: stopped,
        };
      }
      failures.push({
        kind,
        fingerprint,
        at: typeof at === "number" ? at : Date.now(),
      });
      return {
        action: "continue",
        failures: failures.length,
        duplicate: false,
        reason:
          "one changed approach is allowed; do not repeat the failed command, and inspect any partial effects before mutating",
      };
    },
    quarantine({ reason, command, at }) {
      if (stopped !== undefined) return;
      failures.push({
        kind: "timeout",
        fingerprint: shellFingerprint(command ?? reason),
        at: typeof at === "number" ? at : Date.now(),
      });
      stopped = reason;
    },
    reset() {
      failures.length = 0;
      stopped = undefined;
    },
    snapshot() {
      const snapshot: {
        failures: number;
        stopped: boolean;
        stoppedReason?: string;
        kinds: ShellGuardFailureKind[];
      } = {
        failures: failures.length,
        stopped: stopped !== undefined,
        kinds: failures.map((f) => f.kind),
      };
      if (stopped !== undefined) snapshot.stoppedReason = stopped;
      return snapshot;
    },
  };
}

/** Guidance appended to a shell result after a guard failure. */
export function shellFailureGuidance(
  kind: ShellGuardFailureKind,
  decision: ShellGuardDecision,
): string {
  if (decision.action === "stop") {
    return [
      "",
      "",
      `[shell guard quarantined this execution: ${decision.reason}.]`,
      "Do not call shell tools again in this execution. Continue with non-shell tools (read, grep, find, ls, edit, write, LSP diagnostics).",
      "Do not mark a shell-dependent step complete; continue independent non-shell work. If no permitted action can advance, report a structured blocker instead of waiting for the user.",
    ].join("\n");
  }
  let what = "The shell timeout value was invalid, so nothing ran.";
  if (kind === "timeout") {
    what =
      "The command hit the enforced deadline and was cancelled; it may have produced partial effects and partial output.";
  } else if (kind === "empty-probe") {
    what = "The empty interpreter probe was refused before launch.";
  }
  return [
    "",
    "",
    `[shell guard: ${what} ${decision.reason}.]`,
    "Do not replay it. Use a different, bounded approach; if it may have mutated files or state, inspect first.",
  ].join("\n");
}

/**
 * Narrow classifier for Pi's native deadline message. A generic abort (user
 * Esc) and unrelated errors must not consume the guard budget.
 */
export function classifyShellFailureText(
  text: unknown,
): ShellGuardFailureKind | undefined {
  if (typeof text !== "string") return undefined;
  // A real native timeout has no exit status. A failing test/fixture that
  // merely prints the same sentence, followed by a real exit status, is not a
  // timeout and must not consume the guard budget.
  if (/Command exited with code \d+/.test(text)) return undefined;
  if (/Command timed out after \d+(?:\.\d+)? seconds/.test(text)) {
    return "timeout";
  }
  return undefined;
}

/** The recovery failure budget is request-scoped, not model-turn scoped. */
export const SHELL_GUARD_AUDIT_ENTRY = "workflow-shell-guard";
