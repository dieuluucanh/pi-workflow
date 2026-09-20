#!/usr/bin/env node
/**
 * check-gallery.mjs — confirm that published Pi extensions are listed on pi.dev.
 *
 * The gallery at https://pi.dev/packages is a crawl of the npm search index
 * filtered by the `pi-package` keyword — but only a bounded, score-ranked slice
 * of it. npm's `/v1/search` serves results only up to ~`from=5000` (further
 * offsets silently roll over to page 1), so roughly half of the matching
 * packages are unreachable, and ranking is dominated by download traction. A
 * published package can therefore be installable, carry the keyword, and even
 * have a working detail page while pi.dev has no catalog record for it.
 *
 * The detail page is NOT proof of listing: pi.dev renders it for any npm
 * package that looks like a Pi package. What distinguishes a catalogued
 * package is its `Downloads` row — pi.dev fills it only from its own crawled
 * catalog snapshot, so `not available` means "no catalog row" (invisible in the
 * gallery search and in "Recently published"), while a numeric value
 * (`441/mo · 247/wk`) means the gallery has it.
 *
 * Checks, per package:
 *   a) eligibility — the manifest declares the `pi-package` keyword
 *   b) publication — `npm view <name>@<version>` resolves on the registry
 *   c) catalogue   — the detail page's `Downloads` row (>0/number = catalogued)
 *   d) freshness   — the version on the catalog card equals the manifest version
 *
 * Usage:
 *   npm run gallery                          # all packages, one shot
 *   npm run gallery -- --packages workflow   # one package
 *   npm run gallery -- --wait 900            # poll for up to 15 minutes
 *   npm run gallery -- --json                # machine-readable output
 *   npm run gallery -- --warn-only           # never fail (used by release.mjs)
 *   node scripts/check-gallery.mjs --help
 *
 * Exit codes:
 *   0  every package is eligible, published, and listed with the expected version
 *   1  ineligible, not published, not listed yet, or the gallery shows an older version
 *   2  usage error / unknown package
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXT_DIR = path.join(ROOT, "agent", "extensions");
const GALLERY_BASE = "https://pi.dev";
const NPM_SPEC =
  process.platform === "win32"
    ? // npm is a .cmd shim on Windows; spawn it through cmd.exe. shell:false keeps
      // argument escaping sane and avoids Node's DEP0190 shell-args warning.
      { cmd: process.env.ComSpec || "cmd.exe", args: ["/d", "/s", "/c", "npm"] }
    : { cmd: "npm", args: [] };

const DEFAULTS = {
  wait: 0,
  interval: 30,
  timeout: 15,
  retries: 2,
  warnOnly: false,
  json: false,
};

// ── helpers ────────────────────────────────────────────────────────────────

function run(cmd, args, cwd, { timeout = 180_000 } = {}) {
  return spawnSync(cmd, args, {
    cwd,
    encoding: "utf8",
    timeout,
  });
}

function runNpm(args, cwd, opts = {}) {
  return run(NPM_SPEC.cmd, [...NPM_SPEC.args, ...args], cwd, opts);
}

function out(res) {
  return String(res.stdout ?? "").trim();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(
      `cannot read JSON from ${file}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
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
      return {
        short: e.name,
        dir,
        name: String(pkg.name ?? ""),
        version: String(pkg.version ?? ""),
        keywords: Array.isArray(pkg.keywords) ? pkg.keywords : [],
      };
    })
    .sort((a, b) => a.short.localeCompare(b.short));
}

function selectPackages(all, filter) {
  if (!filter) return all;
  const unknown = filter.filter((f) => !all.some((p) => p.short === f));
  if (unknown.length) {
    throw new UsageError(
      `unknown package(s): ${unknown.join(", ")} (known: ${all.map((p) => p.short).join(", ")})`,
    );
  }
  return all.filter((p) => filter.includes(p.short));
}

class UsageError extends Error {}

// ── pi.dev parsing ─────────────────────────────────────────────────────────

const DETAIL_ROW_RE = /<dt>([^<]+)<\/dt>\s*<dd>([\s\S]*?)<\/dd>/g;

const NAMED_ENTITIES = {
  quot: '"',
  apos: "'",
  amp: "&",
  lt: "<",
  gt: ">",
  nbsp: " ",
  middot: "·",
  ndash: "–",
  mdash: "—",
  hellip: "…",
};

function decodeEntities(text) {
  return String(text).replace(
    /&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g,
    (whole, body) => {
      if (body.startsWith("#")) {
        const hex = body[1] === "x" || body[1] === "X";
        const code = Number.parseInt(
          hex ? body.slice(2) : body.slice(1),
          hex ? 16 : 10,
        );
        return Number.isFinite(code) && code > 0 && code <= 0x10ffff
          ? String.fromCodePoint(code)
          : whole;
      }
      return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
    },
  );
}

function stripTags(text) {
  return decodeEntities(String(text).replace(/<[^>]*>/g, ""))
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Extract the facts a pi.dev package detail page exposes.
 *
 * The page renders a `<dl class="definition-grid detail-grid">` with
 * `<dt>Package|Version|Published|Downloads|Author|License|Types|Size|Dependencies</dt>`
 * followed by `<dd>` values (usually wrapped in `<code>`). A not-found page has
 * no such grid, so `listed` is false.
 *
 * @param {string} html
 * @returns {{listed: boolean, name: string|null, version: string|null, published: string|null, types: string|null, author: string|null, downloads: string|null}}
 */
