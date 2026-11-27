/**
 * Filterable picker primitives shared by the `/profile` and `/role` overlays.
 *
 * pi-tui's `SelectList` deliberately has no text composer: `handleInput()` only
 * understands Up/Down/Enter/Escape and silently drops printable keys, while
 * `setFilter()` is a prefix match on `item.value`. pi's own `/model` selector
 * solves this with an `Input` + `fuzzyFilter`; this module exposes the same
 * shape as a reusable component because pi's selector lives in pi's internal
 * `dist/` and is not a public export.
 *
 * Contract for `FilterableList.handleInput(data)`:
 *   - returns `true` when the key was consumed by the composer or list;
 *   - returns `false` for Enter (`tui.select.confirm`) and for the cancel key
 *     when the filter is already empty, so the caller can apply its own
 *     confirm / back / cancel semantics (Enter on a no-match list must stay
 *     inert instead of closing the overlay).
 */

import {
  Input,
  Key,
  SelectList,
  fuzzyFilter,
  getKeybindings,
  matchesKey,
  type SelectItem,
  type SelectListLayoutOptions,
  type SelectListTheme,
} from "@earendil-works/pi-tui";

/** A selectable row plus hidden text that the filter may match but never renders. */
export interface FilterableItem extends SelectItem {
  /**
   * Extra search-only text (e.g. a model's display name). `SelectList` ignores
   * unknown properties, so this never affects the rendered columns.
   */
  searchText?: string;
}

/** The text a row is matched against: label, value, description and hidden text. */
export function pickerItemText(item: FilterableItem): string {
  const parts: string[] = [];
  const seen = new Set<string>();
  for (const part of [
    item.label,
    item.value,
    item.description,
    item.searchText,
  ]) {
    if (!part) continue;
    const text = part.trim();
    // Model rows use the ref as both label and value; dedupe so the fuzzy
    // scorer does not weight the same string twice (and can still award the
    // exact-match bonus).
    if (!text || seen.has(text)) continue;
    seen.add(text);
    parts.push(text);
  }
  return parts.join(" ");
}

/**
 * Fuzzy-filter `items` (best match first). A blank query returns every item.
 * Matching uses `fuzzyFilter`, so whitespace- and slash-separated tokens all
 * have to match; it is case-insensitive.
 */
export function filterPickerItems<T extends FilterableItem>(
  items: readonly T[],
  query: string,
  getText: (item: T) => string = pickerItemText,
): T[] {
  const all = [...items];
  if (!query.trim()) return all;
  return fuzzyFilter(all, query, getText);
}

export interface FilterableListOptions {
  items: readonly FilterableItem[];
  maxVisible: number;
  theme: SelectListTheme;
  layout?: SelectListLayoutOptions;
  /** Seed the composer (e.g. a filter remembered across a re-opened picker). */
  initialQuery?: string;
  /** Initial cursor when the query is empty. */
  initialIndex?: number;
  /** Filter-text builder; defaults to `pickerItemText`. */
  searchText?: (item: FilterableItem) => string;
  /** Message shown when nothing matches (without the two-space indent). */
  noMatchText?: string;
}

/**
 * A `SelectList` paired with an `Input` composer and fuzzy filtering.
 *
 * `SelectList` has no item setter, so the inner list is rebuilt whenever the
 * filtered set changes. The wrapper itself is stable, which is what callers
 * keep per tab so filter text and cursor survive tab switches.
 */
export class FilterableList {
  private items: FilterableItem[];
  private filtered: FilterableItem[];
  private query: string;
  private readonly maxVisible: number;
  private readonly theme: SelectListTheme;
  private readonly layout: SelectListLayoutOptions | undefined;
  private readonly searchText: (item: FilterableItem) => string;
  private readonly noMatchText: string;
  private readonly input: Input;
  private inner: SelectList;

