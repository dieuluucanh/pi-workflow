/**
 * Property and fuzz tests for the plan-execution contract (v2 step 18).
 *
 * These do not pin one fixture; they generate many plans/checks from a seeded
 * PRNG and assert invariants that must hold for *every* input the compiler
 * accepts:
 *
 *   - determinism: the same bytes compile/freeze to the same artifact,
 *   - no prose execution: every accepted check is command-shaped,
 *   - bounds: over-limit plans fail closed instead of truncating,
 *   - stable ids: row/check ids do not depend on display normalisation,
 *   - no duplicate row refs and no unknown workspace aliases,
 *   - no `planChecks`/`planCheckSpecs` drift after freeze,
 *   - unknown YAML keys fail closed instead of being ignored.
 *
 * The PRNG is local and seeded on purpose: a failure is reproducible, and the
 * suite adds no dependency. `node:test` runs it as ordinary tests.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { compilePlan } from "./plan-compiler.ts";
import { createFrozenTodosFromPlan } from "./todo-snapshot.ts";
import { validateCommandShape } from "./plan-checks.ts";
import {
  MAX_CHECKS,
  MAX_CHECK_TIMEOUT_MS,
  MAX_FILES,
  MAX_TEXT,
  MAX_WORKSPACES,
  validatePlanSpec,
  type CheckSpec,
  type PlanSpec,
} from "./plan-spec.ts";
import { validateFrozenExecutionSnapshot } from "./frozen-snapshot.ts";
import type { FrozenWorkspace } from "./orchestrator-workspace-set.ts";

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
const WORKSPACES = [W, D];

/** Deterministic mulberry32 PRNG — reproducible fuzz, no dependency. */
function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function pick<T>(random: () => number, items: readonly T[]): T {
  return items[Math.floor(random() * items.length)]!;
}

function integer(random: () => number, min: number, max: number): number {
  return min + Math.floor(random() * (max - min + 1));
}

const COMMANDS = [
  "npm test",
  "npm run lint",
  "node --test plan-spec.test.ts",
  'node --test "a,b;c.test.ts"',
  "pnpm check:docs-reference",
  "git status --short",
  "echo 'quoted argument'",
];

const PROSE = [
  "the module is documented",
  "the backlog is reconciled",
  "golden comparisons at the exact tolerance",
  "record fresh-install and upgrade results separately",
];

const WORDS = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta"];

function word(random: () => number): string {
  return pick(random, WORDS);
}

function sentence(random: () => number): string {
  return Array.from({ length: integer(random, 2, 5) }, () => word(random)).join(" ");
}

/** A row body with random checks, criteria and files (no section heading). */
function randomRow(random: () => number, index: number): string[] {
  const lines = [`### ${index}. ${sentence(random)}`];
  const checks = Array.from(
    { length: integer(random, 0, 3) },
    () => `- ${pick(random, COMMANDS)}`,
  );
  if (checks.length > 0) lines.push("Checks:", ...checks);
  const criteria = Array.from(
    { length: integer(random, 0, 2) },
    () => pick(random, PROSE),
  );
  if (criteria.length > 0) lines.push(`Acceptance: ${criteria.join("; ")}`);
  const files = Array.from(
    { length: integer(random, 0, 2) },
    () => `src/${word(random)}-${index}.ts`,
  );
  if (files.length > 0) lines.push(`Files: ${files.join(", ")}`);
  if (random() < 0.5) lines.push(`Workspaces: ${pick(random, ["W", "D"])}`);
  return lines;
}

function randomPlan(random: () => number): string {
  const rows = integer(random, 1, 4);
  const lines = [`# Plan: ${sentence(random)}`, "", "## Plan Steps", ""];
  for (let index = 1; index <= rows; index += 1) {
    lines.push(...randomRow(random, index), "");
  }
  lines.push("## Verification", "");
  const finalChecks = Array.from(
    { length: integer(random, 0, 4) },
    () => `- \`${pick(random, COMMANDS)}\``,
  );
  lines.push(...finalChecks);
  if (random() < 0.4) {
    lines.push("", "```checks", "checks:");
    lines.push(`  - id: fuzz-${integer(random, 1, 99)}`);
    lines.push(`    command: ${pick(random, COMMANDS)}`);
    if (random() < 0.5) lines.push(`    kind: ${pick(random, ["gate", "diagnostic"])}`);
    if (random() < 0.4) {
      lines.push(`    timeoutMs: ${integer(random, 1, MAX_CHECK_TIMEOUT_MS)}`);
    }
    lines.push("```");
  }
  lines.push("");
  return lines.join("\n");
}

