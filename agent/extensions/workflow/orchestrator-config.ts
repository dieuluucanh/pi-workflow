/**
 * Workflow Extension — `workflow.orchestrator` execution limits.
 *
 * The Orchestrator has three bounded waits. They are user-owned settings, not
 * literals in the execution path, and they live beside the other workflow
 * policy blocks instead of inventing a new settings location:
 *
 *   { "workflow": { "orchestrator": {
 *       "childTimeoutMs": 2700000,
 *       "verificationTimeoutSeconds": 900,
 *       "gitTimeoutMs": 60000
 *   } } }
 *
 * Precedence is the same as `workflow.handoff`/`workflow.reviewMode`: defaults
 * < global < project, merged field by field. Every value is clamped to the
 * shell guard's hard cap; a non-numeric or non-positive value is ignored WITH a
 * diagnostic instead of being silently treated as the default. This module is
 * the only reader of the settings key (`readOrchestratorLimits`), so the
 * execution path never parses settings itself.
 *
 * Free of Pi/TUI imports (the defaults it re-exports are plain constants) so
 * coercion, merge, provenance, diagnostics and the disk round-trip can be
 * unit-tested against temporary directories.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { reviewConfigPaths, WORKFLOW_SETTINGS_KEY } from "./review.ts";
import { DEFAULT_CHILD_TIMEOUT_MS } from "./orchestrator-child-controller.ts";
import { DEFAULT_GIT_TIMEOUT_MS } from "./check-executor.ts";
import {
  DEFAULT_SHELL_MAX_TIMEOUT_SECONDS,
  HARD_MAX_SHELL_TIMEOUT_SECONDS,
  clampShellSeconds,
} from "./shell-guard.ts";

/** Nested key under `workflow` in settings.json. */
export const ORCHESTRATOR_SETTINGS_KEY = "orchestrator";

/** A JSON object parsed from an untrusted source. */
export type JsonObject = Record<string, unknown>;

export interface OrchestratorLimits {
  /** Wall-clock bound on one Build child turn. */
  childTimeoutMs: number;
  /** Deadline for one row/plan check; also bounded by the shell guard. */
  verificationTimeoutSeconds: number;
  /** Bound on one `git` invocation in the baseline/diff path. */
  gitTimeoutMs: number;
}

export const ORCHESTRATOR_LIMIT_KEYS = [
  "childTimeoutMs",
  "verificationTimeoutSeconds",
  "gitTimeoutMs",
] as const;
export type OrchestratorLimitKey = (typeof ORCHESTRATOR_LIMIT_KEYS)[number];

export const DEFAULT_ORCHESTRATOR_LIMITS: Readonly<OrchestratorLimits> = {
  childTimeoutMs: DEFAULT_CHILD_TIMEOUT_MS,
  verificationTimeoutSeconds: DEFAULT_SHELL_MAX_TIMEOUT_SECONDS,
  gitTimeoutMs: DEFAULT_GIT_TIMEOUT_MS,
};

interface LimitBound {
  /** Inclusive ceiling; the shell guard's hard cap expressed in this unit. */
  max: number;
  unit: "milliseconds" | "seconds";
}

const LIMIT_BOUNDS: Readonly<Record<OrchestratorLimitKey, LimitBound>> = {
  childTimeoutMs: {
    max: HARD_MAX_SHELL_TIMEOUT_SECONDS * 1_000,
    unit: "milliseconds",
  },
  verificationTimeoutSeconds: {
    max: HARD_MAX_SHELL_TIMEOUT_SECONDS,
    unit: "seconds",
  },
  gitTimeoutMs: {
    max: HARD_MAX_SHELL_TIMEOUT_SECONDS * 1_000,
    unit: "milliseconds",
  },
};

/** Which settings scope supplied a field's effective value. */
export type OrchestratorLimitScopeSource = "default" | "global" | "project";

