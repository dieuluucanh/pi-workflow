/**
 * End-to-end plan-execution contract test (v2 step 18).
 *
 * One run walks the whole lifecycle through the real modules, with no fake
 * classes standing in for the contract itself:
 *
 *   plan lint -> freeze (v2) -> execute row checks -> execute the final gate
 *   -> amend a malformed check list -> restore from the frozen artifact
 *   -> complete with a matching final-gate marker.
 *
 * It also pins the two rules that are easy to regress:
 *   - the final gate runs once per spec hash across two call paths,
 *   - an amendment that changes the check list invalidates the old marker,
 *   - accepted rows survive an amendment and a restore unchanged.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { formatPlanPreview, lintPlan, planFreezeGate } from "./plan-lint.ts";
import { createFrozenTodosFromPlan } from "./todo-snapshot.ts";
import {
  createCheckExecutor,
  type CheckTransport,
  type CheckTransportRequest,
} from "./check-executor.ts";
import {
  buildFinalGatePayload,
  computeFinalGateSpecHash,
  finalGateCheckSpecs,
  finalGateSatisfied,
  findFinalGateRecord,
  type FinalGatePayload,
} from "./final-gate.ts";
import {
  applyCheckSpecRepair,
  buildCheckSpecRepair,
  checkSpecRepairEventId,
} from "./orchestrator-check-repair.ts";
import { readFrozenSnapshot } from "./frozen-snapshot.ts";
import type { WorkspaceSet } from "./orchestrator-workspace-set.ts";
import type { FrozenTodoSnapshot } from "./todo-snapshot.ts";

const WORKSPACE_SET: WorkspaceSet = {
  schemaVersion: 1,
  primaryId: "W",
  roots: [
    {
      id: "W",
      key: "plain:C:/work",
      root: "C:/work",
      kind: "plain",
      displayPath: "C:/work",
      primary: true,
    },
  ],
};

const PLAN = [
  "# Plan: End-to-end",
  "",
  "## Plan Steps",
  "",
  "1. Add the module",
  "   Checks:",
  "   - `npm test`",
  "   Acceptance: the module is documented",
  "   Files: src/module.ts",
  "   Workspaces: W",
  "",
  "2. Wire it up",
  "",
  "## Verification",
  "",
  "```bash",
  "npm run typecheck",
  "npm run lint",
  "```",
  "",
].join("\n");

interface RecordingTransport extends CheckTransport {
  commands: string[];
  timeouts: number[];
}

function recordingTransport(fail?: (command: string) => boolean): RecordingTransport {
  const commands: string[] = [];
  const timeouts: number[] = [];
  return {
    kind: "host",
    commands,
    timeouts,
    async run(request: CheckTransportRequest) {
      commands.push(request.command);
      timeouts.push(request.timeoutSeconds);
      if (fail?.(request.command) === true) {
        return { ok: false, exitCode: 1, output: "boom" };
      }
      return { ok: true, exitCode: 0, output: "ok" };
    },
  };
}

function executor(transport: CheckTransport) {
  return createCheckExecutor({
    transport,
    workspaceSet: () => WORKSPACE_SET,
    limits: () => ({ maxTimeoutSeconds: 120 }),
    now: () => 1_000,
  });
}

interface GateRun {
  specHash: string;
  payload?: FinalGatePayload;
  runs: number;
}

/**
 * The single final-gate entry point both call paths (advance and Build
 * completion) must use: run only when no passing marker exists for the hash.
 */
async function ensureFinalGate(
  events: Array<{ type: string; payload: unknown }>,
  snapshot: FrozenTodoSnapshot,
  transport: CheckTransport,
  state: GateRun,
): Promise<FinalGatePayload> {
  const checks = finalGateCheckSpecs(snapshot);
  const specHash = computeFinalGateSpecHash({
    checks,
    workspaces: snapshot.workspaces,
    set: WORKSPACE_SET,
  });
  state.specHash = specHash;
  const existing = findFinalGateRecord(events, specHash);
  if (existing?.ok === true) return existing;

  state.runs += 1;
  const outcome = await executor(transport).executeMany(checks);
  const payload = buildFinalGatePayload({
    specHash,
    ok: outcome.ok,
    checkedAt: 1_000 + state.runs,
    results: outcome.results,
    workspaceRevisions: { W: "rev-1" },
    ...(outcome.ok ? {} : { failureClass: "test", failure: "final gate failed" }),
  });
  events.push({ type: "final_gate", payload });
  state.payload = payload;
  return payload;
}

