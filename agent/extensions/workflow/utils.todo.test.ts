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
  type TodoItem,
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

test("resolveTodoRef + markCompletedRefs", () => {
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
  assert.equal(resolveTodoRef(items, "1.1").item?.step, 2);
  assert.equal(resolveTodoRef(items, "Create Word").unknown, "Create Word");
  assert.equal(
    resolveTodoRef(items, "Create Word format_range tool").item?.step,
    1,
  );
  assert.equal(resolveTodoRef(items, "999").unknown, "999");

  const res = markCompletedRefs("[DONE:1.1] [DONE:2.1] [DONE:99]", items);
  assert.equal(res.marked, 2);
  assert.deepEqual(res.unknown, ["99"]);
  assert.equal(items[1].completed, true);
  assert.equal(items[2].completed, true);
  assert.equal(items[0].completed, false);
});

test("mergeTodoItems preserves completion for the same plan, replaces on a new one", () => {
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
  assert.equal(merged.items[0].completed, true);
  assert.equal(merged.items[1].completed, false);
  assert.equal(merged.items.length, 2);
  assert.equal(merged.removed, 1);

  const replaced = mergeTodoItems(existing, [
    {
      step: 1,
      text: "Brand new",
      completed: false,
      label: "1",
      source: "plan",
    },
  ]);
  assert.equal(replaced.added, 1);
  assert.equal(replaced.items[0].text, "Brand new");
  assert.equal(replaced.items[0].completed, false);
});

test("synthesizeFromPlanTitle", () => {
  const synth = synthesizeFromPlanTitle("# Plan: Some title\n\nbody");
  assert.equal(synth?.text, "Some title");
  assert.equal(synth?.source, "synthesized");
  assert.equal(synthesizeFromPlanTitle("no title here"), null);
});
