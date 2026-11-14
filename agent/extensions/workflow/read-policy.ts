/**
 * Workflow Extension — Read Policy
 *
 * Read-specific settings and the pure decision/dialog surface. The shared
 * folder scope, outside action and sensitive list live in `folder-policy.ts`;
 * this module only owns:
 *
 *   - read grants (`readPolicy.allowedPaths`), persisted at the same project
 *     scope as write/commit grants,
 *   - `shell: "paths" | "strict"` for the balanced/strict shell analysis,
 *   - `guardedTools`: extra tool names treated as read tools.
 *
 * The decision is pure: sensitive always blocks; outside asks/blocks per the
 * shared folder policy; a granted root allows; `shell: "strict"` turns an
 * unverifiable command into a question. The runtime in index.ts owns the UI.
 *
 * No Pi SDK imports at module scope — same discipline as edit-policy.ts.
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
import type {
  FolderPolicyConfig,
  FolderTarget,
  FolderOutsideAction,
} from "./folder-policy.ts";
import { grantRootForTarget } from "./folder-policy.ts";

/** Nested key under WORKFLOW_SETTINGS_KEY. */
export const READ_POLICY_KEY = "readPolicy";

export type ReadShellMode = "paths" | "strict";

export interface ReadPolicyConfig {
  /** Extra read-only roots, per capability. */
  allowedPaths: string[];
  shell: ReadShellMode;
  /** Extra tool names treated as read tools. */
  guardedTools: string[];
}

export const DEFAULT_READ_POLICY_CONFIG: Readonly<ReadPolicyConfig> = {
  allowedPaths: [],
  shell: "paths",
  guardedTools: [],
};

const SHELL_MODES: readonly ReadShellMode[] = ["paths", "strict"];

export type RawReadPolicySetting = JsonObject | string;

function coerceStringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim();
    if (!trimmed || out.includes(trimmed)) continue;
    out.push(trimmed);
  }
  return out;
}

function unionStrings(a: readonly string[], b: readonly string[]): string[] {
  const out = [...a];
  for (const item of b) if (!out.includes(item)) out.push(item);
  return out;
}

function coerceShell(value: unknown): ReadShellMode | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  return (SHELL_MODES as readonly string[]).includes(normalized)
    ? (normalized as ReadShellMode)
    : undefined;
}

/**
 * Coerce an untrusted `workflow.readPolicy` fragment. A bare string is accepted
 * as `{ shell: <string> }` for a minimal settings file.
 */
export function coerceReadPolicyConfig(
  raw: unknown,
  base: ReadPolicyConfig = DEFAULT_READ_POLICY_CONFIG as ReadPolicyConfig,
): ReadPolicyConfig {
  if (typeof raw === "string") {
    return { ...base, shell: coerceShell(raw) ?? base.shell };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ...base };
  }
  const obj = raw as JsonObject;
  return {
    allowedPaths:
      coerceStringList(obj.allowedPaths) ?? [...base.allowedPaths],
    shell: coerceShell(obj.shell) ?? base.shell,
    guardedTools:
      coerceStringList(obj.guardedTools) ?? [...base.guardedTools],
  };
}

export function extractReadPolicyRaw(
  settings: unknown,
): RawReadPolicySetting | undefined {
  if (!settings || typeof settings !== "object" || Array.isArray(settings))
    return undefined;
  const wf = (settings as JsonObject)[WORKFLOW_SETTINGS_KEY];
  if (!wf || typeof wf !== "object" || Array.isArray(wf)) return undefined;
  const raw = (wf as JsonObject)[READ_POLICY_KEY];
  if (typeof raw === "string") return raw;
  if (raw && typeof raw === "object" && !Array.isArray(raw))
    return raw as JsonObject;
  return undefined;
}

