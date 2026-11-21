/**
 * Compatibility baseline (2026-11-21 orchestrator plan, step 1).
 *
 * The orchestrator work refactors this extension heavily. Before any of it
 * lands, pin what "ordinary Build" means for a real session:
 *
 *   - which tools this extension registers,
 *   - the active tool set Plan and Build apply,
 *   - the commands it owns,
 *   - the built-in model roles and the profile role whitelist,
 *   - the status/widget keys hosts already consume,
 *   - the SDK version this package develops against.
 *
 * The fixture (`fixtures/compat-baseline.json`) is the record. A later step
 * that changes any value must update it deliberately — an accidental drift
 * fails here instead of silently changing Build for every user.
 *
 * Every boot is hermetic: `PI_CODING_AGENT_DIR` points at the test's temp
 * agent directory, so a user's real roles/profiles/settings never leak into
 * the fixture.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import workflowExtension from "./index.ts";
import { BUILT_IN_ROLES, defaultRoleConfig, ROLE_CONFIG_VERSION } from "./roles.ts";
import { PROFILE_ROLES } from "./profiles.ts";
import { WORKFLOW_STATUS_KEYS } from "./workflow-status.ts";
import {
  fakeSdk,
  makeFakeCtx,
  makeFakePi,
  submitThenFinish,
  tmpProject,
} from "./test-support.ts";
import {
  makeFakeChildBus,
  makeFakeClock,
  makeFakeHost,
  makeFakeLauncher,
  makeMemoryFs,
  normalizeFakePath,
} from "./test-support-ports.ts";
import type { LauncherPort } from "./ports.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASELINE_PATH = path.join(HERE, "fixtures", "compat-baseline.json");

interface Baseline {
  version: number;
  sdk: { package: string; version: string };
  registeredTools: string[];
  planActiveTools: string[];
  buildActiveTools: string[];
  commands: string[];
  roles: { builtIn: string[]; configVersion: number; profileRoles: string[] };
  statusKeys: Record<string, string>;
  widgetKeys: string[];
}

function readBaseline(): Baseline {
  return JSON.parse(fs.readFileSync(BASELINE_PATH, "utf8")) as Baseline;
}

function sdkVersion(): string {
  const packageJson = path.join(
    HERE,
    "node_modules",
    "@earendil-works",
    "pi-coding-agent",
    "package.json",
  );
  return (JSON.parse(fs.readFileSync(packageJson, "utf8")) as { version: string })
    .version;
}

interface Boot {
  cwd: string;
  pi: ReturnType<typeof makeFakePi>;
  made: ReturnType<typeof makeFakeCtx>;
  cleanup(): Promise<void>;
}

/** Boot the real extension against a fake host, without a provider. */
async function boot(): Promise<Boot> {
  const { cwd, agentDir } = tmpProject();
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const pi = makeFakePi({
    activeTools: ["read", "write", "edit", "bash"],
  });
  const { sdk } = fakeSdk({ pass1: submitThenFinish("# Plan: baseline") });
  await workflowExtension(pi as never, {
    loadSdk: async () => sdk as never,
    plannotatorRequestTimeoutMs: 20,
    plannotatorRecoveryTimeoutMs: 20,
    isTerminalHost: () => true,
  });
  const made = makeFakeCtx({ cwd, hasUI: false, branch: [] });
  await pi.emit("session_start", { reason: "startup" }, made.ctx);
  return {
    cwd,
    pi,
    made,
    cleanup: async () => {
      try {
        await pi.emit("session_shutdown", { reason: "quit" }, made.ctx);
      } catch {
        /* shutdown is best-effort in the fake host */
      }
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
    },
  };
}

async function withBoot<T>(fn: (boot: Boot) => Promise<T>): Promise<T> {
  const running = await boot();
  try {
    return await fn(running);
  } finally {
    await running.cleanup();
  }
}

function lastToolSet(pi: ReturnType<typeof makeFakePi>): string[] | undefined {
  const entry = [...pi.timeline].reverse().find((item) => item.kind === "tools");
  return entry && entry.kind === "tools" ? entry.tools : undefined;
}

test("compat baseline: extension and SDK identity are pinned", () => {
  const baseline = readBaseline();
  assert.equal(baseline.version, 1);
  assert.equal(baseline.sdk.package, "@earendil-works/pi-coding-agent");
  assert.equal(sdkVersion(), baseline.sdk.version);
});

