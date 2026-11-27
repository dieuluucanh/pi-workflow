# Changelog

All notable changes to this package are documented in this file.

## [0.17.5] - 2026-11-27

Release target: **0.17.5**, the first npm release after **0.13.0**. The
0.14.0–0.17.4 sections below record development milestones included in this
release, not separately published versions. Live human acceptance and Pi
Desktop staging are **not verified** by this release.

### Release overview and migration

- **Breaking:** replaces the frozen/journaled execution engine with normal
  markdown plans and a model-driven Orchestrator. Old engine runs are not
  migrated; restart those from the approved plan. Each row uses an in-process
  Build child; verification is ordinary visible bash, with no automatic
  diff/check/acceptance engine.
- **Breaking:** `/orchestrator <verb>` and `/review <verb>` replace the old
  hyphenated command families. Reviewer body replacement and chunked plan
  submission are removed. The Planner owns the body, the Reviewer owns its
  appendix, and a bounded revision loop settles required changes before handoff.
- Adds shell deadlines/quarantine, prompt refinement and its host-agnostic
  composer contract, multi-repository rows, additive action groups/mode choices,
  live profile/role model switching, and independent child TODO presentation.
- Fixes dormant-run session ownership, child settle/report races, execution
  TODOs firing during Plan/Review, shared safe-shell classification, and the
  duplicate activation notices detailed below.
- Maintains experimental Orchestrator status. Automated checks do not establish
  real-provider, Terminal or Desktop acceptance.

### Documentation and verification

- Restores descending changelog milestone order, updates install/tested-version
  examples, replaces obsolete operator instructions and clearly labels legacy
  acceptance records. Desktop bundle pins must be checked independently.
- Pins the shared composer conformance fixture to LF on checkout so Windows
  `core.autocrlf` cannot invalidate its byte-level checksum. Verification errors
  retain enough test output to identify failed assertions in CI. PATH lookup uses
  the child platform's delimiter, and the dead-code guard scans files in-process,
  so the suite passes without Windows hosts or a ripgrep install.
- Node 24.22.2: root release-tool tests and the four-package verification gate
  pass, including typechecks, package tests, packed import closure and packed
  extension load smoke tests.

### Fixed — one activation notice

- **No duplicated `/profile use` block.** Every live-owner summary now arrives
  in one info notice. The Pi TUI `showStatus` renders each info row from one
  mutable `lastStatusMessage`, so a row created before the next entry could be
  repainted with a later message; the extension guarantees one info notice per
  command and never interleaves durable entries between two info notices.
- **One info notice per command.** The entry writer never notifies: each
  activation, role, delete and editor command emits exactly one info notice,
  after every durable entry, with the default profile, default model,
  Default-mode model and live reviewer/builder-child/settling-child lines
  folded into it.
- **Applied-switch info notices removed.** The reviewer line no longer raises a
  separate `notifyReview` info notice; when folded into the neutral activation
  notice it is deliberately unprefixed (profile/role summary content), while
  reviewer-authored warnings keep the `Review Mode:` prefix. The notify-scope
  audited set drops from 29 to 28 review-owned call sites.
- **`/role set`, `/role use`, the `/role` picker, profile delete and the
  profile editor** fold their summary into the same single activation notice
  instead of emitting an extra info row.
- **Tests:** `profile-live-switch.test.ts` (30), the profiles composer tests and
  `notify-scope.test.ts` (audited set 28) cover the one-notice contract.

## [0.17.4] - 2026-11-27

Local Workflow version **0.17.4**, not published to npm or GitHub. Desktop staging
and live human acceptance are not verified by this entry.

### Fixed — independent Orchestrator child TODO panel

- Child display preference is independent of the parent's plan-scoped preference
  and scoped to the child run: a new run gets effective Auto through scope
  mismatch, while reloading the same run restores its choice.
- `/todos` and terminal `Ctrl+Alt+O` target the active parent/child panel; use
  `/orchestrator view parent|child|auto` to switch. The `todos` action group
  exposes Auto, Show, Collapse and Hide in child view, including empty, hidden
  and headerless states. `/todos clear` refuses in child view with parent-view
  guidance.
- Empty child presentation follows the real header/state matrix, without fake
  rows or zero-total progress. Child refresh/replay preserves parent preference
  and bookkeeping; progress remains non-empty-only.
- Coverage includes pure panel derivation and decoding, contribution behavior,
  live widget rendering, active targeting, empty/headerless selection, run-scope
  persistence/replay, and parent-state isolation (`todo-panel.test.ts` and
  `workflow-contributions.test.ts`). This is automated evidence, not live host
  acceptance.

### Changed — shared read-only shell classification

- The shared classifier now recognizes a fail-closed subset of safe `sed` print/select programs, package-runner wrappers (`npx`, `pnpm exec`, and related forms), and transparent launchers such as `env`, `timeout`, `nice`, `stdbuf` and `command`. Plan and Review use the same verdict table; Explorer receives read-only commands but not verification commands. Read-only `sed` and wrapped verification no longer count as writes under `writePolicy: ask`.
- `awk`, `sed -i`/`-f` and unsafe `sed` programs, installs, builds, real file redirects and git mutations remain restricted. Wrapper and `sed` file operands are attributed for path checks, including operands reached through wrappers.
- Fail-closed safeguards include an environment-assignment name allowlist (excluding startup and module-resolution variables), wrapper flag checks and a recursion-depth cap. Package-runner option parsing respects `--`; timeout duration values are validated, and unknown command flags are refused. Review refusal reasons, copy and prompts now describe the shared policy; regression tests cover write-policy ask behavior and unchanged mutation grant keys.
- Added `shell-programs.ts` and `shell-wrappers.ts` with their tests. Verification is not an OS sandbox: allowed verification may execute project code, and a package runner may fetch a missing named tool.

## [0.17.3] - 2026-11-26

This patch keeps execution TODOs out of the plan-editing phase. Version bumped by
this change, **not published**; it builds on the unreleased `0.17.2` profile
live-switch patch. A real Plan/Review session showed the failure: the revision
turn's "Plan Steps" message started a run before the revision prompt arrived, and
the TODO footer, reminder, `[DONE:n]` completion, stale warning and auto-commit
fired while the Planner was only editing a plan.

### Fixed — execution TODOs are live only after Build starts

- **One follow-up per revision turn.** `sendRevisionFollowUp()` delivers only the
  `# Planner revision — round N` prompt; the extra `workflow-todo-list` "Plan
  Steps" custom message is gone, so a revision turn can no longer start an
  execution run before its instructions arrive.
- **The placeholder moved to the Build kickoff.** `agent_end` no longer
  synthesizes a single "Step 1" row from the plan title during Plan/Review.
  `seedExecutionTodoOnBuild()` creates the fallback row when Build starts from an
  approved plan (best-effort, in its own `try/catch`, so it cannot block or roll
  back the kickoff), and a list that belongs to a different plan is cleared
  before the new `todos.planPath` is assigned, so a new plan does not inherit old
  rows.
- **The Plan TODO list is read-only.** `todoExecutionLive()` (`mode !== "plan"`)
  is the single predicate: the passive `[TODO …]` footer, the `[TODO LIST]`
  context reminder, `[DONE:n]` completion, the per-step auto-commit and the
  "Todo list not updated" stale warning are all gated on it, and the footer skips
  `.pi/plans/` writes. `workflow_todo` refuses every action except `list` in Plan
  mode (`details.error: "plan-mode-read-only"`) and `list` reports the steps as
  planned, not executing.
- **Prompt wording.** The injected Plan context calls the list read-only execution
  state created by the Build kickoff, the `[REVIEW MODE ACTIVE]` note says a
  revision turn edits the plan and never touches the execution list, and
  `buildPlanRevisionPrompt()` opens with "This is a planning turn, not
  implementation" and tells the Planner to leave the execution TODO list
  untouched (the old "update the TODO list" rule is gone).
- **A custom continuation keeps an open revision cycle.** A non-user custom run
  during a pending Planner revision no longer calls
  `endReviewTurn()`/`beginReviewCycle()`, so a display message cannot reset the
  cycle or drop the findings the Planner was asked to answer.
- **The Plan-mode panel is a preview.** The pinned panel renders a Plan list as
  `☐ Todos d/t · planned · not executing · /todos expand`, never promotes a row to
  `▶` (including an `in_progress` row), and offers no `next` step until Build
  starts.

### Tests and docs

- `review-negotiation.test.ts`, `plan-revision.test.ts`, `plan-naming.test.ts`,
  `todo-panel.test.ts` and `workflow-mode.test.ts` cover the one-message revision
  follow-up, the empty Plan list and the Build seed, the gated
  footer/reminder/`[DONE]`/stale/auto-commit paths (with a Build-mode
  counterpart), the read-only `workflow_todo`, the custom-continuation cycle
  guard, the plan-preview panel and the `todoExecutionLive` table.
- `README.md` documents the read-only Plan/Review list and the Build-kickoff
  ownership; `package.json` is `0.17.3`.

## [0.17.2] - 2026-11-26

Development milestone included in 0.17.5; the one-notice behavior in 0.17.5
supersedes this milestone's per-owner notification channels.

### Added — live profile and role switching

- `/profile use`, profile-picker activation, `/profile use none`, `/role set`
  and role-picker saves reconcile the live parent, reviewer and Build child in
  place. The in-flight request keeps its old model; the next request uses the
  new model without an abort, session restart or re-seeded review round.
- Reviewer model labels, footer/status and `/review status` follow the applied
  model. Refused switches retain the live model, warn with both model names,
  and preserve the selection for the next child or round. A settling child is
  left alone.
- One display-only `workflow-model-switch` audit per owner records
  `scope`/`role`, `from`, `to`, `ok`, `changed`, `at` and any error/reason.
  The entry writer is silent. Scopes are `parent`, `reviewer`, `builder-child`
  and child-local `child`.

### Changed — the parent owns the launch model

- A child-local profile switch affects only that in-process session through
  `setModel(..., { persist: false })`. It never writes the global profile,
  Workflow default model, native default model/thinking mirror, or the parent's
  transcript/settings. The parent alone chooses new children's launch model.
- Tests cover running/paused/handoff/warm-idle reviewers, refused switches,
  each owner and audit scope, child-local settings isolation, and runtime/UI
  model labels (`profile-live-switch`, `in-process-child`, `review-runtime`
  and `review-ui` suites).

## [0.17.1] - 2026-11-26

This release fixes the Planner↔Reviewer revision loop introduced in `0.17.0`
(version bumped, not published). The loop existed but could stall, hand off a
plan the reviewer had refused, or silently lose the reviewer's notes; the
contract below is now enforced by the harness instead of trusted.

### Fixed — Planner↔Reviewer revision loop

- **Note ids are strict per-round `R<n>`.** Numbering restarts at `R1` in every
  review round, so a restated note may reuse its previous id, and omitted ids
  are still assigned `R1..Rn` in submission order (`R01` canonicalises to
  `R1`). Any other supplied form (`RV1`, `F1`, `1`, a blank) and a duplicate id
  inside one submission are rejected by `review_submit` with the offending
  entries named. The rendered `## Reviewer Revisions` appendix is parsed back
  and compared field by field (`id`/`step`/`change`/`findingIds`, in order)
  with the submission, so a note that would not survive the one-bullet grammar
  is refused **before** anything is written rather than silently dropped or
  reshaped.
- **`notes-unparsed` is a fail-closed outcome.** A `revise`/`block` round that
  submitted required changes which parse to zero notes is neither revisable nor
  approvable: the Planner gets no revision turn, the plan is **not handed off**,
  and the notice names the submitted-versus-parsed counts so the refusal is
  actionable. `ReviewNegotiationDecision` gained `handoff`, which is false for
  `continue` and `notes-unparsed` and true for every terminal outcome
  (`converged`, `exhausted`, `no-revision`, `review-failed`).
- **The revision-turn lifecycle is tracked, not guessed.** A revision turn is
  recorded before its follow-up is delivered and resolved exactly once by the
  run that owns it; a pending turn that has not started blocks the leftover
  `agent_end` from resolving, reviewing or handing off a stale snapshot, a
  custom (todo/follow-up) run does not reset the turn, and a genuine new task
  does. The decision is made from the round's result snapshot, never from the
  mutable review-state closure, and a revise round can no longer fall through
  to a silent handoff when the turn cannot be opened.
- **A no-op revision gets one corrective turn.** A Planner turn that changes
  nothing is not a revision and not a verdict: while the budget allows it, the
  same notes earn one corrective turn whose prompt says the previous turn
  changed nothing (no handoff, no re-review); once the budget is spent the
  handoff carries the `exhausted` non-convergence line.
- **Every revision turn opens a fresh review cycle.** The re-review is round 1
  of its own cycle, so `rounds` stays a within-cycle cap and can never cut a
  revision short; the previous session-wide counter (and any `keepRound`/
  `loopReReview` bypass to work around it) is gone. A manual `/review` also
  starts at round 1 of a new cycle instead of being refused as round 2.
- **Every decision is audited.** Each negotiation decision writes one
  `workflow-review-negotiation` entry (`outcome`, `request`, `handoff`, round,
  budget, parsed notes, submitted changes, verdict, reason) from the round
  snapshot it decided from, on both the automatic post-Plan path and manual
  `/review`, so converged, exhausted, no-revision, review-failed and
  notes-unparsed decisions all leave a trace.
- **The attempt guard stops a non-final retry from ending the loop.** A
  non-final (retried/truncated) run is skipped and audited: it may not resolve
  the revision turn, review or hand off while the retried run owns the plan,
  and the skip notice is shown once per distinct attempt.
- New/updated tests: `review-notes.test.ts` (id grammar and round-trip),
  `plan-revision.test.ts` (lifecycle seam, attempt guard, corrective turn),
  `review-negotiation.test.ts` (decision matrix, fail-closed handoff, audit,
  per-revision cycle) and `notify-scope.test.ts`.

### Changed — docs and package manifest

- `README.md` documents the strict per-round `R<n>` ids, `notes-unparsed`, the
  corrective no-op turn, `rounds` (within-cycle cap) versus `maxRevisions` (the
  loop budget), the handoff decision, the audit entry and the attempt guard, plus
  the fact that each revision turn starts a fresh review cycle.
- `package.json` is `0.17.1` and `files[]` now ships `plan-revision.ts` and
  `review-negotiation.ts`, which `index.ts` imports but earlier tarballs did not
  include.

## [0.17.0] - 2026-11-26

This release is **cut by the 2026-11-26 review-note/step-count plan** (version
bumped by it, not published); the `0.16.0` advisory-note bullets below are
superseded.

### Breaking — the Planner↔Reviewer revision loop replaces the advisory notes (2026-11-26)

- **The reviewed plan now has two owners.** The Planner owns the plan BODY; the
  Reviewer owns the `## Reviewer Revisions (round N)` appendix. A revise verdict
  with open required changes now earns the Planner a **revision turn** instead
  of ending the cycle: it edits the body, answers every note id through
  `plan_revision_done` as `applied`, `rejected` or `not_applicable` (a concrete
  reason is required for the last two, an `applied` with an unchanged body is
  refused, and editing the appendix is refused), and the reviewer re-reviews
  the revised body with those responses. The loop repeats until the reviewer
  approves or the budget is spent, then hands off.
- **`maxRevisions` is the new budget** (`workflow.reviewMode.maxRevisions`,
  `0`–`5`, default `3`; `0` = the previous one-shot review). `rounds` stays the
  per-cycle Review round cap. When the budget is exhausted with notes still
  open the loop stops without converging: the handoff says so, Approve accepts
  the plan as written and Give feedback continues. The loop covers the
  automatic post-Plan review and `/review` in Plan mode; `/review` outside Plan
  mode stays one-shot.
- **The downstream advisory-note pipeline is reverted, not deprecated.** Rows
  no longer carry `reviewNotes`, the run no longer keeps `unboundReviewNotes`,
  the child kickoff no longer carries a `## Review notes (advisory)` block, the
  mission asks the parent for no note placement or acknowledgement (mission
  **v6**), and the report no longer lists note conflicts. **The Orchestrator and
  direct Build consume only the approved plan's steps** — they never read, parse
  or bind the appendix. A step change goes back to Plan through the handoff's
  Feedback path.
- **`countPlanSteps`/`stepCount` are deleted.** The harness no longer guesses a
  plan's step count from its text, so the note-to-row binding heuristic and its
  false warning (a long plan reported as "24 numbered steps") are gone with it.
  One step per row is the model's call.
- **The chunked rewrite path stays deleted.** `review_plan_begin` /
  `review_plan_chunk` / `review_plan_finalize`, the plan assembler, the
  `replacement-body` submission and the `chunkedSubmit`/`chunkChars` settings
  remain removed; there is no body rewrite left to configure.

### Changed — docs

- `README.md` and `docs/plan-format.md` describe the loop, the body/appendix
  ownership split, the `plan_revision_done` dispositions and the fact that the
  appendix never reaches a row or a child. `maxRevisions` is documented in the
  Review Mode settings table.

### Fixed — Orchestrator ownership follows execution, not record existence (2026-11-26)

A finished run kept refusing every prompt: input ownership was derived from
whether an `OrchestratorRun` record existed (`state.hasRun`) instead of whether
a child or the run phase still owned execution, so an idle, interrupted or
settled record blocked Orchestrator, Plan, Build and Default alike.

- **Input is phase-based.** `orchestratorInputDecision()` now takes
  `runPhase`/`childPhase`: `running` forwards, `paused` queues, `starting` and
  `settling` return short truthful wait notices, the run phase `running`
  (between rows) refuses, and every dormant or terminal phase allows the prompt.
  It shares `executionOwnsSession()` with mode switching and Reviewer admission
  so the three cannot drift. `OPERATOR_SCHEMA_VERSION` is `5`.
- **A settled run auto-completes.** New `completeOrchestratorRunIfSettled()`
  sets `completed` when every row is `completed`/`cancelled` and no child is
  live, fired from a successful TODO write, the child's `idle` publish after its
  report is recorded, and session restore. A recorded failure or abort wins, so
  a settled run whose child then fails or is aborted stays `interrupted`/`paused`.
- **Terminal runs are sealed and replaceable.** `completed`/`cancelled` runs are
  not revivable by `orchestrator_dispatch` (explicit row included),
  `orchestrator_retry`, `/orchestrator retry` or `/orchestrator resume`;
  `orchestrator_start` and `/orchestrator start` replace a terminal or fully
  settled run once no child is live. A cancelled row is terminal for `next`,
  retry and resume selection, and terminal status reports no stale next row.
- **Abort and stop clarified, not changed.** `/orchestrator abort` keeps
  `requiresMode: true` because it only applies to a live child.
  `/orchestrator stop` remains the escape when rows can no longer settle (for
  example after `/todos clear`, since `runRowsSettled` reads the live TODO list).
- New/updated tests: `orchestrator-run.test.ts` (terminal/settled helpers),
  `orchestrator-operator.test.ts` (phase decisions, replacement, cancelled rows),
  `orchestrator-lifecycle.test.ts` (settle → complete → prompt reaches parent in
  Plan and Orchestrator → replacement start → `start <plan>` recording → failure
  and abort precedence) and `workflow-contributions.test.ts` (no stale next row).

## [0.16.0] - 2026-11-25

### Changed — Review Mode is advisory: the plan body is never rewritten (2026-11-25)

- **The reviewer is a reference, not an author.** `review_submit` appends
  exactly one `## Reviewer Revisions (round N)` section to the plan file and
  leaves the author's plan body byte-identical; a pass-2 resubmission replaces
  that round's section instead of stacking a second one. Nothing in the
  pipeline applies a revision to the body, so there is no diff and no
  apply/keep choice at the handoff — the plan is printed as the planner wrote
  it.
- **Revision ids make every note addressable.** Each required change is
  rendered as `- **R2 · Step 3:** … _(F1)_`: a stable `R<n>` id (normalised to
  `R1..Rn` in submission order when the model omits one) plus the finding ids
  it answers. The appendix also states its own precedence:
  `_Advisory review notes. The approved plan body is authoritative on any
  conflict._`
- **The notes reach the Orchestrator and the Build child, with a fallback.**
  `parseReviewNotes` parses the appendix deterministically (shared with the
  renderer, with a render→parse round-trip test), the run keeps every note it
  could not bind in `unboundReviewNotes`, and the mission tells the parent to
  place those notes itself. Rows are bound only when the plan's numbered step
  count and the model's row count match — otherwise every note stays unbound
  and the mismatch is reported, never guessed onto a row.
- **The child kickoff carries `## Review notes (advisory)`.** The Build child
  gets the approved plan as authoritative and each bound row's notes as a
  bounded block that never drops an id (surplus notes collapse into
  `… and N more: R7, R8, R9`). Its final summary must acknowledge every id as
  `applied`, `not applicable — <why>`, or
  `conflicts with the plan — followed the plan`, and the parent reports each
  conflict with the row ref and the child's reason. A note is never a
  requirement, a gate or an acceptance criterion.
- **The chunked rewrite path is deleted, not repaired.**
  `review_plan_begin`/`review_plan_chunk`/`review_plan_finalize`, their
  registration and permission rows, the plan assembler
  (`beginPlan`/`appendPlanChunk`/`takeAssembledPlan`/`resetPlan`), the
  `replacement-body` submission, the pass-1 chunk prompt branch, and the
  `chunkedSubmit`/`chunkChars` config keys are gone. An old `settings.json`
  that still carries those keys is tolerated: unknown review keys are ignored,
  not fatal.
- **The handoff names the note count.** The handoff line gains `· N notes`
  beside the finding count (`Review: revise · 3 findings · 2 notes`). No body
  rewrite is implied by it.
- **`planHash` and the guards are documented as they behave.**
  `stripReviewAppendix` removes only `## Review changes` and
  `## Unresolved findings`, so the hash covers the author's body **plus** the
  `## Reviewer Revisions` appendix: a reviewer round changes it once, and the
  same body with the same appendix hashes identically. Tests pin the handoff
  print dedupe, the Plannotator stale-tab check, the approval re-read and the
  pause/review `unchanged` comparison against that behaviour.

### Compatibility

- This checkout is `@dieulc/workflow` **0.16.0**. Pi Desktop's
  `resources/workflow.lock.json` still pins the previously published tarball;
  it moves to 0.16.0 only after a separate, explicitly approved release. The
  Desktop architecture docs that name an older publisher version are release
  follow-ups, not part of this change.
