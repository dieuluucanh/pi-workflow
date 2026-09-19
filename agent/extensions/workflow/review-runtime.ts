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

import {
  DEFAULT_REVIEW_MODE_CONFIG,
  createReviewRoundGate,
  createReviewSession,
  createReviewState,
  planHash,
  reviewNeedsVerification,
  type CreateReviewSessionOptions,
  type CreateReviewSessionResult,
  type ReviewChildSession,
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
import { createReviewTools } from "./review-tools.ts";
import { renderReviewContextBlock, type ReviewFinding } from "./utils.ts";

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
  /** Resolve a model from the parent's registry. */
  findModel: (provider: string, id: string) => unknown;
  /** Plan path Plan Mode chose (absolute or cwd-relative), if known. */
  planPath: () => string | undefined;
  /** Current plan text on disk, if it exists. */
  readPlan: () => string | undefined;
  /** Pruned parent context entries (from ctx.sessionManager.getBranch()). */
  contextEntries: () => unknown[];
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
  previousFindings?: ReviewFinding[];
  round: number;
  totalRounds: number;
  verify: boolean;
}): string {
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

  if (input.contextBlock.trim()) {
    parts.push(
      "",
      "## Shared context from Plan Mode",
      "",
      "This is what the author explored and was asked for. It is background, not",
      "ground truth — verify anything you rely on against the repository.",
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
      ...input.previousFindings.map(
        (f) =>
          `- [${f.disposition}] ${f.summary}${
            f.file ? ` (${f.file}${f.lineRange ? `:${f.lineRange}` : ""})` : ""
          }`,
      ),
    );
  }

  parts.push(
    "",
    "## Required output",
    "",
    "1. `review_submit_plan` with the COMPLETE revised plan (readable markdown,",
    "   original structure preserved, no `Review changes` section — it is generated).",
    "2. `review_pass_done` with your verdict and the same findings.",
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
  return [
    "[REVIEW MODE — PASS 2 of 2: VERIFY YOUR OWN REWRITE]",
    "",
    "You just rewrote the plan and submitted it. Now check your own work. This pass",
    "exists because a rewrite can silently drop a requirement the author cared about.",
    "",
    "## Original plan (as the author wrote it)",
    "",
    "```markdown",
    input.originalPlan,
    "```",
    "",
    "## Your rewrite (currently on disk)",
    "",
    "```markdown",
    input.rewrittenPlan,
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
  let starting: Promise<boolean> | undefined;
  let abortController: AbortController | undefined;
  /** True while `runRound` is in flight (gates prompt routing). */
  let roundActive = false;

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

    const stop = await new Promise<PassStop>((resolve) => {
      let done = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const onAbort = () => finish("aborted");
      const finish = (s: PassStop): void => {
        if (done) return;
        done = true;
        if (timer !== undefined) clearTimeout(timer);
        rc.signal.removeEventListener("abort", onAbort);
        resolve(s);
      };
      if (rc.signal.aborted) {
        finish("aborted");
        return;
      }
      const cap = remaining();
      if (cap !== undefined) timer = setTimeout(() => finish("timeout"), cap);
      rc.signal.addEventListener("abort", onAbort, { once: true });
      void gate.waitForPassDone(remaining(), rc.signal).then((result) => {
        if (result) finish("passDone");
      });
      void waitForSettle(baseline, remaining(), rc.signal).then((did) => {
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
        `Review Mode pass ${pass} hit its ${Math.round(
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

  async function ensureStarted(): Promise<boolean> {
    if (session) return true;
    if (starting) return starting;
    starting = (async () => {
      const cfg = config();
      const modelRef = deps.reviewerModel();
      if (!modelRef) {
        deps.log(
          "Review Mode: no reviewer model configured — run /role set reviewer <provider/model>",
          "warning",
        );
        return false;
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
            budget: () => config().exploreBudget,
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
          // Reuse the already-resolved module instead of importing twice.
          loadSdk: async () => sdk,
        };

        const created: CreateReviewSessionResult =
          await createReviewSession(createOptions);

        if (!created.ok || !created.session) {
          deps.log(
            `Review Mode unavailable: ${created.error ?? "unknown error"} — the plan will be handed over unreviewed.`,
            cfg.fallbackOnError === "block" ? "error" : "warning",
          );
          return false;
        }

        // One line per session, so "the reviewer has no tools" is visible
        // immediately instead of only after a failed pass (see /review-status).
        if (created.activeTools) {
          deps.log(
            `Review Mode: reviewer tools active — ${created.activeTools.join(", ")}`,
            "info",
          );
        }

        session = created.session;
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
        return true;
      } catch (e: unknown) {
        deps.log(
          `Review Mode failed to start: ${e instanceof Error ? e.message : String(e)}`,
          "warning",
        );
        return false;
      } finally {
        starting = undefined;
      }
    })();
    return starting;
  }

  async function runRound(input: RunRoundInput): Promise<ReviewRoundResult> {
    const cfg = config();
    const hash = planHash(input.planText);
    const started = Date.now();
    const originalPlan = input.planText;

    const fail = (
      reason: string,
      planText = originalPlan,
    ): ReviewRoundResult => {
      if (state) {
        state.phase = "failed";
        state.error = reason;
        state.finishedAt = Date.now();
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
        reason,
      };
    };

    try {
      roundActive = true;
      // A review with nowhere to submit can only fail: do not spend a run on it.
      if (!input.planPath) {
        return fail("no plan path — the reviewer has nowhere to submit");
      }

      const ready = await ensureStarted();
      if (!ready || !session) {
        return fail("reviewer session unavailable");
      }
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
      setPhase("reviewing");

      abortController = new AbortController();
      const rc = abortController;
      // 0 (default) = no cap. A configured cap is the outer safety net; the
      // settle race below still ends a silent pass quickly either way.
      const limitMs = cfg.timeoutMs > 0 ? cfg.timeoutMs : undefined;
      const deadline = limitMs !== undefined ? started + limitMs : undefined;
      if (limitMs === undefined) {
        deps.log(
          "Review Mode: no time limit configured — each pass ends when the reviewer submits or its run settles.",
          "info",
        );
      }

      // ── Pass 1 ──────────────────────────────────────────────────────
      await settleInFlight(deadline, rc);
      gate.reset();
      const pass1Prompt = buildPass1Prompt({
        planPath: input.planPath,
        planText: originalPlan,
        reviewPrompt: deps.promptText(),
        contextBlock: renderReviewContextBlock(deps.contextEntries()),
        previousFindings: input.previousFindings,
        round: input.round,
        totalRounds: cfg.rounds,
        verify: cfg.verify && cfg.passes > 1,
      });

      const p1 = await runPass(1, deadline, rc, () =>
        child.prompt(pass1Prompt),
      );

      if (p1.stop === "error") {
        await abortChild();
        return fail(`could not prompt the reviewer: ${errorText(p1.error)}`);
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
        // Fail now — waiting longer cannot produce a submission.
        await abortChild();
        return fail(
          p1.stop === "timeout"
            ? `the reviewer did not finish within ${Math.round((limitMs ?? 0) / 1000)}s and submitted no plan`
            : "the reviewer finished without submitting a plan — it has no write path unless review_submit_plan succeeds",
          originalPlan,
        );
      }
      if (p1.stop === "timeout") {
        // The protocol completed, the run did not: stop paying for it, but keep
        // the submission — never discard real work over a slow model.
        deps.log(
          "Review Mode pass 1 exceeded its time limit after submitting — using the submitted plan.",
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
        const pass2Prompt = buildPass2Prompt({
          planPath: input.planPath,
          originalPlan,
          rewrittenPlan: p1.submitted.planBody,
          findings: state?.findings ?? [],
        });
        const p2 = await runPass(2, deadline, rc, () =>
          child.followUp(pass2Prompt),
        );
        if (p2.error !== undefined) {
          // Verification is an enhancement: never lose pass 1's plan over it.
          deps.log(
            `Review Mode verification pass failed (${errorText(p2.error)}) — keeping pass 1's plan.`,
            "warning",
          );
        } else if (p2.submitted) {
          finalPlan = p2.submitted.planText;
        }
        if (p2.stop === "timeout") await abortChild();
      }

      if (state) {
        state.phase = "done";
        state.rewrittenPlan = finalPlan;
        state.finishedAt = Date.now();
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
    } catch (e: unknown) {
      return fail(
        `review round failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
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
      try {
        abortController?.abort();
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
      gate = createReviewRoundGate();
      abortController = undefined;
      try {
        deps.onState?.(undefined);
      } catch {
        /* ignore */
      }
    },
  };
}
