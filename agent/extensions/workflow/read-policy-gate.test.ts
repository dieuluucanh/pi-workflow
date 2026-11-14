/**
 * Workflow Extension — read gate integration tests
 *
 * Run with: npm test   (node --test, type-stripping — no build step)
 *
 * Drives the real `tool_call` and `tool_result` handlers: folder asks, grants,
 * sensitive blocking, parent/any modes, headless fail-closed, explore/file-URL
 * targets and grep redaction.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import workflowExtension from "./index.ts";
import { makeFakeCtx, makeFakePi, tmpProject } from "./test-support.ts";

async function boot(
  settings: Record<string, unknown> = {},
  hasUI = true,
  projectTrusted = true,
) {
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
  const { ctx } = makeFakeCtx({ cwd, hasUI, projectTrusted });
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
  return { cwd, pi, ctx, cleanup };
}

function call(
  pi: ReturnType<typeof makeFakePi>,
  ctx: unknown,
  toolName: string,
  input: Record<string, unknown>,
  id = "t1",
) {
  const handlers = pi.handlers.get("tool_call") ?? [];
  assert.ok(handlers.length > 0);
  return handlers[0]({ toolName, toolCallId: id, input }, ctx);
}

test("read: cwd reads are free", async () => {
  const { pi, ctx, cleanup } = await boot();
  try {
    assert.equal(await call(pi, ctx, "read", { path: "src/app.ts" }), undefined);
    assert.equal(await call(pi, ctx, "ls", {}), undefined);
  } finally {
    await cleanup();
  }
});

test("read: outside asks; cancel denies, allow-once allows", async () => {
  const { cwd, pi, ctx, cleanup } = await boot();
  try {
    const outside = path.join(cwd, "..", "outside.ts");
    (ctx as any).ui.select = async () => undefined;
    const denied = await call(pi, ctx, "read", { path: outside });
    assert.ok(denied && (denied as any).block);

    await pi.emit("turn_start", { turnIndex: 1, timestamp: Date.now() }, ctx);
    (ctx as any).ui.select = async () => "Allow once (this turn)";
    assert.equal(
      await call(pi, ctx, "read", {
        path: path.join(cwd, "..", "outside-2.ts"),
      }),
      undefined,
    );
  } finally {
    await cleanup();
  }
});

test("read: parent mode allows siblings without a dialog", async () => {
  const { cwd, pi, ctx, cleanup } = await boot({
    workflow: { folderPolicy: { mode: "parent", outside: "ask" } },
  });
  try {
    assert.equal(
      await call(pi, ctx, "read", {
        path: path.join(cwd, "..", "sibling", "x.ts"),
      }),
      undefined,
    );
  } finally {
    await cleanup();
  }
});

test("read: any mode still blocks sensitive files", async () => {
  const { cwd, pi, ctx, cleanup } = await boot({
    workflow: { folderPolicy: { mode: "any", outside: "ask" } },
  });
  try {
    assert.equal(
      await call(pi, ctx, "read", { path: path.join(cwd, "..", "x.ts") }),
      undefined,
    );
    const blocked = await call(pi, ctx, "read", {
      path: path.join(cwd, ".env"),
    });
    assert.ok(blocked && (blocked as any).block);
    assert.match(String((blocked as any).reason), /sensitive/i);
  } finally {
    await cleanup();
  }
});

test("read: templates are not sensitive", async () => {
  const { cwd, pi, ctx, cleanup } = await boot();
  try {
    assert.equal(
      await call(pi, ctx, "read", { path: path.join(cwd, ".env.example") }),
      undefined,
    );
  } finally {
    await cleanup();
  }
});

test("read: headless outside ask fails closed", async () => {
  const { cwd, pi, ctx, cleanup } = await boot({}, false);
  try {
    const result = await call(pi, ctx, "read", {
      path: path.join(cwd, "..", "outside.ts"),
    });
    assert.ok(result && (result as any).block);
    assert.match(String((result as any).reason), /no interactive UI/i);
  } finally {
    await cleanup();
  }
});

test("read: explore cwd outside is gated", async () => {
  const { cwd, pi, ctx, cleanup } = await boot();
  try {
    (ctx as any).ui.select = async () => undefined;
    const result = await call(pi, ctx, "explore", { cwd: path.join(cwd, "..") });
    assert.ok(result && (result as any).block);
  } finally {
    await cleanup();
  }
});

test("read: local fetch_content/file URL is gated", async () => {
  const { cwd, pi, ctx, cleanup } = await boot();
  try {
    (ctx as any).ui.select = async () => undefined;
    const target = path.join(cwd, "..", "video.mp4");
    const result = await call(pi, ctx, "fetch_content", { url: target });
    assert.ok(result && (result as any).block);
  } finally {
    await cleanup();
  }
});

test("read: strict shell asks for unverifiable inline code", async () => {
  const { pi, ctx, cleanup } = await boot({
    workflow: { readPolicy: { shell: "strict" } },
  });
  try {
    (ctx as any).ui.select = async () => undefined;
    const result = await call(pi, ctx, "bash", { command: "node -e 'x'" });
    assert.ok(result && (result as any).block);
  } finally {
    await cleanup();
  }
});

test("tool_result: grep output is redacted", async () => {
  const { cwd, pi, ctx, cleanup } = await boot();
  try {
    const results = await pi.emit(
      "tool_result",
      {
        toolName: "grep",
        input: { path: cwd },
        content: [
          {
            type: "text",
            text: [".env:1: SECRET=x", "src/app.ts:2: ok"].join("\n"),
          },
        ],
      },
      ctx,
    );
    const result = results[0] as any;
    assert.ok(result);
    const text = String(result.content?.[0]?.text ?? "");
    assert.doesNotMatch(text, /SECRET/);
    assert.match(text, /src\/app\.ts:2/);
  } finally {
    await cleanup();
  }
});

test("read: Always allow persists a project-scoped read grant", async () => {
  const { cwd, pi, ctx, cleanup } = await boot({
    workflow: { folderPolicy: { mode: "cwd", outside: "ask", grantScope: "project" } },
  });
  try {
    const outside = path.join(cwd, "..", "shared", "x.ts");
    (ctx as any).ui.select = async () => "Always allow this folder";
    assert.equal(await call(pi, ctx, "read", { path: outside }), undefined);
    const project = JSON.parse(
      fs.readFileSync(path.join(cwd, ".pi", "settings.json"), "utf8"),
    );
    assert.ok(
      project.workflow.readPolicy.allowedPaths.some((p: string) =>
        p.includes("shared"),
      ),
    );
  } finally {
    await cleanup();
  }
});
