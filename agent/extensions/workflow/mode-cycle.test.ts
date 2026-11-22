/**
 * Live mode-cycle tests (plan step 2).
 *
 * `workflow-mode.ts` owns the ring; this file proves the *live extension*
 * dispatcher honours it: Tab and Ctrl+Alt+P advance through the real mode
 * setters, a double press serializes instead of losing a step, a managed worker
 * never reaches Orchestrator, and mode entry starts no work.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import workflowExtension from "./index.ts";
import { MANAGED_SESSION_ENTRY } from "./managed-session.ts";
import {
  fakeSdk,
  makeFakeCtx,
  makeFakePi,
  submitThenFinish,
  tmpProject,
} from "./test-support.ts";

interface BootOptions {
  branch?: unknown[];
  hasUI?: boolean;
}

async function boot(over: BootOptions = {}) {
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
  const made = makeFakeCtx({
    cwd,
    hasUI: over.hasUI === true,
    branch: over.branch ?? [],
  });
  await pi.emit("session_start", { reason: "startup" }, made.ctx);
  return {
    pi,
    ctx: made.ctx,
    notifies: made.notifies,
    statusCalls: made.statusCalls,
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

/** The persisted mode is the durable evidence; status text is presentation. */
function persistedMode(pi: ReturnType<typeof makeFakePi>) {
  const entry = [...pi.entries].reverse().find((item) => item.type === "workflow");
  return (entry?.data as { mode?: string | null } | undefined)?.mode ?? null;
}

async function tap(pi: ReturnType<typeof makeFakePi>, ctx: unknown, key = "tab") {
  const shortcut = pi.shortcuts[key];
  assert.ok(shortcut, `${key} must be registered`);
  await shortcut.handler(ctx);
}

/** The composer's mode button runs this command; it must be the Tab cycle. */
async function invokeCycle(pi: ReturnType<typeof makeFakePi>, ctx: unknown, args = "") {
  const command = pi.commands["workflow-cycle"];
  assert.ok(command, "the mode-cycle command must be registered");
  await command.handler(args, ctx);
}

test("mode cycle: Tab and Ctrl+Alt+P walk Default → Plan → Orchestrator → Build", async () => {
  const b = await boot();
  try {
    const seen: Array<string | null> = [];
    for (let i = 0; i < 4; i += 1) {
      await tap(b.pi, b.ctx);
      seen.push(persistedMode(b.pi));
    }
    assert.deepEqual(seen, ["plan", "orchestrator", "build", null]);

    // A second lap and the alias chord produce the same order.
    const alias: Array<string | null> = [];
    for (let i = 0; i < 4; i += 1) {
      await tap(b.pi, b.ctx, "ctrl+alt+p");
      alias.push(persistedMode(b.pi));
    }
    assert.deepEqual(alias, ["plan", "orchestrator", "build", null]);
  } finally {
    await b.cleanup();
  }
});

test("mode cycle: a double press advances twice, never losing a step", async () => {
  const b = await boot();
  try {
    const shortcut = b.pi.shortcuts.tab;
    // Two presses before either transition settles.
    const first = shortcut.handler(b.ctx);
    const second = shortcut.handler(b.ctx);
    await Promise.all([first, second]);
    assert.equal(persistedMode(b.pi), "orchestrator");

    await tap(b.pi, b.ctx);
    assert.equal(persistedMode(b.pi), "build");
  } finally {
    await b.cleanup();
  }
});

test("mode cycle: the composer command walks the same ring as Tab", async () => {
  const b = await boot();
  try {
    // Alternate the two entry points: a click must not need Tab, and the pair
    // must produce exactly one ring, including Default.
    const seen: Array<string | null> = [];
    await invokeCycle(b.pi, b.ctx);
    seen.push(persistedMode(b.pi));
    await tap(b.pi, b.ctx);
    seen.push(persistedMode(b.pi));
    await invokeCycle(b.pi, b.ctx);
    seen.push(persistedMode(b.pi));
    await tap(b.pi, b.ctx);
    seen.push(persistedMode(b.pi));
    assert.deepEqual(seen, ["plan", "orchestrator", "build", null]);

    // A command that targeted a fixed mode (e.g. /build) would not return here.
    await invokeCycle(b.pi, b.ctx, "ignored-argument");
    assert.equal(persistedMode(b.pi), "plan");
  } finally {
    await b.cleanup();
  }
});

test("mode cycle: a double command activation advances twice, never losing a step", async () => {
  const b = await boot();
  try {
    const first = invokeCycle(b.pi, b.ctx);
    const second = invokeCycle(b.pi, b.ctx);
    await Promise.all([first, second]);
    assert.equal(persistedMode(b.pi), "orchestrator");
  } finally {
    await b.cleanup();
  }
});

