/**
 * Workflow Extension — workspace identity, cooperative lease and baseline (step 22).
 *
 * Three separate concerns, all pure/ported:
 *   1. identity — one key for cwd aliases, symlinks, worktrees and Windows path
 *      forms, so two sessions cannot think they are in different workspaces;
 *   2. lease — one cooperative mutation holder per workspace. A stale lease is
 *      never silently stolen: TTL expiry requires an explicit reclaim;
 *   3. baseline — bounded tracked/untracked/deleted/binary/mode snapshot and a
 *      comparison that reports EXTERNAL changes for revalidation.
 *
 * Nothing here touches git history or the project `.git`: there is no checkout,
 * reset or clean. Git state arrives through an injected port; non-Git projects
 * get a bounded file listing instead. Dirty user work is preserved and
 * same-file overlap is reported as unsafe for automatic staging.
 */

import { createHash } from "node:crypto";

export const WORKSPACE_SCHEMA_VERSION = 1 as const;
export const DEFAULT_LEASE_TTL_MS = 60_000;
export const DEFAULT_MAX_BASELINE_FILES = 5_000;
export const MAX_PATH_CHARS = 4_000;

export interface WorkspaceResolver {
  /** Resolves symlinks; null for a missing path. */
  realpath(path: string): Promise<string | null>;
  /** Git top level for a cwd, or null for a non-Git folder. */
  gitTopLevel(cwd: string): Promise<string | null>;
  /** Common git dir; worktrees share it. */
  gitCommonDir?(cwd: string): Promise<string | null>;
}

export interface WorkspaceIdentity {
  /** Stable comparison key: `git:<root>` or `plain:<root>`. */
  key: string;
  root: string;
  kind: "git" | "plain";
  commonDir?: string;
  displayPath: string;
}

export type WorkspaceResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

function normalizePath(value: string, caseInsensitive: boolean): string {
  let path = value.trim();
  if (path.startsWith("\\\\?\\UNC\\")) path = `\\\\${path.slice(8)}`;
  else if (path.startsWith("\\\\?\\")) path = path.slice(4);
  path = path.replace(/\\/g, "/");
  // Collapse duplicate separators, but keep the UNC `//server/share` prefix.
  const unc = path.startsWith("//");
  path = path.replace(/\/{2,}/g, "/");
  if (unc && !path.startsWith("//")) path = `/${path}`;
  if (path.length > 1) path = path.replace(/\/+$/, "");
  if (caseInsensitive) path = path.toLowerCase();
  return path;
}

/** True for a Windows-style path (drive letter or UNC). */
export function isWindowsPath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\");
}

export async function resolveWorkspaceIdentity(input: {
  cwd: string;
  resolver: WorkspaceResolver;
  caseInsensitive?: boolean;
}): Promise<WorkspaceResult<WorkspaceIdentity>> {
  if (!input.cwd || input.cwd.trim().length === 0) {
    return { ok: false, error: "cwd is required" };
  }
  const real = await input.resolver.realpath(input.cwd);
  if (!real) return { ok: false, error: `workspace does not exist: ${input.cwd}` };
  const caseInsensitive = input.caseInsensitive ?? isWindowsPath(real);
  const top = await input.resolver.gitTopLevel(input.cwd);
  if (top) {
    const root = normalizePath(top, caseInsensitive);
    const common = input.resolver.gitCommonDir
      ? await input.resolver.gitCommonDir(input.cwd)
      : null;
    return {
      ok: true,
      value: {
        key: `git:${root}`,
        root,
        kind: "git",
        ...(common ? { commonDir: normalizePath(common, caseInsensitive) } : {}),
        displayPath: top,
      },
    };
  }
  const root = normalizePath(real, caseInsensitive);
  return {
    ok: true,
    value: { key: `plain:${root}`, root, kind: "plain", displayPath: real },
  };
}

// ── Cooperative lease ────────────────────────────────────────────────

export interface LeaseGrant {
  workspaceKey: string;
  runId: string;
  taskId: string;
  attemptId: string;
  sessionId: string;
  generation: number;
  acquiredAt: number;
  expiresAt: number;
}

export type LeaseCode =
  | "held"
  | "expired"
  | "stale_generation"
  | "invalid"
  | "confirmation"
  | "not_holder";

export type LeaseResult =
  | { ok: true; grant: LeaseGrant }
  | { ok: false; code: LeaseCode; error: string; holder?: LeaseGrant };

