/**
 * Advisory review notes on Orchestrator rows (2026-11-25 authoritative-review
 * plan, row 3).
 *
 * Notes are advisory: they bind by 1-based index only when the plan's numbered
 * step count equals the model-supplied row count. A merged or otherwise
 * mismatched row list leaves every note run-level (`unboundReviewNotes`), and a
 * non-numeric/out-of-range step is never guessed onto a row. The last two tests
 * cover the `startOrchestratorRun` seam, including the no-plan-path case.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  bindReviewNotes,
  createOrchestratorRun,
  recordDispatch,
  recordDispatchIfNotReported,
  restoreOrchestratorRun,
  type OrchestratorUnboundReviewNote,
} from "./orchestrator-run.ts";
import workflowExtension from "./index.ts";
import {
  fakeSdk,
  makeFakeCtx,
  makeFakeOrchestratorChildFactory,
  makeFakePi,
  submitThenFinish,
  tmpProject,
} from "./test-support.ts";

const NOTES: OrchestratorUnboundReviewNote[] = [
  { id: "R1", step: "1", change: "First change." },
  { id: "R2", step: "2", change: "Second change." },
  { id: "R3", step: "3", change: "Third change." },
];

const PLAN = [
  "# Plan: Notes",
  "",
  "## Steps",
  "",
  "1. First",
  "2. Second",
  "3. Third",
  "",
  "## Reviewer Revisions (round 2)",
  "",
  "### Required changes",
  "",
  "- **R1 · Step 1:** First change.",
  "- **R2 · Step 2:** Second change.",
  "- **R3 · Step 3:** Third change.",
].join("\n");

test("notes bind to the row whose 1-based index matches their step", () => {
  const result = bindReviewNotes(NOTES, 3, ["one", "two", "three"]);

  assert.equal(result.aligned, true);
  assert.equal(result.planStepCount, 3);
  assert.equal(result.rowCount, 3);
  assert.deepEqual(result.unboundReviewNotes, []);
  assert.deepEqual(
    result.rows.map((row) => [row.ref, row.reviewNotes]),
    [
      ["1", [{ id: "R1", change: "First change." }]],
      ["2", [{ id: "R2", change: "Second change." }]],
      ["3", [{ id: "R3", change: "Third change." }]],
    ],
  );
});

test("a merged row list leaves every note unbound and reports both counts", () => {
  const result = bindReviewNotes(NOTES, 3, ["merged one and two", "three"]);

  assert.equal(result.aligned, false);
  assert.equal(result.planStepCount, 3);
  assert.equal(result.rowCount, 2);
  assert.deepEqual(result.unboundReviewNotes, NOTES);
  assert.equal(
    result.rows.every((row) => row.reviewNotes === undefined),
    true,
    "nothing is guessed onto the two rows",
  );
});

test("a reordered row list with equal counts still binds positionally", () => {
  // Documented positional limit: a row carries no plan-step identity, so equal
  // counts are the only check. R1 lands on ref 1 even though that row is text
  // for plan step 3.
  const result = bindReviewNotes(NOTES, 3, ["three", "one", "two"]);

  assert.equal(result.aligned, true);
  assert.deepEqual(
    result.rows.map((row) => row.reviewNotes?.map((note) => note.id)),
    [["R1"], ["R2"], ["R3"]],
    "binding is by 1-based index, not by matching row text",
  );
});

test("a non-numeric or out-of-range step stays unbound while valid notes bind", () => {
  const notes: OrchestratorUnboundReviewNote[] = [
    { id: "R1", step: "1", change: "Valid one." },
    { id: "R2", step: "two", change: "Non-numeric." },
    { id: "R3", step: "9", change: "Out of range." },
    { id: "R4", step: "2", change: "Valid two." },
  ];
  const result = bindReviewNotes(notes, 3, ["one", "two", "three"]);

  assert.equal(result.aligned, true);
  assert.deepEqual(result.unboundReviewNotes, [
    { id: "R2", step: "two", change: "Non-numeric." },
    { id: "R3", step: "9", change: "Out of range." },
  ]);
  assert.deepEqual(
    result.rows.map((row) => row.reviewNotes?.map((note) => note.id)),
    [['R1'], ['R4'], undefined],
  );
});

test("no notes means no bindings", () => {
  const result = bindReviewNotes([], 3, ["one", "two", "three"]);

  assert.equal(result.aligned, true);
  assert.deepEqual(result.unboundReviewNotes, []);
  assert.equal(
    result.rows.every((row) => row.reviewNotes === undefined),
    true,
  );
});

test("create, dispatch and restore preserve row and run-level notes", () => {
  const created = createOrchestratorRun({
    title: "notes",
    steps: ["one", "two"],
    unboundReviewNotes: [
      { id: "R9", step: "notes", change: "Parent must place this." },
    ],
    now: 1,
  });
  const withNotes = {
    ...created,
    rows: created.rows.map((row) =>
      row.ref === "1"
        ? { ...row, reviewNotes: [{ id: "R1", change: "Bound change." }] }
        : row,
    ),
  };

  const dispatched = recordDispatch(withNotes, {
    rowRef: "1",
    instruction: "Do it.",
  });
  assert.deepEqual(dispatched.rows[0]?.reviewNotes, [
    { id: "R1", change: "Bound change." },
  ]);
  assert.deepEqual(dispatched.unboundReviewNotes, [
    { id: "R9", step: "notes", change: "Parent must place this." },
  ]);

  const admitted = recordDispatchIfNotReported(withNotes, {
    rowRef: "1",
    instruction: "Admitted later.",
    startedAt: 0,
  });
  assert.equal(admitted.recorded, true);
  assert.deepEqual(admitted.run.rows[0]?.reviewNotes, [
    { id: "R1", change: "Bound change." },
  ]);
  assert.deepEqual(admitted.run.unboundReviewNotes, [
    { id: "R9", step: "notes", change: "Parent must place this." },
  ]);

  const restored = restoreOrchestratorRun(
    JSON.parse(JSON.stringify(dispatched)),
  );
  assert.deepEqual(restored, dispatched);
  assert.deepEqual(restored?.rows[0]?.reviewNotes, [
    { id: "R1", change: "Bound change." },
  ]);
  assert.deepEqual(restored?.unboundReviewNotes, [
    { id: "R9", step: "notes", change: "Parent must place this." },
  ]);
});

// ── startOrchestratorRun seam ───────────────────────────────────────────

interface Seam {
  pi: ReturnType<typeof makeFakePi>;
  ctx: ReturnType<typeof makeFakeCtx>["ctx"];
  notifies: ReturnType<typeof makeFakeCtx>["notifies"];
  cwd: string;
}

async function withSeam<T>(fn: (seam: Seam) => Promise<T>): Promise<T> {
  const { cwd, agentDir } = tmpProject();
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const pi = makeFakePi({ activeTools: ["read", "write", "edit", "bash"] });
  const fake = makeFakeOrchestratorChildFactory();
  const { sdk } = fakeSdk({ pass1: submitThenFinish("# Plan: seam") });
  await workflowExtension(pi as never, {
    loadSdk: async () => sdk as never,
    createOrchestratorChild: fake.factory as never,
    plannotatorRequestTimeoutMs: 20,
    plannotatorRecoveryTimeoutMs: 20,
    isTerminalHost: () => true,
  });
  const made = makeFakeCtx({ cwd, hasUI: false, branch: [] });
  await pi.emit("session_start", { reason: "startup" }, made.ctx);
  await (pi.commands.orchestrator.handler("", made.ctx) as Promise<void>);
  try {
    return await fn({
      pi,
      ctx: made.ctx,
      notifies: made.notifies,
      cwd,
    });
  } finally {
    try {
      await pi.emit("session_shutdown", { reason: "quit" }, made.ctx);
    } catch {
      /* shutdown is best-effort in the fake host */
    }
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  }
}

