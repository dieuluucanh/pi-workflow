/**
 * Provider seeding for Review Mode's reviewer session.
 *
 * Why this exists: `createReviewSession()` builds the reviewer as an isolated
 * child (`noExtensions: true`, its own `ModelRuntime`). That isolation is
 * deliberate — the reviewer must not inherit ambient extensions — but it has
 * one consequence: a provider that is registered ONLY by an extension in the
 * parent session (e.g. `pi.registerProvider("synthetic", …)`) does not exist in
 * the child's runtime, so the child's prompt preflight throws
 * `No API key found for <provider>.` even though `auth.json` holds a valid
 * credential for it.
 *
 * The fix is a *present-probe*, not layer names: the seeder asks the child
 * runtime what it already composes (`getRegisteredProviderIds()`), asks the
 * parent surface for the same list, and registers only the difference —
 * native provider objects first, plain provider configs otherwise. Providers
 * the child already composes by construction (Pi's provider catalog and
 * `~/.pi/agent/models.json` — every `ModelRuntime` loads both) never appear in
 * these id lists at all, so the probe is automatically a no-op for them and for
 * any future provider source Pi composes globally. No code here mentions or
 * branches on provider layers; grep this file for "built-in"/"extension" to
 * confirm the decision logic stays structural.
 *
 * Everything is feature-detected and per-provider fault-isolated:
 * - a missing method degrades to "nothing to seed / cannot verify" — never a
 *   crash (the dev-dependency pins a different Pi version than is installed);
 * - a broken unrelated provider registration is recorded in `errors` and must
 *   never block a review.
 */

/**
 * A provider registration as the parent holds it, copied opaquely to the
 * child. The seeder never interprets a field — the child runtime validates
 * and composes it exactly as it would a registration of its own.
 */
interface ProviderRegistration {
  /** Provider id (present on native provider objects). */
  readonly id?: string;
  readonly [field: string]: unknown;
}

/**
 * The parent-side provider-registration surface the seeder reads from.
 *
 * Structural, not nominal: any object exposing these three accessors
 * qualifies. Both real Pi surfaces — the session's `ModelRegistry` facade
 * (`ctx.modelRegistry`) and its underlying `ModelRuntime` (`ctx.modelRuntime`)
 * — expose exactly this shape; a future surface is picked up by adding one
 * entry to `PARENT_SURFACE_KEYS`.
 */
export interface ParentProviderSurface {
  getRegisteredProviderIds(): readonly string[];
  getRegisteredProviderConfig(providerId: string): ProviderRegistration | undefined;
  getRegisteredNativeProvider(providerId: string): ProviderRegistration | undefined;
}

/** One provider that could not be seeded, with the reason. */
export interface ProviderSeedError {
  name: string;
  error: string;
}

/** What one seeding pass did (or did not) do. */
export interface ProviderSeedResult {
  /** Ids that were newly registered on the child runtime. */
  seeded: string[];
  /** Parent ids the child already composes — untouched, proving the no-op. */
  skippedPresent: string[];
  /** Per-provider failures; the review is never blocked by these. */
  errors: ProviderSeedError[];
}

export interface ProviderGapScan {
  /** Parent ids the child does not compose yet. */
  missing: string[];
  /** Parent ids the child already composes. */
  present: string[];
}

/** Junk-tolerant `getRegisteredProviderIds()` reader. Empty when unavailable. */
function registeredIdsOn(surface: unknown): string[] {
  try {
    const get = (surface as { getRegisteredProviderIds?: unknown } | undefined)
      ?.getRegisteredProviderIds;
    if (typeof get !== "function") return [];
    const ids = (get as (this: unknown) => unknown).call(surface);
    if (!Array.isArray(ids)) return [];
    const seen = new Set<string>();
    for (const id of ids) {
      if (typeof id === "string" && id.trim()) seen.add(id.trim());
    }
    return [...seen];
  } catch {
    return [];
  }
}

/**
 * Structural probe: does this object expose the full provider-registration
 * surface (id list + both getters)? Both real Pi surfaces — the parent
 * runtime and its `ModelRegistry` facade — expose all three; anything less
 * cannot seed anything, so it is treated as "no surface".
 */
function isProviderSurface(value: unknown): value is ParentProviderSurface {
  if (typeof value !== "object" || value === null) return false;
  const s = value as Partial<ParentProviderSurface>;
  return (
    typeof s.getRegisteredProviderIds === "function" &&
    typeof s.getRegisteredProviderConfig === "function" &&
    typeof s.getRegisteredNativeProvider === "function"
  );
}

/**
 * Public alias for the structural probe, so callers can distinguish a parent
 * with no surface (worth reporting) from a surface that had nothing to give
 * (a normal no-op).
 */
export function isParentProviderSurface(value: unknown): boolean {
  return isProviderSurface(value);
}

/**
 * Find a provider-registration surface on the parent context, trying the
 * documented public surfaces in order. Returns `undefined` when none exists —
 * callers must treat that as "nothing to seed", never as an error.
 *
 * The list is the extension point for future Pi versions: add one entry and
 * the new surface is picked up without touching the seeder.
 */
