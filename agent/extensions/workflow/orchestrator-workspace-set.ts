/**
 * Workflow Extension — multi-workspace identity for Orchestrator runs.
 *
 * A run may span sibling repositories. This module owns the pure contract:
 *   - parse the plan's conservative `Repositories:` / `## Workspaces` block;
 *   - resolve declarations to canonical roots through injected ports;
 *   - validate aliases, exactly one primary, overlap and broad roots.
 *
 * Nothing here reads the filesystem or spawns git. `orchestrator-workspace-set`
 * tests use fake resolvers, and `index.ts` supplies the real Node adapter.
 */

import * as path from "node:path";

import { isWindowsPath } from "./orchestrator-workspace.ts";
export interface RowWorkspaceBinding {
  workspaces?: readonly string[];
}

export const WORKSPACE_SET_SCHEMA_VERSION = 1 as const;
export const MAX_WORKSPACES = 8;
export const MAX_ALIAS_CHARS = 24;

const ALIAS = /^[A-Za-z][A-Za-z0-9_-]{0,23}$/;

/**
 * Path rules for the value's own platform, not the host's. Real hosts pass
 * native paths, so this matches the host; fake/injected Windows roots on a
 * POSIX test runner still resolve as absolute Windows paths.
 */
function pathRules(value: string): typeof path.posix {
  return isWindowsPath(value) ? path.win32 : path.posix;
}

export interface WorkspaceDeclaration {
  id: string;
  /** As written in the plan; relative paths resolve against the primary root. */
  path: string;
  sourceLine?: number;
}

export interface WorkspaceRoot {
  id: string;
  /** `git:<canonical root>` or `plain:<canonical root>`. */
  key: string;
  /** Canonical absolute root (git top level for a git workspace). */
  root: string;
  kind: "git" | "plain";
  displayPath: string;
  primary: boolean;
}

/** Persisted alias kept for the frozen snapshot. */
export type FrozenWorkspace = WorkspaceRoot;

export interface WorkspaceSet {
  schemaVersion: typeof WORKSPACE_SET_SCHEMA_VERSION;
  primaryId: string;
  roots: WorkspaceRoot[];
}

export interface WorkspaceSetResolver {
  /** Resolves symlinks; null for a missing path. */
  realpath(path: string): Promise<string | null>;
  /** Directory/file/other, or null when missing. */
  statKind(path: string): Promise<"file" | "dir" | "other" | null>;
  /** Git top level for a cwd, or null for a non-Git folder. */
  gitTopLevel(cwd: string): Promise<string | null>;
  /** Common git dir; worktrees share it. Diagnostics/future use. */
  gitCommonDir?(cwd: string): Promise<string | null>;
}

export type WorkspaceSetResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

export interface ResolveWorkspaceSetInput {
  primaryRoot: string;
  /** Plan declarations; ignored when `overrides` is non-empty. */
  declarations?: readonly WorkspaceDeclaration[];
  /** Explicit tool declarations: they replace the plan's declarations. */
  overrides?: readonly WorkspaceDeclaration[];
  resolver: WorkspaceSetResolver;
  /** Windows defaults to case-insensitive when omitted. */
  caseInsensitive?: boolean;
  /** Optional broad-root rejection, e.g. folder-policy broadGrantRootReason. */
  broadRootReason?: (root: string) => string | undefined;
}

export interface ValidateWorkspaceSetInput {
  roots: readonly WorkspaceRoot[];
  /** The parent session root; the primary must resolve to it. */
  sessionRoot?: string;
  caseInsensitive?: boolean;
  broadRootReason?: (root: string) => string | undefined;
}

/** Collapse separators, strip Windows verbatim prefixes and trailing slashes. */
export function normalizeWorkspacePath(
  value: string,
  caseInsensitive: boolean,
): string {
  let normalized = value.trim();
  if (normalized.startsWith("\\\\?\\UNC\\")) {
    normalized = `\\\\${normalized.slice(8)}`;
  } else if (normalized.startsWith("\\\\?\\")) {
    normalized = normalized.slice(4);
  }
  normalized = normalized.replace(/\\/g, "/");
  const unc = normalized.startsWith("//");
  normalized = normalized.replace(/\/{2,}/g, "/");
  if (unc && !normalized.startsWith("//")) normalized = `/${normalized}`;
  if (normalized.length > 1) normalized = normalized.replace(/\/+$/, "");
  return caseInsensitive ? normalized.toLowerCase() : normalized;
}

