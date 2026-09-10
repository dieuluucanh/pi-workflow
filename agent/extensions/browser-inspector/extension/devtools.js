/**
 * DevTools page script — creates the Pi Browser Inspector panel tab.
 * Loaded by devtools.html (the devtools_page declared in manifest.json).
 */
chrome.devtools.panels.create(
  "Pi Browser Inspector", // panel title shown in DevTools toolbar
  "icon128.png", // panel icon
  "panel.html", // panel content page (loads panel.js)
  (panel) => {
    console.log("[Pi Browser Inspector] Panel created successfully");
    panel.onShown.addListener(() => {
      console.log("[Pi Browser Inspector] Panel shown");
    });
  },
);

// Log to the DevTools Console so the user sees confirmation
console.log("[Pi Browser Inspector] DevTools page loaded, creating panel...");
