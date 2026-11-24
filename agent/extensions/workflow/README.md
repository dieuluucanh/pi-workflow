# @dieulc/workflow

Plan↔Build mode with an independent **Review Mode** reviewer, questionnaire, subagent explore, todos and shadow-checkpoint rewind for Pi.

## 2026-11-24 — model-driven Orchestrator

The frozen plan contract and the automatic acceptance engine are removed. The
current flow is:

1. **Plan Mode** writes a normal markdown plan. No schema, no executable-check
   block, no `plan_validate`, no freeze gate.
2. **Review (optional)** submits findings and required revisions. The harness
   appends one `## Reviewer Revisions` section; it never rewrites the plan body.
3. **Approve**, then choose **Direct Build** or **Orchestrator**.
4. The approved plan is immutable by prompt convention. Build and Orchestrator
   implement it; neither edits it.
5. **Orchestrator** reads the plan, seeds a mutable TODO list, and dispatches
   one in-process Build child per row with a complete instruction. The child
   owns its local TODO list, runs the step's verification/gates, fixes in-scope
   failures, and reports success or an out-of-scope blocker.
6. The parent trusts a successful report, marks the row done, and dispatches the
   next row. On a blocker it inspects the root cause, amends the instruction and
   re-dispatches. The parent does not fix code itself and does not re-run the
   child's checks.

Removed: `plan_validate`, `/plan lint`, `/workflow lint`, the freeze gate, the
frozen v1/v2 snapshots, the NDJSON run journal, the diff gate, per-row check
execution, repair rounds, the final-gate marker, `migration-scan` and the
migration-report script. Old runs are not resumed; restart from the approved
plan. The Orchestrator parent now has the same permissions as Build; delegation
is a prompt convention, not a mechanical cage.

## Features

