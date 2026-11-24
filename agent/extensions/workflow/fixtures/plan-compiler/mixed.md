# Plan: Mixed authoring

## Context

A plan may combine fenced commands, whole-bullet code spans, a typed row check
and prose evidence. The compiler must keep all of them, and must never execute
the prose.

## Plan Steps

### 1. Prepare the fixture
Checks: `npm run prepare`
Acceptance: the fixture explains itself; it stays prose
Files: fixtures/plan-compiler/mixed.md
Workspaces: W

### 2. Execute it
- [x] a checkbox line inside a row is body content, not a second row

## Verification

Workspace: W
- `npm test`
- npm run lint
- This prose bullet is documentation, not a command.

```checks
checks:
  - id: unit
    command: node --test plan-compiler.test.ts
    expectedExitCode: 0
```
