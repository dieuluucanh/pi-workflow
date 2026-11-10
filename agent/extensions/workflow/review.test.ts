/**
 * Workflow Extension — Review Mode tests
 *
 * Run with: npm test   (node --test, type-stripping — no build step)
 *
 * These cover the deterministic surface: config/prompt resolution, plan
 * hashing and the changelog, submission validation, context pruning, finding
 * sanitisation, the pass gate, and the "Review Mode off ⇒ nothing happens"
 * guarantee.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  appendReviewChangelog,
  buildPlanDiff,
  buildPlannerContextManifest,
  classifyReviewLanding,
  getUtcDatePrefix,
  planHash,
  pruneContextEntriesForReview,
  renderReviewChangelog,
  renderReviewContextBlock,
  REVIEW_CHANGELOG_HEADING,
  REVIEW_UNRESOLVED_HEADING,
  reviewFindingTier,
  reviewNeedsVerification,
  stripReviewAppendix,
  validateReviewedPlan,
  type ReviewFinding,
} from "./utils.ts";

import {
  DEFAULT_REVIEW_MODE_CONFIG,
  DEFAULT_REVIEW_PROMPT,
  applySubmittedPlan,
  buildReviewerAttempts,
  buildReviewerFallbacks,
  canRunManualReview,
  classifyReviewExecution,
  coerceReviewModeConfig,
  createReviewHandoffGate,
  createReviewRoundGate,
  createReviewState,
  createReviewSession,
  extractReviewModeRaw,
  isReviewEnabled,
  mergeReviewModeConfig,
  nextReviewRound,
  planHash as planHashReexported,
  readProviderErrorEvent,
  readReviewModeConfig,
  resolveReviewPrompt,
  reviewElapsedMs,
  reviewEscapeAction,
  reviewFooterSegment,
  reviewGatePhaseOnResume,
  reviewHandoffParks,
  reviewIsActive,
  reviewModeLockFooter,
  reviewModeLockKind,
  reviewModeLockNotice,
  reviewModeLockStatusLine,
  reviewNoticeText,
  reviewPauseIsCurrent,
  reviewPhaseLabel,
  reviewResumeGateOutcome,
  reviewResumeNotice,
  reviewResumePlanChoice,
  reviewResumeSettles,
  reviewStatusText,
  reviewStatusVisible,
  reviewRunLabel,
  sanitizeFindings,
  shouldPauseReviewOnEscape,
  shouldRouteInputToReviewer,
  reviewStateSummary,
  writeReviewModeConfig,
  writeReviewPrompt,
  ReviewTranscript,
  translateReviewEvent,
  formatActionLabel,
  formatReviewStatusLines,
  parseReviewTimeoutArg,
  timeoutSourceOf,
  truncateErrorText,
  type ReviewExecutionResult,
  type ReviewStatusInput,
  REVIEW_BUILTIN_TOOLS,
  reviewToolAllowlist,
  MAX_REVIEW_LINES,
} from "./review.ts";

import {
  createReviewBashTool,
  createReviewExploreTool,
  createReviewPassDoneTool,
  createReviewPlanBeginTool,
  createReviewPlanChunkTool,
  createReviewPlanFinalizeTool,
  createReviewSubmitPlanTool,
  createReviewTools,
  resolveBashToolDefinitionBuilder,
} from "./review-tools.ts";
import {
  buildPass1Prompt,
  buildPass2Prompt,
  createReviewRuntime,
} from "./review-runtime.ts";
import { isRecoverableProviderFailure } from "./review-recovery.ts";
import {
  appendProviderAuthHint,
  collectMissingChildProviders,
  findParentProviderSurface,
  seedChildRuntimeProviders,
} from "./review-providers.ts";
import {
  FAKE_BUILTIN_TOOLS,
  HIGH_FINDING,
  ORIGINAL_PLAN,
  REWRITTEN_PLAN,
  fakeSdk,
  submitThenFinish,
  submitThenFinishPass2,
  tmpProject,
  type FakeCapture,
} from "./test-support.ts";

// ── Fixtures ─────────────────────────────────────────────────────────

// ══ Step 2: configuration ═════════════════════════════════════════════

test("review config: defaults are safe (off, 1 round, verify on)", () => {
  const c = coerceReviewModeConfig(undefined);
  assert.equal(c.enabled, false, "must default to disabled");
  assert.equal(c.rounds, 1);
  assert.equal(c.passes, 2);
  assert.equal(c.verify, true);
  assert.equal(c.fallbackOnError, "skip");
  assert.equal(c.providerRecovery, "fallback");
  assert.equal(c.providerRetries, 1);
  assert.equal(c.chunkedSubmit, "auto");
  assert.equal(c.chunkChars, 6_000);
  assert.equal(c.recoveryBudgetMs, 0);
  assert.equal(c.timeoutMs, 300_000, "5-minute cap by default (step 10)");
  assert.deepEqual(c, { ...DEFAULT_REVIEW_MODE_CONFIG });
});

test("review config: clamps out-of-range numbers", () => {
  const c = coerceReviewModeConfig({
    rounds: 99,
    passes: 9,
    exploreBudget: 500,
    providerRetries: 9,
    chunkChars: 1,
    recoveryBudgetMs: -1,
    timeoutMs: -5,
  });
  assert.equal(c.rounds, 5);
  assert.equal(c.passes, 2);
  assert.equal(c.exploreBudget, 8);
  assert.equal(c.providerRetries, 2);
  assert.equal(c.chunkChars, 1_000);
  assert.equal(c.recoveryBudgetMs, 0);
  assert.equal(c.timeoutMs, 0, "below the minimum clamps to unlimited");
  const low = coerceReviewModeConfig({
    rounds: -3,
    providerRetries: -2,
    chunkChars: 1e9,
    recoveryBudgetMs: 1e9,
    timeoutMs: 1e12,
  });
  assert.equal(low.rounds, 1);
  assert.equal(low.providerRetries, 0);
  assert.equal(low.chunkChars, 20_000);
  assert.equal(low.recoveryBudgetMs, 3_600_000);
  assert.equal(low.timeoutMs, 3_600_000);
});

test("review config: boolean shorthand means {enabled}", () => {
  assert.equal(coerceReviewModeConfig(true).enabled, true);
  assert.equal(coerceReviewModeConfig(false).enabled, false);
  assert.equal(mergeReviewModeConfig(true, undefined).enabled, true);
});

test("review config: project overrides global field-by-field", () => {
  const merged = mergeReviewModeConfig(
    { enabled: true, rounds: 4, verify: false },
    { rounds: 2 },
  );
  assert.equal(merged.enabled, true, "unset project field keeps global");
  assert.equal(merged.rounds, 2, "project wins where set");
  assert.equal(merged.verify, false, "global kept where project silent");
});

test("review config: removed pane/parallel keys are ignored", () => {
  const c = coerceReviewModeConfig({
    enabled: true,
    parallel: false,
    autoOpenPane: false,
    paneEnabled: false,
    reserveRows: 12,
  });
  assert.equal(c.enabled, true);
  assert.equal(c.rounds, DEFAULT_REVIEW_MODE_CONFIG.rounds);
  assert.equal(c.fallbackOnError, "skip");
  assert.deepEqual(Object.keys(c).sort(), [
    "chunkChars",
    "chunkedSubmit",
    "contextChars",
    "contextEntries",
    "contextToolChars",
    "enabled",
    "exploreBudget",
    "fallbackOnError",
    "passes",
    "providerRecovery",
    "providerRetries",
    "recoveryBudgetMs",
    "rounds",
    "timeoutMs",
    "verify",
  ]);
});

test("review config: sanitizes the explicit fallback model", () => {
  const c = coerceReviewModeConfig({
    fallbackModel: {
      provider: " synthetic ",
      id: " hf:deepseek-ai/DeepSeek-V4.1-Flash ",
      thinking: " xhigh ",
    },
  });
  assert.deepEqual(c.fallbackModel, {
    provider: "synthetic",
    id: "hf:deepseek-ai/DeepSeek-V4.1-Flash",
    thinking: "xhigh",
  });
  assert.equal(
    coerceReviewModeConfig({ fallbackModel: { provider: "", id: "x" } }).fallbackModel,
    undefined,
  );
  assert.equal(
    coerceReviewModeConfig({ fallbackModel: { provider: "p", id: "m" } }).fallbackModel
      ?.thinking,
    "high",
  );
});

test("review config: recovery toggles accept only their documented values", () => {
  const c = coerceReviewModeConfig({
    providerRecovery: "off",
    chunkedSubmit: "off",
  });
  assert.equal(c.providerRecovery, "off");
  assert.equal(c.chunkedSubmit, "off");
  const junk = coerceReviewModeConfig({
    providerRecovery: "sometimes",
    chunkedSubmit: "always",
  });
  assert.equal(junk.providerRecovery, "fallback");
  assert.equal(junk.chunkedSubmit, "auto");
});

test("buildReviewerFallbacks: parent first, then base roles, clamped and deduped", () => {
  const clamped: string[] = [];
  const out = buildReviewerFallbacks({
    parentModel: { provider: "command-code", id: "deepseek", thinking: "max" },
    baseReviewer: { provider: "synthetic", id: "hf:x", thinking: "xhigh" },
    basePlanner: { provider: "synthetic", id: "hf:x", thinking: "high" },
    clampThinking: (model) => {
      clamped.push(`${model.provider}/${model.id}`);
      return model.thinking === "max" ? "high" : model.thinking;
    },
  });
  assert.deepEqual(out, [
    { provider: "command-code", id: "deepseek", thinking: "high" },
    { provider: "synthetic", id: "hf:x", thinking: "xhigh" },
  ]);
  assert.deepEqual(clamped, ["command-code/deepseek", "synthetic/hf:x"]);
  assert.deepEqual(
    buildReviewerFallbacks({
      parentModel: { provider: " ", id: "x", thinking: "high" },
    }),
    [],
  );
});

test("buildReviewerAttempts: base, explicit fallback, automatic fallbacks; dedupe and cap", () => {
  const out = buildReviewerAttempts({
    base: { provider: " command-code ", id: " deepseek ", thinking: " max " },
    explicitFallback: { provider: "opencode-go", id: "m", thinking: "high" },
    fallbacks: [
      { provider: "command-code", id: "deepseek", thinking: "high" },
      { provider: "synthetic", id: "hf:x", thinking: "xhigh" },
    ],
    max: 3,
  });
  assert.deepEqual(out, [
    { provider: "command-code", id: "deepseek", thinking: "max" },
    { provider: "opencode-go", id: "m", thinking: "high" },
    { provider: "synthetic", id: "hf:x", thinking: "xhigh" },
  ]);
  assert.deepEqual(
    buildReviewerAttempts({
      fallbacks: [
        { provider: "a", id: "1", thinking: "high" },
        { provider: "a", id: "1", thinking: "max" },
        { provider: "b", id: "2", thinking: "" },
      ],
      max: 2,
    }),
    [
      { provider: "a", id: "1", thinking: "high" },
      { provider: "b", id: "2", thinking: "high" },
    ],
  );
});

test("review recovery: uses the SDK's transient table and rejects deterministic failures", () => {
  for (const message of [
    "Stream ended without finish_reason",
    "429 Too Many Requests",
    "Request timed out",
    "socket hang up",
    "502 Bad Gateway",
  ]) {
    assert.equal(isRecoverableProviderFailure(message), true, message);
  }
  for (const message of [
    "",
    "Request was aborted",
    "No API key found for command-code.",
    "model not found in registry",
    "invalid_request_error",
    "context window exceeded",
    "prompt too long",
  ]) {
    assert.equal(isRecoverableProviderFailure(message), false, message);
  }
});

test("review config: extractReviewModeRaw handles junk", () => {
  assert.deepEqual(
    extractReviewModeRaw({ workflow: { reviewMode: true } }),
    true,
  );
  assert.deepEqual(
    extractReviewModeRaw({ workflow: { reviewMode: { rounds: 2 } } }),
    {
      rounds: 2,
    },
  );
  for (const junk of [
    null,
    undefined,
    42,
    "x",
    [],
    { workflow: 5 },
    { workflow: { reviewMode: [] } },
  ]) {
    assert.equal(extractReviewModeRaw(junk), undefined);
  }
});

test("review config: never throws on corrupt files, and DISABLED by default", () => {
  const { cwd, agentDir } = tmpProject();
  fs.writeFileSync(path.join(agentDir, "settings.json"), "{ not json", "utf8");
  const r = readReviewModeConfig(cwd, agentDir);
  assert.equal(r.config.enabled, false);
  assert.equal(isReviewEnabled(cwd, agentDir), false);
});

test("review config: write preserves unrelated settings keys", () => {
  const { cwd, agentDir } = tmpProject();
  const fp = path.join(agentDir, "settings.json");
  fs.writeFileSync(
    fp,
    JSON.stringify({ theme: "dark", packages: ["x"], workflow: { other: 1 } }),
    "utf8",
  );
  const res = writeReviewModeConfig("global", cwd, agentDir, {
    enabled: true,
    rounds: 3,
  });
  assert.equal(res.ok, true);
  const after = JSON.parse(fs.readFileSync(fp, "utf8"));
  assert.equal(after.theme, "dark");
  assert.deepEqual(after.packages, ["x"]);
  assert.equal(after.workflow.other, 1, "sibling workflow keys preserved");
  assert.equal(after.workflow.reviewMode.enabled, true);
  assert.equal(after.workflow.reviewMode.rounds, 3);
});

test("review config: timeout provenance is project > global > default", () => {
  assert.equal(timeoutSourceOf(undefined, undefined), "default");
  assert.equal(timeoutSourceOf({ rounds: 2 }, undefined), "default");
  assert.equal(
    timeoutSourceOf(true, undefined),
    "default",
    "boolean shorthand carries no fields",
  );
  assert.equal(timeoutSourceOf({ timeoutMs: 0 }, undefined), "global");
  assert.equal(timeoutSourceOf({ timeoutMs: 0 }, { verify: false }), "global");
  assert.equal(
    timeoutSourceOf({ timeoutMs: 0 }, { timeoutMs: 600000 }),
    "project",
  );

  const { cwd, agentDir } = tmpProject();
  writeReviewModeConfig("global", cwd, agentDir, { timeoutMs: 600000 });
  let r = readReviewModeConfig(cwd, agentDir);
  assert.equal(r.config.timeoutMs, 600000);
  assert.equal(r.sources.timeout, "global");
  assert.equal(r.sources.global, true);
  assert.equal(r.sources.project, false);

  writeReviewModeConfig("project", cwd, agentDir, { timeoutMs: 0 });
  r = readReviewModeConfig(cwd, agentDir);
  assert.equal(r.config.timeoutMs, 0);
  assert.equal(r.sources.timeout, "project");
  assert.equal(r.sources.project, true);
});

test("review config: a fragment without timeoutMs keeps the default cap", () => {
  assert.equal(DEFAULT_REVIEW_MODE_CONFIG.timeoutMs, 300_000);
  assert.equal(coerceReviewModeConfig({ enabled: true }).timeoutMs, 300_000);
  assert.equal(
    mergeReviewModeConfig({ rounds: 2 }, { verify: false }).timeoutMs,
    300_000,
  );
});

test("parseReviewTimeoutArg: unlimited/seconds accepted, junk rejected", () => {
  for (const [raw, ms] of [
    ["unlimited", 0],
    ["off", 0],
    ["none", 0],
    ["0", 0],
    [" 90 ", 90_000],
    ["600", 600_000],
    ["3600", 3_600_000],
  ] as const) {
    assert.deepEqual(
      parseReviewTimeoutArg(raw),
      { ok: true, timeoutMs: ms },
      raw,
    );
  }
  for (const bad of ["", "   ", "-1", "1.5", "3601", "abc", "1h", "1e3"]) {
    const parsed = parseReviewTimeoutArg(bad);
    assert.equal(parsed.ok, false, `${JSON.stringify(bad)} must be rejected`);
  }
});

const statusInput = (
  over: Partial<ReviewStatusInput> = {},
): ReviewStatusInput => ({
  enabled: true,
  config: { ...DEFAULT_REVIEW_MODE_CONFIG, timeoutMs: 0 },
  timeoutSource: "default",
  reviewer: { provider: "opencode-go", id: "glm-5.3-flash", thinking: "xhigh" },
  promptSource: "/agent/review-prompt.md",
  sources: { global: true, project: false },
  runtime: "not started",
  ...over,
});

test("formatReviewStatusLines: no flow row, timeout provenance, usage", () => {
  const text = formatReviewStatusLines(statusInput()).join("\n");
  assert.ok(!/flow|parallel/i.test(text), "no flow/parallel wording may survive");
  assert.ok(text.includes("reviewer model : opencode-go/glm-5.3-flash (xhigh)"));
  assert.ok(text.includes("timeout: unlimited (default)"));
  assert.ok(
    text.includes("recovery       : fallback (1 SDK retry/model; budget round deadline)"),
  );
  assert.ok(text.includes("chunked submit : auto (6000 chars/chunk)"));
  assert.ok(text.includes("runtime        : not started"));
  assert.ok(text.includes("/review-mode timeout <seconds|unlimited>"));
  assert.ok(!text.includes("cap set in"));

  const globalPinned = formatReviewStatusLines(
    statusInput({
      timeoutSource: "global",
      config: { ...DEFAULT_REVIEW_MODE_CONFIG, timeoutMs: 600_000 },
    }),
  ).join("\n");
  assert.ok(globalPinned.includes("timeout: 600s (global settings)"));
  assert.ok(globalPinned.includes("600s cap set in global settings"));

  const projectPinned = formatReviewStatusLines(
    statusInput({
      timeoutSource: "project",
      config: { ...DEFAULT_REVIEW_MODE_CONFIG, timeoutMs: 600_000 },
    }),
  ).join("\n");
  assert.ok(projectPinned.includes("timeout: 600s (project settings)"));
  assert.ok(projectPinned.includes("600s cap set in project settings"));

  const unconfigured = formatReviewStatusLines(
    statusInput({ enabled: false, reviewer: undefined }),
  ).join("\n");
  assert.ok(unconfigured.startsWith("Review Mode: disabled"));
  assert.ok(unconfigured.includes("unconfigured — /role set reviewer"));

  const explicit = formatReviewStatusLines(
    statusInput({
      config: {
        ...DEFAULT_REVIEW_MODE_CONFIG,
        providerRecovery: "fallback",
        providerRetries: 0,
        recoveryBudgetMs: 90_000,
        chunkedSubmit: "off",
        fallbackModel: { provider: "synthetic", id: "hf:model", thinking: "xhigh" },
      },
    }),
  ).join("\n");
  assert.ok(
    explicit.includes(
      "recovery       : fallback (0 SDK retry/model; budget 90s; explicit synthetic/hf:model (xhigh))",
    ),
  );
  assert.ok(explicit.includes("chunked submit : off"));
});

// ══ Step 3: reviewer prompt ═══════════════════════════════════════════

test("review prompt: project > global > default, blank files ignored", () => {
  const { cwd, agentDir } = tmpProject();
  assert.equal(resolveReviewPrompt(cwd, agentDir).source, "default");
  assert.match(DEFAULT_REVIEW_PROMPT, /existing project framework/);
  assert.match(DEFAULT_REVIEW_PROMPT, /industry best practice/);

  fs.writeFileSync(path.join(agentDir, "review-prompt.md"), "GLOBAL", "utf8");
  assert.equal(resolveReviewPrompt(cwd, agentDir).source, "global");

  fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
  fs.writeFileSync(
    path.join(cwd, ".pi", "review-prompt.md"),
    "PROJECT",
    "utf8",
  );
  assert.equal(resolveReviewPrompt(cwd, agentDir).source, "project");
  assert.equal(resolveReviewPrompt(cwd, agentDir).text, "PROJECT");

  fs.writeFileSync(
    path.join(cwd, ".pi", "review-prompt.md"),
    "   \n  ",
    "utf8",
  );
  assert.equal(resolveReviewPrompt(cwd, agentDir).source, "global");
});

test("review prompt: writeReviewPrompt round-trips", () => {
  const { cwd, agentDir } = tmpProject();
  const w = writeReviewPrompt("global", "CUSTOM GUIDANCE", cwd, agentDir);
  assert.equal(w.ok, true);
  assert.equal(
    resolveReviewPrompt(cwd, agentDir).text.trim(),
    "CUSTOM GUIDANCE",
  );
});

// ══ Step 4: pure plan/context helpers ═════════════════════════════════

test("planHash: ignores the review appendix, tracks the body", () => {
  const h = planHash(ORIGINAL_PLAN);
  const withLog = appendReviewChangelog(ORIGINAL_PLAN, "some changelog");
  assert.equal(planHash(withLog), h, "appendix must not change the hash");
  assert.notEqual(planHash(ORIGINAL_PLAN.replace("CSV", "TSV")), h);
  assert.equal(planHash(ORIGINAL_PLAN), planHash(ORIGINAL_PLAN), "stable");
  assert.match(h, /^[0-9a-f]{8}$/);
});

test("planHash is re-exported from review.ts", () => {
  assert.equal(planHashReexported("# x"), planHash("# x"));
});

test("appendReviewChangelog: idempotent and body-preserving", () => {
  const once = appendReviewChangelog(ORIGINAL_PLAN, "log text");
  const twice = appendReviewChangelog(once, "log text");
  assert.equal(twice, once, "re-appending must not duplicate the appendix");
  assert.ok(once.includes(REVIEW_CHANGELOG_HEADING));
  assert.equal(
    stripReviewAppendix(once).replace(/\s+$/, ""),
    ORIGINAL_PLAN.replace(/\s+$/, ""),
  );
});

test("stripReviewAppendix removes both appendix headings", () => {
  for (const heading of [REVIEW_CHANGELOG_HEADING, REVIEW_UNRESOLVED_HEADING]) {
    const text = `# Plan: x\n\nbody\n\n---\n\n${heading}\n\nstuff\n`;
    assert.ok(!stripReviewAppendix(text).includes(heading));
    assert.ok(stripReviewAppendix(text).includes("body"));
  }
  assert.equal(stripReviewAppendix(""), "");
  assert.equal(stripReviewAppendix("no appendix here"), "no appendix here");
});

test("renderReviewChangelog: tiers, dispositions and the empty case", () => {
  const findings: ReviewFinding[] = [
    { ...HIGH_FINDING, id: "F1" },
    {
      id: "F2",
      severity: 6,
      confidence: 70,
      category: "best-practice",
      summary: "No rollback path",
      rationale: "migration",
      disposition: "accepted",
    },
    {
      id: "F3",
      severity: 3,
      confidence: 55,
      category: "style",
      summary: "Naming",
      rationale: "house style",
      disposition: "rejected",
    },
    {
      id: "F4",
      severity: 7,
      confidence: 80,
      category: "scope",
      summary: "Out of scope",
      rationale: "needs a decision",
      disposition: "deferred",
    },
  ];
  const md = renderReviewChangelog(findings, {
    modelLabel: "opencode-go/muse-spark",
    verdict: "revise",
  });
  assert.ok(md.includes("Critical"), "severity 9/85 is Critical");
  assert.ok(md.includes("Important"), "severity 6/70 is Important");
  assert.ok(md.includes("Deferred"));
  assert.ok(md.includes("Rejected by the reviewer"));
  assert.ok(md.includes("src/export/csv.ts:1"), "file:line anchor rendered");
  assert.ok(md.includes("muse-spark") && md.includes("revise"));
  assert.equal(
    renderReviewChangelog([]),
    "No findings — the plan was submitted unchanged.",
  );
});

test("reviewFindingTier thresholds and verify trigger", () => {
  assert.equal(reviewFindingTier({ severity: 9, confidence: 80 }), "Critical");
  assert.equal(reviewFindingTier({ severity: 6, confidence: 65 }), "Important");
  assert.equal(reviewFindingTier({ severity: 3, confidence: 55 }), "Minor");
  assert.equal(reviewFindingTier({ severity: 2, confidence: 99 }), "Info");
  assert.equal(
    reviewFindingTier({ severity: 9, confidence: 10 }),
    "Info",
    "high severity with no confidence is not Critical",
  );
  assert.equal(reviewNeedsVerification([{ ...HIGH_FINDING }]), true);
  assert.equal(
    reviewNeedsVerification([{ ...HIGH_FINDING, severity: 3, confidence: 40 }]),
    false,
  );
  assert.equal(reviewNeedsVerification([]), false);
});

test("validateReviewedPlan: catches stubs and heading-less blobs, allows real edits", () => {
  assert.equal(validateReviewedPlan(REWRITTEN_PLAN, ORIGINAL_PLAN).length, 0);
  assert.ok(validateReviewedPlan("", ORIGINAL_PLAN).length > 0);
  assert.ok(validateReviewedPlan("# Plan\n\ntiny", ORIGINAL_PLAN).length > 0);
  assert.ok(
    validateReviewedPlan("x".repeat(ORIGINAL_PLAN.length + 50), ORIGINAL_PLAN)
      .length > 0,
    "no markdown heading",
  );
  assert.ok(
    validateReviewedPlan(ORIGINAL_PLAN.repeat(5), ORIGINAL_PLAN).length > 0,
    "wholesale substitution (too long)",
  );
  // Legitimate simplification must NOT be rejected: "simplicity" is a review
  // criterion. This removes a step and the optional sections (~40% shorter),
  // which is a real condensation — not the sub-25% stub the guard targets.
  const condensed = [
    "# Plan: CSV export",
    "",
    "## Plan Steps",
    "",
    "1. Add a CSV serializer in src/export/csv.ts",
    "2. Add tests under tests/export/",
  ].join("\n");
  assert.equal(validateReviewedPlan(condensed, ORIGINAL_PLAN).length, 0);
});

test("pruneContextEntriesForReview: drops workflow context, elides, stops at the plan write", () => {
  const entries = [
    { type: "message", message: { role: "user", content: "write me a plan" } },
    {
      type: "custom_message",
      customType: "workflow-plan-context",
      content: "[PLAN MODE ACTIVE]",
    },
    // A large tool result BEFORE the plan write must be elided.
    {
      type: "message",
      message: {
        role: "toolResult",
        toolName: "read",
        content: [{ type: "text", text: "Z".repeat(9000) }],
        isError: false,
      },
    },
    {
      type: "message",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "working" },
          {
            type: "toolCall",
            id: "c1",
            name: "write",
            arguments: { path: ".pi/plans/2026-09-18-x.md" },
          },
        ],
      },
    },
    // Anything after the plan write is not part of the plan under review.
    {
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "POST-PLAN NOISE" }],
      },
    },
  ];
  const pruned = pruneContextEntriesForReview(entries, {
    maxToolResultChars: 1000,
  });
  const text = JSON.stringify(pruned);
  assert.ok(!text.includes("PLAN MODE ACTIVE"), "workflow context dropped");
  assert.ok(text.includes("chars elided"), "oversized tool result elided");
  assert.ok(!text.includes("POST-PLAN NOISE"), "stops at the plan-file write");
  assert.ok(
    text.includes(".pi/plans/2026-09-18-x.md"),
    "keeps the plan write itself",
  );
  assert.deepEqual(pruneContextEntriesForReview(null), []);
  assert.deepEqual(pruneContextEntriesForReview(undefined), []);
});

test("pruneContextEntriesForReview: honours maxEntries, keeps newest", () => {
  const entries = Array.from({ length: 50 }, (_, i) => ({
    type: "message",
    message: { role: "user", content: `m${i}` },
  }));
  const pruned = pruneContextEntriesForReview(entries, { maxEntries: 5 });
  assert.equal(pruned.length, 5);
  assert.ok(JSON.stringify(pruned).includes("m49"));
  assert.ok(!JSON.stringify(pruned).includes('m0"'));
});

test("renderReviewContextBlock: renders a readable transcript", () => {
  const block = renderReviewContextBlock([
    { type: "message", message: { role: "user", content: "add CSV export" } },
    {
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "planned" }, { type: "image" }],
      },
    },
    {
      type: "message",
      message: {
        role: "toolResult",
        toolName: "read",
        content: [{ type: "text", text: "file body" }],
      },
    },
  ]);
  assert.ok(block.includes("### User") && block.includes("add CSV export"));
  assert.ok(block.includes("### Plan Mode") && block.includes("[image]"));
  assert.ok(block.includes("### Tool result (read)"));
  assert.equal(renderReviewContextBlock([]), "");
  assert.equal(renderReviewContextBlock(null), "");
});

test("renderReviewContextBlock: caps total size", () => {
  const big = Array.from({ length: 40 }, (_, i) => ({
    type: "message",
    message: { role: "user", content: `line${i} `.repeat(200) },
  }));
  const block = renderReviewContextBlock(big, { maxChars: 2000 });
  assert.ok(block.length < 3000);
  assert.ok(block.includes("context truncated"));
});

// ══ Step 5: state + findings sanitisation ═════════════════════════════

test("sanitizeFindings: clamps ranges, drops junk, defaults disposition", () => {
  const out = sanitizeFindings([
    {
      severity: 99,
      confidence: 500,
      category: "x",
      summary: "real",
      rationale: "r",
      disposition: "bogus",
    },
    { severity: 5, confidence: 50, category: "x", rationale: "no summary" },
    "junk",
    null,
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].severity, 10);
  assert.equal(out[0].confidence, 100);
  assert.equal(out[0].disposition, "accepted");
  assert.equal(sanitizeFindings("nope").length, 0);
  assert.equal(
    sanitizeFindings([{ summary: "a" }], { defaultDisposition: "deferred" })[0]
      .disposition,
    "deferred",
  );
  assert.equal(
    sanitizeFindings(
      Array.from({ length: 100 }, (_, i) => ({ summary: `s${i}` })),
    ).length,
    50,
  );
});

test("review state: creation, summary, phase helpers", () => {
  const s = createReviewState({
    planHash: "abc12345",
    modelLabel: "m/x",
    now: 1000,
  });
  assert.equal(s.phase, "idle");
  assert.equal(s.round, 1);
  assert.equal(s.pass, 1);
  assert.deepEqual(s.findings, []);

  s.phase = "verifying";
  s.pass = 2;
  s.findings = [HIGH_FINDING];
  assert.match(reviewStateSummary(s), /verifying/);
  assert.match(reviewStateSummary(s), /1 finding/);
  assert.equal(reviewStateSummary(undefined), "");
  assert.equal(reviewIsActive("verifying"), true);
  assert.equal(reviewIsActive("done"), false);
  assert.equal(reviewIsActive("idle"), false);
  assert.equal(reviewPhaseLabel("exploring"), "exploring");
  s.finishedAt = 1000 + 4200;
  assert.equal(reviewElapsedMs(s, 9_999_999), 4200);
});

test("shouldRouteInputToReviewer: only a live round with an allowed gate takes the prompt", () => {
  // [enabled, active, session, manualSessionActive, expected]. The gate is
  // allowed when the persisted flag is on OR a live ad-hoc session exists.
  const cases: Array<[boolean, boolean, boolean, boolean | undefined, boolean]> = [
    [true, true, true, undefined, true],
    [true, true, false, undefined, false],
    [true, false, true, undefined, false],
    [false, true, true, undefined, false],
    [false, false, false, undefined, false],
    // Ad-hoc session while the flag stays OFF.
    [false, true, true, true, true],
    [false, true, true, false, false],
    [false, false, true, true, false],
    [false, true, false, true, false],
    [true, true, true, true, true],
  ];
  for (const [
    reviewEnabled,
    reviewActive,
    hasReviewerSession,
    manualSessionActive,
    expected,
  ] of cases) {
    assert.equal(
      shouldRouteInputToReviewer({
        reviewEnabled,
        reviewActive,
        hasReviewerSession,
        manualSessionActive,
      }),
      expected,
      `enabled=${reviewEnabled} active=${reviewActive} session=${hasReviewerSession} manual=${manualSessionActive}`,
    );
  }
});

test("REGRESSION: with Review Mode off and no ad-hoc session, input routing is inert", () => {
  for (const reviewActive of [true, false]) {
    for (const hasReviewerSession of [true, false]) {
      for (const manualSessionActive of [undefined, false]) {
        assert.equal(
          shouldRouteInputToReviewer({
            reviewEnabled: false,
            reviewActive,
            hasReviewerSession,
            manualSessionActive,
          }),
          false,
        );
      }
    }
  }
});

test("GATING: manual review stays available while automatic review is off", () => {
  const { cwd, agentDir } = tmpProject();
  // No settings file at all: manual still available (defaults apply).
  assert.equal(canRunManualReview(cwd, agentDir), true);
  assert.equal(isReviewEnabled(cwd, agentDir), false);
  // Explicitly disabled: automatic off, manual still available.
  writeReviewModeConfig("global", cwd, agentDir, { enabled: false });
  assert.equal(isReviewEnabled(cwd, agentDir), false);
  assert.equal(canRunManualReview(cwd, agentDir), true);
  // Enabled: both available.
  writeReviewModeConfig("global", cwd, agentDir, { enabled: true });
  assert.equal(isReviewEnabled(cwd, agentDir), true);
  assert.equal(canRunManualReview(cwd, agentDir), true);
});

// ══ Step 16: transcript ═══════════════════════════════════════════════

test("translateReviewEvent: drops prose/thinking, surfaces action headers", () => {
  // Prose and reasoning are deliberately not streamed to the main transcript.
  assert.deepEqual(
    translateReviewEvent({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "hi" },
    }),
    [],
  );
  assert.deepEqual(
    translateReviewEvent({
      type: "message_update",
      assistantMessageEvent: { type: "thinking_delta", delta: "hmm" },
    }),
    [],
  );
  assert.deepEqual(
    translateReviewEvent({
      type: "message_start",
      message: { role: "assistant" },
    }),
    [],
  );
  assert.equal(translateReviewEvent({ type: "queue_update" }).length, 0);
  assert.equal(translateReviewEvent({ type: "compaction_start" }).length, 0);

  const labels = new Map<string, string>();
  const start = translateReviewEvent(
    {
      type: "tool_execution_start",
      toolCallId: "c1",
      toolName: "read",
      args: { path: "src/app.ts" },
    },
    labels,
  );
  assert.deepEqual(start, [
    { op: "new", kind: "tool", text: "▸ read: src/app.ts" },
  ]);
  assert.equal(labels.get("c1"), "read: src/app.ts");

  const end = translateReviewEvent(
    {
      type: "tool_execution_end",
      toolCallId: "c1",
      toolName: "read",
      isError: false,
    },
    labels,
  );
  assert.deepEqual(end, [
    { op: "new", kind: "tool", text: "▸ read: src/app.ts ok" },
  ]);
  assert.equal(labels.has("c1"), false, "the label map entry is consumed");

  // An end event with an unknown toolCallId falls back to the tool name.
  const unknown = translateReviewEvent(
    {
      type: "tool_execution_end",
      toolCallId: "nope",
      toolName: "grep",
      isError: true,
    },
    labels,
  );
  assert.deepEqual(unknown, [
    { op: "new", kind: "tool", text: "▸ grep failed" },
  ]);
});

test("formatActionLabel: key argument, truncation, junk input", () => {
  assert.equal(
    formatActionLabel("read", { path: "src/app.ts" }),
    "read: src/app.ts",
  );
  assert.equal(
    formatActionLabel("review_bash", { command: "git log -5\nmore" }),
    "review_bash: git log -5",
  );
  assert.equal(
    formatActionLabel("grep", { pattern: "TODO", path: "src" }),
    "grep: TODO (src)",
  );
  assert.equal(
    formatActionLabel("review_submit_plan", { verdict: "approve", findings: [] }),
    "review_submit_plan: verdict approve · 0 findings",
  );
  assert.equal(
    formatActionLabel("review_pass_done", { pass: 2, verdict: "revise" }),
    "review_pass_done: pass 2 · verdict revise",
  );
  assert.equal(
    formatActionLabel("review_explore", {
      tasks: [{ task: "check X" }, { task: "check Y" }],
    }),
    "review_explore: 2 tasks — check X",
  );
  assert.equal(formatActionLabel("read", {}), "read");
  assert.equal(formatActionLabel(undefined, undefined), "tool");
  assert.equal(formatActionLabel(42, null), "tool");
  const long = formatActionLabel("review_bash", { command: "x".repeat(500) });
  assert.ok(long.length <= 100, `label is truncated (${long.length})`);
  assert.ok(long.endsWith("…"));
});

test("translateReviewEvent: never throws on malformed events", () => {
  for (const junk of [
    null,
    undefined,
    42,
    "x",
    {},
    { type: 42 },
    { type: "message_update" },
    { type: "agent_end", messages: "nope" },
    { type: "agent_end", messages: [null, 42, "x"] },
    { type: "auto_retry_start", attempt: "two" },
    { type: "auto_retry_end", success: "false" },
  ]) {
    assert.doesNotThrow(() => translateReviewEvent(junk));
  }
});

 test("truncateErrorText: one line, bounded, junk-safe", () => {
  assert.equal(
    truncateErrorText(
      "No API key found for synthetic.\nUse /login (see docs/providers.md)",
    ),
    "No API key found for synthetic. Use /login (see docs/providers.md)",
  );
  const long = truncateErrorText("x".repeat(200));
  assert.equal(long.length, 160, "bounded to MAX_ERROR_TEXT");
  assert.ok(long.endsWith("…"));
  assert.equal(truncateErrorText("   \n\t "), "");
  assert.equal(truncateErrorText(undefined), "");
  assert.equal(truncateErrorText({ boom: true }), "");
  assert.equal(truncateErrorText("abcdefghij", 5), "abcd…");
});

 test("translateReviewEvent: provider failures surface their real, truncated text", () => {
  assert.deepEqual(
    translateReviewEvent({
      type: "auto_retry_start",
      attempt: 2,
      maxAttempts: 3,
      delayMs: 1000,
      errorMessage: "No API key for synthetic.\nUse /login.",
    }),
    [
      {
        op: "new",
        kind: "notice",
        text: "retrying after a provider error: No API key for synthetic. Use /login.",
      },
    ],
  );
  // No message on the event → the legacy plain notice (backward compatible).
  assert.deepEqual(translateReviewEvent({ type: "auto_retry_start", attempt: 1 }), [
    { op: "new", kind: "notice", text: "retrying after a provider error" },
  ]);
  assert.deepEqual(
    translateReviewEvent({
      type: "auto_retry_end",
      success: false,
      attempt: 3,
      finalError: "429 quota exceeded",
    }),
    [
      {
        op: "new",
        kind: "error",
        text: "reviewer retry budget exhausted: 429 quota exceeded",
      },
    ],
  );
  // A retry that recovered stays silent; the earlier notice covered it.
  assert.deepEqual(
    translateReviewEvent({ type: "auto_retry_end", success: true, attempt: 1 }),
    [],
  );
  assert.deepEqual(
    translateReviewEvent({
      type: "agent_end",
      messages: [
        { role: "user", content: "x" },
        {
          role: "assistant",
          content: [],
          stopReason: "error",
          errorMessage: "503 upstream",
        },
      ],
    }),
    [
      { op: "new", kind: "status", text: "reviewer run ended" },
      {
        op: "new",
        kind: "error",
        text: "reviewer run ended on a provider error: 503 upstream",
      },
    ],
  );
  assert.deepEqual(
    translateReviewEvent({
      type: "agent_end",
      messages: [{ role: "assistant", content: [], stopReason: "stop" }],
    }),
    [{ op: "new", kind: "status", text: "reviewer run ended" }],
  );
  // Run-start lines are the runtime's job (`reviewRunLabel`): `agent_start`
  // fires for every prompt on the same child session, so it cannot tell a cold
  // boot from a warm resume or a next round.
  assert.deepEqual(translateReviewEvent({ type: "agent_start" }), []);
});

 test("readProviderErrorEvent: decodes retry/exhaust/stop, junk-safe", () => {
  assert.deepEqual(
    readProviderErrorEvent({
      type: "auto_retry_start",
      attempt: 2,
      errorMessage: "503",
    }),
    { kind: "retry", message: "503", retries: 2 },
  );
  assert.equal(
    readProviderErrorEvent({ type: "auto_retry_start", attempt: 1 }).kind,
    "none",
    "a bare retry without a message carries nothing to record",
  );
  assert.deepEqual(
    readProviderErrorEvent({
      type: "auto_retry_end",
      success: false,
      attempt: 3,
      finalError: "429 quota",
    }),
    { kind: "exhaust", message: "429 quota", retries: 3 },
  );
  assert.equal(
    readProviderErrorEvent({ type: "auto_retry_end", success: true }).kind,
    "none",
    "a recovered retry is not a failure",
  );
  assert.deepEqual(
    readProviderErrorEvent({
      type: "agent_end",
      messages: [{ role: "assistant", stopReason: "error", errorMessage: "boom" }],
    }),
    { kind: "stop", message: "boom" },
  );
  assert.equal(
    readProviderErrorEvent({
      type: "agent_end",
      messages: [{ role: "assistant", stopReason: "stop" }],
    }).kind,
    "none",
  );
  assert.equal(readProviderErrorEvent(null).kind, "none");
  assert.equal(readProviderErrorEvent("x").kind, "none");
});

test("ReviewTranscript: buffers action headers, bounds and clears", () => {
  const t = new ReviewTranscript(10);
  for (const d of ["Hello", " ", "world"]) {
    assert.deepEqual(
      t.ingest({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: d },
      }),
      [],
    );
  }
  assert.equal(t.size, 0, "prose never reaches the buffer");

  t.ingest({
    type: "tool_execution_start",
    toolCallId: "a",
    toolName: "read",
    args: { path: "a.ts" },
  });
  t.ingest({
    type: "tool_execution_start",
    toolCallId: "b",
    toolName: "ls",
    args: { path: "src" },
  });
  assert.equal(t.size, 2, "each start is its own header line");
  assert.deepEqual(t.toDisplayLines(), ["▸ read: a.ts", "▸ ls: src"]);

  const coalesced = new ReviewTranscript(10);
  coalesced.apply({ op: "append", kind: "tool", text: "▸ one" });
  coalesced.apply({ op: "append", kind: "tool", text: " + two" });
  assert.equal(coalesced.size, 1, "same-kind appends coalesce");
  assert.equal(coalesced.toLines()[0].text, "▸ one + two");

  const bounded = new ReviewTranscript(5);
  for (let i = 0; i < 20; i++) {
    bounded.ingest({ type: "tool_execution_start", toolName: `t${i}` });
  }
  assert.equal(bounded.size, 5);
  assert.ok(bounded.toDisplayLines()[4].includes("t19"), "keeps newest");
  bounded.clear();
  assert.equal(bounded.size, 0);

  const orphan = new ReviewTranscript(5);
  orphan.apply({ op: "append", kind: "text", text: "no tail" });
  assert.equal(
    orphan.toLines()[0].text,
    "no tail",
    "orphan append is not lost",
  );
});

test("ReviewTranscript: default cap is bounded", () => {
  assert.equal(MAX_REVIEW_LINES, 2000);
  const t = new ReviewTranscript();
  for (let i = 0; i < 2100; i++) {
    t.ingest({ type: "tool_execution_start", toolName: `t${i}` });
  }
  assert.equal(t.size, MAX_REVIEW_LINES);
});

// ══ Steps 7-8: review_bash / review_explore ═══════════════════════════

function bashTool(ran: string[], logs: Array<[string, string]> = []) {
  return createReviewBashTool(
    () => ({
      parameters: { type: "object" },
      execute: async (_id: unknown, params: unknown) => {
        ran.push(String((params as { command?: string }).command ?? ""));
        return { content: [{ type: "text" as const, text: "ok" }] };
      },
    }),
    { cwd: "/p", log: (m, l) => logs.push([l ?? "info", m]) },
  );
}

test("review_bash: refuses every mutation vector, allows reads", async () => {
  const ran: string[] = [];
  const tool = bashTool(ran);
  const call = (command: string) =>
    tool.execute("id", { command }, undefined, undefined, {});

  assert.equal(tool.name, "review_bash", "distinct from the built-in bash");

  for (const bad of [
    "echo hi > out.txt",
    "echo hi >> out.txt",
    "rm -rf /tmp/x",
    "mv a b",
    "cp a b",
    "mkdir -p x",
    "touch x",
    "chmod 777 x",
    "sudo ls",
    "tee out.txt",
    "dd if=/dev/zero of=x",
    "npm install left-pad",
    "git commit -m x",
    "git push",
  ]) {
    const r = await call(bad);
    assert.equal(r.isError, true, `${bad} must be refused`);
    assert.ok(r.content[0].text.includes("REFUSED"));
  }
  assert.equal(ran.length, 0, "no refused command may reach the shell");

  for (const good of [
    "ls -la",
    "git log --oneline",
    "git diff HEAD",
    "rg TODO src",
    "cat package.json",
    "node --test",
  ]) {
    assert.equal((await call(good)).isError, undefined);
  }
  assert.equal(ran.length, 6);
});

test("review_bash: reports shell failures instead of throwing", async () => {
  const tool = createReviewBashTool(
    () => ({
      parameters: {},
      execute: async () => {
        throw new Error("shell exploded");
      },
    }),
    { cwd: "/p", log: () => {} },
  );
  const r = await tool.execute(
    "id",
    { command: "ls" },
    undefined,
    undefined,
    {},
  );
  assert.equal(r.isError, true);
  assert.ok(r.content[0].text.includes("shell exploded"));
  const empty = await tool.execute(
    "id",
    { command: "   " },
    undefined,
    undefined,
    {},
  );
  assert.equal(empty.isError, true);
});

test("review_explore: enforces the budget and isolates failures", async () => {
  const used: number[] = [];
  const mk = (budget: number, run?: (t: string) => Promise<string>) =>
    createReviewExploreTool({
      budget: () => budget,
      run: run ?? (async (t) => `findings for: ${t}`),
      onUsed: (n) => used.push(n),
      log: () => {},
    });
  const call = (tool: ReturnType<typeof mk>, tasks: Array<{ task: string }>) =>
    tool.execute("id", { tasks }, undefined, undefined, {});

  let tool = mk(3);
  let r = await call(tool, [{ task: "a" }, { task: "b" }]);
  assert.equal(r.isError, undefined);
  assert.deepEqual(used, [2]);

  tool = mk(3);
  r = await call(tool, [
    { task: "a" },
    { task: "b" },
    { task: "c" },
    { task: "d" },
  ]);
  assert.equal((r.details as { tasks: number }).tasks, 3, "sliced to budget");
  assert.ok(r.content[0].text.includes("further task"));

  tool = mk(2);
  await call(tool, [{ task: "a" }, { task: "b" }]);
  r = await call(tool, [{ task: "c" }]);
  assert.equal(r.isError, true);
  assert.ok(r.content[0].text.includes("budget exhausted"));

  assert.equal((await call(mk(0), [{ task: "a" }])).isError, true);
  assert.equal((await call(mk(3), [])).isError, true);

  tool = mk(3, async (t) => {
    if (t === "boom") throw new Error("agent crashed");
    return `ok:${t}`;
  });
  r = await call(tool, [{ task: "boom" }, { task: "fine" }]);
  assert.equal(r.isError, undefined, "one failure must not fail the tool");
  assert.ok(r.content[0].text.includes("FAILED: agent crashed"));
  assert.ok(r.content[0].text.includes("ok:fine"));
});

// ══ Steps 9-11: review_submit_plan ════════════════════════════════════

function submitTool(options: {
  planPath?: string | undefined;
  writes: Array<Record<string, unknown>>;
  submitFails?: string;
  throws?: boolean;
}) {
  return createReviewSubmitPlanTool({
    planPath: () => options.planPath,
    originalPlan: () => ORIGINAL_PLAN,
    modelLabel: () => "opencode-go/muse-spark",
    submit: async (payload) => {
      if (options.throws) throw new Error("disk gone");
      if (options.submitFails) return { ok: false, error: options.submitFails };
      options.writes.push(payload as unknown as Record<string, unknown>);
      return { ok: true, path: "/abs/plans/x.md" };
    },
    log: () => {},
  });
}

test("review_submit_plan: rejects stubs without writing", async () => {
  const writes: Array<Record<string, unknown>> = [];
  const tool = submitTool({ planPath: ".pi/plans/x.md", writes });
  const call = (params: Record<string, unknown>) =>
    tool.execute("id", params, undefined, undefined, {});

  let r = await call({
    planMarkdown: "# Plan\n\ntiny",
    findings: [],
    verdict: "approve",
    summary: "s",
  });
  assert.equal(r.isError, true);
  assert.ok(r.content[0].text.includes("REJECTED"));
  assert.equal(writes.length, 0, "nothing written on a rejected submission");

  r = await call({
    planMarkdown: "x".repeat(ORIGINAL_PLAN.length + 50),
    findings: [],
    verdict: "approve",
    summary: "s",
  });
  assert.equal(r.isError, true);
  r = await call({
    planMarkdown: "",
    findings: [],
    verdict: "approve",
    summary: "s",
  });
  assert.equal(r.isError, true);
  assert.equal(writes.length, 0);
});

test("review_submit_plan: refuses when no plan path is known", async () => {
  const tool = submitTool({ planPath: undefined, writes: [] });
  const r = await tool.execute(
    "id",
    {
      planMarkdown: REWRITTEN_PLAN,
      findings: [],
      verdict: "approve",
      summary: "s",
    },
    undefined,
    undefined,
    {},
  );
  assert.equal(r.isError, true);
  assert.ok(r.content[0].text.includes("no plan path"));
});

test("review_submit_plan: composes the changelog and appends it", async () => {
  const writes: Array<Record<string, unknown>> = [];
  const tool = submitTool({ planPath: ".pi/plans/x.md", writes });
  const r = await tool.execute(
    "id",
    {
      planMarkdown: REWRITTEN_PLAN,
      findings: [HIGH_FINDING],
      verdict: "revise",
      summary: "aligned",
    },
    undefined,
    undefined,
    {},
  );
  assert.equal(r.isError, undefined);
  assert.equal(writes.length, 1);
  const payload = writes[0] as {
    planText: string;
    changelog: string;
    planBody: string;
  };
  assert.ok(payload.changelog.includes("Addressed"));
  assert.ok(payload.planText.includes(REVIEW_CHANGELOG_HEADING));
  assert.ok(
    !payload.planBody.includes(REVIEW_CHANGELOG_HEADING),
    "reviewer must not author the appendix",
  );
  assert.equal(
    stripReviewAppendix(payload.planText).replace(/\s+$/, ""),
    REWRITTEN_PLAN.replace(/\s+$/, ""),
    "original body preserved byte-for-byte",
  );
  assert.ok(
    r.content[0].text.includes("review_pass_done"),
    "tells the reviewer to end the pass",
  );
});

test("review_submit_plan: surfaces write failures to the model", async () => {
  const fails = submitTool({
    planPath: "p.md",
    writes: [],
    submitFails: "EACCES",
  });
  let r = await fails.execute(
    "id",
    {
      planMarkdown: REWRITTEN_PLAN,
      findings: [],
      verdict: "approve",
      summary: "s",
    },
    undefined,
    undefined,
    {},
  );
  assert.equal(r.isError, true);
  assert.ok(r.content[0].text.includes("EACCES"));

  const throws = submitTool({ planPath: "p.md", writes: [], throws: true });
  r = await throws.execute(
    "id",
    {
      planMarkdown: REWRITTEN_PLAN,
      findings: [],
      verdict: "approve",
      summary: "s",
    },
    undefined,
    undefined,
    {},
  );
  assert.equal(r.isError, true);
  assert.ok(r.content[0].text.includes("disk gone"));
});

test("review_plan_begin/chunk: assemble ordered chunks and reject bad input", async () => {
  const begun: Array<number | undefined> = [];
  const chunks: Array<{ index: number; content: string }> = [];
  const deps = {
    planPath: () => ".pi/plans/x.md",
    originalPlan: () => ORIGINAL_PLAN,
    modelLabel: () => "m",
    submit: async () => ({ ok: true, path: "/x" }),
    beginPlan: (total?: number) => {
      begun.push(total);
      return { ok: true, maxChunkChars: 10 };
    },
    appendPlanChunk: (index: number, content: string) => {
      chunks.push({ index, content });
      return {
        ok: true,
        received: chunks.length,
        nextIndex: index + 1,
        totalChars: chunks.reduce((sum, chunk) => sum + chunk.content.length, 0),
      };
    },
    takeAssembledPlan: () => chunks.map((chunk) => chunk.content).join(""),
    resetPlan: () => {},
    maxChunkChars: 10,
    log: () => {},
  };

  const begin = createReviewPlanBeginTool(deps);
  const beginResult = await begin.execute("id", { totalChunks: 2 }, undefined, undefined, {});
  assert.equal(beginResult.isError, undefined);
  assert.match(beginResult.content[0].text, /max 10 characters/);
  assert.deepEqual(begun, [2]);

  const chunk = createReviewPlanChunkTool(deps);
  const accepted = await chunk.execute(
    "id",
    { index: 1, content: "0123456789" },
    undefined,
    undefined,
    {},
  );
  assert.equal(accepted.isError, undefined);
  assert.match(accepted.content[0].text, /Next expected index: 2/);

  for (const params of [
    { index: 0, content: "x" },
    { index: 2, content: "x".repeat(11) },
    { index: 2, content: "" },
  ]) {
    const rejected = await chunk.execute("id", params, undefined, undefined, {});
    assert.equal(rejected.isError, true, JSON.stringify(params));
  }
  assert.equal(chunks.length, 1);
});

test("review_submit_plan: finalises assembled chunks without planMarkdown", async () => {
  const writes: Array<Record<string, unknown>> = [];
  const chunks: string[] = [];
  let resets = 0;
  const deps = {
    planPath: () => ".pi/plans/x.md",
    originalPlan: () => ORIGINAL_PLAN,
    modelLabel: () => "m",
    submit: async (payload: unknown) => {
      writes.push(payload as Record<string, unknown>);
      return { ok: true, path: "/abs/plans/x.md" };
    },
    beginPlan: () => ({ ok: true, maxChunkChars: REWRITTEN_PLAN.length }),
    appendPlanChunk: (index: number, content: string) => {
      chunks.push(content);
      return { ok: true, received: chunks.length, nextIndex: index + 1 };
    },
    takeAssembledPlan: () => chunks.join(""),
    resetPlan: () => {
      resets += 1;
    },
    maxChunkChars: REWRITTEN_PLAN.length,
    log: () => {},
  };
  const chunk = createReviewPlanChunkTool(deps);
  await chunk.execute(
    "id",
    { index: 1, content: REWRITTEN_PLAN },
    undefined,
    undefined,
    {},
  );
  const submit = createReviewSubmitPlanTool(deps);
  const result = await submit.execute(
    "id",
    { findings: [HIGH_FINDING], verdict: "revise", summary: "chunked" },
    undefined,
    undefined,
    {},
  );
  assert.equal(result.isError, undefined);
  assert.equal(writes.length, 1);
  assert.ok(String(writes[0].planBody).includes("Result<string, ExportError>"));
  assert.equal(resets, 1, "the assembler is cleared after a successful submit");
});

test("review_submit_plan: no plan and no chunks is rejected", async () => {
  const tool = createReviewSubmitPlanTool({
    planPath: () => ".pi/plans/x.md",
    originalPlan: () => ORIGINAL_PLAN,
    modelLabel: () => "m",
    submit: async () => ({ ok: true }),
    takeAssembledPlan: () => undefined,
    log: () => {},
  });
  const result = await tool.execute(
    "id",
    { findings: [], verdict: "approve", summary: "s" },
    undefined,
    undefined,
    {},
  );
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /no plan was provided/);
});

test("review_plan_finalize: refuses an incomplete assembly, then writes once", async () => {
  const writes: Array<Record<string, unknown>> = [];
  const chunks: string[] = [];
  const deps = {
    planPath: () => ".pi/plans/x.md",
    originalPlan: () => ORIGINAL_PLAN,
    modelLabel: () => "m",
    submit: async (payload: unknown) => {
      writes.push(payload as Record<string, unknown>);
      return { ok: true, path: "/abs/plans/x.md" };
    },
    beginPlan: (totalChunks?: number) => ({ ok: true, totalChunks }),
    appendPlanChunk: (index: number, content: string) => {
      chunks.push(content);
      return { ok: true, received: chunks.length, nextIndex: index + 1 };
    },
    // Simulates the harness: the assembly is only complete once the model has
    // declared (and sent) both chunks.
    takeAssembledPlan: () => {
      const head = REWRITTEN_PLAN.slice(0, 60);
      const tail = REWRITTEN_PLAN.slice(60);
      return chunks.length >= 2 ? `${head}${tail}` : undefined;
    },
    resetPlan: () => {
      chunks.length = 0;
    },
    log: () => {},
  };
  const begin = createReviewPlanBeginTool(deps);
  await begin.execute("id", { totalChunks: 2 }, undefined, undefined, {});
  const chunk = createReviewPlanChunkTool(deps);
  await chunk.execute(
    "id",
    { index: 1, content: REWRITTEN_PLAN.slice(0, 60) },
    undefined,
    undefined,
    {},
  );

  const finalize = createReviewPlanFinalizeTool(deps);
  const early = await finalize.execute(
    "id",
    { findings: [], verdict: "approve", summary: "s" },
    undefined,
    undefined,
    {},
  );
  assert.equal(early.isError, true, "chunk 2 is missing");
  assert.equal(writes.length, 0, "nothing is written before finalize succeeds");

  const retry = await chunk.execute(
    "id",
    { index: 2, content: REWRITTEN_PLAN.slice(60) },
    undefined,
    undefined,
    {},
  );
  assert.equal(retry.isError, undefined);

  const done = await finalize.execute(
    "id",
    { findings: [HIGH_FINDING], verdict: "revise", summary: "chunked" },
    undefined,
    undefined,
    {},
  );
  assert.equal(done.isError, undefined);
  assert.equal(writes.length, 1, "finalize is the single write");
  assert.equal(
    String(writes[0].planBody),
    REWRITTEN_PLAN,
    "the assembled text is the plan body",
  );
  assert.equal(chunks.length, 0, "the assembler is cleared after the write");
});

test("review_plan_finalize: rejects out-of-order, duplicate and oversized chunks", async () => {
  const seen: number[] = [];
  let next = 1;
  const deps = {
    planPath: () => ".pi/plans/x.md",
    originalPlan: () => ORIGINAL_PLAN,
    modelLabel: () => "m",
    submit: async () => ({ ok: true }),
    beginPlan: () => {
      next = 1;
      seen.length = 0;
      return { ok: true };
    },
    appendPlanChunk: (index: number, content: string) => {
      if (index !== next) {
        return { ok: false, error: `expected chunk ${next}, got ${index}` };
      }
      if (content.length > 10) {
        return { ok: false, error: `chunk ${index} is too large` };
      }
      seen.push(index);
      next += 1;
      return { ok: true, received: seen.length, nextIndex: next };
    },
    takeAssembledPlan: () => (seen.length === 2 ? "abcdefghijkl" : undefined),
    maxChunkChars: 10,
    log: () => {},
  };
  const begin = createReviewPlanBeginTool(deps);
  await begin.execute("id", {}, undefined, undefined, {});
  const chunk = createReviewPlanChunkTool(deps);

  const skipped = await chunk.execute(
    "id",
    { index: 3, content: "x" },
    undefined,
    undefined,
    {},
  );
  assert.equal(skipped.isError, true);
  assert.match(skipped.content[0].text, /expected chunk 1/);

  assert.equal(
    (await chunk.execute("id", { index: 1, content: "12345" }, undefined, undefined, {})).isError,
    undefined,
  );
  const duplicate = await chunk.execute(
    "id",
    { index: 1, content: "again" },
    undefined,
    undefined,
    {},
  );
  assert.equal(duplicate.isError, true);
  assert.match(duplicate.content[0].text, /expected chunk 2/);

  const oversized = await chunk.execute(
    "id",
    { index: 2, content: "y".repeat(11) },
    undefined,
    undefined,
    {},
  );
  assert.equal(oversized.isError, true);
  assert.match(oversized.content[0].text, /limit is 10/);
  assert.deepEqual(seen, [1], "only the accepted chunk was appended");
});

test("review_plan_begin: resets an in-progress assembly intentionally", async () => {
  let chunks: string[] = [];
  const deps = {
    planPath: () => ".pi/plans/x.md",
    originalPlan: () => ORIGINAL_PLAN,
    modelLabel: () => "m",
    submit: async () => ({ ok: true }),
    beginPlan: () => {
      chunks = [];
      return { ok: true };
    },
    appendPlanChunk: (index: number, content: string) => {
      chunks.push(content);
      return { ok: true, received: chunks.length, nextIndex: index + 1 };
    },
    takeAssembledPlan: () => (chunks.length === 0 ? undefined : chunks.join("")),
    log: () => {},
  };
  const chunk = createReviewPlanChunkTool(deps);
  await chunk.execute("id", { index: 1, content: "first-attempt" }, undefined, undefined, {});
  assert.equal(deps.takeAssembledPlan(), "first-attempt");

  const begin = createReviewPlanBeginTool(deps);
  await begin.execute("id", {}, undefined, undefined, {});
  assert.equal(deps.takeAssembledPlan(), undefined, "begin dropped the partial plan");
});

test("review_plan_chunk: a cut mid-chunk keeps accepted chunks and names the next index", async () => {
  let next = 1;
  const accepted: string[] = [];
  const deps = {
    planPath: () => ".pi/plans/x.md",
    originalPlan: () => ORIGINAL_PLAN,
    modelLabel: () => "m",
    submit: async () => ({ ok: true }),
    beginPlan: () => {
      next = 1;
      accepted.length = 0;
      return { ok: true, maxChunkChars: 8 };
    },
    appendPlanChunk: (index: number, content: string) => {
      if (index !== next) {
        return { ok: false, error: `expected chunk ${next}, got ${index}` };
      }
      if (content.length > 8) {
        return {
          ok: false,
          error: `chunk ${index} is ${content.length} characters; the limit is 8`,
        };
      }
      accepted.push(content);
      next += 1;
      return { ok: true, received: accepted.length, nextIndex: next };
    },
    maxChunkChars: 8,
    log: () => {},
  };
  const begin = createReviewPlanBeginTool(deps);
  await begin.execute("id", { totalChunks: 3 }, undefined, undefined, {});
  const chunk = createReviewPlanChunkTool(deps);
  await chunk.execute("id", { index: 1, content: "abcdefgh" }, undefined, undefined, {});
  await chunk.execute("id", { index: 2, content: "ijklmnop" }, undefined, undefined, {});

  // The provider cuts while chunk 3 streams: a truncated chunk never lands, so
  // the retry must resend exactly index 3.
  const cut = await chunk.execute(
    "id",
    { index: 3, content: "qrstuvwxyz" },
    undefined,
    undefined,
    {},
  );
  assert.equal(cut.isError, true);
  assert.match(cut.content[0].text, /limit is 8/, "the cut chunk is refused");

  const retry = await chunk.execute(
    "id",
    { index: 3, content: "qrstuvwx" },
    undefined,
    undefined,
    {},
  );
  assert.equal(retry.isError, undefined, "the retry continues, no restart");
  assert.match(retry.content[0].text, /Next expected index: 4/);
  assert.deepEqual(accepted, ["abcdefgh", "ijklmnop", "qrstuvwx"]);
});

// ══ Step 15: review_pass_done ═════════════════════════════════════════

test("review_pass_done: refuses to end a pass with no submission", async () => {
  const done: unknown[] = [];
  let submitted = false;
  const tool = createReviewPassDoneTool({
    hasSubmitted: () => submitted,
    onPassDone: (r) => done.push(r),
    willVerify: () => true,
    log: () => {},
  });
  let r = await tool.execute(
    "id",
    { verdict: "approve", findings: [] },
    undefined,
    undefined,
    {},
  );
  assert.equal(r.isError, true);
  assert.ok(r.content[0].text.includes("review_submit_plan"));
  assert.equal(done.length, 0, "an unsubmitted pass is not recorded");

  submitted = true;
  r = await tool.execute(
    "id",
    {
      pass: 1,
      verdict: "revise",
      findings: [HIGH_FINDING],
      notes: "unverified",
    },
    undefined,
    undefined,
    {},
  );
  assert.equal(r.isError, undefined);
  assert.equal(done.length, 1);
  const rec = done[0] as {
    pass: number;
    verdict: string;
    notes: string;
    findings: unknown[];
  };
  assert.equal(rec.pass, 1);
  assert.equal(rec.verdict, "revise");
  assert.equal(rec.notes, "unverified");
  assert.equal(rec.findings.length, 1);
  assert.ok(r.content[0].text.includes("verification pass is scheduled"));
});

test("review_pass_done: coerces invalid input and drops empty notes", async () => {
  const done: Array<{
    pass: number;
    verdict: string;
    notes?: string;
    findings: unknown[];
  }> = [];
  const tool = createReviewPassDoneTool({
    hasSubmitted: () => true,
    onPassDone: (r) => done.push(r as never),
    willVerify: () => false,
    log: () => {},
  });
  const r = await tool.execute(
    "id",
    { pass: 99, verdict: "nonsense", findings: "junk" },
    undefined,
    undefined,
    {},
  );
  assert.equal(done[0].pass, 1);
  assert.equal(done[0].verdict, "revise");
  assert.deepEqual(done[0].findings, []);
  assert.equal(done[0].notes, undefined);
  assert.ok(r.content[0].text.includes("review is complete"));
});

// ══ Steps 12-13: applySubmittedPlan ═══════════════════════════════════

test("applySubmittedPlan: writes Plan Mode's own path, guards .pi/plans", () => {
  const { root, cwd } = tmpProject();
  const entries: Array<[string, unknown]> = [];
  const notes: string[] = [];
  const pi = { appendEntry: (t: string, d?: unknown) => entries.push([t, d]) };

  // Date-dependent on purpose: the plan path must be today's, so a stale
  // prefix is corrected to today (never a hard-coded date, which went stale).
  const today = getUtcDatePrefix();
  const rel = path.join(".pi", "plans", `${today}-csv.md`);
  const r = applySubmittedPlan({
    cwd,
    planPath: rel,
    planText: `${REWRITTEN_PLAN}\n\n---\n\n${REVIEW_CHANGELOG_HEADING}\n\nlog\n`,
    planBody: REWRITTEN_PLAN,
    verdict: "revise",
    summary: "aligned",
    findings: [HIGH_FINDING],
    round: 1,
    modelLabel: "opencode-go/muse-spark",
    pi,
    notify: (m) => notes.push(m),
  });
  assert.equal(r.ok, true);
  assert.equal(path.basename(r.path), `${today}-csv.md`);
  assert.ok(
    fs.existsSync(path.join(cwd, rel)),
    "nested dir created and file written",
  );
  assert.equal(entries.length, 1);
  assert.equal(entries[0][0], "workflow-review-submitted");
  assert.equal(notes.length, 1);

  // Stale date prefix is corrected to today, slug preserved.
  const stale = applySubmittedPlan({
    cwd,
    planPath: path.join(".pi", "plans", "2020-01-01-csv.md"),
    planText: REWRITTEN_PLAN,
    planBody: REWRITTEN_PLAN,
    verdict: "approve",
    summary: "s",
    findings: [],
    round: 1,
    modelLabel: "m",
    pi,
  });
  assert.equal(stale.corrected, true);
  assert.equal(path.basename(stale.path), `${today}-csv.md`);

  // Defense in depth: never write outside .pi/plans/.
  for (const escape of ["src/app.ts", "notes.md", path.join("..", "evil.md")]) {
    const bad = applySubmittedPlan({
      cwd,
      planPath: escape,
      planText: "x",
      planBody: "x",
      verdict: "approve",
      summary: "s",
      findings: [],
      round: 1,
      modelLabel: "m",
      pi,
    });
    assert.equal(bad.ok, false, `${escape} must be refused`);
  }
  assert.ok(!fs.existsSync(path.join(cwd, "src", "app.ts")));

  // A failing audit sink must not invalidate a successful write.
  const r2 = applySubmittedPlan({
    cwd,
    planPath: rel,
    planText: "z",
    planBody: "z",
    verdict: "approve",
    summary: "s",
    findings: [],
    round: 1,
    modelLabel: "m",
    pi: {
      appendEntry: () => {
        throw new Error("sink down");
      },
    },
  });
  assert.equal(r2.ok, true);

  fs.rmSync(root, { recursive: true, force: true });
});

// ══ Step 14: round gate ═══════════════════════════════════════════════

test("round gate: notifies, resolves immediately, times out, aborts, resets", async () => {
  const gate = createReviewRoundGate();
  assert.equal(gate.lastSubmitted(), undefined);

  // notify before wait → immediate
  const payload = {
    planBody: "b",
    planText: "t",
    findings: [],
    verdict: "approve" as const,
    summary: "s",
    changelog: "c",
  };
  gate.notifySubmitted(payload);
  assert.equal((await gate.waitForSubmit(50))?.summary, "s");

  // notify while waiting → resolves
  const g2 = createReviewRoundGate();
  const waiting = g2.waitForSubmit(2000);
  setTimeout(() => g2.notifySubmitted(payload), 5);
  assert.equal((await waiting)?.summary, "s");

  // R7: a silent reviewer must not hang the handoff
  const g3 = createReviewRoundGate();
  const t0 = Date.now();
  assert.equal(await g3.waitForPassDone(120), undefined);
  assert.ok(Date.now() - t0 < 2000, "timeout is bounded");

  // abort releases the wait
  const g4 = createReviewRoundGate();
  const ac = new AbortController();
  const abortedWait = g4.waitForSubmit(5000, ac.signal);
  setTimeout(() => ac.abort(), 5);
  assert.equal(await abortedWait, undefined);

  // pass 1 → pass 2 advance is observable via reset
  const g5 = createReviewRoundGate();
  g5.notifyPassDone({ pass: 1, verdict: "revise", findings: [], at: 1 });
  assert.equal((await g5.waitForPassDone(10))?.pass, 1);
  g5.reset();
  assert.equal(g5.lastPassDone(), undefined);
  g5.notifyPassDone({ pass: 2, verdict: "approve", findings: [], at: 2 });
  assert.equal((await g5.waitForPassDone(10))?.pass, 2);
});

// ══ Gated handoff (plan 2026-10-23 follow-up) ═════════════════════════

test("handoff gate: resolve-before-wait, single settle, reset, abort", async () => {
  const gate = createReviewHandoffGate();
  assert.equal(gate.settled(), false);
  assert.equal(gate.peek(), undefined);

  // Resolve before wait → the waiter gets the result immediately.
  gate.resolve({ outcome: "reviewed", planText: "new-plan" });
  assert.equal(gate.settled(), true);
  assert.deepEqual(await gate.wait(), {
    outcome: "reviewed",
    planText: "new-plan",
  });
  assert.equal(gate.peek()?.outcome, "reviewed");

  // Exactly-once: a second resolve is ignored, so an abort cannot clobber
  // a resume that already landed (and vice versa).
  gate.resolve({ outcome: "unreviewed", planText: "other" });
  assert.equal(gate.peek()?.planText, "new-plan");

  // Reset clears the slot for the next gated phase.
  gate.reset();
  assert.equal(gate.settled(), false);
  assert.equal(gate.peek(), undefined);

  // Wait then resolve.
  const g2 = createReviewHandoffGate();
  const waiting = g2.wait();
  setTimeout(
    () => g2.resolve({ outcome: "unreviewed", planText: undefined }),
    5,
  );
  assert.deepEqual(await waiting, {
    outcome: "unreviewed",
    planText: undefined,
  });
  assert.equal(g2.settled(), true);

  // A caller abort releases the wait with undefined; the gate itself stays
  // open so an explicit settle still delivers the handoff exactly once.
  const g3 = createReviewHandoffGate();
  const ac = new AbortController();
  const abortedWait = g3.wait(ac.signal);
  setTimeout(() => ac.abort(), 5);
  assert.equal(await abortedWait, undefined);
  assert.equal(g3.settled(), false);
  g3.resolve({ outcome: "reviewed", planText: "late-plan" });
  assert.equal((await g3.wait())?.planText, "late-plan");
});

test("handoff gate: an already-aborted signal resolves immediately", async () => {
  const gate = createReviewHandoffGate();
  const ac = new AbortController();
  ac.abort();
  // Regression: the old deferredWait registered a listener that could never
  // fire, so the parked agent_end handler waited forever.
  assert.equal(await gate.wait(ac.signal), undefined);
  assert.equal(gate.settled(), false);
  // The gate stays open, so an explicit settle still delivers exactly once.
  gate.resolve({ outcome: "reviewed", planText: "late-plan" });
  assert.equal((await gate.wait())?.planText, "late-plan");
});

test("classifyReviewExecution: a pre-aborted signal is an abort, never a pause", () => {
  const base = {
    ok: false,
    aborted: false,
    abortedBeforeStart: false,
    paused: false,
    planChanged: false,
  };
  // The exact 2026-10-25 regression: no explicit pause snapshot exists, so a
  // pre-aborted host signal must not be classified as a pause.
  assert.equal(
    classifyReviewExecution({ ...base, abortedBeforeStart: true }),
    "aborted",
  );
  assert.equal(
    classifyReviewExecution({ ...base, aborted: true }),
    "aborted",
  );
  assert.equal(
    classifyReviewExecution({ ...base, aborted: true, paused: true }),
    "paused",
    "an explicit pause snapshot wins",
  );
  assert.equal(
    classifyReviewExecution({ ...base, ok: true, planChanged: true }),
    "rewritten",
  );
  assert.equal(
    classifyReviewExecution({ ...base, ok: true, planChanged: false }),
    "unchanged",
  );
  assert.equal(classifyReviewExecution(base), "fallback");
});

test("review resume helpers: settle, gate outcome and truthful notices", () => {
  const r = (
    outcome: ReviewExecutionResult["outcome"],
    over: Partial<ReviewExecutionResult> = {},
  ): ReviewExecutionResult => ({
    planText: "plan",
    outcome,
    paused: outcome === "paused",
    ...over,
  });

  assert.equal(reviewResumeSettles(r("paused")), false);
  for (const outcome of [
    "rewritten",
    "unchanged",
    "aborted",
    "skipped",
    "fallback",
  ] as const) {
    assert.equal(reviewResumeSettles(r(outcome)), true, outcome);
  }

  assert.equal(reviewResumeGateOutcome(r("rewritten")), "reviewed");
  assert.equal(reviewResumeGateOutcome(r("unchanged")), "unreviewed");
  assert.equal(reviewResumeGateOutcome(r("fallback")), "unreviewed");
  assert.equal(reviewResumeGateOutcome(r("paused")), undefined);

  const pausedNotice = reviewResumeNotice(r("paused"));
  assert.ok(pausedNotice.includes("paused"));
  assert.ok(!pausedNotice.includes("no usable rewrite"));
  assert.ok(reviewResumeNotice(r("unchanged")).includes("kept the plan"));
  assert.ok(reviewResumeNotice(r("rewritten")).includes("rewritten"));
  assert.ok(
    reviewResumeNotice(r("fallback", { reason: "provider down" })).includes(
      "provider down",
    ),
  );
  assert.ok(reviewResumeNotice(r("skipped", { reason: "already reviewed" })).includes("already reviewed"));
});

test("reviewRunLabel: names a boot, a resume, a continuation and pass 2", () => {
  assert.equal(reviewRunLabel({ created: true }), "reviewer started");
  assert.equal(
    reviewRunLabel({ created: true, resumed: true }),
    "reviewer restarted — new reviewer session",
    "a resume that had to reboot names the new session instead of claiming warmth",
  );
  assert.equal(reviewRunLabel({ created: false }), "reviewer continuing");
  assert.equal(
    reviewRunLabel({ created: false, resumed: true }),
    "reviewer resumed",
  );
  // Pass 2 is always the verification pass, whatever the session history.
  assert.equal(
    reviewRunLabel({ created: true, resumed: true, pass: 2 }),
    "reviewer verifying — pass 2",
  );
  assert.equal(
    reviewRunLabel({ created: false, pass: 2 }),
    "reviewer verifying — pass 2",
  );
  // The user-visible regression: a warm resume is never narrated as a start.
  assert.ok(
    !reviewRunLabel({ created: false, resumed: true }).includes("started"),
  );
});

test("reviewNoticeText: prefixes exactly once", () => {
  assert.equal(
    reviewNoticeText("no reviewer model configured"),
    "Review Mode: no reviewer model configured",
  );
  assert.equal(
    reviewNoticeText("Review Mode: no time limit configured"),
    "Review Mode: no time limit configured",
  );
  assert.equal(
    reviewNoticeText("Review Mode unavailable: no provider"),
    "Review Mode unavailable: no provider",
  );
  assert.equal(
    reviewNoticeText("Review Mode pass 1 exceeded its limit"),
    "Review Mode pass 1 exceeded its limit",
  );
  assert.equal(reviewNoticeText("  spaced  "), "Review Mode: spaced");
  assert.equal(reviewNoticeText(""), "Review Mode: ");
  assert.ok(
    !reviewNoticeText("Review Mode: x").includes("Review Mode: Review Mode:"),
    "no notice may be double-prefixed",
  );
});

test("reviewResumePlanChoice: the reviewer's own rewrite still resumes", () => {
  // The regression: pass 1 wrote the rewrite to the file before a pass-2 pause.
  assert.equal(
    reviewResumePlanChoice({
      pausedPlanHash: "orig",
      pausedFileHash: "rewrite",
      currentFileHash: "rewrite",
    }),
    "warm",
    "a reviewer-authored change is not an author edit",
  );
  assert.equal(
    reviewResumePlanChoice({
      pausedPlanHash: "orig",
      pausedFileHash: "rewrite",
      currentFileHash: "author-edit",
    }),
    "fresh",
  );
  assert.equal(
    reviewResumePlanChoice({
      pausedPlanHash: "orig",
      pausedFileHash: "rewrite",
      currentFileHash: undefined,
    }),
    "warm",
    "a missing file cannot be an author edit",
  );
  // Defensive fallback: no snapshot → compare with the round's text, as before.
  assert.equal(
    reviewResumePlanChoice({ pausedPlanHash: "orig", currentFileHash: "orig" }),
    "warm",
  );
  assert.equal(
    reviewResumePlanChoice({ pausedPlanHash: "orig", currentFileHash: "other" }),
    "fresh",
  );
});

test("reviewHandoffParks requires phase + snapshot + unsettled gate", () => {
  assert.equal(
    reviewHandoffParks({ phase: "paused", paused: true, settled: false }),
    true,
  );
  assert.equal(
    reviewHandoffParks({ phase: "paused", paused: false, settled: false }),
    false,
    "a paused phase without a snapshot could never be resumed",
  );
  assert.equal(
    reviewHandoffParks({ phase: "paused", paused: true, settled: true }),
    false,
  );
  assert.equal(
    reviewHandoffParks({ phase: "auditing", paused: true, settled: false }),
    false,
  );
  assert.equal(
    reviewHandoffParks({ phase: "idle", paused: true, settled: false }),
    false,
  );
});

test("reviewEscapeAction: pause a live round, swallow a paused gate, pass otherwise", () => {
  assert.equal(
    reviewEscapeAction({ roundActive: true, paused: false, gatedPause: false }),
    "pause",
  );
  assert.equal(
    reviewEscapeAction({ roundActive: true, paused: false, gatedPause: true }),
    "pause",
  );
  assert.equal(
    reviewEscapeAction({ roundActive: false, paused: true, gatedPause: true }),
    "swallow",
    "ESC must not abort the parked parent turn",
  );
  assert.equal(
    reviewEscapeAction({ roundActive: false, paused: true, gatedPause: false }),
    "pass",
  );
  assert.equal(
    reviewEscapeAction({ roundActive: false, paused: false, gatedPause: false }),
    "pass",
  );
});

test("reviewStatusVisible: only a live round or a pause shows the review line", () => {
  assert.equal(reviewStatusVisible({}), false);
  assert.equal(reviewStatusVisible({ roundInFlight: true }), true);
  assert.equal(reviewStatusVisible({ roundActive: true }), true);
  assert.equal(reviewStatusVisible({ paused: true }), true);
  assert.equal(
    reviewStatusVisible({ roundActive: true, phase: "reviewing" }),
    true,
  );
  assert.equal(
    reviewStatusVisible({ roundInFlight: true, phase: "reviewing" }),
    true,
  );
  // Cold boot: roundActive flips before the first live phase event, so a
  // retained terminal state from the previous round must not be painted.
  assert.equal(
    reviewStatusVisible({ roundActive: true, phase: "aborted" }),
    false,
  );
  assert.equal(reviewStatusVisible({ roundActive: true, phase: "done" }), false);
  assert.equal(
    reviewStatusVisible({ roundInFlight: true, phase: "failed" }),
    false,
  );

  // Regression: a retained terminal state must render the PAUSED text while
  // paused, never "… aborted", and the widget is hidden when not visible.
  const aborted = createReviewState({ planHash: "h", modelLabel: "m" });
  aborted.phase = "aborted";
  assert.ok(reviewFooterSegment(aborted, false).includes("aborted"));
  assert.equal(
    reviewFooterSegment(aborted, true),
    "🔍 review paused — /review-resume to continue",
  );
  assert.ok(!reviewFooterSegment(aborted, true).includes("aborted"));

  // reviewStatusText is the single composer used by the footer/widget.
  assert.equal(
    reviewStatusText({
      state: aborted,
      roundActive: true,
      roundInFlight: false,
      paused: false,
    }),
    "",
    "a terminal state is not live during a new round's cold boot",
  );
  assert.equal(
    reviewStatusText({
      state: aborted,
      roundActive: false,
      roundInFlight: false,
      paused: true,
    }),
    "🔍 review paused — /review-resume to continue",
  );
  assert.equal(
    reviewStatusText({ state: undefined, roundInFlight: true }),
    "🔍 review · starting",
    "the cold-boot window is visible as starting",
  );
});

test("nextReviewRound restarts a new cycle even after the cap", () => {
  assert.deepEqual(nextReviewRound({ round: 1, maxRounds: 1 }), {
    round: 2,
    allowed: false,
  });
  assert.deepEqual(
    nextReviewRound({ round: 1, maxRounds: 1, newCycle: true }),
    { round: 1, allowed: true },
    "a new plan cycle must not inherit the previous cycle's consumed round",
  );
  assert.deepEqual(nextReviewRound({ round: 0, maxRounds: 1 }), {
    round: 1,
    allowed: true,
  });
  assert.deepEqual(nextReviewRound({ round: -3, maxRounds: 1 }), {
    round: 1,
    allowed: true,
  });
  assert.deepEqual(nextReviewRound({ round: 1, maxRounds: 0 }), {
    round: 2,
    allowed: false,
  });
  assert.deepEqual(nextReviewRound({ round: 1, maxRounds: Number.NaN }), {
    round: 2,
    allowed: false,
  });
});

test("reviewPauseIsCurrent ignores a pause from a superseded cycle", () => {
  assert.equal(reviewPauseIsCurrent({ pauseCycle: 3, currentCycle: 3 }), true);
  assert.equal(reviewPauseIsCurrent({ pauseCycle: 2, currentCycle: 3 }), false);
  assert.equal(
    reviewPauseIsCurrent({ pauseCycle: undefined, currentCycle: 3 }),
    false,
  );
});

test("shouldPauseReviewOnEscape pauses exactly once per round", () => {
  assert.equal(
    shouldPauseReviewOnEscape({ roundActive: true, paused: false }),
    true,
  );
  assert.equal(
    shouldPauseReviewOnEscape({ roundActive: true, paused: true }),
    false,
    "an ESC while already paused falls through (editor/selector keep it)",
  );
  assert.equal(
    shouldPauseReviewOnEscape({ roundActive: false, paused: false }),
    false,
    "an ESC with no round running falls through",
  );
  assert.equal(
    shouldPauseReviewOnEscape({ roundActive: false, paused: true }),
    false,
  );
});

test("reviewFooterSegment composes the footer review state", () => {
  assert.equal(reviewFooterSegment(undefined, false), "");
  assert.equal(
    reviewFooterSegment(undefined, false, true),
    "🔍 review · starting",
    "a round in flight has a live line before its first state",
  );
  assert.equal(
    reviewFooterSegment(undefined, true),
    "🔍 review paused — /review-resume to continue",
  );
  const s = createReviewState({
    planHash: "abc",
    modelLabel: "p/m",
    round: 1,
  });
  assert.equal(reviewFooterSegment(s, false), reviewStateSummary(s));
  assert.equal(
    reviewFooterSegment(s, true),
    "🔍 review paused — /review-resume to continue",
    "the paused form wins over the live phase",
  );
});

// ══ Mode-switch lock (plan 2026-10-25) ═══════════════════════════════

test("reviewModeLockKind locks running and paused reviews only", () => {
  assert.equal(reviewModeLockKind({}), undefined);
  assert.equal(
    reviewModeLockKind({ gatePhase: "idle" }),
    undefined,
    "a resolved/post-review handoff is intentionally unlocked",
  );
  assert.equal(reviewModeLockKind({ roundInFlight: true }), "running");
  assert.equal(reviewModeLockKind({ roundActive: true }), "running");
  assert.equal(
    reviewModeLockKind({ gatePhase: "auditing" }),
    "running",
    "the gated handoff audit still owns the turn",
  );
  assert.equal(reviewModeLockKind({ paused: true }), "paused");
  assert.equal(reviewModeLockKind({ gatePhase: "paused" }), "paused");
  assert.equal(
    reviewModeLockKind({ roundActive: true, paused: true }),
    "paused",
    "a pause wins while the abort is still landing",
  );
  assert.equal(
    reviewModeLockKind({ roundActive: true, gatePhase: "paused" }),
    "running",
    "a resumed round must not be masked by a stale paused gate phase",
  );
});

test("reviewGatePhaseOnResume makes a gated pause auditing again", () => {
  assert.equal(reviewGatePhaseOnResume("paused"), "auditing");
  assert.equal(reviewGatePhaseOnResume("auditing"), "auditing");
  assert.equal(reviewGatePhaseOnResume("idle"), "idle");
});

test("reviewModeLockNotice names only the allowed review exits", () => {
  const running = reviewModeLockNotice("running");
  for (const s of [
    "ESC",
    "/review-pause",
    "/review-resume",
    "/review-abort",
    "/review-mode off",
  ]) {
    assert.ok(running.includes(s), `running notice names ${s}`);
  }
  const paused = reviewModeLockNotice("paused");
  for (const s of ["/review-resume", "/review-abort", "/review-mode off"]) {
    assert.ok(paused.includes(s), `paused notice names ${s}`);
  }
  assert.ok(!paused.includes("ESC"), "ESC is a pause, not a resume");
});

test("reviewModeLockFooter/StatusLine surface the lock", () => {
  assert.equal(reviewModeLockFooter(undefined), "");
  assert.equal(reviewModeLockFooter("running"), "🔒 modes locked");
  assert.equal(reviewModeLockFooter("paused"), "🔒 modes locked");
  assert.ok(
    reviewModeLockStatusLine("paused").includes(
      "mode switching stays locked",
    ),
  );
  assert.ok(reviewModeLockStatusLine("running").includes("mode switching is locked"));
  assert.equal(reviewModeLockStatusLine(undefined), "");
});

// ══ Step 6: child session isolation ═══════════════════════════════════

test("createReviewSession: isolates the reviewer from the parent", async () => {
  const captured: {
    loaderOpts?: Record<string, unknown>;
    sessionOpts?: Record<string, unknown>;
    markerDuringCreate?: string | undefined;
  } = {};
  const fakeSession = {
    subscribe: () => () => {},
    prompt: async () => {},
    followUp: async () => {},
    abort: async () => {},
    isStreaming: false,
    bindExtensions: async () => {},
  };
  const sdk = {
    ModelRuntime: { create: async () => ({}) },
    DefaultResourceLoader: class {
      constructor(opts: Record<string, unknown>) {
        captured.loaderOpts = opts;
      }
      async reload() {}
    },
    SessionManager: { inMemory: () => ({}) },
    createAgentSession: async (opts: Record<string, unknown>) => {
      captured.sessionOpts = opts;
      captured.markerDuringCreate = process.env.PI_WORKFLOW_REVIEW_CHILD;
      return { session: fakeSession };
    },
  };

  const customTools = [
    { name: "review_bash" },
    { name: "review_explore" },
    { name: "review_submit_plan" },
    { name: "review_pass_done" },
  ];

  const res = await createReviewSession({
    cwd: "/proj",
    agentDir: "/agent",
    modelRef: { provider: "p", id: "m", thinking: "xhigh" },
    findModel: () => ({}),
    reviewPrompt: "USER GUIDANCE",
    customTools,
    loadSdk: async () => sdk as never,
  });

  assert.equal(res.ok, true);
  assert.equal(
    captured.loaderOpts?.noExtensions,
    true,
    "no ambient extensions → no recursion",
  );
  assert.equal(captured.loaderOpts?.noSkills, true);
  assert.equal(
    captured.loaderOpts?.systemPrompt
      ?.toString()
      .startsWith("You are REVIEW MODE"),
    true,
  );
  assert.deepEqual(captured.loaderOpts?.appendSystemPrompt, ["USER GUIDANCE"]);
  // The allowlist MUST carry the reviewer's own tools: `tools` filters custom
  // tools too, so a built-ins-only list silently removes review_submit_plan and
  // every review ends in a fallback (the bug this test guards).
  const allowlist = captured.sessionOpts?.tools as string[];
  assert.deepEqual(allowlist, reviewToolAllowlist(customTools));
  for (const name of REVIEW_BUILTIN_TOOLS) {
    assert.ok(allowlist.includes(name), `${name} stays enabled`);
  }
  for (const tool of customTools) {
    assert.ok(
      allowlist.includes(tool.name),
      `${tool.name} must be in the allowlist or the SDK filters it out`,
    );
  }
  assert.ok(!allowlist.includes("edit"));
  assert.ok(!allowlist.includes("write"));
  assert.ok(!allowlist.includes("bash"));
  assert.equal(
    captured.markerDuringCreate,
    "1",
    "anti-recursion marker set during create",
  );
  assert.equal(
    process.env.PI_WORKFLOW_REVIEW_CHILD,
    undefined,
    "marker restored after create",
  );
});

test("createReviewSession: bounds the child SDK retry budget in memory only", async () => {
  const captured: {
    createArgs?: { cwd: string; agentDir: string };
    overrides?: Record<string, unknown>;
    sessionOpts?: Record<string, unknown>;
  } = {};
  const fakeSession = {
    subscribe: () => () => {},
    prompt: async () => {},
    followUp: async () => {},
    abort: async () => {},
    isStreaming: false,
    bindExtensions: async () => {},
  };
  const manager = {
    getRetrySettings: () => ({
      enabled: true,
      maxRetries: 3,
      baseDelayMs: 2_000,
      maxAgentDelayMs: 60_000,
    }),
    applyOverrides: (overrides: Record<string, unknown>) => {
      captured.overrides = overrides;
    },
  };
  const sdk = {
    ModelRuntime: { create: async () => ({}) },
    DefaultResourceLoader: class {
      async reload() {}
    },
    SessionManager: { inMemory: () => ({}) },
    SettingsManager: {
      create: (cwd: string, agentDir: string) => {
        captured.createArgs = { cwd, agentDir };
        return manager;
      },
    },
    createAgentSession: async (opts: Record<string, unknown>) => {
      captured.sessionOpts = opts;
      return { session: fakeSession };
    },
  };

  const res = await createReviewSession({
    cwd: "/proj",
    agentDir: "/agent",
    modelRef: { provider: "p", id: "m", thinking: "high" },
    findModel: () => ({}),
    reviewPrompt: "guidance",
    customTools: [],
    providerRetries: 0,
    loadSdk: async () => sdk as never,
  });

  assert.equal(res.ok, true);
  assert.deepEqual(captured.createArgs, { cwd: "/proj", agentDir: "/agent" });
  assert.deepEqual(captured.overrides, {
    retry: {
      enabled: true,
      maxRetries: 0,
      baseDelayMs: 2_000,
      maxAgentDelayMs: 60_000,
    },
  });
  assert.equal(captured.sessionOpts?.settingsManager, manager);
});

test("reviewToolAllowlist: built-ins plus every custom tool, junk-tolerant", () => {
  assert.deepEqual(reviewToolAllowlist([]), [...REVIEW_BUILTIN_TOOLS]);
  assert.deepEqual(reviewToolAllowlist(undefined), [...REVIEW_BUILTIN_TOOLS]);
  assert.deepEqual(
    reviewToolAllowlist([
      { name: "review_submit_plan" },
      { name: "review_pass_done" },
    ]),
    [...REVIEW_BUILTIN_TOOLS, "review_submit_plan", "review_pass_done"],
  );
  // Duplicates collapse; junk never becomes a tool name.
  assert.deepEqual(
    reviewToolAllowlist([
      { name: "read" },
      { name: "  " },
      { name: 7 },
      null,
      42,
      {},
    ]),
    [...REVIEW_BUILTIN_TOOLS],
  );
});

/**
 * An SDK stub that applies Pi's REAL allowlist rule (built-ins and custom tools
 * are filtered by `tools`) and reports the survivors via getActiveToolNames.
 */
