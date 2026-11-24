/**
 * Workflow Extension — Authoritative Default-mode model accessor
 *
 * `model-default.ts` owns the *persisted* default (settings.json) and the
 * session-start apply rule. This module is the narrower, exposure-side view of
 * the same bookkeeping: a single accessor that answers "which model is the
 * authoritative Default-mode model for this session?" plus the refinement
 * resolver that consumes it.
 *
 * Why a separate seam:
 *   - Prompt refinement must inherit the Default-mode model, never a Planner /
 *     Builder / Reviewer / Explorer / Orchestrator role model.
 *   - When the snapshot is unknown, refinement must REFUSE rather than borrow
 *     the currently active role model.
 *   - Project-level defaults are only trusted when the project is trusted.
 *   - Automatic role switches must not overwrite the Default baseline, and Pi's
 *     internal `restore` events must not be mistaken for user selections.
 *
 * The module is pure (no I/O, no Pi runtime): everything is injectable, so the
 * precedence and refusal rules are unit-testable without a session. It never
 * mutates its inputs and never writes settings/roles/profiles — the regression
 * test "refinement never touches the main model/settings" pins that.
 */

import {
  coerceModelDefault,
  sameModelRef,
  shouldPersistModelSelect,
  type PersistedModelDefault,
} from "./model-default.ts";

/** A model reference, matching the persisted-default shape. */
export type DefaultModeModelRef = PersistedModelDefault;

/** Which input supplied the authoritative Default-mode model. */
export type DefaultModeModelSource =
  | "entry"
  | "persisted"
  | "profile"
  | "project"
  | "none";

/**
 * How much the value can be trusted:
 *   - `session`: the session's own recorded default (entry) or an explicit
 *     persisted record;
 *   - `configured`: a trusted project-level default;
 *   - `seed`: a profile's `defaultModel` seed (legacy fallback);
 *   - `none`: no default is known.
 */
export type DefaultModeModelTrust = "session" | "configured" | "seed" | "none";

export interface DefaultModeModelSnapshot {
  /** The effective Default-mode model, or undefined when unknown. */
  model: DefaultModeModelRef | undefined;
  /** Which input supplied it. */
  source: DefaultModeModelSource;
  /** Trust class of the value (see DefaultModeModelTrust). */
  trust: DefaultModeModelTrust;
  /**
   * True only when the value is an authoritative Default-mode model. A role
   * model offered as a substitute is never authoritative.
   */
  authoritative: boolean;
  /**
   * True when a role model was offered but deliberately NOT used because no
   * Default-mode record existed. Refinement reports this distinctly.
   */
  refusedRoleModel: boolean;
}

export interface DefaultModeModelAccessorInput {
  /** A resumed session's own recorded Default-mode model. */
  entryModel?: DefaultModeModelRef;
  /** `workflow.modelDefault` (the authoritative persisted record). */
  persistedModel?: DefaultModeModelRef;
  /** Profile `defaultModel` seed (legacy fallback only). */
  profileModel?: DefaultModeModelRef;
  /** Pi's project-level default (`<cwd>/.pi/settings.json`). */
  projectModel?: DefaultModeModelRef;
  /** Whether the project may contribute settings (Pi trust). */
  projectTrusted?: boolean;
  /** The active role's model — never a substitute for a missing default. */
  activeRoleModel?: DefaultModeModelRef;
}

const NONE: Omit<DefaultModeModelSnapshot, "refusedRoleModel"> = {
  model: undefined,
  source: "none",
  trust: "none",
  authoritative: false,
};

/**
 * Resolve the authoritative Default-mode model.
 *
 * Precedence:
 *   1. the session entry (a resumed session's own recorded default);
 *   2. a TRUSTED project default (explicit configuration for this project);
 *   3. `workflow.modelDefault` (global or project record);
 *   4. the profile seed (legacy fallback).
 *
 * The active role model is never a candidate. When nothing above resolves, the
 * result is `source: "none"` with `refusedRoleModel` set if a role model was
 * offered — callers must refuse rather than fall back to that role model.
 */
