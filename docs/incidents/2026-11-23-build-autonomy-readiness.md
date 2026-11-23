# Build autonomy and shell quarantine — readiness record (2026-11-23)

## Delivered behavior

- Direct Build continuation at the real `agent_before_settle` boundary, with a
  `continue:true` nudge and no routine “continue” prompts.
- Two-attempt shell cap preserved; the second failure quarantines shell for the
  execution instead of aborting the run. Non-shell tools remain available.
- Required shell checks leave their row/run **blocked/unverified**; no green
  card. `/shell-guard reset` is the explicit new shell budget.
- `/build status|pause|resume|stop`, `workflow_execution` status/checkpoint/
  verify/blocker, runtime-owned row evidence, final gate before completion.
- Reload/reopen/fork restores paused; one explicit Resume continues non-shell
  work.
- Exact check payloads, overflow rejection, persisted frozen state, shell
  quarantine persistence, child environment inheritance and settled-fence
  candidate delivery.

## Automated evidence

| Gate | Result |
|---|---|
| Workflow typecheck | clean |
| Workflow full suite (`npm test`) | **1319 passed, 0 failed** |
| Real-SDK faux provider (`composed-provider.test.ts`) | **1 passed** — `agent_before_settle` caused a second provider request |
| Root script tests (`npm test` at repo root) | **80 passed, 0 failed** |
| `npm run verify -- --packages workflow` | **1/1 package passed; 81 files packed** |
| `npm run check:read-policy` | all checks passed |
| LSP diagnostics on changed modules | 0 findings, **7 inconclusive** (push-only/silent server); not proof of clean |
| `git diff --check` | no whitespace errors (line-ending warnings only) |

Not run: `check:policy` (writes live settings; requires a disposable
HOME/USERPROFILE/PI_CODING_AGENT_DIR).

## NOT RUN — live-host acceptance (release blockers)

These were not claimed as passing:

- Real TUI Plan → approval → Build 20-step walkthrough.
- Real visible Orchestrator/Desktop child window, focus, cleanup and child
  restart.
- Real provider/model turns (only the credential-free faux provider was used).
- A real second shell timeout in a TUI after the source reload.
- Real `/build` controls and `/shell-guard reset` in a terminal host.
- Packaged Desktop E2E and cross-platform signoff.

The automated suites exercised the actual extension factory, boundary event,
real `createAgentSession` host boundary, frozen rows, evidence gate, final gate,
reload pause and shell quarantine. They did not exercise a human-driven TUI or
a real provider.

## Workspace / release

All changes are uncommitted for user review. No commit, tag, push or npm publish
was performed (commit policy `never`). Version remains `@dieulc/workflow@0.13.0`.