export function isInsideWorkspaceRoot(
  target: string,
  root: string,
  caseInsensitive: boolean,
): boolean {
  const t = normalizeWorkspacePath(target, caseInsensitive);
  const r = normalizeWorkspacePath(root, caseInsensitive);
  if (!t || !r) return false;
  if (t === r) return true;
  if (r === "/") return t.startsWith("/");
  return t.startsWith(`${r}/`);
}

function canonicalRoot(
  root: string,
  kind: "git" | "plain",
  caseInsensitive: boolean,
): string {
  return `${kind}:${normalizeWorkspacePath(root, caseInsensitive)}`;
}

function fail<T>(error: string): WorkspaceSetResult<T> {
  return { ok: false, error };
}

function validateRootShape(root: WorkspaceRoot): string | undefined {
  if (!ALIAS.test(root.id)) return `invalid workspace alias "${root.id}"`;
  if (!root.root || !pathRules(root.root).isAbsolute(root.root)) {
    return `workspace ${root.id} has no absolute root`;
  }
  if (root.kind !== "git" && root.kind !== "plain") {
    return `workspace ${root.id} has an unknown kind`;
  }
  if (!root.key.trim()) return `workspace ${root.id} has no identity key`;
  return undefined;
}

export function validateWorkspaceSet(
  input: ValidateWorkspaceSetInput,
): WorkspaceSetResult<WorkspaceSet> {
  const roots = input.roots;
  const caseInsensitive = input.caseInsensitive ?? false;
  if (roots.length === 0) return fail("at least one workspace root is required");
  if (roots.length > MAX_WORKSPACES) {
    return fail(`at most ${MAX_WORKSPACES} workspace roots are supported`);
  }
  const aliases = new Set<string>();
  const keys = new Set<string>();
  let primaryId: string | undefined;
  for (const root of roots) {
    const shape = validateRootShape(root);
    if (shape) return fail(shape);
    const alias = root.id.toLowerCase();
    if (aliases.has(alias)) return fail(`duplicate workspace alias "${root.id}"`);
    aliases.add(alias);
    if (keys.has(root.key)) return fail(`duplicate workspace root for ${root.id}`);
    keys.add(root.key);
    if (root.primary) {
      if (primaryId) return fail("more than one primary workspace");
      primaryId = root.id;
    }
    const broad = input.broadRootReason?.(root.root);
    if (broad) return fail(`workspace ${root.id} is ${broad}`);
  }
  if (!primaryId) return fail("exactly one primary workspace is required");

  for (let left = 0; left < roots.length; left += 1) {
    for (let right = left + 1; right < roots.length; right += 1) {
      const a = roots[left]!;
      const b = roots[right]!;
      if (isInsideWorkspaceRoot(a.root, b.root, caseInsensitive) ||
          isInsideWorkspaceRoot(b.root, a.root, caseInsensitive)) {
        return fail(
          `workspace roots overlap: ${a.id} (${a.root}) and ${b.id} (${b.root}); nested roots are not supported`,
        );
      }
    }
  }

  if (input.sessionRoot) {
    const primary = roots.find((root) => root.primary);
    const session = normalizeWorkspacePath(input.sessionRoot, caseInsensitive);
    const actual = normalizeWorkspacePath(primary?.root ?? "", caseInsensitive);
    if (!primary || session !== actual) {
      return fail(
        `the primary workspace ${primary?.id ?? "(missing)"} does not match the session root ${input.sessionRoot}`,
      );
    }
  }

  return {
    ok: true,
    value: {
      schemaVersion: WORKSPACE_SET_SCHEMA_VERSION,
      primaryId,
      roots: roots.map((root) => ({ ...root })),
    },
  };
}

interface ResolvedRoot {
  id: string;
  key: string;
  root: string;
  kind: "git" | "plain";
  displayPath: string;
}

async function resolveRoot(
  absolutePath: string,
  resolver: WorkspaceSetResolver,
  caseInsensitive: boolean,
): Promise<WorkspaceSetResult<ResolvedRoot>> {
  const real = await resolver.realpath(absolutePath);
  if (!real) return fail(`workspace does not exist: ${absolutePath}`);
  const stat = await resolver.statKind(real);
  if (stat === null) return fail(`workspace does not exist: ${absolutePath}`);
  if (stat !== "dir") return fail(`workspace is not a directory: ${absolutePath}`);
  const top = await resolver.gitTopLevel(real);
  let root = real;
  if (top) {
    const topReal = (await resolver.realpath(top)) ?? top;
    const topStat = await resolver.statKind(topReal);
    if (topStat !== "dir") {
      return fail(`the git top level is not a directory: ${top}`);
    }
    root = topReal;
  }
  const kind = top ? "git" : "plain";
  return {
    ok: true,
    value: {
      id: "",
      key: canonicalRoot(root, kind, caseInsensitive),
      root,
      kind,
      displayPath: top ?? real,
    },
  };
}

