/**
 * Workflow Extension — the `/orchestrator` operator (single dispatcher).
 *
 * The grammar lives in `orchestrator-command.ts` (verb table, parser, help and
 * completions, all pure). This module owns the EFFECTS:
 *
 *   /orchestrator <verb> [args]   (bare `/orchestrator` enters the mode)
 *
 * `run(args)` parses once and dispatches. Decision 3 guards are read from the
 * table (`requiresMode`, `run`) and applied generically here; each verb's
 * child/phase checks stay inside its own case so their refusal copy is
 * unchanged. There is no `cancel` verb (`stop` is the only cancel) and no
 * aliases — the parser already reports `cancel` as unknown with the `stop`
 * hint.
 *
 * The run is the session's `OrchestratorRun` record plus one in-process Build
 * child. There is no preview, approve, refine or acceptance verb: the plan
 * approval is the only decision. `start` is model-mediated: the port records
 * the plan and sends the kickoff; the model then calls `orchestrator_start`
 * with the rows.
 *
 * Notification-free: every method returns text and the caller notifies.
 */

import {
  formatChildStatusLine,
  modelRefFromLabel,
  sanitizeStatLine,
} from "./child-stats.ts";
import {
  formatOrchestratorHelp,
  MAX_SAY_CHARS,
  ORCHESTRATOR_VERBS,
  orchestratorVerb,
  parseOrchestratorInvocation,
  type OrchestratorVerbName,
} from "./orchestrator-command.ts";
import type { OrchestratorRun, OrchestratorRunPhase } from "./orchestrator-run.ts";
import type { WorkflowMode } from "./workflow-mode.ts";

/**
 * Bumped when the operator's public surface changes shape. 4 = schema-driven
 * grammar (no `cancel`, no aliases, `mode`/`start`/`abort` ports).
 */
export const OPERATOR_SCHEMA_VERSION = 4 as const;

export type OperatorVerb = OrchestratorVerbName | "mode-entry";

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

/**
 * The public contract between the composition root and the dispatcher.
 *
 * Every port except `run` is optional so a partially wired host still works.
 * `mode` returning `undefined` (unwired) is treated as permissive rather than
 * as "wrong mode"; a wired port is authoritative.
 */
export interface OperatorRuntimePorts {
  run: () => OrchestratorRun | undefined;
  /** The live workflow mode; a wired port gates the mode-required verbs. */
  mode?: () => WorkflowMode;
  /** The live TODO list; completion decides whether a row is done. */
  todos?: () => OperatorTodoRow[];
  now?: () => number;
  /** The live in-process child, when one exists. */
  child?: () => OperatorChildSnapshot | undefined;
  pauseChild?: () => Promise<boolean>;
  resumeChild?: (note?: string) => Promise<boolean>;
  /** Record the approved plan and send the start kickoff (`""` = bare start). */
  start?: (path: string) => Promise<{ ok: boolean; text: string }>;
  /** Abort the live child; `aborted` is false for an idempotent no-op. */
  abort?: (
    reason: string,
  ) => Promise<{ ok: boolean; text: string; aborted: boolean }>;
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
  /** `error` means the invocation never parsed as a verb. */
  verb: OperatorVerb | "error";
  text: string;
}

export interface OperatorRuntime {
  run(args: string): Promise<OperatorResult>;
}

/** Shared no-run guidance: read-only verbs report it, mutating verbs fail. */
const NO_RUN_TEXT =
  "No Orchestrator run is bound yet. Start one with /orchestrator start <path>, or call orchestrator_start with the approved steps. Nothing was launched.";

function modeRefusalText(verb: OrchestratorVerbName): string {
  return `/orchestrator ${verb} is available in Orchestrator mode only. Enter it with /orchestrator (bare) or Tab; no other switch is needed.`;
}

