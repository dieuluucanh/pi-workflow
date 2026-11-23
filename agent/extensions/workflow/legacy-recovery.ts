/**
 * Workflow Extension — bounded legacy TODO rebinding.
 *
 * Older sessions stored a mutable list that a model may have shortened to
 * "remaining steps". Freezing that shortened list would permanently lose the
 * plan's original refs. This module rebuilds the full frozen rows from the
 * approved plan, then transfers only unambiguous statuses from the legacy rows.
 * It never infers a plan from chat and never executes anything.
 */

import {
  createFrozenTodosFromPlan,
  type FrozenTodoResult,
  type FrozenTodoRow,
} from "./todo-snapshot.ts";
import { itemStatus, todoKey, todoRef, type TodoItem } from "./utils.ts";

export interface LegacyRebindInput {
  planPath: string;
  planText: string;
  priorItems: readonly TodoItem[];
  now?: number;
  executionId?: string;
}

function rowStatus(item: TodoItem): FrozenTodoRow["status"] {
  const status = itemStatus(item);
  return status === "completed" || status === "cancelled" || status === "in_progress"
    ? status
    : "pending";
}

function addToIndex(
  index: Map<string, TodoItem[]>,
  key: string | undefined,
  item: TodoItem,
): void {
  if (!key) return;
  const list = index.get(key) ?? [];
  list.push(item);
  index.set(key, list);
}

/**
 * Rebuild all plan rows and transfer legacy statuses by stable identity.
 *
 * Matching order:
 *   1. `planStepId` (the durable source occurrence identity);
 *   2. normalized text + group (the older list's only identity);
 *   3. ref, only when the legacy list has the full row count. A shortened
 *      remaining-steps list must never be matched by its new local numbers.
 *
 * If one row would inherit conflicting statuses, the whole migration fails
 * closed; the caller keeps the legacy list and reports a diagnostic.
 */
export function rebindLegacyTodosToPlan(
  input: LegacyRebindInput,
): FrozenTodoResult {
  const created = createFrozenTodosFromPlan({
    planPath: input.planPath,
    planText: input.planText,
    mode: "build",
    ...(input.now === undefined ? {} : { now: input.now }),
    ...(input.executionId === undefined
      ? {}
      : { executionId: input.executionId }),
  });
  if (!created.ok) return created;

  const byPlanId = new Map<string, TodoItem[]>();
  const byKey = new Map<string, TodoItem[]>();
  for (const item of input.priorItems) {
    addToIndex(byPlanId, item.planStepId, item);
    addToIndex(byKey, todoKey(item), item);
  }
  const fullList = input.priorItems.length === created.snapshot.rows.length;
  const ambiguous: string[] = [];

  const rows = created.snapshot.rows.map((row) => {
    const planMatches = row.planStepId
      ? (byPlanId.get(row.planStepId) ?? [])
      : [];
    const keyMatches = byKey.get(todoKey({ text: row.text, group: row.group })) ?? [];
    let matches = planMatches.length > 0 ? planMatches : keyMatches;
    if (matches.length === 0 && fullList) {
      const byRef = input.priorItems.find((item) => todoRef(item) === row.ref);
      if (byRef) matches = [byRef];
    }
    if (matches.length === 0) return row;
    const statuses = new Set(matches.map(rowStatus));
    if (statuses.size > 1) {
      ambiguous.push(row.ref);
      return row;
    }
    return { ...row, status: rowStatus(matches[0]!) };
  });

  if (ambiguous.length > 0) {
    return {
      ok: false,
      error: `ambiguous legacy status mapping for row(s) ${ambiguous.join(", ")}`,
    };
  }
  return {
    ok: true,
    snapshot: { ...created.snapshot, rows },
  };
}