export function parseGalleryPage(html) {
  const text = String(html ?? "");
  const facts = {};
  DETAIL_ROW_RE.lastIndex = 0;
  let match;
  while ((match = DETAIL_ROW_RE.exec(text)) !== null) {
    const key = stripTags(match[1]).toLowerCase();
    const value = stripTags(match[2]);
    if (key && value) facts[key] = value;
  }
  const listed =
    Boolean(facts.version) &&
    /packages-detail-(?:view|card|topline)/.test(text);
  return {
    listed,
    name: facts.package ?? null,
    version: facts.version ?? null,
    published: facts.published ?? null,
    types: facts.types ?? null,
    author: facts.author ?? null,
    downloads: facts.downloads ?? null,
  };
}

/**
 * Classify the pi.dev detail page's `Downloads` row.
 *
 * pi.dev renders that row from its own crawled catalog snapshot (built from
 * npm's search results for `keywords:pi-package`), not from npm's download
 * counters. `not available` therefore means "pi.dev has no catalog record for
 * this package", even when the package has real downloads on npm.
 *
 * @param {string|null|undefined} downloads
 * @returns {"listed"|"unlisted"|"unknown"}
 */
export function galleryMembership(downloads) {
  if (downloads == null) return "unknown";
  const value = String(downloads).replace(/\s+/g, " ").trim().toLowerCase();
  if (!value) return "unknown";
  if (value === "not available") return "unlisted";
  return /\d/.test(value) ? "listed" : "unknown";
}

/**
 * Decide the status for one package from already-collected facts (pure, so the
 * decision table stays unit-testable without network access).
 *
 * @param {{eligible: boolean, published: boolean, membership: "listed"|"unlisted"|"unknown"|null, version: string, galleryVersion: string|null}} facts
 * @returns {"ineligible"|"missing"|"not-indexed"|"ok"|"stale"|"unreachable"}
 */
export function classifyGalleryStatus({
  eligible,
  published,
  membership,
  version,
  galleryVersion,
}) {
  if (!eligible) return "ineligible";
  if (!published) return "missing";
  if (membership === "unlisted") return "not-indexed";
  if (membership === "listed" && galleryVersion) {
    return galleryVersion === version ? "ok" : "stale";
  }
  // Fetch failed, no detail grid, or a Downloads row we cannot read.
  return "unreachable";
}

export function galleryUrl(name) {
  // Scoped names stay unencoded in the path — that is how pi.dev links them
  // (`/packages/@dieulc/pi-office-bridge`).
  return `${GALLERY_BASE}/packages/${encodeURI(name)}`;
}

