/**
 * Workflow's contribution mapping (step 10).
 *
 * The mapper is the only Workflow-aware part of the contract: Plan/Build appear
 * as a badge plus commands, Review owns the badge while active, and TODOs are
 * progress. A host renders these without parsing glyphs.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildWorkflowContributions } from "./workflow-contributions.ts";
import { buildWorkflowStatusSegments } from "./workflow-status.ts";
import { MODE_PRESENTATION, modePresentation } from "./workflow-mode.ts";
import { parseContributionEnvelope } from "./host-contributions.ts";
import {
  CONTRIBUTION_EVENTS,
  createContributionPublisher,
} from "./host-contributions-publisher.ts";
import { makeFakeClock } from "./test-support-ports.ts";

const envelopeFor = (contributions: ReturnType<typeof buildWorkflowContributions>) =>
  parseContributionEnvelope({
    version: 1,
    owner: { id: "@dieulc/workflow", version: "0.15.0" },
    sessionId: "session-a",
    epoch: 0,
    revision: 1,
    removed: [],
    contributions,
  });

/** Every mode command registered in a normal session. */
const MODE_COMMANDS = {
  default: "default",
  plan: "plan",
  orchestrator: "orchestrator",
  build: "build",
} as const;

const actionsOf = (contributions: ReturnType<typeof buildWorkflowContributions>) =>
  contributions.filter((entry) => entry.kind === "action");

const choicesOf = (contributions: ReturnType<typeof buildWorkflowContributions>) =>
  contributions.filter((entry) => entry.kind === "mode-choice");

test("build: mode badge, progress and one cycle action are valid contributions", () => {
  const contributions = buildWorkflowContributions({
    mode: "build",
    done: 3,
    total: 8,
    commitMode: "never",
    writeMode: "allow",
    modeCommands: MODE_COMMANDS,
  });
  const parsed = envelopeFor(contributions);
  assert.equal(parsed.ok, true, parsed.ok ? "" : parsed.error);

  const mode = contributions.find((entry) => entry.id === "mode");
  assert.ok(mode && mode.kind === "mode");
  // The composer identity keeps its glyph; the menu uses the clean label.
  assert.equal(mode.label, "▶ build");
  assert.equal(mode.tone, "accent");
  // The label is the control: it references one same-owner action.
  assert.equal(mode.actionRef, "mode-cycle");

  const todos = contributions.find((entry) => entry.id === "todos");
  assert.ok(todos && todos.kind === "progress");
  assert.equal(todos.done, 3);
  assert.equal(todos.total, 8);

  const cycle = contributions.find((entry) => entry.id === "mode-cycle");
  assert.ok(cycle && cycle.kind === "action");
  assert.equal(cycle.enabled, true);
  assert.deepEqual(cycle.command, { name: "workflow-cycle" });

  // One stable action + one presentation choice per mode, in cycle order.
  assert.deepEqual(
    actionsOf(contributions).map((entry) => entry.id),
    [
      "mode-cycle",
      "mode-default",
      "mode-plan",
      "mode-orchestrator",
      "mode-build",
      "todos-auto",
      "todos-expand",
      "todos-collapse",
      "todos-hide",
    ],
  );
  assert.deepEqual(
    choicesOf(contributions).map((entry) => entry.id),
    ["mode-choice-default", "mode-choice-plan", "mode-choice-orchestrator", "mode-choice-build"],
  );
  assert.deepEqual(
    choicesOf(contributions).map((entry) => entry.label),
    ["Default", "Plan", "Orchestrator", "Build"],
  );
  assert.deepEqual(
    choicesOf(contributions).map((entry) =>
      entry.kind === "mode-choice" ? entry.actionRef : undefined,
    ),
    ["mode-default", "mode-plan", "mode-orchestrator", "mode-build"],
  );
  assert.deepEqual(
    choicesOf(contributions).map((entry) =>
      entry.kind === "mode-choice" ? entry.checked === true : false,
    ),
    [false, false, false, true],
    "only the live mode is checked",
  );
  for (const actionId of ["mode-default", "mode-plan", "mode-orchestrator", "mode-build"]) {
    const action = contributions.find((entry) => entry.id === actionId);
    assert.ok(action && action.kind === "action", actionId);
    assert.match(action.description ?? "", /^Switch to /);
  }
  const current = contributions.find((entry) => entry.id === "mode-build");
  assert.ok(current && current.kind === "action");
  assert.equal(current.enabled, false);
  assert.equal(current.disabledReason, "current mode");
});

test("build: every base mode exposes the same cycle binding, Default included", () => {
  for (const mode of [null, "plan", "orchestrator", "build"] as const) {
    const contributions = buildWorkflowContributions({
      mode,
      done: 0,
      total: 0,
      modeCommands: MODE_COMMANDS,
    });
    const badge = contributions.find((entry) => entry.id === "mode");
    assert.ok(badge && badge.kind === "mode", `mode ${String(mode)} has a badge`);
    assert.equal(badge.actionRef, "mode-cycle");
    assert.equal(badge.label, modePresentation(mode).composerLabel);
    const cycle = contributions.find((entry) => entry.id === "mode-cycle");
    assert.ok(cycle && cycle.kind === "action");
    assert.equal(cycle.enabled, true);
    assert.deepEqual(cycle.command, { name: "workflow-cycle" });
    // The current mode is checked in the menu and its action refuses with the
    // one canonical reason; the other three stay executable.
    const checked = choicesOf(contributions)
      .filter((entry) => entry.kind === "mode-choice" && entry.checked === true)
      .map((entry) => entry.id);
    assert.deepEqual(checked, [`mode-choice-${modePresentation(mode).key}`]);
    for (const presentation of MODE_PRESENTATION) {
      const action = contributions.find((entry) => entry.id === `mode-${presentation.key}`);
      assert.ok(action && action.kind === "action");
      if (presentation.mode === mode) {
        assert.equal(action.enabled, false);
        assert.equal(action.disabledReason, "current mode");
      } else {
        assert.equal(action.enabled, true, `${presentation.key} stays enabled`);
      }
    }
    assert.equal(envelopeFor(contributions).ok, true);
  }
});

test("build: an unavailable cycle command is disabled with a reason, not dangling", () => {
  const contributions = buildWorkflowContributions({
    mode: "plan",
    done: 0,
    total: 0,
    cycleAvailable: false,
  });
  const cycle = contributions.find((entry) => entry.id === "mode-cycle");
  assert.ok(cycle && cycle.kind === "action");
  assert.equal(cycle.enabled, false);
  assert.match(cycle.disabledReason ?? "", /unavailable/i);
  const badge = contributions.find((entry) => entry.id === "mode");
  assert.ok(badge && badge.kind === "mode");
  assert.equal(badge.actionRef, "mode-cycle");
  assert.equal(envelopeFor(contributions).ok, true);
});

test("mode choices: every actionRef names a same-owner action, never a dangling or foreign one", () => {
  const contributions = buildWorkflowContributions({
    mode: "orchestrator",
    done: 0,
    total: 0,
    modeCommands: MODE_COMMANDS,
  });
  const actionIds = new Set(
    contributions.filter((entry) => entry.kind === "action").map((entry) => entry.id),
  );
  const choices = choicesOf(contributions);
  assert.equal(choices.length, MODE_PRESENTATION.length);
  for (const choice of choices) {
    assert.ok(choice.kind === "mode-choice");
    assert.equal(choice.slot, "mode-choice");
    assert.ok(actionIds.has(choice.actionRef), `${choice.id} resolves ${choice.actionRef}`);
    assert.match(choice.actionRef, /^mode-(default|plan|orchestrator|build)$/);
    // The choice is presentation data only: the referenced action owns
    // execution and disabled state.
    assert.equal("command" in choice, false);
    assert.equal("enabled" in choice, false);
    assert.equal("disabledReason" in choice, false);
  }
});

test("mode choices: a missing command is disabled with a precise reason", () => {
  const contributions = buildWorkflowContributions({
    mode: "plan",
    done: 0,
    total: 0,
    modeCommands: { default: "default", orchestrator: "orchestrator" },
  });
  const build = contributions.find((entry) => entry.id === "mode-build");
  assert.ok(build && build.kind === "action");
  assert.equal(build.enabled, false);
  assert.equal(build.disabledReason, "/build is not registered in this session");
  // Plan's fallback is reported precisely when neither name is registered.
  const plan = contributions.find((entry) => entry.id === "mode-plan");
  assert.ok(plan && plan.kind === "action");
  assert.equal(plan.disabledReason, "current mode");
  const fallback = buildWorkflowContributions({
    mode: "build",
    done: 0,
    total: 0,
    modeCommands: { default: "default", build: "build", orchestrator: "orchestrator" },
  });
  const planFallback = fallback.find((entry) => entry.id === "mode-plan");
  assert.ok(planFallback && planFallback.kind === "action");
  assert.equal(
    planFallback.disabledReason,
    "neither /plan nor /workflow is registered in this session",
  );
});

