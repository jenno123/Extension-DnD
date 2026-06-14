/*
 * D&D Voice Overlay - Roll20 content script  (runs for EVERY player)
 * ------------------------------------------------------------------
 * Visual-novel overlay over Roll20: idle characters hidden; a speaker's large
 * transparent portrait slides into a free side slot, then slides away.
 *
 * Pause: Ctrl+Shift+P (or the popup button) toggles a table-wide pause via the
 * relay, so everyone's overlay hides while you talk out of character.
 */
(() => {
  const STORAGE_KEY = "relayBaseUrl";
  // Pre-configured relay so players don't have to type anything.
  const DEFAULT_RELAY_URL = "https://extension-dnd.onrender.com";
  const SLOTS = ["slot-left", "slot-right", "slot-left-2", "slot-right-2"];
  const slotOccupant = new Array(SLOTS.length).fill(null);
  const HIDE_DELAY_MS = 340;

  let socket = null;
  let reconnectMs = 1000;
  let portraitEls = new Map();
  let rootEl = null, statusEl = null, pausedBanner = null;
  let teardown = false;
  let paused = false;

  const log = (...a) => console.log("[dnd-overlay]", ...a);

  function normalizeBase(raw) {
    let base = (raw || "").trim().replace(/\/+$/, "");
    if (!base) return null;
    if (!/^https?:\/\//i.test(base)) base = "http://" + base;
    return base;
  }
  const toWsUrl = (b) => b.replace(/^http/i, "ws") + "/?role=display";

  function ensureRoot() {
    if (rootEl && document.documentElement.contains(rootEl)) return;
    rootEl = document.createElement("div");
    rootEl.id = "dnd-voice-overlay-root";
    statusEl = document.createElement("div");
    statusEl.id = "dnd-voice-overlay-status";
    pausedBanner = document.createElement("div");
    pausedBanner.id = "dnd-voice-overlay-paused";
    pausedBanner.textContent = "Overlay paused";
    document.documentElement.appendChild(rootEl);
    document.documentElement.appendChild(statusEl);
    document.documentElement.appendChild(pausedBanner);
  }

  function clearOverlay() {
    portraitEls.clear();
    slotOccupant.fill(null);
    if (rootEl) rootEl.innerHTML = "";
  }

  function buildPortraits(base, campaign) {
    ensureRoot();
    clearOverlay();
    const chars = (campaign && campaign.characters) || {};
    for (const [userId, c] of Object.entries(chars)) {
      const wrap = document.createElement("div");
      wrap.className = "dnd-portrait";
      wrap.dataset.userid = userId;
      const img = document.createElement("img");
      img.alt = c.name || "";
      img.src = `${base}/portraits/${encodeURIComponent(c.portrait)}`;
      img.onerror = () => log("portrait failed to load:", c.portrait);
      const name = document.createElement("div");
      name.className = "dnd-nameplate";
      name.textContent = c.name || "";
      wrap.appendChild(img);
      wrap.appendChild(name);
      rootEl.appendChild(wrap);
      portraitEls.set(userId, wrap);
    }
    log(`loaded ${portraitEls.size} characters for "${campaign.campaignName || "campaign"}"`);
  }

  function showSpeaker(userId) {
    if (paused) return;
    const el = portraitEls.get(userId);
    if (!el) return;
    if (el._hideTimer) { clearTimeout(el._hideTimer); el._hideTimer = null; }
    if (el.dataset.slot == null) {
      let i = slotOccupant.indexOf(null);
      if (i === -1) i = 0;
      slotOccupant[i] = userId;
      el.dataset.slot = String(i);
      el.classList.add(SLOTS[i]);
      void el.offsetWidth;
    }
    el.classList.add("active");
  }

  function hideSpeaker(userId) {
    const el = portraitEls.get(userId);
    if (!el) return;
    el.classList.remove("active");
    if (el._hideTimer) clearTimeout(el._hideTimer);
    el._hideTimer = setTimeout(() => {
      const i = el.dataset.slot;
      if (i != null) {
        slotOccupant[Number(i)] = null;
        el.classList.remove(SLOTS[Number(i)]);
        delete el.dataset.slot;
      }
      el._hideTimer = null;
    }, HIDE_DELAY_MS);
  }

  function setSpeaking(userId, speaking) {
    if (paused) return;
    speaking ? showSpeaker(userId) : hideSpeaker(userId);
  }

  function resetAll() {
    for (const [, el] of portraitEls) {
      if (el._hideTimer) { clearTimeout(el._hideTimer); el._hideTimer = null; }
      el.classList.remove("active", ...SLOTS);
      delete el.dataset.slot;
    }
    slotOccupant.fill(null);
  }

  function applyPaused(p) {
    paused = !!p;
    if (pausedBanner) pausedBanner.classList.toggle("show", paused);
    if (paused) resetAll();   // hide all art immediately
    log(paused ? "overlay paused" : "overlay resumed");
  }

  function requestTogglePause() {
    // Local-only: each player pauses just their own overlay (no relay involved).
    applyPaused(!paused);
  }

  const setConnected = (ok) => statusEl && statusEl.classList.toggle("connected", ok);

  async function loadCampaign(base) {
    const res = await fetch(`${base}/campaign.json`, { cache: "no-store" });
    if (!res.ok) throw new Error(`campaign.json HTTP ${res.status}`);
    return res.json();
  }

  function connectSocket(base) {
    if (teardown) return;
    const url = toWsUrl(base);
    log("connecting", url);
    socket = new WebSocket(url);
    socket.onopen = () => { reconnectMs = 1000; setConnected(true); log("relay connected"); };
    socket.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.type === "speaking") setSpeaking(msg.userId, msg.speaking);
      else if (msg.type === "snapshot") {
        resetAll();
        if (!paused) for (const id of msg.speaking || []) showSpeaker(id);
      }
    };
    socket.onclose = () => {
      setConnected(false);
      if (teardown) return;
      log(`relay disconnected, retrying in ${reconnectMs}ms`);
      setTimeout(() => connectSocket(base), reconnectMs);
      reconnectMs = Math.min(reconnectMs * 2, 15000);
    };
    socket.onerror = () => socket && socket.close();
  }

  async function start(rawBase) {
    teardown = false;
    const base = normalizeBase(rawBase);
    if (!base) { log("no relay URL set. Open the extension popup and enter it."); return; }
    try {
      const campaign = await loadCampaign(base);
      buildPortraits(base, campaign);
      connectSocket(base);
    } catch (err) {
      log("startup failed:", err.message, "- retrying in 5s");
      setTimeout(() => start(rawBase), 5000);
    }
  }

  function stop() {
    teardown = true;
    if (socket) { try { socket.close(); } catch (_) {} socket = null; }
    clearOverlay();
    if (rootEl) rootEl.remove();
    if (statusEl) statusEl.remove();
    if (pausedBanner) pausedBanner.remove();
    rootEl = statusEl = pausedBanner = null;
  }

  // Pause toggle from the keyboard command / popup (via background.js).
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === "toggle-pause") requestTogglePause();
  });

  chrome.storage.local.get(STORAGE_KEY, (data) => start(data[STORAGE_KEY] || DEFAULT_RELAY_URL));
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes[STORAGE_KEY]) {
      log("relay URL changed, restarting overlay");
      stop();
      start(changes[STORAGE_KEY].newValue);
    }
  });
})();
