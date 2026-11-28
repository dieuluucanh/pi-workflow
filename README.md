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
| `agent/extensions/workflow/` | `@dieulc/workflow` | Plan↔Build mode, shared folder/read permissions, Review Mode, prompt refinement (`/prompt`, `/prompt-model`, one-shot composer control), questionnaire (1–4 Qs, dedup), subagent `explore`, pinned `workflow_todo` panel, `/rewind` shadow-checkpoint, Plannotator bridge with a native handoff fallback, experimental Orchestrator |
| `agent/extensions/autocompact/` | `@dieulc/autocompact` | Intelligent compaction: plan/todo-aware summary, 70% pre-warming, cheap model override, `/autocompact` |
| `agent/extensions/server-logs/` | `@dieulc/server-logs` | Docker + systemd log inspection tools (remote SSH or local) |
| `agent/extensions/browser-inspector/` | `@dieulc/browser-inspector` | Browser DevTools inspection via CDP: console, network, screenshots (fresh browser or real session) |
| `agent/settings.json` | — | Shared config: `packages`, theme, enabled models |
| `agent/keybindings.json` | — | Keeps `tui.input.tab` bound to Tab; workflow completes while a suggestion list is open and cycles modes otherwise |
| `agent/plannotator.json` | — | `planning` phase tool gate + status label |
| `agent/agents/planner.md`, `scout.md` | — | Agent presets |
| `scripts/` | — | `verify-packages.mjs` (pre-publish gate) + `release.mjs` (release tooling) |

External packages listed in `agent/settings.json` auto-install on first trusted startup.

### Orchestrator (experimental)

`@dieulc/workflow` also contains the opt-in Orchestrator dispatcher: the parent
reads the approved plan, binds one row per step with `orchestrator_start`
(including the declared repository roots), and dispatches one in-process Build
child per row with that row’s root as `cwd`. The child owns its TODO list and
verification; the parent trusts its report, marks the row done with
`workflow_todo` and dispatches the next. A blocked report wakes the parent to
inspect the report: in-scope work is retried with amended instructions; an
external policy/user blocker is disclosed, not retried. Verification is ordinary
bash whose real output is visible — there is no journal, frozen snapshot, diff
gate, repair round, final gate or `workflow_execution` tool. A reload restores
the current record without launching work; a running phase becomes
`interrupted`. Old frozen/journaled runs are not migrated.

Mode entry alone never launches work, existing Plan → Review → Build remains the
default. A managed child follows the normal Build commit policy and cannot
mark the parent's row accepted or bypass permission gates.
The dispatcher is **experimental**: real provider turns and visible-terminal
acceptance still need a human run (see
[`agent/extensions/workflow/README.md`](agent/extensions/workflow/README.md) and
the verification record in
[`docs/verification-2026-11-24-legacy-engine-deletion.md`](docs/verification-2026-11-24-legacy-engine-deletion.md)).

> This repo root is **not** a Pi package and is not published (`"private": true`). Install the extensions individually, or clone the repo for the dotfiles.

### Prompt refinement (`/prompt`)

`@dieulc/workflow` can rewrite a **drafted request** in an isolated child session
and hand the candidate back to the composer — it never sends or runs it. On
Terminal Pi, `/prompt <draft>` writes the editor (a path is literal text, not an
attachment). On Pi Desktop the extension publishes the additive
`composer-transform-v1` capability, so the same runtime is driven by a one-shot
composer control through a grant-only bootstrap and a private, single-use
handoff — never by slash concatenation. `/prompt-model` gives refinement an
independent model (trusted project → global → Default-mode inherit, with an
explicit inherit sentinel and per-scope reset) and never changes the main
session model, roles or profiles.

