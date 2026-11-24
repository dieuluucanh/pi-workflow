/**
 * Golden fixtures for the plan-execution contract (v2 step 18).
 *
 * `fixtures/plan-contract/golden-plan.md` is compiled and frozen once;
 * `golden-frozen.json` is the reviewed expected `FrozenExecutionSnapshot`.
 * Putting a whole artifact in one golden file catches the class of drift that
 * narrower assertions miss: a changed row id, a reordered check, a dropped
 * workspace tag, a shifted source line, a changed spec hash or a new derived
 * `acceptanceChecks` value all fail this test.
 *
 * The incident fixture is the anti-golden: the exact five malformed bullets
 * must be refused at freeze with their line number and must never become a
 * `planChecks` entry.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { createFrozenTodosFromPlan } from "./todo-snapshot.ts";
import { buildFrozenExecutionSnapshot, readFrozenSnapshot, type FrozenExecutionSnapshot } from "./frozen-snapshot.ts";
import type { FrozenWorkspace } from "./orchestrator-workspace-set.ts";
import type { PlanCheckSpec } from "./plan-checks.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONTRACT_FIXTURES = path.join(HERE, "fixtures", "plan-contract");
const PLAN_FIXTURES = path.join(HERE, "fixtures", "plan-compiler");

const W: FrozenWorkspace = {
  id: "W",
  key: "plain:C:/work",
  root: "C:/work",
  kind: "plain",
  displayPath: "C:/work",
  primary: true,
};
const D: FrozenWorkspace = {
  id: "D",
  key: "plain:C:/docs",
  root: "C:/docs",
  kind: "plain",
  displayPath: "C:/docs",
  primary: false,
};

interface GoldenFile {
  execution: FrozenExecutionSnapshot;
}

function readContract(name: string): string {
  return fs.readFileSync(path.join(CONTRACT_FIXTURES, name), "utf8");
}

function readPlanFixture(name: string): string {
  return fs.readFileSync(path.join(PLAN_FIXTURES, name), "utf8");
}

function golden(): FrozenExecutionSnapshot {
  const parsed = JSON.parse(readContract("golden-frozen.json")) as GoldenFile;
  return parsed.execution;
}

function freezeGoldenPlan(overrides: { executionId?: string; now?: number } = {}) {
  return createFrozenTodosFromPlan({
    planPath: "C:/work/.pi/plans/golden-plan.md",
    planText: readContract("golden-plan.md"),
    mode: "orchestrator",
    workspaces: [W, D],
    executionId: overrides.executionId ?? "todo-exec-golden-plan",
    now: overrides.now ?? 1_700_000_000_000,
  });
}

interface IncidentFixture {
  verificationBullets: string[];
  frozenPlanChecks: string[];
  frozenPlanCheckSpecs: PlanCheckSpec[];
}

function incident(): IncidentFixture {
  return JSON.parse(
    fs.readFileSync(
      path.join(HERE, "fixtures", "plan-checks-incident.json"),
      "utf8",
    ),
  ) as IncidentFixture;
}

test("the golden plan freezes to the reviewed v2 artifact", () => {
  const built = freezeGoldenPlan();
  assert.equal(built.ok, true, built.ok ? "" : built.error);
  if (!built.ok) return;
  assert.ok(built.execution, "freeze must expose the v2 artifact");
  assert.deepEqual(built.execution, golden());
});

test("the golden artifact round-trips through the reader unchanged", () => {
  const expected = golden();
  const read = readFrozenSnapshot(expected);
  assert.equal(read.ok, true, read.ok ? "" : read.error);
  if (!read.ok) return;
  assert.equal(read.fromVersion, 2);
  assert.deepEqual(read.snapshot, expected);
  assert.deepEqual(read.quarantined, []);
});

test("the golden freeze keeps rows, checks, workspaces and exact command bytes", () => {
  const artifact = golden();
  assert.equal(artifact.schemaVersion, 2);
  assert.equal(artifact.compiler.version, "plan-compiler/1");
  assert.equal(artifact.source.path, "C:/work/.pi/plans/golden-plan.md");
  assert.equal(artifact.source.title, "Execution contract golden");

  assert.deepEqual(
    artifact.rows.map((row) => [row.ref, row.text, row.sourceLine, row.workspaces]),
    [
      ["1", "Add the contract", 12, ["W"]],
      ["2", "Validate the contract", 20, undefined],
    ],
  );
  assert.deepEqual(
    artifact.rows[0]!.checks.map((check) => [check.id, check.command, check.kind]),
    [
      ["check-row-1-1", "npm test", "gate"],
      ["check-row-1-2", "npm run lint", "gate"],
    ],
  );
  assert.deepEqual(artifact.rows[0]!.acceptanceCriteria, [
    "the contract parses",
    "prose stays evidence",
  ]);
  assert.deepEqual(artifact.rows[0]!.expectedFiles, [
    "plan-spec.ts",
    "frozen-snapshot.ts",
  ]);

  // The first plan check was written as a whole-bullet code span and the second
  // as a typed block; both keep exact bytes, ids, kind, workspace and timeout.
  assert.deepEqual(
    artifact.checks.map((check) => ({
      id: check.id,
      command: check.command,
      kind: check.kind,
      workspace: check.workspace ?? null,
      timeoutMs: check.timeoutMs ?? null,
    })),
    [
      { id: "check-1", command: "npm run typecheck", kind: "gate", workspace: "W", timeoutMs: null },
      {
        id: "docs",
        command: "pnpm check:docs-reference",
        kind: "diagnostic",
        workspace: "W",
        timeoutMs: 900_000,
      },
    ],
  );
  assert.deepEqual(artifact.workspaces, [W, D]);
  assert.equal(artifact.validation.ok, true);
});

test("freezing the same source twice produces byte-identical golden artifacts", () => {
  const first = freezeGoldenPlan();
  const second = freezeGoldenPlan();
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  if (!first.ok || !second.ok) return;
  assert.deepEqual(first.execution, second.execution);
  assert.equal(first.execution?.executionId, second.execution?.executionId);
});

test("the incident bullets are refused at freeze and never become planChecks", () => {
  const fixture = incident();
  const planText = [
    "# Plan: Incident",
    "",
    "## Plan Steps",
    "",
    "1. Reconcile the backlog",
    "",
    "## Verification",
    "",
    ...fixture.verificationBullets.map((bullet) => `- ${bullet}`),
    "",
  ].join("\n");

  const built = createFrozenTodosFromPlan({
    planPath: "C:/repo/.pi/plans/incident.md",
    planText,
    mode: "orchestrator",
  });
  assert.equal(built.ok, false);
  if (built.ok) return;
  assert.match(built.error, /line 9/);
  assert.match(built.error, /mixed|prose|command/i);
  for (const malformed of fixture.frozenPlanChecks) {
    assert.doesNotMatch(built.error, new RegExp(escapeRegExp(malformed)));
  }
});

test("a malformed frozen planCheckSpecs list is refused, not executed", () => {
  const fixture = incident();
  const built = createFrozenTodosFromPlan({
    planPath: "C:/repo/.pi/plans/incident.md",
    planText: [
      "# Plan: Incident rows",
      "## Plan Steps",
      "1. Reconcile",
      "",
    ].join("\n"),
    mode: "orchestrator",
    planCheckSpecs: fixture.frozenPlanCheckSpecs,
  });
  assert.equal(built.ok, false);
  if (built.ok) return;
  assert.match(built.error, /diverge|command|backtick|mixed|prose/i);
  for (const malformed of fixture.frozenPlanChecks) {
    assert.doesNotMatch(built.error, new RegExp(escapeRegExp(malformed)));
  }
});

test("a commands-only plan freezes gates byte-for-byte", () => {
  const built = createFrozenTodosFromPlan({
    planPath: "C:/work/.pi/plans/fenced-commands.md",
    planText: readPlanFixture("fenced-commands.md"),
    mode: "build",
    workspaces: [W],
    now: 5,
  });
  assert.equal(built.ok, true, built.ok ? "" : built.error);
  if (!built.ok) return;
  assert.deepEqual(built.snapshot.planChecks, [
    "npm run typecheck",
    'node --test "suite with spaces.test.ts"',
    "npm run lint",
  ]);
  assert.deepEqual(built.snapshot.planCheckSpecs, [
    { command: "npm run typecheck" },
    { command: 'node --test "suite with spaces.test.ts"', workspace: "W" },
    { command: "npm run lint" },
  ]);
  assert.equal(built.execution?.checks.every((check) => check.kind === "gate"), true);
});

test("a build-time artifact validates both its reader and its content hash", () => {
  const artifact = golden();
  const rebuilt = buildFrozenExecutionSnapshot({
    executionId: artifact.executionId,
    mode: artifact.mode,
    source: artifact.source,
    compilerVersion: artifact.compiler.version,
    rows: artifact.rows.map((row) => ({
      ...row,
      workspaces: row.workspaces ?? [],
    })),
    checks: artifact.checks,
    workspaces: artifact.workspaces,
    createdAt: artifact.createdAt,
  });
  assert.equal(rebuilt.ok, true, rebuilt.ok ? "" : rebuilt.error);
  if (!rebuilt.ok) return;
  assert.equal(rebuilt.value.compiler.specHash, artifact.compiler.specHash);
  assert.deepEqual(rebuilt.value, artifact);
});

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