function allowlistSdk(activeOverride?: string[]): {
  requested: () => string[];
  sdk: unknown;
} {
  let requested: string[] = [];
  const sdk = {
    ModelRuntime: { create: async () => ({}) },
    DefaultResourceLoader: class {
      async reload() {}
    },
    SessionManager: { inMemory: () => ({}) },
    createAgentSession: async (opts: {
      tools?: string[];
      customTools?: Array<{ name: string }>;
    }) => {
      requested = [...(opts.tools ?? [])];
      const allow = new Set(requested);
      const active =
        activeOverride ??
        [
          ...FAKE_BUILTIN_TOOLS,
          ...(opts.customTools ?? []).map((t) => t.name),
        ].filter((n) => allow.has(n));
      return {
        session: {
          subscribe: () => () => {},
          prompt: async () => {},
          followUp: async () => {},
          abort: async () => {},
          isStreaming: false,
          getActiveToolNames: () => active.slice(),
          bindExtensions: async () => {},
        },
      };
    },
  };
  return { requested: () => requested, sdk };
}

const REVIEW_TOOL_NAMES = [
  "review_bash",
  "review_explore",
  "review_plan_begin",
  "review_plan_chunk",
  "review_plan_finalize",
  "review_submit_plan",
  "review_pass_done",
];

