/**
 * Workflow Extension — context and capability budget (step 17).
 *
 * The parent composer and a Build child have different models and different
 * jobs, so each gets its own resolved budget. This module is pure: the caller
 * supplies the real model limits (provider catalogue + user caps) and runtime
 * compaction settings. Missing metadata degrades to a conservative fallback
 * with low confidence — never to a guess that a model is "capable enough".
 *
 * Policy defaults follow the plan's initial shape: keep the projected working
 * set within ~50% of usable input, checkpoint near 65%, stop near 75%, with
 * explicit output and repair reserves. A dispatch gate refuses before work
 * starts when the bootstrap alone cannot fit.
 *
 * Context window is capacity, never competence: nothing here ranks models or
 * claims implementation ability from token count.
 */

export const BUDGET_SCHEMA_VERSION = 1 as const;

export type BudgetRole = "orchestrator" | "builder";
export type BudgetConfidence = "high" | "medium" | "low";
export type BudgetSource = "provider" | "user-cap" | "fallback";

/** What the model registry actually reports for this model. */
export interface ModelLimits {
  provider?: string;
  id: string;
  contextWindow: number | null;
  maxOutputTokens: number | null;
}

/** Runtime compaction settings (autocompact/session), when available. */
export interface CompactionSettings {
  enabled?: boolean;
  /** Percent of the usable window at which a checkpoint is requested. */
  thresholdPercent?: number | null;
}

/** Explicit user caps; always narrower than or equal to provider limits. */
export interface UserCaps {
  inputTokens?: number;
  outputTokens?: number;
}

/**
 * Ratios are fractions of the usable input window. A caller may tighten them;
 * `coerceBudgetPolicy` clamps them to a safe order (target < checkpoint < stop).
 */
export interface BudgetPolicy {
  targetRatio: number;
  checkpointRatio: number;
  stopRatio: number;
  outputReserveRatio: number;
  repairReserveRatio: number;
  bootstrapRatio: number;
}

export const DEFAULT_BUDGET_POLICY: Readonly<BudgetPolicy> = {
  targetRatio: 0.5,
  checkpointRatio: 0.65,
  stopRatio: 0.75,
  outputReserveRatio: 0.2,
  repairReserveRatio: 0.15,
  bootstrapRatio: 0.1,
};

/** Conservative fallback when the catalogue has no context metadata. */
export const FALLBACK_CONTEXT_WINDOW = 8_192;
export const FALLBACK_OUTPUT_TOKENS = 1_024;

export interface BudgetPlan {
  schemaVersion: typeof BUDGET_SCHEMA_VERSION;
  role: BudgetRole;
  /**
   * Provider is part of the launch identity, not a capacity input. It is kept
   * optional here so "unknown" is never confused with an explicit empty value;
   * launch validation decides whether a provider is required.
   */
  model: { provider?: string; id: string };
  /** Capacity used for this plan (after provider/user caps). */
  contextWindow: number;
  usableInput: number;
  targetWorkingSet: number;
  checkpointAt: number;
  stopAt: number;
  outputReserve: number;
  repairReserve: number;
  /** Maximum inline bootstrap/assignment packet. */
  bootstrapBudget: number;
  /** Remaining budget for reads, roadmap excerpts and tool output. */
  packetBudget: number;
  confidence: BudgetConfidence;
  source: BudgetSource;
  warnings: string[];
}

export type BudgetResult =
  | { ok: true; plan: BudgetPlan }
  | { ok: false; error: string };

function clampRatio(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Tighten or relax ratios within safe bounds; target < checkpoint < stop. */
export function coerceBudgetPolicy(raw: unknown): BudgetPolicy {
  const base = { ...DEFAULT_BUDGET_POLICY };
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const record = raw as Record<string, unknown>;
    for (const key of Object.keys(base) as Array<keyof BudgetPolicy>) {
      const value = record[key];
      if (typeof value === "number" && Number.isFinite(value)) {
        base[key] = clampRatio(value, 0.05, 0.9);
      }
    }
  }
  // Ordering is an invariant, not a suggestion.
  base.targetRatio = Math.min(base.targetRatio, base.checkpointRatio, base.stopRatio);
  base.checkpointRatio = Math.min(base.checkpointRatio, base.stopRatio);
  base.checkpointRatio = Math.max(base.checkpointRatio, base.targetRatio);
  base.stopRatio = Math.max(base.stopRatio, base.checkpointRatio);
  base.bootstrapRatio = Math.min(base.bootstrapRatio, base.targetRatio);
  base.outputReserveRatio = clampRatio(base.outputReserveRatio, 0.05, 0.5);
  base.repairReserveRatio = clampRatio(base.repairReserveRatio, 0.05, 0.5);
  return base;
}

function boundedTokens(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  return Math.floor(value);
}

/**
 * Resolve one model's safe budget. The caller must pass real metadata when it
 * has it; a missing/absurd window is treated as unknown, not as "large".
 */
