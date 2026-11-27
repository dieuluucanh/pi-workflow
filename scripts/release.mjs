#!/usr/bin/env node
/**
 * release.mjs — local release tool for the four @dieulc/* Pi extensions.
 *
 * One command: verify -> version/changelog -> commit -> push -> await CI ->
 * publish -> tag -> push tags. Versions are independent per package; tags look
 * like `@dieulc/workflow@0.2.0`.
 *
 * CI is never queried in preflight: the release commit does not exist (or is
 * not pushed) yet, so its check runs cannot be green. Preflight is limited to
 * `checkWorkspace` + `checkVersionInvariants` (plus npm auth), the branch is
 * pushed first, and only then does the publish phase require green CI for the
 * manifest SHA (`releasePhaseAllowed`). Pending, unknown and red all block.
 *
 * Usage:
 *   npm run release                                  # interactive
 *   npm run release -- --dry-run                     # plan only, changes nothing
 *   npm run release -- --packages workflow --bump minor --yes
 *   npm run release -- --packages workflow --bump none --yes
 *   npm run release -- --continue                    # resume an interrupted run
 *
 * CI bypass: only `RELEASE_SKIP_CI=1` in the environment (with --yes) skips the
 * gate, and the transcript then says "CI gate bypassed by RELEASE_SKIP_CI".
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

import {
  CI_POLL_INTERVAL_MS,
  CI_POLL_TIMEOUT_MS,
  DEFAULT_REPO,
  checkVersionInvariants,
  checkWorkspace,
  createGhCheckRunsFetcher,
  pollCiState,
  releasePhaseAllowed,
  topChangelogVersion,
} from "./release-gate.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXT_DIR = path.join(ROOT, "agent", "extensions");
const NPM_SPEC =
  process.platform === "win32"
    ? { cmd: process.env.ComSpec || "cmd.exe", args: ["/d", "/s", "/c", "npm"] }
    : { cmd: "npm", args: [] };
const DEFAULT_BRANCH = "main";
const DEFAULT_NPM_USER = "dieulc";
const MIN_NODE_MAJOR = 22;
const BUMP_KINDS = ["patch", "minor", "major", "none"];
const CONVENTIONAL_RE = /^(\w+)(?:\(([^)]*)\))?(!)?:\s*(.*)$/;
const GROUPS = [
  ["feat", "Features"],
  ["fix", "Fixes"],
  ["perf", "Performance"],
  ["refactor", "Refactoring"],
  ["revert", "Reverts"],
  ["docs", "Documentation"],
  ["test", "Tests"],
  ["build", "Build"],
  ["ci", "CI"],
  ["style", "Style"],
  ["chore", "Chores"],
  ["other", "Other changes"],
];
const CHANGELOG_HEADER =
  "# Changelog\n\nAll notable changes to this package are documented in this file.\n";

// Explicit staging only: never `git add -A`, which once swept a machine-local
// agent/settings.json change into a release commit.
export const RELEASE_STAGE_BASENAMES = Object.freeze([
  "package.json",
  "package-lock.json",
  "CHANGELOG.md",
]);

/** The phrase an unattended (and audited) CI bypass must print. */
export const CI_BYPASS_MESSAGE = "CI gate bypassed by RELEASE_SKIP_CI";

const CI_CHECKS_URL = `https://github.com/${DEFAULT_REPO}/commit`;

class ReleaseError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}

// ── process helpers ────────────────────────────────────────────────────────

function run(cmd, args, cwd, { timeout = 600_000, capture = true } = {}) {
  return spawnSync(cmd, args, {
    cwd,
    encoding: "utf8",
    timeout,
    stdio: capture ? "pipe" : "inherit",
  });
}

function npm(args, cwd, opts = {}) {
  return run(NPM_SPEC.cmd, [...NPM_SPEC.args, ...args], cwd, opts);
}

function git(args, opts = {}) {
  return run("git", args, ROOT, opts);
}

function tail(res, lines = 12) {
  const text = `${res.stdout ?? ""}\n${res.stderr ?? ""}`.trim();
  return text.split(/\r?\n/).slice(-lines).join("\n");
}

function must(res, what) {
  if (res.status !== 0) throw new ReleaseError(`${what} failed:\n${tail(res)}`);
  return res;
}

