#!/usr/bin/env node
/**
 * status.mjs — read-only npm publish-state report for the four @dieulc/*
 * Pi extensions.
 *
 * For every package under agent/extensions/ it compares the local
 * package.json version with the registry: `latest` dist-tag, all dist-tags,
 * publish date, deprecation flags, and a drift verdict.
 *
 * Nothing is written, published, or tagged. Safe to run any time.
 *
 * Usage:
 *   npm run release:status                        # human table
 *   npm run release:status -- --json              # machine-readable report
 *   npm run release:status -- --check             # exit non-zero on problems
 *   npm run release:status -- --packages workflow,autocompact
 *   node scripts/status.mjs --registry http://localhost:4873
 *
 * Exit codes:
 *   0  report generated (without --check), or --check found nothing to fix
 *   1  --check found version-state problems (never published, drift, deprecated)
 *   2  usage error, or a registry query failed while --check was set
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXT_DIR = path.join(ROOT, "agent", "extensions");
const DEFAULT_REGISTRY = "https://registry.npmjs.org/";
const QUERY_TIMEOUT_MS = 15_000;
const NPM_SPEC =
  process.platform === "win32"
    ? // npm is a .cmd shim on Windows; spawn it through cmd.exe (same pattern
      // as scripts/verify-packages.mjs and scripts/release.mjs).
      { cmd: process.env.ComSpec || "cmd.exe", args: ["/d", "/s", "/c", "npm"] }
    : { cmd: "npm", args: [] };

// ── process helpers ────────────────────────────────────────────────────────

function run(cmd, args, { timeout = 120_000 } = {}) {
  return spawnSync(cmd, args, { cwd: ROOT, encoding: "utf8", timeout });
}

function npm(args, opts = {}) {
  return run(NPM_SPEC.cmd, [...NPM_SPEC.args, ...args], opts);
}

function out(res) {
  return String(res.stdout ?? "").trim();
}

function tail(res, lines = 6) {
  const text = `${res.stdout ?? ""}\n${res.stderr ?? ""}`.trim();
  return text.split(/\r?\n/).slice(-lines).join("\n");
}

function readJson(file) {
  const source = fs.readFileSync(file, "utf8");
  try {
    return JSON.parse(source);
  } catch (err) {
    throw new Error(
      `cannot parse JSON from ${file}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function stripAnsi(text) {
  // eslint-disable-next-line no-control-regex
  return String(text ?? "").replace(/\u001B\[[0-9;]*m/g, "");
}

// ── discovery ──────────────────────────────────────────────────────────────

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
      return { short: e.name, dir, name: pkg.name, localVersion: pkg.version };
    })
    .sort((a, b) => a.short.localeCompare(b.short));
}

function selectPackages(all, filter) {
  if (!filter) return all;
  const unknown = filter.filter((f) => !all.some((p) => p.short === f));
  if (unknown.length) {
    throw new Error(
      `unknown package(s): ${unknown.join(", ")} (known: ${all
        .map((p) => p.short)
        .join(", ")})`,
    );
  }
  return all.filter((p) => filter.includes(p.short));
}

// ── arguments ──────────────────────────────────────────────────────────────

const USAGE = [
  "Usage: npm run release:status -- [options]",
  "",
  "  --json            print the report as JSON (nothing else on stdout)",
  "  --check           exit 1 on publish-state problems, 2 if a query failed",
  "  --packages a,b    restrict the report to these packages",
  "  --registry url    registry to query (default: npm config get registry)",
  "  --help, -h        show this help",
].join("\n");

function parseArgs(argv) {
  const opts = {
    json: false,
    check: false,
    packages: null,
    registry: null,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json") opts.json = true;
    else if (arg === "--check") opts.check = true;
    else if (arg === "--packages")
      opts.packages = String(argv[++i] ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    else if (arg === "--registry")
      opts.registry = String(argv[++i] ?? "").trim();
    else if (arg === "--help" || arg === "-h") opts.help = true;
    else throw new Error(`unknown argument: ${arg}\n\n${USAGE}`);
  }
  if (opts.registry && !/^https?:\/\//.test(opts.registry)) {
    throw new Error(`--registry must be an http(s) URL (got ${opts.registry})`);
  }
  return opts;
}

// ── registry ───────────────────────────────────────────────────────────────

let cachedRegistry = null;

function registryUrl(override) {
  if (override) return `${override.replace(/\/+$/, "")}/`;
  if (cachedRegistry) return cachedRegistry;
  const res = npm(["config", "get", "registry"]);
  const value = stripAnsi(out(res));
  cachedRegistry =
    res.status === 0 && /^https?:\/\//.test(value)
      ? `${value.replace(/\/+$/, "")}/`
      : DEFAULT_REGISTRY;
  return cachedRegistry;
}

function packumentUrl(registry, name) {
  // Escape only the scope slash: https://registry.npmjs.org/@dieulc%2fworkflow
  return `${registry}${name.replace("/", "%2f")}`;
}

function emptyState() {
  return {
    exists: false,
    distTags: {},
    versions: [],
    times: {},
    deprecated: new Map(),
  };
}

function normalizePackument(doc) {
  const versions =
    doc && typeof doc.versions === "object" && doc.versions !== null
      ? Object.keys(doc.versions)
      : [];
  const deprecated = new Map();
  for (const version of versions) {
    const flag = doc.versions[version]?.deprecated;
    if (flag) deprecated.set(version, flag);
  }
  return {
    exists: true,
    distTags: { ...(doc?.["dist-tags"] ?? {}) },
    versions,
    times: { ...(doc?.time ?? {}) },
    deprecated,
  };
}

async function fetchPackument(name, registry) {
  const res = await fetch(packumentUrl(registry, name), {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(QUERY_TIMEOUT_MS),
  });
  // A missing packument is a state, not a failure: nothing is published yet.
  if (res.status === 404) return emptyState();
  if (!res.ok) throw new Error(`registry responded ${res.status}`);
  return normalizePackument(await res.json());
}

function readPackumentViaNpm(name) {
  const res = npm(["view", name, "--json"], { timeout: QUERY_TIMEOUT_MS * 2 });
  if (res.status !== 0) {
    const text = `${out(res)}\n${res.stderr ?? ""}`;
    if (/E404|404 Not Found/i.test(text)) return emptyState();
    throw new Error(tail(res, 3) || "npm view failed");
  }
  try {
    return normalizePackument(JSON.parse(out(res)));
  } catch (err) {
    throw new Error(
      `could not parse npm view output for ${name}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

async function queryPackage(pkg, registry) {
  try {
    return {
      pkg,
      state: await fetchPackument(pkg.name, registry),
      error: null,
    };
  } catch (fetchError) {
    try {
      // Fallback respects ~/.npmrc (mirrors, auth) when direct fetch does not.
      return { pkg, state: readPackumentViaNpm(pkg.name), error: null };
    } catch (npmError) {
      const npmMessage =
        npmError instanceof Error ? npmError.message : String(npmError);
      const fetchMessage =
        fetchError instanceof Error ? fetchError.message : String(fetchError);
      return { pkg, state: null, error: npmMessage || fetchMessage };
    }
  }
}

function queryAll(packages, registry) {
  return Promise.all(packages.map((pkg) => queryPackage(pkg, registry)));
}

// ── version comparison ─────────────────────────────────────────────────────

const SEMVER_RE =
  /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

function parseSemver(version) {
  const match = SEMVER_RE.exec(String(version ?? "").trim());
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split(".") : [],
  };
}

function comparePrerelease(a, b) {
  if (!a.length && !b.length) return 0;
  if (!a.length) return 1; // a release outranks a prerelease
  if (!b.length) return -1;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const ai = a[i];
    const bi = b[i];
    const aNumeric = /^\d+$/.test(ai);
    const bNumeric = /^\d+$/.test(bi);
    if (aNumeric && bNumeric) {
      const diff = Number(ai) - Number(bi);
      if (diff !== 0) return diff < 0 ? -1 : 1;
    } else if (aNumeric !== bNumeric) {
      return aNumeric ? -1 : 1; // numeric identifiers sort lower
    } else if (ai !== bi) {
      return ai < bi ? -1 : 1;
    }
  }
  if (a.length === b.length) return 0;
  return a.length < b.length ? -1 : 1;
}

/**
 * Semver precedence (build metadata ignored). Returns -1 | 0 | 1, or null when
 * either side is not a version we can compare.
 */
