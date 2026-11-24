/**
 * Standalone recovery script — temp-run integration.
 *
 * The script is the out-of-session recovery path for a frozen run whose
 * `planChecks` are malformed. These tests drive the real process against a
 * real Node journal and pin the contract:
 *
 *   - dry-run validates and writes nothing;
 *   - apply refuses without `--yes`, a stale `--expect-seq` or a mismatched
 *     `--expect-accepted`;
 *   - apply appends exactly one `run.control` amendment (seq + 1), keeps the
 *     checksum chain and snapshot cache valid and preserves accepted rows and
 *     task states;
 *   - a rerun of the same manifest is a no-op;
 *   - `--status` / `--json` report the run without touching it.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createNodeJournalIo } from "./orchestrator-adapters.ts";
import {
  applyRunEvent,
  createRunState,
  type RunEvent,
  type RunState,
} from "./orchestrator-state.ts";
import { createRunJournal, replayJournal } from "./orchestrator-store.ts";
import { createFrozenTodosFromSteps, type FrozenTodoSnapshot } from "./todo-snapshot.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, "scripts", "repair-orchestrator-checks.mjs");

const MALFORMED = [
  "pnpm typecheck`, followed by a controlled smoke test.",
  "pnpm lint` and `pnpm format:check`, plus prose that is not a command.",
];

const PROPOSED = [
  "pnpm typecheck",
  "pnpm lint",
  "pnpm format:check",
];

const JOURNAL_TYPE = {
  "run.transition": "run.transition",
  "task.start": "task.started",
  "task.report": "task.reported",
  "task.verify": "task.verified",
  "task.accept": "task.accepted",
  "task.needsFix": "task.needs_fix",
  "task.block": "task.blocked",
  "task.retry": "task.retried",
} as const;

interface BuiltRun {
  root: string;
  runDir: string;
  runId: string;
  manifestPath: string;
  seq: number;
}

function snapshotWithMalformedChecks(): FrozenTodoSnapshot {
  const frozen = createFrozenTodosFromSteps({
    title: "Repair script run",
    steps: ["First row", "Second row", "Third row"],
    mode: "orchestrator",
  });
  assert.equal(frozen.ok, true);
  if (!frozen.ok) throw new Error("unreachable");
  return { ...frozen.snapshot, planChecks: [...MALFORMED] };
}

async function buildRun(): Promise<BuiltRun> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rv-repair-script-"));
  const runId = "run-test-repair-script";
  const runDir = path.join(root, runId);
  const snapshot = snapshotWithMalformedChecks();
  const io = createNodeJournalIo();
  const journal = createRunJournal({ dir: runDir, runId, io });
  const created = createRunState({ runId, todos: snapshot, now: 100 });
  assert.equal(created.ok, true);
  if (!created.ok) throw new Error("unreachable");
  let state: RunState = created.state;
  let tick = 100;

  const createdEvent = await journal.append({
    type: "run.created",
    eventId: `created-${runId}`,
    at: tick,
    payload: {
      sourcePath: path.join(root, "plan.md"),
      digest: snapshot.source.digest,
      title: snapshot.source.title,
      mode: snapshot.mode,
      plan: null,
      rowCount: snapshot.rows.length,
    },
  });
  assert.equal(createdEvent.ok, true, createdEvent.ok ? "" : createdEvent.error);

  const frozenEvent = await journal.append({
    type: "todos.frozen",
    eventId: `frozen-${runId}`,
    at: (tick += 1),
    payload: {
      executionId: snapshot.executionId,
      digest: snapshot.source.digest,
      snapshot,
    },
  });
  assert.equal(frozenEvent.ok, true, frozenEvent.ok ? "" : frozenEvent.error);

  const step = async (event: Record<string, unknown>): Promise<void> => {
    tick += 1;
    const payload = { ...event, runId, now: tick };
    const applied = applyRunEvent(state, {
      ...(payload as unknown as RunEvent),
      expectedRevision: state.revision,
    });
    assert.equal(applied.ok, true, applied.ok ? "" : applied.error);
    if (!applied.ok) return;
    const type = JOURNAL_TYPE[event.type as keyof typeof JOURNAL_TYPE];
    const appended = await journal.append({
      type,
      eventId: `${String(event.type)}-${tick}`,
      at: tick,
      payload,
    });
    assert.equal(appended.ok, true, appended.ok ? "" : appended.error);
    state = applied.state;
  };

  await step({ type: "run.transition", to: "running" });
  for (const ref of ["1", "2"]) {
    const taskId = `task-${ref}`;
    await step({ type: "task.start", taskId, attemptId: `attempt-${ref}`, sessionId: `session-${ref}` });
    await step({ type: "task.report", taskId });
    await step({ type: "task.verify", taskId });
    await step({ type: "task.accept", taskId, evidenceId: `evidence-${ref}`, workspaceRevision: "rev-1" });
  }
  await step({ type: "task.start", taskId: "task-3", attemptId: "attempt-3", sessionId: "session-3" });
  await step({ type: "task.block", taskId: "task-3", reason: "no executable final check" });
  await step({ type: "run.transition", to: "paused" });

  const loaded = await journal.load();
  assert.equal(loaded.ok, true, loaded.ok ? "" : loaded.error);
  if (!loaded.ok) throw new Error("unreachable");

  const manifestPath = path.join(root, "manifest.json");
  fs.writeFileSync(
    manifestPath,
    JSON.stringify(
      {
        reason: "Replace the malformed inline-command bullets with executable gates.",
        source: "repair-orchestrator-checks test",
        commands: PROPOSED,
      },
      null,
      2,
    ),
    "utf8",
  );
  return { root, runDir, runId, manifestPath, seq: loaded.value.seq };
}

interface ScriptResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runScript(args: string[]): ScriptResult {
  const result = spawnSync(
    process.execPath,
    ["--experimental-transform-types", SCRIPT, ...args],
    { cwd: HERE, encoding: "utf8", timeout: 120_000 },
  );
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function journalText(run: BuiltRun): string {
  return fs.readFileSync(path.join(run.runDir, "journal.ndjson"), "utf8");
}

function lineCount(run: BuiltRun): number {
  return journalText(run).split("\n").filter((line) => line.length > 0).length;
}

test("repair script: --status reports the run without writing", async () => {
  const run = await buildRun();
  const before = journalText(run);
  const result = runScript(["--run-dir", run.runDir, "--status"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(run.runId));
  assert.match(result.stdout, /phase: paused/);
  assert.match(result.stdout, /accepted: 2\/3/);
  assert.match(result.stdout, /current checks: 2/);
  assert.match(result.stdout, /BAD .*Markdown backticks/);
  assert.match(result.stdout, /task-3: blocked/);
  assert.equal(journalText(run), before, "--status must not touch the journal");
});

test("repair script: dry-run validates the manifest and writes nothing", async () => {
  const run = await buildRun();
  const before = journalText(run);
  const result = runScript(["--run-dir", run.runDir, "--manifest", run.manifestPath]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /proposed checks: 3 \(valid\)/);
  assert.match(result.stdout, /validation: ok — 3 gate, 0 diagnostic, 0 manual/);
  assert.match(result.stdout, /mode: dry-run — no journal write/);
  assert.equal(journalText(run), before);
  assert.equal(lineCount(run), run.seq);
});

test("repair script: apply requires --yes and refuses a stale --expect-seq", async () => {
  const run = await buildRun();
  const before = journalText(run);

  const noYes = runScript([
    "--run-dir", run.runDir,
    "--manifest", run.manifestPath,
    "--apply",
  ]);
  assert.equal(noYes.status, 1);
  assert.match(noYes.stderr, /--apply needs --yes/);

  const stale = runScript([
    "--run-dir", run.runDir,
    "--manifest", run.manifestPath,
    "--apply",
    "--yes",
    "--expect-seq", String(run.seq - 1),
  ]);
  assert.equal(stale.status, 1);
  assert.match(stale.stderr, new RegExp(`observed seq ${run.seq}`));

  const wrongAccepted = runScript([
    "--run-dir", run.runDir,
    "--manifest", run.manifestPath,
    "--apply",
    "--yes",
    "--expect-accepted", "3",
  ]);
  assert.equal(wrongAccepted.status, 1);
  assert.match(wrongAccepted.stderr, /observed 2 accepted row/);
  assert.equal(journalText(run), before);
});

test("repair script: apply appends one valid amendment and preserves accepted rows", async () => {
  const run = await buildRun();
  const result = runScript([
    "--run-dir", run.runDir,
    "--manifest", run.manifestPath,
    "--apply",
    "--yes",
    "--expect-seq", String(run.seq),
    "--expect-accepted", "2",
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /applied: repair-[a-f0-9]+ at seq/);
  assert.match(result.stdout, /accepted: 2\/3 \(unchanged: true\)/);
  assert.match(result.stdout, /checksum chain: ok/);
  assert.match(result.stdout, /specs on reload: match/);

  assert.equal(lineCount(run), run.seq + 1);
  const replay = replayJournal(run.runId, journalText(run));
  assert.equal(replay.ok, true);
  if (!replay.ok) return;
  assert.equal(replay.value.state.truncated, 0);
  assert.equal(replay.value.state.seq, run.seq + 1);
  assert.equal(replay.value.state.acceptedTaskIds.size, 2);

  const records = replay.value.state.events.filter(
    (event) =>
      event.type === "run.control" &&
      (event.payload as { action?: string }).action === "plan-check-specs-repair",
  );
  assert.equal(records.length, 1);
  const payload = records[0]?.payload as {
    previous: { planChecks: string[] };
    next: { planChecks: string[]; planCheckSpecs: Array<{ command: string; kind: string }> };
    reason: string;
    manifestSha256: string;
  };
  assert.deepEqual(payload.previous.planChecks, MALFORMED);
  assert.deepEqual(payload.next.planChecks, PROPOSED);
  assert.deepEqual(
    payload.next.planCheckSpecs.map((spec) => spec.kind),
    ["gate", "gate", "gate"],
  );
  assert.match(payload.reason, /malformed inline-command/);
  assert.match(payload.manifestSha256, /^[a-f0-9]{64}$/);

  const snapshotPath = path.join(run.runDir, "snapshot.json");
  const snapshot = JSON.parse(fs.readFileSync(snapshotPath, "utf8")) as {
    seq: number;
    version: number;
  };
  assert.equal(snapshot.version, 1);
  assert.equal(snapshot.seq, run.seq + 1);

  const artifacts = path.join(run.runDir, "artifacts");
  assert.ok(fs.existsSync(artifacts));
  assert.ok(fs.readdirSync(artifacts).includes(payload.manifestSha256));
});

test("repair script: a repeated apply is an idempotent no-op", async () => {
  const run = await buildRun();
  const first = runScript([
    "--run-dir", run.runDir,
    "--manifest", run.manifestPath,
    "--apply",
    "--yes",
  ]);
  assert.equal(first.status, 0, first.stderr);
  const afterFirst = journalText(run);

  const second = runScript([
    "--run-dir", run.runDir,
    "--manifest", run.manifestPath,
    "--apply",
    "--yes",
  ]);
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /no-op — the checks already match the manifest/);
  assert.equal(journalText(run), afterFirst, "a rerun must not append another event");
});

test("repair script: --json emits one machine-readable document", async () => {
  const run = await buildRun();
  const result = runScript([
    "--run-dir", run.runDir,
    "--manifest", run.manifestPath,
    "--json",
  ]);
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout) as {
    ok: boolean;
    mode: string;
    run: { runId: string; seq: number; accepted: number; checks: Array<{ valid: boolean }> };
    proposed: Array<{ command: string; kind: string }>;
    validation: { ok: boolean; counts: { gate: number } };
  };
  assert.equal(payload.ok, true);
  assert.equal(payload.mode, "dry-run");
  assert.equal(payload.run.runId, run.runId);
  assert.equal(payload.run.seq, run.seq);
  assert.equal(payload.run.accepted, 2);
  assert.equal(payload.run.checks.every((check) => check.valid === false), true);
  assert.deepEqual(payload.proposed.map((check) => check.command), PROPOSED);
  assert.equal(payload.validation.ok, true);
  assert.equal(payload.validation.counts.gate, 3);
});
