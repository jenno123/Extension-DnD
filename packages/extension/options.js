const DEFAULT_RELAY_URL = "https://extension-dnd.onrender.com";
const $ = (id) => document.getElementById(id);
let base = DEFAULT_RELAY_URL, code = "", joinPw = "";

function setMsg(el, text, ok) { el.textContent = text; el.className = "msg " + (ok ? "ok" : "bad"); }
const enc = encodeURIComponent;

function load() {
  chrome.storage.local.get(["relayBaseUrl", "campaignCode", "joinPw", "dmMode"], (d) => {
    base = (d.relayBaseUrl || DEFAULT_RELAY_URL).replace(/\/+$/, "");
    code = (d.campaignCode || "").toUpperCase();
    joinPw = d.joinPw || "";
    $("code").value = code;
    $("join").value = joinPw;
    if (document.getElementById("nKind")) document.getElementById("nKind").value = d.dmMode ? "npc" : "pc";
    renderShare();
    if (code) refreshChars();
  });
}

function renderShare() {
  if (!code) { $("shareInfo").innerHTML = ""; return; }
  $("shareInfo").innerHTML =
    'Players install the overlay extension and enter code <code>' + code + '</code>.<br>' +
    'Optional web link (reserve): <code>' + base + '/?room=' + code + '</code>';
}

$("createBtn").onclick = () => {
  const name = $("cName").value.trim(), jp = $("cJoin").value, adminpw = $("cAdmin").value, m = $("createMsg");
  if (!name) return setMsg(m, "Enter a campaign name.", false);
  setMsg(m, "Creating...", true);
  const prm = { name }; if (jp) prm.joinpw = jp; if (adminpw) prm.password = adminpw;
  fetch(base + "/create?" + new URLSearchParams(prm), { method: "POST" })
    .then((r) => r.ok ? r.json() : r.text().then((t) => { throw new Error(t); }))
    .then((j) => {
      code = j.room; joinPw = jp || "";
      chrome.storage.local.set({ campaignCode: code, joinPw });
      $("code").value = code; $("join").value = joinPw;
      setMsg(m, "✓ Created campaign " + code + " — now the active campaign.", true);
      renderShare(); refreshChars();
    }).catch((e) => setMsg(m, "Failed: " + e.message, false));
};

$("saveBtn").onclick = () => {
  code = ($("code").value || "").trim().toUpperCase(); joinPw = $("join").value || "";
  chrome.storage.local.set({ campaignCode: code, joinPw }, () => {
    setMsg($("saveMsg"), code ? ("Using campaign " + code) : "Cleared campaign.", true);
    renderShare(); refreshChars();
  });
};

$("nFile").onchange = (e) => { const f = e.target.files[0]; if (f) { $("prev").src = URL.createObjectURL(f); $("prev").style.display = "block"; } };

function refreshChars() {
  const box = $("chars");
  if (!code) { box.innerHTML = '<div class="hint">Set a campaign code above first.</div>'; return; }
  fetch(base + "/campaign.json?room=" + enc(code), { cache: "no-store" })
    .then((r) => r.json()).then((c) => {
      const chars = (c && c.characters) || {}, ids = Object.keys(chars);
      box.innerHTML = ids.length ? "" : '<div class="hint">No characters yet — add one below.</div>';
      ids.forEach((id) => {
        const d = document.createElement("div"); d.className = "ch";
        const img = document.createElement("img");
        img.src = /^https?:\/\//i.test(chars[id].portrait) ? chars[id].portrait : base + "/portraits/" + enc(chars[id].portrait) + "?room=" + enc(code);
        const nm = document.createElement("span"); nm.textContent = chars[id].name || id;
        d.appendChild(img); d.appendChild(nm); box.appendChild(d);
      });
    }).catch(() => { box.innerHTML = '<div class="hint bad">Could not load characters.</div>'; });
}

$("addBtn").onclick = () => {
  const name = $("nName").value.trim(), f = $("nFile").files[0], m = $("addMsg");
  if (!code) return setMsg(m, "Set a campaign code in section 2 first.", false);
  if (!name) return setMsg(m, "Enter a character name.", false);
  if (!f) return setMsg(m, "Choose an image.", false);
  setMsg(m, "Uploading...", true);
  const kind = ($("nKind") && $("nKind").value === "npc") ? "npc" : "pc";
  const url = base + "/admin/upload?room=" + enc(code) + "&" + new URLSearchParams({ name, type: f.type || "image/png", kind }) + (joinPw ? "&join=" + enc(joinPw) : "");
  fetch(url, { method: "POST", body: f })
    .then((r) => r.ok ? r.json() : r.text().then((t) => { throw new Error(t); }))
    .then(() => { setMsg(m, "✓ Saved.", true); $("nName").value = ""; $("nFile").value = ""; $("prev").style.display = "none"; refreshChars(); })
    .catch((e) => setMsg(m, "Failed: " + e.message, false));
};

load();
