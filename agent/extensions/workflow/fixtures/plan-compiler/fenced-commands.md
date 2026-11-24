# Plan: Fenced commands only

## Context

Every current plan carries its gates as fenced command lines. That surface must
stay first-class: a compiler that only reads typed blocks would silently freeze
these plans with zero gates.

## Plan Steps

1. Run the typecheck
2. Run the suite

## Verification

```bash
npm run typecheck
[W] node --test "suite with spaces.test.ts"
```

- `npm run lint`

## Risks

- None.