function compareSemver(a, b) {
  const left = parseSemver(a);
  const right = parseSemver(b);
  if (!left || !right) return null;
  for (const key of ["major", "minor", "patch"]) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1;
  }
  return comparePrerelease(left.prerelease, right.prerelease);
}

// ── classification ─────────────────────────────────────────────────────────

/**
 * Turn one registry query into a drift verdict plus problem/note codes.
 * Problem codes double as --check failures: never-published, local-ahead,
 * local-behind, local-not-published, published-not-latest, deprecated-current,
 * invalid-version, registry-error.
 */
function classifyPackage(pkg, result) {
  if (result.error || !result.state) {
    return {
      drift: "registry-error",
      problems: ["registry-error"],
      notes: [],
      error: result.error ?? "registry query failed",
    };
  }

  const { state } = result;
  const local = String(pkg.localVersion ?? "");
  const notes = [];

  if (!state.exists || state.versions.length === 0) {
    return {
      drift: "never-published",
      problems: ["never-published"],
      notes,
      error: null,
    };
  }

  if (parseSemver(local) === null) {
    return {
      drift: "invalid-version",
      problems: ["invalid-version"],
      notes,
      error: null,
    };
  }

  const latest = state.distTags.latest ?? null;
  const localPublished = state.versions.includes(local);
  let drift;

  if (!localPublished) {
    const compared = latest ? compareSemver(local, latest) : null;
    if (compared === null) {
      drift = "local-not-published";
      if (latest) notes.push(`cannot compare ${local} with latest ${latest}`);
    } else if (compared > 0) {
      drift = "local-ahead";
    } else if (compared < 0) {
      drift = "local-behind";
    } else {
      // Same precedence but a different string (e.g. build metadata only).
      drift = "local-not-published";
    }
  } else if (latest === local) {
    drift = "in-sync";
  } else {
    const compared = latest ? compareSemver(local, latest) : null;
    drift =
      compared !== null && compared < 0
        ? "local-behind"
        : "published-not-latest";
  }

  const problems = drift === "in-sync" ? [] : [drift];

  if (state.deprecated.has(local)) problems.push("deprecated-current");

  if (latest && (parseSemver(latest)?.prerelease.length ?? 0) > 0) {
    notes.push(`latest ${latest} is a prerelease`);
  }
  const olderDeprecated = [...state.deprecated.keys()].filter(
    (v) => v !== local,
  );
  if (olderDeprecated.length) {
    notes.push(
      `${olderDeprecated.length} older published version(s) deprecated`,
    );
  }

  return { drift, problems, notes, error: null };
}