/** One ignored setting, so the caller can tell the user what was wrong. */
export interface OrchestratorLimitDiagnostic {
  scope: "global" | "project";
  key: OrchestratorLimitKey;
  value: unknown;
  message: string;
}

export interface ResolvedOrchestratorLimits {
  config: OrchestratorLimits;
  sources: {
    global: boolean;
    project: boolean;
    childTimeout: OrchestratorLimitScopeSource;
    verificationTimeout: OrchestratorLimitScopeSource;
    gitTimeout: OrchestratorLimitScopeSource;
  };
  diagnostics: OrchestratorLimitDiagnostic[];
}

interface LimitRead {
  value: number;
  invalid?: { value: unknown; reason: string };
}

function isJsonObject(value: unknown): value is JsonObject {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * Read one limit. Missing keeps the base; a finite positive number is floored
 * and clamped to the hard cap; everything else keeps the base AND reports why.
 */
function readLimit(
  raw: unknown,
  key: OrchestratorLimitKey,
  base: number,
): LimitRead {
  if (raw === undefined) return { value: base };
  const bound = LIMIT_BOUNDS[key];
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return {
      value: base,
      invalid: {
        value: raw,
        reason: `must be a positive whole number of ${bound.unit}`,
      },
    };
  }
  const whole = Math.floor(raw);
  if (whole < 1) {
    return {
      value: base,
      invalid: {
        value: raw,
        reason: `must be greater than 0 ${bound.unit}`,
      },
    };
  }
  return { value: Math.min(whole, bound.max) };
}

/**
 * Coerce an untrusted `workflow.orchestrator` fragment onto a base config.
 * Missing/invalid fields keep `base`; high values are clamped, never widened
 * past the shell guard's hard cap. Never throws.
 */
export function coerceOrchestratorLimits(
  raw: unknown,
  base: OrchestratorLimits = DEFAULT_ORCHESTRATOR_LIMITS as OrchestratorLimits,
): OrchestratorLimits {
  if (!isJsonObject(raw)) return { ...base };
  const out: OrchestratorLimits = { ...base };
  for (const key of ORCHESTRATOR_LIMIT_KEYS) {
    out[key] = readLimit(raw[key], key, base[key]).value;
  }
  return out;
}

/** Diagnostic text for one invalid value, used by both read and tests. */
export function orchestratorLimitDiagnosticMessage(
  key: OrchestratorLimitKey,
  raw: unknown,
  reason: string,
): string {
  return `workflow.orchestrator.${key} ${reason}; ignoring ${JSON.stringify(raw)}`;
}

/**
 * Every ignored value in one raw fragment. A missing key or a valid number
 * yields no diagnostic; invalid values keep the fallback silently only in
 * `coerceOrchestratorLimits`, never without this report.
 */
export function orchestratorLimitDiagnostics(
  raw: unknown,
  scope: "global" | "project",
): OrchestratorLimitDiagnostic[] {
  if (!isJsonObject(raw)) return [];
  const out: OrchestratorLimitDiagnostic[] = [];
  for (const key of ORCHESTRATOR_LIMIT_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(raw, key)) continue;
    const read = readLimit(
      raw[key],
      key,
      DEFAULT_ORCHESTRATOR_LIMITS[key],
    );
    if (!read.invalid) continue;
    out.push({
      scope,
      key,
      value: read.invalid.value,
      message: orchestratorLimitDiagnosticMessage(
        key,
        read.invalid.value,
        read.invalid.reason,
      ),
    });
  }
  return out;
}

/** Extract the `workflow.orchestrator` fragment from a raw settings object. */
export function extractOrchestratorRaw(settings: unknown): JsonObject | undefined {
  if (!isJsonObject(settings)) return undefined;
  const wf = settings[WORKFLOW_SETTINGS_KEY];
  if (!isJsonObject(wf)) return undefined;
  const raw = wf[ORCHESTRATOR_SETTINGS_KEY];
  return isJsonObject(raw) ? raw : undefined;
}

