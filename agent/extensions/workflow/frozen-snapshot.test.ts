/**
 * Frozen execution snapshot v2 and the v1 upcaster (v2 step 8).
 *
 * The v1 fixture is the incident shape: five Markdown sentences in
 * `planChecks`. The contract must read that run (it exists on disk), quarantine
 * every malformed check with its exact bytes, never execute it, and project the
 * result back to a v1 view the current panel/tools still validate. A future
 * snapshot version must fail closed instead of being half-read.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  FROZEN_EXECUTION_SCHEMA_VERSION,
  FROZEN_V1_UPCAST_COMPILER,
  buildFrozenExecutionSnapshot,
  frozenExecutionToPlanSpec,
  frozenExecutionToTodoSnapshot,
  frozenSnapshotVersionOf,
  readFrozenSnapshot,
  validateFrozenExecutionSnapshot,
  type FrozenExecutionRowInput,
  type FrozenExecutionSnapshot,
} from "./frozen-snapshot.ts";
import { planCheckId, rowCheckId, sha256Hex, type CheckSpec } from "./plan-spec.ts";
import { validateCommandShape } from "./plan-checks.ts";
import {
  createFrozenTodosFromPlan,
  createFrozenTodosFromSteps,
  validateFrozenSnapshot,
} from "./todo-snapshot.ts";
import type { FrozenWorkspace } from "./orchestrator-workspace-set.ts";

const digest = sha256Hex("incident plan bytes");

const PRIMARY: FrozenWorkspace = {
  id: "W",
  key: "plain:C:/work",
  root: "C:/work",
  kind: "plain",
  displayPath: "C:/work",
  primary: true,
};
const SECONDARY: FrozenWorkspace = {
  id: "D",
  key: "plain:C:/docs",
  root: "C:/docs",
  kind: "plain",
  displayPath: "C:/docs",
  primary: false,
};

/** Verbatim `todos.frozen` plan checks from run-2026-11-21 (seq 2). */
const INCIDENT_CHECKS = [
  "pnpm dev:preflight`, followed by controlled `npm run dev` smoke on the repaired local demo.",
  "pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test`, golden comparisons at the repository's exact tolerance.",
  "pnpm check` (the existing 19-gate chain), plus `check:docs-reference`, `check:docs-glossary` and focused generated-snapshot checks where applicable.",
  "pnpm db:test:invariants`, `pnpm db:test:ledger-tamper`, `pnpm db:verify-ledger` and migration/backfill/restore rehearsal on disposable databases only. Record fresh-install and upgrade results separately.",
  "pnpm docs:build` and `pnpm check:release` as diagnostics: report pending release/human gates honestly, not as conditions that can be fabricated or bypassed.",
];

function v1Snapshot(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    executionId: "todo-exec-4f5693849d93-1795440365299",
    mode: "orchestrator",
    source: {
      kind: "plan",
      path: "C:/repo/.pi/plans/2026-11-21-misa-audit-dev-recovery.md",
      digest,
      title: "MISA audit recovery",
    },
    rows: [
      {
        id: "row-1",
        ref: "1",
        text: "Reconcile documentation and remaining backlog.",
        label: "15",
        source: "plan",
        planStepId: "step-15",
        acceptanceChecks: [
          "The docs are reconciled with the new contract.",
          "pnpm test",
        ],
        expectedFiles: ["docs/README.md"],
        status: "completed",
        sourceLine: 120,
      },
      {
        id: "row-2",
        ref: "2",
        text: "Verify the repaired local demo.",
        label: "16",
        source: "plan",
        planStepId: "step-16",
        acceptanceChecks: [],
        expectedFiles: [],
        status: "pending",
        sourceLine: 140,
      },
    ],
    planChecks: [...INCIDENT_CHECKS],
    planCheckSpecs: INCIDENT_CHECKS.map((command) => ({ command })),
    createdAt: 1795440365299,
    ...overrides,
  };
}

function typedRow(overrides: Partial<FrozenExecutionRowInput> = {}): FrozenExecutionRowInput {
  return {
    id: "row-1",
    ref: "1",
    text: "Add the typed snapshot",
    checks: [
      { id: rowCheckId("1", 0), command: "pnpm test", kind: "gate" },
    ],
    acceptanceCriteria: ["The snapshot parses."],
    expectedFiles: ["frozen-snapshot.ts"],
    workspaces: [],
    sourceLine: 10,
    ...overrides,
  };
}

function typedCheck(overrides: Partial<CheckSpec> = {}): CheckSpec {
  return { id: planCheckId(0), command: "pnpm typecheck", kind: "gate", ...overrides };
}

