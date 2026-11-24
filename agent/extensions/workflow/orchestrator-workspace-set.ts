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

import { createHash } from "node:crypto";
import * as path from "node:path";

import {
  captureBaseline,
  diffSinceBaseline,
  isWindowsPath,
  type BaselineDiff,
  type BaselinePort,
  type WorkspaceBaseline,
} from "./orchestrator-workspace.ts";
export interface RowWorkspaceBinding {
  workspaces?: readonly string[];
}

export const WORKSPACE_SET_SCHEMA_VERSION = 1 as const;
export const MAX_WORKSPACES = 8;
export const MAX_ALIAS_CHARS = 24;

const ALIAS = /^[A-Za-z][A-Za-z0-9_-]{0,23}$/;
const HEADING = /^(#{1,6})\s+(.+?)\s*$/;
const BULLET = /^\s*[-*+]\s+(.+?)\s*$/;
const LABEL = /^repositories(?:\s+and\s+baseline)?\s*:\s*$/i;
const SECTION = /^(workspaces?|repositories?)$/i;
const BACKTICK = /`([^`]+)`/;
const BOLD_LABEL = /^\*\*(.+?)\*\*(.*)$/;

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

function parseAliasBold(bold: string): string | undefined {
  const trimmed = bold.trim();
  if (!trimmed) return undefined;
  const dashed = /^(.+?)\s+[—–-]\s+.+$/.exec(trimmed);
  const candidate = (dashed?.[1] ?? trimmed).replace(/:\s*$/, "").trim();
  return ALIAS.test(candidate) ? candidate : undefined;
}

function parseDeclarationBullet(
  line: string,
  sourceLine: number,
): WorkspaceDeclaration | undefined {
  const bullet = BULLET.exec(line);
  if (!bullet) return undefined;
  const body = bullet[1]!;
  let alias: string | undefined;
  const bold = BOLD_LABEL.exec(body);
  if (bold) {
    alias = parseAliasBold(bold[1]!);
  } else {
    const plain = /^([A-Za-z][A-Za-z0-9_-]{0,23})\s*:\s*(.*)$/.exec(body);
    if (plain) alias = plain[1];
  }
  if (!alias) return undefined;
  const token = BACKTICK.exec(body);
  if (!token) return undefined;
  const declaredPath = token[1]!.trim();
  if (!declaredPath) return undefined;
  return { id: alias, path: declaredPath, sourceLine };
}

/**
 * Parse only the conservative plan conventions. Fenced examples are ignored;
 * a declaration requires a valid short alias AND a backticked path, so
 * informational bullets (for example an SDK note) never become roots.
 */
export function parseWorkspaceDeclarations(markdown: string): WorkspaceDeclaration[] {
  if (typeof markdown !== "string" || markdown.trim().length === 0) return [];
  const lines = markdown.split(/\r?\n/);
  const out: WorkspaceDeclaration[] = [];
  const seen = new Set<string>();
  let fence: string | undefined;
  let section = false;
  let repositoryBlock = false;
  const push = (declaration: WorkspaceDeclaration | undefined): void => {
    if (!declaration) return;
    const key = `${declaration.id.toLowerCase()}\u0000${declaration.path}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(declaration);
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const trimmed = line.trim();
    const fenceMatch = /^(```|~~~)/.exec(trimmed);
    if (fenceMatch) {
      const marker = fenceMatch[1]!;
      fence = fence === undefined ? marker : fence === marker ? undefined : fence;
      continue;
    }
    if (fence !== undefined) continue;

    const heading = HEADING.exec(line);
    if (heading) {
      const level = heading[1]!.length;
      const title = heading[2]!.trim();
      section = level === 2 && SECTION.test(title);
      repositoryBlock = false;
      continue;
    }

    if (LABEL.test(trimmed)) {
      repositoryBlock = true;
      continue;
    }
    if (repositoryBlock) {
      if (trimmed.length === 0) continue;
      const declaration = parseDeclarationBullet(line, index + 1);
      if (declaration) {
        push(declaration);
        continue;
      }
      repositoryBlock = false;
      continue;
    }
    if (section) {
      push(parseDeclarationBullet(line, index + 1));
    }
  }
  return out;
}

function fail<T>(error: string): WorkspaceSetResult<T> {
  return { ok: false, error };
}

function validateRootShape(root: WorkspaceRoot): string | undefined {
  if (!ALIAS.test(root.id)) return `invalid workspace alias "${root.id}"`;
  if (!root.root || !path.isAbsolute(root.root)) {
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
    path.resolve(input.primaryRoot),
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
    const absolute = path.isAbsolute(declaration.path)
      ? declaration.path
      : path.resolve(input.primaryRoot, declaration.path);
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

// ── Per-root baselines, diffs and attribution ───────────────────────

export interface WorkspaceSetBaselineEntry {
  workspaceId: string;
  baseline: WorkspaceBaseline;
}

export interface WorkspaceSetBaseline {
  capturedAt: number;
  entries: WorkspaceSetBaselineEntry[];
}

export interface WorkspaceSetDiffEntry {
  workspaceId: string;
  root: string;
  diff: BaselineDiff;
}

export interface WorkspaceSetDiff {
  changed: boolean;
  entries: WorkspaceSetDiffEntry[];
  committedPaths: string[];
  dirtyPaths: string[];
  attributionConflicts: string[];
  workspaceRevision: string;
}

function selectedRoots(
  set: WorkspaceSet,
  workspaceIds: readonly string[] | undefined,
): WorkspaceSetResult<WorkspaceRoot[]> {
  if (!workspaceIds || workspaceIds.length === 0) return { ok: true, value: [...set.roots] };
  const byAlias = workspaceAliasMap(set);
  const selected: WorkspaceRoot[] = [];
  const seen = new Set<string>();
  for (const id of workspaceIds) {
    const root = byAlias.get(id.trim().toLowerCase());
    if (!root) return fail(`unknown workspace "${id}"`);
    if (seen.has(root.id)) continue;
    seen.add(root.id);
    selected.push(root);
  }
  return selected.length > 0
    ? { ok: true, value: selected }
    : fail("at least one workspace is required");
}

export async function captureWorkspaceSetBaseline(input: {
  set: WorkspaceSet;
  port: BaselinePort;
  now: number;
  workspaceIds?: readonly string[];
  maxFiles?: number;
}): Promise<WorkspaceSetResult<WorkspaceSetBaseline>> {
  const selected = selectedRoots(input.set, input.workspaceIds);
  if (!selected.ok) return selected;
  const entries: WorkspaceSetBaselineEntry[] = [];
  for (const root of selected.value) {
    let captured: Awaited<ReturnType<typeof captureBaseline>>;
    try {
      captured = await captureBaseline({
        workspace: {
          key: root.key,
          root: root.root,
          kind: root.kind,
          displayPath: root.displayPath,
        },
        port: input.port,
        now: input.now,
        ...(input.maxFiles === undefined ? {} : { maxFiles: input.maxFiles }),
      });
    } catch (error: unknown) {
      return fail(
        `workspace ${root.id} (${root.root}): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    if (!captured.ok) {
      return fail(`workspace ${root.id} (${root.root}): ${captured.error}`);
    }
    entries.push({ workspaceId: root.id, baseline: captured.value });
  }
  return { ok: true, value: { capturedAt: input.now, entries } };
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

