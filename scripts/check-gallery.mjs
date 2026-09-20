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
 * package that looks like a Pi package. A catalog row is what puts a package
 * into the gallery search and into "Recently published". Two independent
 * signals are read, and they have to agree:
 *
 *   1. membership — an exact-name card in the catalog listing
 *      (`/packages?name=<pkg>`, walked page by page while the page counter
 *      says more rows matched)
 *   2. the detail page's `Downloads` row — pi.dev fills it only from its own
 *      crawled catalog snapshot, so `not available` means "no catalog row"
 *      while a numeric value (`441/mo · 247/wk`) means the gallery has it
 *
 * A disagreement between the two (or a signal that cannot be read at all) is
 * reported as `unreachable`, never as a confident "not indexed".
 *
 * Checks, per package:
 *   a) eligibility — the manifest declares the `pi-package` keyword
 *   b) publication — `npm view <name>@<version>` resolves on the registry
 *   c) catalogue   — (1) and (2) above agree that a catalog row exists
 *   d) freshness   — the version on the detail page equals the manifest version
 *
 * Usage:
 *   npm run gallery                          # all packages, one shot
 *   npm run gallery -- --packages workflow   # one package
 *   npm run gallery -- --wait 900            # poll for up to 15 minutes
 *   npm run gallery -- --diagnose            # explain a verdict (index figures, cut-off)
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
const SEARCH_BASE = "https://registry.npmjs.org/-/v1/search";
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
  diagnose: false,
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
 * `listMember` is the catalog-listing verdict: `true` (exact-name card found),
 * `false` (listing read completely, no card) or `null` (could not be read).
 * Leaving it `undefined` keeps the legacy single-signal behaviour, where the
 * detail page's `Downloads` row is the only evidence.
 *
 * @param {{eligible: boolean, published: boolean, membership: "listed"|"unlisted"|"unknown"|null, version: string, galleryVersion: string|null, listMember?: boolean|null}} facts
 * @returns {"ineligible"|"missing"|"not-indexed"|"ok"|"stale"|"unreachable"}
 */
export function classifyGalleryStatus({
  eligible,
  published,
  membership,
  version,
  galleryVersion,
  listMember,
}) {
  if (!eligible) return "ineligible";
  if (!published) return "missing";

  const rowSaysMember =
    membership === "listed" ? true : membership === "unlisted" ? false : null;

  if (listMember === undefined) {
    // Legacy single-signal path: the detail page's Downloads row alone.
    if (membership === "unlisted") return "not-indexed";
    if (membership === "listed" && galleryVersion) {
      return galleryVersion === version ? "ok" : "stale";
    }
    return "unreachable";
  }

  // Both signals must be readable and must agree before anything is claimed.
  if (listMember === null || rowSaysMember === null) return "unreachable";
  if (listMember !== rowSaysMember) return "unreachable";
  if (!listMember) return "not-indexed";
  if (!galleryVersion) return "unreachable";
  return galleryVersion === version ? "ok" : "stale";
}

/**
 * Parse the page counter the catalog renders above its grid. Three shapes are
 * in the wild:
 *
 *   `1-4 / 4 (of 5376)`     filtered, one page        → from/to/matched/total
 *   `5351-5376 / 5376`      last page, matched == total
 *   `0 / 5374`              nothing matched
 *
 * @param {string} text plain text of the counter element
 * @returns {{from: number, to: number, matched: number, total: number}|null}
 */
export function parseCatalogCount(text) {
  const value = stripTags(text);
  const ranged = value.match(
    /^(\d+)\s*[-–—]\s*(\d+)\s*\/\s*(\d+)(?:\s*\(of\s+(\d+)\))?$/i,
  );
  if (ranged) {
    const from = Number.parseInt(ranged[1], 10);
    const to = Number.parseInt(ranged[2], 10);
    const matched = Number.parseInt(ranged[3], 10);
    const total = Number.parseInt(ranged[4] ?? ranged[3], 10);
    if (![from, to, matched, total].every(Number.isFinite)) return null;
    return { from, to, matched, total };
  }

  // `<matched> / <total>` — rendered when there is a single number to show
  // (`0 / 5374` for no matches).
  const single = value.match(/^(\d+)\s*\/\s*(\d+)$/);
  if (single) {
    const matched = Number.parseInt(single[1], 10);
    const total = Number.parseInt(single[2], 10);
    if (![matched, total].every(Number.isFinite)) return null;
    return { from: 0, to: matched, matched, total };
  }

  return null;
}

