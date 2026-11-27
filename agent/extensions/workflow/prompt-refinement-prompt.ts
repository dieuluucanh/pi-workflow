/**
 * Workflow Extension — prompt-refinement prompt and wire contracts.
 *
 * This module is the single source of truth for *what refinement is asked to
 * do* and *what shape its input/output must have*. It is deliberately pure and
 * provider-neutral: no Pi SDK, no provider SDK, no network, no filesystem, no
 * clock. The same strings/schemas run against any chat model that accepts a
 * system prompt and JSON output.
 *
 * Contracts frozen here (version 1):
 *
 *   - `buildRefinementSystemPrompt()` — the versioned system prompt.
 *   - `pi.workflow.prompt-refinement.input.v1`  — the refinement request.
 *   - `pi.workflow.prompt-refinement.result.v1` — the composition result.
 *   - `PROMPT_REFINEMENT_RUBRIC` — the human/automated quality rubric. It is
 *     versioned and intentionally declared *before* any prompt tuning so the
 *     corpus in `fixtures/prompt-refinement-cases.json` cannot quietly redefine
 *     success.
 *
 * Hard rules encoded below:
 *
 *   - intent and explicit constraints survive the rewrite;
 *   - refinement never executes the request (no tools, commands, edits, plans,
 *     commits or orchestrator work) and never claims it did;
 *   - the original language(s), including mixed-language spans, are retained;
 *   - sections follow the request's purpose (a coding template is not imposed
 *     on prose);
 *   - terminology changes are only made with cited evidence, and deliberately
 *     distinct terms are never merged;
 *   - literals (code, paths, commands, flags, URLs, identifiers) are preserved;
 *   - optional ideas require consent (`suggestionsAllowed`) and stay out of the
 *     candidate prompt;
 *   - output is concise and is exactly one result object.
 *
 * The validators are hand-written rather than TypeBox-based so the prompt
 * module stays usable in a pure Node test without Pi/SDK initialization. They
 * reject unknown fields: a provider that invents extra result fields is
 * refused rather than half-consumed.
 */

import {
  REFINEMENT_LIMITS,
  type RefinementEvidenceKind,
} from "./prompt-refinement-state.ts";

// ── Versions and schema identifiers ──────────────────────────────────

export const PROMPT_REFINEMENT_PROMPT_VERSION = 1 as const;
export const PROMPT_REFINEMENT_INPUT_SCHEMA_VERSION = 1 as const;
export const PROMPT_REFINEMENT_RESULT_SCHEMA_VERSION = 1 as const;

export const REFINEMENT_INPUT_SCHEMA_ID = "pi.workflow.prompt-refinement.input.v1";
export const REFINEMENT_RESULT_SCHEMA_ID = "pi.workflow.prompt-refinement.result.v1";

/** Evidence kinds accepted from the policy-safe inspection layer. */
export const REFINEMENT_EVIDENCE_KINDS = [
  "file",
  "search",
  "context",
  "question",
  "answer",
] as const satisfies readonly RefinementEvidenceKind[];

/** Additional wire bounds that are not part of the control-state record. */
export const REFINEMENT_WIRE_LIMITS = {
  language: 80,
  purpose: 200,
  evidenceId: 200,
  evidencePath: 1_024,
  terminologyChanges: 16,
  terminologyTerm: 200,
  terminologyReason: 400,
  preservedLiterals: 32,
  preservedLiteralLength: 500,
} as const;

// ── Input contract ───────────────────────────────────────────────────

export interface RefinementPromptEvidence {
  evidenceId: string;
  kind: RefinementEvidenceKind;
  path?: string;
  summary: string;
}

export interface RefinementPromptAnswer {
  question: string;
  /** May be empty when the user skipped the question. */
  answer: string;
}

export interface RefinementInput {
  schemaVersion: typeof PROMPT_REFINEMENT_INPUT_SCHEMA_VERSION;
  /** The user's literal prompt text. Never normalised in place. */
  prompt: string;
  /** BCP-47-ish tag or free label; `auto`/absent means detect from `prompt`. */
  language?: string;
  /** Free-form purpose hint ("coding", "writing", "analysis", …). */
  purpose?: string;
  intentPoints?: string[];
  constraints?: string[];
  evidence?: RefinementPromptEvidence[];
  answers?: RefinementPromptAnswer[];
  /**
   * Explicit user consent to receive optional suggestions. Defaults to false:
   * an unasked-for idea must not appear anywhere in the result.
   */
  suggestionsAllowed: boolean;
}

const INPUT_KEYS = new Set([
  "schemaVersion",
  "prompt",
  "language",
  "purpose",
  "intentPoints",
  "constraints",
  "evidence",
  "answers",
  "suggestionsAllowed",
]);

function stringArraySchema(maxItems: number, maxLength: number): Record<string, unknown> {
  return {
    type: "array",
    maxItems,
    items: { type: "string", minLength: 1, maxLength },
  };
}

/** Plain JSON Schema for the request (provider/API neutral). */
export const REFINEMENT_INPUT_JSON_SCHEMA: Record<string, unknown> = {
  $id: REFINEMENT_INPUT_SCHEMA_ID,
  title: "Prompt refinement input (v1)",
  description:
    "A bounded request for one prompt rewrite. The model may inspect only the supplied evidence and must return one result object.",
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "prompt"],
  properties: {
    schemaVersion: { const: PROMPT_REFINEMENT_INPUT_SCHEMA_VERSION },
    prompt: {
      type: "string",
      minLength: 1,
      maxLength: REFINEMENT_LIMITS.originalText,
    },
    language: { type: "string", minLength: 1, maxLength: REFINEMENT_WIRE_LIMITS.language },
    purpose: { type: "string", minLength: 1, maxLength: REFINEMENT_WIRE_LIMITS.purpose },
    intentPoints: stringArraySchema(
      REFINEMENT_LIMITS.intentPoints,
      REFINEMENT_LIMITS.intentPointLength,
    ),
    constraints: stringArraySchema(
      REFINEMENT_LIMITS.constraints,
      REFINEMENT_LIMITS.constraintLength,
    ),
    evidence: {
      type: "array",
      maxItems: REFINEMENT_LIMITS.evidence,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["evidenceId", "kind", "summary"],
        properties: {
          evidenceId: {
            type: "string",
            minLength: 1,
            maxLength: REFINEMENT_WIRE_LIMITS.evidenceId,
          },
          kind: { type: "string", enum: [...REFINEMENT_EVIDENCE_KINDS] },
          path: {
            type: "string",
            minLength: 1,
            maxLength: REFINEMENT_WIRE_LIMITS.evidencePath,
          },
          summary: {
            type: "string",
            minLength: 1,
            maxLength: REFINEMENT_LIMITS.evidenceSummary,
          },
        },
      },
    },
    answers: {
      type: "array",
      maxItems: REFINEMENT_LIMITS.answers,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["question", "answer"],
        properties: {
          question: {
            type: "string",
            minLength: 1,
            maxLength: REFINEMENT_LIMITS.questionPrompt,
          },
          answer: {
            type: "string",
            maxLength: REFINEMENT_LIMITS.answerLength,
          },
        },
      },
    },
    suggestionsAllowed: {
      type: "boolean",
      default: false,
      description:
        "Explicit consent for optional suggestions; absent means false.",
    },
  },
};

