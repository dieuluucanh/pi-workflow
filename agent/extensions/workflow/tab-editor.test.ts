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
      if (keybinding === "app.interrupt") return data === "\x1b";
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

// ── Orchestrator composer activity / Esc ownership ───────────────────

import type { WorkflowEditorActivity } from "./tab-editor.ts";

function activity(
  over: Partial<WorkflowEditorActivity> = {},
): WorkflowEditorActivity {
  return {
    line: "Working · Builder 2/7 · bash npm test · ESC or /orchestrator-pause to pause · /orchestrator-abort to stop",
    compact: "Working · Builder 2/7 · bash npm test",
    busy: true,
    paused: false,
    esc: "pause",
    ...over,
  };
}

function makeHookEditor(hooks: {
  activity?: () => WorkflowEditorActivity | undefined;
  onEscConsumed?: (action: "pause" | "swallow") => void;
}): WorkflowTabEditor {
  return new WorkflowTabEditor({} as any, theme, keybindings(), hooks);
}

test("composer border delegates to the host when no child owns it", () => {
  const base = makeEditor(false);
  const withHooks = makeHookEditor({ activity: () => undefined });
  assert.equal(
    (withHooks as any).renderTopBorder(60, 0),
    (base as any).renderTopBorder(60, 0),
  );
});

test("composer border shows Working and the real controls", () => {
  const editor = makeHookEditor({ activity: () => activity() });
  const line = (editor as any).renderTopBorder(120, 0);
  assert.match(line, /Working · Builder 2\/7/);
  assert.match(line, /ESC or \/orchestrator-pause to pause/);
  assert.match(line, /\/orchestrator-abort to stop/);
});

test("narrow terminals fall back to the hint-free compact line", () => {
  const editor = makeHookEditor({ activity: () => activity() });
  const line = (editor as any).renderTopBorder(42, 0);
  assert.match(line, /Working · Builder 2\/7/);
  assert.doesNotMatch(line, /ESC/);
});

test("a warm pause renders the paused line with resume", () => {
  const editor = makeHookEditor({
    activity: () =>
      activity({
        line: "Paused · Builder 2/7 · /orchestrator-resume to continue · /orchestrator-abort to stop",
        compact: "Paused · Builder 2/7",
        busy: false,
        paused: true,
        esc: "swallow",
      }),
  });
  const line = (editor as any).renderTopBorder(120, 0);
  assert.match(line, /Paused · Builder 2\/7/);
  assert.match(line, /\/orchestrator-resume/);
});

function escapeTestEditor(action: WorkflowEditorActivity["esc"]) {
  let consumed = 0;
  let native = 0;
  let lastAction = "";
  const editor = makeHookEditor({
    activity: () => activity({ esc: action }),
    onEscConsumed: (value) => {
      consumed += 1;
      lastAction = value;
    },
  });
  (editor as any).isShowingAutocomplete = () => false;
  editor.onEscape = () => {
    native += 1;
  };
  return {
    editor,
    consumed: () => consumed,
    native: () => native,
    lastAction: () => lastAction,
  };
}

test("Esc pauses once per press and never reaches the native abort", () => {
  const h = escapeTestEditor("pause");
  for (let i = 0; i < 3; i += 1) h.editor.handleInput("\x1b");
  assert.equal(h.consumed(), 3);
  assert.equal(h.native(), 0);
  assert.equal(h.lastAction(), "pause");
});

test("repeated Esc while paused is swallowed, never an abort", () => {
  const h = escapeTestEditor("swallow");
  for (let i = 0; i < 4; i += 1) h.editor.handleInput("\x1b");
  assert.equal(h.consumed(), 4);
  assert.equal(h.native(), 0);
  assert.equal(h.lastAction(), "swallow");
});

test("Esc passes through when no child owns the composer", () => {
  const h = escapeTestEditor("pass");
  h.editor.handleInput("\x1b");
  assert.equal(h.consumed(), 0);
  assert.equal(h.native(), 1);
});

test("an open completion menu owns Esc", () => {
  const h = escapeTestEditor("pause");
  (h.editor as any).isShowingAutocomplete = () => true;
  h.editor.handleInput("\x1b");
  assert.equal(h.consumed(), 0);
  assert.equal(h.native(), 0);
});

test("key-release Esc does not pause", () => {
  const h = escapeTestEditor("pause");
  // Kitty keyboard protocol release event for Escape.
  h.editor.handleInput("\x1b[27;1:3~");
  assert.equal(h.consumed(), 0);
});
