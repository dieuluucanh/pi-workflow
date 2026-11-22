/**
 * Workflow Extension — plan-or-discussion work source (plan step 5).
 *
 * Orchestrator work can start from an approved/plan file OR from the current
 * discussion. The roadmap parser deliberately requires an absolute path and a
 * `## Plan Steps` section, so discussion work must be captured explicitly and
 * turned into a deterministic roadmap instead of being forced through Plan mode
 * or a fake file path.
 *
 * Everything here is pure and bounded. The extension owns where the capture is
 * written and when a run is ingested; this module only decides what the source
 * is and produces stable bytes plus their digest.
 */

import { createHash } from "node:crypto";

export type WorkSourceKind = "plan" | "discussion" | "auto";

export const WORK_SOURCE_VERSION = 1 as const;
export const MAX_SOURCE_CHARS = 20_000;
export const MAX_REQUIREMENTS = 60;
export const MAX_REQUIREMENT_CHARS = 400;

export interface WorkSourceRequest {
  /** Explicit source; `auto` resolves from the request and live context. */
  source?: WorkSourceKind;
  planPath?: string;
  /** The user's objective when the work comes from the discussion. */
  objective?: string;
  /** Extra constraints the user stated. */
  constraints?: string[];
  /** A stable label for the transcript/status (never a secret). */
  label?: string;
  now: number;
}

export interface PlanSource {
  kind: "plan";
  path: string;
}

export interface DiscussionSource {
  kind: "discussion";
  objective: string;
  constraints: string[];
  markdown: string;
  digest: string;
  requirements: string[];
  label: string;
  capturedAt: number;
}

export type WorkSourceResolution =
  | { ok: true; source: PlanSource | DiscussionSource }
  | { ok: false; code: "invalid" | "missing" | "ambiguous"; error: string };

function clean(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.replace(/\r\n/g, "\n").trim();
  if (text.length === 0) return undefined;
  return text.slice(0, max);
}

function digestOf(markdown: string): string {
  return createHash("sha256").update(markdown, "utf8").digest("hex");
}

/**
 * Splits the objective into requirements without inventing scope.
 *
 * Bullets/numbered lines in the objective are the user's own decomposition and
 * become one requirement each. A plain paragraph is a single requirement. The
 * constraints follow as explicit requirements so the breakdown must cover them.
 */
export function discussionRequirements(input: {
  objective: string;
  constraints?: readonly string[];
}): string[] {
  const objective = input.objective.replace(/\r\n/g, "\n").trim();
  const listed = objective
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^([-*+]|\d+[.)])\s+/.test(line))
    .map((line) => line.replace(/^([-*+]|\d+[.)])\s+/, "").trim())
    .filter((line) => line.length > 0);

  const base =
    listed.length > 0
      ? listed
      : objective
          .split(/\n{2,}/)
          .map((part) => part.replace(/\s+/g, " ").trim())
          .filter((part) => part.length > 0);

  const requirements: string[] = [];
  const seen = new Set<string>();
  const push = (text: string) => {
    const bounded = text.replace(/\s+/g, " ").trim().slice(0, MAX_REQUIREMENT_CHARS);
    if (!bounded) return;
    const key = bounded.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    if (requirements.length < MAX_REQUIREMENTS) requirements.push(bounded);
  };
  for (const entry of base) push(entry);
  for (const constraint of input.constraints ?? []) {
    push(`Respect the constraint: ${constraint}`);
  }
  return requirements;
}

/** Deterministic roadmap bytes for discussion work. */
export function discussionRoadmap(input: {
  objective: string;
  constraints?: readonly string[];
  label?: string;
  sourceRef?: string;
  capturedAt: number;
}): { markdown: string; requirements: string[]; digest: string } {
  const requirements = discussionRequirements({
    objective: input.objective,
    ...(input.constraints === undefined ? {} : { constraints: input.constraints }),
  });
  const title = (input.label ?? input.objective.split("\n")[0] ?? "Discussed work")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  const lines = [
    `# Plan: ${title}`,
    "",
    "## Context",
    "",
    "Captured from the current Orchestrator discussion at the user's request. This is",
    "an execution snapshot, not a separately approved Plan-mode document; the",
    "breakdown approval is the user decision that authorizes work.",
    "",
    ...(input.sourceRef ? ["", `Source: ${input.sourceRef}`] : []),
    "",
    "## Plan Steps",
    "",
    ...requirements.map((requirement, index) => `${index + 1}. ${requirement}`),
    "",
  ];
  const markdown = lines.join("\n");
  return { markdown, requirements, digest: digestOf(markdown) };
}

