/**
 * Provider-agnostic auth preflight for isolated child sessions.
 *
 * Review Mode and prompt refinement both create a second SDK session with its
 * own `ModelRuntime`. That runtime composes the built-in catalog and
 * `~/.pi/agent/models.json`, but it does not inherit providers that the parent
 * session registered at runtime (`pi.registerProvider(...)`) unless the shared
 * provider seeder copies them (`review-providers.ts`). After seeding, the child
 * must still be asked whether the *requested* provider has usable auth before a
 * session is created, otherwise the first prompt fails with a bare
 * `No API key found for <provider>`.
 *
 * This module owns only that probe. Failure text, model selection, prompts and
 * fallback policy stay in the caller's wrapper.
 *
 * The probe mirrors the child session's own prompt gate
 * (`hasConfiguredAuth(provider) || checkAuth(provider) !== undefined`) but
 * tolerates runtimes that expose neither accessor (old or stubbed SDKs):
 * "cannot verify" proceeds rather than blocking. Feature-detected and never
 * throws; a throwing `checkAuth` counts as "not configured".
 */

export interface ProviderAuthCheck {
  configured: boolean;
  /** `hasConfiguredAuth` said yes (snapshot). */
  viaSnapshot: boolean;
  /** `checkAuth` resolved to something (credential resolution). */
  viaCheckAuth: boolean;
  /** True when the runtime exposes neither accessor (cannot verify — trust). */
  unverifiable: boolean;
}

export async function checkProviderAuth(
  runtimeLike: unknown,
  providerId: string,
): Promise<ProviderAuthCheck> {
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
    return {
      configured: true,
      viaSnapshot: true,
      viaCheckAuth: false,
      unverifiable: false,
    };
  }
  let viaCheckAuth = false;
  let sawCheckAuthAccessor = false;
  try {
    const check = (runtimeLike as { checkAuth?: unknown })?.checkAuth;
    if (typeof check === "function") {
      sawCheckAuthAccessor = true;
      const resolved = await (
        check as (this: unknown, id: string) => unknown
      ).call(runtimeLike, providerId);
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
