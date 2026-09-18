/**
 * Workflow Extension — Review Mode tests
 *
 * Run with: npm test   (node --test, type-stripping — no build step)
 *
 * These cover the deterministic surface: config/prompt resolution, plan
 * hashing and the changelog, submission validation, context pruning, the
 * ANSI-aware pane layout, finding sanitisation, the pass gate, and the
 * "Review Mode off ⇒ nothing happens" guarantee.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  appendReviewChangelog,
  composeTwoColumn,
  displayWidth,
  padAnsi,
  planHash,
  pruneContextEntriesForReview,
  renderReviewChangelog,
  renderReviewContextBlock,
  REVIEW_CHANGELOG_HEADING,
  REVIEW_UNRESOLVED_HEADING,
  reviewFindingTier,
  reviewNeedsVerification,
  sliceViewport,
  stripAnsi,
  stripReviewAppendix,
  truncateAnsi,
  validateReviewedPlan,
  type ReviewFinding,
} from "./utils.ts";

import {
  DEFAULT_REVIEW_MODE_CONFIG,
  DEFAULT_REVIEW_PROMPT,
  applySubmittedPlan,
  coerceReviewModeConfig,
  createReviewRoundGate,
  createReviewState,
  createReviewSession,
  extractReviewModeRaw,
  isReviewEnabled,
  mergeReviewModeConfig,
  planHash as planHashReexported,
  readReviewModeConfig,
  resolveReviewPrompt,
  reviewElapsedMs,
  reviewIsActive,
  reviewPhaseLabel,
  sanitizeFindings,
  reviewStateSummary,
  writeReviewModeConfig,
  writeReviewPrompt,
  ReviewTranscript,
  translateReviewEvent,
  REVIEW_BUILTIN_TOOLS,
  MAX_REVIEW_LINES,
} from "./review.ts";

import {
  createReviewBashTool,
  createReviewExploreTool,
  createReviewPassDoneTool,
  createReviewSubmitPlanTool,
  createReviewTools,
  resolveBashToolDefinitionBuilder,
} from "./review-tools.ts";

import { paneColumnWidths } from "./review-pane.ts";
import {
  buildPass1Prompt,
  buildPass2Prompt,
  createReviewRuntime,
} from "./review-runtime.ts";

// ── Fixtures ─────────────────────────────────────────────────────────

const ORIGINAL_PLAN = [
  "# Plan: Add CSV export",
  "",
  "## Context",
  "The reports page needs CSV export following the existing export conventions.",
  "",
  "## Plan Steps",
  "",
  "1. Add a CSV serializer in src/export/csv.ts",
  "2. Wire a download button into the reports toolbar",
  "3. Add tests under tests/export/",
  "",
  "## Verification",
  "- Run the export test suite",
].join("\n");

/** A realistic rewrite: adds framework detail and a step, keeps the shape. */
const REWRITTEN_PLAN = ORIGINAL_PLAN.replace(
  "1. Add a CSV serializer in src/export/csv.ts",
  "1. Add a CSV serializer in src/export/csv.ts returning Result<string, ExportError>, matching src/export/json.ts\n2. Register the format in src/export/index.ts so feature flags apply",
).replace(
  "3. Add tests under tests/export/",
  "4. Add tests under tests/export/ following the table-driven pattern",
);

function tmpProject(): { root: string; cwd: string; agentDir: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rv-test-"));
  const cwd = path.join(root, "proj");
  const agentDir = path.join(root, "agent");
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(agentDir, { recursive: true });
  return { root, cwd, agentDir };
}

const HIGH_FINDING = {
  id: "F1",
  severity: 9,
  confidence: 85,
  category: "framework-alignment",
  file: "src/export/csv.ts",
  lineRange: "1",
  summary: "Plan ignored the Result<T,E> convention",
  rationale: "Every sibling exporter returns Result.",
  disposition: "accepted" as const,
};

// ══ Step 2: configuration ═════════════════════════════════════════════

