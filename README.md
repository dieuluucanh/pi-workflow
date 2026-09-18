# pi-workflow — Portable Pi Dotfiles

Four independently published Pi extensions, sane defaults, and the local release tooling for them — reproducible on any machine via `git clone` → `~/.pi`.

Each extension is its own npm package (install just what you want):

[![@dieulc/workflow](https://img.shields.io/npm/v/@dieulc/workflow?label=%40dieulc%2Fworkflow)](https://www.npmjs.com/package/@dieulc/workflow)
[![@dieulc/autocompact](https://img.shields.io/npm/v/@dieulc/autocompact?label=%40dieulc%2Fautocompact)](https://www.npmjs.com/package/@dieulc/autocompact)
[![@dieulc/server-logs](https://img.shields.io/npm/v/@dieulc/server-logs?label=%40dieulc%2Fserver-logs)](https://www.npmjs.com/package/@dieulc/server-logs)
[![@dieulc/browser-inspector](https://img.shields.io/npm/v/@dieulc/browser-inspector?label=%40dieulc%2Fbrowser-inspector)](https://www.npmjs.com/package/@dieulc/browser-inspector)

[![pi-package](https://img.shields.io/badge/pi--package-blue)](https://pi.dev/packages)

## What is included

| Path | npm package | Description |
| --- | --- | --- |
| `agent/extensions/workflow/` | `@dieulc/workflow` | Plan↔Build mode, questionnaire (1–4 Qs, dedup), subagent `explore`, `workflow_todo`, `/rewind` shadow-checkpoint, Plannotator bridge |
| `agent/extensions/autocompact/` | `@dieulc/autocompact` | Intelligent compaction: plan/todo-aware summary, 70% pre-warming, cheap model override, `/autocompact` |
| `agent/extensions/server-logs/` | `@dieulc/server-logs` | Docker + systemd log inspection tools (remote SSH or local) |
| `agent/extensions/browser-inspector/` | `@dieulc/browser-inspector` | Browser DevTools inspection via CDP: console, network, screenshots (fresh browser or real session) |
| `agent/settings.json` | — | Shared config: `packages`, theme, enabled models |
| `agent/keybindings.json` | — | Disables `tui.input.tab` (autocomplete conflict) |
| `agent/plannotator.json` | — | `planning` phase tool gate + status label |
| `agent/agents/planner.md`, `scout.md` | — | Agent presets |
| `scripts/` | — | `verify-packages.mjs` (pre-publish gate) + `release.mjs` (release tooling) |

External packages listed in `agent/settings.json` auto-install on first trusted startup.

> This repo root is **not** a Pi package and is not published (`"private": true`). Install the extensions individually, or clone the repo for the dotfiles.

## Install

### A — The extensions (npm)

```bash
pi install npm:@dieulc/workflow
pi install npm:@dieulc/autocompact
pi install npm:@dieulc/server-logs
pi install npm:@dieulc/browser-inspector

# pinned, for reproducible installs
pi install npm:@dieulc/workflow@0.1.0

# project-local (writes .pi/settings.json for team sharing)
pi install -l npm:@dieulc/workflow

# try without installing
pi -e npm:@dieulc/workflow
```

Manage them with `pi list`, `pi update --extensions`, `pi remove npm:@dieulc/workflow`.

### B — The dotfiles (git clone)

This repo **is** `~/.pi`. Clone it directly:

```bash
# fresh machine (no ~/.pi yet)
git clone https://github.com/dieuluucanh/pi-workflow ~/.pi

# if ~/.pi already exists, clone elsewhere and point the env var
git clone https://github.com/dieuluucanh/pi-workflow ~/pi-workflow
PI_CODING_AGENT_DIR=~/pi-workflow/agent pi
# or move: mv ~/.pi ~/.pi.bak && git clone ... ~/.pi
```

First `pi` run prompts to **trust** the project — approve. Missing `npm:` packages (`pi-lens` etc.) install automatically. `/reload` hot-reloads extensions.

> **Pick one per machine.** Cloning to `~/.pi` loads the extensions from source; installing the npm packages too would load duplicates. The clone is the development path, npm is the user path.

## Updating

- Extensions: `pi update --extensions` (or `pi install npm:@dieulc/workflow@0.2.0` to pin)
- Dotfiles: `cd ~/.pi && git pull`, then `pi update --extensions`

## Developing

```bash
cd ~/.pi

# pre-publish gate: manifest, imports, tarball contents, tests, load smoke test
npm run verify
npm run verify -- --packages workflow,server-logs

# per-package checks
(cd agent/extensions/workflow && npm run typecheck && npm test)
(cd agent/extensions/browser-inspector && npm run typecheck)
```

Extensions load directly from `agent/extensions/*` — edit the `.ts` file and run `/reload` in Pi. No build step.

## Releasing

Releases are cut locally with one script. Versions are **independent per package**, git tags look like `@dieulc/workflow@0.2.0`, and each package keeps its own `CHANGELOG.md` generated from commits since its previous tag.

```bash
npm login                      # once per machine (npm user: dieulc)
npm run release:status         # read-only: manifest versions vs the npm registry
npm run verify                 # gate: all four packages
npm run release -- --dry-run   # plan only: versions, changelogs, tarballs
npm run release                # interactive: pick packages + bump type

# non-interactive
npm run release -- --packages workflow,autocompact --bump minor --yes
```

What a release does: preflight (clean tree, `main`, npm auth) → verify → bump `package.json` → prepend `CHANGELOG.md` sections → one commit → `npm publish` per package → annotated tag per package → push commit + tags.

- `--bump none` publishes the current version as-is (first publish, or resuming).
- `--continue` resumes after an interrupted run: already-published versions and existing tags are skipped.
- A package whose target version is already on npm is **skipped, never fatal** — the rest of the batch is still published, tagged and pushed, and a missing tag for an already-published version is repaired. Add a bump to actually release it again, and always pass flags after `--` (`npm run release -- --continue`).
- `--no-push` stops before `git push`.

See [`docs/publishing.md`](docs/publishing.md) for the full reference and recovery paths.

## Secrets & machine-local files

These are **ignored** (never committed) and regenerated per machine:

- `agent/auth.json` — credentials
- `agent/models-store.json` — model catalog cache (regenerated via `pi update --models`)
- `agent/trust.json` — saved trust decisions — template at `agent/trust.json.example`
- `agent/sessions/`, `agent/checkpoints/`, `plans/`, `.pi/plans/`, `web-search-cache/`, `**/node_modules/`, `**/.cache/`, `nul`, `*.tgz`

Intentional config stays tracked: `agent/settings.json` (+ `settings.json.example`), `agent/keybindings.json`, `agent/plannotator.json`, `agent/agents/*.md`, `agent/extensions/**`.

If you fork, check `agent/settings.json` doesn't contain private `enabledModels` values you don't want public — `settings.json.example` is the safe template.

## Layout

```text
~/.pi/  (this repo — dotfiles + release tooling, not itself a package)
├─ package.json              ← private; scripts: verify, release, release:status, gallery, test
├─ README.md, LICENSE
├─ docs/publishing.md        ← release reference
├─ scripts/
│  ├─ verify-packages.mjs    ← pre-publish gate
│  ├─ release.mjs            ← version + changelog + publish + tag
│  ├─ status.mjs             ← read-only npm publish-state report
│  └─ check-gallery.mjs      ← pi.dev listing check
├─ .gitignore
└─ agent/
   ├─ settings.json / .example
   ├─ keybindings.json, plannotator.json, trust.json.example
   ├─ agents/planner.md, scout.md
   ├─ extensions/
   │  ├─ workflow/        (@dieulc/workflow)
   │  ├─ autocompact/     (@dieulc/autocompact)
   │  ├─ server-logs/     (@dieulc/server-logs)
   │  └─ browser-inspector/ (@dieulc/browser-inspector)
   ├─ npm/   ← generated (ignored except .gitignore)
   ├─ sessions/, checkpoints/ ← ignored
   └─ bin/fd.exe, rg.exe
```

## License

MIT — see [LICENSE](./LICENSE).
