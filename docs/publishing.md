# Publishing & Releasing

How the four `@dieulc/*` Pi extensions in this repo are verified and published to npm.

| Package | Directory | Published to |
| --- | --- | --- |
| `@dieulc/workflow` | `agent/extensions/workflow` | <https://www.npmjs.com/package/@dieulc/workflow> |
| `@dieulc/autocompact` | `agent/extensions/autocompact` | <https://www.npmjs.com/package/@dieulc/autocompact> |
| `@dieulc/server-logs` | `agent/extensions/server-logs` | <https://www.npmjs.com/package/@dieulc/server-logs> |
| `@dieulc/browser-inspector` | `agent/extensions/browser-inspector` | <https://www.npmjs.com/package/@dieulc/browser-inspector> |

> `@dieulc/checkpoints` moved to the Pi Desktop repository (`packages/checkpoints`);
> it is not released from this repo.

Each package is published **independently**: its own version, its own tag (`@dieulc/workflow@0.2.0`), its own `CHANGELOG.md`. The repo root (`@dieulc/pi-workflow`) is `"private": true` and is **never published** — it is the dotfiles repo plus the release tooling.

> **Local releases, by design.** Publishing happens on this machine with `npm publish` under the logged-in `dieulc` account. That keeps the flow to one command, but it means npm **provenance attestations are not generated** (those require a CI/OIDC publisher). Everything else — semver bumps, per-package changelogs, version↔tag symmetry, idempotent publishing — already matches the shape a CI publisher needs, so trusted publishing can be added later without changing this workflow.
>
> **Publishing is CI-gated.** "Local" does not mean unverified: the script pushes the release commit, waits for GitHub Actions' `verify` matrix (`ubuntu-latest` *and* `windows-latest`) to succeed for that exact SHA, and only then runs `npm publish`. See [The CI gate](#the-ci-gate).

## Prerequisites

