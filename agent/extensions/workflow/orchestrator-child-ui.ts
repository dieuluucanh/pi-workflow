/**
 * Workflow Extension — parent UI bridge for an in-process Build child.
 *
 * The child is a second Workflow extension instance in the SAME process. Its
 * permission dialogs (write/folder/read/shell gates) must reach the real user,
 * but its status/widget/footer writes must never overwrite the parent's.
 *
 * This bridge forwards dialogs and notifications to the parent UI, serializes
 * them so two dialogs can never overlap, and no-ops every chrome surface.
 * A headless parent denies dialogs instead of pretending it has a UI.
 */

export interface ChildUiLabel {
  ref: string;
  total: number;
}

export interface ChildUiBridge {
  /** True while the bridge may still forward dialogs. */
  readonly alive: boolean;
  dispose(): void;
  /** The object handed to `bindExtensions({ uiContext })`. */
  readonly uiContext: Record<string, unknown>;
}

type AnyFn = (...args: any[]) => any;

function prefix(label: ChildUiLabel, text: string): string {
  return `[child ${label.ref}/${label.total}] ${text}`;
}

/**
 * Create the bridge. `parentUi` is structurally the parent extension's
 * `ctx.ui`; it is not imported as a Pi type so this module stays testable.
 */
export function createChildUiBridge(
  parentUi: unknown,
  label: ChildUiLabel,
): ChildUiBridge {
  const ui = (parentUi ?? {}) as Record<string, AnyFn | undefined>;
  let alive = true;
  let queue: Promise<unknown> = Promise.resolve();

  const has = (name: string): boolean => typeof ui[name] === "function";

  /** Serialize one dialog; a failure denies rather than throwing. */
  const serial = <T>(run: () => Promise<T>, deny: T): Promise<T> => {
    const next = queue.then(async () => {
      if (!alive) return deny;
      try {
        return await run();
      } catch {
        return deny;
      }
    });
    queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };

  const notify = (message: string, type?: "info" | "warning" | "error"): void => {
    if (!alive || !has("notify")) return;
    try {
      ui.notify!(prefix(label, message), type);
    } catch {
      /* display-only */
    }
  };

  const uiContext: Record<string, unknown> = {
    // ── Forwarded dialogs ────────────────────────────────────────────
    select: (title: string, options: string[], opts?: unknown) =>
      serial(async () => {
        if (!has("select")) return undefined;
        return await ui.select!(prefix(label, title), options, opts);
      }, undefined),
    confirm: (title: string, message: string, opts?: unknown) =>
      serial(async () => {
        if (!has("confirm")) return false;
        return await ui.confirm!(prefix(label, title), message, opts);
      }, false),
    input: (title: string, placeholder?: string, opts?: unknown) =>
      serial(async () => {
        if (!has("input")) return undefined;
        return await ui.input!(prefix(label, title), placeholder, opts);
      }, undefined),
    editor: (title: string, prefill?: string) =>
      serial(async () => {
        if (!has("editor")) return undefined;
        return await ui.editor!(prefix(label, title), prefill);
      }, undefined),
    custom: (factory: unknown, options?: unknown) =>
      serial(async () => {
        if (!has("custom")) return undefined;
        return await ui.custom!(factory, options);
      }, undefined),
    notify,

    // ── Chrome: never let the child repaint the parent ───────────────
    onTerminalInput: () => () => {},
    setStatus: () => {},
    setWorkingMessage: () => {},
    setWorkingVisible: () => {},
    setWorkingIndicator: () => {},
    setHiddenThinkingLabel: () => {},
    setWidget: () => {},
    setFooter: () => {},
    setHeader: () => {},
    setTitle: () => {},
    pasteToEditor: () => {},
    setEditorText: () => {},
    getEditorText: () => "",
    addAutocompleteProvider: () => {},
    setEditorComponent: () => {},
    getEditorComponent: () => undefined,
    getToolsExpanded: () => false,
    setToolsExpanded: () => {},
    // Theme reads are harmless; the child only needs them to colour a dialog
    // it never renders. Returning undefined keeps it defensive.
    getAllThemes: () => [],
    getTheme: () => undefined,
    setTheme: () => ({ ok: false }),
  };

  return {
    get alive() {
      return alive;
    },
    dispose() {
      alive = false;
    },
    uiContext,
  };
}
