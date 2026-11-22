/**
 * Workflow Extension — production Node adapters (integration step 8).
 *
 * The orchestration decision modules are pure. This module supplies the real
 * effects they need, behind the same small contracts the tests already use:
 *
 *   - `JournalIo` over a real append-only journal with an exclusive writer lock;
 *   - a `FsPort` for run artifacts;
 *   - cross-PROCESS workspace leases (a shared lock directory), not the
 *     process-local Map — two Pi sessions in different windows must agree on
 *     who owns a workspace;
 *   - a git-backed `BaselinePort` for real dirty/staged/untracked/binary state;
 *   - clock/host ports for the parent runtime.
 *
 * Everything is injected: no module here reads `process.cwd()` or the user's
 * real agent directory on its own. Failures are values (`{ok:false}` /
 * rejection with a reason), never a silent "probably fine".
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import type { JournalIo } from "./orchestrator-store.ts";
import type { FsPort, FsStat, HostPort, ClockPort } from "./ports.ts";
import type {
  BaselineChange,
  BaselinePort,
  LeaseGrant,
  WorkspaceLeases,
} from "./orchestrator-workspace.ts";

// ── Clock ────────────────────────────────────────────────────────────

export function createNodeClock(): ClockPort {
  return {
    now: () => Date.now(),
    setTimeout: (callback, ms) => setTimeout(callback, ms),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
}

// ── Journal I/O ──────────────────────────────────────────────────────

const LOCK_OWNER_FILE = "owner.json";

/**
 * Journal I/O for one run directory.
 *
 * - `writeAtomic` writes a sibling temp file then renames it, so a torn process
 *   never leaves a half-written snapshot in place;
 * - `append` uses a single `appendFileSync` with `O_APPEND` semantics;
 * - `acquireLock` is `wx` (exclusive create) and records pid+time, so two
 *   processes cannot both believe they are the writer;
 * - a stale lock is NOT stolen here: `createRunJournal` decides, so the
 *   decision stays in one place.
 */
export function createNodeJournalIo(): JournalIo {
  return {
    async read(filePath) {
      try {
        return fs.readFileSync(filePath, "utf8");
      } catch {
        return null;
      }
    },
    async writeAtomic(filePath, data) {
      const dir = path.dirname(filePath);
      fs.mkdirSync(dir, { recursive: true });
      const tmp = path.join(
        dir,
        `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`,
      );
      fs.writeFileSync(tmp, data, "utf8");
      fs.renameSync(tmp, filePath);
    },
    async append(filePath, data) {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.appendFileSync(filePath, data, "utf8");
    },
    async list(dir) {
      try {
        return fs.readdirSync(dir);
      } catch {
        return [];
      }
    },
    async mkdir(dir) {
      fs.mkdirSync(dir, { recursive: true });
    },
    async remove(filePath) {
      fs.rmSync(filePath, { recursive: true, force: true });
    },
    async acquireLock(lockPath) {
      const dir = path.dirname(lockPath);
      try {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(
          lockPath,
          JSON.stringify({ pid: process.pid, at: Date.now() }),
          { flag: "wx" },
        );
        return true;
      } catch {
        return false;
      }
    },
    async releaseLock(lockPath) {
      try {
        const owner = JSON.parse(fs.readFileSync(lockPath, "utf8")) as {
          pid?: number;
        };
        // Only the process that took the lock may release it.
        if (owner.pid !== undefined && owner.pid !== process.pid) return;
      } catch {
        /* an unreadable lock is removed below */
      }
      fs.rmSync(lockPath, { force: true });
    },
  };
}

/** Owner metadata written next to a journal lock (diagnostics, not authority). */
export function writeLockOwner(lockDir: string, data: Record<string, unknown>): void {
  fs.mkdirSync(lockDir, { recursive: true });
  fs.writeFileSync(
    path.join(lockDir, LOCK_OWNER_FILE),
    JSON.stringify({ ...data, pid: process.pid, at: Date.now() }),
    "utf8",
  );
}

