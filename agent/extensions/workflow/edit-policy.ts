/**
 * Workflow Extension — Write Policy
 *
 * User-controllable permission for file modification in Pi's DEFAULT mode:
 *
 *   "allow" (default) — the agent may write files freely (today's behaviour).
 *   "ask"             — every file write pops a confirmation dialog. The
 *            user can allow once, allow that path/command permanently, or
 *            deny. Persistent grants live in the allowlists below.
 *   "never"           — the agent may not write files at all. The user (or
 *            /build, the deliberate execution mode) does the writing.
 *
 * WHY THIS EXISTS: the Workflow extension's three modes are Plan → Build →
 * Default. Plan mode is read-only and Build mode is unrestricted, but
 * Default mode is ALSO unrestricted — `resolveSessionRole()` returns
 * undefined there, so the tool_call gate in index.ts has no branch to take
 * and the agent edits files without asking. This module supplies the missing
 * permission knob, enforced deterministically (a soft prompt is not enough —
 * the same lesson as the commit policy).
 *
 * This module holds the pure, I/O-light parts (config, coercion, merge,
 * read, write, path matching, command classification, the decision table) so
 * they can be unit-tested without a Pi runtime. Nothing here imports the Pi
 * SDK at module scope — same discipline as commit-policy.ts and permissions.ts.
 *
 * Settings live under `workflow.writePolicy` in `~/.pi/agent/settings.json`
 * (global) or `<cwd>/.pi/settings.json` (project). Project wins for `mode`;
 * the allowlists are additive (unioned) across scopes, because an allowlist
 * is a grant of trust, not a restriction. Writes preserve every other key in
 * the file (Pi owns settings.json — we must not clobber it).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ArgumentCompletion } from "./utils.ts";
import { joinArgumentValue, suppressExactArgumentMatch } from "./utils.ts";
import {
  COMMIT_CONFIG_DIR,
  WORKFLOW_SETTINGS_KEY,
  type JsonObject,
} from "./commit-policy.ts";
import {
  commandClassOf,
  forbiddenSyntaxReason,
  gitCommitPolicyHit,
  splitCommandSegments,
  stripHarmlessRedirects,
  DENIED_FLAG_RE,
} from "./permissions.ts";

/** Nested key under WORKFLOW_SETTINGS_KEY. */
export const WRITE_POLICY_KEY = "writePolicy";

/** How the agent may modify files in Default mode. */
export type WritePolicyMode = "allow" | "ask" | "never";

export interface WritePolicyConfig {
  mode: WritePolicyMode;
  /** Absolute paths the agent may write without being asked again. */
  allowedPaths: string[];
  /** Command keys the agent may run without being asked again. */
  allowedCommands: string[];
  /** Extra tool names treated as file writes (e.g. "ast_grep_replace"). */
  mutatingTools: string[];
}

export const DEFAULT_WRITE_POLICY_CONFIG: Readonly<WritePolicyConfig> = {
  mode: "allow",
  allowedPaths: [],
  allowedCommands: [],
  mutatingTools: [],
};

const WRITE_POLICY_MODES: readonly WritePolicyMode[] = ["allow", "ask", "never"];

/**
 * A raw `workflow.writePolicy` fragment. A bare mode string ("allow" |
 * "ask" | "never") is accepted as shorthand for `{ mode: <string> }` so a
 * minimal settings file stays readable.
 */
export type RawWritePolicySetting = JsonObject | string;

/** Coerce an unknown value into a WritePolicyMode, or undefined. */
function coerceMode(value: unknown): WritePolicyMode | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  return (WRITE_POLICY_MODES as readonly string[]).includes(normalized)
    ? (normalized as WritePolicyMode)
    : undefined;
}

/**
 * Coerce an unknown value into a list of non-empty strings. Non-arrays and
 * non-string members are dropped. Never throws.
 */
function coerceStringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim();
    if (!trimmed) continue;
    if (out.includes(trimmed)) continue;
    out.push(trimmed);
  }
  return out;
}

/** Union two string lists, preserving order and dropping duplicates. */
function unionStrings(a: readonly string[], b: readonly string[]): string[] {
  const out = [...a];
  for (const item of b) if (!out.includes(item)) out.push(item);
  return out;
}

/**
 * Coerce an untrusted settings fragment into a complete WritePolicyConfig.
 * Accepts an object (`{ mode: "ask" }`) or a bare mode string shorthand.
 * Booleans, numbers, garbage and wrong types all fall back to `base`
 * (defaults) — there is no boolean shorthand for the write policy.
 * Never throws.
 */