function out(res) {
  return String(res.stdout ?? "").trim();
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    throw new ReleaseError(
      `cannot read ${file}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// ── arguments & discovery ──────────────────────────────────────────────────

// npm parses `npm run release <flags>` itself: only arguments after `--` reach
// the script. When npm swallows one of our flags it exports it into the child
// environment as npm_config_<name> instead, and the script would silently fall
// back to its default mode — that is how a `--continue` resume once turned into
// an interactive bump prompt. Detect it and say exactly what to type.
const NPM_CONSUMED_FLAGS = [
  "continue",
  "packages",
  "bump",
  "dry_run",
  "yes",
  "branch",
  "npm_user",
];

function npmConsumedFlags(argv = process.argv.slice(2)) {
  const hits = [];
  for (const name of NPM_CONSUMED_FLAGS) {
    const value = process.env[`npm_config_${name}`];
    // npm sets every config it knows, so only a value that actually came from
    // the command line counts (a plain "false"/"0" is the default).
    if (!value || /^(false|0|undefined|null)$/i.test(value)) continue;
    const flag = `--${name.replace(/_/g, "-")}`;
    const passed =
      argv.includes(flag) || (name === "yes" && argv.includes("-y"));
    if (!passed) hits.push(flag);
  }
  // `--no-push` is the one flag npm normalizes into `push=false`.
  if (
    process.env.npm_config_push === "false" &&
    !process.argv.slice(2).includes("--no-push")
  ) {
    hits.push("--no-push");
  }
  return hits;
}

function parseArgs(argv) {
  const opts = {
    packages: null,
    bump: null,
    dryRun: false,
    continue: false,
    noPush: false,
    branch: DEFAULT_BRANCH,
    npmUser: process.env.RELEASE_NPM_USER || DEFAULT_NPM_USER,
    yes: false,
    help: false,
    env: process.env,
    ciIntervalMs: undefined,
    ciTimeoutMs: undefined,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--packages")
      opts.packages = String(argv[++i] ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    else if (arg === "--bump") opts.bump = String(argv[++i] ?? "").trim();
    else if (arg === "--branch") opts.branch = String(argv[++i] ?? "").trim();
    else if (arg === "--npm-user")
      opts.npmUser = String(argv[++i] ?? "").trim();
    else if (arg === "--dry-run") opts.dryRun = true;
    else if (arg === "--continue") opts.continue = true;
    else if (arg === "--no-push") opts.noPush = true;
    else if (arg === "--yes" || arg === "-y") opts.yes = true;
    else if (arg === "--help" || arg === "-h") opts.help = true;
    else if (arg === "--skip-ci") {
      // Deliberately not a flag: bypassing the CI gate must be an explicit,
      // auditable environment decision, not something typed after `--`.
      throw new ReleaseError(
        "--skip-ci is not supported — the CI gate only yields to RELEASE_SKIP_CI=1 (with --yes)",
      );
    } else throw new ReleaseError(`unknown argument: ${arg}`);
  }
  if (opts.bump && !BUMP_KINDS.includes(opts.bump)) {
    throw new ReleaseError(
      `--bump must be one of ${BUMP_KINDS.join("|")} (got ${opts.bump})`,
    );
  }
  if (opts.yes && (!opts.packages || !opts.bump) && !opts.continue) {
    throw new ReleaseError(
      "--yes requires --packages and --bump (or use --continue)",
    );
  }
  return opts;
}

function discoverPackages() {
  return fs
    .readdirSync(EXT_DIR, { withFileTypes: true })
    .filter(
      (e) =>
        e.isDirectory() &&
        fs.existsSync(path.join(EXT_DIR, e.name, "package.json")),
    )
    .map((e) => {
      const dir = path.join(EXT_DIR, e.name);
      const pkg = readJson(path.join(dir, "package.json"));
      return { short: e.name, dir, name: pkg.name, version: pkg.version, pkg };
    })
    .sort((a, b) => a.short.localeCompare(b.short));
}

function selectPackages(all, filter) {
  if (!filter) return all;
  const unknown = filter.filter((f) => !all.some((p) => p.short === f));
  if (unknown.length) {
    throw new ReleaseError(
      `unknown package(s): ${unknown.join(", ")} (known: ${all.map((p) => p.short).join(", ")})`,
    );
  }
  return all.filter((p) => filter.includes(p.short));
}

// ── versions, tags, registry ───────────────────────────────────────────────

function bumpVersion(version, kind) {
  if (kind === "none") return version;
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/.exec(version);
  if (!match)
    throw new ReleaseError(`cannot bump non-semver version "${version}"`);
  let major = Number(match[1]);
  let minor = Number(match[2]);
  let patch = Number(match[3]);
  if (kind === "patch") patch += 1;
  else if (kind === "minor") {
    minor += 1;
    patch = 0;
  } else {
    major += 1;
    minor = 0;
    patch = 0;
  }
  return `${major}.${minor}.${patch}`;
}

function tagFor(name, version) {
  return `${name}@${version}`;
}

function tagExists(tag) {
  return git(["rev-parse", "-q", "--verify", `refs/tags/${tag}`]).status === 0;
}

// Three distinct answers, never two. `npm view <name>@<version> version` exits 0
// with the version when it exists; a missing version and a fully unpublished
// package name both come back as E404 (the latter with "Unpublished on …");
// everything else (offline, 5xx, auth, rate limit, empty output) is *unknown*.
// "unknown" must never be read as "not published": a wrong "not published"
// leads to a doomed publish, a wrong "published" to a silently skipped release.
function classifyNpmView(res) {
  const text = `${res?.stdout ?? ""}\n${res?.stderr ?? ""}`;
  if (res?.status === 0) return out(res).length > 0 ? "published" : "unknown";
  if (/E404|404 Not Found|Unpublished on/i.test(text)) return "absent";
  return "unknown";
}

function publishState(name, version) {
  return classifyNpmView(npm(["view", `${name}@${version}`, "version"], ROOT));
}

// The interactive picker and planTargets ask about the same package; one
// registry round-trip per name@version is enough for a whole run.
function memoizedProbe(probe = publishState) {
  const cache = new Map();
  return (name, version) => {
    const key = `${name}@${version}`;
    if (!cache.has(key)) cache.set(key, probe(name, version));
    return cache.get(key);
  };
}

function lastTagFor(name) {
  const res = git(["tag", "-l", `${name}@*`, "--sort=-v:refname"]);
  if (res.status !== 0) return null;
  const tags = out(res).split(/\r?\n/).filter(Boolean);
  return tags[0] ?? null;
}

// ── changelog ──────────────────────────────────────────────────────────────

function commitsFor(dir, fromTag) {
  const relative = path.relative(ROOT, dir).split(path.sep).join("/");
  const args = ["log", "--no-merges", "--pretty=format:%h\t%s"];
  if (fromTag) args.push(`${fromTag}..HEAD`);
  else args.push("HEAD");
  args.push("--", relative);
  const res = git(args);
  if (res.status !== 0) return [];
  return out(res)
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const tab = line.indexOf("\t");
      return { hash: line.slice(0, tab), subject: line.slice(tab + 1) };
    })
    .filter((c) => !/^chore\(release\)/.test(c.subject));
}

function initialSection(version, date) {
  return `## [${version}] - ${date}\n\nInitial release.`;
}

function changelogSection(version, commits, date) {
  const buckets = new Map(GROUPS.map(([key]) => [key, []]));
  for (const commit of commits) {
    const match = CONVENTIONAL_RE.exec(commit.subject);
    const type = match ? match[1].toLowerCase() : "other";
    const text = match ? match[4] || commit.subject : commit.subject;
    const key = buckets.has(type) ? type : "other";
    buckets.get(key).push(`- ${text} (${commit.hash})`);
  }
  const lines = [`## [${version}] - ${date}`, ""];
  let wrote = false;
  for (const [key, title] of GROUPS) {
    const items = buckets.get(key);
    if (!items.length) continue;
    wrote = true;
    lines.push(`### ${title}`, "", ...items, "");
  }
  if (!wrote) lines.push("- No user-facing changes recorded.", "");
  return lines.join("\n").trimEnd();
}

const SECTION_VERSION_RE = /^##\s*\[([^\]]+)\]/;

// Git checks these files out with CRLF on Windows (`core.autocrlf=true` in this
// repo, no .gitattributes), while this script writes LF. Comparing raw text
// against an LF header therefore failed on every second release and prepended a
// second "# Changelog" header — normalize before any comparison or write.
function normalizeEol(text) {
  return String(text ?? "")
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n");
}

function sectionVersion(section) {
  const match = SECTION_VERSION_RE.exec(String(section).trimStart());
  return match ? match[1] : null;
}

function documentsVersion(text, version) {
  return normalizeEol(text)
    .split("\n")
    .some((line) => {
      const match = SECTION_VERSION_RE.exec(line.trim());
      return match ? match[1] === version : false;
    });
}

/** Pure: the new changelog body with `section` on top of `existingText`. */
function composeChangelog(existingText, section) {
  // Leading blank lines (and a BOM) must not defeat the header check, or the
  // header would be prepended a second time.
  let existing = normalizeEol(existingText).replace(/^\n+/, "");
  if (existing.startsWith(CHANGELOG_HEADER))
    existing = existing.slice(CHANGELOG_HEADER.length);
  const rest = existing.replace(/^\n+/, "");
  return `${CHANGELOG_HEADER}\n${section}\n${rest ? `\n${rest.trimEnd()}\n` : "\n"}`;
}

function prependChangelog(file, section) {
  const version = sectionVersion(section);
  const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;

  // Idempotent: a re-run (or `--continue` after an aborted release) must not add
  // a second section for the same version — only the date would differ.
  if (version && existing !== null && documentsVersion(existing, version)) {
    console.log(
      `  ↺ ${path.relative(ROOT, file)} already documents ${version} — leaving it unchanged.`,
    );
    return false;
  }

  fs.writeFileSync(file, composeChangelog(existing ?? "", section));
  return true;
}

function writeVersion(dir, version) {
  const file = path.join(dir, "package.json");
  const source = fs.readFileSync(file, "utf8");
  const versionField = /^(\s*"version":\s*)"[^"]*"/m;
  // `--bump none` (the documented first-publish / resume path) publishes the
  // version already in the manifest, so the file is legitimately unchanged.
  // Only a missing version field is an error.
  if (!versionField.test(source)) {
    throw new ReleaseError(`could not find the version field in ${file}`);
  }
  const updated = source.replace(versionField, `$1"${version}"`);
  if (updated === source) return false;
  fs.writeFileSync(file, updated);
  return true;
}

