# Plan: Typed checks block

## Plan Steps

1. Add the module
   Checks:
   - `npm test`
   - node --test "src/a,b;c.test.ts"
   Acceptance: the module is documented; the fixture stays prose
   Files: src/module.ts, tests/module.test.ts
   Workspaces: W
   ```checks
   - id: row-lint
     command: npm run lint
     kind: diagnostic
     timeoutMs: 120000
   ```
2. Wire it up

## Verification

```checks
checks:
  - id: typecheck
    command: pnpm typecheck
    kind: gate
    workspace: W
  - id: docs
    command: 'pnpm check:docs-reference'
    timeoutMs: 900000
```

```bash
npm run build
```
