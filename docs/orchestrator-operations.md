> **Superseded (2026-11-24).** The frozen plan contract and the automatic
> acceptance engine described below were removed. Current flow: a normal
> markdown plan, optional append-only review, then Direct Build or the
> model-driven Orchestrator dispatcher. Old runs are not resumed. See the
> README section "2026-11-24 — model-driven Orchestrator".

# Orchestrator operation, migration and compatibility

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
>
> **Launch and retry semantics (2026-11-22).** A dispatch is complete only
> after the child window/tab is shown and the child acknowledges the sealed
> start. A launcher refusal blocks the row with the real reason; retry
> re-dispatches it. A delivered start without an acknowledgement stays
> `running` and is reported as uncertain — it is never relaunched
> automatically. A `running` row is abandoned only when the probe proves it
> never launched (no `task.launched`, no assistant turn, no start marker);
> otherwise the retry refuses. On Windows the launcher runs the Pi Node
> entrypoint or `pi.cmd` — never the extensionless npm shell shim
> (`0x800700c1`).

Status: **experimental**. The engine, its contracts and the live composition are
implemented and covered by automated tests; real provider turns and visible-host
signoff remain manual. This document is the operator-facing contract for what
exists today. It is not a claim that the live loop passed acceptance — see
[`orchestrator-live-acceptance.md`](orchestrator-live-acceptance.md).

## Enable / disable

- Orchestrator is **opt-in**. `/orchestrator` enters the mode; entering the mode
  launches nothing. Tab does not advertise it as an execution mode.
- Ordinary Plan → Review → Build, Default mode, Review Mode and all existing
  policies keep their behavior. There is no global switch that enables automatic
  orchestration.
- To go back, leave the mode as usual (`/plan`, `/build`, `/default`); an
  in-flight run's controls are `pauseRun`/`resumeRun`/`stopRun` in the engine.
  If a run is terminal, it cannot be resumed or cancelled again.

## Plan handoff: approval and execution are two decisions

The presenter (`Plannotator` or the native sheet) is always asked about the
**plan** first. Approving it does not execute anything:

```text
Plan → optional independent Review → configured presenter
     ├─ Feedback → Plan revision → (review) → presenter again
     └─ Approve  → execution chooser
                     ├─ Orchestrator → record the approved plan → model calls orchestrator_start → children
                     ├─ Direct Build → this session's Build → one execute turn
                     └─ Decide later → Plan, approved, nothing started
```

- `workflow.handoff.executionMode` is a **recommendation** (first chooser row).
  It never executes by itself, and the chooser's answer is not written back to
  settings — it applies to that approved plan only.
- Cancelling the chooser keeps the approval. Resume with
  `/handoff continue <decision-id>`; a changed plan/branch/session invalidates
  the approval instead.
- Headless: `/handoff approve <id>` records the approval, then
  `/handoff execute <id> orchestrator|build` records the destination. Neither
  infers consent from the saved default.
- Choosing Orchestrator records the approval and sends the start kickoff; the
  model then calls `orchestrator_start` with the rows. There is no separate
  preparation service and no digest-bound preview approval before a child
  starts.

## Entry and work sources

Both the automatic handoff and a direct request use the same model-driven start:

- **Direct request.** Bare `/orchestrator` enters the mode;
  `/orchestrator start [path]` records the approved plan and sends the existing
  start kickoff. Without a path it uses `currentPlanFile ?? todos.planPath` and
  otherwise refuses with `/orchestrator start <path>`. The model then calls
  `orchestrator_start` with one step per row (a string, or
  `{text, workspace}` for a non-primary root) and the workspaces the plan
  declares.
- **The model owns the rows.** The extension records the rows and resolves the
  roots; it does not compile or validate the plan. There is no
  `orchestrator_prepare` preparation service, no derived-requirements preview
  and no separate execution-approval step.
- **Explicit plan.** A path on `start` records that plan file as the run's
  source; a missing plan refuses instead of silently choosing an old plan or
  TODO list.
- **No `/build` detour.** Orchestrator is a distinct role. Its edit/shell
  refusals name delegation as the remedy; `/build` is a deliberate user choice,
  not the response to an ordinary work request.

