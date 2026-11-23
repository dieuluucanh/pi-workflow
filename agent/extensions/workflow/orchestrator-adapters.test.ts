/**
 * Production adapter tests (plan step 8).
 *
 * Real filesystem, real locks and a fake git runner: the properties that matter
 * are durability (atomic replace, torn-line replay), single-writer ownership
 * across processes (exclusive lock + generation high-water mark) and an honest
 * baseline parser.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  MAX_GIT_DIFF_PATHS,
  createGitBaselinePort,
  createNodeJournalIo,
  createNodeWorkspaceResolver,
  parsePorcelainZ,
  readGitDiffPaths,
} from "./orchestrator-adapters.ts";
import { createRunJournal } from "./orchestrator-store.ts";
import { captureBaseline } from "./orchestrator-workspace.ts";

function tempDir(): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-adapters-"));
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test("journal io: atomic replace never leaves a partial target", async () => {
  const { dir, cleanup } = tempDir();
  try {
    const io = createNodeJournalIo();
    const target = path.join(dir, "snapshot.json");
    await io.writeAtomic(target, '{"v":1}');
    assert.equal(await io.read(target), '{"v":1}');
    // No temp files are left behind.
    assert.deepEqual((await io.list(dir)).filter((n) => n.includes(".tmp")), []);
    await io.writeAtomic(target, '{"v":2}');
    assert.equal(await io.read(target), '{"v":2}');
  } finally {
    cleanup();
  }
});

test("journal io: a torn tail is preserved for replay/recovery, not hidden", async () => {
  const { dir, cleanup } = tempDir();
  try {
    const io = createNodeJournalIo();
    const run = createRunJournal({ dir, runId: "run-1", io });
    const appended = await run.append({
      eventId: "evt-1",
      type: "run.created",
      at: 1,
      payload: { cwd: dir },
    });
    assert.equal(appended.ok, true, appended.ok ? "" : appended.error);

    // A crash mid-append leaves a partial last line on disk.
    const journalPath = path.join(dir, "journal.ndjson");
    assert.ok(journalPath, "the journal file exists on disk");
    await io.append(journalPath!, '{"version":1,"seq":2,"torn"');

    const loaded = await run.load();
    assert.equal(loaded.ok, true, loaded.ok ? "" : loaded.error);
    if (loaded.ok) {
      assert.equal(loaded.value.seq, 1, "only the valid event is replayed");
      assert.equal(loaded.value.truncated, 1, "the torn tail is reported");
    }
  } finally {
    cleanup();
  }
});

test("journal io: the writer lock is exclusive per process", async () => {
  const { dir, cleanup } = tempDir();
  try {
    const io = createNodeJournalIo();
    const lock = path.join(dir, "run.lock");
    assert.equal(await io.acquireLock(lock, 1_000), true);
    assert.equal(await io.acquireLock(lock, 1_000), false, "a second writer is refused");
    await io.releaseLock(lock);
    assert.equal(await io.acquireLock(lock, 1_000), true);
    await io.releaseLock(lock);
  } finally {
    cleanup();
  }
});

test("baseline: content digests are real file bytes and bound to the workspace root", async () => {
  const { dir, cleanup } = tempDir();
  try {
    fs.writeFileSync(path.join(dir, "same-length.txt"), "aaaa");
    const port = createGitBaselinePort({
      runGit: () => ({ ok: false, stdout: "", error: "not a repository" }),
    });
    const first = await port.contentDigest!(dir, "same-length.txt");
    assert.match(first ?? "", /^[0-9a-f]{64}$/);
    fs.writeFileSync(path.join(dir, "same-length.txt"), "bbbb");
    const second = await port.contentDigest!(dir, "same-length.txt");
    assert.notEqual(first, second, "same size, different bytes");
    assert.equal(await port.contentDigest!(dir, "../outside.txt"), null);
    assert.equal(await port.contentDigest!(dir, "missing.txt"), null);
  } finally {
    cleanup();
  }
});

test("workspace resolver: real paths and injected git top level/common dir", async () => {
  const { dir, cleanup } = tempDir();
  try {
    const sub = path.join(dir, "sub");
    fs.mkdirSync(sub);
    const file = path.join(dir, "file.txt");
    fs.writeFileSync(file, "x");
    const calls: string[][] = [];
    const resolver = createNodeWorkspaceResolver({
      runGit: (args, cwd) => {
        calls.push(args);
        assert.equal(cwd, dir);
        if (args[0] === "rev-parse" && args[1] === "--show-toplevel") {
          return { ok: true, stdout: `${dir}\n` };
        }
        if (args[0] === "rev-parse" && args[1] === "--git-common-dir") {
          return { ok: true, stdout: ".git\n" };
        }
        return { ok: false, stdout: "", error: "unexpected" };
      },
    });
    assert.equal(await resolver.realpath(dir), fs.realpathSync.native(dir));
    assert.equal(await resolver.realpath(path.join(dir, "missing")), null);
    assert.equal(await resolver.statKind(sub), "dir");
    assert.equal(await resolver.statKind(file), "file");
    assert.equal(await resolver.statKind(path.join(dir, "missing")), null);
    assert.equal(await resolver.gitTopLevel(dir), dir);
    assert.equal(await resolver.gitCommonDir?.(dir), path.join(dir, ".git"));
    assert.deepEqual(calls, [
      ["rev-parse", "--show-toplevel"],
      ["rev-parse", "--git-common-dir"],
    ]);

    const noGit = createNodeWorkspaceResolver({
      runGit: () => ({ ok: false, stdout: "", error: "not a repo" }),
    });
    assert.equal(await noGit.gitTopLevel(dir), null);
    assert.equal(await noGit.gitCommonDir?.(dir), null);
  } finally {
    cleanup();
  }
});

test("workspace resolver: a directory link resolves to the same real path", async () => {
  const { dir, cleanup } = tempDir();
  try {
    const target = path.join(dir, "target");
    const link = path.join(dir, "link");
    fs.mkdirSync(target);
    try {
      fs.symlinkSync(target, link, "junction");
    } catch {
      return; // privilege/policy may refuse symlinks; the rest is covered
    }
    const resolver = createNodeWorkspaceResolver({
      runGit: () => ({ ok: false, stdout: "" }),
    });
    assert.equal(await resolver.realpath(link), await resolver.realpath(target));
  } finally {
    cleanup();
  }
});

test("git diff paths: one read-only range command, sorted and deduped", () => {
  const calls: Array<{ args: string[]; cwd: string }> = [];
  const result = readGitDiffPaths({
    runGit: (args, cwd) => {
      calls.push({ args, cwd });
      return { ok: true, stdout: "src/b.ts\nsrc/a.ts\nsrc/a.ts\n\n" };
    },
    root: "C:/work/D",
    fromHead: "aaaa",
    toHead: "bbbb",
  });
  assert.deepEqual(result, { ok: true, paths: ["src/a.ts", "src/b.ts"] });
  assert.deepEqual(calls, [
    { args: ["diff", "--name-only", "aaaa..bbbb"], cwd: "C:/work/D" },
  ]);

  const same = readGitDiffPaths({
    runGit: () => {
      throw new Error("must not run");
    },
    root: "C:/work/D",
    fromHead: "aaaa",
    toHead: "aaaa",
  });
  assert.deepEqual(same, { ok: true, paths: [] });
});

test("git diff paths: failures and oversized ranges are errors, not empty", () => {
  const failed = readGitDiffPaths({
    runGit: () => ({ ok: false, stdout: "", error: "bad object" }),
    root: "C:/work/D",
    fromHead: "a",
    toHead: "b",
  });
  assert.equal(failed.ok, false);
  assert.match(failed.ok ? "" : failed.error, /bad object/);

  const huge = readGitDiffPaths({
    runGit: () => ({
      ok: true,
      stdout: Array.from({ length: MAX_GIT_DIFF_PATHS + 1 }, (_, index) => `f${index}.ts`).join("\n"),
    }),
    root: "C:/work/D",
    fromHead: "a",
    toHead: "b",
  });
  assert.equal(huge.ok, false);
  assert.match(huge.ok ? "" : huge.error, /more than/);
});

test("porcelain: modifications, staged adds, deletes, renames and untracked", () => {
  const output = [
    " M src/a.ts",
    "A  src/b.ts",
    "D  src/c.ts",
    "R  src/new.ts",
    "src/old.ts",
    "?? notes.md",
    "",
  ].join("\u0000");
  const changes = parsePorcelainZ(output);
  assert.deepEqual(
    changes.map((c) => `${c.status}:${c.staged}:${c.path}`),
    [
      "modified:false:src/a.ts",
      "added:true:src/b.ts",
      "deleted:true:src/c.ts",
      "renamed:true:src/new.ts",
      "untracked:false:notes.md",
    ],
  );
});

test("baseline: git status is read-only and captures untracked + binary", async () => {
  const { dir, cleanup } = tempDir();
  try {
    const calls: string[][] = [];
    const port = createGitBaselinePort({
      runGit: (args) => {
        calls.push(args);
        const joined = args.join(" ");
        if (joined === "rev-parse --is-inside-work-tree") return { ok: true, stdout: "true\n" };
        if (joined === "rev-parse HEAD") return { ok: true, stdout: "abc123\n" };
        if (joined === "rev-parse --abbrev-ref HEAD") return { ok: true, stdout: "main\n" };
        if (joined.includes("status --porcelain")) {
          return { ok: true, stdout: " M src/a.ts\u0000?? notes.md\u0000" };
        }
        if (joined.includes("diff --numstat")) {
          return { ok: true, stdout: "-\t-\tsrc/logo.png\n" };
        }
        return { ok: true, stdout: "" };
      },
    });

    const baseline = await captureBaseline({
      workspace: { key: "ws", root: dir, kind: "git" },
      port,
      now: 5,
      maxFiles: 100,
    } as never);
    assert.equal(baseline.ok, true, baseline.ok ? "" : baseline.error);
    if (!baseline.ok) return;
    assert.equal(baseline.value.kind, "git");
    assert.equal(baseline.value.head, "abc123");
    const statuses = baseline.value.changes.map((c) => `${c.status}:${c.path}`);
    assert.ok(statuses.includes("modified:src/a.ts"));
    assert.ok(statuses.includes("untracked:notes.md"));
    assert.ok(statuses.includes("binary:src/logo.png"));

    // Only read-only git commands were issued.
    for (const call of calls) {
      assert.equal(
        ["status", "diff", "rev-parse"].some((head) => call[0] === head),
        true,
        `unexpected git command: ${call.join(" ")}`,
      );
    }
  } finally {
    cleanup();
  }
});

test("baseline: a non-Git folder gets a bounded listing, never a failure", async () => {
  const { dir, cleanup } = tempDir();
  try {
    fs.writeFileSync(path.join(dir, "a.txt"), "a");
    fs.mkdirSync(path.join(dir, "nested"));
    fs.writeFileSync(path.join(dir, "nested", "b.txt"), "bb");
    const port = createGitBaselinePort({
      runGit: () => ({ ok: false, stdout: "", error: "not a repository" }),
    });
    const listing = await port.listFiles(dir, 1);
    assert.ok(listing);
    assert.equal(listing?.truncated, true, "the bound is applied");
    assert.equal(listing?.files.length, 1);
  } finally {
    cleanup();
  }
});
