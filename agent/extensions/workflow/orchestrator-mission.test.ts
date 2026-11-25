import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
  assert.match(text, /do not poll/i);
  assert.doesNotMatch(text, /frozen row/i);
  assert.doesNotMatch(text, /automatic acceptance/i);
  assert.doesNotMatch(text, /bounded repair/i);
  assert.doesNotMatch(text, /row checks/i);
});

test("the mission routes external and in-scope blockers separately", () => {
  const text = buildOrchestratorMission({ phase: "idle" });
  assert.match(text, /Status:/);
  assert.match(text, /Suggested:/);
  assert.match(text, /External \/ out of scope/i);
  assert.match(text, /do not re-dispatch/i);
  assert.match(text, /orchestrator_abort/);
  assert.match(text, /Internal \/ in scope/i);
  assert.match(text, /retry the SAME row with orchestrator_retry/i);
  assert.match(text, /amended `instructions`/);
  assert.match(text, /final message must list each row's outcome/i);
  assert.doesNotMatch(text, /mark it done"\s*,\s*"If it is blocked/i);
});

test("the mission teaches the canonical Orchestrator grammar", () => {
  const text = buildOrchestratorMission({ phase: "paused" });
  assert.match(
    text,
    /\/orchestrator pause, resume, abort, view, inspect\./,
  );
  assert.match(text, /\/orchestrator resume continues a warm paused child/);
  assert.doesNotMatch(
    text,
    /\/orchestrator-(?:pause|resume|abort|view)\b/,
  );
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
  assert.equal(ORCHESTRATOR_MISSION_VERSION, 5);
  assert.match(
    buildOrchestratorMission({ phase: "unbound" }),
    /mission v5/,
  );
});

test("the mission states how review notes are carried and reported", () => {
  const text = buildOrchestratorMission({ phase: "idle" });
  assert.match(text, /Review notes \(advisory\):/);
  assert.match(text, /attaches each row's review notes to that row's child kickoff/i);
  assert.match(text, /Do not drop them/i);
  assert.match(text, /advisory/i);
  assert.match(text, /approved plan wins on any conflict/i);
  assert.match(text, /never a requirement, a gate or an acceptance criterion/i);
  assert.match(text, /conflicts with the plan/);
  assert.match(text, /with the row ref and the child's reason/i);
});

test("unbound review notes render with ids and step refs, capped", () => {
  const long = "x".repeat(600);
  const text = buildOrchestratorMission({
    phase: "running",
    unboundReviewNotes: [
      { id: "R2", step: "3", change: "tighten the retry guard" },
      { id: "R4", change: "name the seam" },
      { id: "R9", step: "7", change: long },
    ],
  });
  assert.match(text, /Unbound review notes \(place them yourself\):/);
  assert.match(text, /- R2 · Step 3: tighten the retry guard/);
  assert.match(text, /- R4: name the seam/);
  const cappedLine = text
    .split("\n")
    .find((line) => line.startsWith("- R9 · Step 7:"));
  assert.ok(cappedLine, "the R9 line is rendered");
  assert.match(cappedLine, /…$/);
  assert.ok(
    cappedLine.length <= 230,
    `long note change is capped, got ${cappedLine.length} chars`,
  );
  assert.match(text, /Decide which row each one belongs to/i);
  assert.match(text, /approved plan still wins on any conflict/i);
});

test("no unbound notes means no unbound section", () => {
  assert.doesNotMatch(
    buildOrchestratorMission({ phase: "idle" }),
    /Unbound review notes/,
  );
  assert.doesNotMatch(
    buildOrchestratorMission({ phase: "idle", unboundReviewNotes: [] }),
    /Unbound review notes/,
  );
});

test("the mission builder stays pure: no I/O, no run lookup", () => {
  const source = readFileSync(new URL("./orchestrator-mission.ts", import.meta.url), "utf8");
  const imports = source.match(/^import .*$/gm) ?? [];
  assert.deepEqual(imports, [
    'import type { OrchestratorRunPhase } from "./orchestrator-run.ts";',
  ]);
  assert.doesNotMatch(source, /readFileSync|fs\.promises|node:fs|orchestratorRun\b/);
});