// ── rendering ──────────────────────────────────────────────────────────────

function npmIdentity() {
  const res = npm(["whoami"], { timeout: 30_000 });
  const user = stripAnsi(out(res));
  return res.status === 0 && user
    ? { loggedIn: true, user }
    : { loggedIn: false, user: null };
}

function formatDate(iso) {
  if (!iso) return "—";
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime())
    ? String(iso)
    : parsed.toISOString().slice(0, 10);
}

function pad(value, width) {
  const text =
    value === null || value === undefined || value === "" ? "—" : String(value);
  if (text.length >= width) return `${text.slice(0, Math.max(1, width - 1))}…`;
  return text.padEnd(width);
}

function renderTable(rows, identity, registry) {
  console.log("── npm identity ──\n");
  console.log(
    identity.loggedIn
      ? `logged in as ${identity.user}`
      : "not logged in — registry reads still work for public packages",
  );
  console.log(`registry: ${registry}\n`);

  console.log("── packages ──\n");
  console.log(
    `${pad("package", 30)}${pad("local", 10)}${pad("latest", 12)}${pad("published", 11)}${pad("drift", 21)}notes`,
  );
  for (const row of rows) {
    const notes = [...row.notes, row.error ? `error: ${row.error}` : ""]
      .filter(Boolean)
      .join("; ");
    console.log(
      `${pad(row.name, 30)}${pad(row.localVersion, 10)}${pad(row.latest, 12)}${pad(formatDate(row.publishedAt), 11)}${pad(row.drift, 21)}${notes || "—"}`,
    );
  }

  const flagged = rows.filter((row) => row.problems.length > 0);
  console.log("");
  if (flagged.length === 0) {
    console.log(
      `${rows.length}/${rows.length} package(s) in sync with the registry.`,
    );
  } else {
    console.log(
      `${rows.length - flagged.length}/${rows.length} package(s) in sync — problems: ${flagged
        .map((row) => `${row.short} (${row.problems.join(", ")})`)
        .join("; ")}`,
    );
  }
}

