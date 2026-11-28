#!/usr/bin/env node
/**
 * release-gate.mjs — pure, testable invariants for a 0.17.5-style release.
 *
 * Nothing here runs a release. Every function is a decision function:
 *
 *   classifyCiState       → green / unknown / pending / red for one commit SHA
 *   pollCiState           → the same, polled, fail-closed (20 s × 20 min)
 *   createGhCheckRunsFetcher → `gh api .../commits/<sha>/check-runs` adapter
 *   checkVersionInvariants → changelog heading, published versions, annotated tags
 *   checkWorkspace        → branch, clean tree, agent/settings.json, origin drift
 *   releasePhaseAllowed   → push -> await-ci -> publish -> tag -> push-tags
 *
 * Rules encoded here (see PR #10):
 *   - Only `verify (ubuntu-latest)` AND `verify (windows-latest)` on the
 *     expected SHA, both `success`, make CI green. A missing leg is unknown.
 *   - Unknown is blocked exactly like pending. Publishing requires green.
 *   - Missing `gh`, missing GH_TOKEN/GITHUB_TOKEN, auth failure, no checks and
 *     a polling timeout all fail closed.
 *   - A published version must have an annotated tag whose tagged package.json
 *     version matches. A frozen historical-gap allowlist covers pre-existing
 *     published-but-untagged versions only; anything published now cannot
 *     enter it.
 *   - Changelog-only historical headings (0.1.0, 0.3.2) and untagged
 *     development milestones (0.14.0–0.17.4) never block.
 *
 * Usage (tests): `node --test scripts/release-gate.test.mjs`
 */

// ── constants ──────────────────────────────────────────────────────────────

/** The only commit-status context that can satisfy the gate. */
export const EXPECTED_WORKFLOW = "verify";

/** Both matrix legs, exactly as GitHub Actions names the jobs. */
export const MATRIX_LEGS = Object.freeze([
  Object.freeze({ leg: "ubuntu-latest", name: "verify (ubuntu-latest)" }),
  Object.freeze({ leg: "windows-latest", name: "verify (windows-latest)" }),
]);

/** The documented query origin (PR #10). */
export const DEFAULT_REPO = "dieuluucanh/pi-workflow";

/** Poll cadence and deadline for `pollCiState`. */
export const CI_POLL_INTERVAL_MS = 20_000;
export const CI_POLL_TIMEOUT_MS = 20 * 60_000;

/** Conventions that mean "the leg did not pass". */
export const FAILURE_CONCLUSIONS = Object.freeze([
  "failure",
  "cancelled",
  "timed_out",
  "action_required",
  "startup_failure",
  "stale",
]);

/** Conclusions that are neither success, failure, nor still running. */
export const INCONCLUSIVE_CONCLUSIONS = Object.freeze(["neutral", "skipped"]);

/** Ordered release phases. A later phase may not start before an earlier one. */
export const RELEASE_PHASES = Object.freeze([
  "push",
  "await-ci",
  "publish",
  "tag",
  "push-tags",
]);

/** Phases that must prove green CI before they are allowed to run. */
export const CI_GATED_PHASES = Object.freeze(["publish", "tag", "push-tags"]);

/**
 * Freeze instant for the historical-gap allowlist.
 *
 * A gap entry is honoured only when the registry reports a publish timestamp
 * strictly before this instant. Anything published at or after it — including
 * every version published from now on — can never be waived, so a fresh
 * published-but-untagged version always blocks.
 */
export const HISTORICAL_GAP_FREEZE_AT = "2026-11-28T00:00:00.000Z";

/**
 * Frozen allowlist of genuinely published-but-untagged versions that predate
 * the gate. Verified against the tags in this repository:
 *
 *   0.1.0, 0.3.2      → changelog-only, never published, never tagged
 *   0.14.0–0.17.4     → untagged development milestones, never published
 *   0.13.0            → published and tagged
 *
 * There are therefore no genuine pre-existing gaps: the list is empty on
 * purpose. The mechanism stays so a real gap found later can be recorded once,
 * with its registry timestamp, and never silently grow.
 */