function compiled(markdown: string): { spec?: PlanSpec; ok: boolean; error?: string } {
  const result = compilePlan(markdown, {
    path: "C:/work/.pi/plans/fuzz.md",
    workspaces: WORKSPACES,
  });
  return result.ok
    ? { ok: true, spec: result.spec }
    : { ok: false, error: result.error };
}

test("property: accepted fuzz plans are deterministic and re-validate", () => {
  const random = rng(0x5eed);
  for (let iteration = 0; iteration < 120; iteration += 1) {
    const markdown = randomPlan(random);
    const first = compiled(markdown);
    const second = compiled(markdown);
    assert.equal(
      first.ok,
      second.ok,
      `iteration ${iteration}: compile must be deterministic`,
    );
    if (!first.ok || !second.ok) {
      assert.equal(first.error, second.error);
      continue;
    }
    assert.deepEqual(first.spec, second.spec);
    assert.equal(
      first.spec!.compiler.specHash,
      second.spec!.compiler.specHash,
    );
    const validated = validatePlanSpec(first.spec);
    assert.equal(validated.ok, true, `${iteration}: ${!validated.ok ? validated.error : ""}`);
  }
});

test("property: no accepted fuzz check is prose", () => {
  const random = rng(0xc0ffee);
  let accepted = 0;
  for (let iteration = 0; iteration < 120; iteration += 1) {
    const result = compiled(randomPlan(random));
    if (!result.ok) continue;
    accepted += 1;
    for (const check of allChecks(result.spec!)) {
      const shape = validateCommandShape(check.command);
      assert.equal(
        shape.ok,
        true,
        `iteration ${iteration}: accepted check is not command-shaped: ${JSON.stringify(check.command)}`,
      );
      // A whole prose sentence must never appear as a command.
      assert.equal(
        PROSE.includes(check.command),
        false,
        `iteration ${iteration}: prose reached a check`,
      );
    }
    for (const row of result.spec!.rows) {
      for (const criterion of row.acceptanceCriteria) {
        assert.equal(
          allChecks(result.spec!).some((check) => check.command === criterion),
          false,
          `iteration ${iteration}: acceptance criterion was executed`,
        );
      }
    }
  }
  assert.ok(accepted > 30, "the fuzz corpus must accept a meaningful number of plans");
});

test("property: over-limit fuzz plans fail closed instead of truncating", () => {
  const random = rng(0xbadbed);
  for (let iteration = 0; iteration < 40; iteration += 1) {
    // One unambiguous command repeated: a mixed corpus can legitimately be
    // ignored as documentation, which is not the boundary under test.
    const checks = Array.from(
      { length: MAX_CHECKS + 1 },
      (_, index) => `- npm run check-${index + 1}`,
    );
    const markdown = [
      "# Plan: Over limit",
      "## Plan Steps",
      "1. Run it",
      "",
      "## Verification",
      ...checks,
      "",
    ].join("\n");
    const result = compiled(markdown);
    assert.equal(result.ok, false, `iteration ${iteration}: ${MAX_CHECKS + 1} checks must fail`);
    if (!result.ok) assert.match(result.error!, new RegExp(`more than ${MAX_CHECKS}`));
  }
});

test("property: file/workspace/text bounds fail closed", () => {
  const random = rng(0xf11e);
  for (let iteration = 0; iteration < 20; iteration += 1) {
    const files = Array.from(
      { length: MAX_FILES + 1 },
      (_, index) => `src/fuzz-${iteration}-${index}.ts`,
    );
    const tooManyFiles = compiled(
      ["# Plan: Files", "## Plan Steps", "1. Touch", `   Files: ${files.join(", ")}`, ""].join("\n"),
    );
    assert.equal(tooManyFiles.ok, false);
    if (!tooManyFiles.ok) assert.match(tooManyFiles.error!, /more than 20/);

    const aliases = Array.from({ length: MAX_WORKSPACES + 1 }, (_, i) => `W${i + 1}`);
    const tooManyWorkspaces = compiled(
      ["# Plan: Roots", "## Plan Steps", "1. Touch", `   Workspaces: ${aliases.join(", ")}`, ""].join("\n"),
    );
    assert.equal(tooManyWorkspaces.ok, false);
    if (!tooManyWorkspaces.ok) assert.match(tooManyWorkspaces.error!, /more than 8/);
  }

  const tooLong = `node --test ${"x".repeat(MAX_TEXT)}`;
  const result = compiled(
    ["# Plan: Long", "## Plan Steps", "1. Run", "", "## Verification", `- ${tooLong}`, ""].join("\n"),
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error!, /4000 characters or fewer/);
});

