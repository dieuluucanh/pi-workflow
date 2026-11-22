/**
 * Plan-or-discussion work source (plan step 5).
 *
 * These tests pin the selection rules that stopped manual Orchestrator work
 * from requiring a Markdown plan: an explicitly requested discussion beats a
 * stale `currentPlanFile`, a plain task list becomes real requirements, and an
 * empty/ambiguous request asks instead of inventing scope.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  MAX_REQUIREMENTS,
  MAX_REQUIREMENT_CHARS,
  MAX_SOURCE_CHARS,
  discussionRequirements,
  discussionRoadmap,
  discussionSourceFileName,
  resolveWorkSource,
  summarizeWorkSource,
} from "./orchestrator-source.ts";

const NOW = 1_760_000_000_000;

test("source: an explicitly requested discussion beats a stale bound plan", () => {
  const resolved = resolveWorkSource({
    request: { source: "discussion", objective: "Fix the login redirect", now: NOW },
    boundPlanPath: "/old/2026-01-01-stale-plan.md",
  });
  assert.equal(resolved.ok, true);
  if (!resolved.ok) return;
  assert.equal(resolved.source.kind, "discussion");
  if (resolved.source.kind !== "discussion") return;
  assert.equal(resolved.source.label, "current discussion");
  assert.deepEqual(resolved.source.requirements, ["Fix the login redirect"]);
  assert.equal(resolved.source.capturedAt, NOW);
});

test("source: auto prefers the current prompt over a stale bound plan", () => {
  const resolved = resolveWorkSource({
    request: { now: NOW },
    boundPlanPath: "/old/plan.md",
    lastUserPrompt: "Please work on our current discussion",
  });
  assert.equal(resolved.ok, true);
  if (!resolved.ok) return;
  assert.equal(resolved.source.kind, "discussion");
});

test("source: an explicit plan path wins in auto mode", () => {
  const resolved = resolveWorkSource({
    request: { planPath: "/tmp/plan.md", objective: "ignore me", now: NOW },
    boundPlanPath: "/old/plan.md",
    lastUserPrompt: "work on this",
  });
  assert.deepEqual(resolved, { ok: true, source: { kind: "plan", path: "/tmp/plan.md" } });
});

test("source: source=plan falls back to the bound plan, and reports a missing path", () => {
  const bound = resolveWorkSource({
    request: { source: "plan", now: NOW },
    boundPlanPath: "/bound/plan.md",
  });
  assert.deepEqual(bound, { ok: true, source: { kind: "plan", path: "/bound/plan.md" } });

  const missing = resolveWorkSource({ request: { source: "plan", now: NOW } });
  assert.equal(missing.ok, false);
  if (missing.ok) return;
  assert.equal(missing.code, "missing");
  assert.match(missing.error, /planPath/);
});

test("source: auto falls back to the bound plan, then asks instead of guessing", () => {
  const bound = resolveWorkSource({
    request: { source: "auto", now: NOW },
    boundPlanPath: "/bound/plan.md",
  });
  assert.equal(bound.ok, true);

  const ambiguous = resolveWorkSource({ request: { source: "auto", now: NOW } });
  assert.equal(ambiguous.ok, false);
  if (ambiguous.ok) return;
  assert.equal(ambiguous.code, "ambiguous");
});

test("source: an explicitly requested discussion needs an objective", () => {
  const resolved = resolveWorkSource({ request: { source: "discussion", now: NOW } });
  assert.equal(resolved.ok, false);
  if (resolved.ok) return;
  assert.equal(resolved.code, "invalid");
  assert.match(resolved.error, /objective/);
});

test("source: bullet/numbered discussion lines become one requirement each", () => {
  const requirements = discussionRequirements({
    objective: [
      "Make the release checklist executable:",
      "- add the packaging step",
      "1. run the package gate",
      "* keep the old commands working",
    ].join("\n"),
  });
  assert.deepEqual(requirements, [
    "add the packaging step",
    "run the package gate",
    "keep the old commands working",
  ]);
});

test("source: a plain paragraph is a single requirement and duplicates collapse", () => {
  assert.deepEqual(
    discussionRequirements({ objective: "Fix the login redirect.\n\nAlso fix the login redirect." }),
    ["Fix the login redirect.", "Also fix the login redirect."],
  );
  assert.deepEqual(
    discussionRequirements({
      objective: "- Add tests",
      constraints: ["Do not change public APIs", "Do not change public APIs"],
    }),
    ["Add tests", "Respect the constraint: Do not change public APIs"],
  );
});

test("source: requirements are bounded and never grow an invented scope", () => {
  const many = Array.from({ length: MAX_REQUIREMENTS + 25 }, (_, index) => `- step ${index + 1}`).join(
    "\n",
  );
  assert.equal(discussionRequirements({ objective: many }).length, MAX_REQUIREMENTS);

  const long = discussionRequirements({ objective: "x".repeat(MAX_REQUIREMENT_CHARS + 100) });
  assert.equal(long.length, 1);
  assert.equal(long[0]!.length, MAX_REQUIREMENT_CHARS);

  const hugeObjective = "y".repeat(MAX_SOURCE_CHARS + 500);
  const roadmap = discussionRoadmap({ objective: hugeObjective, capturedAt: NOW });
  assert.ok(roadmap.requirements.length >= 1);
  assert.ok(roadmap.markdown.length < MAX_SOURCE_CHARS + 2_000);
});

test("source: the discussion snapshot is deterministic, policy-readable bytes", () => {
  const first = discussionRoadmap({
    objective: "Add the export command",
    constraints: ["Keep the JSON format stable"],
    label: "Export work",
    sourceRef: "session/root/leaf",
    capturedAt: NOW,
  });
  const second = discussionRoadmap({
    objective: "Add the export command",
    constraints: ["Keep the JSON format stable"],
    label: "Export work",
    sourceRef: "session/root/leaf",
    capturedAt: NOW + 60_000,
  });
  assert.equal(first.digest, second.digest, "the clock is not part of the digest");
  assert.equal(first.markdown, second.markdown);
  assert.match(first.markdown, /^# Plan: Export work/m);
  assert.match(first.markdown, /## Plan Steps/);
  assert.match(first.markdown, /^1\. Add the export command$/m);
  assert.match(first.markdown, /^2\. Respect the constraint: Keep the JSON format stable$/m);
  assert.match(first.markdown, /Source: session\/root\/leaf/);
  assert.equal(first.requirements.length, 2);
});

test("source: snapshot names are stable, workspace-safe and bounded", () => {
  const name = discussionSourceFileName("a".repeat(64));
  assert.equal(name, `discussion-${"a".repeat(16)}.md`);
  assert.doesNotMatch(name, /[\\/:*?"<>|]/);
});

test("source: summaries keep the model's context bounded", () => {
  const plan = summarizeWorkSource({ kind: "plan", path: "/tmp/plan.md" });
  assert.equal(plan, "plan /tmp/plan.md");

  const summary = summarizeWorkSource({
    kind: "discussion",
    objective: "x",
    constraints: [],
    markdown: "x",
    digest: "b".repeat(64),
    requirements: ["one", "two"],
    label: "current discussion",
    capturedAt: NOW,
  });
  assert.match(summary, /current discussion \(2 requirement\(s\)/);
  assert.match(summary, /bbbbbbbbbbbb/);
});
