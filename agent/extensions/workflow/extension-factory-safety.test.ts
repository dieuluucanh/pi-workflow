/**
 * Extension-factory safety tests (plan step 25).
 *
 * Two things are proven here:
 *
 * 1. A built-in Workflow extension that LOSES to an installed extension (the
 *    SDK omits it after its factory ran) must perform no filesystem/config I/O,
 *    start no timers, spawn no subprocess, register no process/global listener
 *    and leave no session state. The SDK only drops the extension record; a
 *    factory that subscribes on the shared event bus during load would leak an
 *    active handler for an extension that is not part of the session.
 *
 * 2. Two sessions plus a resource-inspector load (a second/third factory call
 *    in one process) cannot share refiner, reviewer or subagent state.
 *
 * The I/O test runs the real factory in a child Node process behind a preload
 * that counts fs/child_process/timer/process-listener calls. The in-process
 * test drives two factories with the shared fake host.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import workflowExtension from "./index.ts";
import {
  orchestratorChildTeardowns,
  resetOrchestratorChildTeardownsForTests,
} from "./orchestrator-child-teardown.ts";
import {
  ORCHESTRATOR_CHILD_ENTRY,
  ORCHESTRATOR_CHILD_VERSION,
} from "./orchestrator-child-contract.ts";
import { makeFakeCtx, makeFakePi } from "./test-support.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ── 1. No I/O / background work on a losing built-in ─────────────────

const PRELOAD = String.raw`
const counters = (globalThis.__ioCalls = []);
let gate = () => globalThis.__ioGate === true;
function note(kind, target) {
  if (!gate()) return;
  counters.push(kind + ":" + String(target));
}
function patchObject(object, names, prefix) {
  for (const name of names) {
    const original = object[name];
    if (typeof original !== "function") continue;
    object[name] = function (...args) {
      note(prefix + name, args[0]);
      return original.apply(this, args);
    };
  }
}
const fs = require("node:fs");
patchObject(fs, [
  "readFileSync", "readdirSync", "existsSync", "statSync", "lstatSync",
  "writeFileSync", "appendFileSync", "mkdirSync", "rmSync", "unlinkSync",
  "openSync", "copyFileSync", "renameSync", "createReadStream", "watch",
], "");
patchObject(fs.promises, [
  "readFile", "readdir", "stat", "lstat", "writeFile", "appendFile",
  "mkdir", "rm", "unlink", "open", "access", "mkdtemp", "copyFile", "rename",
], "promises.");
patchObject(require("node:child_process"), [
  "spawn", "spawnSync", "exec", "execSync", "fork", "execFile", "execFileSync",
], "child_process.");
function fakeHandle() {
  return {
    unref() { return this; },
    ref() { return this; },
    hasRef() { return false; },
    close() {},
    [Symbol.toPrimitive]() { return 0; },
  };
}
for (const name of ["setTimeout", "setInterval", "setImmediate"]) {
  const original = globalThis[name];
  globalThis[name] = function (...args) {
    if (gate()) {
      counters.push(name + ":timer");
      return fakeHandle();
    }
    return original.apply(this, args);
  };
}
patchObject(process, ["on", "once", "addListener"], "process.");
`;

const DRIVER = String.raw`
import { makeFakePi } from "__TEST_SUPPORT__";
const { default: workflowExtension } = await import("__INDEX__");
const { orchestratorChildTeardowns } = await import("__TEARDOWN__");

const out = { runs: [], error: undefined };
const envBefore = Object.keys(process.env).sort().join("\n");
try {
  for (let run = 0; run < 2; run += 1) {
    const pi = makeFakePi();
    globalThis.__ioCalls.length = 0;
    globalThis.__ioGate = true;
    await workflowExtension(pi, { selfExtensionPath: "/fake/workflow/index.ts" });
    globalThis.__ioGate = false;
    out.runs.push({
      io: globalThis.__ioCalls.slice(),
      busListeners: pi.events.listenerCount(),
      commands: Object.keys(pi.commands).length,
      tools: Object.keys(pi.tools).length,
      shortcuts: Object.keys(pi.shortcuts).length,
      handlers: [...pi.handlers.keys()],
      teardownEntries: orchestratorChildTeardowns.size(),
    });
  }
} catch (error) {
  out.error = error && error.stack ? String(error.stack) : String(error);
}
globalThis.__ioGate = false;
out.envChanged = envBefore !== Object.keys(process.env).sort().join("\n");
process.stdout.write("__RESULT__" + JSON.stringify(out));
`;

function runFactoryBehindIoGate(): {
  runs: Array<{
    io: string[];
    busListeners: number;
    commands: number;
    tools: number;
    shortcuts: number;
    handlers: string[];
    teardownEntries: number;
  }>;
  envChanged: boolean;
  error?: string;
} {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-factory-gate-"));
  try {
    const preloadPath = path.join(dir, "preload.cjs");
    const driverPath = path.join(dir, "driver.mjs");
    fs.writeFileSync(preloadPath, PRELOAD, "utf8");
    fs.writeFileSync(
      driverPath,
      DRIVER.replace("__TEST_SUPPORT__", `file:///${path.join(HERE, "test-support.ts").replace(/\\/g, "/")}`)
        .replace("__INDEX__", `file:///${path.join(HERE, "index.ts").replace(/\\/g, "/")}`)
        .replace("__TEARDOWN__", `file:///${path.join(HERE, "orchestrator-child-teardown.ts").replace(/\\/g, "/")}`),
      "utf8",
    );
    const result = spawnSync(
      process.execPath,
      ["--require", preloadPath, driverPath],
      { encoding: "utf8", timeout: 120_000 },
    );
    const marker = result.stdout?.lastIndexOf("__RESULT__") ?? -1;
    assert.ok(
      marker >= 0,
      `driver produced no result.\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
    );
    return JSON.parse(result.stdout.slice(marker + "__RESULT__".length));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("a losing built-in factory performs no I/O, timers, subprocesses or listener registration", () => {
  const parsed = runFactoryBehindIoGate();
  assert.equal(parsed.error, undefined, `factory threw: ${parsed.error}`);
  assert.equal(parsed.runs.length, 2);
  for (const [index, run] of parsed.runs.entries()) {
    // Zero filesystem/config reads, writes, subprocesses and timers during the
    // factory call: the work belongs to lifecycle handlers/invocations.
    assert.deepEqual(run.io, [], `factory run ${index} performed I/O: ${run.io.join(", ")}`);
    // No bus handler survives the SDK's replacement decision.
    assert.equal(run.busListeners, 0, "a losing factory must leave zero bus listeners");
    // It still composes by registration only (commands/tools/handlers).
    assert.ok(run.commands > 10, `expected command registrations, got ${run.commands}`);
    assert.ok(run.tools >= 1, "expected tool registrations");
    assert.ok(run.handlers.length > 0, "expected event-handler registrations");
    assert.ok(run.shortcuts >= 1, "expected shortcut registrations");
    // No session/resource state is created by loading: teardown entries are
    // published only by a child session_start.
    assert.equal(run.teardownEntries, 0);
  }
  // No process-global environment mutation (no refiner/child identity marker).
  assert.equal(parsed.envChanged, false);
});

// ── 2. Two sessions + resource inspector cannot share state ──────────

function tempRoots(): { root: string; agentDir: string; cwd: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wf-two-sessions-"));
  const agentDir = path.join(root, "agent");
  const cwd = path.join(root, "project");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(path.join(cwd, ".pi", "plans"), { recursive: true });
  return { root, agentDir, cwd };
}

function childBranch(): unknown[] {
  return [
    {
      type: "custom",
      customType: ORCHESTRATOR_CHILD_ENTRY,
      data: {
        version: ORCHESTRATOR_CHILD_VERSION,
        runId: "run-1",
        taskId: "task-1",
        attemptId: "attempt-1",
        ref: "1",
        total: 1,
        parentSessionRef: "parent-session",
        mode: "build",
        mayOrchestrate: false,
        createdAt: Date.now(),
      },
    },
  ];
}

test("two sessions and a resource-inspector load share no refiner/reviewer/subagent state", async () => {
  resetOrchestratorChildTeardownsForTests();
  const { root, agentDir, cwd } = tempRoots();
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    const piA = makeFakePi();
    const piB = makeFakePi();
    const piInspector = makeFakePi();
    const madeA = makeFakeCtx({ cwd, branch: [] });
    const madeB = makeFakeCtx({ cwd, branch: childBranch() });
    const ctxA = madeA.ctx as any;
    const ctxB = madeB.ctx as any;
    ctxB.sessionManager.getSessionId = () => "child-session-1";

    await workflowExtension(piA as never, { selfExtensionPath: "/fake/index.ts" });
    await workflowExtension(piB as never, { selfExtensionPath: "/fake/index.ts" });
    // A resource-inspector load: the factory composes but owns no session.
    await workflowExtension(piInspector as never, {
      selfExtensionPath: "/fake/index.ts",
    });

    await piA.emit("session_start", { reason: "startup" }, ctxA);
    await piB.emit("session_start", { reason: "startup" }, ctxB);

    // Each session owns exactly one external bridge listener; the inspector
    // (no session) owns none.
    assert.equal(piA.events.listenerCount("pi-code:plan-mode"), 1);
    assert.equal(piB.events.listenerCount("pi-code:plan-mode"), 1);
    assert.equal(piInspector.events.listenerCount(), 0);

    // Subagent teardown: only the child session published an entry, keyed by
    // its own session id. The ordinary session published nothing.
    assert.equal(orchestratorChildTeardowns.has("child-session-1"), true);
    assert.equal(orchestratorChildTeardowns.size(), 1);
    const childTeardown = orchestratorChildTeardowns.take("child-session-1");
    assert.equal(typeof childTeardown, "function");
    assert.equal(orchestratorChildTeardowns.size(), 0);

    // Refiner/reviewer state: the same command invocation on A only touches A.
    resetOrchestratorChildTeardownsForTests();
    const bNotifiesBefore = madeB.notifies.length;
    const aNotifiesBefore = madeA.notifies.length;
    await piA.commands["prompt"].handler("", ctxA);
    assert.ok(
      madeA.notifies.length > aNotifiesBefore,
      "session A's refiner must answer its own command",
    );
    assert.equal(
      madeB.notifies.length,
      bNotifiesBefore,
      "session B must not see session A's refiner output",
    );

    // Reviewer state is per instance as well: a status read on B is not a
    // status read on A.
    await piB.commands["review-status"].handler("", ctxB);
    assert.equal(
      madeA.notifies.length,
      aNotifiesBefore + 1,
      "session A must not see session B's reviewer output",
    );

    // Commands/tools are registered per factory call, never a shared object.
    assert.notEqual(piA.commands["prompt"], piB.commands["prompt"]);
    assert.notEqual(piA.tools["workflow_todo"], piInspector.tools["workflow_todo"]);

    // Closing A removes only A's bridge listener; B's session and the child
    // teardown handshake stay intact until their own owner releases them.
    orchestratorChildTeardowns.register("child-session-2", () => {});
    await piA.emit("session_shutdown", { reason: "quit" }, ctxA);
    assert.equal(piA.events.listenerCount("pi-code:plan-mode"), 0);
    assert.equal(piB.events.listenerCount("pi-code:plan-mode"), 1);
    assert.equal(orchestratorChildTeardowns.has("child-session-2"), true);

    // B's own shutdown drops its bridge and only its OWN pending child entry;
    // another session's registration is never consumed by B's lifetime.
    orchestratorChildTeardowns.register("child-session-1", () => {});
    await piB.emit("session_shutdown", { reason: "quit" }, ctxB);
    assert.equal(piB.events.listenerCount("pi-code:plan-mode"), 0);
    assert.equal(orchestratorChildTeardowns.has("child-session-1"), false);
    assert.equal(orchestratorChildTeardowns.has("child-session-2"), true);
  } finally {
    resetOrchestratorChildTeardownsForTests();
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ── 3. Reviewer/refiner runtimes keep no module-scope session state ──

test("reviewer, refiner and isolated-session modules declare no module-scope mutable state", () => {
  const files = [
    "review-runtime.ts",
    "review.ts",
    "prompt-refinement-runtime.ts",
    "prompt-refinement-state.ts",
    "isolated-session.ts",
  ];
  for (const file of files) {
    const source = fs.readFileSync(path.join(HERE, file), "utf8");
    const mutableAtModuleScope: string[] = [];
    let depth = 0;
    for (const line of source.split("\n")) {
      const trimmed = line.trim();
      if (depth === 0 && /^(export\s+)?(let|var)\s/.test(trimmed)) {
        mutableAtModuleScope.push(trimmed);
      }
      if (depth === 0 && /^(export\s+)?const\s+\w+\s*(:[^=]*)?=\s*new\s+(Map|Set|WeakMap|WeakSet)\s*\(/.test(trimmed)) {
        // A frozen/read-only container is configuration, not session state.
        if (!/Readonly(Map|Set)/.test(trimmed)) mutableAtModuleScope.push(trimmed);
      }
      const stripped = line
        .replace(/\/\/.*$/, "")
        .replace(/`[^`]*`/g, "``")
        .replace(/"[^"]*"/g, '""')
        .replace(/'[^']*'/g, "''");
      for (const char of stripped) {
        if (char === "{") depth += 1;
        else if (char === "}") depth -= 1;
      }
    }
    assert.deepEqual(
      mutableAtModuleScope,
      [],
      `${file} must not keep module-scope session state (move it under the instance lifetime): ${mutableAtModuleScope.join(" | ")}`,
    );
  }
});
