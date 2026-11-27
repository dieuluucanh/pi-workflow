/**
 * Shared utils for workflow extension — copied from plan-mode example
 * Pure functions, testable. Deliberately dependency-free (no Pi / pi-tui
 * imports) so it stays loadable in plain Node tests.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { isCommandAllowedForRole } from "./permissions.ts";
import { planStepIdFor, todoItemId } from "./plan-identity.ts";

/**
 * Translate shell foreign path syntax to native syntax without changing case.
 *
 * On Windows, Git-Bash/MSYS (`/c/...`), Cygwin (`/cygdrive/c/...`) and WSL
 * (`/mnt/c/...`) spellings otherwise become `C:\c\...` under `path.resolve`.
 * On POSIX, a Windows drive path is mapped to `/mnt/<drive>/...` only when the
 * mount exists; otherwise the caller treats it as uncertain. UNC/WSL UNC
 * paths intentionally stay network paths.
 *
 * This is the case-preserving plumbing used for real filesystem/settings
 * paths. `normalizePolicyPath` applies this and then lowercases only for the
 * comparison form.
 */
export function translateForeignPath(value: unknown): {
  path: string;
  uncertain?: boolean;
} {
  if (typeof value !== "string") return { path: "", uncertain: true };
  let raw = value.trim();
  if (!raw) return { path: "" };

  if (raw.startsWith("file:")) {
    try {
      raw = fileURLToPath(raw);
    } catch {
      try {
        raw = decodeURIComponent(raw.replace(/^file:\/\//i, ""));
      } catch {
        return { path: raw, uncertain: true };
      }
    }
  }

  if (process.platform === "win32") {
    const drivePath = (drive: string, rest: string | undefined): string =>
      `${drive.toUpperCase()}:/${rest ?? ""}`;
    const cygdrive = /^\/cygdrive\/([A-Za-z])(?:\/(.*))?$/i.exec(raw);
    if (cygdrive) return { path: drivePath(cygdrive[1], cygdrive[2]) };
    const wsl = /^\/mnt\/([A-Za-z])(?:\/(.*))?$/i.exec(raw);
    if (wsl) return { path: drivePath(wsl[1], wsl[2]) };
    const msys = /^\/([A-Za-z])(?:\/(.*))?$/.exec(raw);
    if (msys) return { path: drivePath(msys[1], msys[2]) };

    // A drive-relative path (`C:foo`) or a device path is not a normal
    // absolute path; do not guess what it means.
    if (/^[A-Za-z]:[^\\/]/.test(raw) || /^\\\\.\\/.test(raw)) {
      return { path: raw, uncertain: true };
    }
    // Extended-length prefixes are not meaningful to the policy layer.
    raw = raw
      .replace(/^\\\\\?\\UNC\\/i, "\\\\")
      .replace(/^\\\\\?\\/i, "");
    return { path: raw };
  }

  // POSIX host: map a Windows drive path only when its WSL mount exists.
  const win = /^([A-Za-z]):[\\/](.*)$/.exec(raw);
  if (win) {
    const mount = `/mnt/${win[1].toLowerCase()}`;
    if (fs.existsSync(mount)) return { path: `${mount}/${win[2]}` };
    return { path: raw, uncertain: true };
  }
  return { path: raw };
}

/** Options for the Git-Bash `/tmp` translator (injectable for tests). */
export interface MsysPathOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  exists?: (value: string) => boolean;
  /** Only translate when the session cwd is a native Windows path. */
  cwd?: string;
}

/** A native Windows absolute path (drive-absolute or UNC). */
export function isNativeWindowsPath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || /^\\\\/.test(value);
}

let msysTempCache: { key: string; root: string | undefined } | undefined;

function msysTempCacheKey(env: NodeJS.ProcessEnv): string {
  return [
    env.MSYSTEM ?? "",
    env.SHELL ?? "",
    env.ProgramFiles ?? "",
    env.PI_MSYS_TMP ?? "",
    env.TMP ?? "",
    env.TEMP ?? "",
    env.TMPDIR ?? "",
    env.LOCALAPPDATA ?? "",
    env.USERPROFILE ?? "",
  ].join("\0");
}

/**
 * The real Windows directory behind Git-Bash's `/tmp`.
 *
 * Only meaningful for MSYS/Git-Bash (Pi's default Windows shell): Git for
 * Windows is detected by `%ProgramFiles%\Git\bin\bash.exe`, `MSYSTEM`, or a
 * bash `SHELL`. Candidates are tried in order and the first existing one
 * wins. Injected `env`/`exists` options bypass the cache (tests); no
 * `cygpath` subprocess.
 */
export function resolveMsysTempRoot(
  opts: MsysPathOptions = {},
): string | undefined {
  const platform = opts.platform ?? process.platform;
  if (platform !== "win32") return undefined;
  const env = opts.env ?? process.env;
  const exists = opts.exists ?? fs.existsSync;
  const injected =
    opts.env !== undefined ||
    opts.exists !== undefined ||
    opts.platform !== undefined;
  const key = msysTempCacheKey(env);
  if (!injected && msysTempCache?.key === key) return msysTempCache.root;
  const enabled =
    Boolean(env.PI_MSYS_TMP) ||
    Boolean(env.MSYSTEM) ||
    /bash(?:\.exe)?$/i.test(env.SHELL ?? "") ||
    Boolean(
      env.ProgramFiles &&
        exists(path.join(env.ProgramFiles, "Git", "bin", "bash.exe")),
    );
  if (!enabled) {
    if (!injected) msysTempCache = { key, root: undefined };
    return undefined;
  }
  const candidates: string[] = [];
  if (env.PI_MSYS_TMP && isNativeWindowsPath(env.PI_MSYS_TMP))
    candidates.push(env.PI_MSYS_TMP);
  for (const value of [env.TMP, env.TEMP, env.TMPDIR]) {
    if (value && isNativeWindowsPath(value)) candidates.push(value);
  }
  if (env.LOCALAPPDATA)
    candidates.push(path.join(env.LOCALAPPDATA, "Temp"));
  if (env.USERPROFILE)
    candidates.push(path.join(env.USERPROFILE, "AppData", "Local", "Temp"));
  const root = candidates.find((candidate) => exists(candidate));
  if (!injected) msysTempCache = { key, root };
  return root;
}

