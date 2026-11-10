/**
 * Workflow Extension — Review Mode runtime
 *
 * The orchestrator that ties the pure pieces (review.ts), the tools
 * (review-tools.ts) and the parent extension together.
 *
 * Flow for one Plan↔Review round:
 *
 *   ensureStarted()            create the reviewer session (idempotent)
 *   ├─ gate.reset()            fresh pass-1 slots
 *   ├─ prompt(PASS_1_PROMPT)   review criteria + plan + context + guidance
 *   ├─ await submit + passDone (settle race; optional timeoutMs cap)
 *   ├─ gate.reset()
 *   ├─ prompt(PASS_2_PROMPT)   only when verify is on AND pass 1 was material
 *   └─ await passDone
 *
 * Every failure path returns `{ ok: false, fallback: true }` so the caller can
 * hand the author's original plan to the user: a broken reviewer must never
 * block the plan (config.fallbackOnError = "skip").
 *
 * Decisions are made here in TypeScript, not by asking the model to follow
 * instructions — the reviewer only supplies judgement.
 */

import * as path from "node:path";

import {
  DEFAULT_REVIEW_MODE_CONFIG,
  buildReviewerAttempts,
  createReviewRoundGate,
  createReviewSession,
  createReviewState,
  planHash,
  readProviderErrorEvent,
  reviewNeedsVerification,
  reviewRunLabel,
  truncateErrorText,
  type CreateReviewSessionOptions,
  type CreateReviewSessionResult,
  type ReviewChildSession,
  type ReviewFallbackModel,
  type ReviewModeConfig,
  type ReviewPassResult,
  type ReviewPhase,
  type ReviewRoundGate,
  type ReviewRoundResult,
  type ReviewSdkLoader,
  type ReviewState,
  type ReviewSubmitPayloadLike,
  type ReviewTranscriptOp,
  type ReviewVerdict,
  ReviewTranscript as Transcript,
} from "./review.ts";
import { appendProviderAuthHint } from "./review-providers.ts";
import { isRecoverableProviderFailure } from "./review-recovery.ts";
import { createReviewTools } from "./review-tools.ts";
import { buildPlanDiff, renderReviewContextBlock, type ReviewFinding } from "./utils.ts";

/** Event `type` from a child-session event, or "" for junk. Never throws. */
function readEventType(event: unknown): string {
  const type = (event as { type?: unknown } | undefined)?.type;
  return typeof type === "string" ? type : "";
}

/**
 * Bound for the pre-pass "wait for the previous run to settle" step in
 * unlimited mode. Without a deadline this is the only thing stopping a hung
 * earlier run from blocking pass 1 before the settle race is even armed.
 */
const SETTLE_IN_FLIGHT_FALLBACK_MS = 60_000;

/** What the runtime needs from the parent extension. */
export interface ReviewRuntimeDeps {
  cwd: string;
  agentDir: string;
  config: () => ReviewModeConfig | undefined;
  /** Resolve the reviewer role's model (falls back to the planner when unset). */
  reviewerModel: () =>
    | { provider: string; id: string; thinking: string }
    | undefined;
  /** Automatic fallback models for provider recovery (parent, base reviewer, base planner). */
  fallbackReviewerModels?: () => readonly ReviewFallbackModel[];
  /** Resolve a model from the parent's registry. */
  findModel: (provider: string, id: string) => unknown;
  /**
   * Parent-side provider-registration surface for the reviewer runtime, found
   * with `findParentProviderSurface(ctx)` at session-creation time. Providers
   * the parent knows that the isolated child does not compose yet are seeded
   * onto it before `createAgentSession`. Optional: when absent (or when the
   * probe finds no surface) nothing is seeded and the provider-auth preflight
   * reports the generic escape hatch instead.
   */
  parentProviders?: () => unknown;
  /** Plan path Plan Mode chose (absolute or cwd-relative), if known. */
  planPath: () => string | undefined;
  /** Current plan text on disk, if it exists. */
  readPlan: () => string | undefined;
  /** Pruned parent context entries (from ctx.sessionManager.getBranch()). */
  contextEntries: () => unknown[];
  /**
   * Whether the last Planner manifest carried recon summaries (step 8).
   * When true the reviewer verifies instead of re-exploring: its explore
   * budget is 0. Optional — absent means "no recon".
   */
  hasRecon?: () => boolean;
  /**
   * Planner-context manifest (file inventory + recon) for the pass-1 prompt
   * (step 8). Optional: when absent the reviewer works from the transcript
   * block alone, as before.
   */
  plannerManifest?: () => string;
  /**
   * Resolved reviewer guidance (review-prompt.md, else the built-in default).
   * A function, not a string: the user can edit the file between rounds.
   */
  promptText: () => string;
  /** Read-only reconnaissance runner (explorer role) reused from `explore`. */
  runExplore: (task: string, signal?: AbortSignal) => Promise<string>;
  /** Persist the reviewed plan. */
  writePlan: (input: {
    planPath: string;
    planText: string;
    planBody: string;
    verdict: ReviewVerdict;
    summary: string;
    findings: ReviewFinding[];
    round: number;
    modelLabel: string;
  }) => { ok: boolean; path?: string; error?: string };
  log: (message: string, level?: "info" | "warning" | "error") => void;
  notify: (message: string, level?: "info" | "warning" | "error") => void;
  /** Fired on every state transition (drives the status strip). */
  onState?: (state: ReviewState | undefined) => void;
  /**
   * Fired for every transcript op the reviewer produces, so the parent can
   * stream the review into the main Pi transcript. Best-effort: a throwing
   * callback must never affect the review.
   */
  onTranscriptOps?: (ops: ReviewTranscriptOp[]) => void;
  /** Injected in tests. */
  loadSdk?: ReviewSdkLoader;
}

export interface RunRoundInput {
  planText: string;
  planPath: string;
  round: number;
  /** Findings from the previous round, so pass 2 can assert they were fixed. */
  previousFindings?: ReviewFinding[];
  /**
   * Host abort signal (ESC). When it fires the round stops promptly and the
   * author's plan is kept — the same outcome as the internal abortRound().
   * Linked to the round's own controller; detached when the round ends.
   */
  signal?: AbortSignal;
  /**
   * `/review-resume` is continuing a paused round on the warm session. Only the
   * transcript label needs this: warmth alone cannot express intent, because a
   * next round reuses the same session too.
   */
  resumed?: boolean;
}