export function coerceWritePolicyConfig(
  raw: unknown,
  base: WritePolicyConfig = DEFAULT_WRITE_POLICY_CONFIG as WritePolicyConfig,
): WritePolicyConfig {
  if (typeof raw === "string") {
    const mode = coerceMode(raw);
    return { ...base, mode: mode ?? base.mode };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ...base };
  }
  const obj = raw as JsonObject;
  const mode = coerceMode(obj.mode);
  return {
    mode: mode ?? base.mode,
    allowedPaths:
      coerceStringList(obj.allowedPaths) ?? [...base.allowedPaths],
    allowedCommands:
      coerceStringList(obj.allowedCommands) ?? [...base.allowedCommands],
    mutatingTools:
      coerceStringList(obj.mutatingTools) ?? [...base.mutatingTools],
  };
}

/** Extract the `workflow.writePolicy` fragment from a raw settings object. */
export function extractWritePolicyRaw(
  settings: unknown,
): RawWritePolicySetting | undefined {
  if (!settings || typeof settings !== "object" || Array.isArray(settings))
    return undefined;
  const wf = (settings as JsonObject)[WORKFLOW_SETTINGS_KEY];
  if (!wf || typeof wf !== "object" || Array.isArray(wf)) return undefined;
  const raw = (wf as JsonObject)[WRITE_POLICY_KEY];
  if (typeof raw === "string") return raw;
  if (raw && typeof raw === "object" && !Array.isArray(raw))
    return raw as JsonObject;
  return undefined;
}

/**
 * Merge global then project settings fragments, then coerce onto defaults.
 * `mode` is project-over-global (field-by-field); the allowlists and the
 * mutating-tool list are UNIONED, because an allowlist is additive trust.
 */
export function mergeWritePolicyConfig(
  globalRaw: unknown,
  projectRaw: unknown,
): WritePolicyConfig {
  const fromGlobal = coerceWritePolicyConfig(globalRaw);
  const fromProject = coerceWritePolicyConfig(projectRaw, fromGlobal);
  return {
    mode: fromProject.mode,
    allowedPaths: unionStrings(
      fromGlobal.allowedPaths,
      fromProject.allowedPaths,
    ),
    allowedCommands: unionStrings(
      fromGlobal.allowedCommands,
      fromProject.allowedCommands,
    ),
    mutatingTools: unionStrings(
      fromGlobal.mutatingTools,
      fromProject.mutatingTools,
    ),
  };
}

export interface WritePolicyConfigPaths {
  global: string;
  project: string;
}

/**
 * Settings file locations. `agentDir` is passed in rather than read from the
 * Pi SDK so this stays pure and testable.
 */
export function writePolicyConfigPaths(
  cwd: string,
  agentDir: string,
): WritePolicyConfigPaths {
  return {
    global: path.join(agentDir, "settings.json"),
    project: path.join(cwd, COMMIT_CONFIG_DIR, "settings.json"),
  };
}

