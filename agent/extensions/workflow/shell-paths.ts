/**
 * Workflow Extension — Shell path analysis
 *
 * One quote-aware extraction of the file paths a shell command READS and
 * WRITES. The read policy consumes `reads`; the write policy consumes
 * `writes`; the commit policy consumes `git`.
 *
 * WHY THIS EXISTS: command policy used to answer "may this write?" without
 * knowing WHICH files a command touches. `cp ../.env ./x` was just "mutating".
 * The folder floor needs concrete targets. This module is deliberately
 * conservative: it extracts what it can prove, marks interpreters and
 * unparseable constructs as `uncertain`, and leaves unknown write commands to
 * the write policy (a documented residual — this is not a sandbox).
 *
 * Pure: imports only `permissions.ts` / `shell-text.ts` and path helpers from
 * `folder-policy.ts`; no Pi SDK, no filesystem reads beyond normalisation.
 */

import {
  analyzeCommand,
  type SegmentAnalysis,
} from "./permissions.ts";
import type { ShellRedirect, ShellWord } from "./shell-text.ts";
import {
  type FolderTarget,
  normalizePolicyPath,
} from "./folder-policy.ts";
import { translateMsysTempPath } from "./utils.ts";

export type ShellPathFamily = "posix" | "powershell" | "cmd";

export interface ShellPathOptions {
  /** MSYS `/tmp` translation is a POSIX-shell concern (default: "posix"). */
  family?: ShellPathFamily;
}

export type GitCommitHit = "add" | "commit" | "push";

export interface GitScope {
  hit: GitCommitHit;
  /** Canonical-ish working/repository root implied by -C/--git-dir/-work-tree. */
  repoRoot: string;
  /** Explicit path operands (add/commit/checkout/restore/switch). */
  explicitPaths: string[];
  /** `git add .` / `-A` / `--all` — the caller must scan the worktree. */
  allPaths: boolean;
  amend: boolean;
  /** True when no explicit root flag was given (repo is cwd's repository). */
  usesCwd: boolean;
}

export interface ShellPathAnalysis {
  reads: FolderTarget[];
  writes: FolderTarget[];
  git?: GitScope;
  /** Reasons the command could not be statically verified. */
  uncertain: string[];
}

const READ_COMMANDS = new Set([
  "cat",
  "tac",
  "head",
  "tail",
  "less",
  "more",
  "bat",
  "batcat",
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
  "egrep",
  "fgrep",
  "rg",
  "ag",
  "ack",
  "fd",
  "fdfind",
  "find",
  "ls",
  "tree",
  "eza",
  "du",
  "stat",
  "file",
  "realpath",
  "readlink",
  "xxd",
  "hexdump",
  "strings",
  "md5sum",
  "sha1sum",
  "sha256sum",
  "sha512sum",
  "cksum",
  "base64",
  "jq",
  "yq",
  "zcat",
  "bzcat",
  "xzcat",
  "zipinfo",
  "ffmpeg",
  "openssl",
]);

const WRITE_COMMANDS = new Set([
  "tee",
  "mkdir",
  "rmdir",
  "rm",
  "touch",
  "truncate",
  "chmod",
  "chown",
  "ln",
  "cp",
  "mv",
  "install",
  "rsync",
  "scp",
  "dd",
]);

const WRAPPERS = new Set([
  "env",
  "nice",
  "time",
  "timeout",
  "nohup",
  "stdbuf",
  "command",
  "builtin",
  "sudo",
]);

const SHELLS = new Set([
  "sh",
  "bash",
  "dash",
  "zsh",
  "fish",
  "ksh",
  "pwsh",
  "powershell",
  "cmd",
]);

const INTERPRETERS = new Set([
  "node",
  "python",
  "python3",
  "perl",
  "ruby",
  "php",
]);

const POWERSHELL_READS = new Set([
  "get-content",
  "gc",
  "select-string",
  "sls",
  "get-childitem",
  "gci",
  "get-item",
  "gi",
  "resolve-path",
  "rvpa",
  "test-path",
  "findstr",
  "type",
  "dir",
]);

