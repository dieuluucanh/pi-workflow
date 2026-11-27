/**
 * Workflow Extension — Shared Folder Policy tests
 *
 * Run with: npm test   (node --test, type-stripping — no build step)
 *
 * Covers config coercion/merge/trust/round-trips, repo-root detection, the
 * repo/cwd/parent/any roots, lexical + canonical containment, the sensitive
 * deny list and template exemptions, network/broad targets, and the pure
 * folder decision.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  DEFAULT_FOLDER_POLICY_CONFIG,
  DEFAULT_SENSITIVE_EXEMPTIONS,
  DEFAULT_SENSITIVE_PATTERNS,
  EXCLUDE_USAGE,
  FOLDER_POLICY_KEY,
  baseFolderRoots,
  broadGrantRootReason,
  canonicalizePolicyPath,
  coerceFolderPolicyConfig,
  combineGateDecisions,
  decideFolderGate,
  describeFolderEvaluation,
  describeFolderPolicyMode,
  detectRepoRoot,
  effectiveSensitiveExemptions,
  evaluateFolderTargets,
  evaluateBaseCoverage,
  extractFolderPolicyRaw,
  folderPolicyArgumentCompletions,
  folderPolicyConfigPaths,
  globToRegExp,
  isBroadGrantRoot,
  isInsideAnyRoot,
  isInsidePolicyPath,
  isNetworkPath,
  matchSensitivePath,
  mergeFolderPolicyConfig,
  normalizeExcludePattern,
  normalizePolicyPath,
  parseExcludeArgs,
  readFolderPolicyConfig,
  resolveFolderRoots,
  revokeFolderPolicyListEntry,
  splitPolicyArgs,
  writeFolderPolicyConfig,
} from "./folder-policy.ts";
import { WORKFLOW_SETTINGS_KEY, commitConfigPaths } from "./commit-policy.ts";
import { translateForeignPath } from "./utils.ts";
import { analyzeShellPaths } from "./shell-paths.ts";
import { writePolicyConfigPaths } from "./edit-policy.ts";
import { readPolicyConfigPaths } from "./read-policy.ts";

function tmpCwd(): { cwd: string; agentDir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-folder-policy-"));
  const cwd = path.join(dir, "proj");
  const agentDir = path.join(dir, "agent");
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(agentDir, { recursive: true });
  return {
    cwd,
    agentDir,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

function writeJson(fp: string, value: unknown): void {
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

// ── coerce / extract / merge ────────────────────────────────────────

test("coerce: defaults, bare mode, garbage and wrong types", () => {
  assert.deepEqual(coerceFolderPolicyConfig(undefined), {
    ...DEFAULT_FOLDER_POLICY_CONFIG,
  });
  assert.equal(coerceFolderPolicyConfig("parent").mode, "parent");
  assert.equal(coerceFolderPolicyConfig("  ANY  ").mode, "any");
  assert.equal(coerceFolderPolicyConfig("bogus").mode, "repo");
  assert.equal(coerceFolderPolicyConfig(42).mode, "repo");
  assert.equal(coerceFolderPolicyConfig({ mode: 7 }).mode, "repo");
  assert.equal(
    coerceFolderPolicyConfig({ outside: "block" }).outside,
    "block",
  );
  assert.equal(
    coerceFolderPolicyConfig({ grantScope: "global" }).grantScope,
    "global",
  );
  assert.equal(
    coerceFolderPolicyConfig({ sensitiveTemplates: "block" })
      .sensitiveTemplates,
    "block",
  );
  assert.deepEqual(
    coerceFolderPolicyConfig({
      sensitivePatterns: [" **/*.sql ", "", 7, "**/*.sql"],
      sensitiveExemptions: ["**/demo.env"],
    }).sensitivePatterns,
    ["**/*.sql"],
  );
  // Exclusions are normalised globs, never throw, and default to empty.
  assert.deepEqual(coerceFolderPolicyConfig(undefined).excludePaths, []);
  assert.deepEqual(
    coerceFolderPolicyConfig({
      excludePaths: [" C:\\Users\\Me\\ ", "", 7, "c:/users/me"],
    }).excludePaths,
    ["C:/Users/Me"],
  );
  assert.deepEqual(
    coerceFolderPolicyConfig({ excludePaths: "C:/" }).excludePaths,
    [],
  );
});

test("exclude: patterns normalise shell spellings, keep roots intact", () => {
  assert.equal(normalizeExcludePattern("  C:\\Users\\Me\\Projects  "), "C:/Users/Me/Projects");
  assert.equal(normalizeExcludePattern("C:/"), "C:/",);
  assert.equal(normalizeExcludePattern("/"), "/");
  assert.equal(normalizeExcludePattern("//server/share/"), "//server/share");
  assert.equal(normalizeExcludePattern("./build"), "build");
  assert.equal(normalizeExcludePattern("a//b"), "a/b");
  assert.equal(normalizeExcludePattern(""), "");
  assert.equal(normalizeExcludePattern(42), "");
  assert.equal(normalizeExcludePattern("~"), os.homedir().replace(/\\/g, "/"));
});

test("extract: pulls workflow.folderPolicy only from valid settings", () => {
  const extracted = extractFolderPolicyRaw({
    [WORKFLOW_SETTINGS_KEY]: { [FOLDER_POLICY_KEY]: { mode: "cwd" } },
  });
  assert.equal(
    typeof extracted === "object" ? extracted?.mode : extracted,
    "cwd",
  );
  assert.equal(
    extractFolderPolicyRaw({
      [WORKFLOW_SETTINGS_KEY]: { [FOLDER_POLICY_KEY]: "parent" },
    }),
    "parent",
  );
  assert.equal(extractFolderPolicyRaw(undefined), undefined);
  assert.equal(extractFolderPolicyRaw({ workflow: [] }), undefined);
  assert.equal(
    extractFolderPolicyRaw({ workflow: { [FOLDER_POLICY_KEY]: 3 } }),
    undefined,
  );
});

test("merge: scalars project-over-global, pattern lists unioned", () => {
  const merged = mergeFolderPolicyConfig(
    {
      mode: "cwd",
      outside: "ask",
      sensitivePatterns: ["**/*.a"],
      sensitiveExemptions: ["**/global.env"],
      excludePaths: ["C:/", "~"],
    },
    {
      mode: "parent",
      outside: "block",
      sensitivePatterns: ["**/*.b"],
      sensitiveExemptions: ["**/project.env"],
      excludePaths: ["/mnt/shared", "C:/"] as string[],
    },
  );
  assert.equal(merged.mode, "parent");
  assert.equal(merged.outside, "block");
  assert.deepEqual(merged.sensitivePatterns, ["**/*.a", "**/*.b"]);
  assert.deepEqual(merged.sensitiveExemptions, [
    "**/global.env",
    "**/project.env",
  ]);
  assert.deepEqual(merged.excludePaths, ["C:/", os.homedir().replace(/\\/g, "/"), "/mnt/shared"]);
});

// ── read / write / trust / lock ─────────────────────────────────────

test("settings: MSYS cwd resolves to the same native project paths", () => {
  if (process.platform !== "win32") return;
  const { cwd, agentDir, cleanup } = tmpCwd();
  try {
    const msys = cwd.replace(/^([A-Za-z]):[\\/]/, "/$1/");
    const expected = path.join(cwd, ".pi", "settings.json");
    assert.equal(folderPolicyConfigPaths(msys, agentDir).project, expected);
    assert.equal(writePolicyConfigPaths(msys, agentDir).project, expected);
    assert.equal(readPolicyConfigPaths(msys, agentDir).project, expected);
    assert.equal(commitConfigPaths(msys, agentDir).project, expected);
  } finally {
    cleanup();
  }
});

