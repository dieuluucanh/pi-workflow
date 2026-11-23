import assert from "node:assert/strict";
import test from "node:test";

import {
  buildOrchestratorChildKickoff,
  buildOrchestratorChildSystemPrompt,
  parseOrchestratorChildContext,
  type OrchestratorChildContext,
} from "./orchestrator-child-contract.ts";

const context: OrchestratorChildContext = {
  version: 1,
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
    roots: [
      { id: "W", root: "C:/work/W", primary: true },
      { id: "D", root: "C:/work/D", primary: false },
    ],
  },
  createdAt: 1,
};

test("child context accepts an optional workspace and rejects a malformed one", () => {
  const parsed = parseOrchestratorChildContext(context);
  assert.equal(parsed.ok, true, parsed.ok ? "" : parsed.reason);
  if (!parsed.ok) return;
  assert.equal(parsed.context.workspace?.id, "D");
  const invalid = parseOrchestratorChildContext({ ...context, workspace: { id: "D" } });
  assert.equal(invalid.ok, false);
});

test("child system prompt names its root and every run root", () => {
  const prompt = buildOrchestratorChildSystemPrompt(context);
  assert.match(prompt, /C:\/work\/D/);
  assert.match(prompt, /W=C:\/work\/W/);
  assert.match(prompt, /D=C:\/work\/D/);
  assert.doesNotMatch(prompt, new RegExp(["same", "workspace", "as", "the", "Orchestrator", "parent"].join(" ")));
});

test("kickoff carries the workspace section and row metadata", () => {
  const kickoff = buildOrchestratorChildKickoff({
    context,
    row: {
      id: "todo-1",
      ref: "1",
      text: "Implement D",
      source: "plan",
      acceptanceChecks: ["npm test"],
      expectedFiles: ["src/d.ts"],
      status: "pending",
    },
  });
  assert.match(kickoff, /## Workspace/);
  assert.match(kickoff, /Root: C:\/work\/D/);
  assert.match(kickoff, /W=C:\/work\/W/);
  assert.match(kickoff, /npm test/);
  assert.match(kickoff, /src\/d\.ts/);
});
