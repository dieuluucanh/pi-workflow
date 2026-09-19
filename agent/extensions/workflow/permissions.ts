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
  "base64",
  "man",
  "ss",
  "netstat",
  "lsof",
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
  "show-ref",
  "check-ref-format",
  "diff-tree",
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
  /(^|\s)(--fix|--fix-dry-run|--write|--update|--update-snapshots?|--updateSnapshot|--test-update-snapshots|--watch|--watchAll|--inspect|--inspect-brk|--in-place|--output)(\s|$|=)/i;

/**
 * Snapshot/update and watch flags. Applied to bare test runners and to
 * test-shaped package-manager invocations (`npm test -- -u`,
 * `node --test --test-update-snapshots`, `go test -update`), which is where a
 * verify-class command can still rewrite tracked files.
 */
const TEST_UPDATE_FLAG_RE =
  /(^|\s)(-u|-w|-update|--update|--test-update-snapshots)(\s|$)/;

/** Flags that take an arbitrary output path — never allowed for verify tools. */
const ARBITRARY_OUTPUT_FLAG_RE =
  /(^|\s)(--output-file|--outputFile|--output-dir)(\s|$|=)/;

/** pytest flags that write to a chosen path or clear caches. */
const PYTEST_OUTPUT_FLAG_RE =
  /(^|\s)(--junit-xml|--junitxml|--cache-clear)(\s|$|=)/;

/** `go test`/`go vet` flags that execute a program or write a chosen path. */
const GO_EXEC_FLAG_RE =
  /(^|\s)(-exec|--exec|-vettool|-o|-coverprofile|-cpuprofile|-memprofile|-blockprofile|-mutexprofile|-trace)(\s|$|=)/;

/** mypy/ruff flags that install packages or rewrite sources. */
const MYPY_DENY_FLAG_RE = /(^|\s)--install-types(\s|$|=)/;
const RUFF_NOQA_FLAG_RE = /(^|\s)--add-noqa(\s|$|=)/;

const SORT_OUTPUT_RE = /(^|\s)-o(\s|=|$)/;
const IN_PLACE_RE = /(^|\s)(-i|--in-place)(\s|$)/;
const RG_PRE_RE = /(^|\s)--pre(=|\s)/;
const FIND_DENIED_FLAG_RE =
  /(^|\s)-(delete|exec|execdir|ok|okdir|fprint\w*|fls)(\s|$)/;
const CURL_WRITE_RE =
  /(^|\s)(-o|-O|--output|--output-dir|--remote-name|--remote-header-name|-d|--data[^\s]*|-F|--form[^\s]*|--json|-T|--upload-file)(\s|=|$)/;
const CURL_METHOD_RE =
  /(^|\s)(-X\s*|--request[=\s]+)(POST|PUT|DELETE|PATCH|CONNECT)\b/i;

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

/**
 * True when a tool is being told where to write (`eslint -o out`, jest's
 * `--outputFile=x`). Deliberately not global: `grep -o` / `rg -o` mean
 * "only matching" and are read-only flags.
 */
function hasArbitraryOutputFlag(segment: string): boolean {
  if (ARBITRARY_OUTPUT_FLAG_RE.test(segment)) return true;
  return wordsOf(segment).some(
    (w) => w === "-o" || (w.startsWith("-o") && w.length > 2 && !w.startsWith("--")),
  );
}

/**
 * The script argument of `npm run …` / `yarn run …` (index 2 onward), skipping
 * flags and stopping at a `--` separator. `undefined` means no script was
 * named, which is the read-only "list scripts" form.
 */
function packageScriptArg(segment: string): string | undefined {
  const words = wordsOf(segment).slice(2);
  const sep = words.indexOf("--");
  const candidates = sep >= 0 ? words.slice(0, sep) : words;
  return candidates.find((w) => !w.startsWith("-"));
}

// ── Shell syntax scanner ─────────────────────────────────────────────

/**
 * A redirection whose target is the null device: an optional fd or `&`,
 * followed by `>` / `>>` and exactly `/dev/null`. Discarding output is not a
 * file write, so these are subtracted before the file-redirect check. The
 * lookahead keeps the match to a complete token — `/dev/null.txt`,
 * `/dev/nullx` and `/dev/null/../f` are real files and must not be scrubbed.
 */
const NULL_DEVICE_REDIRECT_RE =
  /(^|[\s;&|()])(?:[12]|&)?>>?\s*\/dev\/null(?=$|[\s;&|)])/g;

