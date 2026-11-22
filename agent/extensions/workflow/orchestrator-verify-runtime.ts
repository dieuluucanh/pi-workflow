/**
 * Workflow Extension — evidence-backed verification and bounded advance (step 18).
 *
 * The worker's report is a claim. This module is the parent side of the claim:
 * it captures the real baseline → candidate change set, runs the required
 * checks through an injected (gated) executor, and lets `runAcceptance` decide.
 *
 * Non-negotiable properties, all enforced here:
 *   - acceptance references the CURRENT workspace revision and evidence id;
 *     re-applying the same evidence is a no-op, not a second acceptance;
 *   - a changed workspace, a missing/blocked check or an unapproved manual
 *     criterion never becomes a pass;
 *   - a failing candidate gets a SCOPED repair (task.needsFix), preserving the
 *     counters that bound retries;
 *   - the next child is only proposed AFTER acceptance, and this module never
 *     dispatches it.
 */

import {
  applyAcceptanceDecision,
  runAcceptance,
  type AcceptanceOutcome,
  type CheckExecutor,
  type CheckRequest,
  type ManualCheck,
} from "./orchestrator-acceptance.ts";
import { nextRunnableTask } from "./orchestrator-state.ts";
import type { OrchestratorRuntime } from "./orchestrator-runtime.ts";
import type { WorkspaceBaseline } from "./orchestrator-workspace.ts";
import type { BaselineCheck } from "./orchestrator-acceptance.ts";
import type { CriterionStatus } from "./orchestrator-types.ts";

export const VERIFY_RUNTIME_SCHEMA_VERSION = 1 as const;

export interface CriterionObservation {
  roadmapStepId: string;
  status: CriterionStatus;
  evidence?: string;
}

export interface VerifyPorts {
  runtime: () => OrchestratorRuntime | undefined;
  /** The baseline captured before the child started. */
  baseline: () => WorkspaceBaseline | undefined;
  /** The workspace state right now (after the fence). */
  candidate: () => Promise<WorkspaceBaseline>;
  /** The gated check executor (ctx.executeTool-backed in index.ts). */
  executor: CheckExecutor;
  /** Fingerprint of the workspace at decision time. */
  workspaceRevision: () => string;
  now?: () => number;
}

export type VerifyOutcome =
  | {
      ok: true;
      phase: "accepted";
      evidenceId: string;
      duplicate: boolean;
      nextTaskId?: string;
      /** Absent for an idempotent re-read of an already accepted task. */
      outcome?: AcceptanceOutcome;
    }
  | {
      ok: true;
      phase: "needs_fix" | "blocked";
      reasons: string[];
      outcome: AcceptanceOutcome;
    }
  | { ok: false; code: "state" | "invalid" | "workspace" | "journal"; error: string };

export interface VerifyInput {
  taskId: string;
  attemptId: string;
  candidateId: string;
  /** The requirements this task promised to cover. */
  requiredCriteria: readonly string[];
  criteria: readonly CriterionObservation[];
  /** Checks to run; defaults to the task's own acceptance checks. */
  checks?: readonly CheckRequest[];
  baselineChecks?: readonly BaselineCheck[];
  manualChecks?: readonly ManualCheck[];
  expectedPaths?: readonly string[];
  unavailableTools?: readonly string[];
  cwd: string;
}

export interface VerifyRuntime {
  verify(input: VerifyInput): Promise<VerifyOutcome>;
  /** The next dependency-ready task after acceptance; never a dispatch. */
  nextTask(): string | undefined;
}

function taskChecks(runtime: OrchestratorRuntime, taskId: string): CheckRequest[] {
  const view = runtime.view();
  const task = view?.state.tasks[taskId];
  return (task?.acceptanceChecks ?? []).map((name) => ({
    name: name.slice(0, 200),
    command: name.slice(0, 200),
    required: true,
  }));
}

