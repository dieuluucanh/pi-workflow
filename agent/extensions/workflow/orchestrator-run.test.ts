import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createOrchestratorRun,
  markRunInterrupted,
  nextPendingRow,
  recordAbort,
  recordDispatch,
  recordDispatchIfNotReported,
  recordFailure,
  recordReport,
  restoreOrchestratorRun,
  setRunPhase,
  workspaceForRow,
} from "./orchestrator-run.ts";
import type { OrchestratorRunWorkspace } from "./orchestrator-run.ts";

const WORKSPACES: OrchestratorRunWorkspace[] = [
  {
    id: "W",
    root: "C:/repo/main",
    kind: "git",
    displayPath: ".",
    primary: true,
  },
  {
    id: "B",
    root: "C:/repo/other",
    kind: "git",
    displayPath: "C:/repo/other",
    primary: false,
  },
];

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

test("run: a report that lands during dispatch admission is never overwritten", () => {
  const created = createOrchestratorRun({ title: "race", steps: ["one", "two"], now: 1 });
  const dispatched = recordDispatch(created, {
    rowRef: "1",
    instruction: "first instruction",
  });
  const reported = recordReport(dispatched, {
    rowRef: "1",
    report: "Status: settled\nreal report",
    now: 100,
  });

  // Admission started before the report landed: the settle wins.
  const late = recordDispatchIfNotReported(reported, {
    rowRef: "1",
    instruction: "second instruction",
    startedAt: 90,
  });
  assert.equal(late.recorded, false);
  assert.equal(late.run.phase, "idle");
  assert.equal(late.run.rows[0]?.lastReport, "Status: settled\nreal report");
  assert.equal(late.run.rows[0]?.instruction, "first instruction");

  // A retry admitted after the report records normally and keeps the report.
  const retry = recordDispatchIfNotReported(reported, {
    rowRef: "1",
    instruction: "third instruction",
    startedAt: 200,
  });
  assert.equal(retry.recorded, true);
  assert.equal(retry.run.phase, "running");
  assert.equal(retry.run.rows[0]?.instruction, "third instruction");
  assert.equal(retry.run.rows[0]?.lastReport, "Status: settled\nreal report");
});

test("run: abort preserves a real report and records why it stopped", () => {
  const created = createOrchestratorRun({ title: "abort", steps: ["one"], now: 1 });
  const dispatched = recordDispatch(created, { rowRef: "1", instruction: "go" });
  const reported = recordReport(dispatched, { rowRef: "1", report: "real", now: 50 });

  const aborted = recordAbort(reported, {
    rowRef: "1",
    report: "Status: aborted — stuck",
    reason: "the child is stuck",
    now: 60,
  });
  assert.equal(aborted.phase, "paused");
  assert.equal(aborted.blockedReason, "Aborted: the child is stuck");
  assert.equal(aborted.rows[0]?.lastReport, "real", "the settle report survives");
  assert.equal(aborted.rows[0]?.lastReportAt, 50);

  const withoutReport = recordAbort(dispatched, {
    rowRef: "1",
    report: "Status: aborted — stuck",
    reason: "the child is stuck",
    now: 60,
  });
  assert.equal(withoutReport.rows[0]?.lastReport, "Status: aborted — stuck");
  assert.equal(withoutReport.rows[0]?.lastReportAt, 60);
});

test("run: a failure is interrupted, named and retryable", () => {
  const created = createOrchestratorRun({ title: "failure", steps: ["one", "two"], now: 1 });
  const dispatched = recordDispatch(created, { rowRef: "1", instruction: "go" });
  const failed = recordFailure(dispatched, {
    rowRef: "1",
    report: "Status: failed — provider down",
    reason: "provider down",
    now: 70,
  });
  assert.equal(failed.phase, "interrupted");
  assert.equal(failed.blockedReason, "provider down");
  assert.equal(failed.rows[0]?.lastReport, "Status: failed — provider down");
  assert.equal(failed.rows[0]?.lastReportAt, 70);

  const paused = setRunPhase(failed, "paused");
  assert.equal(paused.phase, "paused");
  assert.equal(
    paused.blockedReason,
    "provider down",
    "the operator's paused transition keeps the reason",
  );
  assert.equal(
    setRunPhase(failed, "running").blockedReason,
    undefined,
    "a new dispatch clears the reason",
  );
  assert.deepEqual(
    restoreOrchestratorRun(JSON.parse(JSON.stringify(paused))),
    paused,
    "the paused reason survives a reload",
  );
});

test("run: a corrupt or foreign record is ignored, never half-restored", () => {
  assert.equal(restoreOrchestratorRun(undefined), undefined);
  assert.equal(restoreOrchestratorRun({ schemaVersion: 99 }), undefined);
  assert.equal(restoreOrchestratorRun({ schemaVersion: 1, runId: "x", rows: [] }), undefined);
});

