/**
 * Single plan compiler tests (Phase B, step 9).
 *
 * The compiler replaces three readers that disagreed. These tests pin the
 * contract that replaces them:
 *   - golden plan -> PlanSpec fixtures for commands-only, typed-block and
 *     mixed authoring (rows, checks, workspaces, exact bytes, diagnostics),
 *   - mutation cases: prose/backticks/mixed bullets and prose `Acceptance:`
 *     never become commands,
 *   - the unsupported-YAML fixture fails closed with a line number,
 *   - boundaries (12 checks / 20 files / 8 workspaces / 4000 chars),
 *   - no truncation and no display dedupe in the compiled rows,
 *   - parity with the display projection (`utils.extractPlanStepsFromMarkdown`).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import {
  PLAN_COMPILER_VERSION,
  compilePlan,
  compilePlanRows,
  compilePlanChecks,
  formatPlanDiagnostic,
  parseRowMetadata,
} from "./plan-compiler.ts";
import type { PlanSpec } from "./plan-spec.ts";
import type { FrozenWorkspace } from "./orchestrator-workspace-set.ts";
import { extractPlanStepsFromMarkdown, normalizeStepText } from "./utils.ts";
import { validateCommandShape } from "./plan-checks.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, "fixtures", "plan-compiler");

const WORKSPACE: FrozenWorkspace = {
  id: "W",
  key: "plain:C:/work",
  root: "C:/work",
  kind: "plain",
  displayPath: "C:/work",
  primary: true,
};

interface GoldenRow {
  id: string;
  ref: string;
  text: string;
  label?: string;
  group?: string;
  checks: unknown[];
  acceptanceCriteria: string[];
  expectedFiles: string[];
  workspaces: string[];
  sourceLine?: number;
}

interface GoldenEntry {
  title: string;
  specHash: string;
  rows: GoldenRow[];
  planChecks: unknown[];
  diagnostics: unknown[];
}

type Golden = Record<string, GoldenEntry>;

function golden(): Golden {
  return JSON.parse(
    fs.readFileSync(path.join(FIXTURES, "golden.json"), "utf8"),
  ) as Golden;
}

function fixture(name: string): string {
  return fs.readFileSync(path.join(FIXTURES, `${name}.md`), "utf8");
}

function compileFixture(name: string): PlanSpec {
  const result = compilePlan(fixture(name), {
    path: `C:/work/.pi/plans/${name}.md`,
    workspaces: [WORKSPACE],
  });
  assert.equal(result.ok, true, result.ok ? "" : result.error);
  return (result as { ok: true; spec: PlanSpec }).spec;
}

function rowsOf(spec: PlanSpec): GoldenRow[] {
  return spec.rows.map((row) => ({
    id: row.id,
    ref: row.ref,
    text: row.text,
    label: row.label,
    ...(row.group === undefined ? {} : { group: row.group }),
    checks: row.checks,
    acceptanceCriteria: row.acceptanceCriteria,
    expectedFiles: row.expectedFiles,
    workspaces: row.workspaces,
    ...(row.sourceLine === undefined ? {} : { sourceLine: row.sourceLine }),
  }));
}

/** A compact plan with only the Verification section under test. */
function verificationPlan(bullets: readonly string[]): string {
  return [
    "# Plan: Verification fixture",
    "",
    "## Plan Steps",
    "",
    "1. Run the gate",
    "",
    "## Verification",
    "",
    ...bullets,
    "",
  ].join("\n");
}

test("the compiler version is recorded", () => {
  assert.equal(PLAN_COMPILER_VERSION, "plan-compiler/1");
});

test("golden fixtures compile to the recorded PlanSpec", () => {
  const expected = golden();
  for (const name of Object.keys(expected)) {
    const spec = compileFixture(name);
    assert.equal(spec.source.title, expected[name]!.title, `${name}: title`);
    assert.equal(spec.compiler.specHash, expected[name]!.specHash, `${name}: spec hash`);
    assert.deepEqual(rowsOf(spec), expected[name]!.rows, `${name}: rows`);
    assert.deepEqual(spec.planChecks, expected[name]!.planChecks, `${name}: plan checks`);
    assert.deepEqual(spec.diagnostics, expected[name]!.diagnostics, `${name}: diagnostics`);
    assert.deepEqual(spec.workspaces, [WORKSPACE], `${name}: bound workspaces`);
  }
});