test("mode choices: Plan resolves /workflow when /plan is owned elsewhere", () => {
  const contributions = buildWorkflowContributions({
    mode: null,
    done: 0,
    total: 0,
    modeCommands: {
      default: "default",
      plan: "workflow",
      orchestrator: "orchestrator",
      build: "build",
    },
  });
  const byId = new Map(contributions.map((entry) => [entry.id, entry]));
  assert.deepEqual((byId.get("mode-plan") as { command?: unknown }).command, {
    name: "workflow",
  });
  assert.deepEqual((byId.get("mode-default") as { command?: unknown }).command, {
    name: "default",
  });
  assert.deepEqual((byId.get("mode-orchestrator") as { command?: unknown }).command, {
    name: "orchestrator",
  });
  assert.deepEqual((byId.get("mode-build") as { command?: unknown }).command, {
    name: "build",
  });
  // The 0.14.0 verb grammar, never the retired hyphenated spellings.
  for (const entry of contributions) {
    if (entry.kind !== "action") continue;
    assert.doesNotMatch(entry.command.name, /^(?:plan|build|default|orchestrator)-/);
  }
});

test("mode choices: a handoff lock disables every non-current action with one reason", () => {
  const lockReason = "Review decision pending — mode switching is locked.";
  const contributions = buildWorkflowContributions({
    mode: "build",
    done: 0,
    total: 0,
    reviewPhase: "handoff",
    cycleDisabledReason: lockReason,
    modeCommands: MODE_COMMANDS,
  });
  for (const [id, expected] of [
    ["mode-default", lockReason],
    ["mode-plan", lockReason],
    ["mode-orchestrator", lockReason],
    ["mode-build", "current mode"],
  ] as const) {
    const action = contributions.find((entry) => entry.id === id);
    assert.ok(action && action.kind === "action", id);
    assert.equal(action.enabled, false, id);
    assert.equal(action.disabledReason, expected, id);
  }
});

test("mode choices: composer glyphs are unchanged, menu labels are clean, and the surfaces agree", () => {
  for (const mode of [null, "plan", "orchestrator", "build"] as const) {
    const contributions = buildWorkflowContributions({
      mode,
      done: 0,
      total: 0,
      modeCommands: MODE_COMMANDS,
    });
    const presentation = modePresentation(mode);
    const badge = contributions.find((entry) => entry.id === "mode");
    assert.ok(badge && badge.kind === "mode");
    // The composer identity must not be replaced by the clean menu label.
    assert.equal(badge.label, presentation.composerLabel);
    assert.equal(badge.tone, presentation.tone);
    assert.deepEqual(
      choicesOf(contributions).map((entry) => entry.label),
      ["Default", "Plan", "Orchestrator", "Build"],
    );
    // Label/choice parity: the menu choice and its action cannot drift.
    for (const row of MODE_PRESENTATION) {
      const action = contributions.find((entry) => entry.id === `mode-${row.key}`);
      const choice = contributions.find((entry) => entry.id === `mode-choice-${row.key}`);
      assert.ok(action && action.kind === "action");
      assert.ok(choice && choice.kind === "mode-choice");
      assert.equal(choice.label, action.label);
      assert.equal(choice.label, row.menuLabel);
      assert.equal(choice.tone, action.tone);
      assert.equal(choice.actionRef, action.id);
    }
    // Exactly one primary mode row: choices have their own slot and id prefix.
    const primary = contributions.filter((entry) => entry.slot === "mode");
    assert.equal(primary.length, 1, "one mode row, never a promoted choice");
    assert.equal(
      contributions.filter((entry) => entry.slot === "mode-choice").length,
      4,
    );
  }
});

test("mode presentation: the footer keeps the same glyph identity", () => {
  for (const mode of ["plan", "orchestrator", "build"] as const) {
    const status = buildWorkflowStatusSegments({
      mode,
      done: 1,
      total: 2,
      commitMode: "ask",
    });
    assert.ok(
      status.mode.startsWith(modePresentation(mode).composerLabel),
      `${mode} footer keeps ${modePresentation(mode).composerLabel}`,
    );
  }
  const fallback = buildWorkflowStatusSegments({
    mode: null,
    done: 1,
    total: 2,
    commitMode: "ask",
  });
  assert.ok(fallback.mode.startsWith("◦"), "Default keeps the ring glyph");
});

test("mode choices: publishing the set never dispatches a command", () => {
  const emitted: Array<{ event: string }> = [];
  const publisher = createContributionPublisher({
    owner: { id: "@dieulc/workflow", version: "0.15.0" },
    sessionId: "session-a",
    clock: makeFakeClock(),
    emit: (event) => emitted.push({ event }),
  });
  publisher.hello({ contractVersion: 1, kinds: [], slots: [] });
  publisher.set(
    buildWorkflowContributions({
      mode: "build",
      done: 0,
      total: 0,
      modeCommands: MODE_COMMANDS,
    }),
  );
  // Review controls are the same kind of data: publishing them (running and
  // paused) must not dispatch `/review pause|resume|abort` either.
  for (const reviewPhase of ["running", "paused"] as const) {
    publisher.set(
      buildWorkflowContributions({
        mode: "plan",
        done: 0,
        total: 0,
        reviewPhase,
        modeCommands: MODE_COMMANDS,
      }),
    );
  }
  // Rendering data only: no command/action event may be emitted by a set.
  for (const entry of emitted) {
    assert.equal(entry.event, CONTRIBUTION_EVENTS.update);
  }
});

test("build: no todo row without a list, and clamping keeps it valid", () => {
  const none = buildWorkflowContributions({ mode: null, done: 0, total: 0 });
  assert.equal(none.some((entry) => entry.id === "todos"), false);
  assert.equal(envelopeFor(none).ok, true);

  const clamped = buildWorkflowContributions({ mode: "plan", done: 12, total: 8 });
  const todos = clamped.find((entry) => entry.id === "todos");
  assert.ok(todos && todos.kind === "progress");
  assert.equal(todos.done, 8);
  assert.equal(todos.total, 8);
});

test("build: a live review owns the badge and exposes its own controls", () => {
  const lockReason = "Review is running — mode switching is locked.";
  const running = buildWorkflowContributions({
    mode: "plan",
    done: 1,
    total: 4,
    reviewPhase: "running",
    cycleDisabledReason: lockReason,
    modeCommands: MODE_COMMANDS,
  });
  const badge = running.find((entry) => entry.id === "mode");
  assert.ok(badge && badge.kind === "mode");
  assert.match(badge.label, /review/);
  const actions = running.filter((entry) => entry.kind === "action").map((entry) => entry.id);
  assert.deepEqual(actions, [
    "mode-cycle",
    "review-pause",
    "review-abort",
    "mode-default",
    "mode-plan",
    "mode-orchestrator",
    "mode-build",
  ]);
  // The old `review`/`review-stop` pair is gone: the footer owns phase detail
  // and the inline group carries the verbs.
  assert.equal(running.some((entry) => entry.id === "review"), false);
  assert.equal(running.some((entry) => entry.id === "review-stop"), false);
  const reviewControls = {
    id: "review-controls",
    label: "Review controls",
    order: 30,
    placement: "inline",
  };
  for (const [id, label, description, args, tone] of [
    ["review-pause", "Pause review", "/review pause", "pause", "warning"],
    ["review-abort", "Abort review", "/review abort", "abort", "warning"],
  ] as const) {
    const action = running.find((entry) => entry.id === id);
    assert.ok(action && action.kind === "action", id);
    assert.equal(action.label, label);
    assert.equal(action.description, description);
    assert.equal(action.tone, tone);
    assert.deepEqual(action.command, { name: "review", args });
    assert.deepEqual(action.group, reviewControls);
    assert.equal(action.enabled, true);
  }
  // The mode control is still present, but it refuses instead of changing mode
  // under the reviewer; the runtime guard re-checks stale requests too.
  assert.equal(badge.actionRef, "mode-cycle");
  const cycle = running.find((entry) => entry.id === "mode-cycle");
  assert.ok(cycle && cycle.kind === "action");
  assert.equal(cycle.enabled, false);
  assert.equal(cycle.disabledReason, lockReason);
  // Current mode wins; every other mode action carries the SAME lock reason.
  const current = running.find((entry) => entry.id === "mode-plan");
  assert.ok(current && current.kind === "action");
  assert.equal(current.enabled, false);
  assert.equal(current.disabledReason, "current mode");
  for (const id of ["mode-default", "mode-orchestrator", "mode-build"]) {
    const action = running.find((entry) => entry.id === id);
    assert.ok(action && action.kind === "action", id);
    assert.equal(action.enabled, false, id);
    assert.equal(action.disabledReason, lockReason, id);
  }
  // Choices stay present and checked, but remain data only.
  assert.deepEqual(
    choicesOf(running).map((entry) =>
      entry.kind === "mode-choice" ? [entry.id, entry.checked === true] : undefined,
    ),
    [
      ["mode-choice-default", false],
      ["mode-choice-plan", true],
      ["mode-choice-orchestrator", false],
      ["mode-choice-build", false],
    ],
  );
  assert.equal(envelopeFor(running).ok, true);

  const paused = buildWorkflowContributions({
    mode: "plan",
    done: 0,
    total: 0,
    reviewPhase: "paused",
    cycleDisabledReason: lockReason,
    modeCommands: MODE_COMMANDS,
  });
  // The paused bar swaps Pause for Resume, keeping the same inline group and
  // the shared Abort; there is never a second working-control pair.
  assert.equal(paused.some((entry) => entry.id === "review-pause"), false);
  assert.equal(paused.some((entry) => entry.id === "review"), false);
  assert.equal(paused.some((entry) => entry.id === "review-stop"), false);
  const resume = paused.find((entry) => entry.id === "review-resume");
  assert.ok(resume && resume.kind === "action");
  assert.equal(resume.label, "Resume review");
  assert.equal(resume.description, "/review resume");
  assert.equal(resume.tone, "info");
  assert.deepEqual(resume.command, { name: "review", args: "resume" });
  assert.deepEqual(resume.group, {
    id: "review-controls",
    label: "Review controls",
    order: 30,
    placement: "inline",
  });
  const stop = paused.find((entry) => entry.id === "review-abort");
  assert.ok(stop && stop.kind === "action");
  assert.equal(stop.label, "Abort review");
  assert.equal(stop.description, "/review abort");
  assert.deepEqual(stop.command, { name: "review", args: "abort" });

  // A review turn never advertises an executable Plan/Build switch: the menu
  // actions exist so Desktop can render the list, but every one is locked.
  const pausedBuild = paused.find((entry) => entry.id === "mode-build");
  assert.ok(pausedBuild && pausedBuild.kind === "action");
  assert.equal(pausedBuild.enabled, false);
  assert.equal(pausedBuild.disabledReason, lockReason);
});

