/**
 * End-to-end Orchestrator parent/child lifecycle.
 *
 * This is the regression test the 2026-11-24 session needed: dispatch must be a
 * short admission, a settle must record a readable report AND release the
 * child, the report must be steered (not left queued behind a polling parent),
 * and the next row must dispatch with no manual abort.
 *
 * Everything runs against the real extension factory with a fake in-process
 * child (no provider, no terminal). The child session is the same fake the
 * controller tests use, so a settle emits the real event order
 * (`workflow_todo` → `agent_end` → `agent_settled`).
 */

import assert from "node:assert/strict";
import test from "node:test";

import workflowExtension from "./index.ts";
import {
  fakeSdk,
  makeFakeCtx,
  makeFakeOrchestratorChildFactory,
  makeFakePi,
  submitThenFinish,
  tmpProject,
  type FakeOrchestratorChildOptions,
} from "./test-support.ts";

interface Boot {
  pi: ReturnType<typeof makeFakePi>;
  ctx: ReturnType<typeof makeFakeCtx>["ctx"];
  fake: ReturnType<typeof makeFakeOrchestratorChildFactory>;
  cwd: string;
  cleanup(): Promise<void>;
}

async function boot(options: FakeOrchestratorChildOptions = {}): Promise<Boot> {
  const { cwd, agentDir } = tmpProject();
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const pi = makeFakePi({ activeTools: ["read", "write", "edit", "bash"] });
  const fake = makeFakeOrchestratorChildFactory(options);
  const { sdk } = fakeSdk({ pass1: submitThenFinish("# Plan: lifecycle") });
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
  return {
    pi,
    ctx: made.ctx,
    fake,
    cwd,
    async cleanup() {
      try {
        await pi.emit("session_shutdown", { reason: "quit" }, made.ctx);
      } catch {
        /* shutdown is best-effort in the fake host */
      }
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
    },
  };
}

async function withBoot<T>(
  options: FakeOrchestratorChildOptions,
  fn: (boot: Boot) => Promise<T>,
): Promise<T> {
  const running = await boot(options);
  try {
    return await fn(running);
  } finally {
    await running.cleanup();
  }
}

interface ToolResult {
  text: string;
  details: Record<string, unknown>;
}

async function callTool(
  b: Boot,
  name: string,
  params: Record<string, unknown>,
): Promise<ToolResult> {
  const tool = b.pi.tools[name];
  assert.ok(tool, `${name} must be registered`);
  const result = (await tool.execute(
    `call-${name}`,
    params,
    undefined,
    undefined,
    b.ctx,
  )) as {
    content: Array<{ type: string; text?: string }>;
    details?: Record<string, unknown>;
  };
  return {
    text: result.content.map((block) => block.text ?? "").join("\n"),
    details: result.details ?? {},
  };
}

/** The durable run record as the session entry stores it. */
function lastRun(b: Boot): {
  phase: string;
  runId: string;
  currentRef?: string;
  rows: Array<{
    ref: string;
    instruction?: string;
    lastReport?: string;
    lastReportAt?: number;
  }>;
} {
  const entry = [...b.pi.entries]
    .reverse()
    .find((item) => item.type === "workflow");
  const run = (entry?.data as { orchestratorRun?: unknown } | undefined)
    ?.orchestratorRun;
  assert.ok(run, "a workflow entry must carry the run record");
  return run as never;
}

/** Let the settle microtask and the deferred child dispose run. */
async function settleTicks(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 20));
}

async function startTwoRows(b: Boot): Promise<void> {
  const started = await callTool(b, "orchestrator_start", {
    title: "Lifecycle",
    steps: ["Row one", "Row two"],
  });
  assert.match(started.text, /created with 2 row/);
}

