/**
 * Workflow Extension — Review Workspace (dual-pane overlay)
 *
 * Left column  = Plan Mode transcript (mirrored live from the parent session)
 * Right column = reviewer transcript (streamed from the child session)
 *
 * Why an overlay with manually composed columns rather than a real split:
 * pi-tui's constrained `HStack`/`VStack` regions only work on the experimental
 * `tuiMode: "fullscreen"` alt-screen (`TuiAltScreen`); the default TUI is
 * `TuiMainScreen`, where the terminal owns scrollback and extension widgets are
 * capped at ~10 lines. So the two panes are rendered as line buffers, sliced to
 * their own viewport height, and composed side-by-side by `composeTwoColumn`.
 * The result is a genuine two-column view with independent scrolling that works
 * in the default TUI.
 *
 * The overlay is non-modal in the sense that the agent keeps running: it takes
 * keyboard focus while open, and `Esc` closes it without cancelling the review.
 */

import { Key, matchesKey, type OverlayHandle } from "@earendil-works/pi-tui";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  composeTwoColumn,
  displayWidth,
  padAnsi,
  sliceViewport,
} from "./utils.ts";

/** Keys are shown in the footer; keep this list in sync with handleInput. */
export const REVIEW_PANE_KEYS =
  "Tab focus • ↑↓ scroll • PgUp/PgDn page • g/G top/bottom • f follow • c collapse • x abort • Esc close";

const MIN_BODY_ROWS = 4;
const COLUMN_GAP = 3;

export interface ReviewPaneDeps {
  /** e.g. `2026-09-18-review-mode.md` */
  planLabel: () => string;
  /** e.g. `opencode-go/muse-spark-1.3-contributor` */
  modelLabel: () => string;
  /** One-line status for the header (phase, pass, findings). */
  statusLine: () => string;
  /** Left pane content: the Plan Mode transcript mirror. */
  planLines: () => string[];
  /** Right pane content: the reviewer transcript. */
  reviewLines: () => string[];
  /** `x` — cancel the in-flight review round. */
  onAbort: () => void;
  /**
   * Fired exactly once when the pane stops being displayed, whatever the cause
   * (Esc, external close, or the overlay being disposed).
   */
  onClosed?: () => void;
}

export interface ReviewPaneController {
  /** Hide the overlay if it is showing. Safe to call repeatedly. */
  close(): void;
  isOpen(): boolean;
}

type Focus = "plan" | "review";