test("REGRESSION: the reviewer's tools survive the session tool allowlist", async () => {
  const { requested, sdk } = allowlistSdk();
  const res = await createReviewSession({
    cwd: "/p",
    agentDir: "/a",
    modelRef: { provider: "p", id: "m", thinking: "high" },
    findModel: () => ({}),
    reviewPrompt: "x",
    customTools: REVIEW_TOOL_NAMES.map((name) => ({ name })),
    loadSdk: async () => sdk as never,
  });

  assert.equal(res.ok, true, res.error);
  for (const name of [...REVIEW_BUILTIN_TOOLS, ...REVIEW_TOOL_NAMES]) {
    assert.ok(
      requested().includes(name),
      `${name} must be in the tools allowlist`,
    );
    assert.ok(
      res.activeTools?.includes(name),
      `${name} must be active in the child session`,
    );
  }
  // Reverting to a built-ins-only allowlist makes the stub drop the reviewer's
  // tools, so every assertion above fails — i.e. this reproduces the bug.
  assert.equal(
    res.activeTools?.length,
    REVIEW_BUILTIN_TOOLS.length + REVIEW_TOOL_NAMES.length,
  );
});

test("createReviewSession: fails fast when the SDK drops a reviewer tool", async () => {
  const { sdk } = allowlistSdk([...REVIEW_BUILTIN_TOOLS]);
  const res = await createReviewSession({
    cwd: "/p",
    agentDir: "/a",
    modelRef: { provider: "p", id: "m", thinking: "high" },
    findModel: () => ({}),
    reviewPrompt: "x",
    customTools: REVIEW_TOOL_NAMES.map((name) => ({ name })),
    loadSdk: async () => sdk as never,
  });

  assert.equal(res.ok, false);
  assert.equal(res.session, undefined);
  assert.match(res.error ?? "", /not active/);
  assert.match(res.error ?? "", /review_submit_plan/);
});

