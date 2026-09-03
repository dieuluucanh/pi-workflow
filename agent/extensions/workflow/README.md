# @dieulc/workflow

Plan↔Build mode, questionnaire, subagent explore, todos and shadow-checkpoint rewind for Pi.

## Features

- **Plan / Build duality** — `Plan` tool gating (`edit`/`write` blocked in plan), `Build` restores full tools; tab + `CtrlAlt+p` shortcuts, `--workflow-plan` flag
- **Questionnaire** — 1–4 questions with headers/options, dedup freeform aliases, inline `↳ Your answer:` editor
- **Explore (subagents)** — parallel `pi --mode json` subagents (`max 8`, concurrency 4), `session_shutdown` kill, `activeSubagents`
- **Todos** — `workflow_todo` (`list/add/toggle/clear`, `[DONE:n]` preservation for compaction)
- **Rewind** — shadow bare-repo checkpoints per cwd (`agent/checkpoints/checkpoint-<slug>.git`), `isDirty` + `createSafetySnapshot` + `restoreCode`
- **Plannotator bridge** — `plannotator:request/review-result/plan-approved` events, inline markdown handoff (`ScrollView` → inline scrollback), `getUtcDatePrefix` / `normalizePlanPath` for `.pi/plans/<UTC-date>-<slug>.md`

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
| `/plan` / `/workflow` | Enter plan mode (tool gating) |
| `/build` | Enter build mode (full tools) |
| `/rewind` | Pick checkpoint to restore |
| `/todos` | Show todo list |
| `/btw` | Queue note for next turn |

## Settings

No extra `settings.json` keys — respects `theme`, `modelRegistry`, and `plannotator` phases from `agent/plannotator.json`.

## How it works

See `index.ts` (~3400 lines), `checkpoint.ts` (shadow bare-repo), `utils.ts` (safe-command gating, todo/plan extraction). Hot-reload via `/reload` when placed in `~/.pi/agent/extensions/workflow/` or loaded via `pi.extensions` manifest.
