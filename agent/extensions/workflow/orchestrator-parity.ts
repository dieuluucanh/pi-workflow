/**
 * Workflow Extension — Build environment parity before edits (step 27).
 *
 * The parent plans in its own environment; the child must be an ordinary Build
 * session with equivalent capability. This module compares the intended parent
 * manifest with the child's readiness manifest and PAUSES before mutation on
 * any capability that would be silently missing.
 *
 * Nuances:
 *   - a parent ACTIVE tool must exist in the child; a child may expose it as
 *     deferred (the loadout can activate it), which is a warning, not a block;
 *   - a missing MCP/extension/host capability is a blocker unless a TESTED
 *     adapter attests it can recreate that exact capability;
 *   - model/policy/runtime/provider identities are compared, never secrets;
 *   - session-specific metadata (ids, timestamps, transient ports) is ignored;
 *   - manifests are bounded: an oversized manifest blocks instead of being
 *     silently reduced.
 */

export const PARITY_SCHEMA_VERSION = 1 as const;
export const MAX_MANIFEST_ENTRIES = 500;

export type ToolProvenance = "builtin" | "extension" | "mcp" | "host" | "skill";
export type ToolExposure = "active" | "deferred";

export interface ToolCapability {
  name: string;
  provenance: ToolProvenance;
  exposure: ToolExposure;
}

export interface EnvironmentManifest {
  schemaVersion: typeof PARITY_SCHEMA_VERSION;
  role: "parent" | "child";
  model: { provider: string; id: string; thinking?: string };
  /** Configured provider ids (never credentials). */
  providers: readonly string[];
  tools: readonly ToolCapability[];
  /** Tools the ordinary Build loadout activates. */
  defaultLoadout: readonly string[];
  skills: readonly string[];
  prompts: readonly string[];
  themes: readonly string[];
  contextFiles: readonly string[];
  /** Host-added resources: checkpoint extension, pi-lens hooks, etc. */
  hostResources: readonly string[];
  /** Policy fingerprints, not policy contents. */
  policies: {
    role: string;
    folder: string;
    read: string;
    write: string;
    commit: string;
    shell: string;
  };
  runtime: { piVersion: string; sdkVersion: string; platform: string };
  /** Ignored during parity (legitimate per-session metadata). */
  session?: { id?: string; startedAt?: number; transientPort?: number | null };
}

export interface CapabilityAdapter {
  /** `provider:<id>`, `tool:<name>`, `resource:<kind>:<id>`, `host:<id>`. */
  id: string;
  /** Only a tested adapter may prevent a pause. */
  tested: boolean;
  recreate(input: {
    capabilityId: string;
    parent: EnvironmentManifest;
    child: EnvironmentManifest;
  }): Promise<{ ok: boolean; reason?: string }>;
}

export type ParityIssueCode =
  | "missing_tool"
  | "deferred_tool"
  | "missing_provider"
  | "missing_resource"
  | "missing_host_resource"
  | "missing_skill"
  | "model_mismatch"
  | "policy_mismatch"
  | "runtime_mismatch"
  | "manifest_too_large"
  | "adapted";

export interface ParityIssue {
  code: ParityIssueCode;
  capabilityId: string;
  message: string;
}

export interface ParityResult {
  ok: boolean;
  requiresPause: boolean;
  blockers: ParityIssue[];
  warnings: ParityIssue[];
  /** Recreated by a tested adapter; no pause. */
  recreated: ParityIssue[];
  /** Session-specific fields intentionally not compared. */
  ignored: string[];
}

function issue(code: ParityIssueCode, capabilityId: string, message: string): ParityIssue {
  return { code, capabilityId, message };
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => typeof value === "string" && value.length > 0))].sort();
}

