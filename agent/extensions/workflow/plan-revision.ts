/**
 * Workflow Extension — the Planner's revision turn (Planner↔Reviewer loop).
 *
 * The 2026-11-26 plan splits the reviewed plan into two owned halves: the
 * Planner owns the BODY, the Reviewer owns the `## Reviewer Revisions (round N)`
 * appendix. This module is the Planner's side of that argument:
 *
 *   - `buildPlanRevisionPrompt` renders the bounded revision prompt that names
 *     the plan, the round, the ownership rules and every note to answer;
 *   - `createPlanRevisionDoneTool` is the `plan_revision_done` child report:
 *     it refuses an answer set that skips a note, invents an id, rejects
 *     without a reason, edits the Reviewer's appendix, or claims `applied`
 *     without changing the body.
 *
 * Everything here is pure except the tool's injected deps: no file access, no
 * Pi runtime, no model calls. The host (`index.ts`) owns the loop state; this
 * module only asks it questions and hands it one settled response set.
 *
 * Row 2 registers the tool but never sets `pending`, so the tool is inert
 * until the loop wiring (step 3) starts a revision turn.
 */

import { Type, type TSchema } from "typebox";

import { splitReviewerAppendix, type ReviewNote } from "./utils.ts";

/** The tool name Plan mode activates for the revision turn. */
export const PLAN_REVISION_TOOL_NAME = "plan_revision_done";

/** Whole-prompt bound, mirroring the Orchestrator child kickoff bound. */
export const MAX_REVISION_PROMPT_CHARS = 12_000;

/** Notes listed in full before the `… and N more: R7, R8` tail. */
export const MAX_REVISION_PROMPT_NOTES = 12;

/** Per-note change text kept in the prompt. */
export const MAX_REVISION_PROMPT_CHANGE_CHARS = 400;

/**
 * The corrective line for the retry of a Planner turn that changed nothing.
 * It is phrased as an instruction, never as a new task, so the same notes are
 * still the only thing the Planner answers.
 */
export const PLAN_REVISION_CORRECTIVE_PREAMBLE =
  "Your previous revision turn changed nothing. Apply the notes or reject them with a concrete reason.";

/** The three dispositions a Planner may report for one note. */
export type PlanRevisionStatus = "applied" | "rejected" | "not_applicable";

/** How the Planner settled one Reviewer note. */
export interface PlanRevisionResponse {
  /** The note id this answers, `R<n>`. */
  id: string;
  status: PlanRevisionStatus;
  /** Required for `rejected` / `not_applicable`; optional for `applied`. */
  reason?: string;
}

const PLAN_REVISION_STATUSES: readonly PlanRevisionStatus[] = [
  "applied",
  "rejected",
  "not_applicable",
];

