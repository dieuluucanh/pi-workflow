/**
 * Notifier scope guard — reviewer branding stops at the reviewer.
 *
 * `notifyReview` is the ONE place that applies `reviewNoticeText()` (the
 * `Review Mode:` prefix). Every message that reaches it therefore renders as
 * `Review Mode: …`. That is correct for the independent reviewer and the
 * review-owned turn, and wrong for everything else: an Orchestrator/child,
 * handoff/Plannotator or plan-lifecycle notice routed through it produced the
 * reported `Review Mode: Paused · Builder 3/19 · …` row.
 *
 * The neutral sibling `notifyWorkflow` never prefixes, and owns every
 * non-reviewer notice. This guard pins the two directions of that contract by
 * scanning the extension source:
 *
 *   1. the reviewer notifier has exactly one definition and exactly twenty-three
 *      call sites — the audited set of review-owned notices;
 *   2. no call site carries a non-reviewer marker word (Builder, Orchestrator,
 *      child, Plannotator, browser, handoff), so a lifecycle notice cannot drift
 *      back onto the reviewer path;
 *   3. the definition keeps `reviewNoticeText()` as its only prefix owner, and
 *      `notifyWorkflow` never calls it.
 *
 * Deliberate call-site changes update the expected count here in the same
 * change set — a silent drift fails instead of re-branding user-facing rows.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** The audited set: 23 review-owned `notifyReview(...)` calls. */
const EXPECTED_REVIEW_CALL_SITES = 23;

/** Markers of a non-reviewer notice; none may reach `notifyReview`. */
const NON_REVIEWER_MARKERS = [
  "Builder",
  "Orchestrator",
  "child",
  "Plannotator",
  "browser",
  "handoff",
] as const;

/** Strip comments before scanning, so prose mentions never count as calls. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/**
 * Argument text of every `name(` occurrence, via balanced parentheses.
 * The definition is reported first: it is the occurrence preceded by `function`.
 */
function callSites(
  source: string,
  name: string,
): { isDefinition: boolean; args: string; body: string }[] {
  const needle = `${name}(`;
  const found: { isDefinition: boolean; args: string; body: string }[] = [];
  let from = 0;
  for (;;) {
    const at = source.indexOf(needle, from);
    if (at === -1) break;
    let depth = 0;
    let end = at + needle.length - 1;
    for (; end < source.length; end++) {
      const ch = source[end];
      if (ch === "(") depth++;
      else if (ch === ")") {
        depth--;
        if (depth === 0) break;
      }
    }
    found.push({
      isDefinition: /\bfunction\s*$/.test(source.slice(0, at)),
      args: source.slice(at + needle.length, end),
      body: source.slice(end + 1, end + 400),
    });
    from = at + needle.length;
  }
  return found;
}

function extensionSource(): string {
  return stripComments(fs.readFileSync(path.join(HERE, "index.ts"), "utf8"));
}

test("notifyReview: one definition plus twenty-three review-owned call sites", () => {
  const sites = callSites(extensionSource(), "notifyReview");
  const definitions = sites.filter((site) => site.isDefinition);
  const calls = sites.filter((site) => !site.isDefinition);

  assert.equal(definitions.length, 1, "exactly one notifyReview definition");
  assert.equal(
    calls.length,
    EXPECTED_REVIEW_CALL_SITES,
    "notifyReview must only carry the audited review-owned notices",
  );
});

test("notifyReview: no non-reviewer notice is routed through it", () => {
  const calls = callSites(extensionSource(), "notifyReview").filter(
    (site) => !site.isDefinition,
  );
  for (const call of calls) {
    for (const marker of NON_REVIEWER_MARKERS) {
      assert.ok(
        !new RegExp(`\\b${marker}\\b`, "i").test(call.args),
        `a non-reviewer notice ("${marker}") must use notifyWorkflow — got: ${call.args
          .replace(/\s+/g, " ")
          .trim()}`,
      );
    }
  }
});

test("notifyReview: reviewNoticeText stays the only prefix owner", () => {
  const source = extensionSource();
  const sites = callSites(source, "notifyReview");
  const definition = sites.find((site) => site.isDefinition);
  assert.ok(definition, "notifyReview definition present");
  assert.match(
    definition.body,
    /reviewNoticeText\(/,
    "notifyReview must prefix through reviewNoticeText()",
  );

  const workflowSites = callSites(source, "notifyWorkflow");
  const workflowDefinition = workflowSites.find((site) => site.isDefinition);
  assert.ok(workflowDefinition, "notifyWorkflow definition present");
  assert.doesNotMatch(
    workflowDefinition.body,
    /reviewNoticeText\(/,
    "notifyWorkflow must never brand its message as Review Mode",
  );
});
