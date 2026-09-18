# Publishing & Releasing

How the four `@dieulc/*` Pi extensions in this repo are verified and published to npm.

| Package | Directory | Published to |
| --- | --- | --- |
| `@dieulc/workflow` | `agent/extensions/workflow` | <https://www.npmjs.com/package/@dieulc/workflow> |
| `@dieulc/autocompact` | `agent/extensions/autocompact` | <https://www.npmjs.com/package/@dieulc/autocompact> |
| `@dieulc/server-logs` | `agent/extensions/server-logs` | <https://www.npmjs.com/package/@dieulc/server-logs> |
| `@dieulc/browser-inspector` | `agent/extensions/browser-inspector` | <https://www.npmjs.com/package/@dieulc/browser-inspector> |

Each package is published **independently**: its own version, its own tag (`@dieulc/workflow@0.2.0`), its own `CHANGELOG.md`. The repo root (`@dieulc/pi-workflow`) is `"private": true` and is **never published** — it is the dotfiles repo plus the release tooling.

> **Local releases, by design.** Publishing happens on this machine with `npm publish` under the logged-in `dieulc` account. That keeps the flow to one command, but it means npm **provenance attestations are not generated** (those require a CI/OIDC publisher). Everything else — semver bumps, per-package changelogs, version↔tag symmetry, idempotent publishing — already matches the shape a CI publisher needs, so trusted publishing can be added later without changing this workflow.

## Prerequisites