// ── prompts ────────────────────────────────────────────────────────────────

async function ask(rl, question) {
  return (await rl.question(question)).trim();
}

function stateNote(state) {
  if (state === "published") return "already on npm";
  if (state === "absent") return "not on npm";
  return "publish state unknown";
}

async function promptPackages(rl, all, probe) {
  console.log("\nPackages:");
  all.forEach((p, i) => {
    console.log(
      `  ${i + 1}) ${p.short.padEnd(18)} ${p.name} @ ${p.version}  (${stateNote(
        probe(p.name, p.version),
      )})`,
    );
  });
  const answer = await ask(
    rl,
    '\nSelect packages (numbers, comma-separated; "all"; or "none"): ',
  );
  if (answer === "all") return all;
  if (!answer || answer === "none") return [];
  const picked = answer
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n >= 1 && n <= all.length);
  return all.filter((_, i) => picked.includes(i + 1));
}

async function promptBump(rl, pkg, probe) {
  const state = probe(pkg.name, pkg.version);
  // Pressing Enter on an already-published package means "release nothing this
  // time": skipping is the honest default, not a pointless patch bump. An
  // unknown publish state keeps the old default, and is reported as blocked.
  const fallback = state === "published" ? "none" : "patch";
  for (;;) {
    const answer = await ask(
      rl,
      `  Bump for ${pkg.short} (current ${pkg.version}, ${stateNote(state)}) [patch/minor/major/none] (${fallback}): `,
    );
    const kind = answer || fallback;
    if (BUMP_KINDS.includes(kind)) return kind;
    console.log(`    ✗ expected one of ${BUMP_KINDS.join(", ")}`);
  }
}

async function promptConfirm(rl, question) {
  const answer = (await ask(rl, question)).toLowerCase();
  return answer === "y" || answer === "yes";
}

// ── preflight ──────────────────────────────────────────────────────────────

function headSha() {
  return out(must(git(["rev-parse", "HEAD"]), "git rev-parse HEAD"));
}

function statusEntries() {
  const res = must(
    git(["status", "--porcelain=v1", "--untracked-files=all"]),
    "git status",
  );
  return out(res).split(/\r?\n/).filter(Boolean);
}

function originDrift(branch) {
  // `--left-right --count HEAD...origin/<branch>` prints "<ahead>\t<behind>":
  // commits the local branch has that origin lacks, then the reverse.
  const res = must(
    git(["rev-list", "--left-right", "--count", `HEAD...origin/${branch}`]),
    "git rev-list",
  );
  const [ahead, behind] = out(res)
    .split(/\s+/)
    .filter(Boolean)
    .map((value) => Number(value));
  return {
    ahead: Number.isInteger(ahead) ? ahead : 0,
    behind: Number.isInteger(behind) ? behind : 0,
  };
}

/**
 * Local preflight: Node version, then `checkWorkspace` (branch, clean tree,
 * unmodified agent/settings.json, origin drift), then npm auth.
 *
 * Deliberately no CI query. The release commit does not exist yet (or is not
 * pushed yet), so requiring green CI here would deadlock every release. CI is
 * consulted once, after the push, before the publish phase.
 */
function preflight(opts) {
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  if (nodeMajor < MIN_NODE_MAJOR) {
    throw new ReleaseError(
      `Node >= ${MIN_NODE_MAJOR} required (running ${process.versions.node})`,
    );
  }

  must(
    git(["fetch", "origin", opts.branch]),
    `git fetch origin ${opts.branch}`,
  );
  const branch = out(
    must(git(["rev-parse", "--abbrev-ref", "HEAD"]), "git rev-parse"),
  );

  const workspace = checkWorkspace({
    branch,
    expectedBranch: opts.branch,
    statusEntries: statusEntries(),
    origin: originDrift(opts.branch),
  });
  if (!workspace.ok) {
    throw new ReleaseError(
      `release preflight blocked:\n  ${workspace.violations
        .map((violation) => violation.message)
        .join("\n  ")}`,
    );
  }

  if (opts.dryRun) {
    console.log(
      `Preflight ok — branch ${branch} (dry run, npm auth not checked)\n`,
    );
    return;
  }

  const who = npm(["whoami"], ROOT);
  const user = out(who);
  if (who.status !== 0 || user !== opts.npmUser) {
    throw new ReleaseError(
      `npm auth check failed: expected user "${opts.npmUser}", got "${user || "not logged in"}"`,
    );
  }
  console.log(`Preflight ok — branch ${branch}, npm user ${user}\n`);
}

