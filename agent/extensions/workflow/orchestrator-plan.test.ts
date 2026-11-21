/**
 * Roadmap ingestion tests (step 16). The acceptance-critical properties:
 * repeated phases keep every requirement, large/partially completed plans are
 * preserved, `[x]` is only a claim, and the source path/digest are exact.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { ingestRoadmapFile, snapshotRoadmap } from "./orchestrator-plan.ts";

const PATH = "C:/Users/me/Documents/2026-01-01-approved-roadmap.md";

function plan(body: string): string {
  return `# Plan: Big roadmap\n\n## Plan Steps\n\n${body}\n`;
}

function snap(markdown: string, path = PATH) {
  const result = snapshotRoadmap({ sourcePath: path, markdown, now: 1 });
  assert.equal(result.ok, true, result.ok ? "" : result.error);
  return (result as { ok: true; snapshot: ReturnType<typeof snapshotRoadmap> extends never ? never : any })
    .snapshot;
}

test("repeated phase labels are distinct phases and keep every requirement", () => {
  const snapshot = snap(
    plan(
      [
        "### Phase A",
        "1. First slice",
        "2. Second slice",
        "### Phase A",
        "1. First slice",
        "2. Second slice",
      ].join("\n"),
    ),
  );
  assert.equal(snapshot.requirements.length, 4);
  assert.deepEqual(
    snapshot.phases.map((phase: { path: string[] }) => phase.path),
    [
      ["Phase A"],
      ["Phase A (2)"],
    ],
  );
  const ids = snapshot.requirements.map((entry: { roadmapStepId: string }) => entry.roadmapStepId);
  assert.equal(new Set(ids).size, 4, "stable ids stay unique");
});

test("a large partially completed roadmap retains all claims without verifying them", () => {
  const lines: string[] = [];
  for (let index = 1; index <= 150; index += 1) {
    const box = index % 3 === 0 ? "x" : " ";
    lines.push(`- [${box}] Requirement ${index}`);
  }
  const snapshot = snap(plan(lines.join("\n")));
  assert.equal(snapshot.requirements.length, 150);
  const claimed = snapshot.requirements.filter(
    (entry: { claimedComplete: boolean }) => entry.claimedComplete,
  );
  assert.equal(claimed.length, 50);
  for (const entry of snapshot.requirements) {
    assert.equal(entry.completionVerified, false);
  }
});

test("the source path is verbatim and the digest changes with the bytes", () => {
  const first = snap(plan("1. One"));
  assert.equal(first.sourcePath, PATH);
  assert.match(first.digest, /^[a-f0-9]{64}$/);
  const same = snap(plan("1. One"));
  assert.equal(same.digest, first.digest);
  const edited = snap(plan("1. One\n2. Two"));
  assert.notEqual(edited.digest, first.digest);
  // No date-prefix normalization or rename anywhere.
  assert.equal(first.sourcePath.endsWith("2026-01-01-approved-roadmap.md"), true);
});

test("empty, ambiguous and step-less inputs fail closed", () => {
  const empty = snapshotRoadmap({ sourcePath: PATH, markdown: "", now: 1 });
  assert.equal(empty.ok, false);
  const ambiguous = snapshotRoadmap({
    sourcePath: PATH,
    markdown: "# Plan\n\n## Plan Steps\n\n1. One\n\n## Plan Steps\n\n1. Two\n",
    now: 1,
  });
  assert.equal(ambiguous.ok, false);
  assert.match((ambiguous as { error: string }).error, /more than one Plan Steps/);
  const none = snapshotRoadmap({ sourcePath: PATH, markdown: "# Plan\n\n## Context\n\nProse.\n", now: 1 });
  assert.equal(none.ok, false);
  const relative = snapshotRoadmap({ sourcePath: "roadmap.md", markdown: plan("1. One"), now: 1 });
  assert.equal(relative.ok, false);
});

test("a numbered list outside Plan Steps still parses step-shaped content", () => {
  const snapshot = snap("# Plan: x\n\n1. First\n2. Second\n");
  assert.deepEqual(
    snapshot.requirements.map((entry: { text: string }) => entry.text),
    ["First", "Second"],
  );
});

test("ingest: policy refusal, missing file and an explicit allowed path", async () => {
  const refused = await ingestRoadmapFile({
    path: PATH,
    read: async () => plan("1. One"),
    allow: () => "outside the effective read policy",
    now: 1,
  });
  assert.equal(refused.ok, false);
  assert.equal((refused as { code: string }).code, "rejected");

  const missing = await ingestRoadmapFile({
    path: PATH,
    read: async () => null,
    allow: () => undefined,
    now: 1,
  });
  assert.equal(missing.ok, false);
  assert.equal((missing as { code: string }).code, "unavailable");

  const allowed = await ingestRoadmapFile({
    path: PATH,
    read: async () => plan("1. One"),
    allow: () => undefined,
    now: 1,
  });
  assert.equal(allowed.ok, true);
});