const PARENT_SURFACE_KEYS = ["modelRegistry", "modelRuntime"] as const;

/**
 * Find a provider-registration surface on the parent context, trying the
 * documented public surfaces in order. Returns `undefined` when none exists —
 * callers must treat that as "nothing to seed", never as an error.
 */
export function findParentProviderSurface(
  ctxLike: unknown,
): ParentProviderSurface | undefined {
  if (typeof ctxLike !== "object" || ctxLike === null) return undefined;
  const holder = ctxLike as Record<string, unknown>;
  for (const key of PARENT_SURFACE_KEYS) {
    try {
      const candidate = holder[key];
      if (isProviderSurface(candidate)) return candidate;
    } catch {
      /* a throwing getter is just not a usable surface */
    }
  }
  return undefined;
}

/**
 * Compare the parent surface's registrations with what the child already
 * composes. Never throws; a feature-detection failure on either side degrades
 * to the safest scan (empty child set ⇒ everything in the parent counts as
 * missing — re-registering is a merge, not a clobber).
 */
export function collectMissingChildProviders(
  childRuntimeLike: unknown,
  parentSurfaceLike: unknown,
): ProviderGapScan {
  const childIds = new Set(registeredIdsOn(childRuntimeLike));
  const parentIds = registeredIdsOn(parentSurfaceLike);
  const missing: string[] = [];
  const present: string[] = [];
  for (const id of parentIds) {
    if (childIds.has(id)) present.push(id);
    else missing.push(id);
  }
  return { missing, present };
}

/**
 * Seed the child runtime with the parent surface's provider registrations.
 *
 * Per missing id: register the provider object when the parent has one, else
 * the provider config. Every id is individually fault-isolated — a malformed
 * registration is recorded in `errors` and the remaining ids are still seeded.
 * Idempotent: ids the child already composes are skipped, so a repeated call
 * (or a shared runtime) is a no-op for them.
 *
 * Never throws. On the real Pi runtime each registration also triggers a
 * network-off, fire-and-forget catalog refresh — local composition only.
 */
