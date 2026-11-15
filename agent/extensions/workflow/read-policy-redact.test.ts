/**
 * Workflow Extension — Read-policy output redaction tests
 *
 * Run with: npm test   (node --test, type-stripping — no build step)
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";

import {
  redactSensitiveText,
  redactToolResult,
} from "./read-policy-redact.ts";
import { DEFAULT_FOLDER_POLICY_CONFIG } from "./folder-policy.ts";

const CWD = path.resolve(process.cwd());
const CONFIG = { ...DEFAULT_FOLDER_POLICY_CONFIG };

function grep(text: string, input: Record<string, unknown> = { path: CWD }) {
  return redactSensitiveText(text, "grep", input, CWD, CONFIG);
}

test("grep: sensitive match and context lines are dropped", () => {
  const result = grep(
    [
      ".env:1: SECRET=abc",
      ".env-0- before",
      "src/app.ts:3: const ok = true",
      "src/app.ts-4- next",
    ].join("\n"),
  );
  assert.equal(result.redacted, true);
  assert.doesNotMatch(result.text, /SECRET/);
  assert.match(result.text, /src\/app\.ts:3/);
});

test("grep: template files are kept", () => {
  const result = grep("config/.env.example:1: DATABASE_URL=replace-me");
  assert.equal(result.redacted, false);
  assert.match(result.text, /\.env\.example/);
});

test("grep: all matches withheld gets a clear marker", () => {
  const result = grep(".env:1: SECRET=abc");
  assert.equal(result.redacted, true);
  assert.match(result.text, /withheld by read policy/);
});

test("grep: notices and non-matching lines are preserved", () => {
  const result = grep(
    "[100 matches limit reached. Use limit=200 for more]\n.env:1: SECRET",
  );
  assert.match(result.text, /100 matches limit reached/);
  assert.doesNotMatch(result.text, /SECRET/);
});

test("find: sensitive entries are dropped, safe entries kept", () => {
  const result = redactSensitiveText(
    [".env", "src/app.ts", "keys/id_rsa", "docs/readme.md"].join("\n"),
    "find",
    { path: CWD },
    CWD,
    CONFIG,
  );
  assert.equal(result.redacted, true);
  assert.doesNotMatch(result.text, /^\.env$/m);
  assert.doesNotMatch(result.text, /id_rsa/);
  assert.match(result.text, /src\/app\.ts/);
  assert.match(result.text, /docs\/readme\.md/);
});

test("ls: sensitive entries are omitted", () => {
  const result = redactSensitiveText(
    [".env", "src/", "credentials.json", "README.md"].join("\n"),
    "ls",
    { path: CWD },
    CWD,
    CONFIG,
  );
  assert.equal(result.redacted, true);
  assert.doesNotMatch(result.text, /credentials\.json/);
  assert.doesNotMatch(result.text, /^\.env$/m);
  assert.match(result.text, /README\.md/);
});

test("bash: sensitive git diff sections are removed, safe sections kept", () => {
  const text = [
    "diff --git a/src/app.ts b/src/app.ts",
    "--- a/src/app.ts",
    "+++ b/src/app.ts",
    "@@ -1 +1 @@",
    "-old",
    "+new",
    "diff --git a/.env b/.env",
    "--- a/.env",
    "+++ b/.env",
    "-SECRET=old",
    "+SECRET=new",
    "diff --git a/README.md b/README.md",
    "--- a/README.md",
    "+++ b/README.md",
    "@@ -1 +1 @@",
    "-a",
    "+b",
  ].join("\n");
  const result = redactSensitiveText(text, "bash", {}, CWD, CONFIG);
  assert.equal(result.redacted, true);
  assert.doesNotMatch(result.text, /SECRET/);
  assert.match(result.text, /src\/app\.ts/);
  assert.match(result.text, /README\.md/);
  assert.match(result.text, /diff section withheld/);
});

test("bash: rg-style path lines are dropped", () => {
  const result = redactSensitiveText(
    [".env:2: SECRET=x", "src/app.ts:2: ok"].join("\n"),
    "bash",
    {},
    CWD,
    CONFIG,
  );
  assert.equal(result.redacted, true);
  assert.doesNotMatch(result.text, /SECRET/);
  assert.match(result.text, /src\/app\.ts:2/);
});

test("tool_result: read safety net blocks a sensitive path", () => {
  const result = redactToolResult(
    {
      toolName: "read",
      input: { path: ".env" },
      content: [{ type: "text", text: "SECRET=abc" }],
    },
    CONFIG,
    CWD,
  );
  assert.ok(result);
  assert.match(String(result?.content?.[0]?.text), /blocked by read policy/);
});

test("tool_result: normal read is untouched", () => {
  assert.equal(
    redactToolResult(
      {
        toolName: "read",
        input: { path: "src/app.ts" },
        content: [{ type: "text", text: "export {}" }],
      },
      CONFIG,
      CWD,
    ),
    undefined,
  );
});

test("tool_result: grep redaction drops structuredContent and keeps details", () => {
  const result = redactToolResult(
    {
      toolName: "grep",
      input: { path: CWD },
      content: [{ type: "text", text: ".env:1: SECRET" }],
      details: { matchLimitReached: 100 },
      structuredContent: { secret: true },
    },
    CONFIG,
    CWD,
  );
  assert.ok(result);
  assert.equal(result?.structuredContent, undefined);
  assert.deepEqual(result?.details, { matchLimitReached: 100 });
});

test("tool_result: bash redaction removes fullOutputPath", () => {
  const result = redactToolResult(
    {
      toolName: "bash",
      input: { command: "rg x ." },
      content: [{ type: "text", text: ".env:1: SECRET" }],
      details: {
        fullOutputPath: "/tmp/full.txt",
        full_output_path: "/tmp/full.txt",
        truncation: { truncated: true },
      },
    },
    CONFIG,
    CWD,
  );
  assert.ok(result);
  const details = result?.details as Record<string, unknown>;
  assert.equal(details.fullOutputPath, undefined);
  assert.equal(details.full_output_path, undefined);
  assert.deepEqual(details.truncation, { truncated: true });
});

test("tool_result: non-read tool is untouched", () => {
  assert.equal(
    redactToolResult(
      {
        toolName: "workflow_todo",
        input: { todos: [] },
        content: [{ type: "text", text: ".env:1: SECRET" }],
      },
      CONFIG,
      CWD,
    ),
    undefined,
  );
});

// ── excludePaths ─────────────────────────────────────────────────────

const EXCLUDED = path.join(CWD, "excluded-tree");
const EXCLUDED_CONFIG = {
  ...DEFAULT_FOLDER_POLICY_CONFIG,
  excludePaths: [EXCLUDED],
};

test("exclude: grep lines inside an excluded folder are withheld", () => {
  const result = redactSensitiveText(
    [
      `${path.join(EXCLUDED, "a.ts")}:1: const leaked = true`,
      "src/app.ts:3: const ok = true",
    ].join("\n"),
    "grep",
    { path: CWD },
    CWD,
    EXCLUDED_CONFIG,
  );
  assert.equal(result.redacted, true);
  assert.doesNotMatch(result.text, /leaked/);
  assert.match(result.text, /src\/app\.ts:3/);
});

test("exclude: a grant does not re-open a denied subtree for output", () => {
  const result = redactSensitiveText(
    `${path.join(EXCLUDED, "a.ts")}:1: const leaked = true`,
    "grep",
    { path: CWD },
    CWD,
    EXCLUDED_CONFIG,
  );
  assert.equal(result.redacted, true);
  assert.doesNotMatch(result.text, /leaked/);
});

test("exclude: a broad root is a ceiling for output redaction", () => {
  const root = path.parse(CWD).root;
  const config = { ...DEFAULT_FOLDER_POLICY_CONFIG, excludePaths: [root] };
  const below = redactSensitiveText(
    `${path.join(root, "sibling", "x.ts")}:1: const visible = true`,
    "grep",
    { path: CWD },
    CWD,
    config,
  );
  assert.equal(below.redacted, false);
  assert.match(below.text, /visible/);
});

test("exclude: ls entries inside an excluded folder are dropped", () => {
  const result = redactSensitiveText(
    ["excluded-tree/", "src/", "README.md"].join("\n"),
    "ls",
    {},
    CWD,
    EXCLUDED_CONFIG,
  );
  assert.equal(result.redacted, true);
  assert.doesNotMatch(result.text, /excluded-tree/);
  assert.match(result.text, /src\//);
  assert.match(result.text, /README\.md/);
});

test("exclude: find results inside an excluded folder are dropped", () => {
  const result = redactSensitiveText(
    ["excluded-tree/a.ts", "src/app.ts"].join("\n"),
    "find",
    { path: CWD },
    CWD,
    EXCLUDED_CONFIG,
  );
  assert.equal(result.redacted, true);
  assert.doesNotMatch(result.text, /excluded-tree/);
  assert.match(result.text, /src\/app\.ts/);
});

test("exclude: bash diff sections for excluded paths are withheld", () => {
  const result = redactSensitiveText(
    [
      "diff --git a/excluded-tree/a.ts b/excluded-tree/a.ts",
      "--- a/excluded-tree/a.ts",
      "+++ b/excluded-tree/a.ts",
      "+const leaked = true;",
      "diff --git a/src/app.ts b/src/app.ts",
      "--- a/src/app.ts",
      "+++ b/src/app.ts",
      "+const ok = true;",
    ].join("\n"),
    "bash",
    {},
    CWD,
    EXCLUDED_CONFIG,
  );
  assert.equal(result.redacted, true);
  assert.doesNotMatch(result.text, /leaked/);
  assert.match(result.text, /const ok = true/);
});

test("exclude: redactToolResult withholds a read of an excluded folder", () => {
  const result = redactToolResult(
    {
      toolName: "read",
      input: { path: path.join(EXCLUDED, "a.ts") },
      content: [{ type: "text", text: "const leaked = true;" }],
    },
    EXCLUDED_CONFIG,
    CWD,
  );
  assert.match(String(result?.content?.[0]?.text), /blocked by read policy/);
});
