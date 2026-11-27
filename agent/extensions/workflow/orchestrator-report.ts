/**
 * Workflow Extension — Orchestrator child settle report (pure).
 *
 * The child's final assistant message is prose, so the parent cannot reliably
 * distinguish a completed row, a policy-blocked last step, and a child that
 * gave up mid-row. This module turns the child's task-local TODO list
 * plus the policy refusals the controller observed into a small, deterministic
 * status block that `onSettled`/`onError`/`onAborted` prepend to the prose:
 *
 *   Status: settled
 *   Todos: 4/5 completed · 1 cancelled · 0 open
 *   Cancelled: 5. Commit the change (blocked: workflow.commitPolicy=never)
 *   Open: —
 *   Policy refusals: Commit policy is 'never' (workflow.commitPolicy): `git add` is blocked. …
 *   Suggested: External blocker (policy). Do not re-dispatch; mark the row done and record the deviation.
 *
 *   ## Child summary
 *   <the child's own summary>
 *
 * The `Suggested:` line is the executable version of the two-branch rule the
 * parent mission states: an external blocker (a policy refusal or a user-only
 * action) is never re-dispatched; unfinished in-scope work is retried with an
 * amended instruction. It is derived only from facts, never from the model's
 * prose, so the advice cannot contradict the list.
 *
 * Pure and dependency-free (only the shared `TodoItem` type/status helper), so
 * the whole table is unit-tested without a child session.
 */

import { itemStatus, type TodoItem } from "./utils.ts";

export const MAX_REPORT_SUMMARY_CHARS = 8_000;
export const MAX_REPORT_ITEM_CHARS = 120;
export const MAX_REPORT_ITEMS = 20;
export const MAX_REPORT_POLICY_REFUSALS = 3;
export const MAX_REPORT_POLICY_CHARS = 300;

export type ChildOutcome = "settled" | "failed" | "aborted";

export interface ChildReportTodoItem {
  step: number;
  text: string;
}

export interface ChildTodoSummary {
  total: number;
  completed: number;
  cancelled: number;
  /** Pending + in-progress: work the child did not finish. */
  open: number;
  cancelledItems: ChildReportTodoItem[];
  openItems: ChildReportTodoItem[];
}

/**
 * Only the extension's own policy gates produce these prefixes. A failed test,
 * a missing file or a provider error must never be classified as "policy", or
 * the parent would accept a row whose work is genuinely unfinished.
 */
const POLICY_REFUSAL_PATTERN =
  /^(?:Commit|Folder|Write|Read|Permission) policy\b|^Shell guard\b/i;