// ── Result contract ──────────────────────────────────────────────────

export interface RefinementTerminologyChange {
  from: string;
  to: string;
  /** Evidence that justifies the substitution; required by default. */
  evidenceId?: string;
  reason?: string;
}

export interface RefinementResult {
  schemaVersion: typeof PROMPT_REFINEMENT_RESULT_SCHEMA_VERSION;
  /** The rewritten prompt only — no preamble, explanation or fence. */
  candidate: string;
  /** Short, user-visible summary of material changes. */
  changeSummary: string[];
  /** Optional ideas. Never requirements; empty without consent. */
  suggestions: string[];
  /** Detected language(s) of the candidate, e.g. `en`, `vi`, `vi+en`. */
  language: string;
  /** Terminology substitutions, each backed by an evidence id. */
  terminology?: RefinementTerminologyChange[];
  /** Literals the model asserts it kept byte-identical (audit aid). */
  preservedLiterals?: string[];
}

const RESULT_KEYS = new Set([
  "schemaVersion",
  "candidate",
  "changeSummary",
  "suggestions",
  "language",
  "terminology",
  "preservedLiterals",
]);

/** Plain JSON Schema for the composition result (provider/API neutral). */
export const REFINEMENT_RESULT_JSON_SCHEMA: Record<string, unknown> = {
  $id: REFINEMENT_RESULT_SCHEMA_ID,
  title: "Prompt refinement result (v1)",
  description:
    "Exactly one rewrite result. Skipped questions or an unclear request are not encoded here; the runtime asks before composing.",
  type: "object",
  additionalProperties: false,
  required: [
    "schemaVersion",
    "candidate",
    "changeSummary",
    "suggestions",
    "language",
  ],
  properties: {
    schemaVersion: { const: PROMPT_REFINEMENT_RESULT_SCHEMA_VERSION },
    candidate: {
      type: "string",
      minLength: 1,
      maxLength: REFINEMENT_LIMITS.candidateText,
    },
    changeSummary: stringArraySchema(
      REFINEMENT_LIMITS.changeSummary,
      REFINEMENT_LIMITS.changeSummaryLength,
    ),
    suggestions: stringArraySchema(
      REFINEMENT_LIMITS.suggestions,
      REFINEMENT_LIMITS.suggestionLength,
    ),
    language: {
      type: "string",
      minLength: 1,
      maxLength: REFINEMENT_WIRE_LIMITS.language,
    },
    terminology: {
      type: "array",
      maxItems: REFINEMENT_WIRE_LIMITS.terminologyChanges,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["from", "to"],
        properties: {
          from: {
            type: "string",
            minLength: 1,
            maxLength: REFINEMENT_WIRE_LIMITS.terminologyTerm,
          },
          to: {
            type: "string",
            minLength: 1,
            maxLength: REFINEMENT_WIRE_LIMITS.terminologyTerm,
          },
          evidenceId: {
            type: "string",
            minLength: 1,
            maxLength: REFINEMENT_WIRE_LIMITS.evidenceId,
          },
          reason: {
            type: "string",
            minLength: 1,
            maxLength: REFINEMENT_WIRE_LIMITS.terminologyReason,
          },
        },
      },
    },
    preservedLiterals: {
      type: "array",
      maxItems: REFINEMENT_WIRE_LIMITS.preservedLiterals,
      items: {
        type: "string",
        minLength: 1,
        maxLength: REFINEMENT_WIRE_LIMITS.preservedLiteralLength,
      },
    },
  },
};

// ── Validation helpers ───────────────────────────────────────────────

export interface RefinementSchemaIssue {
  path: string;
  message: string;
}

export type RefinementValidation<T> =
  | { ok: true; value: T }
  | { ok: false; errors: RefinementSchemaIssue[] };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function pushUnknownKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  path: string,
  errors: RefinementSchemaIssue[],
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      errors.push({ path: `${path}.${key}`, message: "unknown field" });
    }
  }
}

function readString(
  value: unknown,
  path: string,
  maxLength: number,
  errors: RefinementSchemaIssue[],
  options: { allowEmpty?: boolean } = {},
): string | undefined {
  if (typeof value !== "string") {
    errors.push({ path, message: "must be a string" });
    return undefined;
  }
  if (value.length > maxLength) {
    errors.push({
      path,
      message: `must be at most ${maxLength} characters (got ${value.length})`,
    });
    return undefined;
  }
  if (options.allowEmpty !== true && value.trim().length === 0) {
    errors.push({ path, message: "must not be empty" });
    return undefined;
  }
  return value;
}

function readStringArray(
  value: unknown,
  path: string,
  maxItems: number,
  maxLength: number,
  errors: RefinementSchemaIssue[],
): string[] | undefined {
  if (!Array.isArray(value)) {
    errors.push({ path, message: "must be an array" });
    return undefined;
  }
  if (value.length > maxItems) {
    errors.push({
      path,
      message: `must contain at most ${maxItems} items (got ${value.length})`,
    });
    return undefined;
  }
  const items: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const item = readString(value[index], `${path}[${index}]`, maxLength, errors);
    if (item !== undefined) items.push(item);
  }
  return items;
}

function readBoolean(
  value: unknown,
  path: string,
  errors: RefinementSchemaIssue[],
): boolean | undefined {
  if (typeof value !== "boolean") {
    errors.push({ path, message: "must be a boolean" });
    return undefined;
  }
  return value;
}

