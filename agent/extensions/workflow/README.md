# @dieulc/workflow

Plan↔Build mode with an independent **Review Mode** reviewer, questionnaire, subagent explore, todos and shadow-checkpoint rewind for Pi.

## Features

- **Plan / Build duality** — `Plan` tool gating (`edit`/`write` blocked in plan), `Build` restores full tools; tab + `CtrlAlt+p` shortcuts, `--workflow-plan` flag
- **Review Mode** — an independent reviewer agent that runs in its own in-process session, reuses Plan Mode's context, audits the plan, rewrites it, and hands it to Plannotator. Off by default; see [Review Mode](#review-mode) below.
- **Questionnaire** — 1–4 questions with headers/options, dedup freeform aliases, inline `↳ Your answer:` editor
- **Explore (subagents)** — parallel `pi --mode json` subagents (`max 8`, concurrency 4), `session_shutdown` kill, `activeSubagents`
- **Todos** — plan-faithful todo list (global step refs + statuses + phase groups) that persists across Plan/Build/Default modes. `workflow_todo` (`list/update/done/pending/add/toggle/sync/clear`) with industry-style wholesale `update` (send the COMPLETE list; omitted items are removed) plus idempotent `done`/`pending`, lenient `[DONE:<ref>]` markers, throttled Claude-Code-style reminders, a tool-result footer, and a stale ⚠ notice — but **no forced turns and no heuristic auto-completion** (reference: Claude Code / OpenCode / Codex practice).
- **Rewind** — shadow bare-repo checkpoints per cwd (`agent/checkpoints/checkpoint-<slug>.git`), `isDirty` + `createSafetySnapshot` + `restoreCode`
- **Plannotator bridge** — `plannotator:request/review-result/plan-approved` events, inline markdown handoff (`ScrollView` → inline scrollback), `getUtcDatePrefix` / `normalizePlanPath` for `.pi/plans/<UTC-date>-<slug>.md`
- **Model roles** — Planner/Explorer/Builder roles with one model + thinking level each (`roles.ts`, `~/.pi/agent/roles.json` v2). `/plan` switches to the planner model, `/build` to the builder model, `explore` subagents use the explorer model. `/role` opens a tabbed picker (scoped models first, `Ctrl+O` for all).

## Install

```bash
pi install npm:@dieulc/workflow            # latest
pi install npm:@dieulc/workflow@0.1.0      # pinned
pi install -l npm:@dieulc/workflow         # project-local (.pi/settings.json)
pi -e npm:@dieulc/workflow                 # try without installing
```

Manage it with `pi list`, `pi update --extensions`, `pi remove npm:@dieulc/workflow`. Requires Pi on Node ≥ 22.19; the Pi core packages (`@earendil-works/*`, `typebox`) are provided by Pi at runtime and declared as peer dependencies.

## Commands

| Command | Description |
| --- | --- |
| `/plan` / `/workflow` | Enter plan mode (tool gating + switches session model to planner model `high` thinking) |
| `/build` | Enter build mode (full tools + switches session model to builder model `medium` thinking) |
| `/rewind` | Pick checkpoint to restore |
| `/todos` | Show todo list |
| `/btw` | Queue note for next turn |
| `/role` | Config screen: one model + thinking per role (planner/explorer/builder/reviewer tabs, custom roles included). CLI: `list`, `set <role> <provider/model> [thinking]`, `use <role\|auto>`, `add/remove/reset` |
| `/review-mode [on\|off] [global\|project]` | Enable/disable Review Mode (default `off`). `status` prints the effective config |
| `/review-prompt [global]` | Edit the reviewer's guidance (defaults to "align with the existing framework and industry best practice") |
| `/review-pane` | Open/close the dual-pane Review Workspace (`Ctrl+Shift+R`) |
| `/review-status` | Show review phase, model, plan hash, findings and any error |
| `/review` | Run one review round against the current plan file now |

