---
name: browser-inspector
description: Inspect browser DevTools (console, network, screenshots) via CDP. Use when debugging frontend errors, failed API calls, or testing web apps. Supports both a fresh automated browser and your real logged-in session.
---

# Browser Inspector

Lets the AI agent inspect a live browser's console logs, network requests, and screenshots via the Chrome DevTools Protocol (CDP).

## Two modes

| Mode | Use case | How |
|------|----------|-----|
| **Fresh browser** (default) | Automate & test a web app | Agent launches its own Chromium with a temp profile |
| **Real session** | Debug your actual logged-in app | Chrome extension relays DevTools events from your real browser |

> **Why two modes?** Chrome 136+ blocks remote debugging on your default (logged-in) profile. So inspecting your *real* session requires a Chrome extension. The fresh-browser mode needs no browser-side setup.

## Setup

### Fresh browser (no setup)

```bash
pi -e ./browser-inspector/src/index.ts --browser-inspector
```

With an initial URL:

```bash
pi -e ./browser-inspector/src/index.ts --browser-inspector --browser-url https://localhost:3000
```

**Requirements:** Node 18+, Chromium/Chrome installed. Dependencies (`chrome-launcher`, `chrome-remote-interface`, `ws`) are bundled in the extension's `package.json`.

### Real session (Chrome extension required)

1. Load the extension in Chrome:
   - Open `chrome://extensions` → enable **Developer mode**
   - **Load unpacked** → select the `browser-inspector/extension/` directory
2. Start Pi with the extension:

   ```bash
   pi -e ./browser-inspector/src/index.ts --browser-inspector
   ```

3. The agent calls `browser_attach` → gives you a relay port
4. Open DevTools (F12) on the tab to inspect → go to the **Pi Browser Inspector** panel → connect with the port

## Tools

### Fresh browser

| Tool | Purpose |
| ------ | --------- |
| `browser_launch` | Launch Chromium, start capturing |
| `browser_navigate` | Navigate to a URL |
| `browser_console_logs` | Get console logs (filter by level/text) |
| `browser_console_errors` | Get errors only, grouped by signature |
| `browser_network_requests` | Get network requests (filter by URL/status/type) |
| `browser_screenshot` | Take a screenshot |
| `browser_close` | Close the browser |

### Real session

| Tool | Purpose |
| ------ | --------- |
| `browser_attach` | Start WebSocket relay, returns port for the extension |
| `browser_detach` | Stop the relay |
| `browser_console_logs` | Same tools work for both modes |
| `browser_console_errors` | ↑ |
| `browser_network_requests` | ↑ |

### Diagnostics

Run `/browser-doctor` in the Pi TUI to check: Node version, installed deps, Chrome path, extension presence, current state.

## Examples

```javascript
// Fresh browser: launch and test
browser_launch: { url: "https://localhost:3000", headed: true }
browser_navigate: { url: "https://localhost:3000/dashboard" }
browser_console_errors: { groupBy: true }
browser_network_requests: { status: "5xx" }
browser_screenshot: { fullPage: false }

// Real session: attach to your logged-in app
browser_attach: { port: 9234 }
// → connect the Chrome extension to port 9234
browser_console_logs: { level: "error", limit: 20 }
browser_network_requests: { filter: "/api/", status: "4xx" }
```

## Notes

- Console and network logs are buffered in memory (up to 2000 entries each) while the browser/relay is active.
- Output is capped at 50,000 characters. Truncation is reported.
- The fresh-browser mode uses a temporary profile — no cookies, logins, or extensions from your real browser.
- The real-session mode captures events while DevTools is open on the inspected tab.