function sameHolder(grant: LeaseGrant, other: Partial<LeaseGrant>): boolean {
  return (
    grant.runId === other.runId &&
    grant.taskId === other.taskId &&
    grant.attemptId === other.attemptId &&
    grant.sessionId === other.sessionId &&
    grant.generation === other.generation
  );
}

export interface WorkspaceLeases {
  acquire(input: Omit<LeaseGrant, "acquiredAt" | "expiresAt">): LeaseResult;
  renew(grant: LeaseGrant): LeaseResult;
  release(grant: LeaseGrant): { ok: true } | { ok: false; code: LeaseCode; error: string };
  holder(workspaceKey: string): LeaseGrant | undefined;
  isWriter(grant: LeaseGrant): boolean;
  /** Explicit recovery of an expired lease; never implicit. */
  reclaim(input: {
    workspaceKey: string;
    grant: Omit<LeaseGrant, "acquiredAt" | "expiresAt">;
    confirmation: string;
  }): LeaseResult;
  /**
   * Durably reserves the next workspace-wide fencing token. Task/attempt
   * counters must never be used as this number: a second task would otherwise
   * propose generation 1 again.
   */
  nextGeneration?(workspaceKey: string): number;
}

export function createWorkspaceLeases(options: {
  ttlMs?: number;
  now?: () => number;
} = {}): WorkspaceLeases {
  const ttlMs = options.ttlMs ?? DEFAULT_LEASE_TTL_MS;
  const now = options.now ?? (() => Date.now());
  const holders = new Map<string, LeaseGrant>();
  const generations = new Map<string, number>();
  const reserved = new Map<string, number>();

  const expired = (grant: LeaseGrant): boolean => grant.expiresAt <= now();
  const tokenAllowed = (workspaceKey: string, token: number): boolean => {
    const last = generations.get(workspaceKey) ?? 0;
    const pending = reserved.get(workspaceKey) ?? 0;
    if (token > Math.max(last, pending)) return true;
    return token === pending && token > last;
  };

  const leases: WorkspaceLeases = {
    acquire(input) {
      if (
        !input.workspaceKey ||
        !input.runId ||
        !input.taskId ||
        !input.attemptId ||
        !input.sessionId ||
        !Number.isInteger(input.generation) ||
        input.generation < 1
      ) {
        return { ok: false, code: "invalid", error: "lease identity is incomplete" };
      }
      const current = holders.get(input.workspaceKey);
      if (current) {
        if (!expired(current)) {
          if (sameHolder(current, input)) return { ok: true, grant: { ...current } };
          return {
            ok: false,
            code: "held",
            error: `workspace is held by ${current.taskId}/${current.attemptId}`,
            holder: { ...current },
          };
        }
        // Expired but not released: the old writer may still be alive, so only
        // an explicit reclaim may take it.
        return {
          ok: false,
          code: "expired",
          error: "the previous lease expired without release; reclaim it explicitly",
          holder: { ...current },
        };
      }
      const last = generations.get(input.workspaceKey) ?? 0;
      if (!tokenAllowed(input.workspaceKey, input.generation)) {
        return { ok: false, code: "stale_generation", error: `generation must exceed ${last}` };
      }
      const grant: LeaseGrant = {
        ...input,
        acquiredAt: now(),
        expiresAt: now() + ttlMs,
      };
      holders.set(input.workspaceKey, grant);
      generations.set(input.workspaceKey, input.generation);
      reserved.delete(input.workspaceKey);
      return { ok: true, grant: { ...grant } };
    },

    renew(grant) {
      const current = holders.get(grant.workspaceKey);
      if (!current || !sameHolder(current, grant)) {
        return { ok: false, code: "not_holder", error: "the lease is not held by this attempt" };
      }
      if (expired(current)) {
        return { ok: false, code: "expired", error: "the lease expired; reclaim it explicitly" };
      }
      const next: LeaseGrant = { ...current, expiresAt: now() + ttlMs };
      holders.set(grant.workspaceKey, next);
      return { ok: true, grant: { ...next } };
    },

    release(grant) {
      const current = holders.get(grant.workspaceKey);
      if (!current || !sameHolder(current, grant)) {
        return { ok: false, code: "not_holder", error: "the lease is not held by this attempt" };
      }
      holders.delete(grant.workspaceKey);
      return { ok: true };
    },

    holder(workspaceKey) {
      const current = holders.get(workspaceKey);
      return current ? { ...current } : undefined;
    },

    isWriter(grant) {
      const current = holders.get(grant.workspaceKey);
      return !!current && !expired(current) && sameHolder(current, grant);
    },

    reclaim(input) {
      if (input.confirmation !== "reclaim-stale") {
        return {
          ok: false,
          code: "confirmation",
          error: "reclaiming a lease needs an explicit confirmation",
        };
      }
      const current = holders.get(input.workspaceKey);
      if (current && !expired(current)) {
        return { ok: false, code: "held", error: "the lease is still live", holder: { ...current } };
      }
      const last = generations.get(input.workspaceKey) ?? 0;
      if (!tokenAllowed(input.workspaceKey, input.grant.generation)) {
        return { ok: false, code: "stale_generation", error: `generation must exceed ${last}` };
      }
      const grant: LeaseGrant = {
        ...input.grant,
        acquiredAt: now(),
        expiresAt: now() + ttlMs,
      };
      holders.set(input.workspaceKey, grant);
      generations.set(input.workspaceKey, input.grant.generation);
      reserved.delete(input.workspaceKey);
      return { ok: true, grant: { ...grant } };
    },

    nextGeneration(workspaceKey) {
      const last = generations.get(workspaceKey) ?? 0;
      const pending = reserved.get(workspaceKey) ?? 0;
      const next = Math.max(last, pending) + 1;
      reserved.set(workspaceKey, next);
      return next;
    },
  };
  return leases;
}

