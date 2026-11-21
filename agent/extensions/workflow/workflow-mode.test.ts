/**
 * Mode controller and state codec tests (step 4).
 *
 * These pin what a mode switch means without a Pi host: the tool set, the Tab
 * order, the role mapping and — most importantly for upgrades — how an old
 * session entry is read.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  PLAN_MODE_TOOLS,
  NORMAL_MODE_TOOLS,
  buildModeTools,
  cycleMode,
  decodeWorkflowEntry,
  encodeWorkflowMode,
  isManagedTool,
  isWorkflowMode,
  modeLabel,
  planModeTools,
  roleForMode,
  type WorkflowMode,
} from "./workflow-mode.ts";

test("tools: Plan keeps the gated tools active and owns the workflow set", () => {
  const active = ["read", "bash", "write", "edit", "third_party_tool"];
  const plan = planModeTools(active);
  assert.deepEqual(plan, [
    "read",
    "bash",
    "third_party_tool",
    "edit",
    "write",
    "grep",
    "find",
    "ls",
    "explore",
    "questionnaire",
    "workflow_todo",
  ]);
  // edit/write stay active so the tool_call gate can explain the refusal.
  assert.ok(plan.includes("edit"));
  assert.ok(plan.includes("write"));
  // A third-party tool is never silently dropped by a mode switch.
  assert.ok(plan.includes("third_party_tool"));
});

test("tools: Build restores the managed set first and keeps unmanaged tools", () => {
  const active = ["read", "bash", "third_party_tool", "mcp__x__y"];
  const build = buildModeTools(active);
  assert.deepEqual(build.slice(0, NORMAL_MODE_TOOLS.length), [...NORMAL_MODE_TOOLS]);
  assert.ok(build.includes("third_party_tool"));
  assert.ok(build.includes("mcp__x__y"));
  assert.equal(new Set(build).size, build.length, "no duplicates");
});

test("tools: the managed set is explicit", () => {
  for (const tool of PLAN_MODE_TOOLS) assert.equal(isManagedTool(tool), true);
  assert.equal(isManagedTool("third_party_tool"), false);
});

test("cycle: Tab is Default → Plan → Build → Default, and reverses", () => {
  assert.equal(cycleMode(null, 1), "plan");
  assert.equal(cycleMode("plan", 1), "build");
  assert.equal(cycleMode("build", 1), null);
  const forward: WorkflowMode[] = [];
  let mode: WorkflowMode = null;
  for (let i = 0; i < 6; i += 1) {
    mode = cycleMode(mode, 1);
    forward.push(mode);
  }
  assert.deepEqual(forward, ["plan", "build", null, "plan", "build", null]);

  assert.equal(cycleMode("build", -1), "plan");
  assert.equal(cycleMode("plan", -1), null);
  assert.equal(cycleMode(null, -1), "build");
});

test("role and label: each mode names one semantic role", () => {
  assert.equal(roleForMode("plan"), "planner");
  assert.equal(roleForMode("build"), "builder");
  assert.equal(roleForMode(null), null);
  assert.equal(modeLabel("plan"), "plan");
  assert.equal(modeLabel("build"), "build");
  assert.equal(modeLabel(null), "default");
  assert.equal(isWorkflowMode("plan"), true);
  assert.equal(isWorkflowMode("orchestrator"), false);
});

test("codec: the current shape round-trips", () => {
  for (const mode of ["plan", "build", null] as const) {
    const encoded = encodeWorkflowMode(mode);
    assert.equal(encoded.mode, mode);
    assert.equal(encoded.enabled, mode === "plan");
    assert.equal(encoded.executing, mode === "build");
    const decoded = decodeWorkflowEntry(encoded);
    assert.equal(decoded?.mode, mode);
    assert.equal(decoded?.legacy, false);
  }
});

test("codec: the legacy booleans still restore plan/build", () => {
  assert.equal(decodeWorkflowEntry({ enabled: true })?.mode, "plan");
  assert.equal(decodeWorkflowEntry({ executing: true })?.mode, "build");
  assert.equal(decodeWorkflowEntry({ enabled: true })?.legacy, true);
  assert.equal(decodeWorkflowEntry({ executing: true })?.legacy, true);
});

test("codec: a legacy entry with neither flag keeps the previous mode", () => {
  // This is the 2026-09 resume bug: `{enabled:false, executing:false}` must not
  // reset a plan/build selection restored from an earlier entry.
  assert.equal(decodeWorkflowEntry({ enabled: false, executing: false }, "plan")?.mode, "plan");
  assert.equal(decodeWorkflowEntry({}, "build")?.mode, "build");
  assert.equal(decodeWorkflowEntry({ todos: [] }, "build")?.mode, "build");
});

test("codec: an unknown or corrupt mode degrades to Default, never crashes", () => {
  // A mode this build does not understand must not keep running plan/build
  // gating on a guess: Default (no workflow) is the safe state.
  assert.equal(decodeWorkflowEntry({ mode: "orchestrator" })?.mode, null);
  assert.equal(decodeWorkflowEntry({ mode: 42 }, "build")?.mode, null);
  assert.equal(decodeWorkflowEntry(null), undefined);
  assert.equal(decodeWorkflowEntry("plan"), undefined);
  assert.equal(decodeWorkflowEntry([]), undefined);
});

test("codec: optional fields are validated, not trusted", () => {
  const decoded = decodeWorkflowEntry({
    mode: "build",
    toolsBeforePlanMode: ["read", 7, "bash"],
    planFile: "/p/plan.md",
  });
  assert.deepEqual(decoded?.toolsBeforePlanMode, ["read", "bash"]);
  assert.equal(decoded?.planFile, "/p/plan.md");

  const empty = decodeWorkflowEntry({ mode: "build", planFile: "", toolsBeforePlanMode: "read" });
  assert.equal(empty?.planFile, undefined);
  assert.equal(empty?.toolsBeforePlanMode, undefined);
});
