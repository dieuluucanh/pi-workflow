# Repair + retry handoff: malformed frozen plan checks (2026-11-24)

Audit time: 2026-11-24T06:25:35Z. This note is the step-7 output of
`.pi/plans/2026-11-24-plan-execution-contract-refactor.md` (Phase A).

**Status: run paused, six checks repaired, 14/15 rows accepted. Task 15 is not
complete and is not claimed complete — the user runs `/orchestrator retry` in
the ERP session, and only the runtime may report 15/15.**

## Target run

| Field | Value |
| --- | --- |
| Run | `run-2026-11-21-misa-audit-de-4f5693849d93` |
| Run directory | `~/.pi/agent/orchestrator/runs/run-2026-11-21-misa-audit-de-4f5693849d93` |
| Plan | `C:/Users/Lenovo/Projects/erp-atom/.pi/plans/2026-11-21-misa-audit-dev-recovery.md` |
| Plan digest | `4f5693849d9309f681b7fa6a3bf59f8aa63c09c32ee2340daf0ddfd676b3b069` |
| Workspace root | `W=C:\Users\Lenovo\Projects\erp-atom` (primary) |
| Phase | `paused` |
| Seq before / after | `75` / `76` |
| Accepted | `14/15` (unchanged by the amendment) |
| Task 15 | `blocked`, `repairRounds 3`, text `**Reconcile documentation, remaining backlog and readiness verdict.**` |

## What was malformed

The frozen `todos.frozen` payload (journal seq 2) carried five `planChecks`
that were Markdown prose bullets, not commands. All five still validate as
`BAD` (each contains Markdown backticks):