test("mode cycle: the command shares the overlay-open guard with Tab", async () => {
  const branch = [
    { type: "message", message: { role: "user", content: "first prompt" } },
    { type: "message", message: { role: "user", content: "second prompt" } },
  ];
  const b = await boot({ hasUI: true, branch });
  try {
    const before = persistedMode(b.pi);
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    (b.ctx as any).ui.custom = async () => {
      await gate;
      return null;
    };
    const rewinding = b.pi.commands.rewind.handler("", b.ctx);
    await invokeCycle(b.pi, b.ctx);
    assert.equal(persistedMode(b.pi), before, "a click is ignored while a dialog owns input");
    release?.();
    await rewinding;
    await invokeCycle(b.pi, b.ctx);
    assert.notEqual(persistedMode(b.pi), before);
  } finally {
    await b.cleanup();
  }
});

test("mode cycle: a queued cycle never crosses a session rebind", async () => {
  const b = await boot();
  try {
    // The request is queued for the current session lifetime, then the session
    // is shut down before the queued task observes it. The transition must be
    // abandoned instead of publishing into a replacement session.
    const pending = invokeCycle(b.pi, b.ctx);
    await b.pi.emit("session_shutdown", { reason: "reload" }, b.ctx);
    await pending;
    assert.equal(persistedMode(b.pi), null);
  } finally {
    await b.cleanup();
  }
});

test("mode cycle: entry never sends a prompt, starts a run or launches a child", async () => {
  const b = await boot();
  try {
    for (let i = 0; i < 8; i += 1) await tap(b.pi, b.ctx);
    assert.deepEqual(b.pi.sent, [], "mode switching must not create a turn");
    // Parent orchestration tools ARE registered in every session (so a call
    // gets a truthful refusal instead of "unknown tool"). Registration is not
    // activation: outside an approved Orchestrator run they refuse.
    assert.equal(
      Object.keys(b.pi.tools).some((name) => name.startsWith("orchestrator_")),
      true,
      "parent tools are registered deliberately",
    );
    const refused = await b.pi.tools.orchestrator_status.execute("t-mode", {});
    assert.match(
      JSON.stringify(refused),
      /Orchestrator mode only|no approved roadmap|managed worker/i,
      "a tool call without a bound run has no orchestration authority",
    );
    assert.deepEqual(b.pi.sent, [], "a refused tool call creates no turn");
    // No dispatch/launch side effect is observable through the fake host.
    assert.equal(
      b.notifies.some((note) => /dispatching|launched child/i.test(note.message)),
      false,
    );
  } finally {
    await b.cleanup();
  }
});

test("mode cycle: a managed worker skips Orchestrator and cannot enter it", async () => {
  const b = await boot({
    branch: [
      {
        type: "custom",
        customType: MANAGED_SESSION_ENTRY,
        data: {
          version: 1,
          runId: "run-1",
          taskId: "task-1",
          attemptId: "attempt-1",
          parentSessionRef: "parent-session",
          relation: "child",
          mode: "build",
        },
      },
    ],
  });
  try {
    await b.pi.commands.build.handler("", b.ctx);
    const seen: Array<string | null> = [];
    for (let i = 0; i < 4; i += 1) {
      await tap(b.pi, b.ctx);
      seen.push(persistedMode(b.pi));
    }
    assert.deepEqual(seen, [null, "plan", "build", null]);
    assert.equal(seen.includes("orchestrator"), false);

    await b.pi.commands.orchestrator.handler("", b.ctx);
    assert.notEqual(persistedMode(b.pi), "orchestrator");
    assert.ok(
      b.notifies.some((note) => /managed Build worker/i.test(note.message)),
      "the refusal is explained",
    );
  } finally {
    await b.cleanup();
  }
});

test("mode cycle: a real overlay-open Tab is ignored", async () => {
  // `/rewind` raises the extension overlay counter around `ctx.ui.custom`, so a
  // pending editor proves the live shortcut consults that guard. Two user
  // prompts give the picker rows to show.
  const branch = [
    { type: "message", message: { role: "user", content: "first prompt" } },
    { type: "message", message: { role: "user", content: "second prompt" } },
  ];
  const b = await boot({ hasUI: true, branch });
  try {
    const before = persistedMode(b.pi);
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    (b.ctx as any).ui.custom = async () => {
      await gate;
      return null;
    };
    const rewinding = b.pi.commands.rewind.handler("", b.ctx);
    await tap(b.pi, b.ctx);
    assert.equal(persistedMode(b.pi), before, "Tab is ignored while a dialog owns input");
    release?.();
    await rewinding;
    // Once the overlay closes, Tab works again.
    await tap(b.pi, b.ctx);
    assert.notEqual(persistedMode(b.pi), before);
  } finally {
    await b.cleanup();
  }
});
