# @dieulc/workflow

Plan↔Build mode, questionnaire, subagent explore, todos and shadow-checkpoint rewind for Pi.

## Features

- **Plan / Build duality** — `Plan` tool gating (`edit`/`write` blocked in plan), `Build` restores full tools; tab + `CtrlAlt+p` shortcuts, `--workflow-plan` flag
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
| `/role` | Config screen: one model + thinking per role (planner/explorer/builder tabs, custom roles included). CLI: `list`, `set <role> <provider/model> [thinking]`, `use <role\|auto>`, `add/remove/reset` |

## Settings

Role config lives in `~/.pi/agent/roles.json` v2 (user) with optional per-project override at `<cwd>/.pi/roles.json` (per-role replace). Each role holds exactly one `{provider, id, thinking}`. v1 `modelPool` files are discarded and reseeded on load. Seeded with defaults on first run. No extra `settings.json` keys — respects `theme`, `modelRegistry`, and `plannotator` phases from `agent/plannotator.json`.

## How it works

See `index.ts`, `checkpoint.ts` (shadow bare-repo), `utils.ts` (safe-command gating, todo/plan extraction), `roles.ts` (role registry, one model per role). Hot-reload via `/reload` when placed in `~/.pi/agent/extensions/workflow/` or loaded via `pi.extensions` manifest.

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
npm run typecheck   # tsc --noEmit
npm test            # node --test utils.todo.test.ts
```

Plain TypeScript, no build step — Pi loads `index.ts` directly (via jiti). From the repo root, `npm run verify` checks this package's manifest, tarball contents, tests and load path before a release. Live reload: edit the `.ts` file and run `/reload` in Pi.

## License

MIT — see [LICENSE](./LICENSE).
