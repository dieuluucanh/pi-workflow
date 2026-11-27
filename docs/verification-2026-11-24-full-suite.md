# Full verification — test suite + write/read policy gates (workflow extension)

> Recorded by orchestrator row 9 of a standalone run (task-9).
> Purpose: record the exact results of the full gate (not just exit codes), plus
> the two grep audits the row requires, so the parent can verify without the
> original chat log.

## Scope

Run from the package directory so `tsconfig.json` and `node_modules` resolve:

```bash
cd C:/Users/Lenovo/.pi/agent/extensions/workflow
```

Environment: Node `v24.22.2`, npm `11.19.1`, `@dieulc/workflow@0.13.0`.

## Command 1 — full suite (`npm test`, 109 test files)

```bash
npm test
```

Summary block (verbatim):

```
ℹ tests 2027
ℹ suites 0
ℹ pass 2027
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 37217.575
```

- exit status: **0**
- `✔` lines in the log: **2027** (matches `pass 2027`)
- `not ok` / failure lines: **0**
- no unhandled rejections; no unexpected stderr warnings
- last executed test: `✔ the orchestrator segment is always exactly one line`
- the run includes the new `notify-scope.test.ts` (present in the npm test list)

## Command 2 — write-policy gate (`npm run check:policy`)

```bash
npm run check:policy
```

```
PASS  1a ask mode prompts on an edit
...
PASS  13d a granted path no longer prompts

100/100 checks passed
```

- exit status: **0**
- `PASS` lines: **100**, `FAIL` lines: **0**
- covered families: prompt/allow-once/deny, instruction delivery, once-per-turn
  batching, persists-per-path, run settlement reset.
- stderr: one `ExperimentalWarning: Transform Types` (expected for
  `--experimental-transform-types`, not an error).

## Command 3 — read/folder-policy gate (`npm run check:read-policy`)

```bash
npm run check:read-policy
```

```
PASS  sensitive: credentials.json is blocked
...
PASS  msys: /tmpfoo is not /tmp

All read/folder policy checks passed.
```

- exit status: **0**
- `PASS` lines: **30**, `FAIL` lines: **0**
- covered families: sensitive-output redaction, folder in/out decisions, broad
  root refusal (filesystem root, home, AppData umbrella), exclude rules,
  grant override, MSYS `/tmp` mapping.
- stderr: same expected `ExperimentalWarning`.

## Audit 1 — `notifyReview` ownership (21 lines incl. definition)

```bash
grep -n "notifyReview" index.ts | grep -vE "^[0-9]+: *(\*|//)"
```

Result: **21** non-comment lines in `index.ts`, made up of:

- **1** definition — `index.ts:3225  function notifyReview(`
- **20** review-owned call sites (3501, 3504, 3506, 3610, 3674, 3990, 3998,
  4062, 4204, 4332, 6712, 6837, 15475, 18927, 20024, 20060, 20070, 22183,
  22223, 22492)

The remaining `notifyReview` mentions are prose only: `index.ts:3240`/`3243`
doc comments and `review.ts:1181`, plus `notify-scope.test.ts` (its audited set
is "20 review-owned calls + 1 definition"). Cross-check from the test suite:

- `notify-scope.test.ts` — `notifyReview: one definition plus twenty
  review-owned call sites` passes, and `notifyReview: no non-reviewer notice is
  routed through it` passes.

## Audit 2 — orchestrator pause-reminder state is gone

```bash
grep -rn "lastOrchestratorPauseReminderAt\|PauseReminder\|pauseReminder" \
  --include="*.ts" . | grep -v node_modules
grep -rniE "reminder row|rate-limited reminder" \
  --include="*.ts" index.ts orchestrator-*.ts tab-editor.ts workflow-status.ts
```

- removed state identifiers: **0** matches (the deleted
  `lastOrchestratorPauseReminderAt` throttle and its 2s guard no longer exist
  anywhere, including tests)
- "reminder row" / "rate-limited reminder" wording: **0** matches
- git diff confirms the removal: `- let lastOrchestratorPauseReminderAt = 0;`,
  `- if (at - lastOrchestratorPauseReminderAt < 2_000) return;`,
  `- lastOrchestratorPauseReminderAt = 0;` with no additions of the identifier.

What deliberately remains is the unrelated **todo** reminder cadence
(`turnsSinceLastReminder`, `shouldRemind`, `TURNS_BETWEEN_REMINDERS` in
`utils.ts`/`index.ts`), which is a Plan/Build todo-writing nudge and not
orchestrator pause state.

## Result

All three commands are green (2027/2027 tests, 100/100 write-policy checks,
30/30 read-policy checks), and both grep audits match the expected shape:
21 `notifyReview` lines including exactly one definition and 20 review-owned
calls; zero pause-reminder state.

## How to re-verify

```bash
cd C:/Users/Lenovo/.pi/agent/extensions/workflow \
  && npm test \
  && npm run check:policy \
  && npm run check:read-policy

cd C:/Users/Lenovo/.pi/agent/extensions/workflow \
  && grep -n "notifyReview" index.ts | grep -vE "^[0-9]+: *(\*|//)" | wc -l   # 21
  && grep -rn "lastOrchestratorPauseReminderAt\|PauseReminder\|pauseReminder" \
       --include="*.ts" . | grep -v node_modules | wc -l                      # 0
```

## Notes

- Durations vary by machine; counts and exit statuses are the stable signal.
- Policy gates are standalone `node` scripts, so they do not depend on the test
  runner's discovery list.
- `npm run typecheck` is not part of this row; it is covered separately by the
  focused-suite verification document.