- The reviewer tool allowlist is exactly `read`, `grep`, `find`, `ls`,
  `review_bash`, `review_explore`, `review_submit`, `review_pass_done`; the
  removed `review_plan_*` names are not registered in any form.
- Contribution v1, the mode/menu contract and the 0.14.0 verb grammar are
  unchanged.

## [0.15.0] - 2026-11-25

### Changed — action groups, the mode menu and inline controls (2026-11-25)

- **Action groups are additive v1 presentation data.** An action may carry
  `group { id, label, order, placement }`. Identity is `(owner.id, group.id)`,
  `placement` is the closed enum `inline | menu`, `order` defaults to `0`, and
  `placement` defaults to `inline`; an ungrouped action keeps the old code path,
  so an older host renders it exactly as before. Workflow publishes
  `run-controls` (inline, order 30), `review-controls` (inline, order 30) and
  `todos` (menu, order 40). Unknown placements and malformed groups fail the
  envelope rather than being guessed.
- **`mode-choice` is its own kind and slot.** A choice carries label,
  description, tone, order and presentation-only `checked`; the required
  same-owner `actionRef` names the `kind:"action"` that executes it. A choice
  has no `command`, `enabled` or `disabledReason` of its own. A dangling, foreign
  or wrong-kind reference parses but is refused by the resolver instead of
  inventing a command.
- **Four clean menu labels, one unchanged glyph identity.** The menu publishes
  `Default`, `Plan`, `Orchestrator` and `Build` choices, while the composer mode
  badge keeps its existing `◦ default`, `⏸ plan`, `🧭 orchestrator` and
  `▶ build` labels byte-for-byte. Each choice resolves to a `mode-<key>` action
  whose command is the registered `/default`, `/plan` (or `/workflow` when
  `/plan` is held by another owner), `/orchestrator`, or `/build`.
- **Mode actions are disabled precisely.** The current mode is disabled with
  `current mode`; a live Review/handoff lock disables every other mode with the
  lock notice; a mode whose command could not be registered is disabled with a
  named reason instead of an enabled dead button.
- **`Auto todos` and the TODO menu.** The display verbs are now `Auto todos`,
  `Show todos`, `Collapse todos` and `Hide todos` in the `todos` menu group; the
  computed `todos-toggle` action is removed. The four verbs are not published
  when a live child pins the panel, and the TODO action set in that view is
  only the `orchestrator-view` action — `Show parent todos` in child view,
  `Show child todos` otherwise (the run controls stay in `run-controls`). The
  progress row counts the list the pinned panel shows.
- **Review controls are inline.** Running publishes `Pause review` +
  `Abort review`; paused publishes `Resume review` + `Abort review`, both in
  `review-controls`. The standalone `review` action (status/resume) is removed;
  the `workflow-review` status line owns the phase, and handoff/transition
  publish no controls because the review tab owns the decision. Commands are
  `/review pause`, `/review resume`, `/review abort` — never the retired
  hyphenated spellings.
- **One child status surface.** Workflow no longer publishes an
  `orchestrator-child` status row; the `workflow-orchestrator` setStatus line
  remains the single child telemetry surface. The child action set is the TODO
  view toggle plus `Pause child` / `Resume child` / `Abort child` in
  `run-controls`.
- **`setWorkingMessage` ownership is explicit.** On a generic-contribution
  Desktop host the extension owns the working message only while it owns the
  turn: the live child line (including pause/abort hints and paused/settling
  guidance) is written with `setWorkingVisible(true)`, and a running, paused or
  handoff Review suppresses the write entirely, so the reviewer's message is
  never overwritten. The extension clears only a message it set, and it never
  uses visibility as a liveness hack over a native retry/compaction indicator.

### Compatibility

- This checkout is `@dieulc/workflow` **0.15.0**. Pi Desktop's
  `resources/workflow.lock.json` still pins the published **0.13.0** tarball and
  its staged bundle is that 0.13.0 build (hyphenated commands, no groups or
  `mode-choice`). This package has **not** been staged into Desktop.
- Contribution v1 stays additive: a 0.13.0 host ignores `group` on an action and
  drops the unknown `mode-choice` kind, keeping its action/status rows. A host
  rendering 0.15.0 contributions gets groups, choices and inline controls.
- The 0.14.0 verb grammar is unchanged in 0.15.0: `/orchestrator <verb>` and
  `/review <verb>`, with no hyphenated aliases.

## [0.14.0] - 2026-11-25

### Changed — one command grammar for `/orchestrator` and `/review` (2026-11-25)

- **One shape per family.** `/orchestrator <verb>` now owns
  `start|status|inspect|pause|resume|abort|retry|stop|say|view|help`, and bare
  `/orchestrator` enters the mode. `/review <verb>` owns
  `status|pause|resume|abort|say|mode|prompt|help`, while bare `/review` or
  `/review <path>` still runs a round. Both families get table-driven help and
  argument completions, case-insensitive verbs, `--help`/`-h`, and
  "did you mean" suggestions.
- **Ten hyphenated registrations removed, with no aliases.**
  `orchestrator-pause`, `orchestrator-resume`, `orchestrator-abort`,
  `orchestrator-view`, `review-mode`, `review-prompt`, `review-status`,
  `review-pause`, `review-resume` and `review-abort` are gone. The only
  migration aid is the error sentence for the removed `cancel` verb: it is now
  `stop`.
- **Guards live in the verb tables.** The dispatcher applies mode, run and
  child requirements in declared order; none is inferred from a handler body.
  `/review status` and `/review mode status` answer different questions — the
  round versus configuration — and the help teaches both. The default
  `/review [path]` form keeps the path fallback: only an exact verb match
  shadows a plan file, and the help names that caveat.
- **Dead `/handoff execution|once` completions removed.** The tokens and
  completion branches are gone, and `handoffArgumentCompletions` is wired to
  `/handoff`; `/handoff execution` now prints the usage naming `execute`. The
  live `/handoff execute <decision-id> orchestrator|build` stage-2 path is
  unchanged.
- **Review start and abort share one implementation.** The default round and
  `/review say` use the same dispatcher admission (`blockWhileChildActive`, then
  `admitReviewerNow`); `resume` uses only the resume admission, and `mode`
  blocks with the corrected `/review mode` label. `/review abort` is the single
  explicit exit that stops the round or discards the pause and settles the gate,
  so no removed registration can drift from it.
- **The 0.14.0 milestone was the parity target.** It was not separately
  published to npm; the former claim of a published Desktop pin was incorrect.
  Desktop staging must be verified independently. The W compatibility fixture
  lists the two family commands instead of the ten removed names; new coverage
  lives in `command-text.test.ts`,
  `orchestrator-command.test.ts`, `review-command.test.ts` and
  `review-command-handlers.test.ts`.

### Changed — Review criteria are fixed; reviewer guidance is additive (2026-11-25)

- **The five criteria moved out of the overridable prompt.** They now live in
  `REVIEW_CRITERIA`, embedded verbatim in `REVIEW_SYSTEM_PROMPT`, instead of in
  the `DEFAULT_REVIEW_PROMPT` text a file could replace. The rules of
  engagement (read-only, protocol, restraint) moved with them.
- **`review-prompt.md` is additional guidance.** `.pi/review-prompt.md`
  (project) still wins over `~/.pi/agent/review-prompt.md` (global), but both
  are now appended to the fixed criteria and can no longer replace a criterion —
  an override cannot remove or weaken one, only add emphasis.
- **Criterion 5 is extended to simplicity and over-engineering.** It now names
  the smallest change that satisfies the requirements, and flags unnecessary
  steps, speculative abstractions, extra layers, unwanted configuration or
  dependencies, and out-of-scope work as findings.
- **Pass 2 diffs the actual revisions.** It re-reads the original plan and the
  appended `## Reviewer Revisions` section, and its prompt includes the named
  **over-engineering check** (do the revisions add layers, abstractions,
  configuration flags, dependencies, phases or steps the requirements do not
  need?).
- **A round's resubmission replaces its section.** Pass 2's `review_submit`
  strips the round's `## Reviewer Revisions (round N)` section before appending,
  so the section is replaced rather than stacked and `planHash` stays the
  author's plan body.
- **`/review-prompt` and the `prompt` status line say guidance-only.** The
  command description reads "additional reviewer guidance — adds to (never
  replaces) the fixed review criteria", and `/review-mode status` prints
  `prompt : <source> (guidance; fixed criteria always apply)`, so neither reads
  as a way to rewrite the criteria themselves.
- `DEFAULT_REVIEW_PROMPT` is kept as a deprecated alias for the new
  `DEFAULT_REVIEW_GUIDANCE`, which holds the built-in guidance text only.

### Fixed — a settled Orchestrator child is released and its report can no longer be lost (2026-11-25)

Session `01a20fc1-feb9-77a9-bb14-9e17961c1beb` proved three independent defects: a
settle never released the child, the dispatch record overwrote the report, and
the report was queued behind the parent's polling turn.

- **The settle now releases the child.** `finish()` publishes `settling`, waits
  (bounded) for `onSettled`, then publishes `idle`, unsubscribes and disposes
  the session on the next macrotask. A report that cannot be recorded within
  15 s fails honestly and still releases, so `orchestrator_dispatch` for the
  next row can never be wedged by "a child is already settling".
- **The lost update is fixed.** `dispatchOrchestratorRow` captured the run
  record before `await controller.start()` and then wrote it back, clobbering
  the report `onSettled` had just recorded (23:09:53.380 `idle`+report →
  23:09:53.383 `running`+none). `recordDispatchIfNotReported(run, {startedAt})`
  is a compare-and-set: a report at/after the attempt start wins. Dispatch is
  also a short admission now (the tool no longer awaits the whole child run),
  and the row's TODO status is only set when the dispatch was recorded.
- **Reports are steered, not queued.** The wake message uses
  `deliverAs: "steer"` (was `followUp`), so it lands at the parent's next tool
  boundary instead of after its whole polling turn — the 23:12:56Z delay is
  gone.
- **The report is self-sufficient.** `orchestrator-report.ts` prepends
  `Status:`, `Todos:`, `Cancelled:`, `Open:`, `Policy refusals:` and a
  deterministic `Suggested:` line built from the child's final TODO list and
  the policy refusals the controller observed. External blockers (a policy
  refusal or a user-only action) are never re-dispatched; in-scope work is
  retried on the same row. A hung settle cannot be misread as success.
- **The parent can abort a live child.** New `orchestrator_abort` tool. It
  releases `starting|running|paused`, preserves an existing report, and leaves
  the row retryable; a settled child returns "nothing to abort" and its report
  is never overwritten (the old path replaced it with "Child aborted: user
  abort"). `orchestrator_retry` now accepts amended `instructions` for the
  loop-back branch.
- **Run-record honesty.** New `recordAbort`/`recordFailure`: abort keeps a real
  report and records the reason as `paused`, failure records `interrupted`, and
  `setRunPhase("paused")` no longer clears `blockedReason`.
- **Child honesty.** `workflow_todo` gains `cancel`; a policy-blocked step is
  recorded as `cancelled` (never `completed`) and the child contract requires
  the final summary to name every step it did not complete and why. A cancelled
  run row is terminal for row selection, so it cannot be re-dispatched forever.
- **Mission v4** states the two-branch rubric, forbids polling while a child
  runs, and requires the parent's final report to list every row's outcome and
  every external deviation.
- **Docs corrected:** the README no longer claims the deleted automatic
  settle → diff → checks → verify → accept engine or "runtime-owned evidence";
  the parent tool list is `start|dispatch|status|retry|abort`.
- New tests: `orchestrator-report.test.ts`, `orchestrator-lifecycle.test.ts`
  (7 end-to-end cases including the RC2 race and the policy-blocked branch),
  plus controller/run/tool/operator/mission/contract coverage. The previously
  unregistered `orchestrator-parity.test.ts` is now part of `npm test`.

### Changed — plan filenames carry a UTC time prefix (2026-11-24)

New plans are written to `.pi/plans/YYYY-MM-DD-HHmm-<slug>.md` (UTC `HHmm`), so
same-day plans sort by creation time instead of by slug. The write gate, the
Plan Mode prompt, the explicit `/review <path>` resolution and the reviewer's
write path all use `getUtcPlanStamp` / `normalizePlanPath`;
`dateCorrectedPlanPath` lets `/review` find a plan whose date was mistyped.

- **Legacy date-only names keep working and are never renamed.** An existing
  `.pi/plans/YYYY-MM-DD-<slug>.md` file is written in place; only a NEW file
  gets a prefix. No migration is needed.
- **Same minute + same slug is the same plan.** Distinct plans need distinct
  slugs (the filename identifies a plan, not an event).
- New tests: `plan-naming.test.ts` covers the stamp (day boundaries, zero
  padding, invalid clock), every `normalizePlanPath` branch, the `/review`
  lookup, the write gate, `applySubmittedPlan`, and the Plan Mode prompt.

### Breaking — legacy engine deletion (2026-11-24 sweep, v0.14.0)

This sweep finishes the 2026-11-24 refactor: the old engine is now actually
deleted, not merely unreferenced by the new paths.

- **Removed modules:** `orchestrator-runtime`, `orchestrator-state`,
  `orchestrator-store`, `journal-payloads`, `orchestrator-types`,
  `orchestrator-check-repair`, `orchestrator-repair-manifest`,
  `orchestrator-adapters`, `plan-spec`, `plan-compiler`, `plan-checks`,
  `plan-checks-block`, `plan-lint`, `plan-command-shape`, `frozen-snapshot`,
  `todo-snapshot`, `final-gate`, `check-executor`, `execution-state`,
  `verification-deadline`, `legacy-recovery`, and
  `scripts/repair-orchestrator-checks.mjs`. The live workspace resolver and
  bounded git runner moved to `workspace-node.ts` and `git-bounded.ts`.
- **Removed tools/commands/status keys:** `workflow_execution`,
  `/orchestrator-repair-checks`, the `workflow-execution` footer key and its
  `execution` segment, and the `planContract` compat block.
- **Run record is the only orchestration state.** `OrchestratorRun` holds the
  plan path, rows, per-row workspace/cwd, instructions, reports, phase and
  `blockedReason`. A reload restores it; a `running` phase becomes
  `interrupted`. Old journals, frozen v1/v2 snapshots and run directories are
  never read or migrated — restart from the approved plan.
- **Multi-repo is first-class.** `orchestrator_start` takes
  `workspaces: [{id, path}]` and steps of `string | {text, workspace?}`;
  `orchestrator_dispatch` takes a declared alias or an absolute root as `cwd`.
  Unknown, missing, broad or overlapping roots are refused; a multi-root run
  with an unbound row fails closed.
- **No Build execution engine.** Build completes when every non-cancelled TODO
  row is done. The final gate, check executor, evidence map, barren-boundary
  pause and `[DONE:ref]` evidence revert are gone. Verification is ordinary
  bash. The shell quarantine survives a reload through the `workflow` entry's
  `shellQuarantine` key.
- **The parent is excluded from the worktree while a child is live.**
  `parentMutationRefusal` (pure, in `parent-exclusion.ts`) refuses parent
  `edit`/`write`/`powershell` and any `bash` command the classifier cannot
  prove read-only during `starting|running|settling`; the managed child, a
  paused child and a settled parent are allowed.
- **Approval has no lint/check preview** and the handoff questionnaire has no
  `checkPreview` option.
- **Docs:** the plan-format/template/migration guides are now a normal markdown
  guide; historical engine docs carry a **Superseded (2026-11-24)** banner.

*Correction:* the earlier 2026-11-24 entry below described the removals as
landed while the old modules, commands and tool were still reachable. They are
now actually removed; that entry is retained for the contract decisions it
records.


### Breaking — model-driven Orchestrator and append-only review (2026-11-24)

- **Orchestrator has Build permissions.** `ROLE_POLICIES.orchestrator` is now
  `commandClass: "full"`, `canWrite: true`; the mode keeps `edit`/`write` and no
  longer refuses bash/powershell. Delegation to a child is a prompt convention,
  not a permission cage. An idle/paused run no longer blocks a mode switch.
- **The plan contract is removed.** `plan_validate`, `/plan lint`, `/workflow lint`,
  the freeze gate, the zero-gate acknowledgement, `plan-compiler`/`plan-spec`
  validation on approval and the executable-check schema are gone. A plan is a
  normal markdown document; the model extracts the TODO rows.
- **Review appends, never rewrites.** `review_submit_plan` is replaced by
  `review_submit` (findings, verdict, summary, revisions). The harness appends a
  `## Reviewer Revisions (round N)` section and preserves the original body.
  The chunked `review_plan_begin`/`chunk`/`finalize` write path is not registered.
- **No frozen run.** The TODO list is mutable in every mode. Run metadata is a
  session-entry record (plan path, rows, instructions, last child report); the
  NDJSON journal, both frozen schemas, the diff gate, row-check execution, repair
  rounds and the final-gate marker are removed. Old runs are not resumed.
- **The parent dispatches; the child verifies.** `orchestrator_start` binds the
  model-supplied steps; `orchestrator_dispatch` starts one in-process Build child
  per row. A successful child report wakes the parent, which marks the row done
  and dispatches the next. A blocker wakes the parent to inspect and amend the
  instruction; the parent does not fix code and does not re-run the child's checks.
- **Removed tooling:** `migration-scan`, `scripts/migration-report.mjs`,
  `orchestrator-advance`, `orchestrator-todo-runtime`. The migration/integration
  docs are historical and marked superseded.

- **Notifier ownership: only reviewer notices carry `Review Mode:`.** A single helper,
  `notifyReview()`, had doubled as the generic Workflow notifier and as the
  reviewer-branded one, so an Orchestrator pause could surface
  `Review Mode: Paused · Builder 3/19 · /orchestrator-resume to continue …` even
  though no review round, review pause or reviewer session existed. The two scopes
  are now explicit: `notifyWorkflow()` is the neutral helper for Plan/Build/
  Orchestrator/handoff lifecycle notices, and `notifyReview()` is reserved for
  messages emitted by the independent reviewer or a review-owned turn, keeping
  `reviewNoticeText()` as the one idempotent prefix owner. Orchestrator/child,
  handoff/Plannotator and plan-lifecycle notices lose the automatic prefix; they
  may still mention review in their own sentence (`Browser review still open`,
  `Review feedback — switched to Plan mode`). Repeated paused/settling Esc is
  silent (no reminder row) because the composer border already names the resume
  and abort controls. Tests: a `neutralNotice()` helper that requires the notice
  and rejects a `Review Mode` prefix, whole-array negative checks in the
  Orchestrator-only cases, targeted handoff assertions, a new `OE11` paused-child
  queue case, and positive `Review Mode:` controls (HD2, `L`) so the reviewer side
  cannot silently go neutral.

- **The Orchestrator composer border is phase + controls only.** The top border used to render `Working · Builder 3/19 · bash npm test -- --watch … · ESC or /orchestrator-pause to pause · /orchestrator-abort to stop`, because `orchestrator-activity.ts` echoed the child's last tool — a tool name plus up to 100 characters of its key argument — and the frozen-row counter. That reached ~190 columns, so on a normal-width terminal the editor fell back to a compact line that *still* carried the command, or truncated the state away. The border now says `Working · ESC or /orchestrator-pause to pause · /orchestrator-abort to stop`, `Starting…`, `Pausing…`, `Paused · /orchestrator-resume to continue · /orchestrator-abort to stop`, `Verifying`, and `Waiting · answer the dialog`, with a hint-free compact form for narrow terminals. The accepted input type was narrowed to `phase`/`pausePending`/`retrying` so the tool echo and the counters cannot come back by accident, and the Esc matrix, spinner and overflow geometry are untouched. The information moved rather than disappeared: the pinned TODO pane owns progress, the transcript band owns tool lines, and the footer `workflow-orchestrator` line now reads `child running · <model> · ctx 43% (86k/200k) · ↑12k ↓3.0k · 01:23` (parent view: `run running · next task-2 · child running`). `childPhaseWord()` gives every surface one phase word, fixing `settling` vs `verifying` and a premature `paused` during a pending pause; the host `orchestrator-child` row now uses the same formatter instead of its own bit list (ids/commands unchanged), and `/orchestrator status|view` keeps the richer `child 2/7 running · … · 3/5 todos` report. Tests: `orchestrator-activity`, `child-stats`, `tab-editor` (widths 16–200), `workflow-status`, `workflow-contributions`, `orchestrator-operator`, `orchestrator-child-view`, the previously stale `orchestrator-parity` expectation, and `OC1`/`OC2`/`OC3` end-to-end (a long bash command must never reach the border, while the footer keeps the telemetry and the transcript keeps the tool line).

- **Rollout: read-only migration report, dual-read verification and the honest
  gate record (row 19).** New `migration-scan.ts` (plus
  `migration-scan.test.ts`, registered in `files`/`test`) inventories existing
  state without writing: per run it replays the journal, applies
  `plan-check-specs-repair` amendments in memory, reports the stored snapshot
  version and what the reader upcast from, lists malformed/quarantined checks
  and the exact bytes that will never execute, flags checks bound to an
  unbound workspace alias, lists prose `acceptanceChecks` as criteria, and
  detects a stale `snapshot.json`. Per plan it compiles with the same linter as
  the freeze path and reports rows, gate/diagnostic/manual counts, row checks
  and line-numbered errors. `scripts/migration-report.mjs` is the read-only
  filesystem walk (`--runs-dir`, `--plans-dir`, `--plan`, `--json`, `--strict`)
  and ends with an explicit repair list; it never edits a journal or snapshot.
  Scanning the live runs root found 6 runs (4 v1, 1 already amended, 2 older
  runs with no `todos.frozen`) and 134 plans (75 legacy plans still carry
  prose bullets and do not compile), with no run rewritten. The repaired
  ERP run still restores at `paused`, seq 76, 14/15 accepted, 6 valid checks
  and stays v1 on disk (not migrated). Harness gates: `npm test` 2005/2005,
  `typecheck`, `check:policy` 100/100, `check:read-policy`, and the pack gate
  (111 files, 1/1 package). ERP static gates: `format:check`,
  `check:docs-reference` (7 pages), `check:docs-glossary` (52 terms),
  `typecheck` (91/91), `lint` (49/49) and `check` (20 sub-gates, exit 0).
  Explicitly not claimed: ERP full `pnpm test`, Playwright, provider sandbox,
  benchmark, N−1 seeded upgrade, release diagnostics, publish/commit, and
  task 15's 15/15 (the user's `/orchestrator retry` remains). Outcome recorded
  in `docs/rollout-2026-11-24-plan-execution-contract.md`; the migration guide
  gains the read-only first step.

