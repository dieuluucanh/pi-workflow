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
