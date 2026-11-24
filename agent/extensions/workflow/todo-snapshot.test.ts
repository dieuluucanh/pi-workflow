/**
 * Frozen execution TODO snapshot contract.
 *
 * These tests pin the forward-only row contract: one row per top-level source
 * occurrence, stable ids/refs/text/order, and status-only mutation. They do not
 * exercise the store or the Orchestrator; those are separate seams.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  applyFrozenStatusUpdate,
  createFrozenTodosFromPlan,
  createFrozenTodosFromSteps,
  frozenRowsToTodoItems,
  validateFrozenSnapshot,
  type FrozenTodoSnapshot,
} from "./todo-snapshot.ts";
import {
  extractPlanChecks,
  extractPlanChecksDetailed,
  extractRowMetadata,
} from "./plan-checks.ts";
import type { FrozenWorkspace } from "./orchestrator-workspace-set.ts";

const PATH = "C:/work/.pi/plans/demo.md";

function plan(markdown: string) {
  const result = createFrozenTodosFromPlan({
    planPath: PATH,
    planText: markdown,
    mode: "build",
    now: 1_000,
  });
  if (!result.ok) throw new Error(result.error);
  return result.snapshot;
}

const MULTI_REPO: FrozenWorkspace[] = [
  {
    id: "W",
    key: "git:C:/work",
    root: "C:/work",
    kind: "git",
    displayPath: "C:/work",
    primary: true,
  },
  {
    id: "ERP",
    key: "git:C:/erp",
    root: "C:/erp",
    kind: "git",
    displayPath: "C:/erp",
    primary: false,
  },
];

test("freeze binds every workspace root and keeps the row alias (multi-repo Build)", () => {
  const result = createFrozenTodosFromPlan({
    planPath: PATH,
    planText: [
      "# Plan: Multi",
      "",
      "## Plan Steps",
      "",
      "1. Add the ERP module",
      "   Workspaces: ERP",
      "   Checks:",
      "   - pnpm lint",
      "2. Update the root docs",
      "   Files:",
      "   - README.md",
      "",
    ].join("\n"),
    mode: "build",
    workspaces: MULTI_REPO,
    now: 1_000,
  });
  if (!result.ok) throw new Error(result.error);
  // Every bound root survives the freeze, not just the primary one.
  assert.deepEqual(
    (result.snapshot.workspaces ?? []).map((workspace) => workspace.id),
    ["W", "ERP"],
  );
  assert.deepEqual(result.snapshot.rows[0]?.workspaces, ["ERP"]);
  assert.equal(result.execution?.rows[0]?.checks[0]?.command, "pnpm lint");
  assert.deepEqual(result.snapshot.rows[1]?.workspaces ?? [], []);
});

test("one row per top-level Plan Steps occurrence, in source order", () => {
  const snapshot = plan(
    [
      "# Plan: Demo",
      "",
      "## Plan Steps",
      "",
      "1. Add the first module",
      "2. Add the second module",
      "3. Wire the two modules together",
      "",
    ].join("\n"),
  );
  assert.deepEqual(
    snapshot.rows.map((row) => row.text),
    ["Add the first module", "Add the second module", "Wire the two modules together"],
  );
  assert.deepEqual(snapshot.rows.map((row) => row.ref), ["1", "2", "3"]);
  assert.equal(new Set(snapshot.rows.map((row) => row.id)).size, 3);
  assert.equal(snapshot.source.title, "Demo");
  assert.equal(snapshot.source.digest.length, 64);
});

test("a single numbered step is valid (the old two-row threshold is gone)", () => {
  const snapshot = plan("# Plan: One\n\n## Plan Steps\n\n1. Only step\n");
  assert.equal(snapshot.rows.length, 1);
  assert.equal(snapshot.rows[0]?.text, "Only step");
});

test("repeated and long/Unicode steps stay distinct and unmodified", () => {
  const long = `${"Very long shared prefix ".repeat(20)}—最后一步`;
  const snapshot = plan(
    [
      "# Plan: Duplicates",
      "",
      "## Plan Steps",
      "",
      "1. Same wording",
      "2. Same wording",
      `3. ${long}`,
      "",
    ].join("\n"),
  );
  assert.equal(snapshot.rows.length, 3);
  assert.equal(snapshot.rows[0]?.text, "Same wording");
  assert.equal(snapshot.rows[1]?.text, "Same wording");
  assert.notEqual(snapshot.rows[0]?.id, snapshot.rows[1]?.id, "occurrences get distinct ids");
  assert.equal(snapshot.rows[2]?.text, long, "long/Unicode text is not truncated");
});

test("headings and bold steps win over their numbered body", () => {
  const snapshot = plan(
    [
      "# Plan: Explicit",
      "",
      "## Plan Steps",
      "",
      "### 1. First explicit",
      "1. not a second row",
      "",
      "**2. Second explicit**",
      "2. also not a row",
      "",
    ].join("\n"),
  );
  assert.deepEqual(
    snapshot.rows.map((row) => row.text),
    ["First explicit", "Second explicit"],
  );
  assert.deepEqual(snapshot.rows.map((row) => row.label), ["1", "2"]);
});

test("nested bullets and numbered sub-steps are body context, not rows", () => {
  const snapshot = plan(
    [
      "# Plan: Nested",
      "",
      "## Plan Steps",
      "",
      "1. Parent step",
      "   - nested detail",
      "   1. nested numbered detail",
      "2. Second parent",
      "",
    ].join("\n"),
  );
  assert.deepEqual(
    snapshot.rows.map((row) => row.text),
    ["Parent step", "Second parent"],
  );
});

test("fenced examples never become steps", () => {
  const snapshot = plan(
    [
      "# Plan: Fenced",
      "",
      "## Plan Steps",
      "",
      "```md",
      "1. Example only",
      "2. Not real work",
      "```",
      "",
      "1. Real step",
      "",
    ].join("\n"),
  );
  assert.deepEqual(snapshot.rows.map((row) => row.text), ["Real step"]);
});

test("the fallback skips Context/Verification when there is no Plan Steps heading", () => {
  const snapshot = plan(
    [
      "# Plan: Fallback",
      "",
      "## Context",
      "1. Not work",
      "",
      "## Work",
      "1. Real work",
      "",
      "## Verification",
      "2. Not work either",
      "",
    ].join("\n"),
  );
  assert.deepEqual(snapshot.rows.map((row) => row.text), ["Real work"]);
});

test("checkbox-only plans are preserved, and a missing step list fails closed", () => {
  const snapshot = plan(
    ["# Plan: Boxes", "", "## Plan Steps", "", "- [ ] First", "- [x] Second", ""].join("\n"),
  );
  assert.deepEqual(snapshot.rows.map((row) => row.text), ["First", "Second"]);
  assert.deepEqual(snapshot.rows.map((row) => row.status), ["pending", "pending"]);

  const missing = createFrozenTodosFromPlan({
    planPath: PATH,
    planText: "# Plan: Empty\n\n## Plan Steps\n\nNo steps here.\n",
    mode: "build",
    now: 1,
  });
  assert.equal(missing.ok, false);
  assert.match(missing.ok ? "" : missing.error, /no top-level steps/);
});

test("explicit standalone steps freeze with stable order and no plan binding", () => {
  const result = createFrozenTodosFromSteps({
    title: "Agreed work",
    steps: ["First", "Second", "First"],
    mode: "orchestrator",
    sourceRef: "discussion-123",
    now: 1_000,
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.snapshot.rows.map((row) => row.text), ["First", "Second", "First"]);
  assert.deepEqual(result.snapshot.rows.map((row) => row.ref), ["1", "2", "3"]);
  assert.equal(result.snapshot.rows.every((row) => row.planStepId === undefined), true);
  assert.equal(result.snapshot.source.kind, "steps");
  assert.equal(result.snapshot.mode, "orchestrator");
});

test("status updates are status-only and atomic", () => {
  const snapshot = plan("# Plan: Status\n\n## Plan Steps\n\n1. One\n2. Two\n");
  const running = applyFrozenStatusUpdate(snapshot, [
    { ref: "1", status: "in_progress" },
  ]);
  assert.equal(running.ok, true);
  if (!running.ok) return;
  assert.equal(running.snapshot.rows[0]?.status, "in_progress");
  assert.equal(running.snapshot.rows[1]?.status, "pending");
  assert.deepEqual(
    running.snapshot.rows.map((row) => row.id),
    snapshot.rows.map((row) => row.id),
    "ids are unchanged",
  );
  assert.deepEqual(
    running.snapshot.rows.map((row) => row.text),
    snapshot.rows.map((row) => row.text),
    "text is unchanged",
  );

  const twoRunning = applyFrozenStatusUpdate(running.snapshot, [
    { ref: "2", status: "in_progress" },
  ]);
  assert.equal(twoRunning.ok, false, "at most one row may be in progress");

  const unknown = applyFrozenStatusUpdate(snapshot, [{ id: "todo-missing", status: "completed" }]);
  assert.equal(unknown.ok, false);

  const both = applyFrozenStatusUpdate(snapshot, [{ ref: "1", status: "completed" }, { id: snapshot.rows[1]!.id, status: "completed" }]);
  assert.equal(both.ok, true);
  if (!both.ok) return;
  assert.deepEqual(both.snapshot.rows.map((row) => row.status), ["completed", "completed"]);
});

test("persisted snapshots validate closed and round-trip to TodoItems", () => {
  const snapshot = plan("# Plan: Valid\n\n## Plan Steps\n\n1. One\n");
  const valid = validateFrozenSnapshot(snapshot);
  assert.equal(valid.ok, true);
  const items = frozenRowsToTodoItems(snapshot);
  assert.equal(items[0]?.ref, "1");
  assert.equal(items[0]?.step, 1);
  assert.equal(items[0]?.status, "pending");
  assert.equal(items[0]?.completed, false);
  assert.equal(items[0]?.id, snapshot.rows[0]?.id);

  const badVersion = validateFrozenSnapshot({ ...snapshot, version: 2 });
  assert.equal(badVersion.ok, false);
  const duplicate = validateFrozenSnapshot({
    ...snapshot,
    rows: [snapshot.rows[0], { ...snapshot.rows[0]!, ref: "2" }],
  });
  assert.equal(duplicate.ok, false);
  const gap = validateFrozenSnapshot({
    ...snapshot,
    rows: [{ ...snapshot.rows[0]!, ref: "2" }],
  });
  assert.equal(gap.ok, false);
});

test("a frozen snapshot is not inferred from an arbitrary object", () => {
  const result = validateFrozenSnapshot({ rows: [] } as unknown as FrozenTodoSnapshot);
  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.error, /version/);
});

test("plan checks come only from the Verification section and command lines", () => {
  const checks = extractPlanChecks(
    [
      "# Plan: Checks",
      "",
      "## Verification",
      "",
      "```bash",
      "npm test",
      "cd sub && npm run lint",
      "",
      "This prose must not run.",
      "```",
      "",
      "- `node --test suite.test.ts`",
      "- Not a command: just words",
      "",
      "## Risks",
      "- npm run should-not-run",
      "",
    ].join("\n"),
  );
  assert.deepEqual(checks, ["npm test", "cd sub && npm run lint", "node --test suite.test.ts"]);
});

test("a plan without Verification has no final check commands", () => {
  assert.deepEqual(extractPlanChecks("# Plan: None\n\n## Plan Steps\n\n1. One\n"), []);
});

test("plan checks preserve exact bytes and fail closed on overflow", () => {
  const exact = [
    "# Plan: Exact",
    "",
    "## Verification",
    "",
    "```bash",
    'node -e "console.log(\'a,b;c\')"',
    'node --test "suite with spaces.test.ts"',
    "```",
  ].join("\n");
  assert.deepEqual(extractPlanChecks(exact), [
    'node -e "console.log(\'a,b;c\')"',
    'node --test "suite with spaces.test.ts"',
  ]);

  const overflow = [
    "# Plan: Overflow",
    "",
    "## Verification",
    "```bash",
    ...Array.from({ length: 13 }, (_, i) => `node --test check-${i + 1}.test.ts`),
    "```",
  ].join("\n");
  const detailed = extractPlanChecksDetailed(overflow);
  assert.equal(detailed.ok, false);
  assert.match(detailed.ok ? "" : detailed.error, /more than 12/);

  const tooLong = [
    "# Plan: Long",
    "",
    "## Verification",
    "```bash",
    `node --test ${"x".repeat(4_001)}`,
    "```",
  ].join("\n");
  assert.equal(extractPlanChecksDetailed(tooLong).ok, false);
  assert.equal(
    createFrozenTodosFromPlan({
      planPath: PATH,
      planText: overflow,
      mode: "build",
      now: 1,
    }).ok,
    false,
  );
});

test("row metadata reads only labelled checks/files and their bullets", () => {
  const metadata = extractRowMetadata(
    [
      "Acceptance: first criterion; second criterion",
      "Files: src/a.ts, src/b.ts",
      "",
      "Some prose that is not metadata.",
      "",
      "Checks:",
      "- npm test",
      "- npm run lint",
      "",
    ].join("\n"),
  );
  assert.deepEqual(metadata.acceptanceChecks, [
    "first criterion",
    "second criterion",
    "npm test",
    "npm run lint",
  ]);
  assert.deepEqual(metadata.expectedFiles, ["src/a.ts", "src/b.ts"]);

  const quoted = extractRowMetadata(
    'Acceptance: node -e "console.log(\'a,b;c\')"\n',
  );
  assert.deepEqual(quoted.acceptanceChecks, [
    'node -e "console.log(\'a,b;c\')"',
  ]);
});

test("frozen plan rows carry their body checks/files and the plan final checks", () => {
  const snapshot = plan(
    [
      "# Plan: Metadata",
      "",
      "## Plan Steps",
      "",
      "1. Add the module",
      "   Acceptance: the module exports a value",
      "   Files: src/module.ts, tests/module.test.ts",
      "2. Run the suite",
      "",
      "## Verification",
      "",
      "```bash",
      "npm test",
      "```",
      "",
    ].join("\n"),
  );
  assert.deepEqual(snapshot.rows[0]?.acceptanceChecks, ["the module exports a value"]);
  assert.deepEqual(snapshot.rows[0]?.expectedFiles, ["src/module.ts", "tests/module.test.ts"]);
  assert.deepEqual(snapshot.rows[1]?.acceptanceChecks, []);
  assert.deepEqual(snapshot.planChecks, ["npm test"]);
});
