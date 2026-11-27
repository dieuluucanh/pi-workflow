# Delivery preparation — prompt refinement / Workflow parity

Plan: `.pi/plans/2026-11-22-prompt-refinement-workflow-parity.md`, step 42 —
"Prepare delivery without unauthorized release actions".

This is the delivery hand-off record for the plan. It summarizes the change
sets, the source/artifact integrity checks, the verification actually run, the
parity status, the remaining blockers and how to roll back **Workflow (W)** and
**Pi Desktop (D)** independently.

**No release action was taken while producing this file:** no version bump, no
`npm publish`, no git tag, no push, no commit, no runtime install and no
discarding of the existing dirty work in either repository. Any commit, bump,
tag, package build or publish is a separate decision under the current commit
and release policy.

## 1. Change summary

### Workflow (W, `C:/Users/Lenovo/.pi`)

Working tree vs `HEAD` (`b497a4c`): 59 tracked files changed
(+30,846/−443) plus 28 untracked plan files (this delivery record adds one more
untracked file). The package version stays **0.13.0**.

New runtime modules (all listed in `agent/extensions/workflow/package.json#files`
and packed — see §2):

| Area | Modules |
| --- | --- |
| Refinement domain | `prompt-refinement-state.ts`, `prompt-refinement-config.ts`, `prompt-refinement-prompt.ts`, `prompt-refinement-context.ts`, `prompt-refinement-runtime.ts`, `prompt-refinement-command.ts`, `prompt-refinement-tools.ts`, `prompt-refinement-review.ts`, `prompt-refinement-eval.ts` |
| Policy-safe inspection | `inspection-policy.ts`, `inspection-tools.ts` |
| Isolated session / provider | `isolated-session.ts`, `provider-auth.ts` |
| Composer transform | `composer-transform.ts` (frozen contract), `composer-transform-adapter.ts` |
| UI + model access | `clarification-presenter.ts`, `default-mode-model.ts` |
| Child launch / teardown | `subagent-launch.ts`, `orchestrator-child-teardown.ts` |

Modified composition and behaviour: `index.ts` (`/prompt`, `/prompt-model`,
mode/Tab wiring, default-model capture, teardown), `workflow-contributions.ts`
and `host-contributions*.ts` (generic control + operation metadata),
`review-tools.ts`/`review.ts`/`review-providers.ts` (extracted shared
inspection/session primitives, Review behaviour preserved),
`orchestrator-child-controller.ts` / `orchestrator-child-session.ts` /
`in-process-child.ts`, `package.json` (files/test list), README/CHANGELOG,
`compat-baseline` fixture, `agent/settings.json`.

Docs/tests added: `docs/workflow-parity-matrix.md` (frozen inventory + final
classification), `docs/prompt-refinement-rubrics.md`, refinement/conformance
fixtures, cross-host/eval/regression suites, and the test-support modules
(`test-support.ts`, `test-support-ports.ts`) which are intentionally **not**
shipped.

### Pi Desktop (D, `C:/Users/Lenovo/Projects/pi-desktop`)

Working tree vs `HEAD` (`b59a407`): 133 tracked files changed
(+27,919/−399) plus 6 untracked files. The app version stays **0.11.0**.

- **Contracts:** `src/shared/composer-transform.ts`, `composition-operation.ts`,
  `extension-contributions*.ts`, `host-protocol.ts`, `workflow-bundle.ts`;
  the byte-identical W/D conformance fixture is asserted by both suites.
- **Host:** `src/host/composer-transform.ts` (source-bound job registry,
  grants, single-use rendezvous, dedupe/expiry), `src/host/workflow-builtin.ts`
  + `src/host/sdk/*` bridge, contribution projection/allowlists, footer facts,
  extension-ui generations and resources diagnostics.
- **Bundling:** `scripts/workflow-bundle*.mjs` (stage/lock/verify, offline load
  under bundled Node), `resources/workflow.lock.json` (pinned
  `@dieulc/workflow@0.13.0`), `resources/extensions/README.md`,
  `scripts/stage-workflow-bundle.mjs`, `scripts/verify-workflow-bundle.mjs`,
  `scripts/verify-packaged-workflow.mjs`, electron-builder `extraResources`.
