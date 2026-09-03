# pi-workflow — Portable Pi Dotfiles

Custom Pi extensions **workflow** + **autocompact**, sane defaults, and external packages — reproducible on any machine via `git clone` → `~/.pi` or `pi install`.

[![pi-package](https://img.shields.io/badge/pi--package-blue)](https://pi.dev/packages)

## What is included

| Path | Description |
| --- | --- |
| `agent/extensions/workflow/` | Plan↔Build mode, questionnaire (1–4 Qs, dedup), subagent `explore`, `workflow_todo`, `/rewind` shadow-checkpoint, Plannotator bridge |
| `agent/extensions/autocompact/` | Intelligent compaction: plan/todo-aware summary, 70% pre-warming, cheap model override, `/autocompact` |
| `agent/settings.json` | `packages: ["npm:pi-lens","npm:pi-web-access","npm:@plannotator/pi-extension"]`, theme, enabledModels |
| `agent/keybindings.json` | Disables `tui.input.tab` (autocomplete conflict) |
| `agent/plannotator.json` | `planning` phase tool gate + status label |
| `agent/agents/planner.md`, `scout.md` | Agent presets |
| `agent/extensions/*/package.json` | Publishable `pi-package` manifests (`@dieulc/workflow`, `@dieulc/autocompact`) |
| Root `package.json` `@dieulc/pi-workflow` | Wrapper that re-exports both extensions via `pi.extensions` |

External packages auto-install via `settings.json` `packages` on first trusted startup.

## Install

### Option A — Git clone (primary, dotfiles)

This repo **is** `~/.pi`. Clone it directly:

```bash
# fresh machine (no ~/.pi yet)
git clone https://github.com/dieuluucanh/pi-workflow ~/.pi

# if ~/.pi already exists, clone elsewhere and point env
git clone https://github.com/dieuluucanh/pi-workflow ~/pi-workflow
PI_CODING_AGENT_DIR=~/pi-workflow/agent pi
# or move: mv ~/.pi ~/.pi.bak && git clone ... ~/.pi
```

First `pi` run prompts to **trust** the project — approve. Missing `npm:` packages (`pi-lens` etc.) install automatically. Use `/reload` to hot-reload extensions.

Update dotfiles:

```bash
cd ~/.pi && git pull
pi update --extensions   # updates pi-lens etc.
```

### Option B — Pi package (npm / git)

No clone needed — `pi` fetches packages itself:

```bash
# via npm (once published)
pi install npm:@dieulc/workflow
pi install npm:@dieulc/autocompact
# or the wrapper that bundles both + dotfiles defaults
pi install npm:@dieulc/pi-workflow

# via git (works today, no npm publish needed)
pi install git:github.com/dieuluucanh/pi-workflow

# ad-hoc try without installing
pi -e npm:@dieulc/workflow
pi -e git:github.com/dieuluucanh/pi-workflow
```

Project-local (`-l`): `pi install -l npm:@dieulc/workflow` writes to `.pi/settings.json` for team sharing. `pi list` / `pi remove` / `pi update --extensions` manage packages.

> **Pick one** — don't both `git clone` to `~/.pi` *and* `pi install git:...` the same repo on the same machine (you'd get two copies: `~/.pi/agent/extensions` vs `~/.pi/agent/git/...`). They deduplicate by URL identity.

## Updating

- Dotfiles: `git pull` in `~/.pi`
- Packages: `pi update --extensions` (global), `pi update --all` (pi + packages + git refs), or pinned bump: `pi install npm:@dieulc/workflow@0.2.0`

## Developing extensions

```bash
cd ~/.pi
# typecheck
npx tsc --noEmit -p agent/extensions/workflow/tsconfig.json
npx tsc --noEmit -p agent/extensions/autocompact/tsconfig.json
# dry-run tarball contents
npm pack --dry-run                         # root wrapper
npm pack --dry-run -w agent/extensions/workflow 2>&1 | head -30
npm pack --dry-run --prefix agent/extensions/autocompact

# live reload
# edit agent/extensions/workflow/index.ts then in pi: /reload
```

Publish (maintainer):

```bash
npm login
npm publish --access public --prefix agent/extensions/workflow
npm publish --access public --prefix agent/extensions/autocompact
npm publish --access public   # root wrapper
git tag v0.1.0 && git push origin v0.1.0
```

## Secrets & machine-local files

These are **ignored** (never committed) and regenerated per machine:

- `agent/auth.json` — credentials (empty `{}` in repo, ignored)
- `agent/models-store.json` — model catalog cache (regenerated via `pi update --models`)
- `agent/trust.json` — saved trust decisions (created on trust prompt) — template at `agent/trust.json.example`
- `agent/sessions/`, `agent/checkpoints/`, `plans/`, `.pi/plans/`, `web-search-cache/`, `**/node_modules/`, `**/.cache/`, `nul`

Intentional config stays tracked: `agent/settings.json` (+ `settings.json.example`), `agent/keybindings.json`, `agent/plannotator.json`, `agent/agents/*.md`, `agent/extensions/**`.

If you fork, check `agent/settings.json` doesn't contain private `enabledModels` tokens you don't want public — `settings.json.example` is the safe template.

## Layout

```
~/.pi/  (this repo)
├─ package.json              ← wrapper @dieulc/pi-workflow (pi.extensions → agent/…)
├─ README.md
├─ .gitignore                ← ignores caches, sessions, auth, trust
└─ agent/
   ├─ settings.json / .example
   ├─ keybindings.json, plannotator.json, trust.json.example
   ├─ agents/planner.md, scout.md
   ├─ extensions/
   │  ├─ workflow/ (index.ts, utils.ts, checkpoint.ts, README.md, package.json @dieulc/workflow)
   │  └─ autocompact/ (extensions/autocompact.ts, prompts/, README.md, package.json @dieulc/autocompact)
   ├─ npm/   ← generated (ignored except .gitignore)
   ├─ sessions/, checkpoints/ ← ignored
   └─ bin/fd.exe, rg.exe
```

## License

MIT — see `LICENSE` if present (extensions inherit MIT).
