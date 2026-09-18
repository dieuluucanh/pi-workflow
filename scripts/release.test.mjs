#!/usr/bin/env node
/**
 * release.test.mjs — unit tests for scripts/release.mjs.
 *
 * Pure logic only: registry classification, the release decision rules, the
 * plan builder (with an injected probe) and the changelog composer. No npm, no
 * git, no filesystem writes.
 *
 *   node --test scripts/release.test.mjs     # also runs via `npm test`
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  classifyNpmView,
  classifyTargetState,
  composeChangelog,
  decideTarget,
  documentsVersion,
  normalizeEol,
  npmConsumedFlags,
  planTargets,
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
        'npm error code E404\nnpm error 404 Unpublished on 2026-09-16T04:16:14.175Z\nnpm error 404  The requested resource \'@dieulc/autocompact\' could not be found',
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
    classifyTargetState({ kind: "none", nextVersion: "0.2.0", state: "published" })
      .status,
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
  const targets = planTargets(selected, { bump: "none", continue: false }, (name) =>
    name === "@dieulc/autocompact" ? "absent" : "published",
  );

  const publishable = targets.filter((t) => t.status === "publish");
  const skipped = targets.filter((t) => t.status === "skip");

  assert.deepEqual(publishable.map((t) => t.name), ["@dieulc/autocompact"]);
  assert.equal(skipped.length, 3);
  // Published-but-skipped targets stay tag-eligible (missing-tag repair) and
  // none of them is dropped from the plan.
  assert.ok(skipped.every((t) => t.tagEligible));
  assert.equal(targets.length, 4);
});

test("planTargets: the probe is asked about the *next* version", () => {
  const asked = [];
  planTargets([pkg("workflow")], { bump: "minor", continue: false }, (name, version) => {
    asked.push(`${name}@${version}`);
    return "absent";
  });
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
  return text.split("\n").filter((line) => line.trim() === "# Changelog").length;
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
