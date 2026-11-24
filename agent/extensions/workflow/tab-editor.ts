/**
 * Workflow editor: gives Tab back to autocomplete while a suggestion list is
 * visible, lets the existing `tab` extension shortcut cycle modes when it is
 * not, and hosts external child activity in the composer's top border.
 *
 * Why a custom editor is needed: Pi's `CustomEditor.handleInput()` dispatches
 * extension shortcuts before any editor/autocomplete handling, and the
 * workflow registers a raw `tab` shortcut. A plugin cannot make that dispatch
 * conditional, so the workflow installs this thin subclass through the public
 * `ctx.ui.setEditorComponent()` API. The subclass only changes the precedence
 * for the completion branch; every other key and every other extension
 * shortcut keeps the normal path.
 *
 * The Orchestrator Build child is a separate session, so the host's native
 * working indicator never reflects it. The same public subclass is the correct
 * seam: it overrides the protected border renderer and the public indicator
 * setter, without importing SDK-private modules or reading private fields.
 * Native rendering is delegated to unchanged whenever no child owns the
 * composer. While a child owns Esc, this editor consumes every Esc press so a
 * repeated press can never reach the host's abort handler.
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
 * - Do not declare `onEscape`: the core copies the default editor's handler
 *   after construction only when the subclass does not define one. Esc is
 *   intercepted in `handleInput` instead, which keeps native abort behaviour
 *   for every phase the child does not own.
 *
 * The history helpers keep prompt history alive across the editor swap that
 * `setCustomEditorComponent()` performs: the core copies the editor text but not
 * the `history` array.
 */

import {
  CustomEditor,
  type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  Key,
  isKeyRelease,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Editor,
  type EditorTheme,
  type TUI,
} from "@earendil-works/pi-tui";
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

/** What Esc means for the focused composer (see `orchestrator-activity.ts`). */
export type WorkflowEditorEscAction = "pause" | "swallow" | "pass";

/** One external activity line, already projected from run/child state. */
export interface WorkflowEditorActivity {
  line: string;
  compact?: string;
  busy: boolean;
  paused: boolean;
  esc: WorkflowEditorEscAction;
}

export interface WorkflowEditorHooks {
  /** Current external activity; `undefined` restores native-only rendering. */
  activity?: () => WorkflowEditorActivity | undefined;
  /**
   * Called synchronously for a consumed Esc press. `pause` asks the host to
   * pause the child; `swallow` is a silent no-op.
   */
  onEscConsumed?: (action: "pause" | "swallow") => void;
}

/** The host indicator type, reached through the public setter. */
type HostStatusIndicator = Parameters<
  CustomEditor["setWorkingStatusIndicator"]
