/**
 * Workflow Extension — Persisted Default Model
 *
 * Pi keeps a "saved default model" (`defaultProvider` / `defaultModel` /
 * `defaultThinkingLevel` in settings.json), but only an explicit gesture
 * updates it: Ctrl+S in the model selector calls
 * `session.setModel(model, { persist: true })`, which writes
 * `setDefaultModelAndProvider` (see `dist/core/agent-session.js`). Picking a
 * model any other way is session-only, and the extension's own
 * `pi.setModel()` calls are documented as "without changing the configured
 * default for new sessions".
 *
 * This module is the extension-owned record of what the NEXT session should
 * start on, so the behaviour is identical in terminal Pi and Pi Desktop and
 * survives Pi upgrades (it is our key, not Pi's schema):
 *
 *   settings.json
 *     workflow.modelDefault = { provider, id, thinking? }   ← authoritative
 *     defaultProvider / defaultModel / defaultThinkingLevel ← mirrored for Pi
 *
 * The mirror matters because Pi itself only reads its own keys, and because
 * Pi's startup resolution prefers the FIRST `enabledModels` entry over a
 * saved default (`findInitialModel` in `dist/core/model-resolver.js`). The
 * mirror keeps terminal Pi, Pi Desktop and Pi's settings UI in agreement; the
 * extension's `session_start` apply closes the `enabledModels` gap.
 *
 * Pure, I/O-light module — unit-testable without a Pi runtime, mirroring the
 * settings discipline of commit-policy.ts / profiles.ts: read-modify-write
 * that preserves every unrelated key (Pi owns settings.json — we must never
 * clobber it), and a loader that never throws and never rewrites a file it
 * could not understand.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import type { ThinkingLevel } from "./roles.ts";
import { isValidThinkingLevel } from "./roles.ts";
import { COMMIT_CONFIG_DIR, WORKFLOW_SETTINGS_KEY } from "./commit-policy.ts";

// ── Types ────────────────────────────────────────────────────────────

/** Nested key under WORKFLOW_SETTINGS_KEY holding the persisted default. */
export const MODEL_DEFAULT_KEY = "modelDefault";

/** A model reference plus the thinking level to restore with it. */
export interface PersistedModelDefault {
  provider: string;
  id: string;
  thinking?: ThinkingLevel;
}

export interface ModelDefaultSettingPaths {
  global: string;
  project: string;
}

/** Which settings scope supplied the effective value. */
export type ModelDefaultSource = "default" | "global" | "project";

export interface ResolvedModelDefault {
  /** The effective persisted default, or undefined when none is configured. */
  value: PersistedModelDefault | undefined;
  /** Which files contributed (for /role list and /profile status). */
  sources: {
    global: boolean;
    project: boolean;
    effective: ModelDefaultSource;
  };
}

/** Minimal JSON object shape used by the read-modify-write helpers. */
type JsonObject = Record<string, unknown>;

// ── Validation ───────────────────────────────────────────────────────

/** Trim a candidate string; empty / non-string → undefined. */
function cleanString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Coerce one model reference from untrusted JSON. Returns undefined unless
 * `provider` and `id` are non-empty strings; a missing or unrecognised
 * `thinking` is dropped rather than rejecting the whole record (a hand-edited
 * file should still load its model).
 */
export function coerceModelDefault(
  raw: unknown,
): PersistedModelDefault | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const rec = raw as JsonObject;
  const provider = cleanString(rec.provider);
  const id = cleanString(rec.id);
  if (!provider || !id) return undefined;
  const thinkingRaw = cleanString(rec.thinking);
  const thinking =
    thinkingRaw && isValidThinkingLevel(thinkingRaw.toLowerCase())
      ? (thinkingRaw.toLowerCase() as ThinkingLevel)
      : undefined;
  return thinking ? { provider, id, thinking } : { provider, id };
}

