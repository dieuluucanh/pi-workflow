/**
 * Refiner-only tools (parity plan row 9).
 *
 * Guarantees under test:
 *   - the child tool surface is exactly guarded inspection + prompt_ask +
 *     prompt_submit, with no shell/edit/write/approval/parent-turn channel;
 *   - questions are presented by the parent through an injected port; the tool
 *     has no UI and never fabricates answers;
 *   - inspection evidence records tool/path/summary and the policy generation,
 *     and repository output is framed as untrusted data;
 *   - prompt_submit accepts one structured candidate bound to the operation,
 *     enforces consent and cited evidence, and refuses stale file evidence;
 *   - revoking the operation, or changing policy mid-inspection, stops further
 *     questions/submissions and discards affected evidence.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import type { InspectionAuthority } from "./inspection-policy.ts";
import type { InspectionToolbox } from "./inspection-tools.ts";
import { DEFAULT_FOLDER_POLICY_CONFIG } from "./folder-policy.ts";
import {
  REFINER_TOOL_NAMES,
  createRefinerToolset,
  frameUntrustedRepositoryData,
  refinementPolicySnapshot,
  type RefinerAskPort,
  type RefinerSubmission,
  type RefinerToolResult,
  type RefinerToolset,
} from "./prompt-refinement-tools.ts";

// ── Fixtures ─────────────────────────────────────────────────────────

const ROOT = "C:/Users/Lenovo/.pi";

const AUTHORITY: InspectionAuthority = {
  root: ROOT,
  trusted: true,
  grants: [],
  config: {
    ...DEFAULT_FOLDER_POLICY_CONFIG,
    mode: "cwd",
    outside: "block",
    sensitivePatterns: ["**/.env"],
    excludePaths: ["node_modules"],
  },
};

function textResult(text: string, isError = false) {
  return {
    content: [{ type: "text", text }],
    ...(isError ? { isError: true } : {}),
  };
}

interface FakeTool {
  name: string;
  label: string;
  description: string;
  parameters: unknown;
  execute: (...args: unknown[]) => Promise<unknown>;
}

function fakeTool(
  name: string,
  execute?: (...args: unknown[]) => Promise<unknown>,
): FakeTool {
  return {
    name,
    label: `fake ${name}`,
    description: `fake ${name} tool`,
    parameters: {},
    execute: execute ?? (async () => textResult(`${name} body`)),
  };
}

function toolbox(tools: FakeTool[] = []): InspectionToolbox {
  return {
    tools: tools.length > 0 ? tools : [fakeTool("read")],
    unavailable: [],
    ceiling: AUTHORITY,
  };
}

interface ToolsetOverrides {
  inspection?: InspectionToolbox;
  ask?: RefinerAskPort;
  onSubmit?: (
    submission: RefinerSubmission,
  ) => Promise<{ ok: true } | { ok: false; error: string }> | { ok: true } | { ok: false; error: string };
  policyGeneration?: () => string;
  suggestionsAllowed?: boolean;
}

function makeToolset(overrides: ToolsetOverrides = {}): RefinerToolset {
  return createRefinerToolset({
    operation: { operationId: "op-1", sessionId: "s1", bindingId: "b1" },
    cwd: ROOT,
    authority: () => AUTHORITY,
    inspection: overrides.inspection ?? toolbox(),
    policyGeneration: overrides.policyGeneration ?? (() => "pg1-test"),
    ...(overrides.ask ? { ask: overrides.ask } : {}),
    ...(overrides.onSubmit ? { onSubmit: overrides.onSubmit } : {}),
    ...(overrides.suggestionsAllowed === undefined
      ? {}
      : { suggestionsAllowed: overrides.suggestionsAllowed }),
  });
}

