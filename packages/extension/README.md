# Browser extension (the overlay)

Manifest v3 extension that works in both Firefox and Chrome/Edge. Every player
who wants the overlay installs this and points it at the host's relay URL.

## Install in Firefox (temporary - free, easiest for a private group)

1. Go to `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on...**
3. Select the **manifest.json** file inside this `extension/` folder.
4. Click the extension's toolbar icon (puzzle piece -> D&D Voice Overlay),
   enter the relay base URL (e.g. `http://localhost:8787` for solo testing, or
   the host's `https://...` URL), click **Test**, then **Save**.
5. Open your Roll20 game tab. Portraits appear dimmed along the bottom; the
   active speaker lights up.

> Temporary add-ons are removed when Firefox restarts, so you reload it (steps
> 1-3) each session. Your saved relay URL persists. For a permanent install you
> would sign the add-on via addons.mozilla.org, or use Firefox Developer
> Edition / ESR with `xpinstall.signatures.required` set to false.

## Install in Chrome / Edge (unpacked)

1. Open `chrome://extensions` (or `edge://extensions`).
2. Enable **Developer mode**, click **Load unpacked**, select this `extension/`
   folder, then set the relay URL via the toolbar popup as above.

The overlay is click-through (`pointer-events: none`) and never blocks Roll20.

## Files
- `manifest.json` - MV3 manifest (incl. a Firefox add-on id), content script
  scoped to app.roll20.net.
- `content.js` - injects the overlay, fetches config, connects to the relay.
- `overlay.css` - visual-novel styling (dim idle, lit active, nameplate).
- `popup.html` / `popup.js` - set & test the relay URL.
