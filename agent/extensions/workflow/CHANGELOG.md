# Changelog

All notable changes to this package are documented in this file.

## [Unreleased]

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

## [0.3.1] - 2026-09-20

- No user-facing changes recorded.

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
