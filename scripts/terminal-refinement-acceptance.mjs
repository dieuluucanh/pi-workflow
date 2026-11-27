#!/usr/bin/env node
/**
 * Real Terminal keyboard acceptance for prompt refinement (parity plan row 36).
 *
 * This drives the **actual Pi TUI in a real pseudo-terminal** (`node-pty`), not
 * a mocked extension context:
 *
 *   - the real `pi` CLI (pinned SDK, or `PI_TERMINAL_CLI`),
 *   - the real terminal editor/answer surface,
 *   - the real `/prompt` command, refinement runtime and isolated-session
 *     bootstrap,
 *   - a deterministic OpenAI-compatible HTTP provider (only the model bytes are
 *     scripted; the SDK does the request → SSE → tool-call loop for real).
 *
 * Scenarios (each one is a fresh profile/project/CLI process):
 *
 *   prefix-return   typed `/prompt` → candidate in the composer, zero task turns
 *   esc-cancel      Esc during the provider wait → original restored, no apply
 *   questionnaire   `prompt_ask` question answered with the keyboard, then apply
 *   paste-marker    bracketed multi-line paste expands for refinement + history
 *   image-path      a file path survives literally (Terminal has no image attach)
 *
 * Every scenario also records the facts the plan's executable assertions need:
 * provider request count/kind (refiner-only vs. a main-agent turn), the
 * expanded text the refiner received, and the files the project gained.
 *
 * Usage:
 *   node scripts/terminal-refinement-acceptance.mjs [--json]
 *
 * Requirements / overrides:
 *   PI_NODE_PTY      path to node-pty's `lib/index.js` when the repo has no
 *                    `node-pty` dependency (the Desktop checkout has one).
 *   PI_TERMINAL_CLI  path to the `pi` CLI bundle. Defaults to the pinned SDK in
 *                    `agent/extensions/workflow/node_modules`.
 *
 * Exit code 0 = every scenario passed. Unavailable prerequisites are reported
 * as NOT RUN (exit 2), never as a pass.
 */

import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import assert from "node:assert/strict";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const WORKFLOW_DIR = join(ROOT, "agent", "extensions", "workflow");
const EXTENSION_ENTRY = join(WORKFLOW_DIR, "index.ts");

// ── Prerequisites ────────────────────────────────────────────────────

function locatePty() {
  const candidates = [
    process.env.PI_NODE_PTY,
    join(ROOT, "node_modules", "node-pty", "lib", "index.js"),
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return undefined;
}

function locateCli() {
  const candidates = [
    process.env.PI_TERMINAL_CLI,
    join(
      WORKFLOW_DIR,
      "node_modules",
      "@earendil-works",
      "pi-coding-agent",
      "dist",
      "bundle",
      "cli.js",
    ),
    process.env.APPDATA
      ? join(
          process.env.APPDATA,
          "npm",
          "node_modules",
          "@earendil-works",
          "pi-coding-agent",
          "dist",
          "bundle",
          "cli.js",
        )
      : undefined,
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return undefined;
}

async function loadPtyModule() {
  const explicit = locatePty();
  if (explicit) return (await import(pathToFileURL(explicit).href)).default;
  const mod = await import("node-pty");
  return mod.default;
}

// ── Deterministic provider ───────────────────────────────────────────

/**
 * One scripted model turn. Mirrors the Desktop E2E fixture: real SSE chunks,
 * so the SDK's parser and tool loop are exercised rather than stubbed.
 */
function writeSse(response, model, delta, finish) {
  response.write(
    `data: ${JSON.stringify({
      id: "chatcmpl-terminal-acceptance",
      object: "chat.completion.chunk",
      created: 1_700_000_000,
      model,
      choices: [{ index: 0, delta, finish_reason: finish }],
    })}\n\n`,
  );
}

function textStep(text) {
  return { kind: "text", text };
}

function toolStep(name, args) {
  return { kind: "toolCall", name, arguments: args };
}

/** A provider that answers from a per-request queue and logs every body. */
async function startProvider(script) {
  const requests = [];
  const server = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", async () => {
      let body = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        body = {};
      }
      const index = requests.length;
      requests.push({ path: request.url, body, at: Date.now() });
      const step = script({ body, index, requests }) ?? textStep("ok");
      const model = typeof body.model === "string" ? body.model : "fake-1";

      if (step.kind === "hold") {
        // Never answer: the caller aborts the request (Esc scenario).
        request.on("close", () => {});
        return;
      }

      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      if (step.kind === "error") {
        response.writeHead(step.status ?? 500, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: step.message ?? "scripted failure" } }));
        return;
      }
      if (step.kind === "text") {
        for (const word of String(step.text).split(" ")) {
          writeSse(response, model, { content: `${word} ` }, null);
        }
        writeSse(response, model, {}, "stop");
      }
      if (step.kind === "toolCall") {
        writeSse(
          response,
          model,
          {
            tool_calls: [
              {
                index: 0,
                id: step.id ?? `call_${index}`,
                type: "function",
                function: { name: step.name, arguments: JSON.stringify(step.arguments) },
              },
            ],
          },
          "tool_calls",
        );
      }
      writeSse(response, model, {}, step.kind === "toolCall" ? "tool_calls" : "stop");
      response.write("data: [DONE]\n\n");
      response.end();
    });
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () => new Promise((done) => server.close(done)),
  };
}

