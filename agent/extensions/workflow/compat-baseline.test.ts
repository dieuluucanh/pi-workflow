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
 *
 * 2026-11-23 (in-process Orchestrator child): the baseline changed
 * deliberately — `workflow_worker_ready`, `orchestrator_report|checkpoint|
 * verify|accept|repair` and the `workflow-bridge` command were removed;
 * `orchestrator-pause|resume|abort|view` were added. See CHANGELOG.md.
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
import { PLAN_COMPILER_VERSION, compilePlan } from "./plan-compiler.ts";
import {
  CHECK_KINDS,
  MAX_ACCEPTANCE_CRITERIA,
  MAX_CHECKS,
  MAX_CHECK_TIMEOUT_MS,
  MAX_FILES,
  MAX_PLAN_ROWS,
  MAX_TEXT,
  MAX_WORKSPACES,
  PLAN_SPEC_VERSION,
} from "./plan-spec.ts";
import { FROZEN_EXECUTION_SCHEMA_VERSION } from "./frozen-snapshot.ts";
import { JOURNAL_VERSION, SNAPSHOT_VERSION } from "./orchestrator-store.ts";
import {
  fakeSdk,
  latestStatus,
  makeFakeCtx,
  makeFakePi,
  submitThenFinish,
  tmpProject,
} from "./test-support.ts";

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
  planContract: {
    compilerVersion: string;
    planSpecVersion: number;
    frozenSchemaVersion: number;
    journalVersion: number;
    snapshotVersion: number;
    checkKinds: string[];
    limits: {
      maxRows: number;
      maxChecks: number;
      maxAcceptanceCriteria: number;
      maxFiles: number;
      maxWorkspaces: number;
      maxText: number;
      maxCheckTimeoutMs: number;
    };
    goldenFixture: string;
    goldenSpecHash: string;
    goldenPlanChecks: string[];
  };
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

test("compat baseline: the plan compiler/checkpoint contract is pinned", () => {
  const baseline = readBaseline().planContract;
  assert.equal(baseline.compilerVersion, PLAN_COMPILER_VERSION);
  assert.equal(baseline.planSpecVersion, PLAN_SPEC_VERSION);
  assert.equal(baseline.frozenSchemaVersion, FROZEN_EXECUTION_SCHEMA_VERSION);
  assert.equal(baseline.journalVersion, JOURNAL_VERSION);
  assert.equal(baseline.snapshotVersion, SNAPSHOT_VERSION);
  assert.deepEqual(baseline.checkKinds, [...CHECK_KINDS]);
  assert.deepEqual(baseline.limits, {
    maxRows: MAX_PLAN_ROWS,
    maxChecks: MAX_CHECKS,
    maxAcceptanceCriteria: MAX_ACCEPTANCE_CRITERIA,
    maxFiles: MAX_FILES,
    maxWorkspaces: MAX_WORKSPACES,
    maxText: MAX_TEXT,
    maxCheckTimeoutMs: MAX_CHECK_TIMEOUT_MS,
  });
});

test("compat baseline: the golden plan still compiles to the pinned gate list", () => {
  const baseline = readBaseline().planContract;
  const markdown = fs.readFileSync(path.join(HERE, baseline.goldenFixture), "utf8");
  const workspace = {
    id: "W",
    key: "plain:C:/work",
    root: "C:/work",
    kind: "plain" as const,
    displayPath: "C:/work",
    primary: true,
  };
  const compiled = compilePlan(markdown, {
    path: "C:/work/.pi/plans/fenced-commands.md",
    workspaces: [workspace],
  });
  assert.equal(compiled.ok, true, compiled.ok ? "" : compiled.error);
  if (!compiled.ok) return;
  assert.equal(compiled.spec.compiler.specHash, baseline.goldenSpecHash);
  assert.deepEqual(
    compiled.spec.planChecks.map((check) => check.command),
    baseline.goldenPlanChecks,
  );
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

test("compat baseline: /workflow is a Plan entry on every host", async () => {
  // Parity regression (Workflow plan step 31). `/workflow` used to be registered
  // only inside the `/plan` catch, so a host that does not own `/plan` (Pi
  // Desktop ships no pi-code extension) never got the documented alias.
  await withBoot(async ({ pi, made }) => {
    assert.ok(pi.commands.workflow, "a host without pi-code must still expose /workflow");
    assert.ok(pi.commands.plan, "the /plan entry stays registered too");

    made.statusCalls.length = 0;
    await pi.commands.workflow.handler("", made.ctx);
    assert.match(String(latestStatus(made.statusCalls, "workflow") ?? ""), /plan/);
  });
});

test("compat baseline: /workflow survives a foreign owner of /plan", async () => {
  // The original reason for the alias: pi-code owns /plan, so registering it
  // throws. /workflow must still register and still switch to Plan.
  const { cwd, agentDir } = tmpProject();
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    const pi = makeFakePi({ activeTools: ["read", "write", "edit", "bash"] });
    const register = pi.registerCommand.bind(pi);
    pi.registerCommand = ((name: string, opts: never) => {
      if (name === "plan") throw new Error("already registered by pi-code");
      return register(name, opts);
    }) as typeof pi.registerCommand;
    const { sdk } = fakeSdk({ pass1: submitThenFinish("# Plan: alias") });
    await workflowExtension(pi as never, {
      loadSdk: async () => sdk as never,
      plannotatorRequestTimeoutMs: 20,
      plannotatorRecoveryTimeoutMs: 20,
      isTerminalHost: () => true,
    });
    assert.equal(pi.commands.plan, undefined);
    assert.ok(pi.commands.workflow, "/workflow is the fallback Plan entry");

    const made = makeFakeCtx({ cwd, hasUI: false, branch: [] });
    await pi.emit("session_start", { reason: "startup" }, made.ctx);
    made.statusCalls.length = 0;
    await pi.commands.workflow.handler("", made.ctx);
    assert.match(String(latestStatus(made.statusCalls, "workflow") ?? ""), /plan/);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  }
});