test("regression: the reported MSYS command stays inside the repository", () => {
  const { cwd, cleanup } = tmpCwd();
  try {
    fs.mkdirSync(path.join(cwd, ".git"));
    const target = path.join(
      cwd,
      "node_modules",
      "@earendil-works",
      "pi-coding-agent",
      "dist",
    );
    fs.mkdirSync(target, { recursive: true });
    const posixCwd = cwd.replace(/\\/g, "/");
    const shellCwd =
      process.platform === "win32"
        ? posixCwd.replace(/^([A-Za-z]):\//, "/$1/")
        : posixCwd;
    const command = `cd ${shellCwd}/node_modules/@earendil-works/pi-coding-agent && rg -l "profile" dist | head -20`;
    const analysis = analyzeShellPaths(command, cwd);
    const evaluation = evaluateFolderTargets(analysis.reads, {
      config: { ...DEFAULT_FOLDER_POLICY_CONFIG, mode: "repo" },
      grants: [],
      cwd,
    });
    assert.deepEqual(evaluation.outside, []);
  } finally {
    cleanup();
  }
});

test("read: missing files fall back to defaults", () => {
  const { cwd, agentDir, cleanup } = tmpCwd();
  try {
    const resolved = readFolderPolicyConfig(cwd, agentDir, { trusted: true });
    assert.equal(resolved.config.mode, "repo");
    assert.equal(resolved.config.outside, "ask");
    assert.equal(resolved.sources.mode, "default");
  } finally {
    cleanup();
  }
});

test("read: project settings ignored unless trusted", () => {
  const { cwd, agentDir, cleanup } = tmpCwd();
  try {
    writeJson(path.join(cwd, ".pi", "settings.json"), {
      [WORKFLOW_SETTINGS_KEY]: {
        [FOLDER_POLICY_KEY]: { mode: "parent", outside: "block" },
      },
    });
    const untrusted = readFolderPolicyConfig(cwd, agentDir, { trusted: false });
    assert.equal(untrusted.config.mode, "repo");
    assert.equal(untrusted.sources.projectIgnored, true);
    const trusted = readFolderPolicyConfig(cwd, agentDir, { trusted: true });
    assert.equal(trusted.config.mode, "parent");
    assert.equal(trusted.config.outside, "block");
    assert.equal(trusted.sources.mode, "project");
  } finally {
    cleanup();
  }
});

test("exclude: project excludes are ignored unless the project is trusted", () => {
  const { cwd, agentDir, cleanup } = tmpCwd();
  try {
    writeJson(path.join(cwd, ".pi", "settings.json"), {
      [WORKFLOW_SETTINGS_KEY]: {
        [FOLDER_POLICY_KEY]: { excludePaths: ["C:/"] },
      },
    });
    const untrusted = readFolderPolicyConfig(cwd, agentDir, { trusted: false });
    assert.deepEqual(untrusted.config.excludePaths, []);
    assert.equal(untrusted.sources.projectIgnored, true);
    const trusted = readFolderPolicyConfig(cwd, agentDir, { trusted: true });
    assert.deepEqual(trusted.config.excludePaths, ["C:/"]);
  } finally {
    cleanup();
  }
});

test("write: read-modify-write preserves other keys and unions lists", () => {
  const { cwd, agentDir, cleanup } = tmpCwd();
  try {
    writeJson(path.join(agentDir, "settings.json"), {
      theme: "dark",
      [WORKFLOW_SETTINGS_KEY]: {
        [FOLDER_POLICY_KEY]: {
          mode: "cwd",
          sensitivePatterns: ["**/*.a"],
          excludePaths: ["C:\\"] as string[],
        },
        reviewMode: { enabled: true },
      },
    });
    const res = writeFolderPolicyConfig("global", cwd, agentDir, {
      mode: "parent",
      sensitivePatterns: ["**/*.b"],
      excludePaths: ["/mnt/shared", "c:/"] as string[],
    });
    assert.equal(res.ok, true);
    const raw = JSON.parse(fs.readFileSync(res.path, "utf8"));
    assert.equal(raw.theme, "dark");
    assert.equal(raw.workflow.reviewMode.enabled, true);
    assert.equal(raw.workflow.folderPolicy.mode, "parent");
    assert.deepEqual(raw.workflow.folderPolicy.sensitivePatterns, [
      "**/*.a",
      "**/*.b",
    ]);
    // Additive and de-duplicated after normalisation.
    assert.deepEqual(raw.workflow.folderPolicy.excludePaths, ["C:/", "/mnt/shared"]);
  } finally {
    cleanup();
  }
});

test("exclude: revoke removes exactly one entry and keeps every other key", () => {
  const { cwd, agentDir, cleanup } = tmpCwd();
  try {
    writeJson(path.join(agentDir, "settings.json"), {
      theme: "dark",
      [WORKFLOW_SETTINGS_KEY]: {
        [FOLDER_POLICY_KEY]: {
          mode: "cwd",
          sensitivePatterns: ["**/*.sql"],
          excludePaths: ["C:\\", "~"],
        },
        writePolicy: { mode: "allow" },
      },
    });
    const res = revokeFolderPolicyListEntry(
      "global",
      cwd,
      agentDir,
      "excludePaths",
      "c:\\",
    );
    assert.equal(res.ok, true);
    assert.equal(res.removed, true);
    const raw = JSON.parse(fs.readFileSync(res.path, "utf8"));
    assert.equal(raw.theme, "dark");
    assert.equal(raw.workflow.writePolicy.mode, "allow");
    assert.deepEqual(raw.workflow.folderPolicy.excludePaths, [
      os.homedir().replace(/\\/g, "/"),
    ]);
    assert.deepEqual(raw.workflow.folderPolicy.sensitivePatterns, ["**/*.sql"]);
    assert.equal(raw.workflow.folderPolicy.mode, "cwd");
    // A second revoke of the same entry is a no-op, not an error.
    const again = revokeFolderPolicyListEntry(
      "global",
      cwd,
      agentDir,
      "excludePaths",
      "C:/",
    );
    assert.equal(again.ok, true);
    assert.equal(again.removed, false);
    // Missing files and unrelated keys are handled without throwing.
    const missing = revokeFolderPolicyListEntry(
      "project",
      cwd,
      agentDir,
      "excludePaths",
      "C:/",
    );
    assert.equal(missing.ok, true);
    assert.equal(missing.removed, false);
    assert.equal(
      revokeFolderPolicyListEntry("global", cwd, agentDir, "excludePaths", "  ")
        .removed,
      false,
    );
  } finally {
    cleanup();
  }
});

test("exclude: revoke is refused while a subagent lock is active", () => {
  const { cwd, agentDir, cleanup } = tmpCwd();
  const previous = process.env.PI_FOLDER_POLICY_LOCKED;
  try {
    writeJson(path.join(agentDir, "settings.json"), {
      [WORKFLOW_SETTINGS_KEY]: {
        [FOLDER_POLICY_KEY]: { excludePaths: ["C:/"] },
      },
    });
    process.env.PI_FOLDER_POLICY_LOCKED = "1";
    const res = revokeFolderPolicyListEntry(
      "global",
      cwd,
      agentDir,
      "excludePaths",
      "C:/",
    );
    assert.equal(res.ok, false);
    assert.equal(res.removed, false);
    assert.match(String(res.error), /locked/);
    const raw = JSON.parse(fs.readFileSync(res.path, "utf8"));
    assert.deepEqual(raw.workflow.folderPolicy.excludePaths, ["C:/"]);
  } finally {
    if (previous === undefined)
      delete process.env.PI_FOLDER_POLICY_LOCKED;
    else process.env.PI_FOLDER_POLICY_LOCKED = previous;
    cleanup();
  }
});

test("write: corrupt file is replaced, not merged blindly", () => {
  const { cwd, agentDir, cleanup } = tmpCwd();
  try {
    writeJson(path.join(agentDir, "settings.json"), "not-an-object");
    const res = writeFolderPolicyConfig("global", cwd, agentDir, {
      mode: "any",
    });
    assert.equal(res.ok, true);
    const raw = JSON.parse(fs.readFileSync(res.path, "utf8"));
    assert.equal(raw.workflow.folderPolicy.mode, "any");
  } finally {
    cleanup();
  }
});

test("lock: env roots replace base/grants and ignore project settings", () => {
  const { cwd, agentDir, cleanup } = tmpCwd();
  const previous = {
    locked: process.env.PI_FOLDER_POLICY_LOCKED,
    roots: process.env.PI_FOLDER_POLICY_ROOTS,
  };
  try {
    writeJson(path.join(cwd, ".pi", "settings.json"), {
      [WORKFLOW_SETTINGS_KEY]: {
        [FOLDER_POLICY_KEY]: { mode: "any" },
      },
    });
    process.env.PI_FOLDER_POLICY_LOCKED = "1";
    process.env.PI_FOLDER_POLICY_ROOTS = JSON.stringify([cwd]);
    const resolved = readFolderPolicyConfig(cwd, agentDir, { trusted: true });
    assert.equal(resolved.config.mode, "cwd");
    assert.equal(resolved.config.outside, "block");
    assert.deepEqual(resolved.locked?.roots, [cwd]);
    const roots = resolveFolderRoots(
      resolved.config,
      ["/somewhere/else"],
      cwd,
      resolved.locked?.roots,
    );
    assert.equal(roots.lexical.length, 1);
    assert.equal(
      roots.lexical[0],
      normalizePolicyPath(cwd, cwd),
    );
  } finally {
    if (previous.locked === undefined)
      delete process.env.PI_FOLDER_POLICY_LOCKED;
    else process.env.PI_FOLDER_POLICY_LOCKED = previous.locked;
    if (previous.roots === undefined) delete process.env.PI_FOLDER_POLICY_ROOTS;
    else process.env.PI_FOLDER_POLICY_ROOTS = previous.roots;
    cleanup();
  }
});

// ── path canonicalisation / repo roots ──────────────────────────────

test("path: tilde/@/relative/trailing slash normalisation", () => {
  const { cwd, cleanup } = tmpCwd();
  try {
    assert.equal(
      normalizePolicyPath("./a/../b/", cwd),
      normalizePolicyPath(path.join(cwd, "b"), cwd),
    );
    assert.equal(
      normalizePolicyPath("@src/app.ts", cwd),
      normalizePolicyPath(path.join(cwd, "src/app.ts"), cwd),
    );
    assert.equal(
      normalizePolicyPath("~", cwd),
      normalizePolicyPath(os.homedir(), cwd),
    );
    assert.equal(normalizePolicyPath("", cwd), "");
  } finally {
    cleanup();
  }
});

test("path: foreign shell syntax is translated without case folding", () => {
  const { cwd, cleanup } = tmpCwd();
  try {
    if (process.platform === "win32") {
      assert.equal(
        normalizePolicyPath("/c/Users/Lenovo/repo", cwd),
        "c:/users/lenovo/repo",
      );
      assert.equal(
        normalizePolicyPath("/cygdrive/c/Users/Lenovo/repo", cwd),
        "c:/users/lenovo/repo",
      );
      assert.equal(
        normalizePolicyPath("/mnt/c/Users/Lenovo/repo", cwd),
        "c:/users/lenovo/repo",
      );
      assert.equal(normalizePolicyPath("/c", cwd), "c:/");
      assert.equal(
        translateForeignPath("/c/Users/Lenovo/repo").path,
        "C:/Users/Lenovo/repo",
      );
      assert.equal(translateForeignPath("C:foo").uncertain, true);
      assert.equal(translateForeignPath("\\\\.\\disk").uncertain, true);
      assert.equal(
        translateForeignPath("\\\\server\\share\\dir").path,
        "\\\\server\\share\\dir",
      );
    } else {
      assert.equal(
        normalizePolicyPath("/c/Users/Lenovo/repo", cwd),
        "/c/users/lenovo/repo",
      );
    }
  } finally {
    cleanup();
  }
});

test("path: containment respects directory boundaries", () => {
  const root = normalizePolicyPath("/repo/src", "/repo");
  assert.equal(
    isInsidePolicyPath(normalizePolicyPath("/repo/src/a.ts", "/repo"), root),
    true,
  );
  assert.equal(
    isInsidePolicyPath(normalizePolicyPath("/repo/src-old/a.ts", "/repo"), root),
    false,
  );
  assert.equal(
    isInsideAnyRoot(normalizePolicyPath("/repo/src/a.ts", "/repo"), [root]),
    true,
  );
});

test("canonical: nearest existing ancestor resolves the rest", () => {
  const { cwd, cleanup } = tmpCwd();
  try {
    const missing = path.join(cwd, "missing", "file.ts");
    const result = canonicalizePolicyPath(missing, cwd);
    assert.equal(result.resolved, true);
    assert.equal(result.path, normalizePolicyPath(missing, cwd));
  } finally {
    cleanup();
  }
});

test("repo: detects a .git directory and a worktree .git file", () => {
  const { cwd, cleanup } = tmpCwd();
  try {
    const repo = path.join(cwd, "repo");
    const nested = path.join(repo, "packages", "app");
    fs.mkdirSync(nested, { recursive: true });
    fs.mkdirSync(path.join(repo, ".git"));
    assert.equal(detectRepoRoot(nested), normalizePolicyPath(repo, nested));

    const worktree = path.join(cwd, "worktree");
    fs.mkdirSync(path.join(worktree, "src"), { recursive: true });
    fs.writeFileSync(path.join(worktree, ".git"), "gitdir: ../repo/.git\n");
    assert.equal(
      detectRepoRoot(path.join(worktree, "src")),
      normalizePolicyPath(worktree, cwd),
    );
  } finally {
    cleanup();
  }
});

test("repo: no .git falls back to cwd", () => {
  const { cwd, cleanup } = tmpCwd();
  try {
    assert.equal(detectRepoRoot(cwd), null);
    const roots = baseFolderRoots({ ...DEFAULT_FOLDER_POLICY_CONFIG }, cwd);
    assert.deepEqual(roots, [normalizePolicyPath(cwd, cwd)]);
  } finally {
    cleanup();
  }
});

test("roots: repo, cwd, parent and any", () => {
  const { cwd, cleanup } = tmpCwd();
  try {
    const repo = path.join(cwd, "repo");
    const nested = path.join(repo, "a", "b");
    fs.mkdirSync(nested, { recursive: true });
    fs.mkdirSync(path.join(repo, ".git"));
    const repoNorm = normalizePolicyPath(repo, nested);
    assert.deepEqual(
      baseFolderRoots({ ...DEFAULT_FOLDER_POLICY_CONFIG, mode: "repo" }, nested),
      [repoNorm],
    );
    assert.deepEqual(
      baseFolderRoots({ ...DEFAULT_FOLDER_POLICY_CONFIG, mode: "cwd" }, nested),
      [normalizePolicyPath(nested, nested)],
    );
    assert.deepEqual(
      baseFolderRoots(
        { ...DEFAULT_FOLDER_POLICY_CONFIG, mode: "parent" },
        nested,
      ),
      [normalizePolicyPath(path.dirname(repo), nested)],
    );
    assert.deepEqual(
      baseFolderRoots({ ...DEFAULT_FOLDER_POLICY_CONFIG, mode: "any" }, nested),
      [],
    );
  } finally {
    cleanup();
  }
});

test("roots: a symlinked cwd is canonicalised", () => {
  const { cwd, cleanup } = tmpCwd();
  try {
    const target = path.join(cwd, "real");
    const link = path.join(cwd, "link");
    fs.mkdirSync(target);
    try {
      fs.symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
    } catch {
      return; // symlink privilege is not available on this runner
    }
    const roots = resolveFolderRoots(
      { ...DEFAULT_FOLDER_POLICY_CONFIG, mode: "cwd" },
      [],
      link,
    );
    assert.equal(roots.canonical.length, 1);
    assert.ok(
      roots.canonical[0].endsWith("/real") ||
        roots.canonical[0].endsWith("\\real"),
    );
  } finally {
    cleanup();
  }
});

// ── sensitive matching ──────────────────────────────────────────────

test("sensitive: defaults block .env and credentials, templates are allowed", () => {
  const { cwd, cleanup } = tmpCwd();
  try {
    const config = { ...DEFAULT_FOLDER_POLICY_CONFIG };
    assert.equal(matchSensitivePath(".env", config, cwd).sensitive, true);
    assert.equal(matchSensitivePath(".env.local", config, cwd).sensitive, true);
    assert.equal(matchSensitivePath(".env.example", config, cwd).sensitive, false);
    assert.equal(matchSensitivePath(".env.sample", config, cwd).sensitive, false);
    assert.equal(matchSensitivePath("config/credentials.json", config, cwd).sensitive, true);
    assert.equal(matchSensitivePath("keys/id_rsa", config, cwd).sensitive, true);
    assert.equal(matchSensitivePath("keys/server.pem", config, cwd).sensitive, true);
    assert.equal(matchSensitivePath("src/app.ts", config, cwd).sensitive, false);
    assert.equal(matchSensitivePath(".ssh/id_ed25519", config, cwd).sensitive, true);
    assert.equal(matchSensitivePath(".ssh", config, cwd).sensitive, true);
  } finally {
    cleanup();
  }
});

test("sensitive: sensitiveTemplates=block and manual exemptions", () => {
  const { cwd, cleanup } = tmpCwd();
  try {
    const blocked = {
      ...DEFAULT_FOLDER_POLICY_CONFIG,
      sensitiveTemplates: "block" as const,
    };
    assert.equal(matchSensitivePath(".env.example", blocked, cwd).sensitive, true);
    const exempt = {
      ...DEFAULT_FOLDER_POLICY_CONFIG,
      sensitiveExemptions: ["**/.env.local"],
    };
    assert.equal(matchSensitivePath(".env.local", exempt, cwd).sensitive, false);
    assert.equal(matchSensitivePath(".env", exempt, cwd).sensitive, true);
  } finally {
    cleanup();
  }
});

test("sensitive: extra patterns and effective lists", () => {
  const { cwd, cleanup } = tmpCwd();
  try {
    const config = {
      ...DEFAULT_FOLDER_POLICY_CONFIG,
      sensitivePatterns: ["**/*.sql"],
    };
    assert.equal(matchSensitivePath("db/dump.sql", config, cwd).sensitive, true);
    assert.ok(effectiveSensitiveExemptions(config).includes("**/.env.example"));
    assert.ok(effectiveSensitiveExemptions(config).length >= 4);
  } finally {
    cleanup();
  }
});

test("glob: suffix matching for files and directories", () => {
  assert.equal(globToRegExp("**/.env").test("/a/b/.env"), true);
  assert.equal(globToRegExp("**/.env.*").test("/a/.env.local"), true);
  assert.equal(globToRegExp("**/.ssh/**").test("/home/u/.ssh/id_rsa"), true);
  assert.equal(globToRegExp("**/.ssh").test("/home/u/.ssh"), true);
  assert.equal(globToRegExp("**/.ssh/**").test("/home/u/.ssh"), true);
  assert.equal(globToRegExp("*.pem").test("/a/b/key.pem"), true);
  assert.equal(globToRegExp(".git/config").test("/repo/.git/config"), true);
});

test("network: UNC and /net paths", () => {
  assert.equal(isNetworkPath("\\\\server\\share\\x"), true);
  assert.equal(isNetworkPath("//server/share/x"), true);
  assert.equal(isNetworkPath("/net/server/x"), true);
  assert.equal(isNetworkPath("C:/repo/x"), false);
});

// ── evaluation / decision ───────────────────────────────────────────

test("evaluate: sensitive wins, outside/allowed are separated", () => {
  const { cwd, cleanup } = tmpCwd();
  try {
    const config = { ...DEFAULT_FOLDER_POLICY_CONFIG, mode: "cwd" as const };
    const evaluation = evaluateFolderTargets(
      [
        { path: path.join(cwd, "src/app.ts"), kind: "file" },
        { path: ".env", kind: "file" },
        { path: path.join(cwd, "..", "other", "x.ts"), kind: "file" },
      ],
      { config, grants: [], cwd },
    );
    assert.equal(evaluation.sensitive.length, 1);
    assert.equal(evaluation.allowed.length, 1);
    assert.equal(evaluation.outside.length, 1);
  } finally {
    cleanup();
  }
});

test("evaluate: grants cover outside paths; file grants work", () => {
  const { cwd, cleanup } = tmpCwd();
  try {
    const sibling = path.join(cwd, "..", "sibling");
    fs.mkdirSync(sibling, { recursive: true });
    const file = path.join(sibling, "notes.md");
    fs.writeFileSync(file, "ok");
    const config = { ...DEFAULT_FOLDER_POLICY_CONFIG, mode: "cwd" as const };
    const dirGrant = evaluateFolderTargets(
      [{ path: file, kind: "file" }],
      { config, grants: [sibling], cwd },
    );
    assert.equal(dirGrant.outside.length, 0);
    const fileGrant = evaluateFolderTargets(
      [{ path: file, kind: "file" }],
      { config, grants: [file], cwd },
    );
    assert.equal(fileGrant.outside.length, 0);
  } finally {
    cleanup();
  }
});

test("evaluate: any mode still forces a network grant", () => {
  const { cwd, cleanup } = tmpCwd();
  try {
    const config = { ...DEFAULT_FOLDER_POLICY_CONFIG, mode: "any" as const };
    const evaluation = evaluateFolderTargets(
      [{ path: path.join(cwd, "x"), kind: "file" }],
      { config, grants: [], cwd },
    );
    assert.equal(evaluation.outside.length, 0);
    const network = evaluateFolderTargets(
      [{ path: "//server/share/x", kind: "file" }],
      { config, grants: [], cwd },
    );
    assert.ok(network.network.length > 0);
    assert.ok(network.outside.length > 0);
  } finally {
    cleanup();
  }
});

test("evaluate: symlink escape is not allowed", () => {
  const { cwd, cleanup } = tmpCwd();
  try {
    const outside = path.join(cwd, "..", "outside-secret");
    fs.mkdirSync(outside, { recursive: true });
    const link = path.join(cwd, "link");
    try {
      fs.symlinkSync(
        outside,
        link,
        process.platform === "win32" ? "junction" : "dir",
      );
    } catch {
      return;
    }
    const evaluation = evaluateFolderTargets(
      [{ path: path.join(link, "x.ts"), kind: "file" }],
      { config: { ...DEFAULT_FOLDER_POLICY_CONFIG, mode: "cwd" }, grants: [], cwd },
    );
    assert.equal(evaluation.outside.length, 1);
  } finally {
    cleanup();
  }
});

test("decide: sensitive always blocks; outside ask/block; combine order", () => {
  assert.equal(
    decideFolderGate({
      sensitive: true,
      outside: false,
      outsideAction: "ask",
    }),
    "block",
  );
  assert.equal(
    decideFolderGate({
      sensitive: false,
      outside: true,
      outsideAction: "ask",
    }),
    "ask",
  );
  assert.equal(
    decideFolderGate({
      sensitive: false,
      outside: true,
      outsideAction: "block",
    }),
    "block",
  );
  assert.equal(
    decideFolderGate({
      sensitive: false,
      outside: true,
      outsideAction: "ask",
      granted: true,
    }),
    "allow",
  );
  // An unverifiable target follows the chosen outside action: "ask" asks,
  // "block" refuses without opening a dialog.
  assert.equal(
    decideFolderGate({
      sensitive: false,
      outside: false,
      outsideAction: "ask",
      uncertain: true,
    }),
    "ask",
  );
  assert.equal(
    decideFolderGate({
      sensitive: false,
      outside: false,
      outsideAction: "block",
      uncertain: true,
    }),
    "block",
  );
  assert.equal(combineGateDecisions("allow", "ask"), "ask");
  assert.equal(combineGateDecisions("ask", "block"), "block");
  assert.equal(combineGateDecisions(undefined, "allow"), "allow");
});

test("describe: every mode has text", () => {
  for (const mode of ["repo", "cwd", "parent", "any"] as const) {
    assert.ok(describeFolderPolicyMode(mode).length > 0);
  }
});

test("describeFolderEvaluation: counts and lists every verdict", () => {
  const lines = describeFolderEvaluation(
    {
      sensitive: [{ path: "c:/work/.env", pattern: "**/.env" }],
      excluded: [{ path: "c:/", pattern: "C:/", root: "c:/" }],
      outside: [{ path: "c:/other/x.ts", kind: "file" }],
      allowed: [{ path: "c:/work/src/a.ts", kind: "file" }],
      network: [{ path: "//server/share/x.ts", kind: "file" }],
      broad: [],
      uncertain: ["c:/work/bad"],
    },
    "c:/work",
  );
  assert.match(lines[0] ?? "", /c:\/work/);
  assert.match(
    lines[1] ?? "",
    /1 inside, 1 outside, 1 excluded, 1 sensitive, 1 unverifiable/,
  );
  assert.ok(lines.some((line) => line.includes("inside: c:/work/src/a.ts")));
  assert.ok(lines.some((line) => line.includes("outside: c:/other/x.ts")));
  assert.ok(lines.some((line) => line.includes("excluded: c:/ (C:/)")));
  assert.ok(lines.some((line) => line.includes("network: //server/share/x.ts")));
  assert.ok(lines.some((line) => line.includes("sensitive: c:/work/.env (**/.env)")));
  assert.ok(lines.some((line) => line.includes("unverifiable: c:/work/bad")));
});

test("broad: roots/home are refused, project folders are not", () => {
  assert.equal(isBroadGrantRoot(path.parse(process.cwd()).root), true);
  assert.equal(isBroadGrantRoot(os.homedir()), true);
  assert.equal(isBroadGrantRoot(path.join(os.homedir(), "projects", "app")), false);
});

test("broad: reasons name the root/home/protected folder", () => {
  assert.match(
    broadGrantRootReason(path.parse(process.cwd()).root) ?? "",
    /filesystem root/,
  );
  assert.match(broadGrantRootReason(os.homedir()) ?? "", /home folder/);
  assert.match(
    broadGrantRootReason(path.join(os.homedir(), "..")) ?? "",
    /parent folder of your home/,
  );
  assert.equal(
    broadGrantRootReason(
      path.join(path.parse(process.cwd()).root, "pi-grant-probe"),
    ),
    undefined,
  );
  if (process.platform === "win32") {
    assert.match(
      broadGrantRootReason(path.join(os.homedir(), "AppData")) ?? "",
      /protected system folder/,
    );
  } else {
    assert.match(broadGrantRootReason("/etc") ?? "", /protected system folder/);
    assert.equal(broadGrantRootReason("/etc/ssl/certs"), undefined);
  }
});

test("broad: protected roots only, not every depth-1 folder", () => {
  const root = path.parse(process.cwd()).root;
  // The reported case: a drive/FS top-level folder is neither a root nor home.
  assert.equal(isBroadGrantRoot(path.join(root, "pi-grant-probe")), false);
  assert.equal(isBroadGrantRoot(path.join(os.homedir(), "..")), true);
  if (process.platform === "win32") {
    const home = os.homedir();
    assert.equal(isBroadGrantRoot(path.join(home, "AppData")), true);
    assert.equal(isBroadGrantRoot(path.join(home, "AppData", "Local")), true);
    assert.equal(
      isBroadGrantRoot(path.join(home, "AppData", "Local", "Temp")),
      false,
    );
    assert.equal(isBroadGrantRoot(path.join(root, "tmp")), false);
    assert.equal(
      isBroadGrantRoot(
        path.join(process.env.SystemRoot ?? path.join(root, "Windows")),
      ),
      true,
    );
  } else {
    assert.equal(isBroadGrantRoot("/etc"), true);
    assert.equal(isBroadGrantRoot("/etc/ssl/certs"), false);
    assert.equal(isBroadGrantRoot("/tmp"), false);
    assert.equal(isBroadGrantRoot("/var/tmp"), false);
  }
});

test("completions: subcommands and scopes follow the full-argument contract", () => {
  const first = folderPolicyArgumentCompletions("");
  assert.ok(first?.some((item) => item.value === "repo"));
  const outside = folderPolicyArgumentCompletions("outside ");
  assert.ok(outside?.some((item) => item.value === "outside block"));
  const scope = folderPolicyArgumentCompletions("outside ask ");
  assert.ok(scope?.some((item) => item.value === "outside ask project"));
  assert.equal(folderPolicyArgumentCompletions("outside ask project"), null);
  // exclude: the verbs, then the scope flags (or a free-form glob → null).
  const exclude = folderPolicyArgumentCompletions("exclude ");
  assert.ok(exclude?.some((item) => item.value === "exclude add"));
  assert.ok(exclude?.some((item) => item.value === "exclude revoke"));
  assert.ok(exclude?.some((item) => item.value === "exclude list"));
  const excludeScope = folderPolicyArgumentCompletions("exclude add ");
  assert.ok(excludeScope?.some((item) => item.value === "exclude add --project"));
  assert.ok(excludeScope?.some((item) => item.value === "exclude add --global"));
  assert.equal(folderPolicyArgumentCompletions("exclude add C:/"), null);
  // A verb the handler never implemented must not be advertised.
  assert.ok(!folderPolicyArgumentCompletions("sensitive ")?.length);
});

test("sensitive list is exported and contains no duplicate entries", () => {
  assert.equal(
    new Set(DEFAULT_SENSITIVE_PATTERNS).size,
    DEFAULT_SENSITIVE_PATTERNS.length,
  );
  assert.equal(
    new Set(DEFAULT_SENSITIVE_EXEMPTIONS).size,
    DEFAULT_SENSITIVE_EXEMPTIONS.length,
  );
});

// ── excludePaths: two tiers — hard deny vs broad-root ceiling ────────

function excludeTree() {
  const { cwd, cleanup } = tmpCwd();
  const parent = path.dirname(cwd);
  const excluded = path.join(parent, "excluded");
  const inner = path.join(excluded, "proj");
  const sibling = path.join(excluded, "other");
  fs.mkdirSync(inner, { recursive: true });
  fs.mkdirSync(sibling, { recursive: true });
  return { parent, excluded, inner, sibling, cleanup };
}

function evalWith(
  target: string,
  options: {
    cwd: string;
    excluded: string;
    /** Full rule list (defaults to `[excluded]`). */
    excludes?: string[];
    grants?: string[];
    mode?: "repo" | "cwd" | "parent" | "any";
    outside?: "ask" | "block";
  },
) {
  return evaluateFolderTargets([{ path: target, kind: "file" }], {
    config: {
      ...DEFAULT_FOLDER_POLICY_CONFIG,
      mode: options.mode ?? "cwd",
      outside: options.outside ?? "ask",
      excludePaths: options.excludes ?? [options.excluded],
    },
    grants: options.grants ?? [],
    cwd: options.cwd,
    action: "read",
  });
}

test("exclude: a specific rule hard-denies the root and every descendant", () => {
  const { excluded, sibling, cleanup } = excludeTree();
  try {
    const cwd = path.dirname(excluded);
    const atRoot = evalWith(excluded, { cwd, excluded });
    assert.equal(atRoot.excluded.length, 1);
    assert.equal(atRoot.excluded[0]?.path, normalizePolicyPath(excluded, cwd));
    assert.equal(atRoot.outside.length, 0);
    assert.equal(atRoot.allowed.length, 0);

    // Descendants are denied too — no dialog, no grant.
    for (const grants of [
      [] as string[],
      [excluded],
      [path.join(excluded, "keep")],
      [cwd],
    ]) {
      const child = evalWith(path.join(sibling, "a.ts"), {
        cwd,
        excluded,
        grants,
      });
      assert.equal(
        child.excluded.length,
        1,
        `the subtree stays denied (grants: ${grants.join(", ") || "none"})`,
      );
      assert.equal(child.outside.length, 0);
      assert.equal(child.allowed.length, 0);
      assert.equal(
        child.excluded[0]?.pattern,
        normalizeExcludePattern(excluded),
      );
    }

    // `mode: "any"` does not soften a specific rule.
    const anyMode = evalWith(path.join(sibling, "a.ts"), {
      cwd,
      excluded,
      mode: "any",
    });
    assert.equal(anyMode.excluded.length, 1);
    assert.equal(anyMode.allowed.length, 0);
  } finally {
    cleanup();
  }
});

test("exclude: a session base inside a specific rule is not rescued", () => {
  const { excluded, inner, cleanup } = excludeTree();
  try {
    // cwd is strictly inside the exclusion.
    const inside = evalWith(path.join(inner, "a.ts"), {
      cwd: inner,
      excluded,
    });
    assert.equal(inside.excluded.length, 1);
    assert.equal(inside.allowed.length, 0);
    assert.equal(inside.outside.length, 0);

    // cwd is the excluded root itself.
    const atBase = evalWith(path.join(excluded, "child.txt"), {
      cwd: excluded,
      excluded,
    });
    assert.equal(atBase.excluded.length, 1);
    assert.equal(atBase.allowed.length, 0);
  } finally {
    cleanup();
  }
});

test("exclude: a specific rule nested under a broad root still denies its subtree", () => {
  const { cwd, cleanup } = tmpCwd();
  try {
    const root = normalizePolicyPath(path.parse(cwd).root, cwd);
    const personal = path.join(cwd, "personal");
    const other = path.join(cwd, "other");
    fs.mkdirSync(personal, { recursive: true });
    fs.mkdirSync(other, { recursive: true });
    const config = {
      ...DEFAULT_FOLDER_POLICY_CONFIG,
      mode: "any" as const,
      excludePaths: [root, personal],
    };
    const evaluate = (target: string) =>
      evaluateFolderTargets([{ path: target, kind: "file" }], {
        config,
        grants: [],
        cwd,
        action: "read",
      });

    assert.equal(evaluate(personal).excluded.length, 1);
    assert.equal(evaluate(path.join(personal, "x.ts")).excluded.length, 1);
    // Outside the specific rule the broad root is only a ceiling.
    assert.equal(evaluate(path.join(other, "x.ts")).allowed.length, 1);
  } finally {
    cleanup();
  }
});

test("exclude: sensitive still wins inside a denied subtree", () => {
  const { excluded, sibling, cleanup } = excludeTree();
  try {
    const env = path.join(excluded, "keep", ".env");
    const res = evalWith(env, { cwd: sibling, excluded });
    assert.equal(res.sensitive.length, 1);
    assert.equal(res.excluded.length, 0);
    assert.equal(res.allowed.length, 0);
  } finally {
    cleanup();
  }
});

test("exclude: a broad root blocks only its own root; descendants follow the mode", () => {
  const { cwd, cleanup } = tmpCwd();
  try {
    const root = normalizePolicyPath(path.parse(cwd).root, cwd);
    const descendant = path.join(cwd, "sibling", "x.ts");
    const evaluate = (
      target: string,
      grants: string[] = [],
      mode: "any" | "cwd" = "any",
    ) =>
      evaluateFolderTargets([{ path: target, kind: "file" }], {
        config: {
          ...DEFAULT_FOLDER_POLICY_CONFIG,
          mode,
          excludePaths: [root],
        },
        grants,
        cwd,
        action: "read",
      });

    for (const grants of [[] as string[], [root]]) {
      const atRoot = evaluate(root, grants);
      assert.equal(atRoot.excluded.length, 1, "the broad root is blocked");
      assert.equal(atRoot.allowed.length, 0);
    }

    const below = evaluate(descendant);
    assert.equal(below.allowed.length, 1);
    assert.equal(below.excluded.length, 0);
    assert.equal(below.outside.length, 0);

    const contained = evaluate(
      path.join(cwd, "..", "sibling", "x.ts"),
      [],
      "cwd",
    );
    assert.equal(contained.outside.length, 1);
    assert.doesNotMatch(
      String(contained.outside[0]?.reason),
      /inside excluded/,
    );
  } finally {
    cleanup();
  }
});

test("exclude: a `/**` broad spelling still blocks only its root", () => {
  const { cwd, cleanup } = tmpCwd();
  try {
    const root = normalizePolicyPath(path.parse(cwd).root, cwd);
    const config = {
      ...DEFAULT_FOLDER_POLICY_CONFIG,
      mode: "any" as const,
      excludePaths: [`${root}**`],
    };
    const evaluate = (target: string) =>
      evaluateFolderTargets([{ path: target, kind: "file" }], {
        config,
        grants: [],
        cwd,
        action: "read",
      });

    // `deepestFirst` reports the target itself for a `/**` glob, so the
    // policy must classify the rule, not the match.
    const below = evaluate(path.join(cwd, "sibling", "x.ts"));
    assert.equal(below.allowed.length, 1);
    assert.equal(below.excluded.length, 0);

    const atRoot = evaluate(root);
    assert.equal(atRoot.excluded.length, 1);
    assert.equal(atRoot.allowed.length, 0);
  } finally {
    cleanup();
  }
});

test("exclude: a symlink into a denied tree is excluded", () => {
  const { parent, excluded, cleanup } = excludeTree();
  try {
    const link = path.join(parent, "link");
    try {
      fs.symlinkSync(
        excluded,
        link,
        process.platform === "win32" ? "junction" : "dir",
      );
    } catch {
      return; // symlink privilege unavailable on this runner
    }
    const res = evalWith(path.join(link, "x.ts"), {
      cwd: parent,
      excluded,
    });
    assert.equal(res.excluded.length, 1);
    assert.equal(res.allowed.length, 0);
  } finally {
    cleanup();
  }
});

test("exclude: helpers classify the rule, not the matched prefix", async () => {
  const mod: Record<string, any> = (await import("./folder-policy.ts")) as any;
  assert.equal(typeof mod.exclusionRuleRoot, "function");
  assert.equal(typeof mod.isBroadExclusionMatch, "function");
  assert.equal(typeof mod.matchDeniedExclusion, "function");

  const root = normalizePolicyPath(path.parse(process.cwd()).root, process.cwd());
  assert.equal(mod.exclusionRuleRoot(`${root}**`), root);

  assert.equal(
    mod.isBroadExclusionMatch({
      excluded: true,
      pattern: `${root}**`,
      root: path.join(root, "x"),
      exact: true,
    }),
    true,
  );
  assert.equal(
    mod.isBroadExclusionMatch({
      excluded: true,
      pattern: path.join(root, "Personal"),
      root: path.join(root, "Personal"),
      exact: false,
    }),
    false,
  );

  const { cwd, cleanup } = tmpCwd();
  try {
    const broad = {
      ...DEFAULT_FOLDER_POLICY_CONFIG,
      excludePaths: [root],
    };
    assert.equal(
      mod.matchDeniedExclusion(path.join(cwd, "sibling", "x.ts"), broad, cwd)
        .excluded,
      false,
    );
    assert.equal(mod.matchDeniedExclusion(root, broad, cwd).excluded, true);

    const personal = path.join(cwd, "personal");
    const specific = {
      ...DEFAULT_FOLDER_POLICY_CONFIG,
      excludePaths: [personal],
    };
    const inside = mod.matchDeniedExclusion(
      path.join(personal, "x.ts"),
      specific,
      cwd,
    );
    assert.equal(inside.excluded, true);
    assert.equal(inside.exact, false);
  } finally {
    cleanup();
  }
});

test("exclude: decideFolderGate blocks an excluded target before asking", () => {
  assert.equal(
    decideFolderGate({
      sensitive: false,
      excluded: true,
      outside: false,
      outsideAction: "ask",
    }),
    "block",
  );
  assert.equal(
    decideFolderGate({
      sensitive: false,
      excluded: true,
      outside: true,
      outsideAction: "ask",
    }),
    "block",
  );
  // An ordinary outside target still follows the outside action.
  assert.equal(
    decideFolderGate({
      sensitive: false,
      excluded: false,
      outside: true,
      outsideAction: "block",
    }),
    "block",
  );
});

// ── locked subagents inherit the deny layer ──────────────────────────

test("lock: PI_FOLDER_POLICY_DENY carries exclusions and sensitive extras", () => {
  const { cwd, agentDir, cleanup } = tmpCwd();
  const previous = {
    locked: process.env.PI_FOLDER_POLICY_LOCKED,
    roots: process.env.PI_FOLDER_POLICY_ROOTS,
    deny: process.env.PI_FOLDER_POLICY_DENY,
    source: process.env.PI_FOLDER_POLICY_SOURCE,
  };
  try {
    process.env.PI_FOLDER_POLICY_LOCKED = "1";
    process.env.PI_FOLDER_POLICY_ROOTS = JSON.stringify([cwd]);
    process.env.PI_FOLDER_POLICY_SOURCE = "parent";
    process.env.PI_FOLDER_POLICY_DENY = JSON.stringify({
      sensitiveTemplates: "block",
      sensitivePatterns: ["**/*.sql"],
      sensitiveExemptions: ["**/demo.sql"],
      excludePaths: [path.join(cwd, "private")],
    });
    const resolved = readFolderPolicyConfig(cwd, agentDir, { trusted: true });
    assert.equal(resolved.config.mode, "cwd");
    assert.equal(resolved.config.outside, "block");
    assert.equal(resolved.config.sensitiveTemplates, "block");
    assert.deepEqual(resolved.config.sensitivePatterns, ["**/*.sql"]);
    assert.deepEqual(resolved.config.sensitiveExemptions, ["**/demo.sql"]);
    assert.deepEqual(resolved.config.excludePaths, [
      normalizeExcludePattern(path.join(cwd, "private")),
    ]);
    // The deny layer is enforced, not decorative.
    assert.equal(matchSensitivePath(`${cwd}/dump.sql`, resolved.config, cwd).sensitive, true);
    // A specific rule carried by the deny layer blocks its whole subtree.
    const denied = evaluateFolderTargets(
      [{ path: path.join(cwd, "private", "x.ts"), kind: "file" }],
      {
        config: resolved.config,
        grants: [],
        cwd,
        lockedRoots: resolved.locked?.roots,
        action: "read",
      },
    );
    assert.equal(denied.excluded.length, 1);
    assert.equal(denied.allowed.length, 0);
    // A grant cannot re-open it, even in a locked session.
    const stillDenied = evaluateFolderTargets(
      [{ path: path.join(cwd, "private", "x.ts"), kind: "file" }],
      {
        config: resolved.config,
        grants: [path.join(cwd, "private")],
        cwd,
        lockedRoots: resolved.locked?.roots,
        action: "read",
      },
    );
    assert.equal(stillDenied.excluded.length, 1);

    // A malformed payload must not throw or widen anything.
    process.env.PI_FOLDER_POLICY_DENY = "{not json";
    const fallback = readFolderPolicyConfig(cwd, agentDir, { trusted: true });
    assert.deepEqual(fallback.config.excludePaths, []);
    assert.deepEqual(fallback.config.sensitivePatterns, []);
  } finally {
    if (previous.locked === undefined)
      delete process.env.PI_FOLDER_POLICY_LOCKED;
    else process.env.PI_FOLDER_POLICY_LOCKED = previous.locked;
    if (previous.roots === undefined)
      delete process.env.PI_FOLDER_POLICY_ROOTS;
    else process.env.PI_FOLDER_POLICY_ROOTS = previous.roots;
    if (previous.deny === undefined) delete process.env.PI_FOLDER_POLICY_DENY;
    else process.env.PI_FOLDER_POLICY_DENY = previous.deny;
    if (previous.source === undefined)
      delete process.env.PI_FOLDER_POLICY_SOURCE;
    else process.env.PI_FOLDER_POLICY_SOURCE = previous.source;
    cleanup();
  }
});

// ── /folder-policy argument parsing ──────────────────────────────────

test("args: the splitter honours quotes, keeps backslashes and rejects an open quote", () => {
  assert.deepEqual(splitPolicyArgs("exclude C:/Personal").tokens, [
    "exclude",
    "C:/Personal",
  ]);
  assert.deepEqual(splitPolicyArgs('exclude "C:/My Documents"').tokens, [
    "exclude",
    "C:/My Documents",
  ]);
  assert.deepEqual(splitPolicyArgs("exclude 'D:/Data/R&D'").tokens, [
    "exclude",
    "D:/Data/R&D",
  ]);
  // Windows backslashes are literal, never escapes.
  assert.deepEqual(splitPolicyArgs("exclude C:\\Personal\\x").tokens, [
    "exclude",
    "C:\\Personal\\x",
  ]);
  // The other quote kind is literal inside a quoted word.
  assert.deepEqual(splitPolicyArgs(`exclude "C:/it's here"`).tokens, [
    "exclude",
    "C:/it's here",
  ]);
  assert.deepEqual(splitPolicyArgs("   ").tokens, []);
  assert.deepEqual(splitPolicyArgs(undefined).tokens, []);
  // An explicitly empty quoted argument is kept so the caller can reject it.
  assert.deepEqual(splitPolicyArgs('exclude ""').tokens, ["exclude", ""]);
  const unbalanced = splitPolicyArgs('exclude "C:/My Documents');
  assert.deepEqual(unbalanced.tokens, []);
  assert.match(String(unbalanced.error), /Unbalanced double quote/);
  assert.match(String(splitPolicyArgs("exclude 'x").error), /single quote/);
});

test("args: exclude parsing is flags-only and rejects leftovers", () => {
  assert.deepEqual(parseExcludeArgs(["C:/Personal"]), {
    ok: true,
    action: "add",
    scope: "global",
    pattern: "C:/Personal",
  });
  assert.deepEqual(parseExcludeArgs(["C:/Personal", "--project"]), {
    ok: true,
    action: "add",
    scope: "project",
    pattern: "C:/Personal",
  });
  assert.deepEqual(parseExcludeArgs(["add", "C:/My Documents"]), {
    ok: true,
    action: "add",
    scope: "global",
    pattern: "C:/My Documents",
  });
  assert.deepEqual(parseExcludeArgs(["revoke", "C:/Personal", "--global"]), {
    ok: true,
    action: "revoke",
    scope: "global",
    pattern: "C:/Personal",
  });
  assert.equal(
    (parseExcludeArgs(["remove", "x"]) as { action: string }).action,
    "revoke",
  );
  assert.deepEqual(parseExcludeArgs([]), {
    ok: true,
    action: "list",
    scope: "global",
  });
  assert.deepEqual(parseExcludeArgs(["list", "--project"]), {
    ok: true,
    action: "list",
    scope: "project",
  });
  // A folder literally named `project` is a pattern, not a scope flip.
  assert.deepEqual(parseExcludeArgs(["add", "project"]), {
    ok: true,
    action: "add",
    scope: "global",
    pattern: "project",
  });
  const trailing = parseExcludeArgs(["C:/X", "project"]);
  assert.equal(trailing.ok, false);
  assert.match(
    String((trailing as { message: string }).message),
    /Unexpected argument `project`/,
  );
  for (const bad of [
    ["add"],
    ["revoke"],
    ["list", "extra"],
    ["--global", "--project", "C:/X"],
    ["--nope", "C:/X"],
    ["C:/X", "extra"],
  ]) {
    const result = parseExcludeArgs(bad);
    assert.equal(result.ok, false, `expected ${bad.join(" ")} to be rejected`);
    assert.match(
      String((result as { message: string }).message),
      /Usage|Unknown flag/,
    );
  }
  // The usage line is part of every rejection so the user can recover.
  assert.match(
    EXCLUDE_USAGE,
    /exclude <path>\|add <path>\|revoke <path>\|list/,
  );
});

// ── base coverage: per capability, grant-aware ──────────────────────

test("base coverage: a specific rule denies every capability at the base", () => {
  const { cwd, cleanup } = tmpCwd();
  try {
    const config = { ...DEFAULT_FOLDER_POLICY_CONFIG, mode: "cwd" as const };
    // No exclusion: every capability is clean.
    const plain = evaluateBaseCoverage({ config, cwd });
    assert.deepEqual(
      plain.map((entry) => entry.capability),
      ["read", "write", "commit"],
    );
    assert.ok(plain.every((entry) => entry.excluded.length === 0));

    // The base itself is a specific exclusion: no capability can rescue it.
    const denied = { ...config, excludePaths: [cwd] };
    const blocked = evaluateBaseCoverage({ config: denied, cwd });
    assert.ok(blocked.every((entry) => entry.excluded.length === 1));

    // The session folder strictly inside the rule is denied too (no implicit
    // rescue).
    const inner = path.join(cwd, "project");
    fs.mkdirSync(inner, { recursive: true });
    const nested = evaluateBaseCoverage({ config: denied, cwd: inner });
    assert.ok(nested.every((entry) => entry.excluded.length === 1));

    // A broad root that contains the base (but is not the base) is a ceiling,
    // not a denial.
    const root = normalizePolicyPath(path.parse(cwd).root, cwd);
    const broad = evaluateBaseCoverage({
      config: { ...config, mode: "any" as const, excludePaths: [root] },
      cwd,
    });
    assert.ok(broad.every((entry) => entry.excluded.length === 0));
  } finally {
    cleanup();
  }
});

// ── completions and the parser must agree ───────────────────────────

test("completions: every advertised exclude form is accepted by the parser", () => {
  const verbs = folderPolicyArgumentCompletions("exclude ") ?? [];
  assert.ok(verbs.some((item) => item.value === "exclude add"));
  assert.ok(verbs.some((item) => item.value === "exclude revoke"));
  assert.ok(verbs.some((item) => item.value === "exclude list"));
  for (const candidate of verbs) {
    const split = splitPolicyArgs(candidate.value);
    assert.equal(split.error, undefined, candidate.value);
    const parsed = parseExcludeArgs(split.tokens.slice(1));
    // `add`/`revoke` are prefixes that still need a path; `list` is complete.
    if (
      candidate.value === "exclude add" ||
      candidate.value === "exclude revoke"
    ) {
      assert.equal(parsed.ok, false, candidate.value);
      assert.match(
        String((parsed as { message: string }).message),
        /needs a path/,
      );
    } else {
      assert.equal(parsed.ok, true, `${candidate.value} should parse`);
    }
  }

  // Scope flags are offered only where the parser accepts them (after a verb).
  const scoped = folderPolicyArgumentCompletions("exclude add ") ?? [];
  assert.ok(scoped.length > 0);
  for (const candidate of scoped) {
    const split = splitPolicyArgs(candidate.value);
    const parsed = parseExcludeArgs(split.tokens.slice(1));
    // A bare `add --project` still needs a path: the flag parses, the verb fails.
    assert.equal(parsed.ok, false, candidate.value);
    assert.match(
      String((parsed as { message: string }).message),
      /needs a path/,
    );
  }

  // No completion advertises a flag the parser would reject.
  assert.equal(folderPolicyArgumentCompletions("exclude --bogus "), null);
  const withPath = folderPolicyArgumentCompletions("exclude add --project ");
  assert.equal(withPath, null, "free-form paths have no completion");
  // Every completion that includes a flag still parses once a path is present.
  for (const flag of ["--global", "--project"]) {
    const parsed = parseExcludeArgs(["add", "C:/X", flag]);
    assert.equal(parsed.ok, true, `${flag} should be accepted`);
  }
});