function buildV2(overrides: Record<string, unknown> = {}) {
  const built = buildFrozenExecutionSnapshot({
    executionId: "todo-exec-abc",
    mode: "orchestrator",
    source: {
      kind: "plan",
      path: "C:/repo/.pi/plans/example.md",
      digest,
      bytesSha256: digest,
      title: "Example plan",
    },
    compilerVersion: "plan-compiler/1",
    rows: [typedRow()],
    checks: [typedCheck()],
    createdAt: 1000,
    ...overrides,
  });
  assert.equal(built.ok, true, built.ok ? "" : built.error);
  return (built as { ok: true; value: FrozenExecutionSnapshot }).value;
}

test("v1 snapshots upcast deterministically and keep row identity", () => {
  const first = readFrozenSnapshot(v1Snapshot());
  const second = readFrozenSnapshot(v1Snapshot());
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  if (!first.ok || !second.ok) return;
  assert.equal(first.fromVersion, 1);
  assert.equal(first.snapshot.schemaVersion, FROZEN_EXECUTION_SCHEMA_VERSION);
  assert.equal(first.snapshot.compiler.version, FROZEN_V1_UPCAST_COMPILER);
  assert.deepEqual(first.snapshot, second.snapshot);
  assert.deepEqual(
    first.snapshot.rows.map((row) => [row.id, row.ref, row.status]),
    [
      ["row-1", "1", "completed"],
      ["row-2", "2", "pending"],
    ],
  );
  assert.equal(first.snapshot.source.bytesSha256, digest);
});

test("malformed v1 plan checks are quarantined, never typed", () => {
  const read = readFrozenSnapshot(v1Snapshot());
  assert.equal(read.ok, true);
  if (!read.ok) return;
  assert.deepEqual(read.snapshot.checks, []);
  assert.deepEqual(read.snapshot.planChecks, []);
  assert.deepEqual(read.snapshot.planCheckSpecs, []);
  assert.equal(read.snapshot.validation.ok, false);
  assert.equal(read.quarantined.length, INCIDENT_CHECKS.length);
  assert.deepEqual(
    read.quarantined.map((entry) => entry.command),
    INCIDENT_CHECKS,
  );
  for (const entry of read.quarantined) {
    assert.equal(entry.scope, "plan");
    assert.equal(entry.fromVersion, 1);
    assert.match(entry.reason, /backtick|command/);
  }
  assert.ok(read.warnings.some((warning) => /quarantined/.test(warning)));
});

test("valid v1 plan checks become typed gates with workspace aliases", () => {
  const read = readFrozenSnapshot(
    v1Snapshot({
      workspaces: [
        {
          id: "D",
          key: "plain:C:/repo",
          root: "C:/repo",
          kind: "plain",
          displayPath: "C:/repo",
          primary: true,
        },
      ],
      planChecks: ["pnpm typecheck"],
      planCheckSpecs: [{ command: "pnpm typecheck", workspace: "D" }],
    }),
  );
  assert.equal(read.ok, true);
  if (!read.ok) return;
  assert.deepEqual(read.snapshot.checks, [
    { id: "check-1", command: "pnpm typecheck", workspace: "D", kind: "gate" },
  ]);
  assert.deepEqual(read.snapshot.planChecks, ["pnpm typecheck"]);
  assert.deepEqual(read.snapshot.planCheckSpecs, [
    { command: "pnpm typecheck", workspace: "D" },
  ]);
  assert.equal(read.snapshot.validation.ok, true);
  assert.equal(read.quarantined.length, 0);
});

test("v1 prose acceptance values become criteria; commands stay executable", () => {
  const read = readFrozenSnapshot(v1Snapshot());
  assert.equal(read.ok, true);
  if (!read.ok) return;
  const row = read.snapshot.rows[0]!;
  assert.deepEqual(row.checks, [{ id: "check-row-1-1", command: "pnpm test", kind: "gate" }]);
  assert.deepEqual(row.acceptanceCriteria, ["The docs are reconciled with the new contract."]);
  // Derived view keeps the v1 contract: commands first, then criteria.
  assert.deepEqual(row.acceptanceChecks, ["pnpm test", "The docs are reconciled with the new contract."]);
  assert.ok(
    read.warnings.some((warning) => /row 1: .*criteria/.test(warning)),
    "the upcast explains that a v1 acceptance value is now evidence",
  );
});