test("createReviewSession: reports failures instead of throwing", async () => {
  const base = {
    cwd: "/p",
    agentDir: "/a",
    modelRef: { provider: "p", id: "m", thinking: "high" },
    reviewPrompt: "x",
    customTools: [],
  };
  const missing = await createReviewSession({
    ...base,
    findModel: () => undefined,
    loadSdk: async () => ({}) as never,
  });
  assert.equal(missing.ok, false);
  assert.match(missing.error ?? "", /not in the model registry/);

  const badImport = await createReviewSession({
    ...base,
    findModel: () => ({}),
    loadSdk: async () => {
      throw new Error("cannot resolve sdk");
    },
  });
  assert.equal(badImport.ok, false);
  assert.equal(badImport.error, "cannot resolve sdk");
});

test("createReviewSession: preserves a pre-existing marker env value", async () => {
  const prev = process.env.PI_WORKFLOW_REVIEW_CHILD;
  process.env.PI_WORKFLOW_REVIEW_CHILD = "PRESERVE";
  try {
    await createReviewSession({
      cwd: "/p",
      agentDir: "/a",
      modelRef: { provider: "p", id: "m", thinking: "high" },
      findModel: () => ({}),
      reviewPrompt: "x",
      customTools: [],
      loadSdk: async () =>
        ({
          ModelRuntime: { create: async () => ({}) },
          DefaultResourceLoader: class {
            async reload() {}
          },
          SessionManager: { inMemory: () => ({}) },
          createAgentSession: async () => ({
            session: {
              subscribe: () => () => {},
              prompt: async () => {},
              followUp: async () => {},
              abort: async () => {},
              isStreaming: false,
            },
          }),
        }) as never,
    });
    assert.equal(process.env.PI_WORKFLOW_REVIEW_CHILD, "PRESERVE");
  } finally {
    if (prev === undefined) delete process.env.PI_WORKFLOW_REVIEW_CHILD;
    else process.env.PI_WORKFLOW_REVIEW_CHILD = prev;
  }
});

