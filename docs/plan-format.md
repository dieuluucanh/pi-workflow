> **Superseded (2026-11-24).** The frozen plan contract and the automatic
> acceptance engine described below were removed. Current flow: a normal
> markdown plan, optional append-only review, then Direct Build or the
> model-driven Orchestrator dispatcher. Old runs are not resumed. See the
> README section "2026-11-24 — model-driven Orchestrator".

# Plan format, executable checks and the plan-execution contract

This is the canonical reference for authoring a plan that the Workflow
extension can compile, lint, freeze and execute. The machine-readable skeleton
is [`plan-template.md`](plan-template.md); migrating an existing plan is covered
by [`plan-migration.md`](plan-migration.md).

The one rule that explains the rest: **a check is typed data, not prose.** A
Markdown sentence is never handed to a shell. `Acceptance:` is evidence people
read; only `gate` checks decide acceptance.

## Where a plan lives

`.pi/plans/<UTC-date>-<slug>.md`, where `<date>` is `YYYY-MM-DD` (UTC) and
`<slug>` is kebab-case, at most 40 characters (e.g.
`.pi/plans/2026-11-24-plan-execution-contract-refactor.md`). A wrong date prefix
is corrected by the extension; the slug is not.

## Canonical headings

| Section | Role |
| --- | --- |
| `# Plan: <title>` | Title, recorded as `source.title`. |
| `## Context` | Problem, evidence and constraints. Not executable. |
| `## Decisions` | Numbered decisions and the alternatives they replace. |
| `## Exploration Summary` | Verified anchors (`file:line` + symbol) from recon. |
| `## Workspaces` | Optional multi-repo aliases: `W: C:/work/W`. |
| `## Plan Steps` | The only row source. One top-level item per row. |
| `## Risks` | Risks and mitigations. Not executable. |
| `## Verification` | The final gate (plan-level checks, executed once). |

Only `## Plan Steps` produces rows, and only `## Verification` produces
plan-level checks. A heading may be any level; a second `## Plan Steps` or
`## Verification` section is an error, not a merge. Sections named context,
decisions, exploration, risks, verification, non-goals/out of scope, notes and
summary are never mined for rows when the step section is missing.

## Rows in `## Plan Steps`

A row is a top-level step written as one of:

- a numbered item — `1. **Title.**` or `1. Title`;
- a step heading — `### 1. Title` / `### Step 1: Title`;
- a bold line — `**Title**` / `- **Title**`;
- a checkbox — `- [ ] Title`.

Rows are assigned `ref` `1..N` in document order and a stable id once, at
freeze. Duplicate display text is **not** deduplicated and text is **not**
truncated: the frozen list is the plan, not a summary of it. Nested bullets are
detail of the same row.

### Per-row metadata

Metadata lines start a mode that continues over following bullets until a blank
line or another labelled line. The label must start the line (indentation is
fine, a `-`/`*` bullet marker is not — a bulleted `- Files:` line is ordinary
body text, not metadata). Accepted labels (case-insensitive):

| Label | Meaning | Bounds |
| --- | --- | --- |
| `Checks:` / `Verify:` | Executable row checks | 12 |
| `Files:` / `Expected files:` / `Paths:` | Expected file evidence | 20 |
| `Workspaces:` / `Repos:` / `Repositories:` | Row workspace aliases | 8 |
| `Acceptance:` / `Acceptance criteria:` | Prose criteria — **never executed** | 20 |

There is no `Label:` metadata line. A row's `label` is its step number token;
its `group` comes from the sub-headings it sits under inside `## Plan Steps`
(`### Phase A — unblock`), which also drives the panel grouping. An
unrecognised labelled line (like `Label:`) is ordinary body text and is
ignored by the compiler.

```markdown
### Phase A — unblock

1. **Add the parser guard.**
   Files: `agent/extensions/workflow/plan-checks.ts`
   Workspaces: W
   Checks:
     ```checks
     - id: typecheck
       command: pnpm typecheck
       kind: gate
       timeoutMs: 900000
     ```
   Acceptance: the five incident bullets are refused with a line number.
```

