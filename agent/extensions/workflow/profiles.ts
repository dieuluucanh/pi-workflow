/**
 * Workflow Extension — Model Profiles
 *
 * Named, switchable combinations of role model settings — a layer on top of
 * Model Roles (roles.ts):
 *
 *   planner  🧠   explorer  🔍   builder  🔨   reviewer  🧪
 *
 * - A profile stores exactly one {provider, id, thinking} per built-in role.
 *   Role identity (tools, systemPromptAddendum, description) is NOT part of a
 *   profile — it stays global in roles.json. A profile only overrides models.
 * - Persistence: ~/.pi/agent/profiles.json (user) + <cwd>/.pi/profiles.json
 *   (project override, merged by profile name, project wins). roles.json is
 *   never touched by this module.
 * - Activation is SESSION-scoped (index.ts keeps it in memory and mirrors it
 *   into the `workflow` session entry) so two concurrent sessions can run
 *   different profiles. The only global state here is the optional
 *   `workflow.defaultProfile` settings.json key, which seeds sessions that
 *   never made an explicit choice.
 * - Non-destructive loader: a missing, unreadable or incompatible
 *   profiles.json is never rewritten. A MISSING file is the normal
 *   "feature unused" state (info); corrupt/incompatible files surface a
 *   warning while the in-memory config stays empty.
 *
 * Pure, I/O-light module — unit-testable without a Pi runtime. It depends on
 * ./roles.ts only for shared types + display helpers (roles.ts has no import
 * side effects), and on ./commit-policy.ts for the shared settings constants.
 * Same discipline as commit-policy.ts / review.ts.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";

import type { Role, RoleModel, ThinkingLevel } from "./roles.ts";
import {
  BUILT_IN_ROLES,
  formatModelRef,
  isValidThinkingLevel,
  roleIcon,
} from "./roles.ts";
import { COMMIT_CONFIG_DIR, WORKFLOW_SETTINGS_KEY } from "./commit-policy.ts";
import type { ArgumentCompletion } from "./utils.ts";
import { joinArgumentValue, suppressExactArgumentMatch } from "./utils.ts";

// ── Types ────────────────────────────────────────────────────────────

/** The role names a profile may override — exactly the built-ins in v1. */
export const PROFILE_ROLES = BUILT_IN_ROLES;
export type ProfileRoleName = (typeof PROFILE_ROLES)[number];

export interface Profile {
  /** Stored as entered (trimmed); lookups are case-insensitive. */
  name: string;
  description: string;
  /** Partial by design: hand-edited files may override a subset of roles. */
  roles: Partial<Record<ProfileRoleName, RoleModel>>;
}

export interface ProfileConfig {
  version: number;
  profiles: Profile[];
}

export const PROFILE_CONFIG_VERSION = 1;

/** Profile names longer than this are rejected. */
export const MAX_PROFILE_NAME_LENGTH = 40;

/** Reserved words — they collide with `/profile use <name|none>` and `/role use` style keywords. */
export const RESERVED_PROFILE_NAMES: readonly string[] = ["none", "auto", "off"];

/** Fallback thinking level when a sanitized model omits an invalid one. */
const DEFAULT_THINKING: ThinkingLevel = "medium";

export function defaultProfileConfig(): ProfileConfig {
  return { version: PROFILE_CONFIG_VERSION, profiles: [] };
}

// ── Name validation ──────────────────────────────────────────────────

export type ProfileNameValidation =
  | { ok: true; value: string }
  | { ok: false; error: string };

/**
 * Validate a profile name: trimmed, non-empty, ≤ MAX_PROFILE_NAME_LENGTH,
 * no control characters, no whitespace (names must stay CLI-addressable —
 * slash-command args split on whitespace), not a reserved word, and not a
 * case-insensitive duplicate of an existing name. Pure.
 */
