/**
 * Deterministic fake for the one injection port the workflow still ships:
 * `ClockPort`. Kept out of the shipped package (like `test-support.ts`).
 *
 * The external child-host ports (launcher, child event bus, host effects) were
 * removed with the external Orchestrator child; the in-process child uses the
 * Workflow extension's own UI bridge instead.
 */

import type { ClockPort } from "./ports.ts";

export interface FakeClock extends ClockPort {
  /** Advance virtual time; due timers run in (due, insertion) order. */
  advance(ms: number): void;
  /** Number of timers still scheduled. */
  pending(): number;
}

/** A virtual clock: timers only fire when `advance` is called. */
export function makeFakeClock(start = 1_700_000_000_000): FakeClock {
  let now = start;
  let seq = 0;
  interface Entry {
    id: number;
    due: number;
    callback: () => void;
  }
  let entries: Entry[] = [];

  return {
    now: () => now,
    setTimeout(callback, ms) {
      seq += 1;
      const entry: Entry = {
        id: seq,
        due: now + Math.max(0, ms),
        callback,
      };
      entries.push(entry);
      return entry.id;
    },
    clearTimeout(handle) {
      if (typeof handle !== "number") return;
      entries = entries.filter((entry) => entry.id !== handle);
    },
    advance(ms) {
      const target = now + Math.max(0, ms);
      for (;;) {
        const due = entries
          .filter((entry) => entry.due <= target)
          .sort((a, b) => (a.due === b.due ? a.id - b.id : a.due - b.due));
        if (due.length === 0) break;
        const next = due[0];
        if (!next) break;
        entries = entries.filter((entry) => entry.id !== next.id);
        now = next.due;
        next.callback();
      }
      now = target;
    },
    pending: () => entries.length,
  };
}
