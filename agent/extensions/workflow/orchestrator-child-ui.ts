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

export interface ChildUiBridgeOptions {
  /**
   * Called when the first forwarded dialog opens and when the last closes.
   * Lets the parent composer show Waiting instead of Working, without
   * forwarding any child chrome write.
   */
  onDialogActivity?: (active: boolean) => void;
}

export interface ChildUiBridge {
  /** True while the bridge may still forward dialogs. */
  readonly alive: boolean;
  /** Forwarded dialogs currently open (serialized, so 0 or 1 in practice). */
  readonly activeDialogs: number;
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
  options: ChildUiBridgeOptions = {},
): ChildUiBridge {
  const ui = (parentUi ?? {}) as Record<string, AnyFn | undefined>;
  let alive = true;
  let queue: Promise<unknown> = Promise.resolve();
  let dialogDepth = 0;
  let dialogActive = false;

  const publishDialogActivity = (active: boolean): void => {
    if (active === dialogActive) return;
    dialogActive = active;
    try {
      options.onDialogActivity?.(active);
    } catch {
      /* display-only */
    }
  };

  const dialogStart = (): void => {
    dialogDepth += 1;
    if (dialogDepth === 1) publishDialogActivity(true);
  };

  const dialogEnd = (): void => {
    dialogDepth = Math.max(0, dialogDepth - 1);
    if (dialogDepth === 0) publishDialogActivity(false);
  };

  const has = (name: string): boolean => typeof ui[name] === "function";

  /** Serialize one dialog; a failure denies rather than throwing. */
  const serial = <T>(run: () => Promise<T>, deny: T): Promise<T> => {
    const next = queue.then(async () => {
      if (!alive) return deny;
      dialogStart();
      try {
        return await run();
      } catch {
        return deny;
      } finally {
        dialogEnd();
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
    get activeDialogs() {
      return dialogDepth;
    },
    dispose() {
      alive = false;
      if (dialogDepth !== 0) {
        dialogDepth = 0;
        publishDialogActivity(false);
      }
    },
    uiContext,
  };
}
