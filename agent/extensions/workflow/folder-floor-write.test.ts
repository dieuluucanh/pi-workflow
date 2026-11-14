/**
 * Workflow Extension — shared folder floor in the WRITE gate
 *
 * Run with: npm test   (node --test, type-stripping — no build step)
 *
 * Drives the real `tool_call` handler: write mode `allow` must not escape the
 * folder scope; sensitive write targets stay blocked inside the folder; the
 * "Always allow" dialog persists a project-scoped write grant.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import workflowExtension from "./index.ts";
import { makeFakeCtx, makeFakePi, tmpProject } from "./test-support.ts";

async function boot(settings: Record<string, unknown>, projectTrusted = true) {
  const { root, cwd, agentDir } = tmpProject();
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
  fs.writeFileSync(
    path.join(cwd, ".pi", "settings.json"),
    `${JSON.stringify(settings, null, 2)}\n`,
    "utf8",
  );
  const pi = makeFakePi();
  await workflowExtension(pi as never, {
    loadSdk: async () => ({}) as never,
  });
  const { ctx } = makeFakeCtx({
    cwd,
    hasUI: true,
    projectTrusted,
    selectAnswer: undefined,
  });
  await pi.emit("session_start", { reason: "startup" }, ctx);
  const cleanup = async () => {
    try {
      await pi.emit("session_shutdown", {}, ctx);
    } catch {
      /* best effort */
    }
    fs.rmSync(root, { recursive: true, force: true });
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  };
  return { cwd, agentDir, pi, ctx, cleanup };
}

function toolCall(
  pi: ReturnType<typeof makeFakePi>,
  ctx: unknown,
  toolName: string,
  input: Record<string, unknown>,
) {
  const handlers = pi.handlers.get("tool_call") ?? [];
  assert.ok(handlers.length > 0, "tool_call handler registered");
  return handlers[0]({ toolName, toolCallId: "t1", input }, ctx);
}

test("write: default folder scope asks outside even with writePolicy allow", async () => {
  const { cwd, pi, ctx, cleanup } = await boot({
    workflow: {
      folderPolicy: { mode: "cwd", outside: "ask" },
      writePolicy: { mode: "allow" },
    },
  });
  try {
    const outside = path.join(cwd, "..", "outside.txt");
    (ctx as any).ui.select = async () => undefined; // cancel -> deny
    const blocked = await toolCall(pi, ctx, "write", { path: outside });
    assert.ok(blocked && (blocked as any).block);
    assert.match(String((blocked as any).reason), /folder|outside|permitted/i);

    await pi.emit("turn_start", { turnIndex: 1, timestamp: Date.now() }, ctx);
    (ctx as any).ui.select = async () => "Allow once (this turn)";
    assert.equal(
      await toolCall(pi, ctx, "write", {
        path: path.join(cwd, "..", "outside-2.txt"),
      }),
      undefined,
    );
  } finally {
    await cleanup();
  }
});

test("write: folderPolicy outside=block refuses outside with writePolicy allow", async () => {
  const { cwd, pi, ctx, cleanup } = await boot({
    workflow: {
      folderPolicy: { mode: "cwd", outside: "block" },
      writePolicy: { mode: "allow" },
    },
  });
  try {
    const result = await toolCall(pi, ctx, "write", {
      path: path.join(cwd, "..", "outside.txt"),
    });
    assert.ok(result && (result as any).block);
    assert.match(String((result as any).reason), /Folder policy|permitted/i);
  } finally {
    await cleanup();
  }
});

test("write: sensitive target is blocked inside the folder even with allow", async () => {
  const { cwd, pi, ctx, cleanup } = await boot({
    workflow: {
      folderPolicy: { mode: "cwd", outside: "ask" },
      writePolicy: { mode: "allow" },
    },
  });
  try {
    const result = await toolCall(pi, ctx, "write", { path: path.join(cwd, ".env") });
    assert.ok(result && (result as any).block);
    assert.match(String((result as any).reason), /sensitive/i);
  } finally {
    await cleanup();
  }
});

test("write: shell destination outside is gated", async () => {
  const { cwd, pi, ctx, cleanup } = await boot({
    workflow: {
      folderPolicy: { mode: "cwd", outside: "ask" },
      writePolicy: { mode: "allow" },
    },
  });
  try {
    (ctx as any).ui.select = async () => undefined;
    const result = await toolCall(pi, ctx, "bash", {
      command: `echo x > "${path.join(cwd, "..", "out.txt").replace(/\\/g, "/")}"`,
    });
    assert.ok(result && (result as any).block);
  } finally {
    await cleanup();
  }
});

test("write: shell redirection to .env is blocked as sensitive", async () => {
  const { cwd, pi, ctx, cleanup } = await boot({
    workflow: {
      folderPolicy: { mode: "cwd", outside: "ask" },
      writePolicy: { mode: "allow" },
    },
  });
  try {
    const result = await toolCall(pi, ctx, "bash", {
      command: `echo x > "${path.join(cwd, ".env").replace(/\\/g, "/")}"`,
    });
    assert.ok(result && (result as any).block);
    assert.match(String((result as any).reason), /sensitive/i);
  } finally {
    await cleanup();
  }
});

test("write: Always allow persists a project-scoped write grant", async () => {
  const { cwd, agentDir, pi, ctx, cleanup } = await boot({
    workflow: {
      folderPolicy: { mode: "cwd", outside: "ask", grantScope: "project" },
      writePolicy: { mode: "allow" },
    },
  });
  try {
    const outside = path.join(cwd, "..", "shared", "out.txt");
    (ctx as any).ui.select = async () => "Always allow this path";
    const result = await toolCall(pi, ctx, "write", { path: outside });
    assert.equal(result, undefined);
    const project = JSON.parse(
      fs.readFileSync(path.join(cwd, ".pi", "settings.json"), "utf8"),
    );
    assert.ok(
      Array.isArray(project.workflow.writePolicy.allowedPaths) &&
        project.workflow.writePolicy.allowedPaths.length > 0,
    );
    assert.ok(
      project.workflow.writePolicy.allowedPaths.some((p: string) =>
        p.includes("shared"),
      ),
    );
    assert.equal(fs.existsSync(path.join(agentDir, "settings.json")), false);
  } finally {
    await cleanup();
  }
});

test("write: a path-less mutating tool is uncertain, not silently allowed", async () => {
  const { pi, ctx, cleanup } = await boot({
    workflow: {
      folderPolicy: { mode: "cwd", outside: "ask" },
      writePolicy: { mode: "allow", mutatingTools: ["custom_write"] },
    },
  });
  try {
    (ctx as any).ui.select = async () => undefined;
    const result = await toolCall(pi, ctx, "custom_write", { blob: "x" });
    assert.ok(result && (result as any).block);
  } finally {
    await cleanup();
  }
});

test("write: Always allow refuses a project grant when the project is untrusted", async () => {
  const { cwd, pi, ctx, cleanup } = await boot(
    {
      workflow: {
        folderPolicy: { mode: "cwd", outside: "ask", grantScope: "project" },
        writePolicy: { mode: "allow" },
      },
    },
    false,
  );
  try {
    (ctx as any).ui.select = async () => "Always allow this path";
    const result = await toolCall(pi, ctx, "write", {
      path: path.join(cwd, "..", "outside.txt"),
    });
    assert.ok(result && (result as any).block);
    assert.match(String((result as any).reason), /trusted|trust/i);
  } finally {
    await cleanup();
  }
});