  constructor(opts: FilterableListOptions) {
    this.items = [...opts.items];
    this.maxVisible = opts.maxVisible;
    this.theme = opts.theme;
    this.layout = opts.layout;
    this.searchText = opts.searchText ?? pickerItemText;
    this.noMatchText = opts.noMatchText ?? "No matching entries";
    this.input = new Input();
    // Input.setValue() clamps the cursor instead of moving it to the end, so a
    // remembered query is seeded by simulating typing. Otherwise the next key
    // would be inserted at position 0.
    if (opts.initialQuery) this.input.handleInput(opts.initialQuery);
    this.query = this.input.getValue();
    this.filtered = filterPickerItems(this.items, this.query, this.searchText);
    this.inner = new SelectList(
      this.filtered,
      this.maxVisible,
      this.theme,
      this.layout,
    );
    if (!this.query && opts.initialIndex && opts.initialIndex > 0) {
      this.inner.setSelectedIndex(opts.initialIndex);
    }
  }

  /** Current filter text ("" when unfiltered). */
  getQuery(): string {
    return this.query;
  }

  /** All rows, unfiltered. */
  getItems(): readonly FilterableItem[] {
    return this.items;
  }

  /** Rows matching the current query (the list the user is navigating). */
  getFilteredItems(): readonly FilterableItem[] {
    return this.filtered;
  }

  /** The highlighted row, or null when nothing matches. */
  getSelectedItem(): SelectItem | null {
    return this.inner.getSelectedItem();
  }

  /** Move the cursor (only meaningful while the query is empty). */
  setSelectedIndex(index: number): void {
    this.inner.setSelectedIndex(index);
  }

  /** Reset the filter and restore the full list. */
  clearFilter(): void {
    if (!this.query) return;
    this.applyQuery("");
  }

  /**
   * Replace the rows (e.g. Ctrl+O scope toggle). The query and the selected
   * value are preserved when they still exist in the new set.
   */
  setItems(items: readonly FilterableItem[]): void {
    const previous = this.inner.getSelectedItem()?.value;
    this.items = [...items];
    this.refilter(previous);
  }

  /** One composer line, sized to `width`. */
  renderQuery(width: number): string[] {
    return this.input.render(Math.max(1, width));
  }

  /** The filtered list, or a themed no-match line, sized to `width`. */
  renderList(width: number): string[] {
    if (this.filtered.length === 0) {
      return [this.theme.noMatch(`  ${this.noMatchText}`)];
    }
    return this.inner.render(Math.max(1, width));
  }

  /**
   * Navigation + filter editing. Returns false for keys the caller owns:
   * Enter, and Escape/Ctrl+C when the filter is empty.
   */
  handleInput(data: string): boolean {
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
      if (this.query) {
        this.applyQuery("");
        return true;
      }
      return false;
    }
    const kb = getKeybindings();
    if (
      kb.matches(data, "tui.select.up") ||
      kb.matches(data, "tui.select.down")
    ) {
      if (this.filtered.length > 0) this.inner.handleInput(data);
      return true;
    }
    if (kb.matches(data, "tui.select.confirm")) return false;
    this.input.handleInput(data);
    const next = this.input.getValue();
    if (next !== this.query) this.applyQuery(next);
    return true;
  }

  /** Apply a new query, resetting to the top match or restoring the previous row. */
  private applyQuery(next: string): void {
    const previous = this.inner.getSelectedItem()?.value;
    this.query = next;
    if (this.input.getValue() !== next) this.input.setValue(next);
    this.refilter(previous);
  }

  private refilter(previous: string | undefined): void {
    this.filtered = filterPickerItems(
      this.items,
      this.query,
      this.searchText,
    );
    this.inner = new SelectList(
      this.filtered,
      this.maxVisible,
      this.theme,
      this.layout,
    );
    if (this.query) {
      this.inner.setSelectedIndex(0);
      return;
    }
    const index = previous
      ? this.filtered.findIndex((item) => item.value === previous)
      : -1;
    this.inner.setSelectedIndex(Math.max(0, index));
  }
}
