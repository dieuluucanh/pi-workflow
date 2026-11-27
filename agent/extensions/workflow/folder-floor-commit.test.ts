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

interface BootOptions {
  projectTrusted?: boolean;
  selectAnswer?: string;
  selectAnswers?: Array<string | undefined>;
}

async function boot(
  settings: Record<string, unknown>,
  options: BootOptions = {},
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
    hasUI: true,
    projectTrusted: options.projectTrusted !== false,
    selectAnswer: options.selectAnswer,
    selectAnswers: options.selectAnswers,
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
  return { root, cwd, agentDir, pi, ctx, selects, notifies, cleanup };
}

let callSeq = 0;

function commitCall(
  pi: ReturnType<typeof makeFakePi>,
  ctx: unknown,
  command: string,
) {
  const handlers = pi.handlers.get("tool_call") ?? [];
  assert.ok(handlers.length > 0);
  return handlers[0](
    { toolName: "bash", toolCallId: `t${++callSeq}`, input: { command } },
    ctx,
  );
}

test("commit: a repository inside the folder is not gated", async () => {
  const { cwd, pi, ctx, selects, cleanup } = await boot({
    workflow: {
      folderPolicy: { mode: "cwd", outside: "ask" },
      commitPolicy: { mode: "allow" },
    },
  });
  try {
    git(cwd, ["init"]);
    git(cwd, ["config", "user.email", "test@example.com"]);
    git(cwd, ["config", "user.name", "Test"]);
    fs.writeFileSync(path.join(cwd, "a.txt"), "a\n");
    git(cwd, ["add", "-A"]);
    git(cwd, ["commit", "-qm", "init"]);

    const result = await commitCall(pi, ctx, "git commit -m x");
    assert.equal(result, undefined);
    assert.equal(selects.length, 0, "inside commits do not ask");
  } finally {
    await cleanup();
  }
});

test("commit: git -C outside the folder asks and is attributed to the folder policy", async () => {
  const { pi, ctx, selects, cleanup } = await boot(
    {
      workflow: {
        folderPolicy: { mode: "cwd", outside: "ask" },
        commitPolicy: { mode: "allow" },
      },
    },
    { selectAnswers: [undefined, "Allow once", "Allow once"] },
  );
  try {
    const denied = await commitCall(pi, ctx, "git -C ../other add x.txt");
    assert.ok(denied && (denied as any).block);
    assert.match(String((denied as any).reason), /^Folder policy 'ask'/);
    assert.equal(selects.length, 1);
    assert.match(selects[0]?.title ?? "", /^Folder policy 'ask'/);
    assert.match(selects[0]?.title ?? "", /Outside:/);

    const allowed = await commitCall(pi, ctx, "git -C ../other add other.txt");
    assert.equal(allowed, undefined);
    // The commit gate asks for the outside repo, then the read gate asks for
    // the repository path it reads. Each answer covers one turn.
    assert.equal(selects.length, 3);
    assert.match(selects[1]?.title ?? "", /^Folder policy 'ask'/);
    assert.match(selects[2]?.title ?? "", /^Read policy/);
  } finally {
    await cleanup();
  }
});

test("commit: outside=block refuses an outside repo without a dialog", async () => {
  const { pi, ctx, selects, cleanup } = await boot({
    workflow: {
      folderPolicy: { mode: "cwd", outside: "block" },
      commitPolicy: { mode: "allow" },
    },
  });
  try {
    const result = await commitCall(pi, ctx, "git -C ../other add x.txt");
    assert.ok(result && (result as any).block);
    assert.match(String((result as any).reason), /^Folder policy is 'block'/);
    assert.match(String((result as any).reason), /outside the permitted folders/);
    assert.equal(selects.length, 0, "block must not open a dialog");
  } finally {
    await cleanup();
  }
});

test("commit: outside=block refuses an unverifiable root without a dialog", async () => {
  const { cwd, pi, ctx, selects, cleanup } = await boot({
    workflow: {
      folderPolicy: { mode: "cwd", outside: "block" },
      commitPolicy: { mode: "allow" },
    },
  });
  try {
    // A directory inside the base that is not a git repo anywhere above it:
    // `git rev-parse --show-toplevel` fails, detectRepoRoot falls through, so
    // the repo root is unverifiable rather than outside.
    fs.mkdirSync(path.join(cwd, "not-a-repo"));
    const result = await commitCall(pi, ctx, "git -C not-a-repo add x.txt");
    assert.ok(result && (result as any).block);
    assert.match(String((result as any).reason), /^Folder policy is 'block'/);
    assert.match(String((result as any).reason), /could not be verified/);
    assert.equal(selects.length, 0, "block must not open a dialog");
  } finally {
    await cleanup();
  }
});