- **Typed plan-execution contract, canonical docs and recovery, end to end
  (Phase A + Phase B).** Plans are now compiled by one authority
  (`plan-compiler.ts`) into a typed `PlanSpec`: rows from `## Plan Steps`, typed
  row/final checks from fenced command blocks, whole-bullet code spans and a
  restricted `checks:` block (`kind`, `workspace`, `timeoutMs`,
  `expectedExitCode`), `Acceptance:` kept as non-executable criteria, and
  line-numbered diagnostics. `/plan lint` / `/workflow lint` / `plan_validate`
  plus the handoff preview and reviewer gate compile before approval, so an
  ambiguous or prose-only check is refused instead of frozen; a zero-gate plan
  needs an explicit acknowledgement. Freeze writes a `schemaVersion: 2`
  `FrozenExecutionSnapshot` with provenance, typed checks, workspaces and a
  validation report, while v1 snapshots upcast in memory, malformed v1 checks
  are quarantined (never executed) and unknown versions fail closed. Journal
  lines keep their v1 framing/checksum/`prev` chain but every known event type
  now has a payload validator, unknown event types and payload versions are
  rejected, and `snapshot.json` seq/revision is cross-checked. Restore reads the
  journaled snapshot instead of re-freezing from mutable plan text and rebinds
  by plan path when the digest changed. One `CheckExecutor` (host-tool and
  headless transports with the same validation, workspace, deadline and output
  bounds) classifies every failure; only `test`/`timeout` repair, while
  `metadata`/`policy`/`environment` block with a concrete fix. The final gate is
  journaled once as a content-addressed `final_gate` record, so a passed gate
  cannot re-run and an amended list needs a new pass. `workflow.orchestrator`
  owns `childTimeoutMs`, `verificationTimeoutSeconds` and `gitTimeoutMs`, and a
  malformed frozen list is repaired by the append-only
  `plan-check-specs-repair` `run.control` event through
  `/orchestrator-repair-checks` or `scripts/repair-orchestrator-checks.mjs`.
  New docs: `docs/plan-format.md` (format, surfaces, limits, failure taxonomy,
  final-gate marker, amendment, settings, v1→v2 compatibility and what is never
  auto-executed), `docs/plan-template.md` (canonical skeleton that lints clean)
  and `docs/plan-migration.md`; the README gains a plan-format section. No
  `package.json` version bump and no new `## [x.y.z]` section.

- **Plan lint, preview and pre-approval gating.** The compiler is now consulted
  before approval, not at run creation. `/plan lint [path]` (and `/workflow
  lint [path]`) plus the read-only `plan_validate` tool print the row count,
  gate/diagnostic/manual counts, every exact final/per-row command with its
  workspace, timeout and expected exit code, and line-numbered
  warnings/errors. The handoff sheet carries the same compiled preview. A plan
  that does not compile is refused before `run.created`; a plan with zero final
  `gate` checks needs an explicit acknowledgement, while a fenced-commands
  `## Verification` freezes with no extra prompt. Reviewer rewrites go through
  the same gate and cannot introduce an ambiguous check or drop every gate
  silently. The Plan Mode prompt now documents the executable-check syntax,
  per-row metadata, limits and the acknowledgement rule. New module
  `plan-lint.ts` (registered in `package.json` `files` and the `test` script)
  with `plan-lint.test.ts` coverage; no journal, snapshot or on-disk format
  changed.

- **Frozen plan-check recovery (Phase A).** `/orchestrator-repair-checks`
  (`status`, `--file <manifest.json>`, `--from-plan`, `--allow-empty`, `--yes`)
  and `scripts/repair-orchestrator-checks.mjs` append ONE durable
  `plan-check-specs-repair` `run.control` amendment instead of rewriting the
  journal. The current and proposed checks are shown first; the in-session path
  asks `ui.confirm` unless `--yes` and re-freezes through the TODO store so
  `validateFrozenSnapshot` re-checks the result and the panel updates. The
  script defaults to a dry run, requires `--apply --yes`, enforces optional
  `--expect-seq`/`--expect-accepted` fences, stores the manifest via
  `journal.putArtifact`, then reopens the run and verifies seq +1, the checksum
  chain, `snapshot.json`, the replayed specs and the unchanged accepted/task
  states; a repeated apply is a no-op. The command is pinned in
  `fixtures/compat-baseline.json`; new coverage: `plan-checks.test.ts` fixtures,
  `repair-orchestrator-checks.test.ts` temp-run integration and `RC1`–`RC5`
  command cases.

- **Orchestrator Working/Paused on the composer, with pause-only Esc.** The in-process Build child is a separate session, so the host's native indicator never represented it and the child UI bridge (correctly) no-ops every chrome write. The Workflow editor now projects the child onto the real composer top border in Parent, Child and Auto views: `Working · Builder n/m · <tool>` with `ESC or /orchestrator-pause to pause · /orchestrator-abort to stop`, `Pausing…`, `Paused · /orchestrator-resume to continue`, and `Verifying…`. Esc is handled in the focused editor (not a global listener), so autocomplete and permission dialogs keep their own Esc. Once the child owns execution, EVERY Esc press is consumed: a pause burst cannot reach the host abort, dispose the child, or fail the row; paused/settling presses are inert and silent (the composer border already names
  `/orchestrator-resume` and `/orchestrator-abort`). The controller now scopes pause intent across `agent_start`/`agent_settled` and the prompt rejection, suspends the active execution deadline while paused (remaining budget preserved), and resumes only after pause settlement; resume is a short admission so a resumed child can be paused again immediately. `/orchestrator-pause|resume|abort|view` now route through the operator, fixing duplicate/racy transitions and false "forwarded" prose for a starting child. New tests: `orchestrator-activity`, `orchestrator-child-controller`, `orchestrator-child-ui`, composer border/Esc cases in `tab-editor`, and `OC1`/`OC2` end-to-end cases.

- **Live child model switching + child telemetry.** `/profile use` (picker and prompt), `/role set`, and the role picker now switch an ALREADY-RUNNING Orchestrator Build child and Review reviewer in place through the public `AgentSession.setModel` (`persist: false`): the in-flight request finishes on the old model, the next provider request uses the new one, nothing is aborted or restarted, the warm session is kept, and the next child/round always launches on the new model. A switch that races child creation is reconciled before the first prompt (a refused prepared-child switch is replaced by a fresh child); a paused child switches before resume. A refused switch keeps the live session, names both models, and never blocks the row/round. The Orchestrator child no longer persists a programmatic switch as the global default model/thinking. `in-process-child.ts` now exposes `currentModel()`/`stats()`/`setModel()` (feature-detected, never throwing); `child-stats.ts` is the one formatter for model, context %, tokens and elapsed time. `/orchestrator-view` now switches BOTH the pinned panel and the footer's `workflow-orchestrator` line (child view/auto: full child line; parent view: run/next plus a compact child hint), always one bounded row; a single unref'd repaint clock drives elapsed only while a shown child is starting/running and stops on pause/settle/parent-view/reload. The pinned panel header, `/orchestrator status|inspect`, and the host `orchestrator-child` contribution share the same truth (the child row keeps its historical shape and appends stats). New tests: `child-stats`, `orchestrator-stats-clock`, `in-process-child`, `orchestrator-child-controller`, `orchestrator-child-view`, plus `OE5`–`OE10`/`RE1` end-to-end cases.

- **Reviewer ownership is Plan-only; no speculative Reviewer in Orchestrator/Build.**
  Fixed two independent defects behind the execution-time `Review Mode: reviewer
  unavailable …` warning:
  - The `agent_end` handoff ran an unconditional reviewer **prefetch** before the
    Plan-only return, so an Orchestrator parent turn and every in-process Build
    child (which loads this extension) booted a reviewer session without a plan
    review. The prefetch is removed; a Reviewer session is created only on
    demand by an admitted Plan round.
  - The isolated-session SDK probe rejected class constructors, falsely
    reporting `ModelRuntime.create` / `SessionManager.inMemory` /
    `SettingsManager.inMemory` as missing. Function/class carriers with callable
    statics now pass; genuinely missing APIs still fail closed with the exact
    names (no ambient or file-backed fallback).

  New `review-policy.ts` is the single admission answer: a review round requires
  a parent Plan session, no executing Orchestrator owner (child
  `starting/running/paused/settling` or run `running/paused/blocked`, including
  between-row windows), and — for automatic review — Review Mode on **plus** a
  current Plan submission. `/review` and `/review-resume` are **Plan mode
  only**; outside Plan they refuse with `/plan` guidance without switching
  modes, while `/review-status`, `/review-pause` and `/review-abort` remain
  available for recovery. Automatic review binds to the terminal `agent_end`:
  retry/compaction/queued continuations do not review an incomplete plan.

  The same ownership predicate now gates every mode transition at the point it
  executes (commands, Tab/composer cycling, the `pi-code:plan-mode` host toggle,
  approval-to-Build and legacy refine paths), and a validated child identity
  cannot be overridden by restored Plan/manual metadata. Reviewer startup is
  generation-guarded: teardown during a cold bootstrap disposes the late session
  exactly once, and a stale start can neither install nor clear a newer one.
  Child teardown (which runs without `session_shutdown`) releases review
  ownership defensively.

  Orchestrator row acceptance is unchanged and remains mechanical: diff gate,
  acceptance checks, `task.verify` evidence and final plan checks. No LLM
  review gate was added; a failed check still repairs/blocks exactly as before.
  Tests: `review-policy.test.ts`, `extension.test.ts` (`RO*`, `MT*`, `SW*`,
  `OER*`, `LR1`), `review.test.ts` (`lifetime:*`), plus the corrected
  `isolated-session.test.ts` SDK-export contract. No version bump.

- Documentation for the prompt-refinement feature set (parity plan step 41):
  the package README now documents the `/prompt` and `/prompt-refine` commands,
  the bounded inspect→ask→compose→submit operation, context/provider privacy
  (no ambient extensions/skills/templates/themes or AGENTS/CLAUDE injection,
  bounded parent-selected context, repository text treated as untrusted data),
  `/prompt-model` scope/inherit/reset with Default-mode inheritance, the one-shot
  composer arm, busy refusal and binding conflicts, Escape/Stop cancellation
  scoped to the operation, conflict handling on a moved draft, failure/recovery
  and attachment loss on process restart, image/Terminal-path limits, the public
  `composer-transform-v1` capability (contribution shape, grant-only bootstrap,
  private single-use rendezvous handoff, typed frames, old-host fallback, live
  policy revocation), bundled/override/disable/safe-mode behavior for Pi
  Desktop, a compatibility matrix, tested versions (0.13.0 + Pi SDK 1.5.0) and
  honest acceptance limits (semantic quality is human-reviewed; live desktop,
  real-terminal keyboard and Playwright composer runs remain NOT RUN). The root
  README gains a matching `/prompt` summary. No behavior change, no version bump.

- Prompt-refinement quality evaluation harness (parity plan step 35):
  `prompt-refinement-eval.ts` (with `prompt-refinement-eval.test.ts`) and
  `scripts/eval-prompt-refinement.mjs` run the frozen rubric corpus through the
  real runtime with a deterministic scripted provider/tool harness, grade named
  properties (literal fences, required/forbidden phrases, language retention,
  evidenced terminology, suggestion consent, non-execution, injection
  resistance, clarification, vision disclosure, bounded size) and require ten
  generic mutants to be caught. The evaluation corpus grows to v2 with
  no-repo, ambiguous `sub-session` vs `child session`, prompt-injection,
  vision/no-vision and long-context cases; rubric weights and the prompt/result
  versions are unchanged. A live-model sample is gated behind
  `PI_PROMPT_REFINEMENT_EVAL_AUTHORIZED=1` plus an explicit `--model`, and the
  recorded result at `docs/evaluations/2026-11-24-prompt-refinement-quality.md`
  keeps fake-provider properties, live measurements (NOT RUN) and human rubric
  sign-off (PENDING) separate.

- `/btw` now delivers a note exactly once (parity fix, plan step 32). The
  command used to append the same note three ways — a persisted
  `workflow-btw` custom entry, a visible custom message through
  `sendMessage`, and a second `sessionManager.appendCustomMessageEntry` — and
  then re-inject it again from `before_agent_start`. The result was duplicate
  transcript rows and a duplicate model disclosure. It now appends the entry,
  sends one visible custom message (sessionManager fallback only when the host
  has no `sendMessage`), and marks that note delivered so the per-mode context
  hook injects only genuinely queued notes. Rewind clears the delivered scope
  with the queue. Covered by `BTW1`–`BTW3` in `extension.test.ts`.

- `/workflow` is now registered unconditionally as the Plan-mode entry
  (parity fix, plan step 31). It used to exist only as the fallback when
  `/plan` was already owned by another extension (pi-code), so hosts without
  that package — Pi Desktop ships none — never had the documented alias.
  `/plan` keeps its own registration and conflict tolerance; `/workflow` is no
  longer tied to it. The frozen command baseline records both.

- Frozen `composer-transform-v1` contract (`composer-transform.ts`,
  `fixtures/composer-transform.conformance.json`): additive
  `composer-control` contribution (composer-actions slot, semantic icon list,
  checked/enabled state, one-shot return discriminator, same-owner toggle and
  transform references, public-command/companion operation metadata), bounded
  start/progress/candidate/status/cancel/apply/lifecycle frames, live SDK
  `sourceInfo` binding for both commands, grant-only string bootstrap and the
  single-use private EventBus rendezvous that hands the typed port to the
  companion. The fixture is byte-identical with Pi Desktop and both suites
  assert the same SHA-256 and verdicts. Drafts, images, model/context and
  grants never travel through contribution args (the old 1 000-character args
  limit is unchanged); diagnostics expose identity/counts only. An older host
  drops the unknown kind and keeps text/status fallback, explicitly not
  attachment-aware. The handshake is proven against unmodified SDK 1.5.

- Shared isolated-session infrastructure (`isolated-session.ts`, `provider-auth.ts`):
  Review and prompt refinement now share only the general second-session
  bootstrap. Child sessions use an in-memory `SessionManager` and an in-memory
  `SettingsManager` (no session/settings files), no ambient extensions, skills,
  prompt templates, themes or AGENTS/CLAUDE context files, and explicit
  caller-filtered context blocks. They get their own `ModelRuntime`, parent-only
  provider seeding, a provider-agnostic auth preflight, an exact active-tool
  assertion (missing, unexpected or unverifiable tools fail) and disposal of the
  raw SDK session on every bootstrap failure. A substituted model fails instead
  of falling back silently. Review keeps its prompts, submission tools, fallback
  policy and legacy opt-in anti-recursion marker; prompt refinement sets no
  process-global environment marker. `provider-auth.ts` holds the shared auth
  probe while `review-providers.ts` keeps its reviewer-facing aliases and
  messages.
- Prompt-refinement prompt/schema contracts (v1): a provider-neutral system
  prompt plus `pi.workflow.prompt-refinement.input.v1` and
  `...result.v1` JSON schemas/validators. The prompt preserves intent,
  constraints, original language(s), code/paths/commands and deliberately
  distinct terms; terminology changes cite evidence; optional suggestions
  require consent; refinement never executes or claims execution. Results
  reject wrong versions, unknown fields, empty candidates, unconsented
  suggestions and unsupported terminology. Adds the eight-case evaluation
  corpus (typo-heavy, evidence-backed terminology, distinct terms,
  multilingual/mixed, quoted commands, noncoding, sparse) and a versioned
  quality rubric frozen before tuning.
- Bounded prompt-refinement runtime (`prompt-refinement-runtime.ts`): one
  inspect→ask→reinspect→compose→submit operation with a frozen model, system
  prompt, prepared context and the initial read-policy/trust/grant ceiling.
  Active work time is tracked separately from waiting for the user, and model
  turns, inspection calls, question rounds and active time are hard-capped;
  exhaustion is a recoverable failure. Exactly one structured candidate is
  accepted and revalidated (schema, length, non-empty/truncated prose,
  unapproved scope claims), then handed only to an injected composer port — the
  runtime never sends or executes the request. Live authority is rechecked at
  every provider request, question, inspection, turn boundary and candidate
  delivery; narrowing (or any policy-generation change once file evidence
  exists) invalidates the operation, revokes evidence and disposes the child
  while preserving the draft. Local policy commands invalidate immediately,
  later grants never widen a running operation, late tool/provider/session
  completions cannot deliver, and sessions/subscriptions/timers/question
  signals are released on every exit. Tests cover budgets, no-progress and
  repeated questions, provider errors, untrusted/no-relevant-code operations,
  scope-changing answers, revocation during questions or provider work, and
  late completions.
- Prompt-refinement result review and apply policy
  (`prompt-refinement-review.ts`): the accepted candidate is re-validated at
  the hand-back boundary and checked for composer readiness — non-empty, within
  the hard size cap (over-cap is refused, never truncated), no explicit
  truncation marker, no first-person implementation/verification claim and no
  chat preamble posing as the prompt. Transport wrappers are stripped only when
  they unambiguously wrap the whole text (`/prompt` prefix, short
  "Here is the refined prompt:" label, whole-text Markdown fence or result-JSON
  envelope, trailing sign-off), so headings, lists, quotes, inline code and
  fences with a real language remain byte-identical. Original draft, candidate
  and a short change summary live in a bounded in-memory review store outside
  the parent conversation; View/Copy expose both texts plus advisory
  literal/constraint findings (human-review hints, not a semantic guarantee).
  Ordinary success inserts once without a second approval; a draft changed
  during refinement is never overwritten — the candidate stays recoverable and
  only an explicit replacement writes it, re-reading the exact confirmed
  revision first. Tests cover size boundaries, wrong/missing/extra submission
  fields, false implementation claims and refusals, malicious prompt text,
  unapproved over-expansion, wrapper-vs-Markdown stripping, View/Copy and the
  conflict/replacement policy.
- Prompt-refinement model settings (`/prompt-model`): validated
  `workflow.promptRefinement.model` overrides with trusted project/global
  precedence, an explicit inherit sentinel, per-scope reset, capability/thinking
  clamping, actionable invalid-setting refusals, serialized atomic writes that
  preserve unrelated keys, and scoped argument completions. The main session
  model, roles, profiles and Pi default-model mirror are never modified.
- Orchestrator multi-repo workspaces: plan/row/tool declarations, per-root
  baselines and attribution, workspace-scoped row/final checks, child cwd
  binding, status/mission visibility, and additive old-snapshot compatibility.
- Policy-safe inspection primitives: the reviewer's guarded read/grep/find/ls
  construction now lives in reusable `inspection-policy.ts` + `inspection-tools.ts`.
  A live authority resolver is re-read for every target and again before async
  results are exposed (the build-time snapshot is only a ceiling); revoked
  grants, new exclude/sensitive rules or lost trust refuse the in-flight result.
  Recursive grep evaluates each enumerated file before reading it and renders
  structured per-file matches after the final recheck (never the legacy text
  parser as the boundary); find/ls filter each delegated entry. Symlink/Windows
  alias escapes, unresolvable existing paths, content/details sizes and
  temp-output/structured channels are constrained. Glass tests cover excluded
  descendants, escapes, output modes, leaks, cancellation and mid-flight
  grant/exclusion/trust changes; Review Mode behavior is unchanged.

### Changed — Orchestrator runs an in-process Build child (no window or tab)

- **One child per frozen row, inside this Pi process.** The external child chain
  (Desktop tab, Terminal window, `pi --session`, child host, IPC pipe, start-ack,
  workspace lease, 45 s wait) is gone. Each row is a second SDK `AgentSession`
  with its own model runtime, an in-memory session and a fresh Workflow
  extension instance, so it gets the Workflow-managed Build tools and every
  policy gate. Extensions installed separately do not load inside the child.
- **Automatic acceptance.** A natural settle journals the report, diffs the
  workspace (including `previous.head..HEAD`, so a committed row is
  attributable), runs the row checks, journals verification and accepts —
  then starts the next row. A failure repairs the same warm child (max 2
  rounds); exhaustion blocks the row, pauses the run and wakes the parent model.
- **Prompt cascade.** Prose typed while a child runs is forwarded to it
  (`you → child`) and does not start a parent turn; while paused, one note is
  queued for the resume. Slash commands pass through.
- **Commands.** Added `/orchestrator-pause`, `/orchestrator-resume`,
  `/orchestrator-abort` and `/orchestrator-view` (the `/orchestrator` verbs
  remain). `/orchestrator-view` toggles the pinned panel between the parent
  roadmap and the child's local TODOs; it never changes prompt routing.
