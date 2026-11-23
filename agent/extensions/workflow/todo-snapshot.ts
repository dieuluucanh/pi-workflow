/**
 * Workflow Extension — frozen execution TODO snapshot.
 *
 * Build and Orchestrator share one row contract: a plan (or an explicitly
 * agreed list) is converted ONCE into stable rows, then only status changes.
 * The snapshot is pure data; it owns row identity, order, wording, refs and
 * the row-level check/file metadata. It never reads a plan again.
 *
 * This module deliberately does NOT reuse `parseStepsFromLines`: that parser
 * normalizes, truncates and dedupes by display text, which would make a lost
 * source step permanent once frozen. The extractor below keeps every
 * top-level source occurrence and only ignores nested body content.
 */

import { createHash } from "node:crypto";

import {
  extractPlanChecksDetailed,
  extractRowMetadata,
} from "./plan-checks.ts";
import {
  planStepIdFor,
  todoItemId,
  type TodoItem,
  type TodoStatus,
} from "./utils.ts";

export const FROZEN_TODO_SCHEMA_VERSION = 1 as const;

export type FrozenTodoMode = "build" | "orchestrator";
export type FrozenTodoSourceKind = "plan" | "steps" | "discussion";

export const FROZEN_TODO_STATUSES: readonly TodoStatus[] = [
  "pending",
  "in_progress",
  "completed",
  "cancelled",
];

export interface FrozenTodoRow {
  /** Durable row identity; never derived from the current position. */
  id: string;
  /** Display ref 1..N, assigned once and never recomputed. */
  ref: string;
  text: string;
  label?: string;
  group?: string;
  source: "plan" | "steps";
  /** Plan binding; absent on explicit standalone steps. */
  planStepId?: string;
  acceptanceChecks: string[];
  expectedFiles: string[];
  status: TodoStatus;
  /** 1-based source line, when the row came from a plan. */
  sourceLine?: number;
}

export interface FrozenTodoSnapshot {
  version: typeof FROZEN_TODO_SCHEMA_VERSION;
  executionId: string;
  mode: FrozenTodoMode;
  source: {
    kind: FrozenTodoSourceKind;
    path?: string;
    digest: string;
    title: string;
  };
  rows: FrozenTodoRow[];
  /** Plan-level final-gate commands; per-row checks live on the row. */
  planChecks: string[];
  createdAt: number;
}

export type FrozenTodoResult =
  | { ok: true; snapshot: FrozenTodoSnapshot }
  | { ok: false; error: string };

export interface FrozenTodoBuildInput {
  mode: FrozenTodoMode;
  executionId?: string;
  now?: number;
  /** Optional plan-level checks; the caller may fill these later. */
  planChecks?: readonly string[];
}

// ── Parsing ──────────────────────────────────────────────────────────

interface Line {
  number: number;
  text: string;
  fenced: boolean;
}

const HEADING = /^(#{1,6})\s+(.+?)\s*$/;
const NUMBERED = /^(\d+(?:\.\d+)*)[.)]\s+(.+?)\s*$/;
const STEP_HEADING = /^(?:step\s+)?(\d+(?:\.\d+)*)[.):]?\s+(.+?)\s*$/i;
const BOLD = /^\*\*(.+?)\*\*\s*$/;
const BOLD_BULLET = /^[-*]\s+\*\*(.+?)\*\*\s*$/;
const CHECKBOX = /^[-*]\s+\[([ xX])\]\s+(.+?)\s*$/;
const EXCLUDED_SECTION =
  /^(context|decisions?|exploration|risks?|verification|non[- ]?goals?|out of scope|notes?|summary)$/i;

function scanLines(markdown: string): Line[] {
  const lines: Line[] = [];
  let fence: string | undefined;
  const raw = markdown.split(/\r?\n/);
  for (let index = 0; index < raw.length; index += 1) {
    const text = raw[index] ?? "";
    const trimmed = text.trimStart();
    const marker = trimmed.startsWith("```")
      ? "```"
      : trimmed.startsWith("~~~")
        ? "~~~"
        : undefined;
    if (marker && fence === undefined) {
      fence = marker;
      lines.push({ number: index + 1, text, fenced: true });
      continue;
    }
    if (marker && fence === marker) {
      fence = undefined;
      lines.push({ number: index + 1, text, fenced: true });
      continue;
    }
    lines.push({ number: index + 1, text, fenced: fence !== undefined });
  }
  return lines;
}