export function diffWorkspaceSet(
  previous: WorkspaceSetBaseline,
  current: WorkspaceSetBaseline,
  options: {
    gitDiffPathsByWorkspace?: Readonly<Record<string, readonly string[]>>;
    expectedPathsByWorkspace?: Readonly<Record<string, readonly string[]>>;
    caseInsensitive?: boolean;
  } = {},
): WorkspaceSetResult<WorkspaceSetDiff> {
  const currentById = new Map(
    current.entries.map((entry) => [entry.workspaceId.toLowerCase(), entry]),
  );
  if (currentById.size !== previous.entries.length) {
    return fail("the current workspace baseline does not match the attempt baseline");
  }
  const entries: WorkspaceSetDiffEntry[] = [];
  for (const before of previous.entries) {
    const after = currentById.get(before.workspaceId.toLowerCase());
    if (!after) {
      return fail(`workspace ${before.workspaceId} is missing from the current baseline`);
    }
    const diff = diffSinceBaseline(before.baseline, after.baseline, {
      ...(options.expectedPathsByWorkspace?.[before.workspaceId] === undefined
        ? {}
        : { expectedPaths: options.expectedPathsByWorkspace[before.workspaceId] }),
      ...(options.gitDiffPathsByWorkspace?.[before.workspaceId] === undefined
        ? {}
        : { gitDiffPaths: options.gitDiffPathsByWorkspace[before.workspaceId] }),
    });
    entries.push({
      workspaceId: before.workspaceId,
      root: after.baseline.root,
      diff,
    });
  }
  const revisionPayload = entries
    .map((entry) => `${entry.workspaceId}:${entry.diff.workspaceRevision}`)
    .sort()
    .join("\n");
  return {
    ok: true,
    value: {
      changed: entries.some((entry) => entry.diff.changed),
      entries,
      committedPaths: uniqueSorted(entries.flatMap((entry) => entry.diff.committedPaths)),
      dirtyPaths: uniqueSorted(entries.flatMap((entry) => entry.diff.dirtyPaths)),
      attributionConflicts: uniqueSorted(
        entries.flatMap((entry) => entry.diff.attributionConflicts),
      ),
      workspaceRevision: createHash("sha256").update(revisionPayload, "utf8").digest("hex"),
    },
  };
}

