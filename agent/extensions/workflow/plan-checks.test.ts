/**
 * Plan-check authoring and execution-boundary regressions.
 *
 * These tests pin the 2026-11-21 MISA audit incident: five `## Verification`
 * bullets began with a command token but continued as prose after a stray
 * closing backtick. The old parser froze them verbatim and the final gate ran
 * `pnpm dev:preflight`,` on every retry. The fixture keeps the exact frozen
 * bytes so the failure cannot silently return.
 *
 * The positive half pins the authoring surface that is safe today: fenced
 * one-command-per-line blocks, one whole-bullet code span, one raw command,
 * workspace tags, quoted separators, CRLF and prose-only Verification. The
 * execution half pins the validator seam used before a shell sees a command.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import {
  extractPlanChecks,
  extractPlanChecksDetailed,
  extractPlanChecksWithWorkspaceDetailed,
  extractRowMetadata,
  type PlanCheckSpec,
} from "./plan-checks.ts";
import { createFrozenTodosFromPlan } from "./todo-snapshot.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INCIDENT_PATH = path.join(HERE, "fixtures", "plan-checks-incident.json");

interface IncidentFixture {
  sourceRunId: string;
  verificationBullets: string[];
  frozenPlanChecks: string[];
  frozenPlanCheckSpecs: PlanCheckSpec[];
  frozenRowAcceptance: string[];
}

const INCIDENT = JSON.parse(
  fs.readFileSync(INCIDENT_PATH, "utf8"),
) as IncidentFixture;

/** The first bullet is always line 5 of this shape. */
const INCIDENT_LINE = 5;

function verificationPlan(bullets: readonly string[]): string {
  return [
    "# Plan: Incident fixture",
    "",
    "## Verification",
    "",
    ...bullets.map((bullet) => `- ${bullet}`),
    "",
  ].join("\n");
}

/**
 * The freeze path needs at least one Plan Steps row. Keeping the headings
 * compact makes the first Verification bullet line 5 here too, so the same
 * line-specific assertion covers extraction and freeze.
 */
function freezeableIncidentPlan(): string {
  return [
    "# Plan: Incident fixture",
    "## Plan Steps",
    "1. Run the final gate",
    "## Verification",
    ...INCIDENT.verificationBullets.map((bullet) => `- ${bullet}`),
    "",
  ].join("\n");
}

type ShapeValidation = { ok: true } | { ok: false; error: string };
type SpecsValidation = { ok: true } | { ok: false; error: string };

interface ExecutionValidators {
  validateCommandShape(command: unknown): ShapeValidation;
  validatePlanCheckSpecs(
    specs: readonly PlanCheckSpec[],
    workspaces?: readonly string[],
  ): SpecsValidation;
}

/**
 * The execution guard is added by the parser-hardening step. Loading it
 * dynamically keeps the authoring regressions runnable first and makes a
 * missing export fail with the contract name instead of a module-link error.
 */
async function executionValidators(): Promise<ExecutionValidators> {
  const module = (await import("./plan-checks.ts")) as Record<string, unknown>;
  assert.equal(
    typeof module.validateCommandShape,
    "function",
    "plan-checks.ts must export validateCommandShape(command)",
  );
  assert.equal(
    typeof module.validatePlanCheckSpecs,
    "function",
    "plan-checks.ts must export validatePlanCheckSpecs(specs, workspaces)",
  );
  return module as unknown as ExecutionValidators;
}

test("the five original mixed command/prose bullets fail with a line-specific error", () => {
  assert.equal(INCIDENT.verificationBullets.length, 5, "fixture must keep all five bullets");
  const result = extractPlanChecksDetailed(
    verificationPlan(INCIDENT.verificationBullets),
  );

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.error, new RegExp(`line ${INCIDENT_LINE}`, "i"));
  assert.match(result.error, /mixed|prose|command/i);
});

test("each incident bullet is rejected on its own, never returned as a command", () => {
  for (const [index, bullet] of INCIDENT.verificationBullets.entries()) {
    const result = extractPlanChecksDetailed(verificationPlan([bullet]));
    assert.equal(result.ok, false, `incident bullet ${index + 1} must not parse as a command`);
    if (result.ok) continue;
    assert.match(
      result.error,
      new RegExp(`line ${INCIDENT_LINE}`, "i"),
      `incident bullet ${index + 1} must name its 1-based plan line`,
    );
  }
});

test("a plan with the incident bullets cannot be frozen", () => {
  const frozen = createFrozenTodosFromPlan({
    planPath: "C:/work/.pi/plans/incident.md",
    planText: freezeableIncidentPlan(),
    mode: "build",
    now: 1_000,
  });

  assert.equal(frozen.ok, false);
  if (frozen.ok) return;
  assert.match(frozen.error, new RegExp(`line ${INCIDENT_LINE}`, "i"));
});