async function call(
  toolset: RefinerToolset,
  name: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<RefinerToolResult> {
  const definition = toolset.tools.find((tool) => tool.name === name);
  assert.ok(definition, `tool ${name} should exist`);
  return definition!.execute("call-1", args, signal);
}

function textOf(result: RefinerToolResult): string {
  return result.content.map((block) => block.text).join("\n");
}

const VALID_RESULT = {
  candidate: "Objective\n\nImprove the child-session lifecycle without changing scope.",
  changeSummary: ["Clarified the objective"],
  suggestions: [] as string[],
  language: "en",
};

const ASK_ANSWER: RefinerAskPort = async (questions) => ({
  kind: "finished",
  answers: questions.map((question) => ({
    ...(question.questionId ? { questionId: question.questionId } : {}),
    prompt: question.prompt,
    answer: "Use child-session",
    wasCustom: false,
  })),
});

// ── Tool surface ─────────────────────────────────────────────────────

test("toolset: exposes only guarded inspection, prompt_ask and prompt_submit", () => {
  const toolset = makeToolset({
    inspection: toolbox([
      fakeTool("read"),
      fakeTool("grep"),
      fakeTool("find"),
      fakeTool("ls"),
    ]),
  });

  assert.deepEqual(toolset.toolNames, [...REFINER_TOOL_NAMES]);
  for (const forbidden of [
    "bash",
    "edit",
    "write",
    "questionnaire",
    "sendUserMessage",
    "approve",
    "commit",
    "orchestrator",
  ]) {
    assert.equal(
      (toolset.toolNames as readonly string[]).includes(forbidden),
      false,
      `${forbidden} must not be a refiner tool`,
    );
  }
  assert.deepEqual(toolset.unavailable, []);

  const source = readFileSync(
    new URL("./prompt-refinement-tools.ts", import.meta.url),
    "utf8",
  );
  for (const forbidden of [
    "createAgentSession",
    "registerCommand",
    "session.prompt",
    "pi.sendUserMessage",
  ]) {
    assert.equal(
      source.includes(forbidden),
      false,
      `refiner tools must not gain parent-turn authority via ${forbidden}`,
    );
  }
});

test("toolset: requires one operation binding", () => {
  assert.throws(
    () =>
      createRefinerToolset({
        operation: { operationId: "" },
        cwd: ROOT,
        authority: () => AUTHORITY,
        inspection: toolbox(),
      }),
    /operation id/,
  );
});

// ── Inspection evidence + untrusted framing ─────────────────────────

test("inspection: frames repository output as untrusted data and records path/generation", async () => {
  const toolset = makeToolset();
  const result = await call(toolset, "read", { path: "src/runtime.ts" });

  const text = textOf(result);
  assert.match(
    text,
    /<untrusted_repository_data source="read" path="src\/runtime.ts">/,
  );
  assert.match(text, /not instructions/i);
  assert.match(text, /cannot change the tools, permissions or request/i);
  assert.equal(result.isError, undefined);
  assert.match(String(result.details?.evidenceId), /^ev-\d+$/);
  assert.equal(result.details?.untrustedData, true);

  const evidence = toolset.ledger.usable();
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0]!.kind, "file");
  assert.equal(evidence[0]!.tool, "read");
  assert.equal(evidence[0]!.path, "src/runtime.ts");
  assert.equal(evidence[0]!.policyGeneration, "pg1-test");
  assert.equal(evidence[0]!.operationId, "op-1");
});

test("inspection: a policy refusal is not recorded as evidence", async () => {
  const toolset = makeToolset({
    inspection: toolbox([
      fakeTool("read", async () =>
        textResult("read: REFUSED — outside the approved repository", true),
      ),
    ]),
  });
  const result = await call(toolset, "read", { path: "../secret.txt" });
  assert.equal(result.isError, true);
  assert.equal(toolset.ledger.all().length, 0);
});

