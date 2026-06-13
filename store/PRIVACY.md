# Privacy Policy — D&D Voice Overlay for Roll20

_Last updated: 2026_

D&D Voice Overlay is a browser extension that displays character portraits over
Roll20 when a player speaks in a Discord voice channel.

## What the extension stores
- A single setting on your device: the **relay URL** it should connect to.
  This is stored locally in your browser (`chrome.storage.local`) and is never
  sent to the developer.

## What the extension accesses
- It runs only on `https://app.roll20.net/*` pages, where it draws the overlay.
- It connects to the **relay server** you (or your game's host) configure, to
  receive "who is speaking" events. These events contain Discord user IDs so the
  overlay can match the right portrait. The host controls that mapping.

## What the extension does NOT do
- It does **not** record, receive, or transcribe any audio.
- It does **not** use webcams or video.
- It does **not** collect analytics, track your browsing, or send any data to
  the developer.
- It does **not** sell or share data with third parties.

## Data controller
The relay server and the campaign configuration (Discord IDs, names, portraits)
are operated by your game's host, not by the extension developer.

## Contact
Questions: <your-email-here>