async function callTool(
  seam: Seam,
  name: string,
  params: Record<string, unknown>,
): Promise<void> {
  const tool = seam.pi.tools[name];
  assert.ok(tool, `${name} must be registered`);
  const result = (await tool.execute(
    `call-${name}`,
    params,
    undefined,
    undefined,
    seam.ctx,
  )) as { content: Array<{ type: string; text?: string }> };
  const text = result.content.map((block) => block.text ?? "").join("\n");
  assert.match(text, /created with 3 row/);
}

function lastRun(seam: Seam): {
  rows: Array<{
    ref: string;
    reviewNotes?: Array<{ id: string; change: string }>;
  }>;
  unboundReviewNotes?: Array<{ id: string; step?: string; change: string }>;
} {
  const entry = [...seam.pi.entries]
    .reverse()
    .find((item) => item.type === "workflow");
  const run = (entry?.data as { orchestratorRun?: unknown } | undefined)
    ?.orchestratorRun;
  assert.ok(run, "a workflow entry must carry the run record");
  return run as never;
}

test("start reads the plan and attaches notes to the created rows", async () => {
  await withSeam(async (seam) => {
    const planPath = path.join(seam.cwd, "plan.md");
    fs.writeFileSync(planPath, PLAN, "utf8");
    await callTool(seam, "orchestrator_start", {
      planPath,
      steps: ["First", "Second", "Third"],
    });

    const run = lastRun(seam);
    assert.deepEqual(
      run.rows.map((row) => [row.ref, row.reviewNotes]),
      [
        ["1", [{ id: "R1", change: "First change." }]],
        ["2", [{ id: "R2", change: "Second change." }]],
        ["3", [{ id: "R3", change: "Third change." }]],
      ],
    );
    assert.equal(run.unboundReviewNotes, undefined);
  });
});

test("start without a plan path attaches no notes", async () => {
  await withSeam(async (seam) => {
    await callTool(seam, "orchestrator_start", {
      steps: ["First", "Second", "Third"],
    });

    const run = lastRun(seam);
    assert.equal(
      run.rows.every((row) => row.reviewNotes === undefined),
      true,
    );
    assert.equal(run.unboundReviewNotes, undefined);
  });
});
