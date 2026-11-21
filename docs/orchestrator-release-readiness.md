# Orchestrator release readiness (coordinated, opt-in)

Status: **prepared, not released**. No publish, tag or push was performed. Both
repositories keep their current versions (`@dieulc/workflow` 0.13.0,
`pi-desktop` 0.11.0); promotion requires the user's explicit release
authorization.

## Staged rollout

### Stage 1 — generic host contract (already implemented)

- Workflow publishes mode/progress/status/action/input/related-session through
  the versioned contract; Desktop reads it generically.
- Result: arbitrary extension modes work without a Desktop change; an older
  Desktop keeps ordinary statuses/widgets and reports native generic controls as
  unavailable. No Workflow-specific parsing is required.

### Stage 2 — migrated Workflow presentation

- Plan/Build/Review/TODO/input presentation goes through the same generic
  primitives. Existing short-task defaults and the Plan → Review → Build flow are
  unchanged.
- Legacy fallback is generic, not a retained Workflow adapter. Older Workflow
  versions on a newer Desktop still get ordinary statuses/widgets.

### Stage 3 — Orchestrator, experimental (off by default)

- `/orchestrator` is opt-in; entering the mode launches nothing.
- The engine/contracts are shipped only after Stage 1 + 2; automatic
  orchestration stays off and the mode remains experimental until the live
  checklist in [`orchestrator-live-acceptance.md`](orchestrator-live-acceptance.md)
  passes on the supported platforms.

## Compatibility matrix

| Capability | Minimum W | Minimum D | Missing behavior |
| --- | --- | --- | --- |
| Contribution contract v1 | this build | generic host build | older host: statuses/widgets only; native controls unavailable |
| Source-bound related sessions | this build | generic related-session host | `unsupported`; no hidden child |
| Bootstrap-before-start + authorized wake | this build | related-session host | persisted resume stays idle; no replay |
| Separate visible child tab/window | this build | related-session host | explicit launcher/host unavailable |
| Parent-only commit ledger | this build | — | child auto-commit/push suppressed regardless |
| Evidence-backed acceptance | this build | — | missing evidence blocks acceptance |

The exact Desktop version that first ships the generic host is determined at
release time; until then a host that does not advertise the capability is treated
as `unsupported` rather than guessed.

## Rollback

- Workflow can disable Orchestrator independently; ordinary Build remains
  available with the same policies.
- Desktop can run without the generic contract: Workflow falls back to ordinary
  statuses/widgets and native child tabs are unavailable, not silently emulated.
- No schema/version bump is required to roll back; session history and accepted
  evidence are retained.

## Verification evidence

Automated (completed):

- Workflow `npm test`: 1308/1308.
- Workflow `npm run typecheck`, `check:policy` 100/100, read/folder policy suite,
  root `npm test` 80/80 and `verify --packages workflow` (78 files).
- Desktop `format:check`, `typecheck`, `lint` (0 errors), `npm test` 5659 passed
  / 5 skipped, `npm run build`.
- Shared two-extension fixture and the Desktop contract E2E test.

Not run / not claimed:

- Real provider/turn loop, real Windows Terminal/macOS/Linux launches, packaged
  Desktop E2E, live platform signoff. See the live acceptance checklist; it is
  currently **NOT RUN**.

## Release checklist (requires explicit authorization)

1. Resolve the remaining live/manual cases or record an approved exception.
2. Choose coordinated versions and update both changelogs/package versions.
3. Re-run every gate above on the release commit, including `verify:extension`
   for Desktop packages.
4. Publish Workflow to npm and promote Desktop builds only after `npm login` and
   an explicit go-ahead.
5. Tag/push/release only with the user's authorization; keep Orchestrator
   experimental until the live gates pass.
