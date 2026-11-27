/**
 * `/prompt` command surface (parity plan row 12).
 *
 * These tests pin the outward guarantees: literal arguments, deterministic
 * refusal of every ownership fact, an operation-owned abort/progress lifecycle
 * and a synchronous expected-buffer insert. They also count the paths that must
 * stay at zero — no parent turn, no provider request, no task launch, no mode
 * change, no plan/todo/checkpoint/review/handoff call.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  PROMPT_COMMAND_USAGE,
  createPromptRefinementCommand,
  evaluateRefinementEligibility,
  parsePromptCommandArgs,
  type PromptCommandHost,
  type RefinementEligibilityFacts,
  type RefinementProgressPort,
  type StartRefinementRequest,
} from "./prompt-refinement-command.ts";
import type {
  RefinementCandidate,
  RefinementRunResult,
  RefinementRuntime,
  RefinementRuntimeStage,
} from "./prompt-refinement-runtime.ts";
import type { RefinerAskOutcome } from "./prompt-refinement-tools.ts";

const ORIGINAL = "Update the parser so it keeps /prompt literal.";
const CANDIDATE = "Update the parser so it keeps `/prompt` literal.";

const FACTS: RefinementEligibilityFacts = {
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

function usage(): RefinementRunResult["usage"] {
  return {
    providerRequests: 1,
    promptSends: 1,
    inspectionCalls: 0,
    questionRounds: 0,
    answersReceived: 0,
    inputTokens: 1,
    outputTokens: 1,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 2,
    costTotal: 0,
    activeMs: 1,
    waitingForUserMs: 0,
    startedAt: 1,
    endedAt: 2,
  };
}

function intent(): RefinementRunResult["intent"] {
  return {
    originalText: ORIGINAL,
    intentPoints: ["Keep /prompt literal"],
    constraints: [],
    decisions: [],
    evidence: [],
    suggestions: [],
    unresolved: [],
    truncated: false,
  };
}

function candidateResult(): RefinementRunResult {
  const candidate: RefinementCandidate = {
    schemaVersion: 1,
    candidate: CANDIDATE,
    changeSummary: ["Clarified the request without changing its scope."],
    suggestions: [],
    language: "en",
    digest: "digest-1",
    policyGeneration: "gen-1",
    evidenceIds: [],
    submittedAt: 2,
  };
  return {
    ok: true,
    outcome: "candidate",
    candidate,
    usage: usage(),
    intent: intent(),
    disclosures: [],
    model: "test/model",
    originalText: ORIGINAL,
  };
}

function failureResult(
  reason: "cancelled" | "provider-error",
  message = "the provider failed",
): RefinementRunResult {
  return {
    ok: false,
    reason,
    message,
    usage: usage(),
    intent: intent(),
    disclosures: [],
    model: "test/model",
    retryPreserved: true,
    originalText: ORIGINAL,
  };
}

function makeRuntime(
  result: RefinementRunResult,
  onStart?: () => Promise<void>,
): { runtime: RefinementRuntime } {
  let stage: RefinementRuntimeStage = "idle";
  const runtime: RefinementRuntime = {
    operationId: "test-op",
    get stage() {
      return stage;
    },
    async start() {
      stage = "running";
      try {
        if (onStart) await onStart();
        return result;
      } finally {
        stage = "finished";
      }
    },
    cancel() {
      stage = "finished";
    },
    handleLocalPolicyChange() {
      return { ok: true, generation: "gen-1", narrowed: false, trusted: true, boundary: "test" };
    },
    checkpoint() {
      return { ok: true, generation: "gen-1", narrowed: false, trusted: true, boundary: "test" };
    },
    usage,
    intent,
    disclose() {
      return [];
    },
    dispose() {},
  };
  return { runtime };
}

function makeComposer(initial = "") {
  let text = initial;
  const writes: string[] = [];
  const composer = {
    getText: () => text,
    setText: (next: string) => {
      writes.push(next);
      text = next;
      return true;
    },
    showText: () => {},
    copyText: () => true,
  };
  return {
    composer,
    writes,
    get text() {
      return text;
    },
    set text(next: string) {
      text = next;
    },
  };
}

function makeProgress() {
  const events: string[] = [];
  const progress: RefinementProgressPort = {
    start: (label) => events.push(`start:${label}`),
    update: (label) => events.push(`update:${label}`),
    suspend: () => events.push("suspend"),
    resume: () => events.push("resume"),
    dispose: () => events.push("dispose"),
  };
  return { progress, events };
}

function makeHost(
  overrides: Partial<PromptCommandHost> & {
    composer: PromptCommandHost["composer"];
    progress: PromptCommandHost["progress"];
  },
): PromptCommandHost & { counters: Record<string, number> } {
  const counters: Record<string, number> = {
    parentTurns: 0,
    providerTurns: 0,
    taskLaunches: 0,
    modeChanges: 0,
    planWrites: 0,
    todoWrites: 0,
    checkpointWrites: 0,
    reviewCalls: 0,
    handoffCalls: 0,
  };
  return {
    ctx: { sessionId: "session-1" },
    facts: FACTS,
    notify: () => {},
    presentQuestions: async () => ({ kind: "skipped", reason: "test" }),
    ...overrides,
    counters,
  };
}

function service(
  buildRuntime: Parameters<typeof createPromptRefinementCommand>[0]["buildRuntime"],
) {
  return createPromptRefinementCommand({
    buildRuntime,
    sessionId: () => "session-1",
    now: () => 1000,
  });
}

// ── Literal args / usage ─────────────────────────────────────────────

test("literal args are preserved byte-for-byte and empty args show usage", () => {
  const literal = "Fix `a  b`\n\nKeep /prompt-model inherit and \"quoted text\".";
  const parsed = parsePromptCommandArgs(literal);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.ok && parsed.text, literal);

  const spaced = parsePromptCommandArgs("  keep\ttabs\n ");
  assert.equal(spaced.ok && spaced.text, "keep\ttabs");

  for (const empty of ["", "   ", undefined, null, 42]) {
    const refused = parsePromptCommandArgs(empty);
    assert.equal(refused.ok, false);
    assert.equal(refused.ok === false && refused.usage, PROMPT_COMMAND_USAGE);
  }
});

// ── Eligibility ──────────────────────────────────────────────────────

test("eligibility refuses a managed worker, permission, review, handoff, overlay, busy, queued and headless host", () => {
  const cases: Array<[Partial<RefinementEligibilityFacts>, string]> = [
    [{ managedWorker: true }, "managed-worker"],
    [{ permissionPromptOpen: true }, "permission"],
    [{ reviewOwned: true }, "review"],
    [{ handoffOwned: true }, "handoff"],
    [{ overlayDepth: 1 }, "overlay"],
    [{ operationActive: true }, "operation-active"],
    [{ isIdle: false }, "busy"],
    [{ hasPendingMessages: true }, "queued"],
    [{ hasUi: false }, "unsupported-host"],
  ];
  for (const [patch, code] of cases) {
    const result = evaluateRefinementEligibility({ ...FACTS, ...patch });
    assert.equal(result.ok, false, code);
    assert.equal(result.ok === false && result.code, code);
  }
  assert.deepEqual(evaluateRefinementEligibility(FACTS), { ok: true });
});

test("refused eligibility starts no runtime and does not touch the composer", async () => {
  let built = 0;
  const cmd = service((request) => {
    built += 1;
    return makeRuntime(candidateResult()).runtime;
  });
  const composer = makeComposer("");
  const host = makeHost({
    composer: composer.composer,
    progress: makeProgress().progress,
    facts: { ...FACTS, reviewOwned: true },
  });
  const result = await cmd.run("refine me", host);
  assert.equal(result.status, "refused");
  assert.equal(built, 0);
  assert.equal(composer.writes.length, 0);
});

// ── Success apply ────────────────────────────────────────────────────

test("success inserts one candidate without the command prefix and never sends, launches or changes modes", async () => {
  const cmd = service(() => makeRuntime(candidateResult()).runtime);
  const composer = makeComposer("");
  const progress = makeProgress();
  let suspendCount = 0;
  const wrapped: RefinementProgressPort = {
    ...progress.progress,
    suspend: () => {
      suspendCount += 1;
      progress.progress.suspend();
    },
  };
  const host = makeHost({ composer: composer.composer, progress: wrapped });
  const result = await cmd.run(`  ${ORIGINAL}  `, host);

  assert.equal(result.status, "applied");
  assert.equal(composer.writes.length, 1);
  assert.equal(composer.text, CANDIDATE);
  for (const prefix of ["/prompt ", "/prompt\n"]) {
    assert.equal(composer.text.startsWith(prefix), false);
  }
  assert.equal(suspendCount, 0, "no questionnaire means the progress surface never nests");
  assert.deepEqual(progress.events, ["start:Refining prompt…", "dispose"]);
  assert.equal(cmd.reviewStore.size, 1);
  assert.equal(result.review?.candidateText, CANDIDATE);
  assert.deepEqual(host.counters, {
    parentTurns: 0,
    providerTurns: 0,
    taskLaunches: 0,
    modeChanges: 0,
    planWrites: 0,
    todoWrites: 0,
    checkpointWrites: 0,
    reviewCalls: 0,
    handoffCalls: 0,
  });
});

test("a questionnaire suspends the progress surface first and restores it afterwards", async () => {
  let asked = false;
  const cmd = service((request) =>
    makeRuntime(candidateResult(), async () => {
      asked = true;
      const outcome = await request.ask([
        { prompt: "Which parser?", options: [{ label: "the main one" }] },
      ]);
      assert.equal(outcome.kind, "finished");
    }).runtime,
  );
  const composer = makeComposer("");
  const progress = makeProgress();
  const host = makeHost({
    composer: composer.composer,
    progress: progress.progress,
    presentQuestions: async () => {
      assert.deepEqual(progress.events, ["start:Refining prompt…", "suspend"]);
      return { kind: "finished", answers: [{ prompt: "Which parser?", answer: "the main one" }] };
    },
  });
  const result = await cmd.run(ORIGINAL, host);
  assert.equal(result.status, "applied");
  assert.equal(asked, true);
  assert.deepEqual(progress.events.slice(0, 3), [
    "start:Refining prompt…",
    "suspend",
    "resume",
  ]);
  assert.equal(progress.events[progress.events.length - 1], "dispose");
});

// ── Failure / cancellation recovery ──────────────────────────────────

test("a failure restores the literal draft only when the composer is unchanged", async () => {
  const cmd = service(() => makeRuntime(failureResult("provider-error")).runtime);
  const composer = makeComposer("");
  const host = makeHost({ composer: composer.composer, progress: makeProgress().progress });
  const result = await cmd.run(ORIGINAL, host);
  assert.equal(result.status, "failed");
  assert.equal(result.restored, true);
  assert.equal(composer.text, ORIGINAL);
  assert.equal(composer.writes.length, 1);
  assert.equal(cmd.recover(), undefined);
});

test("a failure never overwrites newer typing and keeps the original recoverable", async () => {
  const cmd = service((request) => {
    // Simulate the user typing while the provider works.
    request.host.composer.setText("newer text");
    return makeRuntime(failureResult("provider-error")).runtime;
  });
  const composer = makeComposer("");
  const host = makeHost({ composer: composer.composer, progress: makeProgress().progress });
  const result = await cmd.run(ORIGINAL, host);
  assert.equal(result.status, "failed");
  assert.equal(result.restored, false);
  assert.equal(result.recoveryKept, true);
  assert.equal(composer.text, "newer text");
  assert.equal(cmd.recover()?.originalText, ORIGINAL);
});

test("a success that races newer typing keeps the candidate recoverable without overwriting", async () => {
  const cmd = service((request) => {
    request.host.composer.setText("newer text");
    return makeRuntime(candidateResult()).runtime;
  });
  const composer = makeComposer("");
  const host = makeHost({ composer: composer.composer, progress: makeProgress().progress });
  const result = await cmd.run(ORIGINAL, host);
  assert.equal(result.status, "conflict");
  assert.equal(composer.text, "newer text");
  assert.equal(result.recoveryKept, true);
  assert.equal(cmd.recover()?.candidateText, CANDIDATE);
  assert.equal(cmd.reviewStore.size, 1);
});

test("cancel aborts the operation-owned controller and restores when the composer is unchanged", async () => {
  let observed: AbortSignal | undefined;
  const cmd = service((request) => {
    observed = request.signal;
    let stage: RefinementRuntimeStage = "idle";
    return {
      operationId: request.operationId,
      get stage() {
        return stage;
      },
      async start() {
        stage = "running";
        await new Promise<void>((resolve) => {
          if (request.signal.aborted) resolve();
          else request.signal.addEventListener("abort", () => resolve(), { once: true });
        });
        stage = "finished";
        return failureResult("cancelled");
      },
      cancel() {
        stage = "finished";
      },
      handleLocalPolicyChange() {
        return { ok: true, generation: "g", narrowed: false, trusted: true, boundary: "test" };
      },
      checkpoint() {
        return { ok: true, generation: "g", narrowed: false, trusted: true, boundary: "test" };
      },
      usage,
      intent,
      disclose() {
        return [];
      },
      dispose() {},
    };
  });
  const composer = makeComposer("");
  const host = makeHost({ composer: composer.composer, progress: makeProgress().progress });
  const pending = cmd.run(ORIGINAL, host);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(cmd.activeOperationId()?.startsWith("refine-"), true);
  assert.equal(cmd.cancelActive(), true);
  const result = await pending;
  assert.equal(observed?.aborted, true);
  assert.equal(result.status, "cancelled");
  assert.equal(result.restored, true);
  assert.equal(composer.text, ORIGINAL);
  assert.equal(cmd.activeOperationId(), undefined);
});

test("a second start is refused while an operation is active and its own lock wins over a stale snapshot", async () => {
  let release: (() => void) | undefined;
  const cmd = service((request) => {
    let stage: RefinementRuntimeStage = "idle";
    return {
      operationId: "op",
      get stage() {
        return stage;
      },
      async start() {
        stage = "running";
        await new Promise<void>((resolve) => {
          release = resolve;
          request.signal.addEventListener("abort", () => resolve(), { once: true });
        });
        stage = "finished";
        return failureResult("provider-error");
      },
      cancel() {
        stage = "finished";
        release?.();
      },
      handleLocalPolicyChange() {
        return { ok: true, generation: "g", narrowed: false, trusted: true, boundary: "test" };
      },
      checkpoint() {
        return { ok: true, generation: "g", narrowed: false, trusted: true, boundary: "test" };
      },
      usage,
      intent,
      disclose() {
        return [];
      },
      dispose() {},
    };
  });
  const composer = makeComposer("");
  const host = makeHost({ composer: composer.composer, progress: makeProgress().progress });
  const first = cmd.run(ORIGINAL, host);
  await new Promise((resolve) => setTimeout(resolve, 5));

  const second = await cmd.run("another", host);
  assert.equal(second.status, "refused");
  assert.match(second.message, /already running/i);
  assert.equal(composer.writes.length, 0);

  cmd.cancelActive();
  await first;
});

test("a late success after cancellation is never applied", async () => {
  let finishRuntime: (() => void) | undefined;
  const cmd = service((request) => {
    let stage: RefinementRuntimeStage = "idle";
    return {
      operationId: "op",
      get stage() {
        return stage;
      },
      async start() {
        stage = "running";
        await new Promise<void>((resolve) => {
          finishRuntime = resolve;
          request.signal.addEventListener("abort", () => resolve(), { once: true });
        });
        stage = "finished";
        return candidateResult();
      },
      cancel() {
        stage = "finished";
      },
      handleLocalPolicyChange() {
        return { ok: true, generation: "g", narrowed: false, trusted: true, boundary: "test" };
      },
      checkpoint() {
        return { ok: true, generation: "g", narrowed: false, trusted: true, boundary: "test" };
      },
      usage,
      intent,
      disclose() {
        return [];
      },
      dispose() {},
    };
  });
  const composer = makeComposer("");
  const host = makeHost({ composer: composer.composer, progress: makeProgress().progress });
  const pending = cmd.run(ORIGINAL, host);
  await new Promise((resolve) => setTimeout(resolve, 5));
  cmd.cancelActive();
  finishRuntime?.();
  const result = await pending;
  assert.equal(result.status, "cancelled");
  assert.equal(composer.text, ORIGINAL);
  assert.equal(cmd.reviewStore.size, 0);
});

test("dispose cancels a live operation and refuses later starts", async () => {
  const cmd = service(() => makeRuntime(failureResult("provider-error")).runtime);
  const composer = makeComposer("");
  const host = makeHost({ composer: composer.composer, progress: makeProgress().progress });
  cmd.dispose();
  const result = await cmd.run(ORIGINAL, host);
  assert.equal(result.status, "refused");
  assert.equal(composer.writes.length, 0);
});

// ── Cancellation during every phase (parity row 22) ──────────────────

function cancellableRuntime(
  request: StartRefinementRequest,
  start: (signal: AbortSignal) => Promise<RefinementRunResult>,
): RefinementRuntime {
  let stage: RefinementRuntimeStage = "idle";
  return {
    operationId: request.operationId,
    get stage() {
      return stage;
    },
    async start() {
      stage = "running";
      try {
        return await start(request.signal);
      } finally {
        stage = "finished";
      }
    },
    cancel() {
      stage = "finished";
    },
    handleLocalPolicyChange() {
      return { ok: true, generation: "g", narrowed: false, trusted: true, boundary: "test" };
    },
    checkpoint() {
      return { ok: true, generation: "g", narrowed: false, trusted: true, boundary: "test" };
    },
    usage,
    intent,
    disclose() {
      return [];
    },
    dispose() {},
  };
}

test("cancel during bootstrap settles the operation without ever applying a candidate", async () => {
  let releaseBuild: ((runtime: RefinementRuntime) => void) | undefined;
  const cmd = service(
    (request) =>
      new Promise((resolve) => {
        releaseBuild = resolve;
      }),
  );
  const composer = makeComposer("");
  const progress = makeProgress();
  const host = makeHost({ composer: composer.composer, progress: progress.progress });
  const pending = cmd.run(ORIGINAL, host);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(cmd.activeOperationId()?.startsWith("refine-"), true);
  assert.equal(cmd.cancelActive(), true);
  assert.deepEqual(progress.events, ["start:Refining prompt…"]);
  releaseBuild?.(makeRuntime(candidateResult()).runtime);
  const result = await pending;
  assert.equal(result.status, "cancelled");
  assert.equal(composer.text, ORIGINAL);
  // Exactly one disposal of the single progress surface.
  assert.deepEqual(
    progress.events.filter((event) => event === "dispose"),
    ["dispose"],
  );
  assert.equal(cmd.reviewStore.size, 0);
});

test("cancel during inspection disposes progress once and forward events keep the model stage observable", async () => {
  const events: Array<{ type: string; message?: string }> = [];
  const cmd = service((request) =>
    cancellableRuntime(request, async (signal) => {
      request.onEvent?.({ type: "started", operationId: request.operationId, at: 1, message: "test/model" });
      request.onEvent?.({ type: "inspection", operationId: request.operationId, at: 2, message: "grep" });
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener("abort", () => resolve(), { once: true });
      });
      request.onEvent?.({ type: "cancelled", operationId: request.operationId, at: 3 });
      return failureResult("cancelled");
    }),
  );
  const composer = makeComposer("");
  const progress = makeProgress();
  const host = makeHost({
    composer: composer.composer,
    progress: progress.progress,
    onEvent: (event) => events.push(event),
  });
  const pending = cmd.run(ORIGINAL, host);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(cmd.cancelActive(), true);
  const result = await pending;
  assert.equal(result.status, "cancelled");
  assert.deepEqual(
    events.map((event) => event.type),
    ["started", "inspection", "cancelled"],
  );
  assert.equal(events[1]?.message, "grep");
  assert.deepEqual(
    progress.events.filter((event) => event === "dispose"),
    ["dispose"],
  );
  assert.deepEqual(progress.events.filter((event) => event.startsWith("start:")), [
    "start:Refining prompt…",
  ]);
});

test("cancel during a question aborts the presenter signal and restores once", async () => {
  let questionSignal: AbortSignal | undefined;
  let asked = 0;
  const cmd = service((request) =>
    cancellableRuntime(request, async () => {
      asked += 1;
      const outcome = await request.ask(
        [{ prompt: "Which term should this keep?", options: [{ label: "child-session" }] }],
        { signal: request.signal },
      );
      assert.equal(outcome.kind, "cancelled");
      return failureResult("cancelled");
    }),
  );
  const composer = makeComposer("");
  const progress = makeProgress();
  const host = makeHost({
    composer: composer.composer,
    progress: progress.progress,
    presentQuestions: async (_questions, options) => {
      questionSignal = options.signal;
      const progressBefore = [...progress.events];
      return new Promise((resolve) => {
        const finish = () =>
          resolve({ kind: "cancelled", reason: "the questionnaire was cancelled" });
        if (options.signal.aborted) finish();
        else options.signal.addEventListener("abort", finish, { once: true });
        // The progress surface is suspended before the question opens.
        assert.deepEqual(progressBefore.slice(-1), ["suspend"]);
      });
    },
  });
  const pending = cmd.run(ORIGINAL, host);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(asked, 1);
  assert.equal(questionSignal?.aborted, false);
  assert.equal(cmd.cancelActive(), true);
  const result = await pending;
  assert.equal(questionSignal?.aborted, true);
  assert.equal(result.status, "cancelled");
  assert.equal(composer.text, ORIGINAL);
  assert.equal(progress.events.filter((event) => event === "dispose").length, 1);
});

test("a double cancel is idempotent: one restore, one dispose and no second apply", async () => {
  const cmd = service((request) =>
    cancellableRuntime(request, async (signal) => {
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener("abort", () => resolve(), { once: true });
      });
      return candidateResult();
    }),
  );
  const composer = makeComposer("");
  const progress = makeProgress();
  const host = makeHost({ composer: composer.composer, progress: progress.progress });
  const pending = cmd.run(ORIGINAL, host);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(cmd.cancelActive(), true);
  assert.equal(cmd.cancelActive(), true);
  const result = await pending;
  assert.equal(result.status, "cancelled");
  assert.equal(composer.writes.length, 1);
  assert.equal(composer.text, ORIGINAL);
  assert.equal(cmd.reviewStore.size, 0);
  assert.equal(progress.events.filter((event) => event === "dispose").length, 1);
});

test("an ignored abort still cannot apply a late success after cancellation", async () => {
  let finishQuestion: (() => void) | undefined;
  const cmd = service((request) =>
    cancellableRuntime(request, async () => {
      // Neither the presenter nor the runtime honours the abort signal.
      await new Promise<void>((resolve) => {
        finishQuestion = resolve;
      });
      return candidateResult();
    }),
  );
  const composer = makeComposer("");
  const progress = makeProgress();
  const host = makeHost({
    composer: composer.composer,
    progress: progress.progress,
    presentQuestions: async () => ({ kind: "skipped", reason: "ignored signal" }),
  });
  const pending = cmd.run(ORIGINAL, host);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(cmd.cancelActive(), true);
  finishQuestion?.();
  const result = await pending;
  assert.equal(result.status, "cancelled");
  assert.equal(composer.text, ORIGINAL);
  assert.equal(cmd.reviewStore.size, 0);
});