export const HISTORICAL_GAPS = Object.freeze([]);

const NON_RETRYABLE_FETCH_CODES = Object.freeze([
  "missing-gh",
  "missing-auth",
  "auth-failed",
]);

const DEFAULT_SLEEP = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ── CI state ───────────────────────────────────────────────────────────────

function describeConclusion(conclusion) {
  return typeof conclusion === "string" && conclusion.length > 0
    ? conclusion
    : "(none)";
}

function newestRun(runs) {
  let best = null;
  for (const run of runs) {
    if (best === null) {
      best = run;
      continue;
    }
    const bestAt = String(best.started_at ?? best.completed_at ?? "");
    const runAt = String(run.started_at ?? run.completed_at ?? "");
    // ISO-8601 timestamps compare lexicographically. Equal timestamps mean the
    // API's own order wins: the later entry is the newer run.
    if (runAt >= bestAt) best = run;
  }
  return best;
}

/**
 * Classify one leg from the check runs that match it.
 *
 * @returns {{present: boolean, state: "success"|"pending"|"missing"|"failure"|"inconclusive", conclusion: string|null, status: string|null, name: string}}
 */
function classifyLeg(runs, name) {
  if (runs.length === 0) {
    return { present: false, state: "missing", conclusion: null, status: null, name };
  }
  const run = newestRun(runs);
  const conclusion = typeof run.conclusion === "string" ? run.conclusion : null;
  const status = typeof run.status === "string" ? run.status : null;
  const base = { present: true, conclusion, status, name };
  if (conclusion === "success") return { ...base, state: "success" };
  if (status !== null && status !== "completed") return { ...base, state: "pending" };
  if (conclusion === null) return { ...base, state: "pending" };
  if (FAILURE_CONCLUSIONS.includes(conclusion)) return { ...base, state: "failure" };
  return { ...base, state: "inconclusive" };
}

function errorState(code, message) {
  return {
    state: "unknown",
    blocked: true,
    reason: code,
    message: message ?? `CI state unknown (${code})`,
    legs: Object.fromEntries(MATRIX_LEGS.map(({ leg }) => [leg, null])),
    ignored: 0,
  };
}

/**
 * Classify CI for one commit.
 *
 * Green only when the check runs for the expected SHA include both matrix legs
 * with conclusion `success`. A missing leg is `unknown` (blocked). Any failure
 * conclusion is `red`. A queued/in-progress leg is `pending`. Runs with another
 * name, event, app or head_sha are ignored.
 *
 * @param {object} input
 * @param {Array<object>} [input.checkRuns] Check runs (gh `check_runs` shape).
 * @param {string} [input.sha] Expected commit SHA.
 * @param {string} [input.error] Fail-closed reason code (missing-gh, missing-auth,
 *   auth-failed, no-checks, timeout, gh-error, bad-json).
 * @param {string} [input.message] Human-readable detail for `error`.
 * @param {string} [input.event] Expected event; runs with a different event are ignored.
 * @returns {{state: "green"|"unknown"|"pending"|"red", blocked: boolean, reason: string, message: string, legs: object, ignored: number}}
 */