function headingOf(line: Line): { level: number; title: string } | undefined {
  if (line.fenced) return undefined;
  const match = HEADING.exec(line.text);
  if (!match) return undefined;
  return { level: match[1]!.length, title: match[2]!.trim() };
}

function labelOf(text: string): { label?: string; text: string } {
  const step = STEP_HEADING.exec(text.trim());
  if (step) return { label: step[1], text: step[2]!.trim() };
  return { text: text.trim() };
}

function cleanStepText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function sectionBounds(lines: Line[]): { start: number; end: number } | "ambiguous" | undefined {
  const matches = lines
    .map((line, index) => ({ index, heading: headingOf(line) }))
    .filter(
      (entry) =>
        entry.heading !== undefined &&
        entry.heading.level >= 2 &&
        entry.heading.level <= 4 &&
        /plan\s+steps/i.test(entry.heading.title),
    );
  if (matches.length > 1) return "ambiguous";
  const found = matches[0];
  if (!found?.heading) return undefined;
  let end = lines.length;
  for (let index = found.index + 1; index < lines.length; index += 1) {
    const heading = headingOf(lines[index]!);
    if (heading && heading.level <= found.heading.level) {
      end = index;
      break;
    }
  }
  return { start: found.index + 1, end };
}

function excludedFallbackLine(
  line: Line,
  stack: Array<{ level: number; title: string }>,
): boolean {
  const heading = headingOf(line);
  if (heading) {
    while (stack.length > 0 && stack.at(-1)!.level >= heading.level) stack.pop();
    if (EXCLUDED_SECTION.test(heading.title)) {
      stack.push({ level: heading.level, title: heading.title });
      return true;
    }
    return stack.length > 0;
  }
  return stack.length > 0;
}

interface RawStep {
  text: string;
  label?: string;
  group?: string;
  sourceLine: number;
  body: string[];
  acceptanceChecks?: string[];
  expectedFiles?: string[];
}

function parsePlanSteps(markdown: string):
  | { ok: true; rows: RawStep[]; title: string }
  | { ok: false; error: string } {
  const lines = scanLines(markdown);
  const title =
    lines
      .map((line) => headingOf(line))
      .find((heading) => heading?.level === 1)
      ?.title.replace(/^Plan:\s*/i, "")
      .trim() || "Plan";
  const bounds = sectionBounds(lines);
  if (bounds === "ambiguous") {
    return { ok: false, error: "the plan has more than one Plan Steps section" };
  }
  const relevant =
    bounds === undefined
      ? (() => {
          const kept: Line[] = [];
          const stack: Array<{ level: number; title: string }> = [];
          for (const line of lines) {
            if (!excludedFallbackLine(line, stack)) kept.push(line);
          }
          return kept;
        })()
      : lines.slice(bounds.start, bounds.end);
  const body = relevant.filter((line) => !line.fenced);
  const groupStack: Array<{ level: number; title: string }> = [];

  const pushGroup = (heading: { level: number; title: string }): void => {
    while (groupStack.length > 0 && groupStack.at(-1)!.level >= heading.level) {
      groupStack.pop();
    }
    groupStack.push(heading);
  };
  const group = (): string | undefined =>
    groupStack.length > 0
      ? groupStack.map((entry) => entry.title).join(" / ")
      : undefined;

  const hasExplicit = body.some((line) => {
    const heading = headingOf(line);
    if (heading && labelOf(heading.title).label) return true;
    return BOLD.test(line.text) || BOLD_BULLET.test(line.text);
  });
  const hasNumbered = body.some((line) => NUMBERED.test(line.text));
  const hasCheckbox = body.some((line) => CHECKBOX.test(line.text));
  const mode = hasExplicit ? "explicit" : hasNumbered ? "numbered" : hasCheckbox ? "checkbox" : undefined;
  if (mode === undefined) {
    return { ok: false, error: "the plan has no top-level steps in the Plan Steps section" };
  }

  const rows: RawStep[] = [];
  let current: RawStep | undefined;
  const push = (step: Omit<RawStep, "body">): void => {
    const next: RawStep = { ...step, body: [] };
    rows.push(next);
    current = next;
  };
  const bodyLine = (text: string): void => {
    if (current) current.body.push(text);
  };

  for (const line of body) {
    const heading = headingOf(line);
    if (heading) {
      if (heading.level === 1 && /^plan:/i.test(heading.title)) continue;
      const labelled = labelOf(heading.title);
      if (mode === "explicit" && labelled.label) {
        push({
          text: cleanStepText(labelled.text),
          label: labelled.label,
          ...(group() === undefined ? {} : { group: group() }),
          sourceLine: line.number,
        });
        continue;
      }
      if (!/plan\s+steps/i.test(heading.title)) {
        pushGroup({ level: heading.level, title: heading.title });
        current = undefined;
      }
      continue;
    }

    if (mode === "explicit") {
      const bold = BOLD.exec(line.text) ?? BOLD_BULLET.exec(line.text);
      if (bold) {
        const labelled = labelOf(bold[1]!);
        push({
          text: cleanStepText(labelled.text),
          ...(labelled.label === undefined ? {} : { label: labelled.label }),
          ...(group() === undefined ? {} : { group: group() }),
          sourceLine: line.number,
        });
        continue;
      }
      bodyLine(line.text);
      continue;
    }

    if (mode === "numbered") {
      const numberedMatch = NUMBERED.exec(line.text);
      if (numberedMatch) {
        push({
          text: cleanStepText(numberedMatch[2]!),
          label: numberedMatch[1]!,
          ...(group() === undefined ? {} : { group: group() }),
          sourceLine: line.number,
        });
        continue;
      }
      bodyLine(line.text);
      continue;
    }

    const checkbox = CHECKBOX.exec(line.text);
    if (checkbox) {
      push({
        text: cleanStepText(checkbox[2]!),
        ...(group() === undefined ? {} : { group: group() }),
        sourceLine: line.number,
      });
      continue;
    }
    bodyLine(line.text);
  }

  const withMetadata = rows.map((raw) => {
    const metadata = extractRowMetadata(raw.body.join("\n"));
    return { ...raw, ...metadata };
  });
  const metadataError = withMetadata.find((row) => row.error)?.error;
  if (metadataError) {
    return { ok: false, error: metadataError };
  }
  return { ok: true, rows: withMetadata, title };
}

