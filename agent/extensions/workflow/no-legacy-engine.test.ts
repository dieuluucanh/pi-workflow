/**
 * No-legacy-engine guard.
 *
 * This test is the tripwire for the sweep: the removed engine must not creep
 * back through an import, a tool/status key, a stray token or a stale package
 * path. It also pins the live command/tool surface to the compat baseline.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import workflowExtension from "./index.ts";
import {
  fakeSdk,
  makeFakeCtx,
  makeFakePi,
  submitThenFinish,
  tmpProject,
} from "./test-support.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));

const DELETED_MODULES = [
  "orchestrator-runtime",
  "orchestrator-state",
  "orchestrator-store",
  "journal-payloads",
  "orchestrator-types",
  "orchestrator-check-repair",
  "orchestrator-repair-manifest",
  "orchestrator-adapters",
  "plan-spec",
  "plan-compiler",
  "plan-checks",
  "plan-checks-block",
  "plan-lint",
  "plan-command-shape",
  "frozen-snapshot",
  "todo-snapshot",
  "final-gate",
  "check-executor",
  "execution-state",
  "verification-deadline",
  "legacy-recovery",
] as const;

const FORBIDDEN_TOKENS = [
  "workflow_execution",
  "orchestrator-repair-checks",
  "workflow-execution",
  "planContract",
  "todos.frozen",
  "todos.freeze(",
  "executionState",
] as const;

function productionFiles(): string[] {
  return fs
    .readdirSync(HERE)
    .filter(
      (file) =>
        file.endsWith(".ts") &&
        !file.endsWith(".test.ts") &&
        !file.startsWith("test-support"),
    );
}

test("no-legacy: production source imports no deleted module", () => {
  for (const file of productionFiles()) {
    const source = fs.readFileSync(path.join(HERE, file), "utf8");
    for (const module of DELETED_MODULES) {
      assert.equal(
        source.includes(`from "./${module}.ts"`),
        false,
        `${file} still imports ${module}.ts`,
      );
    }
  }
});

test("no-legacy: the removed engine tokens are absent from production source", () => {
  for (const file of productionFiles()) {
    const source = fs.readFileSync(path.join(HERE, file), "utf8");
    for (const token of FORBIDDEN_TOKENS) {
      assert.equal(source.includes(token), false, `${file} still contains ${token}`);
    }
  }
});

test("no-legacy: no review tool accepts a replacement body", () => {
  for (const file of productionFiles()) {
    if (!file.startsWith("review")) continue;
    const source = fs.readFileSync(path.join(HERE, file), "utf8");
    assert.equal(source.includes("replacement-body"), false, `${file} replacement-body`);
    assert.equal(source.includes("replacementBody"), false, `${file} replacementBody`);
  }
});

test("no-legacy: every package.json files/test path exists", () => {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(HERE, "package.json"), "utf8"),
  ) as {
    files: string[];
    scripts: { test: string };
  };
  for (const entry of pkg.files) {
    assert.ok(fs.existsSync(path.join(HERE, entry)), `files[] missing: ${entry}`);
  }
  const tests = pkg.scripts.test.replace(/^node --test\s+/, "").trim().split(/\s+/);
  for (const entry of tests) {
    assert.ok(fs.existsSync(path.join(HERE, entry)), `test script missing: ${entry}`);
  }
});

test("no-legacy: the live command/tool surface equals the compat baseline", async () => {
  const baseline = JSON.parse(
    fs.readFileSync(path.join(HERE, "fixtures", "compat-baseline.json"), "utf8"),
  ) as { registeredTools: string[]; commands: string[] };
  const { cwd, agentDir } = tmpProject();
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const pi = makeFakePi({ activeTools: ["read", "write", "edit", "bash"] });
  const { sdk } = fakeSdk({ pass1: submitThenFinish("# Plan: guard") });
  try {
    await workflowExtension(pi as never, {
      loadSdk: async () => sdk as never,
      plannotatorRequestTimeoutMs: 20,
      plannotatorRecoveryTimeoutMs: 20,
      isTerminalHost: () => true,
    });
    const made = makeFakeCtx({ cwd, hasUI: false, branch: [] });
    await pi.emit("session_start", { reason: "startup" }, made.ctx);
    assert.deepEqual(Object.keys(pi.tools).sort(), baseline.registeredTools);
    assert.deepEqual(Object.keys(pi.commands).sort(), baseline.commands);
    assert.equal(
      Object.keys(pi.tools).includes("workflow_execution"),
      false,
      "the Build execution tool must stay removed",
    );
    assert.equal(
      Object.keys(pi.commands).includes("orchestrator-repair-checks"),
      false,
      "the repair command must stay removed",
    );
    await pi.emit("session_shutdown", { reason: "quit" }, made.ctx);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  }
});