- **Plan / Build duality** — `Plan` tool gating (`edit`/`write` blocked in plan), `Build` restores full tools; **Tab** completes the highlighted suggestion while a list is open and otherwise cycles Default → Plan → Orchestrator → Build (`Ctrl+Alt+P` always cycles; a managed worker omits Orchestrator), `--workflow-plan` flag. Hosts that render generic contributions (Pi Desktop) get one current-mode control bound to the same cycle through `/workflow-cycle`.
- **Review Mode** — an independent reviewer agent that runs **after** Plan Mode finishes (sequential — never in parallel), in its own in-process session. It audits the plan, appends its findings and required revisions as a `## Reviewer Revisions` section, streams its work into the main transcript, and hands the result to the configured presenter (`/handoff`: Plannotator, or the workflow's native questionnaire). If Plannotator is unavailable or answers with an error, the handoff falls back to the native questionnaire (the plan is printed into the transcript, the choices are pinned at the bottom). Off by default; see [Review Mode](#review-mode) below.
- **Questionnaire** — 1–4 questions with headers/options, dedup freeform aliases, and an inline `↳ Your answer:` editor. Rendered as a bounded bottom-sheet overlay: a short question and the choices stay pinned, while a long question or the optional `context` body (e.g. a proposed commit message) scrolls with the wheel, `PgUp`/`PgDn` or `Ctrl+U`/`Ctrl+D`. The freeform editor takes the pane while typing.
- **Explore (subagents)** — parallel `pi --mode json` subagents (`max 8`, concurrency 4), `session_shutdown` kill, `activeSubagents`
- **Todos** — plan-faithful todo list (global step refs + statuses + phase groups) that persists across Plan/Build/Default modes. `workflow_todo` (`list/update/done/pending/add/toggle/clear`) with industry-style wholesale `update` (send the COMPLETE list; omitted items are removed) plus idempotent `done`/`pending`, lenient `[DONE:<ref>]` markers, throttled Claude-Code-style reminders, a tool-result footer, and a stale ⚠ notice — but **no forced turns and no heuristic auto-completion** (reference: Claude Code / OpenCode / Codex practice). A pinned panel shows the active list, collapses to one summary line when every step settles, and is controlled by `/todos show|expand|collapse|hide|auto` or `Ctrl+Alt+O` (terminal Pi). In Pi Desktop the native Todo bar above the panel exposes the same verbs and the desktop chord is `Ctrl+Alt+L` (Sessions keeps `Ctrl+Alt+O`). The display choice is sticky for the current plan across Build edits and Review re-syncs; a different plan returns to automatic.
- **Rewind** — shadow bare-repo checkpoints per cwd (`agent/checkpoints/checkpoint-<slug>.git`), `isDirty` + `createSafetySnapshot` + `restoreCode`
- **Plannotator bridge** — `plannotator:request/review-result/plan-approved` events, with a native handoff fallback (the plan is printed into the transcript as a durable entry; a bottom-sheet questionnaire offers Approve / Feedback / Skip). `workflow.handoff` + `/handoff` choose between `auto` (default), `native` (never open the browser) and `plannotator` (always try, native fallback). **Approving the plan and choosing where it runs are two separate decisions:** the configured presenter asks about the PLAN first, and only an approval opens the execution chooser (Orchestrator or direct Build). `getUtcPlanStamp` / `normalizePlanPath` for `.pi/plans/<UTC-date>-<UTC-time>-<slug>.md`
- **Model roles** — Planner/Explorer/Builder roles with one model + thinking level each (`roles.ts`, `~/.pi/agent/roles.json` v2). `/plan` switches to the planner model, `/build` to the builder model, `explore` subagents use the explorer model. `/role` opens a tabbed picker (scoped models first, `Ctrl+O` for all). The thinking list follows the selected model's `thinkingLevelMap`; unsupported stored levels are clamped on save/activation with a warning.
- **Write permission** — a user-controlled `allow`/`ask`/`never` permission for file writes in **Default** mode, the mode that is otherwise ungated. `/write-policy` sets it; see [Write permission](#write-permission) below.
- **Shell guard** — finite native deadlines for every shell surface (120 s default, 900 s ceiling), a pre-launch refusal for provably empty interpreter-stdin heredocs, and a request-scoped recovery budget: one changed approach, then stop. Covers main `bash`/`powershell`, explorer subprocesses and the isolated reviewer's `review_bash`; never times out human dialogs. See [Shell guard](#shell-guard).
- **Model profiles** — named combinations of role models (`profiles.ts`, `~/.pi/agent/profiles.json` v1). Create a profile per provider or per budget, switch with `/profile` — activation is session-scoped, so two concurrent sessions can run different profiles. With no profile active the roles.json flow applies unchanged. See [Model Profiles](#model-profiles).
- **Orchestrator (experimental)** — opt-in model-driven dispatcher: the parent reads the plan, seeds mutable TODO rows, dispatches one in-process Build child per row with a complete instruction, trusts a successful child report, and re-instructions on a blocker. No frozen snapshot, no diff gate, no parent-side checks. The parent has Build permissions; delegation is a prompt convention. See [Orchestrator](#orchestrator-experimental) below.
- **Prompt refinement (`/prompt`)** — rewrite a drafted request in an isolated child session and hand the candidate back to the *composer* — never send it, never run it. `/prompt <draft>` is the Terminal entry; a Desktop host arms the same runtime through the typed `composer-transform-v1` capability (a one-shot composer control, not slash concatenation). `/prompt-model` gives it an independent model, Default-mode inheritance is the fallback, and the main session model, roles and profiles are never touched. Refinement is bounded (inspect → ask → compose → submit), policy-safe, cancellable and recoverable. See [Prompt refinement](#prompt-refinement) below.

## Install

```bash
pi install npm:@dieulc/workflow            # latest
pi install npm:@dieulc/workflow@0.1.0      # pinned
pi install -l npm:@dieulc/workflow         # project-local (.pi/settings.json)
pi -e npm:@dieulc/workflow                 # try without installing
```

Manage it with `pi list`, `pi update --extensions`, `pi remove npm:@dieulc/workflow`. Requires Pi on Node ≥ 22.19; the Pi core packages (`@earendil-works/*`, `typebox`) are provided by Pi at runtime and declared as peer dependencies.

## Commands

| Command | Description |
| --- | --- |
| `/plan` / `/workflow` | Enter plan mode (tool gating + switches session model to planner model `high` thinking) |
| `/build` | Enter build mode (full tools + switches session model to builder model `medium` thinking) |
| `/rewind` | Pick checkpoint to restore |
| `/todos` | List steps, or control the pinned panel: `/todos [show\|expand\|collapse\|hide\|auto\|clear]`. No arg lists everything; `clear` asks first when UI is available (headless clears immediately) |
| `/btw` | Queue note for next turn |
| `/role` | Config screen: one model + thinking per role (planner/explorer/builder/reviewer tabs, custom roles included; type to filter models by `provider/id` or display name). CLI: `list`, `set <role> <provider/model> [thinking]`, `use <role\|auto>`, `add/remove/reset` |
| `/profile` | Switch or manage model profiles (named role-model combinations). Picker: activate / edit / rename / delete / New profile… / Default… (fuzzy type-to-filter; completed actions close the picker). CLI: `list`, `show <name>`, `use <name\|none>`, `create <name>`, `edit <name>`, `rename <old> <new>`, `delete <name>`, `default [name\|none] [global\|project]`, `retarget-provider <old> <new> [global\|project] [--apply]` |
| `/prompt <draft>` | Refine the drafted request in an isolated child session and return it to the composer without sending or running it. Literal arguments; empty shows usage. Handled by the host on a Desktop build that advertises the structured composer capability (use the composer's **Refine prompt** control there); the Terminal path writes only the editor. Never starts a task, mode, plan, todo, checkpoint, review, handoff or Orchestrator dispatch |
| `/prompt-refine [on\|off]` | Toggle the one-shot composer arm (the control a `composer-control` publisher exposes). Armed means the next **Send** refines the draft and returns it in place; it does not run the task. `off` cancels/disarms a live operation. No model, session or runtime work happens on the toggle itself |
| `/prompt-model [status]` | Show the effective prompt-refinement model and thinking level, its source (trusted project / global / Default-mode inherit) and any shadowed scope. `set <provider/model> [thinking] [global\|project]` saves a validated override; `inherit [global\|project]` writes an explicit inherit sentinel (a trusted project inherit suppresses a global override); `reset [global\|project]` removes only that scope. Never changes the main session model |
| `/review-mode [on\|off] [global\|project]` | Enable/disable Review Mode (default `off`). `status` prints the effective config, naming the settings file that supplied the timeout, and any shadowed scope. `off` is allowed while a finished handoff is pending (it becomes a plain handoff) but refused while a reviewer round/pause/gate is active (`/review-abort` first) |
| `/review-mode timeout <seconds\|unlimited> [global\|project]` | Set or show the per-pass time cap (`unlimited`/`0` = no cap). Writes only `timeoutMs` to global settings by default; it never pins `enabled` |
| `/review-prompt [global]` | Edit the reviewer's guidance (defaults to "align with the existing framework and industry best practice") |
| `/review-status` | Show review phase, model, plan hash, findings and any error |
| `/review [path]` | Run a one-shot review round now, **in Plan mode only**. Without a path it uses this run's plan write, then the session's latest plan write; works with Review Mode on or off (mode stays OFF). Outside Plan it refuses with guidance (`/plan`, then `/review`) and never switches modes implicitly. An explicit path must be under `.pi/plans/` |
| `/review-pause` | Pause the in-flight review round (keeps the reviewer session warm). Same as ESC while a review owns the turn |
| `/review-resume` | Continue a paused round on the warm session, or start fresh if the plan changed since the pause. **Plan mode only**; a refused resume keeps the pause intact for `/review-abort` |
| `/review-abort` | Stop the round or discard the pause. A waiting handoff is handed off to the author's plan through the native questionnaire — never re-opened in Plannotator. Releases the mode-switch and prompt locks |
| `/handoff [auto\|native\|plannotator] [global\|project]` | View or set the plan handoff target (`workflow.handoff`). `auto` (default) uses Plannotator when a host is detected, `native` never opens the browser, `plannotator` always tries. Refused while a handoff prompt is open — use the next command instead |
| `/handoff execution orchestrator\|build [global\|project]` | Set the saved execution RECOMMENDATION. It seeds the chooser's first row and never executes anything by itself |
| `/handoff approve <decision-id>` | Stage 1 only: approve the PLAN by the id printed with it. An interactive session then opens the execution chooser; a headless one prints the stage-2 commands |
| `/handoff continue <decision-id>` | Reopen the execution chooser for an approved plan (e.g. after cancelling it, or after a reload) |
| `/handoff execute <decision-id> orchestrator\|build` | Stage 2 explicitly, for headless use or after cancelling the chooser. Refused before approval, or for a changed/consumed/uncertain decision |
| `/handoff fallback` | Present a pending PLAN review in the native questionnaire now, without changing `workflow.handoff`. The escape when the in-app review tab is blank or unusable. An approved plan uses `/handoff continue` instead |
| `/commit` | Commit staged changes with an AI-summarized message (`-a`: stage tracked changes first). Confirmation-gated; the confirmation arms the commit exemption for that run |
| `/commit-policy [never\|ask\|allow] [global\|project]` | View or set the commit policy (default `never`: the agent cannot `git add`/`commit`/`push` — you commit, or use `/commit`) |
| `/write-policy [allow\|ask\|never] [global\|project]` | View or set the write permission for Default mode (default `allow`: the agent writes freely; `ask` prompts per write; `never` blocks writes — see [Write permission](#write-permission)) |
| `/folder-policy [repo\|cwd\|parent\|any] [global\|project]` | Shared folder scope for read, write **and** commit (default `repo`: nearest `.git` root, fallback cwd). `outside ask\|block`, `grant project\|global`, `templates allow\|block`, `sensitive`, `exclude [add\|revoke\|list] <glob> [--global\|--project]` |
| `/read-policy [status\|allow <path>\|revoke <path>\|shell paths\|strict] [global\|project]` | Read grants, shell analysis mode and the shared folder scope. Sensitive files are always blocked |
| `/permissions [explain] <command>` | Explain a shell command's verdict without running it: each segment's class, the Plan/Review/Explorer answer and whether the write policy would treat it as a write |
| `/shell-guard [status]` | Show the effective shell deadlines, their settings source, and this request's failure budget. `/shell-guard limits <default-seconds> <max-seconds> [global\|project]` sets them; `/shell-guard reset` clears a tripped request while idle |
| `/default` | Switch to Default mode (no workflow gating, full access) |
| `/workflow-cycle` | Cycle the workflow mode (Default → Plan → Orchestrator → Build); the host-bound equivalent of `Tab`/`Ctrl+Alt+P` |
| `/orchestrator` | Enter Orchestrator mode, or run an operator command: `status`, `start [path]`, `pause`, `resume`, `stop`, `inspect`, `say`, `retry`, `cancel` |
| `/orchestrator-pause` | Pause the in-process Build child (warm session kept) |
| `/orchestrator-resume` | Resume a paused in-process Build child on the warm session |
| `/orchestrator-abort` | Abort the in-process Build child and pause the run |
| `/orchestrator-view [child\|parent\|auto]` | Show the current Orchestrator child view in the pinned panel and footer |
| `/prompt-refine-companion` | Internal grant-only bootstrap a `composer-transform` host invokes for prompt refinement; not a normal user command |

Mode commands (`/plan`, `/build`, `/default`) and the `Tab` / `Ctrl+Alt+P` shortcuts are refused while a **reviewer round or review-owned handoff** owns the turn — `running`, `paused`, or a handoff produced by `/review`/Review Mode, or applying one (Tab still completes a visible suggestion list); see [Controlling a running review](#controlling-a-running-review). A **plain plan handoff** (Review Mode off) does not lock modes or prompts: switching or typing a new prompt supersedes it, and the plan file stays on disk.

## Orchestrator (experimental)

Orchestrator mode is an opt-in engine for a long, phased roadmap. It is
**experimental**: the contracts, reducers and live composition are implemented
and tested, but real provider turns and visible-host acceptance still require a
human run (see below). Entering the mode changes nothing by itself and ordinary
short Plan → Review → Build work keeps its current behavior.

### Core rules

- **Mode entry is not execution.** Tab or `/orchestrator` enters the mode;
  nothing runs until the user approves a plan (or explicitly agrees the
  standalone steps) and picks an execution destination.
- **The model owns the row list.** After the discussion is agreed the model
  calls `orchestrator_start` with one step per row (a string, or
  `{text, workspace}` for a non-primary root) and the workspaces the plan
  declares. The extension records the rows and the resolved roots; it does not
  compile or validate the plan.
- **Neutral destination every time.** An approved plan always asks: direct
  Build, or Orchestrator, plus *Decide later*. Both options are equal: there is
  no saved default, no recommendation and no `/handoff execution|once`.
  Feedback keeps the session in Plan.
- **Direct Build stays in-session.** It receives one plain kickoff, keeps any
  rows the model already created and has no freeze/merge step.
- **The child is an in-process Build session — no window or tab.** Each row
  runs in a second SDK session inside the same Pi process with the row's root
  as `cwd`: its own model runtime, an in-memory session and a fresh Workflow
  extension instance. It gets the Workflow-managed Build tool set and every
  policy gate (write, folder, read, commit, shell), creates its own task-local
  TODO list before the first edit, and never orchestrates or edits the parent
  run. A managed child is exempt from the parent/child worktree exclusion; the
  parent itself is refused edit/write/mutating shell while a child is live.
- **One panel list authority.** The session `TodoStore` is the list the pinned
  panel renders and the list `workflow_todo` mutates; a child has its own.
- **The parent trusts the report.** A settled child's report wakes the parent
  with `workflow_todo`/`orchestrator_dispatch` instructions. The parent reads
  it, marks the row done with `workflow_todo`, and dispatches the next row. It
  does not re-run the child's checks and does not fix code itself.
- **Blockers stay visible.** A blocked report leaves the row in progress: the
  parent inspects the root cause, amends the instruction and re-dispatches
  (`orchestrator_retry` reuses the stored instruction).
- **Reload is a lost child.** `restoreOrchestratorRun` restores the record; a
  `running` phase becomes `interrupted` and the footer says so. Old journals,
  frozen snapshots and run directories are never read or migrated.
- **Verification is ordinary bash.** The model runs the plan's
  `## Verification` before the last row is marked done and states exactly what
  it ran. There is no hidden gate, no `workflow_execution` tool and no final
  check executor.
- **Cross-repo work is multiple rows.** One row, one root. `cwd` is a declared
  alias or an absolute path inside a declared root; an unknown or ambiguous
  root is refused rather than guessed.

### Host contract

Plan/Build/Review/TODO presentation is published through a generic, bounded host
contract. Pi Desktop renders arbitrary extension modes, actions, input
availability and related sessions without parsing Workflow names; related-session
ownership is derived from a registered command's source info, not from an owner
string in the payload. Two unrelated fixture extensions cover this contract in
both repos (`fixtures/two-extension-contract.json`).

Orchestrator no longer requests a Desktop related session or a new tab. The
`related-session` contribution kind and `session-host.ts` remain as the generic
host contract for other features; Workflow's own use of them is gone. Pi Desktop
may still show the Orchestrator status/actions rows published here.

#### Composer transform (frozen wire contract)

`composer-transform.ts` freezes the additive `composer-transform-v1`
capability that lets any extension refine the live composer draft without
sending it. The same wire format is read independently by Pi Desktop
(`src/shared/composer-transform.ts`);
`fixtures/composer-transform.conformance.json` is copied byte-for-byte into
Desktop's `tests/shared/fixtures/` and both suites assert the same SHA-256 and
verdicts.

- **Contribution.** A `kind: "composer-control"` row uses the
  `composer-actions` slot, a closed semantic icon list, checked/enabled/disabled
  reason, and an explicit `one-shot-return` (or `persistent`) behaviour. Its
  same-owner `actionRef` toggles refinement and `transformActionRef` starts the
  operation; the host resolves both live actions and their registered commands
  and refuses a foreign or wrong-kind id. The renderer never supplies command
  text.
- **Operation metadata and source binding.** `operation` names the public input
  command and the registered bootstrap companion. The host resolves both from
  live SDK registrations and requires the same `sourceInfo` (`path`, `source`,
  `scope`) — matching names alone are not authority. A foreign command or
  companion is refused before any work starts.
- **Transport.** Start request, started receipt, progress, candidate result,
  status, cancellation, apply receipt and lifecycle failures are separate
  bounded frames. Drafts, expanded paste text, image bytes, model/provider
  context and grants never travel through contribution `command.args`; the old
  static 1 000-character args limit is deliberately unchanged. Attachment
  identity/digest metadata stays separate from optional in-band image bytes, and
  diagnostics expose counts/ids/revisions only (never draft text, digest,
  bytes, model or context). The request carries binding/session/epoch,
  contribution revision and a live draft snapshot with a monotonic draft
  revision; duplicate request ids join/replay, conflicting reuse is refused.
- **Bootstrap/rendezvous.** SDK 1.5 registers string-only command handlers, so
  the companion receives a **grant-only** JSON bootstrap. The host installs a
  single-use, unpredictable request-scoped listener on the existing in-process
  EventBus *before* invoking the companion; the grant id selects the private
  channel and a random proof must match. Exactly one claim is accepted and the
  typed port is handed directly to the companion callback. Prompt/image data
  never touches the bus, command string, status row or logs; listeners are
  removed on claim, expiry, rejection and teardown. The handshake is tested
  against the unmodified SDK 1.5 `EventBus` and a real string command handler in
  `composer-transform.test.ts`.
- **Old hosts and fallback.** Contribution v1 stays additive: an older Desktop
  drops the unknown `composer-control` kind and keeps rendering supported
  status/action rows plus the public text command. `composerTransformFallback()`
  explicitly reports `nativeControl: false` and `attachmentAware: false`; a
  text-only fallback never promises attachment-aware transformation.

### What is wired, and what still needs a live run

- **Wired in the entrypoint:** the four-mode ring, a fresh authoritative
  mission injection, `orchestrator_start` (plan path or explicit steps), the
  frozen TODO snapshot and its persistence, the automatic settle →
  report → diff → checks → verify → accept → next-row engine, the parent tools
  (`orchestrator_start|status|retry`), the child lifecycle controller, the
  transcript entries and the operator commands (`/orchestrator status|start|
  pause|resume|abort|stop|inspect|view|say|retry|cancel` plus the
  `/orchestrator-*` aliases), and the neutral execution chooser.
- **Child composition:** one in-process SDK session per row with
  `noExtensions: true` + this extension as the only additional path, an explicit
  Workflow-managed Build allowlist (`questionnaire` and `orchestrator_*` are
  excluded), the parent UI bridge for permission dialogs, and a registered
  teardown that runs after `AgentSession.dispose()` (which never emits
  `session_shutdown`).
- **Runtime-owned evidence:** the engine captures the baseline and the diff,
  runs the checks through the gated executor and applies acceptance itself. No
  model-supplied evidence exists.
- **NOT RUN:** real provider/model turns, real terminal/Desktop rendering of the
  child transcript entries, and `/reload` in a live TUI. See
  [`../../../docs/orchestrator-live-acceptance.md`](../../../docs/orchestrator-live-acceptance.md)
  for the exact human matrix (currently **NOT RUN**).
- The installed SDK's anonymous event bus is not publisher authentication;
  extensions remain trusted executable code. Privileged host operations require
  the host-issued, registration-bound grant, and a host without that seam is
  advertised unsupported.


### Approval has no lint or check preview

Approval is a plain confirm plus a destination choice. No code compiles the
plan, previews executable checks or gates the approval on a check list:

- there is no `plan_validate` tool, no `/plan lint`, no `/workflow lint` and
  no `checkPreview` in the handoff questionnaire;
- a plan with indented headings, no `## Verification`, or prose-only
  verification is approved like any other plan;
- the model reads the plan and runs its `## Verification` as ordinary bash
  when it gets there; the real command and its output are visible.

### Plan format

A plan is a normal markdown document, usually
`.pi/plans/<UTC-date>-<UTC-time>-<slug>.md` (for example
`.pi/plans/2026-11-24-2130-export-endpoint.md`). The UTC `HHmm` time makes
same-day plans sort by creation time. Legacy date-only names
(`.pi/plans/<UTC-date>-<slug>.md`) remain valid and are **never renamed**: an
existing plan is written in place, and only a new file gets a prefix.

```markdown
# Plan: Add the export endpoint

## Context

Why this change is needed.

## Steps

1. Add the route and its handler.
2. Cover the happy path and the validation error.

## Verification

- `npm run typecheck`
- `npm test`
```

`## Steps` (or a numbered list under `## Plan Steps`) is the human plan; the
model turns it into TODO rows with `workflow_todo`. `## Verification` is a
normal list of commands the model runs before the last row is marked done.
Nothing parses the plan, validates a schema, compiles checks or reads
`Acceptance:`/`Files:` metadata at runtime. Old plans with those sections are
still readable — the extra sections are simply prose.

### Multi-repository workspaces

One row targets one repository root. The model declares the roots it needs:

```json
{
  "steps": [
    "Add the endpoint",
    { "text": "Update the client", "workspace": "B" }
  ],
  "workspaces": [
    { "id": "A", "path": "C:/work/api" },
    { "id": "B", "path": "C:/work/client" }
  ]
}
```

- The session root is always resolved as a root (`W` when undeclared).
- A step omits `workspace` for the primary root and names one otherwise.
- `orchestrator_dispatch.cwd` may be a declared workspace id or an absolute
  path inside a declared root; otherwise the row's stored root is used.
- A multi-root run with a row that names no root fails closed instead of
  silently running in the primary repository.
- An unknown alias, a missing path, a duplicate alias, a broad root (drive,
  home, system umbrella) or overlapping roots is refused before the run is
  created, with a message naming the declared ids.
- Cross-repo work is multiple rows. A child launched with a row root as `cwd`
  edits only that root; the normal folder/write policy still applies, so
  declaring a root does not grant automatic cross-root writes.

## Shell guard

The guard exists because of the 2026-11-20 `erp-atom` incident: two valid but **empty** `python - <<'EOF'` probes with no `timeout` waited 52m27s and 21m56s before the user aborted them. Pi's Bash tool has no default timeout; the model's `timeout` argument is optional. Prompt advice cannot make that finite, so the guard enforces it at the tool boundary.

- **Every shell surface gets a finite deadline.** The model's omitted `timeout` becomes 120 s; an explicit value is capped at 900 s. Both are user-owned under `workflow.shellGuard` and deliberately finite: no `0`, `off` or `unlimited` escape. A model cannot widen them or edit the settings file.
- **What it covers.** Main `bash` and `powershell`, explorer children (the parent's effective limits are carried in `PI_SHELL_GUARD_LIMITS` and can only narrow the child's own settings) and the isolated reviewer's `review_bash`. Role, folder, read, write and commit policies still run first and keep their own refusal reasons. Human questionnaire/permission waits are not shell execution and are never timed out.
- **Empty probes are refused before launch.** Only a direct Python-family stdin script (`python - <<'EOF'`, including `python3`/`py` and a `.exe` path) with a provably empty body and a simple delimiter is blocked. Non-empty scripts, `-c`/`-m`, script files, quoted `<<`, `<<-`, multiple heredocs and missing terminators keep the finite deadline instead. The refusal says “empty interpreter probe”, never “malformed Bash”.
- **Bounded recovery is nonfatal.** A first qualifying failure (native deadline, empty-probe refusal, invalid timeout value) returns the partial output/error with guidance and allows **one changed approach**. Repeating the same command, or any second qualifying failure in the same execution, **quarantines shell for that execution**; it does not abort the run. Further shell calls are refused, while non-shell tools (`read`, `grep`, `find`, `ls`, `edit`, `write`, LSP diagnostics) remain available. Nothing is replayed automatically, and a timeout never rolls back side effects.
- **Quarantine survives boundaries.** It is not cleared by `agent_end`, compaction, an automatic continuation, a child replacement, a reload or a tree rewind. A required shell check that cannot run leaves its row/run **blocked/unverified**, never green. Only a genuine user prompt or an explicit `/shell-guard reset` starts a new shell budget; the model cannot reset it.
- **Request scope.** The budget resets on a genuinely new idle user prompt, a new/resumed session, a rewind, or `/shell-guard reset` (including while a quarantined execution is active). A steer, follow-up, extension-authored message, native retry or compaction does not re-arm a tripped request.
- **Honest output.** A native timeout keeps the partial output and names the deadline. `/shell-guard status` shows the effective limits, their source, inherited status and the current quarantine; audit entries record the reason, tool, call id, deadline and failure count — never raw command text or output.

## Build completion and reload

Build completion is plain TODO state: when every non-cancelled row is done,
the extension emits the completion card. There is no final gate, no
`workflow_execution` tool and no execution-state machine. Verification is an
ordinary bash command the model runs; its real output is the evidence.

- `/build` switches to Build mode. The pause/resume/stop execution verbs were
  removed with the execution engine; an Orchestrator child is paused or aborted
  with its own controls, and a shell quarantine with `/shell-guard reset`.
- A reload never resumes a run. The stored `OrchestratorRun` restores; a
  `running` phase becomes `interrupted`, the footer says so, and
  `/orchestrator retry` starts a fresh child. Old frozen/journal entries are
  ignored, not migrated: restart from the approved plan.
- A persisted shell quarantine is re-adopted on reload under the `workflow`
  entry's `shellQuarantine` key, so the guard's guarantee survives the session
  boundary without an execution state.

## Model Profiles

A profile is a **named combination of role model settings** — one `{provider, id, thinking}` each for planner, explorer, builder and reviewer. Profiles layer on top of Model Roles: role identity (tools, system prompts, custom roles) stays global in `roles.json`; a profile only overrides models while it is active.

```text
/profile                    # picker: activate / edit / rename / delete / New profile… / Default… (type to filter)
/profile create budget      # name it, then pick model + thinking per role (same flow as /role)
/profile use budget         # activate for THIS session (none = back to the roles.json flow)
/profile edit budget        # re-open the tabbed model editor
/profile rename budget cheap
/profile delete budget      # confirm dialog; deleting the active profile falls back to base roles
/profile default budget     # workflow.defaultProfile — new sessions start on it (global|project)
```

### Semantics

- **What a profile overrides**: model + thinking for the four built-in roles only. Tools, `systemPromptAddendum` and custom roles are global (roles.json) and are never touched by a profile. Partial profiles are allowed in hand-edited files — roles a profile does not name fall back to the base role model.
- **Activation is session-scoped.** `/profile use` changes only the current session and rides the session's `workflow` entry, so `/resume` restores it and **two concurrent sessions can run different profiles** — session 1 on a cheap provider, session 2 on a premium one. There is deliberately no global "active profile" file.
- **Optional default**: `workflow.defaultProfile` (see [Settings](#settings)) seeds sessions that never made an explicit choice; an explicit `/profile use <name|none>` always wins for that session.
- **Effect**: `/plan` switches to the profile's planner, `/build` to the profile's builder, `explore` subagents run on the profile's explorer, and Review Mode's reviewer session uses the profile's reviewer (planner fallback preserved). Activating while in plan/build re-applies the mode model immediately; in Default mode nothing switches until the next plan/build/explore/review use — the manual chat model is never touched by activation.
- **Live children follow the switch.** An Orchestrator Build child and a Review reviewer already running are switched in place (`/profile use`, `/profile` prompt-pick, `/role set`, and the role picker): the in-flight request finishes on the old model and the next provider request uses the new one — no abort, no session restart. A paused child switches before resume. The next child/round always launches on the new model. If the switch is refused (missing model, provider auth), the live session keeps its model, the warning names both, and the next child/round still uses the profile. The child never writes the global default model/thinking.
- **`/role` keeps editing the base roles.** With a profile active, the `/role` picker shows a notice and `/role list` prints the profile's overrides; `/profile edit <name>` is the way to change what actually runs.
- **Fallback**: no profiles (or none active) → the roles.json flow, identical to before profiles existed. A profile referencing a model missing from the registry is warned about at save time and refused at switch time ("staying on current model"), same as `/role`.

**Picker keys**: `/profile` and `/role` are fuzzy-filterable — start typing to narrow models by `provider/id` or display name (e.g. `flash`, `open/beam`, `muse spark`) and profiles by name, marker, description or one of their models. `↑`/`↓` navigate, `Enter` selects/commits (inert when nothing matches), `Tab`/`←`/`→` switch role tabs, and `Ctrl+O` toggles scoped ↔ all while keeping the filter. `Esc` (or `Ctrl+C`) clears a non-empty filter first; a second press backs out or cancels. A completed `/profile` action closes the overlay; Esc-cancel, a failed save and the action menu's Back keep the profile list open, with its filter remembered.

**Why**: mix models from different providers in one workflow (frontier planner + cheap explorer), keep one profile per provider to control budget per provider, run concurrent sessions on different providers to work around per-provider concurrency limits, and exploit cheaper starter plans across several providers.

Profile config lives in `~/.pi/agent/profiles.json` v1 (user) with optional per-project override at `<cwd>/.pi/profiles.json` (per-profile replace, project wins). Names are case-insensitively unique, ≤ 40 chars, no whitespace (keep them CLI-addressable), and `none`/`auto`/`off` are reserved (`off` is a `/profile use` deactivate keyword, so a profile can never be named it). A missing file is the normal empty state; a corrupt or wrong-version file is never rewritten (warning + in-memory empty config).

**Argument completion** follows pi's full-argument contract (the same one pi's `/mcp` uses): accepting a suggestion replaces the entire typed argument text, so completing `/profile use Syn-␣` inserts `/profile use Syn-Deepseek-…` with the subcommand intact — it never collapses to `/profile <name>`. The dropdown closes (and the first Enter submits) once the typed token is already an exact, unique match. This applies positionally to `/profile` (`use|edit|show|delete|rename <old>|default <name> [global|project]`), `/commit-policy` (`never|ask|allow [global|project]`) and `/role` (`set <role> <provider/model> [thinking]`, `use <role|auto>`, `remove <name>`).

## Review Mode

An independent second agent audits the plan before the handoff renders. The handoff waits for the gated round; the reviewed plan (the reviewer writes the plan file mid-round) is what you see, and the todo steps are re-synced to match. The reviewer runs in its own child session, so Plan Mode and Build Mode never see its prompt, findings or transcript.

**The Reviewer is a Plan artifact.** A review round starts only in a parent Plan session: automatically after a plan submitted in this run (when Review Mode is on), or through an explicit `/review`/`/review-resume` in Plan mode. Configuration ON is **not** a trigger, and no reviewer session is pre-warmed speculatively: an ordinary Build turn, an Orchestrator parent turn and every in-process Build child boot **zero** reviewer sessions. Orchestrator row completion is a parent decision from the child report plus `workflow_todo` — it is not a review round and never asks a model to audit a child's work. Outside Plan, a manual start refuses with guidance (`/plan`, then `/review`) and never switches modes implicitly; `/review-status`, `/review-pause` and `/review-abort` stay available for recovery. Automatic review binds to the terminal end of a run: retries, compaction retries, queued messages and continuation boundaries do not review an incomplete plan, and the later terminal attempt owns the handoff.

```text
Plan Mode (main session) ──plan file──▶ Review Mode (child session, gated)
                                              │ rewrites the plan file
                                              ▼
                                   handoff renders the reviewed plan
                                              ▼
        Plannotator webview ◀── plan file + `## Review changes`
                │ approve ──▶ Build Mode (review activity suspends, session stays warm)
                └─ feedback ──▶ Plan Mode revises ──▶ Review re-reviews

  Plannotator unavailable/error/closes ──▶ native handoff (no dead end)
        plan entry printed above ──▶ bottom-sheet questionnaire
        Approve ──▶ Build (verified) ──▶ execute   Feedback ──▶ Plan   Skip ──▶ stay Plan
```

- **Approve** in Plannotator → Build mode; review activity suspends but the reviewer session stays warm for the next round.
- **Feedback** → Plan revises, Review re-reviews the revision, Plannotator reopens.
- **A broken Plannotator is never a dead end.** Every handoff path (automatic, `/review`, `/review-resume`, a closed browser tab) falls back to the workflow's own questionnaire: the plan is appended to the transcript (scroll up to read it), and `Approve plan (choose execution next)` / `Give feedback (stay in Plan)` / `Skip for now (stay in Plan)` are pinned at the bottom. The fallback keeps the SAME handoff record, so its identity and recommendation survive; a late browser event cannot act on the native decision.
- **Approval is not execution.** Approving the plan (in Plannotator or natively) records the approval and immediately opens a second, separate question: *Plan approved — where should it run?* with direct Build and Orchestrator as equal options, plus *Decide later*. No destination is saved or recommended. Cancelling the chooser keeps the approval: the session stays in Plan with no work started, and `/handoff continue <id>` reopens the chooser while the plan is unchanged. Direct Build sends one execute turn in this session; Orchestrator freezes the plan into one TODO row per step and starts the first visible Build child immediately.
- **Any failure** (missing model, unauth'd provider, abort, error) → the author's plan is handed over unchanged with a warning. Review Mode never blocks the plan. A pass whose run ends without a `review_submit_plan` submission fails *immediately* (the settle race), so a silent reviewer cannot hang the round. `timeoutMs` defaults to **5 minutes**; set `0` to opt out into unlimited, and a pass that outlives the cap is aborted — though a plan submitted before the deadline is always kept.

### Enabling

```text
/review-mode on              # global (~/.pi/agent/settings.json)
/review-mode on project      # this repo only (<cwd>/.pi/settings.json)
/review-mode status
/review-mode timeout 600 project # 10-minute cap for this repo only
/review-mode timeout unlimited   # remove the cap entirely (not recommended)
/review-mode timeout              # show the current value and where it came from
```

Turning the toggle off stops the reviewer and restores the single-agent plan/build flow exactly as it was. Nothing in Review Mode runs while it is disabled.

`/review-mode status` reflects what the current process loaded, so `/role` changes and extension edits are picked up on the next `/reload` (or a new session). After `/reload`, the reviewer model, the effective timeout and its settings file (and the absence of the old `flow` row) all reflect the current files on disk.

### The reviewer's model

Review Mode runs in its own session with its own model, taken from the **`reviewer` role** (`/role`). The default seed is deliberately a *different* model from the planner so the review brings an independent perspective — a reviewer that shares the planner's model and thinking tends to share its blind spots.

```text
/role set reviewer opencode-go/muse-spark-1.3-contributor xhigh
```

If the reviewer role has no model, Review Mode falls back to the planner model and warns rather than silently doing nothing.

The model is **snapshotted when a round starts**, but a `/role` or `/profile` switch now also switches the LIVE reviewer session in place (the next provider request uses it, the round is not aborted, and the warm session is kept for the next round). The mode band, the status widget and `/review-status` name the model that is actually auditing. A switch made in the cold-start window (before the session exists) is retained for that first session. If the switch is refused, the live reviewer keeps its model and the next round applies the new one.

Roles load from `~/.pi/agent/roles.json` (with a `<cwd>/.pi/roles.json` project override) **at session start and again whenever either file changes on disk**, so a `/role` change made in another window is picked up without `/reload`. A missing, unreadable, or legacy `roles.json` is never overwritten: the built-in defaults are used in memory and a warning naming the file is shown, leaving it intact. `/review-mode status`, the mode band and the reviewer run all read through the same loader.

### Reviewer guidance

`.pi/review-prompt.md` (project) wins over `~/.pi/agent/review-prompt.md` (global), which wins over the built-in default. Edit it with `/review-prompt`.

The built-in default asks the reviewer to, in priority order: align with the **existing project framework**, follow **industry best practice**, verify every requirement maps to a plan step, check the plan is executable without guessing, and prefer simplicity. Repository context files (`AGENTS.md`, `CLAUDE.md`, …) also load into the reviewer's system prompt, which is where most framework alignment actually comes from.

This guidance lives **only in the reviewer's session**. Plan Mode receives a single neutral line ("a reviewer will audit this plan") and can never see the reviewer's prompt, findings, or transcript.

### Permissions

Plan Mode and Review Mode share one role-based command policy (`permissions.ts`). Review Mode has Plan Mode's permissions: read-only inspection plus test/lint/typecheck runs, and a single plan-write path.

| Tool | Purpose |
| --- | --- |
| `read`, `grep`, `find`, `ls` | Inspect the repository |
| `review_bash` | Shell access on the same role policy Plan Mode uses: read-only inspection plus **test/lint/typecheck** runners (`npm test`, `npm run lint/typecheck`, `eslint`, `tsc --noEmit`, `node --test`, `pytest`, `cargo clippy`, …). No file redirects (`2>/dev/null` and `2>&1` are allowed), no `sed`/`awk`, no `rm`/`mv`/`cp`/`mkdir`/`touch`, no `sudo`, no package installs, no builds, no `git add/commit/push` |
| `review_explore` | Read-only reconnaissance subagents on the **explorer** role's model, capped by `exploreBudget` per round |
| `review_plan_begin` | Starts a **chunked** rewrite: resets the per-round assembler and states the per-chunk size limit |
| `review_plan_chunk` | Appends one ordered chunk of the rewrite (`index` 1, 2, 3, …). Out-of-order, repeated or oversized chunks are refused with the index that is expected next |
| `review_plan_finalize` | Turns the accepted chunks into the plan. Refuses an incomplete assembly; goes through the same `review_submit_plan` funnel, so the plan is written exactly once |
| `review_submit_plan` | The **only** write path: validates and saves the revised plan to Plan Mode's own `.pi/plans/<UTC-date>-<UTC-time>-<slug>.md` (an existing plan keeps its name). Also the one-shot path for short plans |
| `review_pass_done` | Ends a pass with a verdict (refused if nothing was submitted) |

The policy classifies commands into three classes and maps them to roles:

| Role | Command class | Write tools | Used by |
| --- | --- | --- | --- |
| planner | read-only + verify | `.pi/plans/` only | Plan Mode |
| reviewer | read-only + verify | `review_submit_plan` only | Review Mode |
| explorer | read-only | none | `explore` / `review_explore` subagents |
| builder | full (unrestricted) | all | Build Mode / normal sessions |

- **read-only** — inspection only (`ls`, `cat`, `rg`, `git log/blame/ls-files/show-ref`, `npm run` / `yarn run` with no script argument (lists them), `docker logs`, `journalctl`, `base64`, `ss`, `netstat`, `lsof`, …). `sed`/`awk` are deliberately **not** read-only — their programs are code — so they are Builder-only. A **quoted word is data, not a command**: `rg -n "rm -rf" src` searches for a string and is read-only, because the destructive-keyword layer only matches in command position (or anywhere in a segment already classified `full`).
- **verify** — the above plus `npm test`, `npm run lint|typecheck|check`, `eslint`, `tsc --noEmit`, `node --test`, `npm run`/`node --run` with an allowlisted script, `pytest`, `mypy`, `go vet`, `cargo clippy`, … Runners that rewrite (`--fix`, `--write`, `-u`/`-w`/`--update`, `--test-update-snapshots`, `--watch`) — including through a wrapper such as `npm test -- -u` — and arbitrary output-path flags (`eslint -o`, `jest --outputFile`) stay blocked, as do build commands (`npm run build`).
- **full** — no gate (Builder and normal sessions only).

Compound commands are checked segment-by-segment, and each check reads the view that can answer it (`shell-text.ts`): **operators** (`&`, `>`, `>>`, `<<`, `<(`, `>(`) count only when unquoted, so `rg -n 'a > b' docs` is a search while `rg -n 'a' f > out` is a redirect; **expansions** (`$(…)`, backticks, `${…}`) count outside single quotes only, so `rg -n '$(id)' f` is literal while `rg -n "$(id)" f` executes; **flags** are read from argv after quote removal, so `find . "-delete"` is still refused. `git status && npm test` and `npm test 2>/dev/null | tail -50` work, while `curl … | sh`, unquoted `$(…)`/backticks/heredocs, `sed`/`awk` and file redirects to anything other than `/dev/null` are refused. Refusals name the rule that failed (`explainCommandRefusal`), and `/permissions explain <command>` prints the same verdict without running anything. Explorer subagents run as separate `pi` processes and carry their role in `PI_WORKFLOW_ROLE`, so the same policy gates their `bash` too. The `powershell` tool is refused for every non-builder role, since its syntax cannot be classified by the POSIX allowlist.

The built-in `bash`, `edit` and `write` tools are never given to the reviewer at all.

### One append-only submission

The reviewer submits findings, a verdict and a summary in one call; the
harness appends a `## Reviewer Revisions (round N)` section and preserves the
original plan body. The chunked `review_plan_begin`/`chunk`/`finalize` write
path and the `replacement-body` submission are gone.

### Two passes

1. **Review + rewrite** — audits the plan against the repository and the guidance, records findings, submits the revised plan (one-shot for short plans, `review_plan_begin`/`chunk`/`finalize` when the plan exceeds two chunks).
2. **Self-verify** — re-reads the original and the rewrite, confirms every accepted finding was actually addressed, and reports anything that was silently dropped. This pass exists because a rewrite can lose a requirement the author cared about.

Pass 2 is skipped when `verify` is false, or when pass 1 left nothing at severity ≥ 7 with an `accepted` disposition — clean and low-severity reviews resubmit pass 1's plan directly. When pass 2 runs it checks a **unified diff** of the rewrite (not two full plans), so the self-check costs roughly a tenth of the tokens.

### Every change is visible

A `## Review changes` appendix is appended to the plan automatically (the reviewer is told not to write it), grouped by tier with file:line, severity, confidence and rationale:

```markdown
## Review changes

reviewer `opencode-go/muse-spark-1.3-contributor` · verdict **revise**

**Findings:** 2 addressed, 1 rejected, 1 deferred

### Addressed

**Critical**

- 🔴 `src/export/csv.ts:1` — Plan ignored the Result<T,E> convention _(severity 9, confidence 85%, framework-alignment)_
  - Every sibling exporter returns Result; the plan returned a bare string.

### Deferred

- ⏸ No rollback path _(severity 7, confidence 80%)_
```

### Review in the main transcript

Because the two agents run sequentially — Plan Mode finishes before the reviewer starts — their transcripts can never interleave, and there is no overlay or second pane to navigate. Everything shows up in Pi's normal transcript.

Mode changes are reported by Pi's **footer status** (`⏸ plan` / `▶ build`, plus todo progress) and, on a generic-contribution host, by one published `mode` contribution: switching with **Tab** or `Ctrl+Alt+P` is silent and adds nothing to the transcript, while `/plan`, `/build` and `/default` print a single confirmation line.

**Tab precedence.** While the input's suggestion list is open (commands, `@files`, `#documents`), **Tab** applies the highlighted item and leaves the mode alone. With no list open, the workflow's `tab` shortcut cycles Default → Plan → Orchestrator → Build (a managed worker omits Orchestrator). `Ctrl+Alt+P` and the registered `/workflow-cycle` command run the same guarded cycle; Pi Desktop's composer mode button invokes that command, so a click and Tab cannot drift. Mode switches are refused during a live review and while an overlay owns input. This matches Pi Desktop; it requires `tui.input.tab` to stay bound (the default is `tab`), because a disabled binding leaves nothing for the editor to accept. The one exception is a live review: mode switching is refused with a notice (see [Controlling a running review](#controlling-a-running-review)). Only the review phase adds bands, and the reviewer's stream is rendered in the review color:

| Entry | Color | Meaning |
| --- | --- | --- |
| `▌ REVIEW MODE` | accent | A review round is running (round + model shown). A resumed round reads `resumed · round N · model` instead of `sequential audit` |
| `▌ REVIEW PAUSED` | warning | The round stopped for a pause — `/review-resume` continues it, `/review-abort` discards it |
| action headers | muted | One line per reviewer tool call with its key argument (`▸ read src/app.ts`, `▸ review_bash: git log -5`). Assistant prose and thinking are not streamed, so the transcript stays close to Plan Mode's; status lines are muted |
| `▌ REVIEW DONE` | success / warning | Round finished, with the verdict or the fallback reason |
| `▌ REVIEW SUMMARY` | success / warning | The submitted plan's verdict, plan path and findings (severity-colored) |

These are **display-only custom entries** (`pi.appendEntry` + `pi.registerEntryRenderer`): they are durable in the transcript and survive `/reload`, but they never enter the LLM context, so Plan Mode and Build Mode cannot see the reviewer's work. Consecutive identical bands are suppressed (the gate is seeded from the newest band on reload, and a resumed/paused band is never treated as identical to the band it follows), so cycling modes or re-running a review cannot grow the transcript. Long reviews are coalesced (flushed roughly every 400 ms, and always flushed before a band) and capped, with a one-line notice pointing at `/review-status` when output is truncated.

**Run narration.** The run-start line is emitted by the harness at the moment it sends the prompt, so a resume cannot masquerade as a fresh start: `reviewer started` (a reviewer session was created), `reviewer resumed` (a paused round continues on the warm session), `reviewer continuing` (a later round reuses the session), `reviewer restarting — new reviewer session` (a reviewer-model switch forced a reboot) and `reviewer verifying — pass 2`. A run ends with `reviewer run ended`. An abort **Review Mode requested itself** (pass complete, pause, teardown) is silent; an unexpected abort shows only that neutral line; `reviewer run ended on a provider error: …` is reserved for a real provider or transport failure.

**Notice ownership.** Only notices emitted by the reviewer or a review-owned turn carry the `Review Mode:` prefix; an Orchestrator/child, handoff/Plannotator or plan-lifecycle notice is always neutral, so pausing a Build child reads `Paused · Builder …` rather than `Review Mode: Paused · Builder …`.

#### Where your next message goes

Review is an **exclusive turn** while a real reviewer owns it (`running`, `paused`, a **review-owned** `handoff`, `transition`): prompts are locked. Only `/review…` controls, `/handoff` (including `/handoff fallback`), `/model`, `/thinking`, `/profile` and `/role` pass the input gate; anything else is refused with a notice instead of becoming a queued turn. A **plain plan handoff** (Review Mode off) is not a review turn: modes and prompts stay free, and a prompt or mode switch supersedes it. When no review owns the turn, input follows the **active mode**, decided automatically — there is nothing to focus or toggle:

- **Plan Mode** → the message goes to the plan agent.
- **A plain handoff / the plan sitting in Plannotator or the native handoff with Review Mode off** → the message goes to the plan agent, so you can still refine the plan (and the handoff is superseded).

Use `/review say <message>` to steer the in-flight reviewer explicitly (echoed as `you → reviewer`); `/btw <note>` queues a note for the next turn when no review owns the turn.

Delivery to the reviewer is best-effort: if it fails, the message stays in the plan-agent chat rather than being swallowed.

**Status line.** One formatter now feeds both hosts, so the live Review line cannot drift. While a review runs, the `workflow-review` status carries `🔍 Reviewing plan… · ESC or /review-pause to pause · /review-abort to stop · pass 2/2 · 3 findings · ● verifying`, and the composer area shows the same text. **Pi Terminal** paints it as a plain-text `workflow-review-status` widget above the editor (below the todo widget) for an idle manual round, and reuses the shared running line as its working message during an automatic run. **Pi Desktop** renders the same status as one row below the todo panel and above the composer, with its Pause/Resume/Abort controls. Pausing switches the line to `⏸ Review paused — /review-resume to continue, /review-abort to stop`; resuming returns it to the running form; the handoff form `🔍 review · awaiting decision — /review-abort to skip` names the review-tab decision. The line is live-only: it disappears when the review turn ends, and Plan/Build never keeps a stale `🔍 review … aborted` line. A retained terminal state is painted as the generic turn-derived line, never its old verdict, and a pause from an earlier plan cycle is ignored. Starting a new prompt (or an explicit refine/deny) abandons a paused review and clears both the review line and `🔒 modes locked`. `/review-status` still reports the last round's result.

### Controlling a running review

The handoff **waits for the reviewer**: no browser prompt or native choice renders until the gated round lands, fails, or you pause/abort it. The reviewed plan (the reviewer writes the plan file mid-round) becomes the handed-off text, with the todo steps re-synced to match. A broken reviewer never blocks the plan — the author's draft is handed over with a warning instead.

A handoff opens **only when the current run writes or edits a `.pi/plans/` file while Plan mode is active**. A mid-run switch into Plan counts — the write after the switch is eligible. A plan written before the switch does not auto-handoff: the extension shows `Plan file ready: <path>. Run /review to audit it.` and leaves the plan for the manual command. Switching Build → Plan keeps the previous plan and todos as reference; a fresh prompt also supersedes any pending browser/native handoff prompt, and a stale browser approval/denial from a previous plan is ignored.

**Review cycles.** The round budget (`rounds`) is per plan/feedback cycle, not per session. A fresh prompt, a native `Give feedback`, a browser `Deny`, a different plan-file path, and entering Build all start a new cycle, so a second plan in the same session still gets reviewed with the default `rounds: 1`. Findings carry across a refinement of the same plan file and are cleared for a new plan file. A fresh prompt **abandons** a paused review: the old round is stopped, its open handoff gate settles with the author's plan, and the footer/lock clear. The old handoff cannot render or apply a plan after the new cycle starts.

A paused review is in-memory and belongs to the cycle that recorded it: it cannot keep `🔒 modes locked` alive or short-circuit the next plan's review after a new prompt.

`/review` resolves its target independently of the handoff, so a plan is never unreachable because of how Plan mode was entered: explicit path → this run's last plan write → the session's last plan write → the last handed-off plan → the newest plan write in the session branch. Missing, empty or unreadable candidates are skipped; the resolved path is named when it came from a fallback; the reviewer writes back to that same file. With no candidate it lists the newest `.pi/plans/*.md` files and the explicit-path syntax. `/review <path>` is restricted to `.pi/plans/`.

**Manual handoff and later rounds.** A settled manual `/review` opens Plannotator with the reviewed plan, even with automatic Review Mode off; if Plannotator is unavailable it falls back to the native questionnaire with the same handoff record. `workflow.handoff` (or `/handoff`) decides which presenter is used: `native` skips the browser entirely (no wait, no warning), `plannotator` forces the attempt, and `auto` follows live host detection. The presenter is chosen BEFORE any execution question — an approved plan always crosses the separate execution chooser afterwards. Manual review starts in Plan mode (it does not switch modes for you); Approve then enters the chosen execution and Feedback stays in Plan. The manual cycle keeps re-reviewing and re-handing off after a feedback round until Approve, a fresh prompt or Build. Every new round supersedes an older pending browser gate, so round 2 and later always reopen the current plan; a stale Deny arriving during a round is discarded. After `reload`/`resume`/`fork`, the replacement session asks Plannotator `review-status`: a matching pending review keeps its gate, a completed decision is applied, and a missing/changed review is cleared with a reason. Desktop brings a notification review tab to the front and reloads an existing same-URL review tab; tool-result localhost URLs stay in the background.

- **Review is an exclusive turn.** `ReviewTurnPhase` moves `idle → running → paused → handoff → transition → idle` for a **reviewer round or a review-owned handoff**. Every non-idle phase locks both prompts (see [Where your next message goes](#where-your-next-message-goes)) and mode switches: `Tab` (when no suggestion list is open), `Ctrl+Alt+P`, `/plan`, `/build`, `/default`, browser approve and external plan-mode changes are refused with one notice, and the footer shows `🔒 modes locked`. The turn is the lock's single source of truth (a leaked turn can never half-unlock the session), and every exit closes it. `/review-mode off` is allowed once the reviewer has finished (no running round/pause/gate); with a pending handoff it downgrades that handoff to plain instead of abandoning it. Approve is atomic (stop reviewer → Build → follow-up), and a failed Build closes the turn instead of keeping a phantom handoff.
- **A plain handoff is not Review.** When Review Mode is off (or a manual cycle is not involved), finishing Plan opens the plan handoff as a Plan sub-state (`⏸ plan — handoff pending`, never `🔍 review`). Modes and prompts stay free; switching mode or typing a new prompt supersedes the handoff, and a late browser approve/deny is ignored. The plan is always printed into the transcript, so a browser tab that cannot render is never the only copy. `/handoff fallback` converts the pending browser decision to the native questionnaire without changing `workflow.handoff`; `/review-mode off` does the same downgrade while disabling automatic review.
- **ESC** pauses the round **everywhere it is active** — while the gated handoff waits, while a manual round runs, with no prompt on screen at all. One long-lived terminal listener maps it to `/review-pause` semantics (warm session kept) and stays registered through the paused window: a second ESC while a gated review is paused is swallowed with a hint instead of aborting the parked plan turn (that abort used to poison the turn's signal and stall every `/review-resume`). With no review owning the turn it passes ESC through, so the editor and questionnaire keep it. Headless/RPC hosts have no listener and keep `/review-abort` as their stop path.
- `/review-pause` is the same pause as a command. Pausing mid-handoff does **not** render the handoff — the gate stays open until you resume or abort.
- `/review-resume` continues the paused round on the warm session (or starts a fresh round if the plan changed since the pause), and settles the waiting handoff with the result. A resumed round is **running** again — the notice/footer return to the running form, and a second ESC can pause it. It runs on a fresh controller and deliberately does **not** inherit the parked turn's signal, so an interrupted parent turn cannot instantly re-abort every resume; ESC, `/review-pause` and `/review-abort` are its stop paths. The transcript says so explicitly (`▌ REVIEW MODE  resumed · round N · model` followed by `reviewer resumed`). A rewrite the reviewer wrote to the plan file before the pause is **not** mistaken for an edit of yours: resume compares the file against a hash snapshot taken at pause time (refreshed when the round settles), so only a change made after the pause starts a fresh round. Its notice names the real outcome (rewritten, unchanged, paused, aborted, skipped or fallback).
- `/review-abort` stops the round — or discards a paused one — and is a **strict local exit**. With a waiting handoff (a pending browser decision included) it resolves the in-flight request, settles the gate with the author's plan, closes the turn, and presents the **native** questionnaire: the plan is printed above and Approve/Feedback/Skip are pinned at the bottom. It never re-opens Plannotator, so a broken bridge cannot strand the turn. The aborted revision is not auto-reviewed again until the plan changes. A repeat abort is idempotent (`Nothing to abort — no review, pause, or handoff is active.`) instead of a soft-lock. It also releases the mode-switch and prompt locks immediately.
- A host interrupt (**Ctrl+C**) while a gated review is paused resolves the gate, aborts the reviewer, clears the pause and hands off the author's plan, so the turn can never hang on a parked review.
- `/review say <message>` talks to the in-flight reviewer.
- `/review-status` shows phase, round, the snapshotted model, findings, any paused state, and the mode-switch lock with its allowed exits.

Pausing is in-memory only: a reload starts fresh. A pause also belongs to the current review cycle; a new prompt abandons it (and clears the footer/lock) rather than leaving a resumable round from the previous task.

### Isolation

The reviewer is an in-process child session created with `createAgentSession`, and it is isolated on purpose:

- `DefaultResourceLoader({ noExtensions: true })` — the child cannot load this (or any other) extension, so Review Mode cannot recurse.
- `SessionManager.inMemory(...)` — no session file is written; the reviewer never touches the parent's history.
- Its own `ModelRuntime` — no contention with the parent's model state.
- Plan Mode's conversation is passed as **pruned** prompt context (oversized tool results elided, workflow-injected markers dropped, nothing after the plan write), not by sharing the session. A **Planner-context manifest** — a file inventory with size/mtime/hash tokens plus recent `explore` summaries — rides along so the reviewer verifies instead of re-exploring; the transcript block itself is dieted (15K chars) since anything truncated can be re-read with `read`/`grep`.

An environment marker (`PI_WORKFLOW_REVIEW_CHILD`) is set only for the duration of session creation and restored immediately — the child runs in the same process, so leaking it would affect a later `/reload`.

The general bootstrap lives in `isolated-session.ts` (shared with prompt refinement): in-memory session and settings managers, no ambient extensions/skills/templates/themes/context files, explicit caller-filtered context blocks, its own `ModelRuntime`, parent provider seeding plus a provider-agnostic auth preflight, an exact active-tool assertion, and disposal of the raw child on every bootstrap failure. A model substitution is a hard failure, never a silent fallback. Review keeps its own system prompt, tool set, fallback policy and the opt-in marker above; prompt refinement sets no process-global environment marker and is identified only by its operation/session handles.

### Provider seeding

The isolation above has one consequence: a provider that exists **only** because an extension registered it in the parent session (`pi.registerProvider(...)`) does not exist in the reviewer's freshly created runtime — every review round would fail with `No API key found for <provider>.` even though `/login` had stored a valid credential.

Pi composes providers from three sources: the **built-in catalog**, the **static `~/.pi/agent/models.json`**, and **extension registrations** on the parent runtime. Only the last one is parent-only. Review Mode bridges it with a **present-probe**, not layer names (`review-providers.ts`):

1. **Probe the parent** for a provider-registration surface: the session's model registry (`ctx.modelRegistry`) first, then the underlying runtime (`ctx.modelRuntime`). Both expose the same three accessors; a future Pi surface is picked up by adding one entry to the probe list.
2. **Compare with the child.** Providers the child already composes are skipped. The built-in catalog and `~/.pi/agent/models.json` are loaded by *every* runtime by construction, so for them the seeder is a guaranteed no-op — and any future globally-composed provider source is skipped automatically, with zero layer-name drift.
3. **Seed the difference, native-first.** For every provider the parent knows and the child does not, the seeder registers the parent's provider *object* when there is one, otherwise its config — each in its own try/catch, so a broken unrelated provider can never block a review. Idempotent: already-seeded ids are skipped on a second pass.
4. **Preflight auth, provider-agnostically.** After seeding and before the session is created, the reviewer runtime is asked `hasConfiguredAuth(provider) || checkAuth(provider)` for the *reviewer model's own* provider. On absence the review fails fast with the provider name, the seed report, and the universal escape hatch below — never the bare mid-review error.

Every bridged method is feature-detected: on a Pi version without a given accessor the seeder degrades to "nothing to seed" and the preflight reports the escape hatch instead of crashing.

**The universal escape hatch (works for any provider, even without this fix):** `~/.pi/agent/models.json` is loaded by every runtime, including the reviewer's:

```json
{
  "providers": {
    "<provider>": {
      "baseUrl": "https://…/v1",
      "apiKey": "$MY_API_KEY",
      "api": "openai-completions",
      "models": [
        {
          "id": "<model-id>",
          "name": "<display name>",
          "reasoning": true,
          "input": ["text"],
          "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
          "contextWindow": 200000,
          "maxTokens": 65536
        }
      ]
    }
  }
}
```

A stored credential (`/login <provider>` → `auth.json`) always wins over the `apiKey` template, so `$MY_API_KEY` needs no environment variable while you are logged in. Extensions that register the same provider at runtime keep working: their live model list replaces the static one in the parent, so nothing regresses there.

### Command Code

Command Code's Provider API serves models on three wires: Claude models answer on
`/messages`, models that advertise `/responses` answer there, and the rest use
`/chat/completions`. A hand-written `models.json` entry declares one API family for the
whole provider, so it cannot route each model. Use the maintained
[`pi-commandcode-provider`](https://www.npmjs.com/package/pi-commandcode-provider)
package: it registers the `commandcode` provider, routes each model from
`supported_endpoints`, and normalises Command Code's reasoning deltas.

After installing it, migrate every saved reference without hand-editing JSON:

```text
/profile retarget-provider command-code commandcode          # dry run
/profile retarget-provider command-code commandcode --apply  # writes profiles.json + roles.json
```

The command rewrites only `{ provider, id }` model refs, preserves every other key,
and creates a `.bak` beside each file it changes. A malformed file blocks both writes.
Verify the new provider in `/model` before deleting the old static entry. The Pi Desktop
doctor prints the same recommendation when it sees a single-wire Command Code provider.

### Configuration

Settings live under `workflow.reviewMode` in `~/.pi/agent/settings.json` (global) or `<cwd>/.pi/settings.json` (project). Project values win field-by-field over global. Writing them preserves every other key in the file.

## Prompt refinement

Prompt refinement rewrites a **drafted request** in an isolated child session and
returns the candidate to the composer. It never sends the request, executes a
tool, writes a file, starts a task, mode, plan, todo, checkpoint, review, handoff
or Orchestrator dispatch. Nothing is run until a separate human Send.

### Operation

One refinement is one bounded `inspect → ask → reinspect → compose → submit`
operation, run against a frozen model, system prompt, prepared context and the
**initial** read-policy/trust/grant ceiling. It caps model turns (24), inspection
calls (80), question rounds (6) and active time (8 minutes) by default; a budget
that runs out is a recoverable failure, never a silently truncated candidate.
An answer that changes scope re-prepares context; a new grant never widens a
running operation. Sessions, subscriptions, timers and outstanding question
signals are released on every exit, and a child that finishes bootstrapping
after cancellation is disposed rather than used.

### Context and provider privacy

The child is a second in-memory SDK session with its own `ModelRuntime`. It
loads no ambient extensions, skills, prompt templates, themes or AGENTS/CLAUDE
context files, and its settings manager is in-memory, so a refinement cannot
read or write the session's own settings or transcript. Context is an explicit,
bounded selection the parent picks for the refiner: compaction-aware recent
relevant text, never hidden thinking, credentials, unrelated history or raw logs.
Repository data and prompt injections are treated as untrusted task data, not
instructions.

File evidence is subject to the read policy (see
[Folder and read permission](#folder-and-read-permission)): approved roots,
grants, sensitive paths, symlink/Windows aliases and result sizes are enforced
per file before any output reaches the child model. The **starting snapshot is
only a ceiling**: the live trust/grant/exclusion generation is re-resolved before
every inspection, provider request, question and candidate delivery (plus turn
boundaries). Relevant narrowing — or any policy-generation change once file
evidence exists — invalidates the operation, revokes its toolset/evidence and
disposes the child while preserving the original draft for a retry. Local policy
commands invalidate immediately; a later grant never widens a running operation.

**Revocation is forward-looking, not retroactive.** A narrowed policy stops
future reads and future provider turns, and a stale candidate is not delivered.
It cannot un-disclose what a provider already received in an earlier request
(prompts, file excerpts or model context). This is stated rather than implied.

### Model scope, inherit and reset (`/prompt-model`)

Refinement uses its own optional model setting, independent of the main session
model, roles and profiles. Precedence is: a **trusted** project override
(`<cwd>/.pi/settings.json`) → the global setting (`~/.pi/agent/settings.json`) →
the **Default-mode model**. An explicit inherit sentinel suppresses a global
override so a trusted project can deliberately fall back to the Default model:

```json
{ "workflow": { "promptRefinement": { "model": { "provider": "opencode-go", "id": "deepseek-v4.1-flash", "thinking": "medium" } } } }
{ "workflow": { "promptRefinement": { "model": { "inherit": true } } } }
```

`/prompt-model` writes the value read-modify-write, preserving every other
settings key. `set` validates the provider/model against the registry and clamps
an explicit thinking level to the model's capabilities (a nonreasoning model
stores `off`); provider-qualified IDs may contain additional `/` characters.
Missing or invalid explicit settings are reported and refinement **refuses**
rather than silently falling back to another model. `inherit` writes the
sentinel; `reset` removes only the chosen scope, so resetting a project override
reveals a global one. Project writes require a trusted project, and a malformed
settings file is never rewritten as `{}`. The main session model, roles,
profiles and Pi's default-model mirror are never modified.

### One-shot composer toggle

On a host that advertises the `composer-transform-v1` capability (Pi Desktop),
refinement is an armed **composer control**, not a slash command. Arming is
one-shot: the next Send refines the draft and returns it **in place**, without
running the task. `/prompt-refine on|off` toggles the same arm state and does no
model, session or runtime work itself; explicit `off` cancels/disarms a live
operation. The adapter disarms only after the host acknowledges the apply.

### Busy behaviour

A refinement is refused — never queued over an unrelated busy surface — while a
run owns the turn, a Review round is active or paused, a handoff or
questionnaire owns input, an overlay or non-nested progress surface already owns
the composer, or a managed Orchestrator child owns the operation. On a
structured host, a second start for the same tab/session binding is a
`request-conflict`; a renderer reload adopts the live operation instead of
starting a duplicate provider call. Normal Send, steer/follow-up and shell
behaviour are unchanged when refinement is off.

### Cancellation and conflicts

Escape/Stop cancels the current refinement first and never pauses or aborts an
unrelated Review; the Escape listener exists only while an operation is live and
is detached in `finally`. Explicit toggle-off cancels and disarms; other
cancel/error paths leave the control armed for a retry. A candidate is applied
only to its exact still-current draft revision: newer typing, an attachment
add/remove/reorder, an ABA edit or a tab switch yields an explicit **conflict**,
and the candidate is kept viewable and copyable with an explicit replace
affordance. Duplicate completion/apply frames are refused (idempotent receipt),
never written twice.

### Failure and recovery

The original draft, the candidate and a short change summary live in a bounded
in-memory review store, never in the parent conversation, session files or logs,
and the original stays View/Copy-able. A provider/tool/budget failure is
recoverable: the draft is preserved for a retry. On a structured host, a lost
apply acknowledgement is settled from the host's bounded settled-receipts map;
a renderer reload/activation queries the live operation rather than restarting
it; host restart/crash, new/resume/fork/rewind, `/reload`, publisher
disablement or withdrawal, tab close and app quit cancel/invalidate the job and
grant while keeping the candidate viewable (never apply-able) and the draft text
preserved. Binary attachments live only in renderer memory and do **not**
survive a full app/renderer process loss; text drafts do. Surviving images would
require a separate secure draft-blob store, which this build deliberately does
not have.

### Images and Terminal paths

A Desktop host may send bounded image bytes/IDs and the runtime attaches them
only after validating the selected model's vision capability; unsupported images
are disclosed and the request asks for text descriptions instead of switching
models. A **Terminal command handler receives no structured images**: `/prompt
<draft>` treats a path such as `images/error.png` as literal prompt text, so no
image bytes are attached and the model must not claim to have inspected a file
it did not read. This is an accepted Terminal limitation, not an upstream patch;
attachment-aware transformation requires the structured capability.

### Capabilities for third-party frontend consumers

The public, additive `composer-transform-v1` contract
(`composer-transform.ts`, fixture `fixtures/composer-transform.conformance.json`)
lets an unrelated host drive a refinement without any Workflow identifier in the
host. Copy the fixture byte-for-byte; both suites assert the same SHA-256.

- **Contribution.** `kind: "composer-control"`, `slot: "composer-actions"`, a
  closed semantic icon allowlist, checked/enabled/disabled-reason, an explicit
  `one-shot-return` or `persistent` behaviour, and same-owner `actionRef`
  (toggle) plus `transformActionRef` (operation) references. `operation` names
  the public input command (`/prompt`) and the registered bootstrap companion
  (`/prompt-refine-companion`). Drafts, images, model/context and grants never
  travel through contribution args; the old 1 000-character args limit is
  unchanged.
- **Grant-only bootstrap and the private structured handoff.** SDK 1.5 command
  handlers are string-only, so the handoff is two-stage. The host resolves both
  commands' live SDK `sourceInfo` (`path`/`source`/`scope`) and refuses equal
  names from different extensions. It then arms a **single-use** listener on the
  SDK EventBus, mints an unpredictable request-scoped grant, and invokes the
  companion with a grant-only JSON string (`contract` + `grant`; extra fields
  are refused). The grant id selects a private channel and a random proof must
  match before the typed in-process port is handed to the companion callback —
  the public `/prompt` literal text is never parsed as internal JSON. Listeners
  are removed on claim, expiry, rejection and teardown. The handshake is proven
  against unmodified SDK 1.5.
- **Frames.** Start request, started receipt, progress, candidate, status query/
  response, cancellation, apply receipt and lifecycle errors each have an
  independent validator. Diagnostics expose bounded ids/counts/revisions only,
  never draft text, expanded text, image bytes/digests, grants or model context.
- **Old hosts.** Contribution v1 is additive: an older Desktop drops the
  unknown kind and keeps the status/action rows plus the text command. The
  fallback reports `nativeControl: false` and `attachmentAware: false`; a text
  fallback never promises attachment-aware transformation.
- **Live-policy revocation.** A frontend must re-resolve trust/grants/policy at
  each authority boundary and treat a narrowing policy-generation change as
  cancellation, never as an applicable cached result. As above, revocation
  stops future disclosure; it does not recall provider data already sent.

A minimal generic host integration uses the **structured capability**, not slash
concatenation: read the published `composer-control`, resolve its
`transformActionRef` to the declared public command and its `operation`
companion, verify both share one `sourceInfo`, arm a one-use rendezvous, pass the
grant-only bootstrap, then drive `start`/`progress`/`candidate`/`cancel`/`apply`
with typed frames. Only a host that has none of this may fall back to running the
plain text `/prompt` command, and it must report that it is not
attachment-aware. See the Pi Desktop
[`architecture/extension-ui.md`](https://github.com/dieuluucanh/pi-desktop/blob/main/docs/architecture/extension-ui.md)
composer-transform section for the host-side walkthrough and a worked example.

### Bundled source, override, disable and safe mode

Pi Desktop bundles a pinned `@dieulc/workflow` artifact (`builtin:workflow`,
staged from a verified tarball or release artifact with recorded integrity).
Startup loads it offline and independently of a developer checkout; the resource
hub and About/Diagnostics report the builtin version, source and replacement
state. Explicit npm/git/local/project installs override the builtin exactly once
(a provenance warning states which won). `-builtin:workflow` opts the builtin out
without touching your `packages`/settings; the Extensions hub can disable and
re-enable it; and safe mode loads neither the builtin nor a third-party copy.
Terminal Pi is unaffected — it loads the extension from npm or a checkout as
before. No install happens at runtime and no settings file is rewritten by
these paths.

### Compatibility matrix

| Concern | Terminal Pi (W) | Pi Desktop (D) |
| --- | --- | --- |
| Entry point | `/prompt <draft>` writes the editor | Armed composer control; typed `/prompt` routes through the structured path |
| Refinement model | `/prompt-model` + Default-mode inherit | Same (extension-owned setting) |
| Structured capability | Publishes `composer-transform-v1` | Consumes it; unknown kinds fail safe |
| Images | Path is literal text; no bytes (accepted limitation) | Bounded image bytes after vision-capability validation |
| Apply | `setEditorText` with an expected-buffer check | CAS apply on the exact draft revision + idempotent receipt |
| Old host / old extension | — | Additive fallback: text/status only, `attachmentAware: false` |

**Tested versions.** Workflow 0.13.0 against Pi SDK 1.5.0 (Pi Desktop's exact
pin). The structured handshake is verified against unmodified SDK 1.5; automated
suites are listed under [Development](#development) and in W `docs/`.

### Honest acceptance limits

- Semantic intent quality is an evaluation/human-review property, not a
  deterministic guarantee. The rubric corpus and fake-provider harness check
  preserved literals, consent, language and non-execution; they do not prove a
  candidate is *better*.
- A live-model quality sample, Playwright composer E2E and real Terminal keyboard
  acceptance are **NOT RUN** in this environment and are recorded as such, not
  inferred from unit substitutes (see W `docs/orchestrator-live-acceptance.md`
  and D `docs/architecture/refinement-acceptance-2026-11-24.md`).
- Terminal structured images remain an accepted limitation; differing native/TUI
  rendering is an accepted platform difference.
- Generic SDK APIs Workflow does not use are outside this contract; they are not
  advertised as supported.

## Folder and read permission

**One shared floor.** `workflow.folderPolicy` decides which folders read, write and commit may touch. `mode: "repo"` (default) is the nearest `.git` ancestor (fallback: the session cwd); `cwd` is the exact working directory; `parent` is the parent of that base (siblings); `any` disables containment. `outside: "ask"` prompts once per turn (headless fails closed); `outside: "block"` refuses silently, and an unresolvable write/commit target is refused without a dialog (the read gate keeps its own `readPolicy.shell` opt-in). A policy can only be **stricter** than this floor — `writePolicy: "allow"` cannot write outside it. Both Default and Build respect the floor. `excludePaths` adds **two tiers** on top: a specific folder is a hard deny for its whole subtree, while a broad root (`C:/`, `~`, a share root) is only a ceiling. For writes it asks only for a *proven* outside target, a sensitive file, or an explicit path that cannot be resolved; a command whose writes merely cannot be located is not treated as outside (see “Not a sandbox”). Windows Git-Bash/Cygwin/WSL spellings (`/c/...`, `/cygdrive/c/...`, `/mnt/c/...`) and `file://` paths are translated to native paths before matching. For **shell commands** on Windows, Git-Bash's `/tmp` is also resolved to the real Git-Bash temp directory (`%LOCALAPPDATA%\Temp`, or a native `TMP`/`TEMP`; detected via Git for Windows or `MSYSTEM`, overridable with `PI_MSYS_TMP`), while direct tool paths keep Node's meaning (`/tmp` is `C:/tmp` there). A folder grant covers the first folder outside the base (the outside project), while a file sitting directly in the common parent is granted as that file only. Read, write and commit dialogs list the base/current folder and every requested target path; a prompt caused by the floor is titled **Folder policy 'ask'**, not “Write policy”.

**Sensitive files are always blocked.** The default deny list covers `.env*` (templates such as `.env.example` are exempt by default), `.npmrc`/`.netrc`/`.git-credentials`, `auth.json`, `credentials*`, `secrets.*`, SSH/GPG/cloud stores, key/cert stores, `.git/config`, `.tfstate`/`.tfvars` and keychains. A folder grant never re-enables one; add a manual `folderPolicy.sensitiveExemptions` entry only when a template/fixture is genuinely needed. `/folder-policy sensitive` lists the effective rules.

### Excluded folders

`folderPolicy.excludePaths` has **two tiers**. Which one applies is decided by the *path*, not by whether the pattern contains a wildcard:

| Rule | Examples | The rule's root | Everything below it |
| --- | --- | --- | --- |
| **broad root** (a grant ceiling) | `C:/`, `/`, `~`, `//server/share`, and the same with `/**` | **blocked** (no dialog, no grant) | follow the folder `mode` — `any` allows, `repo`/`cwd`/`parent` apply their normal containment |
| **specific folder** (a hard deny) | `C:/Personal`, `C:/Users/Me/Private`, `**/node_modules` | **blocked** | **blocked** — no dialog, no grant, no rescue |

```jsonc
// ~/.pi/agent/settings.json — global is the usual scope here
{
  "workflow": {
    "folderPolicy": {
      "mode": "any",
      "excludePaths": ["C:/", "C:/Personal"]
    }
  }
}
```

With that policy `C:/Users/Me/Projects/app/README.md` is readable (the `C:/` ceiling does not deny it), while `C:/Personal` and every file under it are refused, and `ls C:/` is refused.

- **Nothing re-opens a deny rule.** `readPolicy`/`writePolicy`/`commitPolicy.allowedPaths`, an “Always allow” answer, a reviewer/subagent's locked roots and the session folder itself all lose to it. `/folder-policy exclude revoke <path>` (a slash command, not an agent tool) is the only way back.
- **A session opened inside a deny rule is blocked.** Read, write and commit are all refused, and `session_start` prints one warning naming the rule and the revoke command. Plan-mode `.pi/plans` writes are refused too.
- **A ceiling never denies its descendants.** `/folder-policy status` and `exclude list` label each rule `[ceiling: …]` or `[deny: …]`; a grant stored inside a deny rule is reported as ignored.
- **Sensitive files still win** in both tiers: `.env`, credentials, key stores, … remain blocked even where the folder is allowed.
- **Dialogs never grant a broad root.** A filesystem/drive root, home, a parent of home, or a protected system/profile umbrella (`C:/Windows`, `Program Files`, `ProgramData`, the `AppData` umbrella, `/etc`, `/usr`, `/var`, `/System`, …) cannot be granted in one click; a concrete folder *inside* one of those still can.
- **Catch-all patterns** (`*`, `**`, `**/*`) are refused; roots are accepted.
- **A deny rule needs a specific folder.** `["C:/", "C:/Users/Lenovo"]` protects those two roots from standing grants but does **not** deny everything under home — add explicit rules such as `C:/Users/Lenovo/Private` (see **Migration**).

Commands (global by default — `--project` opts into `<cwd>/.pi/settings.json`):

```
/folder-policy exclude C:/ --global          # add (the bare form adds)
/folder-policy exclude add ~ --project       # add to the project file
/folder-policy exclude list                  # effective rules + which files supply them
/folder-policy exclude revoke C:/            # remove exactly one entry
/folder-policy exclude "C:/My Documents"     # quote paths that contain spaces
```

Scope is **flags only** (`--global` / `--project`). A bare `global`/`project` word is treated as an ordinary argument, so a folder literally named `project` can be excluded and a trailing word can never silently retarget the write; any leftover argument is rejected with the usage line instead of being dropped.

Input handling worth knowing:

- **Paths with spaces** are supported with quotes (`"…"` or `'…'`); backslashes stay literal, so Windows paths survive. An unbalanced quote is refused, not half-applied.
- **`C:Personal`** (drive-relative, no separator) is repaired to **`C:/Personal`** on Windows and the message says `(normalised from C:Personal)`. Without that repair a slash-less pattern would be a basename glob that never matches an absolute path — a listed rule that does nothing. Revoking works with either spelling.
- **Message levels:** a successful write is `info` (and prints the settings file plus the resulting `Active exclusions (N)` list, so a stale list can never look like a contradiction); a refused/ambiguous input or a non-blocking note is `warning`; `error` means the new rule blocks a capability at your session folder.
- **“Broad root” means an OS/drive/share root or your home directory** (`/`, `C:/`, `//server/share`, `~`, optionally with `/**`). A broad root is a **ceiling**: only that root is blocked. Excluding an ordinary folder such as `C:/Personal` is a **hard deny** for its whole subtree and gets no such note. Catch-all patterns (`*`, `**`, `**/*`) are refused; roots are allowed with the note.

Global and project `excludePaths` are **unioned**: a project can add a rule, never remove a global one. Project settings are only read when the project is trusted (`exclude list` says when it ignored them). When a rule covers the session folder, the warning names every capability it refuses (a deny rule refuses `read, write, commit`) and states that a grant cannot rescue it. `/folder-policy status` uses the same check.

**Workflow settings are user-owned.** Tool writes (`edit`, `write`, shell redirects/`sed -i`) that target the global `~/.pi/agent/settings.json` or the project `.pi/settings.json` are refused in every mode, including Build — otherwise the agent could delete its own exclusions. The slash commands write those files through the filesystem and still work; ask the user to run one, or to edit the file themselves.

**Read gate.** `read`, `ls`, `grep`, `find`, pi-lens read tools, `explore` cwd/tasks, local `fetch_content`/`browser_*` file URLs and balanced shell reads (`cat`, `rg`, `git show/-C`, redirections, `cp`/`tar` sources) are path-gated. `grep`/`find`/`ls` output, sensitive git diff sections and truncated `bash` full-output paths are redacted. `readPolicy.shell: "strict"` also asks for inline/interpreter commands that cannot be statically verified.

**Grants.** “Always allow” writes to the capability's `allowedPaths` in project settings by default (`folderPolicy.grantScope: "project"`); the project must be trusted. Existing global write grants remain honoured. A dialog may remember a concrete folder — including a drive-top folder such as `C:/tmp` and the real Git-Bash temp dir — but not a filesystem/drive root, the home directory, a parent of home, or a protected system/profile umbrella (`C:/Windows`, `Program Files`, `ProgramData`, the `AppData` umbrella, `/etc`, `/usr`, `/var`, `/System`, …); a concrete folder *inside* one of those is grantable. When a grant cannot be persisted (broad root, or an untrusted project with project scope) the dialog **omits** the “Always allow” row, explains why, and names the deliberate path: `/read-policy allow <target> [global|project]` for reads; write and commit grants go in `workflow.writePolicy.allowedPaths` / `workflow.commitPolicy.allowedPaths` (see `/write-policy status` and `/commit-policy status`). If an approval still arrives, the operation runs **once**, nothing is saved, and a warning says so. “Broad” for an **exclusion** is deliberately different and narrower (only an OS/drive/share root or home) because an exclusion is a narrowing action. Use `/folder-policy any` deliberately to disable the floor for read, write and commit.

**Not a sandbox.** Arbitrary code (`node -e`, `python -c`, package scripts), renames of sensitive files and git history are documented residuals. A shell command whose writes cannot be located — `npm run build`, `node script`, `npx`, a `sed`/`awk` program, `powershell`, or a path-less tool in `mutatingTools` — is **not** treated as an outside write: under `writePolicy: "allow"` (and in Build) it runs without a dialog. That is deliberate: the analyzer cannot see inside project code, and asking made ordinary in-repo builds and tests look like a permission violation. Use `writePolicy: "ask"` for a prompt on every mutating call, or an OS container/VM for a hard boundary. The same honesty applies to `excludePaths`: `grep -r` still traverses a denied folder before the output is redacted, project-wide tools (`symbol_search`, `project_report`, a path-less `lens_diagnostics`) can surface names or symbols from it, and opaque code is not path-analysed — the rules stop the agent's *tools* from reading or writing there, not an arbitrary subprocess. A broad root does not deny its descendants; only a specific rule does. The Review Mode reviewer gets guarded built-in `read`/`grep`/`find`/`ls` tools even though its session has no ambient extensions, and inherits the parent's exclusions; a deny rule beats the reviewer's locked repo root too. `review_bash` uses the same guard. Spawned subagents receive locked roots plus the parent's deny layer (`PI_FOLDER_POLICY_DENY`) and cannot expand via a sibling project's settings.

**Migration.** The default `folderPolicy.mode: "repo"` + `outside: "ask"` also constrains writes/commits. Set `folderPolicy.mode: "any"` to restore the old “write anywhere” behaviour (sensitive files remain blocked); this now also disables the unresolvable-target asks. Use `cwd`/`parent` to keep a narrower floor.

Exclusion semantics changed: a specific folder (`C:/Personal`) now denies its **whole subtree** with no dialog and no grant, and neither a stored `allowedPaths` entry nor a locked reviewer root can re-open it — revoke the rule instead. Broad roots (`C:/`, `~`, `/`, a share root) remain ceilings: they block only their own root, so an existing `["C:/", "C:/Users/Lenovo"]` no longer denies your projects. To keep private content unreachable, add explicit deny rules such as `C:/Users/Lenovo/Private`; `sensitivePatterns` still blocks secrets.

## Commit policy

By default the agent **cannot touch your git history**: the tool gate deterministically blocks `git add`, `git commit` and `git push` — including compound commands (`git add -A && git commit -m x`), global-option forms (`git -C path add`) and `powershell` wrappers. You commit manually, or run `/commit` for an AI-summarized, confirmation-gated commit. Read-only git (`status`, `log`, `diff`, `branch -a`, `config --get`, …) stays free, and plan mode keeps its stricter read-only rules regardless.

The default exists because prompt-only rules are soft: models habitually commit per plan step, and "never commit unless asked" instructions in CLAUDE.md-style files are famously ignored (anthropics/claude-code#58883, #68724, #7029). Claude Code, Codex CLI and OpenCode all treat agent-initiated commits as something to gate or approve — so the policy here is enforced where commands execute, not in prose:

| Agent | Default commit behavior | Control |
| --- | --- | --- |
| Claude Code | never auto-commits | CLAUDE.md rules (soft, documentedly ignored) + PreToolUse hooks (hard) |
| Codex CLI | approval-gated git mutations | sandbox + `--approval-mode` |
| OpenCode | no auto-commit | ordered `permission` rules (`git push *` → `deny`), global + project config |
| Aider | auto-commits every edit | `--no-auto-commits`, `--commit-prompt` (the configurable-commit pole) |

### Modes

Exclusions and sensitive files apply to commits too: `git add <sensitive|excluded>`, `git add .`/`-A` when such a path would be included, and a staged sensitive/excluded path before `git commit` are refused. `/commit` bypasses the commit *mode* (with your confirmation), never the sensitive-file or exclusion checks. Per-step auto-commit skips with a notice when the repository — or any dirty path it would stage — is excluded.

| Mode | Meaning |
| --- | --- |
| `never` (default) | `git add` / `git commit` / `git push` are blocked with a policy reason that tells the model to leave changes uncommitted for review |
| `ask` | The agent may commit; every `git commit` / `git push` pops an Allow once / Deny dialog (headless sessions fail closed). `git add` stays free — staging alone pollutes nothing |
| `allow` | **Automatic per-step commits.** While a plan todo list is active the extension itself makes exactly **one commit per completed step** (at the `workflow_todo` completion boundary, before the model starts the next step; subject `step N: <step text>`), and the model cannot run `git add`/`commit`/`push` at all. Outside a plan (no todos) the model may commit as before. `/commit` always works |

The status line always shows the active policy (`▶ build 2/5 · commits:never`), so you can see at a glance what the agent may do to history.

**Outside repositories.** The shared folder floor also gates the repository root. Inside the current project, only the commit policy above decides; a command that targets a repository outside the permitted folders (`git -C ../other ...`, or a worktree/GIT_DIR outside) opens a separate **Folder policy 'ask'** dialog, or is refused under `outside: "block"`. The two prompts are deliberately labelled apart, and the model-facing reason names the folder policy when that is what refused it.

### `/commit` under any policy

`/commit` works under `never` and `allow`-during-a-plan because it is the user's own request. The flow is multi-turn (read the staged diff → confirm the message in a questionnaire → commit), so the exemption is **armed at the user's confirmation**, not when the flow starts:

- `/commit` records a *pending flow* and injects its agent turn. Nothing is exempted yet.
- When the confirmation questionnaire is answered **positively** (✅ Commit, or a custom message), the extension arms a scoped *commit authorization*. Choosing ❌ Cancel clears the flow and arms nothing.
- The authorization exempts **only `git commit`** — `git add` and `git push` stay blocked — and is valid until the run settles (`agent_settled`), additionally bounded by a 10-minute TTL and a 10-commit cap. It is also dropped on `session_shutdown` and on rewind (`session_tree`).

The confirmation step is required: with no positive answer no authorization exists and the policy keeps blocking. `-a` staging happens extension-side before the flow, outside the tool gate.

The proposed message is passed in the questionnaire's scrollable `context`, not in `question`. The bottom-sheet keeps the short decision line and the ✅ Commit / ✏️ Edit / ❌ Cancel rows pinned while the message scrolls (wheel, `PgUp`/`PgDn`, `Ctrl+U`/`Ctrl+D`), so a long, multi-paragraph commit message can never hide the choices.

```text
/commit-policy                # status: mode, which scope supplied it, both settings paths
/commit-policy never          # set globally (~/.pi/agent/settings.json)
/commit-policy allow project  # this repo only (<cwd>/.pi/settings.json)
```

Known limits (accepted, same trade-off OpenCode/Claude Code make): a configured git alias (e.g. `ci` → `commit`) is not recognized, and exotic obfuscations (`sh -c 'git commit'`) are caught only when the plain text survives. Plan-mode and subagent read-only gating are unaffected by the policy; the shadow-checkpoint rewind commits live in a separate bare repo and never appear in your history.

## Write permission

The extension has three modes — **Plan → Build → Default**. Plan mode is read-only and Build mode is unrestricted *by design* (it is the approved-execution path), but **Default mode was also completely unrestricted**: the tool gate has no role to apply there, so the agent edits your files without asking, and it does so inconsistently — sometimes it asks for clarification, sometimes it goes straight to `edit`.

`workflow.writePolicy` closes that gap. It is a **user-controlled permission**, enforced where the tools execute (not in prose — prompt rules are soft and get ignored). The write **mode** applies to **Default mode only**; the shared folder floor is separate and applies in every mode, including Build — but it only asks for a proven outside target, a sensitive file, or an unresolvable explicit path. Build never inherits `ask`/`never`.

| Mode | Meaning |
| --- | --- |
| `allow` (default) | The agent writes files freely — today's behaviour, and the shipped default so existing installs are unaffected |
| `ask` | Writes pop a dialog: **Allow once (this turn)** / **Always allow …** (*this path*, *these paths*, *this folder*, *these folders*, *this command*, *these commands*) / **Deny** / **Deny with instructions…**. One dialog covers a whole turn and lists the writes it covers; a permanent grant is remembered, so the same target stops asking. A prompt caused by the folder floor is titled **Folder policy 'ask'** and shows the base folder; a write-mode prompt is **Write policy 'ask'**. If a persistent grant is impossible (a root/home/protected umbrella, or an untrusted project with project scope), the Always row is omitted and an approval applies once with a warning |
| `never` | The agent may not modify your files (`.pi/plans/` excepted). You apply the changes, or the user switches to `/build` for the approved-execution path |

The status line always shows the active permission (`◦ commits:never · writes:ask`), so you can see at a glance what the agent may touch.

### What is gated

- The `edit` and `write` tools.
- `bash` commands that may modify files. A command is treated as a write when it is **not provably read-only**: a file redirect (`>`, `>>`), a heredoc or command substitution, a command outside the read-only/verify allowlist (`rm`, `mv`, `cp`, `sed`, `awk`, `npm install`, `git checkout`, interpreters, unknown binaries …), or a write flag on an otherwise-safe command (`eslint --fix`). Read-only commands (`ls`, `cat`, `rg`, `git status`, `npm test`, `tsc --noEmit`) and harmless redirections (`2>/dev/null`, `2>&1`) stay free. Only an **unquoted** redirect or expansion counts: `rg -n 'a > b' docs` and `rg -n "rm -rf" src` are read-only, so `ask` never prompts for them.
- **`sed` and `awk` are classified as potential writes whatever their flags** — their programs are code (GNU sed's `e` command runs a shell command and its `w` command writes a file; awk can `system()` or redirect), so a plain `sed -n '…p' file` is a *mutating* call. With `writePolicy: ask` it therefore prompts (use `rg` / `head` / `tail` / `cut` / `column` / `jq` or the `read` tool to avoid that); under `allow` and in Build it runs without a dialog, because the folder floor only asks for a *located* outside target.
- `powershell` is always treated as a write — it cannot be classified by the POSIX allowlist, so it fails closed.

`git add` / `git commit` / `git push` are **not** treated as file writes: they touch the index and the object store, not your working tree, and the independent [commit policy](#commit-policy) already governs them.

### Scope and carve-outs

- **Default mode only for the write mode.** Plan mode keeps its stricter read-only rules (writes only to `.pi/plans/`), and Build stays the execution escape hatch: it never inherits `writePolicy: ask/never`. The shared folder floor still applies in Build and Default (outside targets, sensitive files and [excluded folders](#excluded-folders)).
- **Settings files are user-owned.** A write whose target is the global `~/.pi/agent/settings.json` or the project `.pi/settings.json` is refused in every mode, so the agent cannot delete its own exclusions; the slash commands still write them.
- **Subagents are unaffected.** A spawned child carries `PI_WORKFLOW_ROLE` and is already read-only through the role gate — and it has no UI to answer a prompt with.
- **`.pi/plans/` writes stay allowed** in every mode, so a session that leaves Plan mode mid-flow is not stranded.
- **Third-party write tools need opting in.** `ast_grep_replace` (pi-lens) rewrites files, and the `office_*` tools (pi-office-protocol) write documents; neither is covered by the built-in scope. List them in `mutatingTools` to gate them (see below). A path-less mutating tool follows the write mode: no prompt under `allow`/Build, prompted under `ask`.

```text
/write-policy                # status: mode, which scope supplied it, the allowlists
/write-policy ask            # set globally (~/.pi/agent/settings.json)
/write-policy never project  # this repo only (<cwd>/.pi/settings.json)
```

**Headless sessions fail closed** under `ask`: there is nobody to answer the dialog, so the write is blocked with a reason telling the model to report the change instead. `allow` and `never` are unaffected.

### Denying with guidance

A plain **Deny** tells the model only that the write was refused. It does not say what you actually want, so the model either stops cold or re-proposes the same kind of change. **Deny with instructions…** opens a one-line text box, and your sentence steers the model:

```
Write denied — tell the agent how to proceed
> only explore and propose a plan, do not edit files yet
```

The instruction reaches the model through **two channels**, on purpose:

1. **The tool result** — the block reason quotes your sentence verbatim and ends with the disposition (*"Do not retry this write. Follow the instruction above. If it cannot be followed, say so and stop."*).
2. **A user message** — the same sentence is delivered as a real user turn (`deliverAs: "steer"`), after the current tool batch and before the next model call. One user turn per turn, not one per blocked call.

The second channel is not redundancy for its own sake: Claude Code shipped the comment-on-rejection design and then shipped a bug where the model ignored the comment (it kept trying workarounds) — [anthropics/claude-code#89231](https://github.com/anthropics/claude-code/issues/89231), [#52824](https://github.com/anthropics/claude-code/issues/52824). A tool result is a fact the model may reinterpret; a user turn is an instruction it must follow. Cursor and Claude Code now offer the same affordance (*"Reject? Tell what to do differently"*).

Behaviour worth knowing:

- **One dialog per turn, not per call.** Pi runs an assistant message's tool calls as a batch, and the gate is asked about *every* call of that batch before the first of them runs. Asking per call therefore asked the same question twice when the model batched two writes to one file — and the sentence typed into the first dialog could not reach the model before the second one opened (a tool result is only appended after the whole batch, and a user turn lands only after the batch has run). The dialog now lists every write the answer covers, and the answer applies to all of them: **Allow once (this turn)** allows the listed writes of that turn, **Always allow …** persists a grant for every one of them.
- **A denial is remembered for the rest of the run.** If the agent tries the same write again in a later turn, it is denied again with the same sentence — no second dialog, nothing to retype. The memory ends with the run (the next run asks again). To let that write through sooner, end the run (Esc) and start a new one, or switch to `/build` — the gate only applies in Default mode. Your sentence is never written to `settings.json`; it lives in the transcript and in one audit entry per turn.
- **A plain Deny behaves exactly as it always has** — the agent's run is not cut short, and the model keeps its turn. A denial never sets pi's `terminate` flag: that flag is only consulted *after* a whole tool batch has run, so it cannot stop a sibling write — it would only take away the model's next turn.
- **For a durable "explore only, don't edit yet", use `/plan`.** Plan mode is read-only by design and keeps the agent inside that rule for the whole session; a denial sentence applies to the run it was given in.
- **Cancelling the text box is a plain Deny** — never an implicit allow. An empty or whitespace-only sentence behaves the same way.
- **Long or noisy input is sanitized**: line endings are normalised, control characters are stripped, and the text is capped at 2000 characters.

## Settings

Role config lives in `~/.pi/agent/roles.json` v2 (user) with optional per-project override at `<cwd>/.pi/roles.json` (per-role replace). Each role holds exactly one `{provider, id, thinking}`. v1 `modelPool` files are discarded and reseeded on load. Seeded with defaults on first run. Respects `theme`, `modelRegistry`, and `plannotator` phases from `agent/plannotator.json`.

Profile config lives in `~/.pi/agent/profiles.json` v1 (user) with optional per-project override at `<cwd>/.pi/profiles.json` (per-profile replace). Each profile holds `{name, description, roles}` where `roles` maps any of the four built-in role names to one `{provider, id, thinking}` — see [Model Profiles](#model-profiles).

The default profile lives under `workflow.defaultProfile` (global/project precedence like the other workflow settings):

```json
{
  "workflow": {
    "defaultProfile": "cheap"
  }
}
```

`/profile default <name|none> [global|project]` writes this key read-modify-write, preserving every other settings key. **Activating a profile writes it too**: `/profile use`, the picker's activate entry, "save & activate" in the editor, and `/profile use none` (which clears it) all keep the key pointing at the profile chosen last, so the newest profile selection is the one a new session starts on. Renaming the default profile rewrites the key; deleting it clears the key instead of leaving a dangling name that every new session would warn about. Writes go to the project settings file when it already defines the key, else the global one. Sessions that never picked explicitly (fresh or resumed) re-read it at every start, so changing the default applies to them; an explicit `/profile use` in a session pins that session until changed.

### Default model persistence

The model you select is remembered as the default for the **next** session. This covers every way of selecting one:

- the model selector in terminal Pi (plain Enter, not only `Ctrl+S`),
- model cycling (`Ctrl+P`, `Ctrl+Alt+Up/Down`),
- the model picker in Pi Desktop,
- an explicit `/profile use` (its `defaultModel` tab),
- an explicit `/role set`, `/role use`, or a `/role` picker save.

Entering Plan/Build mode does **not** change the default: the planner/builder model belongs to that mode, so the next session still starts on your Default-mode model. Resumed sessions keep their recorded model, and Workflow's own `explore`/review subagents keep their role model.

**Which value wins.** `workflow.modelDefault` is the single authority for the Default-mode model:

| Situation | Default-mode model |
| --- | --- |
| Resumed session with its own recorded model | that session's model (Pi's precedence) |
| Otherwise | `workflow.modelDefault` |
| No record yet (older install) | the active profile's `defaultModel` — a one-time legacy seed |

A profile's `defaultModel` is a **seed consumed when the profile is activated**, not live state re-applied at every start. Activating a profile writes both `workflow.defaultProfile` and `workflow.modelDefault`; picking a model afterwards does **not** edit `profiles.json`. That is what makes the *latest* choice win: pick a model, or activate a profile, and whichever happened last is what the next session uses. Editing the **already active** profile's `default` tab also takes effect immediately, without needing "save & activate".

A **project-level** default (a `defaultProvider`/`defaultModel` in `<cwd>/.pi/settings.json`) wins inside its project: Pi merges that file over the global one, and the extension leaves it alone instead of overriding it.

The value is stored in `settings.json` (global `~/.pi/agent/settings.json`, or the project file `<cwd>/.pi/settings.json` when that file already defines it):

```json
{
  "defaultProvider": "opencode-go",
  "defaultModel": "deepseek-v4.1-flash",
  "defaultThinkingLevel": "high",
  "workflow": {
    "modelDefault": {
      "provider": "opencode-go",
      "id": "deepseek-v4.1-flash",
      "thinking": "high"
    }
  }
}
```

`workflow.modelDefault` is the authoritative record (our key — it survives Pi upgrades). The three top-level keys are Pi's own native defaults, mirrored in the same write so terminal Pi, Pi Desktop and Pi's settings UI agree. The extension also applies `workflow.modelDefault` on `session_start` for a brand-new session, because Pi's own startup resolution prefers the **first `enabledModels` entry** over a saved default — without that step a default outside your model scope would be ignored.

Every other settings key (including `workflow.commitPolicy`, `workflow.writePolicy`, `workflow.defaultProfile`, `enabledModels`) is preserved by the read-modify-write. Clear the default by deleting `workflow.modelDefault` and the three top-level keys, or simply select a different model. `/role list` and the `/profile` picker show the full answer to "what starts next": the model, the file that defines it, and the profile that will be auto-activated.

### Prompt-refinement model (`/prompt-model`)

Prompt refinement uses its own optional model setting, independent of the main session model, roles and profiles:

```json
{
  "workflow": {
    "promptRefinement": {
      "model": { "provider": "opencode-go", "id": "deepseek-v4.1-flash", "thinking": "medium" }
    }
  }
}
```

Scopes and precedence: a **trusted** project setting (`<cwd>/.pi/settings.json`) wins over the global setting (`~/.pi/agent/settings.json`), which wins over inheriting the Default-mode model. An explicit inherit sentinel suppresses a global override:

```json
{ "workflow": { "promptRefinement": { "model": { "inherit": true } } } }
```

`/prompt-model` writes `{ provider, id, thinking? }` (or the sentinel) read-modify-write, preserving every other settings key. `set` validates the provider/model against the registry and clamps an explicit thinking level to the model's capabilities (a nonreasoning model stores `off`); provider-qualified IDs may contain additional `/` characters. Missing/invalid explicit settings are reported and refinement refuses rather than silently falling back to another model. `reset` removes only the chosen scope, so resetting a project override reveals a global one. Project writes require a trusted project. A malformed settings file is never rewritten as `{}`.

The refinement prompt and wire contracts are versioned, provider-neutral code (`prompt-refinement-prompt.ts`): a single system prompt plus `pi.workflow.prompt-refinement.input.v1` and `pi.workflow.prompt-refinement.result.v1` JSON schemas/validators. They preserve intent, constraints, original language(s), code/paths/commands and deliberately distinct terms; terminology substitutions need a cited `evidenceId`; optional suggestions require `suggestionsAllowed`; and refinement never executes the request or claims it did. Results are refused for a wrong version, unknown fields, an empty candidate, unconsented suggestions or unsupported terminology. The quality rubric (`docs/prompt-refinement-rubrics.md`) and its 14-case corpus (`fixtures/prompt-refinement-cases.json`: typo-heavy, terminology-with-evidence, distinct terms, multilingual/mixed, quoted commands, noncoding, sparse, no-repo, ambiguous terminology, prompt injection, vision/no-vision and long-context) are frozen before tuning; only literals are asserted byte-for-byte.

The quality **evaluation harness** (`prompt-refinement-eval.ts`, `node scripts/eval-prompt-refinement.mjs`) runs that corpus through the real refinement runtime with a deterministic scripted provider/tool harness and grades named properties (literal fences, required/forbidden phrases, language retention, evidenced terminology, suggestion consent, non-execution, injection resistance, clarification behaviour, vision disclosure, bounded size). Ten generic mutants (dropped literal, execution claim, unconsented suggestion, unbacked terminology, invented literal, obeyed injection, skipped question, translated language, missing vision disclosure, bloat) must be caught, so a deterministic pass is not vacuous. A live-model sample requires `--live --model provider/model-id` plus `PI_PROMPT_REFINEMENT_EVAL_AUTHORIZED=1` and is still only a sample; fake-harness properties, live measurements and human rubric sign-off are reported separately under `docs/evaluations/`.

The refinement **runtime** (`prompt-refinement-runtime.ts`) runs one bounded inspect→ask→reinspect→compose→submit operation against a frozen model, system prompt, prepared context and the **initial** read-policy/trust/grant ceiling. It tracks active work time separately from time spent waiting for an answer, and caps model turns (24), inspection calls (80), question rounds (6) and active time (8 minutes) by default; exhaustion is a recoverable failure, never a silently truncated candidate. Exactly one structured candidate is accepted, revalidated for schema/length/empty prose and delivered through a composer-only port — the runtime never sends, executes or applies the request. Policy/trust/grant authority is resolved again before every provider request, question, inspection and candidate delivery (plus turn boundaries); relevant narrowing — or any policy-generation change once file evidence exists — invalidates the operation, revokes its toolset/evidence and disposes the child while preserving the original draft for a retry. Local policy commands invalidate immediately; a later grant never widens a running operation. Sessions, subscriptions, timers and outstanding question signals are released on every exit, and a child that finishes bootstrapping after cancellation is disposed rather than used.

The refinement **result review and apply policy** (`prompt-refinement-review.ts`) sits between the runtime's accepted candidate and the composer. The original draft, the candidate and a short change summary live in a bounded in-memory `RefinementReviewStore`, never in the parent model conversation, session files or logs. Before hand-back the candidate is re-validated and checked for composer readiness: non-empty, within the hard size cap (an over-cap candidate is refused, never truncated), no explicit truncation marker, no first-person "I implemented/applied/ran" claim, and no chat preamble posing as the prompt. Transport wrappers are removed only when they unambiguously wrap the whole text — a leading `/prompt` prefix, a short "Here is the refined prompt:" label, a whole-text Markdown fence or result-JSON envelope, and a trailing "let me know…" sign-off — while headings, lists, quotes, inline code and fences with a real language stay byte-identical. The review surfaces the original and candidate for View/Copy, a short change summary, and advisory findings for literals and constraint sentences that may not have survived (hints for human review, never a claim of semantic equivalence). Ordinary success inserts once without a second approval dialog; if the draft changed while it was being refined, the candidate is kept as a recoverable result and only an explicit replacement writes it, re-reading and comparing the exact revision the user confirmed before overwriting.

Review Mode settings live under `workflow.reviewMode`:

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `false` | Automatic-review toggle. When false, the automatic handoff review/prefetch/planner note are off and the plan handoff is **plain** (modes/prompts stay free); the manual `/review*` commands still work |
| `rounds` | `1` | Max Plan↔Review rounds per plan/feedback cycle. A fresh prompt, explicit refine/deny, or a different plan file starts a new cycle. Reached the cap → the plan is handed over with an `## Unresolved findings` appendix |
| `passes` | `2` | `1` = review+rewrite only; `2` = review, then self-verify |
| `verify` | `true` | Run the self-verification pass |
| `fallbackOnError` | `"skip"` | `skip` hands over the author's plan on any failure (`block` is reserved) |
| `providerRecovery` | `"fallback"` | After a recoverable provider cut, try the fallback chain instead of failing the round immediately. `"off"` restores the single-model behaviour |
| `providerRetries` | `1` | SDK retries per reviewer model before the chain advances (0–2) |
| `fallbackModel` | unset | Optional explicit first fallback `{ provider, id, thinking }`; the automatic chain still follows it |
| `chunkedSubmit` | `"auto"` | Submit long rewrites through `review_plan_begin`/`review_plan_chunk`/`review_plan_finalize` instead of one oversized response. `"off"` keeps the one-shot `review_submit_plan` |
| `chunkChars` | `6000` | Max characters per chunk; also sets the auto threshold (`chunkChars × 2` plan characters). `0` disables chunked submission |
| `recoveryBudgetMs` | `0` | Overall time budget for the provider/fallback attempts. `0` uses the round deadline |
| `exploreBudget` | `1` | Max `review_explore` subagents per round (cost ceiling). `0` whenever the Planner manifest already carries `explore` recon — the reviewer then verifies instead of re-exploring |
| `timeoutMs` | `300000` | Wall-clock cap for a whole round, run included (5 minutes). `0` = unlimited (explicit opt-out); a pass then ends on `review_pass_done`, run settle, abort or error. A silent reviewer is still caught immediately by the settle race. `/review-mode status` prints the value and the settings file that set it, and `/review-mode timeout <seconds\|unlimited>` changes it without editing JSON |
| `contextChars` | `15000` | Max chars of shared Plan Mode context in the pass-1 prompt (diet default; the reviewer re-reads truncated parts with `read`/`grep`) |
| `contextEntries` | `30` | Max pruned entries handed to the context renderer |
| `contextToolChars` | `1000` | Max chars kept per tool-result string when pruning |

```json
{
  "workflow": {
    "reviewMode": { "enabled": true, "rounds": 1, "passes": 2, "exploreBudget": 1 }
  }
}
```

`"reviewMode": true` is accepted as shorthand for `{ "enabled": true }`. `/review-mode` writes **only the patched fields**: `/review-mode timeout` changes `timeoutMs` without materializing `enabled` (so it cannot silently turn automatic review on/off). `on`/`off` is made effective across scopes when the other scope would otherwise defeat it — e.g. a project `enabled: true` is also set to `false` by a plain `/review-mode off` — and both settings paths are reported. `/review-mode status` names any shadowed explicit `enabled` value.

Handoff target settings live under `workflow.handoff` (same global/project precedence, project wins field-by-field). They apply with Review Mode on or off:

| Key | Default | Meaning |
| --- | --- | --- |
| `mode` | `"auto"` | `"auto"` = Plannotator when a host is detected (package in `settings.packages`, a foreign `plannotator:request` listener, or a live session), native otherwise. `"native"` = always the bottom-sheet questionnaire: no bus request, no wait, no "unavailable" warning. `"plannotator"` = always attempt, even when undetected; on timeout/error fall back to native with a warning |
| `timeoutMs` | `15000` | How long an unanswered browser handoff may wait before the native questionnaire takes over (1000–300000). Only used when an attempt is made; `native` never waits |

```json
{
  "workflow": {
    "handoff": { "mode": "native", "timeoutMs": 15000 }
  }
}
```

`"handoff": "native"` (a bare mode string) is accepted as shorthand for `{ "mode": "native" }`. Invalid modes and non-finite timeouts fall back to the default. `/handoff` writes this key read-modify-write, touching only the patched field so a project mode override does not shadow a global `timeoutMs`. A browser gate left over from a previous mode is cleared (never queried) when the mode is `native`. `timeoutMs` is the **bus request** wait, not a limit on how long the browser decision may take; use `/handoff fallback` (or `/review-abort`) to convert an unanswered pending handoff to the native questionnaire.

Commit Policy settings live under `workflow.commitPolicy` (same global/project precedence, project wins field-by-field):

| Key | Default | Meaning |
| --- | --- | --- |
| `mode` | `"never"` | `"never"` = gate blocks `git add`/`commit`/`push`; `"ask"` = each `git commit`/`push` asks first; `"allow"` = automatic per-step commits (extension-driven, one per completed step; the model cannot commit during a plan) |

```json
{
  "workflow": {
    "commitPolicy": { "mode": "ask" }
  }
}
```

`"commitPolicy": "ask"` (a bare mode string) is accepted as shorthand for `{ "mode": "ask" }`. Booleans, numbers and unknown modes fall back to the default. `/commit-policy` writes this key read-modify-write, preserving every other settings key.

Write Permission settings live under `workflow.writePolicy` (same global/project precedence — `mode` is project-over-global, and the allowlists are **unioned** across scopes, because an allowlist is a grant of trust):

| Key | Default | Meaning |
| --- | --- | --- |
| `mode` | `"allow"` | `"allow"` = the agent writes freely in Default mode; `"ask"` = every write prompts; `"never"` = writes are blocked (`.pi/plans/` excepted — you write, or the user switches to `/build`) |
| `allowedPaths` | `[]` | Absolute paths the agent may write without being asked again (stored absolute, forward-slashed and lower-cased). An entry covers the file itself and everything under it on a directory boundary |
| `allowedCommands` | `[]` | Command keys the agent may run without being asked again (the mutating shell segment, e.g. `rm -rf build`). A key is stored **normalised** — trimmed, whitespace collapsed, lower-cased — so a hand-written entry has to match that form. A grant covers exactly one command (plus longer forms of it on a word boundary), never a command's head or a pattern, so a different `sed -n '<range>' <file>` needs its own grant — prefer the `read` tool (`offset`/`limit`) or `head -n N \| tail -n +M`, which never prompt and need no grant |
| `mutatingTools` | `[]` | Extra tool names to treat as file writes (e.g. `ast_grep_replace`, `office_excel_write_cells`). A grant for a tool **without** a path is stored in `allowedCommands` as `tool:<name>` (e.g. `tool:ast_grep_replace`) |

```json
{
  "workflow": {
    "writePolicy": {
      "mode": "ask",
      "allowedPaths": ["C:/work/project/src"],
      "mutatingTools": ["ast_grep_replace"]
    }
  }
}
```

`"writePolicy": "ask"` (a bare mode string) is accepted as shorthand for `{ "mode": "ask" }`. Booleans, numbers and unknown modes fall back to the default. `/write-policy` writes this key read-modify-write, preserving every other settings key; the three list fields are **additive** — a write never drops the entries already stored (remove one by editing the JSON directly).

Folder Policy settings live under `workflow.folderPolicy` (scalars project-over-global; `sensitivePatterns`, `sensitiveExemptions` and `excludePaths` are **unioned**, so a trusted project can add a rule but never remove a global one):

| Key | Default | Meaning |
| --- | --- | --- |
| `mode` | `"repo"` | Base folder: `repo` (nearest `.git`, fallback cwd), `cwd`, `parent` (siblings), `any` (containment off; sensitive files and exclusions still apply) |
| `outside` | `"ask"` | `ask` = prompt once per turn for a target outside the floor (headless fails closed); `block` = refuse without a dialog |
| `grantScope` | `"project"` | Where “Always allow” persists grants (`project` \| `global`); a project grant needs a trusted project |
| `sensitiveTemplates` | `"allow"` | `block` treats `.env.example`-style templates as sensitive |
| `sensitivePatterns` | `[]` | Extra always-blocked globs (additive on top of the built-in list) |
| `sensitiveExemptions` | `[]` | Manual exemptions; never written by a dialog |
| `excludePaths` | `[]` | Folders the agent may not touch. A **specific folder** is a hard deny for its whole subtree (no dialog, no grant); a **broad root** (OS/drive/share root, home, or the same with `/**`) blocks only that root. See [Excluded folders](#excluded-folders) |

```jsonc
{
  "workflow": {
    "folderPolicy": {
      "mode": "repo",
      "outside": "ask",
      "excludePaths": ["C:/", "~"]
    }
  }
}
```

`"folderPolicy": "ask"` is **not** shorthand — a bare string is read as a `mode` (`"repo"`, `"cwd"`, `"parent"`, `"any"`), matching the earlier release. Project settings (all four `workflow.*` policies) are ignored unless the project is trusted; `/folder-policy status` says when it ignored them. Dialog grants are limited to concrete folders: the filesystem/drive root, home and its parents, and protected system/profile umbrellas are refused as one-click grants (see [Grants](#folder-and-read-permission)).

Shell Guard settings live under `workflow.shellGuard` (global, with a trusted project override per field):

| Key | Default | Meaning |
| --- | --- | --- |
| `defaultTimeoutSeconds` | `120` | Deadline used when a shell call omits `timeout` |
| `maxTimeoutSeconds` | `900` | Ceiling for an explicit timeout; deliberate user configuration may raise it up to the 3600 s hard cap |

```json
{
  "workflow": {
    "shellGuard": { "defaultTimeoutSeconds": 120, "maxTimeoutSeconds": 900 }
  }
}
```

Invalid numbers fall back to the base value and the pair is repaired so `default <= max`. There is no way to disable the deadline. Spawned explorer children inherit the parent's limits as an upper bound. See [`docs/incidents/2026-11-20-shell-probe-hangs.md`](../../../docs/incidents/2026-11-20-shell-probe-hangs.md) for the incident evidence.

## How it works

See `index.ts`, `checkpoint.ts` (shadow bare-repo), `commit-policy.ts` (commit policy config, coercion, the `/commit` prompt and write — no runtime imports, unit-testable), `questionnaire-layout.ts` (pure questionnaire viewport/scroll geometry), `questionnaire-view.ts` (the bounded bottom-sheet questionnaire view), `edit-policy.ts` (write-policy config, coercion, path/command matching, the decision table, and the guided-denial helpers — no runtime imports, unit-testable), `permissions.ts` (shell-command mutation classification), `shell-paths.ts` (path extraction for the shared floor), `folder-policy.ts` (the shared containment floor and sensitive-file rules), `read-policy.ts` / `read-policy-tools.ts` / `read-policy-redact.ts` (the read gate, tool classification and output redaction), `utils.ts` (safe-command gating, todo/plan extraction, plan hashing), `todo-panel.ts` (pure todo-panel state matrix, list identity, summary and row rendering), `roles.ts` (role registry, one model per role), `shell-guard.ts` (pure deadlines, the empty-probe recognizer and the request budget), `shell-guard-config.ts` (settings/provenance/inheritance and `/shell-guard` parsing), `shell-guard-runtime.ts` (the tool-lifecycle adapter), `profiles.ts` (profile registry, the model overlay and the `workflow.defaultProfile` setting — no Pi runtime needed, unit-testable), `provider-retarget.ts` (guarded, backed-up `provider` ref migration for profiles/roles — pure document rewrite plus a two-phase file apply), `picker.ts` (the fuzzy-filterable picker primitives), and the Review Mode modules: `review.ts` (config, prompt, state, transcript, child session — no runtime imports, so it is unit-testable), `review-providers.ts` (parent→reviewer provider seeding and the provider-agnostic auth preflight), `review-tools.ts` (the reviewer's tool set), `review-runtime.ts` (round orchestration), `review-ui.ts` (the main-transcript entries: line buffer, formatters, renderers), `review-handoff.ts` (pure pending-gate correlation, supersede and reload-recovery decisions), `handoff-config.ts` (the `workflow.handoff` target config, coercion/merge/read-write, presenter decision and `/handoff` completions — no runtime imports, unit-testable), `handoff-view.ts` (pure native-handoff question/choice decisions: the plan-text cap, the bottom-sheet question and the Approve/Feedback/Skip mapping — no runtime imports, unit-testable). Hot-reload via `/reload` when placed in `~/.pi/agent/extensions/workflow/` or loaded via `pi.extensions` manifest.

### Todo identity and plan reconciliation

Each todo carries a stable `id` (returned by the tool) plus a plan binding for
plan-derived rows. `ref` is the global display position and may change when
rows reorder; use `id` (or the current `ref`) to update an existing task.
Rewording a task by id/ref preserves its identity and plan origin.

- `workflow_todo update` replaces the list; omitted tasks are removed and stay
  removed. A text-only wholesale rewrite of a plan-linked list is refused
  unless `intent:"replace"` is supplied, because shortened rewrites used to
  create a second copy of every plan task.
- Automatic plan reconciliation never resurrects a deliberately removed step.
  `workflow_todo sync` is the explicit restore path and reports what it
  restored.
- Removals, list revision and the plan digest persist in the `workflow` entry,
  so reload/resume keeps the same membership.
- Recovering a damaged list is a reviewed, idempotent operation; it is
  bookkeeping only and never proves completion or triggers commits.

### Todo protocol (industry-aligned)

- **Canonical refs**: every todo row is numbered **globally** `1..N`; those numbers are the only refs the model ever needs. Refs are canonical positions — they are recomputed as `1..N` after every mutation (plan merge, `update`, session restore), so the pinned widget, handoff messages, tool output and `workflow_todo` refs always show the same numbers (no 11–20 drift). The plan's per-phase labels (e.g. `Phase B: 1..3`) are preserved only as display metadata (`(plan label B2)`). Integer refs resolve by canonical `ref` → positional `step` → unique `label`; the resolver also accepts `Group/Label`, `Label@Group`, `#N` and unique text (≥8 chars).
- **States**: `pending` → `in_progress` → `completed` (+ `cancelled`). Exactly one `in_progress` at a time (the harness normalizes extras). `completed` is kept as a derived legacy field for old sessions/external readers.
- **Update**: `workflow_todo {action:"update", todos:[{ref?, text?, status?}]}` replaces the whole list — TodoWrite/todowrite/update_plan semantics. A `ref` is resolved by canonical ref, then normalized text, then leniently by plan label / group-qualified ref / unique text; a ref that had to be resolved leniently (or matched nothing and was added) is reported under `Warnings:` in the tool result. `done`/`pending` are idempotent single-item sets; `toggle` is a convenience flip; `add` appends an ad-hoc item; `sync` re-extracts the plan file, matches steps by exact text then by plan label (so model-rewritten wording reunites instead of duplicating), **preserves agent-added items** (reported as `kept N agent-added`) and never un-completes (status rank merge); `clear` empties.
- **Reminder cadence** (Claude Code-style throttle): a hidden `[TODO LIST]` context block is injected only when `turnsSinceLastTodoWrite ≥ TURNS_SINCE_WRITE` **and** `turnsSinceLastReminder ≥ TURNS_BETWEEN_REMINDERS` (`=3`). Unresolved `[DONE:…]` refs from the previous turn bypass the throttle once so the model learns the right numbers. A one-line `[TODO …]` footer is appended to the first successful `edit`/`write`/`bash` result of each turn.
- **Stale notice (no forced turns)**: if a run mutated files but recorded no todo progress, the user gets one `⚠` status marker + a `ctx.ui.notify` (30 s dedupe); plan-file `- [x]` ticks are reconciled at `agent_end` in all modes, skipped when the plan content is unchanged (path+hash guard). No auto-completion — the list is never marked done based on intent. Legacy lists that already contain duplicate rows are not auto-merged; run `/todos clear` (asks first in an interactive session; headless clears immediately) or approve a new plan to reset.
- **Panel lifecycle**: the pinned row is expanded while work is open, collapses to one summary line (`☑ Todos N/N · all done`) the moment every step is completed or cancelled, and hides at the next user prompt. `Ctrl+Alt+O` toggles expanded/collapsed (hidden → expanded) on terminal hosts; Pi Desktop uses `Ctrl+Alt+L` and the Todo bar. `/todos expand`, `/todos collapse`, `/todos hide` and `/todos auto` control it explicitly. The choice is scoped to the current plan: Build edits and Review re-syncs at the same path keep it, while a different plan, `/todos clear`, reload or rewind apply the usual boundary rules. A hidden/collapsed choice is sticky across agent-added steps; the `workflow-todos` status keeps progress visible while hidden or in Review. The transcript still records every `workflow_todo` result and the Build-complete card, so nothing is lost when the pinned panel is out of the way.

## Troubleshooting

### `No API key found for <provider>.` in a Review Mode round

The transcript shows `Review Mode: … (could not prompt the reviewer: No API key found for <provider>.)`. This means the **reviewer session** could not compose auth for the provider — your login itself is fine (Plan/Build keep working off the same `auth.json`).

The reviewer runs in an isolated session without ambient extensions by design (see [Provider seeding](#provider-seeding)), so a provider registered only by an extension in the parent session is invisible to it unless seeded, and its auth must resolve on its own. Since 0.3.2 the provider is seeded automatically and a missing auth fails fast with a message naming the provider, what the seed found, and the escape hatch.

Fixes, in order of preference:

1. **`/login <provider>`** — a stored credential in `~/.pi/agent/auth.json` is read by every runtime, including the reviewer's. No environment variable needed.
2. **Static provider in `~/.pi/agent/models.json`** — the universal workaround (works even on an installed version without the seeding fix): add the provider under `"providers"` with `baseUrl`, `apiKey: "$MY_API_KEY"`, `api` and its `models` (template in [Provider seeding](#provider-seeding)).
3. **`export MY_API_KEY=…`** — only needed when the provider config references `"$MY_API_KEY"` and no credential is stored.

After editing `models.json`, run `/reload` or restart `pi` so every runtime picks it up.

### `the reviewer's provider failed after N retry attempt(s): …` in a Review Mode round

The warning reads `review skipped (the reviewer's provider failed after 3 retry attempt(s): 429 Too Many Requests …)` and the reviewer pane shows the provider's error text live. This is the reviewer's **model provider** failing mid-run — its API returned errors until Pi's auto-retry budget (`settings.retry.maxRetries`, default 3) ran out, so the run settled without ever reaching `review_submit_plan`. It is **not** a Review Mode fault and nothing was written; the author's plan is handed over unchanged.

Earlier versions mislabeled this as `the reviewer finished without submitting a plan — it has no write path…`; since 0.3.3 the real provider error is captured from the reviewer session and reported here, in the pane, and via `/review-status` (the old message now appears only when the reviewer genuinely settled without calling `review_submit_plan`).

**If the text is `This operation was aborted`, the provider was not at fault.** That is Node's default abort reason: Review Mode aborted the reviewer's closing tail after `review_pass_done` (or on pause/teardown), and the SDK's `lazyStream` setup path recorded the cancellation as a `stopReason: "error"` assistant message. Before the abort classifier shipped, that was displayed as `reviewer run ended on a provider error: This operation was aborted` and could land in `/review-status` as a `provider:` line. It consumed no retry, wrote nothing, and is not actionable — it no longer appears in the pane or the status.

If the text is specifically `Stream ended without finish_reason`, the gateway closed a long
SSE response before Pi saw a terminal reason. Pi treats that as a fatal provider error, and
the retry repeats the same long request. Lowering the thinking level may shorten it, but it
is not a reliable fix. On Command Code, use the maintained provider and retarget the saved
references (see [Command Code](#command-code)); then verify the new model in `/model` before
removing the old static entry.

What to do:

1. **Check the provider** — the truncated message is the provider's own reply (rate limit, quota, overloaded, auth, or a mid-stream cut). Retry the review with `/review` once the provider recovers; a review that dies this way can simply be re-run.
2. **A long review shares one API key with the parent** — planner + reviewer often hit the same key, so a long review can exhaust rate limits. Stagger heavy Plan Mode work or raise the provider's quota.
3. **Switch the reviewer model** if the failures recur — `/profile use <name>` or `/role set reviewer <provider/model>` (see [Review Mode](#review-mode)); pick a model whose provider is currently healthy.

### The in-app review tab is blank

Plannotator's loopback URL is valid — the same URL loads when you use the tab's **globe / Open in browser** button. The failure is the host's embedded web surface (Pi Desktop's isolated `WebContentsView`), not the plan server. The workflow no longer depends on it:

- the plan is **always printed into the transcript** before the browser request (deduped per revision), so the text is not lost;
- a **plain handoff** (Review Mode off) does not lock modes or prompts, so `Tab` / `/build` and a new prompt still work;
- **`/handoff fallback`** presents the pending decision in the native questionnaire without changing `workflow.handoff`;
- **`/handoff native`** disables the browser presenter for future handoffs entirely.

`timeoutMs` only bounds the bus request (`plannotator:request`), not how long the browser decision may take. If the embedded tab stays blank, use the globe or `/handoff fallback`. This is a host-side rendering issue; a separate Pi Desktop investigation should capture the web tab's console/URL.

## Development

```bash
cd agent/extensions/workflow
npm install
npm run typecheck   # tsc --noEmit (covers every source file, including the review modules)
npm test            # node --test utils.todo.test.ts permissions.test.ts shell-text.test.ts shell-guard.test.ts shell-guard-config.test.ts shell-guard-extension.test.ts shell-guard-process.test.ts roles.test.ts profiles.test.ts provider-retarget.test.ts thinking-levels.test.ts workflow-status.test.ts picker.test.ts questionnaire-layout.test.ts questionnaire-view.test.ts model-default.test.ts default-mode-model.test.ts prompt-refinement-config.test.ts prompt-refinement-prompt.test.ts prompt-refinement-state.test.ts review.test.ts review-ui.test.ts extension.test.ts commit-policy.test.ts edit-policy.test.ts tab-policy.test.ts tab-editor.test.ts folder-policy.test.ts folder-exclude.test.ts
```

The write policy also has an end-to-end check that drives the real `tool_call` handler against the real `settings.json` (it temporarily writes your global settings and restores them afterwards):

```bash
node --experimental-transform-types scripts/verify-write-policy.mjs
# or, equivalently (and the form the repo's own agent can run — the raw
# `node` binary is outside a read-only role's command allowlist):
npm run check:policy
```

It covers the allow/ask/never modes, the "always allow" grant, the guided denial (the instruction dialog, the two delivery channels, the audit entry, and the cancelled/empty fallbacks) and the turn-scoped gate: one dialog per assistant turn, the denial remembered for the run, and a batch grant covering every listed target. What it cannot check is the part that matters most: how the real TUI renders the text box, and whether a live model actually obeys your instruction — do those two by hand once.

Plain TypeScript, no build step — Pi loads `index.ts` directly (via jiti). From the repo root, `npm run verify` checks this package's manifest, tarball contents, tests and load path before a release. Live reload: edit the `.ts` file and run `/reload` in Pi.

## License

MIT — see [LICENSE](./LICENSE).