test("lint -> freeze -> row checks -> final gate -> amend -> restore -> complete", async () => {
  // 1. Plan lint accepts the plan and reports its gates before freeze.
  const lint = lintPlan(PLAN, { path: "C:/work/.pi/plans/e2e.md", workspaces: WORKSPACE_SET.roots });
  assert.equal(lint.ok, true, lint.ok ? "" : lint.error);
  assert.equal(lint.assessment.gate, 2);
  assert.equal(lint.assessment.rowChecks, 1);
  assert.equal(lint.assessment.needsAcknowledgement, false);
  const preview = formatPlanPreview(lint);
  assert.match(preview, /npm run typecheck/);
  const gate = planFreezeGate(lint);
  assert.equal(gate.ok, true, gate.ok ? "" : gate.error);

  // 2. Freeze writes a v2 artifact plus the v1 projection consumers use.
  const built = createFrozenTodosFromPlan({
    planPath: "C:/work/.pi/plans/e2e.md",
    planText: PLAN,
    mode: "orchestrator",
    workspaces: WORKSPACE_SET.roots,
    executionId: "todo-exec-e2e",
    now: 1_000,
  });
  assert.equal(built.ok, true, built.ok ? "" : built.error);
  if (!built.ok) return;
  assert.ok(built.execution);
  const snapshot = built.snapshot;
  assert.deepEqual(snapshot.planChecks, ["npm run typecheck", "npm run lint"]);

  // Accept the first row before the final gate, exactly like the run loop.
  const acceptedRows = snapshot.rows.map((row, index) => ({
    ...row,
    status: index === 0 ? ("completed" as const) : row.status,
  }));
  snapshot.rows = acceptedRows;
  const acceptedBefore = acceptedRows.filter((row) => row.status === "completed").length;
  assert.equal(acceptedBefore, 1);

  // 3. Execute the row checks through the single executor.
  const rowTransport = recordingTransport();
  const rowChecks = built.execution!.rows[0]!.checks;
  const rowRun = await executor(rowTransport).executeMany(rowChecks);
  assert.equal(rowRun.ok, true);
  assert.deepEqual(rowTransport.commands, ["npm test"]);
  assert.equal(rowRun.results[0]!.workspaceRoot, "C:/work");

  // 4. Execute the final gate once.
  const events: Array<{ type: string; payload: unknown }> = [];
  const gateTransport = recordingTransport();
  const run: GateRun = { specHash: "", runs: 0 };
  const first = await ensureFinalGate(events, snapshot, gateTransport, run);
  assert.equal(first.ok, true);
  assert.deepEqual(gateTransport.commands, ["npm run typecheck", "npm run lint"]);
  assert.equal(finalGateSatisfied(events, run.specHash), true);

  // 4b. A second call path must reuse the marker, not re-run the checks.
  const second = await ensureFinalGate(events, snapshot, gateTransport, run);
  assert.deepEqual(second, first);
  assert.equal(run.runs, 1, "the final gate ran twice for the same spec hash");
  assert.deepEqual(gateTransport.commands, ["npm run typecheck", "npm run lint"]);
  assert.equal(
    events.filter((event) => event.type === "final_gate").length,
    1,
    "a duplicate final_gate marker was journaled",
  );

  // 5. Amend the executable list; rows/statuses must not move.
  const amended = buildCheckSpecRepair({
    executionId: snapshot.executionId,
    snapshot,
    specs: [
      { command: "npm run typecheck -- --pretty false", kind: "gate" },
      { command: "npm run lint", kind: "gate" },
    ] as never,
    reason: "Pin the typecheck output for the final gate.",
    source: "e2e test",
    approvedAt: 2_000,
  });
  assert.equal(amended.ok, true, amended.ok ? "" : amended.error);
  if (!amended.ok) return;
  const amendedSnapshot = applyCheckSpecRepair(snapshot, amended.value);
  assert.equal(amendedSnapshot.ok, true, amendedSnapshot.ok ? "" : amendedSnapshot.error);
  if (!amendedSnapshot.ok) return;
  assert.equal(amendedSnapshot.value.changed, true);
  assert.deepEqual(amendedSnapshot.value.snapshot.rows, acceptedRows);
  assert.equal(
    amendedSnapshot.value.snapshot.rows.filter((row) => row.status === "completed").length,
    acceptedBefore,
    "an amendment must not drop accepted rows",
  );

  // 6. The amended spec hash is different, so the old marker no longer counts.
  const amendedChecks = finalGateCheckSpecs(amendedSnapshot.value.snapshot);
  const amendedHash = computeFinalGateSpecHash({
    checks: amendedChecks,
    workspaces: amendedSnapshot.value.snapshot.workspaces,
    set: WORKSPACE_SET,
  });
  assert.notEqual(amendedHash, run.specHash);
  assert.equal(finalGateSatisfied(events, amendedHash), false);

  const amendedTransport = recordingTransport();
  const amendedRun: GateRun = { specHash: "", runs: 0 };
  const third = await ensureFinalGate(
    events,
    amendedSnapshot.value.snapshot,
    amendedTransport,
    amendedRun,
  );
  assert.equal(third.ok, true);
  assert.equal(amendedRun.runs, 1);
  assert.equal(finalGateSatisfied(events, amendedHash), true);
  assert.equal(checkSpecRepairEventId(amended.value).startsWith("repair-"), true);

  // 7. Restore reads the frozen artifact back unchanged (no re-freeze).
  const restored = readFrozenSnapshot(built.execution);
  assert.equal(restored.ok, true, restored.ok ? "" : restored.error);
  if (!restored.ok) return;
  assert.deepEqual(restored.snapshot, built.execution);
  assert.deepEqual(
    restored.snapshot.rows.map((row) => row.ref),
    snapshot.rows.map((row) => row.ref),
  );

  // 8. A replay of the amendment is idempotent and completion is now allowed.
  const replay = applyCheckSpecRepair(amendedSnapshot.value.snapshot, amended.value);
  assert.equal(replay.ok, true);
  if (!replay.ok) return;
  assert.equal(replay.value.changed, false);
  assert.equal(
    finalGateSatisfied(events, amendedHash),
    true,
    "completion requires a passing final gate for the current spec",
  );
  assert.equal(
    replay.value.snapshot.rows.filter((row) => row.status === "completed").length,
    acceptedBefore,
  );
});

