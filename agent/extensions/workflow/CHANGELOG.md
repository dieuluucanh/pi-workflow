# Changelog

All notable changes to this package are documented in this file.

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
- **Dual-pane Review Workspace** — `/review-pane` (or `Ctrl+Shift+R`) opens a
  two-column overlay: Plan Mode transcript on the left, reviewer transcript on
  the right, each with independent scrolling. Implemented by composing columns
  manually because pi's default TUI cannot do constrained side-by-side panes.
- **Commands** — `/review-mode on|off|status`, `/review-prompt`, `/review-pane`,
  `/review-status`, `/review`.
- **Settings** — `workflow.reviewMode.{enabled,parallel,rounds,passes,verify,autoOpenPane,fallbackOnError,exploreBudget,timeoutMs}`.
- **Reviewer guidance** — `.pi/review-prompt.md` (project) or
  `~/.pi/agent/review-prompt.md` (global), defaulting to the built-in prompt that
  asks the reviewer to align with the existing framework and industry best practice.
- **Never blocks the plan** — every failure path (missing model, unauth'd
  provider, session error, timeout, abort) returns the author's plan unchanged
  with a warning. No round can hang: each pass is bounded by `timeoutMs`.

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
