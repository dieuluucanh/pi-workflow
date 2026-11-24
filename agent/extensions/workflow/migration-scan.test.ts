/**
 * Read-only migration scanner tests (plan-execution contract, row 19).
 *
 * The scanner is the rollout inventory: it must classify a v1 run, a repaired
 * v1 run, an unreadable snapshot, a stale snapshot cache, an unbound workspace
 * alias and a plan that no longer compiles — without writing anything.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildMigrationReport,
  formatMigrationReport,
  scanPlanText,
  scanRunJournal,
} from "./migration-scan.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONTRACT = path.join(HERE, "fixtures", "plan-contract");
const RUN_ID = "run-2026-11-24-upcast-fixture-000000000000";

function fixtureJournal(): string {
  return fs.readFileSync(path.join(CONTRACT, "v1-journal.ndjson"), "utf8");
}

function fixtureSnapshot(): Record<string, unknown> {
  return JSON.parse(
    fs.readFileSync(path.join(CONTRACT, "v1-snapshot.json"), "utf8"),
  ) as Record<string, unknown>;
}

function lines(text: string): string[] {
  return text.split("\n").filter((line) => line.length > 0);
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
    .join(",")}}`;
}

function eventLine(
  seq: number,
  eventId: string,
  type: string,
  payload: unknown,
  prev: string,
  runId = RUN_ID,
): string {
  const base = {
    version: 1,
    seq,
    eventId,
    at: 1_700_000_000_000 + seq,
    type,
    runId,
    payload,
    prev,
  };
  const checksum = createHash("sha256")
    .update(canonical(base), "utf8")
    .digest("hex");
  return JSON.stringify({ ...base, checksum });
}

/** A minimal two-event journal around an arbitrary v1 snapshot. */
function journalForSnapshot(snapshot: Record<string, unknown>): string {
  const created = eventLine(
    1,
    "created-fixture",
    "run.created",
    {
      sourcePath: "C:/repo/.pi/plans/upcast.md",
      digest: snapshot.source && (snapshot.source as Record<string, unknown>).digest,
      title: "Upcast fixture",
      mode: "orchestrator",
      rowCount: 1,
    },
    "",
  );
  const frozenPrev = JSON.parse(created).checksum as string;
  const frozen = eventLine(
    2,
    "frozen-fixture",
    "todos.frozen",
    {
      executionId: snapshot.executionId,
      digest: (snapshot.source as Record<string, unknown>).digest,
      snapshot,
    },
    frozenPrev,
  );
  return `${created}\n${frozen}\n`;
}

test("a repaired v1 run scans as readable, amended and v1", () => {
  const run = scanRunJournal({
    runId: RUN_ID,
    journalText: fixtureJournal(),
    runDir: "v1-journal",
  });
  assert.equal(run.readable, true, run.error);
  assert.equal(run.frozenFromVersion, 1);
  assert.equal(run.snapshotVersion, 1);
  assert.equal(run.repairEvents, 1);
  assert.deepEqual(run.quarantined, []);
  assert.deepEqual(run.finalChecks, ["npm run typecheck"]);
  assert.equal(run.typedCheckCount, 1);
  assert.equal(run.phase, "ready");
  assert.equal(run.totalRows, 1);
  assert.equal(run.accepted, 0);
  // The prose acceptance value is reported as a criterion, never a command.
  assert.deepEqual(run.proseAcceptance.map((entry) => entry.value), [
    "the wiring is documented",
  ]);
});

test("an unrepaired v1 run lists every malformed check and a repair action", () => {
  const unrepaired = `${lines(fixtureJournal()).slice(0, 2).join("\n")}\n`;
  const run = scanRunJournal({ runId: RUN_ID, journalText: unrepaired });
  assert.equal(run.readable, true, run.error);
  assert.equal(run.repairEvents, 0);
  assert.equal(run.quarantined.length, 2);
  assert.equal(run.typedCheckCount, 0);
  assert.deepEqual(run.finalChecks, []);
  const report = buildMigrationReport({ runs: [run], plans: [] });
  assert.equal(report.counts.quarantinedChecks, 2);
  assert.ok(
    report.repairList.some((action) => action.includes("repair-orchestrator-checks.mjs")),
    "the repair list names the amendment tool",
  );
});

test("a stale snapshot cache is reported but never rewritten", () => {
  const run = scanRunJournal({
    runId: RUN_ID,
    journalText: fixtureJournal(),
    snapshotText: JSON.stringify({ version: 1, runId: RUN_ID, seq: 99, revision: 99 }),
  });
  assert.equal(run.seq, 3);
  assert.equal(run.snapshotCacheSeq, 99);
  assert.equal(run.staleSnapshotCache, true);
  const report = buildMigrationReport({ runs: [run], plans: [] });
  assert.ok(
    report.repairList.some((action) => action.includes("rebuilds snapshot.json")),
    "the repair list explains the cache rebuild",
  );
});

