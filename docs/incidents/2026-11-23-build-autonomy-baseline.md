# Baseline: Build autonomy and shell-quarantine work (2026-11-23)

Audit time: 2026-11-23T02:36:31Z. This note is the step-1 baseline for
`.pi/plans/2026-11-23-build-autonomy-shell-resilience.md`.

## Artifact provenance

- Repository: `C:/Users/Lenovo/.pi`
- Branch: `feature/orchestrator-mode`
- HEAD: `81336d4eaa78` (`fix(workflow): actually launch the Build child and make dispatch and retry honest`)
- Describe: `@dieulc/workflow@0.13.0-16-g81336d4`
- Working tree: clean (`git status --porcelain=v1` produced zero entries).
- Workflow package: `agent/extensions/workflow`, version `0.13.0`.
- Installed Pi SDK used by the extension: `@earendil-works/pi-coding-agent` `1.5.0`.
- Runtime tools: Node `v24.22.2`, npm `11.19.1`.
- The orchestrator simplification is committed at `3dfcbfd`; the child
  launch/dispatch fix is committed at `81336d4`. No source edits were made for
  this baseline.
- Recent session files exist under `agent/sessions/`, including SDK worker
  sessions. The process table shows several `node.exe` processes, but it cannot
  safely attribute an editing host. The source tree is clean, so this run is
  treating itself as the single source writer for the plan. Do not start a
  second source-modifying workflow run concurrently.

## Preserved contracts

- The SDK `SessionManager` class/constructor loader and Builder model/provider
  resolution are committed and must not be reverted.
- The frozen-row and neutral Build/Orchestrator handoff contracts are committed.
- Unrelated `.fix*.cjs` / `.patch*.cjs` files exist in
  `agent/extensions/workflow/`; they were not deleted or restaged.
- Commit policy is `never`; no `git add`, `git commit`, or `git push` was run.

## Baseline gates

Run from `agent/extensions/workflow` at the HEAD above:

| Gate | Result |
|---|---|
| `npm run typecheck` | exit 0, no diagnostics |
| Focused: `compat-baseline.test.ts shell-guard.test.ts shell-guard-config.test.ts todo-snapshot.test.ts` | 61 passed, 0 failed |
| Full `npm test` | 1278 passed, 0 failed, 0 cancelled, 0 skipped, 64,423.7 ms |

The focused run includes the current guard behavior that this plan will
intentionally change: “a second, different failure also trips” and the
extension-level “second failure stops the request” assertions. Those tests are
expected to be updated to quarantine-without-abort semantics in steps 10–13 and
22, not deleted.

No pre-existing test failures were observed. There are no blocked prerequisites
for step 2.

## `fixtures/compat-baseline.json` surface

- Fixture version: `1`; capturedAt: `2026-11-22`; SDK pin: `1.5.0`.
- Registered tools: `explore`, `orchestrator_accept`, `orchestrator_checkpoint`,
  `orchestrator_repair`, `orchestrator_report`, `orchestrator_retry`,
  `orchestrator_start`, `orchestrator_status`, `orchestrator_verify`,
  `questionnaire`, `workflow_todo`, `workflow_worker_ready`.
- Commands: `btw`, `build`, `commit`, `commit-policy`, `default`,
  `folder-policy`, `handoff`, `orchestrator`, `permissions`, `plan`, `profile`,
  `read-policy`, `review`, `review-abort`, `review-mode`, `review-pause`,
  `review-prompt`, `review-resume`, `review-status`, `rewind`, `role`,
  `shell-guard`, `todos`, `workflow-bridge`, `workflow-cycle`, `write-policy`.
- Built-in roles: `builder`, `explorer`, `orchestrator`, `planner`, `reviewer`.
- Profile roles: `planner`, `explorer`, `builder`, `reviewer`, `orchestrator`.
- Status keys: `workflow`, `workflow-profile`, `workflow-policy`,
  `workflow-review`, `workflow-todos`, `workflow-orchestrator`.
- Widget keys: `workflow-review-status`, `workflow-todos`.
- Plan and Build active tool sets currently match the fixture’s explicit
  `planActiveTools` / `buildActiveTools` arrays.

Any intentional registration change in later steps must update the fixture and
`compat-baseline.test.ts` in the same change. Unintended drift is a regression.

## Reproduction commands

```bash
git rev-parse HEAD
git status --porcelain=v1
cd agent/extensions/workflow
npm run typecheck
node --test compat-baseline.test.ts shell-guard.test.ts shell-guard-config.test.ts todo-snapshot.test.ts
npm test
```

## Follow-up baseline rule

Every later step should be compared against HEAD `81336d4eaa78` plus this
green baseline. If a gate fails later, first determine whether the failure is a
new regression, a deliberate behavior change whose tests were not updated, or
an environment-only failure. Record the command, exit status and exact failure
count rather than relying on a piped `tail`/`grep` status.