## Operator commands

```text
/orchestrator                       # enter the mode only
/orchestrator start [path]          # record the approved plan and send the start kickoff; the model calls orchestrator_start
/orchestrator status                # bound run, row progress, live child, next row
/orchestrator inspect [rowRef]      # one row: root, instruction, last report, child detail
/orchestrator pause|resume|abort    # control the live child
/orchestrator retry [rowRef]        # dispatch a row again with its stored instruction
/orchestrator stop                  # dispose the child and cancel the run record
/orchestrator say <text>            # message the running or paused child
/orchestrator view [child|parent|auto]
/orchestrator help [verb]
```

The old `preview`, `approve`, `refine`, `finalize` and `cancel` verbs no longer
exist; `cancel` was renamed to `stop`. Execution is the model's decision, not a
command: the execution chooser (Build / Orchestrator / Decide later) is the only
execution decision, and there is no saved destination or recommendation. Once
Orchestrator is chosen, the model calls `orchestrator_start` with the rows.
There is no separate preview approval or approval dialog.

## Migration

- Old roles/profiles/session entries load unchanged. A missing Orchestrator role
  falls back to the Planner model without rewriting `roles.json` or
  `profiles.json`; the worker stays on the Builder model.
- Existing `workflow_todo` behavior is unchanged. Managed children use a
  task-local list (`owner: "worker"`); a child's completion never edits the
  parent roadmap.
- Legacy host adapters are intentionally removable: older Desktop builds without
  the generic contract still get ordinary statuses/widgets, but native
  cancellation/input/related-session controls are reported unavailable instead
  of being inferred from status prose.
- The Desktop min-version and capability matrix are in the release note for the
  coordinated build; until then, treat an older host as generic-contract
  unavailable (not as a Workflow-specific fallback).

## Run lifecycle (historical — removed pipeline)

The numbered lifecycle below describes the deleted prepare → preview → approval
pipeline and is kept only as history. The current lifecycle is: freeze one row
per plan step, dispatch row 1 to a visible Build child, verify the row's diff and
checks, accept and dispatch the next row, then run the plan's `## Verification`
commands once. See the README for the authoritative list.

1. **Mode** — opt-in, no launch.
2. **Source** — discussion snapshot or explicit readable path, captured verbatim
   with a digest; `- [x]` is a claim, not proof, and ambiguous/empty parses are
   refused. The source kind is shown in status and the preview.
3. **Breakdown** — structured tasks must cover every outstanding requirement;
   dependencies must be a DAG. A material scope/criteria/dependency change needs
   a new approval revision.
4. **Execution approval** — separate from mode entry and plan approval. In a UI
   session the host presents the one approval dialog after the validated
   breakdown: Approve starts the next ready task, Deny invalidates durably and
   stays in Orchestrator, freeform text asks for a revision. A headless host
   uses `/orchestrator preview` and `/orchestrator approve preview-<digest>`.
   The preview shows the task mapping, exact Builder model/limit estimates,
   launcher readiness, checks, dirty baseline, commit behavior and
   repair/rollover limits. Ordinary handoff Approve → Build is not repurposed.
5. **Dispatch** — returns a durable launch/status receipt immediately. The child
   is a normal visible session; assignment start is one correlated wake after
   readiness and lease grant. The terminal host's readiness includes an SDK
   probe: a missing/invalid `SessionManager` blocks the approval preview instead
   of failing after approval. A bare `/orchestrator start` resumes an approved
   run through the same one-dispatch path; passive reload alone stays idle.
6. **Candidate** — a report only proposes completion. Mutation is fenced after a
   real settle with tools/follow-ups drained.
7. **Verification / acceptance** — the parent captures the actual baseline →
   candidate diff (content-addressed, including already-dirty, untracked,
   deleted and non-Git files), runs required checks through normal gated
   execution, recomputes the workspace revision after the checks, records real
   evidence, and accepts atomically against the exact candidate, workspace and
   roadmap revision. Missing content identity, missing evidence, a pre-existing
   red gate, an unavailable tool, a manual-only check or a changed workspace
   blocks it.
