/**
 * Workflow Extension — Review Mode tool definitions
 *
 * These are the ONLY tools the reviewer child session may call. They are built
 * here (rather than in review.ts) because they need TypeBox schemas, and
 * review.ts is deliberately free of runtime imports so it stays unit-testable.
 *
 * Permission model — Review Mode is read-only except for one write path:
 *
 *   review_bash         read-only + verify shell, gated by the same role policy
 *                       Plan Mode uses via `explainCommandRefusal("reviewer", …)`
 *                       (no file redirects — `2>/dev/null` and `2>&1` are fine —
 *                       no rm/mv/cp, no sudo, no installs, no sed/awk, no git
 *                       mutations; test/lint/typecheck runners are allowed)
 *   review_explore      read-only subagents, capped by exploreBudget
 *   review_submit_plan  the single write path: writes the reviewed plan
 *   review_pass_done    ends a pass with a verdict (no side effects)
 *
 * Note: the reviewer is NOT given the built-in `bash`, `edit`, or `write`
 * tools at all. `review_bash` is a distinct tool name so it can never be
 * confused with, or override, the built-in one.
 */

import { Type, type TSchema } from "typebox";
import {
    appendReviewChangelog,
    renderReviewChangelog,
    validateReviewedPlan,
    type ReviewFinding,
} from "./utils.ts";
import { explainCommandRefusal } from "./permissions.ts";
import type {
    PiCodingAgentSdk,
    ReviewPassResult,
    ReviewVerdict,
} from "./review.ts";
import { sanitizeFindings } from "./review.ts";

/** Result shape shared by every review tool. */
export interface ReviewToolTextResult {
    content: Array<{ type: "text"; text: string }>;
    details?: Record<string, unknown>;
    isError?: boolean;
}

export interface ReviewBashDeps {
    /** Working directory for shell execution. */
    cwd: string;
    /** Surface refusals and anomalies to the parent session. */
    log: (message: string, level?: "info" | "warning" | "error") => void;
}

/** Injectable shell-tool builder so this module is testable without the SDK. */
export type BashToolDefinitionBuilder = (cwd: string) => {
    parameters: TSchema;
    execute: (...args: unknown[]) => Promise<unknown>;
};

/**
 * `review_bash` — the reviewer's only shell access.
 *
 * The gate is `explainCommandRefusal("reviewer", …)` from permissions.ts —
 * the same role policy Plan Mode's `tool_call` hook applies to the planner, so
 * Review Mode inherits Plan Mode's permissions rather than defining its own. A
 * refused command is never executed: the wrapper returns before delegating to
 * Pi's shell backend, and the refusal names the first rule that failed.
 *
 * Execution itself is delegated to Pi's `createBashToolDefinition`, so shell
 * selection (bash on POSIX, the platform shell on Windows), output truncation,
 * timeouts and session env vars all behave exactly as they do elsewhere in Pi.
 */