// ── fresh dependencies ─────────────────────────────────────────────────────

/**
 * Pure freshness decision for one package. A `node_modules` tree older than
 * `package-lock.json` is stale: CI runs a fresh `npm ci`, so a release must not
 * be verified against ambient dependencies.
 */
export function dependencyFreshness({
  lockfileMtimeMs = null,
  installedMtimeMs = null,
} = {}) {
  if (lockfileMtimeMs === null) {
    return { fresh: true, reason: "no package-lock.json" };
  }
  if (installedMtimeMs === null) {
    return {
      fresh: false,
      reason: "node_modules/.package-lock.json is missing — run npm ci",
    };
  }
  if (installedMtimeMs < lockfileMtimeMs) {
    return {
      fresh: false,
      reason: "node_modules predates package-lock.json — run npm ci",
    };
  }
  return {
    fresh: true,
    reason: "node_modules was installed after the lockfile",
  };
}

function mtimeMs(file) {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return null;
  }
}

function assertFreshDependencies(targets) {
  const stale = [];
  for (const target of targets) {
    const state = dependencyFreshness({
      lockfileMtimeMs: mtimeMs(path.join(target.dir, "package-lock.json")),
      installedMtimeMs: mtimeMs(
        path.join(target.dir, "node_modules", ".package-lock.json"),
      ),
    });
    if (!state.fresh) stale.push(`${target.short}: ${state.reason}`);
  }
  if (stale.length) {
    throw new ReleaseError(
      "release dependencies are stale — refusing to release from an ambient node_modules:\n" +
        `  ${stale.join("\n  ")}\n` +
        "  Use a fresh worktree and `npm ci` in each package before releasing.",
    );
  }
  console.log("Dependencies fresh — node_modules matches package-lock.json\n");
}

// ── version invariants ─────────────────────────────────────────────────────

// `npm view <name> versions time --json` answers both invariant questions in
// one round-trip. A failed query fails closed outside --dry-run: an unknown
// registry must never be read as "nothing published".
function registryVersions(name, opts) {
  const cache = opts.registryCache ?? new Map();
  opts.registryCache = cache;
  if (cache.has(name)) return cache.get(name);

  const res = npm(["view", name, "versions", "time", "--json"], ROOT);
  let payload = null;
  if (res.status === 0) {
    try {
      payload = JSON.parse(out(res));
    } catch {
      payload = null;
    }
  }
  if (payload === null) {
    if (opts.dryRun) {
      console.log(
        `  ⚠ registry unavailable for ${name} — invariants checked without published versions.`,
      );
      cache.set(name, []);
      return [];
    }
    throw new ReleaseError(
      `cannot read registry versions for ${name} (needed for tag invariants):\n${tail(res)}`,
    );
  }

  const versions = Array.isArray(payload)
    ? payload
    : Array.isArray(payload.versions)
      ? payload.versions
      : [];
  const times =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload.time ?? {})
      : {};
  const normalized = versions.map((version) => ({
    version,
    publishedAt: typeof times[version] === "string" ? times[version] : null,
  }));
  cache.set(name, normalized);
  return normalized;
}

function packageTags(target) {
  const listed = git(["tag", "-l", `${target.name}@*`]);
  if (listed.status !== 0) return [];
  const relative = path.relative(ROOT, target.dir).split(path.sep).join("/");
  return out(listed)
    .split(/\r?\n/)
    .filter(Boolean)
    .map((name) => {
      // An annotated tag is a tag object; a lightweight tag points at a commit.
      const annotated = out(git(["cat-file", "-t", name])) === "tag";
      const blob = git(["show", `${name}:${relative}/package.json`]);
      let manifestVersion = null;
      if (blob.status === 0) {
        try {
          manifestVersion = JSON.parse(out(blob)).version ?? null;
        } catch {
          manifestVersion = null;
        }
      }
      return { name, annotated, manifestVersion };
    });
}

/**
 * `checkVersionInvariants` for the packages actually being released: changelog
 * top heading vs manifest, every published version tagged with an annotated tag
 * whose tagged package.json matches, and no new published-but-untagged version.
 */
function assertVersionInvariants(targets, opts) {
  const packages = targets.map((target) => {
    const changelogFile = path.join(target.dir, "CHANGELOG.md");
    return {
      name: target.name,
      manifestVersion: readJson(path.join(target.dir, "package.json")).version,
      changelog: fs.existsSync(changelogFile)
        ? fs.readFileSync(changelogFile, "utf8")
        : "",
      published: registryVersions(target.name, opts),
      tags: packageTags(target),
    };
  });

  const result = checkVersionInvariants({ packages });
  if (!result.ok) {
    throw new ReleaseError(
      `release preflight blocked by version invariants:\n  ${result.violations
        .map((violation) => violation.message)
        .join("\n  ")}`,
    );
  }
  console.log(
    `Version invariants ok — ${packages
      .map((pkg) => `${pkg.name}@${pkg.manifestVersion}`)
      .join(", ")}\n`,
  );
}

// The release text is written immediately before the commit, so a mismatch can
// only come from a bad write: catch it locally instead of after a push.
function assertWrittenReleaseText(targets) {
  const problems = [];
  for (const target of targets) {
    const manifestVersion = readJson(path.join(target.dir, "package.json"))
      .version;
    const changelogFile = path.join(target.dir, "CHANGELOG.md");
    const changelog = fs.existsSync(changelogFile)
      ? fs.readFileSync(changelogFile, "utf8")
      : "";
    const top = topChangelogVersion(changelog);
    if (top !== manifestVersion) {
      problems.push(
        `${target.name}: changelog top heading is ${top ?? "(none)"}, manifest is ${manifestVersion}`,
      );
    }
  }
  if (problems.length) {
    throw new ReleaseError(
      `release text is inconsistent after writing:\n  ${problems.join("\n  ")}`,
    );
  }
}

// ── CI gate ────────────────────────────────────────────────────────────────

/**
 * Read the only supported CI bypass: `RELEASE_SKIP_CI=1` in the environment.
 *
 * Any other value (including `true`) is reported and ignored; a `--skip-ci`
 * flag is rejected outright. The bypass also requires `--yes`, so an
 * unattended run opts in twice and the transcript always records
 * "CI gate bypassed by RELEASE_SKIP_CI".
 */
