# Orchestrator operation, migration and compatibility

Status: **experimental**. The engine and its contracts are implemented and
covered by automated tests; the live orchestration loop is not wired into the
extension entrypoint yet. This document is the operator-facing contract for what
exists today and what a later release will enable. It is not a claim that the
live loop passed acceptance — see
[`orchestrator-live-acceptance.md`](orchestrator-live-acceptance.md).

## Enable / disable

- Orchestrator is **opt-in**. `/orchestrator` enters the mode; entering the mode
  launches nothing.
- Ordinary Plan → Review → Build, Default mode, Review Mode and all existing
  policies keep their behavior. There is no global switch that enables automatic
  orchestration.
- To go back, leave the mode as usual (`/plan`, `/build`, `/default`); an
  in-flight run's controls are `pauseRun`/`resumeRun`/`stopRun` in the engine.
  If a run is terminal, it cannot be resumed or cancelled again.

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
2. **Roadmap** — an explicit readable path is ingested verbatim; `- [x]` is a
   claim, not proof, and ambiguous/empty parses are refused.
3. **Breakdown** — structured tasks must cover every outstanding requirement;
   dependencies must be a DAG. A material scope/criteria/dependency change needs
   a new approval revision.
4. **Execution approval** — separate from mode entry and plan approval. It shows
   the task mapping, model/limit estimates, launcher readiness, checks and
   repair/rollover/commit behavior. Ordinary handoff Approve → Build is not
   repurposed.
5. **Dispatch** — returns a durable launch/status receipt immediately. The child
   is a normal visible session; assignment start is one correlated wake after
   readiness and lease grant. Resume alone stays idle.
6. **Candidate** — a report only proposes completion. Mutation is fenced after a
   real settle with tools/follow-ups drained.
7. **Verification / acceptance** — the parent captures the actual baseline →
   candidate diff, runs required checks through normal gated execution, records
   real evidence, and accepts atomically against the exact candidate, workspace
   and roadmap revision. Missing evidence, a pre-existing red gate, an
   unavailable tool, a manual-only check or a changed workspace blocks it.
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
  `reclaim-stale` confirmation and a higher generation. Never reuse a stale
  generation.
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
