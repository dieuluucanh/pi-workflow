/**
 * Bounded prompt-refinement runtime (parity plan row 10).
 *
 * The runtime is the only place that decides whether an operation may keep
 * running, what may reach a provider and what may reach the composer. These
 * tests exercise the boundaries that matter:
 *
 *   - budgets: model turns, inspection calls, question rounds, active time;
 *   - no progress and repeated question rounds stop instead of looping;
 *   - provider errors and missing sessions fail honestly;
 *   - an untrusted/no-repository or no-relevant-code operation still composes,
 *     but never pretends it inspected anything;
 *   - scope-changing answers are recorded as user decisions and enable a
 *     candidate that would otherwise be refused as unapproved expansion;
 *   - policy/trust/grant narrowing during a questionnaire or provider request
 *     invalidates the operation, preserves the draft and disposes the child;
 *   - a late tool/provider/session completion can never deliver a candidate
 *     after invalidation or cancellation;
 *   - sessions, subscriptions, timers and question signals are released on
 *     every exit path.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_FOLDER_POLICY_CONFIG } from "./folder-policy.ts";
import type { InspectionAuthority } from "./inspection-policy.ts";
import type { InspectionToolbox } from "./inspection-tools.ts";
import {
  createRefinementRuntime,
  detectApprovedScopeChanges,
  detectUnapprovedScopeExpansion,
  readRefinementProviderFailure,
  refinementQuestionKey,
  type RefinementCandidate,
  type RefinementChildSession,
  type RefinementDeliveryContext,
  type RefinementDeliveryOutcome,
  type RefinementDeliveryPort,
  type RefinementRunResult,
  type RefinementRuntime,
  type RefinementRuntimeClock,
  type RefinementRuntimeDeps,
  type RefinementRuntimeLimits,
  type RefinementSessionFactory,
  type RefinementSessionRequest,
} from "./prompt-refinement-runtime.ts";
import type {
  RefinerAskPort,
  RefinerToolDefinition,
} from "./prompt-refinement-tools.ts";

// ── Fixtures ─────────────────────────────────────────────────────────

const ROOT = "C:/Users/Lenovo/.pi";
const ORIGINAL =
  "Please improve the child-session lifecycle description so sub-session is consistent.";

function makeAuthority(
  overrides: Partial<Omit<InspectionAuthority, "config">> & {
    config?: Partial<InspectionAuthority["config"]>;
  } = {},
): InspectionAuthority {
  const { config, ...rest } = overrides;
  return {
    root: ROOT,
    trusted: true,
    grants: [],
    ...rest,
    config: {
      ...DEFAULT_FOLDER_POLICY_CONFIG,
      mode: "cwd",
      outside: "block",
      excludePaths: ["node_modules"],
      ...(config ?? {}),
    },
  };
}

function makeToolbox(
  authority: InspectionAuthority,
  textFor?: (name: string) => string,
): InspectionToolbox {
  const tools = (["read", "grep", "find", "ls"] as const).map((name) => ({
    name,
    label: name,
    description: `${name} fixture`,
    parameters: {},
    execute: async (...args: unknown[]) => {
      const input =
        args[1] && typeof args[1] === "object"
          ? (args[1] as Record<string, unknown>)
          : {};
      const text = textFor
        ? textFor(name)
        : `${name} result for ${String(input.path ?? input.pattern ?? "")}`;
      return { content: [{ type: "text", text }] };
    },
  }));
  return { tools, unavailable: [], ceiling: authority };
}

function validResult(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    candidate:
      "# Objective\n\nImprove how the child-session lifecycle is described.\n\n## Constraints\n\n- Keep the existing public behaviour.",
    changeSummary: ["Clarified the objective and grouped the constraints."],
    suggestions: [],
    language: "en",
    ...overrides,
  };
}

const QUESTION = {
  prompt: "Should this stay a coding request?",
  header: "Scope",
  options: [{ label: "Keep it coding", recommended: true }],
};

const ASK_RESULT = {
  kind: "finished" as const,
  answers: [
    {
      questionId: "q-1-1",
      prompt: QUESTION.prompt,
      header: "Scope",
      answer: "Keep it coding",
    },
  ],
};

// ── Fake child session ───────────────────────────────────────────────

type SessionScript = (
  session: FakeSession,
  prompt: string,
) => Promise<void> | void;

class FakeSession implements RefinementChildSession {
  sessionId = "child-session-1";
  modelLabel = "fake/model";
  tools: RefinerToolDefinition[];
  prompts: string[] = [];
  disposed = false;
  aborted = false;
  unsubscribeCount = 0;
  listeners = new Set<(event: unknown) => void>();
  script: SessionScript;

  constructor(tools: readonly RefinerToolDefinition[], script: SessionScript) {
    this.tools = [...tools];
    this.script = script;
  }

  subscribe(listener: (event: unknown) => void): () => void {
    this.listeners.add(listener);
    return () => {
      if (this.listeners.delete(listener)) this.unsubscribeCount += 1;
    };
  }

  emit(event: unknown): void {
    for (const listener of [...this.listeners]) listener(event);
  }

  async prompt(text: string): Promise<void> {
    this.prompts.push(text);
    this.emit({ type: "agent_start" });
    try {
      await this.script(this, text);
    } finally {
      if (!this.disposed) this.emit({ type: "agent_settled" });
    }
  }

  async abort(): Promise<void> {
    this.aborted = true;
  }

  isStreaming(): boolean {
    return false;
  }

  dispose(): void {
    this.disposed = true;
  }

  tool(name: string): RefinerToolDefinition {
    const tool = this.tools.find((candidate) => candidate.name === name);
    assert.ok(tool, `the child has no ${name} tool`);
    return tool;
  }

  async call(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ) {
    return await this.tool(name).execute("call-1", args, signal);
  }
}

function resultText(result: unknown): string {
  const record =
    result && typeof result === "object"
      ? (result as { content?: unknown[] })
      : {};
  return Array.isArray(record.content)
    ? record.content
        .map((block) =>
          block &&
          typeof block === "object" &&
          typeof (block as { text?: unknown }).text === "string"
            ? (block as { text: string }).text
            : "",
        )
        .join("\n")
    : "";
}

function isToolError(result: unknown): boolean {
  return (
    Boolean(result) &&
    typeof result === "object" &&
    (result as { isError?: unknown }).isError === true
  );
}

// ── Fake clock ───────────────────────────────────────────────────────

interface FakeClock extends RefinementRuntimeClock {
  advance(ms: number): void;
  pending(): number;
}

function makeClock(): FakeClock {
  let now = 0;
  let sequence = 0;
  const timers = new Map<number, { at: number; run: () => void }>();
  return {
    now: () => now,
    setTimeout(run, ms) {
      sequence += 1;
      timers.set(sequence, { at: now + Math.max(0, ms), run });
      return sequence;
    },
    clearTimeout(handle) {
      timers.delete(handle as number);
    },
    advance(ms) {
      const target = now + Math.max(0, ms);
      for (;;) {
        let nextId: number | undefined;
        let nextAt = Number.POSITIVE_INFINITY;
        for (const [id, timer] of timers) {
          if (timer.at <= target && timer.at < nextAt) {
            nextAt = timer.at;
            nextId = id;
          }
        }
        if (nextId === undefined) break;
        const timer = timers.get(nextId)!;
        timers.delete(nextId);
        now = timer.at;
        timer.run();
      }
      now = target;
    },
    pending: () => timers.size,
  };
}

const tick = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

async function waitFor(
  predicate: () => boolean,
  message = "condition",
): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await tick();
  }
  assert.fail(`timed out waiting for ${message}`);
}

// ── Harness ──────────────────────────────────────────────────────────

interface HarnessOptions {
  script: SessionScript;
  authority?: InspectionAuthority;
  limits?: Partial<RefinementRuntimeLimits>;
  ask?: RefinerAskPort;
  deliver?: RefinementDeliveryPort;
  input?: {
    originalText?: string;
    suggestionsAllowed?: boolean;
    purpose?: string;
  };
  signal?: AbortSignal;
  resolveModel?: RefinementRuntimeDeps["resolveModel"];
  prepareContext?: RefinementRuntimeDeps["prepareContext"];
  createSession?: RefinementSessionFactory;
  toolboxText?: (name: string) => string;
  clock?: FakeClock;
}

interface Harness {
  runtime: RefinementRuntime;
  child?: FakeSession;
  request?: RefinementSessionRequest;
  deliverCalls: Array<{
    candidate: RefinementCandidate;
    context: RefinementDeliveryContext;
  }>;
  askCalls: unknown[][];
  askSignals: AbortSignal[];
  events: string[];
  resolveModelCalls: number;
  prepareContextCalls: number;
  authority(): InspectionAuthority;
  setAuthority(next: InspectionAuthority): void;
  start(): Promise<RefinementRunResult>;
  clock?: FakeClock;
}

function makeHarness(options: HarnessOptions): Harness {
  let authority = options.authority ?? makeAuthority();
  const deliverCalls: Harness["deliverCalls"] = [];
  const askCalls: unknown[][] = [];
  const askSignals: AbortSignal[] = [];
  const events: string[] = [];

  const harness: Harness = {
    runtime: undefined as unknown as RefinementRuntime,
    deliverCalls,
    askCalls,
    askSignals,
    events,
    resolveModelCalls: 0,
    prepareContextCalls: 0,
    authority: () => authority,
    setAuthority: (next) => {
      authority = next;
    },
    start: async () => await harness.runtime.start(),
    ...(options.clock ? { clock: options.clock } : {}),
  };

  const defaultDeliver: RefinementDeliveryPort = (candidate, context) => {
    deliverCalls.push({ candidate, context });
    return { ok: true };
  };

  const ask: RefinerAskPort | undefined = options.ask
    ? async (questions, askOptions) => {
        askCalls.push(questions as unknown[]);
        if (askOptions?.signal) askSignals.push(askOptions.signal);
        return await options.ask!(questions, askOptions);
      }
    : undefined;

  const deps: RefinementRuntimeDeps = {
    operationId: "op-1",
    sessionId: "parent-session",
    bindingId: "binding-1",
    cwd: ROOT,
    input: {
      originalText: options.input?.originalText ?? ORIGINAL,
      ...(options.input?.suggestionsAllowed === undefined
        ? {}
        : { suggestionsAllowed: options.input.suggestionsAllowed }),
      ...(options.input?.purpose ? { purpose: options.input.purpose } : {}),
    },
    authority: () => authority,
    resolveModel: () => {
      harness.resolveModelCalls += 1;
      return options.resolveModel
        ? options.resolveModel()
        : {
            ok: true,
            model: {
              provider: "fake",
              id: "model",
              thinking: "medium",
              input: ["text", "image"],
              inputCapabilityKnown: true,
            },
          };
    },
    prepareContext: options.prepareContext
      ? (input) => {
          harness.prepareContextCalls += 1;
          return options.prepareContext!(input);
        }
      : undefined,
    createSession: (request) => {
      harness.request = request;
      if (options.createSession) return options.createSession(request);
      const child = new FakeSession(request.tools, options.script);
      harness.child = child;
      return { ok: true, session: child };
    },
    inspection: makeToolbox(authority, options.toolboxText),
    ask,
    deliver: options.deliver ?? defaultDeliver,
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.limits ? { limits: options.limits } : {}),
    ...(options.clock
      ? {
          now: options.clock.now,
          clock: {
            now: options.clock.now,
            setTimeout: options.clock.setTimeout,
            clearTimeout: options.clock.clearTimeout,
          },
        }
      : {}),
    onEvent: (event) => {
      events.push(event.type);
    },
  };

  harness.runtime = createRefinementRuntime(deps);
  return harness;
}

// ── Pure helper tests ────────────────────────────────────────────────

test("question keys ignore ordering/whitespace and detect a repeated round", () => {
  const first = refinementQuestionKey([
    { prompt: "Should this stay  a coding request?", options: [] },
    { prompt: "Which term is correct?", options: [] },
  ]);
  const second = refinementQuestionKey([
    { prompt: "which term is correct?", options: [] },
    { prompt: "Should this stay a coding request?", options: [] },
  ]);
  assert.equal(first, second);
});

test("scope helpers separate approved answers from unapproved claims", () => {
  assert.deepEqual(detectApprovedScopeChanges([]), []);
  assert.equal(detectApprovedScopeChanges([{ answer: "Keep it coding" }]).length, 0);
  assert.equal(
    detectApprovedScopeChanges([{ answer: "Also implement CSV export" }]).length,
    1,
  );
  assert.equal(
    detectUnapprovedScopeExpansion(
      ["Added a new deliverable: also implement CSV export"],
      [],
    ),
    "Added a new deliverable: also implement CSV export",
  );
  assert.equal(
    detectUnapprovedScopeExpansion(
      ["Added a new deliverable: also implement CSV export"],
      ["Also implement CSV export"],
    ),
    undefined,
  );
});

test("provider failures are decoded structurally and aborts are not provider health", () => {
  assert.deepEqual(readRefinementProviderFailure({ type: "agent_start" }), {
    kind: "none",
  });
  assert.equal(
    readRefinementProviderFailure({
      type: "agent_end",
      messages: [
        { role: "assistant", stopReason: "error", errorMessage: "rate limited" },
      ],
    }).kind,
    "stop",
  );
  assert.equal(
    readRefinementProviderFailure({
      type: "agent_end",
      messages: [
        {
          role: "assistant",
          stopReason: "error",
          errorMessage: "This operation was aborted",
        },
      ],
    }).kind,
    "aborted",
  );
  assert.deepEqual(
    readRefinementProviderFailure({
      type: "auto_retry_end",
      success: false,
      finalError: "gateway 502",
    }),
    { kind: "stop", message: "gateway 502" },
  );
});

// ── Happy path ───────────────────────────────────────────────────────

test("inspect → ask → compose → submit delivers one validated candidate without executing it", async () => {
  const clock = makeClock();
  let secondSubmission: unknown;
  const harness = makeHarness({
    clock,
    ask: async () => ASK_RESULT,
    script: async (session) => {
      const read = await session.call("read", { path: "src/session.ts" });
      assert.equal(isToolError(read), false);
      const asked = await session.call("prompt_ask", {
        questions: [QUESTION],
      });
      assert.equal(isToolError(asked), false);
      const submitted = await session.call(
        "prompt_submit",
        validResult({
          terminology: [
            {
              from: "sub-session",
              to: "child-session",
              evidenceId: "ev-1",
              reason: "the codebase uses child-session",
            },
          ],
        }),
      );
      assert.equal(isToolError(submitted), false);
      secondSubmission = await session.call("prompt_submit", validResult());
    },
  });

  const result = await harness.start();
  await tick();

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.outcome, "delivered");
  assert.equal(harness.deliverCalls.length, 1);
  const delivered = harness.deliverCalls[0]!;
  assert.equal(delivered.candidate.candidate, validResult().candidate);
  assert.equal(delivered.candidate.language, "en");
  assert.equal(delivered.context.originalText, ORIGINAL);
  assert.ok(
    delivered.candidate.evidenceIds.includes("ev-1"),
    "the cited file evidence is bound to the candidate",
  );
  assert.equal(result.usage.providerRequests, 1);
  assert.equal(result.usage.inspectionCalls, 1);
  assert.equal(result.usage.questionRounds, 1);
  assert.equal(result.usage.answersReceived, 1);
  assert.equal(harness.resolveModelCalls, 1);
  assert.equal(harness.askCalls.length, 1);
  assert.equal(harness.runtime.intent().decisions.length, 1);
  assert.deepEqual(
    harness.runtime.intent().evidence.map((record) => record.kind).sort(),
    ["answer", "file"],
  );
  assert.match(result.intent.decisions[0]!.answer, /Keep it coding/);
  assert.equal(result.model, "fake/model");

  // The candidate is composer text, never a parent prompt.
  const child = harness.child!;
  assert.equal(
    child.prompts.some((prompt) => prompt.includes(delivered.candidate.candidate)),
    false,
  );
  assert.equal(
    child.prompts.length,
    1,
    "a submitted operation must not send another provider request",
  );

  // One accepted candidate only; the second call is refused because the
  // operation is closed.
  assert.equal(isToolError(secondSubmission), true);
  assert.equal(harness.deliverCalls.length, 1);

  // Every event is visible to the host.
  for (const type of [
    "started",
    "provider-request",
    "inspection",
    "question",
    "answer",
    "candidate",
    "delivered",
    "disposed",
  ]) {
    assert.ok(harness.events.includes(type), `missing ${type} event`);
  }

  // Cleanup on success.
  assert.equal(child.disposed, true);
  assert.equal(child.aborted, true);
  assert.equal(child.unsubscribeCount, 1);
  assert.equal(clock.pending(), 0);
});

// ── Budgets ──────────────────────────────────────────────────────────

test("model-turn budget stops the operation before another provider request", async () => {
  const harness = makeHarness({
    limits: { maxModelTurns: 1, maxContinuationPrompts: 2 },
    script: async (session) => {
      // The fake `prompt` already emitted one agent_start; emit a second.
      session.emit({ type: "agent_start" });
    },
  });

  const result = await harness.start();
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "budget-exhausted");
  assert.match(result.message, /model budget/);
  assert.equal(harness.deliverCalls.length, 0);
  assert.equal(result.retryPreserved, true);
  assert.equal(result.originalText, ORIGINAL);
});

test("inspection budget stops a looping inspection without reading again", async () => {
  let reads = 0;
  const harness = makeHarness({
    limits: { maxInspectionCalls: 1 },
    script: async (session) => {
      reads += 1;
      await session.call("read", { path: "src/a.ts" });
      reads += 1;
      const second = await session.call("read", { path: "src/b.ts" });
      assert.equal(isToolError(second), true);
      assert.match(resultText(second), /budget exhausted/);
    },
  });

  const result = await harness.start();
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "budget-exhausted");
  assert.match(result.message, /inspection budget/);
  assert.equal(result.usage.inspectionCalls, 1);
  assert.equal(reads, 2);
  assert.equal(harness.deliverCalls.length, 0);
});

test("question-round budget never presents a second round", async () => {
  const harness = makeHarness({
    limits: { maxQuestionRounds: 1, maxContinuationPrompts: 0 },
    ask: async () => ASK_RESULT,
    script: async (session) => {
      await session.call("prompt_ask", { questions: [QUESTION] });
      const second = await session.call("prompt_ask", {
        questions: [{ ...QUESTION, prompt: "A different follow-up?" }],
      });
      assert.equal(isToolError(second), true);
    },
  });

  const result = await harness.start();
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "no-candidate");
  assert.equal(harness.askCalls.length, 1);
  assert.equal(result.usage.questionRounds, 1);
  assert.equal(harness.deliverCalls.length, 0);
});

test("active-time budget excludes waiting for the user but fires while working", async () => {
  const clock = makeClock();
  const ask: RefinerAskPort = async () => {
    clock.advance(5_000);
    return ASK_RESULT;
  };
  const harness = makeHarness({
    clock,
    ask,
    limits: { maxActiveMs: 3_000 },
    script: async (session) => {
      await session.call("prompt_ask", { questions: [QUESTION] });
      await session.call("prompt_submit", validResult());
    },
  });

  const result = await harness.start();
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.ok(
    result.usage.waitingForUserMs >= 5_000,
    `waitingForUserMs=${result.usage.waitingForUserMs}`,
  );
  assert.ok(
    result.usage.activeMs < 3_000,
    `activeMs=${result.usage.activeMs} must exclude the questionnaire`,
  );
  assert.equal(clock.pending(), 0);
});

test("active-time budget aborts a provider request that never settles", async () => {
  const clock = makeClock();
  let release: (() => void) | undefined;
  const harness = makeHarness({
    clock,
    limits: { maxActiveMs: 1_000 },
    script: async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    },
  });

  const run = harness.start();
  await waitFor(
    () => (harness.child?.prompts.length ?? 0) === 1,
    "initial provider request",
  );
  clock.advance(1_000);
  const result = await run;
  release?.();
  await tick();

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "budget-exhausted");
  assert.match(result.message, /active-time budget/);
  assert.equal(harness.deliverCalls.length, 0);
  assert.equal(clock.pending(), 0);
  assert.equal(harness.child?.disposed, true);
});

// ── No progress / repetition ─────────────────────────────────────────

test("no-progress turns stop instead of prompting forever", async () => {
  const harness = makeHarness({
    limits: { maxStalledTurns: 2, maxContinuationPrompts: 5 },
    script: async () => {
      // A silent model turn: no inspection, question or submission.
    },
  });

  const result = await harness.start();
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "no-progress");
  assert.match(result.message, /stopped instead of looping/);
  assert.equal(harness.deliverCalls.length, 0);
  assert.ok((result.usage.promptSends ?? 0) >= 2);
});

test("a repeated question round is refused and closes the operation", async () => {
  const harness = makeHarness({
    ask: async () => ASK_RESULT,
    limits: { maxContinuationPrompts: 2 },
    script: async (session) => {
      await session.call("prompt_ask", { questions: [QUESTION] });
      const repeated = await session.call("prompt_ask", {
        questions: [QUESTION],
      });
      assert.equal(isToolError(repeated), true);
      assert.match(resultText(repeated), /already asked/);
    },
  });

  const result = await harness.start();
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "repeated-question");
  assert.equal(harness.askCalls.length, 1, "the user is never asked twice");
  assert.equal(harness.deliverCalls.length, 0);
});

test("a settling-but-silent model ends as no-candidate after bounded continuations", async () => {
  const harness = makeHarness({
    limits: { maxStalledTurns: 5, maxContinuationPrompts: 1 },
    script: async (session) => {
      await session.call("read", { path: "src/a.ts" });
    },
  });

  const result = await harness.start();
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "no-candidate");
  assert.match(result.message, /draft was preserved/);
  assert.equal(harness.deliverCalls.length, 0);
});

// ── Provider errors / bootstrap ──────────────────────────────────────

test("a provider error fails honestly and never produces a candidate", async () => {
  const harness = makeHarness({
    script: async (session) => {
      session.emit({
        type: "agent_end",
        messages: [
          {
            role: "assistant",
            stopReason: "error",
            errorMessage: "upstream 503 while composing",
          },
        ],
      });
    },
  });

  const result = await harness.start();
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "provider-error");
  assert.match(result.message, /upstream 503/);
  assert.equal(harness.deliverCalls.length, 0);
});

test("model resolution failure refuses instead of borrowing another model", async () => {
  const harness = makeHarness({
    resolveModel: () => ({
      ok: false,
      reason: "no Default-mode model is known — refusing to pick an unrelated model",
    }),
    script: async () => {
      assert.fail("no child session may be created without a model");
    },
  });

  const result = await harness.start();
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "model-unavailable");
  assert.match(result.message, /refusing/);
  assert.equal(harness.request, undefined);
  assert.equal(harness.events.includes("started"), false);
});

test("session creation failure is reported without a fallback child", async () => {
  const harness = makeHarness({
    script: async () => assert.fail("no script may run"),
    createSession: () => ({ ok: false, error: "provider auth is missing" }),
  });

  const result = await harness.start();
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "session-unavailable");
  assert.match(result.message, /provider auth is missing/);
  assert.equal(harness.deliverCalls.length, 0);
});

// ── No repo / no relevant code ───────────────────────────────────────

test("an untrusted project still refines, discloses the missing inspection, and does not pretend to inspect", async () => {
  const authority = makeAuthority({ trusted: false });
  const harness = makeHarness({
    authority,
    script: async (session) => {
      await session.call("prompt_submit", validResult());
    },
  });

  const result = await harness.start();
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.outcome, "delivered");
  assert.ok(
    result.disclosures.some((line) => /not trusted/i.test(line)),
    "the user must be told inspection was unavailable",
  );
  assert.equal(result.intent.evidence.length, 0);
  assert.equal(result.usage.inspectionCalls, 0);
});

test("no relevant repository code composes the prompt without inventing evidence", async () => {
  const harness = makeHarness({
    toolboxText: () => "No matches found.",
    script: async (session) => {
      const read = await session.call("read", { path: "docs/empty.md" });
      assert.equal(isToolError(read), false);
      assert.match(resultText(read), /No matches/);
      await session.call(
        "prompt_submit",
        validResult({
          changeSummary: ["Kept the original wording; no code evidence was needed."],
        }),
      );
    },
  });

  const result = await harness.start();
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.outcome, "delivered");
  assert.equal(result.usage.inspectionCalls, 1);
  assert.equal(result.intent.evidence.length, 1);
  assert.match(result.intent.evidence[0]!.summary, /No matches/);
  assert.equal(harness.deliverCalls.length, 1);
});

// ── Scope-changing answers ───────────────────────────────────────────

test("an approved scope-changing answer is recorded and allows the matching change", async () => {
  const harness = makeHarness({
    ask: async () => ({
      kind: "finished",
      answers: [
        {
          questionId: "q-1-1",
          prompt: "Should the archive export be included?",
          answer: "Also implement CSV export for the archive",
        },
      ],
    }),
    script: async (session) => {
      await session.call("prompt_ask", {
        questions: [
          {
            prompt: "Should the archive export be included?",
            options: [{ label: "No, keep scope" }],
          },
        ],
      });
      await session.call(
        "prompt_submit",
        validResult({
          changeSummary: [
            "Added a new deliverable: also implement CSV export for the archive.",
          ],
        }),
      );
    },
  });

  const result = await harness.start();
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.intent.decisions.length, 1);
  assert.equal(result.intent.decisions[0]!.scopeChange, true);
  assert.ok(
    result.disclosures.some((line) => /approved a scope change/i.test(line)),
  );
  assert.equal(harness.deliverCalls.length, 1);
});

test("an unapproved scope expansion is refused and preserves the draft", async () => {
  const harness = makeHarness({
    script: async (session) => {
      const refused = await session.call(
        "prompt_submit",
        validResult({
          changeSummary: [
            "Added a new deliverable: also implement CSV export for the archive.",
          ],
        }),
      );
      assert.equal(isToolError(refused), true);
      assert.match(resultText(refused), /never approved/);
    },
  });

  const result = await harness.start();
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "unapproved-scope-expansion");
  assert.equal(harness.deliverCalls.length, 0);
  assert.equal(result.retryPreserved, true);
  assert.equal(result.originalText, ORIGINAL);
});

// ── Empty / truncated / aborted prose ────────────────────────────────

test("empty prose is refused by the schema and a later valid candidate is the only delivery", async () => {
  let emptyAttempt: unknown;
  const harness = makeHarness({
    script: async (session) => {
      emptyAttempt = await session.call(
        "prompt_submit",
        validResult({ candidate: "   " }),
      );
      assert.equal(isToolError(emptyAttempt), true);
      await session.call("prompt_submit", validResult({ candidate: "Short" }));
    },
  });

  const result = await harness.start();
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(harness.deliverCalls.length, 1);
  assert.equal(harness.deliverCalls[0]!.candidate.candidate, "Short");
  assert.match(resultText(emptyAttempt), /invalid|empty/i);
});

test("an over-limit candidate is refused and truncated prose is never delivered", async () => {
  let refusal: unknown;
  const harness = makeHarness({
    limits: { maxCandidateChars: 10 },
    script: async (session) => {
      refusal = await session.call(
        "prompt_submit",
        validResult({ candidate: "This candidate is much longer than ten characters." }),
      );
      assert.equal(isToolError(refusal), true);
      await session.call("prompt_submit", validResult({ candidate: "Short" }));
    },
  });

  const result = await harness.start();
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(harness.deliverCalls[0]!.candidate.candidate, "Short");
  assert.match(resultText(refusal), /candidate/);
});

test("an aborted composition never delivers its in-flight candidate", async () => {
  const harness = makeHarness({
    script: async (session) => {
      await session.call("read", { path: "src/a.ts" });
      // Simulate a host cancellation arriving before the model can submit.
      harness.runtime.cancel("user pressed Esc");
      const late = await session.call("prompt_submit", validResult());
      assert.equal(isToolError(late), true);
    },
  });

  const result = await harness.start();
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "cancelled");
  assert.equal(harness.deliverCalls.length, 0);
  assert.equal(result.retryPreserved, true);
  assert.equal(result.originalText, ORIGINAL);
});

test("a host delivery refusal leaves the operation unapplied and the draft preserved", async () => {
  const harness = makeHarness({
    deliver: (_candidate, _context): RefinementDeliveryOutcome => ({
      ok: false,
      error: "the composer changed while the candidate was being applied",
    }),
    script: async (session) => {
      await session.call("prompt_submit", validResult());
    },
  });

  const result = await harness.start();
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "delivery-refused");
  assert.match(result.message, /composer changed/);
  assert.equal(harness.deliverCalls.length, 0);
  assert.equal(result.retryPreserved, true);
});

// ── Revocation / invalidation ────────────────────────────────────────

test("grant narrowing during a questionnaire invalidates before delivery and preserves the draft", async () => {
  let runtimeRef: RefinementRuntime | undefined;
  const harness = makeHarness({
    ask: async () => {
      harness.setAuthority(makeAuthority({ grants: [] , trusted: false }));
      runtimeRef?.handleLocalPolicyChange("read grants were revoked");
      return ASK_RESULT;
    },
    script: async (session) => {
      await session.call("prompt_ask", { questions: [QUESTION] });
      const late = await session.call("prompt_submit", validResult());
      assert.equal(isToolError(late), true);
    },
  });
  runtimeRef = harness.runtime;

  const result = await harness.start();
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "invalidated-policy-narrowed");
  assert.match(result.message, /narrowed|read grants/);
  assert.equal(harness.deliverCalls.length, 0);
  assert.equal(result.retryPreserved, true);
  assert.equal(result.originalText, ORIGINAL);
  assert.equal(harness.child?.disposed, true);
  assert.equal(
    harness.askSignals[0]?.aborted,
    true,
    "an outstanding question must be released on invalidation",
  );
});

test("revocation during a provider request withholds the late tool completion", async () => {
  let late: unknown;
  const harness = makeHarness({
    script: async (session) => {
      harness.setAuthority(
        makeAuthority({ config: { excludePaths: ["src"] } }),
      );
      session.emit({ type: "agent_settled" });
      await tick();
      late = await session.call("prompt_submit", validResult({ candidate: "Late candidate" }));
    },
  });

  const result = await harness.start();
  await tick();
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "invalidated-policy-narrowed");
  assert.equal(harness.deliverCalls.length, 0);
  assert.equal(isToolError(late), true);
  assert.match(resultText(late), /refused|closed|invalid|finished|policy/i);
});

test("a widened grant after file evidence does not resend stale data", async () => {
  const harness = makeHarness({
    script: async (session) => {
      await session.call("read", { path: "src/a.ts" });
      harness.setAuthority(
        makeAuthority({ grants: ["C:/Users/Lenovo/elsewhere"] }),
      );
    },
  });

  const result = await harness.start();
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "invalidated-policy-generation");
  assert.match(result.message, /previous policy generation/);
  assert.equal(harness.deliverCalls.length, 0);
  assert.equal(result.retryPreserved, true);
});

test("a local policy command invalidates immediately, before the next boundary", async () => {
  const harness = makeHarness({
    script: async (session) => {
      harness.setAuthority(makeAuthority({ trusted: false }));
      const status = harness.runtime.handleLocalPolicyChange(
        "the project trust toggle was turned off",
      );
      assert.equal(status.ok, false);
      assert.equal(status.narrowed, true);
      const late = await session.call("prompt_submit", validResult());
      assert.equal(isToolError(late), true);
    },
  });

  const result = await harness.start();
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "invalidated-policy-narrowed");
  assert.match(result.message, /trust toggle/);
  assert.equal(harness.deliverCalls.length, 0);
});

test("a local policy command invalidates even when it only widens authority", async () => {
  const harness = makeHarness({
    script: async (session) => {
      await session.call("read", { path: "src/a.ts" });
      harness.setAuthority(
        makeAuthority({ grants: ["C:/Users/Lenovo/elsewhere"] }),
      );
      const status = harness.runtime.handleLocalPolicyChange(
        "a local read grant was added",
      );
      assert.equal(status.ok, false);
      const late = await session.call("prompt_submit", validResult());
      assert.equal(isToolError(late), true);
    },
  });

  const result = await harness.start();
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "invalidated-policy-generation");
  assert.equal(harness.deliverCalls.length, 0);
  assert.equal(result.retryPreserved, true);
});

// ── Cleanup / late completions ───────────────────────────────────────

test("cancellation aborts the provider request, releases every resource and refuses late prose", async () => {
  const clock = makeClock();
  let release: (() => void) | undefined;
  let late: unknown;
  const harness = makeHarness({
    clock,
    limits: { maxActiveMs: 60_000 },
    script: async (session) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      late = await session.call("prompt_submit", validResult({ candidate: "Late" }));
    },
  });

  const run = harness.start();
  await waitFor(() => harness.child !== undefined, "child creation");
  await waitFor(() => (harness.child?.prompts.length ?? 0) === 1, "initial prompt");
  harness.runtime.cancel("the user cancelled");
  const result = await run;
  release?.();
  await tick();

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "cancelled");
  assert.equal(harness.deliverCalls.length, 0);
  assert.equal(isToolError(late), true);
  assert.equal(harness.child?.disposed, true);
  assert.equal(harness.child?.unsubscribeCount, 1);
  assert.equal(clock.pending(), 0);
});

test("a session that finishes bootstrapping after cancellation is disposed, not used", async () => {
  let resolveCreation:
    | ((value: { ok: true; session: FakeSession }) => void)
    | undefined;
  let factoryCalled = false;
  const harness = makeHarness({
    script: async () => assert.fail("a cancelled bootstrap must not run"),
    createSession: () => {
      factoryCalled = true;
      return new Promise((resolve) => {
        resolveCreation = resolve;
      });
    },
  });

  const run = harness.start();
  await waitFor(() => factoryCalled, "session factory call");
  harness.runtime.cancel("cancelled during bootstrap");
  const result = await run;
  const lateSession = new FakeSession([], async () => undefined);
  resolveCreation?.({ ok: true, session: lateSession });
  await tick();
  await tick();

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "cancelled");
  assert.equal(lateSession.disposed, true);
  assert.equal(harness.deliverCalls.length, 0);
});

test("an external AbortSignal cancels the operation exactly once", async () => {
  const controller = new AbortController();
  const harness = makeHarness({
    signal: controller.signal,
    script: async () => {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 5);
      });
    },
  });

  const run = harness.start();
  await waitFor(() => (harness.child?.prompts.length ?? 0) === 1, "initial prompt");
  controller.abort();
  const result = await run;
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "cancelled");
  assert.equal(harness.deliverCalls.length, 0);
  assert.equal(harness.child?.disposed, true);
});

test("a second start is refused and does not create a second child", async () => {
  const harness = makeHarness({
    script: async (session) => {
      await session.call("prompt_submit", validResult());
    },
  });

  const first = await harness.start();
  const second = await harness.start();
  assert.equal(first.ok, true);
  assert.equal(second.ok, false);
  if (second.ok) return;
  assert.equal(second.reason, "already-started");
});

test("a non-empty draft is required before any model or session work", async () => {
  const harness = makeHarness({
    input: { originalText: "   " },
    script: async () => assert.fail("no child may run"),
  });
  const result = await harness.start();
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "invalid-input");
  assert.equal(harness.resolveModelCalls, 0);
  assert.equal(harness.request, undefined);
});