function readEvidenceKind(
  value: unknown,
  path: string,
  errors: RefinementSchemaIssue[],
): RefinementEvidenceKind | undefined {
  if (
    typeof value === "string" &&
    (REFINEMENT_EVIDENCE_KINDS as readonly string[]).includes(value)
  ) {
    return value as RefinementEvidenceKind;
  }
  errors.push({
    path,
    message: `must be one of ${REFINEMENT_EVIDENCE_KINDS.join("|")}`,
  });
  return undefined;
}

// ── Input validation ─────────────────────────────────────────────────

/**
 * Validate one untrusted refinement request.
 *
 * Unknown fields are refused (they usually mean a version mismatch or a caller
 * inventing metadata this contract does not own). `suggestionsAllowed` is
 * normalised to `false` when absent.
 */
export function validateRefinementInput(
  raw: unknown,
): RefinementValidation<RefinementInput> {
  const errors: RefinementSchemaIssue[] = [];
  if (!isPlainObject(raw)) {
    return { ok: false, errors: [{ path: "$", message: "must be an object" }] };
  }
  pushUnknownKeys(raw, INPUT_KEYS, "$", errors);

  if (raw.schemaVersion !== PROMPT_REFINEMENT_INPUT_SCHEMA_VERSION) {
    errors.push({
      path: "$.schemaVersion",
      message: `must equal ${PROMPT_REFINEMENT_INPUT_SCHEMA_VERSION}`,
    });
  }

  const prompt = readString(
    raw.prompt,
    "$.prompt",
    REFINEMENT_LIMITS.originalText,
    errors,
  );

  let language: string | undefined;
  if (raw.language !== undefined) {
    language = readString(
      raw.language,
      "$.language",
      REFINEMENT_WIRE_LIMITS.language,
      errors,
    );
  }
  let purpose: string | undefined;
  if (raw.purpose !== undefined) {
    purpose = readString(
      raw.purpose,
      "$.purpose",
      REFINEMENT_WIRE_LIMITS.purpose,
      errors,
    );
  }

  const intentPoints =
    raw.intentPoints === undefined
      ? undefined
      : readStringArray(
          raw.intentPoints,
          "$.intentPoints",
          REFINEMENT_LIMITS.intentPoints,
          REFINEMENT_LIMITS.intentPointLength,
          errors,
        );
  const constraints =
    raw.constraints === undefined
      ? undefined
      : readStringArray(
          raw.constraints,
          "$.constraints",
          REFINEMENT_LIMITS.constraints,
          REFINEMENT_LIMITS.constraintLength,
          errors,
        );

  let evidence: RefinementPromptEvidence[] | undefined;
  if (raw.evidence !== undefined) {
    if (!Array.isArray(raw.evidence)) {
      errors.push({ path: "$.evidence", message: "must be an array" });
    } else if (raw.evidence.length > REFINEMENT_LIMITS.evidence) {
      errors.push({
        path: "$.evidence",
        message: `must contain at most ${REFINEMENT_LIMITS.evidence} items`,
      });
    } else {
      evidence = [];
      const seen = new Set<string>();
      for (let index = 0; index < raw.evidence.length; index += 1) {
        const path = `$.evidence[${index}]`;
        const item = raw.evidence[index];
        if (!isPlainObject(item)) {
          errors.push({ path, message: "must be an object" });
          continue;
        }
        pushUnknownKeys(
          item,
          new Set(["evidenceId", "kind", "path", "summary"]),
          path,
          errors,
        );
        const evidenceId = readString(
          item.evidenceId,
          `${path}.evidenceId`,
          REFINEMENT_WIRE_LIMITS.evidenceId,
          errors,
        );
        const kind = readEvidenceKind(item.kind, `${path}.kind`, errors);
        const itemPath =
          item.path === undefined
            ? undefined
            : readString(
                item.path,
                `${path}.path`,
                REFINEMENT_WIRE_LIMITS.evidencePath,
                errors,
              );
        const summary = readString(
          item.summary,
          `${path}.summary`,
          REFINEMENT_LIMITS.evidenceSummary,
          errors,
        );
        if (evidenceId !== undefined) {
          if (seen.has(evidenceId)) {
            errors.push({
              path: `${path}.evidenceId`,
              message: "duplicate evidence id",
            });
          }
          seen.add(evidenceId);
        }
        if (evidenceId !== undefined && kind !== undefined && summary !== undefined) {
          evidence.push({
            evidenceId,
            kind,
            ...(itemPath !== undefined ? { path: itemPath } : {}),
            summary,
          });
        }
      }
    }
  }

  let answers: RefinementPromptAnswer[] | undefined;
  if (raw.answers !== undefined) {
    if (!Array.isArray(raw.answers)) {
      errors.push({ path: "$.answers", message: "must be an array" });
    } else if (raw.answers.length > REFINEMENT_LIMITS.answers) {
      errors.push({
        path: "$.answers",
        message: `must contain at most ${REFINEMENT_LIMITS.answers} items`,
      });
    } else {
      answers = [];
      for (let index = 0; index < raw.answers.length; index += 1) {
        const path = `$.answers[${index}]`;
        const item = raw.answers[index];
        if (!isPlainObject(item)) {
          errors.push({ path, message: "must be an object" });
          continue;
        }
        pushUnknownKeys(item, new Set(["question", "answer"]), path, errors);
        const question = readString(
          item.question,
          `${path}.question`,
          REFINEMENT_LIMITS.questionPrompt,
          errors,
        );
        const answer = readString(
          item.answer,
          `${path}.answer`,
          REFINEMENT_LIMITS.answerLength,
          errors,
          { allowEmpty: true },
        );
        if (question !== undefined && answer !== undefined) {
          answers.push({ question, answer });
        }
      }
    }
  }

  let suggestionsAllowed = false;
  if (raw.suggestionsAllowed !== undefined) {
    const allowed = readBoolean(
      raw.suggestionsAllowed,
      "$.suggestionsAllowed",
      errors,
    );
    if (allowed !== undefined) suggestionsAllowed = allowed;
  }

  if (errors.length > 0 || prompt === undefined) {
    return { ok: false, errors };
  }

  const value: RefinementInput = {
    schemaVersion: PROMPT_REFINEMENT_INPUT_SCHEMA_VERSION,
    prompt,
    suggestionsAllowed,
  };
  if (language !== undefined) value.language = language;
  if (purpose !== undefined) value.purpose = purpose;
  if (intentPoints !== undefined) value.intentPoints = intentPoints;
  if (constraints !== undefined) value.constraints = constraints;
  if (evidence !== undefined) value.evidence = evidence;
  if (answers !== undefined) value.answers = answers;
  return { ok: true, value };
}

