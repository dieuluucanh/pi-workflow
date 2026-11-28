#!/usr/bin/env node
/**
 * release-gate.test.mjs — table tests for scripts/release-gate.mjs.
 *
 * Pure logic only: synthetic check runs, registry snapshots, tags, git status
 * lines and phase state. No gh, no npm, no network, no filesystem writes.
 *
 *   node --test scripts/release-gate.test.mjs     # also runs via `npm test`
 *
 * The history fixtures mirror the real repository:
 *   0.1.0, 0.3.2   → changelog-only, never published, never tagged
 *   0.13.0         → published and tagged
 *   0.14.0–0.17.4  → untagged development milestones
 *   0.17.5         → the release this gate guards
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CI_POLL_INTERVAL_MS,
  CI_POLL_TIMEOUT_MS,
  HISTORICAL_GAPS,
  HISTORICAL_GAP_FREEZE_AT,
  MATRIX_LEGS,
  RELEASE_PHASES,
  changelogVersions,
  checkVersionInvariants,
  checkWorkspace,
  classifyCiState,
  createGhCheckRunsFetcher,
  isHistoricalGap,
  pollCiState,
  releasePhaseAllowed,
  topChangelogVersion,
} from "./release-gate.mjs";

const SHA = "e9de5370000000000000000000000000000000000";
const OTHER_SHA = "1111111111111111111111111111111111111111";
const FREEZE_MS = Date.parse(HISTORICAL_GAP_FREEZE_AT);
const BEFORE_FREEZE = new Date(FREEZE_MS - 86_400_000).toISOString();
const AT_FREEZE = new Date(FREEZE_MS).toISOString();
const AFTER_FREEZE = new Date(FREEZE_MS + 86_400_000).toISOString();

// ── fixtures ───────────────────────────────────────────────────────────────

function run(name, { sha = SHA, status = "completed", conclusion = "success", ...rest } = {}) {
  return { name, head_sha: sha, status, conclusion, ...rest };
}

const ubuntuGreen = (extra = {}) => run("verify (ubuntu-latest)", extra);
const windowsGreen = (extra = {}) => run("verify (windows-latest)", extra);

function classify(checkRuns, options = {}) {
  return classifyCiState({ checkRuns, sha: SHA, ...options });
}

function workflowChangelog(top = "0.17.5") {
  return [
    "# Changelog",
    "",
    `## [${top}] - 2026-11-27`,
    "",
    "Release target.",
    "",
    "## [0.17.4] - 2026-11-27",
    "## [0.17.3] - 2026-11-26",
    "## [0.17.0] - 2026-11-26",
    "## [0.16.0] - 2026-11-25",
    "## [0.15.0] - 2026-11-25",
    "## [0.14.0] - 2026-11-25",
    "## [0.13.0] - 2026-11-19",
    "## [0.3.2] - 2026-09-21",
    "## [0.3.1] - 2026-09-20",
    "## [0.1.0] - 2026-09-16",
    "",
  ].join("\n");
}

function workflowPackage(overrides = {}) {
  return {
    short: "workflow",
    manifestVersion: "0.17.5",
    changelog: workflowChangelog(),
    published: [{ version: "0.13.0", publishedAt: "2026-11-19T12:00:00.000Z" }],
    tags: [{ name: "@dieulc/workflow@0.13.0", annotated: true, manifestVersion: "0.13.0" }],
    ...overrides,
  };
}

function publishedVersions(versions) {
  return versions.map((version) => ({
    version,
    publishedAt: "2026-09-20T12:00:00.000Z",
  }));
}

function code(violations) {
  return violations.map((violation) => violation.code);
}

// ── classifyCiState: matrix legs ───────────────────────────────────────────

const ciCases = [
  {
    name: "both matrix legs success => green",
    runs: [ubuntuGreen(), windowsGreen()],
    expect: { state: "green", blocked: false, reason: "ci-green" },
  },
  {
    name: "only ubuntu present => unknown (blocked)",
    runs: [ubuntuGreen()],
    expect: { state: "unknown", blocked: true, reason: "missing-leg" },
  },
  {
    name: "only windows present => unknown (blocked)",
    runs: [windowsGreen()],
    expect: { state: "unknown", blocked: true, reason: "missing-leg" },
  },
  {
    name: "ubuntu success + windows queued => pending (blocked)",
    runs: [ubuntuGreen(), run("verify (windows-latest)", { status: "queued", conclusion: null })],
    expect: { state: "pending", blocked: true, reason: "leg-pending" },
  },
  {
    name: "ubuntu success + windows in_progress => pending (blocked)",
    runs: [ubuntuGreen(), run("verify (windows-latest)", { status: "in_progress", conclusion: null })],
    expect: { state: "pending", blocked: true, reason: "leg-pending" },
  },
  {
    name: "ubuntu success + windows failure => red",
    runs: [ubuntuGreen(), run("verify (windows-latest)", { conclusion: "failure" })],
    expect: { state: "red", blocked: true, reason: "leg-failed" },
  },
  {
    name: "ubuntu failure + windows success => red",
    runs: [run("verify (ubuntu-latest)", { conclusion: "failure" }), windowsGreen()],
    expect: { state: "red", blocked: true, reason: "leg-failed" },
  },
  {
    name: "windows cancelled => red",
    runs: [ubuntuGreen(), run("verify (windows-latest)", { conclusion: "cancelled" })],
    expect: { state: "red", blocked: true, reason: "leg-failed" },
  },
  {
    name: "windows timed_out => red",
    runs: [ubuntuGreen(), run("verify (windows-latest)", { conclusion: "timed_out" })],
    expect: { state: "red", blocked: true, reason: "leg-failed" },
  },
  {
    name: "windows action_required => red",
    runs: [ubuntuGreen(), run("verify (windows-latest)", { conclusion: "action_required" })],
    expect: { state: "red", blocked: true, reason: "leg-failed" },
  },
  {
    name: "windows startup_failure => red",
    runs: [ubuntuGreen(), run("verify (windows-latest)", { conclusion: "startup_failure" })],
    expect: { state: "red", blocked: true, reason: "leg-failed" },
  },
  {
    name: "windows stale => red",
    runs: [ubuntuGreen(), run("verify (windows-latest)", { conclusion: "stale" })],
    expect: { state: "red", blocked: true, reason: "leg-failed" },
  },
  {
    name: "windows neutral is not green => blocked red",
    runs: [ubuntuGreen(), run("verify (windows-latest)", { conclusion: "neutral" })],
    expect: { state: "red", blocked: true, reason: "leg-inconclusive" },
  },
  {
    name: "windows skipped is not green => blocked red",
    runs: [ubuntuGreen(), run("verify (windows-latest)", { conclusion: "skipped" })],
    expect: { state: "red", blocked: true, reason: "leg-inconclusive" },
  },
  {
    name: "checks for other names are ignored",
    runs: [
      ubuntuGreen(),
      run("build", { conclusion: "failure" }),
      run("verify (macos-latest)", { conclusion: "failure" }),
      run("verify", { conclusion: "failure" }),
    ],
    expect: { state: "unknown", blocked: true, reason: "missing-leg" },
  },
  {
    name: "checks for another commit SHA are ignored",
    runs: [ubuntuGreen(), windowsGreen({ sha: OTHER_SHA })],
    expect: { state: "unknown", blocked: true, reason: "missing-leg" },
  },
  {
    name: "checks for another event are ignored",
    runs: [ubuntuGreen(), windowsGreen({ event: "push" })],
    options: { event: "pull_request" },
    expect: { state: "unknown", blocked: true, reason: "missing-leg" },
  },
  {
    name: "checks from another app are ignored",
    runs: [ubuntuGreen(), windowsGreen({ app: { slug: "some-other-app" } })],
    expect: { state: "unknown", blocked: true, reason: "missing-leg" },
  },
  {
    name: "rerun: newest failed windows run wins over older success",
    runs: [
      ubuntuGreen(),
      windowsGreen({ started_at: "2026-11-27T10:00:00.000Z" }),
      run("verify (windows-latest)", {
        conclusion: "failure",
        started_at: "2026-11-27T11:00:00.000Z",
      }),
    ],
    expect: { state: "red", blocked: true, reason: "leg-failed" },
  },
  {
    name: "rerun: newer queued windows run wins over older success",
    runs: [
      ubuntuGreen(),
      windowsGreen({ started_at: "2026-11-27T10:00:00.000Z" }),
      run("verify (windows-latest)", {
        status: "queued",
        conclusion: null,
        started_at: "2026-11-27T11:00:00.000Z",
      }),
    ],
    expect: { state: "pending", blocked: true, reason: "leg-pending" },
  },
  {
    name: "run without head_sha still counts for the queried commit",
    runs: [
      ubuntuGreen({ head_sha: undefined }),
      windowsGreen({ head_sha: undefined }),
    ],
    expect: { state: "green", blocked: false, reason: "ci-green" },
  },
];

for (const testCase of ciCases) {
  test(`classifyCiState: ${testCase.name}`, () => {
    const result = classify(testCase.runs, testCase.options);
    assert.equal(result.state, testCase.expect.state, result.message);
    assert.equal(result.blocked, testCase.expect.blocked, result.message);
    assert.equal(result.reason, testCase.expect.reason, result.message);
    if (testCase.expect.state === "green") {
      for (const { leg } of MATRIX_LEGS) {
        assert.equal(result.legs[leg].state, "success");
      }
    } else {
      const unsatisfied = MATRIX_LEGS.filter(({ leg }) => result.legs[leg]?.state !== "success");
      assert.ok(unsatisfied.length > 0, "a blocked result must have a non-success leg");
    }
  });
}

test("classifyCiState: ignored counters count other names, SHAs and events", () => {
  const result = classify(
    [
      ubuntuGreen(),
      windowsGreen(),
      run("build"),
      ubuntuGreen({ sha: OTHER_SHA }),
      ubuntuGreen({ event: "push" }),
    ],
    { event: "pull_request" },
  );
  assert.equal(result.state, "green");
  assert.equal(result.ignored, 3);
});

const fetchFailureCodes = [
  "missing-gh",
  "missing-auth",
  "auth-failed",
  "no-checks",
  "timeout",
  "gh-error",
  "bad-json",
];

for (const codeName of fetchFailureCodes) {
  test(`classifyCiState: ${codeName} fails closed as unknown/blocked`, () => {
    const result = classifyCiState({ sha: SHA, error: codeName });
    assert.equal(result.state, "unknown");
    assert.equal(result.blocked, true);
    assert.equal(result.reason, codeName);
    assert.match(result.message, new RegExp(codeName));
  });
}

test("classifyCiState: a non-array payload fails closed", () => {
  const result = classifyCiState({ sha: SHA, checkRuns: null });
  assert.equal(result.state, "unknown");
  assert.equal(result.blocked, true);
  assert.equal(result.reason, "bad-payload");
});

test("classifyCiState: empty check runs is unknown, never green", () => {
  const result = classify([]);
  assert.equal(result.state, "unknown");
  assert.equal(result.blocked, true);
  assert.equal(result.reason, "missing-leg");
});

// ── pollCiState: fail-closed polling ───────────────────────────────────────

function fakeClock() {
  let time = 0;
  return {
    now: () => time,
    sleep: async (ms) => {
      time += ms;
    },
    get time() {
      return time;
    },
  };
}

test("pollCiState: defaults are 20s interval and 20min deadline", () => {
  assert.equal(CI_POLL_INTERVAL_MS, 20_000);
  assert.equal(CI_POLL_TIMEOUT_MS, 20 * 60_000);
});

test("pollCiState: pending then green resolves green", async () => {
  const clock = fakeClock();
  const responses = [
    { ok: true, checkRuns: [ubuntuGreen()] },
    { ok: true, checkRuns: [ubuntuGreen(), windowsGreen()] },
  ];
  let calls = 0;
  const result = await pollCiState({
    sha: SHA,
    fetchCheckRuns: async () => responses[calls++],
    sleep: clock.sleep,
    now: clock.now,
  });
  assert.equal(result.state, "green");
  assert.equal(result.blocked, false);
  assert.equal(result.attempts, 2);
  assert.equal(result.timedOut, false);
  assert.equal(clock.time, CI_POLL_INTERVAL_MS);
});

test("pollCiState: pending until the deadline stays blocked unknown", async () => {
  const clock = fakeClock();
  let calls = 0;
  const result = await pollCiState({
    sha: SHA,
    fetchCheckRuns: async () => {
      calls += 1;
      return {
        ok: true,
        checkRuns: [ubuntuGreen(), run("verify (windows-latest)", { status: "queued", conclusion: null })],
      };
    },
    sleep: clock.sleep,
    now: clock.now,
  });
  assert.equal(result.state, "unknown");
  assert.equal(result.blocked, true);
  assert.equal(result.timedOut, true);
  assert.equal(result.reason, "leg-pending");
  assert.ok(calls > 1);
  assert.ok(clock.time >= CI_POLL_TIMEOUT_MS);
});

test("pollCiState: no checks ever reported ends blocked", async () => {
  const clock = fakeClock();
  const result = await pollCiState({
    sha: SHA,
    fetchCheckRuns: async () => ({ ok: false, code: "no-checks", message: "none yet" }),
    sleep: clock.sleep,
    now: clock.now,
    intervalMs: 1_000,
    timeoutMs: 5_000,
  });
  assert.equal(result.blocked, true);
  assert.equal(result.state, "unknown");
  assert.equal(result.reason, "no-checks");
  assert.equal(result.timedOut, true);
});

test("pollCiState: missing auth stops immediately", async () => {
  const clock = fakeClock();
  let calls = 0;
  const result = await pollCiState({
    sha: SHA,
    fetchCheckRuns: async () => {
      calls += 1;
      return { ok: false, code: "missing-auth", message: "no token" };
    },
    sleep: clock.sleep,
    now: clock.now,
  });
  assert.equal(result.blocked, true);
  assert.equal(result.reason, "missing-auth");
  assert.equal(result.timedOut, false);
  assert.equal(result.attempts, 1);
  assert.equal(calls, 1);
  assert.equal(clock.time, 0);
});

test("pollCiState: missing gh stops immediately", async () => {
  const result = await pollCiState({
    sha: SHA,
    fetchCheckRuns: async () => ({ ok: false, code: "missing-gh", message: "no gh" }),
    sleep: async () => {
      throw new Error("must not sleep");
    },
    now: () => 0,
  });
  assert.equal(result.blocked, true);
  assert.equal(result.reason, "missing-gh");
  assert.equal(result.attempts, 1);
});

test("pollCiState: a throwing fetcher is retried, then blocked on timeout", async () => {
  const clock = fakeClock();
  const result = await pollCiState({
    sha: SHA,
    fetchCheckRuns: async () => {
      throw new Error("network down");
    },
    sleep: clock.sleep,
    now: clock.now,
    intervalMs: 1_000,
    timeoutMs: 3_000,
    maxAttempts: 4,
  });
  assert.equal(result.blocked, true);
  assert.equal(result.state, "unknown");
  assert.equal(result.timedOut, true);
  assert.equal(result.attempts, 4);
});

test("pollCiState: red stops immediately", async () => {
  let calls = 0;
  const result = await pollCiState({
    sha: SHA,
    fetchCheckRuns: async () => {
      calls += 1;
      return {
        ok: true,
        checkRuns: [ubuntuGreen(), run("verify (windows-latest)", { conclusion: "failure" })],
      };
    },
    sleep: async () => {
      throw new Error("must not sleep");
    },
    now: () => 0,
  });
  assert.equal(result.state, "red");
  assert.equal(result.blocked, true);
  assert.equal(result.attempts, 1);
  assert.equal(calls, 1);
});

test("pollCiState: missing fetcher fails closed", async () => {
  const result = await pollCiState({ sha: SHA });
  assert.equal(result.blocked, true);
  assert.equal(result.state, "unknown");
  assert.equal(result.reason, "missing-fetcher");
});

// ── gh check-runs adapter ──────────────────────────────────────────────────

function runnerReturning({ status = 0, stdout = "", stderr = "", error = null } = {}) {
  const calls = [];
  const run = (cmd, args, options) => {
    calls.push({ cmd, args, options });
    return { status, stdout, stderr, error };
  };
  run.calls = calls;
  return run;
}

const checksPayload = JSON.stringify({
  total_count: 2,
  check_runs: [ubuntuGreen(), windowsGreen()],
});

test("createGhCheckRunsFetcher: missing token never runs gh", async () => {
  const run = runnerReturning({ stdout: checksPayload });
  const fetchCheckRuns = createGhCheckRunsFetcher({ run, env: {} });
  const result = await fetchCheckRuns(SHA);
  assert.equal(result.ok, false);
  assert.equal(result.code, "missing-auth");
  assert.equal(run.calls.length, 0);
});

test("createGhCheckRunsFetcher: GITHUB_TOKEN is accepted and the documented query is used", async () => {
  const run = runnerReturning({ stdout: checksPayload });
  const fetchCheckRuns = createGhCheckRunsFetcher({ run, env: { GITHUB_TOKEN: "t" } });
  const result = await fetchCheckRuns(SHA);
  assert.equal(result.ok, true);
  assert.equal(result.checkRuns.length, 2);
  assert.equal(run.calls.length, 1);
  const { cmd, args } = run.calls[0];
  assert.equal(cmd, "gh");
  assert.equal(args[0], "api");
  assert.equal(args[1], `repos/dieuluucanh/pi-workflow/commits/${SHA}/check-runs`);
  assert.ok(args.includes("Accept: application/vnd.github+json"));
});

test("createGhCheckRunsFetcher: GH_TOKEN is accepted", async () => {
  const run = runnerReturning({ stdout: checksPayload });
  const fetchCheckRuns = createGhCheckRunsFetcher({ run, env: { GH_TOKEN: "t" } });
  assert.equal((await fetchCheckRuns(SHA)).ok, true);
});

test("createGhCheckRunsFetcher: a custom repo is honoured", async () => {
  const run = runnerReturning({ stdout: checksPayload });
  const fetchCheckRuns = createGhCheckRunsFetcher({
    run,
    env: { GH_TOKEN: "t" },
    repo: "example/fork",
  });
  await fetchCheckRuns(SHA);
  assert.equal(run.calls[0].args[1], `repos/example/fork/commits/${SHA}/check-runs`);
});

test("createGhCheckRunsFetcher: ENOENT means gh is missing", async () => {
  const run = runnerReturning({ status: null, error: { code: "ENOENT", message: "spawn gh ENOENT" } });
  const fetchCheckRuns = createGhCheckRunsFetcher({ run, env: { GH_TOKEN: "t" } });
  const result = await fetchCheckRuns(SHA);
  assert.equal(result.ok, false);
  assert.equal(result.code, "missing-gh");
});

test("createGhCheckRunsFetcher: a thrown ENOENT means gh is missing", async () => {
  const fetchCheckRuns = createGhCheckRunsFetcher({
    run: () => {
      const error = new Error("spawn gh ENOENT");
      error.code = "ENOENT";
      throw error;
    },
    env: { GH_TOKEN: "t" },
  });
  assert.equal((await fetchCheckRuns(SHA)).code, "missing-gh");
});

test("createGhCheckRunsFetcher: 401/403 stderr is an auth failure", async () => {
  for (const stderr of [
    "HTTP 401: Bad credentials (https://api.github.com/graphql)",
    "HTTP 403: Resource not accessible",
    "gh: authentication required",
    "no token found in keyring",
  ]) {
    const fetchCheckRuns = createGhCheckRunsFetcher({
      run: runnerReturning({ status: 1, stderr }),
      env: { GH_TOKEN: "t" },
    });
    const result = await fetchCheckRuns(SHA);
    assert.equal(result.ok, false, stderr);
    assert.equal(result.code, "auth-failed", stderr);
  }
});

test("createGhCheckRunsFetcher: an ordinary gh error is gh-error", async () => {
  const fetchCheckRuns = createGhCheckRunsFetcher({
    run: runnerReturning({ status: 1, stderr: "repository not found" }),
    env: { GH_TOKEN: "t" },
  });
  const result = await fetchCheckRuns(SHA);
  assert.equal(result.ok, false);
  assert.equal(result.code, "gh-error");
});

test("createGhCheckRunsFetcher: no checks fails closed", async () => {
  const fetchCheckRuns = createGhCheckRunsFetcher({
    run: runnerReturning({ stdout: JSON.stringify({ total_count: 0, check_runs: [] }) }),
    env: { GH_TOKEN: "t" },
  });
  const result = await fetchCheckRuns(SHA);
  assert.equal(result.ok, false);
  assert.equal(result.code, "no-checks");
});

test("createGhCheckRunsFetcher: malformed JSON fails closed", async () => {
  const fetchCheckRuns = createGhCheckRunsFetcher({
    run: runnerReturning({ stdout: "not json" }),
    env: { GH_TOKEN: "t" },
  });
  assert.equal((await fetchCheckRuns(SHA)).code, "bad-json");

  const missingArray = createGhCheckRunsFetcher({
    run: runnerReturning({ stdout: JSON.stringify({ total_count: 1 }) }),
    env: { GH_TOKEN: "t" },
  });
  assert.equal((await missingArray(SHA)).code, "bad-json");
});

test("createGhCheckRunsFetcher: a missing SHA fails closed", async () => {
  const run = runnerReturning({ stdout: checksPayload });
  const fetchCheckRuns = createGhCheckRunsFetcher({ run, env: { GH_TOKEN: "t" } });
  assert.equal((await fetchCheckRuns()).code, "missing-sha");
  assert.equal(run.calls.length, 0);
});

test("createGhCheckRunsFetcher: requires a runner", () => {
  assert.throws(() => createGhCheckRunsFetcher({ env: { GH_TOKEN: "t" } }), TypeError);
});

// ── version invariants ─────────────────────────────────────────────────────

test("changelog helpers: top heading and all headings", () => {
  const changelog = workflowChangelog();
  assert.equal(topChangelogVersion(changelog), "0.17.5");
  const versions = changelogVersions(changelog);
  assert.equal(versions[0], "0.17.5");
  assert.ok(versions.includes("0.3.2"));
  assert.ok(versions.includes("0.1.0"));
  assert.equal(topChangelogVersion("# Changelog\n\nnothing\n"), null);
  assert.deepEqual(changelogVersions(null), []);
});

test("checkVersionInvariants: real history is allowed (0.1.0/0.3.2 changelog-only, 0.14.0-0.17.4 untagged milestones)", () => {
  const result = checkVersionInvariants({ packages: [workflowPackage()] });
  assert.equal(result.ok, true, JSON.stringify(result.violations));
  assert.equal(result.blocked, false);
  assert.deepEqual(result.violations, []);
  const [summary] = result.packages;
  assert.equal(summary.changelogVersion, "0.17.5");
  assert.deepEqual(summary.published, ["0.13.0"]);
  for (const version of ["0.17.4", "0.14.0", "0.3.2", "0.1.0"]) {
    assert.ok(summary.untaggedHeadings.includes(version), `${version} recorded as untagged`);
  }
});

test("checkVersionInvariants: four packages with consistent tags pass", () => {
  const packages = [
    workflowPackage(),
    {
      short: "autocompact",
      manifestVersion: "0.3.0",
      changelog: "# Changelog\n\n## [0.3.0] - 2026-10-10\n\n## [0.2.1] - 2026-09-20\n",
      published: publishedVersions(["0.2.1", "0.3.0"]),
      tags: [
        { name: "@dieulc/autocompact@0.2.1", annotated: true, manifestVersion: "0.2.1" },
        { name: "@dieulc/autocompact@0.3.0", annotated: true, manifestVersion: "0.3.0" },
      ],
    },
    {
      short: "server-logs",
      manifestVersion: "0.2.1",
      changelog: "# Changelog\n\n## [0.2.1] - 2026-09-20\n\n## [0.1.0] - 2026-09-16\n",
      published: publishedVersions(["0.2.0", "0.2.1"]),
      tags: [
        { name: "@dieulc/server-logs@0.2.0", annotated: true, manifestVersion: "0.2.0" },
        { name: "@dieulc/server-logs@0.2.1", annotated: true, manifestVersion: "0.2.1" },
      ],
    },
  ];
  const result = checkVersionInvariants({ packages });
  assert.equal(result.ok, true, JSON.stringify(result.violations));
});

const versionCases = [
  {
    name: "published 0.17.5 without a tag is blocked",
    pkg: workflowPackage({
      published: [
        { version: "0.13.0", publishedAt: "2026-11-19T12:00:00.000Z" },
        { version: "0.17.5", publishedAt: AFTER_FREEZE },
      ],
    }),
    codes: ["published-without-tag"],
  },
  {
    name: "a newly published version cannot use the allowlist",
    pkg: workflowPackage({
      published: [
        { version: "0.13.0", publishedAt: "2026-11-19T12:00:00.000Z" },
        { version: "0.17.5", publishedAt: AFTER_FREEZE },
      ],
    }),
    gaps: [{ name: "@dieulc/workflow", version: "0.17.5", publishedAt: AFTER_FREEZE }],
    codes: ["published-without-tag"],
  },
  {
    name: "published version with a tag at the wrong manifest is blocked",
    pkg: workflowPackage({
      published: [
        { version: "0.13.0", publishedAt: "2026-11-19T12:00:00.000Z" },
        { version: "0.13.1", publishedAt: "2026-11-20T12:00:00.000Z" },
      ],
      tags: [
        { name: "@dieulc/workflow@0.13.0", annotated: true, manifestVersion: "0.13.0" },
        { name: "@dieulc/workflow@0.13.1", annotated: true, manifestVersion: "0.13.0" },
      ],
    }),
    codes: ["tag-manifest-mismatch"],
  },
  {
    name: "published version with a lightweight tag is blocked",
    pkg: workflowPackage({
      published: [
        { version: "0.13.0", publishedAt: "2026-11-19T12:00:00.000Z" },
        { version: "0.13.1", publishedAt: "2026-11-20T12:00:00.000Z" },
      ],
      tags: [
        { name: "@dieulc/workflow@0.13.0", annotated: true, manifestVersion: "0.13.0" },
        { name: "@dieulc/workflow@0.13.1", annotated: false, manifestVersion: "0.13.1" },
      ],
    }),
    codes: ["tag-not-annotated"],
  },
  {
    name: "published version whose tagged manifest is unreadable is blocked",
    pkg: workflowPackage({
      published: [
        { version: "0.13.0", publishedAt: "2026-11-19T12:00:00.000Z" },
        { version: "0.13.1", publishedAt: "2026-11-20T12:00:00.000Z" },
      ],
      tags: [
        { name: "@dieulc/workflow@0.13.0", annotated: true, manifestVersion: "0.13.0" },
        { name: "@dieulc/workflow@0.13.1", annotated: true, manifestVersion: null },
      ],
    }),
    codes: ["tag-manifest-unreadable"],
  },
  {
    name: "changelog top heading mismatch is blocked",
    pkg: workflowPackage({ changelog: workflowChangelog("0.17.4") }),
    codes: ["changelog-mismatch"],
  },
  {
    name: "missing changelog heading is blocked",
    pkg: workflowPackage({ changelog: "# Changelog\n\nNo versions yet.\n" }),
    codes: ["changelog-heading-missing"],
  },
  {
    name: "missing manifest version is blocked",
    pkg: workflowPackage({ manifestVersion: null }),
    codes: ["manifest-version-missing"],
  },
];

for (const testCase of versionCases) {
  test(`checkVersionInvariants: ${testCase.name}`, () => {
    const result = checkVersionInvariants({
      packages: [testCase.pkg],
      ...(testCase.gaps ? { gaps: testCase.gaps } : {}),
    });
    assert.equal(result.blocked, true, JSON.stringify(result.violations));
    assert.equal(result.ok, false);
    assert.deepEqual(code(result.violations), testCase.codes);
  });
}

test("checkVersionInvariants: historical dangling tag references still report the tag name", () => {
  const result = checkVersionInvariants({
    packages: [
      workflowPackage({
        published: [{ version: "0.13.0", publishedAt: "2026-11-19T12:00:00.000Z" }],
        tags: [],
      }),
    ],
  });
  assert.equal(result.blocked, true);
  assert.deepEqual(code(result.violations), ["published-without-tag"]);
  assert.match(result.violations[0].message, /@dieulc\/workflow@0\.13\.0/);
});

test("checkVersionInvariants: untagged historical headings never block on their own", () => {
  const result = checkVersionInvariants({
    packages: [
      workflowPackage({
        published: [],
        tags: [],
      }),
    ],
  });
  assert.equal(result.ok, true, JSON.stringify(result.violations));
});

test("checkVersionInvariants: a package object may be passed directly", () => {
  assert.equal(checkVersionInvariants({ packages: workflowPackage() }).ok, true);
});

test("HISTORICAL_GAPS: frozen and empty (no genuine pre-existing gaps)", () => {
  assert.equal(Object.isFrozen(HISTORICAL_GAPS), true);
  assert.deepEqual(HISTORICAL_GAPS, []);
});

test("isHistoricalGap: pre-existing published-but-untagged version before the freeze is honoured", () => {
  const gaps = [{ name: "@dieulc/x", version: "1.0.0", publishedAt: BEFORE_FREEZE }];
  assert.equal(isHistoricalGap("@dieulc/x", "1.0.0", BEFORE_FREEZE, gaps), true);
  // Registry reports a slightly earlier publish than the recorded entry.
  assert.equal(
    isHistoricalGap("@dieulc/x", "1.0.0", new Date(FREEZE_MS - 86_400_000 * 2).toISOString(), gaps),
    true,
  );
});

test("isHistoricalGap: anything published at or after the freeze can never be waived", () => {
  const gaps = [
    { name: "@dieulc/x", version: "1.0.0", publishedAt: BEFORE_FREEZE },
    { name: "@dieulc/x", version: "2.0.0", publishedAt: AT_FREEZE },
    { name: "@dieulc/x", version: "3.0.0", publishedAt: AFTER_FREEZE },
  ];
  assert.equal(isHistoricalGap("@dieulc/x", "2.0.0", AT_FREEZE, gaps), false);
  assert.equal(isHistoricalGap("@dieulc/x", "3.0.0", AFTER_FREEZE, gaps), false);
  // A fresh publish is never waivable even if the recorded entry looks old.
  assert.equal(isHistoricalGap("@dieulc/x", "1.0.0", AFTER_FREEZE, gaps), false);
});

test("isHistoricalGap: entries without timestamps or with the wrong version do not match", () => {
  const gaps = [
    { name: "@dieulc/x", version: "1.0.0" },
    { name: "@dieulc/x", version: "2.0.0", publishedAt: BEFORE_FREEZE },
    { name: "@dieulc/y", version: "3.0.0", publishedAt: BEFORE_FREEZE },
  ];
  assert.equal(isHistoricalGap("@dieulc/x", "1.0.0", BEFORE_FREEZE, gaps), false);
  assert.equal(isHistoricalGap("@dieulc/x", "2.0.0", null, gaps), false);
  assert.equal(isHistoricalGap("@dieulc/x", "2.0.0", "not-a-date", gaps), false);
  assert.equal(isHistoricalGap("@dieulc/x", "3.0.0", BEFORE_FREEZE, gaps), false);
});

test("isHistoricalGap: allowed gaps are reported but do not block", () => {
  const result = checkVersionInvariants({
    packages: [
      workflowPackage({
        published: [
          { version: "0.13.0", publishedAt: "2026-11-19T12:00:00.000Z" },
          { version: "0.13.1", publishedAt: "2026-11-20T12:00:00.000Z" },
        ],
      }),
    ],
    gaps: [{ name: "@dieulc/workflow", version: "0.13.1", publishedAt: "2026-11-27T12:00:00.000Z" }],
  });
  assert.equal(result.ok, true, JSON.stringify(result.violations));
  assert.deepEqual(result.allowedGaps.map(({ version }) => version), ["0.13.1"]);
});

test("checkVersionInvariants: gaps parameter does not rewrite the frozen allowlist", () => {
  const result = checkVersionInvariants({
    packages: [
      workflowPackage({
        published: [{ version: "0.17.5", publishedAt: AFTER_FREEZE }],
      }),
    ],
    gaps: [{ name: "@dieulc/workflow", version: "0.17.5", publishedAt: AFTER_FREEZE }],
  });
  assert.deepEqual(code(result.violations), ["published-without-tag"]);
  assert.deepEqual(HISTORICAL_GAPS, []);
});

test("checkVersionInvariants: normalized tag maps are accepted", () => {
  const result = checkVersionInvariants({
    packages: [
      workflowPackage({
        tags: {
          "@dieulc/workflow@0.13.0": { annotated: true, manifestVersion: "0.13.0" },
        },
      }),
    ],
  });
  assert.equal(result.ok, true, JSON.stringify(result.violations));
});

// ── workspace invariants ───────────────────────────────────────────────────

test("checkWorkspace: clean tree on main and in sync is allowed", () => {
  const result = checkWorkspace({ branch: "main", statusEntries: [], origin: { ahead: 0, behind: 0 } });
  assert.equal(result.ok, true);
  assert.equal(result.blocked, false);
  assert.deepEqual(result.violations, []);
});

test("checkWorkspace: branch mismatch is blocked", () => {
  const result = checkWorkspace({ branch: "feature/x" });
  assert.equal(result.blocked, true);
  assert.deepEqual(code(result.violations), ["branch"]);
});

test("checkWorkspace: a dirty agent/settings.json is blocked as settings-dirty", () => {
  const result = checkWorkspace({ branch: "main", statusEntries: [" M agent/settings.json"] });
  assert.equal(result.blocked, true);
  assert.deepEqual(code(result.violations), ["settings-dirty"]);
  assert.deepEqual(result.dirty, ["agent/settings.json"]);
});

test("checkWorkspace: any other dirty path is blocked as dirty-tree", () => {
  const result = checkWorkspace({
    branch: "main",
    statusEntries: ["M  scripts/release.mjs", "?? notes.txt"],
  });
  assert.equal(result.blocked, true);
  assert.deepEqual(code(result.violations), ["dirty-tree"]);
});

test("checkWorkspace: settings plus other dirt reports both codes", () => {
  const result = checkWorkspace({
    branch: "main",
    statusEntries: [" M agent/settings.json", "?? notes.txt"],
  });
  assert.deepEqual(code(result.violations), ["settings-dirty", "dirty-tree"]);
});

test("checkWorkspace: object status entries are supported", () => {
  const result = checkWorkspace({
    branch: "main",
    statusEntries: [{ status: " M", path: "agent/settings.json" }],
  });
  assert.deepEqual(code(result.violations), ["settings-dirty"]);
});

test("checkWorkspace: unpushed commits are blocked", () => {
  const result = checkWorkspace({ branch: "main", origin: { ahead: 2, behind: 0 } });
  assert.deepEqual(code(result.violations), ["unpushed-commits"]);
});

test("checkWorkspace: a checkout behind origin is blocked", () => {
  const result = checkWorkspace({ branch: "main", origin: { ahead: 0, behind: 1 } });
  assert.deepEqual(code(result.violations), ["behind-origin"]);
});

test("checkWorkspace: a non-default expected branch is honoured", () => {
  assert.equal(
    checkWorkspace({ branch: "release/x", expectedBranch: "release/x" }).ok,
    true,
  );
});

// ── release phase ordering ─────────────────────────────────────────────────

const green = { state: "green" };

const phaseCases = [
  {
    name: "push first is allowed",
    phase: "push",
    completed: [],
    ciState: null,
    allowed: true,
  },
  {
    name: "await-ci after push is allowed",
    phase: "await-ci",
    completed: ["push"],
    ciState: null,
    allowed: true,
  },
  {
    name: "publish after push+green CI is allowed",
    phase: "publish",
    completed: ["push", "await-ci"],
    ciState: green,
    allowed: true,
  },
  {
    name: "tag after publish+green CI is allowed",
    phase: "tag",
    completed: ["push", "await-ci", "publish"],
    ciState: green,
    allowed: true,
  },
  {
    name: "push-tags after tag+green CI is allowed",
    phase: "push-tags",
    completed: ["push", "await-ci", "publish", "tag"],
    ciState: green,
    allowed: true,
  },
  {
    name: "publish before await-ci is blocked",
    phase: "publish",
    completed: ["push"],
    ciState: green,
    reason: "phase-order",
  },
  {
    name: "publish before CI is green (pending) is blocked",
    phase: "publish",
    completed: ["push", "await-ci"],
    ciState: { state: "pending" },
    reason: "ci-pending",
  },
  {
    name: "publish on unknown CI is blocked",
    phase: "publish",
    completed: ["push", "await-ci"],
    ciState: { state: "unknown" },
    reason: "ci-unknown",
  },
  {
    name: "publish on red CI is blocked",
    phase: "publish",
    completed: ["push", "await-ci"],
    ciState: { state: "red" },
    reason: "ci-red",
  },
  {
    name: "publish with no CI state is blocked",
    phase: "publish",
    completed: ["push", "await-ci"],
    ciState: null,
    reason: "ci-unknown",
  },
  {
    name: "tag without publish is blocked",
    phase: "tag",
    completed: ["push", "await-ci"],
    ciState: green,
    reason: "phase-order",
  },
  {
    name: "push-tags without tag is blocked",
    phase: "push-tags",
    completed: ["push", "await-ci", "publish"],
    ciState: green,
    reason: "phase-order",
  },
  {
    name: "an unknown phase is blocked",
    phase: "merge",
    completed: RELEASE_PHASES,
    ciState: green,
    reason: "unknown-phase",
  },
];

for (const testCase of phaseCases) {
  test(`releasePhaseAllowed: ${testCase.name}`, () => {
    const result = releasePhaseAllowed({
      phase: testCase.phase,
      completed: testCase.completed,
      ciState: testCase.ciState,
    });
    const allowed = testCase.allowed === true;
    assert.equal(result.allowed, allowed);
    assert.equal(result.blocked, !allowed);
    if (allowed) assert.equal(result.reason, "allowed");
    else assert.equal(result.reason, testCase.reason, result.message);
  });
}

test("releasePhaseAllowed: unknown CI can never unlock a gated phase", () => {
  for (const phase of ["publish", "tag", "push-tags"]) {
    const completed = RELEASE_PHASES.slice(0, RELEASE_PHASES.indexOf(phase));
    for (const ciState of ["unknown", "pending", "red", null]) {
      const result = releasePhaseAllowed({ phase, completed, ciState });
      assert.equal(result.allowed, false, `${phase} with ${ciState}`);
      assert.equal(result.blocked, true);
    }
  }
});

test("releasePhaseAllowed: every phase allows exactly one position in the order", () => {
  for (const phase of RELEASE_PHASES) {
    const completed = RELEASE_PHASES.slice(0, RELEASE_PHASES.indexOf(phase));
    const result = releasePhaseAllowed({ phase, completed, ciState: green });
    assert.equal(result.allowed, true, phase);
  }
});

test("releasePhaseAllowed: default completed list fails closed", () => {
  const result = releasePhaseAllowed({ phase: "publish", ciState: green });
  assert.equal(result.allowed, false);
  assert.equal(result.reason, "phase-order");
});