/**
 * Translate the literal `/tmp` prefix (and only that) to the real Windows
 * temp directory for a POSIX shell. Direct tool paths keep Node semantics
 * (`/tmp` really is `C:/tmp` there), so callers opt in.
 */
export function translateMsysTempPath(
  value: string,
  opts: MsysPathOptions = {},
): string {
  if (!value) return value;
  const platform = opts.platform ?? process.platform;
  if (platform !== "win32") return value;
  if (!/^\/tmp(?=\/|$)/.test(value)) return value;
  if (opts.cwd && !isNativeWindowsPath(opts.cwd)) return value;
  const root = resolveMsysTempRoot(opts);
  return root ? `${root}${value.slice(4)}` : value;
}

/**
 * Backward-compatible alias for Plan Mode's command policy (read-only plus
 * test/lint/typecheck). New code should call
 * `isCommandAllowedForRole(role, command)` from `./permissions.ts` directly so
 * the role is explicit.
 */
export function isSafeCommand(command: string): boolean {
  return isCommandAllowedForRole("planner", command);
}

export type TodoStatus = "pending" | "in_progress" | "completed" | "cancelled";

export interface TodoItem {
  step: number;
  text: string;
  /** Legacy boolean flag; kept derived from `status` for old sessions/external readers. */
  completed: boolean;
  /** Industry-style status. Legacy items derive it from `completed`. */
  status?: TodoStatus;
  /**
   * Stable item identity, assigned once and preserved by updates/merges.
   * Display `ref` is a canonical position and may change when rows reorder;
   * `id` is what identifies the work item across rewording and reindexing.
   */
  id?: string;
  /**
   * Stable plan-step binding for plan-derived rows. Absent on genuine
   * agent-added rows. Never derived from the current position or from a
   * shortened rewrite of the text.
   */
  planStepId?: string;
  /** Canonical position, recomputed as 1..N for display. Not durable identity. */
  ref?: string;
  /** Plan-faithful label, e.g. "1", "2.3". Legacy items derive it from step. */
  label?: string;
  /** Optional group/phase heading the step belongs to. */
  group?: string;
  /** Where the item came from. */
  source?: "plan" | "agent" | "synthesized";
}

