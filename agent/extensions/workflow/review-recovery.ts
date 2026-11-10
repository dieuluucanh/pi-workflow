/**
 * Review Mode — provider recovery classification.
 *
 * The SDK already owns the retryable-provider-error table
 * (`isRetryableAssistantError`). Reusing it keeps Review Mode aligned with the
 * agent's own retry policy instead of maintaining a second regex that drifts
 * when a gateway adds a new transient-error spelling.
 *
 * A few failures are explicitly not recoverable by switching models:
 * user aborts, missing auth, model-not-found, invalid requests and context
 * overflow (the latter can be a different, larger-context model, but it is not
 * a stream cut and must not loop through the fallback chain).
 */

import {
  isRetryableAssistantError,
  type AssistantMessage,
} from "@earendil-works/pi-ai";

const NON_RECOVERABLE_PATTERNS: readonly RegExp[] = [
  /^request was aborted$/i,
  /^aborted$/i,
  /\bno api key\b/i,
  /\bmodel\b.*\bnot\b.*\bfound\b/i,
  /\binvalid[_\s-]?request\b/i,
  /\bcontext\b.*\b(?:overflow|too long|window exceeded)\b/i,
  /\bprompt\b.*\btoo long\b/i,
];

function asAssistantError(message: string): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: "openai-completions",
    provider: "reviewer",
    model: "reviewer",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "error",
    errorMessage: message,
    timestamp: Date.now(),
  } as unknown as AssistantMessage;
}

/**
 * True when the reviewer's failed run is a transient provider/transport failure
 * worth another model. Delegates the transient table to the SDK; only the
 * deterministic non-recoverable shapes above short-circuit it.
 */
export function isRecoverableProviderFailure(message: string | undefined): boolean {
  const text = String(message ?? "").trim();
  if (!text) return false;
  if (NON_RECOVERABLE_PATTERNS.some((pattern) => pattern.test(text))) return false;
  try {
    return isRetryableAssistantError(asAssistantError(text));
  } catch {
    return false;
  }
}