/**
 * Extract the cards of a pi.dev catalog listing page.
 *
 * This is the authoritative membership test for the gallery: the detail page
 * (`/packages/<name>`) is rendered on demand for any npm package that looks
 * like a Pi package, but a card in `/packages?name=<name>` exists only when
 * pi.dev's crawl actually ingested the package into its catalog. Each card
 * carries `data-package-downloads` (its crawled npm figure), `data-package-date`
 * (epoch ms of the version it was ingested with) and `data-package-types`.
 *
 * Markup drift must never throw: an unrecognised page comes back with
 * `recognized: false` so the caller can report `unreachable` instead of
 * claiming a package is missing.
 *
 * @param {string} html
 * @returns {{recognized: boolean, count: {from: number, to: number, matched: number, total: number}|null, packages: Array<{name: string, downloads: number|null, date: number|null, types: string[]}>}}
 */
export function parseCatalogList(html) {
  const text = String(html ?? "");

  const countMatch = text.match(
    /<span[^>]*class="[^"]*packages-count[^"]*"[^>]*>([\s\S]*?)<\/span>/,
  );
  const count = countMatch ? parseCatalogCount(countMatch[1]) : null;

  const packages = [];
  const seen = new Set();
  for (const tag of text.match(/<article\b[^>]*>/g) ?? []) {
    const attrs = {};
    for (const [, key, raw] of tag.matchAll(/data-package-([a-z0-9-]+)="([^"]*)"/g)) {
      attrs[key] = decodeEntities(raw);
    }
    if (attrs.card !== "true" || !attrs.name) continue;
    if (seen.has(attrs.name)) continue;
    seen.add(attrs.name);
    const downloads = Number.parseInt(attrs.downloads ?? "", 10);
    const date = Number.parseInt(attrs.date ?? "", 10);
    packages.push({
      name: attrs.name,
      downloads: Number.isFinite(downloads) ? downloads : null,
      date: Number.isFinite(date) ? date : null,
      types: (attrs.types ?? "").split(/[\s,]+/).filter(Boolean),
    });
  }

  return { recognized: Boolean(count) || packages.length > 0, count, packages };
}

/**
 * Whether a parsed catalog listing contains an exact package name.
 *
 * @param {{packages: Array<{name: string}>}|null|undefined} parsed
 * @param {string} name
 */
export function catalogIncludes(parsed, name) {
  return Boolean(
    parsed?.packages?.some((entry) => entry.name === name),
  );
}

export function galleryUrl(name) {
  // Scoped names stay unencoded in the path — that is how pi.dev links them
  // (`/packages/@dieulc/pi-office-bridge`).
  return `${GALLERY_BASE}/packages/${encodeURI(name)}`;
}

/**
 * The catalog listing filtered by a search term. pi.dev matches that term
 * against a row's name, description and author, and it does **not** match the
 * full `@scope/name` form of a scoped package, so callers pass the terms from
 * `catalogListQueries` instead of a raw package name.
 */
export function catalogListUrl(term) {
  return `${GALLERY_BASE}/packages?name=${encodeURIComponent(term)}`;
}

/**
 * Candidate `?name=` filter terms for a package, most selective first.
 *
 * A scoped row's searchable text contains its publisher, so the scope on its own
 * usually selects that author's handful of packages (`dieulc` → `1-4 / 4`) — a
 * single page that both finds the row and proves its absence. The unscoped
 * basename is the fallback hook (it always matches the package's own name).
 *
 * @param {string} name
 * @returns {string[]}
 */
