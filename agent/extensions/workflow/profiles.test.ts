/**
 * Tests for profile config loading/saving and the profile overlay:
 * merge precedence (user + project), non-destructive fallback for
 * missing/corrupt/legacy files, name validation, applyProfileOverlay, the
 * change fingerprint, and the workflow.defaultProfile setting helpers.
 *
 * Pure fs + node:test. Everything is exercised through path overrides /
 * explicit (cwd, agentDir) pairs so the real ~/.pi/agent files are never
 * read or written. (saveProfiles is covered via project scope + a tmp cwd —
 * the user-scope save path writes the real agent dir by design.)
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  PROFILE_CONFIG_VERSION,
  defaultProfileConfig,
  loadProfiles,
  loadProfilesDetailed,
  profilesFingerprint,
  saveProfiles,
  getProfile,
  profileArgumentCompletions,
  validateProfileName,
  applyProfileOverlay,
  sanitizeProfile,
  missingProfileRoles,
  extractDefaultProfile,
  readDefaultProfileSetting,
  writeDefaultProfileSetting,
  type Profile,
} from "./profiles.ts";
import { joinArgumentValue } from "./utils.ts";
import { defaultRoleConfig, getRole } from "./roles.ts";

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "profiles-test-"));
}

function writeProfilesFile(
  fp: string,
  profiles: unknown[],
  opts?: { version?: number },
): void {
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(
    fp,
    JSON.stringify(
      {
        version: opts?.version ?? PROFILE_CONFIG_VERSION,
        profiles,
      },
      null,
      2,
    ),
    "utf8",
  );
}

const cheapProfile = {
  name: "cheap",
  description: "budget mix",
  roles: {
    planner: { provider: "prov-a", id: "model-a", thinking: "high" },
    explorer: { provider: "prov-b", id: "model-b", thinking: "low" },
    builder: { provider: "prov-b", id: "model-b", thinking: "medium" },
    reviewer: { provider: "prov-a", id: "model-c", thinking: "xhigh" },
  },
};

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

// ── Loader: non-destructive fallback ─────────────────────────────────

test("profiles: a missing file uses an empty config and creates nothing", () => {
  const root = tmpRoot();
  const userPath = path.join(root, "agent", "profiles.json");
  const loaded = loadProfilesDetailed(undefined, { userPath });
  assert.equal(loaded.usedDefaults, true);
  assert.equal(loaded.severity, "info", "a missing file is the normal empty state");
  assert.match(loaded.reason ?? "", /no profiles\.json/);
  assert.equal(fs.existsSync(userPath), false, "must not seed a file");
  assert.deepEqual(loaded.config.profiles, []);
  assert.deepEqual(loadProfiles(undefined, { userPath }), loaded.config);
});

test("profiles: a corrupt file is not overwritten", () => {
  const root = tmpRoot();
  const userPath = path.join(root, "profiles.json");
  fs.writeFileSync(userPath, "{ definitely not json");
  const before = fs.readFileSync(userPath);
  const loaded = loadProfilesDetailed(undefined, { userPath });
  assert.equal(loaded.usedDefaults, true);
  assert.equal(loaded.severity, "warning");
  assert.match(loaded.reason ?? "", /not valid JSON/);
  assert.deepEqual(fs.readFileSync(userPath), before, "bytes unchanged");
});

test("profiles: a wrong-version file is ignored without rewriting", () => {
  const root = tmpRoot();
  const userPath = path.join(root, "profiles.json");
  fs.writeFileSync(userPath, JSON.stringify({ version: 99, profiles: [] }));
  const before = fs.readFileSync(userPath);
  const loaded = loadProfilesDetailed(undefined, { userPath });
  assert.equal(loaded.usedDefaults, true);
  assert.equal(loaded.severity, "warning");
  assert.match(loaded.reason ?? "", /incompatible profiles\.json \(version 99\)/);
  assert.deepEqual(fs.readFileSync(userPath), before, "bytes unchanged");
});

// ── Loader: merge precedence ─────────────────────────────────────────

test("profiles: user file supplies profiles and project overrides by name", () => {
  const root = tmpRoot();
  const userPath = path.join(root, "agent", "profiles.json");
  const projectPath = path.join(root, "proj", ".pi", "profiles.json");
  writeProfilesFile(userPath, [
    clone(cheapProfile),
    {
      name: "premium",
      roles: { planner: { provider: "p", id: "m1", thinking: "high" } },
    },
  ]);
  writeProfilesFile(projectPath, [
    // Same name → project wins wholesale (per-profile replace).
    {
      name: "cheap",
      description: "project variant",
      roles: { planner: { provider: "p", id: "proj-model", thinking: "low" } },
    },
  ]);

  const userOnly = loadProfilesDetailed(undefined, { userPath });
  assert.equal(userOnly.usedDefaults, false);
  assert.equal(userOnly.config.profiles.length, 2);
  assert.equal(
    getProfile(userOnly.config, "CHEAP")?.roles.planner?.id,
    "model-a",
    "lookup is case-insensitive",
  );

  const merged = loadProfilesDetailed(undefined, { userPath, projectPath });
  const cheap = getProfile(merged.config, "cheap");
  assert.equal(cheap?.roles.planner?.id, "proj-model", "project override wins");
  assert.equal(
    cheap?.roles.reviewer,
    undefined,
    "project profile replaces, not field-merges",
  );
  assert.equal(
    getProfile(merged.config, "premium")?.roles.planner?.id,
    "m1",
    "profiles absent from the project file survive",
  );
});

// ── Sanitizing ───────────────────────────────────────────────────────

test("profiles: sanitizer drops bad entries, unknown role keys and invalid models", () => {
  const root = tmpRoot();
  const userPath = path.join(root, "profiles.json");
  writeProfilesFile(userPath, [
    null,
    { description: "no name" },
    { name: "", roles: {} },
    {
      name: "ok",
      roles: {
        planner: { provider: "p", id: "m", thinking: "bogus" },
        customRole: { provider: "p", id: "x", thinking: "high" },
        explorer: { provider: "", id: "", thinking: "high" },
      },
    },
  ]);
  const config = loadProfiles(undefined, { userPath });
  assert.equal(config.profiles.length, 1);
  const ok = config.profiles[0];
  assert.equal(ok.name, "ok");
  assert.equal(
    ok.roles.planner?.thinking,
    "medium",
    "invalid thinking falls back to medium",
  );
  assert.equal(
    (ok.roles as Record<string, unknown>).customRole,
    undefined,
    "unknown role keys dropped",
  );
  assert.equal(ok.roles.explorer, undefined, "empty provider/id dropped");
  assert.deepEqual(missingProfileRoles(ok), [
    "explorer",
    "builder",
    "reviewer",
  ]);
});

// ── Name validation ──────────────────────────────────────────────────

test("profiles: name validation rules", () => {
  assert.equal(validateProfileName("").ok, false);
  assert.equal(validateProfileName("   ").ok, false);
  assert.equal(validateProfileName("x".repeat(41)).ok, false);
  assert.equal(validateProfileName("has space").ok, false);
  assert.equal(validateProfileName("tab\tname").ok, false);
  assert.equal(validateProfileName("none").ok, false);
  assert.equal(
    validateProfileName("NONE").ok,
    false,
    "reserved check is case-insensitive",
  );
  assert.equal(validateProfileName("auto").ok, false);
  assert.equal(validateProfileName("ctrl\u0007char").ok, false);

  const ok = validateProfileName("  Cheap_Work-1  ");
  assert.ok(ok.ok);
  if (ok.ok) assert.equal(ok.value, "Cheap_Work-1", "trimmed, stored as entered");

  assert.equal(
    validateProfileName("cheap", ["Cheap"]).ok,
    false,
    "case-insensitive duplicate",
  );
  assert.equal(validateProfileName("other", ["Cheap"]).ok, true);
});

// ── Overlay ──────────────────────────────────────────────────────────

test("profiles: applyProfileOverlay overrides models only and never mutates the base", () => {
  const base = defaultRoleConfig();
  const before = JSON.stringify(base.roles);
  const profile: Profile = {
    name: "cheap",
    description: "",
    roles: {
      planner: { provider: "prov-a", id: "model-a", thinking: "high" },
      // explorer intentionally missing → falls back to base
    },
  };

  const effective = applyProfileOverlay(base.roles, profile);
  assert.equal(JSON.stringify(base.roles), before, "base untouched");
  assert.notEqual(effective, base.roles, "returns a new array");
  assert.notEqual(effective[0], base.roles[0], "roles are copied, not shared");

  const cfg = { ...base, roles: effective };
  const planner = getRole(cfg, "planner");
  assert.equal(planner?.model.provider, "prov-a");
  assert.equal(planner?.model.id, "model-a");
  assert.equal(planner?.model.thinking, "high");
  const basePlanner = base.roles.find((r) => r.name === "planner");
  assert.deepEqual(
    planner?.tools,
    basePlanner?.tools,
    "role identity (tools) preserved",
  );
  assert.equal(
    planner?.systemPromptAddendum,
    basePlanner?.systemPromptAddendum,
    "role identity (prompt) preserved",
  );

  const explorer = getRole(cfg, "explorer");
  assert.equal(
    explorer?.model.id,
    base.roles.find((r) => r.name === "explorer")?.model.id,
    "missing role falls back to base",
  );

  // A null profile → behaviourally identical copy (the no-profile fallback).
  const none = applyProfileOverlay(base.roles, null);
  assert.equal(none.length, base.roles.length);
  assert.deepEqual(none, base.roles);
  assert.notEqual(none, base.roles);
});

// ── Fingerprint ──────────────────────────────────────────────────────

test("profiles: fingerprint tracks file existence and the project path", () => {
  const root = tmpRoot();
  const userPath = path.join(root, "profiles.json");
  const projectPath = path.join(root, "proj-profiles.json");

  const missingFp = profilesFingerprint(undefined, { userPath });
  assert.equal(
    profilesFingerprint(undefined, { userPath }),
    missingFp,
    "stable while untouched",
  );
  assert.match(missingFp, /user:missing/);
  assert.match(missingFp, /project:n\/a/);

  writeProfilesFile(userPath, []);
  const presentFp = profilesFingerprint(undefined, { userPath });
  assert.notEqual(presentFp, missingFp);
  assert.match(presentFp, /user:\d/);

  const withProject = profilesFingerprint(undefined, { userPath, projectPath });
  assert.notEqual(withProject, presentFp);
  assert.match(withProject, /project:missing/);
});

// ── Save → load round-trip ───────────────────────────────────────────

test("profiles: save → load round-trip (project scope, tmp cwd)", () => {
  const root = tmpRoot();
  const cwd = path.join(root, "proj");
  const config = defaultProfileConfig();
  config.profiles.push(clone(cheapProfile) as Profile);

  saveProfiles(config, "project", cwd);
  const fp = path.join(cwd, ".pi", "profiles.json");
  assert.equal(fs.existsSync(fp), true);

  const loaded = loadProfiles(undefined, {
    userPath: path.join(root, "nonexistent", "profiles.json"),
    projectPath: fp,
  });
  assert.deepEqual(loaded, config);
});

// ── workflow.defaultProfile setting ──────────────────────────────────

test("profiles: extractDefaultProfile coercion", () => {
  assert.equal(extractDefaultProfile(undefined), undefined);
  assert.equal(extractDefaultProfile("x"), undefined);
  assert.equal(extractDefaultProfile({}), undefined);
  assert.equal(extractDefaultProfile({ workflow: {} }), undefined);
  assert.equal(
    extractDefaultProfile({ workflow: { defaultProfile: 42 } }),
    undefined,
  );
  assert.equal(
    extractDefaultProfile({ workflow: { defaultProfile: "  " } }),
    undefined,
  );
  assert.equal(
    extractDefaultProfile({ workflow: { defaultProfile: "cheap" } }),
    "cheap",
  );
  assert.equal(
    extractDefaultProfile({ workflow: { defaultProfile: " Cheap " } }),
    "Cheap",
  );
});

test("profiles: default profile setting — project wins, writes preserve other keys, clear works", () => {
  const root = tmpRoot();
  const agentDir = path.join(root, "agent");
  const cwd = path.join(root, "proj");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });

  // Neither file → default.
  assert.deepEqual(readDefaultProfileSetting(cwd, agentDir), {
    value: undefined,
    sources: { global: false, project: false, effective: "default" },
  });

  // Write global.
  const res1 = writeDefaultProfileSetting("global", cwd, agentDir, "cheap");
  assert.equal(res1.ok, true);
  const globalSettings = JSON.parse(
    fs.readFileSync(path.join(agentDir, "settings.json"), "utf8"),
  );
  assert.equal(globalSettings.workflow.defaultProfile, "cheap");
  assert.equal(
    readDefaultProfileSetting(cwd, agentDir).sources.effective,
    "global",
  );

  // Unrelated keys in BOTH files survive a write (Pi owns settings.json).
  globalSettings.other = { keep: true };
  fs.writeFileSync(
    path.join(agentDir, "settings.json"),
    JSON.stringify(globalSettings, null, 2),
  );
  fs.writeFileSync(
    path.join(cwd, ".pi", "settings.json"),
    JSON.stringify({ unrelated: true }, null, 2),
  );

  // Project override wins over global.
  const res2 = writeDefaultProfileSetting("project", cwd, agentDir, "premium");
  assert.equal(res2.ok, true);
  const resolved = readDefaultProfileSetting(cwd, agentDir);
  assert.equal(resolved.value, "premium");
  assert.equal(resolved.sources.effective, "project");
  assert.equal(resolved.sources.global, true);
  assert.equal(resolved.sources.project, true);
  const projectSettings = JSON.parse(
    fs.readFileSync(path.join(cwd, ".pi", "settings.json"), "utf8"),
  );
  assert.equal(
    projectSettings.unrelated,
    true,
    "project write preserves other keys",
  );
  assert.equal(projectSettings.workflow.defaultProfile, "premium");

  // Clearing the project setting removes the key (and the empty workflow
  // object) and falls back to global.
  const res3 = writeDefaultProfileSetting("project", cwd, agentDir, null);
  assert.equal(res3.ok, true);
  const projectAfter = JSON.parse(
    fs.readFileSync(path.join(cwd, ".pi", "settings.json"), "utf8"),
  );
  assert.equal(projectAfter.workflow, undefined);
  assert.equal(projectAfter.unrelated, true);
  assert.equal(readDefaultProfileSetting(cwd, agentDir).value, "cheap");

  // Invalid names are refused on write.
  const res4 = writeDefaultProfileSetting("global", cwd, agentDir, "has space");
  assert.equal(res4.ok, false);
  assert.match(res4.error ?? "", /whitespace/);
});

// ── Argument completions (/profile) ──────────────────────────────────
//
// Contract: pi-tui's CombinedAutocompleteProvider passes getArgumentCompletions
// the ENTIRE typed argument text and applyCompletion replaces that whole text
// with item.value — so an argument-position value must be the full argument
// ("use Syn-…"), never a bare token (the /mcp extension is the reference).

const COMPLETION_PROFILES: Profile[] = [
  {
    name: "Syn-GLM-5.3-Flash-Planner",
    description: "glm planner",
    roles: {
      planner: { provider: "synthetic", id: "hf:zai-org/GLM-5.3-Flash", thinking: "high" },
    },
  },
  {
    name: "Syn-Deepseek-v4.1-Flash-Planner",
    description: "",
    roles: {
      planner: {
        provider: "synthetic",
        id: "hf:deepseek-ai/DeepSeek-V4.1-Flash",
        thinking: "xhigh",
      },
    },
  },
  { name: "cheap", description: "", roles: {} },
] as unknown as Profile[];

function completionValues(prefix: string): string[] {
  return (profileArgumentCompletions(prefix, COMPLETION_PROFILES) ?? []).map(
    (i) => i.value,
  );
}

function completionLabels(prefix: string): string[] {
  return (profileArgumentCompletions(prefix, COMPLETION_PROFILES) ?? []).map(
    (i) => i.label,
  );
}

test("profiles: argument completions carry the FULL argument text (the /profile use regression)", () => {
  const values = completionValues("use Syn-De");
  assert.deepEqual(values, [
    "use Syn-Deepseek-v4.1-Flash-Planner",
  ]);
  // Every argument-position value starts with the typed subcommand.
  for (const v of values) assert.ok(v.startsWith("use "));
});

test("profiles: completions survive pi-tui applyCompletion algebra (pure string simulation)", () => {
  // pi-tui dist/autocomplete.js applyCompletion, slash-argument branch:
  //   beforePrefix = currentLine.slice(0, cursorCol - prefix.length)
  //   newLine      = beforePrefix + item.value
  // where `prefix` is the ENTIRE argumentText pi passed to
  // getArgumentCompletions (e.g. "use Syn-De"). Reference implementation:
  // pi's /mcp extension ("login servername" full-argument values).
  const line = "/profile use Syn-De";
  const prefix = "use Syn-De";
  const item = profileArgumentCompletions(prefix, COMPLETION_PROFILES)![0];
  const cursorCol = line.length;
  const beforePrefix = line.slice(0, cursorCol - prefix.length);
  const newLine = beforePrefix + item.value;
  assert.equal(
    newLine,
    "/profile use Syn-Deepseek-v4.1-Flash-Planner",
    "accepting the suggestion must keep the `use` subcommand",
  );
});

test("profiles: joinArgumentValue keeps committed tokens", () => {
  assert.equal(
    joinArgumentValue("use Syn-De", "Syn-Deepseek-v4.1-Flash-Planner"),
    "use Syn-Deepseek-v4.1-Flash-Planner",
  );
  assert.equal(joinArgumentValue("use ", "none"), "use none");
  assert.equal(joinArgumentValue("", "list"), "list");
  assert.equal(joinArgumentValue("u", "use"), "use");
  assert.equal(joinArgumentValue("default p g", "global"), "default p global");
});

test("profiles: 'use ' (trailing space) offers all profiles + none, all full-argument", () => {
  assert.deepEqual(completionValues("use "), [
    "use Syn-GLM-5.3-Flash-Planner",
    "use Syn-Deepseek-v4.1-Flash-Planner",
    "use cheap",
    "use none",
  ]);
});

test("profiles: subcommand position — values, trailing space, empty prefix", () => {
  // Empty prefix → every subcommand.
  const all = profileArgumentCompletions("", COMPLETION_PROFILES)!;
  assert.ok(all.length >= 8);
  const use = all.find((i) => i.label === "use <name|none>")!;
  assert.equal(use.value, "use ", "arg-taking subcommands complete with a trailing space");
  const list = all.find((i) => i.label === "list")!;
  assert.equal(list.value, "list", "terminal subcommands carry no trailing space");

  // Partial "u" → only `use`, still with the trailing space.
  assert.deepEqual(completionValues("u"), ["use "]);

  // Partial "li" → only `list`.
  assert.deepEqual(completionValues("li"), ["list"]);
});

test("profiles: bare profile name at the subcommand position completes to the detail form", () => {
  assert.deepEqual(completionValues("syn"), [
    "Syn-GLM-5.3-Flash-Planner",
    "Syn-Deepseek-v4.1-Flash-Planner",
  ]);
  // Descriptions pass through for the bare-name fallback.
  assert.deepEqual(completionLabels("syn-g"), ["Syn-GLM-5.3-Flash-Planner"]);
});

test("profiles: default — name token, then global|project scope token", () => {
  assert.deepEqual(completionValues("default Syn-De"), [
    "default Syn-Deepseek-v4.1-Flash-Planner",
  ]);
  assert.deepEqual(
    completionValues("default Syn-Deepseek-v4.1-Flash-Planner "),
    [
      "default Syn-Deepseek-v4.1-Flash-Planner global",
      "default Syn-Deepseek-v4.1-Flash-Planner project",
    ],
  );
  assert.deepEqual(completionValues("default cheap g"), [
    "default cheap global",
  ]);
  // none is offered for default's name token too.
  assert.ok(completionValues("default n").includes("default none"));
});

test("profiles: rename completes the OLD name only; the new name is free text", () => {
  assert.deepEqual(completionValues("rename Syn-De"), [
    "rename Syn-Deepseek-v4.1-Flash-Planner",
  ]);
  assert.equal(
    profileArgumentCompletions("rename Syn-Deepseek-v4.1-Flash-Planner ", COMPLETION_PROFILES),
    null,
  );
});

test("profiles: aliases are preserved verbatim in the replacement value", () => {
  assert.deepEqual(completionValues("activate Sy"), [
    "activate Syn-GLM-5.3-Flash-Planner",
    "activate Syn-Deepseek-v4.1-Flash-Planner",
  ]);
});

test("profiles: unknown subcommands and free-text args yield no completions", () => {
  assert.equal(profileArgumentCompletions("bogus Sy", COMPLETION_PROFILES), null);
  assert.equal(profileArgumentCompletions("create x", COMPLETION_PROFILES), null);
});

test("profiles: exact-match suppression closes the dropdown so the first Enter submits", () => {
  assert.equal(
    profileArgumentCompletions("use Syn-Deepseek-v4.1-Flash-Planner", COMPLETION_PROFILES),
    null,
    "fully-typed profile name → no dropdown",
  );
  assert.equal(
    profileArgumentCompletions("default cheap global", COMPLETION_PROFILES),
    null,
    "fully-typed scope token → no dropdown",
  );
  // Partial typing still shows the list.
  assert.ok(profileArgumentCompletions("use Syn-De", COMPLETION_PROFILES));
});

test("profiles: the none candidate is filtered by the partial token", () => {
  const labels = completionLabels("use Sy");
  assert.ok(!labels.includes("none"), "none must not appear for a name partial");
  const withN = completionLabels("use n");
  assert.ok(withN.includes("none"));
  assert.ok(!withN.some((l) => l.startsWith("Syn-")), "name partial filters names");
});

test("profiles: 'off' is now a reserved profile name", () => {
  assert.equal(validateProfileName("off").ok, false);
  assert.equal(validateProfileName("OFF").ok, false, "reserved check is case-insensitive");
});

test("profiles: defaultModel round-trips through sanitize", () => {
  const root = tmpRoot();
  const userPath = path.join(root, "agent", "profiles.json");
  writeProfilesFile(userPath, [
    {
      name: "cheap",
      description: "budget mix",
      roles: {
        planner: { provider: "prov-a", id: "model-a", thinking: "high" },
      },
      defaultModel: { provider: "prov-b", id: "model-b", thinking: "low" },
    },
  ]);
  const cfg = loadProfiles(root, { userPath });
  const p = getProfile(cfg, "cheap");
  assert.ok(p);
  assert.deepEqual(p!.defaultModel, { provider: "prov-b", id: "model-b", thinking: "low" });
});

test("profiles: roles.default alias promotes to defaultModel", () => {
  const raw = {
    name: "alias",
    roles: {
      planner: { provider: "prov-a", id: "model-a", thinking: "high" },
      default: { provider: "prov-c", id: "model-c", thinking: "medium" },
    },
  };
  const p = sanitizeProfile(raw);
  assert.ok(p);
  assert.deepEqual(p!.defaultModel, { provider: "prov-c", id: "model-c", thinking: "medium" });
  assert.equal((p!.roles as any).default, undefined);
});

test("profiles: missing defaultModel keeps undefined", () => {
  const p = sanitizeProfile({
    name: "nodef",
    roles: { planner: { provider: "p", id: "m", thinking: "high" } },
  });
  assert.ok(p);
  assert.equal(p!.defaultModel, undefined);
});