## Review Mode

An independent second agent supervises the plan before you see it.

```text
Plan Mode (main session)  ──plan file──▶  Review Mode (child session)
       ▲                                          │
       │ feedback                                 │ rewrites the plan
       │                                          ▼
   Plannotator webview  ◀─────────────  reviewed plan + `## Review changes`
```

- **Approve** in Plannotator → Build mode; both Plan and Review shut down.
- **Feedback** → Plan revises, Review re-reviews the revision, Plannotator reopens.
- **Any failure** (missing model, unauth'd provider, timeout, abort) → the author's plan is handed over unchanged with a warning. Review Mode never blocks the plan.

### Enabling

```text
/review-mode on              # global (~/.pi/agent/settings.json)
/review-mode on project      # this repo only (<cwd>/.pi/settings.json)
/review-mode status
```

Turning the toggle off stops the reviewer and restores the single-agent plan/build flow exactly as it was. Nothing in Review Mode runs while it is disabled.

### The reviewer's model

Review Mode runs in its own session with its own model, taken from the **`reviewer` role** (`/role`). The default seed is deliberately a *different* model from the planner so the review brings an independent perspective — a reviewer that shares the planner's model and thinking tends to share its blind spots.

```text
/role set reviewer opencode-go/muse-spark-1.3-contributor xhigh
```

If the reviewer role has no model, Review Mode falls back to the planner model and warns rather than silently doing nothing.

### Reviewer guidance

`.pi/review-prompt.md` (project) wins over `~/.pi/agent/review-prompt.md` (global), which wins over the built-in default. Edit it with `/review-prompt`.

The built-in default asks the reviewer to, in priority order: align with the **existing project framework**, follow **industry best practice**, verify every requirement maps to a plan step, check the plan is executable without guessing, and prefer simplicity. Repository context files (`AGENTS.md`, `CLAUDE.md`, …) also load into the reviewer's system prompt, which is where most framework alignment actually comes from.

This guidance lives **only in the reviewer's session**. Plan Mode receives a single neutral line ("a reviewer will audit this plan") and can never see the reviewer's prompt, findings, or transcript.

### Permissions

Review Mode has *exactly* Plan Mode's permissions: read-only, plus one write path.

| Tool | Purpose |
| --- | --- |
| `read`, `grep`, `find`, `ls` | Inspect the repository |
| `review_bash` | Shell access, gated by the same `isSafeCommand` allowlist Plan Mode uses: no redirects, no `rm`/`mv`/`cp`/`mkdir`/`touch`, no `sudo`, no package installs, no `git add/commit/push`. Note this also means **no test/build/linter runs** — that is faithful parity with Plan Mode, and the prompt tells the reviewer to verify by reading rather than executing |
| `review_explore` | Read-only reconnaissance subagents on the **explorer** role's model, capped by `exploreBudget` per round |
| `review_submit_plan` | The **only** write path: validates and saves the revised plan to Plan Mode's own `.pi/plans/<UTC-date>-<slug>.md` |
| `review_pass_done` | Ends a pass with a verdict (refused if nothing was submitted) |

The built-in `bash`, `edit` and `write` tools are never given to the reviewer at all.

### Two passes

1. **Review + rewrite** — audits the plan against the repository and the guidance, records findings, submits the revised plan.
2. **Self-verify** — re-reads the original and the rewrite, confirms every accepted finding was actually addressed, and reports anything that was silently dropped. This pass exists because a rewrite can lose a requirement the author cared about.

Pass 2 is skipped when `verify` is false or when pass 1 found nothing at severity ≥ 5.

### Every change is visible

A `## Review changes` appendix is appended to the plan automatically (the reviewer is told not to write it), grouped by tier with file:line, severity, confidence and rationale:

