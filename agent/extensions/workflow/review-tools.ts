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
 *                       Plan Mode uses via `explainCommandRefusal("reviewer", …)`.
 *                       Safe sed print/select forms and package-runner/transparent
 *                       launcher forms are allowed only when their inner command
 *                       is allowed. `sed -i`/`-f`, awk, file redirects (except
 *                       `2>/dev/null` and `2>&1`), installs, builds and git
 *                       mutations remain refused.
 *   review_explore      read-only subagents, capped by exploreBudget
 *   review_submit       the single write path: appends the reviewer's findings
 *                       and required revisions as an advisory appendix
 *   review_pass_done    ends a pass with a verdict (no side effects)
 *
 * Note: the reviewer is NOT given the built-in `bash`, `edit`, or `write`
 * tools at all. `review_bash` is a distinct tool name so it can never be
 * confused with, or override, the built-in one.
 */

import { Type, type TSchema } from "typebox";
import {
    parseReviewNotes,
    renderRequiredChanges,
    renderReviewChangelog,
    type ReviewFinding,
    type ReviewNote,
    type ReviewRevision,
} from "./utils.ts";
import { explainCommandRefusal } from "./permissions.ts";
import { analyzeShellPaths } from "./shell-paths.ts";
import {
    evaluateFolderTargets,
    type FolderPolicyConfig,
} from "./folder-policy.ts";
import { redactSensitiveText } from "./read-policy-redact.ts";
import {
    createInspectionAuthority,
    resolveInspectionAuthority,
} from "./inspection-policy.ts";
import { createGuardedInspectionTools } from "./inspection-tools.ts";
import type {
    PiCodingAgentSdk,
    ReviewPassResult,
    ReviewVerdict,
} from "./review.ts";
import { sanitizeFindings } from "./review.ts";
import {
    classifyShellFailureText,
    detectEmptyInterpreterProbe,
    emptyProbeReason,
    normalizeShellTimeout,
    shellFailureGuidance,
    type ShellGuardRecovery,
    type ShellLimits,
} from "./shell-guard.ts";

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
    /** The parent's folder policy + read grants (see ReviewToolDeps). */
    folderPolicy?: () => {
        config: FolderPolicyConfig;
        grants: readonly string[];
    };
    /**
     * Request-scoped shell guard. Resolved per execute so a warm reviewer
     * session sees the current round's budget, not the one it was built with.
     */
    shellGuard?: () =>
        | {
              limits: ShellLimits;
              state: ShellGuardRecovery;
              onTrip?: (reason: string) => void;
          }
        | undefined;
}

/** Injectable shell-tool builder so this module is testable without the SDK. */
export type BashToolDefinitionBuilder = (cwd: string) => {
    parameters: TSchema;
    execute: (...args: unknown[]) => Promise<unknown>;
};

/** Resolved reviewer shell-guard dependency. */
type ReviewShellGuard = NonNullable<
    ReturnType<NonNullable<ReviewBashDeps["shellGuard"]>>
>;

function reviewResultText(result: ReviewToolTextResult): string {
    return (result.content ?? [])
        .map((part) =>
            part && typeof part === "object" && typeof part.text === "string"
                ? part.text
                : "",
        )
        .filter(Boolean)
        .join("\n");
}

/**
 * Observe one reviewer shell result. Only a native deadline consumes the
 * budget; a user abort, permission refusal or ordinary test failure does not.
 */
