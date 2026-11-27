/**
 * Workflow Extension — scoped prompt-refinement model configuration.
 *
 * Prompt refinement uses a dedicated optional setting:
 *
 *   settings.json
 *     workflow.promptRefinement.model = { provider, id, thinking? }  ← override
 *     workflow.promptRefinement.model = { inherit: true }             ← sentinel
 *
 * The setting exists in two scopes:
 *
 *   global  ~/.pi/agent/settings.json
 *   project <cwd>/.pi/settings.json        (only for trusted projects)
 *
 * Precedence (confirmed in the plan):
 *
 *   trusted project setting (including an explicit inherit sentinel)
 *     → global setting
 *       → inherit the authoritative Default-mode model
 *
 * An explicit project `inherit` is *not* an absent key: it deliberately
 * suppresses a global override and follows Default mode. `/prompt-model reset`
 * removes only the selected scope's value, so resetting a project override can
 * reveal a global override.
 *
 * This module is deliberately I/O-light and framework-free, mirroring
 * commit-policy.ts / model-default.ts: read-modify-write that preserves every
 * unrelated key, no SDK imports, and no file rewrite when JSON cannot be
 * understood. Writes are serialized per process and use a temporary file plus
 * rename, so two unrelated setting updates cannot interleave a partial file.
 *
 * It never writes Pi's own `defaultProvider` / `defaultModel` /
 * `defaultThinkingLevel` mirror, `workflow.modelDefault`, roles or profiles.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { COMMIT_CONFIG_DIR, WORKFLOW_SETTINGS_KEY } from "./commit-policy.ts";
import {
  coerceModelDefault,
  formatPersistedModel,
  type PersistedModelDefault,
} from "./model-default.ts";
import {
  VALID_THINKING_LEVELS,
  isValidThinkingLevel,
  parseModelRef,
  type ThinkingLevel,
} from "./roles.ts";
import { thinkingLevelsForPair } from "./thinking-levels.ts";
import {
  joinArgumentValue,
  suppressExactArgumentMatch,
  type ArgumentCompletion,
} from "./utils.ts";

// ── Keys and paths ───────────────────────────────────────────────────

/** Nested key under WORKFLOW_SETTINGS_KEY that namespaces refinement config. */
export const PROMPT_REFINEMENT_KEY = "promptRefinement";

/** Nested key under `workflow.promptRefinement` holding the model setting. */
export const PROMPT_REFINEMENT_MODEL_KEY = "model";

/** The two scopes a refinement-model setting may live in. */
export type RefinementModelScope = "global" | "project";

export interface RefinementModelConfigPaths {
  global: string;
  project: string;
}

/**
 * Settings file locations. `agentDir` is injected rather than read from the Pi
 * SDK so this stays pure and unit-testable (same contract as
 * commitConfigPaths / modelDefaultSettingPaths).
 */
export function refinementModelConfigPaths(
  cwd: string,
  agentDir: string,
): RefinementModelConfigPaths {
  return {
    global: path.join(agentDir, "settings.json"),
    project: path.join(cwd, COMMIT_CONFIG_DIR, "settings.json"),
  };
}

// ── Setting shape ────────────────────────────────────────────────────

/** A validated refinement override (thinking is optional). */
export type RefinementModelOverride = PersistedModelDefault;

/** A scope value: an override model or an explicit inherit sentinel. */
export type RefinementModelSetting =
  | { kind: "inherit" }
  | { kind: "override"; model: RefinementModelOverride };

type JsonObject = Record<string, unknown>;

function isPlainObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function cleanString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

/** Canonical override label; adds the thinking level only when configured. */
export function formatRefinementOverride(model: RefinementModelOverride): string {
  return `${formatPersistedModel(model)}${
    model.thinking ? ` (${model.thinking})` : ""
  }`;
}

/**
 * Coerce one untrusted `workflow.promptRefinement.model` fragment.
 *
 * - `undefined` / `null` means "no setting at this scope" (`absent`).
 * - `"inherit"` / `{ inherit: true }` is the explicit inherit sentinel.
 * - `{ provider, id, thinking? }` is a validated override.
 * - Anything else is `invalid` **with a reason**: an explicit setting is never
 *   silently downgraded to inheritance (that would be an undeclared fallback).
 */