```markdown
## Review changes

reviewer `opencode-go/muse-spark-1.3-contributor` · verdict **revise**

**Findings:** 2 addressed, 1 rejected, 1 deferred

### Addressed

**Critical**

- 🔴 `src/export/csv.ts:1` — Plan ignored the Result<T,E> convention _(severity 9, confidence 85%, framework-alignment)_
  - Every sibling exporter returns Result; the plan returned a bare string.

### Deferred

- ⏸ No rollback path _(severity 7, confidence 80%)_
```

### The Review Workspace pane

`/review-pane` (or `Ctrl+Shift+R`) opens a two-column overlay: **Plan Mode's transcript on the left, the reviewer's on the right**, each scrolling independently.

| Key | Action |
| --- | --- |
| `Tab` | Switch focused pane |
| `↑` / `↓` | Scroll one line |
| `PgUp` / `PgDn` | Half-page |
| `g` / `G` | Jump to top / bottom |
| `f` | Toggle follow (pin to newest) |
| `c` | Collapse |
| `x` | Abort the in-flight review round |
| `Esc` | Close the pane (the review keeps running) |

A one-line status strip also sits above the editor while a review is active, so the pane is optional.

> **Why an overlay and not a real split?** pi-tui's constrained `HStack`/`VStack` regions only work in the experimental `tuiMode: "fullscreen"` alt-screen; pi's default TUI (`TuiMainScreen`) caps extension widgets at ~10 lines because the terminal owns scrollback. So the panes are rendered as line buffers, sliced to their own viewport height and composed side-by-side by `composeTwoColumn` (ANSI-aware, so colours cannot bleed between columns). This gives genuine two-column independent scrolling in the default TUI.

### Isolation

The reviewer is an in-process child session created with `createAgentSession`, and it is isolated on purpose:

- `DefaultResourceLoader({ noExtensions: true })` — the child cannot load this (or any other) extension, so Review Mode cannot recurse.
- `SessionManager.inMemory(...)` — no session file is written; the reviewer never touches the parent's history.
- Its own `ModelRuntime` — no contention with the parent's model state.
- Plan Mode's conversation is passed as **pruned** prompt context (oversized tool results elided, workflow-injected markers dropped, nothing after the plan write), not by sharing the session.

An environment marker (`PI_WORKFLOW_REVIEW_CHILD`) is set only for the duration of session creation and restored immediately — the child runs in the same process, so leaking it would affect a later `/reload`.

### Configuration

Settings live under `workflow.reviewMode` in `~/.pi/agent/settings.json` (global) or `<cwd>/.pi/settings.json` (project). Project values win field-by-field over global. Writing them preserves every other key in the file.

## Settings

Role config lives in `~/.pi/agent/roles.json` v2 (user) with optional per-project override at `<cwd>/.pi/roles.json` (per-role replace). Each role holds exactly one `{provider, id, thinking}`. v1 `modelPool` files are discarded and reseeded on load. Seeded with defaults on first run. Respects `theme`, `modelRegistry`, and `plannotator` phases from `agent/plannotator.json`.

Review Mode settings live under `workflow.reviewMode`:

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `false` | Master toggle. When false, every Review Mode code path is a no-op |
| `parallel` | `true` | Start the reviewer with Plan Mode and let it explore concurrently; `false` starts it only when the plan is ready |
| `rounds` | `1` | Max Plan↔Review rounds per user-feedback cycle. Reached the cap → the plan is handed over with an `## Unresolved findings` appendix |
| `passes` | `2` | `1` = review+rewrite only; `2` = review, then self-verify |
| `verify` | `true` | Run the self-verification pass |
| `autoOpenPane` | `true` | Open the Review Workspace when a review starts |
| `fallbackOnError` | `"skip"` | `skip` hands over the author's plan on any failure (`block` is reserved) |
| `exploreBudget` | `3` | Max `review_explore` subagents per round (cost ceiling) |
| `timeoutMs` | `600000` | Wall-clock cap per pass — a silent reviewer can never hang the handoff |

