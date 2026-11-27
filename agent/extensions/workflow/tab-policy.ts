/**
 * Tab precedence between Pi's autocomplete and the workflow mode cycle.
 *
 * Pi's `CustomEditor.handleInput()` checks extension shortcuts *before* the
 * editor, so the workflow's registered `tab` shortcut would otherwise swallow
 * every Tab — including the one that accepts the highlighted command, file or
 * document suggestion. The workflow editor asks this policy first:
 *
 *   suggestion list visible  -> complete (apply the highlighted item)
 *   no suggestion list       -> cycle    (Plan → Build → Default)
 *   another key              -> ignore   (let CustomEditor/Editor handle it)
 *   Tab binding disabled     -> ignore   (never turn a disabled Tab into accept)
 *
 * The rule is deliberately based on menu visibility only, matching Pi Desktop's
 * `Composer.tsx` `menuKey` logic. A `/command` line whose list has not rendered
 * yet is allowed to cycle; the list wins only while it is actually visible.
 *
 * Pure module (type-only imports) so the precedence is unit-testable without a
 * TUI.
 */

import type { Keybinding } from "@earendil-works/pi-tui";

export type TabAction = "ignore" | "complete" | "cycle";

export interface TabEditorView {
  /** True while a non-empty autocomplete list is visible. */
  isShowingAutocomplete(): boolean;
}

export interface TabKeyMatcher {
  matches(data: string, keybinding: Keybinding): boolean;
}

export function decideTabAction(args: {
  data: string;
  keybindings: TabKeyMatcher;
  editor: TabEditorView;
}): TabAction {
  if (!args.keybindings.matches(args.data, "tui.input.tab")) return "ignore";
  return args.editor.isShowingAutocomplete() ? "complete" : "cycle";
}