test("fenced one-command-per-line Verification still yields exact gates", () => {
  const markdown = [
    "# Plan: Fenced checks",
    "",
    "## Verification",
    "",
    "```bash",
    "npm test",
    "cd sub && npm run lint",
    "```",
    "",
    "- `node --test suite.test.ts`",
    "- This prose must not run.",
    "",
  ].join("\n");

  assert.deepEqual(extractPlanChecks(markdown), [
    "npm test",
    "cd sub && npm run lint",
    "node --test suite.test.ts",
  ]);
});

test("one whole-bullet code span and one raw bullet command are both safe", () => {
  const markdown = [
    "# Plan: Bullets",
    "",
    "## Verification",
    "",
    "- `npm run lint`",
    "- npm test",
    "",
  ].join("\n");

  assert.deepEqual(extractPlanChecks(markdown), ["npm run lint", "npm test"]);
});

test("workspace tags on fenced lines and on a Workspace: label are preserved", () => {
  const markdown = [
    "# Plan: Workspace tags",
    "",
    "## Verification",
    "",
    "```bash",
    "[W] npm test",
    "npm run lint",
    "```",
    "",
    "Workspace: W",
    "- npm run build",
    "",
  ].join("\n");

  const result = extractPlanChecksWithWorkspaceDetailed(markdown);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.specs, [
    { command: "npm test", workspace: "W" },
    { command: "npm run lint" },
    { command: "npm run build", workspace: "W" },
  ]);
});

test("quoted separators stay inside one command", () => {
  const markdown = [
    "# Plan: Quoted separators",
    "",
    "## Verification",
    "",
    "```bash",
    'node -e "console.log(\'a,b;c\')"',
    'node --test "suite with spaces.test.ts"',
    "```",
    "",
  ].join("\n");

  assert.deepEqual(extractPlanChecks(markdown), [
    'node -e "console.log(\'a,b;c\')"',
    'node --test "suite with spaces.test.ts"',
  ]);
});

test("CRLF plans parse exactly like LF plans", () => {
  const markdown =
    [
      "# Plan: CRLF",
      "",
      "## Verification",
      "",
      "```bash",
      "npm test",
      "npm run lint",
      "```",
      "",
    ].join("\r\n") + "\r\n";

  assert.deepEqual(extractPlanChecks(markdown), ["npm test", "npm run lint"]);
});

test("prose-only Verification yields zero checks and no error", () => {
  const markdown = [
    "# Plan: Prose only",
    "",
    "## Verification",
    "",
    "All checks are described below and run by a human.",
    "",
    "- Keyboard navigation is verified manually.",
    "- Release diagnostics are reported honestly.",
    "",
  ].join("\n");

  const result = extractPlanChecksDetailed(markdown);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.checks, []);
});

test("valid extracted commands satisfy the execution validator", async () => {
  const validators = await executionValidators();
  const markdown = [
    "# Plan: Executable",
    "",
    "## Verification",
    "",
    "```bash",
    "npm test",
    "node --test suite.test.ts",
    "```",
    "",
  ].join("\n");
  const extracted = extractPlanChecksDetailed(markdown);
  assert.equal(extracted.ok, true);
  if (!extracted.ok) return;

  const validated = validators.validatePlanCheckSpecs(
    extracted.checks.map((command) => ({ command })),
    [],
  );
  assert.equal(validated.ok, true);
});

test("the frozen incident list is rejected before any command can run", async () => {
  const validators = await executionValidators();
  assert.equal(INCIDENT.frozenPlanCheckSpecs.length, 5);
  let executed = 0;

  // This mirrors the production gate: validation first, shell only on success.
  const execute = (specs: readonly PlanCheckSpec[]): SpecsValidation => {
    const validation = validators.validatePlanCheckSpecs(specs, []);
    if (!validation.ok) return validation;
    executed += specs.length;
    return validation;
  };

  const result = execute(INCIDENT.frozenPlanCheckSpecs);
  assert.equal(result.ok, false, "malformed frozen v1 checks must fail closed");
  assert.equal(executed, 0, "no malformed string may reach pnpm or any shell");
  if (result.ok) return;
  assert.match(result.error, /command|backtick|mixed|prose/i);
});

test("a prose Acceptance value is preserved at freeze but never command-shaped", async () => {
  const metadata = extractRowMetadata(
    `Acceptance: ${INCIDENT.frozenRowAcceptance[0]}\n`,
  );
  assert.deepEqual(metadata.acceptanceChecks, INCIDENT.frozenRowAcceptance);

  const validators = await executionValidators();
  const shape = validators.validateCommandShape(metadata.acceptanceChecks[0]);
  assert.equal(shape.ok, false, "prose Acceptance is evidence, not a shell command");

  let executed = 0;
  if (shape.ok) executed += 1;
  assert.equal(executed, 0, "prose Acceptance must not reach runVerificationCommand");

  const specs = validators.validatePlanCheckSpecs(
    metadata.acceptanceChecks.map((command) => ({ command })),
    [],
  );
  assert.equal(specs.ok, false);
});
