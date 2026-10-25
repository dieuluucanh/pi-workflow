/**
 * Workflow Extension — Persisted Default Model tests
 *
 * Run with: npm test   (node --test, type-stripping — no build step)
 *
 * Covers the pure surface: coercion of untrusted fragments, project-over-global
 * precedence, the "preserve every other key" read-modify-write guarantee, the
 * mirrored Pi keys, byte-identical idempotency, and every branch of the
 * session-start apply rule.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  MODEL_DEFAULT_KEY,
  coerceModelDefault,
  describeModelDefaultApply,
  extractModelDefault,
  formatPersistedModel,
  modelDefaultSettingPaths,
  modelDefaultWriteScope,
  readModelDefault,
  sameModelRef,
  shouldApplyModelDefaultAtSessionStart,
  shouldPersistModelSelect,
  shouldPersistThinkingSelect,
  writeModelDefault,
} from "./model-default.ts";
import { WORKFLOW_SETTINGS_KEY } from "./commit-policy.ts";

function tmpCwd(): { cwd: string; agentDir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-model-default-"));
  return {
    cwd: dir,
    agentDir: path.join(dir, "agent"),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

function readJson(fp: string): Record<string, any> {
  return JSON.parse(fs.readFileSync(fp, "utf8"));
}

// ── Coercion ─────────────────────────────────────────────────────────

test("coerce: accepts a full record and normalises thinking case", () => {
  assert.deepEqual(
    coerceModelDefault({
      provider: " opencode-go ",
      id: " deepseek-v4.1-flash ",
      thinking: "HIGH",
    }),
    {
      provider: "opencode-go",
      id: "deepseek-v4.1-flash",
      thinking: "high",
    },
  );
});

test("coerce: drops an invalid thinking level but keeps the model", () => {
  assert.deepEqual(
    coerceModelDefault({ provider: "p", id: "m", thinking: "ultra" }),
    { provider: "p", id: "m" },
  );
});

test("coerce: rejects garbage, arrays, blanks and wrong types", () => {
  for (const raw of [
    undefined,
    null,
    "p/m",
    42,
    [],
    {},
    { provider: "", id: "m" },
    { provider: "p", id: "   " },
    { provider: 1, id: "m" },
  ]) {
    assert.equal(coerceModelDefault(raw), undefined, JSON.stringify(raw));
  }
});

test("sameModelRef: provider+id decide, thinking only when both define it", () => {
  const base = { provider: "p", id: "m" };
  assert.equal(sameModelRef(base, { provider: "p", id: "m" }), true);
  assert.equal(sameModelRef(base, { provider: "p", id: "m", thinking: "high" }), true);
  assert.equal(
    sameModelRef({ ...base, thinking: "high" }, { ...base, thinking: "low" }),
    false,
  );
  assert.equal(sameModelRef(base, { provider: "p", id: "other" }), false);
  assert.equal(sameModelRef(base, { provider: "q", id: "m" }), false);
  assert.equal(sameModelRef(undefined, base), false);
  assert.equal(sameModelRef(base, undefined), false);
});

test("format: provider/id, no thinking suffix", () => {
  assert.equal(
    formatPersistedModel({ provider: "synthetic", id: "hf:x/y", thinking: "max" } as any),
    "synthetic/hf:x/y",
  );
});

// ── Reading ──────────────────────────────────────────────────────────

test("paths: global under agentDir, project under <cwd>/.pi", () => {
  assert.deepEqual(modelDefaultSettingPaths("/work/proj", "/agent"), {
    global: path.join("/agent", "settings.json"),
    project: path.join("/work/proj", ".pi", "settings.json"),
  });
});

test("read: absent files report the default source and no value", () => {
  const { cwd, agentDir, cleanup } = tmpCwd();
  try {
    const res = readModelDefault(cwd, agentDir);
    assert.equal(res.value, undefined);
    assert.deepEqual(res.sources, {
      global: false,
      project: false,
      effective: "default",
    });
  } finally {
    cleanup();
  }
});

test("read: corrupt files are ignored, never throw", () => {
  const { cwd, agentDir, cleanup } = tmpCwd();
  try {
    fs.mkdirSync(agentDir, { recursive: true });
    fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
    fs.writeFileSync(path.join(agentDir, "settings.json"), "{not json", "utf8");
    fs.writeFileSync(path.join(cwd, ".pi", "settings.json"), "]]]", "utf8");
    const res = readModelDefault(cwd, agentDir);
    assert.equal(res.value, undefined);
    assert.equal(res.sources.effective, "default");
  } finally {
    cleanup();
  }
});

test("read: extract ignores the key when the workflow bag is not an object", () => {
  assert.equal(extractModelDefault(undefined), undefined);
  assert.equal(extractModelDefault([]), undefined);
  assert.equal(extractModelDefault({ [WORKFLOW_SETTINGS_KEY]: "nope" }), undefined);
  assert.equal(extractModelDefault({ [WORKFLOW_SETTINGS_KEY]: [] }), undefined);
  assert.deepEqual(
    extractModelDefault({
      [WORKFLOW_SETTINGS_KEY]: { [MODEL_DEFAULT_KEY]: { provider: "p", id: "m" } },
    }),
    { provider: "p", id: "m" },
  );
});

test("read: project wins over global, both sources reported", () => {
  const { cwd, agentDir, cleanup } = tmpCwd();
  try {
    writeModelDefault("global", cwd, agentDir, { provider: "g", id: "global-model" });
    writeModelDefault("project", cwd, agentDir, { provider: "p", id: "project-model" });
    const res = readModelDefault(cwd, agentDir);
    assert.deepEqual(res.value, { provider: "p", id: "project-model" });
    assert.deepEqual(res.sources, {
      global: true,
      project: true,
      effective: "project",
    });
  } finally {
    cleanup();
  }
});

test("writeScope: global until the project file defines the key", () => {
  const { cwd, agentDir, cleanup } = tmpCwd();
  try {
    assert.equal(modelDefaultWriteScope(cwd, agentDir), "global");
    writeModelDefault("project", cwd, agentDir, { provider: "p", id: "m" });
    assert.equal(modelDefaultWriteScope(cwd, agentDir), "project");
  } finally {
    cleanup();
  }
});

// ── Writing ──────────────────────────────────────────────────────────

test("write: round-trips the extension key and mirrors the Pi keys", () => {
  const { cwd, agentDir, cleanup } = tmpCwd();
  try {
    const res = writeModelDefault("global", cwd, agentDir, {
      provider: "opencode-go",
      id: "deepseek-v4.1-flash",
      thinking: "high",
    });
    assert.equal(res.ok, true);
    assert.equal(res.changed, true);
    assert.equal(res.path, path.join(agentDir, "settings.json"));

    const root = readJson(res.path);
    assert.deepEqual(root[WORKFLOW_SETTINGS_KEY][MODEL_DEFAULT_KEY], {
      provider: "opencode-go",
      id: "deepseek-v4.1-flash",
      thinking: "high",
    });
    assert.equal(root.defaultProvider, "opencode-go");
    assert.equal(root.defaultModel, "deepseek-v4.1-flash");
    assert.equal(root.defaultThinkingLevel, "high");
  } finally {
    cleanup();
  }
});

test("write: no thinking clears the mirrored defaultThinkingLevel", () => {
  const { cwd, agentDir, cleanup } = tmpCwd();
  try {
    const fp = path.join(agentDir, "settings.json");
    writeModelDefault("global", cwd, agentDir, {
      provider: "p",
      id: "m",
      thinking: "high",
    });
    assert.equal(readJson(fp).defaultThinkingLevel, "high");
    writeModelDefault("global", cwd, agentDir, { provider: "p", id: "m2" });
    const root = readJson(fp);
    assert.equal(root.defaultThinkingLevel, undefined);
    assert.equal("defaultThinkingLevel" in root, false);
    assert.equal(root.defaultModel, "m2");
  } finally {
    cleanup();
  }
});

test("write: preserves every unrelated key, including other workflow settings", () => {
  const { cwd, agentDir, cleanup } = tmpCwd();
  try {
    fs.mkdirSync(agentDir, { recursive: true });
    const fp = path.join(agentDir, "settings.json");
    fs.writeFileSync(
      fp,
      JSON.stringify(
        {
          retry: { maxRetries: 5 },
          enabledModels: ["a/b", "c/d"],
          [WORKFLOW_SETTINGS_KEY]: {
            defaultProfile: "Opencode-Free",
            commitPolicy: { mode: "never" },
            writePolicy: { mode: "allow" },
            unrelated: "keep-me",
          },
          top: [1, 2, 3],
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );

    const res = writeModelDefault("global", cwd, agentDir, {
      provider: "p",
      id: "m",
      thinking: "medium",
    });
    assert.equal(res.ok, true);

    const root = readJson(fp);
    assert.deepEqual(root.retry, { maxRetries: 5 });
    assert.deepEqual(root.enabledModels, ["a/b", "c/d"]);
    assert.deepEqual(root.top, [1, 2, 3]);
    assert.equal(root[WORKFLOW_SETTINGS_KEY].defaultProfile, "Opencode-Free");
    assert.deepEqual(root[WORKFLOW_SETTINGS_KEY].commitPolicy, { mode: "never" });
    assert.deepEqual(root[WORKFLOW_SETTINGS_KEY].writePolicy, { mode: "allow" });
    assert.equal(root[WORKFLOW_SETTINGS_KEY].unrelated, "keep-me");
    assert.deepEqual(root[WORKFLOW_SETTINGS_KEY][MODEL_DEFAULT_KEY], {
      provider: "p",
      id: "m",
      thinking: "medium",
    });
  } finally {
    cleanup();
  }
});

test("write: idempotent — an identical value does not touch the file", () => {
  const { cwd, agentDir, cleanup } = tmpCwd();
  try {
    writeModelDefault("global", cwd, agentDir, {
      provider: "p",
      id: "m",
      thinking: "high",
    });
    const fp = path.join(agentDir, "settings.json");
    const before = fs.readFileSync(fp, "utf8");
    const second = writeModelDefault("global", cwd, agentDir, {
      provider: "p",
      id: "m",
      thinking: "high",
    });
    assert.equal(second.ok, true);
    assert.equal(second.changed, false);
    assert.equal(fs.readFileSync(fp, "utf8"), before);
  } finally {
    cleanup();
  }
});

test("write: null clears the extension key and the mirrored keys only", () => {
  const { cwd, agentDir, cleanup } = tmpCwd();
  try {
    writeModelDefault("global", cwd, agentDir, {
      provider: "p",
      id: "m",
      thinking: "high",
    });
    const fp = path.join(agentDir, "settings.json");
    const rootBefore = readJson(fp);
    rootBefore.theme = "dark";
    rootBefore[WORKFLOW_SETTINGS_KEY].defaultProfile = "Keep";
    fs.writeFileSync(fp, JSON.stringify(rootBefore, null, 2) + "\n", "utf8");

    const res = writeModelDefault("global", cwd, agentDir, null);
    assert.equal(res.ok, true);
    const root = readJson(fp);
    assert.equal(MODEL_DEFAULT_KEY in root[WORKFLOW_SETTINGS_KEY], false);
    assert.equal("defaultProvider" in root, false);
    assert.equal("defaultModel" in root, false);
    assert.equal("defaultThinkingLevel" in root, false);
    assert.equal(root.theme, "dark");
    assert.equal(root[WORKFLOW_SETTINGS_KEY].defaultProfile, "Keep");
  } finally {
    cleanup();
  }
});

test("write: clearing removes an empty workflow bag, keeps a populated one", () => {
  const { cwd, agentDir, cleanup } = tmpCwd();
  try {
    const fp = path.join(agentDir, "settings.json");
    writeModelDefault("global", cwd, agentDir, { provider: "p", id: "m" });
    writeModelDefault("global", cwd, agentDir, null);
    const root = readJson(fp);
    assert.equal(WORKFLOW_SETTINGS_KEY in root, false);

    fs.writeFileSync(
      fp,
      JSON.stringify({ [WORKFLOW_SETTINGS_KEY]: { reviewMode: { enabled: true } } }) + "\n",
      "utf8",
    );
    writeModelDefault("global", cwd, agentDir, null);
    assert.deepEqual(readJson(fp)[WORKFLOW_SETTINGS_KEY], {
      reviewMode: { enabled: true },
    });
  } finally {
    cleanup();
  }
});

test("write: rejects a blank provider/id without touching the file", () => {
  const { cwd, agentDir, cleanup } = tmpCwd();
  try {
    const res = writeModelDefault("global", cwd, agentDir, {
      provider: "  ",
      id: "m",
    });
    assert.equal(res.ok, false);
    assert.match(String(res.error), /provider and id/);
    assert.equal(fs.existsSync(res.path), false);
  } finally {
    cleanup();
  }
});

test("write: an invalid thinking is stripped, the model still lands", () => {
  const { cwd, agentDir, cleanup } = tmpCwd();
  try {
    const res = writeModelDefault("global", cwd, agentDir, {
      provider: "p",
      id: "m",
      thinking: "ultra" as any,
    });
    assert.equal(res.ok, true);
    const root = readJson(res.path);
    assert.deepEqual(root[WORKFLOW_SETTINGS_KEY][MODEL_DEFAULT_KEY], {
      provider: "p",
      id: "m",
    });
  } finally {
    cleanup();
  }
});

// ── Session-start apply rule ─────────────────────────────────────────

const persisted = { provider: "p", id: "saved", thinking: "high" as const };

function decide(over: Record<string, unknown> = {}) {
  return shouldApplyModelDefaultAtSessionStart({
    reason: "startup",
    subagentRoleEnv: undefined,
    live: { provider: "p", id: "first" },
    scopedFirst: { provider: "p", id: "first" },
    settingsDefault: { provider: "p", id: "first" },
    persisted,
    ...over,
  } as any);
}

test("apply: a new session on Pi's own pick adopts the saved default", () => {
  assert.deepEqual(decide(), { apply: true, reason: "apply" });
});

test("apply: reason 'new' behaves like 'startup'", () => {
  assert.equal(decide({ reason: "new" }).apply, true);
});

test("apply: resume and reload never apply", () => {
  for (const reason of ["resume", "reload", undefined, "other"]) {
    assert.deepEqual(decide({ reason }), {
      apply: false,
      reason: "reason-not-new",
    });
  }
});

test("apply: workflow subagents (PI_WORKFLOW_ROLE) never apply", () => {
  assert.deepEqual(decide({ subagentRoleEnv: "explorer" }), {
    apply: false,
    reason: "subagent",
  });
  // A blank value is not a role.
  assert.equal(decide({ subagentRoleEnv: "   " }).apply, true);
});

test("apply: no persisted default is a no-op", () => {
  assert.deepEqual(decide({ persisted: undefined }), {
    apply: false,
    reason: "no-persisted",
  });
});

test("apply: already on the saved default is a no-op", () => {
  assert.deepEqual(
    decide({
      live: { provider: "p", id: "saved" },
      scopedFirst: { provider: "p", id: "other" },
      settingsDefault: { provider: "p", id: "other" },
    }),
    { apply: false, reason: "live-is-persisted" },
  );
});

test("apply: live matching Pi's saved default is adoptable", () => {
  // Pi restored its own default; scoped-first differs. We may refine it.
  assert.equal(
    decide({
      live: { provider: "p", id: "first" },
      scopedFirst: { provider: "p", id: "scoped" },
      settingsDefault: { provider: "p", id: "first" },
    }).apply,
    true,
  );
});

test("apply: an explicit live model wins over the saved default", () => {
  // `--model`, a project default, or another extension: differs from all three.
  assert.deepEqual(
    decide({
      live: { provider: "explicit", id: "chosen" },
      scopedFirst: { provider: "p", id: "first" },
      settingsDefault: { provider: "p", id: "first" },
    }),
    { apply: false, reason: "live-is-explicit" },
  );
});

test("apply: an unknown live model adopts the saved default", () => {
  assert.equal(decide({ live: undefined }).apply, true);
});

test("apply: thinking differences never make the live model 'explicit'", () => {
  // sameModelRef only compares thinking when both sides define it; the live
  // model carries no thinking here, so the record still matches.
  assert.equal(
    decide({
      live: { provider: "p", id: "saved" },
      scopedFirst: { provider: "x", id: "x" },
      settingsDefault: { provider: "x", id: "x" },
    }).reason,
    "live-is-persisted",
  );
});

test("describe: every reason has a phrase", () => {
  for (const reason of [
    "apply",
    "reason-not-new",
    "subagent",
    "no-persisted",
    "live-is-persisted",
    "live-is-explicit",
  ] as const) {
    const text = describeModelDefaultApply({ apply: reason === "apply", reason });
    assert.equal(typeof text, "string");
    assert.ok(text.length > 0, reason);
  }
});

// ── Event gating (the wired behaviour) ───────────────────────────────

test("gate: a user model selection persists (set and cycle)", () => {
  for (const source of ["set", "cycle"]) {
    assert.equal(
      shouldPersistModelSelect({ source, suppressed: false }),
      true,
      source,
    );
  }
});

test("gate: Pi's `restore` and unknown sources never persist", () => {
  for (const source of ["restore", undefined, ""]) {
    assert.equal(
      shouldPersistModelSelect({ source, suppressed: false }),
      false,
      String(source),
    );
  }
});

test("gate: an extension-initiated switch never persists", () => {
  // Regression lock for "entering Plan/Build must not change the default".
  for (const source of ["set", "cycle", "restore"]) {
    assert.equal(
      shouldPersistModelSelect({ source, suppressed: true }),
      false,
      source,
    );
  }
});

test("gate: thinking persists only for the saved default's model", () => {
  const saved = { provider: "p", id: "saved", thinking: "high" as const };
  assert.equal(
    shouldPersistThinkingSelect({
      suppressed: false,
      current: { provider: "p", id: "saved" },
      defaultModel: saved,
    }),
    true,
  );
  // A role model's level must not overwrite the default.
  assert.equal(
    shouldPersistThinkingSelect({
      suppressed: false,
      current: { provider: "p", id: "planner-model" },
      defaultModel: saved,
    }),
    false,
  );
});

test("gate: thinking adopts the current model when no default exists", () => {
  assert.equal(
    shouldPersistThinkingSelect({
      suppressed: false,
      current: { provider: "p", id: "m" },
      defaultModel: undefined,
    }),
    true,
  );
});

test("gate: thinking is refused while suppressed or without a model", () => {
  assert.equal(
    shouldPersistThinkingSelect({
      suppressed: true,
      current: { provider: "p", id: "m" },
      defaultModel: undefined,
    }),
    false,
  );
  assert.equal(
    shouldPersistThinkingSelect({
      suppressed: false,
      current: undefined,
      defaultModel: undefined,
    }),
    false,
  );
  assert.equal(
    shouldPersistThinkingSelect({
      suppressed: false,
      current: { provider: "", id: "m" },
      defaultModel: undefined,
    }),
    false,
  );
});

test("wired: a user pick writes both the extension key and Pi's mirror", () => {
  const { cwd, agentDir, cleanup } = tmpCwd();
  try {
    // The handler's exact path: gate the event, then persist what it carried.
    const event = {
      source: "set",
      model: { provider: "opencode-go", id: "deepseek-v4.1-flash" },
    };
    assert.equal(
      shouldPersistModelSelect({ source: event.source, suppressed: false }),
      true,
    );
    const thinking = "xhigh";
    const written = writeModelDefault("global", cwd, agentDir, {
      provider: event.model.provider,
      id: event.model.id,
      thinking: thinking as any,
    });
    assert.equal(written.ok, true);

    const root = readJson(written.path);
    assert.deepEqual(root[WORKFLOW_SETTINGS_KEY].modelDefault, {
      provider: "opencode-go",
      id: "deepseek-v4.1-flash",
      thinking: "xhigh",
    });
    assert.equal(root.defaultModel, "deepseek-v4.1-flash");

    // And the next session reads exactly that back.
    const res = readModelDefault(cwd, agentDir);
    assert.deepEqual(res.value, {
      provider: "opencode-go",
      id: "deepseek-v4.1-flash",
      thinking: "xhigh",
    });
  } finally {
    cleanup();
  }
});

test("wired: an internal switch writes nothing", () => {
  const { cwd, agentDir, cleanup } = tmpCwd();
  try {
    const source = "set";
    const suppressed = true; // e.g. entering Plan mode
    if (shouldPersistModelSelect({ source, suppressed })) {
      writeModelDefault("global", cwd, agentDir, {
        provider: "p",
        id: "planner",
      });
    }
    assert.equal(readModelDefault(cwd, agentDir).value, undefined);
  } finally {
    cleanup();
  }
});