function clipText(value: unknown, max: number): string {
  const text = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** `R1 · Step 2: change` — the same per-note shape the appendix renders. */
function noteLine(note: ReviewNote): string {
  const id = clipText(note.id, 16) || "R?";
  const step = note.step === undefined ? "" : ` · Step ${clipText(note.step, 40)}`;
  const change = clipText(note.change, MAX_REVISION_PROMPT_CHANGE_CHARS);
  return `- ${id}${step}: ${change}`;
}

function boundPrompt(text: string, max = MAX_REVISION_PROMPT_CHARS): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n… (truncated)`;
}

/**
 * Render the Planner's revision prompt for one revision turn.
 *
 * Bounded: at most {@link MAX_REVISION_PROMPT_NOTES} notes are listed in full,
 * the surplus collapses into `… and N more: <ids>` so an id is never silently
 * dropped, each change is clipped to
 * {@link MAX_REVISION_PROMPT_CHANGE_CHARS}, and the whole prompt is capped at
 * {@link MAX_REVISION_PROMPT_CHARS}. Never throws.
 */
export function buildPlanRevisionPrompt(input: {
  planPath: string;
  round: number;
  maxRounds: number;
  notes: readonly ReviewNote[];
  /**
   * Optional corrective note placed under the heading. Only a retried turn
   * (the previous one changed nothing) sets it; the normal prompt format is
   * unchanged when it is absent.
   */
  preamble?: string;
}): string {
  const planPath = String(input?.planPath ?? "").trim() || "the current plan file";
  const rawRound = Number(input?.round);
  const round = Number.isFinite(rawRound) ? Math.max(1, Math.trunc(rawRound)) : 1;
  const rawMax = Number(input?.maxRounds);
  const maxRounds = Number.isFinite(rawMax)
    ? Math.max(round, Math.trunc(rawMax))
    : round;
  const notes = Array.isArray(input?.notes) ? input.notes : [];
  const preamble = String(input?.preamble ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 600);

  const listed = notes.slice(0, MAX_REVISION_PROMPT_NOTES);
  const surplus = notes.slice(MAX_REVISION_PROMPT_NOTES);
  const noteBlock = listed.map(noteLine).join("\n");
  const tail =
    surplus.length === 0
      ? ""
      : `\n… and ${surplus.length} more: ${surplus
          .map((note) => clipText(note.id, 16) || "R?")
          .join(", ")}`;

  const lines = [
    `# Planner revision — round ${round} of ${maxRounds}`,
    "",
    ...(preamble ? [`> ${preamble}`, ""] : []),
    `Plan file: ${planPath}`,
    "",
    "The Reviewer reviewed your plan and left notes. You are the Planner: you own",
    "the plan BODY. The Reviewer owns the `## Reviewer Revisions (round N)`",
    "appendix at the end of the same file. The two halves are separate ownership:",
    "edit yours, never theirs.",
    "",
    "## Rules",
    "",
    "1. Revise the plan BODY only (inside `.pi/plans/`). Do NOT edit, move,",
    "   reorder or delete the Reviewer's `## Reviewer Revisions` appendix, not even",
    "   its heading or the round number.",
    "2. Answer every note exactly once by calling `plan_revision_done` with one",
    `   response per note id: \`applied\`, \`rejected\` or \`not_applicable\`.`,
    "3. `applied` means the body edit that addresses that note is already saved in",
    "   the plan file. A claimed \`applied\` with an unchanged body is refused.",
    "4. `rejected` and `not_applicable` require a concrete reason: cite the",
    "   codebase evidence, the requirement or the constraint that makes the note",
    "   unnecessary. \"Disagree\" is not a reason.",
    "5. Keep the reviewed plan honest: do not narrow requirements or delete",
    "   verification just to make a note go away.",
    "6. If the revised steps change the work plan, update the TODO list with",
    "   `workflow_todo` so the panel matches the plan the Reviewer will re-audit.",
    "7. Call `plan_revision_done` when the body is saved. The Reviewer re-reviews",
    "   the revised body next; do not call `review_submit` yourself.",
    "",
    `## Notes to answer (${notes.length})`,
    "",
    noteBlock || "(the Reviewer left no notes)",
    tail,
    "",
  ];

  return boundPrompt(`${lines.join("\n").replace(/\n+$/, "")}\n`);
}

/** Text result shape shared with the review tools. */
export interface PlanRevisionToolTextResult {
  content: Array<{ type: "text"; text: string }>;
  details?: Record<string, unknown>;
  isError?: boolean;
}

/** Everything the tool needs from the host's loop state, all request-scoped. */
export interface PlanRevisionToolDeps {
  /** True only while a Planner revision turn is waiting for this report. */
  pending: () => boolean;
  /** The notes parsed from the appendix the Planner was asked to answer. */
  notes: () => readonly ReviewNote[];
  /** The LIVE plan file (`undefined` when it cannot be read). */
  readPlan: () => string | undefined;
  /** The appendix exactly as it stood when the revision turn started. */
  expectedAppendix: () => string;
  /** Body hash recorded when the revision turn started. */
  bodyHashAtStart: () => string;
  /** Hash of the BODY of a full plan text (appendix split off first). */
  planHashBody: (text: string) => string;
  /** Accept the validated response set and continue the loop. */
  settle: (responses: PlanRevisionResponse[]) => void;
}