async function fetchGallery(name, timeoutMs) {
  const url = galleryUrl(name);
  try {
    const res = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs * 1000),
      headers: {
        accept: "text/html",
        "user-agent": "pi-release-gallery-check",
      },
    });
    const body = await res.text();
    return { url, status: res.status, body };
  } catch (err) {
    return {
      url,
      status: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function isPublished(name, version, dir) {
  const res = runNpm(["view", `${name}@${version}`, "version"], dir);
  return res.status === 0 && out(res).length > 0;
}

function latestPublished(name, dir) {
  const res = runNpm(["view", name, "version"], dir);
  return res.status === 0 ? out(res) : null;
}

// ── checks ─────────────────────────────────────────────────────────────────

async function checkPackage(pkg, opts) {
  const eligible = pkg.keywords.includes("pi-package");
  const base = {
    short: pkg.short,
    name: pkg.name,
    version: pkg.version,
    url: galleryUrl(pkg.name),
    listed: null,
    membership: null,
    downloads: null,
    gallery: null,
    published: false,
    latest: null,
    status: "pending",
    notes: [],
  };

  base.published = eligible ? isPublished(pkg.name, pkg.version, pkg.dir) : false;

  let fetchStatus = 0;
  let fetchError = null;
  if (eligible && base.published) {
    let res = await fetchGallery(pkg.name, opts.timeout);
    for (let attempt = 0; attempt < opts.retries && res.status === 0; attempt++) {
      await sleep(1000 * (attempt + 1));
      res = await fetchGallery(pkg.name, opts.timeout);
    }

    fetchStatus = res.status;
    fetchError = res.error ?? null;

    if (res.status !== 0) {
      const page = parseGalleryPage(res.body);
      base.gallery = page;
      // 404 (or a non-package 200 page) means pi.dev has no record of it; a
      // detail page with a numeric Downloads row means the catalog has it.
      if (res.status === 200 && page.listed) {
        base.membership = galleryMembership(page.downloads);
        base.listed = base.membership === "listed";
        base.downloads = page.downloads;
      }
    }
  }

  base.status = classifyGalleryStatus({
    eligible,
    published: base.published,
    membership: base.membership,
    version: pkg.version,
    galleryVersion: base.gallery?.version ?? null,
  });

  if (base.status === "ineligible") {
    base.notes.push(
      'manifest keywords must include "pi-package" — the gallery catalog is built from npm search results for that keyword',
    );
  } else if (base.status === "missing") {
    base.notes.push(
      `not on the npm registry yet — publish it: npm run release -- --packages ${pkg.short} --bump none --yes`,
    );
  } else if (base.status === "unreachable") {
    base.notes.push(
      fetchStatus === 0
        ? `pi.dev request failed: ${fetchError ?? "unknown error"}`
        : 'pi.dev detail page has no recognisable "Downloads" row — the page markup may have changed',
    );
  } else if (base.status === "not-indexed") {
    base.notes.push(
      'published and installable, but pi.dev has no gallery-catalog record for it — its detail page shows "Downloads: not available"',
    );
    base.notes.push(
      "the catalog is built from npm search results for keywords:pi-package, and pi.dev ingests only a bounded, score-ranked slice of them (npm's search API rolls over past from=5000, so roughly half of the matching packages are out of reach); low download traction or a stale npm search-index record keeps a package below that slice",
    );
    base.notes.push(
      "publishing a new version does not reliably change this — the slice is score-ranked (see earendil-works/pi#6991, #7849, #7885, #7987, #8830)",
    );
    base.notes.push(
      `check by hand: ${GALLERY_BASE}/packages?name=${encodeURIComponent(pkg.name)}`,
    );
  } else if (base.status === "stale") {
    base.latest = latestPublished(pkg.name, pkg.dir);
    base.notes.push(
      `catalog shows ${base.gallery?.version ?? "?"}, manifest says ${pkg.version}${
        base.latest && base.latest !== pkg.version
          ? ` (npm latest: ${base.latest})`
          : ""
      } — the catalog card lags until the new version's metadata is indexed`,
    );
  }

  return base;
}

// ── main ───────────────────────────────────────────────────────────────────

const HELP = [
  "Usage: npm run gallery -- [options]",
  "",
  "  --packages a,b     packages to check (default: all)",
  "  --wait <sec>       keep polling until every package is listed (default: 0 = one shot)",
  "  --interval <sec>   seconds between polling attempts (default: 30)",
  "  --timeout <sec>    pi.dev request timeout (default: 15)",
  "  --json             print JSON instead of the report",
  "  --warn-only        always exit 0 (used by release.mjs)",
  "  --help, -h         show this help",
  "",
  "Statuses: ok · stale · not-indexed (published, no gallery-catalog record) · missing · ineligible · unreachable",
  "Exit codes: 0 every package is in the pi.dev gallery catalog · 1 not eligible/published/catalogued, or the catalog shows another version · 2 usage error",
].join("\n");

function parseArgs(argv) {
  const opts = { ...DEFAULTS, packages: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--packages")
      opts.packages = String(argv[++i] ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    else if (arg === "--wait") opts.wait = Number(argv[++i] ?? opts.wait) || 0;
    else if (arg === "--interval")
      opts.interval = Number(argv[++i] ?? opts.interval) || DEFAULTS.interval;
    else if (arg === "--timeout")
      opts.timeout = Number(argv[++i] ?? opts.timeout) || DEFAULTS.timeout;
    else if (arg === "--json") opts.json = true;
    else if (arg === "--warn-only") opts.warnOnly = true;
    else if (arg === "--help" || arg === "-h") opts.help = true;
    else throw new UsageError(`unknown argument: ${arg}`);
  }
  return opts;
}

function catalogDetail(r) {
  return [
    `catalog: ${r.gallery?.version ?? "?"}`,
    r.downloads ? r.downloads : null,
    r.gallery?.published ? `published ${r.gallery.published}` : null,
  ]
    .filter(Boolean)
    .join(", ");
}

const STATUS_DETAIL = {
  ok: catalogDetail,
  stale: catalogDetail,
  "not-indexed": () =>
    "published, but not in the pi.dev gallery catalog (detail page: Downloads: not available)",
  missing: () => "not published on npm",
  unreachable: () => "pi.dev detail page unreadable",
  ineligible: () => 'keywords missing "pi-package"',
};

function report(results) {
  for (const r of results) {
    const detail = (STATUS_DETAIL[r.status] ?? (() => r.status))(r);
    console.log(`── ${r.name} @ ${r.version} — ${r.status} (${detail})`);
    for (const note of r.notes) console.log(`     ↳ ${note}`);
    console.log(`     ${r.url}`);
  }
  const failed = results.filter((r) => r.status !== "ok");
  console.log(
    `\n${results.length - failed.length}/${results.length} package(s) in the pi.dev gallery catalog`,
  );
  if (failed.length) {
    console.log(`Not in the catalog: ${failed.map((r) => r.name).join(", ")}`);
  }
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }
  if (opts.help) {
    console.log(HELP);
    return 0;
  }

  const all = discoverPackages();
  const selected = selectPackages(all, opts.packages);
  if (!selected.length) {
    console.error("✗ nothing to check");
    return 2;
  }

  const deadline = Date.now() + opts.wait * 1000;
  let results;
  let attempt = 0;
  for (;;) {
    attempt++;
    if (opts.wait && !opts.json && attempt > 1) {
      console.log(`\n↻ attempt ${attempt} …`);
    }
    results = [];
    for (const pkg of selected) {
      results.push(await checkPackage(pkg, opts));
    }

    const outstanding = results.filter((r) => r.status !== "ok");
    if (!outstanding.length || !opts.wait || Date.now() >= deadline) break;
    const stillWaiting = outstanding.some((r) =>
      ["not-indexed", "unreachable"].includes(r.status),
    );
    if (!stillWaiting) break; // stale/missing/ineligible never fix themselves by waiting
    if (!opts.json) {
      console.log(
        `⋯ ${outstanding.length} package(s) not listed yet — retrying in ${opts.interval}s (deadline in ${Math.max(
          0,
          Math.round((deadline - Date.now()) / 1000),
        )}s)`,
      );
    }
    await sleep(opts.interval * 1000);
  }

  if (opts.json) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    report(results);
  }

  const failed = results.filter((r) => r.status !== "ok");
  if (opts.warnOnly) return 0;
  return failed.length ? 1 : 0;
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
      process.exitCode = 1;
    });
}
