/**
 * Workflow footer segments (2026-10-31 UI plan).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildWorkflowStatusSegments,
  setWorkflowStatus,
  setWorkflowWidget,
  WORKFLOW_STATUS_KEYS,
} from "./workflow-status.ts";

test("build mode keeps the mode/progress in `workflow` and splits the rest", () => {
  assert.deepEqual(
    buildWorkflowStatusSegments({
      mode: "build",
      done: 3,
      total: 8,
      profileLabel: "⚡ cheap",
      roleLabel: "🔨 builder",
      commitMode: "ask",
    }),
    {
      mode: "▶ build 3/8",
      profile: "⚡ cheap | 🔨 builder",
      policy: "commits:ask",
      orchestrator: "",
    },
  );
});

test("plan no longer claims a browser review without a Review turn", () => {
  assert.deepEqual(
    buildWorkflowStatusSegments({
      mode: "plan",
      done: 1,
      total: 4,
      commitMode: "never",
    }),
    {
      mode: "⏸ plan 1/4",
      profile: "",
      policy: "commits:never",
      orchestrator: "",
    },
  );
});

test("the Review turn replaces the author mode and carries its phase", () => {
  const base = { mode: "plan" as const, done: 1, total: 4, commitMode: "never" };
  assert.equal(
    buildWorkflowStatusSegments({ ...base, reviewPhase: "running" }).mode,
    "🔍 review",
  );
  assert.equal(
    buildWorkflowStatusSegments({ ...base, reviewPhase: "paused" }).mode,
    "🔍 review — paused",
  );
  assert.equal(
    buildWorkflowStatusSegments({ ...base, reviewPhase: "handoff" }).mode,
    "🔍 review — awaiting decision",
  );
  assert.equal(
    buildWorkflowStatusSegments({ ...base, reviewPhase: "transition" }).mode,
    "🔍 review",
  );
  assert.equal(
    buildWorkflowStatusSegments({ ...base, reviewPhase: "idle" }).mode,
    "⏸ plan 1/4",
  );
});

test("a plain handoff is a sub-state of the author mode, never Review", () => {
  const plan = buildWorkflowStatusSegments({
    mode: "plan",
    done: 1,
    total: 4,
    commitMode: "never",
    handoffPending: true,
  });
  assert.equal(plan.mode, "⏸ plan 1/4 — handoff pending");
  assert.ok(!plan.mode.includes("review"), "Review Mode off must not paint Review");
  assert.equal(
    buildWorkflowStatusSegments({
      mode: "build",
      done: 2,
      total: 3,
      commitMode: "never",
      handoffPending: true,
    }).mode,
    "▶ build 2/3 — handoff pending",
  );
  assert.equal(
    buildWorkflowStatusSegments({
      mode: null,
      done: 0,
      total: 0,
      commitMode: "never",
      handoffPending: true,
    }).mode,
    "◦ commits:never — handoff pending",
  );
  // A real Review turn wins over the plain handoff flag.
  assert.equal(
    buildWorkflowStatusSegments({
      mode: "plan",
      done: 1,
      total: 4,
      commitMode: "never",
      reviewPhase: "handoff",
      handoffPending: true,
    }).mode,
    "🔍 review — awaiting decision",
  );
});

test("default mode stays parseable and carries the write policy", () => {
  assert.deepEqual(
    buildWorkflowStatusSegments({
      mode: null,
      done: 2,
      total: 3,
      stale: true,
      commitMode: "ask",
      writeMode: "allow",
    }),
    {
      mode: "◦ 2/3 ⚠",
      profile: "",
      policy: "commits:ask · writes:allow",
      orchestrator: "",
    },
  );
  assert.deepEqual(
    buildWorkflowStatusSegments({
      mode: null,
      done: 0,
      total: 0,
      commitMode: "never",
      writeMode: "ask",
    }),
    {
      mode: "◦ commits:never",
      profile: "",
      policy: "commits:never · writes:ask",
      orchestrator: "",
    },
  );
});

test("the status keys are stable", () => {
  assert.deepEqual(WORKFLOW_STATUS_KEYS, {
    mode: "workflow",
    profile: "workflow-profile",
    policy: "workflow-policy",
    review: "workflow-review",
    todos: "workflow-todos",
    orchestrator: "workflow-orchestrator",
    execution: "workflow-execution",
  });
});

test("setWorkflowStatus clears a key when the segment disappears", () => {
  const calls: Array<[string, string | undefined]> = [];
  const ui = {
    setStatus: (key: string, text: string | undefined) => calls.push([key, text]),
  };
  setWorkflowStatus(ui, "workflow-profile", "⚡ cheap");
  setWorkflowStatus(ui, "workflow-profile", "");
  assert.deepEqual(calls, [
    ["workflow-profile", "⚡ cheap"],
    ["workflow-profile", undefined],
  ]);
});

test("setWorkflowWidget sets lines, clears with [], and passes placement", () => {
  const calls: Array<{
    key: string;
    lines: string[] | undefined;
    options?: { placement?: "aboveEditor" | "belowEditor" };
  }> = [];
  const ui = {
    setWidget: (
      key: string,
      lines: string[] | undefined,
      options?: { placement?: "aboveEditor" | "belowEditor" },
    ) => calls.push({ key, lines, options }),
  };
  setWorkflowWidget(ui, "workflow-review-status", ["a", "b"], {
    placement: "aboveEditor",
  });
  setWorkflowWidget(ui, "workflow-review-status", []);
  assert.deepEqual(calls, [
    {
      key: "workflow-review-status",
      lines: ["a", "b"],
      options: { placement: "aboveEditor" },
    },
    {
      key: "workflow-review-status",
      lines: undefined,
      options: undefined,
    },
  ]);
});

test("setWorkflowWidget is a no-op for a host without a widget API", () => {
  assert.doesNotThrow(() => setWorkflowWidget(undefined, "k", ["a"]));
  assert.doesNotThrow(() => setWorkflowWidget({}, "k", ["a"]));
});

test("the orchestrator footer reports the run without approval or recommendation prose", () => {
  const segments = buildWorkflowStatusSegments({
    mode: "orchestrator",
    done: 1,
    total: 2,
    commitMode: "never",
    orchestration: {
      phase: "blocked",
      blockedReason: "no host",
      nextTaskId: "task-2",
    },
  });
  assert.match(segments.mode, /orchestrator 1\/2/);
  assert.doesNotMatch(segments.mode, /approval/);
  assert.match(segments.orchestrator, /run blocked/);
  assert.match(segments.orchestrator, /next task-2/);
  assert.match(segments.orchestrator, /blocked: no host/);

  const idle = buildWorkflowStatusSegments({
    mode: "plan",
    done: 0,
    total: 0,
    commitMode: "never",
  });
  assert.equal(idle.orchestrator, "");
});

test("handoff stages are named accurately and a recommendation never executes", () => {
  const review = buildWorkflowStatusSegments({
    mode: "plan",
    done: 0,
    total: 0,
    commitMode: "never",
    handoffStage: "review-pending",
  });
  assert.match(review.mode, /handoff pending/);
  assert.equal(review.orchestrator, "", "no destination recommendation is rendered");

  const approved = buildWorkflowStatusSegments({
    mode: "plan",
    done: 0,
    total: 0,
    commitMode: "never",
    handoffStage: "approved",
  });
  assert.match(approved.mode, /execution choice pending/);
  assert.doesNotMatch(approved.mode, /review/);
  assert.equal(approved.orchestrator, "", "no destination recommendation is rendered");

  const routing = buildWorkflowStatusSegments({
    mode: "plan",
    done: 0,
    total: 0,
    commitMode: "never",
    handoffStage: "routing",
  });
  assert.match(routing.mode, /applying execution/);

  // A stale `handoffPending` flag must not override a later stage.
  const both = buildWorkflowStatusSegments({
    mode: "plan",
    done: 0,
    total: 0,
    commitMode: "never",
    handoffPending: true,
    handoffStage: "approved",
  });
  assert.match(both.mode, /execution choice pending/);
  assert.doesNotMatch(both.mode, /handoff pending/);
});

test("the orchestrator segment names the live child and its local todos", () => {
  const segments = buildWorkflowStatusSegments({
    mode: "orchestrator",
    done: 1,
    total: 3,
    commitMode: "never",
    orchestration: {
      phase: "running",
      child: {
        ref: "2",
        total: 7,
        phase: "running",
        model: "builder/model",
        todoDone: 3,
        todoTotal: 5,
      },
      view: "child",
    },
  });
  assert.equal(
    segments.orchestrator,
    "child 2/7 running · builder/model · 3/5 todos",
  );
});

test("the orchestrator segment falls back to the run row without a child", () => {
  const segments = buildWorkflowStatusSegments({
    mode: "orchestrator",
    done: 0,
    total: 1,
    commitMode: "never",
    orchestration: { phase: "paused", nextTaskId: "task-1" },
  });
  assert.equal(segments.orchestrator, "run paused · next task-1");
});

test("the orchestrator segment is view-aware: parent shows the run, child shows stats", () => {
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
    todoDone: 3,
    todoTotal: 5,
  };
  const base = {
    mode: "orchestrator" as const,
    done: 1,
    total: 3,
    commitMode: "never",
  };

  const parent = buildWorkflowStatusSegments({
    ...base,
    orchestration: { phase: "running", nextTaskId: "task-2", child, view: "parent" },
  });
  assert.equal(
    parent.orchestrator,
    "run running · next task-2 · child 2/7 running",
    "parent view stays about the run",
  );

  const childView = buildWorkflowStatusSegments({
    ...base,
    orchestration: { phase: "running", nextTaskId: "task-2", child, view: "child" },
  });
  assert.equal(
    childView.orchestrator,
    "child 2/7 running · open/muse-spark · ctx 43% (86k/200k) · ↑12k ↓3.0k · 01:23 · 3/5 todos",
    "child view carries the child's own telemetry",
  );

  const auto = buildWorkflowStatusSegments({
    ...base,
    orchestration: { phase: "running", child, view: "auto" },
  });
  assert.equal(auto.orchestrator, childView.orchestrator, "auto follows a live child");

  // No stats yet: the historical shape survives (prefix + model + todos).
  const bare = buildWorkflowStatusSegments({
    ...base,
    orchestration: {
      phase: "running",
      child: {
        ref: "2",
        total: 7,
        phase: "running",
        model: "builder/model",
        todoDone: 3,
        todoTotal: 5,
      },
      view: "child",
    },
  });
  assert.equal(
    bare.orchestrator,
    "child 2/7 running · builder/model · 3/5 todos",
  );

  // A pause still names the child; elapsed is frozen by the caller.
  const paused = buildWorkflowStatusSegments({
    ...base,
    orchestration: {
      phase: "paused",
      child: { ...child, phase: "paused", elapsedMs: 120_000 },
      view: "child",
    },
  });
  assert.match(paused.orchestrator, /^child 2\/7 paused · /);
  assert.match(paused.orchestrator, /02:00/);
});

test("the orchestrator segment is always exactly one line", () => {
  const segments = buildWorkflowStatusSegments({
    mode: "orchestrator",
    done: 1,
    total: 3,
    commitMode: "never",
    orchestration: {
      phase: "running",
      blockedReason: "line one\nline two\twith\ttabs",
      child: {
        ref: "1",
        total: 2,
        phase: "running",
        model: "open/model\nwith newline",
        stats: {
          tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 },
          context: { tokens: 1, contextWindow: 10, percent: 10 },
        },
      },
      view: "child",
    },
  });
  assert.equal(/[\r\n\t]/.test(segments.orchestrator), false);
  assert.ok(segments.orchestrator.length < 220);
});