// ── Result validation ────────────────────────────────────────────────

export interface ValidateRefinementResultOptions {
  /** Must match the consent recorded on the request. Defaults to false. */
  suggestionsAllowed?: boolean;
  /** Known evidence ids; when supplied, terminology must reference them. */
  evidenceIds?: ReadonlySet<string>;
  /** Require an `evidenceId` for every terminology change. Defaults to true. */
  requireTerminologyEvidence?: boolean;
  maxCandidateChars?: number;
}

/**
 * Validate one untrusted composition result.
 *
 * A result is only ready for the composer when this returns `ok`. In
 * particular:
 *   - an empty/truncated/whitespace candidate is refused;
 *   - suggestions without consent are refused;
 *   - a terminology substitution without evidence is refused;
 *   - unknown fields are refused.
 */
export function validateRefinementResult(
  raw: unknown,
  options: ValidateRefinementResultOptions = {},
): RefinementValidation<RefinementResult> {
  const errors: RefinementSchemaIssue[] = [];
  if (!isPlainObject(raw)) {
    return { ok: false, errors: [{ path: "$", message: "must be an object" }] };
  }
  pushUnknownKeys(raw, RESULT_KEYS, "$", errors);

  if (raw.schemaVersion !== PROMPT_REFINEMENT_RESULT_SCHEMA_VERSION) {
    errors.push({
      path: "$.schemaVersion",
      message: `must equal ${PROMPT_REFINEMENT_RESULT_SCHEMA_VERSION}`,
    });
  }

  const maxCandidate =
    options.maxCandidateChars ?? REFINEMENT_LIMITS.candidateText;
  const candidate = readString(raw.candidate, "$.candidate", maxCandidate, errors);
  const language = readString(
    raw.language,
    "$.language",
    REFINEMENT_WIRE_LIMITS.language,
    errors,
  );

  const changeSummary = readStringArray(
    raw.changeSummary,
    "$.changeSummary",
    REFINEMENT_LIMITS.changeSummary,
    REFINEMENT_LIMITS.changeSummaryLength,
    errors,
  );
  if (changeSummary !== undefined && changeSummary.length === 0) {
    errors.push({
      path: "$.changeSummary",
      message: "must describe at least one change",
    });
  }

  const suggestions = readStringArray(
    raw.suggestions,
    "$.suggestions",
    REFINEMENT_LIMITS.suggestions,
    REFINEMENT_LIMITS.suggestionLength,
    errors,
  );
  const suggestionsAllowed = options.suggestionsAllowed === true;
  if (
    suggestionsAllowed === false &&
    suggestions !== undefined &&
    suggestions.length > 0
  ) {
    errors.push({
      path: "$.suggestions",
      message: "suggestions require explicit user consent (suggestionsAllowed)",
    });
  }

  let terminology: RefinementTerminologyChange[] | undefined;
  if (raw.terminology !== undefined) {
    if (!Array.isArray(raw.terminology)) {
      errors.push({ path: "$.terminology", message: "must be an array" });
    } else if (
      raw.terminology.length > REFINEMENT_WIRE_LIMITS.terminologyChanges
    ) {
      errors.push({
        path: "$.terminology",
        message: `must contain at most ${REFINEMENT_WIRE_LIMITS.terminologyChanges} items`,
      });
    } else {
      terminology = [];
      const requireEvidence = options.requireTerminologyEvidence !== false;
      for (let index = 0; index < raw.terminology.length; index += 1) {
        const path = `$.terminology[${index}]`;
        const item = raw.terminology[index];
        if (!isPlainObject(item)) {
          errors.push({ path, message: "must be an object" });
          continue;
        }
        pushUnknownKeys(item, new Set(["from", "to", "evidenceId", "reason"]), path, errors);
        const from = readString(
          item.from,
          `${path}.from`,
          REFINEMENT_WIRE_LIMITS.terminologyTerm,
          errors,
        );
        const to = readString(
          item.to,
          `${path}.to`,
          REFINEMENT_WIRE_LIMITS.terminologyTerm,
          errors,
        );
        const evidenceId =
          item.evidenceId === undefined
            ? undefined
            : readString(
                item.evidenceId,
                `${path}.evidenceId`,
                REFINEMENT_WIRE_LIMITS.evidenceId,
                errors,
              );
        const reason =
          item.reason === undefined
            ? undefined
            : readString(
                item.reason,
                `${path}.reason`,
                REFINEMENT_WIRE_LIMITS.terminologyReason,
                errors,
              );

        if (from !== undefined && to !== undefined && from === to) {
          errors.push({
            path: `${path}.to`,
            message: "must differ from the original term",
          });
        }
        if (requireEvidence && evidenceId === undefined) {
          errors.push({
            path: `${path}.evidenceId`,
            message: "a terminology substitution needs cited evidence",
          });
        }
        if (
          evidenceId !== undefined &&
          options.evidenceIds !== undefined &&
          !options.evidenceIds.has(evidenceId)
        ) {
          errors.push({
            path: `${path}.evidenceId`,
            message: "does not reference supplied evidence",
          });
        }
        if (from !== undefined && to !== undefined) {
          terminology.push({
            from,
            to,
            ...(evidenceId !== undefined ? { evidenceId } : {}),
            ...(reason !== undefined ? { reason } : {}),
          });
        }
      }
    }
  }

  let preservedLiterals: string[] | undefined;
  if (raw.preservedLiterals !== undefined) {
    preservedLiterals = readStringArray(
      raw.preservedLiterals,
      "$.preservedLiterals",
      REFINEMENT_WIRE_LIMITS.preservedLiterals,
      REFINEMENT_WIRE_LIMITS.preservedLiteralLength,
      errors,
    );
  }

  if (
    errors.length > 0 ||
    candidate === undefined ||
    language === undefined ||
    changeSummary === undefined ||
    suggestions === undefined
  ) {
    return { ok: false, errors };
  }

  const value: RefinementResult = {
    schemaVersion: PROMPT_REFINEMENT_RESULT_SCHEMA_VERSION,
    candidate,
    changeSummary,
    suggestions,
    language,
  };
  if (terminology !== undefined) value.terminology = terminology;
  if (preservedLiterals !== undefined) value.preservedLiterals = preservedLiterals;
  return { ok: true, value };
}

