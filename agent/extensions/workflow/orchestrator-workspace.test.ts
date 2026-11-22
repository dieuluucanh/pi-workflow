/**
 * Workspace identity/lease/baseline tests (step 22). Identity unifies aliases;
 * a lease is cooperative and never stolen; a baseline detects external changes
 * and preserves dirty user work without destructive git operations.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  captureBaseline,
  compareBaseline,
  createWorkspaceLeases,
  resolveWorkspaceIdentity,
  type BaselinePort,
  type WorkspaceResolver,
} from "./orchestrator-workspace.ts";

function resolver(over: Partial<WorkspaceResolver> = {}): WorkspaceResolver {
  return {
    realpath: async (path) => path.replace(/\\\\\?\\/g, "").replace(/\\/g, "\\"),
    gitTopLevel: async () => "C:\\Work\\App",
    gitCommonDir: async () => "C:\\Work\\App\\.git",
    ...over,
  };
}

test("identity unifies Windows aliases, cwd children and symlinks", async () => {
  const real = await resolveWorkspaceIdentity({
    cwd: "C:\\Work\\App\\src",
    resolver: resolver({ realpath: async () => "C:\\Work\\App" }),
    caseInsensitive: true,
  });
  assert.equal(real.ok, true);
  const identity = (real as { ok: true; value: any }).value;
  assert.equal(identity.key, "git:c:/work/app");
  assert.equal(identity.kind, "git");
  assert.equal(identity.commonDir, "c:/work/app/.git");

  const aliases = [
    "c:/work/app",
    "C:\\WORK\\APP\\",
    "\\\\?\\C:\\Work\\App",
    "C:/work/app/sub",
  ];
  for (const cwd of aliases) {
    const result = await resolveWorkspaceIdentity({
      cwd,
      resolver: resolver({ realpath: async () => "C:/Work/App" }),
      caseInsensitive: true,
    });
    assert.equal((result as { ok: true; value: any }).value.key, identity.key, cwd);
  }
});

test("worktrees are distinct workspaces that share the common dir", async () => {
  const a = await resolveWorkspaceIdentity({
    cwd: "C:/repo/main",
    resolver: resolver({
      realpath: async (path) => path,
      gitTopLevel: async () => "C:/repo/main",
      gitCommonDir: async () => "C:/repo/.git",
    }),
  });
  const b = await resolveWorkspaceIdentity({
    cwd: "C:/repo/task-1",
    resolver: resolver({
      realpath: async (path) => path,
      gitTopLevel: async () => "C:/repo/task-1",
      gitCommonDir: async () => "C:/repo/.git",
    }),
  });
  assert.notEqual((a as any).value.key, (b as any).value.key);
  assert.equal((a as any).value.commonDir, (b as any).value.commonDir);
});

test("non-git folders get a plain key; a missing path is refused", async () => {
  const plain = await resolveWorkspaceIdentity({
    cwd: "/srv/app",
    resolver: resolver({ realpath: async () => "/srv/app/", gitTopLevel: async () => null }),
  });
  assert.equal((plain as any).value.key, "plain:/srv/app");
  const missing = await resolveWorkspaceIdentity({
    cwd: "/nope",
    resolver: resolver({ realpath: async () => null }),
  });
  assert.equal(missing.ok, false);
});

test("lease: one holder, stale generation, expiry without theft, explicit reclaim", () => {
  let clock = 1_000;
  const leases = createWorkspaceLeases({ ttlMs: 1_000, now: () => clock });
  const grant = {
    workspaceKey: "git:c:/work/app",
    runId: "run-1",
    taskId: "task-1",
    attemptId: "a-1",
    sessionId: "s-1",
    generation: 1,
  };
  const first = leases.acquire(grant);
  assert.equal(first.ok, true);
  assert.equal(leases.isWriter((first as any).grant), true);

  // Same attempt can re-enter; another attempt cannot.
  assert.equal(leases.acquire(grant).ok, true);
  const held = leases.acquire({ ...grant, taskId: "task-2", attemptId: "a-2", generation: 2 });
  assert.equal((held as any).code, "held");

  clock = 2_001;
  const expired = leases.acquire({ ...grant, taskId: "task-2", attemptId: "a-2", generation: 2 });
  assert.equal((expired as any).code, "expired", "never stolen implicitly");
  assert.equal(
    (
      leases.reclaim({
        workspaceKey: grant.workspaceKey,
        grant: { ...grant, taskId: "task-2", attemptId: "a-2", generation: 2 },
        confirmation: "no",
      }) as any
    ).code,
    "confirmation",
  );
  const reclaimed = leases.reclaim({
    workspaceKey: grant.workspaceKey,
    grant: { ...grant, taskId: "task-2", attemptId: "a-2", generation: 2 },
    confirmation: "reclaim-stale",
  });
  assert.equal(reclaimed.ok, true);
  assert.equal(leases.isWriter((first as any).grant), false);
  assert.equal(leases.isWriter((reclaimed as any).grant), true);

  // A stale generation cannot be used even after release.
  leases.release((reclaimed as any).grant);
  const stale = leases.acquire({ ...grant, generation: 2 });
  assert.equal((stale as any).code, "stale_generation");
});

test("baseline captures tracked/untracked/binary/mode state deterministically", async () => {
  const port: BaselinePort = {
    async gitStatus() {
      return {
        head: "abc",
        branch: "main",
        changes: [
          { path: "src/a.ts", status: "modified", staged: true },
          { path: "src/a.ts", status: "modified", staged: false },
          { path: "docs/gone.md", status: "deleted", staged: false },
          { path: "new.bin", status: "binary", staged: false, size: 10 },
          { path: "script.sh", status: "mode", staged: false, mode: "100755" },
          { path: "untracked.txt", status: "untracked", staged: false },
        ],
      };
    },
    async listFiles() {
      return null;
    },
  };
  const workspace = {
    key: "git:c:/work/app",
    root: "c:/work/app",
    kind: "git" as const,
    displayPath: "C:/Work/App",
  };
  const one = await captureBaseline({ workspace, port, now: 1 });
  const two = await captureBaseline({ workspace, port, now: 2 });
  assert.equal(one.ok && two.ok, true);
  const baseline = (one as any).value;
  assert.equal(baseline.changes.length, 6);
  assert.deepEqual(baseline.counts, { staged: 1, unstaged: 5, untracked: 1, deleted: 1, binary: 1 });
  assert.equal(baseline.digest, (two as any).value.digest, "digest excludes the clock");
  assert.equal(baseline.head, "abc");
});

test("baseline is bounded and works without git", async () => {
  const port: BaselinePort = {
    async gitStatus() {
      return null;
    },
    async listFiles(_root, limit) {
      return {
        files: Array.from({ length: limit + 1 }, (_, index) => ({ path: `f${index}.txt`, size: index })),
        truncated: true,
      };
    },
  };
  const result = await captureBaseline({
    workspace: { key: "plain:c:/app", root: "c:/app", kind: "plain", displayPath: "C:/app" },
    port,
    now: 1,
    maxFiles: 3,
  });
  const baseline = (result as any).value;
  assert.equal(baseline.changes.length, 3);
  assert.equal(baseline.truncated, true);
  assert.equal(baseline.kind, "plain");
});

test("comparison reports external changes, revalidation and attribution conflicts", async () => {
  const port: BaselinePort = {
    async gitStatus() {
      return {
        changes: [{ path: "src/user.ts", status: "modified", staged: true }],
      };
    },
    async listFiles() {
      return null;
    },
  };
  const workspace = { key: "git:c:/app", root: "c:/app", kind: "git" as const, displayPath: "C:/app" };
  const base = (await captureBaseline({ workspace, port, now: 1 }) as any).value;
  const same = compareBaseline(base, { ...base, capturedAt: 2 });
  assert.equal(same.unchanged, true);
  assert.equal(same.requiresRevalidation, false);

  const changed = compareBaseline(base, {
    ...base,
    changes: [
      ...base.changes,
      { path: "src/external.ts", status: "untracked", staged: false },
    ],
  });
  assert.equal(changed.requiresRevalidation, true);
  assert.deepEqual(changed.externalChanges, ["src/external.ts"]);

  const conflict = compareBaseline(base, base, { expectedPaths: ["src/user.ts"] });
  assert.deepEqual(conflict.attributionConflicts, ["src/user.ts"]);
});

test("content identity detects a same-length edit the metadata fingerprint misses", async () => {
  let content = "aaaa";
  const port: BaselinePort = {
    async gitStatus() {
      return {
        changes: [{ path: "src/user.ts", status: "modified", staged: false, size: 4 }],
      };
    },
    async listFiles() {
      return null;
    },
    async contentDigest() {
      return content;
    },
  };
  const workspace = { key: "git:c:/app", root: "c:/app", kind: "git" as const, displayPath: "C:/app" };
  const before = (await captureBaseline({ workspace, port, now: 1 }) as any).value;
  assert.equal(before.contentComplete, true);
  assert.equal(before.changes[0].contentDigest, "aaaa");

  content = "bbbb";
  const after = (await captureBaseline({ workspace, port, now: 2 }) as any).value;
  assert.notEqual(before.digest, after.digest, "same status/size but different content");
  const compared = compareBaseline(before, after);
  assert.equal(compared.requiresRevalidation, true);
  assert.deepEqual(compared.externalChanges, ["src/user.ts"]);
});

test("unreadable or oversized content is reported as incomplete, not unchanged", async () => {
  const port: BaselinePort = {
    async gitStatus() {
      return {
        changes: [
          { path: "src/user.ts", status: "modified", staged: false, size: 4 },
          { path: "gone.ts", status: "deleted", staged: false },
        ],
      };
    },
    async listFiles() {
      return null;
    },
    async contentDigest() {
      return null;
    },
  };
  const captured = await captureBaseline({
    workspace: { key: "git:c:/app", root: "c:/app", kind: "git", displayPath: "C:/app" },
    port,
    now: 1,
  });
  const value = (captured as any).value;
  assert.equal(value.contentComplete, false);
  assert.equal(value.changes.find((change: any) => change.path === "gone.ts").contentDigest, undefined);
});
