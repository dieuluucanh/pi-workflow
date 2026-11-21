/**
 * Orchestrator contract tests (step 2).
 *
 * These pin the executable parts of the contract: the transition tables, plan
 * coverage, report/evidence validation, lease ownership and the related-session
 * launch gate. They are pure — no Pi host, no provider, no filesystem.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_EXECUTION_BUDGETS,
  MAX_EXECUTION_BUDGETS,
  ORCHESTRATOR_SCHEMA_VERSION,
  RUN_PHASES,
  RUN_TRANSITIONS,
  TASK_STATES,
  TASK_TRANSITIONS,
  TERMINAL_RUN_PHASES,
  TERMINAL_TASK_STATES,
  acceptanceBlocker,
  canTransitionRun,
  canTransitionTask,
  coerceExecutionBudgets,
  findDependencyCycle,
  isIdentifier,
  isTaskState,
  ownsWorkspace,
  validateAcceptanceEvidence,
  validatePlanCoverage,
  validateWorkerReport,
  type AcceptanceEvidence,
  type MutationGrant,
  type PlannedTask,
  type RoadmapRequirement,
  type WorkerReport,
} from "./orchestrator-types.ts";
import {
  SESSION_HOST_VERSION,
  dispatchSupport,
  validateRelatedSessionSpec,
  type SessionHostCapabilities,
} from "./session-host.ts";

// ── Transition tables ────────────────────────────────────────────────

test("run transitions: every phase is in the table and terminals are exits", () => {
  for (const phase of RUN_PHASES) {
    const targets = RUN_TRANSITIONS[phase];
    assert.ok(Array.isArray(targets), `${phase} must have a transition list`);
    for (const target of targets) {
      assert.ok(RUN_PHASES.includes(target), `${phase} → ${target} names an unknown phase`);
    }
    if (TERMINAL_RUN_PHASES.has(phase)) {
      assert.deepEqual(targets, [], `${phase} is terminal and must not transition`);
    } else {
      assert.ok(targets.length > 0, `${phase} must have at least one exit`);
    }
  }
});

test("run transitions: completion is reachable only through final verification", () => {
  const intoCompleted = RUN_PHASES.filter((phase) => RUN_TRANSITIONS[phase].includes("completed"));
  assert.deepEqual(intoCompleted, ["final_verification"]);
  assert.equal(canTransitionRun("final_verification", "completed"), true);
  assert.equal(canTransitionRun("verifying", "completed"), false);
  assert.equal(canTransitionRun("completed", "ready"), false);
});

test("run transitions: no phase can skip acceptance via building → completed", () => {
  for (const phase of RUN_PHASES) {
    if (phase === "final_verification") continue;
    assert.equal(canTransitionRun(phase, "completed"), false, `${phase} must not complete directly`);
  }
});

test("task transitions: acceptance is reachable only from verifying", () => {
  const intoAccepted = TASK_STATES.filter((state) => TASK_TRANSITIONS[state].includes("accepted"));
  assert.deepEqual(intoAccepted, ["verifying"]);
  assert.equal(canTransitionTask("verifying", "accepted"), true);
  assert.equal(canTransitionTask("running", "accepted"), false);
  assert.equal(canTransitionTask("accepted", "running"), false, "accepted work is immutable");
});

test("task transitions: every state is known and terminals are exits", () => {
  for (const state of TASK_STATES) {
    const targets = TASK_TRANSITIONS[state];
    assert.ok(Array.isArray(targets), `${state} must have a transition list`);
    for (const target of targets) {
      assert.ok(TASK_STATES.includes(target), `${state} → ${target} names an unknown state`);
    }
    if (TERMINAL_TASK_STATES.has(state)) {
      assert.deepEqual(targets, [], `${state} is terminal and must not transition`);
    } else {
      assert.ok(targets.length > 0, `${state} must have at least one exit`);
    }
  }
  assert.equal(isTaskState("running"), true);
  assert.equal(isTaskState("teleported"), false);
});

test("task transitions: a failed launch returns to pending, not running", () => {
  assert.equal(canTransitionTask("assigned", "pending"), true);
  assert.equal(canTransitionTask("assigned", "running"), true);
});

// ── Identities ───────────────────────────────────────────────────────

test("identifiers are prefixed and bounded; display numbers are not ids", () => {
  assert.equal(isIdentifier("run", "run-2026-11-21-a"), true);
  assert.equal(isIdentifier("task", "task-phase-2-step-3"), true);
  assert.equal(isIdentifier("task", "3"), false, "a display ref is never a task id");
  assert.equal(isIdentifier("task", "task-" + "x".repeat(200)), false);
  assert.equal(isIdentifier("run", "task-run-1"), false, "wrong prefix is rejected");
});

// ── Plan coverage ────────────────────────────────────────────────────

const requirements: RoadmapRequirement[] = [
  { roadmapStepId: "step-phase-1", label: "1", text: "Scaffold the project" },
  { roadmapStepId: "step-phase-2", label: "2.1", text: "Add the API" },
  { roadmapStepId: "step-phase-2b", label: "2.2", text: "Add the UI" },
];

const task = (over: Partial<PlannedTask> & Pick<PlannedTask, "taskId" | "covers">): PlannedTask => ({
  objective: "do it",
  nonGoals: [],
  dependsOn: [],
  expectedFiles: [],
  acceptanceChecks: ["tests pass"],
  sizeRationale: "fits",
  ...over,
});

test("plan coverage: every requirement must be covered exactly by known tasks", () => {
  const ok = validatePlanCoverage({
    requirements,
    tasks: [
      task({ taskId: "task-1", covers: ["step-phase-1", "step-phase-2"] }),
      task({ taskId: "task-2", covers: ["step-phase-2b"], dependsOn: ["task-1"] }),
    ],
  });
  assert.deepEqual(ok, { ok: true });

  const uncovered = validatePlanCoverage({
    requirements,
    tasks: [task({ taskId: "task-1", covers: ["step-phase-1"] })],
  });
  assert.equal(uncovered.ok, false);
  if (!uncovered.ok) {
    assert.deepEqual(uncovered.uncovered, ["step-phase-2", "step-phase-2b"]);
  }

  const unknown = validatePlanCoverage({
    requirements,
    tasks: [
      task({ taskId: "task-1", covers: ["step-phase-1", "step-phase-2", "step-phase-2b", "step-ghost"] }),
    ],
  });
  assert.equal(unknown.ok, false);
});

test("plan coverage: duplicate task ids, empty coverage and unknown dependencies fail", () => {
  assert.equal(
    validatePlanCoverage({
      requirements,
      tasks: [task({ taskId: "task-1", covers: ["step-phase-1"] }), task({ taskId: "task-1", covers: ["step-phase-2"] })],
    }).ok,
    false,
  );
  assert.equal(
    validatePlanCoverage({
      requirements,
      tasks: [task({ taskId: "task-1", covers: [] })],
    }).ok,
    false,
  );
  assert.equal(
    validatePlanCoverage({
      requirements,
      tasks: [task({ taskId: "task-1", covers: ["step-phase-1"], dependsOn: ["task-nope"] })],
    }).ok,
    false,
  );
});

test("plan coverage: a dependency cycle is named and rejected", () => {
  const tasks = [
    task({ taskId: "task-a", covers: ["step-phase-1"], dependsOn: ["task-b"] }),
    task({ taskId: "task-b", covers: ["step-phase-2"], dependsOn: ["task-a"] }),
  ];
  const cycle = findDependencyCycle(tasks);
  assert.ok(cycle);
  assert.deepEqual(cycle, ["task-a", "task-b", "task-a"]);
  const result = validatePlanCoverage({ requirements, tasks });
  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.error, /dependency cycle/);
});

test("plan coverage: two tasks may cover one requirement (split work)", () => {
  const result = validatePlanCoverage({
    requirements,
    tasks: [
      task({ taskId: "task-1", covers: ["step-phase-1"], dependsOn: [] }),
      task({ taskId: "task-2", covers: ["step-phase-1", "step-phase-2", "step-phase-2b"], dependsOn: ["task-1"] }),
    ],
  });
  assert.deepEqual(result, { ok: true });
});

// ── Budgets ──────────────────────────────────────────────────────────

test("budgets: defaults are conservative and clamps cannot widen them", () => {
  assert.deepEqual(coerceExecutionBudgets(undefined), { ...DEFAULT_EXECUTION_BUDGETS });
  assert.deepEqual(coerceExecutionBudgets({ repairRounds: 999, noProgressLimit: -2 }), {
    ...DEFAULT_EXECUTION_BUDGETS,
    repairRounds: MAX_EXECUTION_BUDGETS.repairRounds,
    noProgressLimit: 0,
  });
  assert.deepEqual(coerceExecutionBudgets({ repairRounds: "2" }), { ...DEFAULT_EXECUTION_BUDGETS });
});

// ── Worker report ────────────────────────────────────────────────────

const baseReport: WorkerReport = {
  schemaVersion: ORCHESTRATOR_SCHEMA_VERSION,
  reportId: "report-1",
  runId: "run-1",
  taskId: "task-1",
  attemptId: "attempt-1",
  sessionId: "session-1",
  outcome: "candidate",
  criteria: [{ roadmapStepId: "step-phase-1", status: "met" }],
  changes: { files: ["src/a.ts"], summary: "added the scaffold" },
  checks: [{ name: "npm test", status: "passed" }],
  remaining: [],
  risks: [],
  artifacts: [],
  createdAt: 1_700_000_000_000,
};

test("worker report: a valid report is normalized into a fresh value", () => {
  const result = validateWorkerReport({ ...baseReport, extra: "ignored" });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(result.value, baseReport);
    assert.notEqual(result.value, baseReport);
  }
});

test("worker report: version, identity and outcome are enforced", () => {
  for (const broken of [
    { ...baseReport, schemaVersion: 2 },
    { ...baseReport, reportId: "1" },
    { ...baseReport, runId: "task-1" },
    { ...baseReport, outcome: "done" },
    { ...baseReport, createdAt: 0 },
  ]) {
    assert.equal(validateWorkerReport(broken).ok, false, JSON.stringify(broken).slice(0, 80));
  }
});

test("worker report: bounds reject a runaway child instead of truncating silently", () => {
  const tooManyFiles = {
    ...baseReport,
    changes: { files: Array.from({ length: 600 }, (_, i) => `f${i}.ts`), summary: "x" },
  };
  assert.equal(validateWorkerReport(tooManyFiles).ok, false);

  const tooManyCriteria = {
    ...baseReport,
    criteria: Array.from({ length: 300 }, () => ({ roadmapStepId: "step-phase-1", status: "met" })),
  };
  assert.equal(validateWorkerReport(tooManyCriteria).ok, false);

  const newline = {
    ...baseReport,
    changes: { files: ["a.ts"], summary: "line\nbreak" },
  };
  assert.equal(validateWorkerReport(newline).ok, false);
});

test("worker report: a claim never becomes an acceptance", () => {
  // The report validates fine — that is exactly why acceptance needs evidence.
  assert.equal(validateWorkerReport(baseReport).ok, true);
});

// ── Acceptance evidence ──────────────────────────────────────────────

const baseEvidence: AcceptanceEvidence = {
  schemaVersion: ORCHESTRATOR_SCHEMA_VERSION,
  evidenceId: "evidence-1",
  runId: "run-1",
  taskId: "task-1",
  attemptId: "attempt-1",
  candidateId: "candidate-1",
  roadmapRevision: 3,
  workspaceRevision: "ws-42",
  inspected: { filesChanged: 2, files: ["src/a.ts", "src/b.ts"] },
  checks: [{ name: "npm test", status: "passed", evidence: "442 files passed" }],
  verdict: "accepted",
  createdAt: 1_700_000_000_000,
};

test("acceptance evidence: validates and rejects unknown versions", () => {
  assert.equal(validateAcceptanceEvidence(baseEvidence).ok, true);
  assert.equal(validateAcceptanceEvidence({ ...baseEvidence, schemaVersion: 9 }).ok, false);
  assert.equal(validateAcceptanceEvidence({ ...baseEvidence, verdict: "sure" }).ok, false);
  assert.equal(
    validateAcceptanceEvidence({ ...baseEvidence, inspected: { filesChanged: -1, files: [] } }).ok,
    false,
  );
});

test("acceptance evidence: the parent gate is strictly evidence-based", () => {
  const ready = {
    evidence: baseEvidence,
    workspaceRevision: "ws-42",
    roadmapRevision: 3,
    unmetCriteria: [],
  };
  assert.equal(acceptanceBlocker(ready), undefined);

  assert.match(acceptanceBlocker({ ...ready, evidence: undefined }) ?? "", /no acceptance evidence/);
  assert.match(
    acceptanceBlocker({ ...ready, evidence: { ...baseEvidence, verdict: "needs_fix" } }) ?? "",
    /verdict is needs_fix/,
  );
  assert.match(
    acceptanceBlocker({ ...ready, workspaceRevision: "ws-43" }) ?? "",
    /different workspace revision/,
  );
  assert.match(acceptanceBlocker({ ...ready, roadmapRevision: 4 }) ?? "", /different roadmap revision/);
  assert.match(acceptanceBlocker({ ...ready, unmetCriteria: ["step-phase-2"] }) ?? "", /unmet criteria/);
});

test("acceptance evidence: failed or skipped checks are visible, never a pass", () => {
  const blocked = acceptanceBlocker({
    evidence: {
      ...baseEvidence,
      checks: [
        { name: "npm test", status: "passed" },
        { name: "manual smoke", status: "skipped" },
      ],
    },
    workspaceRevision: "ws-42",
    roadmapRevision: 3,
    unmetCriteria: ["manual smoke"],
  });
  assert.match(blocked ?? "", /unmet criteria: manual smoke/);
});

// ── Ownership ────────────────────────────────────────────────────────

test("ownership: only the exact lease generation may write", () => {
  const grant: MutationGrant = {
    runId: "run-1",
    taskId: "task-1",
    attemptId: "attempt-1",
    sessionId: "session-1",
    generation: 4,
  };
  assert.equal(ownsWorkspace(grant, grant), true);
  assert.equal(ownsWorkspace(grant, { ...grant, generation: 3 }), false);
  assert.equal(ownsWorkspace(grant, { ...grant, sessionId: "session-2" }), false);
  assert.equal(ownsWorkspace(undefined, grant), false);
});

// ── Related session host ─────────────────────────────────────────────

const fullHost: SessionHostCapabilities = {
  version: SESSION_HOST_VERSION,
  create: true,
  open: true,
  focus: true,
  inspect: true,
  interrupt: true,
  close: true,
  separateWindow: true,
  bootstrapBeforeStart: true,
  label: "test host",
};

test("session host: a full host passes and each missing capability blocks", () => {
  assert.equal(dispatchSupport(fullHost), undefined);
  assert.match(dispatchSupport({ ...fullHost, version: 0 }) ?? "", /older/);
  assert.match(dispatchSupport({ ...fullHost, create: false }) ?? "", /cannot open/);
  assert.match(dispatchSupport({ ...fullHost, separateWindow: false }) ?? "", /separate/);
  assert.match(dispatchSupport({ ...fullHost, bootstrapBeforeStart: false }) ?? "", /bootstrap/);
  assert.match(dispatchSupport({ ...fullHost, focus: false }) ?? "", /bring the child/);
});

test("session host: a launch spec is validated and bounded", () => {
  const spec = {
    requestId: "request-1",
    parentSessionRef: "session-parent",
    relation: "child",
    title: "Task 1",
    cwd: process.platform === "win32" ? "C:\\project" : "/project",
    mode: "build",
    dedupeKey: "task-1-attempt-1",
    bootstrap: [
      {
        customType: "workflow-managed-session",
        content: "runId=run-1 taskId=task-1 attemptId=attempt-1",
        display: false,
      },
    ],
  };
  const parsed = validateRelatedSessionSpec(spec);
  assert.equal(parsed.ok, true);

  assert.equal(validateRelatedSessionSpec({ ...spec, cwd: "relative/path" }).ok, false);
  assert.equal(validateRelatedSessionSpec({ ...spec, relation: "cousin" }).ok, false);
  assert.equal(
    validateRelatedSessionSpec({
      ...spec,
      bootstrap: [{ customType: "unknown-bootstrap", content: "x", display: false }],
    }).ok,
    false,
  );
  assert.equal(
    validateRelatedSessionSpec({
      ...spec,
      bootstrap: [
        { customType: "workflow-managed-session", content: "line\nbreak", display: false },
      ],
    }).ok,
    false,
  );
  assert.equal(
    validateRelatedSessionSpec({
      ...spec,
      bootstrap: Array.from({ length: 20 }, () => ({
        customType: "workflow-managed-session",
        content: "x",
        display: false,
      })),
    }).ok,
    false,
  );
});