test("unknown snapshot versions fail closed", () => {
  const future = readFrozenSnapshot({ ...buildV2(), schemaVersion: 3 });
  assert.equal(future.ok, false);
  if (!future.ok) assert.equal(future.code, "unknown_version");

  const oldMarker = readFrozenSnapshot({ ...v1Snapshot(), version: 2 });
  assert.equal(oldMarker.ok, false);
  if (!oldMarker.ok) assert.equal(oldMarker.code, "unknown_version");

  const versionless = readFrozenSnapshot({ rows: [] });
  assert.equal(versionless.ok, false);
  if (!versionless.ok) assert.equal(versionless.code, "invalid");

  assert.equal(frozenSnapshotVersionOf(buildV2()), 2);
  assert.equal(frozenSnapshotVersionOf(v1Snapshot()), 1);
  assert.equal(frozenSnapshotVersionOf(null), undefined);
});

test("v2 validation rejects derived-view drift, a wrong hash and bad bounds", () => {
  const snapshot = buildV2();

  const drifted = { ...snapshot, planChecks: ["pnpm test"] };
  assert.equal(validateFrozenExecutionSnapshot(drifted).ok, false);

  const wrongHash = { ...snapshot, compiler: { ...snapshot.compiler, specHash: "0".repeat(64) } };
  assert.equal(validateFrozenExecutionSnapshot(wrongHash).ok, false);

  const duplicate = {
    ...snapshot,
    rows: [snapshot.rows[0], { ...snapshot.rows[0], ref: "2" }],
  };
  assert.equal(validateFrozenExecutionSnapshot(duplicate).ok, false);

  const badTimeout = {
    ...snapshot,
    checks: [{ ...snapshot.checks[0]!, timeoutMs: 0 }],
  };
  assert.equal(validateFrozenExecutionSnapshot(badTimeout).ok, false);

  const unknownField = { ...snapshot, planCheckSpecsTyped: [] };
  assert.equal(validateFrozenExecutionSnapshot(unknownField).ok, false);

  const emptyRows = { ...snapshot, rows: [] };
  assert.equal(validateFrozenExecutionSnapshot(emptyRows).ok, false);
});

test("a typed build derives the legacy views and re-reads as v2", () => {
  const snapshot = buildV2({
    checks: [
      typedCheck({ id: planCheckId(0), command: "pnpm typecheck" }),
      typedCheck({ id: planCheckId(1), command: "pnpm docs:build", kind: "diagnostic" }),
    ],
  });
  assert.deepEqual(snapshot.planChecks, ["pnpm typecheck", "pnpm docs:build"]);
  assert.deepEqual(snapshot.planCheckSpecs, [
    { command: "pnpm typecheck" },
    { command: "pnpm docs:build" },
  ]);
  assert.equal(snapshot.validation.ok, true);

  const read = readFrozenSnapshot(snapshot);
  assert.equal(read.ok, true);
  if (!read.ok) return;
  assert.equal(read.fromVersion, 2);
  assert.deepEqual(read.snapshot, snapshot);
});

test("a v2 snapshot projects back to the v1 shape existing consumers validate", () => {
  const read = readFrozenSnapshot(v1Snapshot());
  assert.equal(read.ok, true);
  if (!read.ok) return;
  const legacy = frozenExecutionToTodoSnapshot(read.snapshot);
  const validated = validateFrozenSnapshot(legacy);
  assert.equal(validated.ok, true, validated.ok ? "" : validated.error);
  assert.deepEqual(legacy.planChecks, []);
  assert.deepEqual(legacy.rows[0]!.acceptanceChecks, [
    "pnpm test",
    "The docs are reconciled with the new contract.",
  ]);

  const planSpec = frozenExecutionToPlanSpec(read.snapshot);
  assert.equal(planSpec.ok, true, planSpec.ok ? "" : planSpec.error);
  if (planSpec.ok) {
    assert.deepEqual(planSpec.value.planChecks, []);
    assert.equal(planSpec.value.rows.length, 2);
  }
});

test("a foreign snapshot is not parsed as v1", () => {
  const read = readFrozenSnapshot({ version: 1, rows: "not-an-array" });
  assert.equal(read.ok, false);
  if (!read.ok) assert.equal(read.code, "invalid");

  const discussion = readFrozenSnapshot(
    v1Snapshot({
      source: { kind: "discussion", digest, title: "Chat" },
    }),
  );
  assert.equal(discussion.ok, false);
  if (!discussion.ok) assert.match(discussion.error, /discussion/);
});