export function validateProfileName(
  name: string,
  existing?: readonly string[],
): ProfileNameValidation {
  const trimmed = String(name ?? "").trim();
  if (!trimmed) return { ok: false, error: "Profile name is empty." };
  if (trimmed.length > MAX_PROFILE_NAME_LENGTH) {
    return {
      ok: false,
      error: `Profile name is longer than ${MAX_PROFILE_NAME_LENGTH} characters.`,
    };
  }
  for (const ch of trimmed) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) {
      return {
        ok: false,
        error: "Profile name contains control characters.",
      };
    }
    if (/\s/.test(ch)) {
      return {
        ok: false,
        error:
          "Profile name must not contain whitespace — use dashes or underscores (e.g. cheap-synthetic).",
      };
    }
  }
  const lower = trimmed.toLowerCase();
  if ((RESERVED_PROFILE_NAMES as readonly string[]).includes(lower)) {
    return {
      ok: false,
      error: `"${lower}" is reserved (used by /profile use <name|none>).`,
    };
  }
  if (existing) {
    for (const e of existing) {
      if (String(e).trim().toLowerCase() === lower) {
        return {
          ok: false,
          error: `Profile "${e}" already exists (names are case-insensitive).`,
        };
      }
    }
  }
  return { ok: true, value: trimmed };
}

// ── Paths & persistence ──────────────────────────────────────────────

export function userProfilesPath(): string {
  return path.join(getAgentDir(), "profiles.json");
}

export function projectProfilesPath(cwd: string): string {
  return path.join(cwd, CONFIG_DIR_NAME, "profiles.json");
}

/** Optional path overrides (tests); production reads the real agent/cwd files. */
export interface ProfileConfigPathOverrides {
  userPath?: string;
  projectPath?: string;
}

function fileFingerprint(fp: string): string {
  try {
    const st = fs.statSync(fp);
    return `${st.mtimeMs}:${st.size}`;
  } catch (e: unknown) {
    const code = (e as { code?: string } | undefined)?.code;
    return code === "ENOENT" ? "missing" : "unreadable";
  }
}

/**
 * Cheap change detector for the two profiles files (existence + mtime + size),
 * mirroring rolesFingerprint. Compare two fingerprints to decide whether a
 * reload is needed. Never throws.
 */
export function profilesFingerprint(
  cwd?: string,
  overrides?: ProfileConfigPathOverrides,
): string {
  const user = fileFingerprint(overrides?.userPath ?? userProfilesPath());
  const projectPath =
    overrides?.projectPath ?? (cwd ? projectProfilesPath(cwd) : undefined);
  const project = projectPath ? fileFingerprint(projectPath) : "n/a";
  return `user:${user}|project:${project}`;
}

interface JsonFileRead {
  exists: boolean;
  raw?: unknown;
  error?: string;
}