test("build: a handoff review publishes no pause/resume/abort controls", () => {
  const lockReason = "Review decision pending — mode switching is locked.";
  const handoff = buildWorkflowContributions({
    mode: "plan",
    done: 1,
    total: 2,
    reviewPhase: "handoff",
    cycleDisabledReason: lockReason,
    modeCommands: MODE_COMMANDS,
  });
  const ids = handoff.map((entry) => entry.id);
  for (const id of ["review", "review-stop", "review-pause", "review-resume", "review-abort"]) {
    assert.equal(ids.includes(id), false, id);
  }
  // The decision belongs to the host-provided review tab: the mode row names
  // it, and the input stays locked so a prompt cannot race the decision.
  const badge = handoff.find((entry) => entry.id === "mode");
  assert.ok(badge && badge.kind === "mode");
  assert.equal(badge.detail, "The plan is waiting for your decision in the review tab.");
  const input = handoff.find((entry) => entry.id === "input");
  assert.ok(input && input.kind === "input");
  assert.equal(input.availability, "locked");
  assert.equal(input.tone, "warning");
  assert.equal(
    input.reason,
    "A reviewer owns this turn; pause or stop it to prompt the plan agent.",
  );
  // The mode cycle stays a disabled action, never an enabled dead button.
  const cycle = handoff.find((entry) => entry.id === "mode-cycle");
  assert.ok(cycle && cycle.kind === "action");
  assert.equal(cycle.enabled, false);
  assert.equal(cycle.disabledReason, lockReason);
  assert.equal(envelopeFor(handoff).ok, true);
});

test("build: a plain handoff stays a Plan sub-state, never Review", () => {
  const contributions = buildWorkflowContributions({
    mode: "plan",
    done: 2,
    total: 5,
    handoffPending: true,
  });
  const badge = contributions.find((entry) => entry.id === "mode");
  assert.ok(badge && badge.kind === "mode");
  assert.doesNotMatch(badge.label, /review/);
  assert.equal(badge.detail, "handoff pending");
});

test("build: policy hints are display-only status", () => {
  const contributions = buildWorkflowContributions({
    mode: null,
    done: 0,
    total: 0,
    commitMode: "ask",
    writeMode: "never",
  });
  const policy = contributions.find((entry) => entry.id === "policy");
  assert.ok(policy && policy.kind === "status");
  assert.match(policy.text, /commits:ask/);
  assert.match(policy.text, /writes:never/);
});

test("build: todo display actions are the Auto todos menu, not a computed toggle", () => {
  const expanded = buildWorkflowContributions({
    mode: "plan",
    done: 2,
    total: 5,
    panelState: "expanded",
    modeCommands: MODE_COMMANDS,
  });
  const ids = expanded.filter((entry) => entry.kind === "action").map((entry) => entry.id);
  assert.deepEqual(ids, [
    "mode-cycle",
    "mode-default",
    "mode-plan",
    "mode-orchestrator",
    "mode-build",
    "todos-auto",
    "todos-expand",
    "todos-collapse",
    "todos-hide",
  ]);
  const progress = expanded.find((entry) => entry.id === "todos");
  assert.ok(progress && progress.kind === "progress");
  assert.equal(progress.detail, "Expanded");

  // The explicit verbs are the menu; the retired computed toggle must stay
  // withdrawn so the host never renders two ways to expand/collapse.
  assert.equal(expanded.some((entry) => entry.id === "todos-toggle"), false);

  const byId = new Map(expanded.map((entry) => [entry.id, entry]));
  const display = [
    ["todos-auto", "Auto todos", "auto"],
    ["todos-expand", "Show todos", "expand"],
    ["todos-collapse", "Collapse todos", "collapse"],
    ["todos-hide", "Hide todos", "hide"],
  ] as const;
  for (const [id, label, args] of display) {
    const action = byId.get(id);
    assert.ok(action && action.kind === "action", id);
    assert.equal(action.label, label);
    assert.deepEqual(action.command, { name: "todos", args });
    assert.equal(action.enabled, true);
    assert.deepEqual(action.group, {
      id: "todos",
      label: "Todos",
      order: 40,
      placement: "menu",
    });
  }
  assert.equal(envelopeFor(expanded).ok, true);
});

test("build: TODO display verbs and view switch target the active panel", () => {
  const group = (label: string) => ({ id: "todos", label, order: 40, placement: "menu" });
  const display = [
    ["todos-auto", "Auto todos", "auto"],
    ["todos-expand", "Show todos", "expand"],
    ["todos-collapse", "Collapse todos", "collapse"],
    ["todos-hide", "Hide todos", "hide"],
  ] as const;
  const parent = buildWorkflowContributions({
    mode: "orchestrator",
    done: 1,
    total: 3,
    orchestration: { phase: "running", child: { ref: "2", total: 7, phase: "running" }, view: "parent" },
    childPanelActive: false,
  });
  const showChild = parent.find((entry) => entry.id === "orchestrator-view");
  assert.ok(showChild && showChild.kind === "action");
  assert.equal(showChild.label, "Show child todos");
  assert.deepEqual(showChild.command, { name: "orchestrator", args: "view child" });
  assert.deepEqual(showChild.group, group("Todos"));
  for (const [id, label, args] of display) {
    const action = parent.find((entry) => entry.id === id);
    assert.ok(action && action.kind === "action", id);
    assert.equal(action.label, label);
    assert.deepEqual(action.command, { name: "todos", args });
    assert.equal(action.enabled, true);
    assert.deepEqual(action.group, group("Todos"));
  }
  const parentProgress = parent.find((entry) => entry.id === "todos");
  assert.ok(parentProgress && parentProgress.kind === "progress");
  assert.equal(parentProgress.label, "Todos");

  // childPanelActive is authoritative even when orchestration.view says auto.
  const child = buildWorkflowContributions({
    mode: "orchestrator",
    done: 2,
    total: 7,
    orchestration: { phase: "running", child: { ref: "2", total: 7, phase: "running" }, view: "auto" },
    childPanelActive: true,
  });
  const showParent = child.find((entry) => entry.id === "orchestrator-view");
  assert.ok(showParent && showParent.kind === "action");
  assert.equal(showParent.label, "Show parent todos");
  assert.deepEqual(showParent.command, { name: "orchestrator", args: "view parent" });
  assert.deepEqual(showParent.group, group("Child todos"));
  for (const [id, label, args] of display) {
    const action = child.find((entry) => entry.id === id);
    assert.ok(action && action.kind === "action", id);
    assert.equal(action.label, label);
    assert.deepEqual(action.command, { name: "todos", args });
    assert.equal(action.enabled, true);
    assert.deepEqual(action.group, group("Child todos"));
  }
  const childProgress = child.find((entry) => entry.id === "todos");
  assert.ok(childProgress && childProgress.kind === "progress");
  assert.equal(childProgress.label, "Child todos");

  const emptyParent = buildWorkflowContributions({ mode: "orchestrator", done: 0, total: 0, childPanelActive: false });
  assert.equal(emptyParent.some((entry) => entry.id === "todos"), false);
  for (const [id] of display) assert.equal(emptyParent.some((entry) => entry.id === id), false, id);

  // Every empty child presentation state retains the verbs, but never a 0/0 row.
  for (const state of ["expanded", "collapsed", "hidden", "headerless"] as const) {
    const zeroChild = buildWorkflowContributions({
      mode: "orchestrator",
      done: 0,
      total: 0,
      childPanelActive: true,
      ...(state === "headerless" ? {} : { panelState: state as "expanded" | "collapsed" | "hidden" }),
      ...(state === "headerless" ? {} : { orchestration: { phase: "running", view: "auto" as const } }),
    });
    assert.equal(zeroChild.some((entry) => entry.id === "todos"), false, `${state}: no fake progress`);
    for (const [id, label, args] of display) {
      const action = zeroChild.find((entry) => entry.id === id);
      assert.ok(action && action.kind === "action", `${state}: ${id}`);
      assert.equal(action.label, label);
      assert.deepEqual(action.command, { name: "todos", args });
      assert.equal(action.enabled, true);
      assert.deepEqual(action.group, group("Child todos"));
    }
    const parsed = envelopeFor(zeroChild);
    assert.equal(parsed.ok, true, parsed.ok ? "" : `${state}: ${parsed.error}`);
  }
});