export function openReviewPane(
  ctx: ExtensionContext,
  deps: ReviewPaneDeps,
): ReviewPaneController {
  let open = true;
  let handle: OverlayHandle | undefined;
  let closedNotified = false;

  const notifyClosed = () => {
    if (closedNotified) return;
    closedNotified = true;
    open = false;
    try {
      deps.onClosed?.();
    } catch {
      /* callbacks are best-effort */
    }
  };

  // Terminal-only: in RPC/print mode there is no overlay to render.
  if (ctx.mode !== "tui") {
    notifyClosed();
    return { close: () => {}, isOpen: () => false };
  }

  const finished = ctx.ui.custom<null>(
    (tui, theme, _kb, done) => {
      let focus: Focus = "review";
      let planOffset = 0;
      let reviewOffset = 0;
      let planFollow = false;
      let reviewFollow = true;
      let collapsed = false;
      let cached: string[] | undefined;

      const refresh = () => {
        cached = undefined;
        tui.requestRender();
      };
      const closePane = () => {
        notifyClosed();
        done(null);
      };
      const terminalRows = (): number => {
        const rows = (tui as { terminal?: { rows?: number } })?.terminal?.rows;
        return typeof rows === "number" && rows > 0 ? rows : 30;
      };
      const setFollow = (value: boolean) => {
        if (focus === "plan") planFollow = value;
        else reviewFollow = value;
      };
      const isFollowing = () => (focus === "plan" ? planFollow : reviewFollow);
      const scrollBy = (delta: number) => {
        setFollow(false);
        if (focus === "plan") planOffset += delta;
        else reviewOffset += delta;
        refresh();
      };
      const jump = (toEnd: boolean) => {
        // A large offset is clamped by sliceViewport, so "end" is just a
        // sentinel that cannot be exceeded.
        if (focus === "plan") {
          planOffset = toEnd ? Number.MAX_SAFE_INTEGER : 0;
          planFollow = toEnd;
        } else {
          reviewOffset = toEnd ? Number.MAX_SAFE_INTEGER : 0;
          reviewFollow = toEnd;
        }
        refresh();
      };

      const handleInput = (data: string) => {
        if (matchesKey(data, Key.escape)) {
          closePane();
          return;
        }
        if (matchesKey(data, Key.tab)) {
          focus = focus === "plan" ? "review" : "plan";
          refresh();
          return;
        }
        if (matchesKey(data, Key.up)) {
          scrollBy(-1);
          return;
        }
        if (matchesKey(data, Key.down)) {
          scrollBy(1);
          return;
        }
        const halfPage = Math.max(3, Math.floor(terminalRows() / 2));
        if (matchesKey(data, Key.pageUp)) {
          scrollBy(-halfPage);
          return;
        }
        if (matchesKey(data, Key.pageDown)) {
          scrollBy(halfPage);
          return;
        }
        if (data === "g") {
          jump(false);
          return;
        }
        if (data === "G") {
          jump(true);
          return;
        }
        if (data === "f" || data === "F") {
          setFollow(!isFollowing());
          refresh();
          return;
        }
        if (data === "c" || data === "C") {
          collapsed = !collapsed;
          refresh();
          return;
        }
        if (data === "x" || data === "X") {
          try {
            deps.onAbort();
          } catch {
            /* abort is best-effort */
          }
          refresh();
        }
      };

      const render = (width: number): string[] => {
        if (cached) return cached;
        const W = Math.max(20, width);
        const rows = terminalRows();
        const out: string[] = [];

        // ── Header ────────────────────────────────────────────────────
        const title = ` Review Workspace — ${deps.planLabel()} `;
        out.push(theme.fg("accent", theme.bold(padAnsi(title, W))));
        out.push(
          theme.fg(
            "muted",
            padAnsi(
              ` reviewer: ${deps.modelLabel()} · ${deps.statusLine()} `,
              W,
            ),
          ),
        );
        out.push(theme.fg("accent", "─".repeat(W)));

        // ── Column titles ─────────────────────────────────────────────
        const colW = Math.max(8, Math.floor((W - COLUMN_GAP - 2) / 2));
        const rightW = Math.max(8, W - colW - COLUMN_GAP);
        const planTitle =
          focus === "plan"
            ? theme.fg("accent", theme.bold("▶ PLAN MODE"))
            : theme.fg("muted", "  PLAN MODE");
        const reviewTitle =
          focus === "review"
            ? theme.fg("accent", theme.bold("▶ REVIEW MODE"))
            : theme.fg("muted", "  REVIEW MODE");
        out.push(
          padAnsi(planTitle, colW) +
            " ".repeat(COLUMN_GAP) +
            padAnsi(reviewTitle, rightW),
        );

        // ── Body ──────────────────────────────────────────────────────
        // Chrome is: title + subtitle + separator + column titles +
        // separator + footer = 6 rows. Budget the remainder for the panes.
        const CHROME_ROWS = 6;
        const bodyH = collapsed
          ? 1
          : Math.max(MIN_BODY_ROWS, rows - CHROME_ROWS);
        const left = sliceViewport(
          deps.planLines(),
          planOffset,
          bodyH,
          planFollow,
        );
        const right = sliceViewport(
          deps.reviewLines(),
          reviewOffset,
          bodyH,
          reviewFollow,
        );
        planOffset = left.offset;
        reviewOffset = right.offset;

        if (collapsed) {
          out.push(
            theme.fg(
              "dim",
              padAnsi(
                ` (collapsed — reviewer has ${deps.reviewLines().length} line(s); press c to expand, Tab to switch pane)`,
                W,
              ),
            ),
          );
        } else {
          // Pad BOTH columns to exactly bodyH so the footer stays anchored
          // regardless of which pane is shorter.
          const pad = (lines: string[]): string[] => {
            const copy = lines.slice(0, bodyH);
            while (copy.length < bodyH) copy.push("");
            return copy;
          };
          out.push(
            ...composeTwoColumn(
              pad(left.lines),
              pad(right.lines),
              colW,
              rightW,
              COLUMN_GAP,
            ),
          );
        }

        // ── Footer ────────────────────────────────────────────────────
        const followMark = isFollowing() ? "follow:on" : "follow:off";
        const scrollInfo = `${focus} ${left.offset}/${left.maxOffset} · ${right.offset}/${right.maxOffset} · ${followMark}`;
        out.push(theme.fg("accent", "─".repeat(W)));
        out.push(
          theme.fg("dim", padAnsi(` ${REVIEW_PANE_KEYS}  [${scrollInfo}]`, W)),
        );
        cached = out;
        return out;
      };

      return {
        render,
        invalidate: () => {
          cached = undefined;
        },
        handleInput,
        dispose: () => {
          notifyClosed();
        },
      };
    },
    {
      overlay: true,
      overlayOptions: () => ({
        width: "100%",
        maxHeight: "100%",
        margin: 1,
      }),
      onHandle: (h) => {
        handle = h;
      },
    },
  );

  // The promise settles when the overlay closes; swallow rejections so a UI
  // teardown cannot surface as an unhandled rejection.
  void finished
    .catch(() => null)
    .finally(() => {
      notifyClosed();
    });

  return {
    close() {
      try {
        handle?.hide();
      } catch {
        /* already gone */
      }
      notifyClosed();
    },
    isOpen: () => open,
  };
}

/** Number of columns each pane gets for a given terminal width (for tests). */
export function paneColumnWidths(terminalWidth: number): {
  left: number;
  right: number;
  gap: number;
} {
  const W = Math.max(20, Math.trunc(terminalWidth) || 20);
  const left = Math.max(8, Math.floor((W - COLUMN_GAP - 2) / 2));
  const right = Math.max(8, W - left - COLUMN_GAP);
  return { left, right, gap: COLUMN_GAP };
}

/** True when a line fits the pane width without truncation (for tests). */
export function lineFitsPane(line: string, width: number): boolean {
  return displayWidth(line) <= width;
}
