/**
 * Workflow Extension — bounded `git` runner.
 *
 * `spawnSync` without a timeout blocked the diff/baseline path forever on a
 * hung git. Every invocation is now bounded by a caller-supplied timeout and
 * its output is capped. A timeout is an `environment` problem (configuration),
 * never a repairable test failure.
 *
 * This module is standalone: it does not import the check executor, so the
 * multi-repo resolver can keep working after the check engine is removed.
 */

import { spawnSync } from "node:child_process";

export const DEFAULT_GIT_TIMEOUT_MS = 60_000;
export const MAX_GIT_OUTPUT_CHARS = 64_000;

export type GitFailureClass = "none" | "environment";

export interface BoundedGitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  failureClass: GitFailureClass;
  truncated: boolean;
}

export interface BoundedGitOptions {
  timeoutMs?: number;
  maxOutputChars?: number;
  /** Injected in tests; production uses `node:child_process.spawnSync`. */
  spawnSync?: typeof spawnSync;
  killSignal?: NodeJS.Signals;
}

function boundOutput(
  output: unknown,
  max: number,
): { output: string; truncated: boolean } {
  const text = typeof output === "string" ? output : String(output ?? "");
  if (text.length <= max) return { output: text, truncated: false };
  return { output: text.slice(0, max), truncated: true };
}

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
    const stdout = boundOutput(result.stdout, max);
    const stderr = boundOutput(result.stderr, max);
    const failureText = String(
      (result as { error?: { message?: string } }).error?.message ?? "",
    );
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
      stderr: boundOutput(message, max).output,
      timedOut: false,
      failureClass: "environment",
      truncated: message.length > max,
    };
  }
}
