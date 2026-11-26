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
import { writeFileSync } from "node:fs";
import path from "node:path";
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
  /** Every `ctx.ui.notify` the extension published, in order. */
  notifies: ReturnType<typeof makeFakeCtx>["notifies"];
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
    notifies: made.notifies,
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
  title?: string;
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

/** The persisted TODO list as the workflow entry stores it. */
function lastTodos(b: Boot): Array<{
  step?: number;
  text?: string;
  status?: string;
  completed?: boolean;
}> {
  const entry = [...b.pi.entries]
    .reverse()
    .find((item) => item.type === "workflow");
  const todos = (entry?.data as { todos?: unknown } | undefined)?.todos;
  assert.ok(Array.isArray(todos), "a workflow entry must carry the todo list");
  return todos as never;
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

// ── Auto-completion when every row is settled ─────────────────────

/**
 * Step 4 of the release fix: a run must end on its own once no row is left to
 * dispatch. These pin the transition and, more importantly, the precedence
 * rule — a live child, a failure and an abort all keep the run open/not
 * completed.
 */
test("a run auto-completes when every row is settled and no child is live", async () => {
  await withBoot({ holdPrompt: true }, async (b) => {
    await startTwoRows(b);

    const done = await callTool(b, "workflow_todo", {
      action: "done",
      step: 1,
    });
    assert.doesNotMatch(done.text, /still being executed/);
    assert.equal(
      lastRun(b).phase,
      "idle",
      "one pending row keeps the run open",
    );

    const cancelled = await callTool(b, "workflow_todo", {
      action: "cancel",
      step: 2,
    });
    assert.match(cancelled.text, /cancel/);
    assert.equal(
      lastRun(b).phase,
      "completed",
      "the last settled row completes the run without a child",
    );
    assert.equal(
      lastRun(b).rows.length,
      2,
      "completion keeps the run record's rows",
    );

    // Status must describe the sealed run, not advertise another dispatch.
    const status = await callTool(b, "orchestrator_status", {});
    assert.match(status.text, /No further dispatch for this completed run/);
    assert.match(status.text, /orchestrator_start/);
    assert.match(status.text, /replaces this run/);
    assert.doesNotMatch(status.text, /Next: Dispatch row/);
  });
});

/**
 * Step 12 of the release fix: completion must not discard the settle report.
 * The last settled row closes the run, and the replaced-by-start path later
 * still reads the report off the sealed record.
 */
test("auto-completion keeps the settled report on the completed run", async () => {
  await withBoot(
    {
      holdPrompt: true,
      todos: [{ text: "Write the change", status: "completed" }],
      summary: "Row one landed.",
    },
    async (b) => {
      await startTwoRows(b);
      await callTool(b, "orchestrator_dispatch", {
        rowRef: "1",
        instructions: "Do row one.",
      });
      b.fake.created[0]?.settle("Row one landed.");
      await settleTicks();

      assert.equal(lastRun(b).phase, "idle", "a pending row keeps the run open");
      const report = lastRun(b).rows[0]?.lastReport ?? "";
      assert.match(report, /## Child summary\nRow one landed\./);

      await callTool(b, "workflow_todo", { action: "done", step: 1 });
      assert.equal(lastRun(b).phase, "idle", "row two is still pending");
      await callTool(b, "workflow_todo", { action: "cancel", step: 2 });

      const completed = lastRun(b);
      assert.equal(completed.phase, "completed");
      assert.equal(
        completed.rows[0]?.lastReport,
        report,
        "completion preserves the settle report verbatim",
      );
      assert.equal(
        typeof completed.rows[0]?.lastReportAt,
        "number",
        "the report timestamp survives completion",
      );

      const status = await callTool(b, "orchestrator_status", {});
      assert.match(status.text, /No further dispatch for this completed run/);
      assert.match(status.text, /report: Status: settled/);
    },
  );
});

test("a fully settled run whose child is aborted ends paused, never completed", async () => {
  await withBoot({ holdPrompt: true }, async (b) => {
    await startTwoRows(b);
    await callTool(b, "orchestrator_dispatch", {
      rowRef: "1",
      instructions: "Do row one.",
    });

    // Settle every row while the child still owns the session.
    await callTool(b, "workflow_todo", { action: "cancel", step: 1 });
    await callTool(b, "workflow_todo", { action: "cancel", step: 2 });
    assert.equal(
      lastRun(b).phase,
      "running",
      "never complete a run while a child is live",
    );

    const aborted = await callTool(b, "orchestrator_abort", {
      reason: "the rows were abandoned",
    });
    assert.match(aborted.text, /Aborted the Build child for row 1/);
    await settleTicks();

    assert.equal(
      lastRun(b).phase,
      "paused",
      "the recorded abort wins over auto-completion",
    );
  });
});

test("a child failure after every row settled leaves the run interrupted", async () => {
  await withBoot({ holdPrompt: true }, async (b) => {
    await startTwoRows(b);
    await callTool(b, "orchestrator_dispatch", {
      rowRef: "1",
      instructions: "Do row one.",
    });
    await callTool(b, "workflow_todo", { action: "cancel", step: 1 });
    await callTool(b, "workflow_todo", { action: "cancel", step: 2 });

    const child = b.fake.created[0];
    assert.ok(child);
    // Exceeding the controller's tool-call budget is a failure, not a settle,
    // so it must reach `interrupted` and never `completed`.
    for (let i = 0; i <= 300; i += 1) {
      child.emit({
        type: "tool_execution_start",
        toolCallId: `budget-${i}`,
        toolName: "read",
        args: { path: "README.md" },
      });
    }
    await settleTicks();

    assert.equal(
      lastRun(b).phase,
      "interrupted",
      "the recorded failure wins over auto-completion",
    );
  });
});

// ── Input routing across the run lifecycle ─────────────────────────

/**
 * The 2026-11-26 regression: after a run finishes, every prompt was refused
 * because the input hook derived ownership from record existence (`hasRun`)
 * instead of the run phase. A dormant run must release the session in every
 * mode, while a running child keeps steering prose.
 */
test("a completed run releases the prompt in Orchestrator and Plan mode", async () => {
  await withBoot(
    {
      holdPrompt: true,
      todos: [{ text: "Write the change", status: "completed" }],
      summary: "Row one is done.",
    },
    async (b) => {
      const started = await callTool(b, "orchestrator_start", {
        title: "Input routing",
        steps: ["Row one"],
      });
      assert.match(started.text, /created with 1 row/);
      await callTool(b, "orchestrator_dispatch", {
        rowRef: "1",
        instructions: "Do row one.",
      });
      b.fake.created[0]?.settle("Row one is done.");
      await settleTicks();

      // The single row is still open, so the run is dormant but not terminal.
      assert.equal(lastRun(b).phase, "idle");
      await callTool(b, "workflow_todo", { action: "done", step: 1 });
      assert.equal(
        lastRun(b).phase,
        "completed",
        "settling the last row auto-completes the one-row run",
      );
      const reportBefore = lastRun(b).rows[0]?.lastReport;
      assert.match(reportBefore ?? "", /Row one is done\./);

      const child = b.fake.created[0];
      assert.ok(child);
      assert.equal(child.disposeCalls, 1, "the completed run has no live child");
      const childrenBefore = b.fake.created.length;
      const warningsBefore = b.notifies.filter(
        (item) => item.level === "warning",
      ).length;

      const idle = await b.pi.emit(
        "input",
        { text: "What changed in this run?", source: "interactive" },
        b.ctx,
      );
      assert.deepEqual(idle, [{ action: "continue" }]);
      assert.equal(
        b.notifies.filter((item) => item.level === "warning").length,
        warningsBefore,
        "a completed run shows no ownership refusal",
      );

      await b.pi.commands.plan.handler("", b.ctx);
      const plan = await b.pi.emit(
        "input",
        { text: "What changed in this run?", source: "interactive" },
        b.ctx,
      );
      assert.deepEqual(plan, [{ action: "continue" }]);
      assert.equal(
        b.notifies.filter((item) => item.level === "warning").length,
        warningsBefore,
        "Plan mode admits the prompt for a completed run too",
      );

      // The prompt reached the parent: no child was started or prompted, and
      // the sealed record is untouched.
      assert.equal(b.fake.created.length, childrenBefore);
      assert.equal(
        child.promptCalls,
        1,
        "the prompt was never delivered to a child",
      );
      assert.equal(lastRun(b).phase, "completed");
      assert.equal(lastRun(b).rows[0]?.lastReport, reportBefore);
    },
  );
});

test("a running child still receives prose as a steer", async () => {
  // No `holdPrompt`: the fake kickoff resolves, which leaves the controller
  // phase `running` without settling, exactly the state a steer targets.
  await withBoot({}, async (b) => {
    await startTwoRows(b);
    await callTool(b, "orchestrator_dispatch", {
      rowRef: "1",
      instructions: "Do row one.",
    });
    const child = b.fake.created[0];
    assert.ok(child);
    assert.equal(child.promptCalls, 1, "the kickoff was the only prompt");
    const before = b.notifies.length;

    const routed = await b.pi.emit(
      "input",
      { text: "Also cover the cancelled row.", source: "interactive" },
      b.ctx,
    );
    assert.deepEqual(routed, [{ action: "handled" }]);
    assert.equal(
      child.promptCalls,
      2,
      "the running child received the prose, not the parent",
    );

    // Even with every row settled, a live child owns the turn: prose keeps
    // steering and auto-completion must not seal the run underneath it.
    await callTool(b, "workflow_todo", { action: "cancel", step: 1 });
    await callTool(b, "workflow_todo", { action: "cancel", step: 2 });
    assert.equal(
      lastRun(b).phase,
      "running",
      "a live child keeps the run open even when no row is left to settle",
    );
    const whileLive = await b.pi.emit(
      "input",
      { text: "One more thing before you finish.", source: "interactive" },
      b.ctx,
    );
    assert.deepEqual(whileLive, [{ action: "handled" }]);
    assert.equal(
      child.promptCalls,
      3,
      "auto-completion did not take the turn away from the child",
    );
    assert.equal(
      b.notifies.length,
      before,
      "forwarding a steer is silent",
    );

    child.settle("row one is done");
    await settleTicks();
    assert.equal(
      lastRun(b).phase,
      "completed",
      "once the child is gone the fully settled run completes",
    );
  });
});

// ── Replacing a finished run ───────────────────────────────────────

/**
 * Step 5 of the release fix: a settled/terminal run no longer owns the
 * session, so `orchestrator_start` must replace it. Only an active run (or a
 * live child) refuses, and a refused start must leave the old record intact.
 */
test("a completed run is replaced by orchestrator_start; an active run still refuses", async () => {
  await withBoot({ holdPrompt: true }, async (b) => {
    await startTwoRows(b);
    const firstRunId = lastRun(b).runId;
    assert.equal(lastRun(b).phase, "idle");
    assert.equal(lastTodos(b).length, 2);

    // Rows left to settle with no live child: the run is still the active
    // record, so a second start must refuse without touching it.
    const early = await callTool(b, "orchestrator_start", {
      title: "Too soon",
      steps: ["Nope"],
    });
    assert.match(early.text, /is still active \(idle\)/);
    assert.equal(early.details.code, "state");
    assert.equal(lastRun(b).runId, firstRunId, "the refused start kept the record");
    assert.equal(lastRun(b).rows.length, 2);
    assert.equal(lastTodos(b).length, 2, "the refused start kept the TODO list");

    // Settling every row auto-completes the run.
    await callTool(b, "workflow_todo", { action: "cancel", step: 1 });
    const cancelled = await callTool(b, "workflow_todo", {
      action: "cancel",
      step: 2,
    });
    assert.match(cancelled.text, /cancel/);
    assert.equal(lastRun(b).phase, "completed");

    const restarted = await callTool(b, "orchestrator_start", {
      title: "Replacement",
      steps: ["Fresh row one", "Fresh row two", "Fresh row three"],
    });
    assert.doesNotMatch(restarted.text, /already active|is still active/);
    assert.match(restarted.text, /created with 3 row/);

    const replaced = lastRun(b);
    assert.notEqual(replaced.runId, firstRunId, "the replacement is a new run");
    assert.equal(replaced.phase, "idle");
    assert.equal(replaced.title, "Replacement");
    assert.deepEqual(
      replaced.rows.map((row) => row.ref),
      ["1", "2", "3"],
      "the new run carries only the new rows",
    );
    assert.equal(
      replaced.rows[0]?.lastReport,
      undefined,
      "the replaced record keeps no old report",
    );
    const fresh = lastTodos(b);
    assert.equal(fresh.length, 3, "the TODO list was replaced with the new rows");
    assert.match(fresh[0]?.text ?? "", /Fresh row one/);
    assert.ok(
      fresh.every((item) => (item.status ?? (item.completed ? "completed" : "pending")) === "pending"),
      "every replacement row starts pending",
    );

    // A live child owns the session again: start refuses and keeps the record.
    await callTool(b, "orchestrator_dispatch", {
      rowRef: "1",
      instructions: "Do row one.",
    });
    assert.equal(lastRun(b).phase, "running");
    const live = await callTool(b, "orchestrator_start", {
      title: "Too soon again",
      steps: ["Nope"],
    });
    assert.match(live.text, /live Build child \(running\)/);
    assert.equal(live.details.code, "state");
    assert.equal(lastRun(b).runId, replaced.runId);
    assert.equal(lastRun(b).rows.length, 3);
    assert.equal(lastTodos(b).length, 3);

    b.fake.created[0]?.settle("row one is done");
    await settleTicks();
    assert.equal(
      lastRun(b).phase,
      "idle",
      "two pending rows keep the replacement run open after its first settle",
    );
  });
});

/**
 * Step 6 of the release fix: `/orchestrator start <plan>` records the plan for
 * the model-mediated run. On a completed run it must not answer with the old
 * "A run is already bound" refusal — the terminal record stays visible until
 * the model binds the replacement through `orchestrator_start`.
 */
test("the real /orchestrator start records a plan after completion without a bound-run refusal", async () => {
  await withBoot({ holdPrompt: true }, async (b) => {
    await startTwoRows(b);
    await callTool(b, "workflow_todo", { action: "cancel", step: 1 });
    await callTool(b, "workflow_todo", { action: "cancel", step: 2 });
    assert.equal(lastRun(b).phase, "completed");
    const runId = lastRun(b).runId;

    const planPath = path.join(b.cwd, "plan.md");
    writeFileSync(planPath, "# Plan: replacement\n\n1. Fresh row\n", "utf8");
    const warningsBefore = b.notifies.filter(
      (item) => item.level === "warning",
    ).length;
    const sentBefore = b.pi.sent.length;

    await (b.pi.commands.orchestrator.handler(
      `start ${planPath}`,
      b.ctx,
    ) as Promise<void>);

    const texts = b.notifies.map((item) => item.message).join("\n");
    assert.doesNotMatch(texts, /A run is already bound/);
    assert.doesNotMatch(texts, /still active|live Build child|before recording another plan/);
    assert.match(texts, /Plan .* recorded/);
    assert.equal(
      b.notifies.filter((item) => item.level === "warning").length,
      warningsBefore,
      "recording the plan after completion warns about nothing",
    );

    const kickoff = b.pi.sent
      .slice(sentBefore)
      .find(
        (item) =>
          (item.content as { customType?: string } | undefined)?.customType ===
          "workflow-orchestrator-start",
      );
    assert.ok(kickoff, "the start kickoff was sent to the parent model");

    const entry = [...b.pi.entries]
      .reverse()
      .find((item) => item.type === "workflow");
    assert.equal(
      (entry?.data as { planFile?: string } | undefined)?.planFile,
      planPath,
      "the approved plan is recorded as the bound plan",
    );
    assert.equal(
      lastRun(b).runId,
      runId,
      "the terminal record stays visible until the model binds the replacement",
    );
    assert.equal(lastRun(b).phase, "completed");
  });
});

// ── Sealing a terminal run against dispatch/retry ─────────────────

/**
 * Step 8 of the release fix: a completed or cancelled run is sealed. A stale
 * `orchestrator_dispatch`/`orchestrator_retry` call must not revive it by
 * starting a child and recording a fresh dispatch; the replacement path is
 * `orchestrator_start` with new rows.
 */
test("a terminal run refuses dispatch and retry with new-run guidance", async () => {
  for (const phase of ["completed", "cancelled"] as const) {
    await withBoot({ holdPrompt: true }, async (b) => {
      await startTwoRows(b);
      if (phase === "completed") {
        await callTool(b, "workflow_todo", { action: "cancel", step: 1 });
        await callTool(b, "workflow_todo", { action: "cancel", step: 2 });
      } else {
        await b.pi.commands.orchestrator.handler("stop", b.ctx);
      }
      assert.equal(lastRun(b).phase, phase);
      const runId = lastRun(b).runId;

      const explicit = await callTool(b, "orchestrator_dispatch", {
        rowRef: "1",
        instructions: "Run row one again.",
      });
      assert.equal(explicit.details.ok, false);
      assert.equal(explicit.details.code, "state");
      assert.match(explicit.text, new RegExp(`terminal run.*${phase}|${phase}.*terminal run`, "i"));
      assert.match(explicit.text, /orchestrator_start/);
      assert.match(explicit.text, /new rows/);

      // The default next-row path is sealed too, even with pending TODO rows.
      const fallback = await callTool(b, "orchestrator_dispatch", {
        instructions: "Run the next row.",
      });
      assert.equal(fallback.details.ok, false);
      assert.equal(fallback.details.code, "state");
      assert.match(fallback.text, /orchestrator_start/);

      const retried = await callTool(b, "orchestrator_retry", { rowRef: "1" });
      assert.equal(retried.details.ok, false);
      assert.equal(retried.details.code, "state");
      assert.match(retried.text, /orchestrator_start/);

      assert.equal(
        lastRun(b).phase,
        phase,
        "a refused dispatch/retry never revives the terminal run",
      );
      assert.equal(lastRun(b).runId, runId);
      assert.equal(b.fake.created.length, 0, "no child was started");

      // The status text agrees with the sealed phase: no dispatch, no stale
      // next row, and the replacement path is named.
      const status = await callTool(b, "orchestrator_status", {});
      assert.match(
        status.text,
        new RegExp(`No further dispatch for this ${phase} run`),
      );
      assert.match(status.text, /orchestrator_start/);
      assert.match(status.text, /replaces this run/);
      assert.doesNotMatch(status.text, /Next: Dispatch row/);

      // The sealed phase is replaceable, not revivable: a fresh start works
      // and carries a new runId with pending rows.
      const restarted = await callTool(b, "orchestrator_start", {
        title: `After ${phase}`,
        steps: ["Fresh row"],
      });
      assert.doesNotMatch(restarted.text, /already active|is still active/);
      assert.match(restarted.text, /created with 1 row/);
      assert.notEqual(lastRun(b).runId, runId);
      assert.equal(lastRun(b).phase, "idle");
      assert.deepEqual(
        lastTodos(b).map(
          (item) => item.status ?? (item.completed ? "completed" : "pending"),
        ),
        ["pending"],
        "the replacement rows start pending",
      );
    });
  }
});
