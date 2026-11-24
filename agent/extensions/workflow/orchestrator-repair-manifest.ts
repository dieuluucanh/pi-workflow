/**
 * Workflow Extension — plan-check repair manifest (Phase A).
 *
 * The standalone script and the in-session command accept the same small
 * manifest, so parsing lives here once instead of in two call sites:
 *
 *   {
 *     "reason": "why the checks change",
 *     "source": "who/what approved it",
 *     "allowEmpty": false,
 *     "commands": ["pnpm typecheck"],       // strings or {command,workspace?,kind?}
 *     "specs": [{"command":"pnpm lint","workspace":"W","kind":"gate"}]
 *   }
 *
 * Parsing is deliberately strict and pure: unknown shapes fail with a concrete
 * message, command shape/workspace/lists are validated later by the shared
 * repair helper (which needs the frozen workspace set).
 */

import type { PlanCheckSpec } from "./plan-checks.ts";

export interface RepairManifest {
  reason: string;
  source: string;
  allowEmpty: boolean;
  specs: Array<PlanCheckSpec & { kind?: string }>;
}

export type RepairManifestResult =
  | { ok: true; manifest: RepairManifest }
  | { ok: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function boundedText(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.replace(/\s+/g, " ").trim();
  if (!text) return undefined;
  return text.slice(0, max);
}

/**
 * Parse one manifest value. `commands` are bare strings (or objects), `specs`
 * are objects; using both at once is ambiguous and refused.
 */
export function parseRepairManifest(value: unknown): RepairManifestResult {
  if (!isRecord(value)) return { ok: false, error: "manifest must be a JSON object" };
  const reason = boundedText(value.reason, 500);
  if (!reason) return { ok: false, error: "manifest.reason is required" };
  const source = boundedText(value.source, 500);
  if (!source) return { ok: false, error: "manifest.source is required" };
  if (value.allowEmpty !== undefined && typeof value.allowEmpty !== "boolean") {
    return { ok: false, error: "manifest.allowEmpty must be a boolean" };
  }
  if (value.commands !== undefined && value.specs !== undefined) {
    return { ok: false, error: "use either manifest.commands or manifest.specs, not both" };
  }
  let rawSpecs: unknown[];
  if (value.specs !== undefined) {
    if (!Array.isArray(value.specs)) {
      return { ok: false, error: "manifest.specs must be an array" };
    }
    rawSpecs = value.specs;
  } else if (value.commands !== undefined) {
    if (!Array.isArray(value.commands)) {
      return { ok: false, error: "manifest.commands must be an array" };
    }
    rawSpecs = value.commands.map((entry) =>
      typeof entry === "string" ? { command: entry } : entry,
    );
  } else if (value.allowEmpty === true) {
    rawSpecs = [];
  } else {
    return { ok: false, error: "manifest needs commands, specs, or allowEmpty: true" };
  }

  const specs: RepairManifest["specs"] = [];
  for (const [index, entry] of rawSpecs.entries()) {
    const label = `manifest check ${index + 1}`;
    if (!isRecord(entry)) return { ok: false, error: `${label} is not an object` };
    if (typeof entry.command !== "string") {
      return { ok: false, error: `${label} has no command` };
    }
    if (entry.workspace !== undefined && typeof entry.workspace !== "string") {
      return { ok: false, error: `${label} has an invalid workspace` };
    }
    if (entry.kind !== undefined && typeof entry.kind !== "string") {
      return { ok: false, error: `${label} has an invalid kind` };
    }
    specs.push({
      command: entry.command,
      ...(typeof entry.workspace === "string" ? { workspace: entry.workspace } : {}),
      ...(typeof entry.kind === "string" ? { kind: entry.kind } : {}),
    });
  }
  return {
    ok: true,
    manifest: {
      reason,
      source,
      allowEmpty: value.allowEmpty === true,
      specs,
    },
  };
}
