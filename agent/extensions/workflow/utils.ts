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

export interface TodoItem {
  step: number;
  text: string;
  completed: boolean;
}

export function cleanStepText(text: string): string {
  let cleaned = text
    .replace(/\*{1,2}([^*]+)\*{1,2}/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(
      /^(Use|Run|Execute|Create|Write|Read|Check|Verify|Update|Modify|Add|Remove|Delete|Install)\s+(the\s+)?/i,
      "",
    )
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length > 0)
    cleaned = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
  if (cleaned.length > 50) cleaned = `${cleaned.slice(0, 47)}...`;
  return cleaned;
}

export function extractTodoItems(message: string): TodoItem[] {
  const items: TodoItem[] = [];
  // Try multiple header patterns: strict Plan:\n, "# Plan:" heading, or "Plan:" with trailing title
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
  if (headerIdx === -1) return items;
  const planSection = message.slice(headerIdx + headerLen);
  const numberedPattern = /^\s*(?:#{1,4}\s*)?(\d+)[.)]\s+\*{0,2}([^\n]+)/gm;
  for (const match of planSection.matchAll(numberedPattern)) {
    const text = match[2]
      .trim()
      .replace(/\*{1,2}$/, "")
      .trim();
    if (
      text.length > 5 &&
      !text.startsWith("`") &&
      !text.startsWith("/") &&
      !text.startsWith("-")
    ) {
      const cleaned = cleanStepText(text);
      if (cleaned.length > 3)
        items.push({ step: items.length + 1, text: cleaned, completed: false });
    }
  }
  return items;
}

export function extractPlanStepsFromMarkdown(md: string): TodoItem[] {
  const items = extractTodoItems(md);
  if (items.length > 0) return items;
  // Tolerant heading search: any heading containing "Plan Steps" (case-insensitive)
  const headingMatch = md.match(/^#+\s*.*Plan Steps.*$/im);
  let section: string;
  if (headingMatch && headingMatch.index !== undefined) {
    section = md.slice(headingMatch.index);
  } else {
    // Also accept "## 4) Plan Steps" style via broader search
    const altIdx = md.search(/^##+\s*.*Plan Steps/im);
    section = altIdx >= 0 ? md.slice(altIdx) : md;
  }
  const numberedPattern = /^\s*(?:#{1,4}\s*)?(\d+)[.)]\s+(.+)$/gm;
  for (const match of section.matchAll(numberedPattern)) {
    const text = cleanStepText(match[2].trim());
    if (text.length > 3)
      items.push({ step: items.length + 1, text, completed: false });
  }
  // Second pass: "### Step N: Title" or "#### 1. Title" style when numbered pattern yields zero
  if (items.length === 0) {
    const stepHeaderPattern =
      /^\s*#{3,4}\s*Step\s*\d+\s*[:\-\u2014]?\s*(.+)$/gim;
    for (const m of section.matchAll(stepHeaderPattern)) {
      const text = cleanStepText(m[1].trim());
      if (text.length > 3)
        items.push({ step: items.length + 1, text, completed: false });
    }
  }
  // Last resort: if still zero and section is whole file, try loose numbered pattern on full md but filtered to short list context
  if (items.length === 0 && section === md) {
    // Avoid capturing unrelated numbered lists by requiring at least 2 items; otherwise leave empty for caller to synthesize
  }
  return items;
}

export function extractDoneSteps(message: string): number[] {
  const steps: number[] = [];
  for (const match of message.matchAll(/\[DONE:(\d+)\]/gi)) {
    const step = Number(match[1]);
    if (Number.isFinite(step)) steps.push(step);
  }
  return steps;
}

export function markCompletedSteps(text: string, items: TodoItem[]): number {
  const doneSteps = extractDoneSteps(text);
  for (const step of doneSteps) {
    const item = items.find((t) => t.step === step);
    if (item) item.completed = true;
  }
  return doneSteps.length;
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