export type RefinementModelSettingCoercion =
  | { kind: "absent" }
  | { kind: "valid"; setting: RefinementModelSetting }
  | { kind: "invalid"; error: string };

export function coerceRefinementModelSetting(
  raw: unknown,
): RefinementModelSettingCoercion {
  if (raw === undefined || raw === null) return { kind: "absent" };

  if (typeof raw === "string") {
    if (raw.trim().toLowerCase() === "inherit") {
      return { kind: "valid", setting: { kind: "inherit" } };
    }
    return {
      kind: "invalid",
      error: `expected a model object or "inherit", got "${raw.trim()}"`,
    };
  }

  if (!isPlainObject(raw)) {
    return {
      kind: "invalid",
      error: "expected an object with provider/id, or { inherit: true }",
    };
  }

  if ("inherit" in raw) {
    if (raw.inherit === true) {
      return { kind: "valid", setting: { kind: "inherit" } };
    }
    return {
      kind: "invalid",
      error: "inherit must be true when present",
    };
  }

  const provider = cleanString(raw.provider);
  const id = cleanString(raw.id);
  if (!provider || !id) {
    return {
      kind: "invalid",
      error: "provider and id must both be non-empty strings",
    };
  }
  if (/\s/.test(provider)) {
    return {
      kind: "invalid",
      error: "provider must not contain whitespace",
    };
  }
  // Provider-qualified IDs may contain additional "/" characters (for example
  // `openrouter/anthropic/claude-...`). The first slash separates provider from
  // ID; never split on the last slash.
  if (id.includes(" ") || id.includes("\t")) {
    return {
      kind: "invalid",
      error: "model id must not contain whitespace",
    };
  }

  let thinking: ThinkingLevel | undefined;
  if (raw.thinking !== undefined && raw.thinking !== null) {
    if (typeof raw.thinking !== "string") {
      return {
        kind: "invalid",
        error: `thinking must be one of ${VALID_THINKING_LEVELS.join("|")}`,
      };
    }
    const normalized = raw.thinking.trim().toLowerCase();
    if (!normalized) {
      thinking = undefined;
    } else if (!isValidThinkingLevel(normalized)) {
      return {
        kind: "invalid",
        error: `unknown thinking level "${raw.thinking}" (valid: ${VALID_THINKING_LEVELS.join("|")})`,
      };
    } else {
      thinking = normalized;
    }
  }

  const model: RefinementModelOverride = thinking
    ? { provider, id, thinking }
    : { provider, id };
  return { kind: "valid", setting: { kind: "override", model } };
}

/** The override carried by a setting, or undefined for an inherit sentinel. */
export function refinementOverrideOf(
  setting: RefinementModelSetting | undefined,
): RefinementModelOverride | undefined {
  return setting?.kind === "override" ? { ...setting.model } : undefined;
}

/** Raw JSON written for a setting (kept minimal and hand-readable). */
export function refinementSettingToRaw(
  setting: RefinementModelSetting,
): JsonObject {
  if (setting.kind === "inherit") return { inherit: true };
  const model = coerceModelDefault(setting.model);
  if (!model) return { inherit: true };
  return model.thinking
    ? { provider: model.provider, id: model.id, thinking: model.thinking }
    : { provider: model.provider, id: model.id };
}

// ── Reading settings files ───────────────────────────────────────────

interface SettingsFileRead {
  exists: boolean;
  root?: JsonObject;
  /** Present when the file exists but is not a readable JSON object. */
  error?: string;
}

/**
 * Parse a settings file strictly. A malformed file is reported, never treated
 * as empty: replacing it with `{}` would destroy every unrelated setting.
 */
