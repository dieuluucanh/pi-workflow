/**
 * Workflow Extension — operator commands.
 *
 * `/orchestrator` without arguments stays MODE ENTRY (index.ts). This module is
 * the argument surface:
 *
 *   status | start [path] | pause | resume | abort | stop | retry |
 *   inspect [rowRef] | view [child|parent|auto] | say <text> | cancel | help
 *
 * The run is the session's `OrchestratorRun` record plus one in-process Build
 * child. There is no preview, approve, refine or acceptance verb: the plan
 * approval is the only decision. `start` is a model tool; this module reports
 * and controls an already-bound run.
 */

import {
  formatChildStatusLine,
  modelRefFromLabel,
  sanitizeStatLine,
} from "./child-stats.ts";
import type { OrchestratorRun, OrchestratorRunPhase } from "./orchestrator-run.ts";

export const OPERATOR_SCHEMA_VERSION = 3 as const;
export const MAX_SAY_CHARS = 2_000;

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
  /** A pause request is still settling (the report says `pausing`). */
  pausePending?: boolean;
  /** Provider backoff is active (the report says `retrying`). */
  retrying?: boolean;
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

/** One row of the parent's plain TODO list, as the operator sees it. */
export interface OperatorTodoRow {
  ref: string;
  text: string;
  completed: boolean;
}

export interface OperatorRuntimePorts {
  run: () => OrchestratorRun | undefined;
  /** The live TODO list; completion decides whether a row is done. */
  todos?: () => OperatorTodoRow[];
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
  /** Record a run phase change (pause/resume/abort/stop). */
  setPhase?: (phase: OrchestratorRunPhase) => void;
  /** Re-dispatch the current or named row with its stored instruction. */
  retry?: (rowRef?: string) => Promise<{ ok: boolean; text: string }>;
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
  // Unlike the one-row footer and the composer border, this is a multi-line
  // report: naming the row and the child's own todo progress is useful and
  // nothing is competing for the width.
  const line = formatChildStatusLine(
    {
      ...(child.ref ? { ref: child.ref } : {}),
      ...(child.total === undefined ? {} : { total: child.total }),
      phase: child.phase,
      ...(child.pausePending === undefined
        ? {}
        : { pausePending: child.pausePending }),
      ...(child.retrying === undefined ? {} : { retrying: child.retrying }),
      ...(model ? { model } : {}),
      ...(child.stats ? { stats: child.stats } : {}),
      ...(child.elapsedMs === undefined ? {} : { elapsedMs: child.elapsedMs }),
      todoDone: child.todos.filter((item) => item.completed).length,
      todoTotal: child.todos.length,
    },
    { showRow: true, showTodoCount: true },
  );
  const error = child.lastError
    ? ` · error: ${sanitizeStatLine(child.lastError).slice(0, 200)}`
    : "";
  return `${line}${error}`;
}

/** Rows the TODO list reports complete, keyed by run ref. */
function completedRefs(rows: readonly OperatorTodoRow[]): Set<string> {
  return new Set(rows.filter((row) => row.completed).map((row) => row.ref));
}

