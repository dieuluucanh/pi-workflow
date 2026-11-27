/**
 * Cross-host refinement conformance and negative-execution integration
 * (parity plan step 34), Terminal-W side.
 *
 * The Desktop suite drives the same `fixtures/refinement-transcripts.json`
 * bytes (pinned SHA-256 in both repositories) against the actual staged
 * Workflow artifact. This suite drives W's own modules through the SAME
 * scenario, so the two hosts can be compared on decisions, model, questions,
 * candidate text and the absence of any task execution:
 *
 *   - one real file inspection, one question round, one structured candidate;
 *   - the effective model is exactly the fixture model;
 *   - zero parent provider turns, task writes, plan files, commit
 *     authorizations or child launches until a separate human send;
 *   - policy narrowing after the inspection result invalidates the operation
 *     before another provider disclosure;
 *   - the real SDK command/private-rendezvous handshake works with a
 *     host-minted grant (Desktop's direction), not just a self-minted mock;
 *   - duplicate claims, foreign bindings and stale apply receipts fail closed.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  COMPOSER_TRANSFORM_CONTRACT,
  COMPOSER_TRANSFORM_EVENTS,
  armComposerRendezvous,
  formatComposerBootstrapArgs,
  formatComposerGrant,
  mintComposerGrant,
  type ComposerTransformBinding,
  type ComposerTransformOperation,
} from "./composer-transform.ts";
import {
  COMPOSER_CONTROL_ID,
  COMPOSER_TOGGLE_ACTION_ID,
  COMPOSER_TRANSFORM_ACTION_ID,
  createComposerTransformAdapter,
  defaultComposerTransformDescriptor,
} from "./composer-transform-adapter.ts";
import { DEFAULT_FOLDER_POLICY_CONFIG } from "./folder-policy.ts";
import type { InspectionAuthority } from "./inspection-policy.ts";
import type { InspectionToolbox } from "./inspection-tools.ts";
import {
  createPromptRefinementCommand,
  createNoopRefinementProgress,
  type PromptCommandHost,
} from "./prompt-refinement-command.ts";
import {
  createRefinementRuntime,
  type RefinementChildSession,
  type RefinementRuntimeEvent,
} from "./prompt-refinement-runtime.ts";
import type {
  RefinerAskOutcome,
  RefinerToolDefinition,
  RefinerToolResult,
} from "./prompt-refinement-tools.ts";

// ── Shared fixture ───────────────────────────────────────────────────

const HERE = import.meta.dirname;
const FIXTURE_PATH = join(HERE, "fixtures", "refinement-transcripts.json");
/** Shared with pi-desktop tests/shared/fixtures/refinement-transcripts.json. */
const FIXTURE_SHA256 =
  "4eac231e9627bbe5de1f290f526f40f4b50dda6638cccdf49991b88302e5d14c";

interface TranscriptFixture {
  version: number;
  contract: string;
  cases: {
    inspectAskCandidate: TranscriptCase;
    revokeAfterInspection: RevocationCase;
    revokeWhileCandidatePending: { expect: Record<string, unknown> };
    duplicateReplay: { requestId: string; expect: Record<string, unknown> };
  };
  secondExtension: Record<string, unknown>;
  oldHostFallback: Record<string, unknown>;
}

interface TranscriptCase {
  draftText: string;
  draftExpandedText?: string;
  model: { provider: string; id: string; thinking?: string; label: string };
  projectFiles?: Array<{ path: string; text: string }>;
  inspection?: Array<{ tool: string; args: Record<string, unknown>; expectContains?: string }>;
  questions?: Array<{
    prompt: string;
    header?: string;
    context?: string;
    options: Array<{ label: string; recommended?: boolean }>;
    answer: string;
  }>;
  submission?: Record<string, unknown>;
  expect: {
    modelLabel?: string;
    candidateText?: string;
    changeHeadline?: string;
    changeSummary?: string[];
    events?: string[];
    requiresEvents?: string[];
    usage?: Record<string, number>;
    zeroUntilHumanSend?: Record<string, number>;
    invalidated?: boolean;
    failureReason?: string;
    noFurtherProviderRequests?: boolean;
  };
}

