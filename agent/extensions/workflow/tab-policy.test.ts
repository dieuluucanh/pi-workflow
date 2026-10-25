/**
 * Tests for the Tab precedence policy.
 *
 * The rule is intentionally tiny: Tab completes only while the suggestion list
 * is visible, otherwise the workflow mode cycle keeps the key. These cases pin
 * the user-selected Pi Desktop parity, including the "list has not rendered
 * yet" race and the disabled-keybinding fallback.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  decideTabAction,
  type TabEditorView,
  type TabKeyMatcher,
} from "./tab-policy.ts";

function keysBounding(...keys: string[]): TabKeyMatcher {
  return {
    matches(data, keybinding) {
      return keybinding === "tui.input.tab" && keys.includes(data);
    },
  };
}

function editor(showing: boolean): TabEditorView {
  return { isShowingAutocomplete: () => showing };
}

const TAB = "\t";

test("tab policy: a non-Tab key is ignored", () => {
  assert.equal(
    decideTabAction({ data: "a", keybindings: keysBounding(TAB), editor: editor(true) }),
    "ignore",
  );
});

test("tab policy: an empty tui.input.tab binding never completes", () => {
  assert.equal(
    decideTabAction({ data: TAB, keybindings: keysBounding(), editor: editor(true) }),
    "ignore",
  );
});

test("tab policy: a remapped completion key makes Tab ignore", () => {
  assert.equal(
    decideTabAction({
      data: TAB,
      keybindings: keysBounding("\x00"), // completion moved to another key
      editor: editor(true),
    }),
    "ignore",
  );
});

test("tab policy: visible suggestion list completes", () => {
  assert.equal(
    decideTabAction({ data: TAB, keybindings: keysBounding(TAB), editor: editor(true) }),
    "complete",
  );
});

test("tab policy: no visible list cycles modes", () => {
  assert.equal(
    decideTabAction({ data: TAB, keybindings: keysBounding(TAB), editor: editor(false) }),
    "cycle",
  );
});

test("tab policy: strict parity — /pro without a rendered list cycles", () => {
  // Menu visibility, not the input prefix, decides. Desktop behaves the same
  // when the provider has not answered yet.
  assert.equal(
    decideTabAction({ data: TAB, keybindings: keysBounding(TAB), editor: editor(false) }),
    "cycle",
  );
});

test("tab policy: file/document suggestions use the same rule", () => {
  // The policy never inspects the buffer, so @file and #document lists behave
  // exactly like slash-command lists.
  assert.equal(
    decideTabAction({ data: TAB, keybindings: keysBounding(TAB), editor: editor(true) }),
    "complete",
  );
});

test("tab policy: multiple keys bound to tui.input.tab all complete", () => {
  const bindings = keysBounding(TAB, "\x00");
  assert.equal(
    decideTabAction({ data: TAB, keybindings: bindings, editor: editor(true) }),
    "complete",
  );
  assert.equal(
    decideTabAction({ data: "\x00", keybindings: bindings, editor: editor(true) }),
    "complete",
  );
});
