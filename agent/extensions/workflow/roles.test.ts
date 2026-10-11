/**
 * Tests for role config loading: merge precedence, non-destructive fallback
 * for missing/corrupt/legacy files, activeRole, and the change fingerprint.
 *
 * Pure fs + node:test. The loader is exercised through its path overrides so
 * the real ~/.pi/agent/roles.json is never read or written.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  ROLE_CONFIG_VERSION,
  defaultRoleConfig,
  getRole,
  loadRoleConfig,
  loadRoleConfigDetailed,
  roleArgumentCompletions,
  rolesFingerprint,
} from "./roles.ts";

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "roles-test-"));
}

function writeRolesFile(
  fp: string,
  models: Record<string, string>,
  opts?: { version?: number; activeRole?: string | null },
): void {
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(
    fp,
    JSON.stringify(
      {
        version: opts?.version ?? ROLE_CONFIG_VERSION,
        roles: Object.entries(models).map(([name, id]) => ({
          name,
          description: `${name} test role`,
          model: { provider: "prov", id, thinking: "high" },
          tools: [],
          systemPromptAddendum: "test",
        })),
        activeRole: opts?.activeRole ?? null,
      },
      null,
      2,
    ),
    "utf8",
  );
}

const seeded = (name: string): string | undefined =>
  defaultRoleConfig().roles.find((r) => r.name === name)?.model.id;

test("roles: user file supplies models and project overrides per role", () => {
  const root = tmpRoot();
  const userPath = path.join(root, "agent", "roles.json");
  const projectPath = path.join(root, "proj", ".pi", "roles.json");
  writeRolesFile(userPath, { reviewer: "user-model" });
  writeRolesFile(projectPath, { reviewer: "project-model" });

  const userOnly = loadRoleConfigDetailed(undefined, { userPath });
  assert.equal(userOnly.usedDefaults, false);
  assert.equal(userOnly.reason, undefined);
  assert.equal(getRole(userOnly.config, "reviewer")?.model.id, "user-model");

  const merged = loadRoleConfigDetailed(undefined, { userPath, projectPath });
  assert.equal(
    getRole(merged.config, "reviewer")?.model.id,
    "project-model",
    "project override wins",
  );
  assert.equal(
    getRole(merged.config, "planner")?.model.id,
    seeded("planner"),
    "roles absent from the files keep the built-in seed",
  );
});

test("roles: activeRole is read from the file", () => {
  const root = tmpRoot();
  const userPath = path.join(root, "roles.json");
  writeRolesFile(userPath, { reviewer: "m" }, { activeRole: "reviewer" });
  assert.equal(
    loadRoleConfigDetailed(undefined, { userPath }).config.activeRole,
    "reviewer",
  );
});

test("roles: a missing file uses defaults and creates nothing", () => {
  const root = tmpRoot();
  const userPath = path.join(root, "agent", "roles.json");
  const loaded = loadRoleConfigDetailed(undefined, { userPath });
  assert.equal(loaded.usedDefaults, true);
  assert.match(loaded.reason ?? "", /no roles\.json/);
  assert.equal(fs.existsSync(userPath), false, "must not seed a file");
  assert.equal(
    getRole(loaded.config, "reviewer")?.model.id,
    seeded("reviewer"),
  );
});

test("roles: a corrupt file is not overwritten", () => {
  const root = tmpRoot();
  const userPath = path.join(root, "roles.json");
  fs.writeFileSync(userPath, "{ definitely not json");
  const before = fs.readFileSync(userPath);
  const loaded = loadRoleConfigDetailed(undefined, { userPath });
  assert.equal(loaded.usedDefaults, true);
  assert.match(loaded.reason ?? "", /not valid JSON/);
  assert.deepEqual(fs.readFileSync(userPath), before, "bytes unchanged");
});

test("roles: a legacy file is ignored without rewriting", () => {
  const root = tmpRoot();
  const userPath = path.join(root, "roles.json");
  fs.writeFileSync(
    userPath,
    JSON.stringify({ version: 1, modelPool: ["x"], roles: [] }),
  );
  const before = fs.readFileSync(userPath);
  const loaded = loadRoleConfigDetailed(undefined, { userPath });
  assert.equal(loaded.usedDefaults, true);
  assert.match(loaded.reason ?? "", /incompatible roles\.json \(version 1\)/);
  assert.deepEqual(fs.readFileSync(userPath), before, "bytes unchanged");
});

test("roles: fingerprint tracks file existence and the project path", () => {
  const root = tmpRoot();
  const userPath = path.join(root, "roles.json");
  const projectPath = path.join(root, "proj-roles.json");

  const missingFp = rolesFingerprint(undefined, { userPath });
  assert.equal(
    rolesFingerprint(undefined, { userPath }),
    missingFp,
    "stable while untouched",
  );
  assert.match(missingFp, /user:missing/);
  assert.match(missingFp, /project:n\/a/);

  writeRolesFile(userPath, { reviewer: "m" });
  const presentFp = rolesFingerprint(undefined, { userPath });
  assert.notEqual(presentFp, missingFp);
  assert.match(presentFp, /user:\d/);

  const withProject = rolesFingerprint(undefined, { userPath, projectPath });
  assert.notEqual(withProject, presentFp);
  assert.match(withProject, /project:missing/);
});

test("roles: loadRoleConfig wrapper matches loadRoleConfigDetailed", () => {
  const root = tmpRoot();
  const userPath = path.join(root, "roles.json");
  writeRolesFile(userPath, { reviewer: "wrapped" });
  const detailed = loadRoleConfigDetailed(undefined, { userPath });
  const wrapped = loadRoleConfig(undefined, { userPath });
  assert.deepEqual(wrapped, detailed.config);
});

// ── roleArgumentCompletions ──────────────────────────────────────────
//
// pi-tui full-argument contract: argument-position values must be the
// complete replacement for the typed argument text ("set planner
// opencode-go/muse-…", never a bare token) — otherwise accepting a
// completion drops the already-typed tokens.

const ROLE_FIXTURE = {
  roleNames: ["planner", "explorer", "builder", "reviewer"],
  models: [
    "opencode-go/muse-spark-1.2-contributor",
    "synthetic/hf:deepseek-ai/DeepSeek-V4.1-Flash",
  ],
};

test("roleArgumentCompletions: subcommand position — terminal vs arg-taking values", () => {
  const all = roleArgumentCompletions("", ROLE_FIXTURE)!;
  assert.equal(all.find((i) => i.label === "list")!.value, "list");
  assert.equal(all.find((i) => i.label === "reset")!.value, "reset");
  assert.equal(all.find((i) => i.label === "use <role|auto>")!.value, "use ");
  assert.equal(all.find((i) => i.label.startsWith("set "))!.value, "set ");
  assert.deepEqual(roleArgumentCompletions("us", ROLE_FIXTURE)?.map((i) => i.value), ["use "]);
  assert.equal(roleArgumentCompletions("bogus", ROLE_FIXTURE), null);
});

test("roleArgumentCompletions: set — role names, then model refs, then thinking levels", () => {
  assert.deepEqual(roleArgumentCompletions("set pl", ROLE_FIXTURE)?.map((i) => i.value), [
    "set planner",
  ]);
  assert.deepEqual(
    roleArgumentCompletions("set planner syn", ROLE_FIXTURE)?.map((i) => i.value),
    ["set planner synthetic/hf:deepseek-ai/DeepSeek-V4.1-Flash"],
  );
  assert.deepEqual(
    roleArgumentCompletions("set planner opencode-go/muse-spark-1.2-contributor ", ROLE_FIXTURE)?.map((i) => i.value),
    [
      "set planner opencode-go/muse-spark-1.2-contributor off",
      "set planner opencode-go/muse-spark-1.2-contributor minimal",
      "set planner opencode-go/muse-spark-1.2-contributor low",
      "set planner opencode-go/muse-spark-1.2-contributor medium",
      "set planner opencode-go/muse-spark-1.2-contributor high",
      "set planner opencode-go/muse-spark-1.2-contributor xhigh",
      "set planner opencode-go/muse-spark-1.2-contributor max",
    ],
  );
  // arg3 filters by partial and only offers thinking levels.
  const t3 = roleArgumentCompletions("set planner opencode-go/muse-spark-1.2-contributor hi", ROLE_FIXTURE)!;
  assert.deepEqual(t3.map((i) => i.value), [
    "set planner opencode-go/muse-spark-1.2-contributor high",
  ]);
});

test("roleArgumentCompletions: set with no models yields null for the model token", () => {
  assert.equal(
    roleArgumentCompletions("set planner ", { roleNames: ["planner"] }),
    null,
  );
});

test("roleArgumentCompletions: use — role names + auto; remove — role names; add arg1 free text", () => {
  assert.deepEqual(
    roleArgumentCompletions("use rev", ROLE_FIXTURE)?.map((i) => i.value),
    ["use reviewer"],
  );
  assert.ok(roleArgumentCompletions("use ", ROLE_FIXTURE)!.some((i) => i.value === "use auto"));
  assert.deepEqual(roleArgumentCompletions("remove bu", ROLE_FIXTURE)?.map((i) => i.value), [
    "remove builder",
  ]);
  assert.equal(roleArgumentCompletions("add x", ROLE_FIXTURE), null);
});

test("roleArgumentCompletions: exact-match suppression closes the dropdown", () => {
  assert.equal(
    roleArgumentCompletions("use planner", ROLE_FIXTURE),
    null,
    "fully-typed role name → no dropdown",
  );
  assert.equal(
    roleArgumentCompletions("set planner opencode-go/muse-spark-1.2-contributor high", ROLE_FIXTURE),
    null,
    "fully-typed thinking level → no dropdown",
  );
  assert.ok(roleArgumentCompletions("use pl", ROLE_FIXTURE));
});

test("roleArgumentCompletions: applyCompletion algebra keeps the committed tokens", () => {
  const line = "/role set pl";
  const prefix = "set pl";
  const item = roleArgumentCompletions(prefix, ROLE_FIXTURE)![0];
  const newLine = line.slice(0, line.length - prefix.length) + item.value;
  assert.equal(newLine, "/role set planner");
});
