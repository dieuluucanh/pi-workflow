import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createOrchestratorRun,
  nextPendingRow,
  recordDispatch,
  recordReport,
  restoreOrchestratorRun,
  setRunPhase,
} from "./orchestrator-run.ts";

test("run: steps become stable rows and a dispatch/report round-trips", () => {
  const run = createOrchestratorRun({
    title: "Simplify orchestrator",
    planPath: ".pi/plans/x.md",
    steps: ["  First step  ", "Second step", "", "Third step"],
    now: 1_700_000_000_000,
  });
  assert.deepEqual(
    run.rows.map((row) => row.ref),
    ["1", "2", "3"],
  );
  assert.deepEqual(
    run.rows.map((row) => row.text),
    ["First step", "Second step", "Third step"],
  );
  assert.equal(run.phase, "idle");
  assert.equal(run.planPath, ".pi/plans/x.md");

  const dispatched = recordDispatch(run, {
    rowRef: "2",
    instruction: "Implement the second step.",
    childSessionId: "child-2",
  });
  assert.equal(dispatched.phase, "running");
  assert.equal(dispatched.currentRef, "2");
  assert.equal(dispatched.rows[1]?.instruction, "Implement the second step.");

  const reported = recordReport(dispatched, {
    rowRef: "2",
    report: "Done. Tests pass.",
    now: 1_700_000_000_500,
  });
  assert.equal(reported.phase, "idle");
  assert.equal(reported.rows[1]?.lastReport, "Done. Tests pass.");

  assert.equal(
    nextPendingRow(reported, (ref) => ref === "1")?.ref,
    "2",
    "the parent decides completion through the TODO list",
  );

  const restored = restoreOrchestratorRun(JSON.parse(JSON.stringify(reported)));
  assert.deepEqual(restored, reported);
  assert.equal(setRunPhase(reported, "completed").phase, "completed");
});

test("run: a corrupt or foreign record is ignored, never half-restored", () => {
  assert.equal(restoreOrchestratorRun(undefined), undefined);
  assert.equal(restoreOrchestratorRun({ schemaVersion: 99 }), undefined);
  assert.equal(restoreOrchestratorRun({ schemaVersion: 1, runId: "x", rows: [] }), undefined);
});
