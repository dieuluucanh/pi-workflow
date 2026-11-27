/**
 * Extension-level regression tests for the shell hang guard.
 *
 * These drive the REAL workflow extension through the fake Pi host, plus the
 * reviewer's `review_bash` wrapper with an injected shell builder. No provider
 * or real child session is involved.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { Type } from "typebox";

import workflowExtension from "./index.ts";
import { createReviewBashTool } from "./review-tools.ts";
import { createShellGuardRecovery } from "./shell-guard.ts";
import { DEFAULT_FOLDER_POLICY_CONFIG } from "./folder-policy.ts";
import {
  fakeSdk,
  makeFakeCtx,
  makeFakePi,
  submitThenFinish,
  tmpProject,
  REWRITTEN_PLAN,
} from "./test-support.ts";

const INCIDENT_1 = `cd .; python - <<'EOF' 2>/dev/null || true
EOF
grep -n "0016_invoice_dimensions.sql" modules/finance/module.manifest.json`;

const INCIDENT_2 = `python - <<'PY' 2>/dev/null || true
PY
grep -n "INSERT INTO core_documents" modules/finance/0018_invoice_documents.sql`;

async function boot(over: { shellGuard?: Record<string, unknown> } = {}) {
  const { root, cwd, agentDir } = tmpProject();
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
  fs.writeFileSync(
    path.join(cwd, ".pi", "settings.json"),
    JSON.stringify(
      {
        workflow: {
          commitPolicy: { mode: "never" },
          ...(over.shellGuard ? { shellGuard: over.shellGuard } : {}),
        },
      },
      null,
      2,
    ),
  );
  const { sdk } = fakeSdk({ pass1: submitThenFinish(REWRITTEN_PLAN) });
  const pi = makeFakePi();
  await workflowExtension(pi as never, {
    loadSdk: async () => sdk as never,
    plannotatorRequestTimeoutMs: 50,
    plannotatorRecoveryTimeoutMs: 50,
    isTerminalHost: () => true,
  });
  const fake = makeFakeCtx({ cwd, hasUI: true, idle: true });
  await pi.emit("session_start", { reason: "startup" }, fake.ctx);
  const cleanup = () => {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  };
  return { pi, ctx: fake.ctx, fake, cwd, root, cleanup };
}

async function callTool(
  pi: any,
  ctx: any,
  toolName: string,
  toolCallId: string,
  input: Record<string, unknown>,
): Promise<any> {
  const results = await pi.emit(
    "tool_call",
    { type: "tool_call", toolName, toolCallId, input },
    ctx,
  );
  const blocks = results.filter((r: unknown) => r !== undefined);
  return { input, block: blocks.at(-1) };
}

function lastNotice(notifies: Array<{ message: string; level?: string }>) {
  return notifies.at(-1)?.message ?? "";
}

test("guard: both incident commands are refused with an empty-probe reason", async () => {
  const { pi, ctx, cleanup } = await boot();
  try {
    for (const [i, command] of [INCIDENT_1, INCIDENT_2].entries()) {
      const { block } = await callTool(pi, ctx, "bash", `incident-${i}`, {
        command,
      });
      assert.equal(block?.block, true);
      assert.match(String(block?.reason), /empty interpreter probe refused/);
      assert.match(String(block?.reason), /not a syntax error/);
    }
  } finally {
    cleanup();
  }
});

test("guard: an ordinary shell call gets the 120s default, explicit shorter wins", async () => {
  const { pi, ctx, cleanup } = await boot();
  try {
    const plain = await callTool(pi, ctx, "bash", "a", {
      command: "grep -n foo bar.ts",
    });
    assert.equal(plain.block, undefined);
    assert.equal(plain.input.timeout, 120);

    const explicit = await callTool(pi, ctx, "bash", "b", {
      command: "npm test",
      timeout: 30,
    });
    assert.equal(explicit.input.timeout, 30);

    const capped = await callTool(pi, ctx, "bash", "c", {
      command: "npm test",
      timeout: 5_000,
    });
    assert.equal(capped.input.timeout, 900);

    const powershell = await callTool(pi, ctx, "powershell", "d", {
      command: "Get-ChildItem",
    });
    assert.equal(powershell.input.timeout, 120);
  } finally {
    cleanup();
  }
});

test("guard: project settings can tune both limits", async () => {
  const { pi, ctx, cleanup } = await boot({
    shellGuard: { defaultTimeoutSeconds: 45, maxTimeoutSeconds: 120 },
  });
  try {
    const { input } = await callTool(pi, ctx, "bash", "tuned", {
      command: "grep -n foo bar.ts",
    });
    assert.equal(input.timeout, 45);
  } finally {
    cleanup();
  }
});

test("guard: invalid timeout is refused, and a second failure quarantines shell", async () => {
  const { pi, ctx, fake, cleanup } = await boot();
  try {
    const invalid = await callTool(pi, ctx, "bash", "bad", {
      command: "npm test",
      timeout: 0,
    });
    assert.equal(invalid.block?.block, true);
    assert.match(String(invalid.block?.reason), /greater than 0/);

    const stopped = await callTool(pi, ctx, "bash", "next", {
      command: "pnpm test",
      timeout: 0,
    });
    assert.equal(stopped.block?.block, true);
    assert.match(String(stopped.block?.reason), /greater than 0/);
    assert.match(lastNotice(fake.notifies), /quarantined/);
    assert.equal(fake.aborts(), 0);

    const afterTrip = await callTool(pi, ctx, "bash", "after", {
      command: "grep -n foo bar.ts",
    });
    assert.equal(afterTrip.block?.block, true);
    assert.match(String(afterTrip.block?.reason), /shell is quarantined/);
    const nonShell = await callTool(pi, ctx, "workflow_todo", "after-nonshell", {
      action: "list",
    });
    assert.equal(nonShell.block, undefined);
  } finally {
    cleanup();
  }
});

test("guard: a timeout result gets guidance; repeating quarantines without aborting", async () => {
  const { pi, ctx, fake, cleanup } = await boot();
  try {
    const command = "npm test";
    assert.equal(
      (await callTool(pi, ctx, "bash", "t1", { command })).block,
      undefined,
    );

    const first = await pi.emit(
      "tool_result",
      {
        type: "tool_result",
        toolName: "bash",
        toolCallId: "t1",
        isError: true,
        durationMs: 120_000,
        content: [
          { type: "text", text: "partial output\n\nCommand timed out after 120 seconds" },
        ],
      },
      ctx,
    );
    const firstPatch = first.filter((r: any) => r !== undefined).at(-1) as any;
    assert.match(firstPatch.content.at(-1).text, /Do not replay/);
    assert.equal(firstPatch.isError, true);
    assert.equal(fake.aborts(), 0);

    assert.equal(
      (await callTool(pi, ctx, "bash", "t2", { command })).block,
      undefined,
    );
    await pi.emit(
      "tool_result",
      {
        type: "tool_result",
        toolName: "bash",
        toolCallId: "t2",
        isError: true,
        durationMs: 120_000,
        content: [{ type: "text", text: "Command timed out after 120 seconds" }],
      },
      ctx,
    );
    assert.match(lastNotice(fake.notifies), /quarantined/);
    assert.equal(fake.aborts(), 0);
    const nonShell = await callTool(pi, ctx, "read", "after-timeout", {
      path: "README.md",
    });
    assert.equal(nonShell.block, undefined);
  } finally {
    cleanup();
  }
});

test("guard: a user abort is not a qualifying failure", async () => {
  const { pi, ctx, fake, cleanup } = await boot();
  try {
    await callTool(pi, ctx, "bash", "u1", { command: "npm test" });
    await pi.emit(
      "tool_result",
      {
        type: "tool_result",
        toolName: "bash",
        toolCallId: "u1",
        isError: true,
        content: [{ type: "text", text: "Command aborted" }],
      },
      ctx,
    );
    const next = await callTool(pi, ctx, "bash", "u2", {
      command: "grep -n foo bar.ts",
    });
    assert.equal(next.block, undefined);
    assert.equal(fake.aborts(), 0);
  } finally {
    cleanup();
  }
});

test("guard: a new idle user prompt resets; a steer or extension message does not", async () => {
  const { pi, ctx, fake, cleanup } = await boot();
  try {
    await callTool(pi, ctx, "bash", "r1", { command: "false", timeout: 0 });
    await callTool(pi, ctx, "bash", "r2", { command: "false", timeout: 0 });
    assert.match(
      String(
        (await callTool(pi, ctx, "bash", "r3", { command: "grep x f" })).block
          ?.reason,
      ),
      /shell is quarantined/,
    );

    await pi.emit(
      "input",
      { text: "steer", source: "interactive", streamingBehavior: "steer" },
      ctx,
    );
    assert.match(
      String(
        (await callTool(pi, ctx, "bash", "r4", { command: "grep x f" })).block
          ?.reason,
      ),
      /shell is quarantined/,
    );

    await pi.emit(
      "input",
      { text: "new task", source: "extension" },
      ctx,
    );
    assert.match(
      String(
        (await callTool(pi, ctx, "bash", "r5", { command: "grep x f" })).block
          ?.reason,
      ),
      /shell is quarantined/,
    );

    await pi.emit("input", { text: "new task", source: "interactive" }, ctx);
    const fresh = await callTool(pi, ctx, "bash", "r6", {
      command: "grep x f",
    });
    assert.equal(fresh.block, undefined);
    assert.equal(fresh.input.timeout, 120);
    assert.equal(fake.aborts(), 0);
  } finally {
    cleanup();
  }
});

test("guard: an inherited quarantine env blocks shell after session reset", async () => {
  const previous = process.env.PI_SHELL_GUARD_QUARANTINED;
  process.env.PI_SHELL_GUARD_QUARANTINED = "1";
  const { pi, ctx, cleanup } = await boot();
  try {
    const blocked = await callTool(pi, ctx, "bash", "inherited", {
      command: "grep -n foo bar.ts",
    });
    assert.equal(blocked.block?.block, true);
    assert.match(String(blocked.block?.reason), /inherited from the parent/);
    assert.match(String(blocked.block?.reason), /non-shell tools/);
  } finally {
    cleanup();
    if (previous === undefined) delete process.env.PI_SHELL_GUARD_QUARANTINED;
    else process.env.PI_SHELL_GUARD_QUARANTINED = previous;
  }
});

test("guard: /shell-guard status reports limits and the request budget", async () => {
  const { pi, ctx, fake, cleanup } = await boot();
  try {
    await pi.commands["shell-guard"].handler("status", ctx);
    const status = lastNotice(fake.notifies);
    assert.match(status, /120s default/);
    assert.match(status, /900s maximum/);
    assert.match(status, /covers: bash, powershell, explorer shells, review_bash/);
  } finally {
    cleanup();
  }
});

test("guard: a structured exit code overrides fixture timeout text", async () => {
  const { pi, ctx, fake, cleanup } = await boot();
  try {
    await callTool(pi, ctx, "bash", "structured", { command: "npm test" });
    await pi.emit(
      "tool_result",
      {
        type: "tool_result",
        toolName: "bash",
        toolCallId: "structured",
        isError: true,
        structuredContent: { exit_code: 1 },
        content: [
          {
            type: "text",
            text: "fixture output: Command timed out after 120 seconds\n\nCommand exited with code 1",
          },
        ],
      },
      ctx,
    );
    const next = await callTool(pi, ctx, "bash", "after-structured", {
      command: "grep -n foo bar.ts",
    });
    assert.equal(next.block, undefined);
    assert.equal(fake.aborts(), 0);
  } finally {
    cleanup();
  }
});

test("review_bash: a thrown timeout is observed by the reviewer guard", async () => {
  const state = createShellGuardRecovery();
  let trips = 0;
  const builder = () => ({
    parameters: Type.Object({ command: Type.String(), timeout: Type.Optional(Type.Number()) }),
    async execute() {
      throw new Error("Command timed out after 120 seconds");
    },
  });
  const tool = createReviewBashTool(builder as never, {
    cwd: process.cwd(),
    log: () => {},
    folderPolicy: () => ({
      config: DEFAULT_FOLDER_POLICY_CONFIG,
      grants: [],
    }),
    shellGuard: () => ({
      limits: { defaultTimeoutSeconds: 120, maxTimeoutSeconds: 900 },
      state,
      onTrip: () => {
        trips += 1;
      },
    }),
  });

  const first = await tool.execute(
    "1",
    { command: "npm test" },
    new AbortController().signal,
    undefined,
    {},
  );
  assert.equal((first as any).isError, true);
  assert.equal(trips, 0);
  const second = await tool.execute(
    "2",
    { command: "npm test" },
    new AbortController().signal,
    undefined,
    {},
  );
  assert.equal((second as any).isError, true);
  assert.equal(trips, 1);
  const secondText = (second as any).content
    .map((part: any) => (part?.type === "text" ? String(part.text) : ""))
    .join("\n");
  assert.match(secondText, /quarantined/);
});

test("review_bash: the isolated reviewer gets a finite timeout and the probe guard", async () => {
  const seen: Array<Record<string, unknown>> = [];
  const builder = (_cwd: string) => ({
    parameters: Type.Object({ command: Type.String(), timeout: Type.Optional(Type.Number()) }),
    async execute(_id: string, params: any) {
      seen.push({ ...params });
      return { content: [{ type: "text", text: "ok" }], details: {} };
    },
  });
  const state = createShellGuardRecovery();
  const tool = createReviewBashTool(builder as never, {
    cwd: process.cwd(),
    log: () => {},
    folderPolicy: () => ({
      config: DEFAULT_FOLDER_POLICY_CONFIG,
      grants: [],
    }),
    shellGuard: () => ({
      limits: { defaultTimeoutSeconds: 120, maxTimeoutSeconds: 900 },
      state,
    }),
  });

  const empty = await tool.execute(
    "1",
    { command: "python - <<'PY'\nPY\n" },
    new AbortController().signal,
    undefined,
    {},
  );
  // The reviewer's role policy refuses every heredoc before the shell guard
  // sees it; that refusal must stay authoritative.
  assert.equal((empty as any).isError, true);
  assert.match((empty as any).content[0].text, /heredoc/);
  assert.equal(seen.length, 0);

  const invalid = await tool.execute(
    "2",
    { command: "npm test", timeout: 0 },
    new AbortController().signal,
    undefined,
    {},
  );
  assert.equal((invalid as any).isError, true);
  assert.match((invalid as any).content[0].text, /greater than 0/);
  assert.equal(seen.length, 0);

  await tool.execute(
    "3",
    { command: "grep -n foo bar.ts" },
    new AbortController().signal,
    undefined,
    {},
  );
  assert.equal(seen[0]?.timeout, 120);
});

test("review_bash: safe sed and npx delegate; sed -i is refused", async () => {
  const delegated: Array<{ toolCallId: string; command: string }> = [];
  const builder = (_cwd: string) => ({
    parameters: Type.Object({ command: Type.String(), timeout: Type.Optional(Type.Number()) }),
    async execute(toolCallId: string, params: { command: string }) {
      delegated.push({ toolCallId, command: params.command });
      return { content: [{ type: "text" as const, text: "ok" }] };
    },
  });
  const state = createShellGuardRecovery();
  const tool = createReviewBashTool(builder as never, {
    cwd: process.cwd(),
    log: () => {},
    folderPolicy: () => ({
      config: DEFAULT_FOLDER_POLICY_CONFIG,
      grants: [],
    }),
    shellGuard: () => ({
      limits: { defaultTimeoutSeconds: 120, maxTimeoutSeconds: 900 },
      state,
    }),
  });

  const execute = (toolCallId: string, command: string) =>
    tool.execute(
      toolCallId,
      { command },
      new AbortController().signal,
      undefined,
      {},
    );
  const textOf = (result: any) =>
    result.content
      .map((part: any) => (part?.type === "text" ? String(part.text) : ""))
      .join("\n");

  for (const [id, command] of [
    ["sed", "sed -n '1,5p' package.json"],
    ["npx", "npx vitest run"],
  ] as const) {
    const result = await execute(id, command);
    assert.notEqual((result as any).isError, true);
    assert.doesNotMatch(textOf(result), /review_bash: REFUSED/);
    assert.deepEqual(delegated.at(-1), { toolCallId: id, command });
  }
  assert.equal(delegated.length, 2);

  const refused = await execute("sed-in-place", "sed -i 's/a/b/' package.json");
  assert.equal((refused as any).isError, true);
  assert.match(textOf(refused), /review_bash: REFUSED/);
  assert.equal(delegated.length, 2);
});

test("review_bash: a quarantined reviewer does not spawn another shell", async () => {
  const seen: Array<Record<string, unknown>> = [];
  const builder = (_cwd: string) => ({
    parameters: Type.Object({ command: Type.String(), timeout: Type.Optional(Type.Number()) }),
    async execute(_id: string, params: any) {
      seen.push({ ...params });
      return { content: [{ type: "text", text: "ok" }], details: {} };
    },
  });
  const state = createShellGuardRecovery();
  state.recordFailure({ kind: "timeout", command: "npm test" });
  state.recordFailure({ kind: "timeout", command: "npm test" });
  const tool = createReviewBashTool(builder as never, {
    cwd: process.cwd(),
    log: () => {},
    folderPolicy: () => ({
      config: DEFAULT_FOLDER_POLICY_CONFIG,
      grants: [],
    }),
    shellGuard: () => ({
      limits: { defaultTimeoutSeconds: 120, maxTimeoutSeconds: 900 },
      state,
    }),
  });
  const result = await tool.execute(
    "1",
    { command: "grep -n foo bar.ts" },
    new AbortController().signal,
    undefined,
    {},
  );
  assert.equal((result as any).isError, true);
  assert.match(String((result as any).content[0].text), /quarantined/);
  assert.equal(seen.length, 0);
});