- **Reload.** A restored `running` row is blocked ("the in-process Build child
  did not survive the reload") and the run pauses; retry starts a fresh child.
  Old managed-worker child sessions open as ordinary Build with a warning.
- **Removed:** tools `workflow_worker_ready`, `orchestrator_report`,
  `orchestrator_checkpoint`, `orchestrator_verify`, `orchestrator_accept`,
  `orchestrator_repair`; the `workflow-bridge` command; the managed-worker
  mode ring and its tool set; the Desktop related-session request for
  Orchestrator. Parent tools are now `orchestrator_start|status|retry`.
- **Host contract:** `session-host.ts` and the generic `related-session`
  contribution kind remain for other features; Workflow's Orchestrator use of
  them is gone.


### Added — continuous Build execution and nonfatal shell quarantine

- **Build continues through routine stops.** `agent_before_settle` adds one
  bounded recovery/continuation message while an approved execution is active.
  It continues through ordinary test failures and shell quarantine, and pauses
  after three barren boundaries, a user pause/stop, or an explicit blocker.
- **The two-attempt shell cap quarantines shell, not the run.** After the
  second qualifying failure the run stays alive: shell tools are refused while
  `read`/`grep`/`find`/`ls`/`edit`/`write`/LSP remain available. A required
  shell check leaves its row **blocked/unverified**, never green. Quarantine
  survives compaction, reload, tree/fork and child replacement; only a genuine
  user prompt or `/shell-guard reset` starts a new shell budget.
- **Execution controls and evidence.** `/build status|pause|resume|stop` and
  `workflow_execution` provide status, checkpoints, row verification and
  structured blockers. Completion claims (`done`, `toggle`, bulk update and
  `[DONE]`) require fresh runtime evidence when a row has checks; editing source
  invalidates it. The final plan check runs before the last acceptance, and a
  failing or unavailable final gate cannot emit a green card.
- **Paused recovery.** Reload/reopen/fork restores the execution paused. One
  explicit `/build resume` continues the remaining non-shell work; persisted
  history alone starts no provider request, edit or child.
- **Lossless checks and child binding.** Verification commands preserve exact
  quoting/whitespace/separators; overflow is rejected with a source diagnostic.
  Child tasks inherit the parent shell limits/quarantine, and candidates are
  delivered only after the child fence settles.
- **Footer/status:** `workflow-execution` reports paused, blocked, recovering,
  shell-quarantined and complete lifecycle state.

### Fixed — child launch, retry recovery and automatic execution start (2026-11-22)

- **A prepared child is actually launched.** `createChildDispatcher.wake()`
  now calls `host.launch(spec)` and awaits the child's sealed `start-ack`
  (45 s). It no longer returns success from a map lookup, so
  "Dispatched … waiting for the report" cannot describe a metadata-only
  session.
- **Launch evidence is durable.** A successful launch journals
  `task.launched` (session ref/file and handle when available). A launch
  refusal applies `task.block` with the real launcher reason; a
  delivered-but-unacknowledged start remains `running` and is reported as
  uncertain instead of being relaunched.
- **Retry recovers stale runs.** `orchestrator_retry` accepts an optional
  `taskId`, unblocks `blocked`/`needs_fix` rows, and abandons a `running` row
  only when a probe proves it never launched (no `task.launched`, no assistant
  turn, no start marker). It dispatches immediately; `/orchestrator retry` uses
  the same path.
- **Orchestrator handoffs consume again.** `handoffRouteFor` and
  `consumeHandoffRoute` agree on `orchestrator-start`; legacy
  `orchestrator-prepare` receipts still parse. Choosing Orchestrator once again
  writes `workflow-handoff-route` and consumes the decision.
- **The chosen execution starts without another prompt.** A Direct Build
  kickoff queued while the chooser is inside `agent_end` is released at
  `agent_settled` (idle), and an Orchestrator start reports its dispatch
  outcome immediately.
- **Windows launcher no longer executes the npm shell shim.** `resolvePiCli`
  prefers the Pi Node entrypoint (`process.execPath <cli.js>`) or `pi.cmd`
  via `cmd /c`; the extensionless `…\npm\pi` shim previously failed with
  `0x800700c1` (ERROR_BAD_EXE_FORMAT).
- **Reload restores, never re-dispatches.** `session_start` rebinds the run
  from its journal when the frozen list is present; a `running` row waits for
  the explicit retry/probe path.

### Changed — Orchestrator simplification: frozen plan TODOs and direct delegation (2026-11-22)

**Breaking.** The Orchestrator no longer has a second planning/approval layer.

- **Frozen TODO authority.** A new pure `todo-snapshot.ts` converts a plan (or an
  explicitly agreed standalone list) into stable rows ONCE: one row per
  top-level plan step, stable ids/refs, heading and 1-based source line, optional
  `Acceptance:`/`Checks:`/`Files:` metadata, and plan-level `## Verification`
  commands. Build and Orchestrator share it; only status changes afterwards.
  The session `TodoStore` enforces the freeze (structural mutations refused as a
  `{refused}` result rather than thrown) and persists it per branch.
- **No execution breakdown approval.** `orchestrator_prepare`,
  `orchestrator_propose_tasks`, `orchestrator_dispatch`, the execution preview,
  the approval dialog/flow, budgets, rollover, drift, verifier, parity,
  lifecycle/stages, the roadmap/final/commit runtimes, the event pump, the
  packet/context/plan/source modules and `orchestrator-worker-todos` were
  deleted. The model-facing tools are now `orchestrator_start|status|verify|
  repair|accept|retry`.
- **Start freezes and dispatches.** `orchestrator_start` (plan path or explicit
  steps) freezes the list and dispatches row 1; acceptance of row N dispatches
  row N+1; all rows accepted plus a passing plan check completes the run. A
  dispatch failure leaves a retryable ready/blocked row, never a lost approval.
- **Neutral destination.** `workflow.handoff.executionMode`,
  `DEFAULT_EXECUTION_DESTINATION`, the recommendation fields,
  `recommendHandoffDestination`, `/handoff execution` and `/handoff once` are
  removed. Every approved plan asks Build/Orchestrator again; feedback stays in
  Plan. Handoff decisions are codec version 3; version 2 is still read (its
  recommendation fields are ignored) and approved records still require their
  explicit `destination`.
- **The child is a Build session.** Managed children switch to Build on session
  start (mode/tools/model), create their own task-local TODO list, and edit
  immediately: the readiness/fence edit interlock and the 45 s start wait are
  gone. Report/checkpoint and parent-only tool refusal remain.
- **Verification is row-scoped.** The parent captures the pre-work baseline,
  runs the row checks, accepts with runtime-owned evidence, and runs the plan's
  verification commands once after the last row. Repair is hard-capped at two
  rounds.
- **Status/footer.** The Orchestrator footer no longer renders approval or
  recommendation prose; host contributions report phase/next/blocked only.

### Changed — the composer mode label is the cycle control (2026-11-22)

- **One cycle, two entry points.** `Tab`, `Ctrl+Alt+P` and the registered
  `/workflow-cycle` command now call one serialized operation; the next mode is
  computed inside it from the live mode, and the overlay/Review checks are
  re-evaluated when the queued request runs. The ordinary ring is
  Default → Plan → Orchestrator → Build (a managed worker omits Orchestrator;
  quarantined workers use the worker ring instead of getting stuck on a refused
  target). A transition queued before a rebind/shutdown is abandoned instead of
  publishing into the replacement session.
- **The generic mode contribution references its action.** `ModeContribution`
  gained an optional `actionRef` naming a same-owner, top-level action. The
  publisher emits one `mode-cycle` action for all four base modes (Default
  included) and no longer sends the fixed-target `mode-plan` /
  `mode-orchestrator` / `mode-build` buttons, so a host can make the mode label
  itself the control. The retired ids are withdrawn explicitly; a Review turn
  publishes the cycle action disabled with its reason. Task, progress, review,
  handoff and recovery contributions are unchanged.
- **Publication failures are visible.** `set()` results are inspected and a
  rejected set keeps the last valid state and reports one bounded, deduplicated
  diagnostic (never the payload).

### Fixed — SDK SessionManager loader and host readiness (2026-11-22)

**The Orchestrator can now create the durable Builder session on a host whose
SDK exports `SessionManager` as a class.**

- **The loader validates the contract, not the JavaScript type.** A class is a
  function, not an object. `loadPiSdkModule()` accepts a class/function or an
  object whose static `create` and `open` are functions, including a
  `default.SessionManager` ESM/CJS interop shape. Invalid exports and import
  failures name the package and report a bounded export shape.
- **Terminal readiness includes the SDK.** `createTerminalChildHost` probes the
  SDK worker storage in `capabilities()` and again before `prepare()`. A
  terminal that exists but cannot load the SDK is advertised unavailable, so the
  approval preview blocks before the user spends an approval.
- **`/orchestrator start` resumes an approved run.** It restores the bound
  plan's deterministic journal first, then uses the same one-dispatch auto-start
  path as approval. A repeated start is still refused by the approval, phase and
  mutation guards; passive reload never auto-dispatches.
- **Non-creating probe.** `createSdkWorkerPort.probe()` loads and validates the
  SDK without creating a session file or metadata.

### Fixed — breakdown approval dialog and Builder bootstrap (2026-11-22)

**The Orchestrator no longer asks the user to copy an approval command, and a
valid approval can actually launch the Builder child.**

- **Approval is a dialog.** After `orchestrator_propose_tasks` validates an
  unblocked breakdown, the host opens the execution-approval questionnaire.
  The fixed rows are *Approve execution — start the next ready task* and
  *Deny — stay in Orchestrator*; the freeform row means “revise”. Esc/cancel
  dismisses without approving or invalidating.
- **Approve starts work.** Approval is journaled first, then the next
  dependency-ready task is dispatched through the existing durable dispatch
  path. A failed dispatch keeps the approval and reports the real blocker.
- **Deny is durable.** The preview is invalidated through the runtime refine
  path; typed feedback asks for a revised breakdown. The session stays in
  Orchestrator mode.
- **Headless fallback unchanged.** A host without UI still gets
  `/orchestrator approve preview-<digest>`; the command now also starts the next
  ready task after approval.
- **Builder model bootstrap fixed.** `builderModelPlan()` no longer drops the
  provider. `resolveBudget()` keeps a missing provider absent instead of writing
  `""`, so a fallback is not defeated by a non-nullish empty string. Preview and
  launch now share one resolver: effective Builder role/profile first, current
  session model fallback, fail closed when neither has a provider/id.
- **Truthful preview.** The preview shows the exact Builder model that will
  launch, including a profile override and a conservative limit estimate when
  the role model is not the live session model.
- **Model-facing text.** The mission, preparation result and tool description
  no longer instruct the model to print an approval command in a UI session.

### Changed — plan approval and execution selection are separate decisions (2026-11-22)

**Fixes the reported ordering bug.** After Review completed, the configured
presenter was not given the plan first: the browser path asked a native
destination question *before* opening Plannotator (and could look like a native
fallback), while the native sheet combined "approve" with a destination. Both
now follow the required order everywhere.

- **Presenter first.** `confirmBrowserHandoffDestination()` — the pre-review
  picker that wrote a global `executionMode` — is gone. The configured
  presenter (Plannotator or native) is asked about the PLAN only:
  *Approve plan (choose execution next)* / *Give feedback* / *Skip*.
- **Separate execution chooser.** A plan approval records the approval and then
  opens one chooser: *Orchestrator — prepare an execution breakdown* /
  *Direct Build — execute in this session now* / *Decide later*. No approval,
  saved default or one-off recommendation can execute by itself.
- **Per-plan, not persisted.** The chooser's answer applies to that approved
  plan. `workflow.handoff.executionMode` remains the saved RECOMMENDATION
  (edited only by `/handoff execution …`) and is no longer written as a side
  effect.
- **Cancel keeps the approval.** Cancelling/escaping the chooser, or a reload
  mid-choice, leaves the plan approved and the session in Plan with nothing
  started. `/handoff continue <decision-id>` reopens it; a changed plan,
  branch or session invalidates it instead.
- **New command stages.** `/handoff approve <id>` is stage 1 only;
  `/handoff continue <id>` reopens stage 2; `/handoff execute <id>
  orchestrator|build` is the explicit headless/CLI stage 2; `/handoff once`
  now changes only the recommendation and never executes.
- **`handoff-routing.ts` v2.** The record now models
  `pending → approved → routing → consumed` (plus `route-failed`,
  `superseded`, `dismissed`), with separate approval, selection and route
  receipts. v1 records migrate conservatively: the old captured destination
  becomes a recommendation, and a consumed v1 record stays terminal.
- **One owner for effects.** Browser events, native answers, reload recovery and
  commands all approve/route through the same coordinator. Approval is journaled
  before any effect; routing intent is persisted before Build/Orchestrator work;
  a duplicate event cannot open a second chooser, and an uncertain delivery is
  never retried automatically.
- **Fallback keeps the decision.** Plannotator timeout/error, a closed review and
  `/handoff fallback` now retire only the browser transport correlation — the
  claim/identity/recommendation survive into the native sheet (previously the
  decision was cleared and then "reused").
- **Late events are refused.** One claim per review id, plus a state guard in
  the deny handler, prevent an approve-then-deny pair or a stale tab from
  revising or executing an already-approved plan.
- **Status.** The footer/contribution detail distinguishes a pending plan review
  from `execution choice pending`, labels the destination as a *recommendation*,
  and offers a `Choose execution` action for an approved wait.
- Tests: `handoff-routing.test.ts` (v2 + migration), new
  `handoff-execution-view.test.ts`, and `extension.test.ts` now cover the
  ordering, cancellation/resume, changed-plan refusal, duplicate channels, the
  presenter×recommendation matrix, and the headless two-command flow.

The Orchestrator preview approval is unchanged and still separate: choosing
Orchestrator authorizes preparation only.

### Added — Orchestrator mission and manual work entry (2026-11-22, third pass)

- **Distinct Orchestrator identity.** `permissions.ts`/`policy-runtime.ts` now
  resolve an `orchestrator` role (inspect + verify, no project writes). Refusals
  name the delegation remedy instead of calling the session Plan or telling the
  user to switch to `/build`. The role still cannot widen inherited authority.
- **Authoritative mission injection.** `orchestrator-mission.ts` is the single
  mission text: identity (not Plan/Builder), the work-entry tool, the breakdown
  approval, delegation, evidence-backed acceptance, host readiness and the
  current phase/next action. It replaces nothing else and never accumulates.
- **Plan-or-discussion work source.** `orchestrator-source.ts` captures the
  current discussion (objective, constraints, bullet/numbered requirements,
  deterministic snapshot bytes + digest) or an explicit plan path. Explicit
  discussion beats a stale `currentPlanFile`; ambiguity asks instead of guessing.
- **Manual preparation entrypoint.** `orchestrator_prepare` is available before
  a run is bound, and `/orchestrator start [path]` routes into the same service.
  Bare `/orchestrator` still only selects the mode and launches nothing.
- **Human-bound execution preview.** `orchestrator-preview-view.ts` renders the
  derived scope, grouping, models, checks, host, dirty baseline, commit behavior
  and limits. `/orchestrator preview` shows it; approval requires the exact
  `preview-<digest>` id, so the old literal confirmation cannot approve and a
  changed preview cannot be approved by a stale command.
- **Durable refine.** `/orchestrator refine <what>` journals the invalidation,
  clears plan/preview/approval, returns the run to awaiting approval and survives
  reload; a restored journal can no longer resurrect a superseded approval.
- **Content-addressed evidence.** Workspace capture now records a SHA-256 for
  every non-deleted changed path. Same-length edits to already-dirty, untracked
  and non-Git files change the revision; staged + unstaged observations are no
  longer collapsed; unreadable/oversized content is incomplete coverage and
  blocks acceptance instead of reading as unchanged. Verification recomputes the
  revision after checks and refuses evidence when it moved.
- **Durable fencing reservation.** `nextGeneration` reserves a workspace-wide
  token on disk and `acquire` consumes it once; a restarted parent or a second
  task cannot reuse a token, and replaying a consumed token is stale.
- **Model input narrowed.** `orchestrator_propose_tasks` no longer exposes a
  model-supplied requirement list (coverage uses the runtime's immutable roadmap)
  and `orchestrator_dispatch` no longer exposes `sessionRef` (the runtime owns the
  prepared identity).
- **Packaging/docs:** the three new modules and their tests are in the package
  files and test command; README/CHANGELOG describe both work-entry paths.
- **Still NOT RUN:** real provider turns, visible Terminal/Desktop launches,
  packaged Desktop E2E and macOS/Linux signoff. These remain explicit manual
  acceptance items, not claims of passing.

### Added — Live child composition (2026-11-22, second pass)

- **Real child host composition.** `orchestrator-child-host.ts` builds a
  dispatcher over a Terminal launcher or a source-bound Desktop tab. Prepare
  creates the durable child and its metadata, writes a private grant, and only
  then does the visible launch happen. A launcher success is not readiness.
- **Authenticated run control.** `orchestrator-run-control.ts` connects the
  existing envelope/HMAC decisions to real named-pipe/unix-socket transports:
  `ready → one sealed start → start-ack`, plus post-start `say`/control pushes.
  Forged, stale, reordered and duplicate frames are refused; a delivered but
  unacknowledged start is `uncertain`, never a clean failure.
- **Two-step mutation authority.** The child holds the verified grant until
  `workflow_worker_ready` acknowledges the assignment; only that call applies
  the grant and records the start ack. Delivery never opens the workspace.
- **SDK persistence fix.** A lazy session file is materialized with a supported
  user conversation entry (the real SDK does not persist setup entries alone),
  verified against the installed SDK rather than only the fake.
- **Workspace-wide fencing.** `acquire` now takes a durable per-workspace
  generation, so a second task or a later run cannot reuse generation 1; the
  high-water mark survives release and restart.
- **Runtime-owned verification and acceptance.** `orchestrator_verify` captures
  the baseline and candidate, runs the task checks through `ctx.executeTool`,
  and applies acceptance atomically. `orchestrator_accept` no longer accepts a
  model-supplied evidence object at all.
- **Live runtimes wired:** usage is recorded from real assistant usage and
  journaled idempotently; the parent TODO list is the accepted-coverage
  projection (mutations refused); `/orchestrator finalize` runs the fail-closed
  final gate and journals a scoped revision proposal when it fails;
  `/orchestrator say` is delivered to the live child.
- **UI/diagnostics:** the contribution contract now carries run phase/approval,
  blocked reasons, host readiness and an explicit "Use direct Build" action when
  no child host is reachable. A session rebind clears every control/host
  reference so stale callbacks are inert.
- **Still NOT RUN:** real provider turns, real Windows/macOS/Linux terminal
  launches, packaged Desktop E2E and cross-platform signoff.

### Added — Orchestrator integration (2026-11-22)

- **Parent runtime is wired:** an approved Orchestrator handoff now snapshots the
  exact roadmap bytes into a durable run journal and starts exactly one bounded
  preparation turn. Breakdown approval is still a separate, digest-bound decision.
- **Parent tools are registered** (`orchestrator_propose_tasks|dispatch|status|
  verify|repair|accept`). Dispatch journals assign → start intent → one wake →
  ack, and reports uncertain/lost starts instead of retrying blindly. They refuse
  outside Orchestrator mode, on a managed worker, or without a bound run.
- **Durable wake pump:** child events wake the parent at most once per settle
  boundary; heartbeats/progress never do; `agent_end` is not a boundary; delivered
  wakes are journaled so a reload cannot repeat them.
- **Evidence-backed verification:** baseline→candidate capture, gated checks,
  acceptance bound to the current workspace revision, no second acceptance, and a
  bounded scoped repair on failure.
- **Usage/rollover:** usage is durable and idempotent, unknown cost pauses under a
  configured cap, and rollover preserves repair/no-progress/rollover counters.
- **Operator commands:** `/orchestrator status|start|pause|resume|stop|inspect|
  say|retry|approve|cancel`; bare `/orchestrator` remains mode entry.
- **TODO ownership:** the parent roadmap projection derives from acceptance only;
  checkboxes, child TODOs and child reports cannot move it.
- **Commits and final gate:** an accepted task is committed at most once by the
  parent; a required final check that was skipped/cancelled/timed-out is **not** a
  pass (fail-closed), and a failed final gate records a revision proposal without
  reopening accepted work.
- **Quarantine:** present-but-unreadable managed metadata now quarantines the
  session (inspection only) instead of restoring it as an ordinary writable one.
- **Footer:** a `workflow-orchestrator` segment shows the saved destination before
  consent and the run phase/approval/next/blocked state after it; native
  mode-action order is Plan → Orchestrator → Build.
- **Still NOT RUN:** real provider/model turns, real terminal launches, packaged
  Desktop E2E and macOS/Linux signoff. This build binds no child host, so dispatch
  and execution approval fail closed with an actionable reason.

### Added — Orchestrator (experimental)

An opt-in engine for long, phased roadmaps. It is **not** a release of the
live orchestration loop: the durable contracts, reducers and host seam are
implemented and tested, while real provider/turn wiring, cross-platform
terminal launches and Desktop E2E remain manual/next-step work.

- New `/orchestrator` mode and Orchestrator role with planner fallback; mode
  entry never launches work and the ordinary Plan → Review → Build flow is
  unchanged.
- Durable run journal with checksummed append, single writer, idempotent event
  ids, torn-write recovery and intent/ack reconciliation; roadmap ingestion
  keeps every requirement and treats `- [x]` as a claim, not proof.
- Task-only execution TODOs, coverage-validated decomposition, context and
  capability budgets, execution preview/approval and bounded assignment packets.
- Normal visible Build children: durable metadata before launch, readiness and
  lease-gated wake, cross-platform terminal adapters, Desktop related-session
  hosting, Build environment parity and worker-local TODOs.
- Evidence-backed parent acceptance (real diff, real check output, workspace and
  roadmap revision fences), scoped repair with persisted budgets, context
  rollover with a safe-boundary checkpoint, and a final integration gate driven
  only by accepted task coverage.
- Parent-only commits with a durable evidence-keyed ledger; managed children
  suppress TODO/`[DONE]`/checkbox/report auto-commits and may not push.
- Run controls (pause/resume/stop with quiesce-before-lease-release), restart/
  branch reconciliation, drift detection that never widens policy automatically,
  bounded parent context/compaction pointers, usage/caps/retention, an optional
  independent verifier and a future stage interface.
- Generic host contribution and related-session contract; Pi Desktop renders two
  unrelated fixture extensions with arbitrary mode names and source-bound
  related-session ownership, with no Workflow parsing.
- Automated coverage: generated transition invariants, provider-free fake-agent
  process crashes, real on-disk journal recovery, workspace/lease/baseline
  edges, generic Desktop contract fixtures, full extension test suites.
- Live acceptance is **NOT RUN**: see `docs/orchestrator-live-acceptance.md` for
  the manual checklist (real models, Windows Terminal, macOS Terminal and
  Linux/tmux signoff).

### Fixed — shell probes can no longer hang a request indefinitely

The 2026-11-20 `erp-atom` incident recorded two valid but empty
`python - <<'EOF'` probes with no `timeout` waiting 52m27s and 21m56s. Pi's
Bash tool has no default deadline, and Workflow supplied none.

- Every model shell call now gets a finite native deadline: 120 s when
  `timeout` is omitted, capped at 900 s by default (hard cap 3600 s). The new
  `workflow.shellGuard` setting is user-owned, sparse, global/project scoped,
  inherited by explorer children as an upper bound, and cannot be disabled by a
  model. `/shell-guard [status|limits …|reset]` manages it.
- Provably empty direct interpreter-stdin heredocs are refused before launch
  (Python family), with an “empty interpreter probe” explanation. Non-empty
  scripts, `-c`/`-m`, script files, quoted `<<`, `<<-` and ambiguous heredocs
  keep the finite deadline instead of being rejected.
- One changed approach is allowed after a qualifying failure; repeating the
  same command or a second qualifying failure in the same request latches a
  stop, blocks further shell calls and aborts the run. Timeouts never replay a
  command and never roll back effects; partial output is preserved.
- The isolated reviewer's `review_bash` has its own per-round budget and a
  guard trip is not retried as a provider failure. `/shell-guard reset` clears
  a stopped request while idle; a genuinely new idle prompt resets it too.

## [0.13.0] - 2026-11-19

### Changed — sticky todo panel display and Pi Desktop controls

- The panel choice is now scoped to the plan lineage, not the list identity:
  Build `add`/`update` and a same-path Review rewrite keep the expanded,
  collapsed or hidden choice. A different plan, `/todos clear`, reload and
  rewind reset it to automatic, as before.
- A visible row/status change re-registers the widget so Pi Desktop repaints
  immediately (the host only repaints on `setWidget`).
- New `workflow-todos` status: `☐ Todos 3/12 · hidden` (plus stale/cancelled
  markers) while the panel is hidden or Review owns the turn.
- Pi Desktop: the native Todo bar and menu expose the four verbs, the desktop
  toggle is `Ctrl+Alt+L` (Sessions keeps `Ctrl+Alt+O`), and `Ctrl+Alt+O` is
  registered only on terminal hosts.

### Changed — the live Review line is shared and hint-complete

- One formatter (`reviewLine`) now feeds the `workflow-review` status, the
  terminal `workflow-review-status` widget and the host working message. The
  running form carries `ESC or /review-pause to pause · /review-abort to stop`;
  the paused form carries both `/review-resume` and `/review-abort`; the handoff
  form adds `/review-abort to skip`; a transition form covers the decision
  window. Hints come before the phase detail so a narrow terminal keeps them.
- **Pi Desktop** consumes the same `workflow-review` status for its single
  review row (below the todo panel, above the composer). Pi Terminal keeps the
  widget below the todo widget; a todo-panel re-registration now forces the
  review widget to be re-added after it, so the order stays stable.
- Every review round's working row now carries the hints — including an
  automatic review inside the plan turn, which previously showed a hint-less
  spinner line in Terminal.
- Compatibility: an older Pi Desktop still sees the mode status and degrades to
  its existing row; the matching Pi Desktop release reads `workflow-review` and
  falls back to its own canonical line when the status is absent.

### Fixed — a plain plan handoff is no longer Review Mode

With Review Mode off, finishing Plan painted `🔍 review — awaiting decision`,
locks `/plan`, `/build`, `Tab`/`Ctrl+Alt+P` and even `/review-mode off`, and could
strand the turn when the in-app Plannotator tab rendered blank.

- A plan handoff now has an explicit **owner**. Only an actual reviewer round
  (automatic or manual `/review`) enters the exclusive Review turn. A plain
  handoff is a Plan/Build sub-state (`⏸ plan — handoff pending`) and leaves
  modes and prompts free; a mode switch or a new prompt supersedes it, and a
  late browser approve/deny is ignored.
- The plan is **always printed into the transcript** before the browser request
  (deduped per revision), so a blank/unusable host web tab is never the only
  copy of the plan.
- **`/handoff fallback`** converts the pending browser decision to the native
  questionnaire without changing `workflow.handoff`. It is allowed through the
  Review input gate. A repeat call is idempotent.
- **`/review-mode off`** is allowed once the reviewer has finished (no running
  round, pause or gated audit). A pending handoff is downgraded to plain and
  keeps its browser correlation; an open native prompt or a live round is
  refused with the correct exit. This also makes `off` override a project
  `enabled: true` when that scope would otherwise defeat it.
- The footer, `/review-status` and reload recovery distinguish the plain
  handoff from a review-owned one; older session entries default to plain so
  the false Review lock cannot return.

### Fixed — stale manual cycle after restart

A persisted `manualReviewCycle` survived `startup`/`new` recovery and made the
next Plan submission run a manual-trigger reviewer while `workflow.reviewMode.enabled`
was false. It is now cleared when no pending handoff survives; a genuine manual
handoff still keeps its cycle.

### Fixed — Review Mode settings writes no longer shadow each other

`writeReviewModeConfig` wrote the complete coerced config, so `/review-mode
timeout` pinned `enabled` (and every default) into that scope. Writes now touch
only the patched fields. `/review-mode on|off` makes the requested value
effective across scopes when the other scope would defeat it and reports both
paths; `status` names a shadowed explicit `enabled`.

## [0.12.1] - 2026-11-16

### Changed — folder exclusions are now two tiers (breaking)

- A **specific** `folderPolicy.excludePaths` rule (`C:/Personal`,
  `C:/Users/Me/Private`, `**/node_modules`) is a **hard deny** for the folder and
  every descendant, in every mode. It opens no dialog and cannot be granted:
  `readPolicy`/`writePolicy`/`commitPolicy.allowedPaths`, an "Always allow"
  answer, a reviewer/subagent's locked roots and the session folder itself no
  longer re-open it. Revoke with `/folder-policy exclude revoke <path>`.
- A **broad root** (`C:/`, `/`, `~`, `//server/share`, optionally with `/**`) is
  a **grant ceiling**: only that root is blocked; descendants follow `mode`.
  `["C:/", "C:/Personal"]` therefore leaves `C:/Users/.../project` reachable in
  `mode: "any"` while `C:/Personal` stays fully blocked.
- A session opened inside a deny rule now refuses read, write and commit, warns
  once at `session_start`, and refuses plan-mode `.pi/plans` writes. The warning
  names the rule and the revoke command.
- `/folder-policy status` and `exclude list` label every rule
  `[ceiling: …]` or `[deny: …]`; grants stored inside a deny rule are reported as
  ignored. The broad-root add note now explains that only the root is blocked
  and that a specific folder is needed to deny a subtree.
- Redaction and the Review Mode guard share the same two tiers: output under a
  deny rule is always withheld; output under a broad root is not.
- Migration: a stored `["C:/", "C:/Users/Lenovo"]` no longer denies content
  under home (home is a ceiling). Add explicit deny rules such as
  `C:/Users/Lenovo/Private`.

### Fixed

- `folderPolicy.mode: "any"` no longer turns a broad exclusion into an
  allowlist: a `C:/` rule used to classify every C: path as outside and prompt
  for it. Broad roots now block only their own root.

## [0.12.0] - 2026-11-15

### Added — `workflow.handoff` + `/handoff`

The plan handoff presenter is now an explicit setting instead of a side effect
of package detection.

- `workflow.handoff`: `"auto"` (default — Plannotator when a host is detected,
  native otherwise), `"native"` (never open the browser: no request, no wait, no
  "unavailable" warning), or `"plannotator"` (always attempt, even undetected;
  native fallback on timeout/error). The object form `{ mode, timeoutMs }` sets
  the per-attempt timeout (default 15 s, clamped 1–300 s).
- `/handoff [auto|native|plannotator] [global|project]` reports the effective
  mode, the detection evidence (`settings.packages`, bus listener, live session
  or none) and the real target, and writes the key read-modify-write. It refuses
  to switch while a handoff decision is pending (approve/deny in the tab or
  `/review-abort` first).
- Argument completions for the mode and the write scope.

### Fixed — manual `/review` shows the live “Reviewing” line in Pi Terminal

A manual `/review` runs as an extension command on an idle session. Pi Desktop
renders an extension working message as its working row above the todo list even
while the tab is idle (`SessionView.tsx` `extensionBusy`), so the line was
already correct there. Pi Terminal only creates its working row during a run, so
`setWorkingMessage("🔍 Reviewing plan…")` was invisible for the whole manual
round.

- The extension now also paints a plain-text `workflow-review-status` widget
  above the editor while a round or pause owns the turn. It is **Terminal-only**
  (`process.stdout.isTTY` and no `PI_DESKTOP_HOST_ENTRY`) and **idle-only**
  (`ctx.isIdle()`), so Pi Desktop keeps its single working row and a Terminal
  automatic review keeps its existing spinner — no duplicate lines.
- Text: `🔍 Reviewing plan…` in the cold-boot window,
  `🔍 Reviewing plan… · pass 1/2 · 3 findings · ● verifying` once state lands,
  and `⏸ Review paused — /review-resume to continue, /review-abort to stop`
  while paused (one constant shared with the working message).
- Live-only: cleared on round end, pause exit, abort, teardown, shutdown and
  reload; a retained terminal phase never repaints its verdict.
- The last applied text is cached so routine `updateStatus` calls do not
  re-register the widget.

### Fixed — truthful Plannotator detection

`ensurePlannotatorListeners()` marked Plannotator active unconditionally, so
removing the package still emitted `plannotator:request` and stalled every
handoff for the full 15 s timeout before the native fallback.

- Detection is a real host check: package in `settings.packages`, a **foreign**
  `plannotator:request` listener (our own handler is subtracted), or a live
  `session-opened`. Refreshed on `session_start` and before every prompt.
- `auto` with no host renders the native questionnaire immediately, with no
  `Plannotator handoff unavailable` warning and no failure entry.
- Reload recovery in `native` mode never queries Plannotator; a gate left over
  from a previous mode is cleared and the review turn is released.
- Stale `plan-approved` / `review-result` events from a leftover browser tab are
  ignored when the effective mode does not use Plannotator.
- The headless fallback text no longer prints the SSH-forwarding hint in `native`
  mode.

### Fixed — `/review-abort` is a real local exit

A Plannotator failure could soft-lock Review: `/review-abort` re-opened the
browser handoff, `requestPlanReview` cleared the pending decision but left
`reviewTurn = "handoff"`, and the next abort answered *“No review running or
paused.”* while the mode/prompt locks stayed on.

- Abort is now a **strict local exit**: it stops the reviewer, resolves any
  in-flight browser request, settles the gate with the author's plan, clears the
  pause/decision, closes the review turn and presents the native handoff. It
  never re-opens Plannotator.
- Abort is **idempotent**. A residual turn, gate, pause or pending decision is
  always cleaned; only a fully idle state answers
  `Nothing to abort — no review, pause, or handoff is active.`
- A round still in flight keeps the single-presentation rule: the waiting
  `/review` / `runHandoff` caller presents once, never twice.

### Changed — the handoff is a printed plan plus a bottom-sheet questionnaire

The plan no longer lives inside the handoff pane (it pinned the modal and hid
the choices behind a collapse key).

- The plan is appended to the transcript as a display-only `workflow-handoff-plan`
  entry (`pi.appendEntry` + renderer, never LLM context), bounded at 40K chars
  with a trailer naming the full file.
- The choices are the existing questionnaire view, bottom-pinned: **Approve plan
  and go ahead (Build)**, **Give feedback (stay in Plan)**, **Skip for now (stay
  in Plan)**, plus the built-in freeform row (typed text is feedback).
- Every handoff path uses one presenter: automatic handoff, `/review`,
  `/review-resume`, a closed browser tab and abort. Plannotator is tried first
  except on abort; a Plannotator error/timeout/missing bridge now falls back to
  the questionnaire instead of a warning-and-return.
- **No execute turn without a verified Build**: `enterBuildModeFromPlan()` must
  return `true` *and* the session must be in Build before the execute follow-up
  is sent; `sendExecuteMessages()` refuses otherwise
  (`workflow-handoff-blocked-build`). This fixes the reported “starts building
  but stays in Plan mode” failure.

### Changed — the review turn is the lock's single source of truth

`reviewModeLockKind()` now takes the turn phase, so a leftover `running` /
`handoff` / `paused` / `transition` turn locks modes exactly like the round and
pause predicates. Every failure/teardown exit closes the turn through one
`closeReviewTurn()` finalizer, the headless fallback and closed-tab paths no
longer leak it, and `/review-status` reports `turn`, `gate` and a `residual`
hint. `/review-pause` / `/review-resume` name a waiting handoff instead of
claiming nothing is running.

## [0.11.1] - 2026-11-15

### Features

- harden the folder floor, exclusions and Git-Bash paths (17ebfca)

### Other changes

- add folderPolicy.excludePaths as scope subtraction (14aee11)

## [0.11.0] - 2026-11-14

### Added — Review is an exclusive turn with an explicit state machine

Review used to be a derived lock over a running child, so the browser/inline
handoff phase (which has no child session) could accept prompts and mode
switches, the reviewer's streaming tail could leak into Build/Plan, and closing
the review tab could strand the plan with no handoff.

- One explicit `ReviewTurnPhase` now tracks the turn: `idle` → `running` →
  `paused` → `running` → `handoff` → `transition` → `idle`, with `handoff` and
  `transition` as first-class locked states. While Review owns the turn, a
  prompt is accepted only if it is a `/review…` control, `/model`, `/thinking`,
  `/profile` or `/role`; everything else is refused with a notice. Mode
  switches are refused from user paths for the whole turn, with the validated
  decision exit (`fromReview`) allowed only when no round is in flight.
- **Approve is atomic**: stop the reviewer → enter Build → execute messages,
  with `transition` holding the gates. A failed Build keeps the handoff visible
  instead of losing it. Deny keeps the refine cycle alive via
  `reviewFeedbackTurn`, so a manual review still re-reviews the revision with
  Review Mode off.
- A browser close (or an aborted manual round) always presents a handoff:
  inline Approve/Refine, or a no-UI fallback message. Restart-safe restore keeps
  a settled handoff across a reload; a running round is not restored.
- `review-runtime.ts` drops child events once the round ends and aborts a
  still-streaming reviewer on every terminal path, so no tail can be written
  after handoff. `workflow-status.ts` shows the review phase instead of a
  Plannotator sub-state and stays free of `n/m`, so the Desktop badge parser
  does not read review progress as plan steps.
- Tests: 10 new extension scenarios (auto/manual approve, repeated feedback,
  pause/resume/abort, reload, no-plan review, closed-review handoff), ordering
  assertions through a fake-pi timeline, plus review/workflow-status units.

### Added — one shared folder floor for read, write and commit

`folder-policy.ts` is now the single containment floor all three policies
consult: `mode: repo|cwd|parent|any`, `outside: ask|block`, and a sensitive-file
deny list that no grant can soften. `shell-paths.ts` extracts the paths a shell
command reads, writes and commits, so the floor judges concrete targets rather
than “mutating”.

The read gate is new: `read-policy.ts` (grants, `shell: paths|strict`, guarded
tools), `read-policy-tools.ts` (classifier for `read`, `ls`, `grep`, `find`,
pi-lens, `explore` and file-URL tools) and `read-policy-redact.ts` (redaction of
grep/find/ls/bash diff and truncation-escape output). `/folder-policy` and
`/read-policy` expose the configuration; project settings are honoured only
when the project is trusted.

The existing policies are hardened against the same floor: commit gains
`allowedPaths` plus sensitive/folder verdicts, write reuses the shared path
helpers, and Review Mode's own `read`/`grep`/`find`/`ls` and `review_bash` get
the reviewer guard and redaction. The status line shows `folders:`. Covered by
new test suites and `npm run check:read-policy`.

### Added — pinned todo panel with auto-collapse and explicit overrides

`todo-panel.ts` adds a pure state matrix (expanded/collapsed/hidden), list
identity key, settled detection, summary and anchored row rendering, and a
completion signature — with no extension-host dependency.

The panel collapses to one summary line (`☑ Todos N/N · all done`) the moment
every step is completed or cancelled, and hides at the next user prompt.
`Ctrl+Alt+O` toggles it. `/todos` gains
`show|expand|collapse|hide|auto|clear|help` plus argument completions; `clear`
confirms first when UI is available. The choice is persisted in the workflow
custom entry scoped to the list identity and reset at session, reload and
rewind boundaries. Adding, removing or renaming a step re-expands; status-only
changes keep the choice. The Build-complete card is emitted once per list
revision instead of on every `agent_end` turn.

### Fixed — shell-foreign paths and harder folder gates

Git-Bash/MSYS (`/c/...`), Cygwin (`/cygdrive/c/...`), WSL (`/mnt/c/...`) and
`file://` paths are translated to native syntax before policy matching, and
settings/project config paths resolve natively so an MSYS cwd names the same
`settings.json`. Case-insensitive comparison is Windows-only, so a
case-sensitive macOS volume no longer merges distinct paths.

- Outside targets group to the first outside folder; a file directly in the
  common parent is granted as that file alone.
- Read, write and commit dialogs show the base/current folder plus each
  requested target path (bounded, with “… and N more”).
- The commit gate honours `GIT_DIR`, resolves the real repo root, and asks when
  the root cannot be verified; per-step commits skip when staged paths leave the
  permitted folders or are unverifiable.
- A mutating tool with no discoverable path is treated as uncertain instead of
  silently allowed.

### Fixed — Review Mode no longer reports its own abort as a provider error

Review Mode aborts the reviewer's closing tail after `review_pass_done` (and on
pause/teardown). When that abort landed before the next provider request was
created, the SDK's `lazyStream` setup path recorded the host cancellation as a
`stopReason: "error"` assistant message (`This operation was aborted`), so a
successful round printed `reviewer run ended on a provider error: …` and stored
the abort in `/review-status` as a provider failure.

One abort-aware classifier now decides every stop: `stopReason: "aborted"`,
Node/provider abort spellings (`This operation was aborted`, `Request was
aborted`, …) and the SDK's `Retry cancelled` are aborts; timeouts
(`The operation was aborted due to timeout`) remain transient provider
failures. Self-aborts are suppressed before transcript ingest and provider-error
capture, and the round is marked inactive before the teardown abort, so
neither the pane nor `/review-status` blames the provider. A round aborted
during the send race now takes the pause/abort path instead of a failure path.
Real provider failures (429/503, `Stream ended without finish_reason`) are
unchanged, including their recovery chain.

Tests: 762 green (19 new classifier/translator/runtime cases),
`npm run typecheck` clean.

### Fixed — the folder floor no longer prompts for in-repo toolchain commands

Build mode and Default + `writePolicy: allow` no longer open a `Write policy
'ask'` dialog for commands whose writes the shell analyzer cannot fully locate
(`sed`/`awk`, `npm run build`, `npx …`, `node script`, `powershell`,
`git diff | sed`, path-less `mutatingTools`). Only a proven outside target, a
sensitive file, or an explicit path that cannot be resolved is gated;
`writePolicy: ask` remains the strict opt-in for every mutating call. A prompt
caused by the floor is now titled **Folder policy 'ask'** and shows the base
folder, an outside grant is labelled **Always allow this folder**, and
`folderPolicy.outside: "block"` refuses an unresolvable target without opening
a dialog. The commit gate attributes an outside-repository refusal to the
folder policy, and `runGitZ` honours `PI_GIT_BIN` with a clear error when git
cannot be found instead of a raw `ENOENT`.

## [0.10.0] - 2026-11-10

### Fixed — review handoffs survive later rounds and reloads

**Manual `/review` now hands off.** A settled manual round opens Plannotator with
`source: "manual"`. In Default/Build, Approve enters Build and Deny switches to
Plan before sending feedback. A manual cycle keeps reviewing/handing off after a
Deny even when automatic Review Mode is off.

**Round 2+ can no longer be suppressed by a stale gate.** A new round or manual
`/review` supersedes an older `awaitingDecision`; a browser decision arriving
while another round runs is discarded and clears the old gate; the full
correlation (review id, request id, URL, source, plan hash, cycle) is persisted
and restored instead of being nulled.

**Reload recovery.** On `reload`/`resume`/`fork`, the replacement session asks
Plannotator `review-status`: pending keeps a matching gate, completed applies the
recorded approve/deny, and missing/changed clears with a visible reason. Startup,
new sessions and quit still clear.

**Request lifecycle.** The 5 s response-only wait is replaced by a 15 s wait for
`respond` or `plannotator:session-opened`; `session-closed` without a decision
clears the gate. Desktop focuses notification review tabs and reloads an existing
same-URL tab instead of leaving stale content in front.

### Added — chunked plan rewrites for long plans

Review Mode no longer has to fit an entire plan rewrite into one response. When
`workflow.reviewMode.chunkChars > 0` (default 6000) and the plan is longer than
`chunkChars × 2`, pass 1 asks the reviewer to submit through a new three-tool
protocol:

- `review_plan_begin` — resets the per-round assembler, states the chunk limit.
- `review_plan_chunk` — appends ordered chunks (`index` 1, 2, 3, …). A rejected
  chunk (out of order, repeated, oversized, or lost to a stream cut) is answered
  with the index the assembler expects next, so the retry continues without
  restarting; accepted chunks are kept.
- `review_plan_finalize` — validates completeness and writes through the same
  `review_submit_plan` funnel, so `writePlan` remains the single writer and the
  plan file is touched exactly once.

Short plans keep the one-shot `review_submit_plan`, which remains the only write
path (and accepts an assembled plan too). `chunkedSubmit: "off"` or
`chunkChars: 0` restores single-response submission. The assembler is cleared on
abort, teardown, a new round and a provider switch, so a partial rewrite can never
be stitched onto a different attempt. Pass 2 consumes the assembled rewrite and
its diff unchanged.

### Added — safe provider migration and Command Code guidance

- `/profile retarget-provider <old> <new> [global|project] [--apply]` rewrites every
  `{ provider, id }` model reference in `profiles.json` and `roles.json`, preserves every
  other key, and backs up each changed file. It prints a dry run first; `--apply` writes.
  A malformed file blocks both writes. This is the supported migration from the
  hand-written `command-code` provider to the maintained `pi-commandcode-provider`
  (`commandcode`), whose per-model wire routing and reasoning normalisation avoid the
  single-wire setup that contributes to long Command Code stream cuts.
- README documents the Command Code wire model, the maintained package, and the retarget
  workflow. The troubleshooting entry now names `Stream ended without finish_reason` and
  explains why lowering thinking is not a reliable fix.

## [0.9.2] - 2026-11-08

### Fixed — Review Mode resets per plan cycle and the review line is live-only

**A second plan in the same session no longer skips review.** `reviewRound` was
a session-wide counter, while `rounds` is documented as per user-feedback cycle.
With the default `rounds: 1`, the first successful review consumed the only
round and the next plan file was handed over with `round limit (1) reached` — no
reviewer run. Recent sessions (for example the second plan in the 2026-11-06
pi-desktop session) show the exact sequence. The counter is now scoped by a
review-cycle token: a fresh prompt, an explicit inline `Refine`, browser `Deny`,
a changed plan-file path and Build entry each start a new cycle. Findings carry
across a same-plan refinement and are cleared for a new plan file.

**The review line cannot outlive its review.** `pausedReview` had no lifecycle
tie to the plan cycle: `before_agent_start` cleared handoff provenance but not a
pause or a parked gate, so an abandoned pause kept `🔍 review paused` and
`🔒 modes locked` alive indefinitely, and a stale non-idle gate made the next
`agent_end` return early — skipping the next plan's review and handoff. A fresh
prompt now abandons the pause once (stopping the round and settling the open
gate with the author's plan), and pause/gate state is tagged with the cycle that
owns it. A retained terminal `reviewState` is no longer painted during a new
round's cold boot: the footer/widget use `reviewStatusText`, which requires a
live phase (or a current-cycle pause). Old handoff continuations are generation-
guarded, so they cannot render or clear a newer cycle's state.

Tests: 533 green (525 + status-text cold-boot/terminal cases, `nextReviewRound`,
`reviewPauseIsCurrent`, `samePlanPath`, and extension-level two-cycle / inline
Refine / browser-deny / abandoned-pause regressions). `npm run typecheck` clean.

### Fixed — command policy: quoted text is a value, not a command

**The problem.** Plan Mode refused the canonical exploration queries, and the
write policy independently called a quoted `>` a file write. Both faults came
from the same place: the policy layer had four text scanners with three
different ideas about quoting.

| Command | Before | After |
| --- | --- | --- |
| `rg -n "rm -rf" src` | refused (`rm` matched the raw text) | allowed, read-only |
| `rg -n "sudo" .` / `git log --grep="rm -rf"` | refused | allowed, read-only |
| `grep -rn 'a > b' docs` | refused as a redirect; a *write* in `ask` (prompt) | allowed, read-only |
| `grep -rn 'a $(b) c' docs` | refused as substitution; a *write* in `ask` | allowed, read-only |
| `2>/dev/null ls` | refused in Plan Mode | allowed, read-only |
| `rg -n 'a' f > out` | refused | **still refused** (real redirect) |
| `rg -n "a $(id)" f` | refused | **still refused** (double quotes expand) |
| `bash -c 'rm -rf /'`, `env rm -rf /`, `xargs rm`, `find . -exec rm {} ;` | refused | **still refused** |
| `sed -n '1,20p' f` / `awk …` | refused | **still refused** (Builder-only, unchanged) |

**One scanner, one analysis.** New `shell-text.ts` is the single source of
quoting truth, and it exposes three views plus the segmentation:

- `structural` — what the shell treats as an **operator** (`| & ; < > ( )` and
a bare `&`). Quoted and backslash-escaped characters are masked, because they
are literal text.
- `expandable` — what the shell **expands**. Single quotes and escapes are
masked; double quotes are kept, because `$(…)`, `${…}` and backticks do
expand there.
- `words` — the **argv** the process receives, after quote removal, with
operators and redirects excluded (so a leading `2>/dev/null` no longer hides
the command name).
- `splitSegments` reproduces the previous splitter bit-for-bit, including its
legacy escape-inside-single-quotes quirk, because `gitCommitPolicyHit`
consumes its exact boundaries.

`analyzeCommand()` (`permissions.ts`) is now the single pipeline: the role gate
(`explainCommandRefusal`) and the write gate (`commandMayWrite`, now a 10-line
adapter) read the same result, so they can no longer disagree about the same
text. Classification still runs on `stripHarmlessRedirects(segment)`, which
keeps the `/dev/null` and `2>&1` exemptions load-bearing.

**The destructive-keyword denylist is now position-aware** (it stays, as
defence in depth). A keyword counts in **command position** (`rm -rf x`,
`npm install`, `git commit`) or **anywhere in a segment already classified
`full`** (`env rm -rf /`, `bash -c "rm -rf /"`, `xargs rm`) — the latter only
makes the refusal name the cause. A quoted pattern in a read-only command is
data, which is what makes `rg -n "rm -rf"` usable. Every binary that executes
its arguments is class `full` and `full` is refused for every restricted role;
a new executor-invariant test pins that premise, and a cross-gate test pins
`plan-allowed ⇒ not-a-write` over a corpus.

**New `/permissions [explain] <command>`.** Prints each segment's class, the
planner/reviewer/explorer verdict and whether the write policy would treat the
command as a write — from the same analysis, without running anything. This is
the answer to "why was that blocked?" before the agent hits the wall.

**Deliberately unchanged.** `sed`/`awk` stay Builder-only: their programs are
code, and `--sandbox` is not a fix — verified with GNU sed 4.9, `sed --sandbox
-i 's/a/b/' f` (also `-ni`, `--in-place`, `-i.bak`) still rewrites the file,
and BSD/macOS sed has no `--sandbox`. Use the `read` tool (`offset`/`limit`),
`head -n N | tail -n +M`, or `rg`; the refusal hints now name them.

**Intentional behaviour changes** (each pinned by a test): `echo rm -rf /` and
`echo "rm -rf /"` are allowed (they print text; a pipe into an interpreter or a
real redirect is still refused), and a quoted flag is now caught rather than
missed — `find . "-delete"` and `eslint "--fix"` are writes, because quote
removal makes those real flags.

**Tests.** The suite grows from 491 to 525: new `shell-text.test.ts` pins the
three views (masking, expansion, argv, Windows paths, a quote-nesting fuzz
loop); `permissions.test.ts` adds the quoted-pattern matrix, the executor
invariant and the cross-gate invariant (`plan-allowed ⇒ not-a-write`);
`edit-policy.test.ts` pins that a quoted pattern is not a write and that the
grant key is unchanged. `npm run check:policy` drives the real `tool_call`
handler through 83 checks, including “a quoted-pattern `grep` produces zero
dialogs in `ask` mode”.

## [0.9.1] - 2026-11-06

### Fixes

- verify the packed import closure before publishing (50efcdc)

## [0.9.0] - 2026-10-31

### Changed — model-aligned thinking levels, short footer statuses

- **`/profile` and `/role` thinking lists follow the selected model.** Pi's
  `getSupportedThinkingLevels`/`clampThinkingLevel` are now consulted for each
  role's staged model. A model whose `thinkingLevelMap` disables `minimal` or
  `medium` no longer offers them, and an unsupported level already stored in a
  profile is clamped on save and on activation with a visible warning. Unknown
  registry entries still fall back to the full list so offline editing works.
- **Every activation path uses the same clamp.** Default-mode profile switches,
  Plan/Build role switches, restore-default and session start now go through
  `applyThinkingForModel`, so the live level always matches the model Pi runs.
- **Footer statuses are split for column layouts.** `workflow` now carries only
  the mode/progress; profile/role and commit/write policy live in
  `workflow-profile` and `workflow-policy`, and the review indicator is the
  `workflow-review` status instead of a separate widget. Desktop hosts can
  render each as its own short footer column; terminal Pi reads the same
  statuses.

Tests: `thinking-levels.test.ts` (new) plus the profile/role/extension suites.

### Fixed — silent activation clamp

- **No repeated thinking-clamp notification on every mode switch.**
  `applyThinkingForModel` still clamps a stale profile/role level to the model's
  supported set, but it no longer calls `ctx.ui.notify` for it. The live level is
  already visible in the host's composer/footer, and the same advisory was
  re-emitted by every Plan/Build/Default switch. The explicit `/role set`
  validation warning is unchanged.

## [0.8.1] - 2026-10-31

### Fixed — `/review` finds the plan you just wrote (2026-10-31)

Starting in Default mode and switching to Plan mid-session left the written plan
visible in the transcript but unreachable by Review: `/review` only read
`currentPlanFile`, which was assigned at approval/handoff/restore — never on a
plan write — and the automatic handoff required the run to have **started** in
Plan mode. `setPlanMode` also cleared the session's last plan path, so a plan
written before the switch had no remaining reference.

- **Manual `/review` is now self-sufficient.** It resolves a readable plan in a
  stable priority order: explicit `path` → this run's last write → the session's
  last write → the last handed-off plan → the newest write in the session branch.
  Missing/unreadable candidates are skipped; the resolved path is named when it
  came from a fallback; the reviewer's `review_submit_plan` writes to that same
  file. `/review <path>` is accepted (restricted to `.pi/plans/`), and a bare
  `/review` with no candidate lists the newest `.pi/plans/*.md` files.
- **Automatic handoff eligibility is mode-at-write.** A mid-run switch into Plan
  now reviews the plan written after the switch. The per-run write check still
  prevents stale plans from being resurrected; a plan written before the switch
  gets `Plan file ready: <path>. Run /review to audit it.` instead of silently
  falling back.
- **Plan targets survive mode switches and prompts.** `currentPlanFile` is set on
  every `.pi/plans/` write and persisted once at `agent_end`; the session-scoped
  last plan path is no longer cleared by `resetPlanRunProvenance`. Restore no
  longer lets an entry without `planFile` erase an earlier one, and `/tree`
  re-derives the plan (or clears it) for the branch that was rewound to.
- **Pass-race timers are cancelled when a pass ends.** The losing waiters in a
  review pass no longer leave the configured timeout armed after the round (or
  the process) finished.

Tests: 480 (new `extension.test.ts` covers Default→Plan→`/review`, mid-run
switch→handoff, pre-switch write→notice, explicit path, no plan, Review Mode off,
restore and `/tree`).

## [0.8.0] - 2026-10-26

### Fixed — Resuming a review no longer reads as a fresh start (2026-10-25)

`/review-resume` was correct internally — the warm reviewer session, its round
and its findings were reused — but the main transcript narrated it as a cold
boot:

```text
▌ REVIEW MODE  opencode-go/deepseek-v4.1-flash · sequential audit
 Review Mode: Review Mode: no time limit configured — …
reviewer started
```

Three independent causes are fixed. The child's `agent_start` is a per-run event
(it fires for every prompt on the same session), so it can no longer produce a
run-start line; the runtime emits the truthful one instead: `reviewer started`
for a fresh session, `reviewer resumed` for a warm `/review-resume`,
`reviewer continuing` for a later round, `reviewer restarting — new reviewer
session` when a reviewer-model switch forced a reboot, and `reviewer verifying —
pass 2` for the verification pass. The mode band gains a `resumed` marker
(`▌ REVIEW MODE  resumed · round N · model`, never `sequential audit`), and a
paused round renders `▌ REVIEW PAUSED` instead of the contradictory
`▌ REVIEW DONE  paused`. `notifyReview` now prefixes `Review Mode:` exactly once
(the doubled `Review Mode: Review Mode: …` notices are gone), the `no time limit
configured` notice is emitted once per reviewer session rather than on every
round, and pending transcript lines are flushed before a band so a resume band
cannot appear above the previous round's last line.

A fourth bug in the same path is fixed: `review_submit_plan` writes the rewrite
to the plan file *during* the round, so pausing after a submission (typically
during pass 2) made `/review-resume` compare the file against the round's input
hash. It then took the fresh branch, printed `Plan changed since the pause`,
reset the round and re-reviewed the reviewer's own rewrite. The pause snapshot
now records the plan-file hash (refreshed when the round settles) and compares
against that, so only an author edit made after the pause starts a fresh round.

Tests: `reviewRunLabel` / `reviewNoticeText` / `reviewResumePlanChoice` tables;
runtime run-label and notice-once cases on the fake SDK; band renderer/key cases

### Fixed — Tab applies the highlighted suggestion instead of cycling modes (2026-10-25)

The workflow registered a raw `tab` shortcut, and Pi's `CustomEditor` dispatches
extension shortcuts **before** the editor. Tab was therefore swallowed even
while a `/profile`-style suggestion list was visible, and
`agent/keybindings.json` additionally disabled `tui.input.tab` entirely.

The extension now installs a thin `CustomEditor` subclass through
`ctx.ui.setEditorComponent()`. While `isShowingAutocomplete()` is true, Tab is
given back to the editor so it applies the highlighted `/command`, `@file` or
`#document`; with no list open the existing shortcut still cycles
Plan → Build → Default, and `Ctrl+Alt+P` is unchanged. `tui.input.tab` is
restored to `tab`, and a one-time warning points users who still disable it at
the fix. The rule is menu-visibility-only, matching Pi Desktop; a `/command`
whose list has not rendered yet still cycles.

The wrapper preserves the default editor's top-border working spinner, seeds
prompt history after the editor swap (including `/reload` and `/resume`), and
expands large-paste markers before they can be submitted as literal
`[paste #N …]` text. If another extension already installed a custom editor, the
wrapper leaves it alone.

Tests: 463 green (447 + 8 policy cases + 8 editor/history cases).
`tab-policy.test.ts` covers the decision table (including the disabled binding
and strict-parity race); `tab-editor.test.ts` covers the shortcut bypass,
history helpers and embedded-status flag.

### Fixed — Long questionnaire content can no longer hide the choices (2026-10-25)

`/commit` asked the agent to put the whole proposed commit message into the
questionnaire's `question`. A multi-paragraph message made the view taller than
the fullscreen input dock, and the dock clips the editor container from the
bottom (it is a flat leaf: the layout engine never descends into the custom
component), so the ✅ Commit / ✏️ Edit / ❌ Cancel rows and the help line were
pushed off-screen. Fullscreen also routes wheel / `PgUp` / `PgDn` to the
transcript unless a real overlay is focused, so an inline questionnaire could
not scroll even if it had handlers.

The questionnaire is now a **bounded bottom-sheet overlay** (full width,
bottom-anchored, at most 80% of the terminal). The view renders at most
`min(32, floor(rows * 0.8) - 1)` lines and slices its own panes: the short
question stays pinned with the choices and help at the bottom, while the long
question or the new optional `context` field scrolls with the wheel,
`PgUp`/`PgDn` or `Ctrl+U`/`Ctrl+D`. The option list scrolls only when it must,
keeping the selected row visible. While typing a free-form answer the options
are hidden and the editor gets the pane; `Esc` returns to the list.

`/commit` now passes the proposed message in `context` with a short pinned
question (`Commit these staged changes?`), so even an agent that ignores the
new field still gets a scrollable question and visible choices. The result
shape and commit-authorization arming are unchanged (`{answers, cancelled}`;
arms only on a positive answer).

New pure geometry/scroll helpers in `questionnaire-layout.ts` and the bounded
view in `questionnaire-view.ts`; `/commit`'s prompt moved to `commit-policy.ts`.
Tests: 447 green, including 16 layout cases, 14 view regression cases, and two
prompt/detection cases.

### Fixed — `/profile` and `/role` pickers: real type-to-filter and close-after-action (2026-10-25)

**Typing now filters.** `SelectList` silently dropped printable keys, so every
"type to filter" hint in `/profile` and `/role` was false advertising. A shared
`picker.ts` (`FilterableList`) pairs pi-tui's `Input` with `fuzzyFilter`, the same
shape pi's `/model` selector uses: match by `provider/id`, profile name/marker,
description, and the model's display name (carried as hidden `searchText`, so
long refs still render untruncated). It covers the `/profile` list, the default
picker, both model tabs and the thinking lists. `Ctrl+O` keeps the query while
re-scoping; `Esc`/`Ctrl+C` clears a non-empty filter first, and Enter over a
no-match list is inert instead of silently closing.

**Completed actions close `/profile`.** `openProfileEditor`/`pickDefaultProfile`
now return `completed | cancelled | failed`, and the picker maps that through
`profileActionClosesPicker`: activate, deactivate, a saved edit/new profile, a
picked default, rename and delete close the overlay; Esc-cancel, a save failure
and the action menu's Back keep the profile list open (with its filter
remembered). No more second Esc.