// ══ Toolbox ═══════════════════════════════════════════════════════════

test("createReviewTools: reports missing SDK pieces instead of throwing", () => {
  const deps = {
    cwd: "/p",
    log: () => {},
    explore: {
      budget: () => 1,
      run: async () => "",
      onUsed: () => {},
      log: () => {},
    },
    submit: {
      planPath: () => "p.md",
      originalPlan: () => "",
      modelLabel: () => "m",
      submit: async () => ({ ok: true }),
      log: () => {},
    },
    passDone: {
      hasSubmitted: () => false,
      onPassDone: () => {},
      willVerify: () => false,
      log: () => {},
    },
  };
  const withoutSdk = createReviewTools(undefined, deps);
  const names = withoutSdk.tools.map((t) => (t as { name: string }).name);
  assert.deepEqual(names, [
    "review_explore",
    "review_plan_begin",
    "review_plan_chunk",
    "review_plan_finalize",
    "review_submit_plan",
    "review_pass_done",
  ]);
  assert.equal(
    withoutSdk.unavailable.length,
    1,
    "review_bash reported unavailable",
  );

  const withSdk = createReviewTools(
    {
      createBashToolDefinition: () => ({
        parameters: {},
        execute: async () => ({ content: [] }),
      }),
    } as never,
    deps,
  );
  assert.equal(withSdk.tools.length, 7, "all seven tools with a full SDK");
  assert.equal(withSdk.unavailable.length, 0);
  assert.equal(
    resolveBashToolDefinitionBuilder({ createBashToolDefinition: 42 } as never),
    undefined,
  );
});

// ══ Steps 18-25: orchestrator (fake SDK, no provider needed) ══════════

function runtimeDeps(
  sdk: unknown,
  over: {
    config?: Record<string, unknown>;
    reviewerModel?: unknown;
    fallbacks?: Array<{ provider: string; id: string; thinking: string }>;
    parentProviders?: unknown;
    onState?: (s: unknown) => void;
    onTranscriptOps?: (ops: unknown[]) => void;
  } = {},
) {
  const writes: Array<{ planText: string; verdict: string; round: number }> =
    [];
  const logs: string[] = [];
  const deps = {
    cwd: "/proj",
    agentDir: "/agent",
    config: () => ({
      enabled: true,
      rounds: 1,
      passes: 2,
      verify: true,
      fallbackOnError: "skip" as const,
      exploreBudget: 3,
      timeoutMs: 5000,
      ...(over.config ?? {}),
    }),
    reviewerModel: () =>
      over.reviewerModel === null
        ? undefined
        : ((over.reviewerModel as
            | { provider: string; id: string; thinking: string }
            | undefined) ?? { provider: "p", id: "m", thinking: "xhigh" }),
    fallbackReviewerModels: () => over.fallbacks ?? [],
    findModel: () => ({}),
    planPath: () => ".pi/plans/2026-09-18-csv.md",
    readPlan: () => ORIGINAL_PLAN,
    contextEntries: () => [
      { type: "message", message: { role: "user", content: "add CSV export" } },
    ],
    runExplore: async (t: string) => `recon: ${t}`,
    writePlan: (i: { planText: string; verdict: string; round: number }) => {
      writes.push({ planText: i.planText, verdict: i.verdict, round: i.round });
      return { ok: true, path: "/abs/plans/x.md" };
    },
    log: (m: string) => logs.push(m),
    notify: (m: string) => logs.push(m),
    promptText: () => "Always align with the existing project framework.",
    loadSdk: async () => sdk as never,
  };
  if (over.parentProviders !== undefined) {
    (deps as { parentProviders?: unknown }).parentProviders = () =>
      over.parentProviders;
  }
  if (over.onState || over.onTranscriptOps) {
    return {
      deps: {
        ...deps,
        ...(over.onState ? { onState: over.onState } : {}),
        ...(over.onTranscriptOps
          ? { onTranscriptOps: over.onTranscriptOps }
          : {}),
      },
      writes,
      logs,
    };
  }
  return { deps, writes, logs };
}

test("runtime: full round wires all tools, verifies, and returns the rewrite", async () => {
  const { capture, sdk } = fakeSdk({
    pass1: submitThenFinish(REWRITTEN_PLAN),
    pass2: submitThenFinishPass2(REWRITTEN_PLAN),
  });
  const phases: string[] = [];
  const { deps, writes } = runtimeDeps(sdk, {
    onState: (s) =>
      phases.push((s as { phase: string } | undefined)?.phase ?? "cleared"),
  });
  const rt = createReviewRuntime(deps as never);

  assert.equal(rt.isAlive(), false, "no session before start");
  assert.equal(await rt.ensureStarted(), true);
  assert.equal(await rt.ensureStarted(), true, "ensureStarted is idempotent");
  assert.deepEqual(
    Object.keys(capture.tools).sort(),
    [
      "review_bash",
      "review_explore",
      "review_pass_done",
      "review_plan_begin",
      "review_plan_chunk",
      "review_plan_finalize",
      "review_submit_plan",
    ],
    "all seven reviewer tools wired (review_bash needs the SDK)",
  );

  const res = await rt.runRound({
    planText: ORIGINAL_PLAN,
    planPath: ".pi/plans/2026-09-18-csv.md",
    round: 1,
  });
  assert.equal(res.ok, true);
  assert.equal(res.fallback, false);
  assert.ok(
    res.planText.includes("Result<string, ExportError>"),
    "returns the reviewer's plan",
  );
  assert.equal(res.planHash, planHash(REWRITTEN_PLAN));
  assert.equal(capture.prompts.length, 1);
  assert.equal(capture.followUps.length, 1, "verification pass runs");
  assert.ok(capture.followUps[0].includes("VERIFY YOUR OWN REWRITE"));
  assert.equal(writes.length, 2, "written once per pass");
  assert.equal(res.state.phase, "done");
  assert.equal(res.state.passes.length, 2);
  assert.ok(phases.includes("reviewing") && phases.includes("verifying"));
  assert.ok(capture.prompts[0].includes("Plan under review"));
  assert.ok(capture.prompts[0].includes("existing project framework"));
  assert.ok(
    capture.prompts[0].includes("add CSV export"),
    "shared context embedded in the prompt",
  );

  await rt.teardown();
  assert.equal(rt.isAlive(), false);
  assert.equal(rt.getState(), undefined);
});

test("runtime: a recoverable provider cut falls back to the next model", async () => {
  const { capture, sdk } = fakeSdk({
    pass1: async (c) => {
      if (c.prompts.length === 1) {
        c.emit({
          type: "agent_end",
          messages: [
            {
              role: "assistant",
              content: [],
              api: "openai-completions",
              provider: "command-code",
              model: "deepseek",
              usage: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 0,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
              },
              stopReason: "error",
              errorMessage: "Stream ended without finish_reason",
              timestamp: Date.now(),
            },
          ],
        });
        return;
      }
      await submitThenFinish(REWRITTEN_PLAN)(c);
    },
  });
  const { deps, logs } = runtimeDeps(sdk, {
    config: {
      passes: 1,
      verify: false,
      providerRecovery: "fallback",
      providerRetries: 1,
    },
    fallbacks: [{ provider: "fallback", id: "model", thinking: "high" }],
  });
  const rt = createReviewRuntime(deps as never);
  const res = await rt.runRound({
    planText: ORIGINAL_PLAN,
    planPath: ".pi/plans/2026-09-18-csv.md",
    round: 1,
  });
  assert.equal(res.ok, true, res.reason);
  assert.equal(capture.prompts.length, 2, "one prompt per model");
  assert.ok(
    capture.prompts[1].includes("Plan under review"),
    "the fallback gets the same review prompt",
  );
  assert.ok(
    logs.some((line) => line.includes("reviewer recovering on fallback/model")),
    "the switch is visible",
  );
  assert.deepEqual(res.state.recoveryAttempts, [
    "p/m (xhigh)",
    "fallback/model (high)",
  ]);
  assert.ok(res.reason === undefined, "a recovered round has no failure reason");
  await rt.teardown();
});