/**
 * Resolves which work source this request means.
 *
 * Explicit input wins over live state, and an explicit `discussion` wins over a
 * stale plan file — the user's current request is not an old path.
 */
export function resolveWorkSource(input: {
  request: WorkSourceRequest;
  /** A plan path already bound to this session, when known. */
  boundPlanPath?: string;
  /** The current user prompt, bounded by the caller. */
  lastUserPrompt?: string;
}): WorkSourceResolution {
  const requested = input.request.source ?? "auto";

  if (requested === "plan") {
    const path = input.request.planPath ?? input.boundPlanPath;
    if (!path) {
      return {
        ok: false,
        code: "missing",
        error:
          "no plan path is available; pass planPath or use source \"discussion\" for the current conversation",
      };
    }
    return { ok: true, source: { kind: "plan", path } };
  }

  if (requested === "discussion") {
    const objective = clean(
      input.request.objective ?? input.lastUserPrompt,
      MAX_SOURCE_CHARS,
    );
    if (!objective) {
      return {
        ok: false,
        code: "invalid",
        error:
          "no objective was supplied for discussion work; describe the work in the prompt or pass objective",
      };
    }
    const captured = discussionRoadmap({
      objective,
      ...(input.request.constraints === undefined
        ? {}
        : { constraints: input.request.constraints }),
      ...(input.request.label === undefined ? {} : { label: input.request.label }),
      capturedAt: input.request.now,
    });
    return {
      ok: true,
      source: {
        kind: "discussion",
        objective,
        constraints: [...(input.request.constraints ?? [])],
        markdown: captured.markdown,
        digest: captured.digest,
        requirements: captured.requirements,
        label: input.request.label ?? "current discussion",
        capturedAt: input.request.now,
      },
    };
  }

  // auto: explicit planPath wins, then an explicitly requested discussion
  // objective, then the current discussion, then a bound plan path.
  if (input.request.planPath) return { ok: true, source: { kind: "plan", path: input.request.planPath } };
  const objective = clean(
    input.request.objective ?? input.lastUserPrompt,
    MAX_SOURCE_CHARS,
  );
  if (objective) {
    const captured = discussionRoadmap({
      objective,
      ...(input.request.constraints === undefined
        ? {}
        : { constraints: input.request.constraints }),
      ...(input.request.label === undefined ? {} : { label: input.request.label }),
      capturedAt: input.request.now,
    });
    return {
      ok: true,
      source: {
        kind: "discussion",
        objective,
        constraints: [...(input.request.constraints ?? [])],
        markdown: captured.markdown,
        digest: captured.digest,
        requirements: captured.requirements,
        label: input.request.label ?? "current discussion",
        capturedAt: input.request.now,
      },
    };
  }
  if (input.boundPlanPath) return { ok: true, source: { kind: "plan", path: input.boundPlanPath } };
  return {
    ok: false,
    code: "ambiguous",
    error:
      "no work source is available; ask the user what to work on, or pass source/planPath",
  };
}

/** A stable, workspace-safe artifact name for a captured discussion. */
export function discussionSourceFileName(digest: string): string {
  return `discussion-${digest.slice(0, 16)}.md`;
}

/**
 * Summarizes the capture for the preparation result without dumping the whole
 * transcript back into the model's context.
 */
export function summarizeWorkSource(source: PlanSource | DiscussionSource): string {
  if (source.kind === "plan") return `plan ${source.path}`;
  return `current discussion (${source.requirements.length} requirement(s), digest ${source.digest.slice(0, 12)})`;
}
