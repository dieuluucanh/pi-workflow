# Orchestrator operation, migration and compatibility

Current contract for **Workflow 0.17.5** (2026-11-27). Orchestrator remains
**experimental**: automated verification is not real-provider or visible-host
acceptance. The [package README](../agent/extensions/workflow/README.md#orchestrator-experimental)
is the detailed reference; legacy acceptance records are historical evidence,
not instructions for this release.

## Entry and approval

- `/orchestrator` or the mode cycle enters the mode and launches nothing.
- Plan approval and execution destination are separate decisions. Every approved
  plan offers Direct Build, Orchestrator and Decide later, with no saved default
  or recommendation. Feedback returns to Plan.
- `/handoff continue <decision-id>` reopens a cancelled destination choice for
  an unchanged approved plan. Headless users approve with `/handoff approve <id>`
  and explicitly choose `/handoff execute <id> orchestrator|build`.
- `/orchestrator start [path]` records the approved plan and sends a kickoff.
  Without a path it uses the current/last plan or refuses with path guidance.
  The model calls `orchestrator_start` with one row per agreed step and declared
  roots. It then explicitly dispatches a row; start itself launches no child.
- Plans are ordinary markdown. There is no compiler, frozen contract, check
  preview, journal, automatic diff/check acceptance, repair budget or final gate.
  See [plan format](plan-format.md) and [migration](plan-migration.md).

## Parent and child responsibilities

1. The parent calls `orchestrator_dispatch` with the row's complete instruction,
   verification requirements and any corrections. Admission returns promptly;
   the parent ends its turn rather than polling status.
2. One SDK Build child runs **inside the same Pi process**, with its own model,
   in-memory session, task-local TODOs and fresh Workflow extension instance.
   There is no child tab/window or external worker/IPC chain. Separately
   installed extensions do not load in the child.
3. The child owns implementation and verification under normal Build write,
   folder, read, commit and shell policies. Declaring a root is not a grant.
   The parent may inspect and manage its TODOs, but cannot edit/write or use
   mutating shell while the child is starting, running or settling.
4. A settle records a deterministic `Status:`/`Todos:`/`Cancelled:`/`Open:`/
   `Policy refusals:`/`Suggested:` report, releases the child and steers the
   report to the parent. A report is not automatic acceptance.
5. The parent trusts the report, marks the row through `workflow_todo` and
   explicitly dispatches the next row. It does not re-run the child's checks or
   fix the code itself. Verification commands are ordinary visible bash.
6. An in-scope blocker (unfinished code or failing checks) goes to
   `orchestrator_retry` with amended `instructions`. An external policy or
   user-only blocker is not retried: the row is settled and the parent's final
   report discloses the incomplete action and reason, not false success.

A child cannot delegate further or accept the parent's row. It follows normal
Build commit policy; there is no parent-only commit ledger. Neither mode entry
nor plan approval grants permission to bypass policy or push changes.

## Tools and operator commands

Parent tools: `orchestrator_start`, `orchestrator_dispatch`,
`orchestrator_status`, `orchestrator_retry`, `orchestrator_abort`.

```text
/orchestrator                       # enter mode only
/orchestrator start [path]          # send kickoff for approved/agreed work
/orchestrator status                # run, progress, child and next row
/orchestrator inspect [rowRef]      # root, instruction, report and child detail
/orchestrator pause                 # pause live child; keep warm session
/orchestrator resume                # continue paused child or use recovery path
/orchestrator abort                 # release live child; row remains retryable
/orchestrator retry [rowRef]        # fresh child with stored instruction
/orchestrator stop                  # dispose child and cancel run
/orchestrator say <text>            # message running/paused child
/orchestrator view [child|parent|auto]
/orchestrator help [verb]
```

Use the tool's amended `instructions` when retry needs a correction; the slash
retry reuses the stored instruction. The old hyphenated command family and
`preview|approve|refine|finalize|cancel` verbs are removed (`stop` replaces
`cancel`). `/review` also uses a verb grammar; review starts only in Plan.

## Ownership, recovery and completion

- Ownership follows execution phase, not the mere existence of a run record.
  Prose reaches a running child, queues for a paused child, and receives a wait
  notice while starting/settling. Dormant records do not lock ordinary prompts.
- With no live child, a list whose rows are all completed/cancelled transitions
  to `completed`. A recorded failure or abort takes precedence and preserves an
  interrupted/paused outcome and reason.
- Completed/cancelled runs are sealed: dispatch, retry and resume cannot revive
  them. A new start replaces a terminal or fully settled run once no child is
  live. Stop is the escape if the rows can no longer settle.
- Abort preserves an existing report and leaves the row retryable. A settled
  child reports nothing to abort instead of overwriting its report.
- Reload restores the current run record but never auto-launches work. A
  running phase becomes interrupted because its child was lost; explicit retry
  starts a fresh child. An idle run between rows retains its report and can
  dispatch the next row. Old frozen snapshots/journals are not migrated.
- Edits remain after abort, stop or provider failure; none rolls back files.
  Shell quarantine persists across reload; use the explicit user-owned reset
  when appropriate, never claim an unavailable check passed.

## Panels and model switches

`/orchestrator view` selects the parent or child TODO panel and telemetry.
`/todos` and Terminal `Ctrl+Alt+O` target that active panel. Child Auto/Show/
Collapse/Hide preference is independent and scoped to its run; parent preference
remains plan-scoped. `/todos clear` refuses in child view. Generic host action
groups expose the same choices, including empty/headerless states.

Profile/role changes switch live owners in place at the next provider request,
without aborting the current request. Each owner gets a durable model-switch
audit, while activation summaries use one info notice per command. A child-local
profile choice never changes the parent's launch model or global defaults.

## Multiple repositories and compatibility

A run declares at most eight repository roots. The session root is primary;
roots are resolved and duplicate, broad, missing or overlapping declarations
refused. A row names one root (`workspace` for a non-primary root); cross-repo
work uses multiple rows. Dispatch cwd must resolve within declared roots.

Generic contribution v1 remains additive: older hosts keep supported rows and
ignore unsupported kinds. Missing host capability must be reported honestly,
not inferred from status prose. Publishing npm Workflow does not stage a Pi
Desktop bundle; verify that repository's lock and artifact separately.

## Acceptance limits

Real-provider turns, Terminal/Desktop rendering, live reload and packaged
Desktop behavior remain human acceptance work. The SDK event bus is not
publisher authentication and extensions are trusted executable code, not an OS
sandbox. See [live acceptance](orchestrator-live-acceptance.md); historical
engine checks there do not verify the current dispatcher.
