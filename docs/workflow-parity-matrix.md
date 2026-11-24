# Workflow ↔ Pi Desktop parity inventory (frozen baseline)

**Plan:** `.pi/plans/2026-11-22-prompt-refinement-workflow-parity.md`, rows 1 and 37
(**Record baselines and freeze the parity inventory** / **Complete the full
Workflow parity matrix**).
**Status:** inventory frozen in row 1; **row 37 re-ran every row against the real
staged Workflow artifact and closed the matrix**. §3 holds the per-area detail;
§7 records the final classification, the automated evidence, the manual/platform
checks that remain NOT RUN, and the accepted exceptions. No NOT RUN manual check
is presented as a pass.

This file is the checked-in, test-linked matrix required by the plan's
Verification section. It records:

- the W/D baseline actually rechecked before implementation,
- every piece of behaviour W registers with the Pi host,
- one row per Verification area, with Terminal/W source references, D source
  references, automated or manual evidence, and a classification.

Classification legend:

| Class | Meaning |
| --- | --- |
| **SUPPORTED** | The named capability exists and has reproducible automated evidence in the owning repository at the baseline commit. |
| **ABSENT** | The target capability has no implementation in this tree at the baseline. Later plan steps own it. |
| **UNVERIFIED** | Code exists but has no reproducible test or manual acceptance evidence for this specific W-artifact/D-host combination. Not a pass. |
| **INTENTIONAL DIFFERENCE** | An accepted platform divergence (Terminal vs Desktop). Documented, not a defect. |

A row may carry more than one classification per half (e.g. generic seam
SUPPORTED, real-artifact exercise UNVERIFIED).

## 1. Baseline record (rechecked 2026-11-22/23)

### Repositories

| Workspace | Path | Branch | HEAD | Working tree |
| --- | --- | --- | --- | --- |
| W | `C:/Users/Lenovo/.pi` | `feature/orchestrator-mode` | `b497a4c` (feat(workflow): measure and verify multiple workspace roots per Orchestrator run) | clean (`git status --short` empty) |
| D | `C:/Users/Lenovo/Projects/pi-desktop` | `feature/orchestrator-mode` | `b59a407` (feat(session): make the composer mode label the mode-cycle control) | clean (empty) |

Neither tree had uncommitted work at the recheck, so nothing unrelated needed
preserving. (The plan's exploration note about dirty W `index.ts`, orchestrator
runtime/tool modules, tests and `agent/settings.json` no longer applies; those
changes are committed.)

### Manifests and runtime

| Fact | Value |
| --- | --- |
| W extension package | `@dieulc/workflow` `0.13.0`, `private: false`, entry `./index.ts` via `pi.extensions` |
| W repo package | `@dieulc/pi-workflow` `0.0.0`, `type: module`, scripts `test`, `verify`, `release`, `gallery`, `release:status` |
| D app package | `pi-desktop` `0.11.0`, `private: true`, Electron + host/renderer split, bundled Node runtime |
| SDK dependencies (both) | `@earendil-works/pi-coding-agent`, `pi-agent-core`, `pi-ai`, `pi-tui` — **1.5.0** each; `typebox` 1.3.7 |
| Runtime | Node **v24.22.2**, npm **11.19.1**; both manifests require `node >= 22.19.0` |
| D SDK boundary | `src/host/sdk/*` (single import boundary; enforced by `tests/architecture/sdk-boundary.test.ts`) |

### Existing test baselines (run before any change)

| Suite | Command | Result |
| --- | --- | --- |
| W workflow extension | `agent/extensions/workflow: npm test` | **exit 0**, 1286 tests pass, 0 fail |
| W repo root | `C:/Users/Lenovo/.pi: npm test` | **exit 0**, 80 tests pass, 0 fail |
| D full vitest | `C:/Users/Lenovo/Projects/pi-desktop: npm test` | **exit 0**, 420 files pass; 5699 pass, 4 skipped |

D prints jsdom `HTMLCanvasElement.getContext()` notices; they are pre-existing and
do not fail the suite. D gates not run for this baseline snapshot (they are
row-38 work): `format:check`, `typecheck`, `lint`, `build`.

## 2. W registration inventory

Anchors are symbol names because line numbers drift. Sources: `agent/extensions/workflow/index.ts`
(composition root), plus the modules named.

### 2.1 Registered slash commands (30)

| Command | Owning area | Anchor |
| --- | --- | --- |
| `/plan`, `/workflow`, `/build`, `/default`, `/orchestrator` | mode entry | `index.ts` command registrations |
| `/workflow-cycle` | mode cycle (same controller as Tab) | `cycleWorkflowMode` |
| `/orchestrator-pause`, `/orchestrator-resume`, `/orchestrator-abort`, `/orchestrator-view` | orchestrator child control | `index.ts` |
| `/review`, `/review-mode`, `/review-prompt`, `/review-status`, `/review-pause`, `/review-resume`, `/review-abort` | Review Mode | `review.ts`, `review-runtime.ts`, `review-ui.ts` |
| `/handoff` | plan handoff | `handoff-*.ts`, `review-handoff.ts` |
| `/commit`, `/commit-policy` | commit authority | `commit-policy.ts` |
| `/write-policy` | write policy | `edit-policy.ts` |
| `/read-policy` | read policy / grants | `read-policy*.ts` |
| `/folder-policy` | shared folder scope | `folder-policy.ts` |
| `/shell-guard` | shell command guard | `shell-guard*.ts` |
| `/permissions` | unified permission overview | `permissions.ts` |
| `/todos` | todo panel verbs | `todo-service.ts`, `todo-panel.ts` |
| `/role` | model role config | `roles.ts` |
| `/profile` | profile config | `profiles.ts` |
| `/rewind` | shadow-checkpoint rewind | `checkpoint.ts` |
| `/btw` | side note/context channel | `index.ts` |

Frozen list: `agent/extensions/workflow/fixtures/compat-baseline.json` →
`commands`. `compat-baseline.test.ts` fails on accidental drift.

### 2.2 Registered tools (7)

| Tool | Purpose | Anchor |
| --- | --- | --- |
| `workflow_todo` | todo list state, global refs, panel semantics | `todo-service.ts`, `todo-snapshot.ts` |
| `workflow_execution` | execution/approval bookkeeping | `execution-state.ts` |
| `explore` | read-only reconnaissance subagent | `index.ts` (`runSingleAgent`) |
| `questionnaire` | clarification UI tool | `questionnaire-view.ts`, `questionnaire-layout.ts` |
| `orchestrator_start` | start an orchestrator row run | `orchestrator-tool-runtime.ts` |
| `orchestrator_status` | report run/child state | `orchestrator-tool-runtime.ts` |
| `orchestrator_retry` | retry a blocked row | `orchestrator-tool-runtime.ts` |

