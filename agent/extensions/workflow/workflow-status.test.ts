/**
 * Workflow footer segments (2026-10-31 UI plan).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildWorkflowStatusSegments,
  setWorkflowStatus,
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
    { mode: "◦ 2/3 ⚠", profile: "", policy: "commits:ask · writes:allow" },
  );
  assert.deepEqual(
    buildWorkflowStatusSegments({
      mode: null,
      done: 0,
      total: 0,
      commitMode: "never",
      writeMode: "ask",
    }),
    { mode: "◦ commits:never", profile: "", policy: "commits:never · writes:ask" },
  );
});

test("the status keys are stable", () => {
  assert.deepEqual(WORKFLOW_STATUS_KEYS, {
    mode: "workflow",
    profile: "workflow-profile",
    policy: "workflow-policy",
    review: "workflow-review",
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