// ── Artifact filesystem port ─────────────────────────────────────────

export function createNodeFsPort(): FsPort {
  const statOf = (target: string): FsStat | undefined => {
    try {
      const s = fs.statSync(target);
      return {
        kind: s.isFile() ? "file" : s.isDirectory() ? "directory" : "other",
        size: s.size,
        mtimeMs: s.mtimeMs,
      };
    } catch {
      return undefined;
    }
  };
  return {
    async readFileText(filePath, options) {
      try {
        return fs.readFileSync(filePath, "utf8");
      } catch (error) {
        if (options?.missingOk) return undefined;
        throw error;
      }
    },
    async writeFileAtomic(filePath, text, options) {
      const dir = path.dirname(filePath);
      if (options?.mkdirp !== false) fs.mkdirSync(dir, { recursive: true });
      const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.tmp`);
      fs.writeFileSync(tmp, text, "utf8");
      fs.renameSync(tmp, filePath);
    },
    async mkdirp(dir) {
      fs.mkdirSync(dir, { recursive: true });
    },
    async stat(filePath) {
      return statOf(filePath);
    },
    async readdir(dir) {
      try {
        return fs.readdirSync(dir, { withFileTypes: true }).map((entry) => ({
          name: entry.name,
          kind: entry.isFile() ? "file" : entry.isDirectory() ? "directory" : "other",
        }));
      } catch {
        return [];
      }
    },
    async remove(filePath, options) {
      fs.rmSync(filePath, { recursive: options?.recursive === true, force: true });
    },
    async rename(from, to) {
      try {
        fs.renameSync(from, to);
        return { ok: true };
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
    async ensureDir(dir) {
      fs.mkdirSync(dir, { recursive: true });
    },
  };
}

// ── Cross-process workspace leases ───────────────────────────────────

interface LeaseFile {
  version: 1;
  workspaceKey: string;
  runId: string;
  taskId: string;
  attemptId: string;
  sessionId: string;
  generation: number;
  acquiredAt: number;
  expiresAt: number;
  pid: number;
  holder: string;
}

function leaseDirFor(root: string, workspaceKey: string): string {
  const digest = createHash("sha256").update(workspaceKey).digest("hex").slice(0, 24);
  return path.join(root, "leases", digest);
}

function readLease(dir: string): LeaseFile | undefined {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, "lease.json"), "utf8"));
    if (!raw || raw.version !== 1) return undefined;
    if (typeof raw.generation !== "number" || typeof raw.expiresAt !== "number") {
      return undefined;
    }
    return raw as LeaseFile;
  } catch {
    return undefined;
  }
}

function generationState(dir: string): { generation: number; reserved: number } {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, "generation.json"), "utf8"));
    return {
      generation: typeof raw.generation === "number" ? raw.generation : 0,
      reserved: typeof raw.reserved === "number" ? raw.reserved : 0,
    };
  } catch {
    return { generation: 0, reserved: 0 };
  }
}

function generationOf(dir: string): number {
  const state = generationState(dir);
  return Math.max(state.generation, state.reserved);
}

function writeGeneration(dir: string, generation: number, reserved = 0): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "generation.json"),
    JSON.stringify({ generation, reserved }),
    "utf8",
  );
}

/**
 * A token is valid when it is above the high-water mark, or when it is the
 * token this process reserved with `nextGeneration` and nobody consumed it.
 * Once consumed (or released), `reserved` resets, so replaying the same token
 * is stale rather than a second writer.
 */
function tokenAllowed(dir: string, token: number): boolean {
  const state = generationState(dir);
  const last = Math.max(state.generation, state.reserved);
  if (token > last) return true;
  return token === state.reserved && token > state.generation;
}

const sameHolder = (
  a: Pick<LeaseGrant, "workspaceKey" | "runId" | "taskId" | "attemptId" | "sessionId" | "generation">,
  b: Pick<LeaseGrant, "workspaceKey" | "runId" | "taskId" | "attemptId" | "sessionId" | "generation">,
): boolean =>
  a.workspaceKey === b.workspaceKey &&
  a.runId === b.runId &&
  a.taskId === b.taskId &&
  a.attemptId === b.attemptId &&
  a.sessionId === b.sessionId &&
  a.generation === b.generation;

/**
 * Shared leases for one agent profile.
 *
 * The lock is the exclusive creation of `lease.json`; the generation file keeps
 * the high-water mark so a stale holder can never reclaim with an old number.
 * An expired lease is still `expired` (not free) until an explicit
 * `reclaim-stale` — the previous writer may be alive but paused.
 */
export function createFileWorkspaceLeases(options: {
  root: string;
  ttlMs?: number;
  now?: () => number;
}): WorkspaceLeases {
  const ttlMs = options.ttlMs ?? 15 * 60_000;
  const now = options.now ?? (() => Date.now());

  const holder = (workspaceKey: string): LeaseGrant | undefined => {
    const file = readLease(leaseDirFor(options.root, workspaceKey));
    if (!file) return undefined;
    return {
      workspaceKey: file.workspaceKey,
      runId: file.runId,
      taskId: file.taskId,
      attemptId: file.attemptId,
      sessionId: file.sessionId,
      generation: file.generation,
      acquiredAt: file.acquiredAt,
      expiresAt: file.expiresAt,
    };
  };

  const expired = (grant: LeaseGrant): boolean => grant.expiresAt <= now();

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
      const dir = leaseDirFor(options.root, input.workspaceKey);
      fs.mkdirSync(dir, { recursive: true });
      const current = holder(input.workspaceKey);
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
        return {
          ok: false,
          code: "expired",
          error: "the previous lease expired without release; reclaim it explicitly",
          holder: { ...current },
        };
      }
      const last = generationOf(dir);
      if (!tokenAllowed(dir, input.generation)) {
        return {
          ok: false,
          code: "stale_generation",
          error: `generation must exceed ${last}`,
        };
      }
      const grant: LeaseGrant = {
        ...input,
        acquiredAt: now(),
        expiresAt: now() + ttlMs,
      };
      const file: LeaseFile = {
        version: 1,
        ...grant,
        pid: process.pid,
        holder: `${process.pid}:${input.sessionId}`,
      };
      try {
        fs.writeFileSync(path.join(dir, "lease.json"), JSON.stringify(file), {
          flag: "wx",
        });
      } catch {
        return {
          ok: false,
          code: "held",
          error: "another process took the workspace lease first",
        };
      }
      writeGeneration(dir, grant.generation);
      return { ok: true, grant: { ...grant } };
    },

    renew(grant) {
      const dir = leaseDirFor(options.root, grant.workspaceKey);
      const current = holder(grant.workspaceKey);
      if (!current || !sameHolder(current, grant)) {
        return { ok: false, code: "not_holder", error: "the lease is not held by this attempt" };
      }
      if (expired(current)) {
        return { ok: false, code: "expired", error: "the lease expired; reclaim it explicitly" };
      }
      const next: LeaseGrant = { ...current, expiresAt: now() + ttlMs };
      fs.writeFileSync(
        path.join(dir, "lease.json"),
        JSON.stringify({ ...readLease(dir), ...next }),
        "utf8",
      );
      return { ok: true, grant: { ...next } };
    },

    release(grant) {
      const dir = leaseDirFor(options.root, grant.workspaceKey);
      const current = holder(grant.workspaceKey);
      if (!current || !sameHolder(current, grant)) {
        return { ok: false, code: "not_holder", error: "the lease is not held by this attempt" };
      }
      fs.rmSync(path.join(dir, "lease.json"), { force: true });
      return { ok: true };
    },

    holder,

    isWriter(grant) {
      const current = holder(grant.workspaceKey);
      return !!current && !expired(current) && sameHolder(current, grant);
    },

    nextGeneration(workspaceKey) {
      const dir = leaseDirFor(options.root, workspaceKey);
      fs.mkdirSync(dir, { recursive: true });
      const state = generationState(dir);
      const next = Math.max(state.generation, state.reserved) + 1;
      // Reserve the token durably; `acquire` accepts it once, then resets the
      // reservation. A restarted parent therefore never reuses a number.
      writeGeneration(dir, state.generation, next);
      return next;
    },

    reclaim(input) {
      if (input.confirmation !== "reclaim-stale") {
        return {
          ok: false,
          code: "confirmation",
          error: "reclaiming a lease needs an explicit confirmation",
        };
      }
      const dir = leaseDirFor(options.root, input.grant.workspaceKey);
      fs.mkdirSync(dir, { recursive: true });
      const current = holder(input.grant.workspaceKey);
      if (current && !expired(current)) {
        return { ok: false, code: "held", error: "the lease is still live", holder: { ...current } };
      }
      const last = generationOf(dir);
      if (!tokenAllowed(dir, input.grant.generation)) {
        return { ok: false, code: "stale_generation", error: `generation must exceed ${last}` };
      }
      const grant: LeaseGrant = {
        ...input.grant,
        acquiredAt: now(),
        expiresAt: now() + ttlMs,
      };
      fs.writeFileSync(
        path.join(dir, "lease.json"),
        JSON.stringify({ version: 1, ...grant, pid: process.pid }),
        "utf8",
      );
      writeGeneration(dir, grant.generation);
      return { ok: true, grant: { ...grant } };
    },
  };
  return leases;
}

// ── Git baseline ─────────────────────────────────────────────────────

export type GitRunner = (args: string[], cwd: string) => {
  ok: boolean;
  stdout: string;
  error?: string;
};

/** Parse `git status --porcelain=v1 -z` (including renames) into changes. */
export function parsePorcelainZ(output: string): BaselineChange[] {
  const parts = output.split("\u0000").filter((entry) => entry.length > 0);
  const changes: BaselineChange[] = [];
  for (let i = 0; i < parts.length; i += 1) {
    const entry = parts[i] ?? "";
    const code = entry.slice(0, 2);
    let filePath = entry.slice(3);
    if (code.startsWith("R") || code.startsWith("C")) {
      // Rename/copy: the next segment is the original path.
      const original = parts[i + 1];
      if (original !== undefined) i += 1;
      changes.push({
        path: filePath,
        status: "renamed",
        staged: code[0] !== " " && code[0] !== "?",
        ...(original ? { mode: `renamed-from:${original}` } : {}),
      });
      continue;
    }
    if (code === "??") {
      changes.push({ path: filePath, status: "untracked", staged: false });
      continue;
    }
    if (code.includes("D")) {
      changes.push({ path: filePath, status: "deleted", staged: code[0] !== " " && code[0] !== "?" });
      continue;
    }
    if (code.includes("A")) {
      changes.push({ path: filePath, status: "added", staged: code[0] !== " " && code[0] !== "?" });
      continue;
    }
    changes.push({
      path: filePath,
      status: "modified",
      staged: code[0] !== " " && code[0] !== "?",
    });
  }
  return changes;
}

/**
 * Real `BaselinePort`. It never stages, checks out or cleans: only `status`,
 * `diff --numstat` (for binary detection) and `rev-parse HEAD` are read.
 */
export function createGitBaselinePort(options: {
  runGit: GitRunner;
  maxHashBytes?: number;
}): BaselinePort {
  const maxHashBytes = options.maxHashBytes ?? 4 * 1024 * 1024;
  const trackedStatus = (cwd: string): BaselineChange[] | undefined => {
    const result = options.runGit(
      ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
      cwd,
    );
    if (!result.ok) return undefined;
    const changes = parsePorcelainZ(result.stdout);
    // Binary detection for tracked changes; untracked content is captured by
    // the baseline diff, so it is not reclassified here.
    const numstat = options.runGit(["diff", "--numstat", "HEAD"], cwd);
    if (numstat.ok) {
      for (const line of numstat.stdout.split("\n")) {
        if (!line.startsWith("-\t-\t")) continue;
        const target = line.split("\t")[2]?.trim();
        if (!target) continue;
        const existing = changes.find((change) => change.path === target);
        if (existing) existing.status = "binary";
        else changes.push({ path: target, status: "binary", staged: false });
      }
    }
    return changes;
  };

  return {
    async gitStatus(root) {
      const inside = options.runGit(["rev-parse", "--is-inside-work-tree"], root);
      if (!inside.ok || inside.stdout.trim() !== "true") return null;
      const head = options.runGit(["rev-parse", "HEAD"], root);
      const branch = options.runGit(["rev-parse", "--abbrev-ref", "HEAD"], root);
      const changes = trackedStatus(root);
      if (!changes) return null;
      return {
        ...(head.ok && head.stdout.trim() ? { head: head.stdout.trim() } : {}),
        ...(branch.ok && branch.stdout.trim() ? { branch: branch.stdout.trim() } : {}),
        changes,
      };
    },

    async listFiles(root, limit) {
      // A non-Git workspace still gets a bounded listing; no git needed.
      const out: Array<{ path: string; size: number | null }> = [];
      let truncated = false;
      const walk = (dir: string): void => {
        if (truncated) return;
        let entries: fs.Dirent[];
        try {
          entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const entry of entries) {
          if (truncated) return;
          if (entry.name === ".git" || entry.name === "node_modules") continue;
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            walk(full);
            continue;
          }
          if (!entry.isFile()) continue;
          if (out.length >= limit) {
            truncated = true;
            return;
          }
          let size: number | null = null;
          try {
            size = fs.statSync(full).size;
          } catch {
            size = null;
          }
          out.push({
            path: path.relative(root, full).split("\\").join("/"),
            size,
          });
        }
      };
      walk(root);
      out.sort((left, right) => left.path.localeCompare(right.path));
      return { files: out, truncated };
    },

    async contentDigest(root, relative) {
      // Content identity for a changed path. Status/size cannot distinguish a
      // same-length edit; a missing/oversized/unreadable file is reported as
      // `null` so acceptance blocks instead of treating it as unchanged.
      const base = path.resolve(root);
      const target = path.resolve(base, relative);
      if (target !== base && !target.startsWith(base + path.sep)) return null;
      try {
        const stat = fs.statSync(target);
        if (!stat.isFile() || stat.size > maxHashBytes) return null;
        return createHash("sha256").update(fs.readFileSync(target)).digest("hex");
      } catch {
        return null;
      }
    },
  };
}

// ── Host port ────────────────────────────────────────────────────────

export interface HostUiLike {
  notify(message: string, level?: "info" | "warning" | "error"): void;
  setStatus(key: string, text: string | undefined): void;
  setWidget(
    key: string,
    lines: string[] | undefined,
    options?: { placement?: "aboveEditor" | "belowEditor" },
  ): void;
}

/** Narrow the Pi UI surface to the orchestration `HostPort`. */
export function createHostPort(ui: HostUiLike): HostPort {
  return {
    notify: (message, level) => ui.notify(message, level ?? "info"),
    setStatus: (key, text) => ui.setStatus(key, text),
    setWidget: (key, lines, options) => ui.setWidget(key, lines, options),
    // Orchestration does not need to run arbitrary commands; refusing is safer
    // than accepting a name the caller guessed.
    runCommand: async () => ({ ran: false, error: "command execution is not exposed" }),
  };
}