test("extension: publishing the current mapper withdraws the retired switch buttons", () => {
  const emitted: Array<{ event: string; payload?: unknown }> = [];
  const publisher = createContributionPublisher({
    owner: { id: "@dieulc/workflow", version: "0.15.0" },
    sessionId: "session-a",
    clock: makeFakeClock(),
    emit: (event, payload) => emitted.push({ event, payload }),
  });
  publisher.hello({ contractVersion: 1, kinds: [], slots: [] });

  // The set a previous build published: a badge plus three fixed-target
  // buttons with ids this build no longer uses. They must be withdrawn
  // explicitly, not left clickable.
  publisher.set([
    {
      id: "mode",
      kind: "mode",
      slot: "mode",
      label: "⏸ plan",
      tone: "warning",
      order: 0,
      actions: [],
    },
    {
      id: "mode-switch-plan",
      kind: "action",
      slot: "action",
      label: "Plan",
      tone: "warning",
      order: 20,
      command: { name: "plan" },
      enabled: false,
      disabledReason: "already in Plan",
    },
    {
      id: "mode-switch-orchestrator",
      kind: "action",
      slot: "action",
      label: "Orchestrator",
      tone: "info",
      order: 21,
      command: { name: "orchestrator" },
      enabled: true,
    },
    {
      id: "mode-switch-build",
      kind: "action",
      slot: "action",
      label: "Build",
      tone: "accent",
      order: 22,
      command: { name: "build" },
      enabled: true,
    },
  ]);

  const result = publisher.set(
    buildWorkflowContributions({
      mode: "plan",
      done: 0,
      total: 0,
      cycleAvailable: true,
      modeCommands: MODE_COMMANDS,
    }),
  );
  assert.equal(result.ok, true, result.ok ? "" : result.reason);

  const updates = emitted
    .filter((entry) => entry.event === CONTRIBUTION_EVENTS.update)
    .map((entry) => entry.payload as { removed: string[]; contributions: Array<{ id: string }> });
  const last = updates.at(-1)!;
  assert.deepEqual([...last.removed].sort(), [
    "mode-switch-build",
    "mode-switch-orchestrator",
    "mode-switch-plan",
  ]);
  const liveIds = new Set(last.contributions.map((entry) => entry.id));
  for (const id of [
    "mode",
    "mode-cycle",
    "mode-default",
    "mode-plan",
    "mode-orchestrator",
    "mode-build",
    "mode-choice-default",
    "mode-choice-plan",
    "mode-choice-orchestrator",
    "mode-choice-build",
    "input",
  ]) {
    assert.ok(liveIds.has(id), `${id} stays published`);
  }
  // The publisher validated the envelope before emitting it (`result.ok`), so
  // the host never receives an unparsable set here.
});

// ── Extension-level publishing ───────────────────────────────────────

test("extension: a host hello makes Workflow publish its UI", async () => {
  const { default: workflowExtension } = await import("./index.ts");
  const { fakeSdk, makeFakeCtx, makeFakePi, submitThenFinish, tmpProject } = await import(
    "./test-support.ts"
  );
  const { cwd, agentDir } = tmpProject();
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const pi = makeFakePi();
  const envelopes: unknown[] = [];
  // The fake host answers the probe with a hello and records updates.
  pi.events.on("host-contributions:probe", () => {
    pi.events.emit("host-contributions:hello", {
      contractVersion: 1,
      kinds: [],
      slots: [],
    });
  });
  pi.events.on("host-contributions:update", (payload: unknown) => {
    envelopes.push(payload);
  });
  const { sdk } = fakeSdk({ pass1: submitThenFinish("# Plan: x") });
  await workflowExtension(pi as never, {
    loadSdk: async () => sdk as never,
    plannnotatorRequestTimeoutMs: 20,
    plannotatorRequestTimeoutMs: 20,
    plannotatorRecoveryTimeoutMs: 20,
    isTerminalHost: () => true,
  } as never);
  const made = makeFakeCtx({ cwd, hasUI: false, branch: [] });
  try {
    await pi.emit("session_start", { reason: "startup" }, made.ctx);
    await pi.commands.build.handler("", made.ctx);
    assert.ok(envelopes.length > 0, "a hello must lead to a published envelope");
    const envelope = envelopes.at(-1) as {
      version: number;
      owner: { id: string };
      contributions: Array<{ id: string; kind: string; actionRef?: string }>;
    };
    assert.equal(envelope.version, 1);
    assert.equal(envelope.owner.id, "@dieulc/workflow");
    const badge = envelope.contributions.find((entry) => entry.kind === "mode");
    assert.ok(badge, "the current mode is published");
    // The published badge is bound to the same action the composer button runs
    // and keeps its glyph identity; the menu uses the clean labels.
    assert.equal(badge?.actionRef, "mode-cycle");
    assert.ok(envelope.contributions.some((entry) => entry.id === "mode-cycle"));
    const byId = new Map(envelope.contributions.map((entry) => [entry.id, entry]));
    for (const id of ["mode-default", "mode-plan", "mode-orchestrator", "mode-build"]) {
      const action = byId.get(id) as { kind: string; command?: { name: string } } | undefined;
      assert.ok(action, `${id} is published`);
      assert.equal(action?.kind, "action");
      assert.ok(action?.command?.name);
    }
    const current = byId.get("mode-build") as { enabled?: boolean; disabledReason?: string };
    assert.equal(current.enabled, false);
    assert.equal(current.disabledReason, "current mode");
    for (const choice of envelope.contributions.filter((entry) => entry.kind === "mode-choice")) {
      const action = byId.get(String(choice.actionRef));
      assert.ok(action, `${choice.id} actionRef resolves in the same owner envelope`);
      assert.equal(action?.kind, "action");
    }
  } finally {
    await pi.emit("session_shutdown", { reason: "quit" }, made.ctx);
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  }
});

test("build: an approved wait is resumable and is not a Review state", () => {
  const contributions = buildWorkflowContributions({
    mode: "plan",
    done: 0,
    total: 0,
    handoffStage: "approved",
  });
  const badge = contributions.find((entry) => entry.id === "mode");
  assert.ok(badge && badge.kind === "mode");
  assert.equal(badge.detail, "plan approved — execution choice pending");
  assert.doesNotMatch(badge.label, /review/);

  const resume = contributions.find((entry) => entry.id === "handoff-continue");
  assert.ok(resume && resume.kind === "action");
  assert.deepEqual(resume.command, { name: "handoff", args: "continue" });
  assert.equal(resume.enabled, true);
  // The action opens the chooser; it never claims to execute by itself.
  assert.doesNotMatch(String(resume.label), /execute/i);
});

test("build: no resume action without an approved wait", () => {
  const reviewing = buildWorkflowContributions({
    mode: "plan",
    done: 0,
    total: 0,
    handoffStage: "review-pending",
  });
  assert.equal(reviewing.some((entry) => entry.id === "handoff-continue"), false);
  const idle = buildWorkflowContributions({ mode: "plan", done: 0, total: 0 });
  assert.equal(idle.some((entry) => entry.id === "handoff-continue"), false);
});

test("the orchestrator-run status row never pairs a terminal phase with a next row", () => {
  const byId = (phase: string, nextTaskId?: string) =>
    new Map(
      buildWorkflowContributions({
        mode: "orchestrator",
        done: 2,
        total: 2,
        orchestration: {
          phase,
          ...(nextTaskId ? { nextTaskId } : {}),
          view: "parent",
        },
        childPanelActive: false,
      }).map((entry) => [entry.id, entry]),
    );

  const running = byId("running", "2").get("orchestrator-run");
  assert.ok(running && running.kind === "status");
  assert.equal(running.text, "run running · next 2");

  // `orchestrationStatus()` omits `nextTaskId` once the run is terminal, so the
  // footer can never render `run completed · next 2` / `run cancelled · next 2`.
  for (const phase of ["completed", "cancelled"]) {
    const row = byId(phase).get("orchestrator-run");
    assert.ok(row && row.kind === "status", phase);
    assert.equal(row.text, `run ${phase}`);
    assert.doesNotMatch(row.text, /next/);
  }
});