test("commit: a missing git binary fails closed with an explicit reason", async () => {
  const { cwd, pi, ctx, selects, cleanup } = await boot({
    workflow: {
      folderPolicy: { mode: "cwd", outside: "ask" },
      commitPolicy: { mode: "allow" },
    },
  });
  const previous = process.env.PI_GIT_BIN;
  try {
    git(cwd, ["init"]);
    git(cwd, ["config", "user.email", "test@example.com"]);
    git(cwd, ["config", "user.name", "Test"]);
    fs.writeFileSync(path.join(cwd, "a.txt"), "a\n");
    git(cwd, ["add", "-A"]);
    git(cwd, ["commit", "-qm", "init"]);

    process.env.PI_GIT_BIN = path.join(cwd, "missing-git-binary");
    const result = await commitCall(pi, ctx, "git commit -m x");
    assert.ok(result && (result as any).block);
    assert.match(String((result as any).reason), /git executable not found/);
    assert.match(String((result as any).reason), /PI_GIT_BIN/);
    assert.doesNotMatch(String((result as any).reason), /\bENOENT\b/);
    assert.equal(selects.length, 0, "a missing git must not open a dialog");
  } finally {
    if (previous === undefined) delete process.env.PI_GIT_BIN;
    else process.env.PI_GIT_BIN = previous;
    await cleanup();
  }
});