A workspace tag may also prefix a check or bullet — `[W] npm test` — and
`Workspace: W` on its own line selects the alias for the following commands.

## Executable check surfaces

There are exactly three ways a command becomes executable, and each produces a
typed `CheckSpec`:

1. **Fenced command block** (first-class, dependency-free). A fenced block
   inside `## Verification` that is not the `checks` language is one command per
   line — `bash`/`sh` by convention, and a plain fence works too:

   ````markdown
   ## Verification
   ```bash
   pnpm typecheck
   pnpm lint
   pnpm test
   ```
   ````

2. **Whole-bullet code span.** A bullet that is exactly one code span is one
   command: `` - `pnpm typecheck` ``.

3. **Restricted `checks:` block.** A fence with the info string `checks` adds
   the typed fields. This is a deliberately small YAML subset, parsed by an
   in-repo reader with no runtime dependency:

   ````markdown
   ```checks
   - id: final-gate
     command: pnpm test
     kind: gate
     workspace: W
     timeoutMs: 1800000
     expectedExitCode: 0
   ```
   ````

   Accepted keys: `id` (required), `command` (required), `kind`, `workspace`,
   `timeoutMs`, `expectedExitCode`. Values are single-line scalars: plain,
   single-quoted (`'…'` with `''` escape) or double-quoted (`"…"` with only
   `\\` and `\"`). A ` #` outside quotes starts a comment; blank lines and `#`
   lines are ignored.

   Anything else is an **error with a line number**, never a silent misread:
   anchors/aliases/tags (`&`, `*`, `!`), flow collections (`[]`, `{}`), block
   scalars (`|`, `>`), multi-line values, tabs, duplicate keys, unknown keys,
   nested mappings, directives.

### `kind` semantics

| Kind | Runs | Gates acceptance |
| --- | --- | --- |
| `gate` (default) | yes | yes |
| `diagnostic` | yes | no — reported, may fail without blocking |
| `manual` | no | no — a human attestation, never auto-accepted |

A plan with **no final `gate`** check is unverifiable: it compiles, but freezing
it requires an explicit acknowledgement. A `## Verification` made of fenced
command lines is gates and needs no extra prompt.

### Limits

| Bound | Value |
| --- | --- |
| Rows | 500 |
| Checks per row / per final gate | 12 |
| Acceptance criteria per row | 20 |
| Expected files per row | 20 |
| Workspaces | 8 |
| Text (row text, criterion, file, command) | 4000 chars |
| `timeoutMs` | integer 1…3 600 000 |
| `expectedExitCode` | integer 0…255 |

## No prose commands

The compiler refuses, with a 1-based line number:

- a bullet that mixes a command with prose —
  `` - `pnpm dev:preflight`, followed by a controlled smoke test. ``;
- backticks around only part of a command;
- Markdown-rendered commands (`**pnpm test**`), multi-line values, leading or
  trailing whitespace inside the command, CR/LF/NUL bytes, and >4000 chars.

A prose-only bullet in `## Verification` is **ignored**, not executed: that is
documentation, not a check. A bullet that is not command-shaped but contains a
backtick is the mixed case and is an error. This is exactly the class of defect
that produced the 2026-11-21 incident (`pnpm dev:preflight\`,`).

## Compiler, lint and preview workflow

`plan-compiler.ts` is the single reader. `compilePlan` turns Markdown into a
typed `PlanSpec` (version 1):

```text
PlanSpec
  version: 1
  source   { kind, path, digest, bytesSha256, title }
  compiler { version: "plan-compiler/1", specHash }
  rows     [ { id, ref, text, label?, group?, checks[], acceptanceCriteria[], expectedFiles[], workspaces[], sourceLine? } ]
  planChecks [ CheckSpec ]      # the final gate
  workspaces [ { id, root, primary } ]
  diagnostics [ { severity, code, message, line?, rowId?, checkId? } ]
```