function digestOf(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function unique(base: string, used: Set<string>): string {
  const count = [...used].filter((value) => value === base || value.startsWith(`${base}-`)).length;
  const id = count === 0 ? base : `${base}-${count + 1}`;
  used.add(id);
  return id;
}

function buildSnapshot(input: {
  mode: FrozenTodoMode;
  executionId?: string;
  now?: number;
  source: FrozenTodoSnapshot["source"];
  rows: RawStep[];
  planChecks?: readonly string[];
}): FrozenTodoSnapshot {
  const now = input.now ?? Date.now();
  const usedIds = new Set<string>();
  const usedPlanIds = new Set<string>();
  const rows = input.rows.map((raw, index) => {
    const label = raw.label ?? String(index + 1);
    const base = {
      text: raw.text,
      ...(raw.group === undefined ? {} : { group: raw.group }),
      label,
    };
    const id = unique(todoItemId(base), usedIds);
    const planId =
      input.source.kind === "plan"
        ? unique(planStepIdFor({ ...base, planStepId: undefined }), usedPlanIds)
        : undefined;
    return {
      id,
      ref: String(index + 1),
      text: raw.text,
      label,
      ...(raw.group === undefined ? {} : { group: raw.group }),
      source: input.source.kind === "plan" ? ("plan" as const) : ("steps" as const),
      ...(planId === undefined ? {} : { planStepId: planId }),
      acceptanceChecks: [...(raw.acceptanceChecks ?? [])],
      expectedFiles: [...(raw.expectedFiles ?? [])],
      status: "pending" as const,
      sourceLine: raw.sourceLine,
    } satisfies FrozenTodoRow;
  });
  return {
    version: FROZEN_TODO_SCHEMA_VERSION,
    executionId: input.executionId ?? `todo-exec-${input.source.digest.slice(0, 12)}-${now}`,
    mode: input.mode,
    source: input.source,
    rows,
    planChecks: [...(input.planChecks ?? [])],
    createdAt: now,
  };
}

/**
 * Convert an approved plan into frozen rows. One row per top-level source
 * occurrence, in source order; no text dedupe, no truncation, no renumbering.
 */
export function createFrozenTodosFromPlan(
  input: FrozenTodoBuildInput & { planPath: string; planText: string },
): FrozenTodoResult {
  if (typeof input.planPath !== "string" || input.planPath.trim().length === 0) {
    return { ok: false, error: "a plan path is required" };
  }
  if (typeof input.planText !== "string" || input.planText.trim().length === 0) {
    return { ok: false, error: "the plan is empty" };
  }
  const parsed = parsePlanSteps(input.planText);
  if (!parsed.ok) return parsed;
  const extracted = extractPlanChecksDetailed(input.planText);
  if (!extracted.ok) return { ok: false, error: extracted.error };
  return {
    ok: true,
    snapshot: buildSnapshot({
      mode: input.mode,
      ...(input.executionId === undefined ? {} : { executionId: input.executionId }),
      ...(input.now === undefined ? {} : { now: input.now }),
      source: {
        kind: "plan",
        path: input.planPath,
        digest: digestOf(input.planText),
        title: parsed.title,
      },
      rows: parsed.rows,
      planChecks: extracted.checks,
      ...(input.planChecks === undefined ? {} : { planChecks: input.planChecks }),
    }),
  };
}

/**
 * Freeze an explicitly agreed standalone list. This is the no-plan route:
 * the model/user agreed the steps, so their wording/order is the contract.
 */
export function createFrozenTodosFromSteps(
  input: FrozenTodoBuildInput & {
    title: string;
    steps: readonly string[];
    sourceRef?: string;
  },
): FrozenTodoResult {
  const title = input.title.trim();
  if (!title) return { ok: false, error: "a title is required" };
  const steps = input.steps
    .map((step) => step.replace(/\s+/g, " ").trim())
    .filter((step) => step.length > 0);
  if (steps.length === 0) return { ok: false, error: "at least one step is required" };
  if (steps.length > 200) return { ok: false, error: "the list is too long (max 200 steps)" };
  const payload = JSON.stringify({ title, steps, sourceRef: input.sourceRef ?? null });
  return {
    ok: true,
    snapshot: buildSnapshot({
      mode: input.mode,
      ...(input.executionId === undefined ? {} : { executionId: input.executionId }),
      ...(input.now === undefined ? {} : { now: input.now }),
      source: {
        kind: "steps",
        ...(input.sourceRef === undefined ? {} : { path: input.sourceRef }),
        digest: digestOf(payload),
        title,
      },
      rows: steps.map((text, index) => ({ text, label: String(index + 1), sourceLine: index + 1, body: [] })),
      ...(input.planChecks === undefined ? {} : { planChecks: input.planChecks }),
    }),
  };
}

/**
 * Validate a persisted snapshot. A missing/unsupported shape fails closed; the
 * caller must never infer a frozen list from legacy mutable rows.
 */
export function validateFrozenSnapshot(value: unknown): FrozenTodoResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: "the frozen snapshot is not an object" };
  }
  const record = value as Record<string, unknown>;
  if (record.version !== FROZEN_TODO_SCHEMA_VERSION) {
    return { ok: false, error: `unsupported frozen snapshot version ${String(record.version)}` };
  }
  if (typeof record.executionId !== "string" || record.executionId.trim().length === 0) {
    return { ok: false, error: "the frozen snapshot has no execution id" };
  }
  if (record.mode !== "build" && record.mode !== "orchestrator") {
    return { ok: false, error: "the frozen snapshot has an unknown mode" };
  }
  const source = record.source;
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    return { ok: false, error: "the frozen snapshot has no source" };
  }
  const sourceRecord = source as Record<string, unknown>;
  if (
    (sourceRecord.kind !== "plan" && sourceRecord.kind !== "steps" && sourceRecord.kind !== "discussion") ||
    typeof sourceRecord.digest !== "string" ||
    typeof sourceRecord.title !== "string"
  ) {
    return { ok: false, error: "the frozen snapshot source is invalid" };
  }
  if (!Array.isArray(record.rows) || record.rows.length === 0) {
    return { ok: false, error: "the frozen snapshot has no rows" };
  }
  if (record.rows.length > 500) return { ok: false, error: "the frozen snapshot has too many rows" };
  const ids = new Set<string>();
  const refs = new Set<string>();
  let inProgress = 0;
  for (const [index, rowValue] of record.rows.entries()) {
    if (!rowValue || typeof rowValue !== "object" || Array.isArray(rowValue)) {
      return { ok: false, error: `row ${index + 1} is invalid` };
    }
    const row = rowValue as Record<string, unknown>;
    if (typeof row.id !== "string" || row.id.length === 0 || ids.has(row.id)) {
      return { ok: false, error: `row ${index + 1} has a missing/duplicate id` };
    }
    ids.add(row.id);
    const expectedRef = String(index + 1);
    if (typeof row.ref !== "string" || row.ref !== expectedRef || refs.has(row.ref)) {
      return { ok: false, error: `row ${index + 1} has an invalid ref` };
    }
    refs.add(row.ref);
    if (typeof row.text !== "string" || row.text.trim().length === 0) {
      return { ok: false, error: `row ${index + 1} has no text` };
    }
    if (!FROZEN_TODO_STATUSES.includes(row.status as TodoStatus)) {
      return { ok: false, error: `row ${index + 1} has an invalid status` };
    }
    if (row.status === "in_progress") inProgress += 1;
    if (!Array.isArray(row.acceptanceChecks) || row.acceptanceChecks.some((c) => typeof c !== "string")) {
      return { ok: false, error: `row ${index + 1} has invalid checks` };
    }
    if (!Array.isArray(row.expectedFiles) || row.expectedFiles.some((f) => typeof f !== "string")) {
      return { ok: false, error: `row ${index + 1} has invalid files` };
    }
  }
  if (inProgress > 1) return { ok: false, error: "more than one row is in progress" };
  if (!Array.isArray(record.planChecks) || record.planChecks.some((c) => typeof c !== "string")) {
    return { ok: false, error: "the frozen snapshot has invalid plan checks" };
  }
  return { ok: true, snapshot: value as FrozenTodoSnapshot };
}