test("runtime: the recovery budget stops the next attempt", async () => {
  const { capture, sdk } = fakeSdk({
    pass1: async (c) => {
      if (c.prompts.length === 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        c.emit({
          type: "agent_end",
          messages: [
            {
              role: "assistant",
              content: [],
              api: "openai-completions",
              provider: "command-code",
              model: "deepseek",
              usage: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 0,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
              },
              stopReason: "error",
              errorMessage: "Stream ended without finish_reason",
              timestamp: Date.now(),
            },
          ],
        });
        return;
      }
      await submitThenFinish(REWRITTEN_PLAN)(c);
    },
  });
  const { deps } = runtimeDeps(sdk, {
    config: {
      passes: 1,
      verify: false,
      providerRecovery: "fallback",
      providerRetries: 1,
      timeoutMs: 60_000,
      recoveryBudgetMs: 10,
    },
    fallbacks: [{ provider: "fallback", id: "model", thinking: "high" }],
  });
  const rt = createReviewRuntime(deps as never);
  const res = await rt.runRound({
    planText: ORIGINAL_PLAN,
    planPath: ".pi/plans/2026-09-18-csv.md",
    round: 1,
  });
  assert.equal(res.ok, false);
  assert.equal(capture.prompts.length, 1, "no attempt after the budget");
  assert.match(res.reason ?? "", /provider recovery budget expired/);
  assert.deepEqual(res.state.recoveryAttempts, ["p/m (xhigh)"]);
  assert.equal(res.planText, ORIGINAL_PLAN);
  await rt.teardown();
});

test("runtime: a non-recoverable provider failure does not switch models", async () => {
  const { capture, sdk } = fakeSdk({
    pass1: async (c) => {
      c.emit({
        type: "agent_end",
        messages: [
          {
            role: "assistant",
            content: [],
            api: "openai-completions",
            provider: "command-code",
            model: "deepseek",
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "error",
            errorMessage: "No API key found for command-code.",
            timestamp: Date.now(),
          },
        ],
      });
    },
  });
  const { deps } = runtimeDeps(sdk, {
    config: {
      passes: 1,
      verify: false,
      providerRecovery: "fallback",
      providerRetries: 1,
    },
    fallbacks: [{ provider: "fallback", id: "model", thinking: "high" }],
  });
  const rt = createReviewRuntime(deps as never);
  const res = await rt.runRound({
    planText: ORIGINAL_PLAN,
    planPath: ".pi/plans/2026-09-18-csv.md",
    round: 1,
  });
  assert.equal(res.ok, false);
  assert.equal(capture.prompts.length, 1, "no second model is tried");
  assert.match(res.reason ?? "", /No API key/);
  await rt.teardown();
});

test("runtime: isRoundActive tracks the round, not the session", async () => {
  const { sdk } = fakeSdk({
    pass1: submitThenFinish(REWRITTEN_PLAN),
    pass2: submitThenFinishPass2(REWRITTEN_PLAN),
  });
  const { deps } = runtimeDeps(sdk);
  const rt = createReviewRuntime(deps as never);

  assert.equal(rt.isRoundActive(), false, "idle before any round");
  const round = rt.runRound({
    planText: ORIGINAL_PLAN,
    planPath: ".pi/plans/2026-09-18-csv.md",
    round: 1,
  });
  assert.equal(rt.isRoundActive(), true, "active while runRound is in flight");
  await round;
  assert.equal(rt.isRoundActive(), false, "cleared once the round returns");
  assert.equal(rt.isAlive(), true, "the session survives the round");
  await rt.teardown();
});

test("runtime: transcript ops stream to the parent; a throwing sink is harmless", async () => {
  const { sdk } = fakeSdk({
    pass1: submitThenFinish(REWRITTEN_PLAN),
    pass2: submitThenFinishPass2(REWRITTEN_PLAN),
  });
  const seen: Array<{ op?: string; kind?: string; text?: string }> = [];
  const good = runtimeDeps(sdk, {
    onTranscriptOps: (ops) => seen.push(...(ops as typeof seen)),
  });
  const rtGood = createReviewRuntime(good.deps as never);
  const res = await rtGood.runRound({
    planText: ORIGINAL_PLAN,
    planPath: ".pi/plans/2026-09-18-csv.md",
    round: 1,
  });
  assert.equal(res.ok, true);
  assert.ok(seen.length > 0, "the parent received transcript ops");
  assert.ok(
    seen.some((op) => op.op === "new" && op.kind === "tool"),
    "action headers are surfaced",
  );
  assert.ok(
    !seen.some((op) => op.kind === "text" || op.kind === "thinking"),
    "prose and reasoning never reach the parent",
  );
  assert.ok(
    rtGood.getTranscript().join("\n").includes("read: plan.md"),
    "the transcript buffer is fed with the action header",
  );
  await rtGood.teardown();

  const bad = runtimeDeps(sdk, {
    onTranscriptOps: () => {
      throw new Error("sink boom");
    },
  });
  const rtBad = createReviewRuntime(bad.deps as never);
  const res2 = await rtBad.runRound({
    planText: ORIGINAL_PLAN,
    planPath: ".pi/plans/2026-09-18-csv.md",
    round: 1,
  });
  assert.equal(
    res2.ok,
    true,
    "a throwing display sink must not break the review",
  );
  await rtBad.teardown();
});

test("runtime: skips verification when findings are low severity or verify is off", async () => {
  const lowFinding = { ...HIGH_FINDING, severity: 3, confidence: 40 };
  const lowScript = fakeSdk({
    pass1: async (c) => {
      await c.tools.review_submit_plan.execute(
        "1",
        {
          planMarkdown: REWRITTEN_PLAN,
          findings: [lowFinding],
          verdict: "approve",
          summary: "minor",
        },
        undefined,
        undefined,
        {},
      );
      await c.tools.review_pass_done.execute(
        "2",
        { pass: 1, verdict: "approve", findings: [lowFinding] },
        undefined,
        undefined,
        {},
      );
    },
  });
  const a = runtimeDeps(lowScript.sdk);
  const rtA = createReviewRuntime(a.deps as never);
  assert.equal(
    (
      await rtA.runRound({
        planText: ORIGINAL_PLAN,
        planPath: "p.md",
        round: 1,
      })
    ).ok,
    true,
  );
  assert.equal(
    lowScript.capture.followUps.length,
    0,
    "low-severity findings skip pass 2",
  );

  const offScript = fakeSdk({
    pass1: submitThenFinish(REWRITTEN_PLAN),
    pass2: submitThenFinishPass2(REWRITTEN_PLAN),
  });
  const b = runtimeDeps(offScript.sdk, { config: { verify: false } });
  const rtB = createReviewRuntime(b.deps as never);
  await rtB.runRound({ planText: ORIGINAL_PLAN, planPath: "p.md", round: 1 });
  assert.equal(
    offScript.capture.followUps.length,
    0,
    "verify:false skips pass 2",
  );
});

test("runtime: a reviewer that ends its run without submitting fails fast, not after the timeout", async () => {
  const silent = fakeSdk({ pass1: async () => {} });
  // A long timeout proves the failure comes from the run settling, not a clock.
  const { deps, logs } = runtimeDeps(silent.sdk, {
    config: { timeoutMs: 60_000 },
  });
  const rt = createReviewRuntime(deps as never);
  const t0 = Date.now();
  const res = await rt.runRound({
    planText: ORIGINAL_PLAN,
    planPath: "p.md",
    round: 1,
  });
  const elapsed = Date.now() - t0;

  assert.equal(res.ok, false);
  assert.equal(res.fallback, true);
  assert.equal(
    res.planText,
    ORIGINAL_PLAN,
    "author's plan is preserved verbatim",
  );
  assert.ok(elapsed < 1000, `settled immediately (took ${elapsed}ms)`);
  assert.match(res.reason ?? "", /without submitting/);
  assert.ok(
    !logs.some((l) => l.includes("timed out") || l.includes("hit its")),
    "no timeout is burned on a run that already ended",
  );
  assert.ok(silent.capture.aborts >= 1, "the abandoned run is cancelled");
});

test("runtime: a provider failure that ends pass 1 is named in the failure reason", async () => {
  const dying = fakeSdk({
    pass1: async (c) => {
      c.emit({
        type: "auto_retry_start",
        attempt: 1,
        maxAttempts: 3,
        delayMs: 5,
        errorMessage:
          "No API key found for synthetic.\nUse /login (see docs/providers.md)",
      });
      c.emit({
        type: "auto_retry_end",
        success: false,
        attempt: 3,
        finalError: "429 Too Many Requests: quota exceeded",
      });
    },
  });
  const { deps } = runtimeDeps(dying.sdk, {
    config: { timeoutMs: 60_000 },
  });
  const rt = createReviewRuntime(deps as never);
  const res = await rt.runRound({
    planText: ORIGINAL_PLAN,
    planPath: "p.md",
    round: 1,
  });

  assert.equal(res.ok, false);
  assert.equal(res.fallback, true);
  assert.equal(res.planText, ORIGINAL_PLAN, "author's plan is preserved");
  assert.match(res.reason ?? "", /provider failed after 3 retry attempt\(s\)/);
  assert.match(res.reason ?? "", /429 Too Many Requests: quota exceeded/);
  assert.ok(
    !(res.reason ?? "").includes("without submitting"),
    "a dead provider is not mislabeled as a missing write path",
  );
  assert.equal(res.state.error, res.reason, "/review-status sees the cause");
  assert.match(res.reason ?? "", /after \d+s/, "the failure names elapsed time");
  assert.deepEqual(res.state.recoveryAttempts, ["p/m (xhigh)"]);
  assert.match(res.state.providerError ?? "", /429 Too Many Requests/);
  assert.ok(dying.capture.aborts >= 1, "the dead run is cancelled");
});

test("runtime: an error-stop agent_end with no retries also names the provider", async () => {
  const dying = fakeSdk({
    pass1: async (c) => {
      c.emit({
        type: "agent_end",
        messages: [
          { role: "user", content: "x" },
          {
            role: "assistant",
            content: [],
            stopReason: "error",
            errorMessage: "503 upstream connect error",
          },
        ],
      });
    },
  });
  const { deps } = runtimeDeps(dying.sdk, {
    config: { timeoutMs: 60_000 },
  });
  const rt = createReviewRuntime(deps as never);
  const res = await rt.runRound({
    planText: ORIGINAL_PLAN,
    planPath: "p.md",
    round: 1,
  });

  assert.equal(res.ok, false);
  assert.equal(res.fallback, true);
  assert.match(
    res.reason ?? "",
    /provider failed after 0 retry attempt\(s\) on p\/m \(xhigh\): 503 upstream connect error/,
  );
});

test("runtime: a provider error in pass 1 does not leak into a clean pass 2", async () => {
  const flaky = fakeSdk({
    pass1: async (c) => {
      // A transient failure the retry recovered from...
      c.emit({
        type: "auto_retry_start",
        attempt: 1,
        errorMessage: "429 slow down",
      });
      // ...then the reviewer completes the protocol normally.
      await c.tools.review_submit_plan.execute(
        "1",
        {
          planMarkdown: REWRITTEN_PLAN,
          findings: [HIGH_FINDING],
          verdict: "revise",
          summary: "aligned",
        },
        undefined,
        undefined,
        {},
      );
      await c.tools.review_pass_done.execute(
        "2",
        { pass: 1, verdict: "revise", findings: [HIGH_FINDING] },
        undefined,
        undefined,
        {},
      );
    },
    // Pass 2 settles silently (no submission): verification is best-effort.
    pass2: async () => {},
  });
  const { deps, logs } = runtimeDeps(flaky.sdk, {
    config: { timeoutMs: 60_000, verify: true, passes: 2 },
  });
  const rt = createReviewRuntime(deps as never);
  const res = await rt.runRound({
    planText: ORIGINAL_PLAN,
    planPath: "p.md",
    round: 1,
  });

  assert.equal(res.ok, true, "pass 1's submitted plan still wins");
  assert.equal(res.fallback, false);
  assert.ok(
    res.planText.includes("Result<string, ExportError>"),
    "the submitted plan is used",
  );
  assert.ok(
    !logs.some((l) => l.includes("ended without a submission")),
    "pass 1's stale provider error must not accuse pass 2",
  );
});

test("runtime: a hung reviewer run is bounded by timeoutMs and aborted", async () => {
  const hung = fakeSdk({ pass1: () => new Promise<void>(() => {}) });
  const { deps, logs } = runtimeDeps(hung.sdk, {
    config: { timeoutMs: 1200 },
  });
  const rt = createReviewRuntime(deps as never);
  const t0 = Date.now();
  const res = await rt.runRound({
    planText: ORIGINAL_PLAN,
    planPath: "p.md",
    round: 1,
  });
  const elapsed = Date.now() - t0;

  assert.equal(res.ok, false);
  assert.equal(res.fallback, true);
  assert.equal(res.planText, ORIGINAL_PLAN);
  assert.ok(
    elapsed >= 900 && elapsed < 5000,
    `bounded by the timeout (took ${elapsed}ms)`,
  );
  assert.match(res.reason ?? "", /did not finish within/);
  assert.ok(logs.some((l) => l.includes("hit its")), "the limit is reported");
  assert.ok(hung.capture.aborts >= 1, "the stalled run is cancelled");
});

test("runtime: a submission made before a stalled run is still used", async () => {
  const stalled = fakeSdk({
    pass1: async (c) => {
      await c.tools.review_submit_plan.execute(
        "1",
        {
          planMarkdown: REWRITTEN_PLAN,
          findings: [],
          verdict: "approve",
          summary: "sound",
        },
        undefined,
        undefined,
        {},
      );
      await new Promise<void>(() => {}); // the model never ends its turn
    },
  });
  const { deps, logs } = runtimeDeps(stalled.sdk, {
    config: { timeoutMs: 1200, verify: false },
  });
  const rt = createReviewRuntime(deps as never);
  const res = await rt.runRound({
    planText: ORIGINAL_PLAN,
    planPath: "p.md",
    round: 1,
  });

  assert.equal(res.ok, true);
  assert.equal(res.fallback, false);
  assert.ok(
    res.planText.includes("Result<string, ExportError>"),
    "the submitted plan is used, not the author's",
  );
  assert.ok(
    logs.some((l) => l.includes("exceeded its time limit after submitting")),
    "the slow pass is reported",
  );
  assert.ok(stalled.capture.aborts >= 1, "the run is cancelled after handing off");
});

test("runtime: chunked submission writes the plan once, on finalize", async () => {
  const head = REWRITTEN_PLAN.slice(0, 120);
  const tail = REWRITTEN_PLAN.slice(120);
  const sdk = fakeSdk({
    pass1: async (c) => {
      await c.tools.review_plan_begin.execute(
        "b",
        { totalChunks: 2 },
        undefined,
        undefined,
        {},
      );
      await c.tools.review_plan_chunk.execute(
        "c1",
        { index: 1, content: head },
        undefined,
        undefined,
        {},
      );
      const tooEarly = (await c.tools.review_plan_finalize.execute(
        "f0",
        { findings: [], verdict: "approve", summary: "early" },
        undefined,
        undefined,
        {},
      )) as { isError?: boolean; content: Array<{ text: string }> };
      assert.equal(tooEarly.isError, true, "chunk 2 is still missing");
      await c.tools.review_plan_chunk.execute(
        "c2",
        { index: 2, content: tail },
        undefined,
        undefined,
        {},
      );
      await c.tools.review_plan_finalize.execute(
        "f1",
        { findings: [HIGH_FINDING], verdict: "revise", summary: "chunked" },
        undefined,
        undefined,
        {},
      );
    },
  });
  const { deps } = runtimeDeps(sdk.sdk, { config: { verify: false } });
  const rt = createReviewRuntime(deps as never);
  const res = await rt.runRound({
    planText: ORIGINAL_PLAN,
    planPath: ".pi/plans/x.md",
    round: 1,
  });

  assert.equal(res.ok, true, res.reason);
  assert.ok(
    res.planText.startsWith(REWRITTEN_PLAN),
    "the assembled chunks are the plan body",
  );
  assert.ok(
    res.planText.includes("Review changes"),
    "the changelog is appended exactly as the one-shot path would",
  );
  assert.equal(sdk.capture.tools.review_plan_finalize !== undefined, true);
});

test("runtime: abort clears partial chunks so a retry starts clean", async () => {
  let rtRef: ReturnType<typeof createReviewRuntime> | undefined;
  const sdk = fakeSdk({
    pass1: async (c) => {
      await c.tools.review_plan_begin.execute(
        "b",
        { totalChunks: 2 },
        undefined,
        undefined,
        {},
      );
      await c.tools.review_plan_chunk.execute(
        "c1",
        { index: 1, content: "partial rewrite" },
        undefined,
        undefined,
        {},
      );
      await rtRef?.abortRound();
    },
  });
  const { deps } = runtimeDeps(sdk.sdk, { config: { verify: false } });
  const rt = createReviewRuntime(deps as never);
  rtRef = rt;

  const res = await rt.runRound({
    planText: ORIGINAL_PLAN,
    planPath: ".pi/plans/x.md",
    round: 1,
  });
  assert.equal(res.ok, false);

  const late = (await sdk.capture.tools.review_plan_finalize.execute(
    "f",
    { findings: [], verdict: "approve", summary: "late" },
    undefined,
    undefined,
    {},
  )) as { isError?: boolean; content: Array<{ text: string }> };
  assert.equal(late.isError, true, "the aborted assembly is gone");
  assert.match(late.content[0].text, /no complete plan/);
});

test("runtime: a round with no plan path never starts the reviewer", async () => {
  const unused = fakeSdk({});
  const { deps } = runtimeDeps(unused.sdk);
  const rt = createReviewRuntime(deps as never);
  const res = await rt.runRound({
    planText: ORIGINAL_PLAN,
    planPath: "",
    round: 1,
  });

  assert.equal(res.ok, false);
  assert.equal(res.fallback, true);
  assert.match(res.reason ?? "", /no plan path/);
  assert.equal(unused.capture.prompts.length, 0, "no reviewer run is spent");
  assert.equal(rt.isAlive(), false);
});

test("runtime: missing reviewer model and failed session creation both fall back cleanly", async () => {
  const silent = fakeSdk({});
  const noModel = runtimeDeps(silent.sdk, { reviewerModel: null });
  const rtA = createReviewRuntime(noModel.deps as never);
  const resA = await rtA.runRound({
    planText: ORIGINAL_PLAN,
    planPath: "p.md",
    round: 1,
  });
  assert.equal(resA.ok, false);
  assert.equal(resA.planText, ORIGINAL_PLAN);
  assert.ok(noModel.logs.some((l) => l.includes("no reviewer model")));

  const broken = fakeSdk({ shouldThrowOnCreate: true });
  const rtB = createReviewRuntime(runtimeDeps(broken.sdk).deps as never);
  const resB = await rtB.runRound({
    planText: ORIGINAL_PLAN,
    planPath: "p.md",
    round: 1,
  });
  assert.equal(resB.ok, false);
  assert.equal(resB.fallback, true);
  assert.equal(resB.planText, ORIGINAL_PLAN);
});

test("runtime: abort releases a waiting round without losing the author's plan", async () => {
  const silent = fakeSdk({ pass1: () => new Promise<void>(() => {}) });
  const { deps } = runtimeDeps(silent.sdk, { config: { timeoutMs: 8000 } });
  const rt = createReviewRuntime(deps as never);
  const running = rt.runRound({
    planText: ORIGINAL_PLAN,
    planPath: "p.md",
    round: 1,
  });
  await new Promise((r) => setTimeout(r, 30));
  await rt.abortRound();
  const res = await running;
  assert.equal(res.ok, false);
  assert.equal(res.fallback, true);
});

test("runtime: with no cap a hung reviewer never auto-fails; abort still ends the round", async () => {
  const hung = fakeSdk({ pass1: () => new Promise<void>(() => {}) });
  const { deps, logs } = runtimeDeps(hung.sdk, { config: { timeoutMs: 0 } });
  const rt = createReviewRuntime(deps as never);
  let settled = false;
  const running = rt
    .runRound({ planText: ORIGINAL_PLAN, planPath: "p.md", round: 1 })
    .then((r) => {
      settled = true;
      return r;
    });
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(settled, false, "no timer fires when the cap is disabled");
  assert.ok(
    logs.some((l) => l.includes("no time limit configured")),
    "unlimited mode is reported",
  );
  await rt.abortRound();
  const res = await running;
  assert.equal(res.ok, false);
  assert.equal(res.fallback, true);
  assert.equal(res.planText, ORIGINAL_PLAN, "the author's plan is kept");
  assert.ok(hung.capture.aborts >= 1, "the stalled run is cancelled");
});

