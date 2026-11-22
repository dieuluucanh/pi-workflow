/**
 * Workflow Extension — operator commands and mode-exit policy (step 20).
 *
 * `/orchestrator` without arguments stays MODE ENTRY (index.ts). This module is
 * the argument surface:
 *
 *   status | preview | start [path] | pause | resume | stop | inspect [taskId] |
 *   say <text> | retry | refine <what> | approve <preview-id> | cancel | help
 *
 * Two rules are structural here:
 *   - `start` never dispatches by itself: it reports whether a breakdown and
 *     explicit execution approval exist, and refuses otherwise. The command
 *     host performs the one dispatch through the shared auto-start path;
 *   - `approve` names the exact preview ID. The literal `approve-execution` is
 *     not enough: a model or stale command cannot approve a breakdown it did
 *     not show, and a changed preview invalidates the ID.
 */

export const OPERATOR_SCHEMA_VERSION = 1 as const;
export const MAX_SAY_CHARS = 2_000;

import {
  formatExecutionPreview,
  matchesPreviewId,
  previewApprovalId,
} from "./orchestrator-preview-view.ts";

export const OPERATOR_VERBS = [
  "status",
  "preview",
  "start",
  "pause",
  "resume",
  "stop",
  "inspect",
  "say",
  "retry",
  "approve",
  "refine",
  "cancel",
  "help",
] as const;

export type OperatorVerb = (typeof OPERATOR_VERBS)[number] | "mode-entry";

export interface ParsedOperator {
  verb: OperatorVerb;
  rest: string;
}

export function parseOperatorArgs(raw: string): ParsedOperator {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (text.length === 0) return { verb: "mode-entry", rest: "" };
  const [head, ...tail] = text.split(/\s+/);
  const verb = (OPERATOR_VERBS as readonly string[]).includes(head)
    ? (head as OperatorVerb)
    : "help";
  return { verb, rest: tail.join(" ").trim() };
}

export interface OperatorRuntimePorts {
  runtime: () => import("./orchestrator-runtime.ts").OrchestratorRuntime | undefined;
  now?: () => number;
}

export interface OperatorResult {
  ok: boolean;
  verb: OperatorVerb;
  text: string;
  /** When present, index.ts may deliver this to the child (never auto-sent). */
  say?: string;
}

function countStates(state: {
  order: string[];
  tasks: Record<string, { state: string }>;
}): string {
  const counts = { accepted: 0, pending: 0, blocked: 0, other: 0 };
  for (const id of state.order) {
    const status = state.tasks[id]?.state;
    if (status === "accepted") counts.accepted += 1;
    else if (status === "pending") counts.pending += 1;
    else if (status === "blocked") counts.blocked += 1;
    else counts.other += 1;
  }
  return `${counts.accepted} accepted · ${counts.pending} pending · ${counts.blocked} blocked · ${counts.other} in flight`;
}

export interface OperatorRuntime {
  run(args: string): Promise<OperatorResult>;
}

