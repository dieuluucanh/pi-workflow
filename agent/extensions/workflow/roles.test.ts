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