- Node ≥ 22.19 (Pi's own requirement; the scripts check the major version)
- npm CLI authenticated as `dieulc` — `npm whoami` must print `dieulc` **and** the credential must be able to write:
  either a **granular access token with "Bypass 2FA" enabled** (needed for the unattended
  `--yes` flow), or an interactive `npm login` session, where npm prompts for the OTP during
  `npm publish`. A granular token *without* Bypass 2FA authenticates fine but can never publish —
  npm does not fall back to an OTP prompt for token auth, so the publish fails with a 403 even in a
  terminal.
- A clean working tree on the release branch (`main`), with no divergence from `origin`
- A fresh worktree whose `node_modules` was installed by `npm ci` *after* the current `package-lock.json` — the script refuses an ambient tree that predates the lockfile, because CI verifies a fresh install
- `git`, with `origin` reaching `github.com/dieuluucanh/pi-workflow`
- `gh` on `PATH` plus `GH_TOKEN` or `GITHUB_TOKEN` in the environment: the CI gate reads `gh api repos/dieuluucanh/pi-workflow/commits/<sha>/check-runs`. A missing `gh`, missing token, auth failure, no check runs, or a polling timeout all **fail closed** — nothing is published

The scripts are dependency-free Node ESM and run from the repo root.

## Release a version

Release from a **fresh worktree** whose dependencies came from `npm ci`, so the commit CI verifies is the commit that was tested against a clean install:

```bash
git worktree add ../pi-release main && cd ../pi-release
(cd agent/extensions/workflow && npm ci)   # repeat for each package you release
```

Then:

```bash
npm run release:status                # read-only: manifest versions vs the npm registry
npm run verify                        # optional: run the gate on all four packages
npm run release -- --dry-run          # plan only: versions, changelogs, tarballs
npm run release                       # interactive: pick packages, then bump types
npm run gallery                       # after publishing: are they in the pi.dev gallery catalog?
```

Non-interactive:

```bash
# one package, minor bump, no prompts
npm run release -- --packages workflow --bump minor --yes

# several packages, same bump kind
npm run release -- --packages workflow,autocompact --bump patch --yes

# publish the versions currently in the manifests (first release, or resuming)
npm run release -- --packages workflow,autocompact --bump none --yes

# version + curated changelog already committed: nothing new is written,
# CI is keyed on the current HEAD
npm run release -- --packages workflow --bump none --yes
npm run release -- --packages workflow --continue

# mix freely: already-published packages are skipped, the rest are published
npm run release -- --packages workflow,autocompact,server-logs,browser-inspector --bump none --yes
```

### What the script does

The order is strict: everything that publishes or tags is gated on green CI for the pushed release commit.

1. **Preflight (local)** — Node major check; current branch must equal `--branch` (default `main`); working tree must be clean; `agent/settings.json` must be unmodified; `git fetch` and refuse to continue when local and `origin/<branch>` diverge in either direction; `npm whoami` must be `dieulc` (override with `--npm-user`; skipped in `--dry-run`). CI is deliberately **not** queried here: the release commit does not exist (or is not pushed) yet.
2. **Version invariants** — for each selected package, the top `## [x.y.z]` `CHANGELOG.md` heading must equal the manifest version, and every version already on the registry must have an annotated tag `@dieulc/<pkg>@<version>` whose tagged `package.json` version matches. A frozen, timestamp-bounded historical-gap allowlist covers genuine pre-gate gaps only; anything published now can never enter it.
3. **Fresh dependencies** — `node_modules` must have been installed after `package-lock.json`; a stale ambient tree blocks the release.
4. **Resolve** — compute each selected package's next version from the bump kind, and query the registry (one `npm view <name>@<version> version` per package). A version that is already on npm is **skipped, never fatal**: the rest of the batch is still verified, published, tagged and pushed. See [Skipping already-published packages](#skipping-already-published-packages).
5. **Verify** — run `scripts/verify-packages.mjs` for the packages that are actually going to be published: manifest and `files[]` hygiene, peer/dependency import audit, `typecheck`, tests, `npm pack --dry-run` tarball assertions, the packed import closure (every relative import of every packed file must resolve inside the tarball), and a load smoke test of every `pi.extensions` entry from a materialized copy of the packed file set.
6. **Version + changelog** — write the new version into the package's `package.json`; for each package being published, collect commits since that package's previous tag (`git log --no-merges … -- <package dir>`), group them by conventional type, and prepend a `## [version] - YYYY-MM-DD` section to that package's `CHANGELOG.md`. With `--bump none` and the notes already committed there is nothing new to write, so CI is keyed on the current `HEAD`.
7. **Commit** — one commit for the released packages: `chore(release): @dieulc/workflow@0.2.0, @dieulc/autocompact@0.1.1`. Staging is **explicit**: only `package.json`, `package-lock.json` and `CHANGELOG.md`; `git add -A` is gone, so machine-local files cannot be swept in.
8. **Push** — `git push origin <branch>`, so the exact release commit has a run.
9. **Await CI** — poll the `verify` matrix for that SHA until `verify (ubuntu-latest)` **and** `verify (windows-latest)` are both `success`. Pending, unknown (a missing leg, no checks, missing `gh`/token, a timeout) and red all block.
10. **Publish** — `npm publish` in each package directory, in turn — with green CI only. Output is inherited so npm's 2FA/OTP prompt works. `publishConfig.access: "public"` in each manifest supplies public access for the scoped names.
11. **Tag** — annotated tag per package: `git tag -a @dieulc/workflow@0.2.0`. CI-gated.
12. **Push tags** — `git push origin <tag> …`. CI-gated.

The script ends here. It does **not** create a GitHub Release; a successful run leaves only the pushed branch and annotated git tags. Creating a GitHub Release is an **optional, separate manual choice**:

```bash
gh release create "@dieulc/workflow@0.2.0" \
  --title "@dieulc/workflow@0.2.0" --notes-from-tag
```

Nothing in `scripts/release.mjs` depends on a GitHub Release existing, and a release is complete without one.

### The CI gate

Green means exactly one thing: the check runs for the release SHA include both `verify (ubuntu-latest)` and `verify (windows-latest)` with conclusion `success`. Everything else is blocked:

| CI state | Detail | Result |
| --- | --- | --- |
| `green` | both matrix legs `success` on the release SHA | publish → tag → push tags proceed |
| `pending` | a leg is queued or in progress | polled (20 s interval, 20 min deadline), then blocked |
| `unknown` | a leg is missing, no checks reported, `gh`/token/auth problem, or a timeout | blocked — never read as “probably fine” |
| `red` | any leg `failure`/`cancelled`/`timed_out`/…, or `neutral`/`skipped` | blocked |

A missing leg is `unknown`, not green. Runs for another SHA, another workflow or another app are ignored.

**Red CI is not a reason to publish anyway.** Nothing reached the registry, so the version is still unpublished and free to reuse: fix the failure, push the fix, and re-run `npm run release -- --packages <pkg> --bump none --yes` on the **same** version once the matrix is green. Do not bump to escape a red build.

The only bypass is an environment decision — `RELEASE_SKIP_CI=1` together with `--yes` — and the transcript then prints `CI gate bypassed by RELEASE_SKIP_CI`. There is no `--skip-ci`, `RELEASE_SKIP_CI=1` without `--yes` is refused, and any value other than `1` is ignored.

### The pack gate

`npm run verify` checks the **packed artifact**, not the source tree. For each package it:

- runs `npm pack --dry-run --json` to get the exact file list npm would publish;
- resolves every relative import, re-export and dynamic import in every packed `.ts` file
  against that list — a module that is imported but omitted from `files[]` fails with
  `tarball is missing ./X.ts (imported by Y.ts)`;
- materializes exactly that file set in a temp directory and imports every `pi.extensions`
  entry, so a missing module fails before publish.

`prepublishOnly` runs the same check with `--pack-only` on every `npm publish`, including
manual publishes that bypass `scripts/release.mjs`. `npm run verify -- --pack-only` is the
fast local form; `npm run verify` additionally runs the peer/dependency audit, `typecheck`
and the package tests.

### Skipping already-published packages

A batch is not all-or-nothing. Each selected package is classified against the registry *after* the
bump is resolved, and the plan prints what will happen to it:

| Target version | Outcome | What happens | Exit code |
| --- | --- | --- | --- |
| not on npm | `publish` | verified, changelogged, `npm publish`, tagged, pushed | 0 |
| on npm, no bump requested (`none`) | `skip` | nothing is published; a tag that is missing for that version is still created and pushed | 0 |
| on npm, explicit `patch`/`minor`/`major` collides | `skip` | that package is left alone (the checkout is probably behind the registry) — the others still run | 1 at the end |
| registry unreachable | `blocked` | nothing is published for it: a failed lookup is never read as “not published” — the others still run | 1 at the end |

Only the `publish` targets are verified, changelogged and committed, so a skipped package's files are
never touched and one unrelated failure can never block the rest of the batch. Every skip is printed
with its reason; `npm run release:status` stays the read-only way to inspect drift.

### Flags

| Flag | Meaning |
| --- | --- |
| `--packages a,b` | packages to release (short directory names). Default: interactive picker |
| `--bump kind` | `patch` \| `minor` \| `major` \| `none`. Default: interactive, per package |
| `--dry-run` | run preflight + verify and print versions/changelogs/tags; writes, publishes and tags nothing |
| `--continue` | resume: publish current manifest versions that are missing from the registry, then create missing tags and push. For already-published packages it is equivalent to `--bump none`. CI is still required before publish/tag/push-tags. |
| `--no-push` | stop after committing; publishing/tagging then needs `RELEASE_SKIP_CI=1`, because CI cannot verify an unpushed commit |
| `RELEASE_SKIP_CI=1` | **environment variable, not a flag**: with `--yes`, skips the CI gate and prints `CI gate bypassed by RELEASE_SKIP_CI`. `--skip-ci` is rejected, and `RELEASE_SKIP_CI=1` without `--yes` is refused. |
| `--branch name` | branch to release from (default `main`) |
| `--npm-user name` | required npm user (default `dieulc`, or `RELEASE_NPM_USER`) |
| `--yes`, `-y` | non-interactive; requires `--packages` and `--bump` (not needed with `--continue`) |
| `--` | **required before the script's flags**: `npm run release -- --continue`. npm parses everything before `--` itself, so `npm run release --continue` reaches npm, not the script. The script detects the swallowed flags (`npm_config_*`) and exits 2 with the corrected command instead of silently running in interactive mode. |

## Publish status

`npm run release:status` (`scripts/status.mjs`) is a **read-only** report: it never writes,
publishes, tags, or prompts. For every package it compares the manifest version with the
registry — `latest` dist-tag, all dist-tags, publish date, deprecation flags — and prints a
drift verdict.

```bash
npm run release:status                        # human table
npm run release:status -- --json              # machine-readable report
npm run release:status -- --check             # exit 1 on problems, 2 if a query failed
npm run release:status -- --packages workflow
```

| Verdict | Meaning |
| --- | --- |
| `in-sync` | the manifest version is published and is the `latest` dist-tag |
| `never-published` | nothing of the package is on the registry |
| `local-ahead` | the manifest version is newer than `latest` and not published yet |
| `local-behind` | the registry has a newer version than this checkout |
| `published-not-latest` | the manifest version is on npm but is not the `latest` dist-tag |
| `local-not-published` | the manifest version is missing and cannot be compared to `latest` |
| `invalid-version` | the manifest version is not semver |
| `registry-error` | the registry could not be queried (offline, mirror, rate limit) |

- **Exit codes:** `0` by default (informational). With `--check`: `1` when any package is
  never-published, drifts, or has a deprecated current version; `2` when a registry query
  failed — an unknown state never passes a gate silently. Use it in a pre-push hook or before
  a release when you want failure semantics.
- **Fresh repo:** before the first publish every package reports `never-published`, so
  `--check` exits 1 until a release lands. That is the intended meaning (“not released yet”),
  not a bug.
- The registry comes from `npm config get registry` (override with `--registry <url>` for
diagnostics against a mirror). Queries are one packument request per package, in parallel,
with an `npm view --json` fallback that honors `~/.npmrc` auth. Deprecated *older* versions and
a prerelease `latest` are reported as notes, never as failures.
- `--json` emits a versioned schema (`schemaVersion: 1`) with `registry`, `identity`,
per-package `distTags` / `publishedAt` / `problems` / `notes`, and an overall `ok`.

## First publish (bootstrap)

The packages ship with version `0.1.0`. For the initial publish use `--bump none` so the current version is published as-is:

```bash
git switch main && git pull
npm login                 # once per machine
npm whoami                # dieulc
npm run release -- --packages workflow,autocompact,server-logs,browser-inspector --bump none --yes
```

The same command is the recovery path for a partially published batch: the packages that are already
on npm are reported as `skip`, and only the missing ones are published — which is also how a missing
tag for an already-published version gets repaired.

Afterwards, each day-to-day release should bump a version; because Pi compares the installed version against npm's latest, **a change without a version bump never reaches users** (`pi update --extensions` would skip it).

## Recovering from an interrupted release

The order is push → await CI → publish → tag → push tags. The release commit is pushed and CI-verified before publishing starts, so an interrupted run resumes without redoing either:

```bash
npm run release -- --continue
```

`--continue` uses the versions already written to the manifests, skips anything already on the registry, publishes the rest, then creates any missing tags and pushes — after re-checking CI for the release SHA. Running it again after a fully successful release is a no-op.

Other recovery notes:

- **CI red before publish** — nothing was published and no tag was created. Fix the failure, push it, and re-run with `--bump none` on the same unpublished version. No version bump is needed (and none will publish past the gate).

- **Tag exists, version not published** — `--continue` publishes the manifest version (tag existence does not block it).
- **Publish succeeded, push failed** — rerun with `--continue`; the registry check skips the published versions and the tags get pushed.
- **You asked for no bump on a package that is already published** — that is not an error: the plan prints `skip (already on npm at <version> — no bump requested)`, the other packages are released normally, and the run exits 0. A tag that is missing for the already-published version is created and pushed in the same run.
- **Wrong version committed, nothing published yet** — fix the `package.json` version, `git commit --amend`, and rerun with `--bump none`.
- **Wrong version already published** — you cannot overwrite it. Bump again (`--bump patch`) and publish; then deprecate the bad version with `npm deprecate @dieulc/<pkg>@<version> "message"`.
- **An accidental version was published and you want it gone** — unpublishing is destructive, irreversible, and 2FA-gated: `npm unpublish <pkg>@<version>` is refused for bypass-2FA tokens ("Granular access tokens that bypass two-factor authentication may not perform this action"), so use the npm website (package → Settings → Unpublish) or an interactive `npm login` first. A published `name@version` can never be reused, and fully unpublishing a name blocks publishing new versions of it for 24 hours. Clean the repo side too: `git push origin :refs/tags/<tag>`, `git revert <release commit>`.
- **One package cannot be published (24h name block, transient 403, OTP timeout)** — the script still publishes the rest and tags/pushes those, then reports the failure at the end. Rerun `npm run release -- --continue` once the blocker is gone; it skips versions already on npm and tags what is missing.

## Manual fallback (single package)

The script is a convenience; the underlying commands remain valid. From the repo root — note that this manual path bypasses the CI gate, so it is the escape hatch, not the normal flow:

```bash
cd agent/extensions/workflow
npm pack --dry-run          # inspect the tarball first
npm publish                 # publishConfig.access handles public access
# with 2FA and no bypass-2FA token:
npm publish --otp=123456
cd ../../..
git tag -a "@dieulc/workflow@0.2.0" -m "@dieulc/workflow@0.2.0"
git push origin main && git push origin "@dieulc/workflow@0.2.0"
```

Always run `npm run verify -- --packages <pkg>` first — it catches the mistakes that manual publishing would otherwise push to the registry. `prepublishOnly` also re-runs the pack gate on `npm publish`, so a manual publish cannot ship a tarball whose imported modules are missing.

## Verifying an install

```bash
npm view @dieulc/workflow version
pi -e npm:@dieulc/workflow          # isolated load test
pi install npm:@dieulc/workflow     # real install
pi list
```

To test without disturbing your own Pi config, point the config dir at a scratch location:

```bash
PI_CODING_AGENT_DIR=/tmp/pi-verify pi -e npm:@dieulc/workflow
```

Packages that carry the `pi-package` keyword are *eligible* for the gallery at <https://pi.dev/packages>, but pi.dev ingests only a bounded, popularity-ranked slice of them — see [gallery-membership.md](gallery-membership.md) for the crawl mechanics, the measured evidence, and what to do when a package does not show up.

## Gallery listing (pi.dev)

The gallery is **not a registry you publish into**. pi.dev builds its catalog from npm's search
results for the `pi-package` keyword and ingests only a bounded, popularity-ranked slice of them, so a
successful publish makes a package **eligible, not catalogued**. The mechanics, the measured evidence,
the hypotheses that have been ruled out and the escalation path live in
[gallery-membership.md](gallery-membership.md); two facts matter for day-to-day releases:

- **A gallery row is best-effort.** Nothing in `package.json` puts a package in, and a republish only
  helps when it happens to refresh the package's npm search-index record — sometimes it does,
  sometimes it does not.
- **Absence is common.** When measured on 2026-09-20 the catalog held 5,374 rows against 10,255 npm
  `keywords:pi-package` matches, so roughly 4,900 eligible packages had no catalog row at all.

Every catalog card carries the author, downloads/month, age, type badges (`extension`, `skill`), the
`pi install npm:<name>` line, the README and the parsed `pi` manifest. <https://pi.dev/packages?name=dieulc>
filters by name, description or author; `?type=` and `?sort=recent` narrow it further. The filter does
**not** match the `@scope/name` form — search the scope or the unscoped basename instead.

### Checking it

```bash
npm run gallery                       # all four packages, one shot
npm run gallery -- --packages workflow
npm run gallery -- --wait 900         # keep polling (default: 30 s between attempts)
npm run gallery -- --diagnose         # explain a verdict: index figures, catalog row, cut-off
npm run gallery -- --json             # machine-readable
```

The check reads **both** pi.dev signals — whether the catalog listing (`?name=…`) has an exact-name
card, and what the detail page's `Downloads` row says — and only reports a package as `not-indexed`
when they agree that there is no catalog row. A disagreement, or a page it cannot read, is reported
as `unreachable` rather than as a confident miss:

| Status | Meaning |
| --- | --- |
| `ok` | on npm and in the gallery catalog, showing the version the manifest declares |
| `missing` | not on the npm registry — run the release |
| `not-indexed` | published and installable, but pi.dev has no catalog row (the listing has no card and the detail page shows `Downloads: not available`) — the bounded, popularity-ranked crawl has not picked it up |
| `stale` | in the catalog, but the card still shows an older version |
| `ineligible` | manifest keywords lack `pi-package` — it can never be catalogued |
| `unreachable` | pi.dev could not be read unambiguously (request failed, markup drift, or the two signals disagree); retried automatically |

The exit code is 0 only when every selected package is `ok`. `npm run release` calls the same check
in `--warn-only` mode after a successful publish, so a package missing from the catalog never fails a
release.

### When a package does not show up

`not-indexed` is not a lag you can wait out — the catalog only ingests packages that rank inside the
reachable slice. In order:

1. **Confirm the state and the reason.**

   ```bash
   npm run gallery -- --packages workflow --diagnose
   ```

   That prints the package's npm search-index figure and search score, whether the catalog listing has
   a row, the figure pi.dev stored, and a verdict: `no row (below window)` (its index figure is under
   the measured cut-off, so the bounded crawl cannot reach it) or `no row (unknown)` (the cut-off does
   **not** explain it). It also prints the by-hand URL to re-check.
2. **Never republish solely to force a listing.** A version bump only refreshes the package's
   search-index record; that is a measured attempt, not a fix, and repeated no-op releases burn
   versions and tags for nothing. Ship a real release, then re-measure with `--diagnose`.
3. **Escalate to pi.dev when the diagnosis says `no row` — especially `no row (unknown)`.** Every
   catalog card links a prefilled **report** action (`package-report.yml`): that is the official channel
   for “this package is missing”, and an ingest gap is not something this repo can fix.
   [gallery-membership.md](gallery-membership.md) lists the evidence to include and the upstream issues
   already on file.
4. **Real downloads are hygiene, not a proven cure.** Ranking is popularity-led, but the catalog
   already contains packages with *less* npm traction than ones it skips, so traction cannot be shown
   to be why a specific package is missing. Promote honestly — self-download loops and CI fetch farms
   violate npm's terms and misrepresent the package's adoption.

`npm publish` never overwrites an existing version, so “refreshing” always means a new version —
which is exactly what step 2 cautions against doing for its own sake.

## Versioning policy

- **Independent versions** per package. Release only what changed.
- **Semver.** While a package is `0.x`, breaking changes bump the **minor** and features/fixes bump the **patch** (`0.1.0 → 0.2.0` for a break, `→ 0.1.1` for a fix). Reaching `1.0.0` is a deliberate decision per package.
- Changelog entries are generated from commit subjects. Conventional prefixes (`feat:`, `fix:`, `docs:` …) are grouped into sections; anything else lands under "Other changes". Use `type: message` in commits for a useful changelog.
- Tags are annotated and named `<npm name>@<version>` (e.g. `@dieulc/server-logs@0.3.0`).

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `must release from "main"` | You are on another branch. Release from `main`, or rehearse with `--branch dev`. |
| `release preflight blocked: worktree is not clean` | Commit or stash first. The release commit must capture exactly the released state. |
| `release preflight blocked: agent/settings.json has uncommitted changes` | It is machine-local and never staged; revert or stash it. |
| `local is behind origin by N commit(s)` / `origin is behind local by N commit(s)` | `git pull` (or push) so the branch is not diverged in either direction. |
| `release dependencies are stale … Use a fresh worktree and npm ci` | `node_modules` predates `package-lock.json`. Run `npm ci` in that package (a fresh worktree is best) and retry; CI verifies a fresh install, so the release must too. |
| `npm auth check failed` | `npm login` (the expected user is `dieulc`). |
| `CI state unknown: missing verify (windows-latest)` | A matrix leg has no check run for the SHA (still queued, a different SHA, or a different app). Wait for CI or re-run the workflow; unknown is never treated as green. |
| `CI red: verify (ubuntu-latest) failure` / `release blocked at phase "publish"` | A leg failed for the release SHA. Nothing was published or tagged. Fix it, push, and re-run with `--bump none` on the same unpublished version. |
| `GH_TOKEN or GITHUB_TOKEN is required to query check-runs` / `gh CLI not found on PATH` | Export a token `gh` can use and install `gh`. The gate fails closed, so nothing was published. |
| `--skip-ci is not supported` | The CI bypass is an environment decision: `RELEASE_SKIP_CI=1` with `--yes`. |
| `RELEASE_SKIP_CI=1 requires --yes` | Attach the bypass only to an explicit unattended run; it never applies silently. |
| `<pkg>@<version> is already published — bump the version` | **Removed** — that message no longer aborts a batch. A version already on npm is skipped; see [Skipping already-published packages](#skipping-already-published-packages). |
| Plan line `skip (already on npm at <version> — no bump requested)` | Intended: that package needed no release. Nothing was published for it, the run exits 0, and a missing tag is repaired. Pass a bump to release it again. |
| Plan line `skip (<version> is already on npm — bump further)` + exit 1 | An explicit bump landed on a published version, so nothing was published for that package (the others were). The checkout is usually behind the registry: `git pull`, check `npm run release:status`, then bump further. |
| Plan line `blocked (registry query failed)` + exit 1 | The registry could not be queried (offline, mirror, rate limit, auth). Nothing was published for that package — deliberately: an unreadable state is never treated as “not published”. Re-run when it is reachable. |
| `--continue reached npm, not this script` (exit 2) | The flags were typed without `--`, so npm consumed them. Run `npm run release -- --continue`. |
| `verification failed` | Fix what `scripts/verify-packages.mjs` reports; nothing has been written yet. |
| `tarball is missing ./<module>.ts (imported by <file>.ts)` | A file imported by the package is not in `files[]`. Add it to the package manifest (or the directory that contains it) and re-run the gate. This is the failure mode that shipped `@dieulc/workflow@0.9.0` without `thinking-levels.ts` and `workflow-status.ts`. |
| `npm publish` returns 403 | Two different causes — read the message. *`403 Forbidden - PUT … you do not have permission`*: first publish of a scoped package must be public (handled by `publishConfig.access`) — check you are a member of the `@dieulc` scope. *`Two-factor authentication or granular access token with bypass 2fa enabled is required to publish packages`*: see the row below. |
| 403 `Two-factor authentication or granular access token with bypass 2fa enabled is required to publish packages` | The configured npm credential cannot write, and npm does **not** prompt for an OTP when a token is configured — so this fails even in an interactive terminal (observed with a read-only/without-bypass granular token in `~/.npmrc`). Fix: create a **Granular Access Token** with *Bypass 2FA* enabled (npmjs.com → Access Tokens → Generate New Token; give it read+write on `@dieulc` or all packages) and put it in `~/.npmrc`. Alternative: `npm logout` / remove the token, `npm login`, then publish interactively with `npm publish --otp=<code>` (npm also reads the code from `NPM_CONFIG_OTP`). After fixing the credential, resume with `npm run release -- --continue`. |
| 403 `… may not perform this action` when unpublishing or deprecating | Destructive registry actions require an interactive 2FA session; a bypass-2FA granular token is refused. Use the npm website or `npm login` interactively. |
| `npm publish` rejected right after an unpublish | npm blocks new versions of a fully unpublished package name for 24 hours. Wait, then `npm run release -- --continue`. |
| Run ends with `publish failed for <pkg>` | The other packages were published, tagged and pushed. Rerun `npm run release -- --continue` to finish the failed one. |
| npm asks for an OTP | Expected with 2FA; the publish step inherits the terminal, so type the code when prompted. |
| Extension does not load after install | `pi --verbose`; confirm the `pi.extensions` path is in the tarball (`npm pack --dry-run`). |
| Published, but the package is not in the gallery | The catalog ingests only a bounded, score-ranked slice of npm's `pi-package` search results, so an installable package can stay uncatalogued. `npm run gallery` reports `not-indexed` for it; follow [When a package does not show up](#when-a-package-does-not-show-up) (diagnose or escalate; never republish solely to force a listing). |
| Gallery card shows an older version | The catalog snapshot has not picked up the new version yet; `npm run gallery` reports `stale`. Usually resolves within minutes. |
| `npm run gallery` reports `ineligible` | The manifest keywords lack `pi-package`. Add it (plus `publishConfig.access: "public"` and a `pi` manifest — `npm run verify` enforces all three) and release a new version. |
| `npm run release:status` reports every package as `never-published` | Expected before the first publish. Each package flips to `in-sync` once its release lands. |
| `npm run release:status` reports `local-ahead` | The manifest version is not on npm yet. Publish it: `npm run release -- --packages <pkg> --bump none --yes` publishes the current version as-is. |
| `npm run release:status -- --check` exits 2 | A registry query failed (offline, mirror, rate limit) — the state is unknown, not “in sync”. Re-run when reachable; check `npm config get registry` if it keeps failing. |

## Layout

```text
scripts/
├─ verify-packages.mjs    # pre-publish gate (also: npm run verify)
├─ release.mjs            # release tool (also: npm run release)
├─ release-gate.mjs       # pure CI/workspace/version/tag gate used by release.mjs
├─ status.mjs             # read-only publish-state report (also: npm run release:status)
├─ check-gallery.mjs      # pi.dev gallery catalog membership check (also: npm run gallery)
├─ check-gallery.test.mjs # gallery parser tests (also: npm test)
├─ release.test.mjs       # release-order/gate wiring tests (also: npm test)
├─ release-gate.test.mjs  # CI classification, invariants, phase-order tests (also: npm test)
└─ status.test.mjs        # status report tests (also: npm test)
agent/extensions/<pkg>/
├─ package.json          # name, version, pi manifest, files[], publishConfig
├─ README.md             # npm + GitHub page
├─ LICENSE
├─ CHANGELOG.md          # created/updated by the release script
└─ <entry>.ts            # shipped as source — Pi loads TypeScript directly
```
