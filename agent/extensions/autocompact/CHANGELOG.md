# Changelog

All notable changes to this package are documented in this file.

## [0.3.0] - 2026-10-10

### Fixed

- **Overflow-proof compaction**: the `session_before_compact` hook now always answers while enabled. Summarizer input is bounded to the model's context window, so a compaction triggered *because* the context is full no longer sends an unbounded prompt that fails with the same overflow error and bricks the session.
- **Deterministic fallback summary**: when LLM summarization fails entirely (overflow, rate limits, empty/partial responses), a no-LLM continuation summary (previous summary + todos/plan + file lists + recent user messages) is returned instead — the session always continues.
- **Reliable pre-warming**: removed the token high-water mark that suppressed pre-warm until the previous session peak was exceeded; a pending attempt now polls until the agent is idle instead of being silently dropped; added a hard trigger threshold (default 90%) that bypasses the debounce.
- **Self-heal**: after a failed native compaction (threshold/overflow), autocompact retries once via the manual path after a short backoff.
- Cumulative read/modified file tracking no longer resets at each hook-sourced compaction (previous compaction details are merged back).
- Real provider error messages are surfaced instead of a generic "summary was empty"; length-stopped (partial) summaries are never persisted.
- Summarizer output budget mirrors core (`min(0.8 × reserveTokens, model.maxTokens)`) instead of a hardcoded 8192; summarizer calls now carry a system prompt.

### Added

- `autocompact.hardTriggerThreshold` (default `0.9`) and `autocompact.maxSummarizerChunks` (default `8`) settings.
- Chunked fold-reduce summarization: conversations larger than one window-sized request are summarized sequentially, carrying the running summary forward, with a middle-digest cap.
- `/autocompact status` now shows the hard threshold, chunk cap, and the last compaction's strategy (single/fold/fallback + reason).
- Unit tests (`npm test`) for the summarizer and trigger state machines.

### Changed

- Dev dependencies aligned to `@earendil-works/*` ^1.1.0 so extension imports match the running Pi core.

## [0.2.1] - 2026-09-20

- No user-facing changes recorded.

## [0.2.0] - 2026-09-16

Initial release.

## [0.1.0] - 2026-09-16

Initial release.
