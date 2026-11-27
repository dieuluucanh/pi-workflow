/**
 * Tests for the shared filterable picker primitives used by `/profile` and
 * `/role`.
 *
 * The wrapper is exercised with raw pi-tui key sequences (printable characters,
 * DEL for Backspace, ESC/Ctrl+C, Enter, legacy Up/Down arrows), which is how the
 * TUI feeds `handleInput()`. Theme callbacks are identity functions so rendered
 * assertions stay ANSI-free.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  FilterableList,
  filterPickerItems,
  pickerItemText,
  type FilterableItem,
} from "./picker.ts";

const theme = {
  selectedPrefix: (text: string) => text,
  selectedText: (text: string) => text,
  description: (text: string) => text,
  scrollInfo: (text: string) => text,
  noMatch: (text: string) => text,
};

const BEAM = "opencode/beam-free";
const DEEPSEEK = "synthetic/hf:deepseek-ai/DeepSeek-V4.1-Flash-1017";
const MUSE = "opencode-go/muse-spark-1.2";

const ESC = "\x1b";
const CTRL_C = "\x03";
const ENTER = "\r";
const BACKSPACE = "\x7f";
const UP = "\x1b[A";
const DOWN = "\x1b[B";

function models(): FilterableItem[] {
  return [
    { value: BEAM, label: BEAM, searchText: "Beam Free" },
    { value: DEEPSEEK, label: DEEPSEEK },
    { value: MUSE, label: MUSE, searchText: "Muse Spark 1.2" },
  ];
}

function type(list: FilterableList, text: string): void {
  for (const ch of text) list.handleInput(ch);
}

test("picker: a blank query returns every row (and a copy)", () => {
  const items = models();
  for (const query of ["", "   ", "\t"]) {
    const out = filterPickerItems(items, query);
    assert.equal(out.length, items.length);
    assert.notEqual(out, items);
  }
});

test("picker: fuzzy match finds middle tokens, slash tokens and hidden names", () => {
  assert.deepEqual(
    filterPickerItems(models(), "flash").map((item) => item.value),
    [DEEPSEEK],
  );
  assert.deepEqual(
    filterPickerItems(models(), "deepseek flash").map((item) => item.value),
    [DEEPSEEK],
  );
  assert.deepEqual(
    filterPickerItems(models(), "open/beam-f").map((item) => item.value),
    [BEAM],
  );
  // "Beam Free" / "Muse Spark 1.2" exist only in the hidden searchText.
  assert.equal(filterPickerItems(models(), "beam free")[0]?.value, BEAM);
  assert.equal(filterPickerItems(models(), "muse spark")[0]?.value, MUSE);
});

test("picker: descriptions are searchable", () => {
  const items: FilterableItem[] = [
    { value: "budget", label: "⚡ budget", description: "cheap planner" },
    { value: "premium", label: "⚡ premium", description: "frontier planner" },
  ];
  assert.deepEqual(
    filterPickerItems(items, "cheap").map((item) => item.value),
    ["budget"],
  );
});

test("picker: the best fuzzy match comes first", () => {
  const items: FilterableItem[] = [
    { value: "muse-spark", label: "muse-spark" },
    { value: "muse", label: "muse" },
  ];
  assert.equal(filterPickerItems(items, "muse")[0]?.value, "muse");
});

test("picker: no match returns an empty list", () => {
  assert.deepEqual(filterPickerItems(models(), "zzzz"), []);
});

test("picker: pickerItemText joins visible and hidden text", () => {
  assert.equal(
    pickerItemText({
      value: BEAM,
      label: "beam",
      description: "free tier",
      searchText: "Beam Free",
    }),
    "beam opencode/beam-free free tier Beam Free",
  );
});

test("picker: typing narrows the list and selects the top match", () => {
  const list = new FilterableList({ items: models(), maxVisible: 5, theme });
  assert.equal(list.getQuery(), "");
  assert.equal(list.getSelectedItem()?.value, BEAM);

  for (const ch of "flash") assert.equal(list.handleInput(ch), true);
  assert.equal(list.getQuery(), "flash");
  assert.deepEqual(
    list.getFilteredItems().map((item) => item.value),
    [DEEPSEEK],
  );
  assert.equal(list.getSelectedItem()?.value, DEEPSEEK);
});

test("picker: Backspace widens the filter", () => {
  const list = new FilterableList({ items: models(), maxVisible: 5, theme });
  type(list, "flash");
  assert.equal(list.getFilteredItems().length, 1);

  for (let i = 0; i < 5; i++) assert.equal(list.handleInput(BACKSPACE), true);
  assert.equal(list.getQuery(), "");
  assert.equal(list.getFilteredItems().length, 3);
});

test("picker: Enter is left to the caller and no-match stays inert", () => {
  const list = new FilterableList({ items: models(), maxVisible: 5, theme });
  assert.equal(list.handleInput(ENTER), false);
  assert.equal(list.getQuery(), "");

  type(list, "zzzz");
  assert.equal(list.getFilteredItems().length, 0);
  assert.equal(list.getSelectedItem(), null);
  assert.equal(list.handleInput(ENTER), false);
  // Nothing was cleared or selected behind the caller's back.
  assert.equal(list.getQuery(), "zzzz");
});

test("picker: Escape and Ctrl+C clear a non-empty filter, then delegate", () => {
  const list = new FilterableList({ items: models(), maxVisible: 5, theme });

  type(list, "flash");
  assert.equal(list.handleInput(ESC), true);
  assert.equal(list.getQuery(), "");
  assert.equal(list.getFilteredItems().length, 3);
  assert.equal(list.handleInput(ESC), false);

  type(list, "flash");
  assert.equal(list.handleInput(CTRL_C), true);
  assert.equal(list.getQuery(), "");
  assert.equal(list.handleInput(CTRL_C), false);
});

test("picker: Up/Down move the selection", () => {
  const list = new FilterableList({ items: models(), maxVisible: 5, theme });
  assert.equal(list.getSelectedItem()?.value, BEAM);
  assert.equal(list.handleInput(DOWN), true);
  assert.equal(list.getSelectedItem()?.value, DEEPSEEK);
  assert.equal(list.handleInput(UP), true);
  assert.equal(list.getSelectedItem()?.value, BEAM);
});

test("picker: setItems preserves the query and the selected row", () => {
  const list = new FilterableList({ items: models(), maxVisible: 5, theme });
  type(list, "beam");
  assert.equal(list.getSelectedItem()?.value, BEAM);

  list.setItems([
    ...models(),
    { value: "opencode/beam-plus", label: "opencode/beam-plus" },
  ]);
  assert.equal(list.getQuery(), "beam");
  assert.equal(list.getSelectedItem()?.value, BEAM);
  assert.equal(list.getFilteredItems().length, 2);

  // The selected row disappears: keep the query, show the no-match state.
  list.setItems(models().filter((item) => item.value !== BEAM));
  assert.equal(list.getQuery(), "beam");
  assert.equal(list.getFilteredItems().length, 0);
  assert.equal(list.getSelectedItem(), null);
});

test("picker: clearFilter restores the full list and the previous row", () => {
  const list = new FilterableList({ items: models(), maxVisible: 5, theme });
  list.handleInput("m");
  for (const ch of "use") list.handleInput(ch);
  assert.equal(list.getSelectedItem()?.value, MUSE);

  list.clearFilter();
  assert.equal(list.getQuery(), "");
  assert.equal(list.getFilteredItems().length, 3);
  assert.equal(list.getSelectedItem()?.value, MUSE);
});

test("picker: initialQuery is seeded at the end of the composer", () => {
  const list = new FilterableList({
    items: models(),
    maxVisible: 5,
    theme,
    initialQuery: "fl",
  });
  assert.equal(list.getQuery(), "fl");
  // If setValue() had left the cursor at 0 this would become "afl".
  list.handleInput("a");
  assert.equal(list.getQuery(), "fla");
});

test("picker: initialIndex seeds the cursor when unfiltered", () => {
  const list = new FilterableList({
    items: models(),
    maxVisible: 5,
    theme,
    initialIndex: 2,
  });
  assert.equal(list.getSelectedItem()?.value, MUSE);
});

test("picker: renderList shows the themed no-match message", () => {
  const list = new FilterableList({
    items: models(),
    maxVisible: 5,
    theme,
    noMatchText: "No matching models",
  });
  type(list, "zzzz");
  assert.deepEqual(list.renderList(40), ["  No matching models"]);
});
