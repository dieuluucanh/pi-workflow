import assert from "node:assert/strict";
import test from "node:test";

import {
  ORCHESTRATOR_CHILD_VERSION,
  buildOrchestratorChildKickoff,
  buildOrchestratorChildSystemPrompt,
  parseOrchestratorChildContext,
  type OrchestratorChildContext,
} from "./orchestrator-child-contract.ts";

const context: OrchestratorChildContext = {
  version: ORCHESTRATOR_CHILD_VERSION,
  runId: "run-1",
  taskId: "task-1",
  attemptId: "attempt-1",
  ref: "1",
  total: 2,
  parentSessionRef: "parent",
  mode: "build",
  mayOrchestrate: false,
  workspace: {
    id: "D",
    root: "C:/work/D",
    primary: false,
  },
  createdAt: 1,
};

test("child context accepts an optional workspace and rejects a malformed one", () => {
  const parsed = parseOrchestratorChildContext(context);
  assert.equal(parsed.ok, true, parsed.ok ? "" : parsed.reason);
  if (!parsed.ok) return;
  assert.equal(parsed.context.workspace?.id, "D");
  assert.equal(parsed.context.workspace?.root, "C:/work/D");
  const invalid = parseOrchestratorChildContext({ ...context, workspace: { id: "D" } });
  assert.equal(invalid.ok, false);
});

test("child context fails closed on an older prompt-contract version", () => {
  const parsed = parseOrchestratorChildContext({ ...context, version: 1 });
  assert.equal(parsed.ok, false);
  if (parsed.ok) return;
  assert.match(parsed.reason, /unsupported orchestrator-child version 1/);
});

test("child system prompt names only its own root", () => {
  const prompt = buildOrchestratorChildSystemPrompt(context);
  assert.match(prompt, /C:\/work\/D/);
  assert.match(prompt, /Other roots belong to other rows/);
  assert.doesNotMatch(prompt, /C:\/work\/W/, "a later row's root is not advertised");
  assert.doesNotMatch(prompt, /frozen row/i);
  assert.doesNotMatch(prompt, /parent verifies and accepts/i);
});

test("kickoff carries the row root and the parent instruction, with no acceptance sections", () => {
  const kickoff = buildOrchestratorChildKickoff({
    context,
    row: {
      ref: "1",
      text: "Implement D",
      instruction: "Touch only src/d.ts.",
      workspace: { id: "D", root: "C:/work/D" },
    },
  });
  assert.match(kickoff, /## Workspace/);
  assert.match(kickoff, /Root: C:\/work\/D/);
  assert.match(kickoff, /## Parent instructions\nTouch only src\/d\.ts\./);
  assert.match(kickoff, /parent trusts your report/i);
  assert.doesNotMatch(kickoff, /Acceptance checks/);
  assert.doesNotMatch(kickoff, /Expected files/);
  assert.doesNotMatch(kickoff, /Run roots:/);
});

test("a repair round names the concrete blocker without claiming acceptance", () => {
  const kickoff = buildOrchestratorChildKickoff({
    context,
    row: { ref: "1", text: "Implement D" },
    repair: "typecheck failed at src/d.ts:12",
  });
  assert.match(kickoff, /## Repair round/);
  assert.match(kickoff, /typecheck failed at src\/d\.ts:12/);
  assert.doesNotMatch(kickoff, /acceptance/i);
});

test("the contract tells the child how to record a policy-blocked step", () => {
  const system = buildOrchestratorChildSystemPrompt(context);
  assert.match(system, /workflow\.commitPolicy: never/);
  assert.match(system, /never mark it completed/);
  assert.match(system, /`cancelled`/);
  assert.match(system, /## Not done/);

  const kickoff = buildOrchestratorChildKickoff({
    context,
    row: { ref: "1", text: "Implement D" },
  });
  assert.match(
    kickoff,
    /every step you did NOT complete with the reason \(policy or otherwise\)/,
  );
  assert.match(kickoff, /mark it `cancelled` with the policy named/);
  assert.match(kickoff, /## Not done/);
  assert.doesNotMatch(kickoff, /acceptance/i);
});
