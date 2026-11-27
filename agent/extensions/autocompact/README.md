# @dieulc/autocompact

Intelligent session context compaction for Pi. Overflow-proof bounded summarization, proactive pre-warming, plan/todo-aware summaries, cheap model override, and rich UX.

## Features

- **Structured summary**: Goals, Constraints, Progress (Done/In-Progress/Blocked), Key Decisions, Next Steps, Critical Context + cumulative Files Read/Modified
- **Plan/todo preservation**: Extracts plan-mode todos (`[DONE:n]`) and plan files verbatim — appended deterministically so they survive even a degraded summary
- **Overflow-proof**: Every summarizer request is bounded to the model's context window; when the conversation doesn't fit, it is summarized in sequential chunks (fold-reduce). If LLM summarization fails entirely, a deterministic fallback summary keeps the session usable — a full context window can no longer brick the session
- **Idle pre-warming**: Proactively compacts at 70% context (`agent_settled` + debounce), with a hard trigger at 90% that bypasses the debounce and a poll-until-idle re-arm so active use never starves it
- **Self-heal**: One bounded retry after a failed native compaction (threshold/overflow)
- **Cheap model override**: Use `autocompact.model` to route summarization to a cheaper/faster model
- **Status UX**: Footer shows context percent; `/autocompact status` shows thresholds, chunk cap, and the last compaction's strategy
- **Manual commands**: `/autocompact status|on|off|compact|preview`

## Install

```bash
pi install npm:@dieulc/autocompact            # latest
pi install npm:@dieulc/autocompact@0.3.0      # pinned
pi install -l npm:@dieulc/autocompact         # project-local (.pi/settings.json)
pi -e npm:@dieulc/autocompact                 # try without installing
```

Manage it with `pi list`, `pi update --extensions`, `pi remove npm:@dieulc/autocompact`. Requires Pi on Node ≥ 22.19; the Pi core packages (`@earendil-works/*`, `typebox`) are provided by Pi at runtime and declared as peer dependencies.

## Settings

Add to `~/.pi/agent/settings.json` or `<project>/.pi/settings.json`:

```json
{
  "autocompact": {
    "enabled": true,
    "prewarmThreshold": 0.7,
    "hardTriggerThreshold": 0.9,
    "prewarmDebounceMs": 15000,
    "maxSummarizerChunks": 8,
    "model": "google/gemini-2.5-flash",
    "showStatus": true
  }
}
```

| Setting | Default | Description |
| --------- | --------- | ------------- |
| `enabled` | `true` | Master switch (also falls back to `compaction.enabled`) |
| `prewarmThreshold` | `0.7` | Context fraction at which idle pre-warming is scheduled |
| `hardTriggerThreshold` | `0.9` | Context fraction at which compaction fires immediately, bypassing the debounce |
| `prewarmDebounceMs` | `15000` | Minimum time between threshold-triggered pre-warms |
| `maxSummarizerChunks` | `8` | Max fold chunks before middle parts are collapsed into a digest |
| `reserveTokens` | `16384` | Compaction reserve (also read from `compaction.reserveTokens`) |
| `keepRecentTokens` | `20000` | Recent tail kept out of summarization (also `compaction.keepRecentTokens`) |
| `model` | – | Summarizer model override (`provider/id`); defaults to the current model |
| `showStatus` | `true` | Footer status item |

## Commands

| Command | Description |
| --------- | ------------- |
| `/autocompact` | Show status (context usage, thresholds, last compact time + strategy) |
| `/autocompact on` | Enable autocompact |
| `/autocompact off` | Disable autocompact |
| `/autocompact compact [focus]` | Manual compaction with optional focus |
| `/autocompact preview` | Preview serialization size estimate |

## How It Works

1. **Hook ownership**: `session_before_compact` intercepts ALL compaction (threshold, overflow, manual). While enabled, the hook always answers — core's default summarizer sends the whole conversation in one unbounded request and cannot succeed once the context is full, so deferring to it would leave the session stuck.
2. **Bounded summarization**: the conversation is serialized (tool results truncated, oversized messages marked) and measured against a per-call budget of `contextWindow − reserveTokens − outputReserve − safety margin`. Single call when it fits; otherwise sequential **fold-reduce** chunks that carry the running summary forward (capped at `maxSummarizerChunks`, middle parts collapsed into a digest).
3. **Validation**: error stops and length stops are rejected (a length-capped summary is partial and must not become the session checkpoint); overflow errors retry with a halved excerpt before giving up.
4. **Deterministic fallback**: if the LLM path fails entirely, a no-LLM summary (previous summary + todos/plan + file lists + recent user messages + a degradation notice) is returned — the session always continues. The strategy (`single`/`fold`/`fallback`) is recorded in the compaction details and shown by `/autocompact status`.
5. **Triggers**: pre-warm at `prewarmThreshold` on `agent_settled` (debounced, polls until idle instead of dropping the attempt), hard trigger at `hardTriggerThreshold` bypassing the debounce, plus one self-heal retry when core reports a failed compaction.
6. **Cumulative file tracking**: previous compaction details are merged back into the file lists, so Files Read/Modified accumulate across compactions.

## Development

```bash
cd agent/extensions/autocompact
npm install
npm test           # node --test summarizer.test.ts trigger.test.ts
npm run typecheck   # tsc --noEmit
```

Plain TypeScript, no build step — Pi loads `extensions/autocompact.ts` directly (via jiti). From the repo root, `npm run verify` checks this package's manifest, tarball contents and load path before a release. Live reload: edit the `.ts` file and run `/reload` in Pi.

## License

MIT — see [LICENSE](./LICENSE).