function readJsonSafe(fp: string): JsonObject | undefined {
  try {
    if (!fs.existsSync(fp)) return undefined;
    const parsed: unknown = JSON.parse(fs.readFileSync(fp, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return undefined;
    return parsed as JsonObject;
  } catch {
    return undefined;
  }
}

/** Which settings scope supplied a field's effective value. */
export type WritePolicyScopeSource = "default" | "global" | "project";

/**
 * Which raw fragment supplied the effective `mode`: the project fragment when
 * it carries a valid mode, else the global fragment, else the built-in
 * default. Pure and total.
 */
export function writePolicyModeSourceOf(
  globalRaw: RawWritePolicySetting | undefined,
  projectRaw: RawWritePolicySetting | undefined,
): WritePolicyScopeSource {
  const hasModeKey = (raw: unknown): boolean =>
    typeof raw === "string"
      ? coerceMode(raw) !== undefined
      : Boolean(raw) &&
        typeof raw === "object" &&
        !Array.isArray(raw) &&
        coerceMode((raw as JsonObject).mode) !== undefined;
  if (hasModeKey(projectRaw)) return "project";
  if (hasModeKey(globalRaw)) return "global";
  return "default";
}

export interface ResolvedWritePolicy {
  config: WritePolicyConfig;
  /** Which files contributed (for /write-policy status and debugging). */
  sources: {
    global: boolean;
    project: boolean;
    /** Which scope supplied the effective `mode` value. */
    mode: WritePolicyScopeSource;
  };
}

/**
 * Resolve the effective Write Policy config from disk.
 * Never throws — a corrupt or missing file falls back to defaults.
 */
export function readWritePolicyConfig(
  cwd: string,
  agentDir: string,
): ResolvedWritePolicy {
  const paths = writePolicyConfigPaths(cwd, agentDir);
  const globalSettings = readJsonSafe(paths.global);
  const projectSettings = readJsonSafe(paths.project);
  const globalRaw = extractWritePolicyRaw(globalSettings);
  const projectRaw = extractWritePolicyRaw(projectSettings);
  const config = mergeWritePolicyConfig(globalRaw, projectRaw);
  return {
    config,
    sources: {
      global: globalRaw !== undefined,
      project: projectRaw !== undefined,
      mode: writePolicyModeSourceOf(globalRaw, projectRaw),
    },
  };
}

/**
 * Read-modify-write `workflow.writePolicy` into a settings file, preserving
 * every other key in that file (Pi owns settings.json — we must not clobber
 * it).
 *
 * `mode` is REPLACED by the patch. The three list fields are ADDITIVE: the
 * patch's entries are appended to the stored ones (deduplicated, order
 * preserved) and never remove what is already there. An allowlist is a grant
 * of trust — removing an entry is done by editing settings.json directly.
 */
export function writeWritePolicyConfig(
  scope: "global" | "project",
  cwd: string,
  agentDir: string,
  patch: Partial<WritePolicyConfig>,
): { path: string; ok: boolean; error?: string } {
  const paths = writePolicyConfigPaths(cwd, agentDir);
  const fp = scope === "project" ? paths.project : paths.global;
  try {
    const existing = readJsonSafe(fp);
    const root: JsonObject = existing ? { ...existing } : {};
    const wfExisting = root[WORKFLOW_SETTINGS_KEY];
    const wf: JsonObject =
      wfExisting && typeof wfExisting === "object" && !Array.isArray(wfExisting)
        ? { ...(wfExisting as JsonObject) }
        : {};
    const current = coerceWritePolicyConfig(wf[WRITE_POLICY_KEY]);
    // `mode` is replaced by the patch; the three list fields are ADDITIVE —
    // a plain spread would REPLACE them, silently dropping the entries that
    // are already stored (an allowlist is a grant of trust, so a grant must
    // never be lost by writing another one).
    const next: WritePolicyConfig = {
      mode: coerceWritePolicyConfig({ ...current, ...patch }, current).mode,
      allowedPaths: unionStrings(
        current.allowedPaths,
        coerceStringList(patch.allowedPaths) ?? [],
      ),
      allowedCommands: unionStrings(
        current.allowedCommands,
        coerceStringList(patch.allowedCommands) ?? [],
      ),
      mutatingTools: unionStrings(
        current.mutatingTools,
        coerceStringList(patch.mutatingTools) ?? [],
      ),
    };
    wf[WRITE_POLICY_KEY] = next;
    root[WORKFLOW_SETTINGS_KEY] = wf;
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, JSON.stringify(root, null, 2) + "\n", "utf8");
    return { path: fp, ok: true };
  } catch (e: unknown) {
    return {
      path: fp,
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

// ── Path matching ───────────────────────────────────────────────────

/**
 * Canonical form of a path for allowlist comparison: absolute, forward
 * slashes, lower-cased, no trailing separator.
 *
 * Lower-casing matches the existing `isPlanWritePath` convention in utils.ts
 * (Windows paths are case-insensitive) and keeps the comparison
 * platform-independent. A trailing separator is stripped so a directory and
 * its own path compare equal; the filesystem root keeps its slash.
 */
export function normalizeWritePath(p: unknown, cwd: string): string {
  if (typeof p !== "string") return "";
  const raw = p.trim();
  if (!raw) return "";
  const base = cwd && cwd.trim() ? cwd : process.cwd();
  let resolved: string;
  try {
    resolved = path.resolve(base, raw);
  } catch {
    resolved = raw;
  }
  let normalized = resolved.replace(/\\/g, "/").toLowerCase();
  while (
    normalized.length > 1 &&
    normalized.endsWith("/") &&
    !/^[a-z]:\/$/.test(normalized)
  ) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
}

/**
 * True when `target` is covered by an allowlist entry.
 *
 * An entry matches when it EQUALS the target, or when the target sits
 * strictly inside it on a directory boundary — so `…/src` covers
 * `…/src/a.ts` but never `…/src-old/a.ts`.
 */
export function isPathAllowed(
  target: unknown,
  allowedPaths: readonly string[],
  cwd: string,
): boolean {
  const normalizedTarget = normalizeWritePath(target, cwd);
  if (!normalizedTarget) return false;
  for (const entry of allowedPaths) {
    const normalizedEntry = normalizeWritePath(entry, cwd);
    if (!normalizedEntry) continue;
    if (normalizedTarget === normalizedEntry) return true;
    if (normalizedTarget.startsWith(`${normalizedEntry}/`)) return true;
  }
  return false;
}

// ── Command classification ──────────────────────────────────────────

/** The outcome of classifying one tool call. */
export interface WriteIntent {
  /** True when the call may modify the filesystem. */
  mutating: boolean;
  /** Short human-readable cause, present when `mutating`. */
  reason?: string;
  /** The shell segment that triggered the classification. */
  segment?: string;
}

/**
 * Classify a shell command as mutating or not.
 *
 * Per segment, in this order:
 *   1. forbidden shell syntax (file redirect, heredoc, command/process
 *      substitution, background `&`) → mutating. Checked FIRST so a
 *      redirect riding along with a git command (`git commit -m x > log`)
 *      is still caught as a write.
 *   2. `git add` / `git commit` / `git push` → NOT mutating: they touch the
 *      index and the object store, not the user's working-tree files, and
 *      the independent commit policy already governs them.
 *   3. an unrestricted command class (`commandClassOf` → "full") → mutating.
 *      This is the fail-closed default: anything not provably read-only
 *      (sed/awk programs, interpreters, unknown binaries) may write.
 *   4. a write flag (`--fix`, `--write`, `--in-place`, `--update-snapshots`,
 *      `--output`, …) → mutating. Catches verify-class commands that still
 *      rewrite files (`eslint --fix`).
 *   5. otherwise → not mutating (read-only and verify-class segments pass:
 *      `ls`, `cat`, `rg`, `git status`, `npm test`, `tsc --noEmit`).
 */
export function commandMayWrite(command: unknown): WriteIntent {
  if (typeof command !== "string" || !command.trim()) {
    return { mutating: false };
  }
  for (const segment of splitCommandSegments(command)) {
    const trimmed = segment.trim();
    if (!trimmed) continue;

    // 1. Forbidden syntax — a file redirect is a write whatever else runs.
    const syntax = forbiddenSyntaxReason(trimmed);
    if (syntax) {
      return { mutating: true, reason: syntax, segment: trimmed };
    }

    // Classify the command with harmless redirections (`2>&1`, `>/dev/null`)
    // removed, so `2>/dev/null ls` is judged as `ls` (read-only) rather than
    // as an unknown binary. A segment that is nothing but a redirection
    // writes no file.
    const scrubbed = stripHarmlessRedirects(trimmed).trim();
    if (!scrubbed) continue;

    // 2. Git history operations — governed by the commit policy, not here.
    if (gitCommitPolicyHit(scrubbed)) continue;

    // 3. Not provably read-only → may write.
    if (commandClassOf(scrubbed) === "full") {
      return {
        mutating: true,
        reason: "runs a command that may modify files",
        segment: trimmed,
      };
    }

    // 4. A write flag on an otherwise-safe command.
    const flag = scrubbed.match(DENIED_FLAG_RE);
    if (flag) {
      return {
        mutating: true,
        reason: `uses the write flag ${flag[2] ?? flag[0].trim()}`,
        segment: trimmed,
      };
    }
  }
  return { mutating: false };
}

/** Normalize a shell segment into the key used for allowlist matching. */
export function commandAllowKey(segment: unknown): string {
  if (typeof segment !== "string") return "";
  return segment.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * True when `key` is covered by an allowlist entry.
 *
 * An entry matches when it EQUALS the key, or when the key continues the
 * entry on a word boundary — so "npm run build" covers
 * "npm run build --watch" but never "npm run buildx".
 */
export function isCommandAllowed(
  key: unknown,
  allowedCommands: readonly string[],
): boolean {
  const normalizedKey = commandAllowKey(key);
  if (!normalizedKey) return false;
  for (const entry of allowedCommands) {
    const normalizedEntry = commandAllowKey(entry);
    if (!normalizedEntry) continue;
    if (normalizedKey === normalizedEntry) return true;
    if (normalizedKey.startsWith(`${normalizedEntry} `)) return true;
  }
  return false;
}

// ── Tool classification ─────────────────────────────────────────────

/** Built-in tools that write files. */
export const FILE_WRITE_TOOLS: readonly string[] = ["edit", "write"];

/** Built-in tools that run shell commands. */
export const SHELL_TOOLS: readonly string[] = ["bash", "powershell"];

/**
 * The key under which a path-less mutating tool is allowlisted. The
 * namespace prefix keeps a tool name from ever colliding with a shell
 * command key.
 */
export function toolAllowKey(toolName: string): string {
  return `tool:${toolName.toLowerCase()}`;
}

/**
 * Candidate target paths of a tool call. Handles the built-in file tools
 * (`path` / `file_path`) and the array form used by extension tools
 * (`paths`, e.g. ast_grep_replace).
 */
export function writeTargetPaths(input: unknown): string[] {
  if (!input || typeof input !== "object" || Array.isArray(input))
    return [];
  const obj = input as JsonObject;
  const out: string[] = [];
  const push = (value: unknown): void => {
    if (typeof value !== "string") return;
    const trimmed = value.trim();
    if (trimmed && !out.includes(trimmed)) out.push(trimmed);
  };
  push(obj.path);
  push(obj.file_path);
  if (Array.isArray(obj.paths)) for (const p of obj.paths) push(p);
  return out;
}

/** How one tool call should be treated by the write gate. */
export interface WriteCallClassification {
  /** The call may modify the filesystem. */
  mutating: boolean;
  /** Short human-readable cause. */
  reason?: string;
  /** Candidate target paths (file tools and path-aware extension tools). */
  paths: string[];
  /**
   * Key under which a persistent grant is stored: the normalized mutating
   * shell segment, or `tool:<name>` for a path-less mutating tool. Absent
   * when the call is gated by path instead.
   */
  key?: string;
}

/**
 * Classify a tool call against the write policy's scope.
 *
 * `edit` / `write` always write. `bash` is classified by
 * `commandMayWrite`. `powershell` always writes — it cannot be classified
 * by the POSIX allowlist, so it fails closed (same stance the extension
 * already takes for restricted roles). Any tool named in
 * `config.mutatingTools` is treated as a write (the escape hatch for
 * third-party write tools such as ast_grep_replace or the office tools).
 */
export function classifyWriteCall(
  toolName: string,
  input: unknown,
  config: WritePolicyConfig,
): WriteCallClassification {
  const name = String(toolName ?? "");
  if (FILE_WRITE_TOOLS.includes(name)) {
    const paths = writeTargetPaths(input);
    return {
      mutating: true,
      reason: paths.length
        ? `${name}s ${paths.join(", ")}`
        : `${name}s a file`,
      paths,
    };
  }
  if (SHELL_TOOLS.includes(name)) {
    const command = String(
      (input && typeof input === "object" && !Array.isArray(input)
        ? (input as JsonObject).command
        : "") ?? "",
    );
    if (name === "powershell") {
      // Not classifiable by the POSIX allowlist — fail closed.
      return {
        mutating: true,
        reason: "runs a powershell command (not statically classifiable)",
        paths: [],
        key: commandAllowKey(command),
      };
    }
    const intent = commandMayWrite(command);
    return {
      mutating: intent.mutating,
      reason: intent.reason,
      paths: [],
      key: intent.segment ? commandAllowKey(intent.segment) : undefined,
    };
  }
  if (config.mutatingTools.includes(name)) {
    const paths = writeTargetPaths(input);
    return {
      mutating: true,
      reason: `the ${name} tool modifies files`,
      paths,
      key: paths.length ? undefined : toolAllowKey(name),
    };
  }
  return { mutating: false, paths: [] };
}

/**
 * True when the call is already covered by a persistent grant: every target
 * path is allow-listed, or (for a path-less call) its command key is.
 */
export function isWriteCallAllowed(
  classification: WriteCallClassification,
  config: WritePolicyConfig,
  cwd: string,
): boolean {
  if (classification.paths.length > 0) {
    return classification.paths.every((p) =>
      isPathAllowed(p, config.allowedPaths, cwd),
    );
  }
  if (classification.key) {
    return isCommandAllowed(classification.key, config.allowedCommands);
  }
  return false;
}

// ── Decision table ──────────────────────────────────────────────────

export type WriteGateDecision = "allow" | "ask" | "block";

export interface WriteGateInput {
  mode: WritePolicyMode;
  /** The call may modify the filesystem. */
  mutating: boolean;
  /** The call is already covered by a persistent grant. */
  allowed: boolean;
}

/**
 * The pure decision table.
 *
 *   not mutating            → allow
 *   mode "allow"            → allow
 *   mode "never"            → block  (an allowlist entry does NOT soften
 *                              "never" — the strongest statement of intent
 *                              must win, and a stale grant must not
 *                              silently re-open writes)
 *   mode "ask", allowed      → allow  (no prompt for an already-granted path)
 *   mode "ask", not allowed  → ask
 */
export function decideWriteGate(input: WriteGateInput): WriteGateDecision {
  if (!input.mutating) return "allow";
  if (input.mode === "allow") return "allow";
  if (input.mode === "never") return "block";
  return input.allowed ? "allow" : "ask";
}

/** One-line human-readable summary of a policy mode (for status output). */
export function describeWritePolicyMode(mode: WritePolicyMode): string {
  switch (mode) {
    case "allow":
      return "the agent may write files freely";
    case "ask":
      return "every file write asks first; granted paths/commands are remembered";
    case "never":
      return "the agent may not write files — you write, or switch to /build";
    default:
      return "the agent may write files freely";
  }
}

// ── Guided denial ("Deny with instructions") ─────────────────────────
//
// The plain "Deny" answer tells the model only that the write was refused.
// It says nothing about what the user actually wants, so the model either
// stops cold or re-proposes the same class of action. "Deny with
// instructions" lets the user say WHY in one sentence ("only explore and
// propose a plan, do not edit files yet") and have that sentence steer the
// model.
//
// Industry practice (Claude Code's "No, and tell Claude what to do
// differently", Cursor's "Reject? Tell what to do differently") attaches
// the note to the rejection. Anthropic then shipped a bug with exactly that
// design — feedback carried ONLY by the tool result was repeatedly ignored
// by the model (anthropics/claude-code#89231, #52824). A tool result is a
// fact the model may reinterpret; a user-role turn is an instruction it
// must obey. So the instruction travels through BOTH channels: the block
// reason (tool result) and a user message (see index.ts).
//
// Everything in this section is pure so it can be unit-tested without a Pi
// runtime, and so the option labels and the parsing of them live in one
// place instead of being string-matched inline in the gate.

/** Longest user instruction kept from the denial dialog. */
export const WRITE_INSTRUCTION_MAX_LEN = 2000;

/**
 * Prefix of the guided-denial choice. The parser matches on this prefix, so
 * it must stay a prefix of the label below.
 */
export const WRITE_DENY_WITH_INSTRUCTIONS_PREFIX = "Deny with";

/** Label of the guided-denial choice in the ask dialog. */
export const WRITE_DENY_WITH_INSTRUCTIONS_LABEL = `${WRITE_DENY_WITH_INSTRUCTIONS_PREFIX} instructions…`;

/** Title of the free-text dialog opened after the guided-denial choice. */
export const WRITE_INSTRUCTION_PROMPT_TITLE =
  "Write denied — tell the agent how to proceed";

/** Placeholder of the free-text dialog (an example, not a requirement). */
export const WRITE_INSTRUCTION_PROMPT_PLACEHOLDER =
  "e.g. only explore and propose a plan, do not edit files yet";

/**
 * Normalize the text the user typed in the denial dialog.
 *
 * - normalises CRLF/CR to LF,
 * - strips C0 control characters and DEL (but keeps tab and newline),
 * - trims,
 * - hard-caps at WRITE_INSTRUCTION_MAX_LEN (appending an ellipsis).
 *
 * Returns "" for empty / whitespace-only input — the caller then treats the
 * answer as a plain denial (fail closed, never an implicit allow).
 */
export function sanitizeWriteInstruction(raw: unknown): string {
  const text = String(raw ?? "");
  if (!text) return "";
  const out = text
    .replace(/\r\n?/g, "\n")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, "")
    .trim();
  if (!out) return "";
  if (out.length > WRITE_INSTRUCTION_MAX_LEN) {
    return `${out.slice(0, WRITE_INSTRUCTION_MAX_LEN)}…`;
  }
  return out;
}

/**
 * The choices the ask dialog offers — the single source of the labels.
 *
 * The gate consumes this and `parseWriteGateChoice` below, so a renamed
 * label can never silently change the gate's behaviour (the unit test maps
 * every real option through the parser).
 *
 * The labels state the scope they really have, because ONE answer now
 * covers every gated write of the turn (see the turn-scoped helpers below):
 * "Allow once (this turn)" allows the writes the dialog listed, and
 * "Always allow …" persists a grant for every one of them.
 */
export function writeGateOptions(
  kind: WriteGateOptionKind,
): readonly string[] {
  return [
    "Allow once (this turn)",
    writeGateAlwaysLabel(kind),
    "Deny",
    WRITE_DENY_WITH_INSTRUCTIONS_LABEL,
  ];
}

/**
 * The "always allow" label for a set of items — singular, plural or mixed.
 *
 * The prefix "Always allow" is what `parseWriteGateChoice` matches on, so
 * every variant parses to the same choice.
 */
export function writeGateAlwaysLabel(kind: WriteGateOptionKind): string {
  switch (kind) {
    case "path":
      return "Always allow this path";
    case "paths":
      return "Always allow these paths";
    case "command":
      return "Always allow this command";
    case "commands":
      return "Always allow these commands";
    case "mixed":
      return "Always allow these";
    default:
      return "Always allow these";
  }
}

/** What the ask dialog's answer means. */
export type WriteGateChoice =
  | "allow-once"
  | "always"
  | "deny-with-instructions"
  | "deny";

/**
 * Parse the answer of the ask dialog.
 *
 * Fail closed: anything unrecognised — a cancelled dialog, a blank answer,
 * a label this build does not know — is a plain "deny". "Deny with…" is
 * matched BEFORE the bare "Deny" prefix, otherwise the guided choice would
 * be swallowed by it.
 */
export function parseWriteGateChoice(choice: unknown): WriteGateChoice {
  const text = String(choice ?? "").trim();
  if (text.startsWith("Allow once")) return "allow-once";
  if (text.startsWith("Always allow")) return "always";
  if (text.startsWith(WRITE_DENY_WITH_INSTRUCTIONS_PREFIX)) {
    return "deny-with-instructions";
  }
  return "deny";
}

export interface WriteDenyReasonInput {
  /** The write the gate was about (paths, or the command key). */
  target: string;
  /** Why the call was classified as a write (e.g. "edits src/a.ts"). */
  why?: string;
  /** The user's instruction; sanitized here. Empty → a plain denial. */
  instruction?: string;
}

/**
 * The reason the model reads when the user denies a write.
 *
 * Plain denial: the classic "declined, do not retry, propose the change
 * instead". Guided denial: the user's sentence is quoted verbatim in the
 * middle of the reason, followed by the disposition ("follow the
 * instruction; if it cannot be followed, say so and stop") — the
 * "failing loudly" shape, where a refusal states what, why, and what to do
 * next instead of a bare "no".
 */
export function buildWriteDenyReason(input: WriteDenyReasonInput): string {
  const target = String(input.target ?? "").trim() || "the requested write";
  const why = input.why ? ` (${input.why})` : "";
  const instruction = sanitizeWriteInstruction(input.instruction);
  if (!instruction) {
    return (
      `Write policy 'ask': the user declined this write${why}. Do not retry it. ` +
      "Propose the change (a diff or the exact edit) and let the user apply it, or ask whether to continue another way. " +
      `Target: ${target}`
    );
  }
  return (
    `Write policy 'ask': the user denied this write${why} and gave this instruction:\n\n` +
    `${instruction}\n\n` +
    "Do not retry this write. Follow the instruction above. If it cannot be followed, say so and stop. " +
    `Target: ${target}`
  );
}

/**
 * The user-role message that carries the instruction to the model.
 *
 * This is the second channel: a steer message is delivered as a real user
 * turn after the current tool batch, so the instruction is something the
 * model must obey rather than a tool result it may reinterpret.
 */
export function buildWriteGuidanceMessage(input: {
  target: string;
  instruction: string;
}): string {
  const target = String(input.target ?? "").trim() || "the requested write";
  const instruction = sanitizeWriteInstruction(input.instruction);
  return (
    "[write denied — the user asked you to do something different]\n" +
    `The user denied the write to ${target}. Their instruction:\n\n${instruction}\n\n` +
    "Follow the instruction above instead of retrying that write."
  );
}

// ── Turn-scoped gate helpers ───────────────────────────────────────────
//
// The gate asks ONE question per assistant turn — not one per tool call.
//
// WHY: Pi executes an assistant message's tool calls as a BATCH, and the
// extension's `tool_call` hook runs in the batch's PREPARATION phase: once
// per call, sequentially, before any tool in the batch runs
// (pi-agent-core/dist/agent-loop.js → executeToolCallsParallel →
// prepareToolCall → beforeToolCall). A model that batches two writes to the
// same file therefore produced two dialogs back to back, with no agent
// output in between — and the instruction typed into the first one could
// not reach the model before the second one opened, because a tool result is
// appended only after the whole batch and a steer message lands only after
// the turn's tool calls have run. The user had to retype the same sentence.
//
// So the gate collects the turn's gated writes, shows them all in one
// dialog, and applies the answer to every one of them.

/** One gated write covered by a single dialog answer. */
export interface WriteGateItem {
  /** The tool that would write (edit, write, bash, powershell, …). */
  tool: string;
  /** Human target: the joined paths, or the command/tool key. */
  target: string;
  /** Short cause, e.g. "edits src/a.ts". */
  why?: string;
  /** Stable key a denial is remembered under (see `writeGateTargetKey`). */
  key: string;
  /** Path grants "always allow" would persist for this item. */
  grantPaths?: string[];
  /** Command (or tool) grant "always allow" would persist for this item. */
  grantCommand?: string;
}

/**
 * Which "always allow" label fits a set of items.
 *
 * "path"/"paths" — every item writes files; "command"/"commands" — every
 * item runs a command (or a path-less tool, whose grant is stored in the
 * command list); "mixed" — both in one turn.
 */
export type WriteGateOptionKind =
  | "path"
  | "paths"
  | "command"
  | "commands"
  | "mixed";

/**
 * The stable key a denial is remembered under.
 *
 * Path writes key on their normalized absolute path(s) (so the same file
 * keys the same way whatever the model spelled it as), command writes on
 * their allow-key, and a path-less tool on its tool key.
 */
export function writeGateTargetKey(
  toolName: string,
  classification: WriteCallClassification,
  cwd: string,
): string {
  const paths = classification.paths
    .map((p) => normalizeWritePath(p, cwd))
    .filter((p) => p.length > 0)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (paths.length > 0) return `path:${paths.join("|")}`;
  if (classification.key) return `cmd:${commandAllowKey(classification.key)}`;
  return `tool:${toolAllowKey(toolName)}`;
}

/**
 * Build the item for one classified call.
 *
 * `grantPaths` / `grantCommand` are what "always allow" would persist for
 * this item: the normalized paths for a file write, the allow-key for a
 * command or a path-less tool.
 */
export function writeGateItemFromClassification(
  toolName: string,
  classification: WriteCallClassification,
  cwd: string,
): WriteGateItem {
  const tool = String(toolName ?? "");
  const rawPaths = classification.paths.filter(
    (p) => typeof p === "string" && p.trim().length > 0,
  );
  const grantPaths = rawPaths
    .map((p) => normalizeWritePath(p, cwd))
    .filter((p) => p.length > 0);
  const item: WriteGateItem = {
    tool,
    target: rawPaths.length > 0 ? rawPaths.join(", ") : (classification.key ?? tool),
    why: classification.reason,
    key: writeGateTargetKey(tool, classification, cwd),
  };
  if (grantPaths.length > 0) item.grantPaths = grantPaths;
  else if (classification.key) item.grantCommand = classification.key;
  return item;
}

/** Which "always allow" label fits a set of items. */
export function writeGateItemsKind(
  items: readonly WriteGateItem[],
): WriteGateOptionKind {
  const paths = items.filter((i) => (i.grantPaths?.length ?? 0) > 0);
  const commands = items.filter((i) => Boolean(i.grantCommand));
  if (paths.length > 0 && commands.length > 0) return "mixed";
  if (paths.length > 0) return paths.length === 1 ? "path" : "paths";
  if (commands.length > 0) return commands.length === 1 ? "command" : "commands";
  return "path";
}

/**
 * The human list of the writes a dialog covers:
 * "edits src/a.ts; edits src/b.ts".
 */
export function describeWriteGateItems(
  items: readonly WriteGateItem[],
): string {
  return items
    .map((item) => {
      const why = String(item.why ?? "").trim();
      return why || String(item.target ?? "").trim();
    })
    .filter((text) => text.length > 0)
    .join("; ");
}

/**
 * The targets of a set of items, joined for the reason/guidance text:
 * "src/a.ts, src/b.ts".
 */
export function writeGateTargetsLabel(
  items: readonly WriteGateItem[],
): string {
  return items
    .map((item) => String(item.target ?? "").trim())
    .filter((text) => text.length > 0)
    .join(", ");
}

/**
 * The dialog title.
 *
 * One write keeps today's wording verbatim; several writes are listed, so
 * the user sees exactly what the answer covers.
 */
export function writeGateTitle(items: readonly WriteGateItem[]): string {
  if (items.length <= 1) {
    const only = items[0];
    const why = only?.why ? ` (${only.why})` : "";
    return `Write policy 'ask': allow this write${why}?`;
  }
  return (
    `Write policy 'ask': allow these ${items.length} writes? ` +
    `(${describeWriteGateItems(items)})`
  );
}

// ── Argument completions (/write-policy) ────────────────────────────

/** One /write-policy subcommand with its usage hint. */
const WRITE_POLICY_SUBS: readonly {
  name: string;
  label: string;
  description: string;
}[] = [
  {
    name: "allow",
    label: "allow",
    description: "the agent may write files freely",
  },
  {
    name: "ask",
    label: "ask",
    description: "every file write asks first",
  },
  {
    name: "never",
    label: "never",
    description: "the agent may not write files (use /build to execute)",
  },
];

const WRITE_POLICY_SCOPES: readonly {
  token: string;
  description: string;
}[] = [
  { token: "global", description: "write to ~/.pi/agent/settings.json" },
  { token: "project", description: "write to <cwd>/.pi/settings.json" },
];

/** write-policy subcommands take an optional scope → trailing-space values. */
const WRITE_POLICY_MODE_TOKENS: ReadonlySet<string> = new Set([
  "allow",
  "ask",
  "never",
]);

/**
 * Argument completions for `/write-policy` (pure; unit-tested in
 * edit-policy.test.ts).
 *
 * Follows the pi-tui full-argument contract (see `joinArgumentValue` and the
 * /mcp extension): the first token completes a mode, the second token
 * completes the write scope, and every returned `value` is the complete
 * replacement for the typed argument text (`"ask project"`, never
 * `"project"`). Returns null when nothing useful can be offered, including
 * when the typed token is already an exact unique match (exact-match
 * suppression — the dropdown closes so the first Enter submits).
 */
export function writePolicyArgumentCompletions(
  argumentPrefix: string,
): ArgumentCompletion[] | null {
  const raw = String(argumentPrefix ?? "");
  const join = (token: string) => joinArgumentValue(raw, token);

  // ── Subcommand position: no whitespace typed yet ────────────────────
  if (!raw.trim() || !/\s/.test(raw)) {
    const lower = raw.trim().toLowerCase();
    const matching = WRITE_POLICY_SUBS.filter((s) => s.name.startsWith(lower));
    if (matching.length === 0) return null;
    return matching.map((s) => ({
      value: `${s.name} `,
      label: s.label,
      description: s.description,
    }));
  }

  // ── Argument position: mode already committed → complete the scope ──
  const tokens = raw.trim().split(/\s+/).filter(Boolean);
  const mode = (tokens[0] ?? "").toLowerCase();
  if (!WRITE_POLICY_MODE_TOKENS.has(mode)) return null;
  const endsWithWs = /\s$/.test(raw);
  const partial = endsWithWs ? "" : (tokens[tokens.length - 1] ?? "");
  const items: ArgumentCompletion[] = WRITE_POLICY_SCOPES.flatMap((s) =>
    s.token.startsWith(partial.toLowerCase())
      ? [
          {
            value: join(s.token),
            label: s.token,
            description: s.description,
          },
        ]
      : [],
  );
  if (items.length === 0) return null;
  if (
    suppressExactArgumentMatch(
      items.map((i) => i.label),
      partial,
    )
  ) {
    return null;
  }
  return items;
}