function guardReviewShellResult(
    result: ReviewToolTextResult,
    command: string,
    shellGuard: ReviewShellGuard | undefined,
): ReviewToolTextResult {
    if (!shellGuard) return result;
    const kind = classifyShellFailureText(reviewResultText(result));
    if (!kind) return result;
    const decision = shellGuard.state.recordFailure({ kind, command });
    if (decision.action === "stop") shellGuard.onTrip?.(decision.reason);
    return {
        ...result,
        content: [
            ...(result.content ?? []),
            { type: "text", text: shellFailureGuidance(kind, decision) },
        ],
        isError: true,
    };
}

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
            "Run a READ-ONLY or VERIFY shell command to inspect and check the repository (git log/diff/status/show-ref, ls, cat, rg, npm test, npm run lint/typecheck, eslint, tsc --noEmit, node --test, pytest, cargo clippy). Safe sed print/select forms (for example, sed -n '440,510p' f) and package-runner/transparent launcher forms (npx vitest run, npm exec -- vitest, timeout 60 npx vitest) follow the same policy as Plan Mode and are allowed only when the inner command is read-only/verify. Arbitrary awk and sed -i/-f or unsafe sed programs, real file redirects (except 2>/dev/null and 2>&1), rm/mv/cp/mkdir/touch/chmod/sudo, package installs/builds and git mutations remain refused; unknown/dangerous wrapper flags and env assignments outside CI, NO_COLOR, FORCE_COLOR, TZ, LANG, LC_* and TERM are refused, and wrapper recursion is bounded. This is a policy gate, not an OS sandbox: allowlisted test runners execute project code and npx may fetch a missing named tool. Use review_submit to record your findings and required revisions.",
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
                    `Review Mode refused a command outside its read-only policy: ${refusal.detail} — ${command.slice(0, 120)}`,
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
                                "tsc --noEmit, node --test, pytest, cargo clippy). Safe sed print/select",
                                "forms and package-runner/transparent launchers are allowed only when the",
                                "inner command is allowed; wrapper recursion is bounded and unknown or",
                                "dangerous flags refuse. Arbitrary awk remains Builder-only; sed -i/-f and",
                                "unsafe sed programs, real file redirects (except 2>/dev/null and 2>&1),",
                                "no rm/mv/cp/mkdir/touch/chmod, sudo, installs/builds or git mutations",
                                "remain refused. Do not work around this.",
                                "",
                                "If you need to change the plan, call review_submit with your findings",
                                "and required revisions — it appends an advisory section and leaves the",
                                "approved plan body untouched.",
                            ]
                                .filter(Boolean)
                                .join("\n"),
                        },
                    ],
                    isError: true,
                };
            }

            const guard = reviewerReadGuard(deps.cwd, deps.folderPolicy?.());
            const readPaths = analyzeShellPaths(command, deps.cwd).reads;
            const readEval = evaluateFolderTargets(readPaths, {
                config: guard.config,
                grants: guard.grants,
                cwd: deps.cwd,
                lockedRoots: [guard.root],
                action: "read",
            });
            if (
                readEval.sensitive.length > 0 ||
                readEval.excluded.length > 0 ||
                readEval.outside.length > 0
            ) {
                const target =
                    readEval.sensitive[0]?.path ??
                    readEval.excluded[0]?.path ??
                    readEval.outside[0]?.path ??
                    "the requested path";
                deps.log(
                    `Review Mode refused a read outside the repository/sensitive guard: ${target}`,
                    "warning",
                );
                return {
                    content: [
                        {
                            type: "text",
                            text: `review_bash: REFUSED — \`${target}\` is outside the reviewer's permitted repository or is a sensitive file. Work only inside the repository; do not work around this.`,
                        },
                    ],
                    isError: true,
                };
            }

            const shellGuard = deps.shellGuard?.();
            if (shellGuard?.state.isStopped()) {
                return {
                    content: [
                        {
                            type: "text",
                            text: "review_bash: shell is quarantined for this execution. Do not spawn another shell; continue with read-only inspection or end the review with the evidence you have.",
                        },
                    ],
                    isError: true,
                };
            }
            if (shellGuard) {
                const probe = detectEmptyInterpreterProbe(command);
                if (probe.kind === "empty-probe") {
                    const decision = shellGuard.state.recordFailure({
                        kind: "empty-probe",
                        command,
                    });
                    if (decision.action === "stop") {
                        shellGuard.onTrip?.(decision.reason);
                    }
                    deps.log(
                        "Review Mode refused an empty interpreter probe.",
                        "warning",
                    );
                    return {
                        content: [
                            {
                                type: "text",
                                text:
                                    emptyProbeReason(probe) +
                                    shellFailureGuidance("empty-probe", decision),
                            },
                        ],
                        isError: true,
                    };
                }
                const normalized = normalizeShellTimeout(
                    rawParams,
                    shellGuard.limits,
                    "review_bash",
                );
                if (!normalized.ok) {
                    const decision = shellGuard.state.recordFailure({
                        kind: "invalid-timeout",
                        command,
                    });
                    if (decision.action === "stop") {
                        shellGuard.onTrip?.(decision.reason);
                    }
                    return {
                        content: [
                            {
                                type: "text",
                                text:
                                    normalized.error +
                                    shellFailureGuidance("invalid-timeout", decision),
                            },
                        ],
                        isError: true,
                    };
                }
                // The reviewer's optional timeout gets the same finite bound
                // as the main session's; Pi arms process-tree cancellation on
                // the value it receives.
                (rawParams as { timeout?: number }).timeout =
                    normalized.timeoutSeconds;
            }

            try {
                const result = (await inner.execute(
                    toolCallId,
                    rawParams,
                    signal,
                    onUpdate,
                    ctx,
                )) as ReviewToolTextResult;
                const guarded = guardReviewShellResult(result, command, shellGuard);
                return redactReviewResult(
                    guarded,
                    "bash",
                    rawParams,
                    deps.cwd,
                    guard.config,
                );
            } catch (e: unknown) {
                const failure = {
                    content: [
                        {
                            type: "text" as const,
                            text: `review_bash: execution failed — ${
                                e instanceof Error ? e.message : String(e)
                            }`,
                        },
                    ],
                    isError: true as const,
                };
                // The real SDK throws on a native timeout; observe the thrown
                // message before wrapping it, otherwise the reviewer budget
                // never sees the timeout.
                const guarded = guardReviewShellResult(
                    failure,
                    command,
                    shellGuard,
                );
                return redactReviewResult(
                    guarded,
                    "bash",
                    rawParams,
                    deps.cwd,
                    guard.config,
                );
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
    /** Request-scoped shell guard for `review_bash`. */
    shellGuard?: ReviewBashDeps["shellGuard"];
    /**
     * The parent's effective folder policy (sensitive extras, `excludePaths`)
     * and read grants. The reviewer is a separate session with no ambient
     * extensions, so without this it would ignore the user's deny layer.
     */
    folderPolicy?: () => {
        config: FolderPolicyConfig;
        grants: readonly string[];
    };
}