function manifestTooLarge(manifest: EnvironmentManifest): boolean {
  return (
    manifest.tools.length > MAX_MANIFEST_ENTRIES ||
    manifest.providers.length > MAX_MANIFEST_ENTRIES ||
    manifest.skills.length > MAX_MANIFEST_ENTRIES ||
    manifest.prompts.length > MAX_MANIFEST_ENTRIES ||
    manifest.themes.length > MAX_MANIFEST_ENTRIES ||
    manifest.contextFiles.length > MAX_MANIFEST_ENTRIES ||
    manifest.hostResources.length > MAX_MANIFEST_ENTRIES ||
    manifest.defaultLoadout.length > MAX_MANIFEST_ENTRIES
  );
}

async function adapt(
  capabilityId: string,
  parent: EnvironmentManifest,
  child: EnvironmentManifest,
  adapters: readonly CapabilityAdapter[],
): Promise<{ adapted: boolean; reason?: string }> {
  const candidates = adapters.filter(
    (adapter) => adapter.tested && (adapter.id === capabilityId || adapter.id === "*"),
  );
  for (const adapter of candidates) {
    try {
      const result = await adapter.recreate({ capabilityId, parent, child });
      if (result.ok) return { adapted: true, ...(result.reason ? { reason: result.reason } : {}) };
    } catch {
      /* a throwing adapter is not evidence; keep looking */
    }
  }
  return { adapted: false };
}

function missingResources(
  parentValues: readonly string[],
  childValues: readonly string[],
  kind: string,
): string[] {
  const child = new Set(childValues);
  return uniqueSorted(parentValues).filter((value) => !child.has(value)).map((value) => `${kind}:${value}`);
}

/**
 * Compares environments. `requiresPause` is true when any non-adapted blocker
 * remains; the caller must not let the child mutate project sources.
 */