test("review config: defaults are safe (off, 1 round, verify on)", () => {
  const c = coerceReviewModeConfig(undefined);
  assert.equal(c.enabled, false, "must default to disabled");
  assert.equal(c.rounds, 1);
  assert.equal(c.passes, 2);
  assert.equal(c.verify, true);
  assert.equal(c.fallbackOnError, "skip");
  assert.deepEqual(c, { ...DEFAULT_REVIEW_MODE_CONFIG });
});

test("review config: clamps out-of-range numbers", () => {
  const c = coerceReviewModeConfig({
    rounds: 99,
    passes: 9,
    exploreBudget: 500,
    timeoutMs: 1,
  });
  assert.equal(c.rounds, 5);
  assert.equal(c.passes, 2);
  assert.equal(c.exploreBudget, 8);
  assert.equal(c.timeoutMs, 30_000);
  const low = coerceReviewModeConfig({ rounds: -3, timeoutMs: 1e12 });
  assert.equal(low.rounds, 1);
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

test("ANSI-aware layout: exact column widths, no colour bleed", () => {
  const RED = "\x1b[31m";
  const RST = "\x1b[0m";
  assert.equal(displayWidth(`${RED}hello${RST}`), 5);
  assert.equal(displayWidth("日本語"), 6);
  assert.equal(displayWidth("🔍"), 2);
  assert.equal(stripAnsi(`${RED}x${RST}`), "x");
  assert.equal(displayWidth(padAnsi("ab", 6)), 6);
  assert.equal(displayWidth(padAnsi("abcdefghij", 5)), 5);
  assert.ok(truncateAnsi(`${RED}abcdefghij${RST}`, 4).includes("\x1b[0m"));

  const { left: lw, right: rw, gap } = paneColumnWidths(80);
  const rows = composeTwoColumn(
    [`${RED}left-1${RST}`, "left-2", "", "日本語"],
    ["right-1", `${RED}right-2-is-long${RST}`, "right-3", "right-4"],
    lw,
    rw,
    gap,
  );
  assert.equal(rows.length, 4);
  for (const row of rows) {
    assert.equal(
      displayWidth(row),
      lw + gap + rw,
      "every composed row must be exactly left+gap+right wide",
    );
  }
});

test("paneColumnWidths never overflow the terminal", () => {
  for (const w of [10, 40, 80, 120, 200]) {
    const c = paneColumnWidths(w);
    assert.ok(c.left >= 8 && c.right >= 8);
    if (w >= 40) assert.ok(c.left + c.gap + c.right <= w);
  }
});

test("sliceViewport: clamps, follows the end, tolerates junk", () => {
  const src = Array.from({ length: 100 }, (_, i) => `line-${i}`);
  assert.deepEqual(sliceViewport(src, 10, 3).lines, [
    "line-10",
    "line-11",
    "line-12",
  ]);
  assert.equal(sliceViewport(src, 999, 5).offset, 95);
  assert.equal(sliceViewport(src, -5, 5).offset, 0);
  assert.equal(sliceViewport(src, 0, 5, true).lines[4], "line-99");
  assert.equal(sliceViewport(src, 0, 0).lines.length, 0);
  assert.equal(sliceViewport(["a", "b"], 0, 10).lines.length, 2);
  assert.equal(sliceViewport([], 0, 5).lines.length, 0);
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

// ══ Step 16: transcript ═══════════════════════════════════════════════

test("translateReviewEvent: coalescable deltas, tools, drops plumbing", () => {
  assert.deepEqual(
    translateReviewEvent({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "hi" },
    }),
    [{ op: "append", kind: "text", text: "hi" }],
  );
  assert.equal(
    translateReviewEvent({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "" },
    }).length,
    0,
  );
  assert.equal(translateReviewEvent({ type: "queue_update" }).length, 0);
  assert.equal(translateReviewEvent({ type: "compaction_start" }).length, 0);
  assert.ok(
    translateReviewEvent({
      type: "tool_execution_start",
      toolName: "read",
    })[0].text.includes("read"),
  );
  assert.ok(
    translateReviewEvent({
      type: "tool_execution_end",
      toolName: "read",
      isError: true,
    })[0].text.includes("failed"),
  );
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
  ]) {
    assert.doesNotThrow(() => translateReviewEvent(junk));
  }
});

