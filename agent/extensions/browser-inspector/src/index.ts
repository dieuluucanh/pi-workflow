/**
 * Browser Inspector Extension (fresh-browser mode)
 *
 * Lets the AI agent launch a fresh Chromium instance, drive it via the
 * Chrome DevTools Protocol (CDP), and inspect console logs, network
 * requests, and screenshots. Uses chrome-launcher + chrome-remote-interface.
 *
 * This is the "automate & test" mode — it launches its own browser with a
 * temporary profile, so it does NOT see your logged-in session. For that,
 * use the real-session mode (Phase 3).
 *
 * Tools: browser_launch, browser_navigate, browser_console_logs,
 *        browser_console_errors, browser_network_requests,
 *        browser_screenshot, browser_close
 *
 * Usage:
 *   pi -e ./browser-inspector/src/index.ts --browser-inspector
 *   pi -e ./browser-inspector/src/index.ts --browser-inspector --browser-url https://example.com
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// ---------------------------------------------------------------------------
// Real-session mode: WebSocket relay state
// ---------------------------------------------------------------------------

type WebSocketServer = any;
type WebSocket = any;

let wsServer: WebSocketServer | null = null;
const wsClients: Set<WebSocket> = new Set();
let wsPort: number | null = null;
let realSessionActive = false;

// ---------------------------------------------------------------------------
// Real-session mode: WebSocket relay server
// ---------------------------------------------------------------------------

/**
 * Start the WebSocket relay server that the Chrome extension connects to.
 * The extension captures CDP events from the user's real logged-in session
 * and forwards them here, where we parse them into the same buffers used
 * by fresh-browser mode — so the same query tools work for both.
 */
async function startRelayServer(port: number): Promise<void> {
	const { WebSocketServer } = await import("ws");
	return new Promise((resolve, reject) => {
		wsServer = new WebSocketServer({ port });
		wsServer.on("listening", () => {
			wsPort = port;
			realSessionActive = true;
			resolve();
		});
		wsServer.on("connection", (socket: WebSocket) => {
			wsClients.add(socket);
			socket.on("message", (raw: Buffer) => {
				try {
					const { method, params, timestamp } = JSON.parse(raw.toString());
					handleCdpEvent(method, params, timestamp);
				} catch {
					/* ignore malformed messages */
				}
			});
			socket.on("close", () => wsClients.delete(socket));
		});
		wsServer.on("error", reject);
	});
}

function stopRelayServer(): void {
	for (const client of wsClients) {
		try {
			client.close();
		} catch {
			/* ignore */
		}
	}
	wsClients.clear();
	if (wsServer) {
		try {
			wsServer.close();
		} catch {
			/* ignore */
		}
		wsServer = null;
	}
	wsPort = null;
	realSessionActive = false;
}

/**
 * Parse a CDP event from the Chrome extension and push it into the
 * shared buffers (same shape as fresh-browser mode).
 */
