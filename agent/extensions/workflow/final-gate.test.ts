/**
 * Final-gate marker contract.
 *
 * The two completion call paths must share one durable verdict: a passing gate
 * is content-addressed by the exact executable spec, reused instead of re-run,
 * and invalidated by any change to the checks, their kinds/timeouts or the
 * workspace bindings. A changed hash can never inherit an old pass.
 */

import assert from "node:assert/strict";
import test from "node:test";

import type { CheckExecutionResult } from "./check-executor.ts";
import {
  FINAL_GATE_EVENT_TYPE,
  FINAL_GATE_PAYLOAD_VERSION,
  buildFinalGatePayload,
  computeFinalGateSpecHash,
  finalGateCheckSpecs,
  finalGateCompletionError,
  finalGateEventId,
  finalGateSatisfied,
  findFinalGateRecord,
  latestFinalGateRecord,
  parseFinalGatePayload,
  summarizeFinalGateResults,
  validateFinalGatePayload,
} from "./final-gate.ts";
import { validateJournalEventPayload } from "./journal-payloads.ts";
import type { FrozenWorkspace } from "./orchestrator-workspace-set.ts";

const WORKSPACES: FrozenWorkspace[] = [
  {
    id: "W",
    key: "git:C:/work",
    root: "C:/work",
    kind: "git",
    displayPath: "C:/work",
    primary: true,
  },
  {
    id: "X",
    key: "git:C:/work/x",
    root: "C:/work/x",
    kind: "git",
    displayPath: "C:/work/x",
    primary: false,
  },
];

function result(overrides: Partial<CheckExecutionResult> = {}): CheckExecutionResult {
  return {
    checkId: "check-1",
    command: "npm run check",
    kind: "gate",
    ok: true,
    failureClass: "none",
    repairable: false,
    exitCode: 0,
    output: "ok",
    truncated: false,
    durationMs: 12,
    message: "",
    ...overrides,
  };
}

test("the gate spec is derived from the frozen legacy views in command order", () => {
  const fromCommands = finalGateCheckSpecs({
    planChecks: ["npm run a", "npm run b"],
  });
  assert.deepEqual(
    fromCommands.map((spec) => [spec.id, spec.command, spec.kind]),
    [
      ["check-1", "npm run a", "gate"],
      ["check-2", "npm run b", "gate"],
    ],
  );
  const withWorkspace = finalGateCheckSpecs({
    planChecks: ["npm run a"],
    planCheckSpecs: [{ command: "npm run a", workspace: "X" }],
  });
  assert.equal(withWorkspace[0]?.workspace, "X");
});

test("the spec hash is deterministic and ignores evidence-only fields", () => {
  const checks = finalGateCheckSpecs({ planChecks: ["npm run a"] });
  const first = computeFinalGateSpecHash({ checks, workspaces: WORKSPACES });
  const again = computeFinalGateSpecHash({
    checks: finalGateCheckSpecs({ planChecks: ["npm run a"] }),
    workspaces: [...WORKSPACES].reverse(),
  });
  assert.equal(first, again, "workspace order must not change the hash");
  assert.match(first, /^[a-f0-9]{64}$/);

  const record = buildFinalGatePayload({
    specHash: first,
    ok: true,
    checkedAt: 1,
    results: [result({ output: "different evidence" })],
  });
  assert.equal(record.specHash, first, "results never change the spec hash");
});

test("a changed command, kind, timeout or workspace root invalidates the hash", () => {
  const base = computeFinalGateSpecHash({
    checks: finalGateCheckSpecs({ planChecks: ["npm run a"] }),
    workspaces: WORKSPACES,
  });
  const changedCommand = computeFinalGateSpecHash({
    checks: finalGateCheckSpecs({ planChecks: ["npm run b"] }),
    workspaces: WORKSPACES,
  });
  const changedWorkspace = computeFinalGateSpecHash({
    checks: finalGateCheckSpecs({ planChecks: ["npm run a"] }),
    workspaces: [{ ...WORKSPACES[0]!, root: "C:/other" }, WORKSPACES[1]!],
  });
  const changedKind = computeFinalGateSpecHash({
    checks: [{ id: "check-1", command: "npm run a", kind: "diagnostic" }],
    workspaces: WORKSPACES,
  });
  assert.notEqual(changedCommand, base);
  assert.notEqual(changedWorkspace, base);
  assert.notEqual(changedKind, base);
});

test("results are bounded and never store command output", () => {
  const summarized = summarizeFinalGateResults([
    result({ command: "x".repeat(900), output: "very long evidence".repeat(100) }),
  ]);
  assert.equal(summarized[0]?.command.length, 500);
  assert.equal((summarized[0] as unknown as { output?: string }).output, undefined);
  assert.equal(summarized[0]?.exitCode, 0);
});