- Node ≥ 22.19 (Pi's own requirement; the scripts check the major version)
- npm CLI authenticated as `dieulc` — `npm whoami` must print `dieulc` **and** the credential must be able to write:
  either a **granular access token with "Bypass 2FA" enabled** (needed for the unattended
  `--yes` flow), or an interactive `npm login` session, where npm prompts for the OTP during
  `npm publish`. A granular token *without* Bypass 2FA authenticates fine but can never publish —
  npm does not fall back to an OTP prompt for token auth, so the publish fails with a 403 even in a
  terminal.
- A clean working tree on the release branch (`main`)
- `git`, with `origin` reaching `github.com/dieuluucanh/pi-workflow`

The scripts are dependency-free Node ESM and run from the repo root.

## Release a version

```bash
npm run release:status                # read-only: manifest versions vs the npm registry
npm run verify                        # optional: run the gate on all four packages
npm run release -- --dry-run          # plan only: versions, changelogs, tarballs
npm run release                       # interactive: pick packages, then bump types
npm run gallery                       # after publishing: are they listed on pi.dev?
```

Non-interactive:

```bash
# one package, minor bump, no prompts
npm run release -- --packages workflow --bump minor --yes

# several packages, same bump kind
npm run release -- --packages workflow,autocompact --bump patch --yes

# publish the versions currently in the manifests (first release, or resuming)
npm run release -- --packages workflow,autocompact --bump none --yes

# mix freely: already-published packages are skipped, the rest are published
npm run release -- --packages workflow,autocompact,server-logs,browser-inspector --bump none --yes
```

### What the script does

1. **Preflight** — Node major check; current branch must equal `--branch` (default `main`); working tree must be clean; `git fetch` and refuse to continue if the branch is behind `origin`; `npm whoami` must be `dieulc` (override with `--npm-user`; skipped in `--dry-run`).
2. **Resolve** — compute each selected package's next version from the bump kind, and query the registry (one `npm view <name>@<version> version` per package). A version that is already on npm is **skipped, never fatal**: the rest of the batch is still verified, published, tagged and pushed. See [Skipping already-published packages](#skipping-already-published-packages).
3. **Verify** — run `scripts/verify-packages.mjs` for the packages that are actually going to be published: manifest and `files[]` hygiene, peer/dependency import audit, `typecheck`, tests, `npm pack --dry-run` tarball assertions, and a load smoke test of every `pi.extensions` entry.
4. **Changelog** — for each package being published, collect commits since that package's previous tag (`git log --no-merges … -- <package dir>`), group them by conventional type, and prepend a `## [version] - YYYY-MM-DD` section to that package's `CHANGELOG.md`.
5. **Bump** — write the new version into the package's `package.json`.
6. **Commit** — one commit for the released packages: `chore(release): @dieulc/workflow@0.2.0, @dieulc/autocompact@0.1.1`.
7. **Publish** — `npm publish` in each package directory, in turn. Output is inherited so npm's 2FA/OTP prompt works. `publishConfig.access: "public"` in each manifest supplies public access for the scoped names.
8. **Tag** — annotated tag per package: `git tag -a @dieulc/workflow@0.2.0`.
9. **Push** — `git push origin <branch>` then `git push origin <tag> …`.

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
| `--continue` | resume: publish current manifest versions that are missing from the registry, then create missing tags and push. For the packages that are already published it is equivalent to `--bump none`. |
| `--no-push` | stop after tagging; prints the push commands |
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

Publishing is the only step that touches the network, and it runs before tagging/pushing. If it fails part-way (network drop, OTP timeout, permission error), the version bump and changelog commit are already in place, so resume with:

```bash
npm run release -- --continue
```

`--continue` uses the versions already written to the manifests, skips anything already on the registry, publishes the rest, then creates any missing tags and pushes. Running it again after a fully successful release is a no-op.

Other recovery notes:

- **Tag exists, version not published** — `--continue` publishes the manifest version (tag existence does not block it).
- **Publish succeeded, push failed** — rerun with `--continue`; the registry check skips the published versions and the tags get pushed.
- **You asked for no bump on a package that is already published** — that is not an error: the plan prints `skip (already on npm at <version> — no bump requested)`, the other packages are released normally, and the run exits 0. A tag that is missing for the already-published version is created and pushed in the same run.
- **Wrong version committed, nothing published yet** — fix the `package.json` version, `git commit --amend`, and rerun with `--bump none`.
- **Wrong version already published** — you cannot overwrite it. Bump again (`--bump patch`) and publish; then deprecate the bad version with `npm deprecate @dieulc/<pkg>@<version> "message"`.
- **An accidental version was published and you want it gone** — unpublishing is destructive, irreversible, and 2FA-gated: `npm unpublish <pkg>@<version>` is refused for bypass-2FA tokens ("Granular access tokens that bypass two-factor authentication may not perform this action"), so use the npm website (package → Settings → Unpublish) or an interactive `npm login` first. A published `name@version` can never be reused, and fully unpublishing a name blocks publishing new versions of it for 24 hours. Clean the repo side too: `git push origin :refs/tags/<tag>`, `git revert <release commit>`.
- **One package cannot be published (24h name block, transient 403, OTP timeout)** — the script still publishes the rest and tags/pushes those, then reports the failure at the end. Rerun `npm run release -- --continue` once the blocker is gone; it skips versions already on npm and tags what is missing.

## Manual fallback (single package)

The script is a convenience; the underlying commands remain valid. From the repo root:

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

Always run `npm run verify -- --packages <pkg>` first — it catches the mistakes that manual publishing would otherwise push to the registry.

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

Packages that carry the `pi-package` keyword are listed in the gallery at <https://pi.dev/packages> — see [Gallery listing (pi.dev)](#gallery-listing-pidev) for the crawl mechanics, the `npm run gallery` check, and what to do when a package does not show up.

## Gallery listing (pi.dev)

The gallery is a **crawl of the npm search index filtered by the `pi-package` keyword**. There is no
registration step, no submission form and no dashboard: publishing a package whose npm metadata
carries that keyword *is* the registration. All four packages ship `"keywords": ["pi-package", …]`,
`publishConfig.access: "public"` and a `pi` manifest, and `npm run verify` fails if any of those is
missing — so a release is gallery-eligible the moment `npm publish` succeeds.

Each card (<https://pi.dev/packages/@dieulc/workflow>) carries the author, downloads/month, age,
type badges (`extension`, `skill`), the `pi install npm:<name>` line, the README and the parsed `pi`
manifest. <https://pi.dev/packages?name=dieulc> filters by name, description or author; `?type=` and
`?sort=recent` narrow it further.

### Checking it

```bash
npm run gallery                       # all four packages, one shot
npm run gallery -- --packages workflow
npm run gallery -- --wait 900         # poll until listed (default: 30 s between attempts)
npm run gallery -- --json             # machine-readable
```

The check asks both sides — npm and pi.dev — so "not indexed yet" is never confused with "publish
failed":

| Status | Meaning |
| --- | --- |
| `ok` | on npm and listed, showing the version the manifest declares |
| `missing` | not on the npm registry — run the release |
| `pending` | on npm, pi.dev has not indexed it yet (the crawler is behind) |
| `stale` | listed, but the card still shows an older version |
| `ineligible` | manifest keywords lack `pi-package` — it can never be listed |
| `unreachable` | the pi.dev request failed (network blip); retried automatically |

The exit code is 0 only when every selected package is `ok`. `npm run release` calls the same check
in `--warn-only` mode after a successful publish, so a slow crawl never fails a release.

### When a package does not show up

Indexing lag is normal and highly variable — usually minutes, occasionally days:

- Wait, then `npm run gallery -- --wait 900`.
- If it is still missing after ~24 h, npm's search index has skipped it. That is a known upstream gap
  ([pi#7885](https://github.com/earendil-works/pi/issues/7885),
  [pi#6991](https://github.com/earendil-works/pi/issues/6991)) and it **only self-heals on a new
  publish** — bump a patch and publish again:

  ```bash
  npm run release -- --packages autocompact --bump patch --yes
  npm run gallery -- --packages autocompact --wait 900
  ```

  In pi#6991 the skipped package became visible ~2.5 h after exactly such a metadata-touch publish.
- Never try to re-publish an existing version to "refresh" it — npm rejects it. The version bump is
  what triggers re-indexing.

## Versioning policy

- **Independent versions** per package. Release only what changed.
- **Semver.** While a package is `0.x`, breaking changes bump the **minor** and features/fixes bump the **patch** (`0.1.0 → 0.2.0` for a break, `→ 0.1.1` for a fix). Reaching `1.0.0` is a deliberate decision per package.
- Changelog entries are generated from commit subjects. Conventional prefixes (`feat:`, `fix:`, `docs:` …) are grouped into sections; anything else lands under "Other changes". Use `type: message` in commits for a useful changelog.
- Tags are annotated and named `<npm name>@<version>` (e.g. `@dieulc/server-logs@0.3.0`).

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `must release from "main"` | You are on another branch. Release from `main`, or rehearse with `--branch dev`. |
| `working tree is not clean` | Commit or stash first. The release commit must capture exactly the released state. |
| `branch is N commit(s) behind origin/main` | `git pull` first. |
| `npm auth check failed` | `npm login` (the expected user is `dieulc`). |
| `<pkg>@<version> is already published — bump the version` | **Removed** — that message no longer aborts a batch. A version already on npm is skipped; see [Skipping already-published packages](#skipping-already-published-packages). |
| Plan line `skip (already on npm at <version> — no bump requested)` | Intended: that package needed no release. Nothing was published for it, the run exits 0, and a missing tag is repaired. Pass a bump to release it again. |
| Plan line `skip (<version> is already on npm — bump further)` + exit 1 | An explicit bump landed on a published version, so nothing was published for that package (the others were). The checkout is usually behind the registry: `git pull`, check `npm run release:status`, then bump further. |
| Plan line `blocked (registry query failed)` + exit 1 | The registry could not be queried (offline, mirror, rate limit, auth). Nothing was published for that package — deliberately: an unreadable state is never treated as “not published”. Re-run when it is reachable. |
| `--continue reached npm, not this script` (exit 2) | The flags were typed without `--`, so npm consumed them. Run `npm run release -- --continue`. |
| `verification failed` | Fix what `scripts/verify-packages.mjs` reports; nothing has been written yet. |
| `npm publish` returns 403 | Two different causes — read the message. *`403 Forbidden - PUT … you do not have permission`*: first publish of a scoped package must be public (handled by `publishConfig.access`) — check you are a member of the `@dieulc` scope. *`Two-factor authentication or granular access token with bypass 2fa enabled is required to publish packages`*: see the row below. |
| 403 `Two-factor authentication or granular access token with bypass 2fa enabled is required to publish packages` | The configured npm credential cannot write, and npm does **not** prompt for an OTP when a token is configured — so this fails even in an interactive terminal (observed with a read-only/without-bypass granular token in `~/.npmrc`). Fix: create a **Granular Access Token** with *Bypass 2FA* enabled (npmjs.com → Access Tokens → Generate New Token; give it read+write on `@dieulc` or all packages) and put it in `~/.npmrc`. Alternative: `npm logout` / remove the token, `npm login`, then publish interactively with `npm publish --otp=<code>` (npm also reads the code from `NPM_CONFIG_OTP`). After fixing the credential, resume with `npm run release -- --continue`. |
| 403 `… may not perform this action` when unpublishing or deprecating | Destructive registry actions require an interactive 2FA session; a bypass-2FA granular token is refused. Use the npm website or `npm login` interactively. |
| `npm publish` rejected right after an unpublish | npm blocks new versions of a fully unpublished package name for 24 hours. Wait, then `npm run release -- --continue`. |
| Run ends with `publish failed for <pkg>` | The other packages were published, tagged and pushed. Rerun `npm run release -- --continue` to finish the failed one. |
| npm asks for an OTP | Expected with 2FA; the publish step inherits the terminal, so type the code when prompted. |
| Extension does not load after install | `pi --verbose`; confirm the `pi.extensions` path is in the tarball (`npm pack --dry-run`). |
| Published, but the package is not on pi.dev | The gallery crawls npm's search index, and new packages can be skipped for hours — sometimes days. Re-check with `npm run gallery -- --wait 900`; still missing after ~24 h → publish a patch bump (a metadata touch forces re-indexing), see [Gallery listing (pi.dev)](#gallery-listing-pidev). |
| Gallery card shows an older version | npm's index has not picked up the new version yet; `npm run gallery` reports `stale`. Usually resolves within minutes. |
| `npm run gallery` reports `ineligible` | The manifest keywords lack `pi-package`. Add it (plus `publishConfig.access: "public"` and a `pi` manifest — `npm run verify` enforces all three) and release a new version. |
| `npm run release:status` reports every package as `never-published` | Expected before the first publish. Each package flips to `in-sync` once its release lands. |
| `npm run release:status` reports `local-ahead` | The manifest version is not on npm yet. Publish it: `npm run release -- --packages <pkg> --bump none --yes` publishes the current version as-is. |
| `npm run release:status -- --check` exits 2 | A registry query failed (offline, mirror, rate limit) — the state is unknown, not “in sync”. Re-run when reachable; check `npm config get registry` if it keeps failing. |

## Layout

```text
scripts/
├─ verify-packages.mjs    # pre-publish gate (also: npm run verify)
├─ release.mjs            # release tool (also: npm run release)
├─ status.mjs             # read-only publish-state report (also: npm run release:status)
├─ check-gallery.mjs      # pi.dev listing check (also: npm run gallery)
├─ check-gallery.test.mjs # gallery parser tests (also: npm test)
└─ status.test.mjs        # status report tests (also: npm test)
agent/extensions/<pkg>/
├─ package.json          # name, version, pi manifest, files[], publishConfig
├─ README.md             # npm + GitHub page
├─ LICENSE
├─ CHANGELOG.md          # created/updated by the release script
└─ <entry>.ts            # shipped as source — Pi loads TypeScript directly
```