test("runtime: the parent surface reaches the reviewer session via deps", async () => {
  const child = childRuntimeDouble();
  const parent = parentSurfaceDouble({
    ids: ["synthetic"],
    configs: { synthetic: SYNTHETIC_CONFIG },
  });
  const { sdk } = fakeSdk({ runtime: child.runtime });
  const { deps } = runtimeDeps(sdk, { parentProviders: parent });
  const rt = createReviewRuntime(deps as never);

  const ok = await rt.ensureStarted();
  assert.equal(ok, true);
  assert.ok(
    child.registered.has("synthetic"),
    "deps.parentProviders flows into createReviewSession and seeds the child",
  );
});

test("runtime: without a parent surface the reviewer still starts (providers unresolved is not fatal at startup)", async () => {
  const { sdk } = fakeSdk({});
  const { deps } = runtimeDeps(sdk, {});
  const rt = createReviewRuntime(deps as never);
  assert.equal(await rt.ensureStarted(), true);
});

test("runtime: a mid-review provider-auth failure gains the actionable hint", async () => {
  const failPrompt = new Error(
    "No API key found for synthetic.\n\nUse /login to log into a provider via OAuth or API key.",
  );
  const silent = fakeSdk({ failPrompt1: failPrompt });
  const { deps } = runtimeDeps(silent.sdk, {
    reviewerModel: {
      provider: "synthetic",
      id: "hf:zai-org/GLM-5.3-Flash",
      thinking: "xhigh",
    },
  });
  const rt = createReviewRuntime(deps as never);
  const res = await rt.runRound({
    planText: ORIGINAL_PLAN,
    planPath: "p.md",
    round: 1,
  });
  assert.equal(res.ok, false);
  assert.match(
    res.reason ?? "",
    /could not prompt the reviewer on synthetic\/hf:zai-org\/GLM-5.3-Flash \(xhigh\): No API key found for synthetic\./,
    "the original error text is kept",
  );
  assert.match(res.reason ?? "", /models\.json/, "the escape hatch is named");
  assert.match(res.reason ?? "", /\/login synthetic/);
});

test("runtime: a provider-auth failure for a DIFFERENT provider gains no hint", async () => {
  const silent = fakeSdk({
    failPrompt1: new Error("No API key found for openai."),
  });
  const { deps } = runtimeDeps(silent.sdk, {});
  const rt = createReviewRuntime(deps as never);
  const res = await rt.runRound({
    planText: ORIGINAL_PLAN,
    planPath: "p.md",
    round: 1,
  });
  assert.equal(res.ok, false);
  assert.match(res.reason ?? "", /No API key found for openai\./);
  assert.equal(
    (res.reason ?? "").includes("models.json"),
    false,
    "an unrelated provider's failure is not decorated",
  );
});

test("review gate: a wait with no timeout resolves only when the pass ends", async () => {
  const gate = createReviewRoundGate();
  let resolved = false;
  const waiting = gate.waitForPassDone(undefined).then((r) => {
    resolved = true;
    return r;
  });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(resolved, false, "no timer can resolve an uncapped wait");
  gate.notifyPassDone({
    pass: 1,
    verdict: "approve",
    findings: [],
    at: Date.now(),
  });
  const result = await waiting;
  assert.equal(result?.verdict, "approve");

  const timed = createReviewRoundGate();
  assert.equal(
    await timed.waitForPassDone(20),
    undefined,
    "a configured cap still expires the wait",
  );
});

test("buildPass1Prompt / buildPass2Prompt contain the contract, not the reviewer's private context", () => {
  const p1 = buildPass1Prompt({
    planPath: ".pi/plans/x.md",
    planText: ORIGINAL_PLAN,
    reviewPrompt: "GUIDANCE",
    contextBlock: "CONTEXT",
    round: 1,
    totalRounds: 1,
    verify: true,
  });
  assert.ok(
    p1.includes("GUIDANCE") &&
      p1.includes("CONTEXT") &&
      p1.includes(ORIGINAL_PLAN),
  );
  assert.ok(
    p1.includes("review_submit_plan") && p1.includes("review_pass_done"),
  );
  assert.ok(p1.includes("PASS 1 of 2"));
  assert.ok(
    p1.includes("If the harness retries") && p1.includes("## Recovery"),
    "pass 1 tells the reviewer how a recovery retry works",
  );

  const p2 = buildPass2Prompt({
    planPath: ".pi/plans/x.md",
    originalPlan: ORIGINAL_PLAN,
    rewrittenPlan: REWRITTEN_PLAN,
    findings: [HIGH_FINDING],
  });
  assert.ok(p2.includes("PASS 2 of 2"));
  // Step 9: pass 2 carries a diff, not two full plans.
  assert.ok(p2.includes("@@"), "pass 2 shows a unified diff");
  assert.ok(
    p2.includes("returning Result<string, ExportError>"),
    "diff shows the changed line",
  );
  assert.ok(
    p2.includes("```diff"),
    "pass 2 carries the rewrite as a diff block",
  );
  assert.ok(!p2.includes(ORIGINAL_PLAN), "no verbatim original plan");
  assert.ok(!p2.includes(REWRITTEN_PLAN), "no verbatim rewritten plan");
  assert.ok(p2.includes("List anything lost"), "pass 2 asks what was lost");
});

test("buildPass1Prompt: chunked mode is chosen by plan size, and 0 disables it", () => {
  const base = {
    planPath: ".pi/plans/x.md",
    reviewPrompt: "G",
    contextBlock: "",
    round: 1,
    totalRounds: 1,
    verify: false,
  };

  // Long plan, chunking on: the chunked protocol replaces the one-shot ask.
  const chunked = buildPass1Prompt({
    ...base,
    planText: "x".repeat(400),
    chunkChars: 100,
  });
  assert.ok(chunked.includes("## Chunked submission"), "chunked section present");
  for (const name of [
    "review_plan_begin",
    "review_plan_chunk",
    "review_plan_finalize",
  ]) {
    assert.ok(chunked.includes(name), `${name} is named`);
  }
  assert.ok(
    chunked.includes("at most 100 characters"),
    "the chunk budget is stated",
  );
  assert.ok(
    !chunked.includes(
      "1. `review_submit_plan` with the COMPLETE revised plan",
    ),
    "the one-shot instruction is replaced, not duplicated",
  );

  // Short plan: one-shot stays, even with chunking enabled.
  const short = buildPass1Prompt({
    ...base,
    planText: "x".repeat(150),
    chunkChars: 100,
  });
  assert.ok(!short.includes("## Chunked submission"));
  assert.ok(short.includes("review_submit_plan"));

  // chunkChars: 0 is the explicit off switch for a long plan.
  const off = buildPass1Prompt({
    ...base,
    planText: "x".repeat(400),
    chunkChars: 0,
  });
  assert.ok(!off.includes("## Chunked submission"));
  assert.ok(off.includes("1. `review_submit_plan` with the COMPLETE revised plan"));
});

test("runtime: a chunked pass 1 feeds pass 2 the assembled rewrite", async () => {
  const pieces: string[] = [];
  for (let i = 0; i < REWRITTEN_PLAN.length; i += 100) {
    pieces.push(REWRITTEN_PLAN.slice(i, i + 100));
  }
  assert.ok(pieces.length > 2, "the fixture really needs several chunks");
  const sdk = fakeSdk({
    pass1: async (c) => {
      assert.ok(
        c.prompts[0].includes("## Chunked submission"),
        "the plan is long enough for chunked mode",
      );
      await c.tools.review_plan_begin.execute(
        "b",
        { totalChunks: pieces.length },
        undefined,
        undefined,
        {},
      );
      for (const [i, content] of pieces.entries()) {
        const r = (await c.tools.review_plan_chunk.execute(
          `c${i}`,
          { index: i + 1, content },
          undefined,
          undefined,
          {},
        )) as { isError?: boolean; content: Array<{ text: string }> };
        assert.equal(r.isError, undefined, `chunk ${i + 1} accepted`);
      }
      await c.tools.review_plan_finalize.execute(
        "f1",
        { findings: [HIGH_FINDING], verdict: "revise", summary: "chunked" },
        undefined,
        undefined,
        {},
      );
      await c.tools.review_pass_done.execute(
        "p1",
        { pass: 1, verdict: "revise", findings: [HIGH_FINDING] },
        undefined,
        undefined,
        {},
      );
    },
    pass2: submitThenFinishPass2(REWRITTEN_PLAN),
  });
  const { deps } = runtimeDeps(sdk.sdk, { config: { chunkChars: 100 } });
  const rt = createReviewRuntime(deps as never);
  const res = await rt.runRound({
    planText: ORIGINAL_PLAN,
    planPath: ".pi/plans/x.md",
    round: 1,
  });

  assert.equal(res.ok, true, res.reason);
  assert.equal(sdk.capture.followUps.length, 1, "pass 2 ran");
  assert.ok(
    sdk.capture.followUps[0].includes("returning Result<string, ExportError>"),
    "pass 2 diffs the ASSEMBLED rewrite",
  );
});

// ══ Step 37 (automated): Review Mode disabled ⇒ no-op ═════════════════

// ══ Provider seeding: the reviewer runtime composes what the parent knows ══

/**
 * A child `ModelRuntime` double that records every registration and reports
 * the provider ids it already composes — exactly the surface the seeder's
 * present-probe reads.
 */
function childRuntimeDouble(options: {
  /** Ids the child composes BEFORE any seeding (built-ins / models.json). */
  presentIds?: string[];
  /** Auth verdict per provider; defaults to "configured" for every id. */
  hasAuth?: (providerId: string) => boolean;
  /** Make `registerProvider` throw for this id (per-provider tolerance). */
  failRegistrationFor?: string;
} = {}) {
  const calls: string[] = [];
  const registered = new Map<string, unknown>();
  const registeredNative = new Map<string, unknown>();
  const present = new Set(options.presentIds ?? []);
  const hasAuth = options.hasAuth ?? (() => true);
  const runtime = {
    /** Shared with the return value: every registration appends here. */
    calls,
    getRegisteredProviderIds: () => [
      ...present,
      ...registered.keys(),
      ...registeredNative.keys(),
    ],
    registerProvider: (id: string, config: unknown) => {
      calls.push(`registerProvider:${id}`);
      if (id === options.failRegistrationFor) {
        throw new Error(`bad registration for ${id}`);
      }
      registered.set(id, config);
    },
    registerNativeProvider: (provider: { id: string }) => {
      calls.push(`registerNativeProvider:${provider.id}`);
      registeredNative.set(provider.id, provider);
    },
    hasConfiguredAuth: (providerId: string) => hasAuth(providerId),
    checkAuth: async (providerId: string) =>
      hasAuth(providerId) ? { ok: true } : undefined,
  };
  return { runtime, calls, registered, registeredNative };
}

/** A parent-side provider surface double (registry facade or runtime shape). */
function parentSurfaceDouble(options: {
  ids: string[];
  configs?: Record<string, unknown>;
  natives?: Record<string, unknown>;
}) {
  return {
    getRegisteredProviderIds: () => [...options.ids],
    getRegisteredProviderConfig: (id: string) => options.configs?.[id],
    getRegisteredNativeProvider: (id: string) => options.natives?.[id],
  };
}

/** An SDK double whose ModelRuntime.create() hands out a given child runtime. */
function seedingSdk(childRuntime: unknown, calls: string[]) {
  let sessionOpts: Record<string, unknown> | undefined;
  const sdk = {
    ModelRuntime: { create: async () => childRuntime },
    DefaultResourceLoader: class {
      async reload() {}
    },
    SessionManager: { inMemory: () => ({}) },
    createAgentSession: async (opts: Record<string, unknown>) => {
      calls.push("createAgentSession");
      sessionOpts = opts;
      return {
        session: {
          subscribe: () => () => {},
          prompt: async () => {},
          followUp: async () => {},
          abort: async () => {},
          isStreaming: false,
          bindExtensions: async () => {},
        },
      };
    },
  };
  return { sdk, sessionOpts: () => sessionOpts };
}

const SYNTHETIC_CONFIG = {
  baseUrl: "https://api.synthetic.new/openai/v1",
  apiKey: "$SYNTHETIC_API_KEY",
  api: "openai-completions",
  models: [{ id: "hf:zai-org/GLM-5.3-Flash", name: "zai-org/GLM-5.3-Flash" }],
};

async function seedingSession(input: {
  child: unknown;
  parent: unknown;
  modelRef?: { provider: string; id: string; thinking: string };
  findModel?: (provider: string, id: string) => unknown;
}) {
  const calls: string[] = input.child && (input.child as { calls?: string[] }).calls
    ? ((input.child as { calls: string[] }).calls)
    : [];
  const { sdk, sessionOpts } = seedingSdk(input.child, calls);
  const res = await createReviewSession({
    cwd: "/p",
    agentDir: "/a",
    modelRef: input.modelRef ?? {
      provider: "synthetic",
      id: "hf:zai-org/GLM-5.3-Flash",
      thinking: "xhigh",
    },
    findModel:
      input.findModel ??
      ((provider: string, id: string) => ({ provider, id })),
    reviewPrompt: "x",
    customTools: [],
    parentProviders: input.parent,
    loadSdk: async () => sdk as never,
  });
  return { res, calls, sessionOpts };
}

test("createReviewSession: seeds missing providers from the parent surface before createAgentSession", async () => {
  // Child already composes the built-in "anthropic"; the parent knows that,
  // an extension-registered "synthetic" (missing in the child) and a native
  // provider. The seeder must register ONLY what is missing, BEFORE the
  // session is created.
  const child = childRuntimeDouble({ presentIds: ["anthropic"] });
  const parent = parentSurfaceDouble({
    ids: ["synthetic", "anthropic", "native-one"],
    configs: { synthetic: SYNTHETIC_CONFIG },
    natives: { "native-one": { id: "native-one" } },
  });
  const { res, calls } = await seedingSession({ child: child.runtime, parent });

  assert.equal(res.ok, true, res.error);
  const firstRegistration = calls.findIndex((c) => c.startsWith("register"));
  const createAt = calls.indexOf("createAgentSession");
  assert.ok(
    firstRegistration !== -1 && createAt !== -1 && firstRegistration < createAt,
    `registrations must land before createAgentSession (${calls.join(" → ")})`,
  );
  assert.ok(
    calls.includes("registerProvider:synthetic"),
    `the missing extension provider is registered (${calls.join(", ")})`,
  );
  assert.ok(
    calls.includes("registerNativeProvider:native-one"),
    `native providers register natively (${calls.join(", ")})`,
  );
  assert.equal(
    calls.includes("registerProvider:anthropic"),
    false,
    "a provider the child already composes is never re-registered",
  );
});

test("seedChildRuntimeProviders: skips ids the child already composes (the built-in/static no-op path)", () => {
  const child = childRuntimeDouble({ presentIds: ["synthetic", "other"] });
  const parent = parentSurfaceDouble({
    ids: ["synthetic", "other", "missing"],
    configs: { missing: SYNTHETIC_CONFIG },
  });
  const report = seedChildRuntimeProviders(child.runtime, parent);
  assert.deepEqual(report.seeded, ["missing"]);
  assert.deepEqual(report.skippedPresent, ["synthetic", "other"]);
  assert.deepEqual(report.errors, []);
  assert.equal(child.calls.includes("registerProvider:synthetic"), false);
  assert.equal(child.calls.includes("registerProvider:other"), false);
  assert.deepEqual(child.calls, ["registerProvider:missing"]);
});

test("seedChildRuntimeProviders: collects the gap without registering anything", () => {
  const child = childRuntimeDouble({ presentIds: ["a"] });
  const parent = parentSurfaceDouble({ ids: ["a", "b"], configs: {} });
  const gap = collectMissingChildProviders(child.runtime, parent);
  assert.deepEqual(gap.missing, ["b"]);
  assert.deepEqual(gap.present, ["a"]);
  assert.equal(child.calls.length, 0, "the scan never mutates the child");
});

test("seedChildRuntimeProviders: a throwing registration is recorded and the rest still seed", () => {
  const child = childRuntimeDouble({ failRegistrationFor: "broken" });
  const parent = parentSurfaceDouble({
    ids: ["broken", "good"],
    configs: { broken: {}, good: SYNTHETIC_CONFIG },
  });
  const report = seedChildRuntimeProviders(child.runtime, parent);
  assert.deepEqual(report.seeded, ["good"], "unrelated ids still seed");
  assert.equal(report.errors.length, 1);
  assert.equal(report.errors[0].name, "broken");
  assert.match(report.errors[0].error, /bad registration for broken/);
});

test("seedChildRuntimeProviders: native provider objects register natively, not by config", () => {
  const child = childRuntimeDouble();
  const parent = parentSurfaceDouble({
    ids: ["native-one"],
    natives: { "native-one": { id: "native-one", getModels: () => [] } },
  });
  const report = seedChildRuntimeProviders(child.runtime, parent);
  assert.deepEqual(report.seeded, ["native-one"]);
  assert.deepEqual(child.calls, ["registerNativeProvider:native-one"]);
  assert.ok(child.registeredNative.has("native-one"));
  assert.equal(child.registered.has("native-one"), false);
});

test("seedChildRuntimeProviders: an id with no copyable registration is an error, not a crash", () => {
  const child = childRuntimeDouble();
  const parent = parentSurfaceDouble({ ids: ["ghost"], configs: {} });
  const report = seedChildRuntimeProviders(child.runtime, parent);
  assert.deepEqual(report.seeded, []);
  assert.equal(report.errors.length, 1);
  assert.equal(report.errors[0].name, "ghost");
  assert.match(report.errors[0].error, /no registration to copy/);
});

test("seedChildRuntimeProviders: a second pass skips already-seeded ids (idempotent)", () => {
  const child = childRuntimeDouble();
  const parent = parentSurfaceDouble({
    ids: ["synthetic"],
    configs: { synthetic: SYNTHETIC_CONFIG },
  });
  const first = seedChildRuntimeProviders(child.runtime, parent);
  assert.deepEqual(first.seeded, ["synthetic"]);
  const second = seedChildRuntimeProviders(child.runtime, parent);
  assert.deepEqual(second.seeded, []);
  assert.deepEqual(second.skippedPresent, ["synthetic"]);
  assert.deepEqual(second.errors, []);
  assert.deepEqual(child.calls, ["registerProvider:synthetic"]);
});

test("seedChildRuntimeProviders: no parent surface is a clean no-op, never a throw", () => {
  const child = childRuntimeDouble();
  for (const surface of [undefined, null, {}, 42, "x"]) {
    const report = seedChildRuntimeProviders(child.runtime, surface);
    assert.deepEqual(report, { seeded: [], skippedPresent: [], errors: [] });
  }
  assert.equal(child.calls.length, 0);
});

test("findParentProviderSurface: probes the documented surfaces in order, junk-tolerant", () => {
  const registry = parentSurfaceDouble({ ids: [] });
  const runtime = parentSurfaceDouble({ ids: [] });
  assert.equal(
    findParentProviderSurface({ modelRegistry: registry, modelRuntime: runtime }),
    registry,
    "the registry facade is probed first",
  );
  assert.equal(findParentProviderSurface({ modelRuntime: runtime }), runtime);
  assert.equal(findParentProviderSurface(undefined), undefined);
  assert.equal(findParentProviderSurface(null), undefined);
  assert.equal(findParentProviderSurface("junk"), undefined);
  assert.equal(findParentProviderSurface({}), undefined);
  // A partial surface (id list only) cannot seed anything — not a surface.
  assert.equal(
    findParentProviderSurface({
      modelRegistry: { getRegisteredProviderIds: () => [] },
    }),
    undefined,
  );
});

test("createReviewSession: a broken unrelated provider registration does not block the review", async () => {
  const child = childRuntimeDouble({ failRegistrationFor: "broken" });
  const parent = parentSurfaceDouble({
    ids: ["broken", "synthetic"],
    configs: { broken: {}, synthetic: SYNTHETIC_CONFIG },
  });
  const { res } = await seedingSession({ child: child.runtime, parent });
  assert.equal(res.ok, true, res.error);
  assert.ok(child.registered.has("synthetic"), "the reviewer's provider still seeded");
});

test("createReviewSession: unconfigured reviewer provider fails fast with the seed report and the escape hatch", async () => {
  const child = childRuntimeDouble({ hasAuth: () => false });
  const parent = parentSurfaceDouble({
    ids: ["synthetic"],
    configs: { synthetic: SYNTHETIC_CONFIG },
  });
  const { res } = await seedingSession({ child: child.runtime, parent });

  assert.equal(res.ok, false);
  assert.equal(res.session, undefined);
  assert.match(res.error ?? "", /"synthetic"/, "names the provider");
  assert.match(res.error ?? "", /seeded into the reviewer runtime/, "reports the seed result");
  assert.match(res.error ?? "", /models\.json/, "names the generic escape hatch");
  assert.match(res.error ?? "", /\/login synthetic/);
  // Seeding happened BEFORE the preflight failed: the provider is registered
  // on the child even though auth could not be resolved for it.
  assert.ok(child.registered.has("synthetic"));
});

test("createReviewSession: no parent surface ⇒ no seeding, preflight still names the escape hatch", async () => {
  const child = childRuntimeDouble({ hasAuth: () => false });
  const { res, calls } = await seedingSession({
    child: child.runtime,
    parent: undefined,
  });

  assert.equal(res.ok, false);
  assert.deepEqual(
    calls.filter((c) => c.startsWith("register")),
    [],
    "nothing is seeded without a parent surface",
  );
  assert.match(res.error ?? "", /no provider-registration surface/);
  assert.match(res.error ?? "", /models\.json/);
});

