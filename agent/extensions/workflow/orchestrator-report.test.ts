/**
 * Orchestrator child report contract.
 *
 * The report is the parent's only reliable signal that a settle is complete,
 * blocked by policy (external) or unfinished (in scope). These tests pin the
 * deterministic `Status:`/`Suggested:` table and the bounding, because a wrong
 * suggestion would make the parent either re-run a blocked row forever or
 * accept unfinished work.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_REPORT_POLICY_CHARS,
  MAX_REPORT_SUMMARY_CHARS,
  buildChildReport,
  isPolicyRefusal,
  normalizePolicyRefusals,
  suggestChildAction,
  summarizeChildTodos,
} from "./orchestrator-report.ts";
import type { TodoItem } from "./utils.ts";

function todo(
  step: number,
  text: string,
  status: "pending" | "in_progress" | "completed" | "cancelled",
): TodoItem {
  return {
    step,
    text,
    status,
    completed: status === "completed",
  };
}

test("summary counts completed, cancelled and open items in list order", () => {
  const summary = summarizeChildTodos([
    todo(1, "Read the code", "completed"),
    todo(2, "Write the change", "in_progress"),
    todo(3, "Commit the change (blocked: commitPolicy=never)", "cancelled"),
    todo(4, "Update the docs", "pending"),
  ]);
  assert.deepEqual(
    {
      total: summary.total,
      completed: summary.completed,
      cancelled: summary.cancelled,
      open: summary.open,
    },
    { total: 4, completed: 1, cancelled: 1, open: 2 },
  );
  assert.deepEqual(summary.cancelledItems, [
    { step: 3, text: "Commit the change (blocked: commitPolicy=never)" },
  ]);
  assert.deepEqual(summary.openItems, [
    { step: 2, text: "Write the change" },
    { step: 4, text: "Update the docs" },
  ]);
});

test("summary tolerates legacy items, bad text and a missing list", () => {
  assert.equal(summarizeChildTodos(undefined).total, 0);
  const summary = summarizeChildTodos([
    { step: 1, text: "  legacy   done ", completed: true } as TodoItem,
    { step: 2, text: "   ", completed: false } as TodoItem,
    null as unknown as TodoItem,
  ]);
  assert.equal(summary.completed, 1);
  assert.equal(summary.open, 0, "an empty-text item is not work");
  assert.equal(summary.total, 3);
});

test("policy refusal detection matches only the workflow gates", () => {
  for (const text of [
    "Commit policy is 'never' (workflow.commitPolicy): `git add` is blocked.",
    "Folder policy: `secrets/` is excluded by workflow.folderPolicy.excludePaths",
    "Write policy (workflow.writePolicy) could not be evaluated",
    "Read policy 'ask': the user declined this read",
    "Permission policy 'ask': the user declined this write",
    "Shell guard: the request budget is exhausted",
  ]) {
    assert.equal(isPolicyRefusal(text), true, text);
  }
  for (const text of [
    "TypeError: x is not a function",
    "Test Files 1 failed | 4 passed",
    "Command exited with code 1",
    "The commit policy is never, so I stopped", // mid-sentence prose is not a gate refusal
    "",
  ]) {
    assert.equal(isPolicyRefusal(text), false, text);
  }
  assert.equal(isPolicyRefusal(undefined), false);
});

test("policy refusals are deduped, bounded and keep the most recent", () => {
  const long = `Commit policy is 'never': ${"x".repeat(500)}`;
  const normalized = normalizePolicyRefusals([
    "Commit policy is 'never': first",
    "Commit policy is 'never': first",
    "Folder policy: second",
    long,
    "Write policy: fourth",
  ]);
  assert.equal(normalized.length, 3);
  assert.equal(normalized[0], "Folder policy: second");
  assert.equal(normalized[1]?.startsWith("Commit policy is 'never': xxx"), true);
  assert.equal(normalized[1]?.length, MAX_REPORT_POLICY_CHARS);
  assert.equal(normalized[2], "Write policy: fourth");
  assert.deepEqual(normalizePolicyRefusals(undefined), []);
});

test("the suggested action table implements the two branches", () => {
  const empty = summarizeChildTodos([]);
  const complete = summarizeChildTodos([todo(1, "a", "completed")]);
  const cancelled = summarizeChildTodos([
    todo(1, "a", "completed"),
    todo(2, "Commit (policy)", "cancelled"),
  ]);
  const open = summarizeChildTodos([todo(1, "Write", "in_progress")]);
  const refused = ["Commit policy is 'never': blocked"];

  assert.match(
    suggestChildAction("settled", empty, []),
    /No child TODO list was reported/,
  );
  assert.match(
    suggestChildAction("settled", complete, []),
    /Complete\. Mark the row done/,
  );
  assert.match(
    suggestChildAction("settled", cancelled, []),
    /Complete with cancelled steps/,
  );
  assert.match(
    suggestChildAction("settled", complete, refused),
    /External blocker \(policy\)\. Do not re-dispatch/,
  );
  assert.match(
    suggestChildAction("settled", open, []),
    /Work remains in this row\. Retry it with an amended instruction/,
  );
  assert.match(
    suggestChildAction("settled", open, refused),
    /Mixed: retry for the open work/,
  );
  assert.match(
    suggestChildAction("failed", open, refused),
    /The child did not complete/,
  );
  assert.match(
    suggestChildAction("aborted", empty, []),
    /The child did not complete/,
  );
});

test("a settled report renders status, todo facts, suggestion and summary", () => {
  const report = buildChildReport({
    outcome: "settled",
    summary: "Row 1 done. Not committed: the commit policy is 'never'.",
    todos: [
      todo(1, "Read the code", "completed"),
      todo(2, "Write the change", "completed"),
      todo(3, "Commit the change (blocked: commitPolicy=never)", "cancelled"),
    ],
    policyRefusals: [
      "Commit policy is 'never' (workflow.commitPolicy): `git add` is blocked.",
    ],
  });
  assert.match(report, /^Status: settled$/m);
  assert.match(report, /^Todos: 2\/3 completed · 1 cancelled · 0 open$/m);
  assert.match(report, /^Cancelled: 3\. Commit the change/m);
  assert.match(report, /^Open: —$/m);
  assert.match(report, /^Policy refusals: Commit policy is 'never'/m);
  assert.match(report, /^Suggested: External blocker \(policy\)/m);
  assert.match(report, /## Child summary\nRow 1 done\. Not committed/);
  assert.doesNotMatch(report, /acceptance/i);
});

test("a settled report with open work and no policy refusal is in scope", () => {
  const report = buildChildReport({
    outcome: "settled",
    summary: "I ran out of time.",
    todos: [
      todo(1, "Done", "completed"),
      todo(2, "Wire the route", "pending"),
    ],
  });
  assert.match(report, /^Status: settled with 1 open step$/m);
  assert.match(report, /^Open: 2\. Wire the route$/m);
  assert.doesNotMatch(report, /Policy refusals:/);
  assert.match(report, /^Suggested: Work remains in this row\./m);
  assert.doesNotMatch(report, /External blocker/);
});

test("failure and abort outcomes are named and never suggest acceptance", () => {
  const failed = buildChildReport({
    outcome: "failed",
    reason: "provider retry budget exhausted",
    summary: "",
    todos: [todo(1, "Do it", "in_progress")],
  });
  assert.match(failed, /^Status: failed — provider retry budget exhausted$/m);
  assert.match(failed, /^Suggested: The child did not complete\./m);
  assert.match(failed, /## Child summary\n\(no final summary\)/);

  const aborted = buildChildReport({
    outcome: "aborted",
    reason: "parent abort",
    summary: "",
    todos: [],
  });
  assert.match(aborted, /^Status: aborted — parent abort$/m);
  assert.match(aborted, /^Suggested: The child did not complete\./m);
});

test("the summary is bounded without dropping the status block", () => {
  const report = buildChildReport({
    outcome: "settled",
    summary: "s".repeat(MAX_REPORT_SUMMARY_CHARS + 500),
    todos: [todo(1, "done", "completed")],
  });
  assert.ok(report.length < MAX_REPORT_SUMMARY_CHARS + 1_000);
  const summary = report.split("## Child summary\n")[1] ?? "";
  assert.equal(summary.length, MAX_REPORT_SUMMARY_CHARS);
  assert.match(report, /^Status: settled$/m);
});
