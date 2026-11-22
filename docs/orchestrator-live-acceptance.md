# Orchestrator live acceptance — manual signoff

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

Status: **NOT RUN**. This file is a checklist, not evidence. The automated
suites (workflow `npm test`, Desktop `npm test`) exercise the contract with
fake ports, fake agents and in-memory sessions; they are **not** a substitute
for the live runs below. Do not mark a row passed without a real run on the
named platform/provider.

The implementation is opt-in and experimental. Orchestrator mode is off by
default; ordinary Plan → Review → Build is unchanged.

## Status update (2026-11-22)

**Automated (run and green):** workflow `npm run typecheck`, the full workflow
package test suite, and the new real-entrypoint integration tests (RE1/RE2). RE1
approves a plan through the real extension, checks the on-disk run journal
(`run.created`, `run.preparation`), exactly one preparation turn, the registered
status tool reporting the bound run, and an honest refusal for dispatch with no
bound child host. RE2 confirms the explicit direct-Build destination sends one
execution prompt and creates no run. All of this uses fake hosts/providers, so it
is integration evidence, **not** live acceptance.

**Automated (second pass, green):** the child chain is now composed. New
coverage: real local control transport (`ready → start → start-ack`, forged and
duplicate frames refused, uncertain-after-delivery), the child-host dispatcher
ordering (grant → metadata → launch → ack), a real-SDK session-materialization
check, and a real-entrypoint managed-child test that authorizes only from the
parent's signed grant and applies it at `workflow_worker_ready`. Full workflow
suite, typecheck, write-policy 100/100 and read-policy checks are green.

**Automated (third pass, green):** real-entrypoint `/orchestrator start` captures
the current discussion with no plan file and launches nothing; the mission text is
tested for identity/work-entry and absence of a `/build` remedy; the preview is
rendered with its derived scope and approval is refused without the exact
`preview-<digest>` id; refine is journaled and survives restore; content digests
detect same-length edits and post-check drift; the lease high-water mark survives
release, a second task and a restarted adapter. Typecheck and the focused suites
are green. The full package run is recorded below when executed.

**Manual (NOT RUN):** every row below. In particular:

- No real provider/model turn has been executed for Orchestrator preparation,
  breakdown, dispatch or repair.
- No visible Windows Terminal child, macOS Terminal or Linux tmux child has been
  launched by this build. The entrypoint can now bind a Terminal host (or a
  source-bound Desktop tab) and fails closed only when neither is available;
  the launch itself has still not been exercised against a real window.
- No packaged Pi Desktop E2E was run; Desktop related-session behavior is covered
  only by its own fake-host conformance suites.
- Crash/reload recovery is covered by module and entrypoint tests with fake
  processes, not by killing a real parent while a real child runs.

Do not convert any row to PASSED without the real run described in it.

## Required environment

| Axis | Required |
| --- | --- |
| Provider | Two distinct real models (orchestrator/planner and builder roles) |
| Host | Pi Desktop on Windows, plus `Windows Terminal` for the terminal path |
| Other terminals | macOS Terminal and Linux terminal/tmux on their real systems |
| Workspace | A Git repo with pre-existing staged, unstaged and untracked user work |
| Roadmap | Three phases, at least one step split across two tasks |
| Recovery | Ability to kill/reload the parent and close the child window/tab |

## Cases

| # | Case | Expected evidence | Status |
| --- | --- | --- | --- |
| 1 | Entering Orchestrator mode | No work launches; status/help shows the mode; ordinary Tab cycle unchanged | NOT RUN |
| 2 | Approved three-phase roadmap | Execution preview maps every requirement; explicit execution approval required | NOT RUN |
| 3 | First dispatch | Child is a normal visible session with normal tools/UI; assignment starts with no extra prompt | NOT RUN |
| 4 | Child understands scope | Child knows its task, accepted dependencies and roadmap reference without the parent transcript | NOT RUN |
| 5 | Failed verification → repair | Parent records failed checks; child receives a scoped repair; counters persist; no acceptance | NOT RUN |
| 6 | Context rollover | Checkpoint at a safe boundary; old child quiesced; fresh visible continuation; counters survive | NOT RUN |
| 7 | Parent reload | Journal/branch/process reconciliation resumes without a duplicate assignment turn | NOT RUN |
| 8 | Worker window/tab close | Child becomes interrupted, edits preserved, no respawn, no accepted progress | NOT RUN |
| 9 | User question in child | Parent shows “waiting for your answer in the child”; answering continues; no acceptance implied | NOT RUN |
| 10 | Dirty baseline | User staged/unstaged/untracked work is preserved; accept/commit refuses attribution conflicts | NOT RUN |
| 11 | Accepted commit | One parent-only commit per accepted evidence; no unrelated staging; no push | NOT RUN |
| 12 | Final integration gate | Roadmap-level checks run against the latest workspace; a failure keeps the run non-complete | NOT RUN |
| 13 | Pause/stop | Quiesce before lease release; stop retains edits and states that rollback is not automatic | NOT RUN |
| 14 | Desktop generic contract | Two unrelated extensions render arbitrary modes/actions; no Workflow-specific parsing | NOT RUN (automated fixture coverage exists, live host signoff missing) |
| 15 | macOS Terminal launcher | Real window, spaces/Unicode path, resume without assignment text, authorized wake starts once | NOT RUN (no macOS host available) |
| 16 | Linux/tmux launcher | Same as 15 on a real Linux desktop/server | NOT RUN (no Linux host available) |
| 17 | Unsupported host/SDK | Native child tabs are reported unavailable; ordinary Build still works | NOT RUN |
| 18 | Tab → “work on our current discussion” | No `/build` request; preparation binds a discussion snapshot; preview shows the derived requirements; zero children before approval | NOT RUN |
| 19 | `/orchestrator start [path]` | Same preparation service as the tool; bare `/orchestrator` still only enters the mode | NOT RUN |
| 20 | Preview approve/refine/cancel | Approval requires the displayed `preview-<id>`; refine voids it durably; cancel launches nothing; a stale id is refused | NOT RUN |
| 21 | Same-length edit to an already-dirty file | Candidate revision changes; acceptance does not treat it as unchanged | NOT RUN |
| 22 | Configured Plannotator handoff | The browser opens FIRST (no pre-review destination picker, no settings write); Approve then shows the execution chooser | NOT RUN |
| 23 | Native handoff ordering | The sheet asks Approve/Feedback/Skip about the plan only; approval then opens the separate execution chooser | NOT RUN |
| 24 | Cancel the execution chooser | Plan stays approved in Plan, no run/turn starts, settings unchanged; `/handoff continue <id>` resumes and an unchanged plan executes only after the choice | NOT RUN |