export function resolveDefaultModeModelAccessor(
  input: DefaultModeModelAccessorInput,
): DefaultModeModelSnapshot {
  const entry = coerceModelDefault(input.entryModel);
  const project = input.projectTrusted
    ? coerceModelDefault(input.projectModel)
    : undefined;
  const persisted = coerceModelDefault(input.persistedModel);
  const profile = coerceModelDefault(input.profileModel);
  const role = coerceModelDefault(input.activeRoleModel);

  const pick = (
    model: DefaultModeModelRef,
    source: DefaultModeModelSource,
    trust: DefaultModeModelTrust,
  ): DefaultModeModelSnapshot => ({
    model,
    source,
    trust,
    authoritative: true,
    refusedRoleModel: false,
  });

  if (entry) return pick(entry, "entry", "session");
  if (project) return pick(project, "project", "configured");
  if (persisted) return pick(persisted, "persisted", "session");
  if (profile) return pick(profile, "profile", "seed");
  return { ...NONE, refusedRoleModel: role !== undefined };
}

// ── Refinement resolver ─────────────────────────────────────────────

export type RefinementModelSource =
  | "override"
  | "project-override"
  | "default-mode"
  | "none";

export type RefinementModelRefusal =
  | "unknown-default-mode-model"
  | "active-role-model-not-a-default"
  | "invalid-refinement-setting";

export interface RefinementModelResolution {
  ok: boolean;
  model?: DefaultModeModelRef;
  source: RefinementModelSource;
  /** Set only when `ok` is false. */
  reason?: RefinementModelRefusal;
}

export interface RefinementModelInput {
  /** Explicit global refinement override (`workflow.promptRefinement.model`). */
  configuredOverride?: DefaultModeModelRef | null;
  /** Explicit project refinement override (only trusted projects). */
  projectOverride?: DefaultModeModelRef | null;
  /**
   * Explicit project inherit sentinel. A trusted project inherit suppresses a
   * global override and follows the Default-mode model instead.
   */
  projectInherit?: boolean;
  /** Whether the project may contribute the project override. */
  projectTrusted?: boolean;
  /** The authoritative Default-mode snapshot. */
  defaultMode: DefaultModeModelSnapshot;
  /** The active role's model, used only to explain a refusal. */
  activeRoleModel?: DefaultModeModelRef;
}

/**
 * Resolve the model prompt refinement should use.
 *
 *   trusted project override
 *     -> trusted project inherit (suppresses global; Default mode)
 *       -> global override
 *         -> authoritative Default-mode model
 *
 * If none is available, the resolver REFUSES. It never returns the active role
 * model: that is the accidental Planner/Builder/Reviewer fallback this module
 * exists to prevent. The result model is a copy, so callers cannot mutate the
 * bookkeeping through it.
 */
export function resolveRefinementModel(
  input: RefinementModelInput,
): RefinementModelResolution {
  const projectTrusted = input.projectTrusted === true;
  const projectInherit = projectTrusted && input.projectInherit === true;

  if (!projectInherit) {
    const projectOverride = projectTrusted
      ? coerceModelDefault(input.projectOverride ?? undefined)
      : undefined;
    if (projectOverride) {
      return {
        ok: true,
        model: { ...projectOverride },
        source: "project-override",
      };
    }

    const override = coerceModelDefault(input.configuredOverride ?? undefined);
    if (override) return { ok: true, model: { ...override }, source: "override" };
  }

  const snapshot = input.defaultMode;
  if (snapshot.authoritative && snapshot.model) {
    return { ok: true, model: { ...snapshot.model }, source: "default-mode" };
  }

  return {
    ok: false,
    source: "none",
    reason:
      snapshot.refusedRoleModel ||
      coerceModelDefault(input.activeRoleModel) !== undefined
        ? "active-role-model-not-a-default"
        : "unknown-default-mode-model",
  };
}