function buildReport(rows, identity, registry, generatedAt) {
  return {
    schemaVersion: 1,
    generatedAt,
    registry,
    identity,
    packages: rows.map((row) => ({
      short: row.short,
      name: row.name,
      dir: path.relative(ROOT, row.dir).split(path.sep).join("/"),
      localVersion: row.localVersion,
      localPublished: row.localPublished,
      published: row.published,
      latest: row.latest,
      latestPublishedAt: row.latestPublishedAt,
      publishedAt: row.publishedAt,
      deprecated: row.deprecated,
      distTags: row.distTags,
      drift: row.drift,
      problems: row.problems,
      notes: row.notes,
      error: row.error,
    })),
    ok: rows.every((row) => row.problems.length === 0),
    problemCount: rows.reduce((count, row) => count + row.problems.length, 0),
  };
}

function computeExitCode(rows, { check }) {
  if (!check) return 0;
  if (rows.some((row) => row.problems.includes("registry-error"))) return 2;
  if (rows.some((row) => row.problems.length > 0)) return 1;
  return 0;
}

// ── main ───────────────────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(USAGE);
    return 0;
  }

  const registry = registryUrl(opts.registry);
  const selected = selectPackages(discoverPackages(), opts.packages);
  const identity = npmIdentity();
  const results = await queryAll(selected, registry);

  const rows = results.map((result) => {
    const verdict = classifyPackage(result.pkg, result);
    const state = result.state;
    const latest = state?.distTags?.latest ?? null;
    const localPublished = Boolean(
      state?.versions?.includes(result.pkg.localVersion),
    );
    const latestPublishedAt = latest ? (state?.times?.[latest] ?? null) : null;
    return {
      short: result.pkg.short,
      name: result.pkg.name,
      dir: result.pkg.dir,
      localVersion: result.pkg.localVersion,
      localPublished,
      published: Boolean(state?.exists && state.versions.length > 0),
      latest,
      latestPublishedAt,
      publishedAt:
        (localPublished
          ? (state?.times?.[result.pkg.localVersion] ?? null)
          : null) ?? latestPublishedAt,
      deprecated: state?.deprecated?.get(result.pkg.localVersion) ?? null,
      distTags: state?.distTags ?? {},
      drift: verdict.drift,
      problems: verdict.problems,
      notes: verdict.notes,
      error: verdict.error ?? result.error ?? null,
    };
  });

  if (opts.json) {
    process.stdout.write(
      `${JSON.stringify(buildReport(rows, identity, registry, new Date().toISOString()), null, 2)}\n`,
    );
  } else {
    renderTable(rows, identity, registry);
  }
  return computeExitCode(rows, opts);
}

const invokedDirectly =
  Boolean(process.argv[1]) &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      console.error(`\n✗ ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 2;
    });
}

export {
  classifyPackage,
  compareSemver,
  computeExitCode,
  normalizePackument,
  parseArgs,
  parseSemver,
};