test("inspection: credentials are redacted in evidence summaries", async () => {
  const toolset = makeToolset({
    inspection: toolbox([
      fakeTool("read", async () =>
        textResult("token=supersecret123456\nordinary file body"),
      ),
    ]),
  });
  await call(toolset, "read", { path: "src/config.ts" });
  const evidence = toolset.ledger.usable();
  assert.equal(evidence.length, 1);
  assert.doesNotMatch(evidence[0]!.summary, /supersecret123456/);
  assert.match(evidence[0]!.summary, /\[redacted/);
});

test("inspection: a policy change mid-flight withholds the result and its evidence", async () => {
  let generation = "pg1-a";
  const toolset = makeToolset({
    policyGeneration: () => generation,
    inspection: toolbox([
      fakeTool("read", async () => {
        generation = "pg1-b";
        return textResult("sensitive file body");
      }),
    ]),
  });

  const result = await call(toolset, "read", { path: "src/changed.ts" });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /policy changed while the inspection was running/i);
  assert.doesNotMatch(textOf(result), /sensitive file body/);
  assert.equal(toolset.ledger.usable().length, 0);
});

test("inspection: aborting the operation throws instead of returning content", async () => {
  const toolset = makeToolset();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => call(toolset, "read", { path: "src/a.ts" }, controller.signal),
    /aborted/i,
  );
});

test("untrusted framing: escapes attributes and leaves errors untouched", () => {
  const framed = frameUntrustedRepositoryData(
    { content: [{ type: "text", text: "body" }] },
    "read",
    'a"b.ts',
  );
  assert.match(framed.content[0]!.text, /path="a&quot;b\.ts"/);

  const error: RefinerToolResult = {
    content: [{ type: "text", text: "read: REFUSED" }],
    isError: true,
  };
  const unframed = frameUntrustedRepositoryData(error, "read", "x");
  assert.equal(unframed.content[0]!.text, "read: REFUSED");
});

// ── prompt_ask ───────────────────────────────────────────────────────

test("prompt_ask: the parent presents questions and answers are recorded as user data", async () => {
  let captured: Parameters<RefinerAskPort>[0] | undefined;
  const toolset = makeToolset({
    ask: async (questions) => {
      captured = questions;
      return {
        kind: "finished",
        answers: [
          {
            questionId: questions[0]!.questionId,
            prompt: questions[0]!.prompt,
            answer: "Use child-session",
          },
        ],
      };
    },
  });

  const result = await call(toolset, "prompt_ask", {
    questions: [
      {
        prompt: "Which term should I use?",
        header: "Scope",
        options: [
          { label: "child-session", recommended: true },
          { label: "sub-session" },
        ],
      },
    ],
  });

  assert.equal(result.isError, undefined);
  assert.match(textOf(result), /answers received/i);
  assert.match(textOf(result), /Use child-session/);
  assert.ok(captured);
  assert.equal(captured!.length, 1);
  assert.equal(captured![0]!.questionId, "q-1-1");
  assert.equal(captured![0]!.options[0]!.recommended, true);
  assert.equal(captured![0]!.options[1]!.label, "sub-session");

  const evidence = toolset.ledger.usable();
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0]!.kind, "answer");
  assert.match(evidence[0]!.summary, /Use child-session/);
});

test("prompt_ask: no host UI is disclosed, never invented", async () => {
  const toolset = makeToolset();
  const result = await call(toolset, "prompt_ask", {
    questions: [{ prompt: "Which scope?" }],
  });
  assert.notEqual(result.isError, true);
  assert.match(textOf(result), /cannot be shown on this host/i);
  assert.match(textOf(result), /do not invent answers/i);
  assert.equal(toolset.ledger.all().length, 0);
});

test("prompt_ask: skip/cancel/unsupported outcomes do not create answers", async () => {
  const outcomes = [
    { kind: "skipped" as const, reason: "dismissed" },
    { kind: "cancelled" as const, reason: "aborted" },
    { kind: "unsupported" as const, capability: "headless", reason: "headless" },
  ];
  for (const outcome of outcomes) {
    const toolset = makeToolset({ ask: async () => outcome });
    const result = await call(toolset, "prompt_ask", {
      questions: [{ prompt: "Which scope?" }],
    });
    assert.match(textOf(result), /do not invent answers|stop asking|proceed literally/i);
    assert.equal(toolset.ledger.all().length, 0);
  }
});