export function classifyCiState({
  checkRuns = [],
  sha,
  error = null,
  message = null,
  event = null,
} = {}) {
  if (error) return errorState(error, message);
  if (!Array.isArray(checkRuns)) {
    return errorState("bad-payload", "check runs payload is not an array");
  }

  let ignored = 0;
  const matches = new Map(MATRIX_LEGS.map(({ leg }) => [leg, []]));
  for (const run of checkRuns) {
    if (run === null || typeof run !== "object") {
      ignored += 1;
      continue;
    }
    if (sha && run.head_sha && run.head_sha !== sha) {
      ignored += 1;
      continue;
    }
    if (event && run.event && run.event !== event) {
      ignored += 1;
      continue;
    }
    if (run.app && typeof run.app === "object" && run.app.slug && run.app.slug !== "github-actions") {
      ignored += 1;
      continue;
    }
    const match = MATRIX_LEGS.find(({ name }) => run.name === name);
    if (!match) {
      ignored += 1;
      continue;
    }
    matches.get(match.leg).push(run);
  }

  const legs = {};
  for (const { leg, name } of MATRIX_LEGS) {
    legs[leg] = classifyLeg(matches.get(leg), name);
  }

  const missing = MATRIX_LEGS.filter(({ leg }) => legs[leg].state === "missing");
  if (missing.length > 0) {
    return {
      state: "unknown",
      blocked: true,
      reason: "missing-leg",
      message: `CI state unknown: missing ${missing.map(({ name }) => name).join(", ")}`,
      legs,
      ignored,
    };
  }

  const failed = MATRIX_LEGS.filter(({ leg }) => legs[leg].state === "failure");
  if (failed.length > 0) {
    const details = failed
      .map(({ leg }) => `${legs[leg].name} ${describeConclusion(legs[leg].conclusion)}`)
      .join(", ");
    return {
      state: "red",
      blocked: true,
      reason: "leg-failed",
      message: `CI red: ${details}`,
      legs,
      ignored,
    };
  }

  const inconclusive = MATRIX_LEGS.filter(({ leg }) => legs[leg].state === "inconclusive");
  if (inconclusive.length > 0) {
    const details = inconclusive
      .map(({ leg }) => `${legs[leg].name} ${describeConclusion(legs[leg].conclusion)}`)
      .join(", ");
    return {
      state: "red",
      blocked: true,
      reason: "leg-inconclusive",
      message: `CI red: ${details} is not a success`,
      legs,
      ignored,
    };
  }

  const pending = MATRIX_LEGS.filter(({ leg }) => legs[leg].state === "pending");
  if (pending.length > 0) {
    const details = pending.map(({ leg }) => `${legs[leg].name} ${legs[leg].status ?? "queued"}`).join(", ");
    return {
      state: "pending",
      blocked: true,
      reason: "leg-pending",
      message: `CI pending: ${details}`,
      legs,
      ignored,
    };
  }

  return {
    state: "green",
    blocked: false,
    reason: "ci-green",
    message: "CI green: verify (ubuntu-latest) and verify (windows-latest) both succeeded",
    legs,
    ignored,
  };
}

// ── gh adapter ─────────────────────────────────────────────────────────────

/** True when the environment carries a token `gh` can use. */
export function hasGhAuth(env = {}) {
  return Boolean(env.GH_TOKEN || env.GITHUB_TOKEN);
}

/**
 * Build a `fetchCheckRuns(sha)` function backed by the documented query:
 *
 *   gh api repos/dieuluucanh/pi-workflow/commits/<sha>/check-runs
 *
 * The command runner is injected so the adapter is fully testable:
 *   run(cmd, args, options) -> { status, stdout, stderr, error }
 *
 * The returned function never throws. It resolves to
 *   { ok: true, checkRuns }            on a successful query
 *   { ok: false, code, message }       on missing gh, missing token, auth
 *                                      failure, empty checks, or bad output.
 */
export function createGhCheckRunsFetcher({
  run,
  env = {},
  repo = DEFAULT_REPO,
} = {}) {
  if (typeof run !== "function") {
    throw new TypeError("createGhCheckRunsFetcher requires a run(cmd, args, options) function");
  }

  return function fetchCheckRuns(sha) {
    if (!sha || typeof sha !== "string") {
      return { ok: false, code: "missing-sha", message: "no commit SHA to query" };
    }
    if (!hasGhAuth(env)) {
      return {
        ok: false,
        code: "missing-auth",
        message: "GH_TOKEN or GITHUB_TOKEN is required to query check-runs",
      };
    }

    const args = [
      "api",
      `repos/${repo}/commits/${sha}/check-runs`,
      "-H",
      "Accept: application/vnd.github+json",
    ];

    let result;
    try {
      result = run("gh", args, { encoding: "utf8" });
    } catch (caught) {
      result = { status: 1, stdout: "", stderr: "", error: caught };
    }

    if (result?.error?.code === "ENOENT" || result?.error?.code === "ENOTFOUND") {
      return { ok: false, code: "missing-gh", message: "gh CLI not found on PATH" };
    }

    const status = typeof result?.status === "number" ? result.status : 1;
    if (status !== 0) {
      const stderr = `${result?.stderr ?? ""}${result?.error?.message ?? ""}`.trim();
      const authFailure = /401|403|auth|token|credential|not logged in/i.test(stderr);
      return {
        ok: false,
        code: authFailure ? "auth-failed" : "gh-error",
        message: stderr || `gh exited with status ${status}`,
      };
    }

    let payload;
    try {
      payload = JSON.parse(String(result?.stdout ?? ""));
    } catch (caught) {
      return { ok: false, code: "bad-json", message: `gh output is not JSON: ${caught.message}` };
    }

    const checkRuns = Array.isArray(payload?.check_runs) ? payload.check_runs : null;
    if (checkRuns === null) {
      return { ok: false, code: "bad-json", message: "gh output has no check_runs array" };
    }
    if (checkRuns.length === 0) {
      return {
        ok: false,
        code: "no-checks",
        message: `no check runs reported for ${sha}`,
      };
    }

    return { ok: true, checkRuns };
  };
}

