/**
 * Workflow Extension — accepted-task commits and the final integration gate
 * (integration step 22).
 *
 * Two effects live here, and both are parent-owned:
 *
 *   1. COMMIT an accepted task exactly once, from parent-attributable paths,
 *      under the existing never/ask/allow policy. A child report, `[DONE:n]`,
 *      checkbox or auto-commit can never reach this function.
 *   2. FINAL GATE: completion is derived from accepted coverage plus real final
 *      checks. A required check that was skipped/cancelled/timed-out is NOT a
 *      pass (the pure evaluator fails closed). A failed final gate produces a
 *      scoped revision PROPOSAL; accepted tasks are never reopened.
 */

import {
  applyCommit,
  planCommit,
  type CommitApply,
  type CommitDecision,
  type CommitGitPort,
  type CommitLedger,
} from "./orchestrator-commits.ts";
import type { CommitMode } from "./orchestrator-approval.ts";
import {
  evaluateFinalGate,
  type FinalGateDecision,
  type FinalGateInput,
} from "./orchestrator-roadmap.ts";
import type { OrchestratorRuntime } from "./orchestrator-runtime.ts";

export const FINAL_RUNTIME_SCHEMA_VERSION = 1 as const;

export interface FinalRuntimePorts {
  runtime: () => OrchestratorRuntime | undefined;
  ledger: CommitLedger;
  git: CommitGitPort;
  commitMode: () => CommitMode;
  now?: () => number;
}

export interface CommitRequest {
  taskId: string;
  evidenceId: string;
  candidateId: string;
  acceptedPaths: readonly string[];
  baselinePaths?: readonly string[];
  summary?: string;
  approvedPaths?: readonly string[];
}

export type FinalRuntimeResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: "state" | "journal" | "git" | "invalid"; error: string };

export interface FinalRuntime {
  /** Commits one accepted task at most once. */
  commitAccepted(
    request: CommitRequest,
  ): Promise<FinalRuntimeResult<{ apply: CommitApply; decision: CommitDecision }>>;
  /** Evaluates the roadmap-level gate and records the durable decision. */
  finalGate(input: FinalGateInput): Promise<FinalRuntimeResult<{ decision: FinalGateDecision }>>;
  /** Records a scoped revision proposal; it needs a NEW execution approval. */
  proposeRevision(reason: string): Promise<FinalRuntimeResult<{ requiresApproval: true }>>;
}

export function createFinalRuntime(ports: FinalRuntimePorts): FinalRuntime {
  const now = ports.now ?? (() => Date.now());

  const runtime: FinalRuntime = {
    async commitAccepted(request) {
      const owner = ports.runtime();
      if (!owner) return { ok: false, code: "state", error: "no run is bound" };
      const view = owner.view();
      if (!view) return { ok: false, code: "state", error: "no run is bound" };
      const task = view.state.tasks[request.taskId];
      if (!task || task.state !== "accepted") {
        return { ok: false, code: "state", error: "only an accepted task may be committed" };
      }
      if (task.acceptance?.evidenceId !== request.evidenceId) {
        return {
          ok: false,
          code: "state",
          error: "the commit must reference this task's accepted evidence",
        };
      }
      const decision = planCommit({
        mode: ports.commitMode(),
        changeSet: {
          runId: view.runId,
          taskId: request.taskId,
          evidenceId: request.evidenceId,
          candidateId: request.candidateId,
          evidenceVerdict: "accepted",
          acceptedPaths: [...request.acceptedPaths],
          ...(request.baselinePaths === undefined
            ? {}
            : { baselinePaths: [...request.baselinePaths] }),
        },
        ledger: ports.ledger,
        ...(request.summary === undefined ? {} : { summary: request.summary }),
        ...(request.approvedPaths === undefined
          ? {}
          : { approvedPaths: [...request.approvedPaths] }),
        now: now(),
      });
      if (!decision.ok) return { ok: false, code: "invalid", error: decision.error };
      const applied = await applyCommit({
        decision,
        ledger: ports.ledger,
        git: ports.git,
        now: now(),
      });
      if (!applied.ok) {
        return { ok: false, code: applied.code === "git" ? "git" : "invalid", error: applied.error };
      }
      const journaled = await owner.appendJournal(
        "run.control",
        {
          action: "commit",
          taskId: request.taskId,
          evidenceId: request.evidenceId,
          status: applied.status,
          ...(applied.status === "committed" || applied.status === "already_committed"
            ? { sha: applied.sha }
            : {}),
        },
        `commit-${view.runId}-${task.acceptance.evidenceId}`,
      );
      if (!journaled.ok) {
        return { ok: false, code: "journal", error: journaled.error };
      }
      return { ok: true, value: { apply: applied, decision } };
    },

    async finalGate(input) {
      const owner = ports.runtime();
      if (!owner) return { ok: false, code: "state", error: "no run is bound" };
      const view = owner.view();
      if (!view) return { ok: false, code: "state", error: "no run is bound" };
      if (view.state.phase !== "final_verification" && view.state.phase !== "ready") {
        return {
          ok: false,
          code: "state",
          error: `the run is ${view.state.phase}; the final gate applies after all tasks are accepted`,
        };
      }
      const decision = evaluateFinalGate(input);
      if (!decision.ok) {
        return { ok: false, code: "invalid", error: decision.error };
      }
      if (decision.decision === "complete") {
        const transitioned = await owner.applyEvent({
          type: "run.transition",
          runId: view.runId,
          now: now(),
          to: "completed",
        });
        if (!transitioned.ok) return { ok: false, code: "state", error: transitioned.error };
      }
      const journaled = await owner.appendJournal(
        "run.final_gate",
        {
          decision: decision.decision,
          blockers: decision.decision === "complete" ? [] : decision.blockers,
          repair: decision.decision === "repair" ? decision.repair : null,
        },
        `final-gate-${view.runId}-${view.state.revision}`,
      );
      if (!journaled.ok) return { ok: false, code: "journal", error: journaled.error };
      return { ok: true, value: { decision } };
    },

    async proposeRevision(reason) {
      const owner = ports.runtime();
      if (!owner) return { ok: false, code: "state", error: "no run is bound" };
      const view = owner.view();
      if (!view) return { ok: false, code: "state", error: "no run is bound" };
      const text = reason.replace(/\s+/g, " ").trim().slice(0, 500);
      if (!text) return { ok: false, code: "invalid", error: "a revision reason is required" };
      const journaled = await owner.appendJournal(
        "plan.revision",
        { reason: text, requiresApproval: true, at: now() },
        `plan-revision-${view.runId}-${view.state.revision}`,
      );
      if (!journaled.ok) return { ok: false, code: "journal", error: journaled.error };
      return { ok: true, value: { requiresApproval: true } };
    },
  };

  return runtime;
}
