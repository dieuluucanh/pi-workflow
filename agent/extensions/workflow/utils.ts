/**
 * Shared utils for workflow extension — copied from plan-mode example
 * Pure functions, testable. Deliberately dependency-free (no Pi / pi-tui
 * imports) so it stays loadable in plain Node tests. TUI composition helpers
 * live in review-pane.ts instead.
 */

const DESTRUCTIVE_PATTERNS = [
  /\brm\b/i,
  /\brmdir\b/i,
  /\bmv\b/i,
  /\bcp\b/i,
  /\bmkdir\b/i,
  /\btouch\b/i,
  /\bchmod\b/i,
  /\bchown\b/i,
  /\bchgrp\b/i,
  /\bln\b/i,
  /\btee\b/i,
  /\btruncate\b/i,
  /\bdd\b/i,
  /\bshred\b/i,
  /(^|[^<])>(?!>)/,
  />>/,
  /\bnpm\s+(install|uninstall|update|ci|link|publish)/i,
  /\byarn\s+(add|remove|install|publish)/i,
  /\bpnpm\s+(add|remove|install|publish)/i,
  /\bpip\s+(install|uninstall)/i,
  /\bapt(-get)?\s+(install|remove|purge|update|upgrade)/i,
  /\bbrew\s+(install|uninstall|upgrade)/i,
  /\bgit\s+(add|commit|push|pull|merge|rebase|reset|checkout|branch\s+-[dD]|stash|cherry-pick|revert|tag|init|clone)/i,
  /\bsudo\b/i,
  /\bsu\b/i,
  /\bkill\b/i,
  /\bpkill\b/i,
  /\bkillall\b/i,
  /\breboot\b/i,
  /\bshutdown\b/i,
  /\bsystemctl\s+(start|stop|restart|enable|disable)/i,
  /\bservice\s+\S+\s+(start|stop|restart)/i,
  /\b(vim?|nano|emacs|code|subl)\b/i,
];

const SAFE_PATTERNS = [
  /^\s*cat\b/,
  /^\s*head\b/,
  /^\s*tail\b/,
  /^\s*less\b/,
  /^\s*more\b/,
  /^\s*grep\b/,
  /^\s*find\b/,
  /^\s*ls\b/,
  /^\s*pwd\b/,
  /^\s*echo\b/,
  /^\s*printf\b/,
  /^\s*wc\b/,
  /^\s*sort\b/,
  /^\s*uniq\b/,
  /^\s*diff\b/,
  /^\s*file\b/,
  /^\s*stat\b/,
  /^\s*du\b/,
  /^\s*df\b/,
  /^\s*tree\b/,
  /^\s*which\b/,
  /^\s*whereis\b/,
  /^\s*type\b/,
  /^\s*env\b/,
  /^\s*printenv\b/,
  /^\s*uname\b/,
  /^\s*whoami\b/,
  /^\s*id\b/,
  /^\s*date\b/,
  /^\s*cal\b/,
  /^\s*uptime\b/,
  /^\s*ps\b/,
  /^\s*top\b/,
  /^\s*htop\b/,
  /^\s*free\b/,
  /^\s*git\s+(status|log|diff|show|branch|remote|config\s+--get)/i,
  /^\s*git\s+ls-/i,
  /^\s*npm\s+(list|ls|view|info|search|outdated|audit)/i,
  /^\s*yarn\s+(list|info|why|audit)/i,
  /^\s*node\s+--version/i,
  /^\s*python\s+--version/i,
  /^\s*curl\s/i,
  /^\s*wget\s+-O\s*-/i,
  /^\s*jq\b/,
  /^\s*sed\s+-n/i,
  /^\s*awk\b/,
  /^\s*rg\b/,
  /^\s*fd\b/,
  /^\s*bat\b/,
  /^\s*eza\b/,
];

export function isSafeCommand(command: string): boolean {
  const isDestructive = DESTRUCTIVE_PATTERNS.some((p) => p.test(command));
  const isSafe = SAFE_PATTERNS.some((p) => p.test(command));
  return !isDestructive && isSafe;
}

export type TodoStatus = "pending" | "in_progress" | "completed" | "cancelled";

export interface TodoItem {
  step: number;
  text: string;
  /** Legacy boolean flag; kept derived from `status` for old sessions/external readers. */
  completed: boolean;
  /** Industry-style status. Legacy items derive it from `completed`. */
  status?: TodoStatus;
  /** Stable, globally-unique identity ref assigned at creation and never renumbered. */
  ref?: string;
  /** Plan-faithful label, e.g. "1", "2.3". Legacy items derive it from step. */
  label?: string;
  /** Optional group/phase heading the step belongs to. */
  group?: string;
  /** Where the item came from. */
  source?: "plan" | "agent" | "synthesized";
}

const TODO_STATUS_RANK: Record<TodoStatus, number> = {
  completed: 3,
  in_progress: 2,
  pending: 1,
  cancelled: 0,
};

/** Resolve an item's status; legacy `completed` booleans are backfilled. */
export function itemStatus(it: TodoItem): TodoStatus {
  if (it?.status) return it.status;
  return it?.completed ? "completed" : "pending";
}

/** True when the item is done. */
export function isDone(it: TodoItem): boolean {
  return itemStatus(it) === "completed";
}

/** Set an item's status and keep the legacy `completed` flag in sync. */
export function setTodoStatus(it: TodoItem, status: TodoStatus): TodoItem {
  it.status = status;
  it.completed = status === "completed";
  return it;
}

/**
 * Merge precedence for two sources disagreeing on status: the more advanced
 * rank wins (completed > in_progress > pending > cancelled), so a plan-file
 * `- [x]` can mark an item done but nothing can silently un-complete it.
 */
export function mergeStatusByRank(
  a: TodoStatus | undefined,
  b: TodoStatus | undefined,
): TodoStatus {
  const ra = a ? TODO_STATUS_RANK[a] : 0;
  const rb = b ? TODO_STATUS_RANK[b] : 0;
  return rb > ra ? (b as TodoStatus) : ((a ?? "pending") as TodoStatus);
}

/** Canonical, globally-unique ref for an item (stable across merges). */
export function todoRef(it: Pick<TodoItem, "ref" | "step">): string {
  return it?.ref || String(it?.step ?? 0);
}

/** Numeric value of a ref, if it is an integer (for range math). */
export function todoRefNumber(ref: string): number | undefined {
  const n = Number(String(ref ?? "").trim());
  return Number.isFinite(n) && Number.isInteger(n) ? n : undefined;
}

/**
 * Normalize step text for display and identity. Strips markdown emphasis
 * (including orphan `**` left by partially consumed bold) and collapses
 * whitespace. Deliberately does NOT strip imperative verbs — the todo list
 * must mirror the plan's wording.
 */