test("ReviewTranscript: coalesces, bounds and clears", () => {
  const t = new ReviewTranscript(10);
  for (const d of ["Hello", " ", "world"]) {
    t.ingest({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: d },
    });
  }
  assert.equal(t.size, 1, "deltas coalesce into one line");
  assert.equal(t.toLines()[0].text, "Hello world");

  t.ingest({
    type: "message_update",
    assistantMessageEvent: { type: "thinking_delta", delta: "hmm" },
  });
  assert.equal(t.size, 2, "kind switch starts a new line");

  const fresh = new ReviewTranscript(10);
  fresh.ingest({
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", delta: "a\nb\nc" },
  });
  assert.deepEqual(
    fresh.toDisplayLines(),
    ["a", "b", "c"],
    "newlines split for display only",
  );
  assert.equal(fresh.size, 1, "but stay one buffered line");

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
    "node --test",
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
  ]) {
    assert.equal((await call(good)).isError, undefined);
  }
  assert.equal(ran.length, 5);
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

  const rel = path.join(".pi", "plans", "2026-09-18-csv.md");
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
  assert.equal(path.basename(r.path), "2026-09-18-csv.md");
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
  assert.equal(path.basename(stale.path), "2026-09-18-csv.md");

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

  const res = await createReviewSession({
    cwd: "/proj",
    agentDir: "/agent",
    modelRef: { provider: "p", id: "m", thinking: "xhigh" },
    findModel: () => ({}),
    reviewPrompt: "USER GUIDANCE",
    customTools: [{ name: "review_bash" }],
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
  assert.deepEqual(
    captured.sessionOpts?.tools,
    [...REVIEW_BUILTIN_TOOLS],
    "read-only built-ins",
  );
  assert.ok(!(captured.sessionOpts?.tools as string[]).includes("edit"));
  assert.ok(!(captured.sessionOpts?.tools as string[]).includes("write"));
  assert.ok(!(captured.sessionOpts?.tools as string[]).includes("bash"));
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
  assert.equal(withSdk.tools.length, 4, "all four tools with a full SDK");
  assert.equal(withSdk.unavailable.length, 0);
  assert.equal(
    resolveBashToolDefinitionBuilder({ createBashToolDefinition: 42 } as never),
    undefined,
  );
});

// ══ Steps 18-25: orchestrator (fake SDK, no provider needed) ══════════

interface FakeCapture {
  prompts: string[];
  followUps: string[];
  tools: Record<string, { execute: (...args: unknown[]) => Promise<unknown> }>;
  unsubscribeCount: number;
}

/**
 * A fake SDK whose "model" invokes the real review tools.
 *
 * This exercises the genuine orchestration path — tool wiring, the round gate,
 * the pass 1 → pass 2 advance, the fallback on timeout, and teardown — without
 * a provider, a network call, or a real child session.
 */