/**
 * Poll CI until green, red, or the deadline.
 *
 * Fail-closed: a missing leg, pending legs, no checks, or a timeout all end as
 * blocked. `unknown` is never publishable. Missing gh / missing token / auth
 * failure stop immediately instead of burning the deadline.
 *
 * @param {object} input
 * @param {(sha: string) => (object|Promise<object>)} input.fetchCheckRuns
 * @param {string} input.sha Expected commit SHA.
 * @param {(ms: number) => Promise<void>} [input.sleep]
 * @param {() => number} [input.now]
 * @param {number} [input.intervalMs]
 * @param {number} [input.timeoutMs]
 * @param {number} [input.maxAttempts]
 */
export async function pollCiState({
  fetchCheckRuns,
  sha,
  sleep = DEFAULT_SLEEP,
  now = Date.now,
  intervalMs = CI_POLL_INTERVAL_MS,
  timeoutMs = CI_POLL_TIMEOUT_MS,
  maxAttempts = Math.ceil(CI_POLL_TIMEOUT_MS / CI_POLL_INTERVAL_MS) + 1,
} = {}) {
  if (typeof fetchCheckRuns !== "function") {
    return {
      ...errorState("missing-fetcher", "pollCiState requires a fetchCheckRuns(sha) function"),
      attempts: 0,
      timedOut: false,
    };
  }

  const startedAt = now();
  const deadline = startedAt + timeoutMs;
  let attempts = 0;
  let last = null;

  for (;;) {
    attempts += 1;
    let fetched;
    try {
      fetched = await fetchCheckRuns(sha);
    } catch (caught) {
      fetched = { ok: false, code: "fetch-failed", message: caught?.message ?? String(caught) };
    }

    if (fetched && fetched.ok === true) {
      last = classifyCiState({ checkRuns: fetched.checkRuns, sha });
    } else {
      const code = fetched?.code ?? "gh-error";
      last = errorState(code, fetched?.message);
      if (NON_RETRYABLE_FETCH_CODES.includes(code)) {
        return { ...last, attempts, timedOut: false };
      }
    }

    if (last.state === "green" || last.state === "red") {
      return { ...last, attempts, timedOut: false };
    }

    const atDeadline = now() >= deadline || attempts >= maxAttempts;
    if (atDeadline) {
      // Never publish on unknown: anything that is not green ends blocked.
      return {
        ...last,
        state: "unknown",
        blocked: true,
        reason: last.reason === "ci-green" ? "timeout" : last.reason,
        message: `${last.message} (timed out after ${attempts} attempt(s))`,
        attempts,
        timedOut: true,
      };
    }

    await sleep(intervalMs);
  }
}

// ── version invariants ─────────────────────────────────────────────────────

const CHANGELOG_HEADING_RE = /^##\s*\[v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\]/;

