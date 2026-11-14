/**
 * Workflow Extension — Shell path analysis tests
 *
 * Run with: npm test   (node --test, type-stripping — no build step)
 *
 * Covers the read/write targets extracted from shell commands and the
 * git add/commit/push scope used by the commit policy. The analyzer is
 * deliberately conservative: unknown commands do not invent targets.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";

import { analyzeShellPaths, type ShellPathAnalysis } from "./shell-paths.ts";
import { normalizePolicyPath } from "./folder-policy.ts";

const CWD = path.resolve(process.cwd());

function norm(value: string): string {
  return normalizePolicyPath(value, CWD);
}

function readPaths(analysis: ShellPathAnalysis): string[] {
  return analysis.reads.map((target) => target.path).sort();
}

function writePaths(analysis: ShellPathAnalysis): string[] {
  return analysis.writes.map((target) => target.path).sort();
}

// ── reads ───────────────────────────────────────────────────────────

test("read: cat / head / tail paths, including input redirection", () => {
  assert.deepEqual(readPaths(analyzeShellPaths("cat ../secret.txt", CWD)), [
    norm("../secret.txt"),
  ]);
  assert.deepEqual(readPaths(analyzeShellPaths("head -n 5 ../a.txt", CWD)), [
    norm("../a.txt"),
  ]);
  assert.deepEqual(readPaths(analyzeShellPaths("cat < ../a.txt", CWD)), [
    norm("../a.txt"),
  ]);
});

test("read: cd changes the base for later segments", () => {
  const analysis = analyzeShellPaths("cd .. && cat other/x.ts", CWD);
  assert.deepEqual(readPaths(analysis), [norm("../other/x.ts")]);
});

test("read: grep/rg skip the pattern, honour -f, default to cwd", () => {
  assert.deepEqual(readPaths(analyzeShellPaths("rg needle ../src", CWD)), [
    norm("../src"),
  ]);
  const withPattern = analyzeShellPaths("grep -f ../patterns.txt src", CWD);
  assert.deepEqual(readPaths(withPattern), [
    norm("../patterns.txt"),
    norm("src"),
  ]);
  assert.deepEqual(readPaths(analyzeShellPaths("rg needle", CWD)), [norm(CWD)]);
});

test("read: find root and -newer/-files0-from", () => {
  const analysis = analyzeShellPaths(
    "find . -name '*.ts' -newer ../stamp",
    CWD,
  );
  assert.deepEqual(readPaths(analysis), [norm("../stamp"), norm(CWD)].sort());
  const zero = analyzeShellPaths("find . -files0-from ../list", CWD);
  assert.ok(readPaths(zero).includes(norm("../list")));
});

test("read: git -C and git show HEAD:path resolve against the repo root", () => {
  const scoped = analyzeShellPaths("git -C ../other status", CWD);
  assert.ok(readPaths(scoped).includes(norm("../other")));

  const show = analyzeShellPaths("git show HEAD:.env", CWD);
  assert.ok(readPaths(show).includes(norm(".env")));

  const diff = analyzeShellPaths("git diff -- .env", CWD);
  assert.ok(readPaths(diff).includes(norm(".env")));
});

test("read: interpreters, shells and substitutions", () => {
  assert.ok(
    readPaths(analyzeShellPaths("node scripts/build.js", CWD)).includes(
      norm("scripts/build.js"),
    ),
  );
  assert.ok(
    readPaths(analyzeShellPaths("bash -c 'cat ../x'", CWD)).includes(
      norm("../x"),
    ),
  );
  assert.ok(
    readPaths(analyzeShellPaths("echo $(cat ../x)", CWD)).includes(norm("../x")),
  );
  assert.ok(
    readPaths(analyzeShellPaths("echo `cat ../x`", CWD)).includes(norm("../x")),
  );
});

test("read: PowerShell and cmd aliases", () => {
  assert.ok(
    readPaths(analyzeShellPaths("Get-Content ../x", CWD)).includes(norm("../x")),
  );
  assert.ok(
    readPaths(analyzeShellPaths("Get-ChildItem -Path ../src", CWD)).includes(
      norm("../src"),
    ),
  );
  assert.ok(
    readPaths(analyzeShellPaths("cmd /c type ../x.txt", CWD)).includes(
      norm("../x.txt"),
    ),
  );
});

test("read: curl file:// and @file inputs", () => {
  assert.ok(
    readPaths(analyzeShellPaths("curl file:///etc/passwd", CWD)).includes(
      norm("/etc/passwd"),
    ),
  );
  assert.ok(
    readPaths(analyzeShellPaths("curl --data @../payload.json https://x", CWD)).includes(
      norm("../payload.json"),
    ),
  );
});

test("read: sensitive operand on an unknown command is caught", () => {
  assert.ok(
    readPaths(analyzeShellPaths("some-tool .env", CWD)).includes(norm(".env")),
  );
  const unknown = analyzeShellPaths("some-tool ../outside", CWD);
  assert.deepEqual(readPaths(unknown), []);
  assert.ok(unknown.uncertain.length > 0);
});

// ── writes ──────────────────────────────────────────────────────────

test("write: redirections, tee and common write commands", () => {
  assert.deepEqual(writePaths(analyzeShellPaths("echo x > .env", CWD)), [
    norm(".env"),
  ]);
  assert.deepEqual(writePaths(analyzeShellPaths("echo x | tee ../log.txt", CWD)), [
    norm("../log.txt"),
  ]);
  assert.deepEqual(writePaths(analyzeShellPaths("mkdir -p ../out", CWD)), [
    norm("../out"),
  ]);
  assert.deepEqual(writePaths(analyzeShellPaths("rm -rf ../tmp", CWD)), [
    norm("../tmp"),
  ]);
});

test("write: cp/mv source is a read, destination is a write", () => {
  const cp = analyzeShellPaths("cp ../x ./x", CWD);
  assert.ok(readPaths(cp).includes(norm("../x")));
  assert.ok(writePaths(cp).includes(norm("./x")));

  const mv = analyzeShellPaths("mv ../.env ./x", CWD);
  assert.ok(readPaths(mv).includes(norm("../.env")));
  assert.ok(writePaths(mv).includes(norm("./x")));

  const intoSecret = analyzeShellPaths("cp ./x ../.env", CWD);
  assert.ok(writePaths(intoSecret).includes(norm("../.env")));
});

test("write: sed -i, awk inplace and tar -C", () => {
  const sed = analyzeShellPaths("sed -i 's/a/b/' .env", CWD);
  assert.ok(readPaths(sed).includes(norm(".env")));
  assert.ok(writePaths(sed).includes(norm(".env")));

  const tar = analyzeShellPaths("tar -xf ../a.tar -C ../out", CWD);
  assert.ok(readPaths(tar).includes(norm("../a.tar")));
  assert.ok(writePaths(tar).includes(norm("../out")));
});

test("write: PowerShell Set-Content and cmd copy", () => {
  const ps = analyzeShellPaths("Set-Content -Path ../x.txt -Value ok", CWD);
  assert.ok(writePaths(ps).includes(norm("../x.txt")));
  const copy = analyzeShellPaths("copy ../x.txt ../y.txt", CWD);
  assert.ok(readPaths(copy).includes(norm("../x.txt")));
  assert.ok(writePaths(copy).includes(norm("../y.txt")));
});

test("write: git checkout/restore explicit paths and clone", () => {
  const checkout = analyzeShellPaths("git checkout -- .env", CWD);
  assert.ok(writePaths(checkout).includes(norm(".env")));
  const clone = analyzeShellPaths("git clone ../repo ../dest", CWD);
  assert.ok(readPaths(clone).includes(norm("../repo")));
  assert.ok(writePaths(clone).includes(norm("../dest")));
});

// ── git scope ───────────────────────────────────────────────────────

test("git: add explicit path and worktree-wide add", () => {
  const explicit = analyzeShellPaths("git add .env", CWD);
  assert.equal(explicit.git?.hit, "add");
  assert.deepEqual(explicit.git?.explicitPaths, [norm(".env")]);
  assert.equal(explicit.git?.allPaths, false);

  const all = analyzeShellPaths("git add .", CWD);
  assert.equal(all.git?.allPaths, true);

  const allFlag = analyzeShellPaths("git add -A", CWD);
  assert.equal(allFlag.git?.allPaths, true);
});

test("git: commit -m / -a / --amend and -C scope", () => {
  const message = analyzeShellPaths('git commit -m "hello"', CWD);
  assert.equal(message.git?.hit, "commit");
  assert.deepEqual(message.git?.explicitPaths, []);
  assert.equal(message.git?.allPaths, false);
  assert.equal(message.git?.amend, false);

  const amend = analyzeShellPaths("git commit --amend -a", CWD);
  assert.equal(amend.git?.amend, true);
  assert.equal(amend.git?.allPaths, true);

  const scoped = analyzeShellPaths("git -C ../other commit -m x", CWD);
  assert.equal(scoped.git?.repoRoot, norm("../other"));
  assert.equal(scoped.git?.usesCwd, false);
});

test("git: push has no local path operands", () => {
  const push = analyzeShellPaths("git push origin main", CWD);
  assert.equal(push.git?.hit, "push");
  assert.deepEqual(push.git?.explicitPaths, []);
});

// ── uncertain / no invention ────────────────────────────────────────

test("uncertain: inline code, xargs, eval and unknown full commands", () => {
  assert.ok(analyzeShellPaths("node -e 'x'", CWD).uncertain.length > 0);
  assert.ok(analyzeShellPaths("python -c 'print(1)'", CWD).uncertain.length > 0);
  assert.ok(analyzeShellPaths("xargs cat", CWD).uncertain.length > 0);
  assert.ok(analyzeShellPaths("eval \"$x\"", CWD).uncertain.length > 0);
  assert.ok(analyzeShellPaths("npm test", CWD).uncertain.length > 0);
});

test("no invention: read-only unknown commands with plain args have no targets", () => {
  const analysis = analyzeShellPaths("npm test", CWD);
  assert.deepEqual(analysis.reads, []);
  assert.deepEqual(analysis.writes, []);
});

test("empty/non-string commands are total", () => {
  assert.deepEqual(analyzeShellPaths("", CWD).reads, []);
  assert.deepEqual(analyzeShellPaths(undefined, CWD).writes, []);
});
