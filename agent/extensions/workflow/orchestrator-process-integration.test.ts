/**
 * Provider-free process/integration coverage (step 45).
 *
 * A real child process plays a normal Pi session: it stays idle on resume,
 * starts exactly once after an authorized wake, and can crash before/after the
 * start acknowledgement. The journal is a real file on disk, so torn writes,
 * intent/ack reconciliation and restart boundaries are exercised end to end.
 *
 * Also covers the platform edges the plan names: stale PID/lease, missing
 * window, non-Git dirty baselines, symlink/cwd aliases and Windows quoting.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createRunJournal,
  replayJournal,
  type JournalIo,
  type JournalState,
} from "./orchestrator-store.ts";
import {
  planRecovery,
  type ProcessIdentity,
  type RecoveryInput,
} from "./orchestrator-recovery.ts";
import {
  beginWorkerStart,
  deliverWake,
  reconcileWorker,
  recordStartAck,
  type WorkerLaunchSpec,
  type WorkerState,
} from "./orchestrator-worker.ts";
import {
  captureBaseline,
  compareBaseline,
  createWorkspaceLeases,
  resolveWorkspaceIdentity,
  type BaselinePort,
  type WorkspaceResolver,
} from "./orchestrator-workspace.ts";
import { handleWindowClosed, createChildLifecycle, markChildRunning, canSchedule } from "./orchestrator-lifecycle.ts";
import { shellQuote, createTerminalLauncher } from "./orchestrator-launcher.ts";
import { buildRepairDecision } from "./orchestrator-repair.ts";

// ── Real filesystem journal adapter ──────────────────────────────────

function nodeIo(): JournalIo {
  return {
    async read(path) {
      try {
        return readFileSync(path, "utf8");
      } catch {
        return null;
      }
    },
    async writeAtomic(path, data) {
      writeFileSync(path, data, "utf8");
    },
    async append(path, data) {
      appendFileSync(path, data, "utf8");
    },
    async list(dir) {
      try {
        return readdirSync(dir);
      } catch {
        return [];
      }
    },
    async mkdir(dir) {
      mkdirSync(dir, { recursive: true });
    },
    async remove(path) {
      rmSync(path, { force: true });
    },
    async acquireLock(path) {
      try {
        writeFileSync(path, "", { flag: "wx" });
        return true;
      } catch {
        return false;
      }
    },
    async releaseLock(path) {
      rmSync(path, { force: true });
    },
  };
}

function tempDir(name: string): string {
  return mkdtempSync(join(tmpdir(), `pi-orch-${name}-`));
}

// ── Fake interactive child ───────────────────────────────────────────

const AGENT_SCRIPT = `
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
const seen = new Set();
const emit = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
process.stdout.write(JSON.stringify({ event: "idle" }) + "\\n");
rl.on("line", (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.cmd !== "wake") {
    if (message.cmd === "stop") process.exit(0);
    return;
  }
  if (seen.has(message.taskStartId)) {
    emit({ event: "duplicate-ignored", taskStartId: message.taskStartId });
    return;
  }
  seen.add(message.taskStartId);
  if (message.crash === "before-ack") {
    emit({ event: "turn-started", taskStartId: message.taskStartId });
    process.exit(9);
  }
  emit({ event: "start-ack", taskStartId: message.taskStartId });
  if (message.crash === "after-ack") {
    setTimeout(() => process.exit(9), 5);
  }
});
`;

interface FakeAgent {
  child: ChildProcessWithoutNullStreams;
  lines: Array<Record<string, unknown>>;
  waitFor(event: string, timeoutMs?: number): Promise<Record<string, unknown>>;
  send(message: Record<string, unknown>): void;
  exited: Promise<number | null>;
  stop(): void;
}

function startAgent(): FakeAgent {
  const child = spawn(process.execPath, ["-e", AGENT_SCRIPT], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const lines: Array<Record<string, unknown>> = [];
  let buffer = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    const parts = buffer.split("\n");
    buffer = parts.pop() ?? "";
    for (const part of parts) {
      if (!part.trim()) continue;
      try {
        lines.push(JSON.parse(part) as Record<string, unknown>);
      } catch {
        // A fake agent can print diagnostics; only JSON lines matter.
      }
    }
  });
  const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
  return {
    child,
    lines,
    async waitFor(event, timeoutMs = 5_000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const found = lines.find((line) => line.event === event);
        if (found) return found;
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${event}`);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    },
    send(message) {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    },
    exited,
    stop() {
      if (!child.killed) child.kill();
    },
  };
}

function spec(dir: string): WorkerLaunchSpec {
  return {
    schemaVersion: 1,
    workerId: "worker-1",
    sessionName: "Task t1",
    sessionFile: join(dir, "worker.jsonl"),
    sessionId: "session-s1",
    runId: "run-1",
    taskId: "task-t1",
    attemptId: "attempt-a1",
    parentSessionRef: "parent-session",
    packetRef: "artifact-packet",
    roadmap: { path: "roadmap.md", digest: "roadmap-digest", revision: 1 },
    cwd: dir,
    trust: "trust",
    model: { provider: "openai", id: "fake" },
    resources: {},
    kickoff: { customType: "workflow-kickoff", content: "do the task" },
    wake: { customType: "workflow-start", content: "start-1", triggerTurn: true },
    taskStartId: "start-1",
    assignmentId: "assignment-1",
    createdAt: 1,
  };
}

function readyWorker(input: WorkerLaunchSpec): WorkerState {
  return {
    schemaVersion: 1,
    workerId: input.workerId,
    sessionFile: input.sessionFile,
    phase: "ready",
    launchedAt: 1,
    readyAt: 2,
    leaseGeneration: 1,
  };
}

function currentIdentity(): ProcessIdentity {
  return { instanceId: "proc-current", startedAt: 1, heartbeatAt: 100 };
}

async function recoveryInput(dir: string, journal: JournalState): Promise<RecoveryInput> {
  return {
    journal,
    snapshot: {
      runId: "run-1",
      revision: journal.revision,
      phase: "building",
      acceptedTaskIds: [],
    },
    branch: { id: "branch-1", kind: "active", activeRunId: "run-1" },
    sessions: [
      {
        sessionRef: "session-s1",
        sessionFile: join(dir, "worker.jsonl"),
        exists: true,
        ownerInstance: "proc-current",
        heartbeatAt: 100,
      },
    ],
    parent: { identity: currentIdentity(), alive: true },
    current: currentIdentity(),
    staleMs: 1_000,
    now: 200,
  };
}

test("a persisted resume stays idle until an authorized wake starts exactly once", { timeout: 20_000 }, async () => {
  const dir = tempDir("wake");
  const agent = startAgent();
  try {
    await agent.waitFor("idle");
    // Normal resume restores context; it must not submit the stored assignment.
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(agent.lines.some((line) => line.event === "start-ack"), false);

    const journal = createRunJournal({ dir, runId: "run-1", io: nodeIo() });
    const launch = spec(dir);
    const begun = beginWorkerStart(launch, readyWorker(launch), {
      leaseGeneration: 1,
      currentLeaseGeneration: 1,
      now: 3,
    });
    assert.equal(begun.ok, true);
    const intent = (begun as any).value.intent;
    const intentEntry = await journal.append({
      eventId: "event-intent",
      type: "task.start.intent",
      at: 4,
      payload: { taskId: "task-t1", attemptId: "attempt-a1", sessionId: "session-s1", taskStartId: intent.taskStartId },
    });
    assert.equal(intentEntry.ok, true);

    const sdk = {
      createSession: async () => ({ sessionId: "session-s1", sessionFile: launch.sessionFile }),
      exists: async () => true,
      appendManagedEntry: async () => {},
      hasManagedEntry: async () => false,
      sendWake: async (_file: string, wake: { content: string; triggerTurn: true }) => {
        agent.send({ cmd: "wake", taskStartId: wake.content });
      },
    };
    const delivered = await deliverWake(launch, (begun as any).value.state, sdk, {
      intentPersisted: true,
      now: 5,
    });
    assert.equal(delivered.ok, true);
    const ack = await agent.waitFor("start-ack");
    assert.equal(ack.taskStartId, "start-1");

    const acknowledged = recordStartAck({ taskStartId: "start-1" }, (delivered as any).value, { taskStartId: "start-1", now: 6 });
    assert.equal(acknowledged.ok, true);
    assert.equal((acknowledged as any).value.phase, "running");

    const duplicate = await deliverWake(launch, (delivered as any).value, sdk, {
      intentPersisted: true,
      now: 7,
    });
    assert.equal(duplicate.ok, false);
    assert.equal((duplicate as any).code, "duplicate");

    agent.send({ cmd: "wake", taskStartId: "start-1" });
    const ignored = await agent.waitFor("duplicate-ignored");
    assert.equal(ignored.taskStartId, "start-1");
    assert.equal(agent.lines.filter((line) => line.event === "start-ack").length, 1);
  } finally {
    agent.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a crash before the start ack is uncertain and is never blind-retried", { timeout: 20_000 }, async () => {
  const dir = tempDir("crash-before");
  const agent = startAgent();
  try {
    await agent.waitFor("idle");
    const journal = createRunJournal({ dir, runId: "run-1", io: nodeIo() });
    const intentEntry = await journal.append({
      eventId: "event-intent",
      type: "task.start.intent",
      at: 4,
      payload: { taskId: "task-t1", attemptId: "attempt-a1", sessionId: "session-s1", taskStartId: "start-1" },
    });
    assert.equal(intentEntry.ok, true);
    agent.send({ cmd: "wake", taskStartId: "start-1", crash: "before-ack" });
    await agent.waitFor("turn-started");
    assert.equal(await agent.exited, 9);
    assert.equal(agent.lines.some((line) => line.event === "start-ack"), false);

    writeFileSync(join(dir, "worker.jsonl"), "{}", "utf8");
    const loaded = await journal.load();
    assert.equal(loaded.ok, true);
    const plan = planRecovery(await recoveryInput(dir, (loaded as any).value));
    assert.equal(plan.action, "reconcile_start");
    assert.match(plan.reason, /uncertain or inconsistent/);
    assert.match(plan.kickoff[0]!.instruction, /do not resend/);

    const reconciliation = await reconcileWorker({
      state: { ...readyWorker(spec(dir)), phase: "starting", startIntentAt: 4, wakeSentAt: 5 },
      exists: async () => true,
    });
    assert.equal(reconciliation.action, "needs_reconciliation");
  } finally {
    agent.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a crash after the ack resumes from the durable turn start", { timeout: 20_000 }, async () => {
  const dir = tempDir("crash-after");
  const agent = startAgent();
  try {
    await agent.waitFor("idle");
    const journal = createRunJournal({ dir, runId: "run-1", io: nodeIo() });
    await journal.append({
      eventId: "event-intent",
      type: "task.start.intent",
      at: 4,
      payload: { taskId: "task-t1", attemptId: "attempt-a1", sessionId: "session-s1", taskStartId: "start-1" },
    });
    agent.send({ cmd: "wake", taskStartId: "start-1", crash: "after-ack" });
    await agent.waitFor("start-ack");
    assert.equal(await agent.exited, 9);
    await journal.append({
      eventId: "event-ack",
      type: "task.start.ack",
      at: 5,
      payload: { taskId: "task-t1", attemptId: "attempt-a1", sessionId: "session-s1", taskStartId: "start-1" },
    });
    await journal.append({
      eventId: "event-session",
      type: "session.ref",
      at: 6,
      payload: { branchId: "branch-1", sessionRef: "session-s1", taskId: "task-t1", attemptId: "attempt-a1" },
    });
    const loaded = await journal.load();
    const plan = planRecovery(await recoveryInput(dir, (loaded as any).value));
    assert.equal(plan.action, "resume");
    assert.equal(plan.resumeAllowed, true);
    assert.equal(plan.kickoff[0]!.status, "acknowledged");
  } finally {
    agent.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a torn journal tail stops replay and requires recovery", async () => {
  const dir = tempDir("torn");
  try {
    const journal = createRunJournal({ dir, runId: "run-1", io: nodeIo() });
    await journal.append({ eventId: "event-1", type: "run.created", at: 1, payload: { roadmapRevision: 1 } });
    await journal.append({ eventId: "event-2", type: "plan.approved", at: 2, payload: { planRevision: 1 } });
    appendFileSync(join(dir, "journal.ndjson"), "{not-json\n", "utf8");
    const loaded = await journal.load();
    assert.equal(loaded.ok, true);
    const state = (loaded as any).value as JournalState;
    assert.equal(state.events.length, 2);
    assert.equal(state.truncated, 1);

    const plan = planRecovery(await recoveryInput(dir, state));
    assert.equal(plan.action, "pause");
    assert.match(plan.reason, /unreadable\/torn/);

    const recovered = await journal.recover();
    assert.equal(recovered.ok, true);
    assert.equal((recovered as any).value.truncated, 0);
    const reread = replayJournal("run-1", readFileSync(join(dir, "journal.ndjson"), "utf8"));
    assert.equal(reread.ok, true);
    assert.equal((reread as any).value.state.events.length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a closed child window is interrupted with edits preserved and no scheduler", () => {
  const lifecycle = markChildRunning(
    createChildLifecycle({
      runId: "run-1",
      taskId: "task-t1",
      attemptId: "attempt-a1",
      sessionId: "session-s1",
      sessionRef: "window-1",
      leaseGeneration: 1,
    }),
  );
  const closed = handleWindowClosed(lifecycle, {
    parentTabId: "tab-parent",
    sessionFile: "worker.jsonl",
    title: "Task t1",
    now: 10,
  });
  assert.equal(closed.ok, true);
  assert.equal((closed as any).value.interrupted, true);
  assert.equal((closed as any).value.state.editsPreserved, true);
  assert.equal(canSchedule((closed as any).value.state), false);
});

test("stale lease reclaim and workspace aliases behave across Windows paths", async () => {
  let now = 1_000;
  const leases = createWorkspaceLeases({ ttlMs: 10, now: () => now });
  const first = leases.acquire({
    workspaceKey: "git:c:/repo",
    runId: "run-1",
    taskId: "task-t1",
    attemptId: "attempt-a1",
    sessionId: "session-s1",
    generation: 1,
  });
  assert.equal(first.ok, true);
  now += 20;
  const expired = leases.acquire({
    workspaceKey: "git:c:/repo",
    runId: "run-1",
    taskId: "task-t2",
    attemptId: "attempt-a2",
    sessionId: "session-s2",
    generation: 2,
  });
  assert.equal(expired.ok, false);
  assert.equal((expired as any).code, "expired");

  const reclaimed = leases.reclaim({
    workspaceKey: "git:c:/repo",
    grant: {
      workspaceKey: "git:c:/repo",
      runId: "run-1",
      taskId: "task-t2",
      attemptId: "attempt-a2",
      sessionId: "session-s2",
      generation: 2,
    },
    confirmation: "reclaim-stale",
  });
  assert.equal(reclaimed.ok, true);
  assert.equal(leases.isWriter((first as any).grant), false);
  assert.equal(leases.isWriter((reclaimed as any).grant), true);

  const resolver: WorkspaceResolver = {
    async realpath(path) {
      return path === "C:\\Repo\\Alias" ? "C:\\Repo" : path;
    },
    async gitTopLevel(path) {
      return path.toLowerCase().includes("repo") ? "C:\\Repo" : null;
    },
  };
  const alias = await resolveWorkspaceIdentity({ cwd: "C:\\Repo\\Alias", resolver });
  const plain = await resolveWorkspaceIdentity({
    cwd: "C:\\Plain Dir",
    resolver: { realpath: async () => "C:\\Plain Dir", gitTopLevel: async () => null },
  });
  assert.equal(alias.ok, true);
  assert.equal((alias as any).value.key, "git:c:/repo");
  assert.equal((alias as any).value.root, "c:/repo");
  assert.equal((plain as any).value.kind, "plain");
  assert.equal(shellQuote("C:\\A B\\it's"), "'C:\\A B\\it'\\''s'");
});

test("non-Git dirty baselines compare and preserve user work", async () => {
  const root = "C:\\Plain";
  const port: BaselinePort = {
    async gitStatus() {
      return null;
    },
    async listFiles() {
      return {
        files: [
          { path: "keep.ts", size: 10 },
          { path: "user.txt", size: 3 },
        ],
        truncated: false,
      };
    },
  };
  const workspace = { key: "plain:c:/plain", root, kind: "plain" as const, displayPath: root };
  const baseline = await captureBaseline({ workspace, port, now: 1 });
  assert.equal(baseline.ok, true);
  const changedPort: BaselinePort = {
    gitStatus: async () => null,
    listFiles: async () => ({
      files: [
        { path: "keep.ts", size: 11 },
        { path: "user.txt", size: 3 },
        { path: "new.ts", size: 1 },
      ],
      truncated: false,
    }),
  };
  const current = await captureBaseline({ workspace, port: changedPort, now: 2 });
  const comparison = compareBaseline((baseline as any).value, (current as any).value);
  assert.equal(comparison.unchanged, false);
  assert.equal(comparison.externalChanges.includes("new.ts"), true);
  assert.equal(comparison.requiresRevalidation, true);
});

test("partial effects are called out so a repair cannot replay them", () => {
  const because = buildRepairDecision({
    runId: "run-1",
    taskId: "task-t1",
    attemptId: "attempt-a1",
    candidateId: "candidate-c1",
    category: "verification",
    objective: "migrate",
    failedCriteria: [{ roadmapStepId: "step-r1", status: "unmet" }],
    failedChecks: [{ name: "tests", status: "failed", evidence: "exit 1" }],
    changedFiles: ["migrations/001.sql"],
    nonGoals: [],
    child: { phase: "fenced", warm: true, leaseGeneration: 1, currentLeaseGeneration: 1 },
    counters: { repairRounds: 0, noProgress: 0, rollovers: 0, launchFailures: 0 },
    now: 10,
  });
  assert.equal(because.ok, true);
  assert.equal((because as any).action, "same_child");
  assert.equal((because as any).directive.doNotRepeatUnchangedEffects, true);
  assert.match((because as any).directive.guidance, /Do not repeat unchanged side effects/);
});

test("Windows Terminal argv keeps paths as arguments, not shell text", async () => {
  const launched: Array<Record<string, unknown>> = [];
  const launcher = createTerminalLauncher({
    platform: "win32",
    resolvePi: async () => ({ command: "C:\\Program Files\\Pi\\pi.cmd", baseArgs: [] }),
    port: {
      async launch(request) {
        launched.push(request as any);
        return { ok: true, windowRef: "window-1" };
      },
      async focus() {
        return true;
      },
      async close() {
        return true;
      },
    },
  });
  const outcome = await launcher.launch({
    workerId: "worker-1",
    sessionFile: "C:\\Users\\A B\\session.jsonl",
    sessionName: "Task t1",
    cwd: "C:\\Users\\A B\\repo",
    env: {},
  });
  assert.equal(outcome.ok, true);
  const request = launched[0] as any;
  assert.equal(request.executable, "wt.exe");
  assert.equal(request.argv.includes("C:\\Users\\A B\\repo"), true);
  assert.equal(request.argv.includes("--session"), true);
  assert.equal(request.argv.some((arg: string) => arg.includes("do the task")), false);
});
