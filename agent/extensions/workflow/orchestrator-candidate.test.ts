/**
 * Candidate/quiescence tests (step 29): a report proposes, the fence requires
 * settle + tool/queue drain, mutation is revoked before parent verification,
 * silent runs cannot succeed, and late reports need explicit resume.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  agentSettled,
  canAccept,
  canMutate,
  followUpEnded,
  followUpStarted,
  ingestWorkerReport,
  openCandidateFence,
  recordCheckpoint,
  resumeForRepair,
  toolEnded,
  toolStarted,
} from "./orchestrator-candidate.ts";

const context = { runId: "run-1", taskId: "task-1", attemptId: "attempt-1", sessionId: "session-1" };

function report(over: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    reportId: "report-1",
    ...context,
    outcome: "candidate",
    criteria: [{ roadmapStepId: "step-1", status: "met" }],
    changes: { files: ["src/a.ts"], summary: "implemented" },
    checks: [{ name: "tests", status: "passed" }],
    remaining: [],
    risks: [],
    artifacts: [],
    createdAt: 2,
    ...over,
  };
}

test("a report inside a parallel tool batch fences only after drain and settle", () => {
  let state = openCandidateFence();
  const started = toolStarted(state);
  assert.equal(started.ok, true);
  state = (started as any).value;

  const ingested = ingestWorkerReport(state, { raw: report(), context, now: 3 });
  assert.equal(ingested.ok, true);
  state = (ingested as any).value;
  assert.equal(state.phase, "report_received");
  assert.equal(canMutate(state), true);

  state = agentSettled(state, 4);
  assert.equal(state.phase, "report_received", "a tool is still in flight");
  assert.equal(canAccept(state).ok, false);

  state = toolEnded(state, 5);
  assert.equal(state.phase, "fenced");
  assert.equal(canMutate(state), false);
  assert.equal(canAccept(state).ok, true);

  const blocked = toolStarted(state);
  assert.equal(blocked.ok, false);
  assert.equal((blocked as any).code, "fenced");
});

test("a pending follow-up blocks the fence until it is consumed", () => {
  let state = openCandidateFence();
  state = (followUpStarted(state) as any).value;
  state = (ingestWorkerReport(state, { raw: report(), context, now: 2 }) as any).value;
  state = agentSettled(state, 3);
  assert.equal(state.phase, "report_received");
  state = followUpEnded(state, 4);
  assert.equal(state.phase, "fenced");
});

test("a silent settle fences without a candidate and cannot succeed", () => {
  const state = agentSettled(openCandidateFence(), 2);
  assert.equal(state.phase, "fenced");
  assert.equal(state.candidate, undefined);
  assert.match(state.reason ?? "", /without a report/);
  const eligibility = canAccept(state);
  assert.equal(eligibility.ok, false);
  assert.ok(eligibility.reasons.some((reason) => /no candidate/.test(reason)));
});

test("a late report is refused until an explicit parent resume", () => {
  let state = (ingestWorkerReport(openCandidateFence(), { raw: report(), context, now: 2 }) as any).value;
  state = agentSettled(state, 3);
  assert.equal(state.phase, "fenced");

  const late = ingestWorkerReport(state, { raw: report({ reportId: "report-2" }), context, now: 4 });
  assert.equal((late as any).code, "fenced");

  const unauthorized = resumeForRepair(state, { authorization: "no", now: 5 });
  assert.equal((unauthorized as any).code, "authorization");
  const resumed = resumeForRepair(state, { authorization: "repair-authorized", now: 5 });
  assert.equal(resumed.ok, true);
  const next = (resumed as any).value;
  assert.equal(next.phase, "resumed");
  assert.equal(canMutate(next), true);
  assert.equal(canAccept(next).ok, false);
});

test("only a fenced candidate with met criteria is verification-eligible", () => {
  const partial = (ingestWorkerReport(openCandidateFence(), {
    raw: report({ outcome: "partial" }),
    context,
    now: 2,
  }) as any).value;
  const fencedPartial = agentSettled(partial, 3);
  assert.equal(fencedPartial.phase, "fenced");
  assert.equal(canAccept(fencedPartial).ok, false);
  assert.ok(canAccept(fencedPartial).reasons.some((reason) => /outcome/.test(reason)));

  const noMet = (ingestWorkerReport(openCandidateFence(), {
    raw: report({ criteria: [{ roadmapStepId: "step-1", status: "unknown" }] }),
    context,
    now: 2,
  }) as any).value;
  const fencedNone = agentSettled(noMet, 3);
  assert.equal(canAccept(fencedNone).ok, false);
  assert.ok(canAccept(fencedNone).reasons.some((reason) => /met criteria/.test(reason)));
});

test("invalid or mismatched reports are refused and checkpoints never fence", () => {
  const invalid = ingestWorkerReport(openCandidateFence(), { raw: {}, context, now: 2 });
  assert.equal((invalid as any).code, "invalid");

  const mismatched = ingestWorkerReport(openCandidateFence(), {
    raw: report({ sessionId: "session-2" }),
    context,
    now: 2,
  });
  assert.equal((mismatched as any).code, "mismatch");

  const state = recordCheckpoint(openCandidateFence(), { summary: "halfway", now: 2 });
  assert.equal(state.phase, "open");
  assert.equal(state.candidate, undefined);
  assert.equal(state.checkpoint?.summary, "halfway");

  // Without settle, draining a tool does not fence a received report.
  let pending = (toolStarted(openCandidateFence()) as any).value;
  pending = (ingestWorkerReport(pending, { raw: report(), context, now: 3 }) as any).value;
  pending = toolEnded(pending, 4);
  assert.equal(pending.phase, "report_received");
});
