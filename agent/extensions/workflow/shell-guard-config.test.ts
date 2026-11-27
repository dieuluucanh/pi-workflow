/**
 * Configuration tests for workflow.shellGuard.
 *
 * Every write goes to a temporary agent/project directory. This suite must
 * never touch the live ~/.pi/agent/settings.json.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  SHELL_GUARD_LIMITS_ENV,
  SHELL_GUARD_SETTINGS_KEY,
  applyInheritedShellLimits,
  coerceShellGuardConfig,
  decodeShellLimitsEnv,
  effectiveShellLimits,
  encodeShellLimitsEnv,
  extractShellGuardRaw,
  mergeShellGuardConfig,
  parseShellGuardArgs,
  readShellGuardConfig,
  shellGuardArgumentCompletions,
  shellGuardFieldSource,
  writeShellGuardConfig,
} from "./shell-guard-config.ts";
import { DEFAULT_SHELL_LIMITS } from "./shell-guard.ts";

function tmpPair(): { root: string; cwd: string; agentDir: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shell-guard-"));
  const cwd = path.join(root, "project");
  const agentDir = path.join(root, "agent");
  fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
  fs.mkdirSync(agentDir, { recursive: true });
  return { root, cwd, agentDir };
}

function writeSettings(file: string, value: unknown): void {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

test("config: missing files use 120s/900s defaults", () => {
  const { cwd, agentDir } = tmpPair();
  const resolved = readShellGuardConfig(cwd, agentDir);
  assert.deepEqual(resolved.config, DEFAULT_SHELL_LIMITS);
  assert.equal(resolved.sources.defaultTimeout, "default");
  assert.equal(resolved.sources.maxTimeout, "default");
  assert.equal(resolved.sources.projectIgnored, false);
});

test("config: extraction accepts only workflow.shellGuard objects", () => {
  assert.deepEqual(
    extractShellGuardRaw({ workflow: { shellGuard: { defaultTimeoutSeconds: 30 } } }),
    { defaultTimeoutSeconds: 30 },
  );
  assert.equal(extractShellGuardRaw({ workflow: { shellGuard: "off" } }), undefined);
  assert.equal(extractShellGuardRaw({ workflow: { shellGuard: [] } }), undefined);
  assert.equal(extractShellGuardRaw(undefined), undefined);
});

test("config: invalid values fall back and the pair is repaired", () => {
  assert.deepEqual(coerceShellGuardConfig({}), DEFAULT_SHELL_LIMITS);
  assert.deepEqual(
    coerceShellGuardConfig({ defaultTimeoutSeconds: 0, maxTimeoutSeconds: "x" }),
    DEFAULT_SHELL_LIMITS,
  );
  assert.deepEqual(
    coerceShellGuardConfig({ defaultTimeoutSeconds: 500, maxTimeoutSeconds: 300 }),
    { defaultTimeoutSeconds: 300, maxTimeoutSeconds: 300 },
  );
  assert.deepEqual(
    coerceShellGuardConfig({ defaultTimeoutSeconds: 10, maxTimeoutSeconds: 99_999 }),
    { defaultTimeoutSeconds: 10, maxTimeoutSeconds: 3_600 },
  );
});

test("config: project wins field by field; provenance is explicit", () => {
  const globalRaw = { defaultTimeoutSeconds: 60 };
  const projectRaw = { maxTimeoutSeconds: 300 };
  assert.deepEqual(mergeShellGuardConfig(globalRaw, projectRaw), {
    defaultTimeoutSeconds: 60,
    maxTimeoutSeconds: 300,
  });
  assert.equal(shellGuardFieldSource(globalRaw, projectRaw, "defaultTimeoutSeconds"), "global");
  assert.equal(shellGuardFieldSource(globalRaw, projectRaw, "maxTimeoutSeconds"), "project");
  assert.equal(shellGuardFieldSource(undefined, undefined, "maxTimeoutSeconds"), "default");
});

test("config: a trusted project overrides, an untrusted one is ignored", () => {
  const { cwd, agentDir } = tmpPair();
  writeSettings(path.join(agentDir, "settings.json"), {
    workflow: { [SHELL_GUARD_SETTINGS_KEY]: { defaultTimeoutSeconds: 60, maxTimeoutSeconds: 300 } },
  });
  writeSettings(path.join(cwd, ".pi", "settings.json"), {
    workflow: { [SHELL_GUARD_SETTINGS_KEY]: { defaultTimeoutSeconds: 240, maxTimeoutSeconds: 600 } },
  });

  const trusted = readShellGuardConfig(cwd, agentDir, { trusted: true });
  assert.deepEqual(trusted.config, { defaultTimeoutSeconds: 240, maxTimeoutSeconds: 600 });

  const untrusted = readShellGuardConfig(cwd, agentDir, { trusted: false });
  assert.deepEqual(untrusted.config, { defaultTimeoutSeconds: 60, maxTimeoutSeconds: 300 });
  assert.equal(untrusted.sources.projectIgnored, true);
});

test("config: write is sparse and preserves unrelated keys", () => {
  const { cwd, agentDir } = tmpPair();
  const global = path.join(agentDir, "settings.json");
  writeSettings(global, {
    theme: "dark",
    workflow: {
      commitPolicy: { mode: "never" },
      [SHELL_GUARD_SETTINGS_KEY]: { maxTimeoutSeconds: 300 },
    },
  });

  const out = writeShellGuardConfig("global", cwd, agentDir, {
    defaultTimeoutSeconds: 60,
  });
  assert.equal(out.ok, true, out.error);
  const saved = JSON.parse(fs.readFileSync(global, "utf8"));
  assert.equal(saved.theme, "dark");
  assert.equal(saved.workflow.commitPolicy.mode, "never");
  assert.deepEqual(saved.workflow.shellGuard, {
    maxTimeoutSeconds: 300,
    defaultTimeoutSeconds: 60,
  });
});

test("config: write repairs a default above the maximum", () => {
  const { cwd, agentDir } = tmpPair();
  const out = writeShellGuardConfig("global", cwd, agentDir, {
    defaultTimeoutSeconds: 500,
    maxTimeoutSeconds: 300,
  });
  assert.equal(out.ok, true, out.error);
  assert.deepEqual(readShellGuardConfig(cwd, agentDir).config, {
    defaultTimeoutSeconds: 300,
    maxTimeoutSeconds: 300,
  });
});

test("config: write refuses a corrupt file instead of replacing it", () => {
  const { cwd, agentDir } = tmpPair();
  const global = path.join(agentDir, "settings.json");
  fs.writeFileSync(global, "{ not json", "utf8");
  const out = writeShellGuardConfig("global", cwd, agentDir, {
    defaultTimeoutSeconds: 60,
  });
  assert.equal(out.ok, false);
  assert.match(out.error ?? "", /cannot parse/);
  assert.equal(fs.readFileSync(global, "utf8"), "{ not json");
});

test("inheritance: encode/decode round-trip and malformed input", () => {
  const encoded = encodeShellLimitsEnv({ defaultTimeoutSeconds: 30, maxTimeoutSeconds: 120 });
  assert.deepEqual(decodeShellLimitsEnv(encoded), {
    ok: true,
    limits: { defaultTimeoutSeconds: 30, maxTimeoutSeconds: 120 },
  });
  assert.equal(decodeShellLimitsEnv("").ok, false);
  assert.equal(decodeShellLimitsEnv("{").ok, false);
  assert.equal(decodeShellLimitsEnv(JSON.stringify({ defaultTimeoutSeconds: 0, maxTimeoutSeconds: 10 })).ok, false);
});

test("inheritance: a child can never widen the parent's limits", () => {
  assert.deepEqual(
    applyInheritedShellLimits(
      { defaultTimeoutSeconds: 300, maxTimeoutSeconds: 600 },
      { defaultTimeoutSeconds: 120, maxTimeoutSeconds: 900 },
    ),
    { defaultTimeoutSeconds: 120, maxTimeoutSeconds: 600 },
  );
  assert.deepEqual(
    applyInheritedShellLimits(
      { defaultTimeoutSeconds: 30, maxTimeoutSeconds: 2_000 },
      { defaultTimeoutSeconds: 120, maxTimeoutSeconds: 600 },
    ),
    { defaultTimeoutSeconds: 30, maxTimeoutSeconds: 600 },
  );
  assert.deepEqual(
    applyInheritedShellLimits(
      { defaultTimeoutSeconds: 30, maxTimeoutSeconds: 60 },
      undefined,
    ),
    { defaultTimeoutSeconds: 30, maxTimeoutSeconds: 60 },
  );
});

test("inheritance: effectiveShellLimits applies the env snapshot", () => {
  const { cwd, agentDir } = tmpPair();
  writeSettings(path.join(agentDir, "settings.json"), {
    workflow: { shellGuard: { defaultTimeoutSeconds: 300, maxTimeoutSeconds: 900 } },
  });
  const resolved = effectiveShellLimits(cwd, agentDir, {
    env: {
      [SHELL_GUARD_LIMITS_ENV]: encodeShellLimitsEnv({
        defaultTimeoutSeconds: 60,
        maxTimeoutSeconds: 180,
      }),
    },
  });
  assert.deepEqual(resolved.config, {
    defaultTimeoutSeconds: 60,
    maxTimeoutSeconds: 180,
  });
  assert.equal(resolved.inherited, true);
});

test("inheritance: malformed env is reported and ignored", () => {
  const { cwd, agentDir } = tmpPair();
  const resolved = effectiveShellLimits(cwd, agentDir, {
    env: { [SHELL_GUARD_LIMITS_ENV]: "nonsense" },
  });
  assert.deepEqual(resolved.config, DEFAULT_SHELL_LIMITS);
  assert.equal(resolved.inherited, false);
  assert.ok(resolved.inheritedError);
});

test("args: status, limits and reset parse strictly", () => {
  assert.deepEqual(parseShellGuardArgs(""), { action: "status" });
  assert.deepEqual(parseShellGuardArgs("status"), { action: "status" });
  assert.deepEqual(parseShellGuardArgs("reset"), { action: "reset" });
  assert.deepEqual(parseShellGuardArgs("limits 60 300"), {
    action: "limits",
    limits: { defaultTimeoutSeconds: 60, maxTimeoutSeconds: 300 },
    scope: "global",
  });
  assert.deepEqual(parseShellGuardArgs("limits 60 300 project"), {
    action: "limits",
    limits: { defaultTimeoutSeconds: 60, maxTimeoutSeconds: 300 },
    scope: "project",
  });
});

test("args: zero, unlimited, fractions, missing values and extras are refused", () => {
  for (const args of [
    "limits 0 300",
    "limits 60",
    "limits 60 300 extra",
    "limits 60.5 300",
    "limits unlimited 300",
    "status now",
    "reset now",
    "off",
  ]) {
    assert.equal(parseShellGuardArgs(args).action, "error", args);
  }
  const above = parseShellGuardArgs("limits 60 99999");
  assert.equal(above.action, "error");
  const inverted = parseShellGuardArgs("limits 300 60");
  assert.equal(inverted.action, "error");
});

test("completions: subcommands and the limits scope position", () => {
  const subs = shellGuardArgumentCompletions("");
  assert.ok(subs);
  assert.deepEqual(subs?.map((s) => s.label), ["status", "limits", "reset"]);

  assert.ok(shellGuardArgumentCompletions("lim"));
  assert.equal(shellGuardArgumentCompletions("limx"), null);
  const scopes = shellGuardArgumentCompletions("limits 60 300 p");
  assert.deepEqual(scopes?.map((s) => s.label), ["project"]);
  assert.equal(shellGuardArgumentCompletions("limits 60 300 project"), null);
});
