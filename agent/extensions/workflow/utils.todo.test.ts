#!/usr/bin/env node
/**
 * Unit tests for the workflow todo pipeline (parsing, refs, merge).
 * Run: node --test utils.todo.test.ts
 *
 * Imports the real pure functions from ./utils.ts (Node 24 type stripping).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractPlanStepsFromMarkdown,
  extractTodoItems,
  normalizeStepText,
  todoKey,
  dedupeTodoItems,
  ensureTodoLabels,
  mergeTodoItems,
  parseDoneRefs,
  resolveTodoRef,
  markCompletedRefs,
  synthesizeFromPlanTitle,
  itemStatus,
  setTodoStatus,
  mergeStatusByRank,
  todoRef,
  applyTodoUpdate,
  formatTodoLine,
  formatTodoNumberedList,
  buildTodoContextBlock,
  buildTodoFooter,
  formatAmbiguity,
  shouldRemind,
  TURNS_SINCE_WRITE,
  type TodoItem,
  type TodoUpdateEntry,
} from "./utils.ts";

const FORMATTING_PLAN = `# Plan: Add document formatting tools (Word + PowerPoint)

## Context

Two formatting gaps, both **tool gaps**:

1. **Word**: after adding local Word tools, the agent says it can only edit text.
2. **PowerPoint**: the agent generates ugly slides without formatting.

## Plan Steps

### 1. Create Word \`word_format_range\` tool

New file, modeled on replace-text.ts:

- Schema: text, matchCase, bold, size.
- Execute in a single Word.run.

### 2. Enhance \`word_insert_text\` with formatting

1. Add bold param.
2. Apply the font props.

### 3. Enhance \`powerpoint_add_text_box\` with formatting (PPT primary fix)

### 4. Create PowerPoint \`powerpoint_format_slide\` tool (PPT secondary)

### 5. Register new tools everywhere a name must be known

### 6. Update the system prompts to advertise formatting

### 7. Add i18n labels

### 8. Verify TypeScript compiles

### 9. Verify existing test suites green

## Risks

- Word alignment needs an extra sync.

## Verification

1. \`npm run typecheck\` — clean.
2. \`test:context\` + \`test:security\` — no new failures.
3. **Manual — Word**: bold the heading, no "I can't format".
4. **Manual — Word**: bold I. II. III. IV.
5. **Manual — Word insert+format**: insert a formatted heading.
6. **Manual — PPT**: create a formatted slide.
7. **Manual — PPT restyle**: restyle slide 1.
8. **Manual — Excel**: unchanged.
`;

const HOST_DETECTION_PLAN = `# Plan: Fix Word/PowerPoint host detection

## Context

### Root cause (confirmed by code inspection)

The bug: OfficeApp is detected but never passed through. Consequences:

1. **System prompt is hardcoded to Excel** (\`packages/add-in/src/prompt/system-prompt.ts\`):
2. **Tool set is hardcoded to Excel** (\`packages/add-in/src/tools/\`):
3. **Detection is siloed** (init.ts:999).

## Plan Steps

### 1. Compute \`detectedApp\` at init scope and expose it

### 2. Add \`hostApp\` to \`SystemPromptOptions\` and thread it through

### 3. Parameterize the system prompt constants by host app

### 4. Make \`OfficeHost.displayName\` dynamic

### 5. Add \`hostApp\` to \`CreateAllToolsOptions\` and \`createAllTools\`

### 6. Align the advertised tool list with the host

### 7. Update \`buildRuntimeSystemPrompt\` call site

### 8. Make onboarding suggestions host-app-aware

### 9. Verify no TypeScript regressions

## Risks

- Prompt length grows.

## Verification

1. \`tsc --noEmit\` clean.
2. Existing test suites green.
3. **Manual — Word**: confirm IDENTITY says Microsoft Word.
`;

const PHASE_PLAN = `# Plan: Multi-phase build

## Plan Steps

### Phase 1 — Scaffold

Intro text.

**Step 1.1: Create the extension file**

**Step 1.2: Wire up the manifest**

### Phase 2 — Ship

**Step 2.1: Polish and document**

## Verification

1. Do not capture this.
`;

const LIST_PLAN = `# Plan: List style

## Plan Steps

### Phase 1 — Core

1. First step
2. Second step

### Phase 2 — Extras

1. Third step
`;

test("formatting plan: only Plan Steps, labels 1..9, no Context/Verification", () => {
  const items = extractPlanStepsFromMarkdown(FORMATTING_PLAN);
  assert.equal(items.length, 9);
  assert.deepEqual(
    items.map((i) => i.label),
    ["1", "2", "3", "4", "5", "6", "7", "8", "9"],
  );
  assert.deepEqual(
    items.map((i) => i.step),
    [1, 2, 3, 4, 5, 6, 7, 8, 9],
  );
  for (const it of items) {
    assert.ok(
      !/after adding local Word tools/.test(it.text),
      `Context leaked: ${it.text}`,
    );
    assert.ok(
      !/Manual — Word/.test(it.text),
      `Verification leaked: ${it.text}`,
    );
    assert.ok(!/test:context/.test(it.text), `Verification leaked: ${it.text}`);
  }
  // Verbatim wording preserved (backticks + verbs kept).
  assert.match(items[0].text, /word_format_range/);
  assert.equal(items[6].text.startsWith("Add i18n"), true);
});

test("host-detection plan: no Context root-cause bullets", () => {
  const items = extractPlanStepsFromMarkdown(HOST_DETECTION_PLAN);
  assert.equal(items.length, 9);
  for (const it of items) {
    assert.ok(
      !/System prompt is hardcoded to Excel/.test(it.text),
      `Context leaked: ${it.text}`,
    );
  }
});

test("phase plan: bold steps get N.M labels and phase groups", () => {
  const items = extractPlanStepsFromMarkdown(PHASE_PLAN);
  assert.equal(items.length, 3);
  assert.deepEqual(
    items.map((i) => i.label),
    ["1.1", "1.2", "2.1"],
  );
  assert.equal(items[0].group, "Phase 1 — Scaffold");
  assert.equal(items[2].group, "Phase 2 — Ship");
  assert.ok(!items.some((i) => /Do not capture/.test(i.text)));
});

test("numbered lists under phase headings are steps", () => {
  const items = extractPlanStepsFromMarkdown(LIST_PLAN);
  assert.equal(items.length, 3);
  assert.deepEqual(
    items.map((i) => i.label),
    ["1", "2", "1"],
  );
  assert.deepEqual(
    items.map((i) => i.group),
    ["Phase 1 — Core", "Phase 1 — Core", "Phase 2 — Extras"],
  );
});

test("verbs are preserved verbatim", () => {
  const md = `# Plan: x

## Plan Steps

### 1. Add hostApp to SystemPromptOptions
`;
  const items = extractPlanStepsFromMarkdown(md);
  assert.equal(items.length, 1);
  assert.equal(items[0].text, "Add hostApp to SystemPromptOptions");
});

test("normalizeStepText strips emphasis but keeps verbs and backticks", () => {
  assert.equal(
    normalizeStepText("**Add** `x` to Excel** (pkg)"),
    "Add `x` to Excel (pkg)",
  );
});

test("extractTodoItems (chat text) is section-scoped", () => {
  const chat = `Here is the plan.

Plan:
1. First chat step
2. Second chat step

## Verification
1. chat verification item
`;
  const items = extractTodoItems(chat);
  assert.equal(items.length, 2);
  assert.ok(!items.some((i) => /chat verification/.test(i.text)));
});

test("dedupe + ensureTodoLabels + todoKey", () => {
  const dupes: TodoItem[] = [
    { step: 1, text: "Do X", completed: false, label: "1" },
    { step: 2, text: "do  x", completed: true, label: "2" },
    { step: 3, text: "Do Y", completed: false, label: "3" },
  ];
  const deduped = dedupeTodoItems(dupes);
  assert.equal(deduped.length, 2);
  assert.equal(deduped[0].text, "Do X");

  const legacy = ensureTodoLabels([
    { step: 5, text: "Legacy", completed: false } as TodoItem,
  ]);
  assert.equal(legacy[0].label, "5");
  assert.equal(legacy[0].source, "plan");

  assert.equal(
    todoKey({ text: "Do X", group: "Phase 1" }),
    todoKey({ text: "do x!", group: "phase 1" }),
  );
});

test("parseDoneRefs is lenient", () => {
  assert.deepEqual(parseDoneRefs("done [DONE:3]"), ["3"]);
  assert.deepEqual(parseDoneRefs("[DONE: 3.1]"), ["3.1"]);
  assert.deepEqual(parseDoneRefs("[DONE:2-4]"), ["2", "3", "4"]);
  assert.deepEqual(parseDoneRefs("[DONE #2]"), ["2"]);
  assert.deepEqual(parseDoneRefs("[DONE:1,2]"), ["1", "2"]);
  assert.deepEqual(parseDoneRefs("[DONE:999]"), ["999"]);
});

test("resolveTodoRef + markCompletedRefs (canonical ref → step → label → text)", () => {
  const items: TodoItem[] = [
    {
      step: 1,
      text: "Create Word format_range tool",
      completed: false,
      label: "1",
    },
    { step: 2, text: "Wire the manifest", completed: false, label: "1.1" },
    { step: 3, text: "Wire the manifest", completed: false, label: "2.1" },
  ];
  const legacy = ensureTodoLabels(items);
  // Dotted label resolves by label.
  assert.equal(resolveTodoRef(legacy, "1.1").item?.step, 2);
  // Canonical ref wins (integer = global step).
  assert.equal(resolveTodoRef(legacy, "1").item?.step, 1);
  assert.equal(resolveTodoRef(legacy, "999").unknown, "999");

  const res = markCompletedRefs("[DONE:1.1] [DONE:2.1] [DONE:99]", legacy);
  assert.equal(res.marked, 2);
  assert.deepEqual(res.unknown, ["99"]);
  assert.equal(legacy[1].completed, true);
  assert.equal(legacy[2].completed, true);
  assert.equal(legacy[0].completed, false);
  assert.equal(itemStatus(legacy[1]), "completed");
});

test("duplicate per-phase labels are unambiguous via canonical refs", () => {
  // Phase numbering copied from 2026-09-12-context-overflow-compaction-recovery.md:
  // Phase 1: steps 1..4, Phase 2: 1..6, ... (labels repeat across phases).
  const raw: TodoItem[] = [
    {
      step: 1,
      text: "P1 - Context tokens",
      completed: false,
      label: "1",
      group: "Phase 1",
      source: "plan",
    },
    {
      step: 2,
      text: "P1 - Guards/meter",
      completed: false,
      label: "2",
      group: "Phase 1",
      source: "plan",
    },
    {
      step: 3,
      text: "P1 - Failure classification",
      completed: false,
      label: "3",
      group: "Phase 1",
      source: "plan",
    },
    {
      step: 4,
      text: "P1 - Tests",
      completed: false,
      label: "4",
      group: "Phase 1",
      source: "plan",
    },
    {
      step: 5,
      text: "P2 - Pure engine",
      completed: false,
      label: "1",
      group: "Phase 2",
      source: "plan",
    },
    {
      step: 6,
      text: "P2 - Rewrite runCompactCommand",
      completed: false,
      label: "2",
      group: "Phase 2",
      source: "plan",
    },
    {
      step: 7,
      text: "P2 - Bound summarization",
      completed: false,
      label: "3",
      group: "Phase 2",
      source: "plan",
    },
  ];
  const items = ensureTodoLabels(raw);
  // The historical failure: `[DONE:1]` matched 2 items by label.
  assert.equal(resolveTodoRef(items, "1").item?.step, 1);
  assert.equal(resolveTodoRef(items, "2").item?.step, 2);
  // Higher-number labels that repeat earlier phases still resolve by ref.
  assert.equal(resolveTodoRef(items, "6").item?.step, 6);
  // Group-qualified refs work.
  assert.equal(
    resolveTodoRef(items, "Phase 2/1")?.item?.step,
    5,
    "group-qualified label resolves inside the phase",
  );
  const res = markCompletedRefs("[DONE:1] [DONE:6] [DONE:13]", items);
  assert.equal(res.marked, 2);
  assert.equal(items[0].completed, true);
  assert.equal(items[5].completed, true);
  assert.deepEqual(res.unknown, ["13"]);
});

test("ambiguity teaches global step numbers", () => {
  const items = ensureTodoLabels([
    {
      step: 1,
      text: "A",
      completed: false,
      label: "1",
      group: "Phase 1",
      source: "plan",
    },
    {
      step: 2,
      text: "B",
      completed: false,
      label: "1",
      group: "Phase 2",
      source: "plan",
    },
  ]);
  const msg = formatAmbiguity(items, "1");
  assert.match(msg, /ambiguous/);
  assert.match(msg, /GLOBAL STEP/);
  assert.match(msg, /1\. A/);
  assert.match(msg, /2\. B/);
});

test("status backfill + setTodoStatus + mergeStatusByRank", () => {
  const legacy = ensureTodoLabels([
    { step: 1, text: "Done", completed: true } as TodoItem,
  ]);
  assert.equal(legacy[0].status, "completed");
  assert.equal(itemStatus(legacy[0]), "completed");
  assert.equal(todoRef(legacy[0]), "1");

  const it = { step: 1, text: "X", completed: false } as TodoItem;
  assert.equal(itemStatus(it), "pending");
  setTodoStatus(it, "in_progress");
  assert.equal(itemStatus(it), "in_progress");
  assert.equal(it.completed, false);
  setTodoStatus(it, "completed");
  assert.equal(it.completed, true);

  assert.equal(mergeStatusByRank("completed", "pending"), "completed");
  assert.equal(mergeStatusByRank("pending", "completed"), "completed");
  assert.equal(mergeStatusByRank("pending", "pending"), "pending");
  assert.equal(mergeStatusByRank("cancelled", "pending"), "pending");
});

test("applyTodoUpdate replaces the whole list (industry semantics)", () => {
  const prev = ensureTodoLabels([
    { step: 1, text: "Create X", completed: false, label: "1", source: "plan" },
    { step: 2, text: "Create Y", completed: true, label: "2", source: "plan" },
    {
      step: 3,
      text: "Agent extra",
      completed: false,
      label: "3",
      source: "agent",
    },
  ]);
  const incoming: TodoUpdateEntry[] = [
    { ref: "1", status: "completed" },
    { ref: "3", text: "Agent extra (renamed)", status: "in_progress" },
    { text: "Brand new", status: "pending" },
  ];
  const res = applyTodoUpdate(prev, incoming);
  assert.equal(res.kept, 2, "Create X + Agent extra matched by ref");
  assert.equal(res.added, 1, "Brand new appended");
  assert.equal(res.removed, 1, "Create Y omitted → removed");
  const byStep = new Map(res.items.map((it) => [it.step, it]));
  assert.equal(byStep.get(1)?.completed, true);
  assert.equal(byStep.get(1)?.ref, "1", "refs are canonical positions 1..N");
  assert.equal(byStep.get(2)?.text, "Agent extra (renamed)");
  assert.equal(byStep.get(2)?.status, "in_progress");
  assert.equal(byStep.get(2)?.ref, "2");
  assert.equal(byStep.get(3)?.text, "Brand new");
  assert.equal(byStep.get(3)?.ref, "3", "new item gets a compacted ref");
  assert.deepEqual(res.warnings, []);
});

test("applyTodoUpdate normalizes extra in_progress items", () => {
  const prev = ensureTodoLabels([
    { step: 1, text: "A", completed: false, label: "1", source: "plan" },
    { step: 2, text: "B", completed: false, label: "2", source: "plan" },
  ]);
  const res = applyTodoUpdate(prev, [
    { ref: "1", status: "in_progress" },
    { ref: "2", status: "in_progress" },
  ]);
  assert.equal(res.normalized, 1);
  assert.equal(
    res.items.filter((it) => it.status === "in_progress").length,
    1,
    "exactly one in_progress after normalization",
  );
});

test("builders render canonical global refs", () => {
  const items = ensureTodoLabels([
    { step: 1, text: "Create X", completed: true, label: "1", source: "plan" },
    {
      step: 2,
      text: "Add --port parsing",
      completed: false,
      label: "1",
      group: "Phase 2",
      source: "plan",
    },
  ]);
  assert.match(formatTodoLine(items[0]), /^☑ 1\./);
  assert.match(formatTodoLine(items[1]), /^☐ 2\./);
  assert.match(formatTodoLine(items[1]), /\(plan label 1\)/);

  const block = buildTodoContextBlock(items);
  assert.match(block, /1\/2 done/);
  assert.match(block, /GLOBALLY/);
  assert.match(block, /GLOBAL STEP/);
  assert.match(block, /\[DONE:2\]/);

  const withMisses = buildTodoContextBlock(items, { misses: { refs: ["1"] } });
  assert.match(withMisses, /REFS UNRESOLVED/);

  const footer = buildTodoFooter(items);
  assert.match(footer, /^\[TODO 1\/2/);
  assert.match(footer, /\[DONE:2\]/);
});

test("shouldRemind throttles like Claude Code", () => {
  assert.equal(
    shouldRemind({
      turnsSinceLastTodoWrite: TURNS_SINCE_WRITE - 1,
      turnsSinceLastReminder: 10,
      remaining: 2,
    }),
    false,
    "too soon since last todo write",
  );
  assert.equal(
    shouldRemind({
      turnsSinceLastTodoWrite: TURNS_SINCE_WRITE,
      turnsSinceLastReminder: TURNS_SINCE_WRITE - 1,
      remaining: 2,
    }),
    false,
    "too soon since last reminder",
  );
  assert.equal(
    shouldRemind({
      turnsSinceLastTodoWrite: TURNS_SINCE_WRITE,
      turnsSinceLastReminder: 5,
      remaining: 0,
    }),
    false,
    "nothing remaining",
  );
  assert.equal(
    shouldRemind({
      turnsSinceLastTodoWrite: TURNS_SINCE_WRITE,
      turnsSinceLastReminder: 5,
      remaining: 2,
    }),
    true,
  );
});

test("parseDoneRefs accepts group-qualified refs", () => {
  assert.deepEqual(parseDoneRefs("[DONE:Phase 2/1]"), ["Phase 2/1"]);
  assert.deepEqual(parseDoneRefs("[DONE:1,2]"), ["1", "2"]);
});

test("mergeTodoItems preserves completion, refs and agent-added items", () => {
  const existing: TodoItem[] = [
    { step: 1, text: "Create X", completed: true, label: "1", source: "plan" },
    { step: 2, text: "Create Y", completed: false, label: "2", source: "plan" },
    {
      step: 3,
      text: "Agent extra",
      completed: true,
      label: "3",
      source: "agent",
    },
  ];
  const reExtracted: TodoItem[] = [
    { step: 1, text: "Create X", completed: false, label: "1", source: "plan" },
    { step: 2, text: "Create Y", completed: false, label: "2", source: "plan" },
  ];
  const merged = mergeTodoItems(existing, reExtracted);
  assert.equal(merged.kept, 2);
  assert.equal(merged.preserved, 1, "agent item survives the merge");
  assert.equal(merged.items[0].completed, true, "completed never un-completes");
  assert.equal(merged.items[1].completed, false);
  assert.equal(merged.items[2].text, "Agent extra");
  assert.equal(merged.items.length, 3);
  assert.equal(merged.removed, 0);

  const replaced = mergeTodoItems(existing, [
    {
      step: 1,
      text: "Brand new",
      completed: false,
      label: "9",
      source: "plan",
    },
  ]);
  assert.equal(replaced.added, 1);
  assert.equal(replaced.items[0].text, "Brand new");
  assert.equal(replaced.items[0].completed, false);
});

test("mergeTodoItems honors plan-file - [x] ticks via status rank", () => {
  const existing = ensureTodoLabels([
    {
      step: 1,
      text: "Pending step",
      completed: false,
      label: "1",
      source: "plan",
    },
  ]);
  const ticked = ensureTodoLabels([
    {
      step: 1,
      text: "Pending step",
      completed: true,
      label: "1",
      source: "plan",
    },
  ]);
  const merged = mergeTodoItems(existing, ticked);
  assert.equal(merged.items[0].completed, true);
  assert.equal(itemStatus(merged.items[0]), "completed");
});

test("synthesizeFromPlanTitle", () => {
  const synth = synthesizeFromPlanTitle("# Plan: Some title\n\nbody");
  assert.equal(synth?.text, "Some title");
  assert.equal(synth?.source, "synthesized");
  assert.equal(synthesizeFromPlanTitle("no title here"), null);
});

// ── Regression: plan → build ref duplication (2026-09-15 office session) ──

test("same-plan merge reunites model-rewritten steps by plan label (no duplicates)", () => {
  const plan = extractPlanStepsFromMarkdown(
    `# Plan: x

## Plan Steps

### 1. Create the widget
### 2. Wire the widget
### 3. Verify the widget
`,
  );
  assert.equal(plan.length, 3);
  const state = ensureTodoLabels(plan);
  // The model rewrites the wording in workflow_todo update, keeping refs.
  const rewritten = applyTodoUpdate(state, [
    { ref: "1", text: "Create the widget component", status: "completed" },
    { ref: "2", text: "Wire the widget into the app", status: "in_progress" },
    { ref: "3", text: "Verify the widget works", status: "pending" },
  ]);
  assert.equal(rewritten.kept, 3);
  assert.equal(rewritten.added, 0);
  assert.equal(rewritten.removed, 0);
  // A plan re-extraction must match by label and must not append duplicates.
  const merged = mergeTodoItems(rewritten.items, plan);
  assert.equal(merged.kept, 3);
  assert.equal(merged.added, 0);
  assert.equal(merged.removed, 0);
  assert.equal(merged.items.length, 3);
  assert.deepEqual(
    merged.items.map((it) => it.ref),
    ["1", "2", "3"],
  );
  assert.deepEqual(
    merged.items.map((it) => it.text),
    plan.map((p) => p.text),
  );
  assert.deepEqual(
    merged.items.map((it) => it.status),
    ["completed", "in_progress", "pending"],
  );
});

test("plan → rewording update → same-plan merge → build update keeps 1..10", () => {
  const md = ["# Plan: ten", "", "## Plan Steps", ""];
  for (let i = 1; i <= 10; i++) md.push(`### ${i}. Step ${i} of the plan`);
  const plan = extractPlanStepsFromMarkdown(md.join("\n"));
  assert.equal(plan.length, 10);
  let items = ensureTodoLabels(plan);
  // Plan mode: the model rewrites wording using the refs shown (1..10).
  const first = applyTodoUpdate(
    items,
    plan.map((p) => ({
      ref: p.label as string,
      text: `${p.text} — refined`,
      status: "pending" as const,
    })),
  );
  assert.equal(first.added, 0);
  items = first.items;
  // agent_end plan-file reconciliation (plan mode, then build approval).
  items = mergeTodoItems(items, plan).items;
  items = mergeTodoItems(items, plan).items;
  assert.equal(items.length, 10);
  // Build: the model sends the same positional refs again.
  const second = applyTodoUpdate(
    items,
    plan.map((p, i) => ({
      ref: String(i + 1),
      text: `${p.text} — build`,
      status: i === 0 ? ("in_progress" as const) : ("pending" as const),
    })),
  );
  assert.equal(second.added, 0);
  assert.equal(second.kept, 10);
  assert.equal(second.items.length, 10);
  assert.deepEqual(
    second.items.map((t) => t.ref),
    plan.map((_, i) => String(i + 1)),
  );
});

test("unknown ref resolves leniently with warnings", () => {
  const items = ensureTodoLabels([
    {
      step: 1,
      text: "Create the API",
      completed: false,
      label: "1.1",
      source: "plan",
    },
    {
      step: 2,
      text: "Wire the API",
      completed: false,
      label: "1.2",
      source: "plan",
    },
  ]);
  const res = applyTodoUpdate(items, [
    { text: "Create the API", status: "pending" },
    { ref: "1.2", text: "Wire the API", status: "completed" },
  ]);
  assert.equal(res.kept, 2);
  assert.equal(res.added, 0);
  assert.equal(res.removed, 0);
  assert.equal(res.items[1].status, "completed");
  assert.equal(res.warnings.length, 1);
  assert.match(res.warnings[0], /1\.2/);
  assert.match(res.warnings[0], /not found/);

  const ghost = applyTodoUpdate(items, [
    { ref: "99", text: "Ghost step", status: "pending" },
  ]);
  assert.equal(ghost.added, 1);
  assert.equal(ghost.items.length, 1);
  assert.deepEqual(
    ghost.items.map((t) => t.ref),
    ["1"],
  );
  assert.equal(ghost.warnings.length, 1);
  assert.match(ghost.warnings[0], /99/);
});

test("ensureTodoLabels compacts inflated refs back to 1..N", () => {
  const healed = ensureTodoLabels([
    {
      step: 1,
      text: "A",
      completed: false,
      ref: "17",
      label: "17",
      source: "agent",
    },
    {
      step: 2,
      text: "B",
      completed: false,
      ref: "18",
      label: "18",
      source: "agent",
    },
    {
      step: 3,
      text: "C",
      completed: false,
      ref: "23",
      label: "23",
      source: "agent",
    },
  ]);
  assert.deepEqual(
    healed.map((t) => t.ref),
    ["1", "2", "3"],
  );
  assert.deepEqual(
    healed.map((t) => t.step),
    [1, 2, 3],
  );
  // Plan labels are preserved as display metadata.
  assert.deepEqual(
    healed.map((t) => t.label),
    ["17", "18", "23"],
  );
});

test("formatTodoNumberedList uses canonical refs", () => {
  const items = ensureTodoLabels([
    {
      step: 5,
      text: "A",
      completed: false,
      ref: "9",
      label: "1.1",
      source: "plan",
    },
    {
      step: 6,
      text: "B",
      completed: true,
      ref: "10",
      label: "1.2",
      source: "plan",
    },
  ]);
  assert.equal(formatTodoNumberedList(items), "1. A\n2. B");
  assert.equal(
    formatTodoNumberedList(items, { glyph: true }),
    "☐ 1. A\n☑ 2. B",
  );
});

test("refs are always 1..N and unique after merge/update", () => {
  const plan = extractPlanStepsFromMarkdown(
    `# Plan: x

## Plan Steps

### 1. Alpha step
### 2. Bravo step
### 3. Charlie step
`,
  );
  const assertCompact = (list: TodoItem[]) => {
    assert.deepEqual(
      list.map((t) => t.ref),
      list.map((_, i) => String(i + 1)),
    );
    assert.equal(new Set(list.map((t) => t.ref)).size, list.length);
    assert.deepEqual(
      list.map((t) => t.step),
      list.map((_, i) => i + 1),
    );
  };
  let items = ensureTodoLabels(plan);
  assertCompact(items);
  items = applyTodoUpdate(items, [
    { ref: "2", text: "B renamed", status: "completed" },
    { text: "Ad-hoc", status: "pending" },
  ]).items;
  assertCompact(items);
  items = mergeTodoItems(items, plan).items;
  assertCompact(items);
  assert.equal(items.length, 4); // A, B, C + preserved ad-hoc agent item
});
