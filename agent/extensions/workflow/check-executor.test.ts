/**
 * The single CheckExecutor. Row checks, the final plan gate and
 * `workflow_execution verify` all route through this module, so these tests pin
 * the contract they share:
 *
 *   - a malformed check is refused as `metadata` before any transport runs;
 *   - a workspace alias, a bound root and an unambiguous changed root resolve;
 *     an unknown alias or an ambiguous root set fails closed;
 *   - the configured shell deadline and a per-check timeout both apply, and the
 *     headless transport cannot exceed the hard cap;
 *   - output is bounded identically by both transports;
 *   - a guard/policy refusal is `policy`, a timeout is `timeout` and only those
 *     test/timeout failures are repairable;
 *   - a hung git is bounded and classified `environment`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  MAX_CHECK_OUTPUT_CHARS,
  createCheckExecutor,
  createHeadlessCheckTransport,
  createHostCheckTransport,
  isRepairableFailure,
  looksLikePolicyRefusal,
  runBoundedGitSync,
  type CheckTransport,
  type CheckTransportRequest,
  type CheckTransportResponse,
} from "./check-executor.ts";
import { HARD_MAX_SHELL_TIMEOUT_SECONDS } from "./shell-guard.ts";
import type { WorkspaceSet } from "./orchestrator-workspace-set.ts";

function workspaceSet(): WorkspaceSet {
  return {
    schemaVersion: 1,
    primaryId: "W",
    roots: [
      {
        id: "W",
        key: "git:C:/work/primary",
        root: "C:/work/primary",
        kind: "git",
        displayPath: "C:/work/primary",
        primary: true,
      },
      {
        id: "ERP",
        key: "git:C:/work/erp",
        root: "C:/work/erp",
        kind: "git",
        displayPath: "C:/work/erp",
        primary: false,
      },
    ],
  };
}

interface FakeTransport extends CheckTransport {
  calls: CheckTransportRequest[];
}

function fakeTransport(
  response: CheckTransportResponse | ((request: CheckTransportRequest) => CheckTransportResponse),
  kind: "host" | "headless" = "host",
): FakeTransport {
  const calls: CheckTransportRequest[] = [];
  return {
    kind,
    calls,
    async run(request) {
      calls.push(request);
      return typeof response === "function" ? response(request) : response;
    },
  };
}

test("a malformed command is metadata and never reaches a transport", async () => {
  for (const command of [
    "pnpm dev:preflight`, followed by a smoke test.",
    "Run the tests",
    "pnpm test\nrm -rf /",
    " pnpm test",
    "",
  ]) {
    const transport = fakeTransport({ ok: true, output: "should not run", exitCode: 0 });
    const executor = createCheckExecutor({ transport });
    const result = await executor.execute({ command });
    assert.equal(result.ok, false);
    assert.equal(result.failureClass, "metadata");
    assert.equal(result.repairable, false);
    assert.equal(transport.calls.length, 0, `transport ran for ${JSON.stringify(command)}`);
  }
});

test("a typed check keeps its kind, id and expected exit code", async () => {
  const transport = fakeTransport({ ok: true, output: "ok", exitCode: 3 });
  const executor = createCheckExecutor({ transport });
  const result = await executor.execute({
    id: "check-7",
    command: "node scripts/probe.mjs",
    kind: "gate",
    expectedExitCode: 3,
  });
  assert.equal(result.checkId, "check-7");
  assert.equal(result.kind, "gate");
  assert.equal(result.ok, true);
  assert.equal(result.exitCode, 3);
});

test("an exit code other than the expected one is a test failure", async () => {
  const executor = createCheckExecutor({
    transport: fakeTransport({ ok: false, output: "1 failing test", exitCode: 1 }),
  });
  const result = await executor.execute({ command: "npm test" });
  assert.equal(result.ok, false);
  assert.equal(result.failureClass, "test");
  assert.equal(result.repairable, true);
  assert.match(result.message, /exit code 1 \(expected 0\)/);
});

test("workspace resolution: explicit alias, bound root, one changed root", async () => {
  const set = workspaceSet();
  const seen: Array<string | undefined> = [];
  const transport = fakeTransport((request) => {
    seen.push(request.cwd);
    return { ok: true, output: "", exitCode: 0 };
  });
  const executor = createCheckExecutor({ transport, workspaceSet: () => set });

  const explicit = await executor.execute({ command: "pnpm lint", workspace: "ERP" });
  assert.equal(explicit.workspaceId, "ERP");
  assert.equal(explicit.workspaceRoot, "C:/work/erp");

  const bound = await executor.execute(
    { command: "pnpm lint" },
    { boundRoot: "C:/work/erp" },
  );
  assert.equal(bound.workspaceId, "ERP");
  assert.equal(bound.workspaceRoot, "C:/work/erp");

  const changed = await executor.execute(
    { command: "pnpm lint" },
    { changedRoots: ["C:/work/erp"] },
  );
  assert.equal(changed.workspaceId, "ERP");

  // A single-root set has an unambiguous primary root; a multi-root set does
  // not, so an untagged check fails closed rather than guessing the primary.
  const singleRootSet: WorkspaceSet = {
    ...set,
    roots: set.roots.filter((root) => root.id === "W"),
  };
  const singleRootExecutor = createCheckExecutor({
    transport,
    workspaceSet: () => singleRootSet,
  });
  const primary = await singleRootExecutor.execute({ command: "pnpm lint" });
  assert.equal(primary.workspaceId, "W");

  const untagged = await executor.execute({ command: "pnpm lint" });
  assert.equal(untagged.ok, false);
  assert.equal(untagged.failureClass, "metadata");
  assert.match(untagged.message, /ambiguous check workspace/);
  assert.deepEqual(seen, [
    "C:/work/erp",
    "C:/work/erp",
    "C:/work/erp",
    "C:/work/primary",
  ]);
});

test("an unknown alias or an ambiguous changed-root set fails closed as metadata", async () => {
  const set = workspaceSet();
  const transport = fakeTransport({ ok: true, output: "", exitCode: 0 });
  const executor = createCheckExecutor({ transport, workspaceSet: () => set });

  const unknown = await executor.execute({ command: "pnpm lint", workspace: "NOPE" });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.failureClass, "metadata");
  assert.match(unknown.message, /unknown workspace "NOPE"/);

  const ambiguous = await executor.execute(
    { command: "pnpm lint" },
    { changedRoots: ["C:/work/erp", "C:/work/primary"] },
  );
  assert.equal(ambiguous.ok, false);
  assert.equal(ambiguous.failureClass, "metadata");
  assert.match(ambiguous.message, /ambiguous/);
  assert.equal(transport.calls.length, 0);
});

test("the configured shell maximum feeds the deadline, and a per-check timeout wins", async () => {
  const transport = fakeTransport({ ok: true, output: "", exitCode: 0 });
  const set = workspaceSet();
  const singleRootSet: WorkspaceSet = {
    ...set,
    roots: set.roots.filter((root) => root.primary),
  };
  const executor = createCheckExecutor({
    transport,
    workspaceSet: () => singleRootSet,
    limits: () => ({ maxTimeoutSeconds: 300 }),
  });
  await executor.execute({ command: "pnpm check" });
  assert.equal(transport.calls[0]!.timeoutSeconds, 300);
  assert.equal(transport.calls[0]!.timeoutMs, 300_000);
  assert.equal(transport.calls[0]!.timeoutMessage, "Command timed out after 300 seconds");
  assert.equal(
    transport.calls[0]!.scopedCommand,
    "cd -- 'C:/work/primary' && pnpm check",
  );

  await executor.execute({ command: "pnpm check", timeoutMs: 45_000 });
  assert.equal(transport.calls[1]!.timeoutSeconds, 45);
  assert.equal(transport.calls[1]!.timeoutMs, 45_000);
});

test("a timeout is classified timeout and is repairable", async () => {
  const executor = createCheckExecutor({
    limits: () => ({ maxTimeoutSeconds: 5 }),
    transport: fakeTransport({
      ok: false,
      timedOut: true,
      output: "Command timed out after 5 seconds",
      exitCode: null,
    }),
  });
  const result = await executor.execute({ command: "pnpm test" });
  assert.equal(result.ok, false);
  assert.equal(result.failureClass, "timeout");
  assert.equal(result.repairable, true);
  assert.ok(isRepairableFailure("timeout"));
  assert.ok(isRepairableFailure("test"));
  for (const failureClass of ["metadata", "policy", "environment", "manual", "none"] as const) {
    assert.equal(isRepairableFailure(failureClass), false, failureClass);
  }
});

test("a guarded refusal is policy, never a repairable test failure", async () => {
  const transport = fakeTransport({ ok: true, output: "should not run", exitCode: 0 });
  const executor = createCheckExecutor({
    transport,
    guard: () => ({
      blocked: true,
      reason: "shell is quarantined; refused instead of bypassing the guard",
      failureClass: "policy",
    }),
  });
  const result = await executor.execute({ command: "pnpm test" });
  assert.equal(result.ok, false);
  assert.equal(result.failureClass, "policy");
  assert.equal(result.repairable, false);
  assert.match(result.message, /quarantined/);
  assert.equal(transport.calls.length, 0);
});

test("output is bounded identically regardless of transport", async () => {
  const huge = "x".repeat(MAX_CHECK_OUTPUT_CHARS * 3);
  for (const transport of [
    fakeTransport({ ok: true, output: huge, exitCode: 0 }, "host"),
    fakeTransport({ ok: true, output: huge, exitCode: 0 }, "headless"),
  ]) {
    const executor = createCheckExecutor({ transport });
    const result = await executor.execute({ command: "npm test" });
    assert.equal(result.ok, true);
    assert.equal(result.output.length, MAX_CHECK_OUTPUT_CHARS);
    assert.equal(result.truncated, true);
  }
});

test("a manual check is never executed and cannot auto-accept", async () => {
  const transport = fakeTransport({ ok: true, output: "ran", exitCode: 0 });
  const executor = createCheckExecutor({ transport });
  const result = await executor.execute({ command: "npm run deploy", kind: "manual" });
  assert.equal(result.ok, false);
  assert.equal(result.failureClass, "manual");
  assert.equal(result.repairable, false);
  assert.equal(transport.calls.length, 0);
});

test("diagnostics report but do not stop a gate from deciding the outcome", async () => {
  const executor = createCheckExecutor({
    transport: fakeTransport((request) =>
      request.command.includes("diagnostic")
        ? { ok: false, output: "advisory", exitCode: 1 }
        : { ok: true, output: "ok", exitCode: 0 },
    ),
  });
  const outcome = await executor.executeMany([
    { command: "npm run diagnostic", kind: "diagnostic" },
    { command: "npm test", kind: "gate" },
  ]);
  assert.equal(outcome.ok, true);
  assert.deepEqual(
    outcome.results.map((result) => [result.kind, result.failureClass]),
    [
      ["diagnostic", "test"],
      ["gate", "none"],
    ],
  );

  const failing = createCheckExecutor({
    transport: fakeTransport((request) =>
      request.command.includes("diagnostic")
        ? { ok: false, output: "advisory", exitCode: 1 }
        : { ok: false, output: "1 failing", exitCode: 1 },
    ),
  });
  const refused = await failing.executeMany([
    { command: "npm run diagnostic", kind: "diagnostic" },
    { command: "npm test", kind: "gate" },
  ]);
  assert.equal(refused.ok, false);
  assert.equal(refused.results.length, 2);
  assert.equal(refused.results[1]!.failureClass, "test");
});

test("the host transport scopes the command, passes seconds and parses nested text", async () => {
  const calls: Array<{ name: string; params: Record<string, unknown> }> = [];
  const transport = createHostCheckTransport({
    executeTool: async (name, params) => {
      calls.push({ name, params });
      return { isError: false, content: [{ type: "text", text: "all good" }] };
    },
  });
  const result = await transport.run({
    command: "pnpm test",
    scopedCommand: "cd -- 'C:/work/erp' && pnpm test",
    cwd: "C:/work/erp",
    timeoutSeconds: 300,
    timeoutMs: 300_000,
    timeoutMessage: "Command timed out after 300 seconds",
  });
  assert.equal(result.ok, true);
  assert.equal(result.output, "all good");
  assert.equal(calls[0]!.name, "bash");
  assert.deepEqual(calls[0]!.params, {
    command: "cd -- 'C:/work/erp' && pnpm test",
    timeout: 300,
  });
});

test("the host transport reports a policy refusal as policy, not a failed test", async () => {
  const transport = createHostCheckTransport({
    executeTool: async () => ({
      isError: true,
      content: [{ type: "text", text: "tool bash is not permitted in plan mode" }],
    }),
  });
  const response = await transport.run({
    command: "pnpm test",
    scopedCommand: "pnpm test",
    timeoutSeconds: 120,
    timeoutMs: 120_000,
    timeoutMessage: "Command timed out after 120 seconds",
  });
  assert.equal(response.ok, false);
  assert.equal(response.refused, "policy");

  const thrown = createHostCheckTransport({
    executeTool: async () => {
      throw new Error("role policy refused this command");
    },
  });
  const refused = await thrown.run({
    command: "pnpm test",
    scopedCommand: "pnpm test",
    timeoutSeconds: 120,
    timeoutMs: 120_000,
    timeoutMessage: "Command timed out after 120 seconds",
  });
  assert.equal(refused.refused, "policy");
  assert.equal(looksLikePolicyRefusal("permission denied by policy"), true);
  assert.equal(looksLikePolicyRefusal("3 tests failed"), false);
});

test("the headless transport cannot bypass validation or the hard deadline cap", async () => {
  const calls: Array<{ command: string; timeout: number }> = [];
  const transport = createHeadlessCheckTransport({
    spawn: (command, options) => {
      calls.push({ command, timeout: options.timeout });
      return { status: 0, stdout: "ok", stderr: "" };
    },
  });

  const malformed = await transport.run({
    command: "pnpm dev:preflight`, followed by a smoke test",
    scopedCommand: "pnpm dev:preflight`, followed by a smoke test",
    timeoutSeconds: 120,
    timeoutMs: 120_000,
    timeoutMessage: "Command timed out after 120 seconds",
  });
  assert.equal(malformed.refused, "metadata");
  assert.equal(calls.length, 0);

  await transport.run({
    command: "pnpm check",
    scopedCommand: "pnpm check",
    timeoutSeconds: HARD_MAX_SHELL_TIMEOUT_SECONDS + 10_000,
    timeoutMs: (HARD_MAX_SHELL_TIMEOUT_SECONDS + 10_000) * 1_000,
    timeoutMessage: "Command timed out",
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.timeout, HARD_MAX_SHELL_TIMEOUT_SECONDS * 1_000);
});

test("the headless transport bounds output and classifies a timeout", async () => {
  const transport = createHeadlessCheckTransport({
    spawn: () => ({
      status: null,
      stdout: "y".repeat(MAX_CHECK_OUTPUT_CHARS * 2),
      stderr: "",
      error: { code: "ETIMEDOUT", message: "timed out" },
      signal: "SIGKILL",
    }),
  });
  const response = await transport.run({
    command: "pnpm check",
    scopedCommand: "pnpm check",
    timeoutSeconds: 30,
    timeoutMs: 30_000,
    timeoutMessage: "Command timed out after 30 seconds",
  });
  assert.equal(response.ok, false);
  assert.equal(response.timedOut, true);
  assert.ok((response.output ?? "").length <= MAX_CHECK_OUTPUT_CHARS);
  assert.match(response.output ?? "", /timed out after 30 seconds/);

  const executor = createCheckExecutor({
    transport: fakeTransport({ ok: false, timedOut: true, output: "", exitCode: null }),
  });
  const result = await executor.execute({ command: "pnpm check" });
  assert.equal(result.failureClass, "timeout");
});

test("a headless spawn failure is environment, not a repairable test failure", async () => {
  const transport = createHeadlessCheckTransport({
    spawn: () => ({
      status: null,
      stdout: "",
      stderr: "",
      error: { code: "ENOENT", message: "spawn pnpm ENOENT" },
    }),
  });
  const executor = createCheckExecutor({ transport });
  const result = await executor.execute({ command: "pnpm test" });
  assert.equal(result.ok, false);
  assert.equal(result.failureClass, "environment");
  assert.equal(result.repairable, false);
});

test("a hung git is bounded and classified environment", () => {
  const calls: Array<Record<string, unknown>> = [];
  const timedOut = runBoundedGitSync(["status", "--porcelain"], "C:/work", {
    timeoutMs: 1_500,
    spawnSync: ((_command: string, _args: readonly string[], options: Record<string, unknown>) => {
      calls.push(options);
      return {
        status: null,
        stdout: "z".repeat(10_000),
        stderr: "",
        error: { code: "ETIMEDOUT", message: "spawnSync git ETIMEDOUT" },
        signal: "SIGKILL",
      };
    }) as unknown as typeof import("node:child_process").spawnSync,
  });
  assert.equal(timedOut.ok, false);
  assert.equal(timedOut.timedOut, true);
  assert.equal(timedOut.failureClass, "environment");
  assert.equal(timedOut.stderr.includes("timed out after 1500ms"), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.timeout, 1_500);
  assert.equal(calls[0]!.killSignal, "SIGKILL");
  assert.ok(timedOut.stdout.length <= 64_000);

  const ok = runBoundedGitSync(["rev-parse", "HEAD"], "C:/work", {
    spawnSync: (() => ({ status: 0, stdout: "abc123\n", stderr: "" })) as unknown as typeof import("node:child_process").spawnSync,
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.failureClass, "none");
  assert.equal(ok.stdout, "abc123\n");
});

test("executeMany stops on the first gate failure and keeps evidence in order", async () => {
  const transport = fakeTransport((request) =>
    request.command === "npm run one"
      ? { ok: false, output: "boom", exitCode: 1 }
      : { ok: true, output: "fine", exitCode: 0 },
  );
  const executor = createCheckExecutor({ transport });
  const outcome = await executor.executeMany([
    "npm run one",
    "npm run two",
  ]);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.results.length, 1);
  assert.equal(outcome.results[0]!.checkId, "check-1");
  assert.equal(outcome.results[0]!.failureClass, "test");
  assert.equal(transport.calls.length, 1);
});
