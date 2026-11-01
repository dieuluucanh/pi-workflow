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

test("plan keeps Plannotator as a mode sub-state", () => {
  assert.deepEqual(
    buildWorkflowStatusSegments({
      mode: "plan",
      plannotatorActive: true,
      done: 1,
      total: 4,
      commitMode: "never",
    }),
    {
      mode: "⏸ plan — reviewing in browser 1/4",
      profile: "",
      policy: "commits:never",
    },
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