test("orchestrator child rows: the run controls are one inline group and no child status row duplicates the footer", () => {
  const contributions = buildWorkflowContributions({
    mode: "orchestrator",
    done: 1,
    total: 3,
    orchestration: {
      phase: "running",
      child: { ref: "2", total: 7, phase: "running", model: "builder/model", todoDone: 1, todoTotal: 2 },
      view: "child",
    },
    childPanelActive: true,
  });
  const byId = new Map(contributions.map((entry) => [entry.id, entry]));
  // The existing `workflow-orchestrator` setStatus line owns the telemetry; a
  // second status row would duplicate it in the Desktop footer.
  assert.equal(byId.has("orchestrator-child"), false);
  for (const id of ["orchestrator-view", "orchestrator-pause", "orchestrator-abort"]) {
    assert.ok(byId.has(id), id);
  }
  const runControls = {
    id: "run-controls",
    label: "Run controls",
    order: 30,
    placement: "inline",
  };
  for (const [id, label, description, args] of [
    ["orchestrator-pause", "Pause child", "/orchestrator pause", "pause"],
    ["orchestrator-abort", "Abort child", "/orchestrator abort", "abort"],
  ] as const) {
    const action = byId.get(id);
    assert.ok(action && action.kind === "action", id);
    assert.equal(action.label, label);
    assert.equal(action.description, description);
    assert.deepEqual(action.command, { name: "orchestrator", args });
    assert.deepEqual(action.group, runControls);
  }
  // The menu group is ordered after the inline run controls.
  const todosGroup = { id: "todos", label: "Child todos", order: 40, placement: "menu" };
  const view = byId.get("orchestrator-view");
  assert.ok(view && view.kind === "action");
  assert.deepEqual(view.group, todosGroup);
  assert.ok(view.group.order > runControls.order);
  // Every Orchestrator action routes through the one canonical command; the
  // verb rides in `args`, the action ids stay stable for hosts.
  assert.deepEqual(view.command, { name: "orchestrator", args: "view parent" });
  assert.equal(byId.has("orchestrator-direct-build"), false);
  assert.equal(byId.has("orchestrator-host"), false);
});

test("a paused child publishes the canonical resume command and hint", () => {
  const contributions = buildWorkflowContributions({
    mode: "orchestrator",
    done: 1,
    total: 3,
    orchestration: {
      phase: "running",
      child: { ref: "2", total: 7, phase: "paused" },
      view: "parent",
    },
    childPanelActive: false,
  });
  const byId = new Map(contributions.map((entry) => [entry.id, entry]));
  const resume = byId.get("orchestrator-resume");
  assert.ok(resume && resume.kind === "action");
  assert.equal(resume.label, "Resume child");
  assert.equal(resume.description, "/orchestrator resume");
  assert.deepEqual(resume.command, { name: "orchestrator", args: "resume" });
  assert.deepEqual(resume.group, {
    id: "run-controls",
    label: "Run controls",
    order: 30,
    placement: "inline",
  });
  // The parent panel is live, so the child list is still reachable.
  assert.deepEqual(
    (byId.get("orchestrator-view") as { command?: unknown }).command,
    { name: "orchestrator", args: "view child" },
  );
  assert.equal(
    String((byId.get("orchestrator-input-hint") as { text?: string })?.text),
    "paused — prompts are queued; /orchestrator resume delivers them",
  );
});

test("child telemetry stays in the footer segment, not a duplicate contribution row", () => {
  const child = {
    ref: "2",
    total: 7,
    phase: "running",
    model: "open/muse-spark",
    modelRef: { provider: "open", id: "muse-spark", thinking: "high" },
    stats: {
      tokens: {
        input: 12_000,
        output: 3_000,
        cacheRead: 0,
        cacheWrite: 0,
        total: 15_000,
      },
      context: { tokens: 86_000, contextWindow: 200_000, percent: 43 },
    },
    elapsedMs: 83_000,
    todoDone: 1,
    todoTotal: 2,
  };
  const contributions = buildWorkflowContributions({
    mode: "orchestrator",
    done: 1,
    total: 3,
    orchestration: { phase: "running", child, view: "child" },
    childPanelActive: true,
  });
  assert.equal(
    contributions.some(
      (entry) => entry.kind === "status" && /^child\s/.test(entry.text),
    ),
    false,
    "no status row duplicates the footer's child telemetry",
  );
  const segments = buildWorkflowStatusSegments({
    mode: "orchestrator",
    done: 1,
    total: 3,
    commitMode: "never",
    orchestration: { phase: "running", child, view: "child" },
  });
  assert.equal(
    segments.orchestrator,
    "child running · open/muse-spark · ctx 43% (86k/200k) · ↑12k ↓3.0k · 01:23",
    "workflow-status.ts keeps building the child telemetry",
  );
});

// ── Generic composer-transform publication ───────────────────────────

import {
  buildWorkflowComposerContributions,
  type WorkflowComposerInput,
} from "./workflow-contributions.ts";
import {
  parseComposerControlContribution,
  resolveComposerControlTargets,
  COMPOSER_TRANSFORM_CONTRACT,
} from "./composer-transform.ts";

function composerInput(overrides: Partial<WorkflowComposerInput> = {}): WorkflowComposerInput {
  return {
    controlId: "refine-prompt",
    toggleActionId: "refine-prompt-toggle",
    transformActionId: "refine-prompt-transform",
    label: "Refine prompt",
    description: "Send refines this draft and returns it here; it will not run the task.",
    icon: "sparkles",
    checked: false,
    enabled: true,
    publicCommand: "prompt",
    companionCommand: "prompt-refine-companion",
    toggleCommand: "prompt-refine",
    transformCommand: "prompt",
    ...overrides,
  };
}

test("composer control publishes same-owner action refs and companion metadata", () => {
  const contributions = buildWorkflowContributions({
    mode: null,
    done: 0,
    total: 0,
    composer: composerInput(),
  });
  const parsed = envelopeFor(contributions);
  assert.equal(parsed.ok, true, parsed.ok ? "" : parsed.error);
  if (!parsed.ok) return;

  const control = contributions.find((entry) => entry.kind === "composer-control");
  assert.ok(control);
  const validated = parseComposerControlContribution(control);
  assert.equal(validated.ok, true, validated.ok ? "" : validated.error.message);
  if (!validated.ok) return;
  assert.equal(validated.value.checked, false);
  assert.equal(validated.value.enabled, true);
  assert.equal(validated.value.operation.contract, COMPOSER_TRANSFORM_CONTRACT);
  assert.equal(validated.value.operation.companionCommand, "prompt-refine-companion");

  // The host resolves both references from the same owner and checks that the
  // transform action invokes the declared public command with no args.
  const projected = contributions.map((entry) => ({
    ownerId: "@dieulc/workflow",
    id: entry.id,
    kind: entry.kind,
    ...(entry.kind === "action"
      ? { label: entry.label, command: entry.command }
      : {}),
  }));
  const resolved = resolveComposerControlTargets(
    "@dieulc/workflow",
    validated.value,
    projected,
  );
  assert.equal(resolved.ok, true, resolved.ok ? "" : resolved.error.message);
  if (resolved.ok) {
    assert.deepEqual(resolved.value.transform.command, { name: "prompt" });
    assert.deepEqual(resolved.value.toggle.command, { name: "prompt-refine" });
  }
});

test("composer control reflects checked, disabled and no-composer states", () => {
  const armed = buildWorkflowContributions({
    mode: null,
    done: 0,
    total: 0,
    composer: composerInput({ checked: true }),
  });
  const control = armed.find((entry) => entry.kind === "composer-control");
  assert.ok(control && control.kind === "composer-control");
  assert.equal(control?.checked, true);
  assert.equal(
    armed.find((entry) => entry.id === "refine-prompt-toggle")?.kind,
    "action",
  );

  const disabled = buildWorkflowContributions({
    mode: null,
    done: 0,
    total: 0,
    composer: composerInput({ enabled: false, disabledReason: "unsupported host" }),
  });
  const off = disabled.find((entry) => entry.kind === "composer-control");
  assert.ok(off && off.kind === "composer-control");
  assert.equal(off?.enabled, false);
  assert.equal(off?.disabledReason, "unsupported host");

  // No negotiated composer input means no composer rows at all (old hosts keep
  // the status/action fallback and `/prompt`).
  const none = buildWorkflowContributions({ mode: null, done: 0, total: 0 });
  assert.equal(none.some((entry) => entry.kind === "composer-control"), false);
  assert.equal(none.some((entry) => entry.id === "refine-prompt-toggle"), false);
});

test("review mode owns input and publishes no composer control", () => {
  const contributions = buildWorkflowContributions({
    mode: null,
    done: 0,
    total: 0,
    reviewPhase: "running",
    composer: composerInput({ checked: true }),
  });
  assert.equal(contributions.some((entry) => entry.kind === "composer-control"), false);
});

test("composer publication is generic: two publishers build the same shape", () => {
  const a = buildWorkflowComposerContributions(composerInput());
  const b = buildWorkflowComposerContributions(
    composerInput({
      controlId: "other-control",
      toggleActionId: "other-toggle",
      transformActionId: "other-transform",
      label: "Rewrite",
      toggleCommand: "other-toggle",
      transformCommand: "other-rewrite",
      publicCommand: "other-rewrite",
      companionCommand: "other-companion",
      icon: "wand",
    }),
  );
  for (const set of [a, b]) {
    const control = set.find((entry) => entry.kind === "composer-control");
    assert.ok(control);
    assert.equal(parseComposerControlContribution(control).ok, true);
  }
  assert.equal(a.length, 3);
  assert.equal(b.length, 3);
});

// ── Desktop working message + active-panel progress ──────────────────