function fakeSdk(script: {
  pass1?: (c: FakeCapture) => Promise<void>;
  pass2?: (c: FakeCapture) => Promise<void>;
  shouldThrowOnCreate?: boolean;
}): { capture: FakeCapture; sdk: unknown } {
  const capture: FakeCapture = {
    prompts: [],
    followUps: [],
    tools: {},
    unsubscribeCount: 0,
  };
  const sdk = {
    ModelRuntime: { create: async () => ({}) },
    DefaultResourceLoader: class {
      async reload() {}
    },
    SessionManager: { inMemory: () => ({}) },
    createBashToolDefinition: () => ({
      parameters: {},
      execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
    }),
    createAgentSession: async (opts: {
      customTools?: Array<{ name: string }>;
    }) => {
      if (script.shouldThrowOnCreate) throw new Error("session create failed");
      for (const t of opts.customTools ?? []) {
        capture.tools[t.name] = t as never;
      }
      return {
        session: {
          subscribe: () => {
            capture.unsubscribeCount += 1;
            return () => {};
          },
          prompt: async (text: string) => {
            capture.prompts.push(text);
            await script.pass1?.(capture);
          },
          followUp: async (text: string) => {
            capture.followUps.push(text);
            await script.pass2?.(capture);
          },
          abort: async () => {},
          isStreaming: false,
          bindExtensions: async () => {},
        },
      };
    },
  };
  return { capture, sdk };
}

function runtimeDeps(
  sdk: unknown,
  over: {
    config?: Record<string, unknown>;
    reviewerModel?: unknown;
    onState?: (s: unknown) => void;
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
      parallel: true,
      rounds: 1,
      passes: 2,
      verify: true,
      autoOpenPane: true,
      fallbackOnError: "skip" as const,
      exploreBudget: 3,
      timeoutMs: 5000,
      ...(over.config ?? {}),
    }),
    reviewerModel: () =>
      over.reviewerModel === null
        ? undefined
        : ({ provider: "p", id: "m", thinking: "xhigh" } as const),
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
  if (over.onState) {
    return { deps: { ...deps, onState: over.onState }, writes, logs };
  }
  return { deps, writes, logs };
}

const submitThenFinish =
  (plan: string) =>
  async (c: FakeCapture): Promise<void> => {
    await c.tools.review_submit_plan.execute(
      "1",
      {
        planMarkdown: plan,
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
  };

const submitThenFinishPass2 =
  (plan: string) =>
  async (c: FakeCapture): Promise<void> => {
    await c.tools.review_submit_plan.execute(
      "3",
      {
        planMarkdown: plan,
        findings: [],
        verdict: "approve",
        summary: "verified",
      },
      undefined,
      undefined,
      {},
    );
    await c.tools.review_pass_done.execute(
      "4",
      { pass: 2, verdict: "approve", findings: [] },
      undefined,
      undefined,
      {},
    );
  };

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
    ["review_bash", "review_explore", "review_pass_done", "review_submit_plan"],
    "all four reviewer tools wired (review_bash needs the SDK)",
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

test("runtime: a silent reviewer falls back to the author's plan, bounded (R7)", async () => {
  const silent = fakeSdk({ pass1: async () => {} });
  const { deps, logs } = runtimeDeps(silent.sdk, {
    config: { timeoutMs: 1200 },
  });
  const rt = createReviewRuntime(deps as never);
  const t0 = Date.now();
  const res = await rt.runRound({
    planText: ORIGINAL_PLAN,
    planPath: "p.md",
    round: 1,
  });
  assert.equal(res.ok, false);
  assert.equal(res.fallback, true);
  assert.equal(
    res.planText,
    ORIGINAL_PLAN,
    "author's plan is preserved verbatim",
  );
  assert.ok(Date.now() - t0 < 4000, "no hang");
  assert.ok(
    logs.some((l) => l.includes("timed out")),
    "timeout is reported",
  );
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
  const silent = fakeSdk({ pass1: async () => {} });
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

  const p2 = buildPass2Prompt({
    planPath: ".pi/plans/x.md",
    originalPlan: ORIGINAL_PLAN,
    rewrittenPlan: REWRITTEN_PLAN,
    findings: [HIGH_FINDING],
  });
  assert.ok(p2.includes("PASS 2 of 2"));
  assert.ok(p2.includes(ORIGINAL_PLAN) && p2.includes(REWRITTEN_PLAN));
  assert.ok(p2.includes("List anything lost"), "pass 2 asks what was lost");
});

// ══ Step 37 (automated): Review Mode disabled ⇒ no-op ═════════════════

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
