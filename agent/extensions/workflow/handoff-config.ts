/**
 * Workflow Extension — plan handoff target configuration.
 *
 * Plan handoff has two presenters:
 *
 * - **Plannotator** (browser review over the Pi event bus), and
 * - the workflow's **native** bottom-sheet questionnaire (plan printed into
 *   the transcript, Approve / Feedback / Skip pinned at the bottom).
 *
 * Which one is used is a user setting, `workflow.handoff`:
 *
 *   { "workflow": { "handoff": "native" } }
 *   { "workflow": { "handoff": { "mode": "auto", "timeoutMs": 15000 } } }
 *
 * Modes:
 * - `auto` (default) — Plannotator when a host is detected, native otherwise.
 * - `native` — never open the browser, never wait, no "unavailable" warning.
 * - `plannotator` — always attempt, even when detection says no host; on
 *   timeout/error fall back to native (a broken bridge is never a dead end).
 *
 * This module is deliberately free of Pi/TUI imports so the coercion, merge
 * and read/write paths are unit-testable (`handoff-config.test.ts`), mirroring
 * `review.ts`.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { reviewConfigPaths, WORKFLOW_SETTINGS_KEY } from "./review.ts";
import {
  joinArgumentValue,
  suppressExactArgumentMatch,
  type ArgumentCompletion,
} from "./utils.ts";

/** Nested key under `workflow` in settings.json. */
export const HANDOFF_SETTINGS_KEY = "handoff";

/** Handoff presenter policy. */
export type HandoffMode = "auto" | "native" | "plannotator";

/** Canonical mode order (status output and completions). */
export const HANDOFF_MODES: readonly HandoffMode[] = [
  "auto",
  "native",
  "plannotator",
];

export interface HandoffConfig {
  /**
   * `auto` uses Plannotator only when a host is detected; `native` never
   * touches the bus; `plannotator` forces the attempt regardless of detection.
   */
  mode: HandoffMode;
  /**
   * How long a browser handoff may stay unanswered before the native
   * questionnaire takes over. Only consulted when a Plannotator attempt is
   * made; `native` mode never waits.
   */
  timeoutMs: number;
}

export const DEFAULT_HANDOFF_TIMEOUT_MS = 15_000;
export const HANDOFF_TIMEOUT_MIN = 1_000;
export const HANDOFF_TIMEOUT_MAX = 300_000;

export const DEFAULT_HANDOFF_CONFIG: Readonly<HandoffConfig> = {
  mode: "auto",
  timeoutMs: DEFAULT_HANDOFF_TIMEOUT_MS,
};

/** A JSON object parsed from an untrusted source. */
export type JsonObject = Record<string, unknown>;

/**
 * A raw `workflow.handoff` fragment: the string shorthand or an object with
 * `mode`/`timeoutMs`.
 */
export type RawHandoffSetting = JsonObject | string | undefined;

/** Which settings scope supplied a field's effective value. */
export type HandoffConfigScopeSource = "default" | "global" | "project";

export interface ResolvedHandoffConfig {
  config: HandoffConfig;
  sources: {
    global: boolean;
    project: boolean;
    mode: HandoffConfigScopeSource;
    timeout: HandoffConfigScopeSource;
  };
}

function clampInt(
  value: unknown,
  min: number,
  max: number,
  fallback: number,
): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

/** True when `value` is one of the supported modes. */
export function isHandoffMode(value: unknown): value is HandoffMode {
  return (
    value === "auto" || value === "native" || value === "plannotator"
  );
}

function normalizeMode(value: unknown): HandoffMode | undefined {
  if (typeof value !== "string") return undefined;
  const lower = value.trim().toLowerCase();
  return isHandoffMode(lower) ? lower : undefined;
}

/**
 * Coerce an untrusted `workflow.handoff` fragment into a complete config.
 *
 * Accepts the string shorthand (`"native"`) or `{ mode?, timeoutMs? }`.
 * Invalid/missing fields fall back to `base`; never throws.
 */
export function coerceHandoffConfig(
  raw: unknown,
  base: HandoffConfig = DEFAULT_HANDOFF_CONFIG as HandoffConfig,
): HandoffConfig {
  if (typeof raw === "string") {
    const mode = normalizeMode(raw);
    return { ...base, ...(mode ? { mode } : {}) };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ...base };
  }
  const r = raw as Record<string, unknown>;
  const mode = normalizeMode(r.mode);
  return {
    mode: mode ?? base.mode,
    timeoutMs: clampInt(
      r.timeoutMs,
      HANDOFF_TIMEOUT_MIN,
      HANDOFF_TIMEOUT_MAX,
      base.timeoutMs,
    ),
  };
}