interface ChildHostBoot {
  pi: ReturnType<typeof import("./test-support.ts").makeFakePi>;
  ctx: ReturnType<typeof import("./test-support.ts").makeFakeCtx>["ctx"];
  made: ReturnType<typeof import("./test-support.ts").makeFakeCtx>;
  fake: ReturnType<typeof import("./test-support.ts").makeFakeOrchestratorChildFactory>;
  envelopes: Array<{
    contributions: Array<{ id: string; kind: string; label?: string; done?: number; total?: number }>;
  }>;
  cleanup(): Promise<void>;
}

async function bootChildHost(
  options: {
    todos?: Array<{ text: string; completed?: boolean }>;
    terminal?: boolean;
    branch?: Array<{ type: string; customType?: string; data?: unknown }>;
  } = {},
): Promise<ChildHostBoot> {
  const { default: workflowExtension } = await import("./index.ts");
  const {
    fakeSdk,
    makeFakeCtx,
    makeFakeOrchestratorChildFactory,
    makeFakePi,
    submitThenFinish,
    tmpProject,
  } = await import("./test-support.ts");
  const { cwd, agentDir } = tmpProject();
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const pi = makeFakePi({ activeTools: ["read", "write", "edit", "bash"] });
  const fake = makeFakeOrchestratorChildFactory({
    holdPrompt: true,
    ...(options.todos ? { todos: options.todos } : {}),
  });
  const { sdk } = fakeSdk({ pass1: submitThenFinish("# Plan: x") });
  const envelopes: ChildHostBoot["envelopes"] = [];
  pi.events.on("host-contributions:probe", () => {
    pi.events.emit("host-contributions:hello", {
      contractVersion: 1,
      kinds: [],
      slots: [],
    });
  });
  pi.events.on("host-contributions:update", (payload: unknown) => {
    envelopes.push(payload as ChildHostBoot["envelopes"][number]);
  });
  await workflowExtension(pi as never, {
    loadSdk: async () => sdk as never,
    createOrchestratorChild: fake.factory as never,
    plannotatorRequestTimeoutMs: 20,
    plannotatorRecoveryTimeoutMs: 20,
    // The terminal-specific branch registers Ctrl+Alt+O; Desktop uses its
    // working-message surface and must not claim that chord.
    isTerminalHost: () => options.terminal === true,
  } as never);
  const made = makeFakeCtx({ cwd, hasUI: true, branch: options.branch ?? [] });
  await pi.emit("session_start", { reason: "startup" }, made.ctx);
  return {
    pi,
    ctx: made.ctx,
    made,
    fake,
    envelopes,
    async cleanup() {
      try {
        await pi.emit("session_shutdown", { reason: "quit" }, made.ctx);
      } catch {
        /* shutdown is best-effort in the fake host */
      }
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
    },
  };
}

async function callHostTool(
  b: ChildHostBoot,
  name: string,
  params: Record<string, unknown>,
): Promise<{ text: string; details: Record<string, unknown> }> {
  const tool = b.pi.tools[name];
  assert.ok(tool, `${name} must be registered`);
  const result = (await tool.execute(
    `call-${name}`,
    params,
    undefined,
    undefined,
    b.ctx,
  )) as {
    content: Array<{ type: string; text?: string }>;
    details?: Record<string, unknown>;
  };
  return {
    text: result.content.map((block) => block.text ?? "").join("\n"),
    details: result.details ?? {},
  };
}

async function lifecycleTicks(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 20));
}

test("desktop: the live child hint is published as the working message and cleared on settle", async () => {
  const b = await bootChildHost();
  try {
    await b.pi.commands.orchestrator.handler("", b.ctx);
    const started = await callHostTool(b, "orchestrator_start", {
      title: "Working message",
      steps: ["Row one"],
    });
    assert.match(started.text, /created with 1 row/);
    await callHostTool(b, "orchestrator_dispatch", {
      rowRef: "1",
      instructions: "Do row one.",
    });

    // The bar renders this line verbatim, so the live child must carry the
    // exact 0.14.0 pause/abort hints.
    const live = b.made.workingMessages.at(-1);
    assert.equal(typeof live, "string");
    assert.match(String(live), /^Working · /);
    assert.match(String(live), /\/orchestrator pause/);
    assert.match(String(live), /\/orchestrator abort/);
    assert.ok(
      b.made.workingVisible.includes(true),
      "the message is made visible when this composer owns it",
    );

    // Paused is a stable child state, not "no activity": the resume hint must
    // stay on the bar.
    await b.pi.commands.orchestrator.handler("pause", b.ctx);
    await lifecycleTicks();
    const paused = b.made.workingMessages.at(-1);
    assert.match(String(paused), /^Paused · /);
    assert.match(String(paused), /\/orchestrator resume/);
    assert.match(String(paused), /\/orchestrator abort/);

    // Resume before settling: a paused child deliberately keeps the warm
    // session, so its settlement only completes once it runs again.
    await b.pi.commands.orchestrator.handler("resume", b.ctx);
    await lifecycleTicks();

    // A settling/settled child releases the surface; the stale line must go.
    b.fake.created[0]?.settle("row one done");
    await lifecycleTicks();
    assert.equal(
      b.made.workingMessages.at(-1),
      undefined,
      "the working message is cleared when the child settles",
    );
  } finally {
    await b.cleanup();
  }
});

test("child todo commands render the active panel and preserve independent preferences", async () => {
  const { renderTodoWidget } = await import("./test-support.ts");
  const b = await bootChildHost({ todos: [{ text: "child task", completed: true }] });
  try {
    await callHostTool(b, "workflow_todo", {
      action: "update",
      todos: [{ text: "parent only", status: "pending" }],
    });
    await b.pi.commands.orchestrator.handler("", b.ctx);
    await callHostTool(b, "orchestrator_start", { title: "Child panel", steps: ["Task"] });
    await callHostTool(b, "orchestrator_dispatch", { rowRef: "1", instructions: "Do task" });
    b.fake.created[0]?.settle("done");
    await lifecycleTicks();
    const listNotice = () => b.made.notifies.at(-1)?.message ?? "";

    await b.pi.commands.todos.handler("", b.ctx);
    assert.match(listNotice(), /Child todos \(1\)/);
    assert.match(listNotice(), /child task/);
    assert.doesNotMatch(listNotice(), /parent only/);

    await b.pi.commands.todos.handler("show", b.ctx);
    assert.doesNotMatch(listNotice(), /No todos\./);
    await b.pi.commands.todos.handler("expand", b.ctx);
    await b.pi.commands.todos.handler("auto", b.ctx);
    let autoSettled = renderTodoWidget(b.made.widgetCalls, 80);
    assert.equal(autoSettled.length, 2, `settled empty? child shows header plus collapsed summary: ${autoSettled.join(" | ")}`);
    assert.ok(autoSettled.some((line) => /CHILD/.test(line)));
    assert.ok(autoSettled.some((line) => /all done/.test(line)));
    await b.pi.commands.todos.handler("show", b.ctx);
    let lines = renderTodoWidget(b.made.widgetCalls, 80);
    assert.ok(lines.some((line) => /CHILD/.test(line)), `child header: ${lines.join(" | ")}`);
    assert.ok(lines.some((line) => /child task/.test(line)), `child row: ${lines.join(" | ")}`);

    await b.pi.commands.todos.handler("collapse", b.ctx);
    lines = renderTodoWidget(b.made.widgetCalls, 80);
    assert.ok(lines.length > 0, "collapsed child remains rendered");
    assert.ok(lines.some((line) => /No todos yet · \/todos expand/.test(line)) === false,
      "a populated child uses its ordinary collapsed summary");
    await b.pi.commands.todos.handler("hide", b.ctx);
    assert.deepEqual(renderTodoWidget(b.made.widgetCalls, 80), [], "Hide removes the captured widget");
    await b.pi.commands.todos.handler("show", b.ctx);
    assert.ok(renderTodoWidget(b.made.widgetCalls, 80).length > 0, "Show reverses Hide");

    await b.pi.commands.todos.handler("clear", b.ctx);
    assert.match(listNotice(), /Cannot clear child todos/);
    await b.pi.commands.todos.handler("", b.ctx);
    assert.match(listNotice(), /Child todos \(1\)/);
    await b.pi.commands.orchestrator.handler("view parent", b.ctx);
    await b.pi.commands.todos.handler("", b.ctx);
    assert.match(listNotice(), /Todos \(1\)/);
    assert.match(listNotice(), /Task/);
    assert.doesNotMatch(listNotice(), /child task/);
    await b.pi.commands.todos.handler("clear", b.ctx);
    assert.match(listNotice(), /cleared/i);

    await b.pi.commands.orchestrator.handler("view child", b.ctx);
    await b.pi.commands.todos.handler("", b.ctx);
    assert.match(listNotice(), /Child todos \(1\)/, "parent clear does not erase child list");
    assert.ok(renderTodoWidget(b.made.widgetCalls, 80).length > 0,
      "child preference survives switching and parent clear");
  } finally {
    await b.cleanup();
  }
});