// ── Steps 9-11: review_submit ───────────────────────────────────────

/** What the reviewer handed in, after validation. */
export interface ReviewSubmitPayload {
    /** The author's plan body, unchanged (no reviewer appendix). */
    planBody: string;
    /** planBody + the generated `## Reviewer Revisions` appendix (what gets written). */
    planText: string;
    findings: ReviewFinding[];
    verdict: ReviewVerdict;
    /**
     * Required changes the reviewer submitted, AFTER normalization
     * (`revisions.length`). The appendix parse is the only other record of the
     * count, so keeping the submitted number here lets the negotiation
     * distinguish a fail-closed zero parse from a reviewer requesting no changes.
     */
    requiredChanges: number;
    /** The reviewer's one-line summary of the change. */
    summary: string;
    /** The rendered changelog section. */
    changelog: string;
}

export interface ReviewSubmitDeps {
    /**
     * The plan path Plan Mode computed. Review Mode appends to that file; it
     * never invents a new slug (utils.normalizePlanPath owns the convention).
     */
    planPath: () => string | undefined;
    /** The author's current plan — the append base (pass 2 strips the prior section). */
    originalPlan: () => string | undefined;
    /** Reviewer model label, recorded in the changelog header. */
    modelLabel: () => string;
    /** Current review round, recorded in the section heading. */
    round?: () => number;
    /** Persist the appended plan text and announce it. Owned by the parent. */
    submit: (
        payload: ReviewSubmitPayload,
    ) => Promise<{ ok: boolean; path?: string; error?: string }>;
    log: (message: string, level?: "info" | "warning" | "error") => void;
}

/**
 * Remove a previously appended `## Reviewer Revisions (round N)` section.
 *
 * `ReviewSubmitDeps.originalPlan()` reads the LIVE plan file, which after pass 1
 * already ends with pass 1's revisions section. Composing the next submission
 * from that raw text would stack a second section on top of the first, so the
 * base is cut back to the author's body before the new section is rendered.
 * Cutting at the FIRST heading also drops any sections stacked behind it.
 *
 * Deliberately NOT folded into `utils.stripReviewAppendix`: that helper defines
 * `planHash` and the re-review dedupe inputs, so widening it would change which
 * plans count as already reviewed.
 */
