/**
 * Workflow Extension — shared child runtime stats (Orchestrator Build child,
 * Review round).
 *
 * The parent is the only renderer, but the numbers belong to the child session:
 * `InProcessChildSession` exposes `currentModel()` / `stats()` (see
 * `in-process-child.ts`), and every surface — footer status, pinned panel,
 * operator text, host contributions — formats them through THIS module so the
 * four cannot disagree.
 *
 * Everything here is pure and defensive: an absent value renders as nothing,
 * never as a fabricated `0` or `?`.
 */

/** A `provider/id(thinking)` reference the child is actually running. */
export interface ChildModelRef {
  provider: string;
  id: string;
  thinking?: string;
}

/** The child's current context window usage. */
export interface ChildContextUsage {
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
}

/** Cumulative child token totals (session scope, the SDK's own counters). */
export interface ChildTokenTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

/** One child session's live telemetry, as the parent can observe it. */
export interface ChildRuntimeStats {
  model?: ChildModelRef;
  thinking?: string;
  tokens?: ChildTokenTotals;
  context?: ChildContextUsage;
  /** Cumulative cost in USD, when the SDK reports it. */
  cost?: number;
}

const DEFAULT_MAX_MODEL_CHARS = 48;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function nonNegative(value: unknown): number | undefined {
  return isFiniteNumber(value) && value >= 0 ? value : undefined;
}

/** Collapse control characters so a value can never break a one-line status. */
export function sanitizeStatLine(text: string): string {
  return String(text)
    .replace(/[\r\n\t]/g, " ")
    .replace(/ +/g, " ")
    .trim();
}

/**
 * Compact token count, matching Pi's own footer so the two lines agree:
 * `999`, `1.5k`, `12k`, `1.2M`.
 */
export function formatTokenCount(count: number | null | undefined): string {
  const value = nonNegative(count);
  if (value === undefined) return "";
  if (value < 1_000) return String(Math.round(value));
  if (value < 10_000) return `${(value / 1_000).toFixed(1)}k`;
  if (value < 1_000_000) return `${Math.round(value / 1_000)}k`;
  if (value < 10_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  return `${Math.round(value / 1_000_000)}M`;
}

/**
 * `ctx 43%` / `ctx 43% (86k/200k)`.
 *
 * `long` adds the token/window pair for the footer; the panel uses the short
 * form. An unknown percentage renders the token pair only, and unknown both
 * render nothing at all (never `ctx ?`).
 */
export function formatContextUsage(
  context: ChildContextUsage | undefined,
  opts?: { long?: boolean },
): string {
  if (!context) return "";
  const percent = nonNegative(context.percent);
  const tokens = nonNegative(context.tokens);
  const window = nonNegative(context.contextWindow);
  const percentText =
    percent === undefined ? "" : `${Math.round(percent)}%`;
  const pairText =
    tokens !== undefined && window !== undefined && window > 0
      ? `${formatTokenCount(tokens)}/${formatTokenCount(window)}`
      : "";
  if (opts?.long && pairText) {
    return percentText ? `ctx ${percentText} (${pairText})` : `ctx ${pairText}`;
  }
  if (percentText) return `ctx ${percentText}`;
  return pairText ? `ctx ${pairText}` : "";
}

/** `↑12k ↓3k`, plus cache read/write only when the SDK reports them. */
export function formatChildTokens(
  tokens: ChildTokenTotals | undefined,
): string {
  if (!tokens) return "";
  const parts: string[] = [];
  const input = nonNegative(tokens.input);
  const output = nonNegative(tokens.output);
  const cacheRead = nonNegative(tokens.cacheRead);
  const cacheWrite = nonNegative(tokens.cacheWrite);
  if (input !== undefined && input > 0) parts.push(`↑${formatTokenCount(input)}`);
  if (output !== undefined && output > 0) {
    parts.push(`↓${formatTokenCount(output)}`);
  }
  if (cacheRead !== undefined && cacheRead > 0) {
    parts.push(`R${formatTokenCount(cacheRead)}`);
  }
  if (cacheWrite !== undefined && cacheWrite > 0) {
    parts.push(`W${formatTokenCount(cacheWrite)}`);
  }
  return parts.join(" ");
}

/** `01:23`, `1:02:03`; a negative (clock-skew) value clamps to `00:00`. */
export function formatElapsed(elapsedMs: number | null | undefined): string {
  // Unlike tokens, a negative elapsed is clock skew, not "unknown": the child
  // is definitely running, so clamp it rather than blanking the field.
  if (!isFiniteNumber(elapsedMs)) return "";
  const value = Math.max(0, elapsedMs);
  const totalSeconds = Math.floor(value / 1_000);
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3_600);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return hours > 0
    ? `${hours}:${pad(minutes)}:${pad(seconds)}`
    : `${pad(minutes)}:${pad(seconds)}`;
}

