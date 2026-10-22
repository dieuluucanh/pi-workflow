/**
 * Consolidated verification of the write policy's end-to-end behaviour,
 * driven through the REAL tool_call handler and the REAL settings.json.
 *
 *   node --experimental-transform-types scripts/verify-write-policy.mjs
 *
 * ⚠️  This script temporarily WRITES the user's global settings.json
 *     (~/.pi/agent/settings.json) to exercise the allow/ask/never modes and
 *     the "always allow" grant. The original file is restored in a `finally`
 *     block, but do not run it while another Pi session is writing settings.
 *
 * It is the scriptable form of the manual smoke test: every check drives the
 * same code path a real tool call takes, so it verifies the GATE, not a mock
 * of it. The one thing it cannot verify is how the real TUI renders the
 * dialog — do that by hand once.
 */
import * as fs from "node:fs";
import * as path from "node:path";

const SETTINGS = path.join(
  process.env.HOME ?? process.env.USERPROFILE,
  ".pi",
  "agent",
  "settings.json",
);

const results = [];
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  results.push({ name, ok, actual, expected });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) {
    console.log(`        actual   ${JSON.stringify(actual)}`);
    console.log(`        expected ${JSON.stringify(expected)}`);
  }
}

const mod = await import("../index.ts");
const { WRITE_DENY_WITH_INSTRUCTIONS_LABEL } = await import("../edit-policy.ts");
const handlers = {};
const cmds = {};
let dialogs = 0;
let inputDialogs = 0;
let lastOptions = [];
const notifies = [];
/** Every pi.sendUserMessage() call the extension made. */
const sent = [];
/** Every pi.appendEntry() call the extension made. */
const entries = [];

const pi = {
  on: (e, h) => {
    handlers[e] = h;
  },
  registerCommand: (n, o) => (cmds[n] = o),
  registerTool: () => {},
  appendEntry: (type, data) => entries.push({ type, data }),
  getActiveTools: () => ["read", "bash", "edit", "write"],
  setActiveTools: () => {},
  getAllTools: () => [],
  getSettings: () => ({}),
  sendMessage: () => {},
  sendUserMessage: (content, options) => sent.push({ content, options }),
  registerToolRenderer: () => {},
  registerShortcut: () => {},
  registerFlag: () => {},
  registerEntryRenderer: () => {},
  registerMessageRenderer: () => {},
  registerMarkdownTransformer: () => {},
  events: { on: () => {}, emit: () => {} },
};
await mod.default(pi);

/**
 * A TUI-like context. `answer` is what the select dialog returns;
 * `instruction` is what the free-text dialog returns (undefined = cancelled).
 */
const makeCtx = (answer, instruction) => ({
  cwd: process.cwd(),
  mode: "tui",
  hasUI: true,
  ui: {
    select: async (title, options) => {
      dialogs++;
      void title;
      lastOptions = options ?? [];
      return answer;
    },
    input: async (title, placeholder) => {
      inputDialogs++;
      void title;
      void placeholder;
      return instruction;
    },
    notify: (m) => notifies.push(m),
    setStatus: () => {},
    setWidget: () => {},
    theme: { fg: (_c, t) => t },
  },
});
const h = handlers["tool_call"];
/** The raw tool_call invocation — what pi's agent loop does per call. */
const rawCall = (ctx, toolName, input, toolCallId) =>
  h({ toolName, toolCallId: toolCallId ?? "t" + Math.random(), input }, ctx);

/** The real option labels of the ask dialog. */
const ALLOW_ONCE = "Allow once (this turn)";
const ALWAYS_PATH = "Always allow this path";
const ALWAYS_COMMAND = "Always allow this command";

/**
 * Simulate ONE assistant turn, the way pi runs it: the turn starts, the
 * assistant message is sealed (message_end) and then the batch's tool calls
 * are PREPARED one by one — every call of the batch is gated before the
 * first tool of the batch runs (pi-agent-core: executeToolCallsParallel →
 * prepareToolCall → beforeToolCall). The gate must therefore ask ONCE for
 * the whole turn.
 */
