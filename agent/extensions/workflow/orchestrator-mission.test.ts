/**
 * Orchestrator identity and work-source contracts.
 *
 * These pin the user-reported defect: the parent must know it is neither Plan
 * nor Builder, and a work request must be able to start from the current
 * discussion without `/build`, a plan handoff or a fabricated plan file.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildOrchestratorMission,
  ORCHESTRATOR_CONTEXT_ENTRY,
  isOrchestratorContextEntry,
} from "./orchestrator-mission.ts";
import {
  discussionRoadmap,
  resolveWorkSource,
  summarizeWorkSource,
} from "./orchestrator-source.ts";
import { explainCommandRefusal, resolveSessionRole } from "./permissions.ts";

test("mission: names the Orchestrator parent, not Plan or Builder", () => {
  const text = buildOrchestratorMission({ phase: "unbound", coordinator: true });
  assert.match(text, /ORCHESTRATOR MODE ACTIVE/);
  assert.match(text, /not in Plan mode/i);
  assert.match(text, /not the Builder/i);
  assert.doesNotMatch(text, /you are in Plan mode/i);
  // The mission may name the forbidden remedy only to forbid it; it must never
  // instruct the model to use it.
  assert.doesNotMatch(text, /use \/build/i);
  assert.match(text, /Never ask the user to switch to \/build/);
});

test("mission: work entry and approval are explicit and idle-safe", () => {
  const text = buildOrchestratorMission({ phase: "unbound", coordinator: true });
  assert.match(text, /orchestrator_prepare/);
  assert.match(text, /orchestrator_propose_tasks/);
  assert.match(text, /execution approval/i);
  assert.match(text, /never launch|never launched|Nothing has been launched|no child/i);
});

test("mission: unready host or non-coordinator cannot claim launch authority", () => {
  const unready = buildOrchestratorMission({
    phase: "ready",
    coordinator: true,
    host: { ready: false, label: "Windows Terminal", reason: "not installed" },
  });
  assert.match(unready, /NOT ready/);
  assert.match(unready, /Do not claim a child was launched/);

  const worker = buildOrchestratorMission({
    phase: "unbound",
    coordinator: false,
    managedWorker: true,
  });
  assert.match(worker, /managed Build CHILD/);
  assert.match(worker, /not the parent/);
});

test("mission: context ownership is explicit and narrow", () => {
  assert.equal(
    isOrchestratorContextEntry({ customType: ORCHESTRATOR_CONTEXT_ENTRY }),
    true,
  );
  assert.equal(isOrchestratorContextEntry({ role: "user", content: "quoted [PLAN MODE ACTIVE]" }), false);
});

test("role: Orchestrator is its own identity and refusal remedy", () => {
  assert.equal(resolveSessionRole({ workflowMode: "orchestrator" }), "orchestrator");
  assert.equal(resolveSessionRole({ workflowMode: "plan" }), "planner");

  const refusal = explainCommandRefusal("orchestrator", "mkdir src/out");
  assert.ok(refusal);
  assert.doesNotMatch(refusal!.suggestion ?? "", /\/build/);
  assert.match(refusal!.suggestion ?? "", /Orchestrator|delegat|Build child/i);
});

test("source: an explicit discussion request beats a stale plan file", () => {
  const resolved = resolveWorkSource({
    request: { source: "discussion", objective: "add a logout button", now: 10 },
    boundPlanPath: "C:/work/.pi/plans/old.md",
    lastUserPrompt: "work on this",
  });
  assert.equal(resolved.ok, true);
  if (!resolved.ok) return;
  assert.equal(resolved.source.kind, "discussion");
  assert.match(summarizeWorkSource(resolved.source), /current discussion/);
});

test("source: discussion bullets become stable requirements and a roadmap", () => {
  const captured = discussionRoadmap({
    objective: "Ship the settings screen\n- add the form\n- wire validation",
    constraints: ["no new dependency"],
    label: "Settings",
    capturedAt: 5,
  });
  assert.deepEqual(captured.requirements, [
    "add the form",
    "wire validation",
    "Respect the constraint: no new dependency",
  ]);
  assert.match(captured.markdown, /## Plan Steps/);
  assert.equal(captured.digest.length, 64);
});

test("source: no plan and no objective asks for clarification instead of guessing", () => {
  const resolved = resolveWorkSource({
    request: { source: "auto", now: 1 },
  });
  assert.equal(resolved.ok, false);
  if (resolved.ok) return;
  assert.equal(resolved.code, "ambiguous");
});
