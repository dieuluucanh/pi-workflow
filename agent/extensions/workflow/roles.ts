/**
 * Workflow Extension — Model Roles
 *
 * Role registry with one model per role.
 *
 * - Built-in roles: planner / explorer / builder / reviewer (extensible via roles.json)
 * - Persistence: ~/.pi/agent/roles.json (user) + <cwd>/.pi/roles.json (project override)
 * - Config: roles.json holds exactly one {provider, id, thinking} per role
 * - v2 schema: legacy v1 `modelPool` files are ignored (in-memory defaults
 *   are used and the file is never rewritten)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";

// ── Types ────────────────────────────────────────────────────────────

export type ThinkingLevel =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

export interface RoleModel {
  provider: string;
  id: string;
  thinking: ThinkingLevel;
}

export interface Role {
  name: string;
  description: string;
  /** Single model for this role (pool idea removed — see roles.json v2). */
  model: RoleModel;
  /** tool allowlist; empty = inherit all */
  tools: string[];
  systemPromptAddendum: string;
  builtIn: boolean;
}

export interface RoleConfig {
  version: number;
  roles: Role[];
  /** null = follow workflow mode default; otherwise force a role */
  activeRole: string | null;
}

export const ROLE_CONFIG_VERSION = 2;
export const BUILT_IN_ROLES = [
  "planner",
  "explorer",
  "builder",
  "reviewer",
] as const;

/**
 * Role that Review Mode runs in its own in-process child session.
 * Deliberately NOT wired into MODE_ROLE_MAP: the parent session must never
 * switch to this model (Review Mode has its own session).
 */
export const REVIEW_ROLE_NAME = "reviewer";

export const VALID_THINKING_LEVELS: ThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

export function isValidThinkingLevel(s: string): s is ThinkingLevel {
  return (VALID_THINKING_LEVELS as string[]).includes(s);
}

// ── Defaults (seeded from the user's enabledModels so they resolve) ──

export function seedDefaultRoles(): Role[] {
  return [
    {
      name: "planner",
      description:
        "Frontier reasoning model for planning, orchestration, and ambiguous decisions",
      model: {
        provider: "opencode-go",
        id: "muse-spark-1.2-contributor",
        thinking: "high",
      },
      tools: [],
      systemPromptAddendum:
        "You are in PLANNER role. Focus on reasoning, architecture, and planning. Delegate implementation to Builder and research to Explorer.",
      builtIn: true,
    },
    {
      name: "explorer",
      description:
        "Fast, cheap model for read-only codebase exploration, web search, and summarization",
      model: {
        provider: "opencode",
        id: "muse-spark-1.3-contributor-free",
        thinking: "low",
      },
      tools: ["read", "grep", "find", "ls", "bash"],
      systemPromptAddendum:
        "You are in EXPLORER role. Read-only research only. Do NOT edit/write. Return concise findings.",
      builtIn: true,
    },
    {
      name: "builder",
      description:
        "Capable model for code generation following a plan, with light reasoning",
      model: {
        provider: "opencode-go",
        id: "muse-spark-1.2-contributor",
        thinking: "medium",
      },
      tools: [],
      systemPromptAddendum:
        "You are in BUILDER role. Implement the assigned task following the plan. Reason lightly. Ask if blocked.",
      builtIn: true,
    },
    {
      // Seeded with a DIFFERENT model than planner so Review Mode brings a
      // genuinely independent perspective (see docs: Review Mode).
      name: "reviewer",
      description:
        "Independent auditor for Review Mode — reviews and rewrites plans before the user sees them",
      model: {
        provider: "opencode-go",
        id: "muse-spark-1.3-contributor",
        thinking: "xhigh",
      },
      tools: ["read", "grep", "find", "ls"],
      systemPromptAddendum:
        "You are in REVIEWER role. Independently audit the plan. Always align with the existing project framework and industry best practice. Flag divergence from established conventions. Do not write code.",
      builtIn: true,
    },
  ];
}

export function defaultRoleConfig(): RoleConfig {
  return {
    version: ROLE_CONFIG_VERSION,
    roles: seedDefaultRoles(),
    activeRole: null,
  };
}

// ── Paths & persistence ──────────────────────────────────────────────

