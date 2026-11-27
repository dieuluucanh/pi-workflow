/**
 * Workflow Extension — `/prompt` command surface (parity plan row 12).
 *
 * This module is the **only** outward effect of prompt refinement: it places a
 * validated candidate back into the composer and never sends, executes, changes
 * modes or touches plan/todo/checkpoint/Review/handoff state.
 *
 * The composition root (`index.ts`) owns the live ports: the refinement model,
 * the isolated session, the inspection authority, the parent questionnaire and
 * the editor. This module owns the policy around them:
 *
 *   - literal arguments: everything after `/prompt` is the draft. There is no
 *     sub-command grammar, so a prompt starting with "status" is still a prompt;
 *   - explicit eligibility: a managed worker, an open permission/questionnaire
 *     overlay, Review/handoff ownership, a queued message, a busy agent or a
 *     second refinement is refused *before* any model or session work;
 *   - one operation-owned AbortController: cancellation aborts the child
 *     session and every pending question, and a late completion cannot apply;
 *   - a single progress surface that is suspended before every questionnaire
 *     and disposed before the candidate is applied — never two overlays;
 *   - a synchronous expected-buffer check before `setEditorText`, so newer
 *     typing is never overwritten; a failed/cancelled operation restores the
 *     original text only when that check still holds, and otherwise keeps it
 *     recoverable in a bounded in-memory store.
 */

import { detectDraftConflict, type RefinementComposerPort } from "./prompt-refinement-review.ts";
import {
  applyRefinementReview,
  buildRefinementReview,
  createRefinementReviewStore,
  refinementReviewNotice,
  type RefinementReview,
  type RefinementReviewStore,
} from "./prompt-refinement-review.ts";
import type {
  RefinementRuntime,
  RefinementRuntimeEvent,
  RefinementCandidate,
} from "./prompt-refinement-runtime.ts";
import type {
  RefinerAskOutcome,
  RefinerAskPort,
  RefinerQuestionInput,
} from "./prompt-refinement-tools.ts";

// ── Command contract ─────────────────────────────────────────────────

export const PROMPT_COMMAND_NAME = "prompt" as const;

/** One visible progress surface; never nested with a questionnaire. */
export const REFINEMENT_PROGRESS_WIDGET = "workflow-refinement-status";

export const PROMPT_COMMAND_USAGE = [
  "Usage: /prompt <your draft request>",
  "  Refines only that request in an isolated child session, then returns it to the composer.",
  "  Nothing is sent or run, and no mode/plan/todo/checkpoint/review/handoff state changes.",
  "  Edit the returned text and send it yourself when you are ready.",
].join("\n");

export type PromptCommandParseResult =
  | { ok: true; text: string }
  | { ok: false; usage: string };

/**
 * Parse the literal command arguments. Only the outer whitespace is trimmed:
 * newlines, Markdown, quotes and commands inside the draft are preserved
 * byte-for-byte. Empty input shows usage instead of starting an operation.
 */
export function parsePromptCommandArgs(args: unknown): PromptCommandParseResult {
  const raw = typeof args === "string" ? args : "";
  const text = raw.replace(/^\s+/, "").replace(/\s+$/, "");
  if (!text) return { ok: false, usage: PROMPT_COMMAND_USAGE };
  return { ok: true, text };
}

// ── Eligibility ──────────────────────────────────────────────────────

export type RefinementRefusalCode =
  | "managed-worker"
  | "permission"
  | "review"
  | "handoff"
  | "overlay"
  | "operation-active"
  | "busy"
  | "queued"
  | "unsupported-host";

export interface RefinementEligibilityFacts {
  /** True only for an interactive host with a real editor and overlays. */
  hasUi: boolean;
  /** `ctx.isIdle()`; false while the parent turn is streaming. */
  isIdle: boolean;
  /** `ctx.hasPendingMessages()`; queued work must run first. */
  hasPendingMessages: boolean;
  /** Review Mode owns the turn (round, pause or gate). */
  reviewOwned: boolean;
  /** Handoff/plan decision or an in-flight handoff owns the turn. */
  handoffOwned: boolean;
  /** A write/read/commit permission dialog is open. */
  permissionPromptOpen: boolean;
  /** Nested `ctx.ui.custom` overlays already on the stack. */
  overlayDepth: number;
  /** This session is an Orchestrator child, or a child row is active. */
  managedWorker: boolean;
  /** A refinement operation is already running in this instance. */
  operationActive: boolean;
}

