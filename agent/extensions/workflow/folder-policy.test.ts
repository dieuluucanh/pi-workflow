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
  FOLDER_POLICY_KEY,
  baseFolderRoots,
  canonicalizePolicyPath,
  coerceFolderPolicyConfig,
  combineGateDecisions,
  decideFolderGate,
  describeFolderEvaluation,
  describeFolderPolicyMode,
  detectRepoRoot,
  effectiveSensitiveExemptions,
  evaluateFolderTargets,
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
  normalizePolicyPath,
  readFolderPolicyConfig,
  resolveFolderRoots,
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
    },
    {
      mode: "parent",
      outside: "block",
      sensitivePatterns: ["**/*.b"],
      sensitiveExemptions: ["**/project.env"],
    },
  );
  assert.equal(merged.mode, "parent");
  assert.equal(merged.outside, "block");
  assert.deepEqual(merged.sensitivePatterns, ["**/*.a", "**/*.b"]);
  assert.deepEqual(merged.sensitiveExemptions, [
    "**/global.env",
    "**/project.env",
  ]);
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

test("write: read-modify-write preserves other keys and unions lists", () => {
  const { cwd, agentDir, cleanup } = tmpCwd();
  try {
    writeJson(path.join(agentDir, "settings.json"), {
      theme: "dark",
      [WORKFLOW_SETTINGS_KEY]: {
        [FOLDER_POLICY_KEY]: {
          mode: "cwd",
          sensitivePatterns: ["**/*.a"],
        },
        reviewMode: { enabled: true },
      },
    });
    const res = writeFolderPolicyConfig("global", cwd, agentDir, {
      mode: "parent",
      sensitivePatterns: ["**/*.b"],
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
  } finally {
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
      outside: [{ path: "c:/other/x.ts", kind: "file" }],
      allowed: [{ path: "c:/work/src/a.ts", kind: "file" }],
      network: [{ path: "//server/share/x.ts", kind: "file" }],
      broad: [],
      uncertain: ["c:/work/bad"],
    },
    "c:/work",
  );
  assert.match(lines[0] ?? "", /c:\/work/);
  assert.match(lines[1] ?? "", /1 inside, 1 outside, 1 sensitive, 1 unverifiable/);
  assert.ok(lines.some((line) => line.includes("inside: c:/work/src/a.ts")));
  assert.ok(lines.some((line) => line.includes("outside: c:/other/x.ts")));
  assert.ok(lines.some((line) => line.includes("network: //server/share/x.ts")));
  assert.ok(lines.some((line) => line.includes("sensitive: c:/work/.env (**/.env)")));
  assert.ok(lines.some((line) => line.includes("unverifiable: c:/work/bad")));
});

test("broad: roots/home are refused, project folders are not", () => {
  assert.equal(isBroadGrantRoot(path.parse(process.cwd()).root), true);
  assert.equal(isBroadGrantRoot(os.homedir()), true);
  assert.equal(isBroadGrantRoot(path.join(os.homedir(), "projects", "app")), false);
});

test("completions: subcommands and scopes follow the full-argument contract", () => {
  const first = folderPolicyArgumentCompletions("");
  assert.ok(first?.some((item) => item.value === "repo"));
  const outside = folderPolicyArgumentCompletions("outside ");
  assert.ok(outside?.some((item) => item.value === "outside block"));
  const scope = folderPolicyArgumentCompletions("outside ask ");
  assert.ok(scope?.some((item) => item.value === "outside ask project"));
  assert.equal(folderPolicyArgumentCompletions("outside ask project"), null);
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
