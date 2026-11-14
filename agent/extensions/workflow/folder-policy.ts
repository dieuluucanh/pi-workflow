/**
 * Workflow Extension — Shared Folder Policy
 *
 * One folder permission floor for every workflow policy:
 *
 *   mode "repo" (default) — the nearest git repository root (fallback: cwd)
 *   mode "cwd"           — exactly the session working directory
 *   mode "parent"        — the parent of the repo/cwd base (siblings)
 *   mode "any"           — no folder containment (sensitive files still blocked)
 *
 * `outside` decides what happens beyond the allowed roots:
 *
 *   "ask"   — prompt (allow once / always / deny); headless fails closed
 *   "block" — refuse without asking
 *
 * WHY THIS EXISTS: write and commit were the only policies, and each had its
 * own path behaviour. `writePolicy: "allow"` could write anywhere; commit
 * only inspected the git subcommand, so `git -C ../other commit` looked like a
 * local commit. Reads were not gated at all. This module is the single floor
 * all three consult. A policy may be stricter than this floor; it can never be
 * looser.
 *
 * Sensitive files (`.env`, credentials, keys, cloud/ssh stores) are a
 * capability-shared deny list. A folder grant never softens it: the sensitive
 * check runs before containment and before any policy grant.
 *
 * Settings live under `workflow.folderPolicy` in `~/.pi/agent/settings.json`
 * (global) or `<cwd>/.pi/settings.json` (project). Project settings are only
 * honoured when the caller says the project is trusted. Writes preserve every
 * other key in the settings file.
 *
 * This module holds the pure/I-O-light parts (config, path canonicalisation,
 * repo-root detection, sensitive matching, the folder decision) so they can
 * be unit-tested without a Pi runtime. Nothing here imports the Pi SDK.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { ArgumentCompletion } from "./utils.ts";
import {
  joinArgumentValue,
  suppressExactArgumentMatch,
  translateForeignPath,
} from "./utils.ts";
import {
  COMMIT_CONFIG_DIR,
  WORKFLOW_SETTINGS_KEY,
  type JsonObject,
} from "./commit-policy.ts";

/** Nested key under WORKFLOW_SETTINGS_KEY. */
export const FOLDER_POLICY_KEY = "folderPolicy";

/** Which base folder the floor is anchored to. */
export type FolderPolicyMode = "repo" | "cwd" | "parent" | "any";

/** What happens when a target is outside the allowed roots. */
export type FolderOutsideAction = "ask" | "block";

/** Where "Always allow" dialogs persist new grants. */
export type FolderGrantScope = "project" | "global";

/** Whether the default `.env.example`-style exemptions are active. */
export type FolderSensitiveTemplates = "allow" | "block";

export interface FolderPolicyConfig {
  mode: FolderPolicyMode;
  outside: FolderOutsideAction;
  grantScope: FolderGrantScope;
  sensitiveTemplates: FolderSensitiveTemplates;
  /** Extra glob patterns denied in every policy. */
  sensitivePatterns: string[];
  /** Manual glob exemptions. No dialog writes this list. */
  sensitiveExemptions: string[];
}

export const DEFAULT_FOLDER_POLICY_CONFIG: Readonly<FolderPolicyConfig> = {
  mode: "repo",
  outside: "ask",
  grantScope: "project",
  sensitiveTemplates: "allow",
  sensitivePatterns: [],
  sensitiveExemptions: [],
};

const FOLDER_POLICY_MODES: readonly FolderPolicyMode[] = [
  "repo",
  "cwd",
  "parent",
  "any",
];
const OUTSIDE_ACTIONS: readonly FolderOutsideAction[] = ["ask", "block"];
const GRANT_SCOPES: readonly FolderGrantScope[] = ["project", "global"];
const TEMPLATE_MODES: readonly FolderSensitiveTemplates[] = ["allow", "block"];

/**
 * The default sensitive deny list. Patterns use forward slashes and are
 * matched as path suffixes, so `**\/.env` matches `.env` at any depth.
 * Directory rules are listed twice for the directory itself and descendants.
 */
