import assert from "node:assert/strict";
import test from "node:test";

import {
  ORCHESTRATOR_CHILD_VERSION,
  buildOrchestratorChildKickoff,
  buildOrchestratorChildSystemPrompt,
  parseOrchestratorChildContext,
  type OrchestratorChildContext,
} from "./orchestrator-child-contract.ts";

const context: OrchestratorChildContext = {
  version: ORCHESTRATOR_CHILD_VERSION,
  runId: "run-1",
  taskId: "task-1",
  attemptId: "attempt-1",
  ref: "1",
  total: 2,
  parentSessionRef: "parent",
  mode: "build",
  mayOrchestrate: false,
  workspace: {
    id: "D",
    root: "C:/work/D",
    primary: false,
  },
  createdAt: 1,
};

test("child context accepts an optional workspace and rejects a malformed one", () => {
  const parsed = parseOrchestratorChildContext(context);
  assert.equal(parsed.ok, true, parsed.ok ? "" : parsed.reason);
  if (!parsed.ok) return;
  assert.equal(parsed.context.workspace?.id, "D");
  assert.equal(parsed.context.workspace?.root, "C:/work/D");
  const invalid = parseOrchestratorChildContext({ ...context, workspace: { id: "D" } });
  assert.equal(invalid.ok, false);
});

test("child context fails closed on an older prompt-contract version", () => {
  const parsed = parseOrchestratorChildContext({ ...context, version: 1 });
  assert.equal(parsed.ok, false);
  if (parsed.ok) return;
  assert.match(parsed.reason, /unsupported orchestrator-child version 1/);
});

test("child system prompt names only its own root", () => {
  const prompt = buildOrchestratorChildSystemPrompt(context);
  assert.match(prompt, /C:\/work\/D/);
  assert.match(prompt, /Other roots belong to other rows/);
  assert.doesNotMatch(prompt, /C:\/work\/W/, "a later row's root is not advertised");
  assert.doesNotMatch(prompt, /frozen row/i);
  assert.doesNotMatch(prompt, /parent verifies and accepts/i);
});