export interface ReviewRuntime {
  /** Idempotent: creates the reviewer session if it is not alive. */
  ensureStarted(): Promise<boolean>;
  /** Run one full review round. Never throws. */
  runRound(input: RunRoundInput): Promise<ReviewRoundResult>;
  /** Current state snapshot. */
  getState(): ReviewState | undefined;
  /** Reviewer transcript lines (feeds the main-transcript stream). */
  getTranscript(): string[];
  isAlive(): boolean;
  /** True while `runRound` is in flight — used to route prompt input. */
  isRoundActive(): boolean;
  /** Cancel the in-flight review but keep the session. */
  abortRound(): Promise<void>;
  /**
   * Deliver a message the user typed while Review Mode was the active mode.
   *
   * Returns false when it could not be delivered, so the caller can fall back to
   * the plan agent rather than swallowing the message into the void.
   */
  sendUserMessage(text: string, images?: unknown[]): Promise<boolean>;
  /** Abort and release everything (approve / reload / shutdown). */
  teardown(): Promise<void>;
}

/** Prompt for pass 1: review and rewrite. */
export function buildPass1Prompt(input: {
  planPath: string;
  planText: string;
  reviewPrompt: string;
  contextBlock: string;
  /** Planner-context manifest (step 8): inventory + recon, trusted by default. */
  manifest?: string;
  previousFindings?: ReviewFinding[];
  round: number;
  totalRounds: number;
  verify: boolean;
  /**
   * Max characters per submitted chunk (step 18). `0` disables chunked mode.
   * When set and the plan is longer than two chunks, pass 1 asks for the
   * chunked protocol instead of one oversized response.
   */
  chunkChars?: number;
}): string {
  const chunkChars = input.chunkChars ?? 0;
  const chunked = chunkChars > 0 && input.planText.length > chunkChars * 2;
  const parts: string[] = [
    `[REVIEW MODE — PASS 1 of ${input.verify ? 2 : 1} — round ${input.round}/${input.totalRounds}]`,
    "",
    "Audit the plan below against this repository, then rewrite it and submit the",
    "result with `review_submit_plan`, then call `review_pass_done`.",
    "",
    "## Your review guidance (authoritative)",
    "",
    input.reviewPrompt,
  ];

  if (input.manifest && input.manifest.trim()) {
    parts.push("", input.manifest.trim());
  }

  if (input.contextBlock.trim()) {
    parts.push(
      "",
      "## Plan Mode transcript (abridged)",
      "",
      "The author's own words and tool spew, truncated for size. Prefer the",
      "shared-context inventory above; re-read anything you rely on with",
      "read/grep.",
      "",
      input.contextBlock.trim(),
    );
  }

  parts.push(
    "",
    "## Plan under review",
    "",
    `File: ${input.planPath}`,
    "",
    "```markdown",
    input.planText,
    "```",
  );

  if (input.previousFindings && input.previousFindings.length > 0) {
    parts.push(
      "",
      "## Findings from the previous round",
      "",
      "The author has revised the plan in response. Confirm whether each was",
      "actually addressed, and say so in your findings rather than re-raising it.",
      "",
      ...input.previousFindings.map((f) => {
        const loc = f.file
          ? ` (${f.file}${f.lineRange ? `:${f.lineRange}` : ""})`
          : "";
        // Step 8: carry the rationale so re-review rounds verify instead of
        // re-discovering (clipped — the full text lives in the changelog).
        const why = String(f.rationale ?? "")
          .replace(/\s+/g, " ")
          .trim();
        const clipped = why.length > 200 ? `${why.slice(0, 200)}…` : why;
        return `- [${f.disposition}] ${f.summary}${loc}${clipped ? ` — ${clipped}` : ""}`;
      }),
    );
  }

  parts.push(
    "",
    "## Recovery",
    "",
    "A provider may close this stream before you finish. If the harness retries",
    "this review on another model, start again from the plan below; do not assume",
    "the previous model's transcript is available. Submit the complete rewrite as",
    "soon as it is ready — do not hold it back to add more polish.",
  );

  if (chunked) {
    parts.push(
      "",
      "## Chunked submission (required for this plan)",
      "",
      `This plan is long enough that a single response may be cut off. Send the`,
      `rewrite in ordered chunks of at most ${chunkChars} characters:`,
      "",
      "1. `review_plan_begin` (optionally with `totalChunks`).",
      "2. `review_plan_chunk` with `index` 1, 2, 3, … — never skip or repeat. The",
      "   tool echoes the next expected index; if a chunk is rejected, resend that",
      "   index and continue (accepted chunks are kept).",
      "3. `review_plan_finalize` with your findings, verdict and summary. Nothing is",
      "   written before this call succeeds.",
      "",
      "Do not call `review_submit_plan` with a full `planMarkdown` in this round, and",
      "do not repeat earlier chunks. Split on heading boundaries where possible.",
    );
  }

  parts.push(
    "",
    "## Required output",
    "",
    ...(chunked
      ? [
          "1. `review_plan_begin`, then `review_plan_chunk` for every part of the",
          "   COMPLETE revised plan (readable markdown, original structure preserved,",
          "   no `Review changes` section — it is generated).",
          "2. `review_plan_finalize` with your findings, verdict and summary.",
          "3. `review_pass_done` with the same findings.",
        ]
      : [
          "1. `review_submit_plan` with the COMPLETE revised plan (readable markdown,",
          "   original structure preserved, no `Review changes` section — it is generated).",
          "2. `review_pass_done` with your verdict and the same findings.",
        ]),
    "",
    "You may run read-only and test/lint/typecheck commands, but you cannot build or",
    "write any file other than the plan. Say what you could not verify instead of",
    "assuming it passes.",
  );

  return parts.join("\n");
}