/** FNV-1a over normalized text: deterministic ids without persistence. */
// Row identity lives in `plan-identity.ts` so the compiler and the display
// adapter share one rule without an import cycle. Re-exported here because
// `todoItemId`/`planStepIdFor` are part of this module's public surface.
export { planStepIdFor, todoItemId };


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
    const label = it?.label || String(originalStep);
    const source = it?.source ?? "plan";
    const seeded = { ...it, label, group: it?.group };
    return {
      ...seeded,
      step,
      ref: String(step),
      status,
      completed: status === "completed",
      source,
      id: it?.id || todoItemId(seeded),
      ...(source === "plan"
        ? { planStepId: it?.planStepId || planStepIdFor({ ...seeded, label }) }
        : {}),
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
  /** Stable item identity. Preferred over `ref` when supplied. */
  id?: string;
  /** Canonical ref to an existing item (optional for new items). */
  ref?: string;
  /** Step text. Exact/normalized match is used when no id/ref is given. */
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
  /** Set when the store refused an ambiguous destructive replacement. */
  refused?: string;
  /** Store revision after the mutation (absent on a refused/removed-API call). */
  revision?: number;
  /** Plan bindings newly recorded as deliberately removed. */
  excludedAdded?: number;
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
  const byId = new Map<string, TodoItem>();
  const byTextKey = new Map<string, TodoItem>();
  for (const p of prev) {
    const r = todoRef(p);
    if (r) byRef.set(r.toLowerCase(), p);
    if (p.id) byId.set(p.id, p);
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
    const rawId =
      raw?.id !== undefined && String(raw.id).trim()
        ? String(raw.id).trim()
        : undefined;
    const rawRef =
      raw?.ref !== undefined && String(raw.ref).trim()
        ? String(raw.ref).trim()
        : undefined;
    let match: TodoItem | undefined;
    let matchedBy: "id" | "ref" | "label" | "text" | undefined;
    if (rawId) {
      // A supplied stable id is authoritative; an unknown id is an error, not
      // permission to fall back to text and mint a duplicate task.
      const byStableId = byId.get(rawId);
      if (!byStableId) {
        warnings.push(`id "${short(rawId)}" not found; the entry was not applied`);
        continue;
      }
      match = byStableId;
      matchedBy = "id";
    }
    if (!match && rawRef) {
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
        id: match.id || todoItemId(match),
        ...(match.planStepId ? { planStepId: match.planStepId } : {}),
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
        id: todoItemId({ text, label: undefined, group: undefined }),
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

/**
 * Whether two plan paths identify the same file.
 *
 * Plan targets arrive in several shapes: absolute Windows paths from a
 * `tool_result`, relative paths from `/review <path>`, forward slashes from a
 * handoff, and case differences from the host. A review-cycle boundary must
 * not fire for a spelling difference, and must fire for a real move. Kept in
 * this dependency-free module so the comparison is unit-testable; callers pass
 * the session cwd for relative paths.
 */
export function samePlanPath(
  a: string | null | undefined,
  b: string | null | undefined,
  cwd: string = process.cwd(),
): boolean {
  const normalize = (raw: string | null | undefined): string => {
    let value = String(raw ?? "").trim();
    if (!value) return "";
    value = value.replace(/\\/g, "/");
    const absolute =
      value.startsWith("/") || /^[A-Za-z]:\//.test(value);
    if (!absolute) {
      value = `${String(cwd ?? "").replace(/\\/g, "/").replace(/\/+$/, "")}/${value}`;
    }
    const parts: string[] = [];
    for (const part of value.split("/")) {
      if (!part || part === ".") continue;
      if (part === "..") {
        if (parts.length > 0) parts.pop();
        continue;
      }
      parts.push(part);
    }
    let out = parts.join("/");
    if (value.startsWith("/")) out = `/${out}`;
    // Windows drive letters are case-insensitive; keep POSIX case-sensitive.
    out = out.replace(/^([A-Za-z]):/, (_m, drive: string) => `${drive.toUpperCase()}:`);
    return process.platform === "win32" ? out.toLowerCase() : out;
  };
  return normalize(a) === normalize(b);
}

/** Inputs for deciding whether this run may hand a plan off. */
export interface PlanHandoffEligibility {
  mode: "plan" | "build" | null;
  /** This run wrote/edited a file under `.pi/plans/`. */
  planWrittenThisRun: boolean;
  /**
   * The write happened while Plan mode was active. A run that starts in
   * Default/Build and switches to Plan mid-run counts; a plan written before
   * the switch does not. `agent_end`'s current-run message scan sets this too
   * when the run ends in Plan (the tool_result handler was missed).
   */
  planWrittenInPlanMode: boolean;
  /**
   * A Planner↔Reviewer revision turn resolved in THIS run (the Planner settled
   * `plan_revision_done`, silently revised the body, or made no change at all).
   * Pass it only for the run that answers a revision follow-up: that run may
   * hand off (or re-review) without writing a plan itself.
   */
  revisionSettled?: boolean;
}

/**
 * A handoff requires Plan mode plus EITHER a write made under Plan mode in this
 * run, OR a revision turn that resolved in this run. Session-lifetime plan
 * files and old todos never authorize a handoff.
 */
export function shouldHandoffPlan(input: PlanHandoffEligibility): boolean {
  if (input.mode !== "plan") return false;
  if (input.revisionSettled === true) return true;
  return (
    input.planWrittenThisRun === true &&
    input.planWrittenInPlanMode === true
  );
}

/**
 * Last `write`/`edit` tool call in THIS RUN whose path is under `.pi/plans/`.
 * `messages` must be the `agent_end` run messages (the run's `newMessages`),
 * never the session history — scanning history would resurrect old plans.
 * Returns the path as supplied by the tool call; the caller resolves it.
 */
export function findPlanWritePathInMessages(
  messages: readonly unknown[],
  cwd: string,
): string | undefined {
  if (!Array.isArray(messages) || messages.length === 0) return undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as any;
    if (m?.role !== "assistant" || !Array.isArray(m.content)) continue;
    for (let j = m.content.length - 1; j >= 0; j--) {
      const b = m.content[j];
      if (b?.type !== "toolCall") continue;
      if (b.name !== "write" && b.name !== "edit") continue;
      const p = b.arguments?.path ?? b.arguments?.file_path;
      if (typeof p === "string" && p && isPlanWritePath(p, cwd)) return p;
    }
  }
  return undefined;
}

/** Where a manual `/review` found the plan it is about to audit. */
export type PlanPathSource =
  | "explicit"
  | "run"
  | "session"
  | "handoff"
  | "branch";

export interface PlanPathCandidate {
  path?: string | null;
  source: PlanPathSource;
}

export interface PlanPathSelection {
  path: string;
  source: PlanPathSource;
}

/**
 * Pick the first readable plan for a manual `/review`.
 *
 * Candidates arrive in priority order (`explicit` → `run` → `session` →
 * `handoff` → `branch`). Missing, empty and unreadable candidates are skipped;
 * a plan that disappeared since it was written must never win over the next
 * candidate. Pure: the caller owns path resolution and the filesystem probe.
 */
export function choosePlanPath(
  candidates: readonly PlanPathCandidate[],
  isReadable: (absolutePath: string) => boolean,
): PlanPathSelection | undefined {
  for (const candidate of candidates) {
    const p = candidate.path;
    if (typeof p !== "string" || p.length === 0) continue;
    if (isReadable(p)) return { path: p, source: candidate.source };
  }
  return undefined;
}

/**
 * Newest plan reference in a session branch, used as the last manual
 * `/review` fallback after a reload or when the in-memory path was lost.
 *
 * Recognises the persisted `workflow` entry (`planFile`), the
 * `workflow-handoff-resolve` entry (`planPath`), and an assistant `write`/
 * `edit` tool call under `.pi/plans/`. Scans newest-first and never throws.
 */
export function findLatestPlanWriteInBranch(
  entries: readonly unknown[],
  cwd: string,
): string | undefined {
  if (!Array.isArray(entries) || entries.length === 0) return undefined;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i] as any;
    if (!e || typeof e !== "object") continue;
    if (e.type === "custom") {
      const p = e.data?.planPath ?? e.data?.planFile;
      if (typeof p === "string" && p && isPlanWritePath(p, cwd)) return p;
      continue;
    }
    if (e.type === "message" && e.message) {
      const found = findPlanWritePathInMessages([e.message], cwd);
      if (found) return found;
    }
  }
  return undefined;
}

// ── Plan date helpers (UTC) ──────────────────────────────────────

/**
 * Return YYYY-MM-DD in UTC for the given date (default: now). Uses the
 * toISOString slice, so it is deterministic across locales.
 *
 * Plan FILENAMES use `getUtcPlanStamp`/`getUtcDateTimePrefix` — they carry a
 * UTC time so same-day plans sort by creation time. This date-only helper is
 * kept for callers that only need the day (and for legacy plan names).
 */
export function getUtcDatePrefix(d: Date = new Date()): string {
  return d.toISOString().slice(0, 10);
}

/** The `.pi/plans/` filename stamp: date, time and their combined prefix. */
export interface UtcPlanStamp {
  /** `YYYY-MM-DD` (UTC). */
  date: string;
  /** `HHmm` (UTC, zero-padded, minute resolution). */
  time: string;
  /** `${date}-${time}` — the plan filename prefix. */
  prefix: string;
}

/**
 * The UTC date-time stamp used by `.pi/plans/<prefix>-<slug>.md`.
 *
 * Minute resolution is deliberate: a filename identifies a plan, not an event.
 * An invalid `Date` yields empty fields instead of throwing, so a bad clock
 * can never corrupt a plan path (`toISOString` would throw a RangeError).
 */