export const DEFAULT_SENSITIVE_PATTERNS: readonly string[] = [
  "**/.env",
  "**/.env.*",
  "**/.envrc",
  "**/.envrc.*",
  "**/.npmrc",
  "**/.yarnrc",
  "**/.yarnrc.yml",
  "**/.pypirc",
  "**/.netrc",
  "**/_netrc",
  "**/.git-credentials",
  "**/.authinfo",
  "**/.git/config",
  "**/.git/credentials",
  "**/.docker/config.json",
  "**/auth.json",
  "**/credentials.json",
  "**/credentials.yml",
  "**/credentials.yaml",
  "**/secrets.json",
  "**/secrets.yml",
  "**/secrets.yaml",
  "**/secrets.toml",
  "**/secrets.ini",
  "**/service-account*.json",
  "**/*-credentials.json",
  "**/*-service-account.json",
  "**/id_rsa",
  "**/id_dsa",
  "**/id_ecdsa",
  "**/id_ed25519",
  "**/id_ecdsa_sk",
  "**/id_ed25519_sk",
  "**/*.pem",
  "**/*.key",
  "**/*.p12",
  "**/*.pfx",
  "**/*.jks",
  "**/*.keystore",
  "**/*.kdbx",
  "**/*.kdb",
  "**/*.ppk",
  "**/*.p8",
  "**/*.ovpn",
  "**/*.mobileprovision",
  "**/*.tfvars",
  "**/*.tfstate",
  "**/*.tfstate.backup",
  "**/*.secret",
  "**/*.secrets",
  "**/.pgpass",
  "**/.my.cnf",
  "**/.htpasswd",
  "**/*.jwk",
  "**/.ssh",
  "**/.ssh/**",
  "**/.gnupg",
  "**/.gnupg/**",
  "**/.aws",
  "**/.aws/**",
  "**/.azure",
  "**/.azure/**",
  "**/.kube",
  "**/.kube/**",
  "**/.password-store",
  "**/.password-store/**",
  "**/.terraform",
  "**/.terraform/**",
  "**/.config/gh",
  "**/.config/gh/**",
  "**/.config/gcloud",
  "**/.config/gcloud/**",
  "**/.config/sops",
  "**/.config/sops/**",
  "**/.config/rclone",
  "**/.config/rclone/**",
  "**/Library/Keychains",
  "**/Library/Keychains/**",
  "**/AppData/Roaming/Microsoft/Credentials",
  "**/AppData/Roaming/Microsoft/Credentials/**",
  "**/AppData/Local/Microsoft/Credentials",
  "**/AppData/Local/Microsoft/Credentials/**",
];

/** Templates that are safe by default; removed by `sensitiveTemplates: "block"`. */
export const DEFAULT_SENSITIVE_EXEMPTIONS: readonly string[] = [
  "**/.env.example",
  "**/.env.sample",
  "**/.env.template",
  "**/.env.dist",
];

/** A raw `workflow.folderPolicy` fragment (object or bare mode string). */
export type RawFolderPolicySetting = JsonObject | string;

function coerceEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
): T | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  return (allowed as readonly string[]).includes(normalized)
    ? (normalized as T)
    : undefined;
}

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

/** Coerce an untrusted fragment into a complete FolderPolicyConfig. */
export function coerceFolderPolicyConfig(
  raw: unknown,
  base: FolderPolicyConfig = DEFAULT_FOLDER_POLICY_CONFIG as FolderPolicyConfig,
): FolderPolicyConfig {
  if (typeof raw === "string") {
    const mode = coerceEnum(raw, FOLDER_POLICY_MODES);
    return { ...base, mode: mode ?? base.mode };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ...base };
  }
  const obj = raw as JsonObject;
  return {
    mode: coerceEnum(obj.mode, FOLDER_POLICY_MODES) ?? base.mode,
    outside: coerceEnum(obj.outside, OUTSIDE_ACTIONS) ?? base.outside,
    grantScope: coerceEnum(obj.grantScope, GRANT_SCOPES) ?? base.grantScope,
    sensitiveTemplates:
      coerceEnum(obj.sensitiveTemplates, TEMPLATE_MODES) ??
      base.sensitiveTemplates,
    sensitivePatterns:
      coerceStringList(obj.sensitivePatterns) ?? [...base.sensitivePatterns],
    sensitiveExemptions:
      coerceStringList(obj.sensitiveExemptions) ??
      [...base.sensitiveExemptions],
  };
}

/** Extract the `workflow.folderPolicy` fragment from a raw settings object. */
export function extractFolderPolicyRaw(
  settings: unknown,
): RawFolderPolicySetting | undefined {
  if (!settings || typeof settings !== "object" || Array.isArray(settings))
    return undefined;
  const wf = (settings as JsonObject)[WORKFLOW_SETTINGS_KEY];
  if (!wf || typeof wf !== "object" || Array.isArray(wf)) return undefined;
  const raw = (wf as JsonObject)[FOLDER_POLICY_KEY];
  if (typeof raw === "string") return raw;
  if (raw && typeof raw === "object" && !Array.isArray(raw))
    return raw as JsonObject;
  return undefined;
}