test("terminal Ctrl+Alt+O toggles the child panel, including empty child, without registering on Desktop", async () => {
  const { renderTodoWidget } = await import("./test-support.ts");
  const terminal = await bootChildHost({ terminal: true });
  const desktop = await bootChildHost();
  try {
    assert.ok(terminal.pi.shortcuts["ctrl+alt+o"] ?? terminal.pi.shortcuts["Ctrl+Alt+O"],
      "terminal host registers the TODO chord");
    assert.equal(desktop.pi.shortcuts["ctrl+alt+o"] ?? desktop.pi.shortcuts["Ctrl+Alt+O"], undefined,
      "Desktop does not register the terminal chord");
    await terminal.pi.commands.orchestrator.handler("", terminal.ctx);
    await callHostTool(terminal, "orchestrator_start", { title: "Empty child", steps: ["Task"] });
    await callHostTool(terminal, "orchestrator_dispatch", { rowRef: "1", instructions: "Do task" });
    const shortcut = terminal.pi.shortcuts["ctrl+alt+o"] ?? terminal.pi.shortcuts["Ctrl+Alt+O"];
    assert.ok(shortcut);
    const headerOnly = renderTodoWidget(terminal.made.widgetCalls, 80);
    assert.ok(headerOnly.some((line) => /CHILD/.test(line)), `header-only child: ${headerOnly.join(" | ")}`);
    assert.equal(headerOnly.length, 1, "an expanded empty child renders its header without fake rows");
    await terminal.pi.commands.todos.handler("collapse", terminal.ctx);
    const emptyCollapsed = renderTodoWidget(terminal.made.widgetCalls, 80);
    assert.ok(emptyCollapsed.some((line) => /No todos yet · \/todos expand/.test(line)),
      `collapsed empty-child summary: ${emptyCollapsed.join(" | ")}`);
    await shortcut.handler(terminal.ctx);
    assert.ok(renderTodoWidget(terminal.made.widgetCalls, 80).length > 0,
      "shortcut expands a collapsed zero-row live child");
    await terminal.pi.commands.todos.handler("hide", terminal.ctx);
    assert.deepEqual(renderTodoWidget(terminal.made.widgetCalls, 80), [],
      "Hide removes the empty child's renderer");
    await shortcut.handler(terminal.ctx);
    assert.ok(renderTodoWidget(terminal.made.widgetCalls, 80).length > 0,
      "shortcut reverses Hide and expands the empty child");
  } finally {
    await terminal.cleanup();
    await desktop.cleanup();
  }
});

test("reload and rewind restore child panel fields without resurrecting a child", async () => {
  const run = {
    schemaVersion: 1,
    runId: "run-restore-10",
    title: "Restored run",
    rows: [{ ref: "1", text: "Restored task" }],
    currentRef: "1",
    phase: "interrupted",
    createdAt: 1,
    updatedAt: 2,
  };
  const childEntry = {
    mode: "build",
    orchestratorView: "child",
    orchestratorRun: run,
    todos: [],
    todoPanel: {
      preference: "collapsed",
      preferenceScope: "/parent/plan.md",
      childPreference: "hidden",
      childPreferenceScope: "child-run:run-restore-10",
      promptAfterSettle: true,
      completedSignature: "parent-completion-sentinel",
    },
  };
  const staleEntry = {
    mode: "build",
    orchestratorView: "child",
    orchestratorRun: run,
    todos: [],
    todoPanel: { preference: "collapsed", preferenceScope: "/parent/plan.md" },
  };
  const branch = [
    { type: "custom", customType: "workflow", data: staleEntry },
    { type: "custom", customType: "workflow", data: childEntry },
    { type: "custom", customType: "workflow", data: staleEntry },
  ];
  const b = await bootChildHost({ branch, terminal: true });
  try {
    await b.pi.emit("session_start", { reason: "reload" }, b.ctx);
    // Host action publication distinguishes usable controls from a mounted
    // widget. A saved child choice must not manufacture a child/header.
    b.pi.events.emit("host-contributions:hello", {
      contractVersion: 1,
      kinds: [],
      slots: [],
    });
    assert.equal(b.made.widgetCalls.some((call) =>
      call.key === "workflow-todos" && typeof call.value === "function"), false,
    "headerless reload never registers an empty TODO widget factory");
    assert.ok(b.pi.commands.todos, "the active /todos controls remain registered");
    assert.equal(b.fake.created.length, 0, "restore creates no child controller or provider turn");
    const chord = b.pi.shortcuts["ctrl+alt+o"] ?? b.pi.shortcuts["Ctrl+Alt+O"];
    assert.ok(chord, "terminal reload retains the child-view toggle");
    await chord.handler(b.ctx);
    const restoredEntry = [...b.pi.entries].reverse().find((entry) => entry.type === "workflow");
    const restoredPanel = (restoredEntry?.data as { todoPanel?: Record<string, unknown> } | undefined)?.todoPanel;
    assert.equal(restoredPanel?.childPreference, "expanded",
      "matching saved hidden choice toggles to expanded (mismatch Auto would collapse)");
    assert.equal(restoredPanel?.childPreferenceScope, "child-run:run-restore-10");
    const latest = b.envelopes.at(-1);
    assert.ok(latest);
    for (const id of ["todos-auto", "todos-expand", "todos-collapse", "todos-hide"]) {
      assert.ok(latest!.contributions.some((entry) => entry.id === id),
        `headerless child still publishes ${id}`);
    }
    await b.pi.commands.todos.handler("show", b.ctx);
    assert.doesNotMatch(b.made.notifies.at(-1)?.message ?? "", /No todos\./,
      "headerless child Show stores a preference instead of refusing");
    await b.pi.commands.todos.handler("hide", b.ctx);
    await chord.handler(b.ctx);
    const savedEntryAfterToggle = [...b.pi.entries].reverse().find((entry) => entry.type === "workflow");
    const savedAfterToggle = (savedEntryAfterToggle?.data as { todoPanel?: Record<string, unknown> } | undefined)?.todoPanel;
    assert.equal(savedAfterToggle?.childPreference, "expanded",
      "matching run scope restores hidden, and the terminal toggle expands it");
    assert.equal(savedAfterToggle?.childPreferenceScope, "child-run:run-restore-10");

    // session_tree resets panel baselines and replays branch entries in order;
    // a branch with no child fields cannot inherit the prior branch's choice.
    const otherRun = { ...run, runId: "run-restore-11" };
    const otherBranch = [{
      type: "custom",
      customType: "workflow",
      data: { mode: "build", orchestratorView: "child", orchestratorRun: otherRun, todos: [], todoPanel: {
        preference: "collapsed", preferenceScope: "/parent/plan.md",
        childPreference: "hidden", childPreferenceScope: "child-run:run-restore-10",
      } },
    }];
    const rewound = (await import("./test-support.ts")).makeFakeCtx({
      cwd: b.ctx.cwd,
      hasUI: true,
      branch: otherBranch,
    });
    await b.pi.emit("session_tree", {}, rewound.ctx);
    assert.equal(b.fake.created.length, 0, "rewind replay does not create child work");
    // The branch has no child fields. Its Auto baseline is effective, not the
    // previous branch's expanded preference: the first chord collapses the
    // empty child, then persists the new branch's run scope.
    await chord.handler(rewound.ctx);
    const savedRewindEntry = () => [...b.pi.entries].reverse().find((entry) => entry.type === "workflow");
    let rewindSaved = (savedRewindEntry()?.data as { todoPanel?: Record<string, unknown> } | undefined)?.todoPanel;
    assert.equal(rewindSaved?.childPreference, "collapsed");
    assert.equal(rewindSaved?.childPreferenceScope, "child-run:run-restore-11");
    assert.equal(rewindSaved?.preference, "collapsed", "non-Auto parent preference is preserved");

    // A later explicit Auto/null in replay overrides an earlier hidden child
    // choice, while an omitted child panel entry after the valid record does not.
    const overrideBranch = [
      { type: "custom", customType: "workflow", data: { mode: "build", orchestratorView: "child", orchestratorRun: otherRun, todos: [], todoPanel: { preference: "collapsed", preferenceScope: "/parent/plan.md" } } },
      { type: "custom", customType: "workflow", data: { mode: "build", orchestratorView: "child", orchestratorRun: otherRun, todos: [], todoPanel: { preference: "collapsed", preferenceScope: "/parent/plan.md", childPreference: "hidden", childPreferenceScope: "child-run:run-restore-11" } } },
      { type: "custom", customType: "workflow", data: { mode: "build", orchestratorView: "child", orchestratorRun: otherRun, todos: [], todoPanel: { preference: "collapsed", preferenceScope: "/parent/plan.md" } } },
      { type: "custom", customType: "workflow", data: { mode: "build", orchestratorView: "child", orchestratorRun: otherRun, todos: [], todoPanel: { preference: "collapsed", preferenceScope: "/parent/plan.md", childPreference: "auto", childPreferenceScope: null } } },
    ];
    const autoBranch = (await import("./test-support.ts")).makeFakeCtx({ cwd: b.ctx.cwd, hasUI: true, branch: overrideBranch });
    await b.pi.emit("session_tree", {}, autoBranch.ctx);
    await chord.handler(autoBranch.ctx);
    rewindSaved = (savedRewindEntry()?.data as { todoPanel?: Record<string, unknown> } | undefined)?.todoPanel;
    assert.equal(rewindSaved?.childPreference, "collapsed", "explicit Auto overrides earlier hidden before the chord");
    assert.equal(rewindSaved?.preference, "collapsed", "child replay never changes parent preference");
    assert.equal(rewindSaved?.childPreferenceScope, "child-run:run-restore-11");

    const baselineBranch = [{
      type: "custom", customType: "workflow",
      data: { mode: "build", orchestratorView: "child", orchestratorRun: otherRun, todos: [],
        todoPanel: { preference: "collapsed", preferenceScope: "/parent/plan.md" } },
    }];
    const baselineCtx = (await import("./test-support.ts")).makeFakeCtx({ cwd: b.ctx.cwd, hasUI: true, branch: baselineBranch });
    await b.pi.emit("session_tree", {}, baselineCtx.ctx);
    await chord.handler(baselineCtx.ctx);
    rewindSaved = (savedRewindEntry()?.data as { todoPanel?: Record<string, unknown> } | undefined)?.todoPanel;
    assert.equal(rewindSaved?.childPreference, "collapsed",
      "a branch with no child fields resets to Auto before the terminal toggle");
    assert.equal(rewindSaved?.childPreferenceScope, "child-run:run-restore-11");
    assert.equal(rewindSaved?.preference, "collapsed", "parent choice remains independent after baseline replay");
    assert.equal(rewound.widgetCalls.some((call) =>
      call.key === "workflow-todos" && typeof call.value === "function"), false,
    "child choice does not invent a header after rewind");
    assert.ok(b.pi.commands.todos, "controls remain registered after branch replay");
  } finally {
    await b.cleanup();
  }
});

