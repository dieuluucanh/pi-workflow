/**
 * Workflow Extension — `workflow.shellGuard` configuration.
 *
 * Shell deadlines are user-owned: a model cannot disable them, widen them for
 * itself, or edit the settings file. They live next to the other workflow
 * policies and follow the same global/project rules:
 *
 *   { "workflow": { "shellGuard": { "defaultTimeoutSeconds": 120,
 *                                   "maxTimeoutSeconds": 900 } } }
 *
 * Global applies by default; a TRUSTED project may override fields. Lists do
 * not exist here. Invalid numbers never disable protection: they fall back to
 * the base value and the pair is repaired so `default <= max`.
 *
 * The module is free of Pi/TUI imports so the coercion, merge and read/write
 * paths can be unit-tested against temporary directories.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { reviewConfigPaths, WORKFLOW_SETTINGS_KEY } from "./review.ts";
import {
  HARD_MAX_SHELL_TIMEOUT_SECONDS,
  clampShellSeconds,
  normalizeShellLimits,
  type ShellLimits,
  DEFAULT_SHELL_LIMITS,
} from "./shell-guard.ts";
import {
  joinArgumentValue,
  suppressExactArgumentMatch,
  type ArgumentCompletion,
} from "./utils.ts";

/** Nested key under `workflow` in settings.json. */
export const SHELL_GUARD_SETTINGS_KEY = "shellGuard";

/** Env var used to carry a parent's limits into a spawned explorer child. */
export const SHELL_GUARD_LIMITS_ENV = "PI_SHELL_GUARD_LIMITS";

export type JsonObject = Record<string, unknown>;

export type ShellGuardScopeSource = "default" | "global" | "project";

export interface ResolvedShellGuardConfig {
  config: ShellLimits;
  sources: {
    global: boolean;
    project: boolean;
    /** The project file defined shellGuard but was ignored (untrusted). */
    projectIgnored: boolean;
    defaultTimeout: ShellGuardScopeSource;
    maxTimeout: ShellGuardScopeSource;
  };
}