export function getUtcPlanStamp(d: Date = new Date()): UtcPlanStamp {
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) {
    return { date: "", time: "", prefix: "" };
  }
  const iso = d.toISOString(); // 2026-11-24T21:30:59.999Z
  const date = iso.slice(0, 10);
  const time = `${iso.slice(11, 13)}${iso.slice(14, 16)}`;
  return { date, time, prefix: `${date}-${time}` };
}

/** The `YYYY-MM-DD-HHmm` (UTC) prefix for a new plan filename. */
export function getUtcDateTimePrefix(d: Date = new Date()): string {
  return getUtcPlanStamp(d).prefix;
}

/** Split a plan path into its directory prefix and basename (both separators). */
function splitPlanBasename(p: string): { dir: string; base: string } {
  const normalizedSep = p.replace(/\\/g, "/");
  const lastSlash = normalizedSep.lastIndexOf("/");
  return {
    dir: lastSlash >= 0 ? p.slice(0, lastSlash + 1) : "",
    base: lastSlash >= 0 ? p.slice(lastSlash + 1) : p,
  };
}

const PLAN_DATE_PREFIX = /^(\d{4}-\d{2}-\d{2})-(.+)$/;
const PLAN_DATE_TIME_PREFIX = /^(\d{4}-\d{2}-\d{2})-(\d{2})(\d{2})-(.+)$/;

/**
 * Apply the `.pi/plans/<UTC-date>-<HHmm>-<slug>.md` convention to one path.
 *
 * Policy (deliberate — see `docs/plan-format.md`):
 *
 * - Only paths under `.pi/plans/` are touched; everything else is returned as
 *   supplied and no filesystem probe happens.
 * - An EXISTING file is never renamed or moved. Legacy date-only names
 *   (`YYYY-MM-DD-<slug>.md`) therefore keep working forever, and journals,
 *   review entries and docs never point at a path that no longer exists.
 * - A NEW path gets the current UTC stamp: a same-day date-time prefix is
 *   preserved (a long turn keeps its start time), a stale date-time prefix and
 *   a legacy date-only prefix are replaced in place, and an undated name is
 *   prefixed. The slug (everything after a valid date-time/date prefix) is
 *   always preserved.
 * - An invalid `Date` (or `opts.exists` throwing) leaves the path untouched:
 *   uncertainty never renames a plan.
 *
 * Returns `{ path, corrected, original }`; `original` is exactly what the
 * caller passed in.
 */
export function normalizePlanPath(
  p: string,
  cwd: string,
  clock: Date = new Date(),
  options?: { exists?: (absolutePath: string) => boolean },
): { path: string; corrected: boolean; original: string } {
  const original = p;
  const unchanged = { path: p, corrected: false, original };
  // Only touch paths that are under .pi/plans
  if (!isPlanWritePath(p, cwd)) return unchanged;
  const { dir, base } = splitPlanBasename(p);
  if (!base) return unchanged;

  const stamp = getUtcPlanStamp(clock);
  if (!stamp.prefix) return unchanged;

  // An existing plan is never renamed: a probe that throws counts as existing.
  const exists = options?.exists ?? fs.existsSync;
  const abs = path.isAbsolute(p) ? p : path.join(cwd, p);
  try {
    if (exists(abs)) return unchanged;
  } catch {
    return unchanged;
  }

  const dateTime = base.match(PLAN_DATE_TIME_PREFIX);
  if (dateTime) {
    const [, date, hh, mm, rest] = dateTime;
    if (Number(hh) < 24 && Number(mm) < 60) {
      if (date === stamp.date) return unchanged;
      return {
        path: `${dir}${stamp.prefix}-${rest}`,
        corrected: true,
        original,
      };
    }
    // Out-of-range time digits are not a time prefix; treat it as legacy
    // date-only below, where `HHmm-<slug>` simply stays part of the slug.
  }

  const legacy = base.match(PLAN_DATE_PREFIX);
  if (legacy) {
    const [, date, rest] = legacy;
    if (date === stamp.date) return unchanged;
    return { path: `${dir}${stamp.prefix}-${rest}`, corrected: true, original };
  }

  // No date prefix — prepend the date-time stamp.
  return { path: `${dir}${stamp.prefix}-${base}`, corrected: true, original };
}

/**
 * Look up the same plan under TODAY's UTC date.
 *
 * Used by `/review <path>` so a mistyped date still finds the file the
 * extension wrote. It replaces only the leading `YYYY-MM-DD` and preserves the
 * time and slug (`2026-11-20-2130-foo.md` → `2026-11-24-2130-foo.md`), and it
 * never writes or renames anything. `undefined` means "not a dated plan name".
 */