export function createReviewBashTool(
    buildBashToolDefinition: BashToolDefinitionBuilder,
    deps: ReviewBashDeps,
): {
    name: string;
    label: string;
    description: string;
    parameters: TSchema;
    execute: (...args: unknown[]) => Promise<ReviewToolTextResult>;
} {
    const inner = buildBashToolDefinition(deps.cwd);

    return {
        name: "review_bash",
        label: "Review Bash (read-only)",
        description:
            "Run a READ-ONLY or VERIFY shell command to inspect and check the repository (git log/diff/status/show-ref, ls, cat, rg, npm test, npm run lint/typecheck, eslint, tsc --noEmit, node --test, pytest, cargo clippy). Mutating commands — file redirects (> and >>), sed/awk, rm, mv, cp, chmod, sudo, package installs/builds, git add/commit/push — are refused by the harness; `2>/dev/null` and `2>&1` are allowed. You cannot write files with this tool; use review_submit_plan to submit the revised plan.",
        parameters: inner.parameters,
        async execute(...args: unknown[]): Promise<ReviewToolTextResult> {
            // SAFETY: Pi invokes ToolDefinition.execute as
            // (toolCallId, params, signal, onUpdate, ctx) — see ToolDefinition in
            // @earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts. The
            // variadic `unknown[]` signature exists only so this wrapper stays
            // assignable to ToolDefinition without pinning its generics; the runtime
            // argument order is guaranteed by that contract.
            const [toolCallId, rawParams, signal, onUpdate, ctx] =
                args as unknown as [
                    string,
                    { command?: unknown; timeout?: unknown },
                    AbortSignal | undefined,
                    unknown,
                    unknown,
                ];
            const command =
                typeof rawParams?.command === "string" ? rawParams.command : "";

            if (!command.trim()) {
                return {
                    content: [
                        { type: "text", text: "review_bash: command is empty" },
                    ],
                    isError: true,
                };
            }

            const refusal = explainCommandRefusal("reviewer", command);
            if (refusal) {
                deps.log(
                    `Review Mode refused a read-only violation: ${command.slice(0, 120)}`,
                    "warning",
                );
                return {
                    content: [
                        {
                            type: "text",
                            text: [
                                `review_bash: REFUSED — ${refusal.detail}.`,
                                refusal.suggestion ?? "",
                                "",
                                "Review Mode has Plan Mode's permissions: read-only inspection plus",
                                "test/lint/typecheck commands (npm test, npm run lint/typecheck, eslint,",
                                "tsc --noEmit, node --test, pytest, cargo clippy). File redirects (> and >>)",
                                "are refused while 2>/dev/null and 2>&1 are allowed; sed/awk are not on",
                                "the allowlist; no rm/mv/cp/mkdir/touch/chmod, no sudo, no package installs",
                                "or builds, no git add/commit/push/checkout. Do not work around this.",
                                "",
                                "If you need to change the plan, call review_submit_plan.",
                            ]
                                .filter(Boolean)
                                .join("\n"),
                        },
                    ],
                    isError: true,
                };
            }

            try {
                const result = (await inner.execute(
                    toolCallId,
                    rawParams,
                    signal,
                    onUpdate,
                    ctx,
                )) as ReviewToolTextResult;
                return result;
            } catch (e: unknown) {
                return {
                    content: [
                        {
                            type: "text",
                            text: `review_bash: execution failed — ${
                                e instanceof Error ? e.message : String(e)
                            }`,
                        },
                    ],
                    isError: true,
                };
            }
        },
    };
}

/**
 * Type guard for the parts of the SDK this module needs, so a partial or
 * mismatched SDK produces a clear tool-level error instead of a crash.
 */
export function resolveBashToolDefinitionBuilder(
    sdk: PiCodingAgentSdk | undefined,
): BashToolDefinitionBuilder | undefined {
    const candidate = (
        sdk as { createBashToolDefinition?: unknown } | undefined
    )?.createBashToolDefinition;
    if (typeof candidate !== "function") return undefined;
    return candidate as BashToolDefinitionBuilder;
}

// ── Step 8: review_explore ───────────────────────────────────────────

/**
 * One read-only reconnaissance task. Resolves to a concise findings string.
 *
 * Injected rather than imported: the existing `explore` implementation lives
 * inside index.ts's extension closure and is not importable. Supplying it as a
 * dependency also means the reviewer reuses the SAME subagent spawn path as
 * Plan Mode — identical tool allowlist, identical explorer role model — instead
 * of a parallel implementation that could drift.
 */
export type ReviewExploreRunner = (
    task: string,
    signal?: AbortSignal,
) => Promise<string>;

export interface ReviewExploreDeps {
    /** Hard ceiling on subagents for the current review round. */
    budget: () => number;
    /** Read-only reconnaissance runner (explorer role, no write tools). */
    run: ReviewExploreRunner;
    /** Report the running total so the parent can persist/display it. */
    onUsed: (used: number) => void;
    /** Surface budget exhaustion and per-task failures. */
    log: (message: string, level?: "info" | "warning" | "error") => void;
}

/**
 * `review_explore` — delegate focused read-only reconnaissance to subagents.
 *
 * Budget accounting lives here (not in the prompt) so an over-eager reviewer
 * cannot run away with the user's tokens: every task is counted, and tasks
 * beyond `budget()` are refused with a message that tells the reviewer to work
 * with what it already has.
 */
