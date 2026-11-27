#!/usr/bin/env node
/**
 * check-gallery.test.mjs — unit tests for the pi.dev detail-page parser, the
 * catalog-membership helper and the status classifier.
 *
 *   npm test
 *   node --test scripts/check-gallery.test.mjs
 *
 * The fixtures mirror the real markup: a package detail page renders a
 * `<dl class="definition-grid detail-grid">` inside `packages-detail-view`;
 * a missing package returns a page with no such grid. pi.dev fills the
 * `Downloads` row from its crawled catalog snapshot, so `not available` means
 * "no catalog record" while a numeric value means "in the gallery catalog".
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  catalogHasMorePages,
  catalogIncludes,
  catalogListQueries,
  catalogListUrl,
  classifyGalleryStatus,
  diagnoseVerdict,
  galleryMembership,
  galleryUrl,
  parseCatalogCount,
  parseCatalogCutoff,
  parseCatalogList,
  parseGalleryPage,
  parseSearchRecord,
} from "./check-gallery.mjs";

// Trimmed but structurally faithful copy of
// https://pi.dev/packages/@dieulc/pi-office-bridge (catalogued, 441 downloads)
const CATALOGUED_PAGE = `<!DOCTYPE html><html lang="en"><head><title>@dieulc/pi-office-bridge · Packages · Pi</title></head>
<body><main class="content-shell packages-dashboard packages-detail-view">
<header class="content-hero"><h1 class="content-title">@dieulc/pi-office-bridge</h1></header>
<section class="surface-panel content-card packages-detail-card"><div class="content-card-body">
<div id="package-details" class="packages-detail-topline"><div class="packages-badges"><span class="meta-chip packages-badge" data-type="extension">extension</span></div></div>
<dl class="definition-grid detail-grid"><dt>Package</dt><dd><code>@dieulc/pi-office-bridge</code></dd><dt>Version</dt><dd><code>0.5.0</code></dd><dt>Published</dt><dd>Sep 19, 2026</dd><dt>Downloads</dt><dd>441/mo &middot; 247/wk</dd><dt>Author</dt><dd>dieulc</dd><dt>License</dt><dd>MIT</dd><dt>Types</dt><dd>extension</dd><dt>Size</dt><dd>85.2 KB</dd><dt>Dependencies</dt><dd>3 dependencies &amp; 2 peers</dd></dl>
</div></section></main></body></html>`;

// Faithful shape of https://pi.dev/packages/@dieulc/workflow on 2026-09-19/20:
// a live detail page for a package pi.dev has never put in the catalog.
const UNCATALOGUED_PAGE = `<!DOCTYPE html><html lang="en"><head><title>@dieulc/workflow · Packages · Pi</title></head>
<body><main class="content-shell packages-dashboard packages-detail-view">
<header class="content-hero"><h1 class="content-title">@dieulc/workflow</h1></header>
<section class="surface-panel content-card packages-detail-card"><div class="content-card-body">
<div id="package-details" class="packages-detail-topline"><div class="packages-badges"><span class="meta-chip packages-badge" data-type="extension">extension</span></div></div>
<dl class="definition-grid detail-grid"><dt>Package</dt><dd><code>@dieulc/workflow</code></dd><dt>Version</dt><dd><code>0.3.0</code></dd><dt>Published</dt><dd>Sep 19, 2026</dd><dt>Downloads</dt><dd>not available</dd><dt>Author</dt><dd>dieulc</dd><dt>License</dt><dd>MIT</dd><dt>Types</dt><dd>extension</dd><dt>Size</dt><dd>487.1 KB</dd><dt>Dependencies</dt><dd>0 dependencies &middot; 5 peers</dd></dl>
</div></section></main></body></html>`;

// A detail page whose grid has no Downloads row at all (markup drift).
const NO_DOWNLOADS_ROW_PAGE = `<main class="packages-detail-view"><dl class="definition-grid detail-grid"><dt>Package</dt><dd><code>@scope/pkg</code></dd><dt>Version</dt><dd><code>1.0.0</code></dd></dl></main>`;

const NOT_FOUND_PAGE = `<!DOCTYPE html><html lang="en"><head><title>Not Found · Pi</title></head>
<body><main class="content-shell"><header class="content-hero"><h1 class="content-title">Page not found</h1></header></main></body></html>`;

test("parses the version, date and types from a catalogued detail page", () => {
 const page = parseGalleryPage(CATALOGUED_PAGE);
 // `listed` here only means "pi.dev renders a detail page for this package" —
 // catalog membership comes from galleryMembership(page.downloads).
 assert.equal(page.listed, true);
 assert.equal(page.name, "@dieulc/pi-office-bridge");
 assert.equal(page.version, "0.5.0");
 assert.equal(page.published, "Sep 19, 2026");
 assert.equal(page.types, "extension");
 assert.equal(page.author, "dieulc");
 assert.equal(page.downloads, "441/mo · 247/wk");
});

test("decodes entities in detail values", () => {
 const page = parseGalleryPage(CATALOGUED_PAGE);
 assert.equal(page.downloads, "441/mo · 247/wk");
});

test("decodes named and numeric entities", () => {
 const html = `<main class="packages-detail-view"><dl class="definition-grid detail-grid"><dt>Package</dt><dd><code>@scope/pkg</code></dd><dt>Version</dt><dd><code>1.0.0</code></dd><dt>Types</dt><dd>extension &amp; skill &#183; 2 &quot;peers&quot;</dd></dl></main>`;
 const page = parseGalleryPage(html);
 assert.equal(page.types, 'extension & skill · 2 "peers"');
});

test("treats a page without the detail grid as not listed", () => {
 const page = parseGalleryPage(NOT_FOUND_PAGE);
 assert.equal(page.listed, false);
 assert.equal(page.version, null);
 assert.equal(page.name, null);
});

test("treats an empty body as not listed", () => {
 assert.equal(parseGalleryPage("").listed, false);
 assert.equal(parseGalleryPage(undefined).listed, false);
});

test("keeps scoped names unencoded in the gallery URL", () => {
 assert.equal(
  galleryUrl("@dieulc/workflow"),
  "https://pi.dev/packages/@dieulc/workflow",
 );
 assert.equal(galleryUrl("pi-lens"), "https://pi.dev/packages/pi-lens");
});

test("galleryMembership: a numeric Downloads row means catalogued", () => {
 assert.equal(galleryMembership("441/mo · 247/wk"), "listed");
 assert.equal(galleryMembership("124/mo"), "listed");
 assert.equal(galleryMembership("0/mo"), "listed");
});

test("galleryMembership: 'not available' means no catalog row", () => {
 assert.equal(galleryMembership("not available"), "unlisted");
 assert.equal(galleryMembership("  NOT   Available "), "unlisted");
});

test("galleryMembership: unreadable or absent values are unknown", () => {
 assert.equal(galleryMembership(null), "unknown");
 assert.equal(galleryMembership(undefined), "unknown");
 assert.equal(galleryMembership(""), "unknown");
 assert.equal(galleryMembership("   "), "unknown");
 assert.equal(galleryMembership("n/a"), "unknown");
});

test("classifies a catalogued package at the manifest version as ok", () => {
 const page = parseGalleryPage(CATALOGUED_PAGE);
 assert.equal(
  classifyGalleryStatus({
   eligible: true,
   published: true,
   membership: galleryMembership(page.downloads),
   version: "0.5.0",
   galleryVersion: page.version,
  }),
  "ok",
 );
});

test("classifies a catalogued package on an older card as stale", () => {
 const page = parseGalleryPage(CATALOGUED_PAGE);
 assert.equal(
  classifyGalleryStatus({
   eligible: true,
   published: true,
   membership: galleryMembership(page.downloads),
   version: "0.6.0",
   galleryVersion: page.version,
  }),
  "stale",
 );
});

test("classifies a live detail page with 'Downloads: not available' as not-indexed", () => {
 // The regression that produced the misleading "3/4 listed" report: the detail
 // page exists (200, full grid) but pi.dev has no catalog record for it.
 const page = parseGalleryPage(UNCATALOGUED_PAGE);
 assert.equal(page.listed, true);
 assert.equal(page.downloads, "not available");
 assert.equal(
  classifyGalleryStatus({
   eligible: true,
   published: true,
   membership: galleryMembership(page.downloads),
   version: "0.3.0",
   galleryVersion: page.version,
  }),
  "not-indexed",
 );
});

test("classifies a page without a Downloads row as unreachable, never not-indexed", () => {
 const page = parseGalleryPage(NO_DOWNLOADS_ROW_PAGE);
 assert.equal(page.downloads, null);
 assert.equal(galleryMembership(page.downloads), "unknown");
 assert.equal(
  classifyGalleryStatus({
   eligible: true,
   published: true,
   membership: galleryMembership(page.downloads),
   version: "1.0.0",
   galleryVersion: page.version,
  }),
  "unreachable",
 );
});

test("classifies ineligible and unpublished packages before membership", () => {
 assert.equal(
  classifyGalleryStatus({
   eligible: false,
   published: false,
   membership: "unlisted",
   version: "1.0.0",
   galleryVersion: null,
  }),
  "ineligible",
 );
 assert.equal(
  classifyGalleryStatus({
   eligible: true,
   published: false,
   membership: null,
   version: "1.0.0",
   galleryVersion: null,
  }),
  "missing",
 );
});

// ── catalog listing (the authoritative membership signal) ──────────────────

// One card of the real listing, with the attribute set pi.dev emits. Attribute
// order and names mirror https://pi.dev/packages?name=dieulc (2026-09-20).
function card(name, downloads, date, types = "") {
 return `<article class="surface-panel content-card" data-package-card="true" data-package-name="${name}" data-package-search="${name} some description dieulc" data-package-types="${types}" data-package-downloads="${downloads}" data-package-date="${date}" data-package-sort-name="${name}"><div class="packages-card-body"><h3 class="packages-name"><a href="/packages/${name}" data-package-link="true" data-package-path="/packages/${name}">${name}</a></h3></div></article>`;
}

function catalogPage(cards, counter) {
 return `<!DOCTYPE html><html><body><main class="packages-dashboard">
<section class="surface-panel content-card packages-index-card"><header class="content-card-header"><h2 class="content-card-title">All packages</h2><div class="content-card-actions"><span class="packages-count">${counter}</span></div></header><div class="content-card-body">${cards.join("")}</div></section>
</main></body></html>`;
}

// The real `?name=dieulc` result on 2026-09-20: four rows, and
// `@dieulc/workflow` is not one of them.
const DIEULC_LISTING = catalogPage(
 [
  card("@dieulc/pi-office-bridge", 441, 1789825125584, "extension"),
  card("@dieulc/autocompact", 175, 1789885625038),
  card("@dieulc/server-logs", 110, 1789885589513),
  card("@dieulc/browser-inspector", 107, 1789885586119),
 ],
 "1-4 / 4 (of 5374)",
);

const LISTING_PAGE_1 = catalogPage(
 Array.from({ length: 50 }, (_, i) => card(`filler-${i}`, 500 - i, 1789000000000)),
 "1-50 / 317 (of 5374)",
);

const LISTING_PAGE_2 = catalogPage(
 [
  card("@dieulc/workflow", 104, 1789885593115, "extension"),
  ...Array.from({ length: 49 }, (_, i) => card(`filler-${i}`, 400 - i, 1789000000000)),
 ],
 "51-100 / 317 (of 5374)",
);

const EMPTY_LISTING = catalogPage([], "0 / 5374");
const DRIFTED_LISTING =
 "<!DOCTYPE html><html><body><main><h1>Package Catalog</h1><p>temporarily unavailable</p></main></body></html>";

test("parseCatalogCount reads all three counter shapes", () => {
 assert.deepEqual(parseCatalogCount("1-4 / 4 (of 5374)"), {
  from: 1,
  to: 4,
  matched: 4,
  total: 5374,
 });
 assert.deepEqual(parseCatalogCount("5351-5374 / 5374"), {
  from: 5351,
  to: 5374,
  matched: 5374,
  total: 5374,
 });
 assert.deepEqual(parseCatalogCount("0 / 5374"), {
  from: 0,
  to: 0,
  matched: 0,
  total: 5374,
 });
 assert.equal(parseCatalogCount(""), null);
 assert.equal(parseCatalogCount("many packages"), null);
});

test("parseCatalogList extracts cards, their crawled figures and the counter", () => {
 const parsed = parseCatalogList(DIEULC_LISTING);
 assert.equal(parsed.recognized, true);
 assert.deepEqual(parsed.count, { from: 1, to: 4, matched: 4, total: 5374 });
 assert.deepEqual(
  parsed.packages.map((p) => p.name),
  [
   "@dieulc/pi-office-bridge",
   "@dieulc/autocompact",
   "@dieulc/server-logs",
   "@dieulc/browser-inspector",
  ],
 );
 assert.deepEqual(parsed.packages[0], {
  name: "@dieulc/pi-office-bridge",
  downloads: 441,
  date: 1789825125584,
  types: ["extension"],
 });
 // A card with no type keyword, exactly as pi.dev renders it for these.
 assert.deepEqual(parsed.packages[1].types, []);
 assert.equal(parsed.packages[1].downloads, 175);
});

test("parseCatalogList is decisive about absence, and never throws on drift", () => {
 const parsed = parseCatalogList(DIEULC_LISTING);
 assert.equal(catalogIncludes(parsed, "@dieulc/autocompact"), true);
 // The finding this whole check exists for.
 assert.equal(catalogIncludes(parsed, "@dieulc/workflow"), false);

 const empty = parseCatalogList(EMPTY_LISTING);
 assert.equal(empty.recognized, true);
 assert.deepEqual(empty.count, { from: 0, to: 0, matched: 0, total: 5374 });
 assert.deepEqual(empty.packages, []);

 const drifted = parseCatalogList(DRIFTED_LISTING);
 assert.equal(drifted.recognized, false);
 assert.equal(drifted.count, null);
 assert.deepEqual(drifted.packages, []);
 assert.equal(catalogIncludes(drifted, "@dieulc/workflow"), false);
 assert.equal(catalogIncludes(null, "@dieulc/workflow"), false);
 assert.equal(parseCatalogList(undefined).recognized, false);
});

test("a filter term is required: scoped names are looked up by scope, then basename", () => {
 // `?name=@dieulc/workflow` matches nothing at all — pi.dev does not match the
 // full scoped form, so the walker must not use the raw package name.
 assert.deepEqual(catalogListQueries("@dieulc/workflow"), ["dieulc", "workflow"]);
 assert.deepEqual(catalogListQueries("server-logs"), ["server-logs"]);
 assert.deepEqual(catalogListQueries("@scope/name"), ["scope", "name"]);
 assert.deepEqual(catalogListQueries(""), []);
 assert.equal(catalogListUrl("dieulc"), "https://pi.dev/packages?name=dieulc");
 assert.equal(
  catalogListUrl("@dieulc/workflow"),
  "https://pi.dev/packages?name=%40dieulc%2Fworkflow",
 );
});

test("pagination stops only on the last matching page", () => {
 // 317 matched, 50 shown → keep walking, so the package can be found on page 2.
 assert.equal(catalogHasMorePages(parseCatalogList(LISTING_PAGE_1), parseCatalogList(LISTING_PAGE_1).count), true);
 assert.equal(catalogIncludes(parseCatalogList(LISTING_PAGE_2), "@dieulc/workflow"), true);
 // 51-100 of 317: still more to read.
 assert.equal(catalogHasMorePages(parseCatalogList(LISTING_PAGE_2), parseCatalogList(LISTING_PAGE_2).count), true);
 // A one-page result set is complete, so a miss there is decisive.
 assert.equal(catalogHasMorePages(parseCatalogList(DIEULC_LISTING), parseCatalogList(DIEULC_LISTING).count), false);
 // Nothing matched at all.
 assert.equal(catalogHasMorePages(parseCatalogList(EMPTY_LISTING), parseCatalogList(EMPTY_LISTING).count), false);
 // No counter at all: fall back to the page size.
 assert.equal(catalogHasMorePages({ packages: new Array(50).fill({}) }, null), true);
 assert.equal(catalogHasMorePages({ packages: new Array(3).fill({}) }, null), false);
});

// ── agreement between the two signals ─────────────────────────────────────

test("both signals agreeing that a package is catalogued yields ok or stale", () => {
 const page = parseGalleryPage(CATALOGUED_PAGE);
 const base = {
  eligible: true,
  published: true,
  membership: galleryMembership(page.downloads),
  galleryVersion: page.version,
  listMember: true,
 };
 assert.equal(classifyGalleryStatus({ ...base, version: "0.5.0" }), "ok");
 assert.equal(classifyGalleryStatus({ ...base, version: "0.6.0" }), "stale");
});

test("both signals agreeing that there is no row yields not-indexed", () => {
 const page = parseGalleryPage(UNCATALOGUED_PAGE);
 assert.equal(
  classifyGalleryStatus({
   eligible: true,
   published: true,
   membership: galleryMembership(page.downloads),
   version: "0.3.1",
   galleryVersion: page.version,
   listMember: false,
  }),
  "not-indexed",
 );
});

test("a disagreement between the two signals is unreachable, never not-indexed", () => {
 const catalogued = parseGalleryPage(CATALOGUED_PAGE);
 const uncatalogued = parseGalleryPage(UNCATALOGUED_PAGE);

 // Listing has a row, the detail page says "not available".
 assert.equal(
  classifyGalleryStatus({
   eligible: true,
   published: true,
   membership: galleryMembership(uncatalogued.downloads),
   version: "0.3.1",
   galleryVersion: uncatalogued.version,
   listMember: true,
  }),
  "unreachable",
 );
 // Listing has no row, the detail page shows download stats.
 assert.equal(
  classifyGalleryStatus({
   eligible: true,
   published: true,
   membership: galleryMembership(catalogued.downloads),
   version: "0.5.0",
   galleryVersion: catalogued.version,
   listMember: false,
  }),
  "unreachable",
 );
 // Listed by both, but the detail page had no readable version.
 assert.equal(
  classifyGalleryStatus({
   eligible: true,
   published: true,
   membership: "listed",
   version: "0.5.0",
   galleryVersion: null,
   listMember: true,
  }),
  "unreachable",
 );
});

test("an unreadable listing signal is unreachable, never a confident miss", () => {
 for (const listMember of [null]) {
  assert.equal(
   classifyGalleryStatus({
    eligible: true,
    published: true,
    membership: "unlisted",
    version: "0.3.1",
    galleryVersion: "0.3.1",
    listMember,
   }),
   "unreachable",
  );
 }
 // Omitting the key entirely keeps the legacy single-signal behaviour, which
 // the reported-status tests above cover.
 assert.equal(
  classifyGalleryStatus({
   eligible: true,
   published: true,
   membership: "unlisted",
   version: "0.3.1",
   galleryVersion: "0.3.1",
  }),
  "not-indexed",
 );
});

// ── diagnose ──────────────────────────────────────────────────────────────

// One object of the real `/-/v1/search?text=@dieulc/workflow&size=1` response
// (2026-09-20), trimmed to the fields the diagnose mode reads.
const SEARCH_RESPONSE = {
 objects: [
  {
   downloads: { monthly: 104, weekly: 104 },
   dependents: 0,
   updated: "2026-09-20T06:27:03.968Z",
   searchScore: 539.5408,
   package: {
    name: "@dieulc/workflow",
    keywords: ["pi-package", "workflow", "plan-mode"],
    version: "0.3.1",
    description: "Plan↔Build mode …",
    date: "2026-09-20T06:26:33.115Z",
   },
   score: { final: 539.5408, detail: { popularity: 1, quality: 1, maintenance: 1 } },
  },
 ],
 total: 94307,
};

test("parseSearchRecord reads the index figures defensively", () => {
 const record = parseSearchRecord(SEARCH_RESPONSE, "@dieulc/workflow");
 assert.equal(record.found, true);
 assert.equal(record.monthly, 104);
 assert.equal(record.weekly, 104);
 assert.equal(record.searchScore, 539.5408);
 assert.equal(record.date, "2026-09-20T06:26:33.115Z");
 assert.equal(record.version, "0.3.1");
 assert.equal(record.keywords.includes("pi-package"), true);

 // A name that is not in the response, and every malformed shape.
 assert.equal(parseSearchRecord(SEARCH_RESPONSE, "@dieulc/other").found, false);
 assert.equal(parseSearchRecord(SEARCH_RESPONSE, "@dieulc/other").monthly, null);
 for (const payload of [null, undefined, {}, { objects: null }, { objects: [{}] }, "html"]) {
  const missing = parseSearchRecord(payload, "@dieulc/workflow");
  assert.equal(missing.found, false);
  assert.equal(missing.monthly, null);
  assert.deepEqual(missing.keywords, []);
 }
});

test("parseCatalogCutoff reports the floor of the catalog's last page", () => {
 const tail = parseCatalogList(
  catalogPage(
   [card("a", 96, 1), card("b", 87, 2), card("c", 90, 3)],
   "5351-5353 / 5353",
  ),
 );
 assert.deepEqual(parseCatalogCutoff(tail, 108), {
  page: 108,
  rows: 3,
  min: 87,
  max: 96,
  count: { from: 5351, to: 5353, matched: 5353, total: 5353 },
 });
 // Cards without a readable figure are ignored; no figures at all is null.
 const partial = parseCatalogList(
  `<span class="packages-count">1-1 / 1</span><article data-package-card="true" data-package-name="x" data-package-downloads=""></article>`,
 );
 assert.equal(parseCatalogCutoff(partial, 2), null);
 assert.equal(parseCatalogCutoff(parseCatalogList(EMPTY_LISTING), 108), null);
 assert.equal(parseCatalogCutoff(null, 108), null);
});

test("diagnoseVerdict names the reason a package has no row", () => {
 const member = diagnoseVerdict({ listMember: true, indexMonthly: 441, cutoff: 87 });
 assert.equal(member, "member");
 // Below the floor pi.dev ingested → the bounded window explains it.
 assert.equal(
  diagnoseVerdict({ listMember: false, indexMonthly: 51, cutoff: 87 }),
  "no row (below window)",
 );
 // Above the floor but still absent → the cut-off does NOT explain it, and the
 // verdict must not pretend it does (this is @dieulc/workflow's case).
 assert.equal(
  diagnoseVerdict({ listMember: false, indexMonthly: 104, cutoff: 87 }),
  "no row (unknown)",
 );
 assert.equal(
  diagnoseVerdict({ listMember: false, indexMonthly: null, cutoff: 87 }),
  "no row (unknown)",
 );
 assert.equal(
  diagnoseVerdict({ listMember: false, indexMonthly: 104, cutoff: null }),
  "no row (unknown)",
 );
 assert.equal(
  diagnoseVerdict({ listMember: null, indexMonthly: 104, cutoff: 87 }),
  "no row (unknown)",
 );
});