export function userRolesPath(): string {
  return path.join(getAgentDir(), "roles.json");
}

export function projectRolesPath(cwd: string): string {
  return path.join(cwd, CONFIG_DIR_NAME, "roles.json");
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

/** Optional path overrides (tests); production reads the real agent/cwd files. */
export interface RoleConfigPathOverrides {
  userPath?: string;
  projectPath?: string;
}

/**
 * Cheap change detector for the two roles files (existence + mtime + size).
 * Compare two fingerprints to decide whether a reload is needed. Never throws.
 */
export function rolesFingerprint(
  cwd?: string,
  overrides?: RoleConfigPathOverrides,
): string {
  const user = fileFingerprint(overrides?.userPath ?? userRolesPath());
  const projectPath =
    overrides?.projectPath ?? (cwd ? projectRolesPath(cwd) : undefined);
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

function sanitizeModel(
  m: any,
  fallbackThinking: ThinkingLevel,
): RoleModel | undefined {
  if (!m || typeof m.provider !== "string" || typeof m.id !== "string")
    return undefined;
  if (!m.provider.trim() || !m.id.trim()) return undefined;
  return {
    provider: m.provider.trim(),
    id: m.id.trim(),
    thinking: isValidThinkingLevel(String(m.thinking))
      ? (String(m.thinking) as ThinkingLevel)
      : fallbackThinking,
  };
}

function sanitizeRole(r: any): Role | undefined {
  if (!r || typeof r.name !== "string" || !r.name.trim()) return undefined;
  // v2 schema only — legacy v1 `modelPool` entries are ignored (the role
  // falls back to its built-in default; the file itself is left untouched).
  if (Array.isArray((r as any).modelPool)) return undefined;
  const model = sanitizeModel((r as any).model, "medium");
  if (!model) return undefined;
  return {
    name: r.name.trim().toLowerCase(),
    description:
      typeof r.description === "string" ? r.description : "Custom role",
    model,
    tools: Array.isArray(r.tools)
      ? r.tools.filter((t: any) => typeof t === "string")
      : [],
    systemPromptAddendum:
      typeof r.systemPromptAddendum === "string"
        ? r.systemPromptAddendum
        : `You are in ${r.name} role.`,
    builtIn: false,
  };
}

function isCurrentVersion(raw: any): boolean {
  return (
    raw &&
    typeof raw === "object" &&
    (raw as any).version === ROLE_CONFIG_VERSION
  );
}

function mergeRoles(base: Role[], rawRoles: unknown): Role[] {
  if (!Array.isArray(rawRoles)) return base;
  const byName = new Map<string, Role>();
  for (const r of base) byName.set(r.name, r);
  for (const r of rawRoles as any[]) {
    const s = sanitizeRole(r);
    if (s) {
      // preserve builtIn flag for the three built-ins
      if ((BUILT_IN_ROLES as readonly string[]).includes(s.name))
        s.builtIn = true;
      byName.set(s.name, s);
    }
  }
  return [...byName.values()];
}

/** Result of {@link loadRoleConfigDetailed}. */
export interface LoadedRoleConfig {
  config: RoleConfig;
  /** True when neither the user nor a project file supplied usable roles. */
  usedDefaults: boolean;
  /** Why the user file was skipped (missing / unreadable / legacy). */
  reason?: string;
  /** Fingerprint of the roles files at read time (see rolesFingerprint). */
  fingerprint: string;
}

/**
 * Load the merged role config (user file + project override, per-role replace).
 *
 * Non-destructive by design: a missing, unreadable, corrupt, or legacy
 * `roles.json` is never rewritten. In-memory defaults are used instead and the
 * reason is reported via `usedDefaults`/`reason`, so callers can warn without
 * risking the user's file. Never throws.
 */
export function loadRoleConfigDetailed(
  cwd?: string,
  overrides?: RoleConfigPathOverrides,
): LoadedRoleConfig {
  const base = defaultRoleConfig();
  const fingerprint = rolesFingerprint(cwd, overrides);
  let reason: string | undefined;
  let userUsable = false;

  const userPath = overrides?.userPath ?? userRolesPath();
  const userRead = readJsonFileDetailed(userPath);
  if (!userRead.exists) {
    reason = `no roles.json at ${userPath} — using in-memory defaults`;
  } else if (userRead.error) {
    reason = `roles.json is not valid JSON (${userRead.error}) — using in-memory defaults`;
  } else if (!isCurrentVersion(userRead.raw)) {
    const v = (userRead.raw as { version?: unknown } | undefined)?.version;
    reason = `incompatible roles.json${
      v === undefined ? "" : ` (version ${String(v)})`
    } — using in-memory defaults`;
  } else {
    base.roles = mergeRoles(base.roles, (userRead.raw as any).roles);
    if (
      typeof (userRead.raw as any).activeRole === "string" ||
      (userRead.raw as any).activeRole === null
    ) {
      base.activeRole = (userRead.raw as any).activeRole;
    }
    userUsable = true;
  }

  // Project override: per-role replace + activeRole if present. A bad or
  // legacy project file is ignored and never rewritten (it is user-owned).
  let projectUsable = false;
  const projectPath =
    overrides?.projectPath ?? (cwd ? projectRolesPath(cwd) : undefined);
  if (projectPath) {
    const projectRead = readJsonFileDetailed(projectPath);
    if (
      projectRead.exists &&
      !projectRead.error &&
      isCurrentVersion(projectRead.raw)
    ) {
      base.roles = mergeRoles(base.roles, (projectRead.raw as any).roles);
      if (
        typeof (projectRead.raw as any).activeRole === "string" ||
        (projectRead.raw as any).activeRole === null
      ) {
        base.activeRole = (projectRead.raw as any).activeRole;
      }
      projectUsable = true;
    }
  }

  return {
    config: base,
    usedDefaults: !userUsable && !projectUsable,
    ...(reason === undefined ? {} : { reason }),
    fingerprint,
  };
}

/** Convenience wrapper returning just the config. Never throws. */
export function loadRoleConfig(
  cwd?: string,
  overrides?: RoleConfigPathOverrides,
): RoleConfig {
  return loadRoleConfigDetailed(cwd, overrides).config;
}

export function saveRoleConfig(
  config: RoleConfig,
  scope: "user" | "project",
  cwd?: string,
): void {
  const payload: RoleConfig = {
    version: ROLE_CONFIG_VERSION,
    roles: config.roles,
    activeRole: config.activeRole,
  };
  const fp =
    scope === "project" && cwd ? projectRolesPath(cwd) : userRolesPath();
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, JSON.stringify(payload, null, 2), "utf8");
}

// ── Lookup & model refs ──────────────────────────────────────────────

export function getRole(config: RoleConfig, name: string): Role | undefined {
  return config.roles.find(
    (r) => r.name.toLowerCase() === String(name).toLowerCase(),
  );
}

/** Parse "provider/model" or bare "model" (provider = ""). */
export function parseModelRef(ref: string): { provider: string; id: string } {
  const s = String(ref).trim();
  const slash = s.indexOf("/");
  if (slash > 0) return { provider: s.slice(0, slash), id: s.slice(slash + 1) };
  return { provider: "", id: s };
}

export function formatModelRef(m: RoleModel): string {
  return `${m.provider}/${m.id}`;
}

// ── Display ──────────────────────────────────────────────────────────

const ROLE_ICONS: Record<string, string> = {
  planner: "🧠",
  explorer: "🔍",
  builder: "🔨",
  reviewer: "🧪",
};

export function roleIcon(name: string): string {
  return ROLE_ICONS[name.toLowerCase()] ?? "⚙️";
}

export function formatRolesForDisplay(config: RoleConfig): string {
  const lines: string[] = [];
  lines.push("Model Roles (one model per role):");
  lines.push(
    `  Active: ${config.activeRole ?? "auto (plan→planner, build→builder)"}`,
  );
  lines.push("");
  for (const r of config.roles) {
    lines.push(
      `  ${roleIcon(r.name)} ${r.name}: ${r.model.provider}/${r.model.id} (${r.model.thinking})`,
    );
    lines.push(`     ${r.description}`);
  }
  lines.push("");
  lines.push(
    "Usage: /role (picker) | /role set <role> <provider/model> [thinking] | /role use <role|auto> | /role add|remove|reset",
  );
  return lines.join("\n");
}