Frozen list: fixture `registeredTools`. Active Plan/Build tool sets are also
frozen (`planActiveTools`, `buildActiveTools`), including the built-ins
`read/bash/edit/write/grep/find/ls`.

### 2.3 Shortcuts and flag (3 + 1)

| Registration | Behaviour |
| --- | --- |
| `ctrl+alt+p` | cycle Default → Plan → Orchestrator → Build |
| `ctrl+alt+o` | toggle the Workflow todo panel (Terminal; Desktop uses `Ctrl+Alt+L` and its native Todo bar) |
| `tab` | same guarded cycle when no completion list is open (`WorkflowTabEditor` returns Tab to completion first) |
| flag `workflow-plan` | start in Plan mode (alias for `--plan`) |

### 2.4 Status keys (7)

`workflow-status.ts` → `WORKFLOW_STATUS_KEYS`:

| Key | Meaning |
| --- | --- |
| `workflow` | mode segment |
| `workflow-profile` | active profile |
| `workflow-policy` | write/read policy summary |
| `workflow-review` | Review phase line |
| `workflow-todos` | compact todo progress (also shown while the panel is hidden) |
| `workflow-orchestrator` | orchestrator run/child segment |
| `workflow-execution` | execution/approval state |

### 2.5 Widgets (2)

| Widget key | Placement | Renderer |
| --- | --- | --- |
| `workflow-todos` | above editor | component factory (`ctx.ui.setWidget(key, factory)`) |
| `workflow-review-status` | above editor, below the todo widget | plain-text lines |

### 2.6 Entry renderers (6 custom types)

| Custom type | Module |
| --- | --- |
| `workflow-review-mode` | `review-ui.ts` (`REVIEW_MODE_ENTRY_TYPE`) |
| `workflow-review-transcript` | `review-ui.ts` (`REVIEW_TRANSCRIPT_ENTRY_TYPE`) |
| `workflow-review-submitted` | `review-ui.ts` (`REVIEW_SUBMITTED_ENTRY_TYPE`) |
| `workflow-handoff-plan` | `review-ui.ts` (`HANDOFF_PLAN_ENTRY_TYPE`) |
| `workflow-orchestrator-child-band` | `orchestrator-child-view.ts` |
| `workflow-orchestrator-child-transcript` | `orchestrator-child-view.ts` |