function boundRunRefusalText(run: OrchestratorRun): string {
  return `A run is already bound (${run.runId}); use /orchestrator status to read it, /orchestrator retry to dispatch a row, or /orchestrator stop to cancel it before starting another.`;
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
      const parsed = parseOrchestratorInvocation(args);
      const fail = (verb: OperatorResult["verb"], text: string): OperatorResult => ({
        ok: false,
        verb,
        text,
      });

      // ── Parse errors, mode entry and help come first, before any state. ──
      if (parsed.kind === "error") {
        return { ok: false, verb: "error", text: parsed.text };
      }
      if (parsed.kind === "mode-entry") {
        return { ok: true, verb: "mode-entry", text: formatOrchestratorHelp() };
      }
      if (parsed.kind === "help") {
        return {
          ok: true,
          verb: "help",
          text: formatOrchestratorHelp(parsed.verb),
        };
      }

      const verb = parsed.verb;
      const spec = orchestratorVerb(verb);
      // The parser only yields table verbs; keep a defensive refusal instead of
      // trusting that invariant at runtime.
      if (!spec) {
        return fail(
          "error",
          `Unknown Orchestrator verb "${verb}". Run /orchestrator help for the verb list.`,
        );
      }

      const run = ports.run();
      const child = ports.child?.();

      // ── Decision 3 guards, read from the table (never inferred). ──────
      // A wired `mode` port is authoritative; an unwired one is permissive so
      // a partially wired host does not refuse everything.
      const mode = ports.mode?.();
      if (spec.requiresMode && mode !== undefined && mode !== "orchestrator") {
        return fail(verb, modeRefusalText(verb));
      }
      if (spec.run === "forbidden" && run) {
        return fail(verb, boundRunRefusalText(run));
      }

      // ── `start` runs before the run-bound guard (it CREATES the run). ──
      if (verb === "start") {
        if (!ports.start) {
          return fail(
            verb,
            "No Orchestrator start is bound in this session; nothing was launched.",
          );
        }
        const started = await ports.start(parsed.path ?? "");
        return { ok: started.ok, verb, text: started.text };
      }

      // ── `view` needs no run, so it also comes before the guard. ───────
      if (verb === "view") {
        if (parsed.view) ports.setView?.(parsed.view);
        const current = ports.view?.() ?? "auto";
        const line = childLine(child);
        return {
          ok: true,
          verb,
          text: `View: ${current}${line ? `\n${line}` : "\nNo child is active."}`,
        };
      }

      // ── No-run guard: `status` still answers, everything else refuses. ──
      if (!run) {
        return verb === "status"
          ? { ok: true, verb, text: NO_RUN_TEXT }
          : fail(verb, NO_RUN_TEXT);
      }

      const rows = ports.todos?.() ?? [];
      const doneRefs = completedRefs(rows);
      const done = run.rows.filter((row) => doneRefs.has(row.ref)).length;
      const total = run.rows.length;
      const next = run.rows.find((row) => !doneRefs.has(row.ref));
      const target = (): string | undefined =>
        parsed.rowRef || run.currentRef || next?.ref;

      switch (verb) {
        case "status": {
          const line = childLine(child);
          const currentRow = run.currentRef
            ? run.rows.find((row) => row.ref === run.currentRef)
            : undefined;
          return {
            ok: true,
            verb,
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
              ...(currentRow?.lastReport
                ? [
                    `report (row ${currentRow.ref}):`,
                    currentRow.lastReport.slice(0, 1_200),
                  ]
                : []),
              ...(next
                ? [`next row: ${next.ref} — ${next.text.slice(0, 200)}`]
                : ["every row is done"]),
            ].join("\n"),
          };
        }

        case "pause": {
          if (run.phase === "completed" || run.phase === "cancelled") {
            return fail(verb, `The run is ${run.phase}; it cannot be paused.`);
          }
          if (child?.phase === "paused") {
            return fail(verb, "The run is already paused.");
          }
          if (!child || (child.phase !== "running" && child.phase !== "starting")) {
            return fail(verb, "No live child to pause; the run is already idle.");
          }
          const paused = await ports.pauseChild?.();
          if (!paused) {
            return fail(
              verb,
              "The child could not be paused; the run was left unchanged.",
            );
          }
          ports.setPhase?.("paused");
          return {
            ok: true,
            verb,
            text: "Run paused. The warm child can be resumed; no new row is dispatched.",
          };
        }

        case "resume": {
          // Only a warm PAUSED child can be resumed. A settled child was
          // released by the settle path, so the fallback starts a fresh one.
          if (child && child.phase === "paused") {
            const resumed = await ports.resumeChild?.();
            if (!resumed) {
              return fail(
                verb,
                "The child could not be resumed; /orchestrator retry starts a fresh one.",
              );
            }
            ports.setPhase?.("running");
            return { ok: true, verb, text: "Child resumed." };
          }
          const rowRef = target();
          if (!rowRef) {
            return fail(verb, `The run is ${run.phase} and every row is done.`);
          }
          const retried = await ports.retry?.(rowRef);
          if (retried?.ok) {
            return {
              ok: true,
              verb,
              text: `Fresh child started for row ${rowRef}.\n${retried.text}`,
            };
          }
          return fail(
            verb,
            retried
              ? `Could not start row ${rowRef}: ${retried.text}`
              : `No child dispatcher is bound; row ${rowRef} stays pending.`,
          );
        }

        case "abort": {
          if (!child) return fail(verb, "No Orchestrator child is active.");
          if (!ports.abort) {
            return fail(
              verb,
              "No Orchestrator abort is bound in this session; the child was left running.",
            );
          }
          const aborted = await ports.abort("user abort");
          // Only a real abort pauses the run; an idempotent no-op leaves the
          // phase alone (the helper reports `aborted: false`).
          if (aborted.ok && aborted.aborted) ports.setPhase?.("paused");
          return { ok: aborted.ok, verb, text: aborted.text };
        }

        case "stop": {
          await ports.stopChild?.();
          ports.setPhase?.("cancelled");
          return {
            ok: true,
            verb,
            text: "Run cancelled and the child disposed. Edits and history are preserved.",
          };
        }

        case "inspect": {
          const rowRef = target();
          if (!rowRef) return fail(verb, "No row is active; pass a row ref.");
          const row = run.rows.find((entry) => entry.ref === rowRef);
          if (!row) return fail(verb, `Unknown row ${rowRef}.`);
          const workspace = run.workspaces?.find(
            (entry) => entry.id === row.workspaceId,
          );
          return {
            ok: true,
            verb,
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
          // The parser already refuses empty and over-long messages, so this
          // text is delivered byte-for-byte and never sliced.
          const text = parsed.text ?? "";
          if (!text) {
            return fail(verb, "Usage: /orchestrator say <message for the child>");
          }
          if (text.length > MAX_SAY_CHARS) {
            return fail(
              verb,
              `The message is ${text.length} characters; the limit is ${MAX_SAY_CHARS}. Nothing was delivered.`,
            );
          }
          if (!child) {
            return fail(
              verb,
              "No Orchestrator child is active; /orchestrator say needs a running or paused child.",
            );
          }
          const delivery = await ports.deliver?.(text);
          if (!delivery) return fail(verb, "No child is bound; the message was not sent.");
          if (!delivery.ok) {
            return fail(
              verb,
              `The child could not receive the message: ${delivery.error ?? "unknown"}`,
            );
          }
          return {
            ok: true,
            verb,
            text: delivery.queued
              ? `Message queued for the paused child: ${text}`
              : `Message delivered to the child: ${text}`,
          };
        }

        case "retry": {
          const rowRef = target();
          if (!rowRef) return fail(verb, "There is no row to retry.");
          const retried = await ports.retry?.(rowRef);
          return retried?.ok
            ? {
                ok: true,
                verb,
                text: `Fresh child started for row ${rowRef}.\n${retried.text}`,
              }
            : fail(
                verb,
                retried
                  ? `Could not start row ${rowRef}: ${retried.text}`
                  : `No child dispatcher is bound, so row ${rowRef} stays pending.`,
              );
        }

        default: {
          // Unreachable: `start`, `view` and `help` returned above and the
          // switch covers every remaining table verb. Kept so a future verb
          // added to the table fails loudly instead of silently doing nothing.
          const known = ORCHESTRATOR_VERBS.map((entry) => entry.name).join("|");
          return fail(
            verb,
            `Unsupported Orchestrator verb "${verb}". Known verbs: ${known}.`,
          );
        }
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
        "The Orchestrator run owns this session but no child is live. Use /orchestrator retry to start a fresh child for the current row, or /orchestrator status to read its report. Resume only continues a paused warm child.",
    };
  }
  return { action: "allow" };
}
