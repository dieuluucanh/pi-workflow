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
 *   ├─ await submit + passDone (bounded by timeoutMs — never hangs, risk R7)
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
  type ReviewPhase,
  type ReviewRoundGate,
  type ReviewRoundResult,
  type ReviewSdkLoader,
  type ReviewState,
  type ReviewSubmitPayloadLike,
  type ReviewVerdict,
  ReviewTranscript as Transcript,
} from "./review.ts";
import { createReviewTools } from "./review-tools.ts";
import { renderReviewContextBlock, type ReviewFinding } from "./utils.ts";

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
  /** Right-pane lines. */
  getTranscript(): string[];
  isAlive(): boolean;
  /** Cancel the in-flight review but keep the session (used by the pane's `x`). */
  abortRound(): Promise<void>;
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
    "You cannot run tests, builds, or linters, and you cannot write any file other",
    "than the plan. Say what you could not verify instead of assuming it passes.",
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

        session = created.session;
        ensureTranscript();
        session.subscribe((event) => {
          try {
            ensureTranscript().ingest(event);
          } catch {
            /* a malformed event must not break the review */
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

  /** Wait for one pass to finish, bounded by the configured timeout. */
  async function awaitPass(
    pass: 1 | 2,
    rc: AbortController,
  ): Promise<{
    submitted: ReviewSubmitPayloadLike | undefined;
    done: boolean;
  }> {
    const timeout = Math.max(1000, config().timeoutMs);
    const passDone = await gate.waitForPassDone(timeout, rc.signal);
    const submitted = gate.lastSubmitted();
    if (!passDone) {
      deps.log(
        `Review Mode pass ${pass} timed out after ${Math.round(timeout / 1000)}s — continuing with ${
          submitted ? "the submitted plan" : "the author's plan"
        }.`,
        "warning",
      );
    }
    return { submitted, done: Boolean(passDone) };
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
      const ready = await ensureStarted();
      if (!ready || !session) {
        return fail("reviewer session unavailable");
      }

      if (!state || state.planHash !== hash || state.phase === "done") {
        state = createReviewState({
          planHash: hash,
          planPath: input.planPath,
          modelLabel: session.modelLabel,
          round: input.round,
          now: started,
        });
      }
      state.round = input.round;
      state.planPath = input.planPath;
      setPhase("reviewing");

      abortController = new AbortController();
      const rc = abortController;

      // ── Pass 1 ──────────────────────────────────────────────────────
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

      try {
        await session.prompt(pass1Prompt);
      } catch (e: unknown) {
        return fail(
          `could not prompt the reviewer: ${e instanceof Error ? e.message : String(e)}`,
        );
      }

      const p1 = await awaitPass(1, rc);
      if (rc.signal.aborted) {
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
        return fail("the reviewer did not submit a plan", originalPlan);
      }

      let finalPlan = p1.submitted.planText;

      // ── Pass 2 (self-verification) ───────────────────────────────────
      const wantVerify =
        cfg.verify &&
        cfg.passes > 1 &&
        reviewNeedsVerification(state?.findings ?? []);

      if (wantVerify) {
        setPhase("verifying");
        gate.reset();
        const pass2Prompt = buildPass2Prompt({
          planPath: input.planPath,
          originalPlan,
          rewrittenPlan: p1.submitted.planBody,
          findings: state?.findings ?? [],
        });
        try {
          await session.followUp(pass2Prompt);
          const p2 = await awaitPass(2, rc);
          if (p2.submitted) finalPlan = p2.submitted.planText;
        } catch (e: unknown) {
          // Verification is an enhancement: never lose pass 1's plan over it.
          deps.log(
            `Review Mode verification pass failed (${
              e instanceof Error ? e.message : String(e)
            }) — keeping pass 1's plan.`,
            "warning",
          );
        }
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
    async abortRound() {
      try {
        abortController?.abort();
        await session?.abort();
      } catch {
        /* cancellation is best-effort */
      }
      if (state && state.phase !== "done") state.phase = "aborted";
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