Tests: `picker.test.ts` (16 cases) covers fuzzy matching, hidden display-name
text, selection, Backspace, Esc/Ctrl+C, no-match and `setItems` scope changes;
`profiles.test.ts` covers the close/keep rule and the new hidden search text.

### Fixed — Review resume no longer stalls on a stale host abort (2026-10-25)

`/review-resume` reused the **parked parent turn's** `ctx.signal`. A second/leaked
ESC while a gated review was paused aborted that parked turn, leaving the signal
permanently aborted. Every resume then started a round, was aborted before the
first prompt (15-18 ms), and the implicit-pause branch re-created `pausedReview`,
so the handoff gate never settled and the plan was never handed off. Pauses are
now **explicit-only** (ESC, `/review-pause`, or the per-round controller): a
pre-aborted or stale host signal is an abort, never a pause. `/review-resume` runs
on a fresh extension-owned `AbortController` and never inherits that signal; a
pre-aborted automatic handoff skips the review and hands off the author's plan.
While a gated review is paused, ESC is swallowed with a hint instead of aborting
the parked turn, and Ctrl+C releases the gate and hands off the author's plan.
`deferredWait` now resolves an already-aborted wait immediately, and the gate
parks only when a paused phase, a snapshot and an unsettled gate all agree.

Pause now also updates every surface: the gate phase, the footer, the status
widget and the spinner all show the paused form (previously the implicit pause
left the spinner on "Reviewing plan…" and the phase on `auditing`).