/** First versioned `## [x.y.z]` heading in a changelog, or null. */
export function topChangelogVersion(changelog) {
  if (typeof changelog !== "string") return null;
  for (const line of changelog.split(/\r?\n/)) {
    const match = CHANGELOG_HEADING_RE.exec(line.trim());
    if (match) return match[1];
  }
  return null;
}

/** Every versioned `## [x.y.z]` heading, in file order. */
export function changelogVersions(changelog) {
  if (typeof changelog !== "string") return [];
  const versions = [];
  for (const line of changelog.split(/\r?\n/)) {
    const match = CHANGELOG_HEADING_RE.exec(line.trim());
    if (match) versions.push(match[1]);
  }
  return versions;
}

function timestampOf(value) {
  if (typeof value !== "string" || value.length === 0) return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : time;
}

/**
 * Is `name@version` a frozen, genuinely pre-existing published-but-untagged
 * gap?
 *
 * Honoured only when the entry matches exactly, predates the freeze instant,
 * and the registry timestamp for that version is at or before the entry's
 * timestamp — and strictly before the freeze. A version published now can
 * therefore never be waived, even by a hand-edited entry: its registry
 * timestamp is after the freeze.
 */
export function isHistoricalGap(name, version, publishedAt, gaps = HISTORICAL_GAPS) {
  if (!Array.isArray(gaps) || gaps.length === 0) return false;
  const published = timestampOf(publishedAt);
  if (published === null) return false;
  const freeze = timestampOf(HISTORICAL_GAP_FREEZE_AT);
  if (published >= freeze) return false;

  return gaps.some((gap) => {
    if (gap === null || typeof gap !== "object") return false;
    if (gap.name !== name || gap.version !== version) return false;
    const recorded = timestampOf(gap.publishedAt);
    if (recorded === null) return false;
    if (recorded >= freeze) return false;
    return published <= recorded;
  });
}

function normalizePublished(published = []) {
  const normalized = [];
  for (const entry of published) {
    if (typeof entry === "string") normalized.push({ version: entry, publishedAt: null });
    else if (entry && typeof entry === "object" && typeof entry.version === "string") {
      normalized.push({ version: entry.version, publishedAt: entry.publishedAt ?? null });
    }
  }
  return normalized;
}

function normalizeTags(tags = []) {
  if (Array.isArray(tags)) {
    return tags
      .filter((tag) => tag && typeof tag === "object" && typeof tag.name === "string")
      .map((tag) => ({
        name: tag.name,
        annotated: tag.annotated === true,
        manifestVersion: tag.manifestVersion ?? null,
      }));
  }
  if (tags && typeof tags === "object") {
    return Object.entries(tags).map(([name, tag]) => ({
      name,
      annotated: tag === true || tag?.annotated === true,
      manifestVersion: typeof tag === "object" ? (tag?.manifestVersion ?? null) : null,
    }));
  }
  return [];
}

function packageName(pkg) {
  if (typeof pkg.name === "string" && pkg.name.length > 0) return pkg.name;
  if (typeof pkg.short === "string" && pkg.short.length > 0) return `@dieulc/${pkg.short}`;
  return null;
}

/**
 * Check the version/tag invariants for one or more packages.
 *
 * (a) the top `## [x.y.z]` changelog heading equals the manifest version;
 * (b) every published registry version has an annotated tag
 *     `@dieulc/<pkg>@<version>` whose tagged package.json version matches;
 * (c) untagged historical changelog headings never block (0.1.0, 0.3.2,
 *     0.14.0–0.17.4 and friends); untagged *published* versions block unless
 *     they are in the frozen historical-gap allowlist.
 *
 * @param {object} input
 * @param {Array<object>|object} input.packages Package records:
 *   `{ name|short, manifestVersion, changelog, published: [version|{version,publishedAt}], tags: [{name, annotated, manifestVersion}] }`.
 * @param {Array<object>} [input.gaps] Allowlist override (tests only).
 * @returns {{ok: boolean, blocked: boolean, violations: Array<object>, allowedGaps: Array<object>, packages: Array<object>}}
 */