export interface FrozenStatusUpdate {
  id?: string;
  ref?: string;
  status: TodoStatus;
}

/**
 * Status-only mutation. Structure (ids/refs/order/text) is immutable; omitted
 * rows keep their status. The whole batch is atomic.
 */
export function applyFrozenStatusUpdate(
  snapshot: FrozenTodoSnapshot,
  updates: readonly FrozenStatusUpdate[],
): FrozenTodoResult {
  const byId = new Map(snapshot.rows.map((row) => [row.id, row]));
  const byRef = new Map(snapshot.rows.map((row) => [row.ref, row]));
  const nextStatus = new Map<string, TodoStatus>();
  for (const update of updates) {
    if (!FROZEN_TODO_STATUSES.includes(update.status)) {
      return { ok: false, error: `invalid status ${String(update.status)}` };
    }
    const id = typeof update.id === "string" ? update.id : undefined;
    const ref = typeof update.ref === "string" ? update.ref : undefined;
    if ((id === undefined) === (ref === undefined)) {
      return { ok: false, error: "each update must name exactly one id or ref" };
    }
    const row = id !== undefined ? byId.get(id) : byRef.get(ref!);
    if (!row) return { ok: false, error: `unknown row ${id ?? ref}` };
    if (nextStatus.has(row.id)) return { ok: false, error: `duplicate update for ${row.id}` };
    nextStatus.set(row.id, update.status);
  }
  const rows = snapshot.rows.map((row) => ({
    ...row,
    status: nextStatus.get(row.id) ?? row.status,
  }));
  if (rows.filter((row) => row.status === "in_progress").length > 1) {
    return { ok: false, error: "more than one row is in progress" };
  }
  return {
    ok: true,
    snapshot: { ...snapshot, rows, planChecks: [...snapshot.planChecks] },
  };
}

export function frozenRowsToTodoItems(snapshot: FrozenTodoSnapshot): TodoItem[] {
  return snapshot.rows.map((row) => ({
    step: Number(row.ref),
    text: row.text,
    completed: row.status === "completed",
    status: row.status,
    id: row.id,
    ref: row.ref,
    label: row.label ?? row.ref,
    ...(row.group === undefined ? {} : { group: row.group }),
    ...(row.planStepId === undefined ? {} : { planStepId: row.planStepId }),
    source: row.source === "plan" ? ("plan" as const) : ("agent" as const),
  }));
}