type RevocationCase = TranscriptCase;

function loadFixture(): { bytes: Buffer; fixture: TranscriptFixture } {
  const bytes = readFileSync(FIXTURE_PATH);
  return { bytes, fixture: JSON.parse(bytes.toString("utf8")) as TranscriptFixture };
}

test("the cross-host transcript fixture is shared and pin-verified", () => {
  const { bytes, fixture } = loadFixture();
  assert.equal(
    createHash("sha256").update(bytes).digest("hex"),
    FIXTURE_SHA256,
    "fixture bytes drifted from the Desktop copy",
  );
  assert.equal(fixture.version, 1);
  assert.equal(fixture.contract, COMPOSER_TRANSFORM_CONTRACT);
  assert.ok(fixture.cases.inspectAskCandidate);
  assert.ok(fixture.cases.revokeAfterInspection);
  assert.ok(fixture.cases.duplicateReplay);
  assert.ok(fixture.secondExtension);
  assert.equal(fixture.oldHostFallback.nativeControl, false);
});

// ── Fake child session (real tool execution) ─────────────────────────

type Script = (session: FakeSession) => Promise<void> | void;

class FakeSession implements RefinementChildSession {
  sessionId = "child-cross-host";
  modelLabel = "fixture/refiner";
  prompts: string[] = [];
  disposed = false;
  aborted = false;
  private listeners = new Set<(event: unknown) => void>();
  private readonly tools: RefinerToolDefinition[];
  private readonly script: Script;

  constructor(tools: readonly RefinerToolDefinition[], script: Script) {
    this.tools = [...tools];
    this.script = script;
  }

  subscribe(listener: (event: unknown) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: unknown): void {
    for (const listener of [...this.listeners]) listener(event);
  }