/**
 * Why a command's syntax cannot be classified (`null` = the syntax is fine).
 * Mirrors the order the gate has always used, so a refusal can name the first
 * failing construct instead of only saying "blocked".
 */
export function forbiddenSyntaxReason(command: unknown): string | null {
  const raw = typeof command === "string" ? command : "";
  // `2>&1` / `1>&2` are fd duplications, not file writes; `/dev/null` targets
  // are a bit bucket, not a file.
  const scrubbed = raw
    .replace(/\d*>&\d+/g, " ")
    .replace(NULL_DEVICE_REDIRECT_RE, "$1");
  if (scrubbed.replace(/&&/g, " ").includes("&"))
    return "a background `&` (only `&&` chains are allowed)";
  if (raw.includes("$(")) return "command substitution `$(...)`";
  if (raw.includes("`")) return "backtick command substitution";
  if (raw.includes("${")) return "parameter expansion `${...}`";
  if (raw.includes("<(") || raw.includes(">("))
    return "process substitution `<(...)` / `>(...)`";
  if (raw.includes("<<")) return "a heredoc `<<`";
  if (/(^|[^<&])>(?!>|&)/.test(scrubbed))
    return "a file redirect (`>` / `>>`); only `/dev/null` and `2>&1` are allowed";
  return null;
}

/**
 * Reject syntax a prefix allowlist cannot reason about: command substitution,
 * process substitution, heredocs, background `&` and file redirection.
 * Redirections to `/dev/null` and fd duplications (`2>&1` / `1>&2`) are
 * allowed: neither writes a file the user can see.
 */
export function hasForbiddenSyntax(command: string): boolean {
  return forbiddenSyntaxReason(command) !== null;
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
    return wordAt(s, 1)?.toLowerCase() === "check" &&
      !RUFF_NOQA_FLAG_RE.test(s)
      ? "verify"
      : "full";
  if (first === "eslint")
    return hasArbitraryOutputFlag(s) ? "full" : "verify";
  if (TEST_RUNNERS.has(first)) {
    if (TEST_UPDATE_FLAG_RE.test(s) || ARBITRARY_OUTPUT_FLAG_RE.test(s))
      return "full";
    if (first === "pytest" && PYTEST_OUTPUT_FLAG_RE.test(s)) return "full";
    return "verify";
  }
  if (first === "mypy") return MYPY_DENY_FLAG_RE.test(s) ? "full" : "verify";
  if (first === "flake8") return "verify";
  if (first === "sort") return SORT_OUTPUT_RE.test(s) ? "full" : "read-only";
  if (first === "jq" || first === "yq")
    return IN_PLACE_RE.test(s) ? "full" : "read-only";
  if (first === "rg") return RG_PRE_RE.test(s) ? "full" : "read-only";
  if (first === "wget")
    return wordAt(s, 1) === "-O" && wordAt(s, 2) === "-" ? "read-only" : "full";
  // `sed`/`awk` are deliberately NOT read-only: their programs are code (GNU
  // sed's `e` command runs a shell command; awk can pipe to a command, write
  // files or load a library). They fall through to `full`, so only Builder
  // keeps them. Use rg/head/tail/cut/column/jq instead.
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
  const script = packageScriptArg(s);
  // `npm test -- -u` and `npm run test -- -u` forward the snapshot-update flag
  // to the runner; the bare runner would be refused, so refuse the wrapper too.
  const testShaped =
    sub === "test" || (sub === "run" && isAllowedScript(script));
  if (testShaped && TEST_UPDATE_FLAG_RE.test(s)) return "full";
  if (sub === "test") return "verify";
  if (sub === "run") {
    if (isAllowedScript(script)) return "verify";
    // `npm run` with no script argument lists the scripts — a read.
    if (script === undefined) return "read-only";
  }
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
    if (w === "-C") {
      i += 2;
      continue;
    }
    // `-c <key>=<value>` sets config for one invocation, and config values can
    // select programs git executes (core.fsmonitor, core.pager,
    // credential.helper, diff.external). Restricted roles must not reach it.
    if (w === "-c") return "full";
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
  if (a === "--test" || a.startsWith("--test-"))
    return TEST_UPDATE_FLAG_RE.test(s) ? "full" : "verify";
  if (a === "--check") return "verify";
  // `node --run <script>` executes a package script: same gate as `npm run`.
  if (a === "--run") {
    if (TEST_UPDATE_FLAG_RE.test(s)) return "full";
    return isAllowedScript(wordAt(s, 2)) ? "verify" : "full";
  }
  return "full";
}