test("the payload round-trips through the validator", () => {
  const specHash = computeFinalGateSpecHash({
    checks: finalGateCheckSpecs({ planChecks: ["npm run a"] }),
    workspaces: WORKSPACES,
  });
  const payload = buildFinalGatePayload({
    specHash,
    ok: false,
    checkedAt: 1_000,
    results: [
      result({ ok: false, failureClass: "test", exitCode: 1, workspaceId: "W" }),
    ],
    workspaceRevisions: { W: "rev-1" },
    failureClass: "test",
    failure: "npm run a: exit 1",
  });
  assert.equal(payload.version, FINAL_GATE_PAYLOAD_VERSION);
  const parsed = parseFinalGatePayload(payload);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.deepEqual(parsed.value, payload);
  assert.equal(validateFinalGatePayload(payload as unknown as Record<string, unknown>), undefined);
});

test("the validator fails closed on an unknown version, hash or failure class", () => {
  const specHash = computeFinalGateSpecHash({ checks: [] });
  const payload = buildFinalGatePayload({ specHash, ok: true, checkedAt: 1 });
  const versioned = parseFinalGatePayload({ ...payload, version: 2 });
  assert.equal(versioned.ok, false);
  assert.match(versioned.ok ? "" : versioned.error, /unknown payload version/);

  const badHash = parseFinalGatePayload({ ...payload, specHash: "not-a-hash" });
  assert.equal(badHash.ok, false);

  const badClass = parseFinalGatePayload({
    ...payload,
    results: summarizeFinalGateResults([
      result({ ok: false, failureClass: "test", exitCode: 1 }),
    ]).map((entry) => ({ ...entry, failureClass: "banana" })),
  });
  assert.equal(badClass.ok, false);
  assert.match(badClass.ok ? "" : badClass.error, /failure class/);
});

test("the journal registry validates final_gate and rejects a future payload version", () => {
  const specHash = computeFinalGateSpecHash({ checks: [] });
  const payload = buildFinalGatePayload({ specHash, ok: true, checkedAt: 1 });
  assert.deepEqual(validateJournalEventPayload(FINAL_GATE_EVENT_TYPE, payload), {
    ok: true,
    warnings: [],
  });
  const future = validateJournalEventPayload(FINAL_GATE_EVENT_TYPE, {
    ...payload,
    version: 9,
  });
  assert.equal(future.ok, false);
  assert.equal(future.ok ? "" : future.code, "unknown_version");
});

test("the event id is stable for identical records and distinct for a new attempt", () => {
  const specHash = computeFinalGateSpecHash({ checks: [] });
  const first = buildFinalGatePayload({ specHash, ok: true, checkedAt: 1_000 });
  const same = buildFinalGatePayload({ specHash, ok: true, checkedAt: 1_000 });
  const retry = buildFinalGatePayload({ specHash, ok: true, checkedAt: 2_000 });
  const failed = buildFinalGatePayload({ specHash, ok: false, checkedAt: 1_000 });
  assert.equal(finalGateEventId(first), finalGateEventId(same));
  assert.notEqual(finalGateEventId(first), finalGateEventId(retry));
  assert.notEqual(finalGateEventId(first), finalGateEventId(failed));
});

test("only a matching passing record satisfies completion", () => {
  const specHash = computeFinalGateSpecHash({ checks: [] });
  const otherHash = computeFinalGateSpecHash({
    checks: finalGateCheckSpecs({ planChecks: ["npm run changed"] }),
  });
  const passing = buildFinalGatePayload({ specHash, ok: true, checkedAt: 1 });
  const failing = buildFinalGatePayload({ specHash, ok: false, checkedAt: 2 });
  const events = [
    { type: "run.created", payload: {} },
    { type: FINAL_GATE_EVENT_TYPE, payload: passing },
  ];
  assert.equal(finalGateSatisfied(events, specHash), true);
  assert.equal(finalGateSatisfied(events, otherHash), false);
  assert.equal(findFinalGateRecord(events, otherHash), undefined);
  assert.equal(latestFinalGateRecord(events)?.specHash, specHash);

  const failedOnly = [{ type: FINAL_GATE_EVENT_TYPE, payload: failing }];
  assert.equal(finalGateSatisfied(failedOnly, specHash), false);
  assert.match(
    finalGateCompletionError(specHash, latestFinalGateRecord(failedOnly)),
    /last run failed/,
  );
  assert.match(finalGateCompletionError(specHash), /has not run/);
});

test("a tampered or unreadable final_gate line is not treated as a pass", () => {
  const specHash = computeFinalGateSpecHash({ checks: [] });
  const events = [
    { type: FINAL_GATE_EVENT_TYPE, payload: { version: 1, specHash, ok: true } },
  ];
  assert.equal(latestFinalGateRecord(events), undefined);
  assert.equal(finalGateSatisfied(events, specHash), false);
});
