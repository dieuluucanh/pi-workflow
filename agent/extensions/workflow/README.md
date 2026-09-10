# @dieulc/workflow

Plan↔Build mode, questionnaire, subagent explore, todos and shadow-checkpoint rewind for Pi.

## Features

- **Plan / Build duality** — `Plan` tool gating (`edit`/`write` blocked in plan), `Build` restores full tools; tab + `CtrlAlt+p` shortcuts, `--workflow-plan` flag
- **Questionnaire** — 1–4 questions with headers/options, dedup freeform aliases, inline `↳ Your answer:` editor
- **Explore (subagents)** — parallel `pi --mode json` subagents (`max 8`, concurrency 4), `session_shutdown` kill, `activeSubagents`
- **Todos** — plan-faithful todo list (step labels + phase groups) that persists across Plan/Build/Default modes. `workflow_todo` (`list/add/toggle/sync/clear`), lenient `[DONE:<label>]` markers, and a per-turn build reminder so completion tracking never decays.
- **Rewind** — shadow bare-repo checkpoints per cwd (`agent/checkpoints/checkpoint-<slug>.git`), `isDirty` + `createSafetySnapshot` + `restoreCode`
- **Plannotator bridge** — `plannotator:request/review-result/plan-approved` events, inline markdown handoff (`ScrollView` → inline scrollback), `getUtcDatePrefix` / `normalizePlanPath` for `.pi/plans/<UTC-date>-<slug>.md`
- **Model roles** — Planner/Explorer/Builder roles with one model + thinking level each (`roles.ts`, `~/.pi/agent/roles.json` v2). `/plan` switches to the planner model, `/build` to the builder model, `explore` subagents use the explorer model. `/role` opens a tabbed picker (scoped models first, `Ctrl+O` for all).

## Install

```bash
pi install npm:@dieulc/workflow              # npm (when published)
pi install git:github.com/dieuluucanh/pi-workflow  # git (bundled via root wrapper)
pi -e ./agent/extensions/workflow/index.ts   # temp (one run)
```

Bundled with the dotfiles root wrapper `@dieulc/pi-workflow` — `pi install npm:@dieulc/pi-workflow` loads both workflow + autocompact.

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