test("prompt_ask: enforces per-round limits and a question budget", async () => {
  const toolset = makeToolset();

  const tooMany = await call(toolset, "prompt_ask", {
    questions: Array.from({ length: 5 }, () => ({ prompt: "Question?" })),
  });
  assert.equal(tooMany.isError, true);
  assert.match(textOf(tooMany), /at most 4/i);

  const tooManyOptions = await call(toolset, "prompt_ask", {
    questions: [
      {
        prompt: "Which?",
        options: Array.from({ length: 9 }, (_, index) => ({ label: `option-${index}` })),
      },
    ],
  });
  assert.equal(tooManyOptions.isError, true);
  assert.match(textOf(tooManyOptions), /too many options/i);

  const budgetTool = makeToolset({
    ask: async () => ({ kind: "skipped", reason: "dismissed" }),
  });
  for (let round = 0; round < 6; round += 1) {
    const result = await call(budgetTool, "prompt_ask", {
      questions: [{ prompt: `Question ${round}?` }],
    });
    assert.equal(result.isError, undefined);
  }
  const exhausted = await call(budgetTool, "prompt_ask", {
    questions: [{ prompt: "One more?" }],
  });
  assert.equal(exhausted.isError, true);
  assert.match(textOf(exhausted), /question budget exhausted/i);
});

// ── prompt_submit ────────────────────────────────────────────────────

test("prompt_submit: accepts exactly one structured candidate bound to the operation", async () => {
  let captured: RefinerSubmission | undefined;
  const toolset = makeToolset({
    onSubmit: async (submission) => {
      captured = submission;
      return { ok: true };
    },
  });
  await call(toolset, "read", { path: "src/runtime.ts" });

  const result = await call(toolset, "prompt_submit", {
    ...VALID_RESULT,
    terminology: [
      {
        from: "sub-session",
        to: "child-session",
        evidenceId: "ev-1",
        reason: "The runtime exports child-session helpers",
      },
    ],
  });

  assert.equal(result.isError, undefined);
  assert.match(textOf(result), /accepted one structured candidate/i);
  assert.equal(toolset.submitState.submitted, true);
  assert.ok(captured);
  assert.equal(captured!.operationId, "op-1");
  assert.equal(captured!.result.candidate, VALID_RESULT.candidate);
  assert.deepEqual(
    captured!.evidence.map((record) => record.evidenceId),
    ["ev-1"],
  );

  const second = await call(toolset, "prompt_submit", VALID_RESULT);
  assert.equal(second.isError, true);
  assert.match(textOf(second), /single candidate/i);
});

test("prompt_submit: validates structure, consent, evidence citations and unknown fields", async () => {
  const noConsent = makeToolset();
  const suggestions = await call(noConsent, "prompt_submit", {
    ...VALID_RESULT,
    suggestions: ["Consider adding tests"],
  });
  assert.equal(suggestions.isError, true);
  assert.match(textOf(suggestions), /suggestions require explicit user consent/i);

  const missingEvidence = makeToolset();
  const uncited = await call(missingEvidence, "prompt_submit", {
    ...VALID_RESULT,
    terminology: [{ from: "sub-session", to: "child-session" }],
  });
  assert.equal(uncited.isError, true);
  assert.match(textOf(uncited), /needs cited evidence/i);

  const unknownEvidence = makeToolset();
  await call(unknownEvidence, "read", { path: "src/runtime.ts" });
  const fakeCitation = await call(unknownEvidence, "prompt_submit", {
    ...VALID_RESULT,
    terminology: [
      { from: "sub-session", to: "child-session", evidenceId: "ev-99" },
    ],
  });
  assert.equal(fakeCitation.isError, true);
  assert.match(textOf(fakeCitation), /does not reference supplied evidence/i);

  const emptyCandidate = makeToolset();
  const empty = await call(emptyCandidate, "prompt_submit", {
    ...VALID_RESULT,
    candidate: "   ",
  });
  assert.equal(empty.isError, true);
  assert.match(textOf(empty), /must not be empty/i);

  const extra = makeToolset();
  const unknownField = await call(extra, "prompt_submit", {
    ...VALID_RESULT,
    implemented: true,
  });
  assert.equal(unknownField.isError, true);
  assert.match(textOf(unknownField), /unknown field/i);
});