/**
 * Merge global then project fragments; project wins field by field, global
 * wins over defaults. Same precedence as `workflow.handoff`.
 */
export function mergeOrchestratorLimits(
  globalRaw: unknown,
  projectRaw: unknown,
): OrchestratorLimits {
  const fromGlobal = coerceOrchestratorLimits(globalRaw);
  return coerceOrchestratorLimits(projectRaw, fromGlobal);
}

function hasField(raw: JsonObject | undefined, key: OrchestratorLimitKey): boolean {
  return !!raw && Object.prototype.hasOwnProperty.call(raw, key);
}

/** Field provenance: project > global > default. */
export function orchestratorFieldSourceOf(
  globalRaw: JsonObject | undefined,
  projectRaw: JsonObject | undefined,
  key: OrchestratorLimitKey,
): OrchestratorLimitScopeSource {
  if (hasField(projectRaw, key)) return "project";
  if (hasField(globalRaw, key)) return "global";
  return "default";
}

function readJsonSafe(fp: string): JsonObject | undefined {
  try {
    if (!fs.existsSync(fp)) return undefined;
    const parsed: unknown = JSON.parse(fs.readFileSync(fp, "utf8"));
    return isJsonObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Settings file locations, shared with Review Mode and the other blocks. */
export function orchestratorConfigPaths(
  cwd: string,
  agentDir: string,
): { global: string; project: string } {
  return reviewConfigPaths(cwd, agentDir);
}

/**
 * Resolve the effective limits from disk. Never throws — a corrupt or missing
 * file falls back to defaults. The result names every ignored value.
 */
export function readOrchestratorLimits(
  cwd: string,
  agentDir: string,
): ResolvedOrchestratorLimits {
  const paths = orchestratorConfigPaths(cwd, agentDir);
  const globalRaw = extractOrchestratorRaw(readJsonSafe(paths.global));
  const projectRaw = extractOrchestratorRaw(readJsonSafe(paths.project));
  return {
    config: mergeOrchestratorLimits(globalRaw, projectRaw),
    sources: {
      global: globalRaw !== undefined,
      project: projectRaw !== undefined,
      childTimeout: orchestratorFieldSourceOf(globalRaw, projectRaw, "childTimeoutMs"),
      verificationTimeout: orchestratorFieldSourceOf(
        globalRaw,
        projectRaw,
        "verificationTimeoutSeconds",
      ),
      gitTimeout: orchestratorFieldSourceOf(globalRaw, projectRaw, "gitTimeoutMs"),
    },
    diagnostics: [
      ...orchestratorLimitDiagnostics(globalRaw, "global"),
      ...orchestratorLimitDiagnostics(projectRaw, "project"),
    ],
  };
}

/**
 * The deadline a check may actually use: the orchestrator setting, the shell
 * guard's configured maximum and the hard cap all apply; the smallest wins.
 * A configured shell maximum can therefore tighten the orchestrator setting but
 * never be widened by it.
 */
export function effectiveVerificationTimeoutSeconds(
  config: OrchestratorLimits,
  shellGuardMaxTimeoutSeconds?: unknown,
): number {
  const shellMax = clampShellSeconds(
    shellGuardMaxTimeoutSeconds,
    DEFAULT_SHELL_MAX_TIMEOUT_SECONDS,
  );
  return Math.min(
    HARD_MAX_SHELL_TIMEOUT_SECONDS,
    shellMax,
    config.verificationTimeoutSeconds,
  );
}

/** One-line display, used by status output and diagnostics. */
export function describeOrchestratorLimits(config: OrchestratorLimits): string {
  return [
    `child ${Math.round(config.childTimeoutMs / 1_000)}s`,
    `checks ${config.verificationTimeoutSeconds}s`,
    `git ${Math.round(config.gitTimeoutMs / 1_000)}s`,
  ].join(" · ");
}