/**
 * Remove one transport-level Markdown fence around an otherwise complete JSON
 * result. It never strips fences from inside the candidate: only a wrapper
 * that spans the whole text is removed.
 */
export function stripRefinementResultWrapper(text: string): string {
  const trimmed = text.replace(/^\uFEFF/, "").trim();
  const match = /^```(?:json|jsonc)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/.exec(trimmed);
  return match ? match[1]!.trim() : trimmed;
}

/** Parse + validate one provider response. Never throws. */
export function parseRefinementResultText(
  text: unknown,
  options: ValidateRefinementResultOptions = {},
): RefinementValidation<RefinementResult> {
  if (typeof text !== "string" || text.trim().length === 0) {
    return {
      ok: false,
      errors: [{ path: "$", message: "result text must be a non-empty string" }],
    };
  }
  const unwrapped = stripRefinementResultWrapper(text);
  let parsed: unknown;
  try {
    parsed = JSON.parse(unwrapped);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      errors: [{ path: "$", message: `result is not valid JSON: ${message}` }],
    };
  }
  return validateRefinementResult(parsed, options);
}

// ── System prompt ────────────────────────────────────────────────────

/**
 * Stable requirement ids. The prompt must state each `phrase`; tests assert it
 * so a future edit cannot silently drop a non-negotiable rule.
 */
export interface RefinementPromptRequirement {
  id: string;
  phrase: string;
  description: string;
}

export const REFINEMENT_PROMPT_REQUIREMENTS: readonly RefinementPromptRequirement[] =
  [
    {
      id: "intent-preservation",
      phrase: "Preserve the user's intent",
      description: "Goal, tasks and scope stay equivalent.",
    },
    {
      id: "non-execution",
      phrase: "Never execute the request",
      description: "No commands, edits, plans, commits or claimed work.",
    },
    {
      id: "language-retention",
      phrase: "Keep the original language",
      description: "Including mixed-language spans; no unrequested translation.",
    },
    {
      id: "purpose-driven-structure",
      phrase: "Match the structure to the purpose",
      description: "Sections only where they help the actual request.",
    },
    {
      id: "evidence-backed-terminology",
      phrase: "Cite an evidenceId for every terminology substitution",
      description: "No invented repository facts or terms.",
    },
    {
      id: "literal-preservation",
      phrase: "byte-for-byte",
      description: "Code, paths, commands, flags, URLs and identifiers.",
    },
    {
      id: "consented-suggestions",
      phrase: "Only when suggestionsAllowed is true",
      description: "Optional ideas are separate and never requirements.",
    },
    {
      id: "concise-output",
      phrase: "Do not pad",
      description: "Minimal enrichment; no restating the original.",
    },
    {
      id: "distinct-terms",
      phrase: "Do not merge distinct terms",
      description: "Deliberately different names stay different.",
    },
    {
      id: "typo-discipline",
      phrase: "Correct only unambiguous typos",
      description: "Never rewrite identifiers that merely look misspelled.",
    },
  ];

export const REFINEMENT_PROMPT_SECTIONS = [
  "role",
  "non-execution",
  "invariants",
  "language",
  "literals",
  "terminology",
  "structure",
  "suggestions",
  "output",
  "clarification",
  "quality",
] as const;

/**
 * The versioned, provider-neutral system prompt.
 *
 * Plain Markdown: no vendor-specific tags, tool syntax or special tokens. The
 * caller supplies the request as the `input.v1` object; this text is the only
 * system prompt refinement needs.
 */
export function buildRefinementSystemPrompt(): string {
  return [
    `# Prompt refinement — system prompt (v${PROMPT_REFINEMENT_PROMPT_VERSION})`,
    "",
    `Input schema: \`${REFINEMENT_INPUT_SCHEMA_ID}\`.`,
    `Output schema: \`${REFINEMENT_RESULT_SCHEMA_ID}\`.`,
    "",
    "## Role",
    "",
    "You rewrite a user's prompt so it is clearer, more complete and more accurate",
    "without changing what the user is asking for. You are an editor, not an",
    "assistant answering the prompt: you never perform the task it describes.",
    "",
    "## Never execute the request",
    "",
    "Never execute the request. Do not run commands, edit files, create plans or",
    "TODOs, commit, approve handoffs, start subagents or Orchestrator work, or",
    "pretend any of that happened. You do not have authority to do it. The",
    "candidate is text for the user to review and later send themselves; do not",
    "claim that it was sent.",
    "",
    "## Invariants",
    "",
    "Preserve the user's intent: the goal, requested tasks, scope, ordering and",
    "success criteria must mean the same after the rewrite. Do not add new work,",
    "new deliverables or a broader scope. Preserve explicit constraints,",
    "non-goals, exclusions, warnings and formatting requirements; never",
    "contradict one. If the supplied `intentPoints` or `constraints` are present,",
    "treat them as authoritative.",
    "",
    "Correct only unambiguous typos and grammar slips. Do not 'fix' identifiers,",
    "API names, flags or quoted text that merely look misspelled; they are",
    "literals. If a token could plausibly be a real name, leave it unchanged.",
    "",
    "## Language",
    "",
    "Keep the original language and register. If the prompt is Vietnamese, answer",
    "in Vietnamese; if it mixes languages, preserve each span in its original",
    "language and do not translate technical terms, identifiers or quoted",
    "material. Do not switch to English just because these instructions are in",
    "English. Report the candidate's language in `language` (for example `en`,",
    "`vi`, or `vi+en` for a deliberate mix).",
    "",
    "## Literals",
    "",
    "Preserve code, inline code, fenced blocks, file paths, URLs, shell commands,",
    "flags, environment variables, version numbers, placeholders, file mentions",
    "and quoted commands byte-for-byte. Copy them exactly; do not reflow, add",
    "trailing spaces, translate, normalise quotes or 'improve' them. If a literal",
    "is genuinely wrong, keep it and mention the suspicion in `changeSummary` or",
    "ask; do not silently change it.",
    "",
    "## Terminology and evidence",
    "",
    "Cite an evidenceId for every terminology substitution. Only use a project",
    "term that the supplied evidence actually shows, and explain it in",
    "`terminology` with `from`, `to`, `evidenceId` and a short `reason`. Never",
    "invent a repository fact, file, symbol, command or project convention.",
    "Do not merge distinct terms: if the prompt or evidence treats `session`,",
    "`child session` and `subagent` as different things, keep all three and keep",
    "their differences. When no evidence supports a term, keep the user's word.",
    "",
    "## Structure by purpose",
    "",
    "Match the structure to the purpose. For a coding request, a compact",
    "goal/constraints/acceptance shape usually helps. For writing, analysis,",
    "operations or personal requests, use the sections that purpose needs (for",
    "example audience/tone, question/criteria, or preconditions/verification).",
    "Do not impose a coding template, headings or checklists on a noncoding",
    "request, and do not add boilerplate sections that carry no information.",
    "",
    "## Suggestions",
    "",
    "Only when suggestionsAllowed is true, you may add a few optional ideas in",
    "`suggestions`. They are not requirements, must not be folded into",
    "`candidate`, and must not be presented as facts. When suggestionsAllowed is",
    "false, return an empty `suggestions` array. Never ask for consent yourself;",
    "the runtime records the user's choice.",
    "",
    "## Output",
    "",
    `Return exactly one JSON object matching \`${REFINEMENT_RESULT_SCHEMA_ID}\``,
    `with \`schemaVersion: ${PROMPT_REFINEMENT_RESULT_SCHEMA_VERSION}\` and no text`,
    "outside it (no preamble, analysis, apology or Markdown fence):",
    "",
    "- `candidate` — the rewritten prompt only.",
    "- `changeSummary` — 1–5 short, concrete lines naming material changes.",
    "- `suggestions` — optional ideas, or `[]` without consent.",
    "- `language` — the candidate's language tag.",
    "- `terminology` — omitted or a list of evidence-backed substitutions.",
    "- `preservedLiterals` — optional list of literals you kept unchanged.",
    "",
    "Do not add fields. Keep `candidate` under the schema limit.",
    "",
    "## Clarification",
    "",
    "If a missing fact would materially change the rewrite, ask one focused",
    "question through the provided question mechanism and stop; do not guess,",
    "invent scope or pad the prompt. If no question mechanism is available, take",
    "the most literal, intent-preserving interpretation and state the assumption",
    "in `changeSummary`. If the prompt is already clear and complete, return it",
    "essentially unchanged with a one-line summary rather than adding filler.",
    "",
    "## Quality bar",
    "",
    "Do not pad. Prefer the smallest edit that makes the prompt clearer; keep",
    "every original requirement and remove nothing the user asked for. The",
    "candidate must be ready to send as-is, in the user's voice, without this",
    "system prompt's commentary.",
  ].join("\n");
}