function readJsonFileDetailed(fp: string): JsonFileRead {
  if (!fs.existsSync(fp)) return { exists: false };
  try {
    return { exists: true, raw: JSON.parse(fs.readFileSync(fp, "utf8")) };
  } catch (e: unknown) {
    return {
      exists: true,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

function isCurrentVersion(raw: any): boolean {
  return (
    raw &&
    typeof raw === "object" &&
    (raw as any).version === PROFILE_CONFIG_VERSION
  );
}

// ── Sanitizing (untrusted file content → Profile) ────────────────────

function sanitizeProfileModel(m: any): RoleModel | undefined {
  if (!m || typeof m.provider !== "string" || typeof m.id !== "string")
    return undefined;
  if (!m.provider.trim() || !m.id.trim()) return undefined;
  return {
    provider: m.provider.trim(),
    id: m.id.trim(),
    thinking: isValidThinkingLevel(String(m.thinking))
      ? (String(m.thinking) as ThinkingLevel)
      : DEFAULT_THINKING,
  };
}

/**
 * Coerce one untrusted entry into a Profile, or undefined when unusable.
 * Unknown role keys are dropped (v1 knows only the 4 built-ins); a profile
 * with zero usable role overrides is a no-op and is dropped entirely.
 * Never throws.
 */
export function sanitizeProfile(p: any): Profile | undefined {
  if (!p || typeof p.name !== "string") return undefined;
  // Uniqueness is enforced at merge time; here we only check intrinsic rules.
  const nameCheck = validateProfileName(p.name);
  if (!nameCheck.ok) return undefined;
  const rawRoles =
    p.roles && typeof p.roles === "object" && !Array.isArray(p.roles)
      ? p.roles
      : {};
  const roles: Partial<Record<ProfileRoleName, RoleModel>> = {};
  for (const roleName of PROFILE_ROLES) {
    const m = sanitizeProfileModel((rawRoles as any)[roleName]);
    if (m) roles[roleName] = m;
  }
  if (Object.keys(roles).length === 0) return undefined;
  return {
    name: nameCheck.value,
    description: typeof p.description === "string" ? p.description.trim() : "",
    roles,
  };
}

/** Role names a profile does not override (falls back to base roles at runtime). */
export function missingProfileRoles(p: Profile): ProfileRoleName[] {
  return PROFILE_ROLES.filter((r) => !p.roles[r]);
}

function mergeProfiles(base: Profile[], rawProfiles: unknown): Profile[] {
  if (!Array.isArray(rawProfiles)) return base;
  const byName = new Map<string, Profile>();
  for (const p of base) byName.set(p.name.toLowerCase(), p);
  for (const raw of rawProfiles as any[]) {
    const s = sanitizeProfile(raw);
    if (s) byName.set(s.name.toLowerCase(), s); // last wins, like roles.ts
  }
  return [...byName.values()];
}

// ── Load & save ──────────────────────────────────────────────────────

/** Result of {@link loadProfilesDetailed}. */
export interface LoadedProfilesConfig {
  config: ProfileConfig;
  /** True when neither file supplied a usable profile list. Normal when the feature is unused. */
  usedDefaults: boolean;
  /** Why the user file was skipped (missing / unreadable / legacy). */
  reason?: string;
  /** A MISSING file is "info" (normal empty state); corrupt/incompatible is "warning". */
  severity?: "info" | "warning";
  /** Fingerprint of the profiles files at read time (see profilesFingerprint). */
  fingerprint: string;
}

/**
 * Load the merged profile config (user file + project override, per-profile
 * replace). Non-destructive by design: a missing, unreadable, corrupt or
 * legacy `profiles.json` is never rewritten — in-memory defaults are used and
 * the reason is reported. Never throws.
 */
export function loadProfilesDetailed(
  cwd?: string,
  overrides?: ProfileConfigPathOverrides,
): LoadedProfilesConfig {
  const base = defaultProfileConfig();
  const fingerprint = profilesFingerprint(cwd, overrides);
  let reason: string | undefined;
  let severity: "info" | "warning" | undefined;
  let userUsable = false;

  const userPath = overrides?.userPath ?? userProfilesPath();
  const userRead = readJsonFileDetailed(userPath);
  if (!userRead.exists) {
    reason = `no profiles.json at ${userPath} — no profiles defined (roles.json flow stays active)`;
    severity = "info";
  } else if (userRead.error) {
    reason = `profiles.json is not valid JSON (${userRead.error}) — ignoring profiles`;
    severity = "warning";
  } else if (!isCurrentVersion(userRead.raw)) {
    const v = (userRead.raw as { version?: unknown } | undefined)?.version;
    reason = `incompatible profiles.json${
      v === undefined ? "" : ` (version ${String(v)})`
    } — ignoring profiles`;
    severity = "warning";
  } else {
    base.profiles = mergeProfiles(
      base.profiles,
      (userRead.raw as any).profiles,
    );
    userUsable = true;
  }

  // Project override: per-profile replace. A bad or legacy project file is
  // ignored and never rewritten (it is user-owned).
  let projectUsable = false;
  const projectPath =
    overrides?.projectPath ?? (cwd ? projectProfilesPath(cwd) : undefined);
  if (projectPath) {
    const projectRead = readJsonFileDetailed(projectPath);
    if (
      projectRead.exists &&
      !projectRead.error &&
      isCurrentVersion(projectRead.raw)
    ) {
      base.profiles = mergeProfiles(
        base.profiles,
        (projectRead.raw as any).profiles,
      );
      projectUsable = true;
    }
  }

  return {
    config: base,
    usedDefaults: !userUsable && !projectUsable,
    ...(reason === undefined ? {} : { reason }),
    ...(severity === undefined ? {} : { severity }),
    fingerprint,
  };
}

/** Convenience wrapper returning just the config. Never throws. */
export function loadProfiles(
  cwd?: string,
  overrides?: ProfileConfigPathOverrides,
): ProfileConfig {
  return loadProfilesDetailed(cwd, overrides).config;
}

export function saveProfiles(
  config: ProfileConfig,
  scope: "user" | "project",
  cwd?: string,
): void {
  const payload: ProfileConfig = {
    version: PROFILE_CONFIG_VERSION,
    profiles: config.profiles,
  };
  const fp =
    scope === "project" && cwd
      ? projectProfilesPath(cwd)
      : userProfilesPath();
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, JSON.stringify(payload, null, 2), "utf8");
}

// ── Lookup ───────────────────────────────────────────────────────────

export function getProfile(
  config: ProfileConfig,
  name: string,
): Profile | undefined {
  const target = String(name).trim().toLowerCase();
  if (!target) return undefined;
  return config.profiles.find((p) => p.name.toLowerCase() === target);
}

// ── Effective-roles overlay ──────────────────────────────────────────

/**
 * Apply a profile's model overrides to a base roles array. Pure: returns a
 * NEW array of NEW role objects; the inputs are never mutated. For each of
 * the 4 built-in roles present in the profile, the role's `model` is replaced
 * (provider/id/thinking); role identity (tools, systemPromptAddendum,
 * description, builtIn) always comes from the base. A missing/null profile
 * yields a shallow copy that is behaviourally identical to the base — this is
 * the "no profile active → roles.json flow" fallback.
 */
export function applyProfileOverlay(
  baseRoles: Role[],
  profile: Profile | null | undefined,
): Role[] {
  const roles = baseRoles.map((r) => ({ ...r }));
  if (!profile) return roles;
  for (const roleName of PROFILE_ROLES) {
    const override = profile.roles[roleName];
    if (!override) continue;
    const role = roles.find((r) => r.name.toLowerCase() === roleName);
    if (!role) continue;
    role.model = { ...override };
  }
  return roles;
}

// ── Display ──────────────────────────────────────────────────────────

/** One-line summary: `⚡ cheap — 🧠 a/b (high) · 🔍 …` (for picker rows). */
export function formatProfileOneLine(p: Profile): string {
  const parts = PROFILE_ROLES.map((r) => {
    const m = p.roles[r];
    return m ? `${roleIcon(r)} ${formatModelRef(m)} (${m.thinking})` : `${roleIcon(r)} —`;
  });
  const desc = p.description ? ` — ${p.description}` : "";
  return `⚡ ${p.name}${desc}: ${parts.join(" · ")}`;
}

/** Multi-line detail for `/profile show <name>`. */
export function describeProfile(p: Profile): string {
  const lines: string[] = [];
  lines.push(`⚡ Profile ${p.name}${p.description ? ` — ${p.description}` : ""}`);
  for (const r of PROFILE_ROLES) {
    const m = p.roles[r];
    lines.push(
      `  ${roleIcon(r)} ${r}: ${
        m ? `${formatModelRef(m)} (${m.thinking})` : "(not set — falls back to base roles)"
      }`,
    );
  }
  return lines.join("\n");
}

export function formatProfilesForDisplay(
  config: ProfileConfig,
  activeName?: string | null,
  defaultName?: string | null,
): string {
  const lines: string[] = [];
  lines.push("Model Profiles (named role-model combinations):");
  const activeLabel = activeName ? `⚡ ${activeName}` : "none (default roles)";
  const defaultLabel = defaultName ? ` · default: ${defaultName}` : "";
  lines.push(`  Active: ${activeLabel}${defaultLabel}`);
  lines.push("");
  if (config.profiles.length === 0) {
    lines.push("  (no profiles yet — create one with /profile create <name>)");
  }
  const activeLower = String(activeName ?? "").trim().toLowerCase();
  const defaultLower = String(defaultName ?? "").trim().toLowerCase();
  for (const p of config.profiles) {
    const nameLower = p.name.toLowerCase();
    const markers = [
      activeLower && nameLower === activeLower ? "● active" : "",
      defaultLower && nameLower === defaultLower ? "★ default" : "",
    ].filter(Boolean);
    const desc = p.description ? ` — ${p.description}` : "";
    const missing = missingProfileRoles(p);
    const partial =
      missing.length > 0 && missing.length < PROFILE_ROLES.length
        ? ` (partial: ${missing.join(", ")} fall back to base roles)`
        : "";
    lines.push(`  ⚡ ${p.name}${markers.length ? ` (${markers.join(", ")})` : ""}${desc}${partial}`);
    for (const r of PROFILE_ROLES) {
      const m = p.roles[r];
      lines.push(
        `     ${roleIcon(r)} ${r}: ${
          m ? `${formatModelRef(m)} (${m.thinking})` : "(base roles)"
        }`,
      );
    }
  }
  lines.push("");
  lines.push(
    "Usage: /profile (picker) | /profile list | /profile use <name|none> | /profile create <name> | /profile edit <name> | /profile rename <old> <new> | /profile delete <name> | /profile default [name|none] [global|project]",
  );
  return lines.join("\n");
}

// ── workflow.defaultProfile setting ──────────────────────────────────
// Mirrors commit-policy.ts: settings live under `workflow` in
// ~/.pi/agent/settings.json (global) or <cwd>/.pi/settings.json (project);
// project wins. Writes preserve every other key in the file (Pi owns
// settings.json — we must not clobber it).

/** Nested key under WORKFLOW_SETTINGS_KEY. */
export const DEFAULT_PROFILE_KEY = "defaultProfile";

export interface DefaultProfileSettingPaths {
  global: string;
  project: string;
}

/**
 * Settings file locations. `agentDir` is passed in rather than read from the
 * Pi SDK so this stays pure and testable.
 */
export function defaultProfileSettingPaths(
  cwd: string,
  agentDir: string,
): DefaultProfileSettingPaths {
  return {
    global: path.join(agentDir, "settings.json"),
    project: path.join(cwd, COMMIT_CONFIG_DIR, "settings.json"),
  };
}

/**
 * Extract `workflow.defaultProfile` (a profile name string) from a raw
 * settings object. Anything else (absent, non-string, blank) → undefined.
 */
export function extractDefaultProfile(settings: unknown): string | undefined {
  if (!settings || typeof settings !== "object" || Array.isArray(settings))
    return undefined;
  const wf = (settings as Record<string, unknown>)[WORKFLOW_SETTINGS_KEY];
  if (!wf || typeof wf !== "object" || Array.isArray(wf)) return undefined;
  const raw = (wf as Record<string, unknown>)[DEFAULT_PROFILE_KEY];
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed ? trimmed : undefined;
}

/** Which settings scope supplied the effective default profile. */
export type DefaultProfileSource = "default" | "global" | "project";

export interface ResolvedDefaultProfile {
  /** The effective profile name, or undefined when none is configured. */
  value: string | undefined;
  /** Which files contributed (for /profile default status). */
  sources: {
    global: boolean;
    project: boolean;
    effective: DefaultProfileSource;
  };
}

function readSettingsSafe(fp: string): Record<string, unknown> | undefined {
  try {
    if (!fs.existsSync(fp)) return undefined;
    const parsed: unknown = JSON.parse(fs.readFileSync(fp, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return undefined;
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/**
 * Resolve the effective `workflow.defaultProfile` from disk.
 * Never throws — a corrupt or missing file falls back to "no default".
 */
export function readDefaultProfileSetting(
  cwd: string,
  agentDir: string,
): ResolvedDefaultProfile {
  const paths = defaultProfileSettingPaths(cwd, agentDir);
  const globalRaw = extractDefaultProfile(readSettingsSafe(paths.global));
  const projectRaw = extractDefaultProfile(readSettingsSafe(paths.project));
  // Project wins over global; global wins over unset.
  const value = projectRaw ?? globalRaw;
  return {
    value,
    sources: {
      global: globalRaw !== undefined,
      project: projectRaw !== undefined,
      effective: projectRaw !== undefined ? "project" : globalRaw !== undefined ? "global" : "default",
    },
  };
}

/**
 * Read-modify-write `workflow.defaultProfile` into a settings file, preserving
 * every other key in that file (Pi owns settings.json — we must not clobber
 * it). `value === null` clears the key; if the `workflow` object becomes empty
 * it is removed entirely to keep the file tidy.
 */
export function writeDefaultProfileSetting(
  scope: "global" | "project",
  cwd: string,
  agentDir: string,
  value: string | null,
): { path: string; ok: boolean; error?: string } {
  const paths = defaultProfileSettingPaths(cwd, agentDir);
  const fp = scope === "project" ? paths.project : paths.global;
  try {
    const existing = readSettingsSafe(fp);
    const root: Record<string, unknown> = existing ? { ...existing } : {};
    const wfExisting = root[WORKFLOW_SETTINGS_KEY];
    const wf: Record<string, unknown> =
      wfExisting && typeof wfExisting === "object" && !Array.isArray(wfExisting)
        ? { ...(wfExisting as Record<string, unknown>) }
        : {};
    if (value === null) {
      delete wf[DEFAULT_PROFILE_KEY];
    } else {
      const check = validateProfileName(value);
      if (!check.ok) {
        return { path: fp, ok: false, error: check.error };
      }
      wf[DEFAULT_PROFILE_KEY] = check.value;
    }
    if (Object.keys(wf).length === 0) delete root[WORKFLOW_SETTINGS_KEY];
    else root[WORKFLOW_SETTINGS_KEY] = wf;
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

// ── Argument completions (/profile) ──────────────────────────────────

/** Subcommands that take a profile-name argument (position 2). */
const PROFILE_NAME_SUBS: ReadonlySet<string> = new Set([
  "use",
  "edit",
  "show",
  "delete",
  "default",
  "rename",
]);

/** Aliases the /profile handler accepts, mapped to their canonical subcommand. */
const PROFILE_CMD_ALIASES: Readonly<Record<string, string>> = {
  activate: "use",
  config: "edit",
  remove: "delete",
  rm: "delete",
  mv: "rename",
  new: "create",
  add: "create",
};

/** Write-scope descriptions for `/profile default <name> <scope>` completions. */
const SCOPE_DESCRIPTIONS: Readonly<Record<string, string>> = {
  global: "write to ~/.pi/agent/settings.json",
  project: "write to <cwd>/.pi/settings.json",
};

interface ProfileSubMeta {
  name: string;
  /** Takes an argument → completion `value` carries a trailing space. */
  takesArg: boolean;
  label: string;
  description: string;
}

const PROFILE_SUBS: readonly ProfileSubMeta[] = [
  {
    name: "list",
    takesArg: false,
    label: "list",
    description: "show all profiles",
  },
  {
    name: "use",
    takesArg: true,
    label: "use <name|none>",
    description: "activate/deactivate for this session",
  },
  {
    name: "create",
    takesArg: true,
    label: "create <name>",
    description: "create a profile (seeded from current models)",
  },
  {
    name: "edit",
    takesArg: true,
    label: "edit <name>",
    description: "open the tabbed model editor",
  },
  {
    name: "rename",
    takesArg: true,
    label: "rename <old> <new>",
    description: "rename a profile",
  },
  {
    name: "delete",
    takesArg: true,
    label: "delete <name>",
    description: "delete a profile",
  },
  {
    name: "default",
    takesArg: true,
    label: "default [name|none] [global|project]",
    description: "default profile for new sessions",
  },
  {
    name: "show",
    takesArg: true,
    label: "show <name>",
    description: "show one profile's models",
  },
];

/** Profile names matching a lowercased partial token, case-insensitively. */
function profileNameMatches(
  profiles: readonly Profile[],
  partial: string,
): Profile[] {
  if (!partial) return [...profiles];
  return profiles.filter((p) =>
    p.name.toLowerCase().startsWith(partial.toLowerCase()),
  );
}

function profileCompletions(
  profiles: readonly Profile[],
  join: (token: string) => string,
): ArgumentCompletion[] {
  return profiles.map((p) => ({
    value: join(p.name),
    label: p.name,
    ...(p.description ? { description: p.description } : {}),
  }));
}

/**
 * Argument completions for `/profile` (pure; unit-tested in profiles.test.ts).
 *
 * `argumentPrefix` is the ENTIRE typed argument text after "/profile " (what
 * pi's CombinedAutocompleteProvider passes). Per the pi-tui contract, every
 * returned item's `value` is the complete replacement for that argument text
 * (`joinArgumentValue`), never a bare token — accepting `"use Syn-De" →
 * "Syn-…"` would otherwise drop the `use` subcommand (see the /mcp
 * extension for the reference implementation).
 *
 * Returns null when there is nothing useful to offer (unknown subcommand,
 * `rename <old> <new>` second arg, `create`, …) or when the typed token is
 * already an exact, unique match (exact-match suppression → the dropdown
 * closes and the first Enter submits the command).
 */
export function profileArgumentCompletions(
  argumentPrefix: string,
  profiles: readonly Profile[],
): ArgumentCompletion[] | null {
  const raw = String(argumentPrefix ?? "");
  const join = (token: string) => joinArgumentValue(raw, token);

  // ── Subcommand position: no whitespace typed yet ────────────────────
  if (!raw.trim() || !/\s/.test(raw)) {
    const lower = raw.trim().toLowerCase();
    const matching = PROFILE_SUBS.filter((s) =>
      s.name.startsWith(lower),
    );
    if (matching.length > 0) {
      return matching.map((s) => ({
        value: s.takesArg ? `${s.name} ` : s.name,
        label: s.label,
        description: s.description,
      }));
    }
    // Bare profile name → `/profile <name>` shows detail (mirrors /role).
    const names = profileNameMatches(profiles, lower);
    if (names.length === 0) return null;
    return profileCompletions(names, join);
  }

  // ── Argument position ────────────────────────────────────────────────
  const tokens = raw.trim().split(/\s+/).filter(Boolean);
  const head = tokens[0] ?? "";
  const canonical = PROFILE_CMD_ALIASES[head.toLowerCase()] ?? head.toLowerCase();
  const endsWithWs = /\s$/.test(raw);
  const committedCount = endsWithWs ? tokens.length : tokens.length - 1;
  const partial = endsWithWs ? "" : (tokens[tokens.length - 1] ?? "");

  let items: ArgumentCompletion[] | null = null;

  if (canonical === "default") {
    if (committedCount <= 1) {
      // Second token: profile name | none.
      const names = profileNameMatches(profiles, partial);
      const none: ArgumentCompletion[] =
        "none".startsWith(partial.toLowerCase())
          ? [{ value: join("none"), label: "none", description: "no profile" }]
          : [];
      items = [...profileCompletions(names, join), ...none];
    } else {
      // Third token: scope.
      items = ["global", "project"].flatMap((s) =>
        s.startsWith(partial.toLowerCase())
          ? [
              {
                value: join(s),
                label: s,
                description: SCOPE_DESCRIPTIONS[s],
              },
            ]
          : [],
      );
    }
  } else if (canonical === "rename") {
    // First arg: existing name; second arg (new name) is free text.
    if (committedCount <= 1) {
      items = profileCompletions(profileNameMatches(profiles, partial), join);
    }
  } else if (PROFILE_NAME_SUBS.has(canonical)) {
    const names = profileNameMatches(profiles, partial);
    const none: ArgumentCompletion[] =
      canonical === "use" && "none".startsWith(partial.toLowerCase())
        ? [{ value: join("none"), label: "none", description: "no profile" }]
        : [];
    items = [...profileCompletions(names, join), ...none];
  }
  // create|new|add (new name is free text), list, unknown → items stays null.

  if (!items || items.length === 0) return null;
  const candidateTokens = items.map((i) => i.label);
  if (suppressExactArgumentMatch(candidateTokens, partial)) return null;
  return items;
}
