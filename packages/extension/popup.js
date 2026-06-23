const STORAGE_KEY = "relayBaseUrl";
const ROOM_KEY = "campaignCode";
const codeInput = document.getElementById("code");
const DEFAULT_RELAY_URL = "https://extension-dnd.onrender.com";
const urlInput = document.getElementById("url");
const statusEl = document.getElementById("status");

function normalize(raw) {
  let b = (raw || "").trim().replace(/\/+$/, "");
  if (b && !/^https?:\/\//i.test(b)) b = "http://" + b;
  return b;
}
function setStatus(msg, ok) {
  statusEl.textContent = msg;
  statusEl.className = ok ? "ok" : "bad";
}

chrome.storage.local.get([STORAGE_KEY, ROOM_KEY], (data) => {
  urlInput.value = data[STORAGE_KEY] || DEFAULT_RELAY_URL;
  codeInput.value = data[ROOM_KEY] || "";
});

document.getElementById("save").addEventListener("click", () => {
  const base = normalize(urlInput.value);
  if (!base) return setStatus("Enter a relay URL first.", false);
  const code = (codeInput.value || "").trim().toUpperCase();
  chrome.storage.local.set({ [STORAGE_KEY]: base, [ROOM_KEY]: code }, () =>
    setStatus(code ? ("Saved. Campaign " + code) : "Saved (no campaign code set).", true)
  );
});

document.getElementById("test").addEventListener("click", async () => {
  const base = normalize(urlInput.value);
  if (!base) return setStatus("Enter a relay URL first.", false);
  setStatus("Testing...", true);
  try {
    const res = await fetch(`${base}/health`, { cache: "no-store" });
    const j = await res.json();
    setStatus(`Relay OK - ${j.displays} display(s) connected.`, true);
  } catch (e) {
    setStatus("Could not reach relay. Check the URL and that it is running.", false);
  }
});

document.getElementById("pause").addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "toggle-pause" });
  setStatus("Toggled your overlay pause.", true);
});