test("commit: explicit git add of a sensitive file is blocked", async () => {
  const { pi, ctx, cleanup } = await boot({
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

test("commit: an untrusted project's Always allows once and warns", async () => {
  const { agentDir, pi, ctx, notifies, cleanup } = await boot(
    {
      workflow: {
        folderPolicy: { mode: "cwd", outside: "ask", grantScope: "project" },
        commitPolicy: { mode: "allow" },
      },
    },
    {
      projectTrusted: false,
      selectAnswer: "Always allow this repository folder",
    },
  );
  try {
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentDir, "settings.json"),
      JSON.stringify({ workflow: { commitPolicy: { mode: "allow" } } }, null, 2),
      "utf8",
    );
    const result = await commitCall(pi, ctx, "git -C ../other add x.txt");
    assert.equal(
      result,
      undefined,
      "an approved commit must not be denied just because the grant cannot persist",
    );
    assert.ok(notifies.some((entry) => entry.level === "warning"));
    const project = JSON.parse(
      fs.readFileSync(path.join(ctx.cwd, ".pi", "settings.json"), "utf8"),
    );
    assert.deepEqual(project.workflow?.commitPolicy?.allowedPaths ?? [], []);
  } finally {
    await cleanup();
  }
});

// ── excludePaths ─────────────────────────────────────────────────────

test("commit: a repository that IS an excluded folder is refused without a dialog", async () => {
  const { cwd, pi, ctx, selects, cleanup } = await boot({
    workflow: {
      folderPolicy: { mode: "cwd", outside: "ask" },
      commitPolicy: { mode: "allow" },
    },
  });
  try {
    git(cwd, ["init"]);
    git(cwd, ["config", "user.email", "test@example.com"]);
    git(cwd, ["config", "user.name", "Test"]);
    fs.writeFileSync(path.join(cwd, "a.txt"), "a\n");
    git(cwd, ["add", "-A"]);
    // The gate re-reads settings on every call, so the exclusion can be
    // installed with the now-known cwd (repo root == excluded root).
    fs.writeFileSync(
      path.join(cwd, ".pi", "settings.json"),
      `${JSON.stringify(
        {
          workflow: {
            folderPolicy: {
              mode: "cwd",
              outside: "ask",
              excludePaths: [cwd],
            },
            commitPolicy: { mode: "allow" },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    const result = await commitCall(pi, ctx, "git commit -m x");
    assert.ok(result && (result as any).block);
    assert.match(String((result as any).reason), /excluded/i);
    assert.match(String((result as any).reason), /exclude revoke/);
    assert.equal(selects.length, 0, "an excluded repository must not prompt");
  } finally {
    await cleanup();
  }
});

test("commit: a repository strictly inside a specific rule is refused", async () => {
  const { cwd, pi, ctx, selects, cleanup } = await boot({
    workflow: {
      folderPolicy: { mode: "cwd", outside: "ask" },
      commitPolicy: { mode: "allow" },
    },
  });
  try {
    git(cwd, ["init"]);
    git(cwd, ["config", "user.email", "test@example.com"]);
    git(cwd, ["config", "user.name", "Test"]);
    fs.writeFileSync(path.join(cwd, "a.txt"), "a\n");
    git(cwd, ["add", "-A"]);
    // The gate re-reads settings on every call: the repo root is now strictly
    // inside the rule.
    fs.writeFileSync(
      path.join(cwd, ".pi", "settings.json"),
      `${JSON.stringify(
        {
          workflow: {
            folderPolicy: {
              mode: "cwd",
              outside: "ask",
              excludePaths: [path.dirname(cwd)],
            },
            commitPolicy: { mode: "allow" },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    const result = await commitCall(pi, ctx, "git commit -m x");
    assert.ok(result && (result as any).block);
    assert.match(String((result as any).reason), /excluded/i);
    assert.match(String((result as any).reason), /exclude revoke/);
    assert.equal(selects.length, 0, "a denied repository must not prompt");
  } finally {
    await cleanup();
  }
});

test("commit: a staged path inside an excluded folder is refused under outside=block", async () => {
  const { cwd, pi, ctx, selects, cleanup } = await boot({
    workflow: {
      folderPolicy: {
        mode: "cwd",
        outside: "block",
        excludePaths: [path.join(".", "excluded-dir")],
      },
      commitPolicy: { mode: "allow" },
    },
  });
  try {
    git(cwd, ["init"]);
    git(cwd, ["config", "user.email", "test@example.com"]);
    git(cwd, ["config", "user.name", "Test"]);
    fs.mkdirSync(path.join(cwd, "excluded-dir"), { recursive: true });
    fs.writeFileSync(path.join(cwd, "excluded-dir", "a.txt"), "a\n");
    fs.writeFileSync(path.join(cwd, "b.txt"), "b\n");
    git(cwd, ["add", "b.txt", "excluded-dir/a.txt"]);
    const result = await commitCall(pi, ctx, "git commit -m x");
    assert.ok(result && (result as any).block);
    assert.match(String((result as any).reason), /excluded/i);
    assert.match(String((result as any).reason), /exclude revoke/);
    assert.equal(selects.length, 0);
  } finally {
    await cleanup();
  }
});

test("commit: a staged path in a specific rule is refused with no dialog", async () => {
  const { cwd, pi, ctx, selects, cleanup } = await boot(
    {
      workflow: {
        folderPolicy: {
          mode: "cwd",
          outside: "ask",
          excludePaths: [path.join(".", "excluded-dir")],
        },
        commitPolicy: { mode: "allow" },
      },
    },
    { selectAnswers: ["Always allow this repository folder", "Deny"] },
  );
  try {
    git(cwd, ["init"]);
    git(cwd, ["config", "user.email", "test@example.com"]);
    git(cwd, ["config", "user.name", "Test"]);
    fs.mkdirSync(path.join(cwd, "excluded-dir"), { recursive: true });
    fs.writeFileSync(path.join(cwd, "excluded-dir", "a.txt"), "a\n");
    fs.writeFileSync(path.join(cwd, "b.txt"), "b\n");
    git(cwd, ["add", "b.txt", "excluded-dir/a.txt"]);
    const result = await commitCall(pi, ctx, "git commit -m x");
    assert.ok(result && (result as any).block);
    assert.match(String((result as any).reason), /excluded/i);
    assert.match(String((result as any).reason), /exclude revoke/);
    assert.equal(selects.length, 0, "a denied staged path must not prompt");
  } finally {
    await cleanup();
  }
});

test("commit: a broad root leaves an outside repo as an ordinary folder ask", async () => {
  const { cwd, pi, ctx, selects, cleanup } = await boot({
    workflow: {
      folderPolicy: { mode: "cwd", outside: "ask" },
      commitPolicy: { mode: "allow" },
    },
  });
  try {
    fs.writeFileSync(
      path.join(cwd, ".pi", "settings.json"),
      `${JSON.stringify(
        {
          workflow: {
            folderPolicy: {
              mode: "cwd",
              outside: "ask",
              excludePaths: [path.parse(cwd).root],
            },
            commitPolicy: { mode: "allow" },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    const result = await commitCall(pi, ctx, "git -C ../other add x.txt");
    assert.ok(result && (result as any).block);
    assert.match(String((result as any).reason), /^Folder policy 'ask'/);
    assert.doesNotMatch(String((result as any).reason), /excluded/i);
    assert.equal(selects.length, 1);
  } finally {
    await cleanup();
  }
});
