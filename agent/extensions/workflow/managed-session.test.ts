/**
 * Managed worker session tests (step 6).
 *
 * Two layers are covered:
 *  - the pure bootstrap codec/readiness gate;
 *  - the real extension wiring (a managed branch blocks mutation until
 *    `workflow_worker_ready`, while an ordinary session is unchanged).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import workflowExtension from "./index.ts";
import {
  MANAGED_SESSION_ENTRY,
  createManagedSessionGate,
  isManagedWorker,
  parseManagedSessionContext,
  readManagedSessionContext,
  type ManagedSessionContext,
} from "./managed-session.ts";
import {
  fakeSdk,
  makeFakeCtx,
  makeFakePi,
  submitThenFinish,
  tmpProject,
} from "./test-support.ts";

const CONTEXT = {
  version: 1,
  runId: "run-1",
  taskId: "task-1",
  attemptId: "attempt-1",
  parentSessionRef: "session-parent",
  relation: "child",
  mode: "build",
};

const parsed: ManagedSessionContext = {
  version: 1,
  runId: "run-1",
  taskId: "task-1",
  attemptId: "attempt-1",
  parentSessionRef: "session-parent",
  relation: "child",
  mode: "build",
  mayOrchestrate: false,
};

// ── Codec ────────────────────────────────────────────────────────────

test("bootstrap: a valid record is normalized and can never opt into orchestration", () => {
  const result = parseManagedSessionContext({ ...CONTEXT, mayOrchestrate: true });
  assert.deepEqual(result, { ok: true, source: "entry", context: parsed });
});

test("bootstrap: unknown version and invalid ids fail closed with a reason", () => {
  for (const broken of [
    { ...CONTEXT, version: 2 },
    { ...CONTEXT, runId: "1" },
    { ...CONTEXT, taskId: "task 1" },
    { ...CONTEXT, attemptId: "attempt" },
    { ...CONTEXT, parentSessionRef: "" },
    { ...CONTEXT, relation: "cousin" },
  ]) {
    const result = parseManagedSessionContext(broken);
    assert.equal(result.ok, false, JSON.stringify(broken).slice(0, 60));
    if (!result.ok) assert.notEqual(result.reason, "absent");
  }
  assert.deepEqual(parseManagedSessionContext(undefined), { ok: false, reason: "absent" });
  assert.deepEqual(parseManagedSessionContext(null), { ok: false, reason: "absent" });
});

test("bootstrap: reads a custom entry, a custom message, and the newest wins", () => {
  const fromEntry = readManagedSessionContext([
    { type: "custom", customType: MANAGED_SESSION_ENTRY, data: CONTEXT },
  ]);
  assert.equal(fromEntry.ok, true);

  const fromMessage = readManagedSessionContext([
    {
      type: "message",
      message: {
        customType: MANAGED_SESSION_ENTRY,
        content: JSON.stringify(CONTEXT),
      },
    },
  ]);
  assert.equal(fromMessage.ok, true);
  if (fromMessage.ok) assert.equal(fromMessage.source, "message");

  const newest = readManagedSessionContext([
    { type: "custom", customType: MANAGED_SESSION_ENTRY, data: CONTEXT },
    {
      type: "custom",
      customType: MANAGED_SESSION_ENTRY,
      data: { ...CONTEXT, attemptId: "attempt-2" },
    },
  ]);
  assert.equal(newest.ok, true);
  if (newest.ok) assert.equal(newest.context.attemptId, "attempt-2");
});

test("bootstrap: malformed message content is an explicit error, not 'absent'", () => {
  const notJson = readManagedSessionContext([
    {
      type: "message",
      message: { customType: MANAGED_SESSION_ENTRY, content: "{oops" },
    },
  ]);
  assert.equal(notJson.ok, false);
  if (!notJson.ok) assert.match(notJson.reason, /not valid JSON/);

  const noText = readManagedSessionContext([
    { type: "message", message: { customType: MANAGED_SESSION_ENTRY, content: [] } },
  ]);
  assert.equal(noText.ok, false);
  if (!noText.ok) assert.match(noText.reason, /no text content/);
});

test("bootstrap: an ordinary branch is absent, and isManagedWorker is false", () => {
  assert.deepEqual(readManagedSessionContext([]), { ok: false, reason: "absent" });
  assert.equal(isManagedWorker([]), false);
  assert.equal(isManagedWorker([{ type: "message", message: { role: "user" } }]), false);
});

// ── Readiness gate ───────────────────────────────────────────────────

test("gate: mutation is refused until the worker acknowledges", () => {
  const gate = createManagedSessionGate(parsed, "session-1");
  assert.equal(gate.phase(), "pending_ready");
  assert.equal(gate.canMutate(), false);
  assert.match(gate.mutationBlockReason("edit") ?? "", /not ready yet/);
  assert.equal(gate.sessionKey(), "session-1");

  assert.equal(gate.acknowledgeStart(1_700_000_000_000), true);
  assert.equal(gate.phase(), "ready");
  assert.equal(gate.canMutate(), true);
  assert.equal(gate.acknowledgedAt(), 1_700_000_000_000);
  assert.equal(gate.mutationBlockReason("edit"), undefined);
  // Idempotent.
  assert.equal(gate.acknowledgeStart(), true);
  assert.equal(gate.acknowledgedAt(), 1_700_000_000_000);
});

test("gate: a closed worker cannot mutate or re-open itself", () => {
  const gate = createManagedSessionGate(parsed);
  gate.acknowledgeStart();
  gate.close();
  assert.equal(gate.phase(), "closed");
  assert.equal(gate.canMutate(), false);
  assert.equal(gate.acknowledgeStart(), false);
  assert.match(gate.mutationBlockReason("bash") ?? "", /closed/);
});

test("gate: a missing session id derives a stable correlation key", () => {
  const a = createManagedSessionGate(parsed).sessionKey();
  const b = createManagedSessionGate(parsed).sessionKey();
  assert.equal(a, b);
  assert.match(a, /^run-1\/task-1\/attempt-1$/);
});

// ── Extension wiring ─────────────────────────────────────────────────

function managedBranch() {
  return [
    {
      type: "custom",
      customType: MANAGED_SESSION_ENTRY,
      data: CONTEXT,
    },
  ];
}

async function boot(branch: unknown[]) {
  const { cwd, agentDir } = tmpProject();
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const pi = makeFakePi({ activeTools: ["read", "write", "edit", "bash"] });
  const { sdk } = fakeSdk({ pass1: submitThenFinish("# Plan: x") });
  await workflowExtension(pi as never, {
    loadSdk: async () => sdk as never,
    plannotatorRequestTimeoutMs: 20,
    plannotatorRecoveryTimeoutMs: 20,
    isTerminalHost: () => true,
  });
  const made = makeFakeCtx({ cwd, hasUI: false, branch });
  await pi.emit("session_start", { reason: "startup" }, made.ctx);
  return {
    pi,
    made,
    async cleanup() {
      try {
        await pi.emit("session_shutdown", { reason: "quit" }, made.ctx);
      } catch {
        /* best effort */
      }
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
    },
  };
}

