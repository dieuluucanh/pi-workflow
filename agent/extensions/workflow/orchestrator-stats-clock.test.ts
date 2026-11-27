/**
 * Workflow Extension — the bounded child-stats repaint clock.
 *
 * One interval, started only while a child is starting/running in a view that
 * shows it. A leaked timer would repaint a finished child forever, so these
 * tests assert the exact start/stop/dispose lifecycle with a fake clock.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { createStatsClock, type StatsClockTimers } from "./orchestrator-stats-clock.ts";

function fakeTimers() {
  const state = {
    intervals: 0,
    clears: 0,
    unrefs: 0,
    pending: [] as Array<() => void>,
  };
  const timers: StatsClockTimers = {
    setInterval: (callback) => {
      state.intervals += 1;
      state.pending.push(callback);
      return { id: state.intervals };
    },
    clearInterval: () => {
      state.clears += 1;
      state.pending.length = 0;
    },
    unref: () => {
      state.unrefs += 1;
    },
  };
  return {
    timers,
    state,
    tick(): void {
      for (const callback of [...state.pending]) callback();
    },
  };
}

test("clock: is inert until it is made live", () => {
  const fake = fakeTimers();
  let ticks = 0;
  const clock = createStatsClock({ onTick: () => (ticks += 1), timers: fake.timers });
  assert.equal(clock.live, false);
  assert.equal(fake.state.intervals, 0);
  fake.tick();
  assert.equal(ticks, 0);
});

test("clock: one interval while live, unref'd, and stopped again", () => {
  const fake = fakeTimers();
  let ticks = 0;
  const clock = createStatsClock({ onTick: () => (ticks += 1), timers: fake.timers });
  clock.setLive(true);
  assert.equal(clock.live, true);
  assert.equal(fake.state.intervals, 1);
  assert.equal(fake.state.unrefs, 1, "the tick can never hold the process open");

  fake.tick();
  fake.tick();
  assert.equal(ticks, 2);

  clock.setLive(false);
  assert.equal(clock.live, false);
  assert.equal(fake.state.clears, 1);
  fake.tick();
  assert.equal(ticks, 2, "a stopped clock does not tick");
});

test("clock: setLive is idempotent and never arms a second interval", () => {
  const fake = fakeTimers();
  let ticks = 0;
  const clock = createStatsClock({ onTick: () => (ticks += 1), timers: fake.timers });
  clock.setLive(true);
  clock.setLive(true);
  clock.setLive(true);
  assert.equal(fake.state.intervals, 1);
  clock.setLive(false);
  clock.setLive(false);
  assert.equal(fake.state.clears, 1);
  assert.equal(ticks, 0);
});

test("clock: can be paused and resumed without leaking the old interval", () => {
  const fake = fakeTimers();
  let ticks = 0;
  const clock = createStatsClock({ onTick: () => (ticks += 1), timers: fake.timers });
  clock.setLive(true);
  fake.tick();
  clock.setLive(false);
  clock.setLive(true);
  assert.equal(fake.state.intervals, 2, "resume may arm a new interval…");
  assert.equal(fake.state.clears, 1, "…only after clearing the previous one");
  fake.tick();
  assert.equal(ticks, 2);
});

test("clock: dispose stops the interval and ignores later setLive", () => {
  const fake = fakeTimers();
  let ticks = 0;
  const clock = createStatsClock({ onTick: () => (ticks += 1), timers: fake.timers });
  clock.setLive(true);
  clock.dispose();
  clock.dispose();
  assert.equal(clock.live, false);
  assert.equal(fake.state.clears, 1);
  clock.setLive(true);
  assert.equal(clock.live, false);
  fake.tick();
  assert.equal(ticks, 0);
});

test("clock: a throwing repaint never kills the clock", () => {
  const fake = fakeTimers();
  let calls = 0;
  const clock = createStatsClock({
    onTick: () => {
      calls += 1;
      throw new Error("repaint failed");
    },
    timers: fake.timers,
  });
  clock.setLive(true);
  assert.doesNotThrow(() => fake.tick());
  assert.doesNotThrow(() => fake.tick());
  assert.equal(calls, 2);
  assert.equal(clock.live, true);
});

test("clock: a timer that cannot be armed degrades instead of throwing", () => {
  const clock = createStatsClock({
    onTick: () => {},
    timers: {
      setInterval: () => {
        throw new Error("no timers here");
      },
      clearInterval: () => {},
    },
  });
  assert.doesNotThrow(() => clock.setLive(true));
  assert.equal(clock.live, false);
  assert.doesNotThrow(() => clock.dispose());
});