const turn = async (ctx, calls) => {
  await handlers["turn_start"]?.({
    type: "turn_start",
    turnIndex: 0,
    timestamp: Date.now(),
  });
  await handlers["message_end"]?.({
    type: "message_end",
    message: {
      role: "assistant",
      content: calls.map((c, i) => ({
        type: "toolCall",
        id: `t${i}`,
        name: c.toolName,
        arguments: c.input,
      })),
    },
  });
  const results = [];
  for (const [i, c] of calls.entries()) {
    results.push(await rawCall(ctx, c.toolName, c.input, `t${i}`));
  }
  return results;
};

/**
 * One assistant turn with a single tool call — what every scenario below
 * models unless it says otherwise.
 */
const call = async (ctx, toolName, input) => {
  const results = await turn(ctx, [{ toolName, input }]);
  return results[0];
};

/** End the agent run — the lifetime of a remembered denial. */
const settle = async () => {
  await handlers["agent_settled"]?.({ type: "agent_settled" });
};

const backup = fs.readFileSync(SETTINGS, "utf8");
const restore = () => fs.writeFileSync(SETTINGS, backup, "utf8");

try {
  // ── Scenario 1: ask mode prompts on a write, and honours the answer ──
  await cmds["write-policy"].handler("ask", makeCtx(ALLOW_ONCE));
  dialogs = 0;
  let r = await call(makeCtx(ALLOW_ONCE), "edit", { path: "a.ts" });
  check("1a ask mode prompts on an edit", dialogs, 1);
  check("1b 'Allow once' permits the write", r === undefined, true);

  dialogs = 0;
  r = await call(makeCtx("Deny"), "edit", { path: "a.ts" });
  check("1c 'Deny' blocks the write", r?.block, true);
  check("1d deny reason tells the model not to retry", /Do not retry/.test(r?.reason ?? ""), true);

  // ── Scenario 2: "always allow this path" persists and stops asking ──
  dialogs = 0;
  r = await call(makeCtx(ALWAYS_PATH), "edit", { path: "b.ts" });
  check("2a 'Always allow this path' permits the write", r === undefined, true);
  const persisted = JSON.parse(fs.readFileSync(SETTINGS, "utf8")).workflow.writePolicy;
  // The script runs against the user's REAL settings.json, so it may already
  // hold grants of their own — assert the grant is PRESENT, not the count.
  check(
    "2b the path was persisted",
    persisted.allowedPaths.filter((p) => p.includes("b.ts")).length,
    1,
  );
  dialogs = 0;
  r = await call(makeCtx("Deny"), "edit", { path: "b.ts" });
  check("2c the same path no longer prompts", dialogs, 0);
  check("2d the granted path is allowed", r === undefined, true);

  // ── Scenario 3: mutating bash prompts; read-only bash does not ──
  dialogs = 0;
  r = await call(makeCtx("Deny"), "bash", { command: "rm -rf tmpdir" });
  check("3a mutating bash prompts", dialogs, 1);
  check("3b mutating bash can be denied", r?.block, true);
  dialogs = 0;
  r = await call(makeCtx("Deny"), "bash", { command: "ls -la" });
  check("3c read-only bash does not prompt", dialogs, 0);
  check("3d read-only bash is allowed", r === undefined, true);
  // A mutating command can be granted permanently too.
  dialogs = 0;
  r = await call(makeCtx(ALWAYS_COMMAND), "bash", { command: "rm -rf otherdir" });
  check("3e a mutating command can be granted", r === undefined, true);
  const persistedCmd = JSON.parse(fs.readFileSync(SETTINGS, "utf8"))
    .workflow.writePolicy;
  check(
    "3f the command grant was persisted",
    persistedCmd.allowedCommands.filter((c) => c.includes("rm -rf otherdir"))
      .length,
    1,
  );
  dialogs = 0;
  await call(makeCtx("Deny"), "bash", { command: "rm -rf otherdir" });
  check("3g a granted command no longer prompts", dialogs, 0);

  // ── Scenario 4: /build is the escape hatch; /plan keeps its own rules ──
  await cmds["build"].handler("", makeCtx("Deny"));
  dialogs = 0;
  r = await call(makeCtx("Deny"), "edit", { path: "c.ts" });
  check("4a build mode does not prompt", dialogs, 0);
  // The write gate must not fire in Build mode. Build has its own PRE-EXISTING
  // rule (todos before the first edit), so the call may still be blocked —
  // but never by the write policy.
  check(
    "4b build mode does not apply the write policy",
    /Write policy/.test(r?.reason ?? ""),
    false,
  );

  await cmds["default"].handler("", makeCtx("Deny"));
  await cmds["plan"].handler("", makeCtx("Deny"));
  dialogs = 0;
  r = await call(makeCtx("Deny"), "edit", { path: "src/d.ts" });
  check("4c plan mode does not add a second dialog", dialogs, 0);
  check("4d plan mode still blocks a source edit", r?.block, true);
  r = await call(makeCtx("Deny"), "write", {
    path: ".pi/plans/2026-10-20-x.md",
    content: "#",
  });
  check("4e plan mode still allows .pi/plans writes", r === undefined, true);
  await cmds["default"].handler("", makeCtx("Deny"));

  // ── Scenario 5: never blocks writes but leaves read-only commands free ──
  await cmds["write-policy"].handler("never", makeCtx("Deny"));
  dialogs = 0;
  r = await call(makeCtx("Allow once"), "edit", { path: "e.ts" });
  check("5a never blocks an edit", r?.block, true);
  check("5b never does not ask", dialogs, 0);
  check("5c never reason points at /build", /\/build/.test(r?.reason ?? ""), true);
  r = await call(makeCtx("Allow once"), "bash", { command: "ls -la" });
  check("5d never leaves read-only commands free", r === undefined, true);

  // ── Scenario 6: subagents and the reviewer are unaffected ──
  await cmds["write-policy"].handler("ask", makeCtx("Deny"));
  for (const role of ["explorer", "reviewer"]) {
    process.env.PI_WORKFLOW_ROLE = role;
    dialogs = 0;
    await call(makeCtx("Deny"), "edit", { path: "f.ts" });
    check(`6a ${role} child is not prompted`, dialogs, 0);
  }
  delete process.env.PI_WORKFLOW_ROLE;
  dialogs = 0;
  await call(makeCtx("Deny"), "edit", { path: "f.ts" });
  check("6b the top-level session still prompts", dialogs, 1);

  // ── Scenario 7: "Deny with instructions" — the guided denial ──
  const INSTRUCTION = "pls only explore and propose plan, do not edit file yet";
  await cmds["write-policy"].handler("ask", makeCtx("Deny"));
  dialogs = 0;
  inputDialogs = 0;
  sent.length = 0;
  entries.length = 0;
  r = await call(
    makeCtx(WRITE_DENY_WITH_INSTRUCTIONS_LABEL, INSTRUCTION),
    "edit",
    { path: "g.ts" },
  );
  check("7a the dialog offers the guided-denial choice", lastOptions.includes(WRITE_DENY_WITH_INSTRUCTIONS_LABEL), true);
  check("7b the guided choice opens the instruction dialog", inputDialogs, 1);
  check("7c the guided denial blocks the write", r?.block, true);
  check("7d the reason carries the instruction verbatim", (r?.reason ?? "").includes(INSTRUCTION), true);
  check("7e the reason tells the model not to retry", /Do not retry this write/.test(r?.reason ?? ""), true);
  check("7f the denial does NOT terminate the run", "terminate" in (r ?? {}), false);
  check("7g the instruction is delivered as a user message", sent.length, 1);
  check("7h the user message is delivered as a steer", sent[0]?.options?.deliverAs, "steer");
  check("7i the user message carries the instruction", String(sent[0]?.content ?? "").includes(INSTRUCTION), true);
  check("7j the denial is recorded in the transcript", entries.some((e) => e.type === "workflow-write-denial"), true);

  // A command write (no path) takes the same guided path. It uses a command
  // that no earlier scenario denied: a denial is remembered for the rest of
  // the run, so the same command would not be asked about again.
  sent.length = 0;
  inputDialogs = 0;
  r = await call(
    makeCtx(WRITE_DENY_WITH_INSTRUCTIONS_LABEL, INSTRUCTION),
    "bash",
    { command: "rm -rf tmpdir2" },
  );
  check("7k a guided denial works for a command write", r?.block, true);
  check("7l the command write's instruction was delivered", sent.length, 1);
  check("7m the command write's reason carries the instruction", (r?.reason ?? "").includes(INSTRUCTION), true);

  // The same command is NOT asked about again in this run.
  dialogs = 0;
  sent.length = 0;
  r = await call(makeCtx("Deny"), "bash", { command: "rm -rf tmpdir2" });
  check("7n the same command is not asked about again", dialogs, 0);
  check("7o the repeated command keeps the instruction", (r?.reason ?? "").includes(INSTRUCTION), true);
  check("7p the repeated command is still blocked", r?.block, true);

  // ── Scenario 8: a cancelled or empty instruction is a plain denial ──
  sent.length = 0;
  inputDialogs = 0;
  r = await call(
    makeCtx(WRITE_DENY_WITH_INSTRUCTIONS_LABEL, undefined),
    "edit",
    { path: "h.ts" },
  );
  check("8a a cancelled dialog still blocks the write", r?.block, true);
  check("8b a cancelled dialog sends no user message", sent.length, 0);
  check("8c a cancelled dialog is not treated as a guided denial", /Do not retry this write/.test(r?.reason ?? ""), false);
  check("8d a cancelled dialog does not terminate the run", "terminate" in (r ?? {}), false);

  sent.length = 0;
  r = await call(
    makeCtx(WRITE_DENY_WITH_INSTRUCTIONS_LABEL, "   "),
    "edit",
    { path: "h2.ts" },
  );
  check("8e a whitespace-only instruction sends no user message", sent.length, 0);
  check("8f a whitespace-only instruction blocks the write", r?.block, true);

  // A host without a text dialog falls back to a plain denial (fail closed).
  sent.length = 0;
  const noInputCtx = makeCtx(WRITE_DENY_WITH_INSTRUCTIONS_LABEL, INSTRUCTION);
  delete noInputCtx.ui.input;
  r = await call(noInputCtx, "edit", { path: "k.ts" });
  check("8g a host without a text dialog blocks the write", r?.block, true);
  check("8h a host without a text dialog sends no user message", sent.length, 0);

  // ── Scenario 9: plain Deny terminates the batch; allows never prompt for text ──
  sent.length = 0;
  inputDialogs = 0;
  r = await call(makeCtx("Deny"), "edit", { path: "i.ts" });
  check("9a a plain denial blocks the write", r?.block, true);
  check("9b a plain denial does not terminate the run", "terminate" in (r ?? {}), false);
  check("9c a plain denial sends no user message", sent.length, 0);
  check("9d a plain denial keeps the classic wording", /the user declined this write/.test(r?.reason ?? ""), true);
  check("9e a plain denial still says 'do not retry'", /Do not retry it\./.test(r?.reason ?? ""), true);

  sent.length = 0;
  inputDialogs = 0;
  r = await call(makeCtx(ALLOW_ONCE), "edit", { path: "j.ts" });
  check("9f 'Allow once' permits the write", r === undefined, true);
  check("9g 'Allow once' never opens the instruction dialog", inputDialogs, 0);
  check("9h 'Allow once' sends no user message", sent.length, 0);

  // ── Scenario 10: ONE turn, TWO writes to the same file → ONE dialog ──
  // This is the reported bug: pi prepares (and gates) every call of an
  // assistant message's batch before the first tool runs, so asking per call
  // asked the SAME question twice — and the sentence typed into the first
  // dialog could not reach the model before the second one opened.
  await cmds["write-policy"].handler("ask", makeCtx("Deny"));
  dialogs = 0;
  inputDialogs = 0;
  sent.length = 0;
  entries.length = 0;
  const batch = await turn(
    makeCtx(WRITE_DENY_WITH_INSTRUCTIONS_LABEL, INSTRUCTION),
    [
      { toolName: "edit", input: { path: "batch.ts" } },
      { toolName: "edit", input: { path: "batch.ts" } },
    ],
  );
  check("10a the turn asked ONCE", dialogs, 1);
  check("10b both calls of the turn were blocked", batch.every((x) => x?.block), true);
  check(
    "10c both reasons carry the instruction",
    batch.every((x) => (x?.reason ?? "").includes(INSTRUCTION)),
    true,
  );
  check("10d the instruction was delivered once", sent.length, 1);
  check(
    "10e the denial was recorded once",
    entries.filter((e) => e.type === "workflow-write-denial").length,
    1,
  );
  check("10f the option states its scope", lastOptions.includes(ALLOW_ONCE), true);
  check(
    "10g the denial entry lists every target of the turn",
    (entries.find((e) => e.type === "workflow-write-denial")?.data?.targets ?? []).length,
    1,
  );

  // ── Scenario 11: a LATER turn retries the same write → no second dialog ──
  dialogs = 0;
  sent.length = 0;
  const retry = await turn(makeCtx("Deny"), [
    { toolName: "edit", input: { path: "batch.ts" } },
  ]);
  check("11a the retry did not ask again", dialogs, 0);
  check("11b the retry is still blocked", retry[0]?.block, true);
  check(
    "11c the retry carries the same instruction",
    (retry[0]?.reason ?? "").includes(INSTRUCTION),
    true,
  );
  check("11d the retry still delivers the instruction as a user turn", sent.length, 1);

  // ── Scenario 12: the denial lives for the RUN, not for the session ──
  await settle();
  dialogs = 0;
  const afterRun = await turn(makeCtx("Deny"), [
    { toolName: "edit", input: { path: "batch.ts" } },
  ]);
  check("12a after the run settles the target asks again", dialogs, 1);
  check("12b the write is still blocked", afterRun[0]?.block, true);

  // ── Scenario 13: "always allow" a batch grants EVERY listed target ──
  await cmds["write-policy"].handler("ask", makeCtx("Deny"));
  dialogs = 0;
  const granted = await turn(makeCtx("Always allow these paths"), [
    { toolName: "edit", input: { path: "grant1.ts" } },
    { toolName: "edit", input: { path: "grant2.ts" } },
  ]);
  check("13a the batch asked once", dialogs, 1);
  check("13b both writes were allowed", granted.every((x) => x === undefined), true);
  const persistedBatch = JSON.parse(
    fs.readFileSync(SETTINGS, "utf8"),
  ).workflow.writePolicy;
  check(
    "13c both paths were persisted",
    persistedBatch.allowedPaths.filter(
      (p) => p.includes("grant1") || p.includes("grant2"),
    ).length,
    2,
  );
  dialogs = 0;
  await turn(makeCtx("Deny"), [{ toolName: "edit", input: { path: "grant1.ts" } }]);
  check("13d a granted path no longer prompts", dialogs, 0);
} finally {
  restore();
}

const failed = results.filter((x) => !x.ok);
console.log(
  `\n${results.length - failed.length}/${results.length} checks passed`,
);
if (failed.length) {
  console.log("FAILED:");
  for (const f of failed) console.log(`  - ${f.name}`);
  process.exit(1);
}