function classifyPython(s: string): CommandClass {
  const a = wordAt(s, 1)?.toLowerCase();
  if (!a) return "full";
  if (a === "--version" || a === "-v" || a === "-V") return "read-only";
  if (a === "-m") {
    const mod = wordAt(s, 2)?.toLowerCase();
    if (mod === "pytest" || mod === "unittest")
      return PYTEST_OUTPUT_FLAG_RE.test(s) ? "full" : "verify";
    if (mod === "mypy") return MYPY_DENY_FLAG_RE.test(s) ? "full" : "verify";
    if (mod === "flake8") return "verify";
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
  if (sub === "test" || sub === "vet")
    return GO_EXEC_FLAG_RE.test(s) ? "full" : "verify";
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

/**
 * The first destructive pattern (or writing flag) that matches, with the exact
 * text that matched so a refusal can name it (`rm`, `npm install`, `--fix`).
 */
function destructiveMatch(
  command: string,
): { kind: "destructive-pattern" | "blocked-flag"; label: string } | undefined {
  const hit = DESTRUCTIVE_PATTERNS.find((p) => p.test(command));
  if (hit) {
    const matched = command.match(hit)?.[0]?.trim() ?? "destructive keyword";
    return { kind: "destructive-pattern", label: `\`${matched}\`` };
  }
  const flag = command.match(DENIED_FLAG_RE);
  if (flag)
    return {
      kind: "blocked-flag",
      label: `the flag \`${flag[2] ?? flag[0].trim()}\``,
    };
  return undefined;
}

/** True when a segment is denied outright (destructive syntax or writing flags). */
export function isDestructiveCommand(command: string): boolean {
  return destructiveMatch(command) !== undefined;
}

function classAllows(policyClass: CommandClass, needed: CommandClass): boolean {
  if (policyClass === "full") return true;
  if (policyClass === "verify") return needed === "read-only" || needed === "verify";
  return needed === "read-only";
}

/** Structured explanation of the first policy violation. */
export interface CommandRefusal {
  kind:
    | "empty"
    | "forbidden-syntax"
    | "destructive-pattern"
    | "blocked-flag"
    | "segment-class";
  /** One-line, user-facing cause. */
  detail: string;
  /** The offending segment, when the failure is segment-scoped. */
  segment?: string;
  /** What to do instead. */
  suggestion?: string;
}

/**
 * The single source of truth for the gate: `null` means allowed. Keeping the
 * decision and the explanation in one function stops a refusal message from
 * describing a policy the gate no longer enforces.
 */
export function explainCommandRefusal(
  role: WorkflowRole,
  command: unknown,
): CommandRefusal | null {
  const policy = policyForRole(role);
  const raw = typeof command === "string" ? command.trim() : "";
  if (!raw)
    return policy.commandClass === "full"
      ? null
      : { kind: "empty", detail: "the command is empty" };
  if (policy.commandClass === "full") return null;

  const syntax = forbiddenSyntaxReason(raw);
  if (syntax)
    return {
      kind: "forbidden-syntax",
      detail: `forbidden shell syntax: ${syntax}`,
      suggestion: syntax.includes("redirect")
        ? "drop the redirect — `cmd` already captures stdout and `cmd 2>&1` also captures stderr; only `2>/dev/null` and `2>&1` are exempt"
        : "use an allowlisted read-only/verify command, or /build for full shell access",
    };

  const destructive = destructiveMatch(raw);
  if (destructive)
    return {
      kind: destructive.kind,
      detail: `${destructive.label} matched the raw command text (quoting does not exempt it)`,
      suggestion:
        "remove or rename the argument, or use /build for unrestricted access",
    };

  const segments = splitCommandSegments(raw);
  if (segments.length === 0)
    return { kind: "empty", detail: "no command segments found" };
  for (const segment of segments) {
    const needed = commandClassOf(segment);
    if (classAllows(policy.commandClass, needed)) continue;
    const head = firstWord(segment) || segment.slice(0, 40);
    return {
      kind: "segment-class",
      detail: `\`${head}\` needs ${needed === "full" ? "unrestricted" : needed} access, above the ${policy.commandClass} limit`,
      segment,
      suggestion: `${policy.role} may run ${policy.description}; see README "Permissions" for allowlisted alternatives, or use /build`,
    };
  }
  return null;
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
  return explainCommandRefusal(role, command) === null;
}

/** One-line policy summary for refusal messages. */
export function describeRolePolicy(role: WorkflowRole): string {
  const policy = policyForRole(role);
  return `${policy.role} may run ${policy.description}`;
}