export function seedChildRuntimeProviders(
  modelRuntimeLike: unknown,
  parentSurfaceLike: unknown,
): ProviderSeedResult {
  const result: ProviderSeedResult = {
    seeded: [],
    skippedPresent: [],
    errors: [],
  };
  try {
    if (!isProviderSurface(parentSurfaceLike)) return result;
    const gap = collectMissingChildProviders(modelRuntimeLike, parentSurfaceLike);
    result.skippedPresent = gap.present;
    for (const id of gap.missing) {
      try {
        const getNative = parentSurfaceLike.getRegisteredNativeProvider as (
          this: unknown,
          providerId: string,
        ) => unknown;
        const native =
          typeof getNative === "function" ? getNative.call(parentSurfaceLike, id) : undefined;
        if (native !== undefined && native !== null) {
          const registerNative = (modelRuntimeLike as {
            registerNativeProvider?: unknown;
          })?.registerNativeProvider;
          if (typeof registerNative !== "function") {
            throw new Error(
              "the reviewer runtime does not expose registerNativeProvider",
            );
          }
          (registerNative as (this: unknown, p: unknown) => void).call(
            modelRuntimeLike,
            native,
          );
        } else {
          const getConfig = parentSurfaceLike.getRegisteredProviderConfig as (
            this: unknown,
            providerId: string,
          ) => unknown;
          const config =
            typeof getConfig === "function"
              ? getConfig.call(parentSurfaceLike, id)
              : undefined;
          if (config === undefined || config === null) {
            throw new Error(
              "the parent surface has no registration to copy for this id",
            );
          }
          const registerProvider = (modelRuntimeLike as {
            registerProvider?: unknown;
          })?.registerProvider;
          if (typeof registerProvider !== "function") {
            throw new Error(
              "the reviewer runtime does not expose registerProvider",
            );
          }
          (registerProvider as (this: unknown, id: string, c: unknown) => void).call(
            modelRuntimeLike,
            id,
            config,
          );
        }
        result.seeded.push(id);
      } catch (e: unknown) {
        result.errors.push({
          name: id,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
  } catch {
    /* the probe itself misbehaved: report "did nothing" rather than throw */
  }
  return result;
}

/** Outcome of the reviewer's provider-auth preflight. */
export interface ReviewerAuthCheck {
  configured: boolean;
  /** `hasConfiguredAuth` said yes (snapshot). */
  viaSnapshot: boolean;
  /** `checkAuth` resolved to something (credential resolution). */
  viaCheckAuth: boolean;
  /** True when the runtime exposes neither accessor (cannot verify — trust). */
  unverifiable: boolean;
}

/**
 * Provider-agnostic reviewer auth preflight, mirroring the child session's own
 * prompt gate (`hasConfiguredAuth(provider) || checkAuth(provider) !==
 * undefined`) but tolerating a runtime that exposes neither accessor (old or
 * stubbed SDKs): "cannot verify" proceeds rather than blocks. Feature-detected
 * and never throws; a throwing `checkAuth` counts as "not configured".
 */
export async function checkReviewerProviderAuth(
  runtimeLike: unknown,
  providerId: string,
): Promise<ReviewerAuthCheck> {
  let viaSnapshot = false;
  let sawSnapshotAccessor = false;
  try {
    const has = (runtimeLike as { hasConfiguredAuth?: unknown })
      ?.hasConfiguredAuth;
    if (typeof has === "function") {
      sawSnapshotAccessor = true;
      viaSnapshot =
        (has as (this: unknown, id: string) => unknown).call(
          runtimeLike,
          providerId,
        ) === true;
    }
  } catch {
    viaSnapshot = false;
  }
  if (viaSnapshot) {
    return { configured: true, viaSnapshot: true, viaCheckAuth: false, unverifiable: false };
  }
  let viaCheckAuth = false;
  let sawCheckAuthAccessor = false;
  try {
    const check = (runtimeLike as { checkAuth?: unknown })?.checkAuth;
    if (typeof check === "function") {
      sawCheckAuthAccessor = true;
      const resolved = await (check as (this: unknown, id: string) => unknown).call(
        runtimeLike,
        providerId,
      );
      viaCheckAuth = resolved !== undefined && resolved !== null;
    }
  } catch {
    viaCheckAuth = false;
  }
  const unverifiable = !sawSnapshotAccessor && !sawCheckAuthAccessor;
  return {
    configured: viaCheckAuth || unverifiable,
    viaSnapshot: false,
    viaCheckAuth,
    unverifiable,
  };
}

/** One-line summary of a seed result, for preflight/failure messages. */
export function describeSeedResult(result: ProviderSeedResult): string {
  const parts: string[] = [];
  parts.push(
    result.seeded.length > 0
      ? `seeded into the reviewer runtime: ${result.seeded.join(", ")}`
      : "nothing needed seeding",
  );
  parts.push(
    result.skippedPresent.length > 0
      ? `already present: ${result.skippedPresent.join(", ")}`
      : "none were already present",
  );
  parts.push(
    result.errors.length > 0
      ? `failed: ${result.errors
          .map((e) => `${e.name} (${e.error})`)
          .join("; ")}`
      : "no failures",
  );
  return parts.join("; ");
}

/**
 * Build the fail-fast error for a reviewer provider whose auth could not be
 * resolved after seeding. Names the provider, reports what the seed found,
 * and gives the generic escape hatch that works for ANY provider.
 */
export function unconfiguredReviewerProviderMessage(input: {
  providerId: string;
  seed: ProviderSeedResult;
  /** Parent surface was absent entirely (no probe hit). */
  parentSurfaceFound: boolean;
  modelsJsonPath?: string;
}): string {
  const modelsJson =
    input.modelsJsonPath ?? "~/.pi/agent/models.json";
  const seedSummary = input.parentSurfaceFound
    ? describeSeedResult(input.seed)
    : "the parent session exposed no provider-registration surface, so nothing could be seeded";
  const lines = [
    `the reviewer session has no usable auth for provider "${input.providerId}".`,
    `Provider seeding: ${seedSummary}.`,
    `The reviewer runs in an isolated session without ambient extensions, so a provider registered only in the parent session must be seeded (above) AND its auth must be resolvable on its own.`,
    `Fix any one of:`,
    `  1. run /login ${input.providerId} — the stored credential is read by every runtime, including the reviewer's;`,
    `  2. add a static provider entry to ${modelsJson} — that file is loaded by every runtime, including the reviewer's:`,
    `       { "providers": { "${input.providerId}": { "baseUrl": "…", "apiKey": "$MY_API_KEY", "api": "openai-completions", "models": [ … ] } } }`,
    `  3. export MY_API_KEY in the environment when the provider config references "$MY_API_KEY".`,
  ];
  return lines.join("\n");
}

/**
 * Defensive hint appended to a mid-run pass-1 failure that still carries the
 * bare provider-auth text. After seeding + preflight this path should be rare;
 * it is the safety net for any future provider-source gap.
 *
 * Only fires when the error text matches the provider-auth failure shape AND
 * the failing provider (extracted from the text) matches the reviewer's own
 * provider id — an unrelated error must never gain a misleading hint.
 */
export function appendProviderAuthHint(
  errorText: string,
  providerId: string | undefined,
  modelsJsonPath?: string,
): string {
  if (!providerId || !errorText) return errorText;
  const match = errorText.match(/No API key found for\s+([^\s.]+)/);
  if (!match) return errorText;
  const failingProvider = match[1];
  if (failingProvider !== providerId) return errorText;
  const modelsJson = modelsJsonPath ?? "~/.pi/agent/models.json";
  return [
    errorText,
    `Hint: provider "${providerId}" may only be registered in the parent session; the reviewer session starts without ambient extensions.`,
    `Run /login ${providerId}, or add a static provider entry to ${modelsJson} (loaded by every runtime, including the reviewer's).`,
  ].join("\n");
}