// ── Quality rubric (declared before tuning) ──────────────────────────

export const PROMPT_REFINEMENT_RUBRIC_VERSION = 1 as const;

export const RUBRIC_SCORE_SCALE = {
  min: 0,
  max: 4,
  labels: {
    0: "missing or contradicted",
    1: "material regression",
    2: "partially satisfied",
    3: "satisfied with a minor gap",
    4: "fully satisfied",
  },
} as const;

/** Weighted score (0–100) required to consider a candidate acceptable. */
export const RUBRIC_PASS_SCORE = 80;

export interface RefinementRubricDimension {
  id: string;
  title: string;
  /** Relative weight; all dimensions sum to 100. */
  weight: number;
  /** Critical dimensions must also reach `minScore` individually. */
  critical: boolean;
  minScore: number;
  description: string;
  criteria: string[];
}

export const REFINEMENT_RUBRIC_DIMENSIONS: readonly RefinementRubricDimension[] =
  [
    {
      id: "intent_preservation",
      title: "Intent preservation",
      weight: 20,
      critical: true,
      minScore: 3,
      description:
        "The goal, requested work, scope and success criteria mean the same after refinement.",
      criteria: [
        "No new task, deliverable or scope was added.",
        "Nothing the user asked for was removed or weakened.",
        "Ambiguity was resolved by a question, not by an invented requirement.",
      ],
    },
    {
      id: "constraint_preservation",
      title: "Constraint preservation",
      weight: 15,
      critical: true,
      minScore: 3,
      description:
        "Explicit constraints, non-goals, exclusions, ordering and formatting requirements survive.",
      criteria: [
        "Every stated constraint still appears and still applies.",
        "No added requirement contradicts an original constraint.",
        "Warnings and exclusions were not softened into suggestions.",
      ],
    },
    {
      id: "language_retention",
      title: "Language retention",
      weight: 12,
      critical: true,
      minScore: 3,
      description:
        "The candidate keeps the original language(s) and register, including deliberate mixing.",
      criteria: [
        "A monolingual prompt stays in that language.",
        "Mixed-language spans stay mixed in the same places.",
        "Technical terms are not translated for no reason.",
      ],
    },
    {
      id: "literal_preservation",
      title: "Literal preservation",
      weight: 15,
      critical: true,
      minScore: 4,
      description:
        "Code, paths, commands, flags, URLs, versions, identifiers and quoted material are byte-identical.",
      criteria: [
        "No literal was reflowed, retyped or normalised.",
        "Quoted commands and flags are exact.",
        "Placeholders and file mentions are untouched.",
      ],
    },
    {
      id: "evidence_backed_terminology",
      title: "Evidence-backed terminology",
      weight: 10,
      critical: true,
      minScore: 3,
      description:
        "Substitutions cite supplied evidence; distinct terms stay distinct; no repository facts are invented.",
      criteria: [
        "Each `terminology` entry has a real `evidenceId` and reason.",
        "No file, symbol, command or convention is invented.",
        "Deliberately distinct terms are not merged or renamed.",
      ],
    },
    {
      id: "structure_by_purpose",
      title: "Purpose-driven structure",
      weight: 8,
      critical: false,
      minScore: 2,
      description:
        "Sections and formatting fit the request's purpose instead of a fixed coding template.",
      criteria: [
        "A noncoding request gets an appropriate shape, not coding boilerplate.",
        "Headings/checklists carry information rather than ceremony.",
        "Ordering follows the user's workflow.",
      ],
    },
    {
      id: "suggestion_consent",
      title: "Suggestion consent",
      weight: 5,
      critical: true,
      minScore: 4,
      description:
        "Optional ideas appear only with consent, stay separate, and never become requirements.",
      criteria: [
        "`suggestions` is empty when consent is absent.",
        "Ideas are not folded into `candidate`.",
        "Suggestions are not phrased as facts or mandatory work.",
      ],
    },
    {
      id: "non_execution",
      title: "Non-execution",
      weight: 10,
      critical: true,
      minScore: 4,
      description:
        "The result is prompt text only: no execution and no claim that work happened.",
      criteria: [
        "No command, edit, plan, commit, handoff or dispatch is described as done.",
        "The candidate does not tell a future agent to skip approval.",
        "No claim that the prompt was sent or the task completed.",
      ],
    },
    {
      id: "conciseness",
      title: "Conciseness",
      weight: 5,
      critical: false,
      minScore: 2,
      description:
        "The rewrite is the smallest clear improvement, with a short change summary.",
      criteria: [
        "No filler, restatement or duplicated instructions.",
        "`changeSummary` is brief and concrete.",
        "Added structure earns its space.",
      ],
    },
  ];