Registered via `pi.registerEntryRenderer`; entries themselves are written with
`pi.appendEntry` (42 call sites). Bare `custom` entries with no renderer render
nothing (D matches Pi's rule).

### 2.7 Generic host contributions (independent of any host)

- Contract: `agent/extensions/workflow/host-contributions.ts`
  — `HOST_CONTRIBUTION_VERSION = 1`; kinds `mode|progress|status|action|input|related-session`;
  slots `mode|progress|status|action|input|sessions`; bounded strings, no control
  characters, actions carry only a registered `command.name` + opaque `args`.
- Workflow mapping: `workflow-contributions.ts` (`buildWorkflowContributions`,
  `WORKFLOW_OWNER_ID = "@dieulc/workflow"`).
- Publisher: `host-contributions-publisher.ts` (`createContributionPublisher`,
  `CONTRIBUTION_EVENTS`), bus-based (`pi.events.emit`/`on`).
- Conformance fixture: `fixtures/host-contract.conformance.json`;
  two-extension fixture: `fixtures/two-extension-contract.json`.
- D counterpart: `src/shared/extension-contributions.ts` (validators, same
  vocabulary) and `src/host/contributions.ts` (registry, source-bound action
  resolution). D's `tests/architecture/no-workflow-adapters.test.ts` forbids a
  Workflow-specific adapter returning.

### 2.8 Host dependency surface used by W

SDK packages imported by W (non-test source): `pi-coding-agent` (types
`ExtensionAPI`/`ExtensionContext`/`ExtensionCommandContext`/`Theme`, helpers
`defineTool`, `createAgentSession`, `SessionManager`, `getAgentDir`,
`CustomEditor`, `Text`, truncation utilities), `pi-agent-core` (`AgentMessage`,
`ThinkingLevel`, `AgentTool`, `StreamFn`), `pi-ai` (`Model`, `ImageContent`,
`AssistantMessage`, `StringEnum`, `uuidv7`), `pi-tui` (`Container`, `Box`, `Text`,
`TUI`, `Component`, `Focusable`, `MarkdownTheme`, `truncateToWidth`,
`visibleWidth`), `pi-schema` (`Static`).

Host UI surface used (call counts, non-test): `ctx.ui.notify` 432,
`ctx.ui.custom` 47, `setStatus` 30, `theme` 23, `setWidget` 10, `select` 10,
`confirm` 9, `setEditorText` 6, `setEditorComponent` 5, `setTitle` 4,
`setHiddenThinkingLabel` 4, `setFooter` 4, `editor` 4, `setWorkingIndicator` 3,
`setHeader` 3, `input` 3, `setTheme` 2, `setWorkingVisible` 1,
`setWorkingMessage` 1, `addAutocompleteProvider` 1.

Extension API used: `pi.appendEntry` 42, `registerCommand` 30, `on` 23,
`setActiveTools` 9, `getActiveTools` 8, `registerTool` 7 (5 in `index.ts`),
`registerShortcut` 3, `registerFlag` 1, plus `pi.events` via the publisher.

### 2.9 Plan-evidence corrections found while inventorying

| Plan statement | Current evidence |
| --- | --- |
| "following W's `workflow-bridge` pattern" (architecture/step 13) | `workflow-bridge` was **removed** in the in-process child refactor (`CHANGELOG.md` and `compat-baseline.test.ts:24`). The grant-only bootstrap pattern must be re-introduced, not copied. |
| "D `recommended-packages.ts` recommends Workflow" | The file is `src/shared/recommended-packages.ts` (not `src/host/`), id `dieulc-workflow`, source `npm:@dieulc/workflow`. It is a recommendation only. |
| "D `src/host/sdk/index.ts` currently adds only the checkpoint extension" | Confirmed: `checkpointExtensionLoaderOptions` from `src/host/safe-mode.ts`; there is **no** `builtin:` wiring anywhere in `src/`. |
| "D host `contributions.run` re-resolves `contribution.command.args`" | Confirmed generically in `src/host/contributions.ts` + `src/host/sdk/contributions.ts`. |

## 3. Feature-by-feature parity matrix

Columns: **Terminal/W baseline** (source anchors), **D current behaviour**
(source anchors), **Evidence** (automated test files; manual evidence is
explicitly labelled NOT RUN), **Class**, **Owning plan step**.

### 3.1 Startup / discovery / config

| Field | Detail |
| --- | --- |
| Terminal/W | Package manifest `pi.extensions: ["./index.ts"]`; extension registers at load. Capability negotiation lives in `host-contributions.ts`; D disables/enables via Pi settings. |
| D current | Bundled `builtin:workflow` through Pi's named replaceable factory (`src/host/workflow-builtin.ts`, `src/host/sdk/workflow-builtin.ts`), staged by `scripts/stage-workflow-bundle.mjs` and byte-verified by `npm run workflow:verify` into `resources/extensions/workflow` + `out/extensions/workflow`. Sessions and the Extensions hub share `workflowBuiltinLoaderOptions`; safe mode loads neither the builtin nor installed extensions; `-builtin:workflow` is the opt-out; an installed copy replaces it once with Pi's warning. `src/shared/recommended-packages.ts` no longer duplicates the default Workflow recommendation. |
| Evidence | Generic: `tests/host/safe-mode.test.ts`, `tests/host/resources.test.ts`, `tests/host/packages.test.ts`, `tests/architecture/sdk-boundary.test.ts`, `tests/host/workflow-builtin.test.ts`, `tests/host/sdk-workflow-builtin.test.ts`. **Real staged artifact + real `DefaultResourceLoader`** (`tests/host/workflow-builtin-loader.test.ts`): fresh profile, `-builtin:workflow` opt-out, real installed copy replacing the builtin exactly once with the provenance warning, trust-gated project opt-out, reload consistency, checkpoint coexistence, and **step 37** the same four paths driven with the real bundle (exactly one `/prompt`+`/prompt-model`+`/workflow-cycle` registration, opt-out removes it, installed real copy replaces it once, safe mode loads neither). Manual packaged/clean-profile run: **NOT RUN** (row 39). |
| Class | **SUPPORTED** (bundle, builtin, replaceable, opt-out/override/safe-mode with the real artifact) · packaged/offline run **NOT RUN** |
| Steps | 25–27, 37, 39 |

### 3.2 Default / Plan / Build / Orchestrator modes

| Field | Detail |
| --- | --- |
| Terminal/W | `/default /plan /build /orchestrator`, `/workflow`, `/workflow-cycle`, Tab + `Ctrl+Alt+P`, flag `--workflow-plan`; tool gating via `pi.setActiveTools`; no execution on mode entry (`workflow-mode.ts`, `mode-cycle.test.ts`, `extension.test.ts`). |
| D current | Generic `mode`/`action` contributions (`src/host/contributions.ts`, `src/renderer/src/session/Composer.tsx` mode control, documented in `docs/architecture/extension-ui.md`); Tab/shortcut dispatch per tab (`src/host/shortcuts.ts`, `src/renderer/src/session/Composer.tsx`). No Workflow name in the runtime. |
| Evidence | `tests/host/contributions.test.ts`, `tests/host/contribution-mode-boundary.test.ts`, `tests/host/shortcuts.test.ts`, `tests/renderer/composer.test.tsx`, `tests/renderer/session-view.test.tsx`. **Real staged artifact** (row 31): D `tests/host/workflow-artifact-parity.test.ts` loads `out/extensions/workflow` and drives `/default`, `/plan`, `/orchestrator`, `/build`, `/workflow-cycle` and the registered `tab` shortcut, asserting the Default → Plan → Orchestrator → Build ring, per-mode active tool sets and zero execution. W `compat-baseline.test.ts` now also pins `/workflow` as an unconditional Plan entry. |
| Class | **SUPPORTED** (generic seam + real artifact) |
| Steps | 31, 36, 37 |

### 3.3 Role / profile / default model

| Field | Detail |
| --- | --- |
| Terminal/W | `roles.ts` (5 built-ins), `profiles.ts` (profile role whitelist), `model-default.ts` (`resolveDefaultModeModel`, capture/restore/persist), `/role`, `/profile`, `model_select`/`thinking_level_select`; tests `roles.test.ts`, `profiles.test.ts`, `model-default.test.ts`, `thinking-levels.test.ts`. |
| D current | Native model picker `src/renderer/src/session/ModelPicker.tsx`; `src/host/sdk/model-changes.ts`, `model-scope.ts`, `model-thinking.ts`; settings via `src/host/settings.ts`. No refinement model setting, no `/prompt-model`. |
| Evidence | `tests/host/model-thinking.test.ts`, `tests/host/roles.test.ts`, `tests/renderer/session-view.test.tsx`. **Real staged artifact** (row 31): `/role list`, `/profile list` and `/role use` are driven against the bundle (a rejected model never reaches `pi.setModel`); `/prompt-model set` writes only `workflow.promptRefinement` and never `defaultProvider`/`defaultModel`/`defaultThinkingLevel`/`modelDefault`/roles/profiles, and the main session model is unchanged. Refinement inheritance accessor is covered by W `default-mode-model.test.ts`. |
| Class | **SUPPORTED** (existing model/role behaviour + refinement separation) |
| Steps | 3, 4, 31, 35 |

### 3.4 Questionnaires

| Field | Detail |
| --- | --- |
| Terminal/W | `questionnaire-view.ts`, `questionnaire-layout.ts`, `ctx.ui.custom` bottom-center overlay, 1–4 questions, recommendations/free text, Finish/Cancel; tests `questionnaire-view.test.ts`, `questionnaire-layout.test.ts`, `extension.test.ts`. |
| D current | Emulated TUI surface `src/host/tui-surface.ts` + `src/renderer/src/tui/TuiSurface.tsx`; session-column grid and dock/floating overlays (`docs/architecture/extension-ui.md`); inline dialog dock `src/renderer/src/extension-ui/ExtensionDialog.tsx`. |
| Evidence | `tests/host/tui-surface.test.ts`, `tests/host/sdk-tui-surface.test.ts`, `tests/renderer/tui-surface.test.tsx`, `tests/renderer/extension-ui.test.tsx`, `tests/e2e/extension-dialog.spec.ts`. **Real staged artifact** (row 32): D `tests/host/workflow-artifact-parity.test.ts` drives the artifact's real `questionnaire` tool through `ctx.ui.custom`, asserting the selected/custom answer summary, cancellation (`details.cancelled`), and an honest `UI not available` refusal outside the TUI — with no turn or write. Full in-app terminal-surface QA remains row 36/37. |
| Class | **SUPPORTED** (emulated surface + dialogs + real artifact tool) · known limitations: single custom slot/nested overlays, background tab does not activate, stale `tuiSurfaces` (documented in `extension-ui.md`) |
| Steps | 8, 28, 32 |

### 3.5 Todos and progress

| Field | Detail |
| --- | --- |
| Terminal/W | `todo-service.ts`, `todo-panel.ts`, `todo-snapshot.ts`; `workflow_todo` tool (list/update/done/pending/add/toggle/sync/clear); widget `workflow-todos`; status `workflow-todos`; `/todos auto|expand|collapse|hide`; tests `todo-service.test.ts`, `todo-panel.test.ts`, `todo-snapshot.test.ts`, `utils.todo.test.ts`. |
| D current | Generic `progress`/`status` contributions + `TuiWidgetStrip` frames; native Todo bar above the panel documented in `extension-ui.md` (`TodoPanelBar`, `Ctrl+Alt+L`); no Workflow-specific parser (`tests/architecture/no-workflow-adapters.test.ts`). |
| Evidence | `tests/host/contributions.test.ts`, `tests/renderer/contributions-bar.test.tsx`, `tests/renderer/tui-widgets.test.tsx`. **Real staged artifact** (row 32): the artifact publishes the `todos` progress (done/total + `Expanded`/`Hidden` detail) and command-backed `todos-auto|expand|collapse|hide|toggle` actions over `host-contributions:update`; `/todos hide` switches only the detail and starts no turn. W action/panel semantics remain covered by `todo-*.test.ts` and `extension.test.ts` Z1–Z13. Two-session isolation (row 37): W `todo-service.test.ts` (two stores never share items, plan path or panel state) and `extension-factory-safety.test.ts` (two sessions + a resource-inspector load share no refiner/reviewer/subagent state); the D artifact boot in `workflow-artifact-parity.test.ts` uses one instance per host, matching the real one-bus-per-session boundary. |
| Class | **SUPPORTED** (generic rendering + real artifact panel/actions) |
| Steps | 32, 37 |

### 3.6 Explore

| Field | Detail |
| --- | --- |
| Terminal/W | `explore` tool + explorer role; `runSingleAgent` spawns a Pi child and currently derives the executable from `process.argv[1]` (`index.ts`); read-only/policy ceiling; tests `extension.test.ts`, `autonomy-harness.test.ts`. |
| D current | Bundled Node runtime + Pi CLI shim exist (`resources/runtime`, `scripts/verify-runtime.mjs`), but **no verified launcher port** hands the child the real Pi CLI instead of `out/main/index.mjs`; no policy-inheritance proof for a builtin factory's child. |
| Evidence | D `tests/runtime/doctor.live.test.ts` (gated, not part of `npm test`), `tests/host/integration.test.ts`, W `subagent-launch.test.ts` (launcher/argv/policy port). Row 32 adds W `extension.test.ts` EX1/EX2: an agent without a frontmatter model is routed to the read-only `explorer` role, an unknown agent is refused, and an unusable CLI descriptor refuses **before spawn** (no child in the test). Packaged child launch on the real desktop: row 39. |
| Class | **SUPPORTED** (launcher port + read-only role routing) · **UNVERIFIED** (packaged child run) |
| Steps | 30, 39 |

### 3.7 Review

| Field | Detail |
| --- | --- |
| Terminal/W | `review.ts` (`createReviewSession`), `review-runtime.ts`, `review-providers.ts`, `review-ui.ts`, `review-tools.ts`, `review-recovery.ts`; commands `/review*`; status `workflow-review` + widget; tests `review.test.ts`, `review-ui.test.ts`, `review-handoff.test.ts`, `provider-retarget.test.ts`. |
| D current | Generic mode/action/progress contributions, `ctx.ui.custom` surface for the review band, per-tab shortcuts; no Workflow adapter. |
| Evidence | `tests/host/contributions.test.ts`, `tests/host/extension-contract.e2e.test.ts`, `tests/renderer/tui-surface.test.tsx`, `tests/e2e/extension-dialog.spec.ts`. W suite drives the real factory with a fake reviewer SDK/provider: `review.test.ts` (session isolation, prompt precedence, provider errors, pause/resume helpers, status lines), `extension.test.ts` S/R/T/HF/HD groups (pause/resume/abort/status/handoff), plus row 32 `RV1`/`RV2` (`/review-prompt` reads/writes guidance with no turn; `/review-status` on an idle session starts nothing). **Real staged artifact** (row 32): `/review-status`, `/review-pause`, `/review-resume`, `/review-abort`, `/review-prompt` are safe no-ops with no round and start no tools/model. A live independent-provider review run remains row 37. |
| Class | **SUPPORTED** (host mechanics + factory/reviewer session) · **UNVERIFIED** (live provider round) |
| Steps | 32, 37 |

### 3.8 Handoff

| Field | Detail |
| --- | --- |
| Terminal/W | `handoff-config.ts`, `handoff-view.ts`, `handoff-routing.ts`, `review-handoff.ts`; optional Plannotator via loopback URL; entry renderer `workflow-handoff-plan`; tests `handoff-config.test.ts`, `handoff-view.test.ts`, `handoff-routing.test.ts`, `handoff-execution-view.test.ts`, `review-handoff.test.ts`. |
| D current | Isolated in-app web tab for localhost review pages (`docs/product/parity.md`); `PLANNOTATOR_BROWSER=none` for desktop hosts (W code path); no native handoff decision adapter. |
| Evidence | `tests/host/extension-contract.e2e.test.ts`, W `handoff-*` tests. Row 32: W `extension.test.ts` proves native fallback without a host (`HD2`, `HD7`), Plannotator error/timeout fallback (`HF1`, `HD19`), separate plan vs execution approval (`TS1`, `TS2`, `TS4`) and real destinations (`RE1`, `RE2`); D artifact test drives `/handoff status` and reports `no Plannotator host detected` honestly, with no approval or execution grant. A real browser/in-app handoff remains row 36/37. |
| Class | **SUPPORTED** (decisions, destinations, honest degradation) · **UNVERIFIED** (real browser tab) · **INTENTIONAL DIFFERENCE** (in-app tab replaces system browser) |
| Steps | 32, 36 |

### 3.9 Policies and commit

| Field | Detail |
| --- | --- |
| Terminal/W | `read-policy*.ts` (grants, redaction), `edit-policy.ts`, `folder-policy.ts`, `folder-exclude.ts` semantics in `folder-policy.ts`, `shell-guard*.ts`, `commit-policy.ts`, `permissions.ts`; `/write-policy /read-policy /folder-policy /shell-guard /commit-policy /commit /permissions`; scripts `verify-write-policy.mjs`, `verify-read-policy.mjs`; tests `read-policy*.test.ts`, `edit-policy.test.ts`, `folder-*.test.ts`, `shell-guard*.test.ts`, `commit-policy.test.ts`, `permissions.test.ts`, `policy-runtime.test.ts`. |
| D current | Trust before project resources (`src/host/project-trust.ts`); settings managers (`src/host/settings.ts`); generic command/action routing (`src/host/commands.ts`, `src/host/contributions.ts`); no hidden authorization path. |
| Evidence | `tests/host/project-trust.test.ts`, `tests/host/settings.test.ts`, `tests/host/contributions.test.ts`, `tests/host/commands.test.ts`. **Real staged artifact** (row 31): D `tests/host/workflow-artifact-parity.test.ts` round-trips `/write-policy`, `/commit-policy`, `/read-policy`, `/folder-policy` and `/shell-guard` against the bundle, proves a project-scope folder write is ignored for an untrusted project, `/permissions explain` never executes, and `/commit` fails closed with no repository/authorization. Project-scope read/write policy applies only when the host reports trust. Full cross-host policy matrix (live revocation/grants in a running turn): still row 37. |
| Class | **SUPPORTED** (host primitives + policy commands against real artifact) · **UNVERIFIED** (live-revocation matrix) |
| Steps | 31, 37, 38 |

### 3.10 Rewind / checkpoint / btw

| Field | Detail |
| --- | --- |
| Terminal/W | `checkpoint.ts` shadow repo; `/rewind`; `/btw`; tests `extension.test.ts` rewind coverage, `legacy-recovery.test.ts`. |
| D current | Bundled `@dieulc/checkpoints` extension (`src/host/checkpoint-extension.ts`, `packages/checkpoints`), gated by `src/host/safe-mode.ts`; independent checkpoint state (`src/checkpoints/`, `src/main/checkpoint-service.ts`). |
| Evidence | `tests/host/checkpoint-extension.test.ts`, `tests/host/safe-mode.test.ts`, `tests/main/checkpoint-service` coverage. Row 32: W `extension.test.ts` RW1–RW3 (`/btw` is separate) prove a no-history refusal leaves files untouched, a dirty tree needs an explicit confirmation before any restore, and a confirmed rewind moves the branch once and restores tracked files; `BTW1`–`BTW3` prove one note/one disclosure. The D artifact test proves `/rewind` refuses without history, cancels without navigating, and the Workflow source has no `@dieulc/checkpoints`/`checkpoint-service` dependency — the two checkpoint authorities stay independent. |
| Class | **SUPPORTED** (Workflow rewind/btw + independent Desktop checkpoints) |
| Steps | 32, 37 |

### 3.11 Orchestrator

| Field | Detail |
| --- | --- |
| Terminal/W | `orchestrator-*.ts` (state, store, runtime, tools, child controller/session/ui/view, workspace set, advance, mission, operator, adapters); in-process Build child; tools `orchestrator_start/status/retry`; commands `orchestrator`, `orchestrator-pause|resume|abort|view`; tests `orchestrator-*.test.ts` (state/store/runtime/tools/child-contract/advance/mission/operator/workspace/workspace-set/tool-runtime/adapters). |
| D current | Generic related-session bridge (`src/shared/related-sessions.ts`, `src/host/related-sessions.ts`) with source-bound ownership, grants, epochs, dedupe; test fixtures `tests/host/extension-contract.e2e.test.ts` + `tests/fixtures/two-extension-contract.json`. |
| Evidence | W: `orchestrator-*.test.ts` plus `orchestrator-parity.test.ts` (Builder model/source bootstrap and the empty-provider fallback, exact child tool allowlist excluding `orchestrator_*`/`questionnaire`, duplicate launch refused, stale/superseded launch disposal, provider/host failure without a settle, pause/resume/abort/settle-once, display-only child visibility) and `extension.test.ts` OE1–OE4 (real entrypoint: auto-accept/advance, warm repair then block, prose cascade without a parent turn, abort/retry). D: `tests/host/related-sessions.test.ts` + `tests/main/related-sessions.test.ts` (source-bound owner, host grant/epoch, duplicate request join/replay, timeout/teardown, idempotent create, focus/inspect/interrupt/close) and the real staged artifact in `tests/host/workflow-artifact-parity.test.ts` §“Orchestrator / related-session parity” (mode entry and status dispatch nothing, start without a plan refuses, child controls are inert, `/prompt` shows usage with zero orchestrator calls and zero `session-host:request`). Live provider turn, visible terminal child, separate window/pane, real `/reload` and host kill: **NOT RUN**. |
| Class | **SUPPORTED** (in-process Orchestrator contract + generic related-session bridge mechanics) · **UNVERIFIED** (live provider/visible-host acceptance) |
| Steps | 33, 37 |

Contract note (step 33): the older “parent-only commit ledger” wording is
superseded by the in-process design. The Orchestrator parent cannot edit or
write project sources — the tool-call gate refuses it and the real-artifact test
pins that refusal — while a row's Build child follows the normal Build commit
policy with the user-owned approval surface. There is no separate parent commit
ledger to verify. This is an intentional contract change, not an untested gap.

### 3.12 Refinement (`/prompt`, `/prompt-model`, composer toggle)

| Field | Detail |
| --- | --- |
| Terminal/W | Implemented: `/prompt <draft>` (literal args, empty = usage), `/prompt-model status|set|inherit|reset`, `/prompt-refine on|off`, `/prompt-refine-companion` (grant-only bootstrap). Modules: `prompt-refinement-*.ts` (state, config, model, context, prompt, tools, runtime, review, command), `inspection-policy.ts`/`inspection-tools.ts`, `clarification-presenter.ts`, `isolated-session.ts`, `composer-transform.ts`, `composer-transform-adapter.ts`. Live revalidation of trust/grants before each inspection, provider request and candidate delivery. |
| D current | Generic `composer-control` contribution kind + `composer-actions` slot, `composer.transform/cancel/operation/applied` host methods, source-bound companion bootstrap and private rendezvous (`src/host/composer-transform.ts`, `src/host/sdk/composer-transform.ts`, `src/shared/composer-transform.ts`, `src/shared/composer-operation.ts`), revisioned composer draft + CAS apply and explicit send dispositions in the renderer. No Workflow identifier in generic runtime code. |
| Evidence | W: `prompt-refinement-{state,config,prompt,context,tools,runtime,review,command}.test.ts`, `prompt-refinement-{cross-host,eval}.test.ts`, `composer-transform{,-adapter}.test.ts`, `default-mode-model.test.ts`, `inspection-tools.test.ts`, `isolated-session.test.ts`, `clarification-presenter.test.ts`, `extension.test.ts` PM1/PM2 + refinement groups, and `scripts/verify-desktop-composer-operation.mjs`. D: `tests/host/composer-transform.test.ts`, `tests/host/refinement-cross-host.test.ts` (byte-identical shared fixture, real staged artifact, old/new host, second unrelated publisher, revocation, privacy, duplicate/replay), `tests/renderer/composer-*.test.tsx`, `tests/shared/composer-*.test.ts`. **Step 37 additions** (real staged artifact in `refinement-cross-host.test.ts`): `/prompt` in **Default, Plan, Build and Orchestrator** returns the fixture candidate in place, keeps the published mode segment unchanged, uses exactly one isolated child on the configured refinement model, and produces zero parent turns/child dispatches; with `workflow.modelDefault` + an `inherit` sentinel, every mode refines with the **Default-mode model**, never the mode's role model. |
| Class | **SUPPORTED** (prefix + toggle + host transform, model inheritance/override, questions, CAS apply, disarm-on-apply, zero execution) · Terminal structured images **INTENTIONAL DIFFERENCE** · native/TUI rendering **INTENTIONAL DIFFERENCE** |
| Steps | 2–24, 34–37 |

### 3.13 Lifecycle / recovery

| Field | Detail |
| --- | --- |
| Terminal/W | `session_start`/`session_shutdown` handlers, persisted mode/todo state (`workflow-status.ts`, `workflow-mode.ts`), legacy recovery (`legacy-recovery.ts`); tests `extension.test.ts`, `legacy-recovery.test.ts`, `workflow-mode.test.ts`, `workflow-status.test.ts`. |
| D current | Session runtime replacement (`src/host/session-core.ts`), binder reset (`createSdkExtensionBinder` → `resetSessionUi`, `src/host/sdk/extension-ui.ts`), tab/session fencing, contribution epochs (`src/host/contributions.ts`), safe mode. |
| Evidence | `tests/host/integration.test.ts`, `tests/host/session-core.test.ts`, `tests/host/sdk-extension-ui.test.ts`, `tests/renderer/session-events.test.ts`, `tests/renderer/tab-*`. Real new/resume/fork/rewind/reload with W: **NOT RUN**. |
| Class | **SUPPORTED** (generic lifecycle fencing) · **UNVERIFIED** (artifact lifecycle matrix) |
| Steps | 23, 28, 29, 37 |

## 4. Key executable assertions — ownership map

These are the plan's Verification assertions; none is satisfied by this
inventory row. Each is listed with the step that must produce evidence.

| Assertion | Evidence owner |
| --- | --- |
| Zero parent task turns / code writes / plan files / commits / orchestrator dispatches before a later human Send | steps 10, 12, 20, 34, 36 |
| Returned text has no command prefix or transport wrapper; composer stays editable; disarm only on apply receipt | steps 11, 15, 19, 20, 34 |
| Original constraints/language survive; terminology cites real source; unaccepted ideas are not requirements | steps 5, 10, 35 |
| Inheritance uses Default-mode model; override uses exactly that model; main model/thinking/default/role/profile unchanged | steps 3, 4, 34, 35 |
| Images/paths/URLs/code/paste/file mentions survive; unsupported content disclosed | steps 9, 18, 34, 36 |
| Late/stale/duplicate/malicious operations cannot overwrite another tab, newer edit, attachments, or re-toggle | steps 2, 14, 16, 19, 23 |
| Operation never gains authority beyond its starting ceiling; live narrowing invalidates before further disclosure | steps 6, 10, 34 |
| Real SDK provenance + grant-only bootstrap; drafts/images never in command strings; no listener leak | steps 13, 14, 15, 34 |
| Old/new Desktop + W combinations degrade by advertised capability; no double extension | steps 13, 27, 37 |
| Packaged clean-profile/offline run exercises the real staged W artifact | steps 26, 39 |

## 5. Intentional platform differences (accepted)

Recorded now so later rows do not “fix” them by accident:

1. **Terminal image path UX vs Desktop structured images.** SDK 1.5 command
   handlers receive no structured images and expose no source; Terminal keeps
   clipboard *paths*. Desktop preserves real attachment objects. No upstream
   `node_modules` patch is allowed.
2. **Custom editor is recorded, not mounted, in D.** The native composer stays
   the editor; `setEditorComponent` is only coordination (`getEditorComponent`).
   Terminal keeps `WorkflowTabEditor`.
3. **Rendering is equivalent, not pixel-identical.** D renders TUI frames with
   its own tokens/components; Terminal uses pi-tui directly.
4. **Independent checkpoint systems.** Desktop `@dieulc/checkpoints` and
   Workflow `/rewind` keep separate authorities.
5. **Terminal-only chords.** `Ctrl+Alt+O` for the todo panel on Terminal;
   Desktop uses `Ctrl+Alt+L` and its native Todo bar.
6. **Notification classes.** D filters only the bell/toasts; every extension
   notification still prints in the transcript (documented in
   `docs/architecture/session-parity.md`).
7. **`!`/`!!` completion.** Desktop intentionally has no built-in shell
   completion; extension chains still receive `current = null`.

## 6. Maintenance rules

- `agent/extensions/workflow/fixtures/compat-baseline.json` +
  `compat-baseline.test.ts` remain the executable freeze for W command/tool/
  status/widget/role lists. A deliberate change updates both; accidental drift
  fails.
- `agent/extensions/workflow/architecture-generic-integration.test.ts` (added
  with this row) protects the generic contribution contract and W's
  host-independence: no Desktop/Electron branching, frozen kind/slot vocabulary,
  owner-scoped ids, every action command registered, no prompt-payload fields.
- Update this matrix in the same change set that changes a row's evidence.
  Never mark a row SUPPORTED from code inspection alone; a manual/platform check
  is recorded as NOT RUN until actually executed.
- Later parity rows (25–37) replace ABSENT/UNVERIFIED entries with their
  automated evidence and record real-artifact/manual results separately.
- Row 37 is a **completion gate**: an area may be `SUPPORTED`, an accepted
  intentional difference (§5 / §7.4), or an explicitly recorded `NOT RUN`
  manual/platform check (§7.3). It may not stay `ABSENT`, and a formerly
  unsupported behaviour may not be quietly deferred without an approved
  exception. Re-check §7 whenever a row changes.

## 7. Step 37 completion — final matrix

Re-run on 2026-11-24 against the **real staged artifact**
(`out/extensions/workflow`, pinned `@dieulc/workflow@0.13.0`; `npm run
workflow:verify` reports `ok`, 2 staged copies, bundled Node). The artifact was
loaded either through Pi's real `DefaultResourceLoader` (bundling/opt-out/
override/safe-mode) or through a fake `ExtensionAPI` with the real registered
commands/tools (`tests/host/workflow-artifact-parity.test.ts`,
`tests/host/refinement-cross-host.test.ts`). No row below is "supported" because
the code looks right; each names its reproducible check.

