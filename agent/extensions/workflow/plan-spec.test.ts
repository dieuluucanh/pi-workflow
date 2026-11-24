/**
 * Typed plan-execution contract (v2 step 8).
 *
 * These tests pin the boundary that the 2026-11-21 incident crossed: a check is
 * executable data with a stable id and a kind, prose is evidence, and every
 * stored field is parsed instead of cast. If a future change lets a sentence
 * satisfy `CheckSpec`, this file fails before an executor sees it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  CHECK_KINDS,
  gateCommands,
  legacyAcceptanceChecks,
  legacyCheckViews,
  planCheckId,
  planSpecHash,
  rowCheckId,
  sha256Hex,
  validateCheckSpec,
  validatePlanSpec,
  type CheckSpec,
  type PlanRow,
  type PlanSpec,
} from "./plan-spec.ts";
import { CHECK_SPEC_KINDS } from "./orchestrator-check-repair.ts";

const digest = sha256Hex("plan bytes");

function check(overrides: Partial<CheckSpec> = {}): CheckSpec {
  return { id: "check-1", command: "pnpm test", kind: "gate", ...overrides };
}

function row(overrides: Partial<PlanRow> = {}): PlanRow {
  return {
    id: "row-1",
    ref: "1",
    text: "Add the typed contract",
    checks: [check()],
    acceptanceCriteria: ["The contract parses a stored snapshot."],
    expectedFiles: ["plan-spec.ts"],
    workspaces: [],
    sourceLine: 12,
    ...overrides,
  };
}

function spec(overrides: Partial<PlanSpec> = {}): PlanSpec {
  const rows = [row()];
  const planChecks = [check({ id: planCheckId(0), command: "pnpm typecheck" })];
  return {
    version: 1,
    source: {
      kind: "plan",
      path: "C:/repo/.pi/plans/example.md",
      digest,
      bytesSha256: digest,
      title: "Example plan",
    },
    compiler: { version: "plan-compiler/1", specHash: planSpecHash({ rows, planChecks }) },
    rows,
    planChecks,
    workspaces: [],
    diagnostics: [],
    ...overrides,
  };
}

test("check ids and kinds stay aligned with the Phase-A amendment contract", () => {
  assert.deepEqual([...CHECK_KINDS], [...CHECK_SPEC_KINDS]);
  assert.equal(planCheckId(0), "check-1");
  assert.equal(rowCheckId("3", 1), "check-row-3-2");
});

test("a typed check preserves exact command bytes", () => {
  const command = `pnpm exec vitest run "src/a,b;c.test.ts" --reporter=dot`;
  const parsed = validateCheckSpec(check({ command }));
  assert.equal(parsed.ok, true);
  assert.equal((parsed as { ok: true; value: CheckSpec }).value.command, command);
});

test("non-commands and out-of-bounds checks fail closed", () => {
  const cases: Array<[string, unknown]> = [
    ["prose", check({ command: "Update the documentation and remaining backlog." })],
    ["markdown span", check({ command: "`pnpm test`" })],
    ["multi-line", check({ command: "pnpm test\necho done" })],
    ["leading space", check({ command: " pnpm test" })],
    ["trailing space", check({ command: "pnpm test " })],
    ["empty", check({ command: "" })],
    ["too long", check({ command: `pnpm test ${"x".repeat(4_100)}` })],
    ["unknown kind", { ...check(), kind: "release" }],
    ["missing kind", { ...check(), kind: undefined }],
    ["missing id", { ...check(), id: "" }],
    ["timeout zero", check({ timeoutMs: 0 })],
    ["timeout above the shell hard cap", check({ timeoutMs: 3_600_001 })],
    ["timeout fraction", check({ timeoutMs: 1.5 })],
    ["exit code above 255", check({ expectedExitCode: 256 })],
    ["unknown field", { ...check(), files: ["a.ts"] }],
    ["unknown workspace", check({ workspace: "D" }), { workspaces: [{ id: "W" }] }],
    ["not an object", "pnpm test"],
  ] as unknown as Array<[string, unknown]>;
  for (const entry of cases) {
    const [label, value, options] = entry as unknown as [
      string,
      unknown,
      { workspaces?: Array<{ id: string }> } | undefined,
    ];
    const result = validateCheckSpec(value, options ?? {});
    assert.equal(result.ok, false, `${label} should be refused`);
    if (!result.ok) assert.match(result.error, /./, label);
  }
});

test("a workspace alias is resolved against the declared set", () => {
  const workspaces = [{ id: "D" }, { id: "W" }];
  const ok = validateCheckSpec(check({ workspace: "d" }), { workspaces });
  assert.equal(ok.ok, true);
  assert.equal((ok as { ok: true; value: CheckSpec }).value.workspace, "d");
});

test("a plan spec round-trips through the parser without losing identity", () => {
  const parsed = validatePlanSpec(spec());
  assert.equal(parsed.ok, true);
  const value = (parsed as { ok: true; value: PlanSpec }).value;
  assert.deepEqual(value.rows.map((entry) => [entry.id, entry.ref]), [["row-1", "1"]]);
  assert.deepEqual(value.planChecks.map((entry) => entry.command), ["pnpm typecheck"]);
  assert.equal(value.rows[0]!.checks[0]!.kind, "gate");
});

test("row/check identity, refs and workspace aliases are enforced", () => {
  const duplicateIds = spec({
    rows: [row(), row({ ref: "2", text: "Second row" })],
  });
  assert.equal(validatePlanSpec(duplicateIds).ok, false);

  const refDrift = spec({ rows: [row({ ref: "2" })] });
  assert.equal(validatePlanSpec(refDrift).ok, false);

  const danglingAlias = spec({
    workspaces: [
      {
        id: "W",
        key: "plain:C:/repo",
        root: "C:/repo",
        kind: "plain",
        displayPath: "C:/repo",
        primary: true,
      },
    ],
    rows: [row({ checks: [check({ workspace: "D" })] })],
  });
  assert.equal(validatePlanSpec(danglingAlias).ok, false);

  const unknownKey = spec();
  (unknownKey as unknown as Record<string, unknown>).verification = ["pnpm test"];
  assert.equal(validatePlanSpec(unknownKey).ok, false);

  const twoPrimaries = spec({
    workspaces: [
      {
        id: "W",
        key: "plain:C:/w",
        root: "C:/w",
        kind: "plain",
        displayPath: "C:/w",
        primary: true,
      },
      {
        id: "D",
        key: "plain:C:/d",
        root: "C:/d",
        kind: "plain",
        displayPath: "C:/d",
        primary: true,
      },
    ],
  });
  assert.equal(validatePlanSpec(twoPrimaries).ok, false);
});

test("legacy views preserve command order and exact bytes", () => {
  const specs = [
    check({ id: "check-1", command: "pnpm typecheck" }),
    check({ id: "check-2", command: "pnpm test -- --runInBand", workspace: "D", kind: "diagnostic" }),
    check({ id: "check-3", command: "pnpm lint" }),
  ];
  const views = legacyCheckViews(specs);
  assert.deepEqual(views.planChecks, ["pnpm typecheck", "pnpm test -- --runInBand", "pnpm lint"]);
  assert.deepEqual(views.planCheckSpecs, [
    { command: "pnpm typecheck" },
    { command: "pnpm test -- --runInBand", workspace: "D" },
    { command: "pnpm lint" },
  ]);
  assert.deepEqual(gateCommands(specs), ["pnpm typecheck", "pnpm lint"]);
  assert.deepEqual(
    legacyAcceptanceChecks({ checks: specs, acceptanceCriteria: ["Docs updated."] }),
    ["pnpm typecheck", "pnpm test -- --runInBand", "pnpm lint", "Docs updated."],
  );
});

test("the spec hash is deterministic and sensitive to command bytes", () => {
  const first = spec();
  const second = spec();
  assert.equal(first.compiler.specHash, second.compiler.specHash);

  const changed = spec({
    planChecks: [check({ id: planCheckId(0), command: "pnpm typecheck --pretty false" })],
  });
  assert.notEqual(planSpecHash(changed), first.compiler.specHash);

  const reordered = spec({
    rows: [row()],
    planChecks: [check({ id: planCheckId(0), command: "pnpm typecheck" })],
    diagnostics: [
      { severity: "warning", code: "lint", message: "a" },
      { severity: "error", code: "lint", message: "b" },
    ],
  });
  assert.equal(planSpecHash(reordered), first.compiler.specHash);
});
