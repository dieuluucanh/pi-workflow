/**
 * Workflow Extension — scoped prompt-refinement model config tests.
 *
 * Run with: npm test   (node --test, type-stripping — no build step)
 *
 * Covers the `workflow.promptRefinement.model` setting contract:
 *   - validated overrides / explicit inherit sentinels / malformed values;
 *   - project (trusted) → global → Default-mode precedence and shadowing;
 *   - provider/model IDs with additional `/` characters;
 *   - nonreasoning-model thinking clamping;
 *   - strict, non-destructive writes (malformed JSON is refused, unrelated
 *     keys and Pi's default-model mirror are never touched);
 *   - serialized atomic writes with concurrent unrelated edits;
 *   - scope reset/inherit semantics and `/prompt-model` completions.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { WORKFLOW_SETTINGS_KEY } from "./commit-policy.ts";
import {
  PROMPT_REFINEMENT_KEY,
  PROMPT_REFINEMENT_MODEL_KEY,
  coerceRefinementModelSetting,
  formatRefinementModelStatus,
  formatRefinementOverride,
  promptModelArgumentCompletions,
  readRefinementModelConfig,
  refinementModelConfigPaths,
  updateSettingsFileAtomic,
  validateRefinementModelChoice,
  writeRefinementModelSetting,
  type RefinementModelSetting,
} from "./prompt-refinement-config.ts";

function tmpCwd() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-prompt-model-"));
  const cwd = path.join(root, "project");
  const agentDir = path.join(root, "agent");
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(agentDir, { recursive: true });
  return {
    root,
    cwd,
    agentDir,
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

function writeRaw(fp: string, value: unknown): void {
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, JSON.stringify(value, null, 2) + "\n", "utf8");
}

function readRaw(fp: string): any {
  return JSON.parse(fs.readFileSync(fp, "utf8"));
}

const override = (
  provider: string,
  id: string,
  thinking?: string,
): RefinementModelSetting => ({
  kind: "override",
  model: thinking ? { provider, id, thinking: thinking as never } : { provider, id },
});

// ── Coercion / validation ────────────────────────────────────────────

test("coerce: absent values", () => {
  assert.deepEqual(coerceRefinementModelSetting(undefined), { kind: "absent" });
  assert.deepEqual(coerceRefinementModelSetting(null), { kind: "absent" });
});

test("coerce: explicit inherit sentinels (string and object)", () => {
  assert.deepEqual(coerceRefinementModelSetting("inherit"), {
    kind: "valid",
    setting: { kind: "inherit" },
  });
  assert.deepEqual(coerceRefinementModelSetting({ inherit: true }), {
    kind: "valid",
    setting: { kind: "inherit" },
  });
});

test("coerce: provider/model override preserves additional slashes in the id", () => {
  const res = coerceRefinementModelSetting({
    provider: "openrouter",
    id: "anthropic/claude-sonnet-4",
    thinking: "HIGH",
  });
  assert.equal(res.kind, "valid");
  if (res.kind !== "valid") return;
  assert.deepEqual(res.setting, {
    kind: "override",
    model: {
      provider: "openrouter",
      id: "anthropic/claude-sonnet-4",
      thinking: "high",
    },
  });
});

test("coerce: invalid provider/model/thinking are reported, never silently dropped", () => {
  const missingProvider = coerceRefinementModelSetting({ id: "x" });
  assert.equal(missingProvider.kind, "invalid");
  const blankId = coerceRefinementModelSetting({ provider: "p", id: "  " });
  assert.equal(blankId.kind, "invalid");
  const badThinking = coerceRefinementModelSetting({
    provider: "p",
    id: "x",
    thinking: "turbo",
  });
  assert.equal(badThinking.kind, "invalid");
  if (badThinking.kind === "invalid") {
    assert.match(badThinking.error, /thinking/i);
  }
  const falseInherit = coerceRefinementModelSetting({ inherit: false });
  assert.equal(falseInherit.kind, "invalid");
  const wrongType = coerceRefinementModelSetting(42);
  assert.equal(wrongType.kind, "invalid");
});

test("validate: provider/model, thinking and registry capability", () => {
  const basic = validateRefinementModelChoice({ ref: "opencode/muse" });
  assert.equal(basic.ok, true);
  if (!basic.ok) return;
  assert.deepEqual(basic.model, { provider: "opencode", id: "muse" });
  assert.match(basic.warnings.join("\n"), /registry unavailable/i);

  const multiSlash = validateRefinementModelChoice({
    ref: "openrouter/anthropic/claude-sonnet-4",
    thinking: "Medium",
  });
  assert.equal(multiSlash.ok, true);
  if (!multiSlash.ok) return;
  assert.deepEqual(multiSlash.model, {
    provider: "openrouter",
    id: "anthropic/claude-sonnet-4",
    thinking: "medium",
  });

  const noSlash = validateRefinementModelChoice({ ref: "muse" });
  assert.equal(noSlash.ok, false);
  if (!noSlash.ok) assert.match(noSlash.error, /provider\/model/);

  const badThinking = validateRefinementModelChoice({
    ref: "p/x",
    thinking: "turbo",
  });
  assert.equal(badThinking.ok, false);
  if (!badThinking.ok) assert.match(badThinking.error, /Invalid thinking/);

  const missingModel = validateRefinementModelChoice({
    ref: "p/x",
    registryAvailable: true,
  });
  assert.equal(missingModel.ok, false);
});

test("validate: nonreasoning models clamp an explicit thinking level with a warning", () => {
  const res = validateRefinementModelChoice({
    ref: "p/nonreasoning",
    thinking: "high",
    model: { reasoning: false },
  });
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.model.thinking, "off");
  assert.match(res.warnings.join("\n"), /not supported/);
  assert.match(res.warnings.join("\n"), /using off/);
});

test("validate: no thinking requested stores no thinking (inherit Default-mode level)", () => {
  const res = validateRefinementModelChoice({
    ref: "p/nonreasoning",
    model: { reasoning: false },
  });
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal("thinking" in res.model, false);
});

test("validate: unavailable registry saves with a warning (offline configuration)", () => {
  const res = validateRefinementModelChoice({ ref: "p/x" });
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.match(res.warnings.join("\n"), /registry unavailable/i);
});

// ── Read precedence / shadowing ──────────────────────────────────────

test("read: default when neither scope sets a value", () => {
  const t = tmpCwd();
  try {
    const res = readRefinementModelConfig(t.cwd, t.agentDir);
    assert.equal(res.source, "default");
    assert.deepEqual(res.paths, refinementModelConfigPaths(t.cwd, t.agentDir));
    assert.match(res.notes.join("\n"), /inherits the Default-mode model/);
  } finally {
    t.cleanup();
  }
});

test("read: global override applies; trusted project override wins", () => {
  const t = tmpCwd();
  try {
    const paths = refinementModelConfigPaths(t.cwd, t.agentDir);
    writeRaw(paths.global, {
      [WORKFLOW_SETTINGS_KEY]: {
        [PROMPT_REFINEMENT_KEY]: {
          [PROMPT_REFINEMENT_MODEL_KEY]: { provider: "g", id: "global-model" },
        },
      },
    });
    let res = readRefinementModelConfig(t.cwd, t.agentDir, { trusted: true });
    assert.equal(res.source, "global");
    assert.deepEqual(res.setting, override("g", "global-model"));

    writeRaw(paths.project, {
      [WORKFLOW_SETTINGS_KEY]: {
        [PROMPT_REFINEMENT_KEY]: {
          [PROMPT_REFINEMENT_MODEL_KEY]: { provider: "p", id: "project-model" },
        },
      },
    });
    res = readRefinementModelConfig(t.cwd, t.agentDir, { trusted: true });
    assert.equal(res.source, "project");
    assert.deepEqual(res.setting, override("p", "project-model"));
    assert.match(res.notes.join("\n"), /shadow/i);
  } finally {
    t.cleanup();
  }
});

test("read: an untrusted project setting is ignored (global still applies)", () => {
  const t = tmpCwd();
  try {
    const paths = refinementModelConfigPaths(t.cwd, t.agentDir);
    writeRaw(paths.global, {
      [WORKFLOW_SETTINGS_KEY]: {
        [PROMPT_REFINEMENT_KEY]: {
          [PROMPT_REFINEMENT_MODEL_KEY]: { provider: "g", id: "global-model" },
        },
      },
    });
    writeRaw(paths.project, {
      [WORKFLOW_SETTINGS_KEY]: {
        [PROMPT_REFINEMENT_KEY]: {
          [PROMPT_REFINEMENT_MODEL_KEY]: { provider: "p", id: "project-model" },
        },
      },
    });
    const res = readRefinementModelConfig(t.cwd, t.agentDir, { trusted: false });
    assert.equal(res.source, "global");
    assert.equal(res.scopes.projectIgnored, true);
    assert.match(res.notes.join("\n"), /not trusted/);
  } finally {
    t.cleanup();
  }
});

test("read: a trusted project inherit sentinel suppresses the global override", () => {
  const t = tmpCwd();
  try {
    const paths = refinementModelConfigPaths(t.cwd, t.agentDir);
    writeRaw(paths.global, {
      [WORKFLOW_SETTINGS_KEY]: {
        [PROMPT_REFINEMENT_KEY]: {
          [PROMPT_REFINEMENT_MODEL_KEY]: { provider: "g", id: "global-model" },
        },
      },
    });
    writeRaw(paths.project, {
      [WORKFLOW_SETTINGS_KEY]: {
        [PROMPT_REFINEMENT_KEY]: { [PROMPT_REFINEMENT_MODEL_KEY]: "inherit" },
      },
    });
    const res = readRefinementModelConfig(t.cwd, t.agentDir, { trusted: true });
    assert.equal(res.source, "project");
    assert.deepEqual(res.setting, { kind: "inherit" });
    assert.match(res.notes.join("\n"), /suppresses the global/i);
  } finally {
    t.cleanup();
  }
});

test("read: invalid explicit settings are reported, not silently downgraded", () => {
  const t = tmpCwd();
  try {
    const paths = refinementModelConfigPaths(t.cwd, t.agentDir);
    writeRaw(paths.project, {
      [WORKFLOW_SETTINGS_KEY]: {
        [PROMPT_REFINEMENT_KEY]: {
          [PROMPT_REFINEMENT_MODEL_KEY]: {
            provider: "p",
            id: "x",
            thinking: "turbo",
          },
        },
      },
    });
    const trusted = readRefinementModelConfig(t.cwd, t.agentDir, {
      trusted: true,
    });
    assert.equal(trusted.source, "invalid");
    assert.match(trusted.error ?? "", /thinking/i);

    const untrusted = readRefinementModelConfig(t.cwd, t.agentDir, {
      trusted: false,
    });
    assert.equal(untrusted.source, "default");
  } finally {
    t.cleanup();
  }
});

test("read: malformed JSON is an actionable invalid scope (never a silent default)", () => {
  const t = tmpCwd();
  try {
    const paths = refinementModelConfigPaths(t.cwd, t.agentDir);
    fs.mkdirSync(path.dirname(paths.project), { recursive: true });
    fs.writeFileSync(paths.global, '{ "workflow": ', "utf8");
    const res = readRefinementModelConfig(t.cwd, t.agentDir);
    assert.equal(res.source, "invalid");
    assert.match(res.error ?? "", /not valid JSON/i);

    // An untrusted project's malformed file cannot affect the effective value.
    fs.writeFileSync(paths.project, "{", "utf8");
    const untrusted = readRefinementModelConfig(t.cwd, t.agentDir, {
      trusted: false,
    });
    assert.equal(untrusted.source, "invalid"); // global is still malformed
    assert.equal(untrusted.scopes.projectIgnored, true);
  } finally {
    t.cleanup();
  }
});

test("read: resetting the project reveals the global override", async () => {
  const t = tmpCwd();
  try {
    const paths = refinementModelConfigPaths(t.cwd, t.agentDir);
    await writeRefinementModelSetting(
      "global",
      t.cwd,
      t.agentDir,
      override("g", "global-model"),
    );
    await writeRefinementModelSetting(
      "project",
      t.cwd,
      t.agentDir,
      override("p", "project-model"),
    );
    assert.equal(
      readRefinementModelConfig(t.cwd, t.agentDir, { trusted: true }).source,
      "project",
    );
    const reset = await writeRefinementModelSetting(
      "project",
      t.cwd,
      t.agentDir,
      null,
    );
    assert.equal(reset.ok, true);
    assert.equal(reset.changed, true);
    const res = readRefinementModelConfig(t.cwd, t.agentDir, { trusted: true });
    assert.equal(res.source, "global");
    assert.equal(res.scopes.project.kind, "absent");
    assert.equal(fs.existsSync(paths.project), true);
    assert.equal(
      readRaw(paths.project)[WORKFLOW_SETTINGS_KEY] === undefined,
      true,
      "an emptied workflow object is removed, leaving the file readable",
    );

    await writeRefinementModelSetting("global", t.cwd, t.agentDir, null);
    assert.equal(
      readRefinementModelConfig(t.cwd, t.agentDir, { trusted: true }).source,
      "default",
    );
  } finally {
    t.cleanup();
  }
});

// ── Writes: non-destructive + serialized atomic ─────────────────────

test("write: preserves unrelated settings and never touches the main-model/role/profile keys", async () => {
  const t = tmpCwd();
  try {
    const paths = refinementModelConfigPaths(t.cwd, t.agentDir);
    const original = {
      defaultProvider: "pi",
      defaultModel: "pi-default",
      defaultThinkingLevel: "high",
      unrelatedTop: { keep: [1, 2, 3] },
      profiles: { active: "work" },
      roles: { planner: { provider: "r", id: "planner" } },
      [WORKFLOW_SETTINGS_KEY]: {
        modelDefault: { provider: "persisted", id: "default" },
        reviewMode: { enabled: true },
        [PROMPT_REFINEMENT_KEY]: { unrelated: "keep-me" },
      },
    };
    writeRaw(paths.global, original);

    const res = await writeRefinementModelSetting(
      "global",
      t.cwd,
      t.agentDir,
      override("p", "refiner", "medium"),
    );
    assert.deepEqual(res, {
      path: paths.global,
      ok: true,
      changed: true,
    });

    const after = readRaw(paths.global);
    assert.equal(after.defaultProvider, "pi");
    assert.equal(after.defaultModel, "pi-default");
    assert.equal(after.defaultThinkingLevel, "high");
    assert.deepEqual(after.unrelatedTop, { keep: [1, 2, 3] });
    assert.deepEqual(after.profiles, { active: "work" });
    assert.deepEqual(after.roles, { planner: { provider: "r", id: "planner" } });
    assert.deepEqual(after[WORKFLOW_SETTINGS_KEY].modelDefault, {
      provider: "persisted",
      id: "default",
    });
    assert.deepEqual(after[WORKFLOW_SETTINGS_KEY].reviewMode, { enabled: true });
    assert.equal(
      after[WORKFLOW_SETTINGS_KEY][PROMPT_REFINEMENT_KEY].unrelated,
      "keep-me",
    );
    assert.deepEqual(
      after[WORKFLOW_SETTINGS_KEY][PROMPT_REFINEMENT_KEY][
        PROMPT_REFINEMENT_MODEL_KEY
      ],
      { provider: "p", id: "refiner", thinking: "medium" },
    );

    // Reset removes only the model key, keeping its sibling setting.
    await writeRefinementModelSetting("global", t.cwd, t.agentDir, null);
    const reset = readRaw(paths.global);
    assert.equal(
      reset[WORKFLOW_SETTINGS_KEY][PROMPT_REFINEMENT_KEY].unrelated,
      "keep-me",
    );
    assert.equal(
      PROMPT_REFINEMENT_MODEL_KEY in
        reset[WORKFLOW_SETTINGS_KEY][PROMPT_REFINEMENT_KEY],
      false,
    );
    assert.deepEqual(reset[WORKFLOW_SETTINGS_KEY].modelDefault, {
      provider: "persisted",
      id: "default",
    });
    assert.equal(reset.defaultProvider, "pi");
  } finally {
    t.cleanup();
  }
});

test("write: inherit round-trips as an explicit sentinel", async () => {
  const t = tmpCwd();
  try {
    const paths = refinementModelConfigPaths(t.cwd, t.agentDir);
    await writeRefinementModelSetting("project", t.cwd, t.agentDir, {
      kind: "inherit",
    });
    assert.deepEqual(
      readRaw(paths.project)[WORKFLOW_SETTINGS_KEY][PROMPT_REFINEMENT_KEY][
        PROMPT_REFINEMENT_MODEL_KEY
      ],
      { inherit: true },
    );
    const res = readRefinementModelConfig(t.cwd, t.agentDir, { trusted: true });
    assert.equal(res.source, "project");
    assert.deepEqual(res.setting, { kind: "inherit" });
  } finally {
    t.cleanup();
  }
});

test("write: malformed JSON is refused without touching the file", async () => {
  const t = tmpCwd();
  try {
    const paths = refinementModelConfigPaths(t.cwd, t.agentDir);
    const malformed = '{ "workflow": { "reviewMode": ';
    fs.writeFileSync(paths.global, malformed, "utf8");
    const res = await writeRefinementModelSetting(
      "global",
      t.cwd,
      t.agentDir,
      override("p", "x"),
    );
    assert.equal(res.ok, false);
    assert.match(res.error ?? "", /malformed settings/i);
    assert.equal(fs.readFileSync(paths.global, "utf8"), malformed);
  } finally {
    t.cleanup();
  }
});

test("write: refuses to overwrite a non-object workflow/promptRefinement value", async () => {
  const t = tmpCwd();
  try {
    const paths = refinementModelConfigPaths(t.cwd, t.agentDir);
    writeRaw(paths.global, { [WORKFLOW_SETTINGS_KEY]: ["not", "an", "object"] });
    let res = await writeRefinementModelSetting(
      "global",
      t.cwd,
      t.agentDir,
      override("p", "x"),
    );
    assert.equal(res.ok, false);
    assert.deepEqual(readRaw(paths.global)[WORKFLOW_SETTINGS_KEY], [
      "not",
      "an",
      "object",
    ]);

    writeRaw(paths.global, {
      [WORKFLOW_SETTINGS_KEY]: { [PROMPT_REFINEMENT_KEY]: "bad" },
    });
    res = await writeRefinementModelSetting(
      "global",
      t.cwd,
      t.agentDir,
      override("p", "x"),
    );
    assert.equal(res.ok, false);
    assert.equal(
      readRaw(paths.global)[WORKFLOW_SETTINGS_KEY][PROMPT_REFINEMENT_KEY],
      "bad",
    );
  } finally {
    t.cleanup();
  }
});

test("write: no-op writes report changed=false and leave the file untouched", async () => {
  const t = tmpCwd();
  try {
    const paths = refinementModelConfigPaths(t.cwd, t.agentDir);
    const first = await writeRefinementModelSetting(
      "global",
      t.cwd,
      t.agentDir,
      override("p", "x"),
    );
    assert.equal(first.changed, true);
    const before = fs.readFileSync(paths.global, "utf8");
    const second = await writeRefinementModelSetting(
      "global",
      t.cwd,
      t.agentDir,
      override("p", "x"),
    );
    assert.equal(second.ok, true);
    assert.equal(second.changed, false);
    assert.equal(fs.readFileSync(paths.global, "utf8"), before);
  } finally {
    t.cleanup();
  }
});

test("write: concurrent unrelated edits are serialized and both preserved", async () => {
  const t = tmpCwd();
  try {
    const paths = refinementModelConfigPaths(t.cwd, t.agentDir);
    const [refinementWrite, unrelatedWrite] = await Promise.all([
      writeRefinementModelSetting(
        "global",
        t.cwd,
        t.agentDir,
        override("p", "x"),
      ),
      updateSettingsFileAtomic(paths.global, (root) => {
        root.unrelatedFeature = { enabled: true };
        return { ok: true };
      }),
    ]);
    assert.equal(refinementWrite.ok, true);
    assert.equal(unrelatedWrite.ok, true);
    const after = readRaw(paths.global);
    assert.deepEqual(after.unrelatedFeature, { enabled: true });
    assert.deepEqual(
      after[WORKFLOW_SETTINGS_KEY][PROMPT_REFINEMENT_KEY][
        PROMPT_REFINEMENT_MODEL_KEY
      ],
      { provider: "p", id: "x" },
    );
    // Atomic temp files are cleaned up.
    assert.deepEqual(
      fs
        .readdirSync(path.dirname(paths.global))
        .filter((name) => name.includes(".tmp")),
      [],
    );
  } finally {
    t.cleanup();
  }
});

test("write: global and project writes can run concurrently without clobbering", async () => {
  const t = tmpCwd();
  try {
    const paths = refinementModelConfigPaths(t.cwd, t.agentDir);
    await Promise.all([
      writeRefinementModelSetting(
        "global",
        t.cwd,
        t.agentDir,
        override("g", "global"),
      ),
      writeRefinementModelSetting(
        "project",
        t.cwd,
        t.agentDir,
        override("p", "project"),
      ),
    ]);
    const res = readRefinementModelConfig(t.cwd, t.agentDir, { trusted: true });
    assert.equal(res.source, "project");
    assert.equal(res.scopes.global.kind, "override");
    assert.deepEqual(
      readRaw(paths.global)[WORKFLOW_SETTINGS_KEY][PROMPT_REFINEMENT_KEY][
        PROMPT_REFINEMENT_MODEL_KEY
      ],
      { provider: "g", id: "global" },
    );
    assert.deepEqual(
      readRaw(paths.project)[WORKFLOW_SETTINGS_KEY][PROMPT_REFINEMENT_KEY][
        PROMPT_REFINEMENT_MODEL_KEY
      ],
      { provider: "p", id: "project" },
    );
  } finally {
    t.cleanup();
  }
});

// ── Display + completions ───────────────────────────────────────────

test("status: includes effective value, source, both scopes and shadowing", () => {
  const t = tmpCwd();
  try {
    const paths = refinementModelConfigPaths(t.cwd, t.agentDir);
    writeRaw(paths.global, {
      [WORKFLOW_SETTINGS_KEY]: {
        [PROMPT_REFINEMENT_KEY]: {
          [PROMPT_REFINEMENT_MODEL_KEY]: { provider: "g", id: "global" },
        },
      },
    });
    writeRaw(paths.project, {
      [WORKFLOW_SETTINGS_KEY]: {
        [PROMPT_REFINEMENT_KEY]: {
          [PROMPT_REFINEMENT_MODEL_KEY]: { provider: "p", id: "project" },
        },
      },
    });
    const text = formatRefinementModelStatus(
      readRefinementModelConfig(t.cwd, t.agentDir, { trusted: true }),
    );
    assert.match(text, /Refinement model: p\/project/);
    assert.match(text, /trusted project setting/);
    assert.match(text, /global: g\/global/);
    assert.match(text, /project: p\/project/);
    assert.match(text, /shadow/i);
    assert.match(text, /\/prompt-model/);

    const inheritText = formatRefinementModelStatus({
      ...readRefinementModelConfig(t.cwd, t.agentDir, { trusted: true }),
      source: "project",
      setting: { kind: "inherit" },
    });
    assert.match(inheritText, /Default-mode model \(explicit inherit\)/);
  } finally {
    t.cleanup();
  }
});

test("formatRefinementOverride: thinking is shown only when configured", () => {
  assert.equal(formatRefinementOverride({ provider: "p", id: "x" }), "p/x");
  assert.equal(
    formatRefinementOverride({ provider: "p", id: "x", thinking: "high" }),
    "p/x (high)",
  );
});

test("completions: subcommands, scopes and thinking", () => {
  const top = promptModelArgumentCompletions("") ?? [];
  assert.deepEqual(
    top.map((item) => item.label),
    ["status", "set", "inherit", "reset"],
  );
  assert.equal(promptModelArgumentCompletions("se")?.[0]?.label, "set");
  assert.equal(promptModelArgumentCompletions("status ") , null);

  const inheritScopes = promptModelArgumentCompletions("inherit ") ?? [];
  assert.deepEqual(
    inheritScopes.map((item) => item.label),
    ["global", "project"],
  );
  assert.equal(promptModelArgumentCompletions("inherit project"), null);

  const models = promptModelArgumentCompletions("set ", {
    modelRefs: ["opencode/muse", "openrouter/anthropic/claude"],
  });
  assert.deepEqual(
    models?.map((item) => item.label),
    ["opencode/muse", "openrouter/anthropic/claude"],
  );
  assert.equal(models?.[0]?.value, "set opencode/muse");

  const afterModel = promptModelArgumentCompletions("set opencode/muse ") ?? [];
  assert.ok(afterModel.some((item) => item.label === "high"));
  assert.ok(afterModel.some((item) => item.label === "global"));
  assert.ok(afterModel.some((item) => item.label === "project"));

  const afterThinking = promptModelArgumentCompletions(
    "set opencode/muse high ",
  ) ?? [];
  assert.deepEqual(
    afterThinking.map((item) => item.label),
    ["global", "project"],
  );
  assert.equal(
    afterThinking[0]?.value,
    "set opencode/muse high global",
  );

  const partialScope = promptModelArgumentCompletions("set opencode/muse high p");
  assert.deepEqual(partialScope?.map((item) => item.label), ["project"]);
  assert.equal(promptModelArgumentCompletions("set opencode/muse high global"), null);
});