export function createReviewExploreTool(deps: ReviewExploreDeps): {
    name: string;
    label: string;
    description: string;
    parameters: TSchema;
    execute: (...args: unknown[]) => Promise<ReviewToolTextResult>;
} {
    let used = 0;

    return {
        name: "review_explore",
        label: "Review Explore (read-only subagents)",
        description:
            "Delegate focused READ-ONLY reconnaissance to subagents that run with the explorer role's model. Use this to check several independent facts at once (e.g. 'do other modules use a Result type?', 'what is the established migration pattern?', 'how are these tests structured?'). Subagents cannot write files. The number of subagents is capped by the review budget; tasks beyond the cap are refused.",
        parameters: Type.Object({
            tasks: Type.Array(
                Type.Object({
                    task: Type.String({
                        description:
                            "A specific, self-contained question about THIS repository. Include the files or symbols to look at.",
                    }),
                }),
                {
                    minItems: 1,
                    maxItems: 4,
                    description:
                        "Independent reconnaissance tasks, run in parallel.",
                },
            ),
        }),
        async execute(...args: unknown[]): Promise<ReviewToolTextResult> {
            // SAFETY: same ToolDefinition.execute contract as review_bash above —
            // Pi calls (toolCallId, params, signal, onUpdate, ctx).
            const [, rawParams, signal] = args as unknown as [
                string,
                { tasks?: Array<{ task?: unknown }> },
                AbortSignal | undefined,
            ];

            const requested = Array.isArray(rawParams?.tasks)
                ? rawParams.tasks
                      .map((t) =>
                          typeof t?.task === "string" ? t.task.trim() : "",
                      )
                      .filter(Boolean)
                : [];

            if (requested.length === 0) {
                return {
                    content: [
                        {
                            type: "text",
                            text: "review_explore: no tasks given",
                        },
                    ],
                    isError: true,
                };
            }

            const budget = Math.max(0, Math.trunc(deps.budget()));
            const remaining = Math.max(0, budget - used);
            if (remaining === 0) {
                return {
                    content: [
                        {
                            type: "text",
                            text: `review_explore: budget exhausted (${used}/${budget} subagents used this round). Work with what you have already gathered, or finish the review and report what you could not verify in the findings.`,
                        },
                    ],
                    isError: true,
                };
            }

            const slice = requested.slice(0, Math.min(remaining, 4));
            used += slice.length;
            deps.onUsed(used);

            const results = await Promise.all(
                slice.map(async (task, i) => {
                    try {
                        const text = await deps.run(task, signal);
                        return `### Recon ${i + 1}: ${task}\n\n${text?.trim() || "(no findings)"}`;
                    } catch (e: unknown) {
                        const msg = e instanceof Error ? e.message : String(e);
                        deps.log(
                            `review_explore task failed: ${msg}`,
                            "warning",
                        );
                        return `### Recon ${i + 1}: ${task}\n\nFAILED: ${msg}`;
                    }
                }),
            );

            const omitted = requested.length - slice.length;
            const tail =
                omitted > 0
                    ? `\n\n(${omitted} further task(s) not run — explore budget is ${budget} per round.)`
                    : "";

            return {
                content: [{ type: "text", text: results.join("\n\n") + tail }],
                details: { used, budget, tasks: slice.length },
            };
        },
    };
}

/** Convenience toolbox used by review.ts when assembling `customTools`. */
export interface ReviewToolbox {
    tools: unknown[];
    /** Names actually available; missing SDK pieces are reported, not thrown. */
    unavailable: string[];
}

/** Everything the review tool set needs from the parent extension. */
export interface ReviewToolDeps {
    cwd: string;
    log: (message: string, level?: "info" | "warning" | "error") => void;
    explore: ReviewExploreDeps;
    submit: ReviewSubmitDeps;
    passDone: ReviewPassDoneDeps;
}

// ── Steps 9-11: review_submit_plan ───────────────────────────────────

/** What the reviewer handed in, after validation. */
export interface ReviewSubmitPayload {
    /** The reviewer's plan body, without the changelog appendix. */
    planBody: string;
    /** planBody + the generated `## Review changes` appendix (what gets written). */
    planText: string;
    findings: ReviewFinding[];
    verdict: ReviewVerdict;
    /** The reviewer's one-line summary of the change. */
    summary: string;
    /** The rendered changelog section. */
    changelog: string;
}

