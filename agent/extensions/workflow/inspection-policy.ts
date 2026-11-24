/**
 * Workflow Extension — policy-safe inspection primitives (pure core)
 *
 * A guarded inspection answers one question before any bytes reach a model:
 * "may this exact filesystem target be touched under BOTH the authority the
 * caller started with and the authority that is live right now?"
 *
 * The starting snapshot is a ceiling, never a permission. The live resolver is
 * re-read for every target (and again before an asynchronous result is
 * exposed), so a revoked grant, a new exclude rule or a trust downgrade
 * narrows the inspection in flight instead of being ignored.
 *
 * Nothing here imports the Pi SDK, so the rules stay unit-testable and can be
 * reused by any read/grep/find/ls construction (the reviewer is just one
 * consumer). Shells and broad MCP/LSP channels are deliberately absent.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import {
  DEFAULT_FOLDER_POLICY_CONFIG,
  canonicalizePolicyPath,
  detectRepoRoot,
  effectiveSensitivePatterns,
  evaluateFolderTargets,
  isInsidePolicyPath,
  matchSensitivePath,
  normalizeExcludePattern,
  normalizePolicyPath,
  toPosixPath,
  type FolderPolicyConfig,
  type FolderTarget,
  type FolderTargetKind,
} from "./folder-policy.ts";
import { redactSensitiveText } from "./read-policy-redact.ts";

// ── Authority ────────────────────────────────────────────────────────

/**
 * One resolved authority snapshot. `config` + `grants` are the folder-policy
 * layer; `root` is the deepest folder the caller approved; `trusted` is the
 * project-trust bit (false fails closed).
 */
export interface InspectionAuthority {
  config: FolderPolicyConfig;
  grants: readonly string[];
  root: string;
  trusted: boolean;
}

export type InspectionAuthorityResolver = () => InspectionAuthority;

export interface InspectionAuthoritySet {
  /** Snapshot captured when the inspection tools were built. */
  ceiling: InspectionAuthority;
  /** Snapshot resolved for this call. */
  current: InspectionAuthority;
}

/**
 * Build an authority snapshot from a parent folder-policy view. The reviewer
 * (and any other locked consumer) is pinned to its repository/cwd root with
 * `outside: "block"`; the parent config's deny layers are inherited verbatim.
 */
export function createInspectionAuthority(
  cwd: string,
  parent?: { config: FolderPolicyConfig; grants: readonly string[] },
  trusted = true,
): InspectionAuthority {
  return {
    root: detectRepoRoot(cwd) ?? normalizePolicyPath(cwd, cwd),
    config: {
      ...(parent?.config ?? DEFAULT_FOLDER_POLICY_CONFIG),
      mode: "cwd",
      outside: "block",
    },
    grants: [...(parent?.grants ?? [])],
    trusted,
  };
}

/** Resolve safely: a throwing budget/trust resolver fails closed. */
export function resolveInspectionAuthority(
  resolver: InspectionAuthorityResolver | undefined,
  cwd: string,
): InspectionAuthority {
  if (!resolver) return createInspectionAuthority(cwd);
  try {
    const resolved = resolver();
    if (!resolved || typeof resolved !== "object") {
      return { ...createInspectionAuthority(cwd), trusted: false };
    }
    return resolved;
  } catch {
    return { ...createInspectionAuthority(cwd), trusted: false };
  }
}

function patternList(config: FolderPolicyConfig): string[] {
  return effectiveSensitivePatterns(config).map((pattern) =>
    pattern.toLowerCase(),
  );
}

function excludeList(config: FolderPolicyConfig): string[] {
  return config.excludePaths
    .map((entry) => normalizeExcludePattern(entry).toLowerCase())
    .filter(Boolean);
}

function grantList(grants: readonly string[]): string[] {
  return grants
    .map((grant) => normalizePolicyPath(grant, process.cwd()))
    .filter(Boolean);
}

