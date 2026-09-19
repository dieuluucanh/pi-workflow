/**
 * Workflow Extension — role-based command permissions.
 *
 * One place decides what a role may execute. Plan Mode (planner), Review Mode
 * (reviewer) and explorer subagents (explorer) share this policy; the Builder
 * role — and a normal Pi session with no workflow mode — is unrestricted.
 *
 * Command classes, weakest to strongest:
 *   read-only  inspection that never executes project code
 *   verify     read-only plus test/lint/typecheck runners (they execute code
 *              but do not modify tracked sources)
 *   full       unrestricted / unrecognised
 *
 * The module is deliberately dependency-free (no Pi / pi-tui imports) so it
 * stays loadable in plain Node tests, exactly like `utils.ts`.
 */

export type CommandClass = "read-only" | "verify" | "full";

export type WorkflowRole = "planner" | "reviewer" | "explorer" | "builder";

export interface RolePolicy {
  role: WorkflowRole;
  /** Highest command class the role may run. */
  commandClass: CommandClass;
  /** May the role use edit/write? (Plan Mode keeps its .pi/plans/ exception.) */
  canWrite: boolean;
  /** Human-readable summary used in refusal messages. */
  description: string;
}

/** Env var that carries a workflow role into a spawned `pi` subagent process. */
export const WORKFLOW_ROLE_ENV = "PI_WORKFLOW_ROLE";

const WORKFLOW_ROLES: readonly WorkflowRole[] = [
  "planner",
  "reviewer",
  "explorer",
  "builder",
];

export const ROLE_POLICIES: Record<WorkflowRole, RolePolicy> = {
  planner: {
    role: "planner",
    commandClass: "verify",
    canWrite: false,
    description: "read-only plus test/lint/typecheck commands",
  },
  reviewer: {
    role: "reviewer",
    commandClass: "verify",
    canWrite: false,
    description: "read-only plus test/lint/typecheck commands",
  },
  explorer: {
    role: "explorer",
    commandClass: "read-only",
    canWrite: false,
    description: "read-only commands only",
  },
  builder: {
    role: "builder",
    commandClass: "full",
    canWrite: true,
    description: "unrestricted",
  },
};

// ── Role helpers ─────────────────────────────────────────────────────

/** Case/space-tolerant role parser; undefined for anything unknown. */
export function normalizeRole(value: unknown): WorkflowRole | undefined {
  if (typeof value !== "string") return undefined;
  const v = value.trim().toLowerCase();
  return (WORKFLOW_ROLES as readonly string[]).includes(v)
    ? (v as WorkflowRole)
    : undefined;
}

export function isWorkflowRole(value: unknown): value is WorkflowRole {
  return normalizeRole(value) !== undefined;
}

export function policyForRole(role: WorkflowRole): RolePolicy {
  return ROLE_POLICIES[role] ?? ROLE_POLICIES.explorer;
}

/**
 * Resolve the role a session/tool call should be gated as.
 *
 * Env wins (a spawned subagent carries `PI_WORKFLOW_ROLE`), then the workflow
 * mode: plan → planner, build → builder. No mode and no env → undefined, i.e.
 * a normal Pi session with no extra gating.
 *
 * Call this lazily per tool call, not at extension load: `workflowMode` is
 * `null` while the extension body is evaluated and changes on Tab/mode switch.
 */
export function resolveSessionRole(input?: {
  envRole?: unknown;
  workflowMode?: string | null;
}): WorkflowRole | undefined {
  const fromEnv = normalizeRole(input?.envRole);
  if (fromEnv) return fromEnv;
  if (input?.workflowMode === "plan") return "planner";
  if (input?.workflowMode === "build") return "builder";
  return undefined;
}

/** Env for a spawned subagent: carries the role into the child `pi` process. */
export function subagentEnv(
  baseEnv: NodeJS.ProcessEnv,
  role: WorkflowRole | undefined,
): NodeJS.ProcessEnv {
  if (!role) return { ...baseEnv };
  return { ...baseEnv, [WORKFLOW_ROLE_ENV]: role };
}