export function stripReviewerRevisions(text: string): string {
    if (typeof text !== "string") return "";
    const hit = text.search(/^[ \t]*## Reviewer Revisions \(round /m);
    if (hit === -1) return text;
    return text.slice(0, hit).trimEnd();
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
 * `review_submit` — the ONLY write path for Review Mode, and it is append-only.
 *
 * Three things happen here, in order, and nothing is written unless all three
 * pass:
 *
 *  1. (step 10) Validate the submission: the round must know a plan path and the
 *     author's plan body must be non-empty, otherwise the reviewer is told to
 *     report the failure instead of writing. An `approve` verdict that carries
 *     required changes is refused too — approval means the plan is converged,
 *     so the reviewer must use `revise` or drop the revisions.
 *  2. (step 11) Render the advisory `## Reviewer Revisions (round N)` appendix
 *     (findings, verdict, summary, required revisions), append it to the
 *     author's plan body, then parse that would-be text back and compare the
 *     full note shape (`id`/`step`/`change`/`findingIds`, in order) with the
 *     normalised revisions. Any drift refuses the submission and nothing is
 *     written. Any earlier revisions section is stripped first, so a round
 *     always leaves exactly one and the body itself is never rewritten.
 *  3. (steps 12-13) Hand the appended plan text to the parent, which writes it to
 *     the SAME plan path Plan Mode chose and records an entry.
 */
export function createReviewSubmitTool(deps: ReviewSubmitDeps): {
    name: string;
    label: string;
    description: string;
    parameters: TSchema;
    execute: (...args: unknown[]) => Promise<ReviewToolTextResult>;
} {
    return {
        name: "review_submit",
        label: "Submit Review",
        description:
            "Submit your findings and required revisions. Do NOT rewrite the plan: the harness appends one '## Reviewer Revisions' section to the plan file and keeps the original body unchanged. Call review_pass_done afterwards. `approve` means no required changes — if you have any, use `revise` (or drop them), because an approve that carries revisions is refused.",
        parameters: Type.Object({
            findings: Type.Array(FINDING_SCHEMA, {
                description:
                    "Every issue you found. Use an empty array if the plan is sound.",
            }),
            verdict: VERDICT_SCHEMA,
            summary: Type.String({
                description: "One sentence describing the review outcome.",
            }),
            revisions: Type.Optional(
                Type.Array(
                    Type.Object({
                        id: Type.Optional(
                            Type.String({
                                description:
                                    "Note id, `R<n>` only (case-insensitive; `R01` canonicalises to `R1`). Numbering restarts at R1 every round, so a note restated in a later round may reuse its previous id. Omit it and the harness assigns R1..Rn in submission order. Any other form (`RV1`, `F1`, `1`, blanks) is rejected, as are duplicate ids.",
                            }),
                        ),
                        step: Type.Optional(
                            Type.String({
                                description:
                                    "Plan step number or short reference, e.g. '3' or 'Phase 2'.",
                            }),
                        ),
                        change: Type.String({
                            description:
                                "The concrete revision the author must make.",
                        }),
                        findingIds: Type.Optional(
                            Type.Array(Type.String(), {
                                description:
                                    "Finding ids this revision addresses, e.g. ['F1', 'F3']. Optional.",
                            }),
                        ),
                    }),
                    {
                        description:
                            "Required changes, one per plan step. These are appended as the Reviewer Revisions section.",
                    },
                ),
            ),
        }),
        async execute(...args: unknown[]): Promise<ReviewToolTextResult> {
            // SAFETY: same ToolDefinition.execute contract as the tools above —
            // Pi calls (toolCallId, params, signal, onUpdate, ctx).
            const [, rawParams] = args as unknown as [
                string,
                {
                    findings?: unknown;
                    verdict?: unknown;
                    summary?: unknown;
                    revisions?: unknown;
                },
            ];
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
            const normalized = normalizeRevisions(rawParams?.revisions);
            // A submission whose ids or `change` text do not fit the appendix
            // grammar is refused BEFORE anything is rendered or written: the
            // renderer/parser pair would silently drop or reshape the note, so
            // the plan file keeps the previous round's notes and the reviewer is
            // told exactly what to fix.
            if (normalized.error) {
                return {
                    content: [{ type: "text", text: normalized.error }],
                    isError: true,
                };
            }
            const revisions = normalized.revisions;

            // Convergence gate: `approve` is the reviewer's "nothing left to
            // change" signal, so it cannot carry required changes. Refuse BEFORE
            // anything is written or submitted; the tool result is error-shaped
            // and the round's state stays untouched.
            if (verdict === "approve" && revisions.length > 0) {
                return {
                    content: [
                        {
                            type: "text",
                            text: "review_submit: verdict approve cannot carry required changes; use revise or drop the revisions.",
                        },
                    ],
                    isError: true,
                };
            }
            const convergedWithoutNotes =
                verdict !== "approve" && revisions.length === 0;

            // Pass 2 resubmits against a plan file that already carries pass 1's
            // revisions section: strip it so the round's section is replaced,
            // not stacked, and `planHash(planBody)` stays the author's body.
            const original = stripReviewerRevisions(deps.originalPlan() ?? "");
            const targetPath = deps.planPath();
            if (!targetPath) {
                return {
                    content: [
                        {
                            type: "text",
                            text: "review_submit: no plan path is known for this round — the reviewer cannot append. Report this as an error to the user.",
                        },
                    ],
                    isError: true,
                };
            }
            if (!original.trim()) {
                return {
                    content: [
                        {
                            type: "text",
                            text: "review_submit: the original plan is empty — nothing to append to.",
                        },
                    ],
                    isError: true,
                };
            }

            const round = deps.round?.() ?? 1;
            const changelog = renderReviewerRevisions(findings, {
                ...(deps.modelLabel() ? { modelLabel: deps.modelLabel() } : {}),
                verdict,
                summary,
                revisions,
                round,
            });
            const planText = `${original.trimEnd()}\n\n${changelog}\n`;

            // Round-trip gate: the appendix is the only record of this round's
            // revisions, so what the parser reads back MUST be the notes the
            // reviewer submitted — same ids, same steps, same change text, same
            // finding ids, same order. A drift here would silently hand the
            // Planner a different instruction than the reviewer gave, so it is
            // refused BEFORE `deps.submit`: nothing is written and the error
            // names the first field/index that failed to survive.
            const drift = revisionRoundTripDrift(
                revisions,
                parseReviewNotes(planText).notes,
            );
            if (drift) {
                deps.log(
                    `Review submission refused — appendix round-trip drift: ${drift.split("\n")[0]}`,
                    "warning",
                );
                return {
                    content: [{ type: "text", text: drift }],
                    isError: true,
                };
            }

            const payload: ReviewSubmitPayload = {
                planBody: original,
                planText,
                findings,
                verdict,
                requiredChanges: revisions.length,
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
                            text: `review_submit: could not append the revisions — ${result.error ?? "unknown error"}`,
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
                            `review_submit: appended Reviewer Revisions (round ${round}) to ${result.path ?? targetPath}`,
                            `- verdict: ${verdict}`,
                            `- findings: ${findings.length}`,
                            `- revisions: ${revisions.length}`,
                            summary ? `- summary: ${summary}` : "",
                            convergedWithoutNotes
                                ? "No required changes — the Planner has nothing to revise; the host treats this round as converged."
                                : "",
                            "",
                            "The plan body was not modified. Now call review_pass_done.",
                        ]
                            .filter(Boolean)
                            .join("\n"),
                    },
                ],
                details: {
                    path: result.path ?? targetPath,
                    verdict,
                    findings: findings.length,
                    revisions: revisions.length,
                    round,
                },
            };
        },
    };
}

