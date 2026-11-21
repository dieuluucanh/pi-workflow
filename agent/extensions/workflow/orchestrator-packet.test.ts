/**
 * Assignment packet tests (step 19): a fresh child gets the task and roadmap
 * context without parent history, large snapshots stay reachable by page, and
 * an un-fittable mandatory assignment is refused instead of overflowing.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { createAssignmentPacket, roadmapPage } from "./orchestrator-packet.ts";
import { resolveBudget } from "./orchestrator-budget.ts";
import type { RoadmapSnapshot } from "./orchestrator-plan.ts";
import type { PlannedTask } from "./orchestrator-types.ts";

const budget = (() => {
  const result = resolveBudget({
    role: "builder",
    model: { provider: "p", id: "m", contextWindow: 131_072, maxOutputTokens: null },
  });
  assert.equal(result.ok, true);
  return (result as { ok: true; plan: any }).plan;
})();

function snapshot(count: number): RoadmapSnapshot {
  return {
    schemaVersion: 1,
    sourcePath: "C:/docs/roadmap.md",
    digest: "a".repeat(64),
    title: "Big roadmap",
    requirements: Array.from({ length: count }, (_, index) => ({
      roadmapStepId: `rm-${index + 1}`,
      label: String(index + 1),
      text: `Requirement ${index + 1} with enough text to be meaningful`,
      phasePath: [index < count / 2 ? "Phase A" : "Phase B"],
      claimedComplete: false,
      completionVerified: false as const,
      sourceLines: { start: index + 1, end: index + 1 },
    })),
    phases: [],
    lineCount: count,
    createdAt: 1,
  };
}

function task(covers: string[]): PlannedTask {
  return {
    taskId: "task-1",
    covers,
    objective: "Implement the first requirement in the approved roadmap",
    nonGoals: ["do not touch unrelated modules"],
    dependsOn: [],
    expectedFiles: ["src/first.ts"],
    acceptanceChecks: ["unit tests pass", "no new warnings"],
    sizeRationale: "one module and one test file",
  };
}

function build(over: Partial<Parameters<typeof createAssignmentPacket>[0]> = {}) {
  return createAssignmentPacket({
    runId: "run-1",
    taskId: "task-1",
    attemptId: "attempt-1",
    roadmapRevision: 1,
    task: task(["rm-1", "rm-2"]),
    snapshot: snapshot(20),
    dependencies: [
      { taskId: "task-0", objective: "Earlier accepted work", evidenceId: "evidence-1", checks: ["passed"] },
    ],
    projectInstructions: ["AGENTS.md"],
    baselineCautions: ["workspace has unstaged user edits"],
    environment: {
      cwd: "C:/work/app",
      model: { provider: "p", id: "builder", thinking: "medium" },
      tools: ["read", "edit", "bash"],
    },
    reporting: {
      toolNames: ["workflow_worker_report"],
      fields: ["criteria", "files", "checks"],
    },
    budget,
    now: 10,
    ...over,
  });
}

test("a fresh child gets task, roadmap and protocol without parent history", () => {
  const result = build();
  assert.equal(result.ok, true, result.ok ? "" : result.error);
  const packet = (result as { ok: true; packet: any }).packet;
  assert.match(packet.inlineText, /objective: Implement the first requirement/);
  assert.match(packet.inlineText, /acceptance checks: unit tests pass/);
  assert.match(packet.inlineText, /Roadmap overview/);
  assert.match(packet.inlineText, /task-0/);
  assert.match(packet.inlineText, /workflow_worker_report/);
  assert.match(packet.inlineText, /workspace has unstaged user edits/);
  assert.doesNotMatch(packet.inlineText, /parent transcript|conversation history/i);
  assert.equal("messages" in packet, false);
  assert.equal("transcript" in packet, false);
  assert.ok(packet.estimatedTokens <= packet.budget.maxInlineTokens);
});

test("a large roadmap stays reachable by pagination without a full inline dump", () => {
  const result = build({ snapshot: snapshot(1_000) });
  assert.equal(result.ok, true);
  const packet = (result as { ok: true; packet: any }).packet;
  assert.equal(packet.snapshot.totalRequirements, 1_000);
  assert.equal(packet.snapshot.pageCount, 20);
  assert.equal(packet.snapshot.pageSize, 50);
  assert.ok(packet.estimatedTokens < 5_000, "inline stays bounded");
  assert.doesNotMatch(packet.inlineText, /Requirement 1000 with enough text/);

  const ids = new Set<string>();
  for (let page = 0; page < packet.snapshot.pageCount; page += 1) {
    const sliced = roadmapPage(snapshot(1_000), { page, pageSize: 50 });
    assert.equal(sliced.ok, true);
    for (const requirement of (sliced as { ok: true; page: any }).page.requirements) {
      ids.add(requirement.roadmapStepId);
    }
  }
  assert.equal(ids.size, 1_000);
  assert.equal(roadmapPage(snapshot(1_000), { page: 20, pageSize: 50 }).ok, false);
  assert.equal(roadmapPage(snapshot(1_000), { page: -1, pageSize: 50 }).ok, false);
});

test("an assignment whose mandatory part cannot fit is refused, not truncated", () => {
  const result = build({ maxInlineTokens: 20 });
  assert.equal(result.ok, false);
  assert.equal((result as { code: string }).code, "too_large");
  assert.match((result as { error: string }).error, /mandatory assignment/);
  assert.equal((result as { packet?: unknown }).packet, undefined);
});

test("the packet is deeply immutable and deterministic", () => {
  const first = build();
  const second = build();
  assert.equal(first.ok && second.ok, true);
  const packet = (first as { ok: true; packet: any }).packet;
  const again = (second as { ok: true; packet: any }).packet;
  assert.equal(packet.inlineText, again.inlineText);
  assert.equal(Object.isFrozen(packet), true);
  assert.equal(Object.isFrozen(packet.sections), true);
  assert.throws(() => {
    packet.omitted.push("mutated");
  });
  assert.throws(() => {
    packet.sections[0].text = "mutated";
  });
});

test("no raw parent history or environment dump can enter the packet", () => {
  const result = build();
  const packet = (result as { ok: true; packet: any }).packet;
  assert.equal("env" in packet, false);
  assert.doesNotMatch(packet.inlineText, /API_KEY|AUTH_TOKEN|SECRET/);
  // The typed environment section names only capacity/identity fields.
  assert.match(packet.inlineText, /cwd: C:\/work\/app/);
});
