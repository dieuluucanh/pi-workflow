/**
 * Self-tests for the autonomy reproductions and boundary harness.
 *
 * These do not assert the new runtime behavior yet; they pin that the synthetic
 * fixtures are safe and that the fake host can compose Pi's real boundary
 * chaining (entries + continue) instead of merely recording sends.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  CHECKLESS_STANDALONE_ROW,
  EXACT_CHECK_PAYLOAD,
  GREP_STATUS_MISMATCH,
  HISTORICAL_22_STEP_PLAN,
  MISSING_PLAN_RESUME,
  OUT_OF_ORDER_COMPLETION,
  OVERFLOW_CHECKS,
  PREMATURE_FINAL_ANSWER,
  SHELL_QUARANTINE_WORK_SCRIPT,
  TWO_TIMEOUT_SEQUENCE,
  driveBoundaryTurns,
  makeFakeCtx,
  makeFakePi,
  runBoundary,
  tmpProject,
} from "./test-support.ts";

test("fixtures: the historical shape is synthetic and complete", () => {
  const planLines = HISTORICAL_22_STEP_PLAN.split("\n");
  const first = planLines.indexOf("## Plan Steps");
  const verification = planLines.indexOf("## Verification");
  assert.ok(first >= 0);
  assert.ok(verification > first);
  const steps = planLines.slice(first + 1, verification).filter(Boolean);
  assert.equal(steps.length, 22);
  assert.match(steps[0]!, /^1\. Implement synthetic step 1/);
  assert.match(steps[21]!, /^22\. Implement synthetic step 22/);
  assert.doesNotMatch(HISTORICAL_22_STEP_PLAN, /C:\\Users|sessions\\|api[_-]?key/i);
});

test("fixtures: timeouts, quarantine work, and exact check bytes are explicit", () => {
  assert.equal(TWO_TIMEOUT_SEQUENCE.length, 2);
  assert.notEqual(
    TWO_TIMEOUT_SEQUENCE[0].command,
    TWO_TIMEOUT_SEQUENCE[1].command,
  );
  assert.deepEqual(
    SHELL_QUARANTINE_WORK_SCRIPT.slice(0, 2).map((entry) => entry.kind),
    ["bash", "bash"],
  );
  assert.ok(
    SHELL_QUARANTINE_WORK_SCRIPT.slice(2).some(
      (entry) => entry.kind === "edit" || entry.kind === "lsp",
    ),
  );
  assert.match(EXACT_CHECK_PAYLOAD, /;/);
  assert.match(EXACT_CHECK_PAYLOAD, /"/);
  assert.equal(CHECKLESS_STANDALONE_ROW.acceptanceChecks.length, 0);
  assert.equal("planStepId" in CHECKLESS_STANDALONE_ROW, false);
  assert.equal(GREP_STATUS_MISMATCH.pipelineExitCode, 1);
  assert.equal(PREMATURE_FINAL_ANSWER.stopReason, "stop");
  assert.equal(MISSING_PLAN_RESUME.fullRowCount, 22);
  assert.equal(MISSING_PLAN_RESUME.remainingRefs.length, 9);
  assert.ok(OUT_OF_ORDER_COMPLETION.pendingRefs.includes("9"));
  assert.ok(OUT_OF_ORDER_COMPLETION.completedRefs.includes("14"));
  assert.equal(OVERFLOW_CHECKS.length, 13);
});

test("boundary harness chains entries and continuation like Pi", async () => {
  const { cwd } = tmpProject();
  const pi = makeFakePi();
  const fake = makeFakeCtx({ cwd });
  pi.on("agent_before_settle", (event: any) => ({
    entries: [
      ...event.entries,
      {
        type: "custom_message",
        customType: "test-nudge",
        content: "continue",
        display: false,
      },
    ],
    continue: true,
  }));
  pi.on("agent_before_settle", (event: any) => {
    assert.equal(event.entries.length, 1);
    assert.equal(event.continue, true);
    return { continue: false };
  });

  const result = await runBoundary(pi, fake.ctx, { outcome: "completed" });
  assert.equal(result.entries.length, 1);
  assert.equal(result.continue, false);
  assert.equal((result.results[1] as any).continue, false);
  assert.equal(fake.aborts(), 0);
});

test("boundary harness stops after a declined continuation", async () => {
  const { cwd } = tmpProject();
  const pi = makeFakePi();
  const fake = makeFakeCtx({ cwd });
  let calls = 0;
  pi.on("agent_before_settle", () => {
    calls += 1;
    return { continue: calls < 2 };
  });

  const turns = await driveBoundaryTurns(pi, fake.ctx, [
    { outcome: "completed" },
    { outcome: "completed" },
    { outcome: "completed" },
  ]);
  assert.equal(calls, 2);
  assert.equal(turns.length, 2);
  assert.equal(turns[0]!.continue, true);
  assert.equal(turns[1]!.continue, false);
  assert.equal(fake.aborts(), 0);
});

test("boundary harness preserves pending work and abort outcomes", async () => {
  const { cwd } = tmpProject();
  const pi = makeFakePi();
  const fake = makeFakeCtx({ cwd });
  let seen: any;
  pi.on("agent_before_settle", (event: any) => {
    seen = event;
    return { continue: false };
  });

  await runBoundary(pi, fake.ctx, {
    outcome: "aborted",
    pendingMessages: [{ role: "user", content: "queued" }],
  });
  assert.equal(seen.outcome, "aborted");
  assert.equal(seen.context.pendingMessages.length, 1);
  assert.equal(fake.aborts(), 0);
});