### 7.1 Final classification

| Verification area (§3) | Final class | Automated evidence (real artifact where marked) | Manual / platform |
| --- | --- | --- | --- |
| 3.1 Startup / discovery / config | SUPPORTED | real loader: fresh profile, `-builtin:workflow`, installed real copy replaces once, trust-gated project opt-out, safe mode, reload, checkpoint coexistence (`workflow-builtin-loader.test.ts`); hub/opt-out/absence (`workflow-builtin.test.ts`, `sdk-workflow-builtin.test.ts`) | packaged clean profile/offline: **NOT RUN** (row 39) |
| 3.2 Default/Plan/Build/Orchestrator | SUPPORTED | real artifact ring + Tab/`/workflow-cycle`, per-mode tool sets, zero execution (`workflow-artifact-parity.test.ts`); W `mode-cycle.test.ts`, `extension.test.ts` | none beyond the modes themselves |
| 3.3 Role / profile / default model | SUPPORTED | real artifact `/role`, `/profile`, `/prompt-model set` isolation; W `roles/profiles/model-default/default-mode-model` tests | live model pickers: **NOT RUN** (UI-only) |
| 3.4 Questionnaires | SUPPORTED | real artifact questionnaire tool through `ctx.ui.custom` (selected, cancelled, no-TUI refusal); D TUI surface suites | in-app TUI QA: **NOT RUN** (row 36) |
| 3.5 Todos and progress | SUPPORTED | real artifact progress/actions; W two-store and two-session isolation; D contribution renderers | panel/hidden-state human QA: **NOT RUN** (row 36) |
| 3.6 Explore | SUPPORTED | W `subagent-launch.test.ts`, `extension.test.ts` EX1/EX2 (role routing, refusal before spawn) | packaged child launch: **NOT RUN** (row 39) |
| 3.7 Review | SUPPORTED | W `review*.test.ts` + real artifact review commands are safe no-ops with no round | live independent-provider round: **NOT RUN** (needs provider credentials) |
| 3.8 Handoff | SUPPORTED | W handoff/execution-approval tests + real artifact `/handoff status` (honest no-host) | real browser/in-app tab: **NOT RUN** (row 36) · in-app tab is an accepted difference |
| 3.9 Policies and commit | SUPPORTED | real artifact policy commands, untrusted-project refusal, `/commit` fails closed; W policy suites incl. read-grant revocation | live revocation inside a running turn: **NOT RUN** (refinement-side revocation covered) |
| 3.10 Rewind / checkpoint / btw | SUPPORTED | real artifact rewind refusals/confirmations + `/btw`; W RW1–RW3/BTW1–BTW3; D checkpoints independent | real dirty-tree human run: **NOT RUN** (row 36) |
| 3.11 Orchestrator | SUPPORTED | W `orchestrator-*.test.ts` incl. parity/child contract; real artifact mode entry + inert child controls, start refuses without a plan | live provider turn / visible child / host kill: **NOT RUN** (rows 33, 39) |
| 3.12 Refinement | SUPPORTED | W refinement suite (state→command, config, runtime, CAS apply, `/prompt-model`, zero execution); D host transform + renderer suites; **step 37** real artifact `/prompt` in Default/Plan/Build/Orchestrator and Default-mode inheritance in each mode | Playwright composer E2E and real Terminal keyboard run: **NOT RUN** (row 36) · Terminal structured images accepted difference |
| 3.13 Lifecycle / recovery | SUPPORTED | D session-core/extension-ui/contribution epoch suites; W mode/status/legacy-recovery; real artifact reload/shutdown paths | real new/resume/fork/rewind/reload/kill matrix: **NOT RUN** (row 39) |