function readJsonSafe(fp: string): JsonObject | undefined {
  try {
    if (!fs.existsSync(fp)) return undefined;
    const parsed: unknown = JSON.parse(fs.readFileSync(fp, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return undefined;
    }
    return parsed as JsonObject;
  } catch {
    return undefined;
  }
}

/** Strict read used by the writer: a corrupt file must not be clobbered. */
function readJsonStrict(fp: string): { ok: true; value: JsonObject | undefined } | { ok: false; error: string } {
  if (!fs.existsSync(fp)) return { ok: true, value: undefined };
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(fp, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, error: `${fp} does not contain a JSON object` };
    }
    return { ok: true, value: parsed as JsonObject };
  } catch (e: unknown) {
    return {
      ok: false,
      error: `cannot parse ${fp}: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

/** Extract the `workflow.shellGuard` fragment from a raw settings object. */
export function extractShellGuardRaw(settings: unknown): JsonObject | undefined {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
    return undefined;
  }
  const wf = (settings as JsonObject)[WORKFLOW_SETTINGS_KEY];
  if (!wf || typeof wf !== "object" || Array.isArray(wf)) return undefined;
  const raw = (wf as JsonObject)[SHELL_GUARD_SETTINGS_KEY];
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return raw as JsonObject;
  }
  return undefined;
}

/**
 * Coerce one fragment onto a base pair. Missing or non-finite fields keep the
 * base; the pair is repaired so `default <= max`. Never throws.
 */
export function coerceShellGuardConfig(
  raw: unknown,
  base: ShellLimits = DEFAULT_SHELL_LIMITS as ShellLimits,
): ShellLimits {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return normalizeShellLimits(base, base);
  }
  const r = raw as JsonObject;
  return normalizeShellLimits(
    {
      defaultTimeoutSeconds: clampShellSeconds(
        r.defaultTimeoutSeconds,
        base.defaultTimeoutSeconds,
      ),
      maxTimeoutSeconds: clampShellSeconds(
        r.maxTimeoutSeconds,
        base.maxTimeoutSeconds,
      ),
    },
    base,
  );
}

function hasKey(raw: JsonObject | undefined, key: keyof ShellLimits): boolean {
  return Boolean(raw) && Object.prototype.hasOwnProperty.call(raw, key);
}

/** Field provenance: project > global > default. */
export function shellGuardFieldSource(
  globalRaw: JsonObject | undefined,
  projectRaw: JsonObject | undefined,
  key: keyof ShellLimits,
): ShellGuardScopeSource {
  if (hasKey(projectRaw, key)) return "project";
  if (hasKey(globalRaw, key)) return "global";
  return "default";
}

/**
 * Merge global then project. A trusted project wins field by field; an
 * untrusted project is not read at all by `readShellGuardConfig`.
 */
export function mergeShellGuardConfig(
  globalRaw: unknown,
  projectRaw: unknown,
): ShellLimits {
  const fromGlobal = coerceShellGuardConfig(globalRaw);
  return coerceShellGuardConfig(projectRaw, fromGlobal);
}

export function shellGuardConfigPaths(
  cwd: string,
  agentDir: string,
): { global: string; project: string } {
  return reviewConfigPaths(cwd, agentDir);
}

/** Resolve the effective limits from disk. Never throws. */
export function readShellGuardConfig(
  cwd: string,
  agentDir: string,
  options: { trusted?: boolean } = {},
): ResolvedShellGuardConfig {
  const paths = shellGuardConfigPaths(cwd, agentDir);
  const globalRaw = extractShellGuardRaw(readJsonSafe(paths.global));
  const projectPresent = extractShellGuardRaw(readJsonSafe(paths.project));
  const trusted = options.trusted === true;
  const projectRaw = trusted ? projectPresent : undefined;
  return {
    config: mergeShellGuardConfig(globalRaw, projectRaw),
    sources: {
      global: globalRaw !== undefined,
      project: projectRaw !== undefined,
      projectIgnored: !trusted && projectPresent !== undefined,
      defaultTimeout: shellGuardFieldSource(globalRaw, projectRaw, "defaultTimeoutSeconds"),
      maxTimeout: shellGuardFieldSource(globalRaw, projectRaw, "maxTimeoutSeconds"),
    },
  };
}

/**
 * Read-modify-write only the patched fields. Preserves every other key.
 * Refuses a corrupt existing file instead of replacing the user's settings.
 */
export function writeShellGuardConfig(
  scope: "global" | "project",
  cwd: string,
  agentDir: string,
  patch: Partial<ShellLimits>,
): { path: string; ok: boolean; error?: string } {
  const paths = shellGuardConfigPaths(cwd, agentDir);
  const fp = scope === "project" ? paths.project : paths.global;
  const existing = readJsonStrict(fp);
  if (!existing.ok) return { path: fp, ok: false, error: existing.error };
  try {
    const root: JsonObject = existing.value ? { ...existing.value } : {};
    const wfExisting = root[WORKFLOW_SETTINGS_KEY];
    const wf: JsonObject =
      wfExisting && typeof wfExisting === "object" && !Array.isArray(wfExisting)
        ? { ...(wfExisting as JsonObject) }
        : {};
    const current = coerceShellGuardConfig(wf[SHELL_GUARD_SETTINGS_KEY]);
    const next: JsonObject = {
      ...(wf[SHELL_GUARD_SETTINGS_KEY] &&
      typeof wf[SHELL_GUARD_SETTINGS_KEY] === "object" &&
      !Array.isArray(wf[SHELL_GUARD_SETTINGS_KEY])
        ? (wf[SHELL_GUARD_SETTINGS_KEY] as JsonObject)
        : {}),
    };
    if (patch.defaultTimeoutSeconds !== undefined) {
      next.defaultTimeoutSeconds = clampShellSeconds(
        patch.defaultTimeoutSeconds,
        current.defaultTimeoutSeconds,
      );
    }
    if (patch.maxTimeoutSeconds !== undefined) {
      next.maxTimeoutSeconds = clampShellSeconds(
        patch.maxTimeoutSeconds,
        current.maxTimeoutSeconds,
      );
    }
    const normalized = coerceShellGuardConfig(next, current);
    next.defaultTimeoutSeconds = normalized.defaultTimeoutSeconds;
    next.maxTimeoutSeconds = normalized.maxTimeoutSeconds;
    wf[SHELL_GUARD_SETTINGS_KEY] = next;
    root[WORKFLOW_SETTINGS_KEY] = wf;
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, `${JSON.stringify(root, null, 2)}\n`, "utf8");
    return { path: fp, ok: true };
  } catch (e: unknown) {
    return {
      path: fp,
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

// ── Inherited limits (spawned explorer children) ─────────────────────

export interface ParsedShellLimits {
  ok: boolean;
  limits?: ShellLimits;
  error?: string;
}

/** Serialize limits for a spawned child's environment. */
export function encodeShellLimitsEnv(limits: ShellLimits): string {
  const n = normalizeShellLimits(limits);
  return JSON.stringify({
    defaultTimeoutSeconds: n.defaultTimeoutSeconds,
    maxTimeoutSeconds: n.maxTimeoutSeconds,
  });
}

/** Parse an inherited snapshot. Malformed input is reported, not trusted. */
export function decodeShellLimitsEnv(value: unknown): ParsedShellLimits {
  if (typeof value !== "string" || !value.trim()) {
    return { ok: false, error: "no inherited shell limits" };
  }
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, error: "inherited shell limits are not an object" };
    }
    const r = parsed as JsonObject;
    const def = r.defaultTimeoutSeconds;
    const max = r.maxTimeoutSeconds;
    if (
      typeof def !== "number" ||
      typeof max !== "number" ||
      !Number.isFinite(def) ||
      !Number.isFinite(max) ||
      def < 1 ||
      max < 1
    ) {
      return { ok: false, error: "inherited shell limits are not finite positive numbers" };
    }
    return { ok: true, limits: normalizeShellLimits({ defaultTimeoutSeconds: def, maxTimeoutSeconds: max }) };
  } catch (e: unknown) {
    return {
      ok: false,
      error: `cannot parse inherited shell limits: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

/**
 * A child may keep its local policy only where it is not wider than the
 * parent's. Inherited limits constrain both fields; a different child cwd
 * cannot silently weaken them.
 */
export function applyInheritedShellLimits(
  local: ShellLimits,
  inherited: ShellLimits | undefined,
): ShellLimits {
  const base = normalizeShellLimits(local);
  if (!inherited) return base;
  const parent = normalizeShellLimits(inherited);
  const max = Math.min(base.maxTimeoutSeconds, parent.maxTimeoutSeconds);
  const def = Math.min(base.defaultTimeoutSeconds, parent.defaultTimeoutSeconds, max);
  return { defaultTimeoutSeconds: def, maxTimeoutSeconds: max };
}

/** Resolve limits for the current process, honoring an inherited snapshot. */
export function effectiveShellLimits(
  cwd: string,
  agentDir: string,
  options: { trusted?: boolean; env?: NodeJS.ProcessEnv } = {},
): ResolvedShellGuardConfig & { inherited: boolean; inheritedError?: string } {
  const resolved = readShellGuardConfig(cwd, agentDir, {
    trusted: options.trusted,
  });
  const env = options.env ?? process.env;
  const decoded = decodeShellLimitsEnv(env[SHELL_GUARD_LIMITS_ENV]);
  if (!decoded.ok || !decoded.limits) {
    return {
      ...resolved,
      inherited: false,
      ...(env[SHELL_GUARD_LIMITS_ENV]
        ? { inheritedError: decoded.error ?? "invalid inherited shell limits" }
        : {}),
    };
  }
  return {
    ...resolved,
    config: applyInheritedShellLimits(resolved.config, decoded.limits),
    inherited: true,
  };
}

// ── `/shell-guard` parsing and completions ──────────────────────────

const RESERVED_SCOPES = new Set(["global", "project"]);

export type ParsedShellGuardCommand =
  | { action: "status" }
  | { action: "reset" }
  | { action: "limits"; limits: ShellLimits; scope: "global" | "project" }
  | { action: "error"; error: string };

export const SHELL_GUARD_USAGE =
  "Usage: /shell-guard [status] · limits <default-seconds> <max-seconds> [global|project] · reset";

function parseSecondsToken(token: string, label: string): number | string {
  if (!/^\d+$/.test(token)) {
    return `${label} must be a whole number of seconds; received ${JSON.stringify(token)}`;
  }
  const n = Number(token);
  if (!Number.isFinite(n) || n < 1) {
    return `${label} must be at least 1 second`;
  }
  if (n > HARD_MAX_SHELL_TIMEOUT_SECONDS) {
    return `${label} cannot exceed the ${HARD_MAX_SHELL_TIMEOUT_SECONDS}s hard cap`;
  }
  return n;
}

/**
 * Parse `/shell-guard` arguments. Deliberately strict: no `0`, `off`,
 * `unlimited`, fractions, or extra tokens. Scope is a bare word, matching
 * `/handoff` and `/folder-policy`.
 */
export function parseShellGuardArgs(args: unknown): ParsedShellGuardCommand {
  const raw = String(args ?? "").trim();
  if (!raw) return { action: "status" };
  const tokens = raw.split(/\s+/).filter(Boolean);
  const sub = (tokens[0] ?? "").toLowerCase();

  if (sub === "status") {
    if (tokens.length > 1) {
      return { action: "error", error: `status takes no arguments. ${SHELL_GUARD_USAGE}` };
    }
    return { action: "status" };
  }
  if (sub === "reset") {
    if (tokens.length > 1) {
      return { action: "error", error: `reset takes no arguments. ${SHELL_GUARD_USAGE}` };
    }
    return { action: "reset" };
  }
  if (sub === "limits") {
    const scope = tokens.includes("project") ? "project" : "global";
    const positional = tokens.slice(1).filter((t) => !RESERVED_SCOPES.has(t));
    if (positional.length !== 2) {
      return {
        action: "error",
        error: `limits needs a default and a maximum in seconds. ${SHELL_GUARD_USAGE}`,
      };
    }
    const def = parseSecondsToken(positional[0]!, "default timeout");
    if (typeof def === "string") return { action: "error", error: def };
    const max = parseSecondsToken(positional[1]!, "maximum timeout");
    if (typeof max === "string") return { action: "error", error: max };
    if (def > max) {
      return {
        action: "error",
        error: `default timeout (${def}s) cannot be greater than the maximum (${max}s)`,
      };
    }
    return {
      action: "limits",
      limits: { defaultTimeoutSeconds: def, maxTimeoutSeconds: max },
      scope,
    };
  }
  return { action: "error", error: `unknown subcommand ${JSON.stringify(tokens[0])}. ${SHELL_GUARD_USAGE}` };
}

/** Argument completions for `/shell-guard` (full-argument contract). */
export function shellGuardArgumentCompletions(
  argumentPrefix: string,
): ArgumentCompletion[] | null {
  const raw = String(argumentPrefix ?? "");
  if (!/\s/.test(raw.trim()) && !/\s$/.test(raw)) {
    const partial = raw.trim().toLowerCase();
    const items: ArgumentCompletion[] = [
      { value: "status", label: "status", description: "show effective limits and their source" },
      { value: "limits ", label: "limits", description: "set default and maximum seconds" },
      { value: "reset", label: "reset", description: "clear the request's failure budget" },
    ].filter((item) => item.label.startsWith(partial));
    return items.length > 0 ? items : null;
  }
  const tokens = raw.trim().split(/\s+/).filter(Boolean);
  if ((tokens[0] ?? "").toLowerCase() !== "limits") return null;
  const endsWithWs = /\s$/.test(raw);
  // `limits <default> <max> [scope]`: the scope is token index 3. A trailing
  // space after the maximum means "complete the scope now".
  if (!endsWithWs && tokens.length !== 4) return null;
  if (endsWithWs && tokens.length !== 3) return null;
  const partial = endsWithWs ? "" : (tokens[3] ?? "");
  const scopes = ["global", "project"].filter((s) => s.startsWith(partial.toLowerCase()));
  if (scopes.length === 0) return null;
  if (suppressExactArgumentMatch(scopes, partial)) return null;
  return scopes.map((scope) => ({
    value: joinArgumentValue(raw, scope),
    label: scope,
    description: scope === "project" ? "write <cwd>/.pi/settings.json" : "write ~/.pi/agent/settings.json",
  }));
}
