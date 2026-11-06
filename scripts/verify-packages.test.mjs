#!/usr/bin/env node
/**
 * verify-packages.test.mjs — unit tests for the packed-import closure check.
 *
 * Pure logic only: every case is an in-memory packed file set, so no npm, no
 * tarball and no package install is involved.
 *
 *   node --test scripts/verify-packages.test.mjs     # also runs via `npm test`
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { findMissingPackedImports, resolvePackedTarget } from "./verify-packages.mjs";

/** Read a file from the in-memory map, failing loudly on an unexpected path. */
function reader(files) {
  return (rel) => {
    if (!Object.prototype.hasOwnProperty.call(files, rel)) {
      throw new Error(`unexpected read: ${rel}`);
    }
    return files[rel];
  };
}

function missingFor(files) {
  return findMissingPackedImports(Object.keys(files), reader(files));
}

// ── complete packages ──────────────────────────────────────────────────────

test("closure: a complete package has no missing imports", () => {
  const files = {
    "index.ts": [
      'import { a } from "./a.ts";',
      'export { b } from "./b.ts";',
      'import "./side-effect.ts";',
    ].join("\n"),
    "a.ts": 'import { b } from "./b.ts";',
    "b.ts": "export const b = 1;",
    "side-effect.ts": "export {};",
  };
  assert.deepEqual(missingFor(files), []);
});

test("closure: an extensionless specifier resolves to a packed .ts file", () => {
  const files = {
    "index.ts": 'import { a } from "./a";',
    "a.ts": "export const a = 1;",
  };
  assert.deepEqual(missingFor(files), []);
});

test("closure: a .js specifier resolves to a packed .ts file", () => {
  const files = {
    "index.ts": 'import { a } from "./a.js";',
    "a.ts": "export const a = 1;",
  };
  assert.deepEqual(missingFor(files), []);
});

test("closure: nested relative imports resolve inside the package", () => {
  const files = {
    "index.ts": 'import { a } from "./lib/a.ts";',
    "lib/a.ts": 'import { b } from "./b.ts";',
    "lib/b.ts": "export const b = 1;",
  };
  assert.deepEqual(missingFor(files), []);
});

test("closure: a directory specifier resolves to its packed index.ts", () => {
  const files = {
    "index.ts": 'import { a } from "./lib";',
    "lib/index.ts": "export const a = 1;",
  };
  assert.deepEqual(missingFor(files), []);
});

test("closure: non-relative imports are ignored", () => {
  const files = {
    "index.ts": ['import fs from "node:fs";', 'import { x } from "@scope/pkg";'].join(
      "\n",
    ),
  };
  assert.deepEqual(missingFor(files), []);
});

// ── missing targets ────────────────────────────────────────────────────────

test("closure: a missing static import is reported", () => {
  const files = {
    "index.ts": 'import { a } from "./thinking-levels.ts";',
  };
  assert.deepEqual(missingFor(files), [
    { from: "index.ts", spec: "./thinking-levels.ts" },
  ]);
});

test("closure: a missing bare side-effect import is reported", () => {
  const files = {
    "index.ts": 'import "./workflow-status.ts";',
  };
  assert.deepEqual(missingFor(files), [
    { from: "index.ts", spec: "./workflow-status.ts" },
  ]);
});

test("closure: a missing dynamic import is reported", () => {
  const files = {
    "index.ts": 'const mod = await import("./lazy.ts");',
  };
  assert.deepEqual(missingFor(files), [{ from: "index.ts", spec: "./lazy.ts" }]);
});

test("closure: a missing nested import is reported", () => {
  const files = {
    "index.ts": 'import { a } from "./lib/a.ts";',
    "lib/a.ts": 'import { b } from "./b.ts";',
  };
  assert.deepEqual(missingFor(files), [
    { from: "lib/a.ts", spec: "./b.ts" },
  ]);
});

test("closure: backslash separators are normalised", () => {
  const files = {
    "index.ts": 'import { a } from "./lib\\\\a.ts";',
    "lib/a.ts": "export const a = 1;",
  };
  assert.deepEqual(findMissingPackedImports(["index.ts", "lib\\a.ts"], reader(files)), []);
});

// ── resolver unit cases ────────────────────────────────────────────────────

test("resolvePackedTarget: returns null when no candidate is packed", () => {
  assert.equal(
    resolvePackedTarget("index.ts", "./missing.ts", new Set(["index.ts"])),
    null,
  );
});

test("resolvePackedTarget: prefers the exact packed path", () => {
  assert.equal(
    resolvePackedTarget("index.ts", "./a.ts", new Set(["a.ts", "a.ts/index.ts"])),
    "a.ts",
  );
});