export function dateCorrectedPlanPath(
  p: string,
  cwd: string,
  clock: Date = new Date(),
): string | undefined {
  if (!isPlanWritePath(p, cwd)) return undefined;
  const { dir, base } = splitPlanBasename(p);
  if (!base) return undefined;
  const today = getUtcPlanStamp(clock).date;
  if (!today) return undefined;
  const m = base.match(PLAN_DATE_PREFIX);
  if (!m) return undefined;
  const [, date, rest] = m;
  if (date === today) return p;
  return `${dir}${today}-${rest}`;
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
// Review Mode (see review.ts) audits Plan Mode's plan and appends advisory
// review notes to it (the plan body itself is never rewritten). The
// helpers below are the deterministic part: they never call a model and never
// touch the Pi SDK, so they are fully unit-testable.
// ══════════════════════════════════════════════════════════════════════
/**
 * Legacy Review Mode heading (pre-append-only): it used to separate the human
 * plan from the reviewer's changelog.
 *
 * Current rounds append `## Reviewer Revisions (round N)` instead, so this
 * heading is no longer emitted by the live path. It stays exported because
 * `stripReviewAppendix` still removes it from plans written by older versions
 * (and `appendReviewChangelog` remains available for that legacy shape).
 */
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

/** A required change the reviewer appends to the Reviewer Revisions appendix. */
export interface ReviewRevision {
  /** Stable id, `R<n>`. Normalised to submission order when the model omits it. */
  id: string;
  /** Plan step number or short reference, e.g. "3" or "Phase 2". */
  step?: string;
  /** The concrete revision the author must make. */
  change: string;
  /** Finding ids this revision addresses, e.g. ["F1", "F3"]. */
  findingIds?: string[];
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

/**
 * True when a severity tier is high enough to warrant the verify pass.
 *
 * Step 9: only accepted findings at severity >= 7 (with confidence >= 60)
 * trigger self-verification. Lower findings are not worth a second full LLM
 * turn; empty, low-severity, or rejected-only findings resubmit pass 1's
 * plan directly.
 */
export function reviewNeedsVerification(findings: ReviewFinding[]): boolean {
  if (!Array.isArray(findings)) return false;
  return findings.some(
    (f) =>
      Number(f?.severity) >= 7 &&
      Number(f?.confidence) >= 60 &&
      f?.disposition === "accepted",
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
 * Render the `### Required changes` block of the Reviewer Revisions appendix.
 *
 * This is the single source of truth for the format. `renderReviewerRevisions`
 * (review-tools.ts) calls it and `parseReviewNotes` (this module) parses
 * exactly this output, so the renderer and parser cannot drift.
 * Returns "" when there is nothing to list.
 */
export function renderRequiredChanges(
  revisions: ReviewRevision[] | undefined,
): string {
  const list = Array.isArray(revisions) ? revisions.filter(Boolean) : [];
  if (list.length === 0) return "";
  const lines = ["### Required changes", ""];
  for (const revision of list) {
    const step = revision.step ? ` · Step ${revision.step}` : "";
    const findings =
      Array.isArray(revision.findingIds) && revision.findingIds.length > 0
        ? ` _(${revision.findingIds.join(", ")})_`
        : "";
    lines.push(`- **${revision.id}${step}:** ${revision.change}${findings}`);
  }
  return lines.join("\n");
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
// ── Advisory review notes: parse the appendix ───────────────────────

/** One advisory note parsed from an appendix's `### Required changes` list. */
export interface ReviewNote {
  /** Stable id, `R<n>`. Legacy sections without ids get `R1..Rn` positionally. */
  id: string;
  /** Plan step reference, when the bullet carried ` · Step <step>`. */
  step?: string;
  /** The required change, with the trailing `_(F1, F3)_` fragment removed. */
  change: string;
  /** Finding ids from the trailing `_(F1, F3)_` fragment, when present. */
  findingIds?: string[];
}

/** Result of {@link parseReviewNotes}. */
export interface ParsedReviewNotes {
  /** Notes from the LAST `## Reviewer Revisions (round N)` section only. */
  notes: ReviewNote[];
  /** Round number of the section that was read, when the plan has one. */
  round?: number;
}

/** `## Reviewer Revisions (round N)` — the last match wins in the parser. */
const REVIEWER_REVISIONS_HEADING =
  /^[ \t]*##[ \t]+Reviewer Revisions[ \t]*\(round[ \t]*(\d+)\)[ \t]*$/gim;

/** Optional `### Required changes` sub-heading of the appendix. */
const REQUIRED_CHANGES_HEADING = /^[ \t]*###[ \t]+Required changes[ \t]*$/im;

/** Any Markdown heading — ends the required-changes list region. */
const ANY_MARKDOWN_HEADING = /^[ \t]*#{1,6}[ \t]+\S/;

/** Trailing `_(F1, F3)_` fragment rendered by `renderRequiredChanges`. */
const FINDINGS_FRAGMENT = /[ \t]*_\(([^()]*)\)_[ \t]*$/;

interface ParsedRequiredChange {
  id?: string;
  step?: string;
  change: string;
  findingIds?: string[];
}

/**
 * Parse one `- **R1 · Step 2:** change _(F1)_` bullet body (the text after
 * `- `). Grammar: `**R<n>[ · Step <step>][:]** <change>[ _(<f1>, <f3>)_]`.
 * Legacy bullets (`**Step 3:** change`, `**3:** change`) carry no id; the
 * caller assigns `R1..Rn` by position within that section. Anything that does
 * not fit the grammar returns undefined and the caller skips the line.
 */
function parseRequiredChangeBullet(body: string): ParsedRequiredChange | undefined {
  const bold = /^\*\*(.+?)\*\*([\s\S]*)$/.exec(body.trim());
  if (!bold) return undefined;
  const head = bold[1].replace(/[ \t]+$/, "");
  const headCore = head.endsWith(":") ? head.slice(0, -1).trimEnd() : head;

  let id: string | undefined;
  let step: string | undefined;
  const withId = /^(R\d+)(?:[ \t]*\u00b7[ \t]*Step[ \t]+(.+))?$/i.exec(headCore);
  if (withId) {
    id = withId[1].toUpperCase();
    step = withId[2]?.trim() || undefined;
  } else {
    const legacyStep = /^Step[ \t]+(.+)$/i.exec(headCore);
    const legacyNumber = /^(\d+)$/.exec(headCore);
    step = legacyStep?.[1]?.trim() || legacyNumber?.[1];
    if (!step) return undefined;
  }

  let change = bold[2].trim();
  let findingIds: string[] | undefined;
  const fragment = FINDINGS_FRAGMENT.exec(change);
  if (fragment) {
    const ids = fragment[1]
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    if (ids.length > 0) findingIds = ids;
    change = change.slice(0, fragment.index).trimEnd();
  }
  if (!change) return undefined;

  const parsed: ParsedRequiredChange = { change };
  if (id) parsed.id = id;
  if (step) parsed.step = step;
  if (findingIds) parsed.findingIds = findingIds;
  return parsed;
}

/** Next free positional `R<n>` for a legacy (id-less) section. */
function nextLegacyId(start: number, taken: Set<string>): string {
  let n = start;
  while (taken.has(`R${n}`)) n++;
  return `R${n}`;
}

/**
 * Parse the advisory notes out of the plan's Reviewer Revisions appendix.
 *
 * Reads only the LAST `## Reviewer Revisions (round N)` section (a plan can
 * carry one per review round; the newest round wins) and only that section's
 * `### Required changes` list — the findings changelog and anything outside the
 * block are ignored. The block ends at the next heading, at the first line
 * that is neither blank nor a `- ` bullet, or at the end of the section.
 *
 * Format: exactly what `renderRequiredChanges` emits, i.e.
 * `- **R<n>[ · Step <step>][:]** <change>[ _(<f1>, <f3>)_]`. A trailing
 * findings fragment is stripped from `change` and returned as `findingIds`.
 *
 * Legacy sections written before ids existed (`- **Step 3:** change`,
 * `- **3:** change`) get positional ids `R1..Rn` in bullet order within that
 * section, skipping ids already claimed by explicit bullets, so old appendices
 * stay parseable without rewriting the plan body.
 *
 * A malformed line is skipped, never thrown. A plan with no appendix (or a
 * round without required changes) returns `{ notes: [] }`.
 */
export function parseReviewNotes(planText: string): ParsedReviewNotes {
  const text = String(planText ?? "").replace(/\r\n?/g, "\n");
  const headings = [...text.matchAll(REVIEWER_REVISIONS_HEADING)];
  const last = headings[headings.length - 1];
  if (!last || last.index === undefined) return { notes: [] };

  const round = Number(last[1]);
  const afterHeading = text.slice(last.index + last[0].length);
  const nextSection = /^[ \t]*##[ \t]+\S[^\n]*$/m.exec(afterHeading);
  const section = nextSection
    ? afterHeading.slice(0, nextSection.index)
    : afterHeading;

  const blockHeading = REQUIRED_CHANGES_HEADING.exec(section);
  if (!blockHeading) return { notes: [], round };
  const block = section.slice(blockHeading.index + blockHeading[0].length);

  const notes: ReviewNote[] = [];
  const taken = new Set<string>();
  for (const line of block.split("\n")) {
    const bullet = line.trimEnd();
    if (!bullet.trim()) continue;
    if (ANY_MARKDOWN_HEADING.test(bullet)) break;
    if (!bullet.startsWith("- ")) break;
    const parsed = parseRequiredChangeBullet(bullet.slice(2));
    if (!parsed) continue;
    const note: ReviewNote = {
      id: parsed.id ?? nextLegacyId(notes.length + 1, taken),
      change: parsed.change,
    };
    if (parsed.step) note.step = parsed.step;
    if (parsed.findingIds) note.findingIds = parsed.findingIds;
    taken.add(note.id);
    notes.push(note);
  }
  return { notes, round };
}

/**
 * Split a reviewed plan into the Planner's body and the Reviewer's appendix.
 *
 * The appendix is the LAST `## Reviewer Revisions (round N)` section — from
 * that heading to the next H2 or EOF — using the same
 * `REVIEWER_REVISIONS_HEADING` grammar as {@link parseReviewNotes}, so one
 * plan carrying several rounds splits on the round the parser reads. A plan
 * with no appendix returns `{ body: planText.trim(), appendix: "" }`.
 *
 * Ownership (plan 2026-11-26): the Planner may rewrite `body` and must leave
 * `appendix` untouched. Line endings are normalized to `\n` and trailing
 * horizontal whitespace per line is dropped on BOTH halves, so a Windows
 * editor save (CRLF, trailing blanks) is not mistaken for an appendix edit and
 * does not change the body hash.
 *
 * Why this is not `review-tools.stripReviewerRevisions`: that helper cuts at
 * the FIRST round heading and discards the appendix; the Planner loop needs the
 * LAST section's text to compare against the expected appendix.
 *
 * Deliberately does NOT touch {@link planHash} or {@link stripReviewAppendix}:
 * those define which plans count as already reviewed.
 */
export function splitReviewerAppendix(planText: string): {
  body: string;
  appendix: string;
} {
  const text = String(planText ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+$/gm, "");
  if (!text.trim()) return { body: "", appendix: "" };
  const headings = [...text.matchAll(REVIEWER_REVISIONS_HEADING)];
  const last = headings[headings.length - 1];
  if (!last || last.index === undefined) {
    return { body: text.trim(), appendix: "" };
  }
  const afterHeading = text.slice(last.index + last[0].length);
  const nextSection = /^[ \t]*##[ \t]+\S[^\n]*$/m.exec(afterHeading);
  const appendixEnd =
    last.index + last[0].length + (nextSection ? nextSection.index : afterHeading.length);
  return {
    body: text.slice(0, last.index).trim(),
    appendix: text.slice(last.index, appendixEnd).trim(),
  };
}

/**
 * Minimal unified diff between two plan texts (step 9).
 *
 * Pass 2 only checks "did the rewrite drop a requirement", so it gets a
 * diff — not two full plans. Prefix/suffix trim with a few context lines
 * keeps typical localized rewrites at ~1/10th the tokens; a total rewrite
 * degrades to one hunk (no worse than today). Capped and never throws.
 */
export function buildPlanDiff(
  original: string,
  revised: string,
  context = 3,
): string {
  const a = String(original ?? "").split("\n");
  const b = String(revised ?? "").split("\n");
  if (a.join("\n") === b.join("\n")) return "(no differences)";
  const ctx = Number.isFinite(context)
    ? Math.max(0, Math.min(10, Math.trunc(Number(context))))
    : 3;
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start])
    start++;
  let endA = a.length - 1;
  let endB = b.length - 1;
  while (endA >= start && endB >= start && a[endA] === b[endB]) {
    endA--;
    endB--;
  }
  const fromA = Math.max(0, start - ctx);
  const toA = Math.min(a.length - 1, endA + ctx);
  const fromB = Math.max(0, start - ctx);
  const toB = Math.min(b.length - 1, endB + ctx);
  const out = [
    "--- original (author)",
    "+++ rewritten (reviewer)",
    `@@ -${fromA + 1},${toA - fromA + 1} +${fromB + 1},${toB - fromB + 1} @@`,
  ];
  for (let i = fromA; i < start; i++) out.push(`  ${a[i]}`);
  for (let i = start; i <= endA; i++) out.push(`- ${a[i]}`);
  for (let i = start; i <= endB; i++) out.push(`+ ${b[i]}`);
  const tailFrom = Math.max(endA + 1, endB + 1, start);
  const tailTo = Math.max(toA, toB);
  const tailSrc = toA - fromA >= toB - fromB ? a : b;
  for (let i = tailFrom; i <= Math.min(tailTo, tailSrc.length - 1); i++)
    out.push(`  ${tailSrc[i]}`);
  const text = out.join("\n");
  const MAX_DIFF_CHARS = 12_000;
    return text.length > MAX_DIFF_CHARS
      ? `${text.slice(0, MAX_DIFF_CHARS)}\n… [diff truncated — the rewrite is large; re-read the plan file]`
      : text;
}

/** Outcome of landing a detached background review (steps 5/11). */
export type ReviewLanding = "updated" | "unchanged" | "stale";

/**
 * Decide what a landed background review may announce (step 11 contract).
 * Pure: `diskHash` is the plan file on disk, `inputHash` the reviewed
 * revision, `finalHash` the reviewer's rewrite. Only `updated` (the disk
 * holds the rewrite) announces a change; every other outcome keeps the
 * author's/user's text and stays quiet or defers to a re-run.
 */
export function classifyReviewLanding(input: {
  diskHash?: string;
  inputHash: string;
  finalHash: string;
}): ReviewLanding {
  if (input.diskHash === undefined) return "unchanged";
  if (input.diskHash === input.finalHash) return "updated";
  if (input.diskHash === input.inputHash) return "unchanged";
  return "stale";
}

/**
 * Strip the Review Mode changelog appendix from a plan.
 *
 * Strips exactly two headings (plus a `---` rule immediately before them):
 * `## Review changes` and `## Unresolved findings`.
 *
 * `## Reviewer Revisions (round N)` is deliberately NOT stripped. The revision
 * appendix is part of the reviewed document, and the review-round guards compare
 * post-review text, so a new round is a new document by design. Widening this
 * helper would silently change which plans count as already reviewed; pass-2
 * resubmission owns that heading separately (`review-tools.stripReviewerRevisions`).
 *
 * Returns the text with those two headings removed; the revision appendix, when
 * present, is preserved exactly.
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
 * Content hash of a reviewed plan document.
 *
 * Goes through `stripReviewAppendix`, so it ignores only `## Review changes` and
 * `## Unresolved findings`. The `## Reviewer Revisions (round N)` appendix is
 * intentionally INCLUDED: it is part of the reviewed document, and the
 * review-round guards (handoff print dedupe, Plannotator stale-tab check,
 * approval re-read, pause/review `unchanged`) compare the post-review text. A new
 * round therefore hashes as a new document; identical reviewed text hashes
 * identically across calls.
 *
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
    ? Math.min(4000, Math.max(200, Number(opts.maxToolResultChars)))
    : 1000;
  const maxEntries = Number.isFinite(opts.maxEntries)
    ? Math.min(120, Math.max(1, Number(opts.maxEntries)))
    : 30;
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
 * in between is the reviewer legitimately doing its work, and every revision is
 * still made visible to the user through the `## Reviewer Revisions` appendix.
 *
 * Dead export: the append-only submission path no longer validates a replacement
 * body, so nothing calls this. It is kept (and re-exported by review.ts) only so
 * the removal is a separate, reversible change; `## Review changes` in the
 * paragraph above is the LEGACY heading that `stripReviewAppendix` still strips.
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
    ? Math.min(60_000, Math.max(1000, Number(opts.maxChars)))
    : 15_000;
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
    out = `${out.slice(0, maxChars)}\n\n… [context truncated at ${maxChars} chars — re-read anything you rely on with read/grep]`;
  }
  return out;
}

// ── Planner-context manifest for the reviewer (step 8) ─────────────

/** What `buildPlannerContextManifest` found in the parent branch. */
export interface PlannerContextManifest {
  /** Markdown section for the pass-1 prompt ("" when there is nothing). */
  markdown: string;
  /** Distinct file paths inventoried. */
  files: number;
  /** Explore recon summaries included. */
  reconResults: number;
}

export interface BuildPlannerManifestOptions {
  /** Max files listed in the inventory. */
  maxFiles?: number;
  /** Max explore results summarized. */
  maxReconResults?: number;
  /** Max chars taken from the tail of each explore result. */
  maxReconChars?: number;
  /**
   * Describe a referenced path (size/mtime/hash token). Return undefined
   * for paths that cannot be described — the path is still listed.
   */
  describeFile?: (path: string) => string | undefined;
}

const PLANNER_MANIFEST_MAX_FILES = 200;
const PLANNER_MANIFEST_MAX_RECON = 3;
const PLANNER_MANIFEST_RECON_CHARS = 700;

/**
 * Ordered unique `path`/`file_path` arguments from tool calls in the branch.
 * These are the files Plan Mode touched — the reviewer can trust them
 * unless a finding cites them (then it re-reads). Never throws.
 */
function manifestToolPaths(entries: unknown, maxFiles: number): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();
  const take = (raw: unknown): void => {
    if (paths.length >= maxFiles) return;
    if (typeof raw !== "string") return;
    const p = raw.trim();
    if (!p || p.length > 500 || seen.has(p)) return;
    seen.add(p);
    paths.push(p);
  };
  try {
    if (!Array.isArray(entries)) return paths;
    for (const e of entries) {
      if (paths.length >= maxFiles) break;
      if (!e || typeof e !== "object") continue;
      const blocks = (e as { message?: { content?: unknown } }).message
        ?.content;
      if (!Array.isArray(blocks)) continue;
      for (const b of blocks) {
        if (!b || typeof b !== "object") continue;
        const t = (b as { type?: unknown }).type;
        if (t !== "toolCall" && t !== "tool_use") continue;
        const args = (b as { arguments?: unknown; input?: unknown })
          .arguments ?? (b as { input?: unknown }).input;
        if (args && typeof args === "object") {
          take((args as Record<string, unknown>).path);
          take((args as Record<string, unknown>).file_path);
        }
      }
    }
  } catch {
    /* keep what was collected */
  }
  return paths;
}

/**
 * Tails of the most recent `explore` tool results (Plan Mode recon), newest
 * first. Conclusions tend to live at the end, so the tail is kept. Never throws.
 */
function manifestReconTails(
  entries: unknown,
  maxResults: number,
  maxChars: number,
): string[] {
  const tails: string[] = [];
  try {
    if (!Array.isArray(entries)) return tails;
    for (
      let i = entries.length - 1;
      i >= 0 && tails.length < maxResults;
      i--
    ) {
      const msg = (entries[i] as { message?: unknown })?.message as
        | { role?: unknown; toolName?: unknown; content?: unknown }
        | undefined;
      if (!msg || msg.role !== "toolResult" || msg.toolName !== "explore")
        continue;
      const text = contentBlocksToText(msg.content).trim();
      if (!text) continue;
      tails.push(
        text.length > maxChars ? `…${text.slice(text.length - maxChars)}` : text,
      );
    }
  } catch {
    /* keep what was collected */
  }
  return tails;
}

/**
 * Build the Planner-context manifest: a file inventory with change tokens
 * plus recent explore recon, so the reviewer verifies instead of re-exploring
 * (plan 2026-10-23, step 8). Takes the RAW branch — pruned entries elide the
 * explore tails this needs. Pure except for the optional `describeFile`.
 * Never throws; empty input yields an empty markdown section.
 */
export function buildPlannerContextManifest(
  entries: unknown,
  opts: BuildPlannerManifestOptions = {},
): PlannerContextManifest {
  const empty: PlannerContextManifest = {
    markdown: "",
    files: 0,
    reconResults: 0,
  };
  try {
    const maxFiles = Number.isFinite(opts.maxFiles)
      ? Math.max(1, Math.min(500, Number(opts.maxFiles)))
      : PLANNER_MANIFEST_MAX_FILES;
    const maxRecon = Number.isFinite(opts.maxReconResults)
      ? Math.max(0, Math.min(10, Number(opts.maxReconResults)))
      : PLANNER_MANIFEST_MAX_RECON;
    const maxReconChars = Number.isFinite(opts.maxReconChars)
      ? Math.max(100, Math.min(8000, Number(opts.maxReconChars)))
      : PLANNER_MANIFEST_RECON_CHARS;
    const paths = manifestToolPaths(entries, maxFiles);
    const recon = manifestReconTails(entries, maxRecon, maxReconChars);
    if (paths.length === 0 && recon.length === 0) return empty;
    const lines = [
      "## Shared context (Planner — trusted unless a finding cites it)",
      "",
      "Plan Mode already explored this repository. Trust this inventory and",
      "these recon summaries for everything they cover; re-read only files a",
      "finding anchors, plus one or two spot checks.",
      "",
    ];
    if (paths.length > 0) {
      lines.push(`Files Plan Mode touched (${paths.length}):`, "");
      for (const p of paths) {
        let detail = "";
        try {
          const d = opts.describeFile?.(p);
          if (d) detail = ` — ${d}`;
        } catch {
          /* a path is still listed without its token */
        }
        lines.push(`- \`${p}\`${detail}`);
      }
      lines.push("");
    }
    if (recon.length > 0) {
      lines.push(`Planner recon (newest first, ${recon.length}):`, "");
      recon.forEach((tail, i) => {
        lines.push(`### Recon ${i + 1}`, "", tail, "");
      });
    }
    return {
      markdown: lines.join("\n").trimEnd(),
      files: paths.length,
      reconResults: recon.length,
    };
  } catch {
    return empty;
  }
}

// ── Slash-command argument completions (pi-tui contract) ─────────────
//
// `CombinedAutocompleteProvider.getSuggestions` (pi-tui dist/autocomplete.js)
// passes `getArgumentCompletions(argumentText)` the ENTIRE typed argument
// text after the command name and, on accept, `applyCompletion` replaces
// that whole argument text with `item.value` (the slash-argument branch:
// `newLine = beforePrefix + item.value`). So an argument-position item's
// `value` must be the complete replacement — e.g. `"use <name>"`, never the
// bare token. Pi's own /mcp extension follows this contract
// (`value: `${action} ${name}``). `joinArgumentValue` is the single helper
// that enforces it: it keeps every committed token and appends (or replaces
// the last partial token with) `token`.

/** One slash-command argument completion item (pi-tui `AutocompleteItem` shape). */
export interface ArgumentCompletion {
  value: string;
  label: string;
  description?: string;
}

/**
 * Build the full-argument replacement `value` for a completion token.
 *
 * `prefix` is the typed argument text so far. Tokens separated by whitespace
 * are "committed"; if `prefix` ends with whitespace the user is starting a
 * fresh token, so `token` is appended — otherwise it replaces the trailing
 * partial token. Pure; never throws.
 *
 *   joinArgumentValue("use Syn-De", "Syn-Deepseek-v4.1-Flash-Planner")
 *     → "use Syn-Deepseek-v4.1-Flash-Planner"
 *   joinArgumentValue("use ", "none") → "use none"
 *   joinArgumentValue("", "list")     → "list"
 */
export function joinArgumentValue(prefix: string, token: string): string {
  const raw = String(prefix ?? "");
  const endsWithWs = /\s$/.test(raw);
  const parts = raw.trim().split(/\s+/).filter(Boolean);
  const committed = endsWithWs ? parts : parts.slice(0, -1);
  return [...committed, token].join(" ");
}

/**
 * Exact-match suppression for slash-command argument completions: when the
 * token being typed (`partial`, "" while the prefix ends with whitespace)
 * already equals the ONLY remaining candidate, return true so the completer
 * yields null — pi's editor then closes the dropdown and the FIRST Enter
 * submits instead of being consumed by the completion-accept handler
 * (editor.js `tui.select.confirm`). Pure.
 */
export function suppressExactArgumentMatch(
  candidates: readonly string[],
  partial: string,
): boolean {
  if (!partial) return false;
  return (
    candidates.length === 1 &&
    candidates[0].toLowerCase() === partial.toLowerCase()
  );
}