/**
 * Resolve plan declarations (or explicit overrides) to one canonical set.
 * The session root is always primary; a plan that labels it `W` must agree.
 */
export async function resolveWorkspaceSet(
  input: ResolveWorkspaceSetInput,
): Promise<WorkspaceSetResult<WorkspaceSet>> {
  if (!input.primaryRoot || input.primaryRoot.trim().length === 0) {
    return fail("the primary workspace root is required");
  }
  const caseInsensitive = input.caseInsensitive ?? isWindowsPath(input.primaryRoot);
  const primary = await resolveRoot(
    pathRules(input.primaryRoot).resolve(input.primaryRoot),
    input.resolver,
    caseInsensitive,
  );
  if (!primary.ok) return primary;

  const declarations =
    input.overrides && input.overrides.length > 0
      ? input.overrides
      : (input.declarations ?? []);
  if (declarations.length > MAX_WORKSPACES) {
    return fail(`at most ${MAX_WORKSPACES} workspace declarations are supported`);
  }

  const declared: Array<ResolvedRoot & { id: string }> = [];
  for (const declaration of declarations) {
    const id = declaration.id.trim();
    if (!ALIAS.test(id)) {
      return fail(
        `invalid workspace alias "${declaration.id}"${declaration.sourceLine === undefined ? "" : ` at line ${declaration.sourceLine}`}`,
      );
    }
    const rules = pathRules(declaration.path);
    const absolute = rules.isAbsolute(declaration.path)
      ? declaration.path
      : pathRules(input.primaryRoot).resolve(input.primaryRoot, declaration.path);
    const resolved = await resolveRoot(absolute, input.resolver, caseInsensitive);
    if (!resolved.ok) {
      return fail(
        `${resolved.error}${declaration.sourceLine === undefined ? "" : ` (line ${declaration.sourceLine})`}`,
      );
    }
    declared.push({ ...resolved.value, id });
  }

  const primaryMatches = declared.filter((root) => root.key === primary.value.key);
  if (primaryMatches.length > 1) {
    return fail("the session root is declared more than once");
  }
  const declaredW = declared.find(
    (root) => root.id.toLowerCase() === "w" && root.key !== primary.value.key,
  );
  if (declaredW) {
    return fail(
      `the plan declares W at ${declaredW.root}, but this session's workspace is ${primary.value.root}; start from that checkout or pass workspaces explicitly`,
    );
  }

  const primaryId = primaryMatches[0]?.id ?? "W";

  const roots: WorkspaceRoot[] = [
    {
      ...primary.value,
      id: primaryId,
      primary: true,
    },
  ];
  const usedKeys = new Set([primary.value.key]);
  for (const root of declared) {
    if (root.key === primary.value.key) continue;
    if (usedKeys.has(root.key)) {
      return fail(`duplicate workspace root for ${root.id}`);
    }
    usedKeys.add(root.key);
    roots.push({
      id: root.id,
      key: root.key,
      root: root.root,
      kind: root.kind,
      displayPath: root.displayPath,
      primary: false,
    });
  }

  return validateWorkspaceSet({
    roots,
    sessionRoot: primary.value.root,
    caseInsensitive,
    ...(input.broadRootReason === undefined
      ? {}
      : { broadRootReason: input.broadRootReason }),
  });
}

export function workspaceAliasMap(
  set: WorkspaceSet | undefined,
): Map<string, WorkspaceRoot> {
  return new Map(
    (set?.roots ?? []).map((root) => [root.id.toLowerCase(), root]),
  );
}

export function primaryWorkspace(
  set: WorkspaceSet | undefined,
): WorkspaceRoot | undefined {
  if (!set) return undefined;
  return set.roots.find((root) => root.primary) ??
    set.roots.find((root) => root.id === set.primaryId);
}

export function resolveWorkspaceAlias(
  set: WorkspaceSet | undefined,
  alias: string,
): WorkspaceRoot | undefined {
  return workspaceAliasMap(set).get(alias.trim().toLowerCase());
}

export function workspaceRootForRow(
  set: WorkspaceSet | undefined,
  row: RowWorkspaceBinding,
): WorkspaceRoot | undefined {
  if (!set) return undefined;
  const first = row.workspaces?.[0];
  if (first) return resolveWorkspaceAlias(set, first);
  // A row that names no workspace is only unambiguous for a single-root set.
  // With several bound roots the primary root is a guess, so callers must
  // resolve from the observed change (or fail closed) instead of silently
  // running the check in the wrong repository.
  return set.roots.length <= 1 ? primaryWorkspace(set) : undefined;
}