/** Run every `tool_call` handler and return the first block result. */
async function gateResult(
  pi: ReturnType<typeof makeFakePi>,
  ctx: unknown,
  toolName: string,
  input: unknown,
) {
  const handlers = pi.handlers.get("tool_call") ?? [];
  for (const handler of handlers) {
    const result = (await handler(
      { toolName, toolCallId: "c1", input },
      ctx,
    )) as { block?: boolean; reason?: string } | undefined;
    if (result?.block) return result;
  }
  return undefined;
}

test("extension: a managed worker cannot edit or run a shell before acknowledgement", async () => {
  const b = await boot(managedBranch());
  try {
    const edit = await gateResult(b.pi, b.made.ctx, "edit", { path: `${b.made.ctx.cwd}/a.ts` });
    assert.equal(edit?.block, true);
    assert.match(edit?.reason ?? "", /not ready yet/);

    const shell = await gateResult(b.pi, b.made.ctx, "bash", { command: "echo hi" });
    assert.equal(shell?.block, true);
    assert.match(shell?.reason ?? "", /not ready yet/);

    // Read-only inspection and its own TODO list stay open.
    assert.equal(await gateResult(b.pi, b.made.ctx, "read", { path: `${b.made.ctx.cwd}/a.ts` }), undefined);
    assert.equal(
      await gateResult(b.pi, b.made.ctx, "workflow_todo", { action: "list" }),
      undefined,
    );

    const ready = await b.pi.tools.workflow_worker_ready.execute();
    assert.match(JSON.stringify(ready), /acknowledged/);

    const after = await gateResult(b.pi, b.made.ctx, "edit", { path: `${b.made.ctx.cwd}/a.ts` });
    assert.equal(after, undefined, "an acknowledged worker may mutate");
  } finally {
    await b.cleanup();
  }
});

test("extension: an ordinary session is completely unaffected", async () => {
  const b = await boot([]);
  try {
    // No managed context → the readiness gate is inert.
    const edit = await gateResult(b.pi, b.made.ctx, "edit", { path: `${b.made.ctx.cwd}/a.ts` });
    assert.equal(edit, undefined);
    const ready = await b.pi.tools.workflow_worker_ready.execute();
    assert.match(JSON.stringify(ready), /not_managed/);
  } finally {
    await b.cleanup();
  }
});

test("extension: a corrupt bootstrap starts an ordinary session with a warning", async () => {
  const b = await boot([
    { type: "custom", customType: MANAGED_SESSION_ENTRY, data: { version: 99 } },
  ]);
  try {
    assert.ok(
      b.made.notifies.some((note) => /bootstrap ignored/.test(note.message)),
      "the user must be told the record was ignored",
    );
    const edit = await gateResult(b.pi, b.made.ctx, "edit", { path: `${b.made.ctx.cwd}/a.ts` });
    assert.equal(edit, undefined);
  } finally {
    await b.cleanup();
  }
});
