/**
 * Workflow Extension — operator commands.
 *
 * `/orchestrator` without arguments stays MODE ENTRY (index.ts). This module is
 * the argument surface:
 *
 *   status | start [path] | pause | resume | abort | stop | retry |
 *   inspect [taskId] | view [child|parent|auto] | say <text> | cancel | help
 *
 * The run is a durable journal plus one in-process Build child. There is no
 * preview, approve, refine or execution-approval verb: the plan approval is the
 * only decision. `start` is handled by the command host, which owns the frozen
 * list; this module reports and controls an already-bound run.
 */

export const OPERATOR_SCHEMA_VERSION = 2 as const;
export const MAX_SAY_CHARS = 2_000;

import { rowForTask, taskCounts } from "./orchestrator-state.ts";
import {
  formatChildStatusLine,
  modelRefFromLabel,
  sanitizeStatLine,
} from "./child-stats.ts";

export const OPERATOR_VERBS = [
  "status",
  "start",
  "pause",
  "resume",
  "abort",
  "stop",
  "inspect",
  "say",
  "retry",
  "cancel",
  "view",
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

export interface OperatorChildSnapshot {
  phase: string;
  ref?: string;
  total?: number;
  modelLabel?: string;
  /** Structured live model, when the child can report one. */
  modelRef?: { provider: string; id: string; thinking?: string };
  stats?: import("./child-stats.ts").ChildRuntimeStats;
  lastTool?: string;
  lastError?: string;
  /** Elapsed active time, already frozen by the caller when paused. */
  elapsedMs?: number;
  todos: Array<{ text: string; completed: boolean }>;
}

export type OperatorView = "auto" | "parent" | "child";

export interface OperatorRuntimePorts {
  runtime: () => import("./orchestrator-runtime.ts").OrchestratorRuntime | undefined;
  now?: () => number;
  /** The live in-process child, when one exists. */
  child?: () => OperatorChildSnapshot | undefined;
  pauseChild?: () => Promise<boolean>;
  resumeChild?: (note?: string) => Promise<boolean>;
  abortChild?: (reason: string) => Promise<void>;
  stopChild?: () => Promise<void>;
  deliver?: (text: string) => Promise<{ ok: boolean; queued?: boolean; error?: string }>;
  view?: () => OperatorView;
  setView?: (view: OperatorView) => void;
  /** HEAD-aware diff for `inspect`, when a baseline exists. */
  diff?: (
    taskId: string,
  ) => Promise<{ committedPaths: string[]; dirtyPaths: string[] } | undefined>;
  /** Start a fresh child for a pending/blocked row (resume/retry recovery). */
  dispatchRow?: (taskId: string) => Promise<{ ok: boolean; text: string }>;
}

export interface OperatorResult {
  ok: boolean;
  verb: OperatorVerb;
  text: string;
}

export interface OperatorRuntime {
  run(args: string): Promise<OperatorResult>;
}

function childLine(child: OperatorChildSnapshot | undefined): string | undefined {
  if (!child) return undefined;
  const model =
    child.modelRef ??
    (child.modelLabel ? modelRefFromLabel(child.modelLabel) : undefined);
  const line = formatChildStatusLine({
    ...(child.ref ? { ref: child.ref } : {}),
    ...(child.total === undefined ? {} : { total: child.total }),
    phase: child.phase,
    ...(model ? { model } : {}),
    ...(child.stats ? { stats: child.stats } : {}),
    ...(child.elapsedMs === undefined ? {} : { elapsedMs: child.elapsedMs }),
    todoDone: child.todos.filter((item) => item.completed).length,
    todoTotal: child.todos.length,
  });
  const error = child.lastError
    ? ` · error: ${sanitizeStatLine(child.lastError).slice(0, 200)}`
    : "";
  return `${line}${error}`;
}

export function createOperatorRuntime(ports: OperatorRuntimePorts): OperatorRuntime {
  const now = ports.now ?? (() => Date.now());

  return {
    async run(args: string): Promise<OperatorResult> {
      const parsed = parseOperatorArgs(args);
      const owner = ports.runtime();
      const child = ports.child?.();
      const fail = (text: string): OperatorResult => ({
        ok: false,
        verb: parsed.verb,
        text,
      });
      const help = (): OperatorResult => ({
        ok: true,
        verb: parsed.verb,
        text: [
          "Usage: /orchestrator [status|start [path]|pause|resume|abort|stop|retry|inspect [taskId]|view [child|parent|auto]|say <text>|cancel]",
          "Bare /orchestrator enters the mode. Start freezes the approved plan into one TODO row per step and runs the first in-process Build child; there is no second breakdown approval.",
          "Aliases: /orchestrator-pause, /orchestrator-resume, /orchestrator-abort, /orchestrator-view.",
          "While a Builder owns the composer: Esc (or /orchestrator-pause) pauses; /orchestrator-resume continues; /orchestrator-abort stops. Repeated Esc never aborts.",
        ].join("\n"),
      });

      if (parsed.verb === "mode-entry" || parsed.verb === "help") return help();

      if (parsed.verb === "view") {
        const requested = parsed.rest.trim().toLowerCase();
        if (requested === "child" || requested === "parent" || requested === "auto") {
          ports.setView?.(requested);
        } else if (requested.length > 0) {
          return fail("Usage: /orchestrator view [child|parent|auto]");
        }
        const current = ports.view?.() ?? "auto";
        const line = childLine(child);
        return {
          ok: true,
          verb: parsed.verb,
          text: `View: ${current}${line ? `\n${line}` : "\nNo child is active."}`,
        };
      }

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
          const line = childLine(child);
          return {
            ok: true,
            verb: parsed.verb,
            text: [
              `run ${view.runId} · ${view.phase}`,
              view.plan
                ? `plan ${view.plan.path} (digest ${view.plan.digest.slice(0, 12)})`
                : `standalone: ${view.todos.source.title}`,
              `${counts.accepted}/${counts.total} accepted · ${counts.pending} pending · ${counts.running} in flight · ${counts.blocked} blocked`,
              ...(view.todos.workspaces && view.todos.workspaces.length > 0
                ? [`workspaces: ${view.todos.workspaces.map((workspace) => `${workspace.id}=${workspace.root}${workspace.primary ? " (primary)" : ""}`).join(" · ")}`]
                : []),
              ...(line ? [line] : []),
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
          if (
            view.phase === "completed" ||
            view.phase === "cancelled" ||
            view.phase === "failed"
          ) {
            return fail(`The run is ${view.phase}; it cannot be paused.`);
          }
          // Reconcile a durable "paused" whose child is still running (a
          // transition raced the pause). A truly paused run stays idempotent.
          if (view.phase === "paused" && (!child || child.phase !== "running")) {
            return fail("The run is already paused.");
          }
          const paused = await ports.pauseChild?.();
          if (!paused) {
            return fail(
              child
                ? "The child could not be paused; the run was left unchanged."
                : "No live child to pause; the warm session is already gone.",
            );
          }
          if (view.phase !== "paused") {
            const transitioned = await owner.applyEvent({
              type: "run.transition",
              runId: view.runId,
              now: now(),
              to: "paused",
            });
            if (!transitioned.ok) {
              return fail(
                `The child is paused, but the run could not record it: ${transitioned.error}`,
              );
            }
          }
          return {
            ok: true,
            verb: parsed.verb,
            text: "Run paused. The warm child can be resumed; no new row is dispatched.",
          };
        }

        case "resume": {
          if (child && (child.phase === "paused" || child.phase === "settling")) {
            const moved = view.phase === "paused";
            if (moved) {
              const transitioned = await owner.applyEvent({
                type: "run.transition",
                runId: view.runId,
                now: now(),
                to: "running",
              });
              if (!transitioned.ok) {
                return fail(`Cannot resume ${view.runId}: ${transitioned.error}`);
              }
            }
            // Admission is bounded and short: it starts the prompt, it does not
            // wait for the whole resumed row (a new Esc must stay responsive).
            const resumed = await ports.resumeChild?.(parsed.rest || undefined);
            if (!resumed) {
              if (moved) {
                const back = await owner.applyEvent({
                  type: "run.transition",
                  runId: view.runId,
                  now: now(),
                  to: "paused",
                });
                return fail(
                  back.ok
                    ? "The child could not be resumed; the run was returned to paused."
                    : "The child could not be resumed and the run phase needs /orchestrator status.",
                );
              }
              return fail(
                "The child could not be resumed; /orchestrator retry starts a fresh one.",
              );
            }
            return { ok: true, verb: parsed.verb, text: "Child resumed." };
          }
          // No warm child: recover a blocked/repaired row with a fresh child.
          const target =
            view.state.order.find((id) => {
              const task = view.state.tasks[id];
              return task?.state === "blocked" || task?.state === "needs_fix";
            }) ?? view.nextTaskId;
          if (!target) return fail(`The run is ${view.phase} and there is no row to resume.`);
          if (view.phase === "blocked" || view.phase === "paused") {
            await owner.applyEvent({
              type: "run.transition",
              runId: view.runId,
              now: now(),
              to: "ready",
            });
          }
          const task = view.state.tasks[target];
          if (task?.state === "blocked" || task?.state === "needs_fix") {
            const retried = await owner.applyEvent({
              type: "task.retry",
              runId: view.runId,
              now: now(),
              taskId: target,
            });
            if (!retried.ok) return fail(`Cannot resume ${target}: ${retried.error}`);
          }
          const dispatched = await ports.dispatchRow?.(target);
          return dispatched?.ok
            ? { ok: true, verb: parsed.verb, text: `Fresh child started for ${target}.\n${dispatched.text}` }
            : fail(
                dispatched
                  ? `Could not start ${target}: ${dispatched.text}`
                  : `No child dispatcher is bound; ${target} is queued again.`,
              );
        }

        case "abort": {
          if (!child) return fail("No Orchestrator child is active.");
          await ports.abortChild?.("user abort");
          const after = owner.view();
          if (after && after.phase !== "paused" && after.phase !== "cancelled") {
            await owner.applyEvent({
              type: "run.transition",
              runId: after.runId,
              now: now(),
              to: "paused",
            });
          }
          return {
            ok: true,
            verb: parsed.verb,
            text: "Child aborted. The row is retryable; /orchestrator retry starts a fresh child.",
          };
        }

        case "stop":
        case "cancel": {
          await ports.stopChild?.();
          const cancelled = await owner.cancel(
            parsed.verb === "stop" ? "operator stop" : "operator cancel",
          );
          return cancelled.ok
            ? { ok: true, verb: parsed.verb, text: "Run cancelled and the child disposed. Edits and history are preserved." }
            : fail(`Cannot cancel: ${cancelled.error}`);
        }

        case "inspect": {
          const taskId = parsed.rest || view.nextTaskId;
          if (!taskId) return fail("No task is active; pass a task id.");
          const task = view.state.tasks[taskId];
          if (!task) return fail(`Unknown task ${taskId}.`);
          const row = rowForTask(view.state, taskId);
          let diffLine: string | undefined;
          if (ports.diff) {
            try {
              const diff = await ports.diff(taskId);
              if (diff) {
                diffLine = `changed: ${[...diff.committedPaths, ...diff.dirtyPaths].slice(0, 20).join(", ") || "(none)"}`;
              }
            } catch {
              diffLine = "changed: (diff unavailable)";
            }
          }
          return {
            ok: true,
            verb: parsed.verb,
            text: [
              `${task.taskId} · ${task.state}${task.blockedReason ? ` · blocked: ${task.blockedReason}` : ""}`,
              `row ${row?.ref ?? "?"}: ${(row?.text ?? "").slice(0, 400)}`,
              `checks: ${row?.acceptanceChecks.join("; ") || "(none)"}`,
              `files: ${row?.expectedFiles.join(", ") || "(none)"}`,
              `repairs ${task.repairRounds}`,
              ...(childLine(child) ? [childLine(child)!] : []),
              ...(child && child.todos.length > 0
                ? [
                    `child todos: ${child.todos
                      .slice(0, 20)
                      .map((item) => `${item.completed ? "✓" : "○"} ${item.text.slice(0, 80)}`)
                      .join(" | ")}`,
                  ]
                : []),
              ...(diffLine ? [diffLine] : []),
              ...(child?.lastError ? [`child error: ${child.lastError.slice(0, 300)}`] : []),
            ].join("\n"),
          };
        }

        case "say": {
          const text = parsed.rest.slice(0, MAX_SAY_CHARS);
          if (!text) return fail("Usage: /orchestrator say <message for the child>");
          if (!child) {
            return fail(
              "No Orchestrator child is active; /orchestrator say needs a running or paused child.",
            );
          }
          const delivery = await ports.deliver?.(text);
          if (!delivery) return fail("No child is bound; the message was not sent.");
          if (!delivery.ok) {
            return fail(`The child could not receive the message: ${delivery.error ?? "unknown"}`);
          }
          return {
            ok: true,
            verb: parsed.verb,
            text: delivery.queued
              ? `Message queued for the paused child: ${text}`
              : `Message delivered to the child: ${text}`,
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
          const dispatched = await ports.dispatchRow?.(target);
          return dispatched?.ok
            ? { ok: true, verb: parsed.verb, text: `Fresh child started for ${target}.\n${dispatched.text}` }
            : fail(
                dispatched
                  ? `Could not start ${target}: ${dispatched.text}`
                  : `Run is ready; no child dispatcher is bound, so ${target} stays queued.`,
              );
        }

        default:
          return help();
      }
    },
  };
}

// ── Input routing (prompt cascade) ───────────────────────────────────

export type OrchestratorChildInputPhase =
  | "idle"
  | "starting"
  | "running"
  | "paused"
  | "settling"
  | "disposed";

export interface OrchestratorInputState {
  childPhase: OrchestratorChildInputPhase | undefined;
  hasRun: boolean;
}

export type OrchestratorInputDecision =
  | { action: "allow" }
  | { action: "forward" }
  | { action: "queue" }
  | { action: "refuse"; notice: string };

/**
 * Decide what a user prompt means while an Orchestrator run owns the session.
 *
 * - a slash command always passes through (its own guard may still refuse it);
 * - prose while a child runs is forwarded to that child (steer);
 * - prose while the child is paused is queued for the next resume;
 * - prose with a bound run but no live child is refused with the recovery
 *   command, so the parent model never starts a second owner.
 */
export function orchestratorInputDecision(
  text: string,
  state: OrchestratorInputState,
): OrchestratorInputDecision {
  const value = typeof text === "string" ? text.trim() : "";
  if (value.length === 0) return { action: "allow" };
  if (value.startsWith("/")) return { action: "allow" };
  if (state.childPhase === "running") {
    return { action: "forward" };
  }
  if (state.childPhase === "starting") {
    // The controller cannot deliver into a session that is still being
    // created; saying "forwarded" would be a lie and drop the prompt.
    return {
      action: "refuse",
      notice:
        "The Build child is starting. Wait until the composer shows Working, then send the note again.",
    };
  }
  if (state.childPhase === "paused") return { action: "queue" };
  if (state.hasRun) {
    return {
      action: "refuse",
      notice:
        "The Orchestrator run owns this session but no child is live. Use /orchestrator-resume to continue the warm child, or /orchestrator retry to start a fresh one.",
    };
  }
  return { action: "allow" };
}
