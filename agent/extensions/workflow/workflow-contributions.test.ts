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

test("orchestrator child rows expose pause/resume/abort and the view toggle", () => {
  const contributions = buildWorkflowContributions({
    mode: "orchestrator",
    done: 1,
    total: 3,
    orchestration: {
      phase: "running",
      child: { ref: "2", total: 7, phase: "running", model: "builder/model", todoDone: 1, todoTotal: 2 },
      view: "child",
    },
  });
  const byId = new Map(contributions.map((entry) => [entry.id, entry]));
  assert.match(
    String((byId.get("orchestrator-child") as { text?: string })?.text),
    /child 2\/7 · running · builder\/model · 1\/2 todos/,
  );
  for (const id of ["orchestrator-view", "orchestrator-pause", "orchestrator-abort"]) {
    assert.ok(byId.has(id), id);
  }
  assert.equal(byId.has("orchestrator-direct-build"), false);
  assert.equal(byId.has("orchestrator-host"), false);
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