test("a commands-only plan keeps fenced lines, tags and code-span bullets byte-for-byte", () => {
  const spec = compileFixture("fenced-commands");
  assert.deepEqual(
    spec.planChecks.map((check) => [check.command, check.workspace ?? null, check.kind]),
    [
      ["npm run typecheck", null, "gate"],
      ['node --test "suite with spaces.test.ts"', "W", "gate"],
      ["npm run lint", null, "gate"],
    ],
  );
  assert.deepEqual(
    spec.planChecks.map((check) => check.id),
    ["check-1", "check-2", "check-3"],
  );
});

test("the typed checks block preserves ids, kinds, timeouts and quoting", () => {
  const spec = compileFixture("checks-block");
  const row = spec.rows[0]!;
  assert.deepEqual(
    row.checks.map((check) => ({
      id: check.id,
      command: check.command,
      kind: check.kind,
      ...(check.timeoutMs === undefined ? {} : { timeoutMs: check.timeoutMs }),
    })),
    [
      { id: "check-row-1-1", command: "npm test", kind: "gate" },
      {
        id: "check-row-1-2",
        command: 'node --test "src/a,b;c.test.ts"',
        kind: "gate",
      },
      { id: "row-lint", command: "npm run lint", kind: "diagnostic", timeoutMs: 120000 },
    ],
  );
  assert.deepEqual(
    spec.planChecks.map((check) => [check.id, check.command, check.workspace ?? null]),
    [
      ["typecheck", "pnpm typecheck", "W"],
      ["docs", "pnpm check:docs-reference", null],
      ["check-3", "npm run build", null],
    ],
  );
  assert.deepEqual(row.acceptanceCriteria, [
    "the module is documented",
    "the fixture stays prose",
  ]);
  assert.deepEqual(row.expectedFiles, ["src/module.ts", "tests/module.test.ts"]);
  assert.deepEqual(row.workspaces, ["W"]);
});

test("prose Acceptance values and prose bullets never become commands", () => {
  const spec = compileFixture("mixed");
  const row = spec.rows[0]!;
  assert.deepEqual(row.checks.map((check) => check.command), ["npm run prepare"]);
  assert.deepEqual(row.acceptanceCriteria, [
    "the fixture explains itself",
    "it stays prose",
  ]);
  assert.deepEqual(
    spec.planChecks.map((check) => check.command),
    ["npm test", "npm run lint", "node --test plan-compiler.test.ts"],
  );
  for (const check of [...row.checks, ...spec.planChecks]) {
    assert.equal(validateCommandShape(check.command).ok, true);
  }

  const acceptanceOnly = compilePlan(
    [
      "# Plan: Acceptance",
      "## Plan Steps",
      "1. Document it",
      "   Acceptance: npm test should not run",
      "",
    ].join("\n"),
  );
  assert.equal(acceptanceOnly.ok, true);
  if (!acceptanceOnly.ok) return;
  assert.deepEqual(acceptanceOnly.spec.rows[0]?.checks, []);
  assert.deepEqual(acceptanceOnly.spec.rows[0]?.acceptanceCriteria, [
    "npm test should not run",
  ]);
  assert.deepEqual(acceptanceOnly.spec.planChecks, []);
});

test("the 2026-11-21 mixed bullet is refused with its line number", () => {
  const bullets = [
    "- pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test`, golden comparisons.",
  ];
  const result = compilePlan(verificationPlan(bullets), { path: "C:/work/plan.md" });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.error, /line 9/);
  assert.match(result.error, /mixed|prose|command/i);
  assert.equal(result.diagnostics[0]?.code, "verification.mixed");
  assert.equal(
    formatPlanDiagnostic(result.diagnostics[0]!),
    `line 9: ${result.diagnostics[0]!.message}`,
  );
});

test("a prose row Checks value is a line-specific error, not a command", () => {
  const result = compilePlan(
    [
      "# Plan: Row checks",
      "## Plan Steps",
      "1. Wire it",
      "   Checks: update the documentation and the backlog",
      "",
    ].join("\n"),
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.error, /line 4/);
  assert.match(result.error, /prose is not a shell command/);
});