const REVIEW_ADVISORY_LINE =
    "_Review notes for the Planner. The plan body is authoritative once the Planner has revised it; unresolved notes are listed below._";

/** The appendix grammar's id form: `R<n>`, case-insensitive. */
const REVISION_ID = /^R(\d+)$/i;

/** Trailing `_(F1, F3)_` fragment `renderRequiredChanges` appends. */
const REVISION_FINDINGS_FRAGMENT = /_\([^()]*\)_[ \t]*$/;

/**
 * Canonicalise a supplied note id, or return undefined when it is not `R<n>`.
 *
 * Only `R<n>` (>= 1) survives: `R01` canonicalises to `R1`, while `RV1`, `F1`,
 * `1` and blanks return undefined. Deliberately strict — the appendix parser
 * reads `R<n>` only, so letting any other form through would render a bullet
 * the parser then drops, losing the note without telling anyone.
 */
function canonicalRevisionId(value: string): string | undefined {
    const match = REVISION_ID.exec(value.trim());
    if (!match) return undefined;
    const n = Number(match[1]);
    if (!Number.isInteger(n) || n < 1) return undefined;
    return `R${n}`;
}

/**
 * Why a `change` cannot survive the appendix round-trip, if it cannot.
 *
 * `renderRequiredChanges` writes one `- **R1:** <change> _(F1)_` bullet, and
 * `parseReviewNotes` reads it back with that exact grammar. A change that
 * fights it is refused here rather than rendered into a bullet that reads back
 * as a different note:
 *
 *   - a line break injects extra bullets / breaks the list,
 *   - a trailing `_(...) _` is stripped and re-read as `findingIds`,
 *   - a leading `**` is consumed as the bold id head.
 */