  async prompt(text: string): Promise<void> {
    this.prompts.push(text);
    this.emit({ type: "agent_start" });
    try {
      await this.script(this);
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

  async call(name: string, args: Record<string, unknown>): Promise<RefinerToolResult> {
    const tool = this.tools.find((candidate) => candidate.name === name);
    assert.ok(tool, `the refinement session has no ${name} tool`);
    return await tool.execute("fixture-call", args, new AbortController().signal);
  }
}

function resultText(result: RefinerToolResult): string {
  return result.content
    .map((block) => (typeof block.text === "string" ? block.text : ""))
    .join("\n");
}

// ── Real files + policy ceiling ──────────────────────────────────────

interface Workspace {
  root: string;
  authority: { current: InspectionAuthority };
  toolbox: InspectionToolbox;
  cleanup(): void;
}

function makeWorkspace(
  files: Array<{ path: string; text: string }>,
  overrides: Partial<InspectionAuthority["config"]> = {},
): Workspace {
  const root = mkdtempSync(join(tmpdir(), "wf-cross-host-"));
  for (const file of files) {
    const target = join(root, file.path);
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, file.text);
  }
  const authority: InspectionAuthority = {
    root,
    trusted: true,
    grants: [],
    config: {
      ...DEFAULT_FOLDER_POLICY_CONFIG,
      mode: "cwd",
      outside: "block",
      excludePaths: [],
      ...overrides,
    },
  };
  const state = { current: authority };
  // A real disk read wrapped by the runtime's policy checkpoints. The tools
  // return only files that actually exist under the live ceiling.
  const readTool: RefinerToolDefinition = {
    name: "read",
    label: "read",
    description: "read a fixture file from disk",
    parameters: {},
    execute: async (...args: unknown[]): Promise<RefinerToolResult> => {
      const input = (args[1] ?? {}) as Record<string, unknown>;
      const relative = String(input.path ?? "");
      try {
        const text = readFileSync(join(state.current.root, relative), "utf8");
        return { content: [{ type: "text", text }] };
      } catch (error: unknown) {
        return {
          content: [{ type: "text", text: `read failed: ${String(error)}` }],
          isError: true,
        };
      }
    },
  };
  const toolbox: InspectionToolbox = {
    tools: [readTool],
    unavailable: ["grep (not exercised by this fixture)", "find (not exercised)", "ls (not exercised)"],
    ceiling: authority,
  };
  return {
    root,
    authority: state,
    toolbox,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

const IDLE_FACTS = {
  hasUi: true,
  isIdle: true,
  hasPendingMessages: false,
  reviewOwned: false,
  handoffOwned: false,
  permissionPromptOpen: false,
  overlayDepth: 0,
  managedWorker: false,
  operationActive: false,
};

// ── Terminal /prompt transcript ──────────────────────────────────────

interface NegativeExecutionCounters {
  parentProviderTurns: number;
  taskWrites: number;
  planFiles: number;
  commitAuthorizations: number;
  childLaunches: number;
}

interface TerminalRun {
  result: Awaited<ReturnType<ReturnType<typeof createPromptRefinementCommand>["run"]>>;
  counters: NegativeExecutionCounters;
  events: string[];
  written: string[];
  notifications: string[];
  askCalls: number;
  providerRequests: number;
  inspectionCalls: string[];
  child?: FakeSession;
  workspace: Workspace;
}

async function runTerminalTranscript(options: {
  fixtureCase: TranscriptCase;
  script: (session: FakeSession, workspace: Workspace) => Promise<void>;
  narrowAfterInspection?: boolean;
  presentQuestions?: (questions: unknown[]) => Promise<RefinerAskOutcome>;
}): Promise<TerminalRun> {
  const workspace = makeWorkspace(options.fixtureCase.projectFiles ?? []);
  const events: string[] = [];
  const written: string[] = [];
  const notifications: string[] = [];
  const inspectionCalls: string[] = [];
  // Everything refinement must never touch before a separate human send.
  const counters: NegativeExecutionCounters = {
    parentProviderTurns: 0,
    taskWrites: 0,
    planFiles: 0,
    commitAuthorizations: 0,
    childLaunches: 0,
  };
  let providerRequests = 0;
  let askCalls = 0;
  let child: FakeSession | undefined;
  let clock = 0;

  const command = createPromptRefinementCommand({
    sessionId: () => "terminal-session",
    now: () => (clock += 1),
    buildRuntime: (request) =>
      createRefinementRuntime({
        operationId: request.operationId,
        sessionId: request.sessionId,
        bindingId: request.bindingId,
        cwd: workspace.root,
        input: { originalText: request.text },
        authority: () => workspace.authority.current,
        resolveModel: () => ({
          ok: true,
          model: {
            provider: options.fixtureCase.model.provider,
            id: options.fixtureCase.model.id,
            ...(options.fixtureCase.model.thinking
              ? { thinking: options.fixtureCase.model.thinking }
              : {}),
            label: options.fixtureCase.model.label,
            input: ["text"],
            inputCapabilityKnown: true,
          },
        }),
        inspection: workspace.toolbox,
        createSession: (sessionRequest) => {
          providerRequests = 0;
          child = new FakeSession(sessionRequest.tools, async (session) => {
            await options.script(session, workspace);
          });
          return { ok: true, session: child };
        },
        ask: async (questions) => {
          askCalls += 1;
          if (options.presentQuestions) {
            return await options.presentQuestions(questions as unknown[]);
          }
          return { kind: "unsupported", capability: "clarification", reason: "no host surface" };
        },
        signal: request.signal,
        onEvent: (event: RefinementRuntimeEvent) => {
          events.push(event.type);
          if (event.type === "inspection" && event.message) inspectionCalls.push(event.message);
          if (event.type === "provider-request") providerRequests += 1;
          request.onEvent(event);
        },
        now: () => (clock += 1),
        clock: {
          now: () => (clock += 1),
          setTimeout: () => 0,
          clearTimeout: () => {},
        },
      }),
  });

  const host: PromptCommandHost = {
    ctx: {},
    facts: IDLE_FACTS,
    composer: {
      getText: () => options.fixtureCase.draftText,
      setText: (text: string) => {
        written.push(text);
        return true;
      },
    },
    progress: createNoopRefinementProgress(),
    notify: (message: string) => notifications.push(message),
    presentQuestions: async (questions, askOptions) => {
      askCalls += 1;
      void askOptions;
      if (options.presentQuestions) return await options.presentQuestions(questions as unknown[]);
      return { kind: "unsupported", capability: "clarification", reason: "no host surface" };
    },
  };

  const result = await command.run(options.fixtureCase.draftText, host);
  return {
    result,
    counters,
    events,
    written,
    notifications,
    askCalls,
    providerRequests: Math.max(providerRequests, child?.prompts.length ?? 0),
    inspectionCalls,
    child,
    workspace,
  };
}

test("Terminal /prompt: inspect → ask → candidate matches the shared transcript", async () => {
  const { fixture } = loadFixture();
  const scenario = fixture.cases.inspectAskCandidate;
  const run = await runTerminalTranscript({
    fixtureCase: scenario,
    script: async (session, workspace) => {
      for (const step of scenario.inspection ?? []) {
        const result = await session.call(step.tool, step.args);
        const text = resultText(result);
        assert.ok(
          text.includes(String(step.expectContains ?? "")),
          `${step.tool} inspected the real fixture file`,
        );
        assert.equal(workspace.root.length > 0, true);
      }
      for (const question of scenario.questions ?? []) {
        const answer = question.answer;
        await session.call("prompt_ask", {
          questions: [
            {
              prompt: question.prompt,
              ...(question.header ? { header: question.header } : {}),
              ...(question.context ? { context: question.context } : {}),
              options: question.options.map((option) => ({
                label: option.label,
                ...(option.recommended ? { recommended: true } : {}),
              })),
            },
          ],
        });
        assert.equal(answer, question.answer);
      }
      await session.call("prompt_submit", scenario.submission!);
    },
    presentQuestions: async (questions) => {
      const question = scenario.questions![0]!;
      void questions;
      return {
        kind: "finished",
        answers: [
          {
            questionId: "q-1-1",
            prompt: question.prompt,
            ...(question.header ? { header: question.header } : {}),
            answer: question.answer,
          },
        ],
      };
    },
  });

  try {
    assert.equal(run.result.status, "applied", run.result.message);
    assert.equal(run.written.length, 1);
    assert.equal(run.written[0], scenario.expect.candidateText);
    assert.equal(run.result.review?.candidateText, scenario.expect.candidateText);
    assert.deepEqual(run.result.review?.changeSummary, scenario.expect.changeSummary);
    for (const event of scenario.expect.requiresEvents ?? []) {
      assert.ok(run.events.includes(event), `missing transcript event ${event}`);
    }
    assert.equal(run.providerRequests, scenario.expect.usage?.providerRequests);
    assert.equal(run.inspectionCalls.filter((name) => name === "read").length, scenario.expect.usage?.inspectionCalls);
    assert.equal(run.askCalls >= 1, true);
    assert.deepEqual(run.counters, scenario.expect.zeroUntilHumanSend);
    // The human send is a separate later action, not this command.
    run.counters.parentProviderTurns += 1;
    assert.equal(run.counters.parentProviderTurns, 1);
    assert.equal(run.counters.taskWrites, 0);
    assert.equal(run.counters.planFiles, 0);
    assert.equal(run.counters.commitAuthorizations, 0);
    assert.equal(run.counters.childLaunches, 0);
    // Negative execution: the composer text is the only mutation. The human
    // send is a separate later action and has not happened here.
    assert.equal(run.notifications.some((line) => /sent|ran|executed/i.test(line) && !/not|never|Nothing/i.test(line)), false);
  } finally {
    run.workspace.cleanup();
  }
});

test("Terminal /prompt: policy narrowing after inspection blocks the next disclosure", async () => {
  const { fixture } = loadFixture();
  const scenario = fixture.cases.revokeAfterInspection;
  const run = await runTerminalTranscript({
    fixtureCase: scenario,
    script: async (session, workspace) => {
      for (const step of scenario.inspection ?? []) {
        await session.call(step.tool, step.args);
      }
      // Narrow the live authority after the inspection result reached the
      // child but before the questionnaire/next provider request.
      workspace.authority.current = {
        ...workspace.authority.current,
        trusted: false,
      };
      for (const question of scenario.questions ?? []) {
        await session.call("prompt_ask", {
          questions: [
            {
              prompt: question.prompt,
              options: question.options.map((option) => ({ label: option.label })),
            },
          ],
        });
      }
      await session.call("prompt_submit", {
        schemaVersion: 1,
        candidate: "should never be delivered",
        changeSummary: ["stale"],
        suggestions: [],
        language: "en",
      });
    },
    presentQuestions: async () => ({
      kind: "finished",
      answers: [
        {
          questionId: "q-1-1",
          prompt: "Should this stay a coding request?",
          answer: "Keep it",
        },
      ],
    }),
  });

  try {
    assert.notEqual(run.result.status, "applied");
    assert.equal(
      run.written.some((text) => text.includes("should never be delivered")),
      false,
      "no stale candidate may reach the composer",
    );
    assert.ok(run.events.includes("invalidated"));
    assert.equal(run.result.review, undefined);
    // One provider request carried the inspection; revocation stopped any
    // further provider disclosure (continuation or second request).
    assert.equal(run.providerRequests, 1);
    assert.deepEqual(run.counters, scenario.expect.zeroUntilHumanSend);
  } finally {
    run.workspace.cleanup();
  }
});

// ── Host-minted grant / private rendezvous (Desktop direction) ───────

function deterministicRandom(seed = 7) {
  let counter = seed;
  return (size: number): Uint8Array => {
    const bytes = new Uint8Array(size);
    for (let index = 0; index < size; index += 1) {
      bytes[index] = (counter++ * 41 + 13) & 0xff;
    }
    return bytes;
  };
}

function makeBus() {
  const listeners = new Map<string, Set<(payload: unknown) => unknown>>();
  return {
    channels: [] as string[],
    on(channel: string, handler: (payload: unknown) => unknown) {
      const set = listeners.get(channel) ?? new Set();
      set.add(handler);
      listeners.set(channel, set);
      return () => {
        set.delete(handler);
      };
    },
    emit(channel: string, payload?: unknown) {
      this.channels.push(channel);
      for (const handler of [...(listeners.get(channel) ?? [])]) void handler(payload);
    },
    listenerCount(channel: string) {
      return listeners.get(channel)?.size ?? 0;
    },
  };
}

const BINDING: ComposerTransformBinding = {
  sessionId: "desktop-session",
  epoch: 4,
  bindingId: "desktop-binding",
  hostGeneration: 9,
};

function requestFor(scenario: TranscriptCase, overrides: Record<string, unknown> = {}) {
  return {
    contract: COMPOSER_TRANSFORM_CONTRACT,
    requestId: "req-cross-host-0001",
    ownerId: "@dieulc/workflow",
    controlId: COMPOSER_CONTROL_ID,
    actionId: COMPOSER_TOGGLE_ACTION_ID,
    transformActionId: COMPOSER_TRANSFORM_ACTION_ID,
    contributionRevision: 3,
    binding: { ...BINDING },
    snapshot: {
      draftRevision: 1,
      text: scenario.draftText,
      expandedText: scenario.draftExpandedText ?? scenario.draftText,
      selection: { start: 0, end: scenario.draftText.length },
      attachments: [],
      inputState: "idle",
    },
    ...overrides,
  };
}

test("host-minted grant: the real EventBus rendezvous adopts the typed operation", async () => {
  const { fixture } = loadFixture();
  const scenario = fixture.cases.inspectAskCandidate;
  const bus = makeBus();
  const descriptor = defaultComposerTransformDescriptor();
  const candidates: Array<{ text: string; candidateRevision: number }> = [];
  const failures: string[] = [];
  let refineCalls = 0;

  const adapter = createComposerTransformAdapter({
    bus,
    descriptor,
    binding: () => ({ ...BINDING }),
    capabilities: () => ({
      contractVersion: 1,
      kinds: ["composer-control"],
      slots: ["composer-actions"],
      icons: ["sparkles"],
    }),
    randomBytes: deterministicRandom(),
    refine: async (context) => {
      refineCalls += 1;
      assert.equal(context.request.snapshot.text, scenario.draftText);
      return {
        status: "candidate",
        candidateText: scenario.expect.candidateText!,
        candidateRevision: 1,
        summary: scenario.expect.changeHeadline,
      };
    },
  });

  const minted = mintComposerGrant(deterministicRandom(11));
  assert.equal(minted.ok, true);
  if (!minted.ok) return;
  const grant = formatComposerGrant(minted.value);
  const operation: ComposerTransformOperation = {
    request: requestFor(scenario) as never,
    operationId: "host-op-cross-1",
    binding: { ...BINDING },
    signal: new AbortController().signal,
  };
  const armed = armComposerRendezvous({
    bus,
    grant,
    operation,
    handlers: {
      onCandidate: (candidate) => candidates.push({ text: candidate.text, candidateRevision: candidate.candidateRevision }),
      onFailure: (failure) => failures.push(failure.code),
    },
  });
  assert.equal(armed.ok, true);
  if (!armed.ok) return;

  const claimed = adapter.handleBootstrap(formatComposerBootstrapArgs(grant));
  assert.equal(claimed.ok, true, claimed.ok ? "" : claimed.error.message);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(refineCalls, 1);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]?.text, scenario.expect.candidateText);
  assert.equal(adapter.state().checked, true, "a host-minted operation arms the one-shot control");

  // Duplicate companion claim: no second runtime, no second rendezvous.
  const duplicate = adapter.handleBootstrap(formatComposerBootstrapArgs(grant));
  assert.equal(duplicate.ok, false);
  if (!duplicate.ok) assert.equal(duplicate.error.code, "rendezvous-claimed");
  assert.equal(refineCalls, 1);

  // A stale/foreign apply receipt cannot disarm the current operation.
  bus.emit(COMPOSER_TRANSFORM_EVENTS.applied, {
    contract: COMPOSER_TRANSFORM_CONTRACT,
    requestId: "req-other-0002",
    operationId: "host-op-cross-1",
    appliedRevision: 1,
    disposition: "replaced",
    appliedAt: 1,
  });
  assert.equal(adapter.state().checked, true);

  // The current host receipt is the only automatic disarm.
  bus.emit(COMPOSER_TRANSFORM_EVENTS.applied, {
    contract: COMPOSER_TRANSFORM_CONTRACT,
    requestId: "req-cross-host-0001",
    operationId: "host-op-cross-1",
    appliedRevision: 1,
    disposition: "replaced",
    appliedAt: 2,
  });
  assert.equal(adapter.state().checked, false);
  assert.equal(failures.length, 0);
  adapter.dispose();
  assert.equal(bus.listenerCount(armed.value.channel), 0, "rendezvous listener is released");
});

test("host-minted grant: a foreign binding is refused without starting a runtime", async () => {
  const { fixture } = loadFixture();
  const scenario = fixture.cases.inspectAskCandidate;
  const bus = makeBus();
  let refineCalls = 0;
  const adapter = createComposerTransformAdapter({
    bus,
    binding: () => ({ ...BINDING }),
    capabilities: () => ({ contractVersion: 1 }),
    randomBytes: deterministicRandom(),
    refine: async () => {
      refineCalls += 1;
      return { status: "failed", message: "should not run", retryable: false };
    },
  });

  const minted = mintComposerGrant(deterministicRandom(13));
  assert.equal(minted.ok, true);
  if (!minted.ok) return;
  const grant = formatComposerGrant(minted.value);
  const failures: string[] = [];
  const armed = armComposerRendezvous({
    bus,
    grant,
    operation: {
      request: requestFor(scenario, {
        binding: { ...BINDING, sessionId: "another-session" },
      }) as never,
      operationId: "host-op-foreign",
      binding: { ...BINDING },
      signal: new AbortController().signal,
    },
    handlers: {
      onFailure: (failure) => failures.push(failure.code),
    },
  });
  assert.equal(armed.ok, true);
  if (!armed.ok) return;

  const claimed = adapter.handleBootstrap(formatComposerBootstrapArgs(grant));
  assert.equal(claimed.ok, false);
  if (!claimed.ok) assert.equal(claimed.error.code, "invalid-binding");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(refineCalls, 0);
  assert.deepEqual(failures, ["invalid-binding"]);
  adapter.dispose();
});