**The review status line is live-only.** It was driven by the retained
`reviewState`, so `🔍 review · pass 1/2 · 0 findings · aborted` stayed above the
editor in Plan/Build long after the round ended; while paused it showed the
terminal "aborted" text instead of the paused form. The footer and widget now
share `reviewStatusVisible`, clear on every terminal path (success, failure,
abort, mode switch, `/review-mode on`, teardown), and show the paused form while
paused. `reviewState` is still retained for `/review-status` and the REVIEW
SUMMARY band.

Resume notices are outcome-driven (`rewritten` / `unchanged` / `paused` /
`aborted` / `skipped` / `fallback`) instead of comparing strings, so a pause or
failure is no longer reported as "no usable rewrite".

Tests: 398 green (391 + pre-aborted-signal, deferred-wait, outcome, gate-park,
ESC-routing and live-status coverage).

### Fixed — The active profile no longer overrides your latest model choice (2026-10-25)

A profile's Default-mode model was treated as live state and re-applied on every
session start, so picking a model while a default profile was active only lasted
for that session: the next one started on the profile's model again. `Profile.defaultModel`
is now a **seed consumed on activation**; `workflow.modelDefault` is the single
authority. Precedence is resolved once, in `resolveDefaultModeModel`:

| Situation | Default-mode model |
| --- | --- |
| Resumed session with its own recorded model | that session's model |
| Otherwise | `workflow.modelDefault` |
| No record yet (older install) | the profile's `defaultModel` (legacy seed) |

Picking a model never edits `profiles.json`; activating a profile later restores
that profile's own model, because the latest choice wins. A **project-level**
default (`<cwd>/.pi/settings.json` `defaultProvider`/`defaultModel`) is detected
and left in place instead of being overridden — Pi merges that file over the
global one, so the extension now agrees with Pi. Editing the already active
profile's `default` tab also takes effect immediately, without "save & activate".

### Added — Activating a profile makes it the default profile (2026-10-25)

`workflow.defaultProfile` used to be written only by `/profile default`. Every
explicit activation now writes it as well (`/profile use`, the picker's activate
entry, "save & activate"), so the newest profile selection is the one a new
session auto-activates; `/profile use none` clears it. The write targets the
project settings file when that file already defines the key, else global. The
key stays coherent for the rest of a profile's life: renaming the default
profile rewrites it, and deleting it clears it instead of leaving a dangling
name that made every new session warn. `/role list` and the `/profile` picker
now show the whole "what starts next" answer — model, defining file, and the
profile that will be activated.

Tests: 391 green (379 + 11 resolution/project-default cases and 1 write-scope
case).

### Added — The selected model becomes the default for the next session (2026-10-25)

Picking a model used to last only for the current session unless you remembered
`Ctrl+S`; `/profile use` and `/role set` never touched the saved default at all.
The latest selection now wins for every entry point: the model selector (plain
Enter), `Ctrl+P` / `Ctrl+Alt` cycling, Pi Desktop's picker, an explicit
`/profile use` (its `defaultModel`), and an explicit `/role set` / `/role use` /
`/role` picker save.

Entering Plan/Build mode deliberately does **not** persist: the planner/builder
model belongs to that mode, so the next session still starts on the Default-mode
model. Resumed sessions keep their recorded model, and Workflow's
`explore`/review subagents keep their role model (an internal-switch suppression
flag plus an `PI_WORKFLOW_ROLE` guard).

