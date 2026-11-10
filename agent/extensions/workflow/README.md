# @dieulc/workflow

Plan↔Build mode with an independent **Review Mode** reviewer, questionnaire, subagent explore, todos and shadow-checkpoint rewind for Pi.

## Features

- **Plan / Build duality** — `Plan` tool gating (`edit`/`write` blocked in plan), `Build` restores full tools; **Tab** completes the highlighted suggestion while a list is open and otherwise cycles Plan → Build → Default (`Ctrl+Alt+P` always cycles), `--workflow-plan` flag
- **Review Mode** — an independent reviewer agent that runs **after** Plan Mode finishes (sequential — never in parallel), in its own in-process session. It audits the plan, rewrites it, streams its work into the main transcript, and hands the result to Plannotator. Off by default; see [Review Mode](#review-mode) below.
- **Questionnaire** — 1–4 questions with headers/options, dedup freeform aliases, and an inline `↳ Your answer:` editor. Rendered as a bounded bottom-sheet overlay: a short question and the choices stay pinned, while a long question or the optional `context` body (e.g. a proposed commit message) scrolls with the wheel, `PgUp`/`PgDn` or `Ctrl+U`/`Ctrl+D`. The freeform editor takes the pane while typing.
- **Explore (subagents)** — parallel `pi --mode json` subagents (`max 8`, concurrency 4), `session_shutdown` kill, `activeSubagents`
- **Todos** — plan-faithful todo list (global step refs + statuses + phase groups) that persists across Plan/Build/Default modes. `workflow_todo` (`list/update/done/pending/add/toggle/sync/clear`) with industry-style wholesale `update` (send the COMPLETE list; omitted items are removed) plus idempotent `done`/`pending`, lenient `[DONE:<ref>]` markers, throttled Claude-Code-style reminders, a tool-result footer, and a stale ⚠ notice — but **no forced turns and no heuristic auto-completion** (reference: Claude Code / OpenCode / Codex practice).
- **Rewind** — shadow bare-repo checkpoints per cwd (`agent/checkpoints/checkpoint-<slug>.git`), `isDirty` + `createSafetySnapshot` + `restoreCode`
- **Plannotator bridge** — `plannotator:request/review-result/plan-approved` events, inline markdown handoff (`ScrollView` → inline scrollback), `getUtcDatePrefix` / `normalizePlanPath` for `.pi/plans/<UTC-date>-<slug>.md`
- **Model roles** — Planner/Explorer/Builder roles with one model + thinking level each (`roles.ts`, `~/.pi/agent/roles.json` v2). `/plan` switches to the planner model, `/build` to the builder model, `explore` subagents use the explorer model. `/role` opens a tabbed picker (scoped models first, `Ctrl+O` for all). The thinking list follows the selected model's `thinkingLevelMap`; unsupported stored levels are clamped on save/activation with a warning.
- **Write permission** — a user-controlled `allow`/`ask`/`never` permission for file writes in **Default** mode, the mode that is otherwise ungated. `/write-policy` sets it; see [Write permission](#write-permission) below.
- **Model profiles** — named combinations of role models (`profiles.ts`, `~/.pi/agent/profiles.json` v1). Create a profile per provider or per budget, switch with `/profile` — activation is session-scoped, so two concurrent sessions can run different profiles. With no profile active the roles.json flow applies unchanged. See [Model Profiles](#model-profiles).

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
| `/todos` | Show todo list |
| `/btw` | Queue note for next turn |
| `/role` | Config screen: one model + thinking per role (planner/explorer/builder/reviewer tabs, custom roles included; type to filter models by `provider/id` or display name). CLI: `list`, `set <role> <provider/model> [thinking]`, `use <role\|auto>`, `add/remove/reset` |
| `/profile` | Switch or manage model profiles (named role-model combinations). Picker: activate / edit / rename / delete / New profile… / Default… (fuzzy type-to-filter; completed actions close the picker). CLI: `list`, `show <name>`, `use <name\|none>`, `create <name>`, `edit <name>`, `rename <old> <new>`, `delete <name>`, `default [name\|none] [global\|project]`, `retarget-provider <old> <new> [global\|project] [--apply]` |
| `/review-mode [on\|off] [global\|project]` | Enable/disable Review Mode (default `off`). `status` prints the effective config, naming the settings file that supplied the timeout |
| `/review-mode timeout <seconds\|unlimited> [global\|project]` | Set or show the per-pass time cap (`unlimited`/`0` = no cap). Writes to global settings by default |
| `/review-prompt [global]` | Edit the reviewer's guidance (defaults to "align with the existing framework and industry best practice") |
| `/review-status` | Show review phase, model, plan hash, findings and any error |
| `/review [path]` | Run a one-shot review round now. Without a path it uses this run's plan write, then the session's latest plan write; works with Review Mode on or off (mode stays OFF). An explicit path must be under `.pi/plans/` |
| `/commit` | Commit staged changes with an AI-summarized message (`-a`: stage tracked changes first). Confirmation-gated; the confirmation arms the commit exemption for that run |
| `/commit-policy [never\|ask\|allow] [global\|project]` | View or set the commit policy (default `never`: the agent cannot `git add`/`commit`/`push` — you commit, or use `/commit`) |
| `/write-policy [allow\|ask\|never] [global\|project]` | View or set the write permission for Default mode (default `allow`: the agent writes freely; `ask` prompts per write; `never` blocks writes — see [Write permission](#write-permission)) |
| `/permissions [explain] <command>` | Explain a shell command's verdict without running it: each segment's class, the Plan/Review/Explorer answer and whether the write policy would treat it as a write |

Mode commands (`/plan`, `/build`, `/default`) and the `Tab` / `Ctrl+Alt+P` shortcuts are refused while a review round or a paused review owns the turn (Tab still completes a visible suggestion list); see [Controlling a running review](#controlling-a-running-review).

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
- **`/role` keeps editing the base roles.** With a profile active, the `/role` picker shows a notice and `/role list` prints the profile's overrides; `/profile edit <name>` is the way to change what actually runs.
- **Fallback**: no profiles (or none active) → the roles.json flow, identical to before profiles existed. A profile referencing a model missing from the registry is warned about at save time and refused at switch time ("staying on current model"), same as `/role`.

**Picker keys**: `/profile` and `/role` are fuzzy-filterable — start typing to narrow models by `provider/id` or display name (e.g. `flash`, `open/beam`, `muse spark`) and profiles by name, marker, description or one of their models. `↑`/`↓` navigate, `Enter` selects/commits (inert when nothing matches), `Tab`/`←`/`→` switch role tabs, and `Ctrl+O` toggles scoped ↔ all while keeping the filter. `Esc` (or `Ctrl+C`) clears a non-empty filter first; a second press backs out or cancels. A completed `/profile` action closes the overlay; Esc-cancel, a failed save and the action menu's Back keep the profile list open, with its filter remembered.

**Why**: mix models from different providers in one workflow (frontier planner + cheap explorer), keep one profile per provider to control budget per provider, run concurrent sessions on different providers to work around per-provider concurrency limits, and exploit cheaper starter plans across several providers.

Profile config lives in `~/.pi/agent/profiles.json` v1 (user) with optional per-project override at `<cwd>/.pi/profiles.json` (per-profile replace, project wins). Names are case-insensitively unique, ≤ 40 chars, no whitespace (keep them CLI-addressable), and `none`/`auto`/`off` are reserved (`off` is a `/profile use` deactivate keyword, so a profile can never be named it). A missing file is the normal empty state; a corrupt or wrong-version file is never rewritten (warning + in-memory empty config).

**Argument completion** follows pi's full-argument contract (the same one pi's `/mcp` uses): accepting a suggestion replaces the entire typed argument text, so completing `/profile use Syn-␣` inserts `/profile use Syn-Deepseek-…` with the subcommand intact — it never collapses to `/profile <name>`. The dropdown closes (and the first Enter submits) once the typed token is already an exact, unique match. This applies positionally to `/profile` (`use|edit|show|delete|rename <old>|default <name> [global|project]`), `/commit-policy` (`never|ask|allow [global|project]`) and `/role` (`set <role> <provider/model> [thinking]`, `use <role|auto>`, `remove <name>`).

## Review Mode

An independent second agent audits the plan before the handoff renders. The handoff waits for the gated round; the reviewed plan (the reviewer writes the plan file mid-round) is what you see, and the todo steps are re-synced to match. The reviewer runs in its own child session, so Plan Mode and Build Mode never see its prompt, findings or transcript.

```text
Plan Mode (main session) ──plan file──▶ Review Mode (child session, gated)
                                              │ rewrites the plan file
                                              ▼
                                   handoff renders the reviewed plan
                                              ▼
        Plannotator webview ◀── plan file + `## Review changes`
                │ approve ──▶ Build Mode (review activity suspends, session stays warm)
                └─ feedback ──▶ Plan Mode revises ──▶ Review re-reviews
```

- **Approve** in Plannotator → Build mode; review activity suspends but the reviewer session stays warm for the next round.
- **Feedback** → Plan revises, Review re-reviews the revision, Plannotator reopens.
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

The model is **snapshotted when a round starts**: a `/role` or `/profile` switch mid-round takes effect **next round**, never mid-pass. The mode band, the status widget and `/review-status` name the snapshotted model — the one actually auditing.

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
| `review_submit_plan` | The **only** write path: validates and saves the revised plan to Plan Mode's own `.pi/plans/<UTC-date>-<slug>.md`. Also the one-shot path for short plans |
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

### Chunked rewrite submission

A plan rewrite is the one response in the flow that can be longer than a provider gateway allows a
stream to live. Nothing is written until a submission succeeds, so a cut mid-response loses the
whole rewrite and burns the round. Chunking makes the rewrite survive that:

1. `review_plan_begin` (optionally with `totalChunks`) resets the assembler.
2. `review_plan_chunk` appends `index` 1, 2, 3, … — each at most `chunkChars` characters. A
   rejected chunk (out of order, repeated, oversized, or cut before it arrived) is answered with
   the index the assembler expects next, so the retry continues **without restarting**: already
   accepted chunks are kept. Calling `review_plan_begin` again is the explicit "throw it away" move.
3. `review_plan_finalize` validates completeness (`totalChunks`, when declared) and calls the same
   submit funnel the one-shot path uses — `writePlan` stays the single writer and the review gate
   is notified exactly once.

Pass 1 asks for the chunked protocol when `chunkChars > 0` **and** the plan is longer than
`chunkChars × 2`; shorter plans keep the one-shot `review_submit_plan`. `chunkedSubmit: "off"` or
`chunkChars: 0` disables chunking entirely (the runtime then refuses `review_plan_begin`). Pass 2
reads the assembled rewrite and its diff, so a chunked pass 1 feeds the self-verify pass unchanged.
On abort, teardown, a new round or a provider switch the assembler is cleared, so a partial rewrite
can never be stitched onto a different attempt.

The child session is created with an explicit tool allowlist: the read-only built-ins **plus every reviewer tool above**. That union is load-bearing — Pi's `createAgentSession({ tools })` option is a *global* allowlist that filters custom tools too, so a built-ins-only list silently removes `review_submit_plan` and makes every review end in a fallback. The runtime therefore reads `getActiveToolNames()` straight after creation and refuses the session (naming the missing tools) rather than starting a review that cannot succeed; the active tool set is also logged once per session.

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

Mode changes are reported by Pi's **footer status** (`⏸ plan` / `▶ build`, plus todo progress): switching with **Tab** or `Ctrl+Alt+P` is silent and adds nothing to the transcript, while `/plan`, `/build` and `/default` print a single confirmation line.

**Tab precedence.** While the input's suggestion list is open (commands, `@files`, `#documents`), **Tab** applies the highlighted item and leaves the mode alone. With no list open, the workflow's `tab` shortcut cycles Plan → Build → Default. `Ctrl+Alt+P` always cycles. This matches Pi Desktop; it requires `tui.input.tab` to stay bound (the default is `tab`), because a disabled binding leaves nothing for the editor to accept. The one exception is a live review: mode switching is refused with a notice (see [Controlling a running review](#controlling-a-running-review)). Only the review phase adds bands, and the reviewer's stream is rendered in the review color:

| Entry | Color | Meaning |
| --- | --- | --- |
| `▌ REVIEW MODE` | accent | A review round is running (round + model shown). A resumed round reads `resumed · round N · model` instead of `sequential audit` |
| `▌ REVIEW PAUSED` | warning | The round stopped for a pause — `/review-resume` continues it, `/review-abort` discards it |
| action headers | muted | One line per reviewer tool call with its key argument (`▸ read src/app.ts`, `▸ review_bash: git log -5`). Assistant prose and thinking are not streamed, so the transcript stays close to Plan Mode's; status lines are muted |
| `▌ REVIEW DONE` | success / warning | Round finished, with the verdict or the fallback reason |
| `▌ REVIEW SUMMARY` | success / warning | The submitted plan's verdict, plan path and findings (severity-colored) |

These are **display-only custom entries** (`pi.appendEntry` + `pi.registerEntryRenderer`): they are durable in the transcript and survive `/reload`, but they never enter the LLM context, so Plan Mode and Build Mode cannot see the reviewer's work. Consecutive identical bands are suppressed (the gate is seeded from the newest band on reload, and a resumed/paused band is never treated as identical to the band it follows), so cycling modes or re-running a review cannot grow the transcript. Long reviews are coalesced (flushed roughly every 400 ms, and always flushed before a band) and capped, with a one-line notice pointing at `/review-status` when output is truncated.

**Run narration.** The run-start line is emitted by the harness at the moment it sends the prompt, so a resume cannot masquerade as a fresh start: `reviewer started` (a reviewer session was created), `reviewer resumed` (a paused round continues on the warm session), `reviewer continuing` (a later round reuses the session), `reviewer restarting — new reviewer session` (a reviewer-model switch forced a reboot) and `reviewer verifying — pass 2`. A run ends with `reviewer run ended`.

#### Where your next message goes

Input follows the **active mode**, decided automatically — there is nothing to focus or toggle:

- **Plan Mode** → the message goes to the plan agent.
- **Review Mode** (a review round is in flight) → plain chat **stays with the plan agent**. Use `/review say <message>` to steer the in-flight reviewer explicitly (echoed as `you → reviewer`); `/btw <note>` always queues a note for the next turn, even mid-review.
- **Neither** (including while the plan sits in Plannotator) → the message goes to the plan agent, so you can still refine the plan.

Delivery to the reviewer is best-effort: if it fails, the message stays in the plan-agent chat rather than being swallowed.

**Status line.** While a review is running, the footer status carries a review segment alongside the mode (`⏸ plan … · 🔍 review · pass 2/2 · 3 findings · ● verifying`), the widget above the editor shows the same live phase, and the spinner row reads `🔍 Reviewing plan…`. Pausing switches both to the paused form (`🔍 review paused — /review-resume to continue`); resuming returns them to the running form. The line is **live-only**: it disappears as soon as the round lands, fails or is aborted, and on a mode switch — Plan/Build never keeps a stale `🔍 review … aborted` line. A retained terminal state is also hidden during a new round's cold boot, and a pause from an earlier plan cycle is ignored. Starting a new prompt (or an explicit refine/deny) abandons a paused review and clears both the review line and `🔒 modes locked`. `/review-status` still reports the last round's result.

### Controlling a running review

The handoff **waits for the reviewer**: no browser prompt or inline choice renders until the gated round lands, fails, or you pause/abort it. The reviewed plan (the reviewer writes the plan file mid-round) becomes the handed-off text, with the todo steps re-synced to match. A broken reviewer never blocks the plan — the author's draft is handed over with a warning instead.

A handoff opens **only when the current run writes or edits a `.pi/plans/` file while Plan mode is active**. A mid-run switch into Plan counts — the write after the switch is eligible. A plan written before the switch does not auto-handoff: the extension shows `Plan file ready: <path>. Run /review to audit it.` and leaves the plan for the manual command. Switching Build → Plan keeps the previous plan and todos as reference; a fresh prompt also supersedes any pending browser/inline handoff prompt, and a stale browser approval/denial from a previous plan is ignored.

**Review cycles.** The round budget (`rounds`) is per plan/feedback cycle, not per session. A fresh prompt, an explicit inline `Refine` or browser `Deny`, a different plan-file path, and entering Build all start a new cycle, so a second plan in the same session still gets reviewed with the default `rounds: 1`. Findings carry across a refinement of the same plan file and are cleared for a new plan file. A fresh prompt **abandons** a paused review: the old round is stopped, its open handoff gate settles with the author's plan, and the footer/lock clear. The old handoff cannot render or apply a plan after the new cycle starts.

A paused review is in-memory and belongs to the cycle that recorded it: it cannot keep `🔒 modes locked` alive or short-circuit the next plan's review after a new prompt.

`/review` resolves its target independently of the handoff, so a plan is never unreachable because of how Plan mode was entered: explicit path → this run's last plan write → the session's last plan write → the last handed-off plan → the newest plan write in the session branch. Missing, empty or unreadable candidates are skipped; the resolved path is named when it came from a fallback; the reviewer writes back to that same file. With no candidate it lists the newest `.pi/plans/*.md` files and the explicit-path syntax. `/review <path>` is restricted to `.pi/plans/`.

**Manual handoff and later rounds.** A settled manual `/review` opens Plannotator with the reviewed plan, even with automatic Review Mode off. In Default/Build, Approve enters Build and Deny switches to Plan before sending feedback. The manual cycle keeps re-reviewing and re-handing off after a Deny until Approve, a fresh prompt or Build. Every new round supersedes an older pending browser gate, so round 2 and later always reopen the current plan; a stale Deny arriving during a round is discarded. After `reload`/`resume`/`fork`, the replacement session asks Plannotator `review-status`: a matching pending review keeps its gate, a completed decision is applied, and a missing/changed review is cleared with a reason. Desktop brings a notification review tab to the front and reloads an existing same-URL review tab; tool-result localhost URLs stay in the background.

- **Mode switching is locked** from the moment a review round starts (including the cold boot) until it lands, fails, or is aborted, and for the whole paused state. `Tab` (when no suggestion list is open), `Ctrl+Alt+P`, `/plan`, `/build`, `/default`, browser approve and external plan-mode changes are refused with one notice, and the footer shows `🔒 modes locked`. `/review-abort` and `/review-mode off` end the lock; the post-review handoff prompt is intentionally unlocked because the independent reviewer has finished.
- **ESC** pauses the round **everywhere it is active** — while the gated handoff waits, while a manual round runs, with no prompt on screen at all. One long-lived terminal listener maps it to `/review-pause` semantics (warm session kept) and stays registered through the paused window: a second ESC while a gated review is paused is swallowed with a hint instead of aborting the parked plan turn (that abort used to poison the turn's signal and stall every `/review-resume`). With no review owning the turn it passes ESC through, so the editor, questionnaire and handoff selector keep it. Headless/RPC hosts have no listener and keep `/review-abort` as their stop path.
- `/review-pause` is the same pause as a command. Pausing mid-handoff does **not** render the handoff — the gate stays open until you resume or abort.
- `/review-resume` continues the paused round on the warm session (or starts a fresh round if the plan changed since the pause), and settles the waiting handoff with the result. A resumed round is **running** again — the notice/footer return to the running form, and a second ESC can pause it. It runs on a fresh controller and deliberately does **not** inherit the parked turn's signal, so an interrupted parent turn cannot instantly re-abort every resume; ESC, `/review-pause` and `/review-abort` are its stop paths. The transcript says so explicitly (`▌ REVIEW MODE  resumed · round N · model` followed by `reviewer resumed`). A rewrite the reviewer wrote to the plan file before the pause is **not** mistaken for an edit of yours: resume compares the file against a hash snapshot taken at pause time (refreshed when the round settles), so only a change made after the pause starts a fresh round. Its notice names the real outcome (rewritten, unchanged, paused, aborted, skipped or fallback).
- `/review-abort` stops the round — or discards a paused one — and, when a handoff is waiting, **hands off the author's plan immediately** so the plan is always delivered. The aborted revision is not auto-reviewed again until the plan changes. It also releases the mode-switch lock immediately.
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

| Mode | Meaning |
| --- | --- |
| `never` (default) | `git add` / `git commit` / `git push` are blocked with a policy reason that tells the model to leave changes uncommitted for review |
| `ask` | The agent may commit; every `git commit` / `git push` pops an Allow once / Deny dialog (headless sessions fail closed). `git add` stays free — staging alone pollutes nothing |
| `allow` | **Automatic per-step commits.** While a plan todo list is active the extension itself makes exactly **one commit per completed step** (at the `workflow_todo` completion boundary, before the model starts the next step; subject `step N: <step text>`), and the model cannot run `git add`/`commit`/`push` at all. Outside a plan (no todos) the model may commit as before. `/commit` always works |

The status line always shows the active policy (`▶ build 2/5 · commits:never`), so you can see at a glance what the agent may do to history.

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

`workflow.writePolicy` closes that gap. It is a **user-controlled permission**, enforced where the tools execute (not in prose — prompt rules are soft and get ignored), and it applies to **Default mode only**:

| Mode | Meaning |
| --- | --- |
| `allow` (default) | The agent writes files freely — today's behaviour, and the shipped default so existing installs are unaffected |
| `ask` | Writes pop a dialog: **Allow once (this turn)** / **Always allow …** (*this path*, *these paths*, *this command*, *these commands*) / **Deny** / **Deny with instructions…**. One dialog covers a whole turn and lists the writes it covers; a permanent grant is remembered, so the same target stops asking |
| `never` | The agent may not modify your files (`.pi/plans/` excepted). You apply the changes, or the user switches to `/build` for the approved-execution path |

The status line always shows the active permission (`◦ commits:never · writes:ask`), so you can see at a glance what the agent may touch.

### What is gated

- The `edit` and `write` tools.
- `bash` commands that may modify files. A command is treated as a write when it is **not provably read-only**: a file redirect (`>`, `>>`), a heredoc or command substitution, a command outside the read-only/verify allowlist (`rm`, `mv`, `cp`, `sed`, `awk`, `npm install`, `git checkout`, interpreters, unknown binaries …), or a write flag on an otherwise-safe command (`eslint --fix`). Read-only commands (`ls`, `cat`, `rg`, `git status`, `npm test`, `tsc --noEmit`) and harmless redirections (`2>/dev/null`, `2>&1`) stay free. Only an **unquoted** redirect or expansion counts: `rg -n 'a > b' docs` and `rg -n "rm -rf" src` are read-only, so `ask` never prompts for them.
- **`sed` and `awk` are gated as potential writes whatever their flags** — their programs are code (GNU sed's `e` command runs a shell command and its `w` command writes a file; awk can `system()` or redirect), so a plain `sed -n '…p' file` asks too. To inspect a file without a prompt use `rg` / `head` / `tail` / `cut` / `column` / `jq`, or the `read` tool — or pick **Always allow this command** to grant that one command permanently.
- `powershell` is always treated as a write — it cannot be classified by the POSIX allowlist, so it fails closed.

`git add` / `git commit` / `git push` are **not** treated as file writes: they touch the index and the object store, not your working tree, and the independent [commit policy](#commit-policy) already governs them.

### Scope and carve-outs

- **Default mode only.** Plan mode keeps its stricter read-only rules (writes only to `.pi/plans/`), and Build mode stays the deliberate "go ahead" escape hatch.
- **Subagents are unaffected.** A spawned child carries `PI_WORKFLOW_ROLE` and is already read-only through the role gate — and it has no UI to answer a prompt with.
- **`.pi/plans/` writes stay allowed** in every mode, so a session that leaves Plan mode mid-flow is not stranded.
- **Third-party write tools need opting in.** `ast_grep_replace` (pi-lens) rewrites files, and the `office_*` tools (pi-office-protocol) write documents; neither is covered by the built-in scope. List them in `mutatingTools` to gate them (see below).

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

Review Mode settings live under `workflow.reviewMode`:

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `false` | Automatic-review toggle. When false, the handoff review/prefetch/planner note are off; the manual `/review*` commands still work |
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

`"reviewMode": true` is accepted as shorthand for `{ "enabled": true }`.

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

## How it works

See `index.ts`, `checkpoint.ts` (shadow bare-repo), `commit-policy.ts` (commit policy config, coercion, the `/commit` prompt and write — no runtime imports, unit-testable), `questionnaire-layout.ts` (pure questionnaire viewport/scroll geometry), `questionnaire-view.ts` (the bounded bottom-sheet questionnaire view), `edit-policy.ts` (write-policy config, coercion, path/command matching, the decision table, and the guided-denial helpers — no runtime imports, unit-testable), `permissions.ts` (shell-command mutation classification), `utils.ts` (safe-command gating, todo/plan extraction, plan hashing), `roles.ts` (role registry, one model per role), `profiles.ts` (profile registry, the model overlay and the `workflow.defaultProfile` setting — no Pi runtime needed, unit-testable), `provider-retarget.ts` (guarded, backed-up `provider` ref migration for profiles/roles — pure document rewrite plus a two-phase file apply), `picker.ts` (the fuzzy-filterable picker primitives), and the Review Mode modules: `review.ts` (config, prompt, state, transcript, child session — no runtime imports, so it is unit-testable), `review-providers.ts` (parent→reviewer provider seeding and the provider-agnostic auth preflight), `review-tools.ts` (the reviewer's tool set), `review-runtime.ts` (round orchestration), `review-ui.ts` (the main-transcript entries: line buffer, formatters, renderers), `review-handoff.ts` (pure pending-gate correlation, supersede and reload-recovery decisions). Hot-reload via `/reload` when placed in `~/.pi/agent/extensions/workflow/` or loaded via `pi.extensions` manifest.

### Todo protocol (industry-aligned)

- **Canonical refs**: every todo row is numbered **globally** `1..N`; those numbers are the only refs the model ever needs. Refs are canonical positions — they are recomputed as `1..N` after every mutation (plan merge, `update`, session restore), so the pinned widget, handoff messages, tool output and `workflow_todo` refs always show the same numbers (no 11–20 drift). The plan's per-phase labels (e.g. `Phase B: 1..3`) are preserved only as display metadata (`(plan label B2)`). Integer refs resolve by canonical `ref` → positional `step` → unique `label`; the resolver also accepts `Group/Label`, `Label@Group`, `#N` and unique text (≥8 chars).
- **States**: `pending` → `in_progress` → `completed` (+ `cancelled`). Exactly one `in_progress` at a time (the harness normalizes extras). `completed` is kept as a derived legacy field for old sessions/external readers.
- **Update**: `workflow_todo {action:"update", todos:[{ref?, text?, status?}]}` replaces the whole list — TodoWrite/todowrite/update_plan semantics. A `ref` is resolved by canonical ref, then normalized text, then leniently by plan label / group-qualified ref / unique text; a ref that had to be resolved leniently (or matched nothing and was added) is reported under `Warnings:` in the tool result. `done`/`pending` are idempotent single-item sets; `toggle` is a convenience flip; `add` appends an ad-hoc item; `sync` re-extracts the plan file, matches steps by exact text then by plan label (so model-rewritten wording reunites instead of duplicating), **preserves agent-added items** (reported as `kept N agent-added`) and never un-completes (status rank merge); `clear` empties.
- **Reminder cadence** (Claude Code-style throttle): a hidden `[TODO LIST]` context block is injected only when `turnsSinceLastTodoWrite ≥ TURNS_SINCE_WRITE` **and** `turnsSinceLastReminder ≥ TURNS_BETWEEN_REMINDERS` (`=3`). Unresolved `[DONE:…]` refs from the previous turn bypass the throttle once so the model learns the right numbers. A one-line `[TODO …]` footer is appended to the first successful `edit`/`write`/`bash` result of each turn.
- **Stale notice (no forced turns)**: if a run mutated files but recorded no todo progress, the user gets one `⚠` status marker + a `ctx.ui.notify` (30 s dedupe); plan-file `- [x]` ticks are reconciled at `agent_end` in all modes, skipped when the plan content is unchanged (path+hash guard). No auto-completion — the list is never marked done based on intent. Legacy lists that already contain duplicate rows are not auto-merged; run `/todos clear` (or approve a new plan) to reset.

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

## Development

```bash
cd agent/extensions/workflow
npm install
npm run typecheck   # tsc --noEmit (covers every source file, including the review modules)
npm test            # node --test utils.todo.test.ts permissions.test.ts shell-text.test.ts roles.test.ts profiles.test.ts provider-retarget.test.ts thinking-levels.test.ts workflow-status.test.ts picker.test.ts questionnaire-layout.test.ts questionnaire-view.test.ts model-default.test.ts review.test.ts review-ui.test.ts extension.test.ts commit-policy.test.ts edit-policy.test.ts tab-policy.test.ts tab-editor.test.ts
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