test("run: workspaces default a bare step to the primary root and round-trip", () => {
  const run = createOrchestratorRun({
    title: "Two repos",
    workspaces: WORKSPACES,
    steps: [
      "Root step",
      { text: "Other repo step", workspace: "B" },
      { text: "Explicit primary", workspace: "W" },
    ],
  });
  assert.deepEqual(run.workspaces, WORKSPACES);
  assert.deepEqual(
    run.rows.map((row) => [row.workspaceId, row.cwd]),
    [
      ["W", "C:/repo/main"],
      ["B", "C:/repo/other"],
      ["W", "C:/repo/main"],
    ],
  );
  assert.equal(workspaceForRow(run, run.rows[1])?.root, "C:/repo/other");
  assert.deepEqual(restoreOrchestratorRun(JSON.parse(JSON.stringify(run))), run);
});

test("run: an undeclared step workspace is refused, with or without a set", () => {
  assert.throws(
    () =>
      createOrchestratorRun({
        title: "Bad",
        workspaces: WORKSPACES,
        steps: [{ text: "Nope", workspace: "Z" }],
      }),
    /Unknown workspace "Z" on step 1; declared workspaces: W, B\./,
  );
  assert.throws(
    () =>
      createOrchestratorRun({
        title: "No set",
        steps: [{ text: "Nope", workspace: "W" }],
      }),
    /Unknown workspace "W" on step 1; declared workspaces: none declared\./,
  );
});

test("run: dispatch records the row workspace and cwd, clearing the blocked reason", () => {
  const run = createOrchestratorRun({
    title: "Two repos",
    workspaces: WORKSPACES,
    steps: ["Root step", { text: "Other repo step", workspace: "B" }],
  });
  const blocked = markRunInterrupted(run, { reason: "child crashed", now: 42 });
  assert.equal(blocked.phase, "interrupted");
  assert.equal(blocked.blockedReason, "child crashed");
  assert.equal(blocked.updatedAt, 42);

  const dispatched = recordDispatch(blocked, {
    rowRef: "2",
    instruction: "Re-run it.",
    cwd: "C:/repo/other",
    workspaceId: "B",
  });
  assert.equal(dispatched.phase, "running");
  assert.equal(dispatched.blockedReason, undefined);
  assert.equal(dispatched.rows[1]?.workspaceId, "B");
  assert.equal(dispatched.rows[1]?.cwd, "C:/repo/other");
});

test("run: interrupted, cancelled and paused phases survive a restore", () => {
  const run = createOrchestratorRun({ title: "Phases", steps: ["Only step"] });
  const interrupted = markRunInterrupted(run);
  assert.match(interrupted.blockedReason ?? "", /did not survive the reload/);

  for (const phase of ["interrupted", "cancelled", "paused"] as const) {
    const phased = setRunPhase(interrupted, phase);
    const restored = restoreOrchestratorRun(JSON.parse(JSON.stringify(phased)));
    assert.equal(restored?.phase, phase);
  }
  assert.equal(restoreOrchestratorRun({ ...JSON.parse(JSON.stringify(interrupted)) })?.phase, "interrupted");
  const cancelledFromIdle = restoreOrchestratorRun({
    schemaVersion: 1,
    runId: "run-x",
    title: "x",
    phase: "cancelled",
    rows: [{ ref: "1", text: "One" }],
  });
  assert.equal(cancelledFromIdle?.phase, "cancelled", "a reload must not revive a cancelled run as idle");
});

test("run: an old v1 record without workspaces still restores", () => {
  const restored = restoreOrchestratorRun({
    schemaVersion: 1,
    runId: "run-old",
    title: "Old run",
    phase: "running",
    rows: [{ ref: "1", text: "One", instruction: "Go", lastReport: "Done", lastReportAt: 7 }],
    createdAt: 1,
    updatedAt: 2,
  });
  assert.deepEqual(restored?.rows, [
    { ref: "1", text: "One", instruction: "Go", lastReport: "Done", lastReportAt: 7 },
  ]);
  assert.equal(restored?.workspaces, undefined);
});

test("run: a corrupt workspace entry is dropped, not half-restored", () => {
  const restored = restoreOrchestratorRun({
    schemaVersion: 1,
    runId: "run-ws",
    title: "Broken set",
    phase: "idle",
    workspaces: [
      { id: "W", root: "C:/repo/main", kind: "git", primary: true },
      { id: "", root: "C:/repo/broken" },
      { id: "B", root: "   " },
      { id: "W", root: "C:/repo/duplicate", kind: "git" },
      "not-an-object",
    ],
    rows: [{ ref: "1", text: "One", workspaceId: "B", cwd: "C:/repo/ghost" }],
  });
  assert.equal(
    restored?.workspaces?.length,
    1,
    "invalid and duplicate entries are dropped, never half-restored",
  );
  assert.equal(restored?.workspaces?.[0]?.id, "W");
  assert.equal(
    restored?.rows[0]?.workspaceId,
    undefined,
    "a row reference to a dropped workspace is not kept",
  );
});
