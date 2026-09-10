/**
 * Pi Browser Inspector — DevTools panel script.
 *
 * Provides a small UI in the DevTools panel to connect to the Pi agent's
 * WebSocket relay and attach/detach the debugger to the inspected tab.
 */

const statusEl = document.getElementById("status");
const btnConnect = document.getElementById("btnConnect");
const btnAttach = document.getElementById("btnAttach");
const btnDetach = document.getElementById("btnDetach");

let relayPort = null;

function setStatus(text, connected) {
	statusEl.textContent = text;
	statusEl.className = "status " + (connected ? "connected" : "disconnected");
}

function updateButtons(connected, attached) {
	btnConnect.disabled = connected;
	btnAttach.disabled = !connected || attached;
	btnDetach.disabled = !attached;
}

// Prompt for the relay port (shown by the Pi agent when browser_attach is called)
btnConnect.addEventListener("click", async () => {
	const port = prompt("Enter the relay port shown by the Pi agent:", "9234");
	if (!port) return;
	relayPort = parseInt(port, 10);

	// Get the inspected tab's ID from DevTools
	const inspectedTabId = chrome.devtools.inspectedWindow.tabId;

	chrome.runtime.sendMessage({ type: "CONNECT", port: relayPort }, (resp) => {
		if (resp?.ok) {
			setStatus(`Connected to relay on port ${relayPort}`, true);
			updateButtons(true, false);
			// Auto-attach to the inspected tab
			chrome.runtime.sendMessage(
				{ type: "ATTACH", tabId: inspectedTabId },
				(r) => {
					if (r?.ok) {
						setStatus(`Connected — capturing tab ${inspectedTabId}`, true);
						updateButtons(true, true);
					}
				},
			);
		} else {
			setStatus("Connection failed", false);
		}
	});
});

btnAttach.addEventListener("click", () => {
	const inspectedTabId = chrome.devtools.inspectedWindow.tabId;
	chrome.runtime.sendMessage(
		{ type: "ATTACH", tabId: inspectedTabId },
		(resp) => {
			if (resp?.ok) {
				setStatus(`Capturing tab ${inspectedTabId}`, true);
				updateButtons(true, true);
			}
		},
	);
});

btnDetach.addEventListener("click", () => {
	chrome.runtime.sendMessage({ type: "DETACH" }, (resp) => {
		if (resp?.ok) {
			setStatus("Connected — detached", true);
			updateButtons(true, false);
		}
	});
});

// Check current status on load
chrome.runtime.sendMessage({ type: "STATUS" }, (resp) => {
	if (resp) {
		const connected = resp.connected;
		const attached = resp.attachedTabId !== null;
		if (connected) {
			setStatus(
				attached
					? `Capturing tab ${resp.attachedTabId}`
					: `Connected to relay on port ${resp.port}`,
				true,
			);
			relayPort = resp.port;
		}
		updateButtons(connected, attached);
	}
});
