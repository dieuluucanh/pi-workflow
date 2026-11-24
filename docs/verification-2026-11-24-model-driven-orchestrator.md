> **Superseded (2026-11-24).** This document describes the removed frozen /
> journaled Orchestrator engine and Build execution engine. It is retained as
> historical evidence, not current behaviour. Current flow: the model-driven
> dispatcher in `agent/extensions/workflow/README.md` (model-supplied rows, one
> in-process child per row, verification as ordinary bash).

# Verification — model-driven Orchestrator (2026-11-24)

Branch: `feature/orchestrator-mode` (changes uncommitted).
Scope: `agent/extensions/workflow`.

## Automated gates

| Gate | Result |
|---|---|
| `npm run typecheck` | clean |
| `npm test` | 1670 passed / 0 failed |
| `npm run check:policy` | 100/100 checks passed |
| `npm run check:read-policy` | all read/folder policy checks passed |
| `npm run prepublishOnly` | 1/1 package passed (109 files packed) |

Focused smoke suites:

| Suite | Result |
|---|---|
| `orchestrator-run.test.ts` | pass — steps → stable rows, dispatch/report round-trip, corrupt record ignored |
| `review-append-only.test.ts` | pass — appends `## Reviewer Revisions`, preserves the body, no replacement-body parameter |
| `orchestrator-tools.test.ts` / `orchestrator-tool-runtime.test.ts` | pass — start/dispatch/status/retry surface |
| `todo-service.test.ts` | pass — a freeze call installs mutable rows; no frozen state |
| `permissions.test.ts` | pass — orchestrator has builder authority |

## What the automated checks prove

- The Orchestrator permission identity is `commandClass: "full"`, `canWrite: true`;
  the mode keeps `edit`/`write` and no longer refuses bash/powershell.
- Approval no longer compiles or freezes a plan; an indented heading or a
  differently numbered list cannot be refused by the removed compiler.
- The reviewer appends one section and has no tool parameter for a replacement
  body.
- A run record survives JSON/session round-tripping; a child report is stored
  without a workspace-diff gate, and the parent decides completion through the
  TODO list.
- The TODO list is mutable in an Orchestrator session.

## Manual smoke still recommended

The live TUI/host path is not driven by the automated suite:

1. Plan → Review → Direct Build: one appended `## Reviewer Revisions` section and
   an untouched plan body.
2. Plan → Orchestrator with a two-step plan: dispatch row 1, receive the child
   report, mark the row done, dispatch row 2, complete.
3. A blocker report: inspect, amend the instruction, re-dispatch the same row.
4. `/reload` during a run: record restored, lost child marked interrupted,
   re-dispatch works.
5. A deliberately indented plan: approval succeeds (the compiler is gone).

## Coverage note

`extension.test.ts` (the old frozen-engine integration suite) and
`review.test.ts` (the old rewrite/chunk suite) were removed from the test list
and the worktree because they asserted the removed behavior. The focused suites
above replace the parts that still apply. The live smoke checklist is the
remaining coverage for the host/UI path.