function handleCdpEvent(method: string, params: any, timestamp: number): void {
	switch (method) {
		case "Runtime.consoleAPICalled": {
			const text = (params.args || [])
				.map(
					(a: any) =>
						a.value ?? a.description ?? a.unserializableValue ?? JSON.stringify(a),
				)
				.join(" ");
			consoleBuffer.push({
				timestamp: timestamp ?? Date.now(),
				level:
					params.type === "error"
						? "error"
						: params.type === "warning"
							? "warning"
							: (params.type ?? "log"),
				text,
				source: params.stackTrace?.callFrames?.[0]?.url,
				line: params.stackTrace?.callFrames?.[0]?.lineNumber,
			});
			break;
		}
		case "Runtime.exceptionThrown": {
			const detail = params.exceptionDetails;
			consoleBuffer.push({
				timestamp: timestamp ?? Date.now(),
				level: "exception",
				text: detail.exception?.description ?? detail.text ?? "Unknown exception",
				source: detail.url,
				line: detail.lineNumber,
			});
			break;
		}
		case "Network.requestWillBeSent": {
			networkBuffer.push({
				timestamp: timestamp ?? Date.now(),
				method: params.request?.method ?? "GET",
				url: params.request?.url ?? "",
				resourceType: params.type,
				requestHeaders: params.request?.headers,
			});
			break;
		}
		case "Network.responseReceived": {
			const entries = networkBuffer.all;
			for (let i = entries.length - 1; i >= 0; i--) {
				if (
					entries[i].url === params.response?.url &&
					entries[i].status === undefined
				) {
					entries[i].status = params.response.status;
					entries[i].statusText = params.response.statusText;
					entries[i].responseHeaders = params.response.headers;
					break;
				}
			}
			break;
		}
		case "Network.loadingFailed": {
			const entries = networkBuffer.all;
			for (let i = entries.length - 1; i >= 0; i--) {
				if (entries[i].status === undefined) {
					entries[i].failed = true;
					entries[i].failureText = params.errorText;
					break;
				}
			}
			break;
		}
		case "Log.entryAdded": {
			consoleBuffer.push({
				timestamp: timestamp ?? Date.now(),
				level:
					params.entry?.level === "error"
						? "error"
						: params.entry?.level === "warning"
							? "warning"
							: "info",
				text: params.entry?.text ?? "",
				source: params.entry?.source,
			});
			break;
		}
	}
}

// CDP client type — chrome-remote-interface ships no types in 0.34
type CDPClient = any;

// ---------------------------------------------------------------------------
// Ring buffer for bounded in-memory log storage
// ---------------------------------------------------------------------------

class RingBuffer<T> {
	private items: T[] = [];
	constructor(private capacity: number) {}
	push(item: T) {
		if (this.items.length >= this.capacity) this.items.shift();
		this.items.push(item);
	}
	get all(): T[] {
		return [...this.items];
	}
	get length() {
		return this.items.length;
	}
	clear() {
		this.items = [];
	}
}

// ---------------------------------------------------------------------------
// Log entry types
// ---------------------------------------------------------------------------

interface ConsoleEntry {
	timestamp: number;
	level:
		| "log"
		| "error"
		| "warning"
		| "info"
		| "debug"
		| "dir"
		| "table"
		| "trace"
		| "exception";
	text: string;
	source?: string;
	line?: number;
	column?: number;
}