### 7.2 Evidence added by row 37

- `C:/Users/Lenovo/Projects/pi-desktop/tests/host/workflow-builtin-loader.test.ts`
  — new `describe("real staged artifact through opt-out / override / safe
  mode")`: the shipped bundle registers exactly once on a fresh profile (with
  `/prompt`, `/prompt-model`, `/workflow-cycle`), `-builtin:workflow` removes it
  and leaves a re-enableable hub row, a **real copied install** replaces the
  builtin exactly once with Pi's provenance warning, and safe mode loads
  neither the builtin nor the installed copy.
- `C:/Users/Lenovo/Projects/pi-desktop/tests/host/refinement-cross-host.test.ts`
  — new `describe("refinement under every eligible Workflow mode")`: for
  Default, Plan, Build and Orchestrator the real artifact's `/prompt` returns
  the fixture candidate into the composer, leaves the published mode segment
  unchanged, starts exactly one isolated child on the configured refiner model,
  and produces zero parent sends/child dispatches. A second case (no override,
  `workflow.promptRefinement.model = { inherit: true }`,
  `workflow.modelDefault` set) proves each mode refines with the **Default-mode
  model** rather than that mode's role model.
- The fake host in that suite now mirrors the real `pi.setModel` contract
  (updating the live model) so a mode-entry test cannot fabricate "the live
  model differed from the persisted default". This is test-harness fidelity, not
  a product change.

