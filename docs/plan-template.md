# Plan: <title>

Date: <YYYY-MM-DD> · Scope: `<primary path or area>`

One sentence on what this plan changes and why. Keep executable detail in the
metadata lines and the `## Verification` section, never in prose that looks like
a command.

## Context

- Current behaviour, the anchor files/symbols verified during recon, and the
  defect or gap being fixed.
- Constraints that decide the shape of the work (compatibility, settings,
  compatibility with existing runs).
- For a live incident: the exact observed error, the journal/run id and the
  evidence that was re-read — not a guess.

## Decisions

1. **Decision.** What is chosen, and the alternative it replaces.
2. **Decision.** The invariant that must hold after the change.
3. **No unrelated worktree changes.** List what must not be touched.

## Exploration Summary

- Verified anchors: `path/to/file.ts:123` (symbol) — what it does today.
- Verified anchors: `path/to/test.ts:456` — the behaviour already pinned.
- What is **not** the cause, when a defect is being narrowed.

## Workspaces

Only when the work spans repositories. One alias per root; the first declared
root is primary when no `primary` marker is given.

```text
W: C:/work/W
D: C:/work/D
```

## Plan Steps

Number the steps `1..N`. Sub-bullets are detail for the same row, not new rows.
A step may carry these metadata lines:

- `Checks:` executable checks for this row (a fenced `checks:` block or one
  whole-code-span command per line). `Verify:` is an accepted synonym.
- `Files:` expected files (comma or newline separated, max 20).
- `Workspaces:` aliases this row may attribute (max 8).
- `Acceptance:` readable evidence, **never executed**.

Group rows under a sub-heading inside `## Plan Steps` (for example
`### Phase 1 — <name>`); the heading becomes the row's group in the panel.
The row's label is the step number itself. There is no `Label:` metadata line.

### Phase 1 — <name>

1. **<Step title>**
   Files: `src/module.ts`, `src/module.test.ts`
   Checks:
     ```checks
     - id: typecheck
       command: pnpm typecheck
       kind: gate
     ```
   Acceptance: the new module is covered and the old path still compiles.

2. **<Step title>**
   Workspaces: D
   Verify: `pnpm --dir packages/app test`
   Acceptance: the cross-repo consumer builds against the new contract.

### Phase 2 — document and hand off

3. **<Step title>**
   Files: `docs/<doc>.md`
   Acceptance: docs match the shipped behaviour; nothing claims a check that
   did not run.

## Risks

- **Risk.** Likelihood/impact and the mitigation that is already in the plan.
- **Compatibility.** What old runs/plans keep doing, and what needs an
  amendment instead of a rewrite.

## Verification

The final gate. Fenced command blocks are one command per line and are the
default, dependency-free authoring surface:

```bash
pnpm typecheck
pnpm lint
pnpm test
```

Use a restricted `checks:` block only when a check needs `kind`, a workspace
alias, a timeout or a non-zero expected exit code:

```checks
- id: final-tests
  command: pnpm test
  kind: gate
  timeoutMs: 1800000
- id: release-notes
  command: pnpm check:release
  kind: diagnostic
```

Rules that the compiler enforces (a violation refuses the plan with a line
number, it does not silently drop the check):

- A bullet is a check only when it is **one whole command** or **one whole
  code span**. Mixing a command with prose is an error.
- `Acceptance:` is evidence. It is never executed, and a command-shaped value
  there is still a criterion.
- `kind: gate` (default) gates acceptance; `diagnostic` runs and reports;
  `manual` is a human attestation that is never executed.
- Limits: 12 checks per row and per final gate, 20 `Files:` entries, 8
  workspaces, 500 rows, 4000 characters per command, `timeoutMs` 1–3600000,
  `expectedExitCode` 0–255.
- A plan with no final `gate` check is unverifiable and needs an explicit
  acknowledgement before it can be frozen.

Run `/plan lint` (or the read-only `plan_validate` tool) after writing or
editing this file to see exactly what will execute.