test("the unsupported-YAML fixture fails closed with a line number", () => {
  const result = compilePlan(fixture("unsupported-yaml"), {
    path: "C:/work/.pi/plans/unsupported-yaml.md",
    workspaces: [WORKSPACE],
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.error, /line 12/);
  assert.match(result.error, /anchors/);
  assert.equal(result.diagnostics[0]?.code, "verification.checks-block");
});

test("CRLF plans compile to the same spec hash as LF plans", () => {
  const lf = fixture("fenced-commands");
  const crlf = lf.replace(/\n/g, "\r\n");
  const options = { path: "C:/work/plan.md", workspaces: [WORKSPACE] };
  const left = compilePlan(lf, options);
  const right = compilePlan(crlf, options);
  assert.equal(left.ok, true);
  assert.equal(right.ok, true);
  if (!left.ok || !right.ok) return;
  assert.equal(left.spec.compiler.specHash, right.spec.compiler.specHash);
  assert.deepEqual(left.spec.rows, right.spec.rows);
  assert.deepEqual(left.spec.planChecks, right.spec.planChecks);
});

test("boundaries fail closed: 12 checks, 20 files, 8 workspaces, 4000 chars", () => {
  const thirteen = Array.from({ length: 13 }, (_, index) => `- npm run check-${index + 1}`);
  const checks = compilePlan(verificationPlan(thirteen), { path: "C:/work/plan.md" });
  assert.equal(checks.ok, false);
  if (!checks.ok) assert.match(checks.error, /more than 12/);

  const files = Array.from({ length: 21 }, (_, index) => `src/file-${index + 1}.ts`);
  const manyFiles = compilePlan(
    [
      "# Plan: Files",
      "## Plan Steps",
      "1. Touch files",
      `   Files: ${files.join(", ")}`,
      "",
    ].join("\n"),
  );
  assert.equal(manyFiles.ok, false);
  if (!manyFiles.ok) assert.match(manyFiles.error, /more than 20/);

  const aliases = Array.from({ length: 9 }, (_, index) => `W${index + 1}`);
  const manyWorkspaces = compilePlan(
    [
      "# Plan: Workspaces",
      "## Plan Steps",
      "1. Touch repos",
      `   Workspaces: ${aliases.join(", ")}`,
      "",
    ].join("\n"),
    { path: "C:/work/plan.md" },
  );
  assert.equal(manyWorkspaces.ok, false);
  if (!manyWorkspaces.ok) assert.match(manyWorkspaces.error, /more than 8/);

  const tooLong = `node --test ${"x".repeat(4_001)}`;
  const long = compilePlan(verificationPlan([`- ${tooLong}`]), { path: "C:/work/plan.md" });
  assert.equal(long.ok, false);
  if (!long.ok) assert.match(long.error, /4000 characters or fewer/);
});

test("compiled rows are not deduped by display text and keep stable ids", () => {
  const markdown = [
    "# Plan: Duplicates",
    "## Plan Steps",
    "1. Repeat the same step",
    "2. Repeat the same step",
    "",
  ].join("\n");
  const first = compilePlan(markdown, { path: "C:/work/plan.md" });
  const second = compilePlan(markdown, { path: "C:/work/plan.md" });
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  if (!first.ok || !second.ok) return;
  assert.equal(first.spec.rows.length, 2);
  assert.notEqual(first.spec.rows[0]?.id, first.spec.rows[1]?.id);
  assert.deepEqual(
    first.spec.rows.map((row) => row.id),
    second.spec.rows.map((row) => row.id),
  );
  assert.equal(first.spec.compiler.specHash, second.spec.compiler.specHash);
});

test("compiled rows are not truncated; the display projection applies its own cap", () => {
  const long = `Implement ${"detail ".repeat(50)}`.trim();
  assert.ok(long.length > 200);
  const markdown = ["# Plan: Long", "## Plan Steps", `1. ${long}`, ""].join("\n");
  const compiled = compilePlanRows(markdown);
  assert.equal(compiled.rows[0]?.text, long);

  const displayed = extractPlanStepsFromMarkdown(markdown);
  assert.equal(displayed[0]?.text, normalizeStepText(long));
  assert.ok((displayed[0]?.text.length ?? 0) <= 200);
});

test("display rows match compiled rows apart from the documented normalisation", () => {
  for (const name of Object.keys(golden())) {
    const markdown = fixture(name);
    const compiled = compilePlanRows(markdown, { workspaces: [WORKSPACE] });
    const displayed = extractPlanStepsFromMarkdown(markdown);
    assert.equal(displayed.length, compiled.rows.length, `${name}: row count`);
    for (const [index, row] of compiled.rows.entries()) {
      const item = displayed[index]!;
      assert.equal(item.label, row.label ?? String(index + 1), `${name}: label`);
      assert.equal(item.group, row.group, `${name}: group`);
      assert.equal(item.text, normalizeStepText(row.text), `${name}: text`);
    }
  }
});

test("the row metadata adapter stays a projection of the compiler", () => {
  const parsed = parseRowMetadata(
    [
      "Acceptance: first criterion; second criterion",
      "Checks:",
      "- npm test",
      "- npm run lint",
      "Files: src/a.ts",
      "Workspaces: W",
    ].join("\n"),
  );
  assert.deepEqual(parsed.acceptanceCriteria, ["first criterion", "second criterion"]);
  assert.deepEqual(parsed.checks.map((check) => check.command), ["npm test", "npm run lint"]);
  assert.deepEqual(parsed.acceptanceChecks, [
    "first criterion",
    "second criterion",
    "npm test",
    "npm run lint",
  ]);
  assert.deepEqual(parsed.expectedFiles, ["src/a.ts"]);
  assert.deepEqual(parsed.workspaces, ["W"]);
  assert.deepEqual(parsed.diagnostics, []);
});

test("compilePlanChecks reads only the Verification section", () => {
  const result = compilePlanChecks(fixture("fenced-commands"), {
    workspaces: [WORKSPACE],
  });
  assert.equal(result.ok, true);
  assert.deepEqual(
    result.checks.map((check) => check.command),
    ["npm run typecheck", 'node --test "suite with spaces.test.ts"', "npm run lint"],
  );
});

test("a malformed row check does not hide the display rows", () => {
  const markdown = [
    "# Plan: Lenient",
    "## Plan Steps",
    "1. First row",
    "   Checks: this is prose, not a command",
    "2. Second row",
    "",
  ].join("\n");
  const rows = compilePlanRows(markdown);
  assert.equal(rows.rows.length, 2);
  assert.ok(rows.diagnostics.length >= 1);
  for (const diagnostic of rows.diagnostics) {
    assert.equal(diagnostic.severity, "error");
    assert.equal(diagnostic.line, 4);
  }
  assert.equal(extractPlanStepsFromMarkdown(markdown).length, 2);
});

test("the compiler is the only plan parser: adapters keep no section/step logic", () => {
  const adapters: Array<{ file: string; uses: RegExp }> = [
    { file: "utils.ts", uses: /compilePlanRows\s*\(/ },
    { file: "todo-snapshot.ts", uses: /compilePlan\s*\(/ },
    { file: "plan-checks.ts", uses: /from "\.\/plan-compiler\.ts"/ },
    { file: "todo-service.ts", uses: /extractPlanStepsFromMarkdown\s*\(/ },
    { file: "legacy-recovery.ts", uses: /createFrozenTodosFromPlan\s*\(/ },
    { file: "review-tools.ts", uses: /reviewPlanSubmissionProblems\s*\(/ },
  ];
  const duplicateParsers = [
    /function\s+parseStepsFromLines\b/,
    /function\s+stepFromHeading\b/,
    /function\s+stepFromBold\b/,
    /function\s+stepFromList\b/,
    /function\s+stepFromCheckbox\b/,
    /function\s+parsePlanSteps\b/,
    /const\s+EXCLUDED_SECTION_RE\b/,
  ];
  for (const adapter of adapters) {
    const source = fs.readFileSync(path.join(HERE, adapter.file), "utf8");
    assert.match(source, adapter.uses, `${adapter.file} must delegate to the compiler`);
    for (const pattern of duplicateParsers) {
      assert.doesNotMatch(
        source,
        pattern,
        `${adapter.file} must not define its own plan/step parser (${pattern})`,
      );
    }
  }
});