function readSettingsFile(filePath: string): SettingsFileRead {
  try {
    if (!fs.existsSync(filePath)) return { exists: false };
    const text = fs.readFileSync(filePath, "utf8");
    const parsed: unknown = JSON.parse(text);
    if (!isPlainObject(parsed)) {
      return {
        exists: true,
        error: "top-level JSON value is not an object",
      };
    }
    return { exists: true, root: parsed };
  } catch (error: unknown) {
    return {
      exists: true,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Extract the raw `workflow.promptRefinement.model` value, if any. */
export function extractRefinementModelRaw(settings: unknown): unknown {
  if (!isPlainObject(settings)) return undefined;
  const wf = settings[WORKFLOW_SETTINGS_KEY];
  if (!isPlainObject(wf)) return undefined;
  const pr = wf[PROMPT_REFINEMENT_KEY];
  if (!isPlainObject(pr)) return undefined;
  return pr[PROMPT_REFINEMENT_MODEL_KEY];
}

// ── Resolution ───────────────────────────────────────────────────────

export type RefinementModelScopeKind =
  | "absent"
  | "inherit"
  | "override"
  | "invalid";

export interface RefinementModelScopeState {
  kind: RefinementModelScopeKind;
  model?: RefinementModelOverride;
  error?: string;
}

export type RefinementSettingSource =
  | "project"
  | "global"
  | "default"
  | "invalid";

export interface ResolvedRefinementModelConfig {
  /** Which scope supplied the effective setting (or `default`/`invalid`). */
  source: RefinementSettingSource;
  /** Effective setting for `project`/`global`; absent for default/invalid. */
  setting?: RefinementModelSetting;
  /** Actionable reason when `source === "invalid"`. */
  error?: string;
  scopes: {
    global: RefinementModelScopeState;
    project: RefinementModelScopeState;
    projectTrusted: boolean;
    /** True when a project value exists but trust withheld it. */
    projectIgnored: boolean;
  };
  paths: RefinementModelConfigPaths;
  /** Provenance / shadowing lines for `/prompt-model status`. */
  notes: string[];
}

function readScope(filePath: string): RefinementModelScopeState {
  const read = readSettingsFile(filePath);
  if (!read.exists) return { kind: "absent" };
  if (read.error) {
    return {
      kind: "invalid",
      error: `${filePath} is not valid JSON (${read.error})`,
    };
  }
  const raw = extractRefinementModelRaw(read.root);
  const coerced = coerceRefinementModelSetting(raw);
  if (coerced.kind === "absent") return { kind: "absent" };
  if (coerced.kind === "invalid") {
    return { kind: "invalid", error: coerced.error };
  }
  if (coerced.setting.kind === "inherit") return { kind: "inherit" };
  return { kind: "override", model: { ...coerced.setting.model } };
}

/**
 * Resolve the effective refinement-model setting from disk.
 *
 * Never throws. A malformed file / invalid explicit setting is surfaced as
 * `invalid` when it would govern the effective value; it never silently falls
 * back to a lower-precedence scope.
 */
export function readRefinementModelConfig(
  cwd: string,
  agentDir: string,
  options: { trusted?: boolean } = {},
): ResolvedRefinementModelConfig {
  const paths = refinementModelConfigPaths(cwd, agentDir);
  const global = readScope(paths.global);
  const project = readScope(paths.project);
  const projectTrusted = options.trusted === true;
  const projectIgnored = !projectTrusted && project.kind !== "absent";

  const notes: string[] = [];
  if (projectIgnored) {
    notes.push(
      `Project refinement setting (${project.kind}) ignored: this project is not trusted.`,
    );
  }
  if (project.kind === "override" && global.kind !== "absent") {
    notes.push(
      "Project override shadows the global refinement setting for this project.",
    );
  }
  if (project.kind === "inherit" && global.kind !== "absent") {
    notes.push(
      "Project inherit sentinel suppresses the global refinement setting; refinement follows Default mode here.",
    );
  }
  if (project.kind === "absent" && global.kind !== "absent") {
    notes.push("Global refinement setting applies to this project.");
  }

  if (projectTrusted && project.kind === "invalid") {
    notes.push(
      "The trusted project refinement setting is invalid; fix it or run /prompt-model reset project.",
    );
    return {
      source: "invalid",
      error: project.error ?? "invalid project refinement setting",
      scopes: { global, project, projectTrusted, projectIgnored },
      paths,
      notes,
    };
  }
  if (projectTrusted && (project.kind === "inherit" || project.kind === "override")) {
    return {
      source: "project",
      setting:
        project.kind === "inherit"
          ? { kind: "inherit" }
          : { kind: "override", model: { ...(project.model as RefinementModelOverride) } },
      scopes: { global, project, projectTrusted, projectIgnored },
      paths,
      notes,
    };
  }

  if (global.kind === "invalid") {
    notes.push(
      "The global refinement setting is invalid; fix it or run /prompt-model reset global.",
    );
    return {
      source: "invalid",
      error: global.error ?? "invalid global refinement setting",
      scopes: { global, project, projectTrusted, projectIgnored },
      paths,
      notes,
    };
  }
  if (global.kind === "inherit" || global.kind === "override") {
    return {
      source: "global",
      setting:
        global.kind === "inherit"
          ? { kind: "inherit" }
          : { kind: "override", model: { ...(global.model as RefinementModelOverride) } },
      scopes: { global, project, projectTrusted, projectIgnored },
      paths,
      notes,
    };
  }

  notes.push(
    "No refinement override is configured — refinement inherits the Default-mode model.",
  );
  return {
    source: "default",
    scopes: { global, project, projectTrusted, projectIgnored },
    paths,
    notes,
  };
}

// ── Write discipline ─────────────────────────────────────────────────

export interface SettingsWriteResult {
  path: string;
  ok: boolean;
  /** False when the file already held exactly this value (no write needed). */
  changed: boolean;
  error?: string;
}

type SettingsMutationResult = { ok: true } | { ok: false; error: string };

/**
 * Process-wide serialization queue for settings writes. Two command handlers
 * (or a command and a future integration) never interleave a read-modify-write
 * on the same file through this helper.
 */
let settingsWriteChain: Promise<unknown> = Promise.resolve();

function enqueueSettingsWrite<T>(task: () => Promise<T> | T): Promise<T> {
  const run = settingsWriteChain.then(task, task);
  settingsWriteChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function atomicWriteText(filePath: string, text: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.${Math.floor(
    Math.random() * 1e6,
  )}.tmp`;
  try {
    fs.writeFileSync(temporary, text, "utf8");
    fs.renameSync(temporary, filePath);
  } catch (error) {
    try {
      fs.rmSync(temporary, { force: true });
    } catch {
      // Best-effort cleanup must not replace the write error.
    }
    throw error;
  }
}

/**
 * Serialized, atomic read-modify-write of one settings JSON file.
 *
 * The file is re-read **inside** the queue, so an unrelated edit that landed
 * before this write is preserved. A malformed or non-object file is refused
 * rather than replaced. A no-op mutation does not touch the file.
 *
 * Exported so tests (and future settings features) can exercise the shared
 * serialization/atomicity contract without duplicating it.
 */
export function updateSettingsFileAtomic(
  filePath: string,
  mutate: (root: JsonObject) => SettingsMutationResult,
): Promise<SettingsWriteResult> {
  return enqueueSettingsWrite(() => {
    const read = readSettingsFile(filePath);
    if (read.exists && read.error) {
      return {
        path: filePath,
        ok: false,
        changed: false,
        error: `refusing to rewrite malformed settings: ${read.error}`,
      };
    }
    const root: JsonObject = read.root ? { ...read.root } : {};
    let mutated: SettingsMutationResult;
    try {
      mutated = mutate(root);
    } catch (error: unknown) {
      return {
        path: filePath,
        ok: false,
        changed: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    if (!mutated.ok) {
      return { path: filePath, ok: false, changed: false, error: mutated.error };
    }
    const nextText = JSON.stringify(root, null, 2) + "\n";
    let previousText: string | undefined;
    try {
      previousText = fs.existsSync(filePath)
        ? fs.readFileSync(filePath, "utf8")
        : undefined;
    } catch (error: unknown) {
      return {
        path: filePath,
        ok: false,
        changed: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    if (previousText === nextText) {
      return { path: filePath, ok: true, changed: false };
    }
    try {
      atomicWriteText(filePath, nextText);
      return { path: filePath, ok: true, changed: true };
    } catch (error: unknown) {
      return {
        path: filePath,
        ok: false,
        changed: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });
}

/**
 * Write or reset one scope's `workflow.promptRefinement.model`.
 *
 * - `null` resets only that scope (project reset reveals a global override).
 * - `{ kind: "inherit" }` writes the explicit inherit sentinel.
 * - `{ kind: "override", model }` writes a validated model.
 *
 * Unrelated keys — including Pi's default-model mirror, `workflow.modelDefault`,
 * roles and profiles — are preserved untouched.
 */
export function writeRefinementModelSetting(
  scope: RefinementModelScope,
  cwd: string,
  agentDir: string,
  value: RefinementModelSetting | null,
): Promise<SettingsWriteResult> {
  const paths = refinementModelConfigPaths(cwd, agentDir);
  const filePath = scope === "project" ? paths.project : paths.global;
  return updateSettingsFileAtomic(filePath, (root) => {
    const wfRaw = root[WORKFLOW_SETTINGS_KEY];
    if (wfRaw !== undefined && !isPlainObject(wfRaw)) {
      return {
        ok: false,
        error:
          '"workflow" is not a JSON object; refusing to overwrite unrelated settings',
      };
    }
    const wf: JsonObject = wfRaw ? { ...wfRaw } : {};
    const prRaw = wf[PROMPT_REFINEMENT_KEY];
    if (prRaw !== undefined && !isPlainObject(prRaw)) {
      return {
        ok: false,
        error:
          '"workflow.promptRefinement" is not a JSON object; refusing to overwrite unrelated settings',
      };
    }
    const pr: JsonObject = prRaw ? { ...prRaw } : {};

    if (value === null) {
      delete pr[PROMPT_REFINEMENT_MODEL_KEY];
    } else {
      pr[PROMPT_REFINEMENT_MODEL_KEY] = refinementSettingToRaw(value);
    }

    if (Object.keys(pr).length === 0) delete wf[PROMPT_REFINEMENT_KEY];
    else wf[PROMPT_REFINEMENT_KEY] = pr;

    if (Object.keys(wf).length === 0) delete root[WORKFLOW_SETTINGS_KEY];
    else root[WORKFLOW_SETTINGS_KEY] = wf;
    return { ok: true };
  });
}

// ── Set-command validation ───────────────────────────────────────────

export interface RefinementModelChoiceInput {
  /** The literal `<provider/model>` argument. Extra slashes stay in the ID. */
  ref: string;
  /** Optional thinking level argument. */
  thinking?: string;
  /** Registry entry when the model was found (capability validation). */
  model?: unknown;
  /**
   * True when a model registry lookup was available. With no entry, `set`
   * refuses instead of saving a model this Pi cannot resolve.
   */
  registryAvailable?: boolean;
}

export type RefinementModelChoiceResult =
  | { ok: true; model: RefinementModelOverride; warnings: string[] }
  | { ok: false; error: string };

/**
 * Validate a `/prompt-model set <provider/model> [thinking]` request.
 *
 * - Additional `/` characters belong to the model ID (first slash is the only
 *   separator), matching roles.ts `parseModelRef`.
 * - An explicit thinking level must be a Pi level; a known model clamps it with
 *   the same `thinkingLevelsForPair` helper `/role set` uses (a nonreasoning
 *   model therefore stores `off` and warns instead of silently keeping `high`).
 * - A missing registry entry is a refusal when a registry was available; when
 *   no registry exists (offline/headless editing) the value is saved with a
 *   warning so configuration is still possible.
 */
export function validateRefinementModelChoice(
  input: RefinementModelChoiceInput,
): RefinementModelChoiceResult {
  const ref = String(input.ref ?? "").trim();
  if (!ref) {
    return {
      ok: false,
      error: "Model must be provider/model (e.g. opencode-go/muse-spark-1.2-contributor).",
    };
  }
  const { provider, id } = parseModelRef(ref);
  if (!provider || !id) {
    return {
      ok: false,
      error: `Model must be provider/model (provider and id required). Got: ${ref}`,
    };
  }
  if (/\s/.test(provider) || /\s/.test(id)) {
    return {
      ok: false,
      error: `Model reference must not contain whitespace. Got: ${ref}`,
    };
  }

  const warnings: string[] = [];
  let thinking: ThinkingLevel | undefined;
  if (input.thinking !== undefined && input.thinking !== null) {
    const rawThinking = String(input.thinking).trim();
    if (rawThinking) {
      const normalized = rawThinking.toLowerCase();
      if (!isValidThinkingLevel(normalized)) {
        return {
          ok: false,
          error: `Invalid thinking level "${rawThinking}". Valid: ${VALID_THINKING_LEVELS.join("|")}`,
        };
      }
      thinking = normalized;
    }
  }

  if (input.model === undefined) {
    if (input.registryAvailable === true) {
      return {
        ok: false,
        error: `Model ${provider}/${id} is not in the model registry. Set up the provider first, or use /prompt-model inherit.`,
      };
    }
    warnings.push(
      `Model registry unavailable — saved ${provider}/${id} without capability validation.`,
    );
  } else if (thinking !== undefined) {
    const pair = thinkingLevelsForPair(input.model, thinking);
    if (pair.level !== thinking) {
      warnings.push(
        `Thinking ${thinking} is not supported by ${provider}/${id}; using ${pair.level}.`,
      );
    }
    thinking = pair.level;
  }

  return {
    ok: true,
    model: thinking ? { provider, id, thinking } : { provider, id },
    warnings,
  };
}

// ── Display ──────────────────────────────────────────────────────────

function describeScopeState(state: RefinementModelScopeState): string {
  switch (state.kind) {
    case "absent":
      return "not set";
    case "inherit":
      return "inherit (explicit sentinel)";
    case "override":
      return state.model ? formatRefinementOverride(state.model) : "invalid";
    case "invalid":
      return `invalid — ${state.error ?? "unreadable value"}`;
  }
}

/**
 * `/prompt-model status` body. Includes effective model/thinking, provenance,
 * both scopes and explicit shadowing/inheritance notes.
 */
export function formatRefinementModelStatus(
  resolved: ResolvedRefinementModelConfig,
): string {
  const effective =
    resolved.source === "invalid"
      ? `unresolved — ${resolved.error ?? "invalid configuration"}`
      : resolved.source === "default"
        ? "Default-mode model (inherit)"
        : resolved.setting?.kind === "inherit"
          ? "Default-mode model (explicit inherit)"
          : resolved.setting?.kind === "override"
            ? formatRefinementOverride(resolved.setting.model)
            : "Default-mode model (inherit)";

  const sourceLabel =
    resolved.source === "project"
      ? "trusted project setting"
      : resolved.source === "global"
        ? "global setting"
        : resolved.source === "default"
          ? "inherited Default mode (no scope set)"
          : "invalid explicit setting (refinement will refuse)";

  return [
    `Refinement model: ${effective}`,
    `  source: ${sourceLabel}`,
    `  global: ${describeScopeState(resolved.scopes.global)}`,
    `  project: ${describeScopeState(resolved.scopes.project)}${
      resolved.scopes.projectIgnored ? " (ignored: project not trusted)" : ""
    }`,
    ...resolved.notes.map((note) => `  ${note}`),
    `Global settings: ${resolved.paths.global}`,
    `Project settings: ${resolved.paths.project}`,
    "Usage: /prompt-model [status] | set <provider/model> [thinking] [global|project] | inherit [global|project] | reset [global|project]",
  ].join("\n");
}

// ── Argument completions (/prompt-model) ─────────────────────────────

const PROMPT_MODEL_SUBS: readonly {
  name: string;
  label: string;
  description: string;
}[] = [
  {
    name: "status",
    label: "status",
    description: "show effective model, source and scoped settings",
  },
  {
    name: "set",
    label: "set",
    description: "save a validated provider/model override",
  },
  {
    name: "inherit",
    label: "inherit",
    description: "write an explicit inherit sentinel at this scope",
  },
  {
    name: "reset",
    label: "reset",
    description: "remove this scope's setting (project reset reveals global)",
  },
];

const PROMPT_MODEL_SCOPES: readonly {
  token: string;
  description: string;
}[] = [
  { token: "global", description: "write to ~/.pi/agent/settings.json" },
  { token: "project", description: "write to <cwd>/.pi/settings.json (trusted)" },
];

const THINKING_TOKENS: readonly {
  token: string;
  description: string;
}[] = VALID_THINKING_LEVELS.map((level) => ({
  token: level,
  description:
    level === "off"
      ? "no extended thinking (nonreasoning models store this)"
      : `${level} thinking`,
}));

function tokenItems(
  raw: string,
  tokens: readonly { token: string; description: string }[],
  partial: string,
): ArgumentCompletion[] {
  return tokens
    .filter((item) => item.token.startsWith(partial.toLowerCase()))
    .map((item) => ({
      value: joinArgumentValue(raw, item.token),
      label: item.token,
      description: item.description,
    }));
}

/**
 * Argument completions for `/prompt-model` (pure; unit-tested).
 *
 * Follows the pi-tui full-argument contract: every returned `value` is the
 * complete replacement for the typed argument text. Model identifiers are
 * offered only when `modelRefs` is supplied (the command can pass registry
 * labels); `set` still works without them.
 */
export function promptModelArgumentCompletions(
  argumentPrefix: string,
  options: { modelRefs?: readonly string[] } = {},
): ArgumentCompletion[] | null {
  const raw = String(argumentPrefix ?? "");
  const trimmed = raw.trim();
  const endsWithWs = /\s$/.test(raw);
  const tokens = trimmed ? trimmed.split(/\s+/).filter(Boolean) : [];
  const partial = endsWithWs || tokens.length === 0 ? "" : tokens[tokens.length - 1]!;

  // Subcommand position.
  if (tokens.length === 0 || (tokens.length === 1 && !endsWithWs)) {
    const lower = partial.toLowerCase();
    const items = PROMPT_MODEL_SUBS.filter((sub) =>
      sub.name.startsWith(lower),
    ).map((sub) => ({
      value: `${sub.name} `,
      label: sub.label,
      description: sub.description,
    }));
    if (items.length === 0) return null;
    if (
      suppressExactArgumentMatch(
        items.map((item) => item.label),
        partial,
      )
    ) {
      return null;
    }
    return items;
  }

  const sub = (tokens[0] ?? "").toLowerCase();
  if (sub === "status") return null;

  if (sub === "inherit" || sub === "reset") {
    if (tokens.length >= 2 && !endsWithWs) return null;
    const items = tokenItems(raw, PROMPT_MODEL_SCOPES, partial);
    if (items.length === 0) return null;
    if (
      suppressExactArgumentMatch(
        items.map((item) => item.label),
        partial,
      )
    ) {
      return null;
    }
    return items;
  }

  if (sub !== "set") return null;

  const modelRefItems = (typed: string): ArgumentCompletion[] | null => {
    const refs = options.modelRefs ?? [];
    const lower = typed.toLowerCase();
    const items = refs
      .filter((ref) => ref.toLowerCase().includes(lower))
      .map((ref) => ({
        value: joinArgumentValue(raw, ref),
        label: ref,
        description: "provider/model",
      }));
    if (items.length === 0) return null;
    if (
      suppressExactArgumentMatch(
        items.map((item) => item.label),
        typed,
      )
    ) {
      return null;
    }
    return items;
  };

  const finish = (items: ArgumentCompletion[]): ArgumentCompletion[] | null => {
    if (items.length === 0) return null;
    if (
      suppressExactArgumentMatch(
        items.map((item) => item.label),
        partial,
      )
    ) {
      return null;
    }
    return items;
  };

  // `set` with no model ref typed yet → offer registry model labels if known.
  if (tokens.length === 1) return modelRefItems(partial);
  // Still typing the model ref itself (no trailing space after it).
  if (tokens.length === 2 && !endsWithWs) {
    return modelRefItems(tokens[1] ?? "");
  }

  // `set <model> ` — the next token is a thinking level or a scope.
  if (tokens.length === 2) {
    return finish(
      tokenItems(raw, [...THINKING_TOKENS, ...PROMPT_MODEL_SCOPES], ""),
    );
  }

  const hasScope = tokens
    .slice(2)
    .some((token) => token === "global" || token === "project");
  if (hasScope) return null;

  // Third token: either a partial thinking level or a partial scope. With a
  // trailing space after a valid thinking level, only the scope remains.
  if (tokens.length === 3) {
    if (endsWithWs && isThinkingToken(tokens[2] ?? "")) {
      return finish(tokenItems(raw, PROMPT_MODEL_SCOPES, ""));
    }
    return finish(
      tokenItems(
        raw,
        [...THINKING_TOKENS, ...PROMPT_MODEL_SCOPES],
        partial,
      ),
    );
  }

  // Fourth token (after a thinking level): only the scope remains.
  if (tokens.length === 4 && isThinkingToken(tokens[2] ?? "")) {
    return finish(tokenItems(raw, PROMPT_MODEL_SCOPES, partial));
  }

  return null;
}

function isThinkingToken(token: string): boolean {
  return (VALID_THINKING_LEVELS as readonly string[]).includes(
    token.toLowerCase(),
  );
}
