# @dieulc/workflow

Plan↔Build mode with an independent **Review Mode** reviewer, questionnaire, subagent explore, todos and shadow-checkpoint rewind for Pi.

## Features

- **Plan / Build duality** — `Plan` tool gating (`edit`/`write` blocked in plan), `Build` restores full tools; tab + `CtrlAlt+p` shortcuts, `--workflow-plan` flag
- **Review Mode** — an independent reviewer agent that runs **after** Plan Mode finishes (sequential — never in parallel), in its own in-process session. It audits the plan, rewrites it, streams its work into the main transcript, and hands the result to Plannotator. Off by default; see [Review Mode](#review-mode) below.
- **Questionnaire** — 1–4 questions with headers/options, dedup freeform aliases, inline `↳ Your answer:` editor
- **Explore (subagents)** — parallel `pi --mode json` subagents (`max 8`, concurrency 4), `session_shutdown` kill, `activeSubagents`
- **Todos** — plan-faithful todo list (global step refs + statuses + phase groups) that persists across Plan/Build/Default modes. `workflow_todo` (`list/update/done/pending/add/toggle/sync/clear`) with industry-style wholesale `update` (send the COMPLETE list; omitted items are removed) plus idempotent `done`/`pending`, lenient `[DONE:<ref>]` markers, throttled Claude-Code-style reminders, a tool-result footer, and a stale ⚠ notice — but **no forced turns and no heuristic auto-completion** (reference: Claude Code / OpenCode / Codex practice).
- **Rewind** — shadow bare-repo checkpoints per cwd (`agent/checkpoints/checkpoint-<slug>.git`), `isDirty` + `createSafetySnapshot` + `restoreCode`
- **Plannotator bridge** — `plannotator:request/review-result/plan-approved` events, inline markdown handoff (`ScrollView` → inline scrollback), `getUtcDatePrefix` / `normalizePlanPath` for `.pi/plans/<UTC-date>-<slug>.md`
- **Model roles** — Planner/Explorer/Builder roles with one model + thinking level each (`roles.ts`, `~/.pi/agent/roles.json` v2). `/plan` switches to the planner model, `/build` to the builder model, `explore` subagents use the explorer model. `/role` opens a tabbed picker (scoped models first, `Ctrl+O` for all).

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
| `/role` | Config screen: one model + thinking per role (planner/explorer/builder/reviewer tabs, custom roles included). CLI: `list`, `set <role> <provider/model> [thinking]`, `use <role\|auto>`, `add/remove/reset` |
| `/review-mode [on\|off] [global\|project]` | Enable/disable Review Mode (default `off`). `status` prints the effective config, naming the settings file that supplied the timeout |
| `/review-mode timeout <seconds\|unlimited> [global\|project]` | Set or show the per-pass time cap (`unlimited`/`0` = no cap). Writes to global settings by default |
| `/review-prompt [global]` | Edit the reviewer's guidance (defaults to "align with the existing framework and industry best practice") |
| `/review-status` | Show review phase, model, plan hash, findings and any error |
| `/review` | Run one review round against the current plan file now |

## Review Mode

An independent second agent supervises the plan before you see it. The flow is strictly **sequential**: Plan Mode finishes, then the reviewer runs, then the reviewed plan goes to Plannotator.

```text
Plan Mode (main session) ──plan file──▶ Review Mode (child session, sequential)
                                              │ rewrites the plan
                                              ▼
        Plannotator webview ◀── reviewed plan + `## Review changes`
                │ approve ──▶ Build Mode
                └─ feedback ──▶ Plan Mode revises ──▶ Review re-reviews
```

- **Approve** in Plannotator → Build mode; both Plan and Review shut down.
- **Feedback** → Plan revises, Review re-reviews the revision, Plannotator reopens.
- **Any failure** (missing model, unauth'd provider, abort, error) → the author's plan is handed over unchanged with a warning. Review Mode never blocks the plan. A pass whose run ends without a `review_submit_plan` submission fails *immediately* (the settle race), so a silent reviewer cannot hang the handoff even with no time cap. `timeoutMs` is **off by default (`0` = unlimited)**; set a positive value to re-enable the outer safety net, and a pass that outlives it is aborted — though a plan submitted before the deadline is always kept.

### Enabling

```text
/review-mode on              # global (~/.pi/agent/settings.json)
/review-mode on project      # this repo only (<cwd>/.pi/settings.json)
/review-mode status
/review-mode timeout unlimited   # remove the per-pass cap (global)
/review-mode timeout 600 project # 10-minute cap for this repo only
```

Turning the toggle off stops the reviewer and restores the single-agent plan/build flow exactly as it was. Nothing in Review Mode runs while it is disabled.

`/review-mode status` reflects what the current process loaded, so `/role` changes and extension edits are picked up on the next `/reload` (or a new session). After `/reload`, the reviewer model, the effective timeout and its settings file (and the absence of the old `flow` row) all reflect the current files on disk.

### The reviewer's model

Review Mode runs in its own session with its own model, taken from the **`reviewer` role** (`/role`). The default seed is deliberately a *different* model from the planner so the review brings an independent perspective — a reviewer that shares the planner's model and thinking tends to share its blind spots.

```text
/role set reviewer opencode-go/muse-spark-1.3-contributor xhigh
```

If the reviewer role has no model, Review Mode falls back to the planner model and warns rather than silently doing nothing.

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
| `review_bash` | Shell access on the same role policy Plan Mode uses: read-only inspection plus **test/lint/typecheck** runners (`npm test`, `npm run lint/typecheck`, `eslint`, `tsc --noEmit`, `node --test`, `pytest`, `cargo clippy`, …). No redirects, no `rm`/`mv`/`cp`/`mkdir`/`touch`, no `sudo`, no package installs, no builds, no `git add/commit/push` |
| `review_explore` | Read-only reconnaissance subagents on the **explorer** role's model, capped by `exploreBudget` per round |
| `review_submit_plan` | The **only** write path: validates and saves the revised plan to Plan Mode's own `.pi/plans/<UTC-date>-<slug>.md` |
| `review_pass_done` | Ends a pass with a verdict (refused if nothing was submitted) |

The policy classifies commands into three classes and maps them to roles:

| Role | Command class | Write tools | Used by |
| --- | --- | --- | --- |
| planner | read-only + verify | `.pi/plans/` only | Plan Mode |
| reviewer | read-only + verify | `review_submit_plan` only | Review Mode |
| explorer | read-only | none | `explore` / `review_explore` subagents |
| builder | full (unrestricted) | all | Build Mode / normal sessions |

- **read-only** — inspection only (`ls`, `cat`, `rg`, `git log/blame/ls-files`, `docker logs`, `journalctl`, …).
- **verify** — the above plus `npm test`, `npm run lint|typecheck|check`, `eslint`, `tsc --noEmit`, `node --test`, `pytest`, `mypy`, `go vet`, `cargo clippy`, … Runners that rewrite (`--fix`, `--write`, `-u`/`--update`, `--watch`) and build commands (`npm run build`) stay blocked.
- **full** — no gate (Builder and normal sessions only).

Compound commands are checked segment-by-segment with quote awareness, so `git status && npm test` and `npm test 2>&1 | tail -50` work while `curl … | sh`, `$(…)`, backticks, heredocs and file redirects are refused. Explorer subagents run as separate `pi` processes and carry their role in `PI_WORKFLOW_ROLE`, so the same policy gates their `bash` too. The `powershell` tool is refused for every non-builder role, since its syntax cannot be classified by the POSIX allowlist.

The built-in `bash`, `edit` and `write` tools are never given to the reviewer at all.

The child session is created with an explicit tool allowlist: the read-only built-ins **plus every reviewer tool above**. That union is load-bearing — Pi's `createAgentSession({ tools })` option is a *global* allowlist that filters custom tools too, so a built-ins-only list silently removes `review_submit_plan` and makes every review end in a fallback. The runtime therefore reads `getActiveToolNames()` straight after creation and refuses the session (naming the missing tools) rather than starting a review that cannot succeed; the active tool set is also logged once per session.

### Two passes

1. **Review + rewrite** — audits the plan against the repository and the guidance, records findings, submits the revised plan.
2. **Self-verify** — re-reads the original and the rewrite, confirms every accepted finding was actually addressed, and reports anything that was silently dropped. This pass exists because a rewrite can lose a requirement the author cared about.

Pass 2 is skipped when `verify` is false or when pass 1 found nothing at severity ≥ 5.

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

Mode changes are reported by Pi's **footer status** (`⏸ plan` / `▶ build`, plus todo progress): switching with **Tab** or `Ctrl+Alt+P` is silent and adds nothing to the transcript, while `/plan`, `/build` and `/default` print a single confirmation line. Only the review phase adds bands, and the reviewer's stream is rendered in the review color:

| Entry | Color | Meaning |
| --- | --- | --- |
| `▌ REVIEW MODE` | accent | A review round is running (round + model shown) |
| action headers | muted | One line per reviewer tool call with its key argument (`▸ read src/app.ts`, `▸ review_bash: git log -5`). Assistant prose and thinking are not streamed, so the transcript stays close to Plan Mode's; status lines are muted |
| `▌ REVIEW DONE` | success / warning | Round finished, with the verdict or the fallback reason |
| `▌ REVIEW SUMMARY` | success / warning | The submitted plan's verdict, plan path and findings (severity-colored) |

These are **display-only custom entries** (`pi.appendEntry` + `pi.registerEntryRenderer`): they are durable in the transcript and survive `/reload`, but they never enter the LLM context, so Plan Mode and Build Mode cannot see the reviewer's work. Consecutive identical bands are suppressed (the gate is seeded from the newest band on reload), so cycling modes or re-running a review cannot grow the transcript. Long reviews are coalesced (flushed roughly every 400 ms) and capped, with a one-line notice pointing at `/review-status` when output is truncated.

#### Where your next message goes

Input follows the **active mode**, decided automatically — there is nothing to focus or toggle:

- **Plan Mode** → the message goes to the plan agent.
- **Review Mode** (a review round is in flight) → the message is delivered to the reviewer's session (steered if it is mid-pass) and echoed in the transcript as `you → reviewer`. The plan agent never sees it.
- **Neither** (including while the plan sits in Plannotator) → the message goes to the plan agent, so you can still refine the plan.

Delivery to the reviewer is best-effort: if it fails, the message falls through to the plan agent rather than being swallowed.

**Status line.** While a review is running, the status widget above the editor shows the live phase (`🔍 review · pass 2/2 · 3 findings · ● verifying`).

### Isolation

The reviewer is an in-process child session created with `createAgentSession`, and it is isolated on purpose:

- `DefaultResourceLoader({ noExtensions: true })` — the child cannot load this (or any other) extension, so Review Mode cannot recurse.
- `SessionManager.inMemory(...)` — no session file is written; the reviewer never touches the parent's history.
- Its own `ModelRuntime` — no contention with the parent's model state.
- Plan Mode's conversation is passed as **pruned** prompt context (oversized tool results elided, workflow-injected markers dropped, nothing after the plan write), not by sharing the session.

An environment marker (`PI_WORKFLOW_REVIEW_CHILD`) is set only for the duration of session creation and restored immediately — the child runs in the same process, so leaking it would affect a later `/reload`.

### Configuration

Settings live under `workflow.reviewMode` in `~/.pi/agent/settings.json` (global) or `<cwd>/.pi/settings.json` (project). Project values win field-by-field over global. Writing them preserves every other key in the file.

## Settings

Role config lives in `~/.pi/agent/roles.json` v2 (user) with optional per-project override at `<cwd>/.pi/roles.json` (per-role replace). Each role holds exactly one `{provider, id, thinking}`. v1 `modelPool` files are discarded and reseeded on load. Seeded with defaults on first run. Respects `theme`, `modelRegistry`, and `plannotator` phases from `agent/plannotator.json`.

Review Mode settings live under `workflow.reviewMode`:

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `false` | Master toggle. When false, every Review Mode code path is a no-op |
| `rounds` | `1` | Max Plan↔Review rounds per user-feedback cycle. Reached the cap → the plan is handed over with an `## Unresolved findings` appendix |
| `passes` | `2` | `1` = review+rewrite only; `2` = review, then self-verify |
| `verify` | `true` | Run the self-verification pass |
| `fallbackOnError` | `"skip"` | `skip` hands over the author's plan on any failure (`block` is reserved) |
| `exploreBudget` | `3` | Max `review_explore` subagents per round (cost ceiling) |
| `timeoutMs` | `0` | Optional wall-clock cap for a whole pass, run included. `0` = unlimited (default); a pass then ends on `review_pass_done`, run settle, abort or error. A silent reviewer is still caught immediately by the settle race. `/review-mode status` prints the value and the settings file that set it, and `/review-mode timeout <seconds\|unlimited>` changes it without editing JSON |

```json
{
  "workflow": {
    "reviewMode": { "enabled": true, "rounds": 1, "passes": 2, "exploreBudget": 3 }
  }
}
```

`"reviewMode": true` is accepted as shorthand for `{ "enabled": true }`.

## How it works

See `index.ts`, `checkpoint.ts` (shadow bare-repo), `utils.ts` (safe-command gating, todo/plan extraction, plan hashing), `roles.ts` (role registry, one model per role), and the Review Mode modules: `review.ts` (config, prompt, state, transcript, child session — no runtime imports, so it is unit-testable), `review-tools.ts` (the reviewer's tool set), `review-runtime.ts` (round orchestration), `review-ui.ts` (the main-transcript entries: line buffer, formatters, renderers). Hot-reload via `/reload` when placed in `~/.pi/agent/extensions/workflow/` or loaded via `pi.extensions` manifest.

### Todo protocol (industry-aligned)

- **Canonical refs**: every todo row is numbered **globally** `1..N`; those numbers are the only refs the model ever needs. Refs are canonical positions — they are recomputed as `1..N` after every mutation (plan merge, `update`, session restore), so the pinned widget, handoff messages, tool output and `workflow_todo` refs always show the same numbers (no 11–20 drift). The plan's per-phase labels (e.g. `Phase B: 1..3`) are preserved only as display metadata (`(plan label B2)`). Integer refs resolve by canonical `ref` → positional `step` → unique `label`; the resolver also accepts `Group/Label`, `Label@Group`, `#N` and unique text (≥8 chars).
- **States**: `pending` → `in_progress` → `completed` (+ `cancelled`). Exactly one `in_progress` at a time (the harness normalizes extras). `completed` is kept as a derived legacy field for old sessions/external readers.
- **Update**: `workflow_todo {action:"update", todos:[{ref?, text?, status?}]}` replaces the whole list — TodoWrite/todowrite/update_plan semantics. A `ref` is resolved by canonical ref, then normalized text, then leniently by plan label / group-qualified ref / unique text; a ref that had to be resolved leniently (or matched nothing and was added) is reported under `Warnings:` in the tool result. `done`/`pending` are idempotent single-item sets; `toggle` is a convenience flip; `add` appends an ad-hoc item; `sync` re-extracts the plan file, matches steps by exact text then by plan label (so model-rewritten wording reunites instead of duplicating), **preserves agent-added items** (reported as `kept N agent-added`) and never un-completes (status rank merge); `clear` empties.
- **Reminder cadence** (Claude Code-style throttle): a hidden `[TODO LIST]` context block is injected only when `turnsSinceLastTodoWrite ≥ TURNS_SINCE_WRITE` **and** `turnsSinceLastReminder ≥ TURNS_BETWEEN_REMINDERS` (`=3`). Unresolved `[DONE:…]` refs from the previous turn bypass the throttle once so the model learns the right numbers. A one-line `[TODO …]` footer is appended to the first successful `edit`/`write`/`bash` result of each turn.
- **Stale notice (no forced turns)**: if a run mutated files but recorded no todo progress, the user gets one `⚠` status marker + a `ctx.ui.notify` (30 s dedupe); plan-file `- [x]` ticks are reconciled at `agent_end` in all modes, skipped when the plan content is unchanged (path+hash guard). No auto-completion — the list is never marked done based on intent. Legacy lists that already contain duplicate rows are not auto-merged; run `/todos clear` (or approve a new plan) to reset.

## Development

```bash
cd agent/extensions/workflow
npm install
npm run typecheck   # tsc --noEmit (covers every source file, including the review modules)
npm test            # node --test utils.todo.test.ts review.test.ts review-ui.test.ts
```

Plain TypeScript, no build step — Pi loads `index.ts` directly (via jiti). From the repo root, `npm run verify` checks this package's manifest, tarball contents, tests and load path before a release. Live reload: edit the `.ts` file and run `/reload` in Pi.

## License

MIT — see [LICENSE](./LICENSE).