### 7.3 Explicitly NOT RUN (release blockers, not silent gaps)

These are environment/time boundaries recorded by rows 36/39, not parity
findings, and are **not** claimed as passes:

| Check | Why not run here | Owner |
| --- | --- | --- |
| Live Review round against a real independent provider | requires user provider credentials/authorization | row 37 follow-up / row 39 |
| Live Orchestrator provider turn, visible child, separate window/pane, host kill | needs a real model + visible host | rows 33, 39 |
| Real browser / in-app Plannotator handoff tab | needs the optional browser integration running | row 36 |
| Packaged clean-profile, offline, no-system-Pi child launch, Windows/macOS/Linux signoff | packaging is row 39; other platforms unavailable here | row 39 |
| Playwright composer E2E and a real Terminal keyboard run | GUI/terminal interaction rows | row 36 |
| Live read-grant revocation inside a long main-agent turn | needs a live turn; the refinement-side revocation path **is** covered | rows 34, 39 |

### 7.4 Accepted exceptions (user-approved; not parity gaps)

1. **Terminal structured-image limitation.** SDK 1.5 command handlers receive
   no structured images and expose no source, so Terminal keeps its clipboard
   **image-path** UX; Desktop preserves real attachment objects. No upstream
   `node_modules` patch. Accepted in the plan's confirmed decisions.
