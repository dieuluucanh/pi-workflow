/**
 * Workflow Extension — shared folder floor in the WRITE gate
 *
 * Run with: npm test   (node --test, type-stripping — no build step)
 *
 * Drives the real `tool_call` handler: write mode `allow` must not escape the
 * folder scope; sensitive write targets stay blocked inside the folder; the
 * "Always allow" dialog persists a project-scoped write grant; and ordinary
 * in-repo toolchain commands (sed, npm run build, npx, …) must not prompt in
 * Default-allow or Build.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import workflowExtension from "./index.ts";
import { makeFakeCtx, makeFakePi, tmpProject } from "./test-support.ts";

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
  fs.mkdirSync(path.join(cwd, "src"), { recursive: true });
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
  return { cwd, agentDir, pi, ctx, selects, notifies, cleanup };
}

let callSeq = 0;

function toolCall(
  pi: ReturnType<typeof makeFakePi>,
  ctx: unknown,
  toolName: string,
  input: Record<string, unknown>,
) {
  const handlers = pi.handlers.get("tool_call") ?? [];
  assert.ok(handlers.length > 0, "tool_call handler registered");
  // A fresh id makes this call its own batch, so the gate never reuses a
  // previous call's dialog answer.
  return handlers[0](
    { toolName, toolCallId: `t${++callSeq}`, input },
    ctx,
  );
}

/** Enter Build mode and give it the todo list the build guard requires. */
async function enterBuildWithTodo(
  pi: ReturnType<typeof makeFakePi>,
  ctx: unknown,
) {
  const build = pi.commands.build;
  assert.ok(build, "/build command registered");
  await build.handler("", ctx);
  const todo = (pi.tools as any).workflow_todo;
  assert.ok(todo, "workflow_todo tool registered");
  await todo.execute(
    "todo-setup",
    { action: "add", text: "probe step" },
    undefined,
    undefined,
    ctx,
  );
}

const IN_REPO_COMMANDS: Array<[string, string]> = [
  ["sed with file", "sed -n '1,5p' package.json"],
  ["sed without file", "sed -n '900,1100p'"],
  ["npm run build", "npm run build"],
  ["npx vitest", "npx vitest run"],
  ["node script", "node scripts/x.mjs"],
  ["git diff | sed", "git diff | sed -n '1,20p'"],
];

test("write: default folder scope asks outside even with writePolicy allow", async () => {
  const { cwd, pi, ctx, selects, cleanup } = await boot(
    {
      workflow: {
        folderPolicy: { mode: "cwd", outside: "ask" },
        writePolicy: { mode: "allow" },
      },
    },
    { selectAnswers: [undefined, "Allow once (this turn)"] },
  );
  try {
    const outside = path.join(cwd, "..", "outside.txt");
    const blocked = await toolCall(pi, ctx, "write", { path: outside });
    assert.ok(blocked && (blocked as any).block);
    assert.match(String((blocked as any).reason), /folder|outside|permitted/i);
    assert.equal(selects.length, 1);
    assert.match(selects[0]?.title ?? "", /Write policy|Folder policy/);

    const allowed = await toolCall(pi, ctx, "write", {
      path: path.join(cwd, "..", "outside-2.txt"),
    });
    assert.equal(allowed, undefined);
    assert.equal(selects.length, 2);
    assert.ok(
      selects[1]?.options.some((option) =>
        String(option).startsWith("Allow once"),
      ),
      "the second dialog offers Allow once",
    );
  } finally {
    await cleanup();
  }
});