// ── Command tables ───────────────────────────────────────────────────

/** Read-only executables (first word); anything needing context is special-cased. */
const READ_ONLY_EXECUTABLES = new Set<string>([
  "cat",
  "head",
  "tail",
  "less",
  "more",
  "bat",
  "tac",
  "nl",
  "rev",
  "fold",
  "fmt",
  "column",
  "cut",
  "tr",
  "wc",
  "uniq",
  "diff",
  "cmp",
  "comm",
  "join",
  "paste",
  "grep",
  "ag",
  "ack",
  "fd",
  "ls",
  "pwd",
  "tree",
  "eza",
  "du",
  "df",
  "stat",
  "file",
  "realpath",
  "basename",
  "dirname",
  "readlink",
  "which",
  "whereis",
  "type",
  "echo",
  "printf",
  "seq",
  "test",
  "[",
  "uname",
  "whoami",
  "id",
  "groups",
  "hostname",
  "date",
  "cal",
  "uptime",
  "ps",
  "top",
  "htop",
  "free",
  "md5sum",
  "sha1sum",
  "sha256sum",
  "sha512sum",
  "xxd",
  "hexdump",
  "strings",
  "cksum",
  "journalctl",
]);

/** Bare interpreters are never allowed for restricted roles (fail closed). */
const INTERPRETER_EXECUTABLES = new Set<string>([
  "sh",
  "bash",
  "dash",
  "zsh",
  "fish",
  "ksh",
  "csh",
  "tcsh",
  "pwsh",
  "powershell",
  "cmd",
  "cscript",
  "wscript",
  "perl",
  "ruby",
]);

/** Test runners that may be told to rewrite snapshots with `-u`/`-w`. */
const TEST_RUNNERS = new Set<string>([
  "vitest",
  "jest",
  "mocha",
  "ava",
  "pytest",
]);

const NPM_READ_ONLY_SUBCOMMANDS = new Set<string>([
  "list",
  "ls",
  "view",
  "info",
  "show",
  "search",
  "outdated",
  "audit",
  "why",
  "explain",
  "doctor",
  "ping",
  "fund",
  "repo",
  "bugs",
  "root",
  "prefix",
]);

const YARN_READ_ONLY_SUBCOMMANDS = new Set<string>([
  "list",
  "info",
  "why",
  "audit",
  "versions",
  "outdated",
]);

const PNPM_READ_ONLY_SUBCOMMANDS = new Set<string>([
  "list",
  "ls",
  "why",
  "outdated",
  "audit",
]);

const GIT_READ_ONLY_SUBCOMMANDS = new Set<string>([
  "status",
  "log",
  "diff",
  "show",
  "blame",
  "shortlog",
  "rev-parse",
  "rev-list",
  "describe",
  "for-each-ref",
  "reflog",
  "cat-file",
  "merge-base",
  "check-ignore",
  "check-attr",
  "count-objects",
  "name-rev",
  "whatchanged",
  "show-branch",
  "verify-commit",
  "verify-tag",
  "grep",
  "help",
  "version",
  "ls-files",
  "ls-tree",
  "ls-remote",
  "var",
]);

const GIT_BRANCH_BLOCKED_FLAGS = new Set<string>([
  "-d",
  "-D",
  "-m",
  "-M",
  "-c",
  "-C",
  "-u",
  "--delete",
  "--move",
  "--copy",
  "--edit-description",
  "--set-upstream-to",
  "--unset-upstream",
]);

const GIT_REMOTE_MUTATIONS = new Set<string>([
  "add",
  "remove",
  "rm",
  "set-url",
  "set-branches",
  "set-head",
  "rename",
  "prune",
  "update",
]);

const GIT_CONFIG_READ_FLAGS = new Set<string>([
  "--get",
  "--get-all",
  "--get-regexp",
  "--get-urlmatch",
  "--list",
  "-l",
]);

const GIT_CONFIG_WRITE_FLAGS = new Set<string>([
  "--add",
  "--unset",
  "--unset-all",
  "--replace-all",
  "--edit",
  "-e",
  "--rename-section",
  "--remove-section",
]);