2. **Native/TUI rendering differences.** Desktop renders TUI frames/dialogs
   with its own tokens/components; Terminal uses pi-tui directly. Equivalent
   behaviour, not identical pixels.
3. The remaining platform differences already recorded in §5 (custom editor
   recorded rather than mounted in Desktop, independent checkpoint systems,
   Terminal-only chords, notification classes, no `!`/`!!` shell completion).

Generic SDK APIs that Workflow never uses are **outside** this parity promise
and are not advertised as fully supported.

### 7.5 No quiet deferral

After row 37 every §3 area is `SUPPORTED` with a reproducible automated check,
an accepted exception above, or an explicit §7.3 `NOT RUN` ledger entry. No area
remains `ABSENT`; the two formerly absent capabilities (bundled Workflow,
prompt refinement) are implemented and exercised against the staged artifact.

The pinned-artifact ledger from row 31 still applies: the v0.13.0 bundle
predates the W `/workflow` fix, so `/workflow` appears once the bundle is
re-pinned (a release step, not a parity gap).

### 7.6 Step 40 acceptance review

Row 40 re-read this matrix, the quality record
(`docs/evaluations/2026-11-24-prompt-refinement-quality.md`), the security/
compatibility suites and the packaged/platform evidence, then re-ran every gate
available in this environment.

