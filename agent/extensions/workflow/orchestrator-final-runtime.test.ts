/**
 * Final-gate and accepted-commit tests (plan step 22).
 *
 * The regression that matters most: a required final check that reported
 * `skipped` must never complete the roadmap. The commit path is parent-only and
 * commits an accepted task at most once.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { createFinalRuntime } from "./orchestrator-final-runtime.ts";
import { createCommitLedger } from "./orchestrator-commits.ts";
import { evaluateFinalGate } from "./orchestrator-roadmap.ts";
import type { OrchestratorRuntime } from "./orchestrator-runtime.ts";
import type { RunState } from "./orchestrator-state.ts";

function acceptedState(): RunState {
  const task = {
    taskId: "task-1",
    covers: ["step-1"],
    objective: "one",
    nonGoals: [],
    dependsOn: [],
    expectedFiles: ["a.ts"],
    acceptanceChecks: ["npm test"],
    sizeRationale: "small",
    state: "accepted" as const,
    attempts: [],
    counters: { repairRounds: 0, noProgress: 0, rollovers: 0, launchFailures: 0 },
    acceptance: {
      evidenceId: "evidence-1",
      candidateId: "candidate-1",
      attemptId: "attempt-1",
      workspaceRevision: "rev-1",
      roadmapRevision: 1,
      acceptedAt: 2,
    },
  };
  return {
    schemaVersion: 1,
    runId: "run-1",
    revision: 3,
    phase: "ready",
    roadmapRevision: 1,
    planRevision: 1,
    requirements: [{ roadmapStepId: "step-1", label: "1", text: "one" }],
    tasks: { "task-1": task },
    order: ["task-1"],
    mutation: null,
    createdAt: 1,
    updatedAt: 3,
  };
}

function fakeRuntime(state: RunState) {
  const appended: string[] = [];
  const runtime = {
    view() {
      return {
        runId: "run-1",
        phase: state.phase,
        roadmapRevision: 1,
        roadmap: { path: "p", digest: "d", title: "t", requirementCount: 1 },
        plan: null,
        preview: null,
        approval: null,
        preparationStarted: true,
        state,
      } as never;
    },
    async appendJournal(type: string) {
      appended.push(type);
      return { ok: true as const, value: undefined };
    },
    async applyEvent(event: { type: string; to?: string }) {
      appended.push(`${event.type}:${event.to ?? ""}`);
      return { ok: true as const, value: { revision: 4, view: runtime.view() } };
    },
  };
  // SAFETY: the final runtime only uses view/appendJournal/applyEvent.
  return { runtime: runtime as unknown as OrchestratorRuntime, appended };
}

test("a required final check that was skipped never completes the roadmap", () => {
  const state = acceptedState();
  const decision = evaluateFinalGate({
    snapshot: {
      schemaVersion: 1,
      sourcePath: "p",
      digest: "d",
      title: "t",
      requirements: [
        {
          roadmapStepId: "step-1",
          label: "1",
          text: "one",
          phasePath: [],
          claimedComplete: false,
          completionVerified: false,
        },
      ],
      phases: [],
      lineCount: 10,
      createdAt: 1,
    } as never,
    state,
    approval: { roadmapDigest: "d", roadmapRevision: 1 },
    workspace: { revision: "rev-1", quiescent: true },
    verifiedWorkspaceRevision: "rev-1",
    checks: [{ name: "integration", status: "skipped" }],
    requiredChecks: ["integration"],
    manualAcceptance: [],
    now: 10,
  });
  assert.equal(decision.ok, true);
  if (!decision.ok) return;
  assert.notEqual(decision.decision, "complete");
  if (decision.decision !== "complete") {
    assert.ok(decision.blockers.some((entry) => /did not run/.test(entry)));
  }
});

test("an accepted task is committed at most once, by the parent", async () => {
  const state = acceptedState();
  const { runtime, appended } = fakeRuntime(state);
  const ledger = createCommitLedger();
  const commits: string[] = [];
  const final = createFinalRuntime({
    runtime: () => runtime,
    ledger,
    commitMode: () => "allow",
    git: {
      async stage() {},
      async commit() {
        commits.push("commit");
        return { sha: "abc123" };
      },
      async findCommit() {
        return null;
      },
    },
    now: () => 5,
  });

  const request = {
    taskId: "task-1",
    evidenceId: "evidence-1",
    candidateId: "candidate-1",
    acceptedPaths: ["a.ts"],
  };
  const first = await final.commitAccepted(request);
  assert.equal(first.ok, true, first.ok ? "" : first.error);
  if (!first.ok) return;
  assert.equal(first.value.apply.ok, true, first.value.apply.ok ? "" : first.value.apply.error);
  if (first.value.apply.ok) assert.equal(first.value.apply.status, "committed");

  const again = await final.commitAccepted(request);
  assert.equal(again.ok, true);
  if (!again.ok) return;
  assert.equal(again.value.apply.ok, true);
  // The ledger already owns this key, so a second call is skipped rather than
  // committed again; both are "no new commit".
  assert.notEqual(again.value.decision.ok && again.value.decision.action, "commit");
  if (again.value.apply.ok) {
    assert.ok(["not_committed", "already_committed"].includes(again.value.apply.status));
  }
  assert.equal(commits.length, 1, "the same acceptance is never committed twice");
  assert.ok(appended.includes("run.control"));
});

test("a non-accepted task cannot be committed", async () => {
  const state = acceptedState();
  state.tasks["task-1"] = { ...state.tasks["task-1"]!, state: "verifying" };
  const { runtime } = fakeRuntime(state);
  const final = createFinalRuntime({
    runtime: () => runtime,
    ledger: createCommitLedger(),
    commitMode: () => "allow",
    git: {
      async stage() {},
      async commit() {
        return { sha: "x" };
      },
      async findCommit() {
        return null;
      },
    },
  });
  const result = await final.commitAccepted({
    taskId: "task-1",
    evidenceId: "evidence-1",
    candidateId: "candidate-1",
    acceptedPaths: ["a.ts"],
  });
  assert.equal(result.ok, false);
});

test("a final-gate failure records a revision proposal and never reopens accepted work", async () => {
  const state = acceptedState();
  const { runtime, appended } = fakeRuntime(state);
  const final = createFinalRuntime({
    runtime: () => runtime,
    ledger: createCommitLedger(),
    commitMode: () => "never",
    git: {
      async stage() {},
      async commit() {
        return { sha: "x" };
      },
      async findCommit() {
        return null;
      },
    },
  });
  const revision = await final.proposeRevision("integration failed: add the missing export");
  assert.equal(revision.ok, true);
  if (revision.ok) assert.equal(revision.value.requiresApproval, true);
  assert.ok(appended.includes("plan.revision"));
  assert.equal(state.tasks["task-1"]?.state, "accepted", "accepted evidence is immutable");
});
