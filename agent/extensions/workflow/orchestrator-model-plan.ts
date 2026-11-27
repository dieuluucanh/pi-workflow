/**
 * Workflow Extension — one model resolver for the Orchestrator parent and its
 * Build child.
 *
 * The reported bootstrap failure came from three separate mistakes:
 *
 *   1. the child launch omitted `provider`, so `resolveBudget()` wrote `""`;
 *   2. `provider ?? fallback` could never recover from `""`;
 *   3. the parent session model was used as if it were the Builder model.
 *
 * This module makes the model identity explicit: the effective Builder role
 * (profile overlay already applied by the caller) wins, the current session
 * model is a fallback, and a launch model is returned only with a non-empty
 * provider and id. The budget is returned from the SAME resolution, so the
 * approval preview and the launched child cannot describe different models.
 */

export interface ModelLimits {
  provider?: string;
  id: string;
  contextWindow: number | null;
  maxOutputTokens: number | null;
}

export interface ModelPlanRef {
  provider?: string;
  id: string;
  thinking?: string;
}

export interface ModelLimitsLookup {
  contextWindow?: number | null;
  maxOutputTokens?: number | null;
}

export interface ResolveModelPlanInput {
  role: "builder" | "orchestrator";
  /** Human-facing role name used in a fail-closed error. */
  roleName: string;
  /** Effective role model (base role + active profile overlay). */
  roleModel?: ModelPlanRef | null;
  /** The live session model, used only when the role is absent/incomplete. */
  fallbackModel?: ModelLimits | null;
  /** Provider catalogue lookup for a role model that is not the live model. */
  lookupLimits?: (ref: {
    provider: string;
    id: string;
  }) => ModelLimitsLookup | undefined;
}

export type ModelPlanResult =
  | {
      ok: true;
      launch: { provider: string; id: string; thinking?: string };
    }
  | { ok: false; code: "no_model"; error: string };

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function sameModel(
  left: { provider: string; id: string },
  right: { provider?: string; id: string },
): boolean {
  return left.provider === clean(right.provider) && left.id === right.id;
}

/**
 * Resolve the launch model and its budget together.
 *
 * A role model is used only when BOTH provider and id are non-empty. A missing
 * or empty role provider therefore falls back to the session model instead of
 * being passed through as `""`.
 */
export function resolveModelPlan(
  input: ResolveModelPlanInput,
): ModelPlanResult {
  const roleProvider = clean(input.roleModel?.provider);
  const roleId = clean(input.roleModel?.id);
  const fallbackProvider = clean(input.fallbackModel?.provider);
  const fallbackId = clean(input.fallbackModel?.id);

  const chosen =
    roleProvider.length > 0 && roleId.length > 0
      ? {
          provider: roleProvider,
          id: roleId,
          source: "role" as const,
          thinking: input.roleModel?.thinking,
        }
      : fallbackProvider.length > 0 && fallbackId.length > 0
        ? {
            provider: fallbackProvider,
            id: fallbackId,
            source: "session" as const,
          }
        : undefined;

  if (!chosen) {
    return {
      ok: false,
      code: "no_model",
      error: `${input.roleName} model is required: neither the effective role nor the current session has a provider and id`,
    };
  }

  let limits: ModelLimitsLookup | undefined;
  if (chosen.source === "role" && input.lookupLimits) {
    limits = input.lookupLimits({
      provider: chosen.provider,
      id: chosen.id,
    });
  }
  const fallbackLimits = input.fallbackModel ?? undefined;
  const fallbackHasLimits =
    fallbackLimits !== undefined && sameModel(chosen, fallbackLimits);
  if (
    fallbackHasLimits &&
    (limits === undefined ||
      (typeof limits.contextWindow !== "number" &&
        typeof limits.maxOutputTokens !== "number"))
  ) {
    limits = fallbackLimits;
  }

  const model: ModelLimits = {
    provider: chosen.provider,
    id: chosen.id,
    contextWindow:
      typeof limits?.contextWindow === "number" ? limits.contextWindow : null,
    maxOutputTokens:
      typeof limits?.maxOutputTokens === "number"
        ? limits.maxOutputTokens
        : null,
  };
  return {
    ok: true,
    launch: {
      provider: chosen.provider,
      id: chosen.id,
      ...(chosen.source === "role" && chosen.thinking
        ? { thinking: chosen.thinking }
        : {}),
    },
  };
}