export async function compareBuilderEnvironment(
  parent: EnvironmentManifest,
  child: EnvironmentManifest,
  options: { adapters?: readonly CapabilityAdapter[]; requireSameThinking?: boolean } = {},
): Promise<ParityResult> {
  const adapters = options.adapters ?? [];
  const blockers: ParityIssue[] = [];
  const warnings: ParityIssue[] = [];
  const recreated: ParityIssue[] = [];

  if (manifestTooLarge(parent) || manifestTooLarge(child)) {
    return {
      ok: false,
      requiresPause: true,
      blockers: [
        issue(
          "manifest_too_large",
          "manifest",
          `a manifest exceeds ${MAX_MANIFEST_ENTRIES} entries; refusing a silent reduction`,
        ),
      ],
      warnings: [],
      recreated: [],
      ignored: [],
    };
  }

  const report = async (
    candidate: ParityIssue,
    action: "block" | "warn",
  ): Promise<void> => {
    const adapted = await adapt(candidate.capabilityId, parent, child, adapters);
    if (adapted.adapted) {
      recreated.push(
        issue(
          "adapted",
          candidate.capabilityId,
          `${candidate.message} — recreated by a tested adapter${adapted.reason ? ` (${adapted.reason})` : ""}`,
        ),
      );
      return;
    }
    if (action === "block") blockers.push(candidate);
    else warnings.push(candidate);
  };

  const childTools = new Map(child.tools.map((tool) => [tool.name, tool]));
  for (const tool of parent.tools) {
    const inChild = childTools.get(tool.name);
    if (!inChild) {
      // A missing configured MCP/extension/host capability is a reduction; a
      // missing deferred builtin is only a warning.
      const blocking =
        tool.exposure === "active" || tool.provenance === "mcp" || tool.provenance === "extension" || tool.provenance === "host";
      await report(
        issue(
          "missing_tool",
          `tool:${tool.name}`,
          `child is missing ${tool.provenance} tool ${tool.name} (${tool.exposure})`,
        ),
        blocking ? "block" : "warn",
      );
    } else if (tool.exposure === "active" && inChild.exposure === "deferred") {
      warnings.push(
        issue(
          "deferred_tool",
          `tool:${tool.name}`,
          `tool ${tool.name} is deferred in the child; the Build loadout must activate it`,
        ),
      );
    }
  }
  const childDefaults = new Set(child.defaultLoadout);
  for (const name of uniqueSorted(parent.defaultLoadout)) {
    if (!childDefaults.has(name)) {
      await report(
        issue("missing_tool", `tool:${name}`, `the child default loadout does not include ${name}`),
        "block",
      );
    }
  }

  for (const provider of uniqueSorted(parent.providers)) {
    if (child.providers.includes(provider)) continue;
    await report(
      issue("missing_provider", `provider:${provider}`, `provider ${provider} is not configured in the child`),
      "block",
    );
  }

  for (const id of missingResources(parent.skills, child.skills, "skill")) {
    await report(issue("missing_skill", id, `skill ${id.slice("skill:".length)} is missing`), "block");
  }
  for (const [kind, values] of [
    ["prompt", parent.prompts],
    ["theme", parent.themes],
    ["context", parent.contextFiles],
  ] as const) {
    for (const id of missingResources(values, kind === "prompt" ? child.prompts : kind === "theme" ? child.themes : child.contextFiles, kind)) {
      await report(
        issue("missing_resource", id, `${kind} ${id.slice(kind.length + 1)} is missing`),
        "block",
      );
    }
  }
  for (const id of missingResources(parent.hostResources, child.hostResources, "host")) {
    await report(
      issue("missing_host_resource", id, `host resource ${id.slice(5)} is missing`),
      "block",
    );
  }

  if (parent.model.provider !== child.model.provider || parent.model.id !== child.model.id) {
    blockers.push(
      issue(
        "model_mismatch",
        `model:${parent.model.provider}/${parent.model.id}`,
        `child runs ${child.model.provider}/${child.model.id}, expected ${parent.model.provider}/${parent.model.id}`,
      ),
    );
  } else if (
    options.requireSameThinking !== false &&
    (parent.model.thinking ?? "") !== (child.model.thinking ?? "")
  ) {
    blockers.push(
      issue(
        "model_mismatch",
        "model:thinking",
        `thinking level differs (${parent.model.thinking ?? "default"} vs ${child.model.thinking ?? "default"})`,
      ),
    );
  }

  for (const key of ["role", "folder", "read", "write", "commit", "shell"] as const) {
    if (parent.policies[key] !== child.policies[key]) {
      blockers.push(
        issue("policy_mismatch", `policy:${key}`, `${key} policy differs between parent and child`),
      );
    }
  }

  if (
    parent.runtime.piVersion !== child.runtime.piVersion ||
    parent.runtime.sdkVersion !== child.runtime.sdkVersion
  ) {
    await report(
      issue(
        "runtime_mismatch",
        "runtime:pi",
        `runtime differs (pi ${parent.runtime.piVersion}/${child.runtime.piVersion}, sdk ${parent.runtime.sdkVersion}/${child.runtime.sdkVersion})`,
      ),
      "block",
    );
  }
  if (parent.runtime.platform !== child.runtime.platform) {
    blockers.push(
      issue(
        "runtime_mismatch",
        "runtime:platform",
        `platform differs (${parent.runtime.platform} vs ${child.runtime.platform})`,
      ),
    );
  }

  return {
    ok: blockers.length === 0,
    requiresPause: blockers.length > 0,
    blockers,
    warnings,
    recreated,
    ignored: parent.session || child.session ? ["session.id", "session.startedAt", "session.transientPort"] : [],
  };
}

/** Convenience: true only when edits may start. */
export async function buildParityGate(
  parent: EnvironmentManifest,
  child: EnvironmentManifest,
  options: { adapters?: readonly CapabilityAdapter[]; requireSameThinking?: boolean } = {},
): Promise<{ allowed: boolean; result: ParityResult }> {
  const result = await compareBuilderEnvironment(parent, child, options);
  return { allowed: result.ok && !result.requiresPause, result };
}
