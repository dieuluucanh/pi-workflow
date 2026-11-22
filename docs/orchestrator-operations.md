# Orchestrator operation, migration and compatibility

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
                     ├─ Orchestrator → prepare breakdown → preview approval → children
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
- Choosing Orchestrator authorizes **preparation only**. The digest-bound
  `preview-<id>` approval below is still required before any child starts.

## Entry and work sources

Both the automatic handoff and a direct request use ONE preparation service:

- **Direct request.** In Orchestrator, ask for the work. The parent calls
  `orchestrator_prepare`; `/orchestrator start` is also the explicit RESUME
  command: a bare start restores a bound plan's deterministic run/journal and,
  if it already has an execution approval, starts the next ready task;
  `start <path>` prepares an explicit plan. A bare `/orchestrator` remains mode
  entry.
- **Current discussion.** With no path, the parent snapshots the objective and
  the constraints the user stated, plus bullet/numbered lines as requirements.
  A formal Markdown plan and a separate Plan-mode approval are not required; the
  execution preview shows the derived requirements before approval.
- **Explicit plan.** `source:"plan"` / a path captures the exact bytes and
  digest. An explicitly requested discussion wins over a stale
  `currentPlanFile`.
- **Ambiguity.** With no objective, no path and no bound plan, preparation asks
  for the work instead of silently choosing an old plan or TODO list.
- **No `/build` detour.** Orchestrator is a distinct role. Its edit/shell
  refusals name delegation as the remedy; `/build` is a deliberate user choice,
  not the response to an ordinary work request.

## Operator commands

```text
/orchestrator                       # enter the mode only
/orchestrator start [path]          # prepare discussion (default) or an explicit plan
/orchestrator status                # phase, requirements, approval/next blocker
/orchestrator preview               # the exact breakdown preview + approval id
/orchestrator approve preview-<id>  # explicit approval; starts the next ready task
/orchestrator refine <what>         # durably void the preview/approval
/orchestrator cancel                # terminal; nothing launched
/orchestrator pause|resume|stop|retry|inspect|say <text>
```

The normal UI flow asks for this approval in a dialog right after the breakdown
validates. **Approve** records the approval and dispatches the next
dependency-ready task; **Deny** invalidates the preview durably and stays in
Orchestrator; freeform text asks for a revision. `/orchestrator approve` is the
headless/automation fallback and also starts the next ready task. The model has
no approve tool. A stale, duplicate or wrong preview id is refused; an approval
never carries over to a changed preview.

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

## Run lifecycle

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
