/**
 * Workflow Extension — shared folder floor in the COMMIT gate
 *
 * Run with: npm test   (node --test, type-stripping — no build step)
 *
 * Uses real temp git repos for the staged/`git add .` sensitive scans.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

import workflowExtension from "./index.ts";
import { makeFakeCtx, makeFakePi, tmpProject } from "./test-support.ts";

function git(cwd: string, args: string[]): void {
  const res = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(res.status, 0, `git ${args.join(" ")}: ${res.stderr}`);
}

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

function commitCall(
  pi: ReturnType<typeof makeFakePi>,
  ctx: unknown,
  command: string,
) {
  const handlers = pi.handlers.get("tool_call") ?? [];
  assert.ok(handlers.length > 0);
  return handlers[0](
    { toolName: "bash", toolCallId: "t1", input: { command } },
    ctx,
  );
}

test("commit: git -C outside the folder asks and can be allowed once", async () => {
  const { cwd, pi, ctx, cleanup } = await boot({
    workflow: {
      folderPolicy: { mode: "cwd", outside: "ask" },
      commitPolicy: { mode: "allow" },
    },
  });
  try {
    (ctx as any).ui.select = async () => undefined;
    const denied = await commitCall(pi, ctx, "git -C ../other add x.txt");
    assert.ok(denied && (denied as any).block);

    await pi.emit("turn_start", { turnIndex: 1, timestamp: Date.now() }, ctx);
    (ctx as any).ui.select = async () => "Allow once";
    assert.equal(
      await commitCall(pi, ctx, "git -C ../other add other.txt"),
      undefined,
    );
  } finally {
    await cleanup();
  }
});

test("commit: explicit git add of a sensitive file is blocked", async () => {
  const { cwd, pi, ctx, cleanup } = await boot({
    workflow: {
      folderPolicy: { mode: "cwd", outside: "ask" },
      commitPolicy: { mode: "allow" },
    },
  });
  try {
    const result = await commitCall(pi, ctx, "git add .env");
    assert.ok(result && (result as any).block);
    assert.match(String((result as any).reason), /sensitive/i);
  } finally {
    await cleanup();
  }
});

test("commit: .env.example is not sensitive", async () => {
  const { cwd, pi, ctx, cleanup } = await boot({
    workflow: {
      folderPolicy: { mode: "cwd", outside: "ask" },
      commitPolicy: { mode: "allow" },
    },
  });
  try {
    git(cwd, ["init"]);
    fs.writeFileSync(path.join(cwd, ".env.example"), "X=1\n");
    assert.equal(
      await commitCall(pi, ctx, "git add .env.example"),
      undefined,
    );
  } finally {
    await cleanup();
  }
});

test("commit: git add . blocks when an untracked .env would be added", async () => {
  const { cwd, pi, ctx, cleanup } = await boot({
    workflow: {
      folderPolicy: { mode: "cwd", outside: "ask" },
      commitPolicy: { mode: "allow" },
    },
  });
  try {
    git(cwd, ["init"]);
    fs.writeFileSync(path.join(cwd, ".env"), "SECRET=1\n");
    const result = await commitCall(pi, ctx, "git add .");
    assert.ok(result && (result as any).block);
    assert.match(String((result as any).reason), /sensitive/i);
  } finally {
    await cleanup();
  }
});

test("commit: a staged .env blocks git commit", async () => {
  const { cwd, pi, ctx, cleanup } = await boot({
    workflow: {
      folderPolicy: { mode: "cwd", outside: "ask" },
      commitPolicy: { mode: "allow" },
    },
  });
  try {
    git(cwd, ["init"]);
    git(cwd, ["config", "user.email", "test@example.com"]);
    git(cwd, ["config", "user.name", "Test"]);
    fs.writeFileSync(path.join(cwd, ".env"), "SECRET=1\n");
    // Stage directly (bypassing the extension) to simulate a pre-staged file.
    git(cwd, ["add", "-f", ".env"]);
    const result = await commitCall(pi, ctx, 'git commit -m "x"');
    assert.ok(result && (result as any).block);
    assert.match(String((result as any).reason), /sensitive/i);
  } finally {
    await cleanup();
  }
});

test("commit: unsafe folder grant is refused when the project is untrusted", async () => {
  const { agentDir, pi, ctx, cleanup } = await boot(
    {
      workflow: {
        folderPolicy: { mode: "cwd", outside: "ask", grantScope: "project" },
        commitPolicy: { mode: "allow" },
      },
    },
    false,
  );
  try {
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentDir, "settings.json"),
      JSON.stringify({ workflow: { commitPolicy: { mode: "allow" } } }, null, 2),
      "utf8",
    );
    (ctx as any).ui.select = async () => "Always allow this repository folder";
    const result = await commitCall(pi, ctx, "git -C ../other add x.txt");
    assert.ok(result && (result as any).block);
    assert.match(String((result as any).reason), /trusted|trust/i);
  } finally {
    await cleanup();
  }
});
