/**
 * Pi Browser Inspector — Chrome Extension (Manifest V3)
 *
 * Background service worker that:
 * 1. Attaches to the active tab via chrome.debugger API (bypasses Chrome 136+ default-profile block)
 * 2. Receives raw CDP events from the debugger
 * 3. Forwards them over WebSocket to the Pi extension's relay server
 *
 * The user must open DevTools (F12) on the tab they want to inspect — capture
 * begins automatically when DevTools is open.
 */

let ws = null;
let wsPort = null;
let attachedTabId = null;
const debuggerVersion = "1.3";

// Domains we want to capture from the debugger
const CDP_DOMAINS = ["Runtime", "Network", "Log", "Console"];

/** Connect to the Pi extension's WebSocket relay */
function connectWebSocket(port) {
	wsPort = port;
	const url = `ws://localhost:${port}`;
	try {
		ws = new WebSocket(url);

		ws.onopen = () => {
			console.log(`[Pi Browser Inspector] Connected to relay on port ${port}`);
			// If we already had a tab attached, re-attach now that WS is ready
			if (attachedTabId !== null) {
				attachToTab(attachedTabId);
			}
		};

		ws.onclose = () => {
			console.log("[Pi Browser Inspector] Disconnected from relay");
			ws = null;
		};

		ws.onerror = (err) => {
			console.error("[Pi Browser Inspector] WebSocket error", err);
		};
	} catch (e) {
		console.error("[Pi Browser Inspector] Failed to connect:", e);
	}
}

/** Disconnect from the relay */
function disconnectWebSocket() {
	if (ws) {
		ws.close();
		ws = null;
	}
	wsPort = null;
}

/** Attach the debugger to a tab */
function attachToTab(tabId) {
	if (!ws || ws.readyState !== WebSocket.OPEN) {
		// WS not ready yet; store tabId for when it connects
		attachedTabId = tabId;
		return;
	}

	// Detach from previous tab if any
	if (attachedTabId !== null && attachedTabId !== tabId) {
		chrome.debugger.detach({ tabId: attachedTabId }).catch(() => {});
	}

	attachedTabId = tabId;
	chrome.debugger.attach({ tabId }, debuggerVersion, () => {
		if (chrome.runtime.lastError) {
			console.error(
				"[Pi Browser Inspector] Attach failed:",
				chrome.runtime.lastError.message,
			);
			return;
		}
		console.log(`[Pi Browser Inspector] Attached to tab ${tabId}`);

		// Enable the domains we care about
		for (const domain of CDP_DOMAINS) {
			chrome.debugger.sendCommand({ tabId }, `${domain}.enable`, {}, () => {
				if (chrome.runtime.lastError) {
					// Some domains may not be available; that's fine
					console.debug(
						`[Pi Browser Inspector] ${domain}.enable: ${chrome.runtime.lastError.message}`,
					);
				}
			});
		}
	});
}

/** Detach the debugger from the current tab */
function detachFromTab() {
	if (attachedTabId !== null) {
		chrome.debugger.detach({ tabId: attachedTabId }, () => {});
		attachedTabId = null;
	}
}

/** Forward a CDP event to the WebSocket relay */
function relayEvent(tabId, method, params) {
	if (ws && ws.readyState === WebSocket.OPEN) {
		ws.send(
			JSON.stringify({
				tabId,
				method,
				params: params || {},
				timestamp: Date.now(),
			}),
		);
	}
}

// Listen for CDP events from the debugger
chrome.debugger.onEvent.addListener((source, method, params) => {
	relayEvent(source.tabId, method, params);
});

// Listen for debugger detach (tab closed, navigation, user detached)
chrome.debugger.onDetach.addListener((source, reason) => {
	console.log(
		`[Pi Browser Inspector] Detached from tab ${source.tabId}: ${reason}`,
	);
	if (source.tabId === attachedTabId) {
		attachedTabId = null;
	}
});

// Listen for messages from the DevTools panel or content script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
	switch (message.type) {
		case "CONNECT":
			connectWebSocket(message.port);
			sendResponse({ ok: true });
			break;
		case "DISCONNECT":
			detachFromTab();
			disconnectWebSocket();
			sendResponse({ ok: true });
			break;
		case "ATTACH":
			attachToTab(message.tabId);
			sendResponse({ ok: true });
			break;
		case "DETACH":
			detachFromTab();
			sendResponse({ ok: true });
			break;
		case "STATUS":
			sendResponse({
				connected: ws?.readyState === WebSocket.OPEN,
				port: wsPort,
				attachedTabId,
			});
			break;
	}
});

console.log("[Pi Browser Inspector] Background service worker loaded");
