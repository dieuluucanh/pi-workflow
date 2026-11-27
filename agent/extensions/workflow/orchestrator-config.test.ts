/**
 * Workflow Extension — `workflow.orchestrator` execution-limit settings.
 *
 * Run with: npm test   (node --test, type-stripping — no build step)
 *
 * Covers the pure settings surface: coercion of an untrusted fragment, hard-cap
 * clamping, invalid-value diagnostics, extraction, global < project precedence,
 * field provenance, disk resolution through temp directories, and the effective
 * verification deadline (the shell guard's maximum and the hard cap still win).
 * The last test pins the reduced `childTimeoutMs` reaching the controller port,
 * which is the one wiring seam this module owns.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import {
  DEFAULT_ORCHESTRATOR_LIMITS,
  ORCHESTRATOR_LIMIT_KEYS,
  ORCHESTRATOR_SETTINGS_KEY,
  coerceOrchestratorLimits,
  describeOrchestratorLimits,
  extractOrchestratorRaw,
  mergeOrchestratorLimits,
  orchestratorConfigPaths,
  orchestratorFieldSourceOf,
  orchestratorLimitDiagnostics,
  deprecatedVerificationTimeoutDiagnostics,
  readOrchestratorLimits,
} from "./orchestrator-config.ts";
import { DEFAULT_CHILD_TIMEOUT_MS } from "./orchestrator-child-controller.ts";
import { DEFAULT_GIT_TIMEOUT_MS } from "./git-bounded.ts";
import { WORKFLOW_SETTINGS_KEY } from "./review.ts";
import { HARD_MAX_SHELL_TIMEOUT_SECONDS } from "./shell-guard.ts";
import { createOrchestratorChildController } from "./orchestrator-child-controller.ts";
import { tmpProject } from "./test-support.ts";

function writeSettings(dir: string, value: unknown, project = false): string {
  const fp = project
    ? path.join(dir, ".pi", "settings.json")
    : path.join(dir, "settings.json");
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, JSON.stringify(value), "utf8");
  return fp;
}

// ── defaults and coercion ────────────────────────────────────────────

test("orchestrator limits: defaults mirror the execution constants", () => {
  assert.equal(DEFAULT_ORCHESTRATOR_LIMITS.childTimeoutMs, DEFAULT_CHILD_TIMEOUT_MS);
  assert.equal(DEFAULT_ORCHESTRATOR_LIMITS.gitTimeoutMs, DEFAULT_GIT_TIMEOUT_MS);
  assert.deepEqual([...ORCHESTRATOR_LIMIT_KEYS], ["childTimeoutMs", "gitTimeoutMs"]);
});

test("orchestrator coerce: garbage and missing keys keep the defaults", () => {
  for (const raw of [undefined, null, 42, [], "x", true, {}]) {
    assert.deepEqual(coerceOrchestratorLimits(raw), {
      ...DEFAULT_ORCHESTRATOR_LIMITS,
    });
  }
});

test("orchestrator coerce: valid values are floored, never widened past the cap", () => {
  const coerced = coerceOrchestratorLimits({
    childTimeoutMs: 1_234.9,
    gitTimeoutMs: 5_000,
  });
  assert.deepEqual(coerced, {
    childTimeoutMs: 1_234,
    gitTimeoutMs: 5_000,
  });

  const capped = coerceOrchestratorLimits({
    childTimeoutMs: HARD_MAX_SHELL_TIMEOUT_SECONDS * 1_000 * 10,
    gitTimeoutMs: HARD_MAX_SHELL_TIMEOUT_SECONDS * 1_000 * 10,
  });
  assert.equal(capped.childTimeoutMs, HARD_MAX_SHELL_TIMEOUT_SECONDS * 1_000);
  assert.equal(capped.gitTimeoutMs, HARD_MAX_SHELL_TIMEOUT_SECONDS * 1_000);
});

test("orchestrator coerce: invalid values fall back to the base", () => {
  const base = {
    childTimeoutMs: 10_000,
    gitTimeoutMs: 20_000,
  };
  for (const bad of ["60000", -1, 0, Number.NaN, Number.POSITIVE_INFINITY, null, {}]) {
    assert.deepEqual(
      coerceOrchestratorLimits({ childTimeoutMs: bad, gitTimeoutMs: bad }, base),
      base,
    );
  }
});

// ── diagnostics ─────────────────────────────────────────────────────

test("orchestrator diagnostics: one entry per invalid present value", () => {
  const diagnostics = orchestratorLimitDiagnostics(
    {
      childTimeoutMs: "soon",
      gitTimeoutMs: -5,
      unknownKey: 1,
    },
    "project",
  );
  assert.equal(diagnostics.length, 2);
  assert.deepEqual(
    diagnostics.map((entry) => entry.key).sort(),
    ["childTimeoutMs", "gitTimeoutMs"],
  );
  for (const entry of diagnostics) {
    assert.equal(entry.scope, "project");
    assert.match(entry.message, /workflow\.orchestrator\./);
    assert.match(entry.message, /ignoring/);
  }
});

test("orchestrator diagnostics: missing and valid values produce nothing", () => {
  assert.deepEqual(orchestratorLimitDiagnostics({}, "global"), []);
  assert.deepEqual(
    orchestratorLimitDiagnostics(
      { childTimeoutMs: 1_000, verificationTimeoutSeconds: 1, gitTimeoutMs: 1 },
      "global",
    ),
    [],
  );
  assert.deepEqual(orchestratorLimitDiagnostics(undefined, "global"), []);
});

// ── extract / merge / provenance ────────────────────────────────────

test("orchestrator extract: only a nested object fragment is read", () => {
  assert.deepEqual(
    extractOrchestratorRaw({
      [WORKFLOW_SETTINGS_KEY]: {
        [ORCHESTRATOR_SETTINGS_KEY]: { childTimeoutMs: 1_000 },
      },
    }),
    { childTimeoutMs: 1_000 },
  );
  for (const junk of [
    null,
    undefined,
    42,
    "x",
    [],
    { workflow: 5 },
    { workflow: { orchestrator: [] } },
    { workflow: { orchestrator: "x" } },
  ]) {
    assert.equal(extractOrchestratorRaw(junk), undefined);
  }
});

test("orchestrator merge: project wins field by field over global and default", () => {
  const merged = mergeOrchestratorLimits(
    { childTimeoutMs: 1_000 },
    { gitTimeoutMs: 5_000 },
  );
  assert.deepEqual(merged, {
    childTimeoutMs: 1_000,
    gitTimeoutMs: 5_000,
  });
});

test("orchestrator merge: an invalid project value does not shadow global", () => {
  const merged = mergeOrchestratorLimits(
    { childTimeoutMs: 2_000 },
    { childTimeoutMs: "nope" },
  );
  assert.equal(merged.childTimeoutMs, 2_000);
});

test("orchestrator field source: project > global > default", () => {
  assert.equal(
    orchestratorFieldSourceOf(undefined, undefined, "childTimeoutMs"),
    "default",
  );
  assert.equal(
    orchestratorFieldSourceOf({ childTimeoutMs: 1 }, undefined, "childTimeoutMs"),
    "global",
  );
  assert.equal(
    orchestratorFieldSourceOf(
      { childTimeoutMs: 1 },
      { childTimeoutMs: 2 },
      "childTimeoutMs",
    ),
    "project",
  );
});

// ── disk resolution ─────────────────────────────────────────────────

test("orchestrator read: global then project from disk, with provenance", () => {
  const { cwd, agentDir } = tmpProject();
  writeSettings(agentDir, {
    [WORKFLOW_SETTINGS_KEY]: {
      [ORCHESTRATOR_SETTINGS_KEY]: {
        childTimeoutMs: 60_000,
      },
    },
  });
  writeSettings(cwd, {
    [WORKFLOW_SETTINGS_KEY]: {
      [ORCHESTRATOR_SETTINGS_KEY]: {
        gitTimeoutMs: 45_000,
        // Removed key: reported, never applied.
        verificationTimeoutSeconds: 45,
      },
    },
  }, true);

  const resolved = readOrchestratorLimits(cwd, agentDir);
  assert.deepEqual(resolved.config, {
    childTimeoutMs: 60_000,
    gitTimeoutMs: 45_000,
  });
  assert.equal(resolved.sources.childTimeout, "global");
  assert.equal(resolved.sources.gitTimeout, "project");
  assert.equal(resolved.sources.global, true);
  assert.equal(resolved.sources.project, true);
  assert.deepEqual(
    resolved.diagnostics.map((entry) => entry.key),
    ["verificationTimeoutSeconds"],
  );
  assert.match(resolved.diagnostics[0]?.message ?? "", /no longer used/);
});

test("orchestrator read: corrupt files fall back to defaults without throwing", () => {
  const { cwd, agentDir } = tmpProject();
  const fp = orchestratorConfigPaths(cwd, agentDir).project;
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, "{not json", "utf8");

  const resolved = readOrchestratorLimits(cwd, agentDir);
  assert.deepEqual(resolved.config, { ...DEFAULT_ORCHESTRATOR_LIMITS });
  assert.equal(resolved.sources.global, false);
  assert.equal(resolved.sources.project, false);
});

test("orchestrator read: invalid values are reported with their scope", () => {
  const { cwd, agentDir } = tmpProject();
  writeSettings(cwd, {
    [WORKFLOW_SETTINGS_KEY]: {
      [ORCHESTRATOR_SETTINGS_KEY]: { childTimeoutMs: -1 },
    },
  }, true);
  const resolved = readOrchestratorLimits(cwd, agentDir);
  assert.equal(resolved.config.childTimeoutMs, DEFAULT_ORCHESTRATOR_LIMITS.childTimeoutMs);
  assert.equal(resolved.diagnostics.length, 1);
  assert.equal(resolved.diagnostics[0]!.scope, "project");
  assert.equal(resolved.diagnostics[0]!.key, "childTimeoutMs");
});

// ── effective verification deadline ─────────────────────────────────

test("a removed verificationTimeoutSeconds is reported, never applied", () => {
  const diagnostics = deprecatedVerificationTimeoutDiagnostics(
    { verificationTimeoutSeconds: 900 },
    "global",
  );
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0]?.key, "verificationTimeoutSeconds");
  assert.match(diagnostics[0]?.message ?? "", /no longer used/);
  assert.deepEqual(
    deprecatedVerificationTimeoutDiagnostics({ childTimeoutMs: 1 }, "global"),
    [],
  );
});

test("describe: one bounded line names every limit", () => {
  const line = describeOrchestratorLimits(DEFAULT_ORCHESTRATOR_LIMITS);
  assert.match(line, /child \d+s/);
  assert.doesNotMatch(line, /checks/);
  assert.match(line, /git \d+s/);
});

// ── controller wiring ───────────────────────────────────────────────

test("reduced childTimeoutMs reaches the controller port", async () => {
  const child = {
    sessionId: "s",
    modelLabel: "fake/model",
    subscribe: () => () => undefined,
    prompt: async () => undefined,
    followUp: async () => undefined,
    abort: async () => undefined,
    isStreaming: () => false,
    dispose: () => undefined,
  };
  let settled = 0;
  let failed = "";
  const controller = createOrchestratorChildController({
    create: async () => ({ ok: true, child, modelLabel: child.modelLabel }),
    buildPrompt: () => "do the row",
    onSettled: () => {
      settled += 1;
    },
    onError: ({ error }) => {
      failed = error;
    },
    timeoutMs: 20,
  });
  const run = controller.start({
    sessionId: "s",
    taskId: "task-1",
    attemptId: "a",
    ref: "1",
    total: 1,
  });
  await new Promise((resolve) => setTimeout(resolve, 80));
  await run;
  assert.equal(settled, 0);
  assert.match(failed, /did not finish/i);
  assert.equal(controller.state().phase, "disposed");
});

// Guard against a key list drifting away from the interface.
test("orchestrator keys match the limits interface", () => {
  assert.deepEqual([...ORCHESTRATOR_LIMIT_KEYS].sort(), [
    "childTimeoutMs",
    "gitTimeoutMs",
  ]);
});
