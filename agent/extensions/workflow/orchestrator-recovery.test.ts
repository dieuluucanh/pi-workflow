/**
 * Recovery tests (step 38): a clean resume, uncertain kickoff reconciliation,
 * snapshot/journal disagreement, stale-writer safety, parent loss, branch forks
 * and ignored cross-branch session refs.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  planRecovery,
  type RecoveryInput,
  type SessionProbe,
} from "./orchestrator-recovery.ts";
import type { JournalState, KickoffState } from "./orchestrator-store.ts";

const CURRENT = { instanceId: "proc-1", startedAt: 100, heartbeatAt: 200 };

function acked(): KickoffState {
  return {
    intent: { attemptId: "attempt-a1", sessionId: "session-s1", at: 1 },
    ack: { attemptId: "attempt-a1", sessionId: "session-s1", at: 2 },
    status: "acknowledged",
  };
}

function journal(over: Partial<JournalState> = {}): JournalState {
  return {
    runId: "run-1",
    seq: 10,
    revision: 10,
    events: [],
    accepted: [],
    acceptedTaskIds: new Set(["task-t1"]),
    kickoff: { "task-t1": acked() },
    sessionsByBranch: new Map([
      ["branch-1", [{ sessionRef: "session-s1", taskId: "task-t1", attemptId: "attempt-a1" }]],
    ]),
    truncated: 0,
    ...over,
  };
}

function probe(over: Partial<SessionProbe> = {}): SessionProbe {
  return {
    sessionRef: "session-s1",
    sessionFile: "C:/sessions/worker.jsonl",
    exists: true,
    ownerInstance: "proc-1",
    heartbeatAt: 200,
    ...over,
  };
}

function input(over: Partial<RecoveryInput> = {}): RecoveryInput {
  return {
    journal: journal(),
    snapshot: {
      runId: "run-1",
      revision: 10,
      phase: "building",
      acceptedTaskIds: ["task-t1"],
    },
    branch: { id: "branch-1", kind: "active", activeRunId: "run-1" },
    sessions: [probe()],
    parent: { identity: CURRENT, alive: true },
    current: CURRENT,
    staleMs: 30_000,
    now: 250,
    ...over,
  };
}

test("a clean journal/branch/process/session set resumes", () => {
  const plan = planRecovery(input());
  assert.equal(plan.action, "resume");
  assert.equal(plan.resumeAllowed, true);
  assert.equal(plan.ownership, "current_instance");
  assert.equal(plan.staleWriterPossible, false);
  assert.equal(plan.sessions[0]!.state, "live");
  assert.deepEqual(plan.acceptedTaskIds, ["task-t1"]);
});

test("an intent without an ack asks for reconciliation, never a blind resend", () => {
  const uncertain: KickoffState = {
    intent: { attemptId: "attempt-a1", sessionId: "session-s1", at: 1 },
    status: "uncertain",
  };
  const plan = planRecovery(input({ journal: journal({ kickoff: { "task-t1": uncertain } }) }));
  assert.equal(plan.action, "reconcile_start");
  assert.equal(plan.resumeAllowed, false);
  assert.deepEqual(plan.reconcileTasks, ["task-t1"]);
  assert.match(plan.kickoff[0]!.instruction, /do not resend the kickoff blindly/);
});

test("an inconsistent ack pauses and a snapshot cannot invent acceptance", () => {
  const inconsistent: KickoffState = {
    intent: { attemptId: "attempt-a1", at: 1 },
    ack: { attemptId: "attempt-a2", at: 2 },
    status: "inconsistent",
  };
  const badKickoff = planRecovery(input({ journal: journal({ kickoff: { "task-t1": inconsistent } }) }));
  assert.equal(badKickoff.action, "reconcile_start");
  assert.deepEqual(badKickoff.pausedTasks, ["task-t1"]);

  const invented = planRecovery(
    input({
      snapshot: {
        runId: "run-1",
        revision: 10,
        phase: "building",
        acceptedTaskIds: ["task-t1", "task-t2"],
      },
    }),
  );
  assert.equal(invented.action, "pause");
  assert.equal(invented.snapshotMatchesJournal, false);
  assert.match(invented.reason, /never recorded/);
});

test("an old parent with a fresh heartbeat blocks reacquisition despite TTL", () => {
  const oldParent = { instanceId: "proc-0", startedAt: 1, heartbeatAt: 240 };
  const plan = planRecovery(
    input({
      parent: { identity: oldParent, alive: true },
      current: { instanceId: "proc-1", startedAt: 245, heartbeatAt: 250 },
      staleMs: 10,
    }),
  );
  assert.equal(plan.action, "pause");
  assert.equal(plan.staleWriterPossible, true);
  assert.equal(plan.ownership, "old_instance");
  assert.match(plan.reason, /TTL alone is not ownership/);
});

test("parent loss stops children safely instead of resuming their work", () => {
  const plan = planRecovery(
    input({
      parent: { identity: { instanceId: "proc-0", startedAt: 1, heartbeatAt: 1 }, alive: false },
      current: { instanceId: "proc-1", startedAt: 245, heartbeatAt: 250 },
      staleMs: 10,
    }),
  );
  assert.equal(plan.action, "stop_children");
  assert.equal(plan.stopChildren, true);
  assert.equal(plan.resumeAllowed, false);
});

test("fork/tree/rewind branches require an explicit clone decision", () => {
  for (const kind of ["fork", "tree", "rewind"] as const) {
    const plan = planRecovery(input({ branch: { id: "branch-2", kind, activeRunId: "run-1" } }));
    assert.equal(plan.action, "clone_required");
    assert.equal(plan.resumeAllowed, false);
    assert.match(plan.reason, /explicit clone decision/);
  }
});

test("a missing acknowledged session pauses and another branch's refs are ignored", () => {
  const missing = planRecovery(input({ sessions: [probe({ exists: false })] }));
  assert.equal(missing.action, "pause");
  assert.deepEqual(missing.pausedTasks, ["task-t1"]);
  assert.match(missing.reason, /no live session file/);

  const otherBranch = planRecovery(
    input({
      sessions: [],
      journal: journal({
        sessionsByBranch: new Map([
          ["branch-1", []],
          ["branch-old", [{ sessionRef: "session-old", taskId: "task-old" }]],
        ]),
      }),
    }),
  );
  assert.equal(otherBranch.action, "resume");
  assert.deepEqual(otherBranch.sessions, []);
});

test("a truncated journal and a snapshot from another run fail closed", () => {
  const truncated = planRecovery(input({ journal: journal({ truncated: 2 }) }));
  assert.equal(truncated.action, "pause");
  assert.match(truncated.reason, /torn line/);

  const wrongRun = planRecovery(
    input({
      snapshot: { runId: "run-2", revision: 1, phase: "ready", acceptedTaskIds: [] },
    }),
  );
  assert.equal(wrongRun.action, "pause");
  assert.equal(wrongRun.snapshotMatchesJournal, false);
});

test("journal acceptance missing from the snapshot is replayed, not lost", () => {
  const plan = planRecovery(
    input({
      snapshot: { runId: "run-1", revision: 5, phase: "building", acceptedTaskIds: [] },
    }),
  );
  assert.equal(plan.action, "resume");
  assert.equal(plan.snapshotStale, true);
  assert.match(plan.reason, /rebuild the snapshot/);
});
