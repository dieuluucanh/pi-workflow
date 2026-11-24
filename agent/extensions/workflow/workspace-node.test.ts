/**
 * Real workspace resolver tests.
 *
 * The resolver is read-only and injects git, so these run without a real
 * repository. The real-filesystem cases use a temp directory.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { createNodeWorkspaceResolver } from "./workspace-node.ts";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pi-workspace-node-"));
}

const runner = (
  answers: Record<string, { ok: boolean; stdout: string; error?: string }>,
) =>
  (args: string[], _cwd: string) => {
    const key = args.join(" ");
    return answers[key] ?? { ok: false, stdout: "", error: "no answer" };
  };

test("workspace-node: reads the real directory and file kinds", async () => {
  const dir = tempDir();
  const file = path.join(dir, "a.txt");
  fs.writeFileSync(file, "x", "utf8");
  const resolver = createNodeWorkspaceResolver({ runGit: () => ({ ok: false, stdout: "" }) });

  assert.equal(await resolver.statKind(dir), "dir");
  assert.equal(await resolver.statKind(file), "file");
  assert.equal(await resolver.statKind(path.join(dir, "missing")), null);
  assert.equal(await resolver.realpath(dir), fs.realpathSync.native(dir));
  assert.equal(await resolver.realpath(path.join(dir, "missing")), null);
});

test("workspace-node: gitTopLevel returns the top level or null", async () => {
  const top = "/repo/main";
  const resolver = createNodeWorkspaceResolver({
    runGit: runner({
      "rev-parse --show-toplevel": { ok: true, stdout: `${top}\n` },
      "rev-parse --git-common-dir": { ok: true, stdout: ".git\n" },
    }),
  });
  assert.equal(await resolver.gitTopLevel("/repo/main/sub"), top);
  assert.equal(
    await resolver.gitCommonDir?.("/repo/main/sub"),
    path.resolve("/repo/main/sub", ".git"),
  );
});

test("workspace-node: a missing git answer is null, never a throw", async () => {
  const resolver = createNodeWorkspaceResolver({
    runGit: () => ({ ok: false, stdout: "", error: "not a git repository" }),
  });
  assert.equal(await resolver.gitTopLevel("/repo/main"), null);
  assert.equal(await resolver.gitCommonDir?.("/repo/main"), null);
});

test("workspace-node: injected realpath/statKind replace the filesystem", async () => {
  const resolver = createNodeWorkspaceResolver({
    runGit: () => ({ ok: false, stdout: "" }),
    realpath: (value) => `/real${value}`,
    statKind: () => "other",
  });
  assert.equal(await resolver.realpath("/x"), "/real/x");
  assert.equal(await resolver.statKind("/x"), "other");
});

test("workspace-node: an absolute --git-common-dir is kept as-is", async () => {
  const resolver = createNodeWorkspaceResolver({
    runGit: runner({
      "rev-parse --git-common-dir": { ok: true, stdout: "/bare/repo.git\n" },
    }),
  });
  assert.equal(await resolver.gitCommonDir?.("/repo/main"), "/bare/repo.git");
});
