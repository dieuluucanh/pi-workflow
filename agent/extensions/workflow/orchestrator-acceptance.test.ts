/**
 * Evidence-backed acceptance tests (step 32).
 *
 * Pins: parent-captured diffs, real check evidence, explicit blockers for
 * pre-existing red gates / unavailable tools / manual-only criteria, the
 * workspace revision fence, and an atomic idempotent acceptance transition.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  applyAcceptanceDecision,
  diffCandidateChanges,
  evidenceIdFor,
  runAcceptance,
  type AcceptanceInput,
  type CheckRequest,
  type CheckExecutor,
} from "./orchestrator-acceptance.ts";
import { applyRunEvent, createRunState, type RunState } from "./orchestrator-state.ts";
import {
  ORCHESTRATOR_SCHEMA_VERSION,
  type PlannedTask,
  type RoadmapRequirement,
} from "./orchestrator-types.ts";
import type { BaselineChange, WorkspaceBaseline } from "./orchestrator-workspace.ts";

const REQS: RoadmapRequirement[] = [
  { roadmapStepId: "step-r1", label: "1", text: "Read the API" },
];

const TASKS: PlannedTask[] = [
  {
    taskId: "task-t1",
    covers: ["step-r1"],
    objective: "Read the API",
    nonGoals: [],
    dependsOn: [],
    expectedFiles: ["src/api.ts"],
    acceptanceChecks: ["tests"],
    sizeRationale: "small",
  },
];

const WORKSPACE_REVISION = "workspace-rev-1";

function ok<T>(result: { ok: boolean }, label = "expected success"): T {
  assert.equal(result.ok, true, label);
  return result as unknown as T;
}

function baseline(
  changes: BaselineChange[],
  over: Partial<WorkspaceBaseline> = {},
): WorkspaceBaseline {
  return {
    schemaVersion: 1,
    workspaceKey: "ws-1",
    root: "/repo",
    kind: "git",
    capturedAt: 1,
    changes,
    counts: {
      staged: changes.filter((change) => change.staged).length,
      unstaged: changes.filter((change) => !change.staged).length,
      untracked: changes.filter((change) => change.status === "untracked").length,
      deleted: changes.filter((change) => change.status === "deleted").length,
      binary: changes.filter((change) => change.status === "binary").length,
    },
    truncated: false,
    digest: `digest-${changes.length}`,
    ...over,
  };
}

function verifyingState(): RunState {
  let state = ok<{ state: RunState }>(
    createRunState({ runId: "run-1", roadmapRevision: 1, now: 1 }),
  ).state;
  state = ok<{ state: RunState }>(
    applyRunEvent(state, {
      type: "plan.apply",
      runId: "run-1",
      expectedRevision: state.revision,
      now: 2,
      plan: {
        schemaVersion: ORCHESTRATOR_SCHEMA_VERSION,
        runId: "run-1",
        roadmapRevision: 1,
        tasks: TASKS,
      },
      requirements: REQS,
    }),
  ).state;
  state = ok<{ state: RunState }>(
    applyRunEvent(state, {
      type: "task.assign",
      runId: "run-1",
      expectedRevision: state.revision,
      now: 3,
      taskId: "task-t1",
      attemptId: "attempt-a1",
      sessionId: "session-s1",
      generation: 1,
    }),
  ).state;
  state = ok<{ state: RunState }>(
    applyRunEvent(state, {
      type: "task.start",
      runId: "run-1",
      expectedRevision: state.revision,
      now: 4,
      taskId: "task-t1",
      attemptId: "attempt-a1",
      sessionId: "session-s1",
      generation: 1,
    }),
  ).state;
  state = ok<{ state: RunState }>(
    applyRunEvent(state, {
      type: "task.candidate",
      runId: "run-1",
      expectedRevision: state.revision,
      now: 5,
      taskId: "task-t1",
      attemptId: "attempt-a1",
      candidateId: "candidate-c1",
      meaningfulChange: true,
    }),
  ).state;
  return ok<{ state: RunState }>(
    applyRunEvent(state, {
      type: "task.verify",
      runId: "run-1",
      expectedRevision: state.revision,
      now: 6,
      taskId: "task-t1",
    }),
  ).state;
}

function input(over: Partial<AcceptanceInput> = {}): AcceptanceInput {
  return {
    runId: "run-1",
    taskId: "task-t1",
    attemptId: "attempt-a1",
    candidateId: "candidate-c1",
    roadmapRevision: 1,
    workspace: { revision: WORKSPACE_REVISION, quiescent: true },
    baseline: baseline([]),
    candidate: baseline([
      { path: "src/api.ts", status: "modified", staged: false },
      { path: "src/new.ts", status: "untracked", staged: false },
      { path: "old.ts", status: "deleted", staged: false },
      { path: "assets/logo.png", status: "binary", staged: false },
    ]),
    requiredCriteria: ["step-r1"],
    criteria: [{ roadmapStepId: "step-r1", status: "met" }],
    checks: [{ name: "tests", required: true }],
    expectedPaths: ["src/api.ts"],
    cwd: "/repo",
    now: 7,
    ...over,
  };
}

function executor(
  observation: Record<string, { status: "passed" | "failed" | "skipped"; exitCode?: number; evidence?: string }> = {},
  calls: string[] = [],
): CheckExecutor {
  return {
    async run(request) {
      calls.push(request.name);
      const found = observation[request.name];
      if (!found) return { status: "passed", exitCode: 0 };
      return found;
    },
  };
}

test("the parent diff includes untracked, deleted and binary changes", () => {
  const diff = diffCandidateChanges(
    baseline([{ path: "kept.ts", status: "modified", staged: false }]),
    baseline([
      { path: "kept.ts", status: "modified", staged: true },
      { path: "new.ts", status: "untracked", staged: false },
      { path: "gone.ts", status: "deleted", staged: false },
      { path: "logo.png", status: "binary", staged: false },
    ]),
  );
  assert.deepEqual(diff.added, ["logo.png", "new.ts"]);
  assert.deepEqual(diff.modified, ["kept.ts"]);
  assert.deepEqual(diff.deleted, ["gone.ts"]);
  assert.deepEqual(diff.binary, ["logo.png"]);
  assert.equal(diff.filesChanged, 4);
});

test("acceptance requires real check evidence and met criteria", async () => {
  const calls: string[] = [];
  const built = ok<{ outcome: any }>(
    await runAcceptance(input(), executor({ tests: { status: "passed", exitCode: 0 } }, calls)),
  );
  assert.deepEqual(calls, ["tests"]);
  assert.equal(built.outcome.verdict, "accepted");
  assert.equal(built.outcome.evidence.verdict, "accepted");
  assert.equal(built.outcome.evidence.checks[0].evidence, "exit 0");
  assert.equal(built.outcome.evidence.inspected.filesChanged, 4);
});

test("a claimed pass with no evidence, a missing check and a red gate are explicit", async () => {
  const noEvidence = ok<{ outcome: any }>(
    await runAcceptance(input(), executor({ tests: { status: "passed" } })),
  );
  assert.equal(noEvidence.outcome.verdict, "needs_fix");
  assert.match(noEvidence.outcome.blockers.join(" "), /without recorded evidence/);

  const noChecks = ok<{ outcome: any }>(await runAcceptance(input({ checks: [] }), executor()));
  assert.equal(noChecks.outcome.phase, "blocked");
  assert.match(noChecks.outcome.blockers.join(" "), /no verification checks were run/);

  const preExisting = ok<{ outcome: any }>(
    await runAcceptance(
      input({ baselineChecks: [{ name: "tests", status: "failed" }] }),
      executor({ tests: { status: "passed", exitCode: 0 } }),
    ),
  );
  assert.equal(preExisting.outcome.phase, "blocked");
  assert.match(preExisting.outcome.blockers.join(" "), /pre-existing red gate/);

  const failed = ok<{ outcome: any }>(
    await runAcceptance(
      input({ expectedPaths: [] }),
      executor({ tests: { status: "failed", exitCode: 1, evidence: "boom" } }),
    ),
  );
  assert.equal(failed.outcome.verdict, "needs_fix");
  assert.match(failed.outcome.blockers.join(" "), /required check failed: tests/);
});

test("unavailable tools, manual-only checks and missing expected changes block", async () => {
  const unavailable = ok<{ outcome: any }>(
    await runAcceptance(
      input({
        checks: [{ name: "tests", required: true, tool: "pi-lens" } as CheckRequest],
        unavailableTools: ["pi-lens"],
      }),
      executor(),
    ),
  );
  assert.equal(unavailable.outcome.phase, "blocked");
  assert.match(unavailable.outcome.blockers.join(" "), /required tool is unavailable/);

  const manual = ok<{ outcome: any }>(
    await runAcceptance(
      input({ checks: [{ name: "visual check", required: true, manualOnly: true }] }),
      executor(),
    ),
  );
  assert.equal(manual.outcome.phase, "blocked");
  assert.match(manual.outcome.blockers.join(" "), /manual-only check/);

  const acceptedManual = ok<{ outcome: any }>(
    await runAcceptance(
      input({
        checks: [{ name: "visual check", required: true, manualOnly: true }],
        manualChecks: [{ name: "visual check", approvedBy: "user" }],
      }),
      executor(),
    ),
  );
  assert.equal(acceptedManual.outcome.verdict, "accepted");

  const missing = ok<{ outcome: any }>(
    await runAcceptance(input({ expectedPaths: ["src/other.ts"] }), executor()),
  );
  assert.equal(missing.outcome.phase, "needs_fix");
  assert.match(missing.outcome.blockers.join(" "), /expected change is missing/);

  const notQuiescent = ok<{ outcome: any }>(
    await runAcceptance(input({ workspace: { revision: WORKSPACE_REVISION, quiescent: false } }), executor()),
  );
  assert.equal(notQuiescent.outcome.phase, "blocked");
});

test("a changed workspace invalidates evidence and acceptance is idempotent", async () => {
  const built = ok<{ outcome: any }>(await runAcceptance(input(), executor()));
  const evidence = built.outcome.evidence;
  const state = verifyingState();

  const changed = applyAcceptanceDecision({
    state,
    evidence,
    currentWorkspaceRevision: "workspace-rev-2",
    now: 8,
  });
  assert.equal(changed.ok, false);
  assert.equal((changed as any).code, "workspace");

  const accepted = applyAcceptanceDecision({
    state,
    evidence,
    currentWorkspaceRevision: WORKSPACE_REVISION,
    now: 8,
  });
  assert.equal(accepted.ok, true);
  const next = (accepted as any).state as RunState;
  assert.equal(next.tasks["task-t1"]!.state, "accepted");
  assert.equal(next.revision, state.revision + 1);

  const repeat = applyAcceptanceDecision({
    state: next,
    evidence,
    currentWorkspaceRevision: WORKSPACE_REVISION,
    now: 9,
  });
  assert.equal(repeat.ok, true);
  assert.equal((repeat as any).duplicate, true);
  assert.equal((repeat as any).state.revision, next.revision);
});

test("an advanced task state cannot accept stale evidence; ids are deterministic", async () => {
  const built = ok<{ outcome: any }>(await runAcceptance(input(), executor()));
  const evidence = built.outcome.evidence;
  assert.equal(
    evidence.evidenceId,
    evidenceIdFor({
      runId: "run-1",
      taskId: "task-t1",
      attemptId: "attempt-a1",
      candidateId: "candidate-c1",
      workspaceRevision: WORKSPACE_REVISION,
      roadmapRevision: 1,
    }),
  );

  const state = verifyingState();
  const advanced = ok<{ state: RunState }>(
    applyRunEvent(state, {
      type: "task.needsFix",
      runId: "run-1",
      expectedRevision: state.revision,
      now: 8,
      taskId: "task-t1",
      meaningfulChange: true,
      reason: "verification failed",
    }),
  ).state;
  const rejected = applyAcceptanceDecision({
    state: advanced,
    evidence,
    currentWorkspaceRevision: WORKSPACE_REVISION,
    now: 9,
  });
  assert.equal(rejected.ok, false);
  assert.equal((rejected as any).code, "state");

  const mismatched = applyAcceptanceDecision({
    state,
    evidence: { ...evidence, candidateId: "candidate-c2" },
    currentWorkspaceRevision: WORKSPACE_REVISION,
    now: 10,
  });
  assert.equal(mismatched.ok, false);
  assert.equal((mismatched as any).code, "evidence");
});

test("content digests detect a same-length edit to an already-dirty file", () => {
  const before = baseline(
    [{ path: "src/api.ts", status: "modified", staged: false, size: 10, contentDigest: "old" }],
    { contentComplete: true },
  );
  const after = baseline(
    [{ path: "src/api.ts", status: "modified", staged: false, size: 10, contentDigest: "new" }],
    { contentComplete: true },
  );
  const diff = diffCandidateChanges(before, after);
  assert.deepEqual(diff.modified, ["src/api.ts"]);
  assert.equal(diff.filesChanged, 1);
});

test("staged and unstaged observations of one path are not collapsed", () => {
  const before = baseline([
    { path: "src/api.ts", status: "modified", staged: false },
  ]);
  const after = baseline([
    { path: "src/api.ts", status: "modified", staged: false },
    { path: "src/api.ts", status: "modified", staged: true },
  ]);
  const diff = diffCandidateChanges(before, after);
  assert.deepEqual(diff.modified, ["src/api.ts"]);

  const reversed = diffCandidateChanges(after, before);
  assert.ok(reversed.modified.includes("src/api.ts"));
});

test("metadata-only content coverage blocks acceptance instead of becoming a pass", async () => {
  const built = ok<{ outcome: any }>(
    await runAcceptance(
      input({
        baseline: baseline([], { contentComplete: false }),
        candidate: baseline(
          [{ path: "src/api.ts", status: "modified", staged: false }],
          { contentComplete: false },
        ),
      }),
      executor({ tests: { status: "passed", exitCode: 0 } }),
    ),
  );
  assert.equal(built.outcome.phase, "blocked");
  assert.match(built.outcome.blockers.join(" "), /no content identity/);
});