/**
 * Compare two model references. Provider + id must match; `thinking` is only
 * compared when BOTH sides define one, so "same model, unknown thinking" does
 * not fabricate a difference (and therefore does not trigger a rewrite).
 */
export function sameModelRef(
  a: { provider: string; id: string; thinking?: string } | undefined,
  b: { provider: string; id: string; thinking?: string } | undefined,
): boolean {
  if (!a || !b) return false;
  if (a.provider !== b.provider || a.id !== b.id) return false;
  if (a.thinking && b.thinking) return a.thinking === b.thinking;
  return true;
}

/** Canonical `provider/id` label (no thinking suffix). */
export function formatPersistedModel(m: {
  provider: string;
  id: string;
}): string {
  return `${m.provider}/${m.id}`;
}

// ── Paths + reading ──────────────────────────────────────────────────

/**
 * Settings file locations. `agentDir` is passed in rather than read from the
 * Pi SDK so this stays pure and testable (same contract as
 * defaultProfileSettingPaths / commitConfigPaths).
 */
export function modelDefaultSettingPaths(
  cwd: string,
  agentDir: string,
): ModelDefaultSettingPaths {
  return {
    global: path.join(agentDir, "settings.json"),
    project: path.join(cwd, COMMIT_CONFIG_DIR, "settings.json"),
  };
}