function cleanText(value: unknown, max: number): string {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** Count and label the child's final list, bounded for a prompt-sized block. */
export function summarizeChildTodos(
  todos: readonly TodoItem[] | undefined,
): ChildTodoSummary {
  const items = Array.isArray(todos) ? todos : [];
  let completed = 0;
  let cancelled = 0;
  let open = 0;
  const cancelledItems: ChildReportTodoItem[] = [];
  const openItems: ChildReportTodoItem[] = [];
  items.forEach((item, index) => {
    if (!item || typeof item.text !== "string") return;
    const status = itemStatus(item);
    const entry: ChildReportTodoItem = {
      step:
        typeof item.step === "number" && Number.isFinite(item.step)
          ? item.step
          : index + 1,
      text: cleanText(item.text, MAX_REPORT_ITEM_CHARS),
    };
    if (!entry.text) return;
    if (status === "completed") {
      completed += 1;
      return;
    }
    if (status === "cancelled") {
      cancelled += 1;
      if (cancelledItems.length < MAX_REPORT_ITEMS) cancelledItems.push(entry);
      return;
    }
    open += 1;
    if (openItems.length < MAX_REPORT_ITEMS) openItems.push(entry);
  });
  return {
    total: items.length,
    completed,
    cancelled,
    open,
    cancelledItems,
    openItems,
  };
}

/** True only for a refusal emitted by one of the Workflow policy gates. */
export function isPolicyRefusal(text: unknown): boolean {
  if (typeof text !== "string") return false;
  return POLICY_REFUSAL_PATTERN.test(text.trim());
}

/** Deduplicate, bound and normalise the refusals the controller observed. */
export function normalizePolicyRefusals(
  refusals: readonly string[] | undefined,
  max = MAX_REPORT_POLICY_REFUSALS,
): string[] {
  if (!Array.isArray(refusals)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of refusals) {
    const text = cleanText(raw, MAX_REPORT_POLICY_CHARS);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  // Keep the most recent refusals: an early, already-fixed denial is noise.
  return out.slice(-Math.max(1, max));
}

function formatItems(items: readonly ChildReportTodoItem[]): string {
  return items.length > 0
    ? items.map((item) => `${item.step}. ${item.text}`).join(" | ")
    : "—";
}

function statusLine(
  outcome: ChildOutcome,
  todos: ChildTodoSummary,
  reason: string | undefined,
): string {
  if (outcome === "failed") {
    return `failed${reason ? ` — ${cleanText(reason, 300)}` : ""}`;
  }
  if (outcome === "aborted") {
    return `aborted${reason ? ` — ${cleanText(reason, 300)}` : ""}`;
  }
  return todos.open > 0
    ? `settled with ${plural(todos.open, "open step", "open steps")}`
    : "settled";
}

/**
 * The deterministic action the parent should take next.
 *
 * This is the two-branch contract: a policy refusal with no open work is an
 * external blocker (never re-dispatch), while open work is in scope (retry with
 * an amended instruction). Mixed cases retry for the open work and record the
 * policy deviation.
 */
export function suggestChildAction(
  outcome: ChildOutcome,
  todos: ChildTodoSummary,
  policyRefusals: readonly string[],
): string {
  if (outcome !== "settled") {
    return "The child did not complete. Retry the row when the blocker is resolved.";
  }
  if (todos.total === 0) {
    return "No child TODO list was reported. Read the summary before accepting.";
  }
  const policy = policyRefusals.length > 0;
  if (todos.open === 0 && policy) {
    return "External blocker (policy). Do not re-dispatch; mark the row done and record the deviation.";
  }
  if (todos.open === 0 && todos.cancelled > 0) {
    return "Complete with cancelled steps. Read them; accept unless they are in-scope work (then retry).";
  }
  if (todos.open === 0) {
    return "Complete. Mark the row done and dispatch the next row.";
  }
  if (policy) {
    return "Mixed: retry for the open work; record the policy refusal as an external deviation.";
  }
  return "Work remains in this row. Retry it with an amended instruction naming the blocker.";
}

export interface ChildReportInput {
  outcome: ChildOutcome;
  reason?: string;
  summary: string;
  todos: readonly TodoItem[] | undefined;
  policyRefusals?: readonly string[];
}

/** Build the report that is stored in the run record and wakes the parent. */
export function buildChildReport(input: ChildReportInput): string {
  const todos = summarizeChildTodos(input.todos);
  const refusals = normalizePolicyRefusals(input.policyRefusals);
  const summary = String(input.summary ?? "").trim();
  const lines = [
    `Status: ${statusLine(input.outcome, todos, input.reason)}`,
    `Todos: ${todos.completed}/${todos.total} completed · ${todos.cancelled} cancelled · ${todos.open} open`,
    `Cancelled: ${formatItems(todos.cancelledItems)}`,
    `Open: ${formatItems(todos.openItems)}`,
    ...(refusals.length > 0
      ? [`Policy refusals: ${refusals.join(" | ")}`]
      : []),
    `Suggested: ${suggestChildAction(input.outcome, todos, refusals)}`,
    "",
    "## Child summary",
    summary
      ? summary.slice(0, MAX_REPORT_SUMMARY_CHARS)
      : "(no final summary)",
  ];
  return lines.join("\n");
}