function revisionChangeProblem(change: string): string | undefined {
    if (/[\r\n]/.test(change)) return "it must be a single line";
    if (REVISION_FINDINGS_FRAGMENT.test(change))
        return "it must not end in a findings fragment such as _(F1)_; use findingIds instead";
    if (change.trimStart().startsWith("**"))
        return "it must not start with '**'";
    return undefined;
}

/**
 * The four fields a note must round-trip, in the order the appendix writes
 * them into one bullet: `id`, `step`, `change`, `findingIds`.
 */
const NOTE_FIELDS = ["id", "step", "change", "findingIds"] as const;

type NoteField = (typeof NOTE_FIELDS)[number];

/** One note normalised the way BOTH sides are compared. */
interface NoteShape {
    id: string;
    step?: string;
    change: string;
    findingIds?: string[];
}

/**
 * Normalise a note so absent optional fields are absent on both sides.
 *
 * `normalizeRevisions` drops blank `step`s and empty `findingIds` and so does
 * `parseReviewNotes`, so a note with neither must compare equal to a parsed
 * note with neither — `{}` is never compared with `{ step: undefined }`.
 */
function noteShape(note: ReviewRevision | ReviewNote): NoteShape {
    const shape: NoteShape = { id: note.id, change: note.change };
    if (note.step) shape.step = note.step;
    if (note.findingIds && note.findingIds.length > 0)
        shape.findingIds = [...note.findingIds];
    return shape;
}

function findingIdsEqual(a: string[] | undefined, b: string[] | undefined): boolean {
    if (!a || !b) return a === b;
    return a.length === b.length && a.every((value, index) => value === b[index]);
}

function fieldValue(shape: NoteShape, field: NoteField): unknown {
    return shape[field];
}

function describeField(value: unknown): string {
    return value === undefined ? "absent" : JSON.stringify(value);
}

/**
 * Why the rendered appendix does not read back as the submitted revisions.
 *
 * Compares the FULL note shape — `id`, `step`, `change`, `findingIds` — field by
 * field and in order, after normalising absent optionals on both sides. Returns
 * undefined when every note survives the round-trip unchanged, otherwise an
 * error text that names the first mismatching note index and field and shows
 * both sides so the reviewer can correct the submission. The caller refuses the
 * write on any result, so a drifting note can never reach the plan file.
 */
function revisionRoundTripDrift(
    expected: ReviewRevision[],
    parsed: ReviewNote[],
): string | undefined {
    const expectedShapes = expected.map(noteShape);
    const parsedShapes = parsed.map(noteShape);
    const problems: string[] = [];
    const total = Math.max(expectedShapes.length, parsedShapes.length);
    for (let index = 0; index < total; index++) {
        const want = expectedShapes[index];
        const got = parsedShapes[index];
        if (!want) {
            problems.push(
                `note ${index + 1} is an extra note the appendix invented: ${describeField(got)}`,
            );
            break;
        }
        if (!got) {
            problems.push(
                `note ${index + 1} (${want.id}) is missing from the appendix — work out why the bullet did not parse and resubmit it`,
            );
            break;
        }
        let mismatch = false;
        for (const field of NOTE_FIELDS) {
            const equal =
                field === "findingIds"
                    ? findingIdsEqual(want.findingIds, got.findingIds)
                    : fieldValue(want, field) === fieldValue(got, field);
            if (equal) continue;
            problems.push(
                `note ${index + 1} \`${field}\` reads back as ${describeField(
                    fieldValue(got, field),
                )} but the submission says ${describeField(fieldValue(want, field))}`,
            );
            mismatch = true;
            break;
        }
        if (mismatch) break;
    }
    if (problems.length === 0) return undefined;
    const render = (shapes: NoteShape[]): string =>
        shapes.length === 0 ? "[]" : JSON.stringify(shapes, null, 0);
    return [
        `review_submit: the revision appendix does not round-trip — ${problems[0]}.`,
        `Nothing was written: the appendix must read back exactly as submitted, because that is what the Planner revises from.`,
        `expected: ${render(expectedShapes)}`,
        `parsed:   ${render(parsedShapes)}`,
        "Resubmit the revisions so each note survives the one-bullet grammar (single-line change, no leading '**', no trailing _(F…)_ fragment; use findingIds).",
    ].join("\n");
}

interface NormalizedRevisions {
    revisions: ReviewRevision[];
    /** Refusal text naming the offending ids/`change`s; absent when valid. */
    error?: string;
}

