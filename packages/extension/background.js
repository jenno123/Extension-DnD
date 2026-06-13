/* Relays the keyboard command and popup clicks to the Roll20 content script(s). */
function tellRoll20Tabs(message) {
  chrome.tabs.query({ url: "https://app.roll20.net/*" }, (tabs) => {
    for (const t of tabs) {
      if (t.id != null) chrome.tabs.sendMessage(t.id, message).catch(() => {});
    }
  });
}

chrome.commands.onCommand.addListener((command) => {
  if (command === "toggle-pause") tellRoll20Tabs({ type: "toggle-pause" });
});

// Popup asks the background to forward a toggle as well.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === "toggle-pause") tellRoll20Tabs({ type: "toggle-pause" });
});