## Automated evidence (context, not live signoff)

- Workflow: generated transition invariants, real fake-agent process crashes,
  workspace/lease/baseline edges, journal torn-write recovery, Desktop contract
  fixtures and the full extension suites.
- Desktop: two unrelated fixture extensions, source-bound related-session
  ownership, stale epoch/reload, duplicate request replay.
- Missing: real provider runs, real TTY/window rendering, macOS/Linux
  automation permissions, app packaging signoff.

## Known capability gaps to verify live

- SDK 1.5.0's anonymous event bus is **not** publisher authentication. The
  container action path validates that a host command exists, not that the
  publisher owns it. Extensions remain trusted executable code.
- Persisted session creation is distinct from an authorized assignment turn.
  The live run must prove resume stays idle and one correlated wake starts the
  assignment exactly once.
- OS terminal automation is not a standard Pi extension API; missing launchers
  must pause with setup guidance, never create hidden workers.

## Signoff

| Field | Value |
| --- | --- |
| Operator | |
| Date | |
| Pi Desktop version | |
| Workflow version | |
| Models/providers | |
| Host OS + terminal | |
| Passed cases | |
| Failed/blocked cases (with evidence) | |

## 2026-11-22 simplification — evidence recorded

The propose → preview → execution-approval pipeline was removed. The live
matrix below was **not executed** in this change: it needs real Terminal/Desktop
windows, real provider turns and packaged hosts, none of which are simulated by
the test harness. Do not read the automated suite as a live pass.

| Case | Status | Evidence / note |
| --- | --- | --- |
| Plan approve → neutral chooser → Orchestrator → frozen TODO → visible Build child → report → verify → accept → next row | **NOT RUN** | Needs a real Terminal/Desktop child and provider |
| Plan approve → direct Build (frozen list, status-only) | **NOT RUN** | Needs a real UI session |
| Plan approve → feedback stays in Plan | **NOT RUN** | Needs the real questionnaire |
| Standalone `/orchestrator` → discussion → `orchestrator_start` | **NOT RUN** | Needs a real model turn |
| Child report → verify → accept → automatic next dispatch | **NOT RUN** | Composed unit tests cover the reducer/tool path only |
| Child failure → scoped repair (≤2) → block | **NOT RUN** | Reducer tests cover the cap |
| Dispatch failure (SDK/host/`wt.exe` missing) leaves a retryable row | **NOT RUN** | Fake-host tests cover the refusal text |
| Reload mid-run restores rows/states, no duplicate child | **NOT RUN** | Journal replay is unit-tested |
| Build source edit does not renumber rows | **NOT RUN** | Snapshot immutability is unit-tested |
| Neutral chooser: no recommendation, no saved default, asked every time | **NOT RUN** | Codec/view tests cover the neutrality |
| Legacy pending decision still parses; legacy run not resumed | **NOT RUN** | v1/v2 codec tests cover the parse path |

Automated gates that DID pass on 2026-11-22:

- `agent/extensions/workflow`: `npm run typecheck` clean; `npm test`
  **1247/1247**; `npm run check:read-policy` pass; `npm run check:policy`
  **100/100** in a disposable HOME.
- repo root: `npm test` **80/80**; `npm run verify -- --packages workflow`
  **79 files ok**.
- LSP diagnostics on the changed files were **inconclusive** (timeouts; `index.ts`
  exceeds the 5000-line LSP limit). Typecheck is the authoritative compiler
  evidence; LSP is reported separately.
