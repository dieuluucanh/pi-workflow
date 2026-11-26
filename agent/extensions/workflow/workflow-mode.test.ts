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
  MODE_CYCLE_ORDER,
  MODE_PRESENTATION,
  PLAN_MODE_TOOLS,
  NORMAL_MODE_TOOLS,
  buildModeTools,
  cycleMode,
  decodeWorkflowEntry,
  encodeWorkflowMode,
  isManagedTool,
  isWorkflowMode,
  modeLabel,
  modePresentation,
  planModeTools,
  orchestratorModeTools,
  roleForMode,
  type WorkflowMode,
} from "./workflow-mode.ts";

test("tools: Orchestrator has the Build tool set plus the parent tools", () => {
  const active = ["read", "bash", "write", "edit", "third_party_tool"];
  const orchestrator = orchestratorModeTools(active);
  for (const tool of ["edit", "write", "bash", "read", "workflow_todo"]) {
    assert.ok(orchestrator.includes(tool), `${tool} must stay active`);
  }
  for (const tool of ["orchestrator_start", "orchestrator_status", "orchestrator_abort"]) {
    assert.ok(orchestrator.includes(tool), `${tool} must be active`);
  }
  assert.ok(orchestrator.includes("third_party_tool"));
});

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
    "plan_revision_done",
  ]);
  // edit/write stay active so the tool_call gate can explain the refusal.
  assert.ok(plan.includes("edit"));
  assert.ok(plan.includes("write"));
  // A third-party tool is never silently dropped by a mode switch.
  assert.ok(plan.includes("third_party_tool"));
});