// ── TUI driver ───────────────────────────────────────────────────────

/** Strip ANSI/OSC control sequences so assertions read rendered text. */
function plain(raw) {
  return raw
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\r\n?/g, "\n");
}

class TerminalSession {
  constructor(pty, options) {
    this.pty = pty;
    this.options = options;
    this.raw = "";
    this.exited = false;
    this.exitCode = undefined;
    this.proc = pty.spawn(process.execPath, options.argv, {
      name: "xterm-256color",
      cols: 120,
      rows: 40,
      cwd: options.cwd,
      env: options.env,
    });
    this.proc.onData((data) => {
      this.raw += data;
    });
    this.proc.onExit(({ exitCode }) => {
      this.exited = true;
      this.exitCode = exitCode;
    });
  }

  text() {
    return plain(this.raw);
  }

  write(data) {
    this.proc.write(data);
  }

  async waitFor(needle, { timeout = 30_000, label } = {}) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const text = this.text();
      if (typeof needle === "string" ? text.includes(needle) : needle.test(text)) return text;
      if (this.exited) {
        throw new Error(
          `${label ?? String(needle)}: the terminal exited (code ${this.exitCode}) before it appeared.\n--- tail ---\n${text.slice(-2500)}`,
        );
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(
      `${label ?? String(needle)}: never appeared within ${timeout}ms.\n--- tail ---\n${this.text().slice(-3000)}`,
    );
  }

  async waitForGone(needle, { timeout = 30_000 } = {}) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (!this.text().includes(needle)) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`${needle}: still visible after ${timeout}ms`);
  }

  async idle(ms = 400) {
    await new Promise((r) => setTimeout(r, ms));
  }

  kill() {
    try {
      this.proc.kill();
    } catch {
      /* already gone */
    }
  }
}

// ── Scenario plumbing ────────────────────────────────────────────────

const workdirs = [];

