/**
 * Shared utils for workflow extension — copied from plan-mode example
 * Pure functions, testable.
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

/** Backfill labels/ref/status/source for items restored from older sessions. */
export function ensureTodoLabels(items: TodoItem[]): TodoItem[] {
  return (items ?? []).map((it, i) => {
    const step = Number.isFinite(it?.step) ? Number(it.step) : i + 1;
    const status = itemStatus(it);
    return {
      ...it,
      step,
      label: it?.label || String(step),
      ref: it?.ref || String(step),
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
 * Match is by label first (same plan step), then by normalized text.
 * Matched items keep their stable `ref`; new items get `ref = maxRef+1`;
 * unmatched `source:"agent"` items are preserved; status merges by rank
 * (a plan-file `- [x]` can mark an item done, nothing un-completes it).
 */
export function mergeTodoItems(
  existing: TodoItem[],
  extracted: TodoItem[],
): TodoMergeResult {
  const prev = ensureTodoLabels(existing ?? []);
  const next = dedupeTodoItems((extracted ?? []).map((n) => ({ ...n })));
  const byLabel = new Map<string, TodoItem>();
  const byKey = new Map<string, TodoItem>();
  for (const p of prev) {
    const label = p.label || String(p.step);
    byLabel.set(label.toLowerCase(), p);
    const k = todoKey(p);
    if (k) byKey.set(k, p);
  }
  const used = new Set<TodoItem>();
  let added = 0;
  let kept = 0;
  let maxRef = prev.reduce(
    (m, p) => Math.max(m, todoRefNumber(todoRef(p)) ?? 0),
    0,
  );
  const items = next.map((n) => {
    const nKey = todoKey(n);
    let match: TodoItem | undefined = nKey ? byKey.get(nKey) : undefined;
    if (!match && n.label) {
      const cand = byLabel.get(n.label.toLowerCase());
      // Label fallback only when the text is unchanged (group may have been
      // renamed); never carry completion onto a differently-worded step.
      if (cand && todoKey({ text: cand.text }) === todoKey({ text: n.text }))
        match = cand;
    }
    if (match && !used.has(match)) {
      used.add(match);
      kept++;
      const item: TodoItem = {
        ...n,
        ref: n.ref || match.ref || todoRef(match),
        group: n.group ?? match.group,
        source: n.source ?? match.source,
      };
      const status = mergeStatusByRank(itemStatus(match), itemStatus(item));
      setTodoStatus(item, status);
      item.ref = item.ref || String(++maxRef);
      return item;
    }
    added++;
    const item: TodoItem = { ...n, ref: n.ref || String(++maxRef) };
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
}

/**
 * Industry-style replace update (TodoWrite / todowrite / update_plan semantics):
 * the incoming entries become the new list.
 *
 * - Identify existing items by canonical `ref` first, then by normalized text
 *   (group-insensitive). Matched items keep their `ref` and take the incoming
 *   status/text. New entries get `ref = maxRef + 1`.
 * - Omitted items are removed.
 * - Exactly one item may be `in_progress`; extras are demoted (counted as
 *   `normalized`).
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
  let added = 0;
  let kept = 0;
  let maxRef = prev.reduce(
    (m, p) => Math.max(m, todoRefNumber(todoRef(p)) ?? 0),
    0,
  );
  for (const raw of incoming ?? []) {
    const text = normalizeStepText(raw?.text ?? "");
    let match: TodoItem | undefined;
    if (raw?.ref !== undefined && String(raw.ref).trim()) {
      match = byRef.get(String(raw.ref).trim().toLowerCase());
    }
    if (!match && text) {
      const k = todoKey({ text });
      match = k ? byTextKey.get(k) : undefined;
    }
    const status = raw?.status ?? "pending";
    if (match && !used.has(match)) {
      used.add(match);
      kept++;
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
      const item: TodoItem = {
        step: 0,
        text,
        completed: status === "completed",
        status,
        ref: String(++maxRef),
        label: String(maxRef),
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
  });
  const removed = prev.filter((p) => !used.has(p)).length;
  return { items, added, removed, kept, normalized };
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
