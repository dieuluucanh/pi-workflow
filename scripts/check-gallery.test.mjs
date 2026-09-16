#!/usr/bin/env node
/**
 * check-gallery.test.mjs — unit tests for the pi.dev gallery page parser.
 *
 *   npm test
 *   node --test scripts/check-gallery.test.mjs
 *
 * The fixtures mirror the real markup: a package detail page renders a
 * `<dl class="definition-grid detail-grid">` inside `packages-detail-view`;
 * a missing package returns a page with no such grid.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { galleryUrl, parseGalleryPage } from "./check-gallery.mjs";

// Trimmed but structurally faithful copy of
// https://pi.dev/packages/@dieulc/pi-office-bridge
const LISTED_PAGE = `<!DOCTYPE html><html lang="en"><head><title>@dieulc/pi-office-bridge · Packages · Pi</title></head>
<body><main class="content-shell packages-dashboard packages-detail-view">
<header class="content-hero"><h1 class="content-title">@dieulc/pi-office-bridge</h1></header>
<section class="surface-panel content-card packages-detail-card"><div class="content-card-body">
<div id="package-details" class="packages-detail-topline"><div class="packages-badges"><span class="meta-chip packages-badge" data-type="extension">extension</span></div></div>
<dl class="definition-grid detail-grid"><dt>Package</dt><dd><code>@dieulc/pi-office-bridge</code></dd><dt>Version</dt><dd><code>0.4.1</code></dd><dt>Published</dt><dd>Sep 15, 2026</dd><dt>Downloads</dt><dd>194/mo &middot; 194/wk</dd><dt>Author</dt><dd>dieulc</dd><dt>License</dt><dd>MIT</dd><dt>Types</dt><dd>extension</dd><dt>Size</dt><dd>79.3 KB</dd><dt>Dependencies</dt><dd>3 dependencies &amp; 2 peers</dd></dl>
</div></section></main></body></html>`;

const NOT_FOUND_PAGE = `<!DOCTYPE html><html lang="en"><head><title>Not Found · Pi</title></head>
<body><main class="content-shell"><header class="content-hero"><h1 class="content-title">Page not found</h1></header></main></body></html>`;

test("parses the version, date and types from a listed package page", () => {
  const page = parseGalleryPage(LISTED_PAGE);
  assert.equal(page.listed, true);
  assert.equal(page.name, "@dieulc/pi-office-bridge");
  assert.equal(page.version, "0.4.1");
  assert.equal(page.published, "Sep 15, 2026");
  assert.equal(page.types, "extension");
  assert.equal(page.author, "dieulc");
  assert.equal(page.downloads, "194/mo · 194/wk");
});

test("decodes entities in detail values", () => {
  const page = parseGalleryPage(LISTED_PAGE);
  assert.equal(page.downloads, "194/mo · 194/wk");
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