// ── Baseline ─────────────────────────────────────────────────────────

export type BaselineStatus =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "untracked"
  | "binary"
  | "mode";

export interface BaselineChange {
  path: string;
  status: BaselineStatus;
  staged: boolean;
  mode?: string;
  size?: number;
  /**
   * Content identity of this observation, when the port could read it.
   * Status/size alone cannot detect a same-length edit to an already-dirty
   * file; acceptance requires this to be present for every non-deleted change.
   */
  contentDigest?: string;
}

export interface GitStatusSnapshot {
  head?: string;
  branch?: string;
  changes: BaselineChange[];
}

/** Injected: no git executable is invoked by this module. */
export interface BaselinePort {
  gitStatus(root: string): Promise<GitStatusSnapshot | null>;
  /** Bounded non-Git listing; null when unsupported. */
  listFiles(root: string, limit: number): Promise<{ files: Array<{ path: string; size: number | null }>; truncated: boolean } | null>;
  /**
   * Bounded content digest for one changed path. Returning null means the
   * content could not be observed (too large, unreadable, excluded); that is
   * reported as incomplete coverage instead of "unchanged".
   */
  contentDigest?(root: string, path: string): Promise<string | null>;
}

export interface WorkspaceBaseline {
  schemaVersion: typeof WORKSPACE_SCHEMA_VERSION;
  workspaceKey: string;
  root: string;
  kind: "git" | "plain";
  capturedAt: number;
  head?: string;
  branch?: string;
  changes: BaselineChange[];
  counts: { staged: number; unstaged: number; untracked: number; deleted: number; binary: number };
  truncated: boolean;
  /** Digest of the bounded content, not of the clock. */
  digest: string;
  /**
   * True when every non-deleted observation carries a content digest. Absent
   * when the port cannot hash content at all (metadata-only capture).
   */
  contentComplete?: boolean;
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
    .join(",")}}`;
}

function sha256(value: unknown): string {
  return createHash("sha256").update(canonical(value), "utf8").digest("hex");
}

function sanitizeChanges(
  changes: readonly BaselineChange[],
  limit: number,
): { changes: BaselineChange[]; truncated: boolean } {
  const seen = new Set<string>();
  const out: BaselineChange[] = [];
  for (const change of changes) {
    if (typeof change.path !== "string" || change.path.length === 0) continue;
    if (change.path.length > MAX_PATH_CHARS) continue;
    const key = `${change.staged ? "s" : "u"}\u0000${change.status}\u0000${change.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      path: change.path.replace(/\\/g, "/"),
      status: change.status,
      staged: change.staged === true,
      ...(change.mode ? { mode: change.mode } : {}),
      ...(typeof change.size === "number" ? { size: change.size } : {}),
    });
    if (out.length >= limit) return { changes: out, truncated: true };
  }
  out.sort(
    (left, right) =>
      left.path.localeCompare(right.path) ||
      Number(left.staged) - Number(right.staged) ||
      left.status.localeCompare(right.status),
  );
  return { changes: out, truncated: false };
}