- **Renderer:** `Composer.tsx`, `ComposerControls.tsx`,
  `ComposerOperationPanel.tsx`, `composer-draft.ts`,
  `composer-draft-operation.ts`, `composer-send.ts`, `composer-command-route.ts`,
  `composer-controls-model.ts`, image attachments and revisioned tab state.
- **Evidence/docs:** `tests/e2e/composer-refinement.spec.ts`,
  `docs/architecture/prompt-refinement.md` (operation, upgrade, rollback,
  compatibility, honest limits), `refinement-acceptance-2026-11-24.md`,
  `packaged-workflow-acceptance-2026-11-24.md`, guide and parity updates.

## 2. Source and artifact integrity

### Packed Workflow manifest (compiled/packed manifest gate)

Command (W root):

```bash
node scripts/verify-packages.mjs --pack-only --packages workflow
```

Result: **ok — 92 files packed**. Independently checked with
`npm pack --dry-run --json`:

| Check | Result |
| --- | --- |
| Every `package.json#files` entry is packed | PASS (the only packed path outside the list is the synthesized `package.json`) |
| Packed import closure (every relative import resolves to another packed file) | PASS (part of the pack gate) |
| New runtime modules present (11 named above) | PASS — all 11 packed |
| No `*.test.ts` / `*.spec.*` in the tarball | PASS — zero |
| No `node_modules`, lockfile or fixtures directory in the tarball | PASS |
| No developer-home / absolute checkout path in shippable modules | PASS — no `C:\Users\…`, `/home/<user>/`, `/Users/<user>/` matches |
| No token/private-key-looking literals in shippable modules | PASS — none |

The test-support helpers (`test-support.ts`, `test-support-ports.ts`) exist only
for tests and are deliberately absent from `files`; runtime modules do not
import them.

Cosmetic, non-blocking: `package.json#files` lists `shell-guard-runtime.ts`
twice. `npm pack`/the pack gate still produce 92 unique files with no failure.
It was left untouched because the manifest is part of the pinned artifact and
editing it without a re-pin would only widen the source/pin drift recorded
below.

### Staged Desktop bundle

Command (D root): `npm run workflow:verify`

Result: `@dieulc/workflow@0.13.0 ok (2 staged copies, bundled Node
v24.22.2)`. The packaged-row suite (`node scripts/verify-packaged-workflow.mjs
--dir release/win-unpacked`) reports `artifact-integrity` and
`artifact-self-contained` PASS: both shipped copies match
`resources/workflow.lock.json`, the artifact contains no developer-checkout
path, declares no runtime dependencies and has no install-time lifecycle
scripts.

### Integrity finding: the pinned bundle predates the current W source

This is the one real integrity gap the delivery must not hide:

- The pin describes **90 packed files** (`resources/workflow.lock.json`);
  current W packs **92**. Missing from the pin: `subagent-launch.ts` (imported
  by the current `index.ts`) and `prompt-refinement-eval.ts` (dev eval harness
  used by `scripts/eval-prompt-refinement.mjs`).
- Nine files that **are** in the pin have different sha256 in the working tree:
  `README.md`, `package.json`, `index.ts`, `clarification-presenter.ts`,
  `composer-transform-adapter.ts`, `isolated-session.ts`,
  `orchestrator-child-controller.ts`, `orchestrator-child-session.ts`,
  `prompt-refinement-prompt.ts`.
- `resources/extensions/workflow` therefore stages the **older 0.13.0 bits**
  (90 locked files plus the generated `workflow-bundle.json` metadata document,
  which the lock intentionally does not list). It still loads (the pinned
  `index.ts` predates the `subagent-launch.ts` import) and all 12 packaged rows
  pass, but it is **not** the current source:
  the parity matrix already records that this bundle predates the row-31
  `/workflow` fix, and it also predates row-30 child launching.

**Consequence:** shipping today would ship pre-row-30/31 behaviour. Re-packing
the current source, updating `resources/workflow.lock.json`, re-staging both
layouts and re-running `workflow:verify` + the packaged rows is **required
before any release**, and is a separate authorized release step (the plan
forbids bumping/publishing/tagging here). No lock, version or staged byte was
changed by this row.

### Build freshness

