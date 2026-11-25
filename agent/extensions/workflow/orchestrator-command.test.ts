/**
 * Workflow Extension — `/orchestrator` command grammar tests.
 *
 * Run with: npm test   (node --test, type-stripping — no build step)
 *
 * Covers the pure table module: every verb and its Decision 3 guard flags,
 * case-insensitive parsing, `--help`/`help [verb]`, zero-arg rejection, the
 * `view` enum, quoted/spaced `start` paths, row refs, `say` limits, unknown
 * verbs with the nearest hint, the `cancel` → `stop` migration, grouped help
 * completeness (one line per non-help verb, no aliases) and completions at
 * every position.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_SAY_CHARS,
  ORCHESTRATOR_DESCRIPTION,
  ORCHESTRATOR_GROUPS,
  ORCHESTRATOR_VERB_NAMES,
  ORCHESTRATOR_VERBS,
  ORCHESTRATOR_VIEWS,
  describeOrchestratorGuards,
  formatOrchestratorHelp,
  isOrchestratorView,
  orchestratorCompletionItems,
  orchestratorVerb,
  parseOrchestratorInvocation,
} from "./orchestrator-command.ts";

const EXPECTED_VERBS = [
  "start",
  "status",
  "inspect",
  "retry",
  "pause",
  "resume",
  "abort",
  "stop",
  "say",
  "view",
  "help",
];

function spec(name: string) {
  const found = orchestratorVerb(name);
  assert.ok(found, `missing verb ${name}`);
  return found;
}

function parsed(raw: string) {
  const result = parseOrchestratorInvocation(raw);
  assert.equal(result.kind, "verb", `expected verb for "${raw}", got ${JSON.stringify(result)}`);
  assert.ok(result.kind === "verb");
  return result;
}

function failed(raw: string) {
  const result = parseOrchestratorInvocation(raw);
  assert.equal(result.kind, "error", `expected error for "${raw}", got ${JSON.stringify(result)}`);
  assert.ok(result.kind === "error");
  return result;
}

// ── The table ────────────────────────────────────────────────────────

test("table: exactly the eleven documented verbs, no duplicates, no aliases", () => {
  assert.deepEqual([...ORCHESTRATOR_VERB_NAMES], EXPECTED_VERBS);
  assert.equal(new Set(ORCHESTRATOR_VERB_NAMES).size, EXPECTED_VERBS.length);
  assert.equal(ORCHESTRATOR_VERBS.length, EXPECTED_VERBS.length);
  assert.equal(orchestratorVerb("cancel"), undefined);
  assert.equal(orchestratorVerb("paus"), undefined, "no prefix matching");
  assert.equal(orchestratorVerb("pause ")?.name, "pause", "outer spaces are tolerated");
  for (const removed of [
    "orchestrator-pause",
    "orchestrator-resume",
    "orchestrator-abort",
    "orchestrator-view",
  ]) {
    assert.equal(orchestratorVerb(removed), undefined);
  }
});

test("table: every verb has usage, summary, args and a group", () => {
  for (const entry of ORCHESTRATOR_VERBS) {
    assert.ok(entry.usage.startsWith(`/orchestrator ${entry.name}`), entry.name);
    assert.ok(entry.summary.length > 10, entry.name);
    assert.ok(
      ["none", "path?", "rowRef?", "view", "text"].includes(entry.args),
      entry.name,
    );
    assert.ok(
      ORCHESTRATOR_GROUPS.some((group) => group.key === entry.group),
      entry.name,
    );
  }
});

test("guards: status needs no mode and no run", () => {
  const status = spec("status");
  assert.equal(status.requiresMode, false);
  assert.equal(status.run, "none");
  assert.equal(status.requiresChild, false);
});

test("guards: start needs Orchestrator mode and refuses a bound run", () => {
  const start = spec("start");
  assert.equal(start.requiresMode, true);
  assert.equal(start.run, "forbidden");
  assert.equal(start.requiresChild, false);
});

test("guards: pause needs mode, a bound run and a live child", () => {
  const pause = spec("pause");
  assert.equal(pause.requiresMode, true);
  assert.equal(pause.run, "required");
  assert.equal(pause.requiresChild, true);
});

test("guards: control verbs require mode and a run; only pause/abort/say need a child", () => {
  for (const name of ["resume", "abort", "retry", "stop", "say"]) {
    const entry = spec(name);
    assert.equal(entry.requiresMode, true, name);
    assert.equal(entry.run, "required", name);
  }
  for (const name of ["pause", "abort", "say"]) {
    assert.equal(spec(name).requiresChild, true, name);
  }
  for (const name of ["resume", "retry", "stop"]) {
    assert.equal(spec(name).requiresChild, false, name);
  }
});

test("guards: status/inspect/view/help work in any mode", () => {
  for (const name of ["status", "inspect", "view", "help"]) {
    assert.equal(spec(name).requiresMode, false, name);
  }
  assert.equal(spec("inspect").run, "required", "inspect still needs a run to read");
});

test("guards: describeOrchestratorGuards names mode, run and child", () => {
  assert.match(describeOrchestratorGuards(spec("status")), /any mode/);
  assert.match(describeOrchestratorGuards(spec("status")), /no run needed/);
  assert.match(describeOrchestratorGuards(spec("start")), /refuses an already-bound run/);
  const pause = describeOrchestratorGuards(spec("pause"));
  assert.match(pause, /Orchestrator mode required/);
  assert.match(pause, /a bound run is required/);
  assert.match(pause, /live or paused child/);
});

test("view: the enum is child/parent/auto and the guard accepts all three", () => {
  assert.deepEqual([...ORCHESTRATOR_VIEWS], ["child", "parent", "auto"]);
  for (const view of ORCHESTRATOR_VIEWS) assert.ok(isOrchestratorView(view));
  for (const bad of ["", "CHILD", "both", "parent "]) {
    assert.equal(isOrchestratorView(bad), false, bad);
  }
});

test("description names the bare form and the verbs", () => {
  assert.match(ORCHESTRATOR_DESCRIPTION, /Enter Orchestrator mode/);
  assert.match(ORCHESTRATOR_DESCRIPTION, /start \[path\]/);
  assert.match(ORCHESTRATOR_DESCRIPTION, /stop/);
  assert.match(ORCHESTRATOR_DESCRIPTION, /help \[verb\]/);
  assert.doesNotMatch(ORCHESTRATOR_DESCRIPTION, /cancel|orchestrator-pause/);
});

// ── Parsing: entry, help ─────────────────────────────────────────────

test("parse: empty and whitespace are mode entry", () => {
  for (const raw of ["", "   ", "\n\t ", undefined, null, 42]) {
    assert.deepEqual(parseOrchestratorInvocation(raw), { kind: "mode-entry" });
  }
});

test("parse: --help, -h and help print the list", () => {
  for (const raw of ["--help", "-h", "help", "HELP", " --HELP "]) {
    assert.deepEqual(parseOrchestratorInvocation(raw), { kind: "help" }, raw);
  }
});

test("parse: help names one verb, case-insensitively", () => {
  assert.deepEqual(parseOrchestratorInvocation("help start"), {
    kind: "help",
    verb: "start",
  });
  assert.deepEqual(parseOrchestratorInvocation("help --help"), { kind: "help" });
  assert.deepEqual(parseOrchestratorInvocation("--help pause"), {
    kind: "help",
    verb: "pause",
  });
  assert.deepEqual(parseOrchestratorInvocation("status --help"), {
    kind: "help",
    verb: "status",
  });
  assert.deepEqual(parseOrchestratorInvocation("say -h"), {
    kind: "help",
    verb: "say",
  });
});

test("parse: help for an unknown verb errors with a suggestion", () => {
  const result = failed("help statsu");
  assert.match(result.text, /Unknown Orchestrator verb "statsu"/);
  assert.match(result.text, /Did you mean "status"\?/);
});

// ── Parsing: verbs ───────────────────────────────────────────────────

test("parse: every zero-argument verb parses with no argument", () => {
  for (const name of ["status", "pause", "resume", "abort", "stop"]) {
    const result = parsed(name);
    assert.equal(result.verb, name);
    assert.equal(result.path, undefined, name);
    assert.equal(result.rowRef, undefined, name);
    assert.equal(result.text, undefined, name);
    assert.equal(result.view, undefined, name);
  }
});

test("parse: verbs are case-insensitive", () => {
  for (const raw of ["Status", "STATUS", "  sTaTus  "]) {
    assert.equal(parsed(raw).verb, "status", raw);
  }
  assert.equal(parsed("PAUSE").verb, "pause");
  assert.equal(parsed("StOp").verb, "stop");
});

test("parse: zero-argument verbs reject extra tokens with usage", () => {
  for (const name of ["status", "pause", "resume", "abort", "stop"]) {
    const result = failed(`${name} now`);
    assert.match(result.text, /Unexpected argument "now"/, name);
    assert.match(result.text, new RegExp(`Usage: /orchestrator ${name}`), name);
  }
});

test("parse: start accepts no path, one quoted pair, or a spaced path", () => {
  assert.deepEqual(parsed("start"), { kind: "verb", verb: "start" });
  assert.deepEqual(parsed(`start "a b.md"`), {
    kind: "verb",
    verb: "start",
    path: "a b.md",
  });
  assert.deepEqual(parsed("start '.pi/plans/x.md'"), {
    kind: "verb",
    verb: "start",
    path: ".pi/plans/x.md",
  });
  assert.deepEqual(parsed("start .pi/plans/a b.md"), {
    kind: "verb",
    verb: "start",
    path: ".pi/plans/a b.md",
  });
  assert.deepEqual(parsed(`start '"quoted".md'`), {
    kind: "verb",
    verb: "start",
    path: '"quoted".md',
    // only ONE pair is stripped
  });
  const empty = failed('start ""');
  assert.match(empty.text, /path is empty/);
  assert.match(empty.text, /Usage: \/orchestrator start \[path\]/);
});

test("parse: inspect and retry take one optional row ref", () => {
  assert.deepEqual(parsed("inspect"), { kind: "verb", verb: "inspect" });
  assert.deepEqual(parsed("inspect 2"), {
    kind: "verb",
    verb: "inspect",
    rowRef: "2",
  });
  assert.deepEqual(parsed("retry"), { kind: "verb", verb: "retry" });
  assert.deepEqual(parsed("retry 3"), {
    kind: "verb",
    verb: "retry",
    rowRef: "3",
  });
  for (const raw of ["inspect 2 3", "retry one two"]) {
    const result = failed(raw);
    assert.match(result.text, /single row ref/);
    assert.match(result.text, /Usage: \/orchestrator/);
  }
});

test("parse: view reports, or accepts exactly the enum", () => {
  assert.deepEqual(parsed("view"), { kind: "verb", verb: "view" });
  for (const view of ["child", "parent", "auto"] as const) {
    assert.deepEqual(parsed(`view ${view}`), { kind: "verb", verb: "view", view });
  }
  assert.deepEqual(parsed("view CHILD"), {
    kind: "verb",
    verb: "view",
    view: "child",
  });
  for (const bad of ["view both", "view Child Parent", "view 1"]) {
    const result = failed(bad);
    assert.match(result.text, /Unknown view/);
    assert.match(result.text, /child\|parent\|auto/);
  }
});

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
  assert.match(empty.text, /Usage: \/orchestrator say <text>/);
});

test("parse: say accepts exactly MAX_SAY_CHARS and refuses one more", () => {
  assert.equal(MAX_SAY_CHARS, 2_000);
  const ok = parsed(`say ${"x".repeat(MAX_SAY_CHARS)}`);
  assert.equal(ok.text?.length, MAX_SAY_CHARS);
  const over = failed(`say ${"x".repeat(MAX_SAY_CHARS + 1)}`);
  assert.match(over.text, /2001 characters/);
  assert.match(over.text, /limit is 2000/);
  assert.match(over.text, /Nothing was delivered/);
});

// ── Parsing: unknown verbs ───────────────────────────────────────────

test("parse: unknown verb suggests the nearest verb", () => {
  const result = failed("stats");
  assert.match(result.text, /Unknown Orchestrator verb "stats"/);
  assert.match(result.text, /Did you mean "status"\?/);
  assert.equal(spec("status").name, "status");
});

test("parse: the removed cancel verb migrates to stop", () => {
  for (const raw of ["cancel", "Cancel", "CANCEL"]) {
    const result = failed(raw);
    assert.match(result.text, /Unknown Orchestrator verb "cancel"/, raw);
    assert.match(result.text, /"cancel" is now "stop"/, raw);
    assert.match(result.text, /Run \/orchestrator stop/, raw);
  }
});

test("parse: unknown verb without a close match offers no guess", () => {
  const result = failed("zzzzzz");
  assert.match(result.text, /Unknown Orchestrator verb "zzzzzz"/);
  assert.doesNotMatch(result.text, /Did you mean/);
  assert.match(result.text, /\/orchestrator help/);
});

test("parse: a row-ref-looking token is not corrected into a verb", () => {
  // A leading digit is not alphabetic, so no verb is suggested.
  const result = failed("2");
  assert.doesNotMatch(result.text, /Did you mean/);
});

// ── Help ─────────────────────────────────────────────────────────────

test("help: every non-help verb appears exactly once with its usage", () => {
  const help = formatOrchestratorHelp();
  for (const entry of ORCHESTRATOR_VERBS) {
    const count = help.split(entry.usage).length - 1;
    assert.equal(count, 1, `${entry.usage} appears ${count} times`);
  }
  for (const group of ORCHESTRATOR_GROUPS) {
    assert.match(help, new RegExp(`^${group.title}$`, "m"));
  }
});

test("help: states the bare entry, the exactness and the cancel migration", () => {
  const help = formatOrchestratorHelp();
  assert.match(help, /Bare \/orchestrator enters Orchestrator mode/);
  assert.match(help, /no aliases/);
  assert.match(help, /`cancel` was removed: use `stop`/);
});

test("help: no hyphenated aliases and no cancel usage line", () => {
  const help = formatOrchestratorHelp();
  for (const alias of [
    "/orchestrator-pause",
    "/orchestrator-resume",
    "/orchestrator-abort",
    "/orchestrator-view",
    "/orchestrator cancel",
    "Aliases:",
  ]) {
    assert.equal(help.includes(alias), false, alias);
  }
});

test("help: one verb prints its usage, summary and guards", () => {
  const help = formatOrchestratorHelp("pause");
  assert.match(help, /^Usage: \/orchestrator pause$/m);
  assert.match(help, /pause the live Build child/i);
  assert.match(help, /Guards: Orchestrator mode required/);
  assert.match(help, /a bound run is required/);
  assert.match(help, /live or paused child/);
  assert.match(help, /Run \/orchestrator help for every verb/);
});

test("help: unknown or blank verb input falls back to the full list", () => {
  assert.equal(formatOrchestratorHelp("nope"), formatOrchestratorHelp());
  assert.equal(formatOrchestratorHelp(undefined), formatOrchestratorHelp());
  assert.equal(formatOrchestratorHelp(42), formatOrchestratorHelp());
});

// ── Completions ──────────────────────────────────────────────────────

const CTX = {
  plans: [".pi/plans/a.md", ".pi/plans/b.md"],
  rows: ["1", "2"],
  currentRef: "2",
};

function labels(items: ReturnType<typeof orchestratorCompletionItems>) {
  assert.ok(items, "expected completion items");
  return items.map((item) => item.label);
}

test("completions: verb position offers every verb, args ones commit a space", () => {
  const items = orchestratorCompletionItems("", CTX);
  assert.ok(items);
  assert.deepEqual(
    items.map((item) => item.label),
    EXPECTED_VERBS,
  );
  const byLabel = new Map(items.map((item) => [item.label, item.value]));
  assert.equal(byLabel.get("status"), "status");
  assert.equal(byLabel.get("start"), "start ");
  assert.equal(byLabel.get("say"), "say ");
  assert.equal(byLabel.get("help"), "help ");
});

test("completions: verb filtering is case-insensitive and prefix-based", () => {
  assert.deepEqual(labels(orchestratorCompletionItems("st")), [
    "start",
    "status",
    "stop",
  ]);
  assert.deepEqual(labels(orchestratorCompletionItems("STA")), [
    "start",
    "status",
  ]);
  assert.equal(orchestratorCompletionItems("zzz"), null);
});

test("completions: an exactly typed verb closes the dropdown", () => {
  for (const name of ["status", "start", "help"]) {
    assert.equal(orchestratorCompletionItems(name, CTX), null, name);
  }
});

test("completions: start offers recent plans with the full-argument value", () => {
  const items = orchestratorCompletionItems("start ", CTX);
  assert.ok(items);
  assert.deepEqual(
    items.map((item) => item.label),
    [".pi/plans/a.md", ".pi/plans/b.md"],
  );
  assert.equal(items[0]?.value, "start .pi/plans/a.md");
  assert.equal(items[0]?.description, "recent plan");
  // Partial path replaces the trailing token, not appends.
  const partial = orchestratorCompletionItems("start .pi/plans/b", CTX);
  assert.equal(partial?.length, 1);
  assert.equal(partial?.[0]?.value, "start .pi/plans/b.md");
  assert.equal(orchestratorCompletionItems("start", CTX), null);
});

test("completions: inspect and retry offer rows plus the current ref once", () => {
  for (const name of ["inspect", "retry"]) {
    const items = orchestratorCompletionItems(`${name} `, CTX);
    assert.ok(items, name);
    assert.deepEqual(items.map((item) => item.label), ["2", "1"]);
    assert.equal(items[0]?.description, "current row");
    assert.equal(items[1]?.description, "run row");
    assert.equal(items[0]?.value, `${name} 2`);
    // An exactly typed ref closes the dropdown (single remaining candidate).
    assert.equal(orchestratorCompletionItems(`${name} 1`, CTX), null);
    const partialCtx = { rows: ["12", "2"], currentRef: "12" };
    assert.deepEqual(labels(orchestratorCompletionItems(`${name} 1`, partialCtx)), ["12"]);
    assert.equal(orchestratorCompletionItems(`${name} 12`, partialCtx), null);
    assert.equal(orchestratorCompletionItems(name, CTX), null, name);
  }
  // No currentRef and no rows: nothing to offer.
  assert.equal(orchestratorCompletionItems("inspect ", {}), null);
});

test("completions: view offers the enum only", () => {
  const items = orchestratorCompletionItems("view ", CTX);
  assert.ok(items);
  assert.deepEqual(items.map((item) => item.label), ["child", "parent", "auto"]);
  assert.equal(items[0]?.value, "view child");
  assert.deepEqual(labels(orchestratorCompletionItems("view p", CTX)), ["parent"]);
  assert.equal(orchestratorCompletionItems("view child", CTX), null);
  assert.equal(orchestratorCompletionItems("view", CTX), null);
});

test("completions: help offers verb names", () => {
  const items = orchestratorCompletionItems("help ", CTX);
  assert.ok(items);
  assert.deepEqual(items.map((item) => item.label), EXPECTED_VERBS);
  assert.equal(items[0]?.value, "help start");
  assert.deepEqual(labels(orchestratorCompletionItems("help pa", CTX)), ["pause"]);
  assert.equal(orchestratorCompletionItems("help help", CTX), null);
});

test("completions: free text and unknown verbs offer nothing", () => {
  for (const raw of ["say ", "say hi", "status ", "stop now", "zzz ", "nope"]) {
    assert.equal(orchestratorCompletionItems(raw, CTX), null, raw);
  }
});

test("completions: non-string input behaves like the verb position", () => {
  assert.deepEqual(
    labels(orchestratorCompletionItems(undefined, CTX)),
    EXPECTED_VERBS,
  );
  assert.deepEqual(labels(orchestratorCompletionItems(null, CTX)), EXPECTED_VERBS);
});

test("completions: a prefix with no matching plan returns null", () => {
  assert.equal(orchestratorCompletionItems("start zzz", CTX), null);
});