/** Merge global then project fragments; scalars project-over-global, lists union. */
export function mergeFolderPolicyConfig(
  globalRaw: unknown,
  projectRaw: unknown,
): FolderPolicyConfig {
  const fromGlobal = coerceFolderPolicyConfig(globalRaw);
  const fromProject = coerceFolderPolicyConfig(projectRaw, fromGlobal);
  return {
    mode: fromProject.mode,
    outside: fromProject.outside,
    grantScope: fromProject.grantScope,
    sensitiveTemplates: fromProject.sensitiveTemplates,
    sensitivePatterns: unionStrings(
      fromGlobal.sensitivePatterns,
      fromProject.sensitivePatterns,
    ),
    sensitiveExemptions: unionStrings(
      fromGlobal.sensitiveExemptions,
      fromProject.sensitiveExemptions,
    ),
  };
}

export interface FolderPolicyConfigPaths {
  global: string;
  project: string;
}

export function folderPolicyConfigPaths(
  cwd: string,
  agentDir: string,
): FolderPolicyConfigPaths {
  const nativeCwd = translateForeignPath(cwd).path || cwd;
  const nativeAgentDir = translateForeignPath(agentDir).path || agentDir;
  return {
    global: path.join(nativeAgentDir, "settings.json"),
    project: path.join(nativeCwd, COMMIT_CONFIG_DIR, "settings.json"),
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

/** Which settings scope supplied a scalar value. */
export type FolderPolicyScopeSource = "default" | "global" | "project";

export function folderPolicyModeSourceOf(
  globalRaw: RawFolderPolicySetting | undefined,
  projectRaw: RawFolderPolicySetting | undefined,
): FolderPolicyScopeSource {
  const hasMode = (raw: unknown): boolean => {
    if (typeof raw === "string")
      return coerceEnum(raw, FOLDER_POLICY_MODES) !== undefined;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
    return (
      coerceEnum((raw as JsonObject).mode, FOLDER_POLICY_MODES) !== undefined
    );
  };
  if (hasMode(projectRaw)) return "project";
  if (hasMode(globalRaw)) return "global";
  return "default";
}

export interface FolderPolicyReadOptions {
  /** Project settings are ignored unless this is explicitly true. */
  trusted?: boolean;
}

export interface ResolvedFolderPolicy {
  config: FolderPolicyConfig;
  sources: {
    global: boolean;
    project: boolean;
    /** True when a project fragment existed but was ignored (untrusted). */
    projectIgnored: boolean;
    mode: FolderPolicyScopeSource;
  };
  /**
   * Present for spawned subagents: the parent-approved roots. When set, the
   * caller must pass these to resolveFolderRoots and ignore per-policy grants.
   */
  locked?: { roots: string[]; source: string };
}

function parseLockedRoots(raw: string | undefined): string[] | undefined {
  if (!raw || !raw.trim()) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return undefined;
    const out = parsed.filter(
      (item): item is string => typeof item === "string" && item.trim() !== "",
    );
    return out.length > 0 ? out : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve the effective folder policy from disk. Never throws. Corrupt or
 * missing files fall back to defaults. Project settings are ignored unless
 * `trusted` is true. A spawned subagent with `PI_FOLDER_POLICY_LOCKED=1` gets
 * the parent's roots and cannot read a more permissive project file.
 */
export function readFolderPolicyConfig(
  cwd: string,
  agentDir: string,
  options: FolderPolicyReadOptions = {},
): ResolvedFolderPolicy {
  const paths = folderPolicyConfigPaths(cwd, agentDir);
  const globalSettings = readJsonSafe(paths.global);
  const globalRaw = extractFolderPolicyRaw(globalSettings);

  const lockedRoots =
    process.env.PI_FOLDER_POLICY_LOCKED === "1"
      ? parseLockedRoots(process.env.PI_FOLDER_POLICY_ROOTS)
      : undefined;
  if (lockedRoots) {
    return {
      config: {
        ...DEFAULT_FOLDER_POLICY_CONFIG,
        mode: "cwd",
        outside: "block",
      },
      sources: {
        global: globalRaw !== undefined,
        project: false,
        projectIgnored: true,
        mode: "default",
      },
      locked: {
        roots: lockedRoots,
        source: process.env.PI_FOLDER_POLICY_SOURCE ?? "parent",
      },
    };
  }

  const projectSettings = readJsonSafe(paths.project);
  const projectRaw = extractFolderPolicyRaw(projectSettings);
  const trusted = options.trusted === true;
  const effectiveProjectRaw = trusted ? projectRaw : undefined;
  return {
    config: mergeFolderPolicyConfig(globalRaw, effectiveProjectRaw),
    sources: {
      global: globalRaw !== undefined,
      project: projectRaw !== undefined,
      projectIgnored: projectRaw !== undefined && !trusted,
      mode: folderPolicyModeSourceOf(globalRaw, effectiveProjectRaw),
    },
  };
}

/**
 * Read-modify-write `workflow.folderPolicy`. Preserves every other settings
 * key. Scalars are replaced; the two pattern lists are additive. Refuses to
 * write while a subagent lock is active.
 */
export function writeFolderPolicyConfig(
  scope: "global" | "project",
  cwd: string,
  agentDir: string,
  patch: Partial<FolderPolicyConfig>,
): { path: string; ok: boolean; error?: string } {
  const paths = folderPolicyConfigPaths(cwd, agentDir);
  const fp = scope === "project" ? paths.project : paths.global;
  if (process.env.PI_FOLDER_POLICY_LOCKED === "1") {
    return {
      path: fp,
      ok: false,
      error: "folder policy is locked for this subagent",
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
    const current = coerceFolderPolicyConfig(wf[FOLDER_POLICY_KEY]);
    const next: FolderPolicyConfig = {
      mode: coerceEnum(patch.mode, FOLDER_POLICY_MODES) ?? current.mode,
      outside:
        coerceEnum(patch.outside, OUTSIDE_ACTIONS) ?? current.outside,
      grantScope:
        coerceEnum(patch.grantScope, GRANT_SCOPES) ?? current.grantScope,
      sensitiveTemplates:
        coerceEnum(patch.sensitiveTemplates, TEMPLATE_MODES) ??
        current.sensitiveTemplates,
      sensitivePatterns: unionStrings(
        current.sensitivePatterns,
        coerceStringList(patch.sensitivePatterns) ?? [],
      ),
      sensitiveExemptions: unionStrings(
        current.sensitiveExemptions,
        coerceStringList(patch.sensitiveExemptions) ?? [],
      ),
    };
    wf[FOLDER_POLICY_KEY] = next;
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

// ── Path canonicalisation ────────────────────────────────────────────

function isCaseInsensitivePlatform(): boolean {
  // Only Windows is case-insensitive by default. macOS APFS can be
  // case-sensitive; lowercasing there merged distinct paths. realpath handles
  // the actual filesystem identity.
  return process.platform === "win32";
}

/** Strip a Windows extended-length prefix from a realpath result. */
export function stripWindowsPrefix(value: string): string {
  let out = value;
  if (out.startsWith("\\\\?\\UNC\\")) out = `\\\\${out.slice(8)}`;
  else if (out.startsWith("\\\\?\\")) out = out.slice(4);
  return out;
}

export function toPosixPath(value: string): string {
  return value.replace(/\\/g, "/");
}

/** Expand a leading `~` (the whole path or `~/` / `~\`). */
export function expandTilde(value: string): string {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

/** The Pi read tool accepts an `@` prefix; strip it for path matching. */
export function stripAtPrefix(value: string): string {
  return value.startsWith("@") ? value.slice(1) : value;
}

/**
 * Canonical comparison form: absolute, forward slashes, platform case, no
 * trailing separator (except a filesystem root). Empty input yields "".
 */
export function normalizePolicyPath(value: unknown, cwd: string): string {
  if (typeof value !== "string") return "";
  const raw = stripAtPrefix(expandTilde(value.trim()));
  if (!raw) return "";
  const foreign = translateForeignPath(raw);
  const translated = foreign.path || raw;
  const base = cwd && cwd.trim() ? cwd : process.cwd();
  let resolved: string;
  try {
    resolved = path.resolve(base, translated);
  } catch {
    resolved = translated;
  }
  let normalized = toPosixPath(stripWindowsPrefix(resolved));
  if (isCaseInsensitivePlatform()) normalized = normalized.toLowerCase();
  while (
    normalized.length > 1 &&
    normalized.endsWith("/") &&
    !/^[a-z]:\/$/.test(normalized) &&
    normalized !== "//"
  ) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
}

/**
 * Resolve symlinks/junctions. If the target does not exist, resolve the
 * nearest existing ancestor and append the remainder. `resolved` is false
 * when no ancestor could be canonicalised (the caller should treat that as
 * an uncertain boundary, not silently trust the lexical path).
 */
export function canonicalizePolicyPath(
  value: unknown,
  cwd: string,
): { path: string; resolved: boolean } {
  const lexical = normalizePolicyPath(value, cwd);
  if (!lexical) return { path: "", resolved: false };
  const native = lexical.replace(/\//g, path.sep);
  try {
    const real = fs.realpathSync.native(native);
    return { path: normalizePolicyPath(real, cwd), resolved: true };
  } catch {
    // Walk up to the nearest existing ancestor, then append the remainder.
    const parts: string[] = [];
    let current = native;
    while (true) {
      try {
        const real = fs.realpathSync.native(current);
        const joined = path.join(real, ...parts.reverse());
        return { path: normalizePolicyPath(joined, cwd), resolved: true };
      } catch {
        const parent = path.dirname(current);
        if (parent === current) break;
        parts.push(path.basename(current));
        current = parent;
      }
    }
    return { path: lexical, resolved: false };
  }
}

/** Compare two already-normalised paths on the current platform. */
export function samePolicyPath(a: string, b: string): boolean {
  return a === b;
}

/** True when `target` equals `root` or sits strictly inside it. */
export function isInsidePolicyPath(target: string, root: string): boolean {
  if (!target || !root) return false;
  if (target === root) return true;
  const rel = toPosixPath(path.relative(root, target));
  if (!rel) return true;
  return rel !== ".." && !rel.startsWith("../") && !path.isAbsolute(rel);
}

/** True when the target is inside at least one root. */
export function isInsideAnyRoot(
  target: string,
  roots: readonly string[],
): boolean {
  return roots.some((root) => isInsidePolicyPath(target, root));
}

/**
 * Walk up to the nearest `.git` directory or worktree `.git` file. Returns
 * the canonical repository root, or null when cwd is not in a repository.
 */
export function detectRepoRoot(cwd: string): string | null {
  let current = normalizePolicyPath(cwd, process.cwd());
  if (!current) return null;
  while (true) {
    const marker = current.replace(/\//g, path.sep);
    try {
      if (fs.existsSync(path.join(marker, ".git"))) {
        const canonical = canonicalizePolicyPath(current, cwd);
        return canonical.path || current;
      }
    } catch {
      /* keep walking */
    }
    const parent = path.dirname(marker);
    if (parent === marker) return null;
    current = normalizePolicyPath(parent, cwd);
    if (!current) return null;
  }
}

/** The base folder for a mode (before grants). */
export function baseFolderRoots(
  config: FolderPolicyConfig,
  cwd: string,
): string[] {
  const working = normalizePolicyPath(cwd, cwd);
  const repoBase = detectRepoRoot(cwd) ?? working;
  switch (config.mode) {
    case "repo":
      return [repoBase];
    case "cwd":
      return [working];
    case "parent": {
      const parent = path.dirname(repoBase.replace(/\//g, path.sep));
      return [normalizePolicyPath(parent, cwd)];
    }
    case "any":
    default:
      return [];
  }
}

export interface ResolvedFolderRoots {
  lexical: string[];
  canonical: string[];
  unrestricted: boolean;
}

/**
 * Turn a policy + per-capability grants into comparable roots. When
 * `lockedRoots` is supplied (spawned subagent), it replaces the base and the
 * grants entirely: the child only gets what the parent approved.
 */
export function resolveFolderRoots(
  config: FolderPolicyConfig,
  grants: readonly string[],
  cwd: string,
  lockedRoots?: readonly string[],
): ResolvedFolderRoots {
  const raw =
    lockedRoots && lockedRoots.length > 0
      ? [...lockedRoots]
      : [...baseFolderRoots(config, cwd), ...grants];
  const lexical: string[] = [];
  const canonical: string[] = [];
  for (const entry of raw) {
    const normalized = normalizePolicyPath(entry, cwd);
    if (!normalized) continue;
    if (!lexical.includes(normalized)) lexical.push(normalized);
    const resolved = canonicalizePolicyPath(normalized, cwd);
    if (resolved.path && !canonical.includes(resolved.path))
      canonical.push(resolved.path);
  }
  return {
    lexical,
    canonical,
    unrestricted: config.mode === "any" && !lockedRoots?.length,
  };
}

/**
 * The folder a persistent "Always allow" grant should add for a target:
 * a directory targets itself, a file targets its containing directory, and a
 * glob targets its static prefix. Broad-root refusal is the caller's job.
 */
export function grantRootForTarget(target: FolderTarget): string {
  const value = target.path;
  if (!value) return "";
  const wildcard = value.search(/[?*[]/);
  if (wildcard >= 0) {
    const prefix = value.slice(0, wildcard).replace(/\/+$/, "");
    return prefix || value;
  }
  if (target.kind === "dir" || target.kind === "repo") return value;
  return toPosixPath(path.dirname(value.replace(/\//g, path.sep)));
}

/**
 * The “outside project” folder a grant should cover: the first path segment
 * below the deepest common ancestor of the base and the target. A file that
 * sits directly in that common ancestor is granted as the file itself; an
 * outside target that is an ancestor of the base is granted as itself.
 *
 * Returns undefined for a target inside the base (the caller keeps its
 * capability-specific grant, e.g. an exact write path).
 */
export function outsideProjectRootForTarget(
  target: FolderTarget,
  baseRoot: string,
): string | undefined {
  const base = normalizePolicyPath(baseRoot, baseRoot);
  const normalized = normalizePolicyPath(target.path, base || process.cwd());
  if (!base || !normalized) return undefined;
  if (isInsidePolicyPath(normalized, base)) return undefined;
  // A repository root above a cwd-mode session is itself the outside folder.
  if (isInsidePolicyPath(base, normalized)) return normalized;

  const baseParts = base.split("/").filter(Boolean);
  const targetParts = normalized.split("/").filter(Boolean);
  let common = 0;
  while (
    common < baseParts.length &&
    common < targetParts.length &&
    baseParts[common] === targetParts[common]
  ) {
    common++;
  }
  const commonRoot = baseParts.slice(0, common).join("/");
  const remaining = targetParts.slice(common);
  if (remaining.length === 0) return normalized;
  // Directly in the common ancestor: a file stays the file; a directory is
  // the directory; a glob/static prefix stays its prefix.
  if (remaining.length === 1) return normalized;
  const child = remaining[0];
  return commonRoot ? `${commonRoot}/${child}` : `/${child}`;
}

/** A broad grant: filesystem root, home, drive root, or depth ≤ 1. */
export function isBroadGrantRoot(value: string): boolean {
  const normalized = normalizePolicyPath(value, process.cwd());
  if (!normalized) return true;
  const root = normalizePolicyPath(path.parse(normalized).root, process.cwd());
  if (normalized === root) return true;
  const home = normalizePolicyPath(os.homedir(), process.cwd());
  if (home && (normalized === home || isInsidePolicyPath(home, normalized)))
    return true;
  const rel = toPosixPath(path.relative(root, normalized));
  const depth = rel.split("/").filter(Boolean).length;
  return depth <= 1;
}

/** UNC / network share detection (Windows and POSIX). */
export function isNetworkPath(value: string): boolean {
  const normalized = toPosixPath(value);
  if (normalized.startsWith("//")) return true;
  if (/^\/net\//.test(normalized)) return true;
  if (/^\\\\[^\\]/.test(value)) return true;
  return false;
}

// ── Sensitive matching ───────────────────────────────────────────────

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function globCoreToRegExp(pattern: string): string {
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        i++;
        if (pattern[i + 1] === "/") {
          i++;
          out += "(?:.*/)?";
        } else out += ".*";
      } else out += "[^/]*";
    } else if (ch === "?") out += "[^/]";
    else out += escapeRegExp(ch);
  }
  return out;
}

/** Compile one sensitive glob. Patterns are matched as path suffixes. */
export function globToRegExp(pattern: string): RegExp {
  let source = toPosixPath(pattern.trim());
  if (source.startsWith("./")) source = source.slice(2);
  if (!source) return /$^/;
  if (!source.includes("/")) {
    return new RegExp(`(?:^|/)${globCoreToRegExp(source)}$`, "i");
  }
  if (source.startsWith("**/")) source = source.slice(3);
  if (source.endsWith("/**")) {
    const head = source.slice(0, -3);
    return new RegExp(`(?:^|/)${globCoreToRegExp(head)}(?:/.*)?$`, "i");
  }
  return new RegExp(`(?:^|/)${globCoreToRegExp(source)}$`, "i");
}

export interface SensitiveMatch {
  sensitive: boolean;
  pattern?: string;
  path?: string;
}

function patternMatches(
  pattern: string,
  lexical: string,
  canonical: string,
  cwd: string,
): boolean {
  const re = globToRegExp(pattern);
  const rel = toPosixPath(path.relative(cwd, lexical));
  const candidates = [lexical, canonical, rel];
  return candidates.some((candidate) => candidate && re.test(candidate));
}

/** The effective deny patterns (defaults + extra, exemptions applied later). */
export function effectiveSensitivePatterns(
  config: FolderPolicyConfig,
): string[] {
  return unionStrings(DEFAULT_SENSITIVE_PATTERNS, config.sensitivePatterns);
}

/** The effective exemptions (default templates + manual exemptions). */
export function effectiveSensitiveExemptions(
  config: FolderPolicyConfig,
): string[] {
  const templates =
    config.sensitiveTemplates === "allow" ? [...DEFAULT_SENSITIVE_EXEMPTIONS] : [];
  return unionStrings(templates, config.sensitiveExemptions);
}

/** Match one path against the shared sensitive list. */
export function matchSensitivePath(
  value: unknown,
  config: FolderPolicyConfig,
  cwd: string,
): SensitiveMatch {
  const lexical = normalizePolicyPath(value, cwd);
  if (!lexical) return { sensitive: false };
  const canonical = canonicalizePolicyPath(lexical, cwd).path || lexical;
  for (const exemption of effectiveSensitiveExemptions(config)) {
    if (patternMatches(exemption, lexical, canonical, cwd))
      return { sensitive: false };
  }
  for (const pattern of effectiveSensitivePatterns(config)) {
    if (patternMatches(pattern, lexical, canonical, cwd)) {
      return { sensitive: true, pattern, path: lexical };
    }
  }
  return { sensitive: false };
}

// ── Folder evaluation / decision ─────────────────────────────────────

export type FolderTargetKind = "file" | "dir" | "repo" | "glob";

export interface FolderTarget {
  path: string;
  kind: FolderTargetKind;
  reason?: string;
}

export interface SensitiveTarget {
  path: string;
  pattern: string;
}

export interface FolderEvaluation {
  sensitive: SensitiveTarget[];
  outside: FolderTarget[];
  allowed: FolderTarget[];
  network: FolderTarget[];
  broad: FolderTarget[];
  uncertain: string[];
}

export interface FolderEvaluationOptions {
  config: FolderPolicyConfig;
  grants: readonly string[];
  cwd: string;
  /** Parent-approved roots for a locked subagent. */
  lockedRoots?: readonly string[];
  /** Only used for diagnostics; containment is the same for all actions. */
  action?: "read" | "write" | "commit";
}

function targetNormalized(target: FolderTarget, cwd: string): string {
  return normalizePolicyPath(target.path, cwd);
}

function isAllowedByRoots(
  lexical: string,
  canonical: string,
  roots: ResolvedFolderRoots,
): boolean {
  if (roots.unrestricted) return true;
  // Both the requested path and the resolved path must be inside a root.
  if (!isInsideAnyRoot(lexical, roots.lexical)) return false;
  if (canonical && !isInsideAnyRoot(canonical, roots.canonical)) return false;
  return true;
}

/**
 * Classify targets against the folder floor. Sensitive wins; network paths
 * need an explicit grant even in `any` mode; canonicalisation failures are
 * reported so the caller can ask instead of silently trusting them.
 */
export function evaluateFolderTargets(
  targets: readonly FolderTarget[],
  options: FolderEvaluationOptions,
): FolderEvaluation {
  const { config, grants, cwd, lockedRoots } = options;
  const roots = resolveFolderRoots(config, grants, cwd, lockedRoots);
  const evaluation: FolderEvaluation = {
    sensitive: [],
    outside: [],
    allowed: [],
    network: [],
    broad: [],
    uncertain: [],
  };
  for (const target of targets) {
    const lexical = targetNormalized(target, cwd);
    if (!lexical) {
      evaluation.uncertain.push("empty path");
      continue;
    }
    if (translateForeignPath(target.path).uncertain)
      evaluation.uncertain.push(lexical);
    const canonicalResult = canonicalizePolicyPath(lexical, cwd);
    const canonical = canonicalResult.path || lexical;
    const sensitive = matchSensitivePath(lexical, config, cwd);
    if (sensitive.sensitive) {
      evaluation.sensitive.push({
        path: lexical,
        pattern: sensitive.pattern ?? "sensitive",
      });
      continue;
    }
    if (isBroadGrantRoot(lexical)) evaluation.broad.push(target);
    const network = isNetworkPath(lexical) || isNetworkPath(canonical);
    if (network) evaluation.network.push(target);
    // Network paths need an explicit per-capability grant even in `any` mode.
    const networkGranted =
      isInsideAnyRoot(lexical, roots.lexical) ||
      (Boolean(canonical) && isInsideAnyRoot(canonical, roots.canonical));
    const allowed = network
      ? networkGranted
      : isAllowedByRoots(lexical, canonical, roots);
    if (!canonicalResult.resolved) {
      evaluation.uncertain.push(lexical);
      if (!allowed) evaluation.outside.push(target);
      else evaluation.allowed.push(target);
      continue;
    }
    if (allowed) evaluation.allowed.push(target);
    else evaluation.outside.push(target);
  }
  return evaluation;
}

export type FolderGateDecision = "allow" | "ask" | "block";

export interface FolderGateInput {
  sensitive: boolean;
  outside: boolean;
  outsideAction: FolderOutsideAction;
  /** An allow-once/always grant already covers every outside target. */
  granted?: boolean;
  network?: boolean;
  uncertain?: boolean;
}

/** Pure folder decision. Sensitive always wins; policy can never loosen it. */
export function decideFolderGate(input: FolderGateInput): FolderGateDecision {
  if (input.sensitive) return "block";
  if (input.outside) {
    if (input.outsideAction === "block") return "block";
    if (!input.granted) return "ask";
  }
  if (input.network && !input.granted) return "ask";
  if (input.uncertain) {
    // An unverifiable target follows the user's chosen outside action: a
    // policy of "block" must not open a dialog, and "ask" must ask.
    return input.outsideAction === "block" ? "block" : "ask";
  }
  return "allow";
}

/** Most restrictive wins: block > ask > allow. */
export function combineGateDecisions(
  ...decisions: readonly (FolderGateDecision | undefined)[]
): FolderGateDecision {
  let result: FolderGateDecision = "allow";
  for (const decision of decisions) {
    if (decision === "block") return "block";
    if (decision === "ask") result = "ask";
  }
  return result;
}

/** One-line human-readable summary of the folder mode. */
export function describeFolderPolicyMode(mode: FolderPolicyMode): string {
  switch (mode) {
    case "repo":
      return "the current repository root (or the working directory when not in git)";
    case "cwd":
      return "the session working directory only";
    case "parent":
      return "the parent of the repository/working-directory base (siblings)";
    case "any":
      return "any folder (sensitive files still blocked)";
    default:
      return "the current repository root";
  }
}

/**
 * Human-readable assessment of one folder evaluation, for `/permissions
 * explain` and the folder status output. Bounded so a broad command cannot
 * flood the transcript; `` allowed/outside/sensitive/uncertain counts are
 * always shown.
 */
export function describeFolderEvaluation(
  evaluation: FolderEvaluation,
  base: string,
): string[] {
  const MAX = 8;
  const lines = [
    `Folder base: ${base}`,
    `  targets: ${evaluation.allowed.length} inside, ${evaluation.outside.length} outside, ${evaluation.sensitive.length} sensitive, ${evaluation.uncertain.length} unverifiable`,
  ];
  const add = (label: string, values: readonly string[]) => {
    for (const value of values.slice(0, MAX)) lines.push(`  ${label}: ${value}`);
    if (values.length > MAX) {
      lines.push(`  ${label}: … and ${values.length - MAX} more`);
    }
  };
  add(
    "inside",
    evaluation.allowed.map((target) => target.path),
  );
  add(
    "outside",
    evaluation.outside.map((target) => target.path),
  );
  add(
    "network",
    evaluation.network.map((target) => target.path),
  );
  add(
    "sensitive",
    evaluation.sensitive.map((hit) => `${hit.path} (${hit.pattern})`),
  );
  add("unverifiable", evaluation.uncertain);
  return lines;
}

// ── /folder-policy completions ───────────────────────────────────────

const FOLDER_POLICY_SUBS: readonly {
  name: string;
  description: string;
}[] = [
  { name: "status", description: "show mode, outside, grants and sensitive rules" },
  { name: "repo", description: "only the nearest git repository root (default)" },
  { name: "cwd", description: "only the session working directory" },
  { name: "parent", description: "the parent folder (siblings) as well" },
  { name: "any", description: "no folder containment; sensitive files still blocked" },
  { name: "outside", description: "ask or block reads/writes/commits outside the roots" },
  { name: "grant", description: "project or global for 'Always allow' grants" },
  { name: "templates", description: "allow or block .env.example-style templates" },
  { name: "sensitive", description: "list or extend the sensitive deny list" },
];

const FOLDER_SCOPES: readonly string[] = ["global", "project"];

/**
 * Full-argument completions for `/folder-policy`, following pi's contract:
 * accepting a suggestion replaces the entire argument text.
 */
export function folderPolicyArgumentCompletions(
  prefix: string,
): ArgumentCompletion[] | null {
  const text = String(prefix ?? "");
  const trailing = /\s$/.test(text);
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  const committed = trailing ? tokens : tokens.slice(0, -1);
  const partial = trailing ? "" : (tokens[tokens.length - 1] ?? "");
  const first = committed[0] ?? "";

  const candidates: { value: string; label: string; description?: string }[] =
    [];
  const add = (value: string, description?: string) =>
    candidates.push({ value, label: value, description });

  if (committed.length === 0) {
    for (const sub of FOLDER_POLICY_SUBS) add(sub.name, sub.description);
  } else if (committed.length === 1) {
    if (first === "outside") {
      add("ask", "prompt once per turn; headless fails closed");
      add("block", "refuse outside without asking");
    } else if (first === "grant") {
      add("project", "persist new grants in <cwd>/.pi/settings.json");
      add("global", "persist new grants in ~/.pi/agent/settings.json");
    } else if (first === "templates") {
      add("allow", "allow .env.example/.sample/.template/.dist");
      add("block", "treat templates as sensitive");
    } else if (first === "sensitive") {
      add("add", "add an extra sensitive glob");
      add("allow", "add a manual exemption glob");
    } else if (["repo", "cwd", "parent", "any"].includes(first)) {
      for (const scope of FOLDER_SCOPES) add(scope);
    }
  } else if (committed.length === 2) {
    if (["outside", "grant", "templates", "sensitive"].includes(first)) {
      for (const scope of FOLDER_SCOPES) add(scope);
    }
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
    label: candidate.label,
    ...(candidate.description ? { description: candidate.description } : {}),
  }));
}
