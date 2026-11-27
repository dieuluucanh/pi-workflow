> **Superseded (2026-11-24).** This document describes the removed frozen /
> journaled Orchestrator engine and Build execution engine. It is retained as
> historical evidence, not current behaviour. Current flow: the model-driven
> dispatcher in `agent/extensions/workflow/README.md` (model-supplied rows, one
> in-process child per row, verification as ordinary bash).

# Rollout: plan-execution contract refactor (2026-11-24)

This note is the step-19 output of
`.pi/plans/2026-11-24-plan-execution-contract-refactor.md`: the read-only
migration inventory, the dual-read verification, and the honest gate record.
It does not claim completion of the ERP task, a publish, or a commit.

## What landed

- `agent/extensions/workflow/migration-scan.ts` — pure, read-only scanner.
  Per run: journal replay, in-memory application of
  `plan-check-specs-repair` amendments, stored snapshot version and the version
  the reader upcast from, quarantined checks with their exact bytes, checks
  bound to an unbound workspace alias, prose `acceptanceChecks` as criteria,
  stale `snapshot.json`, and a repair list. Per plan: the same compiler/linter
  as the freeze path (rows, gate/diagnostic/manual counts, row checks,
  line-numbered errors, zero-gate acknowledgement).
- `agent/extensions/workflow/scripts/migration-report.mjs` — the filesystem
  walk (`--runs-dir`, `--plans-dir`, `--plan`, `--json`, `--strict`). It opens
  files read-only and appends no event.
- `agent/extensions/workflow/migration-scan.test.ts` and package wiring
  (`files` + `test` script). The published package packs it (see the pack gate
  below).

## Migration inventory (read-only)

Command:

```bash
node --experimental-transform-types \
  agent/extensions/workflow/scripts/migration-report.mjs \
  --runs-dir agent/orchestrator/runs --plans-dir .pi/plans
```

Observed on the live machine:

| Item | Result |
| --- | --- |
| Runs scanned | 6 |
| Runs on v1 snapshots | 4 |
| Runs already amended | 1 (`run-2026-11-21-misa-audit-de-4f5693849d93`) |
| Runs unreadable as executable | 2 older runs with no `todos.frozen` event (journals replay; they are not corrupted) |
| Quarantined checks remaining | 0 |
| Unbound workspace aliases | 0 |
| Plans scanned | 134 |
| Plans that no longer compile | 75 (legacy prose bullets; a real, expected migration backlog, not a run defect) |

The scan wrote nothing: SHA-256 of every `journal.ndjson` and `snapshot.json`
under the runs root was identical before and after.

## Live run: repaired, v1 on disk, 14/15

`run-2026-11-21-misa-audit-de-4f5693849d93`:

- phase `paused`, seq `76`, plan digest
  `4f5693849d9309f681b7fa6a3bf59f8aa63c09c32ee2340daf0ddfd676b3b069`;
- accepted `14/15`; task 15 `blocked` with `repairRounds 3`;
- six valid final checks (`typecheck`, `lint`, `format:check`,
  `check:docs-reference`, `check:docs-glossary`, `check`);
- snapshot stored as v1 and **not** migrated to v2 on disk; the reader upcasts
  it in memory.

`scripts/repair-orchestrator-checks.mjs --status` reports the same state
(hash-verified unchanged). Only the ERP runtime may report `15/15` after the
user's `/orchestrator retry`.

## Dual-read / write-v2

- Read: `readFrozenSnapshot` accepts v1 (in-memory upcast) and v2, quarantines
  malformed v1 checks and fails closed on unknown future versions
  (`frozen-snapshot.test.ts`, `plan-contract-upcast.test.ts`).
- Write: a new freeze builds `FrozenExecutionSnapshot` with
  `schemaVersion: 2` (`plan-contract-golden.test.ts` asserts it; the freeze path
  in `todo-snapshot.ts` writes the `execution` artifact).
- The existing v1 journals keep their line framing, checksum and `prev` chain;
  no journal was rewritten.

## Gates run (fresh evidence)

Harness (`agent/extensions/workflow`):

| Gate | Result |
| --- | --- |
| `npm test` | 2005 tests, 2005 pass, 0 fail |
| `npm run typecheck` | clean |
| `npm run check:policy` | 100/100 checks passed |
| `npm run check:read-policy` | all read/folder policy checks passed |
| `npm run prepublishOnly` (pack gate) | 1/1 package, 111 files packed (includes `migration-scan.ts`) |

ERP (`C:/Users/Lenovo/Projects/erp-atom`, the six static gates):

| Gate | Result |
| --- | --- |
| `pnpm format:check` | all files match Prettier |
| `pnpm check:docs-reference` | 7 pages current |
| `pnpm check:docs-glossary` | 52 terms |
| `pnpm typecheck` | 91/91 tasks |
| `pnpm lint` | 49/49 tasks |
| `pnpm check` | exit 0, 20 sub-gates (i18n, control plane, human readiness, pilot evidence, docs, docs-i18n, docs-coverage, docs-site, …) |

## Explicitly not claimed / not run

These remain manual or out of scope for this row and must not be reported green:

- ERP full `pnpm test` suite, Playwright, provider sandbox, benchmark,
  N−1 seeded upgrade, `pnpm docs:build`, `pnpm check:release` (release
  diagnostics).
- Publishing the workflow package and committing the harness worktree.
- ERP task 15 acceptance: the run is paused at 14/15; the user runs
  `/orchestrator retry`, and only the runtime may report 15/15.
- The two older runs without `todos.frozen` are reported as not executable by
  the scanner; they were not retrofitted, re-frozen or deleted.
- The 75 legacy plans that no longer compile were inventoried, not rewritten;
  each gets `/plan lint` before it is next approved.

## Operator next steps from the repair list

1. Re-run the report with `--strict` in CI if a non-empty repair list should
   fail a gate; it currently exits 0 unless `--strict` is passed.
2. Repair a malformed run only through the append-only amendment
   (`/orchestrator-repair-checks` or `scripts/repair-orchestrator-checks.mjs`).
3. Migrate an old plan through `docs/plan-migration.md`; do not re-freeze an
   existing run to pick up changed plan text.
