> **Superseded (2026-11-24).** The frozen plan contract and the automatic
> acceptance engine described below were removed. Current flow: a normal
> markdown plan, optional append-only review, then Direct Build or the
> model-driven Orchestrator dispatcher. Old runs are not resumed. See the
> README section "2026-11-24 — model-driven Orchestrator".

# Migrating an existing plan to the canonical format

The compiler accepts every plan that already worked. Migration is only needed
where a plan relied on prose being guessed at, where a step needs typed check
metadata, or where a frozen run already contains malformed checks. This guide
maps each old shape to the new one; the format reference is
[`plan-format.md`](plan-format.md) and the skeleton is
[`plan-template.md`](plan-template.md).

## Inventory first (read-only)

Before editing any plan or repairing any run, take stock without writing
anything:

```bash
node --experimental-transform-types \
  agent/extensions/workflow/scripts/migration-report.mjs \
  --runs-dir ~/.pi/agent/orchestrator/runs --plans-dir .pi/plans
```

It replays every journal, applies the `plan-check-specs-repair` amendments in
memory, and reports the stored snapshot version, quarantined checks with their
exact bytes, unbound workspace aliases, prose `acceptanceChecks`, a stale
`snapshot.json`, and plans that no longer compile. `--json` is machine-readable;
`--strict` exits non-zero when the repair list is non-empty. It never edits a
journal or snapshot, and the live run stays v1 on disk.

## Before you start

1. Open the plan and run `/plan lint` (or `plan_validate`). Read the diagnostics
   with their line numbers — do not guess which bullet is executable.
2. Keep the plan's meaning: rows (`1..N`) and their order are the frozen
   identity of a run. Migration edits the check surface, not the task list.
3. If a run already exists for the plan, do **not** re-freeze or restart it to
   "pick up" the new text. A run keeps its journaled snapshot; repair it with an
   amendment (last section).

What already works unchanged:

- `.pi/plans/<date>-<slug>.md` naming and the `# Plan:` / `## …` headings.
- Numbered steps, bold steps, checkbox steps and `### 1. …` headings.
- A fenced one-command-per-line `bash`/`sh` block in `## Verification`.
- A bullet that is exactly one whole code span (`` - `pnpm test` ``).
- A raw bullet that is exactly one command (`- pnpm test`).
- `Acceptance:` prose, `Files:` and `Workspaces:` metadata (recompiled, same
  meaning).

## Prose bullets: move, never mix

The incident shape is a bullet that starts with a command and continues as
prose. The compiler refuses it with a line number instead of executing
`pnpm dev:preflight\`,`.

**Before (refused):**

```markdown
## Verification
- `pnpm dev:preflight`, followed by a controlled `npm run dev` smoke test.
- `pnpm typecheck`, `pnpm lint`, `pnpm test` and golden comparisons.
```

**After (one command per line, in a fenced block):**

````markdown
## Verification
```bash
pnpm dev:preflight
pnpm typecheck
pnpm lint
pnpm test
```
````

If a sentence is genuinely documentation, delete the backticks or move it out
of `## Verification`. A prose-only bullet is ignored; a command-shaped bullet
with prose attached is an error. Never leave a command rendered as `**bold**`
or wrapped in a partial code span.

## `Acceptance:` stays prose

`Acceptance:` is evidence a human reads; it is never executed, even if it looks
like a command. Do not move acceptance text into `## Verification` to make it
run. If a row needs an executable check, add a `Checks:` line or a fenced
`checks:` block; if it needs human evidence, keep `Acceptance:`.

**Before:**

```markdown
1. **Fix the parser.**
   Acceptance: `pnpm test` passes and the incident fixture is refused.
```

**After:**

````markdown
1. **Fix the parser.**
   Checks:
     ```checks
     - id: parser-tests
       command: pnpm test
       kind: gate
     ```
   Acceptance: the incident fixture is refused with a line number and the
   existing fenced-command plan still freezes.
````

## Rows: legacy metadata keeps working

Metadata is recognised only when the label starts the line. A bulleted
`- Acceptance:` / `- Checks:` / `- Files:` line is body text, so it is ignored
— drop the bullet marker to turn it into metadata. This is the one legacy shape
that needs an edit even when its content is fine.