/** Prompt for pass 2: verify the reviewer's own rewrite. */
export function buildPass2Prompt(input: {
  planPath: string;
  originalPlan: string;
  rewrittenPlan: string;
  findings: ReviewFinding[];
}): string {
  // Step 9: pass 2 checks the rewrite against a diff, not two full plans.
  const diff = buildPlanDiff(input.originalPlan, input.rewrittenPlan);
  return [
    "[REVIEW MODE — PASS 2 of 2: VERIFY YOUR OWN REWRITE]",
    "",
    "You just rewrote the plan and submitted it. Now check your own work. This pass",
    "exists because a rewrite can silently drop a requirement the author cared about.",
    "",
    "## What changed (unified diff of your rewrite)",
    "",
    "```diff",
    diff,
    "```",
    "",
    "## Findings you reported",
    "",
    ...(input.findings.length
      ? input.findings.map(
          (f) =>
            `- [${f.disposition}] (severity ${f.severity}) ${f.summary}${f.rationale ? ` — ${f.rationale}` : ""}`,
        )
      : ["- (none reported)"]),
    "",
    "## Check, in order",
    "",
    "1. Is every finding you marked `accepted` actually reflected in the rewrite?",
    "2. Did you drop or weaken any requirement, step, invariant, or verification",
    "   item that was present in the original? List anything lost — this is the most",
    "   important check.",
    "3. Does the rewrite still describe a plan that can be executed without guessing?",
    "",
    "## Required output",
    "",
    "If the rewrite is correct, resubmit it unchanged with an empty findings array and",
    "verdict `approve`. If you lost something or a finding is not addressed, fix it and",
    "resubmit with the corrected plan. Then call `review_pass_done` with pass 2.",
  ].join("\n");
}

