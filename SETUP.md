# Setup guide

This lists everything, including the few things only **you** can do (marked
**YOU**). Follow it top to bottom once; after that, sessions just work.

Roles recap: the **host** (you) runs the listener + relay and owns the config.
Each **player** only installs the browser extension.

---

## Prerequisites

- Node.js 18+ on the host machine. (`node --version` to check.)
- The Discord **desktop** app installed, running, and logged in on the host.
- Everyone uses the same Discord voice channel and the same Roll20 game.

---

## Step 1 — Register a Discord application  **YOU (host), one time**

1. Go to https://discord.com/developers/applications and click **New
   Application**. Name it anything (e.g. "Table Overlay").
2. On the **OAuth2** page, copy the **Client ID** and **Client Secret**
   (reset the secret to reveal it). Keep these private.
3. Still on **OAuth2 → Redirects**, add a redirect: `http://localhost`. Save.
4. You do **not** need a bot, and you do **not** need to submit the app for
   approval. The gated voice scope works because you (the app owner) are the
   one authorizing it. You may add other people only as **testers** under
   **App Testers** if you ever want them to run the listener too — but normally
   only you run it.

## Step 2 — Find each player's Discord user ID  **YOU**

1. In Discord: **User Settings → Advanced → Developer Mode → On**.
2. Right-click each player (including yourself) → **Copy User ID**.
   These are the long numbers used as keys in the config.

## Step 3 — Build the campaign config  **YOU**

1. Copy the example: `cp config/campaign.example.json config/campaign.json`
   (a working copy already exists; edit it).
2. For each player, set their Discord user ID, character `name`, and a
   `portrait` filename:

   ```json
   {
     "campaignName": "Curse of Strahd",
     "characters": {
       "PASTE_DISCORD_USER_ID": { "name": "Aelarra Moonwhisper", "portrait": "aelarra.png" }
     }
   }
   ```
3. Drop the matching PNGs into `config/portraits/` (filenames must match the
   `portrait` values). Transparent-background portrait PNGs look best.

## Step 4 — Start the relay  **YOU**

```bash
cd packages/relay
cp .env.example .env        # optionally set PORT or RELAY_TOKEN
npm install
npm run build
npm start
```

You should see `Relay listening on :8787`. Quick check in a browser:
`http://localhost:8787/health` → `{"ok":true,...}`.

**Make it reachable by players.** Pick one:
- **Same LAN / in-person:** players use `http://<your-LAN-IP>:8787`.
- **Over the internet (typical):** run a tunnel, e.g.
  `cloudflared tunnel --url http://localhost:8787` or `ngrok http 8787`, and
  give players the resulting `https://…` URL. (https tunnels give you `wss://`
  automatically, which the extension prefers.)
- **Cheap VPS:** deploy the `relay` package there; it has no Discord
  dependency. Put the `config/` folder beside it (or set `CONFIG_DIR`).

If you set `RELAY_TOKEN` in the relay's `.env`, use the same value in the
listener's `.env` (Step 5).

## Step 5 — Start the Discord listener  **YOU (host machine only)**

```bash
cd packages/discord-listener
cp .env.example .env
# edit .env: DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET, RELAY_URL (and RELAY_TOKEN if used)
npm install
npm run build
npm start
```

The **first** run pops a Discord window asking you to **Authorize** the app —
approve it (this is the gated voice scope; it only needs you). After that you'll
see `listening for speaking in "<channel>"`. Join your voice channel if you
haven't; it auto-detects and re-subscribes when you switch channels.

> `RELAY_URL` here is the WebSocket form: `ws://localhost:8787` locally, or
> `wss://your-tunnel-host` if relay and listener are on different machines.

## Step 6 — Each player installs the extension  **EACH PLAYER**

**Firefox:**
1. Go to `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on...** and select the **manifest.json** inside
   `packages/extension/`.
3. Click the extension's toolbar icon, paste the **relay base URL** you (the
   host) shared (e.g. `http://localhost:8787` for solo testing, or the tunnel
   `https://...` URL), click **Test**, then **Save**.
4. Open the Roll20 game tab. Portraits sit dimmed along the bottom; whoever
   talks lights up, within about half a second.

> Firefox temporary add-ons reset on restart, so reload steps 1-2 each session
> (your saved relay URL persists). For a permanent install, sign it via
> addons.mozilla.org or use Firefox Developer Edition / ESR.

**Chrome / Edge:**
1. Open `chrome://extensions` (or `edge://extensions`), enable **Developer
   mode**, click **Load unpacked**, select `packages/extension/`.
2. Set the relay URL via the toolbar popup as above.

(Publishing to the Chrome Web Store is optional and cleaner for non-technical
players, but involves a one-time developer fee and review. Unpacked is free and
fine for a private group.)

---

## Per-session checklist (after first-time setup)

1. **YOU:** start the relay (and tunnel, if used).
2. **YOU:** start the listener; join the voice channel.
3. **Players:** open Roll20. Done.

## Troubleshooting

- **No portraits at all:** the extension has no/incorrect relay URL, or the
  relay isn't reachable. Use the popup's **Test** button.
- **Portraits show but never light up:** the listener isn't running, isn't
  authorized, or you're not in a voice channel. Check the listener console.
- **One player never lights up:** their Discord user ID in `campaign.json` is
  wrong. Re-copy it (Step 2).
- **Portrait is a broken image:** filename in `campaign.json` doesn't match the
  file in `config/portraits/` (case-sensitive on most hosts).
- **A small red dot** in the corner of Roll20 means the overlay lost the relay
  connection; it reconnects automatically.

## Phasing (optional, matches the brief)

- **Phase 1 (proof of concept):** run the relay locally and the listener on your
  own machine, and load the extension in your own browser pointed at
  `http://localhost:8787`. Validates the full speak → portrait loop solo.
- **Phase 2 (shared table):** add a tunnel/VPS so the relay is reachable, and
  have each player install the extension. Same code, no changes.
