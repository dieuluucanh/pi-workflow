/**
 * Workflow Extension — injection ports.
 *
 * The external Orchestrator child (process launch, IPC, lease, host effects)
 * is gone: a Build child is a second SDK session inside this same process. The
 * only long-lived effect the pure decision modules still need to inject is
 * time, so this module is intentionally one small, dependency-free contract.
 *
 * Implementations:
 *   - production: `workspace-node.ts` (`createNodeWorkspaceResolver`)
 *   - tests:      `test-support-ports.ts` (`makeFakeClock`)
 */

// ── Clock ────────────────────────────────────────────────────────────

/**
 * Time and timers, so deadlines are testable without a real clock.
 * `Date.now()`/bare `setTimeout()` in decision code would make timeout tests
 * slow and non-deterministic.
 */
/** Opaque timer handle: a Node timer object or a numeric fake-clock id. */
export type ClockTimeoutHandle = number | NodeJS.Timeout;

export interface ClockPort {
  /** Milliseconds since the Unix epoch. */
  now(): number;
  /** Runs `callback` once after `ms`; returns an opaque handle. */
  setTimeout(callback: () => void, ms: number): ClockTimeoutHandle;
  clearTimeout(handle: ClockTimeoutHandle): void;
}