/**
 * Normalise the model's revisions and validate them against the appendix
 * grammar, so the model can neither produce an id-less note nor an id/`change`
 * the parser cannot read back.
 *
 * Ids: `R<n>` only (canonicalised, so `R01` becomes `R1`), assignments `R1..Rn`
 * in submission order when an id is omitted, and a refusal for any other
 * supplied form, a duplicate supplied id, or an assigned id that collides with
 * a supplied one. Numbering restarts per round, so a restated note may reuse its
 * previous id — ids are per-round, not global.
 *
 * Entries without a change are still dropped silently (the model may leave an
 * optional slot empty); everything that survives is either valid or refused.
 */
function normalizeRevisions(raw: unknown): NormalizedRevisions {
    if (!Array.isArray(raw)) return { revisions: [] };
    const kept: Array<{
        suppliedId?: string;
        /** A supplied but unusable id (blank or non-string), echoed in errors. */
        badId?: string;
        step?: string;
        change: string;
        findingIds?: string[];
    }> = [];
    for (const entry of raw) {
        if (!entry || typeof entry !== "object") continue;
        const record = entry as {
            id?: unknown;
            step?: unknown;
            change?: unknown;
            findingIds?: unknown;
        };
        const change =
            typeof record.change === "string" ? record.change.trim() : "";
        if (!change) continue;
        const slot: (typeof kept)[number] = { change };
        // Present-but-unusable ids are rejected, not silently reassigned: a
        // blank or non-string id is still the model claiming an id.
        if (record.id !== undefined && record.id !== null) {
            if (typeof record.id !== "string") {
                slot.badId = JSON.stringify(record.id) ?? String(record.id);
            } else {
                slot.suppliedId = record.id.trim();
            }
        }
        if (typeof record.step === "string" && record.step.trim()) {
            slot.step = record.step.trim();
        }
        if (Array.isArray(record.findingIds)) {
            const findingIds = record.findingIds
                .filter((value): value is string => typeof value === "string")
                .map((value) => value.trim())
                .filter(Boolean);
            if (findingIds.length > 0) slot.findingIds = findingIds;
        }
        kept.push(slot);
    }

    // Pass 1: every supplied id must be `R<n>` and unique after canonicalising.
    const supplied = new Map<string, number>();
    const invalid: string[] = [];
    const duplicates: string[] = [];
    for (const [index, slot] of kept.entries()) {
        if (slot.badId !== undefined) {
            invalid.push(`revision ${index + 1} has id ${slot.badId}`);
            continue;
        }
        if (slot.suppliedId === undefined) continue;
        const canonical = canonicalRevisionId(slot.suppliedId);
        if (!canonical) {
            invalid.push(`revision ${index + 1} has id ${JSON.stringify(slot.suppliedId)}`);
            continue;
        }
        const seen = supplied.get(canonical);
        if (seen !== undefined) {
            duplicates.push(
                `duplicate revision ids: ${canonical} (revisions ${seen + 1} and ${index + 1})`,
            );
            continue;
        }
        supplied.set(canonical, index);
    }
    if (invalid.length > 0) {
        return {
            revisions: [],
            error: `review_submit: revisions ids must be R<n> (for example R1) — ${invalid.join(
                "; ",
            )}. Forms such as RV1, F1, 1 or blank are rejected; omit the id and the harness assigns R1..Rn in submission order.`,
        };
    }
    if (duplicates.length > 0) {
        return {
            revisions: [],
            error: `review_submit: ${duplicates.join(
                "; ",
            )} — each revision needs its own id. Numbering restarts at R1 every round, so reusing a previous round's id is fine but two notes in one submission may not share one.`,
        };
    }

    // Pass 2: assign the omitted ids in submission order and validate `change`.
    const revisions: ReviewRevision[] = [];
    const collisions: string[] = [];
    const changeProblems: string[] = [];
    for (const [index, slot] of kept.entries()) {
        const id = slot.suppliedId
            ? (canonicalRevisionId(slot.suppliedId) as string)
            : `R${index + 1}`;
        if (!slot.suppliedId && supplied.has(id)) {
            collisions.push(
                `revision ${index + 1} was assigned ${id}, which a supplied id already uses`,
            );
            continue;
        }
        const problem = revisionChangeProblem(slot.change);
        if (problem) {
            changeProblems.push(`revision ${id} has an unusable change — ${problem}`);
            continue;
        }
        const revision: ReviewRevision = { id, change: slot.change };
        if (slot.step) revision.step = slot.step;
        if (slot.findingIds) revision.findingIds = slot.findingIds;
        revisions.push(revision);
    }
    if (collisions.length > 0) {
        return {
            revisions: [],
            error: `review_submit: inconsistent revision ids — ${collisions.join(
                "; ",
            )}. Omit an id only to receive the next free R<n>, or supply the ids you want.`,
        };
    }
    if (changeProblems.length > 0) {
        return {
            revisions: [],
            error: `review_submit: the \`change\` field must survive the appendix round-trip — ${changeProblems.join(
                "; ",
            )}. One single-line bullet per revision, no leading '**' and no trailing _(F…)_ fragment (use findingIds).`,
        };
    }
    return { revisions };
}

