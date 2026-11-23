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
  diffSinceBaseline,
  hasAttributableChange,
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

// ── HEAD-aware diff (attributable work) ──────────────────────────────

function baseline(head: string | undefined, changes: Array<{ path: string; status?: string }>) {
  return {
    schemaVersion: 1 as const,
    workspaceKey: "git:c:/app",
    root: "c:/app",
    kind: "git" as const,
    capturedAt: 1,
    ...(head ? { head } : {}),
    changes: changes.map((change) => ({
      path: change.path,
      status: (change.status ?? "modified") as "modified",
      staged: false,
    })),
    counts: { staged: 0, unstaged: changes.length, untracked: 0, deleted: 0, binary: 0 },
    truncated: false,
    digest: `digest-${head ?? "none"}-${changes.map((c) => c.path).join(",")}`,
  };
}

test("diffSinceBaseline reports committed work from the HEAD range", () => {
  const before = baseline("aaaa", []);
  const after = baseline("bbbb", []);
  const diff = diffSinceBaseline(before, after, {
    gitDiffPaths: ["src/app.ts", "src/app.ts", "docs/readme.md"],
  });
  assert.equal(diff.changed, true);
  assert.deepEqual(diff.committedPaths, ["docs/readme.md", "src/app.ts"]);
  assert.deepEqual(diff.dirtyPaths, []);
  assert.equal(hasAttributableChange(diff, ["src/app.ts"]), true);
});

test("diffSinceBaseline reports new dirty paths and a revision", () => {
  const before = baseline("aaaa", [{ path: "src/old.ts" }]);
  const after = baseline("aaaa", [
    { path: "src/old.ts" },
    { path: "src/new.ts" },
  ]);
  const diff = diffSinceBaseline(before, after, { expectedPaths: ["src/new.ts"] });
  assert.equal(diff.changed, true);
  assert.deepEqual(diff.committedPaths, []);
  assert.deepEqual(diff.dirtyPaths, ["src/new.ts"]);
  assert.match(diff.workspaceRevision, /^[0-9a-f]{64}$/);
  assert.equal(hasAttributableChange(diff, ["src/new.ts"]), true);
});

test("diffSinceBaseline stays clean when nothing changed and no head moved", () => {
  const before = baseline("aaaa", []);
  const after = baseline("aaaa", []);
  const diff = diffSinceBaseline(before, after);
  assert.equal(diff.changed, false);
  assert.deepEqual(diff.committedPaths, []);
  assert.deepEqual(diff.dirtyPaths, []);
  assert.equal(hasAttributableChange(diff, []), false);
});

test("diffSinceBaseline only reports dirty paths outside a git workspace", () => {
  const before = baseline(undefined, []);
  const after = baseline(undefined, [{ path: "notes.txt", status: "untracked" }]);
  const diff = diffSinceBaseline(before, after, {
    gitDiffPaths: ["ignored.ts"],
  });
  assert.deepEqual(diff.committedPaths, []);
  assert.deepEqual(diff.dirtyPaths, ["notes.txt"]);
  assert.equal(diff.changed, true);
});

test("a pre-existing dirty file on an expected path is an attribution conflict, not attributed work", () => {
  const before = baseline("aaaa", [{ path: "src/app.ts" }]);
  const after = baseline("aaaa", [{ path: "src/app.ts" }]);
  const diff = diffSinceBaseline(before, after, { expectedPaths: ["src/app.ts"] });
  assert.deepEqual(diff.attributionConflicts, ["src/app.ts"]);
  assert.equal(diff.changed, false);
  assert.equal(hasAttributableChange(diff, ["src/app.ts"]), false);
});

test("hasAttributableChange matches nested expected paths by suffix", () => {
  const diff = diffSinceBaseline(baseline("aaaa", []), baseline("aaaa", [{ path: "agent/extensions/workflow/x.ts" }]));
  assert.equal(
    hasAttributableChange(diff, ["workflow/x.ts"]),
    true,
  );
  assert.equal(hasAttributableChange(diff, ["unrelated.ts"]), false);
});
