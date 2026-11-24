import assert from "node:assert/strict";
import test from "node:test";

import {
  ORCHESTRATOR_MISSION_VERSION,
  buildOrchestratorMission,
} from "./orchestrator-mission.ts";

test("the mission names every declared workspace root", () => {
  const text = buildOrchestratorMission({
    phase: "unbound",
    workspaces: "W=C:/work/W (primary) · D=C:/work/D",
  });
  assert.match(text, /Workspace roots: W=C:\/work\/W/);
  assert.match(text, /D=C:\/work\/D/);
});

test("the mission remains valid without a multi-root set", () => {
  const text = buildOrchestratorMission({ phase: "unbound" });
  assert.doesNotMatch(text, /Workspace roots:/);
  assert.match(text, /orchestrator_start/);
});

test("the mission describes the dispatcher contract, not the frozen engine", () => {
  const text = buildOrchestratorMission({ phase: "idle" });
  assert.match(text, /one row is one repository root/i);
  assert.match(text, /orchestrator_dispatch/);
  assert.match(text, /trust the child's report/i);
  assert.match(text, /## Verification/);
  assert.match(text, /Never edit the plan file/);
  assert.doesNotMatch(text, /frozen row/i);
  assert.doesNotMatch(text, /automatic acceptance/i);
  assert.doesNotMatch(text, /bounded repair/i);
  assert.doesNotMatch(text, /row checks/i);
});

test("row counts are done/total, never accepted", () => {
  const text = buildOrchestratorMission({
    phase: "running",
    runId: "run-1",
    taskCounts: { done: 2, total: 5 },
  });
  assert.match(text, /2\/5 rows done/);
  assert.doesNotMatch(text, /accepted/i);
});

test("every run phase has a next action, and unbound stays available", () => {
  for (const phase of ["interrupted", "cancelled", "paused", "completed"] as const) {
    const text = buildOrchestratorMission({ phase });
    assert.match(text, /Next action:/, phase);
    assert.doesNotMatch(text, /verify and accept|automatically/i, phase);
  }
  assert.match(
    buildOrchestratorMission({ phase: "unbound" }),
    /orchestrator_start/,
  );
});

test("the mission version is bumped for the contract change", () => {
  assert.equal(ORCHESTRATOR_MISSION_VERSION, 3);
  assert.match(
    buildOrchestratorMission({ phase: "unbound" }),
    /mission v3/,
  );
});
