# Migrating a plan after the legacy-engine deletion

> **Breaking change (2026-11-24, v0.14.0).** The frozen plan contract, the
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
  check executor.

If you kept plans that relied on the compiler's section exclusion, the only
thing to check is that the human steps are under `## Steps`/`## Plan Steps`.
Everything else is ignored rather than validated.

## Runs

- A `running` run record restores as `interrupted` after a reload. `/orchestrator
  retry` starts a fresh child from the stored row instruction.
- Old journals, frozen v1/v2 snapshots and run directories are left on disk and
  never read. Start a new run from the approved plan.
- The shell quarantine survives a reload through the `workflow` entry's
  `shellQuarantine` key; `/shell-guard reset` is still the only new budget.

## Tool and command surface

Removed: `workflow_execution`, `/orchestrator-repair-checks`, the
`workflow-execution` footer segment, `plan_validate`, `/plan lint`,
`/workflow lint`, and the chunked `review_plan_begin`/`chunk`/`finalize` write
path. The four parent tools are `orchestrator_start`, `orchestrator_dispatch`,
`orchestrator_status` and `orchestrator_retry`.
