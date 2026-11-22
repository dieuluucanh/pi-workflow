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
import { parseContributionEnvelope } from "./host-contributions.ts";
import {
  CONTRIBUTION_EVENTS,
  createContributionPublisher,
} from "./host-contributions-publisher.ts";
import { makeFakeClock } from "./test-support-ports.ts";

const envelopeFor = (contributions: ReturnType<typeof buildWorkflowContributions>) =>
  parseContributionEnvelope({
    version: 1,
    owner: { id: "@dieulc/workflow", version: "0.13.0" },
    sessionId: "session-a",
    epoch: 0,
    revision: 1,
    removed: [],
    contributions,
  });

test("build: mode badge, progress and one cycle action are valid contributions", () => {
  const contributions = buildWorkflowContributions({
    mode: "build",
    done: 3,
    total: 8,
    commitMode: "never",
    writeMode: "allow",
  });
  const parsed = envelopeFor(contributions);
  assert.equal(parsed.ok, true, parsed.ok ? "" : parsed.error);

  const mode = contributions.find((entry) => entry.id === "mode");
  assert.ok(mode && mode.kind === "mode");
  assert.match(mode.label, /build/);
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

  // The old fixed-target switch buttons are gone, but their commands remain
  // available for direct use and are not quietly re-published under other ids.
  for (const legacy of ["mode-plan", "mode-orchestrator", "mode-build"]) {
    assert.equal(contributions.some((entry) => entry.id === legacy), false, legacy);
  }
});

test("build: every base mode exposes the same cycle binding, Default included", () => {
  for (const mode of [null, "plan", "orchestrator", "build"] as const) {
    const contributions = buildWorkflowContributions({ mode, done: 0, total: 0 });
    const badge = contributions.find((entry) => entry.id === "mode");
    assert.ok(badge && badge.kind === "mode", `mode ${String(mode)} has a badge`);
    assert.equal(badge.actionRef, "mode-cycle");
    const cycle = contributions.find((entry) => entry.id === "mode-cycle");
    assert.ok(cycle && cycle.kind === "action");
    assert.equal(cycle.enabled, true);
    assert.deepEqual(cycle.command, { name: "workflow-cycle" });
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
  const running = buildWorkflowContributions({
    mode: "plan",
    done: 1,
    total: 4,
    reviewPhase: "running",
  });
  const badge = running.find((entry) => entry.id === "mode");
  assert.ok(badge && badge.kind === "mode");
  assert.match(badge.label, /review/);
  const actions = running.filter((entry) => entry.kind === "action").map((entry) => entry.id);
  assert.deepEqual(actions, ["mode-cycle", "review", "review-stop"]);
  // The mode control is still present, but it refuses instead of changing mode
  // under the reviewer; the runtime guard re-checks stale requests too.
  assert.equal(badge.actionRef, "mode-cycle");
  const cycle = running.find((entry) => entry.id === "mode-cycle");
  assert.ok(cycle && cycle.kind === "action");
  assert.equal(cycle.enabled, false);
  assert.match(cycle.disabledReason ?? "", /review/i);
  assert.equal(envelopeFor(running).ok, true);

  const paused = buildWorkflowContributions({ mode: "plan", done: 0, total: 0, reviewPhase: "paused" });
  const resume = paused.find((entry) => entry.id === "review");
  assert.ok(resume && resume.kind === "action");
  assert.equal(resume.command.name, "review-resume");

  // A review turn never advertises Plan/Build switching.
  assert.equal(paused.some((entry) => entry.id === "mode-build"), false);});

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

test("build: todo display actions include automatic and a state-aware toggle", () => {
  const expanded = buildWorkflowContributions({
    mode: "plan",
    done: 2,
    total: 5,
    panelState: "expanded",
  });
  const ids = expanded.filter((entry) => entry.kind === "action").map((entry) => entry.id);
  assert.deepEqual(ids, [
    "mode-cycle",
    "todos-auto",
    "todos-expand",
    "todos-collapse",
    "todos-hide",
    "todos-toggle",
  ]);
  const progress = expanded.find((entry) => entry.id === "todos");
  assert.ok(progress && progress.kind === "progress");
  assert.equal(progress.detail, "Expanded");
  const toggle = expanded.find((entry) => entry.id === "todos-toggle");
  assert.ok(toggle && toggle.kind === "action");
  assert.equal(toggle.command.name, "todos");
  assert.equal(toggle.command.args, "collapse");
  assert.equal(envelopeFor(expanded).ok, true);

  // A collapsed/hidden panel toggles the other way; no state means expand.
  for (const [state, args] of [
    ["collapsed", "expand"],
    ["hidden", "expand"],
    [null, "expand"],
  ] as const) {
    const view = buildWorkflowContributions({
      mode: "build",
      done: 0,
      total: 2,
      panelState: state,
    });
    const entry = view.find((item) => item.id === "todos-toggle");
    assert.ok(entry && entry.kind === "action");
    assert.equal(entry.command.args, args);
    assert.equal(envelopeFor(view).ok, true);
  }
});

test("extension: publishing the current mapper withdraws the retired switch buttons", () => {
  const emitted: Array<{ event: string; payload?: unknown }> = [];
  const publisher = createContributionPublisher({
    owner: { id: "@dieulc/workflow", version: "0.13.0" },
    sessionId: "session-a",
    clock: makeFakeClock(),
    emit: (event, payload) => emitted.push({ event, payload }),
  });
  publisher.hello({ contractVersion: 1, kinds: [], slots: [] });

  // The set a previous build published: a badge plus three fixed-target
  // buttons. They must be withdrawn explicitly, not left clickable.
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
      id: "mode-plan",
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
      id: "mode-orchestrator",
      kind: "action",
      slot: "action",
      label: "Orchestrator",
      tone: "info",
      order: 21,
      command: { name: "orchestrator" },
      enabled: true,
    },
    {
      id: "mode-build",
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
    buildWorkflowContributions({ mode: "plan", done: 0, total: 0, cycleAvailable: true }),
  );
  assert.equal(result.ok, true, result.ok ? "" : result.reason);

  const updates = emitted
    .filter((entry) => entry.event === CONTRIBUTION_EVENTS.update)
    .map((entry) => entry.payload as { removed: string[]; contributions: Array<{ id: string }> });
  const last = updates.at(-1)!;
  assert.deepEqual([...last.removed].sort(), ["mode-build", "mode-orchestrator", "mode-plan"]);
  assert.deepEqual(
    last.contributions.map((entry) => entry.id).sort(),
    ["input", "mode", "mode-cycle"],
    "only the badge, its referenced cycle action and the input state remain",
  );
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
    // The published badge is bound to the same action the composer button runs,
    // and the retired fixed-target buttons are not part of the live envelope.
    assert.equal(badge?.actionRef, "mode-cycle");
    assert.ok(envelope.contributions.some((entry) => entry.id === "mode-cycle"));
    for (const legacy of ["mode-plan", "mode-orchestrator", "mode-build"]) {
      assert.equal(
        envelope.contributions.some((entry) => entry.id === legacy),
        false,
        `the live envelope must not re-advertise ${legacy}`,
      );
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