function readSettingsSafe(fp: string): JsonObject | undefined {
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

/**
 * Extract `workflow.modelDefault` from a raw settings object. Anything that is
 * not a valid `{provider, id}` record (absent, wrong shape, blank strings)
 * reads as undefined.
 */
export function extractModelDefault(
  settings: unknown,
): PersistedModelDefault | undefined {
  if (!settings || typeof settings !== "object" || Array.isArray(settings))
    return undefined;
  const wf = (settings as JsonObject)[WORKFLOW_SETTINGS_KEY];
  if (!wf || typeof wf !== "object" || Array.isArray(wf)) return undefined;
  return coerceModelDefault((wf as JsonObject)[MODEL_DEFAULT_KEY]);
}

/**
 * Resolve the effective persisted default from disk. Project wins over global;
 * a corrupt or missing file reads as absent. Never throws.
 */
export function readModelDefault(
  cwd: string,
  agentDir: string,
): ResolvedModelDefault {
  const paths = modelDefaultSettingPaths(cwd, agentDir);
  const globalValue = extractModelDefault(readSettingsSafe(paths.global));
  const projectValue = extractModelDefault(readSettingsSafe(paths.project));
  const value = projectValue ?? globalValue;
  return {
    value,
    sources: {
      global: globalValue !== undefined,
      project: projectValue !== undefined,
      effective:
        projectValue !== undefined
          ? "project"
          : globalValue !== undefined
            ? "global"
            : "default",
    },
  };
}

/**
 * Which scope a write should target: the project file when it already defines
 * `workflow.modelDefault` (so an existing project override stays effective),
 * otherwise global. Mirrors the "write where the effective value lives" rule
 * used by the app's model-scope writer.
 */
export function modelDefaultWriteScope(
  cwd: string,
  agentDir: string,
): "global" | "project" {
  const paths = modelDefaultSettingPaths(cwd, agentDir);
  return extractModelDefault(readSettingsSafe(paths.project)) !== undefined
    ? "project"
    : "global";
}

// ── Writing ──────────────────────────────────────────────────────────

/** Result of a settings write. `changed` distinguishes a no-op save. */
export interface ModelDefaultWriteResult {
  path: string;
  ok: boolean;
  /** False when the file already held exactly this value (no write needed). */
  changed: boolean;
  error?: string;
}

/**
 * Read-modify-write the persisted default into a settings file.
 *
 * - `value === null` clears `workflow.modelDefault` AND the mirrored
 *   `defaultProvider` / `defaultModel` / `defaultThinkingLevel` keys.
 * - A value writes the extension key and mirrors the three Pi keys, so Pi's
 *   own startup resolution and settings UI agree with us.
 * - Every other key is preserved, including unrelated `workflow.*` entries
 *   (commitPolicy, writePolicy, defaultProfile, reviewMode, …). An empty
 *   `workflow` object is removed to keep the file tidy.
 * - Idempotent: writing a value the file already holds performs no write and
 *   reports `changed: false`.
 */
export function writeModelDefault(
  scope: "global" | "project",
  cwd: string,
  agentDir: string,
  value: PersistedModelDefault | null,
): ModelDefaultWriteResult {
  const paths = modelDefaultSettingPaths(cwd, agentDir);
  const fp = scope === "project" ? paths.project : paths.global;
  try {
    const existing = readSettingsSafe(fp);
    const root: JsonObject = existing ? { ...existing } : {};
    const wfExisting = root[WORKFLOW_SETTINGS_KEY];
    const wf: JsonObject =
      wfExisting && typeof wfExisting === "object" && !Array.isArray(wfExisting)
        ? { ...(wfExisting as JsonObject) }
        : {};

    if (value === null) {
      delete wf[MODEL_DEFAULT_KEY];
      delete root.defaultProvider;
      delete root.defaultModel;
      delete root.defaultThinkingLevel;
    } else {
      const coerced = coerceModelDefault(value);
      if (!coerced) {
        return {
          path: fp,
          ok: false,
          changed: false,
          error: "modelDefault needs a non-empty provider and id",
        };
      }
      wf[MODEL_DEFAULT_KEY] = coerced.thinking
        ? {
            provider: coerced.provider,
            id: coerced.id,
            thinking: coerced.thinking,
          }
        : { provider: coerced.provider, id: coerced.id };
      // Mirror for Pi itself (native startup + settings UI).
      root.defaultProvider = coerced.provider;
      root.defaultModel = coerced.id;
      if (coerced.thinking) root.defaultThinkingLevel = coerced.thinking;
      else delete root.defaultThinkingLevel;
    }

    if (Object.keys(wf).length === 0) delete root[WORKFLOW_SETTINGS_KEY];
    else root[WORKFLOW_SETTINGS_KEY] = wf;

    const nextText = JSON.stringify(root, null, 2) + "\n";
    const previousText = fs.existsSync(fp)
      ? fs.readFileSync(fp, "utf8")
      : undefined;
    if (previousText === nextText) {
      return { path: fp, ok: true, changed: false };
    }
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, nextText, "utf8");
    return { path: fp, ok: true, changed: true };
  } catch (e: unknown) {
    return {
      path: fp,
      ok: false,
      changed: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

// ── Session-start apply rule ─────────────────────────────────────────

/** Why a session did or did not adopt the persisted default. */
export type ModelDefaultApplyReason =
  | "apply"
  | "reason-not-new"
  | "subagent"
  | "no-persisted"
  | "live-is-persisted"
  | "live-is-explicit";

export interface ModelDefaultApplyInput {
  /** `session_start` event reason: startup | new | resume | reload. */
  reason: string | undefined;
  /** `process.env.PI_WORKFLOW_ROLE` — set on workflow's spawned subagents. */
  subagentRoleEnv: string | undefined;
  /** The live model the session is starting with, if any. */
  live: { provider: string; id: string } | undefined;
  /** `ctx.scopedModels[0]`, i.e. Pi's "first enabled model" preference. */
  scopedFirst: { provider: string; id: string } | undefined;
  /** Pi's own saved default (`defaultProvider`/`defaultModel`). */
  settingsDefault: { provider: string; id: string } | undefined;
  /** Our persisted record. */
  persisted: PersistedModelDefault | undefined;
}

export interface ModelDefaultApplyDecision {
  apply: boolean;
  reason: ModelDefaultApplyReason;
}

/**
 * Decide whether a brand-new session should adopt the persisted default.
 *
 * Guarantees (each branch is unit-tested):
 * - `resume` / `reload` never apply — a resumed session keeps its recorded
 *   model, which is Pi's own precedence.
 * - Workflow's spawned subagents (`PI_WORKFLOW_ROLE`, e.g. `pi --mode json
 *   --model <role model>`) never apply — otherwise every explore/reviewer
 *   child would be re-pointed at the chat default.
 * - An explicitly chosen live model never gets overwritten. We treat the live
 *   model as "explicit" when it differs from ALL of: Pi's first scoped model
 *   (the value Pi would have picked on its own), Pi's saved default, and our
 *   persisted record. Anything explicit (`--model`, another extension, a
 *   project default) therefore wins.
 * - When the live model already IS the persisted default, nothing to do.
 */
export function shouldApplyModelDefaultAtSessionStart(
  input: ModelDefaultApplyInput,
): ModelDefaultApplyDecision {
  if (input.reason !== "startup" && input.reason !== "new") {
    return { apply: false, reason: "reason-not-new" };
  }
  if (input.subagentRoleEnv && input.subagentRoleEnv.trim()) {
    return { apply: false, reason: "subagent" };
  }
  const persisted = input.persisted;
  if (!persisted) return { apply: false, reason: "no-persisted" };
  const live = input.live;
  if (!live) return { apply: true, reason: "apply" };
  if (sameModelRef(live, persisted)) {
    return { apply: false, reason: "live-is-persisted" };
  }
  const matchesScopedFirst = sameModelRef(live, input.scopedFirst);
  const matchesSettingsDefault = sameModelRef(live, input.settingsDefault);
  if (matchesScopedFirst || matchesSettingsDefault) {
    return { apply: true, reason: "apply" };
  }
  return { apply: false, reason: "live-is-explicit" };
}

// ── Event gating ────────────────────────────────────────────────────────

/**
 * Should a `model_select` event be recorded as the saved default?
 *
 * Only a user gesture counts: `source: "set"` (picker Enter/Ctrl+S, `/model`,
 * Pi Desktop's picker) or `source: "cycle"` (Ctrl+P / Ctrl+Alt). `"restore"`
 * is Pi re-applying a recorded model on resume/reload, and any switch made by
 * the extension itself runs with `suppressed` set.
 *
 * This is the regression lock for "entering Plan/Build must not change the
 * default model": the extension sets `suppressed` around its own switches.
 */
export function shouldPersistModelSelect(input: {
  source: string | undefined;
  suppressed: boolean;
}): boolean {
  if (input.suppressed) return false;
  return input.source === "set" || input.source === "cycle";
}

/**
 * Should a `thinking_level_select` event be recorded as the saved default's
 * thinking level?
 *
 * - Never while the extension is switching (mode entry / restore / startup).
 * - Only for the model the default refers to. A role model's thinking belongs
 *   to that role, so persisting it would corrupt the next session's default.
 * - When no default is recorded yet, the current model is adopted (a user who
 *   changes only the thinking level has made an explicit choice).
 */
export function shouldPersistThinkingSelect(input: {
  suppressed: boolean;
  current: { provider: string; id: string } | undefined;
  defaultModel: { provider: string; id: string } | undefined;
}): boolean {
  if (input.suppressed) return false;
  if (!input.current?.provider || !input.current.id) return false;
  if (!input.defaultModel) return true;
  return sameModelRef(input.current, input.defaultModel);
}

/** Short human explanation for a decision (warnings, diagnostics). */
export function describeModelDefaultApply(
  decision: ModelDefaultApplyDecision,
): string {
  switch (decision.reason) {
    case "apply":
      return "applying the saved default";
    case "reason-not-new":
      return "resumed/reloaded session — keeping its recorded model";
    case "subagent":
      return "workflow subagent — keeping its role model";
    case "no-persisted":
      return "no saved default";
    case "live-is-persisted":
      return "already on the saved default";
    case "live-is-explicit":
      return "an explicit model was selected — keeping it";
  }
}
