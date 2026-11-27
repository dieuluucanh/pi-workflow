/**
 * Workflow Extension — command-text helper tests.
 *
 * Run with: npm test   (node --test, type-stripping — no build step)
 *
 * Covers the three pure primitives the `/orchestrator` and `/review` grammars
 * share: head splitting, one-quote-pair stripping, and nearest-verb hints
 * (including the removed `cancel` → `stop` migration).
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  CANCEL_MIGRATION_SENTENCE,
  SUGGEST_MAX_DISTANCE,
  splitCommandHead,
  stripOneQuotePair,
  suggestVerb,
} from "./command-text.ts";

// ── splitCommandHead ─────────────────────────────────────────────────

test("split: blank, whitespace and non-string inputs are empty", () => {
  for (const raw of ["", "   ", "\n\t ", undefined, null, 42, [], {}]) {
    assert.deepEqual(splitCommandHead(raw), { head: "", rest: "" }, String(raw));
  }
});

test("split: head is lowercased, rest keeps its casing and is trimmed", () => {
  assert.deepEqual(splitCommandHead("STATUS"), { head: "status", rest: "" });
  assert.deepEqual(splitCommandHead("  Start  My Plan.md  "), {
    head: "start",
    rest: "My Plan.md",
  });
  assert.deepEqual(splitCommandHead("Say   Hello   World"), {
    head: "say",
    rest: "Hello   World",
  });
});

test("split: any whitespace run separates head from rest", () => {
  assert.deepEqual(splitCommandHead("pause\n"), { head: "pause", rest: "" });
  assert.deepEqual(splitCommandHead("say\tone\ttwo"), {
    head: "say",
    rest: "one\ttwo",
  });
  assert.deepEqual(splitCommandHead("say one\ntwo"), {
    head: "say",
    rest: "one\ntwo",
  });
});

test("split: quoted and spaced arguments survive intact", () => {
  assert.deepEqual(splitCommandHead(`start "a b.md"`), {
    head: "start",
    rest: '"a b.md"',
  });
  assert.deepEqual(splitCommandHead("view  child "), {
    head: "view",
    rest: "child",
  });
});

// ── stripOneQuotePair ───────────────────────────────────────────────

test("strip: removes one matching double or single pair", () => {
  assert.equal(stripOneQuotePair('"a b.md"'), "a b.md");
  assert.equal(stripOneQuotePair("'a b.md'"), "a b.md");
  assert.equal(stripOneQuotePair(`"plain.md"`), "plain.md");
});

test("strip: trims outer whitespace before matching", () => {
  assert.equal(stripOneQuotePair('  " a.md "  '), " a.md ");
});

test("strip: unmatched or mismatched quotes are left alone", () => {
  assert.equal(stripOneQuotePair('"a.md'), '"a.md');
  assert.equal(stripOneQuotePair("a.md'"), "a.md'");
  assert.equal(stripOneQuotePair(`'a.md"`), `'a.md"`);
  assert.equal(stripOneQuotePair("a.md"), "a.md");
});

test("strip: only ONE pair is removed", () => {
  assert.equal(stripOneQuotePair(`""`), "");
  assert.equal(stripOneQuotePair(`'""'`), '""');
  assert.equal(stripOneQuotePair(`"'"`), "'");
});

test("strip: single characters and non-strings are safe", () => {
  assert.equal(stripOneQuotePair('"'), '"');
  assert.equal(stripOneQuotePair(""), "");
  assert.equal(stripOneQuotePair("   "), "");
  assert.equal(stripOneQuotePair(undefined), "");
  assert.equal(stripOneQuotePair(42), "");
});

// ── suggestVerb ─────────────────────────────────────────────────────

const VERBS = ["start", "status", "stop", "pause", "help"];

test("suggest: edit distance 1 and 2 are suggested, 0 is not", () => {
  assert.equal(SUGGEST_MAX_DISTANCE, 2);
  assert.deepEqual(suggestVerb("strat", VERBS), {
    verb: "start",
    migration: false,
    text: 'Did you mean "start"?',
  });
  assert.deepEqual(suggestVerb("statsu", VERBS), {
    verb: "status",
    migration: false,
    text: 'Did you mean "status"?',
  });
  // distance 2 from "stop"
  assert.equal(suggestVerb("stp", VERBS)?.verb, "stop");
  assert.equal(suggestVerb("status", VERBS), undefined);
  assert.equal(suggestVerb("STATUS", VERBS), undefined);
});

test("suggest: distance 3 or more is not suggested", () => {
  assert.equal(suggestVerb("zzzzzz", VERBS), undefined);
  assert.equal(suggestVerb("statusxyz", VERBS), undefined);
  assert.equal(suggestVerb("", VERBS), undefined);
});

test("suggest: the nearest verb wins and ties break alphabetically", () => {
  // "stat" → start (1) beats status (2).
  assert.equal(suggestVerb("stat", VERBS)?.verb, "start");
  // "paus" → pause (1).
  assert.equal(suggestVerb("paus", VERBS)?.verb, "pause");
  // Two candidates at distance 1: the alphabetically first wins.
  assert.equal(suggestVerb("abc", ["abf", "abd"])?.verb, "abd");
  // "stap" is 1 from "stop" (a→o) and 2 from "start".
  assert.equal(suggestVerb("stap", ["stop", "start"])?.verb, "stop");
});

test("suggest: only alphabetic tokens are corrected", () => {
  for (const token of ["3", "row-2", ".pi/plans/a.md", "a b", "st4tus", "-h"]) {
    assert.equal(suggestVerb(token, VERBS), undefined, token);
  }
});

test("suggest: cancel is the documented migration to stop", () => {
  const suggestion = suggestVerb("cancel", VERBS);
  assert.deepEqual(suggestion, {
    verb: "stop",
    migration: true,
    text: CANCEL_MIGRATION_SENTENCE,
  });
  assert.equal(CANCEL_MIGRATION_SENTENCE, '"cancel" is now "stop".');
  // Case-insensitive, like every verb position.
  assert.equal(suggestVerb("CANCEL", VERBS)?.migration, true);
});

test("suggest: cancel without stop in the table falls back to distance", () => {
  const suggestion = suggestVerb("cancel", ["start", "status"]);
  assert.equal(suggestion, undefined);
  assert.equal(suggestVerb("canel", ["cancel", "stop"])?.verb, "cancel");
});

test("suggest: an empty or non-string verb list yields nothing", () => {
  assert.equal(suggestVerb("strat", []), undefined);
  assert.equal(suggestVerb("strat", ["" as string]), undefined);
  assert.equal(suggestVerb(undefined, VERBS), undefined);
  assert.equal(suggestVerb("  strat  ", VERBS)?.verb, "start");
});
