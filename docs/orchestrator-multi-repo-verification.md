> **Superseded (2026-11-24).** This document describes the removed frozen /
> journaled Orchestrator engine and Build execution engine. It is retained as
> historical evidence, not current behaviour. Current flow: the model-driven
> dispatcher in `agent/extensions/workflow/README.md` (model-supplied rows, one
> in-process child per row, verification as ordinary bash).

# Orchestrator multi-repo workspace verification

Date: 2026-11-23
Execution: build-09c6a4d22b6bbb72
Plan: `.pi/plans/2026-11-23-orchestrator-multi-repo-workspaces.md`

## Automated evidence

| Gate | Result |
| --- | --- |
| workflow typecheck | PASS |
| workflow full test suite | PASS (1286/1286) |
| workflow check:policy | PASS (100/100) |
| workflow check:read-policy | PASS |
| root npm test | PASS (80/80) |
| `npm run verify -- --packages workflow` | PASS (73 files packed) |
| `git diff --check` | checked after the final doc fix |

Focused multi-root evidence: `orchestrator-workspace-set.test.ts`,
`orchestrator-adapters.test.ts`, `orchestrator-child-contract.test.ts`,
`orchestrator-mission.test.ts`, `todo-snapshot.test.ts`, and
`orchestrator-advance.test.ts`.

## Manual / live evidence

| Case | Status |
| --- | --- |
| Real provider + real two-repo plan; D-only child launch and acceptance | NOT RUN — no real provider/child session was used in this execution |
| Dual W+D live row | NOT RUN |
| Reload mid-run with live roots | NOT RUN (covered by runtime/advance unit paths) |
| Missing D root during live retry | NOT RUN (covered by capture/advance unit paths) |

The mechanical multi-root path (declarations, per-root baselines/diffs,
attribution, child cwd, row/final checks, and status) is covered by automated
tests. No commit, tag, push, or publish was performed; the working tree remains
uncommitted for review.