export type RefinementRubricDimensionId =
  (typeof REFINEMENT_RUBRIC_DIMENSIONS)[number]["id"];

export const REFINEMENT_RUBRIC_DIMENSION_IDS: readonly string[] =
  REFINEMENT_RUBRIC_DIMENSIONS.map((dimension) => dimension.id);

export interface RefinementRubricResult {
  pass: boolean;
  /** Weighted score on a 0–100 scale. */
  score: number;
  issues: string[];
}

/**
 * Apply the rubric to integer scores (0–4) keyed by dimension id.
 *
 * Missing, unknown or out-of-range scores are issues rather than silent zeroes,
 * so an evaluation harness cannot accidentally report a pass. Critical
 * dimensions must meet their minimum in addition to the weighted threshold.
 */
export function evaluateRefinementRubric(
  scores: Record<string, number>,
): RefinementRubricResult {
  const issues: string[] = [];
  const known = new Set(REFINEMENT_RUBRIC_DIMENSION_IDS);
  for (const key of Object.keys(scores)) {
    if (!known.has(key)) issues.push(`unknown rubric dimension "${key}"`);
  }

  let weighted = 0;
  for (const dimension of REFINEMENT_RUBRIC_DIMENSIONS) {
    const score = scores[dimension.id];
    if (
      typeof score !== "number" ||
      !Number.isInteger(score) ||
      score < RUBRIC_SCORE_SCALE.min ||
      score > RUBRIC_SCORE_SCALE.max
    ) {
      issues.push(
        `missing or invalid score for "${dimension.id}" (expected an integer ${RUBRIC_SCORE_SCALE.min}–${RUBRIC_SCORE_SCALE.max})`,
      );
      continue;
    }
    weighted += dimension.weight * (score / RUBRIC_SCORE_SCALE.max);
    if (dimension.critical && score < dimension.minScore) {
      issues.push(
        `critical dimension "${dimension.id}" scored ${score}; needs at least ${dimension.minScore}`,
      );
    }
  }

  const score = Math.round(weighted * 10) / 10;
  if (score < RUBRIC_PASS_SCORE) {
    issues.push(`weighted score ${score} is below the ${RUBRIC_PASS_SCORE} pass mark`);
  }
  return { pass: issues.length === 0, score, issues };
}

// ── Evaluation-case contract ─────────────────────────────────────────

export const REFINEMENT_CASE_CATEGORIES = [
  "typo-heavy",
  "terminology-evidence",
  "distinct-terms",
  "multilingual",
  "mixed-language",
  "quoted-commands",
  "noncoding",
  "sparse",
  "no-repo",
  "ambiguous-terminology",
  "prompt-injection",
  "vision",
  "vision-unsupported",
  "long-context",
] as const;

export type RefinementCaseCategory =
  (typeof REFINEMENT_CASE_CATEGORIES)[number];

export interface RefinementCaseExpectations {
  /** Exact tokens that must survive into a candidate. */
  mustPreserve?: string[];
  /** Terms/phrases that must not appear in a candidate. */
  mustNotContain?: string[];
  /** Claims that would prove execution or invented work. */
  mustNotClaim?: string[];
  /** Expected language tag/label (e.g. `vi`, `vi+en`). */
  preserveLanguage?: string;
  expectedTerminology?: Array<{
    from: string;
    to: string;
    evidenceId: string;
  }>;
  /** Terms the case deliberately treats as distinct. */
  mustPreserveDistinctTerms?: string[];
  /** True when the correct first move is a focused question, not a rewrite. */
  expectsClarification?: boolean;
  /** Per-dimension minimum overrides; may not lower a critical minimum. */
  rubricMinimums?: Record<string, number>;
}

export interface RefinementEvaluationCase {
  id: string;
  category: RefinementCaseCategory;
  title: string;
  input: RefinementInput;
  expectations: RefinementCaseExpectations;
  humanReview?: string;
}

const CASE_KEYS = new Set([
  "id",
  "category",
  "title",
  "input",
  "expectations",
  "humanReview",
]);

/**
 * Validate one corpus case. The input must satisfy `input.v1`; expected
 * terminology must reference evidence actually present in that input.
 */