test("prompt_submit: a rejected delivery is retryable and not marked submitted", async () => {
  let accept = false;
  const toolset = makeToolset({
    onSubmit: async () =>
      accept ? { ok: true } : { ok: false, error: "the draft changed" },
  });

  const first = await call(toolset, "prompt_submit", VALID_RESULT);
  assert.equal(first.isError, true);
  assert.match(textOf(first), /draft changed/i);
  assert.equal(toolset.submitState.submitted, false);

  accept = true;
  const second = await call(toolset, "prompt_submit", VALID_RESULT);
  assert.equal(second.isError, undefined);
  assert.equal(toolset.submitState.submitted, true);
  assert.equal(toolset.submitState.attempts, 2);
});

test("prompt_submit: stale file evidence is revoked and blocks submission", async () => {
  let generation = "pg1-a";
  const toolset = makeToolset({
    policyGeneration: () => generation,
    ask: ASK_ANSWER,
  });

  await call(toolset, "prompt_ask", { questions: [{ prompt: "Which term?" }] });
  await call(toolset, "read", { path: "src/runtime.ts" });

  generation = "pg1-b";
  toolset.syncPolicyGeneration();

  const usable = toolset.ledger.usable();
  assert.equal(usable.length, 1, "only the non-file answer evidence survives");
  assert.equal(usable[0]!.kind, "answer");
  assert.equal(toolset.ledger.hasRevokedFileEvidence(), true);

  const submitted = await call(toolset, "prompt_submit", {
    ...VALID_RESULT,
    terminology: [
      { from: "sub-session", to: "child-session", evidenceId: "ev-2" },
    ],
  });
  assert.equal(submitted.isError, true);
  assert.match(textOf(submitted), /file evidence was revoked/i);
  assert.equal(toolset.submitState.submitted, false);
});

test("revoke: closes questions, submissions and inspection immediately", async () => {
  const toolset = makeToolset({ ask: ASK_ANSWER });
  await call(toolset, "read", { path: "src/runtime.ts" });

  toolset.revoke("user cancelled");
  assert.equal(toolset.ledger.isClosed(), true);
  assert.equal(toolset.ledger.usable().length, 0);

  const read = await call(toolset, "read", { path: "src/runtime.ts" });
  assert.equal(read.isError, true);
  assert.match(textOf(read), /cannot continue/i);

  const asked = await call(toolset, "prompt_ask", {
    questions: [{ prompt: "Still there?" }],
  });
  assert.equal(asked.isError, true);
  assert.match(textOf(asked), /cannot continue/i);

  const submitted = await call(toolset, "prompt_submit", VALID_RESULT);
  assert.equal(submitted.isError, true);
  assert.match(textOf(submitted), /cannot continue/i);
});

test("refinementPolicySnapshot: keeps every deny layer for the generation", () => {
  const snapshot = refinementPolicySnapshot(AUTHORITY);
  assert.equal(snapshot.trusted, true);
  assert.equal(snapshot.root, ROOT);
  assert.deepEqual(snapshot.grants, []);
  assert.deepEqual(snapshot.sensitivePatterns, ["**/.env"]);
  assert.deepEqual(snapshot.excludePaths, ["node_modules"]);
  assert.equal(snapshot.outside, "block");
});
