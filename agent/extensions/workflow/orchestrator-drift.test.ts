/**
 * Drift tests (step 39): material roadmap/plan/scope edits pause for approval,
 * external workspace changes require re-inspection, lost capabilities and
 * model changes pause, narrowing policy applies immediately while widening is
 * never automatic, and accepted criteria are not silently replaced.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildReconciliationProposal,
  detectDrift,
  driftGate,
  type InputSnapshot,
} from "./orchestrator-drift.ts";

function snapshot(over: Partial<InputSnapshot> = {}): InputSnapshot {
  return {
    roadmapDigest: "roadmap-1",
    roadmapRevision: 1,
    planDigest: "plan-1",
    planRevision: 1,
    tasks: {
      "task-t1": {
        covers: ["step-r1"],
        acceptanceChecks: ["tests"],
        dependsOn: [],
        expectedFiles: ["src/a.ts"],
      },
    },
    capabilities: ["pi-lens", "mcp"],
    models: { orchestrator: "openai/gpt", builder: "openai/gpt" },
    provider: "openai",
    policies: {
      commit: { value: "ask", strictness: 2 },
      read: { value: "ask", strictness: 2 },
    },
    workspaceRevision: "ws-1",
    ...over,
  };
}

test("identical inputs produce no drift", () => {
  const report = detectDrift(snapshot(), snapshot());
  assert.deepEqual(report.items, []);
  assert.equal(report.dispatchAllowed, true);
  assert.equal(report.pauseRequired, false);
  assert.equal(driftGate(report).allowed, true);
});

test("roadmap and plan edits pause for a new approval revision", () => {
  const roadmap = detectDrift(snapshot(), snapshot({ roadmapDigest: "roadmap-2" }));
  assert.equal(roadmap.items[0]!.kind, "roadmap_edit");
  assert.equal(roadmap.requiresApproval, true);
  assert.equal(roadmap.blocksAcceptedEvidence, true);
  assert.equal(driftGate(roadmap).pause, true);

  const plan = detectDrift(snapshot(), snapshot({ planRevision: 2 }));
  assert.equal(plan.items[0]!.kind, "plan_edit");
  assert.equal(driftGate(plan).requiresApproval, true);
});

test("scope, criteria, dependencies and expected files are compared", () => {
  const criteria = detectDrift(
    snapshot(),
    snapshot({
      tasks: {
        "task-t1": {
          covers: ["step-r1"],
          acceptanceChecks: ["tests", "manual"],
          dependsOn: [],
          expectedFiles: ["src/a.ts"],
        },
      },
    }),
  );
  assert.equal(criteria.items[0]!.kind, "criteria_change");
  assert.equal(criteria.items[0]!.severity, "critical");
  assert.equal(criteria.blocksAcceptedEvidence, true);

  const dependency = detectDrift(
    snapshot(),
    snapshot({
      tasks: {
        "task-t1": {
          covers: ["step-r1"],
          acceptanceChecks: ["tests"],
          dependsOn: ["task-t0"],
          expectedFiles: ["src/a.ts"],
        },
      },
    }),
  );
  assert.equal(dependency.items[0]!.kind, "dependency_change");
  assert.equal(dependency.requiresApproval, true);

  const added = detectDrift(
    snapshot(),
    snapshot({
      tasks: {
        ...snapshot().tasks,
        "task-t2": {
          covers: ["step-r2"],
          acceptanceChecks: ["tests"],
          dependsOn: ["task-t1"],
          expectedFiles: ["src/b.ts"],
        },
      },
    }),
  );
  assert.equal(added.items[0]!.kind, "scope_change");
  assert.equal(added.items[0]!.taskId, "task-t2");
});

test("a lost capability is critical; an added one is informational", () => {
  const lost = detectDrift(snapshot(), snapshot({ capabilities: ["pi-lens"] }));
  assert.equal(lost.items[0]!.severity, "critical");
  assert.equal(lost.requiresApproval, true);
  assert.match(lost.items[0]!.detail, /missing: mcp/);

  const gained = detectDrift(snapshot(), snapshot({ capabilities: ["pi-lens", "mcp", "skill-x"] }));
  assert.equal(gained.items[0]!.severity, "info");
  assert.equal(gained.dispatchAllowed, true);
  assert.equal(gained.requiresApproval, false);
});

test("a model or provider change pauses before mutation", () => {
  const model = detectDrift(snapshot(), snapshot({ models: { orchestrator: "openai/gpt", builder: "other/model" } }));
  assert.equal(model.items[0]!.kind, "model_change");
  assert.equal(model.dispatchAllowed, false);

  const provider = detectDrift(snapshot(), snapshot({ provider: "anthropic" }));
  assert.equal(provider.items[0]!.kind, "model_change");
  assert.equal(driftGate(provider).pause, true);
});

test("policy narrowing applies immediately while widening is never automatic", () => {
  const narrowed = detectDrift(
    snapshot(),
    snapshot({
      policies: {
        commit: { value: "never", strictness: 3 },
        read: { value: "ask", strictness: 2 },
      },
    }),
  );
  assert.equal(narrowed.items[0]!.kind, "policy_narrowed");
  assert.equal(narrowed.items[0]!.requiresApproval, false);
  assert.equal(narrowed.dispatchAllowed, true);
  assert.equal(narrowed.policyNarrowingImmediate, true);

  const widened = detectDrift(
    snapshot(),
    snapshot({
      policies: {
        commit: { value: "allow", strictness: 1 },
        read: { value: "ask", strictness: 2 },
      },
    }),
  );
  assert.equal(widened.items[0]!.kind, "policy_widened");
  assert.equal(widened.items[0]!.severity, "critical");
  assert.equal(widened.items[0]!.requiresApproval, true);
  assert.equal(widened.items[0]!.autoWidening, false);
  assert.equal(widened.dispatchAllowed, false);

  const removed = detectDrift(
    snapshot(),
    snapshot({ policies: { read: { value: "ask", strictness: 2 } } }),
  );
  assert.equal(removed.items[0]!.kind, "policy_widened");
  assert.equal(removed.requiresApproval, true);
});

test("an external workspace change requires re-inspection, not approval", () => {
  const report = detectDrift(snapshot(), snapshot({ workspaceRevision: "ws-2" }));
  assert.equal(report.items[0]!.kind, "workspace_external");
  assert.equal(report.pauseRequired, true);
  assert.equal(report.requiresApproval, false);
  assert.equal(report.blocksAcceptedEvidence, false);
  const proposal = buildReconciliationProposal(report);
  assert.deepEqual(proposal.decisions, [{ action: "reinspect_workspace", kinds: ["workspace_external"] }]);
  assert.equal(proposal.wideningRequiresExplicitUserAction, true);
});

test("the proposal lists approval decisions and keeps widening explicit", () => {
  const report = detectDrift(
    snapshot(),
    snapshot({
      planDigest: "plan-2",
      tasks: {
        "task-t1": {
          covers: ["step-r1"],
          acceptanceChecks: ["tests", "extra"],
          dependsOn: [],
          expectedFiles: ["src/a.ts"],
        },
      },
    }),
  );
  const proposal = buildReconciliationProposal(report);
  assert.equal(proposal.requiresApproval, true);
  assert.equal(proposal.decisions.some((decision) => decision.action === "approve_revision"), true);
  assert.equal(proposal.items.some((entry) => entry.kind === "criteria_change"), true);
});