/** Extract the `workflow.handoff` fragment from a raw settings object. */
export function extractHandoffRaw(
  settings: unknown,
): RawHandoffSetting {
  if (!settings || typeof settings !== "object" || Array.isArray(settings))
    return undefined;
  const wf = (settings as JsonObject)[WORKFLOW_SETTINGS_KEY];
  if (!wf || typeof wf !== "object" || Array.isArray(wf)) return undefined;
  const raw = (wf as JsonObject)[HANDOFF_SETTINGS_KEY];
  if (typeof raw === "string") return raw;
  if (raw && typeof raw === "object" && !Array.isArray(raw))
    return raw as JsonObject;
  return undefined;
}

/**
 * Merge global then project fragments; project wins field by field, global
 * wins over defaults. Same precedence as `workflow.reviewMode`.
 */
export function mergeHandoffConfig(
  globalRaw: RawHandoffSetting,
  projectRaw: RawHandoffSetting,
): HandoffConfig {
  const fromGlobal = coerceHandoffConfig(globalRaw);
  return coerceHandoffConfig(projectRaw, fromGlobal);
}

function hasField(raw: RawHandoffSetting, key: "mode" | "timeoutMs"): boolean {
  if (typeof raw === "string") return key === "mode";
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  return Object.prototype.hasOwnProperty.call(raw, key);
}

/**
 * Which scope supplied a field's effective value. Pure and total.
 */
export function handoffFieldSourceOf(
  globalRaw: RawHandoffSetting,
  projectRaw: RawHandoffSetting,
  key: "mode" | "timeoutMs",
): HandoffConfigScopeSource {
  if (hasField(projectRaw, key)) return "project";
  if (hasField(globalRaw, key)) return "global";
  return "default";
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

/** Settings file locations, shared with Review Mode. */
export function handoffConfigPaths(
  cwd: string,
  agentDir: string,
): { global: string; project: string } {
  return reviewConfigPaths(cwd, agentDir);
}

/**
 * Resolve the effective handoff config from disk. Never throws — a corrupt or
 * missing file falls back to defaults (`auto`, 15 s).
 */
export function readHandoffConfig(
  cwd: string,
  agentDir: string,
): ResolvedHandoffConfig {
  const paths = handoffConfigPaths(cwd, agentDir);
  const globalRaw = extractHandoffRaw(readJsonSafe(paths.global));
  const projectRaw = extractHandoffRaw(readJsonSafe(paths.project));
  return {
    config: mergeHandoffConfig(globalRaw, projectRaw),
    sources: {
      global: globalRaw !== undefined,
      project: projectRaw !== undefined,
      mode: handoffFieldSourceOf(globalRaw, projectRaw, "mode"),
      timeout: handoffFieldSourceOf(globalRaw, projectRaw, "timeoutMs"),
    },
  };
}

/**
 * Read-modify-write `workflow.handoff` into a settings file, preserving every
 * other key (Pi owns settings.json — including `workflow.reviewMode` and the
 * other policy blocks).
 *
 * Only the patched fields are written. Unlike `writeReviewModeConfig` (which
 * pins the complete object), a handoff write stays sparse so a project
 * `/handoff native` does not shadow a global `timeoutMs` with the default.
 */
export function writeHandoffConfig(
  scope: "global" | "project",
  cwd: string,
  agentDir: string,
  patch: Partial<HandoffConfig>,
): { path: string; ok: boolean; error?: string } {
  const paths = handoffConfigPaths(cwd, agentDir);
  const fp = scope === "project" ? paths.project : paths.global;
  try {
    const existing = readJsonSafe(fp);
    const root: JsonObject = existing ? { ...existing } : {};
    const wfExisting = root[WORKFLOW_SETTINGS_KEY];
    const wf: JsonObject =
      wfExisting && typeof wfExisting === "object" && !Array.isArray(wfExisting)
        ? { ...(wfExisting as JsonObject) }
        : {};
    const existingRaw = wf[HANDOFF_SETTINGS_KEY];
    const current = coerceHandoffConfig(existingRaw);
    const coerced = coerceHandoffConfig({ ...current, ...patch }, current);
    let next: JsonObject = {};
    if (
      existingRaw &&
      typeof existingRaw === "object" &&
      !Array.isArray(existingRaw)
    ) {
      next = { ...(existingRaw as JsonObject) };
    } else if (typeof existingRaw === "string") {
      next = { mode: existingRaw };
    }
    if (patch.mode !== undefined) next.mode = coerced.mode;
    if (patch.timeoutMs !== undefined) next.timeoutMs = coerced.timeoutMs;
    wf[HANDOFF_SETTINGS_KEY] = next;
    root[WORKFLOW_SETTINGS_KEY] = wf;
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, JSON.stringify(root, null, 2) + "\n", "utf8");
    return { path: fp, ok: true };
  } catch (e: unknown) {
    return {
      path: fp,
      error: e instanceof Error ? e.message : String(e),
      ok: false,
    };
  }
}

