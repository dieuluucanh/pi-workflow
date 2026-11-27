/**
 * Workflow Extension — one bounded repaint clock for the Orchestrator child
 * status line.
 *
 * The child's elapsed time has to tick, but a ticking UI is exactly the kind of
 * thing that leaks a timer across pause/settle/reload. This module is the whole
 * lifecycle:
 *
 *   - ONE interval, started only while a child is `starting`/`running` AND the
 *     selected view shows the child;
 *   - `unref()`ed when the runtime supports it, so a stray tick can never hold
 *     the process open;
 *   - idempotent start/stop, and `dispose()` that is safe to call twice;
 *   - the tick callback is the ONLY write path, so a caller can restrict it to
 *     a single status key and avoid widget re-registration churn.
 *
 * Timers are injected so the tests are deterministic (fake clock, no sleeps).
 */

export interface StatsClockTimers {
  setInterval: (callback: () => void, ms: number) => unknown;
  clearInterval: (handle: unknown) => void;
  /** Optional: mark a timer as not keeping the process alive. */
  unref?: (handle: unknown) => void;
}

export interface StatsClock {
  /** True while the interval is armed. */
  readonly live: boolean;
  /** Arm the interval when `live` is true, disarm it when false. Idempotent. */
  setLive(live: boolean): void;
  /** Release the interval. Safe to call twice. */
  dispose(): void;
}

export const DEFAULT_STATS_TICK_MS = 1_000;

export interface CreateStatsClockOptions {
  /** Called on every tick while live. The caller repaints one status key. */
  onTick: () => void;
  timers?: StatsClockTimers;
  intervalMs?: number;
}

const defaultTimers: StatsClockTimers = {
  setInterval: (callback, ms) => setInterval(callback, ms),
  clearInterval: (handle) => clearInterval(handle as never),
  unref: (handle) => {
    const timer = handle as { unref?: () => void } | undefined;
    try {
      timer?.unref?.();
    } catch {
      /* an unrefusal must never break the clock */
    }
  },
};

export function createStatsClock(options: CreateStatsClockOptions): StatsClock {
  const timers = options.timers ?? defaultTimers;
  const intervalMs =
    typeof options.intervalMs === "number" &&
    Number.isFinite(options.intervalMs) &&
    options.intervalMs > 0
      ? Math.max(250, Math.trunc(options.intervalMs))
      : DEFAULT_STATS_TICK_MS;
  let handle: unknown;
  let live = false;
  let disposed = false;

  const stop = (): void => {
    if (handle === undefined) return;
    const current = handle;
    handle = undefined;
    try {
      timers.clearInterval(current);
    } catch {
      /* a failed clear must not leave the clock armed in our state */
    }
  };

  const start = (): void => {
    if (handle !== undefined || disposed) return;
    try {
      handle = timers.setInterval(() => {
        if (!live || disposed) return;
        try {
          options.onTick();
        } catch {
          /* a repaint failure must never kill the clock */
        }
      }, intervalMs);
      timers.unref?.(handle);
    } catch {
      handle = undefined;
    }
  };

  return {
    get live() {
      return live && handle !== undefined;
    },
    setLive(next: boolean) {
      if (disposed) return;
      if (next === live) return;
      live = next;
      if (live) start();
      else stop();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      live = false;
      stop();
    },
  };
}