test("dispatch is a short admission; settle reports, releases and unblocks row 2", async () => {
  await withBoot(
    {
      holdPrompt: true,
      todos: [{ text: "Write the change", status: "completed" }],
      summary: "The row is done. Not committed: the commit policy is 'never'.",
    },
    async (b) => {
      await startTwoRows(b);

      const dispatched = await callTool(b, "orchestrator_dispatch", {
        rowRef: "1",
        instructions: "Do row one.",
      });
      assert.match(dispatched.text, /Dispatched row 1\/2/);
      assert.equal(b.fake.created.length, 1, "one child was created");
      assert.equal(
        b.fake.created[0]?.promptCalls,
        1,
        "the child received the kickoff",
      );
      let run = lastRun(b);
      assert.equal(run.phase, "running");
      assert.equal(
        run.rows[0]?.lastReport,
        undefined,
        "the dispatch returned while the child is still running",
      );

      b.fake.created[0]?.settle("The row is done. Not committed: the commit policy is 'never'.");
      await settleTicks();

      run = lastRun(b);
      assert.equal(run.phase, "idle", "the settle released the run phase");
      assert.match(run.rows[0]?.lastReport ?? "", /^Status: settled/m);
      assert.match(run.rows[0]?.lastReport ?? "", /## Child summary\nThe row is done/);
      assert.equal(
        b.fake.created[0]?.disposeCalls,
        1,
        "the settled child session was disposed",
      );

      const report = b.pi.sent.find(
        (item) =>
          (item.content as { customType?: string } | undefined)?.customType ===
          "workflow-orchestrator-report",
      );
      assert.ok(report, "the settle woke the parent");
      assert.equal(
        (report?.options as { deliverAs?: string } | undefined)?.deliverAs,
        "steer",
        "the report is steered into the parent's next step, not queued as a follow-up",
      );

      const next = await callTool(b, "orchestrator_dispatch", {
        rowRef: "2",
        instructions: "Do row two.",
      });
      assert.match(
        next.text,
        /Dispatched row 2\/2/,
        "row 2 dispatches with no manual abort",
      );
      assert.equal(b.fake.created.length, 2);
    },
  );
});

test("a child that settles inside prompt() cannot lose its report to the dispatch record", async () => {
  await withBoot(
    { settleOnPrompt: true, summary: "synchronous settle" },
    async (b) => {
      await startTwoRows(b);
      const dispatched = await callTool(b, "orchestrator_dispatch", {
        rowRef: "1",
        instructions: "Do row one.",
      });
      await settleTicks();

      const run = lastRun(b);
      assert.equal(run.phase, "idle");
      assert.match(run.rows[0]?.lastReport ?? "", /synchronous settle/);
      assert.match(
        dispatched.text,
        /settled before its dispatch was recorded|Dispatched row 1\/2/,
        "the tool result is honest either way",
      );
    },
  );
});

test("a cancelled run row is terminal and completion is refused while the child is live", async () => {
  await withBoot({ holdPrompt: true }, async (b) => {
    await startTwoRows(b);
    await callTool(b, "orchestrator_dispatch", {
      rowRef: "1",
      instructions: "Do row one.",
    });

    const refused = await callTool(b, "workflow_todo", {
      action: "done",
      step: 1,
    });
    assert.match(refused.text, /still being executed/);
    assert.match(refused.text, /orchestrator_abort/);
    assert.equal(refused.details.error, "child-live");

    const cancelled = await callTool(b, "workflow_todo", {
      action: "cancel",
      step: 1,
    });
    assert.match(cancelled.text, /cancelled/);

    const aborted = await callTool(b, "orchestrator_abort", {
      reason: "row one was cancelled",
    });
    assert.match(aborted.text, /Aborted the Build child for row 1/);
    assert.equal(aborted.details.aborted, true);

    const next = await callTool(b, "orchestrator_dispatch", {
      instructions: "Do the next row.",
    });
    assert.match(
      next.text,
      /Dispatched row 2\/2/,
      "a cancelled row is not selected as the next pending row",
    );
  });
});

test("aborting a settled child preserves the report and reports nothing to abort", async () => {
  await withBoot({ holdPrompt: true, summary: "the real report" }, async (b) => {
    await startTwoRows(b);
    await callTool(b, "orchestrator_dispatch", {
      rowRef: "1",
      instructions: "Do row one.",
    });
    b.fake.created[0]?.settle("the real report");
    await settleTicks();

    const before = lastRun(b).rows[0]?.lastReport;
    assert.match(before ?? "", /the real report/);

    const aborted = await callTool(b, "orchestrator_abort", {
      reason: "already finished",
    });
    assert.match(aborted.text, /No live Build child/);
    assert.equal(aborted.details.aborted, false);

    const after = lastRun(b);
    assert.equal(after.phase, "idle");
    assert.equal(after.rows[0]?.lastReport, before, "the settle report survives");
  });
});

test("retry with amended instructions loops back to the same row and starts a fresh child", async () => {
  await withBoot(
    {
      holdPrompt: true,
      todos: [{ text: "Write the change", status: "in_progress" }],
      summary: "I ran out of time.",
    },
    async (b) => {
      await startTwoRows(b);
      await callTool(b, "orchestrator_dispatch", {
        rowRef: "1",
        instructions: "Original instruction.",
      });
      b.fake.created[0]?.settle("I ran out of time.");
      await settleTicks();

      const report = lastRun(b).rows[0]?.lastReport ?? "";
      assert.match(report, /^Suggested: Work remains in this row\./m);

      const retried = await callTool(b, "orchestrator_retry", {
        rowRef: "1",
        instructions:
          "The typecheck at src/a.ts still fails; fix it and rerun the check.",
      });
      assert.match(retried.text, /Dispatched row 1\/2/);
      const run = lastRun(b);
      assert.equal(run.rows[0]?.instruction, "The typecheck at src/a.ts still fails; fix it and rerun the check.");
      assert.equal(run.rows[0]?.lastReport, report, "the previous report is kept");
      assert.equal(b.fake.created.length, 2, "a fresh child started");
    },
  );
});

test("a policy refusal with no open work is classified as an external blocker", async () => {
  await withBoot(
    {
      holdPrompt: true,
      todos: [
        { text: "Write the change", status: "completed" },
        {
          text: "Commit (blocked: workflow.commitPolicy=never)",
          status: "cancelled",
        },
      ],
      summary: "Not committed: the commit policy is 'never'.",
    },
    async (b) => {
      await startTwoRows(b);
      await callTool(b, "orchestrator_dispatch", {
        rowRef: "1",
        instructions: "Do row one and commit it.",
      });
      b.fake.created[0]?.emit({
        type: "tool_execution_end",
        toolCallId: "bash-1",
        toolName: "bash",
        isError: true,
        result: {
          content: [
            {
              type: "text",
              text: "Commit policy is 'never' (workflow.commitPolicy): `git add` is blocked.",
            },
          ],
        },
      });
      b.fake.created[0]?.settle("Not committed: the commit policy is 'never'.");
      await settleTicks();

      const report = lastRun(b).rows[0]?.lastReport ?? "";
      assert.match(report, /^Status: settled$/m);
      assert.match(report, /^Cancelled: 2\. Commit/m);
      assert.match(report, /^Policy refusals: Commit policy is 'never'/m);
      assert.match(report, /^Suggested: External blocker \(policy\)/m);
      assert.doesNotMatch(report, /Work remains/);
    },
  );
});

test("status is self-sufficient after a settle: settled child, counters and next action", async () => {
  await withBoot(
    {
      holdPrompt: true,
      todos: [{ text: "Write the change", status: "completed" }],
      summary: "done",
    },
    async (b) => {
      await startTwoRows(b);
      await callTool(b, "orchestrator_dispatch", {
        rowRef: "1",
        instructions: "Do row one.",
      });
      b.fake.created[0]?.settle("done");
      await settleTicks();

      const status = await callTool(b, "orchestrator_status", {});
      assert.match(status.text, /Child: settled · row 1\/2/);
      assert.match(status.text, /todos 1\/1 · 0 cancelled · 0 open/);
      assert.match(status.text, /Next: Read row 1's report/);
      assert.match(status.text, /report: Status: settled/);
    },
  );
});