1. ``pnpm dev:preflight`, followed by controlled `npm run dev` smoke on the repaired local demo.``
2. ``pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test`, golden comparisons at the repository's exact tolerance.``
3. ``pnpm check` (the existing 19-gate chain), plus `check:docs-reference`, `check:docs-glossary` and focused generated-snapshot checks where applicable.``
4. ``pnpm db:test:invariants`, `pnpm db:test:ledger-tamper`, `pnpm db:verify-ledger` and migration/backfill/restore rehearsal on disposable databases only. Record fresh-install and upgrade results separately.``
5. ``pnpm docs:build` and `pnpm check:release` as diagnostics: report pending release/human gates honestly, not as conditions that can be fabricated or bypassed.``

## The amendment (append-only, one event)

| Field | Value |
| --- | --- |
| Event | `run.control` at seq `76` |
| Action / version | `plan-check-specs-repair` / `1` |
| Event id | `repair-f8765001a91050726d3ba9d295723c40` |
| Manifest artifact | `artifacts/3c35aa190ac370bbe3a31beb6a41424d7ab1022102238a467d3a052f773f9a61` |
| Manifest sha256 | `3c35aa190ac370bbe3a31beb6a41424d7ab1022102238a467d3a052f773f9a61` |
| Reason | frozen checks were prose bullets mis-read as commands; replace with the six approved gates |
| Source | plan `2026-11-24-plan-execution-contract-refactor` step 7; user-approved six static gates |

Repaired checks (all `kind: gate`, explicit workspace `W`, no per-check
timeout):

```text
pnpm typecheck
pnpm lint
pnpm format:check
pnpm check:docs-reference
pnpm check:docs-glossary
pnpm check
```

No row, row id, row status, workspace, `executionId` or `revision` moved. The
amendment touched only `todos.planChecks` / `todos.planCheckSpecs`; the journal
kept its v1 framing and checksum algorithm.

## Script-name confirmation (mandatory pre-check)

All six script names exist in `C:/Users/Lenovo/Projects/erp-atom/package.json`
`scripts` (82 scripts total) — a shape-valid but nonexistent script would
reproduce the incident with a different error:

| Script | Value (truncated) |
| --- | --- |
| `typecheck` | `tsc -p tsconfig.scripts.json --noEmit && turbo run typecheck` |
| `lint` | `eslint . && turbo run lint` |
| `format:check` | `prettier --check .` |
| `check:docs-reference` | `node scripts/generate-docs-reference.mjs --check` |
| `check:docs-glossary` | `node scripts/generate-docs-glossary.mjs --check` |
| `check` | `pnpm check:manifests && … && pnpm check:docs-site` (19-gate chain) |

## Rehearsal (copy first, then real)

1. Copied `journal.ndjson` (45,073 B, sha256 `888b2709…ba65f`) and
   `snapshot.json` (166 B, sha256 `bafd51f1…026c1`) to
   `%TEMP%\pi-repair-rehearsal-4f5693849d93` — byte-identical to the originals.
2. `--status` on the copy: seq 75, `paused`, 14/15 accepted, five `BAD` checks,
   task 15 `blocked` (repairRounds 3).
3. `--dry-run` on the copy: six proposed gates, validation `ok — 6 gate, 0
   diagnostic, 0 manual`, no write.
4. `--apply --yes` on the copy: seq 75 → 76, checksum chain ok, `snapshot.json`
   ok at seq 76, specs match on reload, 14 accepted preserved, task 15
   `blocked` unchanged (`verification.ok = true`).
5. Second `--apply --yes` on the copy: `result: no-op`, no second event, seq
   still 76 (journal 76 lines).
6. Independent replay of the copy: 76 lines, `replayJournal` ok, `truncated: 0`,
   accepted set = task-1…task-14, last line `run.control` seq 76, snapshot
   checksum valid and `seq == journal seq`.
7. Real run: `--apply --yes --expect-seq 75 --expect-accepted 14` → seq 76,
   `repair-f8765001a91050726d3ba9d295723c40`, same six specs, same
   verification result. Re-read `--status` immediately before the apply (seq 75,
   14/15) so a changed run could not be amended blindly.

Note on repeat applies: the payload id hashes `approvedAt`, so a repeat
computes a different id (`repair-75cf3c24…` vs `repair-f8765…` across the copy
and the real run). Idempotency is enforced by comparing the applied view
before the `previous` check (`applyCheckSpecRepair`), so a repeat is a safe
no-op and appends nothing. Do not "fix" this by editing the journal.

## Six gates actually run on the ERP tree

Run in `C:/Users/Lenovo/Projects/erp-atom` at `HEAD 0488332` (163 dirty entries
already present in that worktree before this step; no ERP file was edited).

| Gate | Exit | Evidence |
| --- | --- | --- |
| `pnpm typecheck` | 0 | `91 successful, 91 total`, 44.55s |
| `pnpm lint` | 0 | `49 successful, 49 total`, 7.9s |
| `pnpm format:check` | 0 | "All matched files use Prettier code style!" |
| `pnpm check:docs-reference` | 0 | `docs:reference ok — 7 pages current` |
| `pnpm check:docs-glossary` | 0 | `ok glossary — 52 terms` |
| `pnpm check` | 0 | 19 gates, latest `check:docs-site ok — 351 pages … 0 orphans` |

## Retry handoff (user action)

In the ERP session (`C:/Users/Lenovo/Projects/erp-atom`):

```text
/reload            # the workflow extension changed in this worktree
/orchestrator retry
```

- Expected command path: the row-15 retry re-runs the repaired final gate
  (`pnpm typecheck`, `lint`, `format:check`, `check:docs-reference`,
  `check:docs-glossary`, `check`) in the `W` root, then accepts row 15.
- Expected outcome: 15/15 accepted **if and only if** the runtime accepts row
  15 after the retry. 15/15 is the user's post-plan acceptance; this note does
  not claim it.
- If the retry refuses or a gate fails: stop and report the exact gate output.
  Do not drop a gate, hand-edit the journal or bump `revision` to force a pass.
- If a reload is not possible, the in-session command is
  `/orchestrator-repair-checks --status` (same payload path); the standalone
  script is
  `node --experimental-transform-types C:/Users/Lenovo/.pi/agent/extensions/workflow/scripts/repair-orchestrator-checks.mjs --run-dir <run dir> --status`.

## Explicitly not run / not claimed

- Full ERP `pnpm test`, Playwright, provider sandbox, benchmark, N−1 seeded
  upgrade, `pnpm dev:preflight` + `npm run dev` smoke, `pnpm db:test:*`,
  `pnpm docs:build`, `pnpm check:release`, VPS drill — unrun/manual; do not
  report them as green.
- Harness `npm test`/`check:policy`/`check:read-policy`/pack gate for this row
  were owned by earlier rows; this row adds no extension source change.
- No commit, no publish, no journal rewrite, no `snapshot.json` hand edit.