test("tools: plan_revision_done is Plan-only, never Build/Default", () => {
  // The Planner↔Reviewer loop's child report answers a revision turn, which
  // only Plan mode has; Build/Default must not advertise it.
  assert.equal(
    (PLAN_MODE_TOOLS as readonly string[]).includes("plan_revision_done"),
    true,
  );
  assert.equal(
    (NORMAL_MODE_TOOLS as readonly string[]).includes("plan_revision_done"),
    false,
  );
  const build = buildModeTools(["read", "bash"]);
  assert.equal(build.includes("plan_revision_done"), false);
  // A Plan → Build switch drops it from the active set (it is managed, and
  // Build's managed set does not contain it).
  assert.equal(
    buildModeTools(["read", "plan_revision_done"]).includes("plan_revision_done"),
    false,
  );
  assert.equal(planModeTools(["read", "bash"]).includes("plan_revision_done"), true);
  // Orchestrator inherits the Plan set (it is a superset of Build + parent
  // tools), so the tool is present but inert there: it refuses unless a
  // revision turn is pending, which only the Plan↔Review loop opens.
  assert.equal(
    orchestratorModeTools(["read", "bash"]).includes("plan_revision_done"),
    true,
  );
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

test("cycle: Tab is Default → Plan → Orchestrator → Build → Default, and reverses", () => {
  assert.equal(cycleMode(null, 1), "plan");
  assert.equal(cycleMode("plan", 1), "orchestrator");
  assert.equal(cycleMode("orchestrator", 1), "build");
  assert.equal(cycleMode("build", 1), null);

  const forward: WorkflowMode[] = [];
  let mode: WorkflowMode = null;
  for (let i = 0; i < 8; i += 1) {
    mode = cycleMode(mode, 1);
    forward.push(mode);
  }
  assert.deepEqual(forward, [
    "plan",
    "orchestrator",
    "build",
    null,
    "plan",
    "orchestrator",
    "build",
    null,
  ]);

  assert.equal(cycleMode("build", -1), "orchestrator");
  assert.equal(cycleMode("orchestrator", -1), "plan");
  assert.equal(cycleMode("plan", -1), null);
  assert.equal(cycleMode(null, -1), "build");
});

test("cycle: one ring is exported in both directions", () => {
  assert.deepEqual(MODE_CYCLE_ORDER, [null, "plan", "orchestrator", "build"]);
  assert.equal(cycleMode(null), "plan");
  assert.equal(cycleMode("plan"), "orchestrator");
  assert.equal(cycleMode("orchestrator"), "build");
  assert.equal(cycleMode("build"), null);
});

test("cycle: a mode outside the supplied ring resolves to its first entry", () => {
  assert.equal(cycleMode("orchestrator", 1, [null, "plan", "build"]), null);
  assert.equal(cycleMode("someday" as WorkflowMode, 1), null);
});

test("role and label: each mode names one semantic role", () => {
  assert.equal(roleForMode("plan"), "planner");
  assert.equal(roleForMode("build"), "builder");
  assert.equal(roleForMode(null), null);
  assert.equal(modeLabel("plan"), "plan");
  assert.equal(modeLabel("build"), "build");
  assert.equal(modeLabel(null), "default");
  assert.equal(isWorkflowMode("plan"), true);
  assert.equal(isWorkflowMode("orchestrator"), true);
  assert.equal(roleForMode("orchestrator"), "orchestrator");
  assert.equal(modeLabel("orchestrator"), "orchestrator");
});

test("cycle: Orchestrator is a full member of the ordinary ring", () => {
  assert.equal(cycleMode("orchestrator", 1), "build");
  assert.equal(cycleMode("orchestrator", -1), "plan");
  assert.equal(cycleMode("plan", 1), "orchestrator");
  assert.equal(cycleMode("build", -1), "orchestrator");
});

test("presentation: the canonical table keeps composer glyphs and clean menu labels apart", () => {
  assert.deepEqual(
    MODE_PRESENTATION.map((entry) => entry.mode),
    MODE_CYCLE_ORDER,
    "the table follows the Tab ring",
  );
  // These are the labels the composer and footer already render: a menu must
  // never replace them with the clean names.
  assert.deepEqual(
    MODE_PRESENTATION.map((entry) => entry.composerLabel),
    ["◦ default", "⏸ plan", "🧭 orchestrator", "▶ build"],
  );
  assert.deepEqual(
    MODE_PRESENTATION.map((entry) => entry.menuLabel),
    ["Default", "Plan", "Orchestrator", "Build"],
  );
  assert.deepEqual(
    MODE_PRESENTATION.map((entry) => entry.tone),
    ["neutral", "warning", "info", "accent"],
  );
  assert.deepEqual(
    MODE_PRESENTATION.map((entry) => entry.order),
    [0, 1, 2, 3],
  );
  assert.deepEqual(modePresentation("plan").commands, ["plan", "workflow"]);
  assert.deepEqual(modePresentation("build").commands, ["build"]);
  assert.equal(modePresentation("orchestrator").commands[0], "orchestrator");
  assert.equal(modePresentation(null).commands[0], "default");
  for (const entry of MODE_PRESENTATION) {
    assert.equal(modePresentation(entry.mode), entry);
    assert.doesNotMatch(entry.menuLabel, /[⏸▶🧭◦]/u, "menu labels are clean");
    assert.match(entry.description, /^Switch to /);
  }
  // An unknown mode degrades to Default, never an empty row.
  assert.equal(modePresentation("someday" as WorkflowMode), MODE_PRESENTATION[0]);
});

test("codec: orchestrator round-trips and older readers see Default flags", () => {
  const encoded = encodeWorkflowMode("orchestrator");
  assert.equal(encoded.mode, "orchestrator");
  // Legacy flags are false, so an older Workflow reads Default, never Plan/Build.
  assert.equal(encoded.enabled, false);
  assert.equal(encoded.executing, false);
  const decoded = decodeWorkflowEntry(encoded);
  assert.equal(decoded?.mode, "orchestrator");
  assert.equal(decoded?.legacy, false);
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
  assert.equal(decodeWorkflowEntry({ mode: "someday" })?.mode, null);
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

test("the persisted orchestrator view survives decode and resets to undefined when absent", () => {
  const decoded = decodeWorkflowEntry({
    mode: "orchestrator",
    enabled: false,
    executing: false,
    orchestratorView: "child",
  });
  assert.equal(decoded?.orchestratorView, "child");
  // Unknown values are dropped, never guessed.
  const unknown = decodeWorkflowEntry({
    mode: "orchestrator",
    orchestratorView: "split",
  });
  assert.equal(unknown?.orchestratorView, undefined);
});

test("encodeWorkflowMode writes the view only when provided", () => {
  assert.deepEqual(encodeWorkflowMode("orchestrator"), {
    mode: "orchestrator",
    enabled: false,
    executing: false,
  });
  assert.deepEqual(encodeWorkflowMode("orchestrator", "parent"), {
    mode: "orchestrator",
    enabled: false,
    executing: false,
    orchestratorView: "parent",
  });
});