| Old shape | New canonical shape |
| --- | --- |
| `- Acceptance: …` | drop the bullet: `Acceptance: …` — still criteria, never executed |
| `- Checks: \`pnpm typecheck\`` | `Checks: \`pnpm typecheck\``, or a fenced `checks:` block when metadata is needed |
| `- Verify: \`pnpm test\`` | drop the bullet; `Verify:` is an accepted synonym of `Checks:` |
| `- Files: a.ts, b.ts` | drop the bullet (`Expected files:`/`Paths:` also accepted) |
| `- Workspaces: W, D` | drop the bullet; aliases must be declared or passed at start |
| `[W] npm test` | unchanged (alias prefix) |
| `Workspace: W` then commands | unchanged (alias applies to following commands) |
| `Label: Phase A` | not metadata — use a `### Phase A` sub-heading inside `## Plan Steps` |

When a check needs a kind, a workspace, a deadline or a non-zero expected exit
code, prefer the typed block:

````markdown
```checks
- id: migration-check
  command: pnpm db:verify-ledger
  kind: diagnostic
  workspace: D
  timeoutMs: 600000
```
````

Remember the limits while splitting a long bullet: at most 12 checks per row
and per final gate, 20 files, 8 workspaces, 4000 characters per command.

## Zero-gate plans

A plan whose `## Verification` is prose only (or only `diagnostic`/`manual`
checks) still compiles, but it is unverifiable and freezing it requires an
explicit acknowledgement. If the plan genuinely has no automatable gate, record
that honestly. If it has one, give it a `gate` check; do not add a fake command.

## Frozen runs written in v1

New freezes write `schemaVersion: 2`. An existing v1 snapshot is read by
upcasting it in memory: command-shaped values become typed checks, other
`acceptanceChecks` values stay criteria with a warning, and a malformed plan
check is quarantined with its exact bytes — never executed and never fatal to
loading the journal. The v1 array on disk is not rewritten. Restoring a run uses
that journaled snapshot, not the current plan text, so editing the plan does not
silently change what an existing run verifies.

## Repairing a malformed v1 run

If an existing run's frozen checks are unusable (prose or malformed commands),
repair them with the append-only amendment. Do **not** hand-edit
`journal.ndjson`/`snapshot.json`, and do not delete and recreate the run to get
a new check list: accepted rows would be lost.

1. Copy the run directory (`journal.ndjson` + `snapshot.json`) to a temporary
   location and rehearse there first.
2. Inspect the current state:

   ```bash
   node --experimental-transform-types \
     agent/extensions/workflow/scripts/repair-orchestrator-checks.mjs \
     --run-dir <run-dir> --status
   ```

3. Write a manifest with the replacement checks, then dry-run it. The output
   shows run id, seq, phase, previous → proposed checks, validation and the
   accepted count; nothing is written.

   ```json
   {
     "reason": "v1 frozen checks were prose; replace with the six approved gates",
     "source": "migration",
     "commands": ["pnpm typecheck", "pnpm lint", "pnpm format:check", "pnpm check"]
   }
   ```

   ```bash
   node --experimental-transform-types \
     agent/extensions/workflow/scripts/repair-orchestrator-checks.mjs \
     --run-dir <run-dir> --manifest manifest.json --dry-run
   ```

4. Verify every proposed script actually exists in the target repository. A
   shape-valid command that names a missing script reproduces the incident with
   a different error.
5. Apply with the observed fences. Re-read `--status` immediately before and
   stop if the sequence moved:

   ```bash
   node --experimental-transform-types \
     agent/extensions/workflow/scripts/repair-orchestrator-checks.mjs \
     --run-dir <run-dir> --manifest manifest.json \
     --apply --yes --expect-seq <n> --expect-accepted <n>
   ```

   The script reopens the run and checks seq +1, the checksum chain,
   `snapshot.json`, the replayed specs and the unchanged accepted/task states.
   A repeated apply is a no-op.

6. In session, the same amendment is
   `/orchestrator-repair-checks --file manifest.json --yes` (or `--from-plan`
   to propose the plan's current compiled checks). Without `--yes` it asks for
   confirmation first. Only the runtime reports acceptance; an amendment is not
   a green result.

## Migration checklist

- [ ] `/plan lint` reports no error and shows the intended gate/diagnostic/manual
      counts.
- [ ] Every executable bullet is one whole command, one whole code span, or a
      line inside a fenced command/`checks:` block.
- [ ] No command appears in `Acceptance:`; evidence text stays prose.
- [ ] The `## Verification` fenced block lists the real final gates in the order
      they should run.
- [ ] Typed checks declare a workspace alias that is actually bound.
- [ ] A zero-gate plan is either given a real gate or explicitly acknowledged.
- [ ] Existing runs are repaired by amendment, not re-frozen.