export function checkVersionInvariants({ packages, gaps = HISTORICAL_GAPS } = {}) {
  const list = Array.isArray(packages)
    ? packages
    : packages && typeof packages === "object"
      ? [packages]
      : [];

  const violations = [];
  const allowedGaps = [];
  const summary = [];

  for (const pkg of list) {
    if (pkg === null || typeof pkg !== "object") continue;
    const name = packageName(pkg);
    if (name === null) {
      violations.push({
        code: "package-name-missing",
        package: null,
        version: null,
        message: "package record has neither name nor short",
      });
      continue;
    }

    const manifestVersion = typeof pkg.manifestVersion === "string" ? pkg.manifestVersion : null;
    if (manifestVersion === null) {
      violations.push({
        code: "manifest-version-missing",
        package: name,
        version: null,
        message: `${name}: manifest version is missing`,
      });
    }

    const top = topChangelogVersion(pkg.changelog);
    if (top === null) {
      violations.push({
        code: "changelog-heading-missing",
        package: name,
        version: manifestVersion,
        message: `${name}: changelog has no "## [x.y.z]" heading`,
      });
    } else if (manifestVersion !== null && top !== manifestVersion) {
      violations.push({
        code: "changelog-mismatch",
        package: name,
        version: manifestVersion,
        message: `${name}: changelog top heading is ${top}, manifest is ${manifestVersion}`,
      });
    }

    const tags = normalizeTags(pkg.tags);
    const published = normalizePublished(pkg.published);
    const publishedVersions = new Set(published.map(({ version }) => version));

    for (const { version, publishedAt } of published) {
      const tagName = `${name}@${version}`;
      const tag = tags.find((candidate) => candidate.name === tagName);
      if (!tag) {
        if (isHistoricalGap(name, version, publishedAt, gaps)) {
          allowedGaps.push({ name, version, publishedAt, tagName });
          continue;
        }
        violations.push({
          code: "published-without-tag",
          package: name,
          version,
          message: `${name}@${version} is published but has no ${tagName} tag`,
        });
        continue;
      }
      if (tag.annotated !== true) {
        violations.push({
          code: "tag-not-annotated",
          package: name,
          version,
          message: `${tagName} is not an annotated tag`,
        });
        continue;
      }
      if (tag.manifestVersion === null) {
        violations.push({
          code: "tag-manifest-unreadable",
          package: name,
          version,
          message: `${tagName}: tagged package.json version could not be read`,
        });
        continue;
      }
      if (tag.manifestVersion !== version) {
        violations.push({
          code: "tag-manifest-mismatch",
          package: name,
          version,
          message: `${tagName}: tagged package.json is ${tag.manifestVersion}`,
        });
      }
    }

    const changelogHeadings = changelogVersions(pkg.changelog);
    const untaggedHeadings = changelogHeadings.filter((version) => {
      if (publishedVersions.has(version)) return false;
      return !tags.some((tag) => tag.name === `${name}@${version}`);
    });

    summary.push({
      name,
      manifestVersion,
      changelogVersion: top,
      published: published.map(({ version }) => version),
      tagged: tags.map(({ name: tagName }) => tagName),
      // Informational only: changelog-only versions and untagged milestones
      // (0.1.0, 0.3.2, 0.14.0–0.17.4) are recorded here, never blocked on.
      untaggedHeadings,
    });
  }

  return {
    ok: violations.length === 0,
    blocked: violations.length > 0,
    violations,
    allowedGaps,
    packages: summary,
  };
}

// ── workspace invariants ───────────────────────────────────────────────────

function normalizeStatusEntries(entries = []) {
  const result = [];
  for (const entry of entries) {
    if (typeof entry === "string") {
      const line = entry.replace(/\s+$/, "");
      if (line.length === 0) continue;
      // `git status --porcelain=v1` lines are `XY <path>`; keep the path.
      // Leading spaces are significant (they encode the index status), so the
      // line is only right-trimmed.
      const match = /^([ MADRCU?!]{1,2})\s+(.+)$/.exec(line);
      result.push({ status: match ? match[1] : "", path: match ? match[2] : line });
    } else if (entry && typeof entry === "object" && typeof entry.path === "string") {
      result.push({ status: String(entry.status ?? ""), path: entry.path });
    }
  }
  return result;
}