export interface ReviewSubmitDeps {
    /**
     * The plan path Plan Mode computed. Review Mode adjusts that file; it never
     * invents a new slug (utils.normalizePlanPath owns the naming convention).
     */
    planPath: () => string | undefined;
    /** The author's current plan — the validation baseline and changelog base. */
    originalPlan: () => string | undefined;
    /** Reviewer model label, recorded in the changelog header. */
    modelLabel: () => string;
    /** Persist the reviewed plan and announce it. Owned by the parent. */
    submit: (
        payload: ReviewSubmitPayload,
    ) => Promise<{ ok: boolean; path?: string; error?: string }>;
    log: (message: string, level?: "info" | "warning" | "error") => void;
}

const VERDICT_SCHEMA = Type.Union([
    Type.Literal("approve"),
    Type.Literal("revise"),
    Type.Literal("block"),
]);

const FINDING_SCHEMA = Type.Object({
    id: Type.Optional(
        Type.String({ description: "Short stable id, e.g. F1. Optional." }),
    ),
    severity: Type.Number({
        description: "1-10, higher is worse. Use 8+ only for real breakage.",
    }),
    confidence: Type.Number({ description: "0-100. Be honest." }),
    category: Type.String({
        description:
            "e.g. framework-alignment, correctness, requirement-coverage, security, simplicity, best-practice",
    }),
    file: Type.Optional(
        Type.String({
            description: "Repo-relative path, when you can anchor it.",
        }),
    ),
    lineRange: Type.Optional(
        Type.String({ description: "e.g. '42' or '42-58'." }),
    ),
    summary: Type.String({ description: "One line: what is wrong." }),
    rationale: Type.String({
        description: "Why it matters, citing the repo convention or practice.",
    }),
    disposition: Type.Union([
        Type.Literal("accepted"),
        Type.Literal("rejected"),
        Type.Literal("deferred"),
    ]),
});

/**
 * `review_submit_plan` — the ONLY write path for Review Mode.
 *
 * Three things happen here, in order, and nothing is written unless all three
 * pass:
 *
 *  1. (step 10) Validate the submission against the author's plan. A stub or a
 *     heading-less blob is rejected and returned to the reviewer to fix, so a
 *     degenerate rewrite can never silently replace a real plan.
 *  2. (step 11) Compose the changelog and append it, so the user can see
 *     exactly what the reviewer changed and why.
 *  3. (steps 12-13) Hand the composed plan to the parent, which writes it to the
 *     SAME plan path Plan Mode chose and records an entry.
 */