/**
 * True when `next` is strictly narrower than `previous` for inspection: a
 * revoked grant, a new sensitive/exclude rule, a tighter root, or lost trust.
 * Added grants or removed rules widen and are handled by the ceiling check.
 */
export function inspectionAuthorityNarrowed(
  previous: InspectionAuthority,
  next: InspectionAuthority,
): boolean {
  if (previous.trusted !== next.trusted) return !next.trusted;
  if (!next.trusted) return true;

  if (previous.root !== next.root) {
    // A changed root is narrower unless the new root fully contains the old
    // one (which would widen; the ceiling still forbids that).
    if (!isInsidePolicyPath(previous.root, next.root)) return true;
  }

  const prevGrants = new Set(grantList(previous.grants));
  const nextGrants = new Set(grantList(next.grants));
  for (const grant of prevGrants) {
    if (!nextGrants.has(grant)) return true;
  }

  const prevSensitive = new Set(patternList(previous.config));
  for (const pattern of patternList(next.config)) {
    if (!prevSensitive.has(pattern)) return true;
  }
  const prevExcludes = new Set(excludeList(previous.config));
  for (const pattern of excludeList(next.config)) {
    if (!prevExcludes.has(pattern)) return true;
  }

  if (previous.config.outside === "block" && next.config.outside !== "block")
    return false;
  if (previous.config.outside !== "block" && next.config.outside === "block")
    return true;
  return false;
}

// ── Target evaluation ────────────────────────────────────────────────

export type InspectionDenyReason =
  | "untrusted"
  | "missing-path"
  | "sensitive"
  | "excluded"
  | "outside"
  | "unresolvable";

export interface InspectionDecision {
  allowed: boolean;
  /** Normalised lexical path (the path the caller asked for). */
  path?: string;
  reason?: InspectionDenyReason;
  detail?: string;
  pattern?: string;
}

function deny(
  reason: InspectionDenyReason,
  extra: Partial<InspectionDecision> = {},
): InspectionDecision {
  return { allowed: false, reason, ...extra };
}

/**
 * True when the path itself exists. An unresolvable path with no existing
 * ancestor cannot be opened by the operation anyway, so it is reported as a
 * normal tool error rather than a policy leak; an existing path that still
 * cannot be canonicalised is treated as untrusted.
 */
function pathExists(value: string): boolean {
  try {
    return fs.existsSync(value);
  } catch {
    return false;
  }
}

/**
 * Evaluate one target under the ceiling and the live authority. Both must
 * allow it; the first refusal wins and is reported with a stable reason.
 */