export function createOperatorRuntime(ports: OperatorRuntimePorts): OperatorRuntime {
  const now = ports.now ?? (() => Date.now());

  const runtime = {
    async run(args: string): Promise<OperatorResult> {
      const parsed = parseOperatorArgs(args);
      const owner = ports.runtime();
      const fail = (text: string): OperatorResult => ({ ok: false, verb: parsed.verb, text });
      const help = (): OperatorResult => ({
        ok: true,
        verb: parsed.verb,
        text: [
          "Usage: /orchestrator [status|preview|start [path]|pause|resume|stop|inspect [taskId]|say <text>|retry|refine <what>|approve <preview-id>|cancel]",
          "Bare /orchestrator enters the mode. A breakdown and its execution approval are separate decisions; nothing is dispatched by these commands.",
        ].join("\n"),
      });

      if (parsed.verb === "mode-entry") return help();
      if (parsed.verb === "help") return help();
      if (!owner) {
        return fail(
          "No orchestrator run is bound yet. Ask Orchestrator to work (or run /orchestrator start [path]) — preparation binds the current discussion or an explicit plan and launches nothing. A plan handoff is not required.",
        );
      }
      const view = owner.view();
      if (!view) return fail("No orchestrator run is bound.");
      const previewBlock = () => {
        if (!view.preview) return undefined;
        return formatExecutionPreview({
          preview: view.preview,
          requirements: view.requirements,
          fromDiscussion: /discussion-[0-9a-f]+\.md$/i.test(view.roadmap.path),
        });
      };

      switch (parsed.verb) {
        case "status": {
          const dispatch = owner.canDispatch();
          const approval = view.approval
            ? `approved (${view.approval.approvalId})`
            : view.preview
              ? "breakdown proposed — execution approval pending"
              : "no breakdown yet";
          return {
            ok: true,
            verb: parsed.verb,
            text: [
              `run ${view.runId} · ${view.phase}`,
              `roadmap ${view.roadmap.path} (digest ${view.roadmap.digest.slice(0, 12)}, revision ${view.roadmapRevision})`,
              `${view.roadmap.requirementCount} requirement(s) · ${countStates(view.state)}`,
              `execution: ${approval}`,
              ...(view.preview
                ? [`preview ${previewApprovalId(view.preview)} — /orchestrator preview to read it`]
                : []),
              dispatch.ok
                ? `dispatchable${view.nextTaskId ? `; next ${view.nextTaskId}` : ""}`
                : `not dispatchable: ${dispatch.reasons.join("; ")}`,
            ].join("\n"),
          };
        }

        case "preview": {
          const block = previewBlock();
          if (!block) return fail("There is no breakdown to preview yet.");
          return { ok: true, verb: parsed.verb, text: block };
        }

        case "start": {
          if (view.preview && !view.approval) {
            return fail(
              "A breakdown is proposed but not approved. Approve it explicitly (the second approval) before any child starts.",
            );
          }
          if (!view.preview) {
            return fail(
              "No breakdown exists yet. Preparation proposes tasks; then the execution breakdown must be approved separately.",
            );
          }
          const dispatch = owner.canDispatch();
          if (!dispatch.ok) {
            return fail(`Not dispatchable: ${dispatch.reasons.join("; ")}. Nothing was started.`);
          }
          return {
            ok: true,
            verb: parsed.verb,
            text: `Approval is valid${view.nextTaskId ? ` for ${view.nextTaskId}` : ""}. The host is starting the next dependency-ready task through the shared durable dispatch path.`,
          };
        }

        case "refine": {
          if (!view.preview && !view.approval) return fail("There is no breakdown to refine.");
          const what = parsed.rest;
          if (!what) {
            return fail("Say what should change: /orchestrator refine <what to change>.");
          }
          const refined = await owner.refine(what);
          return refined.ok
            ? {
                ok: true,
                verb: parsed.verb,
                text: "Breakdown invalidated (durably). Nothing is approved and nothing was dispatched; propose a revised breakdown, then approve its new preview id.",
              }
            : fail(`Cannot refine: ${refined.error}`);
        }

        case "pause": {
          if (view.state.mutation) {
            return fail(
              "A child still holds the mutation grant. Request a pause and wait for its fence; the run is not paused yet and edits are preserved.",
            );
          }
          if (view.phase === "paused") return fail("The run is already paused.");
          const paused = await owner.applyEvent({
            type: "run.transition",
            runId: view.runId,
            now: now(),
            to: "paused",
          });
          return paused.ok
            ? { ok: true, verb: parsed.verb, text: "Run paused. No child is running and no workspace is leased." }
            : fail(`Cannot pause: ${paused.error}`);
        }

        case "resume": {
          if (view.phase !== "paused") return fail(`The run is ${view.phase}, not paused.`);
          const resumed = await owner.applyEvent({
            type: "run.transition",
            runId: view.runId,
            now: now(),
            to: "ready",
          });
          return resumed.ok
            ? { ok: true, verb: parsed.verb, text: "Run resumed. Dispatch still needs the existing approval." }
            : fail(`Cannot resume: ${resumed.error}`);
        }

        case "stop": {
          if (view.state.mutation) {
            return fail(
              "A child still holds the mutation grant. Stop after its fence; nothing was cancelled and edits are preserved.",
            );
          }
          const cancelled = await owner.cancel("operator stop");
          return cancelled.ok
            ? { ok: true, verb: parsed.verb, text: "Run stopped. No child is running; edits and history are preserved." }
            : fail(`Cannot stop: ${cancelled.error}`);
        }

        case "inspect": {
          const taskId = parsed.rest || view.nextTaskId;
          if (!taskId) return fail("No task is active; pass a task id.");
          const task = view.state.tasks[taskId];
          if (!task) return fail(`Unknown task ${taskId}.`);
          return {
            ok: true,
            verb: parsed.verb,
            text: [
              `${task.taskId} · ${task.state}${task.blockedReason ? ` · blocked: ${task.blockedReason}` : ""}`,
              `covers: ${task.covers.join(", ") || "(none)"}`,
              `objective: ${task.objective.slice(0, 400)}`,
              `checks: ${task.acceptanceChecks.join("; ") || "(none)"}`,
              `files: ${task.expectedFiles.join(", ") || "(none)"}`,
              `repairs ${task.counters.repairRounds} · rollovers ${task.counters.rollovers} · no-progress ${task.counters.noProgress}`,
            ].join("\n"),
          };
        }

        case "say": {
          const text = parsed.rest.slice(0, MAX_SAY_CHARS);
          if (!text) return fail("Usage: /orchestrator say <message for the child>");
          return {
            ok: true,
            verb: parsed.verb,
            text: `Message prepared for the child (not sent automatically): ${text}`,
            say: text,
          };
        }

        case "retry": {
          if (view.phase !== "blocked" && view.phase !== "paused") {
            return fail(`The run is ${view.phase}; retry applies to a blocked or paused run.`);
          }
          const resumed = await owner.applyEvent({
            type: "run.transition",
            runId: view.runId,
            now: now(),
            to: "ready",
          });
          return resumed.ok
            ? {
                ok: true,
                verb: parsed.verb,
                text: "Blocked/paused run returned to ready. The existing approval still governs any dispatch; repair budgets are unchanged.",
              }
            : fail(`Cannot retry: ${resumed.error}`);
        }

        case "approve": {
          if (!view.preview) return fail("There is no breakdown to approve.");
          if (view.approval) return fail("This breakdown is already approved.");
          if (!matchesPreviewId(view.preview, parsed.rest)) {
            return fail(
              `Approval must name this preview: /orchestrator approve ${previewApprovalId(view.preview)}. Nothing was approved.`,
            );
          }
          const approved = await owner.approve({
            confirmation: "approve-execution",
            approvalId: `approval-${view.runId}-${view.preview.planDigest.slice(0, 12)}`,
          });
          return approved.ok
            ? {
                ok: true,
                verb: parsed.verb,
                text: `Execution approved (${approved.value.record.approvalId}). The host starts the next dependency-ready task; approvals are bound to the roadmap, plan and limits digests.`,
              }
            : fail(`Approval refused: ${approved.error}`);
        }

        case "cancel": {
          const cancelled = await owner.cancel(parsed.rest || "operator cancel");
          return cancelled.ok
            ? { ok: true, verb: parsed.verb, text: "Run cancelled. No child was launched by this command." }
            : fail(`Cannot cancel: ${cancelled.error}`);
        }

        default:
          return help();
      }
    },
  };

  return runtime;
}