export function ciBypassRequested({ env = {}, yes = false } = {}) {
  const raw = env?.RELEASE_SKIP_CI;
  if (raw === undefined || raw === null || raw === "") {
    return { requested: false, allowed: false, message: null };
  }
  if (raw !== "1") {
    return {
      requested: false,
      allowed: false,
      message: `RELEASE_SKIP_CI=${raw} is ignored — only RELEASE_SKIP_CI=1 bypasses the CI gate`,
    };
  }
  if (!yes) {
    return {
      requested: true,
      allowed: false,
      message:
        "RELEASE_SKIP_CI=1 requires --yes — refusing to skip the CI gate unattended",
    };
  }
  return { requested: true, allowed: true, message: CI_BYPASS_MESSAGE };
}

/**
 * Pure phase decision: strict order push -> await-ci -> publish -> tag ->
 * push-tags, with the CI gate applied to publish/tag/push-tags.
 *
 * `bypass` is only ever true for an explicit `RELEASE_SKIP_CI=1`; it relaxes the
 * CI requirement, never the phase order, and the returned message is the
 * phrase the release transcript must print.
 */
export function gatePhase({
  phase,
  completed = [],
  ciState = null,
  bypass = false,
} = {}) {
  // Order and phase names are checked even when the CI gate is bypassed.
  const ordered = releasePhaseAllowed({
    phase,
    completed,
    ciState: { state: "green" },
  });
  if (!ordered.allowed) return { ...ordered, bypassed: false };

  if (bypass) {
    return {
      allowed: true,
      blocked: false,
      phase,
      reason: "ci-bypassed",
      message: CI_BYPASS_MESSAGE,
      bypassed: true,
    };
  }

  const decision = releasePhaseAllowed({ phase, completed, ciState });
  return { ...decision, bypassed: false };
}