export function createVerifyRuntime(ports: VerifyPorts): VerifyRuntime {
  const now = ports.now ?? (() => Date.now());

  const runtime: VerifyRuntime = {
    nextTask() {
      const view = ports.runtime()?.view();
      return view ? nextRunnableTask(view.state) : undefined;
    },

    async verify(input) {
      const owner = ports.runtime();
      if (!owner) return { ok: false, code: "state", error: "no run is bound" };
      const view = owner.view();
      if (!view) return { ok: false, code: "state", error: "no run is bound" };
      const task = view.state.tasks[input.taskId];
      if (!task) return { ok: false, code: "state", error: "unknown task" };
      // Idempotent re-read: the evidence is already accepted. Never re-run
      // checks or mint a second acceptance for the same task.
      if (task.state === "accepted" && task.acceptance?.evidenceId) {
        const next = nextRunnableTask(view.state);
        return {
          ok: true,
          phase: "accepted",
          evidenceId: task.acceptance.evidenceId,
          duplicate: true,
          ...(next === undefined ? {} : { nextTaskId: next }),
        };
      }
      if (task.currentAttemptId !== input.attemptId) {
        return { ok: false, code: "state", error: "the attempt is not current" };
      }
      if (view.state.mutation) {
        return { ok: false, code: "state", error: "verification requires a quiescent workspace" };
      }
      const baseline = ports.baseline();
      if (!baseline) {
        return { ok: false, code: "invalid", error: "no pre-work baseline was captured for this attempt" };
      }

      // 1. Move to `verifying` durably before running anything.
      const verifying = await owner.applyEvent({
        type: "task.verify",
        runId: view.runId,
        now: now(),
        taskId: input.taskId,
      });
      if (!verifying.ok) {
        return { ok: false, code: "state", error: verifying.error };
      }

      // 2. Capture the real candidate and judge it.
      let candidate: WorkspaceBaseline;
      try {
        candidate = await ports.candidate();
      } catch (error: unknown) {
        return {
          ok: false,
          code: "workspace",
          error: `the candidate workspace could not be captured: ${
            error instanceof Error ? error.message : String(error)
          }`,
        };
      }
      const workspaceRevision = ports.workspaceRevision();
      const built = await runAcceptance(
        {
          runId: view.runId,
          taskId: input.taskId,
          attemptId: input.attemptId,
          candidateId: input.candidateId,
          roadmapRevision: view.roadmapRevision,
          workspace: { revision: workspaceRevision, quiescent: true },
          baseline,
          candidate,
          requiredCriteria: [...input.requiredCriteria],
          criteria: input.criteria.map((entry) => ({
            roadmapStepId: entry.roadmapStepId,
            status: entry.status,
            ...(entry.evidence === undefined ? {} : { evidence: entry.evidence }),
          })),
          checks: [...(input.checks ?? taskChecks(owner, input.taskId))],
          baselineChecks: input.baselineChecks ?? [],
          manualChecks: input.manualChecks ?? [],
          expectedPaths: input.expectedPaths ?? task.expectedFiles,
          unavailableTools: input.unavailableTools ?? [],
          cwd: input.cwd,
          now: now(),
        },
        ports.executor,
      );
      if (!built.ok) {
        return { ok: false, code: "invalid", error: built.error };
      }
      const outcome = built.outcome;
      // The evidence is only valid for the workspace revision it observed.
      if (ports.workspaceRevision() !== workspaceRevision) {
        return {
          ok: false,
          code: "workspace",
          error: "the workspace changed while acceptance was running; nothing was accepted",
        };
      }

      // 3. Apply the decision. Acceptance validates the exact evidence against
      //    the CURRENT workspace revision; a duplicate evidence id is a no-op.
      //    Re-read the state AFTER `task.verify`: the earlier snapshot is stale.
      const current = owner.view();
      if (!current) return { ok: false, code: "state", error: "the run disappeared mid-verification" };
      if (outcome.phase === "accepted") {
        const validation = applyAcceptanceDecision({
          state: current.state,
          evidence: outcome.evidence,
          currentWorkspaceRevision: workspaceRevision,
          now: now(),
        });
        if (!validation.ok) {
          return { ok: false, code: "workspace", error: validation.error };
        }
        if (validation.duplicate) {
          return {
            ok: true,
            phase: "accepted",
            evidenceId: validation.evidenceId,
            duplicate: true,
            outcome,
          };
        }
        const applied = await owner.applyEvent({
          type: "task.accept",
          runId: current.runId,
          now: now(),
          taskId: input.taskId,
          evidence: outcome.evidence,
          workspaceRevision,
        });
        if (!applied.ok) {
          return { ok: false, code: "journal", error: applied.error };
        }
        return {
          ok: true,
          phase: "accepted",
          evidenceId: outcome.evidence.evidenceId,
          duplicate: false,
          ...(validation.nextTaskId === undefined ? {} : { nextTaskId: validation.nextTaskId }),
          outcome,
        };
      }

      const reasons = outcome.blockers.length > 0 ? outcome.blockers : ["verification failed"];
      if (outcome.phase === "blocked") {
        const blocked = await owner.applyEvent({
          type: "task.block",
          runId: current.runId,
          now: now(),
          taskId: input.taskId,
          reason: reasons.join("; ").slice(0, 500),
        });
        if (!blocked.ok) return { ok: false, code: "journal", error: blocked.error };
        return { ok: true, phase: "blocked", reasons, outcome };
      }

      // needs_fix: a scoped repair through the reducer's budgeted path.
      const repaired = await owner.applyEvent({
        type: "task.needsFix",
        runId: current.runId,
        now: now(),
        taskId: input.taskId,
        meaningfulChange: true,
        reason: reasons.join("; ").slice(0, 500),
      });
      if (!repaired.ok) {
        return { ok: false, code: "journal", error: repaired.error };
      }
      return { ok: true, phase: "needs_fix", reasons, outcome };
    },
  };

  return runtime;
}
