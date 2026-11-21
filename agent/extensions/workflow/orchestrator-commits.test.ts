/**
 * Verified-acceptance commit tests (step 35): child automation is harmless,
 * the ledger is durable/idempotent, never/ask/allow is honored, baseline
 * overlap refuses automatic staging and an uncertain delivery is reconciled
 * by trailer instead of double-committing.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  applyCommit,
  childPushPolicy,
  createCommitLedger,
  ledgerKey,
  planCommit,
  restoreCommitLedger,
  suppressChildCommit,
  type AcceptedChangeSet,
  type CommitGitPort,
} from "./orchestrator-commits.ts";

function changeSet(over: Partial<AcceptedChangeSet> = {}): AcceptedChangeSet {
  return {
    runId: "run-1",
    taskId: "task-t1",
    evidenceId: "evidence-e1",
    candidateId: "candidate-c1",
    evidenceVerdict: "accepted",
    acceptedPaths: ["src/client.ts", "src\\api.ts", "src/client.ts"],
    baselinePaths: [],
    ...over,
  };
}

function gitPort(options: {
  find?: () => Promise<{ sha: string } | null>;
  commit?: () => Promise<{ sha: string }>;
  calls?: string[];
} = {}): CommitGitPort {
  return {
    async stage(paths) {
      options.calls?.push(`stage:${paths.join(",")}`);
    },
    async commit(input) {
      options.calls?.push(`commit:${input.paths.join(",")}`);
      return options.commit ? options.commit() : { sha: "sha-new" };
    },
    async findCommit(trailer) {
      options.calls?.push(`find:${trailer}`);
      return options.find ? options.find() : null;
    },
  };
}

test("child completion mechanisms and push are suppressed for managed work", () => {
  for (const source of ["todo", "done_tag", "checkbox", "auto_commit", "report"] as const) {
    assert.equal(suppressChildCommit({ source, managed: true }).suppressed, true);
  }
  assert.equal(suppressChildCommit({ source: "todo", managed: false }).suppressed, false);
  assert.equal(childPushPolicy().allowed, false);
});

test("the ledger is idempotent and unknown versions fail closed", () => {
  const ledger = createCommitLedger();
  const entry = {
    schemaVersion: 1 as const,
    key: ledgerKey("run-1", "task-t1", "evidence-e1"),
    runId: "run-1",
    taskId: "task-t1",
    evidenceId: "evidence-e1",
    candidateId: "candidate-c1",
    commitSha: "sha-1",
    paths: ["src/a.ts"],
    committedAt: 5,
  };
  assert.equal(ledger.record(entry).duplicate, false);
  assert.equal(ledger.record({ ...entry, commitSha: "sha-2" }).duplicate, true);
  assert.equal(ledger.get(entry.key)?.commitSha, "sha-1");

  const restored = restoreCommitLedger(ledger.serialize());
  assert.equal(restored.ok, true);
  assert.equal((restored as any).ledger.has(entry.key), true);

  const unknown = restoreCommitLedger({ schemaVersion: 99, entries: {} });
  assert.equal(unknown.ok, false);
  assert.equal((unknown as any).code, "version");

  const corrupt = restoreCommitLedger({
    schemaVersion: 1,
    entries: { broken: { schemaVersion: 1 }, good: entry },
  });
  assert.equal(corrupt.ok, true);
  assert.equal((corrupt as any).ledger.entries().length, 1);
});

test("never/ask/allow and explicit approval are honored with scoped paths", () => {
  const ledger = createCommitLedger();
  const never = planCommit({ mode: "never", changeSet: changeSet(), ledger, now: 1 });
  assert.equal((never as any).action, "skip");

  const ask = planCommit({ mode: "ask", changeSet: changeSet(), ledger, now: 1 });
  assert.equal((ask as any).action, "ask");
  assert.match((ask as any).question, /Commit the accepted changes/);

  const approved = planCommit({
    mode: "ask",
    changeSet: changeSet(),
    ledger,
    approvedPaths: ["src/client.ts", "src/api.ts"],
    now: 1,
  });
  assert.equal((approved as any).action, "commit");
  assert.deepEqual((approved as any).paths, ["src/api.ts", "src/client.ts"]);
  assert.match((approved as any).message, /Pi-Orchestrator-Task: run-1:task-t1:evidence-e1/);

  const allow = planCommit({ mode: "allow", changeSet: changeSet(), ledger, now: 1 });
  assert.equal((allow as any).action, "commit");

  const noFiles = planCommit({
    mode: "allow",
    changeSet: changeSet({ acceptedPaths: [] }),
    ledger,
    now: 1,
  });
  assert.equal((noFiles as any).action, "skip");

  const unverified = planCommit({
    mode: "allow",
    changeSet: changeSet({ evidenceVerdict: "needs_fix" }),
    ledger,
    now: 1,
  });
  assert.equal(unverified.ok, false);
});

test("baseline overlap refuses automatic staging instead of mixing user work", () => {
  const ledger = createCommitLedger();
  const overlap = changeSet({ baselinePaths: ["src/client.ts"] });
  const allow = planCommit({ mode: "allow", changeSet: overlap, ledger, now: 1 });
  assert.equal((allow as any).action, "refuse");
  assert.equal((allow as any).reason, "attribution");
  assert.match((allow as any).question, /already contained user work/);

  const ask = planCommit({ mode: "ask", changeSet: overlap, ledger, now: 1 });
  assert.equal((ask as any).action, "ask");
  assert.equal((ask as any).attributionConflict, true);

  const explicitlyApproved = planCommit({
    mode: "allow",
    changeSet: overlap,
    ledger,
    approvedPaths: ["src/client.ts", "src/api.ts"],
    now: 1,
  });
  assert.equal((explicitlyApproved as any).action, "commit");
});

test("applying a commit stages only accepted paths and records the ledger", async () => {
  const ledger = createCommitLedger();
  const decision = planCommit({ mode: "allow", changeSet: changeSet(), ledger, now: 1 });
  const calls: string[] = [];
  const applied = await applyCommit({ decision, ledger, git: gitPort({ calls }), now: 2 });
  assert.equal(applied.ok, true);
  assert.equal((applied as any).status, "committed");
  assert.equal((applied as any).sha, "sha-new");
  assert.ok(calls.includes("stage:src/api.ts,src/client.ts"));
  assert.ok(calls.includes("commit:src/api.ts,src/client.ts"));
  assert.equal(ledger.has("run-1:task-t1:evidence-e1"), true);

  const again = await applyCommit({ decision, ledger, git: gitPort({ calls }), now: 3 });
  assert.equal((again as any).status, "already_committed");
  assert.equal((again as any).duplicate, true);
  const stages = calls.filter((call) => call.startsWith("stage:"));
  assert.equal(stages.length, 1, "a retry never stages twice");
});

test("an existing trailer commit is adopted and an uncertain failure is reconciled", async () => {
  const ledger = createCommitLedger();
  const decision = planCommit({ mode: "allow", changeSet: changeSet(), ledger, now: 1 });

  const existing = await applyCommit({
    decision,
    ledger,
    git: gitPort({ find: async () => ({ sha: "sha-existing" }) }),
    now: 2,
  });
  assert.equal((existing as any).status, "already_committed");
  assert.equal((existing as any).sha, "sha-existing");
  assert.equal(ledger.has("run-1:task-t1:evidence-e1"), true);

  const uncertainLedger = createCommitLedger();
  const uncertain = planCommit({ mode: "allow", changeSet: changeSet(), ledger: uncertainLedger, now: 1 });
  let findCount = 0;
  const recovered = await applyCommit({
    decision: uncertain,
    ledger: uncertainLedger,
    git: gitPort({
      find: async () => {
        findCount += 1;
        return findCount === 1 ? null : { sha: "sha-landed" };
      },
      commit: async () => {
        throw new Error("timeout after the commit landed");
      },
    }),
    now: 2,
  });
  assert.equal((recovered as any).status, "already_committed");
  assert.equal((recovered as any).sha, "sha-landed");
  assert.equal(uncertainLedger.has("run-1:task-t1:evidence-e1"), true);
});

test("a real failure is reported as retry-safe with no ledger entry", async () => {
  const ledger = createCommitLedger();
  const decision = planCommit({ mode: "allow", changeSet: changeSet(), ledger, now: 1 });
  const failed = await applyCommit({
    decision,
    ledger,
    git: gitPort({
      commit: async () => {
        throw new Error("hook rejected the commit");
      },
    }),
    now: 2,
  });
  assert.equal(failed.ok, false);
  assert.equal((failed as any).code, "git");
  assert.equal((failed as any).retrySafe, true);
  assert.equal(ledger.has("run-1:task-t1:evidence-e1"), false);
});
