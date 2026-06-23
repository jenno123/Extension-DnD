const STORAGE_KEY = "relayBaseUrl";
const ROOM_KEY = "campaignCode";
const DM_KEY = "dmMode";
const JOIN_KEY = "joinPw";
const codeInput = document.getElementById("code");
const dmInput = document.getElementById("dm");
const joinInput = document.getElementById("join");
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

chrome.storage.local.get([STORAGE_KEY, ROOM_KEY, DM_KEY, JOIN_KEY], (data) => {
  urlInput.value = data[STORAGE_KEY] || DEFAULT_RELAY_URL;
  codeInput.value = data[ROOM_KEY] || "";
  dmInput.checked = !!data[DM_KEY];
  joinInput.value = data[JOIN_KEY] || "";
});

document.getElementById("save").addEventListener("click", () => {
  const base = normalize(urlInput.value);
  if (!base) return setStatus("Enter a relay URL first.", false);
  const code = (codeInput.value || "").trim().toUpperCase();
  chrome.storage.local.set({ [STORAGE_KEY]: base, [ROOM_KEY]: code, [DM_KEY]: dmInput.checked, [JOIN_KEY]: joinInput.value || "" }, () =>
    setStatus(code ? ("Saved. Campaign " + code + (dmInput.checked ? " (DM)" : "")) : "Saved (no campaign code set).", true)
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


document.getElementById("manageBtn").addEventListener("click", () => {
  if (chrome.runtime.openOptionsPage) chrome.runtime.openOptionsPage();
  else window.open(chrome.runtime.getURL("options.html"));
});
