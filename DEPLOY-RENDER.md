# Deploy the relay to Render (free)

This puts your relay on a permanent free URL like
`https://dnd-overlay-relay.onrender.com`, reachable by all players. The
Discord listener still runs on your own PC and connects up to it.

## A. Put the project on GitHub (one time)

From the project folder (`dnd-voice-overlay`) in a terminal:

```
git init
git add .
git commit -m "D&D voice overlay"
```

Then create an empty repo on github.com and push (GitHub shows you the exact
two lines, they look like):

```
git remote add origin https://github.com/<you>/dnd-voice-overlay.git
git branch -M main
git push -u origin main
```

> Your `campaign.json` and portrait PNGs are committed on purpose so Render can
> serve them. The `.env` files and node_modules are NOT (they're git-ignored).

## B. Create the service on Render

1. Sign up at https://render.com (free, no card for the free tier).
2. Click **New +** -> **Blueprint**, pick your GitHub repo. Render reads
   `render.yaml` and proposes the **dnd-overlay-relay** web service. Click apply.
3. When asked, set the secret env var **RELAY_TOKEN** to:
   ```
   59cc20e5aceb3f0b8fef42e4c0095ae8
   ```
   (any long random string; this one is generated for you. Keep it private.)
4. Wait for the first deploy to finish. Your URL appears at the top, e.g.
   `https://dnd-overlay-relay.onrender.com`.
5. Test it: open `https://<your-url>/health` -> should show `{"ok":true,...}`,
   and `https://<your-url>/campaign.json` -> your config.

## C. Point your PC listener at the cloud relay

Edit `packages/discord-listener/.env`:

```
RELAY_URL=wss://dnd-overlay-relay.onrender.com
RELAY_TOKEN=59cc20e5aceb3f0b8fef42e4c0095ae8
```

(Use the same token as on Render. `wss://` — secure WebSocket — because Render
serves HTTPS.) Then run `start.bat` as usual; the relay now lives in the cloud,
only the listener runs locally.

## D. Tell me the URL

Send me your `https://...onrender.com` address and I'll bake it into the Chrome
extension as the default, so players install and it just works.

## Notes
- Free Render services sleep after ~15 min idle; the first connection each
  session wakes it (a few seconds). Your planned pinger avoids even that.
- To update portraits/config later: edit the files, `git commit` + `git push`,
  and Render redeploys automatically.
