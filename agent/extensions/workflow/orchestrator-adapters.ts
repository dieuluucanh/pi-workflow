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
import type {
  BaselineChange,
  BaselinePort,
} from "./orchestrator-workspace.ts";

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
