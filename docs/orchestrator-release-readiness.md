> **Superseded (2026-11-24).** This document describes the removed frozen /
> journaled Orchestrator engine and Build execution engine. It is retained as
> historical evidence, not current behaviour. Current flow: the model-driven
> dispatcher in `agent/extensions/workflow/README.md` (model-supplied rows, one
> in-process child per row, verification as ordinary bash).

# Orchestrator release readiness (coordinated, opt-in)

> **Updated 2026-11-23 — in-process Build child.** The external child chain
> (Desktop tab / Terminal window / `pi --session` / child host / IPC / start-ack
> / workspace lease) is removed. The current contract is:
>
> - plan approval (or an agreed standalone discussion) freezes ONE TODO list
>   (one row per top-level plan step) via `orchestrator_start`;
> - the extension runs one **in-process** SDK Build child per row (no window or
>   tab); the child loads only this extension plus Pi built-ins and gets the
>   normal Workflow-managed Build tools and policy gates;
> - on a natural settle the extension reports, diffs (including
>   `previous.head..HEAD`), runs the row checks, verifies and accepts, then
>   starts the next row; a failure repairs the same warm child (max 2 rounds)
>   and then blocks and pauses;
> - the parent model only handles blockers, status and recovery; user prose is
>   forwarded to the running child;
> - `/orchestrator pause|resume|abort|view` (and the `/orchestrator` verbs)
>   control the child; `/orchestrator view` switches BOTH the pinned panel and
>   the footer's child line (model, context, tokens, elapsed time);
> - a reload blocks a `running` row and pauses the run; retry starts a fresh
>   child. Old managed-worker sessions open as ordinary Build.
>
> Parent tools are `orchestrator_start|status|retry`; there is no
> `workflow_worker_ready`, `orchestrator_verify|accept|repair` or
> `workflow-bridge`. See the package README and CHANGELOG.

> **Superseded 2026-11-22 (Orchestrator simplification).** The
> propose → preview → execution-approval pipeline described in the older body of
> this document no longer exists. The current contract is:
>
> - plan approval (or an agreed standalone discussion) freezes ONE TODO list
>   (one row per top-level plan step) via `orchestrator_start`;
> - the scheduler dispatches row 1 to a visible Build child, and acceptance of
>   row N dispatches row N+1;
> - the child is a normal Build session with its own task-local TODO list and no
>   edit interlock;
> - per row the parent runs the row's checks and `orchestrator_verify` /
>   `orchestrator_accept`; after the last row it runs the plan's
>   `## Verification` commands once;
> - there is no saved execution destination, no recommendation and no
>   `/handoff execution|once`; every approved plan asks Build/Orchestrator;
> - `workflow.handoff.executionMode` is ignored, never rewritten, and legacy
>   runs are not resumed — restart from the approved plan.
>
> See the package README and CHANGELOG for the current operator contract.

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
