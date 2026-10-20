/**
 * Workflow Extension — Write Policy tests
 *
 * Run with: npm test   (node --test, type-stripping — no build step)
 *
 * These cover the pure config surface: coercion of untrusted fragments
 * (objects, bare-string shorthand, garbage, wrong types), merge precedence
 * (mode is project-over-global; allowlists are unioned), scope-source
 * attribution, disk round-trips via temp dirs, the "preserve every other
 * key" read-modify-write guarantee, path and command allowlist matching,
 * shell-command mutation classification, and the pure decision table.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  DEFAULT_WRITE_POLICY_CONFIG,
  WRITE_DENY_WITH_INSTRUCTIONS_LABEL,
  WRITE_DENY_WITH_INSTRUCTIONS_PREFIX,
  WRITE_INSTRUCTION_MAX_LEN,
  WRITE_POLICY_KEY,
  buildWriteDenyReason,
  buildWriteGuidanceMessage,
  classifyWriteCall,
  coerceWritePolicyConfig,
  commandAllowKey,
  commandMayWrite,
  decideWriteGate,
  describeWritePolicyMode,
  extractWritePolicyRaw,
  isCommandAllowed,
  isPathAllowed,
  isWriteCallAllowed,
  mergeWritePolicyConfig,
  normalizeWritePath,
  parseWriteGateChoice,
  readWritePolicyConfig,
  sanitizeWriteInstruction,
  toolAllowKey,
  writePolicyArgumentCompletions,
  writePolicyConfigPaths,
  writePolicyModeSourceOf,
  writeTargetPaths,
  writeWritePolicyConfig,
  type WritePolicyConfig,
} from "./edit-policy.ts";
// WORKFLOW_SETTINGS_KEY lives in commit-policy.ts (edit-policy.ts imports it
// from there) — import it from its home so there is exactly one "workflow"
// literal in the package.
import { WORKFLOW_SETTINGS_KEY } from "./commit-policy.ts";

// ── coerceWritePolicyConfig ─────────────────────────────────────────

test("coerce: defaults when raw is undefined/null", () => {
  assert.deepEqual(coerceWritePolicyConfig(undefined), {
    mode: "allow",
    allowedPaths: [],
    allowedCommands: [],
    mutatingTools: [],
  });
  assert.deepEqual(coerceWritePolicyConfig(null), {
    mode: "allow",
    allowedPaths: [],
    allowedCommands: [],
    mutatingTools: [],
  });
});

test("coerce: valid object fragment", () => {
  assert.deepEqual(coerceWritePolicyConfig({ mode: "ask" }), {
    mode: "ask",
    allowedPaths: [],
    allowedCommands: [],
    mutatingTools: [],
  });
  assert.equal(coerceWritePolicyConfig({ mode: "never" }).mode, "never");
  assert.equal(coerceWritePolicyConfig({ mode: "allow" }).mode, "allow");
});

test("coerce: bare mode string shorthand", () => {
  assert.equal(coerceWritePolicyConfig("allow").mode, "allow");
  assert.equal(coerceWritePolicyConfig("ask").mode, "ask");
  assert.equal(coerceWritePolicyConfig("never").mode, "never");
});

test("coerce: mode string is trimmed and case-insensitive", () => {
  assert.equal(coerceWritePolicyConfig("  ASK  ").mode, "ask");
  assert.equal(coerceWritePolicyConfig({ mode: " Never " }).mode, "never");
});

test("coerce: garbage falls back to base", () => {
  const base: WritePolicyConfig = {
    mode: "ask",
    allowedPaths: ["/a"],
    allowedCommands: [],
    mutatingTools: [],
  };
  assert.deepEqual(coerceWritePolicyConfig(true, base), base);
  assert.deepEqual(coerceWritePolicyConfig(false, base), base);
  assert.deepEqual(coerceWritePolicyConfig(42, base), base);
  assert.deepEqual(coerceWritePolicyConfig("bogus", base), base);
  assert.deepEqual(coerceWritePolicyConfig(["ask"], base), base);
  assert.deepEqual(coerceWritePolicyConfig({ mode: 7 }, base), base);
  assert.deepEqual(coerceWritePolicyConfig({ mode: "maybe" }, base), base);
  assert.deepEqual(coerceWritePolicyConfig(null, base), base);
});

test("coerce: no boolean shorthand — true/false are never allow/never", () => {
  assert.equal(coerceWritePolicyConfig(true).mode, "allow");
  assert.equal(coerceWritePolicyConfig(false).mode, "allow");
  assert.deepEqual(
    coerceWritePolicyConfig(true),
    DEFAULT_WRITE_POLICY_CONFIG as WritePolicyConfig,
  );
});

test("coerce: allowlists are read as string arrays, garbage dropped", () => {
  const cfg = coerceWritePolicyConfig({
    mode: "ask",
    allowedPaths: ["/a", 42, "", "  /b  ", "/a"],
    allowedCommands: "not-an-array",
    mutatingTools: ["ast_grep_replace", null],
  });
  assert.deepEqual(cfg.allowedPaths, ["/a", "/b"]);
  // A non-array list falls back to the base (here: empty), never throws.
  assert.deepEqual(cfg.allowedCommands, []);
  assert.deepEqual(cfg.mutatingTools, ["ast_grep_replace"]);
});

test("coerce: a missing list inherits the base, an absent key is dropped", () => {
  const base: WritePolicyConfig = {
    mode: "ask",
    allowedPaths: ["/base"],
    allowedCommands: ["ls"],
    mutatingTools: [],
  };
  const cfg = coerceWritePolicyConfig({ mode: "never" }, base);
  assert.equal(cfg.mode, "never");
  assert.deepEqual(cfg.allowedPaths, ["/base"]);
  assert.deepEqual(cfg.allowedCommands, ["ls"]);
});

test("coerce: unknown fields are dropped", () => {
  const cfg = coerceWritePolicyConfig({ mode: "ask", evil: true });
  assert.equal((cfg as unknown as Record<string, unknown>).evil, undefined);
});

// ── extractWritePolicyRaw ───────────────────────────────────────────

test("extract: pulls workflow.writePolicy from a settings object", () => {
  assert.deepEqual(
    extractWritePolicyRaw({
      other: 1,
      [WORKFLOW_SETTINGS_KEY]: {
        [WRITE_POLICY_KEY]: { mode: "ask" },
      },
    }),
    { mode: "ask" },
  );
  assert.equal(
    extractWritePolicyRaw({
      [WORKFLOW_SETTINGS_KEY]: { [WRITE_POLICY_KEY]: "never" },
    }),
    "never",
  );
});

test("extract: undefined for absent/malformed shapes", () => {
  assert.equal(extractWritePolicyRaw(undefined), undefined);
  assert.equal(extractWritePolicyRaw(null), undefined);
  assert.equal(extractWritePolicyRaw("nope"), undefined);
  assert.equal(extractWritePolicyRaw([]), undefined);
  assert.equal(extractWritePolicyRaw({}), undefined);
  assert.equal(extractWritePolicyRaw({ workflow: "x" }), undefined);
  assert.equal(
    extractWritePolicyRaw({ [WORKFLOW_SETTINGS_KEY]: { [WRITE_POLICY_KEY]: 7 } }),
    undefined,
  );
  assert.equal(
    extractWritePolicyRaw({
      [WORKFLOW_SETTINGS_KEY]: { [WRITE_POLICY_KEY]: ["ask"] },
    }),
    undefined,
  );
});

// ── mergeWritePolicyConfig ──────────────────────────────────────────

test("merge: mode is project-over-global, defaults win", () => {
  assert.equal(mergeWritePolicyConfig(undefined, undefined).mode, "allow");
  assert.equal(mergeWritePolicyConfig({ mode: "ask" }, undefined).mode, "ask");
  assert.equal(mergeWritePolicyConfig(undefined, { mode: "never" }).mode, "never");
  assert.equal(
    mergeWritePolicyConfig({ mode: "ask" }, { mode: "never" }).mode,
    "never",
  );
  // An invalid project mode falls back to the global one.
  assert.equal(
    mergeWritePolicyConfig({ mode: "ask" }, { mode: "bogus" }).mode,
    "ask",
  );
});

test("merge: allowlists are UNIONED across scopes (additive trust)", () => {
  const merged = mergeWritePolicyConfig(
    { mode: "ask", allowedPaths: ["/global"] },
    { mode: "ask", allowedPaths: ["/project"] },
  );
  assert.deepEqual(merged.allowedPaths, ["/global", "/project"]);

  // A project fragment that omits the list inherits the global one.
  const inherited = mergeWritePolicyConfig(
    { mode: "ask", allowedCommands: ["ls"] },
    { mode: "never" },
  );
  assert.deepEqual(inherited.allowedCommands, ["ls"]);

  // Duplicates collapse.
  const deduped = mergeWritePolicyConfig(
    { allowedPaths: ["/x"] },
    { allowedPaths: ["/x", "/y"] },
  );
  assert.deepEqual(deduped.allowedPaths, ["/x", "/y"]);
});

test("merge: mutatingTools are unioned too", () => {
  const merged = mergeWritePolicyConfig(
    { mutatingTools: ["ast_grep_replace"] },
    { mutatingTools: ["office_excel_write_cells"] },
  );
  assert.deepEqual(merged.mutatingTools, [
    "ast_grep_replace",
    "office_excel_write_cells",
  ]);
});

// ── writePolicyModeSourceOf ─────────────────────────────────────────

test("modeSourceOf: project > global > default, keyed on a VALID mode", () => {
  assert.equal(writePolicyModeSourceOf(undefined, undefined), "default");
  assert.equal(writePolicyModeSourceOf("ask", undefined), "global");
  assert.equal(writePolicyModeSourceOf(undefined, { mode: "ask" }), "project");
  assert.equal(writePolicyModeSourceOf("ask", "allow"), "project");
  // An invalid mode must not count as "supplied".
  assert.equal(writePolicyModeSourceOf("bogus", undefined), "default");
  assert.equal(writePolicyModeSourceOf(undefined, { mode: "bogus" }), "default");
});

// ── disk round-trips (temp dirs) ─────────────────────────────────────

function tmpCwd(): { cwd: string; agentDir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-edit-policy-"));
  return {
    cwd: dir,
    agentDir: path.join(dir, "agent"),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

test("read: defaults when no settings files exist", () => {
  const { cwd, agentDir, cleanup } = tmpCwd();
  try {
    const res = readWritePolicyConfig(cwd, agentDir);
    assert.deepEqual(res.config, DEFAULT_WRITE_POLICY_CONFIG);
    assert.equal(res.sources.mode, "default");
    assert.equal(res.sources.global, false);
    assert.equal(res.sources.project, false);
  } finally {
    cleanup();
  }
});

test("read: corrupt files fall back to defaults, never throw", () => {
  const { cwd, agentDir, cleanup } = tmpCwd();
  try {
    fs.mkdirSync(agentDir, { recursive: true });
    fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
    fs.writeFileSync(path.join(agentDir, "settings.json"), "{not json", "utf8");
    fs.writeFileSync(path.join(cwd, ".pi", "settings.json"), "]]]", "utf8");
    const res = readWritePolicyConfig(cwd, agentDir);
    assert.deepEqual(res.config, DEFAULT_WRITE_POLICY_CONFIG);
  } finally {
    cleanup();
  }
});

test("read+write: global scope then project override", () => {
  const { cwd, agentDir, cleanup } = tmpCwd();
  try {
    const g = writeWritePolicyConfig("global", cwd, agentDir, { mode: "ask" });
    assert.equal(g.ok, true);
    assert.equal(g.path, path.join(agentDir, "settings.json"));
    let res = readWritePolicyConfig(cwd, agentDir);
    assert.equal(res.config.mode, "ask");
    assert.equal(res.sources.mode, "global");

    const p = writeWritePolicyConfig("project", cwd, agentDir, { mode: "never" });
    assert.equal(p.ok, true);
    assert.equal(p.path, path.join(cwd, ".pi", "settings.json"));
    res = readWritePolicyConfig(cwd, agentDir);
    assert.equal(res.config.mode, "never");
    assert.equal(res.sources.mode, "project");
  } finally {
    cleanup();
  }
});

test("write: preserves every other key in the settings file", () => {
  const { cwd, agentDir, cleanup } = tmpCwd();
  try {
    fs.mkdirSync(agentDir, { recursive: true });
    const fp = path.join(agentDir, "settings.json");
    fs.writeFileSync(
      fp,
      JSON.stringify(
        { theme: "dark", packages: ["npm:pi-lens"], workflow: { reviewMode: { enabled: true } } },
        null,
        2,
      ),
      "utf8",
    );
    writeWritePolicyConfig("global", cwd, agentDir, { mode: "never" });
    const raw = JSON.parse(fs.readFileSync(fp, "utf8"));
    assert.equal(raw.theme, "dark");
    assert.deepEqual(raw.packages, ["npm:pi-lens"]);
    // A sibling workflow key survives too.
    assert.deepEqual(raw.workflow.reviewMode, { enabled: true });
    assert.equal(raw.workflow.writePolicy.mode, "never");
  } finally {
    cleanup();
  }
});

test("write: the object form is always written (never a bare string)", () => {
  const { cwd, agentDir, cleanup } = tmpCwd();
  try {
    writeWritePolicyConfig("global", cwd, agentDir, { mode: "ask" });
    const raw = JSON.parse(
      fs.readFileSync(path.join(agentDir, "settings.json"), "utf8"),
    );
    assert.equal(typeof raw.workflow.writePolicy, "object");
    assert.equal(raw.workflow.writePolicy.mode, "ask");
  } finally {
    cleanup();
  }
});

test("write: list fields are ADDITIVE — a patch never removes entries", () => {
  const { cwd, agentDir, cleanup } = tmpCwd();
  try {
    writeWritePolicyConfig("global", cwd, agentDir, {
      mode: "ask",
      allowedPaths: ["/a"],
    });
    writeWritePolicyConfig("global", cwd, agentDir, {
      allowedPaths: ["/b"],
    });
    const res = readWritePolicyConfig(cwd, agentDir);
    assert.deepEqual(res.config.allowedPaths, ["/a", "/b"]);
    assert.equal(res.config.mode, "ask");
  } finally {
    cleanup();
  }
});

test("write: a failing write reports the error instead of throwing", () => {
  const { cwd, agentDir, cleanup } = tmpCwd();
  try {
    // Make the settings path a directory so the final writeFileSync fails.
    fs.mkdirSync(path.join(agentDir, "settings.json"), { recursive: true });
    const res = writeWritePolicyConfig("global", cwd, agentDir, { mode: "ask" });
    assert.equal(res.ok, false);
    assert.ok(typeof res.error === "string" && res.error.length > 0);
  } finally {
    cleanup();
  }
});

test("configPaths: global is the agent dir, project is <cwd>/.pi", () => {
  const paths = writePolicyConfigPaths("/work/proj", "/agent");
  assert.equal(paths.global, path.join("/agent", "settings.json"));
  assert.equal(paths.project, path.join("/work/proj", ".pi", "settings.json"));
});

// ── path matching ───────────────────────────────────────────────────

test("normalizeWritePath: absolute, forward slashes, lower-cased", () => {
  // Platform-agnostic: resolve the expectation the same way the
  // implementation does, then compare the normalized forms.
  const expected = path
    .resolve("/work/proj", "src/File.ts")
    .replace(/\\/g, "/")
    .toLowerCase();
  const n = normalizeWritePath("src/File.ts", "/work/proj");
  assert.equal(n, expected);
  assert.ok(!n.includes("\\"));
  assert.equal(n, n.toLowerCase());
});

test("normalizeWritePath: an absolute path is kept as-is (resolved)", () => {
  const abs = path.resolve("/work/proj/src/a.ts");
  const n = normalizeWritePath(abs, path.resolve("/other"));
  assert.equal(n, abs.replace(/\\/g, "/").toLowerCase());
  // The cwd must not leak into an already-absolute path.
  assert.ok(!n.includes("other"));
});

test("normalizeWritePath: empty/garbage input yields an empty string", () => {
  assert.equal(normalizeWritePath("", "/work/proj"), "");
  assert.equal(normalizeWritePath("   ", "/work/proj"), "");
  assert.equal(normalizeWritePath(undefined, "/work/proj"), "");
  assert.equal(normalizeWritePath(42, "/work/proj"), "");
});

test("isPathAllowed: exact match and directory containment", () => {
  const cwd = "/work/proj";
  assert.equal(isPathAllowed("/work/proj/src/a.ts", ["/work/proj/src/a.ts"], cwd), true);
  assert.equal(isPathAllowed("/work/proj/src/a.ts", ["/work/proj/src"], cwd), true);
  assert.equal(isPathAllowed("/work/proj/src/deep/a.ts", ["/work/proj/src"], cwd), true);
});

test("isPathAllowed: a directory entry never matches a sibling prefix", () => {
  const cwd = "/work/proj";
  // …/src must not cover …/src-old
  assert.equal(isPathAllowed("/work/proj/src-old/a.ts", ["/work/proj/src"], cwd), false);
  // …/a.ts must not cover …/a.ts.bak
  assert.equal(isPathAllowed("/work/proj/a.ts.bak", ["/work/proj/a.ts"], cwd), false);
});

test("isPathAllowed: unrelated paths and empty allowlists do not match", () => {
  const cwd = "/work/proj";
  assert.equal(isPathAllowed("/work/proj/src/a.ts", [], cwd), false);
  assert.equal(isPathAllowed("/elsewhere/a.ts", ["/work/proj"], cwd), false);
  assert.equal(isPathAllowed("", ["/work/proj"], cwd), false);
});

// ── command allowlist matching ──────────────────────────────────────

test("commandAllowKey: whitespace collapsed and lower-cased", () => {
  assert.equal(commandAllowKey("  npm   run   build "), "npm run build");
  assert.equal(commandAllowKey("RM -rf x"), "rm -rf x");
  assert.equal(commandAllowKey(undefined), "");
});

test("isCommandAllowed: exact match and word-boundary continuation", () => {
  assert.equal(isCommandAllowed("npm run build", ["npm run build"]), true);
  assert.equal(isCommandAllowed("npm run build --watch", ["npm run build"]), true);
  // A prefix must not match a longer word.
  assert.equal(isCommandAllowed("npm run buildx", ["npm run build"]), false);
  assert.equal(isCommandAllowed("rm -rf x", ["rm"]), true);
  assert.equal(isCommandAllowed("rmdir x", ["rm"]), false);
});

test("isCommandAllowed: empty key or allowlist never matches", () => {
  assert.equal(isCommandAllowed("", ["ls"]), false);
  assert.equal(isCommandAllowed("ls", []), false);
  assert.equal(isCommandAllowed("ls", ["  "]), false);
});

// ── commandMayWrite ─────────────────────────────────────────────────

test("commandMayWrite: read-only commands are not writes", () => {
  for (const cmd of [
    "ls -la",
    "cat file",
    "rg foo",
    "git status",
    "git log",
    "git diff",
    "npm test",
    "tsc --noEmit",
    "eslint src",
  ]) {
    assert.equal(commandMayWrite(cmd).mutating, false, cmd);
  }
});

test("commandMayWrite: obvious mutators are writes", () => {
  for (const cmd of [
    "rm -rf /tmp/x",
    "mv a b",
    "cp a b",
    "mkdir out",
    "touch f",
    "sed -i s/a/b/ f",
    "npm install",
    "git checkout main",
    "python -c \"open('f','w')\"",
    "node -e \"x\"",
  ]) {
    assert.equal(commandMayWrite(cmd).mutating, true, cmd);
  }
});

test("commandMayWrite: a file redirect is a write", () => {
  assert.equal(commandMayWrite("echo hi > out.txt").mutating, true);
  assert.equal(commandMayWrite("cat >> log").mutating, true);
  assert.equal(commandMayWrite("cat a > b").mutating, true);
});

test("commandMayWrite: a write flag on a verify-class command is a write", () => {
  assert.equal(commandMayWrite("eslint --fix src").mutating, true);
  assert.equal(commandMayWrite("prettier --write .").mutating, true);
});

test("commandMayWrite: harmless redirections are NOT writes", () => {
  // The planner gate already allows these; the write gate must agree.
  assert.equal(commandMayWrite("2>/dev/null ls").mutating, false);
  assert.equal(commandMayWrite("ls 2>&1").mutating, false);
  assert.equal(commandMayWrite("cat f 2>/dev/null").mutating, false);
  // But the same command with a real write is still a write.
  assert.equal(commandMayWrite("2>/dev/null rm -rf x").mutating, true);
});

test("commandMayWrite: git history operations are NOT writes (commit policy owns them)", () => {
  assert.equal(commandMayWrite("git add -A").mutating, false);
  assert.equal(commandMayWrite("git commit -m x").mutating, false);
  assert.equal(commandMayWrite("git push").mutating, false);
  // But a worktree-mutating git command IS a write.
  assert.equal(commandMayWrite("git checkout main").mutating, true);
  assert.equal(commandMayWrite("git reset --hard").mutating, true);
  assert.equal(commandMayWrite("git clean -fd").mutating, true);
});

test("commandMayWrite: a compound command is a write if ANY segment is", () => {
  assert.equal(commandMayWrite("ls && rm -rf x").mutating, true);
  assert.equal(commandMayWrite("npm test && echo done").mutating, false);
  assert.equal(commandMayWrite("cat a | grep b").mutating, false);
});

test("commandMayWrite: empty/garbage input is not a write", () => {
  assert.equal(commandMayWrite("").mutating, false);
  assert.equal(commandMayWrite("   ").mutating, false);
  assert.equal(commandMayWrite(undefined).mutating, false);
  assert.equal(commandMayWrite(42).mutating, false);
});

test("commandMayWrite: a write reports the offending segment", () => {
  const r = commandMayWrite("ls && rm -rf x");
  assert.equal(r.mutating, true);
  assert.equal(r.segment, "rm -rf x");
  assert.ok(r.reason && r.reason.length > 0);
});

// ── tool classification ─────────────────────────────────────────────

test("writeTargetPaths: reads path, file_path and paths", () => {
  assert.deepEqual(writeTargetPaths({ path: "a.ts" }), ["a.ts"]);
  assert.deepEqual(writeTargetPaths({ file_path: "b.ts" }), ["b.ts"]);
  assert.deepEqual(writeTargetPaths({ paths: ["c.ts", "d.ts"] }), ["c.ts", "d.ts"]);
  assert.deepEqual(writeTargetPaths({}), []);
  assert.deepEqual(writeTargetPaths(undefined), []);
  assert.deepEqual(writeTargetPaths("nope"), []);
});

test("classifyWriteCall: edit and write always mutate", () => {
  const cfg = coerceWritePolicyConfig({ mode: "ask" });
  const edit = classifyWriteCall("edit", { path: "src/a.ts" }, cfg);
  assert.equal(edit.mutating, true);
  assert.deepEqual(edit.paths, ["src/a.ts"]);

  const write = classifyWriteCall("write", { path: "src/b.ts" }, cfg);
  assert.equal(write.mutating, true);
});

test("classifyWriteCall: bash is classified by commandMayWrite", () => {
  const cfg = coerceWritePolicyConfig({ mode: "ask" });
  assert.equal(
    classifyWriteCall("bash", { command: "ls" }, cfg).mutating,
    false,
  );
  const rm = classifyWriteCall("bash", { command: "rm -rf x" }, cfg);
  assert.equal(rm.mutating, true);
  assert.ok(rm.key && rm.key.includes("rm -rf x"));
});

test("classifyWriteCall: powershell always mutates (not statically classifiable)", () => {
  const cfg = coerceWritePolicyConfig({ mode: "ask" });
  const ps = classifyWriteCall("powershell", { command: "Get-ChildItem" }, cfg);
  assert.equal(ps.mutating, true);
});

test("classifyWriteCall: read-only tools never mutate", () => {
  const cfg = coerceWritePolicyConfig({ mode: "ask" });
  for (const tool of ["read", "grep", "find", "ls", "questionnaire"]) {
    assert.equal(classifyWriteCall(tool, {}, cfg).mutating, false, tool);
  }
});

test("classifyWriteCall: mutatingTools is the escape hatch for third-party writers", () => {
  const cfg = coerceWritePolicyConfig({
    mode: "ask",
    mutatingTools: ["ast_grep_replace"],
  });
  const bare = classifyWriteCall("ast_grep_replace", { paths: ["a.ts"] }, cfg);
  assert.equal(bare.mutating, true);
  assert.deepEqual(bare.paths, ["a.ts"]);
  // Not listed → not gated.
  assert.equal(
    classifyWriteCall("some_other_tool", { paths: ["a.ts"] }, cfg).mutating,
    false,
  );
});

test("classifyWriteCall: a path-less mutating tool is keyed by tool name", () => {
  const cfg = coerceWritePolicyConfig({
    mode: "ask",
    mutatingTools: ["office_excel_write_cells"],
  });
  const c = classifyWriteCall("office_excel_write_cells", {}, cfg);
  assert.equal(c.mutating, true);
  assert.equal(c.key, toolAllowKey("office_excel_write_cells"));
  assert.ok(c.key!.startsWith("tool:"));
});

test("isWriteCallAllowed: all target paths must be allowed", () => {
  const cfg = coerceWritePolicyConfig({
    mode: "ask",
    allowedPaths: ["/work/proj/src"],
  });
  const one = classifyWriteCall("edit", { path: "/work/proj/src/a.ts" }, cfg);
  assert.equal(isWriteCallAllowed(one, cfg, "/work/proj"), true);
  const outside = classifyWriteCall("edit", { path: "/work/proj/other/a.ts" }, cfg);
  assert.equal(isWriteCallAllowed(outside, cfg, "/work/proj"), false);
  // A multi-path call is allowed only if EVERY path is allowed.
  const mixed = classifyWriteCall(
    "edit",
    { paths: ["/work/proj/src/a.ts", "/work/proj/other/b.ts"] },
    cfg,
  );
  assert.equal(isWriteCallAllowed(mixed, cfg, "/work/proj"), false);
});

test("isWriteCallAllowed: a command key is matched against allowedCommands", () => {
  const cfg = coerceWritePolicyConfig({
    mode: "ask",
    allowedCommands: ["rm -rf build"],
  });
  const c = classifyWriteCall("bash", { command: "rm -rf build" }, cfg);
  assert.equal(isWriteCallAllowed(c, cfg, "/work/proj"), true);
  const other = classifyWriteCall("bash", { command: "rm -rf src" }, cfg);
  assert.equal(isWriteCallAllowed(other, cfg, "/work/proj"), false);
});

// ── decideWriteGate ─────────────────────────────────────────────────

test("decideWriteGate: a non-write is always allowed", () => {
  for (const mode of ["allow", "ask", "never"] as const) {
    assert.equal(
      decideWriteGate({ mode, mutating: false, allowed: false }),
      "allow",
    );
    assert.equal(
      decideWriteGate({ mode, mutating: false, allowed: true }),
      "allow",
    );
  }
});

test("decideWriteGate: mode allow always allows", () => {
  assert.equal(
    decideWriteGate({ mode: "allow", mutating: true, allowed: false }),
    "allow",
  );
});

test("decideWriteGate: mode never blocks, even for an allow-listed path", () => {
  assert.equal(
    decideWriteGate({ mode: "never", mutating: true, allowed: false }),
    "block",
  );
  // "never" is the strongest statement of intent — a stale grant must not
  // silently re-open writes.
  assert.equal(
    decideWriteGate({ mode: "never", mutating: true, allowed: true }),
    "block",
  );
});

test("decideWriteGate: mode ask prompts unless already allowed", () => {
  assert.equal(
    decideWriteGate({ mode: "ask", mutating: true, allowed: false }),
    "ask",
  );
  assert.equal(
    decideWriteGate({ mode: "ask", mutating: true, allowed: true }),
    "allow",
  );
});

// ── describeWritePolicyMode ─────────────────────────────────────────

test("describeWritePolicyMode: every mode has a summary", () => {
  for (const mode of ["allow", "ask", "never"] as const) {
    const text = describeWritePolicyMode(mode);
    assert.equal(typeof text, "string");
    assert.ok(text.length > 0);
  }
});

// ── argument completions ────────────────────────────────────────────

test("writePolicy completions: modes at the subcommand position", () => {
  const items = writePolicyArgumentCompletions("");
  assert.ok(items);
  assert.deepEqual(
    items.map((i) => i.label),
    ["allow", "ask", "never"],
  );
  // The value carries a trailing space so the scope can be typed next.
  assert.equal(items[0].value, "allow ");
});

test("writePolicy completions: prefix filter on the mode", () => {
  const items = writePolicyArgumentCompletions("ne");
  assert.ok(items);
  assert.deepEqual(items.map((i) => i.label), ["never"]);
});

test("writePolicy completions: scope after a committed mode", () => {
  const items = writePolicyArgumentCompletions("ask ");
  assert.ok(items);
  assert.deepEqual(
    items.map((i) => i.label),
    ["global", "project"],
  );
  // The value replaces the WHOLE typed argument text.
  assert.equal(items[0].value, "ask global");
});

test("writePolicy completions: null for an unknown mode", () => {
  assert.equal(writePolicyArgumentCompletions("bogus "), null);
  assert.equal(writePolicyArgumentCompletions("zzz"), null);
});

// ── guided denial: instruction sanitizing ───────────────────────────

test("sanitizeWriteInstruction: trims and collapses whitespace", () => {
  assert.equal(sanitizeWriteInstruction("  hello  "), "hello");
  assert.equal(sanitizeWriteInstruction("a\n\n\n\nb"), "a\n\nb");
  assert.equal(sanitizeWriteInstruction("\t tab kept \n"), "tab kept");
});

test("sanitizeWriteInstruction: normalises CRLF and CR to LF", () => {
  assert.equal(sanitizeWriteInstruction("a\r\nb\rc"), "a\nb\nc");
});

test("sanitizeWriteInstruction: strips control characters but keeps tab/LF", () => {
  const raw = "a\u0000b\u001Bc\u007Fd\te\nf";
  assert.equal(sanitizeWriteInstruction(raw), "abcd\te\nf");
});

test("sanitizeWriteInstruction: empty input yields an empty string", () => {
  assert.equal(sanitizeWriteInstruction(""), "");
  assert.equal(sanitizeWriteInstruction("   \n\t  "), "");
  assert.equal(sanitizeWriteInstruction(undefined), "");
  assert.equal(sanitizeWriteInstruction(null), "");
});

test("sanitizeWriteInstruction: hard-caps the length with an ellipsis", () => {
  const long = "x".repeat(WRITE_INSTRUCTION_MAX_LEN + 500);
  const out = sanitizeWriteInstruction(long);
  assert.equal(out.length, WRITE_INSTRUCTION_MAX_LEN + 1);
  assert.ok(out.endsWith("…"));
});

// ── guided denial: choice parsing ───────────────────────────────────

test("parseWriteGateChoice: allow-once and always are recognised", () => {
  assert.equal(parseWriteGateChoice("Allow once"), "allow-once");
  assert.equal(parseWriteGateChoice("Always allow this path"), "always");
  assert.equal(parseWriteGateChoice("Always allow this command"), "always");
});

test("parseWriteGateChoice: the guided choice is matched BEFORE plain Deny", () => {
  assert.equal(
    parseWriteGateChoice(WRITE_DENY_WITH_INSTRUCTIONS_LABEL),
    "deny-with-instructions",
  );
  // The prefix is what the parser matches on — the label must keep it.
  assert.ok(WRITE_DENY_WITH_INSTRUCTIONS_LABEL.startsWith(WRITE_DENY_WITH_INSTRUCTIONS_PREFIX));
  assert.equal(parseWriteGateChoice("Deny"), "deny");
});

test("parseWriteGateChoice: unknown, blank and cancelled answers deny", () => {
  assert.equal(parseWriteGateChoice("Deny"), "deny");
  assert.equal(parseWriteGateChoice(""), "deny");
  assert.equal(parseWriteGateChoice("   "), "deny");
  assert.equal(parseWriteGateChoice(undefined), "deny");
  assert.equal(parseWriteGateChoice(null), "deny");
  assert.equal(parseWriteGateChoice("Something else"), "deny");
});

// ── guided denial: reason + guidance message ────────────────────────

test("buildWriteDenyReason: a plain denial keeps the classic wording", () => {
  const reason = buildWriteDenyReason({
    target: "C:/work/a.ts",
    why: "edits C:/work/a.ts",
  });
  assert.match(reason, /the user declined this write \(edits C:\/work\/a\.ts\)/);
  assert.match(reason, /Do not retry it\./);
  assert.match(reason, /Target: C:\/work\/a\.ts/);
});

test("buildWriteDenyReason: a guided denial quotes the instruction verbatim", () => {
  const instruction = "only explore and propose a plan, do not edit files yet";
  const reason = buildWriteDenyReason({
    target: "C:/work/a.ts",
    why: "edits C:/work/a.ts",
    instruction,
  });
  assert.ok(reason.includes(instruction));
  // The disposition line: what happened, what to do next.
  assert.match(reason, /Do not retry this write\./);
  assert.match(reason, /Follow the instruction above\./);
  assert.match(reason, /If it cannot be followed, say so and stop\./);
  assert.match(reason, /Target: C:\/work\/a\.ts/);
});

test("buildWriteDenyReason: an empty instruction degrades to a plain denial", () => {
  const guided = buildWriteDenyReason({
    target: "a.ts",
    instruction: "   ",
  });
  const plain = buildWriteDenyReason({ target: "a.ts" });
  assert.equal(guided, plain);
  assert.match(guided, /the user declined this write/);
});

test("buildWriteGuidanceMessage: carries the target and the instruction", () => {
  const instruction = "pls only explore and propose plan, do not edit file yet";
  const message = buildWriteGuidanceMessage({
    target: "C:/work/a.ts",
    instruction,
  });
  assert.ok(message.includes(instruction));
  assert.ok(message.includes("C:/work/a.ts"));
  assert.match(message, /write denied/);
  assert.match(message, /instead of retrying that write/);
});

test("buildWriteGuidanceMessage: an empty instruction is sanitized away", () => {
  const message = buildWriteGuidanceMessage({ target: "a.ts", instruction: "" });
  assert.ok(!message.includes("undefined"));
  assert.ok(message.includes("a.ts"));
});
