/**
 * Launcher tests (step 25): visible interactive Pi in a separate window, resume
 * args only, safe quoting, unsupported launchers fail with guidance, and a
 * launcher success is never readiness or a task start.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  LINUX_TERMINALS,
  appleScriptQuote,
  createTerminalLauncher,
  interpretLauncherExit,
  piArgs,
  shellQuote,
  type LaunchRequest,
  type LauncherPort,
  type PiCli,
  type WorkerResumeSpec,
} from "./orchestrator-launcher.ts";

const pi: PiCli = {
  command: "C:/Program Files/Pi/pi.exe",
  baseArgs: ["--agent-dir", "C:/profile"],
  resourceArgs: (resources) => [
    ...(resources.extensions ?? []).flatMap((path) => ["--extension", path]),
    ...(resources.skills ?? []),
  ],
};

const spec: WorkerResumeSpec = {
  workerId: "worker-run-1-task-1-attempt-1",
  sessionName: "Task 1 — ünïcode \"quoted\"",
  sessionFile: "C:/sessions/worker 1.jsonl",
  cwd: "C:/work/My Project/ü",
  agentDir: "C:/profile",
  resources: { extensions: ["C:/ext/my ext.ts"], skills: ["C:/skills/a b"] },
  env: { PI_DESKTOP_PROFILE: "builder", OPENAI_API_KEY: "must-not-copy" },
};

function port(): LauncherPort & { requests: LaunchRequest[] } {
  const requests: LaunchRequest[] = [];
  return {
    requests,
    async launch(request) {
      requests.push(request);
      return { windowRef: "window-1" };
    },
    async focus() {
      return true;
    },
    async close() {
      return true;
    },
  };
}

function launcher(over: Partial<Parameters<typeof createTerminalLauncher>[0]> = {}) {
  const p = port();
  return {
    p,
    value: createTerminalLauncher({
      platform: "win32",
      port: p,
      resolvePi: async () => pi,
      ...over,
    }),
  };
}

test("Windows Terminal resumes the worker in a visible tab with argv-safe quoting", async () => {
  const { p, value } = launcher();
  const result = await value.launch(spec);
  assert.equal(result.ok, true, result.ok ? "" : result.error);
  const request = p.requests[0]!;
  assert.equal(request.executable, "wt.exe");
  assert.deepEqual(request.argv.slice(0, 6), ["-w", "0", "new-tab", "--title", spec.sessionName, "-d"]);
  assert.equal(request.argv[6], spec.cwd);
  assert.equal(request.argv[7], "--");
  assert.equal(request.argv[8], pi.command);
  assert.deepEqual(request.argv.slice(9), [
    "--agent-dir",
    "C:/profile",
    "--session",
    spec.sessionFile,
    "--extension",
    "C:/ext/my ext.ts",
    "C:/skills/a b",
  ]);
  assert.equal(request.argv.join(" ").includes("assignment"), false);
  assert.equal(request.argv.some((arg) => ["-p", "--no-session", "--no-extensions"].includes(arg)), false);
  // Allowlisted env only; the API key is never copied.
  assert.deepEqual(request.env, {
    PI_CODING_AGENT_DIR: "C:/profile",
    PI_DESKTOP_PROFILE: "builder",
  });
  assert.equal((result as any).readiness, "pending");
  assert.equal((result as any).taskStarted, false);
});

test("macOS Terminal quotes the shell command and Unicode safely", async () => {
  const { p, value } = launcher({ platform: "darwin" });
  const result = await value.launch(spec);
  assert.equal(result.ok, true);
  const request = p.requests[0]!;
  assert.equal(request.executable, "osascript");
  const script = request.argv[1]!;
  assert.match(script, /tell application "Terminal" to do script /);
  assert.match(script, /--session/);
  // Unicode cwd/paths survive; the title is not part of the shell command.
  assert.match(script, /ü/);
  assert.match(script, /worker 1\.jsonl/);
  assert.equal(script.includes("assignment"), false);
});

test("Linux terminal and tmux adapters keep cwd/title as argv values", async () => {
  const gnome = launcher({ platform: "linux", linux: LINUX_TERMINALS[0]! });
  await gnome.value.launch(spec);
  assert.equal(gnome.p.requests[0]!.executable, "gnome-terminal");
  assert.deepEqual(gnome.p.requests[0]!.argv.slice(0, 6), [
    "--title",
    spec.sessionName,
    "--working-directory",
    spec.cwd,
    "--",
    pi.command,
  ]);

  const tmux = launcher({ platform: "linux", useTmux: true });
  await tmux.value.launch(spec);
  assert.deepEqual(tmux.p.requests[0]!.argv.slice(0, 8), [
    "new-session",
    "-d",
    "-s",
    spec.workerId,
    "-c",
    spec.cwd,
    "--",
    pi.command,
  ]);
});

test("missing CLI or launcher fails with guidance and never creates a hidden worker", async () => {
  const noPi = launcher({ resolvePi: async () => null });
  const result = await noPi.value.launch(spec);
  assert.equal(result.ok, false);
  assert.equal((result as any).code, "unsupported");
  assert.match((result as any).guidance, /never falls back to a hidden\/headless worker/);
  assert.equal(noPi.p.requests.length, 0);

  const missing = launcher({
    port: {
      async launch() {
        throw new Error("spawn wt.exe ENOENT");
      },
      async focus() {
        return false;
      },
      async close() {
        return false;
      },
    },
  });
  const missingResult = await missing.value.launch(spec);
  assert.equal((missingResult as any).code, "unsupported");
  assert.match((missingResult as any).guidance, /Install it/);
});

test("cancellation stops before or during launch; exit is not readiness", async () => {
  const controller = new AbortController();
  controller.abort();
  const { p, value } = launcher();
  const cancelled = await value.launch(spec, { signal: controller.signal });
  assert.equal((cancelled as any).code, "cancelled");
  assert.equal(p.requests.length, 0);

  const mid = launcher({
    port: {
      async launch() {
        throw new Error("cancelled");
      },
      async focus() {
        return false;
      },
      async close() {
        return false;
      },
    },
  });
  const controller2 = new AbortController();
  const pending = mid.value.launch(spec, { signal: controller2.signal });
  controller2.abort();
  assert.equal((await pending as any).code, "cancelled");

  const exit = interpretLauncherExit();
  assert.deepEqual(
    { childExited: exit.childExited, readinessChanged: exit.readinessChanged, taskStarted: exit.taskStarted },
    { childExited: false, readinessChanged: false, taskStarted: false },
  );
});

test("forbidden headless flags and unsafe ids are refused", async () => {
  const { p, value } = launcher({ resolvePi: async () => ({ ...pi, baseArgs: ["-p"] }) });
  const result = await value.launch(spec);
  assert.equal((result as any).code, "invalid");
  assert.match((result as any).error, /must not pass -p/);
  assert.equal(p.requests.length, 0);

  const badId = await (launcher().value.launch({ ...spec, workerId: "../evil" }));
  assert.equal((badId as any).code, "invalid");
});

test("quoting helpers round-trip spaces, quotes and Unicode", () => {
  assert.equal(shellQuote("a b"), "'a b'");
  assert.equal(shellQuote("it's"), "'it'\\''s'");
  assert.equal(appleScriptQuote('a"b\\c'), '"a\\"b\\\\c"');
  assert.deepEqual(piArgs(spec, pi).slice(0, 2), ["--agent-dir", "C:/profile"]);
});