export function evaluateInspectionTarget(
  value: unknown,
  kind: FolderTargetKind,
  authorities: InspectionAuthoritySet,
  cwd: string,
): InspectionDecision {
  if (typeof value !== "string" || !value.trim()) {
    return deny("missing-path");
  }
  const lexical = normalizePolicyPath(value, cwd);
  if (!lexical) return deny("missing-path", { path: lexical });

  const views: Array<[InspectionAuthority, string]> = [
    [authorities.ceiling, "approved"],
    [authorities.current, "current"],
  ];
  for (const [authority, label] of views) {
    if (!authority.trusted) {
      return deny("untrusted", {
        path: lexical,
        detail: `the ${label} project trust is not granted`,
      });
    }
    // Sensitive-file rules win over every scope rule.
    const sensitive = matchSensitivePath(lexical, authority.config, cwd);
    if (sensitive.sensitive) {
      return deny("sensitive", {
        path: lexical,
        pattern: sensitive.pattern,
        detail: `matches the sensitive rule \`${sensitive.pattern ?? "sensitive"}\``,
      });
    }
    const canonicalResult = canonicalizePolicyPath(lexical, cwd);
    const canonical = canonicalResult.path || lexical;
    const resolved = canonicalResult.resolved;
    const exists = pathExists(
      lexical.replace(/\//g, path.sep),
    );
    const target: FolderTarget = { path: lexical, kind };
    const evaluation = evaluateFolderTargets([target], {
      config: authority.config,
      grants: authority.grants,
      cwd,
      lockedRoots: [authority.root],
      action: "read",
    });
    if (evaluation.sensitive.length > 0) {
      return deny("sensitive", {
        path: lexical,
        pattern: evaluation.sensitive[0]?.pattern,
        detail: "a sensitive rule matched the resolved path",
      });
    }
    if (evaluation.excluded.length > 0) {
      return deny("excluded", {
        path: lexical,
        pattern: evaluation.excluded[0]?.pattern,
        detail: `the path is inside the excluded folder \`${evaluation.excluded[0]?.root ?? ""}\``,
      });
    }
    if (evaluation.uncertain.length > 0 && (resolved || exists)) {
      return deny("unresolvable", {
        path: lexical,
        detail: "the target could not be verified against the approved roots",
      });
    }
    if (evaluation.outside.length > 0) {
      return deny("outside", {
        path: lexical,
        detail: `the path is outside the approved root \`${authority.root}\``,
      });
    }
    // Explicit belt-and-braces containment check for aliases/symlinks.
    if (!isInsidePolicyPath(lexical, authority.root)) {
      return deny("outside", {
        path: lexical,
        detail: `the path is outside the approved root \`${authority.root}\``,
      });
    }
    if (!isInsidePolicyPath(canonical, authority.root)) {
      return deny("outside", {
        path: lexical,
        detail: "the resolved path escapes the approved root (symlink/junction)",
      });
    }
  }
  return { allowed: true, path: lexical };
}

/** Boolean form used to filter one entry out of a recursive result. */
export function isInspectionPathAllowed(
  value: unknown,
  kind: FolderTargetKind,
  authorities: InspectionAuthoritySet,
  cwd: string,
): boolean {
  return evaluateInspectionTarget(value, kind, authorities, cwd).allowed;
}

export function inspectionRefusalText(
  tool: string,
  decision: InspectionDecision,
): string {
  const target = decision.path || "the requested path";
  const suffix = decision.detail ? ` — ${decision.detail}` : "";
  return `${tool}: REFUSED — \`${target}\` is outside the approved repository or protected by the current read policy${suffix}. Work inside the approved root; do not work around this.`;
}

// ── Result bounding / sanitising ─────────────────────────────────────

export interface InspectionLimits {
  /** Maximum text bytes exposed to the model per content block. */
  maxContentBytes?: number;
  /** Maximum serialised size of `details`. */
  maxDetailsBytes?: number;
  maxDetailsDepth?: number;
  maxDetailsItems?: number;
  /** Maximum number of files a recursive grep will scan. */
  maxScanFiles?: number;
}

export const DEFAULT_INSPECTION_LIMITS: Required<InspectionLimits> = {
  maxContentBytes: 50 * 1024,
  maxDetailsBytes: 8 * 1024,
  maxDetailsDepth: 4,
  maxDetailsItems: 100,
  maxScanFiles: 20_000,
};

export function resolveInspectionLimits(
  limits?: InspectionLimits,
): Required<InspectionLimits> {
  return {
    maxContentBytes: Math.max(
      1,
      Math.trunc(limits?.maxContentBytes ?? DEFAULT_INSPECTION_LIMITS.maxContentBytes),
    ),
    maxDetailsBytes: Math.max(
      0,
      Math.trunc(limits?.maxDetailsBytes ?? DEFAULT_INSPECTION_LIMITS.maxDetailsBytes),
    ),
    maxDetailsDepth: Math.max(
      1,
      Math.trunc(limits?.maxDetailsDepth ?? DEFAULT_INSPECTION_LIMITS.maxDetailsDepth),
    ),
    maxDetailsItems: Math.max(
      1,
      Math.trunc(limits?.maxDetailsItems ?? DEFAULT_INSPECTION_LIMITS.maxDetailsItems),
    ),
    maxScanFiles: Math.max(
      1,
      Math.trunc(limits?.maxScanFiles ?? DEFAULT_INSPECTION_LIMITS.maxScanFiles),
    ),
  };
}

const TEMP_KEY = /^(full[_-]?output([_-]?path)?|temp(file|path|dir)?|tmp(file|path|dir)?|outputpath|artifactpath)$/i;
const PATH_LIKE = /[\\/]|^[A-Za-z]:[\\/]|^\\\\/;
const TRUNCATION_FIELDS = new Set([
  "truncated",
  "truncatedBy",
  "totalLines",
  "totalBytes",
  "outputLines",
  "outputBytes",
  "lastLinePartial",
  "firstLineExceedsLimit",
  "maxLines",
  "maxBytes",
]);

function boundText(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  const marker = "\n[output truncated by inspection policy]";
  const budget = Math.max(0, maxBytes - Buffer.byteLength(marker, "utf8"));
  const slice = Buffer.from(text, "utf8").subarray(0, budget).toString("utf8");
  // Avoid leaving a torn multi-byte character or half a line at the cut.
  const lastNewline = slice.lastIndexOf("\n");
  const clean = lastNewline > 0 ? slice.slice(0, lastNewline) : slice;
  return clean + marker;
}

function stripTemporaryOutputReferences(text: string): string {
  return text
    .split("\n")
    .filter(
      (line) =>
        !/^\s*Full output:\s/i.test(line) &&
        !/^\s*\[full output:\s/i.test(line),
    )
    .join("\n");
}

function looksLikePath(value: string): boolean {
  return PATH_LIKE.test(value);
}

function sanitizeDetailValue(
  value: unknown,
  authorities: InspectionAuthoritySet,
  cwd: string,
  limits: Required<InspectionLimits>,
  depth: number,
): { keep: boolean; value?: unknown } {
  if (depth > limits.maxDetailsDepth) return { keep: false };
  if (typeof value === "string") {
    if (value.length > 2_048) return { keep: false };
    if (looksLikePath(value)) {
      const check = value.replace(/^@/, "");
      if (!isInspectionPathAllowed(check, "file", authorities, cwd)) {
        return { keep: false };
      }
    }
    return { keep: true, value };
  }
  if (typeof value === "number" || typeof value === "boolean" || value === null)
    return { keep: true, value };
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const entry of value.slice(0, limits.maxDetailsItems)) {
      const sanitized = sanitizeDetailValue(
        entry,
        authorities,
        cwd,
        limits,
        depth + 1,
      );
      if (sanitized.keep) out.push(sanitized.value);
    }
    return { keep: true, value: out };
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    let count = 0;
    for (const [key, entry] of Object.entries(
      value as Record<string, unknown>,
    )) {
      if (TEMP_KEY.test(key)) continue;
      if (count >= limits.maxDetailsItems) break;
      if (key === "truncation" && entry && typeof entry === "object") {
        // Truncation details can carry the full untruncated content; keep only
        // the structural counters.
        const safe: Record<string, unknown> = {};
        for (const [tKey, tValue] of Object.entries(
          entry as Record<string, unknown>,
        )) {
          if (TRUNCATION_FIELDS.has(tKey) && typeof tValue !== "object") {
            safe[tKey] = tValue;
          }
        }
        out[key] = safe;
        count += 1;
        continue;
      }
      const sanitized = sanitizeDetailValue(
        entry,
        authorities,
        cwd,
        limits,
        depth + 1,
      );
      if (!sanitized.keep) continue;
      out[key] = sanitized.value;
      count += 1;
    }
    return { keep: true, value: out };
  }
  return { keep: false };
}