export function normalizeStepText(text: string): string {
  let cleaned = String(text ?? "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/\*{1,2}/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[:\-\u2013\u2014]\s*$/, "")
    .trim();
  if (cleaned.length > 200) cleaned = `${cleaned.slice(0, 197)}...`;
  return cleaned;
}

/** @deprecated kept for compatibility; use normalizeStepText. */
export function cleanStepText(text: string): string {
  return normalizeStepText(text);
}

/** Stable identity key for dedupe/merge (case/punctuation-insensitive). */
export function todoKey(item: Pick<TodoItem, "text" | "group">): string {
  const norm = (s: string | undefined) =>
    String(s ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  const g = norm(item.group);
  const t = norm(item.text);
  return g ? `${g}|${t}` : t;
}

/**
 * Backfill labels/ref/status/source for items restored from older sessions.
 * Global refs are canonical positions: `step`/`ref` are recomputed as 1..N in
 * array order, so persisted lists with inflated refs (e.g. 17..23 written by
 * an older build) heal on restore. Plan labels are preserved as display
 * metadata and default to the position when absent.
 */
export function ensureTodoLabels(items: TodoItem[]): TodoItem[] {
  return (items ?? []).map((it, i) => {
    const step = i + 1;
    // Preserve the original positional label for legacy rows without a label.
    const originalStep = Number.isFinite(it?.step) ? Number(it.step) : step;
    const status = itemStatus(it);
    return {
      ...it,
      step,
      label: it?.label || String(originalStep),
      ref: String(step),
      status,
      completed: status === "completed",
      source: it?.source ?? "plan",
    };
  });
}

/** Stable dedupe — first occurrence wins. */
export function dedupeTodoItems(items: TodoItem[]): TodoItem[] {
  const seen = new Set<string>();
  const out: TodoItem[] = [];
  for (const it of items ?? []) {
    const key = todoKey(it);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(it);
  }
  return out;
}

export interface TodoMergeResult {
  items: TodoItem[];
  added: number;
  removed: number;
  kept: number;
  /** Number of unmatched `source:"agent"` items preserved from the previous list. */
  preserved: number;
}

/**
 * Merge freshly extracted plan steps into the existing list while preserving
 * completion state for steps that are still present. Extracted order wins.
 *
 * Match order: exact `todoKey` (text+group) first, then — for existing
 * `source:"plan"` rows — the plan label (group-aware, collision-safe), so a
 * step whose wording the model rewrote in `workflow_todo update` still
 * reunites with its plan row instead of being duplicated. On a label match the
 * extracted text is authoritative and status merges by rank (a plan-file
 * `- [x]` can mark an item done, nothing un-completes it). Unmatched
 * `source:"agent"` items are preserved.
 *
 * Global refs are canonical positions: `step`/`ref` are recomputed as 1..N in
 * the returned list order, so displayed numbers always equal `todoRef`.
 */
export function mergeTodoItems(
  existing: TodoItem[],
  extracted: TodoItem[],
): TodoMergeResult {
  const prev = ensureTodoLabels(existing ?? []);
  const next = dedupeTodoItems((extracted ?? []).map((n) => ({ ...n })));
  const normLabel = (s: string | undefined) =>
    String(s ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  const byLabel = new Map<string, TodoItem[]>();
  const byKey = new Map<string, TodoItem>();
  for (const p of prev) {
    const l = normLabel(p.label || String(p.step));
    if (l) {
      const arr = byLabel.get(l);
      if (arr) arr.push(p);
      else byLabel.set(l, [p]);
    }
    const k = todoKey(p);
    if (k && !byKey.has(k)) byKey.set(k, p);
  }
  const used = new Set<TodoItem>();
  let added = 0;
  let kept = 0;
  /**
   * Collision-safe plan-label match for a re-extracted step. Only existing
   * `source:"plan"` rows are eligible; when duplicate labels exist across
   * phases the group must disambiguate (otherwise the label is not trusted).
   */
  const matchByPlanLabel = (n: TodoItem): TodoItem | undefined => {
    const l = normLabel(n.label);
    if (!l) return undefined;
    const cands = (byLabel.get(l) ?? []).filter(
      (p) => !used.has(p) && p.source === "plan",
    );
    if (cands.length === 0) return undefined;
    if (cands.length === 1) return cands[0];
    const ng = normLabel(n.group);
    const grouped = cands.filter((p) => normLabel(p.group) === ng);
    return grouped.length === 1 ? grouped[0] : undefined;
  };
  const items = next.map((n) => {
    const nKey = todoKey(n);
    let match: TodoItem | undefined = nKey ? byKey.get(nKey) : undefined;
    if (match && used.has(match)) match = undefined;
    if (!match) match = matchByPlanLabel(n);
    if (match && !used.has(match)) {
      used.add(match);
      kept++;
      const item: TodoItem = {
        ...n,
        group: n.group ?? match.group,
        source: n.source ?? match.source,
      };
      const status = mergeStatusByRank(itemStatus(match), itemStatus(item));
      setTodoStatus(item, status);
      return item;
    }
    added++;
    const item: TodoItem = { ...n };
    if (item.status) item.completed = item.status === "completed";
    else setTodoStatus(item, item.completed ? "completed" : "pending");
    return item;
  });
  // Preserve unmatched agent-added items (progress + ad-hoc steps survive sync).
  const preserved: TodoItem[] = [];
  for (const p of prev) {
    if (used.has(p)) continue;
    if (p.source === "agent") preserved.push({ ...p });
  }
  const all = [...items, ...preserved];
  all.forEach((it, i) => {
    it.step = i + 1;
    it.ref = String(i + 1);
    if (!it.label) it.label = String(i + 1);
  });
  const removed = prev.filter(
    (p) => !used.has(p) && p.source !== "agent",
  ).length;
  return { items: all, added, removed, kept, preserved: preserved.length };
}

export interface TodoRefResolution {
  item?: TodoItem;
  ambiguous?: TodoItem[];
  unknown?: string;
}

/** Resolve a `[DONE:ref]` / toggle reference to a todo item.
 * Precedence: (a) pure integer → canonical `ref`, then positional `step`, then
 * unique `label`; (b) dotted `N.M` → unique `label`; (c) group-qualified
 * `Group/Label`, `Label@Group`, `#N`; (d) unique normalized-text match ≥8 chars.
 */
export function resolveTodoRef(
  items: TodoItem[],
  ref: string,
): TodoRefResolution {
  const list = items ?? [];
  const raw = String(ref ?? "").trim();
  if (!raw) return { unknown: raw };
  let norm = raw.replace(/[.)]+$/, "").trim();
  const clean = (s: string | undefined) =>
    String(s ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  const unique = (arr: TodoItem[]): TodoRefResolution | null => {
    if (arr.length === 1) return { item: arr[0] };
    if (arr.length > 1) return { ambiguous: arr };
    return null;
  };

  // `#N` → ref N
  const hash = norm.match(/^#(\d+)$/);
  if (hash) norm = hash[1];

  // Group-qualified: "Phase B/2", "2@Phase A"
  const gq = norm.match(/^(.+)\/(\S+)$/) || norm.match(/^(\S+)@(.+)$/);
  if (gq) {
    const g = clean(gq[1]);
    const l = clean(gq[2]);
    const inGroup = list.filter((it) => clean(it.group) === g);
    if (inGroup.length === 0) return { unknown: raw };
    const byLabel = unique(inGroup.filter((it) => clean(it.label) === l));
    if (byLabel) return byLabel;
    const byRef = unique(
      inGroup.filter((it) => clean(todoRef(it)) === l || todoRef(it) === l),
    );
    if (byRef) return byRef;
    const num = Number(l);
    if (Number.isFinite(num))
      return (
        unique(inGroup.filter((it) => it.step === num)) ?? { unknown: raw }
      );
    return { unknown: raw };
  }

  // Pure integer: canonical ref → positional step → unique label
  if (/^\d+$/.test(norm)) {
    const n = Number(norm);
    const byRef = unique(
      list.filter((it) => todoRef(it) === norm || todoRef(it) === String(n)),
    );
    if (byRef) return byRef;
    const byStep = unique(list.filter((it) => it.step === n));
    if (byStep) return byStep;
    const byLabel = unique(list.filter((it) => clean(it.label) === norm));
    if (byLabel) return byLabel;
    // Duplicated per-phase labels (the historical failure): surface them all so
    // the error can teach the global step numbers.
    const labeled = list.filter((it) => String(it.label) === norm);
    if (labeled.length > 0) return { ambiguous: labeled };
    return { unknown: raw };
  }

  // Dotted plan label: N.M
  if (/^\d+\.\d+$/.test(norm)) {
    const byLabel = unique(list.filter((it) => it.label === norm));
    if (byLabel) return byLabel;
  }

  // Unique normalized-text substring (≥8 chars)
  if (norm.length >= 8) {
    const needle = clean(norm);
    const textMatches = list.filter((it) => clean(it.text).includes(needle));
    const res = unique(textMatches);
    if (res) return res;
  }
  return { unknown: raw };
}

/**
 * Leniently parse completion refs from assistant text: `[DONE:3]`,
 * `[DONE: 3.1]`, `[DONE:2-4]`, `[DONE #2]`, `[DONE:1,2]`,
 * `[DONE:Phase B/2]` (group-qualified).
 */
export function parseDoneRefs(text: string): string[] {
  const refs: string[] = [];
  if (!text) return refs;
  const re = /\[DONE\s*[:#]?\s*([^\]]+)\]/gi;
  for (const m of text.matchAll(re)) {
    const body = String(m[1] ?? "").trim();
    if (!body) continue;
    const range = body.match(/^(\d+)\s*(?:-|\u2013|\u2014|\.\.)\s*(\d+)$/);
    if (range) {
      const a = Number(range[1]);
      const b = Number(range[2]);
      if (Number.isFinite(a) && Number.isFinite(b)) {
        const [lo, hi] = a <= b ? [a, b] : [b, a];
        for (let i = lo; i <= hi && i - lo < 200; i++) refs.push(String(i));
        continue;
      }
    }
    const numericParts: string[] = [];
    let hasNonNumeric = false;
    for (const part of body.split(/[,\s]+/)) {
      const p = part.trim().replace(/[.)]+$/, "");
      if (/^\d+(?:\.\d+)?$/.test(p)) numericParts.push(p);
      else if (p) hasNonNumeric = true;
    }
    if (numericParts.length > 0) refs.push(...numericParts);
    else if (hasNonNumeric) refs.push(body);
  }
  return refs;
}

export interface MarkCompletedResult {
  marked: number;
  unknown: string[];
  ambiguous: string[];
}

/** Mark items completed from `[DONE:ref]` tags. Only sets true. */
export function markCompletedRefs(
  text: string,
  items: TodoItem[],
): MarkCompletedResult {
  const result: MarkCompletedResult = {
    marked: 0,
    unknown: [],
    ambiguous: [],
  };
  for (const ref of parseDoneRefs(text)) {
    const res = resolveTodoRef(items, ref);
    if (res.item) {
      setTodoStatus(res.item, "completed");
      result.marked++;
    } else if (res.ambiguous) {
      result.ambiguous.push(ref);
    } else {
      result.unknown.push(ref);
    }
  }
  return result;
}

/** Legacy numeric API retained for compatibility. */
export function extractDoneSteps(message: string): number[] {
  return parseDoneRefs(message)
    .map(Number)
    .filter((n) => Number.isFinite(n));
}

/** Legacy API retained for compatibility. */
export function markCompletedSteps(text: string, items: TodoItem[]): number {
  return markCompletedRefs(text, items).marked;
}

// ── Wholesale update (industry-style replace) ────────────────────────

export interface TodoUpdateEntry {
  /** Canonical ref to an existing item (optional for new items). */
  ref?: string;
  /** Step text. Exact/normalized match is used when no `ref` is given. */
  text?: string;
  status?: TodoStatus;
}

export interface TodoUpdateResult {
  items: TodoItem[];
  added: number;
  removed: number;
  kept: number;
  /** Extra `in_progress` items demoted to `pending` (only one allowed). */
  normalized: number;
  /** Non-fatal resolution notes (refs matched by label/text or added as new). */
  warnings: string[];
}

/**
 * Industry-style replace update (TodoWrite / todowrite / update_plan semantics):
 * the incoming entries become the new list.
 *
 * - Identify existing items by canonical `ref` first, then by normalized text
 *   (group-insensitive), then leniently via `resolveTodoRef` (plan label /
 *   group-qualified ref / unique text). A non-empty `ref` that had to be
 *   resolved leniently, or that matched nothing, is reported in `warnings`.
 * - Omitted items are removed; new entries are appended.
 * - Exactly one item may be `in_progress`; extras are demoted (counted as
 *   `normalized`).
 * - Global refs are canonical positions: `step`/`ref` are recomputed as 1..N in
 *   the returned list order, so displayed numbers always equal `todoRef`.
 */
export function applyTodoUpdate(
  existing: TodoItem[],
  incoming: TodoUpdateEntry[],
): TodoUpdateResult {
  const prev = ensureTodoLabels(existing ?? []);
  const byRef = new Map<string, TodoItem>();
  const byTextKey = new Map<string, TodoItem>();
  for (const p of prev) {
    const r = todoRef(p);
    if (r) byRef.set(r.toLowerCase(), p);
    const k = todoKey({ text: p.text });
    if (k && !byTextKey.has(k)) byTextKey.set(k, p);
  }
  const used = new Set<TodoItem>();
  const items: TodoItem[] = [];
  const warnings: string[] = [];
  const short = (s: string) => (s.length > 60 ? `${s.slice(0, 57)}...` : s);
  let added = 0;
  let kept = 0;
  for (const raw of incoming ?? []) {
    const text = normalizeStepText(raw?.text ?? "");
    const rawRef =
      raw?.ref !== undefined && String(raw.ref).trim()
        ? String(raw.ref).trim()
        : undefined;
    let match: TodoItem | undefined;
    let matchedBy: "ref" | "label" | "text" | undefined;
    if (rawRef) {
      match = byRef.get(rawRef.toLowerCase());
      if (match) matchedBy = "ref";
    }
    if (!match && text) {
      const k = todoKey({ text });
      match = k ? byTextKey.get(k) : undefined;
      if (match) matchedBy = "text";
    }
    if (!match && rawRef) {
      const resolved = resolveTodoRef(prev, rawRef);
      if (resolved.item && !used.has(resolved.item)) {
        match = resolved.item;
        matchedBy = "label";
      }
    }
    if (match && used.has(match)) match = undefined;
    const status = raw?.status ?? "pending";
    if (match) {
      used.add(match);
      kept++;
      if (rawRef && matchedBy !== "ref")
        warnings.push(
          `ref "${rawRef}" not found; matched "${short(match.text)}" by ${matchedBy ?? "text"}`,
        );
      const item: TodoItem = {
        ...match,
        text: text || match.text,
        status,
        completed: status === "completed",
        source: match.source ?? "agent",
      };
      items.push(item);
    } else {
      // Skip empty ghost entries (blank text, no ref, already-used ref).
      if (!text) continue;
      added++;
      if (rawRef)
        warnings.push(
          `ref "${rawRef}" not found; added "${short(text)}" as a new step`,
        );
      const item: TodoItem = {
        step: 0,
        text,
        completed: status === "completed",
        status,
        source: "agent",
      };
      items.push(item);
    }
  }
  // Normalize: at most one in_progress.
  let normalized = 0;
  let seenInProgress = false;
  for (const it of items) {
    if (it.status === "in_progress") {
      if (seenInProgress) {
        it.status = "pending";
        it.completed = false;
        normalized++;
      } else {
        seenInProgress = true;
      }
    }
  }
  items.forEach((it, i) => {
    it.step = i + 1;
    it.ref = String(i + 1);
    if (!it.label) it.label = String(i + 1);
  });
  const removed = prev.filter((p) => !used.has(p)).length;
  return { items, added, removed, kept, normalized, warnings };
}

// ── Display + reminder builders (pure, exported for tests) ────────────

/** Status glyph for a todo row. */
export function todoGlyph(it: TodoItem): string {
  const s = itemStatus(it);
  return s === "completed"
    ? "☑"
    : s === "in_progress"
      ? "▶"
      : s === "cancelled"
        ? "✖"
        : "☐";
}

/** One display line: `☑ 6. text (plan label B2)` when the label differs. */
export function formatTodoLine(
  it: TodoItem,
  opts?: { showLabel?: boolean },
): string {
  const ref = todoRef(it);
  const labelPart =
    opts?.showLabel !== false &&
    it.label !== undefined &&
    String(it.label) !== ref
      ? ` (plan label ${it.label})`
      : "";
  return `${todoGlyph(it)} ${ref}. ${it.text}${labelPart}`;
}

/**
 * Numbered list for model-facing messages (handoff preview, execute prompt).
 * Uses each row's canonical global ref, so the numbers shown always match the
 * refs `workflow_todo` resolves. Single source for such lists.
 */
export function formatTodoNumberedList(
  items: TodoItem[],
  opts?: { glyph?: boolean },
): string {
  return (items ?? [])
    .map((it) =>
      opts?.glyph
        ? `${todoGlyph(it)} ${todoRef(it)}. ${it.text}`
        : `${todoRef(it)}. ${it.text}`,
    )
    .join("\n");
}

export interface TodoContextBlockOptions {
  /** Unresolved refs from the previous turn (fed back so the model can fix them). */
  misses?: { refs: string[] };
}

/**
 * The per-turn reminder block (context injection / before_agent_start).
 * Canonical global refs only; teaches the update protocol.
 */
export function buildTodoContextBlock(
  items: TodoItem[],
  opts?: TodoContextBlockOptions,
): string {
  const list = items ?? [];
  if (list.length === 0) return "";
  const done = list.filter((t) => isDone(t)).length;
  const total = list.length;
  const remaining = list.filter(
    (t) => !isDone(t) && itemStatus(t) !== "cancelled",
  );
  const current =
    list.find((t) => itemStatus(t) === "in_progress") ?? remaining[0];
  const preview = remaining
    .slice(0, 6)
    .map((t) => `${todoRef(t)}. ${t.text}`)
    .join("\n");
  const more = remaining.length > 6 ? `\n… +${remaining.length - 6} more` : "";
  const missBlock = opts?.misses?.refs?.length
    ? `\n\n[REFS UNRESOLVED last turn: ${opts.misses.refs.join(", ")} matched multiple steps. Use the GLOBAL STEP numbers below (e.g. step ${current ? todoRef(current) : "N"}).]`
    : "";
  return [
    `[TODO LIST] ${done}/${total} done. Steps are numbered GLOBALLY 1..${total}; use these GLOBAL STEP numbers as refs.`,
    current
      ? `Current/next: ${todoRef(current)}. ${current.text}`
      : "All steps done.",
    `Remaining:\n${preview}${more}`,
    `Finish a step → workflow_todo {action:"update", todos:[…COMPLETE LIST…]}, or {action:"done", step:${current ? todoRef(current) : "<N>"}}, or [DONE:${current ? todoRef(current) : "<N>"}].`,
    `After finishing a step, mark it in the SAME turn. Never leave it unchecked.`,
    missBlock,
  ]
    .filter(Boolean)
    .join("\n");
}

/** One-line footer appended to successful mutating tool results. */
export function buildTodoFooter(items: TodoItem[]): string {
  const list = items ?? [];
  if (list.length === 0) return "";
  const done = list.filter((t) => isDone(t)).length;
  const total = list.length;
  const remaining = list.filter(
    (t) => !isDone(t) && itemStatus(t) !== "cancelled",
  );
  if (remaining.length === 0) return "";
  const current =
    list.find((t) => itemStatus(t) === "in_progress") ?? remaining[0];
  return `[TODO ${done}/${total} — sync status now: if the step you just worked on (${todoRef(current)}. ${current.text.slice(0, 50)}) is finished, call workflow_todo {action:"done", step:${todoRef(current)}} or [DONE:${todoRef(current)}].]`;
}

/** Ambiguity error that teaches the global step numbers. */
export function formatAmbiguity(items: TodoItem[], ref: string): string {
  const list = items ?? [];
  if (list.length === 0)
    return `Todo "${ref}" is ambiguous but no items match.`;
  const lines = list
    .slice(0, 12)
    .map((t) => `${todoRef(t)}. ${t.text}`)
    .join("\n");
  const more = list.length > 12 ? `\n… +${list.length - 12} more` : "";
  return `Todo "${ref}" is ambiguous (matches ${list.length} items). Use the GLOBAL STEP numbers:\n${lines}${more}`;
}

export interface RemindState {
  turnsSinceLastTodoWrite: number;
  turnsSinceLastReminder: number;
  remaining: number;
}

/** Claude Code-style throttled cadence: no reminder until enough turns have
 * passed since both the last todo write and the last reminder. */
export function shouldRemind(state: RemindState): boolean {
  const s = state ?? {
    turnsSinceLastTodoWrite: 0,
    turnsSinceLastReminder: 0,
    remaining: 0,
  };
  return (
    s.remaining > 0 &&
    s.turnsSinceLastTodoWrite >= TURNS_SINCE_WRITE &&
    s.turnsSinceLastReminder >= TURNS_BETWEEN_REMINDERS
  );
}

export const TURNS_SINCE_WRITE = 3;
export const TURNS_BETWEEN_REMINDERS = 3;

// ── Plan extraction (section-scoped) ─────────────────────────────

const EXCLUDED_SECTION_RE =
  /^(context|decisions?|exploration(\s+summary)?|risks?|verification|notes?|root\s+cause|background|summary|alternatives?|open\s+questions?|references?|appendix)\b/i;

function headingMatch(line: string): { level: number; title: string } | null {
  const m = line.match(/^(#{1,6})\s+(.+?)\s*$/);
  if (!m) return null;
  return { level: m[1].length, title: m[2].trim() };
}

/** Step-shaped heading: `### 1. Title`, `### Step 2: Title`. */
function stepFromHeading(line: string): { label: string; text: string } | null {
  const m = line.match(
    /^(#{3,6})\s*(?:(\d+(?:\.\d+)?)[.)]\s+|Step\s+(\d+(?:\.\d+)?)\s*[:\uFF1A\-\u2013\u2014.)]?\s+)(.+?)\s*$/i,
  );
  if (!m) return null;
  const label = m[2] ?? m[3];
  const text = normalizeStepText(m[4] ?? "");
  if (!label || text.length <= 3) return null;
  return { label, text };
}

/** Bold step paragraph: `**Step 1.1: Scaffold**`. */
function stepFromBold(line: string): { label: string; text: string } | null {
  const m = line.match(
    /^\s*\*\*Step\s+(\d+(?:\.\d+)?)\s*[:\uFF1A\-\u2013\u2014.)]?\s*(.+?)\*\*\s*$/i,
  );
  if (!m) return null;
  const text = normalizeStepText(m[2]);
  if (text.length <= 3) return null;
  return { label: m[1], text };
}

/** Numbered list item: `1. Title`. */
function stepFromList(line: string): { label: string; text: string } | null {
  const m = line.match(/^\s*(\d+(?:\.\d+)?)[.)]\s+(.+?)\s*$/);
  if (!m) return null;
  const text = normalizeStepText(m[2]);
  if (text.length <= 3) return null;
  return { label: m[1], text };
}

/** Checkbox item: `- [ ] Title` / `- [x] Title`. */
function stepFromCheckbox(
  line: string,
): { text: string; completed: boolean } | null {
  const m = line.match(/^\s*[-*]\s*\[([ xX])\]\s+(.+?)\s*$/);
  if (!m) return null;
  const text = normalizeStepText(m[2]);
  if (text.length <= 3) return null;
  return { text, completed: m[1].toLowerCase() === "x" };
}

function parseStepsFromLines(lines: string[]): TodoItem[] {
  type RawStep = {
    label?: string;
    text: string;
    completed?: boolean;
    group?: string;
  };
  let usedExplicit = false;
  for (const line of lines) {
    if (stepFromHeading(line) || stepFromBold(line)) {
      usedExplicit = true;
      break;
    }
  }
  let numberedCount = 0;
  if (!usedExplicit) {
    for (const line of lines) if (stepFromList(line)) numberedCount++;
  }
  const useNumberedList = !usedExplicit && numberedCount >= 2;
  const raw: RawStep[] = [];
  let group: string | undefined;
  for (const line of lines) {
    const bold = stepFromBold(line);
    if (bold) {
      raw.push({ ...bold, group });
      continue;
    }
    const heading = headingMatch(line);
    if (heading) {
      const step = stepFromHeading(line);
      if (step) {
        raw.push({ ...step, group });
        continue;
      }
      const title = heading.title;
      if (heading.level >= 3 && !EXCLUDED_SECTION_RE.test(title)) group = title;
      continue;
    }
    if (useNumberedList) {
      const list = stepFromList(line);
      if (list) {
        raw.push({ ...list, group });
      }
    }
  }
  if (!usedExplicit && !useNumberedList) {
    for (const line of lines) {
      const cb = stepFromCheckbox(line);
      if (cb) raw.push({ text: cb.text, completed: cb.completed });
    }
  }
  const items: TodoItem[] = raw.map((r, i) => ({
    step: i + 1,
    text: r.text,
    completed: !!r.completed,
    label: r.label,
    group: r.group,
    source: "plan" as const,
  }));
  const deduped = dedupeTodoItems(items);
  deduped.forEach((it, i) => {
    it.step = i + 1;
    if (!it.label) it.label = String(i + 1);
  });
  return deduped;
}

/**
 * Extract plan steps from a plan markdown file. Section-scoped: only the
 * `## Plan Steps` section is parsed (fallback: step-shaped headings across
 * the document, skipping Context/Decisions/Exploration/Risks/Verification).
 * Labels and phase groups are preserved. Verification is never extracted.
 */
export function extractPlanStepsFromMarkdown(md: string): TodoItem[] {
  if (!md) return [];
  const lines = md.split(/\r?\n/);
  let start = -1;
  let level = 0;
  for (let i = 0; i < lines.length; i++) {
    const h = headingMatch(lines[i]);
    if (!h || h.level < 2 || h.level > 4) continue;
    if (/plan\s+steps/i.test(h.title)) {
      start = i + 1;
      level = h.level;
      break;
    }
  }
  let section: string[];
  if (start >= 0) {
    let end = lines.length;
    for (let i = start; i < lines.length; i++) {
      const h = headingMatch(lines[i]);
      if (h && h.level <= level && !/plan\s+steps/i.test(h.title)) {
        end = i;
        break;
      }
    }
    section = lines.slice(start, end);
  } else {
    section = [];
    let skipping = false;
    for (const line of lines) {
      const h = headingMatch(line);
      if (h && h.level <= 2) skipping = EXCLUDED_SECTION_RE.test(h.title);
      else if (h && skipping) continue;
      if (!skipping) section.push(line);
    }
  }
  return parseStepsFromLines(section);
}

/**
 * Extract plan steps from assistant chat text (used when no plan file exists).
 * Finds a `Plan:` header, then parses section-scoped steps.
 */
export function extractTodoItems(message: string): TodoItem[] {
  if (!message) return [];
  let headerIdx = -1;
  let headerLen = 0;
  const strict = message.match(/\*{0,2}Plan:\*{0,2}\s*\n/i);
  if (strict && strict.index !== undefined) {
    headerIdx = strict.index;
    headerLen = strict[0].length;
  } else {
    const hashPlan = message.match(/^#{1,4}\s*\*{0,2}Plan\b[^\n]*\n/im);
    if (hashPlan && hashPlan.index !== undefined) {
      headerIdx = hashPlan.index;
      headerLen = hashPlan[0].length;
    } else {
      const planColon = message.match(/Plan:\s*[^\n]*\n/i);
      if (planColon && planColon.index !== undefined) {
        headerIdx = planColon.index;
        headerLen = planColon[0].length;
      }
    }
  }
  if (headerIdx === -1) return [];
  const body = message.slice(headerIdx + headerLen).split(/\r?\n/);
  const filtered: string[] = [];
  let skipping = false;
  for (const line of body) {
    const h = headingMatch(line);
    if (h && h.level <= 2) skipping = EXCLUDED_SECTION_RE.test(h.title);
    else if (h && skipping) continue;
    if (!skipping) filtered.push(line);
  }
  return parseStepsFromLines(filtered);
}

/** Single placeholder step from a plan title when no steps could be parsed. */
export function synthesizeFromPlanTitle(md: string): TodoItem | null {
  const src = String(md ?? "");
  const m = src.match(/^#\s+Plan[:\s]+(.+)$/im) || src.match(/^#\s+(.+)$/m);
  if (!m) return null;
  const text = normalizeStepText(m[1]).slice(0, 120);
  if (!text) return null;
  return { step: 1, text, completed: false, label: "1", source: "synthesized" };
}

export function isPlanWritePath(p: string, cwd: string): boolean {
  const norm = p.replace(/\\/g, "/").toLowerCase();
  const cwdNorm = cwd.replace(/\\/g, "/").toLowerCase();
  return norm.includes(".pi/plans/") || norm.startsWith(cwdNorm + "/.pi/plans");
}

// ── Plan date helpers (UTC) ──────────────────────────────────────

/** Return YYYY-MM-DD in UTC for the given date (default: now). Uses toISOString slice, deterministic across locales. */
export function getUtcDatePrefix(d: Date = new Date()): string {
  return d.toISOString().slice(0, 10);
}

export function normalizePlanPath(
  p: string,
  cwd: string,
  today: string,
): { path: string; corrected: boolean; original: string } {
  const original = p;
  // Only touch paths that are under .pi/plans
  if (!isPlanWritePath(p, cwd)) return { path: p, corrected: false, original };
  // Split dir + basename (handle both / and \ separators)
  const normalizedSep = p.replace(/\\/g, "/");
  const lastSlash = normalizedSep.lastIndexOf("/");
  const dir = lastSlash >= 0 ? p.slice(0, lastSlash + 1) : "";
  const base = lastSlash >= 0 ? p.slice(lastSlash + 1) : p;
  if (!base) return { path: p, corrected: false, original };
  const m = base.match(/^(\d{4}-\d{2}-\d{2})-(.+)$/);
  if (m) {
    const currentDate = m[1];
    const rest = m[2];
    if (currentDate === today) return { path: p, corrected: false, original };
    // Validate that today looks like YYYY-MM-DD to avoid corrupting on invalid today
    if (!/^\d{4}-\d{2}-\d{2}$/.test(today))
      return { path: p, corrected: false, original };
    const correctedBase = `${today}-${rest}`;
    return { path: `${dir}${correctedBase}`, corrected: true, original };
  }
  // No date prefix — prepend today-
  if (!/^\d{4}-\d{2}-\d{2}$/.test(today))
    return { path: p, corrected: false, original };
  return { path: `${dir}${today}-${base}`, corrected: true, original };
}

// ── Rewind checkpoint helpers (pure, no FS/git) ─────────────────────

export function shortId(id: string): string {
  return (id || "").slice(0, 6);
}

export function formatTimestamp(ts: string | undefined): string {
  if (!ts) return "";
  try {
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return ts;
    const now = Date.now();
    const diff = now - d.getTime();
    if (diff < 0) return ts;
    const sec = Math.floor(diff / 1000);
    if (sec < 60) return "just now";
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min}m ago`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr}h ago`;
    const days = Math.floor(hr / 24);
    if (days < 7) return `${days}d ago`;
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  } catch {
    return ts || "";
  }
}

function extractUserText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return (content as any[])
      .filter((b) => b && b.type === "text" && typeof b.text === "string")
      .map((b) => b.text as string)
      .join("\n");
  }
  return "";
}

function firstNonEmptyLine(text: string): string {
  const lines = text.split(/\r?\n/);
  for (const ln of lines) {
    const t = ln.trim();
    if (t.length > 0) return t;
  }
  return "";
}

export function getHeaderText(e: any): string {
  try {
    if (!e || typeof e !== "object") return "";
    // Custom btw entries
    if (
      e.type === "custom" &&
      e.customType === "workflow-btw" &&
      e.data?.note
    ) {
      const n = String(e.data.note).trim();
      return collapseAndTruncate(firstNonEmptyLine(n) || n);
    }
    if (
      e.type === "custom_message" &&
      e.customType === "workflow-btw" &&
      typeof e.content === "string"
    ) {
      const c = String(e.content)
        .replace(/^\[BTW\]\s*/i, "")
        .trim();
      return collapseAndTruncate(firstNonEmptyLine(c) || c);
    }
    // Label bookmarks
    if (e.type === "label" && typeof e.label === "string" && e.label.trim()) {
      return collapseAndTruncate(firstNonEmptyLine(e.label.trim()));
    }
    // User messages
    if (e.type === "message" && e.message?.role === "user") {
      const raw = extractUserText(e.message.content);
      if (!raw.trim()) {
        // image-only: check for image blocks
        const hasImage =
          Array.isArray(e.message.content) &&
          (e.message.content as any[]).some((b) => b?.type === "image");
        if (hasImage) return "[image]";
        return "";
      }
      const first = firstNonEmptyLine(raw);
      return collapseAndTruncate(first || raw.trim());
    }
    return "";
  } catch {
    return "";
  }
}

function collapseAndTruncate(s: string): string {
  const collapsed = s.replace(/\s+/g, " ").trim();
  if (collapsed.length <= 60) return collapsed;
  return collapsed.slice(0, 60).trimEnd() + "…";
}

function isWorkflowInjected(e: any): boolean {
  // Extension-injected continuations have display false or workflow-* customTypes
  if (e.type === "custom_message" && e.display === false) return true;
  if (e.customType && typeof e.customType === "string") {
    if (e.customType.startsWith("workflow-plan-context")) return true;
    if (e.customType.startsWith("workflow-build-context")) return true;
    if (e.customType === "workflow" || e.customType === "workflow-complete")
      return true;
  }
  // Some injected messages use content containing the marker
  if (e.type === "message" && e.message?.role === "user") {
    const raw = extractUserText(e.message.content);
    if (
      raw.includes("[PLAN MODE ACTIVE]") ||
      raw.includes("[BUILD MODE — executing plan")
    )
      return true;
  }
  if (e.type === "custom" && e.customType === "workflow") return true;
  if (
    e.type === "custom" &&
    e.customType === "workflow-btw" &&
    e.data?.note === undefined
  )
    return true;
  return false;
}

export function isUserInteractionEntry(e: any): boolean {
  if (!e || typeof e !== "object") return false;
  if (isWorkflowInjected(e)) return false;
  // Direct user message
  if (e.type === "message" && e.message?.role === "user") return true;
  // BTW notes as custom user interaction (display true)
  if (
    e.type === "custom" &&
    e.customType === "workflow-btw" &&
    typeof e.data?.note === "string" &&
    e.data.note.trim()
  )
    return true;
  if (
    e.type === "custom_message" &&
    e.customType === "workflow-btw" &&
    e.display === true
  )
    return true;
  return false;
}

// ══════════════════════════════════════════════════════════════════════
// Review Mode — pure helpers
//
// Review Mode (see review.ts) audits Plan Mode's plan and rewrites it. The
// helpers below are the deterministic part: they never call a model and never
// touch the Pi SDK, so they are fully unit-testable.
// ══════════════════════════════════════════════════════════════════════

/** Markdown heading that separates the human plan from Review Mode's changelog. */
export const REVIEW_CHANGELOG_HEADING = "## Review changes";
/** Markdown heading appended when Review Mode could not clear its findings. */
export const REVIEW_UNRESOLVED_HEADING = "## Unresolved findings";

/** How a reviewer finding was resolved by the rewrite. */
export type ReviewDisposition = "accepted" | "rejected" | "deferred";

/**
 * Severity tiers used for the changelog and for deciding whether the
 * self-verification pass runs. Thresholds mirror the house style used by
 * other Pi reviewers (severity 1-10, confidence 0-100).
 */
export type ReviewTier = "Critical" | "Important" | "Minor" | "Info";

/** A single reviewer finding. */
export interface ReviewFinding {
  id: string;
  /** 1-10, higher is worse. */
  severity: number;
  /** 0-100. */
  confidence: number;
  /** Short category label, e.g. "correctness", "framework-alignment". */
  category: string;
  /** Repo-relative path, when the finding is anchored to a file. */
  file?: string;
  /** e.g. "42" or "42-58". */
  lineRange?: string;
  summary: string;
  rationale: string;
  disposition: ReviewDisposition;
}

/** Tier for a finding, using severity first and confidence as the gate. */
export function reviewFindingTier(f: {
  severity: number;
  confidence: number;
}): ReviewTier {
  const sev = Number(f?.severity) || 0;
  const conf = Number(f?.confidence) || 0;
  if (sev >= 8 && conf >= 70) return "Critical";
  if (sev >= 5 && conf >= 60) return "Important";
  if (sev >= 3 && conf >= 50) return "Minor";
  return "Info";
}

/** True when a severity tier is high enough to warrant the verify pass. */
export function reviewNeedsVerification(findings: ReviewFinding[]): boolean {
  if (!Array.isArray(findings)) return false;
  return findings.some(
    (f) => Number(f?.severity) >= 5 && Number(f?.confidence) >= 60,
  );
}

const TIER_ICON: Record<ReviewTier, string> = {
  Critical: "🔴",
  Important: "🟡",
  Minor: "🔵",
  Info: "⚪",
};

const TIER_ORDER: ReviewTier[] = ["Critical", "Important", "Minor", "Info"];

function escapeRegExpChars(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findingLocation(f: ReviewFinding): string {
  if (!f?.file) return "";
  return f.lineRange ? `\`${f.file}:${f.lineRange}\`` : `\`${f.file}\``;
}

function oneLine(s: string): string {
  return String(s ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Render the changelog that gets appended to the reviewed plan so the user can
 * see exactly what Review Mode changed and why. Deterministic and pure.
 */
export function renderReviewChangelog(
  findings: ReviewFinding[],
  meta?: { modelLabel?: string; verdict?: string; originalLength?: number },
): string {
  const list = Array.isArray(findings) ? findings.filter(Boolean) : [];
  const lines: string[] = [];

  if (meta?.modelLabel || meta?.verdict) {
    const bits: string[] = [];
    if (meta?.modelLabel) bits.push(`reviewer \`${meta.modelLabel}\``);
    if (meta?.verdict) bits.push(`verdict **${meta.verdict}**`);
    if (bits.length) lines.push(bits.join(" · "), "");
  }

  if (list.length === 0) {
    lines.push("No findings — the plan was submitted unchanged.");
    return lines.join("\n").trimEnd();
  }

  const accepted = list.filter((f) => f.disposition === "accepted");
  const rejected = list.filter((f) => f.disposition === "rejected");
  const deferred = list.filter((f) => f.disposition === "deferred");

  const counts: string[] = [];
  if (accepted.length) counts.push(`${accepted.length} addressed`);
  if (rejected.length) counts.push(`${rejected.length} rejected`);
  if (deferred.length) counts.push(`${deferred.length} deferred`);
  lines.push(`**Findings:** ${counts.join(", ") || "none"}`);
  lines.push("");

  if (accepted.length) {
    lines.push("### Addressed", "");
    for (const tier of TIER_ORDER) {
      const group = accepted.filter((f) => reviewFindingTier(f) === tier);
      if (!group.length) continue;
      lines.push(`**${tier}**`, "");
      for (const f of group) {
        const loc = findingLocation(f);
        lines.push(
          `- ${TIER_ICON[tier]} ${loc ? loc + " — " : ""}${oneLine(f.summary)} _(severity ${f.severity}, confidence ${f.confidence}%, ${oneLine(f.category) || "general"})_`,
        );
        const why = oneLine(f.rationale);
        if (why) lines.push(`  - ${why}`);
      }
      lines.push("");
    }
  }

  if (deferred.length) {
    lines.push("### Deferred", "");
    for (const f of deferred) {
      const loc = findingLocation(f);
      lines.push(
        `- ⏸ ${loc ? loc + " — " : ""}${oneLine(f.summary)} _(severity ${f.severity}, confidence ${f.confidence}%)_`,
      );
      const why = oneLine(f.rationale);
      if (why) lines.push(`  - ${why}`);
    }
    lines.push("");
  }

  if (rejected.length) {
    lines.push("### Rejected by the reviewer", "");
    for (const f of rejected) {
      const loc = findingLocation(f);
      lines.push(`- ❌ ${loc ? loc + " — " : ""}${oneLine(f.summary)}`);
      const why = oneLine(f.rationale);
      if (why) lines.push(`  - ${why}`);
    }
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}

/**
 * Strip any previously appended Review Mode appendix from a plan.
 * Returns the plan body exactly as the author wrote it.
 */
export function stripReviewAppendix(planText: string): string {
  const text = String(planText ?? "");
  if (!text) return "";
  let cut = -1;
  for (const heading of [REVIEW_CHANGELOG_HEADING, REVIEW_UNRESOLVED_HEADING]) {
    const re = new RegExp(`^${escapeRegExpChars(heading)}\\s*$`, "m");
    const hit = text.search(re);
    if (hit !== -1 && (cut === -1 || hit < cut)) cut = hit;
  }
  if (cut === -1) return text;
  // Also drop a `---` horizontal rule immediately preceding the appendix.
  return text.slice(0, cut).replace(/\n+---\s*\n*$/, "\n");
}

/**
 * Append (or replace) the Review Mode changelog section. Idempotent: calling
 * it twice with the same changelog yields the same result.
 */
export function appendReviewChangelog(
  planText: string,
  changelog: string,
): string {
  const base = stripReviewAppendix(planText).replace(/\s+$/, "");
  const body = String(changelog ?? "").trim();
  if (!body) return base + "\n";
  return `${base}\n\n---\n\n${REVIEW_CHANGELOG_HEADING}\n\n${body}\n`;
}

/**
 * Content hash of a plan body, ignoring any Review Mode appendix so a re-review
 * of the same revision is detected instead of re-triggering forever.
 * FNV-1a over whitespace-normalized text; stable across platforms.
 */
export function planHash(planText: string): string {
  const normalized = stripReviewAppendix(planText)
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+$/gm, "")
    .trim();
  let h = 0x811c9dc5;
  for (let i = 0; i < normalized.length; i++) {
    h ^= normalized.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

// ── ANSI-aware text layout for the dual-pane view ─────────────────────
//
// These live here (dependency-free) rather than in review-pane.ts so they can
// be unit-tested without loading pi-tui, and so the pane module adds no new
// dependency surface to the package.

/** CSI / OSC / single-char escape sequences. */
const ANSI_SEQUENCE_RE =
  /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/;

/** Remove ANSI/OSC escapes, preserving visible text. */
export function stripAnsi(s: string): string {
  return String(s ?? "").replace(
    /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g,
    "",
  );
}

/**
 * Rough East-Asian-wide / emoji test. Deliberately coarse: one column of drift
 * on an exotic glyph is invisible next to a 100%-wide overlay, and a full
 * Unicode wcwidth table is not worth its weight here.
 */
function isWideCodePoint(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  );
}

/** Display width of a string, ignoring ANSI escapes and counting wide glyphs as 2. */
export function displayWidth(s: string): number {
  let w = 0;
  for (const ch of stripAnsi(s)) {
    const cp = ch.codePointAt(0) ?? 0;
    w += isWideCodePoint(cp) ? 2 : 1;
  }
  return w;
}

/**
 * Truncate to a display width, preserving ANSI escapes that appear before the
 * cut and appending a reset so a truncated coloured line cannot bleed its
 * colour into the next column.
 */
export function truncateAnsi(s: string, width: number, ellipsis = "…"): string {
  const str = String(s ?? "");
  if (width <= 0) return "";
  if (displayWidth(str) <= width) return str;
  const ellipsisWidth = displayWidth(ellipsis);
  const budget = Math.max(0, width - ellipsisWidth);
  let out = "";
  let used = 0;
  let i = 0;
  while (i < str.length) {
    const rest = str.slice(i);
    const esc = rest.match(ANSI_SEQUENCE_RE);
    if (esc && esc.index === 0) {
      out += esc[0];
      i += esc[0].length;
      continue;
    }
    const cp = str.codePointAt(i);
    if (cp === undefined) break;
    const ch = String.fromCodePoint(cp);
    const cw = isWideCodePoint(cp) ? 2 : 1;
    if (used + cw > budget) break;
    out += ch;
    used += cw;
    i += ch.length;
  }
  return `${out}\x1b[0m${ellipsis}`;
}

/** Pad or truncate one line to exactly `width` display columns. */
export function padAnsi(s: string, width: number): string {
  const str = String(s ?? "");
  if (width <= 0) return "";
  const w = displayWidth(str);
  if (w > width) return truncateAnsi(str, width);
  if (w === width) return str;
  return str + " ".repeat(width - w);
}

/**
 * Compose two rendered line buffers into side-by-side rows.
 *
 * This is how the Review Workspace gets a real two-column layout on pi's
 * default TUI: `HStack`/`VStack` constrained regions only work on the
 * experimental `tuiMode: "fullscreen"` alt-screen (see pi-tui's README), so the
 * panes are composed manually and each column owns its own scroll offset.
 */
export function composeTwoColumn(
  left: string[],
  right: string[],
  leftWidth: number,
  rightWidth: number,
  gap = 2,
): string[] {
  const rows = Math.max(left.length, right.length);
  const gapStr = " ".repeat(Math.max(0, gap));
  const out: string[] = [];
  for (let i = 0; i < rows; i++) {
    out.push(
      padAnsi(left[i] ?? "", leftWidth) +
        gapStr +
        padAnsi(right[i] ?? "", rightWidth),
    );
  }
  return out;
}

export interface ViewportSlice {
  lines: string[];
  /** Clamped offset actually used. */
  offset: number;
  maxOffset: number;
}

/**
 * Clamp a scroll offset and slice a viewport out of a line buffer.
 * `followEnd` pins the view to the newest content (live streaming).
 */
export function sliceViewport(
  lines: string[],
  offset: number,
  height: number,
  followEnd = false,
): ViewportSlice {
  const all = Array.isArray(lines) ? lines : [];
  const h = Math.max(0, Math.trunc(height) || 0);
  const maxOffset = Math.max(0, all.length - h);
  const requested = followEnd ? maxOffset : Math.trunc(offset) || 0;
  const off = Math.max(0, Math.min(maxOffset, requested));
  return {
    lines: h === 0 ? [] : all.slice(off, off + h),
    offset: off,
    maxOffset,
  };
}

// ── Context pruning for the reviewer session ────────────────────────

export interface PruneReviewContextOptions {
  /** Max characters kept per string field. Longer values are elided. */
  maxToolResultChars?: number;
  /** Max entries handed to the reviewer (most recent are kept). */
  maxEntries?: number;
}

const REVIEW_PRUNE_MAX_DEPTH = 6;

/** Extension-injected entries that must not leak into the reviewer's context. */
function isReviewDroppedEntry(e: any): boolean {
  if (!e || typeof e !== "object") return true;
  const ct = typeof e.customType === "string" ? e.customType : "";
  return ct.startsWith("workflow");
}

/**
 * Tool calls carried by an assistant message entry.
 *
 * Real session format (docs/session-format.md):
 *   { type: "message", message: { role: "assistant",
 *       content: [{ type: "toolCall", id, name, arguments }] } }
 * The top-level `input` shape is also accepted because the Plan Mode handoff
 * already probes it (`e?.input?.path`) and older entries may carry it.
 */
function collectToolCalls(e: any): Array<{ name?: string; args?: any }> {
  const out: Array<{ name?: string; args?: any }> = [];
  const blocks = e?.message?.content;
  if (!Array.isArray(blocks)) return out;
  for (const b of blocks) {
    if (!b || typeof b !== "object") continue;
    if (b.type !== "toolCall" && b.type !== "tool_use") continue;
    out.push({
      name: typeof b.name === "string" ? b.name : undefined,
      args: b.arguments ?? b.input,
    });
  }
  return out;
}

/** Plan-file path written by an entry, if it is a plan write. */
function entryPlanWritePath(e: any): string | undefined {
  const candidates: unknown[] = [
    e?.input?.path,
    e?.input?.file_path,
    e?.data?.planFile,
  ];
  for (const call of collectToolCalls(e)) {
    if (call.name !== "write" && call.name !== "edit") continue;
    const a = call.args;
    if (a && typeof a === "object") {
      candidates.push((a as any).path, (a as any).file_path);
    }
  }
  for (const cand of candidates) {
    if (typeof cand !== "string") continue;
    const norm = cand.replace(/\\/g, "/").toLowerCase();
    if (norm.includes(".pi/plans/")) return cand;
  }
  return undefined;
}

function shrinkReviewString(s: string, maxChars: number): string {
  if (s.length <= maxChars) return s;
  return `${s.slice(0, maxChars)}\n… [review context: ${s.length - maxChars} chars elided]`;
}

/** Recursively clone a value, eliding any string longer than maxChars. */
function shrinkReviewNode(node: any, maxChars: number, depth = 0): any {
  if (typeof node === "string") return shrinkReviewString(node, maxChars);
  if (depth >= REVIEW_PRUNE_MAX_DEPTH) return node;
  if (Array.isArray(node))
    return node.map((n) => shrinkReviewNode(n, maxChars, depth + 1));
  if (node && typeof node === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) {
      out[k] = shrinkReviewNode(v, maxChars, depth + 1);
    }
    return out;
  }
  return node;
}

/**
 * Build the conversation history handed to the reviewer session.
 *
 * - drops workflow-injected entries (plan/todo context markers, handoff notes)
 * - elides oversized tool results so the reviewer's window is spent on reasoning
 * - stops at the plan-file write: anything the author did *after* writing the
 *   plan is not part of the plan under review
 * - keeps the most recent `maxEntries` when the result is still too long
 *
 * Never throws; malformed entries are skipped.
 */
export function pruneContextEntriesForReview(
  entries: unknown,
  opts: PruneReviewContextOptions = {},
): any[] {
  const maxChars = Number.isFinite(opts.maxToolResultChars)
    ? Math.max(200, Number(opts.maxToolResultChars))
    : 4000;
  const maxEntries = Number.isFinite(opts.maxEntries)
    ? Math.max(1, Number(opts.maxEntries))
    : 120;
  if (!Array.isArray(entries)) return [];
  const kept: any[] = [];
  try {
    for (const e of entries) {
      if (isReviewDroppedEntry(e)) continue;
      kept.push(shrinkReviewNode(e, maxChars));
      if (entryPlanWritePath(e)) break;
    }
  } catch {
    /* keep whatever was collected */
  }
  return kept.length > maxEntries ? kept.slice(kept.length - maxEntries) : kept;
}

/**
 * Validate a reviewer-submitted plan before it replaces the author's plan.
 *
 * Returns a list of human-readable problems; empty means valid.
 *
 * The length guard exists so a degenerate rewrite cannot silently discard the
 * plan (a stub that looks authoritative but carries no plan).
 *
 * Why the bounds are deliberately generous and asymmetric: two of the review
 * criteria REQURE the length to change. "Requirement coverage" findings add
 * whole steps, and "simplicity" findings delete them. A tight ±60% window (the
 * obvious first guess) would reject exactly the reviews that are doing their
 * job. So the bounds only catch catastrophes: a stub (below `minRatio`) or an
 * accidental paste / wholesale plan substitution (above `maxRatio`). Everything
 * in between is the reviewer legitimately doing its work, and every change is
 * still made visible to the user through the `## Review changes` appendix.
 */
export function validateReviewedPlan(
  planMarkdown: unknown,
  originalMarkdown: unknown,
  opts: { minRatio?: number; maxRatio?: number } = {},
): string[] {
  const problems: string[] = [];
  const next = typeof planMarkdown === "string" ? planMarkdown : "";
  const prev = typeof originalMarkdown === "string" ? originalMarkdown : "";
  const minRatio = opts.minRatio ?? 0.25;
  const maxRatio = opts.maxRatio ?? 4;

  if (!next.trim()) {
    problems.push("planMarkdown is empty");
    return problems;
  }
  if (!/^#{1,6}\s+\S/m.test(next)) {
    problems.push("planMarkdown contains no markdown heading");
  }
  const prevBody = stripReviewAppendix(prev);
  if (prevBody.trim().length > 0) {
    const ratio = next.length / prevBody.length;
    if (ratio < minRatio)
      problems.push(
        `planMarkdown is too short (${Math.round(ratio * 100)}% of the original; minimum ${Math.round(minRatio * 100)}%) — resubmit the complete plan rather than a summary`,
      );
    if (ratio > maxRatio)
      problems.push(
        `planMarkdown is unexpectedly long (${Math.round(ratio * 100)}% of the original; maximum ${Math.round(maxRatio * 100)}%) — this looks like a pasted document rather than an adjustment of the original plan`,
      );
  }
  return problems;
}

// ── Rendering the shared context for the reviewer's prompt ───────────

function contentBlocksToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const b of content) {
    if (!b || typeof b !== "object") continue;
    const block = b as Record<string, unknown>;
    if (block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    } else if (block.type === "image") {
      parts.push("[image]");
    } else if (block.type === "toolCall" || block.type === "tool_use") {
      const name = typeof block.name === "string" ? block.name : "tool";
      const args = (block.arguments ?? block.input) as
        | Record<string, unknown>
        | undefined;
      const hint =
        args && typeof args === "object"
          ? String(args.path ?? args.file_path ?? args.command ?? "")
              .slice(0, 120)
              .replace(/\s+/g, " ")
          : "";
      parts.push(`[tool call: ${name}${hint ? ` ${hint}` : ""}]`);
    }
  }
  return parts.join("\n");
}

/**
 * Render the pruned Plan Mode history into a plain-text block for the
 * reviewer's first prompt.
 *
 * Why the prompt rather than the session manager: `SessionManager.inMemory()`
 * only accepts pre-existing entries from Pi 0.85.1 onward, and this package
 * declares `peerDependencies: { "@earendil-works/pi-coding-agent": "*" }`.
 * Passing entries to a 0.84.x runtime would be silently ignored, handing the
 * reviewer an empty context — a silent failure. Rendering into the prompt
 * works identically on every supported version and is explicit about what the
 * reviewer can and cannot see.
 *
 * Never throws.
 */
export function renderReviewContextBlock(
  entries: unknown,
  opts: { maxChars?: number } = {},
): string {
  const maxChars = Number.isFinite(opts.maxChars)
    ? Math.max(1000, Number(opts.maxChars))
    : 60_000;
  if (!Array.isArray(entries) || entries.length === 0) return "";
  const lines: string[] = [];
  try {
    for (const raw of entries) {
      if (!raw || typeof raw !== "object") continue;
      const e = raw as Record<string, unknown>;
      const msg = e.message as Record<string, unknown> | undefined;
      if (!msg) continue;
      const role = typeof msg.role === "string" ? msg.role : "unknown";
      const text = contentBlocksToText(msg.content).trim();
      if (!text) continue;
      if (role === "user") lines.push(`### User\n${text}`);
      else if (role === "assistant") lines.push(`### Plan Mode\n${text}`);
      else if (role === "toolResult" || role === "tool") {
        const tool = typeof msg.toolName === "string" ? msg.toolName : "tool";
        lines.push(`### Tool result (${tool})\n${text}`);
      }
    }
  } catch {
    /* return what we have */
  }
  let out = lines.join("\n\n");
  if (out.length > maxChars) {
    out = `${out.slice(0, maxChars)}\n\n… [context truncated at ${maxChars} chars]`;
  }
  return out;
}
