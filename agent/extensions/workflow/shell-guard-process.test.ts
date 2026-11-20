/**
 * Real native shell deadline tests.
 *
 * These call Pi's own `createBashToolDefinition` — the same backend the guard
 * relies on — and prove that the timeout (a) fires, (b) is not renewed by
 * continuous output, (c) keeps partial output, and (d) does not disturb a
 * legitimate non-empty heredoc script.
 *
 * Every child is a harmless owned fixture with a short explicit deadline. No
 * provider, network, Python, or repository process is involved. `node:test`'s
 * per-test timeout is the independent outer bound.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createBashToolDefinition } from "@earendil-works/pi-coding-agent";

const node = JSON.stringify(process.execPath);
const tool = createBashToolDefinition(process.cwd());

const ctx = {
  cwd: process.cwd(),
  model: undefined,
  thinkingLevel: undefined,
  sessionManager: {
    getSessionId: () => "process-test",
    getSessionFile: () => undefined,
  },
};

function run(command: string, timeout: number) {
  return tool.execute(
    "process-test",
    { command, timeout },
    undefined as never,
    undefined,
    ctx as never,
  );
}

test(
  "native: a silent waiting child is cancelled at the deadline",
  { timeout: 10_000 },
  async () => {
    await assert.rejects(
      run(`${node} -e "setTimeout(() => {}, 60000)"`, 0.3),
      /Command timed out after 0\.3 seconds/,
    );
  },
);

test(
  "native: continuous output does not renew the deadline",
  { timeout: 10_000 },
  async () => {
    await assert.rejects(
      run(
        `${node} -e "setInterval(() => console.log('tick'), 25)"`,
        0.4,
      ),
      /Command timed out after 0\.4 seconds/,
    );
  },
);

test(
  "native: partial output is preserved in the timeout result",
  { timeout: 10_000 },
  async () => {
    await assert.rejects(
      run(
        `${node} -e "console.log('partial-before-wait'); setTimeout(() => {}, 60000)"`,
        0.4,
      ),
      (error: Error) => {
        assert.match(error.message, /partial-before-wait/);
        assert.match(error.message, /Command timed out after 0\.4 seconds/);
        return true;
      },
    );
  },
);

test(
  "native: a legitimate non-empty heredoc script still runs",
  { timeout: 10_000 },
  async () => {
    const result = (await run(
      `${node} - <<'JS'\nconsole.log("heredoc-ok")\nJS\n`,
      5,
    )) as { content?: Array<{ text?: string }> };
    const text = (result.content ?? []).map((p) => p.text ?? "").join("\n");
    assert.match(text, /heredoc-ok/);
  },
);