export interface PlanRevisionToolDefinition {
  name: string;
  label: string;
  description: string;
  parameters: TSchema;
  execute: (...args: unknown[]) => Promise<PlanRevisionToolTextResult>;
}

function textResult(
  text: string,
  details?: Record<string, unknown>,
  isError = false,
): PlanRevisionToolTextResult {
  return {
    content: [{ type: "text", text }],
    ...(details === undefined ? {} : { details }),
    ...(isError ? { isError: true } : {}),
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

interface RawResponse {
  id: string;
  status: unknown;
  reason?: string;
}

function readResponses(value: unknown): RawResponse[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: RawResponse[] = [];
  for (const entry of value) {
    const record = asRecord(entry);
    if (!record) return undefined;
    const raw: RawResponse = {
      id: String(record.id ?? "").trim().toUpperCase(),
      status: record.status,
    };
    if (record.reason !== undefined) raw.reason = String(record.reason ?? "");
    out.push(raw);
  }
  return out;
}

/**
 * `plan_revision_done` — the only way a Planner revision turn can end.
 *
 * Validation order is fixed and each step returns before the next runs, so a
 * refusal always names the first broken rule:
 *
 *   a. a revision turn is pending;
 *   b. every current note id is covered exactly once (unknown/duplicate/missing
 *      ids refused with the offending ids);
 *   c. every status is one of the three and `rejected`/`not_applicable` carry a
 *      non-empty reason;
 *   d. the live plan's appendix is still the expected one (trimmed, line-ending
 *      and trailing-whitespace normalized by `splitReviewerAppendix`);
 *   e. when any response is `applied`, the body hash must differ from the hash
 *      recorded at the start of the turn;
 *   f. on success `settle(responses)` runs and the summary is returned.
 *
 * Never throws and never writes: a refusal leaves the loop pending.
 */
export function createPlanRevisionDoneTool(
  deps: PlanRevisionToolDeps,
): PlanRevisionToolDefinition {
  return {
    name: PLAN_REVISION_TOOL_NAME,
    label: "Plan Revision Done",
    description:
      "Report how you settled each Reviewer note: one response per note id with status applied | rejected | not_applicable (a reason is required for rejected/not_applicable). You may edit the plan body; the Reviewer's '## Reviewer Revisions' appendix must stay byte-identical, and any 'applied' response requires a real body change. Call this once, when the revised plan body is saved.",
    parameters: Type.Object({
      responses: Type.Array(
        Type.Object({
          id: Type.String({
            description: "The Reviewer's note id, e.g. R1.",
          }),
          status: Type.Union([
            Type.Literal("applied"),
            Type.Literal("rejected"),
            Type.Literal("not_applicable"),
          ]),
          reason: Type.Optional(
            Type.String({
              description:
                "Why the note was rejected or does not apply. Required for rejected and not_applicable.",
            }),
          ),
        }),
        {
          description:
            "One entry per Reviewer note. Every current note id exactly once.",
        },
      ),
      summary: Type.Optional(
        Type.String({
          description: "One short line describing what changed in the body.",
        }),
      ),
    }),
    async execute(...args: unknown[]): Promise<PlanRevisionToolTextResult> {
      // SAFETY: Pi calls ToolDefinition.execute as
      // (toolCallId, params, signal, onUpdate, ctx); only params is read here.
      const [, rawParams] = args as unknown as [
        string,
        { responses?: unknown; summary?: unknown },
      ];

      // a. A revision turn must be waiting for this report.
      if (!deps.pending()) {
        return textResult(
          "plan_revision_done: no Planner revision is pending. This tool only answers a revision turn sent after a revise verdict; nothing was recorded.",
          undefined,
          true,
        );
      }

      const notes = deps.notes();
      const known = new Set(notes.map((note) => note.id.toUpperCase()));

      // b. Shape + coverage: every note id exactly once, no invented ids.
      const responses = readResponses(rawParams?.responses);
      if (!responses) {
        return textResult(
          "plan_revision_done: `responses` must be an array of { id, status, reason? }.",
          undefined,
          true,
        );
      }
      const seen = new Set<string>();
      const duplicates: string[] = [];
      const unknown: string[] = [];
      for (const response of responses) {
        if (!response.id) {
          return textResult(
            "plan_revision_done: a response is missing its note id.",
            undefined,
            true,
          );
        }
        if (seen.has(response.id)) duplicates.push(response.id);
        seen.add(response.id);
        if (!known.has(response.id)) unknown.push(response.id);
      }
      if (unknown.length > 0) {
        return textResult(
          `plan_revision_done: unknown note ids: ${unknown.join(", ")}. Answer only ${[
            ...known,
          ].join(", ") || "(no notes)"}.`,
          undefined,
          true,
        );
      }
      if (duplicates.length > 0) {
        return textResult(
          `plan_revision_done: duplicate responses for: ${duplicates.join(", ")}. One response per note id.`,
          undefined,
          true,
        );
      }
      const missing = [...known].filter((id) => !seen.has(id));
      if (missing.length > 0) {
        return textResult(
          `plan_revision_done: missing responses for: ${missing.join(", ")}. Every note needs exactly one response.`,
          undefined,
          true,
        );
      }

      // c. Status vocabulary + a real reason for rejected / not_applicable.
      const settled: PlanRevisionResponse[] = [];
      const badStatus: string[] = [];
      const missingReason: string[] = [];
      for (const response of responses) {
        const status = response.status;
        if (!PLAN_REVISION_STATUSES.includes(status as PlanRevisionStatus)) {
          badStatus.push(`${response.id} (${String(status ?? "none")})`);
          continue;
        }
        const reason = String(response.reason ?? "")
          .replace(/\s+/g, " ")
          .trim();
        if (status !== "applied" && !reason) {
          missingReason.push(`${response.id} (${String(status)})`);
        }
        const entry: PlanRevisionResponse = {
          id: response.id,
          status: status as PlanRevisionStatus,
        };
        if (reason) entry.reason = reason;
        settled.push(entry);
      }
      if (badStatus.length > 0) {
        return textResult(
          `plan_revision_done: invalid status for: ${badStatus.join(", ")}. Use applied, rejected or not_applicable.`,
          undefined,
          true,
        );
      }
      if (missingReason.length > 0) {
        return textResult(
          `plan_revision_done: a concrete reason is required for: ${missingReason.join(", ")}. Say why the note is rejected or does not apply.`,
          undefined,
          true,
        );
      }

      // d. The Reviewer's appendix is not the Planner's to edit.
      const currentPlan = deps.readPlan();
      if (typeof currentPlan !== "string") {
        return textResult(
          "plan_revision_done: the plan file could not be read. Save the revised plan and retry.",
          undefined,
          true,
        );
      }
      const currentAppendix = splitReviewerAppendix(currentPlan).appendix;
      const expectedAppendix = splitReviewerAppendix(deps.expectedAppendix()).appendix;
      if (currentAppendix !== expectedAppendix) {
        return textResult(
          "Do not edit the Reviewer's appendix; restore it and retry.",
          undefined,
          true,
        );
      }

      // e. `applied` has to mean the body actually changed.
      const claimsApplied = settled.some((r) => r.status === "applied");
      if (claimsApplied && deps.planHashBody(currentPlan) === deps.bodyHashAtStart()) {
        return textResult(
          "The plan body did not change; apply the notes or mark them rejected/not applicable with a reason.",
          undefined,
          true,
        );
      }

      // f. Settle once, then report the compact per-status summary.
      deps.settle(settled);
      const counts = { applied: 0, rejected: 0, not_applicable: 0 };
      for (const response of settled) counts[response.status] += 1;
      const summary = clipText(rawParams?.summary, 200);
      const text = [
        `Plan revision recorded — ${counts.applied} applied, ${counts.rejected} rejected, ${counts.not_applicable} not applicable. The Reviewer re-reviews the revised body now.`,
        ...(summary ? [summary] : []),
      ].join("\n");
      return textResult(text, {
        responses: settled,
        counts,
      });
    },
  };
}
