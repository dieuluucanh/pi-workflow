# @pi/autocompact

Intelligent session context compaction for Pi. Proactive pre-warming, plan/todo-aware summarization, cheap model override, and rich UX.

## Features

- **Structured summary**: Goals, Constraints, Progress (Done/In-Progress/Blocked), Key Decisions, Next Steps, Critical Context + cumulative `<read-files>/<modified-files>`
- **Plan/todo preservation**: Extracts plan-mode todos (`[DONE:n]`) and plan files verbatim
- **Idle pre-warming**: Proactively compacts at 70% context (15s debounce on `agent_settled`)
- **Cheap model override**: Use `autocompact.model` to route summarization to a cheaper/faster model
- **Status UX**: Footer shows context percent + reserve headroom
- **Manual commands**: `/autocompact status|on|off|compact|preview`

## Install

```bash
pi install /path/to/pi-autocompact        # local
pi install npm:@pi/autocompact            # npm (when published)
pi -e ./extensions/autocompact.ts         # temp (one run)
```

## Settings

Add to `~/.pi/agent/settings.json` or `<project>/.pi/settings.json`:

```json
{
  "autocompact": {
    "enabled": true,
    "prewarmThreshold": 0.7,
    "prewarmDebounceMs": 15000,
    "model": "google/gemini-2.5-flash",
    "showStatus": true
  }
}
```

## Commands

| Command | Description |
| --------- | ------------- |
| `/autocompact` | Show status (context usage, last compact time) |
| `/autocompact on` | Enable autocompact |
| `/autocompact off` | Disable autocompact |
| `/autocompact compact [focus]` | Manual compaction with optional focus |
| `/autocompact preview` | Preview serialization size estimate |

## How It Works

1. **Threshold**: Relies on Pi's native `shouldCompact` check (`contextTokens > window - reserveTokens`)
2. **Overflow**: Supplies smarter summary via `session_before_compact` when `reason:"overflow"`
3. **Idle pre-warming**: On `agent_settled`, if context > 70%, triggers proactive compaction
4. **Summarization**: Uses structured prompt with plan/todo extraction + cumulative file tracking