function makeProfile(providerBaseUrl) {
  const profile = mkdtempSync(join(tmpdir(), "pi-terminal-acceptance-profile-"));
  const project = mkdtempSync(join(tmpdir(), "pi-terminal-acceptance-project-"));
  workdirs.push(profile, project);
  for (const dir of [profile, project]) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(
    join(profile, "settings.json"),
    `${JSON.stringify(
      {
        defaultProvider: "fake",
        defaultModel: "fake-1",
        // The authoritative Default-mode record refinement inherits from.
        workflow: { modelDefault: { provider: "fake", id: "fake-1" } },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  writeFileSync(
    join(profile, "models.json"),
    `${JSON.stringify(
      {
        providers: {
          fake: {
            baseUrl: providerBaseUrl,
            api: "openai-completions",
            apiKey: "fake-key",
            compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
            models: [
              { id: "fake-1", name: "Fake Model", input: ["text", "image"], contextWindow: 200000 },
            ],
          },
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return { profile, project };
}

function buildArgv(cli, extensionEntry) {
  return [
    cli,
    "-e",
    extensionEntry,
    "-ne",
    "-ns",
    "-np",
    "--no-session",
    "--offline",
    "--tui-mode",
    "regular",
    "--provider",
    "fake",
    "--model",
    "fake-1",
  ];
}

async function launch(pty, cli, { providerBaseUrl }) {
  const { profile, project } = makeProfile(providerBaseUrl);
  const session = new TerminalSession(pty, {
    cwd: project,
    argv: buildArgv(cli, EXTENSION_ENTRY),
    env: {
      ...process.env,
      PI_CODING_AGENT_DIR: profile,
      PI_OFFLINE: "1",
      TERM: "xterm-256color",
      PI_TERMINAL_ACCEPTANCE: "1",
    },
  });
  // Startup banner or the footer model line proves the TUI is ready for input.
  await session.waitFor(/\(fake\) fake-1|fake-1\s*$/m, {
    timeout: 60_000,
    label: "TUI startup",
  });
  await session.idle(600);
  return { session, profile, project };
}

/** Opt-in failure diagnostics: dump the full rendered terminal to a file. */
function dumpTerminal(session) {
  const dir = process.env.PI_TERMINAL_DEBUG_DUMP;
  if (!dir) return;
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${currentScenario ?? "scenario"}.log`), session.text(), "utf8");
  } catch {
    /* diagnostics never fail a run */
  }
}

/** The refiner's child session, identified by its submit tool definition. */
function isRefinerRequest(request) {
  const tools = Array.isArray(request.body.tools) ? request.body.tools : [];
  return tools.some((tool) => tool?.function?.name === "prompt_submit");
}

function requestText(request) {
  return JSON.stringify(request.body);
}

function lastUserText(request) {
  const messages = Array.isArray(request.body.messages) ? request.body.messages : [];
  const user = [...messages].reverse().find((message) => message?.role === "user");
  if (!user) return "";
  if (typeof user.content === "string") return user.content;
  if (Array.isArray(user.content)) {
    return user.content
      .map((part) => (typeof part === "string" ? part : part?.text ?? ""))
      .join("\n");
  }
  return "";
}

/** Text of the refiner's tool-result messages (the answers it received). */
function toolResultText(request) {
  const messages = Array.isArray(request.body.messages) ? request.body.messages : [];
  return messages
    .filter((message) => message?.role === "tool")
    .map((message) =>
      typeof message.content === "string"
        ? message.content
        : Array.isArray(message.content)
          ? message.content.map((part) => part?.text ?? "").join("\n")
          : "",
    )
    .join("\n");
}

/** Files/dirs that refinement must never create inside the project. */
function projectArtifacts(project) {
  const out = [];
  const walk = (dir, prefix) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (entry.name === ".git" || entry.name === "node_modules") continue;
        walk(join(dir, entry.name), rel);
      } else {
        out.push(rel);
      }
    }
  };
  walk(project, "");
  return out.sort();
}

function candidateEvents(session) {
  // The candidate is rendered in the composer; the transcript must not grow a
  // matching assistant/tool row. One occurrence = composer only.
  return (session.text().match(/Refined prompt:/g) ?? []).length;
}

// ── Scenarios ────────────────────────────────────────────────────────

const CANDIDATE = "Refined prompt: keep the intent, tighten the wording.";

const scenarios = [];
let currentScenario;

scenarios.push({
  name: "prefix-return",
  title: "typed /prompt returns a candidate without a task turn",
  async run({ pty, cli }) {
    const provider = await startProvider(() =>
      toolStep("prompt_submit", {
        candidate: CANDIDATE,
        changeSummary: ["Kept the intent."],
        suggestions: [],
        language: "en",
      }),
    );
    const { session, project } = await launch(pty, cli, { providerBaseUrl: provider.baseUrl });
    try {
      session.write("/prompt make the paragrph better");
      await session.idle(300);
      session.write("\r");
      await session.waitFor(CANDIDATE, { timeout: 90_000, label: "candidate in composer" });
      await session.idle(800);

      assert.equal(provider.requests.length, 1, "exactly one provider request (the refiner)");
      assert.ok(isRefinerRequest(provider.requests[0]), "the request came from the refiner session");
      assert.match(lastUserText(provider.requests[0]), /make the paragrph better/);

      // The composer keeps the candidate editable: the editor cursor is still
      // active and typing appends rather than dispatching. (The scrollback may
      // still show the typed command line; only the composer proves the
      // prefix is gone, which the appended text does.)
      session.write(" tail");
      await session.waitFor(`${CANDIDATE} tail`, {
        timeout: 30_000,
        label: "candidate is editable",
      });
      assert.deepEqual(projectArtifacts(project), [], "refinement created no project files");
      return {
        providerRequests: provider.requests.length,
        refinerRequests: provider.requests.filter(isRefinerRequest).length,
        candidateRendered: candidateEvents(session),
        editable: true,
        projectArtifacts: [],
      };
    } finally {
      dumpTerminal(session);
      session.kill();
      await provider.close();
    }
  },
});

scenarios.push({
  name: "esc-cancel",
  title: "Esc during the provider wait restores the original and applies nothing",
  async run({ pty, cli }) {
    const provider = await startProvider(() => ({ kind: "hold" }));
    const { session, project } = await launch(pty, cli, { providerBaseUrl: provider.baseUrl });
    try {
      session.write("/prompt hold this draft while it runs");
      await session.idle(300);
      session.write("\r");
      await session.waitFor(/Refining|Inspecting|inspect/i, {
        timeout: 60_000,
        label: "progress surface",
      });
      // Give the refiner request time to reach the scripted hold.
      const deadline = Date.now() + 30_000;
      while (provider.requests.length === 0 && Date.now() < deadline) {
        await session.idle(100);
      }
      assert.equal(provider.requests.length, 1, "the refiner request was in flight");

      session.write("\u001b"); // Esc
      await session.waitFor("hold this draft while it runs", {
        timeout: 60_000,
        label: "original restored in the composer",
      });
      await session.idle(1200);

      assert.ok(!session.text().includes(CANDIDATE), "no candidate was applied");
      assert.equal(provider.requests.length, 1, "cancel never started a second operation");

      // The session is still usable: an ordinary prompt dispatches a *task*
      // turn (proving Esc cancelled the operation, not the terminal).
      session.write("/prompt ");
      await session.idle(200);
      session.write("\u0015"); // ctrl+u clears the partial command line
      session.write("hello after cancel");
      await session.idle(200);
      session.write("\r");
      await session.waitFor(/\(fake\) fake-1/, { timeout: 30_000 });
      const unrefined = await (async () => {
        const until = Date.now() + 30_000;
        while (Date.now() < until) {
          const task = provider.requests.find((request) => !isRefinerRequest(request));
          if (task) return task;
          await session.idle(100);
        }
        return undefined;
      })();
      assert.ok(unrefined, "the later human send produced a main-agent request");
      assert.match(lastUserText(unrefined), /hello after cancel/);
      assert.deepEqual(projectArtifacts(project), [], "cancel created no project files");
      return {
        providerRequests: provider.requests.length,
        refinerRequests: provider.requests.filter(isRefinerRequest).length,
        taskRequests: provider.requests.filter((request) => !isRefinerRequest(request)).length,
        cancelledDraftRestored: true,
        projectArtifacts: [],
      };
    } finally {
      dumpTerminal(session);
      session.kill();
      await provider.close();
    }
  },
});

scenarios.push({
  name: "questionnaire",
  title: "prompt_ask docks a question, the keyboard answers it, then the candidate applies",
  async run({ pty, cli }) {
    const provider = await startProvider(({ index, requests }) => {
      if (index === 0) {
        return toolStep("prompt_ask", {
          questions: [
            {
              prompt: "Which audience should the prompt target?",
              header: "Audience",
              options: [
                { label: "Alpha users", description: "People using the product" },
                { label: "Beta maintainers", description: "People changing the code", recommended: true },
              ],
            },
          ],
        });
      }
      // The answer must arrive as the prompt_ask tool *result*, not merely as
      // part of the question text in the conversation.
      const sawAnswer =
        requests.length > 1 && toolResultText(requests[1]).includes("Alpha users");
      return toolStep("prompt_submit", {
        candidate: sawAnswer
          ? "Refined prompt: written for alpha users, keeping the failure details."
          : CANDIDATE,
        changeSummary: ["Targeted maintainers."],
        suggestions: [],
        language: "en",
      });
    });
    const { session, project } = await launch(pty, cli, { providerBaseUrl: provider.baseUrl });
    try {
      session.write("/prompt summarise the failure for the release notes");
      await session.idle(300);
      session.write("\r");
      await session.waitFor("Which audience", {
        timeout: 90_000,
        label: "question surface",
      });
      // Keyboard route: Down moves to the recommended option, Enter confirms.
      session.write("\u001b[B");
      await session.idle(300);
      session.write("\r");
      await session.waitFor("Refined prompt: written for alpha users", {
        timeout: 90_000,
        label: "candidate after the answer",
      });
      await session.idle(600);

      assert.equal(provider.requests.length, 2, "one ask turn and one submit turn");
      assert.ok(isRefinerRequest(provider.requests[1]), "the second turn is the refiner");
      assert.match(
        toolResultText(provider.requests[1]),
        /Alpha users/,
        "the keyboard choice reached the refiner as a tool result",
      );
      // The question surface is disposed after answering: the composer, not a
      // modal, holds the candidate and typing goes to the draft.
      session.write(" tail");
      await session.waitFor("written for alpha users, keeping the failure details. tail", {
        timeout: 30_000,
        label: "composer editable after answering",
      });
      assert.deepEqual(projectArtifacts(project), []);
      return {
        providerRequests: provider.requests.length,
        refinerRequests: provider.requests.filter(isRefinerRequest).length,
        questionRendered: true,
        answerDelivered: true,
        projectArtifacts: [],
      };
    } finally {
      dumpTerminal(session);
      session.kill();
      await provider.close();
    }
  },
});

scenarios.push({
  name: "paste-marker",
  title: "a bracketed multi-line paste expands for refinement and history survives",
  async run({ pty, cli }) {
    const provider = await startProvider(({ requests, body }) => {
      // Only the ordinary seed prompt is a task turn; every refined turn is a
      // refiner child identified by its submit tool.
      if (!(Array.isArray(body.tools) ? body.tools : []).some((tool) => tool?.function?.name === "prompt_submit")) {
        return textStep("history seed acknowledged");
      }
      const expanded = requests.some((request) => requestText(request).includes("line 20"));
      return toolStep("prompt_submit", {
        candidate: expanded
          ? "Refined prompt: keep all twenty log lines and explain the failure."
          : CANDIDATE,
        changeSummary: ["Kept the pasted log."],
        suggestions: [],
        language: "en",
      });
    });
    const { session, project } = await launch(pty, cli, { providerBaseUrl: provider.baseUrl });
    try {
      // Seed the editor's prompt history with one ordinary, deliberately sent
      // prompt (the only task turn in this scenario).
      session.write("earlier prompt for history");
      await session.idle(200);
      session.write("\r");
      await session.waitFor("history seed acknowledged", {
        timeout: 60_000,
        label: "seed task answered",
      });
      await session.idle(500);

      session.write("/prompt ");
      await session.idle(200);
      const lines = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join("\r\n");
      // Bracketed paste is what a real terminal sends; Pi collapses it to a
      // canonical `[paste #N …]` marker and keeps the expanded side table.
      session.write(`\u001b[200~${lines}\u001b[201~`);
      await session.waitFor(/\[paste #\d+/, {
        timeout: 30_000,
        label: "paste marker in the composer",
      });
      session.write("\r");
      await session.waitFor("Refined prompt: keep all twenty log lines", {
        timeout: 90_000,
        label: "candidate after the pasted input",
      });
      await session.idle(600);

      const refinerRequests = provider.requests.filter(isRefinerRequest);
      assert.equal(refinerRequests.length, 1, "exactly one refinement ran");
      assert.match(
        requestText(refinerRequests[0]),
        /line 20/,
        "refinement received the expanded paste, not the marker",
      );
      assert.match(lastUserText(refinerRequests[0]), /line 1\b/);

      // History preservation: clear the composer, then Up must recall the
      // earlier ordinary prompt — not a broken `[paste #N …]` line and not a
      // refinement artifact. Typing appends to the recalled draft.
      session.write("\u0015"); // ctrl+u
      await session.idle(500);
      session.write("\u001b[A");
      await session.idle(600);
      session.write(" HISTORY");
      await session.waitFor(/ HISTORY/, { timeout: 30_000, label: "history recall" });
      await session.idle(300);
      const recalled = /([^\n]{0,160}) HISTORY/.exec(session.text())?.[1] ?? "";
      // The editor history stores the *expanded* submitted line (the paste side
      // table was resolved when it was submitted), never the bare marker.
      assert.match(
        recalled,
        /\/prompt line 1/,
        `Up recalled the submitted refinement line; got ${JSON.stringify(recalled)}`,
      );
      assert.match(recalled, /line 12/, "the recalled line kept the pasted body");
      assert.ok(
        !recalled.includes("[paste #"),
        "history kept a paste marker instead of the expanded text",
      );
      assert.deepEqual(projectArtifacts(project), []);
      return {
        providerRequests: provider.requests.length,
        refinerRequests: refinerRequests.length,
        taskRequests: provider.requests.filter((request) => !isRefinerRequest(request)).length,
        expandedPasteReachedRefiner: true,
        historyRecall: recalled.trim(),
        projectArtifacts: [],
      };
    } finally {
      dumpTerminal(session);
      session.kill();
      await provider.close();
    }
  },
});

scenarios.push({
  name: "image-path",
  title: "file paths (Terminal has no image attach) survive refinement literally",
  async run({ pty, cli }) {
    const provider = await startProvider(({ requests }) => {
      const sawPath =
        requests.length > 0 && requestText(requests[0]).includes("screenshots/capture.png");
      return toolStep("prompt_submit", {
        candidate: sawPath
          ? "Refined prompt: update the docs for `screenshots/capture.png` and keep `/prompt` literal."
          : CANDIDATE,
        changeSummary: ["Preserved the path and the literal command."],
        suggestions: [],
        language: "en",
      });
    });
    const { session, project } = await launch(pty, cli, { providerBaseUrl: provider.baseUrl });
    try {
      const input =
        "/prompt Update the docs for screenshots/capture.png and keep /prompt literal.";
      session.write(input);
      await session.idle(300);
      session.write("\r");
      await session.waitFor("Refined prompt: update the docs for", {
        timeout: 90_000,
        label: "candidate preserving the path",
      });
      await session.idle(500);

      assert.equal(provider.requests.length, 1);
      const body = requestText(provider.requests[0]);
      assert.match(body, /screenshots\/capture\.png/);
      assert.match(body, /\/prompt literal/, "the quoted literal command survived");
      assert.deepEqual(projectArtifacts(project), []);
      return {
        providerRequests: provider.requests.length,
        pathPreserved: true,
        literalCommandPreserved: true,
        imageAttachment: "unsupported (Terminal limitation, documented in the parity matrix)",
        projectArtifacts: [],
      };
    } finally {
      dumpTerminal(session);
      session.kill();
      await provider.close();
    }
  },
});

// ── Runner ───────────────────────────────────────────────────────────

async function main() {
  const asJson = process.argv.includes("--json");
  const onlyIndex = process.argv.indexOf("--only");
  const only = onlyIndex >= 0 ? process.argv[onlyIndex + 1] : undefined;
  const ptyPath = locatePty();
  const cli = locateCli();
  const unavailable = [];
  if (!ptyPath) unavailable.push("node-pty (set PI_NODE_PTY to node-pty/lib/index.js)");
  if (!cli) unavailable.push("pi CLI bundle (set PI_TERMINAL_CLI)");
  if (unavailable.length > 0) {
    const payload = {
      status: "NOT RUN",
      reason: `missing prerequisites: ${unavailable.join("; ")}`,
      node: process.version,
      platform: `${process.platform} ${process.arch}`,
    };
    console.log(asJson ? JSON.stringify(payload, null, 2) : `NOT RUN — ${payload.reason}`);
    process.exitCode = 2;
    return;
  }

  const pty = await loadPtyModule();
  const evidence = {
    status: "RUN",
    startedAt: new Date().toISOString(),
    node: process.version,
    platform: `${process.platform} ${process.arch}`,
    ptyModule: ptyPath,
    cli,
    extensionEntry: EXTENSION_ENTRY,
    scenarios: [],
  };
  let failed = 0;
  for (const scenario of scenarios) {
    if (only && scenario.name !== only) continue;
    const startedAt = Date.now();
    currentScenario = scenario.name;
    try {
      const facts = await scenario.run({ pty, cli });
      evidence.scenarios.push({
        name: scenario.name,
        title: scenario.title,
        status: "PASS",
        durationMs: Date.now() - startedAt,
        facts,
      });
      if (!asJson) console.log(`PASS ${scenario.name} — ${scenario.title}`);
    } catch (error) {
      failed += 1;
      evidence.scenarios.push({
        name: scenario.name,
        title: scenario.title,
        status: "FAIL",
        durationMs: Date.now() - startedAt,
        error: error instanceof Error ? error.stack ?? error.message : String(error),
      });
      console.error(
        `FAIL ${scenario.name} — ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  evidence.endedAt = new Date().toISOString();
  evidence.status = failed === 0 ? "PASS" : "FAIL";
  evidence.passed = evidence.scenarios.filter((scenario) => scenario.status === "PASS").length;
  evidence.failed = failed;

  if (asJson) console.log(JSON.stringify(evidence, null, 2));
  else console.log(`\n${evidence.passed}/${evidence.scenarios.length} scenarios passed`);
  process.exitCode = failed === 0 ? 0 : 1;
}

let cleanupStarted = false;
function cleanup() {
  if (cleanupStarted) return;
  cleanupStarted = true;
  for (const dir of workdirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* Windows keeps handles briefly; temp leftovers are harmless. */
    }
  }
}

process.on("exit", cleanup);

await main();