```json
{
  "workflow": {
    "reviewMode": { "enabled": true, "rounds": 1, "passes": 2, "exploreBudget": 3 }
  }
}
```

`"reviewMode": true` is accepted as shorthand for `{ "enabled": true }`.

## How it works

See `index.ts`, `checkpoint.ts` (shadow bare-repo), `utils.ts` (safe-command gating, todo/plan extraction, ANSI-aware pane layout), `roles.ts` (role registry, one model per role), and the Review Mode modules: `review.ts` (config, prompt, state, transcript, child session — no runtime imports, so it is unit-testable), `review-tools.ts` (the reviewer's tool set), `review-runtime.ts` (round orchestration), `review-pane.ts` (the dual-pane overlay). Hot-reload via `/reload` when placed in `~/.pi/agent/extensions/workflow/` or loaded via `pi.extensions` manifest.

### Todo protocol (industry-aligned)

- **Canonical refs**: every todo row is numbered **globally** `1..N`; those numbers are the only refs the model ever needs. Refs are canonical positions — they are recomputed as `1..N` after every mutation (plan merge, `update`, session restore), so the pinned widget, handoff messages, tool output and `workflow_todo` refs always show the same numbers (no 11–20 drift). The plan's per-phase labels (e.g. `Phase B: 1..3`) are preserved only as display metadata (`(plan label B2)`). Integer refs resolve by canonical `ref` → positional `step` → unique `label`; the resolver also accepts `Group/Label`, `Label@Group`, `#N` and unique text (≥8 chars).
- **States**: `pending` → `in_progress` → `completed` (+ `cancelled`). Exactly one `in_progress` at a time (the harness normalizes extras). `completed` is kept as a derived legacy field for old sessions/external readers.
- **Update**: `workflow_todo {action:"update", todos:[{ref?, text?, status?}]}` replaces the whole list — TodoWrite/todowrite/update_plan semantics. A `ref` is resolved by canonical ref, then normalized text, then leniently by plan label / group-qualified ref / unique text; a ref that had to be resolved leniently (or matched nothing and was added) is reported under `Warnings:` in the tool result. `done`/`pending` are idempotent single-item sets; `toggle` is a convenience flip; `add` appends an ad-hoc item; `sync` re-extracts the plan file, matches steps by exact text then by plan label (so model-rewritten wording reunites instead of duplicating), **preserves agent-added items** (reported as `kept N agent-added`) and never un-completes (status rank merge); `clear` empties.
- **Reminder cadence** (Claude Code-style throttle): a hidden `[TODO LIST]` context block is injected only when `turnsSinceLastTodoWrite ≥ TURNS_SINCE_WRITE` **and** `turnsSinceLastReminder ≥ TURNS_BETWEEN_REMINDERS` (`=3`). Unresolved `[DONE:…]` refs from the previous turn bypass the throttle once so the model learns the right numbers. A one-line `[TODO …]` footer is appended to the first successful `edit`/`write`/`bash` result of each turn.
- **Stale notice (no forced turns)**: if a run mutated files but recorded no todo progress, the user gets one `⚠` status marker + a `ctx.ui.notify` (30 s dedupe); plan-file `- [x]` ticks are reconciled at `agent_end` in all modes, skipped when the plan content is unchanged (path+hash guard). No auto-completion — the list is never marked done based on intent. Legacy lists that already contain duplicate rows are not auto-merged; run `/todos clear` (or approve a new plan) to reset.

## Development

```bash
cd agent/extensions/workflow
npm install
npm run typecheck   # tsc --noEmit (covers every source file, including the review modules)
npm test            # node --test utils.todo.test.ts review.test.ts
```

Plain TypeScript, no build step — Pi loads `index.ts` directly (via jiti). From the repo root, `npm run verify` checks this package's manifest, tarball contents, tests and load path before a release. Live reload: edit the `.ts` file and run `/reload` in Pi.

## License

MIT — see [LICENSE](./LICENSE).