/** `provider/id`, truncated from the middle so the provider stays readable. */
export function formatChildModel(
  model: ChildModelRef | undefined,
  maxChars = DEFAULT_MAX_MODEL_CHARS,
): string {
  if (!model) return "";
  const ref = `${model.provider}/${model.id}`;
  const text = sanitizeStatLine(ref);
  if (text.length <= maxChars) return text;
  const budget = Math.max(8, maxChars);
  const head = Math.ceil((budget - 1) / 2);
  const tail = Math.floor((budget - 1) / 2);
  return `${text.slice(0, head)}…${text.slice(text.length - tail)}`;
}

/**
 * Split an older `provider/id` label into a structured ref.
 *
 * Several surfaces still receive only the launch label (the pinned panel, the
 * operator snapshot), so they need the same split rather than a second parser.
 */
export function modelRefFromLabel(
  label: string | undefined,
): ChildModelRef | undefined {
  if (typeof label !== "string") return undefined;
  const trimmed = label.trim();
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash >= trimmed.length - 1) return undefined;
  return {
    provider: trimmed.slice(0, slash),
    id: trimmed.slice(slash + 1),
  };
}

/** Derive the launch/live model label for the narrow handle. */
export function childModelLabel(
  model: ChildModelRef | undefined,
  fallback?: string,
): string {
  const formatted = formatChildModel(model);
  if (formatted) return formatted;
  return typeof fallback === "string" ? fallback : "";
}

export interface ChildStatusInput {
  ref?: string;
  total?: number;
  phase?: string;
  stats?: ChildRuntimeStats;
  model?: ChildModelRef;
  /** Task-local todo counters (the child's own list). */
  todoDone?: number;
  todoTotal?: number;
  /** Last tool label, shown by the compact progress form. */
  lastTool?: string;
  elapsedMs?: number;
}

function identityBits(input: ChildStatusInput): string[] {
  const ref =
    typeof input.ref === "string" && input.ref.length > 0 ? input.ref : "?";
  const total = isFiniteNumber(input.total) ? input.total : 0;
  const phase = input.phase ? input.phase : "starting";
  return total > 0 ? [`child ${ref}/${total} ${phase}`] : [`child ${phase}`];
}

/**
 * The one-line child status shared by the footer status, the child band detail
 * and the operator text.
 *
 * With stats the line is:
 *   `child 2/7 running · provider/id · ctx 43% (86k/200k) · ↑12k ↓3k · 01:23 · 3/5 todos`
 * Without stats it degrades to the historical shape:
 *   `child 2/7 running · provider/id · 3/5 todos`
 */
export function formatChildStatusLine(input: ChildStatusInput): string {
  const bits = identityBits(input);
  const model = formatChildModel(input.model ?? input.stats?.model);
  if (model) bits.push(model);
  const context = formatContextUsage(input.stats?.context, { long: true });
  if (context) bits.push(context);
  const tokens = formatChildTokens(input.stats?.tokens);
  if (tokens) bits.push(tokens);
  const elapsed = formatElapsed(input.elapsedMs);
  if (elapsed) bits.push(elapsed);
  if (
    typeof input.todoTotal === "number" &&
    input.todoTotal > 0
  ) {
    bits.push(`${input.todoDone ?? 0}/${input.todoTotal} todos`);
  }
  return sanitizeStatLine(bits.filter(Boolean).join(" · "));
}

/**
 * The pinned panel's child header: bounded, model + context only.
 * `▌ CHILD 2/7 · provider/id · ctx 43% · local todos`
 */
export function formatChildPanelHeader(input: {
  ref?: string;
  total?: number;
  model?: ChildModelRef;
  stats?: ChildRuntimeStats;
}): string {
  const ref =
    typeof input.ref === "string" && input.ref.length > 0 ? input.ref : "?";
  const total = isFiniteNumber(input.total) ? input.total : 0;
  const bits = [total > 0 ? `▌ CHILD ${ref}/${total}` : "▌ CHILD"];
  const model = formatChildModel(input.model ?? input.stats?.model, 32);
  if (model) bits.push(model);
  const context = formatContextUsage(input.stats?.context);
  if (context) bits.push(context);
  bits.push("local todos");
  return sanitizeStatLine(bits.join(" · "));
}

/**
 * The compact progress detail used by the historical child band (which already
 * carries the launch model): `read · 3/5 todos`, or nothing.
 */
export function formatChildProgress(input: ChildStatusInput): string {
  const bits: string[] = [];
  const tool = input.lastTool ? sanitizeStatLine(input.lastTool) : "";
  if (tool) bits.push(tool);
  if (typeof input.todoTotal === "number" && input.todoTotal > 0) {
    bits.push(`${input.todoDone ?? 0}/${input.todoTotal} todos`);
  }
  return bits.join(" · ");
}