test("createReviewSession: a runtime that exposes no auth accessor is trusted, not blocked", async () => {
  // Old/stubbed SDKs expose neither hasConfiguredAuth nor checkAuth — the
  // preflight must not block a review it cannot verify.
  const { res } = await seedingSession({
    child: { registerProvider: () => {}, registerNativeProvider: () => {} },
    parent: parentSurfaceDouble({
      ids: ["synthetic"],
      configs: { synthetic: SYNTHETIC_CONFIG },
    }),
  });
  assert.equal(res.ok, true, res.error);
});

test("appendProviderAuthHint: only the reviewer's own provider-auth failure gains the hint", () => {
  const bare = "No API key found for synthetic.\n\nUse /login to log into a provider via OAuth or API key.";
  const hinted = appendProviderAuthHint(bare, "synthetic", "C:/agent/models.json");
  assert.ok(hinted.startsWith(bare), "the original error is kept verbatim");
  assert.match(hinted, /models\.json/);
  assert.match(hinted, /\/login synthetic/);

  // A different provider failed than the reviewer's own → no hint.
  assert.equal(
    appendProviderAuthHint("No API key found for openai.", "synthetic"),
    "No API key found for openai.",
  );
  // Unrelated errors and absent provider ids are never decorated.
  assert.equal(appendProviderAuthHint("network unreachable", "synthetic"), "network unreachable");
  assert.equal(
    appendProviderAuthHint("No API key found for synthetic.", undefined),
    "No API key found for synthetic.",
  );
});

test("GATING: with Review Mode off, all resolution stays inert", () => {
  const { cwd, agentDir } = tmpProject();
  assert.equal(isReviewEnabled(cwd, agentDir), false);
  assert.equal(readReviewModeConfig(cwd, agentDir).config.enabled, false);
  assert.equal(
    coerceReviewModeConfig(extractReviewModeRaw(undefined)).enabled,
    false,
  );

  // Enabling then disabling returns to inert.
  writeReviewModeConfig("global", cwd, agentDir, { enabled: true });
  assert.equal(isReviewEnabled(cwd, agentDir), true);
  writeReviewModeConfig("global", cwd, agentDir, { enabled: false });
  assert.equal(isReviewEnabled(cwd, agentDir), false);
});

// ══ Plan 2026-10-23 (steps 7–11): fast-path + interactive review ══

test("plan-2026-10-23: verify gate needs severity >= 7 and accepted disposition", () => {
  const base = { ...HIGH_FINDING }; // sev 9, conf 85, accepted
  assert.equal(reviewNeedsVerification([base]), true);
  assert.equal(
    reviewNeedsVerification([{ ...base, severity: 7, confidence: 60 }]),
    true,
    "boundary 7/60 verifies",
  );
  assert.equal(
    reviewNeedsVerification([{ ...base, severity: 6, confidence: 99 }]),
    false,
    "severity 6 no longer verifies",
  );
  assert.equal(
    reviewNeedsVerification([{ ...base, confidence: 59 }]),
    false,
    "low confidence skips",
  );
  assert.equal(
    reviewNeedsVerification([{ ...base, disposition: "rejected" }]),
    false,
    "rejected never verifies",
  );
  assert.equal(
    reviewNeedsVerification([{ ...base, disposition: "deferred" }]),
    false,
    "deferred never verifies",
  );
  assert.equal(reviewNeedsVerification([]), false);
  assert.equal(reviewNeedsVerification(undefined as never), false);
});

test("plan-2026-10-23: buildPlanDiff is a minimal hunk, not two full plans", () => {
  assert.equal(buildPlanDiff(ORIGINAL_PLAN, ORIGINAL_PLAN), "(no differences)");
  assert.equal(buildPlanDiff("", ""), "(no differences)");
  const diff = buildPlanDiff(ORIGINAL_PLAN, REWRITTEN_PLAN);
  assert.ok(diff.startsWith("--- original (author)"), "unified header");
  assert.ok(diff.includes("@@"), "hunk header");
  assert.ok(
    diff.includes("- 1. Add a CSV serializer in src/export/csv.ts\n"),
    "removed line present",
  );
  assert.ok(
    diff.includes(
      "+ 1. Add a CSV serializer in src/export/csv.ts returning Result<string, ExportError>",
    ),
    "added line present",
  );
  assert.ok(
    diff.length < ORIGINAL_PLAN.length + REWRITTEN_PLAN.length,
    "diff is smaller than both full plans",
  );
  const big = `${"x".repeat(20000)}\nmid\n${"y".repeat(20000)}`;
  assert.ok(
    buildPlanDiff(big, big.replace("mid", "MID")).includes("diff truncated"),
    "huge rewrites are capped",
  );
});

test("plan-2026-10-23: manifest is empty for empty/junk input", () => {
  for (const junk of [undefined, null, [], {}, "nope", 42]) {
    const m = buildPlannerContextManifest(junk);
    assert.equal(m.markdown, "");
    assert.equal(m.files, 0);
    assert.equal(m.reconResults, 0);
  }
});

test("plan-2026-10-23: manifest inventories tool paths once, with tokens", () => {
  const entries = [
    {
      type: "message",
      message: {
        role: "assistant",
        content: [
          { type: "toolCall", name: "read", arguments: { path: "src/a.ts" } },
          { type: "toolCall", name: "read", arguments: { path: "src/a.ts" } },
          {
            type: "toolCall",
            name: "grep",
            arguments: { path: "src", file_path: "src/b.ts" },
          },
        ],
      },
    },
    {
      type: "message",
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            name: "write",
            arguments: { path: ".pi/plans/x.md" },
          },
        ],
      },
    },
  ];
  const m = buildPlannerContextManifest(entries, {
    describeFile: (p) => (p.endsWith(".ts") ? "1KB · #deadbeef" : undefined),
  });
  assert.equal(m.files, 4, "src/a.ts, src, src/b.ts, .pi/plans/x.md");
  assert.ok(m.markdown.includes("`src/a.ts` — 1KB · #deadbeef"));
  assert.ok(m.markdown.includes("`.pi/plans/x.md`"));
  assert.ok(!m.markdown.includes("#deadbeef", 0) || m.markdown.includes("`src/b.ts` — 1KB"));
  assert.equal(m.reconResults, 0);
  const capped = buildPlannerContextManifest(entries, { maxFiles: 2 });
  assert.equal(capped.files, 2, "inventory honours maxFiles");
});

test("plan-2026-10-23: manifest keeps newest explore recon first, capped", () => {
  const toolResult = (toolName: string, text: string) => ({
    type: "message",
    message: {
      role: "toolResult",
      toolName,
      content: [{ type: "text", text }],
    },
  });
  const entries = [
    toolResult("read", "some file body"),
    toolResult("explore", "first recon conclusion"),
    toolResult("explore", `padding ${"z".repeat(5000)} MARKER-TAIL`),
  ];
  const m = buildPlannerContextManifest(entries);
  assert.equal(m.reconResults, 2);
  assert.ok(m.markdown.includes("MARKER-TAIL"), "tail of oversized recon kept");
  assert.ok(!m.markdown.includes("padding "), "head of oversized recon elided");
  assert.ok(
    m.markdown.indexOf("MARKER-TAIL") < m.markdown.indexOf("first recon"),
    "newest recon first",
  );
  const one = buildPlannerContextManifest(entries, { maxReconResults: 1 });
  assert.equal(one.reconResults, 1);
  assert.ok(one.markdown.includes("MARKER-TAIL"));
  assert.ok(!one.markdown.includes("first recon"));
});

test("plan-2026-10-23: landing guard never overwrites user edits", () => {
  const inputHash = planHash(ORIGINAL_PLAN);
  const finalHash = planHash(REWRITTEN_PLAN);
  assert.equal(
    classifyReviewLanding({ diskHash: finalHash, inputHash, finalHash }),
    "updated",
  );
  assert.equal(
    classifyReviewLanding({ diskHash: inputHash, inputHash, finalHash }),
    "unchanged",
    "round-cap appendix and pauses announce nothing new",
  );
  assert.equal(
    classifyReviewLanding({ diskHash: undefined, inputHash, finalHash }),
    "unchanged",
    "unreadable disk stays quiet",
  );
  assert.equal(
    classifyReviewLanding({ diskHash: "deadbeef", inputHash, finalHash }),
    "stale",
    "user edits since the review are kept",
  );
});

test("plan-2026-10-23-follow-up: abort during verification keeps pass 1's plan and the session warm", async () => {
  const { capture, sdk } = fakeSdk({
    pass1: submitThenFinish(REWRITTEN_PLAN),
    // Hang the verification pass: only an abort ends it.
    pass2: async () => {
      await new Promise<void>(() => {});
    },
  });
  const { deps } = runtimeDeps(sdk);
  const rt = createReviewRuntime(deps as never);
  assert.equal(await rt.ensureStarted(), true);
  const inFlight = rt.runRound({
    planText: ORIGINAL_PLAN,
    planPath: ".pi/plans/2026-09-18-csv.md",
    round: 1,
  });
  // Wait until the verification pass starts, then abort it.
  const t0 = Date.now();
  while (capture.followUps.length === 0) {
    if (Date.now() - t0 > 10_000)
      throw new Error("verification pass never started");
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.equal(rt.isRoundActive(), true);
  await rt.abortRound();
  const res = await inFlight;
  // Pass 2 is best-effort: the abort keeps pass 1's rewrite, not the draft.
  // (The handoff layer maps this completion to the reviewed plan; a pause
  // that raced it is dropped as stale there.)
  assert.equal(res.ok, true);
  assert.equal(res.fallback, false);
  assert.ok(res.planText.includes("Result<string, ExportError>"));
  assert.equal(rt.isRoundActive(), false);
  assert.equal(rt.isAlive(), true, "abort keeps the session warm");
  await rt.teardown();
});

test("plan-2026-10-23: host abort (ESC) ends the round but keeps the session warm", async () => {
  const { capture, sdk } = fakeSdk({
    pass1: async () => {
      await new Promise<void>(() => {}); // hangs: only an abort ends the run
    },
  });
  const { deps } = runtimeDeps(sdk);
  const rt = createReviewRuntime(deps as never);
  assert.equal(await rt.ensureStarted(), true);
  const ac = new AbortController();
  const inFlight = rt.runRound({
    planText: ORIGINAL_PLAN,
    planPath: ".pi/plans/2026-09-18-csv.md",
    round: 1,
    signal: ac.signal,
  });
  assert.equal(rt.isRoundActive(), true);
  ac.abort(); // ESC
  const res = await inFlight;
  assert.equal(res.ok, false);
  assert.equal(res.reason, "aborted");
  assert.notEqual(
    res.abortedBeforeStart,
    true,
    "a mid-round abort is not a pre-start abort",
  );
  assert.equal(res.planText, ORIGINAL_PLAN, "author's plan kept");
  assert.equal(res.fallback, true);
  assert.ok(capture.aborts >= 1, "the child run was aborted");
  assert.equal(rt.isRoundActive(), false);
  assert.equal(rt.isAlive(), true, "pause keeps the session warm");
  await rt.teardown();
});

test("plan-2026-10-23: abort then resume reuses the warm session", async () => {
  let allowSubmit = false;
  const { sdk } = fakeSdk({
    pass1: async (c) => {
      if (!allowSubmit) {
        await new Promise<void>(() => {}); // hangs until aborted
        return;
      }
      await submitThenFinish(REWRITTEN_PLAN)(c);
    },
    pass2: submitThenFinishPass2(REWRITTEN_PLAN),
  });
  const creations = { n: 0 };
  const origCreate = (
    sdk as { createAgentSession: (o: unknown) => Promise<unknown> }
  ).createAgentSession;
  (
    sdk as { createAgentSession: (o: unknown) => Promise<unknown> }
  ).createAgentSession = async (o) => {
    creations.n += 1;
    return origCreate(o);
  };
  const { deps } = runtimeDeps(sdk);
  const rt = createReviewRuntime(deps as never);
  assert.equal(await rt.ensureStarted(), true);
  assert.equal(creations.n, 1);
  const ac = new AbortController();
  const inFlight = rt.runRound({
    planText: ORIGINAL_PLAN,
    planPath: ".pi/plans/2026-09-18-csv.md",
    round: 1,
    signal: ac.signal,
  });
  ac.abort();
  const paused = await inFlight;
  assert.equal(paused.reason, "aborted");
  assert.notEqual(
    paused.abortedBeforeStart,
    true,
    "the aborted live round did start",
  );
  assert.equal(creations.n, 1, "no reboot on abort");
  allowSubmit = true; // /review-resume on the warm session
  const resumed = await rt.runRound({
    planText: ORIGINAL_PLAN,
    planPath: ".pi/plans/2026-09-18-csv.md",
    round: 1,
  });
  assert.equal(resumed.ok, true, "resume completes on the warm session");
  assert.ok(resumed.planText.includes("Result<string, ExportError>"));
  assert.equal(creations.n, 1, "resume reuses the session");
  await rt.teardown();
});

test("runtime: run labels name a fresh boot, a warm round and the verify pass", async () => {
  const { sdk } = fakeSdk({
    pass1: submitThenFinish(REWRITTEN_PLAN),
    pass2: submitThenFinishPass2(REWRITTEN_PLAN),
  });
  const seen: Array<{ kind?: string; text?: string }> = [];
  const { deps } = runtimeDeps(sdk, {
    onTranscriptOps: (ops) => seen.push(...(ops as typeof seen)),
  });
  const rt = createReviewRuntime(deps as never);
  const statuses = (): string[] =>
    seen
      .filter((op) => op.kind === "status")
      .map((op) => String(op.text ?? ""));

  const first = await rt.runRound({
    planText: ORIGINAL_PLAN,
    planPath: ".pi/plans/2026-09-18-csv.md",
    round: 1,
  });
  assert.equal(first.ok, true);
  assert.ok(
    statuses().includes("reviewer started"),
    "a cold boot says started",
  );
  assert.ok(
    statuses().includes("reviewer verifying — pass 2"),
    "pass 2 names itself instead of re-announcing a boot",
  );

  seen.length = 0;
  const second = await rt.runRound({
    planText: ORIGINAL_PLAN,
    planPath: ".pi/plans/2026-09-18-csv.md",
    round: 2,
  });
  assert.equal(second.ok, true);
  assert.ok(
    statuses().includes("reviewer continuing"),
    "a next round on the warm session is a continuation",
  );
  assert.ok(
    !statuses().includes("reviewer started"),
    "a warm round must not claim a fresh boot",
  );
  await rt.teardown();
});

test("runtime: a resumed round reuses the warm session and says resumed", async () => {
  let allowSubmit = false;
  const { sdk } = fakeSdk({
    pass1: async (c) => {
      if (!allowSubmit) {
        await new Promise<void>(() => {}); // hangs until aborted
        return;
      }
      await submitThenFinish(REWRITTEN_PLAN)(c);
    },
    pass2: submitThenFinishPass2(REWRITTEN_PLAN),
  });
  const creations = { n: 0 };
  const origCreate = (
    sdk as { createAgentSession: (o: unknown) => Promise<unknown> }
  ).createAgentSession;
  (
    sdk as { createAgentSession: (o: unknown) => Promise<unknown> }
  ).createAgentSession = async (o) => {
    creations.n += 1;
    return origCreate(o);
  };
  const seen: Array<{ kind?: string; text?: string }> = [];
  const { deps } = runtimeDeps(sdk, {
    onTranscriptOps: (ops) => seen.push(...(ops as typeof seen)),
  });
  const rt = createReviewRuntime(deps as never);
  const ac = new AbortController();
  const paused = rt.runRound({
    planText: ORIGINAL_PLAN,
    planPath: ".pi/plans/2026-09-18-csv.md",
    round: 1,
    signal: ac.signal,
  });
  ac.abort();
  assert.equal((await paused).reason, "aborted");
  assert.equal(creations.n, 1, "the paused round booted the session");

  seen.length = 0;
  allowSubmit = true;
  const resumed = await rt.runRound({
    planText: ORIGINAL_PLAN,
    planPath: ".pi/plans/2026-09-18-csv.md",
    round: 1,
    resumed: true,
  });
  assert.equal(resumed.ok, true);
  assert.equal(creations.n, 1, "resume reuses the warm session");
  const statuses = seen
    .filter((op) => op.kind === "status")
    .map((op) => String(op.text ?? ""));
  assert.ok(statuses.includes("reviewer resumed"), "resume is named");
  assert.ok(
    !statuses.includes("reviewer started"),
    "a warm resume never reads as a fresh start",
  );
  await rt.teardown();
});

test("runtime: the no-limit notice is logged once per reviewer session", async () => {
  const { sdk } = fakeSdk({
    pass1: submitThenFinish(REWRITTEN_PLAN),
    pass2: submitThenFinishPass2(REWRITTEN_PLAN),
  });
  const { deps, logs } = runtimeDeps(sdk, { config: { timeoutMs: 0 } });
  const rt = createReviewRuntime(deps as never);
  const count = (): number =>
    logs.filter((l) => l.includes("no time limit configured")).length;

  const first = await rt.runRound({
    planText: ORIGINAL_PLAN,
    planPath: ".pi/plans/2026-09-18-csv.md",
    round: 1,
  });
  assert.equal(first.ok, true);
  assert.equal(count(), 1, "a fresh session reports the missing cap once");

  const second = await rt.runRound({
    planText: ORIGINAL_PLAN,
    planPath: ".pi/plans/2026-09-18-csv.md",
    round: 2,
  });
  assert.equal(second.ok, true);
  assert.equal(count(), 1, "a warm round does not replay it");
  await rt.teardown();
});

test("plan-2026-10-25: a pre-aborted host signal aborts before start, never a pause", async () => {
  const { capture, sdk } = fakeSdk({});
  const { deps } = runtimeDeps(sdk);
  const rt = createReviewRuntime(deps as never);
  assert.equal(await rt.ensureStarted(), true);
  const promptsBefore = capture.prompts.length;
  const ac = new AbortController();
  ac.abort();
  const res = await rt.runRound({
    planText: ORIGINAL_PLAN,
    planPath: ".pi/plans/2026-09-18-csv.md",
    round: 1,
    signal: ac.signal,
  });
  assert.equal(res.ok, false);
  assert.equal(res.reason, "aborted-before-start");
  assert.equal(res.abortedBeforeStart, true);
  assert.equal(res.fallback, true);
  assert.equal(res.planText, ORIGINAL_PLAN);
  assert.equal(res.state.phase, "aborted");
  assert.equal(capture.prompts.length, promptsBefore, "no prompt was sent");
  assert.equal(rt.isRoundActive(), false);
  assert.equal(rt.isAlive(), true, "the warm session is kept");

  // A cold runtime must not boot a session for a pre-aborted signal either.
  const coldBuilt = runtimeDeps(sdk);
  const cold = createReviewRuntime(coldBuilt.deps as never);
  const coldRes = await cold.runRound({
    planText: ORIGINAL_PLAN,
    planPath: ".pi/plans/2026-09-18-csv.md",
    round: 1,
    signal: ac.signal,
  });
  assert.equal(coldRes.abortedBeforeStart, true);
  assert.equal(cold.isAlive(), false, "no session was booted");

  await rt.teardown();
});

test("plan-2026-10-23: planner manifest is embedded in the pass-1 prompt", async () => {
  const { capture, sdk } = fakeSdk({
    pass1: submitThenFinish(REWRITTEN_PLAN),
    pass2: submitThenFinishPass2(REWRITTEN_PLAN),
  });
  const built = runtimeDeps(sdk);
  (built.deps as Record<string, unknown>).plannerManifest =
    () => "## Shared context (Planner — test manifest)\n- `src/a.ts`";
  const rt = createReviewRuntime(built.deps as never);
  const res = await rt.runRound({
    planText: ORIGINAL_PLAN,
    planPath: ".pi/plans/2026-09-18-csv.md",
    round: 1,
  });
  assert.equal(res.ok, true);
  assert.ok(
    capture.prompts[0].includes("test manifest"),
    "manifest reaches the reviewer prompt",
  );
  await rt.teardown();
});

test("plan-2026-10-23: reviewer model change reboots the session", async () => {
  const { sdk } = fakeSdk({});
  const creations = { n: 0 };
  const origCreate = (
    sdk as { createAgentSession: (o: unknown) => Promise<unknown> }
  ).createAgentSession;
  (
    sdk as { createAgentSession: (o: unknown) => Promise<unknown> }
  ).createAgentSession = async (o) => {
    creations.n += 1;
    return origCreate(o);
  };
  const model = { provider: "p", id: "m", thinking: "xhigh" };
  const { deps } = runtimeDeps(sdk, { reviewerModel: model });
  const rt = createReviewRuntime(deps as never);
  assert.equal(await rt.ensureStarted(), true);
  assert.equal(creations.n, 1);
  assert.equal(await rt.ensureStarted(), true, "same model reuses the session");
  assert.equal(creations.n, 1);
  model.id = "m2"; // /role set reviewer … — applies via reboot
  assert.equal(await rt.ensureStarted(), true);
  assert.equal(creations.n, 2, "model change reboots the session");
  await rt.teardown();
});
