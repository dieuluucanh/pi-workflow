# Migrating a plan after the legacy-engine deletion

> **Breaking change (2026-11-24, 0.14.0 development milestone; shipped in
> 0.17.5).** The frozen plan contract, the
> compiler/lint/check-preview, the freeze gate, the run journal and the Build
> execution engine are gone. Plans and runs from before the sweep are not
> migrated: restore says "restart from the approved plan".

## Plans

Nothing has to be edited. A plan is a normal markdown document:

- `# Plan:`, `## Context`, `## Steps` (or `## Plan Steps`) and an optional
  `## Verification` list are enough;
- `Acceptance:`, `Checks:`, `Files:`, `Workspaces:` and typed gate/diagnostic/
  manual metadata are now ordinary prose;
- a plan with indented headings, no verification section or prose-only
  verification is approved normally;
- `## Verification` commands are run by the model as ordinary bash, not by a
  check executor;
- a plan filename may be the legacy date-only
  `.pi/plans/<date>-<slug>.md` or the current date-time
  `.pi/plans/<date>-<HHmm>-<slug>.md` (UTC). Existing plans are never renamed,
  so **no migration is required** — new plans just carry the time.

If you kept plans that relied on the compiler's section exclusion, the only
thing to check is that the human steps are under `## Steps`/`## Plan Steps`.
Everything else is ignored rather than validated.

## Runs

- A `running` run record restores as `interrupted` after a reload. `/orchestrator
  retry` starts a fresh child from the stored row instruction. Idle runs between
  rows retain their report; explicit dispatch can continue them. Completed or
  cancelled runs cannot be revived: use a new `orchestrator_start`.
- Old journals, frozen v1/v2 snapshots and run directories are left on disk and
  never read. Start a new run from the approved plan.
- The shell quarantine survives a reload through the `workflow` entry's
  `shellQuarantine` key. A genuine new idle user prompt or explicit
  `/shell-guard reset` can start a new budget; a reload or child replacement
  cannot.

## Tool and command surface

Removed: `workflow_execution`, `/orchestrator-repair-checks`, the
`workflow-execution` footer segment, `plan_validate`, `/plan lint`,
`/workflow lint`, and the chunked `review_plan_begin`/`chunk`/`finalize` write
path. The five parent tools are `orchestrator_start`, `orchestrator_dispatch`,
`orchestrator_status`, `orchestrator_retry` and `orchestrator_abort`.