test("a check bound to an undeclared workspace alias is reported, not defaulted", () => {
  const snapshot = fixtureSnapshot();
  snapshot.planChecks = ["npm test"];
  snapshot.planCheckSpecs = [{ command: "npm test", workspace: "D", kind: "gate" }];
  const run = scanRunJournal({
    runId: RUN_ID,
    journalText: journalForSnapshot(snapshot),
  });
  // The snapshot validator refuses the alias, so the run fails closed instead
  // of silently running in the primary root; the alias is still reported.
  assert.equal(run.readable, false);
  assert.match(run.error ?? "", /unknown workspace "D"/);
  assert.deepEqual(run.missingWorkspaces, [{ scope: "plan", alias: "D" }]);
  assert.equal(run.finalChecks.length, 1);
  const report = buildMigrationReport({ runs: [run], plans: [] });
  assert.ok(
    report.repairList.some((action) => action.includes('bind workspace alias "D"')),
    "the repair list names the unbound alias",
  );
});

test("an unknown snapshot version fails closed and is not executed", () => {
  const snapshot = fixtureSnapshot();
  snapshot.version = 9;
  const run = scanRunJournal({
    runId: RUN_ID,
    journalText: journalForSnapshot(snapshot),
  });
  assert.equal(run.readable, false);
  assert.match(run.error ?? "", /unknown frozen snapshot version 9/);
  assert.ok(
    run.issues.some((issue) => issue.includes("must not execute checks")),
    "an unreadable snapshot is never executed",
  );
});

test("a torn journal tail keeps the valid prefix and reports the truncation", () => {
  const run = scanRunJournal({
    runId: RUN_ID,
    journalText: `${fixtureJournal()}{not json}\n`,
  });
  assert.equal(run.readable, true, run.error);
  assert.equal(run.seq, 3);
  assert.ok(
    run.issues.some((issue) => issue.includes("torn tail")),
    "the truncated tail is reported",
  );
});

test("plan scan: commands-only verification compiles as a gate", () => {
  const markdown = [
    "# Plan: Demo",
    "",
    "## Plan Steps",
    "",
    "1. **Do the thing.**",
    "   Files: a.ts",
    "",
    "## Verification",
    "",
    "```bash",
    "npm test",
    "```",
    "",
  ].join("\n");
  const plan = scanPlanText({ path: "C:/repo/.pi/plans/demo.md", markdown });
  assert.equal(plan.ok, true, plan.error);
  assert.equal(plan.rows, 1);
  assert.equal(plan.gate, 1);
  assert.equal(plan.needsAcknowledgement, false);
});

test("plan scan: a mixed command/prose bullet fails with a line number", () => {
  const markdown = [
    "# Plan: Broken",
    "",
    "## Plan Steps",
    "",
    "1. **Fix it.**",
    "",
    "## Verification",
    "",
    "- `pnpm dev:preflight`, followed by a controlled smoke test.",
    "",
  ].join("\n");
  const plan = scanPlanText({ path: "C:/repo/.pi/plans/broken.md", markdown });
  assert.equal(plan.ok, false);
  assert.ok(plan.diagnostics.some((entry) => entry.severity === "error"));
  const report = buildMigrationReport({ runs: [], plans: [plan] });
  assert.equal(report.counts.failingPlans, 1);
  assert.ok(report.repairList.some((action) => action.includes("does not compile")));
});

test("plan scan: prose-only verification needs an acknowledgement", () => {
  const markdown = [
    "# Plan: Docs",
    "",
    "## Plan Steps",
    "",
    "1. **Write the docs.**",
    "",
    "## Verification",
    "",
    "Everything is reviewed by hand.",
    "",
  ].join("\n");
  const plan = scanPlanText({ path: "C:/repo/.pi/plans/docs.md", markdown });
  assert.equal(plan.ok, true, plan.error);
  assert.equal(plan.gate, 0);
  assert.equal(plan.needsAcknowledgement, true);
  const report = buildMigrationReport({ runs: [], plans: [plan] });
  assert.ok(report.repairList.some((action) => action.includes("no final gate check")));
});

test("plan scan: a missing plan file is reported without aborting the report", () => {
  const plan = scanPlanText({ path: "C:/repo/.pi/plans/gone.md", markdown: null });
  assert.equal(plan.readable, false);
  assert.equal(plan.ok, false);
  const text = formatMigrationReport(buildMigrationReport({ runs: [], plans: [plan] }));
  assert.match(text, /read-only, no journal or snapshot was written/);
  assert.match(text, /gone\.md/);
});
