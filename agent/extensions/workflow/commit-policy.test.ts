/**
 * Workflow Extension — Commit Policy tests
 *
 * Run with: npm test   (node --test, type-stripping — no build step)
 *
 * These cover the pure config surface: coercion of untrusted fragments
 * (objects, bare-string shorthand, garbage, wrong types), merge precedence
 * (defaults < global < project, field-by-field), scope-source attribution,
 * disk round-trips via temp dirs, and the "preserve every other key"
 * read-modify-write guarantee of writeCommitPolicyConfig.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  COMMIT_POLICY_KEY,
  DEFAULT_COMMIT_POLICY_CONFIG,
  WORKFLOW_SETTINGS_KEY,
  coerceCommitPolicyConfig,
  commitConfigPaths,
  describeCommitPolicyMode,
  extractCommitPolicyRaw,
  mergeCommitPolicyConfig,
  modeSourceOf,
  readCommitPolicyConfig,
  stepCommitDecision,
  stepCommitMessage,
  writeCommitPolicyConfig,
  type StepCommitCandidate,
} from "./commit-policy.ts";

// ── coerceCommitPolicyConfig ─────────────────────────────────────────

test("coerce: defaults when raw is undefined/null", () => {
  assert.deepEqual(coerceCommitPolicyConfig(undefined), { mode: "never" });
  assert.deepEqual(coerceCommitPolicyConfig(null), { mode: "never" });
});

test("coerce: valid object fragment", () => {
  assert.deepEqual(coerceCommitPolicyConfig({ mode: "ask" }), { mode: "ask" });
  assert.deepEqual(coerceCommitPolicyConfig({ mode: "allow" }), {
    mode: "allow",
  });
  assert.deepEqual(coerceCommitPolicyConfig({ mode: "never" }), {
    mode: "never",
  });
});

test("coerce: bare mode string shorthand", () => {
  assert.deepEqual(coerceCommitPolicyConfig("allow"), { mode: "allow" });
  assert.deepEqual(coerceCommitPolicyConfig("never"), { mode: "never" });
});

test("coerce: mode string is trimmed and case-insensitive", () => {
  assert.deepEqual(coerceCommitPolicyConfig("  ASK  "), { mode: "ask" });
  assert.deepEqual(coerceCommitPolicyConfig({ mode: " Allow " }), {
    mode: "allow",
  });
});

test("coerce: garbage falls back to base", () => {
  const base = { mode: "ask" as const };
  assert.deepEqual(coerceCommitPolicyConfig(true, base), base);
  assert.deepEqual(coerceCommitPolicyConfig(false, base), base);
  assert.deepEqual(coerceCommitPolicyConfig(42, base), base);
  assert.deepEqual(coerceCommitPolicyConfig("bogus", base), base);
  assert.deepEqual(coerceCommitPolicyConfig(["ask"], base), base);
  assert.deepEqual(coerceCommitPolicyConfig(null, base), base);
  assert.deepEqual(coerceCommitPolicyConfig({ mode: 7 }, base), base);
  assert.deepEqual(coerceCommitPolicyConfig({ mode: "maybe" }, base), base);
  assert.deepEqual(coerceCommitPolicyConfig({ nope: true }, base), base);
  // No boolean shorthand exists: true/false never mean "allow"/"never".
  assert.deepEqual(coerceCommitPolicyConfig(true), DEFAULT_COMMIT_POLICY_CONFIG);
});

test("coerce: unknown fields are dropped", () => {
  assert.deepEqual(coerceCommitPolicyConfig({ mode: "allow", evil: true }), {
    mode: "allow",
  });
});

// ── extractCommitPolicyRaw ───────────────────────────────────────────

test("extract: pulls workflow.commitPolicy from a settings object", () => {
  assert.deepEqual(
    extractCommitPolicyRaw({
      other: 1,
      [WORKFLOW_SETTINGS_KEY]: {
        [COMMIT_POLICY_KEY]: { mode: "ask" },
      },
    }),
    { mode: "ask" },
  );
  assert.equal(
    extractCommitPolicyRaw({
      [WORKFLOW_SETTINGS_KEY]: { [COMMIT_POLICY_KEY]: "allow" },
    }),
    "allow",
  );
});

test("extract: undefined for absent/malformed shapes", () => {
  assert.equal(extractCommitPolicyRaw(undefined), undefined);
  assert.equal(extractCommitPolicyRaw(null), undefined);
  assert.equal(extractCommitPolicyRaw("nope"), undefined);
  assert.equal(extractCommitPolicyRaw([]), undefined);
  assert.equal(extractCommitPolicyRaw({}), undefined);
  assert.equal(
    extractCommitPolicyRaw({ [WORKFLOW_SETTINGS_KEY]: "not-an-object" }),
    undefined,
  );
  assert.equal(
    extractCommitPolicyRaw({ [WORKFLOW_SETTINGS_KEY]: { [COMMIT_POLICY_KEY]: 3 } }),
    undefined,
  );
});

// ── merge precedence ─────────────────────────────────────────────────

test("merge: project wins over global, global wins over default", () => {
  assert.equal(mergeCommitPolicyConfig(undefined, undefined).mode, "never");
  assert.equal(mergeCommitPolicyConfig("ask", undefined).mode, "ask");
  assert.equal(mergeCommitPolicyConfig(undefined, "ask").mode, "ask");
  assert.equal(mergeCommitPolicyConfig("ask", "allow").mode, "allow");
  assert.equal(mergeCommitPolicyConfig("allow", "never").mode, "never");
});

test("merge: invalid project fragment falls back to global", () => {
  assert.equal(mergeCommitPolicyConfig("ask", "garbage").mode, "ask");
  assert.equal(mergeCommitPolicyConfig("ask", true).mode, "ask");
  assert.equal(mergeCommitPolicyConfig("ask", { mode: 9 }).mode, "ask");
});

// ── modeSourceOf ─────────────────────────────────────────────────────

test("modeSourceOf: project > global > default, keyed on a VALID mode", () => {
  assert.equal(modeSourceOf(undefined, undefined), "default");
  assert.equal(modeSourceOf("ask", undefined), "global");
  assert.equal(modeSourceOf(undefined, { mode: "ask" }), "project");
  assert.equal(modeSourceOf("ask", "allow"), "project");
  // An invalid mode must not count as "supplied".
  assert.equal(modeSourceOf("bogus", undefined), "default");
  assert.equal(modeSourceOf(undefined, { mode: "bogus" }), "default");
});

// ── disk round-trips (temp dirs) ─────────────────────────────────────

function tmpCwd(): { cwd: string; agentDir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-commit-policy-"));
  return {
    cwd: dir,
    agentDir: path.join(dir, "agent"),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

test("read: defaults when no settings files exist", () => {
  const { cwd, agentDir, cleanup } = tmpCwd();
  try {
    const res = readCommitPolicyConfig(cwd, agentDir);
    assert.deepEqual(res.config, DEFAULT_COMMIT_POLICY_CONFIG);
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
    const res = readCommitPolicyConfig(cwd, agentDir);
    assert.deepEqual(res.config, DEFAULT_COMMIT_POLICY_CONFIG);
  } finally {
    cleanup();
  }
});

test("read+write: global scope then project override", () => {
  const { cwd, agentDir, cleanup } = tmpCwd();
  try {
    // Global write.
    const g = writeCommitPolicyConfig("global", cwd, agentDir, {
      mode: "ask",
    });
    assert.equal(g.ok, true);
    assert.equal(g.path, path.join(agentDir, "settings.json"));
    let res = readCommitPolicyConfig(cwd, agentDir);
    assert.equal(res.config.mode, "ask");
    assert.equal(res.sources.mode, "global");

    // Project override wins.
    const p = writeCommitPolicyConfig("project", cwd, agentDir, {
      mode: "never",
    });
    assert.equal(p.ok, true);
    assert.equal(
      p.path,
      path.join(cwd, ".pi", "settings.json"),
    );
    res = readCommitPolicyConfig(cwd, agentDir);
    assert.equal(res.config.mode, "never");
    assert.equal(res.sources.mode, "project");
    assert.equal(res.sources.global, true);
    assert.equal(res.sources.project, true);
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
        {
          retry: { maxRetries: 5 },
          [WORKFLOW_SETTINGS_KEY]: {
            reviewMode: { enabled: true, rounds: 2 },
            unrelated: "keep-me",
          },
          top: [1, 2, 3],
        },
        null,
        2,
      ),
      "utf8",
    );

    const res = writeCommitPolicyConfig("global", cwd, agentDir, {
      mode: "allow",
    });
    assert.equal(res.ok, true);

    const root = JSON.parse(fs.readFileSync(fp, "utf8"));
    assert.deepEqual(root.retry, { maxRetries: 5 });
    assert.deepEqual(root.top, [1, 2, 3]);
    assert.deepEqual(
      root[WORKFLOW_SETTINGS_KEY].reviewMode,
      { enabled: true, rounds: 2 },
      "reviewMode settings must survive untouched",
    );
    assert.equal(root[WORKFLOW_SETTINGS_KEY].unrelated, "keep-me");
    assert.deepEqual(root[WORKFLOW_SETTINGS_KEY][COMMIT_POLICY_KEY], {
      mode: "allow",
    });

    // And a second write merges onto the existing policy value.
    writeCommitPolicyConfig("global", cwd, agentDir, { mode: "ask" });
    const reread = readCommitPolicyConfig(cwd, agentDir);
    assert.equal(reread.config.mode, "ask");
    assert.deepEqual(
      JSON.parse(fs.readFileSync(fp, "utf8"))[WORKFLOW_SETTINGS_KEY]
        .reviewMode,
      { enabled: true, rounds: 2 },
    );
  } finally {
    cleanup();
  }
});

test("write: bad patch values are coerced, not written raw", () => {
  const { cwd, agentDir, cleanup } = tmpCwd();
  try {
    writeCommitPolicyConfig("global", cwd, agentDir, {
      mode: "hax" as never,
    });
    const res = readCommitPolicyConfig(cwd, agentDir);
    assert.deepEqual(res.config, DEFAULT_COMMIT_POLICY_CONFIG);
  } finally {
    cleanup();
  }
});

test("write: reports a structured error instead of throwing", () => {
  const { cwd, agentDir, cleanup } = tmpCwd();
  try {
    // Make the settings path itself a directory so the final writeFileSync
    // fails (EISDIR/EPERM) — writeCommitPolicyConfig must swallow it.
    fs.mkdirSync(path.join(agentDir, "settings.json"), { recursive: true });
    const res = writeCommitPolicyConfig("global", cwd, agentDir, {
      mode: "ask",
    });
    assert.equal(res.ok, false);
    assert.ok(res.error && res.error.length > 0);
  } finally {
    cleanup();
  }
});

test("paths: global is under agentDir, project is under <cwd>/.pi", () => {
  const { cwd, agentDir, cleanup } = tmpCwd();
  try {
    const p = commitConfigPaths(cwd, agentDir);
    assert.equal(p.global, path.join(agentDir, "settings.json"));
    assert.equal(p.project, path.join(cwd, ".pi", "settings.json"));
  } finally {
    cleanup();
  }
});

test("describe: every mode has a human-readable label", () => {
  assert.ok(describeCommitPolicyMode("never").includes("cannot"));
  assert.ok(describeCommitPolicyMode("ask").includes("asks"));
  assert.ok(
    describeCommitPolicyMode("allow").includes("one commit per completed"),
  );
});

// ── stepCommitDecision / stepCommitMessage (per-step guarantee) ─────

const step = (
  ref: string,
  text: string,
  stepNum?: number,
): StepCommitCandidate => ({ ref, text, step: stepNum });

const allowInput = (
  over: Partial<Parameters<typeof stepCommitDecision>[0]> = {},
) => ({
  mode: "allow" as const,
  hasTodos: true,
  dirty: true,
  isInRepo: true,
  completed: [step("1", "implement parser module", 1)],
  ...over,
});

test("stepCommitDecision: allow + todos + dirty + new completion → exactly one commit", () => {
  const d = stepCommitDecision(allowInput());
  assert.equal(d.commit, true);
  assert.deepEqual(d.refs, ["1"]);
  assert.equal(d.message, "step 1: implement parser module");
});

test("stepCommitDecision: never and ask never auto-commit", () => {
  assert.equal(stepCommitDecision(allowInput({ mode: "never" })).commit, false);
  assert.equal(stepCommitDecision(allowInput({ mode: "ask" })).commit, false);
  assert.equal(
    stepCommitDecision(allowInput({ mode: "never" })).skipReason,
    "mode",
  );
});

test("stepCommitDecision: skips without todos, repo, changes, or new completions", () => {
  assert.equal(stepCommitDecision(allowInput({ hasTodos: false })).skipReason, "no-todos");
  assert.equal(stepCommitDecision(allowInput({ isInRepo: false })).skipReason, "no-repo");
  assert.equal(stepCommitDecision(allowInput({ dirty: false })).skipReason, "clean");
  assert.equal(stepCommitDecision(allowInput({ completed: [] })).skipReason, "nothing-new");
});

test("stepCommitDecision: a batch of steps yields ONE commit covering them", () => {
  const d = stepCommitDecision(
    allowInput({
      completed: [
        step("2", "add parser tests", 2),
        step("3", "wire parser into cli", 3),
      ],
    }),
  );
  assert.equal(d.commit, true);
  assert.deepEqual(d.refs, ["2", "3"]);
  assert.match(d.message, /^steps 2,3: /);
  assert.match(d.message, /\(\+1 more\)$/);
});

test("stepCommitDecision: duplicate refs are deduped, never double-counted", () => {
  const d = stepCommitDecision(
    allowInput({
      completed: [step("1", "a", 1), step("1", "a again", 1)],
    }),
  );
  assert.deepEqual(d.refs, ["1"]);
});

test("stepCommitDecision: never throws on garbage input", () => {
  assert.equal(
    stepCommitDecision(allowInput({ completed: [null as never, {} as never] }))
      .commit,
    false,
  );
});

test("stepCommitMessage: single step formats and truncates to a git subject", () => {
  assert.equal(stepCommitMessage([step("7", "fix the login flow", 7)]), "step 7: fix the login flow");
  const long = stepCommitMessage([step("1", "x".repeat(200), 1)]);
  assert.ok(long.length <= 72, `subject too long: ${long.length}`);
  assert.ok(long.endsWith("…"));
});

test("stepCommitMessage: falls back to label then ref for numbering", () => {
  // A plan label is used verbatim (no information loss) when no global step
  // number is known.
  assert.equal(
    stepCommitMessage([{ ref: "5", label: "4.2", text: "tune retry" }]),
    "step 4.2: tune retry",
  );
  assert.equal(
    stepCommitMessage([{ ref: "9", text: "no numbers here" }]),
    "step 9: no numbers here",
  );
});