export function createReviewSubmitPlanTool(deps: ReviewSubmitDeps): {
    name: string;
    label: string;
    description: string;
    parameters: TSchema;
    execute: (...args: unknown[]) => Promise<ReviewToolTextResult>;
} {
    return {
        name: "review_submit_plan",
        label: "Submit Reviewed Plan",
        description:
            "Submit the FINAL revised plan. This is the only way your work reaches the user, and the only file you can write. Pass the complete plan markdown (not a diff or a summary) plus your findings and verdict. The plan body must keep a markdown heading and stay close to the original length; the harness rejects stubs. A `## Review changes` section is appended automatically from your findings, so do not write it yourself. You may call this more than once — the last successful submission wins.",
        parameters: Type.Object({
            planMarkdown: Type.String({
                description:
                    "The complete revised plan in markdown, preserving the original structure and heading style. Do NOT include a 'Review changes' section.",
            }),
            findings: Type.Array(FINDING_SCHEMA, {
                description:
                    "Every issue you found. Use an empty array if the plan is sound and you are submitting it unchanged.",
            }),
            verdict: VERDICT_SCHEMA,
            summary: Type.String({
                description: "One sentence describing what you changed.",
            }),
        }),
        async execute(...args: unknown[]): Promise<ReviewToolTextResult> {
            // SAFETY: same ToolDefinition.execute contract as the tools above —
            // Pi calls (toolCallId, params, signal, onUpdate, ctx).
            const [, rawParams] = args as unknown as [
                string,
                {
                    planMarkdown?: unknown;
                    findings?: unknown;
                    verdict?: unknown;
                    summary?: unknown;
                },
            ];

            const planBody =
                typeof rawParams?.planMarkdown === "string"
                    ? rawParams.planMarkdown
                    : "";
            const verdict: ReviewVerdict =
                rawParams?.verdict === "approve" ||
                rawParams?.verdict === "revise" ||
                rawParams?.verdict === "block"
                    ? rawParams.verdict
                    : "revise";
            const summary =
                typeof rawParams?.summary === "string"
                    ? rawParams.summary.trim()
                    : "";
            const findings = sanitizeFindings(rawParams?.findings);

            const original = deps.originalPlan() ?? "";
            const targetPath = deps.planPath();
            if (!targetPath) {
                return {
                    content: [
                        {
                            type: "text",
                            text: "review_submit_plan: no plan path is known for this round — the reviewer cannot write. Report this as an error to the user.",
                        },
                    ],
                    isError: true,
                };
            }

            // Step 10 — reject stubs and heading-less blobs before anything is written.
            const problems = validateReviewedPlan(planBody, original);
            if (problems.length > 0) {
                deps.log(
                    `Review submission rejected: ${problems.join("; ")}`,
                    "warning",
                );
                return {
                    content: [
                        {
                            type: "text",
                            text: [
                                "review_submit_plan: REJECTED — nothing was written.",
                                "",
                                ...problems.map((p) => `- ${p}`),
                                "",
                                "Resubmit the COMPLETE plan (all sections, same heading style), not a",
                                "summary or a diff. Read the original plan again if needed.",
                            ].join("\n"),
                        },
                    ],
                    isError: true,
                };
            }

            // Step 11 — changelog, appended so the user sees every change.
            const changelog = renderReviewChangelog(findings, {
                modelLabel: deps.modelLabel(),
                verdict,
            });
            const planText = appendReviewChangelog(planBody, changelog);

            const payload: ReviewSubmitPayload = {
                planBody,
                planText,
                findings,
                verdict,
                summary,
                changelog,
            };

            let result: { ok: boolean; path?: string; error?: string };
            try {
                result = await deps.submit(payload);
            } catch (e: unknown) {
                result = {
                    ok: false,
                    error: e instanceof Error ? e.message : String(e),
                };
            }

            if (!result.ok) {
                deps.log(
                    `Review submission failed to write: ${result.error ?? "unknown error"}`,
                    "error",
                );
                return {
                    content: [
                        {
                            type: "text",
                            text: `review_submit_plan: could not write the plan — ${result.error ?? "unknown error"}`,
                        },
                    ],
                    isError: true,
                };
            }

            return {
                content: [
                    {
                        type: "text",
                        text: [
                            `review_submit_plan: submitted to ${result.path ?? targetPath}`,
                            `- verdict: ${verdict}`,
                            `- findings: ${findings.length}`,
                            summary ? `- summary: ${summary}` : "",
                            "",
                            "The plan now carries a `## Review changes` appendix. Now call",
                            "review_pass_done to end this pass.",
                        ]
                            .filter(Boolean)
                            .join("\n"),
                    },
                ],
                details: {
                    path: result.path ?? targetPath,
                    verdict,
                    findings: findings.length,
                },
            };
        },
    };
}

// ── Step 15: review_pass_done ────────────────────────────────────────

/**
 * Deterministic orchestration hook for ending a pass.
 *
 * The tool records the verdict and findings; the ORCHESTRATOR decides what
 * happens next (pass 2, another round, or hand off to Plannotator). Keeping that
 * decision in TypeScript rather than in the prompt is what makes the protocol
 * reliable — the same principle the persona-audit and supi-review extensions
 * use for their reviewer loops.
 */
export interface ReviewPassDoneDeps {
    /** Whether the reviewer has submitted a plan in the current pass. */
    hasSubmitted: () => boolean;
    /** Called when the reviewer ends a pass. */
    onPassDone: (result: ReviewPassResult) => void;
    /** True when the harness intends to run the self-verification pass. */
    willVerify: () => boolean;
    log: (message: string, level?: "info" | "warning" | "error") => void;
}

/**
 * `review_pass_done` — end the current pass with a verdict.
 *
 * Refuses to end a pass in which nothing was submitted: a review that never
 * reaches the plan file is a failed review, and silently "completing" it would
 * hand the user the author's unreviewed plan while looking reviewed.
 */
