/**
 * Restricted-subset reader tests for the fenced `checks:` block.
 *
 * The package has no runtime YAML dependency, so this reader is the only way a
 * typed check surface can exist. Every unsupported YAML feature must fail with
 * a line number instead of being guessed at: a silent misread could turn prose
 * back into an executable command.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  CHECKS_BLOCK_LANGUAGE,
  parseChecksBlock,
  parseChecksBlockScalar,
  type ChecksBlockEntry,
  type ChecksBlockLine,
} from "./plan-checks-block.ts";

function lines(text: string): ChecksBlockLine[] {
  return text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line, index) => ({ line: index + 1, text: line }));
}

function expectError(text: string, pattern: RegExp, line?: number): void {
  const result = parseChecksBlock(lines(text));
  assert.equal(result.ok, false, `expected a refusal for:\n${text}`);
  if (result.ok) return;
  assert.match(result.error, pattern);
  if (line !== undefined) assert.equal(result.line, line);
}

function expectOk(text: string): ChecksBlockEntry[] {
  const result = parseChecksBlock(lines(text));
  assert.equal(result.ok, true, result.ok ? "" : `${result.line}: ${result.error}`);
  return result.ok ? result.entries : [];
}

test("the fence language constant stays `checks`", () => {
  assert.equal(CHECKS_BLOCK_LANGUAGE, "checks");
});

test("a minimal block reads id and command with their lines", () => {
  const entries = expectOk(
    ["checks:", "  - id: typecheck", "    command: pnpm typecheck"].join("\n"),
  );
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0]?.id, { value: "typecheck", line: 2 });
  assert.deepEqual(entries[0]?.command, { value: "pnpm typecheck", line: 3 });
  assert.equal(entries[0]?.line, 2);
});

test("the optional `checks:` header may be omitted and entries keep order", () => {
  const entries = expectOk(
    [
      "- id: a",
      "  command: pnpm a",
      "- id: b",
      "  command: pnpm b",
      "  kind: diagnostic",
      "  workspace: W",
      "  timeoutMs: 900000",
      "  expectedExitCode: 2",
    ].join("\n"),
  );
  assert.deepEqual(
    entries.map((entry) => entry.id?.value),
    ["a", "b"],
  );
  assert.equal(entries[1]?.kind?.value, "diagnostic");
  assert.equal(entries[1]?.workspace?.value, "W");
  assert.equal(entries[1]?.timeoutMs?.value, "900000");
  assert.equal(entries[1]?.expectedExitCode?.value, "2");
});

test("blank lines and comment lines are ignored", () => {
  const entries = expectOk(
    ["checks:", "", "  # a comment", "  - id: a", "", "    command: pnpm a", ""].join("\n"),
  );
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.command?.value, "pnpm a");
});

test("quoted scalars keep separators, comments and escapes as data", () => {
  const entries = expectOk(
    [
      "- id: 'node -e ''a,b;c'''",
      '  command: "node -e \\"console.log(\'a,b;c\')\\""',
      "  kind: gate # inline comments are stripped from plain scalars",
    ].join("\n"),
  );
  assert.equal(entries[0]?.id?.value, "node -e 'a,b;c'");
  assert.equal(entries[0]?.command?.value, 'node -e "console.log(\'a,b;c\')"');
  assert.equal(entries[0]?.kind?.value, "gate");
});

test("a plain scalar stops at an unquoted ` #` and keeps other hashes", () => {
  const entries = expectOk(
    ["- id: a", "  command: echo a#b # trailing comment"].join("\n"),
  );
  assert.equal(entries[0]?.command?.value, "echo a#b");
});

test("an empty block is valid", () => {
  assert.deepEqual(expectOk("checks:\n"), []);
  assert.deepEqual(expectOk(""), []);
});

test("unknown and duplicate keys fail closed with a line", () => {
  expectError("- id: a\n  command: pnpm a\n  retries: 3", /unknown key "retries"/, 3);
  expectError("- id: a\n  command: pnpm a\n  command: pnpm b", /duplicate key "command"/, 3);
});

test("a key without an entry or a shallower field fails closed", () => {
  expectError("command: pnpm a", /must belong to an entry/, 1);
  expectError("- id: a\ncommand: pnpm a", /indented deeper/, 2);
  expectError("  - id: a\n    command: pnpm a\n - id: b", /share one indentation level/, 3);
});

test("YAML features outside the subset fail closed with a line", () => {
  const cases: Array<[string, RegExp, number]> = [
    ["- id: a\n  command: &x pnpm a", /anchors/, 2],
    ["- id: a\n  command: *x", /aliases/, 2],
    ["- id: a\n  command: !!str pnpm a", /tags/, 2],
    ["- id: a\n  command: {run: pnpm a}", /flow mappings/, 2],
    ["- id: a\n  command: [pnpm, a]", /flow sequences/, 2],
    ["- id: a\n  command: |\n    pnpm a", /block scalars/, 2],
    ["- id: a\n  command: >\n    pnpm a", /folded block scalars/, 2],
    ["%YAML 1.2\n- id: a", /directives/, 1],
    ["- id: a\n  command: @pnpm a", /reserved indicators/, 2],
    ["- id: a\n  command: `pnpm a`", /reserved indicators/, 2],
  ];
  for (const [text, pattern, line] of cases) expectError(text, pattern, line);
});

test("tabs, empty values, multi-line values and extra top-level keys fail closed", () => {
  expectError("- id: a\n\tcommand: pnpm a", /tabs/, 2);
  expectError("- id: a\n  command:", /value is empty/, 2);
  expectError(
    "- id: a\n  command: pnpm a\n  command: pnpm b\n  - nope",
    /duplicate key "command"/,
    3,
  );
  expectError("- id: a\n  command: pnpm a\n  - nope", /unsupported checks-block syntax/, 3);
  expectError("checks:\n  - id: a\n    command: pnpm a\nchecks:", /only one top-level/, 4);
  expectError("- id: a\n  command: pnpm a\n    nested: b", /unknown key "nested"/, 3);
});

test("the scalar reader refuses unterminated and escaped values", () => {
  assert.deepEqual(parseChecksBlockScalar('"pnpm a"'), { ok: true, value: "pnpm a" });
  assert.deepEqual(parseChecksBlockScalar("'pnpm a'"), { ok: true, value: "pnpm a" });
  assert.equal(parseChecksBlockScalar('"pnpm a').ok, false);
  assert.equal(parseChecksBlockScalar("'pnpm a").ok, false);
  assert.equal(parseChecksBlockScalar('"a\\nb"').ok, false);
  assert.equal(parseChecksBlockScalar('"a" b').ok, false);
  assert.equal(parseChecksBlockScalar('"a": b').ok, false);
  assert.equal(parseChecksBlockScalar("run: pnpm a").ok, false);
  assert.equal(parseChecksBlockScalar("   ").ok, false);
});