>[0];

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_INTERVAL_MS = 80;

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
  private hooks: WorkflowEditorHooks;
  private hostHistoryAdded = false;
  /** The host's indicator object; host-owned, never mutated or disposed. */
  private hostIndicator: HostStatusIndicator;
  private ticker: ReturnType<typeof setInterval> | undefined;
  private frame = 0;
  private lastStatusKey = "";

  constructor(
    tui: TUI,
    theme: EditorTheme,
    keybindings: KeybindingsManager,
    hooks: WorkflowEditorHooks = {},
  ) {
    // The installed SDK supports the public option. Assigning the flag after
    // `super()` keeps this inert on older 0.84.x runtimes as well.
    super(tui, theme, keybindings, { embedWorkingStatus: true });
    this.tabKeybindings = keybindings;
    this.hooks = hooks;
    (this as any).embedWorkingStatus = true;
  }

  /** Replace the hooks after construction (host wiring/rebinding). */
  setHooks(hooks: WorkflowEditorHooks): void {
    this.hooks = hooks;
    this.refreshStatus();
  }

  /** True once the host has populated this editor's prompt history. */
  hasHostHistory(): boolean {
    return this.hostHistoryAdded;
  }

  override addToHistory(text: string): void {
    if (text.trim()) this.hostHistoryAdded = true;
    super.addToHistory(text);
  }

  /**
   * Mirror the host indicator's presence for border ownership. Delegating is
   * essential: the host creates and disposes this object; the editor only
   * observes it.
   */
  override setWorkingStatusIndicator(
    indicator: HostStatusIndicator,
  ): void {
    this.hostIndicator = indicator;
    super.setWorkingStatusIndicator(indicator);
    // With a live native indicator the host's own ticker repaints the border,
    // so the editor's fallback ticker must stop.
    if (indicator) this.stopTicker();
    else this.syncTicker();
  }

  /** Repaint after a projected activity/state change. */
  refreshStatus(): void {
    const activity = this.readActivity();
    const key = activity
      ? `${activity.busy ? "1" : "0"}|${activity.paused ? "1" : "0"}|${activity.line}`
      : "";
    if (key !== this.lastStatusKey) {
      this.lastStatusKey = key;
      this.invalidate();
    }
    this.syncTicker();
    try {
      this.tui.requestRender();
    } catch {
      /* display-only */
    }
  }

  /** Stop the fallback ticker (teardown / editor replacement). */
  disposeStatus(): void {
    this.stopTicker();
    this.hostIndicator = undefined;
    this.lastStatusKey = "";
  }

  override handleInput(data: string): void {
    // Orchestrator Esc ownership comes first. The child is a separate session,
    // so the host would otherwise treat Esc as "abort the parent" — or, while
    // paused, nothing at all. `activity.esc` decides; every non-pass action is
    // consumed synchronously, so a second press can never fall through.
    if (this.handleOrchestratorEscape(data)) return;

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

  protected override renderTopBorder(
    width: number,
    hiddenLineCount: number,
  ): string {
    const activity = this.readActivity();
    if (!activity || !activity.line) {
      return super.renderTopBorder(width, hiddenLineCount);
    }
    const glyph = this.statusGlyph(activity);
    const full = `${glyph} ${activity.line}`;
    const compact = `${glyph} ${activity.compact ?? activity.line}`;
    // Prefer the actionable line; fall back to the hint-free compact form
    // before the native spinner-only degradation.
    const status =
      visibleWidth(`── ${full} `) <= width ? full : compact;
    return this.composeBorder(width, hiddenLineCount, status);
  }

  // ── Internals ──────────────────────────────────────────────────────

  private readActivity(): WorkflowEditorActivity | undefined {
    try {
      return this.hooks.activity?.();
    } catch {
      return undefined;
    }
  }

  private handleOrchestratorEscape(data: string): boolean {
    if (!this.hooks.activity && !this.hooks.onEscConsumed) return false;
    if (isKeyRelease(data)) return false;
    if (!matchesKey(data, Key.escape)) return false;
    // A visible completion menu owns Esc: cancelling it must stay local.
    if (this.isShowingAutocomplete()) return false;
    const activity = this.readActivity();
    if (!activity || activity.esc === "pass") return false;
    try {
      this.hooks.onEscConsumed?.(
        activity.esc === "pause" ? "pause" : "swallow",
      );
    } catch {
      /* a consumed key must never surface an extension error */
    }
    return true;
  }

  /** A spinner while busy; a static pause/verify glyph otherwise. */
  private statusGlyph(activity: WorkflowEditorActivity): string {
    if (activity.busy) {
      if (this.hostIndicator) {
        return this.hostIndicator.renderSpinnerInBorder(4).trimEnd();
      }
      return SPINNER_FRAMES[this.frame % SPINNER_FRAMES.length] ?? "⠋";
    }
    if (activity.paused) return "⏸";
    return "◇";
  }

  /**
   * Same border geometry as the host: `── <status> ` then a fill, with the
   * multiline overflow label kept centred when it fits.
   */
  private composeBorder(
    width: number,
    hiddenLineCount: number,
    status: string,
  ): string {
    if (width <= 0) return "";
    const coloredStatus = this.borderColor(status);
    const statusWidth = visibleWidth(status);
    const overflow =
      hiddenLineCount > 0 ? ` ↑ ${hiddenLineCount} more ` : undefined;
    const overflowWidth = overflow ? visibleWidth(overflow) : 0;
    const overflowStart = Math.floor((width - overflowWidth) / 2);
    if (
      overflow &&
      overflowWidth + 2 <= width &&
      overflowStart - (3 + statusWidth + 1) >= 1
    ) {
      const leftBlock = 3 + statusWidth + 1;
      return (
        this.borderColor("── ") +
        coloredStatus +
        this.borderColor(
          ` ${"─".repeat(overflowStart - leftBlock)}${overflow}${"─".repeat(
            Math.max(0, width - overflowStart - overflowWidth),
          )}`,
        )
      );
    }
    if (width >= statusWidth + 5) {
      return (
        this.borderColor("── ") +
        coloredStatus +
        this.borderColor(` ${"─".repeat(width - statusWidth - 4)}`)
      );
    }
    // Narrow terminal: no room for the frame. Truncate the status itself.
    return this.borderColor(truncateToWidth(status, width, ""));
  }

  /** Start/stop the single fallback ticker based on current activity. */
  private syncTicker(): void {
    const activity = this.readActivity();
    const animate = activity?.busy === true && !this.hostIndicator;
    if (animate) {
      if (this.ticker === undefined) {
        this.ticker = setInterval(() => {
          this.frame = (this.frame + 1) % SPINNER_FRAMES.length;
          this.invalidate();
          try {
            this.tui.requestRender();
          } catch {
            /* display-only */
          }
        }, SPINNER_INTERVAL_MS);
        // SAFETY: Node's Timeout exposes `unref()`; a DOM-style handle from a
        // non-Node host does not, so the call is optional. A display ticker
        // must never keep the process alive on its own.
        (this.ticker as unknown as { unref?: () => void }).unref?.();
      }
    } else {
      this.stopTicker();
    }
  }

  private stopTicker(): void {
    if (this.ticker !== undefined) {
      clearInterval(this.ticker);
      this.ticker = undefined;
    }
  }
}