function ciEnvNumber(opts, name, fallback) {
  const raw = opts.env?.[name];
  if (raw === undefined || raw === null || raw === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

const gh = (cmd, args) => run(cmd, args, ROOT, { timeout: 120_000 });

async function awaitCiState(sha, opts) {
  console.log(
    `\nAwaiting CI for ${sha} — verify (ubuntu-latest) and verify (windows-latest) must both succeed …`,
  );
  const fetchCheckRuns = createGhCheckRunsFetcher({ run: gh, env: opts.env });
  const state = await pollCiState({
    fetchCheckRuns,
    sha,
    intervalMs: ciEnvNumber(
      opts,
      "RELEASE_CI_INTERVAL_MS",
      CI_POLL_INTERVAL_MS,
    ),
    timeoutMs: ciEnvNumber(opts, "RELEASE_CI_TIMEOUT_MS", CI_POLL_TIMEOUT_MS),
  });
  console.log(`  ${state.message}`);
  if (state.blocked) console.log(`  checks: ${CI_CHECKS_URL}/${sha}/checks`);
  return state;
}

// ── release phases ─────────────────────────────────────────────────────────

function verify(packages) {
  const list = packages.map((p) => p.short).join(",");
  console.log(`Verifying ${list} …`);
  const res = run(
    process.execPath,
    [path.join(ROOT, "scripts", "verify-packages.mjs"), "--packages", list],
    ROOT,
    {
      capture: false,
    },
  );
  if (res.status !== 0)
    throw new ReleaseError("verification failed — nothing was changed");
}

/**
 * The release decision for one package, as a pure function of the bump kind and
 * the registry state — no npm, no git, so it is unit-testable.
 *
 *   published + "none"                → skip        (nothing to do: already released)
 *   published + patch|minor|major     → skip        (flagged: that version is taken,
 *                                                   the manifest is probably behind)
 *   absent                            → publish
 *   unknown                           → blocked     (never publish, never skip blindly)
 *
 * Only `skip` with tagEligible is a clean outcome; `blocked` and a bump
 * collision are reported as problems at the end of the run.
 */
function classifyTargetState({ kind, nextVersion, state }) {
  if (state === "unknown") {
    return {
      status: "blocked",
      reason: "registry query failed",
      tagEligible: false,
    };
  }
  if (state === "published") {
    return kind === "none"
      ? {
          status: "skip",
          reason: `already on npm at ${nextVersion} — no bump requested`,
          tagEligible: true,
        }
      : {
          status: "skip",
          reason: `${nextVersion} is already on npm — bump further`,
          tagEligible: false,
        };
  }
  return { status: "publish", reason: "not on npm", tagEligible: true };
}

function decideTarget({
  version,
  kind,
  state,
  nextVersion = bumpVersion(version, kind),
}) {
  return { nextVersion, ...classifyTargetState({ kind, nextVersion, state }) };
}

function planTargets(packages, opts, probe = publishState) {
  const targets = [];
  for (const pkg of packages) {
    // Interactive runs set pkg.bump per package; --bump overrides all of them.
    const kind = opts.continue ? "none" : (opts.bump ?? pkg.bump ?? "none");
    const nextVersion = bumpVersion(pkg.version, kind);
    const decision = decideTarget({
      version: pkg.version,
      kind,
      nextVersion,
      state: probe(pkg.name, nextVersion),
    });
    targets.push({
      ...pkg,
      bumpKind: kind,
      nextVersion,
      status: decision.status,
      reason: decision.reason,
      tagEligible: decision.tagEligible,
      skipPublish: decision.status !== "publish",
      tag: tagFor(pkg.name, nextVersion),
    });
  }
  return targets;
}

function prepareChangelogs(targets, opts) {
  const date = new Date().toISOString().slice(0, 10);
  for (const target of targets) {
    if (opts.continue) continue;
    // No previous tag means this is the package's first publish: a curated
    // "Initial release." line beats replaying the whole path history.
    const fromTag = lastTagFor(target.name);
    target.section = fromTag
      ? changelogSection(
          target.nextVersion,
          commitsFor(target.dir, fromTag),
          date,
        )
      : initialSection(target.nextVersion, date);
    if (!opts.dryRun) {
      prependChangelog(path.join(target.dir, "CHANGELOG.md"), target.section);
      writeVersion(target.dir, target.nextVersion);
    }
  }
}

/**
 * Explicit staging paths for one package directory: `package.json`,
 * `package-lock.json`, `CHANGELOG.md` — nothing else, ever.
 *
 * `exists(name)` is injected so the rule is testable without a filesystem.
 */
export function stagePathsFor({
  dir,
  root = ROOT,
  exists = () => true,
} = {}) {
  const relative = path.relative(root, dir).split(path.sep).join("/");
  if (!relative || relative.startsWith("..")) {
    throw new ReleaseError(
      `package directory ${dir} is not inside the repository (${root})`,
    );
  }
  return RELEASE_STAGE_BASENAMES.map((name) => `${relative}/${name}`).filter(
    (candidate) => exists(path.basename(candidate)),
  );
}

/**
 * The SHA the CI gate is keyed on. A commit that changed nothing is not an
 * error: `--bump none` with committed notes legitimately finds the release text
 * already recorded, so the current HEAD is the manifest SHA and must be green.
 */
export function resolveReleaseSha({ committed = false, head = null } = {}) {
  const sha = typeof head === "string" ? head.trim() : "";
  if (!/^[0-9a-f]{40}$/i.test(sha)) {
    throw new ReleaseError(
      `cannot resolve the release commit SHA (got ${JSON.stringify(head)})`,
    );
  }
  return { sha, committed: Boolean(committed) };
}

function commitRelease(targets) {
  const summary = targets.map((t) => `${t.name}@${t.nextVersion}`).join(", ");
  const paths = targets.flatMap((target) =>
    stagePathsFor({
      dir: target.dir,
      exists: (name) => fs.existsSync(path.join(target.dir, name)),
    }),
  );
  if (paths.length) must(git(["add", "--", ...paths]), "git add");

  // A resumed release (--continue after an interrupted publish) finds the
  // manifests and changelogs already committed by the first run — the index is
  // then empty and the current HEAD is what carries the release text.
  const staged = paths.length
    ? out(must(git(["diff", "--cached", "--name-only"]), "git diff --cached"))
    : "";
  if (!staged) {
    console.log(
      `Nothing to commit — ${summary} is already recorded; releasing the current HEAD.`,
    );
    return resolveReleaseSha({ committed: false, head: headSha() });
  }

  must(git(["commit", "-m", `chore(release): ${summary}`]), "git commit");
  console.log(`Committed: chore(release): ${summary}`);
  return resolveReleaseSha({ committed: true, head: headSha() });
}

function publish(targets) {
  // Attempt every target: one package being unpublishable must not block the
  // others' tags/pushes (npm's 24h name-reuse block, transient 403s, OTP
  // timeouts…). Failures are reported at the end with a --continue hint.
  //
  // Publishable targets are published; already-published ones are skipped but
  // stay in `done` when their manifest version is what is on npm (that is how a
  // published-but-untagged version gets its tag repaired); targets whose
  // publish state is unknown are never touched — the caller reports them.
  const published = [];
  const done = [];
  const failed = [];
  let authHinted = false;
  for (const target of targets) {
    if (target.status === "blocked") continue;
    if (target.skipPublish) {
      console.log(
        `Already on npm, skipping publish: ${target.name}@${target.nextVersion}`,
      );
      if (target.tagEligible) done.push(target);
      else
        console.log(
          `  ↳ no tag created for ${target.tag} — that version is not what the manifest points at`,
        );
      continue;
    }
    console.log(`\nPublishing ${target.name}@${target.nextVersion} …`);
    const res = npm(["publish"], target.dir, { capture: false });
    if (res.status === 0) {
      published.push(target);
      done.push(target);
    } else {
      console.log(
        `✗ npm publish failed for ${target.name}@${target.nextVersion}`,
      );
      if (!authHinted) {
        authHinted = true;
        // npm does not fall back to an interactive OTP prompt when a token is
        // configured, so a read-only / non-bypass granular token in ~/.npmrc
        // always fails this way — the credential, not the package, is at fault.
        console.log(
          '  ↳ if npm reported 403 "Two-factor authentication or granular access token\n' +
            '    with bypass 2fa enabled is required": the configured npm auth cannot\n' +
            '    write. Create a granular token with "Bypass 2FA" enabled at\n' +
            "    npmjs.com → Access Tokens, or log in interactively (removing the token)\n" +
            "    and retry with an OTP. See docs/publishing.md → Troubleshooting.",
        );
      }
      failed.push(target);
    }
  }
  return { published, done, failed };
}

function createTags(targets) {
  const tags = [];
  for (const target of targets) {
    if (tagExists(target.tag)) {
      console.log(`Tag already exists, skipping: ${target.tag}`);
    } else {
      must(
        git(["tag", "-a", target.tag, "-m", target.tag]),
        `git tag ${target.tag}`,
      );
      console.log(`Tagged ${target.tag}`);
    }
    tags.push(target.tag);
  }
  return tags;
}

// Advisory only. pi.dev builds its gallery catalog from npm's search results
// for the `pi-package` keyword, and it ingests only a bounded, score-ranked
// slice of them (npm's search API rolls over past `from=5000`), so a published
// package can stay out of the catalog for a long time — republishing does not
// reliably change it. Never fail a completed release over it.
function galleryCheck(targets) {
  if (!targets.length) return;
  console.log("\npi.dev gallery:");
  run(
    process.execPath,
    [
      path.join(ROOT, "scripts", "check-gallery.mjs"),
      "--packages",
      targets.map((t) => t.short).join(","),
      "--warn-only",
    ],
    ROOT,
    { capture: false },
  );
  console.log(
    "Catalog membership is decided by pi.dev's ingest of npm's search results, not by\n" +
      "publishing — if a package is missing above, see docs/publishing.md\n" +
      "(“When a package does not show up”) and docs/gallery-membership.md, then re-check with:\n" +
      "  npm run gallery -- --packages <short> --diagnose",
  );
}

// ── plan reporting ─────────────────────────────────────────────────────────

function actionLabel(target) {
  return target.status === "publish"
    ? `publish (${target.reason})`
    : `${target.status} (${target.reason})`;
}

function printPlan(targets) {
  console.log("\nPlan:");
  for (const t of targets) {
    console.log(
      `  ${t.name.padEnd(28)} ${t.version} → ${t.nextVersion}   ${actionLabel(t)}`,
    );
  }
}

// ── main ───────────────────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(
      [
        "Usage: npm run release -- [options]",
        "",
        "  --packages a,b     packages to release (default: interactive)",
        "  --bump kind        patch | minor | major | none (default: interactive)",
        "  --dry-run          verify and print the plan; change nothing",
        "  --continue         resume: publish what is missing, tag and push the rest",
        "  --no-push          stop before git push (publishing then needs RELEASE_SKIP_CI=1)",
        "  --branch name      branch to release from (default: main)",
        "  --npm-user name    required npm user (default: dieulc)",
        "  --yes, -y          non-interactive (requires --packages and --bump)",
        "",
        "Flags must follow `--`: `npm run release -- --continue`.",
        "Preflight checks the workspace (branch, clean tree, agent/settings.json,",
        "origin) and the version/changelog/tag/registry invariants, then verifies",
        "the package. It never queries CI: the release commit is not pushed yet.",
        "After the push the script polls the verify matrix (ubuntu-latest AND",
        "windows-latest) for that exact SHA and only then publishes, tags, and",
        "pushes tags. Pending, unknown or red CI blocks publish/tag.",
        "Staging is explicit: package.json, package-lock.json, CHANGELOG.md.",
        "CI bypass: set RELEASE_SKIP_CI=1 and pass --yes. There is no --skip-ci.",
        "A package whose target version is already on npm is skipped, never fatal:",
        "  --bump none + published                  → skip (exit 0)",
        "  patch|minor|major onto a published version → skip, exit 1 at the end",
        "  registry unreachable                     → blocked, nothing published, exit 1",
      ].join("\n"),
    );
    return;
  }

  // Any real release without --yes must be confirmed interactively. Failing
  // here (before preflight) keeps unattended invocations from touching git,
  // the registry, or the manifests at all.
  const interactive = !opts.yes && !opts.dryRun && !opts.continue;

  const consumed = npmConsumedFlags();
  if (consumed.length) {
    throw new ReleaseError(
      `${consumed.join(", ")} reached npm, not this script (npm exports them as npm_config_*).\n` +
        '  npm only forwards arguments after "--"\n' +
        `  Re-run: npm run release -- ${consumed.join(" ")}`,
      2,
    );
  }

  if (interactive && !process.stdin.isTTY) {
    throw new ReleaseError(
      "stdin is not a TTY — pass --yes for an unattended release, or --dry-run to preview",
    );
  }

  preflight(opts);

  // One registry round-trip per name@version for the whole run: the interactive
  // prompts, the printed plan and the publish decision share one answer.
  const probe = memoizedProbe();

  const all = discoverPackages();
  let selected = selectPackages(all, opts.packages);
  let targets = null;

  if (opts.continue) {
    if (!selected.length) selected = all;
    console.log("Continue mode: publishing current package.json versions.\n");
  } else if (opts.dryRun || opts.yes) {
    // Unattended: --yes was validated above; --dry-run changes nothing anyway.
  } else {
    // Any real release without --yes is confirmed interactively, even when
    // --packages/--bump were supplied. Publishing must always be explicit.
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    try {
      if (!selected.length) {
        selected = await promptPackages(rl, all, probe);
        if (!selected.length) {
          console.log("Nothing selected — nothing to do.");
          return;
        }
      }
      if (!opts.bump) {
        console.log("\nBump type:");
        for (const pkg of selected) {
          pkg.bump = await promptBump(rl, pkg, probe);
        }
      }
      // The registry state is already known (and memoized) here, so confirm
      // against the real plan — including what will be skipped and why.
      targets = planTargets(selected, opts, probe);
      printPlan(targets);
      if (
        !(await promptConfirm(
          rl,
          "\nProceed with verify, publish, tag and push? (y/N): ",
        ))
      ) {
        console.log("Aborted.");
        return;
      }
    } finally {
      rl.close();
    }
  }

  // Non-interactive: apply a single --bump to every selected package.
  if (opts.bump && !opts.continue) {
    for (const pkg of selected) pkg.bump = opts.bump;
  }
  if (!targets) {
    if (!selected.length) {
      console.log("Nothing selected — nothing to do.");
      return;
    }
    targets = planTargets(selected, opts, probe);
    printPlan(targets);
  }

  const publishable = targets.filter((t) => t.status === "publish");
  const skipped = targets.filter((t) => t.status === "skip");
  // A skip whose tag is not eligible is a bump collision: the version it would
  // be tagged as is already on npm, but it is not what the manifest points at.
  const collisions = skipped.filter((t) => !t.tagEligible);
  const blocked = targets.filter((t) => t.status === "blocked");

  if (!publishable.length) {
    const notes = [];
    if (skipped.length) notes.push(`${skipped.length} already on npm`);
    if (blocked.length)
      notes.push(`${blocked.length} with an unknown publish state`);
    console.log(`\nNothing to publish — ${notes.join(", ")}.`);
    if (skipped.length)
      console.log(
        "Tags for already-published versions are still checked and repaired.",
      );
  }

  // The CI bypass is an environment decision, so it is resolved (and printed)
  // with the plan, before anything is written. `--skip-ci` is not a flag.
  const bypass = ciBypassRequested({ env: opts.env, yes: opts.yes });
  if (bypass.requested && !bypass.allowed) {
    throw new ReleaseError(bypass.message);
  }
  if (bypass.message) console.log(`\n⚠ ${bypass.message}`);

  // Preflight is limited to what can be checked before anything is written:
  // workspace invariants (in preflight), the version/tag/registry invariants of
  // the packages actually being released, and a fresh dependency tree. CI is
  // never queried here — the release commit is not pushed yet.
  if (publishable.length) {
    assertFreshDependencies(publishable);
    assertVersionInvariants(publishable, opts);
    verify(publishable);
  }
  prepareChangelogs(publishable, opts);
  if (publishable.length && !opts.dryRun) assertWrittenReleaseText(publishable);

  if (opts.dryRun) {
    for (const t of publishable) {
      console.log(
        `\n${t.name} ${t.version} → ${t.nextVersion}  (tag ${t.tag})`,
      );
      console.log(
        t.section
          ? t.section
              .split("\n")
              .map((l) => `  ${l}`)
              .join("\n")
          : "  (continue mode — no new changelog)",
      );
    }
    if (collisions.length || blocked.length) {
      console.log(
        `\n⚠ ${collisions.length} bump collision(s), ${blocked.length} unknown publish state(s) — a real run would skip those packages and exit 1.`,
      );
    }
    if (bypass.allowed) {
      console.log(
        `\n⚠ ${CI_BYPASS_MESSAGE} — a real run would publish and tag without waiting for CI.`,
      );
    } else {
      console.log(
        "\nA real run would then: stage package.json/package-lock.json/CHANGELOG.md →\n" +
          "commit → push → await green CI (ubuntu-latest + windows-latest) for that SHA\n" +
          "→ publish → tag → push tags. Pending, unknown or red CI blocks publish.",
      );
    }
    console.log(
      "\nDry run complete — nothing was written, published, or tagged.",
    );
    return;
  }

  // Anything that publishes or (re)tags needs a CI-verified SHA.
  const tagCandidates = targets.filter(
    (t) => t.status === "publish" || (t.status === "skip" && t.tagEligible),
  );
  const needsPhases = publishable.length > 0 || tagCandidates.length > 0;

  const completed = [];
  let ciState = null;
  let releaseSha = null;
  let published = [];
  let done = [];
  const failed = [];

  const gate = (phase) => {
    const decision = gatePhase({
      phase,
      completed,
      ciState,
      bypass: bypass.allowed,
    });
    if (!decision.allowed) {
      throw new ReleaseError(
        `release blocked at phase "${phase}": ${decision.message}` +
          (releaseSha
            ? `\n  Check the matrix for ${releaseSha}: ${CI_CHECKS_URL}/${releaseSha}/checks`
            : ""),
      );
    }
    return decision;
  };

  if (needsPhases) {
    // 1. Write the release text, then commit only its explicit paths.
    const commit = publishable.length
      ? commitRelease(publishable)
      : resolveReleaseSha({ committed: false, head: headSha() });
    releaseSha = commit.sha;
    if (!commit.committed) {
      console.log(
        `CI gate keyed on the current HEAD ${releaseSha} (nothing new to commit).`,
      );
    }

    // 2. push -> await-ci
    gate("push");
    if (opts.noPush) {
      console.log(
        "\n--no-push set — the release commit and tags stay local, so CI cannot verify them.",
      );
      if (!bypass.allowed) {
        throw new ReleaseError(
          "--no-push leaves the release commit unpushed, so CI cannot verify it; publish/tag is blocked.\n" +
            "  Push the branch (or re-run without --no-push), or set RELEASE_SKIP_CI=1 with --yes to bypass the gate deliberately.",
        );
      }
      console.log(CI_BYPASS_MESSAGE);
    } else {
      must(git(["push", "origin", opts.branch]), "git push (branch)");
      console.log(
        `\nPushed ${opts.branch} (${releaseSha}) — CI verifies this exact SHA.`,
      );
    }
    completed.push("push");

    gate("await-ci");
    if (bypass.allowed) {
      console.log(`${CI_BYPASS_MESSAGE} — not polling CI for ${releaseSha}.`);
      ciState = {
        state: "green",
        blocked: false,
        reason: "ci-bypassed",
        message: CI_BYPASS_MESSAGE,
      };
    } else {
      ciState = await awaitCiState(releaseSha, opts);
    }
    completed.push("await-ci");

    // 3. publish (CI-gated)
    if (publishable.length) {
      gate("publish");
      const result = publish(targets);
      published = result.published;
      done = result.done;
      failed.push(...result.failed);
    } else {
      done = tagCandidates;
    }
    completed.push("publish");

    // 4. tag -> push-tags (CI-gated)
    if (done.length) {
      gate("tag");
      const tags = createTags(done);
      completed.push("tag");
      if (opts.noPush) {
        console.log(
          "\n--no-push set — commit and tags are local only. Push with:",
        );
        console.log(
          `  git push origin ${opts.branch} && git push origin ${tags.join(" ")}`,
        );
      } else {
        gate("push-tags");
        must(git(["push", "origin", ...tags]), "git push (tags)");
        completed.push("push-tags");
        console.log(`\nPushed ${opts.branch} and ${tags.length} tag(s).`);
        for (const target of done)
          console.log(`  ✓ ${target.name}@${target.nextVersion}`);
      }
    } else {
      console.log(
        "\nNothing was published — no tags were created and nothing was pushed.",
      );
    }
  } else {
    console.log(
      "\nNothing was published — no tags were created and nothing was pushed.",
    );
  }

  if (bypass.allowed) console.log(`\n⚠ ${CI_BYPASS_MESSAGE}`);

  if (published.length) {
    console.log("\nRelease complete:");
    for (const t of published) {
      console.log(
        `  ${t.name}@${t.nextVersion}  https://www.npmjs.com/package/${t.name}/v/${t.nextVersion}`,
      );
    }
  } else if (done.length) {
    console.log(
      "\nNothing published this run — already-published versions were tagged and pushed.",
    );
  }

  galleryCheck(published);

  if (failed.length) {
    console.log("\nNot published (npm publish failed):");
    for (const t of failed) console.log(`  ✗ ${t.name}@${t.nextVersion}`);
  }
  if (collisions.length) {
    console.log("\nSkipped (target version already on npm — bump further):");
    for (const t of collisions) {
      console.log(
        `  ⚠ ${t.name}: ${t.nextVersion} is on npm but the manifest says ${t.version}`,
      );
    }
  }
  if (blocked.length) {
    console.log("\nNot published (publish state unknown):");
    for (const t of blocked) console.log(`  ⚠ ${t.name} — ${t.reason}`);
  }

  const problems = [];
  if (failed.length)
    problems.push(`publish failed for ${failed.map((t) => t.name).join(", ")}`);
  if (collisions.length)
    problems.push(
      `bump collides with a published version: ${collisions
        .map((t) => `${t.name}@${t.nextVersion}`)
        .join(", ")}`,
    );
  if (blocked.length)
    problems.push(
      `publish state unknown: ${blocked.map((t) => t.name).join(", ")}`,
    );
  if (problems.length) {
    throw new ReleaseError(
      `${problems.join("\n  ")}\n` +
        (failed.length
          ? "  Resume the failed package(s) with: npm run release -- --continue\n"
          : "") +
        (collisions.length
          ? "  A colliding bump usually means this checkout is behind the registry — check `npm run release:status`, then bump further or pull.\n"
          : "") +
        (blocked.length
          ? "  Nothing was published for the unknown-state package(s) — re-run when the registry is reachable.\n"
          : ""),
    );
  }
}

const invokedDirectly =
  Boolean(process.argv[1]) &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  main().catch((err) => {
    console.error(`\n✗ ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = err instanceof ReleaseError ? err.exitCode : 1;
  });
}

// Exported for scripts/release.test.mjs: the decision rules, the staging rule,
// the phase/CI gate, and the registry classification are pure, so they are
// tested without npm, git, gh or a registry. (The newer helpers are exported at
// their declarations: ciBypassRequested, dependencyFreshness, gatePhase,
// resolveReleaseSha, stagePathsFor, CI_BYPASS_MESSAGE, RELEASE_STAGE_BASENAMES.)
export {
  classifyNpmView,
  classifyTargetState,
  composeChangelog,
  decideTarget,
  documentsVersion,
  normalizeEol,
  npmConsumedFlags,
  parseArgs,
  planTargets,
  publishState,
  stateNote,
};
