/**
 * Orchestrator `orchestrator_start` seam.
 *
 * `orchestrator_start` reads the plan only to confirm it exists; it no longer
 * binds advisory notes to rows and does not warn about numbered-step counts.
 * The tests cover an appendix-bearing plan (rows still created, no note fields
 * on the run, no step-count warning) and the no-plan-path case.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import workflowExtension from "./index.ts";
import {
  fakeSdk,
  makeFakeCtx,
  makeFakeOrchestratorChildFactory,
  makeFakePi,
  submitThenFinish,
  tmpProject,
} from "./test-support.ts";

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

interface RunRecord {
  rows: Array<{ ref: string }>;
}

function lastRun(seam: Seam): RunRecord {
  const entry = [...seam.pi.entries]
    .reverse()
    .find((item) => item.type === "workflow");
  const run = (entry?.data as { orchestratorRun?: unknown } | undefined)
    ?.orchestratorRun;
  assert.ok(run, "a workflow entry must carry the run record");
  return run as RunRecord;
}

function numberingWarnings(
  seam: Seam,
): Array<{ message: string; level?: string }> {
  return seam.notifies.filter((note) => /numbered steps/i.test(note.message));
}

/** Review-related keys on the run record or on any row; must stay empty. */
function reviewKeys(run: RunRecord): string[] {
  const runKeys = Object.keys(run).filter((key) => /review/i.test(key));
  const rowKeys = run.rows.flatMap((row) =>
    Object.keys(row).filter((key) => /review/i.test(key)),
  );
  return [...runKeys, ...rowKeys];
}

test("start creates rows for an appendix-bearing plan and attaches no notes", async () => {
  await withSeam(async (seam) => {
    const planPath = path.join(seam.cwd, "plan.md");
    fs.writeFileSync(planPath, PLAN, "utf8");
    await callTool(seam, "orchestrator_start", {
      planPath,
      steps: ["First", "Second", "Third"],
    });

    const run = lastRun(seam);
    assert.equal(run.rows.length, 3);
    assert.deepEqual(reviewKeys(run), [], "the run carries no review notes");
    assert.deepEqual(numberingWarnings(seam), []);
  });
});

test("start without a plan path creates rows with no notes", async () => {
  await withSeam(async (seam) => {
    await callTool(seam, "orchestrator_start", {
      steps: ["First", "Second", "Third"],
    });

    const run = lastRun(seam);
    assert.equal(run.rows.length, 3);
    assert.deepEqual(reviewKeys(run), []);
    assert.deepEqual(numberingWarnings(seam), []);
  });
});