test("kickoff carries the row root and the parent instruction, with no acceptance sections", () => {
  const kickoff = buildOrchestratorChildKickoff({
    context,
    row: {
      ref: "1",
      text: "Implement D",
      instruction: "Touch only src/d.ts.",
      workspace: { id: "D", root: "C:/work/D" },
    },
  });
  assert.match(kickoff, /## Workspace/);
  assert.match(kickoff, /Root: C:\/work\/D/);
  assert.match(kickoff, /## Parent instructions\nTouch only src\/d\.ts\./);
  assert.match(kickoff, /parent trusts your report/i);
  assert.doesNotMatch(kickoff, /Acceptance checks/);
  assert.doesNotMatch(kickoff, /Expected files/);
  assert.doesNotMatch(kickoff, /Run roots:/);
});

test("a repair round names the concrete blocker without claiming acceptance", () => {
  const kickoff = buildOrchestratorChildKickoff({
    context,
    row: { ref: "1", text: "Implement D" },
    repair: "typecheck failed at src/d.ts:12",
  });
  assert.match(kickoff, /## Repair round/);
  assert.match(kickoff, /typecheck failed at src\/d\.ts:12/);
  assert.doesNotMatch(kickoff, /acceptance/i);
});

test("the contract tells the child how to record a policy-blocked step", () => {
  const system = buildOrchestratorChildSystemPrompt(context);
  assert.match(system, /workflow\.commitPolicy: never/);
  assert.match(system, /never mark it completed/);
  assert.match(system, /`cancelled`/);
  assert.match(system, /## Not done/);

  const kickoff = buildOrchestratorChildKickoff({
    context,
    row: { ref: "1", text: "Implement D" },
  });
  assert.match(
    kickoff,
    /every step you did NOT complete with the reason \(policy or otherwise\)/,
  );
  assert.match(kickoff, /mark it `cancelled` with the policy named/);
  assert.match(kickoff, /## Not done/);
  assert.doesNotMatch(kickoff, /acceptance/i);
});

function reviewBlock(kickoff: string): string {
  const marker = "## Review notes (advisory)";
  const start = kickoff.indexOf(marker);
  assert.ok(start >= 0, "review notes block present");
  const nextHeading = kickoff.indexOf("\n## ", start + marker.length);
  const block = nextHeading === -1 ? kickoff.slice(start) : kickoff.slice(start, nextHeading);
  return block.replace(/\n+$/, "");
}

test("a row without review notes renders no advisory block", () => {
  const kickoff = buildOrchestratorChildKickoff({
    context,
    row: { ref: "1", text: "Implement D" },
  });
  assert.doesNotMatch(kickoff, /## Review notes \(advisory\)/);
});

test("one review note renders after the row and before the parent instruction", () => {
  const kickoff = buildOrchestratorChildKickoff({
    context,
    row: {
      ref: "1",
      text: "Implement D",
      instruction: "Touch only src/d.ts.",
      reviewNotes: [{ id: "R2", change: "Bound the change." }],
    },
  });
  assert.equal(
    reviewBlock(kickoff),
    [
      "## Review notes (advisory)",
      "The approved plan is authoritative. Apply a note when it is consistent with the row. If a note conflicts with the plan or the row, follow the plan and record the conflict.",
      "- R2: Bound the change.",
    ].join("\n"),
  );
  assert.ok(kickoff.indexOf("## Your row") < kickoff.indexOf("## Review notes (advisory)"));
  assert.ok(
    kickoff.indexOf("## Review notes (advisory)") <
      kickoff.indexOf("## Parent instructions"),
  );
  assert.doesNotMatch(kickoff, /acceptance criteria|required change|must apply/i);
});

test("eight notes keep the first five whole and shorten the rest to 120 chars", () => {
  const notes = Array.from({ length: 8 }, (_, index) => ({
    id: `R${index + 1}`,
    change: index < 5 ? `Short note ${index + 1}.` : "x".repeat(500),
  }));
  const kickoff = buildOrchestratorChildKickoff({
    context,
    row: { ref: "1", text: "Implement D", reviewNotes: notes },
  });
  const block = reviewBlock(kickoff);
  for (let index = 1; index <= 5; index += 1) {
    assert.match(block, new RegExp(`^- R${index}: Short note ${index}\\.$`, "m"));
  }
  for (let index = 6; index <= 8; index += 1) {
    assert.match(block, new RegExp(`^- R${index}: ${'x'.repeat(120)}$`, "m"));
  }
  assert.ok(block.length <= 2_000, `review block is ${block.length} chars`);
  assert.doesNotMatch(block, /… and \d+ more/);
  for (let index = 1; index <= 8; index += 1) {
    assert.match(block, new RegExp(`\\bR${index}\\b`));
  }
});

test("eight long notes cap the first five at 400 chars and keep every remaining id", () => {
  const notes = Array.from({ length: 8 }, (_, index) => ({
    id: `R${index + 1}`,
    change: "z".repeat(1_000),
  }));
  const kickoff = buildOrchestratorChildKickoff({
    context,
    row: { ref: "1", text: "Implement D", reviewNotes: notes },
  });
  const block = reviewBlock(kickoff);
  for (let index = 1; index <= 5; index += 1) {
    assert.match(block, new RegExp(`^- R${index}: ${'z'.repeat(400)}$`, "m"));
  }
  assert.match(block, /^… and 3 more: R6, R7, R8$/m);
  for (let index = 1; index <= 8; index += 1) {
    assert.match(block, new RegExp(`\\bR${index}\\b`));
  }
});

test("a 2,000-character note change is capped at 400 chars", () => {
  const kickoff = buildOrchestratorChildKickoff({
    context,
    row: {
      ref: "1",
      text: "Implement D",
      reviewNotes: [{ id: "R7", change: "q".repeat(2_000) }],
    },
  });
  const block = reviewBlock(kickoff);
  assert.match(block, new RegExp(`^- R7: ${'q'.repeat(400)}$`, "m"));
  assert.doesNotMatch(block, new RegExp(`q{401}`));
});

test("the review block keeps every id and the whole kickoff stays under 12,000 chars", () => {
  const notes = Array.from({ length: 605 }, (_, index) => ({
    id: `R${index + 1}`,
    change: index < 5 ? "w".repeat(500) : "v".repeat(300),
  }));
  const kickoff = buildOrchestratorChildKickoff({
    context,
    row: { ref: "1", text: "Implement D", reviewNotes: notes },
  });
  assert.ok(kickoff.length <= 12_000, `kickoff is ${kickoff.length} chars`);
  const block = reviewBlock(kickoff);
  assert.match(block, /^… and 600 more: R6, R7, R8, /m);
  for (let index = 1; index <= 605; index += 1) {
    assert.match(block, new RegExp(`\\bR${index}\\b`), `note R${index} is visible`);
  }

  const huge = buildOrchestratorChildKickoff({
    context,
    row: {
      ref: "1",
      text: "Implement D",
      reviewNotes: [{ id: "R9", change: "p".repeat(50_000) }],
    },
  });
  assert.ok(huge.length <= 12_000, `kickoff is ${huge.length} chars`);
  assert.match(reviewBlock(huge), /^- R9: p{400}$/m);
});

test("the notes block keeps shortened bullets while the 2,000-char budget allows", () => {
  const notes = [
    ...Array.from({ length: 5 }, (_, index) => ({
      id: `R${index + 1}`,
      change: "a".repeat(100),
    })),
    ...Array.from({ length: 20 }, (_, index) => ({
      id: `R${index + 6}`,
      change: "b".repeat(500),
    })),
  ];
  const kickoff = buildOrchestratorChildKickoff({
    context,
    row: { ref: "1", text: "Implement D", reviewNotes: notes },
  });
  const block = reviewBlock(kickoff);
  assert.ok(block.length <= 2_000, `review block is ${block.length} chars`);
  assert.match(block, /^… and \d+ more: R\d+(, R\d+)*$/m);
  for (let index = 1; index <= 25; index += 1) {
    assert.match(block, new RegExp(`\\bR${index}\\b`), `note R${index} is visible`);
  }
});

test("the acknowledgement duty covers every note id, including shortened text", () => {
  const kickoff = buildOrchestratorChildKickoff({
    context,
    row: { ref: "1", text: "Implement D" },
  });
  assert.match(
    kickoff,
    /End the summary with a `## Review notes` section listing every note id as `applied`, `not applicable — <why>`, or `conflicts with the plan — followed the plan`\./,
  );
  assert.match(kickoff, /A note whose text was shortened is still acknowledged by id\./);
});

test("the system prompt calls review notes advisory and keeps the plan authoritative", () => {
  const system = buildOrchestratorChildSystemPrompt(context);
  assert.match(
    system,
    /Review notes are advisory: the approved plan is authoritative and wins on conflict\./,
  );
  assert.match(system, /Your list is local to this row\./);
});
