# Incident: unbounded shell probes hung the agent (2026-11-20)

**Status:** resolved by `workflow.shellGuard` (finite deadlines + empty-probe refusal).
**Scope:** Pi Workflow shell tools in the `erp-atom` project. The investigation was
reported from the `erp-atom` repository; the fix lives in `~/.pi`.

## Session

- Project: `C:/Users/Lenovo/Projects/erp-atom`
- Session: `01a1f3e3-4cd9-7469-bd50-e9b83b96b138`
- File: `~/.pi/agent/sessions/--C--Users-Lenovo-Projects-erp-atom--/2026-11-19T12-58-42-265Z_01a1f3e3-4cd9-7469-bd50-e9b83b96b138.jsonl`
- Model at the incident: `synthetic/hf:deepseek-ai/DeepSeek-V4.1-Flash-1017` (`openai-completions`).

## Timeline (UTC)

| Time | Event |
| --- | --- |
| 2026-11-20 02:39:46 | Bash call, no `timeout`, empty Python heredoc followed by a grep |
| 2026-11-20 03:32:14 | Call returns `Command aborted`; `durationMs = 3147487` (**52m27s**) |
| 2026-11-20 03:32:24 | User: “it looks like you are stuck at last command” |
| 2026-11-20 03:53:31 | Second Bash call, no `timeout`, another empty Python heredoc |
| 2026-11-20 04:15:28 | Call returns `Command aborted`; `durationMs = 1315758` (**21m56s**) |
| 2026-11-20 04:15:38 | User: “it looks like you are stuck at last command again” |

## Commands (shape preserved, sanitized)

```bash
# 1 — 52 minutes
cd /c/Users/Lenovo/Projects/erp-atom 2>/dev/null || cd .; python - <<'EOF' 2>/dev/null || true
EOF
grep -n "0016_invoice_dimensions.sql" modules/finance/module.manifest.json

# 2 — 22 minutes
python - <<'PY' 2>/dev/null || true
PY
grep -n "INSERT INTO core_documents" migrations/modules.finance/0018_invoice_documents.sql
```

Both heredocs are syntactically valid and deliberately empty. They run an
interpreter with nothing to execute, before a plain grep. `2>/dev/null` hides
diagnostics; `|| true` hides a nonzero exit but cannot release a process that
never exits.

## Root cause

**Confirmed:** a foreground Bash tool call can wait without a deadline. Pi's
built-in Bash tool has **no default timeout**; its native backend arms timeout
and process-tree cancellation only when a timeout is supplied. Workflow supplied
neither a default nor a hang breaker for unrestricted Default/Build sessions.
The agent was waiting for a tool result, not demonstrably looping in the model.

**Not established:** which subprocess stalled. No PIDs, stacks, or syscall
traces were recorded. Empty stdin normally reaches EOF immediately. Current
read-only resolution finds a real Python 3.13 install at
`C:/Users/Lenovo/AppData/Local/Programs/Python/Python313/python.exe`, not a
Windows Store alias. The model's “malformed probe” explanation is unsupported:
the command text is valid, and the sessions do not contain a parse or launch
error.

## Recurrence conditions

Any foreground command that waits indefinitely while the model omits its
optional timeout: interpreter stdin (Python/Node), credential prompts, network
tools, stuck tests/builds, or a child that never closes its pipes. Repeated
timeouts also consume unbounded total time unless recovery is bounded.

## Prevention

`workflow.shellGuard` (see the workflow README):

- 120 s default deadline, 900 s default ceiling, finite hard bound 3600 s.
- Applied to main `bash`/`powershell`, explorer children, and `review_bash`.
- Provably empty direct interpreter-stdin heredocs are refused before launch.
- First qualifying failure allows one changed approach; an identical retry or a
  second qualifying failure stops automatic execution for that request.
- Timeouts never replay the command automatically and never roll back effects;
  partial output is preserved and the model is told to inspect the result.

## Verification (automated, 2026-11-20)

Run from `agent/extensions/workflow` unless noted:

- `npx tsc --noEmit -p tsconfig.json` — pass.
- `npm test` — **981 passing, 0 failing** (baseline before the change: 934).
- `npm run verify -- --packages workflow` (repo root) — **39 files packed, package gate ok**.
- Active LSP: 6 changed files probed, **0 confirmed diagnostics**, all 6 *unconfirmed*
  by a push-only/silent-on-clean server. `index.ts` still exceeds the 5000-line
  LSP limit; typecheck is the authoritative check.
- Real native shell tests: a silent waiting child, a continuously producing
  child (output does **not** renew the deadline), partial-output retention,
  and a legitimate non-empty heredoc all behaved as required.

The native tests use owned Node fixtures with 0.3–0.4 s deadlines and an
independent 10 s test timeout. They never execute the historical Python probes.

## Remaining manual rollout (not yet performed)

The implementation session's actual cwd is the `erp-atom` repository, not
`~/.pi`, so the plan's safe-session prerequisite could not be met. Automatic
commits were already disabled (`commitPolicy: never`), and nothing in
`erp-atom` was edited or staged. The extension must now be reloaded in a
Terminal Pi session:

1. `/reload` in ~/.pi (or start a new Pi there).
2. `/shell-guard status` → `120s default · 900s maximum`, source `default`,
   covers main/explorer/reviewer.
3. Paste a command shaped like incident 1 with a temp-safe `cd` (do not run
   the original against Python): it must be refused as an *empty interpreter
   probe* without launching Python.
4. Run a direct `grep`/`read` → allowed, timeout 120.
5. Run a non-empty script → allowed.
6. Trip the guard deliberately twice (invalid `timeout: 0` is the cheap way),
   confirm the second failure stops the request and `/shell-guard reset` works
   while idle.
7. Confirm permission/questionnaire dialogs are not affected and a normal
   next prompt works.
8. For reviewer/explorer coverage, use controlled fixtures — not an unbounded
   live provider loop — and confirm `/review-status`/handoff remains sane.

Do not claim already-running sessions are protected before the reload.
