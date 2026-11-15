/**
 * Workflow Extension — `excludePaths` matcher tests
 *
 * Run with: npm test   (node --test, type-stripping — no build step)
 *
 * Covers the pattern normalisation contract, prefix walking (drive/UNC/POSIX
 * roots), subtree matching, deepest-match attribution, sibling boundaries and
 * canonical (symlink-resolved) matching. The rescue rule that turns a match
 * into allow/ask/block lives in `folder-policy.test.ts`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  DEFAULT_FOLDER_POLICY_CONFIG,
  createExclusionMatcher,
  evaluateFolderTargets,
  isBroadExcludePattern,
  matchExcludedPath,
  normalizeExcludePattern,
  normalizePolicyPath,
  pathPrefixes,
} from "./folder-policy.ts";

/** Comparison form for expectations (absolute, forward slashes, platform case). */
function norm(value: string): string {
  return normalizePolicyPath(value, value);
}

function tmpDir(): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-folder-exclude-"));
  return {
    dir,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

function withExcludes(excludePaths: string[]) {
  return { ...DEFAULT_FOLDER_POLICY_CONFIG, excludePaths };
}

// ── pathPrefixes ────────────────────────────────────────────────────

test("prefixes: POSIX, drive root and UNC walk deepest-first", () => {
  assert.deepEqual(pathPrefixes("/mnt/shared/x"), [
    "/mnt/shared/x",
    "/mnt/shared",
    "/mnt",
    "/",
  ]);
  assert.deepEqual(pathPrefixes("/"), ["/"]);
  assert.deepEqual(pathPrefixes("c:/users/me/proj"), [
    "c:/users/me/proj",
    "c:/users/me",
    "c:/users",
    "c:/",
  ]);
  assert.deepEqual(pathPrefixes("c:/"), ["c:/"]);
  assert.deepEqual(pathPrefixes("//server/share/dir/x"), [
    "//server/share/dir/x",
    "//server/share/dir",
    "//server/share",
  ]);
  assert.deepEqual(pathPrefixes(""), []);
});

// ── matching ────────────────────────────────────────────────────────

test("match: the excluded folder itself and its descendants", () => {
  const { dir, cleanup } = tmpDir();
  try {
    const config = withExcludes([dir]);
    const exact = matchExcludedPath(dir, config, dir);
    assert.equal(exact.excluded, true);
    assert.equal(exact.exact, true);
    assert.equal(exact.root, norm(dir));

    const deep = matchExcludedPath(path.join(dir, "a", "b.txt"), config, dir);
    assert.equal(deep.excluded, true);
    assert.equal(deep.exact, false);
    assert.equal(deep.root, norm(dir));
  } finally {
    cleanup();
  }
});

test("match: no exclusion configured is always a miss", () => {
  assert.deepEqual(matchExcludedPath("/anything", withExcludes([]), "/"), {
    excluded: false,
  });
  assert.deepEqual(
    matchExcludedPath("", withExcludes(["/"]), "/"),
    { excluded: false },
  );
  assert.deepEqual(
    matchExcludedPath(42, withExcludes(["/"]), "/"),
    { excluded: false },
  );
});

test("match: sibling names are not prefix collisions", () => {
  const { dir, cleanup } = tmpDir();
  try {
    const config = withExcludes([path.join(dir, "src")]);
    assert.equal(
      matchExcludedPath(path.join(dir, "src", "a.ts"), config, dir).excluded,
      true,
    );
    assert.equal(
      matchExcludedPath(path.join(dir, "src-old", "a.ts"), config, dir).excluded,
      false,
    );
    assert.equal(
      matchExcludedPath(path.join(dir, "srcs", "a.ts"), config, dir).excluded,
      false,
    );
  } finally {
    cleanup();
  }
});

test("match: a directory-name glob covers the folder and its contents", () => {
  const { dir, cleanup } = tmpDir();
  try {
    const config = withExcludes(["**/node_modules"]);
    assert.equal(
      matchExcludedPath(path.join(dir, "node_modules"), config, dir).excluded,
      true,
    );
    assert.equal(
      matchExcludedPath(
        path.join(dir, "node_modules", "pkg", "index.js"),
        config,
        dir,
      ).excluded,
      true,
    );
    assert.equal(
      matchExcludedPath(path.join(dir, "src", "index.ts"), config, dir).excluded,
      false,
    );
    // The matched root is the folder, not the leaf file.
    assert.equal(
      matchExcludedPath(path.join(dir, "node_modules", "x.js"), config, dir)
        .root,
      norm(path.join(dir, "node_modules")),
    );
  } finally {
    cleanup();
  }
});

test("match: a nested exclusion wins over a shallower one", () => {
  const { dir, cleanup } = tmpDir();
  try {
    const config = withExcludes([dir, path.join(dir, "keep", "out")]);
    const nested = matchExcludedPath(
      path.join(dir, "keep", "out", "x.txt"),
      config,
      dir,
    );
    assert.equal(nested.excluded, true);
    assert.equal(nested.root, norm(path.join(dir, "keep", "out")));
    assert.equal(nested.pattern, path.join(dir, "keep", "out").replace(/\\/g, "/"));

    const shallow = matchExcludedPath(path.join(dir, "other", "x.txt"), config, dir);
    assert.equal(shallow.root, norm(dir));
  } finally {
    cleanup();
  }
});

test("match: shell spellings normalise to the same rule", () => {
  const { dir, cleanup } = tmpDir();
  try {
    const backslashed = dir.replace(/\//g, "\\");
    const config = withExcludes([`${backslashed}${path.sep}`]);
    assert.equal(
      matchExcludedPath(path.join(dir, "x.txt"), config, dir).excluded,
      true,
    );
    // A duplicate with different spelling is the same rule.
    const matcher = createExclusionMatcher(
      withExcludes([dir, `${dir}/`, backslashed]),
    );
    assert.equal(matcher.match(path.join(dir, "x.txt"), dir).excluded, true);
  } finally {
    cleanup();
  }
});

test("match: case differences do not create a second rule", () => {
  const { dir, cleanup } = tmpDir();
  try {
    const upper = path.join(dir, "PROJECTS");
    const config = withExcludes([upper]);
    // Globs match case-insensitively, so the lower-case spelling matches too.
    assert.equal(
      matchExcludedPath(path.join(dir, "projects", "x.ts"), config, dir).excluded,
      true,
    );
  } finally {
    cleanup();
  }
});

test("match: a symlink into an excluded tree is excluded", () => {
  const { dir, cleanup } = tmpDir();
  try {
    const excludedDir = path.join(dir, "excluded");
    const linkDir = path.join(dir, "link");
    fs.mkdirSync(excludedDir, { recursive: true });
    try {
      fs.symlinkSync(
        excludedDir,
        linkDir,
        process.platform === "win32" ? "junction" : "dir",
      );
    } catch {
      return; // no symlink privilege on this runner
    }
    const config = withExcludes([excludedDir]);
    const viaLink = matchExcludedPath(path.join(linkDir, "x.txt"), config, dir);
    assert.equal(viaLink.excluded, true);
    assert.equal(
      viaLink.root,
      norm(excludedDir),
      "the canonical path attributes the rule to the real folder",
    );
  } finally {
    cleanup();
  }
});

test("match: a bare name matches that folder at any depth", () => {
  const { dir, cleanup } = tmpDir();
  try {
    const deep = path.join(dir, "a", "build", "out.js");
    assert.equal(matchExcludedPath(deep, withExcludes(["build"]), dir).excluded, true);
    assert.equal(
      matchExcludedPath(path.join(dir, "a", "builder", "out.js"), withExcludes(["build"]), dir)
        .excluded,
      false,
    );
  } finally {
    cleanup();
  }
});

test("match: a catch-all pattern is predictable (the command refuses to store it)", () => {
  const { dir, cleanup } = tmpDir();
  try {
    const any = matchExcludedPath(path.join(dir, "a.ts"), withExcludes(["*"]), dir);
    assert.equal(any.excluded, true);
    // `*` matches the leaf itself, so this is an exact hit.
    assert.equal(any.exact, true);
    const everything = matchExcludedPath(dir, withExcludes(["**"]), dir);
    assert.equal(everything.excluded, true);
  } finally {
    cleanup();
  }
});

test("match: filesystem and drive roots", () => {
  if (process.platform === "win32") {
    assert.equal(
      matchExcludedPath("c:/users/me/proj", withExcludes(["C:/"]), "c:/").excluded,
      true,
    );
    assert.equal(
      matchExcludedPath("c:/", withExcludes(["C:/"]), "c:/").exact,
      true,
    );
    assert.equal(
      matchExcludedPath("d:/other", withExcludes(["C:/"]), "c:/").excluded,
      false,
    );
  } else {
    assert.equal(matchExcludedPath("/etc/passwd", withExcludes(["/"]), "/").excluded, true);
    assert.equal(matchExcludedPath("/", withExcludes(["/"]), "/").exact, true);
  }
  assert.equal(
    matchExcludedPath("//server/share/dir/x", withExcludes(["//server/share"]), "/")
      .excluded,
    true,
  );
});

test("match: home directory exclusion reaches its contents", () => {
  const home = os.homedir();
  const config = withExcludes(["~"]);
  assert.equal(matchExcludedPath(home, config, home).exact, true);
  assert.equal(
    matchExcludedPath(path.join(home, "Documents", "x.txt"), config, home).excluded,
    true,
  );
});

// ── pattern normalisation: drive-relative spellings ──────────────────

test("normalise: Windows drive-relative patterns are repaired, not left inert", () => {
  if (process.platform !== "win32") {
    // NOOP on POSIX: a `c:` prefix is not a drive there.
    assert.equal(normalizeExcludePattern("c:Personal"), "c:Personal");
    return;
  }
  assert.equal(normalizeExcludePattern("C:Personal"), "C:/Personal");
  assert.equal(normalizeExcludePattern("c:Personal"), "c:/Personal");
  assert.equal(normalizeExcludePattern("C:Personal/"), "C:/Personal");
  // The repaired form actually excludes the folder.
  const config = withExcludes([normalizeExcludePattern("C:Personal")]);
  const hit = matchExcludedPath("C:/Personal/secret.txt", config, "C:/work");
  assert.equal(hit.excluded, true);
  assert.equal(hit.root, "c:/personal");
  // Already-slashed spellings are untouched.
  assert.equal(normalizeExcludePattern("C:/Personal"), "C:/Personal");
  assert.equal(normalizeExcludePattern("C:/"), "C:/");
});

// ── broadness: roots and home only ───────────────────────────────────

test("broad: only a filesystem/drive/share root or the home directory", () => {
  assert.equal(isBroadExcludePattern("/"), true);
  assert.equal(isBroadExcludePattern("//server/share"), true);
  assert.equal(isBroadExcludePattern(os.homedir()), true);
  assert.equal(isBroadExcludePattern("~"), true);
  if (process.platform === "win32") {
    assert.equal(isBroadExcludePattern("C:/"), true);
    assert.equal(isBroadExcludePattern("c:/"), true);
    // A specific top-level folder is a precise exclusion, not a broad root.
    assert.equal(isBroadExcludePattern("C:/Personal"), false);
    assert.equal(isBroadExcludePattern("D:/Data"), false);
  }
  assert.equal(isBroadExcludePattern("C:/Users/Someone/Projects"), false);
  assert.equal(isBroadExcludePattern(path.join(os.homedir(), "Projects")), false);
  assert.equal(isBroadExcludePattern("**/node_modules"), false);
  assert.equal(isBroadExcludePattern(""), false);
  assert.equal(isBroadExcludePattern(42), false);
});

// ── enforcement regression: normalisation must not move the semantics ──

test("enforcement: the excluded root blocks, a child is outside, a grant rescues one subtree", () => {
  const { dir, cleanup } = tmpDir();
  try {
    const excluded = path.join(dir, "Personal");
    const granted = path.join(excluded, "sub");
    const config = withExcludes([excluded]);
    const evaluate = (target: string, grants: string[] = []) =>
      evaluateFolderTargets([{ path: target, kind: "file" }], {
        config,
        grants,
        cwd: dir,
        action: "read",
      });

    // The root itself is a hard block (never a dialog, never outside).
    const atRoot = evaluateFolderTargets(
      [{ path: excluded, kind: "dir" }],
      { config, grants: [], cwd: dir, action: "read" },
    );
    assert.equal(atRoot.excluded.length, 1);
    assert.equal(atRoot.outside.length, 0);
    assert.equal(atRoot.allowed.length, 0);

    // A child is outside and is attributed to the excluded root.
    const child = evaluate(path.join(excluded, "secret.txt"));
    assert.equal(child.excluded.length, 0);
    assert.equal(child.outside.length, 1);
    assert.equal(child.allowed.length, 0);
    assert.equal(child.outside[0]?.excludeRoot, norm(excluded));

    // A grant inside re-opens exactly that subtree, nothing else.
    const rescued = evaluate(path.join(granted, "x.ts"), [granted]);
    assert.equal(rescued.allowed.length, 1);
    assert.equal(rescued.outside.length, 0);
    const sibling = evaluate(path.join(excluded, "other", "y.ts"), [granted]);
    assert.equal(sibling.allowed.length, 0);
    assert.equal(sibling.outside.length, 1);

    // Normalisation is enforcement-neutral: the repaired drive-relative
    // spelling produces the same verdict as the slashed one.
    if (process.platform === "win32") {
      const slashed = { ...config, excludePaths: ["C:/Personal"] };
      const repaired = { ...config, excludePaths: ["C:Personal"] };
      for (const candidate of [slashed, repaired]) {
        const verdict = evaluateFolderTargets(
          [{ path: "C:/Personal/secret.txt", kind: "file" }],
          { config: candidate, grants: [], cwd: "C:/work", action: "read" },
        );
        assert.equal(verdict.outside.length, 1);
        assert.equal(verdict.allowed.length, 0);
      }
    }
  } finally {
    cleanup();
  }
});
