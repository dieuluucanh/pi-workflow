import { test } from "node:test";
import assert from "node:assert/strict";

import { rebindLegacyTodosToPlan } from "./legacy-recovery.ts";
import { createFrozenTodosFromPlan } from "./todo-snapshot.ts";
import { HISTORICAL_22_STEP_PLAN } from "./test-support.ts";
import type { TodoItem } from "./utils.ts";

function legacy(
  row: { ref: string; text: string; planStepId?: string },
  status: TodoItem["status"],
): TodoItem {
  return {
    step: Number(row.ref),
    ref: row.ref,
    text: row.text,
    completed: status === "completed",
    status,
    ...(row.planStepId ? { planStepId: row.planStepId } : {}),
  };
}

test("rebind: a shortened remaining list restores all 22 refs", () => {
  const full = createFrozenTodosFromPlan({
    planPath: "C:/work/.pi/plans/twenty-two.md",
    planText: HISTORICAL_22_STEP_PLAN,
    mode: "build",
    now: 1,
  });
  assert.equal(full.ok, true);
  if (!full.ok) return;
  const selected = full.snapshot.rows.filter((row) =>
    ["9", "15", "16", "17", "18", "19", "20", "21", "22"].includes(row.ref),
  );
  const prior = selected.map((row, index) =>
    legacy(row, index === 0 ? "in_progress" : "completed"),
  );
  const rebound = rebindLegacyTodosToPlan({
    planPath: "C:/work/.pi/plans/twenty-two.md",
    planText: HISTORICAL_22_STEP_PLAN,
    priorItems: prior,
    now: 2,
  });
  assert.equal(rebound.ok, true);
  if (!rebound.ok) return;
  assert.equal(rebound.snapshot.rows.length, 22);
  assert.deepEqual(
    rebound.snapshot.rows.map((row) => row.ref),
    Array.from({ length: 22 }, (_, i) => String(i + 1)),
  );
  assert.equal(rebound.snapshot.rows.find((row) => row.ref === "9")?.status, "in_progress");
  assert.equal(rebound.snapshot.rows.find((row) => row.ref === "15")?.status, "completed");
  assert.equal(rebound.snapshot.rows.find((row) => row.ref === "1")?.status, "pending");
});

test("rebind: idempotent and preserves statuses on a second pass", () => {
  const first = rebindLegacyTodosToPlan({
    planPath: "C:/work/.pi/plans/twenty-two.md",
    planText: HISTORICAL_22_STEP_PLAN,
    priorItems: [
      { step: 9, ref: "9", text: "Implement synthetic step 9 in module-09.ts", completed: false, status: "in_progress" },
    ],
    now: 1,
  });
  assert.equal(first.ok, true);
  if (!first.ok) return;
  const second = rebindLegacyTodosToPlan({
    planPath: "C:/work/.pi/plans/twenty-two.md",
    planText: HISTORICAL_22_STEP_PLAN,
    priorItems: first.snapshot.rows.map((row) => ({
      step: Number(row.ref),
      ref: row.ref,
      text: row.text,
      completed: row.status === "completed",
      status: row.status,
      ...(row.planStepId ? { planStepId: row.planStepId } : {}),
    })),
    now: 2,
  });
  assert.equal(second.ok, true);
  if (!second.ok) return;
  assert.deepEqual(
    second.snapshot.rows.map((row) => [row.ref, row.status]),
    first.snapshot.rows.map((row) => [row.ref, row.status]),
  );
});

test("rebind: duplicate text without plan identity fails closed", () => {
  const plan = "# Plan: Duplicate\n\n## Plan Steps\n\n1. Same\n2. Same\n";
  const result = rebindLegacyTodosToPlan({
    planPath: "C:/work/duplicate.md",
    planText: plan,
    priorItems: [
      { step: 1, ref: "1", text: "Same", completed: true, status: "completed" },
      { step: 2, ref: "2", text: "Same", completed: false, status: "pending" },
    ],
    now: 1,
  });
  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.error, /ambiguous/);
});

test("rebind: an unreadable or invalid plan fails closed", () => {
  const result = rebindLegacyTodosToPlan({
    planPath: "",
    planText: "",
    priorItems: [],
  });
  assert.equal(result.ok, false);
});
