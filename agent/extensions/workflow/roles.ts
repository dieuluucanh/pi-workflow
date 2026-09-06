/**
 * Workflow Extension — Model Roles
 *
 * Role registry with one model per role.
 *
 * - Built-in roles: planner / explorer / builder (extensible via roles.json)
 * - Persistence: ~/.pi/agent/roles.json (user) + <cwd>/.pi/roles.json (project override)
 * - Config: roles.json holds exactly one {provider, id, thinking} per role
 * - v2 schema: legacy v1 `modelPool` files are discarded and reseeded
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
export const BUILT_IN_ROLES = ["planner", "explorer", "builder"] as const;

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

function readJsonFile(fp: string): any | undefined {
  try {
    if (!fs.existsSync(fp)) return undefined;
    return JSON.parse(fs.readFileSync(fp, "utf8"));
  } catch {
    return undefined;
  }
}

function sanitizeModel(m: any, fallbackThinking: ThinkingLevel): RoleModel | undefined {
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
  // v2 schema only — legacy v1 `modelPool` arrays are rejected so the
  // file gets reseeded with single-model defaults (reset, no migration).
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

function seedUserFile(fp: string, base: RoleConfig): void {
  try {
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, JSON.stringify(base, null, 2), "utf8");
  } catch {
    /* best effort */
  }
}

/**
 * Load merged role config: user file + project override (per-role replace).
 * v1 `modelPool` files (or any non-v2 version) are discarded and reseeded
 * with single-model defaults. Never throws — falls back to in-memory
 * defaults on corrupt config.
 */
export function loadRoleConfig(cwd?: string): RoleConfig {
  const base = defaultRoleConfig();
  try {
    const fp = userRolesPath();
    const raw = readJsonFile(fp);
    if (raw === undefined) {
      // first run — seed file
      seedUserFile(fp, base);
    } else if (!isCurrentVersion(raw)) {
      // legacy v1 (modelPool) or unknown version — reset to defaults
      seedUserFile(fp, base);
    } else {
      base.roles = mergeRoles(base.roles, (raw as any).roles);
      if (
        typeof (raw as any).activeRole === "string" ||
        (raw as any).activeRole === null
      )
        base.activeRole = (raw as any).activeRole;
    }
  } catch {
    /* fall through with defaults */
  }
  // project override: per-role replace + activeRole if present.
  // Legacy project files are ignored (never reseeded — user-owned).
  try {
    if (cwd) {
      const praw = readJsonFile(projectRolesPath(cwd));
      if (praw && typeof praw === "object" && isCurrentVersion(praw)) {
        base.roles = mergeRoles(base.roles, (praw as any).roles);
        if (
          typeof (praw as any).activeRole === "string" ||
          (praw as any).activeRole === null
        )
          base.activeRole = (praw as any).activeRole;
      }
    }
  } catch {
    /* ignore project errors */
  }
  return base;
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
};

export function roleIcon(name: string): string {
  return ROLE_ICONS[name.toLowerCase()] ?? "⚙️";
}

export function formatRolesForDisplay(config: RoleConfig): string {
  const lines: string[] = [];
  lines.push("Model Roles (one model per role):");
  lines.push(`  Active: ${config.activeRole ?? "auto (plan→planner, build→builder)"}`);
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