`out/host/index.mjs` is newer (09:09) than the packaged copy under
`release/win-unpacked` (08:52). The 12/12 packaged result above is still a valid
integrity/loading proof for the staged bytes, but a release must rebuild and
repackage from the final source (`npm run build` **after** `workflow:stage`, in
that order, because the host build cleans `out/`).

## 3. Verification results

Re-run while preparing this record (2026-11-24, Windows, Node v24.22.2):

| Repository | Command | Exit | Result |
| --- | --- | --- | --- |
| W | `agent/extensions/workflow: npm run typecheck` | 0 | clean |
| W | `agent/extensions/workflow: npm test` | 0 | 1636 tests, 0 fail, 0 skipped |
| W | `agent/extensions/workflow: npm run check:policy` | 0 | 100/100 checks |
| W | `agent/extensions/workflow: npm run check:read-policy` | 0 | all read/folder policy checks pass |
| W | root `npm test` | 0 | 80 tests, 0 fail |
| W | `node scripts/verify-packages.mjs --pack-only --packages workflow` | 0 | 92 files packed, closure clean |
| D | `npm run workflow:verify` | 0 | pin matches both staged copies |
| D | `node scripts/verify-packaged-workflow.mjs --dir release/win-unpacked` | 0 | 12/12 packaged rows |
| D | `npm run format:check` | 0 | Prettier clean |
| D | `npm run typecheck` (node + web + e2e) | 0 | clean |

Recorded by step 40 against the same tree (not re-run here; this delivery row
changed no source):

| Repository | Gate | Recorded result |
| --- | --- | --- |
| D | full `npm test` | 6130 passed, 4 skipped, 0 fail |
| D | `npm run lint` | 0 errors, 9 pre-existing warnings |
| D | `npm run build` | PASS |
| D | architecture/host/packaging suites | 1145 passed, 3 skipped |
| D | Playwright composer E2E (`tests/e2e/composer-refinement.spec.ts`) | 14 passed, 1 skipped (`test.fixme` known gap) — see `docs/architecture/refinement-acceptance-2026-11-24.md` |

No new baseline failures were observed. One previously fixed failure (D site
navigation missing the step-39 evidence doc) remains covered by
`tests/site/site-contract.test.ts`.

## 4. Parity matrix status

`docs/workflow-parity-matrix.md` §7 is the checked-in matrix. All 13
Verification areas are **SUPPORTED**, each with a named automated check, or are
covered by an accepted exception; there is no remaining `ABSENT` area and no
quiet deferral.

- **Accepted exceptions (user-approved):** Terminal command handlers receive no
  structured image bytes, so Terminal keeps its image-path UX; Desktop keeps
  real attachments. Native/TUI rendering differences are behavioural, not
  pixel-identical. Remaining documented platform differences (custom editor,
  independent checkpoint systems, Terminal-only chords, notification classes,
  no `!`/`!!` completion) are in §5.
- **NOT RUN ledger (release blockers, not passes):** live Review round against a
  real independent provider; live Orchestrator provider turn / visible child /
  host kill; real Plannotator browser tab; packaged clean-profile/offline on
  macOS and Linux; a fresh Playwright composer E2E and real Terminal keyboard
  QA in this row; live read-grant revocation inside a long main-agent turn; the
  live-model quality sample and human rubric sign-off.

## 5. Remaining blockers before delivery

1. **Re-pin the Workflow bundle from current source.** Current pin = 90 files /
   9 drifted; current pack = 92 files including `subagent-launch.ts`. Requires
   a locally built, verified tarball → `npm run workflow:lock -- --tarball …` →
   `npm run workflow:stage` → `npm run workflow:verify` → packaged rows. This is
   a release action and needs separate authorization.
2. **Rebuild and repackage Desktop from the final source**, after the re-pin
   (`npm run build` then `electron-builder … --publish never`). The current
   `release/win-unpacked` predates `out/`.
3. **Platform signoff.** macOS and Linux packaged/offline rows are unrun release
   blockers; Windows packaged rows pass.
4. **Manual/live evidence** still NOT RUN: live Review provider round, live
   Orchestrator turn/child/host-kill, Plannotator browser handoff, real Terminal
   keyboard QA, live-model quality sample with human review, live read-grant
   revocation in a long main-agent turn.