export function validateRefinementEvaluationCase(
  raw: unknown,
): RefinementValidation<RefinementEvaluationCase> {
  const errors: RefinementSchemaIssue[] = [];
  if (!isPlainObject(raw)) {
    return { ok: false, errors: [{ path: "$", message: "must be an object" }] };
  }
  pushUnknownKeys(raw, CASE_KEYS, "$", errors);

  const id = readString(raw.id, "$.id", 80, errors);
  if (id !== undefined && !/^[a-z0-9][a-z0-9-]*$/.test(id)) {
    errors.push({
      path: "$.id",
      message: "must be lowercase letters, digits and dashes",
    });
  }
  let category: RefinementCaseCategory | undefined;
  if (
    typeof raw.category === "string" &&
    (REFINEMENT_CASE_CATEGORIES as readonly string[]).includes(raw.category)
  ) {
    category = raw.category as RefinementCaseCategory;
  } else {
    errors.push({
      path: "$.category",
      message: `must be one of ${REFINEMENT_CASE_CATEGORIES.join("|")}`,
    });
  }
  const title = readString(raw.title, "$.title", 200, errors);

  const inputResult = validateRefinementInput(raw.input);
  if (!inputResult.ok) {
    for (const issue of inputResult.errors) {
      errors.push({ path: `$.input${issue.path.slice(1)}`, message: issue.message });
    }
  }

  const expectationsRaw = raw.expectations;
  let expectations: RefinementCaseExpectations | undefined;
  if (!isPlainObject(expectationsRaw)) {
    errors.push({ path: "$.expectations", message: "must be an object" });
  } else {
    pushUnknownKeys(
      expectationsRaw,
      new Set([
        "mustPreserve",
        "mustNotContain",
        "mustNotClaim",
        "preserveLanguage",
        "expectedTerminology",
        "mustPreserveDistinctTerms",
        "expectsClarification",
        "rubricMinimums",
      ]),
      "$.expectations",
      errors,
    );
    expectations = {};
    const arrayField = (
      key: "mustPreserve" | "mustNotContain" | "mustNotClaim" | "mustPreserveDistinctTerms",
      maxLength: number,
    ): string[] | undefined =>
      expectationsRaw[key] === undefined
        ? undefined
        : readStringArray(
            expectationsRaw[key],
            `$.expectations.${key}`,
            64,
            maxLength,
            errors,
          );
    const mustPreserve = arrayField("mustPreserve", 1_000);
    const mustNotContain = arrayField("mustNotContain", 1_000);
    const mustNotClaim = arrayField("mustNotClaim", 1_000);
    const distinct = arrayField("mustPreserveDistinctTerms", 200);
    if (mustPreserve !== undefined) expectations.mustPreserve = mustPreserve;
    if (mustNotContain !== undefined) {
      expectations.mustNotContain = mustNotContain;
    }
    if (mustNotClaim !== undefined) expectations.mustNotClaim = mustNotClaim;
    if (distinct !== undefined) expectations.mustPreserveDistinctTerms = distinct;

    if (expectationsRaw.preserveLanguage !== undefined) {
      const preserveLanguage = readString(
        expectationsRaw.preserveLanguage,
        "$.expectations.preserveLanguage",
        REFINEMENT_WIRE_LIMITS.language,
        errors,
      );
      if (preserveLanguage !== undefined) {
        expectations.preserveLanguage = preserveLanguage;
      }
    }

    const inputEvidenceIds = new Set(
      (inputResult.ok ? (inputResult.value.evidence ?? []) : []).map(
        (item) => item.evidenceId,
      ),
    );
    if (expectationsRaw.expectedTerminology !== undefined) {
      if (!Array.isArray(expectationsRaw.expectedTerminology)) {
        errors.push({
          path: "$.expectations.expectedTerminology",
          message: "must be an array",
        });
      } else if (
        expectationsRaw.expectedTerminology.length >
        REFINEMENT_WIRE_LIMITS.terminologyChanges
      ) {
        errors.push({
          path: "$.expectations.expectedTerminology",
          message: `must contain at most ${REFINEMENT_WIRE_LIMITS.terminologyChanges} items`,
        });
      } else {
        const expected: NonNullable<
          RefinementCaseExpectations["expectedTerminology"]
        > = [];
        for (
          let index = 0;
          index < expectationsRaw.expectedTerminology.length;
          index += 1
        ) {
          const path = `$.expectations.expectedTerminology[${index}]`;
          const item = expectationsRaw.expectedTerminology[index];
          if (!isPlainObject(item)) {
            errors.push({ path, message: "must be an object" });
            continue;
          }
          pushUnknownKeys(item, new Set(["from", "to", "evidenceId"]), path, errors);
          const from = readString(
            item.from,
            `${path}.from`,
            REFINEMENT_WIRE_LIMITS.terminologyTerm,
            errors,
          );
          const to = readString(
            item.to,
            `${path}.to`,
            REFINEMENT_WIRE_LIMITS.terminologyTerm,
            errors,
          );
          const evidenceId = readString(
            item.evidenceId,
            `${path}.evidenceId`,
            REFINEMENT_WIRE_LIMITS.evidenceId,
            errors,
          );
          if (
            evidenceId !== undefined &&
            !inputEvidenceIds.has(evidenceId)
          ) {
            errors.push({
              path: `${path}.evidenceId`,
              message: "does not match evidence in this case's input",
            });
          }
          if (from !== undefined && to !== undefined && evidenceId !== undefined) {
            expected.push({ from, to, evidenceId });
          }
        }
        expectations.expectedTerminology = expected;
      }
    }

    if (expectationsRaw.expectsClarification !== undefined) {
      const expects = readBoolean(
        expectationsRaw.expectsClarification,
        "$.expectations.expectsClarification",
        errors,
      );
      if (expects !== undefined) expectations.expectsClarification = expects;
    }

    if (expectationsRaw.rubricMinimums !== undefined) {
      if (!isPlainObject(expectationsRaw.rubricMinimums)) {
        errors.push({
          path: "$.expectations.rubricMinimums",
          message: "must be an object",
        });
      } else {
        const byId = new Map(
          REFINEMENT_RUBRIC_DIMENSIONS.map((dimension) => [
            dimension.id,
            dimension,
          ]),
        );
        const minimums: Record<string, number> = {};
        for (const [key, value] of Object.entries(
          expectationsRaw.rubricMinimums,
        )) {
          const dimension = byId.get(key);
          if (!dimension) {
            errors.push({
              path: `$.expectations.rubricMinimums.${key}`,
              message: "unknown rubric dimension",
            });
            continue;
          }
          if (
            typeof value !== "number" ||
            !Number.isInteger(value) ||
            value < RUBRIC_SCORE_SCALE.min ||
            value > RUBRIC_SCORE_SCALE.max
          ) {
            errors.push({
              path: `$.expectations.rubricMinimums.${key}`,
              message: `must be an integer ${RUBRIC_SCORE_SCALE.min}–${RUBRIC_SCORE_SCALE.max}`,
            });
            continue;
          }
          if (dimension.critical && value < dimension.minScore) {
            errors.push({
              path: `$.expectations.rubricMinimums.${key}`,
              message: `may not lower the critical minimum of ${dimension.minScore}`,
            });
            continue;
          }
          minimums[key] = value;
        }
        expectations.rubricMinimums = minimums;
      }
    }
  }

  let humanReview: string | undefined;
  if (raw.humanReview !== undefined) {
    humanReview = readString(raw.humanReview, "$.humanReview", 1_000, errors);
  }

  if (
    errors.length > 0 ||
    id === undefined ||
    category === undefined ||
    title === undefined ||
    !inputResult.ok ||
    expectations === undefined
  ) {
    return { ok: false, errors };
  }
  return {
    ok: true,
    value: {
      id,
      category,
      title,
      input: inputResult.value,
      expectations,
      ...(humanReview !== undefined ? { humanReview } : {}),
    },
  };
}