test("compat baseline: registered tools, commands and mode tool sets", async () => {
  const baseline = readBaseline();

  await withBoot(async ({ pi }) => {
    assert.deepEqual(Object.keys(pi.tools).sort(), baseline.registeredTools);
    assert.deepEqual(Object.keys(pi.commands).sort(), baseline.commands);
  });

  await withBoot(async ({ pi, made }) => {
    await pi.commands.plan.handler("", made.ctx);
    assert.deepEqual(lastToolSet(pi), baseline.planActiveTools);
  });

  await withBoot(async ({ pi, made }) => {
    await pi.commands.build.handler("", made.ctx);
    assert.deepEqual(lastToolSet(pi), baseline.buildActiveTools);
  });
});

test("compat baseline: mode rules survive any tool-list refresh", () => {
  const baseline = readBaseline();
  // Plan keeps the gated tools active (the tool_call gate explains the refusal)
  // and always carries the workflow tools, so a future "clean up the list"
  // change cannot silently drop the gate's ability to answer.
  for (const tool of ["read", "bash", "edit", "write", "workflow_todo"]) {
    assert.ok(baseline.planActiveTools.includes(tool), `plan must include ${tool}`);
  }
  // Build is the full normal set; nothing from Plan is lost.
  for (const tool of baseline.planActiveTools) {
    assert.ok(baseline.buildActiveTools.includes(tool), `build must include ${tool}`);
  }
  assert.deepEqual(baseline.planActiveTools, baseline.buildActiveTools);
});

test("compat baseline: roles and profile whitelist stay aligned", () => {
  const baseline = readBaseline();
  const config = defaultRoleConfig();
  assert.equal(config.version, ROLE_CONFIG_VERSION);
  assert.equal(ROLE_CONFIG_VERSION, baseline.roles.configVersion);
  assert.deepEqual(
    config.roles.map((role) => role.name).sort(),
    [...baseline.roles.builtIn].sort(),
  );
  assert.deepEqual([...BUILT_IN_ROLES].sort(), [...baseline.roles.builtIn].sort());
  assert.deepEqual([...PROFILE_ROLES], baseline.roles.profileRoles);
  // Every seeded role resolves a model + a thinking level.
  for (const role of config.roles) {
    assert.ok(role.model.provider.length > 0, `${role.name} needs a provider`);
    assert.ok(role.model.id.length > 0, `${role.name} needs a model id`);
    assert.ok(role.model.thinking.length > 0, `${role.name} needs thinking`);
  }
});

test("compat baseline: host-consumed status and widget keys are stable", () => {
  const baseline = readBaseline();
  assert.deepEqual({ ...WORKFLOW_STATUS_KEYS }, baseline.statusKeys);
  assert.deepEqual(baseline.widgetKeys, [
    "workflow-review-status",
    "workflow-todos",
  ]);
});

test("compat baseline: session startup sets the status keys and stays idempotent", async () => {
  const baseline = readBaseline();

  await withBoot(async ({ pi, made }) => {
    const keys = made.statusCalls.map((call) => call.key);
    for (const key of Object.values(baseline.statusKeys)) {
      assert.ok(keys.includes(key), `session_start must publish ${key}`);
    }

    // A second session_start (reload/resume) must not duplicate handlers.
    const handlerCounts = [...pi.handlers.entries()].map(
      ([event, list]) => [event, list.length] as const,
    );
    await pi.emit("session_start", { reason: "reload" }, made.ctx);
    const after = [...pi.handlers.entries()].map(
      ([event, list]) => [event, list.length] as const,
    );
    assert.deepEqual(after, handlerCounts, "a second session_start must not re-register handlers");

    // A shutdown clears every key it published.
    made.statusCalls.length = 0;
    await pi.emit("session_shutdown", { reason: "quit" }, made.ctx);
    const cleared = made.statusCalls
      .filter((call) => call.value === undefined)
      .map((call) => call.key);
    for (const key of Object.values(baseline.statusKeys)) {
      assert.ok(cleared.includes(key), `session_shutdown must clear ${key}`);
    }
  });
});

// ── Port fakes ───────────────────────────────────────────────────────
// Later steps rely on these fakes being honest. Each test pins the property
// the orchestration code will depend on.

test("port fake: virtual clock only advances on demand", () => {
  const clock = makeFakeClock(1_000);
  const seen: number[] = [];
  clock.setTimeout(() => seen.push(clock.now()), 500);
  clock.setTimeout(() => seen.push(clock.now()), 100);
  assert.deepEqual(seen, []);
  assert.equal(clock.pending(), 2);
  clock.advance(100);
  assert.deepEqual(seen, [1_100]);
  clock.advance(400);
  assert.deepEqual(seen, [1_100, 1_500]);
  assert.equal(clock.pending(), 0);
  assert.equal(clock.now(), 1_500);
});

