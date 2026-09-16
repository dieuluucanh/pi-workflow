# @dieulc/browser-inspector

Pi extension that lets the agent inspect a live browser — console logs, network requests, and screenshots — via the Chrome DevTools Protocol (CDP).

[![pi-package](https://img.shields.io/badge/pi--package-blue)](https://pi.dev/packages)

## Two modes

| Mode | Use case | How |
| --- | --- | --- |
| **Fresh browser** (default) | Automate & test a web app | The agent launches its own Chromium with a temporary profile |
| **Real session** | Debug your actual logged-in app | A bundled Chrome extension relays DevTools events from your real browser |

> **Why two modes?** Chrome 136+ blocks remote debugging on your default (logged-in) profile. Inspecting your *real* session therefore requires a Chrome extension. Fresh-browser mode needs no browser-side setup.

## Install

```bash
pi install npm:@dieulc/browser-inspector          # latest
pi install npm:@dieulc/browser-inspector@0.1.0    # pinned
pi install -l npm:@dieulc/browser-inspector       # project-local (.pi/settings.json)
pi -e npm:@dieulc/browser-inspector               # try without installing
```

The package declares `chrome-launcher`, `chrome-remote-interface`, and `ws` as runtime dependencies; Pi installs them automatically. Manage it with `pi list`, `pi update --extensions`, `pi remove npm:@dieulc/browser-inspector`.

## Usage

### Fresh browser (no setup)

```bash
pi --browser-inspector
```

With an initial URL:

```bash
pi --browser-inspector --browser-url https://localhost:3000
```

**Requirements:** Node 18+, Chromium/Chrome installed.

### Real session (Chrome extension required)

1. Load the extension in Chrome:
   - Open `chrome://extensions` → enable **Developer mode** → **Load unpacked**
   - Select the `extension/` directory shipped with this package (repo: `agent/extensions/browser-inspector/extension/`; installed: `<pi config dir>/agent/npm/node_modules/@dieulc/browser-inspector/extension/`)
2. Start Pi (the extension is active once installed).
3. Ask the agent to attach — it calls `browser_attach` and gives you a relay port.
4. Open DevTools (F12) on the tab to inspect → **Pi Browser Inspector** panel → connect with that port.

## Tools

| Tool | Mode | Purpose |
| --- | --- | --- |
| `browser_launch` | fresh | Launch Chromium, start capturing |
| `browser_navigate` | fresh | Navigate to a URL |
| `browser_console_logs` | both | Console logs (filter by level/text) |
| `browser_console_errors` | both | Errors only, grouped by signature |
| `browser_network_requests` | both | Network requests (filter by URL/status/type) |
| `browser_screenshot` | fresh | Take a screenshot |
| `browser_close` | fresh | Close the browser |
| `browser_attach` | real | Start the WebSocket relay, returns the port |
| `browser_detach` | real | Stop the relay |

Run `/browser-doctor` in the Pi TUI to check Node version, installed dependencies, Chrome path, extension presence, and current state.

## Examples

```javascript
// Fresh browser
browser_launch: { url: "https://localhost:3000", headed: true }
browser_navigate: { url: "https://localhost:3000/dashboard" }
browser_console_errors: { groupBy: true }
browser_network_requests: { status: "5xx" }
browser_screenshot: { fullPage: false }

// Real session
browser_attach: { port: 9234 }
browser_console_logs: { level: "error", limit: 20 }
browser_network_requests: { filter: "/api/", status: "4xx" }
```

## Notes

- Console and network logs are buffered in memory (up to 2000 entries each) while the browser/relay is active.
- Output is capped at 50,000 characters. Truncation is reported.
- Fresh-browser mode uses a temporary profile — no cookies, logins, or extensions from your real browser.
- Real-session mode captures events while DevTools is open on the inspected tab.

## Development

```bash
cd agent/extensions/browser-inspector
npm install
npm run typecheck
```

Plain TypeScript, no build step — Pi loads `src/index.ts` directly. Live check:

```bash
pi -e ./src/index.ts --browser-inspector
```

## License

MIT — see [LICENSE](./LICENSE).
