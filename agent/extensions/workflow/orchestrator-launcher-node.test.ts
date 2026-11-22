/**
 * Real terminal launcher tests (plan step 11).
 *
 * The decision module already pins argv/quoting. These tests pin the spawn:
 * array argv (no shell), allowlisted env, detached/unref'd, a missing binary is
 * `unsupported` with guidance, and launcher success is never readiness.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createSpawnLauncherPort,
  createTerminalHost,
  launchWorkerInTerminal,
  type SpawnCall,
  type SpawnOutcome,
} from "./orchestrator-launcher-node.ts";
import type { WorkerResumeSpec } from "./orchestrator-launcher.ts";

const PI = { command: "C:/pi/bin/pi.exe", baseArgs: ["--agent-dir", "C:/profile"] };

function spec(over: Partial<WorkerResumeSpec> = {}): WorkerResumeSpec {
  return {
    workerId: "worker-run-1-task-1-attempt-1",
    sessionName: "Workflow task-1",
    sessionFile: "C:/sessions/worker 1.jsonl",
    cwd: "C:/work/ünïcode project",
    agentDir: "C:/profile",
    ...over,
  };
}

function recorder(outcome: SpawnOutcome = { ok: true, pid: 4242 }) {
  const calls: SpawnCall[] = [];
  return {
    calls,
    spawn: async (call: SpawnCall) => {
      calls.push(call);
      return outcome;
    },
  };
}

test("launcher: a worker window receives the resolved argv, cwd and allowlisted env", async () => {
  const rec = recorder();
  const host = createTerminalHost({
    platform: "win32",
    resolvePi: async () => PI,
    spawn: rec.spawn,
  });

  const outcome = await launchWorkerInTerminal(host, spec());
  assert.equal(outcome.ok, true, outcome.ok ? "" : outcome.error);
  if (!outcome.ok) return;
  assert.equal(outcome.readiness, "pending", "launcher success is not readiness");
  assert.equal(outcome.taskStarted, false, "never claims a task start");

  const call = rec.calls[0];
  assert.ok(call, "the launcher spawned once");
  assert.equal(call.command, "wt.exe");
  assert.deepEqual(call.args.slice(0, 6), [
    "-w",
    "0",
    "new-tab",
    "--title",
    "Workflow task-1",
    "-d",
  ]);
  // argv is an array: spaces/Unicode survive without shell quoting.
  assert.ok(call.args.includes("C:/work/ünïcode project"));
  assert.ok(call.args.includes("--session"));
  assert.ok(call.args.includes("C:/sessions/worker 1.jsonl"));
  // Headless flags are never passed.
  for (const forbidden of ["-p", "--print", "--no-session", "--no-extensions"]) {
    assert.equal(call.args.includes(forbidden), false, `${forbidden} must be refused`);
  }
  assert.equal(call.detached, true);
  // Only the allowlisted profile dir is forwarded.
  assert.deepEqual(call.env, { PI_CODING_AGENT_DIR: "C:/profile" });
});

test("launcher: a missing executable is unsupported with guidance, not a hidden worker", async () => {
  const host = createTerminalHost({
    platform: "win32",
    resolvePi: async () => PI,
    spawn: async () => ({ ok: false, error: "spawn wt.exe ENOENT" }),
  });
  const outcome = await launchWorkerInTerminal(host, spec());
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(outcome.code, "unsupported");
  assert.match(outcome.guidance ?? "", /no hidden worker/i);
});

test("launcher: no resolvable Pi CLI blocks before any spawn", async () => {
  const rec = recorder();
  const host = createTerminalHost({
    platform: "darwin",
    resolvePi: async () => null,
    spawn: rec.spawn,
  });
  const outcome = await launchWorkerInTerminal(host, spec());
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(outcome.code, "unsupported");
  assert.equal(rec.calls.length, 0, "nothing was launched");
});

test("launcher: forbidden resume arguments are refused before spawn", async () => {
  const rec = recorder();
  const host = createTerminalHost({
    platform: "win32",
    resolvePi: async () => ({ command: "pi", baseArgs: ["--print"] }),
    spawn: rec.spawn,
  });
  const outcome = await launchWorkerInTerminal(host, spec());
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(outcome.code, "invalid");
  assert.equal(rec.calls.length, 0);
});

test("launcher: capabilities never claim focus/close a spawn cannot provide", async () => {
  const host = createTerminalHost({
    platform: "linux",
    resolvePi: async () => PI,
    spawn: async () => ({ ok: true, pid: 7 }),
    linux: { command: "gnome-terminal" },
  });
  const caps = await host.port.capabilities();
  assert.equal(caps.available, true);
  assert.equal(caps.separateWindow, true);
  assert.equal(caps.focus, false);
  assert.equal(caps.close, false);

  const launched = await host.port.launch({
    sessionId: "s1",
    cwd: "C:/work/app",
    executable: "C:/pi/bin/pi.exe",
    args: ["--session", "C:/sessions/s1.jsonl"],
    env: { PI_CODING_AGENT_DIR: "C:/profile" },
    title: "Workflow s1",
  });
  assert.equal(launched.ok, true);
  if (!launched.ok) return;
  assert.equal(launched.handle.windowLabel, "Workflow s1");
});

test("launcher: the spawn port records the exact request and returns a handle", async () => {
  const rec = recorder({ ok: true, pid: 99 });
  const port = createSpawnLauncherPort({ spawn: rec.spawn });
  const { windowRef } = await port.launch({
    schemaVersion: 1,
    kind: "windows-terminal",
    executable: "wt.exe",
    argv: ["new-tab"],
    cwd: "C:/x",
    title: "t",
    env: {},
    label: "Windows Terminal",
  });
  assert.match(windowRef, /launch-1-99/);
  assert.deepEqual(port.lastCall()?.args, ["new-tab"]);
  assert.equal(await port.close(windowRef), true);
  assert.equal(await port.close(windowRef), false);
  assert.equal(await port.focus("missing"), false);
});