const DOCKER_READ_ONLY_SUBCOMMANDS = new Set<string>([
  "ps",
  "images",
  "inspect",
  "logs",
  "version",
  "info",
  "history",
  "port",
  "diff",
]);

const SYSTEMCTL_READ_ONLY_SUBCOMMANDS = new Set<string>([
  "status",
  "show",
  "list-units",
  "list-unit-files",
  "is-active",
  "is-enabled",
  "is-failed",
  "cat",
  "help",
]);

const ALLOWED_SCRIPT_RE =
  /^(test|test[:._-].*|lint|lint[:._-].*|typecheck|type-check|tsc|check|check[:._-].*|format:check|format-check)$/i;

const BLOCKED_SCRIPT_SUFFIX_RE = /[:._-](fix|write)([:._-]|$)/i;

// ── Dangerous syntax / patterns ──────────────────────────────────────

/**
 * Hard denylist. Applied to the whole raw command (quote-insensitive, like the
 * original implementation) before any allowlist classification.
 *
 * The git entries are deliberately narrowed so the read-only forms the
 * allowlist exposes are actually reachable: `git tag -l` / `--list`,
 * `git stash list|show`, and `git config --get*|--list` must NOT match here.
 */
const DESTRUCTIVE_PATTERNS: RegExp[] = [
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
  /\bnpm\s+(install|uninstall|update|ci|link|publish|init|create|dedupe|prune|rebuild|pack)\b/i,
  /\byarn\s+(add|remove|install|publish|init|create|upgrade|dedupe|prune)\b/i,
  /\bpnpm\s+(add|remove|install|publish|init|create|upgrade|dedupe|prune)\b/i,
  /\bbun\s+(add|remove|install|publish|init|create|upgrade|link)\b/i,
  /\bpip[23]?\s+(install|uninstall|download|wheel)\b/i,
  /\bapt(-get)?\s+(install|remove|purge|update|upgrade)\b/i,
  /\bbrew\s+(install|uninstall|upgrade|reinstall)\b/i,
  /\bgit\s+(add|commit|push|pull|fetch|merge|rebase|reset|checkout|switch|restore|clean|gc|prune|cherry-pick|revert|init|clone|apply|am|update-ref|update-index|symbolic-ref|filter-branch|replace)\b/i,
  /\bgit\s+branch\s+(-[dDmMcC]|--delete|--move|--copy)\b/i,
  /\bgit\s+stash(?!\s+(?:list|show)\b)(?:\s|$)/i,
  /\bgit\s+tag\s+(?!--list\b|-l\b)\S+/i,
  /\bgit\s+remote\s+(add|remove|rm|set-url|set-branches|set-head|rename|prune|update)\b/i,
  /\bgit\s+worktree\s+(add|remove|prune|move|lock|unlock|repair)\b/i,
  /\bgit\s+reflog\s+(expire|delete)\b/i,
  /\bgit\s+submodule\s+(add|update|deinit|set-url|sync|absorbgitdirs)\b/i,
  /\bgit\s+notes\s+(add|remove|copy|append|edit|prune)\b/i,
  /\bsudo\b/i,
  /\bsu\b/i,
  /\bkill\b/i,
  /\bpkill\b/i,
  /\bkillall\b/i,
  /\breboot\b/i,
  /\bshutdown\b/i,
  /\bsystemctl\s+(start|stop|restart|enable|disable|mask|unmask|reload)\b/i,
  /\bservice\s+\S+\s+(start|stop|restart)/i,
  /\b(vim?|nano|emacs|code|subl)\b/i,
  /\bfind\b[^|;&]*\s-(delete|exec|execdir|ok|okdir|fprint\w*|fls)\b/i,
  /\bawk\b[^|;&]*\bsystem\s*\(/i,
  /(^|\s)(sh|bash|dash|zsh|fish|ksh|csh|tcsh|pwsh|powershell|cmd|cscript|wscript|perl|ruby)(\.exe)?(\s|$)/i,
];

/** Writing/formatting flags that must never reach a verify-class command. */
const DENIED_FLAG_RE =
  /(^|\s)(--fix|--fix-dry-run|--write|--update|--update-snapshots?|--updateSnapshot|--watch|--watchAll|--inspect|--inspect-brk|--in-place|--output)(\s|$|=)/i;

/** `-u` / `-w` only matter on snapshot-capable test runners. */
const TEST_RUNNER_UPDATE_RE = /(^|\s)(-u|-w)(\s|$)/;

const SORT_OUTPUT_RE = /(^|\s)-o(\s|=|$)/;
const IN_PLACE_RE = /(^|\s)(-i|--in-place)(\s|$)/;
const RG_PRE_RE = /(^|\s)--pre(=|\s)/;
const AWK_SYSTEM_RE = /\bsystem\s*\(/;
const FIND_DENIED_FLAG_RE =
  /(^|\s)-(delete|exec|execdir|ok|okdir|fprint\w*|fls)(\s|$)/;
const CURL_WRITE_RE =
  /(^|\s)(-o|-O|--output|--remote-name|--remote-header-name|-d|--data[^\s]*|-F|--form[^\s]*|-T|--upload-file)(\s|=|$)/;
const CURL_METHOD_RE = /(^|\s)-X\s*(POST|PUT|DELETE|PATCH|CONNECT)\b/i;

// ── Token helpers ────────────────────────────────────────────────────

function wordsOf(segment: string): string[] {
  return segment.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
}

function wordAt(segment: string, index: number): string | undefined {
  return wordsOf(segment)[index];
}

function unquote(token: string): string {
  return token.trim().replace(/^["']|["']$/g, "");
}

/** Normalise an executable token: drop dirs, quotes, and a trailing .exe/.cmd. */
function normalizeBinary(token: string): string {
  let t = unquote(token);
  const slash = Math.max(t.lastIndexOf("/"), t.lastIndexOf("\\"));
  if (slash >= 0) t = t.slice(slash + 1);
  t = t.toLowerCase();
  for (const ext of [".exe", ".cmd", ".bat", ".ps1"]) {
    if (t.endsWith(ext)) {
      t = t.slice(0, -ext.length);
      break;
    }
  }
  return t;
}

function firstWord(segment: string): string {
  return normalizeBinary(wordAt(segment, 0) ?? "");
}

/** Token-exact flag test (also matches `--flag=value`); no dynamic RegExp. */
function containsFlag(segment: string, flag: string): boolean {
  return wordsOf(segment).some(
    (w) => w === flag || w.startsWith(`${flag}=`),
  );
}

function isAllowedScript(rawScript: string | undefined): boolean {
  const script = unquote(String(rawScript ?? ""));
  if (!script) return false;
  if (!ALLOWED_SCRIPT_RE.test(script)) return false;
  if (BLOCKED_SCRIPT_SUFFIX_RE.test(script)) return false;
  return true;
}

// ── Shell syntax scanner ─────────────────────────────────────────────

/**
 * Reject syntax a prefix allowlist cannot reason about: command substitution,
 * process substitution, heredocs, `&>` and file redirection. `2>&1` / `1>&2`
 * are fd duplications, not file writes, so they are allowed.
 */
export function hasForbiddenSyntax(command: string): boolean {
  const withoutFd = command.replace(/\d*>&\d+/g, " ");
  const withoutAnd = withoutFd.replace(/&&/g, " ");
  if (withoutAnd.includes("&")) return true;
  if (command.includes("$(") || command.includes("`")) return true;
  if (command.includes("${")) return true;
  if (command.includes("<(") || command.includes(">(")) return true;
  if (command.includes("<<")) return true;
  if (/(^|[^<&])>(?!>|&)/.test(command)) return true;
  return false;
}

/**
 * Split a compound command on top-level `|`, `;`, `&&`, `||` and newlines.
 * Quote-aware: `grep -E 'a|b' f` stays one segment.
 */
export function splitCommandSegments(command: string): string[] {
  const segments: string[] = [];
  let current = "";
  let quote: '"' | "'" | undefined;
  let escaped = false;
  const push = (): void => {
    const s = current.trim();
    if (s) segments.push(s);
    current = "";
  };
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      current += ch;
      escaped = true;
      continue;
    }
    if (quote) {
      current += ch;
      if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === "\n" || ch === ";") {
      push();
      continue;
    }
    if (ch === "|") {
      push();
      if (command[i + 1] === "|") i++;
      continue;
    }
    if (ch === "&" && command[i + 1] === "&") {
      push();
      i++;
      continue;
    }
    current += ch;
  }
  push();
  return segments;
}

// ── Classification ───────────────────────────────────────────────────

/** Classify one already-split segment. Unknown input → `full` (fail closed). */
export function commandClassOf(segment: string): CommandClass {
  const s = String(segment ?? "").trim();
  if (!s) return "full";
  const first = firstWord(s);

  if (!first) return "full";
  if (INTERPRETER_EXECUTABLES.has(first)) return "full";

  if (first === "cd") {
    const args = wordsOf(s).slice(1);
    return args.length <= 1 && !args.some((a) => a.startsWith("-"))
      ? "read-only"
      : "full";
  }
  if (first === "npm" || first === "yarn" || first === "pnpm" || first === "bun")
    return classifyPackageManager(first, s);
  if (first === "git") return classifyGit(s);
  if (first === "docker") return classifyDocker(s);
  if (first === "systemctl") return classifySystemctl(s);
  if (first === "journalctl") return "read-only";
  if (first === "find")
    return FIND_DENIED_FLAG_RE.test(s) ? "full" : "read-only";
  if (first === "env") return isBareEnv(s) ? "read-only" : "full";
  if (first === "printenv") return "read-only";
  if (first === "node") return classifyNode(s);
  if (first === "python" || first === "python3" || first === "py")
    return classifyPython(s);
  if (first === "pip" || first === "pip3") return classifyPip(s);
  if (first === "go") return classifyGo(s);
  if (first === "cargo") return classifyCargo(s);
  if (first === "rustc")
    return containsFlag(s, "--version") || containsFlag(s, "-V")
      ? "read-only"
      : "full";
  if (first === "tsc") return containsFlag(s, "--noEmit") ? "verify" : "full";
  if (first === "prettier")
    return containsFlag(s, "--check") ? "verify" : "full";
  if (first === "black")
    return containsFlag(s, "--check") || containsFlag(s, "--diff")
      ? "verify"
      : "full";
  if (first === "gofmt")
    return containsFlag(s, "-l") || containsFlag(s, "-d") ? "verify" : "full";
  if (first === "ruff")
    return wordAt(s, 1)?.toLowerCase() === "check" ? "verify" : "full";
  if (first === "eslint") return "verify";
  if (TEST_RUNNERS.has(first))
    return TEST_RUNNER_UPDATE_RE.test(s) ? "full" : "verify";
  if (first === "mypy" || first === "flake8") return "verify";
  if (first === "sort") return SORT_OUTPUT_RE.test(s) ? "full" : "read-only";
  if (first === "jq" || first === "yq")
    return IN_PLACE_RE.test(s) ? "full" : "read-only";
  if (first === "rg") return RG_PRE_RE.test(s) ? "full" : "read-only";
  if (first === "wget")
    return wordAt(s, 1) === "-O" && wordAt(s, 2) === "-" ? "read-only" : "full";
  if (first === "sed") return wordAt(s, 1) === "-n" ? "read-only" : "full";
  if (first === "awk") return AWK_SYSTEM_RE.test(s) ? "full" : "read-only";
  if (first === "curl")
    return CURL_WRITE_RE.test(s) || CURL_METHOD_RE.test(s)
      ? "full"
      : "read-only";
  if (READ_ONLY_EXECUTABLES.has(first)) return "read-only";
  return "full";
}

function classifyPackageManager(bin: string, s: string): CommandClass {
  const sub = wordAt(s, 1)?.toLowerCase();
  if (!sub) return "full";
  if (sub === "test") return "verify";
  if (sub === "run" && isAllowedScript(wordAt(s, 2))) return "verify";
  if (
    sub === "config" &&
    ["get", "list"].includes(wordAt(s, 2)?.toLowerCase() ?? "")
  )
    return "read-only";
  if (bin === "npm") {
    if (sub === "pkg" && wordAt(s, 2)?.toLowerCase() === "get")
      return "read-only";
    return NPM_READ_ONLY_SUBCOMMANDS.has(sub) ? "read-only" : "full";
  }
  if (bin === "yarn")
    return YARN_READ_ONLY_SUBCOMMANDS.has(sub) ? "read-only" : "full";
  if (bin === "pnpm") {
    if (
      sub === "licenses" &&
      wordAt(s, 2)?.toLowerCase() === "list"
    )
      return "read-only";
    return PNPM_READ_ONLY_SUBCOMMANDS.has(sub) ? "read-only" : "full";
  }
  // bun
  if (sub === "pm" && wordAt(s, 2)?.toLowerCase() === "ls")
    return "read-only";
  return "full";
}

function classifyGit(s: string): CommandClass {
  const words = wordsOf(s);
  let i = 1;
  while (i < words.length) {
    const w = words[i];
    if (w === "-C" || w === "-c") {
      i += 2;
      continue;
    }
    if (
      w === "--no-pager" ||
      w === "--no-optional-locks" ||
      w === "--literal-pathspecs"
    ) {
      i += 1;
      continue;
    }
    break;
  }
  const sub = (words[i] ?? "").toLowerCase();
  if (!sub) return "full";
  const rest = words.slice(i + 1);

  if (sub === "branch") {
    const blocked = rest.some(
      (w) =>
        GIT_BRANCH_BLOCKED_FLAGS.has(w) ||
        w.startsWith("--set-upstream-to="),
    );
    return blocked ? "full" : "read-only";
  }
  if (sub === "remote")
    return rest.some((w) => GIT_REMOTE_MUTATIONS.has(w.toLowerCase()))
      ? "full"
      : "read-only";
  if (sub === "config") {
    const flags = rest.filter((w) => w.startsWith("-"));
    const hasRead = flags.some(
      (f) =>
        GIT_CONFIG_READ_FLAGS.has(f) ||
        f.startsWith("--get=") ||
        f.startsWith("--get-regexp="),
    );
    const hasWrite = flags.some((f) => GIT_CONFIG_WRITE_FLAGS.has(f));
    return hasRead && !hasWrite ? "read-only" : "full";
  }
  if (sub === "tag")
    return rest.length === 0 ||
      rest.some((w) => w === "-l" || w === "--list")
      ? "read-only"
      : "full";
  if (sub === "stash") {
    const a = (rest[0] ?? "").toLowerCase();
    return a === "list" || a === "show" ? "read-only" : "full";
  }
  if (sub === "worktree") {
    const a = (rest[0] ?? "").toLowerCase();
    return a === "list" ? "read-only" : "full";
  }
  return GIT_READ_ONLY_SUBCOMMANDS.has(sub) ? "read-only" : "full";
}

function classifyDocker(s: string): CommandClass {
  const sub = wordAt(s, 1)?.toLowerCase();
  if (!sub) return "full";
  if (sub === "compose") {
    const a = wordAt(s, 2)?.toLowerCase();
    return ["ps", "logs", "config", "images", "version"].includes(a ?? "")
      ? "read-only"
      : "full";
  }
  return DOCKER_READ_ONLY_SUBCOMMANDS.has(sub) ? "read-only" : "full";
}

function classifySystemctl(s: string): CommandClass {
  const sub = wordAt(s, 1)?.toLowerCase();
  return SYSTEMCTL_READ_ONLY_SUBCOMMANDS.has(sub ?? "")
    ? "read-only"
    : "full";
}

function isBareEnv(s: string): boolean {
  const rest = wordsOf(s).slice(1);
  if (rest.length === 0) return true;
  return rest.every((w) => /^-{1,2}[A-Za-z0-9-]+$/.test(w));
}

function classifyNode(s: string): CommandClass {
  const a = wordAt(s, 1)?.toLowerCase();
  if (!a) return "full";
  if (a === "--version" || a === "-v") return "read-only";
  if (a === "--test" || a.startsWith("--test-")) return "verify";
  if (a === "--check") return "verify";
  return "full";
}

function classifyPython(s: string): CommandClass {
  const a = wordAt(s, 1)?.toLowerCase();
  if (!a) return "full";
  if (a === "--version" || a === "-v" || a === "-V") return "read-only";
  if (a === "-m") {
    const mod = wordAt(s, 2)?.toLowerCase();
    if (
      mod === "pytest" ||
      mod === "unittest" ||
      mod === "mypy" ||
      mod === "flake8"
    )
      return "verify";
    if (
      mod === "black" &&
      (containsFlag(s, "--check") || containsFlag(s, "--diff"))
    )
      return "verify";
    if (mod === "ruff" && wordAt(s, 3)?.toLowerCase() === "check")
      return "verify";
    if (
      mod === "pip" &&
      ["list", "show", "freeze", "check"].includes(
        wordAt(s, 3)?.toLowerCase() ?? "",
      )
    )
      return "read-only";
  }
  return "full";
}

function classifyPip(s: string): CommandClass {
  const sub = wordAt(s, 1)?.toLowerCase();
  if (sub === "--version" || sub === "-V") return "read-only";
  if (sub && ["list", "show", "freeze", "check"].includes(sub))
    return "read-only";
  return "full";
}

function classifyGo(s: string): CommandClass {
  const sub = wordAt(s, 1)?.toLowerCase();
  if (sub === "version") return "read-only";
  if (sub === "env")
    return /(^|\s)-[wu](\s|$)/.test(s) ? "full" : "read-only";
  if (sub === "test" || sub === "vet") return "verify";
  return "full";
}

function classifyCargo(s: string): CommandClass {
  const sub = wordAt(s, 1)?.toLowerCase();
  if (sub === "--version" || sub === "-V") return "read-only";
  if (sub === "test" || sub === "check" || sub === "clippy") return "verify";
  if (sub === "fmt") return containsFlag(s, "--check") ? "verify" : "full";
  if (sub === "metadata" || sub === "tree" || sub === "locate-project")
    return "read-only";
  return "full";
}

// ── Public gate ──────────────────────────────────────────────────────

/** True when a segment is denied outright (destructive syntax or writing flags). */
export function isDestructiveCommand(command: string): boolean {
  return (
    DESTRUCTIVE_PATTERNS.some((p) => p.test(command)) ||
    DENIED_FLAG_RE.test(command)
  );
}

function classAllows(policyClass: CommandClass, needed: CommandClass): boolean {
  if (policyClass === "full") return true;
  if (policyClass === "verify") return needed === "read-only" || needed === "verify";
  return needed === "read-only";
}

/**
 * The single gate. `builder` (and callers with no role) is unrestricted; every
 * other role must pass the destructive denylist and have every top-level
 * segment classified inside its allowed classes. Fails closed.
 */
export function isCommandAllowedForRole(
  role: WorkflowRole,
  command: unknown,
): boolean {
  const policy = policyForRole(role);
  const raw = typeof command === "string" ? command.trim() : "";
  if (!raw) return policy.commandClass === "full";
  if (policy.commandClass === "full") return true;
  if (hasForbiddenSyntax(raw)) return false;
  if (isDestructiveCommand(raw)) return false;
  const segments = splitCommandSegments(raw);
  if (segments.length === 0) return false;
  return segments.every((segment) =>
    classAllows(policy.commandClass, commandClassOf(segment)),
  );
}

/** One-line policy summary for refusal messages. */
export function describeRolePolicy(role: WorkflowRole): string {
  const policy = policyForRole(role);
  return `${policy.role} may run ${policy.description}`;
}