test("freeze writes a compiled v2 snapshot and derives the legacy views", () => {
  const plan = [
    "# Plan: Freeze",
    "",
    "## Plan Steps",
    "",
    "1. Add the typed freeze",
    "   Acceptance: the snapshot stores typed checks",
    "   Checks:",
    "   - node --test row.test.ts",
    "   Files: frozen-snapshot.ts",
    "   Workspaces: W",
    "",
    "## Verification",
    "",
    "```bash",
    "[D] node --test final.test.ts",
    "node --test primary.test.ts",
    "```",
    "",
  ].join("\n");
  const built = createFrozenTodosFromPlan({
    planPath: "C:/work/.pi/plans/freeze.md",
    planText: plan,
    mode: "build",
    workspaces: [PRIMARY, SECONDARY],
    now: 1_000,
  });
  assert.equal(built.ok, true, built.ok ? "" : built.error);
  if (!built.ok) return;
  const execution = built.execution;
  assert.ok(execution, "the freeze exposes the compiled v2 artifact");
  if (!execution) return;

  assert.equal(execution.schemaVersion, FROZEN_EXECUTION_SCHEMA_VERSION);
  assert.equal(execution.mode, "build");
  assert.equal(execution.source.path, "C:/work/.pi/plans/freeze.md");
  assert.equal(execution.source.bytesSha256, sha256Hex(plan));
  assert.equal(execution.compiler.version, "plan-compiler/1");
  assert.equal(execution.validation.ok, true);
  assert.deepEqual(execution.workspaces, [PRIMARY, SECONDARY]);

  assert.deepEqual(execution.rows[0]!.checks, [
    { id: "check-row-1-1", command: "node --test row.test.ts", kind: "gate" },
  ]);
  assert.deepEqual(execution.rows[0]!.acceptanceCriteria, [
    "the snapshot stores typed checks",
  ]);
  assert.deepEqual(execution.rows[0]!.acceptanceChecks, [
    "node --test row.test.ts",
    "the snapshot stores typed checks",
  ]);
  assert.deepEqual(execution.rows[0]!.workspaces, ["W"]);
  assert.deepEqual(execution.checks, [
    {
      id: "check-1",
      command: "node --test final.test.ts",
      workspace: "D",
      kind: "gate",
    },
    { id: "check-2", command: "node --test primary.test.ts", kind: "gate" },
  ]);
  assert.deepEqual(execution.planChecks, [
    "node --test final.test.ts",
    "node --test primary.test.ts",
  ]);
  assert.deepEqual(execution.planCheckSpecs, [
    { command: "node --test final.test.ts", workspace: "D" },
    { command: "node --test primary.test.ts" },
  ]);

  // The v1 projection is what the panel/executor consumes today, and prose
  // acceptance is evidence, never a command.
  assert.equal(built.snapshot.version, 1);
  assert.equal(validateFrozenSnapshot(built.snapshot).ok, true);
  assert.deepEqual(built.snapshot.workspaces, [PRIMARY, SECONDARY]);
  assert.deepEqual(built.snapshot.planChecks, execution.planChecks);
  assert.deepEqual(built.snapshot.rows[0]!.acceptanceChecks, execution.rows[0]!.acceptanceChecks);
  assert.equal(validateCommandShape("the snapshot stores typed checks").ok, false);

  const reread = readFrozenSnapshot(execution);
  assert.equal(reread.ok, true);
  if (reread.ok) {
    assert.equal(reread.fromVersion, 2);
    assert.deepEqual(reread.snapshot, execution);
  }
});

test("freeze rejects a legacy check view that diverges from the compiler", () => {
  const plan = [
    "# Plan: Divergence",
    "## Plan Steps",
    "1. One",
    "## Verification",
    "```bash",
    "node --test real.test.ts",
    "```",
  ].join("\n");
  const built = createFrozenTodosFromPlan({
    planPath: "C:/work/.pi/plans/divergence.md",
    planText: plan,
    mode: "build",
    planChecks: ["node --test other.test.ts"],
  });
  assert.equal(built.ok, false);
  if (!built.ok) assert.match(built.error, /diverge/);
});

test("standalone steps freeze v2 with typed plan checks and no plan binding", () => {
  const built = createFrozenTodosFromSteps({
    title: "Agreed work",
    steps: ["First", "Second"],
    mode: "orchestrator",
    planCheckSpecs: [{ command: "node --test final.test.ts" }],
    now: 2_000,
  });
  assert.equal(built.ok, true, built.ok ? "" : built.error);
  if (!built.ok) return;
  const execution = built.execution;
  assert.ok(execution);
  if (!execution) return;
  assert.equal(execution.schemaVersion, FROZEN_EXECUTION_SCHEMA_VERSION);
  assert.equal(execution.source.kind, "steps");
  assert.deepEqual(execution.planChecks, ["node --test final.test.ts"]);
  assert.deepEqual(execution.checks, [
    { id: "check-1", command: "node --test final.test.ts", kind: "gate" },
  ]);
  assert.equal(execution.rows.every((row) => row.planStepId === undefined), true);
  assert.equal(execution.rows.every((row) => row.checks.length === 0), true);
});