interface NetworkEntry {
	timestamp: number;
	method: string;
	url: string;
	status?: number;
	statusText?: string;
	resourceType?: string;
	duration?: number;
	failed?: boolean;
	failureText?: string;
	requestHeaders?: Record<string, string>;
	responseHeaders?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Browser session state
// ---------------------------------------------------------------------------

let cdp: CDPClient | null = null;
let launchedChrome: { kill: () => void; port: number; pid: number } | null =
	null;
let tempProfileDir: string | null = null;

const consoleBuffer = new RingBuffer<ConsoleEntry>(2000);
const networkBuffer = new RingBuffer<NetworkEntry>(2000);

const MAX_OUTPUT_CHARS = 50_000;

function safeOutput(text: string): { text: string; truncated: boolean } {
	if (text.length <= MAX_OUTPUT_CHARS) return { text, truncated: false };
	return {
		text:
			text.slice(0, MAX_OUTPUT_CHARS) +
			`\n--- TRUNCATED (${text.length} chars total) ---`,
		truncated: true,
	};
}

// ---------------------------------------------------------------------------
// CDP event handlers
// ---------------------------------------------------------------------------

function setupEventHandlers(client: CDPClient) {
	const { Runtime, Network, Log } = client;

	// Console API calls (console.log, console.error, etc.)
	Runtime.consoleAPICalled(({ type, timestamp, args, stackTrace }: any) => {
		const text = (args || [])
			.map(
				(a: any) =>
					a.value ?? a.description ?? a.unserializableValue ?? JSON.stringify(a),
			)
			.join(" ");
		const entry: ConsoleEntry = {
			timestamp: timestamp ?? Date.now(),
			level: type === "error" ? "error" : type === "warning" ? "warning" : type,
			text,
		};
		if (stackTrace?.callFrames?.length) {
			const top = stackTrace.callFrames[0];
			entry.source = top.url;
			entry.line = top.lineNumber + 1;
			entry.column = top.columnNumber + 1;
		}
		consoleBuffer.push(entry);
	});

	// Uncaught exceptions
	Runtime.exceptionThrown(({ exceptionDetails }: any) => {
		const text =
			exceptionDetails.exception?.description ??
			exceptionDetails.text ??
			"Unknown exception";
		consoleBuffer.push({
			timestamp: Date.now(),
			level: "exception",
			text,
			source: exceptionDetails.url,
			line: exceptionDetails.lineNumber,
			column: exceptionDetails.columnNumber,
		});
	});

	// Network requests
	Network.requestWillBeSent(({ request, type }: any) => {
		networkBuffer.push({
			timestamp: Date.now(),
			method: request.method,
			url: request.url,
			resourceType: type,
			requestHeaders: request.headers,
		});
	});

	Network.responseReceived(({ response }: any) => {
		// Find matching request and update it
		const entries = networkBuffer.all;
		for (let i = entries.length - 1; i >= 0; i--) {
			if (entries[i].url === response.url && entries[i].status === undefined) {
				entries[i].status = response.status;
				entries[i].statusText = response.statusText;
				entries[i].responseHeaders = response.headers;
				break;
			}
		}
	});

	Network.loadingFailed(({ errorText }: any) => {
		const entries = networkBuffer.all;
		for (let i = entries.length - 1; i >= 0; i--) {
			if (entries[i].status === undefined) {
				entries[i].failed = true;
				entries[i].failureText = errorText;
				break;
			}
		}
	});

	// Browser-level log entries (Log domain)
	if (Log?.entryAdded) {
		Log.entryAdded(({ entry }: any) => {
			consoleBuffer.push({
				timestamp: entry.timestamp ?? Date.now(),
				level:
					entry.level === "error"
						? "error"
						: entry.level === "warning"
							? "warning"
							: "info",
				text: entry.text,
				source: entry.source,
			});
		});
	}
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	pi.registerFlag("browser-inspector", {
		description:
			"Enable the browser inspector extension (fresh-browser CDP mode)",
		type: "boolean",
		default: false,
	});
	pi.registerFlag("browser-url", {
		description: "Initial URL to navigate to on browser launch",
		type: "string",
	});
	pi.registerFlag("browser-headed", {
		description: "Show the browser window (headed mode)",
		type: "boolean",
		default: false,
	});

	// ---- browser_launch ------------------------------------------------------
	pi.registerTool({
		name: "browser_launch",
		label: "Browser Launch",
		description:
			"Launch a fresh Chromium instance for inspection. Returns the debug port. Call this before any other browser_* tool.",
		parameters: Type.Object({
			url: Type.Optional(
				Type.String({ description: "URL to navigate to after launch" }),
			),
			headed: Type.Optional(
				Type.Boolean({
					description: "Show browser window (default false = headless)",
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (cdp) {
				return {
					content: [
						{
							type: "text",
							text: "Browser already launched. Use browser_close first to restart.",
						},
					],
					details: {},
				};
			}

			try {
				// Dynamic import so the extension loads even if deps aren't installed
				const { launch } = await import("chrome-launcher");
				const CDP = (await import("chrome-remote-interface")).default;

				// Create a temporary profile so we never touch the user's real profile
				tempProfileDir = mkdtempSync(join(tmpdir(), "pi-browser-"));

				const headed =
					params.headed ??
					(pi.getFlag("browser-headed") as boolean | undefined) ??
					false;
				const startUrl =
					params.url ??
					(pi.getFlag("browser-url") as string | undefined) ??
					"about:blank";

				launchedChrome = await launch({
					startingUrl: startUrl,
					userDataDir: tempProfileDir,
					chromeFlags: [
						"--no-first-run",
						"--no-default-browser-check",
						"--disable-background-networking",
						headed ? "" : "--headless=new",
					].filter(Boolean) as string[],
					handleSIGINT: false,
				});

				const client = await CDP({ port: launchedChrome.port });
				cdp = client;

				// Enable domains
				await Promise.all(
					[
						client.Runtime?.enable(),
						client.Network?.enable(),
						client.Page?.enable(),
						client.Log?.enable(),
					].filter(Boolean),
				);

				setupEventHandlers(client);

				ctx.ui.setStatus(
					"browser-inspector",
					ctx.ui.theme.fg("accent", `Browser: live (port ${launchedChrome.port})`),
				);

				return {
					content: [
						{
							type: "text",
							text: `Browser launched on port ${launchedChrome.port} (PID ${launchedChrome.pid}).\nNavigated to: ${startUrl}\nConsole and network capture active.`,
						},
					],
					details: { port: launchedChrome.port, pid: launchedChrome.pid },
				};
			} catch (err) {
				// Clean up on failure
				if (launchedChrome) {
					try {
						launchedChrome.kill();
					} catch {
						/* ignore */
					}
					launchedChrome = null;
				}
				if (tempProfileDir) {
					try {
						rmSync(tempProfileDir, { recursive: true, force: true });
					} catch {
						/* ignore */
					}
					tempProfileDir = null;
				}
				return {
					content: [
						{
							type: "text",
							text: `Failed to launch browser: ${(err as Error).message}`,
						},
					],
					details: { error: (err as Error).message },
				};
			}
		},
	});

	// ---- browser_navigate ----------------------------------------------------
	pi.registerTool({
		name: "browser_navigate",
		label: "Browser Navigate",
		description: "Navigate the browser to a URL and wait for it to load.",
		parameters: Type.Object({
			url: Type.String({ description: "URL to navigate to" }),
		}),
		async execute(_toolCallId, params, _signal, onUpdate, ctx) {
			if (!cdp && !realSessionActive) {
				return {
					content: [
						{ type: "text", text: "No browser running. Call browser_launch first." },
					],
					details: {},
				};
			}
			try {
				await cdp.Page.navigate({ url: params.url });
				// Wait for load event
				await new Promise<void>((resolve, reject) => {
					const timeout = setTimeout(
						() => reject(new Error("navigation timeout")),
						30_000,
					);
					cdp.Page.loadEventFired(() => {
						clearTimeout(timeout);
						resolve();
					});
				});
				return {
					content: [{ type: "text", text: `Navigated to ${params.url}` }],
					details: { url: params.url },
				};
			} catch (err) {
				return {
					content: [
						{ type: "text", text: `Navigation failed: ${(err as Error).message}` },
					],
					details: { error: (err as Error).message },
				};
			}
		},
	});

	// ---- browser_console_logs ------------------------------------------------
	pi.registerTool({
		name: "browser_console_logs",
		label: "Browser Console Logs",
		description:
			"Retrieve captured browser console logs. Filter by level and text.",
		parameters: Type.Object({
			level: Type.Optional(
				Type.String({
					description:
						'Filter by level: "error", "warning", "info", "all" (default "all")',
				}),
			),
			filter: Type.Optional(
				Type.String({ description: "Only return logs containing this text" }),
			),
			limit: Type.Optional(
				Type.Number({
					description: "Max entries to return (default 50)",
					default: 50,
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			if (!cdp && !realSessionActive) {
				return {
					content: [
						{ type: "text", text: "No browser running. Call browser_launch first." },
					],
					details: {},
				};
			}
			let entries = consoleBuffer.all;
			const level = params.level ?? "all";
			if (level !== "all") {
				entries = entries.filter((e) => e.level === level);
			}
			if (params.filter) {
				const f = params.filter.toLowerCase();
				entries = entries.filter((e) => e.text.toLowerCase().includes(f));
			}
			entries = entries.slice(-Math.min(params.limit ?? 50, entries.length));

			if (entries.length === 0) {
				return {
					content: [{ type: "text", text: "(no console logs captured)" }],
					details: { total: consoleBuffer.length },
				};
			}

			const lines = entries.map((e) => {
				const loc = e.source ? ` @ ${e.source}:${e.line ?? "?"}` : "";
				return `[${e.level.toUpperCase()}] ${e.text}${loc}`;
			});
			const { text } = safeOutput(lines.join("\n"));
			return {
				content: [{ type: "text", text }],
				details: { returned: entries.length, total: consoleBuffer.length },
			};
		},
	});

	// ---- browser_console_errors ----------------------------------------------
	pi.registerTool({
		name: "browser_console_errors",
		label: "Browser Console Errors",
		description:
			"Retrieve only console errors and uncaught exceptions, grouped by signature.",
		parameters: Type.Object({
			limit: Type.Optional(
				Type.Number({ description: "Max entries (default 50)", default: 50 }),
			),
			groupBy: Type.Optional(
				Type.Boolean({
					description: "Group similar errors with counts",
					default: true,
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			if (!cdp && !realSessionActive) {
				return {
					content: [
						{ type: "text", text: "No browser running. Call browser_launch first." },
					],
					details: {},
				};
			}
			const errors = consoleBuffer.all.filter(
				(e) => e.level === "error" || e.level === "exception",
			);
			const limited = errors.slice(-Math.min(params.limit ?? 50, errors.length));

			if (limited.length === 0) {
				return {
					content: [{ type: "text", text: "(no console errors captured)" }],
					details: { total: errors.length },
				};
			}

			let output: string;
			if (params.groupBy ?? true) {
				const groups = new Map<string, { count: number; example: ConsoleEntry }>();
				for (const e of limited) {
					const key = e.text.slice(0, 120);
					const existing = groups.get(key);
					if (existing) {
						existing.count++;
					} else {
						groups.set(key, { count: 1, example: e });
					}
				}
				const lines = [...groups.entries()].map(([key, { count, example }]) => {
					const loc = example.source
						? ` @ ${example.source}:${example.line ?? "?"}`
						: "";
					return count > 1 ? `[×${count}] ${key}${loc}` : `[1] ${key}${loc}`;
				});
				output = lines.join("\n");
			} else {
				output = limited
					.map((e) => {
						const loc = e.source ? ` @ ${e.source}:${e.line ?? "?"}` : "";
						return `[${e.level.toUpperCase()}] ${e.text}${loc}`;
					})
					.join("\n");
			}

			const { text } = safeOutput(output);
			return {
				content: [{ type: "text", text }],
				details: { returned: limited.length, total: errors.length },
			};
		},
	});

	// ---- browser_network_requests --------------------------------------------
	pi.registerTool({
		name: "browser_network_requests",
		label: "Browser Network Requests",
		description:
			"Retrieve captured network requests. Filter by URL, status, or resource type.",
		parameters: Type.Object({
			filter: Type.Optional(
				Type.String({ description: "Only requests whose URL contains this text" }),
			),
			status: Type.Optional(
				Type.String({
					description:
						'Filter by status: "4xx", "5xx", "failed", or a specific code like "200"',
				}),
			),
			type: Type.Optional(
				Type.String({
					description:
						'Filter by resource type: "xhr", "fetch", "document", "script", "stylesheet", "image"',
				}),
			),
			limit: Type.Optional(
				Type.Number({ description: "Max entries (default 50)", default: 50 }),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			if (!cdp && !realSessionActive) {
				return {
					content: [
						{ type: "text", text: "No browser running. Call browser_launch first." },
					],
					details: {},
				};
			}
			let entries = networkBuffer.all;
			if (params.filter) {
				const f = params.filter.toLowerCase();
				entries = entries.filter((e) => e.url.toLowerCase().includes(f));
			}
			if (params.status) {
				entries = entries.filter((e) => {
					if (!e.status) return false;
					if (params.status === "failed") return e.failed;
					if (params.status === "4xx") return e.status >= 400 && e.status < 500;
					if (params.status === "5xx") return e.status >= 500;
					return String(e.status) === params.status;
				});
			}
			if (params.type) {
				entries = entries.filter(
					(e) => e.resourceType?.toLowerCase() === params.type!.toLowerCase(),
				);
			}
			entries = entries.slice(-Math.min(params.limit ?? 50, entries.length));

			if (entries.length === 0) {
				return {
					content: [{ type: "text", text: "(no network requests captured)" }],
					details: { total: networkBuffer.length },
				};
			}

			const lines = entries.map((e) => {
				const status = e.failed
					? `FAILED (${e.failureText ?? "unknown"})`
					: (e.status ?? "...");
				return `[${status}] ${e.method} ${e.url}${e.resourceType ? ` [${e.resourceType}]` : ""}`;
			});
			const { text } = safeOutput(lines.join("\n"));
			return {
				content: [{ type: "text", text }],
				details: { returned: entries.length, total: networkBuffer.length },
			};
		},
	});

	// ---- browser_screenshot --------------------------------------------------
	pi.registerTool({
		name: "browser_screenshot",
		label: "Browser Screenshot",
		description:
			"Take a screenshot of the current page. Returns the image and saves to a temp file.",
		parameters: Type.Object({
			fullPage: Type.Optional(
				Type.Boolean({
					description: "Capture full scrollable page",
					default: false,
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			if (!cdp) {
				return {
					content: [
						{ type: "text", text: "No browser running. Call browser_launch first." },
					],
					details: {},
				};
			}
			try {
				const { data } = await cdp.Page.captureScreenshot({
					format: "png",
					fromSurface: true,
				});
				// Save to temp file
				const { writeFileSync } = await import("node:fs");
				const path = join(tmpdir(), `pi-browser-screenshot-${Date.now()}.png`);
				writeFileSync(path, Buffer.from(data, "base64"));
				return {
					content: [
						{ type: "text", text: `Screenshot saved to ${path}` },
						{ type: "image", data, mimeType: "image/png" } as any,
					],
					details: { path },
				};
			} catch (err) {
				return {
					content: [
						{ type: "text", text: `Screenshot failed: ${(err as Error).message}` },
					],
					details: { error: (err as Error).message },
				};
			}
		},
	});

	// ---- browser_close -------------------------------------------------------
	pi.registerTool({
		name: "browser_close",
		label: "Browser Close",
		description: "Close the browser instance and clean up resources.",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			return closeBrowser(ctx);
		},
	});

	// ---- browser_attach (real-session mode) ----------------------------------
	pi.registerTool({
		name: "browser_attach",
		label: "Browser Attach (Real Session)",
		description:
			"Start a WebSocket relay and attach to your REAL logged-in Chrome session. " +
			"Requires the Pi Browser Inspector Chrome extension to be loaded. " +
			"Returns the relay port — enter this in the extension's DevTools panel to connect.",
		parameters: Type.Object({
			port: Type.Optional(
				Type.Number({
					description: "WebSocket relay port (default 9234)",
					default: 9234,
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (realSessionActive) {
				return {
					content: [
						{
							type: "text",
							text: `Real-session relay already running on port ${wsPort}. Enter this port in the Chrome extension's DevTools panel.`,
						},
					],
					details: { port: wsPort },
				};
			}
			if (cdp) {
				return {
					content: [
						{
							type: "text",
							text:
								"Fresh-browser mode is active. Call browser_close first before switching to real-session mode.",
						},
					],
					details: {},
				};
			}
			try {
				const port = params.port ?? 9234;
				await startRelayServer(port);
				ctx.ui.setStatus(
					"browser-inspector",
					ctx.ui.theme.fg("accent", `Browser: real-session relay (port ${wsPort})`),
				);
				return {
					content: [
						{
							type: "text",
							text:
								`Real-session relay started on port ${wsPort}.\n\n` +
								`Next steps:\n` +
								`1. Open Chrome DevTools (F12) on the tab you want to inspect\n` +
								`2. Go to the "Pi Browser Inspector" panel in DevTools\n` +
								`3. Click Connect and enter port ${wsPort}\n` +
								`4. Click "Attach to Tab"\n\n` +
								`The agent can then read console logs and network requests from your real session.`,
						},
					],
					details: { port: wsPort, mode: "real-session" },
				};
			} catch (err) {
				return {
					content: [
						{
							type: "text",
							text: `Failed to start relay: ${(err as Error).message}`,
						},
					],
					details: { error: (err as Error).message },
				};
			}
		},
	});

	// ---- browser_detach (real-session mode) ----------------------------------
	pi.registerTool({
		name: "browser_detach",
		label: "Browser Detach (Real Session)",
		description: "Stop the real-session WebSocket relay and clear captured logs.",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			if (!realSessionActive) {
				return {
					content: [{ type: "text", text: "No real-session relay is running." }],
					details: {},
				};
			}
			stopRelayServer();
			consoleBuffer.clear();
			networkBuffer.clear();
			ctx.ui.setStatus("browser-inspector", undefined);
			return {
				content: [
					{ type: "text", text: "Real-session relay stopped and logs cleared." },
				],
				details: {},
			};
		},
	});

	// ---- /doctor command ----------------------------------------------------
	pi.registerCommand("browser-doctor", {
		description: "Diagnose browser inspector setup (deps, Chrome, extension)",
		handler: async (_args, ctx) => {
			const checks: string[] = [];
			// Node version
			checks.push(`Node: ${process.version}`);
			// Check chrome-launcher
			try {
				await import("chrome-launcher");
				checks.push("chrome-launcher: installed");
			} catch {
				checks.push(
					"chrome-launcher: MISSING — run npm install in the extension directory",
				);
			}
			// Check chrome-remote-interface
			try {
				await import("chrome-remote-interface");
				checks.push("chrome-remote-interface: installed");
			} catch {
				checks.push("chrome-remote-interface: MISSING");
			}
			// Check ws
			try {
				await import("ws");
				checks.push("ws: installed");
			} catch {
				checks.push("ws: MISSING");
			}
			// Check Chrome availability
			try {
				const { getChromePath } = await import("chrome-launcher");
				const p = getChromePath();
				checks.push(`Chrome: found at ${p}`);
			} catch {
				checks.push("Chrome: not found — install Google Chrome or Chromium");
			}
			// Extension present?
			const { existsSync } = await import("node:fs");
			const { resolve } = await import("node:path");
			const extDir = resolve(__dirname, "../extension");
			checks.push(
				existsSync(resolve(extDir, "manifest.json"))
					? `Extension: found at ${extDir}`
					: `Extension: NOT FOUND at ${extDir}`,
			);
			// Current state
			checks.push(
				cdp
					? "State: fresh-browser mode active"
					: realSessionActive
						? `State: real-session relay on port ${wsPort}`
						: "State: idle",
			);
			ctx.ui.notify(checks.join("\n"), "info");
		},
	});

	// ---- Lifecycle -----------------------------------------------------------
	pi.on("session_shutdown", async (_event, ctx) => {
		await closeBrowser(ctx);
		stopRelayServer();
	});
}

// ---------------------------------------------------------------------------
// Shared cleanup
// ---------------------------------------------------------------------------

async function closeBrowser(
	ctx: any,
): Promise<{ content: { type: string; text: string }[]; details: any }> {
	let message: string;
	try {
		if (cdp) {
			await cdp.close?.().catch(() => {});
			cdp = null;
		}
		if (launchedChrome) {
			launchedChrome.kill();
			launchedChrome = null;
		}
		if (tempProfileDir) {
			rmSync(tempProfileDir, { recursive: true, force: true });
			tempProfileDir = null;
		}
		consoleBuffer.clear();
		networkBuffer.clear();
		message = "Browser closed and cleaned up.";
	} catch (err) {
		message = `Error during browser cleanup: ${(err as Error).message}`;
	}
	ctx?.ui?.setStatus?.("browser-inspector", undefined);
	return { content: [{ type: "text", text: message }], details: {} };
}
