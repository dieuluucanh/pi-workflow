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
 classifyGalleryStatus,
 galleryMembership,
 galleryUrl,
 parseGalleryPage,
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