test("child display refreshes preserve non-default parent bookkeeping and stale state", async () => {
  const { renderTodoWidget } = await import("./test-support.ts");
  const run = {
    schemaVersion: 1, runId: "row10-bookkeeping-run", title: "Bookkeeping run",
    rows: [{ ref: "1", text: "Child work" }], currentRef: "1", phase: "running", createdAt: 1, updatedAt: 2,
  };
  const branch = [{ type: "custom", customType: "workflow", data: {
    mode: "build", orchestratorView: "child", orchestratorRun: run,
    todos: [{ text: "Parent pending", status: "pending", step: 1 }],
    todoPanel: { preference: "expanded", preferenceScope: "/parent/plan.md", promptAfterSettle: true,
      completedSignature: "parent-sentinel", childPreference: "expanded", childPreferenceScope: "child-run:row10-bookkeeping-run" },
  } }];
  const b = await bootChildHost({ branch, todos: [{ text: "Child pending" }] });
  try {
    const persistedPanel = () => {
      const entry = [...b.pi.entries].reverse().find((item) => item.type === "workflow");
      return (entry?.data as { todoPanel?: Record<string, unknown> } | undefined)?.todoPanel;
    };
    await b.pi.emit("session_start", { reason: "reload" }, b.ctx);
    const initial = persistedPanel();
    assert.equal(initial?.promptAfterSettle, true);
    assert.equal(initial?.completedSignature, "parent-sentinel");

    // Child view is active from boot; open and settle a real fake child without
    // letting parent-derived rendering consume its non-default sentinels.
    await callHostTool(b, "orchestrator_start", { title: "Child", steps: ["work"] });
    await callHostTool(b, "orchestrator_dispatch", { rowRef: "1", instructions: "Do child work" });
    await b.pi.commands.todos.handler("show", b.ctx);
    await b.pi.commands.todos.handler("collapse", b.ctx);
    const whileOpen = persistedPanel();
    assert.equal(whileOpen?.promptAfterSettle, true);
    assert.equal(whileOpen?.completedSignature, "parent-sentinel");
    b.fake.created[0]?.settle("done");
    await lifecycleTicks();
    await b.pi.commands.todos.handler("auto", b.ctx);
    const afterSettle = persistedPanel();
    assert.equal(afterSettle?.promptAfterSettle, true);
    assert.equal(afterSettle?.completedSignature, "parent-sentinel");

    // Establish a genuine stale marker from fake lifecycle events, without an
    // actual tool mutation or provider call, then repaint the selected child.
    await b.pi.emit("before_agent_start", { prompt: "synthetic lifecycle", messages: [] }, b.ctx);
    const fakeToolResult = await b.pi.emit("tool_result", {
      toolName: "edit", isError: false, input: { path: "src/route.ts" }, content: [],
    }, b.ctx);
    assert.ok(fakeToolResult.some((result) => JSON.stringify(result ?? null).includes("[TODO")),
      `Build lifecycle must inject a footer: ${JSON.stringify(fakeToolResult)}`);
    await b.pi.emit("agent_end", {
      type: "agent_end", willRetry: false,
      messages: [{ role: "assistant", content: [{ type: "text", text: "Working" }] }],
    }, b.ctx);
    await lifecycleTicks();
    assert.ok(b.made.notifies.some((notice) => /Todo list not updated/.test(notice.message)),
      "the fake lifecycle created a genuine stale marker");
    await b.pi.commands.todos.handler("show", b.ctx);
    const childRows = renderTodoWidget(b.made.widgetCalls, 80);
    assert.doesNotMatch(childRows.join(" "), /⚠/, "child repaint does not display the parent's stale marker");
    assert.ok(b.made.notifies.some((notice) => /Todo list not updated/.test(notice.message)),
      "the fake lifecycle created a genuine stale marker");
    await b.pi.commands.orchestrator.handler("view parent", b.ctx);
    const parentRows = renderTodoWidget(b.made.widgetCalls, 80);
    assert.doesNotMatch(parentRows.join(" "), /⚠/, "expanded parent rows do not embed the summary marker");
    assert.ok(b.made.statusCalls.some((call) => JSON.stringify(call.value ?? null).includes("⚠")),
      "the non-settled parent stale marker survives child repaint/settlement and parent reappearance");
  } finally { await b.cleanup(); }
});

test("child widget renders Build-accent styling on the actual active row body", async () => {
  const { renderTodoWidget } = await import("./test-support.ts");
  const b = await bootChildHost({ todos: [{ text: "Build accent body" }] });
  try {
    await b.pi.commands.orchestrator.handler("", b.ctx);
    await callHostTool(b, "orchestrator_start", { title: "Accent", steps: ["task"] });
    await callHostTool(b, "orchestrator_dispatch", { rowRef: "1", instructions: "Work" });
    b.fake.created[0]?.settle("done");
    await lifecycleTicks();
    await b.pi.commands.todos.handler("show", b.ctx);
    const colors: string[] = [];
    const rows = renderTodoWidget(b.made.widgetCalls, 100, {
      fg: (color, text) => { colors.push(color); return `<${color}>${text}</${color}>`; },
      bold: (text) => text,
      strikethrough: (text) => text,
    });
    assert.ok(rows.some((line) => line.includes("Build accent body")), rows.join(" | "));
    assert.ok(colors.includes("accent"), `Build accent must be requested: ${colors.join(",")}`);
    assert.ok(rows.some((line) => /<accent>.*Build accent body/.test(line)),
      `active row BODY uses Build accent: ${rows.join(" | ")}`);
  } finally { await b.cleanup(); }
});

test("desktop: progress counts follow the active child panel", async () => {
  const b = await bootChildHost({
    todos: [
      { text: "child a", completed: true },
      { text: "child b", completed: false },
    ],
  });
  try {
    // The parent list has three rows; the child's own list has two.
    await callHostTool(b, "workflow_todo", {
      action: "update",
      todos: [
        { text: "parent a", status: "completed" },
        { text: "parent b", status: "pending" },
        { text: "parent c", status: "pending" },
      ],
    });
    const progressOf = () => {
      const envelope = b.envelopes.at(-1);
      assert.ok(envelope, "an envelope was published");
      const row = envelope!.contributions.find((entry) => entry.id === "todos");
      assert.ok(row && row.kind === "progress", "the progress row is published");
      return row!;
    };
    // The parent panel is active before dispatch: its three rows drive the
    // footer count.
    const parentProgress = progressOf();
    assert.equal(parentProgress.label, "Todos");
    assert.equal(parentProgress.total, 3);
    assert.equal(parentProgress.done, 1);

    await b.pi.commands.orchestrator.handler("", b.ctx);
    await callHostTool(b, "orchestrator_start", {
      title: "Active panel",
      steps: ["Row one"],
    });
    await callHostTool(b, "orchestrator_dispatch", {
      rowRef: "1",
      instructions: "Do row one.",
    });

    // A live child makes its (still empty) list the active panel: no stale
    // parent progress row may survive.
    const liveEnvelope = b.envelopes.at(-1);
    assert.ok(liveEnvelope, "an envelope was published");
    assert.equal(
      liveEnvelope!.contributions.some((entry) => entry.id === "todos"),
      false,
      "an empty child list does not publish the parent's three rows",
    );

    b.fake.created[0]?.settle("row one done");
    await lifecycleTicks();
    const after = progressOf();
    assert.equal(after.label, "Child todos");
    assert.equal(after.total, 2, "the child panel's two rows drive the count");
    assert.equal(after.done, 1);
  } finally {
    await b.cleanup();
  }
});