/**
 * Check the local workspace is safe to release from.
 *
 * - branch equals `expectedBranch` (default `main`)
 * - tree is clean (`git status --porcelain=v1 --untracked-files=all` empty)
 * - `agent/settings.json` is not modified (explicit, separate violation)
 * - origin is neither ahead (unpushed commits) nor behind (stale checkout)
 *
 * @param {object} input
 * @param {string} [input.branch]
 * @param {string} [input.expectedBranch]
 * @param {Array<string|object>} [input.statusEntries]
 * @param {{ahead?: number, behind?: number}} [input.origin]
 */
export function checkWorkspace({
  branch = null,
  expectedBranch = "main",
  statusEntries = [],
  origin = {},
} = {}) {
  const violations = [];
  if (expectedBranch !== null && branch !== expectedBranch) {
    violations.push({
      code: "branch",
      message: `on ${branch ?? "(detached)"}, expected ${expectedBranch}`,
    });
  }

  const entries = normalizeStatusEntries(statusEntries);
  const settingsDirty = entries.filter(({ path }) => path === "agent/settings.json" || path.startsWith("agent/settings.json"));
  if (settingsDirty.length > 0) {
    violations.push({
      code: "settings-dirty",
      message: "agent/settings.json has uncommitted changes",
    });
  }
  const otherDirty = entries.filter(({ path }) => !settingsDirty.some((s) => s.path === path));
  if (otherDirty.length > 0) {
    violations.push({
      code: "dirty-tree",
      message: `worktree is not clean: ${otherDirty.map(({ path }) => path).join(", ")}`,
    });
  }

  const ahead = Number.isInteger(origin.ahead) ? origin.ahead : 0;
  const behind = Number.isInteger(origin.behind) ? origin.behind : 0;
  if (ahead > 0) {
    violations.push({
      code: "unpushed-commits",
      message: `origin is behind local by ${ahead} commit(s)`,
    });
  }
  if (behind > 0) {
    violations.push({
      code: "behind-origin",
      message: `local is behind origin by ${behind} commit(s)`,
    });
  }

  return {
    ok: violations.length === 0,
    blocked: violations.length > 0,
    violations,
    dirty: entries.map(({ path }) => path),
    origin: { ahead, behind },
  };
}

// ── release phases ─────────────────────────────────────────────────────────

/**
 * May `phase` run now?
 *
 * Order is strict: push -> await-ci -> publish -> tag -> push-tags. Every
 * earlier phase must be completed, and publish/tag/push-tags additionally need
 * green CI for the expected SHA. Unknown CI is blocked exactly like pending.
 *
 * @param {object} input
 * @param {string} input.phase
 * @param {string[]} [input.completed] Phases already done, in order.
 * @param {{state?: string}|string|null} [input.ciState] Result of classifyCiState/pollCiState.
 */
export function releasePhaseAllowed({ phase, completed = [], ciState = null } = {}) {
  const index = RELEASE_PHASES.indexOf(phase);
  if (index < 0) {
    return {
      allowed: false,
      blocked: true,
      phase,
      reason: "unknown-phase",
      message: `${phase ?? "(none)"} is not a release phase`,
    };
  }

  const done = new Set(Array.isArray(completed) ? completed : []);
  const missing = RELEASE_PHASES.slice(0, index).filter((earlier) => !done.has(earlier));
  if (missing.length > 0) {
    return {
      allowed: false,
      blocked: true,
      phase,
      reason: "phase-order",
      message: `${phase} requires ${missing.join(" -> ")} first`,
    };
  }

  if (CI_GATED_PHASES.includes(phase)) {
    const state = typeof ciState === "string" ? ciState : (ciState?.state ?? "unknown");
    if (state !== "green") {
      return {
        allowed: false,
        blocked: true,
        phase,
        reason: `ci-${state}`,
        message: `${phase} requires green CI, current state is ${state}`,
      };
    }
  }

  return { allowed: true, blocked: false, phase, reason: "allowed", message: `${phase} is allowed` };
}