/** Strip temp-file escape hatches and any path/structured detail that leaks. */
export function sanitizeInspectionDetails(
  details: unknown,
  authorities: InspectionAuthoritySet,
  cwd: string,
  limits: Required<InspectionLimits> = DEFAULT_INSPECTION_LIMITS,
): Record<string, unknown> | undefined {
  if (!details || typeof details !== "object") return undefined;
  const sanitized = sanitizeDetailValue(details, authorities, cwd, limits, 0);
  if (!sanitized.keep || !sanitized.value) return undefined;
  let serialized: string;
  try {
    serialized = JSON.stringify(sanitized.value);
  } catch {
    return undefined;
  }
  if (Buffer.byteLength(serialized, "utf8") > limits.maxDetailsBytes) {
    return { truncated: true };
  }
  return sanitized.value as Record<string, unknown>;
}

/** Merge the deny layers of several authorities for defence-in-depth redaction. */
export function mergeInspectionConfigs(
  authorities: readonly InspectionAuthority[],
): FolderPolicyConfig {
  const first = authorities[0]?.config ?? DEFAULT_FOLDER_POLICY_CONFIG;
  const union = (pick: (config: FolderPolicyConfig) => string[]): string[] => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const authority of authorities.length > 0 ? authorities : []) {
      for (const entry of pick(authority.config)) {
        const key = entry.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(entry);
      }
    }
    return out;
  };
  return {
    ...first,
    mode: "cwd",
    outside: "block",
    sensitivePatterns: union((config) => config.sensitivePatterns),
    sensitiveExemptions: union((config) => config.sensitiveExemptions),
    excludePaths: union((config) => config.excludePaths),
  };
}