Display (`extractPlanStepsFromMarkdown`), freeze, and legacy `planChecks` /
`acceptanceChecks` views are thin projections of the same output — no second
source of truth, no divergent section rules.

Before approval:

1. Write or edit the plan.
2. Run `/plan lint` (or `/workflow lint [path]`, or the read-only
   `plan_validate` tool). It prints the row count, gate/diagnostic/manual
   counts, every exact final and per-row command with workspace, timeout and
   expected exit code, and every diagnostic with a line number.
3. The handoff sheet shows the same compiled preview.
4. A plan that does not compile is refused at approval; nothing reaches
   `run.created`. A reviewer rewrite goes through the same gate and cannot
   introduce an ambiguous check or silently drop every final gate.

`/plan lint` never freezes, writes or executes anything. The compiler and lint
are pure: no clock, no filesystem, no shell.

## Failure taxonomy

Every executed check returns exactly one failure class:

| Class | Meaning | Repairable |
| --- | --- | --- |
| `none` | passed | — |
| `test` | the command ran and failed | yes |
| `timeout` | the check exceeded its deadline | yes |
| `metadata` | malformed spec, unknown workspace, bad frozen snapshot | no |
| `policy` | the shell/permission guard refused the command | no |
| `environment` | missing tool/root, policy-neutral infrastructure failure | no |
| `manual` | human attestation not provided | no |

Only `test` and `timeout` start a repair round (bounded, at most 2, against the
same warm child). `metadata`, `policy` and `environment` block the row with a
concrete fix instead of burning a repair round on something re-prompting cannot
change; `manual` can never auto-accept. The classification happens in one place
(`check-executor.ts`), for row checks, the final gate and Build `verify` alike.

## The final-gate marker

The plan-level checks run ONCE, before the last row is accepted, and the result
is journaled as a `final_gate` event (payload version 1):

```text
final_gate {
  version: 1,
  specHash,             # content hash of exactly what ran
  ok, checkedAt,
  results[],            # bounded per-check evidence, no output text
  workspaceRevisions,   # workspaceId -> revision judged
  failureClass?, failure?
}
```

Completion requires a passing record whose `specHash` matches the current frozen
snapshot. A changed check list is a different hash, so an old pass can never
authorize a new gate; a retry after an amendment needs a new passing record. The
marker also stops the second call path (the Build-completion branch) from
re-running checks that already passed. An unreadable or tampered record is not a
pass.

## Repairing a malformed frozen run

Recovery is an **append-only amendment**, never a journal edit, re-freeze from
changed plan text, or hand-written event. A malformed v1 `planChecks` list (the
live 2026-11-21 incident) is repaired by appending one `run.control` event with
`action: "plan-check-specs-repair"`, `version: 1`, the previous and proposed
checks, a reason, the source, the approval time and an optional manifest hash.
Rows, ids, statuses, workspaces and `RunState.revision` are untouched.

In session:

```text
/orchestrator-repair-checks                 # status; read-only
/orchestrator-repair-checks --from-plan     # propose the current plan's checks
/orchestrator-repair-checks --file manifest.json
/orchestrator-repair-checks --file manifest.json --yes
```

Flags: `status`, `--file <manifest.json>`, `--from-plan`, `--allow-empty`,
`--yes`. It shows current → proposed checks and asks `ui.confirm` unless
`--yes`; applying re-freezes through the TODO store so `validateFrozenSnapshot`
runs again and the panel updates.

Out of session (same event, no extension runtime):

```bash
node --experimental-transform-types \
  agent/extensions/workflow/scripts/repair-orchestrator-checks.mjs \
  --run-dir <dir> --manifest manifest.json --dry-run
```