export function createReviewPassDoneTool(deps: ReviewPassDoneDeps): {
    name: string;
    label: string;
    description: string;
    parameters: TSchema;
    execute: (...args: unknown[]) => Promise<ReviewToolTextResult>;
} {
    return {
        name: "review_pass_done",
        label: "Finish Review Pass",
        description:
            "End the current review pass with your verdict and findings. Call this AFTER review_submit_plan — a pass that submits nothing is rejected. Pass 1 completes the review; if the harness schedules a verification pass, it will prompt you for pass 2 next.",
        parameters: Type.Object({
            pass: Type.Optional(
                Type.Union([Type.Literal(1), Type.Literal(2)], {
                    description:
                        "Which pass you are ending. Defaults to the current pass.",
                }),
            ),
            verdict: VERDICT_SCHEMA,
            findings: Type.Array(FINDING_SCHEMA, {
                description:
                    "The same findings you submitted, so the run is readable without re-parsing the plan file.",
            }),
            notes: Type.Optional(
                Type.String({
                    description:
                        "Anything the user should know that is not a finding: what you could not verify, and why.",
                }),
            ),
        }),
        async execute(...args: unknown[]): Promise<ReviewToolTextResult> {
            // SAFETY: same ToolDefinition.execute contract as the tools above —
            // Pi calls (toolCallId, params, signal, onUpdate, ctx).
            const [, rawParams] = args as unknown as [
                string,
                {
                    pass?: unknown;
                    verdict?: unknown;
                    findings?: unknown;
                    notes?: unknown;
                },
            ];

            if (!deps.hasSubmitted()) {
                deps.log(
                    "Review pass_done refused: no plan was submitted this pass",
                    "warning",
                );
                return {
                    content: [
                        {
                            type: "text",
                            text: [
                                "review_pass_done: REFUSED — you have not submitted a plan this pass.",
                                "",
                                "Your review only reaches the user through `review_submit_plan`.",
                                "Submit the complete revised plan (unchanged is fine if it is sound),",
                                "then call review_pass_done again.",
                            ].join("\n"),
                        },
                    ],
                    isError: true,
                };
            }

            const pass: 1 | 2 = rawParams?.pass === 2 ? 2 : 1;
            const verdict: ReviewVerdict =
                rawParams?.verdict === "approve" ||
                rawParams?.verdict === "revise" ||
                rawParams?.verdict === "block"
                    ? rawParams.verdict
                    : "revise";
            const findings = sanitizeFindings(rawParams?.findings);
            const notes =
                typeof rawParams?.notes === "string"
                    ? rawParams.notes.trim()
                    : undefined;

            const result: ReviewPassResult = {
                pass,
                verdict,
                findings,
                at: Date.now(),
            };
            if (notes) result.notes = notes;

            deps.onPassDone(result);
            return {
                content: [
                    {
                        type: "text",
                        text: deps.willVerify()
                            ? "review_pass_done: pass 1 recorded. A verification pass is scheduled — wait for the harness to prompt you, then confirm the rewrite addressed each finding and dropped no original content."
                            : `review_pass_done: pass ${pass} recorded (${verdict}, ${findings.length} finding${findings.length === 1 ? "" : "s"}). Your review is complete.`,
                    },
                ],
                details: { pass, verdict, findings: findings.length },
            };
        },
    };
}

/**
 * Build every tool the reviewer may use.
 */
export function createReviewTools(
    sdk: PiCodingAgentSdk | undefined,
    deps: ReviewToolDeps,
): ReviewToolbox {
    const tools: unknown[] = [];
    const unavailable: string[] = [];

    const bashBuilder = resolveBashToolDefinitionBuilder(sdk);
    if (bashBuilder) {
        tools.push(createReviewBashTool(bashBuilder, deps));
    } else {
        unavailable.push("review_bash (createBashToolDefinition unavailable)");
    }

    tools.push(createReviewExploreTool(deps.explore));
    tools.push(createReviewSubmitPlanTool(deps.submit));
    tools.push(createReviewPassDoneTool(deps.passDone));

    return { tools, unavailable };
}

/** Re-exported so consumers can build ad-hoc schemas of the same flavour. */
export const ReviewSchema = Type;
