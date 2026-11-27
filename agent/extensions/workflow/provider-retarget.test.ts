/**
 * Provider retarget: profiles.json + roles.json rewrite only model refs.
 *
 * The dangerous part is not the string replacement; it is preserving every
 * unrelated field, refusing a malformed file, and never writing in a dry run.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  formatRetargetResult,
  retargetProviderDocument,
  retargetProviderFiles,
} from "./provider-retarget.ts";

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "provider-retarget-"));
}

function profilesText(): string {
  return `${JSON.stringify(
    {
      version: 1,
      profiles: [
        {
          name: "CommandCode-Deepseek",
          description: "keep this",
          roles: {
            planner: {
              provider: "command-code",
              id: "deepseek-v4.1",
              thinking: "high",
            },
            reviewer: { provider: "other", id: "auditor", thinking: "max" },
          },
          defaultModel: {
            provider: "command-code",
            id: "deepseek-v4.1",
            thinking: "low",
          },
          extra: { keep: true },
        },
      ],
      untouched: "yes",
    },
    null,
    2,
  )}\n`;
}

function rolesText(): string {
  return `${JSON.stringify(
    {
      version: 2,
      roles: [
        {
          name: "planner",
          description: "keep this",
          model: {
            provider: "command-code",
            id: "deepseek-v4.1",
            thinking: "high",
          },
          tools: ["read"],
          systemPromptAddendum: "keep this too",
          builtIn: true,
        },
        {
          name: "reviewer",
          model: { provider: "other", id: "auditor", thinking: "xhigh" },
          tools: [],
          systemPromptAddendum: "untouched",
          builtIn: true,
        },
      ],
      activeRole: null,
      untouched: { keep: true },
    },
    null,
    2,
  )}\n`;
}

function writePair(root: string): { profilesPath: string; rolesPath: string } {
  const profilesPath = path.join(root, "profiles.json");
  const rolesPath = path.join(root, "roles.json");
  fs.writeFileSync(profilesPath, profilesText(), "utf8");
  fs.writeFileSync(rolesPath, rolesText(), "utf8");
  return { profilesPath, rolesPath };
}

test("rewrites model refs while preserving every other key and the trailing newline", () => {
  const result = retargetProviderDocument(
    profilesText(),
    "command-code",
    "commandcode",
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.changes, 2);
  assert.ok(result.text.endsWith("\n"));
  const parsed = JSON.parse(result.text) as any;
  const profile = parsed.profiles[0];
  assert.equal(profile.roles.planner.provider, "commandcode");
  assert.equal(profile.defaultModel.provider, "commandcode");
  assert.equal(profile.roles.reviewer.provider, "other");
  assert.equal(profile.description, "keep this");
  assert.deepEqual(profile.extra, { keep: true });
  assert.equal(parsed.untouched, "yes");
});

test("reports invalid JSON instead of guessing", () => {
  const result = retargetProviderDocument(
    "{not json",
    "command-code",
    "commandcode",
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.error, /not valid JSON/);
});

test("is a no-op when the provider does not change", () => {
  const result = retargetProviderDocument(
    profilesText(),
    "command-code",
    "command-code",
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.changes, 0);
  assert.equal(result.text, profilesText());
});

test("a dry run never writes or creates a backup", () => {
  const root = tmpRoot();
  const { profilesPath, rolesPath } = writePair(root);
  const beforeProfiles = fs.readFileSync(profilesPath, "utf8");
  const beforeRoles = fs.readFileSync(rolesPath, "utf8");

  const result = retargetProviderFiles({
    profilesPath,
    rolesPath,
    oldProvider: "command-code",
    newProvider: "commandcode",
    dryRun: true,
  });

  assert.equal(result.profiles.status, "would-change");
  assert.equal(result.roles.status, "would-change");
  assert.equal(fs.readFileSync(profilesPath, "utf8"), beforeProfiles);
  assert.equal(fs.readFileSync(rolesPath, "utf8"), beforeRoles);
  assert.equal(fs.existsSync(`${profilesPath}.bak`), false);
  assert.equal(fs.existsSync(`${rolesPath}.bak`), false);
  assert.match(formatRetargetResult(result), /Add --apply/);
});

test("apply writes both files, backs them up, and is idempotent", () => {
  const root = tmpRoot();
  const { profilesPath, rolesPath } = writePair(root);
  const beforeProfiles = fs.readFileSync(profilesPath, "utf8");
  const beforeRoles = fs.readFileSync(rolesPath, "utf8");

  const applied = retargetProviderFiles({
    profilesPath,
    rolesPath,
    oldProvider: "command-code",
    newProvider: "commandcode",
  });
  assert.equal(applied.profiles.status, "changed");
  assert.equal(applied.roles.status, "changed");
  assert.equal(fs.readFileSync(`${profilesPath}.bak`, "utf8"), beforeProfiles);
  assert.equal(fs.readFileSync(`${rolesPath}.bak`, "utf8"), beforeRoles);
  assert.equal(
    (JSON.parse(fs.readFileSync(profilesPath, "utf8")) as any).profiles[0].roles
      .planner.provider,
    "commandcode",
  );
  assert.equal(
    (JSON.parse(fs.readFileSync(rolesPath, "utf8")) as any).roles[1].model
      .provider,
    "other",
  );

  const second = retargetProviderFiles({
    profilesPath,
    rolesPath,
    oldProvider: "command-code",
    newProvider: "commandcode",
  });
  assert.equal(second.profiles.status, "unchanged");
  assert.equal(second.roles.status, "unchanged");
});

test("a malformed file blocks both writes", () => {
  const root = tmpRoot();
  const { profilesPath, rolesPath } = writePair(root);
  fs.writeFileSync(profilesPath, "{not json", "utf8");
  const beforeRoles = fs.readFileSync(rolesPath, "utf8");

  const result = retargetProviderFiles({
    profilesPath,
    rolesPath,
    oldProvider: "command-code",
    newProvider: "commandcode",
  });

  assert.equal(result.profiles.status, "invalid");
  assert.equal(result.roles.status, "blocked");
  assert.equal(fs.readFileSync(profilesPath, "utf8"), "{not json");
  assert.equal(fs.readFileSync(rolesPath, "utf8"), beforeRoles);
  assert.equal(fs.existsSync(`${rolesPath}.bak`), false);
  assert.match(formatRetargetResult(result), /not changed/);
});

test("missing files are reported, not created", () => {
  const root = tmpRoot();
  const result = retargetProviderFiles({
    profilesPath: path.join(root, "profiles.json"),
    rolesPath: path.join(root, "roles.json"),
    oldProvider: "command-code",
    newProvider: "commandcode",
  });
  assert.equal(result.profiles.status, "missing");
  assert.equal(result.roles.status, "missing");
  assert.equal(fs.existsSync(path.join(root, "profiles.json")), false);
});
