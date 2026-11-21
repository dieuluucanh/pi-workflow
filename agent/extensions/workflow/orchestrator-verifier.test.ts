/**
 * Verifier tests (step 42): opt-in only, read-only request, authority-bearing
 * response fields rejected, disagreement blocks acceptance, and verifier
 * agreement can never replace a missing parent check.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  applyVerifierResult,
  buildVerifierRequest,
  coerceVerifierConfig,
  DEFAULT_VERIFIER_CONFIG,
  validateVerifierResponse,
  verifierMayAccept,
  verifierMayRewritePlan,
  type ParentEvidenceSummary,
  type VerifierRequest,
} from "./orchestrator-verifier.ts";

const CONFIG = { enabled: true, role: "implementation-verifier" };

function request(): VerifierRequest {
  const built = buildVerifierRequest({
    config: CONFIG,
    requestId: "request-r1",
    runId: "run-1",
    taskId: "task-t1",
    attemptId: "attempt-a1",
    candidateId: "candidate-c1",
    roadmapRevision: 1,
    workspaceRevision: "ws-1",
    task: {
      objective: "Implement the client",
      covers: ["step-r1"],
      acceptanceChecks: ["tests"],
      nonGoals: ["do not rewrite the transport"],
    },
    candidate: {
      evidenceId: "evidence-e1",
      verdict: "accepted",
      filesChanged: ["src/client.ts"],
      checks: [{ name: "tests", status: "passed", evidence: "exit 0" }],
    },
  });
  assert.equal(built.ok, true);
  return (built as any).request;
}

function response(over: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    requestId: "request-r1",
    verdict: "agree",
    findings: ["looks consistent"],
    blockingFindings: [],
    reviewedChecks: ["tests"],
    ...over,
  };
}

function parent(over: Partial<ParentEvidenceSummary> = {}): ParentEvidenceSummary {
  return {
    verdict: "accepted",
    blockers: [],
    requiredChecks: ["tests"],
    checks: [{ name: "tests", status: "passed", evidence: "exit 0" }],
    ...over,
  };
}

test("the verifier is opt-in and defaults to disabled", () => {
  assert.equal(DEFAULT_VERIFIER_CONFIG.enabled, false);
  assert.equal(coerceVerifierConfig(undefined).enabled, false);
  assert.equal(coerceVerifierConfig({ enabled: "yes" }).enabled, false);
  const enabled = coerceVerifierConfig({ enabled: true, role: "  verifier  ", model: { provider: "openai", id: "gpt" } });
  assert.equal(enabled.enabled, true);
  assert.equal(enabled.role, "verifier");
  assert.deepEqual(enabled.model, { provider: "openai", id: "gpt" });
  assert.equal(coerceVerifierConfig({ enabled: true, model: { provider: "", id: "" } }).model, undefined);
});

test("a disabled verifier is parent-only, never an empty approval", () => {
  const built = buildVerifierRequest({
    config: { ...DEFAULT_VERIFIER_CONFIG },
    requestId: "request-r1",
    runId: "run-1",
    taskId: "task-t1",
    attemptId: "attempt-a1",
    candidateId: "candidate-c1",
    roadmapRevision: 1,
    workspaceRevision: "ws-1",
    task: { objective: "x", covers: [], acceptanceChecks: ["tests"], nonGoals: [] },
    candidate: { evidenceId: "evidence-e1", verdict: "accepted", filesChanged: [], checks: [] },
  });
  assert.equal(built.ok, false);
  assert.equal((built as any).code, "disabled");
  assert.equal((built as any).parentOnly, true);

  const decision = applyVerifierResult({ parent: parent() });
  assert.equal(decision.parentOnly, true);
  assert.equal(decision.acceptanceAllowed, true);

  const missing = applyVerifierResult({ parent: parent({ checks: [] }) });
  assert.equal(missing.acceptanceAllowed, false);
  assert.match(missing.blockers.join(" "), /required check is missing/);
});

test("the request itself grants no authority", () => {
  const built = request();
  assert.deepEqual(built.permissions, {
    readOnly: true,
    mayMutate: false,
    mayRewritePlan: false,
    mayAccept: false,
    mayDispatch: false,
    mayChangeScope: false,
  });
  assert.equal(verifierMayAccept(), false);
  assert.equal(verifierMayRewritePlan(), false);
});

test("authority-bearing response fields and mismatched requests are rejected", () => {
  const built = request();
  for (const field of ["accepted", "accept", "approval", "rewritePlan", "plan", "dispatch", "scope"]) {
    const result = validateVerifierResponse(response({ [field]: true }), built);
    assert.equal(result.ok, false, `${field} must be rejected`);
  }
  assert.equal(validateVerifierResponse(response({ requestId: "other" }), built).ok, false);
  assert.equal(validateVerifierResponse(response({ verdict: "accepted" }), built).ok, false);
  assert.equal(
    validateVerifierResponse(response({ findings: Array.from({ length: 100 }, () => "x") }), built).ok,
    false,
  );
  const valid = validateVerifierResponse(response(), built);
  assert.equal(valid.ok, true);
});

test("disagreement blocks acceptance until it is resolved", () => {
  const built = request();
  const disagree = validateVerifierResponse(
    response({ verdict: "disagree", blockingFindings: ["the client is not wired"] }),
    built,
  );
  assert.equal(disagree.ok, true);
  const decision = applyVerifierResult({
    request: built,
    response: (disagree as any).value,
    parent: parent(),
  });
  assert.equal(decision.acceptanceAllowed, false);
  assert.equal(decision.requiresResolution, true);
  assert.match(decision.blockers.join(" "), /verifier disagreement: the client is not wired/);

  const agree = validateVerifierResponse(response(), built);
  const allowed = applyVerifierResult({ request: built, response: (agree as any).value, parent: parent() });
  assert.equal(allowed.acceptanceAllowed, true);
  assert.equal(allowed.requiresResolution, false);
});

test("verifier agreement cannot replace a missing or unrecorded parent check", () => {
  const built = request();
  const agree = {
    schemaVersion: 1 as const,
    requestId: built.requestId,
    verdict: "agree" as const,
    findings: [],
    blockingFindings: [],
    reviewedChecks: ["tests"],
  };

  const missing = applyVerifierResult({
    request: built,
    response: agree,
    parent: parent({ checks: [] }),
  });
  assert.equal(missing.acceptanceAllowed, false);
  assert.match(missing.blockers.join(" "), /required check is missing/);

  const unrecorded = applyVerifierResult({
    request: built,
    response: agree,
    parent: parent({ checks: [{ name: "tests", status: "passed" }] }),
  });
  assert.equal(unrecorded.acceptanceAllowed, false);
  assert.match(unrecorded.blockers.join(" "), /no recorded evidence/);

  const unreviewed = applyVerifierResult({
    request: built,
    response: { ...agree, reviewedChecks: [] },
    parent: parent(),
  });
  assert.equal(unreviewed.acceptanceAllowed, false);
  assert.match(unreviewed.blockers.join(" "), /did not review required check/);
});

test("an unavailable verifier keeps the required parent checks", () => {
  const built = request();
  const decision = applyVerifierResult({
    request: built,
    response: undefined,
    parent: parent({ checks: [] }),
    unavailable: true,
  });
  assert.equal(decision.parentOnly, true);
  assert.equal(decision.acceptanceAllowed, false);
  assert.match(decision.blockers.join(" "), /required check is missing/);
});

test("a disagreement with no blocking finding is still recorded as blocking", () => {
  const built = request();
  const validated = validateVerifierResponse(response({ verdict: "disagree" }), built);
  assert.equal(validated.ok, true);
  assert.equal((validated as any).value.blockingFindings.length > 0, true);
});