export type RefinementEligibility =
  | { ok: true }
  | { ok: false; code: RefinementRefusalCode; message: string };

/**
 * Every refusal is checked in a fixed order so the message is deterministic.
 * A managed worker and an open permission dialog win over a generic "busy":
 * they describe a stronger ownership fact.
 */
export function evaluateRefinementEligibility(
  facts: RefinementEligibilityFacts,
): RefinementEligibility {
  if (facts.managedWorker) {
    return {
      ok: false,
      code: "managed-worker",
      message:
        "Prompt refinement is unavailable inside an Orchestrator Build child. Finish or stop the managed worker first.",
    };
  }
  if (facts.permissionPromptOpen) {
    return {
      ok: false,
      code: "permission",
      message:
        "Answer the open permission prompt first; prompt refinement does not grant or bypass any policy.",
    };
  }
  if (facts.reviewOwned) {
    return {
      ok: false,
      code: "review",
      message:
        "Review Mode owns the turn. Finish, pause or abort the review before refining a prompt.",
    };
  }
  if (facts.handoffOwned) {
    return {
      ok: false,
      code: "handoff",
      message:
        "A plan handoff decision is still open. Resolve it before refining a prompt; refinement never approves or dispatches work.",
    };
  }
  if (facts.overlayDepth > 0) {
    return {
      ok: false,
      code: "overlay",
      message:
        "Close the open dialog first; prompt refinement needs the editor and its own progress/question surfaces.",
    };
  }
  if (facts.operationActive) {
    return {
      ok: false,
      code: "operation-active",
      message:
        "A prompt refinement is already running. Finish it or cancel it (Esc) before starting another.",
    };
  }
  if (!facts.isIdle) {
    return {
      ok: false,
      code: "busy",
      message:
        "The agent is still working. Wait for it to settle or press Esc before refining a prompt.",
    };
  }
  if (facts.hasPendingMessages) {
    return {
      ok: false,
      code: "queued",
      message:
        "A message is already queued. Let it run (or clear it) before refining a prompt.",
    };
  }
  if (!facts.hasUi) {
    return {
      ok: false,
      code: "unsupported-host",
      message:
        "Prompt refinement needs an interactive composer. This host has no editor surface for the returned text.",
    };
  }
  return { ok: true };
}

// ── Progress surface ─────────────────────────────────────────────────

export interface RefinementProgressPort {
  start(label: string): void;
  update(label: string): void;
  /** Remove the progress surface before a questionnaire opens. */
  suspend(): void;
  /** Restore the progress surface after the questionnaire closes. */
  resume(): void;
  /** Idempotent: remove the surface and ignore later updates. */
  dispose(): void;
}

export function createNoopRefinementProgress(): RefinementProgressPort {
  return {
    start() {},
    update() {},
    suspend() {},
    resume() {},
    dispose() {},
  };
}

/**
 * The typed stage of one runtime event. A frontend that shows its own
 * progress surface (Desktop's composer operation row) needs the stage
 * separately from the terminal one-line label, so the effective model and the
 * stage can be presented without parsing a sentence.
 */
export interface RefinementStage {
  phase: string;
  label: string;
}

export function refinementStage(
  event: RefinementRuntimeEvent,
): RefinementStage | undefined {
  switch (event.type) {
    case "started":
      return { phase: "refining", label: "refining the prompt" };
    case "provider-request":
      return { phase: "model", label: "waiting for the refinement model" };
    case "inspection":
      return {
        phase: "inspection",
        label: event.message
          ? `inspecting the repository (${event.message})`
          : "inspecting the repository",
      };
    case "candidate":
      return { phase: "validating", label: "validating the candidate" };
    case "continuation":
      return { phase: "refining", label: "finishing the rewrite" };
    case "answer":
      return { phase: "refining", label: "continuing after your answer" };
    // A question owns the overlay slot; its own surface is the progress there.
    default:
      return undefined;
  }
}

