/**
 * Live composition tests (integration steps 13/17/24).
 *
 * These boot the REAL extension entrypoint with the fake Pi host. They prove
 * registration is not authority, and that a managed child only mutates after
 * the parent's authenticated start grant — with a real local control socket.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import workflowExtension from "./index.ts";
import { makeFakeCtx, makeFakePi, tmpProject } from "./test-support.ts";
import { createRunControl } from "./orchestrator-run-control.ts";
import { workerIdFor } from "./orchestrator-worker.ts";

type Booted = {
  pi: ReturnType<typeof makeFakePi>;
  ctx: ReturnType<typeof makeFakeCtx>["ctx"];
  notifies: Array<{ message: string; level?: string }>;
  cleanup: () => void;
};

async function boot(branch: unknown[]): Promise<Booted> {
  const { root, cwd, agentDir } = tmpProject();
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const pi = makeFakePi();
  await workflowExtension(pi as never, { isTerminalHost: () => true });
  const made = makeFakeCtx({ cwd, branch, projectTrusted: true });
  const ctx = made.ctx;
  return {
    pi,
    ctx,
    notifies: made.notifies,
    cleanup: () => {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 4_000): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return predicate();
}

test("live: parent orchestration tools are registered but refuse without approval", async () => {
  const b = await boot([]);
  try {
    await waitFor(() => !!b.pi.tools["orchestrator_dispatch"]);
    assert.ok(b.pi.tools["orchestrator_dispatch"], "dispatch is registered");
    assert.ok(b.pi.tools["orchestrator_verify"], "verify is registered");
    const accept = b.pi.tools["orchestrator_accept"] as any;
    const schema = JSON.stringify(accept?.parameters ?? {});
    assert.match(schema, /taskId/);
    assert.doesNotMatch(schema, /AcceptanceEvidence/);
    // The model cannot narrow the requirement set or name the session it will
    // own; both are resolved by the runtime from immutable state.
    const proposeSchema = JSON.stringify((b.pi.tools["orchestrator_propose_tasks"] as any)?.parameters ?? {});
    assert.doesNotMatch(proposeSchema, /"requirements":/);
    const dispatchSchema = JSON.stringify((b.pi.tools["orchestrator_dispatch"] as any)?.parameters ?? {});
    assert.doesNotMatch(dispatchSchema, /"sessionRef":/);

    await b.pi.emit("session_start", { reason: "startup" }, b.ctx as never);
    await b.pi.commands["orchestrator"]!.handler("", b.ctx as never);

    const dispatch = b.pi.tools["orchestrator_dispatch"] as any;
    const result = await dispatch.execute("call-1", { taskId: "task-1", attemptId: "a1" }, undefined, undefined, b.ctx);
    const text = String(result?.content?.[0]?.text ?? "");
    assert.match(text, /No approved roadmap|No child host|not dispatchable|Orchestrator/i);
    // Registration and mode entry never start a child or a run.
    assert.equal(b.pi.sent.length, 0);
  } finally {
    b.cleanup();
  }
});

test("live: /orchestrator start compiles the current discussion without a plan file or /build", async () => {
  const b = await boot([]);
  try {
    await waitFor(() => !!b.pi.tools["orchestrator_prepare"]);
    await b.pi.emit("session_start", { reason: "startup" }, b.ctx as never);
    // The discussion is the current user prompt; no Markdown plan exists.
    await b.pi.emit(
      "before_agent_start",
      { prompt: "Implement the export command\n- add the CLI command\n- add tests" },
      b.ctx as never,
    );

    await b.pi.commands["orchestrator"]!.handler("start", b.ctx as never);
    const text = b.notifies.map((entry) => entry.message).join("\n");
    assert.match(text, /Work source bound: current discussion/);
    assert.match(text, /distinct|execution approval|approval/i);
    assert.doesNotMatch(text, /\/build switch is needed|Plan mode/i);
    // Preparation binds a run but launches nothing.
    assert.equal(
      b.pi.sent.filter(
        (entry) => (entry.content as { type?: string } | undefined)?.type === "workflow-task-start",
      ).length,
      0,
    );
  } finally {
    b.cleanup();
  }
});

test("live: a managed child authorizes only from the parent's signed start grant", async () => {
  const b = await boot([]);
  try {
    const agentDir = process.env.PI_CODING_AGENT_DIR!;
    const cwd = b.ctx.cwd;
    const runId = `run-live-${process.pid}-${Date.now()}`;
    const taskId = "task-1";
    const attemptId = "attempt-1";
    const sessionId = workerIdFor({ runId, taskId, attemptId });
    const taskStartId = `start-${sessionId}-${attemptId}`;

    const parent = createRunControl({
      profileDir: agentDir,
      runId,
      platform: process.platform,
    });
    assert.deepEqual(await parent.start(), { ok: true });
    const prepared = await parent.prepareGrant({
      taskId,
      attemptId,
      sessionId,
      generation: 1,
      taskStartId,
    });
    assert.equal(prepared.ok, true);
    if (!prepared.ok) return;
    const waiting = parent.awaitStart({ sessionId, timeoutMs: 5_000 });

    // The child's own metadata: managed identity, assignment, scope, roadmap
    // and the grant REFERENCE (never the secret).
    const branch = [
      {
        type: "custom",
        customType: "workflow-managed-session",
        data: {
          version: 1,
          runId,
          taskId,
          attemptId,
          parentSessionRef: "parent-1",
          relation: "child",
          mode: "build",
          mayOrchestrate: false,
        },
      },
      {
        type: "custom",
        customType: "workflow-task-assignment",
        data: {
          assignmentId: `assignment-${sessionId}`,
          taskStartId,
          packetRef: "packet",
          kickoff: "Do the assigned task.",
          model: { provider: "p", id: "builder" },
          trust: "session",
          profile: null,
        },
      },
      {
        type: "custom",
        customType: "workflow-task-scope",
        data: {
          covers: ["1"],
          objective: "Implement the assigned change",
          acceptanceChecks: ["npm test"],
          expectedFiles: ["src/x.ts"],
        },
      },
      {
        type: "custom",
        customType: "workflow-roadmap-reference",
        data: { path: path.join(cwd, "plan.md"), digest: "d".repeat(64), revision: 1 },
      },
      {
        type: "custom",
        customType: "workflow-control-grant",
        data: { grantRef: prepared.grantRef, controlSessionId: sessionId },
      },
    ];
    const child = await boot(branch);
    try {
      await child.pi.emit("session_start", { reason: "startup" }, child.ctx as never);
      const delivered = await waitFor(() =>
        child.pi.sent.some(
          (entry) => (entry.content as { customType?: string } | undefined)?.customType === "workflow-task-start",
        ),
      );
      assert.equal(
        delivered,
        true,
        `the authorized kickoff must be delivered; notifies=${JSON.stringify(child.notifies)}`,
      );
      assert.deepEqual(await waiting, { ok: true, acknowledged: true });
    } finally {
      child.cleanup();
      await parent.stop();
    }
  } finally {
    b.cleanup();
  }
});
