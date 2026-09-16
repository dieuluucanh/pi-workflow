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
- npm CLI logged in as `dieulc` — verify with `npm whoami`
- A clean working tree on the release branch (`main`)
- `git`, with `origin` reaching `github.com/dieuluucanh/pi-workflow`

The scripts are dependency-free Node ESM and run from the repo root.

## Release a version

```bash
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
```

### What the script does

1. **Preflight** — Node major check; current branch must equal `--branch` (default `main`); working tree must be clean; `git fetch` and refuse to continue if the branch is behind `origin`; `npm whoami` must be `dieulc` (override with `--npm-user`; skipped in `--dry-run`).
2. **Resolve** — compute each selected package's next version from the bump kind, and query the registry. If `name@version` is already published the release aborts (so you cannot accidentally re-publish).
3. **Verify** — run `scripts/verify-packages.mjs` for the selection: manifest and `files[]` hygiene, peer/dependency import audit, `typecheck`, tests, `npm pack --dry-run` tarball assertions, and a load smoke test of every `pi.extensions` entry.
4. **Changelog** — for each package, collect commits since that package's previous tag (`git log --no-merges … -- <package dir>`), group them by conventional type, and prepend a `## [version] - YYYY-MM-DD` section to that package's `CHANGELOG.md`.
5. **Bump** — write the new version into the package's `package.json`.
6. **Commit** — one commit: `chore(release): @dieulc/workflow@0.2.0, @dieulc/autocompact@0.1.1`.
7. **Publish** — `npm publish` in each package directory, in turn. Output is inherited so npm's 2FA/OTP prompt works. `publishConfig.access: "public"` in each manifest supplies public access for the scoped names.
8. **Tag** — annotated tag per package: `git tag -a @dieulc/workflow@0.2.0`.
9. **Push** — `git push origin <branch>` then `git push origin <tag> …`.

### Flags

| Flag | Meaning |
| --- | --- |
| `--packages a,b` | packages to release (short directory names). Default: interactive picker |
| `--bump kind` | `patch` \| `minor` \| `major` \| `none`. Default: interactive, per package |
| `--dry-run` | run preflight + verify and print versions/changelogs/tags; writes, publishes and tags nothing |
| `--continue` | resume: publish current manifest versions that are missing from the registry, then create missing tags and push |
| `--no-push` | stop after tagging; prints the push commands |
| `--branch name` | branch to release from (default `main`) |
| `--npm-user name` | required npm user (default `dieulc`, or `RELEASE_NPM_USER`) |
| `--yes`, `-y` | non-interactive; requires `--packages` and `--bump` (not needed with `--continue`) |

## First publish (bootstrap)

The packages ship with version `0.1.0`. For the initial publish use `--bump none` so the current version is published as-is:

```bash
git switch main && git pull
npm login                 # once per machine
npm whoami                # dieulc
npm run release -- --packages workflow,autocompact,server-logs,browser-inspector --bump none --yes
```

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
| `<pkg>@<version> is already published` | The registry already has that version; choose a bump or use `--continue`. |
| `verification failed` | Fix what `scripts/verify-packages.mjs` reports; nothing has been written yet. |
| `npm publish` returns 403 | First publish of a scoped package must be public — handled by `publishConfig.access`; check you are logged in as a member of the `@dieulc` scope. |
| 403 `… may not perform this action` when unpublishing or deprecating | Destructive registry actions require an interactive 2FA session; a bypass-2FA granular token is refused. Use the npm website or `npm login` interactively. |
| `npm publish` rejected right after an unpublish | npm blocks new versions of a fully unpublished package name for 24 hours. Wait, then `npm run release -- --continue`. |
| Run ends with `publish failed for <pkg>` | The other packages were published, tagged and pushed. Rerun `npm run release -- --continue` to finish the failed one. |
| npm asks for an OTP | Expected with 2FA; the publish step inherits the terminal, so type the code when prompted. |
| Extension does not load after install | `pi --verbose`; confirm the `pi.extensions` path is in the tarball (`npm pack --dry-run`). |
| Published, but the package is not on pi.dev | The gallery crawls npm's search index, and new packages can be skipped for hours — sometimes days. Re-check with `npm run gallery -- --wait 900`; still missing after ~24 h → publish a patch bump (a metadata touch forces re-indexing), see [Gallery listing (pi.dev)](#gallery-listing-pidev). |
| Gallery card shows an older version | npm's index has not picked up the new version yet; `npm run gallery` reports `stale`. Usually resolves within minutes. |
| `npm run gallery` reports `ineligible` | The manifest keywords lack `pi-package`. Add it (plus `publishConfig.access: "public"` and a `pi` manifest — `npm run verify` enforces all three) and release a new version. |

## Layout

```text
scripts/
├─ verify-packages.mjs    # pre-publish gate (also: npm run verify)
├─ check-gallery.mjs      # pi.dev listing check (also: npm run gallery)
├─ check-gallery.test.mjs # parser tests (also: npm test)
└─ release.mjs            # release tool (also: npm run release)
agent/extensions/<pkg>/
├─ package.json          # name, version, pi manifest, files[], publishConfig
├─ README.md             # npm + GitHub page
├─ LICENSE
├─ CHANGELOG.md          # created/updated by the release script
└─ <entry>.ts            # shipped as source — Pi loads TypeScript directly
```