export function createReviewRuntime(deps: ReviewRuntimeDeps): ReviewRuntime {
  let session: ReviewChildSession | undefined;
  let state: ReviewState | undefined;
  let transcript: Transcript | undefined;
  let gate: ReviewRoundGate = createReviewRoundGate();
  let starting: Promise<EnsureSessionResult> | undefined;
  let abortController: AbortController | undefined;
  /** `provider/id/thinking` the live session was created with (step 10). */
  let sessionModelKey: string | undefined;
  /** True while `runRound` is in flight (gates prompt routing). */
  let roundActive = false;
  /**
   * The reviewer's most recent provider failure, captured live from child
   * events (`auto_retry_start`, failed `auto_retry_end`, an `agent_end` that
   * stopped on error). Latest wins. Cleared at the start of every pass so a
   * stale error can never mislabel a later clean settle (see runRound).
   */
  let lastProviderError:
    | { message: string; retries: number; at: number }
    | undefined;

  /** Ordered plan chunks for the current pass; reset on submit/abort/switch. */
  let planAssembler:
    | { chunks: string[]; nextIndex: number; totalChunks?: number }
    | undefined;

  const resetPlanAssembler = (): void => {
    planAssembler = undefined;
  };

  const beginPlan = (totalChunks?: number) => {
    if (config().chunkedSubmit === "off") {
      return {
        ok: false,
        error: "chunked submission is off; pass the complete plan to review_submit_plan",
      };
    }
    planAssembler = {
      chunks: [],
      nextIndex: 1,
      ...(totalChunks !== undefined ? { totalChunks } : {}),
    };
    return { ok: true, maxChunkChars: config().chunkChars };
  };

  const appendPlanChunk = (index: number, content: string) => {
    if (!planAssembler) {
      return { ok: false, error: "call review_plan_begin first" };
    }
    if (index !== planAssembler.nextIndex) {
      return {
        ok: false,
        error: `expected chunk ${planAssembler.nextIndex}, got ${index}`,
      };
    }
    const maxChunkChars = config().chunkChars;
    if (content.length > maxChunkChars) {
      return {
        ok: false,
        error: `chunk ${index} is ${content.length} characters; the limit is ${maxChunkChars}`,
      };
    }
    planAssembler.chunks.push(content);
    planAssembler.nextIndex += 1;
    return {
      ok: true,
      received: planAssembler.chunks.length,
      nextIndex: planAssembler.nextIndex,
      totalChars: planAssembler.chunks.reduce(
        (sum, chunk) => sum + chunk.length,
        0,
      ),
    };
  };

  const takeAssembledPlan = (): string | undefined => {
    if (!planAssembler || planAssembler.chunks.length === 0) return undefined;
    if (
      planAssembler.totalChunks !== undefined &&
      planAssembler.chunks.length < planAssembler.totalChunks
    ) {
      return undefined;
    }
    return planAssembler.chunks.join("");
  };

  /** Record one provider failure. The message arrives pre-decoded, non-empty. */
  const noteProviderError = (message: string, retries: number): void => {
    lastProviderError = {
      message,
      retries: Math.max(0, Math.trunc(retries)),
      at: Date.now(),
    };
    if (state) state.providerError = message;
  };

  /** Drop the captured error when a new pass starts. */
  const clearProviderError = (): void => {
    lastProviderError = undefined;
  };

  const config = (): ReviewModeConfig => {
    try {
      return deps.config() ?? (DEFAULT_REVIEW_MODE_CONFIG as ReviewModeConfig);
    } catch {
      return DEFAULT_REVIEW_MODE_CONFIG as ReviewModeConfig;
    }
  };

  const setPhase = (phase: ReviewPhase): void => {
    if (state) state.phase = phase;
    try {
      deps.onState?.(state);
    } catch {
      /* status updates are best-effort */
    }
  };

  const ensureTranscript = (): Transcript => {
    if (!transcript) transcript = new Transcript();
    return transcript;
  };

  /**
   * Emit a runtime-authored status line to the local transcript buffer and the
   * parent stream. Used for run-start narration, which the child's
   * `agent_start` cannot describe truthfully (see `reviewRunLabel`).
   * Display-only: a broken sink must never break a review.
   */
  const pushStatus = (text: string): void => {
    const op: ReviewTranscriptOp = { op: "new", kind: "status", text };
    try {
      ensureTranscript().apply(op);
    } catch {
      /* ignore */
    }
    try {
      deps.onTranscriptOps?.([op]);
    } catch {
      /* ignore */
    }
  };

  /**
   * Completed reviewer runs (`agent_settled`). A pass is over when either its
   * `review_pass_done` or the end of its run arrives — see `runPass()`.
   */
  let settleCount = 0;
  let settleWaiters: Array<() => void> = [];

  /**
   * Mark that a reviewer run has fully settled.
   *
   * `agent_settled` — not `agent_end` — is the reliable "this pass is over"
   * signal: it is emitted after every post-run continuation (provider retry,
   * auto-compaction), so a pass is never judged finished while Pi is still
   * working on it.
   */
  function noteSettled(): void {
    settleCount += 1;
    for (const resolve of settleWaiters.splice(0)) {
      try {
        resolve();
      } catch {
        /* a waiter must never break the settle path */
      }
    }
  }

  /**
   * Resolve `true` when a run settles after `baseline`; `false` on timeout or
   * abort. Edge-tolerant, like `ReviewRoundGate`: a settle that already
   * happened resolves immediately.
   */
  function waitForSettle(
    baseline: number,
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<boolean> {
    if (settleCount > baseline) return Promise.resolve(true);
    if (signal?.aborted) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const waiter = () => finish(true);
      const remove = () => {
        const i = settleWaiters.indexOf(waiter);
        if (i >= 0) settleWaiters.splice(i, 1);
      };
      const onAbort = () => finish(false);
      const finish = (value: boolean): void => {
        if (settled) return;
        settled = true;
        remove();
        if (timer !== undefined) clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        resolve(value);
      };
      if (
        typeof timeoutMs === "number" &&
        Number.isFinite(timeoutMs) &&
        timeoutMs > 0
      ) {
        timer = setTimeout(() => finish(false), Math.trunc(timeoutMs));
      }
      signal?.addEventListener("abort", onAbort, { once: true });
      settleWaiters.push(waiter);
    });
  }

  /**
   * Wait for any in-flight reviewer run to end before starting a pass, so the
   * settle the pass then races belongs to THAT pass rather than the previous
   * one (a reviewer that calls `review_pass_done` keeps streaming until its
   * turn ends).
   */
  async function settleInFlight(
    deadline: number | undefined,
    rc: AbortController,
  ): Promise<void> {
    if (!session || !session.isStreaming()) return;
    // Unlimited mode still needs a bound here: a hung previous run must not
    // block pass 1 forever before the settle race is even armed.
    const waitMs =
      deadline === undefined
        ? SETTLE_IN_FLIGHT_FALLBACK_MS
        : Math.max(1, deadline - Date.now());
    await waitForSettle(settleCount, waitMs, rc.signal);
  }

  /** Abort the reviewer's in-flight run. Best-effort; never throws. */
  async function abortChild(): Promise<void> {
    try {
      await session?.abort();
    } catch {
      /* cancellation is best-effort */
    }
  }

  function errorText(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
  }

  /** Why a pass stopped waiting. */
  type PassStop = "passDone" | "settled" | "timeout" | "aborted" | "error";

  interface PassOutcome {
    submitted: ReviewSubmitPayloadLike | undefined;
    passDone: ReviewPassResult | undefined;
    stop: PassStop;
    /** Set only when `stop === "error"`. */
    error?: unknown;
  }

  /**
   * Drive one pass to a terminal state.
   *
   * The terminal state is whichever comes first of:
   *   - `review_pass_done` (the reviewer completed the protocol), or
   *   - the reviewer's run settling (`agent_settled`), or
   *   - the round deadline, or
   *   - the caller aborting,
   *   - a prompt/follow-up failure such as a rejected preflight.
   *
   * Racing the settle is what makes a silent reviewer fail in seconds instead
   * of waiting out `timeoutMs`: `session.prompt()` resolves when the run ends,
   * so a `review_pass_done` that has not arrived by then never will. The send
   * itself is never awaited unguarded — the deadline covers the run too.
   */
  async function runPass(
    pass: 1 | 2,
    deadline: number | undefined,
    rc: AbortController,
    send: () => Promise<void>,
  ): Promise<PassOutcome> {
    const baseline = settleCount;
    // undefined ⇒ no cap (default): the pass ends on passDone/settle/abort/error.
    const remaining = (): number | undefined =>
      deadline === undefined ? undefined : Math.max(1, deadline - Date.now());
    let sendError: unknown;
    // The losing waiters in the pass race must be cancelled when the winner
    // settles. Otherwise their timers (up to `timeoutMs`, 5 minutes by
    // default) stay referenced and keep the process alive after the round.
    const waitAbort = new AbortController();

    const stop = await new Promise<PassStop>((resolve) => {
      let done = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const onAbort = () => finish("aborted");
      const finish = (s: PassStop): void => {
        if (done) return;
        done = true;
        if (timer !== undefined) clearTimeout(timer);
        rc.signal.removeEventListener("abort", onAbort);
        waitAbort.abort();
        resolve(s);
      };
      if (rc.signal.aborted) {
        finish("aborted");
        return;
      }
      const cap = remaining();
      if (cap !== undefined) timer = setTimeout(() => finish("timeout"), cap);
      rc.signal.addEventListener("abort", onAbort, { once: true });
      void gate.waitForPassDone(remaining(), waitAbort.signal).then((result) => {
        if (result) finish("passDone");
      });
      void waitForSettle(baseline, remaining(), waitAbort.signal).then((did) => {
        if (did) finish("settled");
      });
      void send().catch((e: unknown) => {
        sendError = e;
        finish("error");
      });
    });

    const submitted = gate.lastSubmitted();
    const passDone = gate.lastPassDone();
    if (stop === "timeout") {
      const capMs = Math.max(1000, config().timeoutMs);
      deps.log(
        `pass ${pass} hit its ${Math.round(
          capMs / 1000,
        )}s limit — continuing with ${
          submitted ? "the submitted plan" : "the author's plan"
        }.`,
        "warning",
      );
    }
    return {
      submitted,
      passDone,
      stop,
      ...(sendError === undefined ? {} : { error: sendError }),
    };
  }

  /** Release the child session and its round state (step 10). Never throws. */
  async function disposeSession(options: { keepRoundController?: boolean } = {}): Promise<void> {
    try {
      if (options.keepRoundController !== true) abortController?.abort();
      await session?.abort();
    } catch {
      /* ignore */
    }
    try {
      session?.dispose();
    } catch {
      /* ignore */
    }
    session = undefined;
    state = undefined;
    transcript = undefined;
    sessionModelKey = undefined;
    gate = createReviewRoundGate();
    resetPlanAssembler();
    if (options.keepRoundController !== true) abortController = undefined;
    try {
      deps.onState?.(undefined);
    } catch {
      /* ignore */
    }
  }

  /** Outcome of `ensureSession`: `created` is true only for a fresh boot. */
  interface EnsureSessionResult {
    ok: boolean;
    created: boolean;
  }

  /**
   * Idempotent session boot. `created` tells the caller whether THIS call paid
   * for a new child session, which is what makes the transcript's run label
   * truthful (fresh boot vs warm resume/next round).
   */
  async function ensureSession(modelRefOverride?: {
    provider: string;
    id: string;
    thinking: string;
  }): Promise<EnsureSessionResult> {
    const modelRef = modelRefOverride ?? deps.reviewerModel();
    const modelKey = modelRef
      ? `${modelRef.provider}/${modelRef.id}/${modelRef.thinking}`
      : "";
    if (session) {
      // Step 10: the session is bound to the model it was created with. A
      // reviewer switch since then reboots it so the new model audits.
      if (modelKey && sessionModelKey && modelKey !== sessionModelKey) {
        deps.log(
          "reviewer model changed — restarting the reviewer session.",
          "info",
        );
        // A recovery switch is part of the SAME round: keep its controller so
        // the loop can start the next attempt instead of seeing an abort.
        await disposeSession({ keepRoundController: true });
      } else {
        return { ok: true, created: false };
      }
    }
    if (starting) return starting;
    starting = (async (): Promise<EnsureSessionResult> => {
      const cfg = config();
      if (!modelRef) {
        deps.log(
          "no reviewer model configured — run /role set reviewer <provider/model>",
          "warning",
        );
        return { ok: false, created: false };
      }
      try {
        // The SDK must be loaded BEFORE building the tools: review_bash is
        // constructed from Pi's own `createBashToolDefinition`, so passing an
        // unresolved SDK here would silently drop the reviewer's shell access.
        const sdk = await (
          deps.loadSdk ?? (() => import("@earendil-works/pi-coding-agent"))
        )();

        const built = createReviewTools(sdk, {
          cwd: deps.cwd,
          log: deps.log,
          explore: {
            // Step 8: Planner recon rides along in the prompt — when it is
            // present the reviewer verifies instead of re-exploring.
            budget: () =>
              (deps.hasRecon?.() ?? false) ? 0 : config().exploreBudget,
            run: (task, signal) => deps.runExplore(task, signal),
            onUsed: (used) => {
              if (state) state.exploreUsed = used;
            },
            log: deps.log,
          },
          submit: {
            planPath: () => deps.planPath(),
            originalPlan: () => deps.readPlan(),
            modelLabel: () => session?.modelLabel ?? "reviewer",
            submit: async (payload) => {
              const planPath = deps.planPath();
              if (!planPath) return { ok: false, error: "no plan path" };
              const written = deps.writePlan({
                planPath,
                planText: payload.planText,
                planBody: payload.planBody,
                verdict: payload.verdict,
                summary: payload.summary,
                findings: payload.findings,
                round: state?.round ?? 1,
                modelLabel: session?.modelLabel ?? "reviewer",
              });
              if (!written.ok) return { ok: false, error: written.error };
              if (state) {
                state.rewrittenPlan = payload.planText;
                state.findings = payload.findings;
                state.verdict = payload.verdict;
              }
              gate.notifySubmitted(payload);
              return { ok: true, path: written.path };
            },
            beginPlan,
            appendPlanChunk,
            takeAssembledPlan,
            resetPlan: resetPlanAssembler,
            maxChunkChars: config().chunkChars,
            log: deps.log,
          },
          passDone: {
            hasSubmitted: () => gate.lastSubmitted() !== undefined,
            onPassDone: (result) => {
              if (state) {
                state.passes.push(result);
                state.pass = result.pass;
                state.verdict = result.verdict;
                // Findings from the authoritative pass replace earlier guesses.
                if (result.findings.length > 0) {
                  state.findings = result.findings;
                }
              }
              gate.notifyPassDone(result);
            },
            willVerify: () => {
              const cfg2 = config();
              return (
                cfg2.verify &&
                cfg2.passes > 1 &&
                state?.pass === 1 &&
                reviewNeedsVerification(state?.findings ?? [])
              );
            },
            log: deps.log,
          },
        });
        if (built.unavailable.length > 0) {
          deps.log(
            `Review Mode: some reviewer tools are unavailable — ${built.unavailable.join(", ")}`,
            "warning",
          );
        }

        const createOptions: CreateReviewSessionOptions = {
          cwd: deps.cwd,
          agentDir: deps.agentDir,
          modelRef,
          findModel: deps.findModel,
          reviewPrompt: deps.promptText(),
          customTools: built.tools,
          providerRetries: cfg.providerRetries,
          // Reuse the already-resolved module instead of importing twice.
          loadSdk: async () => sdk,
        };
        // Probed lazily, at creation time: the parent context is live here.
        const parentSurface = deps.parentProviders?.();
        if (parentSurface !== undefined) {
          createOptions.parentProviders = parentSurface;
        }

        const created: CreateReviewSessionResult =
          await createReviewSession(createOptions);

        if (!created.ok || !created.session) {
          deps.log(
            `reviewer unavailable: ${created.error ?? "unknown error"} — the plan will be handed over unreviewed.`,
            cfg.fallbackOnError === "block" ? "error" : "warning",
          );
          return { ok: false, created: false };
        }

        // One line per session, so "the reviewer has no tools" is visible
        // immediately instead of only after a failed pass (see /review-status).
        if (created.activeTools) {
          deps.log(
            `reviewer tools active — ${created.activeTools.join(", ")}`,
            "info",
          );
        }

        session = created.session;
        // Step 10: remember which model this session audits with.
        sessionModelKey = modelKey;
        // Config, not round state: report the missing cap once per live
        // session, so a resume cannot replay it as if the reviewer had just
        // started. Also avoids the old `Review Mode: Review Mode:` doubling.
        if (cfg.timeoutMs <= 0) {
          deps.log(
            "no time limit configured — each pass ends when the reviewer submits or its run settles.",
            "info",
          );
        }
        ensureTranscript();
        const child = created.session;
        session.subscribe((event) => {
          let ops: ReviewTranscriptOp[] = [];
          try {
            ops = ensureTranscript().ingest(event);
          } catch {
            /* a malformed event must not break the review */
          }
          if (ops.length > 0) {
            try {
              deps.onTranscriptOps?.(ops);
            } catch {
              /* streaming to the main transcript is display-only: never fatal */
            }
          }
          const type = readEventType(event);
          // Capture provider failures as they happen, so a pass that ends
          // without a submission can be diagnosed with the reviewer's real
          // API error instead of a generic "no plan" message (see runRound).
          try {
            const failure = readProviderErrorEvent(event);
            if (failure.kind === "retry") {
              noteProviderError(failure.message, failure.retries);
            } else if (failure.kind === "exhaust") {
              noteProviderError(
                failure.message ||
                  lastProviderError?.message ||
                  "provider error (no detail)",
                failure.retries || lastProviderError?.retries || 0,
              );
            } else if (failure.kind === "stop") {
              noteProviderError(
                failure.message,
                lastProviderError?.retries ?? 0,
              );
            }
          } catch {
            /* error capture is diagnostics only: never break the review */
          }
          if (type === "agent_settled") {
            noteSettled();
          } else if (type === "agent_end") {
            // Fallback for a runtime without `agent_settled`: a retry or a
            // compaction continuation continues after agent_end, so only count
            // the event once the session is really idle — and only for the
            // session that is still current.
            setTimeout(() => {
              if (session === child && !child.isStreaming()) noteSettled();
            }, 0);
          }
        });
        return { ok: true, created: true };
      } catch (e: unknown) {
        deps.log(
          `failed to start: ${e instanceof Error ? e.message : String(e)}`,
          "warning",
        );
        return { ok: false, created: false };
      } finally {
        starting = undefined;
      }
    })();
    return starting;
  }

  /** Public shape: idempotent, creates the reviewer session if it is not alive. */
  async function ensureStarted(): Promise<boolean> {
    return (await ensureSession()).ok;
  }

  async function runRound(input: RunRoundInput): Promise<ReviewRoundResult> {
    const cfg = config();
    const hash = planHash(input.planText);
    const started = Date.now();
    const originalPlan = input.planText;
    // Declared outside the try: a `let` inside the try block would not be
    // visible in `finally` (block scoping), and the external listener must
    // always be detached when the round ends.
    let detachExternal: (() => void) | undefined;
    const recoveryAttempts: string[] = [];

    const fail = (
      reason: string,
      planText = originalPlan,
    ): ReviewRoundResult => {
      const elapsedSeconds = Math.max(
        1,
        Math.round((Date.now() - started) / 1000),
      );
      const detail = `${reason} (after ${elapsedSeconds}s)`;
      if (state) {
        state.phase = "failed";
        state.error = detail;
        state.finishedAt = Date.now();
        state.recoveryAttempts = [...recoveryAttempts];
        if (lastProviderError) state.providerError = lastProviderError.message;
      }
      try {
        deps.onState?.(state);
      } catch {
        /* ignore */
      }
      return {
        ok: false,
        fallback: true,
        planText,
        planHash: hash,
        ...(state
          ? { state }
          : {
              state: createReviewState({
                planHash: hash,
                modelLabel: "unavailable",
              }),
            }),
        reason: detail,
      };
    };

    try {
      roundActive = true;
      // Chunks from an earlier round must never leak into this one.
      resetPlanAssembler();
      // A review with nowhere to submit can only fail: do not spend a run on it.
      if (!input.planPath) {
        return fail("no plan path — the reviewer has nowhere to submit");
      }

      // A signal that is already aborted means the host turn this round would
      // belong to is gone (e.g. the planner turn was interrupted). Do not boot
      // a session, send a prompt or spend a pass on it: report a fast abort.
      // The caller decides what that means — the automatic handoff skips the
      // review and hands off unreviewed, while an explicit `/review-resume`
      // passes no host signal at all (its stop paths are ESC / `/review-abort`).
      // Crucially, a pre-aborted signal must never become a pause: doing so
      // re-created `pausedReview` on every resume and parked the handoff
      // forever (2026-10-25 stall).
      if (input.signal?.aborted === true) {
        if (!state || state.planHash !== hash) {
          state = createReviewState({
            planHash: hash,
            planPath: input.planPath,
            modelLabel: session?.modelLabel ?? "reviewer",
            round: input.round,
            now: started,
          });
        }
        state.round = input.round;
        state.planPath = input.planPath;
        state.phase = "aborted";
        state.error =
          "aborted before start — the host turn was already aborted";
        state.finishedAt = Date.now();
        try {
          deps.onState?.(state);
        } catch {
          /* status updates are best-effort */
        }
        return {
          ok: false,
          fallback: true,
          planText: originalPlan,
          planHash: hash,
          state,
          reason: "aborted-before-start",
          abortedBeforeStart: true,
        };
      }

      const baseModel = deps.reviewerModel();
      if (!baseModel) {
        deps.log(
          "no reviewer model configured — run /role set reviewer <provider/model>",
          "warning",
        );
        return fail(
          "no reviewer model configured — run /role set reviewer <provider/model>",
        );
      }
      const attempts =
        cfg.providerRecovery === "fallback"
          ? buildReviewerAttempts({
              base: baseModel,
              explicitFallback: cfg.fallbackModel,
              fallbacks: deps.fallbackReviewerModels?.() ?? [],
              max: 4,
            })
          : [{ ...baseModel }];
      if (attempts.length === 0) {
        return fail(
          "no reviewer model configured — run /role set reviewer <provider/model>",
        );
      }
      const attemptLabel = (model: {
        provider: string;
        id: string;
        thinking: string;
      }): string => `${model.provider}/${model.id} (${model.thinking})`;
      let lastFailure = "reviewer session unavailable";

      abortController = new AbortController();
      const rc = abortController;
      // ESC cancels: link the host signal (when the caller threads one
      // through) to the round's controller, so ESC aborts the pass race,
      // the settle wait and the send alike. The existing `aborted` branch
      // below then keeps the session warm and hands back the author's plan.
      const externalSignal = input.signal;
      if (externalSignal) {
        if (externalSignal.aborted) {
          rc.abort();
        } else {
          const onExternalAbort = () => {
            try {
              rc.abort();
            } catch {
              /* abort is best-effort */
            }
          };
          externalSignal.addEventListener("abort", onExternalAbort, {
            once: true,
          });
          detachExternal = () =>
            externalSignal.removeEventListener("abort", onExternalAbort);
        }
      }
      // 0 (default) = no cap. A configured cap is the outer safety net; the
      // settle race below still ends a silent pass quickly either way.
      const limitMs = cfg.timeoutMs > 0 ? cfg.timeoutMs : undefined;
      const deadline = limitMs !== undefined ? started + limitMs : undefined;
      const recoveryDeadline =
        cfg.recoveryBudgetMs > 0
          ? Math.min(
              deadline ?? Number.POSITIVE_INFINITY,
              started + cfg.recoveryBudgetMs,
            )
          : deadline;

      for (let attemptIndex = 0; attemptIndex < attempts.length; attemptIndex += 1) {
        const attempt = attempts[attemptIndex]!;
        if (rc.signal.aborted) {
          if (!state) {
            state = createReviewState({
              planHash: hash,
              planPath: input.planPath,
              modelLabel: attemptLabel(attempt),
              round: input.round,
              now: started,
            });
          }
          state.phase = "aborted";
          return {
            ok: false,
            fallback: true,
            planText: state.rewrittenPlan ?? originalPlan,
            planHash: hash,
            state,
            reason: "aborted",
          };
        }
        if (
          recoveryDeadline !== undefined &&
          Date.now() >= recoveryDeadline
        ) {
          lastFailure = `provider recovery budget expired before ${attemptLabel(attempt)}`;
          break;
        }
        recoveryAttempts.push(attemptLabel(attempt));
        if (attemptIndex > 0) {
          deps.log(
            `reviewer recovering on ${attemptLabel(attempt)} (attempt ${attemptIndex + 1}/${attempts.length}).`,
            "warning",
          );
          pushStatus(
            `reviewer recovering — ${attemptLabel(attempt)} (attempt ${attemptIndex + 1}/${attempts.length})`,
          );
        }
        const start = await ensureSession(attempt);
        if (!start.ok || !session) {
          lastFailure = `reviewer session unavailable for ${attemptLabel(attempt)}`;
          continue;
        }
        const created = start.created;
        const child = session;

        if (!state || state.planHash !== hash || state.phase === "done") {
          state = createReviewState({
            planHash: hash,
            planPath: input.planPath,
            modelLabel: child.modelLabel,
            round: input.round,
            now: started,
          });
        }
        state.round = input.round;
        state.planPath = input.planPath;
        state.recoveryAttempts = [...recoveryAttempts];
        setPhase("reviewing");

      // ── Pass 1 ──────────────────────────────────────────────────────
      await settleInFlight(deadline, rc);
      gate.reset();
      clearProviderError();
      const pass1Prompt = buildPass1Prompt({
        planPath: input.planPath,
        planText: originalPlan,
        reviewPrompt: deps.promptText(),
        contextBlock: renderReviewContextBlock(deps.contextEntries(), {
          // Step 7 — diet default (settings-overridable).
          maxChars: config().contextChars,
        }),
        // Step 8: inventory + recon so the reviewer verifies, not re-explores.
        manifest: deps.plannerManifest?.() ?? "",
        previousFindings: input.previousFindings,
        round: input.round,
        totalRounds: cfg.rounds,
        verify: cfg.verify && cfg.passes > 1,
        // `chunkedSubmit: "off"` is the coarse switch; `chunkChars: 0` is the
        // numeric one. Both mean "ask for the one-shot submission".
        chunkChars: cfg.chunkedSubmit === "off" ? 0 : cfg.chunkChars,
      });

      const p1 = await runPass(1, deadline, rc, () => {
        // Pushed inside `send`: an already-aborted pass never sends, so it must
        // not claim a start either.
        pushStatus(
          reviewRunLabel({ created, resumed: input.resumed === true, pass: 1 }),
        );
        return child.prompt(pass1Prompt);
      });

      if (p1.stop === "error") {
        await abortChild();
        const sendMessage = errorText(p1.error);
        const providerMessage = lastProviderError?.message ?? sendMessage;
        // Safety net for any provider-source gap the preflight could not see:
        // the bare "No API key found for <provider>." gains the actionable
        // hint ONLY when the failing provider is the reviewer's own.
        lastFailure = `could not prompt the reviewer on ${attemptLabel(
          attempt,
        )}: ${appendProviderAuthHint(
          sendMessage,
          attempt.provider,
          path.join(deps.agentDir, "models.json"),
        )}`;
        const nextExists = attemptIndex + 1 < attempts.length;
        const budgetExpired =
          nextExists &&
          recoveryDeadline !== undefined &&
          Date.now() >= recoveryDeadline;
        const canFallback =
          nextExists && !rc.signal.aborted && !budgetExpired;
        if (budgetExpired) lastFailure += " — provider recovery budget expired";
        if (canFallback && isRecoverableProviderFailure(providerMessage)) {
          deps.log(
            `reviewer attempt failed on ${attemptLabel(attempt)} — ${truncateErrorText(providerMessage)}; trying the next model.`,
            "warning",
          );
          continue;
        }
        return fail(lastFailure);
      }
      if (p1.stop === "aborted" || rc.signal.aborted) {
        await abortChild();
        if (state) state.phase = "aborted";
        return {
          ok: false,
          fallback: true,
          planText: p1.submitted?.planText ?? originalPlan,
          planHash: hash,
          state: state as ReviewState,
          reason: "aborted",
        };
      }
      if (!p1.submitted) {
        // The run is over (or out of time) and nothing reached the plan file.
        await abortChild();
        const nextExists = attemptIndex + 1 < attempts.length;
        const budgetExpired =
          nextExists &&
          recoveryDeadline !== undefined &&
          Date.now() >= recoveryDeadline;
        const canFallback =
          nextExists && !rc.signal.aborted && !budgetExpired;
        if (p1.stop === "timeout") {
          lastFailure = `the reviewer did not finish within ${Math.round(
            (limitMs ?? 0) / 1000,
          )}s and submitted no plan on ${attemptLabel(attempt)}`;
          if (budgetExpired) lastFailure += " — provider recovery budget expired";
          if (canFallback) continue;
          return fail(lastFailure, originalPlan);
        }
        // A provider failure settles the run without a submission — name the
        // real cause (with the provider's own message) instead of blaming the
        // write path. The slot only holds errors captured during THIS pass.
        if (lastProviderError) {
          lastFailure = `the reviewer's provider failed after ${
            lastProviderError.retries
          } retry attempt(s) on ${attemptLabel(attempt)}: ${truncateErrorText(
            lastProviderError.message,
          )}`;
          if (budgetExpired) lastFailure += " — provider recovery budget expired";
          if (
            canFallback &&
            isRecoverableProviderFailure(lastProviderError.message)
          ) {
            continue;
          }
          return fail(lastFailure, originalPlan);
        }
        lastFailure = `the reviewer finished without submitting a plan on ${attemptLabel(
          attempt,
        )} — it has no write path unless review_submit_plan succeeds`;
        if (budgetExpired) lastFailure += " — provider recovery budget expired";
        if (canFallback) continue;
        return fail(lastFailure, originalPlan);
      }
      if (p1.stop === "timeout") {
        // The protocol completed, the run did not: stop paying for it, but keep
        // the submission — never discard real work over a slow model.
        deps.log(
          "pass 1 exceeded its time limit after submitting — using the submitted plan.",
          "warning",
        );
        await abortChild();
      }

      let finalPlan = p1.submitted.planText;

      // ── Pass 2 (self-verification) ───────────────────────────────────
      const wantVerify =
        cfg.verify &&
        cfg.passes > 1 &&
        reviewNeedsVerification(state?.findings ?? []);

      if (wantVerify) {
        setPhase("verifying");
        await settleInFlight(deadline, rc);
        gate.reset();
        clearProviderError();
        const pass2Prompt = buildPass2Prompt({
          planPath: input.planPath,
          originalPlan,
          rewrittenPlan: p1.submitted.planBody,
          findings: state?.findings ?? [],
        });
        const p2 = await runPass(2, deadline, rc, () => {
          pushStatus(reviewRunLabel({ created, pass: 2 }));
          return child.followUp(pass2Prompt);
        });
        // Name the provider when the verification pass died on one; pass 2
        // stays best-effort either way — pass 1's plan is never lost to it.
        const p2Provider = lastProviderError
          ? `provider error after ${lastProviderError.retries} retry attempt(s): ${truncateErrorText(lastProviderError.message)}`
          : undefined;
        if (p2.error !== undefined) {
          // Verification is an enhancement: never lose pass 1's plan over it.
          deps.log(
            p2Provider
              ? `verification pass failed (${p2Provider}; send error: ${errorText(p2.error)}) — keeping pass 1's plan.`
              : `verification pass failed (${errorText(p2.error)}) — keeping pass 1's plan.`,
            "warning",
          );
        } else if (p2.submitted) {
          finalPlan = p2.submitted.planText;
        } else if (p2Provider) {
          // The run settled without a submission AND a provider error was
          // seen this pass: say why, then keep going with pass 1's rewrite.
          deps.log(
            `verification pass ended without a submission (${p2Provider}) — keeping pass 1's plan.`,
            "warning",
          );
        }
        if (p2.stop === "timeout") await abortChild();
      }

      if (state) {
        state.phase = "done";
        state.rewrittenPlan = finalPlan;
        state.finishedAt = Date.now();
        state.recoveryAttempts = [...recoveryAttempts];
      }
      try {
        deps.onState?.(state);
      } catch {
        /* ignore */
      }

      return {
        ok: true,
        fallback: false,
        planText: finalPlan,
        planHash: planHash(finalPlan),
        state: state as ReviewState,
      };
      }

      return fail(
        `${lastFailure} (attempts: ${attempts.map(attemptLabel).join(" → ")})`,
      );
    } catch (e: unknown) {
      return fail(
        `review round failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      try {
        detachExternal?.();
      } catch {
        /* listener cleanup is best-effort */
      }
      abortController = undefined;
      roundActive = false;
    }
  }

  return {
    ensureStarted,
    runRound,
    getState: () => state,
    getTranscript: () => {
      try {
        return transcript?.toDisplayLines() ?? [];
      } catch {
        return [];
      }
    },
    isAlive: () => Boolean(session),
    isRoundActive: () => roundActive,
    async abortRound() {
      try {
        abortController?.abort();
        await session?.abort();
      } catch {
        /* cancellation is best-effort */
      }
      // An aborted round cannot be finalised: drop partial chunks so a retry
      // starts a clean submission instead of silently stitching two rewrites.
      resetPlanAssembler();
      if (state && state.phase !== "done") state.phase = "aborted";
    },
    async sendUserMessage(text: string, images?: unknown[]): Promise<boolean> {
      if (!session) return false;
      const trimmed = String(text ?? "").trim();
      if (!trimmed) return false;
      try {
        // SAFETY: the child is an SDK `AgentSession`. `ReviewChildSession` is a
        // deliberately narrow structural type that only declares what the review
        // round itself needs (prompt/followUp/abort/subscribe), so `steer` and
        // `isStreaming` have to be re-declared here. Both are feature-detected
        // below before use, so the widening cannot cause a missing-method call.
        const child = session as unknown as {
          isStreaming?: boolean;
          steer?: (message: string) => Promise<void>;
          prompt: (message: string, options?: unknown) => Promise<void>;
        };
        const hasImages = Array.isArray(images) && images.length > 0;
        if (child.isStreaming === true && typeof child.steer === "function") {
          // Mid-pass: steer rather than queueing a whole new turn.
          await child.steer(trimmed);
        } else {
          await child.prompt(trimmed, hasImages ? { images } : undefined);
        }
        return true;
      } catch (e: any) {
        deps.notify(
          `could not deliver your message to the reviewer (${String(e?.message ?? e)}); it went to the plan agent instead`,
          "warning",
        );
        return false;
      }
    },
    async teardown() {
      await disposeSession();
    },
  };
}