/** Map a runtime event to one short, non-overlapping progress line. */
export function refinementProgressLabel(
  event: RefinementRuntimeEvent,
): string | undefined {
  switch (event.type) {
    case "started":
      return event.message
        ? `Refining prompt with ${event.message}…`
        : "Refining prompt…";
    case "provider-request":
      return "Refining prompt — waiting for the refinement model…";
    case "inspection":
      return "Refining prompt — inspecting the repository…";
    case "candidate":
      return "Refining prompt — checking the candidate…";
    case "continuation":
      return "Refining prompt — finishing the rewrite…";
    case "answer":
      return "Refining prompt — continuing after your answer…";
    default:
      return undefined;
  }
}

// ── Recovery ─────────────────────────────────────────────────────────

export interface RefinementRecoveryRecord {
  operationId: string;
  /** The literal `/prompt` argument text. */
  originalText: string;
  /** Present when a candidate existed (conflict/delivery failure). */
  candidateText?: string;
  at: number;
  reason: string;
}

// ── Host / service contracts ─────────────────────────────────────────

/**
 * Everything a single `/prompt` invocation needs from the composition root.
 * Ports are bound to the live extension context by the caller.
 */
export interface PromptCommandHost {
  /** The live command context, opaque here (the runtime builder needs it). */
  ctx: unknown;
  facts: RefinementEligibilityFacts;
  composer: RefinementComposerPort;
  progress: RefinementProgressPort;
  notify(message: string, level?: "info" | "warning" | "error"): void;
  presentQuestions(
    questions: RefinerQuestionInput[],
    options: { signal: AbortSignal },
  ): Promise<RefinerAskOutcome>;
  /**
   * Optional observer for the same runtime events that drive the progress
   * line. A typed frontend uses it to show the effective model and stage in
   * its own surface; it must not perform work or mutate the composer.
   */
  onEvent?(event: RefinementRuntimeEvent): void;
}

export interface StartRefinementRequest {
  operationId: string;
  sessionId: string;
  bindingId?: string;
  text: string;
  /** Operation-owned; aborts the child, questions and the runtime. */
  signal: AbortSignal;
  ask: RefinerAskPort;
  onEvent(event: RefinementRuntimeEvent): void;
  host: PromptCommandHost;
}

export type BuildRefinementRuntimePort = (
  request: StartRefinementRequest,
) => RefinementRuntime | Promise<RefinementRuntime>;

export interface PromptRefinementCommandDeps {
  buildRuntime: BuildRefinementRuntimePort;
  sessionId(ctx: unknown): string;
  bindingId?(ctx: unknown): string | undefined;
  now?: () => number;
  reviewStore?: RefinementReviewStore;
  maxRecovery?: number;
}

export type PromptCommandStatus =
  | "usage"
  | "refused"
  | "applied"
  | "candidate"
  | "conflict"
  | "cancelled"
  | "failed";

export interface PromptCommandResult {
  status: PromptCommandStatus;
  operationId?: string;
  message: string;
  /** True only when the composer now holds `originalText` again. */
  restored: boolean;
  /** True when the original (and any candidate) was kept in memory. */
  recoveryKept: boolean;
  review?: RefinementReview;
}

export interface PromptRefinementCommand {
  readonly name: typeof PROMPT_COMMAND_NAME;
  readonly usage: string;
  readonly reviewStore: RefinementReviewStore;
  run(args: unknown, host: PromptCommandHost): Promise<PromptCommandResult>;
  activeOperationId(): string | undefined;
  /** Abort the live operation. Returns false when nothing was running. */
  cancelActive(reason?: string): boolean;
  /** Latest (or specific) preserved draft after an unsafe restore. */
  recover(operationId?: string): RefinementRecoveryRecord | undefined;
  dispose(): void;
}

interface ActiveOperation {
  id: string;
  controller: AbortController;
  baselineText: string;
  originalText: string;
  cancelled: boolean;
}

function writeOk(result: boolean | { ok: boolean; error?: string }): boolean {
  return result === true || (typeof result === "object" && result.ok === true);
}