export interface InspectionTextBlock {
  type: string;
  text?: string;
  [key: string]: unknown;
}

export interface InspectionToolResult {
  content: InspectionTextBlock[];
  details?: Record<string, unknown>;
  isError?: boolean;
  structuredContent?: unknown;
  [key: string]: unknown;
}

/**
 * Redact a result under every authority's deny layer, drop structured channels
 * and temp-output escape hatches, then bound text and details.
 */
export function sanitizeInspectionResult(
  result: InspectionToolResult,
  tool: string,
  input: Record<string, unknown>,
  authorities: InspectionAuthoritySet,
  cwd: string,
  limits: Required<InspectionLimits> = DEFAULT_INSPECTION_LIMITS,
): InspectionToolResult {
  const config = mergeInspectionConfigs([
    authorities.ceiling,
    authorities.current,
  ]);
  let redacted = false;
  const content = (result.content ?? []).map((block) => {
    if (!block || block.type !== "text" || typeof block.text !== "string") {
      return block;
    }
    let text = stripTemporaryOutputReferences(block.text);
    for (const view of [authorities.ceiling, authorities.current]) {
      const next = redactSensitiveText(
        text,
        tool,
        input,
        cwd,
        mergeInspectionConfigs([view]),
      );
      text = next.text;
      if (next.redacted) redacted = true;
    }
    // `config` above is intentionally the union; run it last for aliases that
    // only appear when the two snapshots are combined.
    const combined = redactSensitiveText(text, tool, input, cwd, config);
    text = combined.text;
    if (combined.redacted) redacted = true;
    return { ...block, text: boundText(text, limits.maxContentBytes) };
  });

  const out: InspectionToolResult = { ...result, content };
  delete out.structuredContent;
  const details = sanitizeInspectionDetails(result.details, authorities, cwd, limits);
  if (details === undefined) delete out.details;
  else out.details = details;
  return out;
}

/** Best-effort cleanup helper for tests/diagnostics. */
export function inspectionDisplayPath(value: string, cwd: string): string {
  return toPosixPath(path.relative(cwd, value) || value);
}

/** True when a filesystem entry is a directory, without following a symlink escape. */
export function isDirectoryEntry(entryPath: string): boolean {
  try {
    return fs.statSync(entryPath).isDirectory();
  } catch {
    return false;
  }
}