test("write: folderPolicy outside=block refuses outside with writePolicy allow", async () => {
  const { cwd, pi, ctx, selects, cleanup } = await boot({
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
    assert.equal(selects.length, 0, "block must not open a dialog");
  } finally {
    await cleanup();
  }
});

test("write: sensitive target is blocked inside the folder even with allow", async () => {
  const { cwd, pi, ctx, selects, cleanup } = await boot({
    workflow: {
      folderPolicy: { mode: "cwd", outside: "ask" },
      writePolicy: { mode: "allow" },
    },
  });
  try {
    const result = await toolCall(pi, ctx, "write", {
      path: path.join(cwd, ".env"),
    });
    assert.ok(result && (result as any).block);
    assert.match(String((result as any).reason), /sensitive/i);
    assert.equal(selects.length, 0, "a sensitive block must not ask");
  } finally {
    await cleanup();
  }
});

test("write: shell destination outside is gated", async () => {
  const { cwd, pi, ctx, selects, cleanup } = await boot(
    {
      workflow: {
        folderPolicy: { mode: "cwd", outside: "ask" },
        writePolicy: { mode: "allow" },
      },
    },
    { selectAnswer: undefined },
  );
  try {
    const result = await toolCall(pi, ctx, "bash", {
      command: `echo x > "${path.join(cwd, "..", "out.txt").replace(/\\/g, "/")}"`,
    });
    assert.ok(result && (result as any).block);
    assert.equal(selects.length, 1);
  } finally {
    await cleanup();
  }
});

test("write: shell redirection to .env is blocked as sensitive", async () => {
  const { cwd, pi, ctx, selects, cleanup } = await boot({
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
    assert.equal(selects.length, 0);
  } finally {
    await cleanup();
  }
});

test("write: Always allow persists a project-scoped write grant", async () => {
  const { cwd, agentDir, pi, ctx, selects, cleanup } = await boot(
    {
      workflow: {
        folderPolicy: { mode: "cwd", outside: "ask", grantScope: "project" },
        writePolicy: { mode: "allow" },
      },
    },
    { selectAnswer: "Always allow this folder" },
  );
  try {
    const outside = path.join(cwd, "..", "shared", "out.txt");
    const result = await toolCall(pi, ctx, "write", { path: outside });
    assert.equal(result, undefined);
    assert.equal(selects.length, 1, "the dialog was recorded");
    assert.ok(
      selects[0]?.options.some((option) =>
        String(option).startsWith("Always allow this folder"),
      ),
      "an outside folder grant is labelled as a folder",
    );
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

test("write: Always allow persists a top-level folder", async () => {
  const { cwd, pi, ctx, cleanup } = await boot(
    {
      workflow: {
        folderPolicy: { mode: "cwd", outside: "ask", grantScope: "project" },
        writePolicy: { mode: "allow" },
      },
    },
    { selectAnswer: "Always allow this folder" },
  );
  try {
    const target = path.join(path.parse(cwd).root, "pi-grant-probe", "out.txt");
    assert.equal(await toolCall(pi, ctx, "write", { path: target }), undefined);
    const project = JSON.parse(
      fs.readFileSync(path.join(cwd, ".pi", "settings.json"), "utf8"),
    );
    assert.ok(
      project.workflow.writePolicy.allowedPaths.some((p: string) =>
        p.includes("pi-grant-probe"),
      ),
    );
  } finally {
    await cleanup();
  }
});

test("write: a protected root allows once and warns", async () => {
  const { cwd, pi, ctx, notifies, cleanup } = await boot(
    {
      workflow: {
        folderPolicy: { mode: "cwd", outside: "ask", grantScope: "project" },
        writePolicy: { mode: "allow" },
      },
    },
    { selectAnswer: "Always allow this folder" },
  );
  try {
    assert.equal(
      await toolCall(pi, ctx, "write", { path: path.parse(cwd).root }),
      undefined,
    );
    assert.ok(notifies.some((entry) => entry.level === "warning"));
    const project = JSON.parse(
      fs.readFileSync(path.join(cwd, ".pi", "settings.json"), "utf8"),
    );
    assert.deepEqual(project.workflow?.writePolicy?.allowedPaths ?? [], []);
  } finally {
    await cleanup();
  }
});

test("write: a path-less mutating tool follows the write mode, not folder uncertainty", async () => {
  const allowed = await boot({
    workflow: {
      folderPolicy: { mode: "cwd", outside: "ask" },
      writePolicy: { mode: "allow", mutatingTools: ["custom_write"] },
    },
  });
  try {
    const result = await toolCall(allowed.pi, allowed.ctx, "custom_write", {
      blob: "x",
    });
    assert.equal(result, undefined);
    assert.equal(allowed.selects.length, 0);
  } finally {
    await allowed.cleanup();
  }

  const asked = await boot(
    {
      workflow: {
        folderPolicy: { mode: "cwd", outside: "ask" },
        writePolicy: { mode: "ask", mutatingTools: ["custom_write"] },
      },
    },
    { selectAnswer: "Allow once (this turn)" },
  );
  try {
    const result = await toolCall(asked.pi, asked.ctx, "custom_write", {
      blob: "x",
    });
    assert.equal(result, undefined);
    assert.equal(asked.selects.length, 1, "writePolicy ask still covers it");
    assert.match(asked.selects[0]?.title ?? "", /Write policy/);
  } finally {
    await asked.cleanup();
  }
});

test("write: an untrusted project's Always allows once and warns", async () => {
  const { cwd, pi, ctx, notifies, cleanup } = await boot(
    {
      workflow: {
        folderPolicy: { mode: "cwd", outside: "ask", grantScope: "project" },
        writePolicy: { mode: "allow" },
      },
    },
    { projectTrusted: false, selectAnswer: "Always allow this path" },
  );
  try {
    const result = await toolCall(pi, ctx, "write", {
      path: path.join(cwd, "..", "outside.txt"),
    });
    assert.equal(result, undefined, "an approved write must not be denied just because the grant cannot persist");
    assert.ok(notifies.some((entry) => entry.level === "warning"));
    const project = JSON.parse(
      fs.readFileSync(path.join(cwd, ".pi", "settings.json"), "utf8"),
    );
    assert.deepEqual(project.workflow?.writePolicy?.allowedPaths ?? [], []);
  } finally {
    await cleanup();
  }
});

test("write: Build mode allows in-repo toolchain commands without a dialog", async () => {
  const { cwd, pi, ctx, selects, cleanup } = await boot({
    workflow: {
      folderPolicy: { mode: "repo", outside: "ask" },
      writePolicy: { mode: "allow" },
    },
  });
  try {
    await enterBuildWithTodo(pi, ctx);
    const inside = path.join(cwd, "src", "new.ts");
    const cases: Array<[string, string, Record<string, unknown>]> = [
      ...IN_REPO_COMMANDS.map(
        ([label, command]) => [label, "bash", { command }] as const,
      ).map(([label, tool, input]) => [label, tool, input] as [string, string, Record<string, unknown>]),
      ["edit", "edit", { path: inside }],
      ["write", "write", { path: inside, content: "x" }],
    ];
    for (const [label, tool, input] of cases) {
      const before = selects.length;
      const result = await toolCall(pi, ctx, tool, input);
      assert.equal(result, undefined, `${label} must not be blocked`);
      assert.equal(selects.length, before, `${label} must not prompt`);
    }
  } finally {
    await cleanup();
  }
});

test("write: Default + writePolicy allow allows in-repo toolchain commands", async () => {
  const { cwd, pi, ctx, selects, cleanup } = await boot({
    workflow: {
      folderPolicy: { mode: "repo", outside: "ask" },
      writePolicy: { mode: "allow" },
    },
  });
  try {
    const inside = path.join(cwd, "src", "new-default.ts");
    const cases: Array<[string, string, Record<string, unknown>]> = [
      ...IN_REPO_COMMANDS.map(
        ([label, command]) => [label, "bash", { command }] as const,
      ).map(([label, tool, input]) => [label, tool, input] as [string, string, Record<string, unknown>]),
      ["edit", "edit", { path: inside }],
      ["write", "write", { path: inside, content: "x" }],
    ];
    for (const [label, tool, input] of cases) {
      const before = selects.length;
      const result = await toolCall(pi, ctx, tool, input);
      assert.equal(result, undefined, `${label} must not be blocked`);
      assert.equal(selects.length, before, `${label} must not prompt`);
    }
  } finally {
    await cleanup();
  }
});

test("write: folderPolicy any disables the floor's asks", async () => {
  const { cwd, pi, ctx, selects, cleanup } = await boot({
    workflow: {
      folderPolicy: { mode: "any", outside: "ask" },
      writePolicy: { mode: "allow" },
    },
  });
  try {
    for (const [label, command] of IN_REPO_COMMANDS) {
      const before = selects.length;
      const result = await toolCall(pi, ctx, "bash", { command });
      assert.equal(result, undefined, `${label} must not be blocked under any`);
      assert.equal(selects.length, before, `${label} must not prompt under any`);
    }
    const outside = path.join(cwd, "..", "outside-any.txt");
    const result = await toolCall(pi, ctx, "write", {
      path: outside,
      content: "x",
    });
    assert.equal(result, undefined);
    assert.equal(selects.length, 0, "mode any must not ask for an outside write");

    const sensitive = await toolCall(pi, ctx, "write", {
      path: path.join(cwd, ".env"),
      content: "x",
    });
    assert.ok(sensitive && (sensitive as any).block);
    assert.match(String((sensitive as any).reason), /sensitive/i);
  } finally {
    await cleanup();
  }
});

test("write: writePolicy ask still prompts for an in-repo sed", async () => {
  const { pi, ctx, selects, cleanup } = await boot(
    {
      workflow: {
        folderPolicy: { mode: "repo", outside: "ask" },
        writePolicy: { mode: "ask" },
      },
    },
    { selectAnswer: "Allow once (this turn)" },
  );
  try {
    const result = await toolCall(pi, ctx, "bash", {
      command: "sed -n '1,5p' package.json",
    });
    assert.equal(result, undefined);
    assert.equal(selects.length, 1, "ask is the strict opt-in");
    assert.match(selects[0]?.title ?? "", /Write policy/);

    // A verify-class command is not a write and stays free under ask.
    const before = selects.length;
    const test = await toolCall(pi, ctx, "bash", { command: "npm test" });
    assert.equal(test, undefined);
    assert.equal(selects.length, before);
  } finally {
    await cleanup();
  }
});

test("write: Build asks for an outside write with a Folder policy dialog", async () => {
  const { cwd, pi, ctx, selects, cleanup } = await boot(
    {
      workflow: {
        folderPolicy: { mode: "repo", outside: "ask" },
        writePolicy: { mode: "allow" },
      },
    },
    { selectAnswer: undefined },
  );
  try {
    await enterBuildWithTodo(pi, ctx);
    const result = await toolCall(pi, ctx, "write", {
      path: path.join(cwd, "..", "shared", "outside-build.txt"),
      content: "x",
    });
    assert.ok(result && (result as any).block);
    assert.equal(selects.length, 1);
    assert.match(
      selects[0]?.title ?? "",
      /^Folder policy 'ask'/,
      "the dialog is attributed to the folder floor",
    );
    assert.match(selects[0]?.title ?? "", /Outside:/);
    assert.ok(
      selects[0]?.options.some((option) =>
        String(option).startsWith("Always allow this folder"),
      ),
      "an outside grant is labelled as a folder",
    );

    // Sensitive stays blocked inside, even in Build.
    const before = selects.length;
    const sensitive = await toolCall(pi, ctx, "write", {
      path: path.join(cwd, ".env"),
      content: "x",
    });
    assert.ok(sensitive && (sensitive as any).block);
    assert.match(String((sensitive as any).reason), /sensitive/i);
    assert.equal(selects.length, before);
  } finally {
    await cleanup();
  }
});

// ── excludePaths ─────────────────────────────────────────────────────

/** A parent folder that contains the temp project (the "broad root" case). */
function parentOf(cwd: string): string {
  return path.dirname(cwd);
}

test("write: excluded root is refused with no dialog under writePolicy allow", async () => {
  const parentHolder: { parent?: string } = {};
  const probe = await boot({ workflow: { writePolicy: { mode: "allow" } } });
  parentHolder.parent = parentOf(probe.cwd);
  await probe.cleanup();

  const parent = parentHolder.parent;
  const { cwd, pi, ctx, selects, cleanup } = await boot({
    workflow: {
      folderPolicy: {
        mode: "cwd",
        outside: "ask",
        excludePaths: [parent],
      },
      writePolicy: { mode: "allow" },
    },
  });
  try {
    const result = await toolCall(pi, ctx, "bash", {
      command: `rm -rf "${parent}"`,
    });
    assert.ok(result && (result as any).block);
    assert.match(String((result as any).reason), /excluded/i);
    assert.match(String((result as any).reason), /exclude revoke/);
    assert.equal(selects.length, 0);
    // The session folder is strictly inside the exclusion and still works.
    assert.equal(
      await toolCall(pi, ctx, "write", { path: path.join(cwd, "a.ts") }),
      undefined,
    );
    assert.equal(selects.length, 0);
  } finally {
    await cleanup();
  }
});

test("write: a descendant of an excluded folder asks and 'always' rescues it", async () => {
  const parentHolder: { parent?: string } = {};
  const probe = await boot({ workflow: { writePolicy: { mode: "allow" } } });
  parentHolder.parent = parentOf(probe.cwd);
  await probe.cleanup();

  const parent = parentHolder.parent;
  const target = path.join(parent, "sibling", "note.txt");
  const { pi, ctx, selects, cleanup } = await boot(
    {
      workflow: {
        folderPolicy: {
          mode: "cwd",
          outside: "ask",
          excludePaths: [parent],
        },
        writePolicy: { mode: "allow" },
      },
    },
    { selectAnswers: ["Always allow this folder"] },
  );
  try {
    assert.equal(await toolCall(pi, ctx, "write", { path: target }), undefined);
    assert.equal(selects.length, 1);
    assert.match(selects[0]?.title ?? "", /Folder policy/i);
    // Persisted grant sits inside the exclusion → no second prompt.
    assert.equal(await toolCall(pi, ctx, "write", { path: target }), undefined);
    assert.equal(selects.length, 1);
  } finally {
    await cleanup();
  }
});

test("write: outside=block refuses an excluded descendant without a dialog", async () => {
  const probe = await boot({ workflow: { writePolicy: { mode: "allow" } } });
  const parent = parentOf(probe.cwd);
  await probe.cleanup();
  const { pi, ctx, selects, cleanup } = await boot({
    workflow: {
      folderPolicy: { mode: "cwd", outside: "block", excludePaths: [parent] },
      writePolicy: { mode: "allow" },
    },
  });
  try {
    const result = await toolCall(pi, ctx, "write", {
      path: path.join(parent, "sibling", "x.txt"),
    });
    assert.ok(result && (result as any).block);
    assert.equal(selects.length, 0);
  } finally {
    await cleanup();
  }
});

test("write: a grant above the exclusion does not rescue it", async () => {
  const probe = await boot({ workflow: { writePolicy: { mode: "allow" } } });
  const parent = parentOf(probe.cwd);
  const grandparent = parentOf(parent);
  await probe.cleanup();
  const { pi, ctx, selects, cleanup } = await boot({
    workflow: {
      folderPolicy: { mode: "cwd", outside: "ask", excludePaths: [parent] },
      writePolicy: { mode: "allow", allowedPaths: [grandparent] },
    },
  });
  try {
    const result = await toolCall(pi, ctx, "write", {
      path: path.join(parent, "x.txt"),
    });
    assert.ok(result && (result as any).block);
    assert.match(String((result as any).reason), /Folder policy|permitted/i);
    assert.equal(selects.length, 1);
  } finally {
    await cleanup();
  }
});

test("write: shell redirect into an excluded descendant follows the floor", async () => {
  const probe = await boot({ workflow: { writePolicy: { mode: "allow" } } });
  const parent = parentOf(probe.cwd);
  await probe.cleanup();
  const { pi, ctx, selects, cleanup } = await boot(
    {
      workflow: {
        folderPolicy: { mode: "cwd", outside: "ask", excludePaths: [parent] },
        writePolicy: { mode: "allow" },
      },
    },
    { selectAnswers: ["Allow once (this turn)"] },
  );
  try {
    const result = await toolCall(pi, ctx, "bash", {
      command: `echo hi > "${path.join(parent, "x.txt")}"`,
    });
    assert.equal(result, undefined);
    assert.equal(selects.length, 1, "a descendant asks once");
    assert.match(selects[0]?.title ?? "", /Folder policy/i);
  } finally {
    await cleanup();
  }
});

// ── workflow settings are user-owned ─────────────────────────────────

test("settings: write/edit to the project settings file is refused in every mode", async () => {
  const { cwd, pi, ctx, selects, cleanup } = await boot({
    workflow: { writePolicy: { mode: "allow" } },
  });
  try {
    const target = path.join(cwd, ".pi", "settings.json");
    const viaWrite = await toolCall(pi, ctx, "write", {
      path: target,
      content: "{}",
    });
    assert.ok(viaWrite && (viaWrite as any).block);
    assert.match(String((viaWrite as any).reason), /user-owned/i);
    const viaEdit = await toolCall(pi, ctx, "edit", {
      path: target,
      oldText: "a",
      newText: "b",
    });
    assert.ok(viaEdit && (viaEdit as any).block);
    // Build mode does not bypass it either.
    await enterBuildWithTodo(pi, ctx);
    const inBuild = await toolCall(pi, ctx, "write", {
      path: target,
      content: "{}",
    });
    assert.ok(inBuild && (inBuild as any).block);
    assert.match(String((inBuild as any).reason), /user-owned/i);
    assert.equal(selects.length, 0);
  } finally {
    await cleanup();
  }
});

test("settings: shell writes to the global settings file are refused", async () => {
  const { agentDir, pi, ctx, cleanup } = await boot({
    workflow: { writePolicy: { mode: "allow" } },
  });
  try {
    const target = path.join(agentDir, "settings.json");
    const redirect = await toolCall(pi, ctx, "bash", {
      command: `echo '{}' > "${target}"`,
    });
    assert.ok(redirect && (redirect as any).block);
    assert.match(String((redirect as any).reason), /user-owned/i);
    const sedInPlace = await toolCall(pi, ctx, "bash", {
      command: `sed -i 's/a/b/' "${target}"`,
    });
    assert.ok(sedInPlace && (sedInPlace as any).block);
    assert.match(String((sedInPlace as any).reason), /user-owned/i);
  } finally {
    await cleanup();
  }
});

test("settings: ordinary files still work and slash commands still persist", async () => {
  const { cwd, pi, ctx, cleanup } = await boot({
    workflow: { writePolicy: { mode: "allow" } },
  });
  try {
    assert.equal(
      await toolCall(pi, ctx, "write", { path: path.join(cwd, "a.ts"), content: "x" }),
      undefined,
    );
    const readPolicy = pi.commands["read-policy"];
    assert.ok(readPolicy, "/read-policy registered");
    await readPolicy.handler(`allow ${path.join(cwd, "extra")} project`, ctx);
    const raw = JSON.parse(
      fs.readFileSync(path.join(cwd, ".pi", "settings.json"), "utf8"),
    );
    assert.ok(
      raw.workflow.readPolicy.allowedPaths.some((entry: string) =>
        entry.endsWith("extra"),
      ),
      "the slash command bypasses the tool gate",
    );
  } finally {
    await cleanup();
  }
});

// ── /folder-policy exclude ───────────────────────────────────────────

test("cmd: /folder-policy exclude adds, lists and revokes (global by default)", async () => {
  const { cwd, agentDir, pi, ctx, notifies, cleanup } = await boot({
    workflow: { writePolicy: { mode: "allow" } },
  });
  try {
    const cmd = pi.commands["folder-policy"];
    assert.ok(cmd, "/folder-policy registered");
    const target = path.join(cwd, "vendor");
    await cmd.handler(`exclude ${target}`, ctx);
    let raw = JSON.parse(fs.readFileSync(path.join(agentDir, "settings.json"), "utf8"));
    assert.deepEqual(raw.workflow.folderPolicy.excludePaths, [
      target.replace(/\\/g, "/"),
    ]);
    notifies.length = 0;
    await cmd.handler("exclude list", ctx);
    assert.ok(notifies.some((n) => String(n.message).includes(target.replace(/\\/g, "/"))));

    await cmd.handler(`exclude revoke ${target}`, ctx);
    raw = JSON.parse(fs.readFileSync(path.join(agentDir, "settings.json"), "utf8"));
    assert.deepEqual(raw.workflow.folderPolicy.excludePaths, []);
  } finally {
    await cleanup();
  }
});

test("cmd: /folder-policy exclude --project writes the project settings", async () => {
  const { cwd, pi, ctx, cleanup } = await boot({
    workflow: { writePolicy: { mode: "allow" } },
  });
  try {
    const cmd = pi.commands["folder-policy"];
    const target = path.join(cwd, "vendor");
    await cmd.handler(`exclude ${target} --project`, ctx);
    const raw = JSON.parse(
      fs.readFileSync(path.join(cwd, ".pi", "settings.json"), "utf8"),
    );
    assert.deepEqual(raw.workflow.folderPolicy.excludePaths, [
      target.replace(/\\/g, "/"),
    ]);
  } finally {
    await cleanup();
  }
});

test("cmd: a catch-all exclude pattern is refused and changes nothing", async () => {
  const { agentDir, pi, ctx, notifies, cleanup } = await boot({
    workflow: { writePolicy: { mode: "allow" } },
  });
  try {
    const cmd = pi.commands["folder-policy"];
    for (const bad of ["*", "**", "**/*"]) {
      notifies.length = 0;
      await cmd.handler(`exclude ${bad}`, ctx);
      assert.ok(
        notifies.some((n) => n.level === "warning"),
        `expected ${bad} to be refused`,
      );
      assert.ok(
        notifies.some((n) => /Refusing that exclude pattern/.test(n.message)),
      );
    }
    const exists = fs.existsSync(path.join(agentDir, "settings.json"));
    if (exists) {
      const raw = JSON.parse(fs.readFileSync(path.join(agentDir, "settings.json"), "utf8"));
      assert.deepEqual(raw.workflow?.folderPolicy?.excludePaths ?? [], []);
    }
  } finally {
    await cleanup();
  }
});

test("cmd: status warns loudly when the session folder is excluded", async () => {
  const { cwd, pi, ctx, notifies, cleanup } = await boot({
    workflow: { writePolicy: { mode: "allow" } },
  });
  try {
    const cmd = pi.commands["folder-policy"];
    // Install an exclusion that covers the session folder, then ask for status.
    fs.rmSync(path.join(cwd, ".pi", "settings.json"), { force: true });
    fs.writeFileSync(
      path.join(cwd, ".pi", "settings.json"),
      `${JSON.stringify(
        {
          workflow: {
            folderPolicy: { mode: "cwd", outside: "ask", excludePaths: [cwd] },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    notifies.length = 0;
    await cmd.handler("status", ctx);
    const message = notifies.map((n) => String(n.message)).join("\n");
    assert.match(message, /WARNING: the session folder itself is excluded/);
    assert.match(message, /exclude revoke/);
  } finally {
    await cleanup();
  }
});

function readGlobalExcludes(agentDir: string): string[] {
  const fp = path.join(agentDir, "settings.json");
  if (!fs.existsSync(fp)) return [];
  const raw = JSON.parse(fs.readFileSync(fp, "utf8"));
  return raw.workflow?.folderPolicy?.excludePaths ?? [];
}

test("cmd: adding a specific folder is one info block with the active list", async () => {
  const { cwd, agentDir, pi, ctx, notifies, cleanup } = await boot({
    workflow: { writePolicy: { mode: "allow" } },
  });
  try {
    const cmd = pi.commands["folder-policy"];
    notifies.length = 0;
    await cmd.handler("exclude C:/Personal", ctx);
    assert.equal(notifies.length, 1, "one notification, not a list + a result");
    const note = notifies[0]!;
    assert.equal(note.level, "info", "a successful write must not be an error");
    assert.match(note.message, /Excluded \(global\): C:\/Personal/);
    assert.match(note.message, /Active exclusions \(1\)/);
    assert.match(note.message, /settings\.json/);
    assert.doesNotMatch(note.message, /broad root/i);
    assert.doesNotMatch(note.message, /Error/);
    assert.deepEqual(readGlobalExcludes(agentDir), ["C:/Personal"]);

    // The follow-up calls agree with the write.
    notifies.length = 0;
    await cmd.handler("exclude list", ctx);
    assert.match(notifies[0]!.message, /Excluded paths \(1\)/);
    assert.match(notifies[0]!.message, /C:\/Personal/);
    notifies.length = 0;
    await cmd.handler("status", ctx);
    assert.match(notifies[0]!.message, /excluded: 1 rule\(s\)/);
    assert.ok(cwd);
  } finally {
    await cleanup();
  }
});

test("cmd: quoted paths with spaces are stored once, unquoted", async () => {
  const { cwd, agentDir, pi, ctx, notifies, cleanup } = await boot({
    workflow: { writePolicy: { mode: "allow" } },
  });
  try {
    const cmd = pi.commands["folder-policy"];
    const target = path.join(cwd, "My Documents");
    notifies.length = 0;
    await cmd.handler(`exclude "${target}"`, ctx);
    assert.equal(notifies[0]!.level, "info", String(notifies[0]!.message));
    assert.deepEqual(readGlobalExcludes(agentDir), [
      target.replace(/\\/g, "/"),
    ]);
    // An unbalanced quote is refused, not half-applied.
    notifies.length = 0;
    await cmd.handler('exclude "C:/Bare', ctx);
    assert.equal(notifies[0]!.level, "warning");
    assert.match(notifies[0]!.message, /Unbalanced double quote/);
    assert.equal(readGlobalExcludes(agentDir).length, 1);
  } finally {
    await cleanup();
  }
});

test("cmd: a folder named project is a path, and leftover tokens are rejected", async () => {
  const { cwd, pi, ctx, notifies, cleanup } = await boot({
    workflow: { writePolicy: { mode: "allow" } },
  });
  try {
    const cmd = pi.commands["folder-policy"];
    // `project` is a pattern, not a scope switch.
    notifies.length = 0;
    await cmd.handler("exclude add project --global", ctx);
    assert.equal(notifies[0]!.level, "info", String(notifies[0]!.message));
    assert.deepEqual(readGlobalExcludes(path.join(cwd, "..", "agent")), [
      "project",
    ]);
    // A trailing scope word is not silently accepted any more.
    notifies.length = 0;
    await cmd.handler("exclude C:/X project", ctx);
    assert.equal(notifies[0]!.level, "warning");
    assert.match(notifies[0]!.message, /Unexpected argument/);
    const projectSettings = path.join(cwd, ".pi", "settings.json");
    if (fs.existsSync(projectSettings)) {
      const raw = JSON.parse(fs.readFileSync(projectSettings, "utf8"));
      assert.deepEqual(raw.workflow?.folderPolicy?.excludePaths ?? [], []);
    }
    // Both scope flags is a usage error, not a guess.
    notifies.length = 0;
    await cmd.handler("exclude C:/Y --global --project", ctx);
    assert.equal(notifies[0]!.level, "warning");
    assert.match(notifies[0]!.message, /both --global and --project/);
  } finally {
    await cleanup();
  }
});

test("cmd: drive-relative input is repaired and revocable either way", async () => {
  if (process.platform !== "win32") return;
  const { agentDir, pi, ctx, notifies, cleanup } = await boot({
    workflow: { writePolicy: { mode: "allow" } },
  });
  try {
    const cmd = pi.commands["folder-policy"];
    notifies.length = 0;
    await cmd.handler("exclude C:Personal", ctx);
    assert.equal(notifies[0]!.level, "info", String(notifies[0]!.message));
    assert.match(notifies[0]!.message, /normalised from C:Personal/);
    assert.deepEqual(readGlobalExcludes(agentDir), ["C:/Personal"]);
    notifies.length = 0;
    await cmd.handler("exclude revoke c:personal", ctx);
    assert.equal(notifies[0]!.level, "info", String(notifies[0]!.message));
    assert.deepEqual(readGlobalExcludes(agentDir), []);
  } finally {
    await cleanup();
  }
});

test("cmd: a rule covering the session folder names only the blocked capabilities", async () => {
  const { cwd, pi, ctx, notifies, cleanup } = await boot({
    workflow: {
      folderPolicy: { mode: "cwd", outside: "ask" },
      writePolicy: { mode: "allow" },
    },
  });
  try {
    const cmd = pi.commands["folder-policy"];
    notifies.length = 0;
    await cmd.handler(`exclude ${cwd}`, ctx);
    const note = notifies[0]!;
    assert.equal(note.level, "error", String(note.message));
    assert.match(note.message, /Refused at the session folder: read, write, commit/);
    assert.match(note.message, /exclude revoke/);
  } finally {
    await cleanup();
  }
});

test("cmd: a read grant rescues read only; write and commit stay reported", async () => {
  const { cwd, pi, ctx, notifies, cleanup } = await boot({
    workflow: {
      folderPolicy: { mode: "cwd", outside: "ask" },
      writePolicy: { mode: "allow" },
    },
  });
  try {
    // Install the grant now that cwd is known (the gate re-reads per call).
    const settingsPath = path.join(cwd, ".pi", "settings.json");
    const current = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    current.workflow.readPolicy = { allowedPaths: [cwd] };
    fs.writeFileSync(settingsPath, `${JSON.stringify(current, null, 2)}\n`, "utf8");

    const cmd = pi.commands["folder-policy"];
    notifies.length = 0;
    await cmd.handler(`exclude ${cwd}`, ctx);
    const note = notifies[0]!;
    assert.equal(note.level, "error", String(note.message));
    assert.match(note.message, /Refused at the session folder: write, commit/);
    assert.match(note.message, /Still covered by a grant: read \(/);
    assert.doesNotMatch(note.message, /Refused at the session folder: read/);
  } finally {
    await cleanup();
  }
});

test("cmd: full grant coverage downgrades the warning and says so", async () => {
  const { cwd, pi, ctx, notifies, cleanup } = await boot({
    workflow: {
      folderPolicy: { mode: "cwd", outside: "ask" },
      writePolicy: { mode: "allow" },
    },
  });
  try {
    const settingsPath = path.join(cwd, ".pi", "settings.json");
    const current = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    current.workflow.readPolicy = { allowedPaths: [cwd] };
    current.workflow.writePolicy = { mode: "allow", allowedPaths: [cwd] };
    current.workflow.commitPolicy = { mode: "allow", allowedPaths: [cwd] };
    fs.writeFileSync(settingsPath, `${JSON.stringify(current, null, 2)}\n`, "utf8");

    const cmd = pi.commands["folder-policy"];
    notifies.length = 0;
    await cmd.handler(`exclude ${cwd}`, ctx);
    const note = notifies[0]!;
    assert.equal(note.level, "warning", String(note.message));
    assert.match(note.message, /covered by an explicit grant/);
    assert.doesNotMatch(note.message, /Refused at the session folder/);
  } finally {
    await cleanup();
  }
});
