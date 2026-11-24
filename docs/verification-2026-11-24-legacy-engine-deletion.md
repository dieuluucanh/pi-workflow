# Verification — legacy engine deletion (2026-11-24, v0.14.0)

Baseline: `81a70c6` (tag `pre-legacy-engine-deletion`). Scope:
`agent/extensions/workflow`. The sweep removes the frozen/journaled Orchestrator
engine and the Build execution engine, and finishes the model-driven run record.

## Gates

| Gate | Result |
| --- | --- |
| `npm run typecheck` | pass (clean after every step) |
| `npm test` | pass — see the run recorded below |
| `node --test no-legacy-engine.test.ts` | pass |
| `npm run check:policy` | pass (100/100) |
| `npm run check:read-policy` | pass |
| `npm run prepublishOnly` | pass (pack + import closure) |

Full-suite count at the final run: **1415 passed / 0 failed** (1670 at the
baseline; 255 old-engine tests were deleted and the new regressions added).

## Removed surface (audited)

The repository-wide grep for the deleted module names returns no import, and
the production grep for `workflow_execution`, `orchestrator-repair-checks`,
`workflow-execution`, `planContract`, `todos.frozen`, `todos.freeze(` and
`executionState` is empty. `no-legacy-engine.test.ts` pins all of it, plus the
command/tool set against `fixtures/compat-baseline.json`.

## Regressions

- (a) multi-repo: `orchestrator-workspace-set.test.ts` (two roots, per-row cwd,
  unknown/broad refusal).
- (b) reload: `sweep-regressions.test.ts` — a `running` record restores as
  `interrupted` and retry dispatches the stored instruction.
- (c) no auto-accept: `sweep-regressions.test.ts` — a child report does not
  complete a row; only `workflow_todo` does.
- (d) parent exclusion: `parent-exclusion.test.ts`.
- (e) approve → build: `sweep-regressions.test.ts` — one plain kickoff, no
  freeze API, rows stay mutable.
- (f) append-only review: `review-append-only.test.ts`.

## Manual smoke

Run from a real terminal against the packed artifact. Status at the time of
writing: **not run** (this sweep was executed in Direct Build, without
`/reload`, as required by the plan).

1. Plan → Review (one appended section, body untouched) → Direct Build (one
   kickoff, TODO list created, plan not edited) — **not run**.
2. Plan → Orchestrator with a two-repo plan: row 1 dispatches into repo A,
   report wakes the parent, row 2 into repo B — **not run**.
3. Blocker report: row stays in progress; amended instruction re-dispatches —
   **not run**.
4. `/reload` during a row: record restored as `interrupted`; retry works —
   **not run**.
5. `/orchestrator status|pause|resume|abort|say|view|inspect` on the run
   record — **not run**.
6. A parent `write` while a child runs is refused; after settle it is allowed —
   covered by `parent-exclusion.test.ts`; live terminal **not run**.
7. Build completion card appears on all-done TODOs with no final-gate run —
   **not run**.

## Commit

The sweep is left uncommitted for review (the session's commit policy is
`never`). Working tree: the extension source, tests, fixtures and docs listed
in the plan's steps assume no unrelated changes.