/**
 * Create the one `/prompt` service for an extension instance. It owns at most
 * one operation at a time; every mutation of an editor is guarded by an exact
 * baseline comparison.
 */
export function createPromptRefinementCommand(
  deps: PromptRefinementCommandDeps,
): PromptRefinementCommand {
  const now = deps.now ?? (() => Date.now());
  const reviewStore = deps.reviewStore ?? createRefinementReviewStore();
  const maxRecovery = Math.max(1, Math.floor(deps.maxRecovery ?? 8));
  const recoveries = new Map<string, RefinementRecoveryRecord>();
  let active: ActiveOperation | undefined;
  let disposed = false;
  let sequence = 0;

  function preserve(record: RefinementRecoveryRecord): void {
    recoveries.delete(record.operationId);
    recoveries.set(record.operationId, record);
    while (recoveries.size > maxRecovery) {
      const oldest = recoveries.keys().next();
      if (oldest.done) break;
      recoveries.delete(oldest.value);
    }
  }

  function latestRecovery(): RefinementRecoveryRecord | undefined {
    let last: RefinementRecoveryRecord | undefined;
    for (const record of recoveries.values()) last = record;
    return last;
  }

  function nextOperationId(): string {
    sequence += 1;
    return `refine-${now().toString(36)}-${sequence.toString(36)}`;
  }

  function preserveFor(
    operation: ActiveOperation,
    reason: string,
    candidateText?: string,
  ): { restored: boolean; recoveryKept: boolean } {
    preserve({
      operationId: operation.id,
      originalText: operation.originalText,
      ...(candidateText === undefined ? {} : { candidateText }),
      at: now(),
      reason,
    });
    return { restored: false, recoveryKept: true };
  }

  /**
   * Restore the literal draft only when the editor still holds the exact text
   * captured at start (an empty composer is the normal case). Any difference —
   * including whitespace — is newer user text and is never overwritten.
   */
  function restoreOrPreserveWithComposer(
    operation: ActiveOperation,
    composer: RefinementComposerPort,
    reason: string,
    candidateText?: string,
  ): { restored: boolean; recoveryKept: boolean } {
    let current: string | undefined;
    try {
      current = composer.getText();
    } catch (_e) {
      void _e;
      return preserveFor(operation, reason, candidateText);
    }
    const conflict = detectDraftConflict(operation.baselineText, current);
    if (conflict.conflict) return preserveFor(operation, reason, candidateText);
    let wrote: boolean | { ok: boolean; error?: string } = false;
    try {
      wrote = composer.setText(operation.originalText);
    } catch (_e) {
      void _e;
      wrote = false;
    }
    if (writeOk(wrote)) return { restored: true, recoveryKept: false };
    return preserveFor(operation, reason, candidateText);
  }

  function cancelActive(reason = "the prompt refinement was cancelled"): boolean {
    const operation = active;
    if (!operation) return false;
    operation.cancelled = true;
    try {
      operation.controller.abort(reason);
    } catch (_e) {
      void _e;
    }
    return true;
  }

  async function run(
    args: unknown,
    host: PromptCommandHost,
  ): Promise<PromptCommandResult> {
    const parsed = parsePromptCommandArgs(args);
    if (!parsed.ok) {
      host.notify(parsed.usage, "info");
      return {
        status: "usage",
        message: parsed.usage,
        restored: false,
        recoveryKept: false,
      };
    }

    if (disposed) {
      const message = "Prompt refinement is no longer available in this session.";
      host.notify(message, "warning");
      return { status: "refused", message, restored: false, recoveryKept: false };
    }

    // The service's own lock is authoritative; a stale snapshot cannot start a
    // second operation.
    const facts: RefinementEligibilityFacts = {
      ...host.facts,
      operationActive: host.facts.operationActive || active !== undefined,
    };
    const eligibility = evaluateRefinementEligibility(facts);
    if (!eligibility.ok) {
      host.notify(eligibility.message, "warning");
      return {
        status: "refused",
        message: eligibility.message,
        restored: false,
        recoveryKept: false,
      };
    }

    let baseline: string | undefined;
    try {
      baseline = host.composer.getText();
    } catch (_e) {
      void _e;
      baseline = undefined;
    }
    if (typeof baseline !== "string") {
      const message =
        "The composer cannot be read, so the prompt was not refined. Nothing was sent or run.";
      host.notify(message, "warning");
      return { status: "refused", message, restored: false, recoveryKept: false };
    }

    const operation: ActiveOperation = {
      id: nextOperationId(),
      controller: new AbortController(),
      baselineText: baseline,
      originalText: parsed.text,
      cancelled: false,
    };
    active = operation;
    const progress = host.progress;
    let progressDisposed = false;
    const finishProgress = (): void => {
      if (progressDisposed) return;
      progressDisposed = true;
      try {
        progress.dispose();
      } catch (_e) {
        void _e;
      }
    };

    try {
      progress.start("Refining prompt…");

      const ask = async (
        questions: RefinerQuestionInput[],
        options: { signal?: AbortSignal } = {},
      ): Promise<RefinerAskOutcome> => {
        // The questionnaire owns the single overlay slot: remove the progress
        // surface first and only restore it after the questionnaire closes.
        progress.suspend();
        try {
          return await host.presentQuestions(questions, {
            signal: options.signal ?? operation.controller.signal,
          });
        } finally {
          if (!progressDisposed) progress.resume();
        }
      };

      let runtime: RefinementRuntime;
      try {
        runtime = await deps.buildRuntime({
          operationId: operation.id,
          sessionId: deps.sessionId(host.ctx),
          ...(deps.bindingId?.(host.ctx)
            ? { bindingId: deps.bindingId(host.ctx)! }
            : {}),
          text: parsed.text,
          signal: operation.controller.signal,
          ask,
          onEvent: (event) => {
            const label = refinementProgressLabel(event);
            if (label && !progressDisposed) progress.update(label);
            try {
              host.onEvent?.(event);
            } catch (_e) {
              void _e;
            }
          },
          host,
        });
      } catch (error: unknown) {
        finishProgress();
        const reason = `the refinement could not start: ${
          error instanceof Error ? error.message : String(error)
        }`;
        const outcome = restoreOrPreserveWithComposer(
          operation,
          host.composer,
          reason,
        );
        const message = outcome.restored
          ? `${reason}. Your original prompt was restored in the composer; nothing was sent or run.`
          : `${reason}. Your current draft was left untouched; the original prompt is kept (operation ${operation.id}).`;
        host.notify(message, "warning");
        return {
          status: "failed",
          operationId: operation.id,
          message,
          ...outcome,
        };
      }

      let result: Awaited<ReturnType<RefinementRuntime["start"]>>;
      try {
        result = await runtime.start();
      } catch (error: unknown) {
        finishProgress();
        const reason = `the refinement failed: ${
          error instanceof Error ? error.message : String(error)
        }`;
        const outcome = restoreOrPreserveWithComposer(
          operation,
          host.composer,
          reason,
        );
        const message = outcome.restored
          ? `${reason}. Your original prompt was restored in the composer; nothing was sent or run.`
          : `${reason}. Your current draft was left untouched; the original prompt is kept (operation ${operation.id}).`;
        host.notify(message, "warning");
        return {
          status: "failed",
          operationId: operation.id,
          message,
          ...outcome,
        };
      } finally {
        finishProgress();
        try {
          runtime.dispose();
        } catch (_e) {
          void _e;
        }
      }

      // A late success after cancellation is still a cancellation. Nothing may
      // be applied once the operation-owned controller aborted.
      if (operation.controller.signal.aborted || operation.cancelled) {
        const reason = "the prompt refinement was cancelled";
        const outcome = restoreOrPreserveWithComposer(
          operation,
          host.composer,
          reason,
        );
        const message = outcome.restored
          ? `${reason}. Your original prompt was restored in the composer; nothing was sent or run.`
          : `${reason}. Your current draft was left untouched; the original prompt is kept (operation ${operation.id}).`;
        host.notify(message, "info");
        return {
          status: "cancelled",
          operationId: operation.id,
          message,
          ...outcome,
        };
      }

      if (!result.ok) {
        const reason = `the prompt was not refined: ${result.message}`;
        const outcome = restoreOrPreserveWithComposer(
          operation,
          host.composer,
          reason,
        );
        const message = outcome.restored
          ? `${reason}. Your original prompt was restored in the composer; nothing was sent or run.`
          : `${reason}. Your current draft was left untouched; the original prompt is kept (operation ${operation.id}).`;
        host.notify(
          message,
          result.reason === "cancelled" ? "info" : "warning",
        );
        return {
          status: result.reason === "cancelled" ? "cancelled" : "failed",
          operationId: operation.id,
          message,
          ...outcome,
        };
      }

      const candidate: RefinementCandidate = result.candidate;
      const approvedScopeChanges = result.intent.decisions
        .filter((decision) => decision.scopeChange)
        .map((decision) => decision.answer);
      // The runtime candidate carries operation metadata on top of the strict
      // wire result; the review validator must only see the wire fields.
      const {
        digest: _digest,
        policyGeneration: _policyGeneration,
        evidenceIds: candidateEvidenceIds,
        submittedAt: _submittedAt,
        ...wireResult
      } = candidate;
      void _digest;
      void _policyGeneration;
      void _submittedAt;
      const built = buildRefinementReview({
        originalText: parsed.text,
        result: wireResult,
        operationId: operation.id,
        suggestionsAllowed: false,
        evidenceIds: candidateEvidenceIds,
        approvedScopeChanges,
        now,
      });
      if (!built.ok) {
        const reason = `the refined prompt could not be handed back: ${built.message}`;
        const outcome = restoreOrPreserveWithComposer(
          operation,
          host.composer,
          reason,
          candidate.candidate,
        );
        const message = outcome.restored
          ? `${reason}. Your original prompt was restored in the composer; nothing was sent or run.`
          : `${reason}. Your current draft was left untouched; the original prompt is kept (operation ${operation.id}).`;
        host.notify(message, "warning");
        return {
          status: "failed",
          operationId: operation.id,
          message,
          ...outcome,
        };
      }

      const review = built.review;
      reviewStore.put(review);

      const applied = applyRefinementReview({
        action: "insert",
        review,
        baselineText: operation.baselineText,
        composer: host.composer,
      });
      if (applied.ok) {
        const message = `${refinementReviewNotice(review)} Nothing was sent or run; edit and send it yourself.`;
        host.notify(message, "info");
        return {
          status: "applied",
          operationId: operation.id,
          message,
          restored: false,
          recoveryKept: false,
          review,
        };
      }

      if (applied.reason === "conflict") {
        preserve({
          operationId: operation.id,
          originalText: parsed.text,
          candidateText: review.candidateText,
          at: now(),
          reason: applied.message,
        });
        const message = `${applied.message}. Your newer draft was left untouched. The refined prompt is kept for View/Copy (operation ${operation.id}); nothing was sent or run.`;
        host.notify(message, "warning");
        return {
          status: "conflict",
          operationId: operation.id,
          message,
          restored: false,
          recoveryKept: true,
          review,
        };
      }

      // A write refusal (or an unavailable composer) is never retried into a
      // send; the result stays recoverable and the draft is untouched.
      preserve({
        operationId: operation.id,
        originalText: parsed.text,
        candidateText: review.candidateText,
        at: now(),
        reason: applied.message,
      });
      const message = `${applied.message}. The refined prompt is kept for View/Copy (operation ${operation.id}); nothing was sent or run.`;
      host.notify(message, "warning");
      return {
        status: "candidate",
        operationId: operation.id,
        message,
        restored: false,
        recoveryKept: true,
        review,
      };
    } finally {
      finishProgress();
      if (active?.id === operation.id) active = undefined;
    }
  }

  return {
    name: PROMPT_COMMAND_NAME,
    usage: PROMPT_COMMAND_USAGE,
    reviewStore,
    run,
    activeOperationId() {
      return active?.id;
    },
    cancelActive,
    recover(operationId?: string) {
      if (operationId === undefined) return latestRecovery();
      return recoveries.get(operationId);
    },
    dispose() {
      disposed = true;
      cancelActive("the session was rebound");
      recoveries.clear();
      reviewStore.clear();
    },
  };
}
