# Plan: Execution contract golden

## Context

One plan that exercises every part of the compiled artifact: rows with typed
checks, prose acceptance criteria, expected files, workspace tags, a plan-level
gate and a diagnostic typed block. It is frozen once and compared byte-for-byte
so a compiler/preview/freeze change cannot silently alter what will run.

## Plan Steps

### 1. Add the contract
Checks:
- `npm test`
- npm run lint
Acceptance: the contract parses; prose stays evidence
Files: plan-spec.ts, frozen-snapshot.ts
Workspaces: W

### 2. Validate the contract
Checks: `node --test plan-spec.test.ts`
Files: plan-spec.test.ts

## Verification

Workspace: W
- `npm run typecheck`

```checks
checks:
  - id: docs
    command: pnpm check:docs-reference
    kind: diagnostic
    timeoutMs: 900000
```

## Risks

- None.
