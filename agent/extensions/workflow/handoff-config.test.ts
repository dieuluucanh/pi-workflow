/**
 * Workflow Extension — Handoff target config tests
 *
 * Run with: npm test   (node --test, type-stripping — no build step)
 *
 * Covers the pure `workflow.handoff` surface: coercion (string shorthand,
 * object form, garbage), merge precedence (defaults < global < project), scope
 * attribution, disk round-trips via temp dirs, the "preserve every other key"
 * read-modify-write guarantee, the presenter decision, timeout precedence and
 * the `/handoff` argument completions.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import {
  DEFAULT_HANDOFF_CONFIG,
  DEFAULT_HANDOFF_TIMEOUT_MS,
  HANDOFF_MODES,
  HANDOFF_SETTINGS_KEY,
  HANDOFF_TIMEOUT_MAX,
  HANDOFF_TIMEOUT_MIN,
  coerceHandoffConfig,
  describeExecutionDestination,
  describeHandoffMode,
  extractHandoffRaw,
  handoffArgumentCompletions,
  handoffConfigPaths,
  handoffFieldSourceOf,
  isExecutionDestination,
  isHandoffMode,
  mergeHandoffConfig,
  readHandoffConfig,
  resolveHandoffTimeout,
  shouldUsePlannotator,
  writeHandoffConfig,
} from "./handoff-config.ts";
import { WORKFLOW_SETTINGS_KEY } from "./review.ts";
import { tmpProject } from "./test-support.ts";

// ── coerceHandoffConfig ──────────────────────────────────────────────

test("handoff coerce: defaults when raw is undefined/null/garbage", () => {
  for (const raw of [undefined, null, 42, [], {}, true]) {
    assert.deepEqual(coerceHandoffConfig(raw), { ...DEFAULT_HANDOFF_CONFIG });
  }
});

test("handoff coerce: string shorthand, trimmed and case-insensitive", () => {
  assert.deepEqual(coerceHandoffConfig("native"), {
    mode: "native",
    timeoutMs: DEFAULT_HANDOFF_TIMEOUT_MS,
    executionMode: "orchestrator",
  });
  assert.deepEqual(coerceHandoffConfig("  NAtive "), {
    mode: "native",
    timeoutMs: DEFAULT_HANDOFF_TIMEOUT_MS,
    executionMode: "orchestrator",
  });
  assert.deepEqual(coerceHandoffConfig("plannotator"), {
    mode: "plannotator",
    timeoutMs: DEFAULT_HANDOFF_TIMEOUT_MS,
    executionMode: "orchestrator",
  });
  assert.equal(coerceHandoffConfig("bogus").mode, "auto");
});

test("handoff coerce: object form accepts mode and timeoutMs", () => {
  assert.deepEqual(coerceHandoffConfig({ mode: "PLANNOTATOR" }), {
    mode: "plannotator",
    timeoutMs: DEFAULT_HANDOFF_TIMEOUT_MS,
    executionMode: "orchestrator",
  });
  assert.deepEqual(coerceHandoffConfig({ timeoutMs: 30_000 }), {
    mode: "auto",
    timeoutMs: 30_000,
    executionMode: "orchestrator",
  });
});

test("handoff coerce: invalid fields fall back to the base", () => {
  const base = {
    mode: "native" as const,
    timeoutMs: 7_000,
    executionMode: "build" as const,
  };
  assert.deepEqual(coerceHandoffConfig({ mode: "bogus" }, base), base);
  assert.deepEqual(coerceHandoffConfig({ mode: 7 }, base), base);
  assert.deepEqual(coerceHandoffConfig({ timeoutMs: "abc" }, base), base);
  assert.deepEqual(coerceHandoffConfig({ timeoutMs: Number.NaN }, base), base);
  assert.deepEqual(coerceHandoffConfig("bogus", base), base);
});

test("handoff coerce: timeout is clamped, not rejected", () => {
  assert.equal(coerceHandoffConfig({ timeoutMs: 1 }).timeoutMs, HANDOFF_TIMEOUT_MIN);
  assert.equal(
    coerceHandoffConfig({ timeoutMs: HANDOFF_TIMEOUT_MAX * 10 }).timeoutMs,
    HANDOFF_TIMEOUT_MAX,
  );
  assert.equal(coerceHandoffConfig({ timeoutMs: 5_000.9 }).timeoutMs, 5_000);
});

// ── extract / merge / provenance ─────────────────────────────────────

test("handoff extract: string and object fragments only", () => {
  assert.equal(extractHandoffRaw({ workflow: { handoff: "native" } }), "native");
  assert.deepEqual(
    extractHandoffRaw({ workflow: { handoff: { mode: "auto" } } }),
    { mode: "auto" },
  );
  for (const junk of [
    null,
    undefined,
    42,
    "x",
    [],
    { workflow: 5 },
    { workflow: { handoff: [] } },
    { workflow: { handoff: 5 } },
  ]) {
    assert.equal(extractHandoffRaw(junk), undefined);
  }
});

test("handoff merge: project wins field by field over global", () => {
  assert.deepEqual(
    mergeHandoffConfig(
      { mode: "plannotator", timeoutMs: 20_000 },
      { mode: "native" },
    ),
    { mode: "native", timeoutMs: 20_000, executionMode: "orchestrator" },
  );
  assert.deepEqual(
    mergeHandoffConfig("plannotator", { timeoutMs: 45_000 }),
    { mode: "plannotator", timeoutMs: 45_000, executionMode: "orchestrator" },
  );
  assert.deepEqual(mergeHandoffConfig(undefined, undefined), {
    ...DEFAULT_HANDOFF_CONFIG,
  });
  assert.deepEqual(mergeHandoffConfig(undefined, "native"), {
    mode: "native",
    timeoutMs: DEFAULT_HANDOFF_TIMEOUT_MS,
    executionMode: "orchestrator",
  });
});

test("handoff provenance: project > global > default", () => {
  assert.equal(handoffFieldSourceOf(undefined, undefined, "mode"), "default");
  assert.equal(handoffFieldSourceOf("native", undefined, "mode"), "global");
  assert.equal(handoffFieldSourceOf({ mode: "native" }, undefined, "mode"), "global");
  assert.equal(handoffFieldSourceOf(undefined, "native", "mode"), "project");
  assert.equal(
    handoffFieldSourceOf({ timeoutMs: 5_000 }, { mode: "auto" }, "timeoutMs"),
    "global",
  );
  assert.equal(
    handoffFieldSourceOf({ mode: "auto" }, "native", "timeoutMs"),
    "default",
    "a string shorthand carries no timeoutMs",
  );
  assert.equal(
    handoffFieldSourceOf({ timeoutMs: 5_000 }, { timeoutMs: 9_000 }, "timeoutMs"),
    "project",
  );
});

// ── disk read / write ────────────────────────────────────────────────

test("handoff read: global only, project only, both, corrupt and missing", () => {
  const { cwd, agentDir } = tmpProject();
  const paths = handoffConfigPaths(cwd, agentDir);
  assert.equal(paths.global, path.join(agentDir, "settings.json"));
  assert.equal(paths.project, path.join(cwd, ".pi", "settings.json"));

  let r = readHandoffConfig(cwd, agentDir);
  assert.deepEqual(r.config, { ...DEFAULT_HANDOFF_CONFIG });
  assert.equal(r.sources.global, false);
  assert.equal(r.sources.project, false);
  assert.equal(r.sources.mode, "default");
  assert.equal(r.sources.timeout, "default");

  fs.writeFileSync(
    paths.global,
    JSON.stringify({ [WORKFLOW_SETTINGS_KEY]: { [HANDOFF_SETTINGS_KEY]: "native" } }),
    "utf8",
  );
  r = readHandoffConfig(cwd, agentDir);
  assert.equal(r.config.mode, "native");
  assert.equal(r.sources.mode, "global");
  assert.equal(r.sources.timeout, "default");

  fs.mkdirSync(path.dirname(paths.project), { recursive: true });
  fs.writeFileSync(
    paths.project,
    JSON.stringify({
      [WORKFLOW_SETTINGS_KEY]: {
        [HANDOFF_SETTINGS_KEY]: { mode: "plannotator", timeoutMs: 30_000 },
      },
    }),
    "utf8",
  );
  r = readHandoffConfig(cwd, agentDir);
  assert.deepEqual(r.config, {
    mode: "plannotator",
    timeoutMs: 30_000,
    executionMode: "orchestrator",
  });
  assert.equal(r.sources.mode, "project");
  assert.equal(r.sources.timeout, "project");

  fs.writeFileSync(paths.project, "{ not json", "utf8");
  r = readHandoffConfig(cwd, agentDir);
  assert.equal(r.config.mode, "native", "corrupt project file is ignored");
  assert.equal(r.sources.project, false);
});

test("handoff write: round-trip preserves every unrelated key", () => {
  const { cwd, agentDir } = tmpProject();
  const fp = path.join(agentDir, "settings.json");
  fs.writeFileSync(
    fp,
    JSON.stringify({
      theme: "dark",
      packages: ["npm:@plannotator/pi-extension"],
      workflow: {
        reviewMode: { enabled: true, rounds: 3 },
        commitPolicy: { mode: "never" },
      },
    }),
    "utf8",
  );

  let res = writeHandoffConfig("global", cwd, agentDir, { mode: "native" });
  assert.equal(res.ok, true);
  let after = JSON.parse(fs.readFileSync(fp, "utf8"));
  assert.equal(after.theme, "dark");
  assert.deepEqual(after.packages, ["npm:@plannotator/pi-extension"]);
  assert.deepEqual(after.workflow.reviewMode, { enabled: true, rounds: 3 });
  assert.deepEqual(after.workflow.commitPolicy, { mode: "never" });
  assert.deepEqual(after.workflow.handoff, {
    mode: "native",
  });

  res = writeHandoffConfig("global", cwd, agentDir, { timeoutMs: 30_000 });
  assert.equal(res.ok, true);
  after = JSON.parse(fs.readFileSync(fp, "utf8"));
  assert.deepEqual(after.workflow.handoff, {
    mode: "native",
    timeoutMs: 30_000,
  });

  res = writeHandoffConfig("project", cwd, agentDir, { mode: "plannotator" });
  assert.equal(res.ok, true);
  assert.equal(res.path, path.join(cwd, ".pi", "settings.json"));
  const project = JSON.parse(fs.readFileSync(res.path, "utf8"));
  assert.deepEqual(
    project.workflow.handoff,
    { mode: "plannotator" },
    "sparse write keeps the global timeoutMs inherited",
  );

  const read = readHandoffConfig(cwd, agentDir);
  assert.equal(read.config.mode, "plannotator");
  assert.equal(read.config.timeoutMs, 30_000);
  assert.equal(read.sources.mode, "project");
  assert.equal(read.sources.timeout, "global");
});

test("handoff write: corrupt existing file is replaced, not fatal", () => {
  const { cwd, agentDir } = tmpProject();
  const fp = path.join(agentDir, "settings.json");
  fs.writeFileSync(fp, "{ not json", "utf8");
  const res = writeHandoffConfig("global", cwd, agentDir, { mode: "native" });
  assert.equal(res.ok, true);
  const after = JSON.parse(fs.readFileSync(fp, "utf8"));
  assert.deepEqual(after.workflow.handoff, { mode: "native" });
});

// ── presenter decision / timeout ─────────────────────────────────────

test("handoff presenter: auto follows detection, native never, plannotator always", () => {
  assert.equal(shouldUsePlannotator("auto", true), true);
  assert.equal(shouldUsePlannotator("auto", false), false);
  assert.equal(shouldUsePlannotator("native", true), false);
  assert.equal(shouldUsePlannotator("native", false), false);
  assert.equal(shouldUsePlannotator("plannotator", false), true);
  assert.equal(shouldUsePlannotator("plannotator", true), true);
});

test("handoff timeout: deps wins, otherwise config, clamped, default last", () => {
  assert.equal(resolveHandoffTimeout(50, 60_000), 50);
  assert.equal(resolveHandoffTimeout(undefined, 60_000), 60_000);
  assert.equal(resolveHandoffTimeout(undefined, 10), HANDOFF_TIMEOUT_MIN);
  assert.equal(
    resolveHandoffTimeout(undefined, HANDOFF_TIMEOUT_MAX * 2),
    HANDOFF_TIMEOUT_MAX,
  );
  assert.equal(
    resolveHandoffTimeout(undefined, Number.NaN),
    DEFAULT_HANDOFF_TIMEOUT_MS,
  );
});

test("handoff: isHandoffMode and describeHandoffMode are total", () => {
  for (const mode of HANDOFF_MODES) {
    assert.equal(isHandoffMode(mode), true);
    assert.equal(typeof describeHandoffMode(mode), "string");
    assert.ok(describeHandoffMode(mode).length > 0);
  }
  for (const junk of ["", "AUTO ", "n", null, 7, {}]) {
    assert.equal(isHandoffMode(junk), false);
  }
});

// ── /handoff argument completions ────────────────────────────────────

test("handoff completions: mode position lists modes and subcommands", () => {
  assert.deepEqual(
    handoffArgumentCompletions("")?.map((i) => i.value),
    [
      "auto ",
      "native ",
      "plannotator ",
      "execution ",
      "once ",
      "approve ",
      "continue ",
      "execute ",
      "status",
      "fallback",
    ],
  );
  assert.deepEqual(
    handoffArgumentCompletions("nat")?.map((i) => i.value),
    ["native "],
  );
  assert.deepEqual(
    handoffArgumentCompletions("fall")?.map((i) => i.value),
    ["fallback"],
  );
  assert.equal(handoffArgumentCompletions("zzz"), null);
});

test("handoff completions: scope position returns full-argument values", () => {
  assert.deepEqual(
    handoffArgumentCompletions("native ")?.map((i) => i.value),
    ["native global", "native project"],
  );
  assert.deepEqual(
    handoffArgumentCompletions("native pro")?.map((i) => i.value),
    ["native project"],
  );
  assert.equal(
    handoffArgumentCompletions("native project"),
    null,
    "exact-match suppression",
  );
  assert.equal(
    handoffArgumentCompletions("fallback "),
    null,
    "fallback takes no scope",
  );
  assert.equal(
    handoffArgumentCompletions("native project "),
    null,
    "scope already committed",
  );
  assert.equal(handoffArgumentCompletions("bogus "), null);
  assert.equal(handoffArgumentCompletions("native xyz"), null);
});

// ── Execution destination (plan step 3) ──────────────────────────────

test("destination: the default is orchestrator and is independent of the presenter", () => {
  assert.equal(DEFAULT_HANDOFF_CONFIG.executionMode, "orchestrator");
  assert.deepEqual(coerceHandoffConfig(undefined), {
    mode: "auto",
    timeoutMs: DEFAULT_HANDOFF_TIMEOUT_MS,
    executionMode: "orchestrator",
  });
  // A presenter-only edit never changes the destination and vice versa.
  assert.equal(coerceHandoffConfig({ mode: "native" }).executionMode, "orchestrator");
  assert.equal(coerceHandoffConfig({ executionMode: "build" }).mode, "auto");
});

test("destination: coercion trims, lowercases and falls back on garbage", () => {
  assert.equal(coerceHandoffConfig({ executionMode: " BUILD " }).executionMode, "build");
  assert.equal(coerceHandoffConfig({ executionMode: "orchestrator" }).executionMode, "orchestrator");
  for (const junk of [undefined, null, 7, "", "auto", "plan", {}, []]) {
    assert.equal(
      coerceHandoffConfig({ executionMode: junk }).executionMode,
      "orchestrator",
      JSON.stringify(junk),
    );
  }
  assert.equal(isExecutionDestination("orchestrator"), true);
  assert.equal(isExecutionDestination("build"), true);
  assert.equal(isExecutionDestination("auto"), false);
  assert.ok(describeExecutionDestination("build").includes("Build"));
  assert.ok(describeExecutionDestination("orchestrator").includes("breakdown"));
});

test("destination: merge is field-by-field, so a project destination keeps a global presenter", () => {
  assert.deepEqual(
    mergeHandoffConfig({ mode: "plannotator", timeoutMs: 20_000 }, { executionMode: "build" }),
    { mode: "plannotator", timeoutMs: 20_000, executionMode: "build" },
  );
  assert.deepEqual(
    mergeHandoffConfig({ executionMode: "build" }, { mode: "native" }),
    { mode: "native", timeoutMs: DEFAULT_HANDOFF_TIMEOUT_MS, executionMode: "build" },
  );
  assert.equal(
    handoffFieldSourceOf(undefined, { executionMode: "build" }, "executionMode"),
    "project",
  );
  assert.equal(
    handoffFieldSourceOf({ executionMode: "build" }, { mode: "native" }, "executionMode"),
    "global",
  );
  assert.equal(handoffFieldSourceOf(undefined, undefined, "executionMode"), "default");
});

test("destination: a sparse write stores only the destination and preserves unrelated keys", () => {
  const { root, cwd, agentDir } = tmpProject();
  try {
    fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
    fs.writeFileSync(
      path.join(cwd, ".pi", "settings.json"),
      JSON.stringify({ theme: "x", workflow: { reviewMode: { enabled: true } } }, null, 2),
    );
    const res = writeHandoffConfig("project", cwd, agentDir, { executionMode: "build" });
    assert.equal(res.ok, true);
    const root = JSON.parse(fs.readFileSync(res.path, "utf8"));
    assert.equal(root.theme, "x");
    assert.deepEqual(root.workflow.reviewMode, { enabled: true });
    assert.deepEqual(root.workflow.handoff, { executionMode: "build" });
    const resolved = readHandoffConfig(cwd, agentDir);
    assert.equal(resolved.config.executionMode, "build");
    assert.equal(resolved.config.mode, "auto", "the presenter stays at its default");
    assert.equal(resolved.sources.execution, "project");

    // A later presenter write must not materialize the destination.
    const second = writeHandoffConfig("project", cwd, agentDir, { mode: "native" });
    assert.equal(second.ok, true);
    const after = JSON.parse(fs.readFileSync(second.path, "utf8"));
    assert.equal(after.workflow.handoff.executionMode, "build");
    assert.equal(after.workflow.handoff.mode, "native");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("destination: retained string shorthand does not lose its presenter", () => {
  const { root, cwd, agentDir } = tmpProject();
  try {
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentDir, "settings.json"),
      JSON.stringify({ workflow: { handoff: "native" } }, null, 2),
    );
    const res = writeHandoffConfig("global", cwd, agentDir, { executionMode: "build" });
    assert.equal(res.ok, true);
    const root = JSON.parse(fs.readFileSync(res.path, "utf8"));
    assert.equal(root.workflow.handoff.mode, "native");
    assert.equal(root.workflow.handoff.executionMode, "build");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("destination completions: execution takes a destination then a scope; once takes a destination", () => {
  assert.deepEqual(
    handoffArgumentCompletions("execution ")?.map((i) => i.value),
    ["execution orchestrator", "execution build"],
  );
  assert.deepEqual(
    handoffArgumentCompletions("execution or")?.map((i) => i.value),
    ["execution orchestrator"],
  );
  assert.deepEqual(
    handoffArgumentCompletions("execution orchestrator ")?.map((i) => i.value),
    ["execution orchestrator global", "execution orchestrator project"],
  );
  assert.deepEqual(
    handoffArgumentCompletions("once ")?.map((i) => i.value),
    ["once orchestrator", "once build"],
  );
  assert.equal(handoffArgumentCompletions("once build "), null, "once takes no scope");
  assert.equal(handoffArgumentCompletions("status"), null, "status is complete");
  assert.equal(handoffArgumentCompletions("execution build extra "), null);
});