The script defaults to a dry run and requires `--apply --yes`. Other flags:
`--run-dir` (required, contains `journal.ndjson`), `--expect-seq <n>`,
`--expect-accepted <n>`, `--status`, `--json`, `--help`. After applying it
reopens the run and verifies sequence +1, the checksum chain, `snapshot.json`,
the replayed specs and the unchanged accepted/task states; a repeated apply is a
no-op by deterministic event id.

Manifest shape: `{ "reason": "...", "source": "...", "commands": ["pnpm test"], "allowEmpty": false }`
or `specs` instead of `commands` for typed checks.

## `workflow.orchestrator` settings

Execution waits are user-owned settings, merged field by field with project over
global over default, each clamped to the shell guard's hard cap (3600 s). An
invalid value is ignored **with a diagnostic**, never silently treated as the
default.

```json
{
  "workflow": {
    "orchestrator": {
      "childTimeoutMs": 2700000,
      "verificationTimeoutSeconds": 900,
      "gitTimeoutMs": 60000
    }
  }
}
```

| Key | Default | Bounds | Applies to |
| --- | --- | --- | --- |
| `childTimeoutMs` | 2 700 000 (45 min) | 1…3 600 000 ms | one Build child turn |
| `verificationTimeoutSeconds` | 900 | 1…3600 s | one check deadline |
| `gitTimeoutMs` | 60 000 | 1…3 600 000 ms | `git` baseline/diff |

A per-check `timeoutMs` narrows further; it can never exceed the hard cap. The
shell guard's own `workflow.shellGuard` limits still apply to every shell
surface.

## Compatibility: v1 → v2

The stored contract is versioned, and older artifacts keep working:

- **Journal framing stays v1.** Each line keeps line version 1, canonical-JSON
  checksum and the `prev` chain. Existing journals replay byte-identically; an
  unknown line version is still treated as a torn tail. On load every known
  event type has a payload validator; unknown event types and unknown payload
  versions fail closed instead of being trusted.
- **Frozen snapshots are written as `schemaVersion: 2`**: source
  `{path,digest,bytesSha256,title}`, `compiler {version,specHash}`, typed rows
  and checks, plan-level checks, workspaces, the validation report (warnings and
  quarantined checks) and `createdAt`. `planChecks` and row `acceptanceChecks`
  remain derived legacy views so the panel and older consumers keep working.
- **v1 snapshots are upcast in memory**, never rewritten on disk. A v1
  `acceptanceChecks` value becomes a typed check only when it is actually
  command-shaped; otherwise it stays a criterion with a warning. A malformed v1
  plan check is **quarantined** with its exact bytes and a repair instruction —
  it is never executed, and it does not make the journal unloadable.
- **Unknown future versions fail closed** with an actionable message: a newer
  writer can never be half-read.
- **Restore reads the journal snapshot, not the plan file.** Plan text creates a
  new run. Restoring validates the journaled snapshot, preserves workspaces and
  checks, and can rebind by plan path when the plan digest changed. A missing or
  unreadable plan file never blocks restoring an intact journal.
- `snapshot.json` `seq`/`revision` are cross-checked against the replayed
  journal; a stale cache is rebuilt rather than trusted.

## What is not auto-executed, and never mutated

- `Acceptance:` / `acceptanceCriteria` — prose evidence, never a command, even
  when it looks like one.
- `Files:` / `Workspaces:` — evidence and bindings, not commands.
- `manual` checks — human attestation only.
- Prose bullets in `## Verification` — documentation, ignored.
- Journals, `snapshot.json` and frozen lists — never hand-edited. Repair goes
  through the amendment event, and only the runtime reports acceptance.
- A plan is never silently re-frozen from mutable text after a run exists.

## Related references

- [`plan-template.md`](plan-template.md) — the canonical skeleton.
- [`plan-migration.md`](plan-migration.md) — moving an existing plan.
- [`orchestrator-operations.md`](orchestrator-operations.md) — operator commands,
  recovery and the run lifecycle.
- [`incidents/2026-11-24-plan-check-freeze-repair.md`](incidents/2026-11-24-plan-check-freeze-repair.md)
  — the incident this contract closes.