function normalizeFactPath(value: string, caseInsensitive: boolean): string {
  const normalized = value.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  return caseInsensitive ? normalized.toLowerCase() : normalized;
}

function sameWorkspacePath(
  fact: string,
  expected: string,
  caseInsensitive: boolean,
): boolean {
  const normalizedFact = normalizeFactPath(fact, caseInsensitive);
  const normalizedExpected = normalizeFactPath(expected, caseInsensitive);
  if (!normalizedExpected) return false;
  if (normalizedFact === normalizedExpected) return true;
  if (normalizedExpected.startsWith("*")) {
    return normalizedFact.endsWith(normalizedExpected.slice(1));
  }
  return normalizedFact.endsWith(`/${normalizedExpected}`);
}

function expectedForRoot(
  expectedFiles: readonly string[],
  root: string,
): string[] {
  const out: string[] = [];
  for (const expected of expectedFiles) {
    const normalized = expected.trim().replace(/\\/g, "/");
    if (!normalized) continue;
    if (path.isAbsolute(normalized)) {
      const relative = path.relative(root, normalized).replace(/\\/g, "/");
      if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) continue;
      out.push(relative);
      continue;
    }
    out.push(normalized);
  }
  return out;
}

export function hasAttributableChangeInSet(
  diff: WorkspaceSetDiff,
  workspaceIds: readonly string[] = [],
  expectedFiles: readonly string[] = [],
  caseInsensitive = false,
): boolean {
  const allowed = new Set(
    workspaceIds.length === 0
      ? diff.entries.map((entry) => entry.workspaceId.toLowerCase())
      : workspaceIds.map((id) => id.trim().toLowerCase()),
  );
  const entries = diff.entries.filter((entry) =>
    allowed.has(entry.workspaceId.toLowerCase()),
  );
  if (entries.length === 0) return false;
  if (expectedFiles.length === 0) return entries.some((entry) => entry.diff.changed);
  for (const entry of entries) {
    const expected = expectedForRoot(expectedFiles, entry.root);
    if (expected.length === 0) continue;
    const matches = (paths: readonly string[]): boolean =>
      paths.some((fact) =>
        expected.some((want) => sameWorkspacePath(fact, want, caseInsensitive)),
      );
    if (matches(entry.diff.committedPaths) || matches(entry.diff.dirtyPaths)) {
      return true;
    }
  }
  return false;
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

export function workspaceCheckRoot(
  set: WorkspaceSet | undefined,
  row: RowWorkspaceBinding,
  diff: WorkspaceSetDiff | undefined,
): string | undefined {
  const explicit = row.workspaces?.[0];
  if (explicit) return resolveWorkspaceAlias(set, explicit)?.root;
  const changed = diff?.entries.filter((entry) => entry.diff.changed) ?? [];
  if (changed.length === 1) return changed[0]!.root;
  // Several changed roots (or none) are ambiguous: no primary-root default.
  return undefined;
}

export function scopeCommandToWorkspace(command: string, root?: string): string {
  if (!root || !root.trim()) return command;
  const quoted = root.replace(/\\/g, "/").replace(/'/g, "'\\''");
  return `cd -- '${quoted}' && ${command}`;
}