/** Merge global then project; shell is project-over-global, lists union. */
export function mergeReadPolicyConfig(
  globalRaw: unknown,
  projectRaw: unknown,
): ReadPolicyConfig {
  const fromGlobal = coerceReadPolicyConfig(globalRaw);
  const fromProject = coerceReadPolicyConfig(projectRaw, fromGlobal);
  return {
    allowedPaths: unionStrings(
      fromGlobal.allowedPaths,
      fromProject.allowedPaths,
    ),
    shell: fromProject.shell,
    guardedTools: unionStrings(
      fromGlobal.guardedTools,
      fromProject.guardedTools,
    ),
  };
}

export interface ReadPolicyConfigPaths {
  global: string;
  project: string;
}

export function readPolicyConfigPaths(
  cwd: string,
  agentDir: string,
): ReadPolicyConfigPaths {
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

export type ReadPolicyScopeSource = "default" | "global" | "project";

export interface ResolvedReadPolicy {
  config: ReadPolicyConfig;
  sources: {
    global: boolean;
    project: boolean;
    projectIgnored: boolean;
    shell: ReadPolicyScopeSource;
  };
}

/** Resolve read settings; project settings ignored unless trusted. */
export function readReadPolicyConfig(
  cwd: string,
  agentDir: string,
  options: { trusted?: boolean } = {},
): ResolvedReadPolicy {
  const paths = readPolicyConfigPaths(cwd, agentDir);
  const globalRaw = extractReadPolicyRaw(readJsonSafe(paths.global));
  const projectRaw = extractReadPolicyRaw(readJsonSafe(paths.project));
  const trusted = options.trusted === true;
  const effectiveProjectRaw = trusted ? projectRaw : undefined;
  const shellSource: ReadPolicyScopeSource =
    typeof effectiveProjectRaw === "object" &&
    effectiveProjectRaw &&
    coerceShell((effectiveProjectRaw as JsonObject).shell)
      ? "project"
      : typeof globalRaw === "object" &&
          globalRaw &&
          coerceShell((globalRaw as JsonObject).shell)
        ? "global"
        : "default";
  return {
    config: mergeReadPolicyConfig(globalRaw, effectiveProjectRaw),
    sources: {
      global: globalRaw !== undefined,
      project: projectRaw !== undefined,
      projectIgnored: projectRaw !== undefined && !trusted,
      shell: shellSource,
    },
  };
}

/**
 * Read-modify-write `workflow.readPolicy`. Preserves every other key. The
 * lists are additive; `shell` is replaced.
 */
export function writeReadPolicyConfig(
  scope: "global" | "project",
  cwd: string,
  agentDir: string,
  patch: Partial<ReadPolicyConfig>,
): { path: string; ok: boolean; error?: string } {
  const paths = readPolicyConfigPaths(cwd, agentDir);
  const fp = scope === "project" ? paths.project : paths.global;
  if (process.env.PI_FOLDER_POLICY_LOCKED === "1") {
    return {
      path: fp,
      ok: false,
      error: "read policy is locked for this subagent",
    };
  }
  try {
    const existing = readJsonSafe(fp);
    const root: JsonObject = existing ? { ...existing } : {};
    const wfExisting = root[WORKFLOW_SETTINGS_KEY];
    const wf: JsonObject =
      wfExisting && typeof wfExisting === "object" && !Array.isArray(wfExisting)
        ? { ...(wfExisting as JsonObject) }
        : {};
    const current = coerceReadPolicyConfig(wf[READ_POLICY_KEY]);
    const next: ReadPolicyConfig = {
      allowedPaths: unionStrings(
        current.allowedPaths,
        coerceStringList(patch.allowedPaths) ?? [],
      ),
      shell: coerceShell(patch.shell) ?? current.shell,
      guardedTools: unionStrings(
        current.guardedTools,
        coerceStringList(patch.guardedTools) ?? [],
      ),
    };
    wf[READ_POLICY_KEY] = next;
    root[WORKFLOW_SETTINGS_KEY] = wf;
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, `${JSON.stringify(root, null, 2)}\n`, "utf8");
    return { path: fp, ok: true };
  } catch (error: unknown) {
    return {
      path: fp,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Remove one exact read grant. Lists are otherwise additive. */
export function revokeReadPolicyPath(
  scope: "global" | "project",
  cwd: string,
  agentDir: string,
  grant: string,
): { path: string; ok: boolean; removed: boolean; error?: string } {
  const paths = readPolicyConfigPaths(cwd, agentDir);
  const fp = scope === "project" ? paths.project : paths.global;
  if (process.env.PI_FOLDER_POLICY_LOCKED === "1") {
    return {
      path: fp,
      ok: false,
      removed: false,
      error: "read policy is locked for this subagent",
    };
  }
  try {
    const existing = readJsonSafe(fp);
    const root: JsonObject = existing ? { ...existing } : {};
    const wfExisting = root[WORKFLOW_SETTINGS_KEY];
    const wf: JsonObject =
      wfExisting && typeof wfExisting === "object" && !Array.isArray(wfExisting)
        ? { ...(wfExisting as JsonObject) }
        : {};
    const current = coerceReadPolicyConfig(wf[READ_POLICY_KEY]);
    const target = grant.trim();
    const nextPaths = current.allowedPaths.filter(
      (entry) => entry.trim() !== target,
    );
    const removed = nextPaths.length !== current.allowedPaths.length;
    wf[READ_POLICY_KEY] = { ...current, allowedPaths: nextPaths };
    root[WORKFLOW_SETTINGS_KEY] = wf;
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, `${JSON.stringify(root, null, 2)}\n`, "utf8");
    return { path: fp, ok: true, removed };
  } catch (error: unknown) {
    return {
      path: fp,
      ok: false,
      removed: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// ── Decision table ───────────────────────────────────────────────────

export type ReadGateDecision = "allow" | "ask" | "block";

export interface ReadGateInput {
  /** A target matches the sensitive deny list. */
  sensitive: boolean;
  /** A target is outside the folder roots. */
  outside: boolean;
  outsideAction: FolderOutsideAction;
  /** A turn grant / allowedPaths entry already covers every outside target. */
  granted?: boolean;
  /** The shell analyzer could not verify the command. */
  uncertain?: boolean;
  shell: ReadShellMode;
}

/**
 *   sensitive            → block (never softened by a grant)
 *   outside + block      → block
 *   outside + ask        → ask unless already granted
 *   uncertain + strict   → ask
 *   otherwise            → allow
 */
export function decideReadGate(input: ReadGateInput): ReadGateDecision {
  if (input.sensitive) return "block";
  if (input.outside) {
    if (input.outsideAction === "block") return "block";
    if (!input.granted) return "ask";
  }
  if (input.uncertain && input.shell === "strict") return "ask";
  return "allow";
}

/** Human-readable summary of the read shell mode. */
export function describeReadShellMode(mode: ReadShellMode): string {
  return mode === "strict"
    ? "recognized reads are path-gated; unverifiable commands ask first"
    : "recognized reads are path-gated; unverifiable commands are documented residual";
}

// ── Dialog / denial helpers ─────────────────────────────────────────

export const READ_INSTRUCTION_MAX_LEN = 2000;
export const READ_DENY_WITH_INSTRUCTIONS_PREFIX = "Deny with";
export const READ_DENY_WITH_INSTRUCTIONS_LABEL = `${READ_DENY_WITH_INSTRUCTIONS_PREFIX} instructions…`;
export const READ_INSTRUCTION_PROMPT_TITLE =
  "Read denied — tell the agent how to proceed";
export const READ_INSTRUCTION_PROMPT_PLACEHOLDER =
  "e.g. only use that folder for reference, do not copy secrets";

export type ReadGateItemKind = "folder" | "folders" | "command" | "commands" | "mixed";

export interface ReadGateItem {
  tool: string;
  target: FolderTarget;
  /** Folder root a persistent grant would add ("" for uncertain commands). */
  grantRoot: string;
  /** Why the item is gated. */
  why: string;
  key: string;
}

export type ReadGateChoice =
  | "allow-once"
  | "always"
  | "deny-with-instructions"
  | "deny";

/** Labels for the ask dialog; the parser and the UI share this table. */
export function readGateOptions(kind: ReadGateItemKind): readonly string[] {
  const always =
    kind === "folder"
      ? "Always allow this folder"
      : kind === "folders"
        ? "Always allow these folders"
        : kind === "mixed"
          ? "Always allow these folders"
          : "";
  return [
    "Allow once (this turn)",
    ...(always ? [always] : []),
    "Deny",
    READ_DENY_WITH_INSTRUCTIONS_LABEL,
  ];
}

/** The “Always allow…” label for a kind (empty for command-only). */
export function readGateAlwaysLabel(kind: ReadGateItemKind): string {
  if (kind === "command" || kind === "commands") return "";
  return readGateOptions(kind)[1] ?? "";
}

/** Parse a dialog answer; unknown/cancel/empty fail closed to deny. */
export function parseReadGateChoice(choice: unknown): ReadGateChoice {
  const text = String(choice ?? "").trim();
  if (text.startsWith("Allow once")) return "allow-once";
  if (text.startsWith("Always allow")) return "always";
  if (text.startsWith(READ_DENY_WITH_INSTRUCTIONS_PREFIX))
    return "deny-with-instructions";
  return "deny";
}

/** Normalise a free-text denial instruction. */
export function sanitizeReadInstruction(raw: unknown): string {
  let text = String(raw ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .trim();
  if (text.length > READ_INSTRUCTION_MAX_LEN)
    text = `${text.slice(0, READ_INSTRUCTION_MAX_LEN)}…`;
  return text;
}

export interface ReadDenyReasonInput {
  kind: "sensitive" | "outside" | "uncertain" | "blocked";
  target: string;
  pattern?: string;
  outsideAction?: FolderOutsideAction;
  instruction?: string;
}

/** Build the tool-result reason for a read refusal. */
export function buildReadDenyReason(input: ReadDenyReasonInput): string {
  const instruction = input.instruction?.trim();
  const guidance = instruction
    ? ` The user's instruction:\n\n${instruction}\n\nDo not retry this read. Follow the instruction above. If it cannot be followed, say so and stop.`
    : "";
  switch (input.kind) {
    case "sensitive":
      return (
        `Read policy: \`${input.target}\` is a sensitive file` +
        (input.pattern ? ` (${input.pattern})` : "") +
        ". This cannot be overridden by a folder grant. Do not retry; ask the user if they want to add a manual `sensitiveExemptions` entry." +
        guidance
      );
    case "blocked":
      return (
        `Read policy: \`${input.target}\` is outside the permitted folders and the folder policy is 'block'. Do not retry. Ask the user to open the project at that folder or change /folder-policy.` +
        guidance
      );
    case "uncertain":
      return (
        `Read policy 'strict': the command's file access could not be verified (\`${input.target}\`). Do not retry the same form; use a recognized read tool/command, or ask the user to run it.` +
        guidance
      );
    case "outside":
    default:
      return (
        `Read policy: \`${input.target}\` is outside the permitted folders. Do not retry. Ask the user for access (allow once, always allow the folder, or /folder-policy), or use the current repository folder.` +
        guidance
      );
  }
}

/** Build the user-role message for deny-with-instructions. */
export function buildReadGuidanceMessage(input: {
  target: string;
  instruction: string;
}): string {
  return (
    `[read denied — the user asked you to do something different]\n` +
    `The user denied the read of ${input.target}. Their instruction:\n\n` +
    `${input.instruction.trim()}`
  );
}

/** Stable key for a gated read target (turn grants / run denials). */
export function readGateTargetKey(target: FolderTarget): string {
  return `path:${target.path}`;
}

/** Build a gate item from a target; primary for the dialog and grants. */
export function readGateItemFromTarget(
  tool: string,
  target: FolderTarget,
  why: string,
): ReadGateItem {
  const grantRoot = grantRootForTarget(target);
  return {
    tool,
    target,
    grantRoot,
    why,
    key: readGateTargetKey(target),
  };
}

export function readGateItemsKind(items: readonly ReadGateItem[]): ReadGateItemKind {
  const folders = items.filter((item) => item.grantRoot);
  const commands = items.filter((item) => !item.grantRoot);
  if (folders.length > 0 && commands.length > 0) return "mixed";
  if (folders.length === 1) return "folder";
  if (folders.length > 1) return "folders";
  if (commands.length === 1) return "command";
  return "commands";
}

export function describeReadGateItems(items: readonly ReadGateItem[]): string {
  const folders = [...new Set(items.map((item) => item.grantRoot).filter(Boolean))];
  const commands = items.filter((item) => !item.grantRoot).length;
  const parts: string[] = [];
  if (folders.length > 0) parts.push(`${folders.length} folder(s)`);
  if (commands > 0) parts.push(`${commands} unverified command(s)`);
  return parts.join(" + ") || "no targets";
}

export function readGateTargetsLabel(items: readonly ReadGateItem[]): string {
  const labels = items.map((item) => item.grantRoot || item.target.path);
  const unique = [...new Set(labels)];
  const shown = unique.slice(0, 4).join(", ");
  return unique.length > 4 ? `${shown}, …` : shown;
}

export function readGateTitle(items: readonly ReadGateItem[]): string {
  return `Read policy: allow ${describeReadGateItems(items)}?`;
}

/** Grant root for a dialog target; exported from folder-policy for callers. */
export { grantRootForTarget };

// ── /read-policy completions ────────────────────────────────────────

const READ_POLICY_SUBS: readonly {
  name: string;
  description: string;
}[] = [
  { name: "status", description: "show read grants, shell mode and the shared folder scope" },
  { name: "allow", description: "add a read-only folder/file grant" },
  { name: "revoke", description: "remove a read grant" },
  { name: "shell", description: "paths (balanced) or strict" },
  { name: "guard", description: "add a tool name that must be read-guarded" },
];

const READ_SCOPES: readonly string[] = ["global", "project"];

/** Full-argument completions for `/read-policy`. */
export function readPolicyArgumentCompletions(
  prefix: string,
): ArgumentCompletion[] | null {
  const text = String(prefix ?? "");
  const trailing = /\s$/.test(text);
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  const committed = trailing ? tokens : tokens.slice(0, -1);
  const partial = trailing ? "" : (tokens[tokens.length - 1] ?? "");
  const first = committed[0] ?? "";
  const candidates: { value: string; description?: string }[] = [];
  const add = (value: string, description?: string) =>
    candidates.push({ value, description });

  if (committed.length === 0) {
    for (const sub of READ_POLICY_SUBS) add(sub.name, sub.description);
  } else if (committed.length === 1) {
    if (first === "shell") {
      add("paths", "gate recognized reads; unknown commands are residual");
      add("strict", "also ask for interpreter/inline/unverifiable commands");
    } else if (first === "allow" || first === "revoke" || first === "guard") {
      // Path/tool value is free text; scope follows.
    }
  } else if (
    committed.length === 2 &&
    ["allow", "revoke", "shell", "guard"].includes(first)
  ) {
    for (const scope of READ_SCOPES) add(scope);
  }

  const filtered = candidates.filter((candidate) =>
    candidate.value.toLowerCase().startsWith(partial.toLowerCase()),
  );
  if (filtered.length === 0) return null;
  if (
    suppressExactArgumentMatch(
      filtered.map((candidate) => candidate.value),
      partial,
    )
  )
    return null;
  return filtered.map((candidate) => ({
    value: joinArgumentValue(text, candidate.value),
    label: candidate.value,
    ...(candidate.description ? { description: candidate.description } : {}),
  }));
}

/** A concise status line for /read-policy (folder mode comes from folderPolicy). */
export function describeReadPolicy(
  config: ReadPolicyConfig,
  folder: FolderPolicyConfig,
): string {
  const grants =
    config.allowedPaths.length > 0 ? config.allowedPaths.join(", ") : "none";
  return (
    `Read policy: shared folder scope '${folder.mode}' (${folder.outside}); ` +
    `shell '${config.shell}'; grants: ${grants}`
  );
}