One reproducible failure was found and fixed (no product-behaviour change):

- **D site contract** — `docs/architecture/packaged-workflow-acceptance-2026-11-24.md`
  (the step-39 evidence record) was not listed in `site/src/data/nav.mjs`, so
  `tests/site/site-contract.test.ts` › "names every user/architecture/product
  doc in the navigation" failed. Added the missing entry; the existing contract
  test is the regression guard. No §3 parity row changed classification.

Gate results after the fix (all exit 0):

| Gate | Result |
| --- | --- |
| W `typecheck` | PASS |
| W full suite | PASS — 1636 tests, 0 fail |
| W `check:policy` | PASS — 100/100 |
| W `check:read-policy` | PASS |
| W root suite | PASS — 80 tests |
| W `verify --packages workflow` | PASS — 92 files packed |
| D `format:check` / `typecheck` / `lint` | PASS (lint: 0 errors, 9 pre-existing warnings) |
| D full suite | PASS — 6130 passed, 4 skipped, 0 fail |
| D `build` | PASS |
| D `workflow:verify` / `workflow:package:verify --dir release/win-unpacked` | PASS — 12/12 packaged rows |
| D architecture/host/packaging suites | PASS — 1145 passed, 3 skipped |

**Release readiness is still NOT claimed.** The §7.3 `NOT RUN` ledger is
unchanged: live Review provider round, live Orchestrator provider turn/visible
child/host kill, real Plannotator browser tab, packaged clean-profile/offline
cross-platform (macOS/Linux) signoff, Playwright composer E2E and real Terminal
keyboard QA, and live read-grant revocation inside a long main-agent turn. The
quality record's live-model sample and human rubric sign-off are also still
NOT RUN/PENDING. Automated fake-provider results are not semantic-quality
proof; packaged Windows was re-verified, but macOS/Linux remain release
blockers.

## 8. Delta log

| Date | Change |
| --- | --- |
| 2026-11-23 | Initial frozen inventory (row 1). |
| 2026-11-24 | Row 32: D artifact suite extended with questionnaire/todos/`/btw`/Review/`/handoff`/`/rewind` flows; W `/btw` duplicate-delivery fix plus `BTW1`–`BTW3`, `EX1`–`EX2`, `RW1`–`RW3`, `RV1`–`RV2`. |
| 2026-11-24 | Row 31: D `tests/host/workflow-artifact-parity.test.ts` exercises the command/mode/config/policy inventory against the staged artifact. Found and fixed W `/workflow` being registered only as a `/plan`-conflict fallback (Desktop had no `/workflow`); W `compat-baseline.test.ts` + fixture and CHANGELOG updated. Pinned-artifact ledger: the v0.13.0 bundle predates that fix, so `/workflow` appears after the next re-pin. |
| 2026-11-24 | **Row 37:** closed the matrix against the real staged artifact. §3.1 and §3.12 updated from `ABSENT` to implemented; §3.5 two-session isolation cited (W `todo-service.test.ts`, `extension-factory-safety.test.ts`). New real-artifact evidence: builtin opt-out/installed-override/safe-mode paths with the shipped bundle, and `/prompt` under Default/Plan/Build/Orchestrator including Default-mode-model inheritance in each mode. §7 records the final classification, NOT RUN ledger and accepted exceptions. No product regression required a fix; the only adjustment was fake-host `setModel` fidelity in the D cross-host suite. |
| 2026-11-24 | **Row 40:** acceptance review of this matrix, the quality record, security/compat suites and platform evidence; re-ran all available W and D gates. Fixed one scoped failure — the step-39 evidence doc was missing from the D site navigation, breaking `tests/site/site-contract.test.ts`; added `site/src/data/nav.mjs` entry (contract test is the regression). §7.3 NOT RUN ledger unchanged; release readiness still not claimed. Results in §7.6. |
