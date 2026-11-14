/**
 * Workflow Extension — Read Policy tests
 *
 * Run with: npm test   (node --test, type-stripping — no build step)
 *
 * Config coercion/merge/trust/round-trips, the pure decision table, dialog
 * labels/parsing, denial text, grant-root derivation and completions.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  DEFAULT_READ_POLICY_CONFIG,
  READ_DENY_WITH_INSTRUCTIONS_LABEL,
  READ_INSTRUCTION_MAX_LEN,
  READ_POLICY_KEY,
  buildReadDenyReason,
  buildReadGuidanceMessage,
  coerceReadPolicyConfig,
  decideReadGate,
  describeReadPolicy,
  describeReadShellMode,
  extractReadPolicyRaw,
  grantRootForTarget,
  mergeReadPolicyConfig,
  parseReadGateChoice,
  readGateAlwaysLabel,
  readGateOptions,
  readPolicyArgumentCompletions,
  readReadPolicyConfig,
  revokeReadPolicyPath,
  sanitizeReadInstruction,
  writeReadPolicyConfig,
} from "./read-policy.ts";
import { WORKFLOW_SETTINGS_KEY } from "./commit-policy.ts";
import { DEFAULT_FOLDER_POLICY_CONFIG, normalizePolicyPath } from "./folder-policy.ts";

function tmpCwd(): { cwd: string; agentDir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-read-policy-"));
  const cwd = path.join(dir, "proj");
  const agentDir = path.join(dir, "agent");
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(agentDir, { recursive: true });
  return {
    cwd,
    agentDir,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

function writeJson(fp: string, value: unknown): void {
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

// ── config ──────────────────────────────────────────────────────────

test("coerce: defaults, bare shell string, garbage and lists", () => {
  assert.deepEqual(coerceReadPolicyConfig(undefined), {
    ...DEFAULT_READ_POLICY_CONFIG,
  });
  assert.equal(coerceReadPolicyConfig("strict").shell, "strict");
  assert.equal(coerceReadPolicyConfig("  STRICT ").shell, "strict");
  assert.equal(coerceReadPolicyConfig("bogus").shell, "paths");
  assert.equal(coerceReadPolicyConfig(42).shell, "paths");
  const cfg = coerceReadPolicyConfig({
    allowedPaths: [" ../shared ", "", 7, "../shared"],
    shell: "strict",
    guardedTools: ["office_read", "office_read", 4],
  });
  assert.deepEqual(cfg.allowedPaths, ["../shared"]);
  assert.equal(cfg.shell, "strict");
  assert.deepEqual(cfg.guardedTools, ["office_read"]);
});

test("extract: pulls workflow.readPolicy", () => {
  const raw = extractReadPolicyRaw({
    [WORKFLOW_SETTINGS_KEY]: { [READ_POLICY_KEY]: { shell: "strict" } },
  });
  assert.equal(
    typeof raw === "object" ? raw?.shell : raw,
    "strict",
  );
  assert.equal(
    extractReadPolicyRaw({
      [WORKFLOW_SETTINGS_KEY]: { [READ_POLICY_KEY]: "strict" },
    }),
    "strict",
  );
  assert.equal(extractReadPolicyRaw(undefined), undefined);
  assert.equal(extractReadPolicyRaw({ workflow: [] }), undefined);
});

test("merge: shell project-over-global, lists unioned", () => {
  const merged = mergeReadPolicyConfig(
    { shell: "paths", allowedPaths: ["../a"], guardedTools: ["x"] },
    { shell: "strict", allowedPaths: ["../b"], guardedTools: ["y"] },
  );
  assert.equal(merged.shell, "strict");
  assert.deepEqual(merged.allowedPaths, ["../a", "../b"]);
  assert.deepEqual(merged.guardedTools, ["x", "y"]);
});

test("read: project settings ignored unless trusted", () => {
  const { cwd, agentDir, cleanup } = tmpCwd();
  try {
    writeJson(path.join(cwd, ".pi", "settings.json"), {
      [WORKFLOW_SETTINGS_KEY]: {
        [READ_POLICY_KEY]: { shell: "strict", allowedPaths: ["../x"] },
      },
    });
    const untrusted = readReadPolicyConfig(cwd, agentDir, { trusted: false });
    assert.equal(untrusted.config.shell, "paths");
    assert.equal(untrusted.sources.projectIgnored, true);
    const trusted = readReadPolicyConfig(cwd, agentDir, { trusted: true });
    assert.equal(trusted.config.shell, "strict");
    assert.deepEqual(trusted.config.allowedPaths, ["../x"]);
    assert.equal(trusted.sources.shell, "project");
  } finally {
    cleanup();
  }
});

test("write/revoke: read-modify-write preserves other keys", () => {
  const { cwd, agentDir, cleanup } = tmpCwd();
  try {
    writeJson(path.join(agentDir, "settings.json"), {
      theme: "dark",
      [WORKFLOW_SETTINGS_KEY]: { reviewMode: { enabled: true } },
    });
    const add = writeReadPolicyConfig("global", cwd, agentDir, {
      allowedPaths: ["../shared"],
      shell: "strict",
    });
    assert.equal(add.ok, true);
    let raw = JSON.parse(fs.readFileSync(add.path, "utf8"));
    assert.equal(raw.theme, "dark");
    assert.equal(raw.workflow.reviewMode.enabled, true);
    assert.deepEqual(raw.workflow.readPolicy.allowedPaths, ["../shared"]);
    assert.equal(raw.workflow.readPolicy.shell, "strict");

    const revoke = revokeReadPolicyPath(
      "global",
      cwd,
      agentDir,
      "../shared",
    );
    assert.equal(revoke.ok, true);
    assert.equal(revoke.removed, true);
    raw = JSON.parse(fs.readFileSync(add.path, "utf8"));
    assert.deepEqual(raw.workflow.readPolicy.allowedPaths, []);
    assert.equal(raw.theme, "dark");
  } finally {
    cleanup();
  }
});

test("write: locked subagent cannot mutate settings", () => {
  const { cwd, agentDir, cleanup } = tmpCwd();
  const previous = process.env.PI_FOLDER_POLICY_LOCKED;
  try {
    process.env.PI_FOLDER_POLICY_LOCKED = "1";
    const res = writeReadPolicyConfig("global", cwd, agentDir, {
      shell: "strict",
    });
    assert.equal(res.ok, false);
  } finally {
    if (previous === undefined) delete process.env.PI_FOLDER_POLICY_LOCKED;
    else process.env.PI_FOLDER_POLICY_LOCKED = previous;
    cleanup();
  }
});

// ── decision ────────────────────────────────────────────────────────

test("decide: sensitive wins, outside ask/block, grants, strict uncertain", () => {
  assert.equal(
    decideReadGate({
      sensitive: true,
      outside: false,
      outsideAction: "ask",
      shell: "paths",
    }),
    "block",
  );
  assert.equal(
    decideReadGate({
      sensitive: false,
      outside: true,
      outsideAction: "ask",
      shell: "paths",
    }),
    "ask",
  );
  assert.equal(
    decideReadGate({
      sensitive: false,
      outside: true,
      outsideAction: "ask",
      granted: true,
      shell: "paths",
    }),
    "allow",
  );
  assert.equal(
    decideReadGate({
      sensitive: false,
      outside: true,
      outsideAction: "block",
      shell: "paths",
    }),
    "block",
  );
  assert.equal(
    decideReadGate({
      sensitive: false,
      outside: false,
      outsideAction: "ask",
      uncertain: true,
      shell: "paths",
    }),
    "allow",
  );
  assert.equal(
    decideReadGate({
      sensitive: false,
      outside: false,
      outsideAction: "ask",
      uncertain: true,
      shell: "strict",
    }),
    "ask",
  );
});

test("describe: shell modes", () => {
  assert.ok(describeReadShellMode("paths").includes("residual"));
  assert.ok(describeReadShellMode("strict").includes("ask"));
});

// ── dialog / denial ─────────────────────────────────────────────────

test("options: labels are the single source of parsing", () => {
  assert.deepEqual(readGateOptions("folder"), [
    "Allow once (this turn)",
    "Always allow this folder",
    "Deny",
    READ_DENY_WITH_INSTRUCTIONS_LABEL,
  ]);
  assert.deepEqual(readGateOptions("folders"), [
    "Allow once (this turn)",
    "Always allow these folders",
    "Deny",
    READ_DENY_WITH_INSTRUCTIONS_LABEL,
  ]);
  assert.deepEqual(readGateOptions("command"), [
    "Allow once (this turn)",
    "Deny",
    READ_DENY_WITH_INSTRUCTIONS_LABEL,
  ]);
  assert.equal(readGateAlwaysLabel("folder"), "Always allow this folder");
  assert.equal(readGateAlwaysLabel("command"), "");
});

test("parse: deny-with before deny; unknown/cancel denies", () => {
  assert.equal(parseReadGateChoice("Allow once (this turn)"), "allow-once");
  assert.equal(parseReadGateChoice("Always allow these folders"), "always");
  assert.equal(
    parseReadGateChoice(READ_DENY_WITH_INSTRUCTIONS_LABEL),
    "deny-with-instructions",
  );
  assert.equal(parseReadGateChoice("Deny"), "deny");
  assert.equal(parseReadGateChoice(undefined), "deny");
  assert.equal(parseReadGateChoice("something else"), "deny");
});

test("sanitize: CRLF, control chars, cap and empty", () => {
  assert.equal(sanitizeReadInstruction("  a\r\nb  "), "a\nb");
  assert.equal(sanitizeReadInstruction("a\u0000b"), "ab");
  assert.equal(sanitizeReadInstruction("   "), "");
  const long = "x".repeat(READ_INSTRUCTION_MAX_LEN + 20);
  assert.ok(sanitizeReadInstruction(long).length <= READ_INSTRUCTION_MAX_LEN + 1);
});

test("deny reasons: sensitive cannot be softened; outside/uncertain guidance", () => {
  const sensitive = buildReadDenyReason({
    kind: "sensitive",
    target: "/repo/.env",
    pattern: "**/.env",
  });
  assert.match(sensitive, /cannot be overridden/);
  assert.match(sensitive, /Do not retry/);
  const outside = buildReadDenyReason({
    kind: "outside",
    target: "/other",
    instruction: "use the docs folder only",
  });
  assert.match(outside, /outside the permitted folders/);
  assert.match(outside, /use the docs folder only/);
  assert.match(
    buildReadDenyReason({ kind: "uncertain", target: "node -e" }),
    /could not be verified/,
  );
});