test("a failing row check is classified repairable; a metadata failure is not", async () => {
  const built = createFrozenTodosFromPlan({
    planPath: "C:/work/.pi/plans/e2e.md",
    planText: PLAN,
    mode: "orchestrator",
    workspaces: WORKSPACE_SET.roots,
    executionId: "todo-exec-e2e-fail",
    now: 1_000,
  });
  assert.equal(built.ok, true);
  if (!built.ok) return;

  const failing = recordingTransport((command) => command === "npm test");
  const result = await executor(failing).executeMany(built.execution!.rows[0]!.checks);
  assert.equal(result.ok, false);
  assert.equal(result.results[0]!.failureClass, "test");
  assert.equal(result.results[0]!.repairable, true);

  // A prose acceptance criterion is metadata, never a shell command.
  const metadata = await executor(recordingTransport()).execute({
    id: "prose",
    command: "the module is documented",
    kind: "gate",
  });
  assert.equal(metadata.ok, false);
  assert.equal(metadata.failureClass, "metadata");
  assert.equal(metadata.repairable, false);
});

test("the final gate cannot complete without a marker for the current spec", () => {
  assert.equal(finalGateSatisfied([], "a".repeat(64)), false);
  const failed = buildFinalGatePayload({
    specHash: "b".repeat(64),
    ok: false,
    checkedAt: 1,
    failureClass: "test",
    failure: "failed",
  });
  assert.equal(finalGateSatisfied([{ type: "final_gate", payload: failed }], "b".repeat(64)), false);
});
