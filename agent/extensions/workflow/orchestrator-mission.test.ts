import assert from "node:assert/strict";
import test from "node:test";

import { buildOrchestratorMission } from "./orchestrator-mission.ts";

test("the mission names every declared workspace root", () => {
  const text = buildOrchestratorMission({
    phase: "unbound",
    workspaces: "W=C:/work/W (primary) · D=C:/work/D",
  });
  assert.match(text, /Workspace roots: W=C:\/work\/W/);
  assert.match(text, /D=C:\/work\/D/);
  assert.match(text, /Workspaces:/);
});

test("the mission remains valid without a multi-root set", () => {
  const text = buildOrchestratorMission({ phase: "unbound" });
  assert.doesNotMatch(text, /Workspace roots:/);
  assert.match(text, /orchestrator_start/);
});