test("guidance message carries target and instruction", () => {
  const message = buildReadGuidanceMessage({
    target: "/other",
    instruction: "do not read it",
  });
  assert.match(message, /^\[read denied/);
  assert.match(message, /\/other/);
  assert.match(message, /do not read it/);
});

// ── grant roots / status / completions ──────────────────────────────

test("grant roots: file -> dir, dir -> itself, glob -> prefix", () => {
  const file = normalizePolicyPath("/repo/src/a.ts", process.cwd());
  const dir = normalizePolicyPath("/repo/shared", process.cwd());
  const glob = normalizePolicyPath("/repo/src/**/*.ts", process.cwd());
  assert.equal(
    grantRootForTarget({ path: file, kind: "file" }),
    normalizePolicyPath("/repo/src", process.cwd()),
  );
  assert.equal(grantRootForTarget({ path: dir, kind: "dir" }), dir);
  assert.equal(
    grantRootForTarget({ path: glob, kind: "glob" }),
    normalizePolicyPath("/repo/src", process.cwd()),
  );
});

test("status: includes shared folder scope and read grants", () => {
  const text = describeReadPolicy(
    { ...DEFAULT_READ_POLICY_CONFIG, allowedPaths: ["../shared"], shell: "strict" },
    { ...DEFAULT_FOLDER_POLICY_CONFIG, mode: "parent", outside: "block" },
  );
  assert.match(text, /parent/);
  assert.match(text, /block/);
  assert.match(text, /strict/);
  assert.match(text, /\.\.\/shared/);
});

test("completions: subcommands, shell modes, scopes", () => {
  assert.ok(readPolicyArgumentCompletions("")?.some((item) => item.value === "shell"));
  assert.ok(
    readPolicyArgumentCompletions("shell ")?.some(
      (item) => item.value === "shell strict",
    ),
  );
  assert.ok(
    readPolicyArgumentCompletions("allow ../shared ")?.some(
      (item) => item.value === "allow ../shared project",
    ),
  );
  assert.equal(readPolicyArgumentCompletions("shell paths project"), null);
});