export function createOperatorRuntime(ports: OperatorRuntimePorts): OperatorRuntime {
  return {
    async run(args: string): Promise<OperatorResult> {
      const parsed = parseOperatorArgs(args);
      const run = ports.run();
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
          "Usage: /orchestrator [status|start [path]|pause|resume|abort|stop|retry|inspect [rowRef]|view [child|parent|auto]|say <text>|cancel]",
          "Bare /orchestrator enters the mode. Start is the model tool orchestrator_start: it records one row per plan step and the parent dispatches them one at a time.",
          "Aliases: /orchestrator-pause, /orchestrator-resume, /orchestrator-abort, /orchestrator-view.",
          "While a child owns the composer: Esc (or /orchestrator-pause) pauses; /orchestrator-resume continues; /orchestrator-abort stops. Repeated Esc never aborts.",
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

      if (!run) {
        return fail(
          "No Orchestrator run is bound. Call orchestrator_start with the approved steps, or restart from the approved plan. Nothing was launched.",
        );
      }

      const rows = ports.todos?.() ?? [];
      const doneRefs = completedRefs(rows);
      const done = run.rows.filter((row) => doneRefs.has(row.ref)).length;
      const total = run.rows.length;
      const next = run.rows.find((row) => !doneRefs.has(row.ref));
      const target = (): string | undefined =>
        parsed.rest.trim() || run.currentRef || next?.ref;

      switch (parsed.verb) {
        case "status": {
          const line = childLine(child);
          return {
            ok: true,
            verb: parsed.verb,
            text: [
              `run ${run.runId} · ${run.phase}`,
              run.planPath ? `plan ${run.planPath}` : `standalone: ${run.title}`,
              `${done}/${total} rows done${next ? ` · next ${next.ref}` : ""}`,
              ...(run.workspaces && run.workspaces.length > 0
                ? [
                    `workspaces: ${run.workspaces
                      .map(
                        (workspace) =>
                          `${workspace.id}=${workspace.root}${workspace.primary ? " (primary)" : ""}`,
                      )
                      .join(" · ")}`,
                  ]
                : []),
              ...(line ? [line] : []),
              ...(run.blockedReason ? [`blocked: ${run.blockedReason}`] : []),
              ...(next ? [`next row: ${next.ref} — ${next.text.slice(0, 200)}`] : ["every row is done"]),
            ].join("\n"),
          };
        }

        case "start": {
          return fail(
            run.rows.length > 0
              ? `Run ${run.runId} is already bound. Start a new run only after the current one is cancelled or completed; otherwise dispatch the next row or retry the current one.`
              : `Run ${run.runId} has no rows. Call orchestrator_start with the plan's steps.`,
          );
        }

        case "pause": {
          if (run.phase === "completed" || run.phase === "cancelled") {
            return fail(`The run is ${run.phase}; it cannot be paused.`);
          }
          if (child?.phase === "paused") return fail("The run is already paused.");
          if (!child || (child.phase !== "running" && child.phase !== "starting")) {
            return fail("No live child to pause; the run is already idle.");
          }
          const paused = await ports.pauseChild?.();
          if (!paused) {
            return fail("The child could not be paused; the run was left unchanged.");
          }
          ports.setPhase?.("paused");
          return {
            ok: true,
            verb: parsed.verb,
            text: "Run paused. The warm child can be resumed; no new row is dispatched.",
          };
        }

        case "resume": {
          if (child && (child.phase === "paused" || child.phase === "settling")) {
            const resumed = await ports.resumeChild?.(parsed.rest || undefined);
            if (!resumed) {
              return fail(
                "The child could not be resumed; /orchestrator retry starts a fresh one.",
              );
            }
            ports.setPhase?.("running");
            return { ok: true, verb: parsed.verb, text: "Child resumed." };
          }
          const rowRef = target();
          if (!rowRef) {
            return fail(`The run is ${run.phase} and every row is done.`);
          }
          const retried = await ports.retry?.(rowRef);
          if (retried?.ok) {
            return {
              ok: true,
              verb: parsed.verb,
              text: `Fresh child started for row ${rowRef}.\n${retried.text}`,
            };
          }
          return fail(
            retried
              ? `Could not start row ${rowRef}: ${retried.text}`
              : `No child dispatcher is bound; row ${rowRef} stays pending.`,
          );
        }

        case "abort": {
          if (!child) return fail("No Orchestrator child is active.");
          await ports.abortChild?.("user abort");
          ports.setPhase?.("paused");
          return {
            ok: true,
            verb: parsed.verb,
            text: "Child aborted. The row is retryable; /orchestrator retry starts a fresh child.",
          };
        }

        case "stop":
        case "cancel": {
          await ports.stopChild?.();
          ports.setPhase?.("cancelled");
          return {
            ok: true,
            verb: parsed.verb,
            text: "Run cancelled and the child disposed. Edits and history are preserved.",
          };
        }

        case "inspect": {
          const rowRef = target();
          if (!rowRef) return fail("No row is active; pass a row ref.");
          const row = run.rows.find((entry) => entry.ref === rowRef);
          if (!row) return fail(`Unknown row ${rowRef}.`);
          const workspace = run.workspaces?.find(
            (entry) => entry.id === row.workspaceId,
          );
          return {
            ok: true,
            verb: parsed.verb,
            text: [
              `row ${row.ref} · ${run.phase}`,
              `root: ${row.cwd ?? workspace?.root ?? "(session root)"}${workspace ? ` (id ${workspace.id}${workspace.primary ? ", primary" : ""})` : ""}`,
              `text: ${row.text.slice(0, 800)}`,
              `instruction: ${(row.instruction ?? "(not dispatched yet)").slice(0, 800)}`,
              `last report: ${(row.lastReport ?? "(none)").slice(0, 1_200)}`,
              ...(childLine(child) ? [childLine(child)!] : []),
              ...(child && child.todos.length > 0
                ? [
                    `child todos: ${child.todos
                      .slice(0, 20)
                      .map((item) => `${item.completed ? "✓" : "○"} ${item.text.slice(0, 80)}`)
                      .join(" | ")}`,
                  ]
                : []),
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
          const rowRef = target();
          if (!rowRef) return fail("There is no row to retry.");
          const retried = await ports.retry?.(rowRef);
          return retried?.ok
            ? {
                ok: true,
                verb: parsed.verb,
                text: `Fresh child started for row ${rowRef}.\n${retried.text}`,
              }
            : fail(
                retried
                  ? `Could not start row ${rowRef}: ${retried.text}`
                  : `No child dispatcher is bound, so row ${rowRef} stays pending.`,
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