Refinement is bounded, policy-safe and recoverable: an initial read/trust/grant
ceiling is re-resolved before every inspection, provider request, question and
candidate delivery; narrowing invalidates the operation and disposes the child.
Revocation stops future disclosure — it cannot recall provider data already
sent. A conflict is never overwritten; the original draft stays recoverable.
Pi Desktop can bundle a pinned Workflow artifact with explicit
override/disable/safe-mode paths; Terminal Pi keeps loading from npm or a
checkout. The source tree targets Workflow **0.17.5** (published — npm
serves **0.17.5**) + Pi SDK **1.5.0**; semantic quality and live
desktop/Terminal acceptance still require human verification, not inference
from unit tests. Full detail: [`agent/extensions/workflow/README.md`](agent/extensions/workflow/README.md#prompt-refinement)
and the Pi Desktop
[`architecture/extension-ui.md`](https://github.com/dieuluucanh/pi-desktop/blob/main/docs/architecture/extension-ui.md)
composer-transform contract.

## Install

### A — The extensions (npm)

```bash
pi install npm:@dieulc/workflow
pi install npm:@dieulc/autocompact
pi install npm:@dieulc/server-logs
pi install npm:@dieulc/browser-inspector

# pinned, for reproducible installs (0.17.5 is the current published version)
pi install npm:@dieulc/workflow@0.17.5

# project-local (writes .pi/settings.json for team sharing)
pi install -l npm:@dieulc/workflow

# try without installing
pi -e npm:@dieulc/workflow
```

Manage them with `pi list`, `pi update --extensions`, `pi remove npm:@dieulc/workflow`.

> Folder checkpoints (`@dieulc/checkpoints`) moved to the Pi Desktop repository.
> Install it with `pi install npm:@dieulc/checkpoints`; it is not part of this
> dotfiles repo.

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

- Extensions: `pi update --extensions` (or `pi install npm:@dieulc/workflow@0.17.5` to pin — 0.17.5 is the current published version)
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

Releases are cut locally with one script, but **`npm publish` is gated on green CI for the exact release commit**. Versions are **independent per package**, git tags look like `@dieulc/workflow@0.2.0`, and each package keeps its own `CHANGELOG.md` generated from commits since its previous tag.

```bash
npm login                      # once per machine (npm user: dieulc)
export GH_TOKEN=…              # the CI gate reads check-runs via gh api
npm run release:status         # read-only: manifest versions vs the npm registry
npm run verify                 # gate: all four packages (includes the packed import closure)
npm run release -- --dry-run   # plan only: versions, changelogs, tarballs
npm run release                # interactive: pick packages + bump type

# non-interactive: publish the versions already in the manifests
npm run release -- --packages workflow --bump none --yes

# non-interactive: bump, then publish
npm run release -- --packages workflow,autocompact --bump minor --yes
```

Preflight is deliberately local. It checks the **workspace** — expected branch (default `main`), clean tree, untouched `agent/settings.json`, no divergence from `origin` — and the **version invariants** — top `CHANGELOG.md` heading equals the manifest version, and every published version has an annotated tag whose tagged `package.json` version matches — plus npm auth. It does not query CI, because the release commit does not exist yet.

Then, in this exact order, the script:

1. **verify** the packages being published (packed import closure + load smoke test of the packed file set);
2. write the version and prepend the changelog section — with `--bump none --yes` and the notes already committed, there is nothing new to write;
3. **commit** only `package.json`, `package-lock.json` and `CHANGELOG.md` — staging is explicit, `git add -A` is gone;
4. **push** the branch, so the release commit has a run;
5. **await CI** for that SHA — `verify (ubuntu-latest)` *and* `verify (windows-latest)` must both be `success`; pending, unknown (including a missing leg) and red all block;
6. only then **publish** each package, create an annotated tag per package, and **push the tags**.

Release from a **fresh worktree** and run `npm ci` there after the current `package-lock.json`: the script refuses a `node_modules` that predates the lockfile, because CI verifies a fresh install and a release must not pass on ambient dependencies.

- `--bump none` publishes the current version as-is (first publish, resuming, or a version whose curated changelog is already committed). `--continue` is the resume form: already-published versions and existing tags are skipped, and committed notes are preserved instead of regenerated.
- A package whose target version is already on npm is **skipped, never fatal** — the rest of the batch is still published, tagged and pushed, and a missing tag for an already-published version is repaired. Always pass flags after `--` (`npm run release -- --continue`).
- `--no-push` stops before the push, which also means CI cannot verify the commit: publishing then requires the bypass below.
- **CI red?** Do not publish and do not tag. Fix forward on the *same unpublished version* — nothing reached the registry, so the version is still free — push the fix, and re-run `npm run release -- --packages <pkg> --bump none --yes` once both matrix legs are green. Never bump to "get past" a red build, and never publish a version CI rejected.
- **Bypass:** only `RELEASE_SKIP_CI=1` in the environment *together with* `--yes` skips the gate, and the transcript then prints `CI gate bypassed by RELEASE_SKIP_CI`. There is no `--skip-ci`. Use it only for a genuine CI outage you have accepted by hand.
- The script ends at the pushed tags. It does **not** create a GitHub Release; that is an optional manual step (`gh release create`), never implied by a successful release.

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
│  ├─ release.mjs            ← version + changelog + CI-gated publish + tag
│  ├─ status.mjs             ← read-only npm publish-state report
│  └─ check-gallery.mjs      ← pi.dev gallery-catalog membership check
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