export function resolveBudget(input: {
  role: BudgetRole;
  model: ModelLimits;
  compaction?: CompactionSettings;
  userCaps?: UserCaps;
  policy?: Partial<BudgetPolicy>;
}): BudgetResult {
  const policy = coerceBudgetPolicy(input.policy);
  const warnings: string[] = [];
  let confidence: BudgetConfidence = "high";
  let source: BudgetSource = "provider";

  let window = boundedTokens(input.model.contextWindow);
  if (window === undefined) {
    window = FALLBACK_CONTEXT_WINDOW;
    confidence = "low";
    source = "fallback";
    warnings.push("model context window is unknown; using a conservative fallback");
  }
  const outputLimit =
    boundedTokens(input.model.maxOutputTokens) ??
    Math.min(FALLBACK_OUTPUT_TOKENS, Math.floor(window * policy.outputReserveRatio));

  const capInput = boundedTokens(input.userCaps?.inputTokens);
  if (capInput !== undefined && capInput < window) {
    window = capInput;
    source = "user-cap";
    warnings.push(`user input cap ${capInput} is below the provider window`);
  }
  const capOutput = boundedTokens(input.userCaps?.outputTokens);

  const usableInputCandidate = window;
  const outputReserve = Math.max(
    1,
    Math.min(outputLimit, Math.floor(usableInputCandidate * policy.outputReserveRatio)),
  );
  const repairReserve = Math.max(
    1,
    Math.floor(usableInputCandidate * policy.repairReserveRatio),
  );
  const minInput = 64;
  if (usableInputCandidate <= outputReserve + repairReserve + minInput) {
    return {
      ok: false,
      error: "the context window cannot hold a useful input after reserves",
    };
  }
  const usableInput = usableInputCandidate - outputReserve - repairReserve;

  let checkpointAt = Math.floor(usableInput * policy.checkpointRatio);
  const threshold = boundedTokens(input.compaction?.thresholdPercent);
  if (input.compaction?.enabled !== false && threshold !== undefined) {
    const percent = Math.min(95, Math.max(10, threshold));
    const fromCompaction = Math.floor((usableInputCandidate * percent) / 100);
    if (fromCompaction < checkpointAt) {
      checkpointAt = fromCompaction;
      warnings.push(`runtime compaction requests a checkpoint at ${percent}%`);
    }
  }
  const stopAt = Math.max(
    checkpointAt,
    Math.floor(usableInput * policy.stopRatio),
  );
  const targetWorkingSet = Math.max(1, Math.floor(usableInput * policy.targetRatio));
  const bootstrapBudget = Math.max(
    1,
    Math.min(targetWorkingSet, Math.floor(usableInput * policy.bootstrapRatio)),
  );

  const provider =
    typeof input.model.provider === "string" ? input.model.provider.trim() : "";

  return {
    ok: true,
    plan: {
      schemaVersion: BUDGET_SCHEMA_VERSION,
      role: input.role,
      model: {
        ...(provider.length > 0 ? { provider } : {}),
        id: input.model.id,
      },
      contextWindow: usableInputCandidate,
      usableInput,
      targetWorkingSet,
      checkpointAt,
      stopAt,
      outputReserve:
        capOutput === undefined
          ? outputReserve
          : Math.max(1, Math.min(outputReserve, capOutput)),
      repairReserve,
      bootstrapBudget,
      packetBudget: Math.max(0, targetWorkingSet - bootstrapBudget),
      confidence,
      source,
      warnings,
    },
  };
}

export interface BudgetPair {
  orchestrator: BudgetPlan;
  builder: BudgetPlan;
}

/** The parent and the child have different windows; resolve both up front. */
export function resolveBudgetPair(input: {
  orchestrator: Omit<Parameters<typeof resolveBudget>[0], "role">;
  builder: Omit<Parameters<typeof resolveBudget>[0], "role">;
}): { ok: true; pair: BudgetPair } | { ok: false; error: string } {
  const orchestrator = resolveBudget({ ...input.orchestrator, role: "orchestrator" });
  if (!orchestrator.ok) return { ok: false, error: `orchestrator: ${orchestrator.error}` };
  const builder = resolveBudget({ ...input.builder, role: "builder" });
  if (!builder.ok) return { ok: false, error: `builder: ${builder.error}` };
  return { ok: true, pair: { orchestrator: orchestrator.plan, builder: builder.plan } };
}

export interface DispatchRequirement {
  /** Bootstrap/assignment packet the child must receive before it starts. */
  bootstrapTokens: number;
  /** System prompt, tool schemas and project instructions, when known. */
  systemTokens?: number;
  /** The expected output the task must be able to produce. */
  outputTokens?: number;
}

export type DispatchDecision =
  | { ok: true }
  | { ok: false; reason: string; code: "bootstrap" | "capacity" | "invalid" };

/**
 * The pre-dispatch gate. A bootstrap that alone exceeds its budget stops the
 * run before a child session is created; the caller reports `reason`.
 */
export function canDispatch(
  plan: BudgetPlan,
  requirement: DispatchRequirement,
): DispatchDecision {
  const bootstrap = requirement.bootstrapTokens;
  const system = requirement.systemTokens ?? 0;
  const output = requirement.outputTokens ?? 0;
  if (
    !Number.isFinite(bootstrap) ||
    !Number.isFinite(system) ||
    !Number.isFinite(output) ||
    bootstrap < 0 ||
    system < 0 ||
    output < 0
  ) {
    return { ok: false, code: "invalid", reason: "dispatch requirement is not a token count" };
  }
  if (bootstrap > plan.bootstrapBudget) {
    return {
      ok: false,
      code: "bootstrap",
      reason: `the bootstrap needs ${bootstrap} tokens but only ${plan.bootstrapBudget} fit`,
    };
  }
  const needed = bootstrap + system + output + plan.repairReserve;
  if (needed > plan.usableInput) {
    return {
      ok: false,
      code: "capacity",
      reason: `the request needs ${needed} tokens but ${plan.usableInput} are usable`,
    };
  }
  if (needed > plan.targetWorkingSet) {
    return {
      ok: false,
      code: "capacity",
      reason: `the request exceeds the ${plan.targetWorkingSet}-token working-set target`,
    };
  }
  return { ok: true };
}

/** Conservative text-size estimate: ~4 characters/token, never zero. */
export function estimateTextTokens(text: string): { tokens: number; confidence: BudgetConfidence } {
  const length = typeof text === "string" ? text.length : 0;
  return { tokens: Math.max(1, Math.ceil(length / 4)), confidence: "medium" };
}
