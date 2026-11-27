#!/usr/bin/env node
/**
 * Row-16 acceptance check for the Desktop (D) deliverable.
 *
 * The Orchestrator run's measured workspace is W (`C:/Users/Lenovo/.pi`), while
 * the row's code lands in the Desktop repository
 * (`C:/Users/Lenovo/Projects/pi-desktop`). That repository is not a run root, so
 * the parent's workspace-diff gate cannot see the D files. This W-side check
 * records and verifies the concrete row-16 deliverable without duplicating D's
 * runtime code:
 *
 *   - the renderer-safe composer-control projection and per-tab operation
 *     reducer exist and export the expected surface;
 *   - descriptor/binding generations, publisher withdrawal, multiple-armed
 *     conflicts and old/unknown-frame tolerance are covered by tests;
 *   - `command.args` remain host-owned and are never spread into renderer
 *     snapshots;
 *   - the generic runtime contains no extension identifier.
 *
 * Usage:
 *   node scripts/verify-desktop-composer-operation.mjs [desktop-root]
 *   PI_DESKTOP_ROOT=/path/to/pi-desktop node scripts/...
 *
 * Exits 0 with an explicit SKIP when the Desktop checkout is absent, so the W
 * package gates stay portable. Exits 1 on a real missing/incomplete deliverable.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const candidates = [
  process.argv[2],
  process.env.PI_DESKTOP_ROOT,
  resolve(here, "..", "..", "Projects", "pi-desktop"),
  join(homedir(), "Projects", "pi-desktop"),
].filter((value) => typeof value === "string" && value.length > 0);

const desktopRoot = candidates.find((candidate) => existsSync(join(candidate, "package.json")));

if (!desktopRoot) {
  console.log(
    "SKIP desktop composer-operation acceptance: no Desktop checkout found " +
      "(pass a path or set PI_DESKTOP_ROOT).",
  );
  process.exit(0);
}

const failures = [];

function read(relativePath) {
  const path = join(desktopRoot, relativePath);
  if (!existsSync(path)) {
    failures.push(`missing ${relativePath}`);
    return "";
  }
  return readFileSync(path, "utf8");
}

function requireText(relativePath, needle, label) {
  const source = read(relativePath);
  if (source.length > 0 && !source.includes(needle)) {
    failures.push(`${relativePath}: ${label ?? `missing ${JSON.stringify(needle)}`}`);
  }
}

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

const OPERATION = "src/shared/composer-operation.ts";
const OPERATION_TEST = "tests/shared/composer-operation.test.ts";
const VIEW = "src/shared/extension-contributions-view.ts";
const VIEW_TEST = "tests/shared/extension-contributions-view.test.ts";
const HOST_TEST = "tests/host/contributions.test.ts";

const operationSource = read(OPERATION);
read(OPERATION_TEST);
read(VIEW);
read(VIEW_TEST);
read(HOST_TEST);

for (const symbol of [
  "export function projectComposerControls",
  "export function deriveComposerOperation",
  "export function reduceComposerOperation",
  "export function reduceComposerOperationForTab",
  "export function dropComposerOperationTab",
  "descriptorGeneration",
  "ComposerBindingGeneration",
]) {
  requireText(OPERATION, symbol, `missing exported surface ${symbol}`);
}

if (operationSource.length > 0 && /workflow/i.test(stripComments(operationSource))) {
  failures.push(`${OPERATION}: generic runtime must not name a publisher`);
}

// Renderer snapshots keep only the command identity; args stay host-owned.
requireText(
  VIEW,
  "command: { name: contribution.command.name }",
  "renderer action projection must drop command.args",
);
if (read(VIEW).includes("command: { ...contribution.command }")) {
  failures.push(`${VIEW}: renderer projection still spreads executable command args`);
}

requireText(
  HOST_TEST,
  'command: { name: "build", args: "--fast" }',
  "host-owned nonempty command.args regression is missing",
);
requireText(HOST_TEST, 'not.toHaveProperty("args")', "snapshot args non-forwarding assertion is missing");

for (const [needle, label] of [
  ["publisher withdraws", "publisher-withdrawal test"],
  ["multiple armed", "multiple-armed conflict test"],
  ["foreign-action", "same-owner reference validation test"],
  ["status text", "no-status-string-parsing test"],
  ["generic runtime has no extension identifiers", "no extension identifier test"],
]) {
  requireText(OPERATION_TEST, needle, `${label} is missing`);
}

if (failures.length > 0) {
  console.error("Desktop composer-operation acceptance FAILED:");
  for (const failure of failures) console.error(`  - ${failure}`);
  console.error(`Desktop root: ${desktopRoot}`);
  process.exit(1);
}

console.log("Desktop composer-operation acceptance passed.");
console.log(`  desktop root: ${desktopRoot}`);
for (const file of [OPERATION, OPERATION_TEST, VIEW, VIEW_TEST, HOST_TEST]) {
  console.log(`  checked: ${file}`);
}
