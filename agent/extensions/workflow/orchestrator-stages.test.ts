/**
 * Stage-interface tests (step 43): a fake future stage can use the narrow port,
 * but v1 cannot auto-plan, rewrite a running roadmap, approve its own scope or
 * recursively orchestrate. Execution needs a matching approval; verification
 * cannot accept without evidence.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createStagePipeline,
  legacyControllerCompatibility,
  runStage,
  STAGE_AUTHORITY,
  V1_STAGE_LIMITS,
  type StageInput,
  type StageOutput,
  type StagePort,
} from "./orchestrator-stages.ts";

const ARTIFACT = [{ name: "plan.md", digest: "digest-plan", bytes: 100 }];

function input(over: Partial<StageInput> = {}): StageInput {
  return {
    schemaVersion: 1,
    runId: "run-1",
    stage: "artifact",
    revision: 1,
    roadmapRevision: 1,
    planRevision: 1,
    artifacts: ARTIFACT,
    ...over,
  };
}

function port(output: StageOutput | (() => Promise<StageOutput>)): StagePort {
  return {
    async run() {
      return typeof output === "function" ? output() : output;
    },
  };
}

test("stage authority keeps v1 non-recursive and non-accepting", () => {
  for (const authority of Object.values(STAGE_AUTHORITY)) {
    assert.equal(authority.dispatchChildren, false);
    assert.equal(authority.acceptWork, false);
    assert.equal(authority.rewriteExecutingRoadmap, false);
    assert.equal(authority.autoPlan, false);
  }
  assert.equal(STAGE_AUTHORITY.approval.approveScope, true);
  assert.equal(STAGE_AUTHORITY.execution.mutateWorkspace, true);
  assert.equal(STAGE_AUTHORITY.verification.mutateWorkspace, false);
  assert.deepEqual(V1_STAGE_LIMITS, {
    autoPlan: false,
    rewriteExecutingRoadmap: false,
    approveOwnScope: false,
    recursiveOrchestration: false,
  });
  assert.equal(legacyControllerCompatibility().planLifecycleMoved, false);
  assert.equal(legacyControllerCompatibility().reviewTurnOwnership, "unchanged");
});

test("a fake future artifact stage works through the port", async () => {
  const result = await runStage(
    port({
      stage: "artifact",
      status: "ok",
      artifacts: [{ name: "task-breakdown.json", digest: "digest-plan", bytes: 42 }],
    }),
    input(),
    { actor: "parent", now: 1 },
  );
  assert.equal(result.ok, true);
  assert.equal((result as any).output.stage, "artifact");
  assert.equal((result as any).runMutation, "none");

  const mismatch = await runStage(
    port({ stage: "execution", status: "ok", changedFiles: [], taskIds: [] }),
    input(),
    { actor: "parent", now: 1 },
  );
  assert.equal((mismatch as any).code, "mismatch");
});

test("execution requires a matching approval and cannot accept work", async () => {
  const executionInput = input({
    stage: "execution",
    approval: { approved: true, approvedBy: "user", digest: "digest-plan" },
  });
  const executed = await runStage(
    port({ stage: "execution", status: "ok", changedFiles: ["src\\a.ts"], taskIds: ["task-t1"] }),
    executionInput,
    { actor: "parent", now: 1 },
  );
  assert.equal(executed.ok, true);
  assert.deepEqual((executed as any).output.changedFiles, ["src/a.ts"]);
  assert.equal((executed as any).output.accepted, undefined);

  const noApproval = await runStage(
    port({ stage: "execution", status: "ok", changedFiles: [], taskIds: [] }),
    input({ stage: "execution" }),
    { actor: "parent", now: 1 },
  );
  assert.equal((noApproval as any).code, "approval");

  const stageApproval = await runStage(
    port({ stage: "execution", status: "ok", changedFiles: [], taskIds: [] }),
    input({ stage: "execution", approval: { approved: true, approvedBy: "stage", digest: "digest-plan" } }),
    { actor: "parent", now: 1 },
  );
  assert.equal((stageApproval as any).code, "approval");

  const wrongDigest = await runStage(
    port({ stage: "execution", status: "ok", changedFiles: [], taskIds: [] }),
    input({ stage: "execution", approval: { approved: true, approvedBy: "user", digest: "other" } }),
    { actor: "parent", now: 1 },
  );
  assert.equal((wrongDigest as any).code, "approval");

  const selfAccept = await runStage(
    port({
      stage: "execution",
      status: "ok",
      changedFiles: [],
      taskIds: [],
      accepted: true,
    } as unknown as StageOutput),
    executionInput,
    { actor: "parent", now: 1 },
  );
  assert.equal((selfAccept as any).code, "authority");
});

test("an approval stage needs a user/parent actor and a concrete digest", async () => {
  const approval = input({ stage: "approval" });
  const fake = port({
    stage: "approval",
    status: "ok",
    approval: { approved: true, approvedBy: "stage" },
    approvedDigest: "digest-plan",
  });
  const stageActor = await runStage(fake, approval, { actor: "stage", now: 1 });
  assert.equal((stageActor as any).code, "approval");

  const stageApprover = await runStage(fake, approval, { actor: "parent", now: 1 });
  assert.equal((stageApprover as any).code, "authority");

  const accepted = await runStage(
    port({
      stage: "approval",
      status: "ok",
      approval: { approved: true, approvedBy: "parent" },
      approvedDigest: "digest-plan",
    }),
    approval,
    { actor: "parent", now: 1 },
  );
  assert.equal(accepted.ok, true);

  const missingDigest = await runStage(
    port({
      stage: "approval",
      status: "ok",
      approval: { approved: true, approvedBy: "parent" },
      approvedDigest: "",
    }),
    approval,
    { actor: "parent", now: 1 },
  );
  assert.equal((missingDigest as any).code, "invalid");
});

test("verification may propose but not accept without evidence", async () => {
  const verification = input({ stage: "verification" });
  const noEvidence = await runStage(
    port({ stage: "verification", status: "ok", verdict: "accepted" }),
    verification,
    { actor: "parent", now: 1 },
  );
  assert.equal((noEvidence as any).code, "authority");

  const withEvidence = await runStage(
    port({
      stage: "verification",
      status: "ok",
      verdict: "accepted",
      evidenceId: "evidence-e1",
    }),
    verification,
    { actor: "parent", now: 1 },
  );
  assert.equal(withEvidence.ok, true);
  assert.equal((withEvidence as any).authority.acceptWork, false);
  assert.equal((withEvidence as any).runMutation, "none");

  const authorityField = await runStage(
    port({ stage: "verification", status: "ok", verdict: "accepted", accepted: true } as unknown as StageOutput),
    verification,
    { actor: "parent", now: 1 },
  );
  assert.equal((authorityField as any).code, "authority");
});

test("nested stages, missing ports and thrown stages fail closed", async () => {
  const nested = await runStage(
    port({ stage: "artifact", status: "ok", artifacts: [] }),
    input(),
    { actor: "parent", nested: true, now: 1 },
  );
  assert.equal((nested as any).code, "nested");

  const pipeline = createStagePipeline({});
  const missing = await pipeline.run(input(), { actor: "parent", now: 1 });
  assert.equal((missing as any).code, "unavailable");

  const thrown = await runStage(
    port(async () => {
      throw new Error("stage crashed");
    }),
    input(),
    { actor: "parent", now: 1 },
  );
  assert.equal((thrown as any).code, "unavailable");
  assert.match((thrown as any).error, /stage crashed/);
});

test("the pipeline dispatches by kind and keeps stages isolated", async () => {
  const pipeline = createStagePipeline({
    artifact: port({ stage: "artifact", status: "ok", artifacts: [] }),
    approval: port({
      stage: "approval",
      status: "ok",
      approval: { approved: true, approvedBy: "user" },
      approvedDigest: "digest-plan",
    }),
  });
  const artifact = await pipeline.run(input(), { actor: "parent", now: 1 });
  assert.equal(artifact.ok, true);
  const approval = await pipeline.run(input({ stage: "approval" }), { actor: "user", now: 2 });
  assert.equal(approval.ok, true);
  assert.equal((approval as any).output.approval.approvedBy, "user");
});