export async function captureBaseline(input: {
  workspace: WorkspaceIdentity;
  port: BaselinePort;
  now: number;
  maxFiles?: number;
}): Promise<WorkspaceResult<WorkspaceBaseline>> {
  const limit = Math.max(1, Math.floor(input.maxFiles ?? DEFAULT_MAX_BASELINE_FILES));
  const git = await input.port.gitStatus(input.workspace.root);
  let changes: BaselineChange[] = [];
  let truncated = false;
  let head: string | undefined;
  let branch: string | undefined;

  if (git) {
    head = git.head;
    branch = git.branch;
    const bounded = sanitizeChanges(git.changes, limit);
    changes = bounded.changes;
    truncated = bounded.truncated;
  } else {
    const listing = await input.port.listFiles(input.workspace.root, limit);
    if (!listing) return { ok: false, error: "no baseline source is available" };
    changes = sanitizeChanges(
      listing.files.map((file) => ({
        path: file.path,
        status: "untracked" as const,
        staged: false,
        ...(file.size === null ? {} : { size: file.size }),
      })),
      limit,
    ).changes;
    truncated = listing.truncated;
  }

  // Content identity, not just status/size. One observation per (path, staged,
  // status) pair; a path changed in both index and worktree is two entries.
  let contentComplete: boolean | undefined;
  if (input.port.contentDigest) {
    const hasher = input.port.contentDigest.bind(input.port);
    const digests = new Map<string, string | null>();
    contentComplete = true;
    for (const change of changes) {
      if (change.status === "deleted") continue;
      let observed: string | null;
      if (digests.has(change.path)) observed = digests.get(change.path) ?? null;
      else {
        try {
          observed = await hasher(input.workspace.root, change.path);
        } catch {
          observed = null;
        }
        digests.set(change.path, observed);
      }
      if (observed) change.contentDigest = observed;
      else contentComplete = false;
    }
  }

  const counts = {
    staged: changes.filter((change) => change.staged).length,
    unstaged: changes.filter((change) => !change.staged).length,
    untracked: changes.filter((change) => change.status === "untracked").length,
    deleted: changes.filter((change) => change.status === "deleted").length,
    binary: changes.filter((change) => change.status === "binary").length,
  };
  const content = {
    workspaceKey: input.workspace.key,
    kind: input.workspace.kind,
    head,
    branch,
    changes,
    truncated,
  };
  return {
    ok: true,
    value: {
      schemaVersion: WORKSPACE_SCHEMA_VERSION,
      workspaceKey: input.workspace.key,
      root: input.workspace.root,
      kind: input.workspace.kind,
      capturedAt: input.now,
      ...(head ? { head } : {}),
      ...(branch ? { branch } : {}),
      changes,
      counts,
      truncated,
      ...(contentComplete === undefined ? {} : { contentComplete }),
      digest: sha256(content),
    },
  };
}

export interface BaselineComparison {
  unchanged: boolean;
  /** Paths that changed since the baseline (external mutation). */
  externalChanges: string[];
  requiresRevalidation: boolean;
  /** The baseline already had user work on a path this task expects to change. */
  attributionConflicts: string[];
}

export function compareBaseline(
  previous: WorkspaceBaseline,
  current: WorkspaceBaseline,
  options: { expectedPaths?: readonly string[] } = {},
): BaselineComparison {
  const key = (change: BaselineChange) =>
    `${change.staged ? "s" : "u"}\u0000${change.status}\u0000${change.path}\u0000${
      change.mode ?? ""
    }\u0000${change.size ?? ""}\u0000${change.contentDigest ?? ""}`;
  const before = new Map(previous.changes.map((change) => [key(change), change]));
  const after = new Set(current.changes.map(key));
  const external: string[] = [];
  for (const change of current.changes) {
    if (!before.has(key(change))) external.push(change.path);
  }
  for (const change of previous.changes) {
    if (!after.has(key(change))) external.push(change.path);
  }
  const expected = new Set(
    (options.expectedPaths ?? []).map((path) => path.replace(/\\/g, "/")),
  );
  const attributionConflicts = previous.changes
    .filter((change) => expected.has(change.path))
    .map((change) => change.path);
  return {
    unchanged: external.length === 0,
    externalChanges: [...new Set(external)].sort(),
    requiresRevalidation: external.length > 0,
    attributionConflicts: [...new Set(attributionConflicts)].sort(),
  };
}