8. **Repair / rollover** — failed criteria go back in a bounded scoped directive;
   the same warm child is preferred, a fresh continuation is used only when the
   child is gone. Counters survive. At the budget the run pauses; rollover uses a
   safe-boundary checkpoint and never runs two writers.
9. **Final gate** — only accepted task coverage can complete the roadmap.
   Roadmap-level integration/manual checks run against the latest workspace; a
   failure keeps the run non-complete and proposes a scoped repair. A scope
   change needs approval.

## Operator recovery

- **Journal is authoritative.** The snapshot is a cache; a snapshot that claims
  acceptance the journal never recorded is inconsistent and must not resume.
- **Torn write.** Replay stops at the last valid line. Run the journal recovery
  (`recover()` on the run journal) before resuming. The recovered state reports
  `truncated: 0`; never hand-edit accepted events.
- **Uncertain kickoff.** An intent without ack is `uncertain`. Inspect the child
  session file/outbox and the actual turn start; do not resend the kickoff
  blindly. An ack without intent is inconsistent and also pauses.
- **Old parent may still be alive.** TTL alone is not ownership. If the previous
  process identity has a fresh heartbeat, reacquisition pauses even after expiry.
- **Parent loss.** Children are stopped safely; edits remain. A new parent does
  not continue their work automatically.
- **Fork/tree/rewind.** Those branches are historical for an active run; reuse
  requires an explicit clone/reconcile decision.
- **Lease reclaim.** An expired lease is reclaimed only with the explicit
  `reclaim-stale` confirmation and a reserved higher generation. Fencing tokens
  are workspace-wide and survive release/restart; never reuse a consumed token.
- **Pause/stop.** Quiesce first; release the lease only after a real settle and
  drain. Stop retains edits and does **not** roll back automatically.
- **Close/archive.** A child window/tab close is `interrupted`, not accepted
  progress. History remains; no scheduler respawns it.
- **Commits.** Managed children never auto-commit or push. Accepted work is
  committed by the parent at most once per evidence id, under the existing
  `never`/`ask`/`allow` policy. A path that already held user work is an
  attribution conflict: the parent asks or skips rather than silently staging.
- **Retention.** Cleanup is explicit. Active work, unaccepted evidence, session
  history and pinned items are never candidates; accepted evidence waits until
  the run is complete.

## Compatibility matrix (planned release)

| Capability | Workflow (W) | Pi Desktop (D) | Behavior when missing |
| --- | --- | --- | --- |
| Generic contribution contract v1 | required | required | Older host keeps statuses/widgets; native generic controls unavailable |
| Source-bound related-session host | required | required | Related child tabs report `unsupported`; no hidden child |
| Bootstrap-before-start + authorized wake | required | required | Persisted resume stays idle; no assignment replay |
| Separate visible child (terminal/tab) | required | required | Missing launcher pauses with setup guidance |
| Parent-only commit ledger | required | — | Child commits suppressed regardless of host |
| Evidence-backed acceptance | required | — | Missing checks/evidence blocks acceptance |

Rollback is independent: disabling Orchestrator (or running an older Workflow)
leaves ordinary Build available. A Desktop that lacks a capability must return an
explicit `unsupported`/unavailable result, not a Workflow-specific fallback.

## Known limits

- No real provider/turn loop, no real terminal-window signoff and no packaged
  Desktop E2E has been run. The SDK event bus is not publisher authentication.
- Extensions are trusted executable code; this is not a sandbox boundary.
- Approval confirms what runs, not the safety of arbitrary project scripts.


## Multi-repository workspaces

A run may declare up to eight roots. The session root is primary; declared
roots are resolved through `realpath` and git top level, deduplicated, and
rejected when missing, broad, duplicate or overlapping. Rows may bind one or
more aliases; the first is the child cwd. Baselines and diffs are captured per
root, a missing/unreadable root is a measurement failure, and committed paths
only satisfy expected files. Row checks run in the bound root (or the single
changed root); plan checks use `[alias] command` or `Workspace: alias`. Child
writes remain subject to the normal folder/write policy — declaring a root is
not a grant. Old snapshots without roots remain primary-only.