/** Short, user-facing description for `/prompt-model status` and diagnostics. */
export function describeRefinementModel(
  resolution: RefinementModelResolution,
): string {
  if (resolution.ok && resolution.model) {
    const label = `${resolution.model.provider}/${resolution.model.id}`;
    switch (resolution.source) {
      case "override":
        return `${label} (configured refinement override)`;
      case "project-override":
        return `${label} (trusted project refinement override)`;
      case "default-mode":
        return `${label} (inherited from the Default-mode model)`;
      case "none":
        return label;
    }
  }
  return resolution.reason === "active-role-model-not-a-default"
    ? "no Default-mode model is known — refusing to borrow the active role model"
    : resolution.reason === "invalid-refinement-setting"
      ? "the configured refinement setting is invalid — fix it or run /prompt-model reset"
      : "no Default-mode model is known — refusing to pick an unrelated model";
}

// ── Default baseline capture ────────────────────────────────────────

export type DefaultBaselineAction = "captured" | "kept" | "refused";

export type DefaultBaselineReason =
  | "not-default-mode"
  | "unknown-live-model"
  | "live-is-active-role-model"
  | undefined;

export interface DefaultBaselineInput {
  /** Workflow mode before the switch: `null`/`"default"` means Default mode. */
  mode: string | null | undefined;
  /** The live model that would become the baseline. */
  live?: DefaultModeModelRef;
  /** The previously remembered baseline (kept when capture is unsafe). */
  previous?: DefaultModeModelRef;
  /** The active role model, so a role model is never captured as the default. */
  activeRoleModel?: DefaultModeModelRef;
}

export interface DefaultBaselineResult {
  baseline: DefaultModeModelRef | undefined;
  action: DefaultBaselineAction;
  reason?: DefaultBaselineReason;
}

/**
 * Capture the Default-mode baseline before an automatic role switch.
 *
 * Rules (each unit-tested):
 *   - Only Default mode may capture. Leaving Plan/Build/Orchestrator never
 *     replaces the baseline with the live role model.
 *   - No live model keeps the previous baseline (unknown is not a guess).
 *   - A live model that IS the active role model is refused: a role model must
 *     not become the Default baseline just because the snapshot was unknown.
 */
export function captureDefaultBaseline(
  input: DefaultBaselineInput,
): DefaultBaselineResult {
  const previous = coerceModelDefault(input.previous);
  const mode = input.mode ?? null;
  if (mode !== null && mode !== "default") {
    return { baseline: previous, action: "kept", reason: "not-default-mode" };
  }
  const live = coerceModelDefault(input.live);
  if (!live) {
    return { baseline: previous, action: "kept", reason: "unknown-live-model" };
  }
  const role = coerceModelDefault(input.activeRoleModel);
  if (role && sameModelRef(live, role)) {
    return {
      baseline: previous,
      action: "refused",
      reason: "live-is-active-role-model",
    };
  }
  return { baseline: live, action: "captured" };
}

// ── Model-selection event classification ────────────────────────────

export type ModelSelectionKind =
  | "user"
  | "internal-switch"
  | "internal-restore"
  | "ignored";

export interface ModelSelectionClassification {
  kind: ModelSelectionKind;
  /** Same verdict as `shouldPersistModelSelect` (explicit-choice parity). */
  persist: boolean;
  /**
   * Pi re-applied a recorded model (`source: "restore"`) while not suppressed.
   * It is audit-worthy precisely because it must NOT persist: it can otherwise
   * be mistaken for a user gesture on resume/reload.
   */
  auditRestore: boolean;
}

/**
 * Classify a `model_select` event.
 *
 * `persist` delegates to `shouldPersistModelSelect`, so the explicit-choice
 * semantics are identical by construction; the classification only adds the
 * audit/diagnostic distinction. Extension-initiated switches (suppressed) are
 * `internal-switch`, so even a `restore` source cannot be audited as a Pi
 * restore while we are the one switching.
 */
export function classifyModelSelectionEvent(input: {
  source: string | undefined;
  suppressed: boolean;
}): ModelSelectionClassification {
  const persist = shouldPersistModelSelect(input);
  if (input.suppressed) {
    return { kind: "internal-switch", persist, auditRestore: false };
  }
  if (input.source === "restore") {
    return { kind: "internal-restore", persist, auditRestore: true };
  }
  if (persist) return { kind: "user", persist, auditRestore: false };
  return { kind: "ignored", persist, auditRestore: false };
}
