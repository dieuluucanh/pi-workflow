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
  matchExcludedPath,
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
