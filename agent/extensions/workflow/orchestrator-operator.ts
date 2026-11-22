/**
 * Workflow Extension — operator commands.
 *
 * `/orchestrator` without arguments stays MODE ENTRY (index.ts). This module is
 * the argument surface:
 *
 *   status | start [path] | pause | resume | stop | inspect [taskId] |
 *   say <text> | retry | cancel | help
 *
 * There is no preview, approve, refine or execution-approval verb: the plan
 * approval and the neutral Build/Orchestrator choice are the only decisions.
 * `start` is handled by the command host, which owns the frozen list and the
 * scheduler; this module only reports and controls an already-bound run.
 */

export const OPERATOR_SCHEMA_VERSION = 1 as const;
export const MAX_SAY_CHARS = 2_000;

import { rowForTask, taskCounts } from "./orchestrator-state.ts";

export const OPERATOR_VERBS = [
  "status",
  "start",
  "pause",
  "resume",
  "stop",
  "inspect",
  "say",
  "retry",
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
  const verb = (OPERATOR_VERBS as readonly string[]).includes(head ?? "")
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

export interface OperatorRuntime {
  run(args: string): Promise<OperatorResult>;
}

export function createOperatorRuntime(ports: OperatorRuntimePorts): OperatorRuntime {
  const now = ports.now ?? (() => Date.now());

  return {
    async run(args: string): Promise<OperatorResult> {
      const parsed = parseOperatorArgs(args);
      const owner = ports.runtime();
      const fail = (text: string): OperatorResult => ({ ok: false, verb: parsed.verb, text });
      const help = (): OperatorResult => ({
        ok: true,
        verb: parsed.verb,
        text: [
          "Usage: /orchestrator [status|start [path]|pause|resume|stop|inspect [taskId]|say <text>|retry|cancel]",
          "Bare /orchestrator enters the mode. Start freezes the approved plan into one TODO row per step and dispatches the first Build child; there is no second breakdown approval.",
        ].join("\n"),
      });

      if (parsed.verb === "mode-entry" || parsed.verb === "help") return help();
      if (!owner) {
        return fail(
          "No orchestrator run is bound yet. Run /orchestrator start [path] (or agree the steps and let the model call orchestrator_start). Nothing was launched.",
        );
      }
      const view = owner.view();
      if (!view) return fail("No orchestrator run is bound.");

      switch (parsed.verb) {
        case "status": {
          const counts = taskCounts(view.state);
          return {
            ok: true,
            verb: parsed.verb,
            text: [
              `run ${view.runId} · ${view.phase}`,
              view.plan
                ? `plan ${view.plan.path} (digest ${view.plan.digest.slice(0, 12)})`
                : `standalone: ${view.todos.source.title}`,
              `${counts.accepted}/${counts.total} accepted · ${counts.pending} pending · ${counts.running} in flight · ${counts.blocked} blocked`,
              ...(view.blockedReason ? [`blocked: ${view.blockedReason}`] : []),
              ...(view.nextTaskId ? [`next: ${view.nextTaskId}`] : []),
            ].join("\n"),
          };
        }

        case "start": {
          return fail(
            view.nextTaskId
              ? `Run ${view.runId} is already bound; ${view.nextTaskId} is the next frozen row. Use /orchestrator retry if it is not dispatched.`
              : `Run ${view.runId} is ${view.phase}; there is no pending row to start.`,
          );
        }

        case "pause": {
          if (view.phase === "paused") return fail("The run is already paused.");
          if (view.phase === "completed" || view.phase === "cancelled" || view.phase === "failed") {
            return fail(`The run is ${view.phase}; it cannot be paused.`);
          }
          const paused = await owner.applyEvent({
            type: "run.transition",
            runId: view.runId,
            now: now(),
            to: "paused",
          });
          return paused.ok
            ? { ok: true, verb: parsed.verb, text: "Run paused. No new row is dispatched." }
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
            ? { ok: true, verb: parsed.verb, text: "Run resumed. Use retry to dispatch the next pending row." }
            : fail(`Cannot resume: ${resumed.error}`);
        }

        case "stop":
        case "cancel": {
          const cancelled = await owner.cancel(parsed.verb === "stop" ? "operator stop" : "operator cancel");
          return cancelled.ok
            ? { ok: true, verb: parsed.verb, text: "Run cancelled. Edits and history are preserved." }
            : fail(`Cannot cancel: ${cancelled.error}`);
        }

        case "inspect": {
          const taskId = parsed.rest || view.nextTaskId;
          if (!taskId) return fail("No task is active; pass a task id.");
          const task = view.state.tasks[taskId];
          if (!task) return fail(`Unknown task ${taskId}.`);
          const row = rowForTask(view.state, taskId);
          return {
            ok: true,
            verb: parsed.verb,
            text: [
              `${task.taskId} · ${task.state}${task.blockedReason ? ` · blocked: ${task.blockedReason}` : ""}`,
              `row ${row?.ref ?? "?"}: ${(row?.text ?? "").slice(0, 400)}`,
              `checks: ${row?.acceptanceChecks.join("; ") || "(none)"}`,
              `files: ${row?.expectedFiles.join(", ") || "(none)"}`,
              `repairs ${task.repairRounds}`,
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
          const target = view.state.order.find((id) => {
            const task = view.state.tasks[id];
            return task?.state === "blocked" || task?.state === "needs_fix";
          }) ?? view.nextTaskId;
          if (!target) return fail("There is no blocked, repaired or pending row to retry.");
          const task = view.state.tasks[target];
          if (view.phase === "blocked" || view.phase === "paused") {
            await owner.applyEvent({
              type: "run.transition",
              runId: view.runId,
              now: now(),
              to: "ready",
            });
          }
          if (task?.state === "blocked" || task?.state === "needs_fix") {
            const retried = await owner.applyEvent({
              type: "task.retry",
              runId: view.runId,
              now: now(),
              taskId: target,
            });
            if (!retried.ok) return fail(`Cannot retry ${target}: ${retried.error}`);
          }
          return {
            ok: true,
            verb: parsed.verb,
            text: `Run is ready; the host will retry the next pending row (${target}).`,
          };
        }

        default:
          return help();
      }
    },
  };
}
