#!/usr/bin/env node
/**
 * status.test.mjs — unit tests for scripts/status.mjs.
 *
 * Pure logic only: synthetic packuments, no network, no filesystem writes.
 *
 *   node --test scripts/status.test.mjs     # also runs via `npm test`
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  classifyPackage,
  compareSemver,
  computeExitCode,
  normalizePackument,
  parseSemver,
} from "./status.mjs";

// ── fixtures ───────────────────────────────────────────────────────────────

function packument({
  tags = {},
  versions = [],
  times = {},
  deprecated = {},
} = {}) {
  const doc = {
    "dist-tags": { ...tags },
    versions: {},
    time: { created: "2026-01-01T00:00:00.000Z", ...times },
  };
  for (const version of versions) {
    doc.versions[version] = { name: "@dieulc/x", version };
  }
  for (const [version, message] of Object.entries(deprecated)) {
    doc.versions[version] = {
      ...(doc.versions[version] ?? { name: "@dieulc/x", version }),
      deprecated: message,
    };
  }
  return normalizePackument(doc);
}

function missing() {
  return {
    exists: false,
    distTags: {},
    versions: [],
    times: {},
    deprecated: new Map(),
  };
}

function classify(localVersion, state, error = null) {
  return classifyPackage(
    { short: "x", name: "@dieulc/x", localVersion },
    { state, error },
  );
}

// ── parseSemver ────────────────────────────────────────────────────────────

test("parseSemver reads core, prerelease and build metadata", () => {
  assert.deepEqual(parseSemver("1.2.3"), {
    major: 1,
    minor: 2,
    patch: 3,
    prerelease: [],
  });
  assert.deepEqual(parseSemver("1.2.3-pre.1+build.5").prerelease, ["pre", "1"]);
});

test("parseSemver rejects non-semver strings", () => {
  for (const value of ["v1.2.3", "1.2", "1.2.3.4", "", "latest", null]) {
    assert.equal(parseSemver(value), null, `expected null for ${value}`);
  }
});

// ── compareSemver ──────────────────────────────────────────────────────────

test("compareSemver orders core versions", () => {
  assert.equal(compareSemver("0.1.0", "0.1.0"), 0);
  assert.equal(compareSemver("0.1.0", "0.1.1"), -1);
  assert.equal(compareSemver("0.1.1", "0.1.0"), 1);
  assert.equal(compareSemver("1.0.0", "0.9.9"), 1);
});

test("compareSemver applies prerelease precedence", () => {
  assert.equal(compareSemver("0.1.0-pre", "0.1.0"), -1);
  assert.equal(compareSemver("0.1.0", "0.1.0-pre"), 1);
  assert.equal(compareSemver("0.1.0-pre.2", "0.1.0-pre.10"), -1);
  assert.equal(compareSemver("0.1.0-alpha", "0.1.0-beta"), -1);
  assert.equal(compareSemver("0.1.0-alpha.1", "0.1.0-alpha"), 1);
});

test("compareSemver ignores build metadata and refuses junk", () => {
  assert.equal(compareSemver("1.0.0+build.1", "1.0.0+build.2"), 0);
  assert.equal(compareSemver("nope", "1.0.0"), null);
  assert.equal(compareSemver("1.0.0", undefined), null);
});

// ── classifyPackage ────────────────────────────────────────────────────────

test("classify: never-published (missing packument and zero versions)", () => {
  for (const state of [missing(), normalizePackument(null)]) {
    const verdict = classify("0.2.0", state);
    assert.equal(verdict.drift, "never-published");
    assert.deepEqual(verdict.problems, ["never-published"]);
  }
});

test("classify: in-sync when the local version is the latest dist-tag", () => {
  const verdict = classify(
    "0.2.0",
    packument({ tags: { latest: "0.2.0" }, versions: ["0.2.0"] }),
  );
  assert.equal(verdict.drift, "in-sync");
  assert.deepEqual(verdict.problems, []);
});

test("classify: local-ahead when nothing of the local version is published", () => {
  const verdict = classify(
    "0.2.0",
    packument({ tags: { latest: "0.1.0" }, versions: ["0.1.0"] }),
  );
  assert.equal(verdict.drift, "local-ahead");
  assert.deepEqual(verdict.problems, ["local-ahead"]);
});

test("classify: local-behind when the registry latest is newer", () => {
  const unpublishedLocal = classify(
    "0.1.0",
    packument({ tags: { latest: "0.1.1" }, versions: ["0.1.1"] }),
  );
  assert.equal(unpublishedLocal.drift, "local-behind");
  assert.deepEqual(unpublishedLocal.problems, ["local-behind"]);

  const publishedLocal = classify(
    "0.1.0",
    packument({ tags: { latest: "0.1.1" }, versions: ["0.1.0", "0.1.1"] }),
  );
  assert.equal(publishedLocal.drift, "local-behind");
  assert.deepEqual(publishedLocal.problems, ["local-behind"]);
});

test("classify: published-not-latest when the local version is published but not `latest`", () => {
  const verdict = classify(
    "0.2.0",
    packument({ tags: { latest: "0.1.0" }, versions: ["0.1.0", "0.2.0"] }),
  );
  assert.equal(verdict.drift, "published-not-latest");
  assert.deepEqual(verdict.problems, ["published-not-latest"]);
});

test("classify: local-not-published when latest cannot be compared", () => {
  const verdict = classify(
    "0.1.0",
    packument({ tags: { latest: "stable" }, versions: ["1.0.0"] }),
  );
  assert.equal(verdict.drift, "local-not-published");
  assert.deepEqual(verdict.problems, ["local-not-published"]);
  assert.equal(verdict.notes.length, 1);
});

test("classify: deprecated current version fails even when in sync", () => {
  const verdict = classify(
    "0.1.0",
    packument({
      tags: { latest: "0.1.0" },
      versions: ["0.1.0"],
      deprecated: { "0.1.0": "missing modules" },
    }),
  );
  assert.equal(verdict.drift, "in-sync");
  assert.deepEqual(verdict.problems, ["deprecated-current"]);
});

test("classify: deprecated older versions are a note, not a problem", () => {
  const verdict = classify(
    "0.2.0",
    packument({
      tags: { latest: "0.2.0" },
      versions: ["0.1.0", "0.2.0"],
      deprecated: { "0.1.0": "old" },
    }),
  );
  assert.deepEqual(verdict.problems, []);
  assert.match(verdict.notes.join(" "), /older published version/);
});

test("classify: prerelease latest is a note, not a problem", () => {
  const verdict = classify(
    "0.2.0-pre",
    packument({ tags: { latest: "0.2.0-pre" }, versions: ["0.2.0-pre"] }),
  );
  assert.equal(verdict.drift, "in-sync");
  assert.deepEqual(verdict.problems, []);
  assert.match(verdict.notes.join(" "), /prerelease/);
});

test("classify: invalid local version fails instead of guessing", () => {
  const verdict = classify(
    "not-a-version",
    packument({ tags: { latest: "0.1.0" }, versions: ["0.1.0"] }),
  );
  assert.equal(verdict.drift, "invalid-version");
  assert.deepEqual(verdict.problems, ["invalid-version"]);
});

test("classify: registry errors are surfaced, never silently 'in sync'", () => {
  const verdict = classify("0.2.0", null, "registry responded 500");
  assert.equal(verdict.drift, "registry-error");
  assert.deepEqual(verdict.problems, ["registry-error"]);
  assert.equal(verdict.error, "registry responded 500");
});

// ── computeExitCode ────────────────────────────────────────────────────────

test("computeExitCode: without --check drift is informational", () => {
  const drift = classify(
    "0.2.0",
    packument({ tags: { latest: "0.1.0" }, versions: ["0.1.0"] }),
  );
  assert.equal(computeExitCode([drift], { check: false }), 0);
});

test("computeExitCode: --check fails on version problems and registry errors", () => {
  const clean = classify(
    "0.2.0",
    packument({ tags: { latest: "0.2.0" }, versions: ["0.2.0"] }),
  );
  const drift = classify(
    "0.2.0",
    packument({ tags: { latest: "0.1.0" }, versions: ["0.1.0"] }),
  );
  const error = classify("0.2.0", null, "boom");

  assert.equal(computeExitCode([clean], { check: true }), 0);
  assert.equal(computeExitCode([clean, drift], { check: true }), 1);
  assert.equal(computeExitCode([clean, error], { check: true }), 2);
});