test("port fake: filesystem replaces atomically and models a torn write", async () => {
  const mem = makeMemoryFs({ "/run/a.json": "old" });
  await mem.writeFileAtomic("/run/a.json", "new");
  assert.equal(await mem.readFileText("/run/a.json"), "new");
  assert.deepEqual(mem.writes().map((entry) => entry.path), ["/run/a.json"]);

  mem.faults.failNextWrite = "/run/a.json";
  await assert.rejects(() => mem.writeFileAtomic("/run/a.json", "loser"));
  // The torn write must not have replaced the committed value.
  assert.equal(await mem.readFileText("/run/a.json"), "new");

  mem.faults.truncateNextWriteTo = 3;
  await mem.writeFileAtomic("/run/a.json", "abcdef");
  assert.equal(await mem.readFileText("/run/a.json"), "new");

  assert.equal(normalizeFakePath("C:\\x\\..\\y"), "C:/y");
  assert.equal(await mem.readFileText("/missing", { missingOk: true }), undefined);
});

test("port fake: launcher failures are explicit, never a hidden fallback", async () => {
  const launcher = makeFakeLauncher({ available: true, label: "test-wt" });
  assert.equal((await launcher.capabilities()).label, "test-wt");
  const first = await launcher.launch({
    sessionId: "s1",
    cwd: "/p",
    executable: "/pi",
    args: ["--session-id", "s1"],
  });
  assert.equal(first.ok, true);
  assert.equal(launcher.launches.length, 1);

  launcher.failNextLaunch("wt.exe not found");
  const failed = await launcher.launch({
    sessionId: "s2",
    cwd: "/p",
    executable: "/pi",
    args: [],
  });
  assert.deepEqual(failed, { ok: false, reason: "wt.exe not found" });
  assert.equal(launcher.launches.length, 1);

  launcher.setCapabilities({ available: false, separateWindow: false, reason: "no terminal" });
  const caps = await launcher.capabilities();
  assert.equal(caps.available, false);
  assert.equal(caps.separateWindow, false);
  if (first.ok) assert.equal(typeof first.handle.ref, "string");
});

test("port fake: child bus orders per session and reports transport state", async () => {
  const bus = makeFakeChildBus();
  const got: number[] = [];
  bus.subscribe((event) => got.push(event.seq));
  bus.send({
    runId: "r1",
    sessionId: "w1",
    taskId: "t1",
    attemptId: "a1",
    message: { kind: "ready", taskId: "t1", attemptId: "a1", sessionId: "w1" },
  });
  bus.send({
    runId: "r1",
    sessionId: "w1",
    taskId: "t1",
    attemptId: "a1",
    message: { kind: "heartbeat", taskId: "t1", attemptId: "a1", sessionId: "w1" },
  });
  bus.send({
    runId: "r1",
    sessionId: "w2",
    taskId: "t2",
    attemptId: "a2",
    message: { kind: "ready", taskId: "t2", attemptId: "a2", sessionId: "w2" },
  });
  assert.deepEqual(got, [1, 2, 1]);

  bus.setConnected(false, "socket closed");
  assert.deepEqual(bus.status(), { connected: false, detail: "socket closed" });
  const rejected = await bus.publish({
    seq: 3,
    sessionId: "w1",
    runId: "r1",
    taskId: "t1",
    attemptId: "a1",
    at: 0,
    message: { kind: "candidate", taskId: "t1", attemptId: "a1", reportId: "rep" },
  });
  assert.equal(rejected.ok, false);
});

test("port fake: host records effects without touching a real Pi host", async () => {
  const host = makeFakeHost();
  host.commands["orchestrator"] = async (args) => {
    host.notify(`ran ${args}`);
  };
  host.setStatus("workflow-run", "▶ run");
  host.setWidget("workflow-run", ["line"]);
  const result = await host.runCommand("orchestrator", "status");
  assert.deepEqual(result, { ran: true });
  assert.deepEqual(host.notifications, [{ message: "ran status" }]);
  assert.deepEqual(host.statusCalls, [{ key: "workflow-run", text: "▶ run" }]);
  assert.deepEqual(host.widgetCalls, [{ key: "workflow-run", lines: ["line"] }]);
  const missing = await host.runCommand("nope");
  assert.deepEqual(missing, { ran: false });
});

test("port fake: a launcher satisfies the port contract (type-level guard)", () => {
  // Compile-time guard: if `LauncherPort` changes, this assignment fails
  // typecheck instead of every orchestration test failing at runtime.
  const launcher: LauncherPort = makeFakeLauncher();
  assert.equal(typeof launcher.capabilities, "function");
});
