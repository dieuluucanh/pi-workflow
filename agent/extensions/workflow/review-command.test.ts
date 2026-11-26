/**
 * Workflow Extension — `/review` command grammar tests.
 *
 * Run with: npm test   (node --test, type-stripping — no build step)
 *
 * Covers the pure table module: every verb and its Decision 3 guard class,
 * the default-form path fallback (Decision 5) including verb shadowing,
 * case-insensitive verbs, `--help`/`help [verb]`, the strict `mode` and
 * `prompt` sub-grammars, `say`/`resume` text, the unknown-token suggestion
 * helper, the `status` vs `mode status` help distinction, grouped help
 * completeness (no removed names) and completions at every position.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_REVIEW_MODE_CONFIG, formatReviewStatusLines } from "./review.ts";
import {
  REVIEW_DEFAULT_FORM,
  REVIEW_DESCRIPTION,
  REVIEW_GROUPS,
  REVIEW_MODE_SCOPES,
  REVIEW_MODE_SUBS,
  REVIEW_VERBS,
  REVIEW_VERB_NAMES,
  describeReviewGuards,
  formatReviewHelp,
  isReviewModeScope,
  isReviewModeSub,
  reviewCompletionItems,
  reviewDefaultForm,
  reviewVerb,
  suggestReviewVerb,
  parseReviewInvocation,
} from "./review-command.ts";

const EXPECTED_VERBS = [
  "status",
  "pause",
  "resume",
  "abort",
  "say",
  "mode",
  "prompt",
  "help",
];

const REMOVED = [
  "/review-mode",
  "/review-prompt",
  "/review-status",
  "/review-pause",
  "/review-resume",
  "/review-abort",
];

function spec(name: string) {
  const found = reviewVerb(name);
  assert.ok(found, `missing verb ${name}`);
  return found;
}

function parsed(raw: unknown) {
  const result = parseReviewInvocation(raw);
  assert.equal(
    result.kind,
    "verb",
    `expected verb for ${JSON.stringify(raw)}, got ${JSON.stringify(result)}`,
  );
  assert.ok(result.kind === "verb");
  return result;
}

function defaulted(raw: unknown) {
  const result = parseReviewInvocation(raw);
  assert.equal(
    result.kind,
    "default",
    `expected default form for ${JSON.stringify(raw)}, got ${JSON.stringify(result)}`,
  );
  assert.ok(result.kind === "default");
  return result;
}

function failed(raw: unknown) {
  const result = parseReviewInvocation(raw);
  assert.equal(
    result.kind,
    "error",
    `expected error for ${JSON.stringify(raw)}, got ${JSON.stringify(result)}`,
  );
  assert.ok(result.kind === "error");
  return result;
}

function labels(items: ReturnType<typeof reviewCompletionItems>) {
  assert.ok(items, "expected completion items");
  return items.map((item) => item.label);
}

// ── The table ────────────────────────────────────────────────────────

test("table: exactly the eight documented verbs, no duplicates, no aliases", () => {
  assert.deepEqual([...REVIEW_VERB_NAMES], EXPECTED_VERBS);
  assert.equal(new Set(REVIEW_VERB_NAMES).size, EXPECTED_VERBS.length);
  assert.equal(REVIEW_VERBS.length, EXPECTED_VERBS.length);
  assert.equal(reviewVerb(""), undefined);
  assert.equal(reviewVerb("review"), undefined, "the default form is not a verb");
  assert.equal(reviewVerb("stat"), undefined, "no prefix matching");
  assert.equal(reviewVerb("Status ")?.name, "status", "outer spaces are tolerated");
  for (const removed of [
    "review-mode",
    "review-prompt",
    "review-status",
    "review-pause",
    "review-resume",
    "review-abort",
  ]) {
    assert.equal(reviewVerb(removed), undefined, removed);
  }
});

test("table: the default form is /review [path] with the same guard class as say", () => {
  assert.equal(REVIEW_DEFAULT_FORM.name, "");
  assert.equal(REVIEW_DEFAULT_FORM.usage, "/review [path]");
  assert.equal(REVIEW_DEFAULT_FORM.group, "round");
  assert.equal(REVIEW_DEFAULT_FORM.blockWhileChildActive, true);
  assert.equal(REVIEW_DEFAULT_FORM.admission, "manual");
  assert.equal(reviewDefaultForm(), REVIEW_DEFAULT_FORM);
});

test("table: every verb has usage, summary and a known group", () => {
  for (const entry of REVIEW_VERBS) {
    assert.ok(entry.usage.startsWith(`/review ${entry.name}`), entry.name);
    assert.ok(entry.summary.length > 10, entry.name);
    assert.ok(
      REVIEW_GROUPS.some((group) => group.key === entry.group),
      entry.name,
    );
  }
});

test("guards: status/pause/abort/prompt/help never block or admit", () => {
  for (const name of ["status", "pause", "abort", "prompt", "help"]) {
    const entry = spec(name);
    assert.equal(entry.blockWhileChildActive, false, name);
    assert.equal(entry.admission, "none", name);
  }
});

test("guards: say blocks on a child and admits on the manual trigger", () => {
  const say = spec("say");
  assert.equal(say.blockWhileChildActive, true);
  assert.equal(say.blockLabel, "/review");
  assert.equal(say.admission, "manual");
});

test("guards: resume admits on the resume trigger and does not block", () => {
  const resume = spec("resume");
  assert.equal(resume.blockWhileChildActive, false);
  assert.equal(resume.admission, "resume");
});

test("guards: mode blocks with the /review mode label and never admits", () => {
  const mode = spec("mode");
  assert.equal(mode.blockWhileChildActive, true);
  assert.equal(mode.blockLabel, "/review mode");
  assert.equal(mode.admission, "none");
});

test("guards: describeReviewGuards names each class", () => {
  assert.match(describeReviewGuards(spec("status")), /^No guards/);
  assert.match(describeReviewGuards(spec("resume")), /`resume` trigger/);
  assert.doesNotMatch(describeReviewGuards(spec("resume")), /Build child/);
  const say = describeReviewGuards(spec("say"));
  assert.match(say, /Build child is active \(\/review\)/);
  assert.match(say, /`manual` trigger/);
  const mode = describeReviewGuards(spec("mode"));
  assert.match(mode, /Build child is active \(\/review mode\)/);
  assert.doesNotMatch(mode, /admission/i);
});

test("description names the round form and every verb, with no removed names", () => {
  assert.match(REVIEW_DESCRIPTION, /one-shot Review round/);
  assert.match(REVIEW_DESCRIPTION, /\/review <path>/);
  for (const name of EXPECTED_VERBS) {
    assert.match(REVIEW_DESCRIPTION, new RegExp(name));
  }
  for (const removed of REMOVED) {
    assert.equal(REVIEW_DESCRIPTION.includes(removed), false, removed);
  }
});

// ── Parsing: the default form (Decision 5) ───────────────────────────

test("parse: empty, whitespace and non-strings are the empty default form", () => {
  for (const raw of ["", "   ", "\n\t ", undefined, null, 42]) {
    assert.deepEqual(parseReviewInvocation(raw), { kind: "default", text: "" });
  }
});

test("parse: a non-verb is a path, trimmed and one quote pair stripped", () => {
  assert.deepEqual(defaulted("  .pi/plans/a.md  "), {
    kind: "default",
    text: ".pi/plans/a.md",
  });
  assert.deepEqual(defaulted(`"a b.md"`), { kind: "default", text: "a b.md" });
  assert.deepEqual(defaulted(`'a b.md'`), { kind: "default", text: "a b.md" });
  assert.deepEqual(defaulted(`"Plans/Foo.MD"`), {
    kind: "default",
    text: "Plans/Foo.MD",
    // case is preserved for paths
  });
  assert.deepEqual(defaulted(`'"quoted".md'`), {
    kind: "default",
    text: '"quoted".md',
    // only ONE pair is stripped
  });
  assert.deepEqual(defaulted(`"unmatched.md`), {
    kind: "default",
    text: `"unmatched.md`,
  });
});

test("parse: a spaced, unquoted path keeps every token", () => {
  assert.deepEqual(defaulted(".pi/plans/a b.md"), {
    kind: "default",
    text: ".pi/plans/a b.md",
  });
});

test("parse: verbs shadow a same-named plan, quoting makes it a path again", () => {
  for (const name of EXPECTED_VERBS) {
    const result = parseReviewInvocation(name);
    // The plan never wins: `say` demands a message and `help` prints help.
    assert.notEqual(result.kind, "default", name);
    if (name === "say") {
      assert.equal(result.kind, "error", name);
    } else if (name === "help") {
      assert.equal(result.kind, "help", name);
    } else {
      assert.equal(result.kind, "verb", name);
    }
    assert.deepEqual(defaulted(`"${name}"`), { kind: "default", text: name });
  }
  assert.deepEqual(defaulted(".pi/plans/status.md"), {
    kind: "default",
    text: ".pi/plans/status.md",
  });
  assert.deepEqual(defaulted("status.md"), { kind: "default", text: "status.md" });
});

test("parse: verbs are case-insensitive", () => {
  for (const raw of ["Status", "STATUS", "  sTaTus  "]) {
    assert.equal(parsed(raw).verb, "status", raw);
  }
  assert.equal(parsed("PAUSE").verb, "pause");
  assert.equal(parsed("Abort").verb, "abort");
  assert.equal(parsed("MoDe status").verb, "mode");
});

// ── Parsing: help ────────────────────────────────────────────────────

test("parse: --help, -h and help print the list", () => {
  for (const raw of ["--help", "-h", "help", "HELP", " --HELP "]) {
    assert.deepEqual(parseReviewInvocation(raw), { kind: "help" }, raw);
  }
});

test("parse: help names one verb, case-insensitively", () => {
  assert.deepEqual(parseReviewInvocation("help status"), {
    kind: "help",
    verb: "status",
  });
  assert.deepEqual(parseReviewInvocation("help mode"), {
    kind: "help",
    verb: "mode",
  });
  assert.deepEqual(parseReviewInvocation("--help pause"), {
    kind: "help",
    verb: "pause",
  });
  assert.deepEqual(parseReviewInvocation("status --help"), {
    kind: "help",
    verb: "status",
  });
  assert.deepEqual(parseReviewInvocation("mode -h"), {
    kind: "help",
    verb: "mode",
  });
  assert.deepEqual(parseReviewInvocation("help --help"), { kind: "help" });
});

test("parse: help for an unknown verb errors with a suggestion", () => {
  const result = failed("help statsu");
  assert.match(result.text, /Unknown Review verb "statsu"/);
  assert.match(result.text, /Did you mean "status"\?/);
});

// ── Parsing: say / resume / zero-arg verbs ───────────────────────────

test("parse: say keeps the message verbatim and refuses empty", () => {
  assert.deepEqual(parsed("say focus on the failing test  "), {
    kind: "verb",
    verb: "say",
    text: "focus on the failing test",
  });
  assert.deepEqual(parsed('say "keep the quotes"'), {
    kind: "verb",
    verb: "say",
    text: '"keep the quotes"',
  });
  const empty = failed("say   ");
  assert.match(empty.text, /message is required/i);
  assert.match(empty.text, /Usage: \/review say <msg>/);
});

test("parse: resume takes an optional free-text note", () => {
  assert.deepEqual(parsed("resume"), { kind: "verb", verb: "resume" });
  assert.deepEqual(parsed("resume continue from pass 2"), {
    kind: "verb",
    verb: "resume",
    note: "continue from pass 2",
  });
});

test("parse: status/pause/abort reject extra tokens with usage", () => {
  for (const name of ["status", "pause", "abort"]) {
    const result = failed(`${name} now`);
    assert.match(result.text, /Unexpected argument "now"/, name);
    assert.match(result.text, new RegExp(`Usage: /review ${name}`), name);
  }
});

// ── Parsing: strict mode sub-grammar ─────────────────────────────────

test("mode: enums are exactly the documented values", () => {
  assert.deepEqual([...REVIEW_MODE_SUBS], ["on", "off", "status", "timeout"]);
  assert.deepEqual([...REVIEW_MODE_SCOPES], ["global", "project"]);
  for (const sub of REVIEW_MODE_SUBS) assert.ok(isReviewModeSub(sub));
  assert.ok(isReviewModeSub("ON"), "case-insensitive");
  for (const bad of ["on ", "", "enable"]) {
    assert.equal(isReviewModeSub(bad), false, bad);
  }
  for (const scope of REVIEW_MODE_SCOPES) assert.ok(isReviewModeScope(scope));
  assert.ok(isReviewModeScope("GLOBAL"), "case-insensitive");
  for (const bad of ["global ", "", "user"]) {
    assert.equal(isReviewModeScope(bad), false, bad);
  }
});

test("mode: bare and `mode status` report configuration", () => {
  assert.deepEqual(parsed("mode"), {
    kind: "verb",
    verb: "mode",
    mode: { action: "status" },
  });
  assert.deepEqual(parsed("mode status"), {
    kind: "verb",
    verb: "mode",
    mode: { action: "status" },
  });
});

test("mode: on/off default to global and accept an explicit scope", () => {
  assert.deepEqual(parsed("mode on"), {
    kind: "verb",
    verb: "mode",
    mode: { action: "on", scope: "global" },
  });
  assert.deepEqual(parsed("mode OFF"), {
    kind: "verb",
    verb: "mode",
    mode: { action: "off", scope: "global" },
  });
  assert.deepEqual(parsed("mode off project"), {
    kind: "verb",
    verb: "mode",
    mode: { action: "off", scope: "project" },
  });
  assert.deepEqual(parsed("mode on Global"), {
    kind: "verb",
    verb: "mode",
    mode: { action: "on", scope: "global" },
  });
});

test("mode timeout: no value shows the current setting, a value is carried", () => {
  assert.deepEqual(parsed("mode timeout"), {
    kind: "verb",
    verb: "mode",
    mode: { action: "timeout", scope: "global" },
  });
  assert.deepEqual(parsed("mode timeout 600"), {
    kind: "verb",
    verb: "mode",
    mode: { action: "timeout", scope: "global", value: "600" },
  });
  assert.deepEqual(parsed("mode timeout unlimited project"), {
    kind: "verb",
    verb: "mode",
    mode: { action: "timeout", scope: "project", value: "unlimited" },
  });
  assert.deepEqual(parsed("mode timeout 0 global"), {
    kind: "verb",
    verb: "mode",
    mode: { action: "timeout", scope: "global", value: "0" },
  });
  assert.deepEqual(parsed("mode timeout off"), {
    kind: "verb",
    verb: "mode",
    mode: { action: "timeout", scope: "global", value: "off" },
  });
});

test("mode: an unknown subcommand or scope is named in the error", () => {
  const sub = failed("mode garbage");
  assert.match(sub.text, /Unknown review mode subcommand "garbage"/);
  assert.match(sub.text, /Usage: \/review mode/);

  const scope = failed("mode on garbage");
  assert.match(scope.text, /Unknown scope "garbage"/);
  assert.match(scope.text, /global\|project/);

  const timeoutScope = failed("mode timeout 600 garbage");
  assert.match(timeoutScope.text, /Unknown scope "garbage"/);

  const badValue = failed("mode timeout abc");
  assert.match(badValue.text, /Invalid timeout "abc"/);
  assert.match(badValue.text, /<seconds\|unlimited>/);
});

test("mode: extra tokens are rejected, not silently dropped", () => {
  assert.match(failed("mode status now").text, /Unexpected argument "now"/);
  assert.match(failed("mode on global extra").text, /Unexpected argument "extra"/);
  assert.match(
    failed("mode timeout 600 global extra").text,
    /Unexpected argument "extra"/,
  );
});

// ── Parsing: prompt scope ────────────────────────────────────────────

test("prompt: scope defaults to project and accepts global", () => {
  assert.deepEqual(parsed("prompt"), {
    kind: "verb",
    verb: "prompt",
    scope: "project",
  });
  assert.deepEqual(parsed("prompt global"), {
    kind: "verb",
    verb: "prompt",
    scope: "global",
  });
  assert.deepEqual(parsed("prompt GLOBAL"), {
    kind: "verb",
    verb: "prompt",
    scope: "global",
  });
  assert.deepEqual(parsed("prompt project"), {
    kind: "verb",
    verb: "prompt",
    scope: "project",
  });
});

test("prompt: a junk scope or an extra token is a usage error naming it", () => {
  const junk = failed("prompt junk");
  assert.match(junk.text, /Unknown scope "junk"/);
  assert.match(junk.text, /Usage: \/review prompt \[global\]/);
  const extra = failed("prompt global now");
  assert.match(extra.text, /Unexpected argument "now"/);
});

// ── Suggestion helper (handler calls it after path resolution fails) ─
test("suggestReviewVerb: nearest alphabetic verb within distance 2", () => {
  assert.deepEqual(suggestReviewVerb("statsu"), {
    verb: "status",
    migration: false,
    text: 'Did you mean "status"?',
  });
  assert.deepEqual(suggestReviewVerb("paus"), {
    verb: "pause",
    migration: false,
    text: 'Did you mean "pause"?',
  });
  assert.equal(suggestReviewVerb("mod")?.verb, "mode");
  assert.equal(suggestReviewVerb("Status"), undefined, "exact matches are not hints");
});

test("suggestReviewVerb: paths, refs and far tokens are never corrected", () => {
  for (const token of [
    "zzzzzz",
    ".pi/plans/status.md",
    "2",
    "",
    "cancel",
    "review-mode",
    42,
  ]) {
    assert.equal(suggestReviewVerb(token), undefined, String(token));
  }
});

// ── Help ─────────────────────────────────────────────────────────────

test("help: every form appears once, grouped, with no removed names", () => {
  const help = formatReviewHelp();
  const entries = [REVIEW_DEFAULT_FORM, ...REVIEW_VERBS];
  for (const entry of entries) {
    const lines = help
      .split("\n")
      .filter((line) => line.startsWith("  ") && line.trimStart().startsWith(entry.usage));
    assert.equal(lines.length, 1, `${entry.usage} appears ${lines.length} times`);
  }
  for (const group of REVIEW_GROUPS) {
    assert.match(help, new RegExp(`^${group.title}$`, "m"));
  }
  for (const removed of REMOVED) {
    assert.equal(help.includes(removed), false, removed);
  }
  assert.equal(help.includes("Aliases:"), false);
});

test("help: teaches the bare/path form and the verb shadowing caveat", () => {
  const help = formatReviewHelp();
  assert.match(help, /Bare \/review runs a one-shot Review round/);
  assert.match(help, /\/review <path>/);
  assert.match(help, /no aliases/);
  assert.match(help, /Shadowing: a plan file named exactly/);
  for (const name of EXPECTED_VERBS) {
    assert.match(help, new RegExp(`\`${name}\``), name);
  }
  assert.match(help, /quote the path/);
});

test("help: teaches /review status vs /review mode status", () => {
  const help = formatReviewHelp();
  assert.match(help, /\/review status reports the review round/);
  assert.match(help, /\/review mode status reports configuration/);
  assert.match(help, /enabled, timeout and source, prompt source, shadowed scope/);
});

test("help: one verb prints its usage, summary and guards", () => {
  assert.match(formatReviewHelp("resume"), /^Usage: \/review resume \[note\]$/m);
  assert.match(formatReviewHelp("resume"), /paused round/i);
  assert.match(formatReviewHelp("resume"), /Guards: Reviewer admission on the `resume` trigger/);
  assert.match(formatReviewHelp("say"), /Guards: refuses while a Build child is active/);
  assert.match(formatReviewHelp("status"), /Guards: No guards/);
  assert.match(formatReviewHelp("status"), /Run \/review help for every verb/);
});

test("help: unknown or blank verb input falls back to the full list", () => {
  assert.equal(formatReviewHelp("nope"), formatReviewHelp());
  assert.equal(formatReviewHelp(undefined), formatReviewHelp());
  assert.equal(formatReviewHelp(42), formatReviewHelp());
});

// ── Completions ──────────────────────────────────────────────────────

const CTX = { plans: [".pi/plans/a.md", ".pi/plans/b.md"] };

test("completions: verb position offers every verb plus recent plans", () => {
  const items = reviewCompletionItems("", CTX);
  assert.ok(items);
  assert.deepEqual(items.map((item) => item.label), [
    ...EXPECTED_VERBS,
    ".pi/plans/a.md",
    ".pi/plans/b.md",
  ]);
  const byLabel = new Map(items.map((item) => [item.label, item.value]));
  assert.equal(byLabel.get("status"), "status");
  assert.equal(byLabel.get("pause"), "pause");
  assert.equal(byLabel.get("resume"), "resume");
  assert.equal(byLabel.get("abort"), "abort");
  assert.equal(byLabel.get("say"), "say ");
  assert.equal(byLabel.get("mode"), "mode ");
  assert.equal(byLabel.get("prompt"), "prompt ");
  assert.equal(byLabel.get("help"), "help ");
  assert.equal(byLabel.get(".pi/plans/a.md"), ".pi/plans/a.md");
});

test("completions: verb filtering is case-insensitive and prefix-based", () => {
  assert.deepEqual(labels(reviewCompletionItems("sta")), ["status"]);
  assert.deepEqual(labels(reviewCompletionItems("P")), [
    "pause",
    "prompt",
  ]);
  assert.equal(reviewCompletionItems("zzz"), null);
});

test("completions: a plan path is completed while it is the only token", () => {
  const items = reviewCompletionItems(".pi/plans/b", CTX);
  assert.ok(items);
  assert.deepEqual(items.map((item) => item.label), [".pi/plans/b.md"]);
  assert.equal(items[0]?.value, ".pi/plans/b.md");
  assert.equal(items[0]?.description, "review this plan");
  assert.equal(reviewCompletionItems(".pi/plans/b.md", CTX), null);
  assert.equal(reviewCompletionItems(".pi/plans/nope", CTX), null);
});

test("completions: an exactly typed verb closes the dropdown", () => {
  for (const name of ["status", "mode", "help"]) {
    assert.equal(reviewCompletionItems(name, CTX), null, name);
  }
});

test("completions: mode offers subs, scopes and the unlimited value", () => {
  assert.deepEqual(labels(reviewCompletionItems("mode ")), [
    "on",
    "off",
    "status",
    "timeout",
  ]);
  assert.deepEqual(labels(reviewCompletionItems("mode t")), ["timeout"]);
  const on = reviewCompletionItems("mode on ");
  assert.ok(on);
  assert.deepEqual(on.map((item) => item.label), ["global", "project"]);
  assert.equal(on[0]?.value, "mode on global");
  assert.deepEqual(labels(reviewCompletionItems("mode off p")), ["project"]);
  assert.equal(reviewCompletionItems("mode on global"), null);

  assert.deepEqual(labels(reviewCompletionItems("mode timeout ")), ["unlimited"]);
  assert.equal(reviewCompletionItems("mode timeout 6"), null);
  const scoped = reviewCompletionItems("mode timeout 600 ");
  assert.ok(scoped);
  assert.deepEqual(scoped.map((item) => item.label), ["global", "project"]);
  assert.equal(scoped[1]?.value, "mode timeout 600 project");
  assert.equal(reviewCompletionItems("mode timeout 600 global"), null);
  assert.equal(reviewCompletionItems("mode status "), null);
});

test("completions: prompt offers scopes only", () => {
  const items = reviewCompletionItems("prompt ");
  assert.ok(items);
  assert.deepEqual(items.map((item) => item.label), ["global", "project"]);
  assert.equal(items[0]?.value, "prompt global");
  assert.deepEqual(labels(reviewCompletionItems("prompt g")), ["global"]);
  assert.equal(reviewCompletionItems("prompt global"), null);
  assert.equal(reviewCompletionItems("prompt global "), null);
});

test("completions: help offers verb names", () => {
  const items = reviewCompletionItems("help ");
  assert.ok(items);
  assert.deepEqual(items.map((item) => item.label), EXPECTED_VERBS);
  assert.equal(items[0]?.value, "help status");
  assert.deepEqual(labels(reviewCompletionItems("help pa")), ["pause"]);
  assert.equal(reviewCompletionItems("help status"), null);
});

test("completions: free text and argument-less verbs offer nothing", () => {
  for (const raw of [
    "say ",
    "say hi",
    "status ",
    "pause now",
    "abort ",
    "resume note",
    "mode on global extra",
    ".pi/plans/a.md ",
  ]) {
    assert.equal(reviewCompletionItems(raw, CTX), null, raw);
  }
});

test("completions: non-string input behaves like the verb position", () => {
  assert.deepEqual(
    labels(reviewCompletionItems(undefined, CTX)),
    [...EXPECTED_VERBS, ".pi/plans/a.md", ".pi/plans/b.md"],
  );
  assert.deepEqual(labels(reviewCompletionItems(null)), EXPECTED_VERBS);
});

// ── Revision budget copy ─────────────────────────────────────────────

test("help: names the revision budget", () => {
  const help = formatReviewHelp();
  assert.match(help, /maxRevisions/);
  assert.match(help, /0-5, default 3/);
  assert.match(help, /0 makes every review one-shot/);
  // The mode verb itself carries the name, so `/review help mode` teaches it.
  assert.match(formatReviewHelp("mode"), /maxRevisions/);
});

test("status: the config block shows the revisions value beside rounds/passes", () => {
  const lines = formatReviewStatusLines({
    enabled: true,
    config: { ...DEFAULT_REVIEW_MODE_CONFIG, rounds: 1, maxRevisions: 3, passes: 2 },
    timeoutSource: "default",
    promptSource: "default",
    sources: { global: false, project: false },
    runtime: "not started",
  });
  const row = lines.find((line) => line.includes("rounds"));
  assert.ok(row, `missing rounds row in:\n${lines.join("\n")}`);
  assert.match(row, /rounds\s+: 1/);
  assert.match(row, /revisions: 3/);
  assert.match(row, /passes: 2/);

  const disabledBudget = formatReviewStatusLines({
    enabled: false,
    config: { ...DEFAULT_REVIEW_MODE_CONFIG, maxRevisions: 0 },
    timeoutSource: "default",
    promptSource: "default",
    sources: { global: false, project: false },
    runtime: "not started",
  });
  const disabledRow = disabledBudget.find((line) => line.includes("rounds"));
  assert.ok(disabledRow);
  assert.match(disabledRow, /revisions: 0/);
});