const POWERSHELL_WRITES = new Set([
  "set-content",
  "add-content",
  "clear-content",
  "out-file",
  "new-item",
  "remove-item",
  "copy-item",
  "move-item",
  "rename-item",
  "copy",
  "move",
  "del",
  "erase",
  "md",
  "rd",
]);

function values(words: readonly ShellWord[]): string[] {
  return words.map((word) => word.value);
}

function isFlag(value: string): boolean {
  return value.startsWith("-") && value !== "-";
}

function looksLikeOptionValue(flag: string): boolean {
  return /^-[A-Za-z]$/.test(flag) || /^--[^=]+$/.test(flag);
}

function dedupeTargets(targets: FolderTarget[]): FolderTarget[] {
  const seen = new Set<string>();
  const out: FolderTarget[] = [];
  for (const target of targets) {
    const key = `${target.kind}\0${target.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(target);
  }
  return out;
}

/**
 * Extract read/write targets and, for git add/commit/push, the scope the
 * commit policy needs. Total: non-strings produce an empty analysis.
 */
export function analyzeShellPaths(
  command: unknown,
  cwd: string,
  options: ShellPathOptions = {},
): ShellPathAnalysis {
  const analysis: ShellPathAnalysis = {
    reads: [],
    writes: [],
    uncertain: [],
  };
  if (typeof command !== "string" || !command.trim()) return analysis;
  const parsed = analyzeCommand(command);
  let virtualCwd = normalizePolicyPath(cwd, cwd);
  const family = options.family ?? "posix";
  const translate = (value: string): string =>
    family === "posix" ? translateMsysTempPath(value, { cwd }) : value;
  const normalizeShellPath = (value: string, base = virtualCwd): string =>
    normalizePolicyPath(translate(value), base);

  // Best-effort command substitution: `echo $(cat ../x)` / backticks. Only
  // simple, non-nested bodies are parsed; the rest stays uncertain.
  for (const match of command.matchAll(/\$\(([^()]*)\)|`([^`]*)`/g)) {
    const inner = (match[1] ?? match[2] ?? "").trim();
    if (!inner) continue;
    const nested = analyzeShellPaths(inner, virtualCwd, { family });
    for (const target of nested.reads) analysis.reads.push(target);
    for (const target of nested.writes) analysis.writes.push(target);
    for (const reason of nested.uncertain) analysis.uncertain.push(reason);
    if (nested.git) analysis.git = nested.git;
  }

  const addRead = (value: string, kind: FolderTarget["kind"] = "file") => {
    const normalized = normalizeShellPath(value);
    if (!normalized || normalized === "-") return;
    if (/^\d+$/.test(normalized)) return;
    if (normalized.endsWith("/dev/null") || normalized.endsWith("/dev/stdin"))
      return;
    if (normalized.endsWith("/dev/stdout") || normalized.endsWith("/dev/stderr"))
      return;
    analysis.reads.push({ path: normalized, kind });
  };
  const addWrite = (value: string, kind: FolderTarget["kind"] = "file") => {
    const normalized = normalizeShellPath(value);
    if (!normalized || normalized === "-") return;
    if (normalized.endsWith("/dev/null")) return;
    analysis.writes.push({ path: normalized, kind });
  };

  for (const segment of parsed.segments) {
    analyzeSegment(segment, {
      analysis,
      addRead,
      addWrite,
      family,
      normalizePath: (value: string) => normalizeShellPath(value),
      get cwd() {
        return virtualCwd;
      },
      set cwd(value: string) {
        virtualCwd = value;
      },
    });
  }

  analysis.reads = dedupeTargets(analysis.reads);
  analysis.writes = dedupeTargets(analysis.writes);
  return analysis;
}

interface SegmentContext {
  analysis: ShellPathAnalysis;
  cwd: string;
  family: ShellPathFamily;
  /** Translate + normalize one shell path against the current cwd. */
  normalizePath: (value: string) => string;
  addRead: (value: string, kind?: FolderTarget["kind"]) => void;
  addWrite: (value: string, kind?: FolderTarget["kind"]) => void;
}

function analyzeSegment(segment: SegmentAnalysis, ctx: SegmentContext): void {
  for (const redirect of segment.redirects) {
    if (!redirect.target) continue;
    const op = redirect.op;
    if (op === "<" || op === "<<<" || op === "<&") {
      if (op === "<") ctx.addRead(redirect.target);
      continue;
    }
    if (op === ">" || op === ">>" || op === "&>" || op === "&>>" || op === "2>") {
      ctx.addWrite(redirect.target);
    }
  }

  let words = values(segment.words);
  let command = segment.command;
  if (!command) return;

  if (command === "cd") {
    const target = words.slice(1).find((word) => !isFlag(word));
    if (!target) {
      if (words.length > 1 && words[1] === "-") ctx.analysis.uncertain.push("cd -");
      return;
    }
    if (/\$|%|`/.test(target)) {
      ctx.analysis.uncertain.push(`cd ${target}`);
      return;
    }
    const next = ctx.normalizePath(target);
    if (next) ctx.cwd = next;
    return;
  }
  if (command === "pushd" || command === "popd") {
    ctx.analysis.uncertain.push(command);
    return;
  }

  // Strip wrappers and leading VAR=value assignments.
  let guard = 0;
  while (guard++ < 8) {
    const stripped = stripWrappersAndAssignments(words);
    if (stripped.length === words.length) break;
    words = stripped;
    command = baseCommand(words[0] ?? "");
  }

  if (command === "git") {
    analyzeGit(words, ctx);
    return;
  }
  if (POWERSHELL_READS.has(command)) {
    analyzePowerShellRead(words, ctx);
    return;
  }
  if (POWERSHELL_WRITES.has(command)) {
    analyzePowerShellWrite(words, ctx, command);
    return;
  }
  if (command === "grep" || command === "egrep" || command === "fgrep" || command === "rg" || command === "ag" || command === "ack") {
    analyzeGrep(words, ctx);
    return;
  }
  if (command === "find") {
    analyzeFind(words, ctx);
    return;
  }
  if (command === "sed") {
    analyzeSed(words, ctx);
    return;
  }
  if (command === "awk") {
    analyzeAwk(words, ctx);
    return;
  }
  if (command === "tar") {
    analyzeTar(words, ctx);
    return;
  }
  if (command === "unzip" || command === "7z" || command === "zipinfo") {
    analyzeArchive(words, ctx, command);
    return;
  }
  if (command === "curl" || command === "wget") {
    analyzeCurl(words, ctx);
    return;
  }
  if (command === "cp" || command === "mv" || command === "install" || command === "rsync" || command === "scp") {
    analyzeCopy(words, ctx, command);
    return;
  }
  if (READ_COMMANDS.has(command)) {
    analyzeReadCommand(words, ctx, command);
    return;
  }
  if (WRITE_COMMANDS.has(command)) {
    analyzeWriteCommand(words, ctx, command);
    return;
  }
  if (command === "tee") {
    for (const word of words.slice(1)) if (!isFlag(word)) ctx.addWrite(word);
    return;
  }
  if (SHELLS.has(command)) {
    analyzeShell(words, ctx, command);
    return;
  }
  if (INTERPRETERS.has(command)) {
    analyzeInterpreter(words, ctx, command);
    return;
  }
  if (command === "source" || command === ".") {
    const target = words.slice(1).find((word) => !isFlag(word));
    if (target) ctx.addRead(target);
    return;
  }
  if (command === "eval" || command === "exec") {
    ctx.analysis.uncertain.push(command);
    return;
  }
  if (command === "xargs") {
    ctx.analysis.uncertain.push("xargs (paths arrive on stdin)");
    return;
  }
  if (["npm", "npx", "pnpm", "yarn", "bun"].includes(command)) {
    ctx.analysis.uncertain.push(
      `${command} scripts can read/write arbitrary paths`,
    );
  }

  // Unknown command: only flag operands that are obviously sensitive. This
  // catches `some-tool .env` without mistaking every write destination for a
  // read. The folder floor / write mode still governs the rest.
  if (segment.commandClass === "full") {
    ctx.analysis.uncertain.push(`${command} (cannot be statically classified)`);
  }
  for (const word of words.slice(1)) {
    if (isFlag(word) || word === "-") continue;
    const normalized = normalizePolicyPath(word, ctx.cwd);
    if (looksSensitiveOperand(normalized)) ctx.addRead(word);
  }
}

function baseCommand(value: string): string {
  const normalized = value.replace(/\\/g, "/");
  const name = normalized.split("/").pop() ?? normalized;
  return name.toLowerCase().replace(/\.(exe|cmd|bat|ps1)$/i, "");
}

function stripWrappersAndAssignments(words: string[]): string[] {
  let index = 0;
  while (index < words.length) {
    const word = words[index];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) {
      index++;
      continue;
    }
    if (!WRAPPERS.has(baseCommand(word))) break;
    const command = baseCommand(word);
    index++;
    while (index < words.length && isFlag(words[index])) {
      const flag = words[index];
      index++;
      if (looksLikeOptionValue(flag) && index < words.length && !words[index].startsWith("-")) {
        // Wrapper option values: nice -n 5, timeout 30, sudo -u user.
        if (command === "nice" && flag === "-n") index++;
        else if (command === "timeout") index++;
        else if (command === "sudo" && (flag === "-u" || flag === "-g")) index++;
        else if (command === "env" && (flag === "-u" || flag === "--unset")) index++;
        else if (command === "stdbuf") index++;
      }
    }
    if (command === "timeout" && index < words.length && !words[index].startsWith("-")) {
      index++; // duration
    }
    if (command === "sudo" && index < words.length && !words[index].startsWith("-")) {
      // `sudo user command` is rare; only strip a -u value, already handled.
    }
  }
  return words.slice(index);
}

function analyzeReadCommand(
  words: string[],
  ctx: SegmentContext,
  command: string,
): void {
  const optionsWithValue = new Set([
    "-n",
    "-c",
    "--bytes",
    "--lines",
    "--max-count",
    "--color",
    "--exclude",
    "--include",
    "--glob",
    "--type",
    "--file",
    "--files0-from",
  ]);
  const args: string[] = [];
  for (let i = 1; i < words.length; i++) {
    const word = words[i];
    if (isFlag(word)) {
      if (optionsWithValue.has(word) && i + 1 < words.length) i++;
      if (word === "--" && i + 1 < words.length) {
        args.push(...words.slice(i + 1));
        break;
      }
      continue;
    }
    args.push(word);
  }
  if (args.length === 0) {
    // `cat`/`head`/`wc` with no operand read stdin, not the directory. Only
    // commands whose documented default is the current directory add it.
    if (["ls", "tree", "eza", "du", "fd", "fdfind"].includes(command))
      ctx.addRead(ctx.cwd, "dir");
    return;
  }
  for (const arg of args) ctx.addRead(arg);
}

function analyzeWriteCommand(
  words: string[],
  ctx: SegmentContext,
  command: string,
): void {
  const args = words.slice(1).filter((word) => !isFlag(word) && word !== "-");
  if (args.length === 0) {
    ctx.analysis.uncertain.push(`${command} without a statically known target`);
    return;
  }
  for (const arg of args) ctx.addWrite(arg);
}

function analyzeGrep(words: string[], ctx: SegmentContext): void {
  const optionsWithValue = new Set([
    "-e",
    "--regexp",
    "-f",
    "--file",
    "-g",
    "--glob",
    "--type",
    "-C",
    "-A",
    "-B",
    "--context",
    "--after-context",
    "--before-context",
    "--max-count",
    "--exclude",
    "--include",
  ]);
  const positionals: string[] = [];
  for (let i = 1; i < words.length; i++) {
    const word = words[i];
    if (word === "--") {
      positionals.push(...words.slice(i + 1));
      break;
    }
    if (isFlag(word)) {
      if (word === "-f" || word === "--file") {
        if (i + 1 < words.length) ctx.addRead(words[++i]);
        continue;
      }
      if (optionsWithValue.has(word) && i + 1 < words.length) i++;
      continue;
    }
    positionals.push(word);
  }
  // The first positional is the pattern unless -e/-f supplied it.
  const hasExplicitPattern = words.some(
    (word) => word === "-e" || word === "--regexp" || word === "-f" || word === "--file",
  );
  const paths = hasExplicitPattern ? positionals : positionals.slice(1);
  if (paths.length === 0) {
    ctx.addRead(ctx.cwd, "dir");
    return;
  }
  for (const p of paths) ctx.addRead(p);
}

function analyzeFind(words: string[], ctx: SegmentContext): void {
  let root: string | undefined;
  for (let i = 1; i < words.length; i++) {
    const word = words[i];
    if (word === "-newer" || word === "-files0-from") {
      if (i + 1 < words.length) ctx.addRead(words[++i]);
      continue;
    }
    if (word === "-exec" || word === "-execdir" || word === "-ok") {
      ctx.analysis.uncertain.push(`find ${word}`);
      continue;
    }
    if (isFlag(word)) continue;
    if (!root) root = word;
  }
  ctx.addRead(root ?? ctx.cwd, "dir");
}

function analyzeSed(words: string[], ctx: SegmentContext): void {
  const files: string[] = [];
  let scriptSeen = false;
  for (let i = 1; i < words.length; i++) {
    const word = words[i];
    if (word === "-e" || word === "--expression") {
      scriptSeen = true;
      if (i + 1 < words.length) i++;
      continue;
    }
    if (word === "-f" || word === "--file") {
      if (i + 1 < words.length) ctx.addRead(words[++i]);
      scriptSeen = true;
      continue;
    }
    if (word.startsWith("-i") || word === "--in-place") {
      ctx.analysis.uncertain.push("sed -i");
      continue;
    }
    if (isFlag(word)) continue;
    if (!scriptSeen) {
      scriptSeen = true;
      if (/\b[ew]\b/.test(word)) ctx.analysis.uncertain.push("sed script executes/writes");
      continue;
    }
    files.push(word);
  }
  for (const file of files) {
    ctx.addRead(file);
    if (words.some((word) => word.startsWith("-i") || word === "--in-place"))
      ctx.addWrite(file);
  }
}

function analyzeAwk(words: string[], ctx: SegmentContext): void {
  const files: string[] = [];
  let programSeen = false;
  for (let i = 1; i < words.length; i++) {
    const word = words[i];
    if (word === "-f" || word === "--file") {
      if (i + 1 < words.length) ctx.addRead(words[++i]);
      programSeen = true;
      continue;
    }
    if (word === "-i" || word === "--include") continue;
    if (isFlag(word)) continue;
    if (!programSeen) {
      programSeen = true;
      if (/system\s*\(|\|\s*["']/.test(word))
        ctx.analysis.uncertain.push("awk program executes a command");
      continue;
    }
    files.push(word);
  }
  for (const file of files) {
    ctx.addRead(file);
    if (words.includes("inplace") || words.includes("-i"))
      ctx.addWrite(file);
  }
}

function analyzeTar(words: string[], ctx: SegmentContext): void {
  let extracting = false;
  for (let i = 1; i < words.length; i++) {
    const word = words[i];
    if (word === "-f" || word === "--file") {
      if (i + 1 < words.length) ctx.addRead(words[++i]);
      continue;
    }
    if (word === "-C" || word === "--directory") {
      if (i + 1 < words.length) ctx.addWrite(words[++i], "dir");
      continue;
    }
    if (/^[-]?[xXtT]/.test(word)) extracting = true;
    if (/^-/.test(word) && /[xX]/.test(word)) extracting = true;
    if (!isFlag(word)) ctx.addRead(word);
  }
  if (extracting) ctx.addWrite(ctx.cwd, "dir");
}

function analyzeArchive(
  words: string[],
  ctx: SegmentContext,
  command: string,
): void {
  for (let i = 1; i < words.length; i++) {
    const word = words[i];
    if (word === "-d" || word === "-o") {
      if (i + 1 < words.length) ctx.addWrite(words[++i], "dir");
      continue;
    }
    if (command === "unzip" && word === "-d") continue;
    if (isFlag(word)) continue;
    if (/\.(zip|tar|gz|tgz|7z|rar|xz|bz2)$/i.test(word) || i === 1)
      ctx.addRead(word);
    else ctx.addWrite(word);
  }
}

function analyzeCurl(words: string[], ctx: SegmentContext): void {
  for (let i = 1; i < words.length; i++) {
    const word = words[i];
    if (word === "-o" || word === "--output") {
      if (i + 1 < words.length) ctx.addWrite(words[++i]);
      continue;
    }
    if (word === "-K" || word === "--config") {
      if (i + 1 < words.length) ctx.addRead(words[++i]);
      continue;
    }
    if (word.startsWith("@")) {
      ctx.addRead(word.slice(1));
      continue;
    }
    if (word.startsWith("file://")) {
      ctx.addRead(word.slice("file://".length));
      continue;
    }
    if (word.startsWith("--data") || word.startsWith("--form")) continue;
    if (isFlag(word)) continue;
    if (/^https?:\/\//i.test(word)) continue;
    if (word.startsWith("@")) ctx.addRead(word.slice(1));
  }
}

function analyzeCopy(
  words: string[],
  ctx: SegmentContext,
  command: string,
): void {
  const args: string[] = [];
  let recursive = command === "rsync";
  for (let i = 1; i < words.length; i++) {
    const word = words[i];
    if (isFlag(word)) {
      if (word === "-r" || word === "-R" || word === "-a" || word === "-A")
        recursive = true;
      continue;
    }
    args.push(word);
  }
  if (args.length < 2) {
    ctx.analysis.uncertain.push(`${command} without a destination`);
    return;
  }
  const sources = args.slice(0, -1);
  const destination = args[args.length - 1];
  for (const source of sources) {
    if (/^[^/\\]+@[^:]+:/.test(source)) continue; // remote scp/rsync source
    ctx.addRead(source, recursive ? "dir" : "file");
  }
  if (/^[^/\\]+@[^:]+:/.test(destination)) return; // remote destination
  ctx.addWrite(destination, recursive ? "dir" : "file");
}

function analyzeShell(
  words: string[],
  ctx: SegmentContext,
  command: string,
): void {
  for (let i = 1; i < words.length; i++) {
    const word = words[i];
    if (word === "-c" || word === "/c" || word === "-Command" || word === "-command") {
      const inner = words.slice(i + 1).join(" ");
      if (!inner) {
        ctx.analysis.uncertain.push(`${command} ${word} without a command`);
        return;
      }
      mergeAnalysis(ctx, analyzeShellPaths(inner, ctx.cwd, { family: ctx.family }));
      return;
    }
    if (isFlag(word)) continue;
    ctx.addRead(word);
  }
}

function analyzeInterpreter(
  words: string[],
  ctx: SegmentContext,
  command: string,
): void {
  for (let i = 1; i < words.length; i++) {
    const word = words[i];
    if (word === "-e" || word === "-c" || word === "-m" || word === "-r") {
      ctx.analysis.uncertain.push(`${command} ${word} inline code`);
      return;
    }
    if (isFlag(word)) continue;
    ctx.addRead(word);
    return;
  }
  ctx.analysis.uncertain.push(`${command} (inline or stdin code)`);
}

function mergeAnalysis(ctx: SegmentContext, nested: ShellPathAnalysis): void {
  for (const target of nested.reads) ctx.addRead(target.path, target.kind);
  for (const target of nested.writes) ctx.addWrite(target.path, target.kind);
  for (const reason of nested.uncertain) ctx.analysis.uncertain.push(reason);
  if (nested.git) ctx.analysis.git = nested.git;
}

function analyzeGit(words: string[], ctx: SegmentContext): void {
  const command = words;
  let index = 1;
  let rootFlag: string | undefined;
  let usesCwd = true;
  while (index < command.length) {
    const word = command[index];
    if (word === "-C" || word === "--git-dir" || word === "--work-tree") {
      rootFlag = command[index + 1];
      usesCwd = false;
      index += 2;
      continue;
    }
    if (word.startsWith("--git-dir=") || word.startsWith("--work-tree=")) {
      rootFlag = word.slice(word.indexOf("=") + 1);
      usesCwd = false;
      index++;
      continue;
    }
    if (word === "-c" || word === "--config-env" || word === "--exec-path" || word === "--namespace" || word === "--super-prefix") {
      const value = command[index + 1] ?? "";
      if (/fsmonitor|pager|alias\./i.test(value))
        ctx.analysis.uncertain.push("git -c may execute a configured program");
      index += 2;
      continue;
    }
    if (word.startsWith("-")) {
      index++;
      continue;
    }
    break;
  }
  const subcommand = (command[index] ?? "").toLowerCase();
  const args = command.slice(index + 1);
  const repoRoot = rootFlag
    ? ctx.normalizePath(rootFlag)
    : normalizePolicyPath(ctx.cwd, ctx.cwd);
  if (rootFlag) {
    // Git metadata and worktree are both read; the commit policy uses repoRoot.
    ctx.addRead(rootFlag, "dir");
  }

  if (subcommand === "add" || subcommand === "commit" || subcommand === "push") {
    const explicitPaths: string[] = [];
    let allPaths = false;
    let amend = false;
    let afterSeparator = false;
    for (let i = 0; i < args.length; i++) {
      const word = args[i];
      if (word === "--") {
        afterSeparator = true;
        continue;
      }
      if (word === "-A" || word === "--all") {
        allPaths = true;
        continue;
      }
      if (subcommand === "commit" && word === "-a") {
        allPaths = true;
        continue;
      }
      if (word === "--patch") continue;
      if (word === "--amend") {
        amend = true;
        continue;
      }
      if (!afterSeparator && isFlag(word)) {
        if (
          ["-m", "--message", "-F", "--file", "--author", "--date", "-C", "-c", "--fixup", "--squash"].includes(word)
        ) {
          if (word === "-F" || word === "--file") {
            if (args[i + 1]) ctx.addRead(args[i + 1]);
          }
          i++;
        }
        continue;
      }
      if (subcommand === "push") continue; // remote names, not local paths
      explicitPaths.push(word);
    }
    if (
      subcommand === "add" &&
      explicitPaths.some((p) => p === "." || p === ":/" || p === ":")
    )
      allPaths = true;
    for (const p of explicitPaths) {
      ctx.addRead(p);
      ctx.addWrite(p);
    }
    ctx.analysis.git = {
      hit: subcommand,
      repoRoot,
      explicitPaths: explicitPaths.map((p) =>
        normalizePolicyPath(ctx.normalizePath(p), repoRoot),
      ),
      allPaths,
      amend,
      usesCwd,
    };
    return;
  }

  if (subcommand === "checkout" || subcommand === "restore" || subcommand === "switch") {
    let afterSeparator = false;
    for (let i = 0; i < args.length; i++) {
      const word = args[i];
      if (word === "--") {
        afterSeparator = true;
        continue;
      }
      if (isFlag(word)) {
        if (["-b", "-B", "--orphan"].includes(word)) i++;
        continue;
      }
      // A branch name is indistinguishable from a path; both resolve inside
      // repoRoot, so target them and let the evaluator decide.
      if (!afterSeparator && /^[A-Za-z0-9._/-]+$/.test(word)) {
        ctx.addWrite(word);
      } else ctx.addWrite(word);
    }
    return;
  }

  if (subcommand === "clone") {
    const source = args.find((word) => !isFlag(word));
    const positional = args.filter((word) => !isFlag(word));
    if (source && !/^https?:\/\//i.test(source) && !source.startsWith("git@"))
      ctx.addRead(source, "dir");
    if (positional.length > 1) ctx.addWrite(positional[1], "dir");
    return;
  }

  if (subcommand === "show" || subcommand === "cat-file") {
    for (const arg of args) {
      const colon = arg.indexOf(":");
      if (colon > 0 && !arg.includes("://")) {
        const file = arg.slice(colon + 1);
        if (file) addGitRead(ctx, file, repoRoot);
      }
    }
    if (subcommand === "show" && !args.some((arg) => arg.includes(":"))) {
      ctx.addRead(repoRoot, "dir");
    }
    return;
  }

  if (subcommand === "diff" || subcommand === "log" || subcommand === "grep" || subcommand === "blame") {
    const separator = args.indexOf("--");
    const paths = separator >= 0 ? args.slice(separator + 1) : [];
    for (const p of paths) addGitRead(ctx, p, repoRoot);
    if (paths.length === 0) ctx.addRead(repoRoot, "dir");
    return;
  }

  // Other git subcommands read the repository at least.
  ctx.addRead(repoRoot, "dir");
}

function addGitRead(
  ctx: SegmentContext,
  value: string,
  repoRoot: string,
): void {
  const normalized = normalizePolicyPath(ctx.normalizePath(value), repoRoot);
  if (normalized) ctx.analysis.reads.push({ path: normalized, kind: "file" });
}

function analyzePowerShellRead(words: string[], ctx: SegmentContext): void {
  const args = powerShellPathArgs(words);
  if (args.length === 0) ctx.addRead(ctx.cwd, "dir");
  else for (const arg of args) ctx.addRead(arg);
}

function analyzePowerShellWrite(
  words: string[],
  ctx: SegmentContext,
  command: string,
): void {
  const args = powerShellPathArgs(words);
  if (args.length === 0) {
    ctx.analysis.uncertain.push(`${command} without a statically known target`);
    return;
  }
  if (command === "copy-item" || command === "move-item" || command === "copy" || command === "move") {
    for (const source of args.slice(0, -1)) ctx.addRead(source);
    ctx.addWrite(args[args.length - 1]);
    return;
  }
  for (const arg of args) ctx.addWrite(arg);
}

function powerShellPathArgs(words: string[]): string[] {
  const pathFlags = new Set([
    "-path",
    "-literalpath",
    "-destination",
    "-source",
    "-filepath",
  ]);
  const valueFlags = new Set([
    "-value",
    "-encoding",
    "-name",
    "-itemtype",
    "-filter",
    "-include",
    "-exclude",
  ]);
  const out: string[] = [];
  for (let i = 1; i < words.length; i++) {
    const word = words[i];
    const lower = word.toLowerCase();
    if (pathFlags.has(lower)) {
      if (i + 1 < words.length) out.push(words[++i]);
      continue;
    }
    if (valueFlags.has(lower)) {
      if (i + 1 < words.length) i++;
      continue;
    }
    if (isFlag(word)) continue;
    out.push(word);
  }
  return out;
}

function looksSensitiveOperand(normalized: string): boolean {
  const name = normalized.split("/").pop()?.toLowerCase() ?? "";
  if (!name) return false;
  if (name === ".env" || (name.startsWith(".env.") && !/\.(example|sample|template|dist)$/.test(name)))
    return true;
  if (
    [
      ".npmrc",
      ".yarnrc",
      ".pypirc",
      ".netrc",
      "_netrc",
      ".git-credentials",
      ".authinfo",
      "auth.json",
      "credentials.json",
      "id_rsa",
      "id_ed25519",
      "id_ecdsa",
    ].includes(name)
  )
    return true;
  return /\.(pem|key|p12|pfx|jks|keystore|kdbx|tfstate|tfvars)$/i.test(name);
}

// Keep the import useful for consumers that inspect redirects directly.
export type { ShellRedirect };
