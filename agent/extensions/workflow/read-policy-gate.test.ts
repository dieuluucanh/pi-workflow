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
import * as os from "node:os";
import * as path from "node:path";

import workflowExtension from "./index.ts";
import { makeFakeCtx, makeFakePi, tmpProject } from "./test-support.ts";

// The session temp folder has to be spelled the way the fixture root is
// resolved: on Windows a runner's temp dir can be an 8.3 short path
// (`RUNNER~1`) while the fixture/project root is the long form.
const TEMP_ROOT = fs.realpathSync.native(os.tmpdir());

async function boot(
  settings: Record<string, unknown> = {},
  hasUI = true,
  projectTrusted = true,
  selectAnswer: string | undefined = undefined,
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
  const { ctx, selects, notifies } = makeFakeCtx({
    cwd,
    hasUI,
    projectTrusted,
    selectAnswer,
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
  return { cwd, pi, ctx, selects, notifies, cleanup };
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

test("batch: a 3-call batch is listed once, and turn_start resets it", async () => {
  const { cwd, pi, ctx, selects, cleanup } = await boot();
  try {
    const a = path.join(cwd, "..", "outside-a", "a.ts");
    const b = path.join(cwd, "..", "outside-b", "b.ts");
    const c = path.join(cwd, "..", "outside-c", "c.ts");
    await pi.emit(
      "message_end",
      {
        message: {
          role: "assistant",
          content: [
            { type: "toolCall", id: "t0", name: "read", arguments: { path: a } },
            { type: "toolCall", id: "t1", name: "read", arguments: { path: b } },
            { type: "toolCall", id: "t2", name: "read", arguments: { path: c } },
          ],
        },
      },
      ctx,
    );
    (ctx as any).ui.select = async (title: string, options: unknown[]) => {
      selects.push({ title, options });
      return undefined;
    };
    await call(pi, ctx, "read", { path: a }, "t0");
    assert.equal(selects.length, 1);
    assert.match(selects[0].title, /outside-a/);
    assert.match(selects[0].title, /outside-b/);
    assert.match(selects[0].title, /outside-c/);

    await pi.emit("turn_start", { turnIndex: 1, timestamp: Date.now() }, ctx);
    (ctx as any).ui.select = async (title: string, options: unknown[]) => {
      selects.push({ title, options });
      return undefined;
    };
    const fresh = path.join(cwd, "..", "fresh", "new.ts");
    await call(pi, ctx, "read", { path: fresh }, "t0");
    assert.equal(selects.length, 2);
    assert.match(selects[1].title, /fresh/);
    assert.doesNotMatch(selects[1].title, /outside-a|outside-b|outside-c/);
  } finally {
    await cleanup();
  }
});

test("read: Build mode leaves inside reads free and asks outside", async () => {
  const { cwd, pi, ctx, selects, cleanup } = await boot(
    { workflow: { folderPolicy: { mode: "repo", outside: "ask" } } },
    true,
    true,
    "Allow once (this turn)",
  );
  try {
    const build = pi.commands.build;
    assert.ok(build, "/build command registered");
    await build.handler("", ctx);

    assert.equal(
      await call(pi, ctx, "read", { path: "src/app.ts" }, "build-in"),
      undefined,
    );
    assert.equal(selects.length, 0, "an inside read in Build must not prompt");

    const outside = path.join(cwd, "..", "outside-build.ts");
    assert.equal(
      await call(pi, ctx, "read", { path: outside }, "build-out"),
      undefined,
    );
    assert.equal(selects.length, 1, "an outside read still asks in Build");
    assert.match(selects[0]?.title ?? "", /^Read policy/);
  } finally {
    await cleanup();
  }
});

test("read: strict shell asks for npm test; paths does not", async () => {
  const paths = await boot(
    { workflow: { readPolicy: { shell: "paths" } } },
    true,
    true,
    "Allow once (this turn)",
  );
  try {
    assert.equal(
      await call(paths.pi, paths.ctx, "bash", { command: "npm test" }, "paths-1"),
      undefined,
    );
    assert.equal(
      paths.selects.length,
      0,
      "the default shell mode treats unverifiable commands as a residual",
    );
  } finally {
    await paths.cleanup();
  }

  const strict = await boot(
    { workflow: { readPolicy: { shell: "strict" } } },
    true,
    true,
    "Allow once (this turn)",
  );
  try {
    assert.equal(
      await call(strict.pi, strict.ctx, "bash", { command: "npm test" }, "strict-1"),
      undefined,
    );
    assert.equal(strict.selects.length, 1, "strict is the opt-in ask");
    assert.match(strict.selects[0]?.title ?? "", /^Read policy/);
  } finally {
    await strict.cleanup();
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

test("read: Always allow persists a top-level folder (the reported case)", async () => {
  const { cwd, pi, ctx, cleanup } = await boot(
    {
      workflow: {
        folderPolicy: { mode: "cwd", outside: "ask", grantScope: "project" },
      },
    },
    true,
    true,
    "Always allow this folder",
  );
  try {
    // A drive/file-system top-level folder: depth 1, but neither a root nor
    // home. The old depth<=1 rule refused it as "too broad".
    const target = path.join(path.parse(cwd).root, "pi-grant-probe", "x.ts");
    assert.equal(await call(pi, ctx, "read", { path: target }), undefined);
    const project = JSON.parse(
      fs.readFileSync(path.join(cwd, ".pi", "settings.json"), "utf8"),
    );
    assert.ok(
      project.workflow.readPolicy.allowedPaths.some((p: string) =>
        p.includes("pi-grant-probe"),
      ),
    );
  } finally {
    await cleanup();
  }
});

test("read: a protected root offers no Always and runs once", async () => {
  const { cwd, pi, ctx, selects, cleanup } = await boot(
    {
      workflow: {
        folderPolicy: { mode: "cwd", outside: "ask", grantScope: "project" },
      },
    },
    true,
    true,
    "Allow once (this turn)",
  );
  try {
    assert.equal(await call(pi, ctx, "read", { path: path.parse(cwd).root }), undefined);
    assert.equal(selects.length, 1);
    assert.ok(
      !selects[0]?.options.some((option) =>
        String(option).startsWith("Always allow"),
      ),
      "a filesystem root must not offer a one-click grant",
    );
  } finally {
    await cleanup();
  }
});

test("read: a forced Always on a protected root allows once and warns", async () => {
  const { cwd, pi, ctx, notifies, cleanup } = await boot(
    {
      workflow: {
        folderPolicy: { mode: "cwd", outside: "ask", grantScope: "project" },
      },
    },
    true,
    true,
    "Always allow this folder",
  );
  try {
    assert.equal(await call(pi, ctx, "read", { path: path.parse(cwd).root }), undefined);
    assert.ok(
      notifies.some((entry) => entry.level === "warning"),
      "the refused grant must be reported, not silently persisted",
    );
    const project = JSON.parse(
      fs.readFileSync(path.join(cwd, ".pi", "settings.json"), "utf8"),
    );
    assert.deepEqual(project.workflow?.readPolicy?.allowedPaths ?? [], []);
  } finally {
    await cleanup();
  }
});

test("read: an untrusted project's Always allows once and warns", async () => {
  const { cwd, pi, ctx, notifies, cleanup } = await boot(
    {
      workflow: {
        folderPolicy: { mode: "cwd", outside: "ask", grantScope: "project" },
      },
    },
    true,
    false,
    "Always allow this folder",
  );
  try {
    const target = path.join(cwd, "..", "outside-untrusted", "x.ts");
    assert.equal(await call(pi, ctx, "read", { path: target }), undefined);
    assert.ok(notifies.some((entry) => entry.level === "warning"));
    const project = JSON.parse(
      fs.readFileSync(path.join(cwd, ".pi", "settings.json"), "utf8"),
    );
    assert.deepEqual(project.workflow?.readPolicy?.allowedPaths ?? [], []);
  } finally {
    await cleanup();
  }
});

// ── excludePaths ─────────────────────────────────────────────────────

test("read: a session folder inside a specific rule is fully blocked", async () => {
  const { cwd, pi, ctx, selects, cleanup } = await boot({
    workflow: {
      folderPolicy: {
        mode: "cwd",
        outside: "ask",
        excludePaths: [TEMP_ROOT],
      },
    },
  });
  try {
    // cwd is strictly inside a hard-deny rule: every read is refused.
    const blocked = await call(pi, ctx, "read", { path: path.join(cwd, "a.ts") });
    assert.ok(blocked && (blocked as any).block);
    assert.match(String((blocked as any).reason), /excluded/i);
    assert.match(
      String((blocked as any).reason),
      /folder-policy exclude revoke/,
    );
    assert.equal(selects.length, 0, "an excluded session must never prompt");
  } finally {
    await cleanup();
  }
});

test("read: the excluded folder itself is blocked with no dialog", async () => {
  const probe = await boot();
  const parent = path.dirname(probe.cwd);
  await probe.cleanup();
  const { pi, ctx, selects, cleanup } = await boot({
    workflow: {
      folderPolicy: { mode: "cwd", outside: "ask", excludePaths: [parent] },
    },
  });
  try {
    const blocked = await call(pi, ctx, "ls", { path: parent });
    assert.ok(blocked && (blocked as any).block);
    assert.match(String((blocked as any).reason), /excluded/i);
    assert.match(
      String((blocked as any).reason),
      /folder-policy exclude revoke/,
    );
    assert.equal(selects.length, 0, "an excluded folder must never prompt");
  } finally {
    await cleanup();
  }
});

test("read: a descendant of a specific rule is blocked with no dialog", async () => {
  const probe = await boot();
  const parent = path.dirname(probe.cwd);
  await probe.cleanup();
  const target = path.join(parent, "outside-sibling", "x.ts");
  const { pi, ctx, selects, cleanup } = await boot(
    {
      workflow: {
        folderPolicy: { mode: "cwd", outside: "ask", excludePaths: [parent] },
      },
    },
    true,
    true,
    "Always allow this folder",
  );
  try {
    const blocked = await call(pi, ctx, "read", { path: target });
    assert.ok(blocked && (blocked as any).block);
    assert.match(String((blocked as any).reason), /excluded/i);
    assert.equal(
      selects.length,
      0,
      "a denied subtree never prompts and cannot be granted",
    );
  } finally {
    await cleanup();
  }
});

test("read: outside 'block' refuses an excluded descendant without a dialog", async () => {
  const probe = await boot();
  const parent = path.dirname(probe.cwd);
  await probe.cleanup();
  const { pi, ctx, selects, cleanup } = await boot({
    workflow: {
      folderPolicy: { mode: "cwd", outside: "block", excludePaths: [parent] },
    },
  });
  try {
    const blocked = await call(pi, ctx, "read", {
      path: path.join(parent, "sibling", "x.ts"),
    });
    assert.ok(blocked && (blocked as any).block);
    assert.match(String((blocked as any).reason), /excluded/i);
    assert.equal(selects.length, 0);
  } finally {
    await cleanup();
  }
});

test("read: a broad-root descendant follows the mode", async () => {
  const { cwd, pi, ctx, selects, cleanup } = await boot();
  try {
    const root = path.parse(cwd).root;
    // A `C:/`-style ceiling must not deny a project below it in `any` mode.
    fs.writeFileSync(
      path.join(cwd, ".pi", "settings.json"),
      `${JSON.stringify(
        {
          workflow: {
            folderPolicy: {
              mode: "any",
              outside: "ask",
              excludePaths: [root],
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    assert.equal(
      await call(pi, ctx, "read", {
        path: path.join(cwd, "..", "sibling", "x.ts"),
      }),
      undefined,
    );
    assert.equal(selects.length, 0);
  } finally {
    await cleanup();
  }
});

test("read: a broad root cannot be rescued by a grant", async () => {
  const { cwd, pi, ctx, selects, cleanup } = await boot();
  try {
    const root = path.parse(cwd).root;
    fs.writeFileSync(
      path.join(cwd, ".pi", "settings.json"),
      `${JSON.stringify(
        {
          workflow: {
            folderPolicy: {
              mode: "any",
              outside: "ask",
              excludePaths: [root],
            },
            readPolicy: { allowedPaths: [root] },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    const blocked = await call(pi, ctx, "ls", { path: root });
    assert.ok(blocked && (blocked as any).block);
    assert.match(String((blocked as any).reason), /excluded/i);
    assert.equal(selects.length, 0);
  } finally {
    await cleanup();
  }
});

test("read: sensitive still wins inside a denied subtree", async () => {
  const probe = await boot();
  const parent = path.dirname(probe.cwd);
  await probe.cleanup();
  const { pi, ctx, cleanup } = await boot({
    workflow: {
      folderPolicy: { mode: "cwd", outside: "ask", excludePaths: [parent] },
      readPolicy: { allowedPaths: [parent] },
    },
  });
  try {
    const blocked = await call(pi, ctx, "read", { path: path.join(parent, ".env") });
    assert.ok(blocked && (blocked as any).block);
    assert.match(String((blocked as any).reason), /sensitive/i);
  } finally {
    await cleanup();
  }
});
