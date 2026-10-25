/**
 * Workflow editor: gives Tab back to autocomplete while a suggestion list is
 * visible, and lets the existing `tab` extension shortcut cycle modes when it
 * is not.
 *
 * Why a custom editor is needed: Pi's `CustomEditor.handleInput()` dispatches
 * extension shortcuts before any editor/autocomplete handling, and the
 * workflow registers a raw `tab` shortcut. A plugin cannot make that dispatch
 * conditional, so the workflow installs this thin subclass through the public
 * `ctx.ui.setEditorComponent()` API. The subclass only changes the precedence
 * for the completion branch; every other key and every other extension
 * shortcut keeps the normal path.
 *
 * Public-API constraints:
 * - `isShowingAutocomplete()` is public.
 * - The editor's `autocompleteList`, `autocompletePrefix` and
 *   `handleTabCompletion()` are private, so the only clean way to accept the
 *   highlighted item is to suppress the extension bridge for one synchronous
 *   `super.handleInput()` call.
 * - `onExtensionShortcut` is installed by the core *after* this class is
 *   constructed. Do not declare a same-named field: an own handler would stop
 *   the core from installing its bridge and silently break every extension
 *   shortcut.
 *
 * The history helpers keep prompt history alive across the editor swap that
 * `setCustomEditorComponent()` performs: the core copies the editor text but not
 * the `history` array.
 */

import {
  CustomEditor,
  type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import type { Editor, EditorTheme, TUI } from "@earendil-works/pi-tui";
import { decideTabAction } from "./tab-policy.ts";

/** Minimal structural shape of a session entry that can carry user text. */
export interface PromptHistoryEntry {
  type?: string;
  message?: {
    role?: string;
    content?:
      | string
      | ReadonlyArray<{ type?: string; text?: string }>;
  };
}

/**
 * User prompt texts from session entries, oldest first.
 *
 * Mirrors pi's `getUserMessageText()`: string content or the concatenation of
 * text blocks. Entries without user text (assistant/tool/system, or an empty
 * message) are skipped.
 */
export function promptHistoryTexts(
  entries: readonly PromptHistoryEntry[],
): string[] {
  const texts: string[] = [];
  for (const entry of entries) {
    if (!entry || entry.type !== "message") continue;
    const message = entry.message;
    if (!message || message.role !== "user") continue;

    const content = message.content;
    let text = "";
    if (typeof content === "string") {
      text = content;
    } else {
      for (const block of content ?? []) {
        if (block?.type === "text" && typeof block.text === "string") {
          text += block.text;
        }
      }
    }
    if (text.trim()) texts.push(text);
  }
  return texts;
}

/**
 * Seed a fresh editor's prompt history from session entries.
 *
 * `Editor.addToHistory()` unshifts, so feeding oldest→newest leaves the newest
 * prompt at the cursor end, exactly like the host's own population path.
 */
export function seedPromptHistory(
  editor: Pick<Editor, "addToHistory">,
  entries: readonly PromptHistoryEntry[],
): void {
  for (const text of promptHistoryTexts(entries)) {
    editor.addToHistory(text);
  }
}

export class WorkflowTabEditor extends CustomEditor {
  private readonly tabKeybindings: KeybindingsManager;
  private hostHistoryAdded = false;

  constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) {
    super(tui, theme, keybindings);
    this.tabKeybindings = keybindings;
    // The default 1.4.0 editor renders the working spinner in its top border.
    // `embedWorkingStatus` is absent from the 0.84.4 constructor options type
    // this package compiles against, but the runtime check is field-based, so
    // assigning it after `super` restores the default behaviour and is inert on
    // older versions.
    (this as any).embedWorkingStatus = true;
  }

  /** True once the host has populated this editor's prompt history. */
  hasHostHistory(): boolean {
    return this.hostHistoryAdded;
  }

  override addToHistory(text: string): void {
    if (text.trim()) this.hostHistoryAdded = true;
    super.addToHistory(text);
  }

  override handleInput(data: string): void {
    const action = decideTabAction({
      data,
      keybindings: this.tabKeybindings,
      editor: this,
    });

    if (action === "complete") {
      // Suppress only the extension-shortcut bridge for this synchronous call.
      // `super.handleInput()` then reaches the editor's Tab branch, which
      // applies the highlighted item. `finally` restores the bridge so the
      // workflow `tab` shortcut and every other extension shortcut keep
      // working for the next key.
      const forwarded = this.onExtensionShortcut;
      this.onExtensionShortcut = undefined;
      try {
        super.handleInput(data);
      } finally {
        this.onExtensionShortcut = forwarded;
      }
      return;
    }

    // "cycle" (no visible list) and "ignore" (not Tab / disabled binding) use
    // the normal CustomEditor path: extension shortcuts first, then the editor.
    super.handleInput(data);
  }
}
