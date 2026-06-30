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
  const ROOM_KEY = "campaignCode";
  // Pre-configured relay so players don't have to type anything.
  const DEFAULT_RELAY_URL = "https://extension-dnd.onrender.com";
  const SLOTS = ["slot-left", "slot-right", "slot-left-2", "slot-right-2"];
  const slotOccupant = new Array(SLOTS.length).fill(null);
  const HIDE_DELAY_MS = 850;  // > fade-out duration so the slot frees after the fade

  let socket = null;
  let reconnectMs = 1000;
  let portraitEls = new Map();
  let livingRaf = null;
  const levelTarget = {}, levelCur = {}, levelTime = {};
  let rootEl = null, statusEl = null, pausedBanner = null;
  let teardown = false;
  let paused = false;
  let room = "DEFAULT";
  // ---- DM mode state ----
  const DM_KEY = "dmMode", JOIN_KEY = "joinPw", SENS_KEY = "dmSens", HOLD_KEY = "dmHold", MYCHAR_KEY = "myCharacterId", MYCHARS_KEY = "myCharacterIds", COLLAPSE_KEY = "stripCollapsed";
  const PLAYER_MAX = 3, DM_MAX = 10;
  let dmMode = false, joinPw = "", dmSens = 6, dmHold = 1200, myCharacterIds = [], collapsed = false, addPanel = null;
  let campaignChars = {}, relayBase = "";
  let strip = null, repWs = null, repAc = null, repSp = null, repStream = null;
  let repRunning = false, repSpeaking = false, repLastLoud = 0, activeId = "", dmIds = [];
  let stripStatusEl = null, stripMeterEl = null, meterRaf = null, lastLevel = 0, lastLevelSent = 0;
  const MIC_HELP = "Microphone is blocked for Roll20.\n\nClick the icon at the left of the address bar, set Microphone to Allow, then reload this tab.";

  const log = (...a) => console.log("[dnd-overlay]", ...a);

  function normalizeBase(raw) {
    let base = (raw || "").trim().replace(/\/+$/, "");
    if (!base) return null;
    if (!/^https?:\/\//i.test(base)) base = "http://" + base;
    return base;
  }
  const toWsUrl = (b) => b.replace(/^http/i, "ws") + "/?role=display&room=" + encodeURIComponent(room);

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
      img.src = /^https?:\/\//i.test(c.portrait) ? c.portrait : `${base}/portraits/${encodeURIComponent(c.portrait)}?room=${encodeURIComponent(room)}`;
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
    if (strip) strip.classList.toggle("paused", paused);
    if (paused) resetAll();   // hide all art immediately
    log(paused ? "overlay paused" : "overlay resumed");
  }

  function requestTogglePause() {
    // Local-only: each player pauses just their own overlay (no relay involved).
    applyPaused(!paused);
  }

  const setConnected = (ok) => statusEl && statusEl.classList.toggle("connected", ok);

  function livingTick(t) {
    const now = Date.now();
    for (const [uid, el] of portraitEls) {
      const img = el.querySelector("img");
      if (!img) continue;
      if (el.classList.contains("active")) {
        if (now - (levelTime[uid] || 0) > 200) levelTarget[uid] = 0;
        const target = levelTarget[uid] || 0;
        const cur = levelCur[uid] = (levelCur[uid] || 0) + (target - (levelCur[uid] || 0)) * 0.3;
        const breathe = Math.sin(t / 1300) * 0.012;
        const scale = 1 + breathe + cur * 0.08;
        const ty = -cur * 6;
        if (img.style.transition !== "none") img.style.transition = "none";
        img.style.transform = "scale(" + scale.toFixed(3) + ") translateY(" + ty.toFixed(1) + "px)";
        img.style.filter = "drop-shadow(0 0 " + (18 + cur * 28).toFixed(0) + "px rgba(255,214,120," + (0.45 + cur * 0.4).toFixed(2) + ")) drop-shadow(0 14px 28px rgba(0,0,0,.55))";
      } else if (img.style.transform) { img.style.transform = ""; img.style.filter = ""; img.style.transition = ""; }
    }
    livingRaf = requestAnimationFrame(livingTick);
  }
  function startLiving() { if (livingRaf) cancelAnimationFrame(livingRaf); livingRaf = requestAnimationFrame(livingTick); }
  function stopLiving() { if (livingRaf) { cancelAnimationFrame(livingRaf); livingRaf = null; } }

  async function loadCampaign(base) {
    const res = await fetch(`${base}/campaign.json?room=${encodeURIComponent(room)}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`campaign.json HTTP ${res.status}`);
    return res.json();
  }

  function connectSocket(base) {
    if (teardown) return;
    const url = toWsUrl(base);
    log("connecting", url);
    socket = new WebSocket(url);
    socket.onopen = () => { reconnectMs = 1000; setConnected(true); updateLiveStatus(); log("relay connected"); };
    socket.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.type === "speaking") setSpeaking(msg.userId, msg.speaking);
      else if (msg.type === "level") { levelTarget[msg.userId] = msg.level; levelTime[msg.userId] = Date.now(); }
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
      campaignChars = (campaign && campaign.characters) || {};
      relayBase = base;
      buildPortraits(base, campaign);
      connectSocket(base);
      initStrip();
      startLiving();
    } catch (err) {
      log("startup failed:", err.message, "- retrying in 5s");
      setTimeout(() => start(rawBase), 5000);
    }
  }

  function stop() {
    teardown = true;
    stopLiving();
    teardownDm();
    if (socket) { try { socket.close(); } catch (_) {} socket = null; }
    clearOverlay();
    if (rootEl) rootEl.remove();
    if (statusEl) statusEl.remove();
    if (pausedBanner) pausedBanner.remove();
    rootEl = statusEl = pausedBanner = null;
  }

  // ===== Bottom control strip = the control center (board + add + mic + pause) =====
  function portraitUrl(c){ return /^https?:\/\//i.test(c.portrait) ? c.portrait : `${relayBase}/portraits/${encodeURIComponent(c.portrait)}?room=${encodeURIComponent(room)}`; }
  function setStripStatus(text, cls, help) {
    if (!stripStatusEl) return;
    stripStatusEl.textContent = text;
    stripStatusEl.className = "dnd-strip-status" + (cls ? " " + cls : "");
    if (help) stripStatusEl.dataset.help = "1"; else delete stripStatusEl.dataset.help;
  }
  function updateLiveStatus() {
    if (!stripStatusEl) return;
    if (!dmMode && boardIds().length === 0) { setStripStatus("Add your character with +", "off"); return; }
    if (dmMode && boardIds().length === 0) { setStripStatus("Add an NPC with +", "off"); return; }
    if (!repRunning) { setStripStatus("Mic off — click 🎤", "off"); return; }
    if (repSpeaking) { const nm = (campaignChars[activeId] && campaignChars[activeId].name) || activeId; setStripStatus("🔊 Live as " + nm, "live"); }
    else setStripStatus("Listening…", "ok");
  }
  function testFlash() {
    const id = activeId || boardIds()[0];
    if (!id) { setStripStatus("Add a character first", "err"); return; }
    showSpeaker(id); setTimeout(() => hideSpeaker(id), 1800);
  }
  function meterTick() { if (!strip) { meterRaf = null; return; } if (stripMeterEl) stripMeterEl.style.width = ((repRunning ? lastLevel : 0) * 100).toFixed(0) + "%"; meterRaf = requestAnimationFrame(meterTick); }

  function repWsUrl() {
    return relayBase.replace(/^http/i, "ws") + "/?role=reporter&room=" + encodeURIComponent(room) +
      (joinPw ? "&join=" + encodeURIComponent(joinPw) : "");
  }
  function reporterSend(id, on) {
    if (repWs && repWs.readyState === 1 && id) repWs.send(JSON.stringify({ type: "speaking", userId: id, speaking: on }));
  }
  function setRepSpeaking(on) {
    if (on === repSpeaking) return;
    repSpeaking = on;
    reporterSend(activeId, on);
    if (strip) strip.classList.toggle("speaking", on);
    updateLiveStatus();
  }
  function highlightStrip() {
    if (!strip) return;
    strip.querySelectorAll(".dnd-dm-thumb").forEach((t) => t.classList.toggle("active", t.dataset.id === activeId));
  }
  function setActive(id) {
    if (!id) { activeId = ""; highlightStrip(); return; }
    if (repRunning) {
      if (activeId && activeId !== id) reporterSend(activeId, false);
      activeId = id;
      reporterSend(id, true);
      repSpeaking = true; repLastLoud = Date.now();
      if (strip) strip.classList.add("speaking");
    } else { activeId = id; }
    highlightStrip();
  }
  function mkBtn(cls, txt, title, onclick) { const b = document.createElement("button"); b.className = cls; b.textContent = txt; b.title = title; b.onclick = onclick; return b; }

  function boardIds() {
    if (dmMode) return Object.keys(campaignChars).filter((id) => (campaignChars[id].kind || "pc") === "npc");
    return (myCharacterIds || []).filter((id) => campaignChars[id]);
  }
  function maxChars() { return dmMode ? DM_MAX : PLAYER_MAX; }

  function makeThumb(id, i) {
    const c = campaignChars[id];
    const t = document.createElement("div");
    t.className = "dnd-dm-thumb"; t.dataset.id = id; t.title = c.name || id;
    const img = document.createElement("img"); img.src = portraitUrl(c); t.appendChild(img);
    if (i < 9) { const k = document.createElement("span"); k.className = "dnd-dm-kbd"; k.textContent = i + 1; t.appendChild(k); }
    const del = document.createElement("span"); del.className = "dnd-dm-del"; del.textContent = "×"; del.title = "Remove";
    del.onclick = (e) => { e.stopPropagation(); deleteChar(id, c.name); };
    t.appendChild(del);
    t.onclick = () => setActive(id);
    return t;
  }

  function buildStrip() {
    teardownStrip();
    dmIds = boardIds();
    strip = document.createElement("div"); strip.id = "dnd-dm-strip";

    strip.appendChild(mkBtn("dnd-dm-collapse", collapsed ? "▸" : "◂", "Collapse / expand", toggleCollapse));
    strip.appendChild(mkBtn("dnd-dm-mic", "🎤", "Start/stop your microphone", () => (repRunning ? stopMic() : startMic())));

    const thumbs = document.createElement("div"); thumbs.className = "dnd-dm-thumbs";
    dmIds.forEach((id, i) => thumbs.appendChild(makeThumb(id, i)));
    if (dmIds.length < maxChars()) {
      const add = document.createElement("div"); add.className = "dnd-dm-thumb dnd-add-tile"; add.title = "Add a character"; add.textContent = "+";
      add.onclick = openAddPanel;
      thumbs.appendChild(add);
    }
    strip.appendChild(thumbs);

    const sens = document.createElement("input");
    sens.type = "range"; sens.min = "1"; sens.max = "40"; sens.value = String(dmSens);
    sens.className = "dnd-dm-sens"; sens.title = "Mic sensitivity";
    sens.oninput = () => { dmSens = parseInt(sens.value, 10) || 6; chrome.storage.local.set({ [SENS_KEY]: dmSens }); };
    strip.appendChild(sens);

    stripStatusEl = document.createElement("div"); stripStatusEl.className = "dnd-strip-status";
    stripStatusEl.onclick = () => { if (stripStatusEl.dataset.help) alert(MIC_HELP); };
    const mw = document.createElement("div"); mw.className = "dnd-strip-meter";
    stripMeterEl = document.createElement("div"); stripMeterEl.className = "dnd-strip-meter-fill"; mw.appendChild(stripMeterEl);
    strip.appendChild(stripStatusEl); strip.appendChild(mw);
    strip.appendChild(mkBtn("dnd-strip-test", "Test", "Flash my portrait to check it works", testFlash));
    strip.appendChild(mkBtn("dnd-dm-pause", "⏸", "Pause overlay on my screen (Ctrl+Shift+P)", () => requestTogglePause()));

    strip.classList.toggle("paused", paused);
    strip.classList.toggle("collapsed", collapsed);
    document.documentElement.appendChild(strip);
    if (dmIds.length) setActive(dmIds.indexOf(activeId) >= 0 ? activeId : dmIds[0]); else activeId = "";
    if (meterRaf) cancelAnimationFrame(meterRaf);
    meterTick();
    updateLiveStatus();
  }
  function teardownStrip() { if (meterRaf) { cancelAnimationFrame(meterRaf); meterRaf = null; } if (strip) { strip.remove(); strip = null; } stripStatusEl = null; stripMeterEl = null; closeAddPanel(); }

  function toggleCollapse() {
    collapsed = !collapsed;
    chrome.storage.local.set({ [COLLAPSE_KEY]: collapsed });
    if (strip) { strip.classList.toggle("collapsed", collapsed); const c = strip.querySelector(".dnd-dm-collapse"); if (c) c.textContent = collapsed ? "▸" : "◂"; }
  }

  function refreshCampaign() {
    loadCampaign(relayBase).then((c) => { campaignChars = (c && c.characters) || {}; buildPortraits(relayBase, c); buildStrip(); }).catch(() => {});
  }

  function openAddPanel() {
    closeAddPanel();
    addPanel = document.createElement("div"); addPanel.id = "dnd-add-panel";
    const title = document.createElement("div"); title.className = "dnd-add-title"; title.textContent = dmMode ? "Add an NPC" : "Add your character";
    const name = document.createElement("input"); name.type = "text"; name.placeholder = "Name"; name.className = "dnd-add-name";
    const file = document.createElement("input"); file.type = "file"; file.accept = "image/*"; file.className = "dnd-add-file";
    const msg = document.createElement("div"); msg.className = "dnd-add-msg";
    const btns = document.createElement("div"); btns.className = "dnd-add-btns";
    btns.appendChild(mkBtn("dnd-add-save", "Save", "", () => doAdd(name, file, msg)));
    btns.appendChild(mkBtn("dnd-add-cancel", "Cancel", "", closeAddPanel));
    addPanel.appendChild(title); addPanel.appendChild(name); addPanel.appendChild(file); addPanel.appendChild(btns); addPanel.appendChild(msg);
    document.documentElement.appendChild(addPanel); name.focus();
  }
  function closeAddPanel() { if (addPanel) { addPanel.remove(); addPanel = null; } }
  function doAdd(nameEl, fileEl, msgEl) {
    const nm = nameEl.value.trim(), f = fileEl.files[0];
    if (!nm) { msgEl.textContent = "Enter a name."; return; }
    if (!f) { msgEl.textContent = "Choose an image."; return; }
    msgEl.textContent = "Uploading…";
    const kind = dmMode ? "npc" : "pc";
    const url = relayBase + "/admin/upload?room=" + encodeURIComponent(room) + "&" + new URLSearchParams({ name: nm, type: f.type || "image/png", kind }) + (joinPw ? "&join=" + encodeURIComponent(joinPw) : "");
    fetch(url, { method: "POST", body: f }).then((r) => r.ok ? r.json() : r.text().then((t) => { throw new Error(t); })).then((j) => {
      if (!dmMode) { if (!myCharacterIds.includes(j.id)) myCharacterIds.push(j.id); myCharacterIds = myCharacterIds.slice(0, PLAYER_MAX); chrome.storage.local.set({ [MYCHARS_KEY]: myCharacterIds }); }
      closeAddPanel(); refreshCampaign();
    }).catch((e) => { msgEl.textContent = "Failed: " + e.message; });
  }
  function deleteChar(id, name) {
    if (!confirm("Remove " + (name || "this character") + "?")) return;
    fetch(relayBase + "/admin/delete?room=" + encodeURIComponent(room) + "&id=" + encodeURIComponent(id) + (joinPw ? "&join=" + encodeURIComponent(joinPw) : ""), { method: "POST" })
      .then(() => { if (!dmMode) { myCharacterIds = myCharacterIds.filter((x) => x !== id); chrome.storage.local.set({ [MYCHARS_KEY]: myCharacterIds }); } refreshCampaign(); })
      .catch(() => {});
  }

  function connectReporter() {
    repWs = new WebSocket(repWsUrl());
    repWs.onclose = () => { if (repRunning) setTimeout(() => { if (repRunning) connectReporter(); }, 1500); };
    repWs.onerror = () => {};
  }
  function onAudio(e) {
    if (!repRunning) return;
    const d = e.inputBuffer.getChannelData(0); let s = 0;
    for (let i = 0; i < d.length; i++) s += d[i] * d[i];
    const level = Math.min(1, Math.sqrt(s / d.length) * 4);
    lastLevel = level;
    const thr = dmSens / 100, now = Date.now();
    if (now - lastLevelSent > 80 && repWs && repWs.readyState === 1 && activeId) {
      lastLevelSent = now;
      repWs.send(JSON.stringify({ type: "level", userId: activeId, level: Math.round(level * 100) / 100 }));
    }
    if (level > thr) { repLastLoud = now; if (!repSpeaking) setRepSpeaking(true); }
    else if (repSpeaking && now - repLastLoud > dmHold) setRepSpeaking(false);
  }
  function startMic() {
    if (!activeId) { const b = boardIds(); if (b.length) activeId = b[0]; }
    if (!activeId) { setStripStatus("Add a character with + first", "err"); return; }
    navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false })
      .then((st) => {
        repStream = st;
        repAc = new (window.AudioContext || window.webkitAudioContext)();
        const sn = repAc.createMediaStreamSource(st);
        repSp = repAc.createScriptProcessor(2048, 1, 1);
        repSp.onaudioprocess = onAudio;
        sn.connect(repSp); repSp.connect(repAc.destination);
        connectReporter();
        repRunning = true; repLastLoud = Date.now();
        if (strip) strip.classList.add("mic-on");
        updateLiveStatus();
        log("mic on");
      }).catch((e) => { setStripStatus("🎤 Mic blocked — click to fix", "err", true); log("mic denied:", e.message); });
  }
  function stopMic() {
    repRunning = false; setRepSpeaking(false);
    if (repSp) { try { repSp.disconnect(); repSp.onaudioprocess = null; } catch (_) {} repSp = null; }
    if (repStream) { repStream.getTracks().forEach((t) => t.stop()); repStream = null; }
    if (repAc) { try { repAc.close(); } catch (_) {} repAc = null; }
    if (repWs) { try { repWs.close(); } catch (_) {} repWs = null; }
    if (strip) strip.classList.remove("mic-on");
    updateLiveStatus();
    log("mic off");
  }
  function initStrip() { buildStrip(); }
  function teardownDm() { stopMic(); teardownStrip(); }

  document.addEventListener("keydown", (e) => {
    if (!dmMode || !strip) return;
    const t = e.target;
    if (t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable)) return;
    const n = parseInt(e.key, 10);
    if (n >= 1 && n <= 9 && dmIds[n - 1]) setActive(dmIds[n - 1]);
  });
  // Pause toggle from the keyboard command / popup (via background.js).
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === "toggle-pause") requestTogglePause();
  });

  chrome.storage.local.get([STORAGE_KEY, ROOM_KEY, DM_KEY, JOIN_KEY, SENS_KEY, HOLD_KEY, MYCHAR_KEY, MYCHARS_KEY, COLLAPSE_KEY], (data) => {
    room = (data[ROOM_KEY] || "DEFAULT").toUpperCase();
    dmMode = !!data[DM_KEY];
    joinPw = data[JOIN_KEY] || "";
    dmSens = data[SENS_KEY] || 6;
    dmHold = data[HOLD_KEY] || 1200;
    myCharacterIds = Array.isArray(data[MYCHARS_KEY]) ? data[MYCHARS_KEY] : (data[MYCHAR_KEY] ? [data[MYCHAR_KEY]] : []);
    collapsed = !!data[COLLAPSE_KEY];
    start(data[STORAGE_KEY] || DEFAULT_RELAY_URL);
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes[ROOM_KEY]) room = (changes[ROOM_KEY].newValue || "DEFAULT").toUpperCase();
    if (changes[DM_KEY]) dmMode = !!changes[DM_KEY].newValue;
    if (changes[JOIN_KEY]) joinPw = changes[JOIN_KEY].newValue || "";
    if (changes[SENS_KEY]) dmSens = changes[SENS_KEY].newValue || 6;
    if (changes[MYCHARS_KEY]) myCharacterIds = Array.isArray(changes[MYCHARS_KEY].newValue) ? changes[MYCHARS_KEY].newValue : [];
    if (changes[STORAGE_KEY] || changes[ROOM_KEY] || changes[DM_KEY] || changes[JOIN_KEY]) {
      log("settings changed, restarting overlay");
      chrome.storage.local.get(STORAGE_KEY, (d) => { stop(); start(d[STORAGE_KEY] || DEFAULT_RELAY_URL); });
    }
  });
})();
