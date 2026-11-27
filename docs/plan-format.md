# Plan format

> **Current (2026-11-24).** A plan is a normal markdown document. There is no
> schema, no compiler, no lint, no freeze gate and no executable-check block.
> The model reads the plan, creates TODO rows with `workflow_todo`, and runs the
> `## Verification` commands as ordinary bash.

## Where a plan lives

`.pi/plans/<UTC-date>-<UTC-time>-<slug>.md`, where `<date>` is `YYYY-MM-DD`
(UTC), `<time>` is `HHmm` (UTC, minute resolution) and `<slug>` is kebab-case,
at most 40 characters (for example
`.pi/plans/2026-11-24-2130-export-endpoint.md`).

The time prefix gives same-day plans their creation order: a plain sort of the
directory lists them chronologically. Two plans with the same slug in the same
UTC minute map to the same file — the filename identifies a plan, not an
event, so distinct plans need distinct slugs.

**Existing files are never renamed.** A plan written before this convention —
`.pi/plans/<UTC-date>-<slug>.md` (for example
`.pi/plans/2026-11-20-export-endpoint.md`) — keeps that name forever, because
review entries, handoffs and links point at it. The rule is:

- an **existing** plan file → its path is left exactly as supplied;
- a **new** file → the extension fills or corrects the prefix
  (`utils.ts: getUtcPlanStamp` / `normalizePlanPath`). A same-day date-time
  prefix keeps its start time, a stale date-time or legacy date-only prefix is
  replaced, and an undated name is prefixed.

One ambiguity is accepted: a legacy slug that begins with four digits
(`2026-11-20-1234-fix.md`) is indistinguishable from a date-time name. It can
only affect a **new** path, and an existing file is never touched.

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

## Reviewer appendix and the Planner loop

When Review Mode is on, the finished plan is audited by an independent
reviewer. That review does not produce a second plan: it appends one
`## Reviewer Revisions (round N)` section at the end of the same file. The file
therefore has two owners:

- **the Planner owns the body** — everything above the appendix, including
  `## Steps` and `## Verification`;
- **the Reviewer owns the appendix** — the findings changelog and the
  `### Required changes` list (`- **R2 · Step 3:** …`), with stable `R<n>` ids
  normalised to submission order.

Neither side writes the other's half. The reviewer has no tool that edits the
body, and a Planner revision turn that touches the appendix is refused.

### The loop

1. The Planner writes the body.
2. The reviewer appends `## Reviewer Revisions (round N)`.
3. If the appendix leaves required changes open and the `maxRevisions` budget
   (`0`–`5`, default `3`; `0` = one-shot) is not spent, the Planner gets one
   revision turn: it edits the body and records a disposition per note id
   through `plan_revision_done`:
   - `applied` — the body edit addressing that note is already saved; a
     claimed `applied` with an unchanged body is refused;
   - `rejected` — the note is declined, with a concrete reason (the evidence
     or requirement that makes it unnecessary);
   - `not_applicable` — the note does not describe this plan, with a reason.
   Every current note id needs exactly one disposition; unknown, duplicate or
   missing ids are refused.
4. The reviewer re-reviews the revised body with those dispositions, so a
   rejected note has to survive the Planner's reason instead of being repeated.
5. Repeat until the reviewer approves or the budget is spent, then hand off.

When the budget is spent with notes still open the loop stops without
converging: the handoff says so, **Approve** accepts the plan as written and
**Give feedback** continues the argument. The loop covers the automatic
post-Plan review and `/review` in Plan mode; `/review` outside Plan mode stays
a one-shot review.

### What downstream reads

The approved plan body wins on any conflict with the appendix. Rows are the
model's call — one plan step per row supplied to `orchestrator_start` (or
created directly in Build) — and the Orchestrator and direct Build consume only
the plan's `## Steps`:

- the appendix is never parsed into rows, notes or requirements;
- no step/row count is computed from the file, so a long plan cannot trigger a
  false step-count warning;
- no note is bound to a row or a child, there is no child
  `## Review notes (advisory)` block and no mission section for unplaced notes.

The revision argument happens in Plan, before approval. If a plan still needs a
step change after approval, it goes back to Plan through the handoff's Feedback
path — never into a running child as a note.

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