function renderReviewerRevisions(
    findings: ReviewFinding[],
    meta: {
        modelLabel?: string;
        verdict: ReviewVerdict;
        summary: string;
        revisions: ReviewRevision[];
        round: number;
    },
): string {
    const body = renderReviewChangelog(findings, {
        ...(meta.modelLabel ? { modelLabel: meta.modelLabel } : {}),
        verdict: meta.verdict,
    });
    const lines = [
        `## Reviewer Revisions (round ${meta.round})`,
        REVIEW_ADVISORY_LINE,
        "",
        meta.modelLabel ? `Reviewer: \`${meta.modelLabel}\`` : "",
        `Verdict: **${meta.verdict}**`,
        meta.summary ? `Summary: ${meta.summary}` : "",
        "",
    ].filter(Boolean);
    const required = renderRequiredChanges(meta.revisions);
    if (required) lines.push(required, "");
    lines.push(body.trimEnd());
    return lines.join("\n").trimEnd();
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
            "End the current review pass with your verdict and findings. Call this AFTER review_submit — a pass that submits nothing is rejected. Pass 1 completes the review; if the harness schedules a verification pass, it will prompt you for pass 2 next.",
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
                                "review_pass_done: REFUSED — you have not submitted findings this pass.",
                                "",
                                "Your review only reaches the user through `review_submit`.",
                                "Submit your findings and required revisions (unchanged is fine if",
                                "the plan is sound), then call review_pass_done again.",
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
                            ? "review_pass_done: pass 1 recorded. A verification pass is scheduled — wait for the harness to prompt you, then confirm the required revisions still address each finding without contradicting the approved plan body."
                            : `review_pass_done: pass ${pass} recorded (${verdict}, ${findings.length} finding${findings.length === 1 ? "" : "s"}). Your review is complete.`,
                    },
                ],
                details: { pass, verdict, findings: findings.length },
            };
        },
    };
}

interface ReviewerReadGuard {
    root: string;
    config: FolderPolicyConfig;
    /** Explicit grants that can re-open an excluded subtree. */
    grants: readonly string[];
}

function reviewerReadGuard(
    cwd: string,
    parent?: { config: FolderPolicyConfig; grants: readonly string[] },
): ReviewerReadGuard {
    return createInspectionAuthority(cwd, parent);
}

function redactReviewResult(
    result: ReviewToolTextResult,
    tool: string,
    input: Record<string, unknown>,
    cwd: string,
    config: FolderPolicyConfig,
): ReviewToolTextResult {
    let redacted = false;
    const content = (result.content ?? []).map((block) => {
        if (block?.type !== "text") return block;
        const next = redactSensitiveText(
            block.text,
            tool,
            input,
            cwd,
            config,
        );
        if (next.redacted) redacted = true;
        return next.redacted ? { ...block, text: next.text } : block;
    });
    if (!redacted) return result;
    return { ...result, content };
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

    // The reviewer session has NO ambient extensions, so its built-in
    // read/grep/find/ls are otherwise a complete bypass of the read gate.
    // Custom tools with those names override the built-ins.
    const guarded = createGuardedInspectionTools(sdk, {
        cwd: deps.cwd,
        // The build-time snapshot is the ceiling; the resolver is re-read for
        // every inspection and again before an async result is exposed.
        authority: () => resolveInspectionAuthority(
            () => createInspectionAuthority(deps.cwd, deps.folderPolicy?.()),
            deps.cwd,
        ),
        log: deps.log,
    });
    tools.push(...guarded.tools);
    unavailable.push(...guarded.unavailable);

    tools.push(createReviewExploreTool(deps.explore));
    tools.push(createReviewSubmitTool(deps.submit));
    tools.push(createReviewPassDoneTool(deps.passDone));

    return { tools, unavailable };
}

/** Re-exported so consumers can build ad-hoc schemas of the same flavour. */
export const ReviewSchema = Type;