export function catalogListQueries(name) {
  const value = String(name ?? "").trim();
  const slash = value.indexOf("/");
  if (!value.startsWith("@") || slash < 1) return value ? [value] : [];
  const scope = value.slice(1, slash);
  const base = value.slice(slash + 1);
  return base ? [scope, base] : [scope];
}

async function fetchText(url, timeoutMs, accept = "text/html") {
  try {
    const res = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs * 1000),
      headers: {
        accept,
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

// A transport failure (status 0) is retried a couple of times with a widening
// delay; an HTTP status is a real answer and is never retried.
async function fetchWithRetry(url, opts, accept = "text/html") {
  let res = await fetchText(url, opts.timeout, accept);
  for (let attempt = 0; attempt < opts.retries && res.status === 0; attempt++) {
    await sleep(1000 * (attempt + 1));
    res = await fetchText(url, opts.timeout, accept);
  }
  return res;
}

async function fetchJsonOrNull(url, opts) {
  const res = await fetchWithRetry(url, opts, "application/json");
  if (res.status !== 200 || !res.body) return null;
  try {
    return JSON.parse(res.body);
  } catch {
    return null;
  }
}

// One pi.dev catalog page holds 50 cards.
const CATALOG_PAGE_SIZE = 50;
// A page budget for the `?name=` walk. The filter matches name, description AND
// author, so a scoped package name normally resolves on page 1; anything longer
// than this is reported as undecided rather than as "no row".
const CATALOG_MAX_PAGES = 20;

/**
 * Whether a walked catalog page leaves more rows unread.
 *
 * Driven by the page counter when it is readable (with `0 / N` meaning "nothing
 * matched"), and by the page size otherwise.
 *
 * @param {{packages: Array<unknown>}|null} parsed
 * @param {{from: number, to: number, matched: number, total: number}|null} count
 */
export function catalogHasMorePages(parsed, count) {
  const rows = parsed?.packages?.length ?? 0;
  if (!count) return rows >= CATALOG_PAGE_SIZE;
  if (count.matched === 0) return false;
  const lastShown = Math.max(count.to, count.from + rows - 1);
  return count.matched > lastShown;
}

/**
 * Walk one `?name=` result set until the exact package name is found or the
 * whole result set has been read.
 *
 * A complete walk that does not contain the exact name is a decisive "not in
 * the catalog": the row's searchable text starts with the package name, so any
 * row that exists is matched by at least one of the query terms.
 *
 * @returns {Promise<{url: string, query: string, status: number, error: string|null, pages: number, member: boolean|null, found: object|null, count: object|null}>}
 */
async function walkCatalogQuery(query, name, opts) {
  const url = catalogListUrl(query);
  const base = {
    url,
    query,
    status: 0,
    error: null,
    pages: 0,
    member: null,
    found: null,
    count: null,
  };

  let firstCount = null;
  for (let page = 1; page <= CATALOG_MAX_PAGES; page++) {
    const pageUrl = page === 1 ? url : `${url}&page=${page}`;
    const res = await fetchWithRetry(pageUrl, opts);
    if (res.status === 0) {
      return { ...base, status: 0, error: res.error ?? null, pages: page - 1 };
    }
    if (res.status !== 200) {
      return { ...base, status: res.status, pages: page - 1 };
    }

    const parsed = parseCatalogList(res.body);
    if (!parsed.recognized) {
      // Markup drift: claim nothing.
      return { ...base, status: res.status, pages: page - 1 };
    }
    firstCount ??= parsed.count;

    const found = parsed.packages.find((entry) => entry.name === name);
    if (found) {
      return {
        ...base,
        status: res.status,
        pages: page,
        member: true,
        found,
        count: firstCount,
      };
    }

    if (!catalogHasMorePages(parsed, firstCount)) {
      // This page was the last one the filter matched: an exact-name miss is
      // now decisive, not merely "not seen yet".
      return {
        ...base,
        status: res.status,
        pages: page,
        member: false,
        count: firstCount,
      };
    }
  }

  // Ran out of page budget with rows still unread: undecided, not absent.
  return { ...base, status: 200, pages: CATALOG_MAX_PAGES, count: firstCount };
}

/**
 * Look a package up in the pi.dev catalog listing.
 *
 * Requests stay sequential and share the caller's timeout. The first query term
 * that gives a decisive answer (a hit, or a fully walked result set without the
 * package) ends the walk; otherwise the next term is tried.
 *
 * @returns {Promise<{url: string, query: string, status: number, error: string|null, pages: number, member: boolean|null, found: {name: string, downloads: number|null, date: number|null, types: string[]}|null, count: object|null}>}
 */
async function fetchCatalogList(name, opts) {
  const queries = catalogListQueries(name);
  let last = {
    url: catalogListUrl(queries[0] ?? name),
    query: queries[0] ?? name,
    status: 200,
    error: null,
    pages: 0,
    member: null,
    found: null,
    count: null,
  };

  for (const query of queries) {
    last = await walkCatalogQuery(query, name, opts);
    if (last.member !== null) return last;
  }
  return last;
}

function isPublished(name, version, dir) {
  const res = runNpm(
    ["view", "--prefer-online", `${name}@${version}`, "version"],
    dir,
  );
  return res.status === 0 && out(res).length > 0;
}

function latestPublished(name, dir) {
  const res = runNpm(["view", "--prefer-online", name, "version"], dir);
  return res.status === 0 ? out(res) : null;
}

// A version that was just published can take a moment to resolve on the
// registry, and the release flow queries the registry seconds earlier (its
// "not on npm" plan), which populates npm's local packument cache. Without
// --prefer-online (above) plus a couple of retries, the advisory gallery check
// that runs immediately after `npm publish` would claim the new version is
// missing and tell the user to publish it again.
const PUBLISH_CHECK_RETRIES = 2;
const PUBLISH_CHECK_DELAY_MS = 5000;

async function isPublishedWithRetry(pkg) {
  for (let attempt = 0; ; attempt++) {
    if (isPublished(pkg.name, pkg.version, pkg.dir)) return true;
    if (attempt >= PUBLISH_CHECK_RETRIES) return false;
    await sleep(PUBLISH_CHECK_DELAY_MS);
  }
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
    listMember: null,
    catalogRow: null,
    catalog: null,
    published: false,
    latest: null,
    status: "pending",
    notes: [],
  };

  base.published = eligible ? await isPublishedWithRetry(pkg) : false;

  let fetchStatus = 0;
  let fetchError = null;
  if (eligible && base.published) {
    // Signal 1: the detail page's Downloads row.
    const res = await fetchWithRetry(galleryUrl(pkg.name), opts);
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

    // Signal 2: the catalog listing itself (authoritative membership).
    const list = await fetchCatalogList(pkg.name, opts);
    base.catalog = {
      url: list.url,
      query: list.query,
      status: list.status,
      error: list.error,
      pages: list.pages,
      count: list.count,
    };
    base.listMember = list.member;
    base.catalogRow = list.found;
  }

  base.status = classifyGalleryStatus({
    eligible,
    published: base.published,
    membership: base.membership,
    version: pkg.version,
    galleryVersion: base.gallery?.version ?? null,
    listMember:
      eligible && base.published ? base.listMember : undefined,
  });

  if (base.status === "ineligible") {
    base.notes.push(
      'manifest keywords must include "pi-package" — the gallery catalog is built from npm search results for that keyword',
    );
  } else if (base.status === "missing") {
    base.notes.push(
      `not on the npm registry yet — if you just published, npm may still be propagating; otherwise publish it: npm run release -- --packages ${pkg.short} --bump none --yes`,
    );
  } else if (base.status === "unreachable") {
    const detailReadable = fetchStatus === 200 && Boolean(base.gallery?.listed);
    if (fetchStatus === 0) {
      base.notes.push(
        `pi.dev detail page request failed: ${fetchError ?? "unknown error"}`,
      );
    } else if (!detailReadable) {
      base.notes.push(
        'pi.dev detail page has no recognisable "Downloads" row — the page markup may have changed',
      );
    }

    if (base.catalog?.status === 0) {
      base.notes.push(
        `pi.dev catalog-listing request failed: ${base.catalog.error ?? "unknown error"}`,
      );
    } else if (base.catalog && base.catalog.status !== 200) {
      base.notes.push(
        `pi.dev catalog listing returned HTTP ${base.catalog.status}`,
      );
    } else if (base.listMember === null) {
      base.notes.push(
        `pi.dev catalog listing could not be read (markup drift, or more than ${CATALOG_MAX_PAGES} matching pages)`,
      );
    } else if (detailReadable && base.listMember === false) {
      base.notes.push(
        "the two pi.dev views disagree: the detail page shows download stats while the catalog listing has no row for it — re-run before acting on it",
      );
    }
    if (base.catalog?.url) base.notes.push(`check by hand: ${base.catalog.url}`);
  } else if (base.status === "not-indexed") {
    base.notes.push(
      'published and installable, but pi.dev has no gallery-catalog record for it — the catalog listing has no row and its detail page shows "Downloads: not available"',
    );
    base.notes.push(
      "the catalog is built from npm search results for keywords:pi-package, and pi.dev ingests only a bounded slice of them (npm's search API rolls over past from=5000, so roughly half of the matching packages are out of reach)",
    );
    base.notes.push(
      "that slice is NOT a pure downloads cut-off: the catalog holds packages with less npm traction than this one, so a missing row can be a per-package ingest gap rather than a ranking outcome — run --diagnose to see which case this is",
    );
    base.notes.push(
      "publishing a new version does not reliably change this — the bounded slice and the missing-row cases are tracked upstream (earendil-works/pi#6991, #7849, #7885, #7987, #8830)",
    );
    base.notes.push(
      `run npm run gallery -- --diagnose for the npm search-index figures and the catalog cut-off`,
    );
    base.notes.push(
      `check by hand: ${base.catalog?.url ?? `${GALLERY_BASE}/packages?name=${encodeURIComponent(pkg.name)}`}`,
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

// ── diagnose ───────────────────────────────────────────────────────────────

/**
 * Pure: the fields worth comparing out of one npm search response. Parsing is
 * defensive — the endpoint is undocumented and its shape may drift.
 *
 * @param {unknown} payload parsed JSON of `/-/v1/search`
 * @param {string} name exact package name to find in the results
 */
export function parseSearchRecord(payload, name) {
  const missing = {
    found: false,
    monthly: null,
    weekly: null,
    searchScore: null,
    date: null,
    version: null,
    keywords: [],
  };
  const objects = Array.isArray(payload?.objects) ? payload.objects : [];
  const hit = objects.find((entry) => entry?.package?.name === name);
  if (!hit) return missing;
  const pkg = hit.package ?? {};
  const num = (value) => (Number.isFinite(value) ? value : null);
  return {
    found: true,
    monthly: num(hit.downloads?.monthly),
    weekly: num(hit.downloads?.weekly),
    searchScore: num(hit.score?.final),
    date: typeof pkg.date === "string" ? pkg.date : null,
    version: typeof pkg.version === "string" ? pkg.version : null,
    keywords: Array.isArray(pkg.keywords) ? pkg.keywords.map(String) : [],
  };
}

/**
 * Pure: the download floor of a catalog page. The catalog is served sorted by
 * downloads, so its last page holds the lowest figure pi.dev has ingested — the
 * cut-off a package has to clear to be reached by the crawl.
 */
export function parseCatalogCutoff(parsed, page) {
  const rows = (parsed?.packages ?? []).filter(
    (entry) => entry.downloads != null,
  );
  if (!rows.length) return null;
  const downloads = rows.map((entry) => entry.downloads);
  return {
    page: page ?? null,
    rows: rows.length,
    min: Math.min(...downloads),
    max: Math.max(...downloads),
    count: parsed?.count ?? null,
  };
}

/**
 * Pure: why a package has (or has not) a catalog row.
 *
 * @param {{listMember: boolean|null, indexMonthly: number|null, cutoff: number|null}} facts
 * @returns {"member"|"no row (below window)"|"no row (unknown)"}
 */
export function diagnoseVerdict({ listMember, indexMonthly, cutoff }) {
  if (listMember === true) return "member";
  if (listMember === null) return "no row (unknown)";
  if (indexMonthly != null && cutoff != null && indexMonthly < cutoff) {
    return "no row (below window)";
  }
  return "no row (unknown)";
}

async function fetchSearchRecord(name, opts) {
  const payload = await fetchJsonOrNull(
    `${SEARCH_BASE}?text=${encodeURIComponent(name)}&size=1`,
    opts,
  );
  return payload ? parseSearchRecord(payload, name) : null;
}

async function fetchKeywordMatchCount(opts) {
  const payload = await fetchJsonOrNull(
    `${SEARCH_BASE}?text=${encodeURIComponent("keywords:pi-package")}&size=1`,
    opts,
  );
  return Number.isFinite(payload?.total) ? payload.total : null;
}

/**
 * Read the catalog's own cut-off: fetch the first page to learn its size, then
 * its last page (page number computed from the counter, never hardcoded).
 */
async function fetchCatalogCutoff(opts) {
  const first = await fetchWithRetry(`${GALLERY_BASE}/packages`, opts);
  if (first.status !== 200) return null;
  const parsed = parseCatalogList(first.body);
  const count = parsed.count;
  if (!count?.total) return null;
  const pageSize = parsed.packages.length || count.to - count.from + 1;
  const lastPage = Math.max(1, Math.ceil(count.total / Math.max(1, pageSize)));
  if (lastPage === 1) return parseCatalogCutoff(parsed, 1);

  const tail = await fetchWithRetry(
    `${GALLERY_BASE}/packages?page=${lastPage}`,
    opts,
  );
  if (tail.status !== 200) return null;
  return parseCatalogCutoff(parseCatalogList(tail.body), lastPage);
}

/** Collect the diagnose table for the checked packages (sequential requests). */
async function collectDiagnose(results, opts) {
  const cutoff = await fetchCatalogCutoff(opts);
  const keywordMatches = await fetchKeywordMatchCount(opts);

  const packages = [];
  for (const r of results) {
    const index = await fetchSearchRecord(r.name, opts);
    packages.push({
      short: r.short,
      name: r.name,
      version: r.version,
      status: r.status,
      listMember: r.listMember ?? null,
      catalogRow: r.catalogRow ?? null,
      catalogPages: r.catalog?.pages ?? 0,
      index,
      verdict: diagnoseVerdict({
        listMember: r.listMember ?? null,
        indexMonthly: index?.monthly ?? null,
        cutoff: cutoff?.min ?? null,
      }),
    });
  }

  const sorted = [...packages].sort((a, b) => {
    const av = a.index?.monthly;
    const bv = b.index?.monthly;
    if (av == null && bv == null) return a.name.localeCompare(b.name);
    if (av == null) return 1;
    if (bv == null) return -1;
    return bv - av;
  });

  return {
    measuredAt: new Date().toISOString(),
    cutoff,
    keywordMatches,
    catalogTotal: cutoff?.count?.total ?? null,
    packages: sorted,
  };
}

function catalogMemberLabel(listMember) {
  if (listMember === true) return "yes";
  if (listMember === false) return "no";
  return "?";
}

function printDiagnose(diag) {
  const header = ["package", "index/mo", "score", "row", "row/mo", "verdict"];
  const rows = diag.packages.map((p) => [
    p.name,
    p.index?.monthly != null ? String(p.index.monthly) : "?",
    p.index?.searchScore != null ? p.index.searchScore.toFixed(1) : "?",
    catalogMemberLabel(p.listMember),
    p.catalogRow?.downloads != null ? String(p.catalogRow.downloads) : "-",
    p.verdict,
  ]);
  const widths = header.map((cell, i) =>
    Math.max(cell.length, ...rows.map((row) => row[i].length)),
  );
  const line = (cells) =>
    cells.map((cell, i) => cell.padEnd(widths[i])).join("  ").trimEnd();

  console.log(`\nnpm search index vs pi.dev catalog — measured ${diag.measuredAt}`);
  console.log(line(header));
  console.log(line(widths.map((width) => "-".repeat(width))));
  for (const row of rows) console.log(line(row));

  console.log("");
  if (diag.cutoff) {
    console.log(
      `catalog cut-off: ~${diag.cutoff.min}/mo — lowest downloads figure on the catalog's last page (page ${diag.cutoff.page}, ${diag.cutoff.rows} rows, up to ${diag.cutoff.max}/mo)`,
    );
  } else {
    console.log("catalog cut-off: unreadable (pi.dev's catalog page could not be parsed)");
  }
  if (diag.catalogTotal != null) console.log(`catalog size: ${diag.catalogTotal} rows`);
  if (diag.keywordMatches != null) {
    console.log(
      `npm matches for keywords:pi-package: ${diag.keywordMatches} package(s)`,
    );
  }
  if (diag.keywordMatches != null && diag.catalogTotal != null) {
    const unreached = diag.keywordMatches - diag.catalogTotal;
    if (unreached > 0) {
      console.log(
        `not ingested: ~${unreached} matching package(s) have no catalog row`,
      );
    }
  }
  console.log(
    '\n"row" is the catalog listing (authoritative membership); "row/mo" is the figure pi.dev stored for it.',
  );
  console.log(
    '"below window" means the package\'s npm search-index download figure sits under the cut-off, so pi.dev\'s bounded crawl does not reach it — see docs/gallery-membership.md.',
  );
  const aboveCutoff = diag.packages.filter(
    (p) =>
      p.listMember === false &&
      p.index?.monthly != null &&
      diag.cutoff?.min != null &&
      p.index.monthly >= diag.cutoff.min,
  );
  if (aboveCutoff.length) {
    console.log(
      `"no row (unknown)" with a figure at or above the cut-off means the cut-off does not explain the absence — the catalog holds packages with less traction than ${aboveCutoff
        .map((p) => p.name)
        .join(", ")}, so this is a per-package ingest gap: report it (docs/gallery-membership.md → Escalating).`,
    );
  }
}

// ── main ───────────────────────────────────────────────────────────────────

const HELP = [
  "Usage: npm run gallery -- [options]",
  "",
  "  --packages a,b     packages to check (default: all)",
  "  --wait <sec>       keep polling until every package is listed (default: 0 = one shot)",
  "  --interval <sec>   seconds between polling attempts (default: 30)",
  "  --timeout <sec>    pi.dev request timeout (default: 15)",
  "  --diagnose         explain each verdict: npm search-index figures, catalog row",
  "                     stats and the catalog's download cut-off",
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
    else if (arg === "--diagnose") opts.diagnose = true;
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
    r.catalogRow?.downloads != null
      ? `catalog row: ${r.catalogRow.downloads}/mo`
      : null,
    r.gallery?.published ? `published ${r.gallery.published}` : null,
  ]
    .filter(Boolean)
    .join(", ");
}

const STATUS_DETAIL = {
  ok: catalogDetail,
  stale: catalogDetail,
  "not-indexed": () =>
    "published, but not in the pi.dev gallery catalog (no catalog row; detail page: Downloads: not available)",
  missing: () => "not published on npm",
  unreachable: () => "pi.dev could not be read unambiguously",
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

  if (opts.diagnose) {
    // Printed once, after the polling loop has settled on a verdict.
    const diag = await collectDiagnose(results, opts);
    if (opts.json) {
      console.log(JSON.stringify({ packages: results, diagnose: diag }, null, 2));
    } else {
      report(results);
      printDiagnose(diag);
    }
  } else if (opts.json) {
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