Storage is two-part, written by one read-modify-write that preserves every other
settings key: `workflow.modelDefault` (the extension's own, upgrade-safe record)
plus Pi's native `defaultProvider` / `defaultModel` / `defaultThinkingLevel`
mirror. On `session_start` a brand-new session adopts `workflow.modelDefault`,
because Pi's own resolution prefers the first `enabledModels` entry over a saved
default — without that step a default outside the model scope would be ignored.
The apply is skipped for resumed/reloaded sessions, for subagents, and when the
live model is an explicit choice (it differs from Pi's scoped-first pick, Pi's
saved default and ours). Idempotent writes make a repeated selection a no-op.
`/role list` and the `/profile` picker now show which model the next session
will start on and which settings file defines it.

Tests: 379 green (340 + 38 `model-default.test.ts` cases covering coercion,
project-over-global precedence, key preservation, byte-identical idempotency,
the session-start apply matrix and the event-gating regression locks).

### Changed — Model pickers: full names, state in the header (2026-10-25)

The `/profile` and `/role` model lists no longer use pi-tui's description column.
That column reserves a fixed 32-cell first column (truncating long refs such as
`synthetic/hf:deepseek-ai/DeepSeek-V4.1-Flash-1017`), and the pickers filled it
with `● selected` / `current` / `all`. Rows are now plain `provider/id`; the
header shows `staged:` (and `saved:` in `/role`) plus the scope (`scoped N` /
`all N`), and Ctrl+O is inert when no scope is configured instead of swapping
the list for an empty one. The desktop host now honours `enabledModels`, so a
scoped session opens on the scoped models rather than the whole catalogue.

### Fixed — Resumed review state and stale plan handoff (plan 2026-10-25 follow-up)

**Resumed reviews report running.** `/review-resume` now moves a gated paused
phase back to `"auditing"`, and `settleReviewGate` resets the phase to `"idle"`.
The mode-lock predicate treats a real pause snapshot as paused, a live round as
running even when the parked handoff still says paused, and only falls back to
the gate phase when neither is present. Pressing `Tab` during a resumed round no
longer says "Review is paused", and a second ESC can pause the resumed round
again.

**A stale plan can no longer hand off.** A Plan handoff now opens only when the
current user run started in Plan mode and wrote/edited a `.pi/plans/` file in
that run. Session-lifetime `lastPlanWritePath`/`currentPlanFile` state and
session-branch scans are no longer handoff sources, so Build → Plan followed by a
new prompt does not reopen the previous Build plan in Plannotator. A fresh
prompt or mode switch resets per-run provenance and supersedes any pending
browser/inline decision; stale Plannotator approvals are correlated by
`awaitingDecision`, review id and plan path/hash. The current run's write path is
authoritative for the handoff content, `planFilePath` and `currentPlanFile`.

Tests: 340 green (337 + resumed-phase/lock precedence and handoff provenance
coverage).

### Changed — Review mode locks mode switching (plan 2026-10-25)

A live review now owns the turn: `Tab`, `Ctrl+Alt+P`, `/plan`, `/build`,
`/default`, the programmatic Build entry, Plannotator approve/deny and the
external pi-code plan-mode event are refused until the round lands, fails, or is
aborted. Previously Tab-to-Build mid-review silently swapped the tool set and
`suspendReview()` dropped the round/pause and the pending handoff. The lock is a
derived projection over in-memory review state (never persisted), so success,
failure, pause/resume, `/review-abort` and `/review-mode off` release it
automatically; a reload cannot restore a phantom lock. The notice names `ESC`,
`/review-pause`, `/review-resume`, `/review-abort` and `/review-mode off`, and the
footer carries `🔒 modes locked` (also shown by `/review-status`). The
post-review handoff prompt is intentionally unlocked because the independent
reviewer has finished. This supersedes the 2026-10-23 acceptance of "Tab-to-Build
mid-gate" as an exit path.

Tests: 337 green (334 + the mode-lock truth table, notice and footer/status
coverage).

### Changed — Ad-hoc `/review` without Review Mode on

Bare `/review` (plus `/review say|pause|resume|abort|status`) now works
whether or not Review Mode is on: it runs a single one-shot round on the
saved config and never flips the persisted `enabled` flag. Only the
automatic audit at handoff (now a foreground gated phase — the handoff waits
for it — plus the prefetch and the planner note) still requires
`/review-mode on`.

### Changed — Gated handoff: the plan waits for the review (plan 2026-10-23 follow-up)

This supersedes Phase B step 5 of the fast-interactive plan below ("the
handoff never waits") — that behavior is reversed.

**The handoff waits.** `agent_end` now runs the automatic review as a
foreground gated phase before anything renders: no browser prompt, inline
choice, or headless preview appears until the round lands, fails, or you
pause/abort it. The reviewed plan becomes the handed-off text (todo steps
re-synced); any failure hands over the author's draft with a warning
(`fallbackOnError = "skip"` is unchanged). A second `agent_end` while the
gate is open is told the review is running instead of queueing behind it.

**ESC works everywhere.** A terminal-input listener registered for the
round's lifetime maps a bare ESC to `/review-pause` semantics (snapshot once,
warm session, one notice) and consumes the key only when it paused — the
editor, questionnaire, and handoff selector keep ESC otherwise. This unifies
the previously split command/host-signal pause paths with exactly-once
snapshot and notice (including the pass-2 race, where the rewrite wins and a
stale pause is dropped).

**Working signal.** The footer `workflow` status composes a review segment
from the same summary the widget shows (single owner: `updateStatus`),
refreshed on every reviewer phase transition; the spinner row reads
`🔍 Reviewing plan…` for the round (`⏸ Review paused — …` while paused) and
is restored afterwards. No new Pi APIs — only the public working-indicator
methods, guarded for headless hosts.

**Abort delivers.** `/review-abort` while a handoff waits settles the gate
with the author's plan, so the normal renderer runs and the plan is always
delivered. `/review` (fresh round) refuses while a gate is open and points at
steer/pause/abort instead, so nothing can race the handoff it is about to
render. Approve/deny can only arrive after the review (the prompt does not
exist before), with `suspendReview` kept as the warm-abort safety net. The
gate is in-memory only and exactly-once; pause never resolves it
(`/review-resume` does), and teardown paths settle it as skipped.

**Tests.** 334 green (330 + gate resolver, ESC predicate, footer segment,
pass-2-abort-keeps-pass-1's-plan).

### Changed — Review Mode goes fast-path + interactive (plan 2026-10-23)

**Speed (fast by default, existing settings still override).** The pass-1
context is dieted (`contextChars` 60K→15K, `contextEntries` 120→30,
`contextToolChars` 4K→1K — new settings, old caps are the maxima), and a
Planner-context manifest (file inventory with size/mtime/hash tokens plus
recent `explore` recon, newest first) rides along so the reviewer verifies
instead of re-exploring. `exploreBudget` defaults to `1` (was `3`) and drops
to `0` whenever the manifest already carries recon. Pass 2 runs only for
`accepted` findings at severity ≥ 7 (was ≥ 5) and checks a unified diff
instead of two full plans. The reviewer session stays warm across rounds and
mode switches (a model change reboots it), the handoff prefetches the session
while it resolves the plan, and `timeoutMs` defaults to 5 minutes (was
unlimited; `0` still opts out).

**Interactive (SUPERSEDED by the gated handoff above — kept as history).**
The handoff used to render immediately with the author's plan (marked
"review pending") while the round worked detached and the landing only
announced — it never overwrites edits made meanwhile (a guarded
`updated`/`unchanged`/`stale` classification, unit-tested). ESC pauses the
round and keeps the session warm (`/review-pause`, `/review-resume`,
`/review-abort`; in-memory only). Plain chat stays with the plan agent
mid-review — `/review say <msg>` steers the reviewer, `/btw` always queues.
`/role` and `/profile` switches take effect next round (the model is
snapshotted per round and named in the band/status). `/review` aborts any
in-flight round before re-running, and nested option modals stack on a depth
counter instead of clobbering each other.

**Tests.** 330 green at that point (334 now — see above), including new contracts for the verify gate (7/accepted),
the plan diff, the manifest (inventory caps, newest-first recon, junk input),
the landing guard, ESC-abort-keeps-session-warm, pause→resume session reuse,
manifest-in-prompt, and model-change reboot.

## [0.7.0] - 2026-10-23

### Added — per-profile Default-mode model

**The feature.** A profile can now carry its own Default-mode (chat) model
via an optional `defaultModel` field (`{ provider, id, thinking }`), separate
from the role models. Switching to a profile that defines one applies it
immediately in Default mode; the profile editor gains a `default` tab; and
`sanitizeProfile` also accepts a `roles.default` alias for hand-edited files.
Display paths (`describeProfile`, the one-line summary, the management UI)
show the Default-mode model alongside the roles.

### Fixed — the ask dialog asks once per turn, not once per tool call

**The problem.** The write policy's `ask` mode opened a dialog **per gated
tool call**. Pi runs an assistant message's tool calls as a **batch**, and the
extension's `tool_call` hook is invoked for *every* call of that batch before
the first of them runs (`pi-agent-core`: `executeToolCallsParallel` →
`prepareToolCall` → `beforeToolCall`). So when the model batched two writes to
one file, the user got **the same question twice, back to back**, with no agent
output in between — and the sentence typed into the first dialog could not
reach the model before the second one opened (a tool result is appended only
after the whole batch, and a steer message lands only after the turn's tool
calls have run). The user had to select *Deny with instructions…* again and
retype the same sentence; only the second copy reached the agent.

**The change.**

- **One dialog per assistant turn.** It lists every gated write of that turn
  (`Write policy 'ask': allow these 2 writes? (edits src/a.ts; edits src/b.ts)`)
  and one answer applies to all of them. *Allow once* is now **Allow once
  (this turn)**; *Always allow …* persists a grant for **every** listed target
  (paths and commands), so none of them asks again.
- **A denial is remembered for the rest of the run.** A later turn that tries
  the same target is denied again with the same sentence — **no second dialog,
  nothing to retype**. The memory ends with the run: the next run asks again.
- **The instruction is delivered once per turn** (one steer user turn, not one
  per blocked call), and every blocked call of the turn carries it in its block
  reason.

**Scope.** The `allow` / `never` modes, the `.pi/plans/` carve-out, the role
and commit gates, the reviewer routing, the fail-closed headless path and the
"a denial never sets `terminate`" contract are unchanged. A host that delivers
no assistant message falls back to one dialog per call.

## [0.6.1] - 2026-10-22

### Fixed — the active tab is marked explicitly, not only by a fill

**The problem.** The tab rows (the questionnaire, the profile editor, the role
config) marked the active tab with a **background fill** only
(`theme.bg("selectedBg", …)`). A fill is easy to miss in a host that paints it
in its own palette — the Pi Desktop app renders extension components in its own
theme, and the fill was nearly invisible there. The reader could not tell
*which* tab was active, and the `■`/`□` glyphs (answered / unanswered) carried
the only strong signal in the row.

**The change.** The active tab now carries an explicit `→` marker in the accent
colour, next to the state glyph, in addition to the fill. The marker replaces
the two-space indent, so the labels stay aligned:

```text
→ □ Scope   ■ Tests   ✓ Submit
  □ Scope   ■ Tests   ✓ Submit
```

**Scope.** Rendering only: no behaviour, keybinding or answer changes. The
questionnaire, the profile editor and the role config all use the same marker,
so every tab row in every surface now says which tab is active.

## [0.6.0] - 2026-10-20

### Added — "Deny with instructions": a guided denial in the write policy

**The problem.** The write policy's `ask` mode offered **Allow once** / **Always allow this path** / **Deny**. A plain **Deny** tells the model only that the write was refused — not what the user actually wants — so the model either stops cold or re-proposes the same class of change. The user could not say *"only explore and propose a plan, do not edit files yet"*.

**The feature.** The `ask` dialog now has a fourth choice, **Deny with instructions…**, which opens a one-line text box. The sentence the user types is delivered to the model through **two channels**:

1. **The block reason** (the tool result): the instruction is quoted verbatim, followed by the disposition — *"Do not retry this write. Follow the instruction above. If it cannot be followed, say so and stop."*
2. **A user message** (`pi.sendUserMessage(..., { deliverAs: "steer" })`): the same sentence is delivered as a real user turn after the current tool batch, before the next model call.

**Why two channels.** Claude Code shipped the comment-on-rejection design and then shipped the bug where the model ignored the comment and kept trying workarounds ([anthropics/claude-code#89231](https://github.com/anthropics/claude-code/issues/89231), [#52824](https://github.com/anthropics/claude-code/issues/52824)). A tool result is a fact the model may reinterpret; a user turn is an instruction it must follow. Cursor and Claude Code now offer the same affordance (*"Reject? Tell what to do differently"*).

**Semantics.**

- **Scope: this write only.** Nothing is persisted — the instruction never reaches `settings.json`; it lives in the transcript and in one `workflow-write-denial` audit entry.
- **Cancelling or emptying the text box is a plain Deny** — never an implicit allow. A host without a text dialog falls back the same way (fail closed).
- **Input is sanitized**: CRLF normalised, control characters stripped, capped at 2000 characters.
- **The steer channel is skipped while a review round is active**, because the extension's `input` handler routes user text to the reviewer; the tool-result copy still carries the instruction.
- **A plain Deny behaves exactly as before**: the denial does not set pi's `terminate` flag, so the agent's run is not cut short. (`terminate` is only consulted after a whole tool batch has run, so it could not suppress a sibling write anyway — it would only remove the model's next turn.)

### Internal

- `edit-policy.ts` gains the pure, unit-tested helpers behind this feature: `writeGateOptions` (the single source of the dialog labels), `sanitizeWriteInstruction`, `parseWriteGateChoice` (the `"Deny with…"` label is matched **before** the bare `"Deny"`, and an unknown answer fails closed to a denial), `buildWriteDenyReason` and `buildWriteGuidanceMessage`.
- `edit-policy.test.ts` gains 14 cases (including a coupling guard that maps every real option through the parser); `scripts/verify-write-policy.mjs` gains 29 checks (53 total) covering the instruction dialog, both delivery channels, the audit entry, the cancelled/empty fallbacks, and the "no `terminate`" contract.

## [0.5.2] - 2026-10-11

### Features

- full-argument slash-command completions for /profile, /role, /commit-policy (ef4178d)

## [0.5.1] - 2026-10-11

### Fixed — `/commit` was dead under the (default) `never` commit policy

**The bug.** 0.4.0's commit-policy gate armed a single-turn exemption (`commitBypassActive`) before injecting the `/commit` agent turn and disarmed it on `turn_end`. But `/commit` is inherently **multi-turn** — read the staged diff → confirm the message in a questionnaire → commit — and `turn_end` fires after *every* assistant response. So the exemption was always gone by the turn that actually ran `git commit`, and `/commit` was blocked under `never` (and under `allow` during a plan) with the policy message.

**The fix — scoped, confirmation-armed authorization.** The exemption is now armed at the user's *decision* instead of before the run:

- `/commit` records a `PendingCommitFlow` and injects its agent turn; nothing is exempted yet.
- The extension-owned `questionnaire` tool arms a `CommitAuthorizationState` only when the user confirms THIS flow's commit questionnaire (positive answer). ❌ Cancel clears the flow and arms nothing.
- The authorization exempts **only `git commit`** (`add`/`push` never) and lives until the run settles (`agent_settled`), bounded by a 10-minute TTL and a 10-commit cap; it is also dropped on `session_shutdown` and rewind (`session_tree`). The per-turn disarm is removed.
- **Fail safe:** no confirmation → no authorization → the policy keeps blocking. Headless sessions never reach the questionnaire, so they still fail closed.

**Testability.** The gate decision is extracted into a pure `decideCommitGate` (`commit-policy.ts`), alongside `startCommitFlow`, `armCommitAuthorization`, `isAuthorizationActive`, `isCommitConfirmation` and `isPositiveCommitDecision`. `commit-policy.test.ts` gains 17 cases covering the full policy × subcommand × todo/auth truth table, TTL/cap expiry, cancel-vs-confirm detection, and the exact regression (never + commit + no auth → block; never + commit + active auth → allow; auth never exempts add/push).

Breaking: none.

## [0.5.0] - 2026-10-11

### Added — Model Profiles: named, session-scoped role-model combinations (`/profile`)

**The problem.** Roles fixed ONE model per role, globally. That made three real workflows clumsy: mixing providers inside one session (frontier planner + cheap explorer), keeping a budget per provider (re-pointing four roles back and forth is tedious, so everything rides one key), and working around per-provider concurrency/rate limits — concurrent sessions all shared the same four models, so parallel sessions hammered the same provider.

**The design — profiles as a model-overlay layer on top of roles** (`profiles.ts`, new module, pure/unit-testable like `commit-policy.ts`; `roles.json` v2 is untouched):

- **Storage**: `~/.pi/agent/profiles.json` v1 (user) + `<cwd>/.pi/profiles.json` project override (per-profile replace, project wins, last-wins within a file — same merge discipline as roles). A profile stores `{name, description, roles}` with at most one `{provider, id, thinking}` per built-in role — model + thinking ONLY; tools, system prompts and custom roles stay global in `roles.json`. Non-destructive loader: a missing file is the normal empty state (info), corrupt/wrong-version files warn and fall back to an in-memory empty config and are never rewritten.
- **Activation is session-scoped by design**: `setActiveProfile` rides the `workflow` session entry (like `activeRole` already does), so `/resume` restores it and **two concurrent sessions can run different profiles** — there is deliberately no global active-profile file. The optional `workflow.defaultProfile` setting (global/project, project wins) seeds sessions that never made an explicit choice; an explicit `/profile use <name|none>` pins that session.
- **Effective roles**: one cached overlay (`effectiveRoles()` / `getEffectiveRole()` — keyed by base-config object identity + active profile name) feeds every model-RESOLUTION site: plan/build mode switching, Review Mode's reviewer session (planner fallback kept), the reviewer's explore scout, the `explore` tool routing, the review band label and `/review-mode status`. All EDITING sites (`/role`, role picker) keep operating on the base roles — the picker shows a notice while a profile is active and `/role list` prints the profile's overrides, so profile values can never leak into `roles.json`.
- **`/profile` command**: bare → management picker (activate/deactivate, edit models, rename, delete with a confirm dialog, New profile…, Default for new sessions…); `list`, `show <name>`, `use <name|none>`, `create <name>` (UI: tabbed editor seeded from the current effective models; headless: seeded + saved), `edit <name>` (tabbed planner/explorer/builder/reviewer editor mirroring the role picker — scoped models first, `Ctrl+O` for all, staged selections, **Save & activate** / **Save only** tabs), `rename <old> <new>`, `delete <name>`, `default [name|none] [global|project]` (read-modify-write of `workflow.defaultProfile`, preserving every other settings key). Headless parity for every subcommand; argument completions for subcommands + profile names.
- **Names**: trimmed, case-insensitively unique, ≤ 40 chars, no whitespace (names stay CLI-addressable), `none`/`auto` reserved. The status line shows `⚡ <profile>` while one is active. Activation in plan/build re-applies the mode model immediately; in Default mode it applies on the next plan/build/explore/review use — the manual chat model is never touched by activation.
- **Fallback guarantees**: no profile active → the overlay is a shallow copy, so behaviour is identical to the pre-profile roles flow; a profile deleted/renamed in another window deactivates cleanly with a warning; a model missing from the registry is warned at save time and refused at switch time ("staying on current model"), exactly like `/role set`.

Tests: 11 cases in `profiles.test.ts` (loader fallback matrix, user+project merge, sanitizer, name rules, overlay purity + fallback, fingerprint, save round-trip, `workflow.defaultProfile` extract/read/write with other-key preservation). Packaging: `profiles.ts` added to `files[]` (repo gate verifies the tarball), test script and tsconfig include updated.

Breaking: none. `roles.json` stays v2; older sessions resume without profile state and simply follow `workflow.defaultProfile` if set.

## [0.4.0] - 2026-10-11

### Added — Commit Policy: user-controlled commit behavior, enforced where commands execute

**The problem.** When the agent executed a multi-step plan it freely ran `git add` + `git commit` — often one commit per step — polluting the user's real git history. Nothing in pi core or this extension instructed that: the core system prompt says nothing about git, the builder role's bash is unrestricted, so the model simply *habited* its way into per-step commits. That is the exact failure mode reported against Claude Code (#58883, #68724, #7029), where "never commit unless asked" prose rules are repeatedly ignored — prompt-only rules are soft; enforcement must be deterministic. Claude Code, Codex CLI and OpenCode all treat agent-initiated commits as something to gate or approve; Aider is the configurable-commit pole (`--no-auto-commits`, `--commit-prompt`).

**The design — `workflow.commitPolicy`** (`commit-policy.ts`, new module, pure/no runtime imports, unit-testable like the review.ts config section):

- **Modes**: `never` (**new default** — the agent cannot run `git add`/`git commit`/`git push`; you commit manually or via `/commit`), `ask` (each `git commit`/`git push` pops an Allow once/Deny dialog; `git add` stays free; headless sessions fail closed), `allow` (**deterministic per-step commits**: while a plan todo list is active the extension itself makes exactly one commit per completed step at the `workflow_todo` completion boundary and blocks the model from running `git add`/`commit`/`push`; outside a plan the model keeps its previous freedom). Bare-string shorthand (`"commitPolicy": "ask"`) is accepted; booleans/numbers/unknown modes fall back to the default.
- **Settings**: `workflow.commitPolicy.mode` in `~/.pi/agent/settings.json` (global) or `<cwd>/.pi/settings.json` (project, wins field-by-field). `writeCommitPolicyConfig` is read-modify-write, preserving every other key (same guarantee as `writeReviewModeConfig`).
- **Hard enforcement** (`gitCommitPolicyHit` in `permissions.ts` + a new gate in the `tool_call` handler): segment-aware classifier that resolves the real git subcommand through compound commands (`&&`/`;`/`|`), global options (`-C path`, `--git-dir=…`, `-c key=value` pairs), wrapper forms (`env git commit`, `nice -n 5 git add`, `GIT_DIR=. git push`) and binary variants (`git.exe`, absolute paths, quoted Windows paths). Fail-closed by design — false positives (an unquoted `echo git commit`) are acceptable; false negatives are not. The gate covers `bash` **and** `powershell` so a wrapper cannot bypass it, runs in every mode except plan mode (planner gating already blocks everything), and is independent of the role gate — it also governs the unrestricted builder role, which is the point.
- **`/commit` keeps working** under `never` and `allow`-during-a-plan: the flow arms a one-turn bypass (`commitBypassActive`) right before injecting its agent turn, so the flow's own `git commit` runs; staging already happens extension-side via `piExecGit` (outside the tool gate), and `add`/`push` are never bypassed. The flag is disarmed on `turn_end` and `agent_settled` (settle/abort/error), so the window is exactly one turn and fails safe.
- **Deterministic per-step commits (`allow` mode)**: commit timing is owned by the extension, not the model. A pure decision core (`stepCommitDecision`/`stepCommitMessage` in `commit-policy.ts`) gates on mode + active todos + dirty tree + new completions; the trigger is the `workflow_todo` `tool_result` boundary — the extension runner AWAITS `tool_result` handlers, so the commit (`git add -A` + `git commit -m "step N: <step text>"` via `piExecGit`) lands after the step is marked done and BEFORE the model starts the next step. A `committedStepRefs` ledger makes it exactly-once per step (a `[DONE:ref]` fallback at `turn_end` covers steps completed via response tags; once-per-session seeding of already-done steps prevents spurious commits on session resume or plan re-execution). Batched completions (several steps marked in one call) yield one commit covering the batch — the per-step protocol ("mark IMMEDIATELY after finishing") is what keeps commits 1:1 with steps.
- **Soft layer**: the plan-execute handoff message (plannotator path, UI decision-gate path and the headless fallback) gains a policy-aware commit directive — `never` says do not commit at all; `ask` says per-step commits will prompt; `allow` says do not run git yourself — the extension commits automatically after each completed step.
- **Status surface**: the workflow status line always shows the active policy (`▶ build 2/5 · commits:never`), read live so `/commit-policy` changes show up without a reload; in default mode with no todos the status item becomes `◦ commits:<mode>` instead of disappearing.
- **`/commit-policy` command** (all modes): bare/`status` prints the mode, which scope supplied it and both settings paths; `never|ask|allow` with optional `global`/`project` writes the setting and names the file; argument completions included.

Behaviour deliberately unchanged: shadow-checkpoint rewind (separate bare repo, invisible in user history), plan-mode/subagent read-only gating, and read-only git forms (`status`, `log`, `diff`, `branch -a`, `config --get`, `stash list/show`, `tag -l`) stay free under every mode. Known limits (accepted, same trade-off OpenCode/Claude Code make): configured git aliases and exotic obfuscations are not recognized.

**Breaking**: the default is now `never` — an agent that previously committed on its own will be blocked until you run `/commit-policy allow` (or `ask`); `allow` during a plan means automatic per-step commits, not model freedom. Tests: 27 cases in `commit-policy.test.ts` (coercion matrix, merge precedence, scope-source attribution, disk round-trips, preserve-other-keys writes, the per-step decision core and message builder) and 6 in `permissions.test.ts` (classifier matrix: compounds, global options, wrappers, binary variants, false-positive bounds).

## [0.3.3] - 2026-09-22

### Fixed — Review Mode: a dead provider is no longer mislabeled as a missing write path

**The bug.** When the reviewer's model provider started failing mid-review, the round ended with `the reviewer finished without submitting a plan — it has no write path unless review_submit_plan succeeds` — even though the reviewer's tools had been active and working for the entire pass (in the diagnosed incident, ~95 minutes of successful `review_bash`/`read` calls). The real chain: Pi's SDK never rejects `prompt()` on provider errors — it auto-retries (default budget 3, the counter resets on every successful assistant message) and its `finally` always emits `agent_settled`, even when the run died with `stopReason: "error"`. The orchestrator's settled path only checked `!p1.submitted`, never inspected the child's final assistant message, and the transcript translator rendered `auto_retry_start` as a bare "retrying after a provider error", dropping the provider's own message. With the child session in memory, the actual API error was unrecoverable after teardown.

**The fix — capture and surface the real error:**

- **Boundary decoder** (`review.ts`): new `readProviderErrorEvent()` decodes one child event into a typed `ReviewProviderFailure` (`retry` / `exhaust` / `stop` / `none`); `truncateErrorText()` flattens a multi-line provider error into one bounded line (160 chars); `lastAssistantErrorStop()` extracts the error-stop reason from an `agent_end`'s messages.
- **Capture in the runtime** (`review-runtime.ts`): the child event subscriber records the latest provider failure (message, retry count, timestamp); the slot is cleared at the start of every pass so a stale error can never mislabel a later clean settle.
- **Honest failure reasons.** Pass 1 settling without a submission now reports `the reviewer's provider failed after N retry attempt(s): <error>` when a provider failure was seen during that pass; the legacy message is kept verbatim for a genuine clean settle without a tool call, and the timeout variant is unchanged. `state.error` carries the reason, so `/review-status` shows the same text.
- **Live transcript errors.** `auto_retry_start` notices carry the truncated provider message (`retrying after a provider error: 429 …`), a failed `auto_retry_end` renders `reviewer retry budget exhausted: …`, and an `agent_end` that stopped on an error appends an `error` line — a new red `error` line kind in the reviewer pane.
- **Pass 2 stays best-effort but explains itself.** A verification pass that dies on the provider logs `verification pass failed (provider error after N retry attempt(s): …)` — or `ended without a submission (…)` — and keeps pass 1's plan.

Behaviour deliberately unchanged: the fallback (the author's plan is handed over), the unlimited default timeout, no automatic pass retry, no submit-nudge.

Tests: 7 new cases in `review.test.ts` — `truncateErrorText`, the translator's provider lines, the decoder matrix, and runtime rounds asserting the new reason (including an error-stop run with no retries and the no-leak-into-pass-2 guarantee); the legacy no-submission regression test still passes. The README gains a troubleshooting entry keyed on the new message.

## [0.3.2] - 2026-09-21

### Fixed — Review Mode: any provider works as the reviewer

**The bug.** Every Review Mode round failed for providers that exist only because an extension registered them in the parent session (`pi.registerProvider(...)`): the transcript showed `could not prompt the reviewer: No API key found for <provider>.` even though `/login` had stored a valid credential in `auth.json` and Plan/Build worked fine on the same model. The reviewer session is deliberately created without ambient extensions and with its own fresh model runtime, so the provider layer the parent composes never reached it.

**The fix — layer-agnostic provider seeding** (`review-providers.ts`, new module):

- **Present-probe, not layer names.** Before the reviewer session is created, the parent context is probed for a provider-registration surface (the model registry facade first, then the runtime — feature-detected). Providers the child already composes are skipped: the built-in catalog and `~/.pi/agent/models.json` are loaded by every runtime by construction, so the seeder is a no-op for them — and for any provider source a future Pi version composes globally.
- **Seed the difference, native-first, fault-isolated.** Every missing provider id is registered on the reviewer runtime — the parent's provider object when there is one, otherwise its config — each in its own try/catch; a broken unrelated provider can never block a review, and a second pass skips already-seeded ids.
- **Provider-agnostic auth preflight.** After seeding, the reviewer runtime is asked `hasConfiguredAuth(provider) || checkAuth(provider)` for the reviewer model's own provider; on absence the review fails fast with the provider name, the seed report and the escape hatch below, instead of a bare error mid-review.
- **Defensive failure text.** A pass-1 failure that still carries the bare `No API key found for <provider>.` gains an actionable hint naming `/login <provider>` and the escape hatch — only when the failing provider is the reviewer's own.

**The universal escape hatch** (documented in the README, works for any provider and even on an installed version without this fix): `~/.pi/agent/models.json` is loaded by every runtime, including the reviewer's — add the provider under `"providers"` with `baseUrl`, `apiKey: "$MY_API_KEY"`, `api` and its `models`; a stored `/login` credential always wins over the template. The README gains a "Provider seeding" section (the three-layer taxonomy, why `noExtensions` is deliberate, the probe design) and a troubleshooting entry keyed on the exact transcript text. 17 new tests cover seeding order, the built-in/static skip, native-first registration, per-provider tolerance, the preflight, the missing-surface path and idempotency.

### Fixed — command policy: `/dev/null` unblocked, verified write/exec holes closed

- **`2>/dev/null` is no longer treated as a file write.** `hasForbiddenSyntax`
  refused every `>` that was not fd duplication, so a Plan Mode
  `ls ~/…/docs/ 2>/dev/null || ls <path>` was refused even though `ls` is
  allowlisted: the null device is a bit bucket, not a file. Redirections whose
  target is exactly `/dev/null` (`>`, `>>`, `1>`, `2>`, `2>>`, `&>`, `&>>`, with
  or without a space) are now subtracted before the file-redirect check, and the
  new `forbiddenSyntaxReason()` names the failing construct. `/dev/null.txt`,
  `/dev/nullx`, `/dev/null/../f` and `2>NUL` are still writes and still refused.
- **Refusals now explain themselves.** New `explainCommandRefusal(role, command)`
  is the single source of truth; `isCommandAllowedForRole` is defined as "no
  refusal", so a message can never describe a policy the gate no longer
  enforces. The Plan Mode gate and `review_bash` print the reason
  (`forbidden-syntax` / `destructive-pattern` / `blocked-flag` /
  `segment-class`) plus a concrete suggestion.
- **`sed`/`awk` are Builder-only.** Their programs are code: GNU sed's `e`
  command and awk's pipe-to-command both ran arbitrary shell from an allowed
  "read-only" command (`sed -n 'e echo X' f`, `awk 'BEGIN{print "x" | "sh"}'`),
  and `sed -n -i` / `awk -i inplace` wrote files in place. All four were
  verified by execution before the fix.
- **Snapshot/update flags can no longer be smuggled through a wrapper.**
  `npm test -- -u`, `npm run test -- -u`, `yarn`/`pnpm test -u`,
  `node --test --test-update-snapshots` and `node --run test -- -u` are refused;
  the bare runners already were. The matcher also covers `-update`/`--update`.
- **Arbitrary output paths and exec flags from verify tools are refused.**
  `eslint -o`/`--output-file`, `jest`/`vitest --outputFile`, `pytest
  --junit-xml`/`--cache-clear`, `go test -coverprofile`/`-exec`,
  `mypy --install-types` and `ruff check --add-noqa` could write a chosen path
  or execute a program; a long-option spelling gap (`--output-file` did not
  match `--output`) was the root cause for the first.
- **`git -c <key>=<value>` is refused.** Config values can select programs git
  executes (`core.fsmonitor`, `core.pager`, `credential.helper`); `git -C <dir>`
  (plain chdir) is still allowed. Multi-word values were only blocked by a
  tokenizer accident, so this is now an explicit rule.
- **curl's method/write spellings are complete.** `--request
  POST|PUT|DELETE|PATCH|CONNECT`, `--json`, `--data-raw`, `--form-string` and
  `--output-dir` are refused like their short forms.
- **Added out of the same audit** (previously refused although harmless):
  `git show-ref`/`check-ref-format`/`diff-tree`, bare `npm run`/`yarn run`
  (lists scripts), `node --run <allowlisted script>`, and `base64`, `man`, `ss`,
  `netstat`, `lsof`. `timeout …` and `VAR=value cmd` prefixes remain refused
  (deliberate, separate decision); the quote-insensitive keyword denylist is
  unchanged, so `rg "cp" f` is still refused.
- Tests: `permissions.test.ts` grows from 11 to 15 tests — the null-device
  matrix, every closed hole with its repro, the newly allowlisted reads,
  `forbiddenSyntaxReason`, and `explainCommandRefusal` including the invariant
  that the gate and the explanation can never disagree. 129/129 passing.

### Fixed — role config loading (stale reviewer model)

- **Root cause of the stale reviewer model.** `roleConfig` is a module cache
  initialized to the built-in seed defaults and only replaced from `roles.json`
  when some other action happened to call `ensureRoleConfig()`;
  `/review-mode status` and the reviewer-model resolution read it without
  loading, so a fresh session with no persisted workflow entry showed the seed
  (`opencode-go/muse-spark-1.3-contributor`) instead of the file's model. A
  `/reload` only appeared to fix it because the session had since persisted a
  workflow entry that triggered the load.
- **Guaranteed load.** `ensureRoleConfig()` now runs unconditionally at
  `session_start`, at the top of every `/review-mode` command, and before the
  reviewer model is resolved for a band or a review round. The cache is keyed by
  cwd so a session switch cannot reuse another project's roles.
- **Auto-refresh.** Loading re-runs when either `roles.json` changes on disk
  (`mtime` + size fingerprint), so `/role` edits from another window or process
  are visible without `/reload`.
- **Non-destructive fallback.** A missing, unreadable, corrupt, or legacy
  `roles.json` is no longer overwritten with seed defaults; in-memory defaults
  are used and a warning naming the file is shown (`loadRoleConfigDetailed`
  reports `usedDefaults`/`reason`). This removes a real data-loss path.
- Tests: new `roles.test.ts` covers merge precedence, the
  missing/corrupt/legacy non-destructive behavior, and the fingerprint.

### Fixed — `/review-mode status` accuracy

- **The `flow` row is gone.** Review Mode is always sequential; the status no
  longer describes a parallel/sequential choice.
- **Timeout provenance.** `/review-mode status` prints the effective `timeoutMs`
  together with the settings file that supplied it (`unlimited (default)`,
  `600s (global settings)`, …) and adds a one-line warning while a scope still
  pins the legacy `600000` value.
- **New `/review-mode timeout <seconds|unlimited> [global|project]`** sets or
  shows the cap without hand-editing `settings.json`; `unlimited`/`0` removes it.
- **`/reload` caveat documented.** The status reflects the code and `roles.json`
  snapshot loaded at process start, so an extension edit or a `/role` change made
  in another window needs `/reload` before it appears.

### Changed — role-based command permissions, unlimited review timeout, header-only review transcript

- **Role-based command policy.** New `permissions.ts` classifies commands into
  `read-only` / `verify` / `full` and maps them to planner, reviewer, explorer and
  builder. Plan Mode and `review_bash` now allow read-only inspection **plus**
  test/lint/typecheck runners (`npm test`, `npm run lint/typecheck`, `eslint`,
  `tsc --noEmit`, `node --test`, `pytest`, `cargo clippy`, …) while still refusing
  mutating commands, redirects, installs and builds. `isSafeCommand` remains as a
  compatibility alias for the planner policy.
- **Compound commands are checked segment-by-segment** with quote awareness, so
  `git status && npm test` and `npm test 2>&1 | tail -50` are allowed while
  `curl … | sh`, `$(…)`, backticks, heredocs and file redirection are refused.
  `npx` stays denied. The destructive git pattern was narrowed so `git tag -l`,
  `git stash list|show` and `git config --get*|--list` are reachable.
- **Explorer subagents are gated too.** `runSingleAgent` passes
  `PI_WORKFLOW_ROLE=explorer` into the spawned `pi` process and the extension
  resolves the role per tool call, so a subagent's `bash` is read-only (it was
  previously ungated). `edit`/`write` are refused for non-planner restricted
  roles. The `powershell` tool is refused for every non-builder role.
- **Review Mode no longer has a time limit by default.** `timeoutMs` defaults to
  `0` (unlimited); a positive value is still an optional cap. Passes end on
  `review_pass_done`, run settle, abort or error, and the settle race still fails
  a silent reviewer fast. The pre-pass in-flight settle keeps a 60 s fallback so
  a hung earlier run cannot block pass 1.
- **Review transcript is header-only.** `translateReviewEvent` no longer streams
  assistant prose or thinking; the main transcript shows one line per action
  (`▸ read src/app.ts`, `▸ review_bash: git log -5`) plus the `REVIEW SUMMARY`
  card. `ToolExecutionEndEvent` carries no args, so `ReviewTranscript` keeps a
  `toolCallId → label` map so the end line repeats the start's header.
- Tests: new `permissions.test.ts` (matrix + role resolution + `subagentEnv`);
  `review.test.ts` updated for the header-only stream and the optional timeout;
  `review-ui.test.ts` covers legacy `thinking` lines.

### Changed — Review Mode is sequential and lives in the main transcript

- **Sequential only.** The reviewer starts when Plan Mode finishes (during the handoff),
  never in parallel. There is no interleaving, so the Plan and Review transcripts cannot
  overlap. The `parallel` setting is gone.
- **Main-transcript UI.** The reviewer's stream is rendered into Pi's normal transcript
  as colored mode bands (`▌ PLAN MODE` / `▌ REVIEW MODE` / `▌ REVIEW DONE`) plus a live,
  coalesced reviewer stream and a `▌ REVIEW SUMMARY` card on submission. These are
  display-only custom entries (`pi.appendEntry` + `registerEntryRenderer`): durable in
  the TUI and absent from LLM context.
- **Input follows the active mode.** A prompt typed while a review round is running is
  delivered to the reviewer (steered mid-pass) and echoed as `you → reviewer`; otherwise
  it goes to the plan agent. Delivery failures fall through — messages are never swallowed.
- **No per-mode interaction.** No pane focus, no pane keys, no pane questionnaires.

### Changed — mode switching is silent

- **Tab cycling writes nothing to the transcript.** `ctx.ui.notify(msg, "info")` is not a
  toast — Pi renders it as a status line inside the chat — and the `▌ PLAN MODE` band that was
  appended on every Plan-mode entry broke Pi's status-line dedupe, so each cycle left a fresh
  `Workflow plan: model → …` line plus a band. Tab / `Ctrl+Alt+P` now thread a `quiet` flag
  through the mode setters and model application; the footer status is the only confirmation.
- **`▌ PLAN MODE` bands are gone.** The footer already shows the mode; only `▌ REVIEW MODE` /
  `▌ REVIEW DONE` mark the audit, and consecutive identical bands are suppressed (the gate is
  seeded from the newest band on reload). Historical `▌ PLAN MODE` entries still render.
- **Explicit commands keep one confirmation.** `/plan`, `/build`, `/default` (and `/workflow`)
  notify once; warnings (unresolved role, model missing from the registry, switch failure) are
  never suppressed.
- **No-op model switches are silent.** When the target model is already active the switch is
  skipped; a changed thinking level is still applied.

### Removed

- **Review Workspace overlay** (`review-pane.ts`, `pane-controller.ts`, `pane-keys.ts`)
  and its `/review-pane` command + `Ctrl+Shift+R` shortcut.
- Pane-only settings: `parallel`, `autoOpenPane`, `paneEnabled`, `reserveRows` (unknown
  keys in existing settings files are ignored).
- Pane-only utilities in `utils.ts` (ANSI column layout and dock-row estimation).

Tests: `pane.test.ts` removed; new `review-ui.test.ts` covers the buffer, formatters and
renderers; `review.test.ts` adds the input-routing truth table and runtime streaming tests.

## [0.3.1] - 2026-09-20

- No user-facing changes recorded.

## [0.3.0] - 2026-09-18

### Added — Review Mode

A second, independent reviewer agent that supervises Plan Mode. Off by default;
when disabled the plan/build flow is unchanged.

- **Parallel reviewer session** — an in-process child Pi session (`createAgentSession`)
  with its own context, its own model and its own system prompt. It reuses Plan
  Mode's pruned conversation and never writes into the parent's history.
  Isolation: `DefaultResourceLoader({ noExtensions: true })` so the child cannot
  load this extension again (no recursion), plus its own `ModelRuntime` and an
  in-memory session (no session file on disk).
- **`reviewer` built-in role** — seeded with a *different* model from the planner
  so the review brings a genuinely independent perspective (`/role` to change it).
- **Read-only by construction** — the reviewer gets `read`/`grep`/`find`/`ls` and
  exactly three custom tools: `review_bash` (gated by the same `isSafeCommand`
  allowlist Plan Mode uses), `review_explore` (read-only subagents on the explorer
  role, budget-capped) and `review_submit_plan` (the single write path). The
  built-in `bash`/`edit`/`write` tools are never given to it.
- **Review + self-verify** — pass 1 reviews and rewrites; pass 2 re-reads the
  original and asserts that every accepted finding was addressed and that no
  requirement was silently dropped.
- **Visible change log** — every rewrite is submitted with a generated
  `## Review changes` appendix (tiered Critical/Important/Minor, with
  file:line, severity, confidence and rationale) so the user can see exactly
  what changed and why.
- **Dual-pane Review Workspace** — a persistent two-column pane: Plan Mode
  transcript on the left, reviewer transcript on the right, each with independent
  scrolling. Non-capturing, so Pi's prompt box stays usable; see *Changed* below.
- **Commands** — `/review-mode on|off|status`, `/review-prompt`, `/review-pane`,
  `/review-status`, `/review`.
- **Settings** — `workflow.reviewMode.{enabled,parallel,rounds,passes,verify,autoOpenPane,paneEnabled,reserveRows,fallbackOnError,exploreBudget,timeoutMs}`.
- **Reviewer guidance** — `.pi/review-prompt.md` (project) or
  `~/.pi/agent/review-prompt.md` (global), defaulting to the built-in prompt that
  asks the reviewer to align with the existing framework and industry best practice.
- **Never blocks the plan** — every failure path (missing model, unauth'd
  provider, session error, timeout, abort) returns the author's plan unchanged
  with a warning. No round can hang: each pass is bounded by `timeoutMs`.

### Changed — the Review Workspace pane

The pane was a focus-stealing, full-height overlay: it covered the prompt box and
footer, and because it captured the keyboard the only way to talk to the agent
was to close it. It is now a persistent, non-capturing workspace.

- **It never takes focus.** The overlay is `nonCapturing`, so Pi's prompt box
  keeps the keyboard; pane keys arrive out-of-band through
  `ctx.ui.onTerminalInput`, which runs *before* the focused component. You can
  type to the agent without leaving the pane.
- **The prompt and footer stay visible.** The pane reserves Pi's dock height via
  `margin.bottom` rather than taking the whole terminal, and sizes itself from the
  overlay's reported bounds. On a terminal too short to show it without crowding
  the prompt, the pane hides itself and says why.
- **The focused column is the routing target.** Plan focused → the plan agent, as
  before. Review focused → the reviewer's session (steered if mid-pass), mirrored
  into the right column as `you → review`; the footer shows `⟨plan⟩`/`⟨review⟩`.
  If Review is focused with no live reviewer session, the message is **not**
  swallowed: it falls through to the plan agent with a warning.
- **All pane keys are `Ctrl+Alt+` chords** (`←`/`→` focus, `↑`/`↓` scroll,
  `PgUp`/`PgDn` page, `Home`/`End` ends, `F` follow, `C` collapse, `X` abort).
  The previous vocabulary used bare `↑`/`↓`, `g`, `f`, `c`, `x` — which, in a
  non-capturing pane, would have silently broken typing, cursor movement and
  prompt history. `Ctrl+Left`/`Ctrl+Right` are left to editor word-cursor
  movement, and `Esc` stays Pi's interrupt.
- **The pane is persistent** while Review Mode is on; `Ctrl+Shift+R` hides or
  shows it without leaving the mode. It is torn down on approve, build,
  `/review-mode off` and session shutdown.
- **Resize-safe.** Pi resolves overlay options once, at show time, so a height
  change re-shows the pane with a corrected reservation. All user-visible state
  (scroll offsets, focus, pending interactions) lives outside the component and
  survives the re-show.
- **New settings** — `workflow.reviewMode.paneEnabled` and
  `workflow.reviewMode.reserveRows` (`"auto"` or an explicit row count).

No Pi core files are modified and no pi-tui internals are patched: `nonCapturing`,
`margin`, `visible()`, `getBounds()` and `onTerminalInput` are all public APIs,
and `getBounds()` is feature-detected because it only exists in pi-tui >= 0.85
while this package pins 0.84.4.

### Tests

- 45 new unit/integration tests (`review.test.ts`): config and prompt
  resolution, plan hashing, changelog rendering and idempotence, submission
  validation (stub/heading/length guards), context pruning, ANSI-aware column
  composition, finding sanitisation, the pass gate, child-session isolation, and
  the whole orchestrator against a fake SDK (including the timeout fallback).
- The suite now also asserts the no-regression guarantee: with Review Mode off,
  all resolution stays inert.

### Fixed

- `tsconfig.json` only included four files, so `npm run typecheck` silently
  ignored the new modules. The include list now covers every source file.
- `validateReviewedPlan`'s length guard was a symmetric ±60% window, which
  rejected exactly the reviews doing their job: adding missing coverage
  (requirement-coverage findings) and removing bloat (simplicity findings). The
  bounds are now deliberately generous and asymmetric (0.25×–4×) so only real
  catastrophes — a stub, or a pasted document — are rejected.

## [0.2.0] - 2026-09-16

Initial release.

## [0.1.0] - 2026-09-16

Initial release.
