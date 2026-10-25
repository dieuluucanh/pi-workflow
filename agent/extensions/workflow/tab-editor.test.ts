/**
 * Tests for the workflow editor wrapper and its history helpers.
 *
 * These construct the real `CustomEditor` subclass with minimal fakes: the
 * editor constructor only stores the TUI/theme, and the tests stub
 * `isShowingAutocomplete()` + `onExtensionShortcut` to observe which path Tab
 * takes. A visible list must suppress the extension shortcut; no list must reach
 * it (the mode cycle).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  WorkflowTabEditor,
  promptHistoryTexts,
  seedPromptHistory,
  type PromptHistoryEntry,
} from "./tab-editor.ts";

const theme = {
  borderColor: (text: string) => text,
  selectList: {},
} as any;

function keybindings(matchesTab = true): any {
  return {
    matches(data: string, keybinding: string): boolean {
      return matchesTab && keybinding === "tui.input.tab" && data === "\t";
    },
  };
}

function makeEditor(showing: boolean, matchesTab = true): WorkflowTabEditor {
  const editor = new WorkflowTabEditor({} as any, theme, keybindings(matchesTab));
  (editor as any).isShowingAutocomplete = () => showing;
  return editor;
}

function spyShortcut(editor: WorkflowTabEditor): () => number {
  let calls = 0;
  editor.onExtensionShortcut = () => {
    calls += 1;
    return true;
  };
  return () => calls;
}

test("workflow editor: a visible list bypasses the extension shortcut", () => {
  const editor = makeEditor(true);
  const calls = spyShortcut(editor);
  editor.handleInput("\t");
  assert.equal(calls(), 0, "Tab must reach the editor, not the mode cycle");
});

test("workflow editor: no visible list reaches the extension shortcut", () => {
  const editor = makeEditor(false);
  const calls = spyShortcut(editor);
  editor.handleInput("\t");
  assert.equal(calls(), 1, "with no list, Tab keeps cycling the mode");
});

test("workflow editor: a disabled tui.input.tab binding still cycles", () => {
  const editor = makeEditor(true, false);
  const calls = spyShortcut(editor);
  editor.handleInput("\t");
  assert.equal(calls(), 1, "a disabled binding must never be turned into accept");
});

test("workflow editor: non-Tab keys keep the normal shortcut path", () => {
  const editor = makeEditor(true);
  const calls = spyShortcut(editor);
  editor.handleInput("a");
  assert.equal(calls(), 1);
});

test("workflow editor: restores the embedded working-status border", () => {
  const editor = makeEditor(false);
  assert.equal((editor as any).embedWorkingStatus, true);
});

test("workflow editor: host history population is tracked", () => {
  const editor = makeEditor(false);
  assert.equal(editor.hasHostHistory(), false);
  editor.addToHistory("hello");
  assert.equal(editor.hasHostHistory(), true);

  const blank = makeEditor(false);
  blank.addToHistory("   ");
  assert.equal(blank.hasHostHistory(), false);
});

test("promptHistoryTexts: user text blocks only, oldest first", () => {
  const entries: PromptHistoryEntry[] = [
    { type: "message", message: { role: "user", content: "first" } },
    {
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "not history" }],
      },
    },
    {
      type: "message",
      message: {
        role: "user",
        content: [
          { type: "text", text: "second" },
          { type: "image", data: "ignored" } as any,
        ],
      },
    },
    { type: "custom", message: { role: "user", content: "ignored" } },
    { type: "message", message: { role: "user", content: "   " } },
    { type: "message" },
  ];

  assert.deepEqual(promptHistoryTexts(entries), ["first", "second"]);
});

test("seedPromptHistory: feeds oldest to newest", () => {
  const added: string[] = [];
  const entries: PromptHistoryEntry[] = [
    { type: "message", message: { role: "user", content: "oldest" } },
    { type: "message", message: { role: "user", content: "newest" } },
  ];

  seedPromptHistory({ addToHistory: (text) => added.push(text) }, entries);
  assert.deepEqual(added, ["oldest", "newest"]);
});