test("property: ids are stable and row refs are unique", () => {
  const random = rng(0x1d5);
  for (let iteration = 0; iteration < 60; iteration += 1) {
    const markdown = randomPlan(random);
    const first = compiled(markdown);
    const second = compiled(markdown);
    if (!first.ok || !second.ok) continue;
    const ids = first.spec!.rows.map((row) => row.id);
    assert.equal(new Set(ids).size, ids.length, `iteration ${iteration}: duplicate row id`);
    const refs = first.spec!.rows.map((row) => row.ref);
    assert.equal(new Set(refs).size, refs.length, `iteration ${iteration}: duplicate row ref`);
    assert.deepEqual(ids, second.spec!.rows.map((row) => row.id));
    assert.deepEqual(
      first.spec!.planChecks.map((check) => check.id),
      second.spec!.planChecks.map((check) => check.id),
    );
  }
});

test("property: workspace aliases on checks are always bound aliases", () => {
  const random = rng(0xa11a5);
  const aliases = new Set(WORKSPACES.map((workspace) => workspace.id));
  for (let iteration = 0; iteration < 120; iteration += 1) {
    const result = compiled(randomPlan(random));
    if (!result.ok) continue;
    for (const check of allChecks(result.spec!)) {
      if (check.workspace === undefined) continue;
      assert.equal(
        aliases.has(check.workspace),
        true,
        `iteration ${iteration}: unbound workspace ${check.workspace}`,
      );
    }
  }
});

test("property: freeze never drifts planChecks from planCheckSpecs", () => {
  const random = rng(0xd21f7);
  let frozen = 0;
  for (let iteration = 0; iteration < 60; iteration += 1) {
    const markdown = randomPlan(random);
    const built = createFrozenTodosFromPlan({
      planPath: "C:/work/.pi/plans/fuzz.md",
      planText: markdown,
      mode: "orchestrator",
      workspaces: WORKSPACES,
      executionId: `todo-exec-fuzz-${iteration}`,
      now: iteration,
    });
    if (!built.ok) continue;
    frozen += 1;
    assert.ok(built.execution);
    const snapshot = built.snapshot;
    assert.deepEqual(
      snapshot.planChecks,
      built.execution!.planChecks,
      `iteration ${iteration}: planChecks drifted`,
    );
    assert.deepEqual(
      snapshot.planCheckSpecs,
      built.execution!.planCheckSpecs,
      `iteration ${iteration}: planCheckSpecs drifted`,
    );
    assert.deepEqual(
      snapshot.planChecks,
      built.execution!.checks.map((check) => check.command),
    );
    assert.equal(validateFrozenExecutionSnapshot(built.execution).ok, true);
  }
  assert.ok(frozen > 20, "the fuzz corpus must freeze a meaningful number of plans");
});

test("property: unknown checks-block keys fail closed", () => {
  const random = rng(0xdead);
  const keys = ["anchors", "aliases", "flow", "retries", "shell", "sudo", "env"];
  for (let iteration = 0; iteration < 40; iteration += 1) {
    const key = pick(random, keys);
    const markdown = [
      "# Plan: Unknown key",
      "## Plan Steps",
      "1. Run it",
      "",
      "## Verification",
      "",
      "```checks",
      "checks:",
      "  - id: unknown",
      "    command: npm test",
      `    ${key}: ${JSON.stringify(word(random))}`,
      "```",
      "",
    ].join("\n");
    const result = compiled(markdown);
    assert.equal(result.ok, false, `iteration ${iteration}: unknown key ${key} was accepted`);
    if (!result.ok) assert.match(result.error!, /unknown|unsupported|not supported|line/i);
  }
});

test("property: mixed prose/command bullets fail closed with a line number", () => {
  const random = rng(0x3d1);
  // Quote-free commands only: an unbalanced quote changes the authoring
  // heuristic (a quoted sentence is documentation), which is a separate case.
  const simple = COMMANDS.filter(
    (command) => !command.includes("'") && !command.includes('"'),
  );
  for (let iteration = 0; iteration < 40; iteration += 1) {
    const command = pick(random, simple);
    const prose = pick(random, PROSE);
    const bullet = `- ${command}\`, ${prose}.`;
    const markdown = [
      "# Plan: Mixed",
      "## Plan Steps",
      "1. Run it",
      "",
      "## Verification",
      bullet,
      "",
    ].join("\n");
    const result = compiled(markdown);
    assert.equal(result.ok, false, `iteration ${iteration}: mixed bullet was accepted`);
    if (!result.ok) assert.match(result.error!, /line 6/);
  }
});

function allChecks(spec: PlanSpec): CheckSpec[] {
  return [...spec.planChecks, ...spec.rows.flatMap((row) => row.checks)];
}
