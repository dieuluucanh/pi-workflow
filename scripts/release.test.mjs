#!/usr/bin/env node
/**
 * release.test.mjs — unit tests for scripts/release.mjs.
 *
 * Pure logic only: registry classification, the release decision rules, the
 * plan builder (with an injected probe), the changelog composer, explicit
 * staging, the fresh-dependency rule, the no-commit HEAD path, the CI bypass
 * and the phase gate. No npm, no git, no gh, no network, no filesystem writes.
 *
 *   node --test scripts/release.test.mjs     # also runs via `npm test`
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  CI_BYPASS_MESSAGE,
  RELEASE_STAGE_BASENAMES,
  ciBypassRequested,
  classifyNpmView,
  classifyTargetState,
  composeChangelog,
  decideTarget,
  dependencyFreshness,
  documentsVersion,
  gatePhase,
  normalizeEol,
  npmConsumedFlags,
  parseArgs,
  planTargets,
  resolveReleaseSha,
  stagePathsFor,
} from "./release.mjs";

const HEADER =
  "# Changelog\n\nAll notable changes to this package are documented in this file.\n";

function pkg(short, version = "0.2.0") {
  return {
    short,
    dir: `/repo/agent/extensions/${short}`,
    name: `@dieulc/${short}`,
    version,
  };
}

function probeFrom(states) {
  return (name) => states[name.replace("@dieulc/", "")] ?? "absent";
}

// ── registry classification (D7) ───────────────────────────────────────────

test("classifyNpmView: a version on stdout means published", () => {
  assert.equal(
    classifyNpmView({ status: 0, stdout: "0.2.0\n", stderr: "" }),
    "published",
  );
});

test("classifyNpmView: exit 0 with no output is unknown, never absent", () => {
  assert.equal(
    classifyNpmView({ status: 0, stdout: "  \n", stderr: "" }),
    "unknown",
  );
});

test("classifyNpmView: E404 (missing version) means absent", () => {
  assert.equal(
    classifyNpmView({
      status: 1,
      stdout: "",
      stderr:
        "npm error code E404\nnpm error 404 Not Found - GET https://registry.npmjs.org/@dieulc/autocompact",
    }),
    "absent",
  );
});

test("classifyNpmView: a fully unpublished package name means absent", () => {
  assert.equal(
    classifyNpmView({
      status: 1,
      stdout: "",
      stderr:
        "npm error code E404\nnpm error 404 Unpublished on 2026-09-16T04:16:14.175Z\nnpm error 404  The requested resource '@dieulc/autocompact' could not be found",
    }),
    "absent",
  );
});

test("classifyNpmView: transport and server failures are unknown", () => {
  for (const stderr of [
    "npm error code ETIMEDOUT",
    "npm error code ENOTFOUND registry.npmjs.org",
    "npm error code ECONNRESET",
    "npm error code E403 Forbidden",
    "npm error 500 Internal Server Error",
    "npm error code EAI_AGAIN",
  ]) {
    assert.equal(
      classifyNpmView({ status: 1, stdout: "", stderr }),
      "unknown",
      stderr,
    );
  }
});

// ── decision rules (D1–D4) ─────────────────────────────────────────────────

test("decideTarget: no bump requested + already published is a clean skip", () => {
  const decision = decideTarget({
    version: "0.2.0",
    kind: "none",
    state: "published",
  });
  assert.deepEqual(decision, {
    nextVersion: "0.2.0",
    status: "skip",
    reason: "already on npm at 0.2.0 — no bump requested",
    tagEligible: true,
  });
});

test("decideTarget: a real bump onto a published version is a skip without a tag", () => {
  const decision = decideTarget({
    version: "0.2.0",
    kind: "patch",
    state: "published",
  });
  assert.equal(decision.nextVersion, "0.2.1");
  assert.equal(decision.status, "skip");
  assert.equal(decision.tagEligible, false);
  assert.match(decision.reason, /0\.2\.1 is already on npm/);
});

test("decideTarget: an absent version is published", () => {
  assert.deepEqual(
    decideTarget({ version: "0.2.0", kind: "none", state: "absent" }),
    {
      nextVersion: "0.2.0",
      status: "publish",
      reason: "not on npm",
      tagEligible: true,
    },
  );
  assert.equal(
    decideTarget({ version: "0.2.0", kind: "minor", state: "absent" })
      .nextVersion,
    "0.3.0",
  );
});

test("decideTarget: an unknown publish state blocks, and never publishes", () => {
  const decision = decideTarget({
    version: "0.2.0",
    kind: "none",
    state: "unknown",
  });
  assert.equal(decision.status, "blocked");
  assert.equal(decision.tagEligible, false);
  assert.equal(decision.nextVersion, "0.2.0");
});

test("decideTarget: a non-semver manifest version still raises", () => {
  assert.throws(
    () => decideTarget({ version: "v0.2", kind: "patch", state: "absent" }),
    /cannot bump non-semver version/,
  );
});

test("classifyTargetState: continue mode is the none-bump path", () => {
  assert.equal(
    classifyTargetState({
      kind: "none",
      nextVersion: "0.2.0",
      state: "published",
    }).status,
    "skip",
  );
});

// ── plan builder: the incident batch ───────────────────────────────────────

test("planTargets: three published packages no longer abort the fourth", () => {
  const selected = [
    pkg("autocompact"),
    pkg("browser-inspector"),
    pkg("server-logs"),
    pkg("workflow"),
  ];
  const targets = planTargets(
    selected,
    { bump: "none", continue: false },
    (name) => (name === "@dieulc/autocompact" ? "absent" : "published"),
  );

  const publishable = targets.filter((t) => t.status === "publish");
  const skipped = targets.filter((t) => t.status === "skip");

  assert.deepEqual(
    publishable.map((t) => t.name),
    ["@dieulc/autocompact"],
  );
  assert.equal(skipped.length, 3);
  // Published-but-skipped targets stay tag-eligible (missing-tag repair) and
  // none of them is dropped from the plan.
  assert.ok(skipped.every((t) => t.tagEligible));
  assert.equal(targets.length, 4);
});

test("planTargets: the probe is asked about the *next* version", () => {
  const asked = [];
  planTargets(
    [pkg("workflow")],
    { bump: "minor", continue: false },
    (name, version) => {
      asked.push(`${name}@${version}`);
      return "absent";
    },
  );
  assert.deepEqual(asked, ["@dieulc/workflow@0.3.0"]);
});

test("planTargets: --continue uses the manifest version and skips published ones", () => {
  const targets = planTargets(
    [pkg("autocompact"), pkg("workflow")],
    { continue: true },
    probeFrom({ autocompact: "absent", workflow: "published" }),
  );
  assert.deepEqual(
    targets.map((t) => [t.nextVersion, t.status]),
    [
      ["0.2.0", "publish"],
      ["0.2.0", "skip"],
    ],
  );
});

test("planTargets: an unknown state is blocked and never tagged", () => {
  const [target] = planTargets(
    [pkg("workflow")],
    { bump: "patch" },
    probeFrom({ workflow: "unknown" }),
  );
  assert.equal(target.status, "blocked");
  assert.equal(target.skipPublish, true);
  assert.equal(target.tagEligible, false);
});

// ── changelog writer (D9) ──────────────────────────────────────────────────

const SECTION_020 = "## [0.2.0] - 2026-09-18\n\nInitial release.";
const SECTION_010 = "## [0.1.0] - 2026-09-16\n\nInitial release.";

function countHeaders(text) {
  return text.split("\n").filter((line) => line.trim() === "# Changelog")
    .length;
}

test("composeChangelog: a fresh file gets exactly one header", () => {
  const body = composeChangelog("", SECTION_020);
  assert.equal(countHeaders(body), 1);
  assert.ok(body.startsWith(HEADER));
  assert.ok(body.includes(SECTION_020));
});

test("composeChangelog: CRLF input does not duplicate the header", () => {
  const crlf = `${HEADER}\n${SECTION_010}\n`.replace(/\n/g, "\r\n");
  const body = composeChangelog(crlf, SECTION_020);
  assert.equal(countHeaders(body), 1);
  assert.ok(!body.includes("\r"), "output is normalized to LF");
  assert.ok(body.indexOf(SECTION_020) < body.indexOf(SECTION_010));
});

test("composeChangelog: BOM and stray leading newlines are tolerated", () => {
  const existing = `\uFEFF\n\n${HEADER}\n${SECTION_010}\n`;
  const body = composeChangelog(existing, SECTION_020);
  assert.equal(countHeaders(body), 1);
  assert.equal(documentsVersion(body, "0.1.0"), true);
});

test("normalizeEol: CRLF and lone CR both collapse to LF", () => {
  assert.equal(normalizeEol("a\r\nb\rc\n"), "a\nb\nc\n");
  assert.equal(normalizeEol("\uFEFFa\n"), "a\n");
});

test("documentsVersion: reads sections in CRLF files", () => {
  const crlf = `# Changelog\r\n\r\n## [0.2.0] - 2026-09-16\r\n\r\nInitial release.\r\n`;
  assert.equal(documentsVersion(crlf, "0.2.0"), true);
  assert.equal(documentsVersion(crlf, "0.3.0"), false);
});

// ── npm flag forwarding (D8) ───────────────────────────────────────────────

test("npmConsumedFlags: flags npm swallowed are reported", () => {
  const saved = { ...process.env };
  try {
    process.env.npm_config_continue = "true";
    process.env.npm_config_packages = "workflow,autocompact";
    delete process.env.npm_config_bump;
    assert.deepEqual(npmConsumedFlags([]), ["--continue", "--packages"]);
    // ...and passing them properly keeps the guard quiet.
    assert.deepEqual(
      npmConsumedFlags(["--continue", "--packages", "workflow,autocompact"]),
      [],
    );
  } finally {
    process.env = saved;
  }
});

test("npmConsumedFlags: default npm config values are not false positives", () => {
  const saved = { ...process.env };
  try {
    process.env.npm_config_yes = "false";
    process.env.npm_config_dry_run = "0";
    delete process.env.npm_config_continue;
    delete process.env.npm_config_packages;
    delete process.env.npm_config_bump;
    delete process.env.npm_config_branch;
    delete process.env.npm_config_npm_user;
    delete process.env.npm_config_push;
    assert.deepEqual(npmConsumedFlags([]), []);
  } finally {
    process.env = saved;
  }
});

test("npmConsumedFlags: --yes and -y are recognized as passed", () => {
  const saved = { ...process.env };
  try {
    process.env.npm_config_yes = "true";
    assert.deepEqual(npmConsumedFlags(["--yes"]), []);
    assert.deepEqual(npmConsumedFlags(["-y"]), []);
    assert.deepEqual(npmConsumedFlags([]), ["--yes"]);
  } finally {
    process.env = saved;
  }
});

// ── explicit staging only ──────────────────────────────────────────────────

const WORKFLOW_DIR = "/repo/agent/extensions/workflow";

// The release source as text: the wiring rules (order, no `git add -A`, no
// preflight CI query) are structural, so they are asserted on the source.
const RELEASE_SOURCE = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "release.mjs"),
  "utf8",
);

test("RELEASE_STAGE_BASENAMES: manifest, lockfile and changelog only", () => {
  assert.deepEqual([...RELEASE_STAGE_BASENAMES], [
    "package.json",
    "package-lock.json",
    "CHANGELOG.md",
  ]);
});

test("stagePathsFor: stages those explicit paths under the package dir", () => {
  assert.deepEqual(stagePathsFor({ dir: WORKFLOW_DIR, root: "/repo" }), [
    "agent/extensions/workflow/package.json",
    "agent/extensions/workflow/package-lock.json",
    "agent/extensions/workflow/CHANGELOG.md",
  ]);
});

test("stagePathsFor: a package without a lockfile stages nothing extra", () => {
  assert.deepEqual(
    stagePathsFor({
      dir: WORKFLOW_DIR,
      root: "/repo",
      exists: (name) => name !== "package-lock.json",
    }),
    [
      "agent/extensions/workflow/package.json",
      "agent/extensions/workflow/CHANGELOG.md",
    ],
  );
});

test("stagePathsFor: never reaches outside the released package", () => {
  const paths = stagePathsFor({ dir: WORKFLOW_DIR, root: "/repo" });
  assert.ok(paths.every((p) => p.startsWith("agent/extensions/workflow/")));
  assert.ok(paths.every((p) => !p.includes("settings.json")));
  assert.throws(
    () => stagePathsFor({ dir: "/elsewhere/pkg", root: "/repo" }),
    /not inside the repository/,
  );
});

// ── no-commit HEAD path ────────────────────────────────────────────────────

const SHA = "4548e9d000000000000000000000000000000000";

test("resolveReleaseSha: 'Nothing to commit' still releases the current HEAD", () => {
  assert.deepEqual(resolveReleaseSha({ committed: false, head: SHA }), {
    sha: SHA,
    committed: false,
  });
  assert.deepEqual(resolveReleaseSha({ committed: true, head: ` ${SHA} ` }), {
    sha: SHA,
    committed: true,
  });
});

test("resolveReleaseSha: a missing or abbreviated HEAD fails closed", () => {
  for (const head of [null, "", "4548e9d", "HEAD", "zz".repeat(20)]) {
    assert.throws(
      () => resolveReleaseSha({ committed: false, head }),
      /cannot resolve the release commit SHA/,
      String(head),
    );
  }
});

// ── fresh dependency state ─────────────────────────────────────────────────

test("dependencyFreshness: an install after the lockfile is fresh", () => {
  assert.equal(
    dependencyFreshness({ lockfileMtimeMs: 10, installedMtimeMs: 10 }).fresh,
    true,
  );
  assert.equal(
    dependencyFreshness({ lockfileMtimeMs: 10, installedMtimeMs: 11 }).fresh,
    true,
  );
});

test("dependencyFreshness: a missing or older node_modules is refused", () => {
  const missing = dependencyFreshness({
    lockfileMtimeMs: 10,
    installedMtimeMs: null,
  });
  assert.equal(missing.fresh, false);
  assert.match(missing.reason, /run npm ci/);

  const stale = dependencyFreshness({
    lockfileMtimeMs: 20,
    installedMtimeMs: 10,
  });
  assert.equal(stale.fresh, false);
  assert.match(stale.reason, /predates package-lock\.json/);
});

test("dependencyFreshness: no lockfile means nothing to check", () => {
  assert.equal(dependencyFreshness({}).fresh, true);
});

// ── RELEASE_SKIP_CI bypass ─────────────────────────────────────────────────

test("ciBypassRequested: no env var keeps the gate closed", () => {
  assert.deepEqual(ciBypassRequested({ env: {}, yes: true }), {
    requested: false,
    allowed: false,
    message: null,
  });
  assert.deepEqual(ciBypassRequested({ env: { RELEASE_SKIP_CI: "" }, yes: true }), {
    requested: false,
    allowed: false,
    message: null,
  });
});

test("ciBypassRequested: RELEASE_SKIP_CI=1 with --yes bypasses and says so", () => {
  const bypass = ciBypassRequested({ env: { RELEASE_SKIP_CI: "1" }, yes: true });
  assert.equal(bypass.requested, true);
  assert.equal(bypass.allowed, true);
  assert.equal(bypass.message, "CI gate bypassed by RELEASE_SKIP_CI");
  assert.equal(CI_BYPASS_MESSAGE, bypass.message);
});

test("ciBypassRequested: the env var alone (no --yes) is refused", () => {
  const bypass = ciBypassRequested({
    env: { RELEASE_SKIP_CI: "1" },
    yes: false,
  });
  assert.equal(bypass.requested, true);
  assert.equal(bypass.allowed, false);
  assert.match(bypass.message, /requires --yes/);
});

test("ciBypassRequested: only the exact value 1 is a bypass", () => {
  for (const raw of ["true", "yes", "0", "2"]) {
    const bypass = ciBypassRequested({
      env: { RELEASE_SKIP_CI: raw },
      yes: true,
    });
    assert.equal(bypass.requested, false, raw);
    assert.equal(bypass.allowed, false, raw);
    assert.match(bypass.message, /only RELEASE_SKIP_CI=1/, raw);
  }
});

test("parseArgs: --skip-ci is rejected in favour of RELEASE_SKIP_CI", () => {
  assert.throws(() => parseArgs(["--skip-ci"]), /--skip-ci is not supported/);
});

test("parseArgs: the documented --packages workflow --bump none path works", () => {
  const opts = parseArgs(["--packages", "workflow", "--bump", "none", "--yes"]);
  assert.deepEqual(opts.packages, ["workflow"]);
  assert.equal(opts.bump, "none");
  assert.equal(opts.yes, true);
  assert.equal(opts.noPush, false);
  assert.equal(opts.continue, false);
});

// ── phase gate and CI-blocked publish ─────────────────────────────────────

const GREEN = { state: "green" };
const BEFORE_PUBLISH = ["push", "await-ci"];
const BEFORE_TAG = [...BEFORE_PUBLISH, "publish"];
const BEFORE_PUSH_TAGS = [...BEFORE_TAG, "tag"];

test("gatePhase: publish needs push+await-ci and green CI", () => {
  assert.equal(
    gatePhase({ phase: "publish", completed: BEFORE_PUBLISH, ciState: GREEN })
      .allowed,
    true,
  );
  const noPush = gatePhase({
    phase: "publish",
    completed: ["await-ci"],
    ciState: GREEN,
  });
  assert.equal(noPush.allowed, false);
  assert.equal(noPush.reason, "phase-order");
});

test("gatePhase: pending, unknown and red CI all block publish", () => {
  for (const state of ["pending", "unknown", "red"]) {
    const decision = gatePhase({
      phase: "publish",
      completed: BEFORE_PUBLISH,
      ciState: { state },
    });
    assert.equal(decision.allowed, false, state);
    assert.equal(decision.reason, `ci-${state}`, state);
  }
});

test("gatePhase: missing CI state is unknown, never green", () => {
  const decision = gatePhase({ phase: "publish", completed: BEFORE_PUBLISH });
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, "ci-unknown");
});

test("gatePhase: tag and push-tags keep the CI gate and the strict order", () => {
  assert.equal(
    gatePhase({ phase: "tag", completed: BEFORE_TAG, ciState: GREEN }).allowed,
    true,
  );
  assert.equal(
    gatePhase({ phase: "tag", completed: BEFORE_PUBLISH, ciState: GREEN })
      .allowed,
    false,
  );
  assert.equal(
    gatePhase({ phase: "tag", completed: BEFORE_TAG, ciState: { state: "red" } })
      .allowed,
    false,
  );
  assert.equal(
    gatePhase({
      phase: "push-tags",
      completed: BEFORE_PUSH_TAGS,
      ciState: GREEN,
    }).allowed,
    true,
  );
  assert.equal(
    gatePhase({ phase: "push-tags", completed: BEFORE_TAG, ciState: GREEN })
      .allowed,
    false,
  );
});

test("gatePhase: an explicit bypass relaxes CI, never the phase order", () => {
  const bypassed = gatePhase({
    phase: "publish",
    completed: BEFORE_PUBLISH,
    ciState: { state: "red" },
    bypass: true,
  });
  assert.equal(bypassed.allowed, true);
  assert.equal(bypassed.bypassed, true);
  assert.equal(bypassed.message, "CI gate bypassed by RELEASE_SKIP_CI");

  const outOfOrder = gatePhase({
    phase: "publish",
    completed: [],
    ciState: { state: "red" },
    bypass: true,
  });
  assert.equal(outOfOrder.allowed, false);
  assert.equal(outOfOrder.reason, "phase-order");
});

test("gatePhase: an unknown phase is rejected with and without bypass", () => {
  for (const bypass of [false, true]) {
    const decision = gatePhase({
      phase: "merge",
      completed: ["push"],
      ciState: GREEN,
      bypass,
    });
    assert.equal(decision.allowed, false);
    assert.equal(decision.reason, "unknown-phase");
  }
});

// ── release.mjs wiring (structural guards) ────────────────────────────────

test("release.mjs: preflight never queries CI for an unpushed SHA", () => {
  assert.ok(RELEASE_SOURCE.includes("checkWorkspace("));
  assert.ok(RELEASE_SOURCE.includes("checkVersionInvariants("));
  assert.ok(
    !RELEASE_SOURCE.includes("classifyCiState"),
    "CI classification belongs to the gate, after the push",
  );
  assert.ok(RELEASE_SOURCE.includes("awaitCiState(releaseSha, opts)"));
});

test("release.mjs: staging is explicit and `git add -A` is gone", () => {
  // The only mention may be the comment explaining why it was removed.
  assert.ok(!RELEASE_SOURCE.includes('"add", "-A"'));
  assert.ok(RELEASE_SOURCE.includes('"add", "--"'));
  assert.ok(RELEASE_SOURCE.includes("stagePathsFor"));
});

test("release.mjs: push -> await CI -> publish -> tag -> push-tags", () => {
  const index = (needle) => {
    const at = RELEASE_SOURCE.indexOf(needle);
    assert.notEqual(at, -1, `missing ${needle}`);
    return at;
  };
  const push = index('git(["push", "origin", opts.branch])');
  const awaitCi = index("awaitCiState(releaseSha, opts)");
  const publish = index('gate("publish")');
  const tag = index('gate("tag")');
  const pushTags = index('gate("push-tags")');
  assert.ok(push < awaitCi, "branch push precedes the CI poll");
  assert.ok(awaitCi < publish, "the CI poll precedes publish");
  assert.ok(publish < tag, "publish precedes tag");
  assert.ok(tag < pushTags, "tag precedes push-tags");
});

test("release.mjs: no --skip-ci flag, only the RELEASE_SKIP_CI env var", () => {
  const flagAt = RELEASE_SOURCE.indexOf('arg === "--skip-ci"');
  assert.notEqual(flagAt, -1, "--skip-ci is handled explicitly");
  assert.match(
    RELEASE_SOURCE.slice(flagAt, flagAt + 400),
    /not supported/,
    "--skip-ci only produces a refusal",
  );
  assert.ok(RELEASE_SOURCE.includes("RELEASE_SKIP_CI"));
  assert.ok(RELEASE_SOURCE.includes("CI_BYPASS_MESSAGE"));
});