5. **Known functional gap kept honest:** reload mid-refinement does not adopt a
   still-live job (host protocol migration/reattach is a protocol change). The
   draft is preserved, nothing is re-run and nothing is double-inserted
   (asserted); only candidate adoption is missing (`test.fixme` in
   `tests/e2e/composer-refinement.spec.ts`).
6. **Commit the work under the current commit policy.** Both trees are dirty
   (W: 59 tracked + 28 untracked; D: 133 tracked + 6 untracked). Packaging must
   happen from a committed, reproducible revision; this row does not commit.
7. **Honest scope limits:** semantic quality of a refinement is human-reviewed,
   not guaranteed; revocation stops future disclosure and stale apply but does
   not recall data already sent to a provider; binary attachments do not
   survive a full app/renderer process loss.

## 6. Rollback instructions (independent halves)

The two halves are independently versioned and can be rolled back separately.
Mixed versions fail safe by capability negotiation: an older Desktop drops the
unknown `composer-control` kind and keeps the generic status/action rows plus
the plain text command; an older Workflow renders as a plain generic row. A
mismatch degrades to text-only and never blocks a normal send.

### Workflow (W) only

1. **Installed extension:** `pi install npm:@dieulc/workflow@<previous-version>`
   (or remove the local/npm override and re-enable the builtin in Desktop's
   Extensions hub). Terminal Pi picks the change up on restart/`/reload`.
2. **Packaged Desktop builtin:** install the previous Desktop build, or add an
   explicit `pi install npm:@dieulc/workflow@<previous>` override. Do not edit
   the user's `packages`/settings by hand.
3. **This checkout:** preserve the work, then restore the previous revision —
   `git stash push --include-untracked` (or commit to a branch) before
   `git switch`/`git restore`. **Never** `git reset --hard` or
   `git clean -fd`; the dirty tree is the only copy of this plan's work.
4. **Configuration:** `workflow.promptRefinement.model` is an optional key under
   the existing `workflow` settings object; older versions ignore unknown keys.
   Removing that key (or `/prompt-model reset`) restores pure Default-mode
   inheritance. No other migration or on-disk state was added.
5. After rollback: `/prompt`, `/prompt-model` and the composer control simply
   disappear; Draft text/chat behaviour is unchanged.

### Desktop (D) only

1. **App:** reinstall the previous Desktop build. Renderer and host ship in one
   binary, so a rollback never leaves a mismatched contract pair. Session data
   is forward/backward tolerant; no settings migration was introduced.
2. **Bundled Workflow:** the staged bundle is generated. Revert
   `resources/workflow.lock.json`, then re-stage from the restored pin
   (`npm run workflow:stage` from the previous lock) and `npm run workflow:verify`.
   Do not hand-edit staged bytes.
3. **This checkout:** same preservation rule — stash/include-untracked or branch
   first, then restore the previous commit. Do not discard the dirty tree.
4. **Mixed versions:** a newer Workflow with an older Desktop keeps the plain
   text `/prompt` path (`composerTransformFallback()` reports
   `nativeControl: false`, `attachmentAware: false`); a newer Desktop with an
   older Workflow shows a generic contribution row. Neither path promises
   attachment-aware transformation.
5. Live operation state, grants, apply receipts and binary attachments are
   in-memory only; a rollback/restart discards them. Draft text in the composer
   is preserved by the normal editor state.

## 7. Release actions explicitly not taken

| Action | State |
| --- | --- |
| Version bump (W 0.13.0, D 0.11.0) | none |
| `npm publish` / `release` / gallery update | none |
| Git tag | none |
| Git push / commit | none — both trees remain dirty as delivered |
| Runtime install or settings rewrite | none |
| Discarding existing work | none |
| Lock/staged-byte edits | none (the pin drift is reported, not silently "fixed") |

## 8. Reproduce this hand-off

```bash
# W
cd C:/Users/Lenovo/.pi/agent/extensions/workflow
npm run typecheck && npm test
npm run check:policy && npm run check:read-policy
cd C:/Users/Lenovo/.pi && npm test
node scripts/verify-packages.mjs --pack-only --packages workflow

# D
cd C:/Users/Lenovo/Projects/pi-desktop
npm run workflow:verify
npm run format:check && npm run typecheck
node scripts/verify-packaged-workflow.mjs --dir release/win-unpacked
```
