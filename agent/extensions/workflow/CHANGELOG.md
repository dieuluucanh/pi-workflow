# Changelog

All notable changes to this package are documented in this file.

## [Unreleased]

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
