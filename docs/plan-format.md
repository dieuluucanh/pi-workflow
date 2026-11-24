# Plan format

> **Current (2026-11-24).** A plan is a normal markdown document. There is no
> schema, no compiler, no lint, no freeze gate and no executable-check block.
> The model reads the plan, creates TODO rows with `workflow_todo`, and runs the
> `## Verification` commands as ordinary bash.

## Where a plan lives

`.pi/plans/<UTC-date>-<slug>.md`, where `<date>` is `YYYY-MM-DD` (UTC) and
`<slug>` is kebab-case, at most 40 characters (for example
`.pi/plans/2026-11-24-export-endpoint.md`).

## Canonical headings

```markdown
# Plan: Add the export endpoint

## Context

Why this change is needed and what it touches.

## Steps

1. Add the route and its handler.
2. Cover the happy path and the validation error.

## Verification

- `npm run typecheck`
- `npm test`
```

Only `## Steps` (or `## Plan Steps`) is the human plan. `## Verification` is a
plain list of commands the model runs before the last row is marked done. The
model may also add `## Decisions`, `## Risks` or any other section it finds
useful; nothing parses or validates them.

## What changed

The former contract — `Acceptance:`, `Checks:`, `Files:`, `Workspaces:`,
typed gate/diagnostic/manual checks, a compiled check preview and a freeze at
approval — was removed. Old plans still read fine: those sections are prose.
A plan with indented headings, no `## Verification`, or prose-only verification
is approved and executed like any other plan.

## How rows and verification work

- The model supplies one step per TODO row to `orchestrator_start` (or creates
  the rows directly in Build).
- A row targets one repository root. Cross-repo work is multiple rows.
- The model runs the plan's `## Verification` as ordinary bash before the last
  row is done and states exactly what it ran. The real command and its output
  are visible; there is no hidden gate.
- Reload does not resume a run. Restart from the approved plan.

See [`plan-template.md`](plan-template.md) for a skeleton and
[`plan-migration.md`](plan-migration.md) for the breaking-change note.
