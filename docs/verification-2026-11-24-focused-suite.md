# Focused verification — typecheck + core suite (workflow extension)

> Recorded by orchestrator row 8 of a standalone run (task-8).
> Purpose: make the "run focused verification and record exact results" step
> reproducible and auditable instead of leaving the output only in a chat log.

## Scope

The four suites that cover the extension entry point, the reviewer, the
orchestrator activity panel and the tab/editor composer:

| File | Covers |
| --- | --- |
| `extension.test.ts` | extension factory wiring, tools, commands, mode entry |
| `review.test.ts` | independent Review Mode reviewer (provider seeding, gates, runtime, lifetime) |
| `orchestrator-activity.test.ts` | orchestrator activity/progress surface |
| `tab-editor.test.ts` | Tab-cycle composer, prompt history, border, Esc/pause behaviour |

Run from the package directory so `tsconfig.json` and `node_modules` resolve:

```bash
cd agent/extensions/workflow
```

## Command 1 — typecheck

```bash
npm run typecheck
```

Output:

```
> @dieulc/workflow@0.13.0 typecheck
> tsc --noEmit -p tsconfig.json
```

- exit status: **0**
- diagnostics: **none**
- `tsc` version pinned by the package: `typescript@5.5.4`

## Command 2 — focused suite

```bash
node --test extension.test.ts review.test.ts orchestrator-activity.test.ts tab-editor.test.ts
```

Summary block:

```
ℹ tests 367
ℹ suites 0
ℹ pass 367
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 33291.9338
```

- exit status: **0**
- last executed test: `✔ key-release Esc does not pause`
- no `not ok` lines, no unhandled rejections, no warnings

## Result

Both commands are green: typecheck clean, 367/367 focused tests passing,
0 failures, 0 skipped, 0 todo.

## How to re-verify

```bash
cd agent/extensions/workflow \
  && npm run typecheck \
  && node --test extension.test.ts review.test.ts orchestrator-activity.test.ts tab-editor.test.ts
```

The full suite is available as `npm test` in the same directory
(108 test files) if a broader regression sweep is needed.

## Notes

- Durations vary by machine; counts and exit statuses are the stable signal.
- These four files are a fast gate, not a replacement for `npm test`.
- If `orchestrator-activity.test.ts` or `tab-editor.test.ts` is renamed, update
  the command in this document and in the row's checklist.