/**
 * Whether the browser presenter should be attempted.
 *
 * `auto` depends on live detection; `plannotator` deliberately ignores it so a
 * wrongly-undetected bridge can still be tried; `native` never uses the bus.
 */
export function shouldUsePlannotator(
  mode: HandoffMode,
  detected: boolean,
): boolean {
  if (mode === "native") return false;
  if (mode === "plannotator") return true;
  return detected;
}

/**
 * Effective per-attempt timeout.
 *
 * An explicit deps value (tests / embedders) wins over user config so the
 * suite's 50 ms seam stays authoritative; production has no deps value and
 * uses `workflow.handoff.timeoutMs`.
 */
export function resolveHandoffTimeout(
  depsMs: number | undefined,
  configMs: number,
): number {
  if (typeof depsMs === "number" && Number.isFinite(depsMs)) return depsMs;
  return clampInt(
    configMs,
    HANDOFF_TIMEOUT_MIN,
    HANDOFF_TIMEOUT_MAX,
    DEFAULT_HANDOFF_TIMEOUT_MS,
  );
}

/** One-line meaning of a mode, for status output, completions and notices. */
export function describeHandoffMode(mode: HandoffMode): string {
  switch (mode) {
    case "native":
      return "plan goes to the native questionnaire — never opens the browser";
    case "plannotator":
      return "always try Plannotator; fall back to native on timeout/error";
    case "auto":
    default:
      return "Plannotator when a host is detected, native otherwise";
  }
}

const HANDOFF_SCOPES: readonly { token: string; description: string }[] = [
  { token: "global", description: "write to ~/.pi/agent/settings.json" },
  { token: "project", description: "write to <cwd>/.pi/settings.json" },
];

/** `/handoff fallback`: convert the pending handoff to the native sheet now. */
export const HANDOFF_FALLBACK_TOKEN = "fallback";
export const HANDOFF_FALLBACK_DESCRIPTION =
  "present the pending plan handoff in the native questionnaire now";

/**
 * Argument completions for `/handoff` (pure; unit-tested).
 *
 * Follows the pi-tui full-argument contract (see `joinArgumentValue`): the
 * first token completes a mode, the second completes the write scope, and
 * every `value` is the complete replacement for the typed argument text.
 * Exact-match suppression closes the dropdown on an unambiguous token.
 */
export function handoffArgumentCompletions(
  argumentPrefix: string,
): ArgumentCompletion[] | null {
  const raw = String(argumentPrefix ?? "");
  const join = (token: string) => joinArgumentValue(raw, token);

  // ── Mode position: no whitespace typed yet ──────────────────────────
  if (!raw.trim() || !/\s/.test(raw)) {
    const lower = raw.trim().toLowerCase();
    const modes = HANDOFF_MODES.filter((mode) => mode.startsWith(lower));
    const items: ArgumentCompletion[] = modes.map((mode) => ({
      value: `${mode} `,
      label: mode,
      description: describeHandoffMode(mode),
    }));
    if (HANDOFF_FALLBACK_TOKEN.startsWith(lower)) {
      items.push({
        value: HANDOFF_FALLBACK_TOKEN,
        label: HANDOFF_FALLBACK_TOKEN,
        description: HANDOFF_FALLBACK_DESCRIPTION,
      });
    }
    return items.length > 0 ? items : null;
  }

  // ── Scope position: a mode is already committed ─────────────────────
  const tokens = raw.trim().split(/\s+/).filter(Boolean);
  const mode = (tokens[0] ?? "").toLowerCase();
  if (!isHandoffMode(mode)) return null;
  if (tokens.length > 2) return null;
  const endsWithWs = /\s$/.test(raw);
  if (tokens.length === 2 && endsWithWs) return null;
  const partial = endsWithWs ? "" : (tokens[tokens.length - 1] ?? "");
  const items: ArgumentCompletion[] = HANDOFF_SCOPES.flatMap((scope) =>
    scope.token.startsWith(partial.toLowerCase())
      ? [
          {
            value: join(scope.token),
            label: scope.token,
            description: scope.description,
          },
        ]
      : [],
  );
  if (items.length === 0) return null;
  if (suppressExactArgumentMatch(items.map((i) => i.label), partial)) {
    return null;
  }
  return items;
}
