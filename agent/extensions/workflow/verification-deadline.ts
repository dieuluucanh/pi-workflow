/**
 * Workflow Extension — the verification deadline.
 *
 * A plan/row check is executable source data, so it gets an explicit, bounded
 * deadline instead of a literal in the executor. The value comes from the
 * effective shell limits (`shellGuardLimitsFor(ctx).config.maxTimeoutSeconds`)
 * and falls back to the shell guard's default maximum; the hard cap is always
 * respected. Pure and total, so it is testable without waiting.
 */

import {
  DEFAULT_SHELL_MAX_TIMEOUT_SECONDS,
  HARD_MAX_SHELL_TIMEOUT_SECONDS,
  clampShellSeconds,
} from "./shell-guard.ts";

export interface VerificationDeadline {
  /** Whole seconds handed to the nested bash tool. */
  timeoutSeconds: number;
  /** The same bound in milliseconds for the headless `spawn` fallback timer. */
  timeoutMs: number;
  /** Deterministic timeout text; never hard-codes 120 seconds. */
  message: string;
}

export function resolveVerificationDeadline(
  limits?: { maxTimeoutSeconds?: unknown } | null,
): VerificationDeadline {
  const timeoutSeconds = Math.min(
    HARD_MAX_SHELL_TIMEOUT_SECONDS,
    clampShellSeconds(limits?.maxTimeoutSeconds, DEFAULT_SHELL_MAX_TIMEOUT_SECONDS),
  );
  return {
    timeoutSeconds,
    timeoutMs: timeoutSeconds * 1_000,
    message: `Command timed out after ${timeoutSeconds} seconds`,
  };
}
