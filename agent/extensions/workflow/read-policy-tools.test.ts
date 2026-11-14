/**
 * Workflow Extension — Read tool-call classifier tests
 *
 * Run with: npm test   (node --test, type-stripping — no build step)
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

import {
  classifyReadCall,
  describeReadTargets,
  staticGlobPrefix,
} from "./read-policy-tools.ts";
import { DEFAULT_READ_POLICY_CONFIG } from "./read-policy.ts";
import { normalizePolicyPath as norm } from "./folder-policy.ts";

const CWD = path.resolve(process.cwd());

function targetPaths(tool: string, input: Record<string, unknown>, guarded: string[] = []): string[] {
  const result = classifyReadCall(
    tool,
    input,
    CWD,
    { ...DEFAULT_READ_POLICY_CONFIG, guardedTools: guarded },
  );
  return result.targets.map((target) => target.path).sort();
}

// ── built-ins ───────────────────────────────────────────────────────

test("read: path is a file target", () => {
  assert.deepEqual(targetPaths("read", { path: "src/app.ts" }), [
    norm("src/app.ts", CWD),
  ]);
  assert.deepEqual(targetPaths("read", { file_path: "@src/app.ts" }), [
    norm("src/app.ts", CWD),
  ]);
});

test("ls/grep/find: default to cwd and accept a path", () => {
  assert.deepEqual(targetPaths("ls", {}), [norm(CWD, CWD)]);
  assert.deepEqual(targetPaths("grep", { pattern: "x", path: "../lib" }), [
    norm("../lib", CWD),
  ]);
  assert.deepEqual(targetPaths("find", { pattern: "*.ts" }), [norm(CWD, CWD)]);
});

test("read: missing path is uncertain, never silently allowed", () => {
  const result = classifyReadCall(
    "read",
    {},
    CWD,
    DEFAULT_READ_POLICY_CONFIG,
  );
  assert.equal(result.targets.length, 0);
  assert.ok(result.uncertain.length > 0);
});

// ── pi-lens ─────────────────────────────────────────────────────────

test("pi-lens: file tools use path", () => {
  for (const tool of ["read_symbol", "read_enclosing", "module_report"]) {
    assert.deepEqual(targetPaths(tool, { path: "src/app.ts" }), [
      norm("src/app.ts", CWD),
    ]);
  }
  assert.deepEqual(targetPaths("effective_config", { file: "src/app.ts" }), [
    norm("src/app.ts", CWD),
  ]);
});

test("pi-lens: paths/analysisRoot and glob prefixes", () => {
  assert.deepEqual(
    targetPaths("lens_diagnostics", {
      path: "src/app.ts",
      paths: ["src", "../other"],
      analysisRoot: "../other",
    }).sort(),
    [norm("../other", CWD), norm("src", CWD), norm("src/app.ts", CWD)].sort(),
  );
  assert.deepEqual(
    targetPaths("symbol_search", { query: "x", paths: ["../other/**/*.ts"] }),
    [norm("../other", CWD)],
  );
  assert.deepEqual(
    targetPaths("ast_grep_search", { lang: "ts", paths: ["src/**/*.ts"] }),
    [norm("src", CWD)],
  );
});

test("pi-lens: lsp_navigation path (newFilePath is not a read)", () => {
  assert.deepEqual(
    targetPaths("lsp_navigation", {
      operation: "rename",
      path: "src/a.ts",
      newFilePath: "../other/a.ts",
    }),
    [norm("src/a.ts", CWD)],
  );
});

// ── explore / local URLs ────────────────────────────────────────────

test("explore: cwd and per-task cwd are targets", () => {
  assert.deepEqual(
    targetPaths("explore", {
      cwd: "../other",
      tasks: [{ agent: "scout", task: "x", cwd: "../sibling" }],
    }).sort(),
    [norm("../other", CWD), norm("../sibling", CWD)].sort(),
  );
});

test("fetch_content/browser: http is exempt, file/bare local is a target", () => {
  assert.deepEqual(
    targetPaths("fetch_content", { url: "https://example.com/x" }),
    [],
  );
  const local = path.join(CWD, "secret.txt");
  assert.deepEqual(
    targetPaths("fetch_content", { url: pathToFileURL(local).href }),
    [norm(local, CWD)],
  );
  assert.deepEqual(
    targetPaths("browser_navigate", { url: "../local/video.mp4" }),
    [norm("../local/video.mp4", CWD)],
  );
  assert.deepEqual(
    targetPaths("browser_launch", { url: pathToFileURL(local).href }),
    [norm(local, CWD)],
  );
});

// ── generic / exempt / writers ──────────────────────────────────────

test("generic: unknown tool with path-like fields is guarded", () => {
  assert.deepEqual(
    targetPaths("mcp__files__read", { filePath: "../secret.txt" }),
    [norm("../secret.txt", CWD)],
  );
  assert.deepEqual(
    targetPaths("office_read", { file: "docs/a.docx" }),
    [norm("docs/a.docx", CWD)],
  );
  assert.deepEqual(
    targetPaths("mcp__capture", { output: "x" }),
    [],
  );
});

test("exempt: agent-state and web tools are skipped", () => {
  for (const tool of [
    "memory_search",
    "memory_read",
    "scratchpad",
    "workflow_todo",
    "web_search",
    "source_check",
    "get_search_content",
    "browser_screenshot",
    "questionnaire",
  ]) {
    const result = classifyReadCall(
      tool,
      { path: "../x" },
      CWD,
      DEFAULT_READ_POLICY_CONFIG,
    );
    assert.equal(result.targets.length, 0, tool);
    assert.ok(result.exempt, tool);
  }
});

test("writers: edit/write/ast_grep_replace are skipped unless guarded", () => {
  for (const tool of ["edit", "write", "ast_grep_replace"]) {
    const result = classifyReadCall(
      tool,
      { path: "../x" },
      CWD,
      DEFAULT_READ_POLICY_CONFIG,
    );
    assert.equal(result.targets.length, 0, tool);
    assert.ok(result.exempt, tool);
  }
  const guarded = targetPaths("write", { path: "../x" }, ["write"]);
  assert.deepEqual(guarded, [norm("../x", CWD)]);
});

test("guardedTools: forces a scan even for an exempt tool", () => {
  assert.deepEqual(
    targetPaths("memory_read", { path: "../x" }, ["memory_read"]),
    [norm("../x", CWD)],
  );
});

// ── static prefix / diagnostics ─────────────────────────────────────

test("staticGlobPrefix: narrows to the non-wildcard directory", () => {
  assert.equal(staticGlobPrefix("../other/src/**/*.ts", CWD), norm("../other/src", CWD));
  assert.equal(staticGlobPrefix("**/*.ts", CWD), norm(CWD, CWD));
  assert.equal(staticGlobPrefix("src/a*.ts", CWD), norm("src", CWD));
});

test("describeReadTargets: stable display", () => {
  assert.equal(
    describeReadTargets([{ path: norm("src", CWD), kind: "dir" }]),
    norm("src", CWD),
  );
});
